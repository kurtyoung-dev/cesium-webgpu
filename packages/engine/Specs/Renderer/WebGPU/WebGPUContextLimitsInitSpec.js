import { initializeContextLimitsFromDevice } from "../../../Source/Renderer/WebGPU/WebGPUContextLimitsInit.js";
import ContextLimits from "../../../Source/Renderer/ContextLimits.js";

describe("Renderer/WebGPU/WebGPUContextLimitsInit", function () {
  // initializeContextLimitsFromDevice is a pure mapping from a
  // GPUDevice's `limits` bag onto the global ContextLimits module's
  // writable `_xxx` internals (exposed through public getters). It
  // never touches the GPU queue, never creates a pipeline/bind group,
  // and never reads from a live adapter — so a plain object with a
  // `limits` field stands in for the device with no Karma/WebGPU
  // dependency. We snapshot and restore the global ContextLimits
  // internals around every spec so this module-level mutation can't
  // leak into other specs.

  // The internal fields the module writes (mirrors ContextLimitsInternals
  // in the source and the `_xxx` keys ContextLimits.js declares).
  const internalKeys = [
    "_maximumTextureSize",
    "_maximumCubeMapSize",
    "_maximumRenderbufferSize",
    "_maximumTextureImageUnits",
    "_maximumVertexTextureImageUnits",
    "_maximumCombinedTextureImageUnits",
    "_maximumVertexAttributes",
    "_maximumViewportWidth",
    "_maximumViewportHeight",
    "_maximumFragmentUniformVectors",
    "_maximumVaryingVectors",
    "_maximumVertexUniformVectors",
    "_minimumAliasedLineWidth",
    "_maximumAliasedLineWidth",
    "_minimumAliasedPointSize",
    "_maximumAliasedPointSize",
    "_maximumTextureFilterAnisotropy",
    "_maximumDrawBuffers",
    "_maximumColorAttachments",
    "_maximumSamples",
    "_highpFloatSupported",
    "_highpIntSupported",
    "_maximum3DTextureSize",
    "_maximumArrayTextureLayers",
  ];

  let savedInternals;

  // Distinct, non-overlapping values so a swapped mapping (e.g. cube
  // map size accidentally fed from maxVertexAttributes) fails loudly.
  function makeFullLimits() {
    return {
      maxTextureDimension2D: 8192,
      maxSampledTexturesPerShaderStage: 16,
      maxVertexAttributes: 30,
      maxColorAttachments: 8,
      maxTextureDimension3D: 2048,
      maxTextureArrayLayers: 256,
    };
  }

  beforeEach(function () {
    savedInternals = {};
    for (const key of internalKeys) {
      savedInternals[key] = ContextLimits[key];
    }
  });

  afterEach(function () {
    for (const key of internalKeys) {
      ContextLimits[key] = savedInternals[key];
    }
  });

  describe("null / undefined device guard", function () {
    it("is a no-op for an undefined device", function () {
      // Poison every internal so a no-op leaves the poison untouched.
      for (const key of internalKeys) {
        ContextLimits[key] = -999;
      }
      initializeContextLimitsFromDevice(undefined);
      for (const key of internalKeys) {
        expect(ContextLimits[key]).toBe(-999);
      }
    });

    it("is a no-op for a null device", function () {
      for (const key of internalKeys) {
        ContextLimits[key] = -999;
      }
      initializeContextLimitsFromDevice(null);
      for (const key of internalKeys) {
        expect(ContextLimits[key]).toBe(-999);
      }
    });
  });

  describe("device-limit mapping (public getters)", function () {
    beforeEach(function () {
      initializeContextLimitsFromDevice({ limits: makeFullLimits() });
    });

    it("maps maxTextureDimension2D to texture / cubemap / renderbuffer / viewport", function () {
      expect(ContextLimits.maximumTextureSize).toBe(8192);
      expect(ContextLimits.maximumCubeMapSize).toBe(8192);
      expect(ContextLimits.maximumRenderbufferSize).toBe(8192);
      expect(ContextLimits.maximumViewportWidth).toBe(8192);
      expect(ContextLimits.maximumViewportHeight).toBe(8192);
    });

    it("maps maxSampledTexturesPerShaderStage to image-unit limits", function () {
      expect(ContextLimits.maximumTextureImageUnits).toBe(16);
      expect(ContextLimits.maximumVertexTextureImageUnits).toBe(16);
      // Combined is the per-stage count doubled (vertex + fragment).
      expect(ContextLimits.maximumCombinedTextureImageUnits).toBe(32);
    });

    it("maps maxVertexAttributes verbatim", function () {
      expect(ContextLimits.maximumVertexAttributes).toBe(30);
    });

    it("maps maxColorAttachments to draw-buffer and color-attachment limits", function () {
      expect(ContextLimits.maximumDrawBuffers).toBe(8);
      expect(ContextLimits.maximumColorAttachments).toBe(8);
    });

    it("maps maxTextureDimension3D verbatim", function () {
      expect(ContextLimits.maximum3DTextureSize).toBe(2048);
    });
  });

  describe("hard-coded WebGPU defaults", function () {
    beforeEach(function () {
      initializeContextLimitsFromDevice({ limits: makeFullLimits() });
    });

    it("pins the fixed uniform / varying vector counts", function () {
      expect(ContextLimits.maximumFragmentUniformVectors).toBe(1024);
      expect(ContextLimits.maximumVaryingVectors).toBe(31);
      expect(ContextLimits.maximumVertexUniformVectors).toBe(1024);
    });

    it("pins the fixed aliased line / point ranges to 1.0", function () {
      expect(ContextLimits.minimumAliasedLineWidth).toBe(1.0);
      expect(ContextLimits.maximumAliasedLineWidth).toBe(1.0);
      expect(ContextLimits.minimumAliasedPointSize).toBe(1.0);
      expect(ContextLimits.maximumAliasedPointSize).toBe(1.0);
    });

    it("pins anisotropy to 16.0 and samples to 4", function () {
      expect(ContextLimits.maximumTextureFilterAnisotropy).toBe(16.0);
      expect(ContextLimits.maximumSamples).toBe(4);
    });

    it("forces highp float / int support to true", function () {
      expect(ContextLimits.highpFloatSupported).toBe(true);
      expect(ContextLimits.highpIntSupported).toBe(true);
    });
  });

  describe("nullish-coalescing fallbacks (limits absent / undefined)", function () {
    // The mandatory WebGPU limits (texture dims, sampled textures,
    // vertex attributes) are always present per spec, so the module
    // only guards the three optional ones with `?? <default>`.
    beforeEach(function () {
      initializeContextLimitsFromDevice({
        limits: {
          maxTextureDimension2D: 4096,
          maxSampledTexturesPerShaderStage: 16,
          maxVertexAttributes: 16,
          // maxColorAttachments, maxTextureDimension3D and
          // maxTextureArrayLayers intentionally omitted (undefined).
        },
      });
    });

    it("defaults maxColorAttachments to 8 for both draw buffers and color attachments", function () {
      expect(ContextLimits.maximumDrawBuffers).toBe(8);
      expect(ContextLimits.maximumColorAttachments).toBe(8);
    });

    it("defaults maxTextureDimension3D to 2048", function () {
      expect(ContextLimits.maximum3DTextureSize).toBe(2048);
    });

    it("does not let a zero optional limit fall through to the default", function () {
      // `?? 0` keeps 0 — only undefined/null trigger the fallback.
      // Re-run with explicit zeros to prove the coalescing operator
      // isn't `|| 8` (which would clobber a legitimate 0).
      initializeContextLimitsFromDevice({
        limits: {
          maxTextureDimension2D: 4096,
          maxSampledTexturesPerShaderStage: 16,
          maxVertexAttributes: 16,
          maxColorAttachments: 0,
          maxTextureDimension3D: 0,
          maxTextureArrayLayers: 0,
        },
      });
      expect(ContextLimits.maximumDrawBuffers).toBe(0);
      expect(ContextLimits.maximumColorAttachments).toBe(0);
      expect(ContextLimits.maximum3DTextureSize).toBe(0);
    });
  });

  describe("idempotency / device-loss refresh", function () {
    it("overwrites prior values when re-invoked with new limits", function () {
      initializeContextLimitsFromDevice({ limits: makeFullLimits() });
      expect(ContextLimits.maximumTextureSize).toBe(8192);

      // Simulate device-loss recovery onto a smaller adapter.
      initializeContextLimitsFromDevice({
        limits: {
          maxTextureDimension2D: 2048,
          maxSampledTexturesPerShaderStage: 8,
          maxVertexAttributes: 16,
          maxColorAttachments: 4,
          maxTextureDimension3D: 1024,
          maxTextureArrayLayers: 128,
        },
      });
      expect(ContextLimits.maximumTextureSize).toBe(2048);
      expect(ContextLimits.maximumCombinedTextureImageUnits).toBe(16);
      expect(ContextLimits.maximumColorAttachments).toBe(4);
      expect(ContextLimits.maximum3DTextureSize).toBe(1024);
    });

    it("leaves the global getters readable as numbers after init", function () {
      initializeContextLimitsFromDevice({ limits: makeFullLimits() });
      expect(typeof ContextLimits.maximumTextureSize).toBe("number");
      expect(typeof ContextLimits.maximumDrawBuffers).toBe("number");
      expect(typeof ContextLimits.highpFloatSupported).toBe("boolean");
    });
  });
});
