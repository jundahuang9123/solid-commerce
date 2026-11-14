/**
 * Buyer-side adapter for shops that do not speak HTTP 402 but offer an
 * ACP-style checkout API with delegated payment (ACP-style, modelled on the
 * public description; verify against the current specification before
 * interoperating).
 *
 * It turns a merchant's product feed into offers the existing ranking can
 * evaluate, drives the checkout session to ready_for_payment, and then
 * synthesizes the same PaymentOption a 402 response would produce. From
 * there the gateway and signer are the only authority, exactly as for 402.
 *
 * Privacy: comparing shops uses feed data only (shipping rates per country).
 * The full shipping address is sent to one merchant, the one being checked
 * out with, and only after it was selected.
 */
import type { Offer } from "../model.js";
import type { PaymentOption } from "../payments/types.js";
import type { OfferLike } from "../agent/ranking.js";
import { postJson } from "../util/http.js";
import {
  IDEMPOTENCY_HEADER, currencyOf, sessionUrl, snapshotDigest, totalOf,
  type AcpAddress, type AcpCheckoutSession, type AcpOrder, type AcpProduct, type AcpProductFeed, type CheckoutChallenge, type DelegatedCredential,
} from "./acp.js";

/** A product from a checkout merchant, presented as an (unsigned) offer for ranking. */
export interface CheckoutCandidate extends OfferLike {
  product: AcpProduct;
  merchant: AcpProductFeed["merchant"];
  apiBase: string;
  /** Cheapest shipping to the buyer's country according to the feed; undefined if the shop does not ship there. */
  shippingEstimate?: number;
}

export type CompletionResult =
  | { kind: "completed"; session: AcpCheckoutSession }
  | { kind: "declined"; code: string; message: string }
  | { kind: "uncertain"; detail: string };

async function readJson<T>(url: string): Promise<T | undefined> {
  try { const r = await fetch(url, { headers: { accept: "application/json" } }); return r.ok ? ((await r.json()) as T) : undefined; } catch { return undefined; }
}

export class CheckoutAdapter {
  constructor(private readonly merchantApis: string[]) {}

  /** Read every merchant's feed. Offline merchants are skipped, as offline 402 sellers are. */
  async discover(category: string, country: string): Promise<CheckoutCandidate[]> {
    const out: CheckoutCandidate[] = [];
    for (const apiBase of this.merchantApis) {
      const feed = await readJson<AcpProductFeed>(`${apiBase}/products`);
      for (const product of feed?.products ?? []) {
        if (product.category !== category || product.availability !== "in_stock") continue;
        const rates = product.shipping.filter((s) => s.country === country).map((s) => s.price);
        const shippingEstimate = rates.length ? Math.min(...rates) : undefined;
        out.push({ payload: toOffer(product, feed!, apiBase, shippingEstimate), product, merchant: feed!.merchant, apiBase, shippingEstimate });
      }
    }
    return out;
  }

  /** Open a session with the items only: no personal data yet. */
  async open(c: CheckoutCandidate, quantity: number, idempotencyKey: string): Promise<AcpCheckoutSession | undefined> {
    const r = await postJson<AcpCheckoutSession>(`${c.apiBase}/checkout_sessions`, { items: [{ id: c.product.id, quantity }] }, { [IDEMPOTENCY_HEADER]: idempotencyKey });
    return r.status === 201 ? r.body : undefined;
  }

  /** Share the address with this merchant, then select the cheapest fulfilment option it offers. */
  async shipTo(apiBase: string, s: AcpCheckoutSession, address: AcpAddress): Promise<AcpCheckoutSession | undefined> {
    const withAddress = await this.update(apiBase, s.id, { fulfillment_address: address });
    const cheapest = withAddress?.fulfillment_options.slice().sort((a, b) => a.total - b.total)[0];
    return cheapest ? this.update(apiBase, s.id, { fulfillment_option_id: cheapest.id }) : withAddress;
  }

  read(apiBase: string, sessionId: string) { return readJson<AcpCheckoutSession>(sessionUrl(apiBase, sessionId)); }

  async cancel(apiBase: string, sessionId: string) { await postJson(`${sessionUrl(apiBase, sessionId)}/cancel`, {}).catch(() => undefined); }

  /** The internal payment decision point, as a 402 response would have produced it. */
  paymentOption(c: CheckoutCandidate, s: AcpCheckoutSession): PaymentOption {
    const challenge: CheckoutChallenge = { checkout_session_id: s.id, merchant_id: c.merchant.id, provider: s.payment_provider.provider, snapshot_digest: snapshotDigest(s) };
    return { scheme: "acp-delegated", amount: String(totalOf(s, "total")), currency: currencyOf(s), payTo: c.merchant.id, resource: sessionUrl(c.apiBase, s.id), challenge, railReference: s.id };
  }

  /**
   * Complete with the delegated token. Idempotency-Key = authId, so retries
   * after a lost response replay the merchant's stored result instead of
   * charging again (the PSP's one-time token is the second line of defence).
   */
  async complete(apiBase: string, sessionId: string, credential: DelegatedCredential, authId: string, retries = 2): Promise<CompletionResult> {
    let detail = "";
    for (let i = 0; i <= retries; i++) {
      try {
        const r = await postJson(`${sessionUrl(apiBase, sessionId)}/complete`, { payment_data: { token: credential.token, provider: credential.provider } }, { [IDEMPOTENCY_HEADER]: authId });
        if (r.status === 200 && r.body?.status === "completed") return { kind: "completed", session: r.body };
        if (r.status === 402) return { kind: "declined", code: r.body?.code ?? "payment_failed", message: r.body?.message ?? "" };
        detail = `merchant answered ${r.status} ${r.body?.code ?? ""}`;
        if (r.status < 500) break;
      } catch (e) { detail = `no response (${(e as Error).message})`; }
      await new Promise((res) => setTimeout(res, 50 * (i + 1)));
    }
    // The completion may have gone through even though we never heard back.
    const s = await this.read(apiBase, sessionId);
    return s?.status === "completed" ? { kind: "completed", session: s } : { kind: "uncertain", detail };
  }

  order(url: string) { return readJson<AcpOrder>(url); }
  /** Error bodies are ACP-style { code, message }; on success the order. */
  async cancelOrder(url: string) { return postJson(`${url}/cancel`, {}); }

  private async update(apiBase: string, id: string, body: unknown) {
    const r = await postJson<AcpCheckoutSession>(sessionUrl(apiBase, id), body);
    return r.status === 200 ? r.body : undefined;
  }
}

/**
 * Map a feed product onto the Offer shape the ranking evaluates. The price is
 * the estimated DELIVERED total (item + cheapest shipping to the buyer's
 * country), because that is what the mandate limits. The binding total is
 * re-read from the checkout session before anything is authorized.
 */
function toOffer(p: AcpProduct, feed: AcpProductFeed, apiBase: string, shipping: number | undefined): Offer {
  return {
    offerId: `${apiBase}/products#${encodeURIComponent(p.id)}`, version: 1, seller: feed.merchant.webId, sellerName: feed.merchant.name,
    category: p.category, resource: apiBase, coverage: "", properties: { ...p.properties, title: p.title },
    prices: shipping === undefined ? [] : [{ scheme: "acp-delegated", amount: String(p.price.amount + shipping), currency: p.price.currency.toUpperCase(), merchantId: feed.merchant.id }],
    validUntil: new Date(Date.now() + 3_600_000).toISOString(),
  };
}
