import {
  createBindGroupLayouts,
  createPipelineLayout,
  createSamplers,
  createPlaceholderTexture,
} from "../../../Source/Renderer/WebGPU/WebGPUGlobeSurfaceLayouts.js";

// These specs exercise the PURE descriptor-construction logic of the four
// globe-surface layout builders. None of them depend on real GPU behavior:
// each function deterministically translates a fixed input shape into
// WebGPU descriptor objects (bind-group-layout entries, a pipeline-layout
// composition, sampler configs, a 1×1 placeholder texture). We capture
// those descriptors with a recording stub `GPUDevice` and assert the
// binding indices / visibilities / filter + address modes / format + size /
// usage flags / BGL composition order that the source hard-codes.
//
// No real `requestAdapter()` / `requestDevice()` is used, so these run in
// any Karma browser regardless of WebGPU support. The functions DO call
// `device.create*` + `device.queue.write*`, but the stub records the
// descriptor arguments and returns tagged sentinels — we never touch a
// live GPU queue, command encoder result, or rendered output.

// The module (and its WebGPUBindGroupLayoutHelpers / WebGPUEffectsBindGroup
// / WebGPUClusteredLightingBGL dependencies) reads these WebGPU global
// constants at module-evaluation and call time. Provide spec-stable values
// matching the WebGPU spec so visibility / usage bitmasks resolve.
if (typeof globalThis.GPUShaderStage === "undefined") {
  globalThis.GPUShaderStage = {
    VERTEX: 0x1,
    FRAGMENT: 0x2,
    COMPUTE: 0x4,
  };
}
if (typeof globalThis.GPUBufferUsage === "undefined") {
  globalThis.GPUBufferUsage = {
    MAP_READ: 0x0001,
    MAP_WRITE: 0x0002,
    COPY_SRC: 0x0004,
    COPY_DST: 0x0008,
    INDEX: 0x0010,
    VERTEX: 0x0020,
    UNIFORM: 0x0040,
    STORAGE: 0x0080,
    INDIRECT: 0x0100,
    QUERY_RESOLVE: 0x0200,
  };
}
if (typeof globalThis.GPUTextureUsage === "undefined") {
  globalThis.GPUTextureUsage = {
    COPY_SRC: 0x01,
    COPY_DST: 0x02,
    TEXTURE_BINDING: 0x04,
    STORAGE_BINDING: 0x08,
    RENDER_ATTACHMENT: 0x10,
  };
}

// Recording stub GPUDevice. Each `create*` returns a tagged sentinel and
// stashes the descriptor it was given so the spec can assert on it. The
// queue / command-encoder surface is no-op (the placeholder-effects helper
// clears a depth texture via render passes; we just swallow those).
function createRecordingDevice() {
  const records = {
    bindGroupLayouts: [],
    pipelineLayouts: [],
    samplers: [],
    textures: [],
    buffers: [],
    bindGroups: [],
    writeTextures: [],
    writeBuffers: [],
  };

  const noopRenderPass = {
    end() {},
  };
  const encoder = {
    beginRenderPass() {
      return noopRenderPass;
    },
    finish() {
      return { __commandBuffer: true };
    },
  };

  const device = {
    __records: records,
    createBindGroupLayout(descriptor) {
      const handle = { __bgl: true, descriptor };
      records.bindGroupLayouts.push(descriptor);
      return handle;
    },
    createPipelineLayout(descriptor) {
      const handle = { __pipelineLayout: true, descriptor };
      records.pipelineLayouts.push(descriptor);
      return handle;
    },
    createSampler(descriptor) {
      const handle = { __sampler: true, descriptor };
      records.samplers.push(descriptor);
      return handle;
    },
    createTexture(descriptor) {
      const handle = {
        __texture: true,
        descriptor,
        createView(viewDescriptor) {
          return { __view: true, of: handle, viewDescriptor };
        },
      };
      records.textures.push(descriptor);
      return handle;
    },
    createBuffer(descriptor) {
      const handle = { __buffer: true, descriptor };
      records.buffers.push(descriptor);
      return handle;
    },
    createBindGroup(descriptor) {
      const handle = { __bindGroup: true, descriptor };
      records.bindGroups.push(descriptor);
      return handle;
    },
    createCommandEncoder() {
      return encoder;
    },
    queue: {
      submit() {},
      writeTexture(destination, data, layout, size) {
        records.writeTextures.push({ destination, data, layout, size });
      },
      writeBuffer(buffer, offset, data) {
        records.writeBuffers.push({ buffer, offset, data });
      },
    },
  };
  return device;
}

// A LayoutsHost with a recording device and the 11 write-target slots
// nulled, matching the renderer's pre-initialize state.
function createHost() {
  const device = createRecordingDevice();
  return {
    _device: device,
    // NEW-WEBGPU-DEFAULT-LIMIT-GLOBE-LAYOUT (Batch 246): the per-device
    // imagery slot count drives the group-1 texture-binding count + the
    // device-shape-aware label. The renderer computes this via
    // `computeGlobeImagerySlotCount` at init; mirror the full-limit value
    // (16) here so the spec exercises the 31-texture pipeline-layout shape.
    _imagerySlotCount: 16,
    _bindGroupLayout0: null,
    _bindGroupLayout1: null,
    _bindGroupLayout2: null,
    _effectsBGL: null,
    _placeholderEffectsBG: null,
    _pipelineLayout: null,
    _sampler: null,
    _waterMaskSampler: null,
    _oceanNormalSampler: null,
    _placeholderTexture: null,
    _placeholderView: null,
  };
}

describe("Renderer/WebGPU/WebGPUGlobeSurfaceLayouts", function () {
  describe("exported surface", function () {
    it("exports the four layout builders as functions", function () {
      expect(typeof createBindGroupLayouts).toBe("function");
      expect(typeof createPipelineLayout).toBe("function");
      expect(typeof createSamplers).toBe("function");
      expect(typeof createPlaceholderTexture).toBe("function");
    });
  });

  describe("createSamplers", function () {
    // Three samplers with specific filter + address-mode configs. These
    // are correctness-critical: the water-mask sampler MUST be linear so
    // the WGSL smoothstep produces smooth coastlines, and the ocean
    // normal sampler MUST repeat for tiled waves.
    let host;
    let samplers;
    beforeEach(function () {
      host = createHost();
      createSamplers(host);
      samplers = host._device.__records.samplers;
    });

    it("creates exactly three samplers", function () {
      expect(samplers.length).toBe(3);
    });

    it("writes all three sampler handles onto the host", function () {
      expect(host._sampler).not.toBeNull();
      expect(host._waterMaskSampler).not.toBeNull();
      expect(host._oceanNormalSampler).not.toBeNull();
    });

    it("imagery sampler is trilinear clamp-to-edge", function () {
      const s = samplers[0];
      expect(s.label).toBe("Globe terrain sampler");
      expect(s.magFilter).toBe("linear");
      expect(s.minFilter).toBe("linear");
      expect(s.mipmapFilter).toBe("linear");
      expect(s.addressModeU).toBe("clamp-to-edge");
      expect(s.addressModeV).toBe("clamp-to-edge");
    });

    it("water-mask sampler is bilinear clamp-to-edge with no mipmap filter", function () {
      const s = samplers[1];
      expect(s.label).toBe("Globe water mask sampler");
      expect(s.magFilter).toBe("linear");
      expect(s.minFilter).toBe("linear");
      // Bilinear: mipmapFilter intentionally omitted so the smoothstep
      // coastline transition can't be defeated by a nearest mip step.
      expect(s.mipmapFilter).toBeUndefined();
      expect(s.addressModeU).toBe("clamp-to-edge");
      expect(s.addressModeV).toBe("clamp-to-edge");
    });

    it("ocean normal sampler is trilinear repeat", function () {
      const s = samplers[2];
      expect(s.label).toBe("Globe ocean normal sampler");
      expect(s.magFilter).toBe("linear");
      expect(s.minFilter).toBe("linear");
      expect(s.mipmapFilter).toBe("linear");
      expect(s.addressModeU).toBe("repeat");
      expect(s.addressModeV).toBe("repeat");
    });
  });

  describe("createPlaceholderTexture", function () {
    let host;
    beforeEach(function () {
      host = createHost();
      createPlaceholderTexture(host);
    });

    it("creates a 1×1 rgba8unorm texture with TEXTURE_BINDING | COPY_DST usage", function () {
      const tex = host._device.__records.textures[0];
      expect(tex.label).toBe("Globe placeholder texture");
      expect(tex.size).toEqual([1, 1]);
      expect(tex.format).toBe("rgba8unorm");
      expect(tex.usage).toBe(
        GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
      );
    });

    it("uploads a single opaque-white texel via writeTexture", function () {
      const write = host._device.__records.writeTextures[0];
      expect(write).toBeDefined();
      expect(Array.from(write.data)).toEqual([255, 255, 255, 255]);
      expect(write.layout.bytesPerRow).toBe(4);
      expect(write.size).toEqual([1, 1]);
    });

    it("writes both the texture and its view onto the host", function () {
      expect(host._placeholderTexture).not.toBeNull();
      expect(host._placeholderView).not.toBeNull();
    });
  });

  describe("createBindGroupLayouts", function () {
    let host;
    beforeEach(function () {
      host = createHost();
      createBindGroupLayouts(host);
    });

    it("writes the three globe BGLs plus the effects BGL onto the host", function () {
      expect(host._bindGroupLayout0).not.toBeNull();
      expect(host._bindGroupLayout1).not.toBeNull();
      expect(host._bindGroupLayout2).not.toBeNull();
      expect(host._effectsBGL).not.toBeNull();
      expect(host._placeholderEffectsBG).not.toBeNull();
    });

    // Group 0 — two uniform buffers (camera + tile), both vertex+fragment.
    describe("group 0 — camera + tile uniforms", function () {
      let layout;
      beforeEach(function () {
        layout = host._bindGroupLayout0.descriptor;
      });

      it("is labeled and has two entries", function () {
        expect(layout.label).toBe(
          "Globe terrain uniforms layout (dynamic offset)",
        );
        expect(layout.entries.length).toBe(2);
      });

      it("binds two uniform buffers at 0 and 1, both VERTEX|FRAGMENT", function () {
        const vf = GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT;
        expect(layout.entries[0].binding).toBe(0);
        expect(layout.entries[0].buffer.type).toBe("uniform");
        expect(layout.entries[0].visibility).toBe(vf);
        expect(layout.entries[1].binding).toBe(1);
        expect(layout.entries[1].buffer.type).toBe("uniform");
        expect(layout.entries[1].visibility).toBe(vf);
      });
    });

    // Group 1 — 16 day-imagery textures + a shared sampler at binding 16.
    describe("group 1 — day imagery textures + sampler", function () {
      let layout;
      beforeEach(function () {
        layout = host._bindGroupLayout1.descriptor;
      });

      it("is labeled and has 17 entries (16 textures + 1 sampler)", function () {
        // NEW-WEBGPU-DEFAULT-LIMIT-GLOBE-LAYOUT (Batch 246): the label
        // carries the per-device slot count so devtools can tell the
        // full-limit (16) shape apart from the reduced (1) compat shape.
        expect(layout.label).toBe("Globe terrain textures layout (16 slots)");
        expect(layout.entries.length).toBe(17);
      });

      it("binds 16 fragment textures at bindings 0..15", function () {
        for (let i = 0; i < 16; i++) {
          const e = layout.entries[i];
          expect(e.binding).toBe(i);
          expect(e.visibility).toBe(GPUShaderStage.FRAGMENT);
          expect(e.texture).toBeDefined();
          // texture() helper defaults: float 2D non-multisampled.
          expect(e.texture.sampleType).toBe("float");
          expect(e.texture.viewDimension).toBe("2d");
        }
      });

      it("places the shared imagery sampler at binding 16 (FRAGMENT, filtering)", function () {
        const e = layout.entries[16];
        expect(e.binding).toBe(16);
        expect(e.visibility).toBe(GPUShaderStage.FRAGMENT);
        expect(e.sampler).toBeDefined();
        expect(e.sampler.type).toBe("filtering");
      });
    });

    // Group 2 — water mask + ocean normal + globe-material payload.
    // Single-shape layout: texture/sampler pairs at 0/1 and 2/3, then a
    // material UBO at 4, image texture/sampler at 5/6, heights
    // texture/sampler at 7/8 — 9 entries total.
    describe("group 2 — water mask + ocean normal + material", function () {
      let layout;
      beforeEach(function () {
        layout = host._bindGroupLayout2.descriptor;
      });

      it("is labeled and has nine entries", function () {
        expect(layout.label).toBe(
          "Globe water mask + ocean normal + material layout",
        );
        expect(layout.entries.length).toBe(9);
      });

      it("follows the texture/sampler + UBO + image + heights binding shape", function () {
        const e = layout.entries;
        // 0: water mask texture, 1: water mask sampler
        expect(e[0].binding).toBe(0);
        expect(e[0].texture).toBeDefined();
        expect(e[1].binding).toBe(1);
        expect(e[1].sampler).toBeDefined();
        // 2: ocean normal texture, 3: ocean normal sampler
        expect(e[2].binding).toBe(2);
        expect(e[2].texture).toBeDefined();
        expect(e[3].binding).toBe(3);
        expect(e[3].sampler).toBeDefined();
        // 4: material UBO
        expect(e[4].binding).toBe(4);
        expect(e[4].buffer).toBeDefined();
        expect(e[4].buffer.type).toBe("uniform");
        // 5/6: material image texture + sampler
        expect(e[5].binding).toBe(5);
        expect(e[5].texture).toBeDefined();
        expect(e[6].binding).toBe(6);
        expect(e[6].sampler).toBeDefined();
        // 7/8: material heights texture + sampler
        expect(e[7].binding).toBe(7);
        expect(e[7].texture).toBeDefined();
        expect(e[8].binding).toBe(8);
        expect(e[8].sampler).toBeDefined();
      });

      it("marks every group-2 entry FRAGMENT-visible", function () {
        for (const e of layout.entries) {
          expect(e.visibility).toBe(GPUShaderStage.FRAGMENT);
        }
      });
    });

    it("stays within the WebGPU maxBindGroups: 4 spec floor (3 globe + 1 effects)", function () {
      // The three globe BGLs + the shared effects BGL compose into exactly
      // four bind groups — the rationale for folding material slots into
      // group 2 instead of a fifth group.
      const total = [
        host._bindGroupLayout0,
        host._bindGroupLayout1,
        host._bindGroupLayout2,
        host._effectsBGL,
      ].filter((bgl) => bgl !== null).length;
      expect(total).toBe(4);
    });
  });

  describe("createPipelineLayout", function () {
    it("composes the four globe BGLs in group order 0,1,2,effects", function () {
      const host = createHost();
      // Populate the BGL slots first (the pipeline layout reads them).
      createBindGroupLayouts(host);
      createPipelineLayout(host);

      expect(host._pipelineLayout).not.toBeNull();
      const descriptor = host._pipelineLayout.descriptor;
      expect(descriptor.label).toBe("Globe terrain pipeline layout");
      expect(descriptor.bindGroupLayouts.length).toBe(4);
      // Exact identity + order: group 0, 1, 2, then the effects BGL.
      expect(descriptor.bindGroupLayouts[0]).toBe(host._bindGroupLayout0);
      expect(descriptor.bindGroupLayouts[1]).toBe(host._bindGroupLayout1);
      expect(descriptor.bindGroupLayouts[2]).toBe(host._bindGroupLayout2);
      expect(descriptor.bindGroupLayouts[3]).toBe(host._effectsBGL);
    });
  });
});
