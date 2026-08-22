import type { EvidenceBundle } from "../evidence/model.js";

/**
 * Regression clustering (roadmap Phase 3): when several tests in a run
 * receive REGRESSION/FAIL verdicts, they often share one root cause — a
 * failing backend endpoint, a crashing page, the same console error.
 * Clustering is deterministic: identical failure signatures across judged
 * bundles are grouped, so "6 regressions" can read as "1 likely root cause".
 *
 * No model calls — signals come straight from the evidence bundle.
 */

/** A machine-comparable failure signature extracted from raw evidence. */
export interface FailureSignal {
  kind: "network" | "console-error" | "crash";
  /** Stable grouping key (normalized; query strings stripped). */
  key: string;
}

/**
 * Extract failure signatures from a bundle:
 * - network responses with status >= 400 → `METHOD /path → status`
 * - console messages of type `error` → normalized first line
 * - page crashes (uncaught exceptions) → normalized first line
 */
export function extractFailureSignals(bundle: EvidenceBundle): FailureSignal[] {
  const signals: FailureSignal[] = [];
  for (const evidence of bundle.evidence) {
    const content = evidence.content as Record<string, unknown> | null;
    if (!content) continue;

    if (evidence.type === "network_event") {
      const status = Number(content.status ?? 0);
      if (!(status >= 400)) continue;
      const method = typeof content.method === "string" ? content.method : "GET";
      const url = typeof content.url === "string" ? content.url : "";
      signals.push({
        kind: "network",
        key: `network:${method} ${urlPath(url)} → ${status}`,
      });
    } else if (evidence.type === "console_event" && content.type === "error") {
      // Only `error` is a strong shared-cause signal; keep it strict to
      // avoid clustering unrelated tests over noisy warnings.
      signals.push({
        kind: "console-error",
        key: `console-error:${normalizeMessage(content.text)}`,
      });
    } else if (evidence.type === "crash") {
      signals.push({
        kind: "crash",
        key: `crash:${normalizeMessage(content.message)}`,
      });
    }
  }
  return signals;
}

function urlPath(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.pathname.replace(/\/$/, "") || "/";
  } catch {
    return url.split("?")[0] || url;
  }
}

function normalizeMessage(text: unknown): string {
  const firstLine = String(text ?? "")
    .split("\n")[0]
    .trim();
  return firstLine.slice(0, 160);
}

export interface ClusterTest {
  title: string;
  file: string;
  verdict: string;
  confidence: number;
}

export interface RegressionCluster {
  kind: FailureSignal["kind"];
  label: string;
  tests: ClusterTest[];
}

export interface ClusterInput {
  bundle: EvidenceBundle;
  verdict?: { verdict: string; confidence: number };
}

export interface ClusterResult {
  clusters: RegressionCluster[];
  /** Material verdicts that belong to no cluster of ≥ minClusterSize. */
  unclustered: number;
}

const MATERIAL_VERDICTS = new Set(["REGRESSION", "FAIL", "UNCERTAIN"]);

/**
 * Group material verdicts by identical failure signature. PASS verdicts and
 * judge errors never join a cluster. Clusters smaller than minClusterSize
 * are dissolved back into `unclustered`.
 */
export function clusterRegressions(
  items: Iterable<ClusterInput>,
  minClusterSize = 2,
): ClusterResult {
  const byKey = new Map<
    string,
    { kind: FailureSignal["kind"]; label: string; tests: ClusterTest[] }
  >();

  for (const item of items) {
    const verdict = item.verdict;
    if (!verdict || !MATERIAL_VERDICTS.has(verdict.verdict)) continue;
    for (const signal of extractFailureSignals(item.bundle)) {
      let entry = byKey.get(signal.key);
      if (!entry) {
        entry = { kind: signal.kind, label: signal.key.split(":").slice(1).join(":"), tests: [] };
        byKey.set(signal.key, entry);
      }
      entry.tests.push({
        title: item.bundle.title,
        file: item.bundle.file,
        verdict: verdict.verdict,
        confidence: verdict.confidence,
      });
    }
  }

  const clusters: RegressionCluster[] = [];
  let unclusteredMaterial = 0;
  for (const entry of byKey.values()) {
    if (entry.tests.length >= minClusterSize) {
      clusters.push({ kind: entry.kind, label: entry.label, tests: entry.tests });
    } else {
      unclusteredMaterial += 1;
    }
  }
  clusters.sort((a, b) => b.tests.length - a.tests.length);
  return { clusters, unclustered: unclusteredMaterial };
}

/** Human-readable run-level summary, e.g. for CLI output and CI step summaries. */
export function renderClusterSummary(result: ClusterResult): string {
  if (result.clusters.length === 0 && result.unclustered === 0) return "";
  const materialCount =
    result.clusters.reduce((sum, c) => sum + c.tests.length, 0) + result.unclustered;
  const lines: string[] = [];
  lines.push(
    `Clustering: ${materialCount} material verdict(s) → ${result.clusters.length} likely root cause(s)` +
      (result.unclustered > 0 ? `, ${result.unclustered} unclustered` : ""),
  );
  for (const cluster of result.clusters) {
    const titles = [...new Set(cluster.tests.map((t) => t.title))].join(", ");
    lines.push(`  🔗 ${cluster.label}`);
    lines.push(`     ${cluster.tests.length} test(s): ${titles}`);
  }
  return lines.join("\n");
}
