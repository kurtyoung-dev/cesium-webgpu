import { preprocess } from "../../../Source/Renderer/WebGPU/WebGPUShaderPreprocessor.js";
import {
  ShaderDefine,
  ShaderDefineHi,
} from "../../../Source/Renderer/WebGPU/WebGPUShaderDefines.js";

// NOTE ON THE FILE NAME: `WebGPUShaderPreprocessorSpec.js` already covers the
// WebGPUShaderTranslator PREPROCESSOR REGISTRY (a different module); this spec
// covers the `//>>ifdef` conditional-compilation preprocessor in
// `WebGPUShaderPreprocessor.ts`.
describe("Renderer/WebGPU/WebGPUShaderPreprocessor preprocess (//>>ifdef)", function () {
  // C11-149 / NEW-WEBGPU-SHADERDEFINE-WIDTH-EXPANSION widened
  // `preprocess(source, defines)` to `preprocess(source, defines, definesHi)`.
  // The ACCEPTANCE BAR for the widening is byte-identity: for every source
  // and every lo-word mask, the 3-arg call with `definesHi = 0` (and the
  // legacy 2-arg call, which defaults it) must emit EXACTLY what the
  // pre-widening implementation emitted. `referencePreprocess` below is the
  // pre-C11-149 algorithm reproduced verbatim (same directive regex, same
  // frame stack, same output join) with its lo-only registry lookup inlined,
  // so the sweep pins the widened function against the historical semantics
  // rather than against itself.

  /** The pre-C11-149 implementation, kept as the byte-identity oracle. */
  function referencePreprocess(source, defines) {
    const DIRECTIVE_PATTERN =
      /^\s*\/\/>>\s*(ifdef|else|endif)(?:\s+([A-Z_][A-Z0-9_]*))?\s*$/;
    const lines = source.split("\n");
    const output = [];
    const stack = [];
    const shouldEmit = function () {
      for (let f = 0; f < stack.length; f++) {
        const frame = stack[f];
        const branchEmitting = frame.inElse
          ? !frame.conditionWasTrue
          : frame.conditionWasTrue;
        if (!branchEmitting) {
          return false;
        }
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
          const bit = ShaderDefine[flag];
          if (bit === undefined) {
            throw new Error(`reference: unknown define "${flag}"`);
          }
          stack.push({
            conditionWasTrue: (defines & bit) !== 0,
            inElse: false,
            startLine: i + 1,
          });
        } else if (directive === "else") {
          stack[stack.length - 1].inElse = true;
        } else if (directive === "endif") {
          stack.pop();
        }
        continue;
      }
      if (shouldEmit()) {
        output.push(line);
      }
    }
    return output.join("\n");
  }

  const DIRECTIVE_FREE = ["// header", "fn main() {}", ""].join("\n");

  const LO_GATED = [
    "// prelude",
    "//>>ifdef LOG_DEPTH",
    "let logDepth = 1.0;",
    "//>>else",
    "let logDepth = 0.0;",
    "//>>endif",
    "fn main() {}",
  ].join("\n");

  const LO_NESTED = [
    "//>>ifdef SPLIT_ENABLED",
    "outer-then",
    "  //>>ifdef LOG_DEPTH",
    "inner-then",
    "  //>>else",
    "inner-else",
    "  //>>endif",
    "//>>else",
    "outer-else",
    "//>>endif",
    "tail",
  ].join("\n");

  const HI_GATED = [
    "head",
    "//>>ifdef HI_WORD_PROBE",
    "hi-then",
    "//>>else",
    "hi-else",
    "//>>endif",
    "tail",
  ].join("\n");

  const MIXED = [
    "//>>ifdef LOG_DEPTH",
    "lo-then",
    "//>>else",
    "lo-else",
    "//>>endif",
    "//>>ifdef HI_WORD_PROBE",
    "hi-then",
    "//>>else",
    "hi-else",
    "//>>endif",
  ].join("\n");

  const LO_SOURCES = [DIRECTIVE_FREE, LO_GATED, LO_NESTED];
  const LO_MASK_SWEEP = [
    0,
    ShaderDefine.LOG_DEPTH,
    ShaderDefine.SPLIT_ENABLED,
    ShaderDefine.LOG_DEPTH | ShaderDefine.SPLIT_ENABLED,
    ShaderDefine.GEODETIC_NORMAL,
    0x7fffffff,
    -1, // signed all-bits form: (-1 & bit) !== 0 for every bit, as before
  ];

  describe("hi=0 byte-identity with the pre-widening implementation", function () {
    it("emits byte-identical output for the legacy 2-arg call", function () {
      for (const source of LO_SOURCES) {
        for (const defines of LO_MASK_SWEEP) {
          expect(preprocess(source, defines)).toBe(
            referencePreprocess(source, defines),
          );
        }
      }
    });

    it("emits byte-identical output for the explicit 3-arg hi=0 call", function () {
      for (const source of LO_SOURCES) {
        for (const defines of LO_MASK_SWEEP) {
          expect(preprocess(source, defines, 0)).toBe(
            referencePreprocess(source, defines),
          );
        }
      }
    });

    it("defines=0 emits the //>>else branch of every block, byte-identically", function () {
      // The documented migration guarantee: defines=0 is byte-identical
      // to a source without ifdef blocks (else branches emitted).
      expect(preprocess(LO_GATED, 0, 0)).toBe(
        ["// prelude", "let logDepth = 0.0;", "fn main() {}"].join("\n"),
      );
    });
  });

  describe("hi-word resolution (C11-149)", function () {
    it("tests a hi-word flag against definesHi, not defines", function () {
      const on = preprocess(HI_GATED, 0, ShaderDefineHi.HI_WORD_PROBE);
      expect(on).toBe(["head", "hi-then", "tail"].join("\n"));
      const off = preprocess(HI_GATED, 0, 0);
      expect(off).toBe(["head", "hi-else", "tail"].join("\n"));
    });

    it("never lets the lo word satisfy a hi-word gate", function () {
      // Even an all-bits lo mask must not flip a hi-gated block: the two
      // words are distinct namespaces. (This is the silent-wrong-shader
      // failure mode the branded types + this runtime split prevent.)
      for (const defines of LO_MASK_SWEEP) {
        expect(preprocess(HI_GATED, defines, 0)).toBe(
          ["head", "hi-else", "tail"].join("\n"),
        );
      }
    });

    it("resolves lo and hi gates independently in one source", function () {
      expect(preprocess(MIXED, ShaderDefine.LOG_DEPTH, 0)).toBe(
        ["lo-then", "hi-else"].join("\n"),
      );
      expect(preprocess(MIXED, 0, ShaderDefineHi.HI_WORD_PROBE)).toBe(
        ["lo-else", "hi-then"].join("\n"),
      );
      expect(
        preprocess(MIXED, ShaderDefine.LOG_DEPTH, ShaderDefineHi.HI_WORD_PROBE),
      ).toBe(["lo-then", "hi-then"].join("\n"));
    });

    it("keeps hi-gated sources source-compatible with legacy 2-arg callers", function () {
      // A shader that grows a hi-gated block must remain preprocessable
      // by call sites that haven't opted into the hi word: they emit the
      // //>>else branch (definesHi defaults to 0), not a throw.
      expect(preprocess(HI_GATED, 0)).toBe(
        ["head", "hi-else", "tail"].join("\n"),
      );
    });
  });

  describe("error handling", function () {
    it("still throws for unknown flags, carrying the line number", function () {
      const src = ["ok", "//>>ifdef NOT_A_REAL_DEFINE", "x", "//>>endif"].join(
        "\n",
      );
      expect(function () {
        preprocess(src, 0, 0);
      }).toThrowError(/unknown define "NOT_A_REAL_DEFINE" at line 2/);
    });

    it("still throws for unbalanced directives", function () {
      expect(function () {
        preprocess("//>>ifdef LOG_DEPTH\nx", 0);
      }).toThrowError(/unclosed/);
      expect(function () {
        preprocess("//>>endif", 0);
      }).toThrowError(/without matching/);
      expect(function () {
        preprocess("//>>ifdef LOG_DEPTH\n//>>else\n//>>else\n//>>endif", 0);
      }).toThrowError(/duplicate/);
    });
  });
});
