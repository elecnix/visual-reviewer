import fs from "node:fs";
import path from "node:path";
import type {
  AdapterArtifacts,
  AdapterAssertion,
  AdapterEvidence,
  AdapterMetadata,
} from "./types.js";

/**
 * Canonical artifact reader shared by every adapter and by tests/smoke tooling.
 * Framework-specific adapters produce this layout; `loadAdapterArtifacts`
 * turns it back into typed structures (or throws with a clear message).
 *
 * Directory layout:
 *   metadata.json     required
 *   sourceCode        optional test spec text (also accepts sourceCode.json)
 *   assertions.json   optional [{ title, passed, error? }]
 *   evidence.json     optional [{ type, timestamp, content, asset?, metadata? }]
 *   artifacts.json    optional { name: relativePath }
 */

export function loadAdapterArtifacts(dir: string): AdapterArtifacts {
  const metadataPath = path.join(dir, "metadata.json");
  const metadata = JSON.parse(fs.readFileSync(metadataPath, "utf8")) as AdapterMetadata;

  let sourceCode: string | undefined;
  const sourceJson = path.join(dir, "sourceCode.json");
  const sourceTxt = path.join(dir, "sourceCode");
  if (fs.existsSync(sourceJson)) {
    const parsed = JSON.parse(fs.readFileSync(sourceJson, "utf8")) as { source?: unknown };
    sourceCode = typeof parsed.source === "string" ? parsed.source : undefined;
  } else if (fs.existsSync(sourceTxt)) {
    sourceCode = fs.readFileSync(sourceTxt, "utf8");
  }

  const readJson = <T>(name: string): T[] | undefined => {
    const file = path.join(dir, name);
    return fs.existsSync(file) ? (JSON.parse(fs.readFileSync(file, "utf8")) as T[]) : undefined;
  };

  const artifactIndex = path.join(dir, "artifacts.json");
  const artifactIndexMap: Record<string, string> = {};
  if (fs.existsSync(artifactIndex)) {
    const entries = JSON.parse(fs.readFileSync(artifactIndex, "utf8")) as Array<{
      name: string;
      path: string;
    }>;
    for (const entry of entries) artifactIndexMap[entry.name] = entry.path;
  }

  return {
    metadata,
    sourceCode,
    assertions: readJson<AdapterAssertion>("assertions.json"),
    evidence: readJson<AdapterEvidence>("evidence.json"),
    artifacts: artifactIndexMap,
  };
}

/** Persist canonical artifacts into a directory (test/sample fixture helper). */
export function writeAdapterArtifacts(dir: string, artifacts: AdapterArtifacts): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "metadata.json"),
    JSON.stringify(artifacts.metadata, null, 2),
  );
  if (artifacts.sourceCode !== undefined) {
    fs.writeFileSync(
      path.join(dir, "sourceCode.json"),
      JSON.stringify({ source: artifacts.sourceCode }, null, 2),
    );
  }
  if (artifacts.assertions) {
    fs.writeFileSync(
      path.join(dir, "assertions.json"),
      JSON.stringify(artifacts.assertions, null, 2),
    );
  }
  if (artifacts.evidence && artifacts.evidence.length > 0) {
    fs.writeFileSync(
      path.join(dir, "evidence.json"),
      JSON.stringify(artifacts.evidence, null, 2),
    );
  }
  if (artifacts.artifacts) {
    const entries = Object.entries(artifacts.artifacts).map(([name, file]) => ({
      name,
      path: file,
    }));
    fs.writeFileSync(path.join(dir, "artifacts.json"), JSON.stringify(entries, null, 2));
  }
}