#!/usr/bin/env node
// comment-only-diff.mjs — the binding gate of every Campaign 16 rewrite batch.
// @purpose Binding gate of every C16 rewrite batch: strips comments from both sides of a diff to a canonical form and requires the remaining code identical.
// @status ACTIVE
//
// THE CLAIM IT CHECKS. C16-03..C16-12 rewrite comments and nothing else. That
// claim is unfalsifiable by reading a diff: a 900-line comment rewrite hides a
// one-character constant change perfectly, and the reviewer who would have
// caught it is the same person who just read 900 lines of prose. This tool
// removes the comments from both sides and requires what is left to be
// identical. A batch that cannot pass it has not done what it says it did.
//
// WHAT "IDENTICAL" MEANS HERE — and why it is not literal byte equality of the
// stripped text. Deleting a six-line comment and writing a two-line one leaves
// four blank lines behind; a literal comparison would fail on every honest
// rewrite and the gate would be turned off within a day. The comparison is
// therefore over a CANONICAL form built by `lib/comment-scanner.mjs`:
//
//   - comments removed, each replaced by one space so adjacent tokens cannot
//     merge;
//   - string, template and regex literals copied VERBATIM, so a byte changed
//     inside an embedded shader or a user-facing message is always caught;
//   - build pragmas (`//>>includeStart`, `//>>ifdef`), linter/type directives
//     and `/*!` license banners RETAINED, because deleting one of those is a
//     behavioural or legal change that merely looks like a comment edit.
//     Retention is decided by comment SHAPE as well as leading token — see
//     `lib/comment-scanner.mjs` — because a retained comment is also a frozen
//     one, and freezing every prose line that happens to begin with the word
//     "global" makes the gate an obstacle to the rewrites it exists to check;
//   - every other whitespace run collapsed to a single newline if it contained
//     a line break, otherwise to a single space.
//
// The last rule is the one that carries the risk, so it is deliberately not
// "collapse all whitespace to one space": `return\nx` and `return x` differ
// under automatic semicolon insertion, and a canonical form that could not
// tell them apart would let a real behaviour change through. Collapsing to a
// newline preserves that distinction while absorbing blank-line churn. It also
// makes CRLF and LF compare equal, which is required here — the working tree
// is CRLF and git blobs are LF.
//
// USAGE
//   node Tools/c16/comment-only-diff.mjs --base <ref>
//       Compare <ref> against the working tree over every file the diff names.
//   node Tools/c16/comment-only-diff.mjs --base <ref> --head <ref>
//       Compare two refs.
//   node Tools/c16/comment-only-diff.mjs --base <ref> [--head <ref>] <paths...>
//       Restrict the comparison to the given paths.
//   --json     Machine-readable report.
//
// EXIT CODES
//   0  every checked file is comment-only
//   1  at least one file's code changed, was added, removed or renamed
//   2  the tool itself failed (bad ref, git unavailable, unreadable file)
//   3  STRUCTURAL: nothing was compared, or the semantic-comment rules stopped
//      matching their own directives. An empty file set is not a pass — it is
//      the gate reporting that it could not see its subject, which is exactly
//      how a rewrite batch would accidentally certify itself — and a rule
//      table that no longer recognises `//>>includeStart` would report a
//      green comparison over a deleted build pragma.

import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  canonicalizeCode,
  languageForPath,
  selfTestSemanticRules,
} from "./lib/comment-scanner.mjs";
import { SCOPE_ROOTS } from "./comment-marker-guard.mjs";

const ROOT = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));

/**
 * Compare one file's two versions.
 *
 * @param {string} before Source text at the base revision.
 * @param {string} after Source text at the head revision.
 * @param {string} relPath Repo-relative path, used to select the grammar.
 * @returns {{status: string, detail?: string}} `comment-only`, `code-differs`,
 *   or `unsupported` when no grammar covers the extension.
 */
export function compareSources(before, after, relPath) {
  const language = languageForPath(relPath);
  if (language === null) {
    return { status: "unsupported" };
  }
  const canonicalBefore = canonicalizeCode(before, language);
  const canonicalAfter = canonicalizeCode(after, language);
  if (canonicalBefore === canonicalAfter) {
    return { status: "comment-only" };
  }
  return {
    status: "code-differs",
    detail: describeFirstDifference(canonicalBefore, canonicalAfter),
  };
}

/**
 * A short, human-usable description of where two canonical forms diverge.
 *
 * @param {string} before Canonical form of the base revision.
 * @param {string} after Canonical form of the head revision.
 * @returns {string} One-line description with surrounding context.
 */
export function describeFirstDifference(before, after) {
  const limit = Math.min(before.length, after.length);
  let i = 0;
  while (i < limit && before[i] === after[i]) {
    i += 1;
  }
  const line = before.slice(0, i).split("\n").length;
  const window = 60;
  const start = Math.max(0, i - window);
  const show = (text) =>
    JSON.stringify(text.slice(start, i + window)).replace(/^"|"$/g, "");
  return `canonical line ${line}: -${show(before)} / +${show(after)}`;
}

/**
 * Compare a set of files using caller-supplied readers.
 *
 * The readers are injected so the comparison engine can be exercised without
 * a git repository — the spec drives it from in-memory fixtures, which is also
 * what lets the mutants run under plain `node --test`.
 *
 * @param {object} options Comparison inputs.
 * @param {Array<{path: string, change: string}>} options.files Changed paths
 *   with a single-letter git change type (`A`, `D`, `M`, `R`, ...).
 * @param {(relPath: string) => Promise<string>} options.readBefore Base reader.
 * @param {(relPath: string) => Promise<string>} options.readAfter Head reader.
 * @returns {Promise<{checked: object[], violations: object[], skipped: object[]}>} Report.
 */
export async function runComparison({ files, readBefore, readAfter }) {
  const checked = [];
  const violations = [];
  const skipped = [];

  for (const entry of files) {
    const relPath = entry.path;
    const inScope = SCOPE_ROOTS.some((root) => relPath.startsWith(`${root}/`));

    if (!inScope) {
      // Outside the comment standard's scope (migration_doc, Tools, Specs,
      // configuration). Reported so the batch's full footprint is visible, but
      // not a violation — those paths are where history is allowed to live.
      skipped.push({ path: relPath, reason: "outside the standard's scope" });
      continue;
    }

    if (entry.change !== "M") {
      // A comment rewrite adds no file, deletes no file and renames nothing.
      violations.push({
        path: relPath,
        status: "file-set-changed",
        detail: `git change type ${entry.change}`,
      });
      continue;
    }

    if (languageForPath(relPath) === null) {
      // In scope but not a language this tool can strip: a shipped asset, a
      // JSON table. Fail closed — "I could not check it" must not read as
      // "it passed".
      violations.push({
        path: relPath,
        status: "unsupported-in-scope",
        detail: "no comment grammar for this extension",
      });
      continue;
    }

    const before = await readBefore(relPath);
    const after = await readAfter(relPath);
    const result = compareSources(before, after, relPath);
    if (result.status === "comment-only") {
      checked.push({ path: relPath, status: result.status });
    } else {
      violations.push({ path: relPath, ...result });
    }
  }

  return { checked, violations, skipped };
}

/**
 * Run a git command from the repository root and return stdout.
 *
 * @param {string[]} args Arguments after `git`.
 * @returns {string} Standard output, UTF-8 decoded.
 */
function git(args) {
  return execFileSync("git", args, {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 1e9,
  });
}

/**
 * Parse argv into options and explicit paths.
 *
 * @param {string[]} argv Arguments after the script name.
 * @returns {{base: string|null, head: string|null, json: boolean, paths: string[]}} Options.
 */
export function parseArgs(argv) {
  const options = { base: null, head: null, json: false, paths: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--base") {
      options.base = argv[++i];
    } else if (arg === "--head") {
      options.head = argv[++i];
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg === "--") {
      options.paths.push(...argv.slice(i + 1));
      break;
    } else if (arg.startsWith("--")) {
      throw new Error(`unknown option ${arg}`);
    } else {
      options.paths.push(arg);
    }
  }
  if (options.base === null || options.base === undefined) {
    throw new Error("--base <ref> is required");
  }
  return options;
}

/**
 * Changed paths between two revisions, with git's change type.
 *
 * @param {string} base Base ref.
 * @param {string|null} head Head ref, or null for the working tree.
 * @param {string[]} paths Optional path filter.
 * @returns {Array<{path: string, change: string}>} Changed entries.
 */
function changedFiles(base, head, paths) {
  const args = ["diff", "--name-status", "--no-renames", base];
  if (head !== null) {
    args.push(head);
  }
  if (paths.length > 0) {
    args.push("--", ...paths);
  }
  return git(args)
    .split(/\r?\n/)
    .filter((line) => line.trim() !== "")
    .map((line) => {
      const [change, ...rest] = line.split("\t");
      return { change: change[0], path: rest.join("\t") };
    });
}

/**
 * Entry point.
 *
 * @returns {Promise<number>} Process exit code.
 */
async function main() {
  const options = parseArgs(process.argv.slice(2));

  // Negative control first. The canonical form's whole protective claim is
  // that a deleted pragma, directive or license banner survives the strip and
  // shows up as a code change. A rule table that had drifted out of agreement
  // with its own examples would keep reporting comment-only over exactly the
  // deletions this gate exists to catch, so refuse to compare anything until
  // the table has proved it still recognises them.
  const brokenRules = selfTestSemanticRules();
  if (brokenRules.length > 0) {
    console.error(
      `comment-only-diff: STRUCTURAL — semantic-comment rules no longer match their own examples:\n  ${brokenRules.join("\n  ")}`,
    );
    return 3;
  }

  git(["rev-parse", "--verify", `${options.base}^{commit}`]);
  if (options.head !== null) {
    git(["rev-parse", "--verify", `${options.head}^{commit}`]);
  }

  const files = changedFiles(options.base, options.head, options.paths);

  const readBefore = async (relPath) =>
    git(["show", `${options.base}:${relPath}`]);
  const readAfter =
    options.head === null
      ? async (relPath) => fs.readFile(path.join(ROOT, relPath), "utf8")
      : async (relPath) => git(["show", `${options.head}:${relPath}`]);

  const report = await runComparison({ files, readBefore, readAfter });

  if (options.json) {
    process.stdout.write(
      `${JSON.stringify({ base: options.base, head: options.head ?? "<worktree>", ...report }, null, 2)}\n`,
    );
  } else {
    console.log(
      `comment-only-diff: ${options.base} -> ${options.head ?? "working tree"}`,
    );
    console.log(
      `  checked      ${report.checked.length} in-scope file(s): comment-only`,
    );
    console.log(`  violations   ${report.violations.length}`);
    console.log(
      `  not checked  ${report.skipped.length} path(s) outside the standard's scope`,
    );
    for (const violation of report.violations) {
      console.log(
        `  VIOLATION  ${violation.path}  [${violation.status}] ${violation.detail ?? ""}`,
      );
    }
    for (const entry of report.skipped) {
      console.log(`  not checked  ${entry.path}`);
    }
  }

  if (report.checked.length === 0 && report.violations.length === 0) {
    console.error(
      "comment-only-diff: STRUCTURAL — no in-scope file was compared. An empty comparison is not a pass; check the ref pair and the path filter.",
    );
    return 3;
  }
  return report.violations.length > 0 ? 1 : 0;
}

// Only run when invoked as a script, so the spec can import the comparison
// engine without shelling out to git.
const invokedDirectly =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      console.error(`comment-only-diff: ${error.stack ?? error}`);
      process.exitCode = 2;
    });
}
