import type { GroundRecord } from "../../model.js";

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const OP: Record<string, string> = { lteq: "≤", lt: "<", gteq: "≥", gt: ">", eq: "=", isAnyOf: "∈" };

/** One line per record, as the conversation panel lists what was approved. */
export function recordLabel(r: GroundRecord): string {
  const c = r.kind === "mandate" ? undefined : r.criterion;
  const crit = c ? `${c.leftOperand} ${OP[c.operator] ?? c.operator} ${Array.isArray(c.rightOperand) ? c.rightOperand.join(", ") : c.rightOperand}${c.unit ? " " + c.unit : ""}` : "";
  switch (r.kind) {
    case "meaning": return `Meaning: "${r.term}" = ${crit}`;
    case "requirement": return `Requirement: ${crit}`;
    case "preference": return `Preference: ${crit}`;
    case "mandate": return `Mandate: ≤ ${r.totalLimit} ${r.currency}, ${r.allowedSellers.length} seller${r.allowedSellers.length === 1 ? "" : "s"}`;
  }
}

/**
 * A Break-it card that cannot run in this session (for example because the
 * user rejected the mandate it needs). Shown as "not run", never as a
 * guardrail that did not hold, and never worked around with a fixture.
 */
export class Unavailable extends Error {}
