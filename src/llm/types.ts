/**
 * Provider-neutral contract for "structured generation": a system prompt, the
 * user's content and a JSON schema go in; a schema-valid object comes out,
 * together with which model actually answered and what it cost in tokens.
 *
 * Adapters (src/llm/providers/) only translate one request/response round trip
 * into a provider's native API and its native structured-output mode. Parsing,
 * schema validation and the bounded repair retry live once, in structured.ts,
 * so every provider is held to the same standard.
 */

export type ProviderName = "anthropic" | "openai" | "gemini" | "ollama" | "openai-compatible";

export const PROVIDERS: readonly ProviderName[] = ["anthropic", "openai", "gemini", "ollama", "openai-compatible"];

/** A JSON schema in the subset documented in jsonSchema.ts. */
export type JsonSchema = Record<string, unknown>;

export interface StructuredRequest {
  system: string;
  user: string;
  schema: JsonSchema;
  /** Name for providers that label the schema (OpenAI's json_schema.name). [A-Za-z0-9_-] only. */
  schemaName: string;
}

/** One turn of a conversation. A repair retry adds the model's invalid answer and the validation errors. */
export interface Turn { role: "user" | "assistant"; content: string }

export interface CompletionRequest {
  system: string;
  turns: Turn[];
  schema: JsonSchema;
  schemaName: string;
}

export interface Usage { inputTokens?: number; outputTokens?: number }

/**
 * What an adapter hands back for one round trip. `finish` is normalised so the
 * shared layer can refuse to read a refused or truncated answer, whatever the
 * provider calls those conditions.
 */
export interface Completion {
  text: string;
  finish: "stop" | "refusal" | "truncated";
  /** The provider's own reason, e.g. a refusal category or finish_reason. */
  detail?: string;
  /** Model id reported by the provider (may differ from the requested one, e.g. after a fallback). */
  model: string;
  usage: Usage;
}

export interface ChatAdapter {
  readonly provider: ProviderName;
  /** The model id requested. Never rewritten (no date suffixes appended). */
  readonly model: string;
  complete(req: CompletionRequest): Promise<Completion>;
}

/** Connection settings every adapter takes. Resolved from code or the environment by config.ts. */
export interface AdapterOptions {
  model: string;
  /** Undefined lets the official SDK use its own credential chain (env var, profile, ADC). */
  apiKey?: string;
  baseURL?: string;
  /** Per request. A slow answer becomes a typed "timeout" error, never a hang. */
  timeoutMs: number;
  /** Transport-level retries (429 / 5xx / connection) done by the SDK. Not the schema repair retry. */
  maxRetries: number;
  maxOutputTokens: number;
}

export interface StructuredResult<T> {
  value: T;
  provider: ProviderName;
  requestedModel: string;
  model: string;
  /** Summed over all attempts. */
  usage: Usage;
  /** 1, or 2 when the first answer failed validation and was repaired. */
  attempts: number;
}

/**
 * Typed failure categories. Callers can decide what is worth retrying (rate
 * limits, transport) and what needs a human (auth, refusal) without parsing
 * provider-specific error messages.
 */
export type LlmErrorKind =
  | "refusal"          // the model or a safety system declined
  | "truncated"        // output hit the token limit; never parsed as if complete
  | "invalid_output"   // not JSON, or JSON that fails the schema, after the repair retry
  | "auth"             // 401 / 403: missing or wrong credentials
  | "rate_limit"       // 429 / quota
  | "timeout"          // no answer within the configured timeout
  | "bad_request"      // 400 / 404 / 422: unsupported model, schema feature or parameter
  | "transport"        // connection failure or 5xx
  | "config";          // incomplete local configuration (e.g. no model for openai-compatible)

export class LlmError extends Error {
  readonly name = "LlmError";
  constructor(
    readonly kind: LlmErrorKind,
    message: string,
    readonly provider?: ProviderName,
    readonly details: { status?: number; validationErrors?: string[]; rawText?: string; cause?: unknown } = {},
  ) {
    super(provider ? `[${provider}] ${message}` : message);
  }

  /** Worth retrying later without changing anything. */
  get retryable(): boolean {
    return this.kind === "rate_limit" || this.kind === "timeout" || this.kind === "transport";
  }
}
