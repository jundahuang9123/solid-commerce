/**
 * Simulated card payment service provider.
 *
 * 1. Payment intents (Stripe-like), used by the "card-psp" scheme behind HTTP 402.
 *    The seller creates an intent. The buyer's vault confirms it with a stored
 *    card token and an idempotency key. The seller checks the intent's status
 *    before delivering.
 *
 * 2. Delegated payment tokens for ACP-style checkout ("acp-delegated"),
 *    modelled on the public description of ACP's delegate_payment; verify
 *    against the current specification before interoperating.
 *      POST /agentic_commerce/delegate_payment       vault -> PSP: card token + allowance -> single-use token "vt_..."
 *      POST /agentic_commerce/charges                merchant -> PSP: charge a token (merchant API key)
 *      POST /agentic_commerce/refunds                merchant -> PSP: refund a charge
 *      GET  /agentic_commerce/delegated_tokens?checkout_session_id=   reconciliation lookup
 *      GET  /agentic_commerce/delegated_tokens/{id}
 *    The allowance is enforced here, at the rail: one use, at most max_amount,
 *    in its currency, only by its merchant, only for its checkout session, only
 *    for the session snapshot the gateway authorized, and only before
 *    expires_at. So a merchant that changes its total after the gateway
 *    authorized it cannot charge more, a session re-addressed or re-itemized
 *    after authorization cannot be charged, and an expired, unused token can
 *    provably never be charged.
 *
 *    Limit, stated plainly: the PSP cannot see the session. The snapshot check
 *    relies on the merchant reporting the digest of the session it is actually
 *    completing. That stops an agent (or anyone else holding the session id)
 *    from changing the session after authorization at an honest merchant; a
 *    dishonest merchant could report the authorized digest and ship anywhere,
 *    as it could ignore the order altogether. Against that the protection is
 *    the trust registry (only approved merchants are paid), the amount cap and
 *    the user's signed delivery verdict, not this check.
 *
 * Raw card numbers never appear. The signer holds only an opaque card token,
 * as with a real PSP vault, and lookups never return it.
 */
import { randomBytes } from "node:crypto";
import { json, serve, type RunningServer } from "../../util/http.js";
import { canonicalJson, randomHex, safeEqual } from "../../util/crypto.js";
import type { Allowance } from "../../checkout/acp.js";

interface Intent { id: string; amount: number; currency: string; merchant: string; resource: string; status: "requires_confirmation" | "succeeded" | "failed"; paymentMethod?: string; createdAt: number }

export interface Charge { id: string; token: string; amount: number; currency: string; merchant_id: string; checkout_session_id: string; status: "succeeded"; amount_refunded: number; created: string }
export interface DelegatedToken {
  id: string; created: string; status: "active" | "used";
  allowance: Allowance; metadata: Record<string, string>;
  paymentMethod: string;            // the vaulted card token: never returned by the API
  chargeId?: string;
}

export interface PspSim extends RunningServer {
  intents: Map<string, Intent>;
  cards: Map<string, { limit: number; spent: number }>;
  merchantBalances: Map<string, number>;
  tokens: Map<string, DelegatedToken>;
  charges: Map<string, Charge>;
  /** Issue an API key for a merchant (what a merchant gets when onboarding with the PSP). */
  registerMerchant(merchantId: string): string;
  /** Test control: decline the next N delegated-token charges as if the issuer refused them. */
  declineNextCharges(n?: number): void;
  /** Test control: fail the next N refunds as if the PSP were having an outage (502, nothing refunded). */
  failNextRefunds(n?: number): void;
}

const err = (code: string, message: string) => ({ type: "invalid_request", code, message });

export async function startPsp(): Promise<PspSim> {
  const intents = new Map<string, Intent>();
  const cards = new Map<string, { limit: number; spent: number }>();
  const idem = new Map<string, unknown>();
  const merchantBalances = new Map<string, number>();
  const tokens = new Map<string, DelegatedToken>();
  const charges = new Map<string, Charge>();
  const merchantKeys = new Map<string, string>();      // API key -> merchant id (a merchant may hold several keys)
  /** ACP-style idempotency: key -> (request, response). Same key with another request is a conflict. */
  const acpIdem = new Map<string, { request: string; status: number; body: unknown }>();
  let declines = 0;
  let refundFailures = 0;

  /** The merchant authenticated by its API key, if any. */
  const merchantOf = (auth: string | undefined) => {
    const key = auth?.replace(/^Bearer\s+/i, "") ?? "";
    for (const [k, id] of merchantKeys) if (safeEqual(k, key)) return id;
    return undefined;
  };
  const publicToken = (t: DelegatedToken) => {
    const c = t.chargeId ? charges.get(t.chargeId) : undefined;
    return { id: t.id, created: t.created, status: t.status, allowance: t.allowance, metadata: t.metadata, charge: c ? { id: c.id, status: c.status, amount: c.amount, amount_refunded: c.amount_refunded } : null };
  };

  function delegate(body: any): { status: number; body: unknown } {
    const a = body?.allowance as Allowance | undefined;
    const pm = body?.payment_method;
    if (!a || a.reason !== "one_time") return { status: 400, body: err("invalid_allowance", "allowance.reason must be one_time") };
    if (!Number.isInteger(a.max_amount) || a.max_amount <= 0 || !a.currency || !a.checkout_session_id || !a.merchant_id || !a.expires_at || !a.checkout_snapshot_digest) return { status: 400, body: err("invalid_allowance", "max_amount, currency, checkout_session_id, merchant_id, expires_at and checkout_snapshot_digest are required") };
    if (new Date(a.expires_at) <= new Date()) return { status: 400, body: err("invalid_allowance", "expires_at is in the past") };
    if (pm?.type !== "card" || !cards.has(pm.token)) return { status: 402, body: err("invalid_payment_method", "unknown card token") };
    const t: DelegatedToken = { id: "vt_" + randomHex(12), created: new Date().toISOString(), status: "active", allowance: { ...a }, metadata: { ...(body.metadata ?? {}) }, paymentMethod: pm.token };
    tokens.set(t.id, t);
    return { status: 201, body: { id: t.id, created: t.created, metadata: t.metadata } };
  }

  function charge(merchant: string | undefined, body: any): { status: number; body: unknown } {
    if (!merchant) return { status: 401, body: err("unauthenticated", "merchant API key required") };
    const t = tokens.get(body?.token);
    if (!t) return { status: 404, body: err("no_such_token", "unknown delegated token") };
    const a = t.allowance;
    if (a.merchant_id !== merchant || body.merchant_id !== merchant) return { status: 403, body: err("merchant_mismatch", "token is not delegated to this merchant") };
    if (body.checkout_session_id !== a.checkout_session_id) return { status: 403, body: err("checkout_session_mismatch", "token is bound to another checkout session") };
    if (t.status === "used") return { status: 409, body: err("token_already_used", "one-time token has already been charged") };
    if (new Date(a.expires_at) <= new Date()) return { status: 403, body: err("token_expired", "allowance expired") };
    if (String(body.currency).toLowerCase() !== a.currency.toLowerCase()) return { status: 403, body: err("currency_mismatch", `allowance is in ${a.currency}`) };
    if (body.checkout_snapshot_digest !== a.checkout_snapshot_digest) return { status: 403, body: err("checkout_snapshot_mismatch", "the checkout session changed after this payment was authorized") };
    if (!Number.isInteger(body.amount) || body.amount <= 0) return { status: 400, body: err("invalid_amount", "amount must be a positive integer") };
    if (body.amount > a.max_amount) return { status: 402, body: err("amount_exceeds_allowance", `${body.amount} > max_amount ${a.max_amount}`) };
    const card = cards.get(t.paymentMethod)!;
    if (declines > 0) { declines--; return { status: 402, body: err("card_declined", "issuer declined") }; }
    if (card.spent + body.amount > card.limit) return { status: 402, body: err("card_declined", "insufficient_funds") };
    card.spent += body.amount;
    const c: Charge = { id: "ch_" + randomHex(10), token: t.id, amount: body.amount, currency: a.currency, merchant_id: merchant, checkout_session_id: a.checkout_session_id, status: "succeeded", amount_refunded: 0, created: new Date().toISOString() };
    charges.set(c.id, c);
    t.status = "used"; t.chargeId = c.id;
    merchantBalances.set(merchant, (merchantBalances.get(merchant) ?? 0) + c.amount);
    return { status: 200, body: c };
  }

  function refund(merchant: string | undefined, body: any): { status: number; body: unknown } {
    if (!merchant) return { status: 401, body: err("unauthenticated", "merchant API key required") };
    const c = charges.get(body?.charge_id);
    if (!c || c.merchant_id !== merchant) return { status: 404, body: err("no_such_charge", "unknown charge") };
    if (refundFailures > 0) { refundFailures--; return { status: 502, body: err("provider_unavailable", "refund could not be processed, retry later") }; }
    const amount = body.amount ?? c.amount - c.amount_refunded;
    if (!Number.isInteger(amount) || amount <= 0 || c.amount_refunded + amount > c.amount) return { status: 400, body: err("invalid_amount", "refund exceeds the charge") };
    c.amount_refunded += amount;
    cards.get(tokens.get(c.token)!.paymentMethod)!.spent -= amount;
    merchantBalances.set(merchant, (merchantBalances.get(merchant) ?? 0) - amount);
    return { status: 200, body: { id: "re_" + randomHex(8), charge_id: c.id, amount, status: "succeeded" } };
  }

  /** Replay a stored response for a repeated Idempotency-Key; refuse the key for a different request. */
  function idempotent(scope: string, key: string | undefined, body: unknown, run: () => { status: number; body: unknown }) {
    if (!key) return run();
    const k = `${scope}:${key}`;
    const request = canonicalJson(body);
    const prior = acpIdem.get(k);
    if (prior) return prior.request === request ? prior : { status: 409, body: err("idempotency_conflict", "Idempotency-Key reused for a different request") };
    const out = run();
    // Declines are not stored: the same key may be retried once the issuer accepts.
    if (out.status < 500 && (out.body as { code?: string })?.code !== "card_declined") acpIdem.set(k, { request, ...out });
    return out;
  }

  const srv = await serve(async (req, res) => {
    const u = new URL(req.url, "http://x");
    const body = req.body ? JSON.parse(req.body) : {};
    const key = req.headers["idempotency-key"] as string | undefined;
    if (req.method === "POST" && u.pathname === "/payment_intents") {
      const id = "pi_" + randomBytes(10).toString("hex");
      const it: Intent = { id, amount: body.amount, currency: body.currency, merchant: body.merchant, resource: body.resource, status: "requires_confirmation", createdAt: Date.now() };
      intents.set(id, it);
      return json(res, 200, it);
    }
    const confirm = u.pathname.match(/^\/payment_intents\/(pi_\w+)\/confirm$/);
    if (req.method === "POST" && confirm) {
      if (key && idem.has(key)) return json(res, 200, idem.get(key));
      const it = intents.get(confirm[1]);
      if (!it) return json(res, 404, { error: "no_such_intent" });
      if (it.status === "succeeded") return json(res, 200, it);
      const card = cards.get(body.paymentMethod);
      if (!card) return json(res, 402, { error: "card_declined", decline_code: "invalid_token" });
      if (card.spent + it.amount > card.limit) { it.status = "failed"; return json(res, 402, { error: "card_declined", decline_code: "insufficient_funds" }); }
      card.spent += it.amount; it.status = "succeeded"; it.paymentMethod = body.paymentMethod;
      merchantBalances.set(it.merchant, (merchantBalances.get(it.merchant) ?? 0) + it.amount);
      if (key) idem.set(key, it);
      return json(res, 200, it);
    }
    const get = u.pathname.match(/^\/payment_intents\/(pi_\w+)$/);
    if (req.method === "GET" && get) {
      const it = intents.get(get[1]);
      return it ? json(res, 200, it) : json(res, 404, { error: "no_such_intent" });
    }
    if (req.method === "POST" && u.pathname === "/cards") { cards.set(body.token, { limit: body.limit, spent: 0 }); return json(res, 200, { ok: true }); }

    // ------------------------------------------------ delegated payment (ACP-style)
    const merchant = merchantOf(req.headers.authorization);
    let out: { status: number; body: unknown } | undefined;
    if (req.method === "POST" && u.pathname === "/agentic_commerce/delegate_payment") out = idempotent("delegate", key, body, () => delegate(body));
    else if (req.method === "POST" && u.pathname === "/agentic_commerce/charges") out = idempotent(`charge:${merchant}`, key, body, () => charge(merchant, body));
    else if (req.method === "POST" && u.pathname === "/agentic_commerce/refunds") out = idempotent(`refund:${merchant}`, key, body, () => refund(merchant, body));
    else if (req.method === "GET" && u.pathname === "/agentic_commerce/delegated_tokens") {
      const session = u.searchParams.get("checkout_session_id");
      out = { status: 200, body: { data: [...tokens.values()].filter((t) => t.allowance.checkout_session_id === session).map(publicToken) } };
    } else {
      const one = u.pathname.match(/^\/agentic_commerce\/delegated_tokens\/(vt_\w+)$/);
      if (req.method === "GET" && one) { const t = tokens.get(one[1]); out = t ? { status: 200, body: publicToken(t) } : { status: 404, body: err("no_such_token", one[1]) }; }
    }
    if (out) return json(res, out.status, out.body);
    json(res, 404, { error: "not_found" });
  });
  return Object.assign(srv, {
    intents, cards, merchantBalances, tokens, charges,
    registerMerchant: (id: string) => { const k = "sk_sim_" + randomHex(12); merchantKeys.set(k, id); return k; },
    declineNextCharges: (n = 1) => { declines = n; },
    failNextRefunds: (n = 1) => { refundFailures = n; },
  });
}
