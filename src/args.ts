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
    // resolveOracleConfig, because "" is not nullish. A negative number is a value.
    const value = (): string | undefined => {
      const next = argv[i + 1];
      if (next === undefined) return undefined;
      if (next.startsWith("-") && !/^-\d/.test(next)) return undefined;
      i += 1;
      return next;
    };
    const apply = COMMON_FLAGS[arg];
    if (apply) {
      // A flag with no value leaves the option unset rather than setting "",
      // so resolveOracleConfig still falls back to its default.
      const v = value();
      if (v !== undefined) apply(options, v);
      continue;
    }
    if (Object.prototype.hasOwnProperty.call(extras, arg)) {
      extra[arg] = extras[arg] ? (value() ?? "") : "true";
      continue;
    }
    if (!arg.startsWith("-")) dir = arg;
  }
  return { dir, options, help, extra };
}
