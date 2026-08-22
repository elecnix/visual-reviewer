import fs from "node:fs";
import path from "node:path";
import { generateText } from "ai";
import { readBundle } from "../evidence/store.js";
import { buildSystemPrompt, buildUserContent } from "../context/builder.js";
import { resolveModel } from "./provider.js";
import { VerdictSchema, type Verdict } from "./schema.js";
import type { OracleConfig } from "../config.js";
import { renderMarkdownReport } from "../report/markdown.js";
import { renderHtmlIndex, renderHtmlReport, type IndexEntry } from "../report/html.js";
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

  let text = "";
  let verdict: Verdict | undefined;
  let lastRaw = "";
  // Cheap models occasionally wrap/precede the JSON with prose; retry once
  // with an explicit correction before giving up.
  for (let attempt = 0; attempt < 2 && !verdict; attempt++) {
    const result = await generateText({
      model,
      system: buildSystemPrompt(),
      messages: [
        { role: "user", content: buildUserContent(bundle, bundleDir, config.maxScreenshots) },
        ...(attempt > 0
          ? ([
              { role: "assistant", content: lastRaw.slice(0, 2000) },
              {
                role: "user",
                content:
                  "Your previous reply was not a valid JSON verdict object. Respond again with ONLY the JSON object, no prose, no code fences.",
              },
            ] as const)
          : []),
      ],
      temperature: config.temperature,
      abortSignal: AbortSignal.timeout(config.timeoutMs),
    });
    text = result.text;
    lastRaw = text;
    try {
      verdict = VerdictSchema.parse(extractJson(text));
    } catch {
      verdict = undefined;
    }
  }

  if (!verdict) {
    return {
      bundlePath,
      error: `Model returned unparseable verdict after retry.\nRaw: ${text.slice(0, 500)}`,
    };
  }

  // Advisory-only: write the report, never influence exit codes here.
  const reportPath = reportPathFor(bundlePath);
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, renderMarkdownReport(bundle, verdict));
  fs.writeFileSync(reportPath.replace(/\.md$/, ".html"), renderHtmlReport(bundle, verdict));

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

  writeRunIndex(bundlePaths, results);
  return results;
}

/** Run-level HTML index next to the per-test reports. */
function writeRunIndex(bundlePaths: string[], results: Judgement[]): void {
  if (bundlePaths.length === 0) return;
  const outputDir = path.dirname(path.dirname(path.resolve(bundlePaths[0])));
  const entries: IndexEntry[] = results.map((r) => {
    const bundleDir = path.dirname(path.resolve(r.bundlePath));
    const bundle = readBundle(r.bundlePath);
    return {
      title: bundle.title,
      href: path.relative(outputDir, path.join(bundleDir, "report.html")),
      verdict: r.verdict?.verdict,
      error: r.error,
    };
  });
  fs.writeFileSync(path.join(outputDir, "report.html"), renderHtmlIndex(entries));
}
