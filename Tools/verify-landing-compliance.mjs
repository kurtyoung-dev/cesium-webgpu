#!/usr/bin/env node
// verify-landing-compliance.mjs — the after-the-fact detector that makes a
// `--no-verify` bypass visible.
// @purpose After-the-fact detector that re-runs the landing rules + C16 marker gate over a landed commit range, making any --no-verify hook bypass visible.
// @status ACTIVE
//
// Ruling: migration_doc/MAINTAINER_RULINGS_2026-08-14.md R-2026-08-14-4
// Charter: EXECUTOR_LANE_CHARTER_2026-08-14.md §2.2/§2.3
// Findings: SOL_WEEK_AUDIT_2026-08-14.md S9, S10
//
// WHY THIS EXISTS. `.husky/pre-push` refuses a non-compliant push, and the
// pre-commit hook runs the C16 marker guard over staged files — but git's own
// `--no-verify` skips both, and nothing recorded that it had been used. Finding
// S9 was reconstructed by noticing that eight clean-listed marker ERRORS were
// sitting in a landed commit; that reconstruction should not have needed an
// audit. This script re-runs both checks over a range of already-landed
// commits, so the bypass produces a red on the next run instead of silence.
//
// WHAT IT CHECKS over the range, per commit authored by `cesium-webgpu-agent`:
//   (a) `Batch NNNN: ` prefix, monotonic against the highest batch reachable
//       from the range's base;
//   (b) non-empty body;
//   (c) `Co-Authored-By:` trailer;
//   (+) the commit's own timestamps against the quiet-hours window. The hook
//       can only see push time; commit time is the half finding S10 measured,
//       and it is only observable after the fact — which is here.
// Merge commits (two or more parents) skip (a)-(c) exactly as the hook does.
//
// AND once for the whole range: the C16 comment-marker grammar and its
// clean-list ratchet, re-run over every in-scope source file the range touched,
// reading the file's content AT THE RANGE HEAD rather than from the working
// tree. That distinction is the point — a later batch cleaning up the markers
// must not make the landing that shipped them read clean.
//
// USAGE
//   node Tools/verify-landing-compliance.mjs            (npm run verify-landing)
//       Default range: `<upstream>..HEAD` when the branch has an upstream,
//       otherwise the last 20 commits.
//   node Tools/verify-landing-compliance.mjs --range origin/main..HEAD
//   node Tools/verify-landing-compliance.mjs --last 30
//   node Tools/verify-landing-compliance.mjs --json
//
// EXIT CODES
//   0  every commit and every touched file complies
//   1  at least one violation (commit rule or marker-guard error)
//   2  the verifier itself failed — bad range, git unavailable, guard crashed
//   3  STRUCTURAL: the range is empty, so nothing was verified. A run that
//      inspects nothing must not read as a pass.

import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  isCleanListed,
  isInScope,
  readCleanList,
  scanSource,
  toRepoRelative,
} from "./c16/comment-marker-guard.mjs";
import {
  evaluateCommits,
  highestBatchIn,
  parseCommitRecords,
} from "./landing-rules.mjs";

const ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const LOG_FORMAT = "%H%n%P%n%an%n%ae%n%aI%n%cI%n%s%n%b";

/** Mirrors the pre-push guard's cap; see its rationale. */
const BASE_LOG_SCAN_CAP = 5000;

/** Default depth when the branch has no upstream to diff against. */
const DEFAULT_LAST = 20;

/**
 * Run git and return stdout.
 *
 * @param {string[]} args Arguments.
 * @returns {string} stdout.
 */
function git(args) {
  return execFileSync("git", args, {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 1 << 28,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/**
 * Parse argv.
 *
 * @param {string[]} argv Arguments after the script name.
 * @returns {{range: string|null, last: number|null, json: boolean, help: boolean}} Options.
 */
export function parseArgs(argv) {
  const options = { range: null, last: null, json: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--json") {
      options.json = true;
    } else if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else if (arg === "--range") {
      options.range = argv[i + 1];
      i += 1;
    } else if (arg === "--last") {
      options.last = Number(argv[i + 1]);
      i += 1;
    } else if (arg.startsWith("--range=")) {
      options.range = arg.slice("--range=".length);
    } else if (arg.startsWith("--last=")) {
      options.last = Number(arg.slice("--last=".length));
    } else {
      throw new Error(`unknown argument ${JSON.stringify(arg)}`);
    }
  }
  if (options.range !== null && !options.range.includes("..")) {
    throw new Error(
      `--range needs a two-dot revision range (got ${JSON.stringify(options.range)})`,
    );
  }
  if (
    options.last !== null &&
    (!Number.isInteger(options.last) || options.last <= 0)
  ) {
    throw new Error("--last needs a positive integer");
  }
  return options;
}

/**
 * Resolve the range to verify.
 *
 * @param {{range: string|null, last: number|null}} options Parsed options.
 * @returns {{base: string, head: string, label: string}} Range endpoints.
 */
function resolveRange(options) {
  if (options.range !== null) {
    const [base, head] = options.range.split("..");
    return {
      base,
      head: head === "" || head === undefined ? "HEAD" : head,
      label: options.range,
    };
  }
  if (options.last !== null) {
    return {
      base: `HEAD~${options.last}`,
      head: "HEAD",
      label: `last ${options.last} commit(s)`,
    };
  }
  try {
    const upstream = git(["rev-parse", "--abbrev-ref", "@{u}"]).trim();
    return { base: upstream, head: "HEAD", label: `${upstream}..HEAD` };
  } catch {
    return {
      base: `HEAD~${DEFAULT_LAST}`,
      head: "HEAD",
      label: `last ${DEFAULT_LAST} commit(s) (no upstream configured)`,
    };
  }
}

/**
 * Source files the range touched that the comment standard applies to.
 *
 * Anything outside the engine/widgets source roots is dropped using the
 * guard's own scope predicate rather than a second copy of the glob.
 *
 * @param {{base: string, head: string}} range Range endpoints.
 * @returns {string[]} Repo-relative paths.
 */
function touchedScopeFiles(range) {
  const raw = git([
    "diff",
    "--name-only",
    "--diff-filter=ACMR",
    `${range.base}`,
    `${range.head}`,
  ]);
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .map((line) => toRepoRelative(line))
    .filter((rel) => isInScope(rel));
}

/**
 * Re-run the marker guard's scanner over the range's OWN content.
 *
 * The guard executable reads the working tree, which answers "is the tree
 * clean now" — a different question from "did this range land marker errors
 * past the guard". A commit whose violations a later batch cleaned up would
 * read clean, and that is exactly the S9 shape this detector exists to catch.
 * So the shared scanner and the shared clean-list ratchet are driven over the
 * blobs at the range head instead. Same grammar, same ratchet, historically
 * honest subject.
 *
 * @param {string[]} files Repo-relative paths.
 * @param {string} head Revision whose content to read.
 * @param {string[]} cleanList Clean-list entries.
 * @returns {{errors: object[], warnings: object[], scanned: number}} Findings.
 */
function scanRangeMarkers(files, head, cleanList) {
  const errors = [];
  const warnings = [];
  let scanned = 0;
  for (const rel of files) {
    let source;
    try {
      source = git(["show", `${head}:${rel}`]);
    } catch {
      // Added and then removed inside the range: nothing landed to check.
      continue;
    }
    scanned += 1;
    const strict = isCleanListed(rel, cleanList);
    for (const finding of scanSource(rel, source)) {
      (strict ? errors : warnings).push(finding);
    }
  }
  return { errors, warnings, scanned };
}

const STATUS_GLYPH = Object.freeze({
  pass: "ok  ",
  fail: "FAIL",
  skip: "--  ",
});

/**
 * Entry point.
 *
 * @returns {number} Process exit code.
 */
async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(
      [
        "verify-landing-compliance — re-check landed commits against the landing rules.",
        "",
        "  --range <A..B>   verify this range (default: <upstream>..HEAD)",
        "  --last <N>       verify the last N commits",
        "  --json           machine-readable report",
        "",
        "Exit: 0 clean, 1 violations, 2 verifier failure, 3 empty range.",
        "",
      ].join("\n"),
    );
    return 0;
  }

  const range = resolveRange(options);
  const commits = parseCommitRecords(
    git([
      "log",
      "-z",
      "--reverse",
      `--format=${LOG_FORMAT}`,
      `${range.base}..${range.head}`,
    ]),
  );

  if (commits.length === 0) {
    const message = `verify-landing: STRUCTURAL — ${range.label} contains no commits; nothing was verified`;
    if (options.json) {
      process.stdout.write(
        `${JSON.stringify({ ok: false, structural: true, range: range.label }, null, 2)}\n`,
      );
    } else {
      process.stdout.write(`${message}\n`);
    }
    return 3;
  }

  let baseSubjects;
  try {
    baseSubjects = git([
      "log",
      "--format=%s",
      `--max-count=${BASE_LOG_SCAN_CAP}`,
      "--no-merges",
      range.base,
    ]).split("\n");
  } catch {
    baseSubjects = [];
  }
  const highestPushedBatch = highestBatchIn(baseSubjects);

  const evaluation = evaluateCommits(commits, {
    highestPushedBatch,
    includeCommitQuietHours: true,
  });
  const files = touchedScopeFiles(range);
  const markers = scanRangeMarkers(files, range.head, await readCleanList());
  const ok = evaluation.ok && markers.errors.length === 0;

  if (options.json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          ok,
          range: range.label,
          highestPushedBatch,
          commits: evaluation.commits,
          violations: evaluation.violations,
          markerGuard: markers,
        },
        null,
        2,
      )}\n`,
    );
    return ok ? 0 : 1;
  }

  const lines = [
    `verify-landing: ${range.label} — ${commits.length} commit(s), ${evaluation.checked} governed, baseline batch ${highestPushedBatch ?? "none"}`,
  ];
  for (const commit of evaluation.commits) {
    const failed = commit.verdicts.filter((entry) => entry.status === "fail");
    if (failed.length === 0) {
      continue;
    }
    lines.push(`  ${commit.shortSha}  ${commit.subject}`);
    for (const entry of failed) {
      lines.push(
        `    ${STATUS_GLYPH[entry.status]} ${entry.rule.padEnd(20)} ${entry.detail}`,
      );
    }
  }
  lines.push(
    `  marker guard: ${markers.scanned} in-scope file(s) re-scanned at ${range.head} — ${markers.errors.length} error(s), ${markers.warnings.length} warning(s)`,
  );
  for (const finding of markers.errors) {
    lines.push(
      `    FAIL marker-guard        ${finding.file}:${finding.line} [${finding.ruleId}] ${finding.match}`,
    );
  }
  lines.push(
    ok
      ? "verify-landing: PASS"
      : `verify-landing: FAIL — ${evaluation.violations} commit rule violation(s)${markers.errors.length > 0 ? ` + ${markers.errors.length} marker-guard error(s)` : ""}`,
  );
  if (!ok) {
    lines.push(
      "  These commits are already landed; history is not rewritten (R-2026-08-14-4).",
      "  Record the violation honestly and fix the process, not the history.",
    );
  }
  process.stdout.write(`${lines.join("\n")}\n`);
  return ok ? 0 : 1;
}

const isEntryPoint =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isEntryPoint) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      process.stderr.write(
        `verify-landing: FAILED TO RUN — ${error?.message ?? error}\n`,
      );
      process.exitCode = 2;
    });
}
