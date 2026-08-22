import fs from "node:fs";
import path from "node:path";
import { generateText } from "ai";
import { readBundle } from "../evidence/store.js";
import { loadLatestHistory, loadAllHistory, saveHistoryRecord, detectFlakiness, type HistoryRecord } from "../evidence/history.js";
import { loadFeedbackForTest, type FeedbackRecord } from "../evidence/feedback.js";
import { buildSystemPrompt, buildUserContent } from "../context/builder.js";
import { resolveModel } from "./provider.js";
import { VerdictSchema, type Verdict } from "./schema.js";
import { followUpInstruction, gatherRequestedEvidence, parseEvidenceRequests } from "./followup.js";
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

  // Team expectations (org memory seed): inject when the file exists.
  let systemPrompt = buildSystemPrompt();
  try {
    const expectationsPath = path.resolve(config.expectationsFile);
    const feedback: FeedbackRecord[] = loadFeedbackForTest(
      path.resolve(config.feedbackFile),
      bundle.testId,
    );
    const feedbackBlock =
      feedback.length > 0
        ? feedback
            .map(
              (f) =>
                `- ${f.timestamp}: human ${f.accepted ? "ACCEPTED" : "REJECTED"} your ${f.verdict ?? "previous"} verdict${f.note ? ` — "${f.note}"` : ""}`,
            )
            .join("\n")
        : undefined;
    systemPrompt = buildSystemPrompt(
      fs.existsSync(expectationsPath) ? fs.readFileSync(expectationsPath, "utf8") : undefined,
      feedbackBlock,
    );
  } catch {
    /* no expectations/feedback — default prompt */
  }

  // Phase-2 baseline: compare against the most recent previous judgement.
  const history =
    config.baselines && bundle.status === "passed"
      ? loadLatestHistory(bundleDir)
      : null;
  const allHistory = config.baselines ? loadAllHistory(bundleDir) : [];
  const flakinessNote = detectFlakiness(allHistory) ?? undefined;
  const baseline = history
    ? {
        date: history.timestamp,
        verdict: history.verdict,
        confidence: history.confidence,
        deterministicStatus: history.deterministicStatus,
        assertionsPassed: history.assertionsPassed,
        assertionsTotal: history.assertionsTotal,
        screenshotFile: history.finalScreenshot,
        flakinessNote,
      }
    : null;
  let text = "";
  let verdict: Verdict | undefined;
  let lastRaw = "";
  // Cheap models occasionally wrap/precede the JSON with prose; retry once
  // with an explicit correction before giving up.
  for (let attempt = 0; attempt < 2 && !verdict; attempt++) {
    const result = await generateText({
      model,
      system: systemPrompt,
      messages: [
        { role: "user", content: buildUserContent(bundle, bundleDir, config.maxScreenshots, baseline) },
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

  // Bounded agentic round (§7): on UNCERTAIN or low confidence, let the
  // model request specific additional evidence and re-judge once.
  if (
    config.followUps &&
    (verdict.verdict === "UNCERTAIN" || verdict.confidence < config.followUpThreshold)
  ) {
    const fu = await generateText({
      model,
      system: systemPrompt,
      messages: [
        { role: "user", content: buildUserContent(bundle, bundleDir, config.maxScreenshots, baseline) },
        { role: "assistant", content: lastRaw.slice(0, 4000) },
        { role: "user", content: followUpInstruction() },
      ],
      temperature: config.temperature,
      abortSignal: AbortSignal.timeout(config.timeoutMs),
    });
    const requests = parseEvidenceRequests(fu.text);
    if (requests.length > 0) {
      const evidenceParts = gatherRequestedEvidence(bundle, bundleDir, requests);
      const second = await generateText({
        model,
        system: systemPrompt,
        messages: [
          { role: "user", content: buildUserContent(bundle, bundleDir, config.maxScreenshots, baseline) },
          { role: "assistant", content: lastRaw.slice(0, 4000) },
          {
            role: "user",
            content: [
              ...evidenceParts,
              {
                type: "text",
                text: "Based on your original observations plus this requested evidence, return your final verdict. Respond ONLY with the JSON verdict object.",
              },
            ],
          },
        ],
        temperature: config.temperature,
        abortSignal: AbortSignal.timeout(config.timeoutMs),
      });
      try {
        const refined = VerdictSchema.parse(extractJson(second.text));
        verdict = refined;
      } catch {
        /* keep the original verdict — investigation is best-effort */
      }
    }
  }

  // Advisory-only: write the report, never influence exit codes here.
  const reportPath = reportPathFor(bundlePath);
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, renderMarkdownReport(bundle, verdict, baseline));
  fs.writeFileSync(reportPath.replace(/\.md$/, ".html"), renderHtmlReport(bundle, verdict));

  // Persist this run for the next run's baseline comparison.
  const screenshots = bundle.evidence.filter((e) => e.type === "screenshot");
  const finalShot = screenshots[screenshots.length - 1];
  const record: HistoryRecord = {
    timestamp: new Date().toISOString(),
    verdict: verdict.verdict,
    confidence: verdict.confidence,
    deterministicStatus: bundle.status,
    assertionsPassed: bundle.assertions.filter((a) => a.passed).length,
    assertionsTotal: bundle.assertions.length,
    ...(typeof (finalShot?.content as { file?: string })?.file === "string"
      ? { finalScreenshot: (finalShot!.content as { file: string }).file }
      : {}),
  };
  try {
    saveHistoryRecord(bundleDir, record);
  } catch {
    /* history is best-effort */
  }

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

  // Advisory CI surfacing: job summary + ::warning annotations on GitHub.
  const gh = await import("../ci/github.js");
  if (gh.isGitHubCI()) {
    gh.writeStepSummary(results);
    gh.emitAnnotations(results);
  }
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
