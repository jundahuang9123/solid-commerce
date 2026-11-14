/**
 * Anthropic Messages API via the official @anthropic-ai/sdk, using native
 * structured outputs (output_config.format = json_schema).
 *
 * The request shape is the one the prototype's Claude interpreter has always
 * sent: server-side fallbacks are enabled so a safety-classifier decline is
 * re-run on a fallback model instead of failing the whole interpretation.
 *
 * Amazon Bedrock and Google Vertex AI are not wired here. The Anthropic SDK
 * ships its own clients for them (@anthropic-ai/bedrock-sdk,
 * @anthropic-ai/vertex-sdk) with the same `beta.messages.create` surface;
 * pass such a client to the constructor to use them.
 */
import Anthropic from "@anthropic-ai/sdk";
import { toLlmError } from "../structured.js";
import type { AdapterOptions, ChatAdapter, Completion, CompletionRequest } from "../types.js";

export const ANTHROPIC_DEFAULT_MODEL = "claude-opus-5-5";

/** The subset of the SDK client this adapter calls, so Bedrock/Vertex clients or test doubles fit. */
export type AnthropicLike = Pick<Anthropic, "beta">;

export class AnthropicAdapter implements ChatAdapter {
  readonly provider = "anthropic" as const;

  constructor(readonly model: string, private readonly client: AnthropicLike, private readonly maxOutputTokens = 16000) {}

  static create(o: AdapterOptions): AnthropicAdapter {
    // apiKey undefined: the SDK falls back to ANTHROPIC_API_KEY or an `ant auth login` profile.
    return new AnthropicAdapter(o.model, new Anthropic({ apiKey: o.apiKey, baseURL: o.baseURL, timeout: o.timeoutMs, maxRetries: o.maxRetries }), o.maxOutputTokens);
  }

  async complete(req: CompletionRequest): Promise<Completion> {
    let response: any;
    try {
      // Cast: the beta fields below are newer than some SDK type releases.
      response = await (this.client.beta.messages.create as any)({
        model: this.model,
        max_tokens: this.maxOutputTokens,
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        output_config: { effort: "medium", format: { type: "json_schema", schema: req.schema } },
        system: req.system,
        messages: req.turns.map((t) => ({ role: t.role, content: t.content })),
      });
    } catch (err) {
      throw toLlmError(this.provider, err);
    }
    const base = { model: response.model ?? this.model, usage: { inputTokens: response.usage?.input_tokens, outputTokens: response.usage?.output_tokens } };
    // stop_reason is checked BEFORE reading content: a refused or truncated message must never be parsed.
    if (response.stop_reason === "refusal") {
      const d = response.stop_details;
      return { ...base, text: "", finish: "refusal", detail: [d?.category, d?.explanation].filter(Boolean).join(": ") || undefined };
    }
    if (response.stop_reason === "max_tokens") return { ...base, text: "", finish: "truncated", detail: `max_tokens ${this.maxOutputTokens}` };
    const text = (response.content ?? []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("");
    return { ...base, text, finish: "stop" };
  }
}
