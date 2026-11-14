/**
 * The structured interpretation an interpreter (rule-based or LLM) proposes
 * for a user's natural-language request. Nothing here is trusted until it has
 * been validated, clarified where ambiguous, and confirmed by the user.
 */
import type { Criterion } from "../model.js";

export interface CandidateMeaning {
  label: string;              // short option shown to the user
  definition: string;         // what accepting it means
  criterion: Criterion;
}

export interface InterpretedStatement {
  text: string;
  role: "intention" | "preference" | "requirement" | "authorization" | "meaning";
  category?: string;
  subject?: string;
  criterion?: Criterion;
  weight?: number;
  /** A term whose meaning must be agreed before it can be applied. */
  ambiguousTerm?: { term: string; candidates: CandidateMeaning[] };
  authorization?: {
    currency: string;
    totalLimit: string;          // major units
    maxPerTransaction?: string;
    approvedSellersOnly: boolean;
    validDays?: number;
  };
}

export interface Interpretation {
  statements: InterpretedStatement[];
  /** Phrases the interpreter could not map onto the vocabulary. */
  unrecognized: string[];
}

export interface Interpreter {
  readonly name: string;
  interpret(text: string): Promise<Interpretation>;
}

/** The vocabulary interpreters may use. Anything else is rejected during validation. */
export const VOCABULARY = {
  categories: ["WeatherReport", "Shoes"],
  leftOperands: {
    WeatherReport: ["observationAgeMinutes", "observationMaxAgeMinutes", "coverage", "includesHourlyForecast", "price"],
    Shoes: ["solesReplaceable", "manufacturerRepairService", "price"],
  } as Record<string, string[]>,
  operators: ["eq", "lt", "lteq", "gt", "gteq", "isAnyOf"],
  currencies: ["USDC", "EUR", "SAT"],
  units: ["minute", "hour"],
};

export function validateInterpretation(i: Interpretation): string[] {
  const errors: string[] = [];
  const checkCriterion = (c: Criterion | undefined, category: string | undefined, where: string) => {
    if (!c) return;
    if (category && !(VOCABULARY.leftOperands[category] ?? []).includes(c.leftOperand)) errors.push(`${where}: unknown property ${c.leftOperand} for ${category}`);
    if (!VOCABULARY.operators.includes(c.operator)) errors.push(`${where}: unknown operator ${c.operator}`);
    if (c.unit && !VOCABULARY.units.includes(c.unit)) errors.push(`${where}: unknown unit ${c.unit}`);
  };
  i.statements.forEach((s, n) => {
    const where = `statement ${n + 1} ("${s.text}")`;
    if (s.category && !VOCABULARY.categories.includes(s.category)) errors.push(`${where}: unknown category ${s.category}`);
    checkCriterion(s.criterion, s.category, where);
    s.ambiguousTerm?.candidates.forEach((c) => checkCriterion(c.criterion, s.category, where));
    if (s.weight !== undefined && (s.weight < 0 || s.weight > 1)) errors.push(`${where}: weight out of range`);
    if (s.role === "authorization") {
      const a = s.authorization;
      if (!a) errors.push(`${where}: authorization without amount`);
      else {
        if (!VOCABULARY.currencies.includes(a.currency)) errors.push(`${where}: unknown currency ${a.currency}`);
        if (!/^\d+(\.\d+)?$/.test(a.totalLimit)) errors.push(`${where}: invalid limit ${a.totalLimit}`);
      }
    }
    if (s.role !== "authorization" && s.authorization) errors.push(`${where}: only authorization statements may carry spending terms`);
  });
  return errors;
}
