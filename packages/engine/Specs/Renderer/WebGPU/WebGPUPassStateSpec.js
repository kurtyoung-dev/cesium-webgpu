import WebGPUPassState from "../../../Source/Renderer/WebGPU/WebGPUPassState.js";

describe("Renderer/WebGPU/WebGPUPassState", function () {
  // These specs cover the PURE behavior of WebGPUPassState — constructor
  // defaults, the msaaSampleCount validation setter, the effective
  // viewport/scissor accessors, the render-pass-descriptor builder, and
  // clone(). None of these paths touch a real GPUDevice/queue: the
  // descriptor builder only reads opaque texture-view references off a
  // plain object and copies them through, and the context is just a bag
  // of width/height numbers. So the whole suite runs in headless Karma
  // without WebGPU support. The `context` parameter is stored verbatim
  // by the constructor, so a plain fake object stands in for the real
  // CesiumGraphicsContext (which is only a TS type annotation here).

  function makeContext(overrides) {
    return Object.assign(
      {
        drawingBufferWidth: 800,
        drawingBufferHeight: 600,
        canvas: { width: 1024, height: 768 },
      },
      overrides,
    );
  }

  describe("constructor", function () {
    it("stores the supplied context", function () {
      const ctx = makeContext();
      const ps = new WebGPUPassState(ctx);
      expect(ps.context).toBe(ctx);
    });

    it("initializes all override fields to undefined", function () {
      const ps = new WebGPUPassState(makeContext());
      expect(ps.framebuffer).toBeUndefined();
      expect(ps.blendingEnabled).toBeUndefined();
      expect(ps.scissorTestEnabled).toBeUndefined();
      expect(ps.scissorRect).toBeUndefined();
      expect(ps.viewport).toBeUndefined();
      expect(ps.depthTestEnabled).toBeUndefined();
      expect(ps.depthWriteEnabled).toBeUndefined();
      expect(ps.cullFaceEnabled).toBeUndefined();
      expect(ps.stencilTestEnabled).toBeUndefined();
      expect(ps.blendConstant).toBeUndefined();
      expect(ps.renderTarget).toBeUndefined();
    });

    it("initializes scalar defaults (stencilReference 0, clears false)", function () {
      const ps = new WebGPUPassState(makeContext());
      expect(ps.stencilReference).toBe(0);
      expect(ps.clearColor).toBe(false);
      expect(ps.clearDepth).toBe(false);
      expect(ps.clearStencil).toBe(false);
    });

    it("defaults msaaSampleCount to 1", function () {
      const ps = new WebGPUPassState(makeContext());
      expect(ps.msaaSampleCount).toBe(1);
    });
  });

  describe("msaaSampleCount setter", function () {
    it("accepts 1", function () {
      const ps = new WebGPUPassState(makeContext());
      ps.msaaSampleCount = 1;
      expect(ps.msaaSampleCount).toBe(1);
    });

    it("accepts 4", function () {
      const ps = new WebGPUPassState(makeContext());
      ps.msaaSampleCount = 4;
      expect(ps.msaaSampleCount).toBe(4);
    });

    it("clamps any unsupported sample count to 1", function () {
      // WebGPU only supports 1 and 4; 2, 8, 0 all fall back to 1.
      const ps = new WebGPUPassState(makeContext());
      ps.msaaSampleCount = 4;
      ps.msaaSampleCount = 2;
      expect(ps.msaaSampleCount).toBe(1);
      ps.msaaSampleCount = 4;
      ps.msaaSampleCount = 8;
      expect(ps.msaaSampleCount).toBe(1);
      ps.msaaSampleCount = 4;
      ps.msaaSampleCount = 0;
      expect(ps.msaaSampleCount).toBe(1);
    });
  });

  describe("getEffectiveViewport", function () {
    it("returns the explicit viewport when one is set", function () {
      const ps = new WebGPUPassState(makeContext());
      const vp = { x: 10, y: 20, width: 100, height: 200 };
      ps.viewport = vp;
      expect(ps.getEffectiveViewport()).toBe(vp);
    });

    it("falls back to context drawingBuffer dimensions when no viewport", function () {
      const ps = new WebGPUPassState(makeContext());
      expect(ps.getEffectiveViewport()).toEqual({
        x: 0,
        y: 0,
        width: 800,
        height: 600,
      });
    });

    it("falls back to canvas dimensions when drawingBuffer dimensions are falsy", function () {
      const ps = new WebGPUPassState(
        makeContext({ drawingBufferWidth: 0, drawingBufferHeight: 0 }),
      );
      expect(ps.getEffectiveViewport()).toEqual({
        x: 0,
        y: 0,
        width: 1024,
        height: 768,
      });
    });

    it("falls back to 1x1 when no dimensions are available at all", function () {
      const ps = new WebGPUPassState({
        drawingBufferWidth: 0,
        drawingBufferHeight: 0,
        canvas: undefined,
      });
      expect(ps.getEffectiveViewport()).toEqual({
        x: 0,
        y: 0,
        width: 1,
        height: 1,
      });
    });
  });

  describe("getEffectiveScissorRect", function () {
    it("returns undefined when scissor testing is not enabled", function () {
      const ps = new WebGPUPassState(makeContext());
      ps.scissorRect = { x: 0, y: 0, width: 10, height: 10 };
      ps.scissorTestEnabled = false;
      expect(ps.getEffectiveScissorRect()).toBeUndefined();
    });

    it("returns undefined when enabled but no rect is set", function () {
      const ps = new WebGPUPassState(makeContext());
      ps.scissorTestEnabled = true;
      ps.scissorRect = undefined;
      expect(ps.getEffectiveScissorRect()).toBeUndefined();
    });

    it("returns the rect only when both enabled and a rect are present", function () {
      const ps = new WebGPUPassState(makeContext());
      const rect = { x: 1, y: 2, width: 3, height: 4 };
      ps.scissorTestEnabled = true;
      ps.scissorRect = rect;
      expect(ps.getEffectiveScissorRect()).toBe(rect);
    });
  });

  describe("createRenderPassDescriptor", function () {
    function makeRenderTarget(overrides) {
      // Texture views are opaque references; the descriptor builder copies
      // them through without calling any GPU API, so plain string tokens
      // are sufficient stand-ins.
      return Object.assign(
        {
          colorTextureView: "color-view",
          depthStencilTextureView: "depth-view",
        },
        overrides,
      );
    }

    it("emits empty colorAttachments and no depthStencil when no renderTarget", function () {
      const ps = new WebGPUPassState(makeContext());
      const desc = ps.createRenderPassDescriptor();
      expect(desc.colorAttachments).toEqual([]);
      expect(desc.depthStencilAttachment).toBeUndefined();
    });

    it("uses 'load' loadOps by default (no clears)", function () {
      const ps = new WebGPUPassState(makeContext());
      ps.renderTarget = makeRenderTarget();
      const desc = ps.createRenderPassDescriptor();
      expect(desc.colorAttachments[0].loadOp).toBe("load");
      expect(desc.depthStencilAttachment.depthLoadOp).toBe("load");
      expect(desc.depthStencilAttachment.stencilLoadOp).toBe("load");
    });

    it("uses 'clear' loadOps when the clear flags are set", function () {
      const ps = new WebGPUPassState(makeContext());
      ps.renderTarget = makeRenderTarget();
      ps.clearColor = true;
      ps.clearDepth = true;
      ps.clearStencil = true;
      const desc = ps.createRenderPassDescriptor();
      expect(desc.colorAttachments[0].loadOp).toBe("clear");
      expect(desc.depthStencilAttachment.depthLoadOp).toBe("clear");
      expect(desc.depthStencilAttachment.stencilLoadOp).toBe("clear");
    });

    it("builds a color attachment with view and store op from the render target field", function () {
      const ps = new WebGPUPassState(makeContext());
      ps.renderTarget = makeRenderTarget();
      const att = ps.createRenderPassDescriptor().colorAttachments[0];
      expect(att.view).toBe("color-view");
      expect(att.storeOp).toBe("store");
    });

    it("prefers the getColorTextureView() getter over the field", function () {
      const ps = new WebGPUPassState(makeContext());
      ps.renderTarget = makeRenderTarget({
        getColorTextureView: () => "getter-color-view",
      });
      const att = ps.createRenderPassDescriptor().colorAttachments[0];
      expect(att.view).toBe("getter-color-view");
    });

    it("sets clearValue only when clearColor is true AND a clear color is provided", function () {
      const clearColor = { r: 1, g: 0, b: 0, a: 1 };

      // clearColor flag false → no clearValue even if a value is passed.
      const psA = new WebGPUPassState(makeContext());
      psA.renderTarget = makeRenderTarget();
      const attA =
        psA.createRenderPassDescriptor(clearColor).colorAttachments[0];
      expect(attA.clearValue).toBeUndefined();

      // clearColor flag true but no value passed → no clearValue.
      const psB = new WebGPUPassState(makeContext());
      psB.renderTarget = makeRenderTarget();
      psB.clearColor = true;
      const attB = psB.createRenderPassDescriptor().colorAttachments[0];
      expect(attB.clearValue).toBeUndefined();

      // Both present → clearValue applied.
      const psC = new WebGPUPassState(makeContext());
      psC.renderTarget = makeRenderTarget();
      psC.clearColor = true;
      const attC =
        psC.createRenderPassDescriptor(clearColor).colorAttachments[0];
      expect(attC.clearValue).toBe(clearColor);
    });

    it("sets resolveTarget only when the render target exposes a resolve view", function () {
      const psNoResolve = new WebGPUPassState(makeContext());
      psNoResolve.renderTarget = makeRenderTarget();
      expect(
        psNoResolve.createRenderPassDescriptor().colorAttachments[0]
          .resolveTarget,
      ).toBeUndefined();

      const psResolve = new WebGPUPassState(makeContext());
      psResolve.renderTarget = makeRenderTarget({
        resolveTextureView: "resolve-view",
      });
      expect(
        psResolve.createRenderPassDescriptor().colorAttachments[0]
          .resolveTarget,
      ).toBe("resolve-view");
    });

    it("omits the depthStencilAttachment when the render target has no depth view", function () {
      const ps = new WebGPUPassState(makeContext());
      ps.renderTarget = makeRenderTarget({
        depthStencilTextureView: undefined,
      });
      const desc = ps.createRenderPassDescriptor();
      expect(desc.depthStencilAttachment).toBeUndefined();
    });

    it("prefers getDepthStencilTextureView() over the field", function () {
      const ps = new WebGPUPassState(makeContext());
      ps.renderTarget = makeRenderTarget({
        getDepthStencilTextureView: () => "getter-depth-view",
      });
      const desc = ps.createRenderPassDescriptor();
      expect(desc.depthStencilAttachment.view).toBe("getter-depth-view");
    });

    it("fills depthStencil store ops and default clear values", function () {
      const ps = new WebGPUPassState(makeContext());
      ps.renderTarget = makeRenderTarget();
      const ds = ps.createRenderPassDescriptor().depthStencilAttachment;
      expect(ds.depthStoreOp).toBe("store");
      expect(ds.stencilStoreOp).toBe("store");
      // Defaults applied via `?? 1.0` and `?? 0`.
      expect(ds.depthClearValue).toBe(1.0);
      expect(ds.stencilClearValue).toBe(0);
    });

    it("honors explicit depth/stencil clear values", function () {
      const ps = new WebGPUPassState(makeContext());
      ps.renderTarget = makeRenderTarget();
      const ds = ps.createRenderPassDescriptor(
        undefined,
        0.25,
        7,
      ).depthStencilAttachment;
      expect(ds.depthClearValue).toBe(0.25);
      expect(ds.stencilClearValue).toBe(7);
    });
  });

  describe("clone", function () {
    function makePopulated() {
      const ps = new WebGPUPassState(makeContext());
      ps.framebuffer = { fb: true };
      ps.blendingEnabled = true;
      ps.scissorTestEnabled = true;
      ps.scissorRect = { x: 1, y: 2, width: 3, height: 4 };
      ps.viewport = { x: 5, y: 6, width: 7, height: 8 };
      ps.depthTestEnabled = false;
      ps.depthWriteEnabled = true;
      ps.cullFaceEnabled = false;
      ps.stencilTestEnabled = true;
      ps.stencilReference = 9;
      ps.clearColor = true;
      ps.clearDepth = true;
      ps.clearStencil = true;
      ps.renderTarget = { rt: true };
      ps.msaaSampleCount = 4;
      return ps;
    }

    it("copies all scalar and override fields by value", function () {
      const ps = makePopulated();
      const c = ps.clone();
      expect(c).not.toBe(ps);
      expect(c.context).toBe(ps.context);
      expect(c.blendingEnabled).toBe(true);
      expect(c.scissorTestEnabled).toBe(true);
      expect(c.depthTestEnabled).toBe(false);
      expect(c.depthWriteEnabled).toBe(true);
      expect(c.cullFaceEnabled).toBe(false);
      expect(c.stencilTestEnabled).toBe(true);
      expect(c.stencilReference).toBe(9);
      expect(c.clearColor).toBe(true);
      expect(c.clearDepth).toBe(true);
      expect(c.clearStencil).toBe(true);
      expect(c.msaaSampleCount).toBe(4);
    });

    it("shares framebuffer and renderTarget references (shallow copy)", function () {
      const ps = makePopulated();
      const c = ps.clone();
      expect(c.framebuffer).toBe(ps.framebuffer);
      expect(c.renderTarget).toBe(ps.renderTarget);
    });

    it("deep-copies scissorRect into a new object with equal values", function () {
      const ps = makePopulated();
      const c = ps.clone();
      expect(c.scissorRect).not.toBe(ps.scissorRect);
      expect(c.scissorRect).toEqual(ps.scissorRect);
    });

    it("deep-copies viewport into a new object with equal values", function () {
      const ps = makePopulated();
      const c = ps.clone();
      expect(c.viewport).not.toBe(ps.viewport);
      expect(c.viewport).toEqual(ps.viewport);
    });

    it("leaves undefined scissorRect/viewport undefined on the clone", function () {
      const ps = new WebGPUPassState(makeContext());
      const c = ps.clone();
      expect(c.scissorRect).toBeUndefined();
      expect(c.viewport).toBeUndefined();
    });

    it("deep-copies an array-style blendConstant into a new array", function () {
      const ps = new WebGPUPassState(makeContext());
      ps.blendConstant = [0.1, 0.2, 0.3, 0.4];
      const c = ps.clone();
      expect(c.blendConstant).not.toBe(ps.blendConstant);
      expect(Array.isArray(c.blendConstant)).toBe(true);
      expect(c.blendConstant).toEqual([0.1, 0.2, 0.3, 0.4]);
    });

    it("deep-copies a dict-style blendConstant into a new object", function () {
      const ps = new WebGPUPassState(makeContext());
      ps.blendConstant = { r: 0.1, g: 0.2, b: 0.3, a: 0.4 };
      const c = ps.clone();
      expect(c.blendConstant).not.toBe(ps.blendConstant);
      expect(Array.isArray(c.blendConstant)).toBe(false);
      expect(c.blendConstant).toEqual({ r: 0.1, g: 0.2, b: 0.3, a: 0.4 });
    });

    it("leaves an undefined blendConstant undefined on the clone", function () {
      const ps = new WebGPUPassState(makeContext());
      const c = ps.clone();
      expect(c.blendConstant).toBeUndefined();
    });

    it("applies overrides after copying base fields", function () {
      const ps = makePopulated();
      const c = ps.clone({ stencilReference: 42, clearColor: false });
      expect(c.stencilReference).toBe(42);
      expect(c.clearColor).toBe(false);
      // Untouched fields still reflect the source.
      expect(c.clearDepth).toBe(true);
    });
  });
});
