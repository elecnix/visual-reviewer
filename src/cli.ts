#!/usr/bin/env node
/**
 * visual-reviewer CLI — judge saved evidence bundles, record feedback.
 *
 *   visual-reviewer judge [.visual-reviewer] [--model id] [--base-url url]
 *   visual-reviewer feedback <bundleDir> --accept|--reject [--note "..."]
 *   visual-reviewer clusters [.visual-reviewer]
 */
import path from "node:path";
import fs from "node:fs";
import { findBundles } from "./evidence/store.js";
import { resolveOracleConfig, resolveOutputDir, type VisualReviewerOptions } from "./config.js";
import { judgeBundles } from "./oracle/judge.js";
import { renderRunSummary } from "./report/markdown.js";

function parseArgs(argv: string[]): {
  dir: string;
  options: VisualReviewerOptions;
  help: boolean;
} {
  const options: VisualReviewerOptions = {};
  let dir = "";
  let help = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--model") options.model = argv[++i];
    else if (arg === "--base-url") options.baseURL = argv[++i];
    else if (arg === "--api-key-env") options.apiKeyEnvVar = argv[++i];
    else if (arg === "--output-dir") options.outputDir = argv[++i];
    else if (arg === "--max-screenshots") options.maxScreenshots = Number(argv[++i]);
    else if (arg === "--no-baselines") options.baselines = false;
    else if (arg === "--no-judge" || arg === "-h" || arg === "--help") help = true;
    else if (!arg.startsWith("-")) dir = arg;
  }
  return { dir, options, help };
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  if (command === "feedback") return feedbackMain(rest);
  if (command === "bench") return benchMain(rest);
  if (command === "clusters") return clustersMain(rest);
  return judgeMain([command, ...rest]);
}

/** visual-reviewer bench <scenariosDir> [--model id] [--base-url url] */
async function benchMain(argv: string[]): Promise<void> {
  let dir = "";
  const options: VisualReviewerOptions = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--model") options.model = argv[++i];
    else if (arg === "--base-url") options.baseURL = argv[++i];
    else if (arg === "--api-key-env") options.apiKeyEnvVar = argv[++i];
    else if (arg === "--seed") dir = argv[++i];
    else if (!arg.startsWith("-")) dir = arg;
  }
  const { resolveOracleConfig } = await import("./config.js");
  const { runBenchmark, seedStarterScenarios } = await import("./oracle/bench.js");

  let scenariosDir = dir;
  if (!scenariosDir || !fs.existsSync(path.join(scenariosDir))) {
    // No scenario dir given (or missing): seed starters into a fresh one.
    scenariosDir = path.resolve(".visual-reviewer/bench");
    if (!fs.existsSync(scenariosDir)) {
      seedStarterScenarios(scenariosDir);
      console.log(`Seeded starter scenarios into ${scenariosDir}`);
    }
  }

  console.log(`Running benchmark from ${scenariosDir} …`);
  const config = resolveOracleConfig(options);
  const report = await runBenchmark(scenariosDir, config);

  console.log("");
  console.log(`Scenarios: ${report.scenarios} | Judged: ${report.judged}`);
  console.log(`Correct:   ${report.correct}/${report.scenarios} (${Math.round(report.detectionRate * 100)}%)`);
  console.log(`False positives: ${report.falsePositives} | False negatives: ${report.falseNegatives}`);
  console.log(`Latency: avg ${report.avgLatencyMs}ms`);
  for (const c of report.cases) {
    console.log(
      `  ${c.correct ? "✓" : "✗"} ${c.name}: expected ${c.expected}, got ${c.actual ?? "ERROR"} (${c.latencyMs}ms)`,
    );
  }

  fs.writeFileSync(
    path.join(process.cwd(), ".visual-reviewer", "bench-report.json"),
    JSON.stringify(report, null, 2),
  );
}

/**
 * visual-reviewer clusters [.visual-reviewer]
 *
 * Offline: groups already-saved verdicts by shared failure signatures
 * (failing endpoints, console errors, crashes). Needs no API key.
 */
async function clustersMain(argv: string[]): Promise<void> {
  let dir = "";
  for (const arg of argv) {
    if (arg === "-h" || arg === "--help") {
      console.log(`Group regression verdicts by likely root cause (offline, no API key).

Usage:
  visual-reviewer clusters [dir]

Reads bundle.json + verdict.json pairs under dir (default: ./.visual-reviewer)
and prints shared failure signatures across material verdicts.
`);
      process.exit(0);
    } else if (!arg.startsWith("-")) dir = arg;
  }

  const rootDir = resolveOutputDir(dir || undefined);
  if (!fs.existsSync(rootDir)) {
    console.error(`No output dir at ${rootDir}. Run your Playwright suite with the visual-reviewer/reporter first.`);
    process.exit(1);
  }
  const { readBundle, findBundles } = await import("./evidence/store.js");
  const { clusterRegressions, renderClusterSummary } = await import("./oracle/cluster.js");

  const bundles = findBundles(rootDir);
  if (bundles.length === 0) {
    console.error(`No evidence bundles found under ${rootDir}.`);
    process.exit(1);
  }

  type AnyBundle = ReturnType<typeof readBundle>;
  const items: Array<{ bundle: AnyBundle; verdict?: { verdict: string; confidence: number } }> = [];
  let missingVerdicts = 0;
  for (const bundlePath of bundles) {
    const bundle = readBundle(bundlePath);
    const verdictPath = path.join(path.dirname(bundlePath), "verdict.json");
    try {
      const verdict = JSON.parse(fs.readFileSync(verdictPath, "utf8")) as {
        verdict: string;
        confidence: number;
      };
      items.push({ bundle, verdict });
    } catch {
      missingVerdicts += 1;
    }
  }

  console.log(
    `Loaded ${items.length} judged bundle(s) under ${rootDir}` +
      (missingVerdicts > 0 ? ` (${missingVerdicts} without verdict.json — skipped)` : ""),
  );
  const summary = renderClusterSummary(clusterRegressions(items));
  if (summary) console.log(summary);
  else console.log("No shared failure signatures found across material verdicts.");
}

/** visual-reviewer feedback <bundleDir> --accept|--reject [--note "…"] [--verdict REGRESSION] */
async function feedbackMain(argv: string[]): Promise<void> {
  let dir = "";
  let accepted: boolean | undefined;
  let note: string | undefined;
  let verdict: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--accept") accepted = true;
    else if (arg === "--reject") accepted = false;
    else if (arg === "--note") note = argv[++i];
    else if (arg === "--verdict") verdict = argv[++i];
    else if (arg === "-h" || arg === "--help") {
      console.log(`Record human feedback on an AI verdict (feeds future judgements).

Usage:
  visual-reviewer feedback <bundleDir> --accept|--reject [--note "..."] [--verdict REGRESSION]

<bundleDir> is a test's directory under the output dir (contains bundle.json).
`);
      process.exit(0);
    } else if (!arg.startsWith("-")) dir = arg;
  }
  if (accepted === undefined) {
    console.error("feedback requires --accept or --reject");
    process.exit(5);
  }
  const { resolveOracleConfig } = await import("./config.js");
  const { readBundle } = await import("./evidence/store.js");
  const { saveFeedbackRecord } = await import("./evidence/feedback.js");
  const config = resolveOracleConfig();
  const bundlePath = path.resolve(dir, "bundle.json");
  const bundle = readBundle(bundlePath);
  saveFeedbackRecord(path.resolve(config.feedbackFile), {
    timestamp: new Date().toISOString(),
    testId: bundle.testId,
    title: bundle.title,
    accepted,
    verdict,
    note,
  });
  console.log(
    `Recorded ${accepted ? "ACCEPTANCE" : "REJECTION"} of ${verdict ?? "previous"} verdict for "${bundle.title}".`,
  );
}

async function judgeMain(argv: string[]): Promise<void> {
  const { dir, options, help } = parseArgs(argv);
  if (help) {
    console.log(`visual-reviewer — AI semantic test oracle (advisory)

Usage:
  visual-reviewer judge [dir] [options]

Judges every bundle.json under dir (default: ./.visual-reviewer).

Options:
  --model <id>          Provider model id (default: qwen/qwen3-vl-30b-a3b-instruct)
  --base-url <url>      OpenAI-compatible endpoint (default: https://openrouter.ai/api/v1)
  --api-key-env <name>  Env var holding the API key (default: OPENROUTER_API_KEY)
  --output-dir <dir>    Where bundles live / reports are written
  --max-screenshots <n> Max images per judgement (default: 6)
`);
    process.exit(0);
  }

  const rootDir = resolveOutputDir(dir || options.outputDir);
  const bundles = findBundles(rootDir);
  if (bundles.length === 0) {
    console.error(`No evidence bundles found under ${rootDir}. Run your Playwright suite with the visual-reviewer/reporter first.`);
    process.exit(1);
  }
  console.log(`Found ${bundles.length} bundle(s) under ${rootDir}`);

  const config = resolveOracleConfig(options);
  const results = await judgeBundles(bundles, config);
  console.log(renderRunSummary(results));

  const hardErrors = results.filter((r) => r.error && !r.error.includes("unparseable"));
  process.exit(hardErrors.length > 0 ? 2 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
