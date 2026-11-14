/**
 * Screen 1: "Get me a current Berlin weather report ... up to 1 USDC from
 * approved providers", one presenter click per step. The same calls as
 * src/demo/run-demo.ts, split so the audience can follow each one.
 */
import { AGENT_1 } from "../../demo/environment.js";
import type { GroundRecord, SpendingMandate } from "../../model.js";
import type { ClarificationQuestion, GroundingContext, NegotiationResult } from "../../grounding/commonGround.js";
import type { PurchaseResult, ShoppingAssistant } from "../../agent/assistant.js";
import { evaluateOffers } from "../../agent/ranking.js";
import { readWallet } from "../../pod/wallet.js";
import { fmt } from "../../util/money.js";
import { actAs } from "../wire.js";
import type { ActionResult, DemoContext } from "../live.js";
import { recordLabel, sleep } from "./common.js";

export const WEATHER_STEPS = ["Ask", "Clarify", "Approve", "Compare", "Pay (HTTP 402)", "Deliver & check", "Evidence"];
export const WEATHER_REQUEST = "Get me a current Berlin weather report. I prefer providers that include an hourly forecast. You may spend up to 1 USDC from approved providers.";
const AGENT = AGENT_1.split(":").pop()!;
/** "observed within the last 60 minutes", the answer the talk uses unless the presenter picks another. */
const DEFAULT_CHOICE = 1;

export class WeatherScenario {
  private next = 0;
  private readonly assistant: ShoppingAssistant;
  private ctx?: GroundingContext;
  private negotiation?: NegotiationResult;
  private choice = DEFAULT_CHOICE;
  private proposals: GroundRecord[] = [];
  private mandate?: SpendingMandate;
  private intention = { category: "WeatherReport", subject: "Berlin" as string | undefined, text: WEATHER_REQUEST };
  private result?: PurchaseResult;

  constructor(private readonly d: DemoContext) {
    this.assistant = d.env.assistant(AGENT_1, { log: d.agentLog(AGENT) });
    d.log.emit("steps", { scenario: "weather", steps: WEATHER_STEPS, request: WEATHER_REQUEST });
  }

  action(what: string, args: Record<string, unknown>): (() => Promise<unknown>) | undefined {
    if (what === "next") return () => this.step(typeof args.text === "string" ? args.text : undefined);
    if (what === "autoplay") return () => this.autoplay();
    return undefined;
  }

  /** The presenter picks a meaning for the ambiguous term before pressing Next. */
  choose(index: number): ActionResult {
    const q = this.negotiation?.questions[0];
    if (!q || this.next !== 1 || !Number.isInteger(index) || index < 0 || index >= q.options.length) return { ok: false, status: 409, error: "no open clarification with that option" };
    this.choice = index;
    this.d.log.emit("weather.choice", { index });
    return { ok: true };
  }

  /** The guardrail scenarios need the main mandate; if the presenter starts there, set it up as a fixture. */
  async groundedMandate(): Promise<SpendingMandate> {
    if (this.mandate) return this.mandate;
    return this.d.fixture("weather common ground and the 1 USDC mandate, as in steps 1 to 3", () => actAs(AGENT, async () => {
      const { ctx, result } = await this.assistant.understand(WEATHER_REQUEST, this.d.approved("sellers"));
      const proposals = [...result.proposals, ...result.questions.flatMap((q) => this.assistant.answer(q, DEFAULT_CHOICE, ctx))];
      const { confirmed } = await this.assistant.confirm(proposals, this.d.env.device);
      return this.setMandate(confirmed.find((r): r is SpendingMandate => r.kind === "mandate")!);
    }));
  }

  private setMandate(m: SpendingMandate) {
    this.mandate = m;
    this.d.track("weather", "Weather report mandate", m);
    return m;
  }

  private async autoplay() {
    while (this.next < WEATHER_STEPS.length) {
      if (!(await this.step())) return;
      if (this.next < WEATHER_STEPS.length) await sleep(this.d.stepPauseMs);
    }
  }

  /** Run the next step. Returns false when the scenario cannot continue. */
  private async step(text?: string): Promise<boolean> {
    const i = this.next;
    if (i >= WEATHER_STEPS.length) { this.say("assistant", "This scenario is complete. Reset to run it again."); return false; }
    this.d.log.emit("step", { scenario: "weather", index: i, state: "active" });
    let outcome: "done" | "failed" = "failed";
    try {
      outcome = (await actAs(AGENT, () => this.run(i, text))) ? "done" : "failed";
    } finally {
      this.d.log.emit("step", { scenario: "weather", index: i, state: outcome });
      if (outcome === "done") this.next = Math.max(this.next, i + 1);
      await this.d.refresh();
    }
    return outcome === "done";
  }

  private say(role: "user" | "assistant", text: string) { this.d.log.emit("chat", { scenario: "weather", role, text }); }

  private async run(i: number, text?: string): Promise<boolean> {
    switch (i) {
      case 0: return this.ask(text?.trim() || WEATHER_REQUEST);
      case 1: return this.clarify();
      case 2: return this.approve();
      case 3: return this.compare();
      case 4: return this.pay();
      case 5: return this.deliver();
      default: return this.evidence();
    }
  }

  private async ask(text: string) {
    this.say("user", text);
    const { ctx, result } = await this.assistant.understand(text, this.d.approved("sellers"));
    Object.assign(this, { ctx, negotiation: result, choice: DEFAULT_CHOICE });
    if (result.intention) this.intention = { category: result.intention.category, subject: result.intention.subject, text };
    for (const n of result.notes) this.d.log.emit("agent.log", { agent: AGENT, line: n });
    if (result.reused.length) this.say("assistant", `From your Pod I already know: ${result.reused.map(recordLabel).join("; ")}. I will not ask again.`);
    const q = result.questions[0];
    if (q) {
      this.d.log.emit("question", { scenario: "weather", term: q.term, prompt: q.prompt, options: q.options.map((o) => o.label), selected: DEFAULT_CHOICE });
      this.say("assistant", q.prompt);
      return true;
    }
    // Nothing ambiguous left: the agreed meaning came from the Pod, so there is nothing to clarify.
    this.proposals = [...result.proposals];
    this.d.log.emit("step", { scenario: "weather", index: 1, state: "skipped" });
    this.next = 2;
    return true;
  }

  private async clarify() {
    const r = this.negotiation;
    if (!r || !this.ctx) return false;
    if (!r.questions.length) return true;   // skipped after a reuse
    const answers = r.questions.flatMap((q: ClarificationQuestion, n) => {
      const choice = n === 0 ? this.choice : DEFAULT_CHOICE;
      this.d.log.emit("answer", { scenario: "weather", term: q.term, index: choice, label: q.options[choice].label });
      this.say("user", q.options[choice].label);
      return this.assistant.answer(q, choice, this.ctx!);
    });
    this.proposals = [...r.proposals, ...answers];
    return true;
  }

  private async approve() {
    const proposals = this.proposals;
    if (!proposals.length) {
      const existing = this.ctx?.mandates.find((m) => m.targets.includes(this.intention.category));
      if (!existing) { this.say("assistant", "There is nothing to approve and no spending mandate in your Pod, so I cannot buy anything."); return false; }
      this.say("assistant", "Nothing new to approve: your Pod already holds a confirmed mandate for this.");
      this.setMandate(existing);
      return true;
    }
    this.say("assistant", `I've sent ${proposals.length} item${proposals.length > 1 ? "s" : ""} to your phone. The spending permission is separate from your preferences.`);
    this.d.broker.expect(proposals.length);
    const { confirmed, rejected } = await this.assistant.confirm(proposals, this.d.env.device);
    this.d.log.emit("confirmed", {
      scenario: "weather",
      items: [...confirmed.map((r) => ({ label: recordLabel(r), kind: r.kind, approved: true })), ...rejected.map((r) => ({ label: recordLabel(r), kind: r.kind, approved: false }))],
    });
    const m = confirmed.find((r): r is SpendingMandate => r.kind === "mandate");
    if (!m) { this.say("assistant", "No spending mandate was approved, so I cannot pay anyone. Reset to try again."); return false; }
    this.setMandate(m);
    return true;
  }

  /**
   * Show the comparison before paying. purchase() ranks again itself, with the
   * same function on freshly fetched offers; this preview reads the same
   * confirmed common ground but writes nothing to the Pod.
   */
  private async compare() {
    const m = this.mandate;
    if (!m) return false;
    const env = this.d.env;
    const ctx = await this.assistant.cg.load();
    const applicable = ctx.preferences.filter((p) => p.appliesTo === this.intention.category);
    const with_ = (kind: string) => applicable.filter((p) => p.kind === kind).map((record) => ({ record, criterion: this.assistant.cg.effectiveCriterion(ctx, record) }));
    const wallet = await readWallet(env.pod, env.layout.wallet);
    const ranked = evaluateOffers(await this.assistant.fetchOffers(), { category: this.intention.category, subject: this.intention.subject, mandate: m, walletSchemes: wallet.schemes, requirements: with_("requirement"), preferences: with_("preference") });
    this.d.log.emit("offers", {
      scenario: "weather",
      items: ranked.map((r, n) => ({
        ...r.evaluation, chosen: n === 0 && r.evaluation.acceptable, approved: env.registry.isApproved(r.signed.payload.seller),
        properties: r.signed.payload.properties, coverage: r.signed.payload.coverage,
      })),
    });
    const best = ranked[0];
    this.say("assistant", best?.evaluation.acceptable
      ? `${best.evaluation.sellerName} fits what we agreed (${fmt(best.evaluation.price!, best.evaluation.currency!)}). ${ranked.filter((r) => !r.evaluation.acceptable).map((r) => r.evaluation.sellerName).join(" and ")} do not.`
      : "No offer satisfies your confirmed requirements and mandate.");
    return true;
  }

  private async pay() {
    if (!this.mandate) return false;
    const r = await this.assistant.purchase({ ...this.intention, mandateId: this.mandate.id });
    this.result = r;
    this.d.log.emit("purchase", {
      scenario: "weather", status: r.status, code: r.code, reason: r.reason, transactionId: r.transactionId, seller: r.selected?.sellerName, offerVersion: r.selected?.version,
      scheme: r.scheme, amount: r.amount, currency: r.currency, display: r.amount ? fmt(r.amount, r.currency!) : undefined, notes: r.notes, evidence: r.evidence,
    });
    this.say("assistant", r.status === "completed" || r.status === "completed_noncompliant"
      ? `Paid ${fmt(r.amount!, r.currency!)} to ${r.selected?.sellerName} via ${r.scheme}, authorized by the gateway against your mandate.`
      : `Purchase ${r.status}${r.code ? ` (${r.code})` : ""}${r.reason ? `: ${r.reason}` : ""}.`);
    return Boolean(r.transactionId);
  }

  private async deliver() {
    const r = this.result;
    if (!r) return false;
    const receipt = r.receipt?.payload;
    this.d.log.emit("delivery", {
      scenario: "weather", status: r.delivery?.status ?? "NotDelivered", checks: r.delivery?.checks ?? [], content: r.content,
      receipt: receipt && { id: receipt.receiptId, keyId: r.receipt!.sig.keyId, deliveredAt: receipt.deliveredAt, amount: fmt(receipt.amount, receipt.currency), contentDigest: receipt.contentDigest },
    });
    this.say("assistant", r.delivery?.status === "Delivered"
      ? `Delivered and checked against what "current" means for you: ${r.delivery.checks.join("; ")}.`
      : `Delivery: ${r.delivery?.status ?? "none"}. ${(r.delivery?.checks ?? []).join("; ")}`);
    return true;
  }

  private async evidence() {
    const r = this.result;
    if (!r?.evidence) return false;
    const ledger = r.evidence.replace(/\.ttl$/, "-ledger.ttl");
    await this.d.showDoc(ledger, "gateway ledger evidence");
    await this.d.showDoc(r.evidence, "assistant evidence");
    const root = this.d.env.podRoot;
    this.d.log.emit("evidence", { scenario: "weather", links: [{ label: "Purchase evidence", url: r.evidence, path: r.evidence.slice(root.length) }, { label: "Ledger entry", url: ledger, path: ledger.slice(root.length) }] });
    this.say("assistant", "Everything above is in your Pod: the intention, the offers considered, the mandate used, the gateway's authorization, the seller's receipt and the delivery check.");
    return true;
  }
}
