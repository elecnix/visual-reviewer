import fs from "node:fs";
import path from "node:path";
import { buildBundleFromAdapter } from "./build.js";
import type {
  AdapterArtifacts,
  AdapterEvidence,
  AdapterStatus,
  FrameworkAdapter,
} from "./types.js";

/**
 * Appium adapter (Phase-3 roadmap: native adapters).
 *
 * Appium drives iOS/Android apps through the WebDriver protocol; sessions are
 * exported as structured JSON plus browser/device assets. This adapter trims
 * that export into the canonical AdapterArtifacts shape so the Appium run is
 * judged exactly like a Playwright run. Nothing downstream knows Appium exists.
 *
 * Expected manifest (`appium.json` in the artifact dir):
 *
 *   {
 *     "schemaVersion": 1,
 *     "runId": "…", "title": "…", "file": "…", "project": "…",
 *     "status": "passed|failed|…", "durationMs": 1234,
 *     "device": "iPhone 15", "appId": "com.example.app",
 *     "steps": [
 *       { "action": "tap", "target": "Upgrade", "timestamp": 1200,
 *         "screenshot": "files/step-01.png", "visible": "*[Upgrade][button]" }
 *     ],
 *     "assertEvents": [{ "title": "…", "passed": true, "error": "…" }],
 *     "networkEvents": [{ "method": "POST", "url": "…", "status": 500,
 *                         "body": "…", "timestamp": 3000 }],
 *     "logEvents": [{ "level": "error", "message": "…", "timestamp": 3100 }]
 *   }
 *
 * `screenshot` and `visible` paths are relative to the manifest's directory.
 */

export interface AppiumManifest {
  schemaVersion: 1;
  runId: string;
  title: string;
  file: string;
  project?: string;
  status: AdapterStatus;
  durationMs: number;
  device?: string;
  appId?: string;
  steps: AppiumStep[];
  assertEvents?: AppiumAssert[];
  networkEvents?: AppiumNetwork[];
  logEvents?: AppiumLog[];
}

interface AppiumStep {
  action: string;
  target?: string;
  timestamp: number;
  /** Path to a screenshot asset relative to the manifest dir. */
  screenshot?: string;
  /** Current UI hierarchy (accessibility-style tree) at this step. */
  visible?: string;
}

interface AppiumAssert {
  title: string;
  passed: boolean;
  error?: string;
}

interface AppiumNetwork {
  method: string;
  url: string;
  status?: number;
  body?: string;
  timestamp: number;
}

interface AppiumLog {
  level: string;
  message: string;
  timestamp: number;
}

export const appiumAdapter: FrameworkAdapter = {
  id: "appium",
  label: "Appium (iOS/Android)",
  version: "1.0.0",
  kind: "native",
  parse(dir: string): AdapterArtifacts {
    return parseAppium(dir);
  },
  build(dir: string) {
    return buildBundleFromAdapter(parseAppium(dir), dir);
  },
};

export function parseAppium(dir: string): AdapterArtifacts {
  const manifest = JSON.parse(
    fs.readFileSync(path.join(dir, "appium.json"), "utf8"),
  ) as AppiumManifest;

  const evidence: AdapterEvidence[] = [];

  manifest.steps.forEach((step, i) => {
    const seq = i + 1;
    if (step.screenshot) {
      evidence.push({
        type: "screenshot",
        timestamp: step.timestamp,
        content: { action: step.action, target: step.target },
        asset: path.join(dir, step.screenshot),
        metadata: { step: seq, action: step.action },
      });
    }
    if (step.visible) {
      evidence.push({
        type: "native_state",
        timestamp: step.timestamp,
        content: step.visible,
        metadata: { step: seq },
      });
    }
    evidence.push({
      type: "user_action",
      timestamp: step.timestamp,
      content: { action: step.action, target: step.target, step: seq },
      metadata: { step: seq },
    });
  });

  for (const ev of manifest.networkEvents ?? []) {
    evidence.push({
      type: "network_event",
      timestamp: ev.timestamp,
      content: {
        method: ev.method,
        url: ev.url,
        status: ev.status,
        body: ev.body,
        source: "appium",
      },
    });
  }

  for (const ev of manifest.logEvents ?? []) {
    evidence.push({
      type: /\berror\b/i.test(ev.level) ? "crash" : "console_event",
      timestamp: ev.timestamp,
      content: { level: ev.level, message: ev.message, source: "appium" },
    });
  }

  return {
    metadata: {
      adapter: "appium",
      schemaVersion: 1,
      runId: manifest.runId,
      title: manifest.title,
      file: manifest.file,
      project: manifest.project,
      status: manifest.status,
      durationMs: manifest.durationMs,
    },
    assertions: manifest.assertEvents ?? [],
    evidence,
    // No extra named artifacts beyond the per-step screenshots today.
    artifacts: undefined,
  };
}