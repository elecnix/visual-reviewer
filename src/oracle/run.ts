import fs from "node:fs";
import path from "node:path";
import { readBundle } from "../evidence/store.js";
import { judgeBundle, type Judgement } from "./judge.js";
import { clusterRegressions, renderClusterSummary, type ClusterResult } from "./cluster.js";
import { renderHtmlIndex, type IndexEntry } from "../report/html.js";
import { createComplete } from "./provider.js";
import type { Complete } from "./complete.js";
import type { OracleConfig } from "../config.js";

/**
 * A judged run, end to end.
 *
 * `judge.ts` owns a *judgement*: one bundle in, one verdict or one error out.
 * It has no opinion about the run around it — no progress output, no run
 * index, no clustering, no CI surfacing, and above all no exit policy. Every
 * caller assembled those differently, which is how `cli.ts` ended up deciding
 * its own process exit code by substring-matching a word inside an error
 * message that a callee chose.
 *
 * This module owns the run. It is the only place that knows the sequence of
 * side effects, and it returns a typed result whose `exitCode` is a *value*
 * derived from each judgement's `outcome` rather than parsed out of prose.
 */

/**
 * Run-level side effects, named so a caller can opt out of one instead of
 * reimplementing the sequence to avoid it. `"index"`, `"clusters"` and
 * `"ci"` are the ones worth suppressing — e.g. a benchmark run should not
 * emit GitHub annotations, and a per-report invocation should not overwrite
 * the run index.
 */
export type RunSideEffect = "index" | "clusters" | "ci";

/** Everything a run writes beyond the per-bundle reports, which judge.ts owns. */
export const RUN_SIDE_EFFECTS: readonly RunSideEffect[] = ["index", "clusters", "ci"];

export interface RunOptions {
  config: OracleConfig;
  /** The oracle's only model seam. Defaults to the production provider. */
  complete?: Complete;
  /** Defaults to every run-level side effect. */
  sideEffects?: readonly RunSideEffect[];
  /** Print per-bundle progress. Defaults to true. */
  progress?: boolean;
}

export interface RunResult {
  /** One judgement per bundle, in input order, including the failures. */
  results: Judgement[];
  /** Present only when clustering ran and produced a cluster set. */
  clusters?: ClusterResult;
  /**
   * The process exit code this run implies: 2 if any bundle failed for a
   * reason the oracle could not express as a verdict, 0 otherwise.
   *
   * An UNCERTAIN verdict and an unparseable model reply are both exit 0 —
   * the oracle is advisory, and a flaky cheap model must not fail CI on its
   * own. A transport or provider failure is exit 2. That distinction used to
   * live in `cli.ts` as `!r.error.includes("unparseable")`.
   */
  exitCode: number;
  /** First hard failure in the run, for a human-facing log line. */
  exitReason?: string;
}

/**
 * The exit policy, in one place. Read off each judgement's `outcome`, so it
 * cannot drift when the wording of a message changes.
 *
 * A judgement with an `error` but no recorded `outcome` counts as a hard
 * failure: that is the conservative reading, and it is what the old
 * substring test did for every error except the parse-failure one.
 */
export function exitCodeFor(results: readonly Judgement[]): number {
  return results.some((r) => r.error && r.outcome !== "unparseable") ? 2 : 0;
}

/**
 * Judge every bundle as one run and return the run's result.
 *
 * Side effects, in order, each gated on `sideEffects`:
 *   per bundle  progress line                      (judge.ts writes reports)
 *   after       run-level HTML index               ("index")
 *   after       regression clustering + summary    ("clusters")
 *   after       CI job summary + annotations       ("ci", GitHub only)
 *
 * Per-bundle throwing is contained: one bad bundle is recorded as a failed
 * judgement and the run continues, exactly as before.
 */
export async function runJudgedBundles(
  bundlePaths: readonly string[],
  options: RunOptions,
): Promise<RunResult> {
  const { config, progress = true } = options;
  const sideEffects = new Set(options.sideEffects ?? RUN_SIDE_EFFECTS);

  // One completion seam for the whole run, so a scripted implementation can
  // drive every bundle in a run as well as a single judgement.
  const complete = options.complete ?? createComplete(config);

  const results: Judgement[] = [];
  for (const bundlePath of bundlePaths) {
    const bundle = readBundle(bundlePath);
    if (progress) process.stdout.write(`[visual-reviewer] judging ${bundle.title} … `);
    try {
      const judgement = await judgeBundle(bundlePath, config, complete);
      if (progress) {
        console.log(
          judgement.verdict
            ? `${judgement.verdict.verdict} (${Math.round(judgement.verdict.confidence * 100)}%)`
            : "UNCERTAIN (parse failure)",
        );
      }
      results.push(judgement);
    } catch (err) {
      if (progress) console.log(`ERROR: ${err instanceof Error ? err.message : String(err)}`);
      results.push({
        bundlePath,
        error: err instanceof Error ? err.message : String(err),
        outcome: "error",
      });
    }
  }

  // Regression clustering: many material verdicts often share one root cause.
  let clusters: ClusterResult | undefined;
  if (sideEffects.has("clusters")) {
    try {
      clusters = computeRunClusters(results);
      const summary = renderClusterSummary(clusters);
      if (summary) console.log(summary);
    } catch {
      /* clustering is advisory — never break the run over it */
    }
  }

  if (sideEffects.has("index")) writeRunIndex(bundlePaths, results, clusters);

  // Advisory CI surfacing: job summary + ::warning annotations on GitHub.
  if (sideEffects.has("ci")) {
    const gh = await import("../ci/github.js");
    if (gh.isGitHubCI()) {
      gh.writeStepSummary(results, clusters);
      gh.emitAnnotations(results);
    }
  }

  const exitCode = exitCodeFor(results);
  const firstHardFailure = results.find((r) => r.error && r.outcome !== "unparseable");
  return {
    results,
    ...(clusters ? { clusters } : {}),
    exitCode,
    ...(firstHardFailure ? { exitReason: firstHardFailure.error } : {}),
  };
}

/** Cluster judged verdicts by shared failure signatures across a run. */
export function computeRunClusters(results: readonly Judgement[]): ClusterResult {
  return clusterRegressions(
    results
      .filter((r) => r.verdict)
      .map((r) => ({ bundle: readBundle(r.bundlePath), verdict: r.verdict })),
  );
}

/** Run-level HTML index next to the per-test reports. */
function writeRunIndex(
  bundlePaths: readonly string[],
  results: readonly Judgement[],
  clusters?: ClusterResult,
): void {
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