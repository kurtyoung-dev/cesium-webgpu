/**
 * @purpose Guards the synchronous device-liveness registry and the producers that consult it, so a lost GPUDevice stops receiving work when its lost promise settles rather than when a replacement is published.
 * @status ACTIVE
 *
 * WebGPU publishes device loss only as a promise, and a recovery leaves the
 * lost handle in place while it runs. Between those two facts the engine had
 * no way to ask, synchronously, whether the device it was about to record
 * against was still alive - so every frame of the recovery window allocated,
 * recorded and submitted against a dead handle, and every pipeline request
 * went to it and rejected.
 *
 * These tests drive the real loss-recovery manager, the real device pool and
 * the real render-pipeline cache through the sequencing a genuine GPU-process
 * termination produces - the lost promise settling while frames are still in
 * flight - and assert the observable consequence: zero operations reach the
 * lost device, and the replacement device is unaffected.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import { registerHooks } from "node:module";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import ts from "typescript";

import { enableEngineTsResolution } from "./lib/engine-ts-resolver.mjs";

const directory = dirname(fileURLToPath(import.meta.url));
const engineWebGPU = resolve(
  directory,
  "../../packages/engine/Source/Renderer/WebGPU",
);

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (
      (specifier.startsWith("./") || specifier.startsWith("../")) &&
      specifier.endsWith(".js") &&
      typeof context.parentURL === "string" &&
      context.parentURL.startsWith("file:")
    ) {
      const asJs = new URL(specifier, context.parentURL);
      if (
        asJs.pathname.includes("/packages/engine/Source/Shaders/") &&
        !fs.existsSync(fileURLToPath(asJs))
      ) {
        return {
          url: "data:text/javascript,export default%20%22%22%3B",
          shortCircuit: true,
        };
      }
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url.endsWith(".ts")) {
      const source = fs.readFileSync(fileURLToPath(url), "utf8");
      return {
        format: "module",
        source: ts.transpileModule(source, {
          compilerOptions: {
            module: ts.ModuleKind.ESNext,
            target: ts.ScriptTarget.ES2022,
            verbatimModuleSyntax: false,
          },
        }).outputText,
        shortCircuit: true,
      };
    }
    return nextLoad(url, context);
  },
});

enableEngineTsResolution();

globalThis.navigator ??= {};
globalThis.navigator.gpu ??= {
  getPreferredCanvasFormat: () => "bgra8unorm",
};

const {
  DEVICE_SUSPECT_WINDOW_MS,
  clearDeviceSuspect,
  isDeviceFailureSignal,
  isDeviceLost,
  isDeviceSuspect,
  markDeviceLost,
  markDeviceSuspect,
} = await import(
  pathToFileURL(resolve(engineWebGPU, "WebGPUDeviceInvalidationBus.ts")).href
);
const { WebGPUDeviceLossRecovery, DeviceLossState } = await import(
  pathToFileURL(resolve(engineWebGPU, "WebGPUDeviceLossRecovery.ts")).href
);
const { WebGPURenderPipelineCache } = await import(
  pathToFileURL(resolve(engineWebGPU, "WebGPURenderPipelineCache.ts")).href
);
const { WebGPUDevicePool } = await import(
  pathToFileURL(resolve(engineWebGPU, "WebGPUDevicePool.ts")).href
);

/**
 * A GPUDevice stand-in whose `lost` promise the test settles by hand, which is
 * the only way to reproduce the ordering a real loss produces: the promise
 * resolves in a microtask while the frame loop is still running. Creation
 * calls are counted on the device itself so a test proves which device the
 * work reached rather than trusting a total.
 */
function fakeDevice(name) {
  let settle;
  const device = {
    name,
    features: new Set(),
    limits: {},
    renderPipelineCalls: 0,
    computePipelineCalls: 0,
  };
  device.lost = new Promise((r) => {
    settle = r;
  });
  device.createShaderModule = () => ({ kind: "shaderModule", device });
  device.createRenderPipelineAsync = async () => {
    device.renderPipelineCalls++;
    return { kind: "renderPipeline", device };
  };
  device.createRenderPipeline = () => {
    device.renderPipelineCalls++;
    return { kind: "renderPipeline", device };
  };
  device.createComputePipelineAsync = async () => {
    device.computePipelineCalls++;
    return { kind: "computePipeline", device };
  };
  device.destroy = () => {};
  device.queue = { submit() {}, writeBuffer() {} };
  return {
    device,
    lose: (reason = "unknown", message = "Device lost") =>
      settle({ reason, message }),
  };
}

function pipelineDescriptor(name, device) {
  const module = device.createShaderModule();
  return {
    name,
    layout: "auto",
    vertex: { module, entryPoint: "vs" },
    fragment: { module, entryPoint: "fs", targets: [{ format: "bgra8unorm" }] },
  };
}

/** Lets pending microtasks - the lost handler, the recovery chain - run. */
async function settleMicrotasks(rounds = 8) {
  for (let i = 0; i < rounds; i++) {
    await Promise.resolve();
  }
}

// -- The registry itself ---------------------------------------------------

test("liveness is per device and a replacement is never implicated", () => {
  const dead = fakeDevice("dead").device;
  const live = fakeDevice("live").device;
  assert.equal(isDeviceLost(dead), false);
  markDeviceLost(dead);
  assert.equal(isDeviceLost(dead), true);
  assert.equal(isDeviceLost(live), false);
  assert.equal(isDeviceLost(null), false);
  assert.equal(isDeviceLost(undefined), false);
});

test("suspicion expires on its own and any success withdraws it", () => {
  const device = fakeDevice("suspect").device;
  const t0 = 1_000_000;
  assert.equal(isDeviceSuspect(device, t0), false);
  markDeviceSuspect(device, t0);
  assert.equal(isDeviceSuspect(device, t0), true);
  assert.equal(
    isDeviceSuspect(device, t0 + DEVICE_SUSPECT_WINDOW_MS - 1),
    true,
    "suspicion must hold for the whole window",
  );
  assert.equal(
    isDeviceSuspect(device, t0 + DEVICE_SUSPECT_WINDOW_MS),
    false,
    "a one-off failure must not wedge a device that is still healthy",
  );

  markDeviceSuspect(device, t0);
  clearDeviceSuspect(device);
  assert.equal(isDeviceSuspect(device, t0), false);
});

test("a lost device is not downgraded to merely suspect", () => {
  const device = fakeDevice("lost-then-suspect").device;
  markDeviceLost(device);
  markDeviceSuspect(device, 5000);
  assert.equal(isDeviceSuspect(device, 5000), false);
  assert.equal(isDeviceLost(device), true);
});

test("a validation rejection is about the work, anything else about the device", () => {
  assert.equal(isDeviceFailureSignal({ reason: "validation" }), false);
  assert.equal(isDeviceFailureSignal({ reason: "internal" }), true);
  assert.equal(
    isDeviceFailureSignal(new Error("Instance reference no longer exists")),
    true,
  );
  assert.equal(isDeviceFailureSignal(undefined), true);
});

// -- The real recovery manager, driven through a real loss -----------------

/**
 * Builds a host matching `DeviceLossRecoveryHost` whose hooks record their
 * order, plus the injected async seams the manager already takes for
 * deterministic tests. The device handles are the fakes above so the pipeline
 * cache below can be pointed at the same objects the manager is holding.
 */
function recoveryFixture(first, replacement) {
  const calls = [];
  const host = {
    _adapter: { name: "adapter1" },
    _device: first,
    _deviceFromPool: false,
    _isDestroyed: false,
    _isTerminallyLost: false,
    _options: {},
    _context: {},
    _setAdapter(a) {
      host._adapter = a;
    },
    _setDevice(d) {
      calls.push(`setDevice:${d?.name}`);
      host._device = d;
    },
    _initializeContextLimits() {
      calls.push("limits");
    },
    _reconfigureCanvas() {
      calls.push("canvas");
    },
    _initializeDefaultTextures() {
      calls.push("textures");
    },
    _clearAllCaches() {
      calls.push("clearCaches");
    },
    _rollbackRecoveredDevice() {},
    _finalizeTerminalLoss() {
      calls.push("finalizeTerminal");
    },
  };
  const operations = {
    delay: () => Promise.resolve(),
    recoverPooledDevice: async () => ({
      adapter: { name: "adapter2" },
      device: replacement,
    }),
    requestAdapter: async () => ({
      requestDevice: async () => replacement,
    }),
    releasePooledDevice: () => {},
  };
  return { host, calls, operations };
}

test("the lost handler publishes the loss before recovery can replace the device", async () => {
  const first = fakeDevice("dev1");
  const second = fakeDevice("dev2");
  const { host, operations } = recoveryFixture(first.device, second.device);
  const recovery = new WebGPUDeviceLossRecovery(host, 3, operations);
  recovery.setupHandler(first.device);

  assert.equal(isDeviceLost(first.device), false, "healthy before the loss");

  first.lose("unknown", "A valid external Instance reference no longer exists");
  await settleMicrotasks(2);

  assert.equal(
    isDeviceLost(first.device),
    true,
    "the loss must be published in the same task as the lost handler, not after recovery completes",
  );
  assert.equal(host._device, first.device, "recovery has not replaced it yet");
  assert.equal(recovery.state, DeviceLossState.RECOVERING);

  await settleMicrotasks(40);
  assert.equal(
    host._device,
    second.device,
    "recovery published the replacement",
  );
  assert.equal(
    isDeviceLost(second.device),
    false,
    "the replacement must not inherit the predecessor's verdict",
  );
});

test("frames in flight during the recovery window reach the dead device zero times", async () => {
  const first = fakeDevice("inflight-dev1");
  const second = fakeDevice("inflight-dev2");
  const { host, operations } = recoveryFixture(first.device, second.device);
  const recovery = new WebGPUDeviceLossRecovery(host, 3, operations);
  recovery.setupHandler(first.device);

  // The pipeline cache a context hands producers. It is built against the
  // first device and, like the real one, is not replaced until recovery
  // reaches the cache-clearing hook.
  const cache = new WebGPURenderPipelineCache(first.device, "ctx-test");

  // One frame before the loss, so the fixture is proven able to create at all.
  await cache.getPipeline(
    pipelineDescriptor("Globe terrain (pre-loss)", first.device),
  );
  const createdBeforeLoss = first.device.renderPipelineCalls;
  assert.equal(createdBeforeLoss, 1);

  first.lose("unknown", "A valid external Instance reference no longer exists");
  await settleMicrotasks(2);

  // The frame loop does not stop when the device dies. Each tick asks for a
  // variant it has not seen, which is what a moving camera does.
  let rejections = 0;
  for (let frame = 0; frame < 24; frame++) {
    try {
      await cache.getPipeline(
        pipelineDescriptor(`Globe terrain (frame ${frame})`, first.device),
      );
    } catch {
      rejections++;
    }
  }

  assert.equal(
    first.device.renderPipelineCalls,
    createdBeforeLoss,
    "no pipeline creation may reach the device after its loss is published",
  );
  assert.equal(
    rejections,
    24,
    "each request is declined, not silently dropped",
  );

  await settleMicrotasks(40);
  assert.equal(host._device, second.device);

  // The replacement gets its own cache, exactly as the context's lazy getter
  // rebuilds one, and it creates normally.
  const recovered = new WebGPURenderPipelineCache(second.device, "ctx-test");
  await recovered.getPipeline(
    pipelineDescriptor("Globe terrain (post-recovery)", second.device),
  );
  assert.equal(
    second.device.renderPipelineCalls,
    1,
    "the replacement device must render again",
  );
});

test("a terminal loss publishes the verdict too, where no recovery follows", async () => {
  const only = fakeDevice("terminal");
  const { host, operations } = recoveryFixture(only.device, only.device);
  const recovery = new WebGPUDeviceLossRecovery(host, 3, operations);
  recovery.setupHandler(only.device);

  only.lose("destroyed", "Device was destroyed");
  await settleMicrotasks(6);

  assert.equal(isDeviceLost(only.device), true);
  assert.equal(recovery.state, DeviceLossState.FATAL);
  assert.equal(host._isTerminallyLost, true);
});

test("a device lost through the pool alone is published without a recovering context", async () => {
  const pooled = fakeDevice("pooled");
  const pool = new WebGPUDevicePool();
  const adapter = {
    features: new Set(),
    limits: {},
    requestDevice: async () => pooled.device,
  };
  await pool.acquireDevice({ prefetchedAdapter: Promise.resolve(adapter) });

  assert.equal(isDeviceLost(pooled.device), false);
  pooled.lose("unknown", "GPU process terminated");
  await settleMicrotasks(4);
  assert.equal(
    isDeviceLost(pooled.device),
    true,
    "the pool's own lost handler must publish liveness for devices it shares",
  );
});
