/**
 * Buyer assistant. It reads permitted common ground from the Pod, proposes
 * refinements, compares offers, and drives the HTTP 402 flow:
 *   402 -> gateway authorization -> protected signer -> retry with credential.
 * It holds no keys and has no spending authority of its own.
 *
 * Shops without HTTP 402 (ACP-style checkout for physical goods) go through
 * purchaseViaCheckout (./checkoutPurchase.ts): same grounding, ranking,
 * gateway, signer and evidence, with a checkout session instead of a 402.
 */
import { SCHEME_CURRENCY, type Criterion, type Offer, type PreferenceRecord, type PurchaseIntention, type SpendingMandate } from "../model.js";
import { PodClient } from "../pod/PodClient.js";
import { PodLayout } from "../pod/layout.js";
import { readWallet } from "../pod/wallet.js";
import { CommonGround, type ClarificationQuestion, type GroundingContext, type NegotiationResult } from "../grounding/commonGround.js";
import type { Interpreter } from "../grounding/interpretation.js";
import type { ApprovalDevice } from "../grounding/approval.js";
import N3 from "n3";
import { intentionToTurtle, parseTurtle } from "../rdf/records.js";
import { sc } from "../rdf/namespaces.js";
import { assistantEvidenceToTurtle, type AssistantEvidence } from "../rdf/evidence.js";
import { parse402 } from "../payments/http402.js";
import { RECEIPT_HEADER, type PaymentCredential, type PaymentOption, type Receipt } from "../payments/types.js";
import { evaluateOffers, type Evaluated } from "./ranking.js";
import { checkDelivery } from "./delivery.js";
import { b64json, postJson } from "../util/http.js";
import { newId, type Signed } from "../util/crypto.js";
import { fmt } from "../util/money.js";
import type { WalletDescriptor } from "../pod/wallet.js";
import { CheckoutPurchaser, type CheckoutPurchaseRequest, type OrderTracking } from "./checkoutPurchase.js";

/** Everything a purchase path needs once grounding and the mandate are loaded. */
export interface PreparedPurchase {
  notes: string[];
  mandate: SpendingMandate;
  wallet: WalletDescriptor;
  intention: PurchaseIntention;
  requirements: Array<{ record: PreferenceRecord; criterion: Criterion }>;
  preferences: Array<{ record: PreferenceRecord; criterion: Criterion }>;
  groundedBy: string[];
}

export interface AssistantConfig {
  agentId: string;
  pod: PodClient;
  layout: PodLayout;
  interpreter: Interpreter;
  enrolledApprovalKeys: JsonWebKey[];
  gatewayUrl: string;
  catalog: string[];                 // offer URLs of known sellers
  checkoutMerchants?: string[];      // API base URLs of known ACP-style checkout merchants
  log?: (line: string) => void;
  deliveryRetries?: number;
}

/** "fulfilment_pending": paid for physical goods, which arrive later (track with trackOrder). */
export type PurchaseStatus = "completed" | "completed_noncompliant" | "paid_not_delivered" | "payment_failed" | "blocked" | "no_acceptable_offer" | "fulfilment_pending";

export interface PurchaseResult {
  status: PurchaseStatus;
  transactionId?: string;
  code?: string;
  reason?: string;
  evaluations: Evaluated["evaluation"][];
  selected?: Offer;
  amount?: string;
  currency?: string;
  scheme?: string;
  content?: unknown;
  receipt?: Signed<Receipt>;
  delivery?: { status: string; checks: string[] };
  evidence?: string;
  tracking?: OrderTracking;          // physical orders only
  notes: string[];
}

export class ShoppingAssistant {
  readonly cg: CommonGround;
  private readonly log: (l: string) => void;
  constructor(private readonly cfg: AssistantConfig) {
    this.cg = new CommonGround(cfg.pod, cfg.layout, cfg.enrolledApprovalKeys, cfg.agentId);
    this.log = cfg.log ?? (() => {});
  }

  // ------------------------------------------------------------ grounding

  /** Interpret a request against current common ground. Returns questions and proposals; writes nothing. */
  async understand(text: string, approvedSellers: string[]): Promise<{ ctx: GroundingContext; result: NegotiationResult }> {
    const ctx = await this.cg.load();
    const interp = await this.cfg.interpreter.interpret(text);
    const wallet = await readWallet(this.cfg.pod, this.cfg.layout.wallet);
    const schemesFor = (cur: string) => wallet.schemes.filter((s) => SCHEME_CURRENCY[s] === cur);
    const result = this.cg.negotiate(interp, ctx, this.cfg.layout.webId, { approvedSellers, agentIds: [this.cfg.agentId], schemesFor });
    return { ctx, result };
  }

  answer(q: ClarificationQuestion, choice: Parameters<CommonGround["answer"]>[1], ctx: GroundingContext) {
    return this.cg.answer(q, choice, this.cfg.layout.webId, ctx);
  }

  /** Send each proposal to the user's approval device; write the confirmed ones. */
  async confirm<T extends Parameters<CommonGround["commit"]>[0]>(proposals: T[], device: ApprovalDevice) {
    const confirmed: T[] = [], rejected: T[] = [];
    for (const p of proposals) ((await this.cg.commit(p, device)) ? confirmed : rejected).push(p);
    return { confirmed, rejected };
  }

  // ------------------------------------------------------------ purchasing

  /**
   * Shared start of every purchase: confirmed common ground, the mandate, the
   * wallet, and the intention written to the Pod. Unconfirmed or tampered
   * records are ignored and noted.
   */
  async prepare(req: { text: string; category: string; subject?: string; mandateId: string }): Promise<PreparedPurchase | PurchaseResult> {
    const notes: string[] = [];
    const ctx = await this.cg.load();
    for (const ig of ctx.ignored) notes.push(`Ignored unconfirmed or tampered record ${ig.id}: ${ig.reason}`);
    const mandate = ctx.mandates.find((m) => m.id === req.mandateId);
    if (!mandate) return { status: "blocked", code: "NO_CONFIRMED_MANDATE", reason: `no user-confirmed mandate ${req.mandateId}`, evaluations: [], notes };
    const wallet = await readWallet(this.cfg.pod, this.cfg.layout.wallet);

    const intention: PurchaseIntention = { id: `${this.cfg.layout.intentions}${newId()}.ttl#it`, owner: this.cfg.layout.webId, category: req.category, subject: req.subject, text: req.text, mandate: mandate.id, createdAt: new Date().toISOString() };
    await this.cfg.pod.putTurtle(intention.id.split("#")[0], await intentionToTurtle(intention));

    const applicable = ctx.preferences.filter((p) => p.appliesTo === req.category);
    const requirements = applicable.filter((p) => p.kind === "requirement").map((record) => ({ record, criterion: this.cg.effectiveCriterion(ctx, record) }));
    const preferences = applicable.filter((p) => p.kind === "preference").map((record) => ({ record, criterion: this.cg.effectiveCriterion(ctx, record) }));
    const groundedBy = [...new Set([...applicable.map((p) => p.id), ...applicable.flatMap((p) => (p.groundedIn ? [p.groundedIn] : []))])];
    this.log(`Applying ${requirements.length} requirement(s) and ${preferences.length} preference(s) from the Pod`);
    return { notes, mandate, wallet, intention, requirements, preferences, groundedBy };
  }

  async purchase(req: { text: string; category: string; subject?: string; mandateId: string; hooks?: { afterEvaluation?: () => Promise<void> } }): Promise<PurchaseResult> {
    const prep = await this.prepare(req);
    if ("status" in prep) return prep;
    const { notes, mandate, wallet, intention, requirements, preferences, groundedBy } = prep;

    const rank = async () => evaluateOffers(await this.fetchOffers(), { category: req.category, subject: req.subject, mandate, walletSchemes: wallet.schemes, requirements, preferences });
    let ranked = await rank();
    const evidence: AssistantEvidence = {
      docUrl: "", transactionId: "", intention: intention.id, agentId: this.cfg.agentId, mandate: mandate.id, groundedBy,
      evaluations: ranked.map((r) => r.evaluation), status: "evaluating", startedAt: new Date().toISOString(),
    };
    const base = { evaluations: evidence.evaluations, notes };
    await req.hooks?.afterEvaluation?.();

    for (let attempt = 0; attempt < 3; attempt++) {
      const best = ranked[0];
      if (!best || !best.evaluation.acceptable) return this.finish(evidence, { ...base, status: "no_acceptable_offer", reason: "no offer satisfies the confirmed requirements and mandate" });
      const offer = best.signed.payload;
      const txId = newId("tx-");
      Object.assign(evidence, { transactionId: txId, docUrl: `${this.cfg.layout.transactions}${txId}.ttl`, selectedOffer: offer.offerId });
      this.log(`Selected ${offer.sellerName} (offer v${offer.version}, score ${best.evaluation.score}); requesting ${offer.resource}`);

      // 1. Hit the resource; expect HTTP 402
      const first = await fetch(offer.resource);
      if (first.status !== 402) return this.finish(evidence, { ...base, status: "blocked", code: "UNEXPECTED_STATUS", reason: `expected 402, got ${first.status}` });
      const challenge = parse402(first, offer.resource);
      this.log(`HTTP 402 offers: ${challenge.options.map((o) => `${o.scheme} ${fmt(o.amount, o.currency)}`).join(", ")}`);

      // 2. Changed offer? Re-fetch and re-evaluate before any authorization
      if (challenge.offer && (challenge.offer.version !== offer.version || challenge.offer.offerId !== offer.offerId)) {
        notes.push(`Offer ${offer.offerId} changed (v${offer.version} -> v${challenge.offer.version}); re-validated before paying`);
        this.log(`Offer changed since evaluation, re-validating`);
        ranked = await rank(); evidence.evaluations = ranked.map((r) => r.evaluation); base.evaluations = evidence.evaluations;
        continue;
      }

      // 3. Pick a payment option the mandate and wallet both allow
      const option = challenge.options.find((o) => mandate.allowedSchemes.includes(o.scheme) && wallet.schemes.includes(o.scheme) && o.currency === mandate.currency);
      if (!option) return this.finish(evidence, { ...base, status: "blocked", code: "NO_PAYABLE_OPTION", reason: "402 offers no scheme the mandate and wallet allow" });

      // 4. Gateway authorization (budget reservation)
      const auth = await postJson(`${this.cfg.gatewayUrl}/authorize`, { transactionId: txId, agentId: this.cfg.agentId, mandateId: mandate.id, offer: best.signed, offerRef: challenge.offer, option });
      if (auth.status === 409 && /OFFER_(CHANGED|MISMATCH)/.test(auth.body?.code)) {
        notes.push(`Gateway: ${auth.body.code}: ${auth.body.reason}; re-validating`);
        ranked = await rank(); evidence.evaluations = ranked.map((r) => r.evaluation); base.evaluations = evidence.evaluations;
        continue;
      }
      if (auth.status !== 200) {
        this.log(`Gateway refused: ${auth.body?.code} ${auth.body?.reason}`);
        return this.finish(evidence, { ...base, status: "blocked", transactionId: txId, code: auth.body?.code, reason: auth.body?.reason });
      }
      const authorization = auth.body.authorization;
      this.log(`Gateway authorized ${fmt(option.amount, option.currency)} (budget available after reservation: ${fmt(auth.body.budget.available, auth.body.budget.currency)})`);
      Object.assign(evidence, { scheme: option.scheme, amount: option.amount, currency: option.currency, ledgerDoc: `${this.cfg.layout.transactions}${txId}-ledger.ttl`, challenge: option.challenge });

      // 5. Protected signer creates the payment credential
      const pay = await postJson(`${wallet.signerEndpoint}/pay`, { authorization, challenge: option.challenge });
      if (pay.status !== 200) {
        await postJson(`${this.cfg.gatewayUrl}/transactions/${txId}/outcome`, { agentId: this.cfg.agentId, result: "payment_failed", detail: pay.body?.reason });
        return this.finish(evidence, { ...base, status: "payment_failed", transactionId: txId, code: pay.body?.error, reason: pay.body?.reason });
      }
      const credential: PaymentCredential = pay.body.credential;
      this.log(`Signer produced ${credential.scheme} credential (${credential.header.name})`);

      // 6. Retry with the credential; delivery errors are retried with the SAME credential (never a new payment)
      return this.deliverAndRecord(txId, offer, option, credential, requirements.map((r) => r.criterion), req.subject, evidence, base, authorization);
    }
    return this.finish(evidence, { ...base, status: "blocked", code: "OFFER_UNSTABLE", reason: "offer kept changing during purchase" });
  }

  private async deliverAndRecord(txId: string, offer: Offer, option: PaymentOption, credential: PaymentCredential, requirements: any[], subject: string | undefined, evidence: AssistantEvidence, base: { evaluations: any[]; notes: string[] }, _authorization: unknown): Promise<PurchaseResult> {
    const retries = this.cfg.deliveryRetries ?? 2;
    let res: Response | undefined;
    for (let i = 0; i <= retries; i++) {
      try { res = await fetch(offer.resource, { headers: { [credential.header.name]: credential.header.value } }); }
      catch { res = undefined; }
      if (res?.status === 200) break;
      this.log(`Delivery attempt ${i + 1} failed (${res?.status ?? "network error"}); retrying with the same credential`);
      await new Promise((r) => setTimeout(r, 50 * (i + 1)));
    }
    const common = { ...base, transactionId: txId, selected: offer, amount: option.amount, currency: option.currency, scheme: option.scheme };
    if (!res || res.status !== 200) {
      const out = await postJson(`${this.cfg.gatewayUrl}/transactions/${txId}/outcome`, { agentId: this.cfg.agentId, result: "unknown", detail: `delivery failed: ${res?.status ?? "network"}` });
      const paid = out.body?.status === "settled";
      const delivery = { status: "NotDelivered" as const, checks: [paid ? "payment settled on the rail; content not delivered (recoverable: re-present the same credential)" : "payment not confirmed; reservation held until reconciled"] };
      evidence.delivery = delivery;
      return this.finish(evidence, { ...common, status: paid ? "paid_not_delivered" : "payment_failed", code: paid ? "DELIVERY_FAILED" : "PAYMENT_UNCERTAIN", delivery });
    }
    const body = await res.text();
    const rh = res.headers.get(RECEIPT_HEADER);
    const receipt: Signed<Receipt> | undefined = rh ? b64json.decode(rh) : undefined;
    const check = checkDelivery(body, receipt?.payload, requirements, subject);
    this.log(`Delivered; checks: ${check.checks.join("; ")}`);
    const out = await postJson(`${this.cfg.gatewayUrl}/transactions/${txId}/outcome`, { agentId: this.cfg.agentId, result: "paid", receipt });
    if (out.status !== 200) base.notes.push(`Gateway did not accept receipt: ${out.body?.reason}`);
    evidence.receipt = receipt;
    evidence.delivery = check;
    return this.finish(evidence, { ...common, status: check.status === "Delivered" ? "completed" : "completed_noncompliant", content: JSON.parse(body), receipt, delivery: check });
  }

  /** Recover a paid-but-undelivered purchase: ask the signer for the SAME credential (idempotent) and re-fetch. */
  async recoverDelivery(prev: PurchaseResult, requirements: any[] = []): Promise<PurchaseResult> {
    if (!prev.transactionId || !prev.selected) throw new Error("nothing to recover");
    const tx = await (await fetch(`${this.cfg.gatewayUrl}/transactions/${prev.transactionId}`)).json() as { auth_json: string };
    const evDoc = `${this.cfg.layout.transactions}${prev.transactionId}.ttl`;
    const evRes = await this.cfg.pod.get(evDoc);
    if (!evRes) throw new Error(`no evidence for ${prev.transactionId}`);
    const store = parseTurtle(evRes.text, evDoc);
    const challengeLit = store.getObjects(N3.DataFactory.namedNode(evDoc + "#tx"), N3.DataFactory.namedNode(sc("challenge")), null)[0];
    if (!challengeLit) throw new Error("evidence has no payment challenge");
    const challenge = JSON.parse(challengeLit.value);
    const wallet = await readWallet(this.cfg.pod, this.cfg.layout.wallet);
    const pay = await postJson(`${wallet.signerEndpoint}/pay`, { authorization: JSON.parse(tx.auth_json), challenge });
    if (pay.status !== 200) throw new Error(`signer: ${pay.body?.error} ${pay.body?.reason}`);
    if (!pay.body.replayed) throw new Error("signer made a NEW payment during recovery");
    const option = { scheme: prev.scheme, amount: prev.amount, currency: prev.currency, challenge } as PaymentOption;
    const evidence: AssistantEvidence = {
      docUrl: `${this.cfg.layout.transactions}${prev.transactionId}-recovery-${Date.now()}.ttl`, recovers: evDoc, transactionId: prev.transactionId, agentId: this.cfg.agentId,
      mandate: (JSON.parse(tx.auth_json).payload as { mandateId: string }).mandateId, groundedBy: [], evaluations: prev.evaluations,
      selectedOffer: prev.selected.offerId, status: "recovering", startedAt: new Date().toISOString(), scheme: prev.scheme, amount: prev.amount, currency: prev.currency,
    };
    return this.deliverAndRecord(prev.transactionId, prev.selected, option, pay.body.credential, requirements, prev.selected.coverage, evidence, { evaluations: prev.evaluations, notes: ["recovered delivery with the original payment credential"] }, undefined);
  }

  async fetchOffers(): Promise<Signed<Offer>[]> {
    const out: Signed<Offer>[] = [];
    for (const url of this.cfg.catalog) {
      try { const r = await fetch(url, { headers: { accept: "application/json" } }); if (r.ok) out.push(await r.json() as Signed<Offer>); } catch { /* seller offline */ }
    }
    return out;
  }

  // ------------------------------------------------------------ checkout merchants (physical goods)

  /** Buy from ACP-style checkout merchants. See ./checkoutPurchase.ts. */
  purchaseViaCheckout(req: CheckoutPurchaseRequest): Promise<PurchaseResult> { return this.checkout.purchase(req); }
  /** Refresh order and payment state from the merchant and the gateway; updates the fulfilment evidence. */
  trackOrder(t: OrderTracking): Promise<OrderTracking> { return this.checkout.track(t); }
  /** Record the user's verdict on delivered goods, signed on the approval device. */
  acceptDelivery(t: OrderTracking, observed: Record<string, string>, device: ApprovalDevice): Promise<OrderTracking> { return this.checkout.accept(t, observed, device); }
  /** Cancel before shipment. Budget returns only once the gateway sees the refund at the PSP. */
  cancelOrder(t: OrderTracking): Promise<OrderTracking> { return this.checkout.cancel(t); }

  private get checkout() { return new CheckoutPurchaser(this.cfg, this, this.log); }

  private async finish(evidence: AssistantEvidence, result: PurchaseResult): Promise<PurchaseResult> {
    if (!evidence.transactionId) { evidence.transactionId = newId("tx-"); evidence.docUrl = `${this.cfg.layout.transactions}${evidence.transactionId}.ttl`; result.transactionId ??= evidence.transactionId; }
    evidence.status = result.status;
    evidence.endedAt = new Date().toISOString();
    await this.cfg.pod.putTurtle(evidence.docUrl, await assistantEvidenceToTurtle(evidence));
    return { ...result, evidence: evidence.docUrl };
  }
}

export type { SpendingMandate };
