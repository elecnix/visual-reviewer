import { z } from "zod";
import type { EvidenceBundle } from "../evidence/model.js";

/**
 * The verdict vocabulary — parsing, materiality and every presentation-neutral
 * projection live here so that sinks render and never decide.
 *
 * Structured verdict. UNCERTAIN is a first-class result, never a failure
 * to decide. Every claim must reference evidence by id.
 */
export const VerdictSchema = z.object({
  verdict: z.enum(["PASS", "REGRESSION", "FAIL", "UNCERTAIN"]),
  /** 0..1 calibrated confidence in the verdict. */
  confidence: z.number().min(0).max(1),
  /** One-line reading of what the test was supposed to verify. */
  intentSummary: z.string(),
  reasoning: z.string(),
  /** Observations that support the verdict, each tied to evidence ids. */
  supportingEvidence: z.array(
    z.object({
      evidenceIds: z.array(z.string()),
      observation: z.string(),
    }),
  ),
  /** Contradictory or suspicious observations, if any. */
  suspiciousObservations: z.array(
    z.object({
      evidenceIds: z.array(z.string()),
      observation: z.string(),
    }),
  ),
  suggestedNextStep: z.string().optional(),
});

export type Verdict = z.infer<typeof VerdictSchema>;

/** The four verdict values, straight off the schema so the two cannot drift. */
export type VerdictKind = Verdict["verdict"];

// A copy, not an alias. `readonly` is compile-time only, so assigning the
// Zod enum's own options array would let any JS caller (or a cast) push onto
// it and change what VerdictSchema.parse accepts for the rest of the process.
export const VERDICT_KINDS: readonly VerdictKind[] = [
  ...VerdictSchema.shape.verdict.options,
];

/**
 * Verdict semantics, defined exactly once.
 *
 * Each rule is an exhaustive `Record<VerdictKind, …>` on purpose: adding a
 * value to `VerdictSchema` is then a compile error in this module rather than
 * a silently-wrong runtime decision spread across every sink. Previously
 * "material verdict" meant three different things (`cluster.ts`,
 * `ci/github.ts`, `oracle/bench.ts`) with three different memberships.
 */

/**
 * Worth run-level attention: clustering, the cluster summary, counts. An
 * UNCERTAIN is a decision the oracle made, not a pass, so it counts.
 */
const MATERIAL: Record<VerdictKind, boolean> = {
  PASS: false,
  REGRESSION: true,
  FAIL: true,
  UNCERTAIN: true,
};

/**
 * Asserts the application is broken, as opposed to "we could not tell". Used
 * for CI annotations and for benchmark false-positive/negative accounting,
 * where UNCERTAIN is neither a hit nor a miss.
 */
const FAILING: Record<VerdictKind, boolean> = {
  PASS: false,
  REGRESSION: true,
  FAIL: true,
  UNCERTAIN: false,
};

const ICON: Record<VerdictKind, string> = {
  PASS: "✅",
  REGRESSION: "🚨",
  FAIL: "❌",
  UNCERTAIN: "⚠️",
};

/** CSS class carrying the verdict's colour/weight policy in the HTML report. */
const CSS_CLASS: Record<VerdictKind, string> = {
  PASS: "pass",
  REGRESSION: "regression",
  FAIL: "fail",
  UNCERTAIN: "uncertain",
};

export function isMaterial(verdict: VerdictKind | string): boolean {
  return isVerdictKind(verdict) && MATERIAL[verdict];
}

/** A confirmed bad outcome. UNCERTAIN is deliberately not one. */
export function isFailing(verdict: VerdictKind | string): boolean {
  return isVerdictKind(verdict) && FAILING[verdict];
}

/**
 * The follow-up gate: UNCERTAIN means "investigate further", and so does low
 * confidence in any verdict. This is UNCERTAIN's third meaning, distinct from
 * materiality — it drives an extra model round, not a report section.
 */
export function needsFollowUp(
  verdict: Pick<Verdict, "verdict" | "confidence">,
  confidenceThreshold: number,
): boolean {
  return verdict.verdict === "UNCERTAIN" || verdict.confidence < confidenceThreshold;
}

/** Narrow an untrusted string (e.g. from disk) to the verdict vocabulary. */
export function isVerdictKind(value: string): value is VerdictKind {
  return (VERDICT_KINDS as readonly string[]).includes(value);
}

export function verdictIcon(verdict: VerdictKind | string): string {
  return isVerdictKind(verdict) ? ICON[verdict] : "•";
}

export function verdictCssClass(verdict: VerdictKind | string): string {
  return isVerdictKind(verdict) ? CSS_CLASS[verdict] : "unknown";
}

/** Confidence as a rounded integer percentage, e.g. `0.853` → `"85%"`. */
export function verdictPercent(confidence: number): string {
  return `${Math.round(confidence * 100)}%`;
}

/**
 * First non-empty line of model prose, optionally truncated. Model output is
 * unbounded; every sink that quotes it needs the same trim-and-cap.
 */
export function firstLine(text: string, maxLength?: number): string {
  const line = text.split("\n")[0]?.trim() ?? "";
  return maxLength === undefined ? line : line.slice(0, maxLength);
}

export interface AssertionTally {
  passed: number;
  total: number;
  /** `"3/5"` — the projection the reports print. */
  text: string;
}

/** Passed/total assertion counts. The deterministic half of every report. */
export function assertionTally(bundle: EvidenceBundle): AssertionTally {
  const total = bundle.assertions.length;
  const passed = bundle.assertions.filter((a) => a.passed).length;
  return { passed, total, text: `${passed}/${total}` };
}

/**
 * Extract the first JSON object from model output. Cheap models add prose,
 * code fences, or reasoning blocks around the verdict; some emit slightly
 * invalid JSON (trailing commas). Tolerant by design.
 */
export function extractVerdictJson(text: string): unknown {
  const cleaned = text.replace(/<think>[\s\S]*?<\/think>/g, "");
  const candidates: string[] = [];
  const fenced = cleaned.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/);
  if (fenced) candidates.push(fenced[1]);
  // First balanced top-level object — survives trailing prose with braces.
  const balanced = firstJsonObject(cleaned);
  if (balanced) candidates.push(balanced);
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start !== -1 && end > start) candidates.push(cleaned.slice(start, end + 1));

  let lastError: unknown;
  for (const candidate of [...new Set(candidates)]) {
    for (const attempt of [candidate, candidate.replace(/,(\s*[}\]])/g, "$1")]) {
      try {
        return JSON.parse(attempt);
      } catch (err) {
        lastError = err;
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error("no JSON object found");
}

/** Scan for the first brace-balanced top-level `{…}` block (string-aware). */
function firstJsonObject(text: string): string | null {
  const start = text.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
    } else if (ch === '"') {
      inString = true;
    } else if (ch === "{") {
      depth += 1;
    } else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}
