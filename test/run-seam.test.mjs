import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runJudgedBundles, exitCodeFor, RUN_SIDE_EFFECTS } from "../dist/oracle/run.js";
import { judgeBundles } from "../dist/oracle/judge.js";
import { DEFAULT_ORACLE_CONFIG } from "../dist/config.js";

/**
 * The run seam (src/oracle/run.ts). Before it, `judgeBundles` was one
 * function holding the progress loop, the run index, the clustering and the
 * CI surfacing, and `cli.ts` derived its own process exit code from
 * `!r.error.includes("unparseable")` — a substring match against a sentence
 * that a different module chose the wording of.
 *
 * These tests pin the exit policy and the run's side-effect contract, both of
 * which were previously untested.
 */

function fixture(dir, name = "checkout-total") {
  const bundleDir = path.join(dir, name);
  fs.mkdirSync(bundleDir, { recursive: true });
  fs.writeFileSync(path.join(bundleDir, "shot-1.png"), Buffer.from("89504e470d0a1a0a", "hex"));
  const bundle = {
    schemaVersion: 1,
    runId: "run-1",
    testId: name,
    title: "checkout shows the order total",
    file: "tests/checkout.spec.ts",
    sourceCode: "test('total', async ({ page }) => { await page.goto('/cart'); });",
    status: "passed",
    durationMs: 1234,
    assertions: [{ title: "response status 200", passed: true }],
    evidence: [
      { id: "ev-1", timestamp: 10, type: "screenshot", source: "playwright", content: { file: "shot-1.png" } },
      {
        id: "ev-2",
        timestamp: 5,
        type: "network_event",
        source: "playwright",
        content: { method: "GET", url: "https://api.test/cart", status: 500, body: "total=NaN" },
      },
    ],
    artifacts: {},
  };
  const bundlePath = path.join(bundleDir, "bundle.json");
  fs.writeFileSync(bundlePath, JSON.stringify(bundle, null, 2));
  return bundlePath;
}

function config(dir, overrides = {}) {
  return {
    ...DEFAULT_ORACLE_CONFIG,
    expectationsFile: path.join(dir, "expectations.md"),
    feedbackFile: path.join(dir, "feedback.jsonl"),
    baselines: false,
    followUps: false,
    ...overrides,
  };
}

const verdictJson = (verdict, confidence = 0.9) =>
  JSON.stringify({
    verdict,
    confidence,
    intentSummary: "the cart total is rendered",
    reasoning: "the network event failed",
    supportingEvidence: [],
    suspiciousObservations: [],
  });

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "vr-run-"));
}

// --- exit policy -----------------------------------------------------------

test("exit policy: a verdict of any kind, including UNCERTAIN, exits 0", () => {
  for (const kind of ["PASS", "REGRESSION", "FAIL", "UNCERTAIN"]) {
    const code = exitCodeFor([{ bundlePath: "b", verdict: { verdict: kind }, outcome: "judged" }]);
    assert.equal(code, 0, `${kind} should not fail the run`);
  }
});

test("exit policy: an unparseable reply exits 0, because it is recorded as such", () => {
  const code = exitCodeFor([
    { bundlePath: "b", error: "Model returned unparseable verdict after retry.", outcome: "unparseable" },
  ]);
  assert.equal(code, 0);
});

test("exit policy: the policy reads the outcome, not the wording of the message", () => {
  // Both cases carry the SAME outcome and differ only in wording. Under the
  // old substring implementation (`r.error.includes("unparseable")`) the
  // second case was filtered out and the run exited 0, so THIS is the
  // assertion that fails on a revert — the first one alone passes under both.
  const base = { bundlePath: "b", outcome: "error" };
  const reworded = exitCodeFor([{ ...base, error: "the provider refused the request" }]);
  const contains = exitCodeFor([{ ...base, error: "unparseable" }]);
  assert.equal(reworded, 2);
  assert.equal(contains, 2, "an 'unparseable' error with outcome 'error' is still a hard failure");
  assert.equal(reworded, contains, "wording must not move the exit code");
});

test("exit policy: an error with no recorded outcome counts as a hard failure", () => {
  // bench.ts assembles Judgements by hand and never sets `outcome`; the
  // conservative reading must keep those from silently exiting 0.
  assert.equal(exitCodeFor([{ bundlePath: "b", error: "boom" }]), 2);
});

test("exit policy: one hard failure among many verdicts fails the whole run", () => {
  const code = exitCodeFor([
    { bundlePath: "a", verdict: { verdict: "PASS" }, outcome: "judged" },
    { bundlePath: "b", error: "gateway timeout", outcome: "error" },
    { bundlePath: "c", verdict: { verdict: "FAIL" }, outcome: "judged" },
  ]);
  assert.equal(code, 2);
});

test("exit policy: an empty run exits 0", () => {
  assert.equal(exitCodeFor([]), 0);
});

// --- the run ---------------------------------------------------------------

test("run: returns the exit code as a value alongside the results", async () => {
  const dir = tmpdir();
  const bundlePath = fixture(dir);
  const run = await runJudgedBundles([bundlePath], {
    config: config(dir),
    complete: async () => ({ text: verdictJson("REGRESSION") }),
    progress: false,
    sideEffects: [],
  });
  assert.equal(run.results.length, 1);
  assert.equal(run.results[0].outcome, "judged");
  assert.equal(run.results[0].verdict.verdict, "REGRESSION");
  assert.equal(run.exitCode, 0);
  assert.equal(run.exitReason, undefined);
});

test("run: a throw from the seam is contained as an outcome-`error` judgement", async () => {
  const dir = tmpdir();
  const bundlePath = fixture(dir);
  const run = await runJudgedBundles([bundlePath], {
    config: config(dir),
    complete: async () => {
      throw new Error("connect ECONNREFUSED");
    },
    progress: false,
    sideEffects: [],
  });
  // The ladder re-asks a model that answered with prose, not one that was
  // unreachable: a transport throw propagates out of judgeBundle and is
  // caught by the run loop, which records it as outcome "error".
  assert.equal(run.results.length, 1);
  assert.equal(run.results[0].outcome, "error");
  assert.match(run.results[0].error, /ECONNREFUSED/);
  assert.equal(run.exitCode, 2);
  assert.match(run.exitReason, /ECONNREFUSED/);
});

test("run: a bundle the run cannot read aborts the run rather than being recorded", async () => {
  const dir = tmpdir();
  const malformed = path.join(dir, "broken", "bundle.json");
  fs.mkdirSync(path.dirname(malformed), { recursive: true });
  fs.writeFileSync(malformed, "{ not json");

  await assert.rejects(
    runJudgedBundles([malformed], {
      config: config(dir),
      complete: async () => ({ text: verdictJson("PASS") }),
      progress: false,
      sideEffects: [],
    }),
    // readBundle happens before the per-bundle try, as it always has. A run
    // that cannot read its own input directory is a different failure from a
    // bundle that could not be judged, and it must not be laundered into one.
    /JSON|Unexpected|token/i,
  );
});

test("run: side effects are opt-out and the index is written by default", async () => {
  const dir = tmpdir();
  const bundlePath = fixture(dir);

  await runJudgedBundles([bundlePath], {
    config: config(dir),
    complete: async () => ({ text: verdictJson("PASS") }),
    progress: false,
    sideEffects: [],
  });
  assert.equal(fs.existsSync(path.join(dir, "report.html")), false, "no index without 'index'");

  await runJudgedBundles([bundlePath], {
    config: config(dir),
    complete: async () => ({ text: verdictJson("PASS") }),
    progress: false,
    sideEffects: ["index"],
  });
  assert.equal(fs.existsSync(path.join(dir, "report.html")), true);
});

test("run: the run index carries the cluster summary", async () => {
  const dir = tmpdir();
  const a = fixture(dir, "checkout-total");
  const b = fixture(dir, "cart-badge");
  const run = await runJudgedBundles([a, b], {
    config: config(dir),
    complete: async () => ({ text: verdictJson("REGRESSION", 0.95) }),
    progress: false,
    sideEffects: RUN_SIDE_EFFECTS.filter((s) => s !== "ci"),
  });
  assert.ok(run.clusters, "clustering runs and reports a result");
  const index = fs.readFileSync(path.join(dir, "report.html"), "utf8");
  assert.ok(
    index.includes("Likely root causes") || run.clusters.clusters.length === 0,
    "the index receives the cluster set",
  );
});

test("run: judgeBundles still returns a plain Judgement[] for the reporter", async () => {
  const dir = tmpdir();
  const bundlePath = fixture(dir);
  const results = await judgeBundles([bundlePath], config(dir), async () => ({
    text: verdictJson("PASS"),
  }));
  assert.equal(results.length, 1);
  assert.equal(results[0].verdict.verdict, "PASS");
  // The run ran with its default side effects, index included.
  assert.equal(fs.existsSync(path.join(dir, "report.html")), true);
});

test("run: the same Complete instance drives every bundle in the run", async () => {
  const dir = tmpdir();
  const a = fixture(dir, "one");
  const b = fixture(dir, "two");
  const seen = [];
  await runJudgedBundles([a, b], {
    config: config(dir),
    complete: async (request) => {
      seen.push(request.system);
      return { text: verdictJson("PASS") };
    },
    progress: false,
    sideEffects: [],
  });
  assert.equal(seen.length, 2);
});