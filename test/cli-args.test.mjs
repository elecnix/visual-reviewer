import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

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
  const { code, stdout } = run(["clusters", "/tmp/visual-reviewer-does-not-exist-xyz"]);
  assert.equal(code, 1);
  assert.match(stdout, /No output dir at/);
});

test("cli: feedback without --accept/--reject exits 5", () => {
  const { code, stdout } = run(["feedback", "/tmp"]);
  assert.equal(code, 5);
  assert.match(stdout, /requires --accept or --reject/);
});

test("cli: clusters honours --output-dir, which the divergent parsers dropped", () => {
  const { code, stdout } = run(["clusters", "--output-dir", "/tmp/vr-no-such-dir-abc"]);
  assert.equal(code, 1);
  assert.match(stdout, /\/tmp\/vr-no-such-dir-abc/);
});

test("cli: clusters honours the output-dir environment variable too", () => {
  const { code, stdout } = run(["clusters"], {
    VISUAL_REVIEWER_OUTPUT_DIR: "/tmp/vr-env-dir-abc",
  });
  assert.equal(code, 1);
  assert.match(stdout, /\/tmp\/vr-env-dir-abc/);
});

test("cli: judge reports no bundles under an empty output dir instead of judging nothing", () => {
  const { code, stdout } = run(["judge", "/tmp/vr-empty-dir-abc"]);
  assert.equal(code, 1);
  assert.match(stdout, /No evidence bundles found/);
});