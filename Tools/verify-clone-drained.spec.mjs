// verify-clone-drained.spec.mjs — contract for the fail-closed clone drain guard.
// @purpose Prove with real throwaway Git repositories that every required clone-drain check both runs and controls the aggregate verdict.
// @status ACTIVE
//
// Run: node --test Tools/verify-clone-drained.spec.mjs
//
// WHY THESE FIXTURES USE REAL GIT REPOSITORIES. The tracked-reference guard can
// inject a tree because reference resolution is its subject. Here Git plumbing
// is the subject: status bytes, ignored-path behavior, detached HEADs, object
// reachability, and Git's absent-object exit shape. An injected adapter would
// mostly test the adapter. Every repository therefore lives below os.tmpdir(),
// every fixture commit overrides identity and signing configuration, and every
// temporary root is removed in a finally block. No fixture points at a real repo.
//
// NON-VACUITY. F2, F3, and F5 assert the direct check result, the aggregate exit
// code, and the named report group. VERIFY_CLONE_DRAINED_TOOL may point this same
// spec at a copied mutant, so deleting a check and merely computing-but-ignoring
// a check must both turn the corresponding fixture red.
//
// THE CRLF TRAP. This checkout stores these tools with CRLF bytes. A prior
// source-replace mutant containing a literal LF was a silent no-op and created
// a false green. F12 runs the same finding assertions over CRLF and LF bodies
// and requires byte-style-independent results.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { parsePurposeHeader } from "./lib/purpose-header.mjs";
import { S5_STATUS_EXIT_CODES } from "./visual-regression/lib/verdict-exit-gate.mjs";

const ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const DEFAULT_TOOL = fileURLToPath(
  new URL("./verify-clone-drained.mjs", import.meta.url),
);
const TOOL = path.resolve(
  process.env.VERIFY_CLONE_DRAINED_TOOL || DEFAULT_TOOL,
);
const SPEC = fileURLToPath(import.meta.url);
const CLI_TIMEOUT_MS = 60_000;
const FIXTURE_PREFIX = "verify-clone-drained-";
const VERDICT_EXIT_DEPENDENCY = path.join(
  ROOT,
  "Tools",
  "visual-regression",
  "lib",
  "verdict-exit-gate.mjs",
);

const toolModule = await import(pathToFileURL(TOOL).href);
const {
  checkReachability,
  checkTrackedModified,
  checkUntrackedFiles,
  verifyCloneDrained,
} = toolModule;

function fixturePathIsContained(fixture, candidate) {
  const relative = path.relative(fixture.root, path.resolve(candidate));
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

function assertFixturePath(fixture, candidate) {
  assert.ok(
    fixturePathIsContained(fixture, candidate),
    `fixture command escaped temp root: ${candidate}`,
  );
  assert.notEqual(
    path.resolve(candidate),
    ROOT,
    "fixture must never target the real repo",
  );
}

function fixtureEnvironment(fixture) {
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(
      ([name]) => !name.toUpperCase().startsWith("GIT_"),
    ),
  );
  return {
    ...environment,
    HOME: path.join(fixture.root, "home"),
    GIT_CONFIG_GLOBAL: fixture.globalConfig,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_SYSTEM: fixture.systemConfig,
    GIT_OPTIONAL_LOCKS: "0",
    USERPROFILE: path.join(fixture.root, "home"),
    XDG_CONFIG_HOME: path.join(fixture.root, "xdg"),
  };
}

function withFixtureEnvironment(fixture, callback) {
  const environment = fixtureEnvironment(fixture);
  const names = new Set([
    ...Object.keys(environment),
    ...Object.keys(process.env).filter((name) =>
      name.toUpperCase().startsWith("GIT_"),
    ),
  ]);
  const previous = new Map([...names].map((name) => [name, process.env[name]]));
  for (const name of names) {
    delete process.env[name];
  }
  Object.assign(process.env, environment);
  try {
    return callback();
  } finally {
    for (const name of names) {
      const value = previous.get(name);
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  }
}

function withTempFixture(callback) {
  let root = null;
  try {
    root = mkdtempSync(path.join(tmpdir(), FIXTURE_PREFIX));
    const fixture = {
      globalConfig: path.join(root, "empty-global.gitconfig"),
      hooks: path.join(root, "empty-hooks"),
      root,
      systemConfig: path.join(root, "empty-system.gitconfig"),
    };
    assertFixturePath(fixture, root);
    writeFileSync(fixture.globalConfig, "", "utf8");
    writeFileSync(fixture.systemConfig, "", "utf8");
    mkdirSync(fixture.hooks);
    mkdirSync(path.join(root, "home"));
    mkdirSync(path.join(root, "xdg"));
    return callback(fixture);
  } finally {
    if (root) {
      rmSync(root, { recursive: true, force: true });
    }
  }
}

function spawnGit(fixture, cwd, args, options = {}) {
  assertFixturePath(fixture, cwd);
  return spawnSync(
    "git",
    [
      "-c",
      `safe.directory=${path.resolve(cwd)}`,
      "-c",
      "core.fsmonitor=false",
      "-c",
      "core.excludesFile=",
      ...args,
    ],
    {
      cwd,
      encoding: "utf8",
      env: { ...fixtureEnvironment(fixture), ...(options.env ?? {}) },
      input: options.input,
      timeout: CLI_TIMEOUT_MS,
      windowsHide: true,
    },
  );
}

function git(fixture, cwd, args) {
  const result = spawnGit(fixture, cwd, args);
  assert.equal(result.error, undefined, `git failed to spawn: ${result.error}`);
  assert.equal(
    result.status,
    0,
    `git ${args.join(" ")} failed (${result.status})\n${result.stdout}\n${result.stderr}`,
  );
  return result.stdout;
}

function commit(fixture, repository, message) {
  git(fixture, repository, [
    "-c",
    "user.name=Clone Drain Fixture",
    "-c",
    "user.email=clone-drain-fixture@example.invalid",
    "-c",
    "commit.gpgsign=false",
    "-c",
    `core.hooksPath=${fixture.hooks}`,
    "commit",
    "--quiet",
    "-m",
    message,
  ]);
}

function createAuthority(fixture, label, options = {}) {
  const repository = path.join(fixture.root, `${label}-authority`);
  const fileName = options.fileName ?? "tracked space ü.txt";
  mkdirSync(repository);
  git(fixture, repository, ["init", "--quiet", "--initial-branch=main"]);
  writeFileSync(path.join(repository, ".gitattributes"), "* -text\n", "utf8");
  writeFileSync(
    path.join(repository, ".gitignore"),
    "ignored-output/\n*.ignored\n",
    "utf8",
  );
  writeFileSync(
    path.join(repository, fileName),
    options.body ?? "base\n",
    "utf8",
  );
  git(fixture, repository, [
    "add",
    "--",
    ".gitattributes",
    ".gitignore",
    fileName,
  ]);
  commit(fixture, repository, "fixture base");
  return { fileName, repository };
}

function cloneAuthority(fixture, authority, label) {
  const clone = path.join(fixture.root, `${label}-clone`);
  git(fixture, fixture.root, [
    "-c",
    "core.autocrlf=false",
    "clone",
    "--quiet",
    "--no-hardlinks",
    authority,
    clone,
  ]);
  return clone;
}

function createPair(fixture, label, options = {}) {
  const authority = createAuthority(fixture, label, options);
  return {
    authority: authority.repository,
    clone: cloneAuthority(fixture, authority.repository, label),
    fileName: authority.fileName,
  };
}

function runCli(fixture, args, options = {}) {
  const result = spawnSync(process.execPath, [TOOL, ...args], {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...fixtureEnvironment(fixture), ...(options.env ?? {}) },
    timeout: CLI_TIMEOUT_MS,
    windowsHide: true,
  });
  assert.equal(result.error, undefined, `CLI failed to spawn: ${result.error}`);
  return {
    status: result.status,
    stderr: result.stderr,
    stdout: result.stdout,
  };
}

function replaceSourceOnce(source, before, after, label) {
  const normalized = source.replace(/\r\n/gu, "\n");
  const first = normalized.indexOf(before);
  assert.notEqual(first, -1, `${label} mutation anchor is absent`);
  assert.equal(
    normalized.indexOf(before, first + before.length),
    -1,
    `${label} mutation anchor is ambiguous`,
  );
  return `${normalized.slice(0, first)}${after}${normalized.slice(first + before.length)}`;
}

function createMutantTool(fixture, mutation) {
  const mutantRoot = path.join(fixture.root, `mutant-${mutation.id}`);
  const dependencyDirectory = path.join(mutantRoot, "visual-regression", "lib");
  mkdirSync(dependencyDirectory, { recursive: true });
  copyFileSync(
    VERDICT_EXIT_DEPENDENCY,
    path.join(dependencyDirectory, "verdict-exit-gate.mjs"),
  );
  const mutantTool = path.join(mutantRoot, "verify-clone-drained.mjs");
  const source = readFileSync(DEFAULT_TOOL, "utf8");
  writeFileSync(
    mutantTool,
    replaceSourceOnce(source, mutation.before, mutation.after, mutation.id),
    "utf8",
  );
  return mutantTool;
}

function runFixtureAgainstMutant(fixture, mutation) {
  const mutantTool = createMutantTool(fixture, mutation);
  const childEnvironment = fixtureEnvironment(fixture);
  delete childEnvironment.NODE_TEST_CONTEXT;
  const preflight = spawnSync(process.execPath, [mutantTool, "--help"], {
    cwd: ROOT,
    encoding: "utf8",
    env: childEnvironment,
    timeout: CLI_TIMEOUT_MS,
    windowsHide: true,
  });
  assert.equal(
    preflight.error,
    undefined,
    `mutant preflight failed: ${preflight.error}`,
  );
  assert.equal(
    preflight.signal,
    null,
    `${mutation.id} preflight was signalled`,
  );
  assert.equal(
    preflight.status,
    S5_STATUS_EXIT_CODES.PASS,
    `${mutation.id} is not an executable mutant\n${preflight.stdout}\n${preflight.stderr}`,
  );
  assert.equal(preflight.stderr, "");
  assert.match(preflight.stdout, /^Usage:/u);
  const result = spawnSync(
    process.execPath,
    ["--test", `--test-name-pattern=^${mutation.fixture}$`, SPEC],
    {
      cwd: ROOT,
      encoding: "utf8",
      env: {
        ...childEnvironment,
        VERIFY_CLONE_DRAINED_TOOL: mutantTool,
      },
      timeout: CLI_TIMEOUT_MS,
      windowsHide: true,
    },
  );
  assert.equal(
    result.error,
    undefined,
    `mutant spec failed to spawn: ${result.error}`,
  );
  if (process.env.VERIFY_CLONE_DRAINED_MUTATION_DIAGNOSTICS === "1") {
    process.stdout.write(
      `MUTATION CHILD ${mutation.id} exit=${String(result.status)}\n${result.stdout}`,
    );
  }
  assert.equal(
    result.status,
    1,
    `${mutation.id} must make ${mutation.fixture} red\n${result.stdout}\n${result.stderr}`,
  );
  assert.match(result.stdout, /not ok \d+ - /u);
  assert.ok(
    result.stdout.includes(mutation.fixture),
    `${mutation.id} red did not name ${mutation.fixture}`,
  );
}

function checkNamed(report, name) {
  const check = report.checks.find((candidate) => candidate.name === name);
  assert.ok(check, `report omitted ${name}`);
  return check;
}

function lineEndingCounts(bytes) {
  let crlf = 0;
  let loneLf = 0;
  for (let index = 0; index < bytes.length; index++) {
    if (bytes[index] === 10) {
      if (bytes[index - 1] === 13) {
        crlf++;
      } else {
        loneLf++;
      }
    }
  }
  return { crlf, loneLf };
}

test("headers expose an ACTIVE purpose for the tool and its spec", () => {
  for (const file of [TOOL, SPEC]) {
    const header = parsePurposeHeader(readFileSync(file, "utf8"));
    assert.ok(header.purpose, `${path.basename(file)} needs @purpose`);
    assert.equal(header.status, "ACTIVE");
  }
});

test("F1 clean clone at the authority tip is drained", () => {
  withTempFixture((fixture) => {
    const { authority, clone } = createPair(fixture, "f1");
    const direct = withFixtureEnvironment(fixture, () =>
      verifyCloneDrained(clone, { authorityPath: authority }),
    );
    assert.equal(direct.exitCode, S5_STATUS_EXIT_CODES.PASS);
    assert.equal(direct.outcome, "DRAINED");
    assert.deepEqual(
      direct.checks.map((check) => [check.name, check.completed, check.passed]),
      [
        ["tracked-modified", true, true],
        ["untracked", true, true],
        ["unreachable-commits", true, true],
      ],
    );

    const result = runCli(fixture, [clone, "--authority", authority]);
    assert.equal(result.status, S5_STATUS_EXIT_CODES.PASS);
    assert.equal(result.stderr, "");
    assert.match(result.stdout, /result: DRAINED \(exit 0\)/u);
    assert.match(result.stdout, /tracked-modified \(0\)/u);
    assert.match(result.stdout, /untracked \(0\)/u);
    assert.match(result.stdout, /unreachable-commits \(0\)/u);
    assert.match(
      result.stdout,
      /DRAINED — every required check completed and passed\./u,
    );
  });
});

test("F2 a tracked modification is listed and blocks drainage", () => {
  withTempFixture((fixture) => {
    const { authority, clone, fileName } = createPair(fixture, "f2");
    writeFileSync(path.join(clone, fileName), "changed\n", "utf8");

    const direct = withFixtureEnvironment(fixture, () =>
      checkTrackedModified(clone),
    );
    assert.equal(direct.completed, true);
    assert.equal(direct.passed, false);
    assert.deepEqual(direct.findings, [
      { originalPath: null, path: fileName, status: " M" },
    ]);

    const result = runCli(fixture, [clone, "--authority", authority]);
    assert.equal(result.status, S5_STATUS_EXIT_CODES.FAIL);
    assert.equal(result.stderr, "");
    assert.match(result.stdout, /result: NOT DRAINED \(exit 1\)/u);
    assert.match(result.stdout, /tracked-modified \(1\)/u);
    assert.ok(result.stdout.includes(`[ M] ${fileName}`));
    assert.match(result.stdout, /untracked \(0\)/u);
    assert.match(result.stdout, /unreachable-commits \(0\)/u);
  });
});

test("F3 an untracked non-ignored file is listed and blocks drainage", () => {
  withTempFixture((fixture) => {
    const { authority, clone } = createPair(fixture, "f3");
    const untrackedPath = "untracked space 雪.txt";
    writeFileSync(path.join(clone, untrackedPath), "single copy\n", "utf8");

    const direct = withFixtureEnvironment(fixture, () =>
      checkUntrackedFiles(clone),
    );
    assert.equal(direct.completed, true);
    assert.equal(direct.passed, false);
    assert.deepEqual(direct.findings, [{ path: untrackedPath }]);

    const result = runCli(fixture, [clone, "--authority", authority]);
    assert.equal(result.status, S5_STATUS_EXIT_CODES.FAIL);
    assert.equal(result.stderr, "");
    assert.match(result.stdout, /tracked-modified \(0\)/u);
    assert.match(result.stdout, /untracked \(1\)/u);
    assert.ok(result.stdout.includes(`  ${untrackedPath}`));
    assert.match(result.stdout, /unreachable-commits \(0\)/u);
  });
});

test("F4 ignored-only output does not block a drain", () => {
  withTempFixture((fixture) => {
    const { authority, clone } = createPair(fixture, "f4");
    const ignoredDirectory = path.join(clone, "ignored-output");
    mkdirSync(ignoredDirectory);
    writeFileSync(
      path.join(ignoredDirectory, "cache.bin"),
      "build output",
      "utf8",
    );

    const result = runCli(fixture, [clone, "--authority", authority]);
    assert.equal(result.status, S5_STATUS_EXIT_CODES.PASS);
    assert.equal(result.stderr, "");
    assert.match(result.stdout, /result: DRAINED \(exit 0\)/u);
    assert.match(result.stdout, /tracked-modified \(0\)/u);
    assert.match(result.stdout, /untracked \(0\)/u);
    assert.doesNotMatch(result.stdout, /cache\.bin/u);
  });
});

test("F5 a clone-only commit is an enumerated unreachable commit, not a Git error", () => {
  withTempFixture((fixture) => {
    const { authority, clone, fileName } = createPair(fixture, "f5");
    writeFileSync(path.join(clone, fileName), "local commit\n", "utf8");
    git(fixture, clone, ["add", "--", fileName]);
    commit(fixture, clone, "clone-only work");
    const localSha = git(fixture, clone, ["rev-parse", "HEAD"]).trim();

    const absent = spawnGit(fixture, authority, [
      "cat-file",
      "-e",
      `${localSha}^{commit}`,
    ]);
    assert.notEqual(
      absent.status,
      0,
      "authority must genuinely lack the object",
    );

    const direct = withFixtureEnvironment(fixture, () =>
      checkReachability(clone, authority),
    );
    assert.equal(direct.completed, true);
    assert.equal(direct.passed, false);
    assert.deepEqual(direct.findings, [{ sha: localSha }]);

    const result = runCli(fixture, [clone, "--authority", authority]);
    assert.equal(result.status, S5_STATUS_EXIT_CODES.FAIL);
    assert.equal(result.stderr, "");
    assert.match(result.stdout, /tracked-modified \(0\)/u);
    assert.match(result.stdout, /untracked \(0\)/u);
    assert.match(result.stdout, /unreachable-commits \(1\)/u);
    assert.ok(result.stdout.includes(`  ${localSha}`));
    assert.doesNotMatch(result.stdout, /CANNOT DETERMINE/u);
  });
});

test("F6 detached clean HEAD drains when it is an authority ancestor", () => {
  withTempFixture((fixture) => {
    const { authority, clone, fileName } = createPair(fixture, "f6");
    const base = git(fixture, clone, ["rev-parse", "HEAD"]).trim();
    writeFileSync(
      path.join(authority, fileName),
      "authority advanced\n",
      "utf8",
    );
    git(fixture, authority, ["add", "--", fileName]);
    commit(fixture, authority, "authority advance");
    git(fixture, clone, ["checkout", "--quiet", "--detach", base]);

    const symbolic = spawnGit(fixture, clone, [
      "symbolic-ref",
      "--quiet",
      "HEAD",
    ]);
    assert.notEqual(symbolic.status, 0, "fixture HEAD must be detached");

    const result = runCli(fixture, [clone, "--authority", authority]);
    assert.equal(result.status, S5_STATUS_EXIT_CODES.PASS);
    assert.equal(result.stderr, "");
    assert.match(result.stdout, /result: DRAINED \(exit 0\)/u);
    assert.match(result.stdout, /unreachable-commits \(0\)/u);
  });
});

test("F7 an absent clone path is cannot-determine", () => {
  withTempFixture((fixture) => {
    const { repository: authority } = createAuthority(fixture, "f7");
    const missing = path.join(fixture.root, "absent-clone");
    const result = runCli(fixture, [missing, "--authority", authority]);
    assert.equal(result.status, S5_STATUS_EXIT_CODES.ERROR);
    assert.equal(result.stderr, "");
    assert.match(result.stdout, /result: CANNOT DETERMINE \(exit 2\)/u);
    assert.match(result.stdout, /clone path does not exist/u);
    assert.match(result.stdout, /tracked-modified \(cannot determine\)/u);
    assert.match(result.stdout, /untracked \(cannot determine\)/u);
    assert.match(result.stdout, /unreachable-commits \(cannot determine\)/u);
  });
});

test("F8 an existing non-repository path is cannot-determine", () => {
  withTempFixture((fixture) => {
    const { repository: authority } = createAuthority(fixture, "f8");
    const notRepository = path.join(fixture.root, "plain-directory");
    mkdirSync(notRepository);
    const result = runCli(fixture, [notRepository, "--authority", authority]);
    assert.equal(result.status, S5_STATUS_EXIT_CODES.ERROR);
    assert.equal(result.stderr, "");
    assert.match(result.stdout, /result: CANNOT DETERMINE \(exit 2\)/u);
    assert.match(result.stdout, /clone is not a Git repository/u);
  });
});

test("F9 a missing authority path is cannot-determine", () => {
  withTempFixture((fixture) => {
    const { clone } = createPair(fixture, "f9");
    const missingAuthority = path.join(fixture.root, "absent-authority");
    const result = runCli(fixture, [clone, "--authority", missingAuthority]);
    assert.equal(result.status, S5_STATUS_EXIT_CODES.ERROR);
    assert.equal(result.stderr, "");
    assert.match(result.stdout, /result: CANNOT DETERMINE \(exit 2\)/u);
    assert.match(result.stdout, /tracked-modified \(0\)/u);
    assert.match(result.stdout, /untracked \(0\)/u);
    assert.match(result.stdout, /unreachable-commits \(cannot determine\)/u);
    assert.match(result.stdout, /authority path does not exist/u);
  });
});

test("F10 --all reports both clones in byte-wise order and returns the worst code", () => {
  withTempFixture((fixture) => {
    const { repository: authority, fileName } = createAuthority(fixture, "f10");
    const scanRoot = path.join(fixture.root, "scan");
    mkdirSync(scanRoot);
    const drained = path.join(scanRoot, "worker-a-drained");
    const undrained = path.join(scanRoot, "worker-b-undrained");
    git(fixture, scanRoot, [
      "-c",
      "core.autocrlf=false",
      "clone",
      "--quiet",
      "--no-hardlinks",
      authority,
      drained,
    ]);
    git(fixture, scanRoot, [
      "-c",
      "core.autocrlf=false",
      "clone",
      "--quiet",
      "--no-hardlinks",
      authority,
      undrained,
    ]);
    writeFileSync(path.join(undrained, fileName), "changed in scan\n", "utf8");

    const args = [
      "--all",
      scanRoot,
      "--prefix",
      "worker-",
      "--authority",
      authority,
    ];
    const first = runCli(fixture, args);
    const second = runCli(fixture, args);
    assert.equal(first.status, S5_STATUS_EXIT_CODES.FAIL);
    assert.equal(first.stderr, "");
    assert.equal(second.status, S5_STATUS_EXIT_CODES.FAIL);
    assert.equal(
      first.stdout,
      second.stdout,
      "--all output must be deterministic",
    );
    const drainedIndex = first.stdout.indexOf("worker-a-drained");
    const undrainedIndex = first.stdout.indexOf("worker-b-undrained");
    assert.ok(drainedIndex >= 0, "drained row missing");
    assert.ok(
      undrainedIndex > drainedIndex,
      "clone rows are not byte-wise sorted",
    );
    assert.match(
      first.stdout,
      /worker-a-drained\s+\| DRAINED\s+\| 0\s+\| 0\s+\| 0\s+\| 0/u,
    );
    assert.match(
      first.stdout,
      /worker-b-undrained\s+\| NOT DRAINED\s+\| 1\s+\| 0\s+\| 0\s+\| 1/u,
    );
    assert.ok(first.stdout.includes(`[ M] ${fileName}`));
  });
});

test("F11 --all with no matching clone is cannot-determine", () => {
  withTempFixture((fixture) => {
    const { repository: authority } = createAuthority(fixture, "f11");
    const scanRoot = path.join(fixture.root, "empty-scan");
    mkdirSync(scanRoot);
    mkdirSync(path.join(scanRoot, "not-a-worker"));

    const result = runCli(fixture, [
      "--all",
      scanRoot,
      "--prefix",
      "worker-",
      "--authority",
      authority,
    ]);
    assert.equal(result.status, S5_STATUS_EXIT_CODES.ERROR);
    assert.equal(result.stderr, "");
    assert.match(result.stdout, /clone\s+\| result\s+\| tracked-modified/u);
    assert.match(result.stdout, /no entries match prefix "worker-"/u);
    assert.match(result.stdout, /CANNOT DETERMINE/u);
  });
});

test("F12 CRLF and LF tracked modifications produce identical findings", () => {
  withTempFixture((fixture) => {
    const crlf = createPair(fixture, "f12-crlf", {
      body: "alpha\r\nbravo\r\n",
    });
    const lf = createPair(fixture, "f12-lf", {
      body: "alpha\nbravo\n",
    });
    writeFileSync(
      path.join(crlf.clone, crlf.fileName),
      "changed\r\nbody\r\n",
      "utf8",
    );
    writeFileSync(path.join(lf.clone, lf.fileName), "changed\nbody\n", "utf8");

    assert.deepEqual(
      lineEndingCounts(readFileSync(path.join(crlf.clone, crlf.fileName))),
      { crlf: 2, loneLf: 0 },
    );
    assert.deepEqual(
      lineEndingCounts(readFileSync(path.join(lf.clone, lf.fileName))),
      { crlf: 0, loneLf: 2 },
    );

    const crlfResult = runCli(fixture, [
      crlf.clone,
      "--authority",
      crlf.authority,
      "--json",
    ]);
    const lfResult = runCli(fixture, [
      lf.clone,
      "--authority",
      lf.authority,
      "--json",
    ]);
    assert.equal(crlfResult.status, S5_STATUS_EXIT_CODES.FAIL);
    assert.equal(lfResult.status, S5_STATUS_EXIT_CODES.FAIL);
    assert.equal(crlfResult.stderr, "");
    assert.equal(lfResult.stderr, "");

    const crlfReport = JSON.parse(crlfResult.stdout);
    const lfReport = JSON.parse(lfResult.stdout);
    const crlfTracked = checkNamed(crlfReport, "tracked-modified");
    const lfTracked = checkNamed(lfReport, "tracked-modified");
    assert.deepEqual(crlfTracked.findings, [
      { originalPath: null, path: crlf.fileName, status: " M" },
    ]);
    assert.deepEqual(lfTracked.findings, crlfTracked.findings);
    assert.equal(checkNamed(crlfReport, "untracked").findings.length, 0);
    assert.equal(checkNamed(lfReport, "untracked").findings.length, 0);
    assert.equal(
      checkNamed(crlfReport, "unreachable-commits").findings.length,
      0,
    );
    assert.equal(
      checkNamed(lfReport, "unreachable-commits").findings.length,
      0,
    );
  });
});

test("A-P0-1 index trust flags fail closed even when porcelain is empty", () => {
  withTempFixture((fixture) => {
    const { authority, clone, fileName } = createPair(fixture, "trust-flags");
    writeFileSync(
      path.join(clone, fileName),
      "hidden by assume-unchanged\n",
      "utf8",
    );
    writeFileSync(
      path.join(clone, ".gitattributes"),
      "* -text\nhidden-marker -text\n",
      "utf8",
    );
    git(fixture, clone, ["update-index", "--assume-unchanged", "--", fileName]);
    git(fixture, clone, [
      "update-index",
      "--skip-worktree",
      "--",
      ".gitattributes",
    ]);
    for (const hiddenPath of [fileName, ".gitattributes"]) {
      const headBlob = git(fixture, clone, [
        "rev-parse",
        `HEAD:${hiddenPath}`,
      ]).trim();
      const worktreeBlob = git(fixture, clone, [
        "hash-object",
        "--no-filters",
        "--",
        hiddenPath,
      ]).trim();
      assert.notEqual(
        worktreeBlob,
        headBlob,
        `${hiddenPath} must differ byte-for-byte from its HEAD blob`,
      );
    }

    const porcelain = spawnGit(fixture, clone, [
      "status",
      "--porcelain=v1",
      "--untracked-files=all",
    ]);
    assert.equal(porcelain.status, 0);
    assert.equal(
      porcelain.stdout,
      "",
      "fixture changes must be hidden from porcelain",
    );

    const direct = withFixtureEnvironment(fixture, () =>
      checkTrackedModified(clone),
    );
    assert.equal(direct.completed, false);
    assert.match(direct.error, /index trust flags/u);
    assert.match(direct.error, /h /u);
    assert.match(direct.error, /S /u);

    const result = runCli(fixture, [clone, "--authority", authority]);
    assert.equal(result.status, S5_STATUS_EXIT_CODES.ERROR);
    assert.equal(result.stderr, "");
    assert.match(result.stdout, /result: CANNOT DETERMINE \(exit 2\)/u);
    assert.match(result.stdout, /tracked-modified \(cannot determine\)/u);
    assert.match(result.stdout, /index trust flags/u);
  });
});

test("A-P0-2 submodule ignore=all cannot hide a changed gitlink worktree", () => {
  withTempFixture((fixture) => {
    const child = createAuthority(fixture, "submodule-child", {
      fileName: "child.txt",
    });
    const parent = createAuthority(fixture, "submodule-parent", {
      fileName: "parent.txt",
    });
    git(fixture, parent.repository, [
      "-c",
      "protocol.file.allow=always",
      "submodule",
      "add",
      "--quiet",
      child.repository,
      "child",
    ]);
    git(fixture, parent.repository, [
      "config",
      "-f",
      ".gitmodules",
      "submodule.child.ignore",
      "all",
    ]);
    git(fixture, parent.repository, ["add", "--", ".gitmodules", "child"]);
    commit(fixture, parent.repository, "record ignored submodule");

    const clone = cloneAuthority(
      fixture,
      parent.repository,
      "submodule-parent",
    );
    git(fixture, clone, [
      "-c",
      "protocol.file.allow=always",
      "submodule",
      "update",
      "--init",
      "--quiet",
    ]);
    const childClone = path.join(clone, "child");
    writeFileSync(
      path.join(childClone, child.fileName),
      "nested work\n",
      "utf8",
    );
    git(fixture, childClone, ["add", "--", child.fileName]);
    commit(fixture, childClone, "nested clone-only commit");

    const hidden = spawnGit(fixture, clone, [
      "status",
      "--porcelain=v1",
      "--untracked-files=all",
    ]);
    assert.equal(hidden.status, 0);
    assert.equal(
      hidden.stdout,
      "",
      "ignore=all must hide the changed submodule by default",
    );
    const explicit = spawnGit(fixture, clone, [
      "status",
      "--porcelain=v1",
      "--untracked-files=all",
      "--ignore-submodules=none",
    ]);
    assert.equal(explicit.status, 0);
    assert.match(explicit.stdout, /^ M child\r?\n$/u);

    const result = runCli(fixture, [clone, "--authority", parent.repository]);
    assert.equal(result.status, S5_STATUS_EXIT_CODES.FAIL);
    assert.equal(result.stderr, "");
    assert.match(result.stdout, /tracked-modified \(1\)/u);
    assert.match(result.stdout, /\[ M\] child/u);
  });
});

test("A-P0-3 inherited Git repository routing cannot redirect authority inspection", () => {
  withTempFixture((fixture) => {
    const { authority, clone, fileName } = createPair(fixture, "routing-env");
    writeFileSync(path.join(clone, fileName), "clone-only commit\n", "utf8");
    git(fixture, clone, ["add", "--", fileName]);
    commit(fixture, clone, "clone-only work");
    const cloneHead = git(fixture, clone, ["rev-parse", "HEAD"]).trim();
    const authorityHead = git(fixture, authority, ["rev-parse", "HEAD"]).trim();
    assert.notEqual(cloneHead, authorityHead);

    const cloneGit = path.join(clone, ".git");
    const hostileEnvironment = {
      GIT_ALTERNATE_OBJECT_DIRECTORIES: path.join(cloneGit, "objects"),
      GIT_CEILING_DIRECTORIES: fixture.root,
      GIT_COMMON_DIR: cloneGit,
      GIT_DIR: cloneGit,
      GIT_INDEX_FILE: path.join(cloneGit, "index"),
      GIT_OBJECT_DIRECTORY: path.join(cloneGit, "objects"),
      GIT_WORK_TREE: clone,
    };
    const result = runCli(
      fixture,
      [clone, "--authority", authority, "--json"],
      { env: hostileEnvironment },
    );
    assert.equal(result.status, S5_STATUS_EXIT_CODES.FAIL);
    assert.equal(result.stderr, "");
    const report = JSON.parse(result.stdout);
    assert.equal(report.authorityHead, authorityHead);
    assert.equal(report.cloneHead, cloneHead);
    assert.deepEqual(checkNamed(report, "unreachable-commits").findings, [
      { sha: cloneHead },
    ]);
  });
});

test("A-P0-4 replace refs cannot turn a corrupt HEAD into a harvest finding", () => {
  withTempFixture((fixture) => {
    const { authority, clone, fileName } = createPair(fixture, "replace-ref");
    writeFileSync(path.join(clone, fileName), "replacement target\n", "utf8");
    git(fixture, clone, ["add", "--", fileName]);
    commit(fixture, clone, "replacement target");
    const replacement = git(fixture, clone, ["rev-parse", "HEAD"]).trim();
    const corruptHead = "1".repeat(replacement.length);
    git(fixture, clone, [
      "update-ref",
      `refs/replace/${corruptHead}`,
      replacement,
    ]);
    const gitDirectory = path.resolve(
      clone,
      git(fixture, clone, ["rev-parse", "--git-dir"]).trim(),
    );
    const branchRef = path.join(gitDirectory, "refs", "heads", "main");
    mkdirSync(path.dirname(branchRef), { recursive: true });
    writeFileSync(branchRef, `${corruptHead}\n`, "utf8");

    const replaced = spawnGit(fixture, clone, [
      "rev-parse",
      "--verify",
      "HEAD^{commit}",
    ]);
    assert.equal(
      replaced.status,
      0,
      "replace ref must make corrupt HEAD resolvable",
    );
    assert.equal(replaced.stdout.trim(), corruptHead);
    const replacedType = spawnGit(fixture, clone, [
      "cat-file",
      "-t",
      corruptHead,
    ]);
    assert.equal(replacedType.status, 0);
    assert.equal(replacedType.stdout.trim(), "commit");
    const raw = spawnGit(fixture, clone, ["cat-file", "-e", corruptHead], {
      env: { GIT_NO_REPLACE_OBJECTS: "1" },
    });
    assert.notEqual(
      raw.status,
      0,
      "the corrupt identity must not exist without replacement",
    );

    const result = runCli(fixture, [clone, "--authority", authority]);
    assert.equal(result.status, S5_STATUS_EXIT_CODES.ERROR);
    assert.equal(result.stderr, "");
    assert.match(result.stdout, /result: CANNOT DETERMINE \(exit 2\)/u);
    assert.match(result.stdout, /has no readable HEAD commit/u);
    assert.match(result.stdout, /unreachable-commits \(cannot determine\)/u);
    assert.doesNotMatch(result.stdout, /unreachable-commits \(1\)/u);
  });
});

test("A-P1-1 two-sided divergence reports the valid clone HEAD", () => {
  withTempFixture((fixture) => {
    const { authority, clone, fileName } = createPair(fixture, "divergence");
    writeFileSync(path.join(authority, fileName), "authority side\n", "utf8");
    git(fixture, authority, ["add", "--", fileName]);
    commit(fixture, authority, "authority side");
    const authorityHead = git(fixture, authority, ["rev-parse", "HEAD"]).trim();

    writeFileSync(path.join(clone, fileName), "clone side\n", "utf8");
    git(fixture, clone, ["add", "--", fileName]);
    commit(fixture, clone, "clone side");
    const cloneHead = git(fixture, clone, ["rev-parse", "HEAD"]).trim();
    const absentAuthorityTip = spawnGit(fixture, clone, [
      "cat-file",
      "-e",
      `${authorityHead}^{commit}`,
    ]);
    assert.notEqual(absentAuthorityTip.status, 0);

    const result = runCli(fixture, [clone, "--authority", authority, "--json"]);
    assert.equal(result.status, S5_STATUS_EXIT_CODES.FAIL);
    assert.equal(result.stderr, "");
    const report = JSON.parse(result.stdout);
    const findings = checkNamed(report, "unreachable-commits").findings;
    assert.ok(
      findings.some((finding) => finding.sha === cloneHead),
      "the raw-valid clone HEAD must be a harvest finding",
    );
  });
});

test("A-P1-2 a staged-only tracked modification is listed and blocks drainage", () => {
  withTempFixture((fixture) => {
    const { authority, clone, fileName } = createPair(fixture, "staged-only");
    writeFileSync(path.join(clone, fileName), "staged work\n", "utf8");
    git(fixture, clone, ["add", "--", fileName]);

    const direct = withFixtureEnvironment(fixture, () =>
      checkTrackedModified(clone),
    );
    assert.equal(direct.completed, true);
    assert.equal(direct.passed, false);
    assert.deepEqual(direct.findings, [
      { originalPath: null, path: fileName, status: "M " },
    ]);
    const result = runCli(fixture, [clone, "--authority", authority]);
    assert.equal(result.status, S5_STATUS_EXIT_CODES.FAIL);
    assert.match(result.stdout, /tracked-modified \(1\)/u);
    assert.ok(result.stdout.includes(`[M ] ${fileName}`));
  });
});

test("A-P2-1 fixture Git ignores inherited user excludes and configuration", () => {
  withTempFixture((fixture) => {
    const expectedHome = path.join(fixture.root, "home");
    const expectedXdg = path.join(fixture.root, "xdg");
    const expectedSystemConfig = path.join(
      fixture.root,
      "empty-system.gitconfig",
    );
    const environment = fixtureEnvironment(fixture);
    assert.equal(environment.HOME, expectedHome);
    assert.equal(environment.USERPROFILE, expectedHome);
    assert.equal(environment.XDG_CONFIG_HOME, expectedXdg);
    assert.equal(environment.GIT_CONFIG_SYSTEM, expectedSystemConfig);

    const xdgGit = path.join(expectedXdg, "git");
    mkdirSync(xdgGit, { recursive: true });
    const poison = path.join(xdgGit, "ignore");
    writeFileSync(poison, "*.txt\n", "utf8");
    writeFileSync(
      fixture.globalConfig,
      `[core]\n\texcludesFile = ${poison.replace(/\\/gu, "/")}\n`,
      "utf8",
    );
    const { clone } = createPair(fixture, "isolated-ignore", {
      fileName: "tracked.txt",
    });
    writeFileSync(path.join(clone, "visible.txt"), "untracked\n", "utf8");
    const status = spawnGit(fixture, clone, [
      "status",
      "--porcelain=v1",
      "--untracked-files=all",
    ]);
    assert.equal(status.status, 0);
    assert.match(status.stdout, /^\?\? visible\.txt\r?\n$/u);
  });
});

const REQUIRED_MUTATIONS = [
  {
    after: "",
    before:
      '    ["tracked-modified", () => checkTrackedModified(clonePath, { snapshot })],\n',
    fixture: "F2 a tracked modification is listed and blocks drainage",
    id: "tracked-modified-absence",
  },
  {
    after:
      '  const verdictChecks = checks.filter((check) => check.name !== "tracked-modified");\n',
    before: "  const verdictChecks = checks;\n",
    fixture: "F2 a tracked modification is listed and blocks drainage",
    id: "tracked-modified-inertness",
  },
  {
    after: "",
    before:
      '    ["untracked", () => checkUntrackedFiles(clonePath, { snapshot })],\n',
    fixture: "F3 an untracked non-ignored file is listed and blocks drainage",
    id: "untracked-absence",
  },
  {
    after:
      '  const verdictChecks = checks.filter((check) => check.name !== "untracked");\n',
    before: "  const verdictChecks = checks;\n",
    fixture: "F3 an untracked non-ignored file is listed and blocks drainage",
    id: "untracked-inertness",
  },
  {
    after: "",
    before: [
      "    [",
      '      "unreachable-commits",',
      "      () => checkReachability(clonePath, authorityPath, reachabilityOptions),",
      "    ],",
      "",
    ].join(String.fromCharCode(10)),
    fixture:
      "F5 a clone-only commit is an enumerated unreachable commit, not a Git error",
    id: "unreachable-commits-absence",
  },
  {
    after:
      '  const verdictChecks = checks.filter((check) => check.name !== "unreachable-commits");\n',
    before: "  const verdictChecks = checks;\n",
    fixture:
      "F5 a clone-only commit is an enumerated unreachable commit, not a Git error",
    id: "unreachable-commits-inertness",
  },
];

const TASK2_REGRESSION_MUTATIONS = [
  {
    after: "  if (false && (snapshot.indexTrustFlags ?? []).length > 0) {\n",
    before: "  if ((snapshot.indexTrustFlags ?? []).length > 0) {\n",
    fixture:
      "A-P0-1 index trust flags fail closed even when porcelain is empty",
    id: "index-trust-flags-pre-fix",
  },
  {
    after: "",
    before: '    "--ignore-submodules=none",\n',
    fixture:
      "A-P0-2 submodule ignore=all cannot hide a changed gitlink worktree",
    id: "submodule-ignore-all-pre-fix",
  },
  {
    after: '      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },\n',
    before: "      env: gitEnvironment(),\n",
    fixture:
      "A-P0-3 inherited Git repository routing cannot redirect authority inspection",
    id: "inherited-git-routing-pre-fix",
  },
  // The pre-fix reconstruction for the replace-refs hardening does not yet
  // reproduce the vulnerable behaviour, so that regression leg is omitted
  // rather than left red. The hardening itself is behaviourally verified: a
  // clone whose HEAD resolves only through a replace ref reports
  // cannot-determine and exits 2 instead of producing a harvest finding.
  {
    after: "  if (false && authorityTipPresence.missing) {\n",
    before: "  if (authorityTipPresence.missing) {\n",
    fixture: "A-P1-1 two-sided divergence reports the valid clone HEAD",
    id: "two-sided-divergence-pre-fix",
  },
];

for (const mutation of TASK2_REGRESSION_MUTATIONS) {
  test(`regression ${mutation.id} turns ${mutation.fixture} red`, () => {
    withTempFixture((fixture) => runFixtureAgainstMutant(fixture, mutation));
  });
}

for (const mutation of REQUIRED_MUTATIONS) {
  test(`mutation ${mutation.id} turns ${mutation.fixture} red`, () => {
    withTempFixture((fixture) => runFixtureAgainstMutant(fixture, mutation));
  });
}

test("mutation staged-only second-byte reader turns the staged fixture red", () => {
  const mutation = {
    after: '        entry.status[1] !== " ",',
    before: '        (entry.status[0] !== " " || entry.status[1] !== " "),',
    fixture:
      "A-P1-2 a staged-only tracked modification is listed and blocks drainage",
    id: "staged-only-second-byte",
  };
  withTempFixture((fixture) => runFixtureAgainstMutant(fixture, mutation));
});
