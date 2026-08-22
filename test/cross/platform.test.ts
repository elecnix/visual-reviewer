import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  appiumAdapter,
  xctestAdapter,
  groupPlatformRuns,
  consistencyKey,
} from "../../dist/index.js";

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ve-cross-"));
}

function appiumFixtureDir(root: string): string {
  const dir = path.join(root, "iOS");
  fs.mkdirSync(path.join(dir, "files"), { recursive: true });
  fs.writeFileSync(path.join(dir, "files", "s.png"), new Uint8Array([1]));
  fs.writeFileSync(
    path.join(dir, "appium.json"),
    JSON.stringify({
      schemaVersion: 1,
      runId: "r-a",
      title: "signin > remember me",
      file: "signin.uitest.swift",
      project: "iOS",
      status: "failed",
      durationMs: 900,
      steps: [
        { action: "tap", target: "Remember me", timestamp: 100, screenshot: "files/s.png" },
      ],
      assertEvents: [{ title: "toggles remember", passed: false, error: "no persist" }],
    }),
  );
  return dir;
}

function xctestFixtureDir(root: string): string {
  const dir = path.join(root, "macOS");
  fs.mkdirSync(path.join(dir, "files"), { recursive: true });
  fs.writeFileSync(path.join(dir, "files", "shot.png"), new Uint8Array([2]));
  fs.writeFileSync(
    path.join(dir, "xctest.json"),
    JSON.stringify({
      schemaVersion: 1,
      runId: "r-x",
      title: "signin > remember me",
      file: "SigninUITests.swift",
      project: "macOS",
      status: "passed",
      durationMs: 800,
      hierarchies: [
        { name: "signin", timestamp: 120, tree: "*[Remember me][checkbox, on]" },
      ],
      assertEvents: [{ title: "toggles remember", passed: true }],
    }),
  );
  return dir;
}

test("consistencyKey is intent segment, platform independent", () => {
  const root = tmpDir();
  const ios = appiumAdapter.build(appiumFixtureDir(root));
  const key = consistencyKey(ios);
  assert.equal(key, "signin");
  fs.rmSync(root, { recursive: true });
});

test("groupPlatformRuns groups same intent across platforms and flags divergence", () => {
  const root = tmpDir();
  const iosDir = appiumFixtureDir(root);
  const macDir = xctestFixtureDir(root);
  appiumAdapter.build(iosDir);
  xctestAdapter.build(macDir);

  const groups = groupPlatformRuns([
    path.join(iosDir, "bundle.json"),
    path.join(macDir, "bundle.json"),
  ]);
  assert.equal(groups.length, 1, "one shared-intent group");
  const [group] = groups;
  assert.equal(group.runs.length, 2, "both platforms grouped");
  assert.equal(group.allPassed, false, "iOS failed so not all passed");
  assert.equal(group.divergent, true, "statuses differ across harnesses");
  const platforms = group.runs.map((r) => r.platform).sort();
  assert.deepEqual(platforms, ["iOS", "macOS"]);
  const iosRun = group.runs.find((r) => r.platform === "iOS");
  assert.equal(iosRun?.assertionsPassed, 0, "iOS assertion failed");
  assert.equal(iosRun?.hasNativeUI, false, "appium exposes native_state, not a ui tree");
  fs.rmSync(root, { recursive: true });
});