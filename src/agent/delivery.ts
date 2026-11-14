/** Check a delivered item against the agreed requirements and the seller's receipt. */
import type { Criterion, WeatherReport } from "../model.js";
import type { Receipt } from "../payments/types.js";
import { sha256Hex } from "../util/crypto.js";
import { compare } from "./ranking.js";

export interface DeliveryCheck { status: "Delivered" | "NonCompliant"; checks: string[]; contentDigest: string }

export function deliveredValue(report: WeatherReport, leftOperand: string, now: Date): unknown {
  switch (leftOperand) {
    case "observationAgeMinutes": return Math.round(((now.getTime() - new Date(report.observedAt).getTime()) / 60_000) * 10) / 10;
    case "coverage": return report.location;
    default: return (report as unknown as Record<string, unknown>)[leftOperand];
  }
}

export function checkDelivery(body: string, receipt: Receipt | undefined, requirements: Criterion[], subject: string | undefined, now = new Date()): DeliveryCheck {
  const checks: string[] = [];
  let ok = true;
  const contentDigest = "sha-256:" + sha256Hex(body);
  if (!receipt) { ok = false; checks.push("✗ no seller receipt"); }
  else if (receipt.contentDigest !== contentDigest) { ok = false; checks.push("✗ content does not match the receipt digest"); }
  else checks.push("✓ content matches the seller-signed receipt");
  let report: WeatherReport;
  try { report = JSON.parse(body); } catch { return { status: "NonCompliant", checks: [...checks, "✗ unparseable content"], contentDigest }; }
  if (subject && report.location.toLowerCase() !== subject.toLowerCase()) { ok = false; checks.push(`✗ report is for ${report.location}, not ${subject}`); }
  for (const c of requirements) {
    if (c.leftOperand === "observationMaxAgeMinutes" || c.leftOperand === "price") continue; // offer-only properties
    const v = deliveredValue(report, c.leftOperand, now);
    const t = compare(v, c);
    if (t === true) checks.push(`✓ ${c.leftOperand} = ${v} satisfies ${c.operator} ${c.rightOperand}`);
    else { ok = false; checks.push(`✗ ${c.leftOperand} = ${v ?? "missing"} violates ${c.operator} ${c.rightOperand}`); }
  }
  return { status: ok ? "Delivered" : "NonCompliant", checks, contentDigest };
}
