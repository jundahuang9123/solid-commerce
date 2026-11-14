/**
 * Simulated online shop for physical goods with an ACP-style checkout API.
 * It does NOT speak HTTP 402. ACP-style, modelled on the public description
 * of the Agentic Commerce Protocol; verify against the current specification
 * before interoperating (see src/checkout/acp.ts).
 *
 *   GET  /profile/card                        merchant identity (Turtle)
 *   GET  /products                            product feed (properties, EUR cents, shipping rates per country)
 *   POST /checkout_sessions                   create { items, fulfillment_address? }
 *   GET  /checkout_sessions/{id}              current state; totals are recomputed from current prices
 *   POST /checkout_sessions/{id}              update { items?, fulfillment_address?, fulfillment_option_id? }
 *   POST /checkout_sessions/{id}/complete     { payment_data: { token, provider } }: charges the delegated token at the PSP
 *   POST /checkout_sessions/{id}/cancel
 *   GET  /orders/{id}                         order state (simulation convenience; ACP reports orders via webhooks)
 *   POST /orders/{id}/cancel                  buyer cancellation before shipment: refunds at the PSP
 *
 * Every POST honours Idempotency-Key: a repeated key replays the stored
 * response, and the same key with a different body is refused (409).
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { canonicalJson, randomHex } from "../../util/crypto.js";
import { json, postJson, serve, type RunningServer } from "../../util/http.js";
import {
  IDEMPOTENCY_HEADER, type AcpAddress, type AcpCheckoutSession, type AcpFulfillmentOption, type AcpOrder, type AcpProduct, type AcpTotal, type OrderStatus,
} from "../../checkout/acp.js";

export interface ShippingRate { id: string; title: string; carrier: string; amount: number; countries: string[] }

export interface AcpMerchantConfig {
  slug: string;
  name: string;
  products: Array<Omit<AcpProduct, "shipping" | "availability"> & { availability?: AcpProduct["availability"] }>;
  shipping: ShippingRate[];
  /** Tax added on top of items and shipping, in basis points. EU consumer prices include VAT, so 0 unless a shop adds taxes or duties. */
  taxRateBps?: number;
  psp: { url: string; apiKey: string };
}

export interface AcpMerchantHandle extends RunningServer {
  webId: string;
  name: string;
  merchantId: string;
  /** Every fulfilment address this merchant has been sent, for privacy checks. */
  receivedAddresses: Array<{ sessionId: string; address: AcpAddress }>;
  sessions: Map<string, AcpCheckoutSession>;
  orders: Map<string, AcpOrder>;
  completions: number;
  setPrice(productId: string, amount: number): void;
  setShippingPrice(rateId: string, amount: number): void;
  setTaxRate(bps: number): void;
  /** Process the next N completions, then drop the connection before responding. */
  loseNextCompletionResponses(n?: number): void;
  /** created -> shipped -> delivered */
  advanceOrder(orderId: string): OrderStatus;
  /** Merchant-initiated refund (e.g. after a return). */
  refundOrder(orderId: string): Promise<AcpOrder>;
}

type Out = { status: number; body: unknown };
const error = (status: number, code: string, message: string, type = "invalid_request"): Out => ({ status, body: { type, code, message } });

export async function startAcpMerchant(cfg: AcpMerchantConfig): Promise<AcpMerchantHandle> {
  const merchantId = `acct_${cfg.slug}`;
  const products = new Map(cfg.products.map((p) => [p.id, { availability: "in_stock" as const, ...p, price: { ...p.price } }]));
  const shipping = new Map(cfg.shipping.map((r) => [r.id, { ...r }]));
  let taxRateBps = cfg.taxRateBps ?? 0;
  const sessions = new Map<string, AcpCheckoutSession>();
  const orders = new Map<string, AcpOrder>();
  const receivedAddresses: AcpMerchantHandle["receivedAddresses"] = [];
  const idem = new Map<string, { request: string; out: Out }>();
  let loseResponses = 0;
  let completions = 0;
  let base = "";

  const tax = (amount: number) => Math.round((amount * taxRateBps) / 10_000);
  const feedShipping = () => [...shipping.values()].flatMap((r) => r.countries.map((country) => ({ country, service: r.title, price: r.amount })));

  /** Recompute prices, options, totals and status from the current catalogue. Completed and canceled sessions are frozen. */
  function refresh(s: AcpCheckoutSession): AcpCheckoutSession {
    if (s.status === "completed" || s.status === "canceled") return s;
    const messages: AcpCheckoutSession["messages"] = [];
    s.line_items = s.line_items.map((li) => {
      const p = products.get(li.item.id);
      const baseAmount = (p?.price.amount ?? 0) * li.item.quantity;
      if (!p || p.availability !== "in_stock") messages.push({ type: "error", code: "out_of_stock", content: `${li.item.id} is not available` });
      return { ...li, base_amount: baseAmount, discount: 0, subtotal: baseAmount, tax: tax(baseAmount), total: baseAmount + tax(baseAmount) };
    });
    const country = s.fulfillment_address?.country;
    s.fulfillment_options = country
      ? [...shipping.values()].filter((r) => r.countries.includes(country)).map((r): AcpFulfillmentOption => ({ type: "shipping", id: r.id, title: r.title, carrier: r.carrier, subtotal: r.amount, tax: tax(r.amount), total: r.amount + tax(r.amount) }))
      : [];
    if (s.fulfillment_option_id && !s.fulfillment_options.some((o) => o.id === s.fulfillment_option_id)) s.fulfillment_option_id = undefined;
    const selected = s.fulfillment_options.find((o) => o.id === s.fulfillment_option_id);
    const sum = (f: (x: { subtotal: number; tax: number }) => number) => s.line_items.reduce((a, li) => a + f(li), 0);
    const subtotal = sum((x) => x.subtotal);
    const taxTotal = sum((x) => x.tax) + (selected?.tax ?? 0);
    const totals: AcpTotal[] = [
      { type: "items_base_amount", display_text: "Items", amount: sum((x) => x.subtotal) },
      { type: "subtotal", display_text: "Subtotal", amount: subtotal },
      ...(selected ? [{ type: "fulfillment" as const, display_text: `Shipping (${selected.title})`, amount: selected.subtotal }] : []),
      { type: "tax", display_text: "Tax", amount: taxTotal },
      { type: "total", display_text: "Total", amount: subtotal + (selected?.subtotal ?? 0) + taxTotal },
    ];
    s.totals = totals;
    if (!s.fulfillment_address) messages.push({ type: "info", code: "missing_address", content: "fulfillment_address required" });
    else if (!selected) messages.push({ type: "info", code: "missing_fulfillment_option", content: "choose a fulfillment option" });
    s.messages = messages;
    s.status = s.line_items.length > 0 && selected && !messages.some((m) => m.type === "error") ? "ready_for_payment" : "not_ready_for_payment";
    return s;
  }

  function applyUpdate(s: AcpCheckoutSession, body: any) {
    if (Array.isArray(body.items)) {
      s.line_items = body.items.map((it: { id: string; quantity?: number }) => ({ id: "li_" + randomHex(4), item: { id: it.id, quantity: it.quantity ?? 1 }, base_amount: 0, discount: 0, subtotal: 0, tax: 0, total: 0 }));
    }
    if (body.fulfillment_address) {
      s.fulfillment_address = body.fulfillment_address;
      receivedAddresses.push({ sessionId: s.id, address: body.fulfillment_address });
    }
    if (body.fulfillment_option_id) s.fulfillment_option_id = body.fulfillment_option_id;
  }

  async function complete(s: AcpCheckoutSession, body: any): Promise<Out> {
    if (s.status === "completed") return { status: 200, body: s };  // already paid: never charge again
    refresh(s);
    if (s.status !== "ready_for_payment") return error(409, "not_ready_for_payment", "checkout session is not ready for payment");
    const token = body?.payment_data?.token;
    if (!token || body.payment_data.provider !== cfg.psp.url) return error(400, "invalid_payment_data", "a delegated token from this shop's payment provider is required");
    const total = s.totals.find((t) => t.type === "total")!.amount;
    const ch = await postJson(`${cfg.psp.url}/agentic_commerce/charges`,
      { token, amount: total, currency: s.currency, merchant_id: merchantId, checkout_session_id: s.id },
      { authorization: `Bearer ${cfg.psp.apiKey}`, [IDEMPOTENCY_HEADER]: `${s.id}:${token}` });
    if (ch.status !== 200) return error(402, ch.body?.code ?? "payment_failed", ch.body?.message ?? "charge failed", "processing_error");
    const orderId = "ord_" + randomHex(6);
    const order: AcpOrder = {
      id: orderId, checkout_session_id: s.id, status: "created", line_items: s.line_items.map((li) => ({ ...li.item })),
      total, currency: s.currency, charge_id: ch.body.id, events: [{ status: "created", at: new Date().toISOString() }], permalink_url: `${base}/orders/${orderId}`,
    };
    orders.set(orderId, order);
    s.status = "completed";
    s.order = { id: orderId, checkout_session_id: s.id, permalink_url: order.permalink_url };
    completions++;
    return { status: 200, body: s };
  }

  async function refund(o: AcpOrder, detail: string): Promise<Out> {
    const r = await postJson(`${cfg.psp.url}/agentic_commerce/refunds`, { charge_id: o.charge_id }, { authorization: `Bearer ${cfg.psp.apiKey}`, [IDEMPOTENCY_HEADER]: `refund:${o.id}` });
    if (r.status !== 200) return error(502, "refund_failed", r.body?.message ?? "refund failed", "processing_error");
    o.refund = { id: r.body.id, amount: r.body.amount };
    o.status = "refunded";
    o.events.push({ status: "refunded", at: new Date().toISOString(), detail });
    return { status: 200, body: o };
  }

  async function route(req: IncomingMessage & { body: string; url: string }): Promise<Out | undefined> {
    const u = new URL(req.url, base);
    const body = req.body ? JSON.parse(req.body) : {};
    if (req.method === "GET" && u.pathname === "/products") {
      return { status: 200, body: { merchant: { id: merchantId, webId: `${base}/profile/card#org`, name: cfg.name }, products: [...products.values()].map((p) => ({ ...p, shipping: feedShipping() })) } };
    }
    if (req.method === "POST" && u.pathname === "/checkout_sessions") {
      const s: AcpCheckoutSession = { id: "cs_" + randomHex(8), status: "not_ready_for_payment", currency: "eur", line_items: [], fulfillment_options: [], totals: [], payment_provider: { provider: cfg.psp.url, supported_payment_methods: ["card"] }, messages: [], links: [{ type: "terms_of_use", url: `${base}/terms` }] };
      applyUpdate(s, body);
      sessions.set(s.id, s);
      return { status: 201, body: refresh(s) };
    }
    const m = u.pathname.match(/^\/checkout_sessions\/([^/]+)(\/complete|\/cancel)?$/);
    if (m) {
      const s = sessions.get(decodeURIComponent(m[1]));
      if (!s) return error(404, "not_found", "no such checkout session");
      if (req.method === "GET" && !m[2]) return { status: 200, body: refresh(s) };
      if (req.method !== "POST") return undefined;
      if (m[2] === "/complete") return complete(s, body);
      if (s.status === "completed" || s.status === "canceled") return error(409, `session_${s.status}`, `checkout session is ${s.status}`);
      if (m[2] === "/cancel") { s.status = "canceled"; return { status: 200, body: s }; }
      applyUpdate(s, body);
      return { status: 200, body: refresh(s) };
    }
    const o = u.pathname.match(/^\/orders\/([^/]+)(\/cancel)?$/);
    if (o) {
      const order = orders.get(decodeURIComponent(o[1]));
      if (!order) return error(404, "not_found", "no such order");
      if (req.method === "GET" && !o[2]) return { status: 200, body: order };
      if (req.method === "POST" && o[2]) {
        if (order.status === "refunded") return { status: 200, body: order };
        if (order.status !== "created") return error(409, "order_already_shipped", `order is ${order.status}; return it instead`);
        order.status = "canceled";
        order.events.push({ status: "canceled", at: new Date().toISOString(), detail: "canceled by the buyer before shipment" });
        return refund(order, "refund for buyer cancellation");
      }
    }
    return undefined;
  }

  const srv = await serve(async (req, res: ServerResponse) => {
    if (req.method === "GET" && new URL(req.url, "http://x").pathname === "/profile/card") {
      res.writeHead(200, { "content-type": "text/turtle" });
      return res.end(`@prefix schema: <https://schema.org/> .\n<#org> a schema:Organization ; schema:name ${JSON.stringify(cfg.name)} ; schema:identifier "${merchantId}" .\n`);
    }
    const key = req.headers[IDEMPOTENCY_HEADER] as string | undefined;
    const scoped = key && req.method === "POST" ? `${new URL(req.url, "http://x").pathname}:${key}` : undefined;
    const request = canonicalJson(req.body ? JSON.parse(req.body) : {});
    const prior = scoped ? idem.get(scoped) : undefined;
    if (prior && prior.request !== request) return json(res, 409, { type: "invalid_request", code: "idempotency_conflict", message: "Idempotency-Key reused for a different request" });
    const out = prior?.out ?? (await route(req)) ?? { status: 404, body: { type: "invalid_request", code: "not_found", message: "not found" } };
    // Only successes are stored: a declined charge may be retried under the same key.
    if (scoped && !prior && out.status < 300) idem.set(scoped, { request, out });
    if (/\/complete$/.test(req.url) && loseResponses > 0 && out.status === 200) {
      loseResponses--;
      req.socket.destroy();                     // processed, but the buyer never hears back
      return;
    }
    json(res, out.status, out.body);
  });
  base = srv.url;

  const handle = Object.assign(srv, {
    webId: `${base}/profile/card#org`, name: cfg.name, merchantId, receivedAddresses, sessions, orders, completions: 0,
    setPrice: (id: string, amount: number) => { products.get(id)!.price.amount = amount; },
    setShippingPrice: (id: string, amount: number) => { shipping.get(id)!.amount = amount; },
    setTaxRate: (bps: number) => { taxRateBps = bps; },
    loseNextCompletionResponses: (n = 1) => { loseResponses = n; },
    advanceOrder(id: string): OrderStatus {
      const o = orders.get(id)!;
      const next: Partial<Record<OrderStatus, OrderStatus>> = { created: "shipped", shipped: "delivered" };
      const to = next[o.status];
      if (!to) throw new Error(`order ${id} is ${o.status}`);
      o.status = to;
      o.events.push({ status: to, at: new Date().toISOString() });
      return to;
    },
    async refundOrder(id: string) {
      const out = await refund(orders.get(id)!, "merchant refund (return)");
      if (out.status !== 200) throw new Error(JSON.stringify(out.body));
      return out.body as AcpOrder;
    },
  });
  return Object.defineProperty(handle, "completions", { get: () => completions, enumerable: true });
}
