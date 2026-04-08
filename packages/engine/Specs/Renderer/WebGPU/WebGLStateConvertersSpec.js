import {
  webglToWebGPUBlendFactor,
  webglToWebGPUBlendOp,
  webglToWebGPUCompareFunction,
} from "../../../Source/Renderer/WebGPU/WebGLStateConverters.js";

describe("Renderer/WebGPU/WebGLStateConverters", function () {
  // The converters are pure functions over WebGL enum constants. They
  // need no GPU device, no Cesium scene context, and no async setup —
  // exactly the kind of low-cost coverage we want a Karma run to give
  // us so that an accidental case-statement deletion fails fast in CI
  // instead of breaking the WebGL compatibility stub at runtime.

  describe("webglToWebGPUBlendFactor", function () {
    // Spot-check the canonical alpha-blending pair (the 99% case for
    // CesiumJS materials) plus a couple of less obvious mappings.
    it("maps GL_ZERO → 'zero'", function () {
      expect(webglToWebGPUBlendFactor(0)).toBe("zero");
    });

    it("maps GL_ONE → 'one'", function () {
      expect(webglToWebGPUBlendFactor(1)).toBe("one");
    });

    it("maps GL_SRC_ALPHA → 'src-alpha'", function () {
      expect(webglToWebGPUBlendFactor(0x0302)).toBe("src-alpha");
    });

    it("maps GL_ONE_MINUS_SRC_ALPHA → 'one-minus-src-alpha'", function () {
      expect(webglToWebGPUBlendFactor(0x0303)).toBe("one-minus-src-alpha");
    });

    it("maps GL_DST_COLOR → 'dst'", function () {
      expect(webglToWebGPUBlendFactor(0x0306)).toBe("dst");
    });

    it("maps GL_CONSTANT_COLOR → 'constant'", function () {
      expect(webglToWebGPUBlendFactor(0x8001)).toBe("constant");
    });

    it("maps GL_SRC_ALPHA_SATURATE → 'src-alpha-saturated'", function () {
      expect(webglToWebGPUBlendFactor(0x0308)).toBe("src-alpha-saturated");
    });

    it("defaults unknown enums to 'one'", function () {
      // 0xDEAD is intentionally not a real WebGL constant — proves the
      // default branch fires instead of throwing.
      expect(webglToWebGPUBlendFactor(0xdead)).toBe("one");
    });
  });

  describe("webglToWebGPUBlendOp", function () {
    it("maps GL_FUNC_ADD → 'add'", function () {
      expect(webglToWebGPUBlendOp(0x8006)).toBe("add");
    });

    it("maps GL_FUNC_SUBTRACT → 'subtract'", function () {
      expect(webglToWebGPUBlendOp(0x800a)).toBe("subtract");
    });

    it("maps GL_FUNC_REVERSE_SUBTRACT → 'reverse-subtract'", function () {
      expect(webglToWebGPUBlendOp(0x800b)).toBe("reverse-subtract");
    });

    it("maps GL_MIN → 'min'", function () {
      expect(webglToWebGPUBlendOp(0x8007)).toBe("min");
    });

    it("maps GL_MAX → 'max'", function () {
      expect(webglToWebGPUBlendOp(0x8008)).toBe("max");
    });

    it("defaults unknown enums to 'add'", function () {
      expect(webglToWebGPUBlendOp(0xdead)).toBe("add");
    });
  });

  describe("webglToWebGPUCompareFunction", function () {
    // The depth/stencil mapping is what makes the depth plane work
    // under the WebGPU stub — covering it here means a careless reorder
    // of the switch can't silently flip LEQUAL → LESS without a test
    // failure.
    it("maps GL_NEVER → 'never'", function () {
      expect(webglToWebGPUCompareFunction(0x0200)).toBe("never");
    });

    it("maps GL_LESS → 'less'", function () {
      expect(webglToWebGPUCompareFunction(0x0201)).toBe("less");
    });

    it("maps GL_EQUAL → 'equal'", function () {
      expect(webglToWebGPUCompareFunction(0x0202)).toBe("equal");
    });

    it("maps GL_LEQUAL → 'less-equal'", function () {
      expect(webglToWebGPUCompareFunction(0x0203)).toBe("less-equal");
    });

    it("maps GL_GREATER → 'greater'", function () {
      expect(webglToWebGPUCompareFunction(0x0204)).toBe("greater");
    });

    it("maps GL_NOTEQUAL → 'not-equal'", function () {
      expect(webglToWebGPUCompareFunction(0x0205)).toBe("not-equal");
    });

    it("maps GL_GEQUAL → 'greater-equal'", function () {
      expect(webglToWebGPUCompareFunction(0x0206)).toBe("greater-equal");
    });

    it("maps GL_ALWAYS → 'always'", function () {
      expect(webglToWebGPUCompareFunction(0x0207)).toBe("always");
    });

    it("defaults unknown enums to 'less'", function () {
      // 'less' is the safe default because it's the most common z-test;
      // an unknown enum dropping silently into 'always' or 'never' would
      // cause invisible-geometry or all-pass-through rendering bugs.
      expect(webglToWebGPUCompareFunction(0xdead)).toBe("less");
    });
  });
});
