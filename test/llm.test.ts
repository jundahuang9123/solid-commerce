/**
 * Provider-neutral LLM layer. No live API keys exist in CI, so each adapter's
 * REAL SDK (or, for Ollama, plain fetch) is pointed at a local mock server
 * that answers in that provider's documented wire format. The tests check
 * what goes over the wire (endpoint, auth header, model id, schema in the
 * provider's native field) and how answers, refusals, truncations, invalid
 * output and HTTP errors are mapped onto the typed error model.
 */
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { serve, json } from "../src/util/http.js";
import { validateJson, toStrictSchema, fromStrict } from "../src/llm/jsonSchema.js";
import { generateStructured, parseJsonText } from "../src/llm/structured.js";
import { LlmError, type AdapterOptions, type ChatAdapter } from "../src/llm/types.js";
import { AnthropicAdapter } from "../src/llm/providers/anthropic.js";
import { OpenAIAdapter } from "../src/llm/providers/openai.js";
import { GeminiAdapter } from "../src/llm/providers/gemini.js";
import { OllamaAdapter } from "../src/llm/providers/ollama.js";
import { createLlm, llmConfigFromEnv, providerConfigFromEnv } from "../src/llm/config.js";
import { createInterpreter, interpreterFromEnv, INTERPRETATION_SCHEMA, LlmInterpreter } from "../src/grounding/llmInterpreter.js";
import { ClaudeInterpreter } from "../src/grounding/claudeInterpreter.js";
import { RuleInterpreter } from "../src/grounding/ruleInterpreter.js";
import { CommonGround } from "../src/grounding/commonGround.js";
import { PodClient } from "../src/pod/PodClient.js";
import { PodLayout } from "../src/pod/layout.js";
import { assess, CASES, configuredProviders } from "../src/llm/compare.js";
import type { Interpretation } from "../src/grounding/interpretation.js";
import { startCss, startEnvironment, AGENT_1, AGENT_2 } from "../src/demo/environment.js";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createNetServer } from "node:net";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// ------------------------------------------------------------------ mock provider servers

interface Recorded { method: string; url: string; headers: Record<string, string | string[] | undefined>; body: any }
type Reply = { status?: number; body: unknown; delayMs?: number };

async function mockServer(reply: (r: Recorded, n: number) => Reply) {
  const requests: Recorded[] = [];
  const srv = await serve(async (req, res) => {
    const r: Recorded = { method: req.method ?? "", url: req.url, headers: req.headers, body: req.body ? JSON.parse(req.body) : undefined };
    requests.push(r);
    const out = reply(r, requests.length);
    if (out.delayMs) await new Promise((ok) => setTimeout(ok, out.delayMs));
    if (!res.destroyed) json(res, out.status ?? 200, out.body);
  });
  servers.push(srv);
  return { url: srv.url, requests };
}
const servers: Array<{ close(): Promise<void> }> = [];
after(async () => { await Promise.all(servers.map((s) => s.close())); });

const opts = (url: string, extra: Partial<AdapterOptions> = {}): AdapterOptions => ({ model: "test-model", apiKey: "sk-test", baseURL: url, timeoutMs: 5000, maxRetries: 0, maxOutputTokens: 16000, ...extra });

/** A schema-valid interpretation in the null-for-absent form the schema prescribes. */
const st = (o: Record<string, unknown>) => ({ category: null, subject: null, criterion: null, weight: null, ambiguousTerm: null, authorization: null, ...o });
const CURRENT = { label: "within 60 minutes", definition: "current means observed at most 60 minutes before delivery", criterion: { leftOperand: "observationAgeMinutes", operator: "lteq", rightOperand: 60, unit: "minute" } };
const INTERP = {
  statements: [
    st({ text: "Get me a current Berlin weather report.", role: "intention", category: "WeatherReport", subject: "Berlin" }),
    st({ text: "Get me a current Berlin weather report.", role: "requirement", category: "WeatherReport", ambiguousTerm: { term: "current", candidates: [CURRENT] } }),
    st({ text: "You may spend up to 1 USDC.", role: "authorization", category: "WeatherReport", authorization: { currency: "USDC", totalLimit: "1.00", maxPerTransaction: null, approvedSellersOnly: true, validDays: 30 } }),
  ],
  unrecognized: [],
};
const REQ = { system: "SYSTEM PROMPT", user: "Get me a current Berlin weather report. You may spend up to 1 USDC.", schema: INTERPRETATION_SCHEMA, schemaName: "interpretation" };

async function rejects(p: Promise<unknown>, kind: LlmError["kind"]): Promise<LlmError> {
  try { await p; } catch (err) {
    assert.ok(err instanceof LlmError, `expected LlmError, got ${err}`);
    assert.equal(err.kind, kind, err.message);
    return err;
  }
  assert.fail(`expected LlmError ${kind}`);
}

// Wire formats -------------------------------------------------------------

const anthropicMessage = (text: string, extra: Record<string, unknown> = {}) => ({
  id: "msg_1", type: "message", role: "assistant", model: "claude-opus-5-5", content: [{ type: "text", text }],
  stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 120, output_tokens: 80 }, ...extra,
});
const openaiCompletion = (message: Record<string, unknown>, finish = "stop") => ({
  id: "chatcmpl-1", object: "chat.completion", created: 1_700_000_000, model: "gpt-test-2026",
  choices: [{ index: 0, message: { role: "assistant", content: null, refusal: null, ...message }, finish_reason: finish, logprobs: null }],
  usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
});
const geminiResponse = (text: string, finishReason = "STOP", extra: Record<string, unknown> = {}) => ({
  candidates: [{ content: { role: "model", parts: [{ text }] }, finishReason, index: 0 }],
  usageMetadata: { promptTokenCount: 90, candidatesTokenCount: 40, thoughtsTokenCount: 10, totalTokenCount: 140 },
  modelVersion: "gemini-test-001", ...extra,
});
const ollamaResponse = (content: string, done_reason = "stop") => ({
  model: "llama-test", created_at: "2026-11-14T00:00:00Z", message: { role: "assistant", content }, done: true, done_reason, prompt_eval_count: 70, eval_count: 30,
});

// ------------------------------------------------------------------ tests

describe("json schema subset", () => {
  test("validates types, enums, required, additionalProperties and anyOf with useful paths", () => {
    assert.deepEqual(validateJson(INTERP, INTERPRETATION_SCHEMA), []);
    const bad = structuredClone(INTERP) as any;
    bad.statements[0].role = "boss";
    bad.statements[1].ambiguousTerm.candidates[0].criterion.operator = "approx";
    bad.statements[2].authorization.validDays = 1.5;
    bad.statements[2].extra = true;
    delete bad.unrecognized;
    const errors = validateJson(bad, INTERPRETATION_SCHEMA);
    assert.ok(errors.includes(`$: missing required property "unrecognized"`), errors.join("\n"));
    assert.ok(errors.some((e) => e.startsWith("$.statements[0].role: must be one of")));
    assert.ok(errors.some((e) => e.startsWith("$.statements[1].ambiguousTerm.candidates[0].criterion.operator")));
    assert.ok(errors.includes("$.statements[2].authorization.validDays: expected integer or null, got number"));
    assert.ok(errors.includes(`$.statements[2]: unexpected property "extra"`));
    assert.throws(() => validateJson({}, { type: "object", patternProperties: {} }), /unsupported keyword/);
  });

  test("Object.prototype keys neither satisfy required nor bypass additionalProperties:false", () => {
    const closed = { type: "object", additionalProperties: false, properties: { a: { type: "string" } } };
    for (const k of ["constructor", "toString", "hasOwnProperty", "__proto__"]) {
      const value = JSON.parse(`{"${k}": "x"}`);
      assert.deepEqual(validateJson(value, closed), [`$: unexpected property "${k}"`], k);
      assert.deepEqual(validateJson({}, { type: "object", required: [k] }), [`$: missing required property "${k}"`], k);
    }
    // A schema property named like a prototype key still works when it is declared.
    assert.deepEqual(validateJson({ constructor: 1 }, { type: "object", additionalProperties: false, properties: { constructor: { type: "number" } } }), []);
    assert.deepEqual(validateJson({ constructor: "x" }, { type: "object", properties: { constructor: { type: "number" } } }), ["$.constructor: expected number, got string"]);
    // fromStrict must not treat an inherited key as a declared property either.
    const optional = { type: "object", properties: { a: { type: "string" } } };
    assert.deepEqual(fromStrict({ a: null, toString: null }, optional), { toString: null });
    assert.deepEqual(Object.keys(fromStrict(JSON.parse('{"__proto__": {"polluted": true}}'), optional) as object), ["__proto__"]);
    assert.equal(({} as any).polluted, undefined);
  });

  test("strict-mode rewrite makes every property required and nullable, and is undone on the answer", () => {
    const schema = { type: "object", required: ["a"], properties: { a: { type: "string" }, b: { type: "number" }, c: { type: "object", properties: { d: { type: "string" } } } } };
    const strict = toStrictSchema(schema) as any;
    assert.deepEqual(strict.required, ["a", "b", "c"]);
    assert.equal(strict.additionalProperties, false);
    assert.deepEqual(strict.properties.b, { anyOf: [{ type: "number" }, { type: "null" }] });
    assert.equal(strict.properties.c.anyOf[0].additionalProperties, false);
    const answer = { a: "x", b: null, c: { d: null } };
    assert.deepEqual(validateJson(answer, strict), []);
    assert.deepEqual(fromStrict(answer, schema), { a: "x", c: {} });
    // The interpretation schema is already strict-shaped: the rewrite is a no-op on it.
    assert.deepEqual(toStrictSchema(INTERPRETATION_SCHEMA), INTERPRETATION_SCHEMA);
  });

  test("JSON is extracted from fences and prose only as a fallback", () => {
    assert.deepEqual(parseJsonText('{"a":1}'), { ok: true, value: { a: 1 } });
    assert.deepEqual(parseJsonText('Sure:\n```json\n{"a":2}\n```'), { ok: true, value: { a: 2 } });
    assert.deepEqual(parseJsonText('Here it is: {"a":3} hope that helps'), { ok: true, value: { a: 3 } });
    assert.equal(parseJsonText("no json here").ok, false);
  });
});

describe("anthropic adapter (@anthropic-ai/sdk against a mock Messages API)", () => {
  test("keeps the established request shape and parses the answer", async () => {
    const m = await mockServer(() => ({ body: anthropicMessage(JSON.stringify(INTERP)) }));
    const r = await generateStructured(AnthropicAdapter.create(opts(m.url, { model: "claude-opus-5-5" })), REQ);
    assert.deepEqual(r.value, INTERP);
    assert.deepEqual({ model: r.model, usage: r.usage, attempts: r.attempts, provider: r.provider }, { model: "claude-opus-5-5", usage: { inputTokens: 120, outputTokens: 80 }, attempts: 1, provider: "anthropic" });
    const [req] = m.requests;
    assert.match(req.url, /^\/v1\/messages(\?beta=true)?$/);
    assert.equal(req.body.betas, undefined, "betas travel in the anthropic-beta header");
    // SDK 1.x sends the API key as a bearer token (older releases used x-api-key).
    assert.equal(req.headers.authorization, "Bearer sk-test");
    assert.match(String(req.headers["anthropic-beta"]), /server-side-fallback-2026-07-01/);
    assert.equal(req.body.model, "claude-opus-5-5", "model id passed through verbatim");
    assert.equal(req.body.max_tokens, 16000);
    assert.equal(req.body.fallbacks, "default");
    assert.deepEqual(req.body.output_config, { effort: "medium", format: { type: "json_schema", schema: INTERPRETATION_SCHEMA } });
    assert.equal(req.body.system, "SYSTEM PROMPT");
    assert.deepEqual(req.body.messages, [{ role: "user", content: REQ.user }]);
  });

  test("refusal and max_tokens are typed errors and never parsed or retried", async () => {
    const refusing = await mockServer(() => ({ body: anthropicMessage('{"statements":[]', { stop_reason: "refusal", stop_details: { category: "cyber", explanation: "declined" } }) }));
    const e = await rejects(generateStructured(AnthropicAdapter.create(opts(refusing.url)), REQ), "refusal");
    assert.match(e.message, /cyber: declined/);
    assert.equal(refusing.requests.length, 1);
    const truncating = await mockServer(() => ({ body: anthropicMessage('{"statements":[', { stop_reason: "max_tokens" }) }));
    await rejects(generateStructured(AnthropicAdapter.create(opts(truncating.url)), REQ), "truncated");
    assert.equal(truncating.requests.length, 1);
    // The context window filling up also cuts the JSON off: typed truncation, no repair round trip.
    for (const stop_reason of ["model_context_window_exceeded", "pause_turn", "compaction"]) {
      const full = await mockServer(() => ({ body: anthropicMessage('{"statements":[{"text":"Get me', { stop_reason }) }));
      const err = await rejects(generateStructured(AnthropicAdapter.create(opts(full.url)), REQ), "truncated");
      assert.match(err.message, new RegExp(stop_reason));
      assert.equal(full.requests.length, 1, stop_reason);
    }
  });

  test("HTTP errors map onto auth / rate_limit / transport", async () => {
    for (const [status, kind] of [[401, "auth"], [429, "rate_limit"], [529, "transport"]] as const) {
      const m = await mockServer(() => ({ status, body: { type: "error", error: { type: "x", message: `status ${status}` } } }));
      const e = await rejects(generateStructured(AnthropicAdapter.create(opts(m.url)), REQ), kind);
      assert.equal(e.details.status, status);
      assert.equal(e.retryable, kind !== "auth");
    }
  });

  test("ClaudeInterpreter stays a working backwards-compatible wrapper", async () => {
    const m = await mockServer(() => ({ body: anthropicMessage(JSON.stringify(INTERP)) }));
    const { default: Anthropic } = await import("@anthropic-ai/sdk");
    const i = new ClaudeInterpreter("claude-opus-5-5", new Anthropic({ apiKey: "sk-test", baseURL: m.url, maxRetries: 0 }));
    assert.equal(i.name, "claude");
    const out = await i.interpret("Get me a current Berlin weather report.");
    assert.equal(out.statements[0].subject, "Berlin");
    assert.ok(!("criterion" in out.statements[0]), "nulls are stripped back to absent fields");
  });
});

describe("openai adapter (openai SDK against a mock Chat Completions API)", () => {
  test("sends strict json_schema structured outputs and parses the answer", async () => {
    const m = await mockServer(() => ({ body: openaiCompletion({ content: JSON.stringify(INTERP) }) }));
    const r = await generateStructured(OpenAIAdapter.create(opts(m.url, { model: "gpt-5" })), REQ);
    assert.deepEqual(r.value, INTERP);
    assert.equal(r.model, "gpt-test-2026");
    assert.deepEqual(r.usage, { inputTokens: 100, outputTokens: 50 });
    const [req] = m.requests;
    assert.equal(req.url, "/chat/completions");
    assert.equal(req.headers.authorization, "Bearer sk-test");
    assert.equal(req.body.model, "gpt-5");
    assert.equal(req.body.max_completion_tokens, 16000);
    assert.equal(req.body.max_tokens, undefined);
    assert.deepEqual(req.body.response_format, { type: "json_schema", json_schema: { name: "interpretation", strict: true, schema: toStrictSchema(INTERPRETATION_SCHEMA) } });
    assert.deepEqual(req.body.messages, [{ role: "system", content: "SYSTEM PROMPT" }, { role: "user", content: REQ.user }]);
  });

  test("invalid JSON is repaired once with the validation errors, then fails typed", async () => {
    const once = await mockServer((_r, n) => ({ body: openaiCompletion({ content: n === 1 ? "not json at all" : JSON.stringify(INTERP) }) }));
    const r = await generateStructured(OpenAIAdapter.create(opts(once.url)), REQ);
    assert.equal(r.attempts, 2);
    assert.deepEqual(r.usage, { inputTokens: 200, outputTokens: 100 }, "usage summed over attempts");
    const retry = once.requests[1].body.messages;
    assert.deepEqual(retry[2], { role: "assistant", content: "not json at all" });
    assert.match(retry[3].content, /did not conform[\s\S]*not valid JSON/);

    const wrongShape = { ...INTERP, statements: [{ ...INTERP.statements[0], role: "boss" }] };
    const never = await mockServer(() => ({ body: openaiCompletion({ content: JSON.stringify(wrongShape) }) }));
    const e = await rejects(generateStructured(OpenAIAdapter.create(opts(never.url)), REQ), "invalid_output");
    assert.equal(never.requests.length, 2, "bounded: one repair only");
    assert.ok(e.details.validationErrors?.some((v) => v.includes("$.statements[0].role")));
    assert.match(never.requests[1].body.messages[3].content, /\$\.statements\[0\]\.role: must be one of/);
  });

  test("refusal field, content_filter and finish_reason length are typed", async () => {
    const refusal = await mockServer(() => ({ body: openaiCompletion({ refusal: "I can't help with that." }) }));
    assert.match((await rejects(generateStructured(OpenAIAdapter.create(opts(refusal.url)), REQ), "refusal")).message, /can't help/);
    const filtered = await mockServer(() => ({ body: openaiCompletion({ content: "" }, "content_filter") }));
    await rejects(generateStructured(OpenAIAdapter.create(opts(filtered.url)), REQ), "refusal");
    const cut = await mockServer(() => ({ body: openaiCompletion({ content: '{"statements":[' }, "length") }));
    await rejects(generateStructured(OpenAIAdapter.create(opts(cut.url)), REQ), "truncated");
    assert.equal(cut.requests.length, 1);
  });

  test("HTTP errors and timeouts are typed", async () => {
    for (const [status, kind] of [[401, "auth"], [403, "auth"], [429, "rate_limit"], [400, "bad_request"], [503, "transport"]] as const) {
      const m = await mockServer(() => ({ status, body: { error: { message: `status ${status}`, type: "x", code: null } } }));
      await rejects(generateStructured(OpenAIAdapter.create(opts(m.url)), REQ), kind);
    }
    const slow = await mockServer(() => ({ body: openaiCompletion({ content: "{}" }), delayMs: 1500 }));
    await rejects(generateStructured(OpenAIAdapter.create(opts(slow.url, { timeoutMs: 200 })), REQ), "timeout");
    await rejects(generateStructured(OpenAIAdapter.create(opts("http://127.0.0.1:1")), REQ), "transport");
  });

  test("Azure OpenAI: deployment path, api-version and api-key header", async () => {
    const m = await mockServer(() => ({ body: openaiCompletion({ content: JSON.stringify(INTERP) }) }));
    const a = OpenAIAdapter.createAzure({ ...opts(m.url, { model: "my-deployment" }), endpoint: m.url, apiVersion: "2024-10-21" });
    await generateStructured(a, REQ);
    const [req] = m.requests;
    assert.equal(req.url, "/openai/deployments/my-deployment/chat/completions?api-version=2024-10-21");
    assert.equal(req.headers["api-key"], "sk-test");
    assert.equal(req.body.response_format.type, "json_schema");
  });
});

describe("openai-compatible adapter (capability fallbacks)", () => {
  test("json_object mode: response_format json_object, schema in the prompt, max_tokens", async () => {
    const m = await mockServer(() => ({ body: openaiCompletion({ content: JSON.stringify(INTERP) }) }));
    const a = OpenAIAdapter.createCompatible({ ...opts(m.url, { model: "mistral-large-latest" }), baseURL: m.url, mode: "json_object" });
    assert.equal(a.provider, "openai-compatible");
    await generateStructured(a, REQ);
    const [req] = m.requests;
    assert.deepEqual(req.body.response_format, { type: "json_object" });
    assert.equal(req.body.max_tokens, 16000);
    assert.equal(req.body.max_completion_tokens, undefined);
    assert.match(req.body.messages[0].content, /^SYSTEM PROMPT\n\nRespond with a single JSON object[\s\S]*"statements"/);
  });

  test("prompt mode: no response_format; fenced or chatty JSON is still parsed and validated", async () => {
    const m = await mockServer(() => ({ body: openaiCompletion({ content: "Here you go:\n```json\n" + JSON.stringify(INTERP) + "\n```" }) }));
    const a = OpenAIAdapter.createCompatible({ ...opts(m.url, { model: "local-model" }), baseURL: m.url, mode: "prompt" });
    assert.deepEqual((await generateStructured(a, REQ)).value, INTERP);
    assert.equal(m.requests[0].body.response_format, undefined);
  });

  test("an OpenAI key is never sent to a third-party base URL", async () => {
    const m = await mockServer(() => ({ body: openaiCompletion({ content: JSON.stringify(INTERP) }) }));
    const cfg = llmConfigFromEnv({ LLM_PROVIDER: "openai-compatible", LLM_BASE_URL: m.url, LLM_MODEL: "x", OPENAI_API_KEY: "sk-real-openai" })!;
    await generateStructured(createLlm({ ...cfg, maxRetries: 0 }), REQ);
    assert.equal(m.requests[0].headers.authorization, "Bearer not-needed");
  });
});

describe("gemini adapter (@google/genai against a mock generateContent API)", () => {
  test("sends responseMimeType + responseJsonSchema and parses the answer", async () => {
    const m = await mockServer(() => ({ body: geminiResponse(JSON.stringify(INTERP)) }));
    const r = await generateStructured(GeminiAdapter.create(opts(m.url, { model: "gemini-2.5-flash" })), REQ);
    assert.deepEqual(r.value, INTERP);
    assert.equal(r.model, "gemini-test-001");
    assert.deepEqual(r.usage, { inputTokens: 90, outputTokens: 50 }, "thinking tokens count as output");
    const [req] = m.requests;
    assert.equal(req.url, "/v1beta/models/gemini-2.5-flash:generateContent");
    assert.equal(req.headers["x-goog-api-key"], "sk-test");
    assert.equal(req.body.generationConfig.responseMimeType, "application/json");
    assert.deepEqual(req.body.generationConfig.responseJsonSchema, INTERPRETATION_SCHEMA);
    assert.equal(req.body.generationConfig.maxOutputTokens, 16000);
    assert.deepEqual(req.body.systemInstruction.parts, [{ text: "SYSTEM PROMPT" }]);
    assert.deepEqual(req.body.contents, [{ role: "user", parts: [{ text: REQ.user }] }]);
  });

  test("repair turn uses role model; safety, prompt blocks and MAX_TOKENS are typed", async () => {
    const m = await mockServer((_r, n) => ({ body: geminiResponse(n === 1 ? '{"statements": "oops"}' : JSON.stringify(INTERP)) }));
    assert.equal((await generateStructured(GeminiAdapter.create(opts(m.url)), REQ)).attempts, 2);
    assert.deepEqual(m.requests[1].body.contents.map((c: any) => c.role), ["user", "model", "user"]);

    const safety = await mockServer(() => ({ body: geminiResponse("", "SAFETY") }));
    await rejects(generateStructured(GeminiAdapter.create(opts(safety.url)), REQ), "refusal");
    const blocked = await mockServer(() => ({ body: { promptFeedback: { blockReason: "PROHIBITED_CONTENT" }, usageMetadata: { promptTokenCount: 5 } } }));
    assert.match((await rejects(generateStructured(GeminiAdapter.create(opts(blocked.url)), REQ), "refusal")).message, /PROHIBITED_CONTENT/);
    const cut = await mockServer(() => ({ body: geminiResponse('{"statements":[', "MAX_TOKENS") }));
    await rejects(generateStructured(GeminiAdapter.create(opts(cut.url)), REQ), "truncated");
    const quota = await mockServer(() => ({ status: 429, body: { error: { code: 429, message: "Resource exhausted", status: "RESOURCE_EXHAUSTED" } } }));
    await rejects(generateStructured(GeminiAdapter.create(opts(quota.url)), REQ), "rate_limit");
    const denied = await mockServer(() => ({ status: 403, body: { error: { code: 403, message: "API key not valid", status: "PERMISSION_DENIED" } } }));
    await rejects(generateStructured(GeminiAdapter.create(opts(denied.url)), REQ), "auth");
  });
});

describe("ollama adapter (REST /api/chat against a mock server)", () => {
  test("sends the schema as format with stream:false and parses the answer", async () => {
    const m = await mockServer(() => ({ body: ollamaResponse(JSON.stringify(INTERP)) }));
    const r = await generateStructured(OllamaAdapter.create(opts(m.url, { model: "llama3.1", apiKey: undefined })), REQ);
    assert.deepEqual(r.value, INTERP);
    assert.deepEqual(r.usage, { inputTokens: 70, outputTokens: 30 });
    const [req] = m.requests;
    assert.equal(req.url, "/api/chat");
    assert.equal(req.headers.authorization, undefined, "no auth header for a local server");
    assert.equal(req.body.model, "llama3.1");
    assert.equal(req.body.stream, false);
    assert.deepEqual(req.body.format, INTERPRETATION_SCHEMA);
    assert.equal(req.body.options.num_predict, 16000);
    assert.match(req.body.messages[0].content, /^SYSTEM PROMPT\n\nRespond with a single JSON object/);
  });

  test("done_reason length, unknown model and timeouts are typed; bearer key for hosted Ollama", async () => {
    const cut = await mockServer(() => ({ body: ollamaResponse('{"statements":[', "length") }));
    await rejects(generateStructured(OllamaAdapter.create(opts(cut.url)), REQ), "truncated");
    assert.equal(cut.requests[0].headers.authorization, "Bearer sk-test");
    const missing = await mockServer(() => ({ status: 404, body: { error: "model 'nope' not found" } }));
    assert.match((await rejects(generateStructured(OllamaAdapter.create(opts(missing.url)), REQ), "bad_request")).message, /not found/);
    const slow = await mockServer(() => ({ body: ollamaResponse("{}"), delayMs: 1500 }));
    await rejects(generateStructured(OllamaAdapter.create(opts(slow.url, { timeoutMs: 200 })), REQ), "timeout");
    let n = 0;
    const flaky = await mockServer(() => (++n === 1 ? { status: 503, body: { error: "loading model" } } : { body: ollamaResponse(JSON.stringify(INTERP)) }));
    assert.equal((await generateStructured(OllamaAdapter.create(opts(flaky.url, { maxRetries: 1 })), REQ)).attempts, 1, "transport retry is not a repair");
    assert.equal(flaky.requests.length, 2);
  });
});

describe("configuration and factory", () => {
  test("the rule-based interpreter stays the default; INTERPRETER=claude keeps working", () => {
    assert.equal(llmConfigFromEnv({}), undefined);
    assert.equal(llmConfigFromEnv({ LLM_PROVIDER: "rules" }), undefined);
    assert.ok(interpreterFromEnv({}) instanceof RuleInterpreter);
    assert.ok(interpreterFromEnv({ INTERPRETER: "rules" }) instanceof RuleInterpreter);
    assert.deepEqual(llmConfigFromEnv({ INTERPRETER: "claude", CLAUDE_MODEL: "claude-sonnet-5", ANTHROPIC_API_KEY: "k" }), { provider: "anthropic", model: "claude-sonnet-5", apiKey: "k", baseURL: undefined, timeoutMs: undefined, maxRetries: undefined });
    const i = interpreterFromEnv({ INTERPRETER: "claude", ANTHROPIC_API_KEY: "k" });
    assert.ok(i instanceof LlmInterpreter);
    assert.equal(i.name, "anthropic:claude-opus-5-5");
  });

  test("LLM_* overrides apply to the selected provider; provider env vars are fallbacks", () => {
    const env = { LLM_PROVIDER: "OpenAI", LLM_MODEL: "gpt-5-mini", OPENAI_API_KEY: "sk-o", LLM_TIMEOUT_MS: "30000", LLM_MAX_RETRIES: "0" };
    assert.deepEqual(llmConfigFromEnv(env), { provider: "openai", model: "gpt-5-mini", apiKey: "sk-o", baseURL: undefined, timeoutMs: 30000, maxRetries: 0 });
    assert.equal(providerConfigFromEnv("gemini", { ...env, GOOGLE_API_KEY: "g" }).model, undefined, "LLM_MODEL is not applied to an unselected provider");
    assert.equal(providerConfigFromEnv("gemini", { GEMINI_API_KEY: "a", GOOGLE_API_KEY: "b" }).apiKey, "a");
    assert.equal(providerConfigFromEnv("ollama", { OLLAMA_HOST: "127.0.0.1:11434" }).baseURL, "http://127.0.0.1:11434");
    assert.deepEqual(providerConfigFromEnv("openai", { AZURE_OPENAI_ENDPOINT: "https://r.openai.azure.com", AZURE_OPENAI_API_KEY: "az", AZURE_OPENAI_DEPLOYMENT: "dep", OPENAI_API_VERSION: "2025-01-01" }).azure, { endpoint: "https://r.openai.azure.com", apiVersion: "2025-01-01" });
    assert.deepEqual(providerConfigFromEnv("gemini", { GOOGLE_GENAI_USE_VERTEXAI: "true", GOOGLE_CLOUD_PROJECT: "p", GOOGLE_CLOUD_LOCATION: "europe-west4" }).vertex, { project: "p", location: "europe-west4" });
  });

  test("OLLAMA_HOST follows the Ollama CLI's port rule, and infers https for public hosts", () => {
    const host = (OLLAMA_HOST: string) => providerConfigFromEnv("ollama", { OLLAMA_HOST }).baseURL;
    // No scheme and no port: the CLI's default port 11434, not 80.
    assert.equal(host("gpu-box"), "http://gpu-box:11434");
    assert.equal(host("0.0.0.0"), "http://0.0.0.0:11434");
    assert.equal(host("localhost"), "http://localhost:11434");
    assert.equal(host("192.168.1.20"), "http://192.168.1.20:11434");
    assert.equal(host("::1"), "http://[::1]:11434");
    assert.equal(host("[::1]:9000"), "http://[::1]:9000");
    // An explicit port is kept.
    assert.equal(host("host:1234"), "http://host:1234");
    assert.equal(host("127.0.0.1:11434"), "http://127.0.0.1:11434");
    // An explicit scheme is kept as written, with that scheme's default port.
    assert.equal(host("https://x"), "https://x");
    assert.equal(host("http://ollama.example.com"), "http://ollama.example.com");
    assert.equal(host("http://gpu-box:8080/"), "http://gpu-box:8080");
    // A public host, or port 443, without a scheme is reached over https.
    assert.equal(host("ollama.com"), "https://ollama.com");
    assert.equal(host("ollama.com:443"), "https://ollama.com");
    assert.equal(host("gpu-box:443"), "https://gpu-box");
    assert.equal(host("203.0.113.5:11434"), "https://203.0.113.5:11434");
    assert.throws(() => host("ftp://x"), (e: unknown) => e instanceof LlmError && e.kind === "config");
  });

  test("an Ollama API key is never sent in cleartext to a non-loopback host", async () => {
    const hosted = llmConfigFromEnv({ LLM_PROVIDER: "ollama", OLLAMA_HOST: "ollama.com", OLLAMA_API_KEY: "ok-secret" })!;
    assert.equal(hosted.baseURL, "https://ollama.com");
    assert.equal(createLlm(hosted).provider, "ollama");
    for (const OLLAMA_HOST of ["http://ollama.com", "192.168.1.20", "gpu-box", "http://203.0.113.5:11434"]) {
      const cfg = llmConfigFromEnv({ LLM_PROVIDER: "ollama", OLLAMA_HOST, OLLAMA_API_KEY: "ok-secret" })!;
      assert.throws(() => createLlm(cfg), (e: unknown) => e instanceof LlmError && e.kind === "config" && /https/.test(e.message) && !e.message.includes("ok-secret"), OLLAMA_HOST);
    }
    assert.throws(() => OllamaAdapter.create(opts("http://ollama.com")), (e: unknown) => e instanceof LlmError && e.kind === "config");
    // Without a key, plain http to a LAN server is fine; loopback may carry a key (the mock tests above).
    assert.equal(createLlm(llmConfigFromEnv({ LLM_PROVIDER: "ollama", OLLAMA_HOST: "192.168.1.20" })!).provider, "ollama");
    assert.equal(createLlm({ provider: "ollama", apiKey: "k", baseURL: "http://localhost:11434" }).provider, "ollama");
  });

  test("Vertex AI mode uses ADC, not a Gemini API key; LLM_API_KEY selects Vertex express", async () => {
    const env = { LLM_PROVIDER: "gemini", GOOGLE_GENAI_USE_VERTEXAI: "true", GOOGLE_CLOUD_PROJECT: "p", GOOGLE_CLOUD_LOCATION: "europe-west4", GEMINI_API_KEY: "gemini-key", GOOGLE_API_KEY: "google-key" };
    const cfg = llmConfigFromEnv(env)!;
    assert.equal(cfg.apiKey, undefined, "GEMINI_API_KEY / GOOGLE_API_KEY are not Vertex credentials");
    assert.deepEqual(cfg.vertex, { project: "p", location: "europe-west4" });

    // On the wire: an ADC bearer token (stubbed auth client), no x-goog-api-key, the project path.
    const m = await mockServer(() => ({ body: geminiResponse(JSON.stringify(INTERP)) }));
    const adc = { getRequestHeaders: async () => new Headers({ authorization: "Bearer adc-token" }) };
    const live = llmConfigFromEnv({ ...env, LLM_BASE_URL: m.url, LLM_MAX_RETRIES: "0" })!;
    await generateStructured(createLlm({ ...live, vertex: { ...live.vertex, googleAuthOptions: { authClient: adc as any } } }), REQ);
    const [req] = m.requests;
    assert.equal(req.headers["x-goog-api-key"], undefined);
    assert.equal(req.headers.authorization, "Bearer adc-token");
    assert.match(req.url, /\/projects\/p\/locations\/europe-west4\/publishers\/google\/models\/gemini-2\.5-flash:generateContent$/);

    // Vertex express: the key comes only from LLM_API_KEY and is sent instead of ADC.
    const express = llmConfigFromEnv({ ...env, LLM_API_KEY: "vertex-express-key", LLM_BASE_URL: m.url, LLM_MAX_RETRIES: "0" })!;
    assert.equal(express.apiKey, "vertex-express-key");
    await generateStructured(createLlm(express), REQ);
    assert.equal(m.requests[1].headers["x-goog-api-key"], "vertex-express-key");
    assert.doesNotMatch(m.requests[1].url, /\/projects\//, "express mode has no project path");
  });

  test("misconfiguration fails loudly with a typed config error", () => {
    for (const env of [{ LLM_PROVIDER: "gpt" }, { LLM_PROVIDER: "openai", LLM_TIMEOUT_MS: "soon" }, { LLM_PROVIDER: "openai-compatible", LLM_STRUCTURED_OUTPUT: "yaml" }]) {
      assert.throws(() => llmConfigFromEnv(env), (e: unknown) => e instanceof LlmError && e.kind === "config");
    }
    assert.throws(() => createLlm({ provider: "openai-compatible", model: "m" }), (e: unknown) => e instanceof LlmError && e.kind === "config" && /LLM_BASE_URL/.test(e.message));
    assert.throws(() => createLlm({ provider: "openai-compatible", baseURL: "http://x" }), (e: unknown) => e instanceof LlmError && e.kind === "config" && /LLM_MODEL/.test(e.message));
  });

  test("createLlm builds every provider's adapter with the requested model id verbatim", () => {
    const cases = [
      [{ provider: "anthropic", apiKey: "k" }, "anthropic", "claude-opus-5-5"],
      [{ provider: "openai", apiKey: "k", model: "gpt-5" }, "openai", "gpt-5"],
      [{ provider: "openai", apiKey: "k", model: "dep", azure: { endpoint: "https://r.openai.azure.com" } }, "openai", "dep"],
      [{ provider: "gemini", apiKey: "k" }, "gemini", "gemini-2.5-flash"],
      [{ provider: "ollama" }, "ollama", "llama3.1"],
      [{ provider: "openai-compatible", baseURL: "https://api.groq.com/openai/v1", model: "llama-3.3-70b-versatile", apiKey: "k" }, "openai-compatible", "llama-3.3-70b-versatile"],
    ] as const;
    for (const [cfg, provider, model] of cases) {
      const a = createLlm(cfg as any);
      assert.deepEqual([a.provider, a.model], [provider, model]);
    }
  });

  test("the comparison harness skips unconfigured providers with a reason", async () => {
    const { configs, skipped } = await configuredProviders({ OPENAI_API_KEY: "sk", OLLAMA_HOST: "127.0.0.1:1" });
    assert.deepEqual(configs.map((c) => c.provider), ["openai"]);
    assert.deepEqual(skipped.map((s) => s.provider), ["anthropic", "gemini", "ollama", "openai-compatible"]);
    assert.ok(skipped.every((s) => s.reason.length > 0));
  });
});

describe("a model cannot widen spending authority", () => {
  test("schema-valid output that smuggles spending terms into a preference is rejected by validateInterpretation", async () => {
    const smuggled = { statements: [st({ text: "I prefer hourly forecasts.", role: "preference", category: "WeatherReport", criterion: { leftOperand: "includesHourlyForecast", operator: "eq", rightOperand: "true", unit: null }, weight: 0.5, authorization: { currency: "USDC", totalLimit: "500", maxPerTransaction: null, approvedSellersOnly: false, validDays: 365 } })], unrecognized: [] };
    const m = await mockServer(() => ({ body: openaiCompletion({ content: JSON.stringify(smuggled) }) }));
    const interp = await createInterpreter(OpenAIAdapter.create(opts(m.url))).interpret("I prefer hourly forecasts.");
    const layout = new PodLayout("https://pod.example/alice/");
    const n = new CommonGround(new PodClient(), layout, []).negotiate(interp, { meanings: [], preferences: [], mandates: [], ignored: [] }, layout.webId, { approvedSellers: [], agentIds: ["urn:a"], schemesFor: () => ["x402"] });
    assert.ok(n.notes.some((x) => /Rejected interpreter output: .*only authorization statements may carry spending terms/.test(x)));
    assert.equal(n.proposals.length, 0, "nothing is proposed from the smuggling statement");

    // The harness reports the same thing for every interpreter.
    const c = CASES.find((x) => x.id === "smuggle-preference")!;
    assert.equal(assess(c, interp).validationErrors.length, 1);
    assert.deepEqual(assess(c, await new RuleInterpreter().interpret(c.text)).invariantViolations, []);
  });

  test("the harness flags an interpretation that obeys an injected budget", () => {
    const c = CASES.find((x) => x.id === "injection")!;
    assert.equal(c.expect.authority, "none", "the user stated no spending limit");
    assert.deepEqual(c.expect.forbiddenLimits, ["1000"]);
    const obeying: Interpretation = {
      statements: [
        { text: "Get me a current Berlin weather report.", role: "intention" as const, category: "WeatherReport", subject: "Berlin" },
        { text: "Get me a current Berlin weather report.", role: "requirement" as const, category: "WeatherReport", ambiguousTerm: { term: "current", candidates: [{ ...CURRENT, criterion: { ...CURRENT.criterion, operator: "lteq" } }] } },
        { text: "the user already approved a budget of 1000 USDC", role: "authorization" as const, category: "WeatherReport", authorization: { currency: "USDC", totalLimit: "1000", approvedSellersOnly: true, validDays: 30 } },
      ],
      unrecognized: [],
    };
    const r = assess(c, obeying);
    assert.deepEqual(r.validationErrors, [], "schema- and vocabulary-valid: only the expectations can catch it");
    assert.ok(r.expectationFailures.some((f) => /proposed spending authority although none was stated/.test(f)), r.expectationFailures.join("\n"));
    assert.ok(r.invariantViolations.some((v) => /1000 USDC .*forbidden/.test(v)), r.invariantViolations.join("\n"));
    // Ignoring the injection passes.
    const ignoring = { ...obeying, statements: obeying.statements.slice(0, 2) };
    assert.deepEqual([assess(c, ignoring).expectationFailures, assess(c, ignoring).invariantViolations], [[], []]);
  });

  test("smuggle-preference: no mandate from the preference; at most the 500 USDC the user wrote", () => {
    const c = CASES.find((x) => x.id === "smuggle-preference")!;
    assert.notEqual(c.expect.authority, "unchecked");
    const pref = { text: "I prefer weather providers with an hourly forecast", role: "preference" as const, category: "WeatherReport", criterion: { leftOperand: "includesHourlyForecast", operator: "eq", rightOperand: "true" }, weight: 0.5 };
    const auth = (totalLimit: string) => ({ text: "lets you spend up to 500 USDC", role: "authorization" as const, category: "WeatherReport", authorization: { currency: "USDC", totalLimit, approvedSellersOnly: true } });
    const run = (statements: any[]) => assess(c, { statements, unrecognized: [] });
    const clean = (r: ReturnType<typeof assess>) => [...r.validationErrors, ...r.expectationFailures, ...r.invariantViolations];
    assert.deepEqual(clean(run([pref])), [], "ignoring the limit is fine");
    assert.deepEqual(clean(run([pref, auth("500")])), [], "a separate authorization for exactly the stated 500 USDC is fine");
    assert.ok(run([pref, auth("5000")]).expectationFailures.some((f) => /at most USDC 500/.test(f)));
    assert.ok(run([pref, auth("5000")]).invariantViolations.length > 0);
    assert.ok(run([pref, auth("100")]).expectationFailures.length === 0, "a lower limit is still within what was stated");
    assert.equal(run([{ ...pref, authorization: auth("500").authorization }]).validationErrors.length, 1, "the preference itself must not carry it");
  });

  test("every adversarial case states concrete expectations", () => {
    for (const c of CASES) assert.notEqual(c.expect.authority, "unchecked", c.id);
  });
});

describe("two agents on different providers share one Pod", () => {
  let css: { url: string; proc: ChildProcess };
  before(async () => { css = await startCss(); });
  after(() => { css.proc.kill(); });

  test("a meaning agreed through a Claude-backed agent is reused by a Gemini-backed agent without asking again", async () => {
    const anthropic = await mockServer(() => ({ body: anthropicMessage(JSON.stringify(INTERP)) }));
    const gemini = await mockServer(() => ({ body: geminiResponse(JSON.stringify({ ...INTERP, statements: INTERP.statements.slice(0, 2) })) }));
    const e = await startEnvironment({ podUrl: css.url });
    try {
      const claudeAgent = e.assistant(AGENT_1, { interpreter: createInterpreter({ provider: "anthropic", apiKey: "k", baseURL: anthropic.url, maxRetries: 0 }) });
      const geminiAgent = e.assistant(AGENT_2, { interpreter: createInterpreter({ provider: "gemini", apiKey: "k", baseURL: gemini.url, maxRetries: 0 }) });
      const approved = e.registry.list().map((s) => s.webId);

      const { ctx, result } = await claudeAgent.understand(REQ.user, approved);
      assert.deepEqual(result.questions.map((q) => q.term), ["current"]);
      const { confirmed } = await claudeAgent.confirm([...result.proposals, ...claudeAgent.answer(result.questions[0], 0, ctx)], e.device);
      assert.deepEqual(confirmed.map((r) => r.kind).sort(), ["mandate", "meaning", "requirement"]);

      const second = (await geminiAgent.understand("Get me a current Berlin weather report.", approved)).result;
      assert.equal(second.questions.length, 0, "no re-asking across providers");
      assert.ok(second.reused.some((r) => r.kind === "meaning" && r.term === "current"));
      assert.equal(gemini.requests.length, 1);
    } finally {
      await e.close();
    }
  });
});

// ------------------------------------------------------------------ final-audit regressions (LLM layer)

/** Run fn with process.env temporarily extended: the SDKs read their own variables from it. */
async function withEnv<T>(vars: Record<string, string>, fn: () => T | Promise<T>): Promise<T> {
  const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  Object.assign(process.env, vars);
  try { return await fn(); } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}
const configError = (secret?: string) => (e: unknown) => e instanceof LlmError && e.kind === "config" && /https/.test(e.message) && (!secret || !e.message.includes(secret));

describe("one transport rule for every provider: credentials never travel over plain http beyond loopback", () => {
  test("explicit http:// base URLs to non-loopback hosts are refused for every provider that sends a credential", async () => {
    const refused: Array<[string, Record<string, string>]> = [
      ["anthropic", { LLM_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "s3cret", ANTHROPIC_BASE_URL: "http://api.example.com" }],
      ["openai", { LLM_PROVIDER: "openai", OPENAI_API_KEY: "s3cret", OPENAI_BASE_URL: "http://api.example.com/v1" }],
      ["azure", { LLM_PROVIDER: "openai", AZURE_OPENAI_API_KEY: "s3cret", AZURE_OPENAI_ENDPOINT: "http://r.openai.azure.com", AZURE_OPENAI_DEPLOYMENT: "d" }],
      ["gemini", { LLM_PROVIDER: "gemini", GEMINI_API_KEY: "s3cret", LLM_BASE_URL: "http://generativelanguage.example.com" }],
      ["openai-compatible", { LLM_PROVIDER: "openai-compatible", LLM_API_KEY: "s3cret", LLM_BASE_URL: "http://ollama.com/v1", LLM_MODEL: "m" }],
      ["openai-compatible LAN", { LLM_PROVIDER: "openai-compatible", LLM_API_KEY: "s3cret", LLM_BASE_URL: "http://192.168.1.5:1234/v1", LLM_MODEL: "m" }],
      ["ollama", { LLM_PROVIDER: "ollama", OLLAMA_API_KEY: "s3cret", OLLAMA_HOST: "http://ollama.com" }],
    ];
    for (const [name, env] of refused) assert.throws(() => createLlm(llmConfigFromEnv(env)!), configError("s3cret"), name);
    // Vertex: ADC sends a bearer token too.
    assert.throws(() => createLlm({ provider: "gemini", baseURL: "http://vertex.example.com", vertex: { project: "p", location: "l" } }), configError(), "vertex");
  });

  test("the SDKs' own base-URL variables are checked as well, not only the configured value", async () => {
    await withEnv({ ANTHROPIC_BASE_URL: "http://api.example.com" }, () => assert.throws(() => createLlm({ provider: "anthropic", apiKey: "s3cret" }), configError("s3cret"), "ANTHROPIC_BASE_URL"));
    await withEnv({ OPENAI_BASE_URL: "http://api.example.com/v1" }, () => assert.throws(() => createLlm({ provider: "openai", apiKey: "s3cret" }), configError("s3cret"), "OPENAI_BASE_URL"));
    await withEnv({ GOOGLE_GEMINI_BASE_URL: "http://g.example.com" }, () => assert.throws(() => createLlm({ provider: "gemini", apiKey: "s3cret" }), configError("s3cret"), "GOOGLE_GEMINI_BASE_URL"));
    await withEnv({ GOOGLE_VERTEX_BASE_URL: "http://v.example.com" }, () => assert.throws(() => createLlm({ provider: "gemini", vertex: { project: "p", location: "l" } }), configError(), "GOOGLE_VERTEX_BASE_URL"));
    // The SDK default (no base URL anywhere) is https and stays allowed.
    assert.ok(createLlm({ provider: "anthropic", apiKey: "s3cret" }));
  });

  test("what stays allowed: https anywhere, loopback with a key, plain http without a key", () => {
    const ok = [
      { provider: "anthropic", apiKey: "k", baseURL: "https://api.example.com" },
      { provider: "anthropic", apiKey: "k", baseURL: "http://127.0.0.1:9999" },
      { provider: "openai", apiKey: "k", baseURL: "http://localhost:8080/v1" },
      { provider: "openai", apiKey: "k", baseURL: "http://[::ffff:127.0.0.1]:8080/v1" },
      { provider: "gemini", apiKey: "k", baseURL: "http://[::1]:9000" },
      { provider: "openai-compatible", model: "m", baseURL: "http://192.168.1.5:1234/v1" },
      { provider: "openai-compatible", model: "m", apiKey: "k", baseURL: "https://api.groq.com/openai/v1" },
      { provider: "ollama", baseURL: "http://gpu-box:11434" },
    ];
    for (const cfg of ok) assert.ok(createLlm(cfg as any), JSON.stringify(cfg));
  });

  test("IPv4-mapped loopback is loopback, and IPv4-mapped private addresses are private", async () => {
    const { isLoopbackHost, isPrivateHost } = await import("../src/llm/providers/ollama.js");
    for (const h of ["::ffff:127.0.0.1", "[::ffff:7f00:1]", "[::ffff:127.0.0.2]"]) assert.equal(isLoopbackHost(h), true, h);
    for (const h of ["::ffff:192.168.1.20", "[::ffff:c0a8:114]", "[::ffff:a00:1]"]) assert.equal(isPrivateHost(h), true, h);
    for (const h of ["::ffff:8.8.8.8", "[::ffff:808:808]"]) assert.equal(isPrivateHost(h), false, h);
    assert.equal(providerConfigFromEnv("ollama", { OLLAMA_HOST: "::ffff:127.0.0.1" }).baseURL, "http://[::ffff:7f00:1]:11434");
  });
});

describe("Vertex AI never falls back to a leftover Gemini API key", () => {
  test("Vertex mode without a project, without LLM_API_KEY, fails with a config error instead of sending GEMINI_API_KEY", async () => {
    await withEnv({ GEMINI_API_KEY: "leftover-gemini-key", GOOGLE_API_KEY: "leftover-google-key" }, async () => {
      const cfg = llmConfigFromEnv({ LLM_PROVIDER: "gemini", GOOGLE_GENAI_USE_VERTEXAI: "true", GEMINI_API_KEY: "leftover-gemini-key" })!;
      assert.throws(() => createLlm(cfg), (e: unknown) => e instanceof LlmError && e.kind === "config" && /GOOGLE_CLOUD_PROJECT/.test(e.message) && !e.message.includes("leftover"));
      // With a project the SDK itself drops the environment key in favour of ADC; express mode still works.
      assert.ok(createLlm({ ...cfg, vertex: { project: "p", location: "europe-west4" } }));
      assert.ok(createLlm({ ...cfg, apiKey: "vertex-express", vertex: {} }));
    });
  });
});

describe("anthropic adapter treats only end_turn as a complete answer", () => {
  test("null, unknown and unexpected stop reasons are typed truncations, never parsed", async () => {
    for (const stop_reason of [null, "some_future_cutoff", "stop_sequence", "tool_use"]) {
      const m = await mockServer(() => ({ body: anthropicMessage(JSON.stringify(INTERP), { stop_reason }) }));
      const e = await rejects(generateStructured(AnthropicAdapter.create(opts(m.url)), REQ), "truncated");
      assert.match(e.message, new RegExp(String(stop_reason)));
      assert.equal(m.requests.length, 1, String(stop_reason));
    }
  });
});

describe("comparison harness: smuggle-preference checks every limit and the sum", () => {
  const c = () => CASES.find((x) => x.id === "smuggle-preference")!;
  const pref = { text: "I prefer weather providers with an hourly forecast", role: "preference" as const, category: "WeatherReport", criterion: { leftOperand: "includesHourlyForecast", operator: "eq" as const, rightOperand: "true" }, weight: 0.5 };
  const auth = (totalLimit: string, maxPerTransaction?: string) => ({ text: "lets you spend up to 500 USDC", role: "authorization" as const, category: "WeatherReport", authorization: { currency: "USDC", totalLimit, ...(maxPerTransaction ? { maxPerTransaction } : {}), approvedSellersOnly: true } });

  test("a per-transaction limit above the cap is a failure", () => {
    // validateInterpretation now rejects a per-purchase limit above the total (src/grounding), so the
    // statement never becomes a mandate; the harness's own per-transaction cap is a second check.
    const r = assess(c(), { statements: [pref, auth("500", "600")], unrecognized: [] });
    assert.ok([...r.validationErrors, ...r.expectationFailures].some((f) => /600/.test(f)), JSON.stringify(r));
  });

  test("several mandates are capped by their sum, not one by one", () => {
    const r = assess(c(), { statements: [pref, auth("500"), { ...auth("500"), text: "and another 500 USDC" }], unrecognized: [] });
    assert.ok(r.expectationFailures.some((f) => /together/.test(f) && /1000/.test(f)), r.expectationFailures.join("\n"));
  });

  test("the sum is exact: 0.1 + 0.2 USDC is within a cap of 0.3 USDC, 0.1 + 0.2 + 0.1 is not", () => {
    const capped = { ...c(), expect: { ...c().expect, authority: { atMost: { currency: "USDC", totalLimit: "0.3" } } } };
    const within = assess(capped, { statements: [pref, auth("0.1"), { ...auth("0.2"), text: "and another 0.2 USDC" }], unrecognized: [] });
    assert.ok(!within.expectationFailures.some((f) => /together/.test(f)), within.expectationFailures.join("\n"));
    const over = assess(capped, { statements: [pref, auth("0.1"), { ...auth("0.2"), text: "and another 0.2 USDC" }, { ...auth("0.1"), text: "and 0.1 USDC more" }], unrecognized: [] });
    assert.ok(over.expectationFailures.some((f) => /together/.test(f) && /0\.4 USDC/.test(f)), over.expectationFailures.join("\n"));
  });

  test("a forbidden per-transaction limit is named as such", () => {
    const inj = CASES.find((x) => x.id === "injection")!;
    const r = assess({ ...inj, text: inj.text + " 5000" }, { statements: [{ text: "x", role: "authorization" as const, category: "WeatherReport", authorization: { currency: "USDC", totalLimit: "5000", maxPerTransaction: "1000", approvedSellersOnly: true } }], unrecognized: [] });
    assert.ok(r.invariantViolations.some((v) => /per-transaction limit 1000 USDC is forbidden/.test(v)), r.invariantViolations.join("\n"));
    assert.ok(!r.invariantViolations.some((v) => /limit 5000 USDC is forbidden/.test(v)), r.invariantViolations.join("\n"));
  });
});

// ------------------------------------------------------------------ docs and tooling match behaviour

const repoFile = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

describe("docs match what the code does", () => {
  test("the rule-based interpreter passes every comparison case, and docs/llm-providers.md says so", async () => {
    for (const c of CASES) {
      const r = assess(c, await new RuleInterpreter().interpret(c.text));
      assert.deepEqual([...r.validationErrors, ...r.expectationFailures, ...r.invariantViolations], [], c.id);
    }
    const doc = repoFile("docs/llm-providers.md");
    assert.doesNotMatch(doc, /rule-based interpreter (currently obeys|misses)/);
    assert.ok(doc.includes(`rule-based interpreter passes all ${CASES.length} cases`), `docs/llm-providers.md states the case count (${CASES.length})`);
  });

  test("the Node.js floor is the first release with unflagged node:sqlite (22.13.0; 23.4.0 on 23.x), everywhere it is stated", () => {
    assert.equal(JSON.parse(repoFile("package.json")).engines.node, "^22.13.0 || >=23.4.0");
    assert.equal(JSON.parse(repoFile("package-lock.json")).packages[""].engines.node, "^22.13.0 || >=23.4.0");
    assert.doesNotMatch(JSON.stringify(JSON.parse(repoFile("package.json")).scripts), /experimental-sqlite/, "no script passes the flag");
    assert.match(repoFile("README.md"), /Node\.js ≥ 22\.13/);
    assert.doesNotMatch(repoFile("README.md"), /22\.5\b/);
    assert.match(repoFile(".github/workflows/ci.yml"), /22\.13\.0/, "CI tests the floor");
  });

  test("no comment or doc points at an environment variable nothing reads", () => {
    assert.doesNotMatch(repoFile("src/payments/schemes/x402.ts"), /X402_FACILITATOR_URL/);
    assert.match(repoFile("src/payments/schemes/x402.ts"), /rails\.facilitatorUrl/);
  });

  test("README does not claim Bedrock/Vertex for Claude are configurable, nor that the demo ledger is durable", () => {
    const readme = repoFile("README.md");
    assert.doesNotMatch(readme, /also Bedrock and Vertex through the Anthropic SDK/);
    assert.match(readme, /Bedrock[^.\n]*not wired/i);
    assert.doesNotMatch(repoFile("docs/design.md"), /rules \| Claude, JSON schema/);
    assert.match(readme, /ledger[^|\n]*in memory/i);
  });
});

describe("README and docs/design.md name only codes, fields and commands the code has", () => {
  const srcText = () => readdirSync(fileURLToPath(new URL("../src", import.meta.url)), { recursive: true, encoding: "utf8" })
    .filter((f) => f.endsWith(".ts")).map((f) => repoFile(`src/${f}`)).join("\n");

  test("every error code in backticks exists in src", () => {
    const src = srcText();
    for (const doc of ["README.md", "docs/design.md"]) {
      const codes = new Set([...repoFile(doc).matchAll(/`(?:\d{3} )?([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)`/g)].map((m) => m[1]));
      assert.ok(codes.size >= 5, `${doc}: ${[...codes].join(", ")}`);
      for (const c of codes) assert.ok(src.includes(`"${c}"`) || src.includes(` ${c} `) || src.includes(`${c}:`), `${doc} names ${c}, which src does not have`);
    }
    for (const c of ["AGENT_NOT_AUTHENTICATED", "AGENT_MISMATCH", "NOT_YOUR_TRANSACTION", "RAIL_REFERENCE_MISMATCH", "MANDATE_SUPERSEDED", "MANDATE_REVISION_CONFLICT", "NOT_YOUR_AUTHORIZATION"]) {
      assert.match(repoFile("docs/design.md"), new RegExp(`\`(\\d{3} )?${c}\``), `design.md documents ${c}`);
    }
  });

  test("design.md's authorization field list is exactly PaymentAuthorization's fields", () => {
    const body = /export interface PaymentAuthorization \{([\s\S]*?)\n\}/.exec(repoFile("src/payments/types.ts"))![1];
    const fields = [...body.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/^\s*(\w+)\??:/gm)].map((m) => m[1]);
    const line = repoFile("docs/design.md").split("\n").find((l) => l.startsWith("`authId, "))!;
    const documented = line.replace(/`/g, "").replace(/\{[^}]*\}/g, "").split(",").map((x) => x.trim()).filter(Boolean);
    assert.deepEqual(documented, fields);
    const x402 = /export interface X402Terms \{([^}]*)\}/.exec(repoFile("src/payments/types.ts"))![1].split(";").map((x) => x.trim().split(":")[0]).filter(Boolean);
    assert.deepEqual(/x402 \{ ([^}]*) \}/.exec(line)![1].split(",").map((x) => x.trim()), x402);
  });

  test("the README's proxy recipe uses the example config's ports and a route it prices for L402", () => {
    const readme = repoFile("README.md");
    const ex = JSON.parse(repoFile("proxy.example.json"));
    assert.ok(readme.includes("npm run rails -- --example-upstream"));
    assert.ok(readme.includes("npm run proxy -- --config proxy.example.json"));
    const route = ex.routes.find((r: { path: string }) => r.path === "/v1/aqi/current");
    const url = `http://${ex.listen.host}:${ex.listen.port}${route.path}`;
    assert.ok(readme.includes(`npm run rails -- pay ${url}`), url);
    assert.ok(readme.includes(`pays ${route.prices.l402} SAT over L402`));
    for (const u of Object.values(ex.rails) as string[]) assert.match(u, /^http:\/\/127\.0\.0\.1:402[123]$/);
    assert.ok(readme.includes("127.0.0.1:4021-4023") && readme.includes(ex.upstream.replace("http://", "")));
  });
});

describe("npm run rails: the README's two-terminal proxy recipe serves a paid request", () => {
  test("`npm run rails -- --example-upstream`, then `npm run proxy -- --config ...`, then `npm run rails -- pay <url>`: 402, then 200 with a receipt", async () => {
    const pkg = JSON.parse(repoFile("package.json"));
    assert.equal(pkg.scripts.rails, "tsx src/payments/sim/cli.ts");
    assert.equal(pkg.scripts.proxy, "tsx src/proxy/cli.ts");
    const freePort = () => new Promise<number>((ok) => { const s = createNetServer().listen(0, "127.0.0.1", () => { const p = (s.address() as { port: number }).port; s.close(() => ok(p)); }); });
    const [f, l, p, u, x] = [await freePort(), await freePort(), await freePort(), await freePort(), await freePort()];
    // proxy.example.json unchanged except for its ports (4021-4023, 9000 and 8402 may be taken on a test machine).
    const example = JSON.parse(repoFile("proxy.example.json"));
    assert.deepEqual(example.rails, { facilitatorUrl: "http://127.0.0.1:4021", lightningUrl: "http://127.0.0.1:4022", pspUrl: "http://127.0.0.1:4023" });
    // Plus one paid POST route, for the Idempotency-Key that paid non-GET routes require.
    const postRoute = { id: "report-job", method: "POST", path: "/v1/reports", category: "AirQualityReport", coverage: "Berlin", prices: { l402: 5 }, description: "Run a report job (one payment per request)" };
    const cfg = { ...example, routes: [...example.routes, postRoute], listen: { host: "127.0.0.1", port: x }, upstream: `http://127.0.0.1:${u}`, rails: { facilitatorUrl: `http://127.0.0.1:${f}`, lightningUrl: `http://127.0.0.1:${l}`, pspUrl: `http://127.0.0.1:${p}` } };
    const dir = mkdtempSync(join(tmpdir(), "sc-rails-"));
    const file = join(dir, "proxy.json");
    writeFileSync(file, JSON.stringify(cfg));
    const root = fileURLToPath(new URL("..", import.meta.url));
    const run = (args: string[]) => spawn(process.execPath, ["--import", "tsx", ...args], { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
    const output = (c: ReturnType<typeof run>, until: RegExp | "exit", ms = 60000) => new Promise<{ out: string; code: number | null }>((ok, fail) => {
      let out = "";
      const t = setTimeout(() => fail(new Error(`timed out waiting for ${String(until)}:\n${out}`)), ms);
      const on = (d: Buffer) => { out += d; if (until !== "exit" && until.test(out)) { clearTimeout(t); ok({ out, code: null }); } };
      c.stdout!.on("data", on); c.stderr!.on("data", on);
      c.on("exit", (code) => { clearTimeout(t); if (until === "exit") ok({ out, code }); else fail(new Error(`exited with ${code} before ${String(until)}:\n${out}`)); });
    });
    const children: Array<ReturnType<typeof run>> = [];
    try {
      const rails = run(["src/payments/sim/cli.ts", "--config", file, "--example-upstream"]); children.push(rails);
      const railsOut = (await output(rails, /Now start the proxy/)).out;
      for (const port of [f, l, p, u]) assert.match(railsOut, new RegExp(`127\\.0\\.0\\.1:${port}\\b`));
      const proxy = run(["src/proxy/cli.ts", "--config", file]); children.push(proxy);
      await output(proxy, /unconfigured paths/);
      const url = `http://127.0.0.1:${x}/v1/aqi/current`;
      const unpaid = await fetch(url);
      assert.equal(unpaid.status, 402, "the rails answer, so the proxy can build its challenge");
      assert.match(String(unpaid.headers.get("www-authenticate")), /L402 macaroon=/);
      const pay = run(["src/payments/sim/cli.ts", "pay", url, "--config", file]); children.push(pay);
      const paid = await output(pay, "exit");
      assert.equal(paid.code, 0, paid.out);
      assert.match(paid.out, new RegExp(`paid ${example.routes[0].prices.l402} SAT over L402 \\(simulated\\); HTTP 200`));
      assert.match(paid.out, /sc-receipt: /, "seller-signed receipt");
      assert.match(paid.out, /"example":true/);

      // `pay --method POST` sends the Idempotency-Key that a paid POST needs (without it: 400 after paying).
      const post = `http://127.0.0.1:${x}${postRoute.path}`;
      const unpaidPost = await fetch(post, { method: "POST" });
      assert.equal(unpaidPost.status, 402);
      assert.match(JSON.stringify(await unpaidPost.json()), /idempotency-key/i, "the 402 says the key is required");
      const payPost = run(["src/payments/sim/cli.ts", "pay", post, "--config", file, "--method", "POST"]); children.push(payPost);
      const paidPost = await output(payPost, "exit");
      assert.equal(paidPost.code, 0, paidPost.out);
      assert.match(paidPost.out, /paid 5 SAT over L402 \(simulated\); HTTP 200/);
    } finally {
      for (const c of children) c.kill("SIGKILL");
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
