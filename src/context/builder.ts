import fs from "node:fs";
import path from "node:path";
import type { ImagePart, TextPart } from "ai";
import type { Evidence, EvidenceBundle } from "../evidence/model.js";

/**
 * Context builder — the cost/relevance knob.
 *
 * Philosophy (brief §8): give the model a curated dossier, not the firehose.
 * Deterministic signals are pre-digested into text; images are capped at
 * config.maxScreenshots, prioritizing end-of-run and error-adjacent shots.
 */

const MAX_SOURCE_CHARS = 12_000;
const MAX_NETWORK_EVENTS = 60;
const MAX_CONSOLE_EVENTS = 40;

/** Previous-run summary used for semantic baseline comparison. */
export interface BaselineInfo {
  date: string;
  verdict: string;
  confidence: number;
  deterministicStatus: string;
  assertionsPassed: number;
  assertionsTotal: number;
  /** Bundle-relative path of the previous run's final screenshot. */
  screenshotFile?: string;
  /** Set when verdict history shows flip-flopping (flaky behavior). */
  flakinessNote?: string;
}

export function buildSystemPrompt(expectations?: string, feedback?: string): string {
  const expectationsBlock =
    expectations && expectations.trim().length > 0
      ? `\nPROJECT-SPECIFIC EXPECTATIONS (provided by the team — treat as authoritative context for intent):
${expectations.trim().slice(0, 4000)}\n`
      : "";
  const feedbackBlock =
    feedback && feedback.trim().length > 0
      ? `\nHUMAN FEEDBACK on your previous verdicts for this test (treat as authoritative corrections):
${feedback.trim().slice(0, 2000)}\n`
      : "";
  return `You are a semantic test oracle. You judge whether a UI test's intended
outcome actually occurred — not merely whether its deterministic assertions passed.

Rules:
- Ground every claim in the provided evidence. Reference evidence by its id.
- Never invent UI state you cannot see in the evidence. If evidence is missing,
  say so and prefer verdict UNCERTAIN over speculation.
- Distinguish observation from interpretation.
- A green assertion result does NOT imply correctness. Look for:
  application-level failures hidden behind HTTP 200, visible error messages,
  contradictions between screenshots / accessibility tree / network bodies /
  console output, and state that contradicts the test's intent.
- Respond ONLY with a JSON object matching this shape:
  {"verdict":"PASS|REGRESSION|FAIL|UNCERTAIN","confidence":0..1,"intentSummary":string,
   "reasoning":string,"supportingEvidence":[{"evidenceIds":[string],"observation":string}],
   "suspiciousObservations":[{"evidenceIds":[string],"observation":string}],
   "suggestedNextStep":string}
- REGRESSION/FAIL means the intended behavior did not occur despite what the
  deterministic results claim. PASS means evidence supports the intent and no
  material contradictory evidence exists.${expectationsBlock}${feedbackBlock}`;
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n… [truncated ${text.length - max} chars]`;
}

function formatEvent(content: unknown): string {
  const c = content as Record<string, unknown>;
  if (typeof c.url === "string") {
    return `${c.method ?? "GET"} ${c.url} -> ${c.status ?? "?"}${
      typeof c.body === "string" ? ` body=${truncate(c.body, 600)}` : ""
    }`;
  }
  if (typeof c.type === "string" && typeof c.text === "string") {
    return `[console.${c.type}] ${truncate(c.text, 400)}`;
  }
  if (typeof c.message === "string") {
    return `[pageerror] ${truncate(c.message, 400)}`;
  }
  return truncate(JSON.stringify(content), 400);
}

/** Pick the most relevant screenshots; returns evidence entries + decoded buffers. */
export function selectScreenshots(
  bundle: EvidenceBundle,
  max: number,
): Array<{ evidence: Evidence; buffer: Buffer }> {
  const shots = bundle.evidence.filter((e) => e.type === "screenshot");
  // Prioritize the last shots (end state) plus any flagged as error-adjacent.
  const ranked = [...shots].sort((a, b) => {
    const aName = String(a.metadata?.name ?? "");
    const bName = String(b.metadata?.name ?? "");
    const aErr = /error|fail/i.test(aName) ? 1 : 0;
    const bErr = /error|fail/i.test(bName) ? 1 : 0;
    if (aErr !== bErr) return bErr - aErr;
    return b.timestamp - a.timestamp;
  });
  const picked = ranked.slice(0, max);
  return picked.flatMap((evidence) => {
    const content = evidence.content as { file?: string };
    if (typeof content?.file !== "string") return [];
    const abs = path.join(path.dirname(bundle.file ?? ""), content.file);
    try {
      return [{ evidence, buffer: fs.readFileSync(abs) }];
    } catch {
      return [];
    }
  });
}

export function buildUserContent(
  bundle: EvidenceBundle,
  bundleDir: string,
  maxScreenshots: number,
  baseline?: BaselineInfo | null,
): Array<TextPart | ImagePart> {
  const parts: Array<TextPart | ImagePart> = [];

  const failedAssertions = bundle.assertions.filter((a) => !a.passed);
  const networkEvents = bundle.evidence.filter((e) => e.type === "network_event");
  const consoleEvents = bundle.evidence.filter((e) => e.type === "console_event");
  const crashes = bundle.evidence.filter((e) => e.type === "crash");
  const ariaTrees = bundle.evidence.filter((e) => e.type === "accessibility_tree");

  let text = `TEST: ${bundle.title}
FILE: ${bundle.file}
DETERMINISTIC RESULT: ${bundle.status}; ${bundle.assertions.length - failedAssertions.length}/${bundle.assertions.length} assertions passed.
DURATION: ${(bundle.durationMs / 1000).toFixed(1)}s

TEST SOURCE (the specification of intent):
\`\`\`
${truncate(bundle.sourceCode, MAX_SOURCE_CHARS)}
\`\`\`
`;

  if (failedAssertions.length > 0) {
    text += `\nFAILED ASSERTIONS:\n${failedAssertions.map((a) => `- ${a.title}: ${a.error ?? ""}`).join("\n")}\n`;
  }
  if (bundle.error) {
    text += `\nTEST ERROR:\n${bundle.error.message}\n`;
  }

  if (networkEvents.length > 0) {
    text += `\nNETWORK (${networkEvents.length} events, showing up to ${MAX_NETWORK_EVENTS}, non-2xx first):\n`;
    const sorted = [...networkEvents].sort((a, b) => {
      const sa = String((a.content as Record<string, unknown>)?.status ?? "200").startsWith("2") ? 1 : 0;
      const sb = String((b.content as Record<string, unknown>)?.status ?? "200").startsWith("2") ? 1 : 0;
      return sa - sb || a.timestamp - b.timestamp;
    });
    for (const e of sorted.slice(0, MAX_NETWORK_EVENTS)) {
      text += `  [${e.id}] t+${e.timestamp}ms ${formatEvent(e.content)}\n`;
    }
  }

  if (consoleEvents.length > 0) {
    text += `\nCONSOLE (up to ${MAX_CONSOLE_EVENTS}, errors/warnings first):\n`;
    const sorted = [...consoleEvents].sort((a, b) => {
      const wa = !/error|warning/i.test(String((a.content as Record<string, unknown>)?.type ?? ""));
      const wb = !/error|warning/i.test(String((b.content as Record<string, unknown>)?.type ?? ""));
      return Number(wa) - Number(wb) || a.timestamp - b.timestamp;
    });
    for (const e of sorted.slice(0, MAX_CONSOLE_EVENTS)) {
      text += `  [${e.id}] t+${e.timestamp}ms ${formatEvent(e.content)}\n`;
    }
  }

  if (crashes.length > 0) {
    text += `\nPAGE ERRORS:\n`;
    for (const e of crashes) text += `  [${e.id}] ${formatEvent(e.content)}\n`;
  }

  for (const aria of ariaTrees.slice(0, 4)) {
    text += `\nACCESSIBILITY TREE [${aria.id}]${aria.metadata?.name ? ` (${String(aria.metadata.name)})` : ""}:\n${truncate(String(aria.content), 4000)}\n`;
  }

  // Native-app output (Appium hierarchy, XCTest UI tree, device state dumps).
  const nativeTrees = bundle.evidence.filter((e) => e.type === "native_ui_tree");
  for (const tree of nativeTrees.slice(0, 4)) {
    text += `\nNATIVE UI TREE [${tree.id}]${tree.metadata?.name ? ` (${String(tree.metadata.name)})` : ""}:\n${truncate(String(tree.content), 4000)}\n`;
  }
  const nativeStates = bundle.evidence.filter((e) => e.type === "native_state");
  for (const state of nativeStates.slice(0, 4)) {
    text += `\nNATIVE DEVICE STATE [${state.id}]${state.metadata?.name ? ` (${String(state.metadata.name)})` : ""}:\n${truncate(String(state.content), 2000)}\n`;
  }
  const nativeActions = bundle.evidence.filter((e) => e.type === "user_action");
  if (nativeActions.length > 0) {
    text += `\nUSER ACTIONS ON DEVICE:\n`;
    for (const action of nativeActions.slice(0, 20)) {
      text += `  [${action.id}] t+${action.timestamp}ms ${truncate(JSON.stringify(action.content), 300)}\n`;
    }
  }

  if (baseline) {
    text += `\nBASELINE (previous run of this test, ${baseline.date}):
- previous AI verdict: ${baseline.verdict} (${Math.round(baseline.confidence * 100)}% confidence)
- previous deterministic result: ${baseline.deterministicStatus}, ${baseline.assertionsPassed}/${baseline.assertionsTotal} assertions passed
${baseline.screenshotFile ? "- a PREVIOUS RUN SCREENSHOT is attached below the current screenshots; compare UI state against it semantically (ignore pixel noise)." : ""}
${baseline.flakinessNote ? `- FLAKINESS WARNING: ${baseline.flakinessNote}` : ""}
Use the baseline as context: changes consistent with modified test intent are expected; changes in areas unrelated to the change may indicate regressions.\n`;
  }

  text += `\nEVIDENCE AVAILABLE: ${bundle.evidence.length} observations (${bundle.evidence.filter((e) => e.type === "screenshot").length} screenshots, ${networkEvents.length} network events, ${consoleEvents.length} console events). Screenshots attached below are ordered oldest→newest.\n`;

  text += `\nJudge whether the intended user outcome occurred. Return only the JSON verdict object.`;

  parts.push({ type: "text", text });

  const shots = selectScreenshots({ ...bundle, file: path.join(bundleDir, "bundle.json") }, maxScreenshots);
  for (const shot of shots) {
    parts.push({
      type: "text",
      text: `SCREENSHOT [${shot.evidence.id}]${shot.evidence.metadata?.name ? ` name=${String(shot.evidence.metadata.name)}` : ""}`,
    });
    parts.push({ type: "image", image: new Uint8Array(shot.buffer) });
  }

  if (baseline?.screenshotFile) {
    try {
      const prev = fs.readFileSync(path.join(bundleDir, baseline.screenshotFile));
      parts.push({ type: "text", text: "PREVIOUS RUN SCREENSHOT (baseline)" });
      parts.push({ type: "image", image: new Uint8Array(prev) });
    } catch {
      /* baseline screenshot missing — skip silently */
    }
  }

  return parts;
}
