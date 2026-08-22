/**
 * Framework-agnostic evidence model.
 *
 * Architectural rule: no Playwright concepts here. Adapters translate their
 * framework's artifacts into these types; the oracle core knows nothing else.
 */

export type EvidenceType =
  | "screenshot"
  | "video_frame"
  | "dom_snapshot"
  | "accessibility_tree"
  | "native_ui_tree"
  | "network_event"
  | "console_event"
  | "log_event"
  | "crash"
  | "assertion"
  | "test_source"
  | "browser_state"
  | "native_state"
  | "user_action";

/** Images are not special — a screenshot is just another typed observation. */
export interface Evidence {
  id: string;
  timestamp: number;
  type: EvidenceType;
  /** What produced it, e.g. "playwright:trace", "fixture:network". */
  source: string;
  /**
   * Payload for this observation. For screenshots this is either a base64
   * data string or `{ file: "<relative path>" }` pointing at an asset
   * written next to bundle.json.
   */
  content: unknown;
  metadata?: Record<string, unknown>;
}

export interface AssertionRecord {
  title: string;
  passed: boolean;
  error?: string;
}

export interface TestError {
  message: string;
  stack?: string;
}

export interface EvidenceBundle {
  schemaVersion: 1;
  runId: string;
  testId: string;
  project?: string;
  title: string;
  /** Path of the spec file the test lives in. */
  file: string;
  sourceCode: string;
  status: "passed" | "failed" | "timedOut" | "skipped" | "interrupted";
  durationMs: number;
  /** Deterministic assertion outcomes observed by the adapter. */
  assertions: AssertionRecord[];
  error?: TestError;
  evidence: Evidence[];
  /** Named artifact files written alongside bundle.json (trace, video…). */
  artifacts: Record<string, string>;
}

let counter = 0;
/** Cheap unique-enough evidence id local to one bundle. */
export function nextEvidenceId(prefix: string): string {
  counter += 1;
  return `${prefix}-${counter.toString(36).padStart(4, "0")}`;
}
