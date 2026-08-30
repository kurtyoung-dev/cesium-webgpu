import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const VERIFIER = fileURLToPath(
  new URL("./verify-worker-handoff.mjs", import.meta.url),
);
const TIMEOUT_MS = 60_000;
const PROVISIONED_PATH = "migration_doc/WORKER_ISOLATION_AND_BRANCH_HANDOFF.md";
const UNTRACKED_PROVISIONED_PATH = "AGENTS.md";
const ORDINARY_PATH = "Tools/ordinary.mjs";

const GIT_IDENTITY = [
  "-c",
  "user.name=worker-handoff-fixture",
  "-c",
  "user.email=worker-handoff-fixture@example.invalid",
  "-c",
  "commit.gpgsign=false",
];

function git(clone, args) {
  return execFileSync("git", [...GIT_IDENTITY, "-C", clone, ...args], {
    encoding: "utf8",
    timeout: TIMEOUT_MS,
  });
}

function writeFixtureFile(clone, relativePath, content) {
  const fullPath = path.join(clone, relativePath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content);
}

function makeFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "worker-handoff-"));
  const clone = path.join(root, "clone");
  fs.mkdirSync(clone);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  git(clone, ["init", "--initial-branch=main"]);
  writeFixtureFile(clone, PROVISIONED_PATH, "baseline governance\n");
  writeFixtureFile(clone, ORDINARY_PATH, "export const baseline = true;\n");
  git(clone, ["add", "--all"]);
  git(clone, ["commit", "-m", "fixture baseline"]);
  return clone;
}

function runVerifier(clone, leases, { json = true } = {}) {
  const args = [VERIFIER, clone];
  for (const lease of leases) {
    args.push("--lease", lease);
  }
  args.push("--base", "main", "--no-specs");
  if (json) {
    args.push("--json");
  }

  const result = spawnSync(process.execPath, args, {
    encoding: "utf8",
    timeout: TIMEOUT_MS,
  });
  if (result.error !== undefined && result.error !== null) {
    throw result.error;
  }
  assert.notEqual(result.status, null, "verifier process must terminate");
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    report:
      json && (result.stdout ?? "").trim().length > 0
        ? JSON.parse(result.stdout)
        : undefined,
  };
}

test("an exact lease counts an untracked provisioned path as authored", (t) => {
  const clone = makeFixture(t);
  writeFixtureFile(clone, UNTRACKED_PROVISIONED_PATH, "worker policy\n");

  const result = runVerifier(clone, [UNTRACKED_PROVISIONED_PATH]);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.report.status, "READY_FOR_REVIEW");
  assert.deepEqual(result.report.authored, [UNTRACKED_PROVISIONED_PATH]);
  assert.deepEqual(result.report.violations, []);
});

test("a directory lease counts a tracked provisioned path as authored", (t) => {
  const clone = makeFixture(t);
  fs.appendFileSync(path.join(clone, PROVISIONED_PATH), "worker change\n");

  const result = runVerifier(clone, ["migration_doc"]);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.report.status, "READY_FOR_REVIEW");
  assert.deepEqual(result.report.authored, [PROVISIONED_PATH]);
  assert.deepEqual(result.report.violations, []);
});

test("the explicit lease is load-bearing for a provisioned path", (t) => {
  const clone = makeFixture(t);
  fs.appendFileSync(path.join(clone, PROVISIONED_PATH), "worker change\n");

  const result = runVerifier(clone, [ORDINARY_PATH]);

  assert.equal(result.status, 1, result.stderr);
  assert.equal(result.report.status, "VIOLATIONS");
  assert.deepEqual(result.report.authored, []);
  assert.ok(
    result.report.violations.includes(
      "no authored changes — the worker produced nothing",
    ),
  );
  assert.equal(
    result.report.violations.some((violation) =>
      violation.startsWith("outside the declared lease:"),
    ),
    false,
  );
});

test("unleased provisioned drift stays ignored beside leased authored work", (t) => {
  const clone = makeFixture(t);
  fs.appendFileSync(path.join(clone, PROVISIONED_PATH), "provisioned drift\n");
  fs.appendFileSync(path.join(clone, ORDINARY_PATH), "// authored change\n");

  const result = runVerifier(clone, [ORDINARY_PATH]);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.report.status, "READY_FOR_REVIEW");
  assert.deepEqual(result.report.authored, [ORDINARY_PATH]);
  assert.deepEqual(result.report.violations, []);
});

test("ordinary leased drift remains authored and uses READY vocabulary", (t) => {
  const clone = makeFixture(t);
  fs.appendFileSync(path.join(clone, ORDINARY_PATH), "// authored change\n");

  const jsonResult = runVerifier(clone, [ORDINARY_PATH]);
  const humanResult = runVerifier(clone, [ORDINARY_PATH], { json: false });

  assert.equal(jsonResult.status, 0, jsonResult.stderr);
  assert.equal(jsonResult.report.status, "READY_FOR_REVIEW");
  assert.deepEqual(jsonResult.report.authored, [ORDINARY_PATH]);
  assert.equal(humanResult.status, 0, humanResult.stderr);
  assert.match(humanResult.stdout, /^handoff: READY_FOR_REVIEW$/m);
  assert.match(humanResult.stdout, /READY FOR REVIEW, not CORRECT/);
});

test("unexpected ordinary unleased drift remains a violation", (t) => {
  const clone = makeFixture(t);
  const unexpectedPath = "Tools/unexpected.mjs";
  writeFixtureFile(clone, unexpectedPath, "export const unexpected = true;\n");

  const result = runVerifier(clone, [ORDINARY_PATH]);

  assert.equal(result.status, 1, result.stderr);
  assert.equal(result.report.status, "VIOLATIONS");
  assert.deepEqual(result.report.authored, [unexpectedPath]);
  assert.ok(
    result.report.violations.includes(
      `outside the declared lease: ${unexpectedPath}`,
    ),
  );
});

test("omitting every lease remains a structural invocation error", (t) => {
  const clone = makeFixture(t);

  const result = runVerifier(clone, []);

  assert.equal(result.status, 3);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /at least one --lease is required/);
  assert.equal(result.report, undefined);
});

test("a moved worker branch is a violation despite valid authored work", (t) => {
  const clone = makeFixture(t);
  const mainSha = git(clone, ["rev-parse", "main"]).trim();
  git(clone, ["switch", "-c", "worker"]);
  writeFixtureFile(clone, "fixture-commit.txt", "worker branch commit\n");
  git(clone, ["add", "fixture-commit.txt"]);
  git(clone, ["commit", "-m", "move worker branch"]);
  const headSha = git(clone, ["rev-parse", "HEAD"]).trim();
  fs.appendFileSync(path.join(clone, ORDINARY_PATH), "// authored change\n");

  const result = runVerifier(clone, [ORDINARY_PATH]);

  assert.notEqual(headSha, mainSha);
  assert.equal(result.status, 1, result.stderr);
  assert.equal(result.report.status, "VIOLATIONS");
  assert.deepEqual(result.report.authored, [ORDINARY_PATH]);
  const movedBranchViolations = result.report.violations.filter((violation) =>
    violation.startsWith("worker moved the branch:"),
  );
  assert.deepEqual(movedBranchViolations, [
    `worker moved the branch: HEAD ${headSha.slice(0, 10)} != main ${mainSha.slice(0, 10)} — workers never run git writes`,
  ]);
  assert.match(
    movedBranchViolations[0],
    /^worker moved the branch: HEAD [0-9a-f]{10} != main [0-9a-f]{10} — workers never run git writes$/,
  );
});
