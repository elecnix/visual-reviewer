import { test } from "node:test";
import assert from "node:assert/strict";
import {
  extractFailureSignals,
  clusterRegressions,
  renderClusterSummary,
} from "../dist/oracle/cluster.js";

function bundle(overrides = {}) {
  return {
    schemaVersion: 1,
    runId: "run-1",
    testId: "t1",
    title: "test one",
    file: "tests/a.spec.ts",
    sourceCode: "",
    status: "passed",
    durationMs: 10,
    assertions: [],
    evidence: [],
    artifacts: {},
    ...overrides,
  };
}

const netEv = (method, url, status) => ({
  id: "ev1",
  timestamp: 1,
  type: "network_event",
  source: "fixture:page",
  content: { method, url, status },
});
const consoleEv = (type, text) => ({
  id: "ev2",
  timestamp: 2,
  type: "console_event",
  source: "fixture:page",
  content: { type, text },
});
const crashEv = (message) => ({
  id: "ev3",
  timestamp: 3,
  type: "crash",
  source: "fixture:page",
  content: { message },
});

test("extracts non-2xx network signals with query strings stripped", () => {
  const b = bundle({ evidence: [netEv("POST", "https://api.example.com/api/pay?token=secret", 500)] });
  const signals = extractFailureSignals(b);
  assert.equal(signals.length, 1);
  assert.equal(signals[0].kind, "network");
  assert.equal(signals[0].key, 'network:POST /api/pay → 500');
});

test("ignores successful network calls", () => {
  const b = bundle({ evidence: [netEv("GET", "https://api.example.com/api/plan", 200)] });
  assert.deepEqual(extractFailureSignals(b), []);
});

test("extracts error-level console signals normalized to first line", () => {
  const b = bundle({
    evidence: [consoleEv("error", "TypeError: cannot read properties of undefined\n    at checkout")],
  });
  const signals = extractFailureSignals(b);
  assert.equal(signals.length, 1);
  assert.equal(signals[0].kind, "console-error");
  assert.equal(signals[0].key, 'console-error:TypeError: cannot read properties of undefined');
});

test("ignores non-error console messages", () => {
  const b = bundle({ evidence: [consoleEv("log", "hello")] });
  assert.deepEqual(extractFailureSignals(b), []);
});

test("extracts page crash signals", () => {
  const b = bundle({ evidence: [crashEv("Uncaught Error: boom\n    at f")] });
  const signals = extractFailureSignals(b);
  assert.equal(signals.length, 1);
  assert.equal(signals[0].kind, "crash");
});

test("clusters regression verdicts sharing an identical failing endpoint", () => {
  const failingPayment = [netEv("POST", "https://api.example.com/api/payment", 500)];
  const items = [
    { bundle: bundle({ title: "upgrade", file: "a.spec.ts" }), verdict: { verdict: "REGRESSION", confidence: 0.9 } },
    { bundle: bundle({ title: "renew", file: "b.spec.ts" }), verdict: { verdict: "REGRESSION", confidence: 0.8 } },
    { bundle: bundle({}), verdict: { verdict: "PASS", confidence: 0.95 } },
  ];
  items[0].bundle.evidence = failingPayment;
  items[1].bundle.evidence = [
    netEv("GET", "https://api.example.com/api/plan", 200),
    netEv("POST", "https://api.example.com/api/payment?x=1", 500),
  ];

  const result = clusterRegressions(items);
  assert.equal(result.clusters.length, 1);
  assert.equal(result.clusters[0].tests.length, 2);
  assert.deepEqual(
    result.clusters[0].tests.map((t) => t.title),
    ["upgrade", "renew"],
  );
  assert.equal(result.unclustered, 0);
});

test("only material verdicts are clustered; PASS never joins a cluster", () => {
  const shared = [consoleEv("error", "TypeError: x is not a function")];
  const items = [
    { bundle: bundle({ title: "a" }), verdict: { verdict: "FAIL", confidence: 0.9 } },
    { bundle: bundle({ title: "b" }), verdict: { verdict: "UNCERTAIN", confidence: 0.4 } },
    { bundle: bundle({ title: "c" }), verdict: { verdict: "PASS", confidence: 0.99 } },
  ];
  for (const it of items) it.bundle.evidence = shared;

  const result = clusterRegressions(items);
  assert.equal(result.clusters.length, 1);
  // PASS is excluded from membership even though it shares the signal.
  assert.deepEqual(result.clusters[0].tests.map((t) => t.title), ["a", "b"]);
});

test("regressions without a shared signal are counted as unclustered", () => {
  const items = [
    { bundle: bundle({ title: "lonely", evidence: [crashEv("Uncaught: solo")] }), verdict: { verdict: "REGRESSION", confidence: 0.8 } },
  ];
  const result = clusterRegressions(items);
  assert.equal(result.clusters.length, 0);
  assert.equal(result.unclustered, 1);
});

test("single-test clusters are reported as unclustered (min size 2)", () => {
  const items = [
    { bundle: bundle({ title: "a", evidence: [netEv("POST", "https://x/api/p", 500)] }), verdict: { verdict: "REGRESSION", confidence: 0.9 } },
    { bundle: bundle({ title: "b", evidence: [netEv("POST", "https://y/api/q", 500)] }), verdict: { verdict: "REGRESSION", confidence: 0.9 } },
  ];
  const result = clusterRegressions(items);
  assert.equal(result.clusters.length, 0);
  assert.equal(result.unclustered, 2);
});

test("judge errors are ignored entirely", () => {
  const items = [{ bundle: bundle(), verdict: undefined, error: "boom" }];
  const result = clusterRegressions(items);
  assert.equal(result.clusters.length, 0);
  assert.equal(result.unclustered, 0);
});

test("renderClusterSummary describes many-to-one root causes", () => {
  const items = [
    { bundle: bundle({ title: "upgrade", evidence: [netEv("POST", "https://api.example.com/api/payment", 500)] }), verdict: { verdict: "REGRESSION", confidence: 0.9 } },
    { bundle: bundle({ title: "renew", evidence: [netEv("POST", "https://api.example.com/api/payment", 500)] }), verdict: { verdict: "REGRESSION", confidence: 0.8 } },
  ];
  const result = clusterRegressions(items);
  const summary = renderClusterSummary(result);
  assert.match(summary, /2 material verdict/);
  assert.match(summary, /1 likely root cause/);
  assert.match(summary, /POST \/api\/payment → 500/);
  assert.match(summary, /upgrade, renew/);
});

test("renderClusterSummary returns empty string when there is nothing to group", () => {
  assert.equal(renderClusterSummary({ clusters: [], unclustered: 0 }), "");
});
