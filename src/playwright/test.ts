import { test as base } from "@playwright/test";
import { attachEvidenceCollector, type EvidenceCollector } from "./fixtures.js";

/**
 * Drop-in replacement for @playwright/test's `test` that captures
 * network/console/a11y/screenshot evidence automatically:
 *
 *   import { test, expect } from "visual-reviewer/playwright";
 */
export const evidenceTest = base.extend<{
  vrCollector: EvidenceCollector;
}>({
  vrCollector: [
    async ({ page }, use, testInfo) => {
      const collector = await attachEvidenceCollector(page, testInfo);
      await use(collector);
      await collector.flush();
    },
    { auto: true },
  ],
});
