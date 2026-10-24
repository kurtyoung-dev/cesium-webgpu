// water-spec-mutants.mjs — the one inertness-mutant helper the water specs share.
// @purpose Applies exact-once anchor replacements to a source string (CRLF read as LF) so a water spec can show that the clause it pins goes red when a call site is made unreachable, and runs the same check against the mutant.
// @status ACTIVE
//
// WHY THIS EXISTS. The water specs read engine and shader source as text, and a text
// pin keeps passing after the pinned code is dead: replacing every use of
// `flightToSurfaceHandover` with `0.0` left the old regex green. A check is only
// evidence for a feature when the same check, run on a copy whose call site was
// made unreachable (`if (false && x)`, or the call replaced by a constant), fails.
//
// THE ANCHOR MUST OCCUR EXACTLY ONCE, as in lib/import-mutated.mjs: an anchor that
// matched nothing would leave the source unchanged and the "mutant" would pass for
// the wrong reason. The mutation is applied to a string in memory; no file is
// written, so there is nothing to restore.

import assert from "node:assert/strict";
import fs from "node:fs";

/**
 * @param {string} source Source text; CRLF is read as LF.
 * @param {Array<[string, string]>} replacements `[anchor, replacement]` pairs, applied in order.
 * @returns {string} The mutated text.
 * @throws {Error} When an anchor occurs zero times or more than once.
 */
export function applyAnchors(source, replacements) {
  let text = source.replace(/\r\n/g, "\n");
  for (const [anchor, replacement] of replacements) {
    const count = text.split(anchor).length - 1;
    if (count !== 1) {
      throw new Error(
        `applyAnchors: the anchor must occur exactly once, found ${count}: ${anchor.slice(0, 80)}`,
      );
    }
    text = text.replace(anchor, () => replacement);
  }
  return text;
}

/** @param {string} file Absolute path. @returns {string} The file read as UTF-8 with CRLF read as LF. */
export function readLf(file) {
  return fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n");
}

/**
 * Assert that `check` passes on the real source and throws on the mutant.
 *
 * @param {string} name Feature name, used in the failure message.
 * @param {string} source The real source text.
 * @param {Array<[string, string]> | ((text: string) => string)} mutation Anchors, or a
 *   function (for example `stripUses`), that make the call site unreachable.
 * @param {(text: string) => void} check The spec's own check, taking the source text.
 */
export function assertInertnessMutantTurnsRed(name, source, mutation, check) {
  assert.doesNotThrow(
    () => check(source.replace(/\r\n/g, "\n")),
    `${name}: the check must pass on the real source before a mutant means anything`,
  );
  const mutant =
    typeof mutation === "function"
      ? mutation(source.replace(/\r\n/g, "\n"))
      : applyAnchors(source, mutation);
  assert.notEqual(
    mutant,
    source.replace(/\r\n/g, "\n"),
    `${name}: the mutant must differ from the source`,
  );
  assert.throws(
    () => check(mutant),
    undefined,
    `${name}: the check must go red when the call site is unreachable`,
  );
}

const DEFINITION_PREFIX =
  /(?:\bfn|\blet|\bvar|\bconst|\bfunction|\bexport function)\s+$/;

function blankComments(source) {
  // Same length, so offsets stay valid: comments become spaces, newlines are kept.
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/\/\/[^\n]*/g, (m) => " ".repeat(m.length));
}

function useOffsets(source, name, asCall) {
  const code = blankComments(source.replace(/\r\n/g, "\n"));
  const pattern = new RegExp(
    String.raw`\b${name}\b${asCall ? String.raw`(?=\s*(?:<[^>]*>)?\s*\()` : ""}`,
    "g",
  );
  const offsets = [];
  for (const match of code.matchAll(pattern)) {
    if (!DEFINITION_PREFIX.test(code.slice(0, match.index))) {
      offsets.push(match.index);
    }
  }
  return { code, offsets };
}

/**
 * Number of places `name` is read or called, outside comments and outside its own
 * definition (`fn name`, `let name`, `const name`, `function name`).
 *
 * @param {string} source
 * @param {string} name An identifier.
 * @param {{ call?: boolean }} [options] `call: true` counts only `name(` sites.
 * @returns {number}
 */
export function countUses(source, name, { call = false } = {}) {
  return useOffsets(source, name, call).offsets.length;
}

/**
 * Replace every use of `name` (see `countUses`) with `replacement`; a call
 * replaces the whole `name(...)` expression. This is the "call site made
 * unreachable" mutant for a feature whose definition must stay valid.
 *
 * @param {string} source
 * @param {string} name
 * @param {string} replacement
 * @param {{ call?: boolean }} [options]
 * @returns {string}
 */
export function stripUses(source, name, replacement, { call = false } = {}) {
  const { code, offsets } = useOffsets(source, name, call);
  assert.ok(offsets.length > 0, `stripUses: no use of ${name} to remove`);
  let out = "";
  let cursor = 0;
  for (const start of offsets) {
    let end = start + name.length;
    if (call) {
      let i = code.indexOf("(", end);
      let depth = 0;
      for (; i < code.length; i++) {
        if (code[i] === "(") {
          depth++;
        } else if (code[i] === ")" && --depth === 0) {
          break;
        }
      }
      end = i + 1;
    }
    out += source.replace(/\r\n/g, "\n").slice(cursor, start) + replacement;
    cursor = end;
  }
  return out + source.replace(/\r\n/g, "\n").slice(cursor);
}

/**
 * The call-site check the water specs share: `name` must be used at least once
 * outside its definition, and no use may sit behind a constant-false guard.
 *
 * @param {string} source
 * @param {string} name
 * @param {string} what Feature name for the failure message.
 * @param {{ call?: boolean }} [options]
 */
export function assertCallSiteLive(source, name, what, options = {}) {
  assert.ok(
    countUses(source, name, options) >= 1,
    `${what}: ${name} is defined but never ${options.call ? "called" : "read"}`,
  );
  assert.doesNotMatch(
    blankComments(source),
    /\bfalse\s*&&/,
    `${what}: a constant-false guard makes a call site unreachable`,
  );
}
