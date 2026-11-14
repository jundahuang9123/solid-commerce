/**
 * Optional LLM interpreter using Claude. Enabled with INTERPRETER=claude and an
 * Anthropic credential (ANTHROPIC_API_KEY, or an `ant auth login` profile).
 *
 * The model only PROPOSES a structured interpretation, constrained by a JSON
 * schema. The application then validates it against the vocabulary, asks
 * clarifying questions, and requires user confirmation before anything is
 * written as common ground. The model never writes RDF and never touches
 * spending authority directly.
 */
import Anthropic from "@anthropic-ai/sdk";
import type { Interpretation, Interpreter } from "./interpretation.js";
import { VOCABULARY } from "./interpretation.js";

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
} as const;

const SCHEMA = {
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

const SYSTEM = `You turn a shopper's request into a structured interpretation for a purchasing assistant.
Rules:
- Split the request into statements. role is one of: intention (what to obtain), preference (ranking only), requirement (mandatory filter), authorization (permission to spend money), meaning (the user defines a term).
- Only "authorization" statements may carry spending terms. Never infer a spending limit the user did not state.
- If a term is vague and could be operationalised in more than one reasonable way (e.g. "current", "repairable"), do NOT pick one: set ambiguousTerm with 2-4 candidates, each with an executable criterion.
- Use only these categories: ${VOCABULARY.categories.join(", ")}.
- Use only these criterion properties per category: ${JSON.stringify(VOCABULARY.leftOperands)}.
- Boolean values are the strings "true"/"false". Durations use unit "minute".
- Put anything you cannot map onto this vocabulary into "unrecognized" rather than guessing.
- Set fields that do not apply to null.`;

function stripNulls(v: any): any {
  if (Array.isArray(v)) return v.map(stripNulls);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).filter(([, x]) => x !== null).map(([k, x]) => [k, stripNulls(x)]));
  return v;
}

export class ClaudeInterpreter implements Interpreter {
  readonly name = "claude";
  private readonly client: Anthropic;
  constructor(private readonly model = process.env.CLAUDE_MODEL ?? "claude-opus-5-5", client?: Anthropic) {
    this.client = client ?? new Anthropic();
  }

  async interpret(text: string): Promise<Interpretation> {
    // Server-side fallbacks are enabled so a safety-classifier decline is re-run on a fallback model.
    const response: any = await (this.client.beta.messages.create as any)({
      model: this.model,
      max_tokens: 16000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: { effort: "medium", format: { type: "json_schema", schema: SCHEMA } },
      system: SYSTEM,
      messages: [{ role: "user", content: text }],
    });
    if (response.stop_reason === "refusal") {
      throw new Error(`Interpreter declined: ${response.stop_details?.category ?? "unknown"} ${response.stop_details?.explanation ?? ""}`);
    }
    if (response.stop_reason === "max_tokens") throw new Error("Interpreter output truncated");
    const block = response.content.find((b: any) => b.type === "text");
    if (!block) throw new Error("Interpreter returned no text");
    return stripNulls(JSON.parse(block.text)) as Interpretation;
  }
}
