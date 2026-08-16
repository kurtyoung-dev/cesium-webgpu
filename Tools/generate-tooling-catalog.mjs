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
// USAGE
//   node Tools/generate-tooling-catalog.mjs            # rewrite the section
//   node Tools/generate-tooling-catalog.mjs --check    # exit 1 on drift
//   node Tools/generate-tooling-catalog.mjs --stdout   # print, write nothing
//
// EXIT CODES
//   0  written, or --check found no drift
//   1  --check found drift
//   2  the generator itself failed
//   3  STRUCTURAL: the markers are missing, or no tooling files were found

import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { parsePurposeHeader } from "./lib/purpose-header.mjs";

const ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const CATALOG = path.join(ROOT, "migration_doc", "TOOLING_CATALOG.md");

export const BEGIN_MARKER =
  "<!-- BEGIN GENERATED CENSUS — regenerate with `node Tools/generate-tooling-catalog.mjs`; edits inside this region are overwritten -->";
export const END_MARKER = "<!-- END GENERATED CENSUS -->";

/** Directories whose `.mjs` files make up the tooling library. */
const CENSUS_ROOTS = Object.freeze(["Tools", "scripts"]);

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
  ".json",
  ".md",
  ".yml",
  ".yaml",
  ".txt",
  ".sh",
  "",
]);

/**
 * Recursively list files under a directory.
 *
 * @param {string} absolute Directory to walk.
 * @param {(rel: string) => boolean} accept Predicate over repo-relative paths.
 * @returns {string[]} Repo-relative, slash-separated paths.
 */
function walk(absolute, accept) {
  const out = [];
  const stack = [absolute];
  let guard = 0;
  while (stack.length > 0 && guard++ < 200000) {
    const dir = stack.pop();
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.name === "node_modules" || entry.name === ".git") {
        continue;
      }
      const child = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(child);
        continue;
      }
      const rel = path.relative(ROOT, child).split(path.sep).join("/");
      if (accept(rel)) {
        out.push(rel);
      }
    }
  }
  return out.sort();
}

/**
 * Every `.mjs` file in the census scope.
 *
 * @returns {string[]} Repo-relative paths, sorted.
 */
export function listToolingFiles() {
  const files = [];
  for (const root of CENSUS_ROOTS) {
    files.push(...walk(path.join(ROOT, root), (rel) => rel.endsWith(".mjs")));
  }
  return files.sort();
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
 * @returns {Map<string, string>} Repo-relative path -> ISO date.
 */
export function lastTouchDates() {
  const dates = new Map();
  let output;
  try {
    output = execFileSync(
      "git",
      [
        "log",
        "--name-only",
        "--pretty=format:%x01%ad",
        "--date=short",
        "--",
        ...CENSUS_ROOTS,
      ],
      { cwd: ROOT, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 },
    );
  } catch {
    return dates;
  }
  let current = null;
  for (const raw of output.split("\n")) {
    const line = raw.replace(/\r$/, "");
    if (line.startsWith("\u0001")) {
      current = line.slice(1).trim();
      continue;
    }
    if (line === "" || current === null) {
      continue;
    }
    // `git log` walks newest-first, so the first date a path is seen with wins.
    if (!dates.has(line)) {
      dates.set(line, current);
    }
  }
  return dates;
}

/**
 * Count inbound references to each tooling file.
 *
 * Every scanned file is tokenized ONCE for `*.mjs` path-like strings, rather
 * than searched once per candidate name; the naive form is ~990 substring
 * scans per file and does not finish in a usable time.
 *
 * @param {string[]} files Census files, repo-relative.
 * @returns {Map<string, number>} Path -> number of distinct referencing files.
 */
export function inboundRefs(files) {
  const byPath = new Set(files);
  const byBase = new Map();
  for (const file of files) {
    const base = path.posix.basename(file);
    if (!byBase.has(base)) {
      byBase.set(base, []);
    }
    byBase.get(base).push(file);
  }

  const sources = [];
  for (const root of REF_ROOTS) {
    sources.push(
      ...walk(path.join(ROOT, root), (rel) =>
        REF_EXTENSIONS.includes(path.posix.extname(rel)),
      ),
    );
  }
  sources.push(...REF_FILES);

  const counts = new Map(files.map((f) => [f, 0]));
  const token = /[A-Za-z0-9_./\\-]*[A-Za-z0-9_-]\.mjs/g;
  for (const source of sources) {
    if (REF_EXCLUDED.includes(source)) {
      continue;
    }
    let text;
    try {
      const absolute = path.join(ROOT, source);
      if (statSync(absolute).size > 8 * 1024 * 1024) {
        continue;
      }
      text = readFileSync(absolute, "utf8");
    } catch {
      continue;
    }
    const hits = new Set();
    for (const match of text.matchAll(token)) {
      const raw = match[0].split("\\").join("/");
      if (byPath.has(raw)) {
        hits.add(raw);
        continue;
      }
      const base = path.posix.basename(raw);
      for (const candidate of byBase.get(base) ?? []) {
        hits.add(candidate);
      }
    }
    for (const hit of hits) {
      if (hit !== source) {
        counts.set(hit, (counts.get(hit) ?? 0) + 1);
      }
    }
  }
  return counts;
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
 * @returns {{rows: object[], byDirectory: Map<string, object[]>}} Census data.
 */
export function collectCensus() {
  const files = listToolingFiles();
  const dates = lastTouchDates();
  const refs = inboundRefs(files);
  const rows = [];
  for (const file of files) {
    let parsed;
    try {
      parsed = parsePurposeHeader(readFileSync(path.join(ROOT, file), "utf8"));
    } catch {
      parsed = { purpose: null, status: null, className: null };
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
  const byDirectory = new Map();
  for (const row of rows) {
    if (!byDirectory.has(row.directory)) {
      byDirectory.set(row.directory, []);
    }
    byDirectory.get(row.directory).push(row);
  }
  return { rows, byDirectory };
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
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([name, count]) => `${name} ${count}`)
      .join(", ")} |`,
  );
  push("");

  for (const directory of [...census.byDirectory.keys()].sort()) {
    const rows = census.byDirectory
      .get(directory)
      .slice()
      .sort((a, b) => a.base.localeCompare(b.base));
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
  push(END_MARKER);
  return lines.join(eol);
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
  if (begin === -1 || end === -1 || end < begin) {
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
 * something other than the git-freshness column. Freshness can only settle
 * AFTER the commit that touches a file lands (it reads that commit's date),
 * so freshness-only drift is unavoidable in the landing commit itself and is
 * advisory; drift in path/class/status/refs/purpose is the real signal.
 *
 * @param {string} committed Region currently in the file.
 * @param {string} regenerated Region this run produced.
 * @returns {{ lines: string[], structural: boolean }} Report + verdict.
 */
export function describeDriftDetailed(committed, regenerated) {
  const rowKey = (line) => {
    const m = /^\|\s*([^|]+?)\s*\|/.exec(line);
    return m === null ? null : m[1];
  };
  const index = (text) => {
    const map = new Map();
    for (const raw of text.split(/\r?\n/)) {
      const key = rowKey(raw);
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
  return { lines: out, structural };
}

/**
 * CLI entry.
 *
 * @param {string[]} argv Arguments after the script name.
 * @returns {number} Process exit code.
 */
export function main(argv) {
  const check = argv.includes("--check");
  const toStdout = argv.includes("--stdout");
  const unknown = argv.filter((a) => !["--check", "--stdout"].includes(a));
  if (unknown.length > 0) {
    console.error(`generate-tooling-catalog: unknown argument ${unknown[0]}`);
    return 2;
  }

  let catalog;
  try {
    catalog = readFileSync(CATALOG, "utf8");
  } catch (error) {
    console.error(`generate-tooling-catalog: ${error.message}`);
    return 2;
  }
  const split = splitCatalog(catalog);
  if (split === null) {
    console.error(
      "generate-tooling-catalog: STRUCTURAL — the census markers are missing from\n" +
        `${path.relative(ROOT, CATALOG)}. Add them around the "## Full census" section:\n` +
        `${BEGIN_MARKER}\n…\n${END_MARKER}`,
    );
    return 3;
  }

  const census = collectCensus();
  if (census.rows.length === 0) {
    console.error(
      "generate-tooling-catalog: STRUCTURAL — no .mjs files found under " +
        `${CENSUS_ROOTS.join(", ")}; a census of nothing must not read as a pass.`,
    );
    return 3;
  }
  const regenerated = renderCensus(census, split.eol);

  if (toStdout) {
    process.stdout.write(`${regenerated}${split.eol}`);
    return 0;
  }
  if (check) {
    if (regenerated === split.region) {
      console.log(
        `generate-tooling-catalog --check: census is current (${census.rows.length} files).`,
      );
      return 0;
    }
    const drift = describeDriftDetailed(split.region, regenerated);
    if (!drift.structural) {
      console.log(
        "generate-tooling-catalog --check: census is current except for the git-freshness column " +
          `(${drift.lines[0]}); freshness only settles after the touching commit lands - advisory, not drift.`,
      );
      return 0;
    }
    console.error(
      "generate-tooling-catalog --check: the committed census has DRIFTED from the tree.",
    );
    for (const line of drift.lines) {
      console.error(`  ${line}`);
    }
    console.error(
      "  Regenerate with `node Tools/generate-tooling-catalog.mjs` and commit the result.",
    );
    return 1;
  }

  writeFileSync(CATALOG, `${split.before}${regenerated}${split.after}`);
  console.log(
    `generate-tooling-catalog: wrote ${census.rows.length} rows to ${path.relative(ROOT, CATALOG).split(path.sep).join("/")}.`,
  );
  return 0;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  process.exitCode = main(process.argv.slice(2));
}
