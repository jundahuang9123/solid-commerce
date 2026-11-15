/**
 * The demo's HTTP server: static client, JSON control API and an SSE stream
 * of the event log. Bound to all interfaces so a phone on the same network
 * can open the approval page.
 *
 *   GET  /                          dashboard          GET /phone      approval device page
 *   GET  /static/<file>             client files       GET /api/qr.svg QR code of the phone URL (token)
 *   GET  /api/events                SSE: the event log from the last reset, then live
 *   GET  /api/info                  mode; with the token, also the phone URL
 *   POST /api/action/<name>         reset · weather.next · weather.autoplay · weather.answer
 *                                   guard.<tamper|price|race|crash|recover|replay|unapproved>
 *                                   shoes.<buy|advance|cancel|accept>
 *   POST /api/approvals/<id>        { approve: boolean, via?: "phone" | "screen" }
 *   POST /api/auto-approve          { on: boolean }
 *   POST /api/record                { name, overwrite? } -> recordings/<name>.json
 *                                   (409 if that file exists and overwrite is not true)
 *
 * Watching needs nothing; every POST needs the session token from the printed
 * URLs (?t=..., sent back as x-demo-token). Anyone on the network can reach
 * the server, and only the presenter and their phone hold the token. The CLI
 * keeps the token across restarts (demoToken), so a restart (for example into
 * --replay) leaves the open dashboard, the phone and the QR code working.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { timingSafeEqual } from "node:crypto";
import { randomHex } from "../util/crypto.js";
import { readBody } from "../util/http.js";
import { RecordingExists, type DemoControls } from "./live.js";
import { qrSvg } from "./qr.js";

const PUBLIC = fileURLToPath(new URL("./public/", import.meta.url));
const TYPES: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".woff2": "font/woff2" };

export interface DemoServer { url: string; port: number; token: string; dashboardUrl: string; phoneUrl: string; server: Server; close(): Promise<void> }

export interface ServeOptions { port?: number; host?: string; token?: string; publicBase?: (port: number) => string }

export async function startDemoServer(demo: DemoControls, opts: ServeOptions = {}): Promise<DemoServer> {
  const token = opts.token ?? randomHex(12);
  // Read once: the client is a fixed set of files, so no path from a request ever reaches the filesystem.
  const files = new Map(readdirSync(PUBLIC).map((f) => [f, readFileSync(join(PUBLIC, f))]));
  const streams = new Set<ServerResponse>();
  let phoneUrl = "";

  const authorized = (req: IncomingMessage, u: URL) => {
    const given = Buffer.from(String(req.headers["x-demo-token"] ?? u.searchParams.get("t") ?? ""));
    const want = Buffer.from(token);
    return given.length === want.length && timingSafeEqual(given, want);
  };

  const server = createServer(async (req, res) => {
    const u = new URL(req.url ?? "/", "http://demo");
    try {
      if (req.method === "GET") return await get(u, req, res);
      if (req.method !== "POST") return send(res, 405, { error: "method_not_allowed" });
      if (!authorized(req, u)) return send(res, 403, { error: "forbidden", reason: "open the dashboard or phone URL printed by the demo (it carries the session token)" });
      const body = await readBody(req);
      const args = body ? JSON.parse(body) as Record<string, unknown> : {};
      return post(u, args, res);
    } catch (e) {
      if (!res.headersSent) send(res, 500, { error: "internal_error", message: (e as Error).message });
    }
  });

  async function get(u: URL, req: IncomingMessage, res: ServerResponse) {
    if (u.pathname === "/" || u.pathname === "/phone") return file(res, u.pathname === "/" ? "index.html" : "phone.html");
    if (u.pathname.startsWith("/static/")) return file(res, u.pathname.slice(8));
    // The phone URL carries the token, so only token holders get it (as text or as a QR code).
    if (u.pathname === "/api/info") return send(res, 200, { mode: demo.mode, authorized: authorized(req, u), phoneUrl: authorized(req, u) ? phoneUrl : undefined });
    if (u.pathname === "/api/qr.svg") {
      if (!authorized(req, u)) return send(res, 403, { error: "forbidden" });
      res.writeHead(200, { "content-type": TYPES[".svg"], "cache-control": "no-store" });
      return res.end(await qrSvg(phoneUrl));
    }
    if (u.pathname === "/api/events") return stream(res);
    send(res, 404, { error: "not_found" });
  }

  function post(u: URL, args: Record<string, unknown>, res: ServerResponse) {
    const action = u.pathname.match(/^\/api\/action\/([a-z]+(?:\.[a-z]+)?)$/);
    if (action) {
      const out = demo.act(action[1], args);
      return out.ok ? send(res, 202, { accepted: action[1] }) : send(res, out.status, { error: out.error });
    }
    const approval = u.pathname.match(/^\/api\/approvals\/([\w-]+)$/);
    if (approval) {
      if (demo.mode === "replay") return send(res, 409, { error: "approvals are part of the recording" });
      const ok = demo.decide(approval[1], args.approve === true, args.via === "phone" ? "phone" : "screen");
      if (ok) return send(res, 200, { decided: approval[1] });
      // Answered meanwhile on the other screen, by auto-approve or by a reset: nothing to do, and not a failure.
      if (demo.wasDecided?.(approval[1])) return send(res, 409, { error: "already decided", alreadyDecided: true });
      return send(res, 404, { error: "no such pending approval" });
    }
    if (u.pathname === "/api/auto-approve") { demo.setAuto(args.on === true); return send(res, 200, { on: args.on === true }); }
    if (u.pathname === "/api/record") {
      if (demo.mode === "replay") return send(res, 409, { error: "cannot record while replaying" });
      try { return send(res, 200, { path: demo.record(String(args.name ?? "session"), { overwrite: args.overwrite === true }) }); }
      // `file` is the name as the server normalised it, so the client's "replace?" names the real file.
      catch (e) { if (e instanceof RecordingExists) return send(res, 409, { error: e.message, exists: true, file: `recordings/${basename(e.path)}` }); throw e; }
    }
    send(res, 404, { error: "not_found" });
  }

  function file(res: ServerResponse, name: string) {
    const content = files.get(name);
    if (!content) return send(res, 404, { error: "not_found" });
    res.writeHead(200, { "content-type": TYPES[extname(name)] ?? "application/octet-stream", "cache-control": "no-cache" });
    res.end(content);
  }

  function stream(res: ServerResponse) {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
    const write = (e: { seq: number }) => res.write(`id: ${e.seq}\ndata: ${JSON.stringify(e)}\n\n`);
    for (const e of demo.log.all()) write(e);
    const unsubscribe = demo.log.subscribe(write);
    // Comments keep proxies and phones in power-saving mode from dropping an idle stream.
    const ping = setInterval(() => res.write(": ping\n\n"), 15_000);
    streams.add(res);
    res.on("close", () => { clearInterval(ping); unsubscribe(); streams.delete(res); });
  }

  await new Promise<void>((r) => server.listen(opts.port ?? 0, opts.host ?? "0.0.0.0", r));
  const port = (server.address() as AddressInfo).port;
  phoneUrl = `${(opts.publicBase ?? ((p: number) => `http://localhost:${p}`))(port)}/phone?t=${token}`;
  return {
    url: `http://localhost:${port}`, port, token, phoneUrl, dashboardUrl: `http://localhost:${port}/?t=${token}`, server,
    close: () => new Promise<void>((r) => { for (const s of streams) s.end(); server.closeAllConnections(); server.close(() => r()); }),
  };
}

/** Where the CLI keeps the session token between runs (gitignored, owner-readable only). */
export const TOKEN_FILE = ".demo-token";

/**
 * The session token: DEMO_TOKEN if set, else the one saved in `dir`/.demo-token
 * by an earlier run, else a new random one saved there. Delete the file (or set
 * DEMO_TOKEN) to change it.
 */
export function demoToken(dir: string, env: Record<string, string | undefined> = process.env): string {
  const given = env.DEMO_TOKEN?.trim();
  if (given !== undefined && given !== "") {
    if (!/^[\w-]{12,}$/.test(given)) throw new Error("DEMO_TOKEN must be at least 12 letters, digits, '-' or '_'");
    return given;
  }
  const file = join(dir, TOKEN_FILE);
  if (existsSync(file)) {
    const saved = readFileSync(file, "utf8").trim();
    if (/^[\w-]{12,}$/.test(saved)) return saved;
  }
  const fresh = randomHex(12);
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, fresh + "\n", { mode: 0o600 });
  chmodSync(file, 0o600);
  return fresh;
}

function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}
