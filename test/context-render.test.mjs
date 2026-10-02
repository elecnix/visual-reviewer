import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  EVIDENCE_RENDER_KIND,
  EVIDENCE_TYPES,
  isEvidenceType,
  renderKindOf,
  renderUnrenderedNotice,
  unrenderedEvidence,
} from "../dist/context/render.js";
import { buildUserContent, selectScreenshots } from "../dist/context/builder.js";

/** A bundle carrying one observation of every declared evidence type. */
function bundleWithEveryType() {
  const content = {
    screenshot: { file: "assets/shot.jpeg" },
    video_frame: { file: "assets/frame.jpeg" },
    dom_snapshot: "<html><body><h1>Checkout</h1></body></html>",
    accessibility_tree: "role=heading name=Checkout",
    native_ui_tree: "<XCUIElementTypeApplication/>",
    network_event: { method: "POST", url: "https://api.example/orders", status: 500, body: "boom" },
    console_event: { type: "warning", text: "deprecated api" },
    log_event: { line: "structured log line" },
    crash: { message: "TypeError: x is not a function" },
    assertion: { title: "expect(page).toHaveTitle", passed: false, error: "nope" },
    test_source: "test('checkout', () => {})",
    browser_state: { url: "https://shop.example/checkout" },
    native_state: { platform: "iOS", osVersion: "18.0" },
    user_action: { label: "click #submit" },
  };
  const evidence = EVIDENCE_TYPES.map((type, i) => ({
    id: `ev-${type}`,
    timestamp: i,
    type,
    source: "test:fixture",
    content: content[type],
  }));
  return {
    schemaVersion: 1,
    runId: "run-1",
    testId: "checkout",
    title: "checkout completes",
    // Deliberately a *spec* path in a different directory from bundleDir:
    // resolving assets from it is the bug this suite guards against.
    file: path.join(os.tmpdir(), "specs", "checkout.spec.ts"),
    sourceCode: "test('checkout', () => {})",
    status: "failed",
    durationMs: 1234,
    assertions: [{ title: "expect(page).toHaveTitle", passed: false, error: "nope" }],
    evidence,
    artifacts: {},
  };
}

function tmpBundleDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "vr-render-"));
}

test("EVIDENCE_TYPES and the render policy table are the same closed set", () => {
  assert.deepEqual(
    [...EVIDENCE_TYPES].sort(),
    Object.keys(EVIDENCE_RENDER_KIND).sort(),
    "every EvidenceType needs exactly one entry in EVIDENCE_RENDER_KIND",
  );
  assert.equal(EVIDENCE_TYPES.length, 14);
});

test("every declared evidence type reaches the dossier or is loudly announced", () => {
  const dir = tmpBundleDir();
  fs.mkdirSync(path.join(dir, "assets"), { recursive: true });
  fs.writeFileSync(path.join(dir, "assets", "shot.jpeg"), Buffer.from("jpeg-bytes"));

  const bundle = bundleWithEveryType();
  const parts = buildUserContent(bundle, dir, 6);
  const text = parts.filter((p) => p.type === "text").map((p) => p.text).join("\n");

  for (const type of EVIDENCE_TYPES) {
    const id = `ev-${type}`;
    assert.ok(text.includes(id), `${type} (${id}) is invisible in the model dossier`);
  }

  // Withheld types must be announced rather than dropped.
  for (const type of EVIDENCE_TYPES.filter((t) => EVIDENCE_RENDER_KIND[t] === "not-rendered")) {
    assert.match(text, new RegExp(`\\[ev-${type}\\][^\\n]*${type}`), `${type} must be announced as not-shown`);
  }
  assert.match(text, /NOT SHOWN ABOVE/);
});

test("dom_snapshot is rendered in the first-pass dossier, not only on request", () => {
  const bundle = bundleWithEveryType();
  const text = buildUserContent(bundle, tmpBundleDir(), 6)
    .filter((p) => p.type === "text")
    .map((p) => p.text)
    .join("\n");
  assert.match(text, /FINAL DOM SNAPSHOT \[ev-dom_snapshot\]/);
  assert.match(text, /<h1>Checkout<\/h1>/);
});

test("an evidence type unknown to this oracle version is announced, not dropped", () => {
  assert.equal(renderKindOf("quantum_flux"), "unknown");
  assert.equal(isEvidenceType("quantum_flux"), false);
  assert.equal(isEvidenceType("dom_snapshot"), true);

  const bundle = bundleWithEveryType();
  bundle.evidence.push({
    id: "ev-future",
    timestamp: 99,
    type: "telemetry_stream",
    source: "adapter:future",
    content: { anything: true },
  });

  assert.equal(unrenderedEvidence(bundle).some((e) => e.id === "ev-future"), true);
  const notice = renderUnrenderedNotice(bundle);
  assert.match(notice, /\[ev-future\] telemetry_stream/);
  assert.match(notice, /unknown to this oracle version/);
});

test("a fully renderable bundle gets no withheld-evidence notice", () => {
  const bundle = bundleWithEveryType();
  bundle.evidence = bundle.evidence.filter(
    (e) => EVIDENCE_RENDER_KIND[e.type] !== "not-rendered",
  );
  assert.equal(renderUnrenderedNotice(bundle), "");
  const text = buildUserContent(bundle, tmpBundleDir(), 6)
    .filter((p) => p.type === "text")
    .map((p) => p.text)
    .join("\n");
  assert.doesNotMatch(text, /NOT SHOWN ABOVE/);
});

test("the evidence summary counts every type, not a hand-picked three", () => {
  const bundle = bundleWithEveryType();
  const text = buildUserContent(bundle, tmpBundleDir(), 6)
    .filter((p) => p.type === "text")
    .map((p) => p.text)
    .join("\n");
  assert.match(text, /EVIDENCE AVAILABLE: 14 observations \(1 accessibility_tree, .*1 dom_snapshot/);
  assert.match(text, /1 network_event/);
});

test("selectScreenshots resolves assets against bundleDir, not the spec file path", () => {
  const dir = tmpBundleDir();
  fs.mkdirSync(path.join(dir, "assets"), { recursive: true });
  fs.writeFileSync(path.join(dir, "assets", "shot.jpeg"), Buffer.from("jpeg-bytes"));

  const bundle = bundleWithEveryType();
  bundle.evidence = [
    {
      id: "ev-shot",
      timestamp: 1,
      type: "screenshot",
      source: "test:fixture",
      content: { file: "assets/shot.jpeg" },
      metadata: { name: "final" },
    },
  ];

  const picked = selectScreenshots(bundle, dir, 6);
  assert.equal(picked.length, 1);
  assert.equal(picked[0].buffer.toString(), "jpeg-bytes");
  assert.equal(picked[0].evidence.id, "ev-shot");
});

test("buildUserContent attaches the screenshot without fabricating a bundle", () => {
  const dir = tmpBundleDir();
  fs.mkdirSync(path.join(dir, "assets"), { recursive: true });
  fs.writeFileSync(path.join(dir, "assets", "shot.jpeg"), Buffer.from("jpeg-bytes"));

  const bundle = bundleWithEveryType();
  bundle.evidence = [
    {
      id: "ev-shot",
      timestamp: 1,
      type: "screenshot",
      source: "test:fixture",
      content: { file: "assets/shot.jpeg" },
      metadata: { name: "final" },
    },
  ];

  const parts = buildUserContent(bundle, dir, 6);
  assert.equal(parts.filter((p) => p.type === "image").length, 1);
  assert.match(parts.map((p) => p.text ?? "").join("\n"), /SCREENSHOT \[ev-shot\] name=final/);
});