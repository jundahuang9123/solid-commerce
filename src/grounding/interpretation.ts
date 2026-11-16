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

export interface InterpretationCheck {
  /** Human-readable errors, one per problem found. */
  errors: string[];
  /** Indexes (into `statements`) of the statements that failed validation and must not be used. */
  invalid: Set<number>;
  /**
   * The category each statement is validated and applied against: its own
   * category, else the category of the latest valid intention before it
   * (the same rule negotiate() applies). Undefined when neither exists.
   */
  categories: Array<string | undefined>;
}

const DECIMAL = /^\d+(\.\d+)?$/;

/**
 * Validate an interpretation against the vocabulary. Every criterion is
 * checked against the category it will actually be applied to, so a statement
 * that omits its own category cannot slip an unknown property past the check
 * by inheriting the intention's category later. A criterion with no category
 * at all is rejected. Invalid statements are reported by index, never by
 * matching their (interpreter-controlled) text.
 */
export function checkInterpretation(i: Interpretation): InterpretationCheck {
  const errors: string[] = [];
  const invalid = new Set<number>();
  const categories: Array<string | undefined> = [];
  let intentionCategory: string | undefined;
  i.statements.forEach((s, n) => {
    const where = `statement ${n + 1} ("${s.text}")`;
    const before = errors.length;
    const own = s.category ?? undefined; // LLM output may carry null
    if (own !== undefined && !VOCABULARY.categories.includes(own)) errors.push(`${where}: unknown category ${own}`);
    const category = own ?? intentionCategory;
    categories.push(category);
    const checkCriterion = (c: Criterion | undefined) => {
      if (!c) return;
      if (!category) errors.push(`${where}: criterion ${c.leftOperand} has no category (neither the statement nor an earlier intention names one)`);
      else if (!(VOCABULARY.leftOperands[category] ?? []).includes(c.leftOperand)) errors.push(`${where}: unknown property ${c.leftOperand} for ${category}`);
      if (!VOCABULARY.operators.includes(c.operator)) errors.push(`${where}: unknown operator ${c.operator}`);
      if (c.unit && !VOCABULARY.units.includes(c.unit)) errors.push(`${where}: unknown unit ${c.unit}`);
    };
    checkCriterion(s.criterion);
    s.ambiguousTerm?.candidates.forEach((c) => checkCriterion(c.criterion));
    if (s.weight !== undefined && s.weight !== null && (s.weight < 0 || s.weight > 1)) errors.push(`${where}: weight out of range`);
    if (s.role === "authorization") {
      const a = s.authorization;
      if (!a) errors.push(`${where}: authorization without amount`);
      else {
        if (!VOCABULARY.currencies.includes(a.currency)) errors.push(`${where}: unknown currency ${a.currency}`);
        if (!DECIMAL.test(a.totalLimit)) errors.push(`${where}: invalid limit ${a.totalLimit}`);
        const per = a.maxPerTransaction ?? undefined;
        if (per !== undefined) {
          if (!DECIMAL.test(per)) errors.push(`${where}: invalid per-purchase limit ${per}`);
          else if (DECIMAL.test(a.totalLimit) && Number(per) > Number(a.totalLimit)) errors.push(`${where}: per-purchase limit ${per} exceeds total limit ${a.totalLimit}`);
        }
        const days = a.validDays ?? undefined;
        if (days !== undefined && !(Number.isInteger(days) && days >= 1)) errors.push(`${where}: invalid validity ${days} days`);
      }
    }
    if (s.role !== "authorization" && s.authorization) errors.push(`${where}: only authorization statements may carry spending terms`);
    if (errors.length > before) invalid.add(n);
    else if (s.role === "intention" && category) intentionCategory = category;
  });
  return { errors, invalid, categories };
}

export function validateInterpretation(i: Interpretation): string[] {
  return checkInterpretation(i).errors;
}
