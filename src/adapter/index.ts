/**
 * Adapter layer — the pluggable seam that keeps the oracle core
 * framework-agnostic (brief §5, §7, §15.4).
 */
export { loadAdapterArtifacts, writeAdapterArtifacts } from "./load.js";
export { buildBundleFromAdapter } from "./build.js";
export {
  registerAdapter,
  unregisterAdapter,
  listAdapters,
  getAdapter,
  buildForAdapter,
  parseCanonical,
} from "./registry.js";
export type {
  FrameworkAdapter,
  AdapterArtifacts,
  AdapterAssertion,
  AdapterEvidence,
  AdapterMetadata,
  AdapterStatus,
} from "./types.js";
export type { RegisteredAdapter } from "./registry.js";
export { appiumAdapter, parseAppium } from "./appium.js";