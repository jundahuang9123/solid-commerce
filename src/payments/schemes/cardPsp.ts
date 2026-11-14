/**
 * Card / PSP payment intent behind HTTP 402. Its shape is loosely modelled on
 * the "Payment" HTTP authentication scheme used by recent machine-payment
 * proposals. It is NOT an implementation of any published specification.
 *
 *   402   WWW-Authenticate: Payment method="card-psp", id="pi_...", amount="2", currency="EUR", merchant="m_...", provider="<psp url>"
 *   retry Authorization: Payment <base64url JSON {method, id}>
 *
 * The same pattern fits bank transfers (open-banking payment initiation) or
 * an ACP-style delegated checkout: the 402 names a provider-side payment
 * object, the buyer's vault completes it, and the seller checks it with the
 * provider.
 */
import type { PaymentAuthorization, PaymentCredential, PaymentOption } from "../types.js";
import { splitChallenges } from "./l402.js";

export const paymentChallenge = (p: { id: string; amount: number; currency: string; merchant: string; provider: string }) =>
  `Payment method="card-psp", id="${p.id}", amount="${p.amount}", currency="${p.currency}", merchant="${p.merchant}", provider="${p.provider}"`;

export function parseCardPsp(wwwAuthenticate: string | null, resourceUrl: string): PaymentOption[] {
  if (!wwwAuthenticate) return [];
  return splitChallenges(wwwAuthenticate)
    .filter((c) => /^Payment\s/i.test(c) && /method="card-psp"/.test(c))
    .map((c) => {
      const g = (k: string) => c.match(new RegExp(`${k}="([^"]*)"`))?.[1] ?? "";
      return { scheme: "card-psp" as const, amount: g("amount"), currency: g("currency"), payTo: g("merchant"), resource: resourceUrl, challenge: { id: g("id"), provider: g("provider") }, railReference: g("id") };
    });
}

export async function createCardPayment(cardToken: string, allowedProviders: string[], auth: PaymentAuthorization, challenge: { id: string; provider: string }): Promise<PaymentCredential> {
  if (!allowedProviders.includes(challenge.provider)) throw new Error(`PSP ${challenge.provider} is not a provider this vault trusts`);
  const intent = await (await fetch(`${challenge.provider}/payment_intents/${challenge.id}`)).json() as { amount: number; currency: string; merchant: string };
  if (String(intent.amount) !== auth.amount || intent.currency !== auth.currency || intent.merchant !== auth.payTo) throw new Error("Payment intent does not match authorization");
  const r = await fetch(`${challenge.provider}/payment_intents/${challenge.id}/confirm`, {
    method: "POST", headers: { "content-type": "application/json", "idempotency-key": auth.authId }, body: JSON.stringify({ paymentMethod: cardToken }),
  });
  const body = await r.json() as { status?: string; error?: string; decline_code?: string };
  if (body.status !== "succeeded") throw new Error(`Card payment failed: ${body.error ?? body.status} ${body.decline_code ?? ""}`);
  const cred = Buffer.from(JSON.stringify({ method: "card-psp", id: challenge.id })).toString("base64url");
  return { scheme: "card-psp", header: { name: "authorization", value: `Payment ${cred}` }, railReference: challenge.id };
}
