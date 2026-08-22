import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { LanguageModel } from "ai";
import type { OracleConfig } from "../config.js";
import { resolveApiKey, USER_AGENT } from "../config.js";

/**
 * Model-provider abstraction: any OpenAI-compatible endpoint works by
 * swapping `baseURL` + `model`. Defaults to OpenRouter + Qwen3-VL (cheap).
 *
 *   OpenRouter:  https://openrouter.ai/api/v1   qwen/qwen3-vl-30b-a3b-instruct
 *   OpenAI:      https://api.openai.com/v1      gpt-4o
 *   Ollama:      http://localhost:11434/v1      qwen3-vl:30b
 */
export function resolveModel(config: OracleConfig): LanguageModel {
  const provider = createOpenAICompatible({
    name: "visual-reviewer",
    baseURL: config.baseURL,
    apiKey: resolveApiKey(config) ?? "",
    headers: { "User-Agent": USER_AGENT },
  });
  return provider(config.model);
}
