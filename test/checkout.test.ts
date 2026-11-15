/**
 * ACP-style checkout for physical goods (no HTTP 402): "Buy repairable shoes.
 * You may spend up to 120 EUR including delivery." Runs against a real
 * Community Solid Server, the simulated PSP and simulated checkout merchants.
 */
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { startCss, startCheckoutEnvironment, AGENT_1, type CheckoutEnvironment } from "../src/demo/environment.js";
import type { SpendingMandate } from "../src/model.js";
import type { AcpMerchantHandle } from "../src/payments/sim/acpMerchant.js";
import { CheckoutAdapter } from "../src/checkout/adapter.js";
import { toAcpAddress } from "../src/pod/address.js";
import { verifyAttestation } from "../src/grounding/approval.js";
import { postJson } from "../src/util/http.js";
import { parseTurtle } from "../src/rdf/records.js";
import { NS } from "../src/rdf/namespaces.js";

let css: { url: string; proc: ChildProcess };
const envs: CheckoutEnvironment[] = [];
const SHOES = { text: "Buy repairable shoes.", category: "Shoes" };

before(async () => { css = await startCss(); });
after(async () => { await Promise.all(envs.map((e) => e.close())); css.proc.kill(); });

async function env(opts: Parameters<typeof startCheckoutEnvironment>[0] = {}) {
  const e = await startCheckoutEnvironment({ podUrl: css.url, ...opts });
  envs.push(e);
  return e;
}

const approvedIds = (e: CheckoutEnvironment) => [...e.registry.list(), ...e.registry.listMerchants()].map((s) => s.webId);

/** Agree "repairable" = soles can be replaced (option 1) and confirm everything proposed. */
async function ground(e: CheckoutEnvironment, text = "Buy repairable shoes. You may spend up to 120 EUR including delivery.") {
  const a = e.checkoutAssistant();
  const { ctx, result } = await a.understand(text, approvedIds(e));
  const proposals = [...result.proposals, ...result.questions.flatMap((q) => a.answer(q, 0, ctx))];
  const { confirmed } = await a.confirm(proposals, e.device);
  return { assistant: a, result, mandate: confirmed.find((r) => r.kind === "mandate") as SpendingMandate | undefined };
}

async function mandate(e: CheckoutEnvironment, terms: Partial<SpendingMandate> & { slug: string }) {
  const { slug, ...rest } = terms;
  const m: SpendingMandate = {
    kind: "mandate", id: e.layout.mandate(slug), owner: e.layout.webId, revision: 1, status: "Proposed",
    assignees: [AGENT_1], targets: ["Shoes"], currency: "EUR", maxPerTransaction: "120.00", totalLimit: "500.00",
    allowedSellers: e.registry.listMerchants().map((s) => s.webId).sort(), allowedSchemes: ["acp-delegated"],
    validUntil: new Date(Date.now() + 86_400_000).toISOString(), ...rest,
  };
  const out = await e.checkoutAssistant().cg.commit(m, e.device);
  assert.ok(out);
  return out as SpendingMandate;
}

/** What an agent sends the gateway for a session it prepared with a merchant (product -1, shipped to the Pod address). */
async function quote(e: CheckoutEnvironment, merchant: AcpMerchantHandle) {
  const adapter = new CheckoutAdapter([merchant.url]);
  const [c] = await adapter.discover("Shoes", "DE");
  const s = await adapter.shipTo(c.apiBase, (await adapter.open(c, 1, "k-" + Math.random()))!, toAcpAddress(e.address));
  const option = adapter.paymentOption(c, s!);
  const claim = { merchant: merchant.webId, sessionId: s!.id, lineItems: [{ id: c.product.id, quantity: 1 }] };
  return { adapter, candidate: c, session: s!, option, claim };
}

const authorize = (e: CheckoutEnvironment, txId: string, m: SpendingMandate, q: { claim: unknown; option: unknown }) =>
  postJson(`${e.gateway.url}/authorize`, { transactionId: txId, agentId: AGENT_1, mandateId: m.id, checkout: q.claim, option: q.option }, e.agentHeaders(AGENT_1));
const budget = async (e: CheckoutEnvironment, m: SpendingMandate) => (await (await fetch(`${e.gateway.url}/budget?mandate=${encodeURIComponent(m.id)}`)).json()) as { settled: string; committed: string; available: string };
const tx = async (e: CheckoutEnvironment, id: string) => (await (await fetch(`${e.gateway.url}/transactions/${id}`, { headers: e.adminHeaders })).json()) as any;
const charge = (e: CheckoutEnvironment, key: string, body: object, idem = "c-" + Math.random()) =>
  postJson(`${e.rails.psp.url}/agentic_commerce/charges`, body, { authorization: `Bearer ${key}`, "idempotency-key": idem });

/** Authorize q under a fresh transaction id and have the signer mint its delegated token. */
async function authorizeAndPay(e: CheckoutEnvironment, m: SpendingMandate, q: Awaited<ReturnType<typeof quote>>, txId = "tx-" + Math.random()) {
  const a = await authorize(e, txId, m, q);
  assert.equal(a.status, 200, JSON.stringify(a.body));
  const p = await postJson(`${e.signer.url}/pay`, { authorization: a.body.authorization, challenge: q.option.challenge }, e.agentHeaders(AGENT_1));
  assert.equal(p.status, 200, JSON.stringify(p.body));
  return { txId, authId: a.body.authorization.payload.authId as string, credential: p.body.credential };
}
/** POST /complete straight to Sohle & Co, as a (possibly misbehaving) agent would. */
const completeRaw = (e: CheckoutEnvironment, sessionId: string, token: string, key: string) =>
  postJson(`${e.merchants.sohle.url}/checkout_sessions/${sessionId}/complete`, { payment_data: { token, provider: e.rails.psp.url } }, { "idempotency-key": key });

describe("ACP-style checkout (physical goods)", () => {
  test("an allowed purchase filters on the agreed meaning and the delivered total, and shares the address with one shop", async () => {
    const e = await env();
    const { assistant, result, mandate: m } = await ground(e);
    assert.equal(result.questions[0]?.term, "repairable", "'repairable' is clarified before anything is assumed");
    assert.deepEqual([m!.maxPerTransaction, m!.currency, m!.targets], ["120", "EUR", ["Shoes"]]);
    assert.ok(m!.allowedSchemes.includes("acp-delegated"));

    const r = await assistant.purchaseViaCheckout({ ...SHOES, mandateId: m!.id });
    assert.equal(r.status, "fulfilment_pending", r.reason);
    assert.equal(r.selected?.sellerName, "Sohle & Co");
    assert.equal(r.amount, "9490", "item 89.00 + standard delivery 5.90");
    const byName = Object.fromEntries(r.evaluations.map((ev) => [ev.sellerName, ev]));
    assert.ok(byName["Billig Schuh"].reasons.some((x: string) => /solesReplaceable.*not met/.test(x)));
    assert.ok(byName["Atelier Leder"].reasons.some((x: string) => /123\.9 EUR above per-purchase limit/.test(x)));
    assert.ok(byName["Schnäppchen Outlet"].reasons.some((x: string) => /not allowed by the mandate/.test(x)));

    // Money: charged once, at the PSP, the exact total; ledger settled from the PSP's view
    assert.equal(e.rails.psp.merchantBalances.get(e.merchants.sohle.merchantId), 9490);
    assert.equal((await tx(e, r.transactionId!)).status, "settled");
    assert.equal((await budget(e, m!)).settled, "9490");

    // Privacy: only the merchant being paid ever received the address
    assert.equal(e.merchants.sohle.receivedAddresses.length, 1);
    for (const other of [e.merchants.billig, e.merchants.atelier, e.merchants.outlet]) assert.equal(other.receivedAddresses.length, 0);

    // Evidence: purchase -> checkout session, ledger, and a fulfilment document marked pending
    const st = parseTurtle((await e.pod.get(r.evidence!))!.text, r.evidence!);
    const objs = (s: string, p: string) => st.getObjects(s, p, null).map((t) => t.value);
    assert.match(objs(r.evidence + "#tx", NS.sc + "checkoutSession")[0], /\/checkout_sessions\/cs_/);
    assert.equal(objs(r.evidence + "#delivery", NS.sc + "status")[0], NS.sc + "FulfilmentPending");
    const fdoc = objs(r.evidence + "#tx", NS.sc + "fulfilment")[0].split("#")[0];
    const fulfilment = (await e.pod.get(fdoc))!.text;
    assert.match(fulfilment, /schema:Order/);
    assert.match(fulfilment, /schema:OrderProcessing/);
    assert.ok(fulfilment.includes(e.layout.address().split("#")[0]));
    assert.match((await e.pod.get(r.evidence!.replace(/\.ttl$/, "-ledger.ttl")))!.text, /sc:Settled/);
  });

  test("a total including delivery or tax over the limit is blocked", async () => {
    const e = await env();
    const { assistant, mandate: m } = await ground(e);
    // The gateway, asked directly, computes the limit on the merchant's own total (109.00 + 14.90 delivery)
    const q = await quote(e, e.merchants.atelier);
    const g = await authorize(e, "tx-atelier", m!, q);
    assert.deepEqual([g.status, g.body.code], [403, "PER_TRANSACTION_LIMIT"]);
    // A session without a selected delivery option is not payable at all
    const bare = await quote(e, e.merchants.sohle);
    const noShip = await bare.adapter.open(bare.candidate, 1, "bare");
    const g2 = await authorize(e, "tx-noship", m!, { claim: { ...bare.claim, sessionId: noShip!.id }, option: { ...bare.option, resource: bare.option.resource.replace(bare.session.id, noShip!.id) } });
    assert.deepEqual([g2.status, g2.body.code], [409, "CHECKOUT_NOT_READY"]);
    // The assistant: tax added at checkout pushes the only fitting product over 120 EUR
    e.merchants.sohle.setTaxRate(3000);
    const r = await assistant.purchaseViaCheckout({ ...SHOES, mandateId: m!.id });
    assert.equal(r.status, "no_acceptable_offer");
    assert.ok(r.notes.some((n) => /Sohle & Co: total incl\. delivery 123\.37 EUR exceeds 120 EUR/.test(n)));
    assert.equal(e.rails.psp.charges.size, 0);
    assert.equal((await budget(e, m!)).committed, "0");
  });

  test("a merchant changing its total after the quote is caught by the gateway's own re-read", async () => {
    const e = await env();
    const { assistant, mandate: m } = await ground(e);
    const q = await quote(e, e.merchants.sohle);
    e.merchants.sohle.setPrice(q.candidate.product.id, 9900);
    const g = await authorize(e, "tx-stale", m!, q);
    assert.deepEqual([g.status, g.body.code], [409, "CHECKOUT_CHANGED"]);
    e.merchants.sohle.setPrice(q.candidate.product.id, 8900);

    // Assistant: price rises between quote and authorization -> re-read, re-check limits, pay the new total
    const r = await assistant.purchaseViaCheckout({ ...SHOES, mandateId: m!.id, hooks: { afterQuote: async (s) => { if (s.totals.find((t) => t.type === "total")!.amount === 9490) e.merchants.sohle.setPrice("sohle-und-co-1", 9500); } } });
    assert.equal(r.status, "fulfilment_pending");
    assert.equal(r.amount, "10090");
    assert.ok(r.notes.some((n) => /CHECKOUT_CHANGED.*re-validated/.test(n)));
    assert.equal(e.rails.psp.merchantBalances.get(e.merchants.sohle.merchantId), 10090);
  });

  test("unapproved merchants and substituted checkout terms are blocked", async () => {
    const e = await env();
    await ground(e);
    const wide = await mandate(e, { slug: "wide", allowedSellers: [...e.registry.listMerchants().map((s) => s.webId), e.merchants.outlet.webId] });
    const outlet = await quote(e, e.merchants.outlet);
    const g1 = await authorize(e, "tx-outlet", wide, outlet);
    assert.deepEqual([g1.status, g1.body.code], [403, "MERCHANT_NOT_APPROVED"]);
    // Claiming to be an approved merchant: the gateway reads from that merchant's pinned URL and finds no such session
    const g2 = await authorize(e, "tx-impostor", wide, { claim: { ...outlet.claim, merchant: e.merchants.sohle.webId }, option: outlet.option });
    assert.deepEqual([g2.status, g2.body.code], [409, "CHECKOUT_UNAVAILABLE"]);

    const q = await quote(e, e.merchants.sohle);
    const g3 = await authorize(e, "tx-items", wide, { ...q, claim: { ...q.claim, lineItems: [{ id: "sohle-und-co-1", quantity: 2 }] } });
    assert.deepEqual([g3.status, g3.body.code], [409, "CHECKOUT_MISMATCH"], "line items must be the ones evaluated");
    const g4 = await authorize(e, "tx-payee", wide, { ...q, option: { ...q.option, payTo: e.merchants.billig.merchantId } });
    assert.deepEqual([g4.status, g4.body.code], [409, "CHECKOUT_MISMATCH"]);
    // An agent redirects the parcel to itself
    await postJson(q.option.resource, { fulfillment_address: { ...toAcpAddress(e.address), name: "Mallory", line_one: "Elsewhere 9" } });
    const s2 = (await q.adapter.read(e.merchants.sohle.url, q.session.id))!;
    const g5 = await authorize(e, "tx-address", wide, { claim: q.claim, option: q.adapter.paymentOption(q.candidate, s2) });
    assert.deepEqual([g5.status, g5.body.code], [409, "ADDRESS_MISMATCH"]);
    assert.equal(e.rails.psp.charges.size, 0);
  });

  test("a delegated token cannot overcharge, be reused, or be used for another session or merchant", async () => {
    const e = await env();
    const m = await mandate(e, { slug: "eur" });
    const q = await quote(e, e.merchants.sohle);
    const a = await authorize(e, "tx-token", m, q);
    assert.equal(a.status, 200, JSON.stringify(a.body));
    const pay = () => postJson(`${e.signer.url}/pay`, { authorization: a.body.authorization, challenge: q.option.challenge }, e.agentHeaders(AGENT_1));
    const [p1, p2] = await Promise.all([pay(), pay()]);
    assert.equal(p1.body.credential.token, p2.body.credential.token, "one token per authorization");
    assert.equal(e.signer.payments, 1);
    assert.equal([...e.rails.psp.tokens.values()].filter((t) => t.metadata.authorization_id === a.body.authorization.payload.authId).length, 1);
    assert.ok(!JSON.stringify(p1.body).includes([...e.rails.psp.cards.keys()][0]), "the card token never leaves the signer");

    const token = p1.body.credential.token;
    const sohleKey = e.rails.psp.registerMerchant(e.merchants.sohle.merchantId);
    const billigKey = e.rails.psp.registerMerchant(e.merchants.billig.merchantId);
    const ok = { token, amount: 9490, currency: "eur", merchant_id: e.merchants.sohle.merchantId, checkout_session_id: q.session.id, checkout_snapshot_digest: (q.option.challenge as { snapshot_digest: string }).snapshot_digest };
    assert.equal((await charge(e, sohleKey, { ...ok, checkout_snapshot_digest: "sha256:changed" })).body.code, "checkout_snapshot_mismatch");
    assert.equal((await charge(e, sohleKey, { ...ok, amount: 9491 })).body.code, "amount_exceeds_allowance");
    assert.equal((await charge(e, billigKey, { ...ok, merchant_id: e.merchants.billig.merchantId })).body.code, "merchant_mismatch");
    assert.equal((await charge(e, sohleKey, { ...ok, checkout_session_id: "cs_other" })).body.code, "checkout_session_mismatch");
    assert.equal((await charge(e, sohleKey, { ...ok, currency: "usd" })).body.code, "currency_mismatch");
    const c1 = await charge(e, sohleKey, ok, "same");
    assert.equal(c1.status, 200);
    assert.equal((await charge(e, sohleKey, ok, "same")).body.id, c1.body.id, "same idempotency key replays");
    assert.equal((await charge(e, sohleKey, ok)).body.code, "token_already_used");
    assert.equal(e.rails.psp.merchantBalances.get(e.merchants.sohle.merchantId), 9490);
  });

  test("retried and lost completion responses charge exactly once", async () => {
    const e = await env();
    await ground(e, "Buy repairable shoes.");
    const m = await mandate(e, { slug: "eur" });
    const a = e.checkoutAssistant();
    // One lost response: the retry with Idempotency-Key = authId replays the merchant's result
    e.merchants.sohle.loseNextCompletionResponses(1);
    const r1 = await a.purchaseViaCheckout({ ...SHOES, mandateId: m.id });
    assert.equal(r1.status, "fulfilment_pending");
    // Every retry lost: the adapter reads the session back; the gateway settles from the PSP
    e.merchants.sohle.loseNextCompletionResponses(10);
    const r2 = await a.purchaseViaCheckout({ ...SHOES, mandateId: m.id });
    assert.equal(r2.status, "fulfilment_pending");
    assert.equal((await tx(e, r2.transactionId!)).status, "settled");
    assert.equal(e.rails.psp.charges.size, 2);
    assert.equal(e.merchants.sohle.completions, 2);

    // Replaying the real completion (the adapter's key = authId, and the real delegated token),
    // then the same token under a fresh key: the merchant replays, the PSP never charges again
    e.merchants.sohle.loseNextCompletionResponses(0);
    const session = [...e.merchants.sohle.sessions.values()].find((s) => s.order?.id === r2.tracking!.orderId)!;
    const authId = JSON.parse((await tx(e, r2.transactionId!)).auth_json).payload.authId as string;
    const token = [...e.rails.psp.tokens.values()].find((t) => t.metadata.authorization_id === authId)!.id;
    for (const key of [authId, "another-key"]) {
      const again = await completeRaw(e, session.id, token, key);
      assert.equal(again.body.status, "completed");
      assert.equal(again.body.order.id, r2.tracking!.orderId);
    }
    assert.equal(e.rails.psp.charges.size, 2);
    assert.equal(e.merchants.sohle.orders.size, 2);
    assert.equal(e.rails.psp.merchantBalances.get(e.merchants.sohle.merchantId), 18980);
    assert.equal((await budget(e, m)).settled, "18980");
  });

  test("a declined charge is held, then released by reconciliation once the token has expired", async () => {
    const e = await env({ authorizationTtlSeconds: 2 });
    await ground(e, "Buy repairable shoes.");
    const m = await mandate(e, { slug: "eur" });
    e.rails.psp.declineNextCharges(1);
    const r = await e.checkoutAssistant().purchaseViaCheckout({ ...SHOES, mandateId: m.id });
    assert.deepEqual([r.status, r.code], ["payment_failed", "card_declined"]);
    assert.equal(r.tracking, undefined, "no order: a payment failure, not a delivery problem");
    assert.equal((await tx(e, r.transactionId!)).status, "pending");
    assert.equal((await budget(e, m)).committed, "9490", "held while the token could still be charged");
    await postJson(`${e.gateway.url}/reconcile`, {}, e.adminHeaders);
    assert.equal((await budget(e, m)).committed, "9490", "the agent's report alone releases nothing");

    await new Promise((res) => setTimeout(res, 2200));
    const token = [...e.rails.psp.tokens.values()][0];
    const late = await charge(e, e.rails.psp.registerMerchant(e.merchants.sohle.merchantId), { token: token.id, amount: 9490, currency: "eur", merchant_id: e.merchants.sohle.merchantId, checkout_session_id: token.allowance.checkout_session_id });
    assert.equal(late.body.code, "token_expired");
    await postJson(`${e.gateway.url}/reconcile`, {}, e.adminHeaders);
    const t = await tx(e, r.transactionId!);
    assert.equal(t.status, "released");
    assert.equal((await budget(e, m)).committed, "0");
  });

  test("delivery is tracked to the user's signed verdict; cancellation refunds and releases budget only once the PSP confirms", async () => {
    const e = await env();
    const { assistant: a } = await ground(e, "Buy repairable shoes.");
    const m = await mandate(e, { slug: "eur" });
    const r = await a.purchaseViaCheckout({ ...SHOES, mandateId: m.id });
    let t = r.tracking!;
    assert.deepEqual([t.orderStatus, t.delivery.status, t.paymentStatus], ["created", "FulfilmentPending", "settled"]);

    e.merchants.sohle.advanceOrder(t.orderId);
    t = await a.trackOrder(t);
    assert.deepEqual([t.orderStatus, t.delivery.status], ["shipped", "FulfilmentPending"]);
    t = await a.cancelOrder(t);
    assert.equal(t.orderStatus, "shipped", "too late to cancel");
    assert.equal(t.paymentStatus, "settled");

    e.merchants.sohle.advanceOrder(t.orderId);
    t = await a.trackOrder(t);
    assert.deepEqual([t.orderStatus, t.delivery.status], ["delivered", "FulfilmentPending"], "the carrier's word is not acceptance");
    // The user finds the soles are glued on: not what "repairable" was agreed to mean
    t = await a.acceptDelivery(t, { solesReplaceable: "false" }, e.device);
    assert.equal(t.delivery.status, "NonCompliant");
    const att = { kind: "deliveryAcceptance" as const, owner: e.layout.webId, transactionId: t.transactionId, orderId: t.orderId, verdict: t.acceptance!.verdict, checks: t.acceptance!.checks };
    assert.ok(verifyAttestation(att, { ...t.acceptance!, by: t.acceptance!.by }, [e.device.publicJwk]));
    const doc = (await e.pod.get(t.fulfilment))!.text;
    assert.match(doc, /schema:OrderDelivered/);
    assert.match(doc, /sc:NonCompliant/);
    assert.match(doc, /sc:DeliveryAcceptance/);
    assert.equal((await budget(e, m)).settled, "9490", "a non-compliant delivery is a dispute, not an automatic refund");

    // A second order, canceled before shipment: merchant refunds at the PSP; the gateway confirms it there
    const r2 = await a.purchaseViaCheckout({ ...SHOES, mandateId: m.id });
    assert.equal((await budget(e, m)).committed, "18980");
    const t2 = await a.cancelOrder(r2.tracking!);
    assert.deepEqual([t2.orderStatus, t2.paymentStatus, t2.delivery.status], ["refunded", "refunded", "Cancelled"]);
    assert.equal((await budget(e, m)).committed, "9490");
    assert.equal(e.rails.psp.merchantBalances.get(e.merchants.sohle.merchantId), 9490);
    assert.match((await e.pod.get(r2.evidence!.replace(/\.ttl$/, "-ledger.ttl")))!.text, /sc:Refunded/);
    // The first order (not refunded) stays settled after a full reconciliation pass
    await postJson(`${e.gateway.url}/reconcile`, {}, e.adminHeaders);
    assert.equal((await tx(e, r.transactionId!)).status, "settled");
  });
  test("a session re-addressed or re-itemized after authorization cannot be completed or charged", async () => {
    const e = await env();
    const m = await mandate(e, { slug: "eur" });
    const sohle = e.merchants.sohle;
    const outcome = (txId: string) => postJson(`${e.gateway.url}/transactions/${txId}/outcome`, { agentId: AGENT_1, result: "paid" }, e.agentHeaders(AGENT_1));

    // Redirect the parcel after the gateway approved the user's address
    const q1 = await quote(e, sohle);
    const p1 = await authorizeAndPay(e, m, q1);
    const moved = await postJson(q1.option.resource, { fulfillment_address: { ...toAcpAddress(e.address), name: "Mallory", line_one: "Elsewhere 9" } });
    assert.equal(moved.body.status, "ready_for_payment", "the merchant still accepts updates (ACP allows them)");
    const d1 = await q1.adapter.complete(sohle.url, q1.session.id, p1.credential, p1.authId);
    assert.equal(d1.kind, "declined");
    assert.equal(d1.kind === "declined" && d1.code, "checkout_snapshot_mismatch");

    // Re-itemize after authorization
    const q2 = await quote(e, sohle);
    const p2 = await authorizeAndPay(e, m, q2);
    await postJson(q2.option.resource, { items: [{ id: q2.candidate.product.id, quantity: 1 }] });
    const d2 = await completeRaw(e, q2.session.id, p2.credential.token, p2.authId);
    assert.deepEqual([d2.status, d2.body.code], [402, "checkout_snapshot_mismatch"]);

    assert.equal(e.rails.psp.charges.size, 0);
    assert.equal(sohle.orders.size, 0);
    // Nothing was charged, so nothing settles on the agent's word
    assert.equal((await outcome(p1.txId)).body.status, "pending");
    assert.equal((await outcome(p2.txId)).body.status, "pending");

    // Restoring the authorized address restores the authorized snapshot: exactly that can be paid
    await postJson(q1.option.resource, { fulfillment_address: toAcpAddress(e.address) });
    const d3 = await q1.adapter.complete(sohle.url, q1.session.id, p1.credential, p1.authId);
    assert.equal(d3.kind, "completed");
    assert.deepEqual(d3.kind === "completed" && d3.session.fulfillment_address, toAcpAddress(e.address));
    assert.equal(e.rails.psp.charges.size, 1);
  });

  test("a checkout session has at most one live authorization, and concurrent completions charge once", async () => {
    const e = await env();
    const m = await mandate(e, { slug: "eur" });
    const q = await quote(e, e.merchants.sohle);
    const [g1, g2] = await Promise.all([authorize(e, "tx-d1", m, q), authorize(e, "tx-d2", m, q)]);
    assert.deepEqual([g1.status, g2.status].sort(), [200, 409]);
    assert.equal([g1, g2].find((g) => g.status === 409)!.body.code, "CHECKOUT_ALREADY_AUTHORIZED");
    assert.equal((await budget(e, m)).committed, "9490");
    const g3 = await authorize(e, "tx-d3", m, q);
    assert.deepEqual([g3.status, g3.body.code], [409, "CHECKOUT_ALREADY_AUTHORIZED"]);
    const replay = await authorize(e, g1.status === 200 ? "tx-d1" : "tx-d2", m, q);
    assert.equal(replay.body.replayed, true, "the idempotent replay of the live authorization is still answered");

    // Defence in depth at the merchant: two tokens for one session (as a gateway without that
    // check would have produced), completed concurrently under different keys
    const q2 = await quote(e, e.merchants.sohle);
    const card = [...e.rails.psp.cards.keys()][0];
    const challenge = q2.option.challenge as { snapshot_digest: string };
    const mint = async (i: number) => (await postJson(`${e.rails.psp.url}/agentic_commerce/delegate_payment`, {
      payment_method: { type: "card", token: card }, metadata: { authorization_id: `auth-direct-${i}` },
      allowance: { reason: "one_time", max_amount: 9490, currency: "eur", checkout_session_id: q2.session.id, merchant_id: e.merchants.sohle.merchantId, expires_at: new Date(Date.now() + 60_000).toISOString(), checkout_snapshot_digest: challenge.snapshot_digest },
    }, { "idempotency-key": `mint-${i}` })).body.id as string;
    const [t1, t2] = [await mint(1), await mint(2)];
    const [c1, c2] = await Promise.all([completeRaw(e, q2.session.id, t1, "k1"), completeRaw(e, q2.session.id, t2, "k2")]);
    assert.deepEqual([c1.body.status, c2.body.status], ["completed", "completed"]);
    assert.equal(c1.body.order.id, c2.body.order.id);
    assert.equal(e.rails.psp.charges.size, 1);
    assert.equal(e.merchants.sohle.orders.size, 1);
    assert.equal(e.rails.psp.merchantBalances.get(e.merchants.sohle.merchantId), 9490);
  });

  test("concurrent completions under the same Idempotency-Key create one order", async () => {
    const e = await env();
    const m = await mandate(e, { slug: "eur" });
    const q = await quote(e, e.merchants.sohle);
    const p = await authorizeAndPay(e, m, q);
    const [c1, c2] = await Promise.all([completeRaw(e, q.session.id, p.credential.token, p.authId), completeRaw(e, q.session.id, p.credential.token, p.authId)]);
    assert.deepEqual([c1.status, c2.status], [200, 200]);
    assert.equal(c1.body.order.id, c2.body.order.id);
    assert.equal(e.merchants.sohle.orders.size, 1);
    assert.equal(e.merchants.sohle.completions, 1);
    assert.equal(e.rails.psp.charges.size, 1);
  });

  test("per-transaction reconciliation never releases a settled payment and needs the transaction's agent", async () => {
    const e = await env();
    const m = await mandate(e, { slug: "eur", allowedSchemes: ["acp-delegated", "card-psp"] });
    const past = new Date(Date.now() - 60_000).toISOString();
    // Expired card/PSP rows. The settled one (paid, per the seller's signed receipt) points at an
    // intent the PSP now reports as unconfirmed; the pending one at an intent the PSP does not know.
    const unconfirmed = (await postJson(`${e.rails.psp.url}/payment_intents`, { amount: 100, currency: "EUR", merchant: "acct_x", resource: "https://seller.example/r" })).body.id as string;
    const row = (tx_id: string, status: "settled" | "pending", rail_reference: string) => e.gateway.ledger.insert({
      tx_id, mandate_id: m.id, agent_id: AGENT_1, seller: "https://seller.example/profile#me", offer_id: "https://seller.example/offer", offer_version: 1,
      scheme: "card-psp", amount: "100", currency: "EUR", request_digest: "d-" + tx_id, status, auth_id: "auth-" + tx_id, auth_json: null,
      rail_reference, payer: null, receipt_json: null, reason: null, expires_at: past,
    });
    row("tx-settled", "settled", unconfirmed);
    row("tx-pending", "pending", "pi_gone");
    const rec = (id: string, agentId = AGENT_1) => postJson(`${e.gateway.url}/transactions/${id}/reconcile`, { agentId }, e.agentHeaders(agentId));
    assert.equal((await rec("tx-settled", "urn:someone-else")).status, 403);
    assert.equal((await rec("tx-settled")).body.status, "settled");
    assert.equal((await rec("tx-pending")).body.status, "pending", "a rail that cannot answer is not proof of non-payment");
    await postJson(`${e.gateway.url}/reconcile`, {}, e.adminHeaders);
    assert.equal((await tx(e, "tx-settled")).status, "settled");
    assert.equal((await tx(e, "tx-pending")).status, "pending");
    assert.equal((await budget(e, m)).committed, "200");
  });

  test("a failed refund on cancellation is reported as such and the cancellation can be retried", async () => {
    const e = await env();
    const { assistant: a } = await ground(e, "Buy repairable shoes.");
    const m = await mandate(e, { slug: "eur" });
    const r = await a.purchaseViaCheckout({ ...SHOES, mandateId: m.id });
    e.rails.psp.failNextRefunds(1);
    const res = await postJson(`${r.tracking!.orderUrl}/cancel`, {});
    assert.deepEqual([res.status, res.body.code], [502, "refund_failed"]);
    let t = await a.trackOrder(r.tracking!);
    assert.deepEqual([t.orderStatus, t.paymentStatus, t.delivery.status], ["canceled", "settled", "Cancelled"]);
    assert.match(t.delivery.checks[0], /refund not yet confirmed/);
    assert.equal((await budget(e, m)).committed, "9490", "no refund confirmed, so the budget stays committed");
    assert.throws(() => e.merchants.sohle.advanceOrder(t.orderId), "a canceled order is not shipped");

    t = await a.cancelOrder(t);
    assert.deepEqual([t.orderStatus, t.paymentStatus, t.delivery.status], ["refunded", "refunded", "Cancelled"]);
    assert.equal((await budget(e, m)).committed, "0");
    assert.equal(e.rails.psp.merchantBalances.get(e.merchants.sohle.merchantId), 0);
    t = await a.cancelOrder(t);
    assert.equal(e.rails.psp.merchantBalances.get(e.merchants.sohle.merchantId), 0, "a repeated cancellation refunds nothing more");
  });

  test("a refund after delivery keeps the user's signed verdict and is recorded as a return", async () => {
    const e = await env();
    const { assistant: a } = await ground(e, "Buy repairable shoes.");
    const m = await mandate(e, { slug: "eur" });
    let t = (await a.purchaseViaCheckout({ ...SHOES, mandateId: m.id })).tracking!;
    e.merchants.sohle.advanceOrder(t.orderId);
    e.merchants.sohle.advanceOrder(t.orderId);
    t = await a.trackOrder(t);
    t = await a.acceptDelivery(t, { solesReplaceable: "false" }, e.device);
    assert.equal(t.delivery.status, "NonCompliant");

    await e.merchants.sohle.refundOrder(t.orderId);
    t = await a.trackOrder(t);
    assert.deepEqual([t.orderStatus, t.paymentStatus, t.delivery.status], ["returned", "refunded", "NonCompliant"]);
    assert.ok(t.delivery.checks.some((c) => /returned; refund confirmed/.test(c)));
    const doc = (await e.pod.get(t.fulfilment))!.text;
    assert.match(doc, /schema:OrderReturned/);
    assert.match(doc, /sc:NonCompliant/);
    assert.match(doc, /sc:Refunded/);
    assert.doesNotMatch(doc, /schema:OrderCancelled/);

    // A retried merchant refund changes nothing: still a return, verdict intact, nothing refunded twice.
    await e.merchants.sohle.refundOrder(t.orderId);
    t = await a.trackOrder(t);
    assert.deepEqual([t.orderStatus, t.paymentStatus, t.delivery.status], ["returned", "refunded", "NonCompliant"]);
    assert.doesNotMatch((await e.pod.get(t.fulfilment))!.text, /schema:OrderCancelled/);
    assert.equal(e.rails.psp.merchantBalances.get(e.merchants.sohle.merchantId), 0);
  });

  test("concurrent refunds of one order refund once and keep a return a return; concurrent cancellations record one refund", async () => {
    const e = await env();
    const { assistant: a } = await ground(e, "Buy repairable shoes.");
    const m = await mandate(e, { slug: "eur" });
    let t = (await a.purchaseViaCheckout({ ...SHOES, mandateId: m.id })).tracking!;
    e.merchants.sohle.advanceOrder(t.orderId);
    e.merchants.sohle.advanceOrder(t.orderId);
    t = await a.trackOrder(t);
    t = await a.acceptDelivery(t, { solesReplaceable: "false" }, e.device);
    const [o1, o2] = await Promise.all([e.merchants.sohle.refundOrder(t.orderId), e.merchants.sohle.refundOrder(t.orderId)]);
    assert.deepEqual([o1.status, o2.status], ["returned", "returned"]);
    const order = e.merchants.sohle.orders.get(t.orderId)!;
    assert.deepEqual(order.events.map((x) => x.status), ["created", "shipped", "delivered", "returned"]);
    t = await a.trackOrder(t);
    assert.deepEqual([t.orderStatus, t.paymentStatus, t.delivery.status], ["returned", "refunded", "NonCompliant"]);

    const t2 = (await a.purchaseViaCheckout({ ...SHOES, mandateId: m.id })).tracking!;
    const cancels = await Promise.all([postJson(`${t2.orderUrl}/cancel`, {}), postJson(`${t2.orderUrl}/cancel`, {})]);
    assert.deepEqual(cancels.map((c) => c.status), [200, 200]);
    assert.deepEqual(e.merchants.sohle.orders.get(t2.orderId)!.events.map((x) => x.status), ["created", "canceled", "refunded"]);
  });
});
