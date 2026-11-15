/**
 * Gateway checks for ACP-style checkout ("acp-delegated").
 *
 * There is no seller-signed offer to verify, so the gateway trusts none of
 * the agent's numbers. It fetches the checkout session itself, server to
 * server, from the merchant's PINNED API base URL in the trust registry, and
 * derives the amount, payee, items and shipping address from that. The
 * authorization is then bound to a digest of the session snapshot it read.
 *
 * These checks hold at the moment of authorization; the session can still be
 * updated afterwards (ACP allows updates until completion). What carries them
 * to the payment is the digest: it is part of the gateway-signed challenge,
 * the signer copies it into the delegated token's allowance, and the PSP
 * charges the token only for a completion whose snapshot has that digest (see
 * src/payments/sim/psp.ts for what that does and does not protect against).
 * One live authorization per session (Ledger.liveCheckout) keeps it to one token.
 *
 * Reconciliation asks the PSP, never the agent or the merchant, whether the
 * delegated token minted for an authorization was charged or refunded.
 */
import type { SpendingMandate } from "../model.js";
import type { PaymentOption, X402Terms } from "../payments/types.js";
import type { TrustRegistry } from "../trust/registry.js";
import type { PodClient } from "../pod/PodClient.js";
import type { PodLayout } from "../pod/layout.js";
import { readAddress, toAcpAddress } from "../pod/address.js";
import { canonicalJson } from "../util/crypto.js";
import {
  currencyOf, itemsKey, sessionUrl, snapshotDigest, totalOf, type AcpCheckoutSession, type AcpProductFeed, type CheckoutChallenge,
} from "../checkout/acp.js";

/** What the agent says it is paying for. Only the identifiers are taken from it; every term is re-read from the merchant. */
export interface CheckoutClaim { merchant: string; sessionId: string; lineItems: Array<{ id: string; quantity: number }> }

/**
 * The scheme-neutral facts an authorization is bound to. `railReference` is derived by the gateway
 * from the challenge or session it checked (x402 adds its nonce once the authorization id exists).
 */
export interface Binding { seller: string; offerId: string; offerVersion: number; offerDigest: string; resource: string; railReference?: string; x402?: X402Terms }

export type BindResult = { ok: true; binding: Binding } | { ok: false; status: number; code: string; reason: string };

const no = (status: number, code: string, reason: string): BindResult => ({ ok: false, status, code, reason });

async function getJson<T>(url: string): Promise<T | undefined> {
  try {
    const r = await fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(5000) });
    return r.ok ? ((await r.json()) as T) : undefined;
  } catch { return undefined; }
}

export async function bindCheckout(deps: { registry: TrustRegistry; pod: PodClient; layout: PodLayout }, m: SpendingMandate, c: CheckoutClaim | undefined, o: PaymentOption): Promise<BindResult> {
  if (!c?.merchant || !c.sessionId || !Array.isArray(c.lineItems)) return no(400, "BAD_REQUEST", "checkout claim (merchant, sessionId, lineItems) required");
  if (!m.allowedSellers.includes(c.merchant)) return no(403, "SELLER_NOT_IN_MANDATE", c.merchant);
  const merchant = deps.registry.getMerchant(c.merchant);
  if (!merchant) return no(403, "MERCHANT_NOT_APPROVED", `${c.merchant} is not an approved checkout merchant`);

  // Read the terms from the pinned merchant, not from the agent.
  const url = sessionUrl(merchant.apiBase, c.sessionId);
  const s = await getJson<AcpCheckoutSession>(url);
  if (!s || s.id !== c.sessionId) return no(409, "CHECKOUT_UNAVAILABLE", `could not read checkout session ${c.sessionId} from ${merchant.name}`);
  if (s.status !== "ready_for_payment") return no(409, "CHECKOUT_NOT_READY", `session is ${s.status}`);
  if (s.payment_provider?.provider !== merchant.paymentProvider) return no(409, "CHECKOUT_MISMATCH", "session names a payment provider that is not pinned for this merchant");
  if (itemsKey(s.line_items.map((li) => li.item)) !== itemsKey(c.lineItems)) return no(409, "CHECKOUT_MISMATCH", "session line items differ from the items the agent evaluated");

  // Category: from the merchant's own feed, so an agent cannot relabel a product to fit the mandate.
  const feed = await getJson<AcpProductFeed>(`${merchant.apiBase}/products`);
  if (!feed) return no(409, "CHECKOUT_UNAVAILABLE", "could not read the merchant's product feed");
  for (const li of s.line_items) {
    const p = feed.products.find((x) => x.id === li.item.id);
    if (!p || !m.targets.includes(p.category)) return no(403, "CATEGORY_NOT_AUTHORIZED", `${li.item.id}: ${p?.category ?? "unknown product"}`);
  }

  // The amount to authorize is the TOTAL including delivery and tax, and it must add up.
  const subtotal = totalOf(s, "subtotal"), fulfillment = totalOf(s, "fulfillment"), tax = totalOf(s, "tax") ?? 0, total = totalOf(s, "total");
  const option = s.fulfillment_options.find((f) => f.id === s.fulfillment_option_id);
  if (subtotal === undefined || total === undefined || fulfillment === undefined || !option || option.subtotal !== fulfillment) return no(409, "CHECKOUT_MISMATCH", "session total does not include a selected fulfilment option");
  if (subtotal + fulfillment + tax !== total) return no(409, "CHECKOUT_MISMATCH", "session totals do not add up");

  // Goods go to the user's address in the Pod, not one an agent put in the session
  // (after authorization, the snapshot digest in the token keeps it that way).
  const address = await readAddress(deps.pod, deps.layout.address());
  if (!address) return no(403, "NO_SHIPPING_ADDRESS", "no shipping address in the Pod");
  if (canonicalJson(s.fulfillment_address) !== canonicalJson(toAcpAddress(address))) return no(409, "ADDRESS_MISMATCH", "session ships to an address other than the user's");

  const digest = snapshotDigest(s);
  const ch = o.challenge as Partial<CheckoutChallenge> | undefined;
  if (o.amount !== String(total) || o.currency !== currencyOf(s) || ch?.snapshot_digest !== digest) {
    return no(409, "CHECKOUT_CHANGED", `merchant session now totals ${total} ${currencyOf(s)} (agent quoted ${o.amount} ${o.currency}); re-read and re-evaluate the checkout`);
  }
  const expected: CheckoutChallenge = { checkout_session_id: s.id, merchant_id: merchant.merchantId, provider: merchant.paymentProvider, snapshot_digest: digest };
  if (o.payTo !== merchant.merchantId || o.resource !== url || canonicalJson(ch) !== canonicalJson(expected)) return no(409, "CHECKOUT_MISMATCH", "payee, resource or challenge does not match the merchant's session");
  if (o.railReference !== undefined && o.railReference !== s.id) return no(409, "RAIL_REFERENCE_MISMATCH", "the option names a different checkout session than its challenge");
  return { ok: true, binding: { seller: merchant.webId, offerId: url, offerVersion: 0, offerDigest: digest, resource: url, railReference: s.id } };
}

export interface DelegatedTokenView { id: string; status: string; metadata: Record<string, string>; charge: { id: string; status: string; amount: number; amount_refunded: number } | null }

/**
 * The PSP's view of the token minted for one authorization (the signer tags it
 * with `metadata.authorization_id`). `undefined` means the PSP could not be asked.
 */
export async function delegatedPaymentState(pspUrl: string, checkoutSessionId: string, authId: string): Promise<{ token?: DelegatedTokenView } | undefined> {
  const out = await getJson<{ data: DelegatedTokenView[] }>(`${pspUrl}/agentic_commerce/delegated_tokens?checkout_session_id=${encodeURIComponent(checkoutSessionId)}`);
  return out && { token: out.data.find((t) => t.metadata?.authorization_id === authId) };
}
