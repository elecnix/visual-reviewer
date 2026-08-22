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
