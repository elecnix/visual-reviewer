import type { EvidenceBundle } from "../evidence/model.js";
import { buildBundleFromAdapter } from "./build.js";
import { loadAdapterArtifacts } from "./load.js";
import type { AdapterArtifacts, FrameworkAdapter } from "./types.js";

/**
 * Registry of framework adapters.
 *
 * Consumers can ask registry.getInstance(id) for a known adapter, or fall
 * back to a generic canonical adapter that reads the documented artifact
 * layout. New adapters (Appium, XCTest, …) register a specialized parser;
 * the bundle-building step is always the same, so an adapter is usually a
 * thin `parse()` against a framework-specific directory shape.
 */

const registry: Map<string, FrameworkAdapter> = new Map();

export interface RegisteredAdapter {
  id: string;
  label: string;
  version: string;
  kind: "web" | "native";
}

export function registerAdapter(adapter: FrameworkAdapter): void {
  registry.set(adapter.id, adapter);
}

export function unregisterAdapter(id: string): void {
  registry.delete(id);
}

export function listAdapters(): RegisteredAdapter[] {
  return [...registry.values()].map((a) => ({
    id: a.id,
    label: a.label,
    version: a.version,
    kind: a.kind,
  }));
}

export function getAdapter(id: string): FrameworkAdapter | undefined {
  return registry.get(id);
}

/** Parse a canonical artifacts directory into a typed shape, no registry. */
export function parseCanonical(dir: string): AdapterArtifacts {
  return loadAdapterArtifacts(dir);
}

/** Parse + build using a registered adapter (defaults to canonical). */
export function buildForAdapter(id: string, dir: string): EvidenceBundle {
  const adapter = registry.get(id);
  if (adapter) return adapter.build(dir);
  return buildBundleFromAdapter(loadAdapterArtifacts(dir), dir);
}