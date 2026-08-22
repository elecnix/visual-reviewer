import fs from "node:fs";
import path from "node:path";
import type { EvidenceBundle } from "./model.js";

export const BUNDLE_FILE = "bundle.json";

export function sanitizeTestId(title: string): string {
  return (
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80) || "test"
  );
}

/** Persist a bundle (and inline any file-backed evidence paths as relative refs). */
export function writeBundle(outputDir: string, bundle: EvidenceBundle): string {
  const dir = path.join(outputDir, sanitizeTestId(bundle.testId));
  fs.mkdirSync(dir, { recursive: true });
  const bundlePath = path.join(dir, BUNDLE_FILE);
  fs.writeFileSync(bundlePath, JSON.stringify(bundle, null, 2));
  return bundlePath;
}

export function readBundle(bundlePath: string): EvidenceBundle {
  const raw = fs.readFileSync(bundlePath, "utf8");
  const parsed = JSON.parse(raw) as EvidenceBundle;
  if (parsed.schemaVersion !== 1) {
    throw new Error(
      `Unsupported bundle schemaVersion ${parsed.schemaVersion} in ${bundlePath}`,
    );
  }
  return parsed;
}

/** Find every bundle.json under a directory (any depth). */
export function findBundles(rootDir: string): string[] {
  const out: string[] = [];
  const stack = [rootDir];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.name === BUNDLE_FILE) out.push(full);
    }
  }
  return out.sort();
}
