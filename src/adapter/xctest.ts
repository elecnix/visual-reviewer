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
 * `tree`, `screenshot` and attachment paths are relative to the manifest dir.
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

interface XCTestLog {
  level: string;
  message: string;
  timestamp: number;
}

export const xctestAdapter: FrameworkAdapter = {
  id: "xctest",
  label: "XCTest / XCUITest (Apple native)",
  version: "1.0.0",
  kind: "native",
  parse(dir: string): AdapterArtifacts {
    return parseXCTest(dir);
  },
  build(dir: string) {
    return buildBundleFromAdapter(parseXCTest(dir), dir);
  },
};

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
        asset: path.join(dir, h.screenshot),
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

  for (const ev of manifest.logs ?? []) {
    evidence.push({
      type: /\berror\b/i.test(ev.level) ? "crash" : "console_event",
      timestamp: ev.timestamp,
      content: { level: ev.level, message: ev.message, source: "xctest" },
    });
  }

  const attachments: Record<string, string> = {};
  for (const [name, file] of Object.entries(manifest.attachments ?? {})) {
    attachments[name] = path.join(dir, file);
  }

  return {
    metadata: {
      adapter: "xctest",
      schemaVersion: 1,
      runId: manifest.runId,
      title: manifest.title,
      file: manifest.file,
      project: manifest.project ?? manifest.os,
      status: manifest.status,
      durationMs: manifest.durationMs,
    },
    assertions: manifest.assertEvents ?? [],
    evidence,
    artifacts: attachments,
  };
}