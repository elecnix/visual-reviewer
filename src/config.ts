import os from "node:os";
import path from "node:path";

export interface OracleConfig {
  /** Any OpenAI-compatible endpoint. Defaults to OpenRouter. */
  baseURL: string;
  /** Environment variable holding the API key. */
  apiKeyEnvVar: string;
  /** Provider/model id, e.g. "qwen/qwen3-vl-30b-a3b-instruct". */
  model: string;
  /** Max screenshots sent per judgement (cost control). */
  maxScreenshots: number;
  temperature: number;
  /** Per-request timeout in ms. */
  timeoutMs: number;
  /** Compare against previous runs' stored history (Phase-2 baseline). */
  baselines: boolean;
  /** Allow one bounded additional-evidence round on low-confidence/UNCERTAIN. */
  followUps: boolean;
  /** Verdicts below this confidence trigger a follow-up round. */
  followUpThreshold: number;
  /** Team expectations file injected into the oracle's system prompt. */
  expectationsFile: string;
  /** JSONL file where human verdict feedback is stored. */
  feedbackFile: string;
}

export const DEFAULT_ORACLE_CONFIG: OracleConfig = {
  baseURL: "https://openrouter.ai/api/v1",
  apiKeyEnvVar: "OPENROUTER_API_KEY",
  // Cheap Qwen3-VL via OpenRouter (~$0.13/$0.52 per M tokens) — see README.
  model: "qwen/qwen3-vl-30b-a3b-instruct",
  maxScreenshots: 6,
  temperature: 0,
  timeoutMs: 120_000,
  baselines: true,
  followUps: true,
  followUpThreshold: 0.7,
  expectationsFile: ".visual-reviewer/expectations.md",
  feedbackFile: ".visual-reviewer/feedback.jsonl",
};

export interface VisualReviewerOptions extends Partial<OracleConfig> {
  /** Where evidence bundles and reports are written. */
  outputDir?: string;
  /** Glob-ish substring filters on spec file paths; empty = all tests. */
  include?: string[];
  /** Run the AI judge automatically after the Playwright run. */
  judge?: boolean;
  /** Fail the reporter (not individual tests) on internal errors? */
  throwOnError?: boolean;
}

export function resolveOracleConfig(
  options: VisualReviewerOptions = {},
): OracleConfig {
  return {
    baseURL:
      options.baseURL ??
      process.env.VISUAL_REVIEWER_BASE_URL ??
      DEFAULT_ORACLE_CONFIG.baseURL,
    apiKeyEnvVar:
      options.apiKeyEnvVar ?? DEFAULT_ORACLE_CONFIG.apiKeyEnvVar,
    model: options.model ?? process.env.VISUAL_REVIEWER_MODEL ?? DEFAULT_ORACLE_CONFIG.model,
    maxScreenshots: options.maxScreenshots ?? DEFAULT_ORACLE_CONFIG.maxScreenshots,
    temperature: options.temperature ?? DEFAULT_ORACLE_CONFIG.temperature,
    timeoutMs: options.timeoutMs ?? DEFAULT_ORACLE_CONFIG.timeoutMs,
    baselines: options.baselines ?? DEFAULT_ORACLE_CONFIG.baselines,
    followUps: options.followUps ?? DEFAULT_ORACLE_CONFIG.followUps,
    followUpThreshold: options.followUpThreshold ?? DEFAULT_ORACLE_CONFIG.followUpThreshold,
    expectationsFile: options.expectationsFile ?? DEFAULT_ORACLE_CONFIG.expectationsFile,
    feedbackFile: options.feedbackFile ?? DEFAULT_ORACLE_CONFIG.feedbackFile,
  };
}

export function resolveOutputDir(outputDir?: string): string {
  return (
    outputDir ??
    process.env.VISUAL_REVIEWER_OUTPUT_DIR ??
    path.join(process.cwd(), ".visual-reviewer")
  );
}

export function resolveApiKey(config: OracleConfig): string | undefined {
  const key = process.env[config.apiKeyEnvVar];
  if (!key && config.baseURL.includes("api.openai.com")) return undefined;
  return key;
}

/** Where cached reports live relative to the output dir. */
export function reportPathFor(bundleDir: string): string {
  return path.join(path.dirname(bundleDir), "report.md");
}

export const USER_AGENT = `visual-reviewer/0.1 (${os.platform()}; ${os.arch()})`;
