import type { Evidence, EvidenceBundle, EvidenceType } from "../evidence/model.js";

/**
 * Framework-adapter contract (brief §5, §7 "framework-agnostic").
 *
 * Visual Reviewer's spine is  Evidence → Context → Reasoning → Verdict .
 * Playwright was the first adapter; a native adapter (Appium, XCTest, …)
 * merely translates its framework's artifacts into the same EvidenceBundle
 * shape. Nothing downstream knows or cares which framework produced them.
 *
 * The native artifact contract:
 *
 *   artifactsDir/
 *     metadata.json     { adapter, schemaVersion, runId, project, title,
 *                         file, status, durationMs }
 *     sourceCode        (or .json with { source }: the test spec text)
 *     assertions.json   [{ title, passed, error? }]
 *     evidence.json     [{ type, timestamp, content, asset?, metadata? }]
 *     artifacts.json    { name -> relative path }  (optional named artifacts)
 *     files/...          binary assets referenced by `asset` paths
 */

/** Deterministic test outcome exposed by an adapter (subset of bundle status). */
export type AdapterStatus =
  | "passed"
  | "failed"
  | "timedOut"
  | "skipped"
  | "interrupted";

export interface AdapterMetadata {
  /** Adapter id, e.g. "playwright", "appium", "xctest". */
  adapter: string;
  /** Framework schema version this parser understands. */
  schemaVersion: 1;
  runId: string;
  title: string;
  /** Test spec path (used as the bundle's `file`). */
  file: string;
  status: AdapterStatus;
  durationMs: number;
  project?: string;
}

export interface AdapterAssertion {
  title: string;
  passed: boolean;
  error?: string;
}

/**
 * One observation in canonical form. `content` mirrors the bundle's Evidence
 * `content`; `asset`, when present, is a path relative to the artifacts dir
 * whose bytes back a screenshot / native-state dump (resolved by the
 * bundle builder into a bundle-relative `{ file }` reference).
 */
export interface AdapterEvidence {
  type: EvidenceType;
  timestamp: number;
  content: unknown;
  asset?: string;
  metadata?: Record<string, unknown>;
}

/** Everything a framework-specific parser must produce before bundling. */
export interface AdapterArtifacts {
  metadata: AdapterMetadata;
  sourceCode?: string;
  assertions?: AdapterAssertion[];
  evidence?: AdapterEvidence[];
  /** Named artifact copies alongside the bundle (trace.zip, …). */
  artifacts?: Record<string, string>;
}

/**
 * A concrete adapter. `kind` distinguishes web (Playwright) from native
 * (Appium/XCTest) so cross-platform consistency tooling can group runs.
 */
export interface FrameworkAdapter {
  id: string;
  label: string;
  version: string;
  kind: "web" | "native";
  /** Parse a framework artifact directory into canonical form. */
  parse(dir: string): AdapterArtifacts;
  /** Parse + resolve assets into a persisted EvidenceBundle. */
  build(dir: string): EvidenceBundle;
}

export type { EvidenceType };