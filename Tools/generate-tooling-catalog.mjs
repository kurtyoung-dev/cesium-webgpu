#!/usr/bin/env node
// generate-tooling-catalog.mjs — regenerates the census half of the tooling
// catalog from the tree itself.
//
// @purpose Regenerates the TOOLING_CATALOG census section from @purpose/@status headers, git freshness and inbound refs; --check fails on drift.
// @status ACTIVE
//
// WHY THIS EXISTS. The .mjs library audit found 380 of 642 probes documented
// nowhere and four documented files that no longer existed. Ruling M2 answered
// that with self-registration: each file carries its own `@purpose` / `@status`
// header, and the catalog's census is GENERATED from those headers rather than
// hand-maintained. A hand-maintained index of a fleet that churns every batch
// is not a documentation problem that more discipline fixes — it is a
// freshness mechanism that does not exist.
//
// WHAT IT OWNS, AND WHAT IT MUST NOT TOUCH. Only the region between the
// `BEGIN GENERATED CENSUS` / `END GENERATED CENSUS` markers in
// `migration_doc/TOOLING_CATALOG.md`. The analyst report and the maintainer
// rulings above those markers are human prose and are copied through
// byte-for-byte; if the markers are missing the run exits 3 (STRUCTURAL)
// rather than guessing where the census starts.
//
// DRIFT IS VISIBLE, NOT SILENT. A file with no header is not omitted — it gets
// a row reading `NO @purpose HEADER`, because a census that quietly drops what
// it cannot classify is how 380 probes went dark in the first place. `--check`
// exits 1 when the regenerated census differs from the committed one, and
// prints whether the difference is structural (rows added/removed/reclassified)
// or only the git freshness column, so a reader can tell a real drift from a
// batch that touched a probe without regenerating.
//
// A header the parser can SEE but cannot READ is a different case, and it is
// a refusal rather than a row: an unterminated block comment, a duplicated
// tag, or a `@status` outside the known vocabulary exits 3 (STRUCTURAL) with
// every offending path named. Publishing it as `NO @purpose HEADER` would say
// the file declared nothing, when in fact it declared something unreadable.
// The cost is that one bad `@status` spelling in any one of the census files
// refuses the whole catalog for both `generate` and `--check`, so the typo has
// to be fixed before either can run. The fleet contract deliberately grades the
// same class more softly - `purposeHeaderViolations` reports an unknown
// `@status` as an ordinary per-file violation - because it is auditing files,
// while the census is certifying a published artifact.
//
// USAGE
//   node Tools/generate-tooling-catalog-launcher.cjs            # rewrite
//   node Tools/generate-tooling-catalog-launcher.cjs --check    # check
//   node Tools/generate-tooling-catalog-launcher.cjs --stdout   # print only
//
// EXIT CODES
//   0  written, or --check found no drift
//   1  --check found drift
//   2  the generator itself failed
//   3  STRUCTURAL: candidate binding/markers/scope cannot certify a census,
//      or a census file's header exists but cannot be parsed (offending
//      paths are named on stderr)

import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { parsePurposeHeader } from "./lib/purpose-header.mjs";

const CANDIDATE_RUNTIME_ENV = "TOOLING_CATALOG_CANDIDATE_RUNTIME";
const TRUSTED_LAUNCHER_ENV = "TOOLING_CATALOG_TRUSTED_LAUNCHER";
const RECEIPT_CHALLENGE_ENV = "TOOLING_CATALOG_RECEIPT_CHALLENGE";
const RECEIPT_FD_ENV = "TOOLING_CATALOG_RECEIPT_FD";
const RECEIPT_SUBJECT_ENV = "TOOLING_CATALOG_RECEIPT_SUBJECT";
const RECEIPT_SCHEMA = "tooling-catalog-completion-v1";
const CANDIDATE_ROOT_ENV = "TOOLING_CATALOG_ROOT";
const CANDIDATE_HEAD_ENV = "TOOLING_CATALOG_CANDIDATE_HEAD";
const HISTORY_GIT_DIR_ENV = "TOOLING_CATALOG_HISTORY_GIT_DIR";
const HISTORY_OBJECT_DIR_ENV = "TOOLING_CATALOG_HISTORY_OBJECT_DIR";
const HISTORY_ALTERNATES_ENV = "TOOLING_CATALOG_HISTORY_ALTERNATES";
const HISTORY_CONFIG_ENV = "TOOLING_CATALOG_HISTORY_CONFIG";
const ROOT = process.env[CANDIDATE_ROOT_ENV]
  ? path.resolve(process.env[CANDIDATE_ROOT_ENV])
  : path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const CATALOG = path.join(ROOT, "migration_doc", "TOOLING_CATALOG.md");
const CATALOG_REL = "migration_doc/TOOLING_CATALOG.md";
const RUNTIME_BINDINGS = Object.freeze([
  "Tools/generate-tooling-catalog.mjs",
  "Tools/lib/purpose-header.mjs",
]);

/*
 * Capture the raw files at module initialization. A later filesystem read does
 * not identify the code Node already loaded: another process can replace a
 * dirty launcher with candidate bytes while the census is running. Git clean
 * filters are intentionally absent too; candidate binding is a byte identity,
 * not a prediction of what a later `git add` would store.
 */
const INITIAL_RUNTIME_BYTES = new Map([
  [RUNTIME_BINDINGS[0], readFileSync(fileURLToPath(import.meta.url))],
  [
    RUNTIME_BINDINGS[1],
    readFileSync(
      fileURLToPath(new URL("./lib/purpose-header.mjs", import.meta.url)),
    ),
  ],
]);

/** Structural candidate ineligibility, distinct from an unreadable object. */
export class CandidateStructureError extends Error {
  constructor(message) {
    super(message);
    this.name = "CandidateStructureError";
  }
}

export const BEGIN_MARKER =
  "<!-- BEGIN GENERATED CENSUS — regenerate with `node Tools/generate-tooling-catalog-launcher.cjs`; edits inside this region are overwritten -->";
export const END_MARKER = "<!-- END GENERATED CENSUS -->";

/** Directories whose `.mjs` files make up the tooling library. */
const CENSUS_ROOTS = Object.freeze(["Tools", "scripts"]);

/** The path segment that marks a tool already retired out of the live fleet. */
const ARCHIVE_SEGMENT = "archive";

/**
 * The pinned fleet-contract census. A probe listed there cannot be moved by a
 * bare `git mv`: `probe-fleet-contract.spec.mjs` fails on a stale row, so the
 * row has to be deleted in the same change. The archive plan reports that
 * membership as its own column rather than folding it into the live-reference
 * count, where it would mark every listed probe as still referenced.
 */
const FLEET_CONTRACT_ALLOWLIST =
  "Tools/visual-regression/lib/probe-fleet-contract-allowlist.mjs";

/** Header statuses that nominate a census file for the archive plan. */
const ARCHIVE_PLAN_STATUSES = Object.freeze([
  "INVESTIGATION",
  "ARCHIVED-CANDIDATE",
]);

/** Where an inbound reference to a tooling file can legitimately come from. */
const REF_ROOTS = Object.freeze([
  "Tools",
  "scripts",
  "migration_doc",
  ".husky",
]);

/** Single files outside those roots that also reference tooling by path. */
const REF_FILES = Object.freeze(["package.json", "lint-staged.config.js"]);

/**
 * Compare two strings by UTF-16 code unit.
 *
 * Every ordering that reaches the rendered census goes through here rather
 * than locale collation. The rendered region is byte-compared by `--check`,
 * so a collation-dependent order would let a small-ICU or differently
 * collated Node reorder rows with no source change at all - reported as
 * structural drift with nothing in the diff to explain it. Code-unit order is
 * the same everywhere Node runs.
 *
 * @param {string} a First value.
 * @param {string} b Second value.
 * @returns {number} Negative, zero or positive.
 */
function byCodeUnit(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * The catalog quotes every file name in its own census, so counting itself
 * would give every file exactly one phantom inbound reference.
 */
const REF_EXCLUDED = Object.freeze([
  "migration_doc/TOOLING_CATALOG.md",
  // The banked audit rows name every file too - a census, not a consumer.
  "Tools/tooling-catalog-audit-rows-2026-08-15.json",
]);

/** Extensions worth scanning for inbound references. */
const REF_EXTENSIONS = Object.freeze([
  ".mjs",
  ".js",
  ".cjs",
  ".ts",
  ".html",
  ".json",
  ".md",
  ".yml",
  ".yaml",
  ".txt",
  ".sh",
  "",
]);

/**
 * Whether a tracked path is a plausible text source of tooling references.
 * Exported so the extension boundary has a direct, mutation-sensitive test.
 *
 * @param {string} rel Repo-relative path.
 * @returns {boolean} True when the path is scanned for inbound references.
 */
export function isReferenceSourcePath(rel) {
  return REF_EXTENSIONS.includes(path.posix.extname(rel));
}

/**
 * List paths tracked by the candidate Git index.
 *
 * The previous filesystem walk admitted ignored output helpers and unrelated
 * untracked files into the committed census. That made the catalog impossible
 * to reproduce from its own commit. The index is the exact prospective tree
 * used by an authorized landing, so it is the only honest census boundary.
 *
 * @param {string[]} scopes Repo-relative pathspecs.
 * @param {string} [root] Repository root; injectable for hermetic tests.
 * @returns {string[]} Repo-relative, slash-separated tracked paths.
 */
export function listTrackedPaths(scopes, root = ROOT) {
  try {
    const output = execFileSync(
      "git",
      ["ls-files", "-z", "--cached", "--", ...scopes],
      {
        cwd: root,
        env: { ...process.env, GIT_NO_REPLACE_OBJECTS: "1" },
        encoding: "utf8",
        maxBuffer: 256 * 1024 * 1024,
      },
    );
    return parseTrackedPathList(output);
  } catch (error) {
    throw new Error(
      `cannot enumerate the candidate Git index: ${error?.message ?? error}`,
      { cause: error },
    );
  }
}

/**
 * Parse Git's NUL-framed path list without rewriting path bytes. Git emits `/`
 * for directory separators on every platform; a literal backslash is therefore
 * part of a distinct repository path and must never alias a slash path.
 *
 * @param {string} output Raw `git ls-files -z` output.
 * @returns {string[]} Exact sorted Git path identities.
 */
export function parseTrackedPathList(output) {
  return output.split("\0").filter(Boolean).sort();
}

/**
 * Parse NUL-framed `git ls-files --stage -z` output for an exact requested set.
 * Paths stay opaque: LF is data inside a record, never a record delimiter.
 *
 * @param {string} staged Raw NUL-framed index listing.
 * @param {string[]} paths Exact requested repo-relative paths.
 * @returns {Map<string, {mode: string, oid: string}>} Stage-zero entries.
 */
export function parseCandidateIndexEntries(staged, paths) {
  const requested = new Set(paths);
  if (requested.size !== paths.length) {
    throw new CandidateStructureError(
      "candidate index read contains duplicate paths",
    );
  }
  const objectIds = new Map();
  for (const entry of staged.split("\0").filter(Boolean)) {
    const tab = entry.indexOf("\t");
    const header = tab === -1 ? "" : entry.slice(0, tab);
    const rel = tab === -1 ? "" : entry.slice(tab + 1);
    if (!requested.has(rel)) {
      continue;
    }
    const match = /^(\d{6}) ([0-9a-f]{40,64}) ([0-3])$/.exec(header);
    if (match === null || match[3] !== "0" || objectIds.has(rel)) {
      throw new CandidateStructureError(
        `candidate index entry for ${JSON.stringify(rel)} is unresolved`,
      );
    }
    objectIds.set(rel, { mode: match[1], oid: match[2] });
  }
  for (const rel of paths) {
    if (!objectIds.has(rel)) {
      throw new CandidateStructureError(
        `candidate index has no stage-zero entry for ${JSON.stringify(rel)}`,
      );
    }
  }
  return objectIds;
}

/**
 * Resolve exact stage-zero entries for requested candidate-index paths.
 *
 * @param {string[]} paths Repo-relative tracked paths.
 * @param {string} [root] Repository root; injectable for hermetic tests.
 * @returns {Map<string, {mode: string, oid: string}>} Candidate entries.
 */
export function readCandidateIndexEntries(paths, root = ROOT) {
  let staged;
  try {
    staged = execFileSync("git", ["ls-files", "--stage", "-z"], {
      cwd: root,
      env: { ...process.env, GIT_NO_REPLACE_OBJECTS: "1" },
      encoding: "utf8",
      maxBuffer: 512 * 1024 * 1024,
    });
  } catch (error) {
    throw new Error(
      `cannot read candidate index entries: ${error?.message ?? error}`,
      { cause: error },
    );
  }
  return parseCandidateIndexEntries(staged, paths);
}

/**
 * Require ordinary stage-zero files before any candidate blob is read.
 * Missing/unmerged/type-mismatched subjects are structurally ineligible;
 * object corruption is deliberately left to the blob reader and is ERROR.
 *
 * @param {string[]} paths Exact candidate paths.
 * @param {string} [root] Repository root.
 * @returns {string[]} Structural eligibility failures.
 */
export function regularCandidatePathReasons(paths, root = ROOT) {
  let entries;
  try {
    entries = readCandidateIndexEntries(paths, root);
  } catch (error) {
    if (error instanceof CandidateStructureError) {
      return [error.message];
    }
    throw error;
  }
  const reasons = [];
  for (const rel of paths) {
    const mode = entries.get(rel)?.mode;
    if (!["100644", "100755"].includes(mode)) {
      reasons.push(
        `candidate index path ${JSON.stringify(rel)} has non-regular mode ${mode ?? "missing"}`,
      );
    }
  }
  return reasons;
}

/**
 * Capture the logical candidate index in Git's NUL-framed stage format.
 * One `ls-files` invocation observes one atomically published index version,
 * including a logical expansion of split/sparse storage details.
 *
 * @param {string} [root] Repository root.
 * @param {NodeJS.ProcessEnv} [env] Git environment selecting the index.
 * @returns {Buffer} Exact logical stage-zero/staged-entry snapshot.
 */
export function readCandidateIndexSnapshot(root = ROOT, env = process.env) {
  try {
    return execFileSync("git", ["ls-files", "--stage", "-z"], {
      cwd: root,
      env,
      maxBuffer: 512 * 1024 * 1024,
    });
  } catch (error) {
    throw new Error(
      `cannot snapshot the candidate Git index: ${error?.message ?? error}`,
      { cause: error },
    );
  }
}

/**
 * Resolve the exact commit whose history supplies the freshness column.
 * Replacement objects are irrelevant to ref identity and are disabled.
 *
 * @param {string} [root] Repository root.
 * @param {NodeJS.ProcessEnv} [env] Git environment.
 * @returns {string} Full commit object ID.
 */
export function readCandidateHead(root = ROOT, env = process.env) {
  try {
    return execFileSync("git", ["rev-parse", "--verify", "HEAD^{commit}"], {
      cwd: root,
      env: { ...env, GIT_NO_REPLACE_OBJECTS: "1" },
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
    }).trim();
  } catch (error) {
    throw new Error(
      `cannot resolve candidate HEAD: ${error?.message ?? error}`,
      { cause: error },
    );
  }
}

/**
 * Check whether Git can supply canonical, complete history for last-touch
 * dates. Replacement objects are disabled separately; legacy grafts and
 * shallow boundaries must be rejected because both silently rewrite or
 * truncate history while leaving ordinary Git commands successful.
 *
 * @param {string} [root] Repository root.
 * @param {NodeJS.ProcessEnv} [env] Candidate Git environment.
 * @returns {string[]} Structural prerequisite failures.
 */
export function canonicalHistoryPrerequisiteReasons(
  root = ROOT,
  env = process.env,
) {
  const safeEnv = { ...env, GIT_NO_REPLACE_OBJECTS: "1" };
  let shallow;
  let graftPathText;
  try {
    shallow = execFileSync("git", ["rev-parse", "--is-shallow-repository"], {
      cwd: root,
      env: safeEnv,
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
    }).trim();
    graftPathText = execFileSync(
      "git",
      ["rev-parse", "--git-path", "info/grafts"],
      {
        cwd: root,
        env: safeEnv,
        encoding: "utf8",
        maxBuffer: 1024 * 1024,
      },
    ).trim();
  } catch (error) {
    throw new Error(
      `cannot inspect canonical Git history prerequisites: ${error?.message ?? error}`,
      { cause: error },
    );
  }
  if (shallow !== "true" && shallow !== "false") {
    throw new Error(`Git returned an invalid shallow-state value: ${shallow}`);
  }

  const reasons = [];
  if (shallow === "true") {
    reasons.push("candidate Git history is shallow");
  }
  const graftPath = path.isAbsolute(graftPathText)
    ? graftPathText
    : path.resolve(root, graftPathText);
  try {
    if (readFileSync(graftPath).length > 0) {
      reasons.push("candidate Git history has a nonempty info/grafts file");
    }
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw new Error(
        `cannot inspect candidate graft file ${graftPath}: ${error?.message ?? error}`,
        { cause: error },
      );
    }
  }
  return reasons;
}

/**
 * Build a private, graft-free and shallow-free Git metadata directory for the
 * freshness walk. The commit is addressed by its frozen object ID and the
 * original content-addressed object store is read only through alternates.
 * Mutating the candidate repository's `shallow` or `info/grafts` files while
 * `git log` runs therefore cannot alter the dates and disappear before the
 * terminal prerequisite check.
 *
 * @param {string} root Candidate repository root.
 * @param {NodeJS.ProcessEnv} candidateEnv Candidate Git environment.
 * @param {string} privateRoot Private subject directory.
 * @returns {NodeJS.ProcessEnv} Isolated history environment.
 */
export function createIsolatedHistoryEnvironment(
  root,
  candidateEnv,
  privateRoot,
) {
  let objectDirectory = candidateEnv.GIT_OBJECT_DIRECTORY;
  if (objectDirectory === undefined || objectDirectory === "") {
    try {
      objectDirectory = execFileSync(
        "git",
        ["rev-parse", "--path-format=absolute", "--git-path", "objects"],
        {
          cwd: root,
          env: { ...candidateEnv, GIT_NO_REPLACE_OBJECTS: "1" },
          encoding: "utf8",
          maxBuffer: 1024 * 1024,
        },
      ).trim();
    } catch (error) {
      throw new Error(
        `cannot resolve candidate object directory: ${error?.message ?? error}`,
        { cause: error },
      );
    }
  }
  if (!path.isAbsolute(objectDirectory)) {
    objectDirectory = path.resolve(root, objectDirectory);
  }

  const historyGitDir = path.join(privateRoot, "history.git");
  const emptyGlobalConfig = path.join(privateRoot, "empty.gitconfig");
  writeFileSync(emptyGlobalConfig, "");
  const initEnv = { ...candidateEnv };
  for (const name of [
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    "GIT_COMMON_DIR",
    "GIT_DIR",
    "GIT_INDEX_FILE",
    "GIT_OBJECT_DIRECTORY",
    "GIT_REPLACE_REF_BASE",
    "GIT_SHALLOW_FILE",
    "GIT_WORK_TREE",
  ]) {
    delete initEnv[name];
  }
  initEnv.GIT_CONFIG_GLOBAL = emptyGlobalConfig;
  initEnv.GIT_CONFIG_NOSYSTEM = "1";
  initEnv.GIT_NO_REPLACE_OBJECTS = "1";
  try {
    execFileSync("git", ["init", "--bare", "--quiet", historyGitDir], {
      cwd: privateRoot,
      env: initEnv,
      maxBuffer: 16 * 1024 * 1024,
    });
  } catch (error) {
    throw new Error(
      `cannot initialize isolated history metadata: ${error?.message ?? error}`,
      { cause: error },
    );
  }

  const existingAlternates =
    candidateEnv.GIT_ALTERNATE_OBJECT_DIRECTORIES ?? "";
  return {
    ...initEnv,
    GIT_ALTERNATE_OBJECT_DIRECTORIES: [objectDirectory, existingAlternates]
      .filter(Boolean)
      .join(path.delimiter),
    GIT_DIR: historyGitDir,
    GIT_OBJECT_DIRECTORY: path.join(historyGitDir, "objects"),
  };
}

/**
 * Materialize one full private index and execute a synchronous callback with
 * every nested Git command bound to it. The original candidate index and HEAD
 * remain separately identifiable for the exit-time currency check.
 *
 * @template T
 * @param {(subject: object) => T} callback Synchronous census operation.
 * @param {string} [root] Repository root.
 * @returns {T} Callback result.
 */
export function withFrozenCandidateIndex(callback, root = ROOT) {
  const originalEnv = { ...process.env };
  const candidateEnv = {
    ...originalEnv,
    GIT_NO_REPLACE_OBJECTS: "1",
  };
  const physicalIndexState = readCandidatePhysicalIndexState(
    root,
    candidateEnv,
  );
  const indexSnapshot = readCandidateIndexSnapshot(root, candidateEnv);
  const head = readCandidateHead(root, candidateEnv);
  const historyPrerequisiteReasons = canonicalHistoryPrerequisiteReasons(
    root,
    candidateEnv,
  );
  const privateRoot = mkdtempSync(
    path.join(tmpdir(), "tooling-catalog-index-"),
  );
  const privateIndex = path.join(privateRoot, "index");
  const privateEnv = {
    ...candidateEnv,
    GIT_INDEX_FILE: privateIndex,
  };
  const priorIndex = process.env.GIT_INDEX_FILE;
  const priorNoReplace = process.env.GIT_NO_REPLACE_OBJECTS;
  try {
    execFileSync("git", ["update-index", "-z", "--index-info"], {
      cwd: root,
      env: privateEnv,
      input: indexSnapshot,
      maxBuffer: 512 * 1024 * 1024,
    });
    execFileSync("git", ["update-index", "--no-split-index"], {
      cwd: root,
      env: privateEnv,
      maxBuffer: 16 * 1024 * 1024,
    });
    const historyEnv = createIsolatedHistoryEnvironment(
      root,
      candidateEnv,
      privateRoot,
    );
    process.env.GIT_INDEX_FILE = privateIndex;
    process.env.GIT_NO_REPLACE_OBJECTS = "1";
    return callback({
      head,
      historyEnv,
      historyPrerequisiteReasons,
      indexPrerequisiteReasons: physicalIndexState.reasons,
      indexSnapshot,
      originalEnv: candidateEnv,
      privateIndex,
      privateRoot,
      physicalIndexFiles: physicalIndexState.files,
      root,
    });
  } finally {
    if (priorIndex === undefined) {
      delete process.env.GIT_INDEX_FILE;
    } else {
      process.env.GIT_INDEX_FILE = priorIndex;
    }
    if (priorNoReplace === undefined) {
      delete process.env.GIT_NO_REPLACE_OBJECTS;
    } else {
      process.env.GIT_NO_REPLACE_OBJECTS = priorNoReplace;
    }
    rmSync(privateRoot, { recursive: true, force: true });
  }
}

/**
 * Detect whether the prospective index or the HEAD used for freshness moved
 * after the private snapshot was taken.
 *
 * @param {object} subject Frozen subject from {@link withFrozenCandidateIndex}.
 * @returns {string[]} Structural currency failures.
 */
export function candidateSubjectDriftReasons(subject) {
  const reasons = [];
  for (const reason of subject.indexPrerequisiteReasons ?? []) {
    reasons.push(`candidate index prerequisite is ineligible: ${reason}`);
  }
  for (const reason of subject.historyPrerequisiteReasons ?? []) {
    reasons.push(`candidate history prerequisite is ineligible: ${reason}`);
  }
  const currentIndex = readCandidateIndexSnapshot(
    subject.root,
    subject.originalEnv,
  );
  if (!currentIndex.equals(subject.indexSnapshot)) {
    reasons.push("candidate Git index changed during census construction");
  }
  const currentPhysicalIndex = readCandidatePhysicalIndexState(
    subject.root,
    subject.originalEnv,
  );
  for (const reason of currentPhysicalIndex.reasons) {
    reasons.push(`candidate index prerequisite is ineligible: ${reason}`);
  }
  const initialPhysical = subject.physicalIndexFiles ?? new Map();
  if (
    initialPhysical.size !== currentPhysicalIndex.files.size ||
    [...initialPhysical].some(
      ([pathname, bytes]) =>
        !currentPhysicalIndex.files.get(pathname)?.equals(bytes),
    )
  ) {
    reasons.push(
      "candidate physical Git index changed during census construction",
    );
  }
  const currentHead = readCandidateHead(subject.root, subject.originalEnv);
  if (currentHead !== subject.head) {
    reasons.push(
      `candidate HEAD changed during census construction (${subject.head} -> ${currentHead})`,
    );
  }
  for (const reason of canonicalHistoryPrerequisiteReasons(
    subject.root,
    subject.originalEnv,
  )) {
    reasons.push(`candidate history prerequisite is ineligible: ${reason}`);
  }
  return reasons;
}

/**
 * Read tracked candidate bytes from the Git index in one batch.
 *
 * Reading the ordinary filesystem here would let unrelated dirty work alter a
 * catalog that is later committed without that work. Index blobs make both the
 * subject list and its parsed purposes/references reproduce the landing tree.
 *
 * @param {string[]} paths Repo-relative tracked paths.
 * @param {string} [root] Repository root; injectable for hermetic tests.
 * @returns {Map<string, string>} Path -> UTF-8 index contents.
 */
export function readCandidateFileBuffers(paths, root = ROOT) {
  const result = new Map();
  if (paths.length === 0) {
    return result;
  }
  const objectIds = readCandidateIndexEntries(paths, root);

  let output;
  try {
    output = execFileSync("git", ["cat-file", "--batch"], {
      cwd: root,
      env: { ...process.env, GIT_NO_REPLACE_OBJECTS: "1" },
      // Object IDs are fixed-width hexadecimal tokens. Unlike `:path`, they
      // cannot contain LF and therefore cannot corrupt the batch protocol.
      input: `${paths.map((rel) => objectIds.get(rel).oid).join("\n")}\n`,
      maxBuffer: 512 * 1024 * 1024,
    });
  } catch (error) {
    throw new Error(
      `cannot read candidate index blobs: ${error?.message ?? error}`,
      { cause: error },
    );
  }

  let offset = 0;
  for (const rel of paths) {
    const headerEnd = output.indexOf(0x0a, offset);
    if (headerEnd === -1) {
      throw new Error(`truncated Git batch header for ${rel}`);
    }
    const header = output.subarray(offset, headerEnd).toString("utf8");
    const match = /^([0-9a-f]{40,64}) blob (\d+)$/.exec(header);
    if (match === null || match[1] !== objectIds.get(rel).oid) {
      throw new Error(`candidate object for ${rel} is not the expected blob`);
    }
    const size = Number(match[2]);
    const contentStart = headerEnd + 1;
    const contentEnd = contentStart + size;
    if (
      !Number.isSafeInteger(size) ||
      size < 0 ||
      contentEnd >= output.length
    ) {
      throw new Error(`candidate blob for ${rel} has invalid framing`);
    }
    result.set(rel, Buffer.from(output.subarray(contentStart, contentEnd)));
    if (output[contentEnd] !== 0x0a) {
      throw new Error(`candidate blob for ${rel} lacks a batch terminator`);
    }
    offset = contentEnd + 1;
  }
  if (offset !== output.length) {
    throw new Error("candidate blob batch contains unrequested trailing data");
  }
  return result;
}

/**
 * Read tracked candidate bytes as UTF-8 strings.
 *
 * @param {string[]} paths Repo-relative tracked paths.
 * @param {string} [root] Repository root; injectable for hermetic tests.
 * @returns {Map<string, string>} Path -> UTF-8 index contents.
 */
export function readTrackedFiles(paths, root = ROOT) {
  const result = new Map();
  for (const [rel, bytes] of readCandidateFileBuffers(paths, root)) {
    result.set(rel, bytes.toString("utf8"));
  }
  return result;
}

function normalizeBootstrapLineEndings(bytes) {
  const normalized = Buffer.allocUnsafe(bytes.length);
  let write = 0;
  for (let read = 0; read < bytes.length; read++) {
    if (bytes[read] === 0x0d && bytes[read + 1] === 0x0a) {
      continue;
    }
    normalized[write++] = bytes[read];
  }
  return normalized.subarray(0, write);
}

/**
 * Compare the executing implementation and its parser dependency to the exact
 * candidate-index blobs they purport to certify.
 *
 * @param {string[]} [paths] Runtime files that define the census semantics.
 * @param {string} [root] Repository root.
 * @param {Map<string, Buffer>} [loadedBytes] Raw bytes captured at module initialization.
 * @returns {string[]} Structural mismatch reasons.
 */
export function runtimeCandidateBindingReasons(
  paths = RUNTIME_BINDINGS,
  root = ROOT,
  loadedBytes = INITIAL_RUNTIME_BYTES,
  allowBootstrapLineEndings = process.env[CANDIDATE_RUNTIME_ENV] !== "1",
) {
  const reasons = regularCandidatePathReasons(paths, root);
  if (reasons.length > 0) {
    return reasons;
  }
  const candidateBytes = readCandidateFileBuffers(paths, root);
  for (const rel of paths) {
    const loaded = loadedBytes.get(rel);
    const candidate = candidateBytes.get(rel);
    const bootstrapEquivalent =
      allowBootstrapLineEndings &&
      Buffer.isBuffer(loaded) &&
      Buffer.isBuffer(candidate) &&
      normalizeBootstrapLineEndings(loaded).equals(candidate);
    if (
      !Buffer.isBuffer(loaded) ||
      !Buffer.isBuffer(candidate) ||
      (!loaded.equals(candidate) && !bootstrapEquivalent)
    ) {
      reasons.push(
        `${rel} module-initialization bytes do not match the candidate-index bootstrap`,
      );
    }
  }
  return reasons;
}

/**
 * Replace the worktree catalog only if it is byte-identical to the snapshot
 * read before census construction. A concurrent prose edit must never be
 * silently overwritten by the several-second generation pass.
 *
 * @param {string} expected Initial worktree catalog bytes.
 * @param {string} replacement Complete replacement bytes.
 * @param {() => string} [readCurrent] Injectable final read.
 * @param {(value: string) => void} [writeReplacement] Injectable writer.
 * @returns {boolean} True only when the replacement was written.
 */
export function writeCatalogIfUnchanged(
  expected,
  replacement,
  readCurrent = () => readFileSync(CATALOG, "utf8"),
  writeReplacement = (value) => writeFileSync(CATALOG, value),
) {
  if (readCurrent() !== expected) {
    return false;
  }
  writeReplacement(replacement);
  return true;
}

/**
 * Every `.mjs` file in the census scope.
 *
 * @returns {string[]} Repo-relative paths, sorted.
 */
export function listToolingFiles() {
  return listTrackedPaths(CENSUS_ROOTS).filter((rel) => rel.endsWith(".mjs"));
}

/**
 * Reject path identities the Markdown catalog cannot encode losslessly, and
 * require every `.mjs` census subject to be an ordinary stage-zero file.
 * The Git readers themselves preserve these bytes (including NUL-framed
 * history); this explicit boundary prevents two identities from collapsing in
 * rendered rows.
 *
 * @param {string} [root] Repository root.
 * @returns {string[]} Structural census prerequisite failures.
 */
export function candidateCensusPrerequisiteReasons(root = ROOT) {
  const allPaths = listTrackedPaths(
    [...new Set([...CENSUS_ROOTS, ...REF_ROOTS, ...REF_FILES])],
    root,
  );
  const reasons = [];
  for (const rel of allPaths) {
    if (
      [...rel].some((character) => {
        const code = character.codePointAt(0);
        return character === "\\" || code <= 0x1f || code === 0x7f;
      })
    ) {
      reasons.push(
        `candidate Git path ${JSON.stringify(rel)} cannot be represented losslessly in the Markdown census`,
      );
    }
  }
  const censusPaths = allPaths.filter(
    (rel) =>
      rel.endsWith(".mjs") &&
      CENSUS_ROOTS.some(
        (scope) => rel === scope || rel.startsWith(`${scope}/`),
      ),
  );
  reasons.push(...regularCandidatePathReasons(censusPaths, root));
  return reasons;
}

/**
 * Class of a file, from its `@class` tag when it has one and its path when it
 * does not.
 *
 * The path fallback reproduces the audit's naming conventions, which are the
 * conventions the fleet actually follows: `probe-` diagnostics, `.spec.mjs`
 * guards, `lib/*-gate.mjs` gate libraries, `*-bake/` bake tools.
 *
 * @param {string} rel Repo-relative path.
 * @param {string|null} declared The file's `@class` tag, if any.
 * @returns {string} Class name.
 */
export function classify(rel, declared) {
  if (declared) {
    return declared;
  }
  const base = path.posix.basename(rel);
  if (base.endsWith(".spec.mjs")) {
    return "spec";
  }
  if (rel.includes("/fixtures/")) {
    return "fixture";
  }
  if (rel.includes("/lib/")) {
    return base.endsWith("-gate.mjs") ? "gate-lib" : "lib";
  }
  if (base.startsWith("probe-")) {
    return "probe";
  }
  if (/-bake\//.test(rel) || base.startsWith("bake-")) {
    return "bake-tool";
  }
  if (base.startsWith("run-") || base.startsWith("capture-")) {
    return "runner";
  }
  if (rel.includes("/output/")) {
    return "scratch";
  }
  return "other";
}

/**
 * Last commit date per file, from ONE `git log` pass.
 *
 * Per-file `git log` calls would be ~990 process spawns; on Windows that alone
 * takes minutes, which is how a freshness tool stops being run.
 *
 * @param {NodeJS.ProcessEnv} [env] Isolated history environment.
 * @param {string} [root] Repository root for the Git process.
 * @returns {Map<string, string>} Repo-relative path -> ISO date.
 */
export function lastTouchDates(head = "HEAD", env = process.env, root = ROOT) {
  try {
    const output = execFileSync(
      "git",
      [
        "log",
        "--name-only",
        "-z",
        // 00 separates the pretty record; 01 tags its date; 02 plus Git's
        // mandatory LF tags the first path. All following paths are NUL
        // records, so LF and backslash remain ordinary path bytes.
        "--pretty=format:%x00%x01%ad%x00%x02",
        "--date=short",
        head,
        "--",
        ...CENSUS_ROOTS,
      ],
      {
        cwd: root,
        env: { ...env, GIT_NO_REPLACE_OBJECTS: "1" },
        maxBuffer: 256 * 1024 * 1024,
      },
    );
    return parseLastTouchHistory(output);
  } catch (error) {
    throw new Error(
      `cannot read tooling freshness history: ${error?.message ?? error}`,
      { cause: error },
    );
  }
}

function physicalIndexPath(root, env) {
  if (env.GIT_INDEX_FILE) {
    return path.isAbsolute(env.GIT_INDEX_FILE)
      ? env.GIT_INDEX_FILE
      : path.resolve(root, env.GIT_INDEX_FILE);
  }
  try {
    return execFileSync(
      "git",
      ["rev-parse", "--path-format=absolute", "--git-path", "index"],
      {
        cwd: root,
        env: { ...env, GIT_NO_REPLACE_OBJECTS: "1" },
        encoding: "utf8",
        maxBuffer: 1024 * 1024,
      },
    ).trim();
  } catch (error) {
    throw new Error(
      `cannot resolve candidate index path: ${error?.message ?? error}`,
      { cause: error },
    );
  }
}

function parsePhysicalIndex(bytes, oidLength) {
  if (
    bytes.length < 12 + oidLength ||
    bytes.subarray(0, 4).toString("ascii") !== "DIRC"
  ) {
    throw new Error("candidate index has an invalid physical header");
  }
  const version = bytes.readUInt32BE(4);
  if (![2, 3, 4].includes(version)) {
    throw new Error(`candidate index version ${version} is unsupported`);
  }
  const count = bytes.readUInt32BE(8);
  const paths = [];
  let previous = Buffer.alloc(0);
  let offset = 12;
  for (let i = 0; i < count; i++) {
    const start = offset;
    const flagsOffset = start + 40 + oidLength;
    if (flagsOffset + 2 > bytes.length) {
      throw new Error("candidate index has a truncated physical entry");
    }
    const flags = bytes.readUInt16BE(flagsOffset);
    let nameOffset = flagsOffset + 2 + ((flags & 0x4000) === 0 ? 0 : 2);
    let pathname;
    if (version === 4) {
      let strip = 0;
      let byte;
      do {
        if (nameOffset >= bytes.length) {
          throw new Error("candidate index has a truncated v4 path prefix");
        }
        byte = bytes[nameOffset++];
        strip = (strip << 7) + (byte & 0x7f);
        if ((byte & 0x80) !== 0) {
          strip++;
        }
      } while ((byte & 0x80) !== 0);
      const nul = bytes.indexOf(0, nameOffset);
      if (nul === -1 || strip > previous.length) {
        throw new Error("candidate index has invalid v4 path compression");
      }
      pathname = Buffer.concat([
        previous.subarray(0, previous.length - strip),
        bytes.subarray(nameOffset, nul),
      ]);
      offset = nul + 1;
    } else {
      const nul = bytes.indexOf(0, nameOffset);
      if (nul === -1) {
        throw new Error("candidate index entry lacks a path terminator");
      }
      pathname = Buffer.from(bytes.subarray(nameOffset, nul));
      const entryLength = nul + 1 - start;
      offset = start + entryLength + ((8 - (entryLength % 8)) % 8);
    }
    previous = pathname;
    paths.push(pathname);
  }

  const extensions = [];
  const extensionEnd = bytes.length - oidLength;
  while (offset < extensionEnd) {
    if (offset + 8 > extensionEnd) {
      throw new Error("candidate index has a truncated extension header");
    }
    const signature = bytes.subarray(offset, offset + 4).toString("ascii");
    const size = bytes.readUInt32BE(offset + 4);
    const end = offset + 8 + size;
    if (end > extensionEnd) {
      throw new Error(`candidate index extension ${signature} is truncated`);
    }
    extensions.push({
      data: bytes.subarray(offset + 8, end),
      signature,
    });
    offset = end;
  }
  if (offset !== extensionEnd) {
    throw new Error("candidate index physical framing is invalid");
  }
  return { extensions, paths };
}

/**
 * Capture every physical index participating in the candidate (including a
 * split index's shared file) and reject identities that Git-for-Windows can
 * silently omit from `ls-files`. Raw bytes are retained for the exit-time ABA
 * comparison; logical sparse/split expansion still comes from Git itself.
 *
 * @param {string} [root] Repository root.
 * @param {NodeJS.ProcessEnv} [env] Candidate Git environment.
 * @returns {{files: Map<string, Buffer>, reasons: string[]}} Physical state.
 */
export function readCandidatePhysicalIndexState(
  root = ROOT,
  env = process.env,
) {
  let objectFormat;
  try {
    objectFormat = execFileSync("git", ["rev-parse", "--show-object-format"], {
      cwd: root,
      env: { ...env, GIT_NO_REPLACE_OBJECTS: "1" },
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
    }).trim();
  } catch (error) {
    throw new Error(
      `cannot resolve candidate object format: ${error?.message ?? error}`,
      { cause: error },
    );
  }
  const oidLength = objectFormat === "sha256" ? 32 : 20;
  if (!["sha1", "sha256"].includes(objectFormat)) {
    throw new Error(`candidate object format ${objectFormat} is unsupported`);
  }

  const files = new Map();
  const rawPaths = [];
  const visit = (indexPath) => {
    const absolute = path.resolve(indexPath);
    if (files.has(absolute)) {
      return;
    }
    const bytes = readFileSync(absolute);
    files.set(absolute, bytes);
    const parsed = parsePhysicalIndex(bytes, oidLength);
    rawPaths.push(...parsed.paths);
    for (const extension of parsed.extensions) {
      if (extension.signature === "link") {
        if (extension.data.length < oidLength) {
          throw new Error("candidate split-index link extension is truncated");
        }
        const sharedName = `sharedindex.${extension.data.subarray(0, oidLength).toString("hex")}`;
        visit(path.join(path.dirname(absolute), sharedName));
      }
    }
  };
  visit(physicalIndexPath(root, env));

  const decoder = new TextDecoder("utf-8", { fatal: true });
  const reasons = [];
  const relevantPrefixes = [...new Set([...CENSUS_ROOTS, ...REF_ROOTS])].map(
    (scope) => Buffer.from(`${scope}/`, "utf8"),
  );
  const relevantExact = new Set(
    [...CENSUS_ROOTS, ...REF_FILES].map((rel) =>
      Buffer.from(rel, "utf8").toString("hex"),
    ),
  );
  for (const raw of rawPaths) {
    const relevant =
      relevantExact.has(raw.toString("hex")) ||
      relevantPrefixes.some(
        (prefix) =>
          raw.length >= prefix.length &&
          raw.subarray(0, prefix.length).equals(prefix),
      );
    if (
      relevant &&
      [...raw].some((byte) => byte === 0x5c || byte <= 0x1f || byte === 0x7f)
    ) {
      let display;
      try {
        display = JSON.stringify(decoder.decode(raw));
      } catch {
        display = `<non-UTF8:${raw.toString("hex")}>`;
      }
      reasons.push(
        `candidate Git path ${display} cannot be represented losslessly in the Markdown census`,
      );
    }
  }
  return { files, reasons };
}

/**
 * Parse the NUL-framed freshness stream emitted by {@link lastTouchDates}.
 *
 * @param {Buffer} output Raw Git log bytes.
 * @returns {Map<string, string>} Exact Git path -> first/newest date.
 */
export function parseLastTouchHistory(output) {
  const dates = new Map();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let current = null;
  let offset = 0;
  while (offset <= output.length) {
    let end = output.indexOf(0, offset);
    if (end === -1) {
      end = output.length;
    }
    let token = output.subarray(offset, end);
    offset = end + 1;
    if (token.length === 0) {
      if (end === output.length) {
        break;
      }
      continue;
    }
    if (token[0] === 0x01) {
      const date = decoder.decode(token.subarray(1));
      if (!/^\d{4}-\d{2}-\d{2}$/u.test(date)) {
        throw new CandidateStructureError(
          `invalid last-touch date record ${JSON.stringify(date)}`,
        );
      }
      current = date;
      continue;
    }
    if (token[0] === 0x02 && token[1] === 0x0a) {
      token = token.subarray(2);
    }
    if (current === null) {
      throw new CandidateStructureError(
        "last-touch history emitted a path before its date",
      );
    }
    const rel = decoder.decode(token);
    // `git log` walks newest-first, so the first date a path is seen wins.
    if (!dates.has(rel)) {
      dates.set(rel, current);
    }
    if (end === output.length) {
      break;
    }
  }
  return dates;
}

/**
 * Resolve one path-like source token to at most one census subject.
 * Ambiguous bare basenames deliberately resolve to null rather than crediting
 * every same-named file with a phantom inbound reference.
 *
 * @param {string} source Referencing repo-relative file.
 * @param {string} rawToken Token found in its source text.
 * @param {Set<string>} byPath Exact census paths.
 * @param {Map<string, string[]>} byBase Census paths grouped by basename.
 * @returns {string|null} One exact referenced path, or null when unresolved.
 */
export function resolveReferenceToken(source, rawToken, byPath, byBase) {
  // A literal backslash is a legal Git path byte. Resolve the exact token
  // before interpreting backslashes as host/source spelling of separators.
  if (byPath.has(rawToken)) {
    return rawToken;
  }
  const raw = rawToken.split("\\").join("/");
  if (byPath.has(raw)) {
    return raw;
  }
  const base = path.posix.basename(raw);
  const candidates = byBase.get(base) ?? [];
  const normalized = raw.replace(/^\.\//, "");
  const sourceRelative = path.posix.normalize(
    path.posix.join(path.posix.dirname(source), normalized),
  );
  if (byPath.has(sourceRelative)) {
    return sourceRelative;
  }
  const suffixMatches = candidates.filter(
    (candidate) =>
      candidate === normalized || candidate.endsWith(`/${normalized}`),
  );
  if (suffixMatches.length === 1) {
    return suffixMatches[0];
  }
  if (normalized === base && candidates.length === 1) {
    return candidates[0];
  }
  return null;
}

/**
 * Count inbound references to each tooling file.
 *
 * Every scanned file is tokenized ONCE for `*.mjs` path-like strings, rather
 * than searched once per candidate name; the naive form is ~990 substring
 * scans per file and does not finish in a usable time.
 *
 * @param {string[]} files Census files, repo-relative.
 * @returns {Map<string, Set<string>>} Path -> the distinct files naming it.
 */
export function inboundRefSources(files) {
  const byPath = new Set(files);
  const byBase = new Map();
  for (const file of files) {
    const base = path.posix.basename(file);
    if (!byBase.has(base)) {
      byBase.set(base, []);
    }
    byBase.get(base).push(file);
  }

  const sources = listTrackedPaths([...REF_ROOTS, ...REF_FILES]).filter(
    isReferenceSourcePath,
  );
  const sourceText = readTrackedFiles(sources);

  const referencedBy = new Map(files.map((f) => [f, new Set()]));
  const token = /[A-Za-z0-9_./\\-]*[A-Za-z0-9_-]\.mjs/g;
  for (const source of sources) {
    if (REF_EXCLUDED.includes(source)) {
      continue;
    }
    const text = sourceText.get(source);
    if (
      text === undefined ||
      Buffer.byteLength(text, "utf8") > 8 * 1024 * 1024
    ) {
      continue;
    }
    const hits = new Set();
    for (const match of text.matchAll(token)) {
      const hit = resolveReferenceToken(source, match[0], byPath, byBase);
      if (hit !== null) {
        hits.add(hit);
      }
    }
    for (const hit of hits) {
      if (hit !== source) {
        referencedBy.get(hit)?.add(source);
      }
    }
  }
  return referencedBy;
}

/**
 * Count inbound references to each tooling file.
 *
 * @param {string[]} files Census files, repo-relative.
 * @param {Map<string, Set<string>>} [sources] Precomputed reference sources, so
 *   a caller that also needs the identities scans the tree once.
 * @returns {Map<string, number>} Path -> number of distinct referencing files.
 */
export function inboundRefs(files, sources = inboundRefSources(files)) {
  return new Map(files.map((file) => [file, sources.get(file)?.size ?? 0]));
}

/**
 * Whether a path already sits inside an `archive/` directory.
 *
 * Only directory segments count: a file whose own NAME contains `archive` has
 * not been retired, and reading it as retired would drop it out of the plan.
 *
 * @param {string} rel Repo-relative, slash-separated path.
 * @returns {boolean} True when a parent directory is exactly `archive`.
 */
export function isUnderArchiveDirectory(rel) {
  return rel.split("/").slice(0, -1).includes(ARCHIVE_SEGMENT);
}

/**
 * The stable anchor a plan row is cited by.
 *
 * Derived from the path, never from the row's position, so a citation written
 * today still resolves after the plan grows, shrinks or reorders. Line numbers
 * do not survive a regeneration; this does.
 *
 * @param {string} rel Repo-relative path.
 * @returns {string} Anchor id, without the leading `#`.
 */
export function archivePlanAnchor(rel) {
  const slug = rel
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `ap-${slug}`;
}

/**
 * Derive the archive plan from census rows and their reference identities.
 *
 * The plan does NOT re-derive the analyst's HIGH/MED confidence grades - those
 * are a human judgement recorded in the report above the markers. It derives
 * the mechanical preconditions ruling M1 attaches to any move: what still
 * names the file from live code and docs, what names it only from an already
 * archived document (breakage contained to `archive/`), and whether the
 * fleet-contract allowlist carries a row that has to be deleted in the same
 * change. A disposition is what remains once those are settled.
 *
 * @param {object[]} rows Census rows.
 * @param {Map<string, Set<string>>} refSources Path -> files naming it.
 * @returns {object[]} Plan rows, sorted by path.
 */
export function archivePlanRows(rows, refSources) {
  if (!rows.some((row) => row.file === FLEET_CONTRACT_ALLOWLIST)) {
    throw new CandidateStructureError(
      `the fleet-contract allowlist ${FLEET_CONTRACT_ALLOWLIST} is not in the census; ` +
        "the archive plan cannot report which candidates carry an allowlist row",
    );
  }
  const plan = [];
  const anchors = new Map();
  for (const row of rows) {
    if (!ARCHIVE_PLAN_STATUSES.includes(row.status)) {
      continue;
    }
    let live = 0;
    let archived = 0;
    let allowlisted = false;
    for (const source of refSources.get(row.file) ?? []) {
      if (source === FLEET_CONTRACT_ALLOWLIST) {
        allowlisted = true;
      } else if (isUnderArchiveDirectory(source)) {
        archived += 1;
      } else {
        live += 1;
      }
    }
    const anchor = archivePlanAnchor(row.file);
    const clash = anchors.get(anchor);
    if (clash !== undefined) {
      throw new CandidateStructureError(
        `archive-plan anchor ${anchor} is claimed by both ${clash} and ${row.file}; ` +
          "two rows cannot share one citation",
      );
    }
    anchors.set(anchor, row.file);
    plan.push({
      anchor,
      file: row.file,
      status: row.status,
      live,
      archived,
      allowlisted,
      disposition: isUnderArchiveDirectory(row.file)
        ? "ALREADY-ARCHIVED"
        : live > 0
          ? "REPOINT-FIRST"
          : allowlisted
            ? "ALLOWLIST-EDIT-THEN-MOVE"
            : "MOVE",
    });
  }
  return plan.sort((a, b) => byCodeUnit(a.file, b.file));
}

/**
 * Escape a value for a Markdown table cell.
 *
 * @param {string} text Cell text.
 * @returns {string} Escaped, single-line text.
 */
function cell(text) {
  return String(text ?? "")
    .replace(/\s+/g, " ")
    .split("|")
    .join("\\|")
    .trim();
}

/**
 * Build the census rows for every file in scope.
 *
 * Fails CLOSED on a header the parser cannot read. The previous catch-all
 * turned an unterminated comment, a duplicated tag or a status outside the
 * vocabulary into the same row a file with no header at all gets, so a
 * malformed header was published as an absent one and nobody could tell the
 * two apart. A census that cannot read its subject must refuse, not guess.
 *
 * @returns {{rows: object[], byDirectory: Map<string, object[]>,
 *   archivePlan: object[]}} Census data.
 */
export function collectCensus(head = "HEAD", historyEnv = process.env) {
  const files = listToolingFiles();
  const toolingText = readTrackedFiles(files);
  const dates = lastTouchDates(head, historyEnv);
  const refSources = inboundRefSources(files);
  const refs = inboundRefs(files, refSources);
  const rows = [];
  const headerFailures = [];
  for (const file of files) {
    const source = toolingText.get(file);
    if (source === undefined) {
      headerFailures.push(`${file}: candidate index blob is unavailable`);
      continue;
    }
    let parsed;
    try {
      parsed = parsePurposeHeader(source);
    } catch (error) {
      headerFailures.push(
        `${file}: the header parser threw - ${error?.message ?? error}`,
      );
      continue;
    }
    if (parsed.errors.length > 0) {
      for (const message of parsed.errors) {
        headerFailures.push(`${file}: ${message}`);
      }
      continue;
    }
    const notes = [parsed.supersededBy, parsed.note]
      .filter(Boolean)
      .join(" · ");
    rows.push({
      file,
      directory: `${path.posix.dirname(file)}/`,
      base: path.posix.basename(file),
      className: classify(file, parsed.className),
      status:
        parsed.purpose === null
          ? "NO @purpose HEADER"
          : (parsed.status ?? "NO @status HEADER"),
      touched: dates.get(file) ?? "—",
      refs: refs.get(file) ?? 0,
      purpose: parsed.purpose ?? "—",
      notes,
    });
  }
  if (headerFailures.length > 0) {
    const shown = headerFailures.slice(0, 10).join("; ");
    const rest =
      headerFailures.length > 10
        ? ` (+${headerFailures.length - 10} more)`
        : "";
    throw new CandidateStructureError(
      `${headerFailures.length} census header(s) cannot be read: ${shown}${rest}`,
    );
  }
  const byDirectory = new Map();
  for (const row of rows) {
    if (!byDirectory.has(row.directory)) {
      byDirectory.set(row.directory, []);
    }
    byDirectory.get(row.directory).push(row);
  }
  return {
    rows,
    byDirectory,
    archivePlan: archivePlanRows(rows, refSources),
  };
}

/**
 * Render the census section, markers included.
 *
 * @param {{rows: object[], byDirectory: Map<string, object[]>}} census Data.
 * @param {string} eol Line terminator.
 * @returns {string} The section text.
 */
export function renderCensus(census, eol) {
  const lines = [];
  const push = (line) => lines.push(line);
  push(BEGIN_MARKER);
  push("");
  push("## Full census");
  push("");
  push(
    "Columns: file (basename), class, status, last git touch, inbound refs, purpose. " +
      "Generated from each file's own `@purpose` / `@status` header (ruling M2) — edit the FILE, not this table. " +
      "`NO @purpose HEADER` names a file that has not self-registered yet, so the gap is visible rather than absent. " +
      "Class comes from a file's `@class` tag when it carries one and from its path otherwise. " +
      "Inbound refs count the distinct files under `Tools/`, `scripts/`, `migration_doc/`, `.husky/`, `package.json` " +
      "and `lint-staged.config.js` that name the file (this catalog itself excluded).",
  );
  push("");

  const statusCounts = new Map();
  const classCounts = new Map();
  for (const row of census.rows) {
    statusCounts.set(row.status, (statusCounts.get(row.status) ?? 0) + 1);
    classCounts.set(row.className, (classCounts.get(row.className) ?? 0) + 1);
  }
  push("| Metric | Value |");
  push("|---|---|");
  push(`| Files in census | ${census.rows.length} |`);
  for (const [status, count] of [...statusCounts].sort()) {
    push(`| ${cell(status)} | ${count} |`);
  }
  push(
    `| Classes | ${[...classCounts]
      .sort((a, b) => b[1] - a[1] || byCodeUnit(a[0], b[0]))
      .map(([name, count]) => `${name} ${count}`)
      .join(", ")} |`,
  );
  push("");

  for (const directory of [...census.byDirectory.keys()].sort()) {
    const rows = census.byDirectory
      .get(directory)
      .slice()
      .sort((a, b) => byCodeUnit(a.base, b.base));
    push(`### ${directory} (${rows.length})`);
    push("");
    push("| File | Class | Status | Touched | Refs | Purpose |");
    push("|---|---|---|---|---|---|");
    for (const row of rows) {
      const purpose = row.notes
        ? `${cell(row.purpose)} — *${cell(row.notes)}*`
        : cell(row.purpose);
      push(
        `| ${cell(row.base)} | ${cell(row.className)} | ${cell(row.status)} | ${cell(row.touched)} | ${row.refs} | ${purpose} |`,
      );
    }
    push("");
  }
  renderArchivePlan(census.archivePlan, push);
  push(END_MARKER);
  return lines.join(eol);
}

/**
 * Render the archive plan into the census region.
 *
 * It belongs INSIDE the markers because it is derived, not authored: the
 * launcher rewrites only this region, so a section rendered anywhere else
 * would be written once by hand and then quietly go stale - the exact failure
 * the generated census exists to prevent.
 *
 * @param {object[]} plan Rows from {@link archivePlanRows}.
 * @param {(line: string) => void} push Line sink.
 */
function renderArchivePlan(plan, push) {
  if (!Array.isArray(plan)) {
    throw new CandidateStructureError(
      "the census carries no archive plan; the region must not be rendered " +
        "without one, or the plan silently disappears from the document",
    );
  }
  push("## Archive plan");
  push("");
  push(
    "Every census file whose own header reads `INVESTIGATION` or `ARCHIVED-CANDIDATE`, with the " +
      "mechanical preconditions a move has to satisfy first. This is the input to the archive rows; " +
      "it does not reproduce the analyst report's HIGH/MED confidence grades above, which are a " +
      "human judgement rather than anything the tree can be asked. " +
      "**Live refs** are the distinct files naming this one from outside any `archive/` directory - " +
      "repoint those before moving. **Archived refs** name it only from an already archived document, " +
      "so the breakage stays inside `archive/`. **Allowlist row** means the pinned fleet-contract " +
      "census lists this probe, and that row must be deleted in the same change or the contract spec " +
      "fails on it. Cite a row by its anchor (`#ap-…`), never by line number - the table is " +
      "regenerated and line numbers do not survive it.",
  );
  push("");

  const dispositions = new Map();
  for (const row of plan) {
    dispositions.set(
      row.disposition,
      (dispositions.get(row.disposition) ?? 0) + 1,
    );
  }
  push("| Disposition | Files |");
  push("|---|---|");
  push(`| Candidates in plan | ${plan.length} |`);
  for (const [disposition, count] of [...dispositions].sort()) {
    push(`| ${cell(disposition)} | ${count} |`);
  }
  push("");

  push(
    "| Row | Path | Status | Live refs | Archived refs | Allowlist row | Disposition |",
  );
  push("|---|---|---|---|---|---|---|");
  for (const row of plan) {
    push(
      `| <a id="${row.anchor}"></a>[#](#${row.anchor}) | ${cell(row.file)} | ` +
        `${cell(row.status)} | ${row.live} | ${row.archived} | ` +
        `${row.allowlisted ? "yes" : "no"} | ${cell(row.disposition)} |`,
    );
  }
  push("");
}

/**
 * Split the catalog around its generated region.
 *
 * @param {string} text Catalog text.
 * @returns {{before: string, region: string, after: string, eol: string}|null}
 *   `null` when the markers are absent.
 */
export function splitCatalog(text) {
  const begin = text.indexOf(BEGIN_MARKER);
  const end = text.indexOf(END_MARKER);
  const secondBegin =
    begin === -1 ? -1 : text.indexOf(BEGIN_MARKER, begin + BEGIN_MARKER.length);
  const secondEnd =
    end === -1 ? -1 : text.indexOf(END_MARKER, end + END_MARKER.length);
  if (
    begin === -1 ||
    end === -1 ||
    end < begin ||
    secondBegin !== -1 ||
    secondEnd !== -1
  ) {
    return null;
  }
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  return {
    before: text.slice(0, begin),
    region: text.slice(begin, end + END_MARKER.length),
    after: text.slice(end + END_MARKER.length),
    eol,
  };
}

/**
 * Describe how two census regions differ, in reviewable terms.
 *
 * @param {string} committed Region currently in the file.
 * @param {string} regenerated Region this run produced.
 * @returns {string[]} Human-readable difference lines.
 */
export function describeDrift(committed, regenerated) {
  return describeDriftDetailed(committed, regenerated).lines;
}

/**
 * Like {@link describeDrift} but also says whether any row differs in
 * something other than the git-freshness column. That distinction is useful
 * diagnostics, but every byte-level difference remains drift and `--check`
 * fails on it. A freshness-only follow-up may be a mechanical linked landing;
 * it is not permission to report a stale catalog as current.
 *
 * @param {string} committed Region currently in the file.
 * @param {string} regenerated Region this run produced.
 * @returns {{ lines: string[], structural: boolean }} Report + verdict.
 */
export function describeDriftDetailed(committed, regenerated) {
  const rowBase = (line) => {
    const m = /^\|\s*([^|]+?)\s*\|/.exec(line);
    return m === null ? null : m[1];
  };
  const index = (text) => {
    const map = new Map();
    let directory = "";
    for (const raw of text.split(/\r?\n/)) {
      const heading = /^###\s+(.+?\/)\s+\(\d+\)$/.exec(raw);
      if (heading !== null) {
        directory = heading[1];
        continue;
      }
      const base = rowBase(raw);
      const key = base === null ? null : `${directory}${base}`;
      // Census rows have six columns; the two-column summary table above them
      // is not a census row and must not be reported as one.
      if (
        key !== null &&
        !raw.startsWith("|---") &&
        raw.split(/(?<!\\)\|/).length - 1 === 7
      ) {
        map.set(key, raw);
      }
    }
    return map;
  };
  const before = index(committed);
  const after = index(regenerated);
  const added = [...after.keys()].filter((k) => !before.has(k));
  const removed = [...before.keys()].filter((k) => !after.has(k));
  const changed = [...after.keys()].filter(
    (k) => before.has(k) && before.get(k) !== after.get(k),
  );
  const dateOnly = changed.filter((k) => {
    const strip = (row) =>
      row
        .split("|")
        .filter((_, i) => i !== 4)
        .join("|");
    return strip(before.get(k)) === strip(after.get(k));
  });
  const out = [
    `rows added ${added.length}, removed ${removed.length}, changed ${changed.length} (of which ${dateOnly.length} differ only in the git-freshness column)`,
  ];
  for (const key of added.slice(0, 10)) {
    out.push(`  + ${key}`);
  }
  for (const key of removed.slice(0, 10)) {
    out.push(`  - ${key}`);
  }
  for (const key of changed.slice(0, 10)) {
    out.push(`  ~ ${key}`);
  }
  if (added.length + removed.length + changed.length === 0) {
    out.push("  (prose or layout outside the row tables)");
  }
  // Byte-identical regions are not drift; otherwise anything beyond the
  // freshness column - including prose outside the row tables - is structural.
  const structural =
    committed !== regenerated &&
    (added.length + removed.length + (changed.length - dateOnly.length) > 0 ||
      added.length + removed.length + changed.length === 0);
  return { lines: out, structural, freshnessOnlyPaths: dateOnly };
}

/**
 * Exact `--check` verdict for two generated regions.
 *
 * Freshness-only drift is ADVISORY only within the candidate commit's own
 * files: the freshness column reads a file's last COMMIT date, which cannot
 * exist before the touching commit lands, so the landing commit itself can
 * never be check-green on those rows and the Batch 1053 contract makes them
 * advisory. The allowance is BOUNDED by `advisoryPaths` (the files the
 * candidate head commit touched) because unbounded advisory would also wave
 * through mass freshness corruption - a shallow or grafted history snaps
 * hundreds of rows to the graft boundary date, and that drift is the
 * defense-in-depth signal the isolated-history walk exists to surface.
 * Structural drift, or freshness drift outside the allowance, fails.
 *
 * @param {string} committed Region currently stored in the catalog.
 * @param {string} regenerated Region produced from the candidate index.
 * @param {Set<string>|null} [advisoryPaths] Paths whose freshness drift is
 *   advisory; omitted or null fails closed on any drift.
 * @returns {0|1} Zero for byte-identical regions or bounded advisory drift.
 */
export function catalogCheckExitCode(committed, regenerated, advisoryPaths) {
  if (committed === regenerated) {
    return 0;
  }
  const drift = describeDriftDetailed(committed, regenerated);
  if (drift.structural || !advisoryPaths) {
    return 1;
  }
  return drift.freshnessOnlyPaths.every((key) => advisoryPaths.has(key))
    ? 0
    : 1;
}

/**
 * Paths whose freshness drift the candidate itself explains: the files its
 * head commit touched, read through the isolated history environment so a
 * replacement or grafted history cannot widen the allowance. A merge commit
 * reports its combined diff, which can under-report; the cost is an advisory
 * miss that demands one explicit regenerate-and-commit, never a silent pass.
 *
 * @param {object} subject Frozen candidate subject.
 * @returns {Set<string>} Repo-relative paths touched by the head commit.
 */
function candidateHeadTouchedPaths(subject) {
  const output = execFileSync(
    "git",
    [
      "show",
      "--name-only",
      "--format=",
      "-z",
      subject.head,
      "--",
      ...CENSUS_ROOTS,
    ],
    {
      cwd: ROOT,
      env: { ...subject.historyEnv, GIT_NO_REPLACE_OBJECTS: "1" },
      maxBuffer: 64 * 1024 * 1024,
    },
  );
  const paths = new Set();
  for (const part of output.toString("utf8").split("\u0000")) {
    const cleaned = part.trim();
    if (cleaned !== "") {
      paths.add(cleaned.replace(/\+/g, "/"));
    }
  }
  return paths;
}

/**
 * Revalidate the original candidate immediately before publishing a verdict or
 * bytes. The census itself reads only the private index snapshot; this second
 * boundary prevents that internally consistent snapshot from certifying a
 * different index/HEAD that appeared while the census was being built.
 *
 * @param {object} subject Frozen candidate subject.
 * @returns {null|2|3} Null when stable, otherwise the terminal exit code.
 */
function candidateSubjectTerminalFailure(subject) {
  if (subject.externallyFrozen === true) {
    return null;
  }
  let reasons;
  try {
    reasons = candidateSubjectDriftReasons(subject);
  } catch (error) {
    console.error(
      `generate-tooling-catalog: cannot revalidate the candidate subject: ${error?.message ?? error}`,
    );
    return 2;
  }
  if (reasons.length === 0) {
    return null;
  }
  console.error(
    "generate-tooling-catalog: STRUCTURAL — the candidate subject is ineligible or changed during census construction.",
  );
  for (const reason of reasons) {
    console.error(`  ${reason}`);
  }
  return 3;
}

/**
 * Require the catalog and the exact executable/parser sources to exist as
 * ordinary stage-zero candidate files. Their absence is an ineligible subject,
 * not an execution fault.
 *
 * @param {string} [root] Repository root.
 * @returns {string[]} Structural prerequisite failures.
 */
function requiredCandidatePathReasons(root = ROOT) {
  const required = [CATALOG_REL, ...RUNTIME_BINDINGS];
  return regularCandidatePathReasons(required, root);
}

/**
 * Run the catalog operation against one immutable private index snapshot.
 *
 * @param {boolean} check Whether to compare without writing.
 * @param {boolean} toStdout Whether to emit only the generated region.
 * @param {object} subject Frozen candidate subject.
 * @returns {number} Process exit code.
 */
function mainFrozen(check, toStdout, subject) {
  const initialSubjectFailure = candidateSubjectTerminalFailure(subject);
  if (initialSubjectFailure !== null) {
    return initialSubjectFailure;
  }
  let requiredPathReasons;
  try {
    requiredPathReasons = requiredCandidatePathReasons();
  } catch (error) {
    console.error(
      `generate-tooling-catalog: cannot inspect required candidate paths: ${error?.message ?? error}`,
    );
    return 2;
  }
  if (requiredPathReasons.length > 0) {
    const subjectFailure = candidateSubjectTerminalFailure(subject);
    if (subjectFailure !== null) {
      return subjectFailure;
    }
    console.error(
      "generate-tooling-catalog: STRUCTURAL — required candidate paths are absent or non-regular.",
    );
    for (const reason of requiredPathReasons) {
      console.error(`  ${reason}`);
    }
    return 3;
  }

  let catalog;
  if (check || toStdout) {
    let bindingReasons;
    try {
      bindingReasons = runtimeCandidateBindingReasons();
      catalog = readTrackedFiles([CATALOG_REL]).get(CATALOG_REL);
      if (catalog === undefined) {
        throw new Error("candidate index catalog blob is unavailable");
      }
    } catch (error) {
      console.error(
        `generate-tooling-catalog: cannot bind the candidate runtime/catalog: ${error?.message ?? error}`,
      );
      return 2;
    }
    if (bindingReasons.length > 0) {
      const subjectFailure = candidateSubjectTerminalFailure(subject);
      if (subjectFailure !== null) {
        return subjectFailure;
      }
      console.error(
        "generate-tooling-catalog: STRUCTURAL — the executing runtime is not the candidate-index runtime.",
      );
      for (const reason of bindingReasons) {
        console.error(`  ${reason}`);
      }
      return 3;
    }
  } else {
    try {
      catalog = readFileSync(CATALOG, "utf8");
    } catch (error) {
      console.error(`generate-tooling-catalog: ${error.message}`);
      return 2;
    }
  }
  const split = splitCatalog(catalog);
  if (split === null) {
    const subjectFailure = candidateSubjectTerminalFailure(subject);
    if (subjectFailure !== null) {
      return subjectFailure;
    }
    console.error(
      "generate-tooling-catalog: STRUCTURAL — the census markers are missing from\n" +
        `${path.relative(ROOT, CATALOG)}. Add them around the "## Full census" section:\n` +
        `${BEGIN_MARKER}\n…\n${END_MARKER}`,
    );
    return 3;
  }

  let censusPrerequisiteReasons;
  try {
    censusPrerequisiteReasons = candidateCensusPrerequisiteReasons();
  } catch (error) {
    console.error(
      `generate-tooling-catalog: cannot inspect candidate census prerequisites: ${error?.message ?? error}`,
    );
    return 2;
  }
  if (censusPrerequisiteReasons.length > 0) {
    const subjectFailure = candidateSubjectTerminalFailure(subject);
    if (subjectFailure !== null) {
      return subjectFailure;
    }
    console.error(
      "generate-tooling-catalog: STRUCTURAL — candidate census paths are ineligible.",
    );
    for (const reason of censusPrerequisiteReasons) {
      console.error(`  ${reason}`);
    }
    return 3;
  }

  let census;
  try {
    census = collectCensus(subject.head, subject.historyEnv);
  } catch (error) {
    if (error instanceof CandidateStructureError) {
      const subjectFailure = candidateSubjectTerminalFailure(subject);
      if (subjectFailure !== null) {
        return subjectFailure;
      }
      console.error(
        `generate-tooling-catalog: STRUCTURAL — candidate census is ineligible: ${error.message}`,
      );
      return 3;
    }
    console.error(
      `generate-tooling-catalog: cannot construct the candidate census: ${error?.message ?? error}`,
    );
    return 2;
  }
  if (census.rows.length === 0) {
    const subjectFailure = candidateSubjectTerminalFailure(subject);
    if (subjectFailure !== null) {
      return subjectFailure;
    }
    console.error(
      "generate-tooling-catalog: STRUCTURAL — no .mjs files found under " +
        `${CENSUS_ROOTS.join(", ")}; a census of nothing must not read as a pass.`,
    );
    return 3;
  }
  const regenerated = renderCensus(census, split.eol);

  const subjectFailure = candidateSubjectTerminalFailure(subject);
  if (subjectFailure !== null) {
    return subjectFailure;
  }

  if (toStdout) {
    process.stdout.write(`${regenerated}${split.eol}`);
    return 0;
  }
  if (check) {
    const advisoryPaths = candidateHeadTouchedPaths(subject);
    if (catalogCheckExitCode(split.region, regenerated, advisoryPaths) === 0) {
      if (split.region === regenerated) {
        console.log(
          `generate-tooling-catalog --check: census is current (${census.rows.length} files).`,
        );
      } else {
        console.warn(
          "generate-tooling-catalog --check: freshness-only drift - advisory, it settles after the touching commit lands.",
        );
        for (const line of describeDriftDetailed(split.region, regenerated)
          .lines) {
          console.warn(`  ${line}`);
        }
      }
      return 0;
    }
    const drift = describeDriftDetailed(split.region, regenerated);
    console.error(
      "generate-tooling-catalog --check: the committed census has DRIFTED from the tree.",
    );
    for (const line of drift.lines) {
      console.error(`  ${line}`);
    }
    console.error(
      "  Regenerate with `node Tools/generate-tooling-catalog-launcher.cjs` and commit the result.",
    );
    return 1;
  }

  const replacement = `${split.before}${regenerated}${split.after}`;
  let written;
  try {
    written = writeCatalogIfUnchanged(catalog, replacement);
  } catch (error) {
    console.error(`generate-tooling-catalog: ${error?.message ?? error}`);
    return 2;
  }
  if (!written) {
    console.error(
      "generate-tooling-catalog: catalog changed during generation; refusing to overwrite concurrent work",
    );
    return 2;
  }
  console.log(
    `generate-tooling-catalog: wrote ${census.rows.length} rows to ${path.relative(ROOT, CATALOG).split(path.sep).join("/")}.`,
  );
  return 0;
}

/**
 * Use the worktree module only as a byte-bound bootstrap. The implementation
 * that computes and publishes the verdict is materialized from the frozen
 * candidate blobs and loaded by a fresh Node process, so its initialization
 * bytes are exactly the bytes in the prospective index. A fixed CRLF-to-LF
 * comparison is permitted only for this non-verdict bootstrap; arbitrary Git
 * filters never participate.
 *
 * @param {string[]} argv CLI arguments.
 * @param {object} subject Frozen outer candidate subject.
 * @returns {number} Child verdict or bootstrap failure.
 */
function mainViaCandidateRuntime(argv, subject) {
  const initialSubjectFailure = candidateSubjectTerminalFailure(subject);
  if (initialSubjectFailure !== null) {
    return initialSubjectFailure;
  }
  const requiredReasons = requiredCandidatePathReasons();
  if (requiredReasons.length > 0) {
    console.error(
      "generate-tooling-catalog: STRUCTURAL — required candidate paths are absent or non-regular.",
    );
    for (const reason of requiredReasons) {
      console.error(`  ${reason}`);
    }
    return 3;
  }

  const bindingReasons = runtimeCandidateBindingReasons();
  if (bindingReasons.length > 0) {
    const subjectFailure = candidateSubjectTerminalFailure(subject);
    if (subjectFailure !== null) {
      return subjectFailure;
    }
    console.error(
      "generate-tooling-catalog: STRUCTURAL — the executing runtime is not the candidate-index runtime (loaded bootstrap mismatch).",
    );
    for (const reason of bindingReasons) {
      console.error(`  ${reason}`);
    }
    return 3;
  }

  const candidateRuntime = readCandidateFileBuffers(RUNTIME_BINDINGS);
  const runtimeRoot = path.join(subject.privateRoot, "runtime");
  for (const rel of RUNTIME_BINDINGS) {
    const destination = path.join(runtimeRoot, ...rel.split("/"));
    mkdirSync(path.dirname(destination), { recursive: true });
    writeFileSync(destination, candidateRuntime.get(rel));
  }
  const runtimeScript = path.join(
    runtimeRoot,
    ...RUNTIME_BINDINGS[0].split("/"),
  );
  const result = spawnSync(process.execPath, [runtimeScript, ...argv], {
    cwd: subject.root,
    env: {
      ...process.env,
      [CANDIDATE_ROOT_ENV]: subject.root,
      [CANDIDATE_RUNTIME_ENV]: "1",
      [CANDIDATE_HEAD_ENV]: subject.head,
      [HISTORY_GIT_DIR_ENV]: subject.historyEnv.GIT_DIR,
      [HISTORY_OBJECT_DIR_ENV]: subject.historyEnv.GIT_OBJECT_DIRECTORY,
      [HISTORY_ALTERNATES_ENV]:
        subject.historyEnv.GIT_ALTERNATE_OBJECT_DIRECTORIES,
      [HISTORY_CONFIG_ENV]: subject.historyEnv.GIT_CONFIG_GLOBAL,
      GIT_INDEX_FILE: subject.privateIndex,
      GIT_NO_REPLACE_OBJECTS: "1",
    },
    maxBuffer: 512 * 1024 * 1024,
  });

  const subjectFailure = candidateSubjectTerminalFailure(subject);
  if (subjectFailure !== null) {
    return subjectFailure;
  }
  if (
    result.error ||
    result.signal !== null ||
    !Number.isInteger(result.status)
  ) {
    console.error(
      `generate-tooling-catalog: candidate runtime failed to settle: ${result.error?.message ?? result.signal ?? "unknown child failure"}`,
    );
    return 2;
  }
  if (result.stdout?.length > 0) {
    process.stdout.write(result.stdout);
  }
  if (result.stderr?.length > 0) {
    process.stderr.write(result.stderr);
  }
  return result.status;
}

/**
 * CLI entry.
 *
 * @param {string[]} argv Arguments after the script name.
 * @returns {number} Process exit code.
 */
export function main(argv) {
  if (process.env[TRUSTED_LAUNCHER_ENV] !== "1") {
    console.error(
      "generate-tooling-catalog: direct execution is unsupported; start with node Tools/generate-tooling-catalog-launcher.cjs",
    );
    return 2;
  }
  if (process.env[CANDIDATE_RUNTIME_ENV] === "1") {
    const check = argv.includes("--check");
    const toStdout = argv.includes("--stdout");
    const unknown = argv.filter((a) => !["--check", "--stdout"].includes(a));
    if (unknown.length > 0) {
      console.error(`generate-tooling-catalog: unknown argument ${unknown[0]}`);
      return 2;
    }
    if (check && toStdout) {
      console.error(
        "generate-tooling-catalog: --check and --stdout are mutually exclusive",
      );
      return 2;
    }
    const requiredEnvironment = [
      CANDIDATE_HEAD_ENV,
      HISTORY_GIT_DIR_ENV,
      HISTORY_OBJECT_DIR_ENV,
      HISTORY_CONFIG_ENV,
    ];
    const missing = requiredEnvironment.filter((name) => !process.env[name]);
    if (missing.length > 0) {
      console.error(
        `generate-tooling-catalog: candidate runtime is missing sealed subject environment ${missing.join(", ")}`,
      );
      return 2;
    }
    const historyEnv = { ...process.env };
    for (const name of [
      "GIT_COMMON_DIR",
      "GIT_INDEX_FILE",
      "GIT_REPLACE_REF_BASE",
      "GIT_SHALLOW_FILE",
      "GIT_WORK_TREE",
    ]) {
      delete historyEnv[name];
    }
    historyEnv.GIT_DIR = process.env[HISTORY_GIT_DIR_ENV];
    historyEnv.GIT_OBJECT_DIRECTORY = process.env[HISTORY_OBJECT_DIR_ENV];
    historyEnv.GIT_ALTERNATE_OBJECT_DIRECTORIES =
      process.env[HISTORY_ALTERNATES_ENV] ?? "";
    historyEnv.GIT_CONFIG_GLOBAL = process.env[HISTORY_CONFIG_ENV];
    historyEnv.GIT_CONFIG_NOSYSTEM = "1";
    historyEnv.GIT_NO_REPLACE_OBJECTS = "1";
    return mainFrozen(check, toStdout, {
      externallyFrozen: true,
      head: process.env[CANDIDATE_HEAD_ENV],
      historyEnv,
      root: ROOT,
    });
  }
  try {
    return withFrozenCandidateIndex(
      (subject) => mainViaCandidateRuntime(argv, subject),
      ROOT,
    );
  } catch (error) {
    console.error(
      `generate-tooling-catalog: cannot freeze the candidate subject: ${error?.message ?? error}`,
    );
    return 2;
  }
}

function publishCompletionReceipt(status) {
  if (process.env[CANDIDATE_RUNTIME_ENV] === "1") {
    return;
  }
  const challenge = process.env[RECEIPT_CHALLENGE_ENV];
  const descriptor = process.env[RECEIPT_FD_ENV];
  const subject = process.env[RECEIPT_SUBJECT_ENV];
  if (
    challenge === undefined &&
    descriptor === undefined &&
    subject === undefined
  ) {
    return;
  }
  if (
    !/^[0-9a-f]{64}$/u.test(challenge ?? "") ||
    descriptor !== "3" ||
    !/^[0-9a-f]{64}$/u.test(subject ?? "") ||
    ![0, 1, 2, 3].includes(status)
  ) {
    throw new Error("invalid launcher completion-receipt contract");
  }
  writeFileSync(
    Number(descriptor),
    `${JSON.stringify({
      challenge,
      schema: RECEIPT_SCHEMA,
      status,
      subject,
    })}\n`,
    "utf8",
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const status = main(process.argv.slice(2));
  try {
    publishCompletionReceipt(status);
    process.exitCode = status;
  } catch (error) {
    console.error(
      `generate-tooling-catalog: cannot publish completion receipt: ${error?.message ?? error}`,
    );
    process.exitCode = 2;
  }
}
