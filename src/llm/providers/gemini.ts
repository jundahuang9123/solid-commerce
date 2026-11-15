/**
 * Google Gemini via the official @google/genai SDK, with native structured
 * output: responseMimeType application/json plus responseJsonSchema (the
 * field that takes standard JSON Schema; the older responseSchema takes
 * Google's OpenAPI-flavoured Schema object).
 *
 * The same SDK reaches Vertex AI (vertexai + project + location, credentials
 * from Application Default Credentials). Gemini enforces the schema on a
 * best-effort basis, which is one reason every answer is validated locally.
 */
import { GoogleGenAI, type GenerateContentResponse, type GoogleGenAIOptions } from "@google/genai";
import { toLlmError } from "../structured.js";
import { assertSecureTransport, envUrl } from "../transport.js";
import { LlmError, type AdapterOptions, type ChatAdapter, type Completion, type CompletionRequest } from "../types.js";

export const GEMINI_DEFAULT_MODEL = "gemini-2.5-flash";

export type GeminiLike = Pick<GoogleGenAI, "models">;

/**
 * Vertex AI routing. With project/location and no API key the SDK uses
 * Application Default Credentials (googleAuthOptions customises that, e.g.
 * explicit credentials). An API key without project/location is Vertex AI
 * express mode.
 */
export interface GeminiVertexOptions { project?: string; location?: string; googleAuthOptions?: GoogleGenAIOptions["googleAuthOptions"] }

/** Finish reasons meaning a policy stopped the answer. Any other non-STOP reason also ends it abnormally. */
const BLOCKED = new Set(["SAFETY", "RECITATION", "BLOCKLIST", "PROHIBITED_CONTENT", "SPII", "IMAGE_SAFETY", "LANGUAGE"]);

export class GeminiAdapter implements ChatAdapter {
  readonly provider = "gemini" as const;

  constructor(readonly model: string, private readonly client: GeminiLike, private readonly maxOutputTokens = 16000) {}

  static create(o: AdapterOptions & { vertex?: GeminiVertexOptions }): GeminiAdapter {
    // Either an API key or an ADC access token is always sent. The SDK reads its own base-URL variables.
    const envBase = o.vertex ? "GOOGLE_VERTEX_BASE_URL" : "GOOGLE_GEMINI_BASE_URL";
    assertSecureTransport("gemini", o.baseURL ?? envUrl(envBase), true, o.baseURL ? "base URL" : envBase);
    if (o.vertex && !o.apiKey && !o.vertex.googleAuthOptions?.credentials && !(o.vertex.project ?? envUrl("GOOGLE_CLOUD_PROJECT"))) {
      // Without a project (and without location) the SDK keeps GEMINI_API_KEY / GOOGLE_API_KEY from
      // process.env and sends it to the Vertex express endpoint instead of using ADC. Refuse that.
      throw new LlmError("config", "Vertex AI with Application Default Credentials needs a project: set GOOGLE_CLOUD_PROJECT (and GOOGLE_CLOUD_LOCATION), or LLM_API_KEY for Vertex AI express mode", "gemini");
    }
    const client = new GoogleGenAI({
      ...(o.vertex ? { vertexai: true, project: o.vertex.project, location: o.vertex.location, googleAuthOptions: o.vertex.googleAuthOptions } : { vertexai: false }),
      apiKey: o.apiKey,
      httpOptions: {
        baseUrl: o.baseURL,
        timeout: o.timeoutMs,
        // The SDK does not retry unless retryOptions is given; attempts counts the first request.
        ...(o.maxRetries > 0 ? { retryOptions: { attempts: o.maxRetries + 1 } } : {}),
      },
    });
    return new GeminiAdapter(o.model, client, o.maxOutputTokens);
  }

  async complete(req: CompletionRequest): Promise<Completion> {
    let res: GenerateContentResponse;
    try {
      res = await this.client.models.generateContent({
        model: this.model,
        contents: req.turns.map((t) => ({ role: t.role === "assistant" ? "model" : "user", parts: [{ text: t.content }] })),
        config: {
          systemInstruction: req.system,
          responseMimeType: "application/json",
          responseJsonSchema: req.schema,
          maxOutputTokens: this.maxOutputTokens,
        },
      });
    } catch (err) {
      throw toLlmError(this.provider, err);
    }
    const u = res.usageMetadata;
    const base = {
      model: res.modelVersion ?? this.model,
      // Thinking tokens are billed as output, so they count here.
      usage: { inputTokens: u?.promptTokenCount, outputTokens: u?.candidatesTokenCount === undefined && u?.thoughtsTokenCount === undefined ? undefined : (u?.candidatesTokenCount ?? 0) + (u?.thoughtsTokenCount ?? 0) },
    };
    if (res.promptFeedback?.blockReason) return { ...base, text: "", finish: "refusal", detail: `prompt blocked: ${res.promptFeedback.blockReason}${res.promptFeedback.blockReasonMessage ? ` ${res.promptFeedback.blockReasonMessage}` : ""}` };
    const cand = res.candidates?.[0];
    if (!cand) return { ...base, text: "", finish: "refusal", detail: "no candidates returned" };
    const reason = cand.finishReason as string | undefined;
    if (reason === "MAX_TOKENS") return { ...base, text: "", finish: "truncated", detail: "finishReason MAX_TOKENS" };
    if (reason && reason !== "STOP" && reason !== "FINISH_REASON_UNSPECIFIED") {
      return { ...base, text: "", finish: "refusal", detail: `finishReason ${reason}${BLOCKED.has(reason) ? "" : " (did not finish normally)"}${cand.finishMessage ? `: ${cand.finishMessage}` : ""}` };
    }
    // Skip thought summaries: only the answer parts carry the JSON.
    const text = (cand.content?.parts ?? []).filter((p) => typeof p.text === "string" && !p.thought).map((p) => p.text).join("");
    return { ...base, text, finish: "stop" };
  }
}
