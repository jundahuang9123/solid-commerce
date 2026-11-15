/**
 * Deterministic interpreter. It is the default, so the prototype and its tests
 * run offline and reproducibly. It covers a small lexicon. Swap in
 * ClaudeInterpreter for open-ended language; both feed the same validation,
 * clarification and confirmation pipeline.
 */
import type { CandidateMeaning, Interpretation, InterpretedStatement, Interpreter } from "./interpretation.js";
import type { Criterion } from "../model.js";

/** Terms that need an agreed meaning before use, with candidate operationalisations. */
export const AMBIGUOUS_TERMS: Record<string, Record<string, CandidateMeaning[]>> = {
  WeatherReport: {
    current: [
      { label: "observed within the last 15 minutes", definition: "For my weather reports, current means observed at most 15 minutes before delivery.", criterion: { leftOperand: "observationAgeMinutes", operator: "lteq", rightOperand: 15, unit: "minute" } },
      { label: "observed within the last 60 minutes", definition: "For my weather reports, current means observed at most 60 minutes before delivery.", criterion: { leftOperand: "observationAgeMinutes", operator: "lteq", rightOperand: 60, unit: "minute" } },
      { label: "observed within the last 3 hours", definition: "For my weather reports, current means observed at most 180 minutes before delivery.", criterion: { leftOperand: "observationAgeMinutes", operator: "lteq", rightOperand: 180, unit: "minute" } },
    ],
  },
  Shoes: {
    repairable: [
      { label: "the soles can be replaced", definition: "For my shoe purchases, repairable means the soles can be replaced.", criterion: { leftOperand: "solesReplaceable", operator: "eq", rightOperand: "true" } },
      { label: "the manufacturer offers a repair service", definition: "For my shoe purchases, repairable means the manufacturer offers a repair service.", criterion: { leftOperand: "manufacturerRepairService", operator: "eq", rightOperand: "true" } },
    ],
  },
};
const SYNONYMS: Record<string, string> = { "up-to-date": "current", "up to date": "current", fresh: "current", latest: "current", current: "current", repairable: "repairable", repaired: "repairable", resoleable: "repairable" };

const PHRASES: Array<{ re: RegExp; category: string; criterion: Criterion }> = [
  { re: /hourly forecast/i, category: "WeatherReport", criterion: { leftOperand: "includesHourlyForecast", operator: "eq", rightOperand: "true" } },
  { re: /replaceable soles|soles (?:must be|are|can be) replace/i, category: "Shoes", criterion: { leftOperand: "solesReplaceable", operator: "eq", rightOperand: "true" } },
  { re: /repair service/i, category: "Shoes", criterion: { leftOperand: "manufacturerRepairService", operator: "eq", rightOperand: "true" } },
];

const CURRENCY = /(USDC|EUR|€|SATS?|sats?)/;

function detectCategory(s: string): string | undefined {
  if (/weather|forecast/i.test(s)) return "WeatherReport";
  if (/shoe|sneaker|boot/i.test(s)) return "Shoes";
  return undefined;
}

/** "within 30 minutes", "no older than 2 hours" -> criterion */
export function parseFreshness(s: string): Criterion | undefined {
  const m = s.match(/(?:within|in) the last\s+(\d+)\s*(minutes?|mins?|hours?|h)\b|(?:within|no older than|at most|max(?:imum)?)\s+(\d+)\s*(minutes?|mins?|hours?|h)\b/i);
  if (!m) return undefined;
  const n = Number(m[1] ?? m[3]);
  const unit = (m[2] ?? m[4]).toLowerCase();
  const minutes = unit.startsWith("h") ? n * 60 : n;
  return { leftOperand: "observationAgeMinutes", operator: "lteq", rightOperand: minutes, unit: "minute" };
}

export class RuleInterpreter implements Interpreter {
  readonly name = "rule-based";
  async interpret(text: string): Promise<Interpretation> {
    const statements: InterpretedStatement[] = [];
    const unrecognized: string[] = [];
    const sentences = text.split(/(?<=[.!?;])\s+|\n+/).map((s) => s.trim()).filter(Boolean);
    let lastCategory: string | undefined;

    for (const raw of sentences) {
      const s = raw.replace(/[.!?;]+$/, "");
      const category = detectCategory(s) ?? lastCategory;
      let matched = false;

      // Spending authority: kept apart from everything else
      // A sentence that claims authority was already granted, or tells the assistant to record
      // something as confirmed, is not the user granting it. Never read a limit out of it.
      if (/\b(already|previously|pre-?)\s*approved\b|\bwas approved\b|\b(record|mark|treat|store)\b[^.]*\b(confirmed|approved)\b|\bnote to the (assistant|agent|ai)\b/i.test(s)) {
        unrecognized.push(raw);
        continue;
      }
      const spend = s.match(/(?:spend|pay|budget)\D*?(?:up to|at most|max(?:imum)?(?: of)?)?\s*(?:€\s*)?(\d+(?:\.\d+)?)\s*(USDC|EUR|€|sats?|SATS?)?/i);
      if (spend && /spend|budget|pay/i.test(s)) {
        const cur = (spend[2] ?? s.match(CURRENCY)?.[1] ?? "USDC").toUpperCase().replace("€", "EUR").replace(/^SATS?$/, "SAT");
        const per = s.match(/(\d+(?:\.\d+)?)\s*(?:USDC|EUR|sats?)?\s*per (?:purchase|transaction|item)/i);
        statements.push({
          text: raw, role: "authorization", category,
          authorization: {
            currency: cur, totalLimit: spend[1], maxPerTransaction: per?.[1],
            approvedSellersOnly: /approved|trusted|known/i.test(s), validDays: 30,
          },
        });
        matched = true;
      }

      // Intention
      const wantsMatch = /\b(get|buy|find|fetch|order|need)\b/i.test(s) && category && !/\bprefer\b/i.test(s);
      if (wantsMatch && !spend) {
        const subject = s.match(/\b(?:for|in)\s+([A-Z][\wäöüß-]+)/)?.[1] ?? s.match(/\b([A-Z][a-zäöüß]+)\s+weather/)?.[1];
        statements.push({ text: raw, role: "intention", category, subject });
        matched = true;
      }

      // Ambiguous terms in this sentence
      if (category) {
        for (const [word, canonical] of Object.entries(SYNONYMS)) {
          if (new RegExp(`\\b${word}\\b`, "i").test(s) && AMBIGUOUS_TERMS[category]?.[canonical]) {
            if (!statements.some((x) => x.ambiguousTerm?.term === canonical)) {
              const isMust = /\bmust|has to|have to|required?\b/i.test(s);
              statements.push({
                text: raw, role: isMust || wantsMatch ? "requirement" : "preference", category,
                ambiguousTerm: { term: canonical, candidates: AMBIGUOUS_TERMS[category][canonical] },
                weight: isMust || wantsMatch ? undefined : 0.5,
              });
            }
            matched = true;
          }
        }
      }

      // Explicit conditions
      const fresh = parseFreshness(s);
      if (fresh && !spend) {
        statements.push({ text: raw, role: /prefer/i.test(s) ? "preference" : "requirement", category: "WeatherReport", criterion: fresh, weight: /prefer/i.test(s) ? 0.5 : undefined });
        matched = true;
      }
      for (const ph of PHRASES) {
        if (ph.re.test(s)) {
          const pref = /prefer|ideally|nice to have|would like/i.test(s);
          statements.push({ text: raw, role: pref ? "preference" : "requirement", category: ph.category, criterion: ph.criterion, weight: pref ? 0.5 : undefined });
          matched = true;
        }
      }
      if (!matched) unrecognized.push(raw);
      lastCategory = category;
    }
    return { statements, unrecognized };
  }
}
