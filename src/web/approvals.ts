/**
 * The approval device's decider, moved out of the process and onto a phone.
 *
 * ApprovalDevice keeps the signing key and signs exactly as before; this only
 * replaces the yes/no question. Each item is published to the event log (the
 * phone page and the dashboard's on-screen phone both render it) and the
 * device waits until someone holding the session token answers, or the
 * "auto-approve" switch answers for them.
 */
import type { Decider, DeliveryAttestation } from "../grounding/approval.js";
import { confirmableTerms, type GroundRecord } from "../model.js";
import { digestOf, newId } from "../util/crypto.js";
import type { EventLog } from "./events.js";

export interface ApprovalItem {
  id: string;
  kind: GroundRecord["kind"] | "deliveryAcceptance";
  /** Spending mandates are shown apart from everything else, as financial authority. */
  financial: boolean;
  heading: string;
  title: string;
  details: Array<[string, string]>;
  summary: string;
  keyId: string;
  termsDigest: string;
  position?: { index: number; total: number };
}

export type Via = "phone" | "screen" | "auto";

export class ApprovalBroker {
  private pending = new Map<string, { item: ApprovalItem; resolve: (ok: boolean) => void }>();
  private batch?: { index: number; total: number };
  /** Recently decided ids, so a late second answer (phone vs screen vs auto) can be told apart from a bogus id. */
  private decided = new Set<string>();
  /** Set while the session is being reset: anything asked meanwhile is refused at once. */
  private closed = false;
  auto = false;

  constructor(
    private readonly log: EventLog,
    private readonly device: () => { keyId: string },
    private readonly nameOf: (webId: string) => string,
    private readonly autoDelayMs = 600,
  ) {}

  /** Number the next `total` items "1 of N" ... on the phone. */
  expect(total: number) { this.batch = { index: 0, total }; }

  readonly decider: Decider = (summary, record) => {
    if (this.closed) return Promise.resolve(false);
    const position = this.batch && this.batch.index < this.batch.total ? { index: ++this.batch.index, total: this.batch.total } : undefined;
    const item = describe(record, summary, this.device().keyId, this.nameOf, position);
    return new Promise<boolean>((resolve) => {
      this.pending.set(item.id, { item, resolve });
      this.log.emit("approval.pending", item);
      // Even when automatic, leave the item on screen long enough for the audience to read it.
      if (this.auto) setTimeout(() => this.decide(item.id, true, "auto"), this.autoDelayMs);
    });
  };

  decide(id: string, approved: boolean, via: Via): boolean {
    const p = this.pending.get(id);
    if (!p) return false;
    this.pending.delete(id);
    this.decided.add(id);
    if (this.decided.size > 200) this.decided.delete(this.decided.values().next().value!);
    this.log.emit("approval.resolved", { id, approved, via, kind: p.item.kind, title: p.item.title, financial: p.item.financial });
    p.resolve(approved);
    return true;
  }

  /** True when `id` was pending and has been answered already (by another device, auto-approve or a reset). */
  wasDecided(id: string): boolean { return this.decided.has(id); }

  setAuto(on: boolean) {
    this.auto = on;
    this.log.emit("approval.auto", { on });
    if (on) for (const id of [...this.pending.keys()]) this.decide(id, true, "auto");
  }

  /** Reject everything open, and anything asked until reopen() (the session is being reset). */
  cancelAll() {
    this.closed = true;
    for (const id of [...this.pending.keys()]) this.decide(id, false, "screen");
  }

  reopen() { this.closed = false; this.batch = undefined; }
}

const HEADINGS: Record<ApprovalItem["kind"], string> = { meaning: "Agreed meaning", requirement: "Requirement", preference: "Preference", mandate: "Financial authority", deliveryAcceptance: "Delivery verdict" };

function describe(r: GroundRecord | DeliveryAttestation, summary: string, keyId: string, nameOf: (w: string) => string, position?: ApprovalItem["position"]): ApprovalItem {
  const terms = r.kind === "deliveryAcceptance" ? r : confirmableTerms(r);
  const base = { id: newId("ap-"), kind: r.kind, financial: r.kind === "mandate", heading: HEADINGS[r.kind], summary, keyId, termsDigest: digestOf(terms), position };
  switch (r.kind) {
    case "meaning":
      return { ...base, title: r.definition, details: [["Term", `"${r.term}"`], ["Scope", r.scope], ["Criterion", criterion(r.criterion)]] };
    case "preference":
    case "requirement":
      return {
        ...base, title: r.derivedFrom ?? `${r.kind} for ${r.appliesTo}`,
        details: [["Applies to", r.appliesTo], ["Criterion", criterion(r.criterion)], ["Effect", r.kind === "preference" ? `ranking only (weight ${r.weight ?? 0.5}); grants no spending` : "offers failing this are rejected"]],
      };
    case "mandate":
      return {
        ...base, title: `Up to ${r.totalLimit} ${r.currency} for ${r.targets.map(category).join(", ")}`,
        details: [
          ["Per purchase", `≤ ${r.maxPerTransaction} ${r.currency}`],
          ["In total", `≤ ${r.totalLimit} ${r.currency}`],
          ["Sellers", r.allowedSellers.map(nameOf).join(", ")],
          ["Pay with", r.allowedSchemes.join(", ")],
          ["Agents", r.assignees.map((a) => a.split(":").pop()!).join(", ")],
          ["Valid until", r.validUntil.slice(0, 10)],
        ],
      };
    case "deliveryAcceptance":
      return { ...base, title: r.verdict === "Delivered" ? `Accept order ${r.orderId}: as agreed` : `Order ${r.orderId} is not as agreed`, details: r.checks.map((c, i): [string, string] => [i === 0 ? "Checks" : "", c]) };
  }
}

const criterion = (c: { leftOperand: string; operator: string; rightOperand: unknown; unit?: string }) =>
  `${c.leftOperand} ${c.operator} ${Array.isArray(c.rightOperand) ? c.rightOperand.join(", ") : c.rightOperand}${c.unit ? " " + c.unit : ""}`;
const category = (c: string) => c.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase() + (c.endsWith("s") ? "" : "s");
