/**
 * Delegated payment for ACP-style checkout (modelled on ACP's public
 * description of delegate_payment; verify against the current specification
 * before interoperating).
 *
 * Instead of paying, the vault asks the PSP to mint a single-use token whose
 * allowance is exactly what the gateway authorized: at most that amount, in
 * that currency, for that merchant and checkout session, until the
 * authorization expires. The merchant charges the token; the PSP enforces the
 * allowance. The vault's card token is sent only to the PSP.
 */
import type { PaymentAuthorization } from "../payments/types.js";
import type { Allowance, CheckoutChallenge, DelegatedCredential } from "../checkout/acp.js";
import { IDEMPOTENCY_HEADER } from "../checkout/acp.js";
import { postJson } from "../util/http.js";

export async function createDelegatedPayment(cardToken: string, allowedProviders: string[], auth: PaymentAuthorization, challenge: CheckoutChallenge): Promise<DelegatedCredential> {
  if (!allowedProviders.includes(challenge.provider)) throw new Error(`PSP ${challenge.provider} is not a provider this vault trusts`);
  // The challenge digest already binds these; checking them again keeps the allowance derivation obviously correct.
  if (challenge.merchant_id !== auth.payTo) throw new Error("challenge merchant differs from the authorized payee");
  if (!auth.resource.endsWith(`/checkout_sessions/${encodeURIComponent(challenge.checkout_session_id)}`)) throw new Error("challenge session differs from the authorized resource");
  const allowance: Allowance = {
    reason: "one_time", max_amount: Number(auth.amount), currency: auth.currency.toLowerCase(),
    checkout_session_id: challenge.checkout_session_id, merchant_id: auth.payTo, expires_at: auth.expiresAt,
  };
  // Idempotency-Key = authId: a retried call can never mint a second token for one authorization.
  const r = await postJson(`${challenge.provider}/agentic_commerce/delegate_payment`,
    { payment_method: { type: "card", token: cardToken }, allowance, metadata: { authorization_id: auth.authId, transaction_id: auth.transactionId } },
    { [IDEMPOTENCY_HEADER]: auth.authId });
  if (r.status !== 201) throw new Error(`delegate_payment failed: ${r.body?.code ?? r.status} ${r.body?.message ?? ""}`);
  return { scheme: "acp-delegated", token: r.body.id, provider: challenge.provider, railReference: challenge.checkout_session_id };
}
