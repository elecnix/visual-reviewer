import { z } from "zod";

/**
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
