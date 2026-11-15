/**
 * Ollama's native REST API (POST /api/chat, stream:false) with structured
 * outputs: "format" carries the JSON schema and the server constrains
 * decoding to it. No SDK is needed for one JSON round trip.
 *
 * Ollama's documentation also recommends putting the schema in the prompt to
 * ground smaller models, so it is sent in both places.
 */
import { schemaInstruction, toLlmError } from "../structured.js";
import { LlmError, type AdapterOptions, type ChatAdapter, type Completion, type CompletionRequest } from "../types.js";

export const OLLAMA_DEFAULT_URL = "http://localhost:11434";
export const OLLAMA_DEFAULT_MODEL = "llama3.1";
/** The port the Ollama CLI assumes when OLLAMA_HOST names neither a scheme nor a port. */
export const OLLAMA_DEFAULT_PORT = "11434";

/** IPv4 dotted quad -> its four octets, or undefined. */
function ipv4(h: string): number[] | undefined {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  const o = m?.slice(1).map(Number);
  return o && o.every((x) => x <= 255) ? o : undefined;
}

/**
 * Hosts whose traffic never leaves this machine: localhost, 127.0.0.0/8, ::1,
 * and the unspecified addresses 0.0.0.0 / :: (connecting to them reaches the
 * local host, which is how `OLLAMA_HOST=0.0.0.0` works for the CLI).
 * `hostname` as URL.hostname gives it (IPv6 in brackets).
 */
export function isLoopbackHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (h === "localhost" || h.endsWith(".localhost") || h === "::1" || h === "::" || h === "0.0.0.0") return true;
  return ipv4(h)?.[0] === 127;
}

/**
 * Loopback plus hosts that are only reachable on a private network: RFC 1918,
 * link-local, CGNAT (100.64/10, e.g. Tailscale), IPv6 ULA / link-local, and
 * names that are not public DNS names (single labels such as "gpu-box",
 * .local, .lan, .internal, .home.arpa).
 */
export function isPrivateHost(hostname: string): boolean {
  if (isLoopbackHost(hostname)) return true;
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  const o = ipv4(h);
  if (o) return o[0] === 10 || (o[0] === 172 && o[1] >= 16 && o[1] <= 31) || (o[0] === 192 && o[1] === 168) || (o[0] === 169 && o[1] === 254) || (o[0] === 100 && o[1] >= 64 && o[1] <= 127);
  if (h.includes(":")) return /^f[cd]/.test(h) || /^fe[89ab]/.test(h);
  return !h.includes(".") || /\.(local|lan|internal|home\.arpa)$/.test(h);
}

/**
 * OLLAMA_HOST as a base URL. Like the Ollama CLI, the scheme is optional and,
 * when neither scheme nor port is given, the port is 11434. Unlike the CLI,
 * which always assumes http, a scheme-less host is reached over http only when
 * it is loopback or private; a public host (e.g. "ollama.com") or port 443 is
 * reached over https on that scheme's default port, so a hosted endpoint's API
 * key never travels in cleartext. An explicit scheme is kept as written.
 */
export function ollamaBaseUrl(value: string): string {
  const v = value.trim();
  const bad = (why: string) => new LlmError("config", `OLLAMA_HOST "${v}" ${why}`, "ollama");
  let u: URL;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(v)) {
    try { u = new URL(v); } catch { throw bad("is not a valid URL"); }
    if (u.protocol !== "http:" && u.protocol !== "https:") throw bad("must use http or https");
  } else {
    // A bare IPv6 address ("::1") cannot carry a port; bracket it so URL can parse it.
    const hostport = !v.startsWith("[") && (v.match(/:/g)?.length ?? 0) > 1 ? `[${v}]` : v;
    const authority = hostport.split(/[/?#]/)[0];
    // Read the port from the text: URL drops a port equal to the scheme's default.
    const port = /^(?:\[[^\]]*\]|[^:]*)(?::(\d+))?$/.exec(authority)?.[1];
    try { u = new URL(`http://${hostport}`); } catch { throw bad("is not a valid host[:port]"); }
    const local = isPrivateHost(u.hostname);
    if (port === "443" || !local) u.protocol = "https:";
    // Re-apply the explicit port: switching the scheme can make URL drop or keep it differently.
    u.port = port ?? (local ? OLLAMA_DEFAULT_PORT : "");
  }
  return `${u.protocol}//${u.host}${u.pathname}`.replace(/\/+$/, "");
}

interface ChatResponse {
  model?: string;
  message?: { role: string; content: string };
  done?: boolean;
  done_reason?: string;
  prompt_eval_count?: number;
  eval_count?: number;
  error?: string;
}

export class OllamaAdapter implements ChatAdapter {
  readonly provider = "ollama" as const;
  private readonly baseURL: string;

  constructor(readonly model: string, private readonly o: Omit<AdapterOptions, "model">) {
    this.baseURL = (o.baseURL ?? OLLAMA_DEFAULT_URL).replace(/\/+$/, "");
    if (o.apiKey) {
      let url: URL;
      try { url = new URL(this.baseURL); } catch { throw new LlmError("config", `invalid Ollama base URL "${this.baseURL}"`, this.provider); }
      // The key travels as a bearer token: never over plain http beyond this machine.
      if (url.protocol !== "https:" && !isLoopbackHost(url.hostname)) {
        throw new LlmError("config", `refusing to send the Ollama API key over ${url.protocol.replace(":", "")} to ${url.host}; use an https:// URL (or remove OLLAMA_API_KEY for a local server)`, this.provider);
      }
    }
  }

  static create(o: AdapterOptions): OllamaAdapter {
    return new OllamaAdapter(o.model, o);
  }

  async complete(req: CompletionRequest): Promise<Completion> {
    const body = {
      model: this.model,
      messages: [{ role: "system", content: req.system + schemaInstruction(req.schema) }, ...req.turns],
      format: req.schema,
      stream: false,
      // Deterministic decoding: interpretations should not vary run to run.
      options: { temperature: 0, num_predict: this.o.maxOutputTokens },
    };
    const res = await this.post(body);
    const base = { model: res.model ?? this.model, usage: { inputTokens: res.prompt_eval_count, outputTokens: res.eval_count } };
    // "length" = num_predict reached; the JSON is cut off.
    if (res.done_reason === "length") return { ...base, text: "", finish: "truncated", detail: "done_reason length" };
    return { ...base, text: res.message?.content ?? "", finish: "stop" };
  }

  /** One POST with a hard timeout; transport-level retries only for 429/5xx/connection errors. */
  private async post(body: unknown): Promise<ChatResponse> {
    for (let attempt = 0; ; attempt++) {
      try {
        const res = await fetch(`${this.baseURL}/api/chat`, {
          method: "POST",
          headers: { "content-type": "application/json", ...(this.o.apiKey ? { authorization: `Bearer ${this.o.apiKey}` } : {}) },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(this.o.timeoutMs),
        });
        const text = await res.text();
        let parsed: ChatResponse;
        try { parsed = JSON.parse(text) as ChatResponse; } catch { parsed = { error: text.slice(0, 200) }; }
        if (!res.ok) throw Object.assign(new Error(parsed.error ?? `HTTP ${res.status}`), { status: res.status });
        return parsed;
      } catch (err) {
        const e = toLlmError(this.provider, err);
        if (!e.retryable || e.kind === "timeout" || attempt >= this.o.maxRetries) throw e;
        await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
      }
    }
  }
}
