import { test } from "node:test";
import assert from "node:assert/strict";
import { VerdictSchema } from "../dist/oracle/schema.js";

function baseVerdict(suggestedNextStep) {
  return {
    verdict: "PASS",
    confidence: 0.9,
    intentSummary: "the dialog opens",
    reasoning: "the dialog is visible in the screenshot",
    supportingEvidence: [],
    suspiciousObservations: [],
    suggestedNextStep,
  };
}

test("accepts a verdict with no suggestedNextStep field", () => {
  const { suggestedNextStep, ...rest } = baseVerdict(undefined);
  const parsed = VerdictSchema.parse(rest);
  assert.equal(parsed.suggestedNextStep, undefined);
});

test("accepts a verdict whose suggestedNextStep is null", () => {
  const parsed = VerdictSchema.parse(baseVerdict(null));
  assert.equal(parsed.suggestedNextStep, null);
});

test("accepts a verdict whose suggestedNextStep is a string", () => {
  const parsed = VerdictSchema.parse(baseVerdict("capture a screenshot of the error state"));
  assert.equal(parsed.suggestedNextStep, "capture a screenshot of the error state");
});
