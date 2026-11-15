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
import { interpreterFromEnv } from "../grounding/llmInterpreter.js";
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
import { bearerHeaders, newAgentSecret, secretHash } from "../trust/agentAuth.js";
import { readWallet } from "../pod/wallet.js";
import { addressToTurtle, type PostalAddress } from "../pod/address.js";
import { startAcpMerchant, type AcpMerchantHandle, type ShippingRate } from "../payments/sim/acpMerchant.js";

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
  /** An assistant acting as agentId, holding that agent's secret for the gateway and the signer. */
  assistant(agentId?: string, opts?: { interpreter?: Interpreter; log?: (l: string) => void }): ShoppingAssistant;
  /**
   * Headers that authenticate a direct call to the gateway or signer as this agent (enrolled on
   * first use). For code that plays an agent without a ShoppingAssistant: tests and the web demo's
   * guardrails. The secret exists only in this process; it is never written to the Pod.
   */
  agentHeaders(agentId?: string): Record<string, string>;
  /**
   * The operator's credential (the demo dashboard): GET /transactions/:id of any agent and POST
   * /reconcile at the gateway. It cannot authorize or pay.
   */
  adminHeaders: Record<string, string>;
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

/** Rule-based unless LLM_PROVIDER (or legacy INTERPRETER=claude) selects a provider; see docs/llm-providers.md. */
export function defaultInterpreter(): Interpreter {
  return interpreterFromEnv();
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
  // Per-agent secrets for the gateway and signer, issued here at setup and held only in memory.
  const adminSecret = newAgentSecret();
  const gateway = await startGateway({
    pod, layout, enrolledApprovalKeys: [device.publicJwk], registry, rails,
    payers: {}, authorizationTtlSeconds: opts.authorizationTtlSeconds, ledgerPath: opts.ledgerPath, adminSecretHash: secretHash(adminSecret),
  });
  const signer = await startSigner({ gatewayPublicJwk: gateway.key.publicJwk, lightning: { url: lightning.url, accountToken: lightningAccount }, card: { token: cardToken, allowedProviders: [psp.url] } });
  // Public payer address, used by the gateway for reconciliation
  gateway.setPayer(signer.evmAddress);
  const agentSecrets = new Map<string, string>();
  const agentSecret = (agentId: string) => {
    let s = agentSecrets.get(agentId);
    if (!s) {
      s = newAgentSecret();
      gateway.enrollAgent(agentId, secretHash(s));
      signer.enrollAgent(agentId, secretHash(s));
      agentSecrets.set(agentId, s);
    }
    return s;
  };
  for (const a of [AGENT_1, AGENT_2]) agentSecret(a);

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
  const env: Environment = {
    podRoot, layout, pod, device, registry, rails: { facilitator, lightning, psp }, sellers: { spree, havel, shady }, signer, gateway,
    assistant: (agentId = AGENT_1, o = {}) => new ShoppingAssistant({ agentId, agentSecret: agentSecret(agentId), pod, layout, interpreter: o.interpreter ?? defaultInterpreter(), enrolledApprovalKeys: [device.publicJwk], gatewayUrl: gateway.url, catalog, log: o.log }),
    agentHeaders: (agentId = AGENT_1) => bearerHeaders(agentSecret(agentId)),
    adminHeaders: bearerHeaders(adminSecret),
    async close() {
      await Promise.all([gateway, signer, spree, havel, shady, facilitator, lightning, psp].map((s) => s.close()));
      css?.proc.kill();
    },
  };
  secrets.set(env, agentSecret);
  return env;
}

/** Each environment's agent-secret issuer, kept out of the Environment object so callers only get headers. */
const secrets = new WeakMap<Environment, (agentId: string) => string>();
const secretOf = (env: Environment, agentId: string) => secrets.get(env)!(agentId);

// ----------------------------------------------------------------- checkout merchants (physical goods)
//
// Shops selling shoes through an ACP-style checkout API (no HTTP 402). They
// reuse the environment's PSP (now also issuing delegated tokens), gateway and
// signer; only the merchants, their registry entries, the buyer's shipping
// address and the wallet's extra scheme are added here.

export interface CheckoutEnvironment extends Environment {
  /** billig: cheap, soles not replaceable · atelier: fits, but 123.90 EUR with delivery · sohle: fits · outlet: NOT approved */
  merchants: { billig: AcpMerchantHandle; atelier: AcpMerchantHandle; sohle: AcpMerchantHandle; outlet: AcpMerchantHandle };
  address: PostalAddress;
  checkoutAssistant(agentId?: string, opts?: { interpreter?: Interpreter; log?: (l: string) => void }): ShoppingAssistant;
}

export const BUYER_ADDRESS: PostalAddress = { name: "Alice Example", streetAddress: "Musterstraße 1", locality: "Berlin", postalCode: "10115", country: "DE" };

export async function startCheckoutEnvironment(opts: Parameters<typeof startEnvironment>[0] = {}): Promise<CheckoutEnvironment> {
  const env = await startEnvironment(opts);
  const psp = env.rails.psp;
  const shoe = (slug: string, name: string, title: string, price: number, properties: Record<string, string>, shipping: ShippingRate[]) =>
    startAcpMerchant({ slug, name, products: [{ id: `${slug}-1`, title, category: "Shoes", price: { amount: price, currency: "eur" }, properties }], shipping, psp: { url: psp.url, apiKey: psp.registerMerchant(`acct_${slug}`) } });
  const standard = (amount: number): ShippingRate => ({ id: "standard", title: "Standard", carrier: "DHL", amount, countries: ["DE", "AT"] });
  const [billig, atelier, sohle, outlet] = await Promise.all([
    shoe("billig-schuh", "Billig Schuh", "Canvas sneaker", 3995, { solesReplaceable: "false", manufacturerRepairService: "false" }, [standard(495)]),
    shoe("atelier-leder", "Atelier Leder", "Goodyear-welted derby", 10900, { solesReplaceable: "true", manufacturerRepairService: "true" }, [{ id: "express", title: "Insured express", carrier: "UPS", amount: 1490, countries: ["DE"] }]),
    shoe("sohle-und-co", "Sohle & Co", "Resoleable leather boot", 8900, { solesReplaceable: "true", manufacturerRepairService: "false" }, [standard(590), { id: "express", title: "Express", carrier: "DHL", amount: 1290, countries: ["DE"] }]),
    shoe("schnaeppchen-outlet", "Schnäppchen Outlet", "Resoleable boot (outlet)", 5900, { solesReplaceable: "true" }, [standard(0)]),
  ]);
  // Outlet is deliberately not approved.
  for (const m of [billig, atelier, sohle]) env.registry.approveMerchant({ webId: m.webId, name: m.name, merchantId: m.merchantId, apiBase: m.url, paymentProvider: psp.url });

  for (const card of psp.cards.values()) card.limit = 50_000;     // EUR 500.00 of test funds for physical goods
  await env.pod.putTurtle(env.layout.address().split("#")[0], addressToTurtle(env.layout.address(), BUYER_ADDRESS));
  const wallet = await readWallet(env.pod, env.layout.wallet);
  await env.pod.putTurtle(env.layout.wallet, walletToTurtle(env.layout.wallet, { ...wallet, schemes: [...wallet.schemes, "acp-delegated"] }));

  const merchantApis = [billig, atelier, sohle, outlet].map((m) => m.url);
  return {
    ...env, merchants: { billig, atelier, sohle, outlet }, address: BUYER_ADDRESS,
    checkoutAssistant: (agentId = AGENT_1, o = {}) => new ShoppingAssistant({ agentId, agentSecret: secretOf(env, agentId), pod: env.pod, layout: env.layout, interpreter: o.interpreter ?? defaultInterpreter(), enrolledApprovalKeys: [env.device.publicJwk], gatewayUrl: env.gateway.url, catalog: [], checkoutMerchants: merchantApis, log: o.log }),
    async close() {
      await Promise.all([billig, atelier, sohle, outlet].map((m) => m.close()));
      await env.close();
    },
  };
}
