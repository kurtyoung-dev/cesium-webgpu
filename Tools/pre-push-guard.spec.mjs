// pre-push-guard.spec.mjs — end-to-end contract for the pre-push hook.
// @purpose End-to-end wiring contract: hook fires on push, not on fetch/pull, and is POSIX-sh clean, exercised in a throwaway temp repository.
// @status ACTIVE
//
// Run: node --test Tools/pre-push-guard.spec.mjs
//
// The rule predicates are pinned hermetically in landing-rules.spec.mjs. What
// can only be established with a real repository is the WIRING, and three of
// those facts are the ones a hook usually gets wrong:
//
//   1. THE HOOK ACTUALLY FIRES ON PUSH and refuses a non-compliant one. A hook
//      that is installed but never reached is indistinguishable from a green
//      tree, which is how finding S9 stayed invisible for a week.
//   2. THE HOOK DOES NOT FIRE ON FETCH OR PULL. git only runs pre-push for
//      `git push`, but "the hook is annoying on every fetch" is the complaint
//      that gets guards uninstalled, so the negative is asserted — with the
//      positive control (a push under the identical environment DOES print) in
//      the same test, because a negative with no control proves nothing.
//   3. THE HOOK IS POSIX SH. Windows git ships a minimal sh; a bash-ism here
//      fails at push time on the maintainer's machine and nowhere else. This
//      spec runs the real hook file through whatever sh git chooses.
//
// The sandbox is a throwaway repository under the OS temp directory with
// core.hooksPath pointed at its own copy of .husky, so nothing here can touch
// the real repository's refs.
//
// STRUCTURAL, not product-FAIL, when git is unavailable: the subject cannot be
// seen, so the tests skip rather than reporting a pass or a failure.

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { isQuietHours } from "./landing-rules.mjs";

const ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const GIT_TIMEOUT_MS = 60_000;

const IDENTITY = [
  "-c",
  "user.name=cesium-webgpu-agent",
  "-c",
  "user.email=cesium-webgpu-agent@users.noreply.github.com",
  "-c",
  "commit.gpgsign=false",
];

/**
 * Whether git can be executed at all.
 *
 * @returns {boolean} True when `git --version` succeeds.
 */
function hasGit() {
  try {
    execFileSync("git", ["--version"], {
      stdio: "ignore",
      timeout: GIT_TIMEOUT_MS,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Run a command, capturing status and BOTH streams.
 *
 * spawnSync rather than execFileSync because the guard reports on stderr: a
 * success-path helper that only kept stdout would silently assert against an
 * empty string and every "the guard printed X" check would vacuously pass.
 *
 * @param {string} file Executable.
 * @param {string[]} args Arguments.
 * @param {object} [options] cwd / env overrides.
 * @returns {{status: number, output: string}} Result.
 */
function run(file, args, options = {}) {
  const result = spawnSync(file, args, {
    encoding: "utf8",
    timeout: GIT_TIMEOUT_MS,
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  });
  if (result.error !== undefined && result.error !== null) {
    throw result.error;
  }
  return {
    status: result.status ?? 1,
    output: `${result.stdout ?? ""}${result.stderr ?? ""}`,
  };
}

/**
 * Build a sandbox repository whose only hook is the real pre-push hook.
 *
 * @returns {{dir: string, work: string, origin: string, git: Function, commit: Function}} Sandbox.
 */
function makeSandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "landing-hook-"));
  const origin = path.join(dir, "origin.git");
  const work = path.join(dir, "work");
  execFileSync("git", ["init", "--bare", "--initial-branch=main", origin], {
    stdio: "ignore",
    timeout: GIT_TIMEOUT_MS,
  });
  execFileSync("git", ["init", "--initial-branch=main", work], {
    stdio: "ignore",
    timeout: GIT_TIMEOUT_MS,
  });

  fs.mkdirSync(path.join(work, ".husky"), { recursive: true });
  fs.mkdirSync(path.join(work, "Tools"), { recursive: true });
  for (const [from, to] of [
    [".husky/pre-push", ".husky/pre-push"],
    ["Tools/pre-push-guard.mjs", "Tools/pre-push-guard.mjs"],
    ["Tools/landing-rules.mjs", "Tools/landing-rules.mjs"],
  ]) {
    fs.copyFileSync(path.join(ROOT, from), path.join(work, to));
  }
  fs.chmodSync(path.join(work, ".husky", "pre-push"), 0o755);

  const git = (args, options = {}) =>
    run("git", [...IDENTITY, ...args], { cwd: work, ...options });

  git(["config", "core.hooksPath", path.join(work, ".husky")]);
  git(["remote", "add", "origin", origin]);

  const commit = (subject, body) => {
    fs.writeFileSync(
      path.join(work, "file.txt"),
      `${subject}\n${Math.random()}\n`,
    );
    const result = git(["add", "file.txt"]);
    assert.equal(result.status, 0, result.output);
    const args = ["commit", "--no-verify", "-m", subject];
    if (body !== undefined) {
      args.push("-m", body);
    }
    const committed = git(args);
    assert.equal(committed.status, 0, committed.output);
  };

  return { dir, work, origin, git, commit };
}

const TRAILER = "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>";
const EXPLAIN = { env: { ...process.env, HOOK_EXPLAIN: "1" } };

test(
  "pre-push hook end-to-end",
  { skip: hasGit() ? false : "git unavailable" },
  async (t) => {
    const sandbox = makeSandbox();
    t.after(() => fs.rmSync(sandbox.dir, { recursive: true, force: true }));

    // Whether a compliant push is allowed depends on the wall clock, which is
    // the point of the rule. The window maths is pinned against fixed instants
    // in landing-rules.spec.mjs; here the expectation is derived from the same
    // predicate so the suite is green at any hour without a bypass existing.
    const inWindow = isQuietHours(new Date());

    await t.test("a compliant commit passes every per-commit rule", () => {
      sandbox.commit(
        "Batch 1: the sandbox commit",
        `What landed and what it discharges.\n\n${TRAILER}`,
      );
      const push = sandbox.git(["push", "origin", "main"], EXPLAIN);
      assert.match(push.output, /landing-guard:/);
      assert.match(push.output, /ok\s+batch-prefix/);
      assert.match(push.output, /ok\s+body/);
      assert.match(push.output, /ok\s+co-author-trailer/);
      if (inWindow) {
        assert.equal(push.status, 1, push.output);
        assert.match(push.output, /quiet-hours.*07:00-19:00 US Eastern/s);
      } else {
        assert.equal(push.status, 0, push.output);
      }
    });

    await t.test("a non-compliant commit is refused, naming each rule", () => {
      sandbox.commit("Harden custom ellipsoid certification");
      const push = sandbox.git(["push", "origin", "main"], EXPLAIN);
      assert.notEqual(push.status, 0);
      assert.match(push.output, /PUSH REFUSED/);
      assert.match(push.output, /FAIL\s+batch-prefix/);
      assert.match(push.output, /FAIL\s+body/);
      assert.match(push.output, /FAIL\s+co-author-trailer/);
    });

    await t.test(
      "--no-verify bypasses the hook, which is why the verifier exists",
      () => {
        const push = sandbox.git(
          ["push", "--no-verify", "origin", "main"],
          EXPLAIN,
        );
        assert.equal(push.status, 0, push.output);
        assert.doesNotMatch(push.output, /landing-guard/);
      },
    );

    await t.test(
      "fetch and pull do not fire the hook (with a push as control)",
      () => {
        const fetched = sandbox.git(["fetch", "origin"], EXPLAIN);
        assert.equal(fetched.status, 0, fetched.output);
        assert.doesNotMatch(fetched.output, /landing-guard/);

        const pulled = sandbox.git(
          ["pull", "--ff-only", "origin", "main"],
          EXPLAIN,
        );
        assert.doesNotMatch(pulled.output, /landing-guard/);

        // Control: the same environment against a push DOES reach the guard.
        sandbox.commit("no prefix here");
        const push = sandbox.git(["push", "origin", "main"], EXPLAIN);
        assert.match(push.output, /landing-guard/);
      },
    );

    await t.test("a branch deletion is not treated as a landing", () => {
      sandbox.git(["branch", "scratch"]);
      const pushed = sandbox.git(["push", "--no-verify", "origin", "scratch"]);
      assert.equal(pushed.status, 0, pushed.output);
      const deleted = sandbox.git(
        ["push", "origin", "--delete", "scratch"],
        EXPLAIN,
      );
      assert.equal(deleted.status, 0, deleted.output);
      assert.match(deleted.output, /no ref updates to check/);
    });
  },
);
