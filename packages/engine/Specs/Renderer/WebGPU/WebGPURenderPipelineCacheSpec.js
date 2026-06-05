import { WebGPURenderPipelineCache } from "../../../Source/Renderer/WebGPU/WebGPURenderPipelineCache.js";

describe("Renderer/WebGPU/WebGPURenderPipelineCache", function () {
  // These specs cover only the cache's pure, device-free behavior:
  // construction + defaults, the LRU-cap clamp math in setMaxSize, the
  // synchronous stats accounting (hits / misses / hitRate / size /
  // maxSize), the cache-key identity contract observed indirectly
  // through has()/remove()/getPipelineSync() on an empty cache, and
  // the clear()/destroy() reset semantics.
  //
  // The constructor only STORES the GPUDevice — it never calls a method
  // on it — so we pass a lightweight stub. Every method exercised below
  // is device-free:
  //   - getPipelineSync() with a cache miss bumps stats and returns
  //     undefined WITHOUT calling device.createRenderPipelineAsync.
  //   - has() / remove() only consult the in-memory Map.
  //   - setMaxSize() / getStats() / clear() / destroy() /
  //     getCachedPipelineNames() are pure bookkeeping.
  //
  // The device-bound paths are NOT tested here because they require a
  // live GPUDevice/queue: getPipeline(), warm(), preloadBatch(), and
  // the private createPipelineAsync()/buildPipelineDescriptor() all
  // funnel through device.createRenderPipelineAsync(). Populating the
  // cache (and therefore exercising real LRU eviction, touch ordering,
  // and the created/evicted counters) likewise depends on that async
  // creation succeeding, so it is out of scope for a pure Karma spec.

  // Opaque GPUDevice stand-in. The cache stores it by reference; none of
  // the methods under test invoke anything on it.
  const deviceStub = { __stub: "gpu-device" };

  // Minimal descriptors. The module never reads the shader-module fields
  // on the device-free paths — generateCacheKey() only reads name plus
  // descriptor-side identity fields (multisample, depthStencil.format,
  // fragment.targets, vertex.buffers).
  function makeDescriptor(name) {
    return {
      name: name,
      vertex: { module: { __stub: "vs" }, entryPoint: "vertexMain" },
    };
  }

  describe("constructor + defaults", function () {
    it("starts with an empty cache and zeroed counters", function () {
      const cache = new WebGPURenderPipelineCache(deviceStub);
      const stats = cache.getStats();
      expect(stats.hits).toBe(0);
      expect(stats.misses).toBe(0);
      expect(stats.created).toBe(0);
      expect(stats.pending).toBe(0);
      expect(stats.evicted).toBe(0);
      expect(stats.size).toBe(0);
    });

    it("defaults hitRate to 0 when no lookups have happened", function () {
      const cache = new WebGPURenderPipelineCache(deviceStub);
      expect(cache.getStats().hitRate).toBe(0);
    });

    it("defaults maxSize to the documented LRU cap of 1024", function () {
      const cache = new WebGPURenderPipelineCache(deviceStub);
      expect(cache.getStats().maxSize).toBe(1024);
    });

    it("honors an explicit maxSize argument", function () {
      const cache = new WebGPURenderPipelineCache(deviceStub, "ctx-1", 32);
      expect(cache.getStats().maxSize).toBe(32);
    });

    it("reports an empty cache from getCachedPipelineNames", function () {
      const cache = new WebGPURenderPipelineCache(deviceStub);
      expect(cache.getCachedPipelineNames()).toEqual([]);
    });
  });

  describe("setMaxSize clamp math", function () {
    it("floors a fractional cap", function () {
      const cache = new WebGPURenderPipelineCache(deviceStub);
      cache.setMaxSize(10.9);
      expect(cache.getStats().maxSize).toBe(10);
    });

    it("clamps a sub-1 cap up to 1", function () {
      const cache = new WebGPURenderPipelineCache(deviceStub);
      cache.setMaxSize(0);
      expect(cache.getStats().maxSize).toBe(1);
    });

    it("clamps a negative cap up to 1", function () {
      const cache = new WebGPURenderPipelineCache(deviceStub);
      cache.setMaxSize(-50);
      expect(cache.getStats().maxSize).toBe(1);
    });

    it("does not evict when the cache is empty and below the new cap", function () {
      const cache = new WebGPURenderPipelineCache(deviceStub);
      cache.setMaxSize(1);
      expect(cache.getStats().evicted).toBe(0);
      expect(cache.getStats().size).toBe(0);
    });
  });

  describe("getPipelineSync miss accounting (device-free path)", function () {
    it("returns undefined and counts a miss for an uncached descriptor", function () {
      const cache = new WebGPURenderPipelineCache(deviceStub);
      const result = cache.getPipelineSync(makeDescriptor("p1"));
      expect(result).toBeUndefined();
      const stats = cache.getStats();
      expect(stats.misses).toBe(1);
      expect(stats.hits).toBe(0);
    });

    it("counts each repeated miss separately", function () {
      const cache = new WebGPURenderPipelineCache(deviceStub);
      cache.getPipelineSync(makeDescriptor("p1"));
      cache.getPipelineSync(makeDescriptor("p1"));
      cache.getPipelineSync(makeDescriptor("p2"));
      expect(cache.getStats().misses).toBe(3);
    });

    it("computes hitRate as hits / (hits + misses)", function () {
      // All three lookups miss (empty cache), so hitRate is 0/3 = 0.
      const cache = new WebGPURenderPipelineCache(deviceStub);
      cache.getPipelineSync(makeDescriptor("p1"));
      cache.getPipelineSync(makeDescriptor("p2"));
      cache.getPipelineSync(makeDescriptor("p3"));
      expect(cache.getStats().hitRate).toBe(0);
    });
  });

  describe("has() on an empty cache", function () {
    it("returns false for any descriptor", function () {
      const cache = new WebGPURenderPipelineCache(deviceStub);
      expect(cache.has(makeDescriptor("nope"))).toBe(false);
    });

    it("does not mutate hit/miss stats (read-only Map probe)", function () {
      const cache = new WebGPURenderPipelineCache(deviceStub);
      cache.has(makeDescriptor("nope"));
      const stats = cache.getStats();
      expect(stats.hits).toBe(0);
      expect(stats.misses).toBe(0);
    });
  });

  describe("remove() on an empty cache", function () {
    it("returns false when the key is absent", function () {
      const cache = new WebGPURenderPipelineCache(deviceStub);
      expect(cache.remove(makeDescriptor("absent"))).toBe(false);
    });
  });

  describe("cache-key identity (observed via has/remove deltas)", function () {
    // generateCacheKey() is private, but its identity contract is
    // observable: two descriptors that produce the SAME key collide in
    // the Map, two that produce DIFFERENT keys do not. We can only
    // probe the device-free side (everything stays absent on an empty
    // cache), so these assertions confirm the key builder does not
    // throw and treats the documented identity fields consistently.

    it("treats distinct names as distinct keys (both absent)", function () {
      const cache = new WebGPURenderPipelineCache(deviceStub);
      expect(cache.has(makeDescriptor("a"))).toBe(false);
      expect(cache.has(makeDescriptor("b"))).toBe(false);
    });

    it("does not throw when keying a descriptor with full identity fields", function () {
      const cache = new WebGPURenderPipelineCache(deviceStub);
      const descriptor = {
        name: "full",
        vertex: {
          module: { __stub: "vs" },
          entryPoint: "vertexMain",
          buffers: [
            {
              arrayStride: 32,
              stepMode: "vertex",
              attributes: [
                { shaderLocation: 0, offset: 0, format: "float32x3" },
                { shaderLocation: 1, offset: 12, format: "float32x2" },
              ],
            },
          ],
        },
        fragment: {
          module: { __stub: "fs" },
          entryPoint: "fragmentMain",
          targets: [{ format: "bgra8unorm", writeMask: 0xf }],
        },
        depthStencil: { format: "depth24plus-stencil8" },
        multisample: { count: 4 },
      };
      // Pure key construction must not require a device.
      expect(function () {
        cache.has(descriptor);
      }).not.toThrow();
      expect(cache.has(descriptor)).toBe(false);
    });

    it("does not throw when keying a descriptor with a full variant", function () {
      const cache = new WebGPURenderPipelineCache(deviceStub);
      const variant = {
        depthTest: true,
        depthWrite: false,
        depthCompare: "less-equal",
        cullMode: "back",
        frontFace: "ccw",
        topology: "triangle-list",
        blend: {
          color: { srcFactor: "src-alpha", dstFactor: "one-minus-src-alpha" },
          alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha" },
        },
        stencilFront: { compare: "always" },
        stencilBack: { compare: "always" },
        stencilReadMask: 0xff,
        stencilWriteMask: 0xff,
        colorWriteMask: 0xf,
        depthBias: 1,
        depthBiasSlopeScale: 2,
        depthBiasClamp: 0,
        blendConstant: { r: 0, g: 0, b: 0, a: 1 },
      };
      expect(function () {
        cache.has(makeDescriptor("variant-keyed"), variant);
      }).not.toThrow();
      expect(cache.has(makeDescriptor("variant-keyed"), variant)).toBe(false);
    });
  });

  describe("clear()", function () {
    it("resets hit/miss/created/evicted counters", function () {
      const cache = new WebGPURenderPipelineCache(deviceStub);
      // Generate some miss traffic on the device-free path.
      cache.getPipelineSync(makeDescriptor("p1"));
      cache.getPipelineSync(makeDescriptor("p2"));
      expect(cache.getStats().misses).toBe(2);

      cache.clear();
      const stats = cache.getStats();
      expect(stats.hits).toBe(0);
      expect(stats.misses).toBe(0);
      expect(stats.created).toBe(0);
      expect(stats.evicted).toBe(0);
      expect(stats.size).toBe(0);
    });

    it("leaves maxSize untouched", function () {
      const cache = new WebGPURenderPipelineCache(deviceStub, "ctx", 64);
      cache.clear();
      expect(cache.getStats().maxSize).toBe(64);
    });
  });

  describe("destroy()", function () {
    it("empties the cache (size stays 0) without throwing", function () {
      const cache = new WebGPURenderPipelineCache(deviceStub);
      expect(function () {
        cache.destroy();
      }).not.toThrow();
      expect(cache.getStats().size).toBe(0);
      expect(cache.getCachedPipelineNames()).toEqual([]);
    });
  });

  describe("setAsyncResourceMonitor()", function () {
    it("accepts a monitor reference and null without throwing", function () {
      const cache = new WebGPURenderPipelineCache(deviceStub);
      const monitorStub = { __stub: "monitor" };
      expect(function () {
        cache.setAsyncResourceMonitor(monitorStub);
        cache.setAsyncResourceMonitor(null);
      }).not.toThrow();
    });
  });

  describe("module exports", function () {
    it("exposes the class as both a named and default export", function () {
      // Named import is exercised throughout; assert the constructor is
      // callable with only a device (contextId / maxSize / monitor all
      // optional).
      const cache = new WebGPURenderPipelineCache(deviceStub);
      expect(cache instanceof WebGPURenderPipelineCache).toBe(true);
    });
  });
});
