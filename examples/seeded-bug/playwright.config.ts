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
        model: process.env.VISUAL_REVIEWER_MODEL ?? "qwen/qwen3-vl-30b-a3b-instruct",
        // Judge only when a key is available — capture-only otherwise.
        judge: Boolean(process.env.OPENROUTER_API_KEY),
      },
    ],
  ],
});
