import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "../dist/args.js";
import { resolveOracleConfig } from "../dist/config.js";

/**
 * The CLI used to carry four argument parsers: `parseArgs` for `judge` and an
 * inline loop each inside `benchMain`, `clustersMain` and `feedbackMain`. Flag
 * coverage had drifted with them — `--output-dir` and `--max-screenshots` were
 * honoured by `judge` and silently ignored elsewhere.
 *
 * These tests drive the built CLI as a subprocess, so they assert what a user
 * actually gets rather than what the parser intends.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = path.join(root, "dist", "cli.js");

const created = [];

/**
 * A fresh, empty temp dir, removed when this process exits.
 *
 * The CLI tests used to hard-code paths like /tmp/vr-empty-dir-abc and assert
 * on them. Nothing created or cleaned them, so any earlier run — or any other
 * process on the machine — could leave a bundle there and fail the assertion
 * for a reason that has nothing to do with the CLI.
 */
function tmpDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vr-cli-"));
  created.push(dir);
  return dir;
}

/** A path inside a fresh temp dir which does NOT exist. */
function missingPath() {
  return path.join(tmpDir(), "absent");
}

process.on("exit", () => {
  for (const dir of created) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
});

/** Run the CLI and return its exit code plus stdout. Never throws on non-zero. */
function run(args, env = {}) {
  try {
    const stdout = execFileSync(process.execPath, [cli, ...args], {
      encoding: "utf8",
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { code: 0, stdout };
  } catch (err) {
    return {
      code: err.status ?? 1,
      stdout: `${err.stdout ?? ""}${err.stderr ?? ""}`,
    };
  }
}

test("cli: --help exits 0 and prints the judge usage", () => {
  const { code, stdout } = run(["judge", "--help"]);
  assert.equal(code, 0);
  assert.match(stdout, /visual-reviewer judge \[dir\]/);
  assert.match(stdout, /--max-screenshots/);
});

test("cli: every subcommand has its own --help", () => {
  for (const [command, expected] of [
    ["bench", /visual-reviewer bench/],
    ["clusters", /visual-reviewer clusters/],
    ["feedback", /visual-reviewer feedback/],
  ]) {
    const { code, stdout } = run([command, "--help"]);
    assert.equal(code, 0, `${command} --help should exit 0`);
    assert.match(stdout, expected);
  }
});

test("cli: -h is accepted as well as --help", () => {
  assert.equal(run(["clusters", "-h"]).code, 0);
});

test("cli: --no-judge still routes to help, not to options.judge", () => {
  // Pre-existing behaviour, deliberately preserved: `--no-judge` has always
  // printed the usage rather than disabling the judge. Changing it is a
  // behaviour change, not part of this refactor.
  const { code, stdout } = run(["judge", "--no-judge"]);
  assert.equal(code, 0);
  assert.match(stdout, /visual-reviewer judge/);
});

test("cli: a missing output dir fails with exit 1 and a pointed message", () => {
  const target = missingPath();
  const { code, stdout } = run(["clusters", target]);
  assert.equal(code, 1);
  assert.match(stdout, /No output dir at/);
  assert.ok(stdout.includes(target), `message should name ${target}`);
});

test("cli: feedback without --accept/--reject exits 5", () => {
  const { code, stdout } = run(["feedback", tmpDir()]);
  assert.equal(code, 5);
  assert.match(stdout, /requires --accept or --reject/);
});

test("cli: clusters honours --output-dir, which the divergent parsers dropped", () => {
  const target = missingPath();
  const { code, stdout } = run(["clusters", "--output-dir", target]);
  assert.equal(code, 1);
  assert.ok(stdout.includes(target), `message should name ${target}`);
});

test("cli: clusters honours the output-dir environment variable too", () => {
  const target = missingPath();
  const { code, stdout } = run(["clusters"], {
    VISUAL_REVIEWER_OUTPUT_DIR: target,
  });
  assert.equal(code, 1);
  assert.ok(stdout.includes(target), `message should name ${target}`);
});

test("cli: judge reports no bundles under an empty output dir instead of judging nothing", () => {
  // tmpDir() exists and is empty, so the CLI must reach findBundles and report
  // "no bundles" rather than "no output dir".
  const { code, stdout } = run(["judge", tmpDir()]);
  assert.equal(code, 1);
  assert.match(stdout, /No evidence bundles found/);
});

test("cli: a value-taking flag does not swallow the next flag", () => {
  // Before, `value()` was `argv[++i] ?? ""` with no guard, so --model consumed
  // the literal "--max-screenshots" as its model id and "5" was left to be
  // parsed as the positional dir — maxScreenshots silently kept its default.
  // This has no observable CLI output, so parseArgs is exercised directly.
  const { dir, options } = parseArgs(["--model", "--max-screenshots", "5"]);
  assert.equal(options.model, undefined);
  assert.equal(options.maxScreenshots, 5);
  assert.equal(dir, "");
});

test("cli: a negative number is only a value for a numeric flag", () => {
  // `--temperature -0.5` is legitimate; `--model -5` and `--output-dir -1` are
  // typos. Shape alone cannot tell them apart, so numeric flags are named.
  const numeric = parseArgs(["--max-screenshots", "-1", "--temperature", "-0.5"]);
  assert.equal(numeric.options.maxScreenshots, -1);
  assert.equal(numeric.options.temperature, -0.5);

  const notNumeric = parseArgs(["--model", "-5"]);
  assert.equal(notNumeric.options.model, undefined);

  const dir = parseArgs(["--output-dir", "-1"]);
  assert.equal(dir.options.outputDir, undefined);

  // The old `^-\d` test also swallowed tokens that merely started with a digit.
  const sloppy = parseArgs(["--temperature", "-5x"]);
  assert.equal(sloppy.options.temperature, undefined);
});

test("cli: bench prefers the positional dir over --seed in either order", () => {
  // main's four parsers were last-one-wins, so `--seed X Y` resolved to Y but
  // `Y --seed X` resolved to X. The unified parser makes the positional win in
  // both orders. Also invisible from CLI output — dir is the only sink.
  const after = parseArgs(["--seed", "SEED", "POS"], { "--seed": true });
  assert.equal(after.dir, "POS");
  assert.equal(after.extra["--seed"], "SEED");

  const before = parseArgs(["POS", "--seed", "SEED"], { "--seed": true });
  assert.equal(before.dir, "POS");
  assert.equal(before.extra["--seed"], "SEED");
});

test("cli: a boolean extra flag does not consume the positional directory", () => {
  // feedbackMain declares --accept/--reject as boolean (`false` = takes no
  // value) and --note/--verdict as value-taking (`true`). A boolean flag must
  // leave the next token for the positional dir.
  const extras = { "--accept": false, "--reject": false, "--note": true, "--verdict": true };

  const flagFirst = parseArgs(["--accept", "/tmp/x"], extras);
  assert.equal(flagFirst.dir, "/tmp/x");
  assert.equal(flagFirst.extra["--accept"], "true");

  const dirFirst = parseArgs(["/tmp/x", "--accept"], extras);
  assert.equal(dirFirst.dir, "/tmp/x");
  assert.equal(dirFirst.extra["--accept"], "true");

  const valued = parseArgs(["--note", "hello", "/tmp/x"], extras);
  assert.equal(valued.dir, "/tmp/x");
  assert.equal(valued.extra["--note"], "hello");
});

test("cli: a bare value-taking flag leaves the option unset so the default survives", () => {
  // resolveOracleConfig uses `??`, so "" would beat the default model id and
  // the provider would be asked for a model named "". Leaving it unset keeps
  // the default.
  const { options } = parseArgs(["--model"]);
  assert.equal(options.model, undefined);
  assert.equal(resolveOracleConfig(options).model, resolveOracleConfig({}).model);
});

test("cli: --accept and --reject together are refused as contradictory", () => {
  // On main the loop was last-one-wins, so `--accept --reject` recorded a
  // rejection and `--reject --accept` recorded an acceptance. With the extras
  // table the --reject check runs last, so it would always win. Neither is
  // right: refuse the contradiction instead of silently dropping a flag.
  const both = run(["feedback", tmpDir(), "--accept", "--reject"]);
  assert.equal(both.code, 5);
  assert.match(both.stdout, /mutually exclusive/);

  const reversed = run(["feedback", tmpDir(), "--reject", "--accept"]);
  assert.equal(reversed.code, 5);
  assert.match(reversed.stdout, /mutually exclusive/);
});

test("cli: a numeric flag given a non-numeric value is left unset, never NaN", () => {
  // NaN is worse than unset: it compares false against every bound, so a NaN
  // screenshot cap silently passes every downstream length check.
  const bad = parseArgs(["--max-screenshots", "abc", "--temperature", "NaN", "--timeout-ms", "1e"]);
  assert.equal(bad.options.maxScreenshots, undefined);
  assert.equal(bad.options.temperature, undefined);
  assert.equal(bad.options.timeoutMs, undefined);

  const good = parseArgs(["--max-screenshots", "3", "--temperature", "-0.5"]);
  assert.equal(good.options.maxScreenshots, 3);
  assert.equal(good.options.temperature, -0.5);

  // Non-numeric flags are unaffected.
  const model = parseArgs(["--model", "abc"]);
  assert.equal(model.options.model, "abc");
});

test("cli: a bare invocation reports a missing output dir instead of crashing", () => {
  // main() used to call judgeMain([command, ...rest]) with command undefined,
  // so `visual-reviewer` on its own threw TypeError: Cannot read properties
  // of undefined (reading 'startsWith').
  const { code, stdout } = run([]);
  assert.notEqual(code, 0);
  assert.doesNotMatch(stdout, /TypeError/);
  assert.match(stdout, /No evidence bundles found/);
});

test("cli: an explicit `judge` word is a subcommand token, not the directory", () => {
  // The same line put the subcommand word into `dir`; last-positional-wins
  // hid it until a second positional started being rejected.
  const dir = tmpDir();
  const explicit = run(["judge", dir]);
  assert.equal(explicit.code, 1);
  assert.ok(explicit.stdout.includes(dir), `should judge ${dir}`);
  assert.doesNotMatch(explicit.stdout, /already given as "judge"/);

  const implied = run([dir]);
  assert.equal(implied.code, 1);
  assert.ok(implied.stdout.includes(dir), `should judge ${dir}`);
});

test("cli: a second positional is rejected, naming the first directory", () => {
  const first = tmpDir();
  const second = tmpDir();
  const { code, stdout } = run(["judge", first, second]);
  assert.equal(code, 5);
  assert.match(stdout, new RegExp(`unexpected argument "${second.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`));
  assert.ok(stdout.includes(first), `should name the directory already given (${first})`);
});

test("cli: a numeric flag with a non-numeric value is rejected, not ignored", () => {
  const { code, stdout } = run(["judge", "--max-screenshots", "abc", tmpDir()]);
  assert.equal(code, 5);
  assert.match(stdout, /--max-screenshots expects a number, got "abc"/);
});

test("cli: --help still wins over a malformed flag elsewhere on the line", () => {
  const { code, stdout } = run(["judge", "--max-screenshots", "abc", "--help"]);
  assert.equal(code, 0);
  assert.match(stdout, /visual-reviewer judge/);
});
