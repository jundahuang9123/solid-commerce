/**
 * Screen 3, "Break it": six attacks and failures run live against the
 * services. The verdict shown is what the gateway, signer, seller or rail
 * answered; the logic follows the guardrail section of src/demo/run-demo.ts
 * and the completion checks in test/e2e.test.ts.
 */
import { AGENT_1, AGENT_2 } from "../../demo/environment.js";
import type { SpendingMandate } from "../../model.js";
import type { PurchaseResult } from "../../agent/assistant.js";
import { parse402 } from "../../payments/http402.js";
import { RECEIPT_HEADER } from "../../payments/types.js";
import { b64json, postJson } from "../../util/http.js";
import { newId } from "../../util/crypto.js";
import { fmt, toMajor } from "../../util/money.js";
import { actAs, QUIET } from "../wire.js";
import type { DemoContext } from "../live.js";

const BERLIN = { text: "Get me a current Berlin weather report.", category: "WeatherReport", subject: "Berlin" };
const id = (agent: string) => agent.split(":").pop()!;
type Tone = "blocked" | "ok" | "warn" | "fail";

/** What a compromised agent might try: rewrite every decimal limit in the mandate to 100 (as in run-demo.ts). */
const raiseLimits = (ttl: string) => ttl.replace(/odrl:rightOperand (?:"\d+(?:\.\d+)?"\^\^xsd:decimal|\d+\.\d+)/g, 'odrl:rightOperand "100.00"^^xsd:decimal');

export class Guardrails {
  private crashed?: PurchaseResult;
  private runs = 0;

  constructor(private readonly d: DemoContext, private readonly mandate: () => Promise<SpendingMandate>) {}

  action(what: string): (() => Promise<unknown>) | undefined {
    const scenarios: Record<string, () => Promise<{ tone: Tone; lines: string[]; tiles?: unknown[] }>> = {
      tamper: () => this.tamper(), price: () => this.price(), race: () => this.race(),
      crash: () => this.crash(), recover: () => this.recover(), replay: () => this.replay(), unapproved: () => this.unapproved(),
    };
    const run = scenarios[what];
    if (!run) return undefined;
    // "recover" reports on the crash card
    const card = what === "recover" ? "crash" : what;
    return async () => {
      this.d.log.emit("guard", { id: card, state: "running" });
      try {
        const out = await run();
        this.d.log.emit("guard", { id: card, state: "done", ...out, recoverable: card === "crash" && Boolean(this.crashed) });
      } catch (e) {
        this.d.log.emit("guard", { id: card, state: "done", tone: "fail", lines: [(e as Error).message] });
      }
      await this.summary();
    };
  }

  private get env() { return this.d.env; }
  private agent(agentId = AGENT_1) { return this.env.assistant(agentId, { log: this.d.agentLog(id(agentId)) }); }

  /** The "budget used · seller received" line above the cards. */
  private async summary() {
    const m = await this.mandate();
    await actAs(QUIET, async () => {
      const b = await (await fetch(`${this.env.gateway.url}/budget?mandate=${encodeURIComponent(m.id)}`)).json() as Record<string, string>;
      const bal = await (await fetch(`${this.env.rails.facilitator.url}/balance/${this.env.sellers.spree.payTo}`)).json() as { balance: string };
      this.d.log.emit("guard.summary", { committed: fmt(b.committed, b.currency), limit: fmt(b.limit, b.currency), sellerReceived: fmt(bal.balance, "USDC") });
    });
  }

  private async tamper() {
    const m = await this.mandate();
    const env = this.env;
    const doc = m.id.split("#")[0];
    return actAs(id(AGENT_1), async () => {
      const original = (await env.pod.get(doc))!.text;
      await env.pod.putTurtle(doc, raiseLimits(original));
      try {
        const viaAssistant = await this.agent().purchase({ ...BERLIN, mandateId: m.id });
        const offer = env.sellers.spree.currentOffer();
        const p = offer.payload.prices.find((x) => x.scheme === "x402")!;
        const direct = await postJson(`${env.gateway.url}/authorize`, { transactionId: newId("tx-bypass-"), agentId: AGENT_1, mandateId: m.id, offer, option: { scheme: "x402", amount: p.amount, currency: "USDC", payTo: p.payTo, resource: offer.payload.resource, challenge: {} } }, env.agentHeaders(AGENT_1));
        return {
          tone: direct.status === 403 ? "blocked" as const : "fail" as const,
          lines: [`${direct.status} ${direct.body?.code}`, String(direct.body?.reason ?? ""), `assistant itself: ${viaAssistant.status} ${viaAssistant.code ?? ""}`],
        };
      } finally {
        await env.pod.putTurtle(doc, original);   // put the user's signed version back
      }
    });
  }

  private async price() {
    const m = await this.mandate();
    const spree = this.env.sellers.spree;
    const before = spree.currentOffer().payload;
    const original = toMajor(before.prices.find((p) => p.scheme === "x402")!.amount, "USDC");
    const raised = (Number(original) + 0.01).toFixed(2);
    try {
      const r = await actAs(id(AGENT_1), () => this.agent().purchase({ ...BERLIN, mandateId: m.id, hooks: { afterEvaluation: async () => { spree.setPrice({ x402: raised }); } } }));
      const revalidated = r.notes.some((n) => /re-validat/.test(n));
      return {
        tone: r.status === "completed" && revalidated ? "warn" as const : "fail" as const,
        lines: [`offer v${before.version} → v${r.selected?.version}: ${revalidated ? "re-validated" : "not re-validated"}`, r.amount ? `paid ${fmt(r.amount, r.currency!)} against v${r.selected?.version}` : `${r.status} ${r.code ?? ""}`],
      };
    } finally {
      spree.setPrice({ x402: original });
    }
  }

  private async race() {
    await this.mandate();   // the agreed meaning of "current" must exist for the requirement
    const n = ++this.runs;
    const shared = await this.fixtureMandate(`shared-${n}`, { totalLimit: "0.05", maxPerTransaction: "0.05", assignees: [AGENT_1, AGENT_2] });
    this.d.track("race", `Shared 0.05 USDC mandate (race ${n})`, shared);
    const agents = [AGENT_1, AGENT_2].map((a) => ({ agentId: a, assistant: this.agent(a) }));
    const results = await Promise.all(Array.from({ length: 6 }, (_, i) => {
      const { agentId, assistant } = agents[i % 2];
      return actAs(id(agentId), () => assistant.purchase({ ...BERLIN, mandateId: shared.id })).then((r) => ({ agent: id(agentId), status: r.status, code: r.code }));
    }));
    const b = await actAs(QUIET, async () => (await fetch(`${this.env.gateway.url}/budget?mandate=${encodeURIComponent(shared.id)}`)).json() as Promise<Record<string, string>>);
    const settled = results.filter((r) => r.status === "completed").length;
    const codes = new Map<string, number>();
    for (const r of results) if (r.status !== "completed") codes.set(r.code ?? r.status, (codes.get(r.code ?? r.status) ?? 0) + 1);
    return {
      tone: settled === 2 ? "blocked" as const : "fail" as const,
      tiles: results,
      lines: [`${settled} settled · ${[...codes].map(([c, k]) => `${k} ${c}`).join(" · ")} · charged ${fmt(b.settled, b.currency)}`],
    };
  }

  private async crash() {
    const m = await this.mandate();
    const env = this.env;
    const before = env.signer.payments;
    env.sellers.spree.setBehaviour({ failDeliveryTimes: 10 });
    let r: PurchaseResult;
    try { r = await actAs(id(AGENT_1), () => this.agent().purchase({ ...BERLIN, mandateId: m.id })); }
    finally { env.sellers.spree.setBehaviour({ failDeliveryTimes: 0 }); }   // the seller's API comes back up
    this.crashed = r.status === "paid_not_delivered" ? r : undefined;
    const tx = await actAs(QUIET, async () => (await fetch(`${env.gateway.url}/transactions/${encodeURIComponent(r.transactionId!)}`, { headers: env.adminHeaders })).json() as Promise<{ status: string }>);
    return {
      tone: r.status === "paid_not_delivered" ? "warn" as const : "fail" as const,
      lines: [`${r.status}: ${r.delivery?.checks.join("; ") ?? r.reason}`, `gateway ledger: ${tx.status} · signer payments ${before} → ${env.signer.payments}`],
    };
  }

  private async recover() {
    const prev = this.crashed;
    if (!prev) return { tone: "fail" as const, lines: ["Nothing to recover: run the failure first."] };
    const before = this.env.signer.payments;
    const r = await actAs(id(AGENT_1), () => this.agent().recoverDelivery(prev));
    this.crashed = undefined;
    return {
      tone: r.status === "completed" && this.env.signer.payments === before ? "ok" as const : "fail" as const,
      lines: [`paid_not_delivered → ${r.status === "completed" ? "recovered" : r.status}`, `signer payments: ${this.env.signer.payments === before ? `still ${before}` : `${before} → ${this.env.signer.payments}`}`],
    };
  }

  private async replay() {
    const m = await this.mandate();
    const env = this.env;
    const { spree, havel } = env.sellers;
    return actAs(id(AGENT_1), async () => {
      const ch = parse402(await fetch(spree.resourceUrl), spree.resourceUrl);
      const option = ch.options.find((o) => o.scheme === "x402")!;
      const txId = newId("tx-replay-");
      const auth = await postJson(`${env.gateway.url}/authorize`, { transactionId: txId, agentId: AGENT_1, mandateId: m.id, offer: spree.currentOffer(), offerRef: ch.offer, option }, env.agentHeaders(AGENT_1));
      if (auth.status !== 200) return { tone: "fail" as const, lines: [`gateway: ${auth.status} ${auth.body?.code}`] };
      const pay = await postJson(`${env.signer.url}/pay`, { authorization: auth.body.authorization, challenge: option.challenge }, env.agentHeaders(AGENT_1));
      const h = { [pay.body.credential.header.name]: pay.body.credential.header.value };
      const transfersBefore = env.rails.facilitator.chain.transfers.length;
      const other = await fetch(havel.resourceUrl, { headers: h });
      const otherBody = await other.json().catch(() => ({})) as { error?: string; reason?: string };
      const spreeRes: Response[] = [];
      for (let i = 0; i < 3; i++) spreeRes.push(await fetch(spree.resourceUrl, { headers: h }));
      const rh = spreeRes.find((r) => r.status === 200)?.headers.get(RECEIPT_HEADER);
      await postJson(`${env.gateway.url}/transactions/${txId}/outcome`, { agentId: AGENT_1, result: "paid", receipt: rh ? b64json.decode(rh) : undefined }, env.agentHeaders(AGENT_1));
      const transfers = env.rails.facilitator.chain.transfers.length - transfersBefore;
      return {
        tone: other.status === 402 && transfers === 1 ? "blocked" as const : "fail" as const,
        lines: [`Havel: ${other.status}${otherBody.error ? ` (${otherBody.reason ?? otherBody.error})` : ""}`, `Spree: ${spreeRes.map((r) => r.status).join(", ")} · ${transfers} transfer${transfers === 1 ? "" : "s"} on the rail`],
      };
    });
  }

  private async unapproved() {
    const m = await this.mandate();
    const env = this.env;
    const offer = env.sellers.shady.currentOffer();
    const p = offer.payload.prices[0];
    const g = await actAs(id(AGENT_1), () => postJson(`${env.gateway.url}/authorize`, { transactionId: newId("tx-shady-"), agentId: AGENT_1, mandateId: m.id, offer, option: { scheme: "x402", amount: p.amount, currency: "USDC", payTo: p.payTo, resource: offer.payload.resource, challenge: {} } }, env.agentHeaders(AGENT_1)));
    return {
      tone: g.status === 403 ? "blocked" as const : "fail" as const,
      lines: [`${g.status} ${g.body?.code}`, this.named(String(g.body?.reason ?? "")), `Shady Forecasts received ${fmt(env.rails.facilitator.chain.balanceOf(offer.payload.prices[0].payTo!), "USDC")}`],
    };
  }

  /** Gateway reasons name sellers by WebID; show their names instead. */
  private named(reason: string) { return reason.replace(/https?:\/\/\S+?#org/g, (w) => this.d.nameOf(w)); }

  /** A user-confirmed mandate with explicit terms (as test/e2e.test.ts does), approved as a fixture. */
  private fixtureMandate(slug: string, terms: Partial<SpendingMandate>): Promise<SpendingMandate> {
    const env = this.env;
    const m: SpendingMandate = {
      kind: "mandate", id: env.layout.mandate(slug), owner: env.layout.webId, revision: 1, status: "Proposed",
      assignees: [AGENT_1], targets: ["WeatherReport"], currency: "USDC", maxPerTransaction: "1.00", totalLimit: "1.00",
      allowedSellers: env.registry.list().map((s) => s.webId).sort(), allowedSchemes: ["x402"],
      validUntil: new Date(Date.now() + 86_400_000).toISOString(), ...terms,
    };
    return this.d.fixture(`a shared ${terms.totalLimit} ${m.currency} mandate for ${m.assignees.map(id).join(" and ")}`, async () => {
      const out = await actAs(id(AGENT_1), () => this.agent().cg.commit(m, env.device));
      if (!out) throw new Error("fixture mandate was not confirmed");
      return out as SpendingMandate;
    });
  }
}
