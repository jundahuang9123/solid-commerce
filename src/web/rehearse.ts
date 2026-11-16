/**
 * An unattended run of every screen against the live services, saved as a
 * recording. This is how the shipped fallback (recordings/) is produced, and
 * how a presenter makes a fresh one on their own laptop before a talk.
 *
 * "Verified" means: every event in the run passes rehearsalProblems() and
 * every presenter action reached the state the script expects
 * (actionProblems()). The checks are a list of what the talk shows; they
 * cannot prove that the services were right, only that the screens a
 * replay will show are the ones the presenter script describes.
 */
import type { DemoEvent } from "./events.js";
import type { DemoControls } from "./live.js";
import { WEATHER_STEPS } from "./scenarios/weather.js";

/** Presenter actions in talk order. Shoes: a refunded order first, then one followed to the user's verdict. */
export const REHEARSAL: Array<[string, Record<string, unknown>?]> = [
  ["weather.autoplay"],
  ["guard.tamper"], ["guard.price"], ["guard.race"], ["guard.crash"], ["guard.recover"], ["guard.replay"], ["guard.unapproved"],
  ["shoes.buy"], ["shoes.cancel"],
  ["shoes.buy"], ["shoes.advance"], ["shoes.advance"], ["shoes.accept", { ok: true }],
];

/** Start an action and wait until the demo is idle again. */
export function perform(demo: DemoControls, name: string, args: Record<string, unknown> = {}): Promise<void> {
  return new Promise((resolve, reject) => {
    const off = demo.log.subscribe((e) => { if (e.type === "busy" && e.data.action === null) { off(); resolve(); } });
    const out = demo.act(name, args);
    if (!out.ok) { off(); reject(new Error(`${name}: ${out.error}`)); }
  });
}

/** Tones a guardrail card may finish with in a rehearsal; "fail" and "unavailable" are not among them. */
const HELD = new Set(["blocked", "warn", "ok"]);

/**
 * What each Break-it card must say for the talk's story to be true: the exact
 * gateway code, not just any 403, and the redelivery that does not charge again.
 */
const GUARD_SCRIPT: Record<string, (lines: string[]) => boolean> = {
  tamper: (l) => l[0] === "403 MANDATE_NOT_CONFIRMED",
  unapproved: (l) => l[0] === "403 SELLER_NOT_IN_MANDATE" && /received 0 USDC$/.test(l[2] ?? ""),
  race: (l) => /^2 settled · 4 BUDGET_EXCEEDED · charged /.test(l[0] ?? ""),
  replay: (l) => /^Havel: 402\b/.test(l[0] ?? "") && /^Spree: 200, 200, 200 · 1 transfer on the rail$/.test(l[1] ?? ""),
  price: (l) => /: re-validated$/.test(l[0] ?? ""),
};

/**
 * Why a run is not fit to be the fallback, judged event by event: an action
 * that threw, a guardrail that did not hold or did not say what the script
 * says (the scenarios catch their own exceptions and report them as tone
 * "fail"), a weather step that failed, a weather purchase or delivery that did
 * not complete, a shoes checkout that did not place an order, a shoes control
 * pressed without an order (or with one still open), and a verdict that was
 * not signed. Empty when everything went as scripted.
 */
export function rehearsalProblems(events: readonly DemoEvent[]): string[] {
  const out: string[] = [];
  for (const { type, data } of events) {
    if (type === "error") out.push(`${data.action} failed: ${data.message}`);
    else if (type === "guard" && data.state === "done") {
      const lines: string[] = data.lines ?? [];
      if (!HELD.has(data.tone)) out.push(`guardrail ${data.id} did not hold (${data.tone}): ${lines.join("; ")}`);
      else if (GUARD_SCRIPT[data.id] && !GUARD_SCRIPT[data.id](lines)) out.push(`guardrail ${data.id} did not go as scripted: ${lines.join("; ")}`);
    }
    else if (type === "step" && data.scenario === "weather" && data.state === "failed") out.push(`weather step ${data.index + 1} (${WEATHER_STEPS[data.index] ?? "?"}) failed`);
    else if (type === "purchase" && data.scenario === "weather" && data.status !== "completed") out.push(`weather purchase ${data.status}${data.code ? ` (${data.code})` : ""}${data.reason ? `: ${data.reason}` : ""}`);
    else if (type === "delivery" && data.scenario === "weather" && data.status !== "Delivered") out.push(`weather delivery ${data.status}: ${(data.checks ?? []).join("; ")}`);
    else if (type === "shoes.purchase" && !["completed", "fulfilment_pending"].includes(data.status)) out.push(`shoes checkout ${data.status}${data.code ? ` (${data.code})` : ""}${data.reason ? `: ${data.reason}` : ""}`);
    else if (type === "shoes.note" && /no order yet|not signed|still open/i.test(String(data.text))) out.push(`shoes: ${data.text}`);
  }
  return out;
}

/**
 * Whether one presenter action ended where the script says it does. `events`
 * is everything the action emitted; `before` is the log up to it (for the
 * state the action started from).
 */
export function actionProblems(name: string, args: Record<string, unknown>, events: readonly DemoEvent[], before: readonly DemoEvent[] = []): string[] {
  const out: string[] = [];
  const [scope, what] = name.split(".");
  const lastOrder = (evs: readonly DemoEvent[]) => evs.filter((e) => e.type === "shoes.order").at(-1)?.data;
  if (name === "weather.autoplay") {
    const final = new Map<number, string>();
    for (const e of [...before, ...events]) if (e.type === "step" && e.data.scenario === "weather" && e.data.state !== "active") final.set(e.data.index, e.data.state);
    const missing = WEATHER_STEPS.map((s, i) => [s, final.get(i)] as const).filter(([, st]) => st !== "done" && st !== "skipped");
    if (missing.length) out.push(`weather did not complete: ${missing.map(([s, st]) => `${s} ${st ?? "not run"}`).join(", ")}`);
  } else if (scope === "guard") {
    const card = what === "recover" ? "crash" : what;
    const done = events.filter((e) => e.type === "guard" && e.data.id === card && e.data.state === "done").at(-1);
    if (!done) out.push(`${name} reported no verdict`);
    else if (what === "crash" && !done.data.recoverable) out.push("guard.crash left nothing to recover");
    else if (what === "recover" && done.data.tone !== "ok") out.push(`guard.recover did not recover: ${(done.data.lines ?? []).join("; ")}`);
  } else if (name === "shoes.buy") {
    const o = lastOrder(events);
    if (o?.orderStatus !== "created") out.push(`shoes.buy placed no new order${o ? ` (order ${o.orderStatus})` : ""}`);
  } else if (name === "shoes.cancel") {
    const o = lastOrder(events);
    if (o?.orderStatus !== "refunded" || o?.paymentStatus !== "refunded") out.push(`shoes.cancel did not end refunded: ${o ? `${o.orderStatus}/${o.paymentStatus}` : "no order"}`);
  } else if (name === "shoes.advance") {
    const o = lastOrder(events), prev = lastOrder(before);
    if (!o || !["shipped", "delivered"].includes(o.orderStatus) || o.orderStatus === prev?.orderStatus) out.push(`shoes.advance did not move the order on: ${prev?.orderStatus ?? "none"} → ${o?.orderStatus ?? "none"}`);
  } else if (name === "shoes.accept") {
    const o = lastOrder(events);
    const want = args.ok === false ? "NonCompliant" : "Delivered";
    if (o?.orderStatus !== "delivered" || o?.acceptance?.verdict !== want) out.push(`shoes.accept did not record "${want}": ${o ? `${o.orderStatus}, verdict ${o.acceptance?.verdict ?? "none"}` : "no order"}`);
    if (!events.some((e) => e.type === "approval.resolved" && e.data.kind === "deliveryAcceptance" && e.data.approved)) out.push("shoes.accept: the verdict was not signed on the device");
  }
  return out;
}

/**
 * A whole recording judged as rehearse() judges a run: every event, and every
 * presenter action (cut at its "action" event) against the script.
 */
export function recordingProblems(events: readonly DemoEvent[]): string[] {
  const out = rehearsalProblems(events);
  const starts = events.map((e, i) => [e, i] as const).filter(([e]) => e.type === "action");
  starts.forEach(([e, i], n) => {
    const end = starts[n + 1]?.[1] ?? events.length;
    out.push(...actionProblems(e.data.name, e.data.args ?? {}, events.slice(i, end), events.slice(0, i)));
  });
  const names = starts.map(([e]) => e.data.name);
  for (const [name] of REHEARSAL) if (!names.includes(name)) out.push(`the recording has no ${name}`);
  return out;
}

/** Run REHEARSAL and save it; throws (and writes nothing) at the first action that did not go as scripted. */
export async function rehearse(demo: DemoControls, path: string, progress: (line: string) => void = () => {}): Promise<string> {
  demo.setAuto(true);
  for (const [name, args = {}] of REHEARSAL) {
    progress(name);
    const from = demo.log.all().length;
    await perform(demo, name, args);
    const all = demo.log.all();
    const problems = [...rehearsalProblems(all), ...actionProblems(name, args, all.slice(from), all.slice(0, from))];
    if (problems.length) throw new Error(`rehearsal failed at ${name}, nothing saved: ${problems.join("; ")}`);
  }
  // Naming the recording on the command line is the explicit request to replace it.
  return demo.record(path, { overwrite: true });
}
