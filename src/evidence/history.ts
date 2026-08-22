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
  const dir = path.join(bundleDir, HISTORY_DIR);
  let files: string[];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith(".json")).sort();
  } catch {
    return null;
  }
  if (files.length === 0) return null;
  try {
    const raw = fs.readFileSync(path.join(dir, files[files.length - 1]), "utf8");
    return JSON.parse(raw) as HistoryRecord;
  } catch {
    return null;
  }
}
