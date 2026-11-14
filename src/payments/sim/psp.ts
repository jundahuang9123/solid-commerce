/**
 * Simulated card payment service provider (Stripe-like payment intents).
 *
 * The seller creates an intent. The buyer's vault confirms it with a stored
 * card token and an idempotency key. The seller checks the intent's status
 * before delivering. Raw card numbers never appear. The signer holds only an
 * opaque token, as with a real PSP vault.
 */
import { randomBytes } from "node:crypto";
import { json, serve, type RunningServer } from "../../util/http.js";

interface Intent { id: string; amount: number; currency: string; merchant: string; resource: string; status: "requires_confirmation" | "succeeded" | "failed"; paymentMethod?: string; createdAt: number }

export interface PspSim extends RunningServer { intents: Map<string, Intent>; cards: Map<string, { limit: number; spent: number }>; merchantBalances: Map<string, number> }

export async function startPsp(): Promise<PspSim> {
  const intents = new Map<string, Intent>();
  const cards = new Map<string, { limit: number; spent: number }>();
  const idem = new Map<string, unknown>();
  const merchantBalances = new Map<string, number>();
  const srv = await serve(async (req, res) => {
    const u = new URL(req.url, "http://x");
    const body = req.body ? JSON.parse(req.body) : {};
    if (req.method === "POST" && u.pathname === "/payment_intents") {
      const id = "pi_" + randomBytes(10).toString("hex");
      const it: Intent = { id, amount: body.amount, currency: body.currency, merchant: body.merchant, resource: body.resource, status: "requires_confirmation", createdAt: Date.now() };
      intents.set(id, it);
      return json(res, 200, it);
    }
    const confirm = u.pathname.match(/^\/payment_intents\/(pi_\w+)\/confirm$/);
    if (req.method === "POST" && confirm) {
      const key = req.headers["idempotency-key"] as string | undefined;
      if (key && idem.has(key)) return json(res, 200, idem.get(key));
      const it = intents.get(confirm[1]);
      if (!it) return json(res, 404, { error: "no_such_intent" });
      if (it.status === "succeeded") return json(res, 200, it);
      const card = cards.get(body.paymentMethod);
      if (!card) return json(res, 402, { error: "card_declined", decline_code: "invalid_token" });
      if (card.spent + it.amount > card.limit) { it.status = "failed"; return json(res, 402, { error: "card_declined", decline_code: "insufficient_funds" }); }
      card.spent += it.amount; it.status = "succeeded"; it.paymentMethod = body.paymentMethod;
      merchantBalances.set(it.merchant, (merchantBalances.get(it.merchant) ?? 0) + it.amount);
      if (key) idem.set(key, it);
      return json(res, 200, it);
    }
    const get = u.pathname.match(/^\/payment_intents\/(pi_\w+)$/);
    if (req.method === "GET" && get) {
      const it = intents.get(get[1]);
      return it ? json(res, 200, it) : json(res, 404, { error: "no_such_intent" });
    }
    if (req.method === "POST" && u.pathname === "/cards") { cards.set(body.token, { limit: body.limit, spent: 0 }); return json(res, 200, { ok: true }); }
    json(res, 404, { error: "not_found" });
  });
  return Object.assign(srv, { intents, cards, merchantBalances });
}
