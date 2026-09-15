import path from "node:path";
import { readBundle } from "../evidence/store.js";
import type { Evidence, EvidenceBundle } from "../evidence/model.js";
import { getAdapter } from "../adapter/registry.js";
import type { FrameworkAdapter } from "../adapter/types.js";

/**
 * Cross-platform consistency (brief §17 Phase 3).
 *
 * The same user-intent test runs on several harnesses (web, iOS via Appium,
 * macOS/iOS via XCUITest, …). Each produces its own EvidenceBundle. This
 * module groups those bundles by the *intent* they share — the test's first
 * title segment plus its platform — and emits a structured comparison a judge
 * (or a CLI) can reason over: which platforms agree, which diverge, and what
 * each platform's deterministic status claims.
 *
 * Read-only and deterministic: no model call, no side effects. The grouping
 * is pure evidence shaping for the oracle / a human reviewer.
 */

export interface PlatformRun {
  /** Adapter id, e.g. "appium", "xctest", "playwright". */
  adapter: string;
  /** Derived platform label (project when set, else "web"). */
  platform: string;
  bundlePath: string;
  title: string;
  status: EvidenceBundle["status"];
  assertionsPassed: number;
  assertionsTotal: number;
  screenshots: Evidence[];
  hasNativeUI: boolean;
}

export interface ConsistencyGroup {
  key: string;
  intentTitle: string;
  runs: PlatformRun[];
  /** True when every platform's deterministic status is `passed`. */
  allPassed: boolean;
  /** True when at least two platforms are present and statuses differ. */
  divergent: boolean;
  /** True when exactly one platform is present (no cross-check possible). */
  singlePlatform: boolean;
}

const REGISTERED: Record<string, FrameworkAdapter> = {};

/** Register a specialized adapter so platform labels stay accurate. */
export function registerPlatformAdapter(adapter: FrameworkAdapter): void {
  REGISTERED[adapter.id] = adapter;
}

function adapterKind(id: string): "web" | "native" | undefined {
  return (REGISTERED[id] ?? getAdapter(id))?.kind;
}

function platformLabel(bundle: EvidenceBundle): string {
  const sourceId = bundle.evidence.find((e) => typeof e.source === "string")?.source
    ?.split(":")[0];
  if (sourceId) {
    const kind = adapterKind(sourceId);
    if (kind === "native") return bundle.project && bundle.project !== "web"
      ? bundle.project
      : "native";
  }
  return bundle.project ?? "web";
}

/**
 * Group key: the normalized intent — the test's first title segment.
 * Platform is deliberately omitted so the SAME intent on different
 * harnesses (web/iOS/macOS) lands in one group for comparison.
 */
export function consistencyKey(bundle: EvidenceBundle): string {
  return bundle.title.split(/[›>]/)[0].trim().toLowerCase();
}

/** Inventory one bundle for cross-platform comparison. */
export function runFromBundle(bundle: EvidenceBundle, bundleDir: string): PlatformRun {
  const passed = bundle.assertions.filter((a) => a.passed).length;
  const sourceId = bundle.evidence.find((e) => typeof e.source === "string")?.source
    ?.split(":")[0] ?? "unknown";
  return {
    adapter: sourceId,
    platform: platformLabel(bundle),
    bundlePath: bundleDir,
    title: bundle.title,
    status: bundle.status,
    assertionsPassed: passed,
    assertionsTotal: bundle.assertions.length,
    screenshots: bundle.evidence.filter((e) => e.type === "screenshot"),
    hasNativeUI: bundle.evidence.some((e) => e.type === "native_ui_tree"),
  };
}

/** Group bundles (their bundle.json paths) by shared intent across platforms. */
export function groupPlatformRuns(bundlePaths: string[]): ConsistencyGroup[] {
  const groups = new Map<string, ConsistencyGroup>();
  for (const bundlePath of bundlePaths) {
    const bundle = readBundle(bundlePath);
    const bundleDir = path.dirname(bundlePath);
    const run = runFromBundle(bundle, bundleDir);
    const key = consistencyKey(bundle);
    const existing = groups.get(key);
    if (existing) existing.runs.push(run);
    else {
      groups.set(key, {
        key,
        intentTitle: run.title,
        runs: [run],
      } as ConsistencyGroup);
    }
  }

  for (const [key, group] of groups) {
    const statuses = group.runs.map((r) => r.status);
    group.allPassed = statuses.every((s) => s === "passed");
    group.divergent = group.runs.length >= 2 && new Set(statuses).size >= 2;
    group.singlePlatform = group.runs.length === 1;
    group.intentTitle = group.runs[0].title;
  }
  return [...groups.values()].sort((a, b) => a.key.localeCompare(b.key));
}