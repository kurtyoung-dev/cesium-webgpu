// probe-runtime-governance.mjs — the runtime-governance detectors behind the
// probe-fleet census. Pure Node source analysis: no browser, no network, no GPU.
//
// @purpose C13-N01 stage 1 detectors: read whether a probe resolves its origin from a hard-coded fallback and whether it routes through the three governance modules, and census the fleet from those two facts.
// @status ACTIVE
//
// THE BEHAVIOUR THIS READS, AND WHY IT IS WORTH COUNTING. `probe-runtime.mjs`
// exists because the parts of a probe run that must be identical everywhere
// were copied into hundreds of files instead: its own header records 682
// probes launching Edge themselves and names the three costs — "a probe that
// forgets the served-build preflight measures a bundle the page never loaded,
// a probe that forgets the origin guard silently lands on the maintainer's
// live 8080 server, and a probe that scores a refusal as a measurement reports
// a number it never took." The first and third are guarded by
// `served-build-preflight.mjs` and by the runtime's refusal path; the second is
// guarded by `decideOriginRefusal`, and the construct that defeats it is
// exactly `process.env.PROBE_BASE || "http://localhost:8080"`: when the
// variable is unset the probe does not refuse, it quietly measures whatever is
// already listening on that port.
//
// SO THE TWO DETECTORS ARE BEHAVIOURAL, NOT SHAPED AFTER THE ROUTING WORK.
// One reads "this file resolves an origin from an environment variable with a
// hard-coded fallback, so an unset variable produces a silent measurement
// rather than a refusal". The other reads "this file imports one of the three
// governance modules, so the governed behaviour reaches it at all". Neither
// asks whether a probe has been rewritten into the runtime's descriptor shape —
// that is the stage-2 routing question, and a detector that asked it would go
// green on a file whose behaviour had not changed.
//
// THIS MODULE ENFORCES NOTHING. It is a census instrument. The fleet-contract
// allowlist (`lib/probe-fleet-contract-allowlist.mjs`) is flat, frozen and
// shrink-only, with 43 cloud/god-ray probes pinned on watchdog-only reasons, so
// a new ENFORCED violation class would either turn ~60 files red at once or
// require rewriting 43 pinned reason strings. The ratchet in
// `probe-fleet-contract.spec.mjs` section H therefore pins the DIRECTION of
// these counts against a dated snapshot, and the routing that moves them is
// C13-N01 stage 2.
//
// PROSE IS NOT THE CONSTRUCT. Every probe's usage comment spells
// `PROBE_BASE=http://localhost:8080`, and probes ship page scripts as embedded
// text. Both would fool a grep, so both detectors read the
// COMMENT-AND-STRING-BLANKED view from `blankNonCode` and recover the literal
// they need from `stringLiteralSpans` — the same split the watchdog and verdict
// detectors in `probe-fleet-contract.mjs` already use, for the same reason.
//
// CRLF: this repo checks out with `core.autocrlf=true`. `blankNonCode`
// normalizes line endings before any offset arithmetic, and line numbers here
// are computed from that same normalized view.

import { blankNonCode, stringLiteralSpans } from "./probe-fleet-contract.mjs";

/**
 * The three modules that own governed probe behaviour, keyed by the exact
 * basename an import specifier has to end in.
 *
 * Exact basenames, not substrings: `lib/` also holds
 * `runtime-residency-contract.mjs` and `runtime-residency-allowlist.mjs`, and a
 * detector matching "runtime" would read those as adoption.
 */
export const GOVERNANCE_MODULES = Object.freeze({
  "probe-runtime.mjs": "runtime",
  "probe-edge-slot.mjs": "edge-slot",
  "served-build-preflight.mjs": "served-build-preflight",
});

/** An origin literal is one that names a scheme and a host. */
const ORIGIN_LITERAL = /^https?:\/\/\S/;

/**
 * `process.env.NAME` followed by a nullish/OR fallback whose right operand
 * opens a string literal. The literal's own text is blanked in the code view,
 * so the quote character is the anchor and `stringLiteralSpans` supplies the
 * content.
 */
const ENV_FALLBACK =
  /process\.env\.([A-Za-z_$][\w$]*)\s*(\|\||\?\?)\s*(["'`])/g;

/** A static `import ... from "<specifier>"`, up to the specifier's quote. */
const STATIC_IMPORT = /\bimport\b[^;()]*?\bfrom\s*(["'`])/g;

/** A dynamic `import("<specifier>")`, up to the specifier's quote. */
const DYNAMIC_IMPORT = /\bimport\s*\(\s*(["'`])/g;

/**
 * One-based line number of an offset in the normalized code view.
 *
 * @param {string} code Normalized, comment-and-string-blanked source.
 * @param {number} index Offset into that view.
 * @returns {number} Line number.
 */
function lineOf(code, index) {
  let line = 1;
  for (let i = 0; i < index && i < code.length; i += 1) {
    if (code[i] === "\n") {
      line += 1;
    }
  }
  return line;
}

/**
 * Index the literal spans by the offset of their opening quote, so a detector
 * that has found a quote in the code view can read what was inside it.
 *
 * @param {string} source Raw file text.
 * @returns {Map<number, string>} Opening-quote offset to literal content.
 */
function literalsByOpeningQuote(source) {
  const byStart = new Map();
  for (const span of stringLiteralSpans(source)) {
    byStart.set(span.start, span.content);
  }
  return byStart;
}

/**
 * Sites where a file resolves an origin from an environment variable with a
 * hard-coded fallback.
 *
 * The fallback is what makes it a finding: with it, an unset variable is a
 * silent measurement of whatever already listens on that port; without it, the
 * unset variable reaches the runtime's origin refusal.
 *
 * @param {string} source Raw file text.
 * @returns {Array<{env: string, operator: string, origin: string, line: number}>}
 *   Sites, in source order.
 */
export function hardDefaultedOrigins(source) {
  const code = blankNonCode(source);
  const literals = literalsByOpeningQuote(source);
  const sites = [];

  for (const match of code.matchAll(ENV_FALLBACK)) {
    const quoteIndex = match.index + match[0].length - 1;
    const content = literals.get(quoteIndex);
    if (content === undefined || !ORIGIN_LITERAL.test(content)) {
      continue;
    }
    sites.push({
      env: match[1],
      operator: match[2],
      origin: content,
      line: lineOf(code, match.index),
    });
  }

  return sites;
}

/**
 * Imports of the three governance modules.
 *
 * Static and dynamic forms both count, because both make the governed
 * behaviour reachable. A mention in a comment or inside a string does not,
 * because it does not.
 *
 * @param {string} source Raw file text.
 * @returns {Array<{module: string, specifier: string, line: number}>} Imports,
 *   in source order.
 */
export function governanceImports(source) {
  const code = blankNonCode(source);
  const literals = literalsByOpeningQuote(source);
  const found = [];

  for (const pattern of [STATIC_IMPORT, DYNAMIC_IMPORT]) {
    for (const match of code.matchAll(pattern)) {
      const quoteIndex = match.index + match[0].length - 1;
      const specifier = literals.get(quoteIndex);
      if (specifier === undefined) {
        continue;
      }
      const basename = specifier.split("/").pop();
      const module = GOVERNANCE_MODULES[basename];
      if (module === undefined) {
        continue;
      }
      found.push({ module, specifier, line: lineOf(code, match.index) });
    }
  }

  return found.sort((a, b) => a.line - b.line);
}

/**
 * Both facts about one file.
 *
 * @param {string} source Raw file text.
 * @returns {{hardDefaultedOrigins: Array<object>, governanceImports: Array<object>,
 *   hardDefaultsOrigin: boolean, adoptsGovernance: boolean, governedBy: string[]}}
 *   Analysis.
 */
export function analyzeRuntimeGovernance(source) {
  const origins = hardDefaultedOrigins(source);
  const imports = governanceImports(source);
  return {
    hardDefaultedOrigins: origins,
    governanceImports: imports,
    hardDefaultsOrigin: origins.length > 0,
    adoptsGovernance: imports.length > 0,
    governedBy: [...new Set(imports.map((entry) => entry.module))].sort(),
  };
}

/**
 * Fold per-file analyses into the census the C13-N01 stage-1 bar is stated in.
 *
 * `analyzed` is reported alongside the two counts on purpose: a detector that
 * stops recognising its constructs reports two zeros, which reads like a
 * repaired fleet. The population size is what tells those apart.
 *
 * @param {Iterable<{name: string, analysis: object}>} entries Per-file analyses.
 * @returns {{analyzed: number, hardDefaulting: number, adopting: number,
 *   hardDefaultingFiles: string[], adoptingFiles: string[],
 *   byModule: Record<string, number>}} Census.
 */
export function censusRuntimeGovernance(entries) {
  const hardDefaultingFiles = [];
  const adoptingFiles = [];
  const byModule = Object.fromEntries(
    Object.values(GOVERNANCE_MODULES).map((module) => [module, 0]),
  );
  let analyzed = 0;

  for (const { name, analysis } of entries) {
    analyzed += 1;
    if (analysis.hardDefaultsOrigin) {
      hardDefaultingFiles.push(name);
    }
    if (analysis.adoptsGovernance) {
      adoptingFiles.push(name);
      for (const module of analysis.governedBy) {
        byModule[module] += 1;
      }
    }
  }

  hardDefaultingFiles.sort();
  adoptingFiles.sort();

  return {
    analyzed,
    hardDefaulting: hardDefaultingFiles.length,
    adopting: adoptingFiles.length,
    hardDefaultingFiles,
    adoptingFiles,
    byModule,
  };
}
