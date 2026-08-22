import type { CDPSession, Page, TestInfo } from "@playwright/test";
import type { Evidence } from "../evidence/model.js";

/**
 * In-test evidence capture. A Playwright *reporter* only sees attachments and
 * errors; the rich runtime signals (network bodies, console output, a11y tree,
 * DOM state) must be captured from inside the test and attached. This helper
 * does that with zero assertions and zero interference.
 *
 * Usage in a spec or fixture:
 *
 *   import { attachEvidenceCollector } from "visual-reviewer";
 *
 *   test.beforeEach(async ({ page }, testInfo) => {
 *     await attachEvidenceCollector(page, testInfo);
 *   });
 *
 * Everything is buffered in memory and attached as files at test end.
 */

export interface EvidenceCollector {
  /** Capture a screenshot + aria snapshot + URL right now. */
  snapshot(label: string): Promise<void>;
  /** Attach everything collected so far (called automatically at test end). */
  flush(): Promise<void>;
}

interface BufferedEvent {
  timestamp: number;
  kind: "console" | "request" | "response" | "pageerror";
  data: unknown;
}

export async function attachEvidenceCollector(
  page: Page,
  testInfo: TestInfo,
): Promise<EvidenceCollector> {
  const events: BufferedEvent[] = [];
  const t0 = Date.now();

  const onConsole = (msg: { type: () => string; text: () => string; location: () => unknown }) => {
    events.push({
      timestamp: Date.now() - t0,
      kind: "console",
      data: { type: msg.type(), text: msg.text(), location: msg.location() },
    });
  };
  const onRequest = (req: { method: () => string; url: () => string; headers: () => Record<string, string> }) => {
    events.push({
      timestamp: Date.now() - t0,
      kind: "request",
      data: { method: req.method(), url: req.url() },
    });
  };
  const onResponse = async (res: {
    status: () => number;
    url: () => string;
    request: () => { method: () => string };
    text: () => Promise<string>;
  }) => {
    const entry: Record<string, unknown> = {
      status: res.status(),
      url: res.url(),
      method: res.request().method(),
    };
    // Capture response bodies for API-ish calls only — cheap and high-signal.
    const contentType = res.url().match(/\.(png|jpg|jpeg|gif|webp|svg|woff2?|ttf|css|js)(\?|$)/i);
    if (!contentType && /^(2|4)/.test(String(res.status()))) {
      try {
        const text = await res.text();
        if (text.length <= 20_000) entry.body = text;
      } catch {
        /* body unavailable — fine */
      }
    }
    events.push({ timestamp: Date.now() - t0, kind: "response", data: entry });
  };
  const onPageError = (err: Error) => {
    events.push({
      timestamp: Date.now() - t0,
      kind: "pageerror",
      data: { message: err.message, stack: err.stack },
    });
  };

  page.on("console", onConsole as never);
  page.on("request", onRequest as never);
  page.on("response", onResponse as never);
  page.on("pageerror", onPageError as never);

  const snapshots: Array<{ label: string; url: string; aria: string; screenshot: Buffer }> = [];

  const collector: EvidenceCollector = {
    async snapshot(label: string) {
      let aria = "";
      try {
        aria = await page.locator("body").ariaSnapshot();
      } catch {
        aria = "<aria snapshot unavailable>";
      }
      const screenshot = await page.screenshot({ fullPage: false });
      snapshots.push({ label, url: page.url(), aria, screenshot });
    },
    async flush() {
      page.off("console", onConsole as never);
      page.off("request", onRequest as never);
      page.off("response", onResponse as never);
      page.off("pageerror", onPageError as never);

      // Final state snapshot so every judged test has at least one image.
      if (snapshots.length === 0 || !testInfo.errors?.length) {
        try {
          await collector.snapshot("end-of-test");
        } catch {
          /* page may already be closed */
        }
      }

      if (events.length > 0) {
        await testInfo.attach("vr-network-console.json", {
          contentType: "application/json",
          body: Buffer.from(JSON.stringify(events, null, 2)),
        });
      }
      for (const snap of snapshots) {
        await testInfo.attach(`vr-screenshot-${snap.label}.png`, {
          contentType: "image/png",
          body: snap.screenshot,
        });
        await testInfo.attach(`vr-aria-${snap.label}.yml`, {
          contentType: "text/yaml",
          body: Buffer.from(`url: ${snap.url}\n\n${snap.aria}`),
        });
      }
    },
  };

  testInfo._vrCollector = collector;
  return collector;
}

/** Internal: reporter picks the collector up from TestInfo at onTestEnd. */
declare module "@playwright/test" {
  interface TestInfo {
    _vrCollector?: EvidenceCollector;
  }
}

export type { CDPSession };
