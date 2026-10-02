import fs from "node:fs";
import path from "node:path";
import type {
  AdapterArtifactIndex,
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
 *   artifacts.json    optional [{ name, path }] (object form also accepted)
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
  const artifactIndexMap: AdapterArtifactIndex = {};
  if (fs.existsSync(artifactIndex)) {
    for (const [name, file] of readArtifactIndex(artifactIndex)) {
      artifactIndexMap[name] = file;
    }
  }

  return {
    metadata,
    sourceCode,
    assertions: readJson<AdapterAssertion>("assertions.json"),
    evidence: readJson<AdapterEvidence>("evidence.json"),
    artifacts: artifactIndexMap,
  };
}

/**
 * Read `artifacts.json` into the one in-memory shape (`name -> path`).
 *
 * The writer emits the array form written by `writeAdapterArtifacts`; the
 * object form documented in earlier revisions of the contract is accepted too
 * so a hand-written or third-party index is not silently lost. Anything else
 * fails loudly instead of yielding an empty index.
 */
function readArtifactIndex(file: string): [string, string][] {
  const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
  if (Array.isArray(parsed)) {
    return parsed.map((entry, i) => {
      const e = entry as { name?: unknown; path?: unknown };
      if (typeof e?.name !== "string" || typeof e?.path !== "string") {
        throw new Error(
          `artifacts.json entry ${i} must be { name: string, path: string }`,
        );
      }
      return [e.name, e.path] as [string, string];
    });
  }
  if (parsed && typeof parsed === "object") {
    return Object.entries(parsed as Record<string, unknown>).map(
      ([name, file]) => {
        if (typeof file !== "string") {
          throw new Error(`artifacts.json entry "${name}" must map to a string path`);
        }
        return [name, file] as [string, string];
      },
    );
  }
  throw new Error('artifacts.json must be [{ name, path }] or { name: path }');
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
    // Canonical on-disk form of AdapterArtifactIndex (see readArtifactIndex).
    const entries = Object.entries(artifacts.artifacts).map(([name, file]) => ({
      name,
      path: file,
    }));
    fs.writeFileSync(path.join(dir, "artifacts.json"), JSON.stringify(entries, null, 2));
  }
}