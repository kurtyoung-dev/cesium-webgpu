#!/usr/bin/env node
// verify-readme-index.mjs — the README-index coverage guard, dual of
// Tools/verify-tracked-references.mjs.
//
// @purpose Fails when a tracked migration_doc/**/*.md file is named nowhere in migration_doc/README.md (by basename or by the directory-aggregate convention README.md documents at :121-127), or when a README markdown link names a migration_doc path the tree does not track.
// @status ACTIVE
//
// WHY THIS EXISTS. `verify-tracked-references.mjs` asks "does every reference
// OUT of a commit resolve inside the tree" for code. Nothing asked the mirror
// question for the doc index: `migration_doc/README.md` claims to be the map
// of the whole `migration_doc/` corpus ("Trust this index over any individual
// doc's self-description"), and DOC_FITNESS_AUDIT_2026-09-04.md's G-06 found
// it drifts silently both ways — `CHELATE.md` landed Batch 1404 and was named
// nowhere, and a README row can keep pointing at a path a rename or archive
// already moved. Nothing before this guard re-derives README's own coverage
// claim against `git ls-files`; a hand count is correct for one commit and
// stale at the next one that adds a doc outside every existing aggregate row.
//
// THE DIRECTORY-AGGREGATE CONVENTION (seeded from README.md:121-127, not a
// hand list). README documents a real convention: a whole directory can be
// "covered" by one backtick-quoted mention ending in `/` — e.g.
// `` `archive/batch-plans/` `` — without every file under it being named
// individually. This guard extracts that convention FROM README's own text
// (every backtick span ending in `/`) rather than hard-coding the directories
// it currently uses, so a new aggregate row README adds keeps working without
// a matching guard edit. A tracked doc is COVERED when either (a) its bare
// filename appears anywhere in README's text, or (b) one of its ancestor
// directories (relative to `migration_doc/`) is one of those backtick-quoted
// mentions.
//
// WHAT THIS DOES NOT CHECK. Anchor correctness (`#some-heading` resolving to
// the right section, and that section still containing what the sentence
// around it claims) is Gd3's job, the doc-citation resolver — this guard only
// asks whether the FILE half of a link or mention resolves, never the
// fragment half. It also does not check row placement, ordering, or table
// formatting.
//
// SOURCING. The tracked file set comes from `git ls-files`, never a disk
// walk — an untracked stray `.md` dropped under `migration_doc/` is invisible
// to a clone and must be invisible here too.
//
// EXIT CODES
//   0  every tracked migration_doc/**/*.md is named; every README-linked
//      migration_doc path resolves to a tracked path
//   1  at least one violation (UNINDEXED or BROKEN-LINK)
//   2  the guard itself could not run (bad argument, missing README, git
//      command failed)
//
// USAGE
//   node Tools/verify-readme-index.mjs                # the repo at cwd
//   node Tools/verify-readme-index.mjs --root <dir>    # a fixture repo root
//   node Tools/verify-readme-index.mjs --json

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const GIT_TIMEOUT_MS = 30_000;
const GIT_MAX_BUFFER = 64 * 1024 * 1024;

/** One backtick-quoted path-segment run ending in `/` — a directory mention. */
const DIRECTORY_MENTION_PATTERN =
  /`([A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*\/)`/g;

/** A markdown link target: the `(href)` half of `[text](href)`. */
const LINK_PATTERN = /\]\(([^)\s]+)\)/g;

/** `scheme://` prefix — used to skip external links. */
const EXTERNAL_LINK_PATTERN = /^[a-z][a-z0-9+.-]*:\/\//iu;

/**
 * Parse CLI arguments.
 *
 * @param {string[]} argv Arguments after the script path.
 * @returns {{root: string, json: boolean}} Parsed options.
 */
export function parseArgs(argv) {
  const options = { root: process.cwd(), json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--root") {
      i += 1;
      if (i >= argv.length) {
        throw new Error("verify-readme-index: --root requires a value");
      }
      options.root = argv[i];
    } else if (arg.startsWith("--root=")) {
      options.root = arg.slice("--root=".length);
    } else if (arg === "--json") {
      options.json = true;
    } else {
      throw new Error(`verify-readme-index: unrecognized argument: ${arg}`);
    }
  }
  return options;
}

/**
 * List every tracked path under `migration_doc/`, repo-root-relative and
 * forward-slashed. Sourced from `git ls-files`, never a disk walk.
 *
 * @param {string} root Repository root to run git in.
 * @returns {string[]} Tracked paths, e.g. `migration_doc/CHELATE.md`.
 */
export function listTrackedMigrationDocPaths(root) {
  const output = execFileSync(
    "git",
    ["ls-files", "-z", "--", "migration_doc"],
    {
      cwd: root,
      encoding: "utf8",
      maxBuffer: GIT_MAX_BUFFER,
      timeout: GIT_TIMEOUT_MS,
    },
  );
  return output
    .split("\0")
    .filter((entry) => entry !== "")
    .map((entry) => entry.replace(/\\/g, "/"));
}

/**
 * Extract every backtick-quoted directory mention from README's raw text,
 * relative to `migration_doc/`, without its trailing slash.
 *
 * @param {string} readmeText Raw README.md contents.
 * @returns {Set<string>} Documented directory-aggregate mentions.
 */
export function extractDirectoryAggregates(readmeText) {
  const aggregates = new Set();
  for (const match of readmeText.matchAll(DIRECTORY_MENTION_PATTERN)) {
    aggregates.add(match[1].replace(/\/$/u, ""));
  }
  return aggregates;
}

/**
 * Extract every markdown link target that names a `migration_doc`-relative
 * path once resolved against README's own directory (`migration_doc/`),
 * stripped of any `#fragment`. External links and pure-fragment links are
 * skipped; a link that resolves OUTSIDE `migration_doc/` (e.g. `../CLAUDE.md`)
 * is out of this guard's contract and skipped too.
 *
 * @param {string} readmeText Raw README.md contents.
 * @returns {string[]} Repo-root-relative, forward-slashed paths, e.g.
 *   `migration_doc/FEATURE_INVENTORY.md`.
 */
export function extractLinkedMigrationDocPaths(readmeText) {
  const resolved = [];
  for (const match of readmeText.matchAll(LINK_PATTERN)) {
    const href = match[1];
    if (href.startsWith("#") || EXTERNAL_LINK_PATTERN.test(href)) {
      continue;
    }
    const withoutFragment = href.split("#")[0];
    if (withoutFragment === "") {
      continue;
    }
    const joined = path.posix.normalize(
      path.posix.join("migration_doc", withoutFragment),
    );
    if (joined !== "migration_doc" && !joined.startsWith("migration_doc/")) {
      continue; // escapes migration_doc/ — out of this guard's contract
    }
    resolved.push(joined);
  }
  return resolved;
}

/**
 * Whether `relPath` (relative to `migration_doc/`) is covered by README:
 * either its bare filename is named anywhere in the text, or one of its
 * ancestor directories is a documented directory-aggregate mention.
 *
 * @param {string} relPath Path relative to `migration_doc/`, forward-slashed.
 * @param {string} readmeText Raw README.md contents.
 * @param {Set<string>} directoryAggregates From {@link extractDirectoryAggregates}.
 * @returns {boolean} True when covered.
 */
export function isCovered(relPath, readmeText, directoryAggregates) {
  const basename = path.posix.basename(relPath);
  if (readmeText.includes(basename)) {
    return true;
  }
  let dir = path.posix.dirname(relPath);
  while (dir !== "." && dir !== "/") {
    if (directoryAggregates.has(dir)) {
      return true;
    }
    dir = path.posix.dirname(dir);
  }
  return false;
}

/**
 * Whether `repoRelativePath` resolves against the tracked set: either it IS
 * a tracked path, or (for a directory-shaped mention) at least one tracked
 * path sits under it.
 *
 * @param {string} repoRelativePath e.g. `migration_doc/FOO.md`.
 * @param {Set<string>} trackedSet Every tracked path under `migration_doc/`.
 * @returns {boolean} True when the link resolves.
 */
export function linkResolves(repoRelativePath, trackedSet) {
  if (trackedSet.has(repoRelativePath)) {
    return true;
  }
  const prefix = `${repoRelativePath}/`;
  for (const tracked of trackedSet) {
    if (tracked.startsWith(prefix)) {
      return true;
    }
  }
  return false;
}

/**
 * The pure computation core: given README's already-read text and the
 * already-obtained tracked-path list, produce the coverage report. No I/O, no
 * git — this is the function a spec calls with injected fixtures, so a test
 * never needs a real or throwaway git repository. (This campaign's workers do
 * not run git write commands, and `git init`/`git add` in a temp directory is
 * still one; see `verify-tracked-references.spec.mjs`'s injected-tree
 * rationale for the same constraint on a sibling guard.)
 *
 * @param {{readmeText: string, trackedPaths: string[]}} inputs Already-read
 *   README text and the tracked `migration_doc/**` path list, in the same
 *   shape {@link listTrackedMigrationDocPaths} returns.
 * @returns {{violations: {type: string, file: string, reason: string}[], trackedMarkdownCount: number, linkedPathCount: number}} Report.
 */
export function buildReportFromInputs({ readmeText, trackedPaths }) {
  const trackedSet = new Set(trackedPaths);
  const directoryAggregates = extractDirectoryAggregates(readmeText);

  const violations = [];
  const seen = new Set();
  const record = (violation) => {
    const key = `${violation.type} ${violation.file}`;
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    violations.push(violation);
  };

  const trackedMarkdown = trackedPaths.filter(
    (entry) => entry.endsWith(".md") && entry !== "migration_doc/README.md",
  );
  for (const tracked of trackedMarkdown) {
    const relPath = tracked.slice("migration_doc/".length);
    if (!isCovered(relPath, readmeText, directoryAggregates)) {
      record({
        type: "UNINDEXED",
        file: tracked,
        reason:
          "tracked but named nowhere in migration_doc/README.md (no basename mention, no covering directory-aggregate mention)",
      });
    }
  }

  const linkedPaths = extractLinkedMigrationDocPaths(readmeText);
  for (const linked of linkedPaths) {
    if (!linkResolves(linked, trackedSet)) {
      record({
        type: "BROKEN-LINK",
        file: linked,
        reason:
          "migration_doc/README.md links to it, but it is not a tracked path",
      });
    }
  }

  return {
    violations,
    trackedMarkdownCount: trackedMarkdown.length,
    linkedPathCount: linkedPaths.length,
  };
}

/**
 * Build the full coverage report for a repository rooted at `root`. Thin I/O
 * shell over {@link buildReportFromInputs}: reads the real README and asks
 * real git for the tracked set, then hands both to the pure core.
 *
 * @param {{root: string}} options Where `root` is the repository root
 *   (the directory containing `migration_doc/`).
 * @returns {{violations: {type: string, file: string, reason: string}[], trackedMarkdownCount: number, linkedPathCount: number}} Report.
 */
export function buildReport({ root }) {
  const readmePath = path.join(root, "migration_doc", "README.md");
  if (!existsSync(readmePath)) {
    throw new Error(`no README at ${readmePath} — nothing to check`);
  }
  const readmeText = readFileSync(readmePath, "utf8");
  const trackedPaths = listTrackedMigrationDocPaths(root);
  return buildReportFromInputs({ readmeText, trackedPaths });
}

/**
 * Render the report as the human-readable text a CI log or terminal prints.
 *
 * @param {ReturnType<typeof buildReport>} report Report.
 * @returns {string} Multi-line text, no trailing newline.
 */
export function formatReport(report) {
  const lines = [
    "README index coverage",
    `  tracked migration_doc/**/*.md (excl. README.md): ${report.trackedMarkdownCount}`,
    `  README-linked migration_doc paths checked:       ${report.linkedPathCount}`,
    `  violations:                                      ${report.violations.length}`,
  ];
  if (report.violations.length === 0) {
    lines.push("", "Every tracked doc is named; every linked path resolves.");
    return lines.join("\n");
  }
  lines.push("", "Violations:");
  for (const violation of report.violations) {
    lines.push(`  ${violation.type}: ${violation.file}`);
    lines.push(`    ${violation.reason}`);
  }
  return lines.join("\n");
}

/**
 * CLI entry point.
 *
 * @param {string[]} argv Arguments after the script path.
 * @param {{stdout?: {write: Function}, stderr?: {write: Function}}} [runtime]
 *   Injectable I/O, for tests.
 * @returns {number} Process exit code (0, 1, or 2 — see the header).
 */
export function runCli(argv, runtime = {}) {
  const stdout = runtime.stdout ?? process.stdout;
  const stderr = runtime.stderr ?? process.stderr;

  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    stderr.write(`${error.message}\n`);
    return 2;
  }

  let report;
  try {
    report = buildReport({ root: path.resolve(options.root) });
  } catch (error) {
    stderr.write(`verify-readme-index: ${error.message}\n`);
    return 2;
  }

  stdout.write(
    `${options.json ? JSON.stringify(report, null, 2) : formatReport(report)}\n`,
  );
  return report.violations.length > 0 ? 1 : 0;
}

const executablePath = process.argv[1];
const modulePath = fileURLToPath(import.meta.url);
const normalizeExecutablePath = (value) => {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
};
if (
  executablePath !== undefined &&
  normalizeExecutablePath(executablePath) ===
    normalizeExecutablePath(modulePath)
) {
  process.exitCode = runCli(process.argv.slice(2));
}
