/**
 * The demo's single event log. Everything the browser shows is folded from
 * these events, so a saved log replays into exactly the same UI
 * (src/web/replay.ts). Nothing renders from server state that is not in here.
 *
 * Secrets are redacted on the way in, which keeps them out of the SSE stream
 * and out of recordings alike.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface DemoEvent { seq: number; t: number; type: string; data: any }

export interface Recording { format: "solid-commerce-demo-recording"; version: 1; recordedAt: string; events: DemoEvent[] }

/**
 * Credentials that pass through the demo process. The wire summaries never
 * copy request bodies, so these are a second line of defence for anything a
 * log line or error message might echo.
 */
const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/\btok_[0-9a-f]{6,}\b/g, "tok_[redacted card token]"],
  [/\bsk_sim_[0-9a-f]+\b/g, "sk_sim_[redacted API key]"],
  [/\bacct-[0-9a-f]{8}\b/g, "acct-[redacted wallet account]"],
];

export function redact<T>(v: T): T {
  if (typeof v === "string") return SECRET_PATTERNS.reduce((s, [re, to]) => s.replace(re, to), v as string) as T;
  if (Array.isArray(v)) return v.map(redact) as T;
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, redact(x)])) as T;
  return v;
}

export class EventLog {
  private events: DemoEvent[] = [];
  private started = Date.now();
  private seq = 0;
  private readonly subscribers = new Set<(e: DemoEvent) => void>();

  emit(type: string, data: unknown = {}): DemoEvent {
    return this.push({ seq: 0, t: Date.now() - this.started, type, data: redact(data) });
  }

  /** Re-emit an event from a recording, keeping its recorded time offset. */
  replay(e: DemoEvent): DemoEvent {
    return this.push({ ...e, seq: 0 });
  }

  private push(e: DemoEvent): DemoEvent {
    e.seq = ++this.seq;   // sequence numbers keep increasing across resets, so SSE clients can resume
    this.events.push(e);
    for (const s of this.subscribers) s(e);
    return e;
  }

  all(): readonly DemoEvent[] { return this.events; }

  subscribe(fn: (e: DemoEvent) => void): () => void {
    this.subscribers.add(fn);
    return () => this.subscribers.delete(fn);
  }

  /** Start a new session: clients fold from the "reset" event onwards. */
  reset(data: unknown = {}) {
    this.events = [];
    this.started = Date.now();
    this.emit("reset", data);
  }

  /** Write the log as a recording; with `overwrite: false`, fail with EEXIST rather than replace a file. */
  save(path: string, opts: { overwrite?: boolean } = {}) {
    const rec: Recording = { format: "solid-commerce-demo-recording", version: 1, recordedAt: new Date().toISOString(), events: this.events.map((e) => ({ ...e })) };
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(rec, null, 1) + "\n", { flag: opts.overwrite === false ? "wx" : "w" });
  }
}

export function loadRecording(path: string): Recording {
  const rec = JSON.parse(readFileSync(path, "utf8")) as Recording;
  if (rec.format !== "solid-commerce-demo-recording" || rec.version !== 1 || !Array.isArray(rec.events)) throw new Error(`${path} is not a demo recording`);
  return rec;
}
