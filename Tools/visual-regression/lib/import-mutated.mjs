// import-mutated.mjs — import an ES module from a mutated copy of its own
// source, for the inertness mutants a spec runs against the clause it pins.
// @purpose Load a module from its source with exact-once anchor replacements applied and its relative imports resolved to the original files, so a spec can show that the clause it pins goes red when that clause is made unreachable.
// @status ACTIVE
//
// WHY THIS EXISTS. An inertness control asks "if this branch were dead, would
// the test notice?" and answers it by importing the module with the branch
// made unreachable (`if (x)` -> `if (false && x)`) and running the same case.
// At `7e12d8f1d0`, twenty spec files directly under `Tools/visual-regression/`
// each define a private `importMutated*` loader for this, with differing
// signatures (anchor pairs, a mutate callback, a from/to pair), and the
// weather descriptor spec carried a twenty-first. This is a shared one, with
// the anchor-pairs signature; none of the twenty is migrated onto it here.
// The kit's existing mutation guard and data-URL importer are
// `lib/engine-stub-bundler.mjs`'s `mutateOrFail` and `bundle({ mutate })`,
// and neither fits: `bundle` builds through esbuild and stubs every import
// not on its allowlist, so a probe whose real runtime must load cannot go
// through it, and `mutateOrFail` only asserts that a rewrite changed
// something, where this loader asserts that each anchor occurs exactly once.
//
// WHAT IT DOES. Reads `file`, normalises CRLF to LF (the repository checks out
// with `core.autocrlf=true`, and an anchor written with `\n` must still match),
// rewrites every `from "./..."` / `from "../..."` specifier to the absolute
// file URL of the original target (a `data:` module has no directory to
// resolve `./` against), applies each `[anchor, replacement]` pair, and
// imports the result as a `data:` URL. Bare specifiers (`node:fs`,
// `playwright`) are left alone and resolve as the original would.
//
// THE ANCHOR MUST OCCUR EXACTLY ONCE. A mutation that matched nothing would
// leave the module unchanged and the control would "pass" without testing
// anything; one that matched twice would mutate a clause the spec did not
// name. Either throws, naming the count.
//
// THE REPLACEMENT IS LITERAL. `String.prototype.replace` reads `$&`, `$'`,
// `` $` `` and `$1` in a string replacement as patterns; a function
// replacement does not, so a replacement carrying a template literal or a
// dollar sign lands byte for byte.
//
// LIMITS. Only static `from "<relative>"` clauses are rewritten. A dynamic
// `import("./x")` or a side-effect `import "./x"` inside the mutated module
// still resolves against the `data:` URL and fails; no weather probe has one.

import fs from "node:fs";
import { pathToFileURL } from "node:url";

/**
 * Import `file` with each `[anchor, replacement]` applied to its source.
 *
 * @param {string} file Absolute path of the module to mutate.
 * @param {Array<[string, string]>} replacements Pairs applied in order; each
 *   anchor must occur exactly once in the source as it stands when its turn
 *   comes.
 * @returns {Promise<object>} The mutated module's namespace.
 * @throws {Error} When an anchor occurs zero times or more than once.
 */
export async function importMutated(file, replacements) {
  let source = fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n");
  const base = pathToFileURL(file);
  source = source.replace(
    /from "(\.[^"]*)"/g,
    (_match, specifier) => `from "${new URL(specifier, base).href}"`,
  );
  for (const [anchor, replacement] of replacements) {
    const count = source.split(anchor).length - 1;
    if (count !== 1) {
      throw new Error(
        `importMutated: the anchor must occur exactly once in ${file}, ` +
          `found ${count}: ${anchor.slice(0, 80)}`,
      );
    }
    source = source.replace(anchor, () => replacement);
  }
  return import(
    `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`
  );
}
