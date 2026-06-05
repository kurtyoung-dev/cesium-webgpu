import {
  getFrameStatistics,
  resetFrameStatistics,
  recordDrawCall,
} from "../../../Source/Renderer/WebGPU/WebGPUFrameStatistics.js";

// These specs are pure-function tests — no GPU device needed. The
// frame-statistics helpers operate over a plain `FrameStatisticsHost`
// duck-type (three mutable counters + three cache slots exposing
// `.size`/`.length`), so a hand-rolled fake host fully exercises every
// branch. Covering them here means an accidental field rename or a
// dropped `++` fails fast in CI instead of silently zeroing the
// renderer's getStatistics() output.

// Build a fake host matching the `FrameStatisticsHost` interface. The
// cache slots only need a numeric `.size` (samplers, BGLs) or `.length`
// (the uniform-buffer pool array), which the helpers read but never
// mutate.
function makeHost(overrides) {
  const host = {
    _frameCount: 0,
    _drawCallCount: 0,
    _triangleCount: 0,
    _samplerCache: { size: 0 },
    _bindGroupLayoutCache: { size: 0 },
    _uniformBufferPool: { length: 0 },
  };
  return Object.assign(host, overrides);
}

describe("Renderer/WebGPU/WebGPUFrameStatistics", function () {
  describe("getFrameStatistics", function () {
    it("snapshots all six counters/cache sizes from the host", function () {
      const host = makeHost({
        _frameCount: 7,
        _drawCallCount: 42,
        _triangleCount: 1234,
        _samplerCache: { size: 3 },
        _bindGroupLayoutCache: { size: 5 },
        _uniformBufferPool: { length: 9 },
      });
      const stats = getFrameStatistics(host);
      expect(stats).toEqual({
        frameCount: 7,
        drawCallCount: 42,
        triangleCount: 1234,
        samplerCacheSize: 3,
        bindGroupLayoutCacheSize: 5,
        uniformBufferPoolSize: 9,
      });
    });

    it("reads cache sizes via .size and pool via .length", function () {
      // Distinct values per slot so a swapped mapping (e.g. sampler ↔
      // BGL, or .size ↔ .length) would surface as a wrong field.
      const host = makeHost({
        _samplerCache: { size: 11 },
        _bindGroupLayoutCache: { size: 22 },
        _uniformBufferPool: { length: 33 },
      });
      const stats = getFrameStatistics(host);
      expect(stats.samplerCacheSize).toBe(11);
      expect(stats.bindGroupLayoutCacheSize).toBe(22);
      expect(stats.uniformBufferPoolSize).toBe(33);
    });

    it("returns a fresh snapshot object that does not alias the host", function () {
      const host = makeHost({ _frameCount: 1 });
      const stats = getFrameStatistics(host);
      // Mutating the host after the fact must not retroactively change
      // an already-captured snapshot (it's a plain value copy).
      host._frameCount = 99;
      expect(stats.frameCount).toBe(1);
    });

    it("produces independent snapshots across calls", function () {
      const host = makeHost({ _drawCallCount: 4 });
      const first = getFrameStatistics(host);
      host._drawCallCount = 8;
      const second = getFrameStatistics(host);
      expect(first.drawCallCount).toBe(4);
      expect(second.drawCallCount).toBe(8);
      expect(first).not.toBe(second);
    });
  });

  describe("resetFrameStatistics", function () {
    it("zeros frameCount, drawCallCount, and triangleCount", function () {
      const host = makeHost({
        _frameCount: 10,
        _drawCallCount: 20,
        _triangleCount: 30,
      });
      resetFrameStatistics(host);
      expect(host._frameCount).toBe(0);
      expect(host._drawCallCount).toBe(0);
      expect(host._triangleCount).toBe(0);
    });

    it("does not touch the cache slots", function () {
      const samplerCache = { size: 3 };
      const bglCache = { size: 5 };
      const pool = { length: 9 };
      const host = makeHost({
        _frameCount: 1,
        _samplerCache: samplerCache,
        _bindGroupLayoutCache: bglCache,
        _uniformBufferPool: pool,
      });
      resetFrameStatistics(host);
      // Same object identities, untouched sizes — the reset only owns
      // the three counters.
      expect(host._samplerCache).toBe(samplerCache);
      expect(host._bindGroupLayoutCache).toBe(bglCache);
      expect(host._uniformBufferPool).toBe(pool);
      expect(samplerCache.size).toBe(3);
      expect(bglCache.size).toBe(5);
      expect(pool.length).toBe(9);
    });

    it("is idempotent on an already-zeroed host", function () {
      const host = makeHost();
      resetFrameStatistics(host);
      resetFrameStatistics(host);
      expect(host._frameCount).toBe(0);
      expect(host._drawCallCount).toBe(0);
      expect(host._triangleCount).toBe(0);
    });
  });

  describe("recordDrawCall", function () {
    it("increments drawCallCount by exactly one", function () {
      const host = makeHost({ _drawCallCount: 5 });
      recordDrawCall(host, 100);
      expect(host._drawCallCount).toBe(6);
    });

    it("adds the triangle argument to triangleCount", function () {
      const host = makeHost({ _triangleCount: 1000 });
      recordDrawCall(host, 250);
      expect(host._triangleCount).toBe(1250);
    });

    it("defaults triangles to zero when the argument is omitted", function () {
      const host = makeHost({ _drawCallCount: 2, _triangleCount: 50 });
      recordDrawCall(host);
      expect(host._drawCallCount).toBe(3);
      expect(host._triangleCount).toBe(50);
    });

    it("accumulates correctly across repeated calls", function () {
      const host = makeHost();
      recordDrawCall(host, 12);
      recordDrawCall(host, 8);
      recordDrawCall(host, 30);
      expect(host._drawCallCount).toBe(3);
      expect(host._triangleCount).toBe(50);
    });

    it("does not mutate frameCount", function () {
      const host = makeHost({ _frameCount: 17 });
      recordDrawCall(host, 5);
      expect(host._frameCount).toBe(17);
    });

    it("feeds straight through to a subsequent getFrameStatistics snapshot", function () {
      // End-to-end of the three pure helpers: reset → record → snapshot.
      const host = makeHost({
        _frameCount: 4,
        _samplerCache: { size: 2 },
      });
      resetFrameStatistics(host);
      recordDrawCall(host, 6);
      recordDrawCall(host, 6);
      const stats = getFrameStatistics(host);
      // resetFrameStatistics zeroed frameCount; recordDrawCall bumped the
      // other two; the cache size is read live off the (untouched) slot.
      expect(stats.frameCount).toBe(0);
      expect(stats.drawCallCount).toBe(2);
      expect(stats.triangleCount).toBe(12);
      expect(stats.samplerCacheSize).toBe(2);
    });
  });
});
