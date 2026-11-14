/**
 * Forwarding a request to the upstream API, with header hygiene.
 *
 * The upstream must never see a payment credential: it may log headers, and
 * a credential that leaks from there could be replayed against the proxy. It
 * also must not be able to trust a payment marker the client forged, so
 * X-Payment-Reference and X-Forwarded-* are always set by the proxy, never
 * passed through.
 */
import type { IncomingMessage } from "node:http";
import { isPaymentAuthorization, PAYMENT_HEADERS } from "../payments/serverSide.js";

/** RFC 9110 §7.6.1 hop-by-hop headers, plus ones the proxy recomputes. */
const HOP_BY_HOP = ["connection", "keep-alive", "proxy-connection", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade", "host", "content-length"];
/**
 * Request headers only this hop acts on. Node's server has already answered "Expect: 100-continue"
 * and read the body; fetch() refuses to send Expect at all, so relaying it would fail every
 * request that carries it (curl adds it to any body over 1 KiB), paid ones after settlement.
 */
const REQUEST_DROP = ["expect"];
/**
 * Validators that turn a GET into a 304 with no body. A paid GET buys the representation and its
 * receipt attests the bytes returned, so the upstream is always asked for the full content.
 * (If-Match / If-Unmodified-Since are kept: on writes they guard against lost updates.)
 */
const PAID_GET_DROP = ["if-none-match", "if-modified-since", "if-range"];
const PROXY_SET = ["x-forwarded-for", "x-forwarded-host", "x-forwarded-proto", "x-payment-reference", "forwarded"];
/** Response headers the proxy must not relay: the body is re-sent decoded and re-framed. */
const RESPONSE_DROP = [...HOP_BY_HOP, "content-encoding"];

export interface UpstreamResponse { status: number; headers: Record<string, string | string[]>; body: Buffer }

export async function readRawBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks);
}

/**
 * Forward `req` to `upstreamBase` + `pathAndQuery`. The caller passes the
 * path it matched routes against, so the upstream is asked for exactly the
 * path the proxy classified, never a raw spelling it could interpret differently.
 * Payment credentials are always removed. On a paid route the Authorization
 * header is removed whatever it holds; on free pass-through traffic it is kept
 * unless it is a payment credential, since it then belongs to the upstream's
 * own auth.
 */
export async function forward(req: IncomingMessage, body: Buffer, opts: {
  upstreamBase: string; pathAndQuery: string; publicUrl: URL; paidRoute: boolean; paymentReference?: string; timeoutMs: number;
}): Promise<UpstreamResponse> {
  const url = opts.upstreamBase.replace(/\/+$/, "") + opts.pathAndQuery;
  const method = (req.method ?? "GET").toUpperCase();
  const drop = new Set([...HOP_BY_HOP, ...REQUEST_DROP, ...PROXY_SET, ...PAYMENT_HEADERS]);
  if (opts.paidRoute && method === "GET") for (const h of PAID_GET_DROP) drop.add(h);
  if (opts.paidRoute || isPaymentAuthorization(String(req.headers.authorization ?? ""))) drop.add("authorization");
  // Headers named in Connection are hop-by-hop too.
  for (const n of String(req.headers.connection ?? "").split(",")) if (n.trim()) drop.add(n.trim().toLowerCase());
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (v === undefined || drop.has(k)) continue;
    for (const x of Array.isArray(v) ? v : [v]) headers.append(k, x);
  }
  // fetch() would transparently decode a compressed body; ask for identity so the bytes the
  // receipt digests are the bytes the upstream produced.
  headers.set("accept-encoding", "identity");
  headers.set("x-forwarded-for", req.socket.remoteAddress ?? "");
  headers.set("x-forwarded-host", req.headers.host ?? opts.publicUrl.host);
  headers.set("x-forwarded-proto", opts.publicUrl.protocol.replace(":", ""));
  if (opts.paymentReference) headers.set("x-payment-reference", opts.paymentReference);

  const r = await fetch(url, {
    method, headers, redirect: "manual", signal: AbortSignal.timeout(opts.timeoutMs),
    body: method === "GET" || method === "HEAD" || body.length === 0 ? undefined : new Uint8Array(body),
  });
  const out: Record<string, string | string[]> = {};
  r.headers.forEach((v, k) => { if (!RESPONSE_DROP.includes(k) && k !== "set-cookie") out[k] = v; });
  const cookies = r.headers.getSetCookie();
  if (cookies.length) out["set-cookie"] = cookies;
  return { status: r.status, headers: out, body: Buffer.from(await r.arrayBuffer()) };
}
