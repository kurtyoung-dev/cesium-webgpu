// runtime-residency-contract.mjs — DX-02, the anti-re-accretion contract for
// probes resident on the shared probe runtime.
//
// @purpose Detects a probe that declares @runtime residency on lib/probe-runtime.mjs yet still hand-rolls one of the four concerns that module already owns.
// @status ACTIVE
//
// WHAT THIS CLOSES. `DX-01` (Batch 1377) gave the fleet one runtime that owns
// argv parsing, the served-build preflight, the single-Edge-slot lock, the
// refusal/incident writer and the receipt writer — `lib/probe-runtime.mjs`,
// `lib/probe-refusal.mjs` and `lib/probe-edge-slot.mjs`. Landing the runtime
// does not, by itself, stop a future probe from re-growing a private copy of
// any of those four concerns beside a `runProbe(` call that already handles
// them; that is exactly how the fleet reached 682 private `chromium.launch(`
// sites and 91 private `sha256`s in the first place (DX-01's own census). This
// module is the detector: given one probe's source, it says whether the probe
// claims residency, and if it does, which of the four concerns it re-rolled
// anyway.
//
// THE TAG IS THE CENSUS FOR THE FOUR-CONCERN SCAN. A probe declares residency
// with `@runtime lib/probe-runtime.mjs` in its `@purpose` header block (the
// same block `Tools/lib/purpose-header.mjs` already locates for `@purpose`
// and `@status` — `runtime` is deliberately kept OUT of that shared
// grammar's tag vocabulary rather than added to it: the tag only needs to be
// discoverable by this contract, and three other consumers reading a name
// they do not act on is a cost with no matching benefit). The four-concern
// scan below runs only for a tag-declared resident: scanning every import
// instead would silently enroll every probe DX-06 has not yet migrated the
// moment it happens to import one runtime helper for an unrelated reason
// (`sha256`, `captureElement`), and would silently un-enroll a probe that
// migrated but forgot to update a stale import path. The tag is what a
// reviewer wrote down on purpose, so it is what the four-concern census
// counts.
//
// ONE IMPORT IS NOT INCIDENTAL, THOUGH: `runProbe`. Nothing calls a shared
// runtime's own entry point by accident — a file that imports the `runProbe`
// binding from `lib/probe-runtime.mjs` is already running through it, tag or
// no tag. So that one import gets its own check, independent of the
// four-concern scan and of the tag-gated `resident` flag: a file that imports
// `runProbe` from `lib/probe-runtime.mjs` without declaring the tag reports
// `missing-runtime-tag`. This is what stops a `DX-06` batch from migrating a
// probe onto the runtime and forgetting the header line — the migration
// itself, not just a hand-rolled concern beside it, is what the tag exists to
// record.
//
// COMMENTS DO NOT COUNT. `probe-globe-cold-start-readiness.mjs` — the pilot
// probe this contract was proven against — narrates its own pre-migration
// shape in prose: "the last good `globe-cold-start-report.json` survived" is
// a sentence in a header comment, not a file write. A scan of raw source text
// would flag that sentence as a hand-rolled receipt writer and make the one
// clean resident probe fail its own contract. Every forbidden-pattern check
// below therefore runs over `canonicalizeCode()` (`Tools/c16/lib/comment-
// scanner.mjs`, the one tokenizer the C16 remediation already uses to tell
// comment from code) rather than raw source: non-semantic comments collapse
// to a single space, string and template literals stay verbatim, and code
// stays code. `Tools/visual-regression/lib/probe-fleet-contract.mjs` already
// carries its own `blankNonCode` for the INVERSE problem — keeping a contract
// keyword inside a string from being misread as a construct — which blanks
// string interiors and would erase the very payload this contract needs to
// read (`{ flag: "wx" }`'s `"wx"` IS the finding). The two functions solve
// opposite problems and neither substitutes for the other.
//
// FOUR CONCERNS, FOUR PATTERNS. Each pattern targets the one technique the
// real implementation uses that a probe has no ordinary reason to duplicate:
//   - served-build preflight / sha256: importing `createHash` from
//     `node:crypto` directly. A resident probe's only hashing need is
//     `sha256()`, re-exported by the runtime; the preflight itself already
//     runs inside `runProbe`.
//   - the Edge-slot lock: the exclusive-create write (`{ flag: "wx" }`) or a
//     literal reference to the lock file itself
//     (`Tools/visual-regression/output/.edge-slot.lock`) instead of calling
//     the `acquireEdgeSlot()` export `probe-edge-slot.mjs` provides for
//     taking it — importing `probe-edge-slot.mjs` is the compliant path and
//     must not itself be flagged.
//   - the refusal/incident writer: a locally declared `class ... extends
//     Error` shaped like `ProbeRefusal`, or a literal `-refusal.json` /
//     `-error.json` filename — the two artifacts `runProbe` writes for a
//     non-measuring run, and never anything a probe itself should construct.
//   - the receipt writer: a literal `-report.json`, `-summary.md` or
//     `-runtime.json` filename — the three artifacts `runProbe` writes for a
//     measured run.
// A resident probe declares its cells and lets `runProbe` do the rest; none
// of those four filename or technique shapes should appear in one at all.

import { canonicalizeCode } from "../../c16/lib/comment-scanner.mjs";
import {
  commentText,
  locateHeaderBlock,
  splitLines,
} from "../../lib/purpose-header.mjs";

/** The one runtime this contract recognizes (`DX-01`). Add-only if a second one is ever ratified. */
export const RUNTIME_MODULE = "lib/probe-runtime.mjs";

/**
 * The vocabulary an `@runtime` tag may carry: the runtime it is resident on,
 * or an explicit statement that it carries none yet. Absence of the tag is
 * also legal — most of the fleet predates `DX-01` and migrating it is
 * `DX-06`'s job, not this contract's.
 */
export const RUNTIME_TAG_VALUES = Object.freeze([RUNTIME_MODULE, "none"]);

/**
 * Read the `@runtime` tag out of a probe's header comment block, if present.
 * Deliberately independent of `Tools/lib/purpose-header.mjs`'s own tag
 * vocabulary (see the module header) while still reusing its header-block
 * locator, so a `@runtime` line living anywhere outside the file's first
 * comment block does not count — same fail-closed reasoning `@purpose` and
 * `@status` already use.
 *
 * @param {string} source File text.
 * @returns {{value: string|null, line: number|null}} The tag's value, or `null` when absent.
 */
export function parseRuntimeTag(source) {
  const lines = splitLines(source);
  const block = locateHeaderBlock(lines);
  if (block.start < 0) {
    return { value: null, line: null };
  }
  for (let i = block.start; i <= block.end && i < lines.length; i++) {
    const text = commentText(lines[i].text);
    const m = /^@runtime\s+(.+)$/.exec(text);
    if (m !== null) {
      return { value: m[1].trim(), line: i };
    }
  }
  return { value: null, line: null };
}

/**
 * The four concerns `lib/probe-runtime.mjs` owns, and the code shape a
 * resident probe leaves behind if it re-implements one anyway.
 */
export const RUNTIME_CONCERNS = Object.freeze([
  {
    id: "own-hash-or-preflight",
    description:
      "imports node:crypto's createHash directly instead of the runtime's sha256 / served-build preflight",
    pattern:
      /import\s*\{[^}]*\bcreateHash\b[^}]*\}\s*from\s*["']node:crypto["']/,
  },
  {
    id: "own-edge-slot-lock",
    description:
      "writes its own exclusive-create Edge-slot lock instead of calling acquireEdgeSlot",
    pattern: /\{\s*flag:\s*["']wx["']\s*\}|\.edge-slot\.lock/,
  },
  {
    id: "own-refusal-or-incident-writer",
    description:
      "declares its own Refusal-shaped error class, or writes a *-refusal.json / *-error.json incident file, instead of ProbeRefusal / runProbe",
    pattern:
      /class\s+\w*Refusal\w*\s+extends\s+Error|-refusal\.json|-error\.json/,
  },
  {
    id: "own-receipt-writer",
    description:
      "writes its own *-report.json / *-summary.md / *-runtime.json instead of letting runProbe assemble the receipt",
    pattern: /-report\.json|-summary\.md|-runtime\.json/,
  },
]);

const RUNTIME_IMPORT_PATTERN =
  /from\s*["'](?:\.\/)?lib\/probe-runtime\.mjs["']/;
const RUN_PROBE_CALL_PATTERN = /\brunProbe\s*\(/;

/**
 * A named import of `runProbe` specifically, not any import from the
 * runtime. Keyed this narrowly so a file pulling in `sha256` or
 * `captureElement` for an unrelated reason does not read as residency.
 */
const RUN_PROBE_IMPORT_PATTERN =
  /import\s*\{[^}]*\brunProbe\b[^}]*\}\s*from\s*["'](?:\.\/)?lib\/probe-runtime\.mjs["']/;

/**
 * Analyze one probe's source for the anti-re-accretion contract.
 *
 * A file that does not declare residency is out of scope for the
 * four-concern scan — migrating it onto the runtime is `DX-06`'s job, and
 * this contract has nothing to say about which of the four concerns a probe
 * that has not claimed residency yet happens to contain. The one exception is
 * a named `runProbe` import: that is not an incidental reuse of a runtime
 * helper, so a file importing it without the tag still reports
 * `missing-runtime-tag`.
 *
 * @param {string} source File text.
 * @returns {{runtimeTag: string|null, resident: boolean, violations: Array<{id: string, message: string}>}} The analysis.
 */
export function analyzeRuntimeResidency(source) {
  const runtimeTag = parseRuntimeTag(source);
  const violations = [];

  if (
    runtimeTag.value !== null &&
    !RUNTIME_TAG_VALUES.includes(runtimeTag.value)
  ) {
    violations.push({
      id: "unknown-runtime-tag",
      message: `@runtime "${runtimeTag.value}" is not one of ${RUNTIME_TAG_VALUES.join(" | ")}`,
    });
  }

  const resident = runtimeTag.value === RUNTIME_MODULE;
  const code = canonicalizeCode(source, "js");

  if (!resident) {
    if (RUN_PROBE_IMPORT_PATTERN.test(code)) {
      violations.push({
        id: "missing-runtime-tag",
        message: `imports runProbe from ${RUNTIME_MODULE} but does not declare @runtime ${RUNTIME_MODULE}`,
      });
    }
    return { runtimeTag: runtimeTag.value, resident, violations };
  }

  if (!RUNTIME_IMPORT_PATTERN.test(code)) {
    violations.push({
      id: "residency-without-import",
      message: `declares @runtime ${RUNTIME_MODULE} but does not import from it`,
    });
  } else if (!RUN_PROBE_CALL_PATTERN.test(code)) {
    violations.push({
      id: "residency-without-runProbe-call",
      message: `declares @runtime ${RUNTIME_MODULE} but never calls runProbe(`,
    });
  }

  for (const concern of RUNTIME_CONCERNS) {
    if (concern.pattern.test(code)) {
      violations.push({ id: concern.id, message: concern.description });
    }
  }

  return { runtimeTag: runtimeTag.value, resident, violations };
}
