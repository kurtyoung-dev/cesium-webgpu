#!/usr/bin/env node
// spec-anchor-sweep.mjs — pre-rewrite detection of specs coupled to source comments.
// @purpose Reports grammar, comment-only, and containment-locator anchors from spec literals against explicitly supplied source files.
// @status ACTIVE
//
// USAGE
//   node Tools/c16/spec-anchor-sweep.mjs \
//     --spec <spec-file> [<spec-file> ...] \
//     --source <source-file> [<source-file> ...]
//
// `--spec` and `--source` may each be repeated. `--json` emits the same
// findings as a machine-readable object. Findings are informational: a
// completed sweep exits 0 even when anchors are present.
//
// EXIT CODES
//   0  sweep completed (including a zero-finding result)
//   2  bad arguments, unreadable input, or another tool error
//   3  STRUCTURAL: the shared marker grammar failed its own self-test

import { promises as fs } from "node:fs";
import path from "node:path";
import { runInNewContext } from "node:vm";
import { fileURLToPath } from "node:url";

import { languageForPath, tokenize } from "./lib/comment-scanner.mjs";
import { findMarkers, selfTestRules } from "./lib/marker-grammar.mjs";

const CLASS_NAMES = Object.freeze({
  A: "grammar anchor",
  B: "comment-text anchor",
  C: "containment locator",
});

const CONTAINMENT_CALL =
  /(?:(?:\?\.|\.)\s*|\b)(indexOf|includes|lastIndexOf|search|split)\s*(?:\?\.)?\(\s*(?:\(\s*)*$/;

function usage() {
  return [
    "Usage:",
    "  node Tools/c16/spec-anchor-sweep.mjs --spec <file> [<file> ...] --source <file> [<file> ...] [--json]",
    "",
    "Options:",
    "  --spec <file...>    JavaScript/TypeScript spec files; repeatable.",
    "  --source <file...>  In-scope JS/TS/WGSL/GLSL source files; repeatable.",
    "  --json              Emit a machine-readable report.",
    "  --help              Show this help.",
  ].join("\n");
}

/**
 * Parse grouped or repeated `--spec` / `--source` arguments.
 *
 * @param {string[]} argv Command-line arguments.
 * @returns {{specs: string[], sources: string[], json: boolean, help: boolean}}
 */
export function parseArgs(argv) {
  const options = { specs: [], sources: [], json: false, help: false };
  let destination = null;

  for (const argument of argv) {
    if (argument === "--help" || argument === "-h") {
      options.help = true;
      continue;
    }
    if (argument === "--json") {
      options.json = true;
      continue;
    }
    if (argument === "--spec") {
      destination = options.specs;
      continue;
    }
    if (argument === "--source") {
      destination = options.sources;
      continue;
    }
    if (argument.startsWith("--spec=")) {
      const value = argument.slice("--spec=".length);
      if (value.length === 0) {
        throw new Error("--spec requires a file path");
      }
      options.specs.push(value);
      continue;
    }
    if (argument.startsWith("--source=")) {
      const value = argument.slice("--source=".length);
      if (value.length === 0) {
        throw new Error("--source requires a file path");
      }
      options.sources.push(value);
      continue;
    }
    if (argument.startsWith("-")) {
      throw new Error(`unknown option: ${argument}`);
    }
    if (destination === null) {
      throw new Error(`file path has no --spec or --source group: ${argument}`);
    }
    destination.push(argument);
  }

  if (!options.help && options.specs.length === 0) {
    throw new Error("at least one --spec file is required");
  }
  if (!options.help && options.sources.length === 0) {
    throw new Error("at least one --source file is required");
  }
  return options;
}

function uniqueAbsolutePaths(filePaths) {
  return [...new Set(filePaths.map((filePath) => path.resolve(filePath)))];
}

function maskText(text) {
  return text.replace(/[^\n]/g, " ");
}

function lineStarts(source) {
  const starts = [0];
  for (let i = 0; i < source.length; i += 1) {
    if (source[i] === "\n") {
      starts.push(i + 1);
    }
  }
  return starts;
}

function lineAt(starts, offset) {
  let low = 0;
  let high = starts.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (starts[middle] <= offset) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  return low;
}

function parseRegexLiteral(raw) {
  let delimiter = raw.length - 1;
  while (delimiter > 0 && /[a-z]/i.test(raw[delimiter])) {
    delimiter -= 1;
  }
  if (raw[0] !== "/" || raw[delimiter] !== "/") {
    return null;
  }
  const pattern = raw.slice(1, delimiter);
  const flags = raw.slice(delimiter + 1);
  // Compilation distinguishes a genuine literal from a safe-direction
  // tokenizer heuristic that happened to span division operators.
  // Compile to validate: an invalid pattern means the tokenizer
  // spanned division operators rather than finding a real literal.
  const compiled = new RegExp(pattern, flags);
  if (!(compiled instanceof RegExp)) {
    return null;
  }
  return { pattern, flags };
}

function parseLiteral(raw) {
  if (raw.startsWith('"') || raw.startsWith("'")) {
    const text = runInNewContext(raw, Object.create(null), { timeout: 50 });
    if (typeof text !== "string") {
      return null;
    }
    return { literalKind: "string", text };
  }
  if (raw.startsWith("/")) {
    const regex = parseRegexLiteral(raw);
    if (regex === null) {
      return null;
    }
    return {
      literalKind: "regex",
      text: regex.pattern,
      pattern: regex.pattern,
      flags: regex.flags,
    };
  }
  // Template chunks are emitted as `string` segments by the shared scanner,
  // but this sweep deliberately owns quoted strings and regex literals only.
  return null;
}

function findContainmentVerb(maskedSyntax, offset) {
  const match = maskedSyntax.slice(0, offset).match(CONTAINMENT_CALL);
  return match?.[1] ?? null;
}

/**
 * Extract quoted-string and regex literals from one spec.
 *
 * The shared C16 tokenizer owns comment/string/regex boundaries. This tool
 * only adds semantic decoding and the containment-call classification.
 *
 * @param {string} source Spec source text.
 * @returns {Array<{literalKind: string, text: string, pattern?: string, flags?: string, raw: string, line: number, containmentVerb: string|null}>}
 */
export function extractSpecLiterals(source) {
  const normalized = source.replace(/\r\n?/g, "\n");
  const segments = tokenize(normalized, "js");
  const starts = lineStarts(normalized);
  const maskedSyntax = segments
    .map((segment) => {
      const raw = normalized.slice(segment.start, segment.end);
      return segment.kind === "code" ? raw : maskText(raw);
    })
    .join("");

  const literals = [];
  for (const segment of segments) {
    if (segment.kind !== "string") {
      continue;
    }
    const raw = normalized.slice(segment.start, segment.end);
    let parsed;
    try {
      parsed = parseLiteral(raw);
    } catch {
      // The shared tokenizer documents a safe-direction regex heuristic. A
      // span that is not independently compilable is code, not a finding.
      continue;
    }
    if (parsed === null) {
      continue;
    }
    literals.push({
      ...parsed,
      raw,
      line: lineAt(starts, segment.start),
      containmentVerb: findContainmentVerb(maskedSyntax, segment.start),
    });
  }
  return literals;
}

function matchesLiteral(literal, text) {
  if (literal.literalKind === "string") {
    return text.includes(literal.text);
  }
  return new RegExp(literal.pattern, literal.flags).test(text);
}

function analyzeSource(file, source) {
  const language = languageForPath(file);
  if (language === null) {
    throw new Error(`unsupported source-file extension: ${file}`);
  }
  const normalized = source.replace(/\r\n?/g, "\n");
  const segments = tokenize(normalized, language);
  const comments = [];
  const codeChunks = [];
  let codeChunk = "";
  for (const segment of segments) {
    const raw = normalized.slice(segment.start, segment.end);
    if (segment.kind === "comment") {
      comments.push(raw);
      if (codeChunk.length > 0) {
        codeChunks.push(codeChunk);
        codeChunk = "";
      }
    } else {
      // Source literals are code text for Class B. Omitting the shared
      // scanner's `string` segments would turn a runtime string containing the
      // same prose into a false comment-only finding.
      codeChunk += raw;
    }
  }
  if (codeChunk.length > 0) {
    codeChunks.push(codeChunk);
  }
  return {
    file,
    text: normalized,
    comments,
    codeChunks,
  };
}

function makeFinding(classId, specFile, literal, sourceFile, extra = {}) {
  return {
    class: classId,
    className: CLASS_NAMES[classId],
    specFile,
    line: literal.line,
    literal: literal.raw,
    literalKind: literal.literalKind,
    sourceFile,
    ...extra,
  };
}

/**
 * Sweep already-loaded specs and sources.
 *
 * Classes are independent. A marker-bearing comment locator can therefore
 * produce A, B, and C findings; suppressing one would violate that class's
 * "any literal" predicate and hide useful information from the rewrite shard.
 *
 * @param {Array<{file: string, source: string}>} specs Spec inputs.
 * @param {Array<{file: string, source: string}>} sources Source inputs.
 * @returns {Array<object>} Findings in spec/literal/source/class order.
 */
export function sweepAnchors(specs, sources) {
  const analyzedSources = sources.map(({ file, source }) =>
    analyzeSource(file, source),
  );
  const findings = [];

  for (const spec of specs) {
    const language = languageForPath(spec.file);
    if (language !== "js") {
      throw new Error(
        `spec file must be JavaScript or TypeScript: ${spec.file}`,
      );
    }
    for (const literal of extractSpecLiterals(spec.source)) {
      const markerMatches = findMarkers(literal.text);
      for (const source of analyzedSources) {
        const resolves = matchesLiteral(literal, source.text);
        const matchesComment = source.comments.some((comment) =>
          matchesLiteral(literal, comment),
        );
        const matchesCode = source.codeChunks.some((code) =>
          matchesLiteral(literal, code),
        );

        if (markerMatches.length > 0 && resolves) {
          findings.push(
            makeFinding("A", spec.file, literal, source.file, {
              markerRuleIds: [
                ...new Set(markerMatches.map((match) => match.ruleId)),
              ],
            }),
          );
        }
        if (matchesComment && !matchesCode) {
          findings.push(makeFinding("B", spec.file, literal, source.file));
        }
        if (
          literal.containmentVerb !== null &&
          matchesComment &&
          !matchesCode
        ) {
          findings.push(
            makeFinding("C", spec.file, literal, source.file, {
              verb: literal.containmentVerb,
            }),
          );
        }
      }
    }
  }
  return findings;
}

function countsFor(findings) {
  const counts = { A: 0, B: 0, C: 0, total: findings.length };
  for (const finding of findings) {
    counts[finding.class] += 1;
  }
  return counts;
}

function renderHuman(report) {
  const { counts, findings } = report;
  const lines = [
    `spec-anchor-sweep: ${counts.total} finding${counts.total === 1 ? "" : "s"} (A ${counts.A}, B ${counts.B}, C ${counts.C})`,
  ];
  for (const finding of findings) {
    const verb = finding.verb === undefined ? "" : ` verb=${finding.verb}`;
    lines.push(
      `Class ${finding.class} — ${finding.className}: ${finding.specFile}:${finding.line} literal=${JSON.stringify(finding.literal)} source=${finding.sourceFile}${verb}`,
    );
  }
  return lines.join("\n");
}

/**
 * CLI entry point.
 *
 * @param {string[]} argv Command-line arguments.
 * @returns {Promise<number>} Process exit code.
 */
export async function main(argv = process.argv.slice(2)) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    console.error(`spec-anchor-sweep: ${error.message}`);
    console.error(usage());
    return 2;
  }

  if (options.help) {
    console.log(usage());
    return 0;
  }

  const brokenRules = selfTestRules();
  if (brokenRules.length > 0) {
    console.error(
      `spec-anchor-sweep: STRUCTURAL — marker rules no longer match their own examples: ${brokenRules.join(", ")}`,
    );
    return 3;
  }

  const specFiles = uniqueAbsolutePaths(options.specs);
  const sourceFiles = uniqueAbsolutePaths(options.sources);
  const specs = await Promise.all(
    specFiles.map(async (file) => ({
      file,
      source: await fs.readFile(file, "utf8"),
    })),
  );
  const sources = await Promise.all(
    sourceFiles.map(async (file) => ({
      file,
      source: await fs.readFile(file, "utf8"),
    })),
  );
  const findings = sweepAnchors(specs, sources);
  const report = {
    specFiles,
    sourceFiles,
    counts: countsFor(findings),
    findings,
  };

  if (options.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    console.log(renderHuman(report));
  }
  return 0;
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      console.error(`spec-anchor-sweep: ${error.stack ?? error}`);
      process.exitCode = 2;
    });
}
