import type { EvidenceBundle } from "../evidence/model.js";
import { appiumAdapter } from "./appium.js";
import { buildBundleFromAdapter } from "./build.js";
import { loadAdapterArtifacts } from "./load.js";
import type { AdapterArtifacts, FrameworkAdapter } from "./types.js";
import { xctestAdapter } from "./xctest.js";

/**
 * Registry of framework adapters — the ONE store for them.
 *
 * Consumers ask `getAdapter(id)` for a known adapter, or fall back to the
 * canonical adapter that reads the documented artifact layout. New adapters
 * (a fourth framework, or a test double) call `registerAdapter` and are
 * immediately honoured by `buildForAdapter`, `listAdapters` and the
 * cross-platform platform labelling — there is no second registry to update.
 *
 * The adapters shipped with visual-reviewer register themselves on import of
 * this module, so importing `registry.js` is enough to populate it.
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

/**
 * The documented-artifact-layout adapter: the fallback every id resolves to,
 * and the single definition of "canonical". It is intentionally NOT in the
 * registry — `listAdapters()` lists concrete frameworks only.
 */
export const canonicalAdapter: FrameworkAdapter = {
  id: "canonical",
  label: "Canonical artifacts",
  version: "1.0.0",
  kind: "web",
  parse(dir: string): AdapterArtifacts {
    return loadAdapterArtifacts(dir);
  },
  build(dir: string): EvidenceBundle {
    return buildBundleFromAdapter(loadAdapterArtifacts(dir), dir);
  },
};

/** Parse a canonical artifacts directory into a typed shape. */
export function parseCanonical(dir: string): AdapterArtifacts {
  return canonicalAdapter.parse(dir);
}

/** Parse + build using a registered adapter (defaults to canonical). */
export function buildForAdapter(id: string, dir: string): EvidenceBundle {
  return (registry.get(id) ?? canonicalAdapter).build(dir);
}

// Populate the registry with the built-in adapters on import.
for (const adapter of [appiumAdapter, xctestAdapter]) registerAdapter(adapter);