/**
 * Oracle smoke test: builds one synthetic EvidenceBundle (a green test with a
 * suspicious application-level failure) and runs it through the real judge.
 * Verifies: provider connectivity, multimodal request shape, JSON verdict
 * parsing. Skips (exit 0) when OPENROUTER_API_KEY is absent.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { judgeBundle } from "../dist/oracle/judge.js";
import { DEFAULT_ORACLE_CONFIG } from "../dist/config.js";

if (!process.env.OPENROUTER_API_KEY) {
  console.log("oracle-smoke: OPENROUTER_API_KEY not set — skipping (advisory job)");
  process.exit(0);
}

const bundle = {
  schemaVersion: 1,
  runId: "smoke",
  testId: "smoke-test-1",
  title: "smoke: user upgrades subscription",
  file: "smoke.spec.ts",
  sourceCode: `test("user upgrades subscription", async ({ page }) => {
  await page.click("text=Upgrade to Pro");
  await expect(page.getByText("Pro plan")).toBeVisible();
  await expect(page.getByText("$29/month")).toBeVisible();
});`,
  status: "passed",
  durationMs: 4200,
  assertions: [
    { title: "expect(toBeVisible) — Pro plan", passed: true },
    { title: "expect(toBeVisible) — $29/month", passed: true },
  ],
  evidence: [
    {
      id: "ev-net-0001",
      timestamp: 3100,
      type: "network_event",
      source: "fixture:page",
      content: {
        method: "POST",
        url: "https://api.example.com/api/subscription",
        status: 200,
        body: '{"success":false,"error":"Payment could not be completed: card_declined"}',
      },
    },
    {
      id: "ev-con-0002",
      timestamp: 3200,
      type: "console_event",
      source: "fixture:page",
      content: { type: "error", text: "Subscription upgrade failed: card_declined" },
    },
  ],
  artifacts: {},
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vr-smoke-"));
const bundlePath = path.join(tmp, "bundle.json");
fs.writeFileSync(bundlePath, JSON.stringify(bundle, null, 2));

const config = { ...DEFAULT_ORACLE_CONFIG, maxScreenshots: 0, timeoutMs: 90_000 };
const result = await judgeBundle(bundlePath, config);

if (result.error) {
  console.error("oracle-smoke: FAIL —", result.error);
  process.exit(1);
}
const { verdict } = result;
console.log(`oracle-smoke: verdict=${verdict.verdict} confidence=${verdict.confidence}`);
console.log(`  intent: ${verdict.intentSummary}`);
console.log(`  reasoning: ${verdict.reasoning.slice(0, 200)}`);

const allowed = ["PASS", "REGRESSION", "FAIL", "UNCERTAIN"];
if (!allowed.includes(verdict.verdict)) {
  console.error(`oracle-smoke: invalid verdict ${verdict.verdict}`);
  process.exit(1);
}
// A card_declined failure behind a 200 with green assertions should NOT be PASS.
if (verdict.verdict === "PASS" && verdict.confidence > 0.5) {
  console.error("oracle-smoke: suspicious — judge passed a test with a declined payment API response");
  process.exit(1);
}
console.log("oracle-smoke: OK");
