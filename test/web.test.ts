/**
 * Web demo (src/web): the JSON API and SSE stream against the live services,
 * a browser smoke test of the dashboard and the phone approval page, and a
 * replay of the shipped recording.
 */
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { LiveDemo } from "../src/web/live.js";
import { ReplayDemo } from "../src/web/replay.js";
import { loadRecording, type DemoEvent } from "../src/web/events.js";
import { startDemoServer, type DemoServer } from "../src/web/server.js";

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

describe("web demo, live", () => {
  let demo: LiveDemo;
  let srv: DemoServer;
  before(async () => {
    demo = await LiveDemo.start({ recordingsDir: fileURLToPath(new URL("../recordings/", import.meta.url)), autoApproveDelayMs: 50, stepPauseMs: 50 });
    srv = await startDemoServer(demo, { host: "127.0.0.1" });
  });
  after(async () => { await srv.close(); await demo.close(); });

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
  });

  test("dashboard and phone page in a browser: approving on the phone advances the step", async (t) => {
    // Playwright is pre-installed globally in CI images; it is deliberately not a dependency.
    let playwright: { chromium: { launch(): Promise<any> } } | undefined;
    try { playwright = createRequire(import.meta.url)("playwright"); } catch { /* not installed here */ }
    if (!playwright) return t.skip("playwright is not available");
    assert.equal((await post(srv, "/api/auto-approve", { on: false })).status, 200);
    const previous = demo.log.all()[0];
    assert.equal((await post(srv, "/api/action/reset")).status, 202);
    // A new log (fresh Pod and environment) that has finished starting up
    await until(() => { const log = demo.log.all(); return log[0] !== previous && log.some((e) => e.type === "session") && log.at(-1)?.type === "busy" && log.at(-1)?.data.action === null; });

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
});
