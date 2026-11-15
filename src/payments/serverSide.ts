/**
 * Server side of HTTP 402: building the multi-scheme challenge and checking a
 * presented credential, for x402 v2, L402-style and card/PSP payments.
 *
 * This is the payment logic a seller needs and nothing else. It knows nothing
 * about routes, upstreams or receipts. src/proxy/ puts it in front of any HTTP
 * API; src/seller/ is just that proxy in front of a plain weather API.
 *
 * Money-safety rules enforced here:
 *   - A credential only counts for the offer it was bought from (offer id and
 *     resource) and at a price the seller set:
 *       x402 and card must match the CURRENT offer's amount and payee at first
 *       redemption (x402 moves no money before that; card is checked against
 *       the offer because anyone can create an intent naming the merchant);
 *       an L402 token is honoured at the price its seller-signed macaroon
 *       states, because the buyer has already paid that invoice, and the
 *       invoice could only be paid before it expired.
 *     A credential that was already settled is honoured whatever the price is now.
 *   - Each payment is bound to exactly one Binding (resource + request target)
 *     in the SettlementBook. Presenting it for anything else is refused, with
 *     one exception: a payment never delivered because the upstream refused its
 *     target outright (e.g. 404) may move to another target of the same resource.
 *   - Re-presenting a settled credential never settles again. For a safe request
 *     (GET) it re-delivers; for any other method one payment buys one delivery,
 *     after which the credential is consumed (SettlementBook.tryStartDelivery).
 *     Concurrent presentations of one x402 credential are serialised, so there
 *     is at most one verify/settle in flight per credential.
 *   - A settlement whose outcome is unknown keeps its claim, so a retry with
 *     the same credential can confirm it on the rail instead of paying again.
 *     "Unknown" includes a rail that cannot be asked: only a positive "not
 *     used" from the rail releases a claim.
 */
import { getAddress } from "viem";
import type { Offer, PriceOption } from "../model.js";
import { offerDigest } from "../trust/registry.js";
import { b64json, postJson } from "../util/http.js";
import type { OfferRef } from "./types.js";
import { OFFER_LINK_REL } from "./types.js";
import {
  buildPaymentRequired, DEFAULT_NETWORK, DEFAULT_USDC, HEADER_REQUIRED, HEADER_RESPONSE, HEADER_SIGNATURE,
  type PaymentPayload, type PaymentRequirements, type SettleResponse,
} from "./schemes/x402.js";
import { invoiceExpiresAt, l402Challenge, mintMacaroon, verifyL402 } from "./schemes/l402.js";
import { paymentChallenge } from "./schemes/cardPsp.js";
import type { SchemeId } from "../model.js";

export interface RailUrls { facilitatorUrl: string; lightningUrl: string; pspUrl: string }
/** Who gets paid on each rail. */
export interface Payees { payTo: string; lightningPayee: string; merchantId: string }
/** x402 in USDC major units ("0.02"), l402 in sats, card in euro cents. */
export interface SchemePrices { x402?: string; l402?: number; cardEur?: number }
export interface X402Asset { network: string; asset: string }

export function priceOptionsFor(prices: SchemePrices, payees: Payees, x402: X402Asset = { network: DEFAULT_NETWORK, asset: DEFAULT_USDC }): PriceOption[] {
  const out: PriceOption[] = [];
  if (prices.x402) {
    const atomic = BigInt(Math.round(Number(prices.x402) * 1e6)).toString();
    out.push({ scheme: "x402", amount: atomic, currency: "USDC", network: x402.network, asset: x402.asset, payTo: getAddress(payees.payTo) });
  }
  if (prices.l402) out.push({ scheme: "l402", amount: String(prices.l402), currency: "SAT", merchantId: payees.lightningPayee, payTo: payees.lightningPayee });
  if (prices.cardEur) out.push({ scheme: "card-psp", amount: String(prices.cardEur), currency: "EUR", merchantId: payees.merchantId, payTo: payees.merchantId });
  return out;
}

export const offerRefOf = (o: Offer): OfferRef => ({ offerId: o.offerId, version: o.version, digest: offerDigest(o) });

export function x402RequirementsFor(o: Offer): PaymentRequirements | undefined {
  const p = o.prices.find((x) => x.scheme === "x402");
  return p && { scheme: "exact", network: p.network!, asset: p.asset!, amount: p.amount, payTo: p.payTo!, maxTimeoutSeconds: 120, extra: { name: "USDC", version: "2" } };
}

// ------------------------------------------------------------------ settlement book

/**
 * What one payment unlocks: the offer's resource and the concrete request
 * target (method, path and query). For an exact route both name the same
 * thing; for a prefix route the target pins the payment to the first path it
 * was redeemed for, so one payment cannot unlock every path under the prefix.
 */
export interface Binding { resource: string; target: string }
const sameBinding = (a: Binding, b: Binding) => a.resource === b.resource && a.target === b.target;

export interface Settlement {
  /** The SettlementBook key: scheme plus the payment's identity on its rail. */
  key: string;
  scheme: SchemeId;
  railReference: string;
  amount: string;
  currency: string;
  offerId: string;
  offerVersion: number;
  binding: Binding;
  /** Absent while the rail outcome is unknown (claimed, not yet confirmed). */
  settledAt?: string;
  settleResponse?: SettleResponse;
}

/**
 * How the upstream answered a paid request: content ("delivered"), a
 * definitive refusal of that target that a retry would repeat ("refused",
 * e.g. 404), or a failure a retry may fix ("transient", e.g. 503).
 */
export type DeliveryOutcome = "delivered" | "refused" | "transient";

const ELSEWHERE = "elsewhere";

/**
 * Payments this seller has claimed or settled, keyed per scheme and rail
 * reference. A claim is taken BEFORE money can move, so a lost settlement
 * response can later be attributed to the right binding.
 *
 * In memory, like the signer's idempotency state. After a restart each scheme
 * still recognises its settled credentials on the rail (x402 via
 * authorization-state, L402 via the preimage, card via the intent) and L402 and
 * card stay bound to their resource, but the target bindings are forgotten and
 * x402 falls back to its unsigned resource field. Persist this to make the
 * binding durable.
 */
export class SettlementBook {
  private entries = new Map<string, Settlement>();
  private deliveries = new Map<string, { inFlight: number; delivered: boolean; refused: boolean }>();
  get(key: string) { return this.entries.get(key); }

  /**
   * The entry `key` holds, as seen by a request for `binding`: the entry itself, nothing, or
   * "elsewhere" when it is bound to something else.
   *
   * A settled payment that never delivered anything, because the upstream refused its target
   * outright, moves to the new target of the same resource. Otherwise a buyer who paid for
   * /stations/typo and got 404 would hold a payment that can never deliver. It moves only while
   * no delivery is in flight for it, so one payment still yields content for at most one target.
   */
  lookup(key: string, binding: Binding): Settlement | typeof ELSEWHERE | undefined {
    const e = this.entries.get(key);
    if (!e) return undefined;
    if (sameBinding(e.binding, binding)) return e;
    const d = this.deliveries.get(key);
    if (e.settledAt && e.binding.resource === binding.resource && d && d.refused && !d.delivered && d.inFlight === 0) {
      e.binding = { ...binding };
      d.refused = false;
      return e;
    }
    return ELSEWHERE;
  }
  /** Take (or re-enter) the claim for `s.binding`. Undefined if the key is bound to something else. */
  claim(key: string, s: Settlement): Settlement | undefined {
    const prior = this.lookup(key, s.binding);
    if (prior === ELSEWHERE) return undefined;
    if (prior) return prior;
    this.entries.set(key, s);
    return s;
  }
  /** Drop a claim whose credential provably moved no money. */
  release(key: string) { if (!this.entries.get(key)?.settledAt) { this.entries.delete(key); this.deliveries.delete(key); } }
  /**
   * Mark settled. The stored entry is used only if it is the claimant's own binding; anything else
   * stored under the key is replaced, so a settlement can never be credited to another binding.
   */
  settle(key: string, claimed: Settlement, settleResponse?: SettleResponse): Settlement {
    const stored = this.entries.get(key);
    const e = stored && sameBinding(stored.binding, claimed.binding) ? stored : claimed;
    this.entries.set(key, e);
    e.settledAt ??= new Date().toISOString();
    e.settleResponse ??= settleResponse;
    return e;
  }
  deliveryStarted(key: string) {
    const d = this.deliveries.get(key) ?? { inFlight: 0, delivered: false, refused: false };
    d.inFlight++;
    this.deliveries.set(key, d);
  }
  /**
   * Start a delivery for a payment. A repeatable (safe, e.g. GET) request may re-deliver any number
   * of times. A request that is not (e.g. POST, whose body the buyer chooses each time) gets one
   * delivery per payment: once one delivered, the payment is "consumed", and while one is in flight
   * another is "busy", since it may yet deliver. A transient failure that delivered nothing leaves
   * the payment usable, so the buyer can retry with the same credential.
   */
  tryStartDelivery(key: string, repeatable: boolean): "started" | "consumed" | "busy" {
    const d = this.deliveries.get(key);
    if (!repeatable && d?.delivered) return "consumed";
    if (!repeatable && d && d.inFlight > 0) return "busy";
    this.deliveryStarted(key);
    return "started";
  }
  deliveryEnded(key: string, outcome: DeliveryOutcome) {
    const d = this.deliveries.get(key);
    if (!d) return;
    d.inFlight--;
    if (outcome === "delivered") d.delivered = true;
    d.refused = outcome === "refused" && !d.delivered;
  }
  get size() { return [...this.entries.values()].filter((e) => e.settledAt).length; }
}

// ------------------------------------------------------------------ acceptor

export type Acceptance =
  /** No payment credential on the request. */
  | { kind: "none" }
  /** Paid (now or earlier) for exactly this binding. */
  | { kind: "paid"; settlement: Settlement; responseHeaders: Record<string, string> }
  /** Credential refused; nothing was charged. 402 means "pay again", 400 means "malformed". */
  | { kind: "rejected"; status: 400 | 402; reason: string }
  /** The rail failed or its answer was lost. The client should retry with the SAME credential. */
  | { kind: "failed"; status: 502; body: Record<string, unknown> };

export interface PaymentAcceptorConfig { rails: RailUrls; payees: Payees; macaroonRootKey: string; book?: SettlementBook }

/** Request headers relevant to payment, lower-case names as Node delivers them. */
type Headers = Record<string, string | string[] | undefined>;
const header = (h: Headers, name: string) => { const v = h[name]; return Array.isArray(v) ? v[0] : v; };

/** Headers that only ever carry a payment credential (x-payment is x402 v1, stripped defensively). */
export const PAYMENT_HEADERS: readonly string[] = [HEADER_SIGNATURE, "x-payment"];
/** An Authorization value that is a payment credential rather than the API's own auth. */
export const isPaymentAuthorization = (v: string) => /^(L402|Payment)\s/i.test(v);

/** An EIP-3009 nonce: a bytes32 as 0x-prefixed hex, either letter case. */
const NONCE = /^0x[0-9a-fA-F]{64}$/;
const BOUND_ELSEWHERE: Acceptance = { kind: "rejected", status: 402, reason: "credential is bound to another resource" };
/** Money may have moved. Never "pay again": the same credential confirms it later. */
const outcomeUnknown = (error: string): Acceptance =>
  ({ kind: "failed", status: 502, body: { error, paid: "unknown", retry: "re-present the same payment credential" } });

export class PaymentAcceptor {
  readonly book: SettlementBook;
  /** The one verify/settle in flight per x402 credential (see acceptX402). */
  private x402Flights = new Map<string, Promise<Acceptance>>();
  constructor(private readonly cfg: PaymentAcceptorConfig) { this.book = cfg.book ?? new SettlementBook(); }

  /** Headers and JSON body of an HTTP 402 offering every scheme priced in the offer. */
  async challenge(o: Offer, description: string, error?: string): Promise<{ headers: Record<string, string>; body: Record<string, unknown> }> {
    const ref = offerRefOf(o);
    const headers: Record<string, string> = { link: `<${o.offerId}>; rel="${OFFER_LINK_REL}"`, "sc-offer": JSON.stringify(ref) };
    const reqs = x402RequirementsFor(o);
    if (reqs) headers[HEADER_REQUIRED] = b64json.encode(buildPaymentRequired(o.resource, reqs, ref, description));
    const challenges: string[] = [];
    const l = o.prices.find((p) => p.scheme === "l402");
    if (l) {
      const inv = await postJson(this.cfg.rails.lightningUrl + "/invoices", { amountSat: Number(l.amount), payee: this.cfg.payees.lightningPayee, memo: o.offerId });
      const mac = mintMacaroon(this.cfg.macaroonRootKey, { paymentHash: inv.body.paymentHash, resource: o.resource, amountSat: Number(l.amount), expiresAt: invoiceExpiresAt(inv.body.paymentRequest), offerId: o.offerId, offerVersion: o.version });
      challenges.push(l402Challenge(mac, inv.body.paymentRequest));
    }
    const c = o.prices.find((p) => p.scheme === "card-psp");
    if (c) {
      const pi = await postJson(this.cfg.rails.pspUrl + "/payment_intents", { amount: Number(c.amount), currency: c.currency, merchant: this.cfg.payees.merchantId, resource: o.resource });
      challenges.push(paymentChallenge({ id: pi.body.id, amount: Number(c.amount), currency: c.currency, merchant: this.cfg.payees.merchantId, provider: this.cfg.rails.pspUrl }));
    }
    if (challenges.length) headers["www-authenticate"] = challenges.join(", ");
    return { headers, body: { error: error ?? "payment_required", offer: ref, accepts: o.prices.map((p) => p.scheme) } };
  }

  /** Check the credential on a request against the current offer and the binding it asks for. */
  async accept(h: Headers, o: Offer, binding: Binding): Promise<Acceptance> {
    const x402 = header(h, HEADER_SIGNATURE);
    const auth = header(h, "authorization") ?? "";
    if (x402) return this.acceptX402(x402, o, binding);
    if (/^L402\s/i.test(auth)) return this.acceptL402(auth, o, binding);
    if (/^Payment\s/i.test(auth)) return this.acceptCard(auth, o, binding);
    return { kind: "none" };
  }

  private bound(key: string, s: Settlement): { ok: true; entry: Settlement } | { ok: false; refusal: Acceptance } {
    const entry = this.book.claim(key, s);
    return entry ? { ok: true, entry } : { ok: false, refusal: BOUND_ELSEWHERE };
  }
  private paid(key: string, claimed: Settlement, settleResponse?: SettleResponse): Acceptance {
    const s = this.book.settle(key, claimed, settleResponse);
    return { kind: "paid", settlement: s, responseHeaders: s.settleResponse ? { [HEADER_RESPONSE]: b64json.encode(s.settleResponse) } : {} };
  }

  /**
   * x402 needs several rail calls between claim and settlement. Presentations of one credential
   * are serialised: each waits for the one in flight and then sees its outcome in the book. So a
   * concurrent retry can never release a claim whose /settle is still running, and the
   * facilitator sees at most one verify/settle per credential at a time.
   */
  private async acceptX402(value: string, o: Offer, binding: Binding): Promise<Acceptance> {
    let payload: PaymentPayload, key: string, nonce: string;
    try {
      payload = b64json.decode<PaymentPayload>(value);
      const raw: unknown = payload.payload.authorization.nonce;
      // An EIP-3009 nonce is a bytes32: its hex spelling is not part of its identity on chain, and the
      // EIP-712 signature verifies whatever the letter case. One canonical (lower-case) form keys the
      // book, the rail reference and the rail query, so a re-cased nonce is the same payment.
      if (typeof raw !== "string" || !NONCE.test(raw)) throw new Error("nonce is not a bytes32");
      nonce = raw.toLowerCase();
      key = `x402:${getAddress(payload.payload.authorization.from)}:${nonce}`;
    } catch { return { kind: "rejected", status: 400, reason: "malformed_payment" }; }
    for (let f = this.x402Flights.get(key); f; f = this.x402Flights.get(key)) await f.catch(() => undefined);
    const run = this.settleX402(key, nonce, payload, o, binding);
    this.x402Flights.set(key, run);
    try { return await run; } finally { if (this.x402Flights.get(key) === run) this.x402Flights.delete(key); }
  }

  private async settleX402(key: string, nonce: string, payload: PaymentPayload, o: Offer, binding: Binding): Promise<Acceptance> {
    const ref = nonce;
    const prior = this.book.lookup(key, binding);
    if (prior === ELSEWHERE) return BOUND_ELSEWHERE;
    if (prior?.settledAt) return this.paid(key, prior); // already paid: re-deliver, never re-charge
    if (prior) {
      // An earlier attempt for this binding claimed it but never learned the outcome: ask the rail
      // first, so a price change since then cannot turn a settled payment into "pay again".
      const state = await this.authorizationState(payload, nonce);
      if (state === "used") return this.paid(key, prior);
      if (state === "unknown") return outcomeUnknown("payment_state_unknown");
      // Provably unpaid: start over against the current offer (re-claimed synchronously below).
      this.book.release(key);
    }

    const reqs = x402RequirementsFor(o);
    const a = payload.accepted;
    // payload.resource is not covered by the EIP-712 signature; checking it catches honest
    // mistakes, while the claim below is what stops one payment unlocking two resources.
    let matches: boolean;
    try { matches = Boolean(reqs) && a?.amount === reqs!.amount && getAddress(a.payTo) === getAddress(reqs!.payTo) && a.network === reqs!.network && (!payload.resource?.url || payload.resource.url === o.resource); }
    catch { return { kind: "rejected", status: 400, reason: "malformed_payment" }; }
    if (!matches) return { kind: "rejected", status: 402, reason: "Payment does not match the current offer" };
    const claim = this.bound(key, { key, scheme: "x402", railReference: ref, amount: reqs!.amount, currency: "USDC", offerId: o.offerId, offerVersion: o.version, binding });
    if (!claim.ok) return claim.refusal;
    const entry = claim.entry;

    const body = { x402Version: 2, paymentPayload: payload, paymentRequirements: reqs };
    const v = await postJson(this.cfg.rails.facilitatorUrl + "/verify", body).catch(() => undefined);
    // /verify moves no money; the claim stays so the retry asks the token before starting over.
    if (!v) return { kind: "failed", status: 502, body: { error: "facilitator_unavailable", paid: false, retry: "re-present the same payment credential" } };
    if (!v.body?.isValid) {
      // Every other check passed but the nonce is spent: a concurrent request or an earlier
      // settlement with a lost response moved the money. Confirm on the token, never re-charge.
      // If the token does not confirm it, the two rail answers disagree: hold, do not release.
      if (v.body?.invalidReason === "nonce_already_used") return (await this.authorizationState(payload, nonce)) === "used" ? this.paid(key, entry) : outcomeUnknown("payment_state_unknown");
      this.book.release(key);
      return { kind: "rejected", status: 402, reason: `Payment invalid: ${v.body?.invalidReason}` };
    }
    let s: { status: number; body: SettleResponse };
    try { s = await postJson<SettleResponse>(this.cfg.rails.facilitatorUrl + "/settle", body); }
    catch { return outcomeUnknown("settlement_unavailable"); } // funds may have moved: keep the claim
    if (s.body?.success) return this.paid(key, entry, s.body);
    // A failed /settle (an error status, or nonce_already_used) does not prove the transfer did not
    // happen: the facilitator may have broadcast it. Only the token's own state decides.
    const state = await this.authorizationState(payload, nonce);
    if (state === "used") return this.paid(key, entry);
    if (state === "unknown") return outcomeUnknown("settlement_unavailable");
    this.book.release(key);
    return { kind: "failed", status: 502, body: { error: "settlement_failed", paid: false, reason: s.body?.errorReason } };
  }

  /**
   * The token contract's authorizationState(), via the facilitator. Anything but a well-formed
   * answer is "unknown": a timeout or a 5xx says nothing about whether the transfer happened.
   */
  private async authorizationState(p: PaymentPayload, nonce: string): Promise<"used" | "unused" | "unknown"> {
    try {
      const q = new URLSearchParams({ authorizer: getAddress(p.payload.authorization.from), nonce });
      const r = await fetch(`${this.cfg.rails.facilitatorUrl}/authorization-state?${q}`);
      if (!r.ok) return "unknown";
      const used = ((await r.json()) as { used?: unknown }).used;
      return used === true ? "used" : used === false ? "unused" : "unknown";
    } catch { return "unknown"; }
  }

  private acceptL402(auth: string, o: Offer, binding: Binding): Acceptance {
    // The macaroon names the offer and resource it was minted for, so a token bought from another
    // offer (e.g. a cheaper route) fails here. Its price is the one the seller signed into it.
    const v = verifyL402(this.cfg.macaroonRootKey, auth, o.resource);
    if (!v.ok) return { kind: "rejected", status: 402, reason: `L402 rejected: ${v.reason}` };
    if (v.caveats.offerId !== o.offerId) return { kind: "rejected", status: 402, reason: "L402 rejected: wrong_offer" };
    const key = `l402:${v.caveats.paymentHash}`;
    // The preimage is the proof of payment: nothing to settle, only to bind.
    const claim = this.bound(key, { key, scheme: "l402", railReference: v.caveats.paymentHash, amount: String(v.caveats.amountSat), currency: "SAT", offerId: v.caveats.offerId, offerVersion: v.caveats.offerVersion, binding });
    return claim.ok ? this.paid(key, claim.entry) : claim.refusal;
  }

  private async acceptCard(auth: string, o: Offer, binding: Binding): Promise<Acceptance> {
    let id: string;
    try { id = (JSON.parse(Buffer.from(auth.slice(8).trim(), "base64url").toString()) as { id: string }).id; }
    catch { return { kind: "rejected", status: 400, reason: "malformed_payment" }; }
    if (typeof id !== "string" || !/^pi_\w+$/.test(id)) return { kind: "rejected", status: 400, reason: "malformed_payment" };
    const key = `card-psp:${id}`;
    const prior = this.book.lookup(key, binding);
    if (prior === ELSEWHERE) return BOUND_ELSEWHERE;
    if (prior) return this.paid(key, prior);
    let intent: { status: string; merchant: string; resource: string; amount: number; currency: string };
    try {
      const r = await fetch(`${this.cfg.rails.pspUrl}/payment_intents/${id}`);
      if (r.status === 404) return { kind: "rejected", status: 402, reason: "unknown payment intent" };
      if (!r.ok) return outcomeUnknown("psp_unavailable");
      intent = await r.json() as typeof intent;
    } catch { return outcomeUnknown("psp_unavailable"); }
    // Anyone can create an intent naming this merchant, so the amount is checked against the
    // offer, not taken from the intent.
    const opt = o.prices.find((p) => p.scheme === "card-psp");
    if (intent.status !== "succeeded" || intent.merchant !== this.cfg.payees.merchantId || intent.resource !== o.resource || String(intent.amount) !== opt?.amount || intent.currency !== opt.currency) {
      return { kind: "rejected", status: 402, reason: "Payment intent not settled for this resource" };
    }
    const claim = this.bound(key, { key, scheme: "card-psp", railReference: id, amount: opt.amount, currency: opt.currency, offerId: o.offerId, offerVersion: o.version, binding });
    return claim.ok ? this.paid(key, claim.entry) : claim.refusal;
  }
}
