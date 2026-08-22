import fs from "node:fs";
import path from "node:path";
import type {
  FullResult,
  Reporter,
  TestCase,
  TestResult,
} from "@playwright/test/reporter";
import type { Evidence, EvidenceBundle } from "../evidence/model.js";
import { nextEvidenceId } from "../evidence/model.js";
import { sanitizeTestId, writeBundle } from "../evidence/store.js";
import {
  resolveOracleConfig,
  resolveOutputDir,
  type VisualReviewerOptions,
} from "../config.js";

interface FlatStep {
  title: string;
  error?: { message?: string };
}

function flattenSteps(steps: Array<{ title: string; error?: { message?: string }; steps?: unknown[] }>): FlatStep[] {
  const out: FlatStep[] = [];
  for (const step of steps) {
    out.push({ title: step.title, error: step.error });
    if (Array.isArray(step.steps)) {
      out.push(...flattenSteps(step.steps as never));
    }
  }
  return out;
}

export class VisualReviewerReporter implements Reporter {
  private options: VisualReviewerOptions;
  private outputDir: string;
  private runId: string;
  private bundlePaths: string[] = [];
  private include: string[];

  constructor(options: VisualReviewerOptions = {}) {
    this.options = options;
    this.outputDir = resolveOutputDir(options.outputDir);
    this.runId = new Date().toISOString().replace(/[:.]/g, "-");
    this.include = options.include ?? [];
  }

  onBegin(): void {
    fs.mkdirSync(this.outputDir, { recursive: true });
  }

  private included(test: TestCase): boolean {
    if (this.include.length === 0) return true;
    return this.include.some((pattern) => test.location.file.includes(pattern));
  }

  onTestEnd(test: TestCase, result: TestResult): void {
    if (result.status === "skipped" || !this.included(test)) return;

    const evidence: Evidence[] = [];
    const artifacts: Record<string, string> = {};
    const bundleDir = path.join(this.outputDir, sanitizeTestId(test.id + "-" + test.title));

    // 1. Attachments (screenshots from our fixture, traces, videos…)
    for (const attachment of result.attachments) {
      const body = attachment.path
        ? fs.readFileSync(attachment.path)
        : attachment.body ?? Buffer.alloc(0);
      const isImage = attachment.contentType.startsWith("image/");
      if (isImage) {
        const fileName = `assets/${nextEvidenceId("shot")}.png`;
        fs.mkdirSync(path.join(bundleDir, "assets"), { recursive: true });
        fs.writeFileSync(path.join(bundleDir, fileName), body);
        evidence.push({
          id: nextEvidenceId("ev"),
          timestamp: Date.now(),
          type: "screenshot",
          source: "playwright:attachment",
          content: { file: fileName },
          metadata: { name: attachment.name },
        });
      } else if (attachment.name === "trace") {
        const fileName = `assets/trace.zip`;
        fs.mkdirSync(path.join(bundleDir, "assets"), { recursive: true });
        fs.writeFileSync(path.join(bundleDir, fileName), body);
        artifacts.trace = fileName;
      } else if (attachment.name.startsWith("vr-network-console")) {
        try {
          const events = JSON.parse(body.toString("utf8")) as Array<{
            timestamp: number;
            kind: string;
            data: unknown;
          }>;
          for (const event of events) {
            const type =
              event.kind === "console"
                ? "console_event"
                : event.kind === "request" || event.kind === "response"
                  ? "network_event"
                  : event.kind === "pageerror"
                    ? "crash"
                    : "log_event";
            evidence.push({
              id: nextEvidenceId("ev"),
              timestamp: event.timestamp,
              type,
              source: "fixture:page",
              content: event.data,
            });
          }
        } catch {
          /* malformed attachment — keep going */
        }
      } else if (attachment.name.startsWith("vr-aria")) {
        evidence.push({
          id: nextEvidenceId("ev"),
          timestamp: Date.now(),
          type: "accessibility_tree",
          source: "fixture:page",
          content: body.toString("utf8"),
          metadata: { name: attachment.name },
        });
      }
    }

    // 2. Test source — the specification the oracle judges against.
    let sourceCode = "";
    try {
      sourceCode = fs.readFileSync(test.location.file, "utf8");
    } catch {
      /* unreadable source — oracle degrades gracefully */
    }

    // 3. Deterministic assertion outcomes (expect* steps reported by Playwright).
    const steps = flattenSteps(result.steps as never);
    const assertions = steps
      .filter((s) => /^expect/i.test(s.title))
      .map((s) => ({
        title: s.title,
        passed: !s.error,
        error: s.error?.message,
      }));

    const bundle: EvidenceBundle = {
      schemaVersion: 1,
      runId: this.runId,
      testId: test.id,
      project: test.titlePath()[0],
      title: test.titlePath().slice(1).join(" › "),
      file: test.location.file,
      sourceCode,
      status:
        result.status === "passed"
          ? "passed"
          : result.status === "timedOut"
            ? "timedOut"
            : result.status === "interrupted"
              ? "interrupted"
              : "failed",
      durationMs: result.duration,
      assertions,
      error: result.errors[0]
        ? {
            message: result.errors[0].message ?? String(result.errors[0]),
            stack: result.errors[0].stack,
          }
        : undefined,
      evidence,
      artifacts,
    };

    this.bundlePaths.push(writeBundle(this.outputDir, bundle));
  }

  async onEnd(_result: FullResult): Promise<void> {
    if (this.options.judge === false) return;
    if (this.bundlePaths.length === 0) return;

    // Lazy-import so the reporter works without an API key when judge: false.
    const { judgeBundles } = await import("../oracle/judge.js");
    const config = resolveOracleConfig(this.options);
    try {
      await judgeBundles(this.bundlePaths, config);
    } catch (err) {
      // Advisory-only: a judge failure must never break the test run.
      console.warn(
        `[visual-reviewer] oracle failed (advisory-only, run not affected): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
}

export default VisualReviewerReporter;
