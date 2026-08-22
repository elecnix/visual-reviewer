#!/usr/bin/env node
/**
 * visual-reviewer CLI — judge saved evidence bundles.
 *
 *   visual-reviewer judge [.visual-reviewer] [--model id] [--base-url url]
 */
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
    else if (arg === "--no-judge" || arg === "-h" || arg === "--help") help = true;
    else if (!arg.startsWith("-")) dir = arg;
  }
  return { dir, options, help };
}

async function main(): Promise<void> {
  const { dir, options, help } = parseArgs(process.argv.slice(2));
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
