import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AdapterArtifacts, FrameworkAdapter } from "../../src/adapter/types.js";
import {
  buildBundleFromAdapter,
  buildForAdapter,
  canonicalAdapter,
  getAdapter,
  listAdapters,
  loadAdapterArtifacts,
  parseCanonical,
  registerAdapter,
  unregisterAdapter,
  writeAdapterArtifacts,
  logEventsToEvidence,
  nativeMetadata,
} from "../../dist/adapter/index.js";

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ve-seam-"));
}

/** A fourth framework, written strictly to the documented contract. */
function makeFourthAdapter(id: string): FrameworkAdapter {
  return {
    id,
    label: "Fourth framework",
    version: "0.1.0",
    kind: "native",
    parse(dir: string): AdapterArtifacts {
      return {
        metadata: {
          adapter: id,
          schemaVersion: 1,
          runId: "run-4th",
          title: "checkout > pays",
          file: "checkout.mstest",
          status: "passed",
          durationMs: 55,
        },
        evidence: [
          // Documented as "a path relative to the artifacts dir".
          { type: "screenshot", timestamp: 1, content: {}, asset: "files/step-1.png" },
          { type: "native_state", timestamp: 2, content: { screen: "paid" } },
        ],
        artifacts: { video: "files/run.mp4" },
      };
    },
    build(dir: string) {
      return buildBundleFromAdapter(this.parse(dir), dir);
    },
  };
}

function artifactsDirWithAssets(): string {
  const dir = tmpDir();
  fs.mkdirSync(path.join(dir, "files"), { recursive: true });
  fs.writeFileSync(path.join(dir, "files", "step-1.png"), new Uint8Array([1, 2]));
  fs.writeFileSync(path.join(dir, "files", "run.mp4"), new Uint8Array([3, 4]));
  return dir;
}

test("the registry is populated on import, not inert", () => {
  const ids = listAdapters().map((a) => a.id).sort();
  assert.deepEqual(ids, ["appium", "xctest"]);
  assert.equal(getAdapter("appium")?.kind, "native");
  assert.equal(getAdapter("xctest")?.kind, "native");
  assert.equal(getAdapter("nope"), undefined);
});

test("a newly registered adapter is honoured by buildForAdapter", () => {
  const dir = artifactsDirWithAssets();
  registerAdapter(makeFourthAdapter("fourth"));
  try {
    const bundle = buildForAdapter("fourth", dir);
    assert.equal(bundle.status, "passed");
    assert.equal(bundle.testId, "checkout.mstest");
    assert.equal(bundle.evidence.length, 2, "screenshot is not silently dropped");
    assert.equal(bundle.artifacts.video, "files/run.mp4");
    assert.ok(fs.existsSync(path.join(dir, "files", "run.mp4")));
    assert.ok(listAdapters().some((a) => a.id === "fourth"));
  } finally {
    unregisterAdapter("fourth");
  }
  fs.rmSync(dir, { recursive: true });
});

test("unregisterAdapter removes an adapter again", () => {
  registerAdapter(makeFourthAdapter("temp-adapter"));
  assert.ok(getAdapter("temp-adapter"));
  unregisterAdapter("temp-adapter");
  assert.equal(getAdapter("temp-adapter"), undefined);
  assert.ok(!listAdapters().some((a) => a.id === "temp-adapter"));
});

test("assets resolve relative to the artifacts dir, absolute paths still work", () => {
  const dir = artifactsDirWithAssets();
  const abs = path.join(dir, "files", "step-1.png");

  const relative = buildBundleFromAdapter(
    {
      metadata: {
        adapter: "rel",
        schemaVersion: 1,
        runId: "r",
        title: "t",
        file: "f.ts",
        status: "passed",
        durationMs: 1,
      },
      evidence: [{ type: "screenshot", timestamp: 1, content: {}, asset: "files/step-1.png" }],
      artifacts: { video: "files/run.mp4" },
    },
    dir,
  );
  assert.equal(relative.evidence.length, 1);
  assert.ok(fs.existsSync(path.join(dir, (relative.evidence[0].content as { file: string }).file)));
  assert.equal(relative.artifacts.video, "files/run.mp4");

  const absolute = buildBundleFromAdapter(
    {
      metadata: {
        adapter: "abs",
        schemaVersion: 1,
        runId: "r",
        title: "t",
        file: "f.ts",
        status: "passed",
        durationMs: 1,
      },
      evidence: [{ type: "screenshot", timestamp: 1, content: {}, asset: abs }],
    },
    dir,
  );
  assert.equal(absolute.evidence.length, 1, "absolute asset paths stay supported");
  fs.rmSync(dir, { recursive: true });
});

test("parseCanonical and the unknown-id fallback are the same canonical adapter", () => {
  const dir = tmpDir();
  fs.writeFileSync(
    path.join(dir, "metadata.json"),
    JSON.stringify({
      adapter: "whatever",
      schemaVersion: 1,
      runId: "r",
      title: "t",
      file: "f.ts",
      status: "passed",
      durationMs: 3,
    }),
  );
  assert.deepEqual(parseCanonical(dir), canonicalAdapter.parse(dir));
  const bundle = buildForAdapter("unknown-framework", dir);
  assert.equal(bundle.runId, "r");
  assert.equal(canonicalAdapter.kind, "web", "canonical is not a concrete framework");
  assert.ok(
    !listAdapters().some((a) => a.id === canonicalAdapter.id),
    "canonical is a fallback, not a listed adapter",
  );
  fs.rmSync(dir, { recursive: true });
});

test("artifacts.json: writer and reader agree, and the object form is accepted", () => {
  const dir = tmpDir();
  writeAdapterArtifacts(dir, {
    metadata: {
      adapter: "x",
      schemaVersion: 1,
      runId: "r",
      title: "t",
      file: "f.ts",
      status: "passed",
      durationMs: 1,
    },
    artifacts: { video: "files/run.mp4" },
  });
  assert.deepEqual(loadAdapterArtifacts(dir).artifacts, { video: "files/run.mp4" });

  fs.writeFileSync(path.join(dir, "artifacts.json"), JSON.stringify({ video: "files/run.mp4" }));
  assert.deepEqual(
    loadAdapterArtifacts(dir).artifacts,
    { video: "files/run.mp4" },
    "the documented object form is read into the same shape",
  );

  fs.writeFileSync(path.join(dir, "artifacts.json"), JSON.stringify(42));
  assert.throws(() => loadAdapterArtifacts(dir), /artifacts\.json must be/);
  fs.rmSync(dir, { recursive: true });
});

test("shared native seam: metadata projection and log classification", () => {
  const logs = [
    { level: "error", message: "boom", timestamp: 5 },
    { level: "warn", message: "hmm", timestamp: 6 },
  ];
  const evidence = logEventsToEvidence(logs, "appium");
  assert.deepEqual(
    evidence.map((e) => e.type),
    ["crash", "console_event"],
  );
  assert.equal(evidence[0].content && (evidence[0].content as { source: string }).source, "appium");

  const withOs = nativeMetadata(
    "xctest",
    { runId: "r", title: "t", file: "f", status: "passed", durationMs: 1 },
    { projectFallback: "iPadOS 19" },
  );
  assert.equal(withOs.project, "iPadOS 19", "the XCTest os fallback survives extraction");
  const withoutFallback = nativeMetadata("appium", {
    runId: "r",
    title: "t",
    file: "f",
    status: "passed",
    durationMs: 1,
  });
  assert.equal(withoutFallback.project, undefined, "appium keeps no implicit fallback");
  assert.equal(
    nativeMetadata(
      "xctest",
      { runId: "r", title: "t", file: "f", project: "iOS", status: "passed", durationMs: 1 },
      { projectFallback: "iPadOS 19" },
    ).project,
    "iOS",
    "an explicit project wins over the fallback",
  );
});