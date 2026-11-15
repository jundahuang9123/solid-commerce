/**
 * Authorization and transaction gateway: deterministic code, no LLM.
 *
 * POST /authorize                  check mandate + seller + offer + challenge, reserve budget, sign an authorization
 * POST /transactions/:id/outcome   agent reports paid / failed / unknown (with the seller's signed receipt)
 * POST /reconcile                  resolve authorized/pending transactions against the payment rails
 * POST /transactions/:id/reconcile the transaction's agent asks for one transaction to be reconciled,
 *                                  including refunds of settled checkout purchases
 * GET  /transactions/:id           ledger row and event history (its own agent, or the admin)
 * GET  /budget?mandate=<iri>       limit, committed, settled, available (unauthenticated: amounts only)
 *
 * Every route but /budget needs a caller credential (src/trust/agentAuth.ts):
 * an enrolled agent's secret, or for GET /transactions/:id and /reconcile the
 * admin secret. The acting agent is the one whose secret is presented; an
 * `agentId` in the body must name that same agent.
 *
 * Authorization is bound to seller, offer version and digest, resource,
 * scheme, amount, currency, payee, the exact challenge, the payment's rail
 * reference (derived here from the challenge, ./offerBinding.ts), for x402
 * the chain, token and EIP-712 domain, an expiry and a unique transaction id.
 *
 * Mandate revisions: the ledger keeps the highest user-signed revision seen
 * per mandate id and refuses older ones (Ledger.observeRevision). Agent-side
 * rollback detection for agreed meanings and requirements is CommonGround's
 * job (src/grounding), not the gateway's.
 *
 * Two kinds of terms are accepted:
 *  - a seller-signed offer plus the HTTP 402 challenge that implements it (x402, L402-style, card/PSP);
 *  - an ACP-style checkout session ("acp-delegated"), which the gateway re-reads
 *    from the approved merchant itself (./checkoutBinding.ts).
 * Everything after that binding step (mandate limits, atomic reservation,
 * signing, reconciliation) is shared.
 */
import type { Offer, SpendingMandate } from "../model.js";
import { PodClient } from "../pod/PodClient.js";
import { PodLayout } from "../pod/layout.js";
import { parseRecord } from "../rdf/records.js";
import { verifyConfirmation } from "../grounding/approval.js";
import { TrustRegistry, offerDigest } from "../trust/registry.js";
import { Ed25519Key, digestOf, newId, signEnvelope, verifyEnvelope, type Signed } from "../util/crypto.js";
import { json, serve, type RunningServer } from "../util/http.js";
import { toAtomic, fmt } from "../util/money.js";
import type { OfferRef, PaymentAuthorization, PaymentOption, Receipt } from "../payments/types.js";
import { nonceFor } from "../payments/schemes/x402.js";
import { Ledger, type TxRow, type TxStatus } from "./ledger.js";
import { ledgerEvidenceToTurtle } from "../rdf/evidence.js";
import { bindCheckout, delegatedPaymentState, type Binding, type CheckoutClaim } from "./checkoutBinding.js";
import { bindSignedOffer } from "./offerBinding.js";
import { AgentDirectory, type AgentEnrollment, type Principal } from "../trust/agentAuth.js";

export interface GatewayConfig {
  pod: PodClient;
  layout: PodLayout;
  enrolledApprovalKeys: JsonWebKey[];
  registry: TrustRegistry;
  rails: { facilitatorUrl: string; lightningUrl: string; pspUrl: string };
  payers: { x402?: string };            // public payer identifiers, for reconciliation
  ledgerPath?: string;
  authorizationTtlSeconds?: number;
  gatewayId?: string;
  /** Agents that may call the gateway, with the hash of each one's secret (more can be enrolled later). */
  agents?: AgentEnrollment[];
  /** Hash of the operator's secret: may read any transaction and run /reconcile, never authorize. */
  adminSecretHash?: string;
}

export interface AuthorizeRequest {
  transactionId: string;
  agentId: string;
  mandateId: string;
  offer?: Signed<Offer>;                 // 402 schemes
  offerRef?: OfferRef;                   // what the 402 response claimed
  checkout?: CheckoutClaim;              // acp-delegated
  option: PaymentOption;
}

export type Rejection = { code: string; reason: string };

/** Statuses whose payment outcome is not known yet; only these may become settled or released. */
const UNRESOLVED: TxStatus[] = ["authorized", "pending"];

export interface GatewayHandle extends RunningServer {
  key: Ed25519Key;
  ledger: Ledger;
  reconcile(): Promise<Array<{ txId: string; status: string }>>;
  /** Register the wallet's public x402 payer address (used to query the rail during reconciliation). */
  setPayer(x402Address: string): void;
  /** Enroll an agent's secret (its hash, see secretHash). Only enrolled agents can act here. */
  enrollAgent(agentId: string, secretHash: string): void;
}

export async function startGateway(cfg: GatewayConfig): Promise<GatewayHandle> {
  const key = Ed25519Key.generate();
  const ledger = new Ledger(cfg.ledgerPath);
  const ttl = cfg.authorizationTtlSeconds ?? 120;
  const gatewayId = cfg.gatewayId ?? "urn:solid-commerce:gateway";

  const reject = (code: string, reason: string): Rejection => ({ code, reason });

  async function loadMandate(id: string): Promise<SpendingMandate | Rejection> {
    const res = await cfg.pod.get(id.split("#")[0]);
    if (!res) return reject("MANDATE_NOT_FOUND", id);
    let rec;
    try { rec = parseRecord(res.text, id); } catch (e) { return reject("MANDATE_INVALID", (e as Error).message); }
    if (rec.kind !== "mandate") return reject("MANDATE_INVALID", "not a spending mandate");
    const check = verifyConfirmation(rec, cfg.enrolledApprovalKeys);
    if (!check.ok) return reject("MANDATE_NOT_CONFIRMED", check.reason);
    // The newest revision the user signed is binding: an older signed revision put back into the
    // Pod (still a valid signature) is refused once a newer one has been seen.
    const hw = ledger.observeRevision(rec.id, rec.revision, rec.confirmation!.termsDigest);
    if (!hw.ok) return reject(hw.code, hw.reason);
    return rec;
  }

  async function authorize(r: AuthorizeRequest, caller: string): Promise<{ status: number; body: unknown }> {
    if (!r || typeof r !== "object") return { status: 400, body: reject("BAD_REQUEST", "missing fields") };
    // The acting agent is the authenticated one; a body naming someone else is refused, not recorded.
    if (r.agentId !== undefined && r.agentId !== caller) return { status: 403, body: reject("AGENT_MISMATCH", `authenticated as ${caller}, request names ${r.agentId}`) };
    r = { ...r, agentId: caller };
    const isCheckout = r.option?.scheme === "acp-delegated";
    if (!r.transactionId || !r.agentId || !r.mandateId || !r.option || (isCheckout ? !r.checkout : !r.offer)) return { status: 400, body: reject("BAD_REQUEST", "missing fields") };
    const requestDigest = digestOf(isCheckout
      ? { mandateId: r.mandateId, agentId: r.agentId, checkout: r.checkout, option: r.option }
      : { mandateId: r.mandateId, agentId: r.agentId, offer: offerDigest(r.offer!.payload), option: r.option });

    // Idempotency: same id + same request returns the same authorization; a different request is a conflict.
    const existing = ledger.get(r.transactionId);
    if (existing) {
      if (existing.request_digest !== requestDigest) return { status: 409, body: reject("IDEMPOTENCY_CONFLICT", "transaction id reused for a different request") };
      if (existing.status === "rejected") return { status: 403, body: reject("REJECTED", existing.reason ?? "") };
      return { status: 200, body: { authorization: JSON.parse(existing.auth_json!), replayed: true, status: existing.status } };
    }

    const fail = (status: number, rj: Rejection) => {
      // Rejections are recorded too, so the evidence trail shows blocked attempts.
      try {
        ledger.insert({ tx_id: r.transactionId, mandate_id: r.mandateId, agent_id: r.agentId, seller: r.offer?.payload?.seller ?? r.checkout?.merchant ?? "?", offer_id: r.offer?.payload?.offerId ?? r.option.resource ?? "?", offer_version: r.offer?.payload?.version ?? 0, scheme: r.option.scheme, amount: r.option.amount, currency: r.option.currency, request_digest: requestDigest, status: "rejected", auth_id: null, auth_json: null, rail_reference: null, payer: null, receipt_json: null, reason: `${rj.code}: ${rj.reason}`, expires_at: null });
      } catch { /* concurrent insert with same id */ }
      syncEvidence(r.transactionId).catch(() => {});
      return { status, body: rj };
    };

    // 1. Mandate: user-signed, current, covers this agent and category
    const m = await loadMandate(r.mandateId);
    if ("code" in m) return fail(403, m);
    if (new Date(m.validUntil) <= new Date()) return fail(403, reject("MANDATE_EXPIRED", m.validUntil));
    if (!m.assignees.includes(r.agentId)) return fail(403, reject("AGENT_NOT_AUTHORIZED", r.agentId));

    // 2-3. Bind to terms the gateway verifies itself: a signed offer, or the merchant's own checkout session
    let binding: Binding;
    if (isCheckout) {
      const b = await bindCheckout(cfg, m, r.checkout, r.option);
      if (!b.ok) return fail(b.status, reject(b.code, b.reason));
      binding = b.binding;
    } else {
      const b = await bindSignedOffer(cfg, m, r.offer!, r.offerRef, r.option);
      if (!b.ok) return fail(b.status, reject(b.code, b.reason));
      binding = b.binding;
    }
    const o = r.option;

    // 4. Mandate limits
    if (!m.allowedSchemes.includes(o.scheme)) return fail(403, reject("SCHEME_NOT_AUTHORIZED", o.scheme));
    if (o.currency !== m.currency) return fail(403, reject("CURRENCY_NOT_AUTHORIZED", `${o.currency} (mandate is ${m.currency})`));
    const amount = BigInt(o.amount);
    const perTx = BigInt(toAtomic(m.maxPerTransaction, m.currency));
    const total = BigInt(toAtomic(m.totalLimit, m.currency));
    if (amount > perTx) return fail(403, reject("PER_TRANSACTION_LIMIT", `${fmt(amount, o.currency)} > ${fmt(perTx, o.currency)}`));

    // 5. Reserve atomically and sign
    const authId = newId("auth-");
    const now = new Date();
    // Derived from the challenge by the binding step (x402: from the authorization id), never the agent's.
    const railReference = o.scheme === "x402" ? nonceFor(authId) : binding.railReference;
    if (!railReference) return fail(409, reject("OFFER_MISMATCH", "the challenge names no payment the gateway could reconcile"));
    const payload: PaymentAuthorization = {
      authId, transactionId: r.transactionId, mandateId: m.id, agentId: r.agentId, seller: binding.seller,
      offerId: binding.offerId, offerVersion: binding.offerVersion, offerDigest: binding.offerDigest, resource: binding.resource,
      scheme: o.scheme, amount: o.amount, currency: o.currency, payTo: o.payTo, challengeDigest: digestOf(o.challenge),
      railReference, ...(binding.x402 ? { x402: binding.x402 } : {}),
      issuedAt: now.toISOString(), expiresAt: new Date(now.getTime() + ttl * 1000).toISOString(),
    };
    const signed = signEnvelope(key, payload);
    let outcome: { ok: true } | { ok: false; status: number; rj: Rejection };
    try {
      outcome = ledger.immediate(() => {
        if (ledger.get(r.transactionId)) return { ok: false as const, status: 409, rj: reject("IDEMPOTENCY_RACE", "retry with the same request") };
        // A newer revision of the mandate seen since it was loaded (a concurrent request) wins.
        const hw = ledger.revisionOf(m.id);
        if (hw && hw.revision > m.revision) return { ok: false as const, status: 403, rj: reject("MANDATE_SUPERSEDED", `revision ${m.revision} was superseded by revision ${hw.revision}`) };
        // One live authorization per checkout session, checked under the same lock as the budget:
        // each authorization gets its own one-time token, so two would let one basket be charged twice.
        const live = isCheckout && railReference ? ledger.liveCheckout(binding.seller, railReference) : undefined;
        if (live) {
          return { ok: false as const, status: 409, rj: reject("CHECKOUT_ALREADY_AUTHORIZED", `checkout session ${railReference} is already covered by transaction ${live.tx_id} (${live.status}); reconcile it before authorizing again`) };
        }
        const committed = ledger.committed(m.id, m.currency);
        if (committed + amount > total) {
          return { ok: false as const, status: 403, rj: reject("BUDGET_EXCEEDED", `${fmt(committed, m.currency)} committed + ${fmt(amount, m.currency)} > ${fmt(total, m.currency)}`) };
        }
        ledger.insert({
          tx_id: r.transactionId, mandate_id: m.id, agent_id: r.agentId, seller: binding.seller, offer_id: binding.offerId, offer_version: binding.offerVersion,
          scheme: o.scheme, amount: o.amount, currency: o.currency, request_digest: requestDigest, status: "authorized",
          auth_id: authId, auth_json: JSON.stringify(signed), rail_reference: railReference,
          payer: o.scheme === "x402" ? cfg.payers.x402 ?? null : null, receipt_json: null, reason: null, expires_at: payload.expiresAt,
        });
        return { ok: true as const };
      });
    } catch (e) {
      return { status: 409, body: reject("IDEMPOTENCY_RACE", (e as Error).message) };
    }
    if (!outcome.ok) {
      if (outcome.rj.code === "IDEMPOTENCY_RACE") return { status: 409, body: outcome.rj };
      return fail(outcome.status, outcome.rj);
    }
    await syncEvidence(r.transactionId);
    return { status: 200, body: { authorization: signed, replayed: false, status: "authorized", budget: budget(m) } };
  }

  function budget(m: SpendingMandate) {
    const total = BigInt(toAtomic(m.totalLimit, m.currency));
    const committed = ledger.committed(m.id, m.currency);
    return { currency: m.currency, limit: total.toString(), committed: committed.toString(), settled: ledger.settled(m.id, m.currency).toString(), available: (total - committed).toString() };
  }

  async function outcome(txId: string, caller: string, body: { agentId?: string; result: "paid" | "payment_failed" | "unknown"; receipt?: Signed<Receipt>; detail?: string }) {
    const tx = ledger.get(txId);
    if (!tx) return { status: 404, body: reject("UNKNOWN_TRANSACTION", txId) };
    if (body?.agentId !== undefined && body.agentId !== caller) return { status: 403, body: reject("AGENT_MISMATCH", `authenticated as ${caller}, request names ${body.agentId}`) };
    if (tx.agent_id !== caller) return { status: 403, body: reject("NOT_YOUR_TRANSACTION", caller) };
    if (tx.status === "settled" || tx.status === "released" || tx.status === "rejected" || tx.status === "refunded") return { status: 200, body: { status: tx.status, unchanged: true } };
    if (tx.scheme === "acp-delegated") {
      // A checkout has no seller receipt. Whatever the agent reports, only the payment provider decides.
      await reconcileOne(tx);
      ledger.move(txId, ["authorized"], { status: "pending", reason: `agent reported ${body.result}${body.detail ? ": " + body.detail : ""}; awaiting the payment provider` });
    } else if (body.result === "paid" && body.receipt) {
      const err = checkReceipt(tx, body.receipt);
      if (err) return { status: 422, body: reject("RECEIPT_INVALID", err) };
      ledger.move(txId, UNRESOLVED, { status: "settled", receipt_json: JSON.stringify(body.receipt), rail_reference: body.receipt.payload.railReference });
    } else {
      // Uncertain or failed: hold the reservation until the rail says otherwise.
      ledger.move(txId, UNRESOLVED, { status: "pending", reason: body.detail ?? body.result });
      await reconcileOne(ledger.get(txId)!);
    }
    await syncEvidence(txId);
    return { status: 200, body: { status: ledger.get(txId)!.status } };
  }

  function checkReceipt(tx: TxRow, rc: Signed<Receipt>): string | undefined {
    const seller = cfg.registry.get(tx.seller);
    if (!seller || !verifyEnvelope(rc, seller.publicJwk)) return "receipt not signed by the seller's pinned key";
    const p = rc.payload;
    if (p.amount !== tx.amount || p.currency !== tx.currency || p.offerId !== tx.offer_id || p.scheme !== tx.scheme) return "receipt does not match the authorized transaction";
    if (tx.rail_reference && p.railReference !== tx.rail_reference) return "receipt references a different payment";
    return undefined;
  }

  /**
   * Checkout purchases, asked of the PSP that holds the delegated token:
   *  - token charged          -> settled, at the charged amount (the PSP caps it at the authorized amount)
   *  - charge fully refunded  -> refunded: no longer counts against the budget, but only once the
   *                              PSP confirms the refund, never on the agent's or merchant's word
   *  - no charge, expired     -> released: the PSP refuses expired tokens, so it can never be charged
   * A partial refund is noted and keeps the full charge committed (conservative).
   *
   * Every transition names the statuses it may leave (Ledger.move), so a stale
   * row or a concurrent pass cannot, say, release a settled purchase.
   */
  async function reconcileCheckout(tx: TxRow, expired: boolean): Promise<string> {
    const provider = cfg.registry.getMerchant(tx.seller)?.paymentProvider ?? cfg.rails.pspUrl;
    const st = tx.rail_reference && tx.auth_id ? await delegatedPaymentState(provider, tx.rail_reference, tx.auth_id) : undefined;
    const charge = st?.token?.charge;
    if (charge?.status === "succeeded") {
      if (charge.amount_refunded >= charge.amount) ledger.move(tx.tx_id, [...UNRESOLVED, "settled"], { status: "refunded", amount: String(charge.amount), reason: `refund of ${charge.id} confirmed by the payment provider` });
      else if (tx.status !== "settled") ledger.move(tx.tx_id, UNRESOLVED, { status: "settled", amount: String(charge.amount), reason: `charge ${charge.id} confirmed by the payment provider` });
      else if (charge.amount_refunded > 0 && !tx.reason?.includes("partial refund")) ledger.update(tx.tx_id, { reason: `partial refund of ${charge.amount_refunded}; budget stays committed` });
    } else if (st && expired) {
      // The PSP answered, shows no charge, and refuses expired tokens: it can never be charged.
      ledger.move(tx.tx_id, UNRESOLVED, { status: "released", reason: "no charge and the delegated token has expired" });
    } else if (expired) {
      ledger.move(tx.tx_id, ["authorized"], { status: "pending", reason: "authorization expired, payment provider state unknown" });
    }
    return ledger.get(tx.tx_id)!.status;
  }

  /**
   * Ask the rail whether money moved. Release only when it provably cannot.
   * For the 402 schemes only unresolved rows are looked at: once settled
   * (receipt or rail), nothing a rail answers later un-pays it. A rail that
   * answers with an error proves nothing either way, so it holds the row.
   */
  async function reconcileOne(tx: TxRow): Promise<string> {
    const expired = tx.expires_at ? new Date(tx.expires_at) <= new Date() : true;
    if (tx.scheme === "acp-delegated") return reconcileCheckout(tx, expired);
    if (!UNRESOLVED.includes(tx.status)) return tx.status;
    let paid: boolean | undefined;
    try {
      if (tx.scheme === "x402" && tx.payer && tx.rail_reference) {
        const r = await fetch(`${cfg.rails.facilitatorUrl}/authorization-state?authorizer=${tx.payer}&nonce=${tx.rail_reference}`);
        paid = r.ok ? ((await r.json()) as { used: boolean }).used : undefined;
      } else if (tx.scheme === "l402" && tx.rail_reference) {
        const r = await fetch(`${cfg.rails.lightningUrl}/invoices/${tx.rail_reference}`);
        paid = r.ok ? ((await r.json()) as { paid: boolean }).paid : undefined;
      } else if (tx.scheme === "card-psp" && tx.rail_reference) {
        const r = await fetch(`${cfg.rails.pspUrl}/payment_intents/${tx.rail_reference}`);
        paid = r.ok ? ((await r.json()) as { status: string }).status === "succeeded" : undefined;
      }
    } catch { paid = undefined; }
    if (paid === true) ledger.move(tx.tx_id, UNRESOLVED, { status: "settled", reason: "confirmed by reconciliation" });
    else if (paid === false && expired) ledger.move(tx.tx_id, UNRESOLVED, { status: "released", reason: "not paid and authorization expired" });
    else if (expired) ledger.move(tx.tx_id, ["authorized"], { status: "pending", reason: "authorization expired, rail state unknown" });
    return ledger.get(tx.tx_id)!.status;
  }

  async function reconcile() {
    const out: Array<{ txId: string; status: string }> = [];
    for (const tx of [...ledger.unresolved(), ...ledger.refundable()]) {
      out.push({ txId: tx.tx_id, status: await reconcileOne(tx) });
      await syncEvidence(tx.tx_id);
    }
    return out;
  }

  async function syncEvidence(txId: string) {
    const tx = ledger.get(txId);
    if (!tx) return;
    const docUrl = `${cfg.layout.transactions}${encodeURIComponent(txId)}-ledger.ttl`;
    await cfg.pod.putTurtle(docUrl, await ledgerEvidenceToTurtle({
      docUrl, transactionId: tx.tx_id, mandate: tx.mandate_id, status: tx.status, scheme: tx.scheme, amount: tx.amount, currency: tx.currency,
      seller: tx.seller, offerId: tx.offer_id, offerVersion: tx.offer_version, authorizationId: tx.auth_id ?? undefined,
      authorization: tx.auth_json ? JSON.parse(tx.auth_json) : undefined, railReference: tx.rail_reference ?? undefined,
      receipt: tx.receipt_json ? JSON.parse(tx.receipt_json) : undefined, reason: tx.reason ?? undefined, updatedAt: tx.updated_at, gateway: gatewayId,
    })).catch(() => { /* evidence sync is retried on the next status change */ });
  }

  const agents = new AgentDirectory(cfg.agents ?? [], cfg.adminSecretHash);
  const unauthenticated = (res: Parameters<typeof json>[0]) =>
    json(res, 401, reject("AGENT_NOT_AUTHENTICATED", "present the secret enrolled for this agent (Authorization: Bearer)"), { "www-authenticate": "Bearer" });

  const srv = await serve(async (req, res) => {
    const u = new URL(req.url, "http://x");
    if (req.method === "GET" && u.pathname === "/budget") {
      const m = await loadMandate(u.searchParams.get("mandate") ?? "");
      return "code" in m ? json(res, 403, m) : json(res, 200, budget(m));
    }
    const isRoute = (req.method === "POST" && (u.pathname === "/authorize" || u.pathname === "/reconcile" || /^\/transactions\/[^/]+\/(outcome|reconcile)$/.test(u.pathname)))
      || (req.method === "GET" && /^\/transactions\/[^/]+$/.test(u.pathname));
    if (!isRoute) return json(res, 404, { error: "not_found" });
    const who: Principal | undefined = agents.authenticate(req.headers);
    if (!who) return unauthenticated(res);
    const agent = who.kind === "agent" ? who.agentId : undefined;

    if (req.method === "POST" && u.pathname === "/authorize") {
      if (!agent) return unauthenticated(res);
      const out = await authorize(JSON.parse(req.body || "null"), agent);
      return json(res, out.status, out.body);
    }
    const oc = u.pathname.match(/^\/transactions\/([^/]+)\/outcome$/);
    if (req.method === "POST" && oc) {
      if (!agent) return unauthenticated(res);
      const out = await outcome(decodeURIComponent(oc[1]), agent, JSON.parse(req.body || "{}"));
      return json(res, out.status, out.body);
    }
    const rc = u.pathname.match(/^\/transactions\/([^/]+)\/reconcile$/);
    if (req.method === "POST" && rc) {
      if (!agent) return unauthenticated(res);
      const row = ledger.get(decodeURIComponent(rc[1]));
      if (!row) return json(res, 404, reject("UNKNOWN_TRANSACTION", rc[1]));
      const { agentId } = JSON.parse(req.body || "{}") as { agentId?: string };
      if (agentId !== undefined && agentId !== agent) return json(res, 403, reject("AGENT_MISMATCH", `authenticated as ${agent}, request names ${agentId}`));
      if (row.agent_id !== agent) return json(res, 403, reject("NOT_YOUR_TRANSACTION", agent));
      // Unresolved rows, plus settled checkout purchases (which can still be refunded). Nothing else moves.
      const open = UNRESOLVED.includes(row.status) || (row.status === "settled" && row.scheme === "acp-delegated");
      const status = open ? await reconcileOne(row) : row.status;
      await syncEvidence(row.tx_id);
      return json(res, 200, { status });
    }
    const tx = u.pathname.match(/^\/transactions\/([^/]+)$/);
    if (req.method === "GET" && tx) {
      // The row holds the signed authorization, from which the signer would replay the credential
      // to its agent; only that agent (or the operator) may read it.
      const row = ledger.get(decodeURIComponent(tx[1]));
      if (row && agent && row.agent_id !== agent) return json(res, 403, reject("NOT_YOUR_TRANSACTION", agent));
      return row ? json(res, 200, { ...row, events: ledger.events(row.tx_id) }) : json(res, 404, { error: "not_found" });
    }
    if (req.method === "POST" && u.pathname === "/reconcile") return json(res, 200, { results: await reconcile() });
    json(res, 404, { error: "not_found" });
  });
  return Object.assign(srv, { key, ledger, reconcile, setPayer: (a: string) => { cfg.payers.x402 = a; }, enrollAgent: (id: string, h: string) => agents.enroll(id, h) });
}
