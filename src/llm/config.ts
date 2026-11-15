/**
 * Provider configuration: from code (per agent) or from the environment.
 *
 * In code, every agent can get its own LlmConfig, so two assistants working on
 * the same Pod may use different providers. From the environment, one
 * provider is selected:
 *
 *   LLM_PROVIDER     rules | anthropic | openai | gemini | ollama | openai-compatible
 *   LLM_MODEL        model id (Azure: deployment name), passed through verbatim
 *   LLM_BASE_URL     endpoint override
 *   LLM_API_KEY      key override
 *   LLM_TIMEOUT_MS   per-request timeout (default 120000)
 *   LLM_MAX_RETRIES  SDK transport retries (default 2)
 *   LLM_STRUCTURED_OUTPUT  openai-compatible only: json_schema | json_object | prompt
 *
 * The LLM_* overrides apply only to the selected provider. Each provider's own
 * standard variables (ANTHROPIC_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY, ...)
 * are read as fallbacks; see docs/llm-providers.md for the full table.
 * Legacy: INTERPRETER=claude selects anthropic and CLAUDE_MODEL its model.
 */
import { ANTHROPIC_DEFAULT_MODEL, AnthropicAdapter } from "./providers/anthropic.js";
import { GEMINI_DEFAULT_MODEL, GeminiAdapter, type GeminiVertexOptions } from "./providers/gemini.js";
import { OLLAMA_DEFAULT_MODEL, OllamaAdapter, ollamaBaseUrl } from "./providers/ollama.js";
import { OPENAI_DEFAULT_MODEL, OpenAIAdapter, STRUCTURED_MODES, type StructuredMode } from "./providers/openai.js";
import { LlmError, PROVIDERS, type AdapterOptions, type ChatAdapter, type ProviderName } from "./types.js";

export interface LlmConfig {
  provider: ProviderName;
  /** Defaults per provider (none for openai-compatible). Never rewritten, e.g. no date suffix. */
  model?: string;
  apiKey?: string;
  baseURL?: string;
  timeoutMs?: number;
  maxRetries?: number;
  maxOutputTokens?: number;
  /** openai-compatible only. Default json_schema. */
  structuredOutput?: StructuredMode;
  /** openai only: route through Azure OpenAI. */
  azure?: { endpoint: string; apiVersion?: string };
  /**
   * gemini only: route through Vertex AI. Without apiKey, credentials come from
   * Application Default Credentials (or googleAuthOptions); with apiKey, Vertex
   * AI express mode.
   */
  vertex?: GeminiVertexOptions;
}

export const DEFAULTS = { timeoutMs: 120_000, maxRetries: 2, maxOutputTokens: 16_000, azureApiVersion: "2024-10-21" } as const;

const DEFAULT_MODELS: Partial<Record<ProviderName, string>> = {
  anthropic: ANTHROPIC_DEFAULT_MODEL,
  openai: OPENAI_DEFAULT_MODEL,
  gemini: GEMINI_DEFAULT_MODEL,
  ollama: OLLAMA_DEFAULT_MODEL,
};

export function createLlm(cfg: LlmConfig): ChatAdapter {
  const model = cfg.model ?? DEFAULT_MODELS[cfg.provider];
  if (!model) throw new LlmError("config", "no model configured (set LLM_MODEL)", cfg.provider);
  const o: AdapterOptions = {
    model, apiKey: cfg.apiKey, baseURL: cfg.baseURL,
    timeoutMs: cfg.timeoutMs ?? DEFAULTS.timeoutMs, maxRetries: cfg.maxRetries ?? DEFAULTS.maxRetries, maxOutputTokens: cfg.maxOutputTokens ?? DEFAULTS.maxOutputTokens,
  };
  try {
    return adapterFor(cfg, o);
  } catch (err) {
    // SDK constructors throw their own errors for missing credentials; keep the typed model.
    if (err instanceof LlmError) throw err;
    throw new LlmError("config", (err as Error).message, cfg.provider, { cause: err });
  }
}

function adapterFor(cfg: LlmConfig, o: AdapterOptions): ChatAdapter {
  switch (cfg.provider) {
    case "anthropic": return AnthropicAdapter.create(o);
    case "openai": return cfg.azure ? OpenAIAdapter.createAzure({ ...o, endpoint: cfg.azure.endpoint, apiVersion: cfg.azure.apiVersion ?? DEFAULTS.azureApiVersion }) : OpenAIAdapter.create(o);
    case "gemini": return GeminiAdapter.create({ ...o, vertex: cfg.vertex });
    case "ollama": return OllamaAdapter.create(o);
    case "openai-compatible":
      if (!cfg.baseURL) throw new LlmError("config", "openai-compatible needs a base URL (set LLM_BASE_URL)", cfg.provider);
      return OpenAIAdapter.createCompatible({ ...o, baseURL: cfg.baseURL, mode: cfg.structuredOutput ?? "json_schema" });
  }
}

type Env = Record<string, string | undefined>;
const nonEmpty = (v: string | undefined) => (v && v.trim() ? v.trim() : undefined);
const truthy = (v: string | undefined) => /^(1|true|yes)$/i.test(v ?? "");

function int(env: Env, name: string): number | undefined {
  const v = nonEmpty(env[name]);
  if (v === undefined) return undefined;
  if (!/^\d+$/.test(v)) throw new LlmError("config", `${name} must be a non-negative integer, got "${v}"`);
  return Number(v);
}

/** OLLAMA_HOST is often written without a scheme or port ("gpu-box", "127.0.0.1:11434"); see ollamaBaseUrl. */
function ollamaHost(v: string | undefined): string | undefined {
  const h = nonEmpty(v);
  return h && ollamaBaseUrl(h);
}

/**
 * The configuration for one provider as the environment describes it.
 * `selected` says whether this provider is the one LLM_PROVIDER names, in which
 * case the generic LLM_* overrides apply to it.
 */
export function providerConfigFromEnv(provider: ProviderName, env: Env = process.env, selected = false): LlmConfig {
  const g = (name: string) => (selected ? nonEmpty(env[name]) : undefined);
  const cfg: LlmConfig = { provider, timeoutMs: int(env, "LLM_TIMEOUT_MS"), maxRetries: int(env, "LLM_MAX_RETRIES") };
  switch (provider) {
    case "anthropic":
      cfg.model = g("LLM_MODEL") ?? nonEmpty(env.CLAUDE_MODEL) ?? nonEmpty(env.ANTHROPIC_MODEL);
      cfg.apiKey = g("LLM_API_KEY") ?? nonEmpty(env.ANTHROPIC_API_KEY);
      cfg.baseURL = g("LLM_BASE_URL") ?? nonEmpty(env.ANTHROPIC_BASE_URL);
      break;
    case "openai": {
      const endpoint = nonEmpty(env.AZURE_OPENAI_ENDPOINT);
      if (endpoint) {
        cfg.azure = { endpoint, apiVersion: nonEmpty(env.OPENAI_API_VERSION) };
        cfg.model = g("LLM_MODEL") ?? nonEmpty(env.AZURE_OPENAI_DEPLOYMENT);
        cfg.apiKey = g("LLM_API_KEY") ?? nonEmpty(env.AZURE_OPENAI_API_KEY);
      } else {
        cfg.model = g("LLM_MODEL") ?? nonEmpty(env.OPENAI_MODEL);
        cfg.apiKey = g("LLM_API_KEY") ?? nonEmpty(env.OPENAI_API_KEY);
        cfg.baseURL = g("LLM_BASE_URL") ?? nonEmpty(env.OPENAI_BASE_URL);
      }
      break;
    }
    case "gemini":
      cfg.model = g("LLM_MODEL") ?? nonEmpty(env.GEMINI_MODEL);
      cfg.baseURL = g("LLM_BASE_URL");
      if (truthy(env.GOOGLE_GENAI_USE_VERTEXAI)) {
        // Vertex AI authenticates with ADC. GEMINI_API_KEY / GOOGLE_API_KEY are Gemini
        // Developer API keys: passing one would send it as x-goog-api-key to the
        // project path instead of using ADC. Only LLM_API_KEY selects Vertex express,
        // which takes a key and no project/location.
        cfg.apiKey = g("LLM_API_KEY");
        cfg.vertex = cfg.apiKey ? {} : { project: nonEmpty(env.GOOGLE_CLOUD_PROJECT), location: nonEmpty(env.GOOGLE_CLOUD_LOCATION) };
      } else {
        cfg.apiKey = g("LLM_API_KEY") ?? nonEmpty(env.GEMINI_API_KEY) ?? nonEmpty(env.GOOGLE_API_KEY);
      }
      break;
    case "ollama":
      cfg.model = g("LLM_MODEL") ?? nonEmpty(env.OLLAMA_MODEL);
      cfg.apiKey = g("LLM_API_KEY") ?? nonEmpty(env.OLLAMA_API_KEY);
      cfg.baseURL = g("LLM_BASE_URL") ?? ollamaHost(env.OLLAMA_HOST);
      break;
    case "openai-compatible": {
      // Deliberately no fallback to OPENAI_API_KEY: that key must not leak to a third-party host.
      cfg.model = g("LLM_MODEL");
      cfg.apiKey = g("LLM_API_KEY");
      cfg.baseURL = g("LLM_BASE_URL");
      const mode = g("LLM_STRUCTURED_OUTPUT");
      if (mode !== undefined) {
        if (!(STRUCTURED_MODES as readonly string[]).includes(mode)) throw new LlmError("config", `LLM_STRUCTURED_OUTPUT must be one of ${STRUCTURED_MODES.join(", ")}, got "${mode}"`, provider);
        cfg.structuredOutput = mode as StructuredMode;
      }
      break;
    }
  }
  return cfg;
}

/**
 * The provider selected by the environment, or undefined for the offline
 * rule-based interpreter (the default). An unknown LLM_PROVIDER is an error,
 * not a silent fallback: a typo should not quietly change which model reads
 * the user's requests.
 */
export function llmConfigFromEnv(env: Env = process.env): LlmConfig | undefined {
  const named = nonEmpty(env.LLM_PROVIDER)?.toLowerCase();
  if (named === undefined) {
    // Backwards compatibility: INTERPRETER=claude (+ CLAUDE_MODEL) predates LLM_PROVIDER.
    return env.INTERPRETER === "claude" ? providerConfigFromEnv("anthropic", env, false) : undefined;
  }
  if (named === "rules") return undefined;
  if (!(PROVIDERS as readonly string[]).includes(named)) throw new LlmError("config", `LLM_PROVIDER must be rules or one of ${PROVIDERS.join(", ")}, got "${named}"`);
  return providerConfigFromEnv(named as ProviderName, env, true);
}
