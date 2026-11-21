import fs from "node:fs";
import path from "node:path";
import type { Evidence, EvidenceBundle } from "../evidence/model.js";
import { nextEvidenceId } from "../evidence/model.js";
import type { AdapterArtifacts } from "./types.js";

/**
 * Build a durable EvidenceBundle from canonical adapter artifacts.
 *
 * Binary-backed evidence (screenshot, video frame, native-state dump) is
 * copied into a `files/` directory and exposed as bundle-relative `{ file }`
 * references, mirroring the `assets/` convention the Playwright adapter
 * already uses — the oracle's `selectScreenshots` reads those bytes directly.
 * Every evidence entry receives a stable, review-friendly id and source tag.
 *
 * Asset resolution lives HERE, not in the adapters: `asset` (and every
 * `artifacts` entry) is documented as a path relative to the artifacts dir,
 * so a parser never has to know where that dir is. Absolute paths are still
 * accepted, which keeps adapters that pre-join the dir working unchanged.
 */
export function buildBundleFromAdapter(
  artifacts: AdapterArtifacts,
  outputDir: string,
): EvidenceBundle {
  const { metadata } = artifacts;
  const dir = path.resolve(outputDir);
  const filesDir = path.join(dir, "files");
  fs.mkdirSync(filesDir, { recursive: true });

  let shots = 0;
  let states = 0;
  const evidence: Evidence[] = [];
  for (const item of artifacts.evidence ?? []) {
    if (!item.asset) {
      evidence.push({
        id: nextEvidenceId("ev"),
        timestamp: item.timestamp,
        type: item.type,
        source: `${metadata.adapter}:artifact`,
        content: item.content,
        metadata: item.metadata,
      });
      continue;
    }

    const src = path.resolve(dir, item.asset);
    if (!fs.existsSync(src)) {
      // Advisory: a missing asset must not sink the whole bundle. Name the
      // resolved path and the dir it was resolved against — quoting only the
      // raw `asset` gives no clue when the caller assumed a different base.
      console.warn(
        `[visual-reviewer] ${metadata.adapter} adapter: missing asset "${item.asset}" ` +
          `(resolved to ${src}; "asset" is relative to the artifacts dir ${dir}, not the cwd)`,
      );
      continue;
    }

    const ext = path.extname(src);
    const isShot = item.type === "screenshot";
    const fileName = `${isShot ? "shot" : "state"}-${(isShot ? ++shots : ++states)}`
      + (ext ? ext : ".bin");
    fs.writeFileSync(path.join(filesDir, fileName), fs.readFileSync(src));
    evidence.push({
      id: nextEvidenceId("ev"),
      timestamp: item.timestamp,
      type: item.type,
      source: `${metadata.adapter}:artifact`,
      content: { file: `files/${fileName}` },
      metadata: {
        ...(item.metadata ?? {}),
        originalName: path.basename(src),
      },
    });
  }

  const namedArtifacts: Record<string, string> = {};
  for (const [name, file] of Object.entries(artifacts.artifacts ?? {})) {
    const src = path.resolve(dir, file);
    if (!fs.existsSync(src)) {
      // Was silently skipped: a named artifact that never lands is invisible in
      // the bundle, and the run carries on as if it had been written.
      console.warn(
        `[visual-reviewer] ${metadata.adapter} adapter: missing named artifact "${name}" ` +
          `(resolved to ${src}; paths in "artifacts" are relative to the artifacts dir ${dir}, not the cwd)`,
      );
      continue;
    }
    const fileName = path.basename(src);
    fs.writeFileSync(path.join(filesDir, fileName), fs.readFileSync(src));
    namedArtifacts[name] = `files/${fileName}`;
  }

  const bundle: EvidenceBundle = {
    schemaVersion: 1,
    runId: metadata.runId,
    testId: metadata.file,
    project: metadata.project,
    title: metadata.title,
    file: metadata.file,
    sourceCode: artifacts?.sourceCode ?? "",
    status: metadata.status,
    durationMs: metadata.durationMs,
    assertions: artifacts?.assertions ?? [],
    evidence,
    artifacts: namedArtifacts,
  };

  fs.writeFileSync(path.join(dir, "bundle.json"), JSON.stringify(bundle, null, 2));
  return bundle;
}