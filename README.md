# Visual Reviewer

**AI semantic test oracle for Playwright.** Your test goes green; Visual Reviewer independently answers: *did the software actually do what this test was intended to verify?* — and shows its evidence when the answer is no.

Advisory-only by design: it never fails your CI on its own.

```text
✓ checkout.spec.ts > user upgrades subscription   7/7 assertions passed
  🚨 visual-reviewer: REGRESSION (87%)
     POST /api/subscription returned {"success":false}
     UI contains "Payment could not be completed"
```

## Install

```bash
npm install -D visual-reviewer
```

Requires Node ≥ 20 and an API key for any OpenAI-compatible provider. The default judge is **`qwen/qwen3-vl-30b-a3b-instruct` via OpenRouter** (~$0.13/$0.52 per M tokens — a full suite run typically costs a few cents).

```bash
export OPENROUTER_API_KEY=sk-or-...
```

## Configure

### 1. Enable the reporter in `playwright.config.ts`

```ts
import { defineConfig } from "@playwright/test";

export default defineConfig({
  reporter: [
    ["list"],
    ["visual-reviewer/reporter", {
      // all optional:
      outputDir: ".visual-reviewer",
      model: "qwen/qwen3-vl-30b-a3b-instruct",   // any OpenRouter model id
      baseURL: "https://openrouter.ai/api/v1",    // or Ollama, OpenAI, vLLM…
      maxScreenshots: 6,                          // cost knob
      judge: true,                                // run oracle after the run
    }],
  ],
});
```

### 2. Capture evidence in your tests

A Playwright *reporter* can't see network bodies, console output or accessibility trees — so either use the drop-in `test`:

```ts
import { test, expect } from "visual-reviewer/playwright";

test("user upgrades subscription", async ({ page }) => {
  // …your normal test…
});
```

…or keep your own imports and attach the collector manually:

```ts
import { test as base } from "@playwright/test";
import { attachEvidenceCollector } from "visual-reviewer";

const test = base.extend({
  vrCollector: [async ({ page }, use, testInfo) => {
    const collector = await attachEvidenceCollector(page, testInfo);
    await use(collector);
    await collector.flush();
  }, { auto: true }],
});
```

### 3. Run your tests normally

```bash
npx playwright test
```

After the deterministic run, each captured test is judged. Verdicts print in the terminal and full evidence reports land at `.visual-reviewer/**/report.md`.

## Providers

The oracle talks to any OpenAI-compatible endpoint through the [Vercel AI SDK](https://sdk.vercel.ai). Swap two strings:

| Provider | baseURL | model | key env |
|---|---|---|---|
| OpenRouter (default) | `https://openrouter.ai/api/v1` | `qwen/qwen3-vl-30b-a3b-instruct` | `OPENROUTER_API_KEY` |
| OpenRouter (stronger) | same | `qwen/qwen3-vl-235b-a22b-instruct` | `OPENROUTER_API_KEY` |
| OpenAI | `https://api.openai.com/v1` | `gpt-4o` | `OPENAI_API_KEY` (`--api-key-env OPENAI_API_KEY`) |
| Ollama (local) | `http://localhost:11434/v1` | `qwen3-vl:30b` | none needed |

Env-var equivalents: `VISUAL_REVIEWER_MODEL`, `VISUAL_REVIEWER_BASE_URL`, `VISUAL_REVIEWER_OUTPUT_DIR`.

## CLI: judge after the fact

Bundles are persisted even if you set `judge: false`, so you can judge later / selectively / with a different model:

```bash
npx playwright test --reporter=list   # capture only
npx visual-reviewer judge --model qwen/qwen3-vl-235b-a22b-instruct
```

## CI (advisory)

```yaml
- run: npx playwright test
- uses: actions/upload-artifact@v4
  if: always()
  with: { name: visual-reviewer, path: .visual-reviewer/ }
```

Exit codes are untouched by verdicts. Judge infrastructure errors exit `2`.

## Verdict model

- **PASS** — evidence supports the intent, nothing contradictory.
- **REGRESSION / FAIL** — evidence shows the intended outcome did not occur.
- **UNCERTAIN** — insufficient or contradictory evidence. First-class result, never hidden.

Every report cites evidence ids, distinguishes observation from interpretation, and suggests a next investigation step.

## Architecture (short version)

```
Playwright (reporter + evidence fixture)
      ↓
EvidenceBundle  ← framework-agnostic typed observations (images are not special)
      ↓
Context builder ← curated dossier, not a firehose (screenshots capped, non-2xx first)
      ↓
Oracle (Vercel AI SDK → any OpenAI-compatible model)
      ↓
Verdict JSON (zod-validated) → Evidence report (Markdown)
```

No Playwright concepts exist outside `src/playwright/`. A second adapter (Appium, Selenium…) would only translate its artifacts into an `EvidenceBundle`.

See [VISUAL_REVIEWER_PRODUCT_BRIEF.md](./VISUAL_REVIEWER_PRODUCT_BRIEF.md) for the full product brief.

## Status

v0.1 vertical slice. Known gaps vs the brief: trace.zip parsing (network/console currently come from the fixture), agentic follow-up evidence requests, baseline comparison, HTML report.
