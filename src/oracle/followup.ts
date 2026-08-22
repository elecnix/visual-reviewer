import fs from "node:fs";
import path from "node:path";
import type { ImagePart, TextPart } from "ai";
import type { EvidenceBundle } from "../evidence/model.js";

/**
 * Bounded agentic investigation (brief §7): when the first pass is
 * UNCERTAIN or low-confidence, the oracle may request specific additional
 * evidence from the bundle — it never gets the firehose, and the round is
 * capped at one.
 */

export interface EvidenceRequest {
  type: "network_body" | "console" | "dom_snapshot" | "screenshot" | "actions";
  urlContains?: string;
  index?: number;
}

const MAX_REQUESTS = 3;

export function followUpInstruction(): string {
  return `Your verdict confidence is low or uncertain. Before finalizing, you may request up to ${MAX_REQUESTS} additional pieces of evidence from the run bundle.

Respond ONLY with JSON:
{"evidence_requests":[{"type":"network_body","urlContains":"substring of url"},
 {"type":"console"},{"type":"dom_snapshot"},{"type":"screenshot","index":1},{"type":"actions"}]}

Rules:
- network_body: full request/response detail for events whose URL contains urlContains
- screenshot: index is 0-based chronological order of available screenshots
Choose only evidence that could change your verdict.`;
}

export function parseEvidenceRequests(text: string): EvidenceRequest[] {
  try {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}") + 1;
    const parsed = JSON.parse(text.slice(start, end)) as {
      evidence_requests?: Array<Record<string, unknown>>;
    };
    return (parsed.evidence_requests ?? [])
      .slice(0, MAX_REQUESTS)
      .flatMap((r) => {
        const type = String(r.type ?? "");
        if (["network_body", "console", "dom_snapshot", "screenshot", "actions"].includes(type)) {
          return [{
            type: type as EvidenceRequest["type"],
            ...(typeof r.urlContains === "string" ? { urlContains: r.urlContains } : {}),
            ...(typeof r.index === "number" ? { index: r.index } : {}),
          }];
        }
        return [];
      });
  } catch {
    return [];
  }
}

/** Resolve requests against the local bundle — deterministic, no model involved. */
export function gatherRequestedEvidence(
  bundle: EvidenceBundle,
  bundleDir: string,
  requests: EvidenceRequest[],
): Array<TextPart | ImagePart> {
  const parts: Array<TextPart | ImagePart> = [];
  let text = `\nEVIDENCE REQUESTED (${requests.length} item(s)):\n`;

  for (const req of requests) {
    switch (req.type) {
      case "network_body": {
        const matches = bundle.evidence.filter(
          (e) =>
            e.type === "network_event" &&
            (!req.urlContains ||
              String((e.content as Record<string, unknown>).url).includes(req.urlContains)),
        );
        for (const e of matches.slice(0, 5)) {
          text += `\n[${e.id}] ${JSON.stringify(e.content)}\n`;
        }
        if (matches.length === 0) text += `- no network event matching "${req.urlContains ?? "*"}"\n`;
        break;
      }
      case "console": {
        const consoleEvents = bundle.evidence.filter((e) => e.type === "console_event" || e.type === "crash");
        if (consoleEvents.length === 0) {
          text += "- no console events recorded\n";
        } else {
          for (const e of consoleEvents.slice(0, 20)) {
            text += `[${e.id}] ${JSON.stringify(e.content)}\n`;
          }
        }
        break;
      }
      case "dom_snapshot": {
        const dom = bundle.evidence.find((e) => e.type === "dom_snapshot");
        text += dom
          ? `[${dom.id}] DOM snapshot${dom.metadata?.note ? ` (note: ${String(dom.metadata.note)})` : ""}:\n${String(dom.content).slice(0, 6000)}\n`
          : "- no DOM snapshot in bundle\n";
        break;
      }
      case "screenshot": {
        const shots = bundle.evidence.filter((e) => e.type === "screenshot");
        const idx = req.index ?? shots.length - 1;
        const shot = shots[idx];
        const file = shot && (shot.content as { file?: string }).file;
        if (file) {
          try {
            const buffer = fs.readFileSync(path.join(bundleDir, file));
            parts.push({ type: "text", text: `SCREENSHOT [${shot.id}] index=${idx}` });
            parts.push({ type: "image", image: new Uint8Array(buffer) });
            break;
          } catch {
            /* fall through to miss report */
          }
        }
        text += `- screenshot index ${idx} unavailable\n`;
        break;
      }
      case "actions": {
        const actions = bundle.evidence.filter((e) => e.type === "user_action");
        if (actions.length === 0) {
          text += "- no action timeline recorded\n";
        } else {
          for (const e of actions) {
            text += `[${e.id}] t+${e.timestamp}ms ${JSON.stringify(e.content)}\n`;
          }
        }
        break;
      }
    }
  }

  parts.unshift({ type: "text", text });
  return parts;
}
