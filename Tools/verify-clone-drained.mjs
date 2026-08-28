#!/usr/bin/env node
/**
 * Worker clone drainage verification.
 * @purpose Fail closed unless a worker clone has no recoverable work outside the authority repository.
 * @status ACTIVE
 *
 * WHY THIS EXISTS. Worker clones have repeatedly held the only copy of real
 * work. A rendering fix and a performance artifact were found this week in
 * uncommitted clone worktrees, absent from every commit, branch, and archive.
 * One hard reset would have destroyed them permanently. The written evidence-
 * repatriation rule therefore needs a mechanical answer to "is this clone safe
 * to delete?" instead of a human reading git status.
 *
 * A clone is drained only when its tracked tree matches its own HEAD, it has no
 * untracked non-ignored paths, and its HEAD is reachable from the authority
 * tip. Every check is required. Ignored output is deliberately absent from the
 * status query. Line-ending-only tracked changes are deliberately findings:
 * byte differences from HEAD are work until somebody harvests or rejects them.
 *
 * Usage:
 *   node Tools/verify-clone-drained.mjs <clonePath> [--authority <repoPath>] [--json]
 *   node Tools/verify-clone-drained.mjs --all <dir> [--prefix cesium-worker-] [--authority <repoPath>] [--json]
 *   node Tools/verify-clone-drained.mjs --help
 *
 * Exit: 0 drained · 1 work must be harvested · 2 cannot determine
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { TextDecoder } from "node:util";
import { fileURLToPath } from "node:url";

import { exitCodeForS5Status } from "./visual-regression/lib/verdict-exit-gate.mjs";

export const DEFAULT_AUTHORITY_PATH = "F:/Dev/GH/cesium-webgpu";
export const DEFAULT_CLONE_PREFIX = "cesium-worker-";

const GIT_TIMEOUT_MS = 30_000;
const GIT_MAX_BUFFER = 64 * 1024 * 1024;
const PATH_DECODER = new TextDecoder("utf-8", { fatal: true });
const CHECK_NAMES = Object.freeze([
  "tracked-modified",
  "untracked",
  "unreachable-commits",
]);
const PASS_EXIT = exitCodeForS5Status("PASS");
const FAIL_EXIT = exitCodeForS5Status("FAIL");
const ERROR_EXIT = exitCodeForS5Status("ERROR");

export const HELP = `Usage:
  node Tools/verify-clone-drained.mjs <clonePath> [--authority <repoPath>] [--json]
  node Tools/verify-clone-drained.mjs --all <dir> [--prefix cesium-worker-] [--authority <repoPath>] [--json]
  node Tools/verify-clone-drained.mjs --help

A clone is DRAINED only when all three checks complete and pass:
  tracked-modified      no staged or unstaged tracked path differs from HEAD
  untracked             no untracked, non-ignored path exists
  unreachable-commits   clone HEAD is an ancestor of the authority tip

Defaults:
  --authority ${DEFAULT_AUTHORITY_PATH}
  --prefix    ${DEFAULT_CLONE_PREFIX}

Exit:
  0  provably drained
  1  divergence found; harvest every reported path and commit
  2  cannot determine; do not delete the clone`;

/**
 * Compare strings by their UTF-8 bytes.
 *
 * @param {string} left First string.
 * @param {string} right Second string.
 * @returns {number} Buffer comparison result.
 */
export function compareBytewise(left, right) {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function gitEnvironment() {
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(
      ([name]) => !name.toUpperCase().startsWith("GIT_"),
    ),
  );
  return {
    ...environment,
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_OPTIONAL_LOCKS: "0",
  };
}

function firstDiagnostic(result) {
  if (result?.error) {
    return result.error.code === "ETIMEDOUT"
      ? `timed out after ${GIT_TIMEOUT_MS} ms`
      : result.error.message;
  }
  if (result?.signal) {
    return `terminated by ${result.signal}`;
  }
  const stderr = Buffer.isBuffer(result?.stderr)
    ? result.stderr.toString("utf8")
    : String(result?.stderr ?? "");
  const line = stderr.split(/\r?\n/u).find((candidate) => candidate.trim());
  return line?.trim() || `exited ${String(result?.status)}`;
}

/**
 * Run a Git read without optional index locks or inherited filesystem monitors.
 * The command-local safe-directory declaration is exact to the requested repo
 * and does not write configuration.
 */
function runGit(repositoryPath, args, options = {}) {
  const resolved = path.resolve(repositoryPath);
  return spawnSync(
    "git",
    [
      "-c",
      `safe.directory=${resolved}`,
      "-c",
      "core.fsmonitor=false",
      "-c",
      "core.excludesFile=",
      "-C",
      repositoryPath,
      ...args,
    ],
    {
      encoding: null,
      env: gitEnvironment(),
      input: options.input,
      maxBuffer: GIT_MAX_BUFFER,
      stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      timeout: GIT_TIMEOUT_MS,
      windowsHide: true,
    },
  );
}

function rawCommitValidation(repositoryPath, sha) {
  const exists = runGit(repositoryPath, ["cat-file", "-e", sha]);
  if (!successful(exists)) {
    return {
      completed: false,
      error: `git cat-file could not read commit ${sha}: ${firstDiagnostic(exists)}`,
    };
  }
  const type = runGit(repositoryPath, ["cat-file", "-t", sha]);
  if (!successful(type)) {
    return {
      completed: false,
      error: `git cat-file could not identify commit ${sha}: ${firstDiagnostic(type)}`,
    };
  }
  const objectType = type.stdout.toString("utf8").trim();
  return objectType === "commit"
    ? { completed: true, error: null }
    : {
        completed: false,
        error: `git cat-file identified ${sha} as ${objectType || "an empty type"}, not a commit`,
      };
}

function successful(result) {
  return (
    result.error === undefined && result.signal === null && result.status === 0
  );
}

function repositoryFailure(label, message) {
  return {
    completed: false,
    label,
    error: `${label} ${message}`,
    head: null,
    path: null,
  };
}

function inspectRepository(repositoryPath, label, requireWorktree) {
  if (typeof repositoryPath !== "string" || repositoryPath.length === 0) {
    return repositoryFailure(label, "path is missing");
  }

  let stat;
  try {
    fs.accessSync(repositoryPath, fs.constants.R_OK);
    stat = fs.statSync(repositoryPath);
  } catch (error) {
    const absent = error?.code === "ENOENT";
    return repositoryFailure(
      label,
      absent
        ? `path does not exist: ${repositoryPath}`
        : `path is unreadable: ${repositoryPath} (${error.message})`,
    );
  }
  if (!stat.isDirectory()) {
    return repositoryFailure(
      label,
      `path is not a directory: ${repositoryPath}`,
    );
  }

  const probe = runGit(
    repositoryPath,
    requireWorktree
      ? ["rev-parse", "--is-inside-work-tree"]
      : ["rev-parse", "--git-dir"],
  );
  if (!successful(probe)) {
    return repositoryFailure(
      label,
      `is not a Git repository: ${repositoryPath} (${firstDiagnostic(probe)})`,
    );
  }
  if (
    requireWorktree &&
    probe.stdout.toString("utf8").trim().toLowerCase() !== "true"
  ) {
    return repositoryFailure(label, `is not a Git worktree: ${repositoryPath}`);
  }

  const headResult = runGit(repositoryPath, ["rev-parse", "--verify", "HEAD"]);
  if (!successful(headResult)) {
    return repositoryFailure(
      label,
      `has no readable HEAD commit: ${repositoryPath} (${firstDiagnostic(headResult)})`,
    );
  }
  const head = headResult.stdout.toString("utf8").trim().toLowerCase();
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(head)) {
    return repositoryFailure(
      label,
      `returned a malformed HEAD identity: ${head}`,
    );
  }
  const rawHead = rawCommitValidation(repositoryPath, head);
  if (!rawHead.completed) {
    return repositoryFailure(
      label,
      `has no readable HEAD commit: ${repositoryPath} (${rawHead.error})`,
    );
  }

  return {
    completed: true,
    error: null,
    head,
    label,
    path: path.resolve(repositoryPath),
  };
}

function splitNulRecords(bytes, commandLabel = "git status") {
  if (bytes.byteLength === 0) {
    return [];
  }
  const records = [];
  let start = 0;
  for (let index = 0; index < bytes.byteLength; index++) {
    if (bytes[index] !== 0) {
      continue;
    }
    records.push(bytes.subarray(start, index));
    start = index + 1;
  }
  if (start !== bytes.byteLength) {
    throw new Error(`${commandLabel} returned a non-NUL-terminated record`);
  }
  return records;
}

function decodePath(pathBytes) {
  try {
    return PATH_DECODER.decode(pathBytes);
  } catch {
    throw new Error("git status returned a path that is not valid UTF-8");
  }
}

/**
 * Parse porcelain-v1 NUL records without trimming the load-bearing X/Y bytes.
 * Rename and copy records carry their destination first and source second.
 *
 * @param {Buffer} bytes Raw `git status --porcelain=v1 -z` output.
 * @returns {Array<object>} Parsed status entries.
 */
export function parsePorcelainStatus(bytes) {
  if (!Buffer.isBuffer(bytes)) {
    throw new TypeError("porcelain status must be a Buffer");
  }
  const records = splitNulRecords(bytes, "git status");
  const entries = [];
  for (let index = 0; index < records.length; index++) {
    const record = records[index];
    if (record.byteLength < 4 || record[2] !== 0x20) {
      throw new Error("git status returned a malformed porcelain-v1 record");
    }
    const status = record.subarray(0, 2).toString("ascii");
    const pathBytes = Buffer.from(record.subarray(3));
    if (pathBytes.byteLength === 0) {
      throw new Error("git status returned an empty path");
    }
    let originalPathBytes = null;
    if (status.includes("R") || status.includes("C")) {
      index++;
      if (index >= records.length || records[index].byteLength === 0) {
        throw new Error(
          "git status omitted the source path for a rename or copy",
        );
      }
      originalPathBytes = Buffer.from(records[index]);
    }
    entries.push({
      originalPath:
        originalPathBytes === null ? null : decodePath(originalPathBytes),
      originalPathBytes,
      path: decodePath(pathBytes),
      pathBytes,
      status,
    });
  }
  return entries;
}

function indexTrustFlagsFor(repository) {
  const result = runGit(repository.path, ["ls-files", "-v", "-z"]);
  if (!successful(result)) {
    return {
      completed: false,
      error: `git ls-files failed in clone ${repository.path}: ${firstDiagnostic(result)}`,
      findings: [],
    };
  }
  try {
    const findings = splitNulRecords(result.stdout, "git ls-files")
      .map((record) => {
        if (record.byteLength < 3 || record[1] !== 0x20) {
          throw new Error("git ls-files returned a malformed tagged record");
        }
        const flag = record.subarray(0, 1).toString("ascii");
        const pathBytes = Buffer.from(record.subarray(2));
        if (pathBytes.byteLength === 0) {
          throw new Error("git ls-files returned an empty path");
        }
        return { flag, path: decodePath(pathBytes) };
      })
      .filter(({ flag }) => flag === "S" || /^[a-z]$/u.test(flag))
      .sort((left, right) => {
        const byPath = compareBytewise(left.path, right.path);
        return byPath !== 0 ? byPath : compareBytewise(left.flag, right.flag);
      });
    return { completed: true, error: null, findings };
  } catch (error) {
    return {
      completed: false,
      error: `cannot parse git ls-files in clone ${repository.path}: ${error.message}`,
      findings: [],
    };
  }
}

function statusSnapshotFor(clonePath, repository) {
  const cloneRepository =
    repository ?? inspectRepository(clonePath, "clone", true);
  if (!cloneRepository.completed) {
    return { completed: false, entries: [], error: cloneRepository.error };
  }
  const result = runGit(cloneRepository.path, [
    "status",
    "--porcelain=v1",
    "-z",
    "--untracked-files=all",
    "--ignore-submodules=none",
  ]);
  if (!successful(result)) {
    return {
      completed: false,
      entries: [],
      error: `git status failed in clone ${cloneRepository.path}: ${firstDiagnostic(result)}`,
    };
  }
  try {
    const indexTrustFlags = indexTrustFlagsFor(cloneRepository);
    if (!indexTrustFlags.completed) {
      return {
        completed: false,
        entries: [],
        error: indexTrustFlags.error,
        indexTrustFlags: [],
      };
    }
    return {
      completed: true,
      entries: parsePorcelainStatus(result.stdout),
      error: null,
      indexTrustFlags: indexTrustFlags.findings,
    };
  } catch (error) {
    return {
      completed: false,
      entries: [],
      error: `cannot parse git status in clone ${cloneRepository.path}: ${error.message}`,
      indexTrustFlags: [],
    };
  }
}

function incompleteCheck(name, error) {
  return { completed: false, error, findings: [], name, passed: false };
}

function completedCheck(name, findings) {
  return {
    completed: true,
    error: null,
    findings,
    name,
    passed: findings.length === 0,
  };
}

function compareStatusFindings(left, right) {
  const byPath = compareBytewise(left.path, right.path);
  if (byPath !== 0) {
    return byPath;
  }
  const byOriginal = compareBytewise(
    left.originalPath ?? "",
    right.originalPath ?? "",
  );
  return byOriginal !== 0
    ? byOriginal
    : compareBytewise(left.status, right.status);
}

/**
 * Check whether any tracked path differs from the clone's own HEAD.
 *
 * @param {string} clonePath Worker clone path.
 * @param {object} [options] Reusable aggregate snapshot.
 * @returns {object} Observable check result.
 */
export function checkTrackedModified(clonePath, options = {}) {
  const snapshot = options.snapshot ?? statusSnapshotFor(clonePath);
  if (!snapshot.completed) {
    return incompleteCheck("tracked-modified", snapshot.error);
  }
  if ((snapshot.indexTrustFlags ?? []).length > 0) {
    const flags = snapshot.indexTrustFlags
      .map(
        ({ flag, path: flaggedPath }) =>
          `${flag} ${JSON.stringify(flaggedPath)}`,
      )
      .join(", ");
    return incompleteCheck(
      "tracked-modified",
      `clone index trust flags can hide worktree changes: ${flags}`,
    );
  }
  const findings = snapshot.entries
    .filter(
      (entry) =>
        entry.status !== "??" &&
        entry.status !== "!!" &&
        (entry.status[0] !== " " || entry.status[1] !== " "),
    )
    .map((entry) => ({
      originalPath: entry.originalPath,
      path: entry.path,
      status: entry.status,
    }))
    .sort(compareStatusFindings);
  return completedCheck("tracked-modified", findings);
}

/**
 * Check whether any untracked, non-ignored path exists in the clone.
 *
 * @param {string} clonePath Worker clone path.
 * @param {object} [options] Reusable aggregate snapshot.
 * @returns {object} Observable check result.
 */
export function checkUntrackedFiles(clonePath, options = {}) {
  const snapshot = options.snapshot ?? statusSnapshotFor(clonePath);
  if (!snapshot.completed) {
    return incompleteCheck("untracked", snapshot.error);
  }
  const findings = snapshot.entries
    .filter((entry) => entry.status === "??")
    .map((entry) => ({ path: entry.path }))
    .sort((left, right) => compareBytewise(left.path, right.path));
  return completedCheck("untracked", findings);
}

function objectPresence(repository, sha) {
  const result = runGit(
    repository.path,
    ["cat-file", "--batch-check=%(objectname) %(objecttype)"],
    { input: Buffer.from(`${sha}\n`, "utf8") },
  );
  if (!successful(result)) {
    return {
      completed: false,
      error: `git cat-file failed in ${repository.label} ${repository.path}: ${firstDiagnostic(result)}`,
      missing: false,
    };
  }
  const response = result.stdout.toString("utf8").trim();
  if (response === `${sha} missing`) {
    return { completed: true, error: null, missing: true };
  }
  if (response === `${sha} commit`) {
    return { completed: true, error: null, missing: false };
  }
  return {
    completed: false,
    error: `${repository.label} object query returned an unexpected response: ${response}`,
    missing: false,
  };
}

function unreachableCommits(cloneRepository, authorityTip) {
  const authorityTipPresence = objectPresence(cloneRepository, authorityTip);
  if (!authorityTipPresence.completed) {
    return {
      completed: false,
      error: authorityTipPresence.error,
      findings: [],
    };
  }
  if (authorityTipPresence.missing) {
    const rawHead = rawCommitValidation(
      cloneRepository.path,
      cloneRepository.head,
    );
    return rawHead.completed
      ? {
          completed: true,
          error: null,
          findings: [{ sha: cloneRepository.head }],
        }
      : {
          completed: false,
          error: `clone HEAD cannot be reported as recoverable: ${rawHead.error}`,
          findings: [],
        };
  }
  const result = runGit(cloneRepository.path, [
    "rev-list",
    `${authorityTip}..HEAD`,
  ]);
  if (!successful(result)) {
    return {
      completed: false,
      error: `git rev-list failed in clone ${cloneRepository.path}: ${firstDiagnostic(result)}`,
      findings: [],
    };
  }
  const commits = result.stdout
    .toString("utf8")
    .split(/\r?\n/u)
    .filter((line) => line.length > 0);
  if (commits.length === 0) {
    return {
      completed: false,
      error:
        "git merge-base reported divergence but git rev-list enumerated no commits",
      findings: [],
    };
  }
  for (const sha of commits) {
    if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(sha)) {
      return {
        completed: false,
        error: `git rev-list returned a malformed commit identity: ${sha}`,
        findings: [],
      };
    }
    const rawCommit = rawCommitValidation(cloneRepository.path, sha);
    if (!rawCommit.completed) {
      return {
        completed: false,
        error: `git rev-list returned an unreadable commit ${sha}: ${rawCommit.error}`,
        findings: [],
      };
    }
  }
  return {
    completed: true,
    error: null,
    findings: commits.map((sha) => ({ sha })),
  };
}

/**
 * Check whether clone HEAD is reachable from the authority tip.
 *
 * @param {string} clonePath Worker clone path.
 * @param {string} [authorityPath] Authority repository path.
 * @param {object} [options] Reusable aggregate repository inspections.
 * @returns {object} Observable check result.
 */
export function checkReachability(
  clonePath,
  authorityPath = DEFAULT_AUTHORITY_PATH,
  options = {},
) {
  const cloneRepository =
    options.cloneRepository ?? inspectRepository(clonePath, "clone", true);
  if (!cloneRepository.completed) {
    return incompleteCheck("unreachable-commits", cloneRepository.error);
  }
  const authorityRepository =
    options.authorityRepository ??
    inspectRepository(authorityPath, "authority", false);
  if (!authorityRepository.completed) {
    return incompleteCheck("unreachable-commits", authorityRepository.error);
  }

  const mergeBase = runGit(authorityRepository.path, [
    "merge-base",
    "--is-ancestor",
    cloneRepository.head,
    authorityRepository.head,
  ]);
  if (successful(mergeBase)) {
    return completedCheck("unreachable-commits", []);
  }

  let divergence = mergeBase.error === undefined && mergeBase.status === 1;
  if (!divergence) {
    if (mergeBase.error || mergeBase.signal || mergeBase.status === null) {
      return incompleteCheck(
        "unreachable-commits",
        `git merge-base failed in authority ${authorityRepository.path}: ${firstDiagnostic(mergeBase)}`,
      );
    }
    const presence = objectPresence(authorityRepository, cloneRepository.head);
    if (!presence.completed) {
      return incompleteCheck("unreachable-commits", presence.error);
    }
    if (!presence.missing) {
      return incompleteCheck(
        "unreachable-commits",
        `git merge-base failed in authority ${authorityRepository.path}: ${firstDiagnostic(mergeBase)}`,
      );
    }
    divergence = true;
  }

  if (divergence) {
    const enumeration = unreachableCommits(
      cloneRepository,
      authorityRepository.head,
    );
    return enumeration.completed
      ? completedCheck("unreachable-commits", enumeration.findings)
      : incompleteCheck("unreachable-commits", enumeration.error);
  }
  return incompleteCheck(
    "unreachable-commits",
    "reachability check reached an unclassified state",
  );
}

/**
 * Fold check results using the shared PASS, FAIL, and ERROR exit table.
 *
 * @param {object[]} checks Check results consulted by the verdict.
 * @returns {number} Exact process exit code.
 */
export function exitCodeForChecks(checks) {
  if (checks.some((check) => !check.completed)) {
    return ERROR_EXIT;
  }
  if (checks.some((check) => check.findings.length > 0)) {
    return FAIL_EXIT;
  }
  return PASS_EXIT;
}

function outcomeForExitCode(exitCode) {
  if (exitCode === PASS_EXIT) {
    return "DRAINED";
  }
  if (exitCode === FAIL_EXIT) {
    return "NOT DRAINED";
  }
  return "CANNOT DETERMINE";
}

/**
 * Run all three required checks for one clone.
 *
 * @param {string} clonePath Worker clone path.
 * @param {object} [options] Authority path and reusable authority inspection.
 * @returns {object} Aggregate report.
 */
export function verifyCloneDrained(clonePath, options = {}) {
  const authorityPath = options.authorityPath ?? DEFAULT_AUTHORITY_PATH;
  const cloneRepository = inspectRepository(clonePath, "clone", true);
  const authorityRepository =
    options.authorityRepository ??
    inspectRepository(authorityPath, "authority", false);
  const snapshot = statusSnapshotFor(clonePath, cloneRepository);
  const reachabilityOptions = { cloneRepository, authorityRepository };
  const checkFactories = [
    ["tracked-modified", () => checkTrackedModified(clonePath, { snapshot })],
    ["untracked", () => checkUntrackedFiles(clonePath, { snapshot })],
    [
      "unreachable-commits",
      () => checkReachability(clonePath, authorityPath, reachabilityOptions),
    ],
  ];
  const checks = checkFactories.map(([expectedName, run]) => {
    try {
      const result = run();
      return result.name === expectedName
        ? result
        : incompleteCheck(
            expectedName,
            `check returned the wrong identity: ${String(result.name)}`,
          );
    } catch (error) {
      return incompleteCheck(expectedName, `check threw: ${error.message}`);
    }
  });
  const verdictChecks = checks;
  const exitCode = exitCodeForChecks(verdictChecks);
  const resolvedClonePath = path.resolve(clonePath);
  return {
    authorityHead: authorityRepository.head,
    authorityPath: path.resolve(authorityPath),
    checks,
    cloneHead: cloneRepository.head,
    cloneName: path.basename(resolvedClonePath),
    clonePath: resolvedClonePath,
    exitCode,
    outcome: outcomeForExitCode(exitCode),
  };
}

function worstExitCode(exitCodes) {
  if (exitCodes.includes(ERROR_EXIT)) {
    return ERROR_EXIT;
  }
  if (exitCodes.includes(FAIL_EXIT)) {
    return FAIL_EXIT;
  }
  return PASS_EXIT;
}

/**
 * Discover and verify every prefix-matching entry directly below a directory.
 * Matching non-directories remain rows and fail closed as invalid clone paths.
 *
 * @param {string} directory Parent directory.
 * @param {object} [options] Prefix and authority path.
 * @returns {object} Multi-clone report.
 */
export function verifyAllClones(directory, options = {}) {
  const prefix = options.prefix ?? DEFAULT_CLONE_PREFIX;
  const authorityPath = options.authorityPath ?? DEFAULT_AUTHORITY_PATH;
  const authorityRepository = inspectRepository(
    authorityPath,
    "authority",
    false,
  );
  const errors = [];
  let names = [];
  try {
    fs.accessSync(directory, fs.constants.R_OK);
    const stat = fs.statSync(directory);
    if (!stat.isDirectory()) {
      throw new Error(`scan path is not a directory: ${directory}`);
    }
    names = fs
      .readdirSync(directory, { withFileTypes: true })
      .map((entry) => entry.name)
      .filter((name) => name.startsWith(prefix))
      .sort(compareBytewise);
  } catch (error) {
    errors.push(
      `cannot enumerate clone directory ${directory}: ${error.message}`,
    );
  }
  if (names.length === 0) {
    errors.push(
      `no entries match prefix ${JSON.stringify(prefix)} in ${directory}`,
    );
  }

  const clones = names.map((name) =>
    verifyCloneDrained(path.join(directory, name), {
      authorityPath,
      authorityRepository,
    }),
  );
  const exitCode = worstExitCode([
    ...clones.map((clone) => clone.exitCode),
    ...(errors.length > 0 ? [ERROR_EXIT] : []),
  ]);
  return {
    authorityHead: authorityRepository.head,
    authorityPath: path.resolve(authorityPath),
    clones,
    directory: path.resolve(directory),
    errors,
    exitCode,
    outcome: outcomeForExitCode(exitCode),
    prefix,
  };
}

function displayPath(value) {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) {
      return JSON.stringify(value);
    }
  }
  return value;
}

function checkFor(report, name) {
  return report.checks.find((check) => check.name === name) ?? null;
}

function findingLines(name, finding, indent) {
  if (name === "tracked-modified") {
    const renamed = finding.originalPath
      ? `${displayPath(finding.originalPath)} -> `
      : "";
    return [
      `${indent}[${finding.status}] ${renamed}${displayPath(finding.path)}`,
    ];
  }
  if (name === "untracked") {
    return [`${indent}${displayPath(finding.path)}`];
  }
  return [`${indent}${finding.sha}`];
}

/**
 * Render one clone report with all three named groups.
 *
 * @param {object} report Aggregate report.
 * @returns {string} Human-readable report.
 */
export function renderCloneReport(report) {
  const lines = [
    `verify-clone-drained — ${report.cloneName}`,
    `clone: ${report.clonePath}`,
    `clone HEAD: ${report.cloneHead ?? "unavailable"}`,
    `authority: ${report.authorityPath}`,
    `authority tip: ${report.authorityHead ?? "unavailable"}`,
    `result: ${report.outcome} (exit ${report.exitCode})`,
  ];
  for (const name of CHECK_NAMES) {
    const check = checkFor(report, name);
    lines.push("");
    lines.push(
      check?.completed
        ? `${name} (${check.findings.length})`
        : `${name} (cannot determine)`,
    );
    if (!check) {
      lines.push("  check did not run");
    } else if (!check.completed) {
      lines.push(`  ${check.error}`);
    } else if (check.findings.length === 0) {
      lines.push("  (none)");
    } else {
      for (const finding of check.findings) {
        lines.push(...findingLines(name, finding, "  "));
      }
    }
  }
  lines.push("");
  if (report.exitCode === PASS_EXIT) {
    lines.push("DRAINED — every required check completed and passed.");
  } else if (report.exitCode === FAIL_EXIT) {
    lines.push(
      "NOT DRAINED — harvest every item above before deleting this clone.",
    );
  } else {
    lines.push("CANNOT DETERMINE — do not delete this clone.");
  }
  return lines.join("\n");
}

function tableLines(reports) {
  const countCell = (report, name) => {
    const check = checkFor(report, name);
    return check?.completed ? String(check.findings.length) : "?";
  };
  const rows = [
    [
      "clone",
      "result",
      "tracked-modified",
      "untracked",
      "unreachable-commits",
      "exit",
    ],
    ...reports.map((report) => [
      report.cloneName,
      report.outcome,
      countCell(report, "tracked-modified"),
      countCell(report, "untracked"),
      countCell(report, "unreachable-commits"),
      String(report.exitCode),
    ]),
  ];
  const widths = rows[0].map((_, column) =>
    Math.max(...rows.map((row) => row[column].length)),
  );
  const format = (row) =>
    row.map((cell, column) => cell.padEnd(widths[column])).join(" | ");
  return [
    format(rows[0]),
    widths.map((width) => "-".repeat(width)).join("-+-"),
    ...rows.slice(1).map(format),
  ];
}

/**
 * Render deterministic table and exact harvest details for a multi-clone run.
 *
 * @param {object} report Multi-clone report.
 * @returns {string} Human-readable report.
 */
export function renderAllReport(report) {
  const lines = [
    "verify-clone-drained --all",
    `directory: ${report.directory}`,
    `prefix: ${report.prefix}`,
    `authority: ${report.authorityPath}`,
    `authority tip: ${report.authorityHead ?? "unavailable"}`,
    "",
    ...tableLines(report.clones),
  ];
  for (const name of CHECK_NAMES) {
    lines.push("");
    lines.push(name);
    let found = false;
    for (const clone of report.clones) {
      const check = checkFor(clone, name);
      if (!check?.completed || check.findings.length === 0) {
        continue;
      }
      found = true;
      lines.push(`  ${clone.cloneName}`);
      for (const finding of check.findings) {
        lines.push(...findingLines(name, finding, "    "));
      }
    }
    if (!found) {
      lines.push("  (none)");
    }
  }

  const incomplete = report.clones.flatMap((clone) =>
    clone.checks
      .filter((check) => !check.completed)
      .map((check) => `${clone.cloneName} / ${check.name}: ${check.error}`),
  );
  if (report.errors.length > 0 || incomplete.length > 0) {
    lines.push("");
    lines.push("cannot-determine");
    for (const error of [...report.errors, ...incomplete]) {
      lines.push(`  ${error}`);
    }
  }
  lines.push("");
  if (report.exitCode === PASS_EXIT) {
    lines.push(
      "DRAINED — every clone completed and passed every required check.",
    );
  } else if (report.exitCode === FAIL_EXIT) {
    lines.push(
      "NOT DRAINED — harvest every listed item before deleting any affected clone.",
    );
  } else {
    lines.push(
      "CANNOT DETERMINE — do not treat this scan as proof that clones are drained.",
    );
  }
  return lines.join("\n");
}

/**
 * Parse the exact supported command line.
 *
 * @param {string[]} argv Arguments after the script name.
 * @returns {object} Parsed options.
 */
export function parseArgs(argv) {
  const options = {
    allDirectory: null,
    authorityPath: DEFAULT_AUTHORITY_PATH,
    clonePath: null,
    help: false,
    json: false,
    prefix: DEFAULT_CLONE_PREFIX,
  };
  const positionals = [];
  const seen = new Set();
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === "--help") {
      options.help = true;
      continue;
    }
    if (argument === "--json") {
      if (seen.has("--json")) {
        throw new Error("--json may be specified only once");
      }
      seen.add("--json");
      options.json = true;
      continue;
    }
    if (["--all", "--authority", "--prefix"].includes(argument)) {
      if (seen.has(argument)) {
        throw new Error(`${argument} may be specified only once`);
      }
      const value = argv[index + 1];
      if (value === undefined || value.length === 0 || value.startsWith("--")) {
        throw new Error(`${argument} requires a value`);
      }
      seen.add(argument);
      index++;
      if (argument === "--all") {
        options.allDirectory = value;
      } else if (argument === "--authority") {
        options.authorityPath = value;
      } else {
        options.prefix = value;
      }
      continue;
    }
    if (argument.startsWith("-")) {
      throw new Error(`unknown option ${argument}`);
    }
    positionals.push(argument);
  }
  if (options.help) {
    return options;
  }
  if (options.allDirectory !== null) {
    if (positionals.length > 0) {
      throw new Error("a clonePath cannot be combined with --all");
    }
  } else {
    if (seen.has("--prefix")) {
      throw new Error("--prefix requires --all");
    }
    if (positionals.length !== 1) {
      throw new Error("exactly one clonePath is required without --all");
    }
    options.clonePath = positionals[0];
  }
  return options;
}

/**
 * CLI entry point.
 *
 * @param {string[]} argv Arguments after the script name.
 * @returns {number} Process exit code.
 */
export function main(argv) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    if (argv.includes("--json")) {
      process.stdout.write(
        `${JSON.stringify(
          {
            error: error.message,
            exitCode: ERROR_EXIT,
            outcome: "CANNOT DETERMINE",
          },
          null,
          2,
        )}\n`,
      );
    } else {
      process.stderr.write(
        `verify-clone-drained: ${error.message}\n\n${HELP}\n`,
      );
    }
    return ERROR_EXIT;
  }
  if (options.help) {
    process.stdout.write(`${HELP}\n`);
    return PASS_EXIT;
  }

  const report =
    options.allDirectory === null
      ? verifyCloneDrained(options.clonePath, {
          authorityPath: options.authorityPath,
        })
      : verifyAllClones(options.allDirectory, {
          authorityPath: options.authorityPath,
          prefix: options.prefix,
        });
  process.stdout.write(
    options.json
      ? `${JSON.stringify(report, null, 2)}\n`
      : `${
          options.allDirectory === null
            ? renderCloneReport(report)
            : renderAllReport(report)
        }\n`,
  );
  return report.exitCode;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
