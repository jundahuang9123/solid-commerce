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
 *   anything else         forwarded free ("passthrough") or 404 ("not-found")
 *
 * The upstream is only reached after payment is settled. The receipt's
 * contentDigest is computed over the exact bytes returned to the client.
 * If the upstream fails after settlement the client gets 502 with paid:true;
 * the payment is remembered, so re-presenting the same credential delivers
 * without a second charge.
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
  PaymentAcceptor, priceOptionsFor, type Acceptance, type Payees, type RailUrls, type SchemePrices, type Settlement, type X402Asset,
} from "../payments/serverSide.js";
import { forward, readRawBody, type UpstreamResponse } from "./forward.js";
import { matchRoute, RESERVED, validateRoutes, type PaidRoute } from "./routes.js";

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
    const route = matchRoute([...states.values()].map((st) => st.route), method, u.pathname);
    if (route) return paid(req, res, body, stateOf(route.id), `${method} ${u.pathname}${u.search}`);
    if (cfg.unconfigured === "passthrough") {
      let up: UpstreamResponse;
      try { up = await forward(req, body, { upstreamBase: cfg.upstream, publicUrl, paidRoute: false, timeoutMs }); }
      catch { return send(res, 502, { error: "upstream_unavailable" }); }
      res.writeHead(up.status, up.headers);
      return res.end(up.body);
    }
    send(res, 404, { error: "not_found" });
  }

  async function paid(req: IncomingMessage, res: ServerResponse, body: Buffer, st: RouteState, target: string) {
    const o = current(st).payload;
    const a: Acceptance = await acceptor.accept(req.headers, o, { resource: o.resource, target });
    switch (a.kind) {
      case "none": return challenge(res, st, o);
      case "rejected": return a.status === 402 ? challenge(res, st, o, a.reason) : send(res, 400, { error: a.reason });
      case "failed": return send(res, a.status, a.body);
      case "paid": return deliver(req, res, body, a.settlement, a.responseHeaders);
    }
  }

  async function challenge(res: ServerResponse, st: RouteState, o: Offer, error?: string) {
    const c = await acceptor.challenge(o, st.route.description, error);
    send(res, 402, c.body, c.headers);
  }

  async function deliver(req: IncomingMessage, res: ServerResponse, body: Buffer, s: Settlement, paymentHeaders: Record<string, string>) {
    let up: UpstreamResponse | undefined;
    try { up = await forward(req, body, { upstreamBase: cfg.upstream, publicUrl, paidRoute: true, paymentReference: `${s.scheme}:${s.railReference}`, timeoutMs }); }
    catch { up = undefined; }
    // Only a 2xx counts as delivery. Anything else is the seller's failure after the buyer paid:
    // never charge again, and say so in a way a client can act on.
    if (!up || up.status < 200 || up.status > 299) {
      return send(res, 502, { error: "upstream_unavailable", paid: true, upstreamStatus: up?.status ?? null, railReference: s.railReference, retry: "re-present the same payment credential" }, paymentHeaders);
    }
    // A fresh receipt per delivery: re-delivered content may differ (e.g. newer data), and the
    // receipt must attest the bytes actually returned. Amount and offer version are what was paid.
    const receipt = signEnvelope(key, {
      receiptId: newId("rcpt-"), seller: webId(), offerId: s.offerId, offerVersion: s.offerVersion, resource: s.binding.resource,
      scheme: s.scheme, amount: s.amount, currency: s.currency, railReference: s.railReference,
      contentDigest: "sha-256:" + sha256Hex(up.body), deliveredAt: new Date().toISOString(),
    } satisfies Receipt);
    deliveries++;
    res.writeHead(up.status, { "content-type": "application/octet-stream", ...up.headers, [RECEIPT_HEADER]: b64json.encode(receipt), ...paymentHeaders });
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
