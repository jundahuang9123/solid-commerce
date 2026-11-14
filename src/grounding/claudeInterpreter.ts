/**
 * Backwards-compatible Claude interpreter: an LlmInterpreter on the Anthropic
 * adapter, with the same constructor as before (model, optional SDK client).
 * New code should use createInterpreter({ provider: "anthropic", ... }).
 */
import Anthropic from "@anthropic-ai/sdk";
import { ANTHROPIC_DEFAULT_MODEL, AnthropicAdapter, type AnthropicLike } from "../llm/providers/anthropic.js";
import { LlmInterpreter } from "./llmInterpreter.js";

export class ClaudeInterpreter extends LlmInterpreter {
  override readonly name = "claude";
  constructor(model = process.env.CLAUDE_MODEL ?? ANTHROPIC_DEFAULT_MODEL, client?: AnthropicLike) {
    super(new AnthropicAdapter(model, client ?? new Anthropic()));
  }
}
