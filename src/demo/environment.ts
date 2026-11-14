/**
 * Starts a complete local environment:
 *   Community Solid Server (or POD_URL) -> buyer Pod
 *   simulated rails: x402 facilitator + USDC, Lightning-style node, card PSP
 *   three sellers (two approved, one not), protected signer, gateway
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { PodClient } from "../pod/PodClient.js";
import { PodLayout } from "../pod/layout.js";
import { walletToTurtle } from "../pod/wallet.js";
import { ApprovalDevice, autoApprove, type Decider } from "../grounding/approval.js";
import { RuleInterpreter } from "../grounding/ruleInterpreter.js";
import { ClaudeInterpreter } from "../grounding/claudeInterpreter.js";
import type { Interpreter } from "../grounding/interpretation.js";
import { TrustRegistry } from "../trust/registry.js";
import { startFacilitator, type FacilitatorSim } from "../payments/sim/facilitator.js";
import { startLightning, type LightningSim } from "../payments/sim/lightning.js";
import { startPsp, type PspSim } from "../payments/sim/psp.js";
import { startSeller, type SellerHandle } from "../seller/sellerServer.js";
import { startSigner, type SignerHandle } from "../signer/signerService.js";
import { startGateway, type GatewayHandle } from "../gateway/gatewayService.js";
import { ShoppingAssistant } from "../agent/assistant.js";
import { randomHex } from "../util/crypto.js";

export const AGENT_1 = "urn:solid-commerce:agent:assistant-1";
export const AGENT_2 = "urn:solid-commerce:agent:assistant-2";

export interface Environment {
  podRoot: string;
  layout: PodLayout;
  pod: PodClient;
  device: ApprovalDevice;
  registry: TrustRegistry;
  rails: { facilitator: FacilitatorSim; lightning: LightningSim; psp: PspSim };
  sellers: { spree: SellerHandle; havel: SellerHandle; shady: SellerHandle };
  signer: SignerHandle;
  gateway: GatewayHandle;
  assistant(agentId?: string, opts?: { interpreter?: Interpreter; log?: (l: string) => void }): ShoppingAssistant;
  close(): Promise<void>;
}

async function freePort(): Promise<number> {
  return new Promise((res) => { const s = createServer(); s.listen(0, "127.0.0.1", () => { const p = (s.address() as any).port; s.close(() => res(p)); }); });
}

export async function startCss(): Promise<{ url: string; proc: ChildProcess }> {
  const port = await freePort();
  const bin = fileURLToPath(new URL("../../node_modules/.bin/community-solid-server", import.meta.url));
  const proc = spawn(bin, ["-c", "@css:config/default.json", "-p", String(port), "-l", "warn"], { stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  proc.stderr?.on("data", (d) => (stderr += d));
  const url = `http://localhost:${port}/`;
  for (let i = 0; i < 120; i++) {
    try { const r = await fetch(url); if (r.status < 500) return { url, proc }; } catch { /* starting */ }
    if (proc.exitCode !== null) throw new Error("Community Solid Server exited: " + stderr);
    await new Promise((r) => setTimeout(r, 250));
  }
  proc.kill();
  throw new Error("Community Solid Server did not start: " + stderr);
}

export function defaultInterpreter(): Interpreter {
  return process.env.INTERPRETER === "claude" ? new ClaudeInterpreter() : new RuleInterpreter();
}

export async function startEnvironment(opts: { podUrl?: string; decider?: Decider; authorizationTtlSeconds?: number; ledgerPath?: string } = {}): Promise<Environment> {
  const external = opts.podUrl ?? process.env.POD_URL;
  const css = external ? undefined : await startCss();
  const serverUrl = (external ?? css!.url).replace(/\/?$/, "/");
  const podRoot = `${serverUrl}alice-${randomHex(4)}/`;
  const layout = new PodLayout(podRoot);
  const pod = new PodClient();

  const [facilitator, lightning, psp] = await Promise.all([startFacilitator(), startLightning(), startPsp()]);
  const rails = { facilitatorUrl: facilitator.url, lightningUrl: lightning.url, pspUrl: psp.url };

  const spree = await startSeller({ slug: "spree-weather", name: "Spree Weather", coverage: "Berlin", properties: { observationMaxAgeMinutes: 10, includesHourlyForecast: "true" }, prices: { x402: "0.02", l402: 25, cardEur: 5 }, rails });
  const havel = await startSeller({ slug: "havel-data", name: "Havel Data", coverage: "Berlin", properties: { observationMaxAgeMinutes: 90, includesHourlyForecast: "false" }, prices: { x402: "0.01", l402: 12 }, rails, behaviour: { observationAgeMinutes: 80 } });
  const shady = await startSeller({ slug: "shady-forecasts", name: "Shady Forecasts", coverage: "Berlin", properties: { observationMaxAgeMinutes: 1, includesHourlyForecast: "true" }, prices: { x402: "0.001" }, rails });

  // Seller approval: identities bound to pinned signing keys. Shady is deliberately not approved.
  const registry = new TrustRegistry();
  for (const s of [spree, havel]) registry.approve({ webId: s.webId, name: s.currentOffer().payload.sellerName, publicJwk: s.key.publicJwk });

  const device = new ApprovalDevice(layout.webId, opts.decider ?? autoApprove);
  // The signer is configured with the gateway's public key, so the gateway starts first.
  const lightningAccount = "acct-" + randomHex(4);
  const cardToken = "tok_" + randomHex(6);
  const gateway = await startGateway({
    pod, layout, enrolledApprovalKeys: [device.publicJwk], registry, rails,
    payers: {}, authorizationTtlSeconds: opts.authorizationTtlSeconds, ledgerPath: opts.ledgerPath,
  });
  const signer = await startSigner({ gatewayPublicJwk: gateway.key.publicJwk, lightning: { url: lightning.url, accountToken: lightningAccount }, card: { token: cardToken, allowedProviders: [psp.url] } });
  // Public payer address, used by the gateway for reconciliation
  gateway.setPayer(signer.evmAddress);

  // Test funds
  facilitator.chain.mint(signer.evmAddress, 5_000_000n);          // 5 USDC
  lightning.balances.set(lightningAccount, 10_000);               // 10k sats
  psp.cards.set(cardToken, { limit: 10_000, spent: 0 });          // EUR 100.00

  // Buyer Pod: profile + wallet descriptor (no secrets)
  await pod.putTurtle(layout.profile, `@prefix foaf: <http://xmlns.com/foaf/0.1/> .
@prefix solid: <http://www.w3.org/ns/solid/terms#> .
<#me> a foaf:Person ; foaf:name "Alice (test user)" ; solid:storage <${podRoot}> .
`);
  await pod.putTurtle(layout.wallet, walletToTurtle(layout.wallet, { schemes: ["x402", "l402", "card-psp"], x402Address: signer.evmAddress, signerEndpoint: signer.url }));

  const catalog = [spree.offerUrl, havel.offerUrl, shady.offerUrl];
  return {
    podRoot, layout, pod, device, registry, rails: { facilitator, lightning, psp }, sellers: { spree, havel, shady }, signer, gateway,
    assistant: (agentId = AGENT_1, o = {}) => new ShoppingAssistant({ agentId, pod, layout, interpreter: o.interpreter ?? defaultInterpreter(), enrolledApprovalKeys: [device.publicJwk], gatewayUrl: gateway.url, catalog, log: o.log }),
    async close() {
      await Promise.all([gateway, signer, spree, havel, shady, facilitator, lightning, psp].map((s) => s.close()));
      css?.proc.kill();
    },
  };
}
