/**
 * Web demo (src/web): the JSON API and SSE stream against the live services,
 * a browser smoke test of the dashboard and the phone approval page, and a
 * replay of the shipped recording.
 */
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { LiveDemo } from "../src/web/live.js";
import { ReplayDemo } from "../src/web/replay.js";
import { loadRecording, type DemoEvent } from "../src/web/events.js";
import { startDemoServer, demoToken, type DemoServer } from "../src/web/server.js";
import { actionProblems, perform, recordingProblems, rehearsalProblems, rehearse } from "../src/web/rehearse.js";
import { QUIET, QUIET_HEADER, actAs } from "../src/web/wire.js";
import { sleep } from "../src/web/scenarios/common.js";

const RECORDING = fileURLToPath(new URL("../recordings/talk.json", import.meta.url));

/** Read the SSE stream (history first, then live) until an event matches. */
async function waitFor(srv: DemoServer, match: (e: DemoEvent) => boolean, timeoutMs = 60_000): Promise<DemoEvent> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(`${srv.url}/api/events`, { signal: ctl.signal });
    const decoder = new TextDecoder();
    let buf = "";
    for await (const chunk of res.body!) {
      buf += decoder.decode(chunk as Uint8Array, { stream: true });
      let i;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const block = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const data = block.split("\n").find((l) => l.startsWith("data: "));
        if (!data) continue;
        const e = JSON.parse(data.slice(6)) as DemoEvent;
        if (match(e)) return e;
      }
    }
    throw new Error("event stream ended");
  } catch (e) {
    if (ctl.signal.aborted) throw new Error("timed out waiting for an event");
    throw e;
  } finally {
    clearTimeout(timer);
    ctl.abort();
  }
}

async function until(cond: () => boolean, timeoutMs = 60_000) {
  for (const end = Date.now() + timeoutMs; !cond(); await new Promise((r) => setTimeout(r, 50))) if (Date.now() > end) throw new Error("timed out");
}

const post = (srv: DemoServer, path: string, body: unknown = {}, token = srv.token) =>
  fetch(`${srv.url}${path}`, { method: "POST", headers: { "content-type": "application/json", "x-demo-token": token }, body: JSON.stringify(body) });

/** Start an action through the HTTP API and collect the events it emits until the demo is idle again. */
async function run(srv: DemoServer, demo: LiveDemo, name: string, args: Record<string, unknown> = {}): Promise<DemoEvent[]> {
  const seen: DemoEvent[] = [];
  let off = () => {};
  const idle = new Promise<void>((resolve) => { off = demo.log.subscribe((e) => { seen.push(e); if (e.type === "busy" && e.data.action === null) resolve(); }); });
  const res = await post(srv, `/api/action/${name}`, args);
  if (res.status !== 202) { off(); throw new Error(`${name}: ${res.status} ${await res.text()}`); }
  await idle;
  off();
  return seen;
}

/** Wait until the action that is running (if any) has finished. */
const idle = (demo: LiveDemo) => until(() => demo["busy"] === undefined);

/** Wait until a reset has produced a new log (fresh Pod and environment) that has finished starting up. */
async function resetDone(demo: LiveDemo, previous: DemoEvent, timeoutMs = 60_000) {
  await until(() => { const log = demo.log.all(); return log[0] !== previous && log.some((e) => e.type === "session") && log.at(-1)?.type === "busy" && log.at(-1)?.data.action === null; }, timeoutMs);
}

/** Reset into a fresh session (fresh Pod, new environment) with auto-approve on or off. */
async function freshSession(srv: DemoServer, demo: LiveDemo, auto: boolean) {
  // Whatever an earlier test left waiting for the phone is approved, so that action can finish first.
  assert.equal((await post(srv, "/api/auto-approve", { on: true })).status, 200);
  await idle(demo);
  assert.equal((await post(srv, "/api/auto-approve", { on: auto })).status, 200);
  const previous = demo.log.all()[0];
  assert.equal((await post(srv, "/api/action/reset")).status, 202);
  await resetDone(demo, previous);
}

describe("web demo, live", () => {
  let demo: LiveDemo;
  let srv: DemoServer;
  // Never the shipped recordings/: a test must not be able to overwrite the fallback.
  const recordings = mkdtempSync(join(tmpdir(), "demo-recordings-"));
  before(async () => {
    demo = await LiveDemo.start({ recordingsDir: recordings, autoApproveDelayMs: 50, stepPauseMs: 50 });
    srv = await startDemoServer(demo, { host: "127.0.0.1" });
  });
  after(async () => { await srv.close(); await demo.close(); rmSync(recordings, { recursive: true, force: true }); });

  test("the weather scenario runs through the JSON API and the SSE stream reports a real completed purchase", async () => {
    assert.equal((await post(srv, "/api/action/weather.next", {}, "wrong-token")).status, 403, "a bystander without the token cannot act");
    assert.equal((await post(srv, "/api/auto-approve", { on: true })).status, 200);
    assert.equal((await post(srv, "/api/action/weather.autoplay")).status, 202);
    assert.equal((await post(srv, "/api/action/guard.race")).status, 409, "one action at a time");

    const purchase = await waitFor(srv, (e) => e.type === "purchase");
    assert.deepEqual([purchase.data.status, purchase.data.seller, purchase.data.scheme, purchase.data.amount, purchase.data.currency], ["completed", "Spree Weather", "x402", "20000", "USDC"]);
    await waitFor(srv, (e) => e.type === "step" && e.data.index === 6 && e.data.state === "done");
    const events = demo.log.all();
    // The numbers on screen come from the services: the gateway's budget and the wire as observed
    const budget = [...events].reverse().find((e) => e.type === "budget" && e.data.key === "weather")!;
    assert.deepEqual([budget.data.settled, budget.data.limit], ["20000", "1000000"]);
    const wire = events.filter((e) => e.type === "wire").map((e) => e.data);
    const challenge = wire.find((w) => w.status === 402 && w.from === "assistant-1" && w.to === "spree")!;
    assert.ok(challenge.response.some((n: string) => n.startsWith("PAYMENT-REQUIRED  x402 exact, 0.02 USDC")));
    assert.ok(challenge.response.some((n: string) => n.startsWith("WWW-Authenticate  L402")));
    assert.ok(wire.some((w) => w.from === "spree" && w.to === "facilitator" && w.path === "/settle" && w.status === 200), "seller-side calls are attributed to the seller");
    assert.ok(wire.some((w) => w.to === "spree" && w.status === 200 && w.request.some((n: string) => n.startsWith("PAYMENT-SIGNATURE"))));
    assert.equal(events.filter((e) => e.type === "approval.resolved" && e.data.via === "auto").length, 4);
    const mandate = events.find((e) => e.type === "approval.pending" && e.data.kind === "mandate")!;
    assert.equal(mandate.data.financial, true);
    // Evidence: the Turtle shown is the Pod's document
    const doc = events.find((e) => e.type === "pod.doc" && e.data.why === "assistant evidence")!;
    assert.equal(doc.data.turtle, await (await fetch(doc.data.url, { headers: { accept: "text/turtle" } })).text());
    await idle(demo);
  });

  test("the dashboard's own polling (budget meters, Pod panel) puts nothing on the wire, also downstream of the gateway", async () => {
    // Self-contained: run alone (--test-name-pattern), there is no weather mandate yet.
    if (!demo.log.all().some((e) => e.type === "budget" && e.data.key === "weather")) {
      assert.equal((await post(srv, "/api/auto-approve", { on: true })).status, 200);
      await run(srv, demo, "weather.autoplay");
    }
    const before = demo.log.all().length;
    // What runs after every action: Pod listing, latest document and GET /budget for each tracked mandate
    await (demo as unknown as { refresh(): Promise<void> }).refresh();
    const mandate = [...demo.log.all()].reverse().find((e) => e.type === "budget" && e.data.key === "weather")!.data.mandate;
    await actAs(QUIET, () => fetch(`${demo["env"]!.gateway.url}/budget?mandate=${encodeURIComponent(mandate)}`));
    const added = demo.log.all().slice(before);
    assert.ok(added.some((e) => e.type === "budget"), "the budget was polled");
    assert.deepEqual(added.filter((e) => e.type === "wire").map((e) => `${e.data.from} -> ${e.data.to} ${e.data.method} ${e.data.path}`), []);
  });

  test("Break it: every guardrail holds when run live through the API", async () => {
    assert.equal((await post(srv, "/api/auto-approve", { on: true })).status, 200);
    const done: Record<string, any> = {};
    for (const g of ["tamper", "price", "race", "crash", "recover", "replay", "unapproved"]) {
      const events = await run(srv, demo, `guard.${g}`);
      assert.deepEqual(rehearsalProblems(events), [], `guard.${g}`);
      done[g] = events.find((e) => e.type === "guard" && e.data.state === "done")!.data;
      assert.notEqual(done[g].tone, "fail", `guard.${g}: ${done[g].lines.join("; ")}`);
    }
    assert.deepEqual([done.tamper.tone, done.tamper.lines[0]], ["blocked", "403 MANDATE_NOT_CONFIRMED"]);
    assert.equal(done.price.tone, "warn");
    assert.match(done.price.lines[0], /^offer v\d+ → v\d+: re-validated$/);
    assert.equal(done.race.tone, "blocked");
    assert.equal(done.race.lines[0], "2 settled · 4 BUDGET_EXCEEDED · charged 0.04 USDC", "the shared mandate's budget: two purchases of 0.02");
    assert.deepEqual([done.crash.tone, done.crash.recoverable], ["warn", true]);
    assert.match(done.crash.lines[0], /^paid_not_delivered/);
    const paidAfterCrash = Number(done.crash.lines[1].match(/signer payments \d+ → (\d+)/)![1]);
    assert.deepEqual([done.recover.tone, done.recover.lines], ["ok", ["paid_not_delivered → recovered", `signer payments: still ${paidAfterCrash}`]]);
    assert.equal(done.replay.tone, "blocked");
    assert.match(done.replay.lines[0], /^Havel: 402/);
    assert.equal(done.replay.lines[1], "Spree: 200, 200, 200 · 1 transfer on the rail");
    assert.deepEqual([done.unapproved.tone, done.unapproved.lines[0]], ["blocked", "403 SELLER_NOT_IN_MANDATE"]);
    assert.match(done.unapproved.lines[2], /received 0 USDC$/);
  });

  test("shoes: a cancelled order ends refunded; a second one is followed to the user's signed acceptance", async () => {
    assert.equal((await post(srv, "/api/auto-approve", { on: true })).status, 200);
    const orderOf = (events: DemoEvent[]) => events.filter((e) => e.type === "shoes.order").at(-1)?.data;
    for (const path of [["cancel"], ["advance", "advance", "accept"]]) {
      const bought = await run(srv, demo, "shoes.buy");
      assert.deepEqual(rehearsalProblems(bought), [], "shoes.buy");
      const purchase = bought.find((e) => e.type === "shoes.purchase")!.data;
      assert.ok(["completed", "fulfilment_pending"].includes(purchase.status), `purchase ${purchase.status} ${purchase.code ?? ""}`);
      assert.equal(orderOf(bought).orderStatus, "created");
      assert.equal(purchase.display, "94.90 EUR");
      const checkout = bought.find((e) => e.type === "shoes.checkout")!.data;
      assert.deepEqual(checkout.lines.map((l: { amount: string }) => l.amount), ["89.00 EUR", "5.90 EUR", "0.00 EUR"]);
      assert.deepEqual([checkout.total, checkout.limitDisplay, orderOf(bought).total], ["94.90 EUR", "120 EUR", "94.90 EUR"]);
      assert.match(checkout.facts[1], /^Delegated card token: max 94\.90 EUR, Sohle & Co only, this session, one use, until \d\d:\d\d:\d\d UTC$/);
      assert.equal(checkout.facts[2], "Address shared with Sohle & Co only");
      const shown = bought.find((e) => e.type === "shoes.products")!.data.items.find((p: { chosen: boolean }) => p.chosen);
      assert.deepEqual([shown.price, shown.delivery], ["89.00 EUR", "5.90 EUR"]);
      let last = bought;
      for (const what of path) {
        last = await run(srv, demo, `shoes.${what}`, what === "accept" ? { ok: true } : {});
        assert.deepEqual(rehearsalProblems(last), [], `shoes.${what}`);
      }
      const order = orderOf(last);
      if (path[0] === "cancel") assert.deepEqual([order.orderStatus, order.paymentStatus], ["refunded", "refunded"]);
      else {
        assert.equal(order.orderStatus, "delivered");
        assert.equal(order.acceptance.verdict, "Delivered");
        assert.match(order.acceptance.keyId, /^ed25519:/);
        assert.ok(last.some((e) => e.type === "approval.resolved" && e.data.kind === "deliveryAcceptance" && e.data.approved), "the verdict was signed on the device");
      }
    }
  });

  test("a failed rehearsal is detected: guardrail failures, shoes failures and missing orders", () => {
    const ev = (type: string, data: unknown): DemoEvent => ({ seq: 0, t: 0, type, data });
    assert.deepEqual(rehearsalProblems([ev("guard", { id: "race", state: "done", tone: "blocked", lines: ["2 settled · 4 BUDGET_EXCEEDED · charged 0.04 USDC"] }), ev("shoes.purchase", { status: "fulfilment_pending" })]), []);
    assert.equal(rehearsalProblems([ev("guard", { id: "race", state: "done", tone: "fail", lines: ["boom"] })]).length, 1);
    assert.equal(rehearsalProblems([ev("shoes.purchase", { status: "blocked", code: "BUDGET_EXCEEDED" })]).length, 1);
    assert.equal(rehearsalProblems([ev("shoes.note", { text: "There is no order yet: buy first." })]).length, 1);
    assert.equal(rehearsalProblems([ev("error", { action: "x", message: "y" })]).length, 1);
  });

  test("a failed rehearsal is detected: the weather run, verdicts and guardrail codes that did not go as scripted", () => {
    const ev = (type: string, data: unknown): DemoEvent => ({ seq: 0, t: 0, type, data });
    const one = (e: DemoEvent) => assert.equal(rehearsalProblems([e]).length, 1, JSON.stringify(e.data));
    one(ev("step", { scenario: "weather", index: 2, state: "failed" }));
    one(ev("purchase", { scenario: "weather", status: "completed_noncompliant" }));
    one(ev("purchase", { scenario: "weather", status: "paid_not_delivered", code: "DELIVERY_FAILED" }));
    one(ev("delivery", { scenario: "weather", status: "NonCompliant", checks: ["✗ observationAgeMinutes = 120 violates lteq 60"] }));
    one(ev("delivery", { scenario: "weather", status: "NotDelivered", checks: [] }));
    one(ev("shoes.note", { text: "The verdict was not signed on the device; nothing recorded." }));
    one(ev("guard", { id: "tamper", state: "done", tone: "blocked", lines: ["403 SOMETHING_ELSE", "", ""] }));
    one(ev("guard", { id: "unapproved", state: "done", tone: "blocked", lines: ["403 MANDATE_EXPIRED", "", "Shady Forecasts received 0 USDC"] }));
    one(ev("guard", { id: "replay", state: "done", tone: "blocked", lines: ["Havel: 402", "Spree: 200, 502, 502 · 1 transfer on the rail"] }));
    one(ev("guard", { id: "tamper", state: "done", tone: "unavailable", lines: ["Not run"] }));
    assert.deepEqual(rehearsalProblems([ev("step", { scenario: "weather", index: 1, state: "skipped" }), ev("purchase", { scenario: "weather", status: "completed" }), ev("delivery", { scenario: "weather", status: "Delivered", checks: [] })]), []);
    // Per action: the state the script expects afterwards
    const steps = (n: number) => Array.from({ length: n }, (_, i) => ev("step", { scenario: "weather", index: i, state: "done" }));
    assert.deepEqual(actionProblems("weather.autoplay", {}, steps(7)), []);
    assert.equal(actionProblems("weather.autoplay", {}, steps(3)).length, 1, "stopped after step 3 without an error");
    const order = (orderStatus: string, paymentStatus: string, acceptance?: unknown) => ev("shoes.order", { orderStatus, paymentStatus, acceptance });
    assert.deepEqual(actionProblems("shoes.cancel", {}, [order("refunded", "refunded")]), []);
    assert.equal(actionProblems("shoes.cancel", {}, [order("created", "settled")]).length, 1, "a merchant that ignored the cancel");
    assert.equal(actionProblems("shoes.advance", {}, [order("created", "settled")], [order("created", "settled")]).length, 1, "a merchant that ignored the advance");
    assert.equal(actionProblems("shoes.accept", { ok: true }, [order("delivered", "settled")]).length, 2, "no verdict recorded, nothing signed");
    assert.equal(actionProblems("guard.crash", {}, [ev("guard", { id: "crash", state: "done", tone: "warn", recoverable: false })]).length, 1);
  });

  test("recording through the API never silently overwrites an existing file", async () => {
    const first = await post(srv, "/api/record", { name: "api-test" });
    assert.equal(first.status, 200);
    const { path } = await first.json() as { path: string };
    assert.equal(path, join(recordings, "api-test.json"));
    const size = statSync(path).size;
    const again = await post(srv, "/api/record", { name: "api-test" });
    assert.equal(again.status, 409);
    assert.match((await again.json() as { error: string }).error, /exists/);
    const respelt = await post(srv, "/api/record", { name: "API Test" });
    assert.equal(respelt.status, 409);
    assert.equal((await respelt.json() as { file: string }).file, "recordings/api-test.json", "the confirm names the file that would really be replaced");
    assert.equal(statSync(path).size, size, "the existing recording is untouched");
    assert.equal((await post(srv, "/api/record", { name: "api-test", overwrite: true })).status, 200);
    assert.ok(loadRecording(path).events.length > 0);
  });

  test("reset while an approval is pending refuses it and starts a fresh session", async () => {
    assert.equal((await post(srv, "/api/auto-approve", { on: false })).status, 200);
    // A fresh session, so that buying shoes has things to approve again
    let previous = demo.log.all()[0];
    assert.equal((await post(srv, "/api/action/reset")).status, 202);
    await resetDone(demo, previous);
    previous = demo.log.all()[0];
    const seen: DemoEvent[] = [];
    const off = demo.log.subscribe((e) => seen.push(e));
    try {
      assert.equal((await post(srv, "/api/action/shoes.buy")).status, 202);
      await until(() => seen.some((e) => e.type === "approval.pending"));
      const pending = seen.find((e) => e.type === "approval.pending")!;
      assert.equal((await post(srv, "/api/action/reset")).status, 202);
      await resetDone(demo, previous);
      assert.ok(seen.some((e) => e.type === "approval.resolved" && e.data.id === pending.data.id && e.data.approved === false), "the pending item counts as rejected");
      assert.deepEqual(seen.filter((e) => e.type === "error").map((e) => e.data.message), [], "no action failed");
      assert.ok(!demo.log.all().some((e) => e.type === "approval.pending"), "nothing pending in the new session");
    } finally { off(); }
  });

  test("dashboard and phone page in a browser: approving on the phone advances the step", async (t) => {
    // Playwright is pre-installed globally in CI images; it is deliberately not a dependency.
    let playwright: { chromium: { launch(): Promise<any> } } | undefined;
    try { playwright = createRequire(import.meta.url)("playwright"); } catch { /* not installed here */ }
    if (!playwright) return t.skip("playwright is not available");
    assert.equal((await post(srv, "/api/auto-approve", { on: false })).status, 200);
    const previous = demo.log.all()[0];
    assert.equal((await post(srv, "/api/action/reset")).status, 202);
    await resetDone(demo, previous);

    const browser = await playwright.chromium.launch();
    try {
      const dash = await browser.newPage();
      const errors: string[] = [];
      dash.on("pageerror", (e: Error) => errors.push(e.message));
      await dash.goto(srv.dashboardUrl);
      for (let i = 0; i < 3; i++) {
        await dash.locator("#btn-next:not([disabled])").click();
        if (i < 2) await dash.locator(`.step:nth-child(${i + 1}).done`).waitFor();
      }
      await dash.locator(".step:nth-child(3).active").waitFor();

      const phone = await browser.newPage({ viewport: { width: 390, height: 844 } });
      await phone.goto(srv.phoneUrl);
      for (let i = 0; i < 4; i++) {
        const approve = phone.locator("button[data-approve=true]");
        await approve.waitFor();
        await approve.click();
        await phone.waitForFunction((n: number) => document.querySelectorAll(".ap-history li").length >= n, i + 1);
      }
      await dash.locator(".step:nth-child(3).done").waitFor();
      assert.match(await dash.locator("#confirmed").innerText(), /Mandate: ≤ 1 USDC, 2 sellers\s+signed/);
      assert.equal(demo.log.all().filter((e) => e.type === "approval.resolved" && e.data.via === "phone").length, 4);
      assert.deepEqual(errors, []);

      // A benign race: a double click on "Next step" runs the step once and shows no red alert.
      await dash.locator("#btn-next:not([disabled])").dblclick();
      await dash.locator(".step:nth-child(4).done").waitFor();
      await idle(demo);
      await sleep(200);
      assert.equal(await dash.locator("#alerts").innerText(), "", "no 'busy' alert after a double click");
      assert.notEqual(await dash.locator(".step:nth-child(5)").getAttribute("class"), "step done");
    } finally {
      await browser.close();
    }
  });

  test("Record in a browser: a session-<HHMM> default name, and the replace prompt names the file the server would replace", async (t) => {
    let playwright: { chromium: { launch(): Promise<any> } } | undefined;
    try { playwright = createRequire(import.meta.url)("playwright"); } catch { /* not installed here */ }
    if (!playwright) return t.skip("playwright is not available");
    await idle(demo);
    const browser = await playwright.chromium.launch();
    try {
      const dash = await browser.newPage();
      const errors: string[] = [];
      dash.on("pageerror", (e: Error) => errors.push(e.message));
      const prompts: string[] = [];
      let answer = false;
      dash.on("dialog", (d: { message(): string; accept(): Promise<void>; dismiss(): Promise<void> }) => { prompts.push(d.message()); return answer ? d.accept() : d.dismiss(); });
      await dash.goto(srv.dashboardUrl);
      await dash.locator("#record-form button:not([disabled])").waitFor();
      assert.match(await dash.locator("#record-name").inputValue(), /^session-\d{4}$/, "never the shipped 'talk' by default");
      const file = join(recordings, "browser-take.json");
      await dash.locator("#record-name").fill("Browser-Take");
      await dash.locator("#record-form button, #record-form [type=submit]").first().click();
      await until(() => existsSync(file));
      const size = statSync(file).size;
      await dash.locator("#record-form button, #record-form [type=submit]").first().click();
      await until(() => prompts.length === 1);
      assert.equal(prompts[0], "recordings/browser-take.json already exists. Replace it?", "the prompt names the real (normalised) file");
      await sleep(200);
      assert.equal(statSync(file).size, size, "dismissed: the recording is untouched");
      answer = true;
      await post(srv, "/api/action/weather.next");   // something new in the log, so a replaced file differs
      await idle(demo);
      await dash.locator("#record-form button, #record-form [type=submit]").first().click();
      await until(() => prompts.length === 2 && statSync(file).size !== size);
      assert.deepEqual(errors, []);
    } finally {
      await browser.close();
    }
  });

  test("Break it in the middle of the weather steps: no fixture signs the mandate the phone is about to be asked for", async () => {
    await freshSession(srv, demo, true);
    for (const step of ["Ask", "Clarify"]) {
      assert.ok((await run(srv, demo, "weather.next")).some((e) => e.type === "step" && e.data.state === "done"), step);
      const events = await run(srv, demo, "guard.tamper");
      assert.deepEqual(events.filter((e) => e.type === "fixture" || e.type === "approval.pending"), [], `after ${step}: nothing signed in the user's place`);
      const done = events.find((e) => e.type === "guard" && e.data.state === "done")!.data;
      assert.equal(done.tone, "unavailable", `after ${step}`);
      assert.match(done.lines[0], /^Not run: the weather steps have started/);
    }
    // Once the phone approved the mandate at step 3, Break it runs against it.
    assert.ok((await run(srv, demo, "weather.next")).some((e) => e.type === "step" && e.data.index === 2 && e.data.state === "done"));
    const after = await run(srv, demo, "guard.tamper");
    assert.deepEqual(after.filter((e) => e.type === "fixture"), []);
    assert.equal(after.find((e) => e.type === "guard" && e.data.state === "done")!.data.tone, "blocked");
  });

  test("Break it after the user rejected the mandate on the phone: no fixture signs it, the card says it did not run", async () => {
    await freshSession(srv, demo, false);
    const off = demo.log.subscribe((e) => {
      // The phone approves the meaning and preferences, and rejects the spending mandate.
      if (e.type === "approval.pending") setTimeout(() => demo.decide(e.data.id, e.data.kind !== "mandate", "phone"), 0);
    });
    try {
      for (let i = 0; i < 3; i++) await run(srv, demo, "weather.next");
    } finally { off(); }
    assert.ok(demo.log.all().some((e) => e.type === "approval.resolved" && e.data.kind === "mandate" && e.data.approved === false));
    const events = await run(srv, demo, "guard.tamper");
    assert.deepEqual(events.filter((e) => e.type === "fixture"), [], "nothing is signed in the user's place");
    assert.ok(!events.some((e) => e.type === "approval.resolved" && e.data.kind === "mandate" && e.data.approved), "no mandate approved");
    const done = events.find((e) => e.type === "guard" && e.data.state === "done")!.data;
    assert.equal(done.tone, "unavailable");
    assert.match(done.lines[0], /rejected on the phone/);
    assert.equal(rehearsalProblems(events).length, 1, "a rehearsal would not accept it");
    const mandates = demo.log.all().filter((e) => e.type === "pod").at(-1)!.data.containers.find((c: { path: string }) => c.path.endsWith("mandates/"));
    assert.deepEqual(mandates.docs, [], "no mandate in the Pod");
  });

  test("a second Buy while an order is open does not hide it: refused with a note, and the first order carries on", async () => {
    await freshSession(srv, demo, true);
    const first = await run(srv, demo, "shoes.buy");
    const order = first.filter((e) => e.type === "shoes.order").at(-1)!.data;
    const again = await run(srv, demo, "shoes.buy");
    assert.deepEqual(again.filter((e) => e.type === "shoes.purchase"), [], "no second checkout against the committed budget");
    assert.ok(again.some((e) => e.type === "shoes.note" && e.data.text.includes(order.orderId) && /still open/.test(e.data.text)));
    // The first order is still the one the controls act on
    const cancelled = (await run(srv, demo, "shoes.cancel")).filter((e) => e.type === "shoes.order").at(-1)!.data;
    assert.deepEqual([cancelled.orderId, cancelled.orderStatus, cancelled.paymentStatus], [order.orderId, "refunded", "refunded"]);
    // A closed order no longer blocks a new one
    const third = await run(srv, demo, "shoes.buy");
    assert.equal(third.filter((e) => e.type === "shoes.order").at(-1)!.data.orderStatus, "created");
  });

  test("an approval answered twice (phone and screen, or after auto-approve) is a benign 409, not a 404", async () => {
    await freshSession(srv, demo, false);
    const seen: DemoEvent[] = [];
    const off = demo.log.subscribe((e) => seen.push(e));
    try {
      assert.equal((await post(srv, "/api/action/shoes.buy")).status, 202);
      await until(() => seen.some((e) => e.type === "approval.pending"));
      const id = seen.find((e) => e.type === "approval.pending")!.data.id;
      assert.equal((await post(srv, `/api/approvals/${id}`, { approve: true, via: "phone" })).status, 200);
      const late = await post(srv, `/api/approvals/${id}`, { approve: true, via: "screen" });
      assert.equal(late.status, 409);
      assert.equal((await late.json() as { alreadyDecided: boolean }).alreadyDecided, true);
      assert.equal((await post(srv, "/api/approvals/ap-unknown", { approve: true })).status, 404, "an id that never existed is still a 404");
    } finally { off(); }
    await freshSession(srv, demo, true);
  });

  test("Reset during auto-play stops it before the payment, promptly, and says it is queued", async () => {
    await freshSession(srv, demo, true);
    const previous = demo.log.all()[0];
    const seen: DemoEvent[] = [];
    const off = demo.log.subscribe((e) => seen.push(e));
    try {
      assert.equal((await post(srv, "/api/action/weather.autoplay")).status, 202);
      await until(() => seen.some((e) => e.type === "step" && e.data.index === 3 && e.data.state === "active"));
      const at = seen.length, t0 = Date.now();
      assert.equal((await post(srv, "/api/action/reset")).status, 202);
      assert.equal((await post(srv, "/api/action/reset")).status, 202, "a second press is accepted and changes nothing");
      await resetDone(demo, previous);
      const after = seen.slice(at);
      assert.equal(after.filter((e) => e.type === "reset.queued").length, 1, "one reset queued, and the dashboard is told");
      assert.deepEqual(after.filter((e) => e.type === "purchase" || (e.type === "step" && e.data.index >= 4)), [], "no payment after Reset");
      assert.ok(!after.some((e) => e.type === "wire" && e.data.to === "signer"), "the signer was not asked to pay");
      assert.equal(after.filter((e) => e.type === "reset").length, 1, "exactly one reset");
      assert.ok(Date.now() - t0 < 15_000, `reset took ${Date.now() - t0} ms`);
      assert.deepEqual(seen.filter((e) => e.type === "error"), []);
    } finally { off(); }
    // The new session works
    const events = await run(srv, demo, "weather.next");
    assert.ok(events.some((e) => e.type === "step" && e.data.index === 0 && e.data.state === "done"));
  });

  test("Reset pressed while the Pay step runs: the signer is not asked to pay, so no payment is made", async () => {
    await freshSession(srv, demo, true);
    const env = demo["env"]!;
    const previous = demo.log.all()[0];
    const seen: DemoEvent[] = [];
    let pressed = false;
    // Press Reset at the latest possible moment: the gateway has just authorised the payment.
    const off = demo.log.subscribe((e) => {
      seen.push(e);
      if (!pressed && e.type === "wire" && e.data.to === "gateway" && /^\/authorize/.test(e.data.path) && e.data.status === 200) {
        pressed = true;
        assert.deepEqual(demo.act("reset", {}), { ok: true });
      }
    });
    try {
      assert.equal((await post(srv, "/api/action/weather.autoplay")).status, 202);
      await resetDone(demo, previous);
    } finally { off(); }
    assert.ok(pressed, "the Pay step reached the gateway");
    const signer = seen.filter((e) => e.type === "wire" && e.data.to === "signer");
    assert.deepEqual(signer.map((e) => e.data.status), [503], "the signer call was refused by the demo, not sent");
    assert.match(signer[0].data.response.join(" "), /not sent.*Reset/);
    assert.equal(env.rails.facilitator.chain.transfers.length, 0, "nothing moved on the rail");
    assert.ok(!seen.some((e) => e.type === "purchase" && e.data.status === "completed"), "no completed purchase");
    assert.equal(seen.filter((e) => e.type === "reset").length, 1);
  });

  test("--rehearse refuses to save a weather run that did not go as scripted (stale data delivered)", async () => {
    await freshSession(srv, demo, true);
    demo["env"]!.sellers.spree.setBehaviour({ observationAgeMinutes: 120 });
    await assert.rejects(rehearse(demo, "broken"), /rehearsal failed at weather\.autoplay, nothing saved: .*weather purchase completed_noncompliant/);
    assert.ok(!existsSync(join(recordings, "broken.json")), "nothing saved");
    await freshSession(srv, demo, true);
  });

  test("Reset recovers from a crashed Community Solid Server", async () => {
    await freshSession(srv, demo, true);
    const css = demo["css"];
    if (!css) return;   // POD_URL: an external server is not ours to restart
    css.proc.kill("SIGKILL");
    await until(() => css.proc.exitCode !== null || css.proc.signalCode !== null, 10_000);
    const previous = demo.log.all()[0];
    assert.equal((await post(srv, "/api/action/reset")).status, 202);
    await resetDone(demo, previous, 90_000);
    assert.notEqual(demo["css"]!.proc.pid, css.proc.pid, "a new Solid server was started");
    const events = await run(srv, demo, "weather.autoplay");
    assert.deepEqual(rehearsalProblems(events), []);
    assert.equal(events.find((e) => e.type === "purchase")!.data.status, "completed");
  });

  test("a non-QUIET caller that sends the quiet header is still traced, downstream too", async () => {
    await idle(demo);
    // Self-contained: run alone (--test-name-pattern), there is no weather mandate yet.
    if (!demo.log.all().some((e) => e.type === "budget" && e.data.key === "weather")) {
      assert.equal((await post(srv, "/api/auto-approve", { on: true })).status, 200);
      await run(srv, demo, "weather.autoplay");
    }
    const mandate = [...demo.log.all()].reverse().find((e) => e.type === "budget" && e.data.key === "weather")!.data.mandate;
    const before = demo.log.all().length;
    await actAs("assistant-1", () => fetch(`${demo["env"]!.gateway.url}/budget?mandate=${encodeURIComponent(mandate)}`, { headers: { [QUIET_HEADER]: "1" } }));
    const wire = demo.log.all().slice(before).filter((e) => e.type === "wire").map((e) => `${e.data.from} -> ${e.data.to}`);
    assert.ok(wire.includes("assistant-1 -> gateway"));
    assert.ok(wire.includes("gateway -> pod"), "the gateway's mandate read is shown: the header alone does not hide it");
  });

  test("after a Reset that could not start a session, other actions are refused with a clear message", async () => {
    await freshSession(srv, demo, true);
    const env = demo["env"];
    demo["env"] = undefined;   // what a failed boot() leaves behind: no environment, scenarios bound to the closed one
    try {
      for (const a of ["weather.next", "weather.answer", "guard.race", "shoes.buy"]) {
        const r = await post(srv, `/api/action/${a}`, { choice: 0 });
        assert.equal(r.status, 409, a);
        assert.match((await r.json() as { error: string }).error, /^no live session: the last Reset could not start one\. Press Reset again/, a);
      }
    } finally { demo["env"] = env; }
    assert.ok((await run(srv, demo, "weather.next")).some((e) => e.type === "step" && e.data.state === "done"), "with a session, actions run again");
  });

  test("while a Reset is starting the new session, other actions answer 'busy: reset' (benign), not 'no live session'", async () => {
    await freshSession(srv, demo, true);
    const previous = demo.log.all()[0];
    assert.equal((await post(srv, "/api/action/reset")).status, 202);
    const r = await post(srv, "/api/action/weather.next");
    assert.equal(r.status, 409);
    assert.equal((await r.json() as { error: string }).error, "busy: reset", "the dashboard treats this as a benign race");
    await resetDone(demo, previous);
  });

  test("Reset pressed again while a reset is running is accepted and changes nothing", async () => {
    await freshSession(srv, demo, true);
    const previous = demo.log.all()[0];
    const seen: DemoEvent[] = [];
    const off = demo.log.subscribe((e) => seen.push(e));
    try {
      assert.equal((await post(srv, "/api/action/reset")).status, 202);
      assert.equal((await post(srv, "/api/action/reset")).status, 202, "not a 'busy: reset' failure");
      await resetDone(demo, previous);
    } finally { off(); }
    assert.equal(seen.filter((e) => e.type === "session").length, 1, "exactly one fresh session");
    assert.deepEqual(seen.filter((e) => e.type === "error"), []);
  });

  // Last in this suite: it closes the shared demo (after() closing it again is harmless).
  test("close() during auto-play with a Reset queued stops it and boots nothing afterwards", async () => {
    await freshSession(srv, demo, true);
    const css = demo["css"];
    const seen: DemoEvent[] = [];
    const off = demo.log.subscribe((e) => seen.push(e));
    try {
      assert.equal((await post(srv, "/api/action/weather.autoplay")).status, 202);
      await until(() => seen.some((e) => e.type === "step" && e.data.index === 1 && e.data.state === "active"));
      assert.equal((await post(srv, "/api/action/reset")).status, 202);
      await demo.close();
      await idle(demo);   // whatever was running has stopped (a queued reset would have booted by now)
      await sleep(500);
    } finally { off(); }
    assert.deepEqual(seen.filter((e) => e.type === "session" || e.type === "purchase").map((e) => e.type), [], "no new session and no payment after close()");
    assert.equal(demo["css"]?.proc.pid, css?.proc.pid, "no new Solid server was started after close()");
  });
});

describe("web demo, replay", () => {
  test("the shipped recording replays the same events through the same API", async () => {
    const rec = loadRecording(RECORDING);
    const raw = readFileSync(RECORDING, "utf8");
    assert.doesNotMatch(raw, /tok_[0-9a-f]{6}|sk_sim_[0-9a-f]|acct-[0-9a-f]{8}/, "no card tokens, API keys or wallet accounts");
    const demo = new ReplayDemo(rec, { name: "talk", maxGapMs: 2, stepPauseMs: 0 });
    const srv = await startDemoServer(demo, { host: "127.0.0.1" });
    try {
      assert.equal((await post(srv, "/api/action/weather.autoplay")).status, 202);
      const purchase = await waitFor(srv, (e) => e.type === "purchase", 20_000);
      const recorded = rec.events.find((e) => e.type === "purchase")!;
      assert.deepEqual(purchase.data, recorded.data);
      await waitFor(srv, (e) => e.type === "busy" && e.data.action === null && demo.log.all().some((x) => x.type === "evidence"), 20_000);
      assert.equal((await post(srv, "/api/action/guard.race")).status, 202);
      const race = await waitFor(srv, (e) => e.type === "guard" && e.data.id === "race" && e.data.state === "done", 20_000);
      assert.match(race.data.lines[0], /^2 settled · 4 BUDGET_EXCEEDED/);
      assert.equal((await post(srv, "/api/approvals/x", { approve: true })).status, 409, "approvals belong to the recording");
      assert.deepEqual(demo.keys().filter((k) => k === "weather.step").length, 7);
    } finally {
      await srv.close();
      await demo.close();
    }
  });

  test("the shipped recording passes the rehearsal's checks", () => {
    const rec = loadRecording(RECORDING);
    assert.deepEqual(recordingProblems(rec.events), []);
    const text = readFileSync(RECORDING, "utf8");
    assert.doesNotMatch(text, new RegExp(QUIET_HEADER), "no demo-internal markers");
    // The agents' and the dashboard's bearer secrets (src/trust/agentAuth.ts) never reach a recording.
    assert.doesNotMatch(text, /sca_[0-9a-f]{8}|Bearer\s+[A-Za-z0-9._~+/-]{8}/, "no bearer secrets");
  });

  test("replay refuses answers the recording does not hold, instead of showing the recorded one", async () => {
    const demo = new ReplayDemo(loadRecording(RECORDING), { name: "talk", maxGapMs: 0, stepPauseMs: 0 });
    try {
      const info = demo.log.all().find((e) => e.type === "replay")!.data;
      assert.deepEqual([info.verdicts, info.choices], [[true], [1]], "what the dashboard may offer");
      const no = demo.act("shoes.accept", { ok: false });
      assert.equal(no.ok, false);
      assert.equal((no as { status: number }).status, 409);
      assert.match((no as { error: string }).error, /only has the verdict "as agreed"/);
      assert.ok(!demo.log.all().some((e) => e.type === "shoes.order"), "nothing played");
      const other = demo.act("weather.answer", { choice: 0 });
      assert.deepEqual([other.ok, (other as { status: number }).status], [false, 409]);
      assert.match((other as { error: string }).error, /observed within the last 60 minutes/);
      assert.deepEqual(demo.act("weather.answer", { choice: 1 }), { ok: true });
      await perform(demo, "shoes.accept", { ok: true });
      assert.equal(demo.log.all().filter((e) => e.type === "shoes.order").at(-1)!.data.acceptance.verdict, "Delivered");
    } finally { await demo.close(); }
  });

  test("reset during the pause between auto-played steps does not skip the next step", async () => {
    const demo = new ReplayDemo(loadRecording(RECORDING), { name: "talk", maxGapMs: 0, stepPauseMs: 300 });
    try {
      const firstDone = new Promise<void>((resolve) => { const off = demo.log.subscribe((e) => { if (e.type === "step" && e.data.index === 0 && e.data.state === "done") { off(); resolve(); } }); });
      assert.deepEqual(demo.act("weather.autoplay", {}), { ok: true });
      await firstDone;
      await sleep(50);   // in the pause before the second step
      assert.deepEqual(demo.act("reset", {}), { ok: true });
      await sleep(400);   // the interrupted auto-play wakes up after its pause
      const started: number[] = [];
      const off = demo.log.subscribe((e) => { if (e.type === "step" && e.data.state === "active") started.push(e.data.index); });
      for (let i = 0; i < 7; i++) await perform(demo, "weather.next");
      off();
      assert.deepEqual(started, [0, 1, 2, 3, 4, 5, 6]);
    } finally { await demo.close(); }
  });

  test("a replayed Break-it card says it is replayed, not run against the live services", async (t) => {
    let playwright: { chromium: { launch(): Promise<any> } } | undefined;
    try { playwright = createRequire(import.meta.url)("playwright"); } catch { /* not installed here */ }
    if (!playwright) return t.skip("playwright is not available");
    const demo = new ReplayDemo(loadRecording(RECORDING), { name: "talk", stepPauseMs: 0 });   // recorded pace (gaps capped at 1.2 s)
    const srv = await startDemoServer(demo, { host: "127.0.0.1", token: "replay-guard-token" });
    const browser = await playwright.chromium.launch();
    try {
      const dash = await browser.newPage();
      await dash.goto(srv.dashboardUrl);
      await dash.locator('[data-tab="breakit"]').click();
      await dash.locator('[data-act="guard.race"]:not([disabled])').click();
      const running = dash.locator(".verdict.running");
      await running.waitFor();
      assert.equal(await running.innerText(), "Replaying the recorded run…");
      await dash.locator(".verdict.blocked").first().waitFor();
    } finally {
      await browser.close();
      await srv.close();
      await demo.close();
    }
  });

  test("dashboard across a server restart: same token keeps the controls, another token locks them", async (t) => {
    let playwright: { chromium: { launch(): Promise<any> } } | undefined;
    try { playwright = createRequire(import.meta.url)("playwright"); } catch { /* not installed here */ }
    if (!playwright) return t.skip("playwright is not available");
    const demo = new ReplayDemo(loadRecording(RECORDING), { name: "talk", maxGapMs: 2, stepPauseMs: 0 });
    const token = "stable-test-token";
    let srv = await startDemoServer(demo, { host: "127.0.0.1", token });
    const port = srv.port;
    const browser = await playwright.chromium.launch();
    try {
      const dash = await browser.newPage();
      const errors: string[] = [];
      dash.on("pageerror", (e: Error) => errors.push(e.message));
      await dash.goto(`${srv.dashboardUrl}&view=business`);
      await dash.locator("#btn-next:not([disabled])").waitFor();
      assert.match(await dash.locator("#outcomes").innerText(), /replayed from recording talk/i, "business view says the guardrails are replayed");
      assert.match(await dash.locator("#breakit-lead").innerText(), /^Each button replays an attack or failure recorded/, "the Break-it lead does not claim a live run");
      assert.ok(await dash.locator("#locked").isHidden());
      for (const a of ["shoes.buy", "shoes.cancel", "shoes.buy", "shoes.advance", "shoes.advance"]) await perform(demo, a);
      // The shoes tab is not the one on screen: wait for the button to be in the DOM and enabled, not visible.
      await dash.locator('[data-k="accept-yes"]:not([disabled])').waitFor({ state: "attached" });
      assert.ok(await dash.locator('[data-k="accept-no"]').isDisabled(), "the verdict the recording does not hold cannot be pressed");
      assert.match(await dash.locator('[data-k="accept-no"]').innerText(), /not recorded/);
      assert.ok(await dash.locator("#btn-buy").isDisabled(), "no second Buy while the order waits for a verdict");

      await srv.close();
      srv = await startDemoServer(demo, { host: "127.0.0.1", port, token: "another-test-token" });
      await dash.locator("#locked").waitFor({ state: "visible", timeout: 20_000 });
      assert.ok(await dash.locator("#btn-next").isDisabled(), "a stale token shows the locked message, not buttons that fail");
      assert.match(await dash.locator("#locked").innerText(), /restarted with a different session token/);
      assert.notEqual(await dash.locator("#qr").getAttribute("hidden"), null, "no QR code of a dead token");

      await srv.close();
      srv = await startDemoServer(demo, { host: "127.0.0.1", port, token });
      await dash.locator("#btn-next:not([disabled])").waitFor({ timeout: 20_000 });
      assert.ok(await dash.locator("#locked").isHidden());
      assert.equal(await dash.locator("#qr").getAttribute("hidden"), null);
      assert.match(String(await dash.locator("#qr").getAttribute("src")), /^\/api\/qr\.svg\?t=stable-test-token&/);
      assert.deepEqual(errors, []);
    } finally {
      await browser.close();
      await srv.close();
      await demo.close();
    }
  });
});

describe("web demo, session token", () => {
  test("a stable token: DEMO_TOKEN, else one kept next to the recordings", () => {
    const dir = mkdtempSync(join(tmpdir(), "demo-token-"));
    try {
      const first = demoToken(dir, {});
      assert.match(first, /^[0-9a-f]{24}$/);
      assert.ok(existsSync(join(dir, ".demo-token")));
      assert.equal(statSync(join(dir, ".demo-token")).mode & 0o077, 0, "readable by the owner only");
      assert.equal(demoToken(dir, {}), first, "a restart keeps the token, so the printed URLs and the QR code stay valid");
      assert.equal(demoToken(dir, { DEMO_TOKEN: "presenter-chosen-token" }), "presenter-chosen-token");
      assert.throws(() => demoToken(dir, { DEMO_TOKEN: "short" }), /DEMO_TOKEN/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
