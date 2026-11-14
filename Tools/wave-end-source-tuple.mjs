#!/usr/bin/env node
// wave-end-source-tuple.mjs — the producer of the wave-end gate's root-supplied source tuple.
//
// @purpose Prints --source-commit <40-hex> --source-dirty <true|false> --source-identity <64-hex> (or --json) for a working tree, read-only: the identity is sha256 over HEAD plus one record per `git status --porcelain=v1 -z --untracked-files=all` path (worktree bytes, a deletion marker, or a link text), and the three values are checked by the gate's own argument validator before they are printed.
// @status ACTIVE
//
// WHY THIS EXISTS. `Tools/wave-end-gate.mjs` binds every receipt it writes to a
// source tuple the ROOT supplies, and refuses without a 64-hex
// `--source-identity` (`wave-end-gate-binding.mjs`, `decideArgumentRefusal`).
// Nothing in the tree produced one, so every operator invented their own, and a
// receipt's identity meant whatever its author thought it meant that day.
//
// WHAT THE IDENTITY COVERS (seat decision SD-3 as revised, R8). sha256 over a
// scheme line, the HEAD commit, then — sorted by the raw path bytes — one record
// per path that `git status --porcelain=v1 -z --untracked-files=all` names:
//   - a present regular file: its path and the sha256 of its WORKTREE bytes,
//     read here in Node (never `git hash-object <path>`, which fails on a
//     directory and applies clean filters, so it would hash something other than
//     what the build and the server read);
//   - an absent path (deleted in the index or the worktree): its path and a
//     fixed deletion marker, so a deletion moves the identity;
//   - an index rename or copy: with `-z` the ORIGINAL path is the next NUL
//     field, and both paths get a record from what is on disk now (a rename's
//     old path is therefore a deletion; a copy's original is still a file);
//   - a symlink: its link text;
//   - an entry that is still a directory (a gitlink, a nested repository): a
//     refusal by name, because there is no honest single digest for it.
// Ignored files are excluded, as `git status` excludes them. Plain `--porcelain`
// is not used: without `--untracked-files=all` an untracked directory collapses
// to one `?? dir/` entry, so a file added inside it would not move the identity
// (the seat's own tree carried exactly that shape: `?? Tools/patch-prototype/`).
//
// READ-ONLY. Every git call is `git --no-optional-locks -C <root>`, so not even
// the index stat refresh is written back. Nothing reads or prints git author
// identity. HEAD is read through the kit's one reader, `safeGitHead`
// (`visual-regression/lib/build-source-identity.mjs`).
//
// Usage:
//   node Tools/wave-end-source-tuple.mjs [--repo <dir>] [--json]
// Exit: 0 printed; 2 usage error; 3 refused (not a repository, HEAD unreadable,
// an entry that is a directory, or a tuple the gate's validator rejects).

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { safeGitHead } from "./visual-regression/lib/build-source-identity.mjs";
import {
  decideArgumentRefusal,
  parseArgs as parseGateArgs,
} from "./wave-end-gate-binding.mjs";

/** First line hashed: names the scheme, so a future change cannot collide. */
export const IDENTITY_SCHEME = "wave-end-source-identity/v1";

/** The value an absent path contributes. Not a valid hex digest, by design. */
export const DELETION_MARKER = "<deleted>";

/** The wave id used only to run the gate's own validator over the tuple. */
const SELF_CHECK_WAVE = "source-tuple-self-check";

export const SOURCE_TUPLE_EXIT_CODES = Object.freeze({
  OK: 0,
  USAGE: 2,
  REFUSED: 3,
});

/** A refusal: the tool will not print a tuple it cannot stand behind. */
export class SourceTupleRefusal extends Error {
  /**
   * @param {string} reason Machine-readable id.
   * @param {string} message Explanation.
   * @param {object|null} [details] Structured context.
   */
  constructor(reason, message, details = null) {
    super(message);
    this.name = "SourceTupleRefusal";
    this.reason = reason;
    this.details = details;
  }
}

/**
 * Run git read-only against `root`.
 *
 * @param {string} cwd Directory git is pointed at.
 * @param {string[]} args Git arguments.
 * @returns {Buffer} Raw stdout.
 */
function runGit(cwd, args) {
  return execFileSync("git", ["--no-optional-locks", "-C", cwd, ...args], {
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 512 * 1024 * 1024,
  });
}

/**
 * Parse `git status --porcelain=v1 -z` output into the set of paths it names.
 *
 * Each entry is `XY <path>` terminated by NUL; when X or Y is `R` or `C` the
 * entry is followed by one more NUL-terminated field, the ORIGINAL path.
 *
 * @param {Buffer} output Raw status output.
 * @returns {Array<{status: string, path: Buffer, originalPath: Buffer|null}>} Entries, in output order.
 */
export function parsePorcelainZ(output) {
  const fields = [];
  let start = 0;
  for (let index = 0; index < output.length; index++) {
    if (output[index] === 0) {
      fields.push(output.subarray(start, index));
      start = index + 1;
    }
  }
  if (start < output.length) {
    throw new SourceTupleRefusal(
      "source-status-unparsable",
      "git status output does not end with a NUL terminator",
    );
  }
  const entries = [];
  for (let index = 0; index < fields.length; index++) {
    const field = fields[index];
    if (field.length < 4 || field[2] !== 0x20) {
      throw new SourceTupleRefusal(
        "source-status-unparsable",
        `git status entry ${index} is not "XY <path>"`,
        { entry: field.toString("utf8") },
      );
    }
    const status = field.subarray(0, 2).toString("latin1");
    const entryPath = field.subarray(3);
    let originalPath = null;
    if (/[RC]/.test(status)) {
      index++;
      if (index >= fields.length || fields[index].length === 0) {
        throw new SourceTupleRefusal(
          "source-status-unparsable",
          `git status rename/copy entry "${entryPath.toString("utf8")}" has no original path`,
        );
      }
      originalPath = fields[index];
    }
    entries.push({ status, path: entryPath, originalPath });
  }
  return entries;
}

/**
 * What one path contributes, read from the worktree now.
 *
 * @param {string} root Repository root.
 * @param {Buffer} rawPath Path bytes as git printed them (repo-relative).
 * @returns {{path: Buffer, kind: "file"|"deleted"|"symlink", value: string}} The record.
 */
export function recordForPath(root, rawPath) {
  const relative = rawPath.toString("utf8");
  const absolute = path.join(root, relative);
  let stats;
  try {
    stats = fs.lstatSync(absolute);
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") {
      return { path: rawPath, kind: "deleted", value: DELETION_MARKER };
    }
    throw error;
  }
  if (stats.isSymbolicLink()) {
    return { path: rawPath, kind: "symlink", value: fs.readlinkSync(absolute) };
  }
  if (stats.isDirectory()) {
    throw new SourceTupleRefusal(
      "source-entry-is-directory",
      `"${relative}" is a directory (a gitlink or a nested repository); the source identity cannot digest it`,
      { path: relative },
    );
  }
  if (!stats.isFile()) {
    throw new SourceTupleRefusal(
      "source-entry-not-a-file",
      `"${relative}" is neither a file, a symlink nor absent`,
      { path: relative },
    );
  }
  const digest = createHash("sha256")
    .update(fs.readFileSync(absolute))
    .digest("hex");
  return { path: rawPath, kind: "file", value: digest };
}

/**
 * The identity digest over HEAD and the records, in path-byte order.
 *
 * @param {string} commit The HEAD commit.
 * @param {Array<{path: Buffer, kind: string, value: string}>} records One per path.
 * @returns {string} 64 lowercase hex.
 */
export function digestSourceIdentity(commit, records) {
  const sorted = [...records].sort((a, b) => Buffer.compare(a.path, b.path));
  const hash = createHash("sha256");
  hash.update(`${IDENTITY_SCHEME}\nHEAD ${commit}\n`);
  for (const record of sorted) {
    hash.update(record.path);
    hash.update(`\0${record.kind}\0`);
    hash.update(Buffer.from(record.value, "utf8"));
    hash.update("\n");
  }
  return hash.digest("hex");
}

/**
 * Check the tuple with the gate's OWN argument validator, so the tool can
 * never print values the gate would refuse.
 *
 * @param {{sourceCommit: string, sourceDirty: boolean, sourceIdentity: string}} tuple
 */
export function assertGateAcceptsTuple(tuple) {
  const refusal = decideArgumentRefusal(
    parseGateArgs(["--wave", SELF_CHECK_WAVE, ...formatTupleArgs(tuple)]),
  );
  if (refusal) {
    throw new SourceTupleRefusal(
      "source-tuple-rejected-by-gate",
      `the wave-end gate's validator rejects the tuple: ${refusal.message ?? JSON.stringify(refusal)}`,
      { refusal },
    );
  }
}

/**
 * @param {{sourceCommit: string, sourceDirty: boolean, sourceIdentity: string}} tuple
 * @returns {string[]} The gate's three flag/value pairs, in order.
 */
export function formatTupleArgs(tuple) {
  return [
    "--source-commit",
    tuple.sourceCommit,
    "--source-dirty",
    tuple.sourceDirty ? "true" : "false",
    "--source-identity",
    tuple.sourceIdentity,
  ];
}

/**
 * Compute the source tuple of the working tree containing `repo`.
 *
 * @param {object} [options] Options.
 * @param {string} [options.repo] Any directory in the tree; defaults to cwd.
 * @param {Function} [options.git] `(cwd, args) => Buffer` seam; defaults to git.
 * @param {Function} [options.head] `(root) => string|undefined` seam; defaults to `safeGitHead`.
 * @returns {{repository: string, sourceCommit: string, sourceDirty: boolean, sourceIdentity: string, entries: number, scheme: string}}
 */
export function computeSourceTuple({
  repo = process.cwd(),
  git = runGit,
  head = safeGitHead,
} = {}) {
  let root;
  try {
    root = git(path.resolve(repo), ["rev-parse", "--show-toplevel"])
      .toString("utf8")
      .trim();
  } catch {
    throw new SourceTupleRefusal(
      "source-not-a-repository",
      `${path.resolve(repo)} is not inside a git working tree`,
      { repo: path.resolve(repo) },
    );
  }
  root = path.resolve(root);
  const commit = head(root);
  if (typeof commit !== "string" || !/^[0-9a-f]{40}$/.test(commit)) {
    throw new SourceTupleRefusal(
      "source-head-unreadable",
      `HEAD of ${root} could not be read as a 40-hex commit`,
      { repository: root },
    );
  }
  const entries = parsePorcelainZ(
    git(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]),
  );
  const byPath = new Map();
  for (const entry of entries) {
    for (const rawPath of [entry.path, entry.originalPath]) {
      if (rawPath === null) {
        continue;
      }
      const key = rawPath.toString("hex");
      if (!byPath.has(key)) {
        byPath.set(key, recordForPath(root, rawPath));
      }
    }
  }
  const tuple = {
    repository: root,
    sourceCommit: commit,
    sourceDirty: entries.length > 0,
    sourceIdentity: digestSourceIdentity(commit, [...byPath.values()]),
    entries: byPath.size,
    scheme: IDENTITY_SCHEME,
  };
  assertGateAcceptsTuple(tuple);
  return tuple;
}

/**
 * @param {string[]} argv Arguments after the script name.
 * @returns {{repo: string, json: boolean}} Options.
 */
export function parseSourceTupleArgs(argv) {
  const options = { repo: process.cwd(), json: false };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--json") {
      options.json = true;
    } else if (arg === "--repo") {
      if (index + 1 >= argv.length || argv[index + 1].startsWith("--")) {
        throw new TypeError("--repo requires a value");
      }
      options.repo = argv[++index];
    } else {
      throw new TypeError(`unknown argument: ${arg}`);
    }
  }
  return options;
}

/**
 * CLI entry.
 *
 * @param {string[]} argv Arguments after the script name.
 * @param {{stdout?: {write: Function}, stderr?: {write: Function}}} [io]
 * @returns {number} The exit code.
 */
export function main(argv, io = {}) {
  const stdout = io.stdout ?? process.stdout;
  const stderr = io.stderr ?? process.stderr;
  let options;
  try {
    options = parseSourceTupleArgs(argv);
  } catch (error) {
    stderr.write(`wave-end-source-tuple: ${error.message}\n`);
    stderr.write(
      "usage: node Tools/wave-end-source-tuple.mjs [--repo <dir>] [--json]\n",
    );
    return SOURCE_TUPLE_EXIT_CODES.USAGE;
  }
  try {
    const tuple = computeSourceTuple({ repo: options.repo });
    if (options.json) {
      stdout.write(`${JSON.stringify(tuple, null, 2)}\n`);
    } else {
      stdout.write(`${formatTupleArgs(tuple).join(" ")}\n`);
    }
    return SOURCE_TUPLE_EXIT_CODES.OK;
  } catch (error) {
    if (error instanceof SourceTupleRefusal) {
      stderr.write(
        `wave-end-source-tuple: REFUSED (${error.reason}) - ${error.message}\n`,
      );
      return SOURCE_TUPLE_EXIT_CODES.REFUSED;
    }
    throw error;
  }
}

if (
  process.argv[1] &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
) {
  process.exitCode = main(process.argv.slice(2));
}
