import "./installWebGPUTestConstants.js";

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
// A pure fake device below also covers enabled-path query allocation,
// resolve/copy, asynchronous readback, duplicate-label aggregation, overflow,
// and destruction without requiring a physical GPU.

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

function fakeEnabledDevice(mapAsyncHook) {
  const buffers = [];
  const querySets = [];
  const device = {
    features: new Set(["timestamp-query"]),
    createQuerySet: function () {
      const querySet = { destroy: jasmine.createSpy("querySet.destroy") };
      querySets.push(querySet);
      return querySet;
    },
    createBuffer: function (descriptor) {
      let mapState = "unmapped";
      const storage = new ArrayBuffer(descriptor.size);
      const buffer = {
        get mapState() {
          return mapState;
        },
        mapAsync: function () {
          mapState = "pending";
          const pending = mapAsyncHook ? mapAsyncHook() : Promise.resolve();
          return pending.then(
            function () {
              mapState = "mapped";
            },
            function (error) {
              mapState = "unmapped";
              throw error;
            },
          );
        },
        getMappedRange: function () {
          return storage;
        },
        unmap: function () {
          mapState = "unmapped";
        },
        destroy: jasmine.createSpy("buffer.destroy"),
        _storage: storage,
      };
      buffers.push(buffer);
      return buffer;
    },
    _buffers: buffers,
    _querySets: querySets,
  };
  return /** @type {any} */ (device);
}

function fakeEncoder() {
  return /** @type {any} */ ({
    resolveQuerySet: jasmine.createSpy("resolveQuerySet"),
    copyBufferToBuffer: jasmine
      .createSpy("copyBufferToBuffer")
      .and.callFake(function (...args) {
        const destination = args[2];
        const offset = args[3];
        const size = args[4];
        const values = new BigUint64Array(
          destination._storage,
          offset,
          size / 8,
        );
        for (let i = 0; i < values.length; i++) {
          values[i] = BigInt(i) * 1000000n;
        }
      }),
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

  describe("enabled fake-device path", function () {
    it("allocates triple-buffered query state when explicitly enabled", function () {
      const device = fakeEnabledDevice();
      const profiler = new WebGPUTimestampProfiler(device, true);
      expect(profiler.enabled).toBe(true);
      expect(device._querySets.length).toBe(3);
      expect(device._buffers.length).toBe(6);
    });

    it("allocates pass query pairs and resolves them through the frame encoder", function () {
      const profiler = new WebGPUTimestampProfiler(fakeEnabledDevice(), true);
      const encoder = fakeEncoder();
      profiler.beginFrame();
      const writes = profiler.getPassTimestampWrites("globe");
      expect(writes.beginningOfPassWriteIndex).toBe(0);
      expect(writes.endOfPassWriteIndex).toBe(1);
      profiler.endFrame(encoder);
      expect(encoder.resolveQuerySet).toHaveBeenCalledTimes(1);
      expect(encoder.copyBufferToBuffer).toHaveBeenCalledTimes(1);
    });

    it("aggregates repeated labels within one frame", async function () {
      const profiler = new WebGPUTimestampProfiler(fakeEnabledDevice(), true);
      profiler.beginFrame();
      profiler.getPassTimestampWrites("opaque");
      profiler.getPassTimestampWrites("opaque");
      profiler.endFrame(fakeEncoder());
      profiler.afterSubmit();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      const results = profiler.getResults();
      expect(results.passes.opaque.lastMs).toBe(2);
      expect(results.frameMs).toBe(3);
      expect(results.profiledPassMs).toBe(2);
      expect(results.unprofiledMs).toBe(1);
      expect(results.coverageRatio).toBeCloseTo(2 / 3, 8);
      expect(results.coverageScope).toBe("between-first-and-last-timed-pass");
      expect(results.frameCount).toBe(1);
      expect(results.attemptedFrameCount).toBe(1);
    });

    it("does not publish an in-flight sample after reset", async function () {
      let resolveMap;
      const mapPromise = new Promise(function (resolve) {
        resolveMap = resolve;
      });
      const profiler = new WebGPUTimestampProfiler(
        fakeEnabledDevice(function () {
          return mapPromise;
        }),
        true,
      );
      profiler.beginFrame();
      profiler.getPassTimestampWrites("old-frame");
      profiler.endFrame(fakeEncoder());
      profiler.afterSubmit();
      profiler.reset();
      resolveMap();
      await mapPromise;
      await Promise.resolve();
      await Promise.resolve();
      const results = profiler.getResults();
      expect(results.passes).toEqual({});
      expect(results.frameCount).toBe(0);
      expect(results.attemptedFrameCount).toBe(0);
    });

    it("does not publish a partially recorded frame when reset happens before endFrame", async function () {
      const profiler = new WebGPUTimestampProfiler(fakeEnabledDevice(), true);
      profiler.beginFrame();
      profiler.getPassTimestampWrites("pre-reset-frame");
      profiler.reset();
      profiler.endFrame(fakeEncoder());
      profiler.afterSubmit();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      const results = profiler.getResults();
      expect(results.passes).toEqual({});
      expect(results.frameCount).toBe(0);
    });

    it("reports pass-query overflow instead of silently losing it", function () {
      const profiler = new WebGPUTimestampProfiler(fakeEnabledDevice(), true);
      profiler.beginFrame();
      for (let i = 0; i < 128; i++) {
        expect(profiler.getPassTimestampWrites(`pass-${i}`)).toBeDefined();
      }
      expect(profiler.getPassTimestampWrites("overflow")).toBeUndefined();
      expect(profiler.getResults().droppedPassCount).toBe(1);
    });
  });

  describe("getResults() when disabled", function () {
    it("returns the documented zeroed ProfilingResults shape", function () {
      const profiler = new WebGPUTimestampProfiler(stubDevice([]), false);
      const results = profiler.getResults();
      expect(results.enabled).toBe(false);
      expect(results.frameMs).toBe(0);
      expect(results.frameAvgMs).toBe(0);
      expect(results.profiledPassMs).toBe(0);
      expect(results.unprofiledMs).toBe(0);
      expect(results.coverageRatio).toBeNull();
      expect(results.coverageScope).toBe("between-first-and-last-timed-pass");
      expect(results.passes).toEqual({});
      expect(results.frameCount).toBe(0);
      expect(results.attemptedFrameCount).toBe(0);
      expect(results.failedReadbackCount).toBe(0);
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
