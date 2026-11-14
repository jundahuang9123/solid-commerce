/**
 * Transaction evidence written to the buyer's Pod: what was considered,
 * authorised, paid and delivered, with PROV links. There are two documents per
 * transaction so the two writers never conflict:
 *   transactions/<id>.ttl         written by the assistant (offers, decision, delivery)
 *   transactions/<id>-ledger.ttl  written by the gateway (authorization, settlement)
 */
import N3 from "n3";
import { NS, sc } from "./namespaces.js";

const { namedNode: nn, literal: lit, quad } = N3.DataFactory;
const xsd = (t: string) => nn(NS.xsd + t);

function writer(base: string) {
  const quads: N3.Quad[] = [];
  const add = (s: string, p: string, o: N3.Term | string | number) =>
    quads.push(quad(nn(s), nn(p), (typeof o === "string" ? lit(o) : typeof o === "number" ? lit(String(o), xsd(Number.isInteger(o) ? "integer" : "decimal")) : o) as N3.Quad_Object));
  const end = () => new Promise<string>((res, rej) => { const w = new N3.Writer({ prefixes: { ...NS, "": base + "#" } }); w.addQuads(quads); w.end((e, r) => (e ? rej(e) : res(r ?? ""))); });
  return { add, end };
}

export interface OfferEvaluation { offerId: string; version: number; seller: string; sellerName?: string; acceptable: boolean; score: number; reasons: string[]; price?: string; currency?: string }

/** FulfilmentPending and Cancelled apply to physical orders, which are delivered after payment. */
export type DeliveryStatus = "Delivered" | "NonCompliant" | "NotDelivered" | "FulfilmentPending" | "Cancelled";

export interface AssistantEvidence {
  docUrl: string;
  transactionId: string;
  intention?: string;
  agentId: string;
  mandate: string;
  groundedBy: string[];               // IRIs of meanings / requirements applied
  evaluations: OfferEvaluation[];
  selectedOffer?: string;
  scheme?: string;
  amount?: string;
  currency?: string;
  ledgerDoc?: string;
  receipt?: unknown;
  challenge?: unknown;               // the seller's payment challenge (public); lets a later session recover delivery
  recovers?: string;                 // evidence document of the transaction being recovered
  delivery?: { status: DeliveryStatus; checks: string[]; contentDigest?: string };
  checkoutSession?: string;          // ACP-style checkout session the purchase completed
  fulfilment?: string;               // document tracking a physical order (see fulfilmentEvidenceToTurtle)
  status: string;
  startedAt: string;
  endedAt?: string;
}

export async function assistantEvidenceToTurtle(e: AssistantEvidence): Promise<string> {
  const { add, end } = writer(e.docUrl);
  const t = `${e.docUrl}#tx`;
  add(t, NS.rdf + "type", nn(sc("Transaction")));
  add(t, sc("transactionId"), e.transactionId);
  if (e.intention) add(t, NS.prov + "used", nn(e.intention));
  if (e.recovers) add(t, NS.prov + "wasInformedBy", nn(e.recovers + "#tx"));
  add(t, NS.prov + "used", nn(e.mandate));
  add(t, NS.prov + "wasAssociatedWith", lit(e.agentId));
  add(t, NS.prov + "startedAtTime", lit(e.startedAt, xsd("dateTime")));
  if (e.endedAt) add(t, NS.prov + "endedAtTime", lit(e.endedAt, xsd("dateTime")));
  add(t, sc("status"), e.status);
  for (const g of e.groundedBy) add(t, sc("groundedIn"), nn(g));
  e.evaluations.forEach((ev, i) => {
    const n = `${e.docUrl}#evaluation-${i + 1}`;
    add(t, sc("offerConsidered"), nn(n));
    add(n, NS.rdf + "type", nn(sc("OfferEvaluation")));
    add(n, NS.prov + "used", nn(ev.offerId));
    add(n, sc("offerVersion"), ev.version);
    add(n, NS.schema + "seller", nn(ev.seller));
    if (ev.sellerName) add(n, NS.schema + "name", ev.sellerName);
    add(n, sc("acceptable"), lit(String(ev.acceptable), xsd("boolean")));
    add(n, sc("score"), ev.score);
    if (ev.price) add(n, sc("amount"), ev.price);
    if (ev.currency) add(n, sc("currency"), nn(sc(ev.currency)));
    for (const r of ev.reasons) add(n, NS.rdfs + "comment", r);
  });
  if (e.selectedOffer) add(t, sc("selectedOffer"), nn(e.selectedOffer));
  if (e.scheme) add(t, sc("paymentScheme"), e.scheme);
  if (e.amount) add(t, sc("amount"), e.amount);
  if (e.currency) add(t, sc("currency"), nn(sc(e.currency)));
  if (e.ledgerDoc) add(t, sc("authorization"), nn(e.ledgerDoc + "#entry"));
  if (e.receipt) add(t, sc("receipt"), JSON.stringify(e.receipt));
  if (e.challenge) add(t, sc("challenge"), JSON.stringify(e.challenge));
  if (e.checkoutSession) add(t, sc("checkoutSession"), nn(e.checkoutSession));
  if (e.fulfilment) add(t, sc("fulfilment"), nn(e.fulfilment + "#order"));
  if (e.delivery) {
    const d = `${e.docUrl}#delivery`;
    add(t, sc("deliveryOutcome"), nn(d));
    add(d, sc("status"), nn(sc(e.delivery.status)));
    if (e.delivery.contentDigest) add(d, sc("contentDigest"), e.delivery.contentDigest);
    for (const c of e.delivery.checks) add(d, NS.rdfs + "comment", c);
  }
  return end();
}

export interface LedgerEvidence {
  docUrl: string; transactionId: string; mandate: string; status: string; scheme: string; amount: string; currency: string;
  seller: string; offerId: string; offerVersion: number; authorizationId?: string; authorization?: unknown;
  railReference?: string; receipt?: unknown; reason?: string; updatedAt: string; gateway: string;
}

export async function ledgerEvidenceToTurtle(e: LedgerEvidence): Promise<string> {
  const { add, end } = writer(e.docUrl);
  const n = `${e.docUrl}#entry`;
  add(n, NS.rdf + "type", nn(sc("PaymentAuthorization")));
  add(n, sc("transactionId"), e.transactionId);
  add(n, NS.prov + "used", nn(e.mandate));
  add(n, NS.prov + "wasAttributedTo", lit(e.gateway));
  add(n, sc("status"), nn(sc(STATUS_IRI[e.status] ?? e.status)));
  add(n, sc("paymentScheme"), e.scheme);
  add(n, sc("amount"), e.amount);
  add(n, sc("currency"), nn(sc(e.currency)));
  add(n, NS.schema + "seller", nn(e.seller));
  add(n, sc("selectedOffer"), nn(e.offerId));
  add(n, sc("offerVersion"), e.offerVersion);
  if (e.authorizationId) add(n, sc("authorizationId"), e.authorizationId);
  if (e.authorization) add(n, sc("signedAuthorization"), JSON.stringify(e.authorization));
  if (e.railReference) add(n, sc("paymentReference"), e.railReference);
  if (e.receipt) add(n, sc("receipt"), JSON.stringify(e.receipt));
  if (e.reason) add(n, NS.rdfs + "comment", e.reason);
  add(n, NS.dct + "modified", lit(e.updatedAt, xsd("dateTime")));
  return end();
}

const STATUS_IRI: Record<string, string> = { authorized: "Reserved", pending: "Pending", settled: "Settled", released: "Released", rejected: "Rejected", refunded: "Refunded" };

// ------------------------------------------------------------------ physical fulfilment

export type OrderState = "created" | "shipped" | "delivered" | "canceled" | "refunded";

export interface FulfilmentEvidence {
  docUrl: string;
  transactionId: string;
  transactionDoc: string;            // the assistant's evidence document for the purchase
  orderId: string;
  orderUrl: string;
  merchant: string;
  merchantName?: string;
  orderStatus: OrderState;
  items: Array<{ id: string; quantity: number }>;
  total: string;
  currency: string;
  deliveryAddress: string;           // IRI of the schema:PostalAddress in the Pod
  events: Array<{ status: OrderState; at: string; detail?: string }>;
  paymentStatus?: string;            // the gateway ledger's view, kept apart from the order state
  delivery: { status: DeliveryStatus; checks: string[] };
  /** The user's verdict on the goods, signed on the approval device. */
  acceptance?: { verdict: "Delivered" | "NonCompliant"; checks: string[]; by: string; at: string; keyId: string; termsDigest: string; signature: string };
  updatedAt: string;
}

/** schema:OrderStatus individuals per order state. A refund is additionally marked sc:Refunded. */
const ORDER_STATUS: Record<OrderState, string> = { created: "OrderProcessing", shipped: "OrderInTransit", delivered: "OrderDelivered", canceled: "OrderCancelled", refunded: "OrderCancelled" };

/**
 * One document per physical order, rewritten as it moves through
 * created -> shipped -> delivered (or canceled / refunded). Payment status and
 * delivery outcome are separate properties, so "paid, not shipped" can never
 * be read as "payment failed".
 */
export async function fulfilmentEvidenceToTurtle(e: FulfilmentEvidence): Promise<string> {
  const { add, end } = writer(e.docUrl);
  const o = `${e.docUrl}#order`;
  add(o, NS.rdf + "type", nn(NS.schema + "Order"));
  add(o, NS.schema + "orderNumber", e.orderId);
  add(o, NS.schema + "url", nn(e.orderUrl));
  add(o, NS.schema + "seller", nn(e.merchant));
  if (e.merchantName) add(o, NS.schema + "name", e.merchantName);
  add(o, NS.schema + "orderStatus", nn(NS.schema + ORDER_STATUS[e.orderStatus]));
  if (e.orderStatus === "refunded") add(o, sc("status"), nn(sc("Refunded")));
  add(o, sc("transactionId"), e.transactionId);
  add(o, NS.prov + "wasGeneratedBy", nn(e.transactionDoc + "#tx"));
  add(o, sc("amount"), e.total);
  add(o, sc("currency"), nn(sc(e.currency)));
  if (e.paymentStatus) add(o, sc("paymentStatus"), nn(sc(STATUS_IRI[e.paymentStatus] ?? e.paymentStatus)));
  e.items.forEach((it, i) => {
    const n = `${e.docUrl}#item-${i + 1}`;
    add(o, NS.schema + "orderedItem", nn(n));
    add(n, NS.rdf + "type", nn(NS.schema + "OrderItem"));
    add(n, NS.schema + "orderedItem", nn(it.id));
    add(n, NS.schema + "orderQuantity", it.quantity);
  });
  const p = `${e.docUrl}#parcel`;
  add(o, NS.schema + "orderDelivery", nn(p));
  add(p, NS.rdf + "type", nn(NS.schema + "ParcelDelivery"));
  add(p, NS.schema + "deliveryAddress", nn(e.deliveryAddress));
  e.events.forEach((ev, i) => {
    const n = `${e.docUrl}#event-${i + 1}`;
    add(p, sc("trackingEvent"), nn(n));
    add(n, NS.schema + "orderStatus", nn(NS.schema + ORDER_STATUS[ev.status]));
    add(n, NS.prov + "atTime", lit(ev.at, xsd("dateTime")));
    if (ev.detail) add(n, NS.rdfs + "comment", ev.detail);
  });
  const d = `${e.docUrl}#delivery`;
  add(o, sc("deliveryOutcome"), nn(d));
  add(d, sc("status"), nn(sc(e.delivery.status)));
  for (const c of e.delivery.checks) add(d, NS.rdfs + "comment", c);
  if (e.acceptance) {
    const a = `${e.docUrl}#acceptance`;
    add(d, sc("acceptance"), nn(a));
    add(a, NS.rdf + "type", nn(sc("DeliveryAcceptance")));
    add(a, sc("verdict"), nn(sc(e.acceptance.verdict)));
    for (const c of e.acceptance.checks) add(a, NS.rdfs + "comment", c);
    add(a, sc("confirmedBy"), nn(e.acceptance.by));
    add(a, NS.prov + "endedAtTime", lit(e.acceptance.at, xsd("dateTime")));
    add(a, sc("keyId"), e.acceptance.keyId);
    add(a, sc("termsDigest"), e.acceptance.termsDigest);
    add(a, sc("signature"), e.acceptance.signature);
  }
  add(o, NS.dct + "modified", lit(e.updatedAt, xsd("dateTime")));
  return end();
}
