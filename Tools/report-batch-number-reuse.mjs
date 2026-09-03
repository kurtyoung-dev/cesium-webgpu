#!/usr/bin/env node
// report-batch-number-reuse.mjs — CI-side visibility net over Batch-number
// reuse across full reachable git history.
//
// @purpose Reports every `Batch NNNN:` commit subject that reuses a number already used by a different commit, across full reachable git history.
// @status ACTIVE
//
// WHY THIS EXISTS ALONGSIDE THE PRE-PUSH GUARD. `Tools/pre-push-guard.mjs`
// already refuses most reuse two ways: `checkPushedBatchUniqueness` catches
// a duplicate within the commits one push carries, and `checkBatchMonotonic`
// additionally seeds its high-water mark from the *remote's* landed history
// (`highestLandedBatch` over the remote tips), so reusing an already-landed
// number is refused even from a single-commit push. What both checks share
// is that they only ever see commits the guard's hook actually ran against.
// A reuse landed before the guard existed, landed with `--no-verify`, or
// landed through any path the guard never saw (a force-push that skipped
// the hook, a mirror, manual history surgery) is invisible to both. Ruling
// R-2026-09-02-12 answers that with a second, independent net: serialized
// landings by one root seat, plus a CI report (this script) over the WHOLE
// history reachable from whatever ref CI checked out. There is deliberately
// no server-side enforcement — this is report-only, and it never fails a
// build over what it finds. If a reuse slipped past the guard, it is still
// visible on the Actions page.
//
// SCOPE DIFFERENCE FROM THE GUARD, ON PURPOSE. This script does not repeat
// the guard's `isAgentAuthored` / `isExempt` (merge-commit) filtering — it
// is a visibility net over every commit subject that claims a Batch number,
// not a re-run of push-time policy. The Batch grammar itself
// (`checkBatchPrefix`) is imported from `landing-rules.mjs` rather than
// re-derived, so the two tools can never silently drift on what counts as a
// governed Batch subject.
//
// EXIT CODE. 0 always — including when duplicates are found — unless the
// underlying `git log` invocation itself fails (not a git repository, a bad
// `--range`, git missing from PATH). That is a real infrastructure problem
// and exits 1 with the git error on stderr.
//
// USAGE
//   node Tools/report-batch-number-reuse.mjs                # full history from HEAD
//   node Tools/report-batch-number-reuse.mjs --json          # machine-readable report
//   node Tools/report-batch-number-reuse.mjs --range <range> # e.g. origin/main..HEAD, for local use

import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { checkBatchPrefix } from "./landing-rules.mjs";

/** Field separator between hash and subject in the `git log --format` output. */
const FIELD_SEPARATOR = "\t";

/**
 * Parse one `<sha><TAB><subject>` line. A commit subject can contain
 * anything except a tab or newline, so the first tab is the only safe cut.
 *
 * @param {string} line One `git log --format=%H%x09%s` output line.
 * @returns {{sha: string, subject: string}} Parsed record.
 */
export function parseLogLine(line) {
  const cut = line.indexOf(FIELD_SEPARATOR);
  if (cut === -1) {
    throw new Error(
      `report-batch-number-reuse: malformed git log line (no tab separator): ${JSON.stringify(line)}`,
    );
  }
  return { sha: line.slice(0, cut), subject: line.slice(cut + 1) };
}

/**
 * Run `git log --format=%H%x09%s` and return one record per commit, in the
 * order git log returns them (newest first, unless `range` says otherwise).
 *
 * @param {{cwd?: string, range?: string}} [options] `cwd` to run git in;
 *   `range` a revision range/args appended after the format (e.g.
 *   `origin/main..HEAD`) — omitted, this walks full history from HEAD.
 * @returns {{sha: string, subject: string}[]} Commit records.
 */
export function collectCommitSubjects({ cwd, range } = {}) {
  const args = ["log", `--format=%H${FIELD_SEPARATOR}%s`];
  if (range !== undefined && range !== "") {
    args.push(range);
  }
  const output = execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return output
    .split(/\r?\n/)
    .filter((line) => line !== "")
    .map((line) => parseLogLine(line));
}

/**
 * Build the reuse report from parsed commit records.
 *
 * @param {{sha: string, subject: string}[]} records Commit records, any order.
 * @returns {{totalBatchSubjects: number, distinctBatchNumbers: number, maxBatchNumber: (number|null), duplicates: {batch: number, commits: {sha: string, subject: string}[]}[]}} Report.
 */
export function buildReport(records) {
  const ownersByBatch = new Map();
  let maxBatchNumber = null;
  let totalBatchSubjects = 0;

  for (const record of records) {
    const { batch } = checkBatchPrefix(record);
    if (batch === null) {
      continue;
    }
    totalBatchSubjects += 1;
    if (maxBatchNumber === null || batch > maxBatchNumber) {
      maxBatchNumber = batch;
    }
    const owners = ownersByBatch.get(batch) ?? [];
    owners.push(record);
    ownersByBatch.set(batch, owners);
  }

  const duplicates = [...ownersByBatch]
    .filter(([, owners]) => owners.length > 1)
    .sort(([left], [right]) => left - right)
    .map(([batch, owners]) => ({ batch, commits: owners }));

  return {
    totalBatchSubjects,
    distinctBatchNumbers: ownersByBatch.size,
    maxBatchNumber,
    duplicates,
  };
}

/**
 * Render the report as the human-readable text CI prints to its job summary.
 *
 * @param {ReturnType<typeof buildReport>} report Report.
 * @returns {string} Multi-line text, no trailing newline.
 */
export function formatReport(report) {
  const lines = [
    "Batch number reuse report",
    `  total batch subjects:   ${report.totalBatchSubjects}`,
    `  distinct batch numbers: ${report.distinctBatchNumbers}`,
    `  max batch number:       ${report.maxBatchNumber ?? "(none found)"}`,
    `  duplicated numbers:     ${report.duplicates.length}`,
  ];

  if (report.duplicates.length === 0) {
    lines.push("", "No Batch number is reused across reachable history.");
    return lines.join("\n");
  }

  lines.push("", "Duplicates (a Batch number used by more than one commit):");
  for (const { batch, commits } of report.duplicates) {
    lines.push(`  Batch ${batch}:`);
    for (const commit of commits) {
      lines.push(`    ${commit.sha.slice(0, 10)}  ${commit.subject}`);
    }
  }
  return lines.join("\n");
}

/**
 * Parse CLI arguments. Throws on anything unrecognized — a report tool that
 * silently ignores a typo'd flag is worse than one that refuses to run.
 *
 * @param {string[]} argv Arguments after the script path.
 * @returns {{json: boolean, range: (string|undefined)}} Parsed options.
 */
export function parseArgs(argv) {
  const options = { json: false, range: undefined };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--json") {
      options.json = true;
    } else if (arg === "--range") {
      i += 1;
      if (i >= argv.length) {
        throw new Error("report-batch-number-reuse: --range requires a value");
      }
      options.range = argv[i];
    } else if (arg.startsWith("--range=")) {
      options.range = arg.slice("--range=".length);
    } else {
      throw new Error(
        `report-batch-number-reuse: unrecognized argument: ${arg}`,
      );
    }
  }
  return options;
}

/**
 * CLI entry point. Only a bad argument or a genuine `git log` failure
 * returns a non-zero code — a duplicate finding never does.
 *
 * @param {string[]} argv Arguments after the script path.
 * @param {{cwd?: string, stdout?: {write: Function}, stderr?: {write: Function}}} [runtime] Injectable I/O and working directory, for tests.
 * @returns {number} Process exit code.
 */
export function runCli(argv, runtime = {}) {
  const stdout = runtime.stdout ?? process.stdout;
  const stderr = runtime.stderr ?? process.stderr;

  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    stderr.write(`${error.message}\n`);
    return 1;
  }

  let records;
  try {
    records = collectCommitSubjects({
      cwd: runtime.cwd,
      range: options.range,
    });
  } catch (error) {
    stderr.write(
      `report-batch-number-reuse: git log failed: ${error.message}\n`,
    );
    return 1;
  }

  const report = buildReport(records);
  stdout.write(
    `${options.json ? JSON.stringify(report, null, 2) : formatReport(report)}\n`,
  );
  return 0;
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
