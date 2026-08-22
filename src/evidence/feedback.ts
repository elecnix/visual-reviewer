import fs from "node:fs";
import path from "node:path";

/**
 * Human feedback on AI verdicts (brief §17: HUMAN FEEDBACK → MEMORY).
 * Records live in one JSONL file; judgements of the same test replay
 * past feedback into the oracle's context so repeated mistakes are
 * corrected once, not every run.
 */

export interface FeedbackRecord {
  timestamp: string;
  /** The bundle's testId the feedback applies to. */
  testId: string;
  /** Human-readable test title at feedback time. */
  title: string;
  /** true = human agrees with the verdict, false = rejected it. */
  accepted: boolean;
  /** The AI verdict being judged, e.g. "REGRESSION". */
  verdict?: string;
  note?: string;
}

export function saveFeedbackRecord(
  feedbackFile: string,
  record: FeedbackRecord,
): void {
  fs.mkdirSync(path.dirname(feedbackFile), { recursive: true });
  fs.appendFileSync(feedbackFile, `${JSON.stringify(record)}\n`);
}

export function loadFeedbackForTest(
  feedbackFile: string,
  testId: string,
  limit = 5,
): FeedbackRecord[] {
  let raw: string;
  try {
    raw = fs.readFileSync(feedbackFile, "utf8");
  } catch {
    return [];
  }
  const all: FeedbackRecord[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      all.push(JSON.parse(line) as FeedbackRecord);
    } catch {
      /* tolerate partial lines */
    }
  }
  return all
    .filter((r) => r.testId === testId)
    .slice(-limit);
}
