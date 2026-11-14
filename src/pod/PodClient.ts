/**
 * Minimal Solid Protocol client (LDP over HTTP, Turtle). It works against any
 * Solid server; development uses the Community Solid Server.
 *
 * Pass an authenticated `fetch` (e.g. from @inrupt/solid-client-authn-node with
 * client credentials) to use it against a protected Pod. The default config is
 * open, for local development only.
 */
import N3 from "n3";
import { NS } from "../rdf/namespaces.js";

export type FetchFn = typeof fetch;

export interface PodResource { status: number; text: string; etag?: string }

export class PodError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

export class PodClient {
  constructor(private readonly fetchFn: FetchFn = fetch) {}

  async get(url: string): Promise<PodResource | undefined> {
    const r = await this.fetchFn(url, { headers: { accept: "text/turtle" } });
    if (r.status === 404) return undefined;
    if (!r.ok) throw new PodError(`GET ${url} -> ${r.status}`, r.status);
    return { status: r.status, text: await r.text(), etag: r.headers.get("etag") ?? undefined };
  }

  /**
   * PUT a Turtle document. `ifMatch` gives optimistic concurrency for record
   * revisions. Note: this is not a substitute for an atomic financial ledger.
   */
  async putTurtle(url: string, turtle: string, opts: { ifMatch?: string; ifNoneMatch?: boolean } = {}): Promise<void> {
    const headers: Record<string, string> = { "content-type": "text/turtle" };
    if (opts.ifMatch) headers["if-match"] = opts.ifMatch;
    if (opts.ifNoneMatch) headers["if-none-match"] = "*";
    const r = await this.fetchFn(url, { method: "PUT", headers, body: turtle });
    if (!r.ok) throw new PodError(`PUT ${url} -> ${r.status} ${await r.text()}`, r.status);
  }

  async delete(url: string): Promise<void> {
    const r = await this.fetchFn(url, { method: "DELETE" });
    if (!r.ok && r.status !== 404) throw new PodError(`DELETE ${url} -> ${r.status}`, r.status);
  }

  /** List the members of an LDP container (empty if the container does not exist). */
  async list(containerUrl: string): Promise<string[]> {
    const res = await this.get(containerUrl);
    if (!res) return [];
    const store = new N3.Store(new N3.Parser({ baseIRI: containerUrl }).parse(res.text));
    return store
      .getObjects(N3.DataFactory.namedNode(containerUrl), N3.DataFactory.namedNode(NS.ldp + "contains"), null)
      .map((t) => t.value)
      .sort();
  }
}
