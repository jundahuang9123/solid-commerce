/**
 * "On the wire": every HTTP exchange between the demo's components, observed
 * by wrapping the global fetch of this process. All services of the
 * environment run in-process and talk through fetch, so nothing in the
 * library has to know it is being watched.
 *
 * Who is calling: each component's HTTP server runs its request handlers
 * inside an AsyncLocalStorage scope naming it, so a fetch made while the
 * gateway handles a request is attributed to the gateway. Scenario code runs
 * inside the scope of the agent it plays.
 *
 * Only derived summaries are kept (status, payment headers decoded, a few
 * response fields), never raw bodies: credentials such as card tokens and
 * merchant API keys pass through here and must not reach the log.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import type { Server } from "node:http";
import { parse402 } from "../payments/http402.js";
import { RECEIPT_HEADER } from "../payments/types.js";
import { HEADER_RESPONSE, HEADER_SIGNATURE } from "../payments/schemes/x402.js";
import { b64json } from "../util/http.js";
import { fmt } from "../util/money.js";
import type { EventLog } from "./events.js";

export type Role = "assistant" | "gateway" | "signer" | "seller" | "api" | "rail" | "merchant" | "pod";
export interface Component { id: string; label: string; role: Role }

/** The dashboard's own reads (Pod panel, budget meter) are not part of the story and are not shown. */
export const QUIET = "dashboard";

const actors = new AsyncLocalStorage<string>();
/** Run fn as component `id`: its fetches are drawn as coming from that component. */
export const actAs = <T>(id: string, fn: () => Promise<T>): Promise<T> => actors.run(id, fn);

export const short = (s: string | undefined, n = 10) => (!s ? "" : s.length <= n + 1 ? s : s.slice(0, n) + "…");
const originOf = (u: URL) => `${u.protocol}//${u.hostname === "localhost" ? "127.0.0.1" : u.hostname}:${u.port}`;

export class WireTap {
  private byOrigin = new Map<string, Component>();
  private podRoot?: URL;
  private seq = 0;
  /** URL of the most recent document written to the Pod (any component). */
  lastPodWrite?: string;

  constructor(private readonly log: EventLog) {}

  /** Forget all components (the environment was restarted). */
  clear() { this.byOrigin.clear(); this.podRoot = undefined; this.lastPodWrite = undefined; }

  /** Name the component listening at `url`; with its server, also attribute the fetches it makes. */
  register(url: string, c: Component, server?: Server) {
    this.byOrigin.set(originOf(new URL(url)), c);
    if (server) attribute(server, c.id);
  }

  setPodRoot(url: string) { this.podRoot = new URL(url); }

  components(): Component[] { return [...this.byOrigin.values()]; }

  /** Replace globalThis.fetch. Returns the function that restores it. */
  install(): () => void {
    const original = globalThis.fetch;
    const tap = this;
    globalThis.fetch = async function tapped(input: string | URL | Request, init?: RequestInit): Promise<Response> {
      const from = actors.getStore();
      const url = new URL(input instanceof Request ? input.url : String(input));
      const to = from && from !== QUIET ? tap.lookup(url, from) : undefined;
      if (!to) return original(input, init);
      const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
      const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
      const started = Date.now();
      const base = { id: ++tap.seq, from, to: to.id, method, path: tap.pathOf(url, to), pod: to.role === "pod" };
      const request = requestNotes(headers, typeof init?.body === "string" ? init.body : undefined, url.pathname);
      let res: Response;
      try { res = await original(input, init); }
      catch (err) {
        tap.log.emit("wire", { ...base, status: 0, ms: Date.now() - started, request, response: [`no response: ${(err as Error).message}`] });
        throw err;
      }
      if (to.role === "pod" && method === "PUT" && res.ok) tap.lastPodWrite = url.href;
      tap.log.emit("wire", { ...base, status: res.status, ms: Date.now() - started, request, response: await responseNotes(res, url.href) });
      return res;
    } as typeof fetch;
    return () => { globalThis.fetch = original; };
  }

  private lookup(url: URL, from: string): Component | undefined {
    const c = this.byOrigin.get(originOf(url));
    if (c) return c;
    // The only unnamed local servers are the sellers' own APIs behind their 402 proxies.
    const caller = [...this.byOrigin.values()].find((x) => x.id === from);
    if (caller?.role === "seller" && /^(127\.0\.0\.1|localhost)$/.test(url.hostname)) return { id: `${caller.id}-api`, label: `${caller.label} API`, role: "api" };
    return undefined;
  }

  private pathOf(url: URL, to: Component): string {
    const p = url.pathname + url.search;
    if (to.role === "pod" && this.podRoot && url.href.startsWith(this.podRoot.href)) return "/" + url.href.slice(this.podRoot.href.length);
    return p.length > 90 ? p.slice(0, 89) + "…" : p;
  }
}

function attribute(server: Server, id: string) {
  const listeners = server.listeners("request") as Array<(...a: unknown[]) => void>;
  server.removeAllListeners("request");
  for (const l of listeners) server.on("request", (req, res) => actors.run(id, () => l.call(server, req, res)));
}

/** Payment-relevant request headers and a one-line summary of known request bodies. */
function requestNotes(h: Headers, body: string | undefined, path: string): string[] {
  const out: string[] = [];
  const sig = h.get(HEADER_SIGNATURE);
  if (sig) {
    const p = safe(() => b64json.decode(sig));
    const a = p?.payload?.authorization;
    out.push(a ? `PAYMENT-SIGNATURE  x402 ${p.accepted?.scheme ?? ""}, EIP-3009 ${short(a.from)} → ${short(a.to)}, value ${a.value}, nonce ${short(a.nonce)}` : "PAYMENT-SIGNATURE  present");
  }
  const auth = h.get("authorization");
  if (auth) {
    const [scheme, rest = ""] = auth.split(/\s+/, 2);
    if (/^L402$/i.test(scheme)) { const [mac, pre] = rest.split(":"); out.push(`Authorization  L402 macaroon ${short(mac, 12)} : preimage ${short(pre, 8)}`); }
    else if (/^Payment$/i.test(scheme)) out.push(`Authorization  Payment ${short(rest, 12)} (references the PSP payment intent)`);
    else out.push(`Authorization  ${scheme} [redacted]`);
  }
  const idem = h.get("idempotency-key");
  if (idem) out.push(`Idempotency-Key  ${short(idem, 24)}`);
  const b = body ? safe(() => JSON.parse(body)) : undefined;
  if (b && typeof b === "object") {
    if (b.option && b.transactionId) out.push(`authorize ${short(b.transactionId, 14)} for ${short(b.agentId?.split(":").pop(), 16)}: ${b.option.scheme} ${amount(b.option.amount, b.option.currency)}${b.checkout ? `, checkout ${short(b.checkout.sessionId, 14)}` : ""}${b.offerRef ? `, offer v${b.offerRef.version}` : ""}`);
    else if (b.authorization?.payload?.authId) out.push(`pay against gateway authorization ${short(b.authorization.payload.authId, 14)}`);
    else if (b.result && b.agentId) out.push(`outcome reported: ${b.result}${b.receipt ? " + seller-signed receipt" : ""}`);
    else if (b.payment_data?.token) out.push(`payment_data: delegated token ${short(b.payment_data.token, 8)}`);
    else if (b.token && b.amount !== undefined && /charges/.test(path)) out.push(`charge ${amount(String(b.amount), String(b.currency).toUpperCase())} with token ${short(b.token, 8)}`);
    else if (b.allowance) out.push(`delegate payment: max ${amount(String(b.allowance.max_amount), String(b.allowance.currency).toUpperCase())}, session ${short(b.allowance.checkout_session_id, 14)}`);
    else if (b.paymentPayload) out.push(`EIP-3009 payload, value ${b.paymentPayload.payload?.authorization?.value}`);
    else if (b.fulfillment_address) out.push(`fulfillment_address: ${b.fulfillment_address.city}, ${b.fulfillment_address.country}`);
    else if (b.items) out.push(`items: ${b.items.map((i: any) => `${i.quantity} × ${i.id}`).join(", ")}`);
  }
  return out;
}

/** Decoded payment headers (402 challenges, settlement, receipt) and the key fields of JSON answers. */
async function responseNotes(res: Response, url: string): Promise<string[]> {
  const out: string[] = [];
  if (res.status === 402) {
    const ch = safe(() => parse402(res, url));
    for (const o of ch?.options ?? []) {
      if (o.scheme === "x402") out.push(`PAYMENT-REQUIRED  x402 exact, ${amount(o.amount, o.currency)} → ${short(o.payTo)}`);
      else if (o.scheme === "l402") out.push(`WWW-Authenticate  L402, invoice for ${amount(o.amount, o.currency)}`);
      else out.push(`WWW-Authenticate  Payment card-psp, ${amount(o.amount, o.currency)} (intent ${short(o.railReference, 12)})`);
    }
    if (ch?.offer) out.push(`offer  v${ch.offer.version}, digest ${short(ch.offer.digest, 12)}`);
  }
  const pr = res.headers.get(HEADER_RESPONSE);
  if (pr) { const s = safe(() => b64json.decode(pr)); out.push(s?.success ? `PAYMENT-RESPONSE  settled, tx ${short(s.transaction, 12)}` : `PAYMENT-RESPONSE  ${s?.errorReason ?? "not settled"}`); }
  const rc = res.headers.get(RECEIPT_HEADER);
  if (rc) { const r = safe(() => b64json.decode(rc)); if (r?.payload) out.push(`receipt  ${short(r.payload.receiptId, 14)}, ${amount(r.payload.amount, r.payload.currency)}, signed by ${short(r.sig?.keyId, 16)}`); }
  if (!/json/.test(res.headers.get("content-type") ?? "")) return out;
  const b = safe(async () => JSON.parse(await res.clone().text()));
  const body = await b;
  if (!body || typeof body !== "object") return out;
  if (body.code) out.push(`${body.code}${body.reason || body.message ? ": " + (body.reason ?? body.message) : ""}`);
  else if (typeof body.error === "string") out.push(`${body.error}${body.reason ? ": " + body.reason : ""}`);
  const a = body.authorization?.payload;
  if (a?.authId) out.push(`authorization signed by gateway: ${short(a.authId, 14)}, ${amount(a.amount, a.currency)} → ${short(a.payTo)}, expires ${a.expiresAt?.slice(11, 19)}`);
  if (body.replayed === true) out.push("replayed: same answer as before, nothing new");
  if (body.budget?.available !== undefined) out.push(`budget available ${amount(body.budget.available, body.budget.currency)}`);
  if (body.credential?.scheme) out.push(`credential ${body.credential.scheme}${body.credential.header ? ` (${body.credential.header.name} header)` : ""}`);
  if (body.isValid !== undefined) out.push(`verify: ${body.isValid ? "valid" : body.invalidReason}`);
  if (body.success !== undefined && body.network) out.push(body.success ? `settle: transfer ${short(body.transaction, 12)}` : `settle failed: ${body.errorReason}`);
  if (Array.isArray(body.totals)) { const t = body.totals.find((x: any) => x.type === "total"); if (t) out.push(`checkout ${body.status}, total ${amount(String(t.amount), String(body.currency).toUpperCase())}`); }
  else if (typeof body.status === "string" && !body.code) out.push(`status ${body.status}`);
  if (Array.isArray(body.products)) out.push(`${body.products.length} product(s) in feed`);
  return out;
}

const amount = (atomic: string | undefined, currency: string | undefined) => {
  try { return fmt(String(atomic), String(currency)); } catch { return `${atomic} ${currency}`; }
};

function safe<T>(fn: () => T): T | undefined {
  try {
    const v = fn();
    return v instanceof Promise ? (v.catch(() => undefined) as T) : v;
  } catch { return undefined; }
}
