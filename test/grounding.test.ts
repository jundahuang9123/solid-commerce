/**
 * Grounding regression tests (audit fixes): rollback to superseded revisions,
 * mandate reuse only for matching terms, approval summaries that show the
 * executable criterion, and vocabulary validation that cannot be bypassed.
 * Runs against an in-memory LDP stand-in, so no Solid server is needed.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { PodClient } from "../src/pod/PodClient.js";
import { PodLayout } from "../src/pod/layout.js";
import { CommonGround, type GroundingContext } from "../src/grounding/commonGround.js";
import { ApprovalDevice, summarize } from "../src/grounding/approval.js";
import { RuleInterpreter } from "../src/grounding/ruleInterpreter.js";
import { validateInterpretation, checkInterpretation, type Interpretation } from "../src/grounding/interpretation.js";
import type { AgreedMeaning, SpendingMandate } from "../src/model.js";

/** Just enough LDP for PodClient: GET/PUT/DELETE, containers list their direct members, ETags, If-Match / If-None-Match. */
function memoryPod() {
  const docs = new Map<string, { text: string; etag: string }>();
  let n = 0;
  const fetchFn = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input);
    const method = init.method ?? "GET";
    const headers = new Headers(init.headers);
    if (method === "GET") {
      if (url.endsWith("/")) {
        const members = [...docs.keys()].filter((d) => d.startsWith(url) && !d.slice(url.length).includes("/"));
        if (!members.length) return new Response("", { status: 404 });
        return new Response(members.map((m) => `<${url}> <http://www.w3.org/ns/ldp#contains> <${m}> .`).join("\n"), { status: 200, headers: { "content-type": "text/turtle" } });
      }
      const d = docs.get(url);
      return d ? new Response(d.text, { status: 200, headers: { etag: d.etag } }) : new Response("", { status: 404 });
    }
    if (method === "PUT") {
      const cur = docs.get(url);
      if (headers.get("if-none-match") === "*" && cur) return new Response("exists", { status: 412 });
      if (headers.get("if-match") && headers.get("if-match") !== cur?.etag) return new Response("etag", { status: 412 });
      docs.set(url, { text: String(init.body), etag: `"${++n}"` });
      return new Response("", { status: 201 });
    }
    if (method === "DELETE") { docs.delete(url); return new Response(null, { status: 205 }); }
    return new Response("", { status: 405 });
  }) as typeof fetch;
  return { pod: new PodClient(fetchFn), docs };
}

const layout = new PodLayout("https://pod.example/alice/");
const owner = layout.webId;
const SELLERS = ["https://s1.example/#org", "https://s2.example/#org"];
const opts = (agentIds = ["urn:agent:a"]) => ({ approvedSellers: SELLERS, agentIds, schemesFor: () => ["x402"] });
const empty = (): GroundingContext => ({ meanings: [], preferences: [], mandates: [], ignored: [] });

function setup() {
  const { pod, docs } = memoryPod();
  const device = new ApprovalDevice(owner);
  const cg = new CommonGround(pod, layout, [device.publicJwk], "urn:agent:a");
  return { pod, docs, device, cg };
}

const baseMandate = (terms: Partial<SpendingMandate> = {}): SpendingMandate => ({
  kind: "mandate", id: layout.mandate("weatherreport-usdc"), owner, revision: 1, status: "Proposed",
  assignees: ["urn:agent:a"], targets: ["WeatherReport"], currency: "USDC", maxPerTransaction: "1", totalLimit: "1",
  allowedSellers: [...SELLERS], allowedSchemes: ["x402"], validUntil: "2030-01-01T00:00:00.000Z", ...terms,
});

describe("rollback to a superseded revision", () => {
  test("a mandate revision copied back from history is refused and reported", async () => {
    const { pod, cg, device } = setup();
    const r1 = (await cg.commit(baseMandate(), device))!;
    // The user narrows the mandate: revision 2 supersedes revision 1, which is archived.
    const ctx1 = await cg.load();
    assert.equal(ctx1.mandates[0].revision, 1);
    const n = cg.negotiate(await new RuleInterpreter().interpret("You may spend up to 0.10 USDC on weather reports, at most 0.05 USDC per purchase, from approved providers."), ctx1, owner, opts());
    const proposal = n.proposals.find((p) => p.kind === "mandate") as SpendingMandate;
    assert.equal(proposal.revision, 2);
    await cg.commit(proposal, device);
    const ctx2 = await cg.load();
    assert.deepEqual([ctx2.mandates[0].revision, ctx2.mandates[0].totalLimit], [2, "0.10"]);

    // An agent with Pod write access restores the archived revision 1 over the live document.
    const doc = r1.id.split("#")[0];
    const archived = (await pod.get(layout.historyDoc("weatherreport-usdc", 1)))!.text;
    await pod.putTurtle(doc, archived);
    const ctx3 = await cg.load();
    assert.equal(ctx3.mandates.length, 0, "the rolled-back revision is not accepted as authority");
    const ig = ctx3.ignored.find((x) => x.id === r1.id);
    assert.ok(ig, "the rollback is reported");
    assert.match(ig!.reason, /rolled back: live revision 1 .*revision 1/);

    // Re-proposing goes past every revision the history proves existed, and is accepted again.
    const again = cg.negotiate(await new RuleInterpreter().interpret("You may spend up to 0.10 USDC on weather reports, at most 0.05 USDC per purchase, from approved providers."), ctx3, owner, opts());
    const p3 = again.proposals.find((p) => p.kind === "mandate") as SpendingMandate;
    assert.equal(p3.revision, 3);
    await cg.commit(p3, device);
    const ctx4 = await cg.load();
    assert.deepEqual([ctx4.mandates[0]?.revision, ctx4.mandates[0]?.totalLimit, ctx4.ignored.length], [3, "0.10", 0]);
  });

  test("an agreed meaning rolled back to an older revision is refused; grounded requirements do not follow it", async () => {
    const { pod, cg, device } = setup();
    const m1: AgreedMeaning = {
      kind: "meaning", id: layout.meaning("weatherreport-current"), owner, revision: 1, status: "Proposed", term: "current", scope: "WeatherReport",
      definition: "observed at most 60 minutes before delivery", criterion: { leftOperand: "observationAgeMinutes", operator: "lteq", rightOperand: 60, unit: "minute" },
    };
    await cg.commit(m1, device);
    await cg.commit({ ...m1, revision: 2, supersedes: layout.historyDoc("weatherreport-current", 1), definition: "observed at most 15 minutes before delivery", criterion: { ...m1.criterion, rightOperand: 15 } }, device);
    assert.equal((await cg.load()).meanings[0].criterion.rightOperand, 15);
    await pod.putTurtle(m1.id.split("#")[0], (await pod.get(layout.historyDoc("weatherreport-current", 1)))!.text);
    const ctx = await cg.load();
    assert.equal(ctx.meanings.length, 0);
    assert.match(ctx.ignored.find((x) => x.id === m1.id)!.reason, /rolled back/);
  });

  test("a live revision lower than a signed revision kept in history is refused", async () => {
    const { pod, cg, device } = setup();
    const m = baseMandate();
    const r1 = await cg.commit(m, device);
    const r1Text = (await pod.get(m.id.split("#")[0]))!.text;
    await cg.commit({ ...m, revision: 2, totalLimit: "0.5", maxPerTransaction: "0.5", supersedes: layout.historyDoc("weatherreport-usdc", 1) }, device);
    await cg.commit({ ...m, revision: 3, totalLimit: "0.2", maxPerTransaction: "0.2", supersedes: layout.historyDoc("weatherreport-usdc", 2) }, device);
    // Attacker deletes history r1 (so r1 is not itself archived) and restores r1 over the live r3.
    await pod.delete(layout.historyDoc("weatherreport-usdc", 1));
    await pod.putTurtle(m.id.split("#")[0], r1Text);
    const ctx = await cg.load();
    assert.equal(ctx.mandates.length, 0);
    assert.match(ctx.ignored.find((x) => x.id === r1!.id)!.reason, /live revision 1 is not newer than signed revision 2/);
  });

  test("unsigned or foreign history documents prove nothing and do not block the live record", async () => {
    const { pod, cg, device } = setup();
    const m = baseMandate();
    await cg.commit(m, device);
    const other = new ApprovalDevice(owner);
    const forged = (await other.review({ ...m, revision: 9 }))!;
    const { recordToTurtle } = await import("../src/rdf/records.js");
    await pod.putTurtle(layout.historyDoc("weatherreport-usdc", 9), await recordToTurtle(forged));
    await pod.putTurtle(layout.historyDoc("weatherreport-usdc", 8), "this is not turtle");
    const ctx = await cg.load();
    assert.equal(ctx.mandates[0]?.revision, 1);
  });
});

describe("mandate reuse", () => {
  const ctxWith = (m: SpendingMandate): GroundingContext => ({ ...empty(), mandates: [{ ...m, status: "UserConfirmed" }] });
  const cg = new CommonGround(new PodClient(), layout, []);
  const ask = async (text: string, ctx: GroundingContext, agentIds?: string[]) => cg.negotiate(await new RuleInterpreter().interpret(text), ctx, owner, opts(agentIds));

  test("a narrower per-purchase limit is not dropped: a new revision is proposed and the change is shown", async () => {
    const n = await ask("Get me a Berlin weather report. You may spend up to 1 USDC on weather reports, at most 0.01 USDC per purchase, from approved providers.", ctxWith(baseMandate({ validUntil: new Date(Date.now() + 86_400_000).toISOString() })));
    const p = n.proposals.find((x) => x.kind === "mandate") as SpendingMandate | undefined;
    assert.ok(p, "a mandate revision is proposed");
    assert.deepEqual([p!.maxPerTransaction, p!.revision], ["0.01", 2]);
    assert.equal(n.reused.some((r) => r.kind === "mandate"), false);
    assert.ok(n.notes.some((x) => /per purchase 1 -> 0\.01 USDC/.test(x)), n.notes.join("\n"));
  });

  test("a shorter validity than the existing mandate's is proposed, not ignored", async () => {
    const n = await ask("You may spend up to 1 USDC on weather reports from approved providers.", ctxWith(baseMandate({ validUntil: "2099-01-01T00:00:00.000Z" })));
    assert.equal(n.proposals.filter((x) => x.kind === "mandate").length, 1);
    assert.ok(n.notes.some((x) => /valid until 2099/.test(x)));
  });

  test("other agents, sellers or schemes on the existing mandate are shown as changes", async () => {
    const tomorrow = new Date(Date.now() + 86_400_000).toISOString();
    for (const terms of [{ assignees: ["urn:agent:a", "urn:agent:b"] }, { allowedSellers: [...SELLERS, "https://s9.example/#org"] }, { allowedSchemes: ["x402", "l402"] as SpendingMandate["allowedSchemes"] }]) {
      const n = await ask("You may spend up to 1 USDC on weather reports from approved providers.", ctxWith(baseMandate({ ...terms, validUntil: tomorrow })));
      assert.equal(n.proposals.filter((x) => x.kind === "mandate").length, 1, JSON.stringify(terms));
      assert.ok(n.notes.some((x) => /agents|sellers|schemes/.test(x)), JSON.stringify(terms));
    }
  });

  test("an existing mandate with the same terms (earlier but future expiry) is reused", async () => {
    const n = await ask("You may spend up to 1.00 USDC on weather reports from approved providers.", ctxWith(baseMandate({ validUntil: new Date(Date.now() + 86_400_000).toISOString() })));
    assert.equal(n.proposals.length, 0);
    assert.equal(n.reused.filter((r) => r.kind === "mandate").length, 1);
    assert.ok(n.notes.some((x) => /Existing mandate covers this request/.test(x)));
  });
});

describe("approval summaries", () => {
  test("an agreed meaning shows its executable criterion, not only the definition", () => {
    const s = summarize({
      kind: "meaning", id: layout.meaning("weatherreport-current"), owner, revision: 2, status: "Proposed", term: "current", scope: "WeatherReport",
      definition: "current means observed at most 15 minutes before delivery", criterion: { leftOperand: "observationAgeMinutes", operator: "lteq", rightOperand: 600, unit: "minute" },
      supersedes: layout.historyDoc("weatherreport-current", 1), derivedFrom: "Get me a current Berlin weather report.",
    });
    assert.match(s, /observationAgeMinutes lteq 600 minute/);
    assert.match(s, /revision 2/);
    assert.match(s, /weatherreport-current-r1\.ttl/);
  });

  test("a grounded requirement names the meaning it follows", () => {
    const s = summarize({ kind: "requirement", id: layout.preference("x"), owner, revision: 1, status: "Proposed", appliesTo: "WeatherReport", criterion: { leftOperand: "observationAgeMinutes", operator: "lteq", rightOperand: 15, unit: "minute" }, groundedIn: layout.meaning("weatherreport-current") });
    assert.match(s, /observationAgeMinutes lteq 15 minute/);
    assert.match(s, /grounded in agreed meaning .*weatherreport-current/);
  });
});

describe("vocabulary validation", () => {
  const cg = new CommonGround(new PodClient(), layout, []);
  const W = "WeatherReport";

  test("a criterion in a statement without its own category is checked against the intention's category", () => {
    const interp: Interpretation = { unrecognized: [], statements: [
      { text: "Get me a Berlin weather report", role: "intention", category: W, subject: "Berlin" },
      { text: "the seller must be my friend", role: "requirement", criterion: { leftOperand: "sellerIsMyFriend", operator: "eq", rightOperand: "true" } },
    ] };
    assert.ok(validateInterpretation(interp).some((e) => /unknown property sellerIsMyFriend for WeatherReport/.test(e)));
    const n = cg.negotiate(interp, empty(), owner, opts());
    assert.deepEqual(n.proposals, []);
  });

  test("a criterion with no category anywhere is rejected", () => {
    const interp: Interpretation = { unrecognized: [], statements: [
      { text: "must be fresh", role: "requirement", criterion: { leftOperand: "observationAgeMinutes", operator: "lteq", rightOperand: 5 } },
    ] };
    assert.ok(validateInterpretation(interp).some((e) => /has no category/.test(e)));
    assert.deepEqual([...checkInterpretation(interp).invalid], [0]);
  });

  test("a double quote in an offending value cannot defeat skipping the invalid statement", () => {
    const interp: Interpretation = { unrecognized: [], statements: [
      { text: "Get me a Berlin weather report", role: "intention", category: W, subject: "Berlin" },
      { text: "I prefer x", role: "preference", category: W, weight: 0.5, criterion: { leftOperand: 'bogus"', operator: "eq", rightOperand: "true" } },
      { text: "the seller must be my friend", role: "requirement", criterion: { leftOperand: "sellerIsMyFriend", operator: "eq", rightOperand: "true" } },
    ] };
    const n = cg.negotiate(interp, empty(), owner, opts());
    assert.deepEqual(n.proposals.map((p) => (p as any).criterion?.leftOperand), [], "neither invalid statement becomes a proposal");
    assert.equal(n.notes.filter((x) => /Rejected interpreter output/.test(x)).length, 2);
  });

  test("an invalid statement does not take a valid statement with the same text down with it, and vice versa", () => {
    const interp: Interpretation = { unrecognized: [], statements: [
      { text: "same", role: "intention", category: W },
      { text: "same", role: "preference", category: W, weight: 0.5, criterion: { leftOperand: "includesHourlyForecast", operator: "eq", rightOperand: "true" } },
      { text: "same", role: "preference", category: W, weight: 0.5, criterion: { leftOperand: "nonsense", operator: "eq", rightOperand: "true" } },
    ] };
    const n = cg.negotiate(interp, empty(), owner, opts());
    assert.deepEqual(n.proposals.map((p) => (p as any).criterion?.leftOperand), ["includesHourlyForecast"]);
  });

  test("a per-purchase limit above the total, or a malformed one, is rejected (comparison-harness variant)", () => {
    const auth = (maxPerTransaction: string) => ({ unrecognized: [], statements: [
      { text: "spend", role: "authorization" as const, category: W, authorization: { currency: "USDC", totalLimit: "500", maxPerTransaction, approvedSellersOnly: true } },
    ] });
    assert.ok(validateInterpretation(auth("600")).some((e) => /exceeds total limit/.test(e)));
    assert.ok(validateInterpretation(auth("lots")).some((e) => /invalid per-purchase limit/.test(e)));
    assert.deepEqual(validateInterpretation(auth("5")), []);
    assert.deepEqual(cg.negotiate(auth("600"), empty(), owner, opts()).proposals, []);
  });
});
