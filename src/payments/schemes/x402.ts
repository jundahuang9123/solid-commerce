/**
 * x402 v2, "exact" scheme on EVM (EIP-3009 transferWithAuthorization).
 *
 * The wire format follows the x402 v2 reference implementation (@x402/core 2.x):
 *   402 response header  PAYMENT-REQUIRED   base64(JSON PaymentRequired)
 *   retry request header PAYMENT-SIGNATURE  base64(JSON PaymentPayload)
 *   200 response header  PAYMENT-RESPONSE   base64(JSON SettleResponse)
 *
 * Signatures are real EIP-712 signatures. Only settlement is simulated (see
 * src/payments/sim/facilitator.ts). To move to Base Sepolia, set
 * X402_FACILITATOR_URL to a real facilitator and fund the signer's address
 * with test USDC.
 */
import { privateKeyToAccount } from "viem/accounts";
import { getAddress, keccak256, toHex, type Hex } from "viem";
import { b64json } from "../../util/http.js";
import type { PaymentOption, PaymentCredential, PaymentAuthorization, OfferRef } from "../types.js";

export const X402_VERSION = 2;
export const HEADER_REQUIRED = "payment-required";
export const HEADER_SIGNATURE = "payment-signature";
export const HEADER_RESPONSE = "payment-response";

/** Base Sepolia (CAIP-2) and Circle's test USDC there. Nothing touches the chain in simulation. */
export const DEFAULT_NETWORK = "eip155:84532";
export const DEFAULT_USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
export const CHAIN_IDS: Record<string, number> = { "eip155:84532": 84532, "eip155:8453": 8453 };

export interface PaymentRequirements {
  scheme: "exact";
  network: string;
  asset: string;
  amount: string;
  payTo: string;
  maxTimeoutSeconds: number;
  extra: { name: string; version: string };
}
export interface PaymentRequired {
  x402Version: number;
  error?: string;
  resource: { url: string; description?: string; mimeType?: string };
  accepts: PaymentRequirements[];
  extensions?: Record<string, unknown>;
}
export interface Eip3009Authorization { from: Hex; to: Hex; value: string; validAfter: string; validBefore: string; nonce: Hex }
export interface PaymentPayload {
  x402Version: number;
  resource?: PaymentRequired["resource"];
  accepted: PaymentRequirements;
  payload: { signature: Hex; authorization: Eip3009Authorization };
}
export interface SettleResponse { success: boolean; errorReason?: string; payer?: string; transaction: string; network: string; amount?: string }

export const authorizationTypes = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

export function eip712Domain(req: PaymentRequirements) {
  const chainId = CHAIN_IDS[req.network];
  if (!chainId) throw new Error(`Unsupported network ${req.network}`);
  return { name: req.extra.name, version: req.extra.version, chainId, verifyingContract: getAddress(req.asset) };
}

/** EIP-3009 nonce derived from the gateway authorization id, so retries reuse it and cannot double-spend. */
export const nonceFor = (authId: string): Hex => keccak256(toHex(`sc-auth:${authId}`));

// ------------------------------------------------------------------ server side

export function buildPaymentRequired(resourceUrl: string, req: PaymentRequirements, offer: OfferRef, description: string): PaymentRequired {
  return {
    x402Version: X402_VERSION,
    error: "Payment required",
    resource: { url: resourceUrl, description, mimeType: "application/json" },
    accepts: [req],
    extensions: { "solid-commerce/offer": offer },
  };
}

// ------------------------------------------------------------------ client side

export function parseX402(res: Response, resourceUrl: string): { options: PaymentOption[]; offer?: OfferRef } {
  const h = res.headers.get(HEADER_REQUIRED);
  if (!h) return { options: [] };
  const pr = b64json.decode<PaymentRequired>(h);
  if (pr.x402Version !== X402_VERSION) return { options: [] };
  const options = pr.accepts
    .filter((a) => a.scheme === "exact")
    .map((a): PaymentOption => ({
      scheme: "x402", amount: a.amount, currency: a.extra.name === "USDC" ? "USDC" : a.extra.name,
      payTo: getAddress(a.payTo), resource: pr.resource.url ?? resourceUrl,
      challenge: { requirements: a, resource: pr.resource },
    }));
  return { options, offer: pr.extensions?.["solid-commerce/offer"] as OfferRef | undefined };
}

// ------------------------------------------------------------------ signer side

export async function createX402Payment(privateKey: Hex, auth: PaymentAuthorization, challenge: { requirements: PaymentRequirements; resource: PaymentRequired["resource"] }): Promise<PaymentCredential> {
  const account = privateKeyToAccount(privateKey);
  const req = challenge.requirements;
  if (req.amount !== auth.amount || getAddress(req.payTo) !== getAddress(auth.payTo)) throw new Error("x402 challenge does not match authorization");
  const now = Math.floor(Date.now() / 1000);
  const validBefore = Math.min(Math.floor(new Date(auth.expiresAt).getTime() / 1000), now + req.maxTimeoutSeconds);
  const authorization: Eip3009Authorization = {
    from: account.address, to: getAddress(req.payTo), value: req.amount,
    validAfter: String(now - 600), validBefore: String(validBefore), nonce: nonceFor(auth.authId),
  };
  const signature = await account.signTypedData({
    domain: eip712Domain(req), types: authorizationTypes, primaryType: "TransferWithAuthorization",
    message: { ...authorization, value: BigInt(authorization.value), validAfter: BigInt(authorization.validAfter), validBefore: BigInt(authorization.validBefore) },
  });
  const payload: PaymentPayload = { x402Version: X402_VERSION, resource: challenge.resource, accepted: req, payload: { signature, authorization } };
  return { scheme: "x402", header: { name: HEADER_SIGNATURE, value: b64json.encode(payload) }, railReference: authorization.nonce, payer: account.address };
}
