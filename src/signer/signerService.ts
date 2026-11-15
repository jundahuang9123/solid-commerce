/**
 * Protected signer / payment vault. A separate service holding:
 *   - an EVM private key (x402, self-custodial)
 *   - a Lightning wallet account token (L402-style)
 *   - an opaque card token at a PSP (card / externally funded). For ACP-style
 *     checkout it mints a single-use delegated token from it (./delegatedPayment.ts);
 *     the card token itself is only ever sent to the PSP
 *
 * It pays ONLY when given an authorization signed by the gateway that matches
 * the exact challenge, and only for the agent the authorization names: callers
 * authenticate with the per-agent secret enrolled at setup (src/trust/agentAuth.ts),
 * and a credential, new or replayed, is returned only to that agent. It is
 * idempotent per authorization id: a retry gets the same credential, and no
 * second payment is made. Agents never see any secret of the vault.
 *
 * Each payer also checks the challenge against what the gateway bound into
 * the authorization beyond the challenge digest: the rail reference the
 * gateway reconciles against, and for x402 the chain, token and EIP-712 domain.
 *
 * The idempotency state (`done`) is in memory: after a restart the signer
 * would try to pay an unexpired authorization again (the rails' own
 * idempotency, i.e. the x402 nonce, the already-paid L402 invoice and the PSP
 * idempotency key, still stops a second transfer for the same authorization).
 */
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import type { Hex } from "viem";
import { digestOf, verifyEnvelope, type Signed } from "../util/crypto.js";
import { json, serve, type RunningServer } from "../util/http.js";
import type { PaymentAuthorization, PaymentCredential } from "../payments/types.js";
import { createX402Payment } from "../payments/schemes/x402.js";
import { createL402Payment } from "../payments/schemes/l402.js";
import { createCardPayment } from "../payments/schemes/cardPsp.js";
import { createDelegatedPayment } from "./delegatedPayment.js";
import type { DelegatedCredential } from "../checkout/acp.js";
import { AgentDirectory, type AgentEnrollment } from "../trust/agentAuth.js";

type Credential = PaymentCredential | DelegatedCredential;

export interface SignerConfig {
  gatewayPublicJwk: JsonWebKey;
  evmPrivateKey?: Hex;
  lightning?: { url: string; accountToken: string };
  card?: { token: string; allowedProviders: string[] };
  /** Agents allowed to call /pay, with the hash of each one's secret (more can be enrolled later). */
  agents?: AgentEnrollment[];
}

export interface SignerHandle extends RunningServer {
  evmAddress: string; lightningAccount?: string; payments: number;
  /** Enroll an agent's secret (its hash, see secretHash); only enrolled agents can obtain credentials. */
  enrollAgent(agentId: string, secretHash: string): void;
}

export async function startSigner(cfg: SignerConfig): Promise<SignerHandle> {
  const evmKey = cfg.evmPrivateKey ?? generatePrivateKey();
  const evmAddress = privateKeyToAccount(evmKey).address;
  const done = new Map<string, { challengeDigest: string; credential: Credential }>();
  const inFlight = new Map<string, Promise<Credential>>();
  let payments = 0;
  const agents = new AgentDirectory(cfg.agents ?? []);

  const srv = await serve(async (req, res) => {
    const u = new URL(req.url, "http://x");
    if (req.method === "GET" && u.pathname === "/info") {
      return json(res, 200, { x402: { address: evmAddress }, schemes: [ "x402", ...(cfg.lightning ? ["l402"] : []), ...(cfg.card ? ["card-psp", "acp-delegated"] : [])] });
    }
    if (req.method !== "POST" || u.pathname !== "/pay") return json(res, 404, { error: "not_found" });

    const caller = agents.authenticate(req.headers);
    if (caller?.kind !== "agent") return json(res, 401, { error: "AGENT_NOT_AUTHENTICATED", reason: "present the agent secret enrolled with this signer" }, { "www-authenticate": "Bearer" });
    const { authorization, challenge } = JSON.parse(req.body) as { authorization: Signed<PaymentAuthorization>; challenge: unknown };
    if (!authorization?.payload || !verifyEnvelope(authorization, cfg.gatewayPublicJwk)) return json(res, 401, { error: "AUTHORIZATION_INVALID", reason: "not signed by the gateway" });
    const a = authorization.payload;
    // A credential is a bearer instrument at the seller: hand it only to the agent it was authorized for.
    if (a.agentId !== caller.agentId) return json(res, 403, { error: "NOT_YOUR_AUTHORIZATION", reason: "the authorization names another agent" });
    if (!a.railReference) return json(res, 409, { error: "AUTHORIZATION_INCOMPLETE", reason: "the authorization names no rail reference" });
    const challengeDigest = digestOf(challenge);
    if (challengeDigest !== a.challengeDigest) return json(res, 409, { error: "CHALLENGE_MISMATCH", reason: "challenge differs from the one the gateway authorized" });

    const prior = done.get(a.authId);
    if (prior) return json(res, 200, { credential: prior.credential, replayed: true });
    if (new Date(a.expiresAt) <= new Date()) return json(res, 401, { error: "AUTHORIZATION_EXPIRED" });

    // Coalesce concurrent duplicate requests for the same authorization.
    let p = inFlight.get(a.authId);
    if (!p) {
      p = (async (): Promise<Credential> => {
        switch (a.scheme) {
          case "x402": return createX402Payment(evmKey, a, challenge as any);
          case "l402": if (!cfg.lightning) throw new Error("no lightning wallet"); return createL402Payment(cfg.lightning.url, cfg.lightning.accountToken, a, challenge as any);
          case "card-psp": if (!cfg.card) throw new Error("no card"); return createCardPayment(cfg.card.token, cfg.card.allowedProviders, a, challenge as any);
          case "acp-delegated": if (!cfg.card) throw new Error("no card"); return createDelegatedPayment(cfg.card.token, cfg.card.allowedProviders, a, challenge as any);
          default: throw new Error(`unsupported scheme ${a.scheme}`);
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
  return Object.defineProperties(Object.assign(srv, { evmAddress, lightningAccount: cfg.lightning?.accountToken, enrollAgent: (id: string, h: string) => agents.enroll(id, h) }), {
    payments: { get: () => payments, enumerable: true },
  }) as SignerHandle;
}
