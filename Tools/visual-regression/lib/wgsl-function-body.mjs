// wgsl-function-body.mjs — replace one WGSL function's body in a source text.
//
// @purpose Builds an inertness mutant of a shader helper by swapping the whole body of a named WGSL function, so a mutant does not depend on the helper's current wording.
// @status ACTIVE

import assert from "node:assert/strict";

/**
 * Replace one function's body in a WGSL text, so a mutant is a whole-helper
 * revert that does not depend on the helper's current wording.
 *
 * @param {string} source WGSL text.
 * @param {string} name Function name.
 * @param {string} newBody Replacement body (without braces).
 * @returns {string} The mutated text.
 */
export function replaceFunctionBody(source, name, newBody) {
  const at = source.search(new RegExp(`\\bfn\\s+${name}\\s*\\(`));
  assert.ok(at >= 0, `mutation target ${name} not found`);
  let depth = 0;
  let i = source.indexOf("(", at);
  for (; i < source.length; i += 1) {
    if (source[i] === "(") depth += 1;
    else if (source[i] === ")" && --depth === 0) break;
  }
  const open = source.indexOf("{", i);
  depth = 0;
  let close = open;
  for (; close < source.length; close += 1) {
    if (source[close] === "{") depth += 1;
    else if (source[close] === "}" && --depth === 0) break;
  }
  return `${source.slice(0, open + 1)}\n${newBody}\n${source.slice(close)}`;
}
