/**
 * Interpreter backed by any LLM provider in src/llm (Anthropic, OpenAI,
 * Gemini, Ollama, OpenAI-compatible servers).
 *
 * The model only PROPOSES a structured interpretation, constrained by the
 * JSON schema below and validated against it locally. The application then
 * validates it against the vocabulary (validateInterpretation), asks
 * clarifying questions and requires user confirmation on the approval device
 * before anything is written as common ground. The model never writes RDF and
 * never touches spending authority directly, so a weaker model can misread a
 * request but cannot widen what may be spent.
 */
import { createLlm, llmConfigFromEnv, type LlmConfig } from "../llm/config.js";
import { generateStructured } from "../llm/structured.js";
import type { ChatAdapter, StructuredResult } from "../llm/types.js";
import type { Interpretation, Interpreter } from "./interpretation.js";
import { VOCABULARY } from "./interpretation.js";
import { RuleInterpreter } from "./ruleInterpreter.js";

const criterionSchema = {
  type: "object",
  additionalProperties: false,
  required: ["leftOperand", "operator", "rightOperand", "unit"],
  properties: {
    leftOperand: { type: "string" },
    operator: { type: "string", enum: VOCABULARY.operators },
    rightOperand: { anyOf: [{ type: "string" }, { type: "number" }] },
    unit: { anyOf: [{ type: "string", enum: VOCABULARY.units }, { type: "null" }] },
  },
};

/** Every field is required and nullable, so the schema is valid as-is for OpenAI strict mode too. */
export const INTERPRETATION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["statements", "unrecognized"],
  properties: {
    unrecognized: { type: "array", items: { type: "string" } },
    statements: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["text", "role", "category", "subject", "criterion", "weight", "ambiguousTerm", "authorization"],
        properties: {
          text: { type: "string" },
          role: { type: "string", enum: ["intention", "preference", "requirement", "authorization", "meaning"] },
          category: { anyOf: [{ type: "string", enum: VOCABULARY.categories }, { type: "null" }] },
          subject: { anyOf: [{ type: "string" }, { type: "null" }] },
          criterion: { anyOf: [criterionSchema, { type: "null" }] },
          weight: { anyOf: [{ type: "number" }, { type: "null" }] },
          ambiguousTerm: {
            anyOf: [{ type: "null" }, {
              type: "object", additionalProperties: false, required: ["term", "candidates"],
              properties: {
                term: { type: "string" },
                candidates: {
                  type: "array",
                  items: { type: "object", additionalProperties: false, required: ["label", "definition", "criterion"], properties: { label: { type: "string" }, definition: { type: "string" }, criterion: criterionSchema } },
                },
              },
            }],
          },
          authorization: {
            anyOf: [{ type: "null" }, {
              type: "object", additionalProperties: false,
              required: ["currency", "totalLimit", "maxPerTransaction", "approvedSellersOnly", "validDays"],
              properties: {
                currency: { type: "string", enum: VOCABULARY.currencies },
                totalLimit: { type: "string", description: "decimal string in major units, e.g. \"1.00\"" },
                maxPerTransaction: { anyOf: [{ type: "string" }, { type: "null" }] },
                approvedSellersOnly: { type: "boolean" },
                validDays: { anyOf: [{ type: "integer" }, { type: "null" }] },
              },
            }],
          },
        },
      },
    },
  },
};

export const INTERPRETER_SYSTEM = `You turn a shopper's request into a structured interpretation for a purchasing assistant.
Rules:
- Split the request into statements. role is one of: intention (what to obtain), preference (ranking only), requirement (mandatory filter), authorization (permission to spend money), meaning (the user defines a term).
- Only "authorization" statements may carry spending terms. Never infer a spending limit the user did not state.
- If a term is vague and could be operationalised in more than one reasonable way (e.g. "current", "repairable"), do NOT pick one: set ambiguousTerm with 2-4 candidates, each with an executable criterion.
- Use only these categories: ${VOCABULARY.categories.join(", ")}.
- Use only these criterion properties per category: ${JSON.stringify(VOCABULARY.leftOperands)}.
- Boolean values are the strings "true"/"false". Durations use unit "minute".
- Put anything you cannot map onto this vocabulary into "unrecognized" rather than guessing.
- Set fields that do not apply to null.`;

/** The schema expresses "not applicable" as null; the Interpretation type uses absent fields. */
function stripNulls(v: any): any {
  if (Array.isArray(v)) return v.map(stripNulls);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).filter(([, x]) => x !== null).map(([k, x]) => [k, stripNulls(x)]));
  return v;
}

export type InterpretationMeta = Omit<StructuredResult<unknown>, "value">;

export class LlmInterpreter implements Interpreter {
  readonly name: string;

  constructor(readonly llm: ChatAdapter) {
    this.name = `${llm.provider}:${llm.model}`;
  }

  /** Interpretation plus which model answered, token usage and whether a repair was needed. */
  async interpretWithMeta(text: string): Promise<{ interpretation: Interpretation; meta: InterpretationMeta }> {
    const { value, ...meta } = await generateStructured<unknown>(this.llm, { system: INTERPRETER_SYSTEM, user: text, schema: INTERPRETATION_SCHEMA, schemaName: "interpretation" });
    return { interpretation: stripNulls(value) as Interpretation, meta };
  }

  async interpret(text: string): Promise<Interpretation> {
    return (await this.interpretWithMeta(text)).interpretation;
  }
}

/**
 * Per-agent configuration in code: "rules", a provider config, or a ready
 * adapter (e.g. one built around an SDK client for Bedrock or Vertex).
 */
export function createInterpreter(spec: "rules" | LlmConfig | ChatAdapter = "rules"): Interpreter {
  if (spec === "rules") return new RuleInterpreter();
  return new LlmInterpreter("complete" in spec ? spec : createLlm(spec));
}

/** The interpreter the environment selects (LLM_PROVIDER, or legacy INTERPRETER=claude); rule-based by default. */
export function interpreterFromEnv(env: Record<string, string | undefined> = process.env): Interpreter {
  const cfg = llmConfigFromEnv(env);
  return cfg ? createInterpreter(cfg) : new RuleInterpreter();
}
