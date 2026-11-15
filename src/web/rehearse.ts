/**
 * An unattended run of every screen against the live services, saved as a
 * recording. This is how the shipped fallback (recordings/) is produced, and
 * how a presenter makes a fresh one on their own laptop before a talk.
 */
import type { DemoEvent } from "./events.js";
import type { DemoControls } from "./live.js";

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

/**
 * Why a run is not fit to be the fallback: an action that threw, a guardrail
 * that did not hold (the scenarios catch their own exceptions and report them
 * as tone "fail"), a shoes checkout that did not place an order, or a shoes
 * control pressed without an order. Empty when everything went as scripted.
 */
export function rehearsalProblems(events: readonly DemoEvent[]): string[] {
  const out: string[] = [];
  for (const { type, data } of events) {
    if (type === "error") out.push(`${data.action} failed: ${data.message}`);
    else if (type === "guard" && data.state === "done" && data.tone === "fail") out.push(`guardrail ${data.id} did not hold: ${(data.lines ?? []).join("; ")}`);
    else if (type === "shoes.purchase" && !["completed", "fulfilment_pending"].includes(data.status)) out.push(`shoes checkout ${data.status}${data.code ? ` (${data.code})` : ""}${data.reason ? `: ${data.reason}` : ""}`);
    else if (type === "shoes.note" && /no order yet/i.test(String(data.text))) out.push(`shoes: ${data.text}`);
  }
  return out;
}

/** Run REHEARSAL and save it; throws (and writes nothing) at the first action that did not go as scripted. */
export async function rehearse(demo: DemoControls, path: string, progress: (line: string) => void = () => {}): Promise<string> {
  demo.setAuto(true);
  for (const [name, args] of REHEARSAL) {
    progress(name);
    await perform(demo, name, args);
    const problems = rehearsalProblems(demo.log.all());
    if (problems.length) throw new Error(`rehearsal failed at ${name}, nothing saved: ${problems.join("; ")}`);
  }
  // Naming the recording on the command line is the explicit request to replace it.
  return demo.record(path, { overwrite: true });
}
