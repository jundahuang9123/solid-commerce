/**
 * A "402 proxy": a reverse proxy that sells access to any existing HTTP API
 * through HTTP 402, without changing the API's code. It is the same idea as
 * Aperture for L402, but serves all three schemes this repo supports from
 * one 402 response.
 *
 *   GET /profile/card     seller identity (Turtle): name, offer-signing key, offer catalogue
 *   GET /offers/<route>   signed, versioned offer (JSON envelope; schema.org Turtle on Accept: text/turtle)
 *   <paid route>          no credential -> 402 with x402 v2, L402-style and card/PSP challenges;
 *                         valid credential -> forwarded upstream, returned with a seller-signed receipt
 *   respellings of a paid path, other methods on it, ambiguous escapes
 *                         refused here (404 / 405 / 400), never forwarded (see routes.ts)
 *   anything else         forwarded free ("passthrough") or 404 ("not-found")
 *
 * The upstream is only reached after payment is settled. The receipt's
 * contentDigest is computed over the exact bytes returned to the client.
 * What the upstream answers after settlement decides what the buyer gets:
 *   2xx                         the content, with a receipt. A GET may be re-delivered by
 *                               re-presenting the credential; any other method is delivered
 *                               once, then the credential is consumed (402 credential_consumed)
 *   no answer, 5xx, 408/425/429 502 paid:true; re-presenting the same credential
 *                               delivers later without a second charge
 *   any other 3xx/4xx           the upstream's own answer, relayed unchanged with no
 *                               receipt and an sc-payment-outcome header (paid, not
 *                               delivered). The answer is deterministic, so retrying is
 *                               pointless; instead a GET payment may be presented once for
 *                               another target of the same resource (see SettlementBook.lookup)
 *
 * Non-GET paid routes (a POST runs a job the buyer chooses with its body) need an
 * Idempotency-Key header on the paid request; without one a credential is refused with
 * 400 before any money moves. The first paid presentation binds the payment to that key
 * and a digest of method, target, content type and body. After that:
 *   same key and body           a retry of the same request: forwarded again (with the same
 *                               Idempotency-Key, so the upstream can recognise it) after a
 *                               transient failure or refusal, or answered from the stored
 *                               response once delivered, without asking the upstream again
 *   other key or body           409 idempotency_conflict before a delivery, 402
 *                               credential_consumed after it. Never forwarded.
 * Limits: an upstream that ignores Idempotency-Key may run the SAME job twice when it did the
 * work and then timed out or failed; and the binding is in memory, so after a proxy restart a
 * consumed POST credential can deliver one more request (see SettlementBook).
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { getAddress } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import type { Offer } from "../model.js";
import { Ed25519Key, newId, randomHex, sha256Hex, signEnvelope, type Signed } from "../util/crypto.js";
import { b64json, type RunningServer } from "../util/http.js";
import { offerToTurtle } from "../rdf/records.js";
import { RECEIPT_HEADER, type Receipt } from "../payments/types.js";
import { DEFAULT_NETWORK, DEFAULT_USDC } from "../payments/schemes/x402.js";
import {
  isPaymentAuthorization, PAYMENT_HEADERS, PaymentAcceptor, priceOptionsFor,
  type Acceptance, type DeliveryOutcome, type Payees, type RailUrls, type RequestClaim, type SchemePrices, type Settlement, type X402Asset,
} from "../payments/serverSide.js";
import { forward, readRawBody, type UpstreamResponse } from "./forward.js";
import { matchRequest, RESERVED, validateRoutes, type PaidRoute } from "./routes.js";

/** Header on a paid request that delivered nothing because the upstream refused it. */
export const OUTCOME_HEADER = "sc-payment-outcome";
/** 4xx answers that say "try again later", not "this request is wrong". */
const RETRYABLE_4XX = new Set([408, 425, 429]);
/**
 * Methods a settled credential may re-deliver any number of times. Anything else (a POST with a new
 * body each time) gets one delivery per payment, or one payment would buy unlimited requests.
 * HEAD never reaches a paid route (routes.ts refuses it).
 */
const SAFE_METHODS = new Set(["GET", "HEAD"]);
/** The buyer's key for one paid non-GET request (draft-ietf-httpapi-idempotency-key-header). */
export const IDEMPOTENCY_HEADER = "idempotency-key";
const IDEMPOTENCY_KEY = /^[\x21-\x7e]{1,255}$/;
/** Set on an answer replayed from the stored response of an already delivered non-GET request. */
export const REPLAY_HEADER = "sc-idempotent-replay";
const singleHeader = (v: string | string[] | undefined) => (Array.isArray(v) ? (v.length === 1 ? v[0] : undefined) : v);
const hasPaymentCredential = (h: IncomingMessage["headers"]) =>
  PAYMENT_HEADERS.some((n) => h[n] !== undefined) || isPaymentAuthorization(String(h.authorization ?? ""));

function outcomeOf(up: UpstreamResponse | undefined): DeliveryOutcome {
  if (!up || up.status >= 500 || RETRYABLE_4XX.has(up.status)) return "transient";
  return up.status >= 200 && up.status <= 299 ? "delivered" : "refused";
}

export interface PaymentProxyConfig {
  seller: { name: string; slug: string };
  /** Base URL of the API being sold. Paths are forwarded unchanged below it. */
  upstream: string;
  /** Externally visible base URL (offer ids, resource URLs, WebID). Defaults to the listening URL. */
  publicUrl?: string;
  routes: PaidRoute[];
  rails: RailUrls;
  /** Requests matching no route: forward free, or answer 404. Default "not-found". */
  unconfigured?: "passthrough" | "not-found";
  /**
   * Key material. Anything missing is generated for this process only, which
   * is fine for tests and simulated rails; see src/proxy/cli.ts for loading
   * persistent keys.
   */
  keys?: { signingKey?: Ed25519Key; payTo?: string; macaroonRootKey?: string };
  /** Payee ids on the Lightning node and PSP. Default ln:<slug> and m_<slug>. */
  payees?: { lightningPayee?: string; merchantId?: string };
  x402?: X402Asset;
  offerTtlSeconds?: number;
  upstreamTimeoutMs?: number;
}

export interface PaymentProxyHandle extends RunningServer {
  webId: string;
  key: Ed25519Key;
  payTo: string;
  lightningPayee: string;
  merchantId: string;
  offerUrl(routeId: string): string;
  resourceUrl(routeId: string): string;
  offer(routeId: string): Signed<Offer>;
  /** Merge new prices into a route; bumps the offer version and re-signs. */
  setPrice(routeId: string, prices: SchemePrices): Signed<Offer>;
  /** Successful paid deliveries (each carries a receipt). */
  readonly deliveries: number;
  /** Distinct payments settled. */
  readonly settlements: number;
}

interface RouteState { route: PaidRoute; version: number; signed: Signed<Offer> }

export async function startPaymentProxy(cfg: PaymentProxyConfig, port = 0, host = "127.0.0.1"): Promise<PaymentProxyHandle> {
  validateRoutes(cfg.routes);
  const key = cfg.keys?.signingKey ?? Ed25519Key.generate();
  const payTo = getAddress(cfg.keys?.payTo ?? privateKeyToAccount(generatePrivateKey()).address);
  const payees: Payees = { payTo, lightningPayee: cfg.payees?.lightningPayee ?? `ln:${cfg.seller.slug}`, merchantId: cfg.payees?.merchantId ?? `m_${cfg.seller.slug}` };
  const acceptor = new PaymentAcceptor({ rails: cfg.rails, payees, macaroonRootKey: cfg.keys?.macaroonRootKey ?? randomHex(32) });
  const x402: X402Asset = cfg.x402 ?? { network: DEFAULT_NETWORK, asset: DEFAULT_USDC };
  const ttlMs = (cfg.offerTtlSeconds ?? 3600) * 1000;
  const timeoutMs = cfg.upstreamTimeoutMs ?? 30_000;
  const states = new Map<string, RouteState>();
  let deliveries = 0;
  let base = "";
  let publicUrl: URL;

  const webId = () => `${base}/profile/card#org`;
  const offerUrl = (id: string) => `${base}/offers/${id}`;
  const resourceUrl = (r: PaidRoute) => base + r.path;

  function publish(st: RouteState) {
    const r = st.route;
    const offer: Offer = {
      offerId: `${offerUrl(r.id)}#offer`, version: st.version, seller: webId(), sellerName: cfg.seller.name,
      category: r.category, resource: resourceUrl(r), coverage: r.coverage ?? "", properties: r.properties ?? {},
      prices: priceOptionsFor(r.prices, payees, x402), validUntil: new Date(Date.now() + ttlMs).toISOString(),
    };
    st.signed = signEnvelope(key, offer);
  }
  /**
   * The current offer. Validity is renewed (same version, new signature) once
   * half the TTL has passed, so a long-running proxy never serves an expired
   * offer. A buyer holding the older envelope sees a different digest in the
   * 402 and re-validates, exactly as for a price change.
   */
  function current(st: RouteState): Signed<Offer> {
    if (new Date(st.signed.payload.validUntil).getTime() - Date.now() < ttlMs / 2) publish(st);
    return st.signed;
  }
  const stateOf = (id: string) => { const st = states.get(id); if (!st) throw new Error(`unknown route ${id}`); return st; };

  const server = createServer((req, res) => {
    onRequest(req, res).catch((err) => {
      if (!res.headersSent) send(res, 500, { error: "internal_error", message: (err as Error).message });
      else res.end();
    });
  });
  await new Promise<void>((r) => server.listen(port, host, r));
  const listenUrl = `http://${host}:${(server.address() as AddressInfo).port}`;
  base = cfg.publicUrl?.replace(/\/+$/, "") ?? listenUrl;
  publicUrl = new URL(base);
  for (const route of cfg.routes) { const st = { route, version: 1 } as RouteState; publish(st); states.set(route.id, st); }

  async function onRequest(req: IncomingMessage, res: ServerResponse) {
    const u = new URL(req.url ?? "/", "http://x");
    const method = (req.method ?? "GET").toUpperCase();
    if (method === "GET" && u.pathname === RESERVED.profile) {
      res.writeHead(200, { "content-type": "text/turtle" });
      return res.end(profileTurtle());
    }
    if (method === "GET" && u.pathname.startsWith(RESERVED.offers)) {
      const st = states.get(u.pathname.slice(RESERVED.offers.length));
      if (!st) return send(res, 404, { error: "not_found" });
      const signed = current(st);
      if ((req.headers.accept ?? "").includes("text/turtle")) {
        res.writeHead(200, { "content-type": "text/turtle" });
        return res.end(await offerToTurtle(signed.payload, JSON.stringify(signed.sig)));
      }
      return send(res, 200, signed);
    }
    const body = await readRawBody(req);
    // Matched and forwarded as the same parsed path, so the upstream sees what was classified.
    const pathAndQuery = u.pathname + u.search;
    const m = matchRequest([...states.values()].map((st) => st.route), method, u.pathname);
    if (m.kind === "paid") return paid(req, res, body, stateOf(m.route.id), method, pathAndQuery, `${method} ${pathAndQuery}`);
    if (m.kind === "refused") return send(res, m.status, { error: m.error }, m.headers);
    if (cfg.unconfigured === "passthrough") {
      let up: UpstreamResponse;
      try { up = await forward(req, body, { upstreamBase: cfg.upstream, pathAndQuery, publicUrl, paidRoute: false, timeoutMs }); }
      catch { return send(res, 502, { error: "upstream_unavailable" }); }
      res.writeHead(up.status, up.headers);
      return res.end(up.body);
    }
    send(res, 404, { error: "not_found" });
  }

  async function paid(req: IncomingMessage, res: ServerResponse, body: Buffer, st: RouteState, method: string, pathAndQuery: string, target: string) {
    const o = current(st).payload;
    const repeatable = SAFE_METHODS.has(method);
    // A non-repeatable request is bound to its Idempotency-Key and body. Checked before the
    // credential is looked at, so a request that would be refused never settles a payment.
    let request: RequestClaim | undefined;
    if (!repeatable) {
      const idem = singleHeader(req.headers[IDEMPOTENCY_HEADER]);
      if (!idem || !IDEMPOTENCY_KEY.test(idem)) {
        if (!hasPaymentCredential(req.headers)) return challenge(res, st, o, undefined, repeatable);
        return send(res, 400, { error: "idempotency_key_required", reason: `a paid ${method} needs an ${IDEMPOTENCY_HEADER} header (1-255 visible ASCII characters); a retry must repeat the same request with the same key` });
      }
      const contentType = singleHeader(req.headers["content-type"]) ?? "";
      request = { idempotencyKey: idem, digest: sha256Hex(Buffer.concat([Buffer.from(`${target}\n${contentType}\n`), body])) };
    }
    const a: Acceptance = await acceptor.accept(req.headers, o, { resource: o.resource, target });
    switch (a.kind) {
      case "none": return challenge(res, st, o, undefined, repeatable);
      case "rejected": return a.status === 402 ? challenge(res, st, o, a.reason, repeatable) : send(res, 400, { error: a.reason });
      case "failed": return send(res, a.status, a.body);
      case "paid": {
        // Checked and started with no await in between, so concurrent requests cannot both pass.
        const start = acceptor.book.tryStartDelivery(a.settlement.key, repeatable, request);
        if (start === "consumed") return challenge(res, st, o, "credential_consumed", repeatable);
        if (start === "conflict") return send(res, 409, { error: "idempotency_conflict", paid: true, reason: "this payment is bound to another request (Idempotency-Key and body); repeat that request exactly" }, a.responseHeaders);
        if (start === "busy") return send(res, 409, { error: "delivery_in_progress", paid: true, retry: "re-present the same payment credential once the request in flight has answered" }, a.responseHeaders);
        if (start === "replay") {
          const stored = acceptor.book.storedResponse(a.settlement.key)!;
          res.writeHead(stored.status, { ...stored.headers, [REPLAY_HEADER]: "true" });
          return res.end(stored.body);
        }
        return deliver(req, res, body, pathAndQuery, a.settlement, a.responseHeaders, repeatable);
      }
    }
  }

  async function challenge(res: ServerResponse, st: RouteState, o: Offer, error?: string, repeatable = true) {
    const c = await acceptor.challenge(o, st.route.description, error);
    const note = repeatable ? {} : { idempotencyKey: `required: send the paid request with an ${IDEMPOTENCY_HEADER} header; the payment then serves that one request` };
    send(res, 402, { ...c.body, ...note }, c.headers);
  }

  async function deliver(req: IncomingMessage, res: ServerResponse, body: Buffer, pathAndQuery: string, s: Settlement, paymentHeaders: Record<string, string>, repeatable: boolean) {
    // Started (by the caller, via tryStartDelivery) before the first await: while it runs, the
    // payment cannot move to another target, nor deliver a second non-repeatable request.
    let up: UpstreamResponse | undefined;
    try { up = await forward(req, body, { upstreamBase: cfg.upstream, pathAndQuery, publicUrl, paidRoute: true, paymentReference: `${s.scheme}:${s.railReference}`, timeoutMs }); }
    catch { up = undefined; }
    const outcome = outcomeOf(up);
    if (outcome !== "delivered" || !up) acceptor.book.deliveryEnded(s.key, outcome);
    // Never charge again after this point, and say what happened in a way a client can act on.
    if (outcome === "transient" || !up) {
      return send(res, 502, { error: "upstream_unavailable", paid: true, upstreamStatus: up?.status ?? null, railReference: s.railReference, retry: "re-present the same payment credential" }, paymentHeaders);
    }
    if (outcome === "refused") {
      // The upstream's real answer (a 404's message, a redirect's Location) is what the buyer needs;
      // a 502 would hide it and suggest a retry that cannot succeed.
      const note = { paid: true, delivered: false, upstreamStatus: up.status, railReference: s.railReference, recovery: "present the same credential for another target of this resource" };
      res.writeHead(up.status, { ...up.headers, [OUTCOME_HEADER]: JSON.stringify(note), ...paymentHeaders });
      return res.end(up.body);
    }
    // A fresh receipt per delivery: re-delivered content may differ (e.g. newer data), and the
    // receipt must attest the bytes actually returned. Amount and offer version are what was paid.
    const receipt = signEnvelope(key, {
      receiptId: newId("rcpt-"), seller: webId(), offerId: s.offerId, offerVersion: s.offerVersion, resource: s.binding.resource,
      scheme: s.scheme, amount: s.amount, currency: s.currency, railReference: s.railReference,
      contentDigest: "sha-256:" + sha256Hex(up.body), deliveredAt: new Date().toISOString(),
    } satisfies Receipt);
    deliveries++;
    const headers = { "content-type": "application/octet-stream", ...up.headers, [RECEIPT_HEADER]: b64json.encode(receipt), ...paymentHeaders };
    // Recorded before the answer is written: an identical retry gets this very answer and receipt.
    acceptor.book.deliveryEnded(s.key, "delivered", repeatable ? undefined : { status: up.status, headers, body: up.body });
    res.writeHead(up.status, headers);
    res.end(up.body);
  }

  function profileTurtle() {
    const offers = [...states.values()].map((st) => `<${st.signed.payload.offerId}>`).join(", ");
    return `@prefix schema: <https://schema.org/> .
@prefix sc: <https://w3id.org/solid-commerce#> .
<#org> a schema:Organization ;
  schema:name ${JSON.stringify(cfg.seller.name)} ;
  sc:signingKey ${JSON.stringify(JSON.stringify(key.publicJwk))} ;
  sc:keyId "${key.keyId}"${offers ? ` ;\n  schema:makesOffer ${offers}` : ""} .
`;
  }

  const api: Omit<PaymentProxyHandle, "deliveries" | "settlements"> = {
    url: listenUrl, server,
    close: () => new Promise<void>((r) => { server.closeAllConnections?.(); server.close(() => r()); }),
    webId: webId(), key, payTo, lightningPayee: payees.lightningPayee, merchantId: payees.merchantId,
    offerUrl: (id) => offerUrl(stateOf(id).route.id),
    resourceUrl: (id) => resourceUrl(stateOf(id).route),
    offer: (id) => current(stateOf(id)),
    setPrice(id, prices) {
      const st = stateOf(id);
      const route = { ...st.route, prices: { ...st.route.prices, ...prices } };
      validateRoutes([route]);
      st.route = route; st.version++; publish(st);
      return st.signed;
    },
  };
  return Object.defineProperties(api, {
    deliveries: { get: () => deliveries, enumerable: true },
    settlements: { get: () => acceptor.book.size, enumerable: true },
  }) as PaymentProxyHandle;
}

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}
