/**
 * Runtime WGSL preprocessor extending Cesium's existing `//>>` pragma
 * style with `//>>ifdef`, `//>>else`, and `//>>endif` conditional
 * compilation directives. Runs before `device.createShaderModule`
 * and emits valid WGSL with directive blocks expanded against an
 * active-defines bitmask.
 *
 * # Why comment-style directives
 *
 * WGSL has no native preprocessor. The two common alternatives —
 * `#ifdef`-style or WGSL-attribute-style (`@if(...)`) — both produce
 * source that is *invalid WGSL* before preprocessing, which breaks IDE
 * plugins, linters, and any tool that reads the raw `.wgsl` file. The
 * `//>>` prefix piggybacks on the same pattern Cesium already uses for
 * `//>>includeStart('debug', pragmas.debug)` — raw source is always
 * valid WGSL (comments are ignored by the compiler) and tooling that
 * doesn't know about the preprocessor still parses the file.
 *
 * # Directive syntax
 *
 * Directives are line-oriented. Each directive consumes its entire
 * line; directive lines never appear in the output.
 *
 *     //>>ifdef FLAG_NAME
 *     <wgsl emitted only when (defines & ShaderDefine.FLAG_NAME) != 0>
 *     //>>else                            (optional)
 *     <wgsl emitted only when the ifdef was false>
 *     //>>endif
 *
 * Nesting is supported to arbitrary depth. Flag names must be
 * registered in `WebGPUShaderDefines.ShaderDefine` (lo word) or
 * `ShaderDefineHi` (hi word); unknown names throw
 * at preprocess time (better to fail loudly than silently emit the
 * wrong branch). A hi-word flag tests against the `definesHi`
 * argument; legacy 1-/2-arg callers implicitly pass `definesHi = 0`,
 * so a hi-gated block correctly emits its `//>>else` branch for them.
 *
 * # Purity
 *
 * `preprocess(source, defines, definesHi)` is a pure function: same
 * inputs always produce byte-identical output. In particular,
 * `preprocess(source, defines, 0)` is byte-identical to the historical
 * two-argument `preprocess(source, defines)`. Callers cache results in
 * `WebGPUShaderModuleCache`; the preprocessor itself has no cache
 * concept.
 *
 * @private
 * @module WebGPUShaderPreprocessor
 */

import {
  resolveDefineBit,
  resolveDefineBitHi,
  type ShaderDefineLoMask,
} from "./WebGPUShaderDefines.js";

// Directive lines look like:
//   //>>ifdef FLAG_NAME
//   //>>else
//   //>>endif
// Leading whitespace is allowed (authors may indent inside blocks for
// readability). Flag names are uppercase identifiers with underscores;
// the pattern rejects lowercase so a typo like `//>>ifdef foo` is an
// immediate parser error rather than a silent-false match.
const DIRECTIVE_PATTERN =
  /^\s*\/\/>>\s*(ifdef|else|endif)(?:\s+([A-Z_][A-Z0-9_]*))?\s*$/;

interface Frame {
  conditionWasTrue: boolean;
  inElse: boolean;
  startLine: number;
}

/**
 * Preprocess a WGSL source string against an active-defines bitmask.
 *
 * @param source Raw WGSL source (as imported from a `.wgsl` module;
 *   debug pragmas already stripped at build time for release builds).
 * @param defines Active LO-word defines bitmask. Each set bit
 *   corresponds to an entry in `ShaderDefine` and enables the matching
 *   `//>>ifdef` block. Pass `0` for "no conditional blocks active."
 *   Typed as `ShaderDefineLoMask` so a branded `ShaderDefineHi` bit
 *   passed here is a compile error (it would silently test false).
 * @param definesHi Active hi-word defines bitmask.
 *   Each set bit corresponds to an entry in `ShaderDefineHi`. Defaults
 *   to `0`, which leaves a lo-only call site's output unchanged.
 * @returns Preprocessed WGSL, ready for `device.createShaderModule`.
 * @throws {Error} when the source contains an unknown `//>>ifdef FLAG`
 *   (registered in neither word's registry), an unbalanced directive
 *   (extra `//>>endif`, unclosed `//>>ifdef`), or a duplicate
 *   `//>>else` within a single block. Errors carry the offending line
 *   number.
 */
export function preprocess(
  source: string,
  defines: ShaderDefineLoMask,
  definesHi: number = 0,
): string {
  const lines = source.split("\n");
  const output: string[] = [];
  const stack: Frame[] = [];

  // Walk the frame stack to decide whether the current line should be
  // emitted. O(depth) per call; depth is almost always ≤2 in practice.
  const shouldEmit = (): boolean => {
    for (let f = 0; f < stack.length; f++) {
      const frame = stack[f];
      const branchEmitting = frame.inElse
        ? !frame.conditionWasTrue
        : frame.conditionWasTrue;
      if (!branchEmitting) return false;
    }
    return true;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const m = line.match(DIRECTIVE_PATTERN);

    if (m) {
      const directive = m[1];
      const flag = m[2];

      if (directive === "ifdef") {
        if (flag === undefined) {
          throw new Error(
            `WGSL preprocessor: //>>ifdef at line ${i + 1} missing flag name`,
          );
        }
        // Probe the hi-word registry first: the lo resolver
        // `resolveDefineBit` deliberately throws on a hi-word name, so a
        // hi flag must never reach it. The hi table is tiny, so this is
        // one failed property lookup per lo-flag directive — and the
        // preprocessor result is cached per (source, defines, definesHi)
        // by the module cache, so none of this is hot.
        let conditionWasTrue: boolean;
        const hiBit = resolveDefineBitHi(flag);
        if (hiBit !== undefined) {
          conditionWasTrue = (definesHi & hiBit) !== 0;
        } else {
          const bit = resolveDefineBit(flag);
          if (bit === undefined) {
            throw new Error(
              `WGSL preprocessor: unknown define "${flag}" at line ${i + 1}. ` +
                `Register it in WebGPUShaderDefines.ShaderDefine (lo word) ` +
                `or ShaderDefineHi (hi word) before use.`,
            );
          }
          conditionWasTrue = (defines & bit) !== 0;
        }
        stack.push({
          conditionWasTrue,
          inElse: false,
          startLine: i + 1,
        });
      } else if (directive === "else") {
        if (stack.length === 0) {
          throw new Error(
            `WGSL preprocessor: //>>else at line ${i + 1} without matching //>>ifdef`,
          );
        }
        const top = stack[stack.length - 1];
        if (top.inElse) {
          throw new Error(
            `WGSL preprocessor: duplicate //>>else at line ${i + 1} ` +
              `(ifdef opened at line ${top.startLine})`,
          );
        }
        top.inElse = true;
      } else if (directive === "endif") {
        if (stack.length === 0) {
          throw new Error(
            `WGSL preprocessor: //>>endif at line ${i + 1} without matching //>>ifdef`,
          );
        }
        stack.pop();
      }
      // Directive lines are consumed; never emitted to output.
      continue;
    }

    if (shouldEmit()) {
      output.push(line);
    }
  }

  if (stack.length > 0) {
    const top = stack[stack.length - 1];
    throw new Error(
      `WGSL preprocessor: unclosed //>>ifdef opened at line ${top.startLine}`,
    );
  }

  return output.join("\n");
}
