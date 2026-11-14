/**
 * A seller: a plain weather API with no payment code at all, sold through
 * the 402 proxy (src/proxy/) placed in front of it. This is how a real
 * seller would deploy: its API stays unchanged, the proxy adds identity,
 * signed offers, multi-scheme HTTP 402 and signed receipts.
 *
 * Exposed (by the proxy, at the seller's URL):
 *   GET  /profile/card         seller identity (Turtle): name, signing key, offer catalogue
 *   GET  /offers/<slug>        signed offer (JSON envelope; Turtle/schema.org with Accept: text/turtle)
 *   GET  /reports/<slug>       the paid resource. Without payment: HTTP 402 offering x402,
 *                              L402-style and card/PSP challenges together.
 */
import type { Offer, WeatherReport } from "../model.js";
import type { Ed25519Key, Signed } from "../util/crypto.js";
import { json, serve, type RunningServer } from "../util/http.js";
import type { RailUrls, SchemePrices } from "../payments/serverSide.js";
import { startPaymentProxy } from "../proxy/paymentProxy.js";

export interface SellerConfig {
  slug: string;                     // e.g. "spree-weather"
  name: string;
  coverage: string;                 // e.g. "Berlin"
  properties: Record<string, number | string>;
  prices: SchemePrices;             // x402 in USDC major units, l402 in sats, card in euro cents
  rails: RailUrls;
  behaviour?: Partial<SellerBehaviour>;
}
/** How the upstream weather API misbehaves, for tests. The proxy does not know about any of it. */
export interface SellerBehaviour {
  observationAgeMinutes: number;    // how old the delivered data actually is
  failDeliveryTimes: number;        // the upstream answers 503 N times (after payment, since the proxy only forwards paid requests)
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

/** The seller's own API: serves a weather report to whoever asks. Payment is the proxy's job. */
async function startWeatherApi(cfg: SellerConfig, behaviour: () => SellerBehaviour): Promise<RunningServer> {
  return serve((req, res) => {
    if (req.method !== "GET" || new URL(req.url, "http://x").pathname !== `/reports/${cfg.slug}`) return json(res, 404, { error: "not_found" });
    const b = behaviour();
    if (b.failDeliveryTimes > 0) { b.failDeliveryTimes--; return json(res, 503, { error: "temporarily_unavailable" }); }
    const report: WeatherReport = {
      location: b.claimedCoverage ?? cfg.coverage,
      observedAt: new Date(Date.now() - b.observationAgeMinutes * 60_000).toISOString(),
      temperatureC: 11.5, conditions: "light rain", provider: cfg.name,
    };
    json(res, 200, report);
  });
}

export async function startSeller(cfg: SellerConfig, port = 0): Promise<SellerHandle> {
  let behaviour: SellerBehaviour = { observationAgeMinutes: 5, failDeliveryTimes: 0, ...cfg.behaviour };
  const api = await startWeatherApi(cfg, () => behaviour);
  const proxy = await startPaymentProxy({
    seller: { name: cfg.name, slug: cfg.slug },
    upstream: api.url,
    rails: cfg.rails,
    routes: [{
      id: cfg.slug, path: `/reports/${cfg.slug}`, category: "WeatherReport", coverage: cfg.coverage,
      properties: cfg.properties, prices: cfg.prices, description: `${cfg.name}: ${cfg.coverage} weather report`,
    }],
  }, port);

  const handle = {
    url: proxy.url, server: proxy.server,
    close: async () => { await Promise.all([proxy.close(), api.close()]); },
    webId: proxy.webId, key: proxy.key, payTo: proxy.payTo, lightningPayee: proxy.lightningPayee, merchantId: proxy.merchantId,
    offerUrl: proxy.offerUrl(cfg.slug),
    resourceUrl: proxy.resourceUrl(cfg.slug),
    currentOffer: () => proxy.offer(cfg.slug),
    setPrice(p: SellerConfig["prices"]) { proxy.setPrice(cfg.slug, p); },
    setBehaviour(b: Partial<SellerBehaviour>) { behaviour = { ...behaviour, ...b }; },
  };
  return Object.defineProperty(handle, "deliveries", { get: () => proxy.deliveries, enumerable: true }) as SellerHandle;
}
