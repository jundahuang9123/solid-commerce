/**
 * Ollama's native REST API (POST /api/chat, stream:false) with structured
 * outputs: "format" carries the JSON schema and the server constrains
 * decoding to it. No SDK is needed for one JSON round trip.
 *
 * Ollama's documentation also recommends putting the schema in the prompt to
 * ground smaller models, so it is sent in both places.
 */
import { schemaInstruction, toLlmError } from "../structured.js";
import type { AdapterOptions, ChatAdapter, Completion, CompletionRequest } from "../types.js";

export const OLLAMA_DEFAULT_URL = "http://localhost:11434";
export const OLLAMA_DEFAULT_MODEL = "llama3.1";

interface ChatResponse {
  model?: string;
  message?: { role: string; content: string };
  done?: boolean;
  done_reason?: string;
  prompt_eval_count?: number;
  eval_count?: number;
  error?: string;
}

export class OllamaAdapter implements ChatAdapter {
  readonly provider = "ollama" as const;
  private readonly baseURL: string;

  constructor(readonly model: string, private readonly o: Omit<AdapterOptions, "model">) {
    this.baseURL = (o.baseURL ?? OLLAMA_DEFAULT_URL).replace(/\/+$/, "");
  }

  static create(o: AdapterOptions): OllamaAdapter {
    return new OllamaAdapter(o.model, o);
  }

  async complete(req: CompletionRequest): Promise<Completion> {
    const body = {
      model: this.model,
      messages: [{ role: "system", content: req.system + schemaInstruction(req.schema) }, ...req.turns],
      format: req.schema,
      stream: false,
      // Deterministic decoding: interpretations should not vary run to run.
      options: { temperature: 0, num_predict: this.o.maxOutputTokens },
    };
    const res = await this.post(body);
    const base = { model: res.model ?? this.model, usage: { inputTokens: res.prompt_eval_count, outputTokens: res.eval_count } };
    // "length" = num_predict reached; the JSON is cut off.
    if (res.done_reason === "length") return { ...base, text: "", finish: "truncated", detail: "done_reason length" };
    return { ...base, text: res.message?.content ?? "", finish: "stop" };
  }

  /** One POST with a hard timeout; transport-level retries only for 429/5xx/connection errors. */
  private async post(body: unknown): Promise<ChatResponse> {
    for (let attempt = 0; ; attempt++) {
      try {
        const res = await fetch(`${this.baseURL}/api/chat`, {
          method: "POST",
          headers: { "content-type": "application/json", ...(this.o.apiKey ? { authorization: `Bearer ${this.o.apiKey}` } : {}) },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(this.o.timeoutMs),
        });
        const text = await res.text();
        let parsed: ChatResponse;
        try { parsed = JSON.parse(text) as ChatResponse; } catch { parsed = { error: text.slice(0, 200) }; }
        if (!res.ok) throw Object.assign(new Error(parsed.error ?? `HTTP ${res.status}`), { status: res.status });
        return parsed;
      } catch (err) {
        const e = toLlmError(this.provider, err);
        if (!e.retryable || e.kind === "timeout" || attempt >= this.o.maxRetries) throw e;
        await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
      }
    }
  }
}
