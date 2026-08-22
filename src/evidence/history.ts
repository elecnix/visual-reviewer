import fs from "node:fs";
import path from "node:path";

/**
 * Per-test run history — the substrate for semantic baseline comparison.
 * One JSON record per judged run; the most recent prior record is the
 * baseline for the next judgement.
 */

export interface HistoryRecord {
  timestamp: string;
  verdict: string;
  confidence: number;
  deterministicStatus: string;
  assertionsPassed: number;
  assertionsTotal: number;
  /** Bundle-relative path of the run's final screenshot, when available. */
  finalScreenshot?: string;
}

const HISTORY_DIR = "history";

export function saveHistoryRecord(
  bundleDir: string,
  record: HistoryRecord,
): void {
  const dir = path.join(bundleDir, HISTORY_DIR);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${record.timestamp.replace(/[:.]/g, "-")}.json`);
  fs.writeFileSync(file, JSON.stringify(record, null, 2));
}

export function loadLatestHistory(bundleDir: string): HistoryRecord | null {
  const all = loadAllHistory(bundleDir);
  return all.length > 0 ? all[all.length - 1] : null;
}

export function loadAllHistory(bundleDir: string): HistoryRecord[] {
  const dir = path.join(bundleDir, HISTORY_DIR);
  let files: string[];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith(".json")).sort();
  } catch {
    return [];
  }
  const records: HistoryRecord[] = [];
  for (const file of files) {
    try {
      records.push(JSON.parse(fs.readFileSync(path.join(dir, file), "utf8")) as HistoryRecord);
    } catch {
      /* skip malformed */
    }
  }
  return records;
}

/**
 * Flakiness signal: count verdict flips across the recorded history.
 * A flip-flopping verdict (PASS↔REGRESSION) suggests flaky app behavior,
 * unstable test environment, or an oracle that needs feedback.
 */
export function detectFlakiness(records: HistoryRecord[]): string | null {
  if (records.length < 3) return null;
  const verdicts = records.map((r) => r.verdict);
  let flips = 0;
  for (let i = 1; i < verdicts.length; i++) {
    if (verdicts[i] !== verdicts[i - 1]) flips += 1;
  }
  if (flips < 2) return null;
  return `This test's AI verdict flip-flopped across its last ${records.length} recorded runs (${verdicts.join(" → ")}). Consider possible flaky application behavior, unstable test environment, or inconsistent evidence before finalizing.`;
}
