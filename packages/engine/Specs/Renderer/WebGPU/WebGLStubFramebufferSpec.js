import { createFramebufferStubs } from "../../../Source/Renderer/WebGPU/Stubs/WebGLStubFramebuffer.js";

describe("Renderer/WebGPU/Stubs/WebGLStubFramebuffer", function () {
  // These are pure-logic tests. The framebuffer/renderbuffer stub methods
  // only MUTATE a plain `WebGLStubState` object (the same one WebGPUContext
  // owns) and read back from it. The only methods that need a live
  // GPUDevice are `renderbufferStorage` /
  // `renderbufferStorageMultisample`, which call
  // `state.device.createTexture(...)` — those are NOT exercised here. Every
  // other method routes attachments, toggles bound-target slots, and tracks
  // framebuffer bookkeeping in a Map with no GPU work, so a bare stub state
  // (and, where a method calls `_texture.destroy()`, a fake texture with a
  // `destroy` spy) is sufficient.

  // A fresh fake state for each test, mirroring the subset of
  // WebGLStubState the framebuffer stub reads/writes. `device` defaults to
  // null; the only method that branches on it here is `createRenderbuffer`,
  // which returns `{}` when device is null and a fresh wrapper otherwise —
  // both branches are device-free (no createTexture call).
  function makeState(device) {
    return {
      device: device ?? null,
      boundFramebuffer: null,
      boundReadFramebuffer: null,
      boundDrawFramebuffer: null,
      boundRenderbuffer: null,
      framebuffers: new Map(),
    };
  }

  // A fake GPUTexture wrapper exposing only the `destroy` hook the stub
  // touches, so delete paths can assert destruction without a real device.
  function fakeTextureAttachment() {
    return {
      _texture: { destroyed: 0, destroy() {} },
    };
  }

  // WebGL attachment / target / status constants copied verbatim from the
  // module under test so a careless renumber there fails one of these
  // assertions instead of silently mis-routing attachments at runtime.
  const GL_FRAMEBUFFER = 0x8d40;
  const GL_READ_FRAMEBUFFER = 0x8ca8;
  const GL_DRAW_FRAMEBUFFER = 0x8ca9;
  const GL_COLOR_ATTACHMENT0 = 0x8ce0;
  const GL_DEPTH_ATTACHMENT = 0x8d00;
  const GL_FRAMEBUFFER_COMPLETE = 0x8cd5;

  describe("createFramebufferStubs", function () {
    it("returns the full set of stub methods", function () {
      const stubs = createFramebufferStubs(makeState(), function () {});
      const expectedMethods = [
        "createFramebuffer",
        "bindFramebuffer",
        "deleteFramebuffer",
        "framebufferTexture2D",
        "framebufferRenderbuffer",
        "checkFramebufferStatus",
        "createRenderbuffer",
        "bindRenderbuffer",
        "deleteRenderbuffer",
        "renderbufferStorage",
        "renderbufferStorageMultisample",
      ];
      for (const name of expectedMethods) {
        expect(typeof stubs[name]).toBe("function");
      }
    });
  });

  describe("createFramebuffer", function () {
    it("returns a framebuffer with null attachments and the WebGPU flag", function () {
      const stubs = createFramebufferStubs(makeState(), function () {});
      const fbo = stubs.createFramebuffer();
      expect(fbo._colorAttachment).toBeNull();
      expect(fbo._depthAttachment).toBeNull();
      expect(fbo._isWebGPU).toBe(true);
    });

    it("assigns a string id (createGuid) to each framebuffer", function () {
      const stubs = createFramebufferStubs(makeState(), function () {});
      const fbo = stubs.createFramebuffer();
      expect(typeof fbo._id).toBe("string");
      expect(fbo._id.length).toBeGreaterThan(0);
    });

    it("gives distinct framebuffers distinct ids", function () {
      const stubs = createFramebufferStubs(makeState(), function () {});
      const a = stubs.createFramebuffer();
      const b = stubs.createFramebuffer();
      expect(a._id).not.toBe(b._id);
    });

    it("registers the framebuffer in state.framebuffers with null attachments", function () {
      const state = makeState();
      const stubs = createFramebufferStubs(state, function () {});
      const fbo = stubs.createFramebuffer();
      expect(state.framebuffers.has(fbo)).toBe(true);
      const data = state.framebuffers.get(fbo);
      expect(data.colorAttachment).toBeNull();
      expect(data.depthAttachment).toBeNull();
    });
  });

  describe("bindFramebuffer target routing", function () {
    it("GL_FRAMEBUFFER sets the legacy slot AND both read/draw slots", function () {
      const state = makeState();
      const stubs = createFramebufferStubs(state, function () {});
      const fbo = stubs.createFramebuffer();
      stubs.bindFramebuffer(GL_FRAMEBUFFER, fbo);
      expect(state.boundFramebuffer).toBe(fbo);
      expect(state.boundReadFramebuffer).toBe(fbo);
      expect(state.boundDrawFramebuffer).toBe(fbo);
    });

    it("GL_READ_FRAMEBUFFER sets only the read slot", function () {
      const state = makeState();
      const stubs = createFramebufferStubs(state, function () {});
      const fbo = stubs.createFramebuffer();
      stubs.bindFramebuffer(GL_READ_FRAMEBUFFER, fbo);
      expect(state.boundReadFramebuffer).toBe(fbo);
      expect(state.boundDrawFramebuffer).toBeNull();
      expect(state.boundFramebuffer).toBeNull();
    });

    it("GL_DRAW_FRAMEBUFFER sets only the draw slot", function () {
      const state = makeState();
      const stubs = createFramebufferStubs(state, function () {});
      const fbo = stubs.createFramebuffer();
      stubs.bindFramebuffer(GL_DRAW_FRAMEBUFFER, fbo);
      expect(state.boundDrawFramebuffer).toBe(fbo);
      expect(state.boundReadFramebuffer).toBeNull();
      expect(state.boundFramebuffer).toBeNull();
    });

    it("GL_FRAMEBUFFER with null unbinds all three slots", function () {
      const state = makeState();
      const stubs = createFramebufferStubs(state, function () {});
      const fbo = stubs.createFramebuffer();
      stubs.bindFramebuffer(GL_FRAMEBUFFER, fbo);
      stubs.bindFramebuffer(GL_FRAMEBUFFER, null);
      expect(state.boundFramebuffer).toBeNull();
      expect(state.boundReadFramebuffer).toBeNull();
      expect(state.boundDrawFramebuffer).toBeNull();
    });
  });

  describe("framebufferTexture2D attachment routing", function () {
    it("routes a color attachment into the bound framebuffer's record", function () {
      const state = makeState();
      const stubs = createFramebufferStubs(state, function () {});
      const fbo = stubs.createFramebuffer();
      stubs.bindFramebuffer(GL_FRAMEBUFFER, fbo);
      const tex = fakeTextureAttachment();
      stubs.framebufferTexture2D(0, GL_COLOR_ATTACHMENT0, 0, tex, 0);
      expect(state.framebuffers.get(fbo).colorAttachment).toBe(tex);
      expect(fbo._colorAttachment).toBe(tex);
      expect(state.framebuffers.get(fbo).depthAttachment).toBeNull();
    });

    it("routes a depth attachment into the bound framebuffer's record", function () {
      const state = makeState();
      const stubs = createFramebufferStubs(state, function () {});
      const fbo = stubs.createFramebuffer();
      stubs.bindFramebuffer(GL_FRAMEBUFFER, fbo);
      const tex = fakeTextureAttachment();
      stubs.framebufferTexture2D(0, GL_DEPTH_ATTACHMENT, 0, tex, 0);
      expect(state.framebuffers.get(fbo).depthAttachment).toBe(tex);
      expect(fbo._depthAttachment).toBe(tex);
      expect(state.framebuffers.get(fbo).colorAttachment).toBeNull();
    });

    it("is a no-op when no framebuffer is bound", function () {
      const state = makeState();
      const stubs = createFramebufferStubs(state, function () {});
      const fbo = stubs.createFramebuffer();
      const tex = fakeTextureAttachment();
      // boundFramebuffer is null — nothing should be recorded and the call
      // must not throw.
      expect(function () {
        stubs.framebufferTexture2D(0, GL_COLOR_ATTACHMENT0, 0, tex, 0);
      }).not.toThrow();
      expect(state.framebuffers.get(fbo).colorAttachment).toBeNull();
      expect(fbo._colorAttachment).toBeNull();
    });

    it("ignores attachment points other than color0 / depth", function () {
      const state = makeState();
      const stubs = createFramebufferStubs(state, function () {});
      const fbo = stubs.createFramebuffer();
      stubs.bindFramebuffer(GL_FRAMEBUFFER, fbo);
      const tex = fakeTextureAttachment();
      // GL_STENCIL_ATTACHMENT (0x8D20) is not handled by this stub.
      stubs.framebufferTexture2D(0, 0x8d20, 0, tex, 0);
      expect(state.framebuffers.get(fbo).colorAttachment).toBeNull();
      expect(state.framebuffers.get(fbo).depthAttachment).toBeNull();
    });
  });

  describe("framebufferRenderbuffer attachment routing", function () {
    it("routes a color renderbuffer into the bound framebuffer's record", function () {
      const state = makeState();
      const stubs = createFramebufferStubs(state, function () {});
      const fbo = stubs.createFramebuffer();
      stubs.bindFramebuffer(GL_FRAMEBUFFER, fbo);
      const rb = fakeTextureAttachment();
      stubs.framebufferRenderbuffer(0, GL_COLOR_ATTACHMENT0, 0, rb);
      expect(state.framebuffers.get(fbo).colorAttachment).toBe(rb);
      expect(fbo._colorAttachment).toBe(rb);
    });

    it("routes a depth renderbuffer into the bound framebuffer's record", function () {
      const state = makeState();
      const stubs = createFramebufferStubs(state, function () {});
      const fbo = stubs.createFramebuffer();
      stubs.bindFramebuffer(GL_FRAMEBUFFER, fbo);
      const rb = fakeTextureAttachment();
      stubs.framebufferRenderbuffer(0, GL_DEPTH_ATTACHMENT, 0, rb);
      expect(state.framebuffers.get(fbo).depthAttachment).toBe(rb);
      expect(fbo._depthAttachment).toBe(rb);
    });

    it("is a no-op when no framebuffer is bound", function () {
      const state = makeState();
      const stubs = createFramebufferStubs(state, function () {});
      const fbo = stubs.createFramebuffer();
      const rb = fakeTextureAttachment();
      expect(function () {
        stubs.framebufferRenderbuffer(0, GL_COLOR_ATTACHMENT0, 0, rb);
      }).not.toThrow();
      expect(state.framebuffers.get(fbo).colorAttachment).toBeNull();
    });

    it("is a no-op when the renderbuffer argument is null", function () {
      const state = makeState();
      const stubs = createFramebufferStubs(state, function () {});
      const fbo = stubs.createFramebuffer();
      stubs.bindFramebuffer(GL_FRAMEBUFFER, fbo);
      stubs.framebufferRenderbuffer(0, GL_COLOR_ATTACHMENT0, 0, null);
      expect(state.framebuffers.get(fbo).colorAttachment).toBeNull();
    });
  });

  describe("deleteFramebuffer", function () {
    it("removes the framebuffer entry from state.framebuffers", function () {
      const state = makeState();
      const stubs = createFramebufferStubs(state, function () {});
      const fbo = stubs.createFramebuffer();
      expect(state.framebuffers.has(fbo)).toBe(true);
      stubs.deleteFramebuffer(fbo);
      expect(state.framebuffers.has(fbo)).toBe(false);
    });

    it("destroys color and depth attachment textures it owns", function () {
      const state = makeState();
      const stubs = createFramebufferStubs(state, function () {});
      const fbo = stubs.createFramebuffer();
      stubs.bindFramebuffer(GL_FRAMEBUFFER, fbo);
      let colorDestroys = 0;
      let depthDestroys = 0;
      const color = {
        _texture: {
          destroy() {
            colorDestroys += 1;
          },
        },
      };
      const depth = {
        _texture: {
          destroy() {
            depthDestroys += 1;
          },
        },
      };
      stubs.framebufferTexture2D(0, GL_COLOR_ATTACHMENT0, 0, color, 0);
      stubs.framebufferTexture2D(0, GL_DEPTH_ATTACHMENT, 0, depth, 0);
      stubs.deleteFramebuffer(fbo);
      expect(colorDestroys).toBe(1);
      expect(depthDestroys).toBe(1);
    });

    it("is a no-op when the framebuffer is null", function () {
      const state = makeState();
      const stubs = createFramebufferStubs(state, function () {});
      expect(function () {
        stubs.deleteFramebuffer(null);
      }).not.toThrow();
    });

    it("is a no-op when the framebuffer was never registered", function () {
      const state = makeState();
      const stubs = createFramebufferStubs(state, function () {});
      // A framebuffer-shaped object the stub never created → not in the Map.
      const orphan = {
        _id: "x",
        _colorAttachment: null,
        _depthAttachment: null,
      };
      expect(function () {
        stubs.deleteFramebuffer(orphan);
      }).not.toThrow();
    });
  });

  describe("checkFramebufferStatus", function () {
    it("always reports GL_FRAMEBUFFER_COMPLETE", function () {
      const stubs = createFramebufferStubs(makeState(), function () {});
      expect(stubs.checkFramebufferStatus(GL_FRAMEBUFFER)).toBe(
        GL_FRAMEBUFFER_COMPLETE,
      );
    });
  });

  describe("createRenderbuffer", function () {
    it("returns an empty object when no device is present", function () {
      const stubs = createFramebufferStubs(makeState(null), function () {});
      const rb = stubs.createRenderbuffer();
      expect(rb).toEqual({});
    });

    it("returns a default renderbuffer wrapper when a device is present", function () {
      // A truthy bare stub satisfies the `if (!state.device)` guard; the
      // method itself never calls anything on the device.
      const stubs = createFramebufferStubs(
        makeState(/** @type {any} */ ({})),
        function () {},
      );
      const rb = stubs.createRenderbuffer();
      expect(typeof rb._id).toBe("string");
      expect(rb._id.length).toBeGreaterThan(0);
      expect(rb._texture).toBeNull();
      expect(rb._format).toBeNull();
      expect(rb._width).toBe(0);
      expect(rb._height).toBe(0);
      expect(rb._isWebGPU).toBe(true);
    });

    it("gives distinct renderbuffers distinct ids", function () {
      const stubs = createFramebufferStubs(
        makeState(/** @type {any} */ ({})),
        function () {},
      );
      const a = stubs.createRenderbuffer();
      const b = stubs.createRenderbuffer();
      expect(a._id).not.toBe(b._id);
    });
  });

  describe("bindRenderbuffer", function () {
    it("records the bound renderbuffer in state", function () {
      const state = makeState();
      const stubs = createFramebufferStubs(state, function () {});
      const rb = { _id: "rb" };
      stubs.bindRenderbuffer(0, rb);
      expect(state.boundRenderbuffer).toBe(rb);
    });

    it("clears the bound renderbuffer when passed null", function () {
      const state = makeState();
      const stubs = createFramebufferStubs(state, function () {});
      stubs.bindRenderbuffer(0, { _id: "rb" });
      stubs.bindRenderbuffer(0, null);
      expect(state.boundRenderbuffer).toBeNull();
    });
  });

  describe("deleteRenderbuffer", function () {
    it("destroys the underlying texture when present", function () {
      const stubs = createFramebufferStubs(makeState(), function () {});
      let destroys = 0;
      const rb = {
        _texture: {
          destroy() {
            destroys += 1;
          },
        },
      };
      stubs.deleteRenderbuffer(rb);
      expect(destroys).toBe(1);
    });

    it("is a no-op when the renderbuffer has no texture", function () {
      const stubs = createFramebufferStubs(makeState(), function () {});
      expect(function () {
        stubs.deleteRenderbuffer({ _texture: null });
      }).not.toThrow();
    });

    it("is a no-op when the renderbuffer is null", function () {
      const stubs = createFramebufferStubs(makeState(), function () {});
      expect(function () {
        stubs.deleteRenderbuffer(null);
      }).not.toThrow();
    });
  });

  describe("device-bound storage methods (guard branch only)", function () {
    // The success path of renderbufferStorage[Multisample] calls
    // state.device.createTexture and is intentionally NOT exercised here.
    // Their early-return guards (no bound renderbuffer, or no device) are
    // device-free and worth pinning so a guard regression fails fast.
    it("renderbufferStorage early-returns when no renderbuffer is bound", function () {
      const state = makeState(/** @type {any} */ ({}));
      const stubs = createFramebufferStubs(state, function () {});
      expect(function () {
        stubs.renderbufferStorage(0, 0x81a5, 16, 16);
      }).not.toThrow();
    });

    it("renderbufferStorage early-returns when no device is present", function () {
      const state = makeState(null);
      state.boundRenderbuffer = { _texture: null };
      const stubs = createFramebufferStubs(state, function () {});
      expect(function () {
        stubs.renderbufferStorage(0, 0x81a5, 16, 16);
      }).not.toThrow();
      // No texture was created (device-free path).
      expect(state.boundRenderbuffer._texture).toBeNull();
    });

    it("renderbufferStorageMultisample early-returns when no device is present", function () {
      const state = makeState(null);
      state.boundRenderbuffer = { _texture: null };
      const stubs = createFramebufferStubs(state, function () {});
      expect(function () {
        stubs.renderbufferStorageMultisample(0, 4, 0x88f0, 16, 16);
      }).not.toThrow();
      expect(state.boundRenderbuffer._texture).toBeNull();
    });
  });
});
