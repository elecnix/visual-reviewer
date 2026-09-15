import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseAppium, appiumAdapter } from "../../dist/adapter/index.js";

function fixtureDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ve-appium-"));
  fs.mkdirSync(path.join(dir, "files"), { recursive: true });
  fs.writeFileSync(path.join(dir, "files", "step-01.png"), new Uint8Array([9, 9]));
  fs.writeFileSync(
    path.join(dir, "appium.json"),
    JSON.stringify({
      schemaVersion: 1,
      runId: "run-2",
      title: "iOS locker > now streaming",
      file: "streaming.uitest.swift",
      project: "iOS",
      status: "failed",
      durationMs: 4400,
      device: "iPhone 15",
      appId: "com.example.music",
      steps: [
        {
          action: "tap",
          target: "Now Streaming",
          timestamp: 800,
          screenshot: "files/step-01.png",
          visible: "*[Now Streaming][button, selected]",
        },
        { action: "assert", target: "Play title", timestamp: 1500 },
      ],
      assertEvents: [{ title: "screen holds play", passed: false, error: "title missing" }],
      networkEvents: [{ method: "POST", url: "https://api.music/play", status: 500, timestamp: 2100 }],
      logEvents: [
        { level: "info", message: "opened locker", timestamp: 200 },
        { level: "error", message: "URL session failed", timestamp: 2200 },
      ],
    }),
  );
  return dir;
}

test("parseAppium maps steps, network, logs and assertions into canonical artifacts", () => {
  const dir = fixtureDir();
  const artifacts = parseAppium(dir);
  assert.equal(artifacts.metadata.adapter, "appium");
  assert.equal(artifacts.metadata.status, "failed");
  assert.equal(artifacts.assertions?.length, 1);
  const types = artifacts.evidence?.map((e) => e.type) ?? [];
  assert.ok(types.includes("screenshot"));
  assert.ok(types.includes("native_state"));
  assert.ok(types.includes("user_action"));
  assert.ok(types.includes("network_event"));
  assert.ok(types.includes("crash"));
  assert.ok(types.includes("console_event"));
  fs.rmSync(dir, { recursive: true });
});

test("appiumAdapter.build persists a bundle with a usable evidence chain", () => {
  const dir = fixtureDir();
  const bundle = appiumAdapter.build(dir);
  assert.equal(bundle.title, "iOS locker > now streaming");
  assert.equal(bundle.status, "failed");
  const shot = bundle.evidence.find((e) => e.type === "screenshot");
  assert.ok(shot, "has a screenshot");
  const rel = (shot.content as { file: string }).file;
  assert.ok(fs.existsSync(path.join(dir, rel)), "screenshot asset copied");
  const actions = bundle.evidence.filter((e) => e.type === "user_action");
  assert.equal(actions.length, 2, "one user_action per step");
  fs.rmSync(dir, { recursive: true });
});