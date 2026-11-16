/**
 * One transport rule for every provider: a credential (API key, bearer token,
 * ADC access token) is sent only over https, or over plain http to a loopback
 * host whose traffic never leaves this machine.
 *
 * Adapters call assertSecureTransport() with the URL the SDK will actually
 * use: the configured base URL, else the variable the SDK itself reads from
 * process.env (e.g. ANTHROPIC_BASE_URL), else the SDK's https default. The
 * check runs in the factories (create / createAzure / createCompatible, and
 * the Ollama constructor). An Anthropic, OpenAI or Gemini adapter constructed
 * in code around a ready client object is not checked: that client owns its
 * transport.
 *
 * Deliberately strict: a LAN server (http://192.168.x.y, http://gpu-box) with
 * an API key is refused too, because "private" is a guess about the network,
 * not a property of the connection. Such servers work without a key, or behind
 * TLS. Residual risk: a host name that resolves to loopback only on this
 * machine is trusted by name ("localhost", "*.localhost"), and DNS rebinding of
 * such names is out of scope for this prototype.
 */
import { LlmError, type ProviderName } from "./types.js";

/** IPv4 dotted quad -> its four octets, or undefined. */
export function ipv4(h: string): number[] | undefined {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  const o = m?.slice(1).map(Number);
  return o && o.every((x) => x <= 255) ? o : undefined;
}

/**
 * The IPv4 address inside an IPv4-mapped IPv6 address, in either spelling:
 * "::ffff:127.0.0.1" (as written) or "::ffff:7f00:1" (as WHATWG URL
 * normalises it).
 */
export function mappedIpv4(h: string): number[] | undefined {
  const m = /^::ffff:(.+)$|^(?:0{1,4}:){5}ffff:(.+)$/i.exec(h);
  if (!m) return undefined;
  const rest = m[1] ?? m[2];
  const dotted = ipv4(rest);
  if (dotted) return dotted;
  const hex = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(rest);
  if (!hex) return undefined;
  const hi = parseInt(hex[1], 16), lo = parseInt(hex[2], 16);
  return [hi >> 8, hi & 255, lo >> 8, lo & 255];
}

const bare = (hostname: string) => hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");

/**
 * Hosts whose traffic never leaves this machine: localhost, 127.0.0.0/8, ::1,
 * IPv4-mapped 127.0.0.0/8, and the unspecified addresses 0.0.0.0 / :: (connecting
 * to them reaches the local host, which is how `OLLAMA_HOST=0.0.0.0` works for
 * the Ollama CLI). `hostname` as URL.hostname gives it (IPv6 in brackets).
 */
export function isLoopbackHost(hostname: string): boolean {
  const h = bare(hostname);
  if (h === "localhost" || h.endsWith(".localhost") || h === "::1" || h === "::" || h === "0.0.0.0") return true;
  return (ipv4(h) ?? mappedIpv4(h))?.[0] === 127;
}

/**
 * Loopback plus hosts that are only reachable on a private network: RFC 1918,
 * link-local, CGNAT (100.64/10, e.g. Tailscale), IPv6 ULA / link-local, the
 * IPv4-mapped forms of those IPv4 ranges, and names that are not public DNS
 * names (single labels such as "gpu-box", .local, .lan, .internal, .home.arpa).
 * Used only to pick http vs https for a scheme-less OLLAMA_HOST, never to allow
 * a credential over http.
 */
export function isPrivateHost(hostname: string): boolean {
  if (isLoopbackHost(hostname)) return true;
  const h = bare(hostname);
  const o = ipv4(h) ?? mappedIpv4(h);
  if (o) return o[0] === 10 || (o[0] === 172 && o[1] >= 16 && o[1] <= 31) || (o[0] === 192 && o[1] === 168) || (o[0] === 169 && o[1] === 254) || (o[0] === 100 && o[1] >= 64 && o[1] <= 127);
  if (h.includes(":")) return /^f[cd]/.test(h) || /^fe[89ab]/.test(h);
  return !h.includes(".") || /\.(local|lan|internal|home\.arpa)$/.test(h);
}

/**
 * Throw a typed config error if a credential would travel over plain http to a
 * host beyond loopback. `url` undefined means the SDK's own https default.
 * `what` names the setting in the message (never the credential itself).
 */
export function assertSecureTransport(provider: ProviderName, url: string | undefined, sendsCredential: boolean, what = "base URL"): void {
  if (!url || !sendsCredential) return;
  let u: URL;
  try { u = new URL(url); } catch { throw new LlmError("config", `invalid ${what} "${url}"`, provider); }
  if (u.protocol === "https:" || isLoopbackHost(u.hostname)) return;
  throw new LlmError(
    "config",
    `refusing to send ${provider} credentials over ${u.protocol.replace(":", "")} to ${u.host} (${what}); use an https:// URL, or a loopback address, or no API key for a keyless local server`,
    provider,
  );
}

/** The variable an SDK reads when no base URL is passed, as the SDK reads it. */
export const envUrl = (name: string): string | undefined => process.env[name]?.trim() || undefined;
