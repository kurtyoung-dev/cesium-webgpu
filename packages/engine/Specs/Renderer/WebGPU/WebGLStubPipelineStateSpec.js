import {
  PIPELINE_STATE_CONSTANTS,
  createPipelineStateStubs,
} from "../../../Source/Renderer/WebGPU/Stubs/WebGLStubPipelineState.js";
import Color from "../../../Source/Core/Color.js";

describe("Renderer/WebGPU/Stubs/WebGLStubPipelineState", function () {
  // These are pure-logic tests — the pipeline-state stub methods only
  // MUTATE a plain `WebGLStubState` object that WebGPUContext normally
  // owns. None of the methods exercised here call createPipeline /
  // createBindGroup / queue.submit, so no live GPUDevice is required.
  // We hand the factory a minimal fake state whose converter hooks and
  // viewport/scissor methods just record their arguments, then assert
  // the stub wrote the right fields. Methods that touch a render-pass
  // encoder are exercised with a tiny fake encoder (no device needed)
  // to confirm the imperative call is forwarded.

  // Build a fresh fake state for each test. The converter functions are
  // declared ON the state in WebGLStubTypes; the stub delegates to them,
  // so we supply deterministic stand-ins that prefix their input. That
  // lets us assert delegation without re-testing the real converters.
  function makeState() {
    const recorded = {
      viewport: undefined,
      scissor: undefined,
      disableScissorTestCalls: 0,
    };
    const state = {
      // Render-pass encoder is null by default; tests set a fake when
      // they need to assert imperative forwarding.
      currentRenderPassEncoder: null,

      // Pipeline state fields the stub writes into.
      clearColor: undefined,
      clearDepth: undefined,
      clearStencil: undefined,
      depthTestEnabled: false,
      depthWriteEnabled: false,
      depthCompare: undefined,
      blendEnabled: false,
      cullFaceEnabled: false,
      cullMode: undefined,
      frontFace: undefined,
      colorWriteMask: 0,
      blendSrc: undefined,
      blendDst: undefined,
      blendSrcAlpha: undefined,
      blendDstAlpha: undefined,
      blendOp: undefined,
      blendOpAlpha: undefined,
      scissorTest: false,
      stencilTestEnabled: false,
      stencilFrontCompare: undefined,
      stencilBackCompare: undefined,
      stencilReadMask: undefined,
      stencilWriteMask: undefined,
      stencilReference: undefined,
      stencilFailOp: undefined,
      stencilDepthFailOp: undefined,
      stencilPassOp: undefined,

      // Viewport / scissor delegate to context-provided methods.
      setViewport(x, y, w, h) {
        recorded.viewport = [x, y, w, h];
      },
      setScissorRect(x, y, w, h) {
        recorded.scissor = [x, y, w, h];
      },
      disableScissorTest() {
        recorded.disableScissorTestCalls += 1;
      },

      // Converter hooks — deterministic stand-ins that tag the input so
      // we can prove which value flowed where.
      webglToWebGPUBlendFactor(f) {
        return `bf:${f}`;
      },
      webglToWebGPUBlendOp(o) {
        return `bo:${o}`;
      },
      webglToWebGPUCompareFunction(f) {
        return `cf:${f}`;
      },
    };
    return { state, recorded };
  }

  // WebGL enum literals copied directly from the module under test so a
  // careless renumber there fails one of these assertions.
  const GL_DEPTH_TEST = 0x0b71;
  const GL_BLEND = 0x0be2;
  const GL_CULL_FACE = 0x0b44;
  const GL_SCISSOR_TEST = 0x0c11;
  const GL_STENCIL_TEST = 0x0b90;
  const GL_FRONT = 0x0404;
  const GL_BACK = 0x0405;
  const GL_FRONT_AND_BACK = 0x0408;
  const GL_CW = 0x0900;
  const GL_CCW = 0x0901;

  // Stencil-op GL constants → GPUStencilOperation strings.
  const GL_KEEP = 0x1e00;
  const GL_ZERO = 0x0000;
  const GL_REPLACE = 0x1e01;
  const GL_INCR = 0x1e02;
  const GL_DECR = 0x1e03;
  const GL_INVERT = 0x150a;
  const GL_INCR_WRAP = 0x8507;
  const GL_DECR_WRAP = 0x8508;

  describe("PIPELINE_STATE_CONSTANTS", function () {
    it("pins the clear bit masks", function () {
      expect(PIPELINE_STATE_CONSTANTS.COLOR_BUFFER_BIT).toBe(0x4000);
      expect(PIPELINE_STATE_CONSTANTS.DEPTH_BUFFER_BIT).toBe(0x0100);
      expect(PIPELINE_STATE_CONSTANTS.STENCIL_BUFFER_BIT).toBe(0x0400);
    });

    it("pins the capability enum constants", function () {
      expect(PIPELINE_STATE_CONSTANTS.DEPTH_TEST).toBe(GL_DEPTH_TEST);
      expect(PIPELINE_STATE_CONSTANTS.BLEND).toBe(GL_BLEND);
      expect(PIPELINE_STATE_CONSTANTS.CULL_FACE).toBe(GL_CULL_FACE);
      expect(PIPELINE_STATE_CONSTANTS.SCISSOR_TEST).toBe(GL_SCISSOR_TEST);
      expect(PIPELINE_STATE_CONSTANTS.STENCIL_TEST).toBe(GL_STENCIL_TEST);
      expect(PIPELINE_STATE_CONSTANTS.SAMPLE_ALPHA_TO_COVERAGE).toBe(0x809e);
    });

    it("is frozen so the constant table can't be mutated at runtime", function () {
      expect(Object.isFrozen(PIPELINE_STATE_CONSTANTS)).toBe(true);
    });
  });

  describe("createPipelineStateStubs", function () {
    it("returns the full set of stub methods", function () {
      const { state } = makeState();
      const stubs = createPipelineStateStubs(state, function () {});
      // Spot-check every documented method exists and is callable.
      const expectedMethods = [
        "clear",
        "clearColor",
        "clearDepth",
        "clearStencil",
        "viewport",
        "scissor",
        "enable",
        "disable",
        "blendFunc",
        "blendFuncSeparate",
        "blendEquation",
        "blendEquationSeparate",
        "blendColor",
        "depthFunc",
        "depthMask",
        "depthRange",
        "stencilFunc",
        "stencilFuncSeparate",
        "stencilMask",
        "stencilMaskSeparate",
        "stencilOp",
        "stencilOpSeparate",
        "cullFace",
        "frontFace",
        "colorMask",
      ];
      for (const name of expectedMethods) {
        expect(typeof stubs[name]).toBe("function");
      }
    });
  });

  describe("clear-state methods", function () {
    it("clearColor records a Color with the given RGBA", function () {
      const { state } = makeState();
      const stubs = createPipelineStateStubs(state, function () {});
      stubs.clearColor(0.1, 0.2, 0.3, 0.4);
      expect(state.clearColor instanceof Color).toBe(true);
      expect(state.clearColor.red).toBe(0.1);
      expect(state.clearColor.green).toBe(0.2);
      expect(state.clearColor.blue).toBe(0.3);
      expect(state.clearColor.alpha).toBe(0.4);
    });

    it("clearColor is a no-op when red is undefined", function () {
      const { state } = makeState();
      const stubs = createPipelineStateStubs(state, function () {});
      stubs.clearColor();
      expect(state.clearColor).toBeUndefined();
    });

    it("clearDepth records the depth value, ignoring undefined", function () {
      const { state } = makeState();
      const stubs = createPipelineStateStubs(state, function () {});
      stubs.clearDepth(0.5);
      expect(state.clearDepth).toBe(0.5);
      stubs.clearDepth();
      expect(state.clearDepth).toBe(0.5);
    });

    it("clearStencil records the stencil value, ignoring undefined", function () {
      const { state } = makeState();
      const stubs = createPipelineStateStubs(state, function () {});
      stubs.clearStencil(7);
      expect(state.clearStencil).toBe(7);
      stubs.clearStencil();
      expect(state.clearStencil).toBe(7);
    });
  });

  describe("viewport and scissor", function () {
    it("viewport delegates to state.setViewport", function () {
      const { state, recorded } = makeState();
      const stubs = createPipelineStateStubs(state, function () {});
      stubs.viewport(1, 2, 3, 4);
      expect(recorded.viewport).toEqual([1, 2, 3, 4]);
    });

    it("scissor delegates to state.setScissorRect", function () {
      const { state, recorded } = makeState();
      const stubs = createPipelineStateStubs(state, function () {});
      stubs.scissor(5, 6, 7, 8);
      expect(recorded.scissor).toEqual([5, 6, 7, 8]);
    });
  });

  describe("enable / disable capability mapping", function () {
    it("enable toggles each tracked capability flag on", function () {
      const { state } = makeState();
      const stubs = createPipelineStateStubs(state, function () {});
      stubs.enable(GL_DEPTH_TEST);
      stubs.enable(GL_BLEND);
      stubs.enable(GL_CULL_FACE);
      stubs.enable(GL_SCISSOR_TEST);
      stubs.enable(GL_STENCIL_TEST);
      expect(state.depthTestEnabled).toBe(true);
      expect(state.blendEnabled).toBe(true);
      expect(state.cullFaceEnabled).toBe(true);
      expect(state.scissorTest).toBe(true);
      expect(state.stencilTestEnabled).toBe(true);
    });

    it("disable toggles each tracked capability flag off", function () {
      const { state } = makeState();
      const stubs = createPipelineStateStubs(state, function () {});
      state.depthTestEnabled = true;
      state.blendEnabled = true;
      state.cullFaceEnabled = true;
      state.scissorTest = true;
      state.stencilTestEnabled = true;
      stubs.disable(GL_DEPTH_TEST);
      stubs.disable(GL_BLEND);
      stubs.disable(GL_CULL_FACE);
      stubs.disable(GL_SCISSOR_TEST);
      stubs.disable(GL_STENCIL_TEST);
      expect(state.depthTestEnabled).toBe(false);
      expect(state.blendEnabled).toBe(false);
      expect(state.cullFaceEnabled).toBe(false);
      expect(state.scissorTest).toBe(false);
      expect(state.stencilTestEnabled).toBe(false);
    });

    it("disabling scissor test also calls disableScissorTest", function () {
      const { state, recorded } = makeState();
      const stubs = createPipelineStateStubs(state, function () {});
      stubs.disable(GL_SCISSOR_TEST);
      expect(recorded.disableScissorTestCalls).toBe(1);
    });

    it("enable ignores unrecognized capability enums", function () {
      const { state } = makeState();
      const stubs = createPipelineStateStubs(state, function () {});
      stubs.enable(0xdead);
      expect(state.depthTestEnabled).toBe(false);
      expect(state.blendEnabled).toBe(false);
      expect(state.cullFaceEnabled).toBe(false);
      expect(state.scissorTest).toBe(false);
      expect(state.stencilTestEnabled).toBe(false);
    });
  });

  describe("blend state", function () {
    it("blendFunc delegates RGB factors and mirrors them onto alpha", function () {
      const { state } = makeState();
      const stubs = createPipelineStateStubs(state, function () {});
      stubs.blendFunc(770, 771);
      expect(state.blendSrc).toBe("bf:770");
      expect(state.blendDst).toBe("bf:771");
      // blendFunc mirrors the RGB factors onto the alpha channel.
      expect(state.blendSrcAlpha).toBe("bf:770");
      expect(state.blendDstAlpha).toBe("bf:771");
    });

    it("blendFuncSeparate delegates all four factors independently", function () {
      const { state } = makeState();
      const stubs = createPipelineStateStubs(state, function () {});
      stubs.blendFuncSeparate(1, 2, 3, 4);
      expect(state.blendSrc).toBe("bf:1");
      expect(state.blendDst).toBe("bf:2");
      expect(state.blendSrcAlpha).toBe("bf:3");
      expect(state.blendDstAlpha).toBe("bf:4");
    });

    it("blendEquation delegates the op and mirrors it onto alpha", function () {
      const { state } = makeState();
      const stubs = createPipelineStateStubs(state, function () {});
      stubs.blendEquation(32774);
      expect(state.blendOp).toBe("bo:32774");
      expect(state.blendOpAlpha).toBe("bo:32774");
    });

    it("blendEquationSeparate delegates RGB and alpha ops independently", function () {
      const { state } = makeState();
      const stubs = createPipelineStateStubs(state, function () {});
      stubs.blendEquationSeparate(10, 20);
      expect(state.blendOp).toBe("bo:10");
      expect(state.blendOpAlpha).toBe("bo:20");
    });

    it("blendColor forwards to the render pass encoder when one is open", function () {
      const { state } = makeState();
      const calls = [];
      state.currentRenderPassEncoder = {
        setBlendConstant(c) {
          calls.push(c);
        },
        setStencilReference() {},
      };
      const stubs = createPipelineStateStubs(state, function () {});
      stubs.blendColor(0.25, 0.5, 0.75, 1.0);
      expect(calls.length).toBe(1);
      expect(calls[0]).toEqual([0.25, 0.5, 0.75, 1.0]);
    });

    it("blendColor is a no-op when no render pass is open", function () {
      const { state } = makeState();
      const stubs = createPipelineStateStubs(state, function () {});
      // currentRenderPassEncoder is null — must not throw.
      expect(function () {
        stubs.blendColor(0, 0, 0, 0);
      }).not.toThrow();
    });
  });

  describe("depth state", function () {
    it("depthFunc delegates the compare function", function () {
      const { state } = makeState();
      const stubs = createPipelineStateStubs(state, function () {});
      stubs.depthFunc(515);
      expect(state.depthCompare).toBe("cf:515");
    });

    it("depthMask records the write flag", function () {
      const { state } = makeState();
      const stubs = createPipelineStateStubs(state, function () {});
      stubs.depthMask(false);
      expect(state.depthWriteEnabled).toBe(false);
      stubs.depthMask(true);
      expect(state.depthWriteEnabled).toBe(true);
    });

    it("depthRange is a no-op that does not throw", function () {
      const { state } = makeState();
      const stubs = createPipelineStateStubs(state, function () {});
      expect(function () {
        stubs.depthRange(0, 1);
      }).not.toThrow();
    });
  });

  describe("stencil state", function () {
    it("stencilFunc sets both face compares, reference, and read mask", function () {
      const { state } = makeState();
      const stubs = createPipelineStateStubs(state, function () {});
      stubs.stencilFunc(514, 3, 0xff);
      expect(state.stencilFrontCompare).toBe("cf:514");
      expect(state.stencilBackCompare).toBe("cf:514");
      expect(state.stencilReference).toBe(3);
      expect(state.stencilReadMask).toBe(0xff);
    });

    it("stencilFunc forwards the reference to an open render pass", function () {
      const { state } = makeState();
      const refs = [];
      state.currentRenderPassEncoder = {
        setStencilReference(r) {
          refs.push(r);
        },
        setBlendConstant() {},
      };
      const stubs = createPipelineStateStubs(state, function () {});
      stubs.stencilFunc(514, 9, 0x0f);
      expect(refs).toEqual([9]);
    });

    it("stencilFuncSeparate updates only the addressed face (front)", function () {
      const { state } = makeState();
      const stubs = createPipelineStateStubs(state, function () {});
      stubs.stencilFuncSeparate(GL_FRONT, 514, 1, 0x12);
      expect(state.stencilFrontCompare).toBe("cf:514");
      expect(state.stencilBackCompare).toBeUndefined();
      expect(state.stencilReference).toBe(1);
      expect(state.stencilReadMask).toBe(0x12);
    });

    it("stencilFuncSeparate updates only the addressed face (back)", function () {
      const { state } = makeState();
      const stubs = createPipelineStateStubs(state, function () {});
      stubs.stencilFuncSeparate(GL_BACK, 515, 2, 0x34);
      expect(state.stencilBackCompare).toBe("cf:515");
      expect(state.stencilFrontCompare).toBeUndefined();
      expect(state.stencilReference).toBe(2);
      expect(state.stencilReadMask).toBe(0x34);
    });

    it("stencilFuncSeparate with FRONT_AND_BACK updates both faces", function () {
      const { state } = makeState();
      const stubs = createPipelineStateStubs(state, function () {});
      stubs.stencilFuncSeparate(GL_FRONT_AND_BACK, 516, 5, 0x56);
      expect(state.stencilFrontCompare).toBe("cf:516");
      expect(state.stencilBackCompare).toBe("cf:516");
    });

    it("stencilMask records the write mask", function () {
      const { state } = makeState();
      const stubs = createPipelineStateStubs(state, function () {});
      stubs.stencilMask(0xab);
      expect(state.stencilWriteMask).toBe(0xab);
    });

    it("stencilMaskSeparate records a single shared write mask", function () {
      const { state } = makeState();
      const stubs = createPipelineStateStubs(state, function () {});
      stubs.stencilMaskSeparate(GL_FRONT, 0xcd);
      expect(state.stencilWriteMask).toBe(0xcd);
    });

    it("stencilOp maps each GL op to its GPUStencilOperation string", function () {
      const { state } = makeState();
      const stubs = createPipelineStateStubs(state, function () {});
      stubs.stencilOp(GL_KEEP, GL_REPLACE, GL_INVERT);
      expect(state.stencilFailOp).toBe("keep");
      expect(state.stencilDepthFailOp).toBe("replace");
      expect(state.stencilPassOp).toBe("invert");
    });

    it("stencilOp maps zero to 'zero' and the increment/decrement family", function () {
      const { state } = makeState();
      const stubs = createPipelineStateStubs(state, function () {});
      stubs.stencilOp(GL_ZERO, GL_INCR, GL_DECR);
      expect(state.stencilFailOp).toBe("zero");
      expect(state.stencilDepthFailOp).toBe("increment-clamp");
      expect(state.stencilPassOp).toBe("decrement-clamp");
    });

    it("stencilOp maps the wrapping increment/decrement ops", function () {
      const { state } = makeState();
      const stubs = createPipelineStateStubs(state, function () {});
      stubs.stencilOp(GL_INCR_WRAP, GL_DECR_WRAP, GL_KEEP);
      expect(state.stencilFailOp).toBe("increment-wrap");
      expect(state.stencilDepthFailOp).toBe("decrement-wrap");
      expect(state.stencilPassOp).toBe("keep");
    });

    it("stencilOp defaults unknown ops to 'keep'", function () {
      const { state } = makeState();
      const stubs = createPipelineStateStubs(state, function () {});
      stubs.stencilOp(0xdead, 0xbeef, 0xfeed);
      expect(state.stencilFailOp).toBe("keep");
      expect(state.stencilDepthFailOp).toBe("keep");
      expect(state.stencilPassOp).toBe("keep");
    });

    it("stencilOpSeparate maps ops the same way, ignoring the face arg", function () {
      const { state } = makeState();
      const stubs = createPipelineStateStubs(state, function () {});
      stubs.stencilOpSeparate(GL_FRONT, GL_KEEP, GL_ZERO, GL_REPLACE);
      expect(state.stencilFailOp).toBe("keep");
      expect(state.stencilDepthFailOp).toBe("zero");
      expect(state.stencilPassOp).toBe("replace");
    });
  });

  describe("cull and front face", function () {
    it("cullFace maps GL_FRONT to 'front'", function () {
      const { state } = makeState();
      const stubs = createPipelineStateStubs(state, function () {});
      stubs.cullFace(GL_FRONT);
      expect(state.cullMode).toBe("front");
    });

    it("cullFace maps GL_BACK to 'back'", function () {
      const { state } = makeState();
      const stubs = createPipelineStateStubs(state, function () {});
      stubs.cullFace(GL_BACK);
      expect(state.cullMode).toBe("back");
    });

    it("cullFace maps anything else (e.g. FRONT_AND_BACK) to 'none'", function () {
      const { state } = makeState();
      const stubs = createPipelineStateStubs(state, function () {});
      stubs.cullFace(GL_FRONT_AND_BACK);
      expect(state.cullMode).toBe("none");
    });

    it("frontFace maps GL_CW to 'cw' and everything else to 'ccw'", function () {
      const { state } = makeState();
      const stubs = createPipelineStateStubs(state, function () {});
      stubs.frontFace(GL_CW);
      expect(state.frontFace).toBe("cw");
      stubs.frontFace(GL_CCW);
      expect(state.frontFace).toBe("ccw");
    });
  });

  describe("color mask", function () {
    it("packs all four channels into the WebGPU color-write bitfield", function () {
      const { state } = makeState();
      const stubs = createPipelineStateStubs(state, function () {});
      stubs.colorMask(true, true, true, true);
      expect(state.colorWriteMask).toBe(0xf);
    });

    it("packs individual channels into their respective bits", function () {
      const { state } = makeState();
      const stubs = createPipelineStateStubs(state, function () {});
      stubs.colorMask(true, false, false, false);
      expect(state.colorWriteMask).toBe(0x1);
      stubs.colorMask(false, true, false, false);
      expect(state.colorWriteMask).toBe(0x2);
      stubs.colorMask(false, false, true, false);
      expect(state.colorWriteMask).toBe(0x4);
      stubs.colorMask(false, false, false, true);
      expect(state.colorWriteMask).toBe(0x8);
    });

    it("packs a mixed mask (RB on, GA off) to 0x5", function () {
      const { state } = makeState();
      const stubs = createPipelineStateStubs(state, function () {});
      stubs.colorMask(true, false, true, false);
      expect(state.colorWriteMask).toBe(0x5);
    });

    it("packs all-off to 0", function () {
      const { state } = makeState();
      const stubs = createPipelineStateStubs(state, function () {});
      stubs.colorMask(false, false, false, false);
      expect(state.colorWriteMask).toBe(0x0);
    });
  });
});
