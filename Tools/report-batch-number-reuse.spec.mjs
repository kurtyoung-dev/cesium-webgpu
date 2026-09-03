// report-batch-number-reuse.spec.mjs — behaviour spec for the CI batch-reuse
// report, driven against a real, throwaway git repository.
//
// @purpose Behaviour spec for report-batch-number-reuse.mjs, run against a real temporary git repository.
// @status ACTIVE
//
// WHY A REAL REPOSITORY. The report's entire job is to read `git log` output
// correctly and count what it finds. A spec that mocks `execFileSync` or
// asserts against the source text would certify the brief, not the tool — it
// would pass even if the tool never actually shelled out to git, or shelled
// out with the wrong arguments. Every case below creates real commits in a
// disposable repository under the OS temp root and spawns the real script as
// a child process, so the assertion is against genuine `git log` output.
//
// SAFETY. No fixture here ever force-pushes, deletes a ref, or resets
// history — every repository is local-only, created fresh per test, and the
// sandbox path is asserted to sit under the canonical OS temp root before any
// git command touches it.

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  buildReport,
  formatReport,
  parseArgs,
  parseLogLine,
} from "./report-batch-number-reuse.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, "report-batch-number-reuse.mjs");
const GIT_TIMEOUT_MS = 20_000;
const IDENTITY = [
  "-c",
  "user.name=report-batch-number-reuse-spec",
  "-c",
  "user.email=spec@example.invalid",
  "-c",
  "commit.gpgsign=false",
];

/**
 * True when `child` is `parent` or strictly nested inside it.
 *
 * @param {string} parent Canonical parent directory.
 * @param {string} child Canonical candidate directory.
 * @returns {boolean} Containment.
 */
function isPathInsideOrEqual(parent, child) {
  if (parent === child) {
    return true;
  }
  const relative = path.relative(parent, child);
  return (
    relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative)
  );
}

/**
 * Allocate a throwaway git repository under the canonical OS temp root and
 * register its cleanup. Every commit uses a fixed author/committer date so
 * SHAs (and therefore any ordering assumption) never depend on wall-clock
 * time.
 *
 * @param {import("node:test").TestContext} t Test context.
 * @returns {{dir: string, commit: (subject: string) => string}} Sandbox handle.
 */
function makeTempRepo(t) {
  const tempRoot = fs.realpathSync(os.tmpdir());
  const allocated = fs.mkdtempSync(path.join(tempRoot, "batch-reuse-spec-"));
  const dir = fs.realpathSync(allocated);
  assert.ok(
    isPathInsideOrEqual(tempRoot, dir),
    `refusing to run git in a directory outside the OS temp root: ${dir}`,
  );
  t.after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  execFileSync("git", ["init", "--initial-branch=main", dir], {
    stdio: "ignore",
    timeout: GIT_TIMEOUT_MS,
  });

  let serial = 0;
  let commitEpochSeconds = 1_800_000_000; // fixed, monotonically advanced below
  const commit = (subject) => {
    serial += 1;
    commitEpochSeconds += 60;
    fs.writeFileSync(path.join(dir, "file.txt"), `${subject}\n${serial}\n`);
    execFileSync("git", [...IDENTITY, "add", "file.txt"], {
      cwd: dir,
      stdio: "ignore",
      timeout: GIT_TIMEOUT_MS,
    });
    const commitEnv = {
      ...process.env,
      GIT_AUTHOR_DATE: `${commitEpochSeconds} +0000`,
      GIT_COMMITTER_DATE: `${commitEpochSeconds} +0000`,
    };
    execFileSync(
      "git",
      [...IDENTITY, "commit", "--no-verify", "--allow-empty", "-m", subject],
      { cwd: dir, stdio: "ignore", timeout: GIT_TIMEOUT_MS, env: commitEnv },
    );
    return execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: dir,
      encoding: "utf8",
      timeout: GIT_TIMEOUT_MS,
    }).trim();
  };

  return { dir, commit };
}

/**
 * Spawn the real script as a child process against a repo directory.
 * spawnSync, not execFileSync: some cases below expect a non-zero exit and
 * must inspect stderr rather than have node throw on it.
 *
 * @param {string} cwd Directory to run the script in.
 * @param {string[]} [args] Extra CLI arguments.
 * @returns {{status: (number|null), stdout: string, stderr: string}} Result.
 */
function runScript(cwd, args = []) {
  const result = spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd,
    encoding: "utf8",
    timeout: GIT_TIMEOUT_MS,
  });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

// ---------------------------------------------------------------------------
// A. Pure helpers
// ---------------------------------------------------------------------------

test("A1: parseLogLine splits on the first tab only", () => {
  const record = parseLogLine("abc123\tBatch 7: a subject\twith a literal tab");
  assert.deepEqual(record, {
    sha: "abc123",
    subject: "Batch 7: a subject\twith a literal tab",
  });
});

test("A2: parseLogLine rejects a line with no tab", () => {
  assert.throws(() => parseLogLine("no-tab-here"), /no tab separator/);
});

test("A3: parseArgs recognizes --json, --range VALUE, and --range=VALUE", () => {
  assert.deepEqual(parseArgs([]), { json: false, range: undefined });
  assert.deepEqual(parseArgs(["--json"]), { json: true, range: undefined });
  assert.deepEqual(parseArgs(["--range", "a..b"]), {
    json: false,
    range: "a..b",
  });
  assert.deepEqual(parseArgs(["--range=a..b", "--json"]), {
    json: true,
    range: "a..b",
  });
});

test("A4: parseArgs rejects an unrecognized flag and a valueless --range", () => {
  assert.throws(() => parseArgs(["--bogus"]), /unrecognized argument/);
  assert.throws(() => parseArgs(["--range"]), /--range requires a value/);
});

test("A5: buildReport counts totals, distinct numbers, and the max, ignoring non-Batch subjects", () => {
  const report = buildReport([
    { sha: "s1", subject: "Batch 1: one" },
    { sha: "s2", subject: "Batch 5: five" },
    { sha: "s3", subject: "not a batch subject" },
  ]);
  assert.equal(report.totalBatchSubjects, 2);
  assert.equal(report.distinctBatchNumbers, 2);
  assert.equal(report.maxBatchNumber, 5);
  assert.deepEqual(report.duplicates, []);
});

test("A6: buildReport reports every distinct duplicated batch number, sorted ascending, with every owning commit", () => {
  const report = buildReport([
    { sha: "s1", subject: "Batch 9: nine a" },
    { sha: "s2", subject: "Batch 3: three a" },
    { sha: "s3", subject: "Batch 9: nine b (reused)" },
    { sha: "s4", subject: "Batch 3: three b (reused)" },
    { sha: "s5", subject: "Batch 3: three c (reused again)" },
  ]);
  assert.equal(report.totalBatchSubjects, 5);
  assert.equal(report.distinctBatchNumbers, 2);
  assert.equal(report.maxBatchNumber, 9);
  assert.deepEqual(
    report.duplicates.map((d) => d.batch),
    [3, 9],
  );
  assert.deepEqual(
    report.duplicates[0].commits.map((c) => c.sha),
    ["s2", "s4", "s5"],
  );
  assert.deepEqual(
    report.duplicates[1].commits.map((c) => c.sha),
    ["s1", "s3"],
  );
});

test("A7: formatReport names every duplicate and its commits; the clean case says so plainly", () => {
  const dirty = formatReport(
    buildReport([
      { sha: "1234567890abcdef", subject: "Batch 4: first" },
      { sha: "fedcba0987654321", subject: "Batch 4: second" },
    ]),
  );
  assert.match(dirty, /duplicated numbers:\s+1/);
  assert.match(dirty, /Batch 4:/);
  assert.match(dirty, /1234567890 {2}Batch 4: first/);

  const clean = formatReport(
    buildReport([{ sha: "a", subject: "Batch 1: x" }]),
  );
  assert.match(clean, /No Batch number is reused/);
});

// ---------------------------------------------------------------------------
// B. End-to-end, against a real temporary git repository
// ---------------------------------------------------------------------------

test("B1: a reused batch number in real history is reported, by hash and subject, in --json mode", (t) => {
  const repo = makeTempRepo(t);
  repo.commit("Batch 1: initial");
  const shaFirst = repo.commit("Batch 2: second thing");
  repo.commit("unrelated non-batch commit");
  const shaReusedA = repo.commit("Batch 2: this reuses batch 2 by mistake");
  repo.commit("Batch 3: third thing");

  const result = runScript(repo.dir, ["--json"]);
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);

  assert.equal(report.totalBatchSubjects, 4); // 1, 2, 2, 3 — the unrelated commit is excluded
  assert.equal(report.distinctBatchNumbers, 3); // 1, 2, 3
  assert.equal(report.maxBatchNumber, 3);
  assert.equal(report.duplicates.length, 1);
  assert.equal(report.duplicates[0].batch, 2);
  assert.deepEqual(
    report.duplicates[0].commits.map((c) => c.sha).sort(),
    [shaFirst, shaReusedA].sort(),
  );
});

test("B2: the default text report names the duplicate and prints the max number", (t) => {
  const repo = makeTempRepo(t);
  repo.commit("Batch 10: a");
  repo.commit("Batch 11: b");
  repo.commit("Batch 10: b (reused)");

  const result = runScript(repo.dir, []);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /total batch subjects:\s+3/);
  assert.match(result.stdout, /distinct batch numbers:\s+2/);
  assert.match(result.stdout, /max batch number:\s+11/);
  assert.match(result.stdout, /Batch 10:/);
});

test("B3: a clean history (no reuse) is reported as clean, exit 0", (t) => {
  const repo = makeTempRepo(t);
  repo.commit("Batch 1: a");
  repo.commit("Batch 2: b");
  repo.commit("Batch 3: c");

  const result = runScript(repo.dir, ["--json"]);
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.deepEqual(report.duplicates, []);
  assert.equal(report.maxBatchNumber, 3);
});

test("B4: --range scopes the report to the given git revision range", (t) => {
  const repo = makeTempRepo(t);
  repo.commit("Batch 1: a");
  const branchPoint = repo.commit("Batch 2: b");
  repo.commit("Batch 3: c");
  repo.commit("Batch 3: c reused, after the branch point");

  // Everything after branchPoint: exactly the two Batch-3 commits — the
  // reuse must be visible scoped to just that range.
  const afterBranch = runScript(repo.dir, [
    "--json",
    "--range",
    `${branchPoint}..HEAD`,
  ]);
  assert.equal(afterBranch.status, 0, afterBranch.stderr);
  const afterBranchReport = JSON.parse(afterBranch.stdout);
  assert.equal(afterBranchReport.totalBatchSubjects, 2);
  assert.equal(afterBranchReport.duplicates.length, 1);
  assert.equal(afterBranchReport.duplicates[0].batch, 3);

  // Up to and including branchPoint: batch 1 and batch 2 only, no reuse —
  // proves --range narrows the read rather than merely being accepted.
  const upToBranch = runScript(repo.dir, ["--json", "--range", branchPoint]);
  assert.equal(upToBranch.status, 0, upToBranch.stderr);
  const upToBranchReport = JSON.parse(upToBranch.stdout);
  assert.equal(upToBranchReport.totalBatchSubjects, 2);
  assert.deepEqual(upToBranchReport.duplicates, []);

  const full = runScript(repo.dir, ["--json"]);
  assert.equal(full.status, 0, full.stderr);
  const fullReport = JSON.parse(full.stdout);
  assert.equal(fullReport.totalBatchSubjects, 4);
  assert.equal(fullReport.duplicates.length, 1);
});

test("B5: a genuine git failure exits non-zero and never crashes the process", (t) => {
  const tempRoot = fs.realpathSync(os.tmpdir());
  const notARepo = fs.mkdtempSync(path.join(tempRoot, "batch-reuse-nogit-"));
  t.after(() => fs.rmSync(notARepo, { recursive: true, force: true }));

  const result = runScript(notARepo, []);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /git log failed/);
});

test("B6: an unrecognized flag exits non-zero before any git command runs", (t) => {
  const repo = makeTempRepo(t);
  repo.commit("Batch 1: a");

  const result = runScript(repo.dir, ["--not-a-real-flag"]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /unrecognized argument/);
});
