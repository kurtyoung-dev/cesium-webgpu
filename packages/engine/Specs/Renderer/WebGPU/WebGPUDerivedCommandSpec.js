import {
  DerivedCommandType,
  WebGPUDerivedCommand,
} from "../../../Source/Renderer/WebGPU/WebGPUDerivedCommand.js";

// ── Test surface ────────────────────────────────────────────────────
//
// WebGPUDerivedCommand (rewritten Batch 248 —
// NEW-DERIVEDCOMMAND-VARIANT-FACTORY) is the centralized pipeline-variant
// factory. Its surface is almost entirely device-free:
//
//   - `deriveDescriptor(base, kind, options)` is a PURE function over the
//     cache-friendly descriptor shape — it never touches a GPUDevice. The
//     shader-module fields are opaque object references the factory only
//     copies, so plain object sentinels stand in for GPUShaderModules.
//   - `resolveVariantPipeline(device, pipelineCache, entry)` is a state
//     machine over the entry slot; both the central-cache path and the
//     direct-create fallback are exercised with stubs (the stub device's
//     createRenderPipeline returns a sentinel — nothing GPU-bound runs).
//   - `deriveCommand(base, overrides)` clones via the command's own
//     clone() (shallow copy fallback) and stamps overrides.
//
// No path here calls a real device.create* — the entire exercised surface
// is deterministic without a GPU.

const VS_MODULE = { __sentinel: "vs-module" };
const FS_MODULE = { __sentinel: "fs-module" };
const SWAP_MODULE = { __sentinel: "swap-module" };

// A representative scene-FB color descriptor (billboard-shaped: blended
// slot 0 + MRT G-buffer placeholder at slot 1, MSAA 4, alpha-blend).
function makeBaseDescriptor() {
  return {
    name: "Test pipeline [bgra8unorm/depth24plus-stencil8/defines=0x0/ms=4]",
    layout: { __sentinel: "pipeline-layout" },
    vertex: {
      module: VS_MODULE,
      entryPoint: "vertexMain",
      buffers: [{ arrayStride: 176, stepMode: "instance", attributes: [] }],
    },
    fragment: {
      module: FS_MODULE,
      entryPoint: "fragmentMain",
      targets: [
        {
          format: "bgra8unorm",
          blend: {
            color: {
              srcFactor: "src-alpha",
              dstFactor: "one-minus-src-alpha",
              operation: "add",
            },
            alpha: {
              srcFactor: "one",
              dstFactor: "one-minus-src-alpha",
              operation: "add",
            },
          },
        },
        { format: "rgba16float", writeMask: 0 },
      ],
    },
    primitive: { topology: "triangle-list", cullMode: "none" },
    depthStencil: {
      format: "depth24plus-stencil8",
      depthWriteEnabled: false,
      depthCompare: "less-equal",
    },
    multisample: { count: 4 },
  };
}

describe("Renderer/WebGPU/WebGPUDerivedCommand", function () {
  describe("DerivedCommandType enum", function () {
    it("exposes the documented string values", function () {
      expect(DerivedCommandType.LOG_DEPTH).toBe("logDepth");
      expect(DerivedCommandType.DEPTH_ONLY).toBe("depthOnly");
      expect(DerivedCommandType.PICK).toBe("pick");
      expect(DerivedCommandType.HDR).toBe("hdr");
      expect(DerivedCommandType.SHADOW).toBe("shadow");
      expect(DerivedCommandType.VELOCITY).toBe("velocity");
    });

    it("has exactly six members", function () {
      expect(Object.keys(DerivedCommandType).length).toBe(6);
    });
  });

  describe("deriveDescriptor — PICK", function () {
    // NEW-WEBGPU-HDR-PICK-FORMAT-CLOSURE — PICK derivation requires an
    // explicit pickFormat (context.pickPipelineFormat); the spec passes the
    // SDR value so slot-0 semantics stay observable.
    const PICK_OPTS = { pickFormat: "bgra8unorm" };

    it("keeps only slot 0 with blend stripped and drops multisample", function () {
      const base = makeBaseDescriptor();
      const d = WebGPUDerivedCommand.deriveDescriptor(
        base,
        DerivedCommandType.PICK,
        PICK_OPTS,
      );
      expect(d.fragment.targets.length).toBe(1);
      expect(d.fragment.targets[0].format).toBe("bgra8unorm");
      expect(d.fragment.targets[0].blend).toBeUndefined();
      expect(d.multisample).toBeUndefined();
    });

    it("stamps the supplied pickFormat over an HDR slot-0 format", function () {
      const base = makeBaseDescriptor();
      base.fragment.targets[0].format = "rgba16float";
      const d = WebGPUDerivedCommand.deriveDescriptor(
        base,
        DerivedCommandType.PICK,
        { pickFormat: "rgba8unorm" },
      );
      expect(d.fragment.targets.length).toBe(1);
      expect(d.fragment.targets[0].format).toBe("rgba8unorm");
    });

    it("throws when options.pickFormat is missing", function () {
      const base = makeBaseDescriptor();
      expect(function () {
        WebGPUDerivedCommand.deriveDescriptor(base, DerivedCommandType.PICK);
      }).toThrowError(/pickFormat/);
      expect(function () {
        WebGPUDerivedCommand.deriveDescriptor(base, DerivedCommandType.PICK, {
          module: SWAP_MODULE,
        });
      }).toThrowError(/pickFormat/);
    });

    it("forces depth write on by default and inherits when disabled", function () {
      const base = makeBaseDescriptor();
      const forced = WebGPUDerivedCommand.deriveDescriptor(
        base,
        DerivedCommandType.PICK,
        PICK_OPTS,
      );
      expect(forced.depthStencil.depthWriteEnabled).toBe(true);
      const inherited = WebGPUDerivedCommand.deriveDescriptor(
        base,
        DerivedCommandType.PICK,
        { forceDepthWriteEnabled: false, pickFormat: "bgra8unorm" },
      );
      expect(inherited.depthStencil.depthWriteEnabled).toBe(false);
    });

    it("swaps both stages' modules via options.module and keeps entry points", function () {
      const base = makeBaseDescriptor();
      const d = WebGPUDerivedCommand.deriveDescriptor(
        base,
        DerivedCommandType.PICK,
        { module: SWAP_MODULE, pickFormat: "bgra8unorm" },
      );
      expect(d.vertex.module).toBe(SWAP_MODULE);
      expect(d.fragment.module).toBe(SWAP_MODULE);
      expect(d.vertex.entryPoint).toBe("vertexMain");
      expect(d.fragment.entryPoint).toBe("fragmentMain");
      // Layout, vertex buffers, and primitive state carry over.
      expect(d.layout).toBe(base.layout);
      expect(d.vertex.buffers).toBe(base.vertex.buffers);
      expect(d.primitive).toBe(base.primitive);
    });

    it("supports the C-R9 fragment-entry-swap style and encodes it in the name", function () {
      const base = makeBaseDescriptor();
      const d = WebGPUDerivedCommand.deriveDescriptor(
        base,
        DerivedCommandType.PICK,
        { fragmentEntryPoint: "fragmentPickMain", pickFormat: "bgra8unorm" },
      );
      expect(d.fragment.module).toBe(FS_MODULE);
      expect(d.fragment.entryPoint).toBe("fragmentPickMain");
      expect(d.name).toContain("::pick");
      expect(d.name).toContain("::fs=fragmentPickMain");
    });

    it("derives a variant-keyed name distinct from the base", function () {
      const base = makeBaseDescriptor();
      const d = WebGPUDerivedCommand.deriveDescriptor(
        base,
        DerivedCommandType.PICK,
        PICK_OPTS,
      );
      expect(d.name).toBe(`${base.name}::pick`);
      expect(d.name).not.toBe(base.name);
    });

    it("never mutates the base descriptor", function () {
      const base = makeBaseDescriptor();
      const snapshot = JSON.stringify(base);
      WebGPUDerivedCommand.deriveDescriptor(base, DerivedCommandType.PICK, {
        module: SWAP_MODULE,
        pickFormat: "bgra8unorm",
      });
      expect(JSON.stringify(base)).toBe(snapshot);
    });

    it("throws when the base descriptor has no fragment stage", function () {
      const base = makeBaseDescriptor();
      delete base.fragment;
      expect(function () {
        WebGPUDerivedCommand.deriveDescriptor(
          base,
          DerivedCommandType.PICK,
          PICK_OPTS,
        );
      }).toThrowError(/no fragment stage/);
    });
  });

  describe("deriveDescriptor — VELOCITY", function () {
    it("targets a single rg16float attachment with read-only depth", function () {
      const base = makeBaseDescriptor();
      const d = WebGPUDerivedCommand.deriveDescriptor(
        base,
        DerivedCommandType.VELOCITY,
        {
          vertexEntryPoint: "vertexVelocityMain",
          fragmentEntryPoint: "fragmentVelocityMain",
        },
      );
      expect(d.fragment.targets).toEqual([{ format: "rg16float" }]);
      expect(d.depthStencil).toEqual({
        format: "depth24plus-stencil8",
        depthWriteEnabled: false,
        depthCompare: "less-equal",
      });
      expect(d.multisample).toBeUndefined();
      expect(d.vertex.entryPoint).toBe("vertexVelocityMain");
      expect(d.fragment.entryPoint).toBe("fragmentVelocityMain");
    });

    it("appends extra vertex-buffer layouts for the prev-instance mirror", function () {
      const base = makeBaseDescriptor();
      const prevLayout = {
        arrayStride: 176,
        stepMode: "instance",
        attributes: [{ shaderLocation: 11, offset: 0, format: "float32x4" }],
      };
      const d = WebGPUDerivedCommand.deriveDescriptor(
        base,
        DerivedCommandType.VELOCITY,
        { extraVertexBufferLayouts: [prevLayout] },
      );
      expect(d.vertex.buffers.length).toBe(2);
      expect(d.vertex.buffers[0]).toBe(base.vertex.buffers[0]);
      expect(d.vertex.buffers[1]).toBe(prevLayout);
    });
  });

  describe("deriveDescriptor — LOG_DEPTH", function () {
    it("bakes the scene-FB sample count (count 1 omits multisample)", function () {
      const base = makeBaseDescriptor();
      const msaa = WebGPUDerivedCommand.deriveDescriptor(
        base,
        DerivedCommandType.LOG_DEPTH,
        { sceneFBSampleCount: 4 },
      );
      expect(msaa.multisample).toEqual({ count: 4 });
      const single = WebGPUDerivedCommand.deriveDescriptor(
        base,
        DerivedCommandType.LOG_DEPTH,
        { sceneFBSampleCount: 1 },
      );
      expect(single.multisample).toBeUndefined();
    });

    it("inherits the base multisample state when no count is supplied", function () {
      const base = makeBaseDescriptor();
      const d = WebGPUDerivedCommand.deriveDescriptor(
        base,
        DerivedCommandType.LOG_DEPTH,
      );
      expect(d.multisample).toEqual({ count: 4 });
    });

    it("preserves the scene-FB target shape (slot 0 + MRT placeholder)", function () {
      const base = makeBaseDescriptor();
      const d = WebGPUDerivedCommand.deriveDescriptor(
        base,
        DerivedCommandType.LOG_DEPTH,
        { module: SWAP_MODULE },
      );
      // Re-stamped through makeSceneFBTargets — slot 0 keeps its format +
      // blend; slot count matches the current MRT mode (2 today).
      expect(d.fragment.targets.length).toBe(base.fragment.targets.length);
      expect(d.fragment.targets[0].format).toBe("bgra8unorm");
      expect(d.fragment.targets[0].blend).toBeDefined();
      expect(d.vertex.module).toBe(SWAP_MODULE);
      expect(d.fragment.module).toBe(SWAP_MODULE);
      expect(d.depthStencil).toBe(base.depthStencil);
      expect(d.name).toBe(`${base.name}::logDepth`);
    });
  });

  describe("deriveDescriptor — DEPTH_ONLY", function () {
    it("zeroes every color target's writeMask and forces depth write", function () {
      const base = makeBaseDescriptor();
      const d = WebGPUDerivedCommand.deriveDescriptor(
        base,
        DerivedCommandType.DEPTH_ONLY,
      );
      expect(d.fragment.targets.length).toBe(2);
      expect(d.fragment.targets[0]).toEqual({
        format: "bgra8unorm",
        writeMask: 0,
      });
      expect(d.fragment.targets[1]).toEqual({
        format: "rgba16float",
        writeMask: 0,
      });
      expect(d.depthStencil.depthWriteEnabled).toBe(true);
    });
  });

  describe("deriveDescriptor — unimplemented kinds", function () {
    it("throws loudly for HDR and SHADOW", function () {
      const base = makeBaseDescriptor();
      expect(function () {
        WebGPUDerivedCommand.deriveDescriptor(base, DerivedCommandType.HDR);
      }).toThrowError(/not implemented/);
      expect(function () {
        WebGPUDerivedCommand.deriveDescriptor(base, DerivedCommandType.SHADOW);
      }).toThrowError(/not implemented/);
    });
  });

  describe("resolveVariantPipeline", function () {
    function makeEntry() {
      return {
        descriptor: makeBaseDescriptor(),
        pipeline: null,
        pending: false,
      };
    }

    it("returns the entry's pipeline immediately when already resolved", function () {
      const entry = makeEntry();
      const sentinel = { __sentinel: "resolved" };
      entry.pipeline = sentinel;
      const result = WebGPUDerivedCommand.resolveVariantPipeline(
        null,
        null,
        entry,
      );
      expect(result).toBe(sentinel);
    });

    it("hits the central cache's sync path", function () {
      const entry = makeEntry();
      const sentinel = { __sentinel: "sync" };
      const cache = {
        getPipelineSync: function () {
          return sentinel;
        },
      };
      const result = WebGPUDerivedCommand.resolveVariantPipeline(
        null,
        cache,
        entry,
      );
      expect(result).toBe(sentinel);
      expect(entry.pipeline).toBe(sentinel);
      expect(entry.pending).toBe(false);
    });

    it("kicks off async creation once and returns null while pending", async function () {
      const entry = makeEntry();
      const sentinel = { __sentinel: "async" };
      let asyncCalls = 0;
      const cache = {
        getPipelineSync: function () {
          return undefined;
        },
        getPipeline: function () {
          asyncCalls++;
          return Promise.resolve(sentinel);
        },
      };
      const first = WebGPUDerivedCommand.resolveVariantPipeline(
        null,
        cache,
        entry,
      );
      expect(first).toBeNull();
      expect(entry.pending).toBe(true);
      // Second call while pending must NOT double-create.
      const second = WebGPUDerivedCommand.resolveVariantPipeline(
        null,
        cache,
        entry,
      );
      expect(second).toBeNull();
      expect(asyncCalls).toBe(1);
      await Promise.resolve();
      expect(entry.pipeline).toBe(sentinel);
      expect(entry.pending).toBe(false);
    });

    it("clears pending on async failure so a retry is possible", async function () {
      const entry = makeEntry();
      const cache = {
        getPipelineSync: function () {
          return undefined;
        },
        getPipeline: function () {
          return Promise.reject(new Error("validation"));
        },
      };
      WebGPUDerivedCommand.resolveVariantPipeline(null, cache, entry);
      expect(entry.pending).toBe(true);
      await Promise.resolve().then(function () {});
      await Promise.resolve();
      expect(entry.pending).toBe(false);
      expect(entry.pipeline).toBeNull();
    });

    it("falls back to direct synchronous creation without a cache", function () {
      const entry = makeEntry();
      const sentinel = { __sentinel: "direct" };
      let descriptorSeen;
      const device = {
        createRenderPipeline: function (gpuDescriptor) {
          descriptorSeen = gpuDescriptor;
          return sentinel;
        },
      };
      const result = WebGPUDerivedCommand.resolveVariantPipeline(
        device,
        null,
        entry,
      );
      expect(result).toBe(sentinel);
      expect(entry.pipeline).toBe(sentinel);
      // The fallback converts the cache-friendly descriptor to the raw
      // WebGPU shape: name → label.
      expect(descriptorSeen.label).toBe(entry.descriptor.name);
      expect(descriptorSeen.vertex.module).toBe(VS_MODULE);
    });
  });

  describe("deriveCommand", function () {
    it("clones via the command's own clone() and stamps overrides", function () {
      const pipeline = { __sentinel: "variant-pipeline" };
      const base = {
        _flag: "base",
        clone: function () {
          const copy = Object.assign({}, base);
          copy._cloned = true;
          return copy;
        },
      };
      const derived = WebGPUDerivedCommand.deriveCommand(base, {
        pipeline: pipeline,
        pickOnly: true,
      });
      expect(derived._cloned).toBe(true);
      expect(derived.pipeline).toBe(pipeline);
      expect(derived.pickOnly).toBe(true);
      expect(base.pipeline).toBeUndefined();
    });

    it("shallow-copies when the command has no clone()", function () {
      const base = { _flag: "base" };
      const derived = WebGPUDerivedCommand.deriveCommand(base, {
        pickOnly: true,
      });
      expect(derived).not.toBe(base);
      expect(derived._flag).toBe("base");
      expect(derived.pickOnly).toBe(true);
      expect(base.pickOnly).toBeUndefined();
    });
  });
});
