import type { ModelMessage } from "ai";

/**
 * Completion seam — the oracle's only way to talk to a model.
 *
 * Everything network-shaped about a judgement (provider construction,
 * timeouts, abort signals, transport errors) lives behind `Complete`, so
 * `judge.ts` can be driven by a scripted implementation in tests instead of
 * by a live endpoint. The retry ladder and the bounded follow-up round in
 * `judge.ts` are pure orchestration over this interface, which is what makes
 * them testable at all.
 */

/** Anything the oracle can put in a user turn: text plus inline images. */
export type UserContent = Extract<ModelMessage, { role: "user" }>["content"];

/** One completion request. The oracle never names a model or a base URL here. */
export interface CompletionRequest {
  system: string;
  messages: ModelMessage[];
  temperature: number;
  /** Abort the request after this many ms. */
  timeoutMs: number;
}

/** The model's reply. The oracle only ever reads `text`. */
export interface Completion {
  text: string;
}

export type Complete = (request: CompletionRequest) => Promise<Completion>;
