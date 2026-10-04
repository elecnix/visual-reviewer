import { defineConfig } from "@playwright/test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
// Reference the monorepo build directly — the example runs without
// installing visual-reviewer from npm.
const dist = path.resolve(here, "../../dist");

export default defineConfig({
  testDir: path.join(here, "tests"),
  timeout: 30_000,
  use: {
    trace: "off",
  },
  reporter: [
    ["line"],
    [
      path.join(dist, "playwright/reporter.js"),
      {
        outputDir: path.join(here, ".visual-reviewer"),
        model: process.env.VISUAL_REVIEWER_MODEL ?? "deepseek/deepseek-v4.1-flash",
        // Judge only when the configured provider's key is available —
        // capture-only otherwise. The key variable follows
        // VISUAL_REVIEWER_API_KEY_ENV, like the reporter's own configuration.
        judge: Boolean(process.env[process.env.VISUAL_REVIEWER_API_KEY_ENV || "OPENROUTER_API_KEY"]),
      },
    ],
  ],
});
