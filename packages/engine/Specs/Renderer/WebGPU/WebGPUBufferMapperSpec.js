import WebGPUBufferMapper from "../../../Source/Renderer/WebGPU/WebGPUBufferMapper.js";

// `GPUMapMode` isn't declared in every Karma runner (only present when the
// browser exposes WebGPU). The cache-reuse specs below pass GPUMapMode.WRITE
// as the `mode` argument, so the symbol must resolve even though the reuse
// path never reads it. Provide the WebGPU-spec values. (Mirrors the
// GPUMapMode / GPUShaderStage shims in WebGPUTextureUtilitiesSpec /
// WebGPUBindGroupReflectionSpec.)
if (typeof globalThis.GPUMapMode === "undefined") {
  globalThis.GPUMapMode = {
    READ: 0x0001,
    WRITE: 0x0002,
  };
}

// ── Test fixtures ───────────────────────────────────────────────────
//
// WebGPUBufferMapper's transfer paths (uploadViaStagingBuffer,
// readbackBuffer, readbackTyped) call device.createCommandEncoder /
// device.queue.submit / buffer.mapAsync / getMappedRange — all of which
// need a live GPUDevice + queue. The constructor itself only stores the
// device reference; it never touches it, so a bare stub is safe for
// everything below.
//
// These specs cover the parts that DON'T need a device:
//   - constructor + getStats() default shape
//   - isDestroyed getter default + post-destroy
//   - destroy() idempotency + cache clearing (empty caches never call
//     buffer.destroy(), so no device is needed)
//   - advanceFrame() frame-counter advance + no-trim on under-capacity
//     caches (trim only fires above _maxCachedBuffers = 4, and only then
//     calls buffer.destroy())
//   - getStats().cachedStagingBuffers accounting, exercised by seeding
//     the private staging/readback cache arrays with fake entries
//   - the staging/readback cache-REUSE path of _getStagingBuffer /
//     _getReadbackBuffer (cache hit returns the cached buffer WITHOUT a
//     device.createBuffer call), including the size-match predicate
//     `entry.size >= size && entry.size <= size * 2`
//
// SKIPPED (device-bound — require a real GPUDevice/queue):
// uploadViaStagingBuffer, readbackBuffer, readbackTyped, and the
// create-NEW branch of _getStagingBuffer / _getReadbackBuffer.

// A stub device — never invoked by any path exercised here.
function makeMapper() {
  return new WebGPUBufferMapper(/** @type {any} */ ({}));
}

// A throwaway value standing in for a GPUBuffer in a seeded cache entry.
// The reuse path never inspects it; the destroy/advanceFrame paths under
// test never reach buffer.destroy() because the caches stay empty there.
function fakeBuffer(tag) {
  return /** @type {any} */ ({ __fakeBuffer: tag });
}

// Seed a staging/readback cache array with an entry matching the private
// StagingEntry shape { buffer, size, lastUsed }.
function makeEntry(buffer, size) {
  return { buffer: buffer, size: size, lastUsed: 0 };
}

describe("Renderer/WebGPU/WebGPUBufferMapper", function () {
  describe("constructor + getStats() defaults", function () {
    it("is defined", function () {
      expect(WebGPUBufferMapper).toBeDefined();
    });

    it("reports a zeroed stats shape on a fresh mapper", function () {
      const mapper = makeMapper();
      const s = mapper.getStats();
      expect(s.uploadCount).toBe(0);
      expect(s.readbackCount).toBe(0);
      expect(s.totalBytesUploaded).toBe(0);
      expect(s.totalBytesReadback).toBe(0);
      expect(s.cachedStagingBuffers).toBe(0);
    });

    it("starts not destroyed", function () {
      expect(makeMapper().isDestroyed).toBe(false);
    });
  });

  describe("isDestroyed getter + destroy()", function () {
    it("flips isDestroyed to true after destroy()", function () {
      const mapper = makeMapper();
      mapper.destroy();
      expect(mapper.isDestroyed).toBe(true);
    });

    it("is idempotent (second destroy is a no-op, no throw)", function () {
      const mapper = makeMapper();
      mapper.destroy();
      expect(() => mapper.destroy()).not.toThrow();
      expect(mapper.isDestroyed).toBe(true);
    });

    it("does not call buffer.destroy() when caches are empty", function () {
      // Empty caches mean the for-loops in destroy() never iterate, so no
      // GPUBuffer method is reached — safe without a device.
      const mapper = makeMapper();
      expect(() => mapper.destroy()).not.toThrow();
    });

    it("clears seeded caches and zeroes cachedStagingBuffers", function () {
      const mapper = makeMapper();
      // Stub buffer.destroy() so the destroy() loop is device-free.
      const destroyed = [];
      const b1 = /** @type {any} */ ({ destroy: () => destroyed.push("s1") });
      const b2 = /** @type {any} */ ({ destroy: () => destroyed.push("r1") });
      mapper._stagingCache = [makeEntry(b1, 256)];
      mapper._readbackCache = [makeEntry(b2, 256)];
      expect(mapper.getStats().cachedStagingBuffers).toBe(2);

      mapper.destroy();
      expect(destroyed).toEqual(["s1", "r1"]);
      expect(mapper.getStats().cachedStagingBuffers).toBe(0);
    });
  });

  describe("getStats() cachedStagingBuffers accounting", function () {
    it("sums staging + readback cache lengths", function () {
      const mapper = makeMapper();
      mapper._stagingCache = [
        makeEntry(fakeBuffer("s1"), 64),
        makeEntry(fakeBuffer("s2"), 128),
      ];
      mapper._readbackCache = [makeEntry(fakeBuffer("r1"), 64)];
      expect(mapper.getStats().cachedStagingBuffers).toBe(3);
    });
  });

  describe("advanceFrame()", function () {
    it("advances the frame counter without throwing on empty caches", function () {
      const mapper = makeMapper();
      expect(() => mapper.advanceFrame()).not.toThrow();
      expect(mapper._frameCount).toBe(1);
      mapper.advanceFrame();
      expect(mapper._frameCount).toBe(2);
    });

    it("does not trim when caches are at or below capacity (4)", function () {
      // Exactly _maxCachedBuffers (4) entries: the `while length > 4`
      // trim loops never fire, so no buffer.destroy() is called — safe
      // without a device.
      const mapper = makeMapper();
      mapper._stagingCache = [
        makeEntry(fakeBuffer("s1"), 64),
        makeEntry(fakeBuffer("s2"), 64),
        makeEntry(fakeBuffer("s3"), 64),
        makeEntry(fakeBuffer("s4"), 64),
      ];
      mapper.advanceFrame();
      expect(mapper._stagingCache.length).toBe(4);
      expect(mapper.getStats().cachedStagingBuffers).toBe(4);
    });

    it("trims the oldest staging buffers above capacity", function () {
      // 6 entries → trim down to 4; the 2 shifted (oldest) entries have
      // their buffer.destroy() called. Stub destroy() to stay device-free.
      const mapper = makeMapper();
      const destroyed = [];
      const mk = (tag) =>
        makeEntry(
          /** @type {any} */ ({ destroy: () => destroyed.push(tag) }),
          64,
        );
      mapper._stagingCache = [
        mk("s1"),
        mk("s2"),
        mk("s3"),
        mk("s4"),
        mk("s5"),
        mk("s6"),
      ];
      mapper.advanceFrame();
      expect(mapper._stagingCache.length).toBe(4);
      // shift() removes from the front, so the two oldest go first.
      expect(destroyed).toEqual(["s1", "s2"]);
    });

    it("trims the oldest readback buffers above capacity", function () {
      const mapper = makeMapper();
      const destroyed = [];
      const mk = (tag) =>
        makeEntry(
          /** @type {any} */ ({ destroy: () => destroyed.push(tag) }),
          64,
        );
      mapper._readbackCache = [
        mk("r1"),
        mk("r2"),
        mk("r3"),
        mk("r4"),
        mk("r5"),
      ];
      mapper.advanceFrame();
      expect(mapper._readbackCache.length).toBe(4);
      expect(destroyed).toEqual(["r1"]);
    });
  });

  describe("_getStagingBuffer() cache-reuse path", function () {
    it("returns a cached buffer of sufficient size without a device call", function () {
      const mapper = makeMapper();
      const cached = fakeBuffer("reuse");
      // size 256 satisfies the predicate for a 256 request:
      //   256 >= 256 && 256 <= 512.
      mapper._stagingCache = [makeEntry(cached, 256)];

      const got = mapper._getStagingBuffer(256, GPUMapMode.WRITE);
      expect(got).toBe(cached);
      // The reused entry is spliced out of the cache.
      expect(mapper._stagingCache.length).toBe(0);
    });

    it("stamps the reused entry's lastUsed with the current frame count", function () {
      const mapper = makeMapper();
      mapper._frameCount = 7;
      const entry = makeEntry(fakeBuffer("reuse"), 256);
      mapper._stagingCache = [entry];
      mapper._getStagingBuffer(256, GPUMapMode.WRITE);
      // lastUsed is set before the entry leaves the array (splice keeps
      // the object), so we can read it off the original reference.
      expect(entry.lastUsed).toBe(7);
    });

    it("rejects a cached buffer more than 2x the requested size", function () {
      const mapper = makeMapper();
      // 256 is NOT <= 100 * 2 (200), so the predicate fails: the cached
      // entry is skipped. With no device, the create-new branch would
      // throw on {}.createBuffer — assert that throw proves we fell
      // through past the reuse path.
      mapper._stagingCache = [makeEntry(fakeBuffer("toobig"), 256)];
      expect(() => mapper._getStagingBuffer(100, GPUMapMode.WRITE)).toThrow();
      // The oversized entry must remain (it was not consumed).
      expect(mapper._stagingCache.length).toBe(1);
    });

    it("rejects a cached buffer smaller than the requested size", function () {
      const mapper = makeMapper();
      // 64 < 128, predicate fails → fall through to the device-bound
      // create branch, which throws on the stub device.
      mapper._stagingCache = [makeEntry(fakeBuffer("toosmall"), 64)];
      expect(() => mapper._getStagingBuffer(128, GPUMapMode.WRITE)).toThrow();
      expect(mapper._stagingCache.length).toBe(1);
    });
  });

  describe("_getReadbackBuffer() cache-reuse path", function () {
    it("returns a cached readback buffer of sufficient size", function () {
      const mapper = makeMapper();
      const cached = fakeBuffer("reuse-rb");
      mapper._readbackCache = [makeEntry(cached, 512)];
      // 512 >= 512 && 512 <= 1024 → reuse.
      const got = mapper._getReadbackBuffer(512);
      expect(got).toBe(cached);
      expect(mapper._readbackCache.length).toBe(0);
    });

    it("rejects an oversized cached readback buffer (>2x request)", function () {
      const mapper = makeMapper();
      // 512 > 200 * 2 (400) → predicate fails → device-bound create →
      // throws on the stub device.
      mapper._readbackCache = [makeEntry(fakeBuffer("big-rb"), 512)];
      expect(() => mapper._getReadbackBuffer(200)).toThrow();
      expect(mapper._readbackCache.length).toBe(1);
    });
  });
});
