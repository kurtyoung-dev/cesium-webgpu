#!/usr/bin/env node
// inject-purpose-headers.mjs — the one-time-but-re-runnable codemod that gives
// every tooling `.mjs` the self-registering header ruling M2 requires.
//
// @purpose Idempotent codemod injecting @purpose/@status headers into the tooling .mjs fleet from the library-audit rows.
// @status ACTIVE
//
// WHAT IT DOES. It reads the .mjs library audit's classification rows (the same
// rows that produced `migration_doc/TOOLING_CATALOG.md`) and writes each file's
// one-line purpose and lifecycle status into that file's own header, so the
// catalog can be regenerated from source instead of re-derived by an audit.
// After it has run once, the headers — not this script — are the source of
// truth; the script stays because a codemod that cannot be re-run is a codemod
// nobody can verify (see the `apply-logdepth-*` precedent in the catalog).
//
// WHAT IT REFUSES TO DO. Rows graded HELD_FOR_D8 (frozen under
// `HANDOFF_2026-08-14_CODEX_PAUSE`, charter 4.3 "frozen means frozen") and
// UNKNOWN (honestly unclear, and a guessed purpose is worse than none) are
// skipped, as is any row whose file is absent from the working tree. Those are
// counted and named, never silently dropped.
//
// IDEMPOTENCE. A file already carrying `@purpose` has that line rewritten in
// place; nothing is ever duplicated. Re-running with unchanged rows rewrites
// nothing and reports every file as `unchanged`. Line endings are preserved
// byte-for-byte (this tree is `core.autocrlf=true`).
//
// USAGE
//   node Tools/inject-purpose-headers.mjs --rows <audit-rows.json> --dry-run
//   node Tools/inject-purpose-headers.mjs --rows <audit-rows.json>
//   node Tools/inject-purpose-headers.mjs --rows <r.json> --only "Tools/c16/**"
//   node Tools/inject-purpose-headers.mjs --rows <r.json> --with-class
//
// The rows file is a JSON array of `{f, cls, purpose, status}` objects with `f`
// repo-relative and slash-separated; extra keys are ignored. `--with-class`
// additionally stamps the audit's semantic class (`runner`, `scratch`, …),
// which the generator prefers over its path-derived guess — off by default
// because ruling M2 asks only for purpose and status.
//
// EXIT CODES
//   0  ran clean
//   1  one or more files could not be parsed (named on stdout)
//   2  the codemod itself failed — bad arguments, unreadable rows file

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  AUDIT_STATUS_TO_HEADER,
  injectPurposeHeader,
  normalizePurpose,
} from "./lib/purpose-header.mjs";

const ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

/**
 * Compile a glob to an anchored RegExp.
 *
 * Supports `**`, `*`, `?` and `{a,b}` — the shapes a caller actually types for
 * `--only`. Everything else is matched literally, so a stray `(` cannot turn
 * the filter into a different pattern than the one on the command line.
 *
 * @param {string} glob Glob pattern, slash-separated.
 * @returns {RegExp} Anchored matcher.
 */
export function globToRegExp(glob) {
  let out = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        // `**/` spans directories including none at all; a bare `**` is any run.
        if (glob[i + 2] === "/") {
          out += "(?:.*/)?";
          i += 2;
        } else {
          out += ".*";
          i += 1;
        }
      } else {
        out += "[^/]*";
      }
    } else if (c === "?") {
      out += "[^/]";
    } else if (c === "{") {
      const close = glob.indexOf("}", i);
      if (close === -1) {
        out += "\\{";
      } else {
        const alts = glob.slice(i + 1, close).split(",");
        out += `(?:${alts.map((a) => a.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`;
        i = close;
      }
    } else {
      out += c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${out}$`);
}

/**
 * Parse the command line.
 *
 * @param {string[]} argv Arguments after the script name.
 * @returns {{rows: string|null, dryRun: boolean, only: string|null, withClass: boolean, quiet: boolean}} Options.
 */
export function parseArgs(argv) {
  const options = {
    rows: null,
    dryRun: false,
    only: null,
    withClass: false,
    quiet: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--dry-run") {
      options.dryRun = true;
    } else if (arg === "--with-class") {
      options.withClass = true;
    } else if (arg === "--quiet") {
      options.quiet = true;
    } else if (arg === "--rows") {
      options.rows = argv[++i] ?? null;
    } else if (arg.startsWith("--rows=")) {
      options.rows = arg.slice("--rows=".length);
    } else if (arg === "--only") {
      options.only = argv[++i] ?? null;
    } else if (arg.startsWith("--only=")) {
      options.only = arg.slice("--only=".length);
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return options;
}

/**
 * Decide what happens to one audit row, without touching the disk.
 *
 * @param {{f: string, cls?: string, purpose?: string, status?: string}} row Row.
 * @returns {{file: string, skip: string|null, status: string|null, purpose: string, className: string|null}} Plan.
 */
export function planRow(row) {
  const file = String(row.f ?? "")
    .split("\\")
    .join("/");
  const mapped = Object.hasOwn(AUDIT_STATUS_TO_HEADER, row.status)
    ? AUDIT_STATUS_TO_HEADER[row.status]
    : undefined;
  let skip = null;
  if (file === "") {
    skip = "row has no file path";
  } else if (mapped === undefined) {
    skip = `unmapped audit status "${row.status}"`;
  } else if (mapped === null) {
    skip = `audit status ${row.status}`;
  } else if (normalizePurpose(row.purpose) === "") {
    skip = "row has no purpose";
  }
  return {
    file,
    skip,
    status: mapped ?? null,
    purpose: normalizePurpose(row.purpose),
    className: row.cls ? String(row.cls) : null,
  };
}

/**
 * Run the codemod.
 *
 * @param {object} options Parsed options; `root` overrides the repository root
 *   so the self-test can drive the real code path over a sandbox tree rather
 *   than over the live fleet.
 * @returns {{counts: object, failures: string[], skipped: Map<string, string[]>}} Report.
 */
export function run(options) {
  const root = options.root ?? ROOT;
  const rowsPath = path.resolve(options.rows);
  const rows = JSON.parse(readFileSync(rowsPath, "utf8"));
  if (!Array.isArray(rows)) {
    throw new Error(`${rowsPath} is not a JSON array of rows`);
  }
  const filter = options.only ? globToRegExp(options.only) : null;
  const counts = {
    rows: rows.length,
    filteredOut: 0,
    absent: 0,
    skipped: 0,
    eligible: 0,
    inserted: 0,
    updated: 0,
    unchanged: 0,
    failed: 0,
  };
  const failures = [];
  const skipped = new Map();
  const noteSkip = (reason, file) => {
    if (!skipped.has(reason)) {
      skipped.set(reason, []);
    }
    skipped.get(reason).push(file);
  };

  for (const row of rows) {
    const plan = planRow(row);
    if (filter !== null && !filter.test(plan.file)) {
      counts.filteredOut += 1;
      continue;
    }
    if (plan.skip !== null) {
      counts.skipped += 1;
      noteSkip(plan.skip, plan.file);
      continue;
    }
    const absolute = path.join(root, plan.file);
    if (!existsSync(absolute)) {
      counts.absent += 1;
      counts.skipped += 1;
      noteSkip("absent from the working tree", plan.file);
      continue;
    }
    counts.eligible += 1;
    let source;
    try {
      source = readFileSync(absolute, "utf8");
    } catch (error) {
      counts.failed += 1;
      failures.push(`${plan.file}: unreadable — ${error.message}`);
      continue;
    }
    const result = injectPurposeHeader(source, {
      purpose: plan.purpose,
      status: plan.status,
      className: options.withClass ? plan.className : null,
    });
    if (result.action === "failed") {
      counts.failed += 1;
      failures.push(`${plan.file}: ${result.error}`);
      continue;
    }
    counts[result.action] += 1;
    if (!options.dryRun && result.text !== source) {
      writeFileSync(absolute, result.text);
    }
  }
  return { counts, failures, skipped };
}

/**
 * CLI entry.
 *
 * @returns {number} Process exit code.
 */
function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`inject-purpose-headers: ${error.message}`);
    return 2;
  }
  if (options.rows === null) {
    console.error(
      "inject-purpose-headers: --rows <audit-rows.json> is required.\n" +
        "The rows are the .mjs library audit's classification output; the\n" +
        "catalog's census records the same data in human-readable form.",
    );
    return 2;
  }
  let report;
  try {
    report = run(options);
  } catch (error) {
    console.error(`inject-purpose-headers: ${error.message}`);
    return 2;
  }
  const { counts, failures, skipped } = report;
  if (!options.quiet) {
    console.log(
      `inject-purpose-headers${options.dryRun ? " --dry-run" : ""}${options.only ? ` --only ${options.only}` : ""}`,
    );
    console.log(`  rows in audit        ${counts.rows}`);
    if (counts.filteredOut > 0) {
      console.log(`  filtered out by glob ${counts.filteredOut}`);
    }
    console.log(`  skipped              ${counts.skipped}`);
    for (const [reason, files] of [...skipped].sort()) {
      console.log(`    ${reason}: ${files.length}`);
      for (const file of files) {
        console.log(`      ${file}`);
      }
    }
    const verb = options.dryRun ? "would " : "";
    console.log(`  ELIGIBLE             ${counts.eligible}`);
    console.log(
      `    ${verb}insert${options.dryRun ? "" : "ed"}`.padEnd(23) +
        counts.inserted,
    );
    console.log(
      `    ${verb}update${options.dryRun ? "" : "d"}`.padEnd(23) +
        counts.updated,
    );
    console.log(`    already current    ${counts.unchanged}`);
    console.log(`  PARSE FAILURES       ${counts.failed}`);
    for (const failure of failures) {
      console.log(`    ${failure}`);
    }
  }
  return counts.failed > 0 ? 1 : 0;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  process.exitCode = main();
}
