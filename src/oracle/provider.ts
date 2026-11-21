import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { generateText, type LanguageModel } from "ai";
import type { OracleConfig } from "../config.js";
import { resolveApiKey, USER_AGENT } from "../config.js";
import type { Complete } from "./complete.js";

/**
 * Model-provider abstraction: any OpenAI-compatible endpoint works by
 * swapping `baseURL` + `model`. Defaults to OpenRouter + DeepSeek V4.1 Flash.
 *
 *   OpenRouter:  https://openrouter.ai/api/v1   deepseek/deepseek-v4.1-flash
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

/**
 * Production implementation of the completion seam: the model is resolved
 * once per call site, and every judgement request shares the config's
 * temperature and per-request timeout. Tests substitute a scripted
 * implementation instead (see `oracle/complete.ts`).
 */
export function createComplete(config: OracleConfig): Complete {
  const model = resolveModel(config);
  return async ({ system, messages, temperature, timeoutMs }) => {
    const result = await generateText({
      model,
      system,
      messages,
      temperature,
      abortSignal: AbortSignal.timeout(timeoutMs),
    });
    return { text: result.text };
  };
}
