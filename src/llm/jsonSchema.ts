/**
 * A small JSON Schema validator for the subset structured-output APIs accept,
 * plus the mechanical rewrite OpenAI's strict mode needs.
 *
 * Why our own and not ajv: providers' "native" structured output differs in
 * how strictly it is enforced (Anthropic and OpenAI strict constrain decoding;
 * Gemini, Ollama and most OpenAI-compatible servers are best-effort; json_object
 * and prompt-only modes only promise JSON). We therefore validate EVERY answer
 * locally, and the subset below is all those APIs share anyway. Unsupported
 * keywords throw instead of being ignored, so a schema can never be silently
 * half-checked.
 *
 * Supported: type (string or array), enum, const, anyOf, properties, required,
 * additionalProperties (boolean or schema), items, minItems, maxItems, minimum,
 * maximum; annotations title and description.
 */
import type { JsonSchema } from "./types.js";

const KEYWORDS = new Set(["type", "enum", "const", "anyOf", "properties", "required", "additionalProperties", "items", "minItems", "maxItems", "minimum", "maximum", "title", "description"]);

function typeOf(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v; // "string" | "number" | "boolean" | "object" | ...
}

function hasType(v: unknown, t: string): boolean {
  if (t === "integer") return typeof v === "number" && Number.isInteger(v);
  if (t === "number") return typeof v === "number" && Number.isFinite(v);
  return typeOf(v) === t;
}

const show = (v: unknown) => JSON.stringify(v);

/** Returns human-readable errors with JSONPath-like locations; empty means valid. */
export function validateJson(value: unknown, schema: JsonSchema, path = "$"): string[] {
  for (const k of Object.keys(schema)) if (!KEYWORDS.has(k)) throw new Error(`jsonSchema: unsupported keyword "${k}" at ${path}`);
  const s = schema as {
    type?: string | string[]; enum?: unknown[]; const?: unknown; anyOf?: JsonSchema[];
    properties?: Record<string, JsonSchema>; required?: string[]; additionalProperties?: boolean | JsonSchema;
    items?: JsonSchema; minItems?: number; maxItems?: number; minimum?: number; maximum?: number;
  };

  if (s.anyOf) {
    const branches = s.anyOf.map((b) => validateJson(value, b, path));
    if (branches.some((e) => e.length === 0)) return [];
    // Report the branch whose type matched: that is the one the model was attempting.
    const typed = s.anyOf.findIndex((b) => b.type === undefined || [b.type].flat().some((t) => hasType(value, t as string)));
    if (typed >= 0) return branches[typed];
    const types = s.anyOf.map((b) => [b.type ?? "any"].flat().join("|")).join(" or ");
    return [`${path}: expected ${types}, got ${typeOf(value)}`];
  }

  if (s.type !== undefined) {
    const types = [s.type].flat();
    if (!types.some((t) => hasType(value, t))) return [`${path}: expected ${types.join("|")}, got ${typeOf(value)}`];
  }
  if (s.enum && !s.enum.some((e) => e === value)) return [`${path}: must be one of ${s.enum.map(show).join(", ")}, got ${show(value)}`];
  if ("const" in s && s.const !== value) return [`${path}: must be ${show(s.const)}`];

  const errors: string[] = [];
  if (typeof value === "number") {
    if (s.minimum !== undefined && value < s.minimum) errors.push(`${path}: must be >= ${s.minimum}`);
    if (s.maximum !== undefined && value > s.maximum) errors.push(`${path}: must be <= ${s.maximum}`);
  }
  if (Array.isArray(value)) {
    if (s.minItems !== undefined && value.length < s.minItems) errors.push(`${path}: needs at least ${s.minItems} item(s)`);
    if (s.maxItems !== undefined && value.length > s.maxItems) errors.push(`${path}: allows at most ${s.maxItems} item(s)`);
    if (s.items) value.forEach((item, i) => errors.push(...validateJson(item, s.items!, `${path}[${i}]`)));
  }
  if (typeOf(value) === "object") {
    const obj = value as Record<string, unknown>;
    for (const r of s.required ?? []) if (!(r in obj)) errors.push(`${path}: missing required property "${r}"`);
    for (const [k, v] of Object.entries(obj)) {
      const sub = s.properties?.[k];
      if (sub) errors.push(...validateJson(v, sub, `${path}.${k}`));
      else if (s.additionalProperties === false) errors.push(`${path}: unexpected property "${k}"`);
      else if (typeof s.additionalProperties === "object") errors.push(...validateJson(v, s.additionalProperties, `${path}.${k}`));
    }
  }
  return errors;
}

const allowsNull = (s: JsonSchema): boolean =>
  [s.type ?? []].flat().includes("null") || ((s.anyOf as JsonSchema[] | undefined) ?? []).some(allowsNull);

/**
 * OpenAI strict structured outputs require every property to be listed in
 * "required" and additionalProperties:false on every object. Optional
 * properties are expressed as nullable instead; `fromStrict` undoes that on the
 * answer so it can be validated against the ORIGINAL schema.
 */
export function toStrictSchema(schema: JsonSchema): JsonSchema {
  const out: JsonSchema = { ...schema };
  if (schema.anyOf) out.anyOf = (schema.anyOf as JsonSchema[]).map(toStrictSchema);
  if (schema.items) out.items = toStrictSchema(schema.items as JsonSchema);
  if (schema.properties) {
    const props = schema.properties as Record<string, JsonSchema>;
    const required = new Set((schema.required as string[] | undefined) ?? []);
    out.properties = Object.fromEntries(Object.entries(props).map(([k, sub]) => {
      const strict = toStrictSchema(sub);
      return [k, required.has(k) || allowsNull(strict) ? strict : { anyOf: [strict, { type: "null" }] }];
    }));
    // Keep the original order first so an already strict-shaped schema is unchanged.
    out.required = [...required, ...Object.keys(props).filter((k) => !required.has(k))];
    out.additionalProperties = false;
  }
  return out;
}

/** Drop the nulls that toStrictSchema made possible for originally optional, non-nullable properties. */
export function fromStrict(value: unknown, schema: JsonSchema): unknown {
  if (Array.isArray(value)) return schema.items ? value.map((v) => fromStrict(v, schema.items as JsonSchema)) : value;
  if (typeOf(value) !== "object") return value;
  if (schema.anyOf) {
    // Only an object branch can need rewriting; pick the first one that has properties.
    const branch = (schema.anyOf as JsonSchema[]).find((b) => b.properties);
    return branch ? fromStrict(value, branch) : value;
  }
  const props = (schema.properties ?? {}) as Record<string, JsonSchema>;
  const required = new Set((schema.required as string[] | undefined) ?? []);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    const sub = props[k];
    if (v === null && sub && !required.has(k) && !allowsNull(sub)) continue;
    out[k] = sub ? fromStrict(v, sub) : v;
  }
  return out;
}
