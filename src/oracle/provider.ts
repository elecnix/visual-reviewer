import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { LanguageModel } from "ai";
import type { OracleConfig } from "../config.js";
import { missingKeyHint, resolveApiKey, USER_AGENT } from "../config.js";

/**
 * Model-provider abstraction: any OpenAI-compatible endpoint works by
 * swapping `baseURL` + `model`. Defaults to Ollama Cloud + DeepSeek V4.1 Flash.
 *
 *   Ollama Cloud: https://ollama.com/v1          deepseek-v4.1-flash
 *   OpenAI:      https://api.openai.com/v1      gpt-4o
 *   Ollama:      http://localhost:11434/v1      qwen3-vl:30b
 */
export function resolveModel(config: OracleConfig): LanguageModel {
  const hint = missingKeyHint(config);
  if (hint) throw new Error(hint);
  const provider = createOpenAICompatible({
    name: "visual-reviewer",
    baseURL: config.baseURL,
    apiKey: resolveApiKey(config) ?? "",
    headers: { "User-Agent": USER_AGENT },
  });
  return provider(config.model);
}
