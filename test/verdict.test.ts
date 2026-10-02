import { test } from "node:test";
import assert from "node:assert/strict";
import {
  VERDICT_KINDS,
  isFailing,
  isMaterial,
  isVerdictKind,
  needsFollowUp,
  verdictCssClass,
  verdictIcon,
  verdictPercent,
  firstLine,
  assertionTally,
} from "../dist/oracle/schema.js";

// The four rules below used to be re-derived independently by src/oracle/cluster.ts,
// src/ci/github.ts, src/oracle/bench.ts and src/oracle/judge.ts, with different
// membership and no compile error. They are pinned here so the next drift is a
// failing test, not a silent behavioural change in a report.

test("the verdict vocabulary has exactly the four schema members", () => {
  assert.deepEqual([...VERDICT_KINDS], ["PASS", "REGRESSION", "FAIL", "UNCERTAIN"]);
});

test("every verdict kind gets a distinct icon and CSS class", () => {
  const icons = VERDICT_KINDS.map(verdictIcon);
  const classes = VERDICT_KINDS.map(verdictCssClass);
  assert.equal(new Set(icons).size, VERDICT_KINDS.length);
  assert.equal(new Set(classes).size, VERDICT_KINDS.length);
  assert.deepEqual(classes, ["pass", "regression", "fail", "uncertain"]);
});

test("presentation lookups degrade safely on an unknown verdict string", () => {
  assert.equal(verdictIcon("NOPE"), "•");
  assert.equal(verdictCssClass("NOPE"), "unknown");
  assert.equal(isVerdictKind("NOPE"), false);
  assert.equal(isMaterial("NOPE"), false);
  assert.equal(isFailing("NOPE"), false);
});

test("material means run-level attention, and UNCERTAIN is material", () => {
  assert.deepEqual(
    VERDICT_KINDS.filter(isMaterial),
    ["REGRESSION", "FAIL", "UNCERTAIN"],
  );
});

test("failing means the app is broken; UNCERTAIN is not a failure", () => {
  assert.deepEqual(VERDICT_KINDS.filter(isFailing), ["REGRESSION", "FAIL"]);
});

test("needsFollowUp fires on UNCERTAIN or low confidence, nothing else", () => {
  assert.equal(needsFollowUp({ verdict: "UNCERTAIN", confidence: 0.99 }, 0.6), true);
  assert.equal(needsFollowUp({ verdict: "PASS", confidence: 0.1 }, 0.6), true);
  assert.equal(needsFollowUp({ verdict: "REGRESSION", confidence: 0.9 }, 0.6), false);
  // The threshold is a floor: exactly at it does not trigger a second round.
  assert.equal(needsFollowUp({ verdict: "PASS", confidence: 0.6 }, 0.6), false);
});

test("verdictPercent rounds to an integer percentage", () => {
  assert.equal(verdictPercent(0.853), "85%");
  assert.equal(verdictPercent(0), "0%");
  assert.equal(verdictPercent(1), "100%");
});

test("firstLine trims, optionally truncates, and tolerates empty input", () => {
  assert.equal(firstLine("  hello \nworld"), "hello");
  assert.equal(firstLine("hello world", 5), "hello");
  assert.equal(firstLine(""), "");
  assert.equal(firstLine("\nsecond"), "");
});

test("assertionTally projects passed/total/text once", () => {
  const bundle = {
    assertions: [{ passed: true }, { passed: false }, { passed: true }],
  } as unknown as Parameters<typeof assertionTally>[0];
  assert.deepEqual(assertionTally(bundle), { passed: 2, total: 3, text: "2/3" });
  assert.deepEqual(assertionTally({ assertions: [] } as never), {
    passed: 0,
    total: 0,
    text: "0/0",
  });
});
