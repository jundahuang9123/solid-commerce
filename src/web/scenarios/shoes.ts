/**
 * Screen 4: "Buy repairable shoes. You may spend up to 120 EUR including
 * delivery." The shops have no HTTP 402; the assistant uses their ACP-style
 * checkout API, and the same gateway and signer authorise the payment. The
 * order is then followed to the user's signed verdict on the goods.
 *
 * Shipping is advanced with the simulated merchant's test control
 * (advanceOrder); everything else goes through the assistant's public API.
 */
import { AGENT_1 } from "../../demo/environment.js";
import type { SpendingMandate } from "../../model.js";
import type { ShoppingAssistant, PurchaseResult } from "../../agent/assistant.js";
import type { OrderTracking } from "../../agent/checkoutPurchase.js";
import type { AcpCheckoutSession, AcpOrder, AcpProductFeed } from "../../checkout/acp.js";
import { actAs, QUIET } from "../wire.js";
import type { DemoContext } from "../live.js";
import { recordLabel } from "./common.js";

export const SHOES_REQUEST = "Buy repairable shoes. You may spend up to 120 EUR including delivery.";
const AGENT = AGENT_1.split(":").pop()!;
/** Euro cents as shown on a receipt ("94.90 EUR"); checkout amounts are always EUR in this scenario. */
const eur = (cents: number | string) => `${(Number(cents) / 100).toFixed(2)} EUR`;
const json = async <T>(url: string) => actAs(QUIET, async () => (await fetch(url)).json() as Promise<T>);
/** "solesReplaceable" -> "soles replaceable" */
const words = (s: string) => s.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase();

export class ShoesScenario {
  private readonly assistant: ShoppingAssistant;
  private mandate?: SpendingMandate;
  private tracking?: OrderTracking;

  constructor(private readonly d: DemoContext) {
    this.assistant = d.env.checkoutAssistant(AGENT_1, { log: d.agentLog(AGENT) });
    d.log.emit("shoes.ready", { request: SHOES_REQUEST });
  }

  action(what: string, args: Record<string, unknown>): (() => Promise<unknown>) | undefined {
    switch (what) {
      case "buy": return () => actAs(AGENT, () => this.buy(Number.isInteger(args.choice) ? Number(args.choice) : 0));
      case "advance": return () => this.withOrder(async (t) => {
        const m = this.merchantOf(t);
        const status = m.advanceOrder(t.orderId);
        this.d.log.emit("shoes.note", { text: `${m.name} (simulated) moved order ${t.orderId} to "${status}" via its test control` });
        return this.assistant.trackOrder(t);
      });
      case "cancel": return () => this.withOrder((t) => this.assistant.cancelOrder(t));
      case "accept": return () => this.withOrder((t) => this.accept(t, args.ok !== false));
      default: return undefined;
    }
  }

  private say(role: "user" | "assistant", text: string) { this.d.log.emit("chat", { scenario: "shoes", role, text }); }

  /** An order that still needs the presenter: not yet delivered, or delivered and waiting for the user's verdict. */
  private openOrder(): OrderTracking | undefined {
    const t = this.tracking;
    return t && (["created", "shipped"].includes(t.orderStatus) || (t.orderStatus === "delivered" && !t.acceptance)) ? t : undefined;
  }

  private async buy(choice: number) {
    const env = this.d.env;
    // A second checkout against the same mandate would be refused by the gateway (the first order's
    // budget is committed) and would hide the order that exists. Finish or cancel that one first.
    const open = this.openOrder();
    if (open) { this.d.log.emit("shoes.note", { text: `Order ${open.orderId} is still open (${open.orderStatus}): advance, cancel or give your verdict first.` }); return; }
    this.say("user", SHOES_REQUEST);
    const { ctx, result } = await this.assistant.understand(SHOES_REQUEST, this.d.approved("merchants"));
    const answers = result.questions.flatMap((q, n) => {
      const pick = n === 0 && choice < q.options.length ? choice : 0;
      this.d.log.emit("shoes.agreed", { term: q.term, label: q.options[pick].label, prompt: q.prompt });
      this.say("assistant", q.prompt);
      this.say("user", q.options[pick].label);
      return this.assistant.answer(q, pick, ctx);
    });
    for (const r of result.reused) if (r.kind === "meaning") this.d.log.emit("shoes.agreed", { term: r.term, label: r.definition, reused: true });
    const proposals = [...result.proposals, ...answers];
    if (proposals.length) {
      this.say("assistant", `I've sent ${proposals.length} item${proposals.length > 1 ? "s" : ""} to your phone.`);
      this.d.broker.expect(proposals.length);
      const { confirmed, rejected } = await this.assistant.confirm(proposals, env.device);
      this.d.log.emit("confirmed", { scenario: "shoes", items: [...confirmed.map((r) => ({ label: recordLabel(r), kind: r.kind, approved: true })), ...rejected.map((r) => ({ label: recordLabel(r), kind: r.kind, approved: false }))] });
      this.mandate = confirmed.find((r): r is SpendingMandate => r.kind === "mandate") ?? this.mandate;
    }
    this.mandate ??= ctx.mandates.find((m) => m.targets.includes("Shoes"));
    if (this.d.cancelled()) return;   // Reset was pressed while the phone was asked: check out nowhere
    if (!this.mandate) { this.say("assistant", "No spending mandate for shoes was approved, so I cannot check out anywhere."); return; }
    this.d.track("shoes", "Shoes mandate", this.mandate);

    const r = await this.assistant.purchaseViaCheckout({ text: SHOES_REQUEST, category: "Shoes", mandateId: this.mandate.id });
    await this.showProducts(r);
    this.d.log.emit("shoes.purchase", { status: r.status, code: r.code, reason: r.reason, notes: r.notes, transactionId: r.transactionId, merchant: r.selected?.sellerName, display: r.amount ? eur(r.amount) : undefined, evidence: r.evidence });
    this.say("assistant", r.tracking ? `Ordered from ${r.selected?.sellerName} for ${eur(r.amount!)} including delivery. Payment ${r.tracking.paymentStatus}; now waiting for shipment.` : `Checkout ${r.status}${r.code ? ` (${r.code})` : ""}${r.reason ? `: ${r.reason}` : ""}.`);
    if (!r.tracking) return;
    this.tracking = r.tracking;
    await this.showCheckout(r.tracking);
    this.emitOrder(r.tracking);
    await this.d.showDoc(r.tracking.fulfilment, "fulfilment evidence");
  }

  /** Product feeds (titles, prices, delivery) joined with the assistant's own evaluation of each product. */
  private async showProducts(r: PurchaseResult) {
    const byOffer = new Map(r.evaluations.map((e) => [e.offerId, e]));
    const items = [];
    for (const m of Object.values(this.d.env.merchants)) {
      const feed = await json<AcpProductFeed>(`${m.url}/products`);
      for (const p of feed.products) {
        const ev = byOffer.get(`${m.url}/products#${encodeURIComponent(p.id)}`);
        const ship = p.shipping.filter((s) => s.country === this.d.env.address.country).map((s) => s.price);
        items.push({
          merchant: feed.merchant.name, title: p.title, price: eur(p.price.amount), delivery: ship.length ? eur(Math.min(...ship)) : undefined,
          properties: p.properties, acceptable: ev?.acceptable ?? false, chosen: r.selected?.offerId === ev?.offerId && Boolean(r.tracking), reasons: ev?.reasons ?? [],
        });
      }
    }
    this.d.log.emit("shoes.products", { items });
  }

  private async showCheckout(t: OrderTracking) {
    const env = this.d.env;
    const order = await json<AcpOrder>(t.orderUrl);
    const m = this.merchantOf(t);
    const s = await json<AcpCheckoutSession>(`${m.url}/checkout_sessions/${order.checkout_session_id}`);
    const titles = new Map((await json<AcpProductFeed>(`${m.url}/products`)).products.map((p) => [p.id, p.title]));
    const total = (type: string) => s.totals.find((x) => x.type === type)?.amount ?? 0;
    const option = s.fulfillment_options.find((o) => o.id === s.fulfillment_option_id);
    const rereads = this.d.log.all().filter((e) => e.type === "wire" && e.data.from === "gateway" && String(e.data.path).includes(s.id)).length;
    const token = [...env.rails.psp.tokens.values()].find((x) => x.allowance.checkout_session_id === s.id);
    const sharedWith = Object.values(env.merchants).filter((x) => x.receivedAddresses.length > 0).map((x) => x.name);
    this.d.log.emit("shoes.checkout", {
      merchant: t.merchantName, sessionId: s.id,
      lines: [
        ...s.line_items.map((li) => ({ label: `${li.item.quantity} × ${titles.get(li.item.id) ?? li.item.id}`, amount: eur(li.subtotal) })),
        ...(option ? [{ label: `${option.title}${option.carrier ? ` (${option.carrier})` : ""}`, amount: eur(option.total) }] : []),
        { label: "Tax added at checkout", amount: eur(total("tax")), muted: true },
      ],
      total: eur(total("total")), totalMajor: total("total") / 100, limit: Number(this.mandate!.maxPerTransaction), limitDisplay: `${this.mandate!.maxPerTransaction} ${this.mandate!.currency}`,
      facts: [
        `Gateway re-read the session from the shop itself (${rereads} request${rereads === 1 ? "" : "s"})`,
        token ? `Delegated card token: max ${eur(token.allowance.max_amount)}, ${t.merchantName} only, this session, one use, until ${token.allowance.expires_at.slice(11, 19)} UTC` : "No delegated token found at the PSP",
        `Address shared with ${sharedWith.join(", ") || "nobody"} only`,
      ],
    });
  }

  private emitOrder(t: OrderTracking) {
    this.d.log.emit("shoes.order", {
      orderId: t.orderId, merchant: t.merchantName, total: eur(t.total), orderStatus: t.orderStatus, paymentStatus: t.paymentStatus,
      delivery: t.delivery, events: t.events, acceptance: t.acceptance && { verdict: t.acceptance.verdict, checks: t.acceptance.checks, keyId: t.acceptance.keyId },
      inspect: t.requirements.map((c) => `${words(c.leftOperand)}: ${c.rightOperand}`),
    });
  }

  private async withOrder(fn: (t: OrderTracking) => Promise<OrderTracking>) {
    if (!this.tracking) { this.d.log.emit("shoes.note", { text: "There is no order yet: buy first." }); return; }
    const next = await actAs(AGENT, () => fn(this.tracking!));
    this.tracking = next;
    this.emitOrder(next);
    await this.d.showDoc(next.fulfilment, "fulfilment evidence");
  }

  /** The user inspected the goods: "as agreed" reports each requirement's agreed value, "not compliant" its opposite. */
  private async accept(t: OrderTracking, ok: boolean) {
    const observed = Object.fromEntries(t.requirements.map((c) => [c.leftOperand, ok ? String(c.rightOperand) : String(c.rightOperand) === "true" ? "false" : "not as agreed"]));
    this.d.broker.expect(1);
    const next = await this.assistant.acceptDelivery(t, observed, this.d.env.device);
    if (!next.acceptance) this.d.log.emit("shoes.note", { text: "The verdict was not signed on the device; nothing recorded." });
    return next;
  }

  private merchantOf(t: OrderTracking) { return Object.values(this.d.env.merchants).find((m) => m.webId === t.merchant)!; }
}
