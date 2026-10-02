import fs from "node:fs";
import path from "node:path";
import { readBundle } from "../evidence/store.js";
import type { EvidenceBundle } from "../evidence/model.js";
import { loadLatestHistory, loadAllHistory, saveHistoryRecord, detectFlakiness, type HistoryRecord } from "../evidence/history.js";
import { loadFeedbackForTest, type FeedbackRecord } from "../evidence/feedback.js";
import { buildSystemPrompt, buildUserContent } from "../context/builder.js";
import { createComplete } from "./provider.js";
import type { Complete, UserContent } from "./complete.js";
import { VerdictSchema, extractVerdictJson, type Verdict } from "./schema.js";
import { followUpInstruction, gatherRequestedEvidence, parseEvidenceRequests } from "./followup.js";
import { clusterRegressions, renderClusterSummary, type ClusterResult } from "./cluster.js";
import type { OracleConfig } from "../config.js";
import { renderMarkdownReport } from "../report/markdown.js";
import { renderHtmlIndex, renderHtmlReport, type IndexEntry } from "../report/html.js";
import { reportPathFor } from "../config.js";

export interface Judgement {
  bundlePath: string;
  verdict?: Verdict;
  error?: string;
}

/** How many times the verdict ladder re-asks before giving up. */
const MAX_PARSE_ATTEMPTS = 3;

const RETRY_INSTRUCTION =
  "Your previous reply was not a valid JSON verdict object. Respond again with ONLY the JSON object, no prose, no code fences.";

const FINAL_INSTRUCTION =
  "Based on your original observations plus this requested evidence, return your final verdict. Respond ONLY with the JSON verdict object.";

/** Everything a round needs that does not depend on its own messages. */
interface RoundOptions {
  complete: Complete;
  systemPrompt: string;
  temperature: number;
  timeoutMs: number;
  /**
   * Rebuilds the evidence dossier for a round. Called once per model call:
   * the retry ladder re-reads every screenshot off disk on each attempt
   * (see `context/builder.ts`), so the call count is the cost policy and it
   * is deliberately left where it was.
   */
  userContent: () => UserContent;
}

/**
 * Verdict ladder. Cheap models wrap, preface or slightly corrupt the verdict
 * JSON, so re-ask up to twice, feeding back the previous raw reply as an
 * assistant turn. Returns the first verdict that parses, or undefined with
 * the last raw reply kept for diagnosis.
 */
async function runVerdictLadder(
  opts: RoundOptions,
): Promise<{ verdict: Verdict | undefined; lastRaw: string }> {
  let lastRaw = "";
  for (let attempt = 0; attempt < MAX_PARSE_ATTEMPTS; attempt++) {
    const { text } = await opts.complete({
      system: opts.systemPrompt,
      temperature: opts.temperature,
      timeoutMs: opts.timeoutMs,
      messages: [
        { role: "user", content: opts.userContent() },
        ...(attempt > 0
          ? ([
              { role: "assistant", content: lastRaw.slice(0, 2000) },
              { role: "user", content: RETRY_INSTRUCTION },
            ] as const)
          : []),
      ],
    });
    lastRaw = text;
    try {
      return { verdict: VerdictSchema.parse(extractVerdictJson(text)), lastRaw };
    } catch {
      /* cheap models often emit prose around the JSON — ask again */
    }
  }
  return { verdict: undefined, lastRaw };
}

/**
 * Bounded agentic round: on UNCERTAIN or low confidence, let the model request
 * specific additional evidence and re-judge. At most one round, and a failed
 * round keeps the original verdict — investigation is best-effort.
 */
async function runFollowUpRound(
  opts: RoundOptions,
  bundle: EvidenceBundle,
  bundleDir: string,
  verdict: Verdict,
  lastRaw: string,
): Promise<Verdict> {
  const base = {
    system: opts.systemPrompt,
    temperature: opts.temperature,
    timeoutMs: opts.timeoutMs,
  };
  const { text: followUpText } = await opts.complete({
    ...base,
    messages: [
      { role: "user", content: opts.userContent() },
      { role: "assistant", content: lastRaw.slice(0, 4000) },
      { role: "user", content: followUpInstruction() },
    ],
  });
  const requests = parseEvidenceRequests(followUpText);
  if (requests.length === 0) return verdict;

  const evidenceParts = gatherRequestedEvidence(bundle, bundleDir, requests);
  const { text: refinedText } = await opts.complete({
    ...base,
    messages: [
      { role: "user", content: opts.userContent() },
      { role: "assistant", content: lastRaw.slice(0, 4000) },
      { role: "user", content: [...evidenceParts, { type: "text", text: FINAL_INSTRUCTION }] },
    ],
  });
  try {
    return VerdictSchema.parse(extractVerdictJson(refinedText));
  } catch {
    /* keep the original verdict — investigation is best-effort */
  }
  return verdict;
}

export async function judgeBundle(
  bundlePath: string,
  config: OracleConfig,
  complete: Complete = createComplete(config),
): Promise<Judgement> {
  const bundle = readBundle(bundlePath);
  const bundleDir = path.dirname(bundlePath);

  // Team expectations (org memory seed) + human feedback on previous
  // verdicts. Any read failure falls back to the default prompt; the prompt
  // itself is pure, so it is built exactly once, on whichever path is taken.
  let systemPrompt: string;
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
    systemPrompt = buildSystemPrompt();
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
  const round: RoundOptions = {
    complete,
    systemPrompt,
    temperature: config.temperature,
    timeoutMs: config.timeoutMs,
    userContent: () => buildUserContent(bundle, bundleDir, config.maxScreenshots, baseline),
  };

  const ladder = await runVerdictLadder(round);
  let verdict = ladder.verdict;
  const { lastRaw } = ladder;

  if (!verdict) {
    // Keep the full raw output for diagnosis — the error message only
    // carries a 500-char preview.
    try {
      fs.writeFileSync(path.join(bundleDir, "verdict-error.txt"), lastRaw);
    } catch {
      /* best-effort */
    }
    return {
      bundlePath,
      error: `Model returned unparseable verdict after retry.\nRaw: ${lastRaw.slice(0, 500)}`,
    };
  }

  // Bounded agentic round (§7): on UNCERTAIN or low confidence, let the
  // model request specific additional evidence and re-judge once.
  if (
    config.followUps &&
    (verdict.verdict === "UNCERTAIN" || verdict.confidence < config.followUpThreshold)
  ) {
    verdict = await runFollowUpRound(round, bundle, bundleDir, verdict, lastRaw);
  }

  // Advisory-only: write the report, never influence exit codes here.
  const reportPath = reportPathFor(bundlePath);
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, renderMarkdownReport(bundle, verdict, baseline));
  fs.writeFileSync(reportPath.replace(/\.md$/, ".html"), renderHtmlReport(bundle, verdict));
  // Machine-readable verdict for post-hoc tooling (clustering, evals).
  fs.writeFileSync(path.join(bundleDir, "verdict.json"), JSON.stringify(verdict, null, 2));

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
  complete?: Complete,
): Promise<Judgement[]> {
  // One completion seam for the whole run, so a scripted implementation can
  // drive every bundle in a run as well as a single judgement.
  const completeRun = complete ?? createComplete(config);
  const results: Judgement[] = [];
  for (const bundlePath of bundlePaths) {
    const bundle = readBundle(bundlePath);
    process.stdout.write(`[visual-reviewer] judging ${bundle.title} … `);
    try {
      const judgement = await judgeBundle(bundlePath, config, completeRun);
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

  // Regression clustering: many material verdicts often share one root cause.
  let clusters: ClusterResult | undefined;
  try {
    clusters = computeClusters(results);
    const summary = renderClusterSummary(clusters);
    if (summary) console.log(summary);
  } catch {
    /* clustering is advisory — never break the run over it */
  }

  // Advisory CI surfacing: job summary + ::warning annotations on GitHub.
  const gh = await import("../ci/github.js");
  if (gh.isGitHubCI()) {
    gh.writeStepSummary(results, clusters);
    gh.emitAnnotations(results);
  }
  return results;
}

/** Cluster material verdicts by shared failure signatures across a run. */
export function computeClusters(results: Judgement[]): ClusterResult {
  return clusterRegressions(
    results
      .filter((r) => r.verdict)
      .map((r) => ({ bundle: readBundle(r.bundlePath), verdict: r.verdict })),
  );
}

/** Run-level HTML index next to the per-test reports. */
function writeRunIndex(bundlePaths: string[], results: Judgement[], clusters?: ClusterResult): void {
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
  fs.writeFileSync(path.join(outputDir, "report.html"), renderHtmlIndex(entries, clusters));
}
