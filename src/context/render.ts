import type { Evidence, EvidenceBundle, EvidenceType } from "../evidence/model.js";

/**
 * Evidence rendering policy — the closed set of observation types the dossier
 * knows about.
 *
 * The mapping from evidence to model-visible content used to live as if-chains
 * inside `buildUserContent`, spread across eight `e.type === "..."` filters.
 * That made the type set effectively open: `Evidence.content` is `unknown` and
 * the renderer list was never checked against `EvidenceType`, so a type with no
 * renderer (or a type string arriving from a bundle.json written by a newer
 * adapter) was dropped from the model's dossier with no build error, no test
 * failure and no word in the prompt.
 *
 * This module closes the set. Every `EvidenceType` gets exactly one declared
 * disposition, and because the table is typed `Record<EvidenceType, ...>`,
 * adding a member to the union without deciding what to do with it is a
 * **compile error**, not a silent drop. Types the dossier genuinely does not
 * show are marked `"not-rendered"` and are surfaced to the model as an explicit
 * "present but not shown" notice, so their absence reads as missing coverage
 * rather than as "nothing was observed".
 */

export type RenderKind =
  /** Attached to the prompt as an image part (see `selectScreenshots`). */
  | "image"
  /** Has a text renderer in `buildUserContent`. */
  | "text"
  /** Deliberately excluded from the model dossier; announced, never dropped silently. */
  | "not-rendered";

/**
 * The single source of truth for "does the model see this evidence?".
 *
 * `not-rendered` entries are evidence we knowingly withhold — cheap to keep
 * around (bundle size, future renderers) but not yet digested. They are listed
 * in the prompt so the model does not read their absence as an observation
 * about the application under test.
 */
export const EVIDENCE_RENDER_KIND: Record<EvidenceType, RenderKind> = {
  screenshot: "image",
  dom_snapshot: "text",
  accessibility_tree: "text",
  native_ui_tree: "text",
  network_event: "text",
  console_event: "text",
  crash: "text",
  native_state: "text",
  user_action: "text",
  log_event: "not-rendered",
  video_frame: "not-rendered",
  assertion: "not-rendered",
  test_source: "not-rendered",
  browser_state: "not-rendered",
};

/** Every declared evidence type, in `EvidenceType` declaration order. */
export const EVIDENCE_TYPES = [
  "screenshot",
  "video_frame",
  "dom_snapshot",
  "accessibility_tree",
  "native_ui_tree",
  "network_event",
  "console_event",
  "log_event",
  "crash",
  "assertion",
  "test_source",
  "browser_state",
  "native_state",
  "user_action",
] as const satisfies readonly EvidenceType[];

const KNOWN_TYPES = new Set<string>(EVIDENCE_TYPES);

/** Runtime guard: `bundle.json` is untyped input and may carry a future type string. */
export function isEvidenceType(value: unknown): value is EvidenceType {
  return typeof value === "string" && KNOWN_TYPES.has(value);
}

export function renderKindOf(type: string): RenderKind | "unknown" {
  if (!isEvidenceType(type)) return "unknown";
  return EVIDENCE_RENDER_KIND[type];
}

/**
 * Evidence the dossier will not show, newest last: types declared
 * `not-rendered`, plus any type string outside the closed set.
 */
export function unrenderedEvidence(bundle: EvidenceBundle): Evidence[] {
  return bundle.evidence.filter((e) => renderKindOf(String(e.type)) !== "image" && renderKindOf(String(e.type)) !== "text");
}

/** Count per type for the "EVIDENCE AVAILABLE" summary line. */
export function evidenceCounts(bundle: EvidenceBundle): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const e of bundle.evidence) {
    const key = String(e.type);
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

/**
 * The loud-policy text block. Empty string when everything is rendered, so the
 * happy path prompt is byte-identical to what it was before this module
 * existed.
 */
export function renderUnrenderedNotice(bundle: EvidenceBundle): string {
  const missing = unrenderedEvidence(bundle);
  if (missing.length === 0) return "";
  const unknown = missing.filter((e) => !isEvidenceType(e.type));
  const lines = missing.map(
    (e) => `  [${e.id}] ${String(e.type)} (present in bundle, not shown above)`,
  );
  const caveat = unknown.length > 0
    ? `\nSome of these types are unknown to this oracle version — treat them as evidence you have NOT seen, not as evidence that was not observed.`
    : "";
  return `\nNOT SHOWN ABOVE (${missing.length} observation(s) carried in the bundle but withheld from this dossier — do not infer their absence means "not observed"):\n${lines.join("\n")}\n${caveat}`;
}