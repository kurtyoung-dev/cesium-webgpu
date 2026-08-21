#!/usr/bin/env node
// comment-marker-guard.mjs — enforcement for the fork comment standard.
// @purpose C16 lint guard scanning engine/widgets Source for banned tracker-marker vocabulary, with a clean-list ratchet; lint-staged + one-shot modes.
// @status ACTIVE
//
// Standard: Documentation/Contributors/CodingGuide/ForkCommentStandard.md
// Grammar:  Tools/c16/lib/marker-grammar.mjs
// Ratchet:  Tools/c16/comment-marker-cleanlist.txt
// Grandfather: Tools/c16/comment-marker-grandfather.txt
//
// SCOPE. `packages/engine/Source` and `packages/widgets/Source` only, minus
// vendored `ThirdParty/` trees. `migration_doc/`, `Tools/`, `Specs/`, the
// launch scripts and commit messages are where development history is SUPPOSED
// to live; the guard never reads them, and adding them to its scope would be a
// standards change, not a configuration change.
//
// WHY A NODE SCRIPT AND NOT AN AST-GREP RULE. Upstream's `Tools/ast-grep/rules`
// setup does support comment matching (`kind: comment` plus `regex`), and an
// earlier draft of this guard was written that way. Three things ruled it out:
//
//   1. ast-grep has no WGSL or GLSL grammar. Those two languages hold 43% of
//      the flagged files (120 `.wgsl` + 20 `.glsl` of 451 at authoring time),
//      so an ast-grep-only guard would certify half the campaign blind.
//   2. `sg scan` is all-or-nothing per rule severity. At `error` it fails CI
//      against every one of the thousands of pre-existing markers from the day
//      it lands; at `warning` it floods `sg scan --context 3` with tens of
//      thousands of context lines. Neither is a usable pre-remediation state.
//   3. The ratchet needs per-path enforcement that changes as shards land.
//      ast-grep's `files:` globs are static config, so expressing the clean
//      list there means editing the rule on every batch and losing the
//      "assert the clean list is still clean" check entirely.
//
// The check itself is a text predicate over comment spans, so nothing is lost
// by running it here. When the last shard lands and the census reaches zero,
// promoting an engine-and-widgets ast-grep rule to `error` becomes free, and
// that is the intended C16-20 follow-up.
//
// THE RATCHET. Until the rewrite shards land, most of the tree legitimately
// still carries markers, so a finding is a WARNING by default and the process
// exits 0. A path listed in the clean list has been remediated and certified:
// findings there are ERRORS and exit 1, in the one-shot run and in the
// pre-commit hook alike. The grandfather file records exact file/rule pairs
// exposed by a later grammar widening; only those pairs remain warnings, and a
// row becomes an error as soon as its pair self-cleans. Rewrite batches append
// their shard's paths to the clean list, which is what makes the debt
// monotonically non-increasing.
//
// USAGE
//   node Tools/c16/comment-marker-guard.mjs
//       One-shot scan of the whole scope. Prints the census. Exits 1 only if a
//       clean-listed path regressed.
//   node Tools/c16/comment-marker-guard.mjs --strict
//       Every finding is an error. This is what C16-20 must exit 0 on.
//   node Tools/c16/comment-marker-guard.mjs <paths...>
//       Check specific files (the lint-staged mode). Paths outside the scope
//       are skipped, not failed.
//   node Tools/c16/comment-marker-guard.mjs --verify-cleanlist
//       Assert every clean-list entry resolves to at least one in-scope file
//       AND that all of them have no findings except current grandfathered
//       pairs. Stale grandfather rows are errors.
//   --json           Machine-readable report on stdout.
//   --census         Report only; never exits non-zero for findings.
//   --max-files N    Cap the number of offending files listed (default 40).
//
// EXIT CODES
//   0  clean, or findings that are only warnings under the ratchet
//   1  at least one error-severity finding
//   2  the guard itself failed (unreadable file, bad argument)
//   3  STRUCTURAL: the guard could not see its subject — no files matched the
//      scope, or a grammar rule stopped matching its own example. A run that
//      scans nothing must not read as a pass.

import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { extractComments, languageForPath } from "./lib/comment-scanner.mjs";
import {
  MARKER_RULES,
  findMarkers,
  selfTestRules,
} from "./lib/marker-grammar.mjs";

const ROOT = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));

/** Directories the standard applies to, repo-relative and slash-separated. */
export const SCOPE_ROOTS = Object.freeze([
  "packages/engine/Source",
  "packages/widgets/Source",
]);

/**
 * Paths inside the scope that the guard still skips. `ThirdParty` is vendored
 * upstream source we do not own; rewriting its comments would create merge
 * conflicts against the vendor for no benefit.
 */
const SCOPE_EXCLUSIONS = Object.freeze(["/ThirdParty/"]);

const CLEAN_LIST_PATH = path.join(
  ROOT,
  "Tools",
  "c16",
  "comment-marker-cleanlist.txt",
);

const GRANDFATHER_PATH = path.join(
  ROOT,
  "Tools",
  "c16",
  "comment-marker-grandfather.txt",
);
const GRANDFATHER_REASON = "2026-08-21 grammar widening";

/**
 * Normalize any path to a repo-relative, slash-separated form.
 *
 * lint-staged hands absolute Windows paths; a human hands relative ones. Both
 * have to land on the same string before the scope test runs.
 *
 * @param {string} filePath Absolute or relative path.
 * @returns {string} Repo-relative path with forward slashes.
 */
export function toRepoRelative(filePath) {
  const absolute = path.isAbsolute(filePath)
    ? filePath
    : path.resolve(ROOT, filePath);
  return path.relative(ROOT, absolute).split(path.sep).join("/");
}

/**
 * Whether the standard applies to a path.
 *
 * @param {string} relPath Repo-relative, slash-separated path.
 * @returns {boolean} True when the file is in scope.
 */
export function isInScope(relPath) {
  if (!SCOPE_ROOTS.some((root) => relPath.startsWith(`${root}/`))) {
    return false;
  }
  if (SCOPE_EXCLUSIONS.some((fragment) => relPath.includes(fragment))) {
    return false;
  }
  return languageForPath(relPath) !== null;
}

/**
 * Read the clean-list ratchet.
 *
 * Each non-comment line is either an exact repo-relative file path or a
 * directory prefix (recursive). Order is irrelevant; duplicates are harmless.
 *
 * @returns {Promise<string[]>} Clean-list entries, slash-separated.
 */
export async function readCleanList() {
  let text;
  try {
    text = await fs.readFile(CLEAN_LIST_PATH, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"))
    .map((line) => line.replace(/\/+$/, ""));
}

/**
 * Parse exact file/rule exceptions exposed by a later grammar widening.
 *
 * @param {string} text Grandfather file contents.
 * @returns {Array<{file: string, ruleId: string}>} Exact file/rule pairs.
 */
export function parseGrandfatherList(text) {
  const rows = [];
  const seen = new Set();
  for (const [index, rawLine] of text.split(/\r?\n/).entries()) {
    const trimmed = rawLine.trim();
    if (trimmed === "" || trimmed.startsWith("#")) {
      continue;
    }

    const match = rawLine.match(/^([^\t]+)\t([a-z0-9-]+) {2}# (.+?)\s*$/);
    if (match === null || match[3] !== GRANDFATHER_REASON) {
      throw new Error(
        `invalid grandfather row ${index + 1}; expected path<TAB>ruleId  # ${GRANDFATHER_REASON}`,
      );
    }

    const file = match[1].trim().replaceAll("\\", "/");
    const ruleId = match[2];
    if (!isInScope(file) || !MARKER_RULES.some((rule) => rule.id === ruleId)) {
      throw new Error(
        `invalid grandfather row ${index + 1}; ${file} [${ruleId}] is not an in-scope file/rule pair`,
      );
    }

    const key = grandfatherKey(file, ruleId);
    if (seen.has(key)) {
      throw new Error(
        `duplicate grandfather row ${index + 1}; ${file} [${ruleId}]`,
      );
    }
    seen.add(key);
    rows.push({ file, ruleId });
  }
  return rows;
}

/**
 * Read the exact file/rule grandfather ratchet.
 *
 * @returns {Promise<Array<{file: string, ruleId: string}>>} Exact pairs.
 */
export async function readGrandfatherList() {
  return parseGrandfatherList(await fs.readFile(GRANDFATHER_PATH, "utf8"));
}

/**
 * Stable key for one exact file/rule pair.
 *
 * @param {string} file Repo-relative file.
 * @param {string} ruleId Marker rule id.
 * @returns {string} Pair key.
 */
function grandfatherKey(file, ruleId) {
  return `${file}\u0000${ruleId}`;
}

/**
 * Whether a finding is one of the exact grandfathered pairs.
 *
 * @param {{file: string, ruleId: string}} finding Marker finding.
 * @param {Array<{file: string, ruleId: string}>} grandfatherRows Exact pairs.
 * @returns {boolean} True only for an exact file/rule match.
 */
export function isGrandfathered(finding, grandfatherRows) {
  const key = grandfatherKey(finding.file, finding.ruleId);
  return grandfatherRows.some(
    (row) => grandfatherKey(row.file, row.ruleId) === key,
  );
}

/**
 * Whether a path is certified clean, and therefore enforced strictly.
 *
 * @param {string} relPath Repo-relative path.
 * @param {string[]} cleanList Entries from `readCleanList`.
 * @returns {boolean} True when strict enforcement applies.
 */
export function isCleanListed(relPath, cleanList) {
  return cleanList.some(
    (entry) => relPath === entry || relPath.startsWith(`${entry}/`),
  );
}

/**
 * Apply strict, clean-list, and exact grandfather severity in that order.
 *
 * @param {Array<{file: string, ruleId: string}>} findings Marker findings.
 * @param {{strict: boolean, cleanList: string[], grandfatherRows: Array<{file: string, ruleId: string}>}} options Severity inputs.
 * @returns {{errors: Array<{file: string, ruleId: string}>, warnings: Array<{file: string, ruleId: string}>}} Partitioned findings.
 */
export function classifyFindings(findings, options) {
  const errors = [];
  const warnings = [];
  for (const finding of findings) {
    const cleanListed = isCleanListed(finding.file, options.cleanList);
    if (
      !options.strict &&
      cleanListed &&
      isGrandfathered(finding, options.grandfatherRows)
    ) {
      warnings.push(finding);
    } else if (options.strict || cleanListed) {
      errors.push(finding);
    } else {
      warnings.push(finding);
    }
  }
  return { errors, warnings };
}

/**
 * Rows whose exact file/rule pair has no current finding.
 *
 * A full-scope scan validates every row, including rows for deleted files. A
 * path-mode scan validates only rows for files in that invocation; otherwise
 * lint-staged would call every unrelated row stale on each one-file check.
 *
 * @param {Array<{file: string, ruleId: string}>} grandfatherRows Exact pairs.
 * @param {string[]} files Files scanned by this invocation.
 * @param {Array<{file: string, ruleId: string}>} findings Current findings.
 * @param {string[]} cleanList Clean-list entries.
 * @param {boolean} completeScan Whether every in-scope file was scanned.
 * @returns {Array<{file: string, ruleId: string}>} Stale rows.
 */
export function findStaleGrandfatherRows(
  grandfatherRows,
  files,
  findings,
  cleanList,
  completeScan,
) {
  const scanned = new Set(files);
  const livePairs = new Set(
    findings.map((finding) => grandfatherKey(finding.file, finding.ruleId)),
  );
  return grandfatherRows.filter((row) => {
    if (!completeScan && !scanned.has(row.file)) {
      return false;
    }
    return (
      !scanned.has(row.file) ||
      !isCleanListed(row.file, cleanList) ||
      !livePairs.has(grandfatherKey(row.file, row.ruleId))
    );
  });
}

/**
 * Every marker finding in one file's comments.
 *
 * @param {string} relPath Repo-relative path, used to pick the grammar.
 * @param {string} source File text.
 * @returns {Array<{file: string, line: number, ruleId: string, match: string, text: string}>} Findings.
 */
export function scanSource(relPath, source) {
  const language = languageForPath(relPath);
  if (language === null) {
    return [];
  }
  const findings = [];
  for (const comment of extractComments(source, language)) {
    for (const marker of findMarkers(comment.text)) {
      // Report the line the MARKER sits on, not the line the comment block
      // opened on: a 40-line docblock with one marker at the bottom is
      // unreviewable if every finding points at line 1.
      const before = comment.text.slice(0, marker.offset);
      const line = comment.line + (before.match(/\n/g)?.length ?? 0);
      findings.push({
        file: relPath,
        line,
        ruleId: marker.ruleId,
        match: marker.match,
        text: excerpt(comment.text, marker.offset),
      });
    }
  }
  return findings;
}

/**
 * A single-line excerpt of the comment around `offset`, for the report.
 *
 * @param {string} text Comment text.
 * @param {number} offset Offset of the marker within `text`.
 * @returns {string} Trimmed excerpt, at most 100 characters.
 */
function excerpt(text, offset) {
  const lineStart = text.lastIndexOf("\n", offset) + 1;
  let lineEnd = text.indexOf("\n", offset);
  if (lineEnd < 0) {
    lineEnd = text.length;
  }
  const line = text.slice(lineStart, lineEnd).trim();
  return line.length > 100 ? `${line.slice(0, 97)}...` : line;
}

/**
 * Recursively collect in-scope files under a directory.
 *
 * @param {string} absoluteDir Directory to walk.
 * @returns {Promise<string[]>} Repo-relative paths.
 */
async function collect(absoluteDir) {
  const out = [];
  let entries;
  try {
    entries = await fs.readdir(absoluteDir, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") {
      return out;
    }
    throw error;
  }
  for (const entry of entries) {
    const full = path.join(absoluteDir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "Build") {
        continue;
      }
      out.push(...(await collect(full)));
      continue;
    }
    const rel = toRepoRelative(full);
    if (isInScope(rel)) {
      out.push(rel);
    }
  }
  return out;
}

/**
 * Every in-scope file in the repository.
 *
 * @returns {Promise<string[]>} Repo-relative paths, sorted.
 */
export async function collectScopeFiles() {
  const all = [];
  for (const root of SCOPE_ROOTS) {
    all.push(...(await collect(path.join(ROOT, root))));
  }
  return all.sort();
}

/**
 * Group findings into a census keyed by rule id and by extension.
 *
 * @param {string[]} files Files that were scanned.
 * @param {Array<{file: string, ruleId: string}>} findings All findings.
 * @returns {{scannedFiles: number, flaggedFiles: number, findings: number, byRule: Record<string, {occurrences: number, files: number}>, byExtension: Record<string, {scanned: number, flagged: number}>}} Census.
 */
export function buildCensus(files, findings) {
  const byRule = {};
  const filesPerRule = {};
  for (const finding of findings) {
    byRule[finding.ruleId] ??= { occurrences: 0, files: 0 };
    byRule[finding.ruleId].occurrences += 1;
    filesPerRule[finding.ruleId] ??= new Set();
    filesPerRule[finding.ruleId].add(finding.file);
  }
  for (const [ruleId, set] of Object.entries(filesPerRule)) {
    byRule[ruleId].files = set.size;
  }

  const flagged = new Set(findings.map((f) => f.file));
  const byExtension = {};
  for (const file of files) {
    const ext = path.extname(file).toLowerCase();
    byExtension[ext] ??= { scanned: 0, flagged: 0 };
    byExtension[ext].scanned += 1;
    if (flagged.has(file)) {
      byExtension[ext].flagged += 1;
    }
  }

  return {
    scannedFiles: files.length,
    flaggedFiles: flagged.size,
    findings: findings.length,
    byRule,
    byExtension,
  };
}

/**
 * Parse argv into options and explicit paths.
 *
 * @param {string[]} argv Arguments after the script name.
 * @returns {{strict: boolean, census: boolean, json: boolean, verifyCleanList: boolean, maxFiles: number, paths: string[]}} Options.
 */
export function parseArgs(argv) {
  const options = {
    strict: false,
    census: false,
    json: false,
    verifyCleanList: false,
    maxFiles: 40,
    paths: [],
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--strict") {
      options.strict = true;
    } else if (arg === "--census") {
      options.census = true;
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg === "--verify-cleanlist") {
      options.verifyCleanList = true;
    } else if (arg === "--max-files") {
      options.maxFiles = Number.parseInt(argv[++i], 10);
      if (!Number.isFinite(options.maxFiles) || options.maxFiles < 0) {
        throw new Error("--max-files needs a non-negative integer");
      }
    } else if (arg.startsWith("--")) {
      throw new Error(`unknown option ${arg}`);
    } else {
      options.paths.push(arg);
    }
  }
  return options;
}

/**
 * Format the census as human-readable text.
 *
 * @param {ReturnType<typeof buildCensus>} census Census to render.
 * @returns {string} Report body.
 */
function renderCensus(census) {
  const lines = [];
  const extensions = Object.entries(census.byExtension)
    .sort((a, b) => b[1].scanned - a[1].scanned)
    .map(([ext, counts]) => `${ext} ${counts.flagged}/${counts.scanned}`)
    .join(", ");
  lines.push(
    `  scanned  ${String(census.scannedFiles).padStart(6)} files (${extensions})`,
  );
  lines.push(`  flagged  ${String(census.flaggedFiles).padStart(6)} files`);
  lines.push(
    `  markers  ${String(census.findings).padStart(6)} occurrences in comments`,
  );
  lines.push("");
  lines.push("  by rule:");
  const rows = MARKER_RULES.map((rule) => [
    rule.id,
    census.byRule[rule.id]?.occurrences ?? 0,
    census.byRule[rule.id]?.files ?? 0,
  ]).sort((a, b) => b[1] - a[1]);
  const width = Math.max(...rows.map(([id]) => id.length));
  for (const [id, occurrences, fileCount] of rows) {
    lines.push(
      `    ${id.padEnd(width)}  ${String(occurrences).padStart(6)} occurrences  ${String(fileCount).padStart(4)} files`,
    );
  }
  return lines.join("\n");
}

/**
 * Entry point.
 *
 * @returns {Promise<number>} Process exit code.
 */
async function main() {
  const options = parseArgs(process.argv.slice(2));

  // Negative control first: a grammar that has stopped matching its own
  // examples would report a clean tree, and a clean tree is the answer this
  // campaign is trying to earn. Refuse to produce it by accident.
  const broken = selfTestRules();
  if (broken.length > 0) {
    console.error(
      `comment-marker-guard: STRUCTURAL — marker rules no longer match their own examples: ${broken.join(", ")}`,
    );
    return 3;
  }

  const cleanList = await readCleanList();
  const grandfatherRows = await readGrandfatherList();

  let files;
  let mode;
  if (options.paths.length > 0) {
    mode = "paths";
    files = options.paths.map(toRepoRelative).filter(isInScope);
    if (files.length === 0) {
      // Not structural: lint-staged legitimately hands batches with no
      // in-scope file in them.
      if (!options.json) {
        console.log(
          "comment-marker-guard: no in-scope files in the given paths — nothing to check.",
        );
      }
      return 0;
    }
  } else {
    mode = "scope";
    files = await collectScopeFiles();
    if (files.length === 0) {
      console.error(
        `comment-marker-guard: STRUCTURAL — no files found under ${SCOPE_ROOTS.join(", ")}. The guard cannot see its subject.`,
      );
      return 3;
    }
  }

  const findings = [];
  for (const file of files) {
    const source = await fs.readFile(path.join(ROOT, file), "utf8");
    findings.push(...scanSource(file, source));
  }

  const census = buildCensus(files, findings);
  const staleGrandfatherRows = findStaleGrandfatherRows(
    grandfatherRows,
    files,
    findings,
    cleanList,
    mode === "scope",
  );

  if (options.verifyCleanList) {
    return verifyCleanList(
      cleanList,
      grandfatherRows,
      staleGrandfatherRows,
      files,
      findings,
      options,
    );
  }

  const { errors, warnings } = classifyFindings(findings, {
    strict: options.strict,
    cleanList,
    grandfatherRows,
  });

  if (options.json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          mode,
          strict: options.strict,
          cleanListEntries: cleanList.length,
          grandfatherEntries: grandfatherRows.length,
          census,
          errors,
          warnings,
          staleGrandfathers: staleGrandfatherRows,
        },
        null,
        2,
      )}\n`,
    );
  } else {
    console.log(
      `comment-marker-guard: ${mode === "scope" ? "one-shot scan" : "path check"}${options.strict ? " (strict)" : ""}`,
    );
    console.log(renderCensus(census));
    console.log("");
    console.log(
      `  clean list  ${cleanList.length} entr${cleanList.length === 1 ? "y" : "ies"} — findings are ERRORS unless exactly grandfathered`,
    );
    console.log(
      `  grandfather ${grandfatherRows.length} exact file/rule pairs — matching clean-list findings are WARNINGS`,
    );
    console.log(
      `  errors      ${errors.length + staleGrandfatherRows.length}\n  warnings    ${warnings.length}`,
    );
    if (errors.length > 0) {
      console.log("");
      console.log("ERRORS (remediated paths must stay clean):");
      for (const finding of errors.slice(0, 500)) {
        console.log(
          `  ${finding.file}:${finding.line}  [${finding.ruleId}] ${finding.match}  ${finding.text}`,
        );
      }
    }
    if (staleGrandfatherRows.length > 0) {
      console.log("");
      console.log(
        "STALE GRANDFATHER ROWS (remove a row when its file/rule pair self-cleans):",
      );
      for (const row of staleGrandfatherRows) {
        console.log(`  ${row.file}  [${row.ruleId}]`);
      }
    }
    if (warnings.length > 0 && !options.strict) {
      const worst = [...new Set(warnings.map((w) => w.file))]
        .map((file) => [file, warnings.filter((w) => w.file === file).length])
        .sort((a, b) => b[1] - a[1])
        .slice(0, options.maxFiles);
      console.log("");
      console.log(
        `WARNINGS (pending paths plus grandfathered pairs; ${worst.length} worst of ${new Set(warnings.map((w) => w.file)).size} files):`,
      );
      for (const [file, count] of worst) {
        console.log(`  ${String(count).padStart(5)}  ${file}`);
      }
    }
  }

  if (options.census && staleGrandfatherRows.length === 0) {
    return 0;
  }
  return errors.length > 0 || staleGrandfatherRows.length > 0 ? 1 : 0;
}

/**
 * Assert both ratchets are honest: every clean-list entry names something
 * real, every non-grandfathered finding is still absent, and every exact
 * grandfather row still has a current finding.
 *
 * @param {string[]} cleanList Clean-list entries.
 * @param {Array<{file: string, ruleId: string}>} grandfatherRows Exact pairs.
 * @param {Array<{file: string, ruleId: string}>} staleGrandfatherRows Stale rows.
 * @param {string[]} files Files scanned.
 * @param {Array<{file: string, ruleId: string}>} findings Findings from the scan.
 * @param {{json: boolean}} options Parsed options.
 * @returns {number} Exit code.
 */
function verifyCleanList(
  cleanList,
  grandfatherRows,
  staleGrandfatherRows,
  files,
  findings,
  options,
) {
  const dead = cleanList.filter(
    (entry) =>
      !files.some((file) => file === entry || file.startsWith(`${entry}/`)),
  );
  const cleanListedFindings = findings.filter((finding) =>
    isCleanListed(finding.file, cleanList),
  );
  const grandfathered = cleanListedFindings.filter((finding) =>
    isGrandfathered(finding, grandfatherRows),
  );
  const regressed = cleanListedFindings.filter(
    (finding) => !isGrandfathered(finding, grandfatherRows),
  );
  const covered = files.filter((file) => isCleanListed(file, cleanList));

  if (options.json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          entries: cleanList.length,
          covered: covered.length,
          grandfatherEntries: grandfatherRows.length,
          grandfathered,
          staleGrandfathers: staleGrandfatherRows,
          dead,
          regressed,
        },
        null,
        2,
      )}\n`,
    );
  } else {
    console.log(
      `comment-marker-guard --verify-cleanlist: ${cleanList.length} entries covering ${covered.length} of ${files.length} in-scope files; ${grandfatherRows.length} grandfather rows`,
    );
    for (const entry of dead) {
      console.log(`  DEAD ENTRY  ${entry} — matches no in-scope file`);
    }
    for (const finding of regressed.slice(0, 200)) {
      console.log(`  REGRESSED   ${finding.file}`);
    }
    for (const row of staleGrandfatherRows) {
      console.log(`  STALE ROW   ${row.file}  [${row.ruleId}]`);
    }
    if (grandfathered.length > 0) {
      console.log(
        `  GRANDFATHERED ${grandfathered.length} current findings in exact file/rule pairs`,
      );
    }
  }

  if (cleanList.length === 0) {
    console.error(
      "comment-marker-guard: STRUCTURAL — the clean list is empty, so this check proves nothing.",
    );
    return 3;
  }
  if (covered.length === 0) {
    console.error(
      "comment-marker-guard: STRUCTURAL — the clean list covers no in-scope file, so this check proves nothing.",
    );
    return 3;
  }
  return dead.length > 0 ||
    regressed.length > 0 ||
    staleGrandfatherRows.length > 0
    ? 1
    : 0;
}

// Only run when invoked as a script. The spec imports the predicates above and
// must not trigger a repository scan just by importing them.
const invokedDirectly =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      console.error(`comment-marker-guard: ${error.stack ?? error}`);
      process.exitCode = 2;
    });
}
