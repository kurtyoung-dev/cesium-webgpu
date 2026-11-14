// wave-end-source-tuple.spec.mjs — the wave-end gate's source tuple, asserted
// over real throwaway git repositories. Pure Node plus the `git` binary; every
// repository lives under a lane temp root and is removed with it.
// @purpose Pins KIT-5A (d): the source identity is stable on an unchanged tree and moves when a tracked file changes, an untracked file is added at the top level or INSIDE a new untracked directory, a tracked file is deleted or renamed, or HEAD moves, and does not move for an ignored file; the three printed values pass the gate's own argument validator; the tool is read-only; a gitlink is refused by name; a non-repository refuses (exit 3) and an unknown flag exits 2.
// @status ACTIVE
//
// The assertions are groups over a module namespace. The live tests run each
// group over the real tool; the mutant tests run the same group over a copy of
// the tool with the clause under test made unreachable and require it to fail.
// Each mutation anchor must occur exactly once in the source.
//
// The throwaway repositories use a placeholder author identity passed as `-c`
// options on every git call; nothing is read from or written to any git config
// and the tool under test never reads or prints author identity.
//
// Run: node --test Tools/wave-end-source-tuple.spec.mjs

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { withLaneTmp } from "./lib/lane-tmp.mjs";
import { importMutated } from "./visual-regression/lib/import-mutated.mjs";
import * as realTool from "./wave-end-source-tuple.mjs";
import { decideArgumentRefusal, parseArgs } from "./wave-end-gate-binding.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TOOL_PATH = path.join(HERE, "wave-end-source-tuple.mjs");

// ---------------------------------------------------------------------------
// Throwaway repository helpers
// ---------------------------------------------------------------------------

/** Run git against `repo`; returns stdout as text. */
function git(repo, ...args) {
  return execFileSync(
    "git",
    [
      "-C",
      repo,
      "-c",
      "user.name=spec",
      "-c",
      "user.email=spec@example.invalid",
      "-c",
      "commit.gpgsign=false",
      "-c",
      "core.autocrlf=false",
      ...args,
    ],
    { stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" },
  );
}

/** A repository with a few tracked files, an ignore rule and one commit. */
function makeRepo(root) {
  const repo = path.join(root, "repo");
  fs.mkdirSync(repo, { recursive: true });
  git(repo, "init", "-q");
  fs.writeFileSync(path.join(repo, ".gitignore"), "ignored.log\n");
  fs.writeFileSync(path.join(repo, "a.txt"), "alpha\n");
  fs.mkdirSync(path.join(repo, "dir"));
  fs.writeFileSync(path.join(repo, "dir", "b.txt"), "bravo\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "initial");
  return repo;
}

const write = (repo, relative, text) => {
  const file = path.join(repo, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
};

/** Back to the committed, clean tree (ignored files removed too). */
function resetRepo(repo) {
  git(repo, "reset", "-q", "--hard", "HEAD");
  git(repo, "clean", "-fdxq");
}

/** Run `main` with captured streams. */
function runMain(api, argv) {
  let stdout = "";
  let stderr = "";
  const code = api.main(argv, {
    stdout: { write: (chunk) => (stdout += chunk) },
    stderr: { write: (chunk) => (stderr += chunk) },
  });
  return { code, stdout, stderr };
}

// ---------------------------------------------------------------------------
// Groups
// ---------------------------------------------------------------------------

/** (d) What moves the identity and what does not. */
async function identityGroup(api) {
  await withLaneTmp("source-tuple-identity-", (root) => {
    const repo = makeRepo(root);
    const tupleOf = () => api.computeSourceTuple({ repo });
    const base = tupleOf();
    assert.equal(base.sourceCommit, git(repo, "rev-parse", "HEAD").trim());
    assert.match(base.sourceIdentity, /^[0-9a-f]{64}$/);
    assert.equal(base.sourceDirty, false, "a clean tree is not dirty");
    assert.equal(
      tupleOf().sourceIdentity,
      base.sourceIdentity,
      "stable over two calls",
    );

    const moves = (label, change) => {
      change();
      const tuple = tupleOf();
      assert.notEqual(
        tuple.sourceIdentity,
        base.sourceIdentity,
        `${label}: the identity moved`,
      );
      return tuple;
    };

    // A tracked file's content changes, and changes back.
    let tuple = moves("a tracked file's content changes", () =>
      write(repo, "a.txt", "alpha changed\n"),
    );
    assert.equal(tuple.sourceDirty, true, "a changed tree is dirty");
    write(repo, "a.txt", "alpha\n");
    assert.equal(
      tupleOf().sourceIdentity,
      base.sourceIdentity,
      "restoring the bytes restores the identity",
    );
    assert.equal(tupleOf().sourceDirty, false);
    resetRepo(repo);

    // An untracked top-level file is added.
    tuple = moves("an untracked top-level file is added", () =>
      write(repo, "new.txt", "new\n"),
    );
    assert.equal(tuple.sourceDirty, true);
    const withTopLevel = tuple.sourceIdentity;
    write(repo, "new.txt", "new, edited\n");
    assert.notEqual(
      tupleOf().sourceIdentity,
      withTopLevel,
      "an untracked file's content counts",
    );
    resetRepo(repo);

    // A file is added INSIDE a new untracked directory (the case plain
    // --porcelain collapses to one `?? dir/` entry).
    tuple = moves("a file is added inside a new untracked directory", () =>
      write(repo, "fresh/one.txt", "one\n"),
    );
    assert.equal(tuple.sourceDirty, true);
    const oneFile = tuple.sourceIdentity;
    write(repo, "fresh/two.txt", "two\n");
    const twoFiles = tupleOf().sourceIdentity;
    assert.notEqual(
      twoFiles,
      oneFile,
      "a SECOND file inside the same new directory moves it again",
    );
    write(repo, "fresh/two.txt", "two, edited\n");
    assert.notEqual(
      tupleOf().sourceIdentity,
      twoFiles,
      "editing a file inside it moves it again",
    );
    resetRepo(repo);

    // Paths git would quote in plain porcelain: spaces and non-ASCII.
    moves("a file with a space and non-ASCII in a new directory", () =>
      write(repo, "dir with space/ünï cödé.txt", "spaced\n"),
    );
    resetRepo(repo);

    // A tracked file is deleted (worktree), or deleted and staged.
    tuple = moves("a tracked file is deleted", () =>
      fs.rmSync(path.join(repo, "a.txt")),
    );
    assert.equal(tuple.sourceDirty, true);
    const deletedInWorktree = tuple.sourceIdentity;
    resetRepo(repo);
    moves("a tracked file is deleted and staged", () =>
      git(repo, "rm", "-q", "a.txt"),
    );
    resetRepo(repo);
    assert.notEqual(deletedInWorktree, base.sourceIdentity);

    // A tracked file is renamed (staged `git mv`); a rename is two paths: the
    // old one is a deletion. Copying the file (old path untouched) must not
    // read the same.
    tuple = moves("a tracked file is renamed", () =>
      git(repo, "mv", "a.txt", "c.txt"),
    );
    const renamed = tuple.sourceIdentity;
    resetRepo(repo);
    write(repo, "c.txt", "alpha\n");
    const copied = tupleOf().sourceIdentity;
    assert.notEqual(
      renamed,
      copied,
      "a rename (old path gone) and a copy (old path kept) are different trees",
    );
    resetRepo(repo);

    // HEAD moves with the tree clean.
    git(repo, "commit", "-q", "--allow-empty", "-m", "moves HEAD");
    const moved = tupleOf();
    assert.equal(moved.sourceDirty, false);
    assert.notEqual(moved.sourceCommit, base.sourceCommit);
    assert.notEqual(
      moved.sourceIdentity,
      base.sourceIdentity,
      "HEAD moving moves the identity",
    );
    const afterMove = moved.sourceIdentity;
    resetRepo(repo);

    // An ignored file changes nothing.
    write(repo, "ignored.log", "noise\n");
    assert.equal(
      tupleOf().sourceIdentity,
      afterMove,
      "an ignored file does not move the identity",
    );
    assert.equal(
      tupleOf().sourceDirty,
      false,
      "an ignored file does not make the tree dirty",
    );
    write(repo, "ignored.log", "more noise\n");
    assert.equal(tupleOf().sourceIdentity, afterMove);
  });
}

/** (d) The printed line is the gate's own validator's input, and refusals exit. */
async function gateGroup(api) {
  await withLaneTmp("source-tuple-gate-", (root) => {
    const repo = makeRepo(root);
    const accepted = (line) =>
      decideArgumentRefusal(
        parseArgs(["--wave", "kit-5a-spec", ...line.trim().split(" ")]),
      );

    for (const dirty of [false, true]) {
      if (dirty) {
        write(repo, "stray.txt", "stray\n");
      }
      const { code, stdout, stderr } = runMain(api, ["--repo", repo]);
      assert.equal(code, 0, stderr);
      assert.match(
        stdout,
        /^--source-commit [0-9a-f]{40} --source-dirty (true|false) --source-identity [0-9a-f]{64}\n$/,
      );
      assert.equal(
        stdout.includes(`--source-dirty ${dirty}`),
        true,
        "the dirty flag is honest",
      );
      assert.equal(
        accepted(stdout),
        null,
        "the gate's own validator accepts the printed tuple",
      );
      const tuple = api.computeSourceTuple({ repo });
      assert.equal(
        stdout.trim(),
        `--source-commit ${tuple.sourceCommit} --source-dirty ${tuple.sourceDirty} --source-identity ${tuple.sourceIdentity}`,
      );
    }

    const json = runMain(api, ["--repo", repo, "--json"]);
    assert.equal(json.code, 0);
    const parsed = JSON.parse(json.stdout);
    const tuple = api.computeSourceTuple({ repo });
    assert.equal(parsed.sourceCommit, tuple.sourceCommit);
    assert.equal(parsed.sourceDirty, true);
    assert.equal(parsed.sourceIdentity, tuple.sourceIdentity);

    // A directory that is not a repository refuses, exit 3, by name.
    const bare = path.join(root, "not-a-repo");
    fs.mkdirSync(bare);
    const refused = runMain(api, ["--repo", bare]);
    assert.equal(refused.code, 3);
    assert.match(refused.stderr, /REFUSED \(source-not-a-repository\)/);
    assert.equal(refused.stdout, "", "a refusal prints no tuple");

    // An unknown flag is a usage error.
    const usage = runMain(api, ["--repo", repo, "--bogus"]);
    assert.equal(usage.code, 2);
    assert.equal(usage.stdout, "");
  });
}

/** (d) A gitlink (a nested repository) is refused by name, never digested. */
async function gitlinkGroup(api) {
  await withLaneTmp("source-tuple-gitlink-", (root) => {
    const repo = makeRepo(root);
    const sub = path.join(repo, "sub");
    fs.mkdirSync(sub);
    git(sub, "init", "-q");
    write(sub, "inner.txt", "inner\n");
    git(sub, "add", "-A");
    git(sub, "commit", "-q", "-m", "inner");
    git(repo, "add", "sub");

    assert.throws(
      () => api.computeSourceTuple({ repo }),
      (error) => {
        assert.ok(error instanceof api.SourceTupleRefusal, String(error));
        assert.equal(error.reason, "source-entry-is-directory");
        assert.equal(error.details.path, "sub");
        return true;
      },
    );
    const { code, stdout, stderr } = runMain(api, ["--repo", repo]);
    assert.equal(code, 3);
    assert.match(stderr, /REFUSED \(source-entry-is-directory\)/);
    assert.equal(stdout, "");
  });
}

/** (d) Read-only: the repository's status, index bytes and .git listing are untouched. */
async function readOnlyGroup(api) {
  await withLaneTmp("source-tuple-readonly-", (root) => {
    const repo = makeRepo(root);
    write(repo, "untracked/deep/file.txt", "u\n");
    write(repo, "a.txt", "alpha edited\n");
    // Make the index stat-stale for a file whose content is unchanged, so a
    // git that refreshes the index opportunistically would rewrite it.
    const future = new Date(Date.now() + 60_000);
    fs.utimesSync(path.join(repo, "dir", "b.txt"), future, future);

    const snapshot = () => ({
      porcelain: git(
        repo,
        "--no-optional-locks",
        "status",
        "--porcelain=v1",
        "-z",
        "--untracked-files=all",
      ),
      index: createHash("sha256")
        .update(fs.readFileSync(path.join(repo, ".git", "index")))
        .digest("hex"),
      gitDir: fs.readdirSync(path.join(repo, ".git")).sort(),
    });
    const before = snapshot();
    api.computeSourceTuple({ repo });
    runMain(api, ["--repo", repo]);
    assert.deepEqual(
      snapshot(),
      before,
      "a call left the repository exactly as it found it",
    );
  });
}

/** (d) Symlinks digest as their link text; skipped visibly where creating one is not permitted. */
async function symlinkGroup(api, t) {
  await withLaneTmp("source-tuple-symlink-", (root) => {
    const repo = makeRepo(root);
    const base = api.computeSourceTuple({ repo }).sourceIdentity;
    try {
      fs.symlinkSync("a.txt", path.join(repo, "link"));
    } catch (error) {
      if (["EPERM", "EACCES", "ENOSYS"].includes(error?.code)) {
        t?.skip(
          `creating a symlink is not permitted on this host (${error.code}); runs where it is`,
        );
        return;
      }
      throw error;
    }
    const first = api.computeSourceTuple({ repo }).sourceIdentity;
    assert.notEqual(first, base, "an untracked symlink moves the identity");
    fs.rmSync(path.join(repo, "link"));
    fs.symlinkSync("dir/b.txt", path.join(repo, "link"));
    assert.notEqual(
      api.computeSourceTuple({ repo }).sourceIdentity,
      first,
      "retargeting the link moves the identity",
    );
  });
}

// ---------------------------------------------------------------------------
// Live tests
// ---------------------------------------------------------------------------

test("d. the identity moves with every change that matters and holds still otherwise", () =>
  identityGroup(realTool));
test("d. the printed tuple passes the gate's own validator; refusals and usage errors exit 3 and 2", () =>
  gateGroup(realTool));
test("d. a gitlink is refused by name", () => gitlinkGroup(realTool));
test("d. a call is read-only", () => readOnlyGroup(realTool));
test("d. a symlink digests as its link text", (t) => symlinkGroup(realTool, t));

// ---------------------------------------------------------------------------
// Inertness mutants
// ---------------------------------------------------------------------------

/**
 * @param {string} label What the mutant does.
 * @param {Array<[string, string]>} replacements Anchors.
 * @param {Function} group The group to run over the mutated tool.
 */
function mutant(label, replacements, group) {
  test(`mutant: ${label} turns the group RED`, async () => {
    const api = await importMutated(TOOL_PATH, replacements);
    await assert.rejects(
      () => group(api),
      (error) =>
        !(
          error instanceof TypeError ||
          error instanceof ReferenceError ||
          error instanceof SyntaxError
        ),
      `${label}: the group still passed over the mutant`,
    );
  });
}

const STATUS_ARGS = '"-z", "--untracked-files=all"]';

mutant(
  "the identity ignoring untracked files",
  [[STATUS_ARGS, '"-z", "--untracked-files=no"]']],
  identityGroup,
);
mutant(
  "the identity collapsing an untracked directory (no --untracked-files=all)",
  [[STATUS_ARGS, '"-z", "--untracked-files=normal"]']],
  identityGroup,
);
mutant(
  "the identity listing ignored files",
  [[STATUS_ARGS, '"-z", "--untracked-files=all", "--ignored"]']],
  identityGroup,
);
mutant(
  "the deletion marker dropped (a deleted path contributes nothing)",
  [
    [
      "        byPath.set(key, recordForPath(root, rawPath));",
      '        const record = recordForPath(root, rawPath);\n        if (record.kind !== "deleted") {\n          byPath.set(key, record);\n        }',
    ],
  ],
  identityGroup,
);
mutant(
  "a rename hashed as one path (the original path ignored)",
  [
    [
      "for (const rawPath of [entry.path, entry.originalPath]) {",
      "for (const rawPath of [entry.path]) {",
    ],
  ],
  identityGroup,
);
mutant(
  "HEAD left out of the identity",
  [["\\nHEAD ${commit}\\n", "\\n"]],
  identityGroup,
);
mutant(
  "file content left out of the identity (the path only)",
  [[".update(fs.readFileSync(absolute))", ".update(relative)"]],
  identityGroup,
);
mutant(
  "sourceDirty always false",
  [["sourceDirty: entries.length > 0,", "sourceDirty: false,"]],
  identityGroup,
);
mutant(
  "the printed identity one character short (the gate's validator rejects it)",
  [['return hash.digest("hex");', 'return hash.digest("hex").slice(1);']],
  gateGroup,
);
mutant(
  "the usage exit code reported as success",
  [
    [
      "    return SOURCE_TUPLE_EXIT_CODES.USAGE;",
      "    return SOURCE_TUPLE_EXIT_CODES.OK;",
    ],
  ],
  gateGroup,
);
mutant(
  "the refusal exit code reported as success",
  [
    [
      "      return SOURCE_TUPLE_EXIT_CODES.REFUSED;",
      "      return SOURCE_TUPLE_EXIT_CODES.OK;",
    ],
  ],
  gateGroup,
);
mutant(
  "the directory refusal inert",
  [["  if (stats.isDirectory()) {", "  if (false && stats.isDirectory()) {"]],
  gitlinkGroup,
);
mutant(
  "git run without --no-optional-locks",
  [['["--no-optional-locks", "-C", cwd, ...args]', '["-C", cwd, ...args]']],
  readOnlyGroup,
);
