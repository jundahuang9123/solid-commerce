/**
 * Purchase path for shops that sell physical goods through an ACP-style
 * checkout API instead of answering HTTP 402.
 *
 *   feed -> ranking (same requirements, preferences, missing-means-no policy)
 *   -> checkout session (items, then the Pod address to the chosen shop only, then shipping)
 *   -> PaymentOption {total incl. delivery and tax}
 *   -> gateway (re-reads the session itself) -> signer (mints a delegated token)
 *   -> complete with Idempotency-Key = authId -> order
 *   -> tracking created -> shipped -> delivered -> the user's signed verdict.
 *
 * Payment status (gateway ledger) and fulfilment status (merchant order, user
 * acceptance) are tracked separately, so "paid, not shipped" or "canceled and
 * refunded" are never confused with "payment failed".
 */
import type { Criterion } from "../model.js";
import type { ApprovalDevice } from "../grounding/approval.js";
import { assistantEvidenceToTurtle, fulfilmentEvidenceToTurtle, type AssistantEvidence, type DeliveryStatus, type OrderState } from "../rdf/evidence.js";
import { readAddress, toAcpAddress } from "../pod/address.js";
import { CheckoutAdapter, type CheckoutCandidate } from "../checkout/adapter.js";
import { totalOf, type AcpCheckoutSession, type DelegatedCredential } from "../checkout/acp.js";
import { evaluateOffers, compare, type Evaluated } from "./ranking.js";
import type { AssistantConfig, PurchaseResult, ShoppingAssistant } from "./assistant.js";
import { postJson } from "../util/http.js";
import { bearerHeaders } from "../trust/agentAuth.js";
import { newId } from "../util/crypto.js";
import { fmt, toAtomic } from "../util/money.js";

export interface CheckoutPurchaseRequest {
  text: string;
  category: string;
  mandateId: string;
  quantity?: number;
  /** Test hook: runs after the checkout total was quoted and before the gateway is asked. */
  hooks?: { afterQuote?: (session: AcpCheckoutSession) => Promise<void> };
}

/** Everything needed to follow a physical order after payment, in this or a later session. */
export interface OrderTracking {
  transactionId: string;
  evidence: string;                       // assistant evidence document of the purchase
  fulfilment: string;                     // fulfilment evidence document (rewritten on each update)
  orderId: string;
  orderUrl: string;
  merchant: string;
  merchantName: string;
  items: Array<{ id: string; quantity: number }>;
  total: string;
  currency: string;
  address: string;                        // IRI of the schema:PostalAddress used
  requirements: Criterion[];              // what the goods must satisfy on arrival
  orderStatus: OrderState;
  paymentStatus: string;                  // gateway ledger status
  events: Array<{ status: OrderState; at: string; detail?: string }>;
  delivery: { status: DeliveryStatus; checks: string[] };
  acceptance?: { verdict: "Delivered" | "NonCompliant"; checks: string[]; by: string; at: string; keyId: string; termsDigest: string; signature: string };
}

const MAX_ATTEMPTS = 4;

export class CheckoutPurchaser {
  private readonly adapter: CheckoutAdapter;
  constructor(private readonly cfg: AssistantConfig, private readonly assistant: ShoppingAssistant, private readonly log: (l: string) => void) {
    this.adapter = new CheckoutAdapter(cfg.checkoutMerchants ?? []);
  }

  async purchase(req: CheckoutPurchaseRequest): Promise<PurchaseResult> {
    const prep = await this.assistant.prepare(req);
    if ("status" in prep) return prep;
    const { notes, mandate, wallet, intention, requirements, preferences, groundedBy } = prep;
    const quantity = req.quantity ?? 1;
    const addressId = this.cfg.layout.address();
    const address = await readAddress(this.cfg.pod, addressId);
    if (!address) return { status: "blocked", code: "NO_SHIPPING_ADDRESS", reason: `no schema:PostalAddress at ${addressId}`, evaluations: [], notes };
    const perTx = BigInt(toAtomic(mandate.maxPerTransaction, mandate.currency));

    // Rank on feed data only. The price compared is the estimated delivered total.
    const rank = async () => {
      const ranked = evaluateOffers(await this.adapter.discover(req.category, address.country), { category: req.category, mandate, walletSchemes: wallet.schemes, requirements, preferences });
      for (const r of ranked) {
        const c = r.signed;
        r.evaluation.reasons.push(c.shippingEstimate === undefined ? `✗ does not ship to ${address.country}` : `·  estimated ${fmt(String(c.product.price.amount + c.shippingEstimate), mandate.currency)} incl. delivery to ${address.country} (item ${fmt(String(c.product.price.amount), mandate.currency)})`);
      }
      return ranked;
    };
    let ranked = await rank();
    const evidence: AssistantEvidence = {
      docUrl: "", transactionId: "", intention: intention.id, agentId: this.cfg.agentId, mandate: mandate.id, groundedBy,
      evaluations: ranked.map((r) => r.evaluation), status: "evaluating", startedAt: new Date().toISOString(),
    };
    const base = { evaluations: evidence.evaluations, notes };
    const excluded = new Set<string>();
    const refuse = (r: Evaluated<CheckoutCandidate>, why: string) => {
      excluded.add(r.evaluation.offerId);
      r.evaluation.acceptable = false;
      r.evaluation.reasons.push("✗ " + why);
    };
    let current: { pick: Evaluated<CheckoutCandidate>; session: AcpCheckoutSession } | undefined;

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      if (!current) {
        const pick = ranked.find((r) => r.evaluation.acceptable && !excluded.has(r.evaluation.offerId));
        if (!pick) return this.finish(evidence, { ...base, status: "no_acceptable_offer", reason: "no product satisfies the confirmed requirements and mandate" });
        const c = pick.signed;
        this.log(`Selected ${c.merchant.name}: ${c.product.title} (score ${pick.evaluation.score}); opening a checkout session`);
        const opened = await this.adapter.open(c, quantity, newId("open-"));
        // Only now, and only to this merchant, does the address leave the Pod.
        const session = opened && (await this.adapter.shipTo(c.apiBase, opened, toAcpAddress(address)));
        if (!session || session.status !== "ready_for_payment") {
          if (opened) await this.adapter.cancel(c.apiBase, opened.id);
          refuse(pick, `checkout could not be made ready for payment${session?.messages.length ? ": " + session.messages.map((m) => m.content).join("; ") : ""}`);
          continue;
        }
        current = { pick, session };
      }
      const { pick, session } = current;
      const c = pick.signed;
      const total = BigInt(totalOf(session, "total") ?? 0);
      this.log(`Checkout total ${fmt(total, mandate.currency)} (items ${fmt(String(totalOf(session, "subtotal")), mandate.currency)}, delivery ${fmt(String(totalOf(session, "fulfillment") ?? 0), mandate.currency)}, tax ${fmt(String(totalOf(session, "tax") ?? 0), mandate.currency)})`);
      if (total > perTx) {
        await this.adapter.cancel(c.apiBase, session.id);
        refuse(pick, `checkout total ${fmt(total, mandate.currency)} incl. delivery and tax is above the per-purchase limit`);
        notes.push(`${c.merchant.name}: total incl. delivery ${fmt(total, mandate.currency)} exceeds ${mandate.maxPerTransaction} ${mandate.currency}; session canceled`);
        current = undefined;
        continue;
      }
      await req.hooks?.afterQuote?.(session);

      const option = this.adapter.paymentOption(c, session);
      const txId = newId("tx-");
      Object.assign(evidence, { transactionId: txId, docUrl: `${this.cfg.layout.transactions}${txId}.ttl`, selectedOffer: c.payload.offerId, checkoutSession: option.resource });
      const lineItems = session.line_items.map((li) => li.item);
      const auth = await postJson(`${this.cfg.gatewayUrl}/authorize`, { transactionId: txId, agentId: this.cfg.agentId, mandateId: mandate.id, checkout: { merchant: c.merchant.webId, sessionId: session.id, lineItems }, option }, bearerHeaders(this.cfg.agentSecret));
      if (auth.status === 409 && auth.body?.code === "CHECKOUT_CHANGED") {
        notes.push(`Gateway: ${auth.body.code}: ${auth.body.reason}; re-validated before paying`);
        this.log("Checkout changed since the quote, re-validating");
        const fresh = await this.adapter.read(c.apiBase, session.id);
        current = fresh?.status === "ready_for_payment" ? { pick, session: fresh } : undefined;
        if (!current) refuse(pick, "checkout session changed and is no longer ready for payment");
        continue;
      }
      if (auth.status !== 200) {
        this.log(`Gateway refused: ${auth.body?.code} ${auth.body?.reason}`);
        await this.adapter.cancel(c.apiBase, session.id);
        return this.finish(evidence, { ...base, status: "blocked", transactionId: txId, code: auth.body?.code, reason: auth.body?.reason, selected: c.payload });
      }
      const authorization = auth.body.authorization;
      const authId: string = authorization.payload.authId;
      this.log(`Gateway authorized ${fmt(option.amount, option.currency)} (budget available after reservation: ${fmt(auth.body.budget.available, auth.body.budget.currency)})`);
      Object.assign(evidence, { scheme: option.scheme, amount: option.amount, currency: option.currency, ledgerDoc: `${this.cfg.layout.transactions}${txId}-ledger.ttl`, challenge: option.challenge });
      const common = { ...base, transactionId: txId, selected: c.payload, amount: option.amount, currency: option.currency, scheme: option.scheme };

      const pay = await postJson(`${wallet.signerEndpoint}/pay`, { authorization, challenge: option.challenge }, bearerHeaders(this.cfg.agentSecret));
      if (pay.status !== 200) {
        await this.outcome(txId, "payment_failed", pay.body?.reason);
        return this.finish(evidence, { ...common, status: "payment_failed", code: pay.body?.error, reason: pay.body?.reason });
      }
      const credential: DelegatedCredential = pay.body.credential;
      this.log(`Signer minted a single-use delegated token (max ${fmt(option.amount, option.currency)}, this session and merchant only)`);

      const done = await this.adapter.complete(c.apiBase, session.id, credential, authId);
      if (done.kind === "declined") {
        const gw = await this.outcome(txId, "payment_failed", `${done.code}: ${done.message}`);
        this.log(`Merchant could not charge: ${done.code}; reservation is ${gw}`);
        return this.finish(evidence, { ...common, status: "payment_failed", code: done.code, reason: `${done.message}; reservation ${gw} until the payment provider shows the token can no longer be charged` });
      }
      if (done.kind === "uncertain") {
        const gw = await this.outcome(txId, "unknown", done.detail);
        const paid = gw === "settled";
        evidence.delivery = { status: "NotDelivered", checks: [paid ? "charged at the payment provider, but the merchant has not confirmed an order" : "payment not confirmed; reservation held until reconciled"] };
        return this.finish(evidence, { ...common, status: paid ? "paid_not_delivered" : "payment_failed", code: paid ? "ORDER_UNCONFIRMED" : "PAYMENT_UNCERTAIN", reason: done.detail, delivery: evidence.delivery });
      }

      const paymentStatus = await this.outcome(txId, "paid");
      const order = done.session.order!;
      this.log(`Order ${order.id} placed with ${c.merchant.name}; payment ${paymentStatus}; awaiting shipment`);
      const tracking: OrderTracking = {
        transactionId: txId, evidence: evidence.docUrl, fulfilment: `${this.cfg.layout.transactions}${txId}-fulfilment.ttl`,
        orderId: order.id, orderUrl: order.permalink_url, merchant: c.merchant.webId, merchantName: c.merchant.name,
        items: lineItems, total: option.amount, currency: option.currency, address: addressId,
        requirements: requirements.map((r) => r.criterion), orderStatus: "created", paymentStatus,
        events: [{ status: "created", at: new Date().toISOString() }],
        delivery: { status: "FulfilmentPending", checks: ["paid; awaiting shipment"] },
      };
      evidence.fulfilment = tracking.fulfilment;
      evidence.delivery = tracking.delivery;
      await this.writeFulfilment(tracking);
      return this.finish(evidence, { ...common, status: "fulfilment_pending", delivery: tracking.delivery, tracking });
    }
    return this.finish(evidence, { ...base, status: "blocked", code: "CHECKOUT_UNSTABLE", reason: "checkout kept changing during purchase" });
  }

  async track(t: OrderTracking): Promise<OrderTracking> {
    const order = await this.adapter.order(t.orderUrl);
    if (!order) throw new Error(`cannot read order ${t.orderUrl}`);
    // Refunds are confirmed by the gateway at the PSP; the merchant's order status alone moves no budget.
    const gw = await postJson(`${this.cfg.gatewayUrl}/transactions/${encodeURIComponent(t.transactionId)}/reconcile`, { agentId: this.cfg.agentId }, bearerHeaders(this.cfg.agentSecret));
    const next: OrderTracking = { ...t, orderStatus: order.status, events: order.events, paymentStatus: gw.body?.status ?? t.paymentStatus };
    next.delivery = deliveryState(next);
    this.log(`Order ${t.orderId}: ${order.status}; payment ${next.paymentStatus}`);
    await this.writeFulfilment(next);
    return next;
  }

  /**
   * The user inspects the goods and reports what they found (e.g.
   * { solesReplaceable: "false" }). Each agreed requirement is checked against
   * that, missing counts as not met, and the device signs the verdict.
   */
  async accept(t: OrderTracking, observed: Record<string, string>, device: ApprovalDevice): Promise<OrderTracking> {
    if (t.orderStatus !== "delivered") throw new Error(`order is ${t.orderStatus}, not delivered`);
    let ok = true;
    const checks = t.requirements.map((c) => {
      const met = compare(observed[c.leftOperand], c) === true;
      ok &&= met;
      return `${met ? "✓" : "✗"} ${c.leftOperand} = ${observed[c.leftOperand] ?? "not reported"} (required ${c.operator} ${c.rightOperand}; reported by the user)`;
    });
    const verdict = ok ? "Delivered" as const : "NonCompliant" as const;
    const conf = await device.attest({ kind: "deliveryAcceptance", owner: this.cfg.layout.webId, transactionId: t.transactionId, orderId: t.orderId, verdict, checks });
    if (!conf) return t;
    const next: OrderTracking = { ...t, acceptance: { verdict, checks, by: conf.by, at: conf.at, keyId: conf.keyId, termsDigest: conf.termsDigest, signature: conf.signature } };
    next.delivery = deliveryState(next);
    await this.writeFulfilment(next);
    return next;
  }

  async cancel(t: OrderTracking): Promise<OrderTracking> {
    const r = await this.adapter.cancelOrder(t.orderUrl);
    if (r.body?.code === "refund_failed") this.log(`Merchant canceled the order but its refund failed (${r.body.message}); cancel again to retry the refund`);
    else if (r.status !== 200) this.log(`Merchant refused cancellation: ${r.body?.code ?? r.status} ${r.body?.message ?? ""}`);
    return this.track(t);
  }

  /** Report to the gateway and return its ledger status. For checkouts it consults the PSP, not this report. */
  private async outcome(txId: string, result: "paid" | "payment_failed" | "unknown", detail?: string): Promise<string> {
    const out = await postJson(`${this.cfg.gatewayUrl}/transactions/${encodeURIComponent(txId)}/outcome`, { agentId: this.cfg.agentId, result, detail }, bearerHeaders(this.cfg.agentSecret));
    return out.body?.status ?? "unknown";
  }

  private async writeFulfilment(t: OrderTracking) {
    await this.cfg.pod.putTurtle(t.fulfilment, await fulfilmentEvidenceToTurtle({
      docUrl: t.fulfilment, transactionId: t.transactionId, transactionDoc: t.evidence, orderId: t.orderId, orderUrl: t.orderUrl,
      merchant: t.merchant, merchantName: t.merchantName, orderStatus: t.orderStatus, items: t.items, total: t.total, currency: t.currency,
      deliveryAddress: t.address, events: t.events, paymentStatus: t.paymentStatus, delivery: t.delivery, acceptance: t.acceptance, updatedAt: new Date().toISOString(),
    }));
  }

  private async finish(evidence: AssistantEvidence, result: PurchaseResult): Promise<PurchaseResult> {
    if (!evidence.transactionId) { evidence.transactionId = newId("tx-"); evidence.docUrl = `${this.cfg.layout.transactions}${evidence.transactionId}.ttl`; result.transactionId ??= evidence.transactionId; }
    evidence.status = result.status;
    evidence.endedAt = new Date().toISOString();
    await this.cfg.pod.putTurtle(evidence.docUrl, await assistantEvidenceToTurtle(evidence));
    return { ...result, evidence: evidence.docUrl };
  }
}

/**
 * Fulfilment outcome from the order state and the user's verdict. "Delivered"
 * needs the user, not the carrier, and a later return or refund never
 * replaces the user's signed verdict: it is recorded alongside it.
 */
function deliveryState(t: OrderTracking): OrderTracking["delivery"] {
  const refund = t.paymentStatus === "refunded" ? "refund confirmed by the payment provider, budget released" : "refund not yet confirmed by the payment provider, budget still committed";
  switch (t.orderStatus) {
    case "created": return { status: "FulfilmentPending", checks: [`paid (${t.paymentStatus}); awaiting shipment`] };
    case "shipped": return { status: "FulfilmentPending", checks: ["in transit"] };
    case "delivered":
      return t.acceptance ? { status: t.acceptance.verdict, checks: t.acceptance.checks } : { status: "FulfilmentPending", checks: ["delivered by the carrier; awaiting the user's inspection"] };
    case "canceled":
      // Canceled, but the merchant's refund has not gone through: cancelling again retries it.
      return { status: "Cancelled", checks: [`order canceled; ${refund}; cancel again to retry the refund`] };
    case "refunded":
      return { status: "Cancelled", checks: [`order canceled; ${refund}`] };
    case "returned":
      return t.acceptance
        ? { status: t.acceptance.verdict, checks: [...t.acceptance.checks, `returned; ${refund}`] }
        : { status: "Cancelled", checks: [`returned before the user's inspection; ${refund}`] };
  }
}
