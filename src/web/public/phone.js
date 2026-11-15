// The approval device on a real phone: shows the first pending item and sends the decision.
import { api, approvalCard, approvalsReducer, connect, esc, info, patch, resolvedList, token } from "./shared.js";

let state = approvalsReducer(undefined, { type: "reset" });
let mode = "live";
/** False once the server no longer accepts this page's token (it restarted with another one). */
let authorized = true;
const $ = (id) => document.getElementById(id);

function render() {
  const p = state.pending;
  $("ph-title").textContent = p.length ? (p[0].position ? `${p[0].position.index} of ${p[0].position.total} to review` : `${p.length} to review`) : "Nothing to review";
  const canDecide = Boolean(token) && authorized;
  $("ph-mode").hidden = mode !== "replay" && !state.auto && canDecide;
  $("ph-mode").textContent = mode === "replay" ? "Replay of a recorded session: decisions were made when it was recorded."
    : !token ? "Open this page from the QR code: this link has no session token."
    : !authorized ? "The demo server restarted with a different session token: scan the new QR code."
    : "Auto-approve is on: items are approved by the demo after a moment.";
  patch($("ph-item"), p[0] ? approvalCard(p[0], { buttons: mode === "live" && canDecide }) : '<p class="ph-empty">When the assistant needs your consent, it appears here.</p>');
  patch($("ph-history"), resolvedList(state.resolved));
}

document.addEventListener("click", async (ev) => {
  const b = ev.target.closest("[data-decide]");
  if (!b) return;
  b.disabled = true;
  try {
    await api(`/api/approvals/${encodeURIComponent(b.dataset.decide)}`, { approve: b.dataset.approve === "true", via: "phone" });
    $("ph-error").hidden = true;
    navigator.vibrate?.(30);
  } catch (e) {
    $("ph-error").hidden = false;
    $("ph-error").innerHTML = esc(e.message);
    b.disabled = false;
  }
});

connect((e) => {
  if (e.type === "replay") mode = "replay";
  if (e.type === "session") mode = e.data.mode;
  state = approvalsReducer(state, e);
  render();
}, (up) => {
  if (!up) { $("ph-title").textContent = "Reconnecting"; return; }
  // Also on reconnect: after a restart, check that this page's token still works.
  if (token) info().then((i) => { authorized = i.authorized; render(); }).catch(() => {});
});
render();
