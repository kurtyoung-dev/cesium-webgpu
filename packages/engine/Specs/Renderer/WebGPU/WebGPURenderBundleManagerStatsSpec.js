import { WebGPURenderBundleManager } from "../../../Source/Renderer/WebGPU/WebGPURenderBundleManager.js";

// ── Test fixtures ───────────────────────────────────────────────────
//
// WebGPURenderBundleManager.getOrCreate() needs a real GPUDevice for
// the bundle encoder. These specs cover the parts that DON'T need a
// device: the freezable contract, the statistics shape, the counter
// reset helper, the public `has` / `invalidate` / `invalidateAll` /
// `invalidateByPrefix` paths exercised against an empty cache, and
// the `asFreezable()` shape used by the audit wiring.

function makeManager() {
  // The constructor only needs the device for the encoder factory; we
  // never call getOrCreate() in these specs so a stub is fine.
  return new WebGPURenderBundleManager(/** @type {any} */ ({}));
}

describe("Renderer/WebGPU/WebGPURenderBundleManager", function () {
  describe("statistics shape", function () {
    it("returns the full Phase 6 schema on a fresh manager", function () {
      const m = makeManager();
      const s = m.statistics;
      expect(s.cacheSize).toBe(0);
      expect(s.totalDrawCalls).toBe(0);
      expect(s.currentFrame).toBe(0);
      expect(s.frozen).toBe(false);
      expect(s.maxIdleFrames).toBeGreaterThan(0);
      expect(s.maxCacheSize).toBeGreaterThan(0);
      expect(s.hits).toBe(0);
      expect(s.misses).toBe(0);
      expect(s.ephemeralBuilds).toBe(0);
      expect(s.evictions).toBe(0);
      expect(s.freezes).toBe(0);
      expect(s.thaws).toBe(0);
      expect(s.hitRate).toBe(0);
      expect(s.keyPrefixes).toEqual({});
    });

    it("respects maxIdleFrames + maxCacheSize constructor options", function () {
      const m = new WebGPURenderBundleManager(/** @type {any} */ ({}), {
        maxIdleFrames: 42,
        maxCacheSize: 7,
      });
      const s = m.statistics;
      expect(s.maxIdleFrames).toBe(42);
      expect(s.maxCacheSize).toBe(7);
    });
  });

  describe("freeze / thaw freezable contract", function () {
    it("asFreezable() returns the canonical name + functions", function () {
      const m = makeManager();
      const f = m.asFreezable();
      expect(f.name).toBe("webgpu-bundle-manager");
      expect(typeof f.freeze).toBe("function");
      expect(typeof f.thaw).toBe("function");
      expect(typeof f.isFrozen).toBe("function");
    });

    it("freeze() flips isFrozen and bumps the freezes counter exactly once", function () {
      const m = makeManager();
      expect(m.isFrozen).toBe(false);
      m.freeze();
      expect(m.isFrozen).toBe(true);
      expect(m.statistics.freezes).toBe(1);
      // Idempotent — second freeze() must NOT bump the counter again.
      m.freeze();
      expect(m.statistics.freezes).toBe(1);
    });

    it("thaw() clears isFrozen and bumps the thaws counter exactly once", function () {
      const m = makeManager();
      m.freeze();
      m.thaw();
      expect(m.isFrozen).toBe(false);
      expect(m.statistics.thaws).toBe(1);
      // Idempotent — second thaw() must NOT bump the counter again.
      m.thaw();
      expect(m.statistics.thaws).toBe(1);
    });
  });

  describe("frame advancement", function () {
    it("beginFrame() bumps the currentFrame counter", function () {
      const m = makeManager();
      const before = m.statistics.currentFrame;
      m.beginFrame();
      expect(m.statistics.currentFrame).toBe(before + 1);
      m.beginFrame();
      expect(m.statistics.currentFrame).toBe(before + 2);
    });

    it("beginFrame() during a freeze still advances the frame counter", function () {
      // The freeze flag only suppresses eviction; the frame counter
      // must keep advancing so the post-thaw lastUsedFrame reset
      // produces correct values.
      const m = makeManager();
      m.freeze();
      const before = m.statistics.currentFrame;
      m.beginFrame();
      expect(m.statistics.currentFrame).toBe(before + 1);
    });
  });

  describe("invalidate paths", function () {
    it("has() returns false for unknown keys", function () {
      const m = makeManager();
      expect(m.has("nope")).toBe(false);
    });

    it("invalidate() of unknown keys is a no-op", function () {
      const m = makeManager();
      expect(() => m.invalidate("nope")).not.toThrow();
      expect(m.statistics.cacheSize).toBe(0);
    });

    it("invalidateByPrefix() returns 0 when nothing matches", function () {
      const m = makeManager();
      expect(m.invalidateByPrefix("terrain_")).toBe(0);
    });

    it("invalidateAll() works on an empty cache", function () {
      const m = makeManager();
      expect(() => m.invalidateAll()).not.toThrow();
      expect(m.statistics.cacheSize).toBe(0);
    });
  });

  describe("resetStatisticsCounters()", function () {
    it("zeros every counter without touching the cache", function () {
      const m = makeManager();
      // Drive some counters via the public freezable contract.
      m.freeze();
      m.thaw();
      m.freeze();
      expect(m.statistics.freezes).toBe(2);
      expect(m.statistics.thaws).toBe(1);
      m.resetStatisticsCounters();
      const s = m.statistics;
      expect(s.freezes).toBe(0);
      expect(s.thaws).toBe(0);
      expect(s.hits).toBe(0);
      expect(s.misses).toBe(0);
      expect(s.ephemeralBuilds).toBe(0);
      expect(s.evictions).toBe(0);
      // The cache is untouched — the manager is still frozen.
      expect(m.isFrozen).toBe(true);
    });
  });

  describe("destroy()", function () {
    it("clears the cache and is safe to call on an empty manager", function () {
      const m = makeManager();
      expect(() => m.destroy()).not.toThrow();
      expect(m.statistics.cacheSize).toBe(0);
    });
  });
});
