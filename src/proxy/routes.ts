/**
 * Paid-route configuration for the 402 proxy and the matching of requests to
 * routes. A route is what the seller sells: one signed offer, one price list.
 */
import type { SchemePrices } from "../payments/serverSide.js";

export interface PaidRoute {
  /** Stable slug; the offer is served at /offers/<id>. */
  id: string;
  /** HTTP method, default GET. */
  method?: string;
  /** Exact path, or a path prefix when `prefix` is true. */
  path: string;
  /** A prefix route charges per request target under the path (see Binding in src/payments/serverSide.ts). */
  prefix?: boolean;
  category: string;
  coverage?: string;
  properties?: Record<string, number | string>;
  prices: SchemePrices;
  description: string;
}

/** Paths the proxy answers itself. A route or upstream path with the same name is shadowed. */
export const RESERVED = { profile: "/profile/card", offers: "/offers/" } as const;

export function validateRoutes(routes: PaidRoute[]): void {
  const ids = new Set<string>();
  for (const r of routes) {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(r.id)) throw new Error(`route id "${r.id}" must be a lower-case slug`);
    if (ids.has(r.id)) throw new Error(`duplicate route id "${r.id}"`);
    ids.add(r.id);
    if (!r.path.startsWith("/")) throw new Error(`route ${r.id}: path must start with "/"`);
    if (r.path === RESERVED.profile || r.path.startsWith(RESERVED.offers)) throw new Error(`route ${r.id}: ${r.path} is reserved by the proxy`);
    if (!r.prices.x402 && !r.prices.l402 && !r.prices.cardEur) throw new Error(`route ${r.id}: no price configured`);
    if (r.prices.x402 !== undefined && !/^\d+(\.\d{1,6})?$/.test(r.prices.x402)) throw new Error(`route ${r.id}: x402 price must be a USDC decimal string`);
    for (const k of ["l402", "cardEur"] as const) {
      const v = r.prices[k];
      if (v !== undefined && !(Number.isInteger(v) && v > 0)) throw new Error(`route ${r.id}: ${k} price must be a positive integer`);
    }
  }
}

/** The most specific matching route: an exact path beats any prefix, a longer prefix beats a shorter one. */
export function matchRoute(routes: PaidRoute[], method: string, pathname: string): PaidRoute | undefined {
  const m = method.toUpperCase();
  const candidates = routes.filter((r) => (r.method ?? "GET").toUpperCase() === m && (r.prefix ? pathname.startsWith(r.path) : pathname === r.path));
  return candidates.sort((a, b) => Number(Boolean(a.prefix)) - Number(Boolean(b.prefix)) || b.path.length - a.path.length)[0];
}
