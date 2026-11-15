// Dashboard. All state is folded from the server's event log (src/web/events.ts); nothing here
// invents a number. The same code renders a live session and a replayed recording.
import { ICONS, api, approvalCard, approvalsReducer, connect, esc, info, patch, resolvedList, token } from "./shared.js";

const $ = (id) => document.getElementById(id);
const DECIMALS = { USDC: 6, SAT: 0, EUR: 2, USD: 2 };
const GUARDS = [
  { id: "tamper", title: "Agent raises its own limit", text: "Edits the signed mandate in the Pod to 100 USDC, then calls the gateway directly.", button: "Run attack" },
  { id: "price", title: "Seller raises its price mid-purchase", text: "The price goes up by 0.01 USDC after the offers were compared.", button: "Run scenario" },
  { id: "race", title: "Six purchases at once", text: "Two agents fire six parallel purchases against a shared 0.05 USDC mandate.", button: "Run race" },
  { id: "crash", title: "Seller crashes after being paid", text: "Payment settles, then the seller's API answers 503. Recover with the same proof of payment.", button: "Run failure" },
  { id: "replay", title: "Replay the payment elsewhere", text: "Re-send Spree's payment to Havel Data, and re-send it to Spree three times.", button: "Run replay" },
  { id: "unapproved", title: "Unapproved seller", text: "Shady Forecasts is cheapest. A compromised agent tries to pay it anyway.", button: "Run attack" },
];
const TONE_LABEL = { blocked: "Blocked", warn: "Handled", ok: "Recovered", fail: "Guardrail did not hold" };

// ------------------------------------------------------------------ state

const fresh = () => ({
  mode: "live", replay: null, components: {}, session: null, busy: null,
  steps: [], stepState: {}, request: "",
  chat: { weather: [], shoes: [] }, question: null, choice: null, confirmed: { weather: [], shoes: [] },
  offers: null, purchase: null, delivery: null, evidence: null,
  shoes: { agreed: null, products: null, purchase: null, checkout: null, order: null, notes: [] },
  guards: {}, guardSummary: null,
  wire: [], pod: null, podBase: null, docs: [], budgets: {},
  approvals: approvalsReducer(undefined, { type: "reset" }), agentLog: [], errors: [], recorded: null,
});
let s = fresh();

const store = { get: (k) => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } } };
const ui = {
  tab: store.get("demo.tab") ?? "weather",
  view: new URLSearchParams(location.search).get("view") ?? store.get("demo.view") ?? "research",
  wireFilter: null, phoneOpen: false, seenPending: new Set(), docSel: null, authorized: false, phoneUrl: "",
  /** Set when this page's token stopped working (the server restarted with another one). */
  tokenStale: false,
};

function reduce(e) {
  const d = e.data;
  s.approvals = approvalsReducer(s.approvals, e);
  switch (e.type) {
    case "reset": { const auto = s.approvals.auto; s = fresh(); s.approvals.auto = auto; ui.docSel = null; break; }
    case "session": s.session = d; s.mode = s.replay ? "replay" : d.mode; break;
    case "replay": s.replay = d; s.mode = "replay"; break;
    case "components": for (const c of d.components) s.components[c.id] = c; break;
    case "busy":
      if (d.action && !s.busy) s.podBase = s.pod;   // "+n new" counts what the next action adds
      s.busy = d.action;
      break;
    case "steps": if (d.scenario === "weather") { s.steps = d.steps; s.request = d.request; } break;
    case "step": if (d.scenario === "weather") s.stepState[d.index] = d.state; break;
    case "chat": s.chat[d.scenario].push(d); break;
    case "question": s.question = d; s.choice = d.selected; break;
    case "weather.choice": s.choice = d.index; break;
    case "answer": s.question = { ...s.question, answered: d.index }; break;
    case "confirmed": s.confirmed[d.scenario] = d.items; break;
    case "offers": s.offers = d.items; break;
    case "purchase": s.purchase = d; break;
    case "delivery": s.delivery = d; break;
    case "evidence": s.evidence = d.links; break;
    case "wire": s.wire.push(d); if (s.wire.length > 600) s.wire.splice(0, s.wire.length - 600); break;
    case "pod": s.pod = d; s.podBase ??= d; break;
    case "pod.doc": s.docs = [d, ...s.docs.filter((x) => x.path !== d.path)].slice(0, 12); break;
    case "budget": s.budgets[d.key] = d; break;
    case "agent.log": s.agentLog.push(d); if (s.agentLog.length > 200) s.agentLog.shift(); break;
    case "fixture": s.agentLog.push({ agent: "demo", line: `Fixture (auto-approved, not part of the story): ${d.what}` }); break;
    case "guard": s.guards[d.id] = d.state === "running" ? { ...s.guards[d.id], running: true } : d; break;
    case "guard.summary": s.guardSummary = d; break;
    case "shoes.agreed": s.shoes.agreed = d; break;
    case "shoes.products": s.shoes.products = d.items; break;
    case "shoes.purchase": s.shoes.purchase = d; if (!d.transactionId || d.status !== "fulfilment_pending") s.shoes.order = null; break;
    case "shoes.checkout": s.shoes.checkout = d; break;
    case "shoes.order": s.shoes.order = d; break;
    case "shoes.note": s.shoes.notes = [d.text, ...s.shoes.notes].slice(0, 4); break;
    case "error": s.errors.unshift(d); s.errors.length = Math.min(s.errors.length, 3); break;
    case "recorded": s.recorded = d; break;
  }
}

// ------------------------------------------------------------------ helpers

function major(atomic, currency) {
  const dp = DECIMALS[currency] ?? 2;
  const v = Number(atomic) / 10 ** dp;
  return v.toLocaleString("en-US", { minimumFractionDigits: Math.min(dp, 2), maximumFractionDigits: dp });
}
const money = (atomic, currency) => (atomic === undefined || atomic === null ? "" : `${major(atomic, currency)} ${currency}`);
const label = (id) => s.components[id]?.label ?? id;
const role = (id) => s.components[id]?.role ?? (String(id).endsWith("-api") ? "api" : "assistant");
const day = (iso) => new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
const shortId = (v, n = 12) => (v && v.length > n + 1 ? v.slice(0, n) + "…" : v ?? "");
const note = (n) => { const i = n.indexOf("  "); return i > 0 ? `<span class="hk">${esc(n.slice(0, i))}</span> ${esc(n.slice(i + 2))}` : esc(n); };
const reasonClass = (r) => (r.startsWith("✗") ? "bad" : r.startsWith("✓") || r.startsWith("+") ? "ok" : "");
const canAct = () => ui.authorized && !s.busy;

function meter(label, used, limit, sub) {
  const pct = limit > 0 ? Math.min(100, (used / limit) * 100) : 0;
  return `<div class="mandate">
    <div class="row-between small"><span class="fa-text">${esc(label)}</span><span class="mono">${esc(sub.value)}</span></div>
    <div role="meter" aria-label="${esc(label)} used" aria-valuemin="0" aria-valuemax="${limit}" aria-valuenow="${used}" aria-valuetext="${esc(sub.value)}" class="meter"><div style="width:${pct.toFixed(1)}%"></div></div>
    ${sub.line ? `<div class="small fa-sub">${esc(sub.line)}</div>` : ""}
  </div>`;
}

function budgetMeter(b, title = "Spending mandate") {
  if (!b) return "";
  if (b.status !== 200) return `<p class="bad small">Gateway: ${esc(b.code ?? b.status)} ${esc(b.reason ?? "")}</p>`;
  const used = Number(b.committed) / 10 ** (DECIMALS[b.currency] ?? 2), limit = Number(b.limit) / 10 ** (DECIMALS[b.currency] ?? 2);
  const schemes = b.schemes.length === 1 ? `${b.schemes[0]} only` : b.schemes.join(", ");
  return meter(title, used, limit, {
    value: `${major(b.committed, b.currency)} / ${major(b.limit, b.currency)} ${b.currency}`,
    line: `${b.sellers} seller${b.sellers === 1 ? "" : "s"} · ${schemes} · until ${day(b.validUntil)} · settled ${money(b.settled, b.currency)}`,
  });
}

// ------------------------------------------------------------------ render

let queued = false;
const render = () => { if (!queued) { queued = true; requestAnimationFrame(() => { queued = false; draw(); }); } };

function draw() {
  document.body.classList.toggle("business", ui.view === "business");
  document.body.classList.toggle("research", ui.view !== "business");
  document.body.classList.toggle("replay", s.mode === "replay");
  for (const r of document.querySelectorAll('input[name="view"]')) r.checked = r.value === ui.view;
  if (ui.viewDrawn !== ui.view) { ui.viewDrawn = ui.view; $("doc-details").open = ui.view !== "business"; }
  drawHeader();
  drawTabs();
  drawSteps(); drawChat(); drawQuestion(); drawConfirmed(); drawOffers(); drawResult(); drawWire(); drawPod(); drawOutcomes();
  drawShoes(); drawGuards(); drawPhone();
}

function drawHeader() {
  const m = $("mode");
  m.textContent = s.mode === "replay" ? `REPLAY · ${s.replay?.name ?? ""}` : "LIVE";
  m.className = `mode-badge ${s.mode}`;
  $("sub-text").textContent = s.mode === "replay"
    ? `Replay of a live session recorded ${s.replay?.recordedAt?.slice(0, 10) ?? ""} · the calls shown were real when recorded; payments are simulated`
    : "Live demo · everything on screen is a real HTTP call; payments are simulated";
  const next = s.steps.findIndex((_, i) => !["done", "skipped"].includes(s.stepState[i]));
  $("btn-next").textContent = next < 0 && s.steps.length ? "Done" : `Next step${next >= 0 ? ` (${next + 1}/${s.steps.length})` : ""}`;
  for (const id of ["btn-next", "btn-autoplay"]) $(id).disabled = !canAct() || (next < 0 && s.steps.length > 0);
  $("btn-reset").disabled = !ui.authorized;   // also while busy: it refuses a pending approval first
  $("auto-approve").checked = s.approvals.auto;
  $("auto-approve").disabled = !ui.authorized || s.mode === "replay";
  $("locked").hidden = ui.authorized;
  $("locked").textContent = ui.tokenStale
    ? "Controls are locked: the demo server restarted with a different session token. Open the new dashboard URL printed in the terminal. You can still watch."
    : "Controls are locked: open the dashboard URL printed in the terminal (it carries the session token). You can still watch.";
  $("status").textContent = s.busy ? `Running: ${s.busy}` : s.recorded ? `Saved ${s.recorded.path.split("/").slice(-2).join("/")} (${s.recorded.events} events)` : "Ready";
  if (document.activeElement !== $("request") && !$("request").value) $("request").placeholder = s.request || $("request").placeholder;
  $("request").disabled = next !== 0;
  patch($("alerts"), s.errors.map((e, i) => `<div class="alert"><b>${esc(e.action)} failed:</b> ${esc(e.message)} <button type="button" class="btn small" data-k="dismiss-${i}" data-dismiss="${i}">Dismiss</button></div>`).join(""));
}

function drawTabs() {
  for (const b of document.querySelectorAll("[data-tab]")) b.setAttribute("aria-current", b.dataset.tab === ui.tab ? "page" : "false");
  // Business view leads with outcomes and the Break-it panel, so it also sits under the weather screen.
  $("tab-weather").hidden = ui.tab !== "weather";
  $("tab-shoes").hidden = ui.tab !== "shoes";
  $("tab-breakit").hidden = !(ui.tab === "breakit" || (ui.tab === "weather" && ui.view === "business"));
  for (const el of document.querySelectorAll(".weather-only")) el.hidden = ui.tab !== "weather";
}

function drawSteps() {
  patch($("steps"), s.steps.map((name, i) => {
    const st = s.stepState[i] ?? "todo";
    return `<li class="step ${st}"${st === "active" ? ' aria-current="step"' : ""}><b>${i + 1}</b> ${esc(name)}<span class="sr-only"> (${st})</span></li>`;
  }).join(""));
}

function drawChat() {
  patch($("chat"), s.chat.weather.map((c) => `<p class="bubble ${c.role}"><span class="sr-only">${c.role === "user" ? "You" : "Assistant"}: </span>${esc(c.text)}</p>`).join("") || '<p class="muted">Press "Next step" to send the request.</p>');
  patch($("agent-log"), s.agentLog.map((l) => `<li><span class="mono small">[${esc(l.agent)}]</span> ${esc(l.line)}</li>`).join(""));
}

function drawQuestion() {
  const q = s.question;
  if (!q) return patch($("question"), "");
  const open = q.answered === undefined;
  patch($("question"), `<div role="radiogroup" aria-label="Meaning of ${esc(q.term)}" class="chips">${q.options.map((o, i) => {
    const on = (open ? s.choice : q.answered) === i;
    return `<button type="button" role="radio" aria-checked="${on}" class="chip${on ? " on" : ""}" data-k="choice-${i}" data-choice="${i}"${open && canAct() ? "" : " disabled"}>${esc(o)}</button>`;
  }).join("")}</div>`);
}

function drawConfirmed() {
  const items = s.confirmed.weather;
  patch($("confirmed"), items.length ? `<div class="approved"><div class="eyebrow">APPROVED ON THE DEVICE</div>${items.map((it) =>
    `<div class="row-between small"><span${it.kind === "mandate" ? ' class="fa-text"' : ""}>${esc(it.label)}</span><span class="${it.approved ? "ok" : "bad"}">${it.approved ? "signed" : "rejected"}</span></div>`).join("")}</div>` : "");
}

function offerFacts(o) {
  const p = o.properties ?? {};
  const facts = [];
  if (p.observationMaxAgeMinutes !== undefined) facts.push(`age ≤ ${p.observationMaxAgeMinutes} min`);
  if (p.includesHourlyForecast !== undefined) facts.push(p.includesHourlyForecast === "true" ? "hourly forecast" : "no hourly forecast");
  facts.push(o.approved ? "approved seller" : "not an approved seller");
  return facts.join(" · ");
}

function drawOffers() {
  if (!s.offers) return;
  patch($("offers"), s.offers.map((o) => {
    const why = o.reasons.find((r) => r.startsWith("✗"));
    return `<article class="offer${o.chosen ? " chosen" : ""}">
      <div class="row-between"><b>${esc(o.sellerName)}</b><span class="${o.chosen ? "ok" : o.acceptable ? "" : "bad"}">${o.chosen ? "chosen" : o.acceptable ? "acceptable" : "rejected"}</span></div>
      <div class="mono">${o.price ? esc(money(o.price, o.currency)) : "no payable price"}</div>
      <div class="small">${esc(offerFacts(o))}</div>
      ${why ? `<div class="small bad business-only">${esc(why.slice(2))}</div>` : ""}
      <ul class="reasons research-only">${o.reasons.map((r) => `<li class="${reasonClass(r)}">${esc(r)}</li>`).join("")}</ul>
      <div class="small muted research-only">offer v${o.version} · score ${o.score}</div>
    </article>`;
  }).join(""));
}

function drawResult() {
  const p = s.purchase, d = s.delivery;
  $("result-card").hidden = !p;
  if (!p) return;
  const ok = p.status === "completed";
  const c = d?.content;
  const age = c && d.receipt ? Math.round((Date.parse(d.receipt.deliveredAt) - Date.parse(c.observedAt)) / 60000) : undefined;
  patch($("result"), `<p class="result-line"><span class="badge ${ok ? "ok-bg" : "bad-bg"}">${esc(p.status)}</span> ${p.display ? `<b class="mono">${esc(p.display)}</b> to ${esc(p.seller)} via ${esc(p.scheme)}` : esc(`${p.code ?? ""} ${p.reason ?? ""}`)}</p>
    ${p.notes?.length ? `<ul class="small">${p.notes.map((n) => `<li>${esc(n)}</li>`).join("")}</ul>` : ""}
    <p class="small muted research-only mono">transaction ${esc(shortId(p.transactionId, 20))}${p.offerVersion ? ` · offer v${p.offerVersion}` : ""}</p>
    ${d ? `<div class="delivery-box">
      ${c ? `<p><b>${esc(c.location)}</b> · ${esc(c.temperatureC)} °C · ${esc(c.conditions)}${age !== undefined ? ` · observed ${age} min before delivery` : ""}</p>` : ""}
      <ul class="checks">${d.checks.map((x) => `<li class="${reasonClass(x)}">${esc(x)}</li>`).join("")}</ul>
      ${d.receipt ? `<p class="small mono research-only">receipt ${esc(shortId(d.receipt.id, 18))} · ${esc(d.receipt.amount)} · seller key ${esc(d.receipt.keyId)}</p>` : ""}
    </div>` : ""}`);
}

const PAY_PATH = /^\/(reports|authorize|pay|verify|settle|transactions|payment_intents|invoices|checkout_sessions|agentic_commerce|orders)/;
function wireVisible(w) {
  const f = ui.wireFilter ?? (ui.view === "business" ? "pay" : "all");
  if (f === "pod") return true;
  if (w.pod) return false;
  if (f === "all") return true;
  return w.status === 402 || w.status === 0 || PAY_PATH.test(w.path) || w.to.endsWith("-api");
}

function drawWire() {
  $("wire-filter").value = ui.wireFilter ?? (ui.view === "business" ? "pay" : "all");
  const used = s.purchase?.scheme;
  patch($("schemes"), ["x402", "l402", "card-psp"].map((x) => `<span class="pill${used === x ? " on" : ""}">${x === "l402" ? "L402" : x === "card-psp" ? "card" : x}</span>`).join(""));
  const list = $("wire");
  const atBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 40;
  const rows = s.wire.filter(wireVisible).slice(-160);
  // Business view: payment headers, verdict codes and the budget, not every detail.
  const notesFor = (w) => (ui.view === "business" ? [...w.request, ...w.response].filter((n) => /  |^[A-Z_]{6,}|^budget available|^settle|^receipt/.test(n)).slice(0, 3) : [...w.request, ...w.response]);
  patch(list, rows.map((w) => {
    const cls = w.status === 402 ? "s402" : w.status >= 200 && w.status < 300 ? "s2xx" : "s4xx";
    const notes = notesFor(w);
    return `<li class="wire-row">
      <span class="who"><span class="r-${role(w.from)}">${esc(label(w.from))}</span> <span aria-hidden="true">→</span><span class="sr-only">to</span> <span class="r-${role(w.to)}">${esc(label(w.to))}</span></span>
      <span class="what"><span class="mono">${esc(w.method)} ${esc(w.path)}</span> <b class="status ${cls}">${w.status || "no response"}${w.status === 402 ? " Payment Required" : ""}</b> <span class="ms">${w.ms} ms</span>
      ${notes.length ? `<ul class="wire-notes">${notes.map((n) => `<li>${note(n)}</li>`).join("")}</ul>` : ""}</span>
    </li>`;
  }).join("") || '<li class="muted-dark">HTTP exchanges appear here as the assistant works.</li>');
  if (atBottom) list.scrollTop = list.scrollHeight;
}

function drawPod() {
  const pod = s.pod;
  $("pod-host").textContent = pod ? new URL(pod.root).pathname : "";
  const keys = Object.keys(s.budgets);
  patch($("budgets"), (s.budgets.weather ? budgetMeter(s.budgets.weather) : '<p class="muted small">No spending mandate yet: approve one at step 3.</p>') +
    keys.filter((k) => k !== "weather").map((k) => budgetMeter(s.budgets[k], s.budgets[k].label)).join(""));
  if (pod) {
    const base = new Map((s.podBase?.containers ?? []).map((c) => [c.path, c.docs.length]));
    patch($("pod-tree"), `<li class="muted">commerce/</li>${pod.containers.map((c) => {
      const name = c.path.replace(/^commerce\//, "");
      const added = c.docs.length - (base.get(c.path) ?? 0);
      return `<li class="${added > 0 ? "new" : ""}"><details><summary>${esc(name)} <span class="ok">${c.docs.length}</span>${added > 0 ? ` <span class="blue">+${added} new</span>` : ""}</summary>
        <ul>${c.docs.map((d) => `<li>${esc(d)}</li>`).join("")}</ul></details></li>`;
    }).join("")}${pod.files.map((f) => `<li class="muted">${esc(f.replace(/^commerce\//, ""))} (no secrets)</li>`).join("")}`);
  }
  patch($("evidence"), s.evidence ? `<div class="eyebrow">EVIDENCE</div><ul class="links">${s.evidence.map((l) => `<li><button type="button" class="linkish" data-k="ev-${esc(l.path)}" data-doc="${esc(l.path)}">${esc(l.label)}</button> <span class="mono small muted">${esc(shortId(l.path.split("/").pop(), 26))}</span></li>`).join("")}</ul>` : "");
  const doc = s.docs.find((d) => d.path === ui.docSel) ?? s.docs[0];
  $("doc-caption").textContent = doc ? `${doc.path.toUpperCase()} · ${doc.why}` : "Most recent record";
  patch($("doc-picker"), s.docs.length > 1 ? `<div class="chips small-chips" role="group" aria-label="Recent documents">${s.docs.slice(0, 6).map((d) => `<button type="button" class="chip${d === doc ? " on" : ""}" aria-pressed="${d === doc}" data-k="doc-${esc(d.path)}" data-doc="${esc(d.path)}">${esc(docName(d.path))}</button>`).join("")}</div>` : "");
  patch($("doc"), doc ? turtleBody(doc.turtle) : "Records written to the Pod appear here as Turtle.");
}

/** "tx-44b421ba-...-7bd2cfc7a1dd-ledger.ttl" -> "tx-44b4…a1dd-ledger.ttl": the distinguishing ends of a document name. */
function docName(path) {
  const n = path.split("/").pop();
  const m = n.match(/^(tx-[0-9a-f]{4})[0-9a-f-]+([0-9a-f]{4}(?:-[a-z]+)?\.ttl)$/);
  return m ? `${m[1]}…${m[2]}` : shortId(n, 24);
}

/** Turtle with the @prefix block folded away (it is the same in every document); the rest verbatim. */
function turtleBody(ttl) {
  const lines = ttl.split("\n");
  const prefixes = lines.filter((l) => l.startsWith("@prefix")).length;
  const body = lines.filter((l) => !l.startsWith("@prefix")).join("\n").trim();
  return `${prefixes ? `<span class="muted"># ${prefixes} @prefix lines folded</span>\n` : ""}${esc(body)}`;
}

function drawOutcomes() {
  const p = s.purchase, b = s.budgets.weather;
  const guards = Object.values(s.guards).filter((g) => g.tone);
  const held = guards.filter((g) => g.tone !== "fail").length;
  const tx = s.pod?.containers.find((c) => c.path.endsWith("transactions/"))?.docs.length ?? 0;
  const card = (k, v, sub, cls = "") => `<div class="outcome ${cls}"><div class="eyebrow">${esc(k)}</div><div class="big-num">${esc(v)}</div><div class="small">${esc(sub)}</div></div>`;
  patch($("outcomes"), [
    card("Purchase", p ? (p.status === "completed" ? "Delivered" : p.status) : "Not yet", p ? `${p.seller ?? ""} · checked against your meaning of "current"` : "the assistant has not bought anything", p?.status === "completed" ? "good" : ""),
    card("Paid", p?.display ?? "0", p ? `via ${p.scheme}, authorized by the gateway` : "nothing can be paid without a signed mandate"),
    card("Budget left", b ? money(b.available, b.currency) : "no mandate", b ? `of ${money(b.limit, b.currency)} the user signed` : "approve one on the phone"),
    card("Evidence in the Pod", String(tx), "transaction documents the user controls"),
    card("Guardrails held", guards.length ? `${held} of ${guards.length}` : "not run",
      s.mode === "replay" ? `attacks and failures below, replayed from recording ${s.replay?.name ?? ""}${s.replay?.recordedAt ? ` (${s.replay.recordedAt.slice(0, 10)})` : ""}` : "attacks and failures below, run live",
      guards.length && held === guards.length ? "good" : ""),
  ].join(""));
}

function drawShoes() {
  const sh = s.shoes;
  patch($("shoes-ask"), `<p class="quote">"Buy repairable shoes. You may spend up to <b>120 EUR including delivery</b>."${sh.agreed ? ` → <b>${esc(sh.agreed.term)}</b> agreed as <b>${esc(sh.agreed.label)}</b>` : ""}</p>`);
  $("btn-buy").disabled = !canAct();
  const notes = [...sh.notes, ...(sh.purchase?.notes ?? []), ...(sh.purchase && !sh.purchase.transactionId ? [] : sh.purchase?.code ? [`${sh.purchase.code}: ${sh.purchase.reason ?? ""}`] : [])];
  patch($("shoes-status"), notes.map((n) => `<p>${esc(n)}</p>`).join(""));
  if (sh.products) patch($("products"), sh.products.map((p) => {
    const why = p.reasons.find((r) => r.startsWith("✗"));
    return `<article class="product${p.chosen ? " chosen" : ""}">
      <div class="photo">${ICONS.shoe}</div>
      <b>${esc(p.title)}</b>
      <div class="small">${esc(p.merchant)} · ${esc(p.price)}${p.delivery ? ` + ${esc(p.delivery)} delivery` : " · no delivery to DE"}</div>
      <div class="small strong ${p.chosen ? "ok" : p.acceptable ? "" : "bad"}">${p.chosen ? `Chosen: ${esc((p.reasons.find((r) => r.startsWith("✓")) ?? "✓ acceptable").slice(2))}` : why ? `Rejected: ${esc(why.slice(2))}` : p.acceptable ? "Acceptable" : "Rejected"}</div>
      <ul class="reasons research-only">${p.reasons.map((r) => `<li class="${reasonClass(r)}">${esc(r)}</li>`).join("")}</ul>
    </article>`;
  }).join(""));
  const co = sh.checkout;
  if (co) patch($("checkout"), `<p class="small muted">${esc(co.merchant)} · <span class="mono">${esc(co.sessionId)}</span></p>
    <dl class="bill">${co.lines.map((l) => `<dt${l.muted ? ' class="muted"' : ""}>${esc(l.label)}</dt><dd class="mono${l.muted ? " muted" : ""}">${esc(l.amount)}</dd>`).join("")}
      <dt class="total">Total</dt><dd class="mono total">${esc(co.total)}</dd></dl>
    ${meter("Total against the per-purchase limit", co.totalMajor, co.limit, { value: `${co.total} / ${co.limitDisplay}`, line: `${Math.round((co.totalMajor / co.limit) * 100)}% of the ${co.limitDisplay} the user signed` })}
    <ul class="facts">${co.facts.map((f) => `<li>${esc(f)}</li>`).join("")}</ul>`);
  const o = sh.order;
  const stages = !o ? [] : o.orderStatus === "canceled" || o.orderStatus === "refunded"
    ? [["Paid", "done"], ["Canceled", "done"], [`Refund ${o.paymentStatus === "refunded" ? "confirmed by the PSP" : "pending"}`, o.paymentStatus === "refunded" ? "done" : "current"]]
    : [[`Paid · ${o.paymentStatus}`, "done"], ["Shipped", ["shipped", "delivered"].includes(o.orderStatus) ? "done" : "todo"], ["Delivered", o.orderStatus === "delivered" ? (o.acceptance ? "done" : "current") : "todo"],
      [o.acceptance ? (o.acceptance.verdict === "Delivered" ? "Accepted by you" : "Not as agreed (you)") : "Accepted by you", o.acceptance ? (o.acceptance.verdict === "Delivered" ? "done" : "bad") : "todo"]];
  patch($("tracking"), stages.map(([t, st]) => `<li class="stage ${st}">${esc(t)}<span class="sr-only"> (${st})</span></li>`).join("") || '<li class="stage todo">No order yet</li>');
  $("btn-advance").disabled = !canAct() || !o || !["created", "shipped"].includes(o.orderStatus);
  $("btn-cancel").disabled = !canAct() || !o || !["created", "shipped"].includes(o.orderStatus);
  const waiting = o && o.orderStatus === "delivered" && !o.acceptance;
  patch($("inspect"), o?.acceptance
    ? `<div class="strong">${o.acceptance.verdict === "Delivered" ? "You accepted the delivery as agreed." : "You reported the goods are not as agreed."}</div><ul class="checks">${o.acceptance.checks.map((c) => `<li class="${reasonClass(c)}">${esc(c)}</li>`).join("")}</ul><div class="small fa-sub">Signed on the device (${esc(o.acceptance.keyId)}) and recorded in the Pod as the delivery outcome.</div>`
    : `<div class="strong">${waiting ? "Your shoes arrived." : "When the shoes arrive:"} Is this true: ${esc(o?.inspect?.join("; ") ?? "soles replaceable")}?</div>
      <div class="btn-row"><button type="button" class="btn dark grow" data-k="accept-yes" data-act="shoes.accept" data-ok="true"${waiting && canAct() ? "" : " disabled"}>Yes, as agreed</button>
      <button type="button" class="btn grow" data-k="accept-no" data-act="shoes.accept" data-ok="false"${waiting && canAct() ? "" : " disabled"}>No, not compliant</button></div>
      <div class="small fa-sub">Your answer is signed on the device and recorded in the Pod as the delivery outcome.</div>`);
  patch($("shoes-budget"), s.budgets.shoes ? budgetMeter(s.budgets.shoes, "Shoes mandate") : '<p class="muted small">No shoes mandate yet.</p>');
  patch($("shoes-doc"), esc(s.docs.find((d) => d.path.includes("-fulfilment"))?.turtle ?? "The fulfilment document appears after the order."));
}

function drawGuards() {
  const g = s.guardSummary;
  patch($("guard-summary"), g ? `budget ${esc(g.committed)} / ${esc(g.limit)} · Spree received ${esc(g.sellerReceived)}` : "budget appears after the first scenario");
  patch($("guards"), GUARDS.map((d) => {
    const r = s.guards[d.id];
    const btn = (act, text, cls = "outline") => `<button type="button" class="btn ${cls}" data-k="g-${act}" data-act="guard.${act}"${canAct() ? "" : " disabled"}>${text}</button>`;
    const buttons = d.id === "crash" ? `<div class="btn-row">${btn("crash", d.button)}${r?.recoverable ? btn("recover", "Recover", "primary") : `<button type="button" class="btn primary" disabled>Recover</button>`}</div>` : btn(d.id, d.button);
    const tiles = r?.tiles ? `<div class="tiles" role="img" aria-label="${esc(r.lines[0])}">${r.tiles.map((t) => `<span class="tile ${t.status === "completed" ? "on" : ""}" title="${esc(`${t.agent}: ${t.code ?? t.status}`)}"></span>`).join("")}</div>` : "";
    const verdict = r?.running ? '<div class="verdict running">Running against the live services…</div>'
      : r?.tone ? `${tiles}<div class="verdict ${r.tone}"><span class="sr-only">${esc(TONE_LABEL[r.tone])}: </span>${r.tone === "fail" ? "<b>Guardrail did not hold</b><br>" : ""}${r.lines.map(esc).join("<br>")}</div>` : "";
    return `<article class="card guard"><h2>${esc(d.title)}</h2><p class="small">${esc(d.text)}</p>${buttons}${verdict}</article>`;
  }).join(""));
}

function drawPhone() {
  const p = s.approvals.pending;
  for (const it of p) if (!ui.seenPending.has(it.id)) { ui.seenPending.add(it.id); ui.phoneOpen = true; }
  $("phone-panel").hidden = !ui.phoneOpen;
  $("btn-phone").setAttribute("aria-expanded", String(ui.phoneOpen));
  const head = p.length ? `<div class="ph-count small">${p[0].position ? `${p[0].position.index} of ${p[0].position.total} to review` : `${p.length} to review`}${s.approvals.auto ? " · auto-approving" : ""}</div>` : '<p class="muted small">Nothing to review.</p>';
  patch($("pp-body"), head + (p[0] ? approvalCard(p[0], { buttons: s.mode === "live" && ui.authorized }) : "") + resolvedList(s.approvals.resolved.slice(0, 4)));
}

// ------------------------------------------------------------------ input

async function act(name, args = {}) {
  try { await api(`/api/action/${name}`, args); }
  catch (e) { s.errors.unshift({ action: name, message: e.message }); render(); }
}

document.addEventListener("click", (ev) => {
  const t = ev.target.closest("button");
  if (!t) return;
  if (t.dataset.tab) { ui.tab = t.dataset.tab; store.set("demo.tab", ui.tab); return render(); }
  if (t.dataset.decide) return void api(`/api/approvals/${encodeURIComponent(t.dataset.decide)}`, { approve: t.dataset.approve === "true", via: "screen" }).catch((e) => { s.errors.unshift({ action: "approval", message: e.message }); render(); });
  if (t.dataset.choice) return void act("weather.answer", { choice: Number(t.dataset.choice) });
  if (t.dataset.doc) { ui.docSel = t.dataset.doc; return render(); }
  if (t.dataset.dismiss) { s.errors.splice(Number(t.dataset.dismiss), 1); return render(); }
  if (t.dataset.act) return void act(t.dataset.act, t.dataset.ok ? { ok: t.dataset.ok === "true" } : {});
  switch (t.id) {
    case "btn-next": return void act("weather.next", { text: $("request").value });
    case "btn-autoplay": return void act("weather.autoplay");
    case "btn-reset": return void act("reset");
    case "btn-buy": return void act("shoes.buy");
    case "btn-advance": return void act("shoes.advance");
    case "btn-cancel": return void act("shoes.cancel");
    case "btn-phone": ui.phoneOpen = !ui.phoneOpen; return render();
    case "pp-close": ui.phoneOpen = false; return render();
  }
});

for (const r of document.querySelectorAll('input[name="view"]')) r.addEventListener("change", () => { ui.view = r.value; ui.wireFilter = null; store.set("demo.view", ui.view); render(); });
$("wire-filter").addEventListener("change", (e) => { ui.wireFilter = e.target.value; render(); });
$("auto-approve").addEventListener("change", (e) => void api("/api/auto-approve", { on: e.target.checked }).catch((err) => { s.errors.unshift({ action: "auto-approve", message: err.message }); render(); }));
// A fresh name per session, so Record never lands on the shipped recordings/talk.json by default.
const hhmm = new Date().toTimeString().slice(0, 5).replace(":", "");
$("record-name").value = `session-${hhmm}`;
$("record-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const name = $("record-name").value;
  const fail = (err) => { s.errors.unshift({ action: "record", message: err.message }); render(); };
  try { await api("/api/record", { name }); }
  catch (err) {
    // The server never replaces a recording unless asked to.
    if (err.status !== 409 || !err.body?.exists) return fail(err);
    if (!confirm(`recordings/${name}.json already exists. Replace it?`)) return;
    await api("/api/record", { name, overwrite: true }).catch(fail);
  }
});

$("logo").innerHTML = ICONS.bag;
$("phone-icon").innerHTML = ICONS.phone;

/** What this page's token allows, the QR code and the phone link. Re-read after every reconnect: the server may have restarted. */
let infoSeq = 0;
async function loadInfo() {
  const n = ++infoSeq;
  let i;
  try { i = await info(); } catch { return; }   // the stream's next reconnect tries again
  if (n !== infoSeq) return;
  ui.tokenStale = !i.authorized && (ui.authorized || ui.tokenStale);
  ui.authorized = i.authorized;
  ui.phoneUrl = i.phoneUrl ?? "";
  $("qr").hidden = !i.authorized;
  if (i.authorized) {
    $("qr").src = `/api/qr.svg?t=${encodeURIComponent(token)}&v=${n}`;   // a new image, not a cached one
    $("phone-link").href = ui.phoneUrl;
  } else $("qr").removeAttribute("src");
  render();
}
// onopen fires on the first connection and on every reconnect.
connect((e) => { reduce(e); render(); }, (up) => { if (up) void loadInfo(); else $("status").textContent = "Reconnecting to the demo server"; });
