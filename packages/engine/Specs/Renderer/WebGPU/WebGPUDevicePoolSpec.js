import { WebGPUDevicePool } from "../../../Source/Renderer/WebGPU/WebGPUDevicePool.js";

function deferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function flushMicrotasks(count = 6) {
  for (let i = 0; i < count; i++) {
    await Promise.resolve();
  }
}

function makeGpu() {
  const loss = deferred();
  const device = {
    features: new Set(),
    limits: {},
    lost: loss.promise,
    destroy: jasmine.createSpy("device.destroy"),
  };
  const adapter = {
    features: new Set(),
    limits: {},
    requestDevice: jasmine
      .createSpy("adapter.requestDevice")
      .and.resolveTo(device),
  };
  const gpu = {
    getPreferredCanvasFormat: jasmine
      .createSpy("gpu.getPreferredCanvasFormat")
      .and.returnValue("bgra8unorm"),
    requestAdapter: jasmine
      .createSpy("gpu.requestAdapter")
      .and.resolveTo(adapter),
  };
  return { gpu, device, loss };
}

describe("Renderer/WebGPU/WebGPUDevicePool device loss reporting", function () {
  let originalGpuDescriptor;

  beforeEach(function () {
    originalGpuDescriptor = Object.getOwnPropertyDescriptor(navigator, "gpu");
    spyOn(console, "error");
  });

  afterEach(function () {
    if (originalGpuDescriptor) {
      Object.defineProperty(navigator, "gpu", originalGpuDescriptor);
    } else {
      delete navigator.gpu;
    }
  });

  function installGpu(gpu) {
    Object.defineProperty(navigator, "gpu", {
      configurable: true,
      value: gpu,
    });
  }

  it("does not report the loss produced by releasing the final lease", async function () {
    const { gpu, device, loss } = makeGpu();
    installGpu(gpu);
    const pool = new WebGPUDevicePool();
    await pool.acquireDevice({ skipAdaptiveNegotiation: true });

    pool.releaseDevice(device);
    loss.resolve({ reason: "destroyed", message: "Device was destroyed" });
    await flushMicrotasks();

    expect(device.destroy).toHaveBeenCalledTimes(1);
    expect(console.error).not.toHaveBeenCalled();
    expect(pool.activeDeviceCount).toBe(0);
  });

  it("does not report losses produced by destroyAll", async function () {
    const { gpu, device, loss } = makeGpu();
    installGpu(gpu);
    const pool = new WebGPUDevicePool();
    await pool.acquireDevice({ skipAdaptiveNegotiation: true });

    pool.destroyAll();
    loss.resolve({ reason: "destroyed", message: "Device was destroyed" });
    await flushMicrotasks();

    expect(device.destroy).toHaveBeenCalledTimes(1);
    expect(console.error).not.toHaveBeenCalled();
    expect(pool.activeDeviceCount).toBe(0);
  });

  it("reports when outside code destroys a pooled device", async function () {
    const { gpu, loss } = makeGpu();
    installGpu(gpu);
    const pool = new WebGPUDevicePool();
    await pool.acquireDevice({ skipAdaptiveNegotiation: true });

    loss.resolve({ reason: "destroyed", message: "external destroy" });
    await flushMicrotasks();

    expect(console.error).toHaveBeenCalledOnceWith(
      "[CesiumJS:WebGPUDevicePool] Device lost: destroyed — external destroy",
    );
    expect(pool.activeDeviceCount).toBe(0);
  });

  it("continues to report genuine device loss", async function () {
    const { gpu, loss } = makeGpu();
    installGpu(gpu);
    const pool = new WebGPUDevicePool();
    await pool.acquireDevice({ skipAdaptiveNegotiation: true });

    loss.resolve({ reason: "unknown", message: "driver reset" });
    await flushMicrotasks();

    expect(console.error).toHaveBeenCalledOnceWith(
      "[CesiumJS:WebGPUDevicePool] Device lost: unknown — driver reset",
    );
    expect(pool.activeDeviceCount).toBe(0);
  });
});
