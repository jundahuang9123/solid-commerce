/**
 * The 402 proxy in front of a plain node:http upstream that knows nothing
 * about payment. Payments go through the real protected signer, against
 * authorizations signed by a test gateway key (the gateway's own checks are
 * covered in e2e.test.ts), and settle on the simulated rails. The proxy
 * reaches each rail through a tap that records its calls and can fail or
 * hold them, so tests can assert on what the proxy itself sends to the rails.
 */
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { createServer, request as httpRequest, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { getAddress } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { startFacilitator, type FacilitatorSim } from "../src/payments/sim/facilitator.js";
import { startLightning, type LightningSim } from "../src/payments/sim/lightning.js";
import { startPsp, type PspSim } from "../src/payments/sim/psp.js";
import { startSigner, type SignerHandle } from "../src/signer/signerService.js";
import { OUTCOME_HEADER, startPaymentProxy, type PaymentProxyConfig, type PaymentProxyHandle } from "../src/proxy/paymentProxy.js";
import type { PaidRoute } from "../src/proxy/routes.js";
import { loadKeyMaterial } from "../src/proxy/keys.js";
import { PaymentAcceptor, priceOptionsFor } from "../src/payments/serverSide.js";
import { parseL402 } from "../src/payments/schemes/l402.js";
import { parse402 } from "../src/payments/http402.js";
import { RECEIPT_HEADER, type PaymentAuthorization, type PaymentCredential, type Receipt } from "../src/payments/types.js";
import type { Offer, SchemeId, SpendingMandate } from "../src/model.js";
import { digestOf, Ed25519Key, newId, randomHex, sha256Hex, signEnvelope, verifyEnvelope, type Signed } from "../src/util/crypto.js";
import { b64json, postJson } from "../src/util/http.js";
import { offerDigest } from "../src/trust/registry.js";
import { startEnvironment } from "../src/demo/environment.js";

/**
 * An HTTP pass-through in front of a rail. It records "METHOD /path" for every
 * call, can answer 503 for chosen paths, and can hold the next call to a path
 * until released. A lost upstream response is passed on as a lost response.
 */
interface Tap {
  url: string;
  calls: string[];
  failing: Set<string>;
  hold(path: string): { arrived: Promise<void>; release(): void };
  close(): Promise<void>;
}
async function startTap(target: string): Promise<Tap> {
  const holds = new Map<string, { arrived: () => void; gate: Promise<void> }>();
  const t = { url: "", calls: [] as string[], failing: new Set<string>() } as Tap;
  const server = createServer(async (req, res) => {
    const path = new URL(req.url ?? "/", "http://x").pathname;
    t.calls.push(`${req.method} ${path}`);
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    if (t.failing.has(path)) { res.writeHead(503, { "content-type": "text/plain" }); return res.end("tap: failing"); }
    const h = holds.get(path);
    if (h) { holds.delete(path); h.arrived(); await h.gate; }
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string" && !["host", "connection", "content-length"].includes(k)) headers[k] = v;
    let r: Response;
    try { r = await fetch(target + req.url, { method: req.method, headers, body: chunks.length ? Buffer.concat(chunks) : undefined }); }
    catch { return req.socket.destroy(); }
    res.writeHead(r.status, { "content-type": r.headers.get("content-type") ?? "application/json" });
    res.end(Buffer.from(await r.arrayBuffer()));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  t.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  t.hold = (path) => {
    let arrived!: () => void, release!: () => void;
    const a = new Promise<void>((r) => { arrived = r; });
    holds.set(path, { arrived, gate: new Promise<void>((r) => { release = r; }) });
    return { arrived: a, release };
  };
  t.close = () => new Promise((r) => { server.closeAllConnections(); server.close(() => r()); });
  return t;
}

const gatewayKey = Ed25519Key.generate();
const lnAccount = "acct-" + randomHex(4);
const cardToken = "tok_" + randomHex(6);
let facilitator: FacilitatorSim, lightning: LightningSim, psp: PspSim, signer: SignerHandle;
let facTap: Tap, lnTap: Tap, pspTap: Tap;
const cleanup: Array<{ close(): Promise<void> }> = [];

before(async () => {
  [facilitator, lightning, psp] = await Promise.all([startFacilitator(), startLightning(), startPsp()]);
  [facTap, lnTap, pspTap] = await Promise.all([startTap(facilitator.url), startTap(lightning.url), startTap(psp.url)]);
  // The 402's card challenge names the proxy's PSP URL, which is the tap.
  signer = await startSigner({ gatewayPublicJwk: gatewayKey.publicJwk, lightning: { url: lightning.url, accountToken: lnAccount }, card: { token: cardToken, allowedProviders: [psp.url, pspTap.url] } });
  facilitator.chain.mint(signer.evmAddress, 100_000_000n);
  lightning.balances.set(lnAccount, 100_000);
  psp.cards.set(cardToken, { limit: 100_000, spent: 0 });
  cleanup.push(facTap, lnTap, pspTap, facilitator, lightning, psp, signer);
});
after(async () => { await Promise.all(cleanup.map((s) => s.close())); });

/** A plain API that counts hits and records what it was sent. */
interface Upstream { url: string; hits: number; seen: IncomingHttpHeaders[]; paths: string[]; bodies: string[]; mode: "ok" | "down" | "error" | "busy" | "unavailable"; close(): Promise<void> }
/** The upstream's ETag: a request carrying it in If-None-Match gets 304. */
const ETAG = '"v1"';
async function startUpstream(): Promise<Upstream> {
  const u: Upstream = { url: "", hits: 0, seen: [], paths: [], bodies: [], mode: "ok", close: async () => {} };
  const server: Server = createServer(async (req, res) => {
    if (u.mode === "down") return req.socket.destroy();
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    u.hits++;
    u.seen.push(req.headers);
    u.paths.push(req.url ?? "");
    u.bodies.push(Buffer.concat(chunks).toString());
    if (u.mode === "error") { res.writeHead(500); return res.end("boom"); }
    if (u.mode === "unavailable") { res.writeHead(503); return res.end("maintenance"); }
    if (u.mode === "busy") { res.writeHead(429, { "retry-after": "1" }); return res.end("slow down"); }
    if (req.url?.includes("missing")) { res.writeHead(404, { "content-type": "application/json" }); return res.end(JSON.stringify({ error: "no such station" })); }
    if (req.headers["if-none-match"] === ETAG) { res.writeHead(304, { etag: ETAG }); return res.end(); }
    res.writeHead(200, { "content-type": "application/json", "x-upstream": "yes", etag: ETAG });
    res.end(JSON.stringify({ path: req.url, hit: u.hits, at: Date.now() }));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  u.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  u.close = () => new Promise((r) => { server.closeAllConnections(); server.close(() => r()); });
  cleanup.push(u);
  return u;
}

const SAME_PRICES = { x402: "0.01", l402: 10, cardEur: 3 };
const ROUTES: PaidRoute[] = [
  // a and b deliberately cost the same, so only the route binding keeps them apart
  { id: "a", path: "/v1/a", category: "Data", coverage: "Berlin", properties: { quality: "high" }, prices: SAME_PRICES, description: "Route A" },
  { id: "b", path: "/v1/b", category: "Data", prices: SAME_PRICES, description: "Route B" },
  { id: "stations", path: "/v1/stations/", prefix: true, category: "Data", prices: { x402: "0.02" }, description: "One station" },
];
async function setup(over: Partial<PaymentProxyConfig> = {}) {
  const upstream = await startUpstream();
  const proxy = await startPaymentProxy({
    // Payee ids derive from the slug and the rails are shared across tests, so keep it unique.
    seller: { name: "Test API", slug: `test-api-${randomHex(3)}` }, upstream: upstream.url,
    rails: { facilitatorUrl: facTap.url, lightningUrl: lnTap.url, pspUrl: pspTap.url },
    unconfigured: "passthrough",
    routes: ROUTES,
    ...over,
  });
  cleanup.push(proxy);
  return { upstream, proxy };
}

/** What a buyer does after a 402: get a gateway-style authorization and let the real signer pay. */
async function buy(proxy: PaymentProxyHandle, url: string, scheme: SchemeId, method = "GET"): Promise<PaymentCredential> {
  const r = await fetch(url, { method });
  assert.equal(r.status, 402);
  const ch = parse402(r, url);
  const option = ch.options.find((o) => o.scheme === scheme)!;
  assert.ok(option, `402 offers ${scheme}`);
  const now = Date.now();
  const auth: PaymentAuthorization = {
    authId: newId("auth-"), transactionId: newId("tx-"), mandateId: "urn:test:mandate", agentId: "urn:test:agent", seller: proxy.webId,
    offerId: ch.offer!.offerId, offerVersion: ch.offer!.version, offerDigest: ch.offer!.digest, resource: option.resource,
    scheme, amount: option.amount, currency: option.currency, payTo: option.payTo, challengeDigest: digestOf(option.challenge),
    issuedAt: new Date(now).toISOString(), expiresAt: new Date(now + 120_000).toISOString(),
  };
  const pay = await postJson(`${signer.url}/pay`, { authorization: signEnvelope(gatewayKey, auth), challenge: option.challenge });
  assert.equal(pay.status, 200, JSON.stringify(pay.body));
  return pay.body.credential;
}
const present = (url: string, c: PaymentCredential, extra: Record<string, string> = {}) => fetch(url, { headers: { [c.header.name]: c.header.value, ...extra } });
/** The x402 credential with its (unsigned) resource field rewritten. */
function rewriteResource(c: PaymentCredential, url: string): PaymentCredential {
  const p = b64json.decode(c.header.value);
  return { ...c, header: { ...c.header, value: b64json.encode({ ...p, resource: { ...p.resource, url } }) } };
}

/** The x402 credential with its EIP-3009 nonce re-cased: the same bytes32 on chain, the signature still verifies. */
function recaseNonce(c: PaymentCredential): PaymentCredential {
  const p = b64json.decode(c.header.value);
  const nonce: string = p.payload.authorization.nonce;
  const recased = "0x" + nonce.slice(2).toUpperCase();
  assert.notEqual(recased, nonce, "the test nonce has letters to re-case");
  return { ...c, header: { ...c.header, value: b64json.encode({ ...p, payload: { ...p.payload, authorization: { ...p.payload.authorization, nonce: recased } } }) } };
}
/** The x402 credential with its nonce replaced by `nonce`. */
function withNonce(c: PaymentCredential, nonce: string): PaymentCredential {
  const p = b64json.decode(c.header.value);
  return { ...c, header: { ...c.header, value: b64json.encode({ ...p, payload: { ...p.payload, authorization: { ...p.payload.authorization, nonce } } }) } };
}

/**
 * A request sent exactly as given. fetch() normalises the path (dot segments) before sending and
 * refuses an Expect header, so it cannot send what these tests need to send.
 */
function rawRequest(url: string, method: string, path: string, headers: Record<string, string> = {}, body?: string): Promise<{ status: number; headers: IncomingHttpHeaders; body: string }> {
  const u = new URL(url);
  return new Promise((resolve, reject) => {
    const r = httpRequest({ host: u.hostname, port: u.port, method, path, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString() }));
    });
    r.on("error", reject);
    r.end(body);
  });
}

/** Money received by this proxy on each rail. */
function charges(p: PaymentProxyHandle) {
  return {
    x402: facilitator.chain.transfers.filter((t) => t.to === p.payTo).length,
    l402: lightning.balances.get(p.lightningPayee) ?? 0,
    "card-psp": psp.merchantBalances.get(p.merchantId) ?? 0,
  };
}
const SCHEMES: SchemeId[] = ["x402", "l402", "card-psp"];

describe("402 proxy", () => {
  test("unpaid requests get a multi-scheme 402 and never reach the upstream; offers and identity are served", async () => {
    const { upstream, proxy } = await setup();
    const url = proxy.resourceUrl("a");
    assert.ok(url.startsWith(proxy.url), "the offer's resource is the proxy URL");
    const res = await fetch(url);
    assert.equal(res.status, 402);
    const pr = b64json.decode(res.headers.get("payment-required")!);
    const ref = { offerId: proxy.offer("a").payload.offerId, version: 1, digest: offerDigest(proxy.offer("a").payload) };
    assert.deepEqual([pr.x402Version, pr.accepts[0].amount, pr.resource.url], [2, "10000", url]);
    assert.deepEqual(pr.extensions["solid-commerce/offer"], ref);
    assert.deepEqual(JSON.parse(res.headers.get("sc-offer")!), ref);
    assert.match(res.headers.get("www-authenticate")!, /^L402 macaroon=".*", invoice="lnsim1.*", Payment method="card-psp"/);
    assert.match(res.headers.get("link")!, new RegExp(`<${ref.offerId}>; rel="https://w3id.org/solid-commerce#offer"`));
    assert.deepEqual(parse402(res, url).options.map((o) => o.scheme), SCHEMES);
    assert.equal(upstream.hits, 0);

    const offer = await (await fetch(proxy.offerUrl("a"))).json() as Signed<any>;
    assert.ok(verifyEnvelope(offer, proxy.key.publicJwk));
    assert.equal(offer.payload.resource, url);
    const ttl = await (await fetch(proxy.offerUrl("a"), { headers: { accept: "text/turtle" } })).text();
    assert.match(ttl, /schema:Offer/);
    const card = await (await fetch(`${proxy.url}/profile/card`)).text();
    assert.ok(card.includes(proxy.key.keyId) && card.includes(proxy.offer("b").payload.offerId));
    assert.equal((await fetch(`${proxy.url}/offers/nope`)).status, 404);
    assert.equal(upstream.hits, 0);
  });

  test("each scheme pays once, reaches the upstream once, and returns a receipt over the exact bytes", async () => {
    for (const scheme of SCHEMES) {
      const { upstream, proxy } = await setup();
      const url = proxy.resourceUrl("a");
      const cred = await buy(proxy, url, scheme);
      // A client-forged payment marker must not reach the upstream.
      const res = await present(url, cred, { "x-payment-reference": "x402:forged", "x-forwarded-for": "6.6.6.6" });
      assert.equal(res.status, 200, scheme);
      const body = Buffer.from(await res.arrayBuffer());
      assert.equal(upstream.hits, 1, scheme);
      assert.equal(res.headers.get("x-upstream"), "yes");
      const receipt = b64json.decode<Signed<Receipt>>(res.headers.get(RECEIPT_HEADER)!);
      assert.ok(verifyEnvelope(receipt, proxy.key.publicJwk), "receipt signed by the proxy's key");
      assert.equal(receipt.payload.contentDigest, "sha-256:" + sha256Hex(body));
      assert.deepEqual([receipt.payload.scheme, receipt.payload.resource, receipt.payload.offerVersion, receipt.payload.railReference], [scheme, url, 1, cred.railReference]);
      if (scheme === "x402") assert.equal(b64json.decode(res.headers.get("payment-response")!).success, true);

      const seen = upstream.seen[0];
      assert.equal(seen.authorization, undefined, "credentials never reach the upstream");
      assert.equal(seen["payment-signature"], undefined);
      assert.equal(seen["x-payment-reference"], `${scheme}:${cred.railReference}`);
      assert.notEqual(seen["x-forwarded-for"], "6.6.6.6");
      assert.equal(seen["x-forwarded-proto"], "http");
      assert.ok(seen["x-forwarded-host"]);
      assert.deepEqual(charges(proxy), { x402: 0, l402: 0, "card-psp": 0, [scheme]: ({ x402: 1, l402: 10, "card-psp": 3 } as Record<string, number>)[scheme] });
      assert.equal(proxy.deliveries, 1);
    }
  });

  test("a credential paid for one route does not unlock another", async () => {
    for (const scheme of SCHEMES) {
      const { upstream, proxy } = await setup();
      const cred = await buy(proxy, proxy.resourceUrl("a"), scheme);
      const onB = await present(proxy.resourceUrl("b"), cred);
      assert.equal(onB.status, 402, `${scheme} credential for A refused on B`);
      assert.equal(upstream.hits, 0);
      assert.equal((await present(proxy.resourceUrl("a"), cred)).status, 200);
      assert.equal((await present(proxy.resourceUrl("b"), cred)).status, 402, `${scheme}: still refused after A was delivered`);
      assert.equal(upstream.hits, 1);
    }
    // x402's resource field is not signed: rewriting it to B is caught by the payment's binding to A.
    const { upstream, proxy } = await setup();
    const cred = await buy(proxy, proxy.resourceUrl("a"), "x402");
    assert.equal((await present(proxy.resourceUrl("a"), cred)).status, 200);
    const p = b64json.decode(cred.header.value);
    const forged = { ...cred, header: { ...cred.header, value: b64json.encode({ ...p, resource: { ...p.resource, url: proxy.resourceUrl("b") } }) } };
    const r = await present(proxy.resourceUrl("b"), forged);
    assert.equal(r.status, 402);
    assert.equal(((await r.json()) as { error: string }).error, "credential is bound to another resource");
    assert.equal(upstream.hits, 1);
    assert.equal(charges(proxy).x402, 1);
    assert.equal((await fetch(proxy.resourceUrl("a"), { headers: { "payment-signature": "%%%" } })).status, 400);
  });

  test("a re-cased x402 nonce is the same payment: refused on another route and another prefix target, never charged twice", async () => {
    const { upstream, proxy } = await setup();
    const a = proxy.resourceUrl("a"), b = proxy.resourceUrl("b");
    const cred = await buy(proxy, a, "x402");
    assert.equal((await present(a, cred)).status, 200);
    const onB = await present(b, rewriteResource(recaseNonce(cred), b));
    assert.equal(onB.status, 402, "a re-cased nonce does not escape the binding");
    assert.equal(((await onB.json()) as { error: string }).error, "credential is bound to another resource");
    // The re-cased form is the same payment on its own binding: it re-delivers without a charge.
    assert.equal((await present(a, recaseNonce(cred))).status, 200);
    assert.deepEqual(upstream.paths, ["/v1/a", "/v1/a"]);
    assert.equal(charges(proxy).x402, 1, "one charge");
    assert.equal(proxy.settlements, 1);

    const berlin = `${proxy.url}/v1/stations/berlin`, hamburg = `${proxy.url}/v1/stations/hamburg`;
    const st = await buy(proxy, berlin, "x402");
    assert.equal((await present(berlin, st)).status, 200);
    const r = await present(hamburg, recaseNonce(st));
    assert.equal(r.status, 402, "one payment, one station, whatever the nonce's case");
    assert.equal(((await r.json()) as { error: string }).error, "credential is bound to another resource");
    assert.ok(!upstream.paths.includes("/v1/stations/hamburg"));
    assert.equal(charges(proxy).x402, 2, "one charge per bought credential");

    // A nonce that is not a bytes32 hex string is malformed, not a new payment.
    for (const nonce of ["0x1234", "0X" + "ab".repeat(32), "0x" + "zz".repeat(32), "ab".repeat(32) + "00", 42 as unknown as string]) {
      assert.equal((await present(a, withNonce(cred, nonce))).status, 400, String(nonce));
    }
    assert.equal(upstream.hits, 3);
  });

  test("a prefix route charges per request target", async () => {
    const { upstream, proxy } = await setup();
    const berlin = `${proxy.url}/v1/stations/berlin`;
    const unpaid = await fetch(berlin);
    assert.equal(unpaid.status, 402);
    assert.equal(parse402(unpaid, berlin).options[0].resource, proxy.resourceUrl("stations"), "challenges name the offer's resource");
    const cred = await buy(proxy, berlin, "x402");
    assert.equal((await present(berlin, cred)).status, 200);
    assert.equal(upstream.seen[0]["x-payment-reference"], `x402:${cred.railReference}`);
    assert.equal((await present(`${proxy.url}/v1/stations/hamburg`, cred)).status, 402, "one payment, one station");
    assert.equal((await present(berlin, cred)).status, 200);
    assert.equal(upstream.hits, 2);
    assert.equal(charges(proxy).x402, 1);
  });

  test("repeated and concurrent presentation of a credential charges once", async () => {
    for (const scheme of SCHEMES) {
      const { upstream, proxy } = await setup();
      const url = proxy.resourceUrl("a");
      const cred = await buy(proxy, url, scheme);
      // What the proxy itself sends to the rails is what could charge twice, so count that.
      const since = [facTap, lnTap, pspTap].map((t) => t.calls.length);
      const railCalls = () => [facTap, lnTap, pspTap].flatMap((t, i) => t.calls.slice(since[i]));
      const concurrent = await Promise.all([present(url, cred), present(url, cred), present(url, cred)]);
      const afterConcurrent = railCalls().length;
      const again = await present(url, cred);
      assert.deepEqual([...concurrent, again].map((r) => r.status), [200, 200, 200, 200], scheme);
      assert.equal(upstream.hits, 4, "each presentation re-delivers");
      if (scheme === "x402") {
        // One verify and one settle in all: concurrent presentations wait for the one in flight.
        assert.deepEqual(railCalls().sort(), ["POST /settle", "POST /verify"], "x402: the proxy settles once");
      } else {
        // L402's preimage and card's confirmed intent are the proof: the proxy only reads, never charges.
        assert.ok(railCalls().every((c) => c.startsWith("GET /payment_intents/")), `${scheme}: ${railCalls()}`);
      }
      assert.equal(railCalls().length, afterConcurrent, `${scheme}: a settled credential re-delivers without touching the rail`);
      assert.deepEqual(charges(proxy), { x402: 0, l402: 0, "card-psp": 0, [scheme]: ({ x402: 1, l402: 10, "card-psp": 3 } as Record<string, number>)[scheme] }, `${scheme}: one charge`);
      assert.equal(proxy.settlements, 1);
      assert.equal(proxy.deliveries, 4);
    }
  });

  test("upstream failure after payment: 502 paid:true, then recovery with the same credential", async () => {
    for (const scheme of ["x402", "card-psp"] as const) {
      const { upstream, proxy } = await setup();
      const url = proxy.resourceUrl("a");
      const cred = await buy(proxy, url, scheme);
      upstream.mode = "down";
      const r1 = await present(url, cred);
      assert.equal(r1.status, 502);
      const b1 = await r1.json() as { paid: boolean; retry: string };
      assert.equal(b1.paid, true);
      assert.match(b1.retry, /same payment credential/);
      upstream.mode = "error";
      const r2 = await present(url, cred);
      assert.deepEqual([r2.status, ((await r2.json()) as { upstreamStatus: number }).upstreamStatus], [502, 500]);
      upstream.mode = "ok";
      const r3 = await present(url, cred);
      assert.equal(r3.status, 200);
      const receipt = b64json.decode<Signed<Receipt>>(r3.headers.get(RECEIPT_HEADER)!);
      assert.equal(receipt.payload.contentDigest, "sha-256:" + sha256Hex(Buffer.from(await r3.arrayBuffer())));
      assert.equal(charges(proxy)[scheme], scheme === "x402" ? 1 : 3, "no second charge");
      assert.equal(proxy.deliveries, 1);
    }
  });

  test("a lost settlement response is recovered on retry, even after a price change", async () => {
    const { upstream, proxy } = await setup();
    const url = proxy.resourceUrl("a");
    const cred = await buy(proxy, url, "x402");
    facilitator.failNextSettle("timeout-after-settle");
    const r1 = await present(url, cred);
    assert.equal(r1.status, 502);
    assert.equal(((await r1.json()) as { error: string }).error, "settlement_unavailable");
    assert.equal(upstream.hits, 0);
    assert.equal(charges(proxy).x402, 1, "the money moved");
    proxy.setPrice("a", { x402: "0.05" });
    const r2 = await present(url, cred);
    assert.equal(r2.status, 200);
    const receipt = b64json.decode<Signed<Receipt>>(r2.headers.get(RECEIPT_HEADER)!).payload;
    assert.deepEqual([receipt.amount, receipt.offerVersion], ["10000", 1], "receipt states what was paid");
    assert.equal(charges(proxy).x402, 1);
  });

  test("a price change bumps the offer version, re-signs, and refuses credentials for the old price", async () => {
    const { upstream, proxy } = await setup();
    const url = proxy.resourceUrl("a");
    const v1 = proxy.offer("a");
    const cred = await buy(proxy, url, "x402");
    const v2 = proxy.setPrice("a", { x402: "0.03" });
    assert.equal(v2.payload.version, 2);
    assert.ok(verifyEnvelope(v2, proxy.key.publicJwk));
    assert.notEqual(offerDigest(v2.payload), offerDigest(v1.payload));
    assert.deepEqual(v2.payload.prices.map((p) => p.amount), ["30000", "10", "3"], "other prices are kept");
    const res = await fetch(url);
    assert.equal(JSON.parse(res.headers.get("sc-offer")!).version, 2);
    assert.equal(b64json.decode(res.headers.get("payment-required")!).accepts[0].amount, "30000");
    assert.equal((await present(url, cred)).status, 402);
    assert.equal(charges(proxy).x402, 0);
    assert.equal(upstream.hits, 0);
  });

  test("an L402 token is honoured at the price its macaroon was minted for, even after a price change", async () => {
    // x402 moves no money before redemption, so an old-price x402 credential is simply refused
    // (above). An L402 buyer has already paid the invoice, which could only be paid before it
    // expired; the macaroon is the seller's signed quote, so it is honoured at that price.
    const { upstream, proxy } = await setup();
    const url = proxy.resourceUrl("a");
    const cred = await buy(proxy, url, "l402");
    proxy.setPrice("a", { l402: 50 });
    const r = await present(url, cred);
    assert.equal(r.status, 200);
    const receipt = b64json.decode<Signed<Receipt>>(r.headers.get(RECEIPT_HEADER)!).payload;
    assert.deepEqual([receipt.amount, receipt.currency, receipt.offerVersion], ["10", "SAT", 1], "the receipt states the quoted price");
    assert.equal(charges(proxy).l402, 10);
    assert.equal(upstream.hits, 1);
  });

  test("an L402 token bought from a cheap offer never unlocks a pricier one", async () => {
    // Routes that would share a resource URL are refused at configuration: every scheme binds a
    // payment to the resource, so they could not be told apart.
    const route = (id: string, path: string, extra: Partial<PaidRoute> = {}): PaidRoute => ({ id, path, category: "Data", prices: { l402: 1 }, description: id, ...extra });
    for (const routes of [
      [route("cheap", "/v1/x"), route("dear", "/v1/x", { method: "POST", prices: { l402: 5000 } })],
      [route("one", "/v1/s"), route("all", "/v1/s/", { prefix: true })],
      [route("lower", "/v1/x"), route("upper", "/V1/X")],
    ]) await assert.rejects(setup({ routes }), /same resource/, routes.map((r) => r.path).join(" vs "));

    // Below that, the macaroon names its offer, and the acceptor checks it.
    const payees = { payTo: getAddress(privateKeyToAccount(generatePrivateKey()).address), lightningPayee: `ln:t-${randomHex(3)}`, merchantId: `m_t-${randomHex(3)}` };
    const acceptor = new PaymentAcceptor({ rails: { facilitatorUrl: facTap.url, lightningUrl: lnTap.url, pspUrl: pspTap.url }, payees, macaroonRootKey: randomHex(32) });
    const base = { version: 1, seller: "urn:test:seller", sellerName: "S", category: "Data", resource: "http://s.test/v1/x", coverage: "", properties: {}, validUntil: new Date(Date.now() + 60_000).toISOString() };
    const cheap: Offer = { ...base, offerId: "http://s.test/offers/cheap#offer", prices: priceOptionsFor({ l402: 1 }, payees) };
    const dear: Offer = { ...base, offerId: "http://s.test/offers/dear#offer", prices: priceOptionsFor({ l402: 5000 }, payees) };
    const [opt] = parseL402((await acceptor.challenge(cheap, "cheap")).headers["www-authenticate"], cheap.resource);
    const ch = opt.challenge as { macaroon: string; invoice: string };
    const paid = await postJson(`${lightning.url}/pay`, { paymentRequest: ch.invoice }, { "x-account": lnAccount });
    const auth = { authorization: `L402 ${ch.macaroon}:${paid.body.preimage}` };
    const onDear = await acceptor.accept(auth, dear, { resource: dear.resource, target: "POST /v1/x" });
    assert.deepEqual(onDear, { kind: "rejected", status: 402, reason: "L402 rejected: wrong_offer" });
    const onCheap = await acceptor.accept(auth, cheap, { resource: cheap.resource, target: "GET /v1/x" });
    assert.equal(onCheap.kind === "paid" && onCheap.settlement.amount, "1");
  });

  test("an authorization state the facilitator cannot report is 'unknown', never 'unpaid'", async () => {
    const { upstream, proxy } = await setup();
    const url = proxy.resourceUrl("a");
    const cred = await buy(proxy, url, "x402");
    facilitator.failNextSettle("timeout-after-settle");
    assert.equal((await present(url, cred)).status, 502);
    assert.equal(charges(proxy).x402, 1, "the money moved");
    facTap.failing.add("/authorization-state");
    try {
      const r = await present(url, cred);
      const body = await r.json() as { paid: unknown; retry: string };
      assert.equal(r.status, 502, "not a 402: the buyer must not pay again");
      assert.deepEqual([body.paid, body.retry], ["unknown", "re-present the same payment credential"]);
      // The claim is held meanwhile, so the payment cannot be redeemed on another route.
      const elsewhere = await present(proxy.resourceUrl("b"), rewriteResource(cred, proxy.resourceUrl("b")));
      assert.equal(((await elsewhere.json()) as { error: string }).error, "credential is bound to another resource");
    } finally { facTap.failing.delete("/authorization-state"); }
    assert.equal((await present(url, cred)).status, 200, "confirmed once the rail answers");
    assert.equal(charges(proxy).x402, 1);
    assert.deepEqual(upstream.paths, ["/v1/a"]);
  });

  test("a settlement in flight is neither released by a retry nor credited to another binding", async () => {
    const { upstream, proxy } = await setup();
    const a = proxy.resourceUrl("a"), b = proxy.resourceUrl("b");
    const cred = await buy(proxy, a, "x402");
    const settleCalls = () => facTap.calls.filter((c) => c === "POST /settle").length;
    const settlesBefore = settleCalls();
    const held = facTap.hold("/settle");
    const r1 = present(a, cred);
    await held.arrived;
    // While R1's settle is in flight, R2 retries after a price change. If R2 could release R1's
    // claim, R3 (the same credential, resource rewritten) could claim route B, and R1's settlement
    // would then be credited to B as well as delivering A.
    proxy.setPrice("a", { x402: "0.05" });
    const r2 = present(a, cred);
    await Promise.race([r2, delay(300)]);
    const r3 = present(b, rewriteResource(cred, b));
    await Promise.race([r3, delay(300)]);
    held.release();
    const statuses = (await Promise.all([r1, r2, r3])).map((r) => r.status);
    assert.deepEqual(statuses, [200, 200, 402], "A delivered (twice, one payment), B refused");
    assert.ok(!upstream.paths.includes("/v1/b"), "B was never delivered");
    assert.equal(settleCalls() - settlesBefore, 1);
    assert.equal(charges(proxy).x402, 1);
  });

  test("respelled paid paths (case, trailing slash, escapes, empty segments, path parameters) are refused, never passed through", async () => {
    const { upstream, proxy } = await setup();
    // Each of these reaches the paid handler on a common lenient upstream (Express ignores case and
    // a trailing slash; most frameworks decode %XX; Tomcat drops ";params").
    for (const path of ["/v1/a/", "/V1/A", "/v1/A/", "/v1/%61", "/v1//a", "/v1/a;x=1", "/V1/stations/berlin", "/v1//stations/berlin"]) {
      const r = await rawRequest(proxy.url, "GET", path);
      assert.equal(r.status, 404, path);
      assert.equal(r.headers.link, `<${path.toLowerCase().includes("stations") ? "/v1/stations/" : "/v1/a"}>; rel="canonical"`, path);
    }
    // Escapes whose meaning depends on the upstream's decoder are refused on every path.
    for (const path of ["/v1/stations%2fberlin", "/v1/stations/..%2f..%2fv1%2fa", "/v1/%2561", "/free%2fx", "/v1/a%00", "/v1/%zz"]) {
      assert.equal((await rawRequest(proxy.url, "GET", path)).status, 400, path);
    }
    // Dot segments are resolved before matching, and the resolved path is what would be forwarded.
    for (const path of ["/v1/x/../a", "/v1/x/%2e%2e/a", "/free/../v1/a"]) assert.equal((await rawRequest(proxy.url, "GET", path)).status, 402, path);
    assert.equal(upstream.hits, 0);
    assert.equal((await rawRequest(proxy.url, "GET", "/free/../free")).status, 200, "free paths still pass through");
    assert.deepEqual(upstream.paths, ["/free"]);
  });

  test("other methods and the bare prefix of a paid path are refused; a prefix ends at a segment boundary", async () => {
    const { upstream, proxy } = await setup({ routes: [...ROUTES, { id: "st", path: "/v1/st", prefix: true, category: "Data", prices: { x402: "0.01" }, description: "st" }] });
    for (const method of ["HEAD", "POST", "PUT", "OPTIONS"]) {
      const r = await rawRequest(proxy.url, method, "/v1/a");
      assert.deepEqual([r.status, r.headers.allow], [405, "GET"], method);
    }
    assert.equal((await rawRequest(proxy.url, "DELETE", "/v1/stations/berlin")).status, 405);
    assert.equal((await rawRequest(proxy.url, "GET", "/v1/stations")).status, 404, "the prefix without its slash");
    assert.equal(upstream.hits, 0);
    assert.equal((await rawRequest(proxy.url, "GET", "/v1/st/x")).status, 402);
    assert.equal((await rawRequest(proxy.url, "GET", "/v1/st")).status, 402);
    const sibling = await rawRequest(proxy.url, "GET", "/v1/stx");
    assert.equal(sibling.status, 200, "/v1/stx is not under the prefix /v1/st");
    assert.deepEqual(upstream.paths, ["/v1/stx"]);
  });

  test("a paid request with 'Expect: 100-continue' is delivered", async () => {
    const submit: PaidRoute = { id: "submit", method: "POST", path: "/v1/submit", category: "Data", prices: SAME_PRICES, description: "Submit" };
    const { upstream, proxy } = await setup({ routes: [...ROUTES, submit] });
    const url = proxy.resourceUrl("submit");
    const cred = await buy(proxy, url, "x402", "POST");
    const big = "x".repeat(4096); // curl sends Expect: 100-continue for any body over 1 KiB
    const r = await rawRequest(proxy.url, "POST", "/v1/submit", { [cred.header.name]: cred.header.value, expect: "100-continue", "content-type": "text/plain" }, big);
    assert.equal(r.status, 200, r.body);
    assert.equal(upstream.bodies.at(-1), big);
    assert.equal(upstream.seen.at(-1)!.expect, undefined, "Expect is hop-by-hop");
    assert.ok(r.headers[RECEIPT_HEADER], "delivered with a receipt");
    const passthrough = await rawRequest(proxy.url, "POST", "/free", { expect: "100-continue", "content-type": "text/plain" }, big);
    assert.equal(passthrough.status, 200);
  });

  test("a settled credential buys one delivery on a POST route: re-presenting it is refused, a transient failure keeps the retry", async () => {
    const submit: PaidRoute = { id: "submit", method: "POST", path: "/v1/submit", category: "Data", prices: SAME_PRICES, description: "Submit" };
    const post = (url: string, c: PaymentCredential, body: string) => fetch(url, { method: "POST", headers: { [c.header.name]: c.header.value, "content-type": "text/plain" }, body });
    for (const scheme of SCHEMES) {
      const { upstream, proxy } = await setup({ routes: [...ROUTES, submit] });
      const url = proxy.resourceUrl("submit");
      const cred = await buy(proxy, url, scheme, "POST");
      const r1 = await post(url, cred, "first");
      assert.equal(r1.status, 200, scheme);
      assert.ok(r1.headers.get(RECEIPT_HEADER));
      const r2 = await post(url, cred, "second");
      assert.equal(r2.status, 402, `${scheme}: one payment, one POST`);
      assert.equal(((await r2.json()) as { error: string }).error, "credential_consumed", scheme);
      assert.deepEqual(upstream.bodies, ["first"], `${scheme}: the second POST never reached the upstream`);
      assert.equal(proxy.deliveries, 1);

      // Nothing was delivered on a 503, so the same credential may retry until it delivers once.
      const cred2 = await buy(proxy, url, scheme, "POST");
      upstream.mode = "unavailable";
      const f = await post(url, cred2, "retry-me");
      assert.deepEqual([f.status, ((await f.json()) as { paid: boolean }).paid], [502, true], scheme);
      upstream.mode = "ok";
      assert.equal((await post(url, cred2, "retry-me")).status, 200, `${scheme}: retry after 503 delivers`);
      assert.equal((await post(url, cred2, "again")).status, 402, `${scheme}: then it is consumed`);
      assert.deepEqual(upstream.bodies, ["first", "retry-me", "retry-me"], scheme);
      assert.deepEqual(charges(proxy), { x402: 0, l402: 0, "card-psp": 0, [scheme]: 2 * ({ x402: 1, l402: 10, "card-psp": 3 } as Record<string, number>)[scheme] }, `${scheme}: one charge per credential`);
      assert.deepEqual([proxy.settlements, proxy.deliveries], [2, 2]);
    }
  });

  test("concurrent POSTs with one credential deliver at most once", async () => {
    const submit: PaidRoute = { id: "submit", method: "POST", path: "/v1/submit", category: "Data", prices: SAME_PRICES, description: "Submit" };
    const { upstream, proxy } = await setup({ routes: [...ROUTES, submit] });
    const url = proxy.resourceUrl("submit");
    const cred = await buy(proxy, url, "card-psp", "POST");
    const rs = await Promise.all([1, 2, 3].map((i) => fetch(url, { method: "POST", headers: { [cred.header.name]: cred.header.value }, body: `b${i}` })));
    assert.equal(rs.filter((r) => r.status === 200).length, 1, rs.map((r) => r.status).join(","));
    assert.equal(upstream.hits, 1);
  });

  test("a paid target the upstream refuses (404) delivers nothing, says so, and lets the payment move once", async () => {
    const { upstream, proxy } = await setup();
    const typo = `${proxy.url}/v1/stations/missing-typo`, berlin = `${proxy.url}/v1/stations/berlin`;
    const cred = await buy(proxy, typo, "x402");
    const r1 = await present(typo, cred);
    assert.equal(r1.status, 404, "the upstream's own answer, not a 502 asking for a pointless retry");
    assert.deepEqual(await r1.json(), { error: "no such station" });
    assert.equal(r1.headers.get(RECEIPT_HEADER), null);
    const note = JSON.parse(r1.headers.get(OUTCOME_HEADER)!);
    assert.deepEqual([note.paid, note.delivered, note.upstreamStatus, note.railReference], [true, false, 404, cred.railReference]);
    assert.equal(b64json.decode(r1.headers.get("payment-response")!).success, true);

    const r2 = await present(berlin, cred);
    assert.equal(r2.status, 200, "the payment moves to the target the buyer meant");
    const receipt = b64json.decode<Signed<Receipt>>(r2.headers.get(RECEIPT_HEADER)!).payload;
    assert.equal(receipt.resource, proxy.resourceUrl("stations"));
    assert.equal((await present(`${proxy.url}/v1/stations/hamburg`, cred)).status, 402, "once delivered, it stays put");
    assert.equal((await present(typo, cred)).status, 402);
    assert.equal((await present(berlin, cred)).status, 200);
    assert.equal(charges(proxy).x402, 1);
    assert.deepEqual([proxy.settlements, proxy.deliveries], [1, 2]);
  });

  test("upstream answers after payment: no 304 for a paid GET, 4xx relayed, retryable statuses keep the retry path", async () => {
    const { upstream, proxy } = await setup();
    const url = proxy.resourceUrl("a");
    const cred = await buy(proxy, url, "card-psp");
    // The buyer's cache validator would make the upstream answer 304 with no body: nothing to attest.
    const r = await present(url, cred, { "if-none-match": ETAG });
    assert.equal(r.status, 200);
    const receipt = b64json.decode<Signed<Receipt>>(r.headers.get(RECEIPT_HEADER)!).payload;
    assert.equal(receipt.contentDigest, "sha-256:" + sha256Hex(Buffer.from(await r.arrayBuffer())));
    assert.equal(upstream.seen.at(-1)!["if-none-match"], undefined);
    assert.equal((await fetch(`${proxy.url}/free`, { headers: { "if-none-match": ETAG } })).status, 304, "free traffic keeps its caching");

    // An exact route: a query the upstream rejects is relayed, and the payment can move to a good query.
    const cred2 = await buy(proxy, `${url}?id=missing`, "l402");
    const bad = await present(`${url}?id=missing`, cred2);
    assert.deepEqual([bad.status, JSON.parse(bad.headers.get(OUTCOME_HEADER)!).delivered], [404, false]);
    upstream.mode = "busy";
    const busy = await present(`${url}?id=good`, cred2);
    assert.deepEqual([busy.status, ((await busy.json()) as { upstreamStatus: number; paid: boolean }).upstreamStatus], [502, 429], "429 is a retry, not a refusal");
    upstream.mode = "ok";
    assert.equal((await present(`${url}?id=good`, cred2)).status, 200);
    assert.deepEqual(charges(proxy), { x402: 0, l402: 10, "card-psp": 3 });
  });

  test("unconfigured paths follow the configured policy", async () => {
    const { upstream, proxy } = await setup();
    const r = await fetch(`${proxy.url}/free?q=1`, { headers: { authorization: "Bearer upstream-token", "payment-signature": "abc" } });
    assert.equal(r.status, 200);
    assert.equal(r.headers.get(RECEIPT_HEADER), null);
    assert.equal(upstream.seen[0].authorization, "Bearer upstream-token", "the API's own auth passes through");
    assert.equal(upstream.seen[0]["payment-signature"], undefined, "payment credentials never do");
    assert.equal(upstream.seen[0]["x-payment-reference"], undefined);
    const closed = await setup({ unconfigured: "not-found" });
    assert.equal((await fetch(`${closed.proxy.url}/free`)).status, 404);
    assert.equal(closed.upstream.hits, 0);
  });

  test("key material loads from env or file, and missing keys are ephemeral with warnings", async () => {
    const priv = generateKeyPairSync("ed25519").privateKey.export({ format: "jwk" });
    const k = Ed25519Key.fromPrivateJwk(priv);
    const env = { SK: JSON.stringify(priv), PAY: "0x000000000000000000000000000000000000dEaD", MAC: randomHex(32) };
    const loaded = await loadKeyMaterial({ signingJwk: { env: "SK" }, payTo: { env: "PAY" }, macaroonRootKey: { env: "MAC", file: "/nonexistent" } }, ".", env);
    assert.deepEqual([loaded.signingKey.keyId, loaded.payTo, loaded.macaroonRootKey, loaded.warnings], [k.keyId, "0x000000000000000000000000000000000000dEaD", env.MAC, []]);
    const eph = await loadKeyMaterial({ signingJwk: { file: "missing.jwk.json" } }, "/nonexistent-dir", {});
    assert.equal(eph.warnings.length, 3);
    assert.ok(eph.warnings[0].includes(eph.signingKey.keyId) && eph.warnings[0].includes(JSON.stringify(eph.signingKey.publicJwk)));
    await assert.rejects(loadKeyMaterial({ signingJwk: { env: "SK" } }, ".", { SK: JSON.stringify(k.publicJwk) }), /private JWK/);
  });

  test("the ShoppingAssistant still buys end to end from proxied sellers", async () => {
    const e = await startEnvironment();
    cleanup.push(e);
    const spree = e.sellers.spree;
    assert.ok(spree.resourceUrl.startsWith(spree.url) && spree.currentOffer().payload.resource === spree.resourceUrl);
    const a = e.assistant();
    const { ctx, result } = await a.understand("Get me a current Berlin weather report. You may spend up to 1 USDC from approved providers.", e.registry.list().map((s) => s.webId));
    const { confirmed } = await a.confirm([...result.proposals, ...result.questions.flatMap((q) => a.answer(q, 1, ctx))], e.device);
    const m = confirmed.find((r) => r.kind === "mandate") as SpendingMandate;
    const r = await a.purchase({ text: "Get me a current Berlin weather report.", category: "WeatherReport", subject: "Berlin", mandateId: m.id });
    assert.equal(r.status, "completed");
    assert.equal(r.selected?.sellerName, "Spree Weather");
    assert.ok(verifyEnvelope(r.receipt!, spree.key.publicJwk));
    assert.equal(spree.deliveries, 1);
    assert.equal(e.rails.facilitator.chain.balanceOf(spree.payTo), 20_000n);
  });
});
