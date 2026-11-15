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
import { perform, rehearsalProblems } from "../src/web/rehearse.js";
import { QUIET, actAs } from "../src/web/wire.js";
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
const idle = (demo: LiveDemo) => until(() => [...demo.log.all()].reverse().find((e) => e.type === "busy")?.data.action === null);

/** Wait until a reset has produced a new log (fresh Pod and environment) that has finished starting up. */
async function resetDone(demo: LiveDemo, previous: DemoEvent) {
  await until(() => { const log = demo.log.all(); return log[0] !== previous && log.some((e) => e.type === "session") && log.at(-1)?.type === "busy" && log.at(-1)?.data.action === null; });
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
    assert.match(done.race.lines[0], /^2 settled · 4 BUDGET_EXCEEDED · charged/);
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
    assert.deepEqual(rehearsalProblems([ev("guard", { id: "race", state: "done", tone: "blocked", lines: ["ok"] }), ev("shoes.purchase", { status: "fulfilment_pending" })]), []);
    assert.equal(rehearsalProblems([ev("guard", { id: "race", state: "done", tone: "fail", lines: ["boom"] })]).length, 1);
    assert.equal(rehearsalProblems([ev("shoes.purchase", { status: "blocked", code: "BUDGET_EXCEEDED" })]).length, 1);
    assert.equal(rehearsalProblems([ev("shoes.note", { text: "There is no order yet: buy first." })]).length, 1);
    assert.equal(rehearsalProblems([ev("error", { action: "x", message: "y" })]).length, 1);
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
    } finally {
      await browser.close();
    }
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
      assert.ok(await dash.locator("#locked").isHidden());

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
