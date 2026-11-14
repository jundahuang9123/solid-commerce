/**
 * OpenAI Chat Completions via the official "openai" SDK. One adapter serves
 * three configurations:
 *
 *   openai             api.openai.com, strict json_schema structured outputs
 *   openai + Azure     the SDK's AzureOpenAI client (endpoint + api-version + deployment)
 *   openai-compatible  any server speaking the same wire format (Mistral, Groq,
 *                      OpenRouter, Together, DeepSeek, LM Studio, vLLM, ...)
 *                      at a custom baseURL
 *
 * Chat Completions rather than the Responses API because it is the surface
 * compatible servers implement. Compatible servers differ in how much of
 * structured outputs they support, hence `mode`:
 *
 *   json_schema  response_format json_schema, strict (native; the default)
 *   json_object  response_format json_object, schema described in the prompt
 *   prompt       no response_format at all, schema described in the prompt
 */
import OpenAI, { AzureOpenAI } from "openai";
import { fromStrict, toStrictSchema } from "../jsonSchema.js";
import { parseJsonText, schemaInstruction, toLlmError } from "../structured.js";
import type { AdapterOptions, ChatAdapter, Completion, CompletionRequest } from "../types.js";

export const OPENAI_DEFAULT_MODEL = "gpt-5";

export type StructuredMode = "json_schema" | "json_object" | "prompt";
export const STRUCTURED_MODES: readonly StructuredMode[] = ["json_schema", "json_object", "prompt"];

export type OpenAILike = Pick<OpenAI, "chat">;

export interface OpenAIAdapterSettings {
  provider: "openai" | "openai-compatible";
  mode: StructuredMode;
  /**
   * OpenAI deprecated max_tokens in favour of max_completion_tokens (and its
   * reasoning models reject max_tokens); most compatible servers only know max_tokens.
   */
  tokenParam: "max_completion_tokens" | "max_tokens";
  maxOutputTokens: number;
}

export class OpenAIAdapter implements ChatAdapter {
  readonly provider: "openai" | "openai-compatible";

  constructor(readonly model: string, private readonly client: OpenAILike, private readonly s: OpenAIAdapterSettings) {
    this.provider = s.provider;
  }

  static create(o: AdapterOptions): OpenAIAdapter {
    return new OpenAIAdapter(o.model, new OpenAI({ apiKey: o.apiKey, baseURL: o.baseURL, timeout: o.timeoutMs, maxRetries: o.maxRetries }),
      { provider: "openai", mode: "json_schema", tokenParam: "max_completion_tokens", maxOutputTokens: o.maxOutputTokens });
  }

  /** Azure OpenAI: `model` is the deployment name. apiKey undefined lets the SDK read AZURE_OPENAI_API_KEY. */
  static createAzure(o: AdapterOptions & { endpoint: string; apiVersion: string }): OpenAIAdapter {
    const client = new AzureOpenAI({ endpoint: o.endpoint, apiVersion: o.apiVersion, deployment: o.model, apiKey: o.apiKey, timeout: o.timeoutMs, maxRetries: o.maxRetries });
    return new OpenAIAdapter(o.model, client, { provider: "openai", mode: "json_schema", tokenParam: "max_completion_tokens", maxOutputTokens: o.maxOutputTokens });
  }

  /** Requires an explicit baseURL and apiKey: an OpenAI key must never be sent to a third-party host by default. */
  static createCompatible(o: AdapterOptions & { baseURL: string; mode: StructuredMode }): OpenAIAdapter {
    // Local servers (LM Studio, vLLM, Ollama's /v1) accept any key, but the SDK insists on one.
    const client = new OpenAI({ apiKey: o.apiKey ?? "not-needed", baseURL: o.baseURL, timeout: o.timeoutMs, maxRetries: o.maxRetries });
    return new OpenAIAdapter(o.model, client, { provider: "openai-compatible", mode: o.mode, tokenParam: "max_tokens", maxOutputTokens: o.maxOutputTokens });
  }

  async complete(req: CompletionRequest): Promise<Completion> {
    const native = this.s.mode === "json_schema";
    const system = native ? req.system : req.system + schemaInstruction(req.schema);
    const responseFormat = native
      ? { response_format: { type: "json_schema" as const, json_schema: { name: req.schemaName, strict: true, schema: toStrictSchema(req.schema) } } }
      : this.s.mode === "json_object" ? { response_format: { type: "json_object" as const } } : {};

    let res: OpenAI.Chat.Completions.ChatCompletion;
    try {
      res = await this.client.chat.completions.create({
        model: this.model,
        messages: [{ role: "system", content: system }, ...req.turns.map((t) => ({ role: t.role, content: t.content }))],
        [this.s.tokenParam]: this.s.maxOutputTokens,
        ...responseFormat,
      });
    } catch (err) {
      throw toLlmError(this.provider, err);
    }
    const base = { model: res.model ?? this.model, usage: { inputTokens: res.usage?.prompt_tokens, outputTokens: res.usage?.completion_tokens } };
    const choice = res.choices?.[0];
    if (!choice) return { ...base, text: "", finish: "stop" };
    // Strict mode reports a refusal in its own field instead of emitting schema-shaped text.
    if (choice.message.refusal) return { ...base, text: "", finish: "refusal", detail: choice.message.refusal };
    if (choice.finish_reason === "content_filter") return { ...base, text: "", finish: "refusal", detail: "content_filter" };
    if (choice.finish_reason === "length") return { ...base, text: choice.message.content ?? "", finish: "truncated", detail: "finish_reason length" };
    let text = choice.message.content ?? "";
    if (native) {
      // Undo the nullable rewrite so the shared layer validates against the caller's schema.
      const parsed = parseJsonText(text);
      if (parsed.ok) text = JSON.stringify(fromStrict(parsed.value, req.schema));
    }
    return { ...base, text, finish: "stop" };
  }
}
