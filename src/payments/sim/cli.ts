/**
 * Start the simulated payment rails on fixed ports, so the 402 proxy
 * (src/proxy/cli.ts) can be run from the command line:
 *
 *   npm run rails [-- --config proxy.example.json] [--example-upstream]
 *   npm run rails -- pay <url> [--config proxy.example.json]
 *
 * The first form reads rails.facilitatorUrl / lightningUrl / pspUrl from the
 * proxy config and serves the x402 facilitator, the Lightning-style node and
 * the card PSP simulations on exactly those host:port pairs. With
 * --example-upstream it also serves a tiny stand-in API on the config's
 * `upstream` address (fake air-quality JSON for any path), so the example
 * config works end to end without an API of your own.
 *
 * The second form is a minimal L402 buyer for trying the proxy by hand: it
 * requests <url>, takes the L402 challenge from the 402, credits a throwaway
 * buyer account on the simulated Lightning node with the invoice amount
 * (POST /fund, a faucet that only the simulation has), pays the invoice and
 * repeats the request with `Authorization: L402 <macaroon>:<preimage>` (plus an
 * Idempotency-Key header for a method other than GET, which the proxy requires
 * on paid non-GET routes).
 *
 * What this is NOT: real rails. All state is in memory and lost on exit, the
 * faucet hands out money to anyone who asks, and the buyer side bypasses the
 * gateway, mandates and signer that the assistant uses (it pays whatever the
 * 402 asks for). It exists to exercise the seller side (the proxy) only.
 *
 * The simulations bind random loopback ports themselves (their start functions
 * take no port), so each fixed port here is a plain TCP forwarder to the
 * simulation's random port.
 */
import { readFile } from "node:fs/promises";
import { createServer, connect, type Server } from "node:net";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { json, postJson, serve, type RunningServer } from "../../util/http.js";
import { parseL402 } from "../schemes/l402.js";
import { startFacilitator } from "./facilitator.js";
import { startLightning } from "./lightning.js";
import { startPsp } from "./psp.js";

export interface RailsConfig {
  rails: { facilitatorUrl: string; lightningUrl: string; pspUrl: string };
  upstream?: string;
}

export interface RunningRails {
  /** name -> the fixed URL it is reachable on */
  urls: Record<string, string>;
  close(): Promise<void>;
}

/** host and port of a plain-http URL; the rails CLI only serves http. */
function hostPort(name: string, raw: string): { host: string; port: number } {
  let u: URL;
  try { u = new URL(raw); } catch { throw new Error(`${name} "${raw}" is not a URL`); }
  if (u.protocol !== "http:") throw new Error(`${name} "${raw}": the simulated rails serve plain http only`);
  if (!u.port) throw new Error(`${name} "${raw}" needs an explicit port`);
  return { host: u.hostname.replace(/^\[|\]$/g, ""), port: Number(u.port) };
}

/** Forward every TCP connection on host:port to the server at `target`. */
async function forward(target: string, host: string, port: number): Promise<Server> {
  const t = new URL(target);
  const server = createServer((client) => {
    const upstream = connect(Number(t.port), t.hostname);
    client.pipe(upstream).pipe(client);
    const done = () => { client.destroy(); upstream.destroy(); };
    client.on("error", done); upstream.on("error", done);
    client.on("close", done); upstream.on("close", done);
  });
  await new Promise<void>((ok, fail) => { server.once("error", fail); server.listen(port, host, () => ok()); });
  return server;
}

/** A stand-in upstream API: answers any request with fake air-quality JSON. */
async function startExampleUpstream(host: string, port: number): Promise<RunningServer> {
  return serve((req, res) => json(res, 200, { example: true, path: req.url, city: "Berlin", aqi: 42, observedAt: new Date().toISOString() }), port, host);
}

export async function startRails(cfg: RailsConfig, opts: { exampleUpstream?: boolean } = {}): Promise<RunningRails> {
  const want = {
    facilitator: hostPort("rails.facilitatorUrl", cfg.rails.facilitatorUrl),
    lightning: hostPort("rails.lightningUrl", cfg.rails.lightningUrl),
    psp: hostPort("rails.pspUrl", cfg.rails.pspUrl),
  };
  const sims: RunningServer[] = [];
  const forwarders: Server[] = [];
  const closeAll = async () => {
    await Promise.all(forwarders.map((s) => new Promise<void>((r) => s.close(() => r()))));
    await Promise.all(sims.map((s) => s.close()));
  };
  const urls: Record<string, string> = {};
  try {
    const [fac, ln, psp] = await Promise.all([startFacilitator(), startLightning(), startPsp()]);
    sims.push(fac, ln, psp);
    for (const [name, sim] of [["facilitator", fac], ["lightning", ln], ["psp", psp]] as const) {
      const { host, port } = want[name];
      forwarders.push(await forward(sim.url, host, port));
      urls[name] = `http://${host.includes(":") ? `[${host}]` : host}:${port}`;
    }
    if (opts.exampleUpstream) {
      if (!cfg.upstream) throw new Error("--example-upstream needs `upstream` in the config");
      const { host, port } = hostPort("upstream", cfg.upstream);
      const up = await startExampleUpstream(host, port);
      sims.push(up);
      urls.upstream = up.url;
    }
  } catch (e) {
    await closeAll();
    const err = e as NodeJS.ErrnoException;
    if (err.code === "EADDRINUSE") throw new Error(`a rails port is already in use (${err.message}); is \`npm run rails\` already running?`);
    throw e;
  }
  return { urls, close: closeAll };
}

export interface PayResult { status: number; headers: Record<string, string>; body: string; paidSat: number }

/** Buy `url` once over L402 against the simulated Lightning node (see the header comment for what this skips). */
export async function payL402(url: string, lightningUrl: string, method = "GET"): Promise<PayResult> {
  const first = await fetch(url, { method });
  if (first.status !== 402) throw new Error(`expected 402 from ${url}, got ${first.status}: ${(await first.text()).slice(0, 300)}`);
  const [opt] = parseL402(first.headers.get("www-authenticate"), url);
  if (!opt) throw new Error("the 402 carries no L402 challenge (this route has no l402 price)");
  const { macaroon, invoice } = opt.challenge as { macaroon: string; invoice: string };
  const account = `cli-buyer-${process.pid}-${Date.now()}`;
  const amountSat = Number(opt.amount);
  const funded = await postJson(`${lightningUrl}/fund`, { account, amountSat });
  if (funded.status !== 200) throw new Error(`funding the buyer account failed: ${JSON.stringify(funded.body)}`);
  const paid = await postJson(`${lightningUrl}/pay`, { paymentRequest: invoice }, { "x-account": account });
  if (paid.status !== 200 || !paid.body?.preimage) throw new Error(`paying the invoice failed: ${JSON.stringify(paid.body)}`);
  // A paid non-GET route serves one request per payment and requires an Idempotency-Key on it.
  const idem: Record<string, string> = method === "GET" || method === "HEAD" ? {} : { "idempotency-key": `cli-${account}` };
  const second = await fetch(url, { method, headers: { authorization: `L402 ${macaroon}:${paid.body.preimage}`, ...idem } });
  return { status: second.status, headers: Object.fromEntries(second.headers), body: await second.text(), paidSat: amountSat };
}

async function loadConfig(path: string): Promise<RailsConfig> {
  const c = JSON.parse(await readFile(resolve(path), "utf8")) as Partial<RailsConfig>;
  if (!c.rails?.facilitatorUrl || !c.rails.lightningUrl || !c.rails.pspUrl) throw new Error(`${path}: rails.facilitatorUrl, rails.lightningUrl and rails.pspUrl are required`);
  return c as RailsConfig;
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { config: { type: "string", default: "proxy.example.json" }, "example-upstream": { type: "boolean", default: false }, method: { type: "string", default: "GET" } },
  });
  const cfg = await loadConfig(values.config!);
  if (positionals[0] === "pay") {
    const url = positionals[1];
    if (!url) throw new Error("usage: npm run rails -- pay <url> [--config <file>] [--method GET]");
    const r = await payL402(url, cfg.rails.lightningUrl, values.method);
    console.log(`paid ${r.paidSat} SAT over L402 (simulated); HTTP ${r.status}`);
    for (const [k, v] of Object.entries(r.headers)) if (/^(content-type|sc-|payment-response)/i.test(k)) console.log(`${k}: ${v.length > 160 ? v.slice(0, 160) + "..." : v}`);
    console.log(r.body);
    process.exit(r.status === 200 ? 0 : 1);
  }
  if (positionals.length) throw new Error(`unknown command "${positionals[0]}" (use: pay <url>)`);
  const rails = await startRails(cfg, { exampleUpstream: values["example-upstream"] });
  console.log("Simulated payment rails (in memory, NOT real money):");
  for (const [name, u] of Object.entries(rails.urls)) console.log(`  ${name.padEnd(12)} ${u}`);
  console.log("Now start the proxy in another terminal: npm run proxy -- --config " + values.config);
  const stop = () => { rails.close().then(() => process.exit(0)); };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error((e as Error).message); process.exit(1); });
}
