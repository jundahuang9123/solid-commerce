/**
 * Gateway checks for the HTTP 402 schemes: the challenge the signer will pay
 * must implement exactly the seller-signed offer that was evaluated.
 *
 * The agent's PaymentOption is a summary it parsed from the 402; none of its
 * fields is trusted on its own. The gateway reads the terms out of the
 * challenge itself (the object the signer receives and whose digest the
 * authorization carries), compares them with the signed offer's price entry,
 * and requires the agent's summary to agree. It also derives the payment's
 * rail reference from the challenge, which is what reconciliation later asks
 * the rail about:
 *
 *   x402      requirements.scheme/network/asset/amount/payTo and the EIP-712
 *             domain (extra.name/version) must equal the offer's price entry
 *             and the pinned token table; the reference is the EIP-3009 nonce,
 *             derived from the authorization id (the signer uses the same one)
 *   L402      the invoice's payment hash, amount and payee, checked against the
 *             Lightning node's own record of the invoice (the simulated invoice
 *             string is unsigned); the macaroon's caveats must name the same hash,
 *             resource and offer
 *   card-psp  the intent id; the intent is read from the PSP the gateway
 *             reconciles against, and its amount, currency, merchant and
 *             resource must equal the offer
 *
 * What it cannot check: the L402 macaroon's HMAC and the x402 resource field
 * are the seller's to verify, and a malicious approved seller can still refuse
 * to deliver after payment (that is what receipts and delivery evidence record).
 */
import { getAddress } from "viem";
import type { Offer, PriceOption, SpendingMandate } from "../model.js";
import type { Signed } from "../util/crypto.js";
import type { TrustRegistry } from "../trust/registry.js";
import type { OfferRef, PaymentOption, X402Terms } from "../payments/types.js";
import { knownX402Token, type PaymentRequirements } from "../payments/schemes/x402.js";
import { lightningInvoice, macaroonCaveats } from "../payments/schemes/l402.js";
import { decodeInvoice } from "../payments/sim/lightning.js";
import type { Binding } from "./checkoutBinding.js";

export type OfferBindResult = { ok: true; binding: Binding } | { ok: false; status: number; code: string; reason: string };

/** The terms a challenge actually carries, as read by the gateway. */
interface ChallengeTerms { amount: string; currency: string; payTo: string; resource: string; railReference?: string; x402?: X402Terms }

const no = (status: number, code: string, reason: string): OfferBindResult => ({ ok: false, status, code, reason });
const mismatch = (reason: string) => no(409, "OFFER_MISMATCH", reason);
const sameAddress = (a: unknown, b: unknown) => {
  try { return typeof a === "string" && typeof b === "string" && getAddress(a) === getAddress(b); } catch { return false; }
};
const isObject = (v: unknown): v is Record<string, any> => typeof v === "object" && v !== null && !Array.isArray(v);

async function getJson<T>(url: string): Promise<T | undefined> {
  try {
    const r = await fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(5000) });
    return r.ok ? ((await r.json()) as T) : undefined;
  } catch { return undefined; }
}

function x402Terms(challenge: unknown, price: PriceOption, offer: Offer): ChallengeTerms | string {
  if (!isObject(challenge) || !isObject(challenge.requirements)) return "x402 challenge carries no payment requirements";
  const req = challenge.requirements as Partial<PaymentRequirements>;
  if (req.scheme !== "exact") return `x402 scheme ${String(req.scheme)} is not "exact"`;
  if (req.network !== price.network || !sameAddress(req.asset, price.asset)) return `x402 challenge pays on ${String(req.network)} in token ${String(req.asset)}; the signed offer says ${price.network} / ${price.asset}`;
  const token = knownX402Token(req.network, req.asset);
  if (!token) return `x402 token ${String(req.asset)} on ${String(req.network)} is not one this gateway pays in`;
  if (!isObject(req.extra) || req.extra.name !== token.domainName || req.extra.version !== token.domainVersion) return `x402 EIP-712 domain ${JSON.stringify(req.extra)} is not the pinned domain of ${token.currency}`;
  if (token.currency !== price.currency) return `the signed offer prices ${price.currency}, but its token is ${token.currency}`;
  if (typeof req.amount !== "string" || !sameAddress(req.payTo, price.payTo)) return "x402 challenge amount or payee is malformed or differs from the signed offer";
  if (!Number.isInteger(req.maxTimeoutSeconds) || req.maxTimeoutSeconds! <= 0) return "x402 challenge has no valid timeout";
  const resource = isObject(challenge.resource) && typeof challenge.resource.url === "string" ? challenge.resource.url : offer.resource;
  return {
    amount: req.amount, currency: token.currency, payTo: getAddress(req.payTo as string), resource,
    x402: { network: token.network, asset: getAddress(token.asset), domainName: token.domainName, domainVersion: token.domainVersion },
  };
}

async function l402Terms(challenge: unknown, offer: Offer, lightningUrl: string): Promise<ChallengeTerms | string> {
  if (!isObject(challenge) || typeof challenge.invoice !== "string" || typeof challenge.macaroon !== "string") return "L402 challenge needs an invoice and a macaroon";
  let inv: ReturnType<typeof decodeInvoice>;
  try { inv = decodeInvoice(challenge.invoice); } catch { return "L402 invoice cannot be decoded"; }
  if (typeof inv.paymentHash !== "string" || !/^[0-9a-f]{64}$/.test(inv.paymentHash)) return "L402 invoice has no valid payment hash";
  const node = await lightningInvoice(lightningUrl, inv.paymentHash);
  if (!node) return "the Lightning node does not know this invoice";
  if (node.amountSat !== inv.amountSat || node.payee !== inv.payee) return "the invoice's amount or payee differs from the node's record of it";
  if (node.paid) return "the invoice has already been paid";
  const c = macaroonCaveats(challenge.macaroon);
  if (!c || c.paymentHash !== inv.paymentHash || c.resource !== offer.resource || c.offerId !== offer.offerId) return "the L402 macaroon is for another invoice, resource or offer";
  return { amount: String(inv.amountSat), currency: "SAT", payTo: inv.payee, resource: offer.resource, railReference: inv.paymentHash };
}

async function cardTerms(challenge: unknown, pspUrl: string): Promise<ChallengeTerms | string> {
  if (!isObject(challenge) || typeof challenge.id !== "string" || !/^pi_\w+$/.test(challenge.id)) return "card challenge names no payment intent";
  // Reconciliation asks this PSP; an intent at any other provider could not be checked later.
  if (challenge.provider !== pspUrl) return `card challenge names payment provider ${String(challenge.provider)}, not the one this gateway reconciles with`;
  const intent = await getJson<{ id: string; amount: number; currency: string; merchant: string; resource: string; status: string }>(`${pspUrl}/payment_intents/${challenge.id}`);
  if (!intent || intent.id !== challenge.id) return "the payment provider does not know this intent";
  if (intent.status !== "requires_confirmation") return `the payment intent is ${intent.status}`;
  return { amount: String(intent.amount), currency: intent.currency, payTo: intent.merchant, resource: intent.resource, railReference: intent.id };
}

export async function bindSignedOffer(
  deps: { registry: TrustRegistry; rails: { lightningUrl: string; pspUrl: string } },
  m: SpendingMandate, signed: Signed<Offer>, offerRef: OfferRef | undefined, o: PaymentOption,
): Promise<OfferBindResult> {
  const offer = signed.payload;
  if (!m.targets.includes(offer.category)) return no(403, "CATEGORY_NOT_AUTHORIZED", offer.category);

  // Seller: approved by the gateway AND allowed by the mandate; offer signed by the pinned key
  if (!m.allowedSellers.includes(offer.seller)) return no(403, "SELLER_NOT_IN_MANDATE", offer.seller);
  const oc = deps.registry.checkOffer(signed);
  if (!oc.ok) return no(403, oc.code, oc.reason);

  // The 402 challenge must implement exactly the signed offer that was evaluated
  if (offerRef && (offerRef.offerId !== offer.offerId || offerRef.version !== offer.version || offerRef.digest !== oc.digest)) {
    return no(409, "OFFER_CHANGED", `402 references ${offerRef.offerId} v${offerRef.version}; evaluated v${offer.version}. Re-fetch and re-evaluate the offer.`);
  }
  const price = offer.prices.find((p) => p.scheme === o.scheme);
  const payee = price && (price.payTo ?? price.merchantId);
  if (!price || price.amount !== o.amount || price.currency !== o.currency || payee !== o.payTo || offer.resource !== o.resource) {
    return mismatch("payment challenge does not match the signed offer (amount, currency, payee or resource)");
  }

  // The challenge itself, not the agent's summary of it
  const terms = o.scheme === "x402" ? x402Terms(o.challenge, price, offer)
    : o.scheme === "l402" ? await l402Terms(o.challenge, offer, deps.rails.lightningUrl)
    : o.scheme === "card-psp" ? await cardTerms(o.challenge, deps.rails.pspUrl)
    : `scheme ${o.scheme} is not a 402 scheme`;
  if (typeof terms === "string") return mismatch(terms);
  if (terms.amount !== price.amount || terms.currency !== price.currency || terms.payTo !== payee || terms.resource !== offer.resource) {
    return mismatch("the challenge's own amount, currency, payee or resource differs from the signed offer");
  }
  if (o.railReference !== undefined && o.railReference !== terms.railReference) {
    return no(409, "RAIL_REFERENCE_MISMATCH", "the option names a different payment than its challenge");
  }
  return { ok: true, binding: { seller: offer.seller, offerId: offer.offerId, offerVersion: offer.version, offerDigest: oc.digest, resource: offer.resource, railReference: terms.railReference, x402: terms.x402 } };
}
