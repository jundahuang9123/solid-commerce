/**
 * The 402 proxy in front of a plain node:http upstream that knows nothing
 * about payment. Payments go through the real protected signer, against
 * authorizations signed by a test gateway key (the gateway's own checks are
 * covered in e2e.test.ts), and settle on the simulated rails.
 */
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { startFacilitator, type FacilitatorSim } from "../src/payments/sim/facilitator.js";
import { startLightning, type LightningSim } from "../src/payments/sim/lightning.js";
import { startPsp, type PspSim } from "../src/payments/sim/psp.js";
import { startSigner, type SignerHandle } from "../src/signer/signerService.js";
import { startPaymentProxy, type PaymentProxyConfig, type PaymentProxyHandle } from "../src/proxy/paymentProxy.js";
import { loadKeyMaterial } from "../src/proxy/keys.js";
import { parse402 } from "../src/payments/http402.js";
import { RECEIPT_HEADER, type PaymentAuthorization, type PaymentCredential, type Receipt } from "../src/payments/types.js";
import type { SchemeId, SpendingMandate } from "../src/model.js";
import { digestOf, Ed25519Key, newId, randomHex, sha256Hex, signEnvelope, verifyEnvelope, type Signed } from "../src/util/crypto.js";
import { b64json, postJson } from "../src/util/http.js";
import { offerDigest } from "../src/trust/registry.js";
import { startEnvironment } from "../src/demo/environment.js";

const gatewayKey = Ed25519Key.generate();
const lnAccount = "acct-" + randomHex(4);
const cardToken = "tok_" + randomHex(6);
let facilitator: FacilitatorSim, lightning: LightningSim, psp: PspSim, signer: SignerHandle;
const cleanup: Array<{ close(): Promise<void> }> = [];

before(async () => {
  [facilitator, lightning, psp] = await Promise.all([startFacilitator(), startLightning(), startPsp()]);
  signer = await startSigner({ gatewayPublicJwk: gatewayKey.publicJwk, lightning: { url: lightning.url, accountToken: lnAccount }, card: { token: cardToken, allowedProviders: [psp.url] } });
  facilitator.chain.mint(signer.evmAddress, 100_000_000n);
  lightning.balances.set(lnAccount, 100_000);
  psp.cards.set(cardToken, { limit: 100_000, spent: 0 });
  cleanup.push(facilitator, lightning, psp, signer);
});
after(async () => { await Promise.all(cleanup.map((s) => s.close())); });

/** A plain API that counts hits and records the headers it was sent. */
interface Upstream { url: string; hits: number; seen: IncomingHttpHeaders[]; mode: "ok" | "down" | "error"; close(): Promise<void> }
async function startUpstream(): Promise<Upstream> {
  const u: Upstream = { url: "", hits: 0, seen: [], mode: "ok", close: async () => {} };
  const server: Server = createServer((req, res) => {
    if (u.mode === "down") return req.socket.destroy();
    u.hits++;
    u.seen.push(req.headers);
    if (u.mode === "error") { res.writeHead(500); return res.end("boom"); }
    res.writeHead(200, { "content-type": "application/json", "x-upstream": "yes" });
    res.end(JSON.stringify({ path: req.url, hit: u.hits, at: Date.now() }));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  u.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  u.close = () => new Promise((r) => { server.closeAllConnections(); server.close(() => r()); });
  cleanup.push(u);
  return u;
}

const SAME_PRICES = { x402: "0.01", l402: 10, cardEur: 3 };
async function setup(over: Partial<PaymentProxyConfig> = {}) {
  const upstream = await startUpstream();
  const proxy = await startPaymentProxy({
    // Payee ids derive from the slug and the rails are shared across tests, so keep it unique.
    seller: { name: "Test API", slug: `test-api-${randomHex(3)}` }, upstream: upstream.url,
    rails: { facilitatorUrl: facilitator.url, lightningUrl: lightning.url, pspUrl: psp.url },
    unconfigured: "passthrough",
    routes: [
      // a and b deliberately cost the same, so only the route binding keeps them apart
      { id: "a", path: "/v1/a", category: "Data", coverage: "Berlin", properties: { quality: "high" }, prices: SAME_PRICES, description: "Route A" },
      { id: "b", path: "/v1/b", category: "Data", prices: SAME_PRICES, description: "Route B" },
      { id: "stations", path: "/v1/stations/", prefix: true, category: "Data", prices: { x402: "0.02" }, description: "One station" },
    ],
    ...over,
  });
  cleanup.push(proxy);
  return { upstream, proxy };
}

/** What a buyer does after a 402: get a gateway-style authorization and let the real signer pay. */
async function buy(proxy: PaymentProxyHandle, url: string, scheme: SchemeId): Promise<PaymentCredential> {
  const r = await fetch(url);
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
      assert.deepEqual(charges(proxy), { x402: 0, l402: 0, "card-psp": 0, [scheme]: { x402: 1, l402: 10, "card-psp": 3 }[scheme] });
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
      const paymentsBefore = signer.payments;
      const cred = await buy(proxy, url, scheme);
      const concurrent = await Promise.all([present(url, cred), present(url, cred), present(url, cred)]);
      const again = await present(url, cred);
      assert.deepEqual([...concurrent, again].map((r) => r.status), [200, 200, 200, 200], scheme);
      assert.equal(upstream.hits, 4, "each presentation re-delivers");
      assert.equal(signer.payments - paymentsBefore, 1);
      assert.deepEqual(charges(proxy), { x402: 0, l402: 0, "card-psp": 0, [scheme]: { x402: 1, l402: 10, "card-psp": 3 }[scheme] }, `${scheme}: one charge`);
      assert.equal(proxy.settlements, 1);
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
