import {
  renderStateToPipelineVariant,
  applyPerEncoderState,
} from "../../../Source/Renderer/WebGPU/RenderStateToPipelineVariant.js";

// These specs are pure-logic tests — no GPU device is created. The first
// translator (`renderStateToPipelineVariant`) is a pure function over a
// WebGL-style `renderState` object. The second (`applyPerEncoderState`)
// issues calls on a `GPURenderPassEncoder`; we substitute a tiny spy
// object that records the calls, so no real WebGPU device/queue is needed.
// The intent is the same as WebGLStateConverters/BindGroupReflection
// specs: an accidental case-statement edit or offset slip fails fast in
// CI instead of breaking pipeline state at runtime.

describe("Renderer/WebGPU/RenderStateToPipelineVariant", function () {
  describe("renderStateToPipelineVariant", function () {
    it("returns undefined for an undefined renderState", function () {
      expect(renderStateToPipelineVariant(undefined)).toBeUndefined();
    });

    it("returns an empty variant for an empty renderState", function () {
      // No fields present means nothing is written to the variant.
      expect(renderStateToPipelineVariant({})).toEqual({});
    });

    describe("cull mode", function () {
      it("maps disabled cull → 'none'", function () {
        const v = renderStateToPipelineVariant({
          cull: { enabled: false, face: 0x0405 },
        });
        expect(v.cullMode).toBe("none");
      });

      it("maps GL_FRONT (0x0404) → 'front'", function () {
        const v = renderStateToPipelineVariant({
          cull: { enabled: true, face: 0x0404 },
        });
        expect(v.cullMode).toBe("front");
      });

      it("maps GL_BACK (0x0405) → 'back'", function () {
        const v = renderStateToPipelineVariant({
          cull: { enabled: true, face: 0x0405 },
        });
        expect(v.cullMode).toBe("back");
      });

      it("maps GL_FRONT_AND_BACK (0x0408) → 'back' fallback", function () {
        // FRONT_AND_BACK has no WebGPU analogue; the module returns 'back'
        // so the pipeline still compiles.
        const v = renderStateToPipelineVariant({
          cull: { enabled: true, face: 0x0408 },
        });
        expect(v.cullMode).toBe("back");
      });

      it("defaults an unknown enabled face → 'back'", function () {
        const v = renderStateToPipelineVariant({
          cull: { enabled: true, face: 0xdead },
        });
        expect(v.cullMode).toBe("back");
      });
    });

    describe("depth state", function () {
      it("defaults depthTest enabled to true when omitted", function () {
        const v = renderStateToPipelineVariant({ depthTest: {} });
        expect(v.depthTest).toBe(true);
      });

      it("honors an explicit depthTest.enabled = false", function () {
        const v = renderStateToPipelineVariant({
          depthTest: { enabled: false },
        });
        expect(v.depthTest).toBe(false);
      });

      it("maps GL_LEQUAL (0x0203) func → 'less-equal'", function () {
        const v = renderStateToPipelineVariant({
          depthTest: { enabled: true, func: 0x0203 },
        });
        expect(v.depthCompare).toBe("less-equal");
      });

      it("omits depthCompare when func is an unknown enum", function () {
        // glCompareToGPU returns undefined for unknown funcs, and the
        // module only writes depthCompare when the result is defined.
        const v = renderStateToPipelineVariant({
          depthTest: { enabled: true, func: 0xdead },
        });
        expect(v.depthCompare).toBeUndefined();
        expect("depthCompare" in v).toBe(false);
      });

      it("maps depthMask boolean → depthWrite", function () {
        expect(
          renderStateToPipelineVariant({ depthMask: true }).depthWrite,
        ).toBe(true);
        expect(
          renderStateToPipelineVariant({ depthMask: false }).depthWrite,
        ).toBe(false);
      });
    });

    describe("color write mask", function () {
      it("packs RGBA channels into the 0x1/0x2/0x4/0x8 bitmask", function () {
        const v = renderStateToPipelineVariant({
          colorMask: { red: true, green: true, blue: true, alpha: true },
        });
        expect(v.colorWriteMask).toBe(0xf);
      });

      it("packs only the red channel as 0x1", function () {
        const v = renderStateToPipelineVariant({
          colorMask: { red: true, green: false, blue: false, alpha: false },
        });
        expect(v.colorWriteMask).toBe(0x1);
      });

      it("packs green|blue as 0x2|0x4 = 0x6", function () {
        const v = renderStateToPipelineVariant({
          colorMask: { red: false, green: true, blue: true, alpha: false },
        });
        expect(v.colorWriteMask).toBe(0x6);
      });

      it("packs only the alpha channel as 0x8", function () {
        const v = renderStateToPipelineVariant({
          colorMask: { red: false, green: false, blue: false, alpha: true },
        });
        expect(v.colorWriteMask).toBe(0x8);
      });

      it("packs an all-false mask as 0", function () {
        const v = renderStateToPipelineVariant({
          colorMask: { red: false, green: false, blue: false, alpha: false },
        });
        expect(v.colorWriteMask).toBe(0);
      });
    });

    describe("polygon offset → depth bias", function () {
      it("maps factor → depthBiasSlopeScale and units → depthBias", function () {
        const v = renderStateToPipelineVariant({
          polygonOffset: { enabled: true, factor: 2, units: 5 },
        });
        expect(v.depthBiasSlopeScale).toBe(2);
        expect(v.depthBias).toBe(5);
      });

      it("defaults missing factor/units to 0 when enabled", function () {
        const v = renderStateToPipelineVariant({
          polygonOffset: { enabled: true },
        });
        expect(v.depthBiasSlopeScale).toBe(0);
        expect(v.depthBias).toBe(0);
      });

      it("ignores polygon offset when disabled", function () {
        const v = renderStateToPipelineVariant({
          polygonOffset: { enabled: false, factor: 2, units: 5 },
        });
        expect(v.depthBias).toBeUndefined();
        expect(v.depthBiasSlopeScale).toBeUndefined();
      });
    });

    describe("blending", function () {
      it("ignores blending when disabled", function () {
        const v = renderStateToPipelineVariant({
          blending: { enabled: false },
        });
        expect(v.blend).toBeUndefined();
      });

      it("maps the canonical premultiplied-alpha blend state", function () {
        // src=ONE(1), dst=ONE_MINUS_SRC_ALPHA(0x0303), eq=FUNC_ADD(0x8006)
        const v = renderStateToPipelineVariant({
          blending: {
            enabled: true,
            equationRgb: 0x8006,
            equationAlpha: 0x8006,
            functionSourceRgb: 1,
            functionSourceAlpha: 1,
            functionDestinationRgb: 0x0303,
            functionDestinationAlpha: 0x0303,
          },
        });
        expect(v.blend).toEqual({
          color: {
            srcFactor: "one",
            dstFactor: "one-minus-src-alpha",
            operation: "add",
          },
          alpha: {
            srcFactor: "one",
            dstFactor: "one-minus-src-alpha",
            operation: "add",
          },
        });
      });

      it("falls back to one/zero/add for unknown blend enums", function () {
        const v = renderStateToPipelineVariant({
          blending: {
            enabled: true,
            equationRgb: 0xdead,
            equationAlpha: 0xdead,
            functionSourceRgb: 0xdead,
            functionSourceAlpha: 0xdead,
            functionDestinationRgb: 0xdead,
            functionDestinationAlpha: 0xdead,
          },
        });
        expect(v.blend.color).toEqual({
          srcFactor: "one",
          dstFactor: "zero",
          operation: "add",
        });
        expect(v.blend.alpha).toEqual({
          srcFactor: "one",
          dstFactor: "zero",
          operation: "add",
        });
      });

      it("maps GL_FUNC_REVERSE_SUBTRACT (0x800b) → 'reverse-subtract'", function () {
        const v = renderStateToPipelineVariant({
          blending: { enabled: true, equationRgb: 0x800b },
        });
        expect(v.blend.color.operation).toBe("reverse-subtract");
      });

      it("captures blendConstant from blending.color with 0 defaults", function () {
        const v = renderStateToPipelineVariant({
          blending: {
            enabled: true,
            color: { red: 0.25, green: 0.5 },
          },
        });
        expect(v.blendConstant).toEqual({ r: 0.25, g: 0.5, b: 0, a: 0 });
      });

      it("omits blendConstant when blending has no color", function () {
        const v = renderStateToPipelineVariant({
          blending: { enabled: true },
        });
        expect(v.blendConstant).toBeUndefined();
      });
    });

    describe("stencil state", function () {
      it("ignores stencil when disabled", function () {
        const v = renderStateToPipelineVariant({
          stencilTest: { enabled: false, frontFunction: 0x0202 },
        });
        expect(v.stencilFront).toBeUndefined();
        expect(v.stencilBack).toBeUndefined();
      });

      it("maps the front face function + operations", function () {
        // frontFunction=EQUAL(0x0202); ops: fail=KEEP(0x1e00),
        // zFail=REPLACE(0x1e01), zPass=INCR_WRAP(0x8507)
        const v = renderStateToPipelineVariant({
          stencilTest: {
            enabled: true,
            frontFunction: 0x0202,
            frontOperation: { fail: 0x1e00, zFail: 0x1e01, zPass: 0x8507 },
          },
        });
        expect(v.stencilFront).toEqual({
          compare: "equal",
          failOp: "keep",
          depthFailOp: "replace",
          passOp: "increment-wrap",
        });
      });

      it("defaults front compare to 'always' and ops to 'keep'", function () {
        // frontOperation present (so the block fires) but with unknown
        // op enums and no frontFunction → all defaults.
        const v = renderStateToPipelineVariant({
          stencilTest: {
            enabled: true,
            frontOperation: { fail: 0xdead, zFail: 0xdead, zPass: 0xdead },
          },
        });
        expect(v.stencilFront).toEqual({
          compare: "always",
          failOp: "keep",
          depthFailOp: "keep",
          passOp: "keep",
        });
      });

      it("maps the back face independently", function () {
        // backFunction=NOTEQUAL(0x0205); ops zPass=DECR_WRAP(0x8508)
        const v = renderStateToPipelineVariant({
          stencilTest: {
            enabled: true,
            backFunction: 0x0205,
            backOperation: { zPass: 0x8508 },
          },
        });
        expect(v.stencilBack).toEqual({
          compare: "not-equal",
          failOp: "keep",
          depthFailOp: "keep",
          passOp: "decrement-wrap",
        });
      });

      it("masks stencilTest.mask to the low byte for the read mask", function () {
        const v = renderStateToPipelineVariant({
          stencilTest: { enabled: true, frontFunction: 0x0207, mask: 0x1ff },
        });
        expect(v.stencilReadMask).toBe(0xff);
      });

      it("masks stencilMask to the low byte for the write mask", function () {
        const v = renderStateToPipelineVariant({ stencilMask: 0x1ab });
        expect(v.stencilWriteMask).toBe(0xab);
      });
    });
  });

  describe("applyPerEncoderState", function () {
    // Minimal spy standing in for a GPURenderPassEncoder — records the
    // arguments of each per-encoder call without a real device.
    function makeEncoderSpy() {
      const calls = {
        stencilReference: [],
        blendConstant: [],
        viewport: [],
        scissorRect: [],
      };
      return {
        calls,
        setStencilReference(ref) {
          calls.stencilReference.push(ref);
        },
        setBlendConstant(c) {
          calls.blendConstant.push(c);
        },
        setViewport(x, y, w, h, minD, maxD) {
          calls.viewport.push([x, y, w, h, minD, maxD]);
        },
        setScissorRect(x, y, w, h) {
          calls.scissorRect.push([x, y, w, h]);
        },
      };
    }

    it("is a no-op when both renderState and variant are absent", function () {
      const enc = makeEncoderSpy();
      applyPerEncoderState(enc, undefined, undefined);
      expect(enc.calls.stencilReference.length).toBe(0);
      expect(enc.calls.blendConstant.length).toBe(0);
      expect(enc.calls.viewport.length).toBe(0);
      expect(enc.calls.scissorRect.length).toBe(0);
    });

    it("sets a non-zero stencil reference", function () {
      const enc = makeEncoderSpy();
      applyPerEncoderState(enc, { stencilTest: { reference: 7 } });
      expect(enc.calls.stencilReference).toEqual([7]);
    });

    it("skips setStencilReference when the reference is 0", function () {
      const enc = makeEncoderSpy();
      applyPerEncoderState(enc, { stencilTest: { reference: 0 } });
      expect(enc.calls.stencilReference.length).toBe(0);
    });

    it("prefers the variant's blendConstant when provided", function () {
      const enc = makeEncoderSpy();
      const bc = { r: 1, g: 0, b: 0, a: 1 };
      applyPerEncoderState(
        enc,
        { blending: { enabled: true, color: { red: 0.5 } } },
        { blendConstant: bc },
      );
      // Variant takes precedence — the renderState color is not used.
      expect(enc.calls.blendConstant).toEqual([bc]);
    });

    it("derives blendConstant from renderState when the variant has none", function () {
      const enc = makeEncoderSpy();
      applyPerEncoderState(enc, {
        blending: { enabled: true, color: { red: 0.25, alpha: 0.75 } },
      });
      expect(enc.calls.blendConstant).toEqual([
        { r: 0.25, g: 0, b: 0, a: 0.75 },
      ]);
    });

    it("does not set a blend constant when blending is disabled", function () {
      const enc = makeEncoderSpy();
      applyPerEncoderState(enc, {
        blending: { enabled: false, color: { red: 1 } },
      });
      expect(enc.calls.blendConstant.length).toBe(0);
    });

    it("sets the viewport with fixed (0,1) depth range", function () {
      const enc = makeEncoderSpy();
      applyPerEncoderState(enc, {
        viewport: { x: 10, y: 20, width: 640, height: 480 },
      });
      expect(enc.calls.viewport).toEqual([[10, 20, 640, 480, 0, 1]]);
    });

    it("clamps degenerate viewport width/height to 1", function () {
      const enc = makeEncoderSpy();
      applyPerEncoderState(enc, {
        viewport: { x: 0, y: 0, width: 0, height: 0 },
      });
      expect(enc.calls.viewport).toEqual([[0, 0, 1, 1, 0, 1]]);
    });

    it("sets the scissor rect when scissor test is enabled", function () {
      const enc = makeEncoderSpy();
      applyPerEncoderState(enc, {
        scissorTest: {
          enabled: true,
          rectangle: { x: 5, y: 6, width: 100, height: 200 },
        },
      });
      expect(enc.calls.scissorRect).toEqual([[5, 6, 100, 200]]);
    });

    it("clamps negative scissor origin to 0 and size to >= 1", function () {
      const enc = makeEncoderSpy();
      applyPerEncoderState(enc, {
        scissorTest: {
          enabled: true,
          rectangle: { x: -4, y: -8, width: 0, height: 0 },
        },
      });
      expect(enc.calls.scissorRect).toEqual([[0, 0, 1, 1]]);
    });

    it("skips the scissor rect when scissor test is disabled", function () {
      const enc = makeEncoderSpy();
      applyPerEncoderState(enc, {
        scissorTest: {
          enabled: false,
          rectangle: { x: 5, y: 6, width: 100, height: 200 },
        },
      });
      expect(enc.calls.scissorRect.length).toBe(0);
    });
  });
});
