/**
 * The live demo: one real environment (Community Solid Server, simulated
 * rails, sellers behind the 402 proxy, checkout merchants, gateway, signer)
 * plus the scenarios that drive it. Every action runs against those services;
 * the browser only sees what lands in the event log.
 *
 * Actions run one at a time (a talk has one presenter), and asynchronously:
 * an HTTP request starts an action and the result arrives over SSE, since a
 * step may wait for a person to approve on their phone.
 */
import type { ChildProcess } from "node:child_process";
import { join } from "node:path";
import { startCss, startCheckoutEnvironment, AGENT_1, AGENT_2, type CheckoutEnvironment } from "../demo/environment.js";
import type { SpendingMandate } from "../model.js";
import { autoApprove } from "../grounding/approval.js";
import { ApprovalBroker, type Via } from "./approvals.js";
import { EventLog } from "./events.js";
import { WireTap, QUIET, actAs, type Component } from "./wire.js";
import { WeatherScenario } from "./scenarios/weather.js";
import { Guardrails } from "./scenarios/guardrails.js";
import { ShoesScenario } from "./scenarios/shoes.js";

export type ActionResult = { ok: true } | { ok: false; status: number; error: string };

/** What the HTTP server needs from a demo, live or replayed. */
export interface DemoControls {
  readonly mode: "live" | "replay";
  readonly log: EventLog;
  act(name: string, args: Record<string, unknown>): ActionResult;
  decide(id: string, approved: boolean, via: Via): boolean;
  setAuto(on: boolean): void;
  record(name: string): string;
  close(): Promise<void>;
}

export interface LiveOptions {
  /** An already running Solid server; otherwise one Community Solid Server is started and reused across resets. */
  podUrl?: string;
  recordingsDir: string;
  /** How long an auto-approved item stays visible. */
  autoApproveDelayMs?: number;
  /** Pause between steps during auto-play. */
  stepPauseMs?: number;
}

/** Context handed to scenarios: the environment and the shared panels they update. */
export interface DemoContext {
  env: CheckoutEnvironment;
  log: EventLog;
  broker: ApprovalBroker;
  /** Approved 402 sellers (weather) or approved checkout merchants (shoes): what a mandate may name. */
  approved(kind: "sellers" | "merchants"): string[];
  /** Display name for a seller or merchant WebID. */
  nameOf(webId: string): string;
  /** Show this mandate's budget (GET /budget on the gateway) under `key`. */
  track(key: string, label: string, mandate: SpendingMandate): void;
  /** Agent log lines, shown in the conversation panel in research view. */
  agentLog(agent: string): (line: string) => void;
  /** Commit a demo fixture (not part of the story) with the device auto-approving; said so in the log. */
  fixture<T>(what: string, fn: () => Promise<T>): Promise<T>;
  /** Update the Pod panel and budget meters now (they also update after every action). */
  refresh(): Promise<void>;
  /** Put a Pod document's Turtle into the Pod panel. */
  showDoc(url: string, why: string): Promise<void>;
  stepPauseMs: number;
}

export class LiveDemo implements DemoControls {
  readonly mode = "live" as const;
  readonly log = new EventLog();
  readonly tap = new WireTap(this.log);
  readonly broker: ApprovalBroker;
  private env?: CheckoutEnvironment;
  private css?: { url: string; proc: ChildProcess };
  private uninstall: () => void;
  private busy?: string;
  private running?: Promise<void>;
  private budgets = new Map<string, { label: string; mandate: SpendingMandate }>();
  private lastDoc?: string;
  private weather?: WeatherScenario;
  private guard?: Guardrails;
  private shoes?: ShoesScenario;

  private constructor(private readonly opts: LiveOptions) {
    // Installed before the environment starts: PodClient captures fetch when constructed.
    this.uninstall = this.tap.install();
    this.broker = new ApprovalBroker(this.log, () => this.env!.device, (w) => this.nameOf(w), opts.autoApproveDelayMs ?? 600);
  }

  static async start(opts: LiveOptions): Promise<LiveDemo> {
    const d = new LiveDemo(opts);
    try { await d.boot(); } catch (e) { await d.close(); throw e; }
    return d;
  }

  /** (Re)start the environment with a fresh Pod and an empty event log. */
  private async boot() {
    this.broker.cancelAll();
    if (this.env) await this.env.close();
    this.tap.clear();
    this.budgets.clear();
    this.lastDoc = undefined;
    if (!this.opts.podUrl && !process.env.POD_URL) this.css ??= await startCss();
    const env = await startCheckoutEnvironment({ podUrl: this.opts.podUrl ?? this.css?.url, decider: this.broker.decider });
    this.env = env;
    this.log.reset({ mode: "live" });
    this.broker.reopen();
    this.registerComponents(env);
    this.log.emit("session", {
      mode: "live", podRoot: env.podRoot, webId: env.layout.webId, approvalKey: env.device.keyId,
      payer: env.signer.evmAddress, sellers: env.registry.list().map((s) => s.name), merchants: env.registry.listMerchants().map((m) => m.name),
      autoApprove: this.broker.auto,
    });
    const ctx = this.context(env);
    this.weather = new WeatherScenario(ctx);
    this.guard = new Guardrails(ctx, () => this.weather!.groundedMandate());
    this.shoes = new ShoesScenario(ctx);
    await this.refresh();
  }

  private registerComponents(env: CheckoutEnvironment) {
    const reg = (url: string, c: Component, server?: import("node:http").Server) => this.tap.register(url, c, server);
    reg(env.gateway.url, { id: "gateway", label: "gateway", role: "gateway" }, env.gateway.server);
    reg(env.signer.url, { id: "signer", label: "signer", role: "signer" }, env.signer.server);
    const { spree, havel, shady } = env.sellers;
    reg(spree.url, { id: "spree", label: "Spree Weather", role: "seller" }, spree.server);
    reg(havel.url, { id: "havel", label: "Havel Data", role: "seller" }, havel.server);
    reg(shady.url, { id: "shady", label: "Shady Forecasts", role: "seller" }, shady.server);
    reg(env.rails.facilitator.url, { id: "facilitator", label: "x402 facilitator", role: "rail" }, env.rails.facilitator.server);
    reg(env.rails.lightning.url, { id: "lightning", label: "Lightning node", role: "rail" }, env.rails.lightning.server);
    reg(env.rails.psp.url, { id: "psp", label: "card PSP", role: "rail" }, env.rails.psp.server);
    for (const [id, m] of Object.entries(env.merchants)) reg(m.url, { id, label: m.name, role: "merchant" }, m.server);
    reg(env.podRoot, { id: "pod", label: "Pod", role: "pod" });
    this.tap.setPodRoot(env.podRoot);
    const actors: Component[] = [
      { id: AGENT_1.split(":").pop()!, label: "assistant-1", role: "assistant" },
      { id: AGENT_2.split(":").pop()!, label: "assistant-2", role: "assistant" },
    ];
    this.log.emit("components", { components: [...actors, ...this.tap.components()] });
  }

  private context(env: CheckoutEnvironment): DemoContext {
    return {
      env, log: this.log, broker: this.broker, stepPauseMs: this.opts.stepPauseMs ?? 900,
      approved: (kind) => (kind === "sellers" ? env.registry.list() : env.registry.listMerchants()).map((s) => s.webId),
      nameOf: (w) => this.nameOf(w),
      track: (key, label, mandate) => { this.budgets.set(key, { label, mandate }); },
      agentLog: (agent) => (line) => this.log.emit("agent.log", { agent, line }),
      fixture: async (what, fn) => {
        this.log.emit("fixture", { what });
        env.device.setDecider(autoApprove);
        try { return await fn(); } finally { env.device.setDecider(this.broker.decider); }
      },
      refresh: () => this.refresh(),
      showDoc: (url, why) => actAs(QUIET, () => this.showDoc(env, url, why)),
    };
  }

  private nameOf(webId: string): string {
    const env = this.env!;
    return [...env.registry.list(), ...env.registry.listMerchants()].find((s) => s.webId === webId)?.name
      ?? Object.values(env.merchants).find((m) => m.webId === webId)?.name
      ?? Object.values(env.sellers).find((s) => s.webId === webId)?.currentOffer().payload.sellerName ?? webId;
  }

  act(name: string, args: Record<string, unknown>): ActionResult {
    if (name === "weather.answer") return this.weather!.choose(Number(args.choice));
    const fn = this.action(name, args);
    if (!fn) return { ok: false, status: 404, error: `unknown action ${name}` };
    if (this.busy) {
      if (name !== "reset" || this.busy === "reset") return { ok: false, status: 409, error: `busy: ${this.busy}` };
      // Reset must work even while a step waits for a phone that never answers: refuse what is
      // pending (so that step ends the way a rejection would), then restart once it has.
      this.broker.cancelAll();
      void this.running?.then(() => this.act("reset", {}));
      return { ok: true };
    }
    this.busy = name;
    this.log.emit("busy", { action: name });
    this.running = (async () => {
      try {
        if (name !== "reset") this.log.emit("action", { name, args });
        await fn();
      } catch (e) {
        this.log.emit("error", { action: name, message: (e as Error).message });
      } finally {
        this.busy = undefined;
        await this.refresh().catch(() => {});
        this.log.emit("busy", { action: null });
      }
    })();
    return { ok: true };
  }

  private action(name: string, args: Record<string, unknown>): (() => Promise<unknown>) | undefined {
    const [scope, what] = name.split(".");
    if (name === "reset") return () => this.boot();
    if (scope === "weather") return this.weather!.action(what, args);
    if (scope === "guard") return this.guard!.action(what);
    if (scope === "shoes") return this.shoes!.action(what, args);
    return undefined;
  }

  decide(id: string, approved: boolean, via: Via) { return this.broker.decide(id, approved, via); }
  setAuto(on: boolean) { this.broker.setAuto(on); }

  record(name: string): string {
    const path = join(this.opts.recordingsDir, `${name.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-|-$/g, "") || "session"}.json`);
    this.log.save(path);
    this.log.emit("recorded", { path, events: this.log.all().length });
    return path;
  }

  /** Re-read the Pod listing, the most recently written document and the tracked budgets. */
  private async refresh() {
    const env = this.env;
    if (!env) return;
    await actAs(QUIET, async () => {
      const l = env.layout;
      const containers = [l.commonGround, l.preferences, l.mandates, l.proposals, l.history, l.intentions, l.transactions, l.addresses];
      const listed = await Promise.all(containers.map(async (c) => ({ path: c.slice(env.podRoot.length), docs: (await env.pod.list(c)).map((d) => d.slice(c.length)) })));
      this.log.emit("pod", { root: env.podRoot, containers: listed, files: [l.wallet.slice(env.podRoot.length)] });
      const latest = this.tap.lastPodWrite;
      if (latest && latest !== this.lastDoc) {
        this.lastDoc = latest;
        await this.showDoc(env, latest, "most recent write");
      }
      for (const [key, { label, mandate }] of this.budgets) {
        const r = await fetch(`${env.gateway.url}/budget?mandate=${encodeURIComponent(mandate.id)}`);
        const b = await r.json() as Record<string, string>;
        this.log.emit("budget", {
          key, label, mandate: mandate.id, ...b, status: r.status,
          maxPerTransaction: mandate.maxPerTransaction, sellers: mandate.allowedSellers.length, schemes: mandate.allowedSchemes, validUntil: mandate.validUntil,
        });
      }
    });
  }

  private async showDoc(env: CheckoutEnvironment, url: string, why: string) {
    const doc = await env.pod.get(url);
    if (doc) this.log.emit("pod.doc", { url, path: url.slice(env.podRoot.length), turtle: doc.text, why });
  }

  async close() {
    this.broker.cancelAll();
    await this.env?.close().catch(() => {});
    this.css?.proc.kill();
    this.uninstall();
  }
}
