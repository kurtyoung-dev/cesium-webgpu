import WebGPUTimestampProfiler from "../../../Source/Renderer/WebGPU/WebGPUTimestampProfiler.js";

// ── Test fixtures ───────────────────────────────────────────────────
//
// WebGPUTimestampProfiler's enabled path calls device.createQuerySet /
// device.createBuffer (in _createFrameState) and, per frame,
// encoder.resolveQuerySet / encoder.copyBufferToBuffer plus async
// buffer.mapAsync — all of which need a live GPUDevice/queue.
//
// The constructor only reaches that path when BOTH the caller passes
// hasTimestampFeature === true AND device.features.has("timestamp-query")
// returns true. When either is false, _enabled stays false and the
// constructor returns BEFORE touching device.create* — so a bare stub
// whose features.has() returns false drives the entire disabled state
// machine with zero GPU calls.
//
// These specs cover the device-free surface deterministically:
//   - constructor default (no feature) → disabled, device.create* never hit
//   - the hasTimestampFeature && features.has() gating decision (both
//     factors required), verified via a stub features set
//   - getResults() disabled shape (the documented zeroed ProfilingResults)
//   - beginFrame / endFrame / getPassTimestampWrites /
//     getComputePassTimestampWrites no-op when disabled
//   - enabled / isDestroyed getters
//   - destroy() idempotence + isDestroyed flip on a disabled profiler
//     (empty _frameStates → no GPU resource .destroy() calls)
//
// SKIPPED (device-bound — require a real GPUDevice/queue): the enabled
// constructor (_createFrameState), endFrame's resolve/copy, _readOldestFrame
// readback + per-pass stats, and the enabled getPass*TimestampWrites slot
// allocation. Those need an actual timestamp-query-capable device.

// A stub device whose feature set is configurable. The disabled paths
// only ever read device.features.has(...); they never call create*.
function stubDevice(features) {
  return /** @type {any} */ ({
    features: {
      has: function (name) {
        return features.indexOf(name) !== -1;
      },
    },
    // create* are intentionally absent — if any disabled path tried to
    // call one, the spec would throw and fail loudly rather than pass
    // on a silently-wrong code path.
  });
}

describe("Renderer/WebGPU/WebGPUTimestampProfiler", function () {
  it("is defined", function () {
    expect(WebGPUTimestampProfiler).toBeDefined();
  });

  describe("constructor + enabled gating", function () {
    it("defaults to disabled when hasTimestampFeature is omitted", function () {
      // Default arg is false → disabled regardless of device features, and
      // the constructor never reads device.features (short-circuit) nor
      // calls device.create*.
      const profiler = new WebGPUTimestampProfiler(
        stubDevice(["timestamp-query"]),
      );
      expect(profiler.enabled).toBe(false);
    });

    it("stays disabled when hasTimestampFeature is true but the device lacks the feature", function () {
      // Both factors are required: feature flag AND device support.
      const profiler = new WebGPUTimestampProfiler(stubDevice([]), true);
      expect(profiler.enabled).toBe(false);
    });

    it("stays disabled when the device has the feature but the caller passes false", function () {
      const profiler = new WebGPUTimestampProfiler(
        stubDevice(["timestamp-query"]),
        false,
      );
      expect(profiler.enabled).toBe(false);
    });

    it("does not call device.create* on the disabled path", function () {
      // The stub device has no create* methods; reaching the enabled
      // constructor branch would throw. A clean construction proves the
      // disabled path is purely state assignment.
      expect(function () {
        return new WebGPUTimestampProfiler(stubDevice([]), true);
      }).not.toThrow();
    });

    it("starts not destroyed", function () {
      const profiler = new WebGPUTimestampProfiler(stubDevice([]), false);
      expect(profiler.isDestroyed).toBe(false);
    });
  });

  describe("getResults() when disabled", function () {
    it("returns the documented zeroed ProfilingResults shape", function () {
      const profiler = new WebGPUTimestampProfiler(stubDevice([]), false);
      const results = profiler.getResults();
      expect(results.enabled).toBe(false);
      expect(results.frameMs).toBe(0);
      expect(results.frameAvgMs).toBe(0);
      expect(results.passes).toEqual({});
      expect(results.frameCount).toBe(0);
    });

    it("reports frameCount 0 before any frames are profiled", function () {
      const profiler = new WebGPUTimestampProfiler(stubDevice([]), false);
      expect(profiler.getResults().frameCount).toBe(0);
    });
  });

  describe("per-frame methods when disabled (no-ops)", function () {
    it("beginFrame is a no-op and does not throw", function () {
      const profiler = new WebGPUTimestampProfiler(stubDevice([]), false);
      expect(function () {
        profiler.beginFrame();
      }).not.toThrow();
    });

    it("endFrame returns early without touching the (null-method) encoder", function () {
      const profiler = new WebGPUTimestampProfiler(stubDevice([]), false);
      // An encoder stub with no methods — endFrame must return before
      // calling resolveQuerySet / copyBufferToBuffer when disabled.
      const encoder = /** @type {any} */ ({});
      expect(function () {
        profiler.endFrame(encoder);
      }).not.toThrow();
    });

    it("getPassTimestampWrites returns undefined when disabled", function () {
      const profiler = new WebGPUTimestampProfiler(stubDevice([]), false);
      expect(profiler.getPassTimestampWrites("terrain")).toBeUndefined();
    });

    it("getComputePassTimestampWrites returns undefined when disabled", function () {
      const profiler = new WebGPUTimestampProfiler(stubDevice([]), false);
      expect(profiler.getComputePassTimestampWrites("cull")).toBeUndefined();
    });

    it("getResults stays disabled-shaped after a begin/end cycle while disabled", function () {
      const profiler = new WebGPUTimestampProfiler(stubDevice([]), false);
      profiler.beginFrame();
      profiler.endFrame(/** @type {any} */ ({}));
      const results = profiler.getResults();
      // endFrame's frame-count bookkeeping lives behind the enabled guard,
      // so a disabled profiler never advances frameCount.
      expect(results.enabled).toBe(false);
      expect(results.frameCount).toBe(0);
    });
  });

  describe("destroy() when disabled", function () {
    it("flips isDestroyed and does not throw with an empty frame-state list", function () {
      const profiler = new WebGPUTimestampProfiler(stubDevice([]), false);
      expect(function () {
        profiler.destroy();
      }).not.toThrow();
      expect(profiler.isDestroyed).toBe(true);
    });

    it("is idempotent", function () {
      const profiler = new WebGPUTimestampProfiler(stubDevice([]), false);
      profiler.destroy();
      expect(function () {
        profiler.destroy();
      }).not.toThrow();
      expect(profiler.isDestroyed).toBe(true);
    });

    it("getResults still reports the disabled shape after destroy", function () {
      const profiler = new WebGPUTimestampProfiler(stubDevice([]), false);
      profiler.destroy();
      const results = profiler.getResults();
      expect(results.enabled).toBe(false);
      expect(results.passes).toEqual({});
    });
  });
});
