# LLM providers

The interpreter that turns a shopper's request into a structured interpretation can run on any major LLM provider. The offline rule-based interpreter is still the default: without configuration nothing calls an LLM, and the demo and tests run offline.

| `LLM_PROVIDER` | Adapter | Native structured-output mode | Client |
|---|---|---|---|
| `rules` (default) | `RuleInterpreter` | n/a | none (offline) |
| `anthropic` | `src/llm/providers/anthropic.ts` | `output_config.format` = `json_schema` (constrained) | `@anthropic-ai/sdk` |
| `openai` | `src/llm/providers/openai.ts` | `response_format` = `json_schema`, `strict: true` (constrained) | `openai` SDK (also Azure OpenAI) |
| `gemini` | `src/llm/providers/gemini.ts` | `responseMimeType: application/json` + `responseJsonSchema` | `@google/genai` (also Vertex AI) |
| `ollama` | `src/llm/providers/ollama.ts` | `/api/chat` with `"format": <JSON schema>`, `stream: false` | plain `fetch` |
| `openai-compatible` | `src/llm/providers/openai.ts` | `json_schema`, `json_object` or prompt-only (`LLM_STRUCTURED_OUTPUT`) | `openai` SDK at a custom `baseURL` |

## A weaker model can misread, but cannot widen spending authority

Whatever a provider returns goes through the same pipeline as the rule-based interpreter:

1. **Local schema validation** (`src/llm/jsonSchema.ts`) of every answer, even from providers that constrain decoding. On invalid or non-JSON output the model gets exactly **one** repair attempt with the validation errors; then the call fails with `LlmError("invalid_output")`.
2. **Vocabulary validation** (`validateInterpretation`): unknown categories, properties, operators, units and currencies are rejected. Spending terms on anything but an `authorization` statement are rejected.
3. **Clarification**: ambiguous terms become questions with executable candidates instead of silent choices.
4. **User confirmation** on the approval device. The device shows a spending mandate separately, as FINANCIAL AUTHORITY, and signs it with the user's key.
5. **The gateway** accepts only signed mandates, and checks every payment against them.

A model only proposes. It cannot confirm a record, sign a mandate, authorise a payment or reach a key. A worse model gives worse proposals: wrong categories, missed ambiguities, or limits the user has to correct or reject. It cannot produce authority the user did not sign. `test/llm.test.ts` checks this: a schema-valid answer that attaches 500 USDC to a preference is rejected, and nothing gets proposed.

## Configuration

The variables are read by `src/llm/config.ts` (`llmConfigFromEnv`):

| Variable | Meaning |
|---|---|
| `LLM_PROVIDER` | `rules` \| `anthropic` \| `openai` \| `gemini` \| `ollama` \| `openai-compatible`. An unknown value is an error, not a silent fallback |
| `LLM_MODEL` | Model id, passed through verbatim (no date suffixes are added). For Azure, the deployment name |
| `LLM_BASE_URL` | Endpoint override |
| `LLM_API_KEY` | Key override |
| `LLM_TIMEOUT_MS` | Per-request timeout, default `120000`. A slow answer becomes `LlmError("timeout")` |
| `LLM_MAX_RETRIES` | Transport retries (429/5xx/connection), done by the SDK. Default `2`. Separate from the schema repair |
| `LLM_STRUCTURED_OUTPUT` | `openai-compatible` only: `json_schema` (default) \| `json_object` \| `prompt` |

`LLM_MODEL`, `LLM_BASE_URL` and `LLM_API_KEY` apply only to the provider that `LLM_PROVIDER` selects. Each provider's standard variables are fallbacks (see below).

**Backwards compatible:** `INTERPRETER=claude` (with optional `CLAUDE_MODEL`) still selects Anthropic when `LLM_PROVIDER` is unset.

Every output is capped at 16,000 tokens. A truncated answer is never parsed: it fails with `LlmError("truncated")`.

### Anthropic

```bash
export ANTHROPIC_API_KEY=sk-ant-...          # or an `ant auth login` profile
LLM_PROVIDER=anthropic npm run demo
LLM_PROVIDER=anthropic LLM_MODEL=claude-opus-5-5 npm run demo
INTERPRETER=claude CLAUDE_MODEL=claude-opus-5-5 npm run demo   # legacy form
```

- Default model: `claude-opus-5-5`. Fallback variables: `ANTHROPIC_API_KEY`, `ANTHROPIC_BASE_URL`, `CLAUDE_MODEL` / `ANTHROPIC_MODEL`.
- The request is the one the prototype has always sent: `client.beta.messages.create` with `betas: ["server-side-fallback-2026-07-01"]`, `fallbacks: "default"`, `output_config: { effort: "medium", format: { type: "json_schema", schema } }` and `max_tokens: 16000`. `stop_reason` `refusal` and `max_tokens` are checked before any content is read.
- **Bedrock / Vertex AI are not wired.** The Anthropic SDK has its own clients for them (`@anthropic-ai/bedrock-sdk`, `@anthropic-ai/vertex-sdk`) with the same `beta.messages.create` surface. Pass one to the adapter in code: `createInterpreter(new AnthropicAdapter("<model id>", new AnthropicBedrock()))`. That path is untested here.

### OpenAI and Azure OpenAI

```bash
export OPENAI_API_KEY=sk-...
LLM_PROVIDER=openai LLM_MODEL=gpt-5 npm run demo
```

```bash
# Azure OpenAI: selected whenever AZURE_OPENAI_ENDPOINT is set
export AZURE_OPENAI_ENDPOINT=https://my-resource.openai.azure.com
export AZURE_OPENAI_API_KEY=...
export AZURE_OPENAI_DEPLOYMENT=my-gpt-deployment     # or LLM_MODEL
export OPENAI_API_VERSION=2024-10-21                 # default; needs structured-output support
LLM_PROVIDER=openai npm run demo
```

- Default model: `gpt-5`, a placeholder. Set `LLM_MODEL` or `OPENAI_MODEL` to the model you want.
- Fallback variables: `OPENAI_API_KEY`, `OPENAI_BASE_URL`, `OPENAI_MODEL`. For Azure: `AZURE_OPENAI_ENDPOINT`, `AZURE_OPENAI_API_KEY`, `AZURE_OPENAI_DEPLOYMENT`, `OPENAI_API_VERSION`.
- Uses Chat Completions with `response_format: { type: "json_schema", json_schema: { name, strict: true, schema } }` and `max_completion_tokens`.
- Strict mode requires every property to be in `required` and `additionalProperties: false` everywhere. `toStrictSchema` rewrites schemas mechanically: optional properties become nullable, and `fromStrict` removes those nulls again before validation. The interpretation schema is already in that shape, so the rewrite does not change it.
- `message.refusal` and `finish_reason: content_filter` map to `refusal`. `finish_reason: length` maps to `truncated`.

### Google Gemini and Vertex AI

```bash
export GEMINI_API_KEY=...        # or GOOGLE_API_KEY
LLM_PROVIDER=gemini LLM_MODEL=gemini-2.5-flash npm run demo
```

```bash
# Vertex AI with Application Default Credentials (gcloud auth application-default login)
export GOOGLE_GENAI_USE_VERTEXAI=true GOOGLE_CLOUD_PROJECT=my-project GOOGLE_CLOUD_LOCATION=europe-west4
LLM_PROVIDER=gemini npm run demo
```

- Default model: `gemini-2.5-flash`, a placeholder. Set `LLM_MODEL` or `GEMINI_MODEL`.
- Fallback variables: `GEMINI_API_KEY`, then `GOOGLE_API_KEY`. Also `GEMINI_MODEL`, and `GOOGLE_GENAI_USE_VERTEXAI` / `GOOGLE_CLOUD_PROJECT` / `GOOGLE_CLOUD_LOCATION` for Vertex.
- Sends `responseMimeType: "application/json"` with `responseJsonSchema`, which takes standard JSON Schema. The older `responseSchema` takes Google's OpenAPI subset.
- Gemini applies the schema on a best-effort basis, so local validation and the repair attempt matter most here.
- `promptFeedback.blockReason`, `SAFETY` and other abnormal finish reasons map to `refusal`. `MAX_TOKENS` maps to `truncated`. Thinking tokens count as output tokens.

### Ollama

```bash
ollama pull llama3.1
LLM_PROVIDER=ollama LLM_MODEL=llama3.1 npm run demo
OLLAMA_HOST=192.168.1.20:11434 LLM_PROVIDER=ollama npm run demo
```

- Default URL: `http://localhost:11434`. Default model: `llama3.1`.
- Fallback variables: `OLLAMA_HOST` (a scheme is optional, as with the Ollama CLI), `OLLAMA_MODEL`, and `OLLAMA_API_KEY` (sent as `Authorization: Bearer`, for hosted Ollama).
- Sends `POST /api/chat` with `format` set to the schema, `stream: false`, `temperature: 0` and `num_predict: 16000`. As Ollama's documentation recommends, the schema is also included in the system prompt.
- `done_reason: "length"` maps to `truncated`.
- Small local models misread more often. The pipeline above is what makes that safe.

### OpenAI-compatible servers

The `openai` SDK at a custom `baseURL`. `LLM_BASE_URL` and `LLM_MODEL` are required. The key comes **only** from `LLM_API_KEY`: `OPENAI_API_KEY` is deliberately not used, so an OpenAI key is never sent to a third-party host. Local servers accept any key.

Servers differ in what they support, so `LLM_STRUCTURED_OUTPUT` sets the capability:

- `json_schema` (default): `response_format` json_schema, strict.
- `json_object`: `response_format: {type: "json_object"}`, with the schema described in the system prompt.
- `prompt`: no `response_format`. The schema is described in the prompt, and JSON is extracted from fences or prose.

Every mode validates the answer locally. If a server rejects `json_schema` with a 400 (`LlmError("bad_request")`), switch to `json_object`.

```bash
# Mistral
LLM_PROVIDER=openai-compatible LLM_BASE_URL=https://api.mistral.ai/v1 LLM_API_KEY=$MISTRAL_API_KEY LLM_MODEL=mistral-large-latest npm run demo
# Groq
LLM_PROVIDER=openai-compatible LLM_BASE_URL=https://api.groq.com/openai/v1 LLM_API_KEY=$GROQ_API_KEY LLM_MODEL=llama-3.3-70b-versatile LLM_STRUCTURED_OUTPUT=json_object npm run demo
# OpenRouter
LLM_PROVIDER=openai-compatible LLM_BASE_URL=https://openrouter.ai/api/v1 LLM_API_KEY=$OPENROUTER_API_KEY LLM_MODEL=<vendor>/<model> npm run demo
# Together
LLM_PROVIDER=openai-compatible LLM_BASE_URL=https://api.together.xyz/v1 LLM_API_KEY=$TOGETHER_API_KEY LLM_MODEL=<model> npm run demo
# DeepSeek (JSON mode only)
LLM_PROVIDER=openai-compatible LLM_BASE_URL=https://api.deepseek.com LLM_API_KEY=$DEEPSEEK_API_KEY LLM_MODEL=deepseek-chat LLM_STRUCTURED_OUTPUT=json_object npm run demo
# LM Studio / vLLM (local)
LLM_PROVIDER=openai-compatible LLM_BASE_URL=http://localhost:1234/v1 LLM_MODEL=<loaded model> npm run demo
LLM_PROVIDER=openai-compatible LLM_BASE_URL=http://localhost:8000/v1 LLM_MODEL=<served model> npm run demo
```

The model names and mode choices in these examples follow each vendor's public documentation. None of them was run as part of this work. Check each vendor's current documentation for structured-output support.

## Per-agent configuration in code

Each assistant can have its own interpreter. Two agents on different providers can share one Pod, and a meaning agreed through one agent is reused by the other without asking again (covered by a test):

```ts
import { createInterpreter } from "./src/grounding/llmInterpreter.js";

const env = await startEnvironment();
const a = env.assistant(AGENT_1, { interpreter: createInterpreter({ provider: "anthropic" }) });
const b = env.assistant(AGENT_2, { interpreter: createInterpreter({ provider: "ollama", model: "llama3.1" }) });
const c = env.assistant(AGENT_2, { interpreter: createInterpreter("rules") });
```

`createInterpreter` accepts `"rules"`, an `LlmConfig` (same fields as the environment variables), or a ready `ChatAdapter`, e.g. one wrapping a Bedrock client. `defaultInterpreter()` in `src/demo/environment.ts` calls `interpreterFromEnv()`. `ClaudeInterpreter` remains as a thin wrapper over the Anthropic adapter.

## Error model

Every failure is an `LlmError` (`src/llm/types.ts`) with one of these `kind` values:

| `kind` | When | `retryable` |
|---|---|---|
| `refusal` | The model or a safety system declined (Anthropic `stop_reason: refusal`, OpenAI `refusal` / `content_filter`, Gemini block / `SAFETY`) | no |
| `truncated` | The token limit was hit; the partial answer is never parsed | no |
| `invalid_output` | Not JSON, or schema-invalid, after one repair attempt; `details.validationErrors` lists why | no |
| `auth` | 401 / 403 | no |
| `rate_limit` | 429 / quota | yes |
| `timeout` | No answer within `LLM_TIMEOUT_MS` | yes |
| `bad_request` | 400 / 404 / 422 (unknown model, unsupported schema feature) | no |
| `transport` | Connection failure or 5xx | yes |
| `config` | Incomplete local configuration | no |

## Comparison harness

```bash
npm run compare:interpreters
npm run compare:interpreters -- --out interpreter-comparison.md   # also writes .json
```

The harness runs a fixed set of requests through the rule-based interpreter and every configured provider (`src/llm/compare.ts`, `CASES`):

- "current" weather;
- "repairable" shoes;
- spending limits, including per-purchase limits and "including delivery";
- paraphrases;
- a vague request;
- a request outside the vocabulary;
- two adversarial ones: a preference that tries to carry a 500 USDC limit, and text claiming a 1000 USDC budget was "already approved".

Each interpretation then goes through the real `CommonGround.negotiate` step, which shows what would reach the user. The report lists, per interpreter and case:

- typed errors;
- `validateInterpretation` failures;
- expectation failures, a measure of interpretation quality. For example, the rule-based interpreter misses "shoes I can get repaired";
- invariant violations: a mandate limit that does not appear in the request, or a record that is not `Proposed`;
- differences from the rule-based baseline.

Token usage, repair counts and latency are included.

Providers without credentials are skipped with a reason. Ollama is skipped when no server answers. The provider named by `LLM_PROVIDER` is always attempted, which is how `ant auth login` profiles and `openai-compatible` endpoints are included.

## What was verified, and how

**None of the adapters was run against a live provider service as part of this work.** CI has no API keys.

`test/llm.test.ts` points each adapter's real client at a local mock HTTP server that mimics that provider's documented wire format:

- the real `@anthropic-ai/sdk` 1.8, `openai` 7.46 (including the `AzureOpenAI` client) and `@google/genai` 2.32;
- for Ollama, `fetch`.

The tests check:

- request shape: endpoint path, auth header, model id, and the schema in the provider's native field;
- response parsing and usage;
- refusal and truncation handling;
- the bounded repair retry on invalid JSON;
- typed HTTP, timeout and connection errors;
- the factory and environment configuration;
- an end-to-end run of two agents on different (mocked) providers sharing a real Community Solid Server Pod.

The mocks encode our reading of each provider's documentation. A live service may differ in details the mocks do not cover:

- which JSON Schema keywords are accepted in strict or native mode;
- exact refusal payloads;
- default model availability.

The default model ids for OpenAI, Gemini and Ollama are placeholders. Set `LLM_MODEL`.
