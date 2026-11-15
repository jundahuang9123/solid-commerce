/**
 * Simulated x402 facilitator plus a simulated USDC token ledger.
 *
 * It implements the facilitator HTTP surface (POST /verify, POST /settle,
 * GET /supported) and checks real EIP-712 / EIP-3009 signatures. "Settlement"
 * moves balances in memory instead of on chain. EIP-3009 nonce semantics are
 * kept: each (authorizer, nonce) can be used once, which is what makes
 * retries safe.
 *
 * GET /authorization-state mirrors the token contract's authorizationState()
 * view, used by the gateway for reconciliation.
 */
import { getAddress, keccak256, toHex, verifyTypedData, type Hex } from "viem";
import { json, serve, type RunningServer } from "../../util/http.js";
import { authorizationTypes, eip712Domain, type PaymentPayload, type PaymentRequirements, type SettleResponse } from "../schemes/x402.js";

export class SimUsdc {
  balances = new Map<string, bigint>();
  usedNonces = new Map<string, string>(); // nonceKey(from, nonce) -> tx hash
  transfers: Array<{ tx: string; from: string; to: string; value: bigint; at: string }> = [];
  mint(addr: string, v: bigint) { const a = getAddress(addr); this.balances.set(a, (this.balances.get(a) ?? 0n) + v); }
  balanceOf(addr: string) { return this.balances.get(getAddress(addr)) ?? 0n; }
}

/**
 * The ledger key of an EIP-3009 authorization. The nonce is a bytes32, so its hex letter case is
 * not part of its identity (as on chain): "0xAB.." and "0xab.." are the same nonce.
 */
export const nonceKey = (from: string, nonce: string) => `${getAddress(from)}:${String(nonce).toLowerCase()}`;

type VerifyResult = { isValid: boolean; invalidReason?: string; payer?: string };

export async function verifyPayment(chain: SimUsdc, p: PaymentPayload, req: PaymentRequirements): Promise<VerifyResult> {
  const a = p?.payload?.authorization;
  if (!a || p.accepted?.scheme !== "exact" || req.scheme !== "exact") return { isValid: false, invalidReason: "unsupported_scheme" };
  if (p.accepted.network !== req.network || getAddress(p.accepted.asset) !== getAddress(req.asset)) return { isValid: false, invalidReason: "invalid_network" };
  if (getAddress(a.to) !== getAddress(req.payTo)) return { isValid: false, invalidReason: "invalid_exact_evm_payload_recipient_mismatch" };
  if (BigInt(a.value) !== BigInt(req.amount)) return { isValid: false, invalidReason: "invalid_exact_evm_payload_authorization_value" };
  const now = BigInt(Math.floor(Date.now() / 1000));
  if (BigInt(a.validBefore) < now) return { isValid: false, invalidReason: "invalid_exact_evm_payload_authorization_valid_before", payer: a.from };
  if (BigInt(a.validAfter) > now) return { isValid: false, invalidReason: "invalid_exact_evm_payload_authorization_valid_after", payer: a.from };
  const ok = await verifyTypedData({
    address: getAddress(a.from), domain: eip712Domain(req), types: authorizationTypes, primaryType: "TransferWithAuthorization",
    message: { from: getAddress(a.from), to: getAddress(a.to), value: BigInt(a.value), validAfter: BigInt(a.validAfter), validBefore: BigInt(a.validBefore), nonce: a.nonce },
    signature: p.payload.signature,
  }).catch(() => false);
  if (!ok) return { isValid: false, invalidReason: "invalid_exact_evm_payload_signature", payer: a.from };
  if (chain.usedNonces.has(nonceKey(a.from, a.nonce))) return { isValid: false, invalidReason: "nonce_already_used", payer: a.from };
  if (chain.balanceOf(a.from) < BigInt(a.value)) return { isValid: false, invalidReason: "insufficient_funds", payer: a.from };
  return { isValid: true, payer: getAddress(a.from) };
}

export async function settlePayment(chain: SimUsdc, p: PaymentPayload, req: PaymentRequirements): Promise<SettleResponse> {
  const a = p.payload.authorization;
  const key = nonceKey(a.from, a.nonce);
  const prior = chain.usedNonces.get(key);
  if (prior) return { success: false, errorReason: "nonce_already_used", transaction: prior, network: req.network, payer: getAddress(a.from) };
  const v = await verifyPayment(chain, p, req);
  if (!v.isValid) return { success: false, errorReason: v.invalidReason, transaction: "", network: req.network, payer: v.payer };
  const from = getAddress(a.from), to = getAddress(a.to), value = BigInt(a.value);
  chain.balances.set(from, chain.balanceOf(from) - value);
  chain.balances.set(to, chain.balanceOf(to) + value);
  const tx = keccak256(toHex(`${key}:${Date.now()}`));
  chain.usedNonces.set(key, tx);
  chain.transfers.push({ tx, from, to, value, at: new Date().toISOString() });
  return { success: true, transaction: tx, network: req.network, payer: from, amount: a.value };
}

export interface FacilitatorSim extends RunningServer { chain: SimUsdc; failNextSettle: (mode: "error" | "timeout-after-settle") => void }

export async function startFacilitator(chain = new SimUsdc()): Promise<FacilitatorSim> {
  let failMode: "error" | "timeout-after-settle" | undefined;
  const srv = await serve(async (req, res) => {
    const u = new URL(req.url, "http://x");
    if (req.method === "GET" && u.pathname === "/supported") {
      return json(res, 200, { kinds: [{ x402Version: 2, scheme: "exact", network: "eip155:84532" }], extensions: [], signers: {} });
    }
    if (req.method === "POST" && (u.pathname === "/verify" || u.pathname === "/settle")) {
      const { paymentPayload, paymentRequirements } = JSON.parse(req.body);
      if (u.pathname === "/verify") return json(res, 200, await verifyPayment(chain, paymentPayload, paymentRequirements));
      if (failMode === "error") { failMode = undefined; return json(res, 502, { success: false, errorReason: "upstream_unavailable" }); }
      const out = await settlePayment(chain, paymentPayload, paymentRequirements);
      if (failMode === "timeout-after-settle") { failMode = undefined; req.socket.destroy(); return; } // funds moved, response lost
      return json(res, 200, out);
    }
    if (req.method === "GET" && u.pathname === "/authorization-state") {
      const key = nonceKey(u.searchParams.get("authorizer") as Hex, u.searchParams.get("nonce") ?? "");
      const tx = chain.usedNonces.get(key);
      return json(res, 200, { used: Boolean(tx), transaction: tx ?? null });
    }
    if (req.method === "GET" && u.pathname.startsWith("/balance/")) {
      return json(res, 200, { address: u.pathname.slice(9), balance: chain.balanceOf(u.pathname.slice(9)).toString() });
    }
    if (req.method === "POST" && u.pathname === "/mint") {
      const { address, amount } = JSON.parse(req.body); chain.mint(address, BigInt(amount));
      return json(res, 200, { ok: true });
    }
    json(res, 404, { error: "not_found" });
  });
  return Object.assign(srv, { chain, failNextSettle: (m: "error" | "timeout-after-settle") => { failMode = m; } });
}
