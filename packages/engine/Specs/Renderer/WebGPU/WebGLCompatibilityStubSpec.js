import createWebGLCompatibilityStub, {
  createWebGLCompatibilityStub as namedCreateStub,
  getCompiledShaderForProgram,
} from "../../../Source/Renderer/WebGPU/WebGLCompatibilityStub.js";
import { WebGLStubBufferRegistry } from "../../../Source/Renderer/WebGPU/Stubs/WebGLStubBuffer.js";
import { WebGLStubTextureRegistry } from "../../../Source/Renderer/WebGPU/Stubs/WebGLStubTexture.js";

// These specs are pure-logic tests — no real GPUDevice / GPUQueue is
// created. `createWebGLCompatibilityStub(state)` composes a WebGL-shaped
// object out of constant tables plus state-tracking methods that read and
// write a caller-supplied `WebGLStubState`. The vast majority of those
// methods are pure CPU-side bookkeeping (active texture unit math, bound
// buffer/framebuffer tracking, enable/disable capability flags, blend /
// depth / stencil / cull state, clear values, color-write mask packing).
// We exercise exactly those paths with a hand-rolled fake state object so
// an accidental edit to a constant value, an enum branch, or a bit-pack
// expression fails fast in CI instead of breaking the WebGL compatibility
// stub at runtime.
//
// Device-bound paths — anything that calls `state.device.createTexture`,
// `device.queue.writeBuffer`, `device.createShaderModule`, etc. — are NOT
// exercised here. They require a live WebGPU device which the Karma run
// can't guarantee. Device-independent handle/state behavior is covered here;
// native buffer ownership uses a recording device in WebGLStubBufferSpec.

/**
 * Build a minimal fake `WebGLStubState` with no real GPUDevice. The
 * `webglToWebGPU*` converters are provided as identity-ish spies so the
 * blend/depth state methods can be observed without pulling in the real
 * converter tables (those have their own spec). `setViewport` /
 * `setScissorRect` / `disableScissorTest` record their last call.
 */
function createFakeState() {
  return {
    // Device & encoders intentionally null — keeps every method on the
    // CPU-only branch.
    device: null,
    resourceGeneration: 0,
    context: null,
    currentCommandEncoder: null,
    currentRenderPassEncoder: null,

    // GL compatibility state
    activeTextureUnit: 0,
    textureBindings: new Map(),
    textureRegistry: new WebGLStubTextureRegistry(),
    boundVertexBuffer: null,
    boundIndexBuffer: null,
    bufferRegistry: new WebGLStubBufferRegistry(),
    allocateCompatibilityBuffers: true,
    boundFramebuffer: null,
    boundReadFramebuffer: null,
    boundDrawFramebuffer: null,
    boundRenderbuffer: null,
    framebuffers: new Map(),

    // Pipeline state (defaults are overwritten by the stub methods)
    clearColor: null,
    clearDepth: -1,
    clearStencil: -1,
    depthTestEnabled: false,
    depthWriteEnabled: false,
    depthCompare: "always",
    blendEnabled: false,
    cullFaceEnabled: false,
    cullMode: "none",
    frontFace: "ccw",
    colorWriteMask: 0,
    blendSrc: "one",
    blendDst: "zero",
    blendSrcAlpha: "one",
    blendDstAlpha: "zero",
    blendOp: "add",
    blendOpAlpha: "add",
    scissorTest: false,

    pixelStore: {
      unpackFlipY: false,
      unpackPremultiplyAlpha: false,
      unpackAlignment: 4,
    },

    stencilTestEnabled: false,
    stencilFrontCompare: "always",
    stencilBackCompare: "always",
    stencilReadMask: 0,
    stencilWriteMask: 0,
    stencilReference: 0,
    stencilFailOp: "keep",
    stencilDepthFailOp: "keep",
    stencilPassOp: "keep",

    mipmapGenerator: null,

    // Recorded calls for the WebGPUContext-provided methods.
    _viewportCall: null,
    _scissorCall: null,
    _scissorDisabled: false,

    setViewport(x, y, w, h) {
      this._viewportCall = [x, y, w, h];
    },
    setScissorRect(x, y, w, h) {
      this._scissorCall = [x, y, w, h];
    },
    disableScissorTest() {
      this._scissorDisabled = true;
    },
    copyTextureRegion() {},
    enqueueMipGeneration() {},
    // Identity-ish converters — return a recognizable mapping of the input
    // so the blend/depth state methods can be asserted without depending on
    // the real WebGLStateConverters tables.
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
}

describe("Renderer/WebGPU/WebGLCompatibilityStub", function () {
  describe("module exports", function () {
    it("exposes the factory as both default and named export", function () {
      expect(typeof createWebGLCompatibilityStub).toBe("function");
      expect(namedCreateStub).toBe(createWebGLCompatibilityStub);
    });

    it("re-exports getCompiledShaderForProgram", function () {
      expect(typeof getCompiledShaderForProgram).toBe("function");
    });
  });

  describe("texture constants", function () {
    let gl;
    beforeEach(function () {
      gl = createWebGLCompatibilityStub(createFakeState());
    });

    it("pins the WebGL texture-target enum values", function () {
      expect(gl.TEXTURE_2D).toBe(0x0de1);
      expect(gl.TEXTURE_CUBE_MAP).toBe(0x8513);
      expect(gl.TEXTURE0).toBe(0x84c0);
    });

    it("pins the pixel-store + sampler-param enum values", function () {
      expect(gl.UNPACK_ALIGNMENT).toBe(0x0cf5);
      expect(gl.UNPACK_FLIP_Y_WEBGL).toBe(0x9240);
      expect(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL).toBe(0x9241);
      expect(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL).toBe(0x9243);
      expect(gl.NONE).toBe(0);
      expect(gl.BROWSER_DEFAULT_WEBGL).toBe(0x9244);
      expect(gl.TEXTURE_MAG_FILTER).toBe(0x2800);
      expect(gl.TEXTURE_MIN_FILTER).toBe(0x2801);
      expect(gl.TEXTURE_WRAP_S).toBe(0x2802);
      expect(gl.TEXTURE_WRAP_T).toBe(0x2803);
      expect(gl.TEXTURE_WRAP_R).toBe(0x8072);
      expect(gl.GENERATE_MIPMAP_HINT).toBe(0x8192);
    });
  });

  describe("buffer constants", function () {
    let gl;
    beforeEach(function () {
      gl = createWebGLCompatibilityStub(createFakeState());
    });

    it("pins the WebGL buffer-target + usage enum values", function () {
      expect(gl.ARRAY_BUFFER).toBe(0x8892);
      expect(gl.ELEMENT_ARRAY_BUFFER).toBe(0x8893);
      expect(gl.STATIC_DRAW).toBe(0x88e4);
      expect(gl.DYNAMIC_DRAW).toBe(0x88e8);
      expect(gl.STREAM_DRAW).toBe(0x88e0);
    });
  });

  describe("pipeline-state constants", function () {
    let gl;
    beforeEach(function () {
      gl = createWebGLCompatibilityStub(createFakeState());
    });

    it("pins the clear bit masks", function () {
      expect(gl.COLOR_BUFFER_BIT).toBe(0x4000);
      expect(gl.DEPTH_BUFFER_BIT).toBe(0x0100);
      expect(gl.STENCIL_BUFFER_BIT).toBe(0x0400);
    });

    it("pins the capability enum values", function () {
      expect(gl.DEPTH_TEST).toBe(0x0b71);
      expect(gl.BLEND).toBe(0x0be2);
      expect(gl.CULL_FACE).toBe(0x0b44);
      expect(gl.SCISSOR_TEST).toBe(0x0c11);
      expect(gl.STENCIL_TEST).toBe(0x0b90);
      expect(gl.SAMPLE_ALPHA_TO_COVERAGE).toBe(0x809e);
    });
  });

  describe("active texture + bind tracking", function () {
    it("subtracts TEXTURE0 (0x84c0) to compute the active unit index", function () {
      const state = createFakeState();
      const gl = createWebGLCompatibilityStub(state);
      gl.activeTexture(0x84c0); // TEXTURE0
      expect(state.activeTextureUnit).toBe(0);
      gl.activeTexture(0x84c0 + 5); // TEXTURE5
      expect(state.activeTextureUnit).toBe(5);
    });

    it("records the bound texture under the active unit", function () {
      const state = createFakeState();
      const gl = createWebGLCompatibilityStub(state);
      const tex = gl.createTexture();
      gl.activeTexture(0x84c0 + 2);
      gl.bindTexture(gl.TEXTURE_2D, tex);
      expect(state.textureBindings.get(2)).toEqual({
        target: gl.TEXTURE_2D,
        texture: tex,
      });
    });

    it("latches the cubemap flag when bound as TEXTURE_CUBE_MAP", function () {
      const state = createFakeState();
      const gl = createWebGLCompatibilityStub(state);
      const tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_CUBE_MAP, tex);
      expect(tex._isCubeMap).toBe(true);
    });

    it("createTexture returns a placeholder with a pending sampler desc", function () {
      const gl = createWebGLCompatibilityStub(createFakeState());
      const tex = gl.createTexture();
      expect(tex._isPlaceholder).toBe(true);
      expect(tex._webgpuTexture).toBeNull();
      // The WebGL "always allocate a mip chain" default is preserved.
      expect(tex._samplerDesc.wantsMipmaps).toBe(true);
      expect(tex._samplerDesc.magFilter).toBe("linear");
      expect(tex._samplerDesc.addressModeU).toBe("clamp-to-edge");
    });
  });

  describe("pixelStorei", function () {
    let state;
    let gl;
    beforeEach(function () {
      state = createFakeState();
      gl = createWebGLCompatibilityStub(state);
    });

    it("records UNPACK_FLIP_Y_WEBGL as a boolean", function () {
      gl.pixelStorei(0x9240, true);
      expect(state.pixelStore.unpackFlipY).toBe(true);
    });

    it("records UNPACK_PREMULTIPLY_ALPHA_WEBGL as a boolean", function () {
      gl.pixelStorei(0x9241, 1);
      expect(state.pixelStore.unpackPremultiplyAlpha).toBe(true);
    });

    it("records UNPACK_ALIGNMENT, defaulting non-numeric values to 4", function () {
      gl.pixelStorei(0x0cf5, 8);
      expect(state.pixelStore.unpackAlignment).toBe(8);
      gl.pixelStorei(0x0cf5, true);
      expect(state.pixelStore.unpackAlignment).toBe(4);
    });
  });

  describe("buffer methods (device-null branch)", function () {
    it("createBuffer returns a lazy stable handle when no device is present", function () {
      const gl = createWebGLCompatibilityStub(createFakeState());
      const buffer = gl.createBuffer();
      expect(buffer._webgpuBuffer).toBeNull();
      expect(buffer._size).toBe(0);
      expect(buffer._destroyed).toBe(false);
    });

    it("bindBuffer routes ARRAY_BUFFER to the vertex slot", function () {
      const state = createFakeState();
      const gl = createWebGLCompatibilityStub(state);
      const fakeBuf = {
        _webgpuBuffer: null,
        _size: 0,
        _device: null,
        _destroyed: false,
      };
      gl.bindBuffer(gl.ARRAY_BUFFER, fakeBuf);
      expect(state.boundVertexBuffer).toBe(fakeBuf);
      expect(state.boundIndexBuffer).toBeNull();
    });

    it("bindBuffer routes ELEMENT_ARRAY_BUFFER to the index slot", function () {
      const state = createFakeState();
      const gl = createWebGLCompatibilityStub(state);
      const fakeBuf = {
        _webgpuBuffer: null,
        _size: 0,
        _device: null,
        _destroyed: false,
      };
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, fakeBuf);
      expect(state.boundIndexBuffer).toBe(fakeBuf);
      expect(state.boundVertexBuffer).toBeNull();
    });

    it("bindBuffer with null clears the targeted slot", function () {
      const state = createFakeState();
      const gl = createWebGLCompatibilityStub(state);
      state.boundVertexBuffer = { stale: true };
      gl.bindBuffer(gl.ARRAY_BUFFER, null);
      expect(state.boundVertexBuffer).toBeNull();
    });

    it("vertex-attribute methods are no-ops that don't throw", function () {
      const gl = createWebGLCompatibilityStub(createFakeState());
      expect(function () {
        gl.enableVertexAttribArray(0);
        gl.disableVertexAttribArray(0);
        gl.vertexAttribPointer(0, 3, 0x1406, false, 0, 0);
        gl.vertexAttribDivisor(0, 1);
      }).not.toThrow();
    });
  });

  describe("enable / disable capability tracking", function () {
    let state;
    let gl;
    beforeEach(function () {
      state = createFakeState();
      gl = createWebGLCompatibilityStub(state);
    });

    it("enable toggles the matching capability flag on", function () {
      gl.enable(gl.DEPTH_TEST);
      gl.enable(gl.BLEND);
      gl.enable(gl.CULL_FACE);
      gl.enable(gl.SCISSOR_TEST);
      gl.enable(gl.STENCIL_TEST);
      expect(state.depthTestEnabled).toBe(true);
      expect(state.blendEnabled).toBe(true);
      expect(state.cullFaceEnabled).toBe(true);
      expect(state.scissorTest).toBe(true);
      expect(state.stencilTestEnabled).toBe(true);
    });

    it("disable toggles the matching capability flag off", function () {
      state.depthTestEnabled = true;
      state.blendEnabled = true;
      gl.disable(gl.DEPTH_TEST);
      gl.disable(gl.BLEND);
      expect(state.depthTestEnabled).toBe(false);
      expect(state.blendEnabled).toBe(false);
    });

    it("disabling SCISSOR_TEST also calls disableScissorTest()", function () {
      state.scissorTest = true;
      gl.disable(gl.SCISSOR_TEST);
      expect(state.scissorTest).toBe(false);
      expect(state._scissorDisabled).toBe(true);
    });

    it("ignores unknown capability enums", function () {
      gl.enable(0xdead);
      expect(state.depthTestEnabled).toBe(false);
      expect(state.blendEnabled).toBe(false);
    });
  });

  describe("viewport / scissor forwarding", function () {
    it("viewport forwards (x, y, w, h) to state.setViewport", function () {
      const state = createFakeState();
      const gl = createWebGLCompatibilityStub(state);
      gl.viewport(1, 2, 640, 480);
      expect(state._viewportCall).toEqual([1, 2, 640, 480]);
    });

    it("scissor forwards (x, y, w, h) to state.setScissorRect", function () {
      const state = createFakeState();
      const gl = createWebGLCompatibilityStub(state);
      gl.scissor(3, 4, 100, 50);
      expect(state._scissorCall).toEqual([3, 4, 100, 50]);
    });
  });

  describe("clear value tracking", function () {
    let state;
    let gl;
    beforeEach(function () {
      state = createFakeState();
      gl = createWebGLCompatibilityStub(state);
    });

    it("clearColor stores the four channels on a Color instance", function () {
      gl.clearColor(0.25, 0.5, 0.75, 1.0);
      expect(state.clearColor.red).toBe(0.25);
      expect(state.clearColor.green).toBe(0.5);
      expect(state.clearColor.blue).toBe(0.75);
      expect(state.clearColor.alpha).toBe(1.0);
    });

    it("clearColor is a no-op when r is undefined", function () {
      state.clearColor = "sentinel";
      gl.clearColor();
      expect(state.clearColor).toBe("sentinel");
    });

    it("clearDepth and clearStencil store their value", function () {
      gl.clearDepth(0.5);
      gl.clearStencil(7);
      expect(state.clearDepth).toBe(0.5);
      expect(state.clearStencil).toBe(7);
    });
  });

  describe("blend state tracking", function () {
    let state;
    let gl;
    beforeEach(function () {
      state = createFakeState();
      gl = createWebGLCompatibilityStub(state);
    });

    it("blendFunc sets src/dst RGB and mirrors them to alpha", function () {
      gl.blendFunc(0x0302, 0x0303); // SRC_ALPHA, ONE_MINUS_SRC_ALPHA
      expect(state.blendSrc).toBe("bf:770"); // 0x0302
      expect(state.blendDst).toBe("bf:771"); // 0x0303
      expect(state.blendSrcAlpha).toBe("bf:770");
      expect(state.blendDstAlpha).toBe("bf:771");
    });

    it("blendFuncSeparate sets RGB and alpha independently", function () {
      gl.blendFuncSeparate(1, 0, 0x0302, 0x0303);
      expect(state.blendSrc).toBe("bf:1");
      expect(state.blendDst).toBe("bf:0");
      expect(state.blendSrcAlpha).toBe("bf:770");
      expect(state.blendDstAlpha).toBe("bf:771");
    });

    it("blendEquation sets the op and mirrors it to alpha", function () {
      gl.blendEquation(0x8006); // FUNC_ADD
      expect(state.blendOp).toBe("bo:32774"); // 0x8006
      expect(state.blendOpAlpha).toBe("bo:32774");
    });

    it("blendEquationSeparate sets RGB and alpha ops independently", function () {
      gl.blendEquationSeparate(0x8006, 0x800a);
      expect(state.blendOp).toBe("bo:32774"); // 0x8006
      expect(state.blendOpAlpha).toBe("bo:32778"); // 0x800a
    });
  });

  describe("depth state tracking", function () {
    let state;
    let gl;
    beforeEach(function () {
      state = createFakeState();
      gl = createWebGLCompatibilityStub(state);
    });

    it("depthFunc routes through the compare-function converter", function () {
      gl.depthFunc(0x0203); // LEQUAL
      expect(state.depthCompare).toBe("cf:515"); // 0x0203
    });

    it("depthMask records the write-enable flag", function () {
      gl.depthMask(false);
      expect(state.depthWriteEnabled).toBe(false);
      gl.depthMask(true);
      expect(state.depthWriteEnabled).toBe(true);
    });
  });

  describe("stencil state tracking", function () {
    let state;
    let gl;
    beforeEach(function () {
      state = createFakeState();
      gl = createWebGLCompatibilityStub(state);
    });

    it("stencilFunc records compare, reference, and read mask", function () {
      gl.stencilFunc(0x0202, 3, 0xff); // EQUAL
      expect(state.stencilFrontCompare).toBe("cf:514"); // 0x0202
      expect(state.stencilBackCompare).toBe("cf:514");
      expect(state.stencilReference).toBe(3);
      expect(state.stencilReadMask).toBe(0xff);
    });

    it("stencilMask records the write mask", function () {
      gl.stencilMask(0x0f);
      expect(state.stencilWriteMask).toBe(0x0f);
    });

    it("stencilOp maps GL stencil ops to GPUStencilOperation strings", function () {
      // KEEP (0x1E00), REPLACE (0x1E01), INCR (0x1E02)
      gl.stencilOp(0x1e00, 0x1e01, 0x1e02);
      expect(state.stencilFailOp).toBe("keep");
      expect(state.stencilDepthFailOp).toBe("replace");
      expect(state.stencilPassOp).toBe("increment-clamp");
    });

    it("stencilOp maps wrap + zero + invert ops", function () {
      // INCR_WRAP (0x8507), 0 (ZERO), INVERT (0x150A)
      gl.stencilOp(0x8507, 0, 0x150a);
      expect(state.stencilFailOp).toBe("increment-wrap");
      expect(state.stencilDepthFailOp).toBe("zero");
      expect(state.stencilPassOp).toBe("invert");
    });

    it("stencilOp defaults unknown ops to 'keep'", function () {
      gl.stencilOp(0xdead, 0xbeef, 0xface);
      expect(state.stencilFailOp).toBe("keep");
      expect(state.stencilDepthFailOp).toBe("keep");
      expect(state.stencilPassOp).toBe("keep");
    });
  });

  describe("cull + front-face tracking", function () {
    let state;
    let gl;
    beforeEach(function () {
      state = createFakeState();
      gl = createWebGLCompatibilityStub(state);
    });

    it("cullFace maps FRONT / BACK / other to GPUCullMode", function () {
      gl.cullFace(0x0404); // FRONT
      expect(state.cullMode).toBe("front");
      gl.cullFace(0x0405); // BACK
      expect(state.cullMode).toBe("back");
      gl.cullFace(0x0408); // FRONT_AND_BACK → falls through to "none"
      expect(state.cullMode).toBe("none");
    });

    it("frontFace maps CW → 'cw' and anything else → 'ccw'", function () {
      gl.frontFace(0x0900); // CW
      expect(state.frontFace).toBe("cw");
      gl.frontFace(0x0901); // CCW
      expect(state.frontFace).toBe("ccw");
    });
  });

  describe("colorMask bit packing", function () {
    let state;
    let gl;
    beforeEach(function () {
      state = createFakeState();
      gl = createWebGLCompatibilityStub(state);
    });

    it("packs RGBA booleans into the 0x1/0x2/0x4/0x8 mask", function () {
      gl.colorMask(true, true, true, true);
      expect(state.colorWriteMask).toBe(0xf);
    });

    it("packs each channel independently", function () {
      gl.colorMask(true, false, false, false);
      expect(state.colorWriteMask).toBe(0x1);
      gl.colorMask(false, true, false, false);
      expect(state.colorWriteMask).toBe(0x2);
      gl.colorMask(false, false, true, false);
      expect(state.colorWriteMask).toBe(0x4);
      gl.colorMask(false, false, false, true);
      expect(state.colorWriteMask).toBe(0x8);
    });

    it("packs an all-false mask to 0", function () {
      gl.colorMask(false, false, false, false);
      expect(state.colorWriteMask).toBe(0);
    });
  });

  describe("framebuffer binding", function () {
    it("createFramebuffer registers an entry in state.framebuffers", function () {
      const state = createFakeState();
      const gl = createWebGLCompatibilityStub(state);
      const fbo = gl.createFramebuffer();
      expect(fbo._isWebGPU).toBe(true);
      expect(fbo._colorAttachment).toBeNull();
      expect(state.framebuffers.has(fbo)).toBe(true);
    });

    it("bindFramebuffer(GL_FRAMEBUFFER) sets all three slots", function () {
      const state = createFakeState();
      const gl = createWebGLCompatibilityStub(state);
      const fbo = gl.createFramebuffer();
      gl.bindFramebuffer(0x8d40, fbo); // GL_FRAMEBUFFER
      expect(state.boundFramebuffer).toBe(fbo);
      expect(state.boundReadFramebuffer).toBe(fbo);
      expect(state.boundDrawFramebuffer).toBe(fbo);
    });

    it("bindFramebuffer(GL_READ_FRAMEBUFFER) sets only the read slot", function () {
      const state = createFakeState();
      const gl = createWebGLCompatibilityStub(state);
      const fbo = gl.createFramebuffer();
      gl.bindFramebuffer(0x8ca8, fbo); // GL_READ_FRAMEBUFFER
      expect(state.boundReadFramebuffer).toBe(fbo);
      expect(state.boundFramebuffer).toBeNull();
      expect(state.boundDrawFramebuffer).toBeNull();
    });

    it("bindFramebuffer(GL_DRAW_FRAMEBUFFER) sets only the draw slot", function () {
      const state = createFakeState();
      const gl = createWebGLCompatibilityStub(state);
      const fbo = gl.createFramebuffer();
      gl.bindFramebuffer(0x8ca9, fbo); // GL_DRAW_FRAMEBUFFER
      expect(state.boundDrawFramebuffer).toBe(fbo);
      expect(state.boundFramebuffer).toBeNull();
      expect(state.boundReadFramebuffer).toBeNull();
    });

    it("checkFramebufferStatus always reports FRAMEBUFFER_COMPLETE", function () {
      const gl = createWebGLCompatibilityStub(createFakeState());
      expect(gl.checkFramebufferStatus(0x8d40)).toBe(0x8cd5);
    });
  });

  describe("shader / program object scaffolding", function () {
    let gl;
    beforeEach(function () {
      gl = createWebGLCompatibilityStub(createFakeState());
    });

    it("createShader records the stage type and starts unresolved", function () {
      const vs = gl.createShader(0x8b31); // GL_VERTEX_SHADER
      expect(vs._type).toBe(0x8b31);
      expect(vs._isWebGPU).toBe(true);
      expect(vs._glslSource).toBeNull();
      expect(vs._wgsl).toBeNull();
      expect(vs._wgslReady).toBeNull();
    });

    it("shaderSource records the GLSL source on the shader", function () {
      const vs = gl.createShader(0x8b31);
      gl.shaderSource(vs, "void main(){}");
      expect(vs._glslSource).toBe("void main(){}");
    });

    it("createProgram starts with null attachments and link status", function () {
      const program = gl.createProgram();
      expect(program._isWebGPU).toBe(true);
      expect(program._attachedVertex).toBeNull();
      expect(program._attachedFragment).toBeNull();
      expect(program._linkStatus).toBeNull();
    });

    it("attachShader routes by shader stage type", function () {
      const program = gl.createProgram();
      const vs = gl.createShader(0x8b31); // vertex
      const fs = gl.createShader(0x8b30); // fragment
      gl.attachShader(program, vs);
      gl.attachShader(program, fs);
      expect(program._attachedVertex).toBe(vs);
      expect(program._attachedFragment).toBe(fs);
    });

    it("getShaderParameter is optimistic (true) for the stub path", function () {
      expect(gl.getShaderParameter()).toBe(true);
    });

    it("getProgramParameter(GL_LINK_STATUS) reflects the cached status", function () {
      const program = gl.createProgram();
      // null cached status → not linked yet → false.
      expect(gl.getProgramParameter(program, 0x8b82)).toBe(false);
      program._linkStatus = true;
      expect(gl.getProgramParameter(program, 0x8b82)).toBe(true);
    });

    it("getProgramParameter returns true for non-link-status queries", function () {
      const program = gl.createProgram();
      expect(gl.getProgramParameter(program, 0x1234)).toBe(true);
    });

    it("getActiveUniform / getActiveAttrib synthesize FLOAT entries", function () {
      const program = gl.createProgram();
      expect(gl.getActiveUniform(program, 2)).toEqual({
        name: "uniform_2",
        size: 1,
        type: 0x1406, // GL_FLOAT
      });
      expect(gl.getActiveAttrib(program, 5)).toEqual({
        name: "attrib_5",
        size: 1,
        type: 0x1406,
      });
    });

    it("getUniformLocation wraps the name in a WebGPU handle", function () {
      const program = gl.createProgram();
      expect(gl.getUniformLocation(program, "u_color")).toEqual({
        _name: "u_color",
        _isWebGPU: true,
      });
    });

    it("getAttribLocation maps well-known names and -1 otherwise", function () {
      const program = gl.createProgram();
      expect(gl.getAttribLocation(program, "position")).toBe(0);
      expect(gl.getAttribLocation(program, "normal")).toBe(1);
      expect(gl.getAttribLocation(program, "texCoord")).toBe(2);
      expect(gl.getAttribLocation(program, "color")).toBe(3);
      expect(gl.getAttribLocation(program, "tangent")).toBe(4);
      expect(gl.getAttribLocation(program, "bitangent")).toBe(5);
      expect(gl.getAttribLocation(program, "nope")).toBe(-1);
    });
  });

  describe("getParameter (device-null fallbacks)", function () {
    let gl;
    beforeEach(function () {
      // No device → limits are undefined → spec-minimum fallbacks fire.
      gl = createWebGLCompatibilityStub(createFakeState());
    });

    it("returns identifying strings for vendor/renderer/version", function () {
      expect(gl.getParameter(0x1f00)).toBe(
        "WebGPU (Cesium WebGL Compatibility Stub)",
      ); // GL_VENDOR
      expect(gl.getParameter(0x1f01)).toBe("WebGPU"); // GL_RENDERER
      expect(gl.getParameter(0x1f02)).toBe("WebGL 2.0 (WebGPU compat)"); // GL_VERSION
      expect(gl.getParameter(0x8b8c)).toBe("WGSL via Cesium compat layer"); // GL_SHADING_LANGUAGE_VERSION
    });

    it("falls back to spec-minimum texture limits", function () {
      expect(gl.getParameter(0x0d33)).toBe(8192); // GL_MAX_TEXTURE_SIZE
      expect(gl.getParameter(0x851c)).toBe(8192); // GL_MAX_CUBE_MAP_TEXTURE_SIZE
      expect(gl.getParameter(0x8073)).toBe(2048); // GL_MAX_3D_TEXTURE_SIZE
      expect(gl.getParameter(0x88ff)).toBe(256); // GL_MAX_ARRAY_TEXTURE_LAYERS
    });

    it("computes combined texture units as 2x the per-stage fallback", function () {
      expect(gl.getParameter(0x8872)).toBe(16); // GL_MAX_TEXTURE_IMAGE_UNITS
      expect(gl.getParameter(0x8b4d)).toBe(32); // GL_MAX_COMBINED_TEXTURE_IMAGE_UNITS
    });

    it("returns fixed pixel-pipeline depths", function () {
      expect(gl.getParameter(0x0d56)).toBe(24); // GL_DEPTH_BITS
      expect(gl.getParameter(0x0d57)).toBe(8); // GL_STENCIL_BITS
      expect(gl.getParameter(0x0d52)).toBe(8); // GL_RED_BITS
      expect(gl.getParameter(0x8d57)).toBe(4); // GL_MAX_SAMPLES
      expect(gl.getParameter(0x8d6b)).toBe(0xffffffff); // GL_MAX_ELEMENT_INDEX
    });

    it("returns 0 for unknown parameters", function () {
      expect(gl.getParameter(0xdead)).toBe(0);
    });
  });

  describe("extension stubs", function () {
    let gl;
    beforeEach(function () {
      gl = createWebGLCompatibilityStub(createFakeState());
    });

    it("returns a non-null object for WebGPU-core extensions", function () {
      expect(gl.getExtension("OES_texture_float")).toEqual({});
      expect(gl.getExtension("EXT_color_buffer_float")).toEqual({});
    });

    it("exposes the anisotropic-filter constants", function () {
      const ext = gl.getExtension("EXT_texture_filter_anisotropic");
      expect(ext.TEXTURE_MAX_ANISOTROPY_EXT).toBe(0x84fe);
      expect(ext.MAX_TEXTURE_MAX_ANISOTROPY_EXT).toBe(0x84ff);
    });

    it("exposes the S3TC compressed-format constants", function () {
      const ext = gl.getExtension("WEBGL_compressed_texture_s3tc");
      expect(ext.COMPRESSED_RGB_S3TC_DXT1_EXT).toBe(0x83f0);
      expect(ext.COMPRESSED_RGBA_S3TC_DXT1_EXT).toBe(0x83f1);
      expect(ext.COMPRESSED_RGBA_S3TC_DXT3_EXT).toBe(0x83f2);
      expect(ext.COMPRESSED_RGBA_S3TC_DXT5_EXT).toBe(0x83f3);
    });

    it("returns null for unknown extensions", function () {
      expect(gl.getExtension("EXT_does_not_exist")).toBeNull();
    });

    it("does not advertise WebGL parallel shader compilation", function () {
      expect(gl.getExtension("KHR_parallel_shader_compile")).toBeNull();
      expect(gl.getSupportedExtensions()).not.toContain(
        "KHR_parallel_shader_compile",
      );
    });

    it("getSupportedExtensions lists the known extension keys", function () {
      const names = gl.getSupportedExtensions();
      expect(names).toContain("OES_texture_float");
      expect(names).toContain("WEBGL_lose_context");
      expect(names).toContain("EXT_texture_filter_anisotropic");
    });
  });

  describe("readPixels (sync API can't work on WebGPU)", function () {
    it("always returns null", function () {
      const gl = createWebGLCompatibilityStub(createFakeState());
      expect(gl.readPixels()).toBeNull();
    });
  });

  describe("getCompiledShaderForProgram (device-free paths)", function () {
    it("returns null for a null program", async function () {
      expect(await getCompiledShaderForProgram(null)).toBeNull();
    });

    it("returns the cached modules when already linked", async function () {
      const modules = { vertex: {}, fragment: {} };
      const program = { _programModules: modules };
      expect(await getCompiledShaderForProgram(program)).toBe(modules);
    });

    it("awaits and returns the in-flight link promise", async function () {
      const modules = { vertex: {}, fragment: {} };
      const program = { _linkReady: Promise.resolve(modules) };
      expect(await getCompiledShaderForProgram(program)).toBe(modules);
    });

    it("returns null when neither modules nor a link promise are present", async function () {
      expect(await getCompiledShaderForProgram({})).toBeNull();
    });
  });
});
