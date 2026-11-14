/**
 * A seller service exposing:
 *   GET  /profile/card         seller identity (Turtle): name, signing key, offer catalogue
 *   GET  /offers/<slug>        signed offer (JSON envelope; Turtle/schema.org with Accept: text/turtle)
 *   GET  /reports/<slug>       the paid resource. Without payment: HTTP 402 offering x402,
 *                              L402-style and card/PSP challenges together.
 *
 * Inventory, search and checkout would be separate services in production.
 * They are kept in-process here for the prototype.
 */
import { getAddress } from "viem";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import type { Offer, PriceOption, WeatherReport } from "../model.js";
import { Ed25519Key, newId, randomHex, sha256Hex, signEnvelope, type Signed } from "../util/crypto.js";
import { b64json, json, postJson, serve, type RunningServer } from "../util/http.js";
import { offerToTurtle } from "../rdf/records.js";
import { offerDigest } from "../trust/registry.js";
import { OFFER_LINK_REL, RECEIPT_HEADER, type OfferRef, type Receipt } from "../payments/types.js";
import {
  buildPaymentRequired, DEFAULT_NETWORK, DEFAULT_USDC, HEADER_REQUIRED, HEADER_RESPONSE, HEADER_SIGNATURE,
  type PaymentPayload, type PaymentRequirements, type SettleResponse,
} from "../payments/schemes/x402.js";
import { l402Challenge, mintMacaroon, verifyL402 } from "../payments/schemes/l402.js";
import { paymentChallenge } from "../payments/schemes/cardPsp.js";

export interface SellerConfig {
  slug: string;                     // e.g. "spree-weather"
  name: string;
  coverage: string;                 // e.g. "Berlin"
  properties: Record<string, number | string>;
  prices: { x402?: string; l402?: number; cardEur?: number }; // x402 in USDC major units, l402 in sats, card in euro cents
  rails: { facilitatorUrl: string; lightningUrl: string; pspUrl: string };
  behaviour?: Partial<SellerBehaviour>;
}
export interface SellerBehaviour {
  observationAgeMinutes: number;    // how old the delivered data actually is
  failDeliveryTimes: number;        // respond 503 after successful payment N times
  claimedCoverage?: string;         // deliver data for a different city than promised
}

export interface SellerHandle extends RunningServer {
  webId: string;
  key: Ed25519Key;
  payTo: string;
  lightningPayee: string;
  merchantId: string;
  offerUrl: string;
  resourceUrl: string;
  currentOffer(): Signed<Offer>;
  setPrice(p: SellerConfig["prices"]): void;
  setBehaviour(b: Partial<SellerBehaviour>): void;
  deliveries: number;
}

export async function startSeller(cfg: SellerConfig, port = 0): Promise<SellerHandle> {
  const key = Ed25519Key.generate();
  const payTo = privateKeyToAccount(generatePrivateKey()).address;
  const macaroonRootKey = randomHex(32);
  const lightningPayee = `ln:${cfg.slug}`;
  const merchantId = `m_${cfg.slug}`;
  let behaviour: SellerBehaviour = { observationAgeMinutes: 5, failDeliveryTimes: 0, ...cfg.behaviour };
  let prices = { ...cfg.prices };
  let version = 1;
  let signedOffer: Signed<Offer>;
  /** Payments already settled: rail reference -> receipt. Lets a paid client re-fetch without paying twice. */
  const settled = new Map<string, Signed<Receipt>>();
  let base = "";
  let deliveries = 0;

  const srv = await serve(async (req, res) => {
    const u = new URL(req.url, base);
    const webId = `${base}/profile/card#org`;
    if (req.method === "GET" && u.pathname === "/profile/card") {
      res.writeHead(200, { "content-type": "text/turtle" });
      return res.end(`@prefix schema: <https://schema.org/> .
@prefix sc: <https://w3id.org/solid-commerce#> .
<#org> a schema:Organization ;
  schema:name "${cfg.name}" ;
  sc:signingKey ${JSON.stringify(JSON.stringify(key.publicJwk))} ;
  sc:keyId "${key.keyId}" ;
  schema:makesOffer <${signedOffer.payload.offerId}> .
`);
    }
    if (req.method === "GET" && u.pathname === `/offers/${cfg.slug}`) {
      if ((req.headers.accept ?? "").includes("text/turtle")) {
        res.writeHead(200, { "content-type": "text/turtle" });
        return res.end(await offerToTurtle(signedOffer.payload, JSON.stringify(signedOffer.sig)));
      }
      return json(res, 200, signedOffer);
    }
    if (req.method === "GET" && u.pathname === `/reports/${cfg.slug}`) return handlePaidResource(req, res, webId);
    json(res, 404, { error: "not_found" });
  }, port);
  base = srv.url;

  const offerRef = (): OfferRef => ({ offerId: signedOffer.payload.offerId, version: signedOffer.payload.version, digest: offerDigest(signedOffer.payload) });
  const resourceUrl = () => `${base}/reports/${cfg.slug}`;
  const x402Requirements = (): PaymentRequirements | undefined => {
    const p = signedOffer.payload.prices.find((x) => x.scheme === "x402");
    return p && { scheme: "exact", network: p.network!, asset: p.asset!, amount: p.amount, payTo: p.payTo!, maxTimeoutSeconds: 120, extra: { name: "USDC", version: "2" } };
  };

  function publishOffer() {
    const priceOptions: PriceOption[] = [];
    if (prices.x402) {
      const atomic = (BigInt(Math.round(Number(prices.x402) * 1e6))).toString();
      priceOptions.push({ scheme: "x402", amount: atomic, currency: "USDC", network: DEFAULT_NETWORK, asset: DEFAULT_USDC, payTo: getAddress(payTo) });
    }
    if (prices.l402) priceOptions.push({ scheme: "l402", amount: String(prices.l402), currency: "SAT", merchantId: lightningPayee, payTo: lightningPayee });
    if (prices.cardEur) priceOptions.push({ scheme: "card-psp", amount: String(prices.cardEur), currency: "EUR", merchantId, payTo: merchantId });
    const offer: Offer = {
      offerId: `${base}/offers/${cfg.slug}#offer`, version, seller: `${base}/profile/card#org`, sellerName: cfg.name,
      category: "WeatherReport", resource: resourceUrl(), coverage: cfg.coverage, properties: cfg.properties,
      prices: priceOptions, validUntil: new Date(Date.now() + 3600_000).toISOString(),
    };
    signedOffer = signEnvelope(key, offer);
  }
  publishOffer();

  async function deliver(res: import("node:http").ServerResponse, scheme: Receipt["scheme"], railReference: string, extraHeaders: Record<string, string>) {
    if (behaviour.failDeliveryTimes > 0) {
      behaviour.failDeliveryTimes--;
      return json(res, 503, { error: "temporarily_unavailable", paid: true, retry: "re-present the same payment credential" }, extraHeaders);
    }
    const now = Date.now();
    const report: WeatherReport = {
      location: behaviour.claimedCoverage ?? cfg.coverage,
      observedAt: new Date(now - behaviour.observationAgeMinutes * 60_000).toISOString(),
      temperatureC: 11.5, conditions: "light rain", provider: cfg.name,
    };
    const body = JSON.stringify(report);
    let receipt = settled.get(railReference);
    if (!receipt) {
      const opt = signedOffer.payload.prices.find((p) => p.scheme === scheme)!;
      receipt = signEnvelope(key, {
        receiptId: newId("rcpt-"), seller: signedOffer.payload.seller, offerId: signedOffer.payload.offerId, offerVersion: signedOffer.payload.version,
        resource: resourceUrl(), scheme, amount: opt.amount, currency: opt.currency, railReference,
        contentDigest: "sha-256:" + sha256Hex(body), deliveredAt: new Date(now).toISOString(),
      } satisfies Receipt);
      settled.set(railReference, receipt);
    }
    deliveries++;
    res.writeHead(200, { "content-type": "application/json", [RECEIPT_HEADER]: b64json.encode(receipt), ...extraHeaders });
    res.end(body);
  }

  async function handlePaidResource(req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse, _webId: string) {
    const auth = (req.headers.authorization as string | undefined) ?? "";
    const x402Header = req.headers[HEADER_SIGNATURE] as string | undefined;

    // ---- x402
    if (x402Header) {
      const reqs = x402Requirements();
      let payload: PaymentPayload;
      try { payload = b64json.decode<PaymentPayload>(x402Header); } catch { return json(res, 400, { error: "malformed_payment" }); }
      const ref = payload.payload?.authorization?.nonce;
      if (ref && settled.has(ref)) return deliver(res, "x402", ref, {}); // already paid: re-deliver, never re-charge
      if (!reqs || payload.accepted?.amount !== reqs.amount || getAddress(payload.accepted.payTo) !== getAddress(reqs.payTo)) {
        return send402(res, "Payment does not match the current offer");
      }
      const v = await postJson(cfg.rails.facilitatorUrl + "/verify", { x402Version: 2, paymentPayload: payload, paymentRequirements: reqs });
      if (!v.body?.isValid) {
        // Every other check passed but the nonce is spent: an earlier settlement may have
        // succeeded with its response lost. Check the token's authorization state.
        if (v.body?.invalidReason === "nonce_already_used" && (await nonceSettled(payload))) return deliver(res, "x402", ref, {});
        return send402(res, `Payment invalid: ${v.body?.invalidReason}`);
      }
      let s: { status: number; body: SettleResponse };
      try { s = await postJson<SettleResponse>(cfg.rails.facilitatorUrl + "/settle", { x402Version: 2, paymentPayload: payload, paymentRequirements: reqs }); }
      catch { return json(res, 502, { error: "settlement_unavailable", retry: "re-present the same payment credential" }); }
      if (!s.body?.success) {
        // A concurrent request with the same credential settled first: re-deliver, never re-charge.
        if (s.body?.errorReason === "nonce_already_used" && (await nonceSettled(payload))) return deliver(res, "x402", ref, {});
        return json(res, 502, { error: "settlement_failed", reason: s.body?.errorReason });
      }
      return deliver(res, "x402", ref, { [HEADER_RESPONSE]: b64json.encode(s.body) });
    }

    // ---- L402
    if (/^L402\s/i.test(auth)) {
      const v = verifyL402(macaroonRootKey, auth, resourceUrl());
      if (!v.ok) return send402(res, `L402 rejected: ${v.reason}`);
      return deliver(res, "l402", v.caveats.paymentHash, {});
    }

    // ---- card / PSP
    if (/^Payment\s/i.test(auth)) {
      const { id } = JSON.parse(Buffer.from(auth.slice(8).trim(), "base64url").toString()) as { id: string };
      if (settled.has(id)) return deliver(res, "card-psp", id, {});
      const intent = await (await fetch(`${cfg.rails.pspUrl}/payment_intents/${id}`)).json() as { status: string; merchant: string; resource: string; amount: number };
      const opt = signedOffer.payload.prices.find((p) => p.scheme === "card-psp");
      if (intent.status !== "succeeded" || intent.merchant !== merchantId || intent.resource !== resourceUrl() || String(intent.amount) !== opt?.amount) {
        return send402(res, "Payment intent not settled for this resource");
      }
      return deliver(res, "card-psp", id, {});
    }
    return send402(res);
  }

  async function nonceSettled(p: PaymentPayload): Promise<boolean> {
    const a = p.payload.authorization;
    const r = await fetch(`${cfg.rails.facilitatorUrl}/authorization-state?authorizer=${a.from}&nonce=${a.nonce}`);
    return r.ok && Boolean(((await r.json()) as { used: boolean }).used);
  }

  async function send402(res: import("node:http").ServerResponse, error?: string) {
    const o = signedOffer.payload;
    const headers: Record<string, string | string[]> = {
      link: `<${o.offerId}>; rel="${OFFER_LINK_REL}"`,
      "sc-offer": JSON.stringify(offerRef()),
    };
    const challenges: string[] = [];
    const reqs = x402Requirements();
    if (reqs) headers[HEADER_REQUIRED] = b64json.encode(buildPaymentRequired(resourceUrl(), reqs, offerRef(), `${cfg.name}: ${cfg.coverage} weather report`));
    const l = o.prices.find((p) => p.scheme === "l402");
    if (l) {
      const inv = await postJson(cfg.rails.lightningUrl + "/invoices", { amountSat: Number(l.amount), payee: lightningPayee, memo: o.offerId });
      const mac = mintMacaroon(macaroonRootKey, { paymentHash: inv.body.paymentHash, resource: resourceUrl(), amountSat: Number(l.amount), expiresAt: Date.now() + 600_000, offerId: o.offerId, offerVersion: o.version });
      challenges.push(l402Challenge(mac, inv.body.paymentRequest));
    }
    const c = o.prices.find((p) => p.scheme === "card-psp");
    if (c) {
      const pi = await postJson(cfg.rails.pspUrl + "/payment_intents", { amount: Number(c.amount), currency: c.currency, merchant: merchantId, resource: resourceUrl() });
      challenges.push(paymentChallenge({ id: pi.body.id, amount: Number(c.amount), currency: c.currency, merchant: merchantId, provider: cfg.rails.pspUrl }));
    }
    if (challenges.length) headers["www-authenticate"] = challenges.join(", ");
    json(res, 402, { error: error ?? "payment_required", offer: offerRef(), accepts: o.prices.map((p) => p.scheme) }, headers);
  }

  const handle = Object.assign(srv, {
    webId: `${base}/profile/card#org`, key, payTo: getAddress(payTo), lightningPayee, merchantId,
    offerUrl: `${base}/offers/${cfg.slug}`,
    resourceUrl: resourceUrl(),
    currentOffer: () => signedOffer,
    setPrice(p: SellerConfig["prices"]) { prices = { ...prices, ...p }; version++; publishOffer(); },
    setBehaviour(b: Partial<SellerBehaviour>) { behaviour = { ...behaviour, ...b }; },
  });
  return Object.defineProperty(handle, "deliveries", { get: () => deliveries, enumerable: true }) as SellerHandle;
}

