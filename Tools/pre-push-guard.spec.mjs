// pre-push-guard.spec.mjs — end-to-end contract for the pre-push hook.
// @purpose Hostile-input, multi-ref, protected-ref, and destructive-fixture contract for the real pre-push driver and hook.
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
import {
  parseAdvertisedRefs,
  parsePushRequests,
  readPushRequests,
  runCli,
} from "./pre-push-guard.mjs";

const ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const GIT_TIMEOUT_MS = 60_000;
const ZERO_SHA1 = "0".repeat(40);
const ZERO_SHA256 = "0".repeat(64);
const FIXED_COMMIT_ENV = Object.freeze({
  GIT_AUTHOR_DATE: "2026-08-14T23:15:30-04:00",
  GIT_COMMITTER_DATE: "2026-08-14T23:15:30-04:00",
});

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
    stdio: ["pipe", "pipe", "pipe"],
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
 * Whether candidate is a proper path-component descendant of root.
 *
 * @param {string} root Canonical root.
 * @param {string} candidate Canonical or derived candidate.
 * @returns {boolean} True only for a proper descendant.
 */
function isPathInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return (
    relative !== "" &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

/**
 * Apply exact-one source mutations to a copied driver.
 *
 * @param {string} source Driver source.
 * @param {{find: string, replace: string}[]} mutations Mutations.
 * @returns {string} Mutated source.
 */
function applyDriverMutations(source, mutations) {
  let result = source;
  for (const mutation of mutations) {
    const pieces = result.split(mutation.find);
    assert.equal(
      pieces.length,
      2,
      `driver mutant anchor must occur exactly once: ${mutation.find}`,
    );
    result = pieces.join(mutation.replace);
  }
  return result;
}

/**
 * Build a sandbox repository whose only hook is the copied pre-push hook.
 * Cleanup is registered immediately after allocation and also runs on a
 * construction exception.
 *
 * @param {import("node:test").TestContext} t Test context.
 * @param {{driverMutations?: {find: string, replace: string}[], failAt?: string, captureDir?: Function}} [options] Fixture options.
 * @returns {{dir: string, work: string, origin: string, git: Function, commit: Function, guard: Function, cleanup: Function}} Sandbox.
 */
function makeSandbox(t, options = {}) {
  const tempRoot = fs.realpathSync(os.tmpdir());
  const allocated = fs.mkdtempSync(path.join(tempRoot, "landing-hook-"));
  let cleaned = false;
  const cleanup = () => {
    if (cleaned || !fs.existsSync(allocated)) {
      cleaned = true;
      return;
    }
    const current = fs.realpathSync(allocated);
    assert.ok(
      isPathInside(tempRoot, current),
      `refusing cleanup outside canonical temp root: ${current}`,
    );
    fs.rmSync(current, { recursive: true, force: true });
    cleaned = true;
  };
  t.after(cleanup);

  try {
    const sourceRoot = fs.realpathSync(ROOT);
    const dir = fs.realpathSync(allocated);
    options.captureDir?.(dir);
    assert.ok(
      isPathInside(tempRoot, dir),
      `sandbox escaped canonical temp root: ${dir}`,
    );
    assert.equal(
      isPathInside(sourceRoot, dir),
      false,
      `sandbox landed inside the real repo: ${dir}`,
    );
    const origin = path.resolve(dir, "origin.git");
    const work = path.resolve(dir, "work");
    assert.ok(isPathInside(dir, origin), `origin escaped sandbox: ${origin}`);
    assert.ok(isPathInside(dir, work), `work escaped sandbox: ${work}`);
    if (options.failAt === "before-first-git") {
      throw new Error("injected construction failure before first git");
    }

    execFileSync("git", ["init", "--bare", "--initial-branch=main", origin], {
      stdio: "ignore",
      timeout: GIT_TIMEOUT_MS,
    });
    if (options.failAt === "between-inits") {
      throw new Error("injected construction failure between git init calls");
    }
    execFileSync("git", ["init", "--initial-branch=main", work], {
      stdio: "ignore",
      timeout: GIT_TIMEOUT_MS,
    });
    assert.ok(
      isPathInside(dir, fs.realpathSync(origin)),
      "canonical origin escaped sandbox",
    );
    assert.ok(
      isPathInside(dir, fs.realpathSync(work)),
      "canonical worktree escaped sandbox",
    );

    fs.mkdirSync(path.join(work, ".husky"), { recursive: true });
    fs.mkdirSync(path.join(work, "Tools"), { recursive: true });
    fs.copyFileSync(
      path.join(ROOT, ".husky/pre-push"),
      path.join(work, ".husky/pre-push"),
    );
    fs.copyFileSync(
      path.join(ROOT, "Tools/landing-rules.mjs"),
      path.join(work, "Tools/landing-rules.mjs"),
    );
    const driver = applyDriverMutations(
      fs.readFileSync(path.join(ROOT, "Tools/pre-push-guard.mjs"), "utf8"),
      options.driverMutations ?? [],
    );
    fs.writeFileSync(path.join(work, "Tools/pre-push-guard.mjs"), driver);
    fs.chmodSync(path.join(work, ".husky", "pre-push"), 0o755);

    const git = (args, commandOptions = {}) =>
      run("git", [...IDENTITY, ...args], {
        cwd: work,
        ...commandOptions,
      });

    assert.equal(
      git(["config", "core.hooksPath", path.join(work, ".husky")]).status,
      0,
    );
    assert.equal(git(["remote", "add", "origin", origin]).status, 0);

    const remoteUrl = git(["remote", "get-url", "origin"]);
    assert.equal(remoteUrl.status, 0, remoteUrl.output);
    assert.equal(
      fs.realpathSync(path.resolve(work, remoteUrl.output.trim())),
      fs.realpathSync(origin),
      `sandbox remote is not the canonical throwaway repo: ${remoteUrl.output}`,
    );
    if (options.failAt === "after-remote") {
      throw new Error("injected construction failure after remote setup");
    }

    let serial = 0;
    const commit = (subject, body, commitOptions = {}) => {
      serial += 1;
      fs.writeFileSync(path.join(work, "file.txt"), `${subject}\n${serial}\n`);
      const added = git(["add", "file.txt"]);
      assert.equal(added.status, 0, added.output);
      const args = ["commit", "--no-verify", "-m", subject];
      if (body !== undefined) {
        args.push("-m", body);
      }
      const committed = git(args, {
        ...commitOptions,
        env: {
          ...process.env,
          ...FIXED_COMMIT_ENV,
          ...(commitOptions.env ?? {}),
        },
      });
      assert.equal(committed.status, 0, committed.output);
      return git(["rev-parse", "HEAD"]).output.trim();
    };

    const guard = (lines, commandOptions = {}) => {
      const {
        remoteName = "origin",
        remoteLocation = origin,
        ...runOptions
      } = commandOptions;
      return run(
        process.execPath,
        ["Tools/pre-push-guard.mjs", remoteName, remoteLocation],
        {
          cwd: work,
          input: `${lines.join("\n")}\n`,
          env: { ...process.env, HOOK_EXPLAIN: "1" },
          ...runOptions,
        },
      );
    };

    return { dir, work, origin, git, commit, guard, cleanup };
  } catch (error) {
    cleanup();
    throw error;
  }
}

/**
 * Revalidate the exact local remote before any force or deletion fixture.
 *
 * @param {object} sandbox Sandbox.
 */
function assertDestructiveSandbox(sandbox) {
  const canonicalDir = fs.realpathSync(sandbox.dir);
  const canonicalOrigin = fs.realpathSync(sandbox.origin);
  const canonicalWork = fs.realpathSync(sandbox.work);
  assert.ok(isPathInside(canonicalDir, canonicalOrigin));
  assert.ok(isPathInside(canonicalDir, canonicalWork));
  const remote = sandbox.git(["remote", "get-url", "origin"]);
  assert.equal(remote.status, 0, remote.output);
  assert.equal(
    fs.realpathSync(path.resolve(canonicalWork, remote.output.trim())),
    canonicalOrigin,
  );
}

/**
 * Pin the three violation domains independently of the ambient quiet window.
 *
 * @param {string} output Guard output.
 * @param {{commit: number, ref: number, push: number}} expected Counts.
 */
function assertViolationCounts(output, expected) {
  assert.match(
    output,
    new RegExp(
      `${expected.commit} commit rule violation\\(s\\), ${expected.ref} protected-ref violation\\(s\\), ${expected.push} push rule violation\\(s\\)`,
    ),
  );
}

/**
 * Read one ref directly from the throwaway origin.
 *
 * @param {object} sandbox Sandbox.
 * @param {string} ref Ref name.
 * @returns {string|null} Object ID, or null when absent.
 */
function remoteTip(sandbox, ref) {
  const result = run(
    "git",
    ["--git-dir", sandbox.origin, "rev-parse", "--verify", ref],
    { cwd: sandbox.work },
  );
  return result.status === 0 ? result.output.trim() : null;
}

/**
 * Create a commit and branch directly in the throwaway bare remote.
 *
 * The worktree does not receive this object until it explicitly fetches, which
 * makes stale-local-state controls independent of local tracking refs.
 *
 * @param {object} sandbox Sandbox.
 * @param {string} ref New remote branch ref.
 * @param {string} subject Commit subject.
 * @param {string} body Commit body.
 * @returns {string} Remote-only commit ID.
 */
function createRemoteOnlyCommit(sandbox, ref, subject, body) {
  assertDestructiveSandbox(sandbox);
  const parent = remoteTip(sandbox, "refs/heads/main");
  assert.notEqual(parent, null, "remote main must exist first");
  const tree = run(
    "git",
    ["--git-dir", sandbox.origin, "rev-parse", `${parent}^{tree}`],
    { cwd: sandbox.work },
  );
  assert.equal(tree.status, 0, tree.output);
  const committed = run(
    "git",
    [
      ...IDENTITY,
      "--git-dir",
      sandbox.origin,
      "commit-tree",
      tree.output.trim(),
      "-p",
      parent,
      "-m",
      subject,
      "-m",
      body,
    ],
    {
      cwd: sandbox.work,
      env: { ...process.env, ...FIXED_COMMIT_ENV },
    },
  );
  assert.equal(committed.status, 0, committed.output);
  const sha = committed.output.trim();
  const updated = run(
    "git",
    ["--git-dir", sandbox.origin, "update-ref", ref, sha, ZERO_SHA1],
    { cwd: sandbox.work },
  );
  assert.equal(updated.status, 0, updated.output);
  return sha;
}

const TRAILER = "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>";
const EXPLAIN = { env: { ...process.env, HOOK_EXPLAIN: "1" } };

test("the pre-push executable and its attribute pin are byte-stable LF", () => {
  const hook = fs.readFileSync(path.join(ROOT, ".husky/pre-push"));
  const shebang = Buffer.from("#!/usr/bin/env sh\n", "utf8");
  assert.deepEqual(hook.subarray(0, shebang.length), shebang);
  assert.equal(hook.includes(0x0d), false, "pre-push contains a CR byte");
  assert.equal(hook.at(-1), 0x0a, "pre-push lacks a terminal LF");
  assert.notDeepEqual(hook.subarray(0, 3), Buffer.from([0xef, 0xbb, 0xbf]));

  const attributes = fs
    .readFileSync(path.join(ROOT, ".gitattributes"), "utf8")
    .split(/\r?\n/);
  assert.equal(
    attributes.filter((line) => line === ".husky/pre-push text eol=lf").length,
    1,
  );
  assert.equal(attributes.includes(".husky/* text eol=lf"), false);
});

test("remote advertisement accepts exact SHA-1/SHA-256 branch records", () => {
  const sha1 = "a".repeat(40);
  const sha256 = "B".repeat(64);
  assert.deepEqual(
    [...parseAdvertisedRefs(`${sha1}\trefs/heads/main\n`, 40)],
    [["refs/heads/main", sha1]],
  );
  assert.deepEqual(
    [...parseAdvertisedRefs(`${sha256}\trefs/heads/topic`, 64)],
    [["refs/heads/topic", sha256.toLowerCase()]],
  );
  assert.deepEqual([...parseAdvertisedRefs("", 40)], []);
});

test("remote advertisement rejects malformed, partial, and duplicate records", () => {
  const sha1 = "a".repeat(40);
  const sha256 = "b".repeat(64);
  for (const malformed of [
    `${sha1} refs/heads/main\n`,
    `${sha1}\trefs/heads/main\textra\n`,
    ` ${sha1}\trefs/heads/main\n`,
    `${sha1}\trefs/heads/main\r\n`,
    `${ZERO_SHA1}\trefs/heads/main\n`,
    `${"g".repeat(40)}\trefs/heads/main\n`,
    `${sha256}\trefs/heads/main\n`,
    `${sha1}\trefs/tags/main\n`,
    `${sha1}\trefs/heads/main branch\n`,
    `${sha1}\trefs/heads/main\n${sha1}\trefs/heads/main\n`,
    "\n",
  ]) {
    assert.throws(() => parseAdvertisedRefs(malformed, 40), /landing-guard:/);
  }
  assert.throws(() => parseAdvertisedRefs(`${sha1}\trefs/heads/main`, 20));
});

test("hook protocol accepts exact SHA-1/SHA-256 records and zero sentinels", () => {
  const sha1 = "a".repeat(40);
  const sha256 = "b".repeat(64);
  assert.deepEqual(
    parsePushRequests(`refs/heads/main ${sha1} refs/heads/main ${ZERO_SHA1}\n`),
    [
      {
        localRef: "refs/heads/main",
        localSha: sha1,
        remoteRef: "refs/heads/main",
        remoteSha: ZERO_SHA1,
      },
    ],
  );
  assert.equal(
    parsePushRequests(
      `refs/heads/topic ${sha256} refs/heads/main ${ZERO_SHA256}\n`,
    )[0].localSha,
    sha256,
  );
  assert.equal(
    parsePushRequests(`(delete) ${ZERO_SHA1} refs/heads/scratch ${sha1}\n`)[0]
      .localRef,
    "(delete)",
  );
});

test("hook protocol rejects malformed fields, OIDs, widths, and deletion shapes", () => {
  const sha1 = "a".repeat(40);
  const sha256 = "b".repeat(64);
  const valid = `refs/heads/main ${sha1} refs/heads/main ${ZERO_SHA1}`;
  for (const malformed of [
    "refs/heads/main a refs/heads/main",
    `${valid} ignored`,
    ` ${valid}`,
    `${valid}\n\n`,
    `refs/heads/main ${"g".repeat(40)} refs/heads/main ${ZERO_SHA1}`,
    `refs/heads/main ${"0".repeat(39)} refs/heads/main ${sha1}`,
    `refs/heads/main ${sha1} refs/heads/main ${ZERO_SHA256}`,
    `refs/heads/main ${ZERO_SHA1} refs/heads/main ${sha1}`,
    `(delete) ${sha1} refs/heads/main ${ZERO_SHA1}`,
    `(delete) ${ZERO_SHA1} refs/heads/main ${ZERO_SHA1}`,
    `refs/heads/main ${sha1} main ${ZERO_SHA1}`,
    `${valid}\nrefs/heads/topic ${sha256} refs/heads/topic ${ZERO_SHA256}`,
  ]) {
    assert.throws(() => parsePushRequests(malformed), /landing-guard:/);
  }
});

test("EAGAIN and every stdin read error reach fail-closed exit 2", () => {
  const error = Object.assign(new Error("temporarily unavailable"), {
    code: "EAGAIN",
  });
  const readOptions = {
    stdin: { isTTY: false },
    readFileSync() {
      throw error;
    },
  };
  assert.throws(
    () => readPushRequests(readOptions),
    (thrown) => thrown === error,
  );
  let output = "";
  const status = runCli({
    argv: [process.execPath, "pre-push-guard.mjs", "origin"],
    env: {},
    readOptions,
    stderr: { write: (value) => (output += value) },
  });
  assert.equal(status, 2);
  assert.match(output, /FAILED TO RUN/);
  assert.match(output, /temporarily unavailable/);
  assert.match(output, /fail-closed/);
});

test("nonempty hook input without the actual remote location fails closed", () => {
  const sha1 = "a".repeat(40);
  let output = "";
  const status = runCli({
    argv: [process.execPath, "pre-push-guard.mjs", "origin"],
    env: {},
    readOptions: {
      stdin: { isTTY: false },
      readFileSync: () =>
        `refs/heads/main ${sha1} refs/heads/main ${ZERO_SHA1}\n`,
    },
    stderr: { write: (value) => (output += value) },
  });
  assert.equal(status, 2);
  assert.match(output, /actual remote location/);
  assert.doesNotMatch(output, /governed commit\(s\)/);
});

test("malformed hook input is rejected before Git is available", (t) => {
  const noGitPath = fs.mkdtempSync(path.join(os.tmpdir(), "landing-no-git-"));
  t.after(() => fs.rmSync(noGitPath, { recursive: true, force: true }));
  const result = run(
    process.execPath,
    [path.join(ROOT, "Tools/pre-push-guard.mjs"), "origin"],
    {
      cwd: ROOT,
      input: "refs/heads/main abc refs/heads/main\n",
      env: { ...process.env, PATH: noGitPath, HOOK_EXPLAIN: "1" },
    },
  );
  assert.equal(result.status, 2, result.output);
  assert.match(result.output, /expected exactly four nonempty fields/);
  assert.doesNotMatch(result.output, /spawnSync git|ENOENT/);
});

test("path containment uses components rather than lexical prefixes", () => {
  const root = path.resolve(os.tmpdir(), "landing-prefix");
  assert.equal(isPathInside(root, path.join(root, "child")), true);
  assert.equal(isPathInside(root, `${root}-sibling`), false);
  assert.equal(isPathInside(root, root), false);
  assert.equal(isPathInside(root, path.dirname(root)), false);
});

test("fixture cleanup is registered before a throwing capture callback", () => {
  let registeredCleanup;
  let capturedDirectory;
  let registered = false;
  const injected = new Error("injected capture callback failure");
  const context = {
    after(callback) {
      registered = true;
      registeredCleanup = callback;
    },
  };

  assert.throws(
    () =>
      makeSandbox(context, {
        captureDir(directory) {
          capturedDirectory = directory;
          assert.equal(registered, true);
          throw injected;
        },
      }),
    (error) => error === injected,
  );
  assert.equal(fs.existsSync(capturedDirectory), false);
  assert.doesNotThrow(() => registeredCleanup());
});

test(
  "fixture construction failures clean their canonical temp directory",
  { skip: hasGit() ? false : "git unavailable" },
  async (t) => {
    for (const stage of ["before-first-git", "between-inits", "after-remote"]) {
      await t.test(stage, (t) => {
        let directory;
        assert.throws(
          () =>
            makeSandbox(t, {
              failAt: stage,
              captureDir: (value) => (directory = value),
            }),
          /injected construction failure/,
        );
        assert.equal(fs.existsSync(directory), false);
      });
    }
  },
);

test(
  "pre-push hook end-to-end",
  { skip: hasGit() ? false : "git unavailable" },
  async (t) => {
    const sandbox = makeSandbox(t);

    // Whether a compliant push is allowed depends on the wall clock, which is
    // the point of the rule. The window maths is pinned against fixed instants
    // in landing-rules.spec.mjs; here the expectation is derived from the same
    // predicate so the suite is green at any hour without a bypass existing.
    const inWindow = isQuietHours(new Date());

    await t.test(
      "a first protected-main push has exact independent counts",
      () => {
        const head = sandbox.commit(
          "Batch 1: the sandbox commit",
          `What landed and what it discharges.\n\n${TRAILER}`,
        );
        const push = sandbox.git(["push", "origin", "main"], EXPLAIN);
        assert.match(push.output, /landing-guard:/);
        assertViolationCounts(push.output, { commit: 0, ref: 0, push: 0 });
        assert.match(push.output, /ok\s+batch-prefix/);
        assert.match(push.output, /ok\s+body/);
        assert.match(push.output, /ok\s+co-author-trailer/);
        assert.match(push.output, /ok\s+protected-ref/);
        if (inWindow) {
          assert.equal(push.status, 1, push.output);
          assert.match(push.output, /quiet-hours.*07:00-19:00 US Eastern/s);
          const seeded = sandbox.git(["push", "--no-verify", "origin", "main"]);
          assert.equal(seeded.status, 0, seeded.output);
        } else {
          assert.equal(push.status, 0, push.output);
        }
        assert.equal(remoteTip(sandbox, "refs/heads/main"), head);
      },
    );

    await t.test(
      "a nonzero-old-SHA fast-forward with an actual lease passes rule f",
      () => {
        const oldMain = remoteTip(sandbox, "refs/heads/main");
        const head = sandbox.commit(
          "Batch 2: the existing main update",
          `Advances an existing protected destination.\n\n${TRAILER}`,
        );
        const args = [
          "push",
          `--force-with-lease=refs/heads/main:${oldMain}`,
          "origin",
          "refs/heads/main:refs/heads/main",
        ];
        const push = sandbox.git(args, EXPLAIN);
        assertViolationCounts(push.output, { commit: 0, ref: 0, push: 0 });
        assert.match(push.output, /ok\s+protected-ref/);
        assert.match(push.output, /refs\/heads\/main -> refs\/heads\/main/);
        if (inWindow) {
          assert.equal(push.status, 1, push.output);
          const seeded = sandbox.git([
            "push",
            "--no-verify",
            `--force-with-lease=refs/heads/main:${oldMain}`,
            "origin",
            "refs/heads/main:refs/heads/main",
          ]);
          assert.equal(seeded.status, 0, seeded.output);
        } else {
          assert.equal(push.status, 0, push.output);
        }
        assert.equal(remoteTip(sandbox, "refs/heads/main"), head);
      },
    );

    await t.test("source topic maps to protected destination main", () => {
      assert.equal(sandbox.git(["switch", "-c", "topic"]).status, 0);
      const oldMain = remoteTip(sandbox, "refs/heads/main");
      const topic = sandbox.commit(
        "Batch 3: mapped source update",
        `Proves destination-ref protection.\n\n${TRAILER}`,
      );
      const args = [
        "push",
        `--force-with-lease=refs/heads/main:${oldMain}`,
        "origin",
        "refs/heads/topic:refs/heads/main",
      ];
      const push = sandbox.git(args, EXPLAIN);
      assertViolationCounts(push.output, { commit: 0, ref: 0, push: 0 });
      assert.match(push.output, /refs\/heads\/topic -> refs\/heads\/main/);
      assert.match(push.output, /ok\s+protected-ref/);
      if (inWindow) {
        assert.equal(push.status, 1, push.output);
        assert.equal(
          sandbox.git(["push", "--no-verify", ...args.slice(1)]).status,
          0,
        );
      } else {
        assert.equal(push.status, 0, push.output);
      }
      assert.equal(remoteTip(sandbox, "refs/heads/main"), topic);
      assert.equal(sandbox.git(["switch", "main"]).status, 0);
      assert.equal(sandbox.git(["reset", "--hard", "topic"]).status, 0);
    });

    await t.test("a non-compliant commit has exactly three commit reds", () => {
      sandbox.commit("Harden custom ellipsoid certification");
      const push = sandbox.git(["push", "origin", "main"], EXPLAIN);
      assert.notEqual(push.status, 0);
      assertViolationCounts(push.output, { commit: 3, ref: 0, push: 0 });
      assert.match(push.output, /FAIL\s+batch-prefix/);
      assert.match(push.output, /FAIL\s+body/);
      assert.match(push.output, /FAIL\s+co-author-trailer/);
    });

    await t.test(
      "--no-verify bypasses the hook and only commit rules remain detectable later",
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
        const seeded = sandbox.git(["push", "--no-verify", "origin", "main"]);
        assert.equal(seeded.status, 0, seeded.output);
      },
    );

    await t.test("a fixed in-window commit has exactly one commit red", () => {
      sandbox.commit(
        "Batch 4: timestamp control",
        `Pins commit-time enforcement.\n\n${TRAILER}`,
        {
          env: {
            GIT_AUTHOR_DATE: "2026-08-12T11:00:00-04:00",
            GIT_COMMITTER_DATE: "2026-08-12T11:00:00-04:00",
          },
        },
      );
      const push = sandbox.git(["push", "origin", "main"], EXPLAIN);
      assert.equal(push.status, 1, push.output);
      assertViolationCounts(push.output, { commit: 1, ref: 0, push: 0 });
      assert.match(push.output, /FAIL\s+commit-quiet-hours/);
      const seeded = sandbox.git(["push", "--no-verify", "origin", "main"]);
      assert.equal(seeded.status, 0, seeded.output);
    });

    await t.test(
      "an actual matching-lease rewrite from topic to main is refused",
      () => {
        assertDestructiveSandbox(sandbox);
        const saved = sandbox.git(["rev-parse", "HEAD"]);
        assert.equal(saved.status, 0, saved.output);
        const oldMain = remoteTip(sandbox, "refs/heads/main");
        assert.equal(
          sandbox.git(["switch", "-c", "rewrite-topic", `${oldMain}~1`]).status,
          0,
        );
        sandbox.commit(
          "Batch 9000: a rewritten replacement",
          `Replaces commits that were already pushed.\n\n${TRAILER}`,
        );
        const push = sandbox.git(
          [
            "push",
            `--force-with-lease=refs/heads/main:${oldMain}`,
            "origin",
            "refs/heads/rewrite-topic:refs/heads/main",
          ],
          EXPLAIN,
        );
        assert.equal(push.status, 1, push.output);
        assertViolationCounts(push.output, { commit: 0, ref: 1, push: 0 });
        assert.match(push.output, /FAIL\s+protected-ref/);
        assert.match(push.output, /history rewrite/);
        assert.match(
          push.output,
          /refs\/heads\/rewrite-topic -> refs\/heads\/main/,
        );
        assert.equal(remoteTip(sandbox, "refs/heads/main"), oldMain);
        assert.equal(sandbox.git(["switch", "main"]).status, 0);
        assert.equal(
          sandbox.git(["reset", "--hard", saved.output.trim()]).status,
          0,
        );
      },
    );

    await t.test("(f) deleting main on the remote is refused", () => {
      assertDestructiveSandbox(sandbox);
      const before = remoteTip(sandbox, "refs/heads/main");
      const deleted = sandbox.git(
        ["push", "origin", "--delete", "main"],
        EXPLAIN,
      );
      assert.equal(deleted.status, 1, deleted.output);
      assertViolationCounts(deleted.output, { commit: 0, ref: 1, push: 0 });
      assert.match(deleted.output, /PUSH REFUSED/);
      assert.match(deleted.output, /FAIL\s+protected-ref/);
      assert.match(deleted.output, /delet/);
      assert.equal(remoteTip(sandbox, "refs/heads/main"), before);
    });

    await t.test(
      "(f) a scratch-branch deletion passes the ref rule (quiet hours still govern it)",
      () => {
        assertDestructiveSandbox(sandbox);
        sandbox.git(["branch", "scratch"]);
        const pushed = sandbox.git([
          "push",
          "--no-verify",
          "origin",
          "scratch",
        ]);
        assert.equal(pushed.status, 0, pushed.output);
        const deleted = sandbox.git(
          ["push", "origin", "--delete", "scratch"],
          EXPLAIN,
        );
        assert.match(deleted.output, /--\s+protected-ref/);
        assert.match(deleted.output, /not a protected branch/);
        assertViolationCounts(deleted.output, { commit: 0, ref: 0, push: 0 });
        // No commit rules apply to a deletion, but a deletion is visible
        // remote activity, so the quiet-hours window still governs it.
        if (inWindow) {
          assert.equal(deleted.status, 1, deleted.output);
          assert.match(deleted.output, /quiet-hours/);
          assert.notEqual(remoteTip(sandbox, "refs/heads/scratch"), null);
        } else {
          assert.equal(deleted.status, 0, deleted.output);
          assert.equal(remoteTip(sandbox, "refs/heads/scratch"), null);
        }
      },
    );
  },
);

test(
  "multi-ref pushes use a global Batch baseline and deduplicate shared SHAs",
  { skip: hasGit() ? false : "git unavailable" },
  async (t) => {
    const sandbox = makeSandbox(t);
    const base = sandbox.commit(
      "Batch 10: remote baseline",
      `Seeds the global remote baseline.\n\n${TRAILER}`,
    );
    assert.equal(
      sandbox.git(["push", "--no-verify", "origin", "main"]).status,
      0,
    );
    assert.equal(sandbox.git(["fetch", "origin"]).status, 0);

    assert.equal(sandbox.git(["switch", "-c", "one", base]).status, 0);
    const one = sandbox.commit(
      "Batch 11: first branch",
      `First distinct branch.\n\n${TRAILER}`,
    );
    assert.equal(sandbox.git(["switch", "-c", "two", base]).status, 0);
    const two = sandbox.commit(
      "Batch 11: second branch",
      `Second distinct branch.\n\n${TRAILER}`,
    );

    await t.test("distinct commits with one Batch produce one push red", () => {
      const result = sandbox.guard([
        `refs/heads/one ${one} refs/heads/one ${ZERO_SHA1}`,
        `refs/heads/two ${two} refs/heads/two ${ZERO_SHA1}`,
      ]);
      assert.equal(result.status, 1, result.output);
      assertViolationCounts(result.output, { commit: 0, ref: 0, push: 1 });
      assert.match(result.output, /FAIL\s+batch-unique/);
    });

    await t.test("one SHA sent to two refs is evaluated exactly once", () => {
      const result = sandbox.guard([
        `refs/heads/one ${one} refs/heads/one ${ZERO_SHA1}`,
        `refs/heads/one ${one} refs/heads/alias ${ZERO_SHA1}`,
      ]);
      assertViolationCounts(result.output, { commit: 0, ref: 0, push: 0 });
      assert.match(result.output, /landing-guard: 1 governed commit\(s\)/);
      assert.match(result.output, /refs\/heads\/alias: 0 distinct commit\(s\)/);
    });

    await t.test("legal divergent values are input-order independent", () => {
      assert.equal(sandbox.git(["switch", "-c", "three", base]).status, 0);
      const three = sandbox.commit(
        "Batch 12: third branch",
        `Distinct legal value.\n\n${TRAILER}`,
      );
      for (const lines of [
        [
          `refs/heads/one ${one} refs/heads/one ${ZERO_SHA1}`,
          `refs/heads/three ${three} refs/heads/three ${ZERO_SHA1}`,
        ],
        [
          `refs/heads/three ${three} refs/heads/three ${ZERO_SHA1}`,
          `refs/heads/one ${one} refs/heads/one ${ZERO_SHA1}`,
        ],
      ]) {
        assertViolationCounts(sandbox.guard(lines).output, {
          commit: 0,
          ref: 0,
          push: 0,
        });
      }
    });

    await t.test(
      "another remote ref supplies the global landed baseline",
      () => {
        const tree = sandbox.git(["rev-parse", `${base}^{tree}`]);
        assert.equal(tree.status, 0, tree.output);
        const low = sandbox.git(
          [
            "commit-tree",
            tree.output.trim(),
            "-m",
            "Batch 2: independent low branch",
            "-m",
            `Must not reuse the global range.\n\n${TRAILER}`,
          ],
          { env: { ...process.env, ...FIXED_COMMIT_ENV } },
        );
        assert.equal(low.status, 0, low.output);
        const result = sandbox.guard([
          `refs/heads/low ${low.output.trim()} refs/heads/low ${ZERO_SHA1}`,
        ]);
        assertViolationCounts(result.output, { commit: 1, ref: 0, push: 0 });
        assert.match(result.output, /FAIL\s+batch-monotonic/);
      },
    );
  },
);

test(
  "missing objects and stale negotiations fail atomically with specific guidance",
  { skip: hasGit() ? false : "git unavailable" },
  (t) => {
    const sandbox = makeSandbox(t);
    const head = sandbox.commit(
      "Batch 1: local object control",
      `Creates one inspectable source.\n\n${TRAILER}`,
    );
    const missing = "f".repeat(40);
    for (const { lines, guidance } of [
      {
        lines: [`refs/heads/missing ${missing} refs/heads/new ${ZERO_SHA1}`],
        guidance: /fetch first|repair the local source/,
      },
      {
        lines: [`refs/heads/main ${head} refs/heads/main ${missing}`],
        guidance: /fresh negotiation/,
      },
      {
        lines: [
          `refs/heads/main ${head} refs/heads/new ${ZERO_SHA1}`,
          `refs/heads/missing ${missing} refs/heads/other ${ZERO_SHA1}`,
        ],
        guidance: /fetch first|repair the local source/,
      },
    ]) {
      const result = sandbox.guard(lines);
      assert.equal(result.status, 2, result.output);
      assert.match(result.output, guidance);
      assert.doesNotMatch(result.output, /governed commit\(s\) pass/);
    }
  },
);

test(
  "remote advertisements, not local tracking refs, define the Batch baseline",
  { skip: hasGit() ? false : "git unavailable" },
  (t) => {
    const sandbox = makeSandbox(t);
    const base = sandbox.commit(
      "Batch 10: remote baseline",
      `Seeds main before the unseen branch.\n\n${TRAILER}`,
    );
    assert.equal(
      sandbox.git(["push", "--no-verify", "origin", "main"]).status,
      0,
    );
    createRemoteOnlyCommit(
      sandbox,
      "refs/heads/unfetched",
      "Batch 50: authoritative remote maximum",
      `Exists only in the bare remote.\n\n${TRAILER}`,
    );

    assert.equal(sandbox.git(["switch", "-c", "topic", base]).status, 0);
    const topic = sandbox.commit(
      "Batch 11: stale local candidate",
      `Must compare against every advertised head.\n\n${TRAILER}`,
    );
    const line = `refs/heads/topic ${topic} refs/heads/topic ${ZERO_SHA1}`;
    const stale = sandbox.guard([line], {
      remoteName: "display-name-that-is-not-configured",
    });
    assert.equal(stale.status, 2, stale.output);
    assert.match(stale.output, /advertised remote branch.*fetch first/s);
    assert.doesNotMatch(stale.output, /governed commit\(s\)/);

    const fetched = sandbox.git([
      "fetch",
      "origin",
      "refs/heads/unfetched:refs/remotes/origin/unfetched",
    ]);
    assert.equal(fetched.status, 0, fetched.output);
    const inspected = sandbox.guard([line], {
      remoteName: "display-name-that-is-not-configured",
    });
    assert.equal(inspected.status, 1, inspected.output);
    assertViolationCounts(inspected.output, { commit: 1, ref: 0, push: 0 });
    assert.match(inspected.output, /FAIL\s+batch-monotonic/);
    assert.match(inspected.output, /highest already-landed batch 50/);
  },
);

test(
  "mixed delete and create requests are atomic in both input orders",
  { skip: hasGit() ? false : "git unavailable" },
  async (t) => {
    await t.test("inspectable old destination evaluates identically", (t) => {
      const sandbox = makeSandbox(t);
      const base = sandbox.commit(
        "Batch 10: mixed baseline",
        `Seeds the deletion destination.\n\n${TRAILER}`,
      );
      assert.equal(
        sandbox.git(["push", "--no-verify", "origin", "main"]).status,
        0,
      );
      assert.equal(
        sandbox.git([
          "push",
          "--no-verify",
          "origin",
          "main:refs/heads/scratch",
        ]).status,
        0,
      );
      assert.equal(sandbox.git(["switch", "-c", "topic", base]).status, 0);
      const topic = sandbox.commit(
        "Batch 11: mixed creation",
        `Pairs with an inspectable deletion.\n\n${TRAILER}`,
      );
      const deletion = `(delete) ${ZERO_SHA1} refs/heads/scratch ${base}`;
      const creation = `refs/heads/topic ${topic} refs/heads/topic ${ZERO_SHA1}`;
      const statuses = [];
      for (const lines of [
        [deletion, creation],
        [creation, deletion],
      ]) {
        const result = sandbox.guard(lines);
        statuses.push(result.status);
        assertViolationCounts(result.output, { commit: 0, ref: 0, push: 0 });
        assert.doesNotMatch(result.output, /FAILED TO RUN/);
      }
      assert.equal(statuses[0], statuses[1]);
    });

    await t.test("a missing deleted-old object blocks both orders", (t) => {
      const sandbox = makeSandbox(t);
      const base = sandbox.commit(
        "Batch 10: missing-object baseline",
        `Seeds main before the remote-only destination.\n\n${TRAILER}`,
      );
      assert.equal(
        sandbox.git(["push", "--no-verify", "origin", "main"]).status,
        0,
      );
      const remoteOnly = createRemoteOnlyCommit(
        sandbox,
        "refs/heads/scratch",
        "Batch 12: remote-only deletion target",
        `Remains absent from the pushing worktree.\n\n${TRAILER}`,
      );
      assert.equal(sandbox.git(["switch", "-c", "topic", base]).status, 0);
      const topic = sandbox.commit(
        "Batch 11: blocked mixed creation",
        `Must not be evaluated before full preflight.\n\n${TRAILER}`,
      );
      const deletion = `(delete) ${ZERO_SHA1} refs/heads/scratch ${remoteOnly}`;
      const creation = `refs/heads/topic ${topic} refs/heads/topic ${ZERO_SHA1}`;
      for (const lines of [
        [deletion, creation],
        [creation, deletion],
      ]) {
        const result = sandbox.guard(lines);
        assert.equal(result.status, 2, result.output);
        assert.match(
          result.output,
          /destination refs\/heads\/scratch.*fetch first/s,
        );
        assert.doesNotMatch(result.output, /governed commit\(s\)|PUSH REFUSED/);
      }
    });
  },
);

test(
  "source-level driver mutants are observed by the exact behavioral oracles",
  { skip: hasGit() ? false : "git unavailable" },
  async (t) => {
    await t.test("fast-forward classified as rewrite", (t) => {
      const sandbox = makeSandbox(t, {
        driverMutations: [
          {
            find: 'return "fast-forward";',
            replace: 'return "rewrite";',
          },
        ],
      });
      sandbox.commit("Batch 1: baseline", `Seeds main.\n\n${TRAILER}`);
      assert.equal(
        sandbox.git(["push", "--no-verify", "origin", "main"]).status,
        0,
      );
      const oldMain = remoteTip(sandbox, "refs/heads/main");
      sandbox.commit(
        "Batch 2: real fast-forward",
        `Advances main without discarding history.\n\n${TRAILER}`,
      );
      const result = sandbox.git(
        [
          "push",
          `--force-with-lease=refs/heads/main:${oldMain}`,
          "origin",
          "main:main",
        ],
        EXPLAIN,
      );
      assertViolationCounts(result.output, { commit: 0, ref: 1, push: 0 });
      assert.equal(remoteTip(sandbox, "refs/heads/main"), oldMain);
    });

    await t.test("commit quiet-hours call disabled", (t) => {
      const sandbox = makeSandbox(t, {
        driverMutations: [
          {
            find: "includeCommitQuietHours: true,",
            replace: "includeCommitQuietHours: false,",
          },
        ],
      });
      sandbox.commit(
        "Batch 1: in-window mutant",
        `Must be caught by the normal driver.\n\n${TRAILER}`,
        {
          env: {
            GIT_AUTHOR_DATE: "2026-08-12T11:00:00-04:00",
            GIT_COMMITTER_DATE: "2026-08-12T11:00:00-04:00",
          },
        },
      );
      const result = sandbox.git(["push", "origin", "main"], EXPLAIN);
      assertViolationCounts(result.output, { commit: 0, ref: 0, push: 0 });
      assert.doesNotMatch(result.output, /FAIL\s+commit-quiet-hours/);
    });

    await t.test("source ref substituted for destination ref", (t) => {
      const sandbox = makeSandbox(t, {
        driverMutations: [
          {
            find: "remoteRef: request.remoteRef,",
            replace: "remoteRef: request.localRef,",
          },
        ],
      });
      const base = sandbox.commit(
        "Batch 1: destination baseline",
        `Seeds protected main.\n\n${TRAILER}`,
      );
      assert.equal(
        sandbox.git(["push", "--no-verify", "origin", "main"]).status,
        0,
      );
      const tree = sandbox.git(["rev-parse", `${base}^{tree}`]);
      const replacement = sandbox.git(
        [
          "commit-tree",
          tree.output.trim(),
          "-m",
          "Batch 9000: mapped rewrite",
          "-m",
          `Would rewrite destination main.\n\n${TRAILER}`,
        ],
        { env: { ...process.env, ...FIXED_COMMIT_ENV } },
      );
      const result = sandbox.guard([
        `refs/heads/topic ${replacement.output.trim()} refs/heads/main ${base}`,
      ]);
      assertViolationCounts(result.output, { commit: 0, ref: 0, push: 0 });
      assert.match(result.output, /--\s+protected-ref/);
    });
  },
);
