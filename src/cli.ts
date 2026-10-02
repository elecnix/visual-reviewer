#!/usr/bin/env node
/**
 * visual-reviewer CLI — judge saved evidence bundles, record feedback.
 *
 *   visual-reviewer judge [.visual-reviewer] [--model id] [--base-url url]
 *   visual-reviewer bench <scenariosDir> [--model id] [--seed dir]
 *   visual-reviewer feedback <bundleDir> --accept|--reject [--note "..."]
 *   visual-reviewer clusters [.visual-reviewer]
 *
 * Every subcommand shares one flag table (`COMMON_FLAGS` below); only
 * `bench` and `feedback` declare extras of their own.
 */
import path from "node:path";
import fs from "node:fs";
import { findBundles } from "./evidence/store.js";
import { resolveOracleConfig, resolveOutputDir, type VisualReviewerOptions } from "./config.js";
import { runJudgedBundles } from "./oracle/run.js";
import { VerdictSchema, type Verdict } from "./oracle/schema.js";
import { renderRunSummary } from "./report/markdown.js";

/**
 * One argument parser for every subcommand.
 *
 * `judge`, `bench` and `feedback` each had their own inline loop, and the
 * flag coverage had drifted: `--output-dir`, `--max-screenshots` and
 * `--no-baselines` worked for `judge` and were silently ignored (not
 * rejected) everywhere else. The shared table below is the single place a
 * flag is declared; a subcommand that does not want one simply ignores it,
 * which is the same forgiving behaviour, minus the four copies.
 *
 * Note `--no-judge` is deliberately still routed to `help`, not to
 * `options.judge`. That is what it has always done, and changing it is a
 * behaviour change, not a refactor. See the linked issue.
 */
const COMMON_FLAGS: Readonly<Record<string, (opt: VisualReviewerOptions, value: string) => void>> = {
  "--model": (o, v) => {
    o.model = v;
  },
  "--base-url": (o, v) => {
    o.baseURL = v;
  },
  "--api-key-env": (o, v) => {
    o.apiKeyEnvVar = v;
  },
  "--output-dir": (o, v) => {
    o.outputDir = v;
  },
  "--max-screenshots": (o, v) => {
    o.maxScreenshots = Number(v);
  },
  "--no-baselines": (o) => {
    o.baselines = false;
  },
  "--temperature": (o, v) => {
    o.temperature = Number(v);
  },
  "--timeout-ms": (o, v) => {
    o.timeoutMs = Number(v);
  },
  "--no-follow-ups": (o) => {
    o.followUps = false;
  },
};

interface ParsedArgs {
  dir: string;
  options: VisualReviewerOptions;
  help: boolean;
  /** Subcommand-specific flags, keyed by flag name. */
  extra: Record<string, string>;
}

/**
 * @param extras subcommand-only flags, mapped to whether they take a value.
 */
function parseArgs(
  argv: string[],
  extras: Readonly<Record<string, boolean>> = {},
): ParsedArgs {
  const options: VisualReviewerOptions = {};
  const extra: Record<string, string> = {};
  let dir = "";
  let help = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--no-judge" || arg === "-h" || arg === "--help") {
      help = true;
      continue;
    }
    const value = () => argv[++i] ?? "";
    const apply = COMMON_FLAGS[arg];
    if (apply) {
      apply(options, value());
      continue;
    }
    if (Object.prototype.hasOwnProperty.call(extras, arg)) {
      extra[arg] = extras[arg] ? value() : "true";
      continue;
    }
    if (!arg.startsWith("-")) dir = arg;
  }
  return { dir, options, help, extra };
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  if (command === "feedback") return feedbackMain(rest);
  if (command === "bench") return benchMain(rest);
  if (command === "clusters") return clustersMain(rest);
  return judgeMain([command, ...rest]);
}

const BENCH_HELP = `visual-reviewer bench <scenariosDir> [options]

Runs every scenario folder (bundle.json + expected.json) through the oracle and
reports detection rate, false positives/negatives and latency.

Options: the common options (--model, --base-url, --api-key-env, --output-dir,
--max-screenshots, --temperature, --timeout-ms, --no-baselines, --no-follow-ups)
plus --seed <dir> to seed starter scenarios into <dir>.
`;

const CLUSTERS_HELP = `Group regression verdicts by likely root cause (offline, no API key).

Usage:
  visual-reviewer clusters [dir] [--output-dir <dir>]

Reads bundle.json + verdict.json pairs under dir (default: ./.visual-reviewer)
and prints shared failure signatures across material verdicts.
`;

const FEEDBACK_HELP = `Record human feedback on an AI verdict (feeds future judgements).

Usage:
  visual-reviewer feedback <bundleDir> --accept|--reject [--note "..."] [--verdict REGRESSION]

<bundleDir> is a test's directory under the output dir (contains bundle.json).
`;

const JUDGE_HELP = `visual-reviewer — AI semantic test oracle (advisory)

Usage:
  visual-reviewer judge [dir] [options]

Judges every bundle.json under dir (default: ./.visual-reviewer).

Options:
  --model <id>          Provider model id (default: qwen/qwen3-vl-30b-a3b-instruct)
  --base-url <url>      OpenAI-compatible endpoint (default: https://openrouter.ai/api/v1)
  --api-key-env <name>  Env var holding the API key (default: OPENROUTER_API_KEY)
  --output-dir <dir>    Where bundles live / reports are written
  --max-screenshots <n> Max images per judgement (default: 6)
  --temperature <n>     Sampling temperature (default: 0)
  --timeout-ms <n>      Per-request timeout in ms (default: 120000)
  --no-baselines        Do not compare against previous runs
  --no-follow-ups       Disable the bounded additional-evidence round
`;

/** visual-reviewer bench <scenariosDir> [--model id] [--base-url url] */
async function benchMain(argv: string[]): Promise<void> {
  const { dir, options, help, extra } = parseArgs(argv, { "--seed": true });
  if (help) {
    console.log(BENCH_HELP);
    process.exit(0);
  }
  const { runBenchmark, seedStarterScenarios } = await import("./oracle/bench.js");

  let scenariosDir = dir || extra["--seed"] || "";
  const outputDir = resolveOutputDir(options.outputDir);
  if (!scenariosDir || !fs.existsSync(path.join(scenariosDir))) {
    // No scenario dir given (or missing): seed starters into a fresh one.
    scenariosDir = path.join(outputDir, "bench");
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

  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(
    path.join(outputDir, "bench-report.json"),
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
  const { dir, options, help } = parseArgs(argv);
  if (help) {
    console.log(CLUSTERS_HELP);
    process.exit(0);
  }

  const rootDir = resolveOutputDir(dir || options.outputDir);
  if (!fs.existsSync(rootDir)) {
    console.error(`No output dir at ${rootDir}. Run your Playwright suite with the visual-reviewer/reporter first.`);
    process.exit(1);
  }
  const { readBundle } = await import("./evidence/store.js");
  const { clusterRegressions, renderClusterSummary } = await import("./oracle/cluster.js");

  const bundles = findBundles(rootDir);
  if (bundles.length === 0) {
    console.error(`No evidence bundles found under ${rootDir}.`);
    process.exit(1);
  }

  const items: Array<{ bundle: ReturnType<typeof readBundle>; verdict?: Verdict }> = [];
  let missingVerdicts = 0;
  for (const bundlePath of bundles) {
    const bundle = readBundle(bundlePath);
    const verdictPath = path.join(path.dirname(bundlePath), "verdict.json");
    try {
      // Parsed through the schema rather than cast: a hand-edited or
      // truncated verdict.json used to sail through as `{verdict, confidence}`
      // and then be clustered as if it were a real judgement.
      const verdict = VerdictSchema.parse(JSON.parse(fs.readFileSync(verdictPath, "utf8")));
      items.push({ bundle, verdict });
    } catch {
      missingVerdicts += 1;
    }
  }

  console.log(
    `Loaded ${items.length} judged bundle(s) under ${rootDir}` +
      (missingVerdicts > 0 ? ` (${missingVerdicts} without a readable verdict.json — skipped)` : ""),
  );
  const summary = renderClusterSummary(clusterRegressions(items));
  if (summary) console.log(summary);
  else console.log("No shared failure signatures found across material verdicts.");
}

/** visual-reviewer feedback <bundleDir> --accept|--reject [--note "…"] [--verdict REGRESSION] */
async function feedbackMain(argv: string[]): Promise<void> {
  let accepted: boolean | undefined;
  let note: string | undefined;
  let verdict: string | undefined;
  const { dir, help, extra } = parseArgs(argv, {
    "--accept": false,
    "--reject": false,
    "--note": true,
    "--verdict": true,
  });
  if (extra["--accept"] !== undefined) accepted = true;
  if (extra["--reject"] !== undefined) accepted = false;
  if (extra["--note"] !== undefined) note = extra["--note"];
  if (extra["--verdict"] !== undefined) verdict = extra["--verdict"];
  if (help) {
    console.log(FEEDBACK_HELP);
    process.exit(0);
  }
  if (accepted === undefined) {
    console.error("feedback requires --accept or --reject");
    process.exit(5);
  }
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
    console.log(JUDGE_HELP);
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
  // The run owns its own exit policy; the CLI does not re-derive it.
  const run = await runJudgedBundles(bundles, { config });
  console.log(renderRunSummary(run.results));

  if (run.exitCode !== 0 && run.exitReason) {
    console.error(`Run failed: ${run.exitReason.split("\n")[0]}`);
  }
  process.exit(run.exitCode);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
