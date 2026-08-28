#!/usr/bin/env node
// Lint: flag debug-style console calls in the WebGPU renderer that are NOT
// wrapped in a `//>>includeStart('debug', pragmas.debug)` ... `//>>includeEnd('debug')`
// guard.
// @purpose Lints Renderer/WebGPU for console.log/warn/debug/info calls not wrapped in //>>includeStart('debug') pragmas; console.error exempt by policy.
// @status ACTIVE
//
// Per CLAUDE.md ("Logging & Debug Pragmas"): per-frame / init-time /
// informational console.{log,warn,debug,info} MUST be pragma-wrapped so the
// build strips them with zero runtime cost. Only real `console.error`
// (broken-output bugs, shader/pipeline failures, device loss, loop sentinels)
// may be unguarded — so this lint deliberately IGNORES console.error.
//
// Runs in plain Node — no dependencies beyond the standard library. Intended
// as a CI gate and a pre-commit sanity check when touching the WebGPU renderer.
//
// Usage:
//   node Tools/lint-debug-pragmas.mjs           # text report, exit 1 if offenders
//   node Tools/lint-debug-pragmas.mjs --json     # machine-readable
//
// Exit codes: 0 = clean, 1 = at least one unguarded debug console call.

import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const SCAN_DIR = path.join(
  ROOT,
  "packages",
  "engine",
  "Source",
  "Renderer",
  "WebGPU",
);

const args = new Set(process.argv.slice(2));
const emitJson = args.has("--json");

// Include console.error in the match so its permanent policy is an explicit,
// testable branch rather than an omission from the expression.
const CONSOLE_METHODS = ["log", "warn", "debug", "info", "error"];
const CONSOLE_RE = new RegExp(
  `\\bconsole\\.(${CONSOLE_METHODS.join("|")})\\s*\\(`,
);
const ALLOW_MARKER_RE = /^\s*\/\/\s*lint-debug-pragmas-allow\b/;

const PRAGMA_START_RE =
  /\/\/>>includeStart\(\s*['"]debug['"]\s*,\s*pragmas\.debug\s*\)/;
const PRAGMA_END_RE = /\/\/>>includeEnd\(\s*['"]debug['"]\s*\)/;

async function collectFiles(dir) {
  const out = [];
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await collectFiles(full)));
    } else if (entry.isFile() && /\.(?:ts|js)$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

export function findOffenders(source, relPath) {
  const lines = source.split(/\r?\n/);
  const offenders = [];
  let depth = 0; // nesting depth of open debug-pragma blocks

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Skip lines that are documentation comments — a `console.log(...)` inside
    // a JSDoc `@example` block (line starts with `*` or `//`) is illustrative
    // text, not a runtime call, and must not be flagged.
    const trimmed = line.trim();
    const isCommentLine =
      trimmed.startsWith("*") ||
      trimmed.startsWith("//") ||
      trimmed.startsWith("/*");

    // Track pragma block depth. A line can legitimately contain both a start
    // and an end (rare), so handle both; ordering within a single line is not
    // meaningful for our "is this console call guarded" question because a
    // console call on the same line as the start directive is unusual — the
    // common pattern puts the call on its own line between the directives.
    const opens = PRAGMA_START_RE.test(line);
    const closes = PRAGMA_END_RE.test(line);

    const guarded = depth > 0;

    const match = line.match(CONSOLE_RE);
    const method = match?.[1];
    const permanentlyVisible = method === "error";

    // Only console.warn may use the explicit marker. Errors are already
    // permanent by method, while log, debug, and info calls are removable
    // diagnostics and must not survive production merely because a marker was
    // copied nearby. Requiring a standalone comment immediately above the call
    // also prevents message text from granting its own exemption.
    const allowed =
      method === "warn" && i > 0 && ALLOW_MARKER_RE.test(lines[i - 1]);

    if (
      match &&
      !guarded &&
      !isCommentLine &&
      !permanentlyVisible &&
      !allowed
    ) {
      offenders.push({
        file: relPath,
        line: i + 1,
        text: line.trim(),
        method: match[0],
      });
    }

    if (opens) {
      depth++;
    }
    if (closes && depth > 0) {
      depth--;
    }
  }

  return offenders;
}

async function main() {
  const files = await collectFiles(SCAN_DIR);
  const allOffenders = [];

  for (const file of files) {
    const source = await fs.readFile(file, "utf8");
    const relPath = path.relative(ROOT, file).replace(/\\/g, "/");
    allOffenders.push(...findOffenders(source, relPath));
  }

  if (emitJson) {
    process.stdout.write(
      `${JSON.stringify(
        { offenderCount: allOffenders.length, offenders: allOffenders },
        null,
        2,
      )}\n`,
    );
  } else if (allOffenders.length === 0) {
    console.log(
      `lint-debug-pragmas: clean — ${files.length} files scanned, no unguarded debug console calls.`,
    );
  } else {
    console.log(
      `lint-debug-pragmas: ${allOffenders.length} unguarded debug console call(s) found in ${files.length} files scanned.`,
    );
    console.log(
      "(per-frame/init/informational logs must be wrapped in //>>includeStart('debug', pragmas.debug) ... //>>includeEnd('debug'))\n",
    );
    for (const o of allOffenders) {
      console.log(`${o.file}:${o.line}  ${o.text}`);
    }
  }

  process.exit(allOffenders.length === 0 ? 0 : 1);
}

const isDirectInvocation =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectInvocation) {
  main().catch((err) => {
    console.error(err);
    process.exit(2);
  });
}
