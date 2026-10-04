import type { VisualReviewerOptions } from "./config.js";

/**
 * One argument parser for every subcommand.
 *
 * `judge`, `bench` and `feedback` each had their own inline loop, and the
 * flag coverage had drifted: `--output-dir`, `--max-screenshots` and
 * `--no-baselines` worked for `judge` and were silently ignored (not
 * rejected) everywhere else. The shared table below is the single place a
 * flag is declared; a subcommand that does not want one simply ignores it,
 * which is the same forgiving behaviour, minus the four copies.
 *
 * Note `--no-judge` is deliberately still routed to `help`, not to
 * `options.judge`. That is what it has always done, and changing it is a
 * behaviour change, not a refactor. See the linked issue.
 */
export const COMMON_FLAGS: Readonly<Record<string, (opt: VisualReviewerOptions, value: string) => void>> = {
  "--model": (o, v) => {
    o.model = v;
  },
  "--base-url": (o, v) => {
    o.baseURL = v;
  },
  "--api-key-env": (o, v) => {
    o.apiKeyEnvVar = v;
  },
  "--output-dir": (o, v) => {
    o.outputDir = v;
  },
  "--max-screenshots": (o, v) => {
    o.maxScreenshots = Number(v);
  },
  "--no-baselines": (o) => {
    o.baselines = false;
  },
  "--temperature": (o, v) => {
    o.temperature = Number(v);
  },
  "--timeout-ms": (o, v) => {
    o.timeoutMs = Number(v);
  },
  "--no-follow-ups": (o) => {
    o.followUps = false;
  },
};

/** Flags whose value is a number, so a negative one is legitimate. */
const NUMERIC_FLAGS: ReadonlySet<string> = new Set([
  "--max-screenshots",
  "--temperature",
  "--timeout-ms",
]);

/** A negative decimal, optionally in exponent form. */
const NEGATIVE_NUMBER = /^-(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/;

export interface ParsedArgs {
  dir: string;
  options: VisualReviewerOptions;
  help: boolean;
  /** Subcommand-specific flags, keyed by flag name. */
  extra: Record<string, string>;
}

/**
 * @param extras subcommand-only flags, mapped to whether they take a value.
 */
/**
 * Parse one argv into a positional dir, the shared option set, and any
 * subcommand-specific extras.
 *
 * This lives in its own module rather than in cli.ts because importing cli.ts
 * runs main(). It also replaced three divergent inline copies, and the
 * seed/positional precedence it encodes has no observable CLI output — both
 * behaviours resolve to the same directory in every command — so testing it
 * directly is the only way to pin it.
 */
export function parseArgs(
  argv: string[],
  extras: Readonly<Record<string, boolean>> = {},
): ParsedArgs {
  const options: VisualReviewerOptions = {};
  const extra: Record<string, string> = {};
  let dir = "";
  let help = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--no-judge" || arg === "-h" || arg === "--help") {
      help = true;
      continue;
    }
    // A value-taking flag whose next token is another flag (or nothing) has no
    // value. Before, `--model --output-dir out` set model to the literal
    // "--output-dir" and left "out" to be parsed as the positional dir; a bare
    // `--model` set model to "" which then beat the default in
    // resolveOracleConfig, because "" is not nullish.
    //
    // A leading "-" is normally another flag, so it is not a value. The
    // exception is a genuine negative number, and only for a numeric flag:
    // `--temperature -0.5` is legitimate, `--model -5` and `--output-dir -1`
    // are typos. Shape alone cannot tell them apart, so the numeric flags are
    // named rather than guessed.
    const value = (): string | undefined => {
      const next = argv[i + 1];
      if (next === undefined) return undefined;
      if (next.startsWith("-") && !(NUMERIC_FLAGS.has(arg) && NEGATIVE_NUMBER.test(next))) {
        return undefined;
      }
      i += 1;
      return next;
    };
    const apply = COMMON_FLAGS[arg];
    if (apply) {
      // A flag with no value leaves the option unset rather than setting "",
      // so resolveOracleConfig still falls back to its default.
      const v = value();
      if (v === undefined) continue;
      // A numeric flag given a non-numeric value must not become NaN. NaN is
      // worse than unset: it compares false against every bound, so a NaN
      // screenshot cap silently passes every length check downstream.
      if (NUMERIC_FLAGS.has(arg) && !Number.isFinite(Number(v))) continue;
      apply(options, v);
      continue;
    }
    if (Object.prototype.hasOwnProperty.call(extras, arg)) {
      if (!extras[arg]) {
        // Boolean flag: present is the whole signal, it takes no value.
        extra[arg] = "true";
        continue;
      }
      // Value-taking extra. A missing value leaves the entry UNSET, matching
      // COMMON_FLAGS above — setting "" would make `extra["--x"] !== undefined`
      // true for a flag the user did not actually give.
      const v = value();
      if (v !== undefined) extra[arg] = v;
      continue;
    }
    if (!arg.startsWith("-")) dir = arg;
  }
  return { dir, options, help, extra };
}
