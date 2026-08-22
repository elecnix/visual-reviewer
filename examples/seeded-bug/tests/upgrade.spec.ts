import { test, expect } from "../../../dist/index.js";

/**
 * The seeded-bug demo.
 *
 * The app below simulates a checkout flow with a REAL bug: the payment
 * fails at the application level (HTTP 200 + {success:false}), the UI
 * renders an error banner… but still displays "Pro plan" and "$29/month",
 * so both deterministic assertions stay GREEN.
 *
 * Expected outcome:
 *   Playwright:  2/2 assertions passed
 *   Oracle:      REGRESSION — upgrade did not actually succeed
 */

const APP_HTML = `<!DOCTYPE html>
<html>
<head><title>Acme Plans</title><style>
  body { font-family: sans-serif; padding: 2rem; }
  .plan { border: 1px solid #ccc; padding: 1rem; margin: 1rem 0; }
  .error { background: #fee2e2; color: #991b1b; padding: .75rem; margin-top: 1rem; }
  button { padding: .5rem 1rem; }
</style></head>
<body>
  <h1>Acme Plans</h1>
  <div class="plan">
    <h2>Free</h2><p>$0/month</p>
    <button id="upgrade">Upgrade to Pro</button>
  </div>
  <div id="result"></div>
  <script>
    document.getElementById("upgrade").addEventListener("click", async () => {
      // BUG: application-level failure is swallowed — the UI proceeds as if
      // the upgrade succeeded, while an error banner also appears.
      const res = await fetch("/api/subscription", { method: "POST" });
      const data = await res.json(); // { success: false, error: "card_declined" }
      document.getElementById("result").innerHTML = \`
        <div class="plan"><h2>Pro plan</h2><p>\$29/month</p></div>
        <div class="error">Payment could not be completed</div>\`;
    });
  </script>
</body>
</html>`;

test("user upgrades subscription", async ({ page }) => {
  await page.route("**://demo.local/**", (route) => {
    const url = route.request().url();
    if (url.includes("/api/subscription")) {
      // Application-level failure hidden behind a successful HTTP response.
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ success: false, error: "card_declined" }),
      });
    } else {
      route.fulfill({ contentType: "text/html", body: APP_HTML });
    }
  });

  await page.goto("https://demo.local/");
  await page.click("#upgrade");

  // Deterministic assertions — these pass despite the bug.
  await expect(page.getByText("Pro plan")).toBeVisible();
  await expect(page.getByText("$29/month")).toBeVisible();
});
