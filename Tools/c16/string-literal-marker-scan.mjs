#!/usr/bin/env node
// string-literal-marker-scan.mjs — C16 marker scan for JavaScript and TypeScript literals.
// @purpose Finds banned tracker vocabulary inside string and template literals that the comment-marker guard intentionally cannot see.
// @status ACTIVE
//
// The comment-marker guard scans comments. Embedded shader comments, warning
// messages, labels, and generated-comment emitters are JavaScript/TypeScript
// literal text instead, so they need a complementary scan. This tool reuses
// both shared C16 components: comment-scanner owns syntax boundaries and
// marker-grammar owns the banned vocabulary.
//
// USAGE
//   node Tools/c16/string-literal-marker-scan.mjs [files-or-directories...]
//   node Tools/c16/string-literal-marker-scan.mjs --self-test
//
// With no paths, packages/engine/Source is scanned recursively. Directories
// are walked recursively; supported JavaScript and TypeScript files are
// selected. Findings are one row per marker-bearing literal source line.
//
// EXIT CODES
//   0  clean, or --self-test passed
//   1  one or more marker-bearing literal lines found
//   2  bad arguments, unreadable input, or another tool error
//   3  STRUCTURAL: no supported files were found, the shared grammar failed
//      its self-test, or this tool's planted self-test failed

import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  languageForPath,
  lineOf as canonicalLineOf,
  lineStarts as collectLineStarts,
  tokenize,
} from "./lib/comment-scanner.mjs";
import { findMarkers, selfTestRules } from "./lib/marker-grammar.mjs";

const ROOT = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const DEFAULT_SCOPE = path.join(ROOT, "packages", "engine", "Source");

function usage() {
  return [
    "Usage:",
    "  node Tools/c16/string-literal-marker-scan.mjs [files-or-directories...] [--json]",
    "  node Tools/c16/string-literal-marker-scan.mjs --self-test",
    "",
    "Options:",
    "  --self-test  Run planted positive and negative controls.",
    "  --json       Emit a machine-readable scan report.",
    "  --help       Show this help.",
    "",
    "Default scope: packages/engine/Source recursively.",
  ].join("\n");
}

/**
 * Parse command-line arguments.
 *
 * @param {string[]} argv Command-line arguments.
 * @returns {{paths: string[], selfTest: boolean, json: boolean, help: boolean}}
 */
export function parseArgs(argv) {
  const options = { paths: [], selfTest: false, json: false, help: false };
  let positionalOnly = false;

  for (const argument of argv) {
    if (positionalOnly) {
      options.paths.push(argument);
      continue;
    }
    if (argument === "--") {
      positionalOnly = true;
      continue;
    }
    if (argument === "--help" || argument === "-h") {
      options.help = true;
      continue;
    }
    if (argument === "--self-test") {
      options.selfTest = true;
      continue;
    }
    if (argument === "--json") {
      options.json = true;
      continue;
    }
    if (argument.startsWith("-")) {
      throw new Error(`unknown option: ${argument}`);
    }
    options.paths.push(argument);
  }

  if (options.selfTest && options.paths.length > 0) {
    throw new Error("--self-test does not accept file or directory paths");
  }
  if (options.selfTest && options.json) {
    throw new Error("--self-test and --json cannot be combined");
  }
  return options;
}

function toDisplayPath(file) {
  const relative = path.relative(process.cwd(), file);
  if (
    relative !== "" &&
    !relative.startsWith(`..${path.sep}`) &&
    relative !== ".." &&
    !path.isAbsolute(relative)
  ) {
    return relative.split(path.sep).join("/");
  }
  return file.split(path.sep).join("/");
}

function lineStarts(source) {
  return collectLineStarts(source);
}

function lineIndexAt(starts, offset) {
  return canonicalLineOf(starts, offset) - 1;
}

function lineExcerpt(source, starts, lineIndex) {
  const start = starts[lineIndex];
  const nextStart = starts[lineIndex + 1] ?? source.length;
  return source
    .slice(start, nextStart)
    .replace(/[\r\n]+$/, "")
    .trim();
}

function literalKind(raw) {
  if (raw.startsWith('"') || raw.startsWith("'")) {
    return "string";
  }
  if (raw.startsWith("`") || raw.startsWith("}")) {
    return "template";
  }
  // The shared tokenizer deliberately groups regular-expression literals
  // with string/template spans. Regexes are spec anchors, not runtime string
  // values, and are outside this scanner's contract.
  return null;
}

/**
 * Find marker-bearing string/template source lines in one already-loaded file.
 *
 * Multiple marker occurrences on one literal line are folded into one finding
 * while retaining every matching rule id and matched token.
 *
 * @param {string} file Display path used in findings.
 * @param {string} source JavaScript or TypeScript source text.
 * @returns {Array<{file: string, line: number, column: number, excerpt: string, literalKinds: string[], ruleIds: string[], matches: string[]}>}
 */
export function scanSource(file, source) {
  if (languageForPath(file) !== "js") {
    throw new Error(`expected a JavaScript or TypeScript file: ${file}`);
  }

  const starts = lineStarts(source);
  const byLine = new Map();

  for (const segment of tokenize(source, "js")) {
    if (segment.kind !== "string") {
      continue;
    }
    const raw = source.slice(segment.start, segment.end);
    const kind = literalKind(raw);
    if (kind === null) {
      continue;
    }

    const markerMatches = findMarkers(raw);
    for (const marker of markerMatches) {
      const offset = segment.start + marker.offset;
      const lineIndex = lineIndexAt(starts, offset);
      const line = lineIndex + 1;
      let finding = byLine.get(line);
      if (finding === undefined) {
        finding = {
          file,
          line,
          column: offset - starts[lineIndex] + 1,
          excerpt: lineExcerpt(source, starts, lineIndex),
          literalKinds: new Set(),
          ruleIds: new Set(),
          matches: new Set(),
        };
        byLine.set(line, finding);
      } else {
        finding.column = Math.min(
          finding.column,
          offset - starts[lineIndex] + 1,
        );
      }
      finding.literalKinds.add(kind);
      finding.ruleIds.add(marker.ruleId);
      finding.matches.add(marker.match);
    }
  }

  return [...byLine.values()]
    .sort((left, right) => left.line - right.line)
    .map((finding) => ({
      ...finding,
      literalKinds: [...finding.literalKinds].sort(),
      ruleIds: [...finding.ruleIds].sort(),
      matches: [...finding.matches],
    }));
}

async function collectDirectory(directory, files) {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const child = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      await collectDirectory(child, files);
    } else if (entry.isFile() && languageForPath(child) === "js") {
      files.add(path.resolve(child));
    }
  }
}

/**
 * Resolve explicit files/directories into a stable, unique source-file list.
 *
 * @param {string[]} inputPaths Paths relative to the current directory, or
 *   absolute paths. An empty list selects the default engine Source tree.
 * @returns {Promise<string[]>} Absolute JavaScript/TypeScript file paths.
 */
export async function collectSourceFiles(inputPaths) {
  const selected = inputPaths.length === 0 ? [DEFAULT_SCOPE] : inputPaths;
  const files = new Set();

  for (const input of selected) {
    const absolute = path.resolve(input);
    let stat;
    try {
      stat = await fs.stat(absolute);
    } catch (error) {
      if (error.code === "ENOENT") {
        throw new Error(`input path does not exist: ${input}`, {
          cause: error,
        });
      }
      throw error;
    }

    if (stat.isDirectory()) {
      await collectDirectory(absolute, files);
      continue;
    }
    if (!stat.isFile()) {
      throw new Error(
        `input path is not a regular file or directory: ${input}`,
      );
    }
    if (languageForPath(absolute) !== "js") {
      throw new Error(`unsupported input file; expected JS/TS: ${input}`);
    }
    files.add(absolute);
  }

  return [...files].sort((left, right) => left.localeCompare(right));
}

/**
 * Run planted controls for literal recognition and comment/regex exclusion.
 *
 * @returns {string[]} Failure descriptions; empty means the controls passed.
 */
export function selfTestScanner() {
  const positive = [
    'const warning = "Batch 47";',
    "const shader = `",
    "  // C2-22 is a deliberate forced-error probe path.",
    "`;",
    "const nested = `prefix ${value} // Session 65`;",
    'const internalDoc = "See migration_doc/DEFERRED_WORK.md.";',
    'lines.push("// DP-H46b — GENERATED structural-metadata chunk");',
  ].join("\n");
  const negative = [
    '// const warning = "Batch 47";',
    "/* `C2-22` is comment text, not a template. */",
    "const anchor = /Session 65/;",
    'const ordinary = "batch 47 is ordinary lower-case prose";',
    "const technical = `Avoid applying display gamma twice.`;",
  ].join("\n");

  const failures = [];
  const positiveFindings = scanSource("planted-positive.ts", positive);
  const expectedPositiveLines = [1, 3, 5, 6, 7];
  const actualPositiveLines = positiveFindings.map((finding) => finding.line);
  if (
    actualPositiveLines.length !== expectedPositiveLines.length ||
    actualPositiveLines.some(
      (line, index) => line !== expectedPositiveLines[index],
    )
  ) {
    failures.push(
      `positive controls: expected lines ${expectedPositiveLines.join(", ")}, got ${actualPositiveLines.join(", ") || "none"}`,
    );
  }

  const positiveRules = new Set(
    positiveFindings.flatMap((finding) => finding.ruleIds),
  );
  for (const expectedRule of [
    "batch-id",
    "campaign-row-id",
    "session-id",
    "tracker-document",
    "dp-h-id",
  ]) {
    if (!positiveRules.has(expectedRule)) {
      failures.push(`positive controls: ${expectedRule} was not reported`);
    }
  }

  const negativeFindings = scanSource("planted-negative.js", negative);
  if (negativeFindings.length > 0) {
    failures.push(
      `negative controls: expected no findings, got lines ${negativeFindings.map((finding) => finding.line).join(", ")}`,
    );
  }
  return failures;
}

function renderFinding(finding) {
  return `${finding.file}:${finding.line}:${finding.column} [${finding.ruleIds.join(",")}] ${finding.excerpt}`;
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
    console.error(`string-literal-marker-scan: ${error.message}`);
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
      `string-literal-marker-scan: STRUCTURAL — marker rules no longer match their own examples: ${brokenRules.join(", ")}`,
    );
    return 3;
  }

  if (options.selfTest) {
    const failures = selfTestScanner();
    if (failures.length > 0) {
      console.error("string-literal-marker-scan: SELF-TEST FAILED");
      for (const failure of failures) {
        console.error(`  ${failure}`);
      }
      return 3;
    }
    console.log("string-literal-marker-scan: self-test passed");
    return 0;
  }

  const files = await collectSourceFiles(options.paths);
  if (files.length === 0) {
    console.error(
      "string-literal-marker-scan: STRUCTURAL — no supported JavaScript or TypeScript files found; the scanner cannot see its subject.",
    );
    return 3;
  }

  const findings = [];
  for (const absolute of files) {
    const file = toDisplayPath(absolute);
    const source = await fs.readFile(absolute, "utf8");
    findings.push(...scanSource(file, source));
  }

  const report = {
    filesScanned: files.length,
    filesWithFindings: new Set(findings.map((finding) => finding.file)).size,
    findingLines: findings.length,
    findings,
  };
  if (options.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else if (findings.length === 0) {
    console.log(
      `string-literal-marker-scan: clean — ${files.length} file${files.length === 1 ? "" : "s"} scanned`,
    );
  } else {
    for (const finding of findings) {
      console.log(renderFinding(finding));
    }
    console.log(
      `string-literal-marker-scan: ${findings.length} marker-bearing literal line${findings.length === 1 ? "" : "s"} in ${report.filesWithFindings} file${report.filesWithFindings === 1 ? "" : "s"} (${files.length} scanned)`,
    );
  }
  return findings.length > 0 ? 1 : 0;
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
      console.error(`string-literal-marker-scan: ${error.stack ?? error}`);
      process.exitCode = 2;
    });
}
