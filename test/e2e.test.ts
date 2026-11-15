/**
 * End-to-end completion checks from the implementation brief, run against a
 * real Community Solid Server and the simulated payment rails.
 */
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { startCss, startEnvironment, AGENT_1, AGENT_2, type Environment } from "../src/demo/environment.js";
import type { SpendingMandate } from "../src/model.js";
import { postJson, b64json } from "../src/util/http.js";
import { Ed25519Key, signEnvelope } from "../src/util/crypto.js";
import { parseTurtle } from "../src/rdf/records.js";
import { parse402 } from "../src/payments/http402.js";
import { NS } from "../src/rdf/namespaces.js";
import { getAddress } from "viem";
import { newId } from "../src/util/crypto.js";
import { DEFAULT_NETWORK, DEFAULT_USDC, nonceFor } from "../src/payments/schemes/x402.js";
import { encodeInvoice } from "../src/payments/sim/lightning.js";

let css: { url: string; proc: ChildProcess };
const envs: Environment[] = [];
const BERLIN = { text: "Get me a current Berlin weather report.", category: "WeatherReport", subject: "Berlin" };

before(async () => { css = await startCss(); });
after(async () => { await Promise.all(envs.map((e) => e.close())); css.proc.kill(); });

async function env(opts: Parameters<typeof startEnvironment>[0] = {}) {
  const e = await startEnvironment({ podUrl: css.url, ...opts });
  envs.push(e);
  return e;
}

/** Agree "current" = within 60 minutes (option 2), and confirm everything the assistant proposes. */
async function ground(e: Environment, text = "Get me a current Berlin weather report. You may spend up to 1 USDC from approved providers.") {
  const a = e.assistant();
  const approved = e.registry.list().map((s) => s.webId);
  const { ctx, result } = await a.understand(text, approved);
  const proposals = [...result.proposals, ...result.questions.flatMap((q) => a.answer(q, 1, ctx))];
  const { confirmed } = await a.confirm(proposals, e.device);
  return { assistant: a, result, confirmed, mandate: confirmed.find((r) => r.kind === "mandate") as SpendingMandate | undefined };
}

/** Write a user-confirmed mandate with explicit terms. */
async function mandate(e: Environment, terms: Partial<SpendingMandate> & { slug: string }) {
  const m: SpendingMandate = {
    kind: "mandate", id: e.layout.mandate(terms.slug), owner: e.layout.webId, revision: 1, status: "Proposed",
    assignees: [AGENT_1], targets: ["WeatherReport"], currency: "USDC", maxPerTransaction: "1.00", totalLimit: "1.00",
    allowedSellers: e.registry.list().map((s) => s.webId).sort(), allowedSchemes: ["x402"],
    validUntil: new Date(Date.now() + 86_400_000).toISOString(), ...terms,
  };
  delete (m as any).slug;
  const out = await e.assistant().cg.commit(m, e.device);
  assert.ok(out);
  return out as SpendingMandate;
}

const budget = async (e: Environment, m: SpendingMandate) => (await (await fetch(`${e.gateway.url}/budget?mandate=${encodeURIComponent(m.id)}`)).json()) as { settled: string; committed: string; available: string };

describe("completion checks", () => {
  test("an allowed purchase succeeds and produces linked evidence", async () => {
    const e = await env();
    const { assistant, mandate: m } = await ground(e);
    const r = await assistant.purchase({ ...BERLIN, mandateId: m!.id });
    assert.equal(r.status, "completed");
    assert.equal(r.selected?.sellerName, "Spree Weather");
    assert.equal(e.rails.facilitator.chain.balanceOf(e.sellers.spree.payTo), 20_000n);

    // Assistant evidence links the intention, mandate, grounding, offers and the gateway's ledger entry
    const doc = (await e.pod.get(r.evidence!))!.text;
    const st = parseTurtle(doc, r.evidence!);
    const tx = r.evidence + "#tx";
    const objs = (p: string) => st.getObjects(tx, p, null).map((t) => t.value);
    assert.ok(objs(NS.prov + "used").includes(m!.id));
    assert.equal(objs(NS.sc + "offerConsidered").length, 3);
    assert.equal(objs(NS.sc + "selectedOffer")[0], r.selected!.offerId);
    assert.ok(objs(NS.sc + "groundedIn").some((g) => g.includes("/common-ground/")));
    const ledgerDoc = objs(NS.sc + "authorization")[0].split("#")[0];
    const ledger = (await e.pod.get(ledgerDoc))!.text;
    assert.match(ledger, /sc:Settled/);
    assert.match(ledger, /sc:receipt/);
  });

  test("overspending and unapproved sellers are blocked", async () => {
    const e = await env();
    const m = await mandate(e, { slug: "small", totalLimit: "0.03", maxPerTransaction: "0.03" });
    const a = e.assistant();
    await ground(e, "Get me a current Berlin weather report."); // agree the meaning only
    assert.equal((await a.purchase({ ...BERLIN, mandateId: m.id })).status, "completed");
    const second = await a.purchase({ ...BERLIN, mandateId: m.id });
    assert.deepEqual([second.status, second.code], ["blocked", "BUDGET_EXCEEDED"]);

    const perTx = await mandate(e, { slug: "pertx", totalLimit: "1.00", maxPerTransaction: "0.01" });
    e.sellers.havel.setBehaviour({ observationAgeMinutes: 1 });
    const r3 = await a.purchase({ ...BERLIN, mandateId: perTx.id });
    assert.equal(r3.status, "no_acceptable_offer", "assistant itself refuses offers above the per-purchase limit");

    // A compromised agent goes straight to the gateway with offers it should not pay
    const shadyOffer = e.sellers.shady.currentOffer();
    const opt = (o: typeof shadyOffer) => ({ scheme: "x402", amount: o.payload.prices[0].amount, currency: "USDC", payTo: o.payload.prices[0].payTo, resource: o.payload.resource, challenge: {} });
    const g1 = await postJson(`${e.gateway.url}/authorize`, { transactionId: "tx-shady", agentId: AGENT_1, mandateId: m.id, offer: shadyOffer, option: opt(shadyOffer) }, e.agentHeaders(AGENT_1));
    assert.deepEqual([g1.status, g1.body.code], [403, "SELLER_NOT_IN_MANDATE"]);
    // Even if a mandate names it, the gateway's registry must approve the seller
    const wide = await mandate(e, { slug: "wide", allowedSellers: [e.sellers.shady.webId] });
    const g2 = await postJson(`${e.gateway.url}/authorize`, { transactionId: "tx-shady-2", agentId: AGENT_1, mandateId: wide.id, offer: shadyOffer, option: opt(shadyOffer) }, e.agentHeaders(AGENT_1));
    assert.deepEqual([g2.status, g2.body.code], [403, "SELLER_NOT_APPROVED"]);
    // An offer re-signed with another key, claiming to be an approved seller
    const forged = signEnvelope(Ed25519Key.generate(), { ...e.sellers.spree.currentOffer().payload, prices: [{ ...e.sellers.spree.currentOffer().payload.prices[0], payTo: e.sellers.shady.payTo }] });
    const g3 = await postJson(`${e.gateway.url}/authorize`, { transactionId: "tx-forged", agentId: AGENT_1, mandateId: m.id, offer: forged, option: opt(forged) }, e.agentHeaders(AGENT_1));
    assert.deepEqual([g3.status, g3.body.code], [403, "KEY_MISMATCH"]);
    assert.equal(e.rails.facilitator.chain.balanceOf(e.sellers.shady.payTo), 0n);
  });

  test("changed offers require revalidation", async () => {
    const e = await env();
    const { assistant, mandate: m } = await ground(e);
    const stale = e.sellers.spree.currentOffer();
    e.sellers.spree.setPrice({ x402: "0.05" });
    // Gateway: a 402 that references v2 cannot be paid against an evaluation of v1
    const res = await fetch(e.sellers.spree.resourceUrl);
    const ch = parse402(res, e.sellers.spree.resourceUrl);
    const g = await postJson(`${e.gateway.url}/authorize`, { transactionId: "tx-stale", agentId: AGENT_1, mandateId: m!.id, offer: stale, offerRef: ch.offer, option: ch.options[0] }, e.agentHeaders(AGENT_1));
    assert.deepEqual([g.status, g.body.code], [409, "OFFER_CHANGED"]);
    // Assistant: price changes after evaluation -> re-fetch, re-evaluate, then pay the new terms
    const r = await assistant.purchase({ ...BERLIN, mandateId: m!.id, hooks: { afterEvaluation: async () => e.sellers.spree.setPrice({ x402: "0.06" }) } });
    assert.equal(r.status, "completed");
    assert.equal(r.amount, "60000");
    assert.ok(r.notes.some((n) => /re-validated/.test(n)));
  });

  test("concurrent requests cannot exceed the authorized budget", async () => {
    const e = await env();
    await ground(e, "Get me a current Berlin weather report.");
    const m = await mandate(e, { slug: "shared", totalLimit: "0.05", assignees: [AGENT_1, AGENT_2] });
    const agents = [e.assistant(AGENT_1), e.assistant(AGENT_2)];
    const results = await Promise.all(Array.from({ length: 6 }, (_, i) => agents[i % 2].purchase({ ...BERLIN, mandateId: m.id })));
    const completed = results.filter((r) => r.status === "completed").length;
    assert.equal(completed, 2, results.map((r) => r.status + ":" + r.code).join(","));
    assert.ok(results.filter((r) => r.code === "BUDGET_EXCEEDED").length === 4);
    assert.equal(e.rails.facilitator.chain.balanceOf(e.sellers.spree.payTo), 40_000n);
    assert.equal((await budget(e, m)).settled, "40000");
  });

  test("retries and replay do not cause duplicate charges", async () => {
    const e = await env();
    const { mandate: m } = await ground(e);
    const offer = e.sellers.spree.currentOffer();
    const ch = parse402(await fetch(e.sellers.spree.resourceUrl), e.sellers.spree.resourceUrl);
    const option = ch.options.find((o) => o.scheme === "x402")!;
    const req = { transactionId: "tx-retry", agentId: AGENT_1, mandateId: m!.id, offer, offerRef: ch.offer, option };
    const a1 = await postJson(`${e.gateway.url}/authorize`, req, e.agentHeaders(AGENT_1));
    const a2 = await postJson(`${e.gateway.url}/authorize`, req, e.agentHeaders(AGENT_1));
    assert.equal(a1.status, 200);
    assert.equal(a2.body.replayed, true);
    assert.deepEqual(a2.body.authorization, a1.body.authorization, "same transaction id -> same authorization");
    assert.equal((await budget(e, m!)).committed, "20000", "reserved once");
    const conflict = await postJson(`${e.gateway.url}/authorize`, { ...req, option: { ...option, amount: "1" } }, e.agentHeaders(AGENT_1));
    assert.equal(conflict.body.code, "IDEMPOTENCY_CONFLICT");

    // Signer: retried and concurrent duplicate pay calls yield one payment
    const pay = () => postJson(`${e.signer.url}/pay`, { authorization: a1.body.authorization, challenge: option.challenge }, e.agentHeaders(AGENT_1));
    const [p1, p2, p3] = await Promise.all([pay(), pay(), pay()]);
    assert.equal(e.signer.payments, 1);
    assert.deepEqual(p2.body.credential, p1.body.credential);
    assert.deepEqual(p3.body.credential, p1.body.credential);
    // Same authorization, different challenge (e.g. a substituted payee): refused
    const swapped = await postJson(`${e.signer.url}/pay`, { authorization: a1.body.authorization, challenge: { ...(option.challenge as object), requirements: { ...(option.challenge as any).requirements, payTo: e.sellers.shady.payTo } } }, e.agentHeaders(AGENT_1));
    assert.equal(swapped.body.error, "CHALLENGE_MISMATCH");
    // Forged authorization
    const forged = signEnvelope(Ed25519Key.generate(), { ...a1.body.authorization.payload, authId: "auth-forged" });
    assert.equal((await postJson(`${e.signer.url}/pay`, { authorization: forged, challenge: option.challenge }, e.agentHeaders(AGENT_1))).status, 401);

    // Seller: presenting the credential repeatedly charges once
    const cred = p1.body.credential;
    const h = { [cred.header.name]: cred.header.value };
    const [r1, r2] = await Promise.all([fetch(e.sellers.spree.resourceUrl, { headers: h }), fetch(e.sellers.spree.resourceUrl, { headers: h })]);
    const r3 = await fetch(e.sellers.spree.resourceUrl, { headers: h });
    assert.deepEqual([r1.status, r2.status, r3.status], [200, 200, 200]);
    assert.equal(e.rails.facilitator.chain.transfers.length, 1);
    assert.equal(e.rails.facilitator.chain.balanceOf(e.sellers.spree.payTo), 20_000n);
    // Replay to another seller: rejected (bound to payee and amount by the EIP-712 signature)
    const other = await fetch(e.sellers.havel.resourceUrl, { headers: h });
    assert.equal(other.status, 402);
    assert.equal(e.rails.facilitator.chain.balanceOf(e.sellers.havel.payTo), 0n);
  });

  test("ambiguous requirements trigger clarification", async () => {
    const e = await env();
    const { result } = await e.assistant().understand("Get me a current Berlin weather report.", []);
    assert.equal(result.questions.length, 1);
    assert.equal(result.questions[0].term, "current");
    assert.ok(result.questions[0].options.length >= 2);
    assert.equal(result.proposals.length, 0, "nothing is assumed before the user answers");
  });

  test("confirmed meanings persist into a new session and another agent", async () => {
    const e = await env();
    await ground(e);
    for (const agent of [AGENT_1, AGENT_2]) {
      const fresh = e.assistant(agent);
      const { result } = await fresh.understand("Get me a current Berlin weather report.", []);
      assert.equal(result.questions.length, 0, `${agent}: no re-asking`);
      assert.ok(result.reused.some((r) => r.kind === "meaning" && r.term === "current"));
    }
    // A meaning revision is versioned, with the old revision preserved in history
    const a = e.assistant();
    const ctx = await a.cg.load();
    const q = (await a.understand("Get me a current Berlin weather report.", [])).result;
    assert.equal(q.questions.length, 0);
    const revised = a.cg.answer({ id: "q", term: "current", scope: "WeatherReport", statement: { text: "current means within 15 minutes", role: "requirement", category: "WeatherReport" }, options: [{ label: "15", definition: "within 15 minutes", criterion: { leftOperand: "observationAgeMinutes", operator: "lteq", rightOperand: 15, unit: "minute" } }], prompt: "" }, 0, e.layout.webId, ctx);
    await a.confirm(revised, e.device);
    const after = await a.cg.load();
    const meaning = after.meanings.find((x) => x.term === "current")!;
    assert.equal(meaning.revision, 2);
    assert.ok(meaning.supersedes && (await e.pod.get(meaning.supersedes)));
  });

  test("preference changes cannot silently expand spending permissions", async () => {
    const e = await env();
    const { assistant, mandate: m } = await ground(e);
    const before = await budget(e, m!);
    // 1. Agent proposes a preference and the user confirms it: the mandate is untouched
    const { result } = await assistant.understand("I prefer providers that include an hourly forecast.", e.registry.list().map((s) => s.webId));
    assert.ok(result.proposals.every((p) => p.kind !== "mandate"));
    await assistant.confirm(result.proposals, e.device);
    assert.deepEqual(await budget(e, m!), before);
    // 2. An agent writes an unsigned "confirmed" mandate with a bigger limit straight into the Pod
    const doc = m!.id.split("#")[0];
    const orig = (await e.pod.get(doc))!.text;
    await e.pod.putTurtle(doc, orig.replace(/odrl:rightOperand (?:"1"\^\^xsd:decimal|1\.0+)/g, 'odrl:rightOperand "500.00"^^xsd:decimal'));
    const offer = e.sellers.spree.currentOffer();
    const ch = parse402(await fetch(e.sellers.spree.resourceUrl), e.sellers.spree.resourceUrl);
    const g = await postJson(`${e.gateway.url}/authorize`, { transactionId: "tx-tamper", agentId: AGENT_1, mandateId: m!.id, offer, offerRef: ch.offer, option: ch.options[0] }, e.agentHeaders(AGENT_1));
    assert.deepEqual([g.status, g.body.code], [403, "MANDATE_NOT_CONFIRMED"]);
    assert.equal((await assistant.purchase({ ...BERLIN, mandateId: m!.id })).code, "NO_CONFIRMED_MANDATE");
    await e.pod.putTurtle(doc, orig);
    // 3. A rejected proposal changes nothing
    e.device.setDecider(async () => false);
    const bigger = (await assistant.understand("You may spend up to 50 USDC on weather reports from approved providers.", e.registry.list().map((s) => s.webId))).result;
    const { confirmed } = await assistant.confirm(bigger.proposals, e.device);
    assert.equal(confirmed.length, 0);
    e.device.setDecider(async () => true);
    const reloaded = (await assistant.cg.load()).mandates.find((x) => x.id === m!.id)!;
    assert.equal(reloaded.totalLimit, m!.totalLimit);
    // (A preference carrying an odrl:permission is rejected by SHACL: see unit tests.)
  });

  test("payment and delivery failures remain distinguishable and recoverable", async () => {
    const e = await env({ authorizationTtlSeconds: 3 });
    const { assistant, mandate: m } = await ground(e);

    // a) Paid, not delivered -> recoverable with the same credential, no second charge
    e.sellers.spree.setBehaviour({ failDeliveryTimes: 10 });
    const r1 = await assistant.purchase({ ...BERLIN, mandateId: m!.id });
    assert.deepEqual([r1.status, r1.delivery?.status], ["paid_not_delivered", "NotDelivered"]);
    const tx = await (await fetch(`${e.gateway.url}/transactions/${r1.transactionId}`, { headers: e.agentHeaders(AGENT_1) })).json() as any;
    assert.equal(tx.status, "settled", "the gateway knows the money moved");
    e.sellers.spree.setBehaviour({ failDeliveryTimes: 0 });
    const paymentsBefore = e.signer.payments;
    const rec = await e.assistant().recoverDelivery(r1);
    assert.equal(rec.status, "completed");
    assert.equal(e.signer.payments, paymentsBefore);
    assert.equal(e.rails.facilitator.chain.balanceOf(e.sellers.spree.payTo), 20_000n);

    // b) Settlement succeeds but the response is lost -> the retry delivers, still one charge
    e.rails.facilitator.failNextSettle("timeout-after-settle");
    const r2 = await assistant.purchase({ ...BERLIN, mandateId: m!.id });
    assert.equal(r2.status, "completed");
    assert.equal(e.rails.facilitator.chain.balanceOf(e.sellers.spree.payTo), 40_000n);

    // c) Delivered but non-compliant (data too old for the agreed meaning of "current")
    e.sellers.spree.setBehaviour({ observationAgeMinutes: 120 });
    const r3 = await assistant.purchase({ ...BERLIN, mandateId: m!.id });
    assert.deepEqual([r3.status, r3.delivery?.status], ["completed_noncompliant", "NonCompliant"]);
    e.sellers.spree.setBehaviour({ observationAgeMinutes: 5 });

    // d) Payment fails (empty Lightning wallet) -> reservation held, then released after reconciliation
    const sats = await mandate(e, { slug: "sats", currency: "SAT", totalLimit: "100", maxPerTransaction: "100", allowedSchemes: ["l402"] });
    e.rails.lightning.balances.set(e.signer.lightningAccount!, 0);
    const r4 = await assistant.purchase({ ...BERLIN, mandateId: sats.id });
    assert.equal(r4.status, "payment_failed");
    assert.equal((await budget(e, sats)).committed, "25", "held while uncertain");
    await new Promise((r) => setTimeout(r, 3200));
    await postJson(`${e.gateway.url}/reconcile`, {}, e.adminHeaders);
    assert.equal((await budget(e, sats)).committed, "0", "released once provably unpaid");
    const t4 = await (await fetch(`${e.gateway.url}/transactions/${r4.transactionId}`, { headers: e.agentHeaders(AGENT_1) })).json() as any;
    assert.equal(t4.status, "released");
    assert.ok(t4.events.map((x: any) => x.type).join(",").includes("pending"));
  });

  test("the same 402 endpoint accepts x402, L402-style and card/PSP payments", async () => {
    const e = await env();
    await ground(e, "Get me a current Berlin weather report.");
    const a = e.assistant();
    const results: Record<string, string> = {};
    for (const [slug, currency, scheme, limit] of [["usdc", "USDC", "x402", "1"], ["sat", "SAT", "l402", "100"], ["eur", "EUR", "card-psp", "1"]] as const) {
      const m = await mandate(e, { slug, currency, allowedSchemes: [scheme], totalLimit: limit, maxPerTransaction: limit });
      const r = await a.purchase({ ...BERLIN, mandateId: m.id });
      results[scheme] = `${r.status}:${r.scheme}`;
      const receipt = r.receipt!.payload;
      assert.equal(receipt.scheme, scheme);
    }
    assert.deepEqual(results, { x402: "completed:x402", l402: "completed:l402", "card-psp": "completed:card-psp" });
    assert.equal(e.rails.lightning.balances.get(e.sellers.spree.lightningPayee), 25);
    assert.equal(e.rails.psp.merchantBalances.get(e.sellers.spree.merchantId), 5);
  });

  test("x402 wire format: PAYMENT-REQUIRED / PAYMENT-SIGNATURE / PAYMENT-RESPONSE", async () => {
    const e = await env();
    const res = await fetch(e.sellers.spree.resourceUrl);
    assert.equal(res.status, 402);
    const pr = b64json.decode(res.headers.get("payment-required")!);
    assert.equal(pr.x402Version, 2);
    assert.equal(pr.accepts[0].scheme, "exact");
    assert.equal(pr.accepts[0].network, "eip155:84532");
    assert.equal(pr.accepts[0].amount, "20000");
    assert.match(res.headers.get("www-authenticate")!, /^L402 macaroon=".*", invoice="lnsim1.*", Payment method="card-psp"/);
  });
});

/** Regression tests for the final audit's payment findings (gateway and signer side). */
describe("payment authority binding", () => {
  const challengeOf = async (e: Environment) => parse402(await fetch(e.sellers.spree.resourceUrl), e.sellers.spree.resourceUrl);
  const authorize = (e: Environment, body: Record<string, unknown>, headers: Record<string, string> = e.agentHeaders(AGENT_1)) =>
    postJson(`${e.gateway.url}/authorize`, { transactionId: newId("tx-"), agentId: AGENT_1, ...body }, headers);

  test("L402 and card: the gateway derives the rail reference from the challenge and binds it; the agent cannot swap it", async () => {
    const e = await env();
    await ground(e, "Get me a current Berlin weather report.");
    const offer = e.sellers.spree.currentOffer();
    const sats = await mandate(e, { slug: "sats", currency: "SAT", totalLimit: "25", maxPerTransaction: "25", allowedSchemes: ["l402"] });
    const eur = await mandate(e, { slug: "eur", currency: "EUR", totalLimit: "5", maxPerTransaction: "5", allowedSchemes: ["card-psp"] });
    for (const [scheme, m] of [["l402", sats], ["card-psp", eur]] as const) {
      const [c1, c2] = [await challengeOf(e), await challengeOf(e)];
      const [o1, o2] = [c1.options.find((o) => o.scheme === scheme)!, c2.options.find((o) => o.scheme === scheme)!];
      assert.notEqual(o1.railReference, o2.railReference);
      // Challenge for payment 1, reference of payment 2: reconciliation would ask about the wrong payment.
      const swapped = await authorize(e, { mandateId: m.id, offer, offerRef: c1.offer, option: { ...o1, railReference: o2.railReference } });
      assert.deepEqual([swapped.status, swapped.body.code], [409, "RAIL_REFERENCE_MISMATCH"], scheme);
      // Without the agent's reference the gateway still binds the challenge's own one.
      const { railReference: _r, ...bare } = o1;
      const ok = await authorize(e, { mandateId: m.id, offer, offerRef: c1.offer, option: bare });
      assert.equal(ok.status, 200, JSON.stringify(ok.body));
      assert.equal(ok.body.authorization.payload.railReference, o1.railReference, scheme);
      const row = await (await fetch(`${e.gateway.url}/transactions/${ok.body.authorization.payload.transactionId}`, { headers: e.agentHeaders(AGENT_1) })).json() as { rail_reference: string };
      assert.equal(row.rail_reference, o1.railReference, `${scheme}: the ledger reconciles against the challenge's payment`);
      await postJson(`${e.gateway.url}/reconcile`, {}, e.adminHeaders);
    }
    // A card intent the agent created itself for the same merchant and price, but another resource.
    const pi = (await postJson(`${e.rails.psp.url}/payment_intents`, { amount: 5, currency: "EUR", merchant: e.sellers.spree.merchantId, resource: "http://elsewhere.example/r" })).body.id as string;
    const card = (await challengeOf(e)).options.find((o) => o.scheme === "card-psp")!;
    const foreign = await authorize(e, { mandateId: eur.id, offer, option: { ...card, challenge: { id: pi, provider: e.rails.psp.url }, railReference: pi } });
    assert.deepEqual([foreign.status, foreign.body.code], [409, "OFFER_MISMATCH"]);
    // An L402 invoice whose string claims the signed price but whose node record is another invoice's.
    const real = (await challengeOf(e)).options.find((o) => o.scheme === "l402")!;
    const big = (await postJson(`${e.rails.lightning.url}/invoices`, { amountSat: 1000, payee: e.sellers.spree.lightningPayee, memo: "x" })).body as { paymentHash: string; paymentRequest: string };
    const lie = encodeInvoice({ paymentHash: big.paymentHash, amountSat: 25, payee: e.sellers.spree.lightningPayee, expiresAt: Date.now() + 60_000 });
    const forged = await authorize(e, { mandateId: sats.id, offer, option: { ...real, challenge: { ...(real.challenge as object), invoice: lie }, railReference: big.paymentHash } });
    assert.deepEqual([forged.status, forged.body.code], [409, "OFFER_MISMATCH"]);
  });

  test("x402: network, token and EIP-712 domain must be those of the signed offer, and the authorization carries them", async () => {
    const e = await env();
    const { mandate: m } = await ground(e);
    const offer = e.sellers.spree.currentOffer();
    const ch = await challengeOf(e);
    const x = ch.options.find((o) => o.scheme === "x402")!;
    const req = (x.challenge as any).requirements;
    for (const v of [{ network: "eip155:8453" }, { asset: "0x000000000000000000000000000000000000bad0", extra: { name: "USDC", version: "2" } }, { extra: { name: "USD Coin", version: "2" } }, { extra: { name: "USDC", version: "9" } }]) {
      const challenge = { ...(x.challenge as object), requirements: { ...req, ...v } };
      const g = await authorize(e, { mandateId: m!.id, offer, offerRef: ch.offer, option: { ...x, challenge } });
      assert.deepEqual([g.status, g.body.code], [409, "OFFER_MISMATCH"], JSON.stringify(v));
    }
    const ok = await authorize(e, { mandateId: m!.id, offer, offerRef: ch.offer, option: x });
    assert.equal(ok.status, 200);
    assert.deepEqual(ok.body.authorization.payload.x402, { network: DEFAULT_NETWORK, asset: getAddress(DEFAULT_USDC), domainName: "USDC", domainVersion: "2" });
    assert.equal(ok.body.authorization.payload.railReference, nonceFor(ok.body.authorization.payload.authId));
  });

  test("agents authenticate: identity comes from the agent's secret, and credentials and transactions go only to their agent", async () => {
    const e = await env();
    const m = await mandate(e, { slug: "only-1", assignees: [AGENT_1] });
    await ground(e, "Get me a current Berlin weather report.");
    const offer = e.sellers.spree.currentOffer();
    const ch = await challengeOf(e);
    const option = ch.options.find((o) => o.scheme === "x402")!;
    const req = { mandateId: m.id, offer, offerRef: ch.offer, option };

    assert.equal((await authorize(e, req, {})).status, 401, "a self-asserted agentId is not an identity");
    assert.equal((await authorize(e, req, e.adminHeaders)).status, 401, "the operator cannot authorize spending");
    const lying = await authorize(e, req, e.agentHeaders(AGENT_2));
    assert.deepEqual([lying.status, lying.body.code], [403, "AGENT_MISMATCH"]);
    const asItself = await authorize(e, { ...req, agentId: AGENT_2 }, e.agentHeaders(AGENT_2));
    assert.deepEqual([asItself.status, asItself.body.code], [403, "AGENT_NOT_AUTHORIZED"]);
    const ok = await authorize(e, req);
    assert.equal(ok.status, 200);
    const txId = ok.body.authorization.payload.transactionId as string;

    const read = (h: Record<string, string>) => fetch(`${e.gateway.url}/transactions/${txId}`, { headers: h });
    assert.equal((await read({})).status, 401, "the signed authorization is not public");
    assert.equal((await read(e.agentHeaders(AGENT_2))).status, 403);
    assert.ok(((await (await read(e.agentHeaders(AGENT_1))).json()) as { auth_json: string }).auth_json);
    assert.equal((await read(e.adminHeaders)).status, 200, "the dashboard reads with the admin credential");

    const pay = (h: Record<string, string>) => postJson(`${e.signer.url}/pay`, { authorization: ok.body.authorization, challenge: option.challenge }, h);
    assert.equal((await pay({})).status, 401);
    assert.deepEqual([(await pay(e.agentHeaders(AGENT_2))).status, e.signer.payments], [403, 0], "another agent gets no credential");
    assert.equal((await pay(e.agentHeaders(AGENT_1))).status, 200);
    assert.equal((await pay(e.agentHeaders(AGENT_2))).status, 403, "nor a replay of the paid one");

    assert.equal((await postJson(`${e.gateway.url}/transactions/${txId}/outcome`, { result: "payment_failed" }, e.agentHeaders(AGENT_2))).status, 403);
    assert.equal((await postJson(`${e.gateway.url}/transactions/${txId}/outcome`, { agentId: AGENT_1, result: "payment_failed" })).status, 401);
    assert.equal((await postJson(`${e.gateway.url}/reconcile`, {})).status, 401);
    assert.equal((await postJson(`${e.gateway.url}/reconcile`, {}, e.adminHeaders)).status, 200);
  });

  test("a superseded mandate revision put back into the Pod is refused by the gateway", async () => {
    const e = await env();
    await ground(e, "Get me a current Berlin weather report.");
    const r1 = await mandate(e, { slug: "rollback", totalLimit: "1.00", maxPerTransaction: "1.00" });
    const doc = r1.id.split("#")[0];
    const r1Bytes = (await e.pod.get(doc))!.text;            // an agent keeps a copy of the signed r1
    assert.equal((await budget(e, r1)).available, "1000000");
    // The user lowers the limit: r2, signed on the device; the gateway sees it.
    const { confirmation: _c, ...terms } = r1;
    const r2 = await e.assistant().cg.commit({ ...terms, status: "Proposed", revision: 2, supersedes: e.layout.historyDoc("rollback", 1), totalLimit: "0.10", maxPerTransaction: "0.05" } as SpendingMandate, e.device);
    assert.ok(r2);
    assert.equal((await budget(e, r1)).available, "100000");
    // The agent restores r1: still a valid user signature, but no longer the newest revision.
    await e.pod.putTurtle(doc, r1Bytes);
    e.sellers.spree.setPrice({ x402: "0.06" });           // above r2's per-purchase limit, within r1's
    const ch = await challengeOf(e);
    const g = await authorize(e, { mandateId: r1.id, offer: e.sellers.spree.currentOffer(), offerRef: ch.offer, option: ch.options.find((o) => o.scheme === "x402")! });
    assert.deepEqual([g.status, g.body.code], [403, "MANDATE_SUPERSEDED"]);
    assert.equal((await fetch(`${e.gateway.url}/budget?mandate=${encodeURIComponent(r1.id)}`)).status, 403);
    // A different signed text under the same revision number as one already seen is refused too.
    const twin = await e.assistant().cg.commit({ ...terms, status: "Proposed", revision: 2, supersedes: e.layout.historyDoc("rollback", 1), totalLimit: "0.50", maxPerTransaction: "0.50" } as SpendingMandate, e.device);
    assert.ok(twin);
    assert.equal(((await (await fetch(`${e.gateway.url}/budget?mandate=${encodeURIComponent(r1.id)}`)).json()) as { code: string }).code, "MANDATE_REVISION_CONFLICT");
  });
});
