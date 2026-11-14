/**
 * Simulated Lightning-style payment node for the L402-style scheme.
 *
 * It keeps the property that matters for L402: paying an invoice reveals a
 * preimage whose sha256 is the invoice's payment hash. That preimage is the
 * proof of payment. Invoices are base64 JSON ("lnsim1..."), not BOLT11.
 * Swap in an LND/CLN client to make it real.
 */
import { createHash, randomBytes } from "node:crypto";
import { json, serve, type RunningServer } from "../../util/http.js";

interface Invoice { paymentHash: string; preimage: string; amountSat: number; payee: string; memo: string; expiresAt: number; paid: boolean; paidBy?: string }

export const encodeInvoice = (i: { paymentHash: string; amountSat: number; payee: string; expiresAt: number }) =>
  "lnsim1" + Buffer.from(JSON.stringify(i)).toString("base64url");
export const decodeInvoice = (pr: string) => {
  if (!pr.startsWith("lnsim1")) throw new Error("not an lnsim invoice");
  return JSON.parse(Buffer.from(pr.slice(6), "base64url").toString()) as { paymentHash: string; amountSat: number; payee: string; expiresAt: number };
};

export interface LightningSim extends RunningServer { balances: Map<string, number>; invoices: Map<string, Invoice> }

export async function startLightning(): Promise<LightningSim> {
  const invoices = new Map<string, Invoice>();
  const balances = new Map<string, number>();
  const srv = await serve(async (req, res) => {
    const u = new URL(req.url, "http://x");
    const body = req.body ? JSON.parse(req.body) : {};
    if (req.method === "POST" && u.pathname === "/invoices") {
      const preimage = randomBytes(32).toString("hex");
      const paymentHash = createHash("sha256").update(Buffer.from(preimage, "hex")).digest("hex");
      const inv: Invoice = { paymentHash, preimage, amountSat: body.amountSat, payee: body.payee, memo: body.memo ?? "", expiresAt: Date.now() + 600_000, paid: false };
      invoices.set(paymentHash, inv);
      return json(res, 200, { paymentRequest: encodeInvoice(inv), paymentHash });
    }
    if (req.method === "POST" && u.pathname === "/pay") {
      // Wallet API: the caller must present its account token (held only by the signer).
      const account = req.headers["x-account"] as string;
      const { paymentHash } = decodeInvoice(body.paymentRequest);
      const inv = invoices.get(paymentHash);
      if (!inv) return json(res, 404, { status: "failed", reason: "unknown_invoice" });
      if (inv.paid) {
        // Idempotent: paying an already-paid invoice returns the same preimage without moving funds again.
        return inv.paidBy === account ? json(res, 200, { status: "succeeded", preimage: inv.preimage, paymentHash }) : json(res, 409, { status: "failed", reason: "already_paid" });
      }
      if (inv.expiresAt < Date.now()) return json(res, 400, { status: "failed", reason: "expired" });
      const bal = balances.get(account) ?? 0;
      if (bal < inv.amountSat) return json(res, 402, { status: "failed", reason: "insufficient_balance" });
      balances.set(account, bal - inv.amountSat);
      balances.set(inv.payee, (balances.get(inv.payee) ?? 0) + inv.amountSat);
      inv.paid = true; inv.paidBy = account;
      return json(res, 200, { status: "succeeded", preimage: inv.preimage, paymentHash });
    }
    if (req.method === "GET" && u.pathname.startsWith("/invoices/")) {
      const inv = invoices.get(u.pathname.slice(10));
      return inv ? json(res, 200, { paymentHash: inv.paymentHash, paid: inv.paid, amountSat: inv.amountSat }) : json(res, 404, { error: "not_found" });
    }
    if (req.method === "POST" && u.pathname === "/fund") { balances.set(body.account, (balances.get(body.account) ?? 0) + body.amountSat); return json(res, 200, { ok: true }); }
    if (req.method === "GET" && u.pathname.startsWith("/balance/")) return json(res, 200, { balance: balances.get(decodeURIComponent(u.pathname.slice(9))) ?? 0 });
    json(res, 404, { error: "not_found" });
  });
  return Object.assign(srv, { balances, invoices });
}
