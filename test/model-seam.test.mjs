import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { judgeBundle } from "../dist/oracle/judge.js";
import { DEFAULT_ORACLE_CONFIG } from "../dist/config.js";

/**
 * The completion seam (src/oracle/complete.ts) lets the retry ladder and the
 * bounded follow-up round be driven without a live model. These tests are the
 * first coverage either branch has ever had: before the seam, `judgeBundle`
 * imported `generateText` inline three times and every one of these paths
 * required a network call.
 */

function fixture(dir) {
  const bundleDir = path.join(dir, "checkout-total");
  fs.mkdirSync(bundleDir, { recursive: true });
  fs.writeFileSync(path.join(bundleDir, "shot-1.png"), Buffer.from("89504e470d0a1a0a", "hex"));
  const bundle = {
    schemaVersion: 1,
    runId: "run-1",
    testId: "checkout-total",
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

/** A scripted `Complete`: returns replies in order, repeating the last one. */
function scripted(replies) {
  const calls = [];
  const complete = async (request) => {
    calls.push(request);
    const reply = replies[Math.min(calls.length - 1, replies.length - 1)];
    return { text: reply };
  };
  return { complete, calls };
}

const verdictJson = (verdict, confidence) =>
  JSON.stringify({
    verdict,
    confidence,
    intentSummary: "the cart total is rendered",
    reasoning: "because the evidence says so",
    supportingEvidence: [{ evidenceIds: ["ev-1"], observation: "screenshot" }],
    suspiciousObservations: [],
  });

const lastUserText = (request) => {
  const messages = request.messages;
  const last = messages[messages.length - 1];
  if (typeof last.content === "string") return last.content;
  return last.content.filter((p) => p.type === "text").map((p) => p.text).join("\n");
};

test("completion seam carries the system prompt, temperature and timeout", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vr-seam-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const { complete, calls } = scripted([verdictJson("PASS", 0.95)]);

  await judgeBundle(fixture(dir), config(dir, { temperature: 0.25, timeoutMs: 4321 }), complete);

  assert.equal(calls.length, 1);
  assert.match(calls[0].system, /semantic test oracle/);
  assert.equal(calls[0].temperature, 0.25);
  assert.equal(calls[0].timeoutMs, 4321);
});

test("retry ladder re-asks on unparseable output and succeeds on the third attempt", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vr-seam-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const { complete, calls } = scripted([
    "The page looked fine to me.",
    '```json\n{"verdict":"PASS","confidence":0.9\n```',
    verdictJson("REGRESSION", 0.92),
  ]);

  const judgement = await judgeBundle(fixture(dir), config(dir), complete);

  assert.equal(calls.length, 3);
  assert.equal(judgement.verdict.verdict, "REGRESSION");
  assert.equal(judgement.verdict.confidence, 0.92);
  // Attempt 0 is the bare dossier; retries feed back the previous raw reply
  // plus an explicit correction instruction.
  assert.equal(calls[0].messages.length, 1);
  assert.equal(calls[1].messages.length, 3);
  assert.equal(calls[1].messages[1].content, "The page looked fine to me.");
  assert.match(lastUserText(calls[1]), /Respond again with ONLY the JSON object/);
  assert.equal(calls[2].messages[1].content, '```json\n{"verdict":"PASS","confidence":0.9\n```');
});

test("retry ladder stops at three attempts and preserves the raw output", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vr-seam-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const { complete, calls } = scripted(["no verdict here"]);

  const bundlePath = fixture(dir);
  const judgement = await judgeBundle(bundlePath, config(dir), complete);

  assert.equal(calls.length, 3);
  assert.equal(judgement.verdict, undefined);
  assert.match(judgement.error, /unparseable verdict after retry/);
  assert.equal(
    fs.readFileSync(path.join(path.dirname(bundlePath), "verdict-error.txt"), "utf8"),
    "no verdict here",
  );
});

test("follow-up round runs on UNCERTAIN and can refine the verdict", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vr-seam-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const { complete, calls } = scripted([
    verdictJson("UNCERTAIN", 0.3),
    '{"evidence_requests":[{"type":"network_body","urlContains":"/cart"}]}',
    verdictJson("REGRESSION", 0.88),
  ]);

  const judgement = await judgeBundle(fixture(dir), config(dir, { followUps: true }), complete);

  assert.equal(calls.length, 3);
  assert.equal(judgement.verdict.verdict, "REGRESSION");
  // The second round carries the original verdict, the follow-up
  // instruction, and finally the evidence the model asked for.
  assert.match(lastUserText(calls[1]), /request up to 3 additional pieces of evidence/);
  const finalText = lastUserText(calls[2]);
  assert.match(finalText, /EVIDENCE REQUESTED \(1 item\(s\)\)/);
  assert.match(finalText, /total=NaN/);
  assert.match(finalText, /return your final verdict/);
});

test("follow-up round runs below the confidence threshold even on a decided verdict", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vr-seam-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const { complete, calls } = scripted([
    verdictJson("PASS", 0.5),
    '{"evidence_requests":[{"type":"console"}]}',
    verdictJson("REGRESSION", 0.8),
  ]);

  const judgement = await judgeBundle(
    fixture(dir),
    config(dir, { followUps: true, followUpThreshold: 0.7 }),
    complete,
  );

  assert.equal(calls.length, 3);
  assert.equal(judgement.verdict.verdict, "REGRESSION");
});

test("follow-up round keeps the original verdict when the refined reply is unparseable", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vr-seam-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const { complete, calls } = scripted([
    verdictJson("UNCERTAIN", 0.2),
    '{"evidence_requests":[{"type":"dom_snapshot"}]}',
    "I am not sure any more.",
  ]);

  const judgement = await judgeBundle(fixture(dir), config(dir, { followUps: true }), complete);

  assert.equal(calls.length, 3);
  assert.equal(judgement.verdict.verdict, "UNCERTAIN");
  assert.equal(judgement.verdict.confidence, 0.2);
});

test("no third call when the model requests no evidence", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vr-seam-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const { complete, calls } = scripted([verdictJson("UNCERTAIN", 0.2), '{"evidence_requests":[]}']);

  const judgement = await judgeBundle(fixture(dir), config(dir, { followUps: true }), complete);

  assert.equal(calls.length, 2);
  assert.equal(judgement.verdict.verdict, "UNCERTAIN");
});

test("follow-up gate is closed when followUps is off", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vr-seam-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const { complete, calls } = scripted([verdictJson("UNCERTAIN", 0.1)]);

  const judgement = await judgeBundle(fixture(dir), config(dir, { followUps: false }), complete);

  assert.equal(calls.length, 1);
  assert.equal(judgement.verdict.verdict, "UNCERTAIN");
});

test("the retry ladder rebuilds the evidence dossier on every attempt", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vr-seam-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const { complete, calls } = scripted(["nope", "still nope", verdictJson("PASS", 0.9)]);

  await judgeBundle(fixture(dir), config(dir), complete);

  // Documents the cost policy split: the per-round cap lives in
  // context/builder.ts, the x3 multiplier lives here. Each attempt re-reads
  // the screenshot off disk and re-sends it.
  for (const call of calls) {
    const first = call.messages[0].content;
    assert.ok(Array.isArray(first));
    assert.equal(first.filter((p) => p.type === "image").length, 1);
  }
});
