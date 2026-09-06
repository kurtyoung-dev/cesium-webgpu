#!/usr/bin/env node
// verify-doc-citations.mjs — the citation-vs-tree guard for migration_doc.
// @purpose Asserts every relative markdown link and every #L line anchor in the tracked LIVE migration_doc set resolves as written, that the anchored range exists, and that a range still contains the symbol its sentence names.
// @status ACTIVE
//
// WHY THIS EXISTS. Principle 10 makes a cited `file:line` a PREMISE that the
// next reader must re-derive before relying on it. That only works while the
// citation still points at something. A rotted citation does not merely fail to
// help — it manufactures exactly the false premise the principle exists to
// prevent: the reader opens the named file, finds different code (or no file at
// all), and either wastes the round-trip or, worse, reconstructs the missing
// premise from the sentence around the link. Three of four worker briefs on
// 2026-08-20 asserted a symptom the code did not exhibit, and each spec written
// from those briefs certified the brief rather than the behaviour.
//
// Citations rot at five boundaries and nothing in this repository watches any of
// them: a doc is archived and its inbound links keep the old path; a source file
// is converted `.js` → `.ts` and every deep link into it dangles; a gallery or a
// probe fleet is reorganised; a file is deleted outright; and — the quietest of
// the five — the file survives, the line numbers move, and the anchor now frames
// unrelated code with no outward sign of it. `Tools/verify-tracked-references.mjs`
// is scoped to node launch targets and `.mjs` imports, and `.markdownlintignore`
// removes all of `migration_doc` from the one markdown check CI runs, so the set
// has had zero coverage.
//
// WHAT IS A CITATION HERE, AND WHY THE ANSWER IS NARROW. Only the TARGET of an
// inline markdown link `[text](target)`. Never the link TEXT, never a
// backticked path-shaped token in prose, and never a filename recovered by
// regex from a table cell. That narrowness is not timidity, it is the
// correctness condition. A 2026-09-04 audit finding claimed the debugging guide
// named nine probes that no longer resolve; every one was an artefact of
// harvesting path-shaped strings out of prose and then GUESSING a base
// directory for them. The guide writes its own directory prefix and its own
// archive status — `archive/probe-tonemap.mjs (BROKEN_STALE — archived
// 2026-08-16)`, `lib/weather-probe-pinning.mjs` — and a resolver that strips or
// invents a prefix reports all fourteen of those as broken when all fourteen
// are correct. A guard whose failures are not believed is a guard that gets
// switched off, so this one resolves the target string BYTE FOR BYTE as the
// author wrote it, with no normalisation beyond percent-decoding and POSIX
// `.`/`..` collapse.
//
// THE BASE, STATED RATHER THAN GUESSED. A relative link resolves against the
// directory of the document that contains it. That is markdown's rule and
// GitHub's rule, and it is the only base this guard FAILS against. A second
// base — the repository root — is tried solely to CLASSIFY: 232 links in the
// live set are written root-relative (`packages/engine/Source/...` from a doc
// inside `migration_doc/`) and resolve under no markdown renderer. They are
// reported as the ROOT_RELATIVE advisory, not as violations, because promoting
// 232 findings on day one would bury the 48 that are genuinely dead and the
// convention question behind them belongs to a maintainer, not to this file.
// The advisory count is printed on every run so the question cannot go quiet.
//
// THE SYMBOL RULE IS DELIBERATELY SMALL. Contract clause 3 — "where the
// sentence names a symbol, the anchored range still contains it" — is the only
// clause that can be wrong about correct prose, so it fires only on an
// unambiguous shape:
//
//   (a) the link target is a SOURCE file (.ts .js .mjs .cjs .wgsl .glsl), never
//       another markdown document, whose line numbering is prose and moves for
//       reasons that are not drift;
//   (b) the anchor names a line or a range;
//   (c) a code-shaped identifier appears in backticks either IMMEDIATELY before
//       the link (separated only by whitespace or opening punctuation) or inside
//       the link text itself;
//   (d) "code-shaped" means an identifier of three characters or more that is
//       either `_`-prefixed or mixed-case — `sampleAndBlend`, `_cascadeCastBindGroups`.
//       A single lowercase word, an English sentence fragment and a
//       SCREAMING_SNAKE document abbreviation are all rejected, because each is
//       ambiguous between a symbol and ordinary prose; and
//   (e) the identifier is not the target's own basename or stem, which names
//       the file rather than anything inside the range.
//
// Three citations in the live set meet all five conditions. One holds; two are
// dead — `GlobeFS.glsl#L188` for `sampleAndBlend` (defined at 429; the anchor
// frames the colour-correction block) and `GlobeTerrain.wgsl#L1486` for
// `applyImageryLayer` (now 2128), both in the imagery-projection chain whose
// own doc `IMAGERY_PROJECTION.md` is a declared single source of truth. Three
// assertions is meagre coverage of the 149 line anchors, and that is the
// correct trade: a false positive on this clause costs a reviewer an argument
// with the guard, a miss costs nothing the range check does not already cover.
//
// DELIBERATELY OUT OF SCOPE. Reference-style links (`[text][ref]`) — the live
// set contains no link-reference definitions. The single `<a href>` in
// `WATER_RENDERING_DESIGN.md` — one HTML anchor does not justify an HTML
// parser. In-document heading anchors (`#some-heading`, 523 of them) — the
// slug rules are renderer-specific and a mismatch is cosmetic. Absolute URLs.
// Links inside fenced code blocks, which are samples rather than citations.
//
// CRLF. The checkout is `core.autocrlf=true`. Everything here splits on
// `/\r?\n/` and counts lines from that split, which is correct under both
// terminators; nothing reconstructs text by joining on a bare "\n".
//
// USAGE
//   node Tools/verify-doc-citations.mjs                  # tracked LIVE migration_doc
//   node Tools/verify-doc-citations.mjs --include-archive
//   node Tools/verify-doc-citations.mjs --strict-base     # ROOT_RELATIVE becomes a violation
//   node Tools/verify-doc-citations.mjs --json
//   node Tools/verify-doc-citations.mjs --report out.md
//
// EXIT CODES (the frozen fleet table, imported — never re-declared)
//   0 PASS        every citation resolves, every range exists, every named symbol is present
//   1 FAIL        at least one dead citation
//   2 ERROR       the guard itself broke, or was handed an argument it cannot read
//   3 STRUCTURAL  not a git repository, so there is no tree to ask

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { exitCodeForS5Status } from "./visual-regression/lib/verdict-exit-gate.mjs";

/** Every git call is bounded; a wedged git must not wedge the guard. */
const GIT_TIMEOUT_MS = 60_000;

/** How many relocation sites a SYMBOL_ABSENT detail names before eliding. */
const RELOCATION_HINT_LIMIT = 6;

/**
 * Child name used to ask whether a path is an ignored DIRECTORY. See
 * {@link makeIgnoreOracle} for why the question cannot be asked directly.
 */
const IGNORE_DIR_PROBE = "__citation_dir_probe__";

/** Buffer ceiling for `git ls-files` on a repository this size. */
const GIT_MAX_BUFFER = 256 * 1024 * 1024;

/** The document set this guard owns. */
export const DOC_ROOT = "migration_doc";

/** Path segment that marks a document as archived rather than live. */
export const ARCHIVE_SEGMENT = "archive";

/** Target extensions the symbol clause is willing to reason about. */
export const SYMBOL_SOURCE_EXTENSIONS = Object.freeze([
  ".ts",
  ".js",
  ".mjs",
  ".cjs",
  ".wgsl",
  ".glsl",
]);

/**
 * Citation dispositions.
 *
 * OK, ROOT_RELATIVE and IGNORED_TARGET are not failures. The advisory pair is
 * the whole difference between "this citation is wrong" and "this citation
 * follows a convention nobody has ruled on yet" — collapsing them is how a
 * guard earns a permanent `|| true`.
 */
export const DISPOSITIONS = Object.freeze({
  OK: "OK",
  MISSING_PATH: "MISSING_PATH",
  ARCHIVED_TARGET: "ARCHIVED_TARGET",
  RENAMED_EXTENSION: "RENAMED_EXTENSION",
  UNTRACKED_TARGET: "UNTRACKED_TARGET",
  RANGE_OUT_OF_BOUNDS: "RANGE_OUT_OF_BOUNDS",
  SYMBOL_ABSENT: "SYMBOL_ABSENT",
  ROOT_RELATIVE: "ROOT_RELATIVE",
  IGNORED_TARGET: "IGNORED_TARGET",
});

/** Dispositions that fail the run. ROOT_RELATIVE joins under `--strict-base`. */
const VIOLATION_DISPOSITIONS = new Set([
  DISPOSITIONS.MISSING_PATH,
  DISPOSITIONS.ARCHIVED_TARGET,
  DISPOSITIONS.RENAMED_EXTENSION,
  DISPOSITIONS.UNTRACKED_TARGET,
  DISPOSITIONS.RANGE_OUT_OF_BOUNDS,
  DISPOSITIONS.SYMBOL_ABSENT,
]);

/** Human-readable cause class per disposition, for the report. */
export const CAUSE_CLASS = Object.freeze({
  [DISPOSITIONS.MISSING_PATH]: "missing path",
  [DISPOSITIONS.ARCHIVED_TARGET]: "archived-and-moved",
  [DISPOSITIONS.RENAMED_EXTENSION]: "renamed extension",
  [DISPOSITIONS.UNTRACKED_TARGET]: "on disk but untracked",
  [DISPOSITIONS.RANGE_OUT_OF_BOUNDS]: "range out of bounds",
  [DISPOSITIONS.SYMBOL_ABSENT]: "symbol absent",
  [DISPOSITIONS.ROOT_RELATIVE]: "root-relative (advisory)",
  [DISPOSITIONS.IGNORED_TARGET]: "declared build artifact (advisory)",
});

/**
 * Inline markdown link. Group 1 is the text, group 2 the destination, which may
 * be angle-bracketed and may carry a title the group deliberately excludes.
 */
const INLINE_LINK =
  /\[((?:[^\]\\]|\\.)*)\]\(\s*(<[^>]*>|[^)\s]*)\s*(?:"[^"]*"|'[^']*')?\s*\)/g;

/** A fenced code block opener or closer, indented or not. */
const FENCE = /^\s{0,3}(?:```|~~~)/;

/** `#L120` or `#L120-L140` or `#L120-140`. */
const LINE_ANCHOR = /^L(\d+)(?:-L?(\d+))?$/;

/** A bare JavaScript-ish identifier. */
const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/** A backticked span sitting immediately before a link, punctuation aside. */
const TRAILING_CODE_SPAN = /`([^`]+)`[\s([,:;—–-]*$/u;

/**
 * Run git, bounded, from a working directory.
 *
 * @param {string[]} args Arguments after `git`.
 * @param {string} cwd Working directory.
 * @returns {string} stdout.
 */
function git(args, cwd) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: GIT_MAX_BUFFER,
  });
}

/**
 * Split on either line terminator. Line numbers are indices into this array.
 *
 * @param {string} source File text.
 * @returns {string[]} Lines.
 */
export function splitLines(source) {
  return source.split(/\r?\n/);
}

/**
 * Is this document path inside an archive directory?
 *
 * @param {string} docPath Repo-relative POSIX path.
 * @returns {boolean} True when any path segment is `archive`.
 */
export function isArchived(docPath) {
  return docPath.split("/").includes(ARCHIVE_SEGMENT);
}

/**
 * The documents this guard scans, out of a tracked set.
 *
 * Exported so the spec drives the SAME selection the CLI does. A spec that
 * reimplements the filter certifies its own copy of it.
 *
 * @param {Iterable<string>} tracked Tracked repo-relative POSIX paths.
 * @param {boolean} includeArchive Include `**\/archive/**` documents.
 * @returns {string[]} Sorted document paths.
 */
export function selectDocs(tracked, includeArchive) {
  return [...tracked]
    .filter(
      (file) =>
        file.startsWith(`${DOC_ROOT}/`) &&
        file.endsWith(".md") &&
        (includeArchive || !isArchived(file)),
    )
    .sort();
}

/**
 * Extract every relative-link citation from one document.
 *
 * Links inside fenced code blocks are samples, not citations, and are skipped.
 * Absolute URLs, in-document heading anchors, root-absolute paths and empty
 * destinations are not citations this guard can resolve and are dropped here
 * rather than carried as noise.
 *
 * @param {string} source Document text.
 * @param {string} docPath Repo-relative POSIX path of the document.
 * @returns {Array<object>} Citations with line numbers, text and target.
 */
export function extractCitations(source, docPath) {
  const citations = [];
  const lines = splitLines(source);
  let inFence = false;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (FENCE.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) {
      continue;
    }
    for (const match of line.matchAll(INLINE_LINK)) {
      let target = match[2] ?? "";
      if (target.startsWith("<") && target.endsWith(">")) {
        target = target.slice(1, -1);
      }
      if (target === "") {
        continue;
      }
      if (/^[a-z][a-z0-9+.-]*:/i.test(target)) {
        continue;
      }
      if (target.startsWith("#") || target.startsWith("/")) {
        continue;
      }
      const hash = target.indexOf("#");
      const rawPath = hash === -1 ? target : target.slice(0, hash);
      const fragment = hash === -1 ? "" : target.slice(hash + 1);
      if (rawPath === "") {
        continue;
      }
      citations.push({
        doc: docPath,
        line: i + 1,
        text: match[1] ?? "",
        target,
        rawPath,
        fragment,
        before: line.slice(0, match.index ?? 0),
      });
    }
  }
  return citations;
}

/**
 * Percent-decode and collapse `.`/`..` without inventing or removing a prefix.
 *
 * A malformed percent escape is left as written: the author's bytes are the
 * citation, and guessing at a repair is how the P-14 false-positive class was
 * produced in the first place.
 *
 * @param {string} rawPath The destination path exactly as authored.
 * @param {string} baseDir POSIX directory to resolve against.
 * @returns {string} Repo-relative POSIX path.
 */
export function resolveAsWritten(rawPath, baseDir) {
  let decoded;
  try {
    decoded = decodeURIComponent(rawPath);
  } catch {
    decoded = rawPath;
  }
  const joined = baseDir === "" ? decoded : `${baseDir}/${decoded}`;
  const normalized = path.posix.normalize(joined);
  return normalized.length > 1 && normalized.endsWith("/")
    ? normalized.slice(0, -1)
    : normalized;
}

/**
 * Every directory prefix of a tracked path, so a link to a directory resolves.
 *
 * `git ls-files` lists blobs only, and docs legitimately link at directories
 * (`../packages/engine/Source/Renderer/WebGPU/`). Without this the guard would
 * red on correct citations, which is the failure mode it exists to avoid.
 *
 * @param {Iterable<string>} tracked Tracked repo-relative POSIX paths.
 * @returns {Set<string>} Directory paths.
 */
export function trackedDirectories(tracked) {
  const dirs = new Set();
  for (const file of tracked) {
    let dir = path.posix.dirname(file);
    while (dir && dir !== "." && dir !== "/" && !dirs.has(dir)) {
      dirs.add(dir);
      dir = path.posix.dirname(dir);
    }
  }
  return dirs;
}

/**
 * Identifiers a citation's sentence unambiguously offers as the anchored symbol.
 *
 * See the header's "THE SYMBOL RULE IS DELIBERATELY SMALL" block for the five
 * conditions and why each one is there. This function implements (c), (d) and
 * (e); the caller enforces (a) and (b).
 *
 * @param {object} citation A citation from {@link extractCitations}.
 * @returns {string[]} Candidate symbols, possibly empty.
 */
export function symbolCandidates(citation) {
  const base = path.posix.basename(citation.rawPath);
  const stem = base.replace(/\.[A-Za-z0-9]+$/, "");
  const found = new Set();

  const accept = (raw) => {
    const token = raw
      .trim()
      .replace(/\(\)$/, "")
      .replace(/:[\d,\s–-]+$/u, "");
    if (!IDENTIFIER.test(token) || token.length < 3) {
      return;
    }
    // Mixed case or a leading underscore. A single lowercase word and a
    // SCREAMING_SNAKE document abbreviation are both ambiguous with prose.
    const codeShaped =
      token.startsWith("_") || (/[a-z]/.test(token) && /[A-Z]/.test(token));
    if (!codeShaped) {
      return;
    }
    if (token === base || token === stem) {
      return;
    }
    found.add(token);
  };

  const adjacent = TRAILING_CODE_SPAN.exec(citation.before);
  if (adjacent) {
    accept(adjacent[1]);
  }
  for (const span of citation.text.matchAll(/`([^`]+)`/g)) {
    accept(span[1]);
  }
  return [...found];
}

/**
 * Classify one citation against an injected tree.
 *
 * @param {object} citation A citation from {@link extractCitations}.
 * @param {object} deps Tree adapter.
 * @param {Set<string>} deps.tracked Tracked repo-relative POSIX paths.
 * @param {Set<string>} deps.directories Tracked directory paths.
 * @param {(p: string) => boolean} deps.onDisk Does the path exist on disk?
 * @param {(p: string) => boolean} deps.isIgnored Is the path gitignored?
 * @param {(p: string) => string} deps.readFile Read a repo-relative path.
 * @returns {object} `{ disposition, detail, resolved }`.
 */
export function classifyCitation(citation, deps) {
  const { tracked, directories, onDisk, isIgnored, readFile } = deps;
  const archiveIndex = deps.archiveIndex ?? archiveIndexOf(tracked);
  const docDir = path.posix.dirname(citation.doc);
  const fromDoc = resolveAsWritten(citation.rawPath, docDir);
  const fromRoot = resolveAsWritten(citation.rawPath, "");

  const hit = (candidate) =>
    tracked.has(candidate) || directories.has(candidate);

  if (!hit(fromDoc)) {
    // Not resolvable as written. Everything below only CLASSIFIES the failure —
    // no branch here can turn a miss back into a pass.
    if (isIgnored(fromDoc) || isIgnored(fromRoot)) {
      return {
        disposition: DISPOSITIONS.IGNORED_TARGET,
        detail: "target is a declared build artifact (gitignored)",
        resolved: fromDoc,
      };
    }
    if (hit(fromRoot)) {
      return {
        disposition: DISPOSITIONS.ROOT_RELATIVE,
        detail: `resolves only from the repository root (${fromRoot}), not from ${docDir}/`,
        resolved: fromRoot,
      };
    }
    if (onDisk(fromDoc)) {
      return {
        disposition: DISPOSITIONS.UNTRACKED_TARGET,
        detail: `${fromDoc} is on disk but the tree does not track it`,
        resolved: fromDoc,
      };
    }
    // Both bases missed, so the citation is dead either way; all that is left is
    // to NAME the cause, and the name is worth taking from whichever base can
    // supply one. A link written root-relative to a file that has also been
    // renamed `.js` → `.ts` is dead twice over, and labelling it "missing path"
    // hides the half a fixer can act on. Nothing in this loop can turn a miss
    // into a pass — it only chooses the label and says which base produced it.
    for (const [base, note] of [
      [fromDoc, ""],
      [fromRoot, " (the link is also written root-relative)"],
    ]) {
      const renamed = renameCandidate(base, tracked);
      if (renamed) {
        return {
          disposition: DISPOSITIONS.RENAMED_EXTENSION,
          detail: `${base} is gone; the tree tracks ${renamed}${note}`,
          resolved: null,
        };
      }
      const archived = archiveCandidate(base, archiveIndex);
      if (archived) {
        return {
          disposition: DISPOSITIONS.ARCHIVED_TARGET,
          detail: `${base} is gone; the tree tracks ${archived}${note}`,
          resolved: null,
        };
      }
    }
    return {
      disposition: DISPOSITIONS.MISSING_PATH,
      detail: `${fromDoc} is in neither the tree nor the working directory`,
      resolved: null,
    };
  }

  const anchor = LINE_ANCHOR.exec(citation.fragment);
  if (!anchor) {
    return { disposition: DISPOSITIONS.OK, detail: "", resolved: fromDoc };
  }
  const start = Number(anchor[1]);
  const end = anchor[2] === undefined ? start : Number(anchor[2]);

  let lines;
  try {
    lines = splitLines(readFile(fromDoc));
  } catch (error) {
    return {
      disposition: DISPOSITIONS.RANGE_OUT_OF_BOUNDS,
      detail: `cannot read ${fromDoc} to check the range: ${error.message}`,
      resolved: fromDoc,
    };
  }
  // A trailing newline yields a final empty element that is not a line.
  const lineCount =
    lines.length > 0 && lines[lines.length - 1] === ""
      ? lines.length - 1
      : lines.length;
  if (start < 1 || end < start || end > lineCount) {
    return {
      disposition: DISPOSITIONS.RANGE_OUT_OF_BOUNDS,
      detail: `#L${start}${anchor[2] === undefined ? "" : `-L${end}`} but ${fromDoc} has ${lineCount} line(s)`,
      resolved: fromDoc,
    };
  }

  const extension = path.posix.extname(fromDoc);
  if (!SYMBOL_SOURCE_EXTENSIONS.includes(extension)) {
    return { disposition: DISPOSITIONS.OK, detail: "", resolved: fromDoc };
  }
  const candidates = symbolCandidates(citation);
  if (candidates.length === 0) {
    return { disposition: DISPOSITIONS.OK, detail: "", resolved: fromDoc };
  }
  const slice = lines.slice(start - 1, end).join("\n");
  const absent = candidates.filter((symbol) => !slice.includes(symbol));
  if (absent.length > 0) {
    const relocated = absent
      .map((symbol) => {
        // EVERY occurrence, not the first. `sampleAndBlend` occurs three times
        // in `GlobeFS.glsl` — twice in comments (34, 273) before its definition
        // at 429 — so "first at 34" would send the fixer to a comment and read
        // as though the symbol had barely moved. Listing the sites lets the
        // reader pick the definition; the guard does not try to guess which one
        // that is, because doing so means parsing six shader and script
        // languages, which is precisely the kind of guessing P-14 punishes.
        const at = occurrenceLines(lines, symbol, RELOCATION_HINT_LIMIT + 1);
        if (at.length === 0) {
          return `${symbol} (absent from the file)`;
        }
        const shown = at.slice(0, RELOCATION_HINT_LIMIT).join(", ");
        const more = at.length > RELOCATION_HINT_LIMIT ? ", …" : "";
        return `${symbol} (now at line ${shown}${more})`;
      })
      .join(", ");
    return {
      disposition: DISPOSITIONS.SYMBOL_ABSENT,
      detail: `#L${start}-L${end} of ${fromDoc} no longer contains ${relocated}`,
      resolved: fromDoc,
      symbolChecked: true,
    };
  }
  // `symbolChecked` marks the two returns the symbol clause actually reached.
  // The count of assertions is reported, and a reported count must mean what it
  // says: an earlier draft re-derived it in the caller from the citation alone,
  // which counted assertions over targets that never resolved and so were never
  // asserted against anything.
  return {
    disposition: DISPOSITIONS.OK,
    detail: "",
    resolved: fromDoc,
    symbolChecked: true,
  };
}

/**
 * Every 1-based line on which a symbol occurs, up to a limit.
 *
 * @param {string[]} lines File lines.
 * @param {string} symbol The identifier to find.
 * @param {number} limit Stop after this many hits.
 * @returns {number[]} Line numbers.
 */
function occurrenceLines(lines, symbol, limit) {
  const found = [];
  for (let i = 0; i < lines.length && found.length < limit; i += 1) {
    if (lines[i].includes(symbol)) {
      found.push(i + 1);
    }
  }
  return found;
}

/**
 * A tracked sibling with the same stem and a different extension.
 *
 * @param {string} target The missing repo-relative path.
 * @param {Set<string>} tracked Tracked paths.
 * @returns {string|null} The sibling, or null.
 */
function renameCandidate(target, tracked) {
  const extension = path.posix.extname(target);
  if (extension === "") {
    return null;
  }
  const stem = target.slice(0, -extension.length);
  for (const alternative of [".ts", ".js", ".mjs", ".cjs", ".tsx", ".jsx"]) {
    if (alternative === extension) {
      continue;
    }
    if (tracked.has(`${stem}${alternative}`)) {
      return `${stem}${alternative}`;
    }
  }
  return null;
}

/**
 * Basename → the first tracked path with that basename under an `archive/`
 * directory. Built once per run: scanning the whole tracked set per miss is
 * O(misses × tree), which on this repository is several million comparisons for
 * an answer that never changes mid-run.
 *
 * @param {Set<string>} tracked Tracked paths.
 * @returns {Map<string, string>} Basename → archived path.
 */
export function archiveIndexOf(tracked) {
  const index = new Map();
  for (const file of tracked) {
    if (!isArchived(file)) {
      continue;
    }
    const base = path.posix.basename(file);
    if (!index.has(base)) {
      index.set(base, file);
    }
  }
  return index;
}

/**
 * The same basename, tracked under an `archive/` directory.
 *
 * @param {string} target The missing repo-relative path.
 * @param {Map<string, string>} archiveIndex From {@link archiveIndexOf}.
 * @returns {string|null} The archived path, or null.
 */
function archiveCandidate(target, archiveIndex) {
  return archiveIndex.get(path.posix.basename(target)) ?? null;
}

/**
 * Verify a document set against an injected tree.
 *
 * @param {object} options Inputs.
 * @param {string[]} options.docs Repo-relative POSIX paths of documents.
 * @param {(p: string) => string} options.readFile Read a repo-relative path.
 * @param {Set<string>} options.tracked Tracked repo-relative POSIX paths.
 * @param {(p: string) => boolean} [options.onDisk] Path exists on disk.
 * @param {(p: string) => boolean} [options.isIgnored] Path is gitignored.
 * @param {(paths: string[]) => void} [options.primeIgnored] Batch-warm the
 *   ignore oracle before classification. Optional, and purely a performance
 *   seam: `isIgnored` must return the same answers either way.
 * @param {boolean} [options.strictBase] Promote ROOT_RELATIVE to a violation.
 * @returns {object} `{ status, totals, violations, advisories }`.
 */
export function verifyDocCitations({
  docs,
  readFile,
  tracked,
  onDisk = () => false,
  isIgnored = () => false,
  primeIgnored = null,
  strictBase = false,
}) {
  const trackedSet = tracked instanceof Set ? tracked : new Set(tracked);
  const directories = trackedDirectories(trackedSet);
  const deps = {
    tracked: trackedSet,
    directories,
    archiveIndex: archiveIndexOf(trackedSet),
    onDisk,
    isIgnored,
    readFile,
  };

  const violations = [];
  const advisories = [];
  const byDisposition = Object.create(null);
  let citationCount = 0;
  let anchorCount = 0;
  let symbolAssertions = 0;

  // Extract everything first, then warm the ignore oracle in ONE call, then
  // classify. Asked lazily, one candidate at a time, the real run spent the
  // overwhelming majority of its wall clock inside `git check-ignore` process
  // spawns on Windows — a guard slow enough to skip is a guard that gets
  // skipped. Only candidates that MISS the tracked set are ever asked about,
  // which is why the prime list is built here rather than from every citation.
  const extracted = docs.map((doc) => extractCitations(readFile(doc), doc));
  if (typeof primeIgnored === "function") {
    const candidates = new Set();
    for (const citations of extracted) {
      for (const citation of citations) {
        const docDir = path.posix.dirname(citation.doc);
        const fromDoc = resolveAsWritten(citation.rawPath, docDir);
        const fromRoot = resolveAsWritten(citation.rawPath, "");
        if (trackedSet.has(fromDoc) || directories.has(fromDoc)) {
          continue;
        }
        candidates.add(fromDoc);
        candidates.add(fromRoot);
      }
    }
    primeIgnored([...candidates]);
  }

  for (const citations of extracted) {
    for (const citation of citations) {
      citationCount += 1;
      if (LINE_ANCHOR.test(citation.fragment)) {
        anchorCount += 1;
      }
      const result = classifyCitation(citation, deps);
      if (result.symbolChecked === true) {
        symbolAssertions += 1;
      }
      byDisposition[result.disposition] =
        (byDisposition[result.disposition] ?? 0) + 1;
      if (result.disposition === DISPOSITIONS.OK) {
        continue;
      }
      const record = {
        doc: citation.doc,
        line: citation.line,
        target: citation.target,
        disposition: result.disposition,
        cause: CAUSE_CLASS[result.disposition] ?? result.disposition,
        detail: result.detail,
      };
      const failing =
        VIOLATION_DISPOSITIONS.has(result.disposition) ||
        (strictBase && result.disposition === DISPOSITIONS.ROOT_RELATIVE);
      (failing ? violations : advisories).push(record);
    }
  }

  return {
    status: violations.length > 0 ? "FAIL" : "PASS",
    totals: {
      documents: docs.length,
      citations: citationCount,
      lineAnchors: anchorCount,
      symbolAssertions,
      byDisposition,
      violations: violations.length,
      advisories: advisories.length,
    },
    violations,
    advisories,
  };
}

/**
 * Group records by cause class, preserving document order within a class.
 *
 * @param {Array<object>} records Violations or advisories.
 * @returns {Map<string, Array<object>>} Cause class → records.
 */
export function groupByCause(records) {
  const grouped = new Map();
  for (const record of records) {
    if (!grouped.has(record.cause)) {
      grouped.set(record.cause, []);
    }
    grouped.get(record.cause).push(record);
  }
  return grouped;
}

/**
 * Render the human report.
 *
 * @param {object} report A report from {@link verifyDocCitations}.
 * @returns {string} Report text.
 */
export function renderReport(report) {
  const lines = [];
  const { totals } = report;
  lines.push(
    `verify-doc-citations: ${totals.citations} relative citation(s) across ${totals.documents} document(s); ` +
      `${totals.lineAnchors} line anchor(s); ${totals.symbolAssertions} symbol assertion(s)`,
  );
  if (report.violations.length > 0) {
    lines.push("", "DEAD CITATIONS");
    for (const [cause, records] of groupByCause(report.violations)) {
      lines.push(`  ${cause} — ${records.length}`);
      for (const record of records) {
        lines.push(`    ${record.doc}:${record.line}  ${record.target}`);
        lines.push(`      ${record.detail}`);
      }
    }
  }
  if (report.advisories.length > 0) {
    lines.push("", "ADVISORIES (not failures)");
    for (const [cause, records] of groupByCause(report.advisories)) {
      lines.push(`  ${cause} — ${records.length}`);
    }
  }
  lines.push(
    "",
    `${report.status}: ${report.violations.length} dead citation(s), ${report.advisories.length} advisory(ies)`,
  );
  return lines.join("\n");
}

const USAGE = `Usage: node Tools/verify-doc-citations.mjs [options]

Asserts that every relative markdown link and every #L line anchor in the
tracked LIVE migration_doc set resolves as written, that the anchored line
range exists, and that a range still contains the symbol its sentence names.

  --include-archive  also scan migration_doc/**/archive/**
  --strict-base      treat root-relative links as violations, not advisories
  --json             emit the report as JSON
  --report <file>    also write the rendered report to <file>
  -h, --help         this message

Exit: 0 clean, 1 dead citations, 2 guard error, 3 structural (no repo).`;

/**
 * Parse CLI arguments.
 *
 * @param {string[]} argv Arguments after the script name.
 * @returns {object} Options.
 */
export function parseArgs(argv) {
  const options = {
    includeArchive: false,
    strictBase: false,
    json: false,
    report: null,
    help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--include-archive") {
      options.includeArchive = true;
    } else if (arg === "--strict-base") {
      options.strictBase = true;
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg === "--report") {
      i += 1;
      if (i >= argv.length) {
        throw new Error("--report needs a file path");
      }
      options.report = argv[i];
    } else if (arg === "-h" || arg === "--help") {
      options.help = true;
    } else {
      throw new Error(`unrecognized argument "${arg}"`);
    }
  }
  return options;
}

/**
 * CLI entry point.
 *
 * @param {string[]} argv Arguments after the script name.
 * @returns {number} Exit code.
 */
export function main(argv) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    console.error(`verify-doc-citations: ${error.message}`);
    console.error(USAGE);
    return exitCodeForS5Status("ERROR");
  }
  if (options.help) {
    console.log(USAGE);
    return exitCodeForS5Status("PASS");
  }

  let root;
  try {
    root = git(["rev-parse", "--show-toplevel"], process.cwd()).trim();
  } catch {
    console.error(
      "verify-doc-citations: STRUCTURAL — not a git repository, so there is no tree to ask.",
    );
    return exitCodeForS5Status("STRUCTURAL");
  }

  let report;
  try {
    const tracked = new Set(
      git(["ls-files", "-z"], root)
        .split("\0")
        .filter((entry) => entry.length > 0),
    );
    const docs = selectDocs(tracked, options.includeArchive);
    const oracle = makeIgnoreOracle(root);
    report = verifyDocCitations({
      docs,
      tracked,
      readFile: (relative) => readFileSync(path.join(root, relative), "utf8"),
      onDisk: (relative) => existsSync(path.join(root, relative)),
      isIgnored: oracle.isIgnored,
      primeIgnored: oracle.prime,
      strictBase: options.strictBase,
    });
  } catch (error) {
    console.error(`verify-doc-citations: ERROR — ${error.message}`);
    return exitCodeForS5Status("ERROR");
  }

  const rendered = options.json
    ? JSON.stringify(report, null, 2)
    : renderReport(report);
  console.log(rendered);
  if (options.report !== null) {
    try {
      writeFileSync(options.report, `${rendered}\n`, "utf8");
    } catch (error) {
      console.error(
        `verify-doc-citations: ERROR — cannot write ${options.report}: ${error.message}`,
      );
      return exitCodeForS5Status("ERROR");
    }
  }
  return exitCodeForS5Status(report.status);
}

/**
 * A memoized `git check-ignore` oracle.
 *
 * `check-ignore` answers for paths that do not exist, which is exactly the case
 * that matters: a link to `Tools/visual-regression/output/...` is a DECLARED
 * build artifact even in a fresh clone where the directory has never been made.
 *
 * TWO QUESTIONS ARE ASKED, and the second one's FORM is the whole point.
 * `.gitignore:93` is `/Tools/visual-regression/output/` — a directory-only
 * pattern, which git will not match against a path spelled as a file. Asked
 * about `Tools/visual-regression/output`, `check-ignore` answers "not ignored"
 * for a path that is emphatically ignored, and the two
 * `../Tools/visual-regression/output/` links in `WEBGPU_DEBUGGING_LOG.md` are
 * reported dead when they are correct — the P-14 shape, the resolver's own
 * handling of a path manufacturing a failure.
 *
 * The obvious repair is to re-ask with a trailing slash. DO NOT: on git 2.x
 * `check-ignore --no-index -- "anything/"` reports a match against the BLANK
 * line at `.gitignore:105`, whose pattern prints as empty, so EVERY path
 * spelled as a directory comes back ignored. The blank line behaves this way
 * because this `.gitignore` is CRLF: git drops the `\n` and keeps the `\r`,
 * leaving a one-character pattern that a directory-spelled query matches and a
 * file-spelled query does not. An LF `.gitignore` does not reproduce it — which
 * is why the spec's fixture writes its ignore file with `\r\n` deliberately.
 *
 * Measured on this tree at Batch 1424 the trap moved the run from 48 dead /
 * 250 advisory to 2 dead / 296 advisory — 46 real dead citations silently
 * reclassified as declared build artifacts. (An earlier draft of this comment
 * read "52 → 2, fifty reclassified". 52/248 was run 1, before two of this
 * file's own defects were fixed, kept beside a destination measured after;
 * every run from run 3 onward reads 48/250. A guard against rotted figures may
 * not carry one.) A guard's false NEGATIVES are the more expensive half of the
 * same P-14 lesson: the mass-advisory run still exits 1 and still looks like it
 * is working.
 *
 * So the directory question is asked as a CHILD path. A directory-only pattern
 * ignores everything beneath it, so `<candidate>/__probe__` is ignored exactly
 * when `<candidate>` is an ignored directory, and it is a file-shaped query git
 * answers straightforwardly. Verified selective on this tree: the three
 * non-artifact examples above all come back clean. Exported so the spec can
 * assert that selectivity against a fixture repository carrying both shapes,
 * rather than injecting `isIgnored: () => false` and testing nothing — the
 * trailing-slash trap above passed a nine-test spec that could not reach here.
 *
 * @param {string} root Repository root.
 * @returns {{isIgnored: (p: string) => boolean, prime: (paths: string[]) => void}}
 *   The oracle and its batch warm-up.
 */
export function makeIgnoreOracle(root) {
  const cache = new Map();
  const ask = (spelling) => {
    try {
      execFileSync(
        "git",
        ["check-ignore", "-q", "--no-index", "--", spelling],
        {
          cwd: root,
          timeout: GIT_TIMEOUT_MS,
          stdio: "ignore",
        },
      );
      return true;
    } catch {
      return false;
    }
  };
  const spellings = (candidate) => [
    candidate,
    `${candidate}/${IGNORE_DIR_PROBE}`,
  ];
  // A `../CLAUDE.md` written from a doc already at the repository root resolves,
  // against the ROOT base, to a path outside the repository. `git check-ignore`
  // treats one such path as fatal and abandons the WHOLE batch, so an unfiltered
  // prime silently degraded to no priming at all — the run stayed at ~100 s and
  // nothing said why. Nothing outside the tree can be ignored by it, so these are
  // answered here rather than asked.
  const escapesRepo = (candidate) =>
    candidate === ".." || candidate.startsWith("../");
  // ONE SPAWN, NOT HUNDREDS. Asked lazily, one candidate at a time, this guard
  // spent ~100 s of a ~103 s run creating `git` processes on Windows. `prime`
  // feeds every candidate — both spellings — to a single `check-ignore --stdin`
  // and records the answers. It is an optimisation only: `isIgnored` still
  // answers a cold path by spawning, so a caller that never primes gets the
  // same verdicts, slowly.
  const prime = (paths) => {
    const inside = paths.filter((candidate) => !escapesRepo(candidate));
    for (const candidate of paths) {
      if (escapesRepo(candidate)) {
        cache.set(candidate, false);
      }
    }
    const queries = inside.flatMap(spellings);
    if (queries.length === 0) {
      return;
    }
    let ignored;
    try {
      ignored = execFileSync(
        "git",
        ["check-ignore", "-z", "--stdin", "--no-index"],
        {
          cwd: root,
          input: `${queries.join("\0")}\0`,
          encoding: "utf8",
          timeout: GIT_TIMEOUT_MS,
          maxBuffer: GIT_MAX_BUFFER,
        },
      );
    } catch (error) {
      // Exit 1 is git's "none of these are ignored" and is a real answer.
      // Anything else is a failure: leave the cache COLD so `isIgnored` falls
      // back to per-path spawns, rather than caching "nothing is ignored" and
      // turning a broken git into 300 confident false failures.
      if (error.status !== 1) {
        return;
      }
      ignored = typeof error.stdout === "string" ? error.stdout : "";
    }
    const hits = new Set(ignored.split("\0").filter((entry) => entry !== ""));
    for (const candidate of inside) {
      cache.set(
        candidate,
        spellings(candidate).some((spelling) => hits.has(spelling)),
      );
    }
  };
  const isIgnored = (candidate) => {
    if (cache.has(candidate)) {
      return cache.get(candidate);
    }
    const ignored =
      !escapesRepo(candidate) &&
      spellings(candidate).some((spelling) => ask(spelling));
    cache.set(candidate, ignored);
    return ignored;
  };
  return { isIgnored, prime };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  // NO WATCHDOG, DELIBERATELY. An earlier draft of this file armed a `setTimeout`
  // whose body exited, on the fleet's usual reasoning that a guard which hangs has
  // silently stopped guarding. Here that timer was inert: `main` is synchronous end
  // to end — `execFileSync`, `readFileSync`, `writeFileSync` — so the event loop is
  // never reached while work is outstanding, and a timer callback cannot run inside
  // a blocking call. It would have fired only after the run it was meant to bound
  // had already finished, i.e. never. A watchdog that cannot fire is worse than
  // none: it advertises a protection nobody has. What actually bounds this guard is
  // `GIT_TIMEOUT_MS` on every `git` invocation, which is where the only unbounded
  // wait (a wedged git) lives. If this file ever grows an `await`, the timer comes
  // back — and the fleet contract that requires one covers `probe-*.mjs`, not
  // `verify-*.mjs`, so nothing else is asking for it in the meantime.
  process.exitCode = main(process.argv.slice(2));
}
