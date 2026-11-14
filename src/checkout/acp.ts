/**
 * ACP-style checkout objects, shared by the simulated merchant
 * (src/payments/sim/acpMerchant.ts), the buyer-side adapter (./adapter.ts)
 * and the gateway (src/gateway/checkoutBinding.ts).
 *
 * ACP-STYLE, MODELLED ON THE PUBLIC DESCRIPTION of the Agentic Commerce
 * Protocol (checkout sessions + delegated payment). Field names follow that
 * description as closely as this prototype needs, but nothing here has been
 * tested against the specification or another implementation. Verify against
 * the current specification before interoperating; this is not a conformance
 * claim.
 *
 * Amounts are integers in minor units (EUR cents). ACP lower-cases currency
 * codes ("eur"); the rest of this code base uses upper case ("EUR"), so values
 * are converted at the boundary (see `currencyOf`).
 */
import { digestOf } from "../util/crypto.js";

export const IDEMPOTENCY_HEADER = "idempotency-key";

export type CheckoutStatus = "not_ready_for_payment" | "ready_for_payment" | "completed" | "canceled";
export type TotalType = "items_base_amount" | "items_discount" | "subtotal" | "discount" | "fulfillment" | "tax" | "fee" | "total";

/** ACP address shape. The buyer's copy lives in the Pod as schema:PostalAddress (src/pod/address.ts). */
export interface AcpAddress { name: string; line_one: string; line_two?: string; city: string; state?: string; country: string; postal_code: string }

export interface AcpLineItem { id: string; item: { id: string; quantity: number }; base_amount: number; discount: number; subtotal: number; tax: number; total: number }
export interface AcpFulfillmentOption { type: "shipping"; id: string; title: string; subtitle?: string; carrier?: string; subtotal: number; tax: number; total: number }
export interface AcpTotal { type: TotalType; display_text: string; amount: number }
export interface AcpMessage { type: "info" | "error"; code?: string; content: string }

export interface AcpCheckoutSession {
  id: string;
  status: CheckoutStatus;
  currency: string;                         // lower case, e.g. "eur"
  line_items: AcpLineItem[];
  fulfillment_address?: AcpAddress;
  fulfillment_options: AcpFulfillmentOption[];
  fulfillment_option_id?: string;
  totals: AcpTotal[];
  payment_provider: { provider: string; supported_payment_methods: string[] };
  messages: AcpMessage[];
  links: Array<{ type: string; url: string }>;
  order?: { id: string; checkout_session_id: string; permalink_url: string };
}

/**
 * Product feed entry. The `shipping` rates per country mirror the feed's
 * shipping attribute, so a buyer can estimate the delivered total WITHOUT
 * sending its address to every shop it compares.
 */
export interface AcpProduct {
  id: string;
  title: string;
  category: string;                         // sc: category local name, e.g. "Shoes"
  price: { amount: number; currency: string };
  properties: Record<string, string>;       // e.g. { solesReplaceable: "true" }
  shipping: Array<{ country: string; service: string; price: number }>;
  availability: "in_stock" | "out_of_stock";
}

export interface AcpProductFeed { merchant: { id: string; webId: string; name: string }; products: AcpProduct[] }

/**
 * Simulation-only order view (ACP itself reports order updates to the agent via webhooks).
 * "canceled" without a refund: the buyer canceled and the refund has not gone through
 * yet (repeating the cancellation retries it). "refunded": canceled before shipment and
 * refunded. "returned": refunded after the goods were shipped.
 */
export type OrderStatus = "created" | "shipped" | "delivered" | "canceled" | "refunded" | "returned";
export interface AcpOrder {
  id: string;
  checkout_session_id: string;
  status: OrderStatus;
  line_items: Array<{ id: string; quantity: number }>;
  total: number;
  currency: string;
  charge_id: string;
  refund?: { id: string; amount: number };
  events: Array<{ status: OrderStatus; at: string; detail?: string }>;
  permalink_url: string;
}

/**
 * Delegated payment allowance (modelled on ACP's delegate_payment).
 * `checkout_snapshot_digest` is an EXTENSION of this prototype, not an ACP
 * field: the digest of the session snapshot the gateway authorized
 * (`snapshotDigest`). The merchant states the digest of the session it is
 * charging for and the PSP refuses the charge unless the two match, so a
 * session re-addressed or re-itemized after authorization cannot be paid with
 * this token.
 */
export interface Allowance { reason: "one_time"; max_amount: number; currency: string; checkout_session_id: string; merchant_id: string; expires_at: string; checkout_snapshot_digest: string }

/** The scheme-specific challenge for "acp-delegated": what the signer is allowed to delegate payment for. */
export interface CheckoutChallenge { checkout_session_id: string; merchant_id: string; provider: string; snapshot_digest: string }

export const totalOf = (s: AcpCheckoutSession, type: TotalType) => s.totals.find((t) => t.type === type)?.amount;
export const currencyOf = (s: AcpCheckoutSession) => s.currency.toUpperCase();
export const sessionUrl = (apiBase: string, id: string) => `${apiBase}/checkout_sessions/${encodeURIComponent(id)}`;

/**
 * The parts of a session that money and delivery depend on. The gateway binds
 * its authorization to this digest, and the delegated token carries it to the
 * point of payment (see `Allowance`). Messages and links are left out: they
 * carry no terms.
 */
export function snapshotOf(s: AcpCheckoutSession) {
  return {
    id: s.id, status: s.status, currency: s.currency,
    line_items: s.line_items, fulfillment_address: s.fulfillment_address ?? null,
    fulfillment_option: s.fulfillment_options.find((o) => o.id === s.fulfillment_option_id) ?? null,
    totals: s.totals, payment_provider: s.payment_provider,
  };
}
export const snapshotDigest = (s: AcpCheckoutSession) => digestOf(snapshotOf(s));

/**
 * What the signer returns for "acp-delegated": a single-use token id, not an
 * HTTP header. The card token it was minted from never leaves the signer.
 */
export interface DelegatedCredential { scheme: "acp-delegated"; token: string; provider: string; railReference: string }

/** Line items as (product id, quantity), order-independent. */
export const itemsKey = (items: Array<{ id: string; quantity: number }>) =>
  items.map((i) => `${i.id}x${i.quantity}`).sort().join(",");
