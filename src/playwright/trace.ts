import fs from "node:fs";
import path from "node:path";
import { unzipSync } from "fflate";
import { nextEvidenceId, type Evidence } from "../evidence/model.js";

/**
 * Playwright trace.zip parser — turns the trace artifact every Playwright run
 * can produce into typed Evidence. This is what makes the oracle work on any
 * test suite, even without the visual-reviewer fixture.
 *
 * Format (empirically stable across recent Playwright versions):
 *   <n>-trace.network  NDJSON { type:"resource-snapshot", snapshot: HAR-like }
 *   <n>-trace.trace    NDJSON { before|after|frame-snapshot|screencast-frame… }
 *   resources/<sha1>   response bodies, screencast jpegs, etc.
 */

const TEXT_MIME = /json|text|xml|javascript|x-www-form-urlencoded|urlencoded/i;
const MAX_BODY_BYTES = 20_000;
const MAX_DOM_BYTES = 30_000;
const MAX_SCREENSHOTS = 3;

export interface TraceParseOptions {
  /** Where to write screenshot files (relative names go into Evidence.content). */
  assetsDir?: string;
  /** Wall-clock ms of test start; evidence timestamps become t+ms offsets. */
  baseWallTime?: number;
}

interface JsonlEntry {
  type: string;
  [key: string]: unknown;
}

function readJsonl(data: Uint8Array): JsonlEntry[] {
  const text = Buffer.from(data).toString("utf8");
  const out: JsonlEntry[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as JsonlEntry);
    } catch {
      /* tolerate partial lines */
    }
  }
  return out;
}

/** Serialize Playwright's nested html tree: ["TAG", attrs, child, …]. */
function serializeHtmlTree(node: unknown): string {
  if (typeof node === "string") return node;
  if (!Array.isArray(node) || node.length === 0) return "";
  const [tag, attrs, ...children] = node as [string, Record<string, string>, ...unknown[]];
  const attrStr =
    attrs && typeof attrs === "object"
      ? Object.entries(attrs)
          .map(([k, v]) => ` ${k}="${String(v).replace(/"/g, "&quot;")}"`)
          .join("")
      : "";
  const inner = children.map(serializeHtmlTree).join("");
  return `<${String(tag).toLowerCase()}${attrStr}>${inner}</${String(tag).toLowerCase()}>`;
}

export function parseTraceZip(zipPath: string, options: TraceParseOptions = {}): Evidence[] {
  const entries = unzipSync(new Uint8Array(fs.readFileSync(zipPath)));
  const byName = new Map<string, Uint8Array>();
  for (const [name, data] of Object.entries(entries)) byName.set(name, data);

  const resource = (sha1: string): Uint8Array | undefined => {
    for (const [name, data] of byName) {
      if (name === `resources/${sha1}` || name.endsWith(`/${sha1}`)) return data;
    }
    return undefined;
  };

  const networkKey = [...byName.keys()].find((k) => /-trace\.network$/.test(k));
  const traceKeys = [...byName.keys()].filter((k) => /-trace\.trace$/.test(k));

  const base = options.baseWallTime ?? 0;
  const evidence: Evidence[] = [];
  const rel = (wallMs: number | undefined): number =>
    typeof wallMs === "number" ? Math.max(0, Math.round(wallMs - base)) : 0;

  // ── Network: resource-snapshots with response bodies ──────────────────
  if (networkKey) {
    for (const entry of readJsonl(byName.get(networkKey)!)) {
      if (entry.type !== "resource-snapshot") continue;
      const snap = entry.snapshot as {
        startedDateTime?: string;
        request?: { method?: string; url?: string; postData?: { text?: string } };
        response?: {
          status?: number;
          statusText?: string;
          content?: { _sha1?: string; mimeType?: string };
        };
      };
      if (!snap?.request?.url) continue;

      let body: string | undefined;
      const sha1 = snap.response?.content?._sha1;
      const mime = snap.response?.content?.mimeType ?? "";
      if (sha1 && TEXT_MIME.test(mime)) {
        const raw = resource(sha1);
        if (raw && raw.byteLength <= MAX_BODY_BYTES) {
          body = Buffer.from(raw).toString("utf8");
        }
      }
      evidence.push({
        id: nextEvidenceId("ev"),
        timestamp: rel(snap.startedDateTime ? Date.parse(snap.startedDateTime) : undefined),
        type: "network_event",
        source: "playwright:trace",
        content: {
          method: snap.request.method ?? "GET",
          url: snap.request.url,
          status: snap.response?.status ?? 0,
          ...(snap.request.postData?.text ? { requestBody: snap.request.postData.text } : {}),
          ...(body !== undefined ? { body } : {}),
        },
      });
    }
  }

  // ── Actions: before/after pairs → user_action timeline ────────────────
  const openCalls = new Map<string, JsonlEntry>();
  for (const traceKey of traceKeys) {
    for (const entry of readJsonl(byName.get(traceKey)!)) {
      if (entry.type === "before") {
        openCalls.set(String(entry.callId), entry);
      } else if (entry.type === "after" && openCalls.has(String(entry.callId))) {
        const before = openCalls.get(String(entry.callId))!;
        openCalls.delete(String(entry.callId));
        const params = (before.params ?? {}) as Record<string, unknown>;
        const selector = typeof params.selector === "string" ? params.selector : undefined;
        const label = [before.method, selector].filter(Boolean).join(" ");
        if (!label) continue;
        const error = (entry as { error?: { message?: string } }).error?.message;
        evidence.push({
          id: nextEvidenceId("ev"),
          // before.startTime is already milliseconds relative to context start.
          timestamp: Math.max(0, Math.round((before.startTime as number) ?? 0)),
          type: "user_action",
          source: "playwright:trace",
          content: {
            label,
            durationMs: Math.round(
              ((entry.endTime as number | undefined) ?? (before.startTime as number)) -
                ((before.startTime as number) ?? 0),
            ),
            ...(error ? { error } : {}),
          },
        });
      }
    }
  }

  // ── DOM snapshots: last main-frame snapshot as HTML ───────────────────
  let lastDom: { html: string; wallTime: number } | undefined;
  let maxDomWallTime = 0;
  for (const traceKey of traceKeys) {
    for (const entry of readJsonl(byName.get(traceKey)!)) {
      if (entry.type !== "frame-snapshot") continue;
      const snap = entry.snapshot as {
        html?: unknown;
        wallTime?: number;
        isMainFrame?: boolean;
        frameUrl?: string;
      };
      if (!snap?.html || snap.isMainFrame === false) continue;
      const wallTime = snap.wallTime ?? 0;
      maxDomWallTime = Math.max(maxDomWallTime, wallTime);
      // Later snapshots are differential (html[0] is a [refIdx, nodeIdx] pair
      // or a nested ref array). Only full trees start with a tag-name string.
      if (!Array.isArray(snap.html) || typeof snap.html[0] !== "string") continue;
      const html = serializeHtmlTree(snap.html);
      if (html.length <= MAX_DOM_BYTES) {
        lastDom = { html, wallTime };
      }
    }
  }
  if (lastDom) {
    evidence.push({
      id: nextEvidenceId("ev"),
      timestamp: rel(lastDom.wallTime),
      type: "dom_snapshot",
      source: "playwright:trace",
      content: lastDom.html,
      // If later differential snapshots exist, the page kept mutating after
      // our last resolvable full snapshot — say so instead of implying it is
      // the final state.
      ...(lastDom.wallTime < maxDomWallTime - 50
        ? { metadata: { note: "DOM snapshot predates the final observed page state" } }
        : {}),
    });
  }

  // ── Screenshots: final screencast frames ──────────────────────────────
  const frames: Array<{ sha1: string; wallTime: number }> = [];
  for (const traceKey of traceKeys) {
    for (const entry of readJsonl(byName.get(traceKey)!)) {
      if (entry.type !== "screencast-frame") continue;
      const sha1 = entry.sha1 as string | undefined;
      if (sha1) frames.push({ sha1, wallTime: (entry.frameSwapWallTime as number) ?? 0 });
    }
  }
  frames.sort((a, b) => a.wallTime - b.wallTime);
  for (const frame of frames.slice(-MAX_SCREENSHOTS)) {
    const raw = resource(frame.sha1);
    if (!raw || !options.assetsDir) continue;
    fs.mkdirSync(options.assetsDir, { recursive: true });
    const fileName = `assets/${nextEvidenceId("shot")}.jpeg`;
    fs.writeFileSync(path.join(path.dirname(options.assetsDir), fileName), raw);
    evidence.push({
      id: nextEvidenceId("ev"),
      timestamp: rel(frame.wallTime),
      type: "screenshot",
      source: "playwright:trace",
      content: { file: fileName },
      metadata: { name: "screencast" },
    });
  }

  return evidence;
}
