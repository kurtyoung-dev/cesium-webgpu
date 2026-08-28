/**
 * @purpose Guards the device-loss recovery seams landed with the invalidation-bus predicate: the allocation-epoch resets and the dispatcher device-identity guards that stop consumers reusing work recorded against a dead device.
 * @status ACTIVE
 *
 * Device-identity gating across the subsystems that survive a device-loss
 * recovery.
 *
 * A recovery replaces the GPUDevice but reuses the objects caches hang from:
 * the Context, the SceneRenderer, Scene-side objects, and the module-level
 * WeakMaps keyed on any of them. A presence-only guard (`if (cached)`) stays
 * satisfied across that boundary, so the subsystem keeps binding handles that
 * belong to the device that was lost. These tests drive the real guards and
 * assert the observable consequence: after the device changes, the subsystem
 * must allocate against the new device and release what it held on the old one.
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

globalThis.GPUTextureUsage ??= Object.freeze({
  STORAGE_BINDING: 1,
  TEXTURE_BINDING: 2,
  COPY_SRC: 4,
  COPY_DST: 8,
  RENDER_ATTACHMENT: 16,
});
globalThis.GPUBufferUsage ??= Object.freeze({
  UNIFORM: 1,
  COPY_DST: 2,
  COPY_SRC: 4,
  STORAGE: 8,
  INDIRECT: 16,
  MAP_READ: 32,
});
globalThis.GPUShaderStage ??= Object.freeze({
  VERTEX: 1,
  FRAGMENT: 2,
  COMPUTE: 4,
});

const { shouldRebuildForDevice } = await import(
  pathToFileURL(resolve(engineWebGPU, "WebGPUDeviceInvalidationBus.ts")).href
);
const { ensureResources } = await import(
  pathToFileURL(resolve(engineWebGPU, "WebGPUSceneRendererEnsureResources.ts"))
    .href
);
const hiZModule = await import(
  pathToFileURL(resolve(engineWebGPU, "WebGPUHiZOcclusionDispatcher.ts")).href
);
const sortKeysModule = await import(
  pathToFileURL(resolve(engineWebGPU, "WebGPUGPUSortKeysDispatcher.ts")).href
);

/**
 * A GPUDevice stand-in whose every factory returns a labelled stub. Each
 * returned object carries `ownerDevice` so a test can prove which device a
 * resource was built on rather than trusting a call count alone.
 */
function fakeDevice(name) {
  const created = [];
  const device = {
    name,
    features: new Set(),
    limits: {},
    lost: new Promise(() => {}),
  };
  const make = (kind) => (descriptor) => {
    const object = {
      kind,
      ownerDevice: device,
      label: descriptor?.label,
      destroy() {},
      getMappedRange: () => new ArrayBuffer(8),
      unmap() {},
      mapAsync: () => Promise.resolve(),
      createView: () => ({ kind: `${kind}View`, ownerDevice: device }),
      getBindGroupLayout: () => ({
        kind: "bindGroupLayout",
        ownerDevice: device,
      }),
    };
    created.push(object);
    return object;
  };
  device.createBuffer = make("buffer");
  device.createTexture = make("texture");
  device.createSampler = make("sampler");
  device.createShaderModule = make("shaderModule");
  device.createBindGroupLayout = make("bindGroupLayout");
  device.createPipelineLayout = make("pipelineLayout");
  device.createComputePipeline = make("computePipeline");
  device.createRenderPipeline = make("renderPipeline");
  device.createBindGroup = make("bindGroup");
  device.createCommandEncoder = make("commandEncoder");
  device.queue = {
    writeBuffer() {},
    submit() {},
    onSubmittedWorkDone: () => Promise.resolve(),
  };
  device.pushErrorScope = () => {};
  device.popErrorScope = () => Promise.resolve(null);
  return { device, created };
}

test("the predicate rebuilds on a null cache and on a foreign device only", () => {
  const live = { name: "live" };
  const dead = { name: "dead" };
  assert.equal(shouldRebuildForDevice(null, live), true);
  assert.equal(shouldRebuildForDevice(undefined, live), true);
  assert.equal(shouldRebuildForDevice({ device: live }, live), false);
  assert.equal(shouldRebuildForDevice({ device: dead }, live), true);
});

/**
 * Captures the callback `ensureResources` hands to `onDeviceInvalidated`.
 * Only the registration matters here, and it happens before any framebuffer is
 * touched, so a later throw from the allocation body is caught and ignored.
 */
function captureInvalidationCallback(host) {
  let captured = null;
  const context = {
    _device: { name: "device" },
    _canvas: { width: 8, height: 8 },
    _msaaSamples: 1,
    presentationFormat: "bgra8unorm",
    onDeviceInvalidated(callback) {
      captured = callback;
      return () => {};
    },
  };
  try {
    ensureResources(host, {
      context,
      scene: {},
      useHDR: false,
    });
  } catch {
    // The allocation body needs a real device; registration already happened.
  }
  assert.ok(
    typeof captured === "function",
    "ensureResources must register a device-invalidation callback",
  );
  return captured;
}

function allocatedHost(dispatcher) {
  return {
    _sceneFramebuffer: {},
    _edgeFramebuffer: {},
    _translucentTileClassification: {},
    _oit: {},
    _webgpuOITEnabled: false,
    _lastOITRequested: false,
    _globeDepth: {},
    _depthPlane: {},
    _postProcess: {},
    _debugDepthOverlay: {},
    _debugFrustumOverlay: {},
    _initialized: true,
    _width: 8,
    _height: 8,
    _lastHDR: false,
    _deviceInvalidationUnsub: null,
    _hiZAllocated: true,
    _hiZAllocatedFor: { width: 1920, height: 1080, capacity: 4096 },
    _sortKeysAllocatedFor: 4096,
    _clusteredLightingDispatcher: dispatcher,
  };
}

test("device invalidation returns the allocation epochs to their pre-allocation values", () => {
  const host = allocatedHost(null);
  const callback = captureInvalidationCallback(host);

  callback();

  // The epochs are what the reallocation guards read. Leaving any of them set
  // makes the guard report the dead device's allocation as current and skips
  // the rebuild the replacement device needs.
  assert.equal(host._hiZAllocated, false);
  assert.deepEqual(host._hiZAllocatedFor, {
    width: 0,
    height: 0,
    capacity: 0,
  });
  assert.equal(host._sortKeysAllocatedFor, 0);

  // The pre-existing resource drops must survive alongside the new resets.
  assert.equal(host._sceneFramebuffer, null);
  assert.equal(host._oit, null);
  assert.equal(host._globeDepth, null);
  assert.equal(host._postProcess, null);
  assert.equal(host._debugFrustumOverlay, null);
  assert.equal(host._initialized, false);
});

test("device invalidation destroys and releases the clustered-lighting dispatcher", () => {
  const destroyed = [];
  const host = allocatedHost({
    destroy() {
      destroyed.push("clustered");
    },
  });

  captureInvalidationCallback(host)();

  assert.deepEqual(destroyed, ["clustered"]);
  assert.equal(host._clusteredLightingDispatcher, null);
});

test("a throwing clustered-lighting teardown still releases the reference", () => {
  const host = allocatedHost({
    destroy() {
      throw new Error("device lost");
    },
  });

  // A lost device can reject native teardown. If that exception escaped, the
  // field would keep the dead dispatcher and no replacement would ever build.
  assert.doesNotThrow(() => captureInvalidationCallback(host)());
  assert.equal(host._clusteredLightingDispatcher, null);
});

/**
 * Drives one of the two context-keyed dispatcher factories through its
 * exported feature-renderer entry point, which is the only caller path that
 * reaches `getOrCreateDispatcher`.
 */
function exerciseDispatcherCache({ init, destroySpyTarget, run }) {
  const destroyCalls = [];
  const originalDestroy = destroySpyTarget.prototype.destroy;
  destroySpyTarget.prototype.destroy = function patchedDestroy(...args) {
    destroyCalls.push(this);
    return originalDestroy.apply(this, args);
  };
  try {
    return run({ init, destroyCalls });
  } finally {
    destroySpyTarget.prototype.destroy = originalDestroy;
  }
}

/**
 * Shared body for the two context-keyed dispatcher caches. `allocate()` opens
 * with a self-`destroy()`, so destroy calls are counted by the instance they
 * ran on rather than in total — churn is a destroy on a NEW instance, and a
 * recovery is a destroy on the instance the first device built.
 */
function assertDispatcherCacheFollowsDevice({ init, klass, allocate }) {
  const first = fakeDevice("first");
  const second = fakeDevice("second");
  const context = {
    device: first.device,
    webgpuComputePipelineCache: null,
  };

  exerciseDispatcherCache({
    init,
    destroySpyTarget: klass,
    run({ destroyCalls }) {
      allocate(context);
      assert.ok(
        first.created.length > 0,
        "the first init must allocate on the first device",
      );
      assert.equal(
        second.created.length,
        0,
        "nothing may be allocated on a device the cache has not been given",
      );
      const original = destroyCalls[0];
      assert.ok(original, "allocate() opens with a self-destroy");

      // Steady state: same context, same device. Seeing a second instance here
      // would mean the identity check churns the cache on every frame.
      allocate(context);
      assert.equal(
        new Set(destroyCalls).size,
        1,
        "an unchanged device must keep the same dispatcher instance",
      );
      const beforeSwap = destroyCalls.length;

      // Recovery: the same context object comes back with a new device.
      context.device = second.device;
      allocate(context);

      assert.ok(
        destroyCalls.slice(beforeSwap).includes(original),
        "the dispatcher built on the dead device must be destroyed",
      );
      assert.ok(
        second.created.length > 0,
        "the replacement device must receive its own allocations",
      );
      for (const object of second.created) {
        assert.equal(object.ownerDevice, second.device);
      }
    },
  });
}

test("the Hi-Z dispatcher cache follows the device across a recovery", () => {
  assertDispatcherCacheFollowsDevice({
    init: hiZModule.initWebGPUHiZOcclusion,
    klass: hiZModule.WebGPUHiZOcclusionDispatcher,
    allocate: (context) =>
      hiZModule.initWebGPUHiZOcclusion(context, 64, 64, 128),
  });
});

test("the sort-keys dispatcher cache follows the device across a recovery", () => {
  assertDispatcherCacheFollowsDevice({
    init: sortKeysModule.initWebGPUGPUSortKeys,
    klass: sortKeysModule.WebGPUGPUSortKeysDispatcher,
    allocate: (context) => sortKeysModule.initWebGPUGPUSortKeys(context, 128),
  });
});
