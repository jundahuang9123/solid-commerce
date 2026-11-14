// Shared by the dashboard (app.js) and the phone page (phone.js). No build step, no dependencies.

/** The session token from the page URL; required for every POST (see src/web/server.ts). */
export const token = new URLSearchParams(location.search).get("t") ?? "";

export const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

export async function api(path, body = {}) {
  const r = await fetch(path, { method: "POST", headers: { "content-type": "application/json", "x-demo-token": token }, body: JSON.stringify(body) });
  const out = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(out.error ?? `HTTP ${r.status}`);
  return out;
}

/** Follow the event log. EventSource reconnects by itself; the server resends the log from the last reset. */
export function connect(onEvent, onStatus) {
  const es = new EventSource("/api/events");
  es.onmessage = (m) => onEvent(JSON.parse(m.data));
  es.onopen = () => onStatus?.(true);
  es.onerror = () => onStatus?.(false);
  return es;
}

/**
 * Replace an element's content only when it changed, and keep keyboard focus
 * on the control with the same data-k after re-rendering.
 */
export function patch(el, html) {
  if (!el || el.__html === html) return;
  const key = document.activeElement?.closest?.("[data-k]")?.getAttribute("data-k");
  const inside = key && el.contains(document.activeElement);
  el.innerHTML = html;
  el.__html = html;
  if (inside) el.querySelector(`[data-k="${CSS.escape(key)}"]`)?.focus();
}

/** Pending approvals and recent decisions, folded from approval.* events. */
export function approvalsReducer(state, e) {
  if (e.type === "reset") return { pending: [], resolved: [], auto: state?.auto ?? false };
  if (e.type === "session") state.auto = Boolean(e.data.autoApprove);
  if (e.type === "approval.auto") state.auto = e.data.on;
  if (e.type === "approval.pending") state.pending.push(e.data);
  if (e.type === "approval.resolved") {
    state.pending = state.pending.filter((p) => p.id !== e.data.id);
    state.resolved.unshift(e.data);
    state.resolved.length = Math.min(state.resolved.length, 8);
  }
  return state;
}

export const ICONS = {
  card: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><rect x="3" y="6" width="18" height="13" rx="2"/><path d="M3 10h18"/></svg>',
  check: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" aria-hidden="true"><path d="M5 12l5 5L19 7"/></svg>',
  cross: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>',
  bag: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M4 7h16l-1.5 10.5a2 2 0 0 1-2 1.5h-9a2 2 0 0 1-2-1.5z"/><path d="M9 7V5a3 3 0 0 1 6 0v2"/></svg>',
  phone: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><rect x="7" y="2.5" width="10" height="19" rx="2"/><path d="M11 18.5h2"/></svg>',
  shoe: '<svg width="72" height="44" viewBox="0 0 72 44" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linejoin="round" aria-hidden="true"><path d="M6 12c0-3 2-5 5-5h9l4 8c7 1 15 4 22 8 6 3 13 4 18 5 3 1 4 3 4 6v3H6z"/><path d="M6 34h66"/><path d="M24 15l-3 6M31 17l-3 6M38 20l-3 6"/></svg>',
};

/** One approval item, as both the phone and the on-screen phone show it. */
export function approvalCard(item, { buttons = true } = {}) {
  const dl = item.details.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join("");
  const head = item.financial
    ? `<div class="fa-head">${ICONS.card}<span>FINANCIAL AUTHORITY</span></div>`
    : `<div class="ap-kind">${esc(item.heading.toUpperCase())}</div>`;
  return `<article class="ap-card${item.financial ? " financial" : ""}" aria-label="${esc(item.heading)}">
    ${head}
    <h3 class="ap-title">${esc(item.title)}</h3>
    <dl class="ap-details">${dl}</dl>
    ${item.financial ? '<p class="ap-note">Preferences never grant spending. Only this signed permission does.</p>' : ""}
    ${buttons ? `<div class="ap-buttons">
      <button type="button" class="btn ghost big" data-k="reject-${esc(item.id)}" data-decide="${esc(item.id)}" data-approve="false">Reject</button>
      <button type="button" class="btn dark big" data-k="approve-${esc(item.id)}" data-decide="${esc(item.id)}" data-approve="true">Approve and sign</button>
    </div>` : ""}
    <p class="ap-key">key ${esc(item.keyId)} · terms ${esc(item.termsDigest.slice(0, 18))}…</p>
  </article>`;
}

export function resolvedList(resolved) {
  if (!resolved.length) return "";
  return `<ul class="ap-history" aria-label="Recent decisions">${resolved.map((r) => `<li><span${r.financial ? ' class="fa-text"' : ""}>${esc(r.title)}</span><span class="${r.approved ? "ok" : "bad"}">${r.approved ? "signed" : "rejected"}${r.via === "auto" ? " (auto)" : ""}</span></li>`).join("")}</ul>`;
}
