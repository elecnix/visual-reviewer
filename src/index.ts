/**
 * visual-reviewer — AI semantic test oracle for Playwright.
 *
 * Public surface:
 * - `attachEvidenceCollector` / `evidenceTest`: in-test evidence capture
 * - `VisualReviewerReporter` (also at "visual-reviewer/reporter")
 * - Types: EvidenceBundle, Evidence, Verdict
 */
export { attachEvidenceCollector, type EvidenceCollector } from "./playwright/fixtures.js";
export { evidenceTest, evidenceTest as test } from "./playwright/test.js";
export { expect } from "@playwright/test";
export { VisualReviewerReporter } from "./playwright/reporter.js";
export type { VisualReviewerOptions } from "./config.js";
export {
  type Evidence,
  type EvidenceBundle,
  type EvidenceType,
  type AssertionRecord,
} from "./evidence/model.js";
export { VerdictSchema, type Verdict } from "./oracle/schema.js";
