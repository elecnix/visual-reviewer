import fs from "node:fs";
import path from "node:path";
import { generateText } from "ai";
import { readBundle } from "../evidence/store.js";
import { buildSystemPrompt, buildUserContent } from "../context/builder.js";
import { resolveModel } from "./provider.js";
import { VerdictSchema, type Verdict } from "./schema.js";
import type { OracleConfig } from "../config.js";
import { renderMarkdownReport } from "../report/markdown.js";
import { reportPathFor } from "../config.js";

/** Extract the first JSON object from model output (cheap models add prose). */
function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*(\{[\s\S]*\})\s*```/);
  const candidate = fenced?.[1] ?? text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
  return JSON.parse(candidate);
}

export interface Judgement {
  bundlePath: string;
  verdict?: Verdict;
  error?: string;
}

export async function judgeBundle(
  bundlePath: string,
  config: OracleConfig,
): Promise<Judgement> {
  const bundle = readBundle(bundlePath);
  const bundleDir = path.dirname(bundlePath);
  const model = resolveModel(config);

  const { text } = await generateText({
    model,
    system: buildSystemPrompt(),
    messages: [
      { role: "user", content: buildUserContent(bundle, bundleDir, config.maxScreenshots) },
    ],
    temperature: config.temperature,
    abortSignal: AbortSignal.timeout(config.timeoutMs),
  });

  let verdict: Verdict;
  try {
    verdict = VerdictSchema.parse(extractJson(text));
  } catch (err) {
    return {
      bundlePath,
      error: `Model returned unparseable verdict: ${
        err instanceof Error ? err.message : String(err)
      }\nRaw: ${text.slice(0, 500)}`,
    };
  }

  // Advisory-only: write the report, never influence exit codes here.
  const reportPath = reportPathFor(bundlePath);
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, renderMarkdownReport(bundle, verdict));

  return { bundlePath, verdict };
}

export async function judgeBundles(
  bundlePaths: string[],
  config: OracleConfig,
): Promise<Judgement[]> {
  const results: Judgement[] = [];
  for (const bundlePath of bundlePaths) {
    const bundle = readBundle(bundlePath);
    process.stdout.write(`[visual-reviewer] judging ${bundle.title} … `);
    try {
      const judgement = await judgeBundle(bundlePath, config);
      if (judgement.verdict) {
        console.log(
          `${judgement.verdict.verdict} (${Math.round(judgement.verdict.confidence * 100)}%)`,
        );
      } else {
        console.log("UNCERTAIN (parse failure)");
      }
      results.push(judgement);
    } catch (err) {
      console.log(`ERROR: ${err instanceof Error ? err.message : String(err)}`);
      results.push({ bundlePath, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return results;
}
