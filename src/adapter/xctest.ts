import fs from "node:fs";
import path from "node:path";
import {
  defineNativeAdapter,
  logEventsToEvidence,
  nativeMetadata,
  type NativeLogEvent,
} from "./native.js";
import type { AdapterArtifacts, AdapterEvidence, AdapterStatus } from "./types.js";

/**
 * XCTest adapter (Phase-3 roadmap: native adapters).
 *
 * XCTest (XCUITest) produces .xcresult bundles with JSON snapshots, UI
 * hierarchy dumps and asset attachments. This adapter translates a documented
 * export into canonical adapter artifacts, so an XCUITest / macOS-native run
 * is judged through the same EvidenceBundle spine as a Playwright run.
 *
 * Expected manifest (`xctest.json` in the artifact dir):
 *
 *   {
 *     "schemaVersion": 1,
 *     "runId": "…", "title": "…", "file": "…", "project": "…",
 *     "status": "passed|failed|…", "durationMs": 1234,
 *     "device": "iPhone 15", "os": "iOS 19",
 *     "hierarchies": [
 *       { "name": "locker", "timestamp": 1200,
 *         "tree": "*[Upgrade][button]", "screenshot": "files/h-01.png" }
 *     ],
 *     "assertEvents": [{ "title": "…", "passed": true, "error": "…" }],
 *     "logs": [{ "level": "error", "message": "…", "timestamp": 1300 }],
 *     "attachments": { "video": "files/run.mp4" }
 *   }
 *
 * `tree`, `screenshot` and attachment paths are relative to the manifest dir
 * and are resolved by the bundle builder, not here.
 */

export interface XCTestManifest {
  schemaVersion: 1;
  runId: string;
  title: string;
  file: string;
  project?: string;
  status: AdapterStatus;
  durationMs: number;
  device?: string;
  os?: string;
  hierarchies: XCTestHierarchy[];
  assertEvents?: XCTestAssert[];
  logs?: XCTestLog[];
  attachments?: Record<string, string>;
}

interface XCTestHierarchy {
  name: string;
  timestamp: number;
  /** XCUITest accessibility-style hierarchy text. */
  tree: string;
  /** Path to a screenshot asset relative to the manifest dir. */
  screenshot?: string;
}

interface XCTestAssert {
  title: string;
  passed: boolean;
  error?: string;
}

interface XCTestLog extends NativeLogEvent {}

export const xctestAdapter = defineNativeAdapter({
  id: "xctest",
  label: "XCTest / XCUITest (Apple native)",
  version: "1.0.0",
  parse: parseXCTest,
});

export function parseXCTest(dir: string): AdapterArtifacts {
  const manifest = JSON.parse(
    fs.readFileSync(path.join(dir, "xctest.json"), "utf8"),
  ) as XCTestManifest;

  const evidence: AdapterEvidence[] = [];
  manifest.hierarchies.forEach((h, i) => {
    const seq = i + 1;
    if (h.screenshot) {
      evidence.push({
        type: "screenshot",
        timestamp: h.timestamp,
        content: { hierarchy: h.name },
        asset: h.screenshot,
        metadata: { hierarchy: h.name, seq },
      });
    }
    evidence.push({
      type: "native_ui_tree",
      timestamp: h.timestamp,
      content: h.tree,
      metadata: { hierarchy: h.name, seq },
    });
  });

  evidence.push(...logEventsToEvidence(manifest.logs, "xctest"));

  // `attachments` are kept verbatim: the builder resolves them against the
  // artifact dir, exactly like `asset`.
  return {
    metadata: nativeMetadata(
      "xctest",
      {
        runId: manifest.runId,
        title: manifest.title,
        file: manifest.file,
        project: manifest.project,
        status: manifest.status,
        durationMs: manifest.durationMs,
      },
      // XCTest reports the platform as `os` when there is no `project`.
      { projectFallback: manifest.os },
    ),
    assertions: manifest.assertEvents ?? [],
    evidence,
    artifacts: manifest.attachments ?? {},
  };
}