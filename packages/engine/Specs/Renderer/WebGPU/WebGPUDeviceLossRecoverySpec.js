import {
  DeviceLossState,
  WebGPUDeviceLossRecovery,
} from "../../../Source/Renderer/WebGPU/WebGPUDeviceLossRecovery.js";
import { WebGPUContext } from "../../../Source/Renderer/WebGPU/WebGPUContext.js";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function flushMicrotasks(count = 12) {
  for (let i = 0; i < count; i++) {
    await Promise.resolve();
  }
}

function makeSourceDevice() {
  const loss = deferred();
  const device = {
    lost: loss.promise,
    destroy: jasmine.createSpy("sourceDevice.destroy"),
  };
  return { device, loss };
}

function makeCandidateDevice(name) {
  return {
    lost: {
      then: jasmine.createSpy(`${name}.lost.then`),
    },
    destroy: jasmine.createSpy(`${name}.destroy`),
  };
}

function makeHost(sourceDevice, overrides = {}) {
  const sourceAdapter = { label: "source-adapter" };
  const host = {
    _adapter: sourceAdapter,
    _device: sourceDevice,
    _isDestroyed: false,
    _isTerminallyLost: false,
    _deviceFromPool: overrides.deviceFromPool ?? true,
    _options: {
      useDevicePool: overrides.useDevicePool ?? true,
    },
    _context: null,
  };

  host._setAdapter = jasmine
    .createSpy("host._setAdapter")
    .and.callFake(function (adapter) {
      host._adapter = adapter;
    });
  host._setDevice = jasmine
    .createSpy("host._setDevice")
    .and.callFake(function (device) {
      host._device = device;
    });
  host._initializeContextLimits = jasmine.createSpy(
    "host._initializeContextLimits",
  );
  host._reconfigureCanvas = jasmine.createSpy("host._reconfigureCanvas");
  host._initializeDefaultTextures = jasmine.createSpy(
    "host._initializeDefaultTextures",
  );
  host._clearAllCaches = jasmine.createSpy("host._clearAllCaches");
  host._rollbackRecoveredDevice = jasmine.createSpy(
    "host._rollbackRecoveredDevice",
  );

  return { host, sourceAdapter };
}

async function beginRecovery(recovery, source, operations) {
  recovery.setupHandler(source.device);
  source.loss.resolve({ reason: "unknown", message: "test loss" });
  await flushMicrotasks();
  expect(operations.delay).toHaveBeenCalled();
}

describe("Renderer/WebGPU/WebGPUDeviceLossRecovery", function () {
  beforeEach(function () {
    spyOn(console, "error");
    spyOn(console, "warn");
    spyOn(console, "log");
  });

  it("ignores the lost promise produced by context teardown", async function () {
    const source = makeSourceDevice();
    const { host } = makeHost(source.device);
    const operations = {
      delay: jasmine.createSpy("delay"),
      recoverPooledDevice: jasmine.createSpy("recoverPooledDevice"),
      requestAdapter: jasmine.createSpy("requestAdapter"),
      releasePooledDevice: jasmine.createSpy("releasePooledDevice"),
    };
    const recovery = new WebGPUDeviceLossRecovery(host, 1, operations);
    const listener = jasmine.createSpy("listener");
    recovery.onDeviceLost(listener);
    recovery.setupHandler(source.device);

    await recovery.dispose();
    source.loss.resolve({
      reason: "destroyed",
      message: "Device was destroyed",
    });
    await flushMicrotasks();

    expect(console.error).not.toHaveBeenCalled();
    expect(listener).not.toHaveBeenCalled();
    expect(operations.delay).not.toHaveBeenCalled();
    expect(operations.recoverPooledDevice).not.toHaveBeenCalled();
    expect(operations.requestAdapter).not.toHaveBeenCalled();
    expect(host._isTerminallyLost).toBeFalse();
    expect(recovery.state).toBe(DeviceLossState.FATAL);
  });

  it("reports an externally destroyed device without attempting recovery", async function () {
    const source = makeSourceDevice();
    const { host } = makeHost(source.device);
    const operations = {
      delay: jasmine.createSpy("delay"),
      recoverPooledDevice: jasmine.createSpy("recoverPooledDevice"),
      requestAdapter: jasmine.createSpy("requestAdapter"),
      releasePooledDevice: jasmine.createSpy("releasePooledDevice"),
    };
    const recovery = new WebGPUDeviceLossRecovery(host, 1, operations);
    const listener = jasmine.createSpy("listener");
    recovery.onDeviceLost(listener);
    recovery.setupHandler(source.device);

    source.loss.resolve({ reason: "destroyed", message: "external destroy" });
    await flushMicrotasks();

    expect(console.error).toHaveBeenCalledOnceWith(
      "[WebGPU] Device lost (reason: destroyed): external destroy",
    );
    expect(listener).toHaveBeenCalledOnceWith({
      reason: "destroyed",
      message: "external destroy",
      state: DeviceLossState.FATAL,
      willRecover: false,
    });
    expect(operations.delay).not.toHaveBeenCalled();
    expect(operations.recoverPooledDevice).not.toHaveBeenCalled();
    expect(operations.requestAdapter).not.toHaveBeenCalled();
    expect(host._isTerminallyLost).toBeTrue();
    expect(recovery.state).toBe(DeviceLossState.FATAL);
  });

  it("does not acquire or mutate the host when disposed during backoff", async function () {
    const source = makeSourceDevice();
    const { host } = makeHost(source.device);
    const backoff = deferred();
    const operations = {
      delay: jasmine.createSpy("delay").and.callFake(function () {
        return backoff.promise;
      }),
      recoverPooledDevice: jasmine.createSpy("recoverPooledDevice"),
      requestAdapter: jasmine.createSpy("requestAdapter"),
      releasePooledDevice: jasmine.createSpy("releasePooledDevice"),
    };
    const recovery = new WebGPUDeviceLossRecovery(host, 1, operations);

    await beginRecovery(recovery, source, operations);
    const disposed = recovery.dispose();
    backoff.resolve();
    await disposed;

    expect(operations.recoverPooledDevice).not.toHaveBeenCalled();
    expect(operations.requestAdapter).not.toHaveBeenCalled();
    expect(host._setAdapter).not.toHaveBeenCalled();
    expect(host._setDevice).not.toHaveBeenCalled();
    expect(host._device).toBe(source.device);
    expect(recovery.state).toBe(DeviceLossState.FATAL);
  });

  it("releases an acquired pooled candidate exactly once when disposed during acquisition", async function () {
    const source = makeSourceDevice();
    const { host } = makeHost(source.device);
    const acquisition = deferred();
    const candidate = makeCandidateDevice("pooledCandidate");
    const candidateAdapter = { label: "candidate-adapter" };
    const operations = {
      delay: jasmine.createSpy("delay").and.callFake(function () {
        return Promise.resolve();
      }),
      recoverPooledDevice: jasmine
        .createSpy("recoverPooledDevice")
        .and.callFake(function () {
          return acquisition.promise;
        }),
      requestAdapter: jasmine.createSpy("requestAdapter"),
      releasePooledDevice: jasmine.createSpy("releasePooledDevice"),
    };
    const recovery = new WebGPUDeviceLossRecovery(host, 1, operations);

    await beginRecovery(recovery, source, operations);
    expect(operations.recoverPooledDevice).toHaveBeenCalledTimes(1);

    const disposed = recovery.dispose();
    acquisition.resolve({ adapter: candidateAdapter, device: candidate });
    await disposed;

    expect(operations.releasePooledDevice).toHaveBeenCalledOnceWith(candidate);
    expect(candidate.destroy).not.toHaveBeenCalled();
    expect(candidate.lost.then).not.toHaveBeenCalled();
    expect(host._setAdapter).not.toHaveBeenCalled();
    expect(host._setDevice).not.toHaveBeenCalled();
    expect(host._device).toBe(source.device);
  });

  it("rolls back failed pooled reinitialization before returning its lease", async function () {
    const source = makeSourceDevice();
    const { host, sourceAdapter } = makeHost(source.device);
    const candidate = makeCandidateDevice("failedPooledCandidate");
    const candidateAdapter = { label: "candidate-adapter" };
    host._initializeDefaultTextures.and.throwError("texture init failed");
    const operations = {
      delay: jasmine.createSpy("delay").and.callFake(function () {
        return Promise.resolve();
      }),
      recoverPooledDevice: jasmine
        .createSpy("recoverPooledDevice")
        .and.callFake(function () {
          return Promise.resolve({
            adapter: candidateAdapter,
            device: candidate,
          });
        }),
      requestAdapter: jasmine.createSpy("requestAdapter"),
      releasePooledDevice: jasmine.createSpy("releasePooledDevice"),
    };
    const recovery = new WebGPUDeviceLossRecovery(host, 1, operations);

    await beginRecovery(recovery, source, operations);
    await flushMicrotasks();

    expect(host._rollbackRecoveredDevice).toHaveBeenCalledOnceWith(candidate);
    expect(operations.releasePooledDevice).toHaveBeenCalledOnceWith(candidate);
    expect(candidate.destroy).not.toHaveBeenCalled();
    expect(candidate.lost.then).not.toHaveBeenCalled();
    expect(host._adapter).toBe(sourceAdapter);
    expect(host._device).toBe(source.device);
    expect(host._deviceFromPool).toBeTrue();
    expect(host._clearAllCaches).not.toHaveBeenCalled();
    expect(host._isDestroyed).toBeFalse();
    expect(host._isTerminallyLost).toBeTrue();
    expect(recovery.state).toBe(DeviceLossState.FATAL);
  });

  it("commits recovery when lost compatibility natives throw during cleanup", async function () {
    const source = makeSourceDevice();
    const { host } = makeHost(source.device);
    const candidate = makeCandidateDevice("cleanupTolerantCandidate");
    const candidateAdapter = { label: "candidate-adapter" };
    const cleanupError = new Error("lost texture destroy failed");
    const cleanupContext = Object.create(WebGPUContext.prototype);
    cleanupContext._drainAfterFrameSubmitCallbacks = jasmine.createSpy(
      "cleanupContext._drainAfterFrameSubmitCallbacks",
    );
    cleanupContext._currentRenderPassEncoder = {};
    cleanupContext._activePassTarget = {};
    cleanupContext._currentCommandEncoder = {};
    cleanupContext._currentTextureView = {};
    cleanupContext._pendingTextureMipJobs = [
      { texture: {}, device: source.device, resourceGeneration: 12 },
    ];
    cleanupContext._cacheRegistry = {
      clearAll: jasmine.createSpy("cleanupContext.clearAll"),
    };
    cleanupContext._gl = {
      invalidateCompatibilityTextureHandles: jasmine
        .createSpy("cleanupContext.invalidateTextures")
        .and.throwError(cleanupError),
      invalidateCompatibilityBufferHandles: jasmine.createSpy(
        "cleanupContext.invalidateBuffers",
      ),
    };
    cleanupContext._device = null;
    cleanupContext._deviceResourceGeneration = 12;
    cleanupContext._environmentDemandRegistry = {
      reset: jasmine.createSpy("cleanupContext.resetDemand"),
    };
    cleanupContext._environmentRefreshScheduler = {
      reset: jasmine.createSpy("cleanupContext.resetScheduler"),
    };
    cleanupContext._environmentTargetPool = null;
    cleanupContext._fireDeviceInvalidated = jasmine.createSpy(
      "cleanupContext.fireInvalidated",
    );
    host._clearAllCaches.and.callFake(function () {
      WebGPUContext.prototype._clearAllCaches.call(cleanupContext, null);
    });
    const operations = {
      delay: jasmine.createSpy("delay").and.resolveTo(),
      recoverPooledDevice: jasmine
        .createSpy("recoverPooledDevice")
        .and.resolveTo({ adapter: candidateAdapter, device: candidate }),
      requestAdapter: jasmine.createSpy("requestAdapter"),
      releasePooledDevice: jasmine.createSpy("releasePooledDevice"),
    };
    const recovery = new WebGPUDeviceLossRecovery(host, 1, operations);

    await beginRecovery(recovery, source, operations);
    await flushMicrotasks();

    expect(host._device).toBe(candidate);
    expect(host._rollbackRecoveredDevice).not.toHaveBeenCalled();
    expect(operations.releasePooledDevice).not.toHaveBeenCalled();
    expect(candidate.destroy).not.toHaveBeenCalled();
    expect(cleanupContext._deviceResourceGeneration).toBe(13);
    expect(cleanupContext._pendingTextureMipJobs.length).toBe(0);
    expect(
      cleanupContext._gl.invalidateCompatibilityBufferHandles,
    ).toHaveBeenCalled();
    expect(cleanupContext._fireDeviceInvalidated).toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalledWith(
      "[WebGPU] Recovered with an old-device cleanup error:",
      cleanupError,
    );
    expect(recovery.state).toBe(DeviceLossState.HEALTHY);
  });

  it("destroys a failed isolated candidate without touching the pool", async function () {
    const source = makeSourceDevice();
    const { host, sourceAdapter } = makeHost(source.device, {
      deviceFromPool: false,
      useDevicePool: false,
    });
    const candidate = makeCandidateDevice("failedIsolatedCandidate");
    const candidateAdapter = {
      requestDevice: jasmine
        .createSpy("candidateAdapter.requestDevice")
        .and.callFake(function () {
          return Promise.resolve(candidate);
        }),
    };
    host._reconfigureCanvas.and.throwError("canvas configure failed");
    const operations = {
      delay: jasmine.createSpy("delay").and.callFake(function () {
        return Promise.resolve();
      }),
      recoverPooledDevice: jasmine.createSpy("recoverPooledDevice"),
      requestAdapter: jasmine
        .createSpy("requestAdapter")
        .and.callFake(function () {
          return Promise.resolve(candidateAdapter);
        }),
      releasePooledDevice: jasmine.createSpy("releasePooledDevice"),
    };
    const recovery = new WebGPUDeviceLossRecovery(host, 1, operations);

    await beginRecovery(recovery, source, operations);
    await flushMicrotasks();

    expect(host._rollbackRecoveredDevice).toHaveBeenCalledOnceWith(candidate);
    expect(candidate.destroy).toHaveBeenCalledTimes(1);
    expect(operations.releasePooledDevice).not.toHaveBeenCalled();
    expect(candidate.lost.then).not.toHaveBeenCalled();
    expect(host._adapter).toBe(sourceAdapter);
    expect(host._device).toBe(source.device);
    expect(host._deviceFromPool).toBeFalse();
    expect(host._isDestroyed).toBeFalse();
    expect(host._isTerminallyLost).toBeTrue();
    expect(recovery.state).toBe(DeviceLossState.FATAL);
  });

  it("does not double-release when synchronous host destruction consumes a promoted candidate", async function () {
    const source = makeSourceDevice();
    const { host } = makeHost(source.device);
    const candidate = makeCandidateDevice("destroyedPromotedCandidate");
    const candidateAdapter = { label: "candidate-adapter" };
    const operations = {
      delay: jasmine.createSpy("delay").and.callFake(function () {
        return Promise.resolve();
      }),
      recoverPooledDevice: jasmine
        .createSpy("recoverPooledDevice")
        .and.callFake(function () {
          return Promise.resolve({
            adapter: candidateAdapter,
            device: candidate,
          });
        }),
      requestAdapter: jasmine.createSpy("requestAdapter"),
      releasePooledDevice: jasmine.createSpy("releasePooledDevice"),
    };
    const recovery = new WebGPUDeviceLossRecovery(host, 1, operations);
    host._clearAllCaches.and.callFake(function () {
      // Mirrors Context.destroy() called synchronously by an invalidation
      // subscriber: dispose flips the abort bit, then the host consumes the
      // already-published pool lease and clears its references.
      void recovery.dispose();
      operations.releasePooledDevice(candidate);
      host._adapter = null;
      host._device = null;
      host._deviceFromPool = false;
      host._isTerminallyLost = false;
      host._isDestroyed = true;
    });

    await beginRecovery(recovery, source, operations);
    await flushMicrotasks();

    expect(operations.releasePooledDevice).toHaveBeenCalledOnceWith(candidate);
    expect(host._rollbackRecoveredDevice).not.toHaveBeenCalled();
    expect(candidate.destroy).not.toHaveBeenCalled();
    expect(candidate.lost.then).not.toHaveBeenCalled();
    expect(host._device).toBeNull();
    expect(recovery.state).toBe(DeviceLossState.FATAL);
  });

  it("serializes loss of a just-committed candidate behind the active recovery", async function () {
    const source = makeSourceDevice();
    const { host } = makeHost(source.device);
    const firstCandidate = {
      lost: Promise.resolve({
        reason: "unknown",
        message: "candidate lost before healthy publication",
      }),
      destroy: jasmine.createSpy("firstCandidate.destroy"),
    };
    const secondCandidate = makeCandidateDevice("secondCandidate");
    const candidates = [firstCandidate, secondCandidate];
    let acquireIndex = 0;
    const operations = {
      delay: jasmine.createSpy("delay").and.callFake(function () {
        return Promise.resolve();
      }),
      recoverPooledDevice: jasmine
        .createSpy("recoverPooledDevice")
        .and.callFake(function () {
          const device = candidates[acquireIndex++];
          return Promise.resolve({ adapter: {}, device });
        }),
      requestAdapter: jasmine.createSpy("requestAdapter"),
      releasePooledDevice: jasmine.createSpy("releasePooledDevice"),
    };
    const recovery = new WebGPUDeviceLossRecovery(host, 1, operations);
    const events = [];
    recovery.onDeviceLost(function (event) {
      events.push(event.reason);
    });

    await beginRecovery(recovery, source, operations);
    await flushMicrotasks(24);

    expect(operations.recoverPooledDevice).toHaveBeenCalledTimes(2);
    expect(host._device).toBe(secondCandidate);
    expect(recovery.state).toBe(DeviceLossState.HEALTHY);
    expect(events.filter((reason) => reason === "recovered").length).toBe(1);
    expect(operations.releasePooledDevice).not.toHaveBeenCalled();
  });

  it("finalizes terminal loss once, after recovery leaves the active slot", async function () {
    const source = makeSourceDevice();
    const { host } = makeHost(source.device, {
      deviceFromPool: false,
      useDevicePool: false,
    });
    const operations = {
      delay: jasmine.createSpy("delay").and.callFake(function () {
        return Promise.resolve();
      }),
      recoverPooledDevice: jasmine.createSpy("recoverPooledDevice"),
      requestAdapter: jasmine
        .createSpy("requestAdapter")
        .and.callFake(function () {
          return Promise.resolve(null);
        }),
      releasePooledDevice: jasmine.createSpy("releasePooledDevice"),
    };
    const drain = jasmine.createSpy("drain");
    const recovery = new WebGPUDeviceLossRecovery(host, 1, operations);
    host._finalizeTerminalLoss = jasmine
      .createSpy("host._finalizeTerminalLoss")
      .and.callFake(function () {
        // The recovery promise must no longer occupy the active slot when the
        // host enters its synchronous destroy path. This is the regression
        // guard against dispose() awaiting the very recovery that invoked it.
        expect(recovery._activeRecovery).toBeNull();
        expect(recovery.state).toBe(DeviceLossState.FATAL);
        expect(host._isTerminallyLost).toBeTrue();
        expect(host._isDestroyed).toBeFalse();
        drain();
        host._isTerminallyLost = false;
        host._isDestroyed = true;
      });
    await beginRecovery(recovery, source, operations);
    await flushMicrotasks();

    expect(recovery.state).toBe(DeviceLossState.FATAL);
    expect(host._finalizeTerminalLoss).toHaveBeenCalledTimes(1);
    expect(drain).toHaveBeenCalledTimes(1);
    expect(host._isTerminallyLost).toBeFalse();
    expect(host._isDestroyed).toBeTrue();

    // A later queued finalization check observes completed teardown and does
    // not re-enter the host hook.
    recovery._finalizeTerminalLoss();
    expect(host._finalizeTerminalLoss).toHaveBeenCalledTimes(1);
    expect(drain).toHaveBeenCalledTimes(1);
  });
});
