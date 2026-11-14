import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export type Handler = (req: IncomingMessage & { body: string; url: string }, res: ServerResponse) => Promise<unknown> | unknown;

export async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

export function json(res: ServerResponse, status: number, body: unknown, headers: Record<string, string | string[]> = {}) {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}

export interface RunningServer { url: string; server: Server; close(): Promise<void> }

/** Minimal HTTP server helper. port 0 = pick a free port. */
export async function serve(handler: Handler, port = 0, host = "127.0.0.1"): Promise<RunningServer> {
  const server = createServer(async (req, res) => {
    try {
      const body = await readBody(req);
      await handler(Object.assign(req, { body, url: req.url ?? "/" }), res);
    } catch (err) {
      if (!res.headersSent) json(res, 500, { error: "internal_error", message: (err as Error).message });
      else res.end();
    }
  });
  await new Promise<void>((r) => server.listen(port, host, r));
  const { port: p } = server.address() as AddressInfo;
  return {
    url: `http://${host}:${p}`,
    server,
    close: () => new Promise<void>((r) => { server.closeAllConnections?.(); server.close(() => r()); }),
  };
}

export async function postJson<T = any>(url: string, body: unknown, headers: Record<string, string> = {}): Promise<{ status: number; body: T }> {
  const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  const text = await r.text();
  return { status: r.status, body: (text ? JSON.parse(text) : undefined) as T };
}

export const b64json = {
  encode: (v: unknown) => Buffer.from(JSON.stringify(v), "utf8").toString("base64"),
  decode: <T = any>(s: string): T => JSON.parse(Buffer.from(s, "base64").toString("utf8")),
};
