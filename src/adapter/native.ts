import type {
  AdapterArtifacts,
  AdapterEvidence,
  AdapterMetadata,
  AdapterStatus,
  FrameworkAdapter,
} from "./types.js";
import { buildBundleFromAdapter } from "./build.js";

/**
 * Knowledge shared by every native (Appium / XCTest / …) adapter.
 *
 * These parsers differ only in the framework's manifest shape — the parts
 * that are identical (how a run is projected into `AdapterMetadata`, how a
 * framework log line becomes a `crash` or `console_event`) live here so they
 * cannot drift. Anything genuinely framework-specific stays in the adapter.
 */

/** A framework log line, in whichever field name the framework uses. */
export interface NativeLogEvent {
  level: string;
  message: string;
  timestamp: number;
}

/** The manifest fields every native framework reports the same way. */
export interface NativeRunHeader {
  runId: string;
  title: string;
  file: string;
  project?: string;
  status: AdapterStatus;
  durationMs: number;
}

/** An `error`-level log line is a crash signal; anything else is chatter. */
const CRASH_LEVEL = /\berror\b/i;

/**
 * Project a native run header into canonical metadata.
 *
 * `projectFallback` is the documented per-adapter escape hatch for manifests
 * that report the platform under a different field (XCTest: `os`), so the
 * projection stays shared without normalising the two adapters' behaviour.
 */
export function nativeMetadata(
  adapterId: string,
  header: NativeRunHeader,
  options: { projectFallback?: string } = {},
): AdapterMetadata {
  return {
    adapter: adapterId,
    schemaVersion: 1,
    runId: header.runId,
    title: header.title,
    file: header.file,
    project: header.project ?? options.projectFallback,
    status: header.status,
    durationMs: header.durationMs,
  };
}

/** Framework log lines → `crash` / `console_event` evidence. */
export function logEventsToEvidence(
  logs: NativeLogEvent[] | undefined,
  source: string,
): AdapterEvidence[] {
  return (logs ?? []).map((ev) => ({
    type: CRASH_LEVEL.test(ev.level) ? "crash" : "console_event",
    timestamp: ev.timestamp,
    content: { level: ev.level, message: ev.message, source },
  }));
}

/**
 * Build the `FrameworkAdapter` for a native framework: `parse` is the only
 * framework-specific part; bundling is identical for all of them.
 */
export function defineNativeAdapter(spec: {
  id: string;
  label: string;
  version: string;
  parse(dir: string): AdapterArtifacts;
}): FrameworkAdapter {
  return {
    id: spec.id,
    label: spec.label,
    version: spec.version,
    kind: "native",
    parse: spec.parse,
    build(dir: string) {
      return buildBundleFromAdapter(spec.parse(dir), dir);
    },
  };
}