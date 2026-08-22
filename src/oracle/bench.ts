import fs from "node:fs";
import path from "node:path";
import { findBundles } from "../evidence/store.js";
import { judgeBundle, type Judgement } from "./judge.js";
import type { OracleConfig } from "../config.js";

/**
 * Evaluation harness (brief §18). A benchmark is a directory of scenario
 * folders, each containing:
 *   bundle.json      — evidence bundle (hand-crafted or captured from a run)
 *   expected.json    — {"expectVerdict": "REGRESSION" | "PASS" | "UNCERTAIN", "name": "..."}
 *
 * Runs every scenario through the real oracle and reports detection rate,
 * false positives/negatives and latency. This is the metric that decides
 * model choice, prompt changes and thresholds — not vibes.
 */

export interface BenchCaseResult {
  name: string;
  expected: string;
  actual?: string;
  confidence?: number;
  correct: boolean;
  latencyMs: number;
  error?: string;
}

export interface BenchReport {
  scenarios: number;
  judged: number;
  correct: number;
  detectionRate: number;
  falsePositives: number;
  falseNegatives: number;
  totalLatencyMs: number;
  avgLatencyMs: number;
  cases: BenchCaseResult[];
}

const VALID_EXPECTED = ["PASS", "REGRESSION", "FAIL", "UNCERTAIN"];

function classify(expected: string, actual?: string): "correct" | "falsePositive" | "falseNegative" | "missed" | "incorrect" {
  if (!actual) return "missed";
  if (actual === expected) return "correct";
  // A REGRESSION/FAIL verdict on a scenario expecting PASS is a false positive.
  // A PASS on a scenario expecting REGRESSION/FAIL is a false negative.
  const badActual = actual === "REGRESSION" || actual === "FAIL";
  const badExpected = expected === "REGRESSION" || expected === "FAIL";
  if (badActual && !badExpected) return "falsePositive";
  if (!badActual && badExpected) return "falseNegative";
  return "incorrect"; // e.g. UNCERTAIN vs either — counted as incorrect only
}

export async function runBenchmark(
  scenariosDir: string,
  config: OracleConfig,
): Promise<BenchReport> {
  const caseDirs = fs
    .readdirSync(scenariosDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => path.join(scenariosDir, d.name));

  const cases: BenchCaseResult[] = [];
  for (const dir of caseDirs) {
    const expectedPath = path.join(dir, "expected.json");
    if (!fs.existsSync(path.join(dir, "bundle.json")) || !fs.existsSync(expectedPath)) continue;
    let expected: { expectVerdict?: string; name?: string };
    try {
      expected = JSON.parse(fs.readFileSync(expectedPath, "utf8"));
    } catch {
      continue;
    }
    const expectVerdict = String(expected.expectVerdict ?? "").toUpperCase();
    if (!VALID_EXPECTED.includes(expectVerdict)) continue;

    // Point judgeBundle at this scenario's own directory.
    const bundlePath = path.join(dir, "bundle.json");
    const started = Date.now();
    let judgement: Judgement;
    try {
      judgement = await judgeBundle(bundlePath, config);
    } catch (err) {
      judgement = { bundlePath, error: err instanceof Error ? err.message : String(err) };
    }
    const latencyMs = Date.now() - started;

    cases.push({
      name: expected.name ?? path.basename(dir),
      expected: expectVerdict,
      actual: judgement.verdict?.verdict,
      confidence: judgement.verdict?.confidence,
      correct: classify(expectVerdict, judgement.verdict?.verdict) === "correct",
      latencyMs,
      error: judgement.error,
    });
  }

  const judged = cases.filter((c) => c.actual !== undefined);
  const correct = cases.filter((c) => c.correct);
  return {
    scenarios: cases.length,
    judged: judged.length,
    correct: correct.length,
    detectionRate: cases.length > 0 ? correct.length / cases.length : 0,
    falsePositives: cases.filter((c) => classify(c.expected, c.actual) === "falsePositive").length,
    falseNegatives: cases.filter((c) => classify(c.expected, c.actual) === "falseNegative").length,
    totalLatencyMs: cases.reduce((sum, c) => sum + c.latencyMs, 0),
    avgLatencyMs: cases.length > 0 ? Math.round(cases.reduce((s, c) => s + c.latencyMs, 0) / cases.length) : 0,
    cases,
  };
}

/** Seed two starter scenarios under <dir> so `visual-reviewer bench` works out of the box. */
export function seedStarterScenarios(dir: string): void {
  const regressionBundle = {
    schemaVersion: 1,
    runId: "bench",
    testId: "bench-regression-1",
    title: "bench: upgrade shows success despite declined payment",
    file: "upgrade.spec.ts",
    sourceCode: `test("user upgrades subscription", async ({ page }) => {
  await page.click("#upgrade");
  await expect(page.getByText("Pro plan")).toBeVisible();
});`,
    status: "passed",
    durationMs: 3000,
    assertions: [{ title: "expect(toBeVisible) — Pro plan", passed: true }],
    evidence: [
      {
        id: "ev-n1",
        timestamp: 2000,
        type: "network_event",
        source: "fixture:page",
        content: {
          method: "POST",
          url: "https://api.example.com/api/subscription",
          status: 200,
          body: '{"success":false,"error":"card_declined"}',
        },
      },
      {
        id: "ev-a1",
        timestamp: 2500,
        type: "accessibility_tree",
        source: "fixture:page",
        content: "- heading 'Pro plan'\n- paragraph '$29/month'\n- text: Payment could not be completed",
      },
    ],
    artifacts: {},
  };

  const passBundle = {
    ...regressionBundle,
    testId: "bench-pass-1",
    title: "bench: successful upgrade",
    evidence: [
      {
        id: "ev-n2",
        timestamp: 2000,
        type: "network_event",
        source: "fixture:page",
        content: {
          method: "POST",
          url: "https://api.example.com/api/subscription",
          status: 200,
          body: '{"success":true,"plan":"pro"}',
        },
      },
      {
        id: "ev-a2",
        timestamp: 2500,
        type: "accessibility_tree",
        source: "fixture:page",
        content: "- heading 'Pro plan'\n- paragraph '$29/month'\n- text: Upgrade complete",
      },
    ],
  };

  const writeScenario = (name: string, bundle: unknown, expectVerdict: string) => {
    const scenarioDir = path.join(dir, name);
    fs.mkdirSync(scenarioDir, { recursive: true });
    fs.writeFileSync(path.join(scenarioDir, "bundle.json"), JSON.stringify(bundle, null, 2));
    fs.writeFileSync(
      path.join(scenarioDir, "expected.json"),
      JSON.stringify({ expectVerdict, name }, null, 2),
    );
  };

  writeScenario("declined-payment-behind-200", regressionBundle, "REGRESSION");
  writeScenario("successful-upgrade", passBundle, "PASS");
}
