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
//   - the documented cache-key format (name | layout-id | entryPoint |
//     constants), exercised by pre-seeding the cache map at the key the
//     pure key generator produces for a fresh cache
//   - getPipelineSync() miss path (returns undefined, bumps misses) and
//     hit path (pre-seeded, returns the entry, bumps hits)
//   - has() / getCachedPipelineNames() on empty + seeded caches
//   - getStats().hitRate accounting + size accounting
//   - layout-identity dedup vs. "auto" no-dedup, observed via the hit
//     path (same layout object → same key → hit; "auto" → fresh
//     sentinel → miss)
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

// A descriptor with a real (non-"auto") layout object. On a fresh cache
// the first layout observed is assigned identity 0 (layoutIdentityCounter
// starts at 0), so its key is `${name}|l:0|e:${entryPoint}`.
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

// Seed the private cache map at the key the pure generateCacheKey would
// produce, so the hit path can be exercised without a device. Copied
// verbatim from WebGPUComputePipelineCache.generateCacheKey:
//   `${name}|l:${layoutId}|e:${entryPoint}${constantsKey}`
// with constantsKey = `|c:${JSON.stringify(constants)}` when present.
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
      // First non-"auto" layout on a fresh cache → identity 0.
      seed(cache, "Fog_Density|l:0|e:main", pipeline, desc);

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
      seed(
        cache,
        `Fog_Scatter|l:0|e:cs|c:${JSON.stringify(constants)}`,
        pipeline,
        desc,
      );
      expect(cache.getPipelineSync(desc)).toBe(pipeline);
      expect(cache.getStats().hits).toBe(1);
    });

    it("treats different entry points as different keys (miss)", function () {
      const cache = makeCache();
      const layout = {};
      const seeded = makeDescriptor("Fog_Density", "main", layout);
      seed(cache, "Fog_Density|l:0|e:main", fakePipeline("d"), seeded);

      // Same name + layout, different entry point → different key → miss.
      const other = makeDescriptor("Fog_Density", "other", layout);
      expect(cache.getPipelineSync(other)).toBeUndefined();
      expect(cache.getStats().misses).toBe(1);
    });

    it("treats a different name as a different key (miss)", function () {
      const cache = makeCache();
      const layout = {};
      const seeded = makeDescriptor("Fog_Density", "main", layout);
      seed(cache, "Fog_Density|l:0|e:main", fakePipeline("d"), seeded);

      const other = makeDescriptor("Fog_Other", "main", layout);
      expect(cache.getPipelineSync(other)).toBeUndefined();
      expect(cache.getStats().misses).toBe(1);
    });
  });

  describe("layout identity (dedup vs. 'auto')", function () {
    it("dedups two descriptors sharing the same layout object", function () {
      const cache = makeCache();
      const layout = {};
      const pipeline = fakePipeline("shared");
      const first = makeDescriptor("Cull", "main", layout);
      // First layout observed → identity 0.
      seed(cache, "Cull|l:0|e:main", pipeline, first);

      // A second descriptor reusing the SAME layout object resolves to
      // the same identity (0) and therefore the same key → hit.
      const second = makeDescriptor("Cull", "main", layout);
      expect(cache.getPipelineSync(second)).toBe(pipeline);
      expect(cache.getStats().hits).toBe(1);
    });

    it("never dedups 'auto' layouts (fresh negative sentinel each time)", function () {
      const cache = makeCache();
      // The first 'auto' lookup resolves to sentinel -1 (-1 - counter, counter
      // 0→1) and misses; seed the result at that key so a dedup WOULD hit it.
      // (The lookup itself advances the counter — `seed` alone would not, since
      // it bypasses generateCacheKey.)
      const first = makeDescriptor("OneOff", "main", "auto");
      expect(cache.getPipelineSync(first)).toBeUndefined();
      seed(cache, "OneOff|l:-1|e:main", fakePipeline("a"), first);

      // A second 'auto' lookup advances the counter → fresh sentinel -2 →
      // different key → MISS, even though name + entry point match. If 'auto'
      // deduped, this would HIT the seeded -1 entry — the bug this guards.
      const other = makeDescriptor("OneOff", "main", "auto");
      expect(cache.getPipelineSync(other)).toBeUndefined();
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
      seed(cache, "Fog_Density|l:0|e:main", fakePipeline("d"), desc);
      expect(cache.has(desc)).toBe(true);
    });
  });

  describe("getCachedPipelineNames()", function () {
    it("lists the descriptor names of seeded entries", function () {
      const cache = makeCache();
      const a = makeDescriptor("Fog_Density", "main", {});
      const b = makeDescriptor("Fog_Scatter", "cs", {});
      seed(cache, "Fog_Density|l:0|e:main", fakePipeline("a"), a);
      seed(cache, "Fog_Scatter|l:0|e:cs", fakePipeline("b"), b);
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
      seed(cache, "A|l:0|e:main", fakePipeline("a"), a);
      seed(cache, "B|l:0|e:main", fakePipeline("b"), b);
      expect(cache.getStats().size).toBe(2);
    });

    it("computes hitRate = hits / (hits + misses)", function () {
      const cache = makeCache();
      const layout = {};
      const hitDesc = makeDescriptor("Hit", "main", layout);
      seed(cache, "Hit|l:0|e:main", fakePipeline("h"), hitDesc);

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
      seed(cache, "Fog_Density|l:0|e:main", fakePipeline("d"), desc);
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
      seed(cache, "Fog_Density|l:0|e:main", fakePipeline("d"), desc);
      cache.clear();

      // After clear, the first layout observed resolves to identity 0
      // again, so re-seeding at the l:0 key and looking up hits.
      const reseeded = makeDescriptor("Fog_Density", "main", layout);
      seed(cache, "Fog_Density|l:0|e:main", fakePipeline("d2"), reseeded);
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
      seed(cache, "Fog_Density|l:0|e:main", fakePipeline("d"), desc);
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
