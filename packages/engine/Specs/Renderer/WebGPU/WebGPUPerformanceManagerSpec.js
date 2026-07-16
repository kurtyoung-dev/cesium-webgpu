import WebGPUPerformanceManager from "../../../Source/Renderer/WebGPU/WebGPUPerformanceManager.js";

function createTimestampProfiler(results) {
  return {
    beginFrame: jasmine.createSpy("timestampProfiler.beginFrame"),
    endFrame: jasmine.createSpy("timestampProfiler.endFrame"),
    getPassTimestampWrites: jasmine.createSpy(
      "timestampProfiler.getPassTimestampWrites",
    ),
    getComputePassTimestampWrites: jasmine.createSpy(
      "timestampProfiler.getComputePassTimestampWrites",
    ),
    getResults: jasmine
      .createSpy("timestampProfiler.getResults")
      .and.returnValue(
        results ?? {
          enabled: true,
          frameMs: 0,
          passes: {},
        },
      ),
  };
}

function createContext(timestampProfiler) {
  return {
    supportsComputeShaders: false,
    renderBundleManager: null,
    indirectDrawManager: null,
    timestampProfiler,
    bufferMapper: null,
  };
}

function createManager(timestampProfiler, timestampProfiling) {
  return new WebGPUPerformanceManager(createContext(timestampProfiler), {
    renderBundles: false,
    indirectDraw: false,
    timestampProfiling,
  });
}

describe("Renderer/WebGPU/WebGPUPerformanceManager", function () {
  describe("indirect draw lifecycle", function () {
    it("does not touch the lazy manager for the default tile policy", function () {
      const context = createContext(null);
      context.useIndirectDrawForTiles = false;
      let managerReads = 0;
      Object.defineProperty(context, "indirectDrawManager", {
        get: function () {
          managerReads++;
          return {
            beginFrame: jasmine.createSpy("indirect.beginFrame"),
            flush: jasmine.createSpy("indirect.flush"),
            drawCount: 99,
          };
        },
      });
      // Omit `indirectDraw` so this exercises its capability-on default.
      const manager = new WebGPUPerformanceManager(context, {
        renderBundles: false,
        timestampProfiling: false,
      });

      expect(manager.config.indirectDraw).toBe(true);
      manager.beginFrame();
      manager.endFrame({});

      expect(managerReads).toBe(0);
      expect(manager.frameTimings.indirectDrawsBatched).toBe(0);
    });

    it("keeps explicitly requested tile indirect lifecycle and stats active", function () {
      const indirectManager = {
        beginFrame: jasmine.createSpy("indirect.beginFrame"),
        flush: jasmine.createSpy("indirect.flush"),
        drawCount: 7,
      };
      const context = createContext(null);
      context.useIndirectDrawForTiles = true;
      let managerReads = 0;
      Object.defineProperty(context, "indirectDrawManager", {
        get: function () {
          managerReads++;
          return indirectManager;
        },
      });
      const manager = new WebGPUPerformanceManager(context, {
        renderBundles: false,
        timestampProfiling: false,
      });

      manager.beginFrame();
      manager.endFrame({});

      expect(managerReads).toBeGreaterThan(0);
      expect(indirectManager.beginFrame).toHaveBeenCalledTimes(1);
      expect(indirectManager.flush).toHaveBeenCalledTimes(1);
      expect(manager.frameTimings.indirectDrawsBatched).toBe(7);
    });

    it("keeps the master feature flag authoritative when tiles request indirect drawing", function () {
      const context = createContext(null);
      context.useIndirectDrawForTiles = true;
      let managerReads = 0;
      Object.defineProperty(context, "indirectDrawManager", {
        get: function () {
          managerReads++;
          return {};
        },
      });
      const manager = new WebGPUPerformanceManager(context, {
        renderBundles: false,
        indirectDraw: false,
        timestampProfiling: false,
      });

      manager.beginFrame();
      manager.endFrame({});

      expect(managerReads).toBe(0);
      expect(manager.frameTimings.indirectDrawsBatched).toBe(0);
    });
  });

  describe("timestamp profiling lifecycle", function () {
    it("forwards beginFrame when timestamp profiling is enabled", function () {
      const profiler = createTimestampProfiler();
      const manager = createManager(profiler, true);

      manager.beginFrame();

      expect(profiler.beginFrame).toHaveBeenCalledTimes(1);
      expect(profiler.endFrame).not.toHaveBeenCalled();
      expect(profiler.getResults).not.toHaveBeenCalled();
    });

    it("begins timestamps only once when context starts before scene preparation", function () {
      const profiler = createTimestampProfiler();
      const manager = createManager(profiler, true);

      manager.beginTimestampFrame();
      manager.beginFrame();

      expect(profiler.beginFrame).toHaveBeenCalledTimes(1);
    });

    it("forwards the command encoder and maps profiler results", function () {
      const profiler = createTimestampProfiler({
        enabled: true,
        frameMs: 12.5,
        passes: {
          opaque: { lastMs: 7.25 },
          postProcess: { lastMs: 1.75 },
        },
      });
      const manager = createManager(profiler, true);
      const encoder = {};

      manager.beginFrame();
      manager.endFrame(encoder);

      expect(profiler.endFrame).toHaveBeenCalledOnceWith(encoder);
      expect(profiler.getResults).toHaveBeenCalledTimes(1);
      expect(manager.frameTimings.totalGpuMs).toBe(12.5);
      expect(manager.frameTimings.passes).toEqual({
        opaque: 7.25,
        postProcess: 1.75,
      });
    });

    it("ends an active frame only once", function () {
      const profiler = createTimestampProfiler();
      const manager = createManager(profiler, true);
      const encoder = {};

      manager.beginFrame();
      manager.endFrame(encoder);
      manager.endFrame(encoder);

      expect(profiler.endFrame).toHaveBeenCalledTimes(1);
      expect(profiler.getResults).toHaveBeenCalledTimes(1);
    });

    it("does not touch the profiler when timestamp profiling is disabled", function () {
      const profiler = createTimestampProfiler({
        enabled: true,
        frameMs: 99,
        passes: { unexpected: { lastMs: 42 } },
      });
      const manager = createManager(profiler, false);

      manager.beginFrame();
      manager.endFrame({});

      expect(profiler.beginFrame).not.toHaveBeenCalled();
      expect(profiler.endFrame).not.toHaveBeenCalled();
      expect(profiler.getResults).not.toHaveBeenCalled();
      expect(manager.frameTimings.totalGpuMs).toBe(0);
      expect(manager.frameTimings.passes).toEqual({});
    });
  });

  describe("pass descriptor decoration", function () {
    it("returns the original descriptor without profiler work when inactive", function () {
      const profiler = createTimestampProfiler();
      const manager = createManager(profiler, false);
      const descriptor = {
        label: "core-render-pass",
        colorAttachments: [],
      };

      const result = manager.withRenderPassTimestamps(descriptor);

      expect(result).toBe(descriptor);
      expect(profiler.getPassTimestampWrites).not.toHaveBeenCalled();
    });

    it("clones a render descriptor only when timestamp writes are attached", function () {
      const timestampWrites = {
        querySet: {},
        beginningOfPassWriteIndex: 0,
        endOfPassWriteIndex: 1,
      };
      const profiler = createTimestampProfiler();
      profiler.getPassTimestampWrites.and.returnValue(timestampWrites);
      const manager = createManager(profiler, true);
      const descriptor = {
        label: "core-render-pass",
        colorAttachments: [],
      };
      manager.beginTimestampFrame();

      const result = manager.withRenderPassTimestamps(descriptor);

      expect(result).not.toBe(descriptor);
      expect(result.timestampWrites).toBe(timestampWrites);
      expect(descriptor.timestampWrites).toBeUndefined();
      expect(profiler.getPassTimestampWrites).toHaveBeenCalledOnceWith(
        "core-render-pass",
      );
    });

    it("preserves caller-provided timestamp writes", function () {
      const callerWrites = {
        querySet: {},
        beginningOfPassWriteIndex: 8,
        endOfPassWriteIndex: 9,
      };
      const profiler = createTimestampProfiler();
      const manager = createManager(profiler, true);
      const descriptor = {
        label: "externally-timed-pass",
        colorAttachments: [],
        timestampWrites: callerWrites,
      };
      manager.beginTimestampFrame();

      const result = manager.withRenderPassTimestamps(descriptor);

      expect(result).toBe(descriptor);
      expect(result.timestampWrites).toBe(callerWrites);
      expect(profiler.getPassTimestampWrites).not.toHaveBeenCalled();
    });

    it("uses a stable fallback label for unnamed compute passes", function () {
      const timestampWrites = {
        querySet: {},
        beginningOfPassWriteIndex: 2,
        endOfPassWriteIndex: 3,
      };
      const profiler = createTimestampProfiler();
      profiler.getComputePassTimestampWrites.and.returnValue(timestampWrites);
      const manager = createManager(profiler, true);
      const descriptor = {};
      manager.beginTimestampFrame();

      const result = manager.withComputePassTimestamps(
        descriptor,
        "Core compute pass",
      );

      expect(result).not.toBe(descriptor);
      expect(result.timestampWrites).toBe(timestampWrites);
      expect(profiler.getComputePassTimestampWrites).toHaveBeenCalledOnceWith(
        "Core compute pass",
      );
    });
  });
});
