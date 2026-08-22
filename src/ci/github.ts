import fs from "node:fs";
import type { Judgement } from "../oracle/judge.js";

/**
 * GitHub CI integration — advisory, per the product's non-goals:
 * verdicts surface as step-summary rows and ::warning annotations,
 * never as check failures.
 */

export function isGitHubCI(): boolean {
  return process.env.GITHUB_ACTIONS === "true";
}

/** Append the verdict table to the GitHub Actions job summary. */
export function writeStepSummary(judgements: Judgement[]): void {
  const summaryFile = process.env.GITHUB_STEP_SUMMARY;
  if (!summaryFile || judgements.length === 0) return;

  const icon: Record<string, string> = {
    PASS: "✅",
    REGRESSION: "🚨",
    FAIL: "❌",
    UNCERTAIN: "⚠️",
  };

  const rows = judgements
    .map((j) => {
      if (j.verdict) {
        const { verdict, confidence } = j.verdict;
        return `| ${icon[verdict] ?? "•"} ${verdict} | ${Math.round(confidence * 100)}% | ${escapeCell(firstLine(j.verdict.intentSummary))} |`;
      }
      return `| ⚠️ JUDGE ERROR | — | ${escapeCell(firstLine(j.error ?? ""))} |`;
    })
    .join("\n");

  const summary = [
    "",
    "## visual-reviewer (advisory)",
    "",
    "| Verdict | Confidence | Intent |",
    "|---|---|---|",
    rows,
    "",
    "<sub>Advisory-only — these verdicts never fail the job.</sub>",
    "",
  ].join("\n");

  try {
    fs.appendFileSync(summaryFile, summary);
  } catch {
    /* best-effort */
  }
}

/** Emit ::warning annotations for material findings (REGRESSION/FAIL only). */
export function emitAnnotations(judgements: Judgement[]): void {
  if (!isGitHubCI()) return;
  for (const j of judgements) {
    if (!j.verdict) continue;
    if (j.verdict.verdict !== "REGRESSION" && j.verdict.verdict !== "FAIL") continue;
    const message = `${firstLine(j.verdict.reasoning)} (advisory)`;
    // Keep within GitHub annotation limits (~1KB message, no newlines).
    process.stdout.write(
      `::warning title=visual-reviewer: ${j.verdict.verdict} (${Math.round(
        j.verdict.confidence * 100,
      )}% confidence)::${message.replace(/[\r\n%]/g, " ").slice(0, 400)}\n`,
    );
  }
}

function firstLine(text: string): string {
  return text.split("\n")[0]?.trim() ?? "";
}

function escapeCell(text: string): string {
  return text.replace(/\|/g, "\\|").slice(0, 200);
}
