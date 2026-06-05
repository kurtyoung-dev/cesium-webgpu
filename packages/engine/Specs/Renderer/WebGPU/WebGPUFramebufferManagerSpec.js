import WebGPUFramebufferManager from "../../../Source/Renderer/WebGPU/WebGPUFramebufferManager.js";

describe("Renderer/WebGPU/WebGPUFramebufferManager", function () {
  // WebGPUFramebufferManager's only device-bound code lives in update()
  // (device.createTexture), clear() (commandEncoder.beginRenderPass), and
  // the _destroyTextures()/destroy() texture .destroy() calls. The
  // constructor merely validates + stores config, and getRenderPassDescriptor()
  // is a pure function of the stored config plus the (possibly null) texture
  // view arrays — it never touches a device. The specs below cover ONLY those
  // device-free surfaces:
  //   - constructor defaults + custom-option storage (getters)
  //   - constructor validation throws (debug pragmas are live in the Spec build)
  //   - depth-only vs depth-stencil format selection
  //   - isMSAA / isReady / isDestroyed / isDirty() / markDirty() state logic
  //   - texture accessors on a fresh (never-updated) instance → null
  //   - getRenderPassDescriptor() descriptor construction: attachment count,
  //     MSAA-resolve vs single-sample branch (exercised by seeding the private
  //     view arrays with fake views — no device needed), depth/stencil
  //     attachment shape, default load/store ops, option overrides, and the
  //     transient-depth "discard" default
  //   - destroy() on a fresh instance (no textures to .destroy())
  //
  // SKIPPED (device-bound — require a real GPUDevice/queue/encoder):
  //   update(), clear(), and the texture .destroy() side of _destroyTextures()
  //   when textures actually exist.

  // A throwaway value standing in for a GPUTextureView when we seed the
  // private view arrays. getRenderPassDescriptor() only copies these into
  // the descriptor — it never inspects them.
  function fakeView(tag) {
    return /** @type {any} */ ({ __fakeView: tag });
  }

  // Force a manager into a "rendered" state by seeding the private view
  // arrays directly, so getRenderPassDescriptor() can be exercised without
  // calling update() (which needs a device). The field names below are the
  // runtime private fields of WebGPUFramebufferManager.
  function seedColorViews(fb, length, withMsaa) {
    fb._colorTextureViews = [];
    fb._msaaColorTextureViews = [];
    for (let i = 0; i < length; i++) {
      fb._colorTextureViews.push(fakeView(`color${i}`));
      fb._msaaColorTextureViews.push(withMsaa ? fakeView(`msaa${i}`) : null);
    }
  }

  function seedDepthView(fb, tag) {
    fb._depthTextureView = fakeView(tag ?? "depth");
  }

  describe("constructor defaults", function () {
    it("is defined", function () {
      expect(WebGPUFramebufferManager).toBeDefined();
    });

    it("applies documented defaults with no options", function () {
      const fb = new WebGPUFramebufferManager();
      expect(fb.width).toBe(0);
      expect(fb.height).toBe(0);
      expect(fb.numSamples).toBe(1);
      expect(fb.isMSAA).toBe(false);
      expect(fb.isReady).toBe(false);
      expect(fb.isDestroyed).toBe(false);
    });

    it("accepts an empty options object", function () {
      expect(() => new WebGPUFramebufferManager({})).not.toThrow();
    });

    it("stores a custom numSamples and reports MSAA", function () {
      const fb = new WebGPUFramebufferManager({ numSamples: 4 });
      expect(fb.numSamples).toBe(4);
      expect(fb.isMSAA).toBe(true);
    });
  });

  describe("constructor validation (debug)", function () {
    it("throws when no attachment type is enabled", function () {
      expect(function () {
        return new WebGPUFramebufferManager({
          color: false,
          depth: false,
          depthStencil: false,
        });
      }).toThrowDeveloperError();
    });

    it("throws when both depth and depthStencil are requested", function () {
      expect(function () {
        return new WebGPUFramebufferManager({
          depth: true,
          depthStencil: true,
        });
      }).toThrowDeveloperError();
    });

    it("does not throw for color-only (the default)", function () {
      expect(() => new WebGPUFramebufferManager()).not.toThrow();
    });

    it("does not throw for depth-only", function () {
      expect(
        () => new WebGPUFramebufferManager({ color: false, depth: true }),
      ).not.toThrow();
    });

    it("does not throw for depthStencil-only", function () {
      expect(
        () =>
          new WebGPUFramebufferManager({ color: false, depthStencil: true }),
      ).not.toThrow();
    });
  });

  describe("isMSAA", function () {
    it("is false for numSamples of 1", function () {
      expect(new WebGPUFramebufferManager({ numSamples: 1 }).isMSAA).toBe(
        false,
      );
    });

    it("is true for numSamples greater than 1", function () {
      expect(new WebGPUFramebufferManager({ numSamples: 2 }).isMSAA).toBe(true);
    });
  });

  describe("isReady", function () {
    it("is false before any update (dirty + no device)", function () {
      expect(new WebGPUFramebufferManager().isReady).toBe(false);
    });
  });

  describe("isDirty()", function () {
    it("is dirty on a fresh instance regardless of requested size", function () {
      const fb = new WebGPUFramebufferManager();
      // _isDirty starts true and _device is null, so any size is dirty.
      expect(fb.isDirty(800, 600)).toBe(true);
    });

    it("is dirty when the requested numSamples differs from current", function () {
      const fb = new WebGPUFramebufferManager({ numSamples: 1 });
      expect(fb.isDirty(800, 600, 4)).toBe(true);
    });

    it("falls back to the current numSamples when none is supplied", function () {
      const fb = new WebGPUFramebufferManager({ numSamples: 4 });
      // Still dirty because _isDirty is true and _device is null, but this
      // proves the numSamples default path does not throw.
      expect(fb.isDirty(800, 600)).toBe(true);
    });
  });

  describe("markDirty()", function () {
    it("keeps the instance not-ready", function () {
      const fb = new WebGPUFramebufferManager();
      fb.markDirty();
      expect(fb.isReady).toBe(false);
      expect(fb.isDirty(1, 1)).toBe(true);
    });
  });

  describe("texture accessors on a fresh instance", function () {
    it("returns null for getColorTexture()", function () {
      expect(new WebGPUFramebufferManager().getColorTexture()).toBeNull();
    });

    it("returns null for getColorTexture(index) out of range", function () {
      expect(new WebGPUFramebufferManager().getColorTexture(3)).toBeNull();
    });

    it("returns null for getColorTextureView()", function () {
      expect(new WebGPUFramebufferManager().getColorTextureView()).toBeNull();
    });

    it("returns null for getDepthTexture()", function () {
      expect(new WebGPUFramebufferManager().getDepthTexture()).toBeNull();
    });

    it("returns null for getDepthTextureView()", function () {
      expect(new WebGPUFramebufferManager().getDepthTextureView()).toBeNull();
    });
  });

  describe("getRenderPassDescriptor() — color attachments", function () {
    it("emits one single-sample color attachment with default ops", function () {
      const fb = new WebGPUFramebufferManager();
      seedColorViews(fb, 1, false);
      const desc = fb.getRenderPassDescriptor();

      expect(desc.colorAttachments.length).toBe(1);
      const a = desc.colorAttachments[0];
      expect(a.view).toBe(fb._colorTextureViews[0]);
      expect(a.resolveTarget).toBeUndefined();
      expect(a.loadOp).toBe("clear");
      expect(a.storeOp).toBe("store");
      // Default clear color is transparent black.
      expect(a.clearValue).toEqual({ r: 0, g: 0, b: 0, a: 0 });
      // No depth/stencil requested by default.
      expect(desc.depthStencilAttachment).toBeUndefined();
    });

    it("emits one attachment per MRT color slot", function () {
      const fb = new WebGPUFramebufferManager({ colorAttachmentsLength: 3 });
      seedColorViews(fb, 3, false);
      const desc = fb.getRenderPassDescriptor();
      expect(desc.colorAttachments.length).toBe(3);
    });

    it("uses MSAA view + resolveTarget and forces storeOp discard for MSAA", function () {
      const fb = new WebGPUFramebufferManager({ numSamples: 4 });
      seedColorViews(fb, 1, true);
      const desc = fb.getRenderPassDescriptor();

      const a = desc.colorAttachments[0];
      // MSAA texture is the render target; single-sample is the resolve target.
      expect(a.view).toBe(fb._msaaColorTextureViews[0]);
      expect(a.resolveTarget).toBe(fb._colorTextureViews[0]);
      // The MSAA source is always discarded after resolve.
      expect(a.storeOp).toBe("discard");
    });

    it("emits no color attachments when color is disabled", function () {
      const fb = new WebGPUFramebufferManager({
        color: false,
        depthStencil: true,
      });
      seedDepthView(fb);
      const desc = fb.getRenderPassDescriptor();
      expect(desc.colorAttachments.length).toBe(0);
    });

    it("honors a clearColor override", function () {
      const fb = new WebGPUFramebufferManager();
      seedColorViews(fb, 1, false);
      const clearColor = { r: 0.1, g: 0.2, b: 0.3, a: 1 };
      const desc = fb.getRenderPassDescriptor({ clearColor });
      expect(desc.colorAttachments[0].clearValue).toBe(clearColor);
    });

    it("honors loadOp / storeOp overrides on a single-sample target", function () {
      const fb = new WebGPUFramebufferManager();
      seedColorViews(fb, 1, false);
      const desc = fb.getRenderPassDescriptor({
        loadOp: "load",
        storeOp: "store",
      });
      expect(desc.colorAttachments[0].loadOp).toBe("load");
      expect(desc.colorAttachments[0].storeOp).toBe("store");
    });

    it("carries a constructor clearColor by default", function () {
      const clearColor = { r: 0.5, g: 0.5, b: 0.5, a: 1 };
      const fb = new WebGPUFramebufferManager({ clearColor });
      seedColorViews(fb, 1, false);
      const desc = fb.getRenderPassDescriptor();
      expect(desc.colorAttachments[0].clearValue).toBe(clearColor);
    });
  });

  describe("getRenderPassDescriptor() — depth-stencil attachment", function () {
    it("emits a depth-stencil attachment with stencil ops when depthStencil is set", function () {
      const fb = new WebGPUFramebufferManager({
        color: false,
        depthStencil: true,
      });
      seedDepthView(fb, "ds");
      const desc = fb.getRenderPassDescriptor();

      const ds = desc.depthStencilAttachment;
      expect(ds).toBeDefined();
      expect(ds.view).toBe(fb._depthTextureView);
      expect(ds.depthClearValue).toBe(1.0);
      expect(ds.depthLoadOp).toBe("clear");
      // depthSamplable defaults false → transient depth discard default.
      expect(ds.depthStoreOp).toBe("discard");
      // Stencil ops are present for a combined depth-stencil target.
      expect(ds.stencilClearValue).toBe(0);
      expect(ds.stencilLoadOp).toBe("clear");
      expect(ds.stencilStoreOp).toBe("discard");
    });

    it("emits a depth-only attachment WITHOUT stencil ops", function () {
      const fb = new WebGPUFramebufferManager({ color: false, depth: true });
      seedDepthView(fb, "d");
      const desc = fb.getRenderPassDescriptor();

      const ds = desc.depthStencilAttachment;
      expect(ds).toBeDefined();
      expect(ds.depthLoadOp).toBe("clear");
      expect(ds.depthStoreOp).toBe("discard");
      // Depth-only target carries no stencil ops.
      expect(ds.stencilClearValue).toBeUndefined();
      expect(ds.stencilLoadOp).toBeUndefined();
      expect(ds.stencilStoreOp).toBeUndefined();
    });

    it("defaults depthStoreOp to 'store' when the depth texture is samplable", function () {
      const fb = new WebGPUFramebufferManager({
        color: false,
        depth: true,
        depthSamplable: true,
      });
      seedDepthView(fb, "d");
      const desc = fb.getRenderPassDescriptor();
      expect(desc.depthStencilAttachment.depthStoreOp).toBe("store");
    });

    it("honors depth load/store and clear-value overrides", function () {
      const fb = new WebGPUFramebufferManager({ color: false, depth: true });
      seedDepthView(fb, "d");
      const desc = fb.getRenderPassDescriptor({
        depthLoadOp: "load",
        depthStoreOp: "store",
        depthClearValue: 0.25,
      });
      const ds = desc.depthStencilAttachment;
      expect(ds.depthLoadOp).toBe("load");
      expect(ds.depthStoreOp).toBe("store");
      expect(ds.depthClearValue).toBe(0.25);
    });

    it("honors a stencilClearValue override for a depth-stencil target", function () {
      const fb = new WebGPUFramebufferManager({
        color: false,
        depthStencil: true,
      });
      seedDepthView(fb, "ds");
      const desc = fb.getRenderPassDescriptor({ stencilClearValue: 7 });
      expect(desc.depthStencilAttachment.stencilClearValue).toBe(7);
    });

    it("omits the depth-stencil attachment when the depth view is null", function () {
      // depthStencil requested but never seeded → no depth view → no attachment.
      const fb = new WebGPUFramebufferManager({ depthStencil: true });
      seedColorViews(fb, 1, false);
      const desc = fb.getRenderPassDescriptor();
      expect(desc.depthStencilAttachment).toBeUndefined();
    });
  });

  describe("getRenderPassDescriptor() — color + depth combined", function () {
    it("emits both color and depth-stencil attachments", function () {
      const fb = new WebGPUFramebufferManager({ depthStencil: true });
      seedColorViews(fb, 1, false);
      seedDepthView(fb, "ds");
      const desc = fb.getRenderPassDescriptor();
      expect(desc.colorAttachments.length).toBe(1);
      expect(desc.depthStencilAttachment).toBeDefined();
    });
  });

  describe("destroy()", function () {
    it("is safe on a fresh instance and flips isDestroyed", function () {
      const fb = new WebGPUFramebufferManager();
      expect(() => fb.destroy()).not.toThrow();
      expect(fb.isDestroyed).toBe(true);
    });

    it("leaves the instance dirty and not-ready after destroy", function () {
      const fb = new WebGPUFramebufferManager();
      fb.destroy();
      expect(fb.isReady).toBe(false);
      expect(fb.isDirty(800, 600)).toBe(true);
    });
  });
});
