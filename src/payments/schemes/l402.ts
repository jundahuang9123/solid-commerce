/**
 * L402-style scheme (formerly LSAT): HTTP 402 + macaroon + invoice.
 *
 *   402  WWW-Authenticate: L402 macaroon="<b64>", invoice="<payment request>"
 *   retry Authorization: L402 <macaroon>:<preimage hex>
 *
 * The "macaroon" here is a simplified HMAC-bound token: base64url JSON
 * caveats plus an HMAC by the seller's root key. It is not a libmacaroons
 * macaroon. It binds payment hash, resource, offer (id and version), amount
 * and expiry.
 *
 * expiresAt is the pay-by time: the invoice's own expiry. The Lightning node
 * refuses to pay an expired invoice, so a valid preimage already proves the
 * token was paid in time. Verification therefore does not refuse a token
 * presented after expiresAt: that would only strand a buyer who has paid, and
 * would break re-delivery of a paid token.
 */
import { createHash } from "node:crypto";
import { hmac, safeEqual } from "../../util/crypto.js";
import { decodeInvoice } from "../sim/lightning.js";
import type { PaymentAuthorization, PaymentCredential, PaymentOption } from "../types.js";

export interface L402Caveats { paymentHash: string; resource: string; amountSat: number; expiresAt: number; offerId: string; offerVersion: number }

export function mintMacaroon(rootKey: string, c: L402Caveats): string {
  const body = Buffer.from(JSON.stringify(c)).toString("base64url");
  return `${body}.${hmac(rootKey, body)}`;
}

/**
 * Check the token's HMAC, resource and preimage. The caveats state the price, so a seller must
 * also check caveats.offerId against the offer it is presented for (src/payments/serverSide.ts).
 */
export function verifyL402(rootKey: string, authorization: string, resource: string): { ok: true; caveats: L402Caveats; preimage: string } | { ok: false; reason: string } {
  const m = authorization.match(/^L402\s+([\w-]+\.[\w-]+):([0-9a-f]{64})$/i);
  if (!m) return { ok: false, reason: "malformed" };
  const [body, mac] = m[1].split(".");
  if (!safeEqual(hmac(rootKey, body), mac)) return { ok: false, reason: "bad_macaroon" };
  const caveats = JSON.parse(Buffer.from(body, "base64url").toString()) as L402Caveats;
  if (caveats.resource !== resource) return { ok: false, reason: "wrong_resource" };
  const hash = createHash("sha256").update(Buffer.from(m[2], "hex")).digest("hex");
  if (hash !== caveats.paymentHash) return { ok: false, reason: "bad_preimage" };
  return { ok: true, caveats, preimage: m[2] };
}

/** When the invoice stops being payable: the macaroon's expiresAt. */
export const invoiceExpiresAt = (paymentRequest: string) => decodeInvoice(paymentRequest).expiresAt;

export const l402Challenge =(macaroon: string, invoice: string) => `L402 macaroon="${macaroon}", invoice="${invoice}"`;

export function parseL402(wwwAuthenticate: string | null, resourceUrl: string): PaymentOption[] {
  if (!wwwAuthenticate) return [];
  const out: PaymentOption[] = [];
  for (const ch of splitChallenges(wwwAuthenticate)) {
    if (!/^L402\s/i.test(ch)) continue;
    const macaroon = ch.match(/macaroon="([^"]+)"/)?.[1];
    const invoice = ch.match(/invoice="([^"]+)"/)?.[1];
    if (!macaroon || !invoice) continue;
    const inv = decodeInvoice(invoice);
    out.push({ scheme: "l402", amount: String(inv.amountSat), currency: "SAT", payTo: inv.payee, resource: resourceUrl, challenge: { macaroon, invoice }, railReference: inv.paymentHash });
  }
  return out;
}

/** Split a combined WWW-Authenticate value into individual challenges. */
export function splitChallenges(v: string): string[] {
  return v.split(/,\s*(?=[A-Za-z0-9-]+\s+[A-Za-z0-9-]+=)/).reduce<string[]>((acc, part) => {
    if (/^[A-Za-z0-9-]+\s+[A-Za-z0-9-]+=/.test(part) || acc.length === 0) acc.push(part);
    else acc[acc.length - 1] += ", " + part;
    return acc;
  }, []);
}

export async function createL402Payment(lightningUrl: string, accountToken: string, auth: PaymentAuthorization, challenge: { macaroon: string; invoice: string }): Promise<PaymentCredential> {
  const inv = decodeInvoice(challenge.invoice);
  if (String(inv.amountSat) !== auth.amount || inv.payee !== auth.payTo) throw new Error("L402 invoice does not match authorization");
  const r = await fetch(lightningUrl + "/pay", { method: "POST", headers: { "content-type": "application/json", "x-account": accountToken }, body: JSON.stringify({ paymentRequest: challenge.invoice }) });
  const body = await r.json() as { status: string; preimage?: string; reason?: string };
  if (body.status !== "succeeded" || !body.preimage) throw new Error(`Lightning payment failed: ${body.reason}`);
  return { scheme: "l402", header: { name: "authorization", value: `L402 ${challenge.macaroon}:${body.preimage}` }, railReference: inv.paymentHash };
}
