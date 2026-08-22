import { test } from "node:test";
import assert from "node:assert/strict";
import { extractVerdictJson } from "../dist/oracle/schema.js";

test("parses a plain JSON verdict", () => {
  const out = extractVerdictJson('{"verdict":"PASS","confidence":0.9}');
  assert.equal(out.verdict, "PASS");
});

test("parses a fenced JSON verdict", () => {
  const out = extractVerdictJson('Here you go:\n```json\n{"verdict":"FAIL","confidence":0.8}\n```\nDone.');
  assert.equal(out.verdict, "FAIL");
});

test("parses JSON embedded in surrounding prose", () => {
  const out = extractVerdictJson('Sure! {"verdict":"UNCERTAIN","confidence":0.4} hope that helps');
  assert.equal(out.verdict, "UNCERTAIN");
});

test("strips <think> reasoning blocks before parsing", () => {
  const text = '<think>Let me consider the evidence… { tricky }</think>\n{"verdict":"REGRESSION","confidence":0.95}';
  const out = extractVerdictJson(text);
  assert.equal(out.verdict, "REGRESSION");
});

test("repairs trailing commas before } and ]", () => {
  const text = `{
    "verdict": "FAIL",
    "confidence": 0.7,
    "supportingEvidence": [{"evidenceIds": ["ev-1"], "observation": "x",}],
  }`;
  const out = extractVerdictJson(text);
  assert.equal(out.verdict, "FAIL");
  assert.equal(out.supportingEvidence.length, 1);
});

test("throws on genuinely unparseable output", () => {
  assert.throws(() => extractVerdictJson("no json here at all"));
});
