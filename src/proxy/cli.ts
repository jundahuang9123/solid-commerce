/**
 * Run the 402 proxy in front of an existing API:
 *
 *   npm run proxy -- --config proxy.example.json [--port 8402]
 *
 * The config file is JSON (see proxy.example.json). It names secrets only by
 * environment variable or file path; see src/proxy/keys.ts. Keys starting
 * with "$" (e.g. "$comment") are ignored.
 *
 * The rails URLs must point at an x402 facilitator, a Lightning node and a
 * PSP speaking the HTTP surfaces of src/payments/sim/. In this prototype
 * only the simulations implement them.
 */
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { fmt, toAtomic } from "../util/money.js";
import { loadKeyMaterial, type KeySources } from "./keys.js";
import { startPaymentProxy, type PaymentProxyConfig } from "./paymentProxy.js";

interface ProxyFile extends Omit<PaymentProxyConfig, "keys"> {
  listen?: { host?: string; port?: number };
  keys?: KeySources;
}

function check(c: ProxyFile): ProxyFile {
  const missing = (["seller", "upstream", "rails", "routes"] as const).filter((k) => !c[k]);
  if (missing.length) throw new Error(`config is missing: ${missing.join(", ")}`);
  for (const k of ["facilitatorUrl", "lightningUrl", "pspUrl"] as const) if (!c.rails[k]) throw new Error(`config rails.${k} is missing`);
  if (c.unconfigured && c.unconfigured !== "passthrough" && c.unconfigured !== "not-found") throw new Error(`unconfigured must be "passthrough" or "not-found"`);
  return c;
}

async function main() {
  const { values } = parseArgs({ options: { config: { type: "string" }, port: { type: "string" } } });
  if (!values.config) throw new Error("usage: npm run proxy -- --config <file> [--port <n>]");
  const path = resolve(values.config);
  const file = check(JSON.parse(await readFile(path, "utf8"), (k, v) => (k.startsWith("$") ? undefined : v)) as ProxyFile);
  const keys = await loadKeyMaterial(file.keys, dirname(path));
  for (const w of keys.warnings) console.warn(`\x1b[33mWARNING\x1b[0m ${w}`);

  const port = values.port ? Number(values.port) : file.listen?.port ?? 8402;
  const proxy = await startPaymentProxy({ ...file, keys: { signingKey: keys.signingKey, payTo: keys.payTo, macaroonRootKey: keys.macaroonRootKey } }, port, file.listen?.host ?? "127.0.0.1");

  console.log(`402 proxy for ${file.seller.name} listening on ${proxy.url}, forwarding to ${file.upstream}`);
  console.log(`  identity   ${proxy.webId}  (offer key ${proxy.key.keyId})`);
  console.log(`  x402 payTo ${proxy.payTo}; L402 payee ${proxy.lightningPayee}; PSP merchant ${proxy.merchantId}`);
  for (const r of file.routes) {
    const prices = [
      r.prices.x402 && fmt(toAtomic(r.prices.x402, "USDC"), "USDC"), r.prices.l402 && `${r.prices.l402} SAT`, r.prices.cardEur && fmt(String(r.prices.cardEur), "EUR"),
    ].filter(Boolean).join(" | ");
    console.log(`  ${(r.method ?? "GET").padEnd(6)} ${r.path}${r.prefix ? "*" : ""}  ${prices}  offer ${proxy.offerUrl(r.id)}`);
  }
  console.log(`  unconfigured paths: ${file.unconfigured ?? "not-found"}`);

  const stop = () => { proxy.close().then(() => process.exit(0)); };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

main().catch((e) => { console.error((e as Error).message); process.exit(1); });
