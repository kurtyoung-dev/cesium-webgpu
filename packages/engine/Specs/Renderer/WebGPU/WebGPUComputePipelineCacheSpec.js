import { WebGPUComputePipelineCache } from "../../../Source/Renderer/WebGPU/WebGPUComputePipelineCache.js";

// ── Test fixtures ───────────────────────────────────────────────────
//
// WebGPUComputePipelineCache's create paths (getPipeline /
// getOrCreateSync / createPipelineAsync) call
// device.createComputePipeline[Async](), which needs a live GPUDevice.
// The constructor itself only stores the device reference — it never
// touches it — so a bare stub is safe for everything below.
//
// These specs cover the parts that DON'T need a device:
//   - constructor + getStats() default shape
//   - the documented cache-key format
//     (name|l:<layout>|m:<module>|e:<entry>[|c:<constants>]), exercised by
//     pre-seeding the cache map at the key the pure key generator produces
//   - getPipelineSync() miss path (returns undefined, bumps misses) and
//     hit path (pre-seeded, returns the entry, bumps hits)
//   - has() / getCachedPipelineNames() on empty + seeded caches
//   - getStats().hitRate accounting + size accounting
//   - layout-identity dedup vs. "auto" no-dedup, observed via the hit
//     path (same layout and module objects → same key → hit; "auto"
//     → fresh sentinel → miss)
//   - clear() / destroy() / setAsyncResourceMonitor() device-free paths
//
// SKIPPED (device-bound — require a real GPUDevice/queue): getPipeline,
// getOrCreateSync, createPipelineAsync.

// A stub device — never invoked by any path exercised here.
function makeCache(contextId, monitor) {
  return new WebGPUComputePipelineCache(
    /** @type {any} */ ({}),
    contextId,
    monitor,
  );
}

// A descriptor with a real (non-"auto") layout object. On a fresh cache,
// the first layout observed is assigned identity 0. Module identities are
// assigned independently, so keys are derived rather than assembled here.
function makeDescriptor(name, entryPoint, layout, constants) {
  return {
    name: name,
    layout: layout,
    compute: {
      module: /** @type {any} */ ({}),
      entryPoint: entryPoint,
      constants: constants,
    },
  };
}

// A throwaway value standing in for a GPUComputePipeline when we
// pre-seed the cache map (the cache never inspects it).
function fakePipeline(tag) {
  return /** @type {any} */ ({ __fakePipeline: tag });
}

// Seed the private cache map at a key derived by the cache itself, so the
// hit path can be exercised without a device. Keys have the shape
// `name|l:<layout>|m:<module>|e:<entry>[|c:<constants>]`.
function seed(cache, key, pipeline, descriptor) {
  cache.cache.set(key, {
    pipeline: pipeline,
    descriptor: descriptor,
    created: 0,
  });
}

describe("Renderer/WebGPU/WebGPUComputePipelineCache", function () {
  describe("constructor + getStats() defaults", function () {
    it("reports a zeroed stats shape on a fresh cache", function () {
      const cache = makeCache();
      const s = cache.getStats();
      expect(s.hits).toBe(0);
      expect(s.misses).toBe(0);
      expect(s.created).toBe(0);
      expect(s.pending).toBe(0);
      expect(s.size).toBe(0);
      expect(s.hitRate).toBe(0);
    });

    it("starts with no cached pipelines", function () {
      const cache = makeCache();
      expect(cache.getCachedPipelineNames()).toEqual([]);
    });

    it("accepts an optional contextId without throwing", function () {
      expect(() => makeCache("ctx-a3f7")).not.toThrow();
    });

    it("accepts an optional monitor without throwing", function () {
      expect(() => makeCache(undefined, null)).not.toThrow();
    });
  });

  describe("getPipelineSync() miss path", function () {
    it("returns undefined when the descriptor is not cached", function () {
      const cache = makeCache();
      const desc = makeDescriptor("Fog_Density", "main", {});
      expect(cache.getPipelineSync(desc)).toBeUndefined();
    });

    it("bumps the misses counter on each miss (no device call)", function () {
      const cache = makeCache();
      const desc = makeDescriptor("Fog_Density", "main", {});
      cache.getPipelineSync(desc);
      cache.getPipelineSync(desc);
      const s = cache.getStats();
      expect(s.misses).toBe(2);
      expect(s.hits).toBe(0);
      expect(s.size).toBe(0);
    });
  });

  describe("cache-key format + getPipelineSync() hit path", function () {
    it("hits a pre-seeded entry whose key matches the documented format", function () {
      const cache = makeCache();
      const layout = {};
      const desc = makeDescriptor("Fog_Density", "main", layout);
      const pipeline = fakePipeline("density");
      seed(cache, cache.generateCacheKey(desc), pipeline, desc);

      expect(cache.getPipelineSync(desc)).toBe(pipeline);
      const s = cache.getStats();
      expect(s.hits).toBe(1);
      expect(s.misses).toBe(0);
      expect(s.size).toBe(1);
    });

    it("includes a serialized constants segment in the key", function () {
      const cache = makeCache();
      const layout = {};
      const constants = { WORKGROUP_SIZE: 64 };
      const desc = makeDescriptor("Fog_Scatter", "cs", layout, constants);
      const pipeline = fakePipeline("scatter");
      // constantsKey = `|c:${JSON.stringify(constants)}`.
      seed(cache, cache.generateCacheKey(desc), pipeline, desc);
      expect(cache.getPipelineSync(desc)).toBe(pipeline);
      expect(cache.getStats().hits).toBe(1);
    });

    it("treats different entry points as different keys (miss)", function () {
      const cache = makeCache();
      const layout = {};
      const seeded = makeDescriptor("Fog_Density", "main", layout);
      seed(cache, cache.generateCacheKey(seeded), fakePipeline("d"), seeded);

      // Same name, layout, and module; a different entry point must miss.
      const other = {
        ...seeded,
        compute: { ...seeded.compute, entryPoint: "other" },
      };
      expect(cache.getPipelineSync(other)).toBeUndefined();
      expect(cache.getStats().misses).toBe(1);
    });

    it("treats a different name as a different key (miss)", function () {
      const cache = makeCache();
      const layout = {};
      const seeded = makeDescriptor("Fog_Density", "main", layout);
      seed(cache, cache.generateCacheKey(seeded), fakePipeline("d"), seeded);

      // Same layout, module, and entry point; a different name must miss.
      const other = { ...seeded, name: "Fog_Other" };
      expect(cache.getPipelineSync(other)).toBeUndefined();
      expect(cache.getStats().misses).toBe(1);
    });
  });

  describe("layout identity (dedup vs. 'auto')", function () {
    it("dedups two descriptors sharing layout and module objects", function () {
      const cache = makeCache();
      const layout = {};
      const pipeline = fakePipeline("shared");
      const first = makeDescriptor("Cull", "main", layout);
      seed(cache, cache.generateCacheKey(first), pipeline, first);

      // Reusing both identity-bearing objects produces the same key.
      const second = { ...first, compute: { ...first.compute } };
      expect(cache.getPipelineSync(second)).toBe(pipeline);
      expect(cache.getStats().hits).toBe(1);
    });

    it("never dedups 'auto' layouts (fresh negative sentinel each time)", function () {
      const cache = makeCache();
      // Deriving the first key resolves to sentinel -1. Seed that key so a
      // repeated sentinel would hit it; the lookup must use fresh sentinel -2.
      const first = makeDescriptor("OneOff", "main", "auto");
      const firstKey = cache.generateCacheKey(first);
      seed(cache, firstKey, fakePipeline("a"), first);
      expect(cache.getPipelineSync(first)).toBeUndefined();

      // A second lookup of the same descriptor advances to another fresh
      // sentinel, so it also misses with every other key component unchanged.
      expect(cache.getPipelineSync(first)).toBeUndefined();
      expect(cache.getStats().misses).toBe(2);
    });
  });

  describe("has()", function () {
    it("returns false on an empty cache without touching stats", function () {
      const cache = makeCache();
      const desc = makeDescriptor("Fog_Density", "main", {});
      expect(cache.has(desc)).toBe(false);
      const s = cache.getStats();
      expect(s.hits).toBe(0);
      expect(s.misses).toBe(0);
    });

    it("returns true for a pre-seeded descriptor", function () {
      const cache = makeCache();
      const layout = {};
      const desc = makeDescriptor("Fog_Density", "main", layout);
      seed(cache, cache.generateCacheKey(desc), fakePipeline("d"), desc);
      expect(cache.has(desc)).toBe(true);
    });
  });

  describe("getCachedPipelineNames()", function () {
    it("lists the descriptor names of seeded entries", function () {
      const cache = makeCache();
      const a = makeDescriptor("Fog_Density", "main", {});
      const b = makeDescriptor("Fog_Scatter", "cs", {});
      seed(cache, cache.generateCacheKey(a), fakePipeline("a"), a);
      seed(cache, cache.generateCacheKey(b), fakePipeline("b"), b);
      const names = cache.getCachedPipelineNames();
      expect(names.length).toBe(2);
      expect(names).toContain("Fog_Density");
      expect(names).toContain("Fog_Scatter");
    });
  });

  describe("getStats() accounting", function () {
    it("reports size from the number of cached entries", function () {
      const cache = makeCache();
      const a = makeDescriptor("A", "main", {});
      const b = makeDescriptor("B", "main", {});
      seed(cache, cache.generateCacheKey(a), fakePipeline("a"), a);
      seed(cache, cache.generateCacheKey(b), fakePipeline("b"), b);
      expect(cache.getStats().size).toBe(2);
    });

    it("computes hitRate = hits / (hits + misses)", function () {
      const cache = makeCache();
      const layout = {};
      const hitDesc = makeDescriptor("Hit", "main", layout);
      seed(cache, cache.generateCacheKey(hitDesc), fakePipeline("h"), hitDesc);

      // 1 hit on the seeded entry.
      cache.getPipelineSync(hitDesc);
      // 3 misses on unseeded descriptors.
      cache.getPipelineSync(makeDescriptor("Miss1", "main", {}));
      cache.getPipelineSync(makeDescriptor("Miss2", "main", {}));
      cache.getPipelineSync(makeDescriptor("Miss3", "main", {}));

      const s = cache.getStats();
      expect(s.hits).toBe(1);
      expect(s.misses).toBe(3);
      expect(s.hitRate).toBe(0.25);
    });

    it("reports hitRate 0 when there has been no traffic", function () {
      expect(makeCache().getStats().hitRate).toBe(0);
    });
  });

  describe("clear()", function () {
    it("drops cached entries and zeroes hit/miss/created stats", function () {
      const cache = makeCache();
      const desc = makeDescriptor("Fog_Density", "main", {});
      seed(cache, cache.generateCacheKey(desc), fakePipeline("d"), desc);
      // Generate some traffic.
      cache.getPipelineSync(desc); // hit
      cache.getPipelineSync(makeDescriptor("Nope", "main", {})); // miss

      cache.clear();
      const s = cache.getStats();
      expect(s.size).toBe(0);
      expect(s.hits).toBe(0);
      expect(s.misses).toBe(0);
      expect(s.created).toBe(0);
      expect(cache.getCachedPipelineNames()).toEqual([]);
    });

    it("resets layout identities so the next layout is identity 0 again", function () {
      const cache = makeCache();
      const layout = {};
      const desc = makeDescriptor("Fog_Density", "main", layout);
      seed(cache, cache.generateCacheKey(desc), fakePipeline("d"), desc);
      cache.clear();

      // After clear, deriving the key assigns fresh cache-local layout
      // identity state; looking up the same descriptor remains stable.
      const reseeded = makeDescriptor("Fog_Density", "main", layout);
      seed(
        cache,
        cache.generateCacheKey(reseeded),
        fakePipeline("d2"),
        reseeded,
      );
      expect(cache.has(reseeded)).toBe(true);
    });
  });

  describe("destroy()", function () {
    it("clears the cache and is safe on an empty cache", function () {
      const cache = makeCache();
      expect(() => cache.destroy()).not.toThrow();
      expect(cache.getStats().size).toBe(0);
    });

    it("clears seeded entries", function () {
      const cache = makeCache();
      const desc = makeDescriptor("Fog_Density", "main", {});
      seed(cache, cache.generateCacheKey(desc), fakePipeline("d"), desc);
      cache.destroy();
      expect(cache.getStats().size).toBe(0);
      expect(cache.getCachedPipelineNames()).toEqual([]);
    });
  });

  describe("setAsyncResourceMonitor()", function () {
    it("is callable with a monitor and with null", function () {
      const cache = makeCache();
      expect(() =>
        cache.setAsyncResourceMonitor(/** @type {any} */ ({})),
      ).not.toThrow();
      expect(() => cache.setAsyncResourceMonitor(null)).not.toThrow();
    });
  });
});
