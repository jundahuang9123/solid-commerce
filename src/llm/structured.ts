/**
 * The provider-independent half of structured generation: call the adapter,
 * refuse refused or truncated answers, parse, validate against the schema,
 * and repair at most once by showing the model its own validation errors.
 *
 * The repair is bounded on purpose: a model that fails twice on the same
 * schema is not going to converge, and every extra round trip costs money and
 * latency. Refusals and truncations are never retried here; resending the same
 * request would most likely hit the same limit or policy.
 */
import { validateJson } from "./jsonSchema.js";
import { LlmError, type ChatAdapter, type ProviderName, type StructuredRequest, type StructuredResult, type Turn, type Usage } from "./types.js";

export const MAX_REPAIRS = 1;

/**
 * Parse model text as JSON. Native modes return bare JSON; json_object and
 * prompt-only modes sometimes wrap it in a code fence or a sentence, so those
 * are unwrapped. Whatever comes out is still schema-validated.
 */
export function parseJsonText(text: string): { ok: true; value: unknown } | { ok: false; error: string } {
  const candidates = [text.trim()];
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  if (fenced) candidates.push(fenced.trim());
  const first = text.indexOf("{"), last = text.lastIndexOf("}");
  if (first >= 0 && last > first) candidates.push(text.slice(first, last + 1));
  for (const c of candidates) {
    try { return { ok: true, value: JSON.parse(c) }; } catch { /* try the next candidate */ }
  }
  return { ok: false, error: text.trim() ? "$: output is not valid JSON" : "$: output is empty" };
}

/**
 * Schema-in-the-prompt instruction for modes that cannot carry a schema
 * natively (json_object, prompt-only) or that benefit from seeing it (Ollama).
 */
export function schemaInstruction(schema: unknown): string {
  return `\n\nRespond with a single JSON object, and nothing else, that conforms to this JSON schema:\n${JSON.stringify(schema)}`;
}

function repairPrompt(errors: string[]): string {
  return [
    "Your previous answer did not conform to the required JSON schema:",
    ...errors.slice(0, 20).map((e) => `- ${e}`),
    "Reply again with the complete corrected JSON object only, no prose.",
  ].join("\n");
}

const add = (a: number | undefined, b: number | undefined) => (a === undefined && b === undefined ? undefined : (a ?? 0) + (b ?? 0));

export async function generateStructured<T>(adapter: ChatAdapter, req: StructuredRequest): Promise<StructuredResult<T>> {
  const turns: Turn[] = [{ role: "user", content: req.user }];
  let usage: Usage = {};
  for (let attempt = 1; ; attempt++) {
    const c = await adapter.complete({ system: req.system, turns: [...turns], schema: req.schema, schemaName: req.schemaName });
    usage = { inputTokens: add(usage.inputTokens, c.usage.inputTokens), outputTokens: add(usage.outputTokens, c.usage.outputTokens) };
    if (c.finish === "refusal") throw new LlmError("refusal", `model declined${c.detail ? `: ${c.detail}` : ""}`, adapter.provider, { rawText: c.text });
    if (c.finish === "truncated") throw new LlmError("truncated", `output truncated at the token limit${c.detail ? ` (${c.detail})` : ""}; refusing to parse a partial answer`, adapter.provider, { rawText: c.text });

    const parsed = parseJsonText(c.text);
    const errors = parsed.ok ? validateJson(parsed.value, req.schema) : [parsed.error];
    if (errors.length === 0) return { value: (parsed as { value: T }).value, provider: adapter.provider, requestedModel: adapter.model, model: c.model, usage, attempts: attempt };
    if (attempt > MAX_REPAIRS) {
      throw new LlmError("invalid_output", `output failed schema validation after ${attempt} attempts: ${errors.slice(0, 5).join("; ")}`, adapter.provider, { validationErrors: errors, rawText: c.text });
    }
    turns.push({ role: "assistant", content: c.text || "(empty)" }, { role: "user", content: repairPrompt(errors) });
  }
}

/**
 * Map an SDK or fetch error onto the typed error model. SDKs differ in class
 * hierarchy but agree on an HTTP `status` and on recognisable timeout and
 * connection error names, so this works across them without importing each
 * SDK's error classes.
 */
export function toLlmError(provider: ProviderName, err: unknown): LlmError {
  if (err instanceof LlmError) return err;
  const e = (err ?? {}) as { status?: unknown; name?: string; message?: string; code?: string; cause?: { code?: string } };
  const names = `${e.name ?? ""} ${(err as object)?.constructor?.name ?? ""}`;
  const message = e.message ?? String(err);
  const status = typeof e.status === "number" ? e.status : undefined;
  const make = (kind: LlmError["kind"], text: string) => new LlmError(kind, text, provider, { status, cause: err });

  // No status: the request never got an HTTP answer.
  if (status === undefined) {
    if (/Timeout|Abort/i.test(names) || e.code === "ETIMEDOUT" || /timed? ?out|aborted/i.test(message)) return make("timeout", `request timed out: ${message}`);
    return make("transport", `connection failed: ${message}`);
  }
  if (status === 401 || status === 403) return make("auth", `authentication failed (${status}): ${message}`);
  if (status === 429) return make("rate_limit", `rate limited or out of quota (429): ${message}`);
  if (status === 408) return make("timeout", `request timed out (408): ${message}`);
  if (status >= 500) return make("transport", `provider error (${status}): ${message}`);
  return make("bad_request", `request rejected (${status}): ${message}`);
}
