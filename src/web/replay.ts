/**
 * Recorded fallback: serves the same UI from a saved event log when the live
 * services cannot be trusted on stage (no network, a laptop that misbehaves).
 *
 * The recording is cut into units at the points where the presenter acted:
 * each weather step, and each other action (a guardrail, a shoes control).
 * Pressing the same control in the replay plays the next recorded unit for
 * it, with the recorded gaps between events (capped), so the screens fill in
 * at a realistic pace. Nothing is computed: it is the recording, re-emitted.
 *
 * A control whose choice the recording does not contain (the "No, not
 * compliant" verdict when only "Yes" was recorded, a meaning of "current"
 * other than the recorded one) is refused with 409 and greyed out on the
 * dashboard: the replay never shows an answer the presenter did not give.
 */
import { EventLog, type DemoEvent, type Recording } from "./events.js";
import type { ActionResult, DemoControls } from "./live.js";
import { sleep } from "./scenarios/common.js";

interface Unit { key: string; events: DemoEvent[]; played: boolean; args?: Record<string, unknown> }

export interface ReplayOptions { name: string; maxGapMs?: number; stepPauseMs?: number }

/** Live-only bookkeeping; the replay emits its own busy markers around each unit. */
const CONTROL_EVENTS = new Set(["busy", "action", "reset", "recorded"]);

export class ReplayDemo implements DemoControls {
  readonly mode = "replay" as const;
  readonly log = new EventLog();
  private readonly preamble: DemoEvent[];
  private readonly units: Unit[];
  /** The verdicts (shoes.accept ok) and the meanings of "current" (option index) the recording holds. */
  private readonly verdicts: boolean[];
  private readonly choices: number[];
  private readonly options: string[];
  private busy?: string;
  private generation = 0;

  constructor(private readonly rec: Recording, private readonly opts: ReplayOptions) {
    const { preamble, units } = cut(rec.events);
    this.preamble = preamble;
    this.units = units;
    this.verdicts = [...new Set(units.filter((u) => u.key === "shoes.accept").map((u) => u.args?.ok !== false))];
    this.choices = [...new Set(rec.events.filter((e) => e.type === "answer" && e.data.scenario === "weather").map((e) => Number(e.data.index)))];
    this.options = rec.events.find((e) => e.type === "question" && e.data.scenario === "weather")?.data.options ?? [];
    this.restart();
  }

  /** The keys the presenter can trigger, in recorded order (for the docs and tests). */
  keys(): string[] { return this.units.map((u) => u.key); }

  private restart() {
    this.generation++;
    this.busy = undefined;
    for (const u of this.units) u.played = false;
    this.log.reset({ mode: "replay" });
    for (const e of this.preamble) this.log.replay(e);
    this.log.emit("replay", { name: this.opts.name, recordedAt: this.rec.recordedAt, units: this.units.length, verdicts: this.verdicts, choices: this.choices });
  }

  act(name: string, args: Record<string, unknown>): ActionResult {
    if (name === "reset") { this.restart(); return { ok: true }; }
    if (name === "weather.answer") {
      // The recorded answer is replayed with the next step; any other answer would be silently replaced by it.
      if (this.choices.includes(Number(args.choice))) return { ok: true };
      const recorded = this.choices.map((i) => `"${this.options[i] ?? i}"`).join(" or ");
      return { ok: false, status: 409, error: recorded ? `the recording only has the answer ${recorded}` : "the recording has no clarification to answer" };
    }
    if (this.busy) return { ok: false, status: 409, error: `busy: ${this.busy}` };
    const key = name === "weather.next" || name === "weather.autoplay" ? "weather.step" : name;
    let queue = this.units.filter((u) => u.key === key);
    if (name === "shoes.accept" && queue.length) {
      const ok = args.ok !== false;
      queue = queue.filter((u) => (u.args?.ok !== false) === ok);
      if (!queue.length) return { ok: false, status: 409, error: `the recording only has the verdict "${ok ? "not compliant" : "as agreed"}"; answer that way, or use a live session` };
    }
    if (!queue.length) return { ok: false, status: 404, error: `the recording has no "${name}"` };
    // Play the next unplayed unit; once all were played, repeat the last one.
    const pending = queue.filter((u) => !u.played);
    const plan = name === "weather.autoplay" ? pending : [pending[0] ?? queue[queue.length - 1]];
    if (!plan.length) return { ok: false, status: 409, error: "this scenario is complete in the recording; reset to replay it" };
    void this.play(name, plan);
    return { ok: true };
  }

  private async play(name: string, plan: Unit[]) {
    const gen = this.generation;
    this.busy = name;
    this.log.emit("busy", { action: name });
    for (const [n, u] of plan.entries()) {
      if (n > 0) {
        await sleep(this.opts.stepPauseMs ?? 900);
        if (gen !== this.generation) return;   // reset during the pause: the next unit belongs to the new session
      }
      u.played = true;
      let prev = u.events[0]?.t ?? 0;
      for (const e of u.events) {
        await sleep(Math.min(Math.max(e.t - prev, 0), this.opts.maxGapMs ?? 1200));
        prev = e.t;
        if (gen !== this.generation) return;   // reset while playing
        this.log.replay(e);
      }
    }
    this.busy = undefined;
    this.log.emit("busy", { action: null });
  }

  decide(): boolean { return false; }
  setAuto(): void { /* approvals were decided when the session was recorded */ }
  record(): string { throw new Error("cannot record while replaying"); }
  async close() { this.generation++; }
}

/**
 * Unit boundaries: every weather step ("step" with state "active") and every
 * other presenter action ("busy" naming it). Events between two units (an
 * auto-approve toggle, a chosen meaning) belong to the unit that follows.
 */
function cut(events: DemoEvent[]): { preamble: DemoEvent[]; units: Unit[] } {
  const preamble: DemoEvent[] = [];
  const units: Unit[] = [];
  let carry: DemoEvent[] = [];
  let current: Unit | undefined;
  for (const e of events) {
    const startsStep = e.type === "step" && e.data.scenario === "weather" && e.data.state === "active";
    const startsAction = e.type === "busy" && typeof e.data.action === "string" && !e.data.action.startsWith("weather.") && e.data.action !== "reset";
    if (startsStep || startsAction) {
      current = { key: startsStep ? "weather.step" : e.data.action, events: carry, played: false };
      carry = [];
      units.push(current);
    }
    // The presenter's arguments (the verdict given) belong to the unit the action started.
    if (e.type === "action" && current && current.key === e.data.name) current.args = e.data.args;
    if (CONTROL_EVENTS.has(e.type)) continue;
    // Choices and toggles made while idle play with the next unit, not the previous one.
    const idle = e.type === "weather.choice" || e.type === "approval.auto";
    if (idle || !current) (current && idle ? carry : preamble).push(e);
    else current.events.push(e);
  }
  if (carry.length) units[units.length - 1]?.events.push(...carry);
  return { preamble, units };
}
