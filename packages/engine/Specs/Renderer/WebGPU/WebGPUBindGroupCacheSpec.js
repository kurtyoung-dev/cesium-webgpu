import { WebGPUBindGroupCache } from "../../../Source/Renderer/WebGPU/WebGPUBindGroupCache.js";

// WebGPUBindGroupCache's only device-touching call is
// `device.createBindGroup` inside `getOrCreate`. Everything that makes
// this class correct — the identity-based cache key (layout id + each
// entry's `binding` + resource-object identity, with `offset`/`size`
// folded in for buffer entries), the dedup-on-hit behaviour, hit/miss/
// invalidation telemetry, `size` accounting, `invalidateAll`, and
// `resetStats` — is observable through a tiny capturing stub device that
// returns a sentinel object and records every `createBindGroup` call. No
// live GPUDevice, queue, or async setup is required, so these run in the
// Karma headless browser with zero GPU dependency.
//
// The cache never inspects the internals of layout / texture-view /
// sampler / buffer objects — it only reads their *identity* via an
// internal WeakMap. So plain `{}` objects are valid stand-ins for every
// GPU resource: two distinct `{}` are two distinct identities, the same
// `{}` reused is the same identity. That is exactly the contract the
// real WeakMap-backed `_idFor` relies on.
function makeStubDevice() {
  const device = {
    calls: [],
    createBindGroup(descriptor) {
      const bindGroup = {
        __isBindGroup: true,
        index: device.calls.length,
        label: descriptor.label,
      };
      device.calls.push(descriptor);
      return bindGroup;
    },
  };
  return device;
}

// Distinct identity tokens standing in for GPU resources.
function layout() {
  return {};
}
function view() {
  return {};
}
function sampler() {
  return {};
}
function buffer() {
  return {};
}

describe("Renderer/WebGPU/WebGPUBindGroupCache", function () {
  describe("constructor + initial state", function () {
    it("starts empty (size 0)", function () {
      const cache = new WebGPUBindGroupCache();
      expect(cache.size).toBe(0);
    });

    it("reports zeroed counters and NaN hitRate before any lookup", function () {
      const cache = new WebGPUBindGroupCache();
      const stats = cache.getStats();
      expect(stats.size).toBe(0);
      expect(stats.hits).toBe(0);
      expect(stats.misses).toBe(0);
      expect(stats.invalidations).toBe(0);
      // total === 0 → hitRate is NaN by contract, not 0.
      expect(isNaN(stats.hitRate)).toBe(true);
    });
  });

  describe("getOrCreate — miss path", function () {
    it("creates and returns the stub bind group on a miss", function () {
      const device = makeStubDevice();
      const cache = new WebGPUBindGroupCache();
      const bg = cache.getOrCreate(device, "BG-A", layout(), [
        { binding: 0, resource: view() },
      ]);
      expect(bg.__isBindGroup).toBe(true);
      expect(device.calls.length).toBe(1);
      expect(cache.size).toBe(1);
    });

    it("forwards label, layout, and entries to createBindGroup", function () {
      const device = makeStubDevice();
      const cache = new WebGPUBindGroupCache();
      const lay = layout();
      const entries = [{ binding: 0, resource: view() }];
      cache.getOrCreate(device, "MyLabel", lay, entries);
      expect(device.calls[0].label).toBe("MyLabel");
      expect(device.calls[0].layout).toBe(lay);
      expect(device.calls[0].entries).toBe(entries);
    });

    it("counts a miss in the stats (1 miss, 0 hits, hitRate 0)", function () {
      const device = makeStubDevice();
      const cache = new WebGPUBindGroupCache();
      cache.getOrCreate(device, "BG", layout(), [
        { binding: 0, resource: view() },
      ]);
      const stats = cache.getStats();
      expect(stats.misses).toBe(1);
      expect(stats.hits).toBe(0);
      // total === 1, hits === 0 → exactly 0, not NaN.
      expect(stats.hitRate).toBe(0);
    });
  });

  describe("getOrCreate — hit path (identity dedup)", function () {
    it("returns the same bind group for identical layout + entries (no re-create)", function () {
      const device = makeStubDevice();
      const cache = new WebGPUBindGroupCache();
      const lay = layout();
      const v = view();
      const first = cache.getOrCreate(device, "first", lay, [
        { binding: 0, resource: v },
      ]);
      const second = cache.getOrCreate(device, "second", lay, [
        { binding: 0, resource: v },
      ]);
      expect(second).toBe(first);
      // Hit path must not call the device again, even with a new label.
      expect(device.calls.length).toBe(1);
      expect(cache.size).toBe(1);
    });

    it("records the hit in the stats and computes hitRate", function () {
      const device = makeStubDevice();
      const cache = new WebGPUBindGroupCache();
      const lay = layout();
      const v = view();
      cache.getOrCreate(device, "a", lay, [{ binding: 0, resource: v }]);
      cache.getOrCreate(device, "b", lay, [{ binding: 0, resource: v }]);
      const stats = cache.getStats();
      expect(stats.hits).toBe(1);
      expect(stats.misses).toBe(1);
      // 1 hit / (1 hit + 1 miss) === 0.5
      expect(stats.hitRate).toBe(0.5);
    });

    it("dedups across entries listed in the same order with same resources", function () {
      const device = makeStubDevice();
      const cache = new WebGPUBindGroupCache();
      const lay = layout();
      const v = view();
      const s = sampler();
      const entriesA = [
        { binding: 0, resource: v },
        { binding: 1, resource: s },
      ];
      const entriesB = [
        { binding: 0, resource: v },
        { binding: 1, resource: s },
      ];
      const a = cache.getOrCreate(device, "a", lay, entriesA);
      const b = cache.getOrCreate(device, "b", lay, entriesB);
      expect(b).toBe(a);
      expect(device.calls.length).toBe(1);
    });
  });

  describe("cache key — layout identity", function () {
    it("creates distinct bind groups for different layouts with identical entries", function () {
      const device = makeStubDevice();
      const cache = new WebGPUBindGroupCache();
      const v = view();
      const a = cache.getOrCreate(device, "a", layout(), [
        { binding: 0, resource: v },
      ]);
      const b = cache.getOrCreate(device, "b", layout(), [
        { binding: 0, resource: v },
      ]);
      expect(b).not.toBe(a);
      expect(device.calls.length).toBe(2);
      expect(cache.size).toBe(2);
    });
  });

  describe("cache key — resource identity", function () {
    it("creates a distinct bind group when a texture view identity changes", function () {
      const device = makeStubDevice();
      const cache = new WebGPUBindGroupCache();
      const lay = layout();
      const a = cache.getOrCreate(device, "a", lay, [
        { binding: 0, resource: view() },
      ]);
      const b = cache.getOrCreate(device, "b", lay, [
        { binding: 0, resource: view() },
      ]);
      expect(b).not.toBe(a);
      expect(cache.size).toBe(2);
    });

    it("creates a distinct bind group when the same resource moves to a different binding", function () {
      const device = makeStubDevice();
      const cache = new WebGPUBindGroupCache();
      const lay = layout();
      const v = view();
      const a = cache.getOrCreate(device, "a", lay, [
        { binding: 0, resource: v },
      ]);
      const b = cache.getOrCreate(device, "b", lay, [
        { binding: 1, resource: v },
      ]);
      expect(b).not.toBe(a);
      expect(cache.size).toBe(2);
    });
  });

  describe("cache key — buffer offset / size encoding", function () {
    it("dedups identical buffer entries (same buffer, default offset/size)", function () {
      const device = makeStubDevice();
      const cache = new WebGPUBindGroupCache();
      const lay = layout();
      const buf = buffer();
      const a = cache.getOrCreate(device, "a", lay, [
        { binding: 0, resource: { buffer: buf } },
      ]);
      const b = cache.getOrCreate(device, "b", lay, [
        { binding: 0, resource: { buffer: buf } },
      ]);
      expect(b).toBe(a);
      expect(device.calls.length).toBe(1);
    });

    it("treats an omitted offset the same as offset 0 (default folding)", function () {
      const device = makeStubDevice();
      const cache = new WebGPUBindGroupCache();
      const lay = layout();
      const buf = buffer();
      const a = cache.getOrCreate(device, "a", lay, [
        { binding: 0, resource: { buffer: buf } },
      ]);
      const b = cache.getOrCreate(device, "b", lay, [
        { binding: 0, resource: { buffer: buf, offset: 0 } },
      ]);
      // `offset ?? 0` folds the missing offset to 0, so these collide.
      expect(b).toBe(a);
      expect(device.calls.length).toBe(1);
    });

    it("treats an omitted size the same as size -1 (default folding)", function () {
      const device = makeStubDevice();
      const cache = new WebGPUBindGroupCache();
      const lay = layout();
      const buf = buffer();
      const a = cache.getOrCreate(device, "a", lay, [
        { binding: 0, resource: { buffer: buf } },
      ]);
      const b = cache.getOrCreate(device, "b", lay, [
        { binding: 0, resource: { buffer: buf, size: -1 } },
      ]);
      // `size ?? -1` folds the missing size to -1, so these collide.
      expect(b).toBe(a);
      expect(device.calls.length).toBe(1);
    });

    it("creates a distinct bind group for the same buffer at a different offset", function () {
      const device = makeStubDevice();
      const cache = new WebGPUBindGroupCache();
      const lay = layout();
      const buf = buffer();
      const a = cache.getOrCreate(device, "a", lay, [
        { binding: 0, resource: { buffer: buf, offset: 0 } },
      ]);
      const b = cache.getOrCreate(device, "b", lay, [
        { binding: 0, resource: { buffer: buf, offset: 256 } },
      ]);
      expect(b).not.toBe(a);
      expect(cache.size).toBe(2);
    });

    it("creates a distinct bind group for the same buffer at a different size", function () {
      const device = makeStubDevice();
      const cache = new WebGPUBindGroupCache();
      const lay = layout();
      const buf = buffer();
      const a = cache.getOrCreate(device, "a", lay, [
        { binding: 0, resource: { buffer: buf, offset: 0, size: 64 } },
      ]);
      const b = cache.getOrCreate(device, "b", lay, [
        { binding: 0, resource: { buffer: buf, offset: 0, size: 128 } },
      ]);
      expect(b).not.toBe(a);
      expect(cache.size).toBe(2);
    });

    it("distinguishes a buffer-backed entry from a plain-resource entry at the same binding", function () {
      const device = makeStubDevice();
      const cache = new WebGPUBindGroupCache();
      const lay = layout();
      // A buffer entry keys as `b<binding>:...`; a plain texture/sampler
      // entry keys as `r<binding>:...`. Even with the same binding the
      // key prefixes differ, so these never collide.
      const a = cache.getOrCreate(device, "a", lay, [
        { binding: 0, resource: { buffer: buffer() } },
      ]);
      const b = cache.getOrCreate(device, "b", lay, [
        { binding: 0, resource: view() },
      ]);
      expect(b).not.toBe(a);
      expect(cache.size).toBe(2);
    });
  });

  describe("invalidateAll", function () {
    it("drops all cached entries", function () {
      const device = makeStubDevice();
      const cache = new WebGPUBindGroupCache();
      cache.getOrCreate(device, "a", layout(), [
        { binding: 0, resource: view() },
      ]);
      cache.getOrCreate(device, "b", layout(), [
        { binding: 0, resource: view() },
      ]);
      expect(cache.size).toBe(2);
      cache.invalidateAll();
      expect(cache.size).toBe(0);
    });

    it("forces a re-create after invalidation (entries are truly gone)", function () {
      const device = makeStubDevice();
      const cache = new WebGPUBindGroupCache();
      const lay = layout();
      const v = view();
      const before = cache.getOrCreate(device, "a", lay, [
        { binding: 0, resource: v },
      ]);
      cache.invalidateAll();
      const after = cache.getOrCreate(device, "a", lay, [
        { binding: 0, resource: v },
      ]);
      expect(after).not.toBe(before);
      expect(device.calls.length).toBe(2);
      expect(cache.size).toBe(1);
    });

    it("counts an invalidation only when the cache was non-empty", function () {
      const device = makeStubDevice();
      const cache = new WebGPUBindGroupCache();
      // Empty-cache invalidate is a no-op for the counter (guarded by
      // `_map.size > 0`).
      cache.invalidateAll();
      expect(cache.getStats().invalidations).toBe(0);

      cache.getOrCreate(device, "a", layout(), [
        { binding: 0, resource: view() },
      ]);
      cache.invalidateAll();
      expect(cache.getStats().invalidations).toBe(1);

      // Now empty again — a second invalidate does not bump the counter.
      cache.invalidateAll();
      expect(cache.getStats().invalidations).toBe(1);
    });

    it("preserves hit/miss counters across invalidation (only contents drop)", function () {
      const device = makeStubDevice();
      const cache = new WebGPUBindGroupCache();
      const lay = layout();
      const v = view();
      cache.getOrCreate(device, "a", lay, [{ binding: 0, resource: v }]); // miss
      cache.getOrCreate(device, "b", lay, [{ binding: 0, resource: v }]); // hit
      cache.invalidateAll();
      const stats = cache.getStats();
      expect(stats.hits).toBe(1);
      expect(stats.misses).toBe(1);
      expect(stats.size).toBe(0);
    });
  });

  describe("getStats", function () {
    it("reflects current size, hits, misses, and invalidations together", function () {
      const device = makeStubDevice();
      const cache = new WebGPUBindGroupCache();
      const lay = layout();
      const v1 = view();
      const v2 = view();
      cache.getOrCreate(device, "a", lay, [{ binding: 0, resource: v1 }]); // miss, size→1
      cache.getOrCreate(device, "b", lay, [{ binding: 0, resource: v2 }]); // miss, size→2
      cache.getOrCreate(device, "c", lay, [{ binding: 0, resource: v1 }]); // hit
      const stats = cache.getStats();
      expect(stats.size).toBe(2);
      expect(stats.hits).toBe(1);
      expect(stats.misses).toBe(2);
      expect(stats.invalidations).toBe(0);
      // 1 hit / 3 lookups
      expect(stats.hitRate).toBe(1 / 3);
    });
  });

  describe("resetStats", function () {
    it("zeroes hit/miss/invalidation counters without dropping cache contents", function () {
      const device = makeStubDevice();
      const cache = new WebGPUBindGroupCache();
      const lay = layout();
      const v = view();
      cache.getOrCreate(device, "a", lay, [{ binding: 0, resource: v }]); // miss
      cache.getOrCreate(device, "b", lay, [{ binding: 0, resource: v }]); // hit
      expect(cache.size).toBe(1);

      cache.resetStats();
      const stats = cache.getStats();
      // Counters reset...
      expect(stats.hits).toBe(0);
      expect(stats.misses).toBe(0);
      expect(stats.invalidations).toBe(0);
      // ...but the entry is still present (size unchanged, hitRate NaN
      // again because no lookups have run since the reset).
      expect(stats.size).toBe(1);
      expect(isNaN(stats.hitRate)).toBe(true);
    });

    it("keeps cached entries resolvable as hits after a stats reset", function () {
      const device = makeStubDevice();
      const cache = new WebGPUBindGroupCache();
      const lay = layout();
      const v = view();
      const first = cache.getOrCreate(device, "a", lay, [
        { binding: 0, resource: v },
      ]);
      cache.resetStats();
      const second = cache.getOrCreate(device, "b", lay, [
        { binding: 0, resource: v },
      ]);
      // Still a cache hit — resetStats does not clear `_map`.
      expect(second).toBe(first);
      expect(device.calls.length).toBe(1);
      expect(cache.getStats().hits).toBe(1);
      expect(cache.getStats().misses).toBe(0);
    });
  });
});
