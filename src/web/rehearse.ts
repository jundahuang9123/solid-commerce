/**
 * An unattended run of every screen against the live services, saved as a
 * recording. This is how the shipped fallback (recordings/) is produced, and
 * how a presenter makes a fresh one on their own laptop before a talk.
 */
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

export async function rehearse(demo: DemoControls, path: string, progress: (line: string) => void = () => {}): Promise<string> {
  demo.setAuto(true);
  for (const [name, args] of REHEARSAL) {
    progress(name);
    await perform(demo, name, args);
    const failed = demo.log.all().filter((e) => e.type === "error");
    if (failed.length) throw new Error(`${name} failed: ${failed.map((e) => e.data.message).join("; ")}`);
  }
  return demo.record(path);
}
