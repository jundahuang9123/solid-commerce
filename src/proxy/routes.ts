/**
 * Paid-route configuration for the 402 proxy and the matching of requests to
 * routes. A route is what the seller sells: one signed offer, one price list.
 *
 * Matching must be at least as lenient as any upstream router. Requests that
 * match no route may be forwarded free ("passthrough"), and many frameworks
 * ignore a trailing slash or case, or decode %XX before routing. So a
 * request that could reach a paid resource upstream is either the paid route
 * itself, in its configured spelling and method, or refused by the proxy.
 */
import type { SchemePrices } from "../payments/serverSide.js";

export interface PaidRoute {
  /** Stable slug; the offer is served at /offers/<id>. */
  id: string;
  /** HTTP method, default GET. Other methods on the path are refused (405), never passed through. */
  method?: string;
  /** Exact path, or a path prefix when `prefix` is true. */
  path: string;
  /**
   * A prefix route covers every path below `path`, ending at a segment boundary ("/v1/st" covers
   * "/v1/st/x", not "/v1/stx"). It charges per request target (see Binding in src/payments/serverSide.ts).
   */
  prefix?: boolean;
  category: string;
  coverage?: string;
  properties?: Record<string, number | string>;
  prices: SchemePrices;
  description: string;
}

/** Paths the proxy answers itself. A route or upstream path with the same name is shadowed. */
export const RESERVED = { profile: "/profile/card", offers: "/offers/" } as const;

/**
 * Escapes no sold API needs and upstreams decode inconsistently: an encoded "/" or "\" can split a
 * segment, "%25" can be decoded twice, "%00" can truncate. Refused on every path, because whether
 * such a request reaches a paid resource depends on the upstream's decoder.
 */
const AMBIGUOUS = /%(2f|5c|25|00)/i;

export function validateRoutes(routes: PaidRoute[]): void {
  const ids = new Set<string>();
  const resources = new Map<string, string>();
  for (const r of routes) {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(r.id)) throw new Error(`route id "${r.id}" must be a lower-case slug`);
    if (ids.has(r.id)) throw new Error(`duplicate route id "${r.id}"`);
    ids.add(r.id);
    if (!r.path.startsWith("/")) throw new Error(`route ${r.id}: path must start with "/"`);
    // The configured spelling is compared with the parsed request path, so it must be in the form
    // the URL parser produces and contain nothing an upstream could decode differently.
    if (new URL(r.path, "http://x").pathname !== r.path || AMBIGUOUS.test(r.path) || /\/\/|;/.test(r.path)) throw new Error(`route ${r.id}: path ${r.path} is not in normal form`);
    if (r.path === RESERVED.profile || r.path.startsWith(RESERVED.offers)) throw new Error(`route ${r.id}: ${r.path} is reserved by the proxy`);
    // One canonical path, one route. The offer's resource URL is the path and every scheme binds a
    // payment to that resource, so two routes on one path (a cheap GET and a dear POST, or an exact
    // and a prefix route) would let a credential bought for one be presented on the other.
    const c = canonicalPath(r.path);
    const clash = resources.get(c);
    if (clash) throw new Error(`route ${r.id}: path ${r.path} is the same resource as route ${clash}; sell different methods on different paths`);
    resources.set(c, r.id);
    if (!r.prices.x402 && !r.prices.l402 && !r.prices.cardEur) throw new Error(`route ${r.id}: no price configured`);
    if (r.prices.x402 !== undefined && !/^\d+(\.\d{1,6})?$/.test(r.prices.x402)) throw new Error(`route ${r.id}: x402 price must be a USDC decimal string`);
    for (const k of ["l402", "cardEur"] as const) {
      const v = r.prices[k];
      if (v !== undefined && !(Number.isInteger(v) && v > 0)) throw new Error(`route ${r.id}: ${k} price must be a positive integer`);
    }
  }
}

/**
 * The path as a lenient upstream router might see it: percent-decoded, path parameters
 * (";jsessionid=...") dropped, duplicate slashes collapsed, case folded, trailing slash removed.
 * Dot segments (including "%2e%2e") are already resolved by the WHATWG URL parser, and the proxy
 * forwards that parsed path, so the upstream never sees them. Throws on a malformed escape.
 */
export function canonicalPath(pathname: string): string {
  const p = decodeURIComponent(pathname).split("/").map((seg) => seg.split(";")[0]).join("/")
    .replace(/\/{2,}/g, "/").toLowerCase().replace(/\/+$/, "");
  return p || "/";
}

/** Does canonical path `c` fall under route `r`? */
function covers(r: PaidRoute, c: string): boolean {
  const rc = canonicalPath(r.path);
  return c === rc || (Boolean(r.prefix) && (rc === "/" || c.startsWith(rc + "/")));
}

export type RouteMatch =
  | { kind: "paid"; route: PaidRoute }
  /** Not a valid paid request, but it might reach a paid resource upstream: the proxy answers it. */
  | { kind: "refused"; status: 400 | 404 | 405; error: string; headers?: Record<string, string> }
  /** Touches no paid resource: subject to the unconfigured-path policy. */
  | { kind: "unrouted" };

/**
 * Classify a request by its parsed (WHATWG) pathname. The most specific route
 * wins: an exact path beats any prefix, a longer prefix beats a shorter one.
 *
 * A respelling of a paid path ("/V1/A", "/v1/a/", "/v1/%61", "/v1//a") is
 * refused with 404 rather than charged: the buyer pays for the resource the
 * offer names, and the upstream is asked for exactly that path. A HEAD for a
 * GET route is refused with 405 rather than charged, because it would use up
 * the payment's single target without delivering the content.
 */
export function matchRequest(routes: PaidRoute[], method: string, pathname: string): RouteMatch {
  if (AMBIGUOUS.test(pathname)) return { kind: "refused", status: 400, error: "ambiguous_path" };
  let c: string;
  try { c = canonicalPath(pathname); } catch { return { kind: "refused", status: 400, error: "malformed_path" }; }
  const r = routes.filter((x) => covers(x, c))
    .sort((a, b) => Number(Boolean(a.prefix)) - Number(Boolean(b.prefix)) || b.path.length - a.path.length)[0];
  if (!r) return { kind: "unrouted" };
  const allowed = (r.method ?? "GET").toUpperCase();
  if (method.toUpperCase() !== allowed) return { kind: "refused", status: 405, error: "method_not_allowed", headers: { allow: allowed } };
  const spelled = pathname === r.path || (Boolean(r.prefix) && pathname.startsWith(r.path.endsWith("/") ? r.path : r.path + "/"));
  if (!spelled) return { kind: "refused", status: 404, error: "not_found", headers: { link: `<${r.path}>; rel="canonical"` } };
  return { kind: "paid", route: r };
}
