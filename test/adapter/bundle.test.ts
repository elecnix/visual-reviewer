import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AdapterArtifacts } from "../../src/adapter/types.js";
import {
  loadAdapterArtifacts,
  writeAdapterArtifacts,
  buildBundleFromAdapter,
} from "../../dist/adapter/index.js";

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ve-adapter-"));
}

test("canonical artifacts round-trip through load", () => {
  const dir = tmpDir();
  const fixture: AdapterArtifacts = {
    metadata: {
      adapter: "appium",
      schemaVersion: 1,
      runId: "run-1",
      title: "flight confirmed",
      file: "flight.spec.ts",
      status: "passed",
      durationMs: 1200,
    },
    sourceCode: "it('books a flight')",
    assertions: [{ title: "expect(page).toHaveTitle('Flight')", passed: true }],
    evidence: [{ type: "native_ui_tree", timestamp: 100, content: { title: "A" } }],
  };
  writeAdapterArtifacts(dir, fixture);
  const artifacts = loadAdapterArtifacts(dir);
  assert.equal(artifacts.metadata.adapter, "appium");
  assert.equal(artifacts.sourceCode, "it('books a flight')");
  assert.equal(artifacts.assertions?.length, 1);
  assert.equal(artifacts.evidence?.[0]?.type, "native_ui_tree");
  fs.rmSync(dir, { recursive: true });
});

test("buildBundleFromAdapter copies file assets and builds a reviewable bundle", () => {
  const srcDir = tmpDir();
  fs.mkdirSync(path.join(srcDir, "files"), { recursive: true });
  const shotSrc = path.join(srcDir, "files", "shot.png");
  fs.writeFileSync(shotSrc, new Uint8Array([1, 2, 3]));

  const fixture: AdapterArtifacts = {
    metadata: {
      adapter: "xctest",
      schemaVersion: 1,
      runId: "run-9",
      title: "checkout completes",
      file: "checkout.test.ts",
      status: "failed",
      durationMs: 900,
    },
    sourceCode: "const t = 1",
    assertions: [{ title: "expect(x)", passed: false, error: "no match" }],
    evidence: [
      { type: "screenshot", timestamp: 42, content: {}, asset: shotSrc },
      { type: "native_state", timestamp: 43, content: { screen: "locked" } },
    ],
    artifacts: { trace: shotSrc },
  };

  const outDir = tmpDir();
  const bundle = buildBundleFromAdapter(fixture, outDir);
  assert.equal(bundle.status, "failed");
  assert.equal(bundle.assertions[0].passed, false);
  assert.equal(bundle.evidence.length, 2);
  const shot = bundle.evidence.find((e) => e.type === "screenshot");
  assert.ok(shot, "screenshot evidence present");
  const shotRel = (shot.content as { file: string }).file;
  assert.ok(fs.existsSync(path.join(outDir, shotRel)), "screenshot bytes copied");
  assert.ok(bundle.artifacts.trace, "named artifact recorded");
  assert.ok(fs.existsSync(path.join(outDir, bundle.artifacts.trace)));
  fs.rmSync(outDir, { recursive: true });
  fs.rmSync(srcDir, { recursive: true });
});