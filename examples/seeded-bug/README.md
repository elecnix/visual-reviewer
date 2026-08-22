# Seeded-bug demo

The Visual Reviewer acceptance test, runnable in one command:

```bash
OPENROUTER_API_KEY=sk-or-... npx playwright test --config examples/seeded-bug/playwright.config.ts
```

(Requires `npm install && npx tsc` at the repo root first, and `npx playwright install chromium` once.)

## What it demonstrates

A checkout test where the app has a real bug: the payment fails at the
application level (`POST /api/subscription` → HTTP 200 `{success:false,
error:"card_declined"}`), the UI shows an error banner — but also displays
"Pro plan" and "$29/month", so both deterministic assertions stay green.

Expected output:

```
  1 passed (…s)
[visual-reviewer] judging … REGRESSION (9x%)
```

The full evidence report lands at
`examples/seeded-bug/.visual-reviewer/**/report.md`.

Without `OPENROUTER_API_KEY` the run still captures evidence bundles
(`judge: false`), which you can judge later with
`npx visual-reviewer judge examples/seeded-bug/.visual-reviewer`.

The app itself is served via Playwright route interception — no external
server, no network access needed beyond the LLM call.
