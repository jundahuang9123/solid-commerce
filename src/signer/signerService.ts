/**
 * Protected signer / payment vault. A separate service holding:
 *   - an EVM private key (x402, self-custodial)
 *   - a Lightning wallet account token (L402-style)
 *   - an opaque card token at a PSP (card / externally funded)
 *
 * It pays ONLY when given an authorization signed by the gateway that matches
 * the exact challenge. It is idempotent per authorization id: a retry gets the
 * same credential, and no second payment is made. Agents never see any secret.
 */
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import type { Hex } from "viem";
import { digestOf, verifyEnvelope, type Signed } from "../util/crypto.js";
import { json, serve, type RunningServer } from "../util/http.js";
import type { PaymentAuthorization, PaymentCredential } from "../payments/types.js";
import { createX402Payment } from "../payments/schemes/x402.js";
import { createL402Payment } from "../payments/schemes/l402.js";
import { createCardPayment } from "../payments/schemes/cardPsp.js";

export interface SignerConfig {
  gatewayPublicJwk: JsonWebKey;
  evmPrivateKey?: Hex;
  lightning?: { url: string; accountToken: string };
  card?: { token: string; allowedProviders: string[] };
}

export interface SignerHandle extends RunningServer { evmAddress: string; lightningAccount?: string; payments: number }

export async function startSigner(cfg: SignerConfig): Promise<SignerHandle> {
  const evmKey = cfg.evmPrivateKey ?? generatePrivateKey();
  const evmAddress = privateKeyToAccount(evmKey).address;
  const done = new Map<string, { challengeDigest: string; credential: PaymentCredential }>();
  const inFlight = new Map<string, Promise<PaymentCredential>>();
  let payments = 0;

  const srv = await serve(async (req, res) => {
    const u = new URL(req.url, "http://x");
    if (req.method === "GET" && u.pathname === "/info") {
      return json(res, 200, { x402: { address: evmAddress }, schemes: [ "x402", ...(cfg.lightning ? ["l402"] : []), ...(cfg.card ? ["card-psp"] : [])] });
    }
    if (req.method !== "POST" || u.pathname !== "/pay") return json(res, 404, { error: "not_found" });

    const { authorization, challenge } = JSON.parse(req.body) as { authorization: Signed<PaymentAuthorization>; challenge: unknown };
    if (!verifyEnvelope(authorization, cfg.gatewayPublicJwk)) return json(res, 401, { error: "AUTHORIZATION_INVALID", reason: "not signed by the gateway" });
    const a = authorization.payload;
    const challengeDigest = digestOf(challenge);
    if (challengeDigest !== a.challengeDigest) return json(res, 409, { error: "CHALLENGE_MISMATCH", reason: "challenge differs from the one the gateway authorized" });

    const prior = done.get(a.authId);
    if (prior) return json(res, 200, { credential: prior.credential, replayed: true });
    if (new Date(a.expiresAt) <= new Date()) return json(res, 401, { error: "AUTHORIZATION_EXPIRED" });

    // Coalesce concurrent duplicate requests for the same authorization.
    let p = inFlight.get(a.authId);
    if (!p) {
      p = (async () => {
        switch (a.scheme) {
          case "x402": return createX402Payment(evmKey, a, challenge as any);
          case "l402": if (!cfg.lightning) throw new Error("no lightning wallet"); return createL402Payment(cfg.lightning.url, cfg.lightning.accountToken, a, challenge as any);
          case "card-psp": if (!cfg.card) throw new Error("no card"); return createCardPayment(cfg.card.token, cfg.card.allowedProviders, a, challenge as any);
        }
      })();
      inFlight.set(a.authId, p);
    }
    try {
      const credential = await p;
      if (!done.has(a.authId)) { done.set(a.authId, { challengeDigest, credential }); payments++; }
      json(res, 200, { credential, replayed: false });
    } catch (e) {
      json(res, 422, { error: "PAYMENT_FAILED", reason: (e as Error).message });
    } finally {
      inFlight.delete(a.authId);
    }
  });
  return Object.defineProperties(Object.assign(srv, { evmAddress, lightningAccount: cfg.lightning?.accountToken }), {
    payments: { get: () => payments, enumerable: true },
  }) as SignerHandle;
}
