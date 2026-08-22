import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseXCTest, xctestAdapter } from "../../dist/adapter/index.js";

function fixtureDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ve-xctest-"));
  fs.mkdirSync(path.join(dir, "files"), { recursive: true });
  fs.writeFileSync(path.join(dir, "files", "h-01.png"), new Uint8Array([5, 6]));
  fs.mkdirSync(path.join(dir, "files", "run"), { recursive: true });
  fs.writeFileSync(path.join(dir, "files", "run", "clip.mp4"), new Uint8Array([1]));
  fs.writeFileSync(
    path.join(dir, "xctest.json"),
    JSON.stringify({
      schemaVersion: 1,
      runId: "run-4",
      title: "Locker > resume",
      file: "LockerUITests.swift",
      project: "iOS",
      status: "passed",
      durationMs: 2100,
      device: "iPad",
      os: "iPadOS 19",
      hierarchies: [
        {
          name: "player",
          timestamp: 900,
          tree: "*[Resume][button] *[Queue][cell]",
          screenshot: "files/h-01.png",
        },
      ],
      assertEvents: [{ title: "resumed", passed: true }],
      logs: [{ level: "error", message: "stalled", timestamp: 1100 }],
      attachments: { video: "files/run/clip.mp4" },
    }),
  );
  return dir;
}

test("parseXCTest maps hierarchies, logs, attachments and assertions", () => {
  const dir = fixtureDir();
  const artifacts = parseXCTest(dir);
  assert.equal(artifacts.metadata.adapter, "xctest");
  assert.equal(artifacts.metadata.project, "iOS");
  const types = artifacts.evidence?.map((e) => e.type) ?? [];
  assert.ok(types.includes("native_ui_tree"));
  assert.ok(types.includes("screenshot"));
  assert.ok(types.includes("crash"));
  assert.equal(artifacts.assertions?.length, 1);
  assert.ok(artifacts.artifacts?.video, "attachment recorded");
  fs.rmSync(dir, { recursive: true });
});

test("xctestAdapter.build persists a native-ui bundle with attachments", () => {
  const dir = fixtureDir();
  const bundle = xctestAdapter.build(dir);
  assert.equal(bundle.status, "passed");
  const tree = bundle.evidence.find((e) => e.type === "native_ui_tree");
  assert.ok(tree, "has a native ui tree");
  assert.match(String(tree?.content), /Resume/);
  assert.ok(bundle.artifacts.video, "named video artifact");
  assert.ok(fs.existsSync(path.join(dir, bundle.artifacts.video)), "video copied");
  fs.rmSync(dir, { recursive: true });
});