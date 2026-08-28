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

const {
  destroyAtmosphereLUTResources,
  ensureAtmosphereLUTResources,
  shouldRebuildAtmosphereLUTResources,
} = await import(
  pathToFileURL(resolve(engineWebGPU, "WebGPUAtmosphereLUT.ts")).href
);
const { ensureGBufferComputeResources } = await import(
  pathToFileURL(resolve(engineWebGPU, "WebGPUGBufferRenderer.ts")).href
);
const { WebGPUPerformanceManager } = await import(
  pathToFileURL(resolve(engineWebGPU, "WebGPUPerformanceManager.ts")).href
);
const { default: WebGPUContext } = await import(
  pathToFileURL(resolve(engineWebGPU, "WebGPUContext.ts")).href
);

globalThis.GPUTextureUsage ??= Object.freeze({
  STORAGE_BINDING: 1,
  TEXTURE_BINDING: 2,
  COPY_SRC: 4,
});
globalThis.GPUBufferUsage ??= Object.freeze({
  UNIFORM: 1,
  COPY_DST: 2,
});

const atmosphereHandleNames = [
  "transmittance",
  "inscatter",
  "moonTransmittance",
  "moonInscatter",
  "multipleScatter",
  "irradiance",
  "skyView",
  "paramsBuffer",
  "moonParamsBuffer",
];

function destroyable(name, calls, throwingName) {
  return {
    destroy() {
      calls.push(name);
      if (name === throwingName) {
        throw new Error(`destroy failed: ${name}`);
      }
    },
  };
}

function atmosphereResources(device, calls = [], throwingName) {
  return {
    device,
    ...Object.fromEntries(
      atmosphereHandleNames.map((name) => [
        name,
        destroyable(name, calls, throwingName),
      ]),
    ),
  };
}

function fakeDevice(name, throwingName) {
  const created = [];
  const destroyed = [];
  const device = {
    name,
    createTexture(descriptor) {
      const texture = {
        ...destroyable(descriptor.label, destroyed, throwingName),
        createView() {
          return { texture };
        },
      };
      created.push(texture);
      return texture;
    },
    createBuffer(descriptor) {
      const buffer = destroyable(descriptor.label, destroyed, throwingName);
      created.push(buffer);
      return buffer;
    },
  };
  return { device, created, destroyed };
}

test("device identity decides LUT reuse and the runtime path rebuilds stale resources", () => {
  const liveDevice = {};
  const otherDevice = {};
  assert.equal(shouldRebuildAtmosphereLUTResources(null, liveDevice), true);
  assert.equal(
    shouldRebuildAtmosphereLUTResources({ device: liveDevice }, liveDevice),
    false,
  );
  assert.equal(
    shouldRebuildAtmosphereLUTResources({ device: otherDevice }, liveDevice),
    true,
  );

  const first = fakeDevice("first");
  const second = fakeDevice("second");
  const host = {
    _atmosphereLutResources: null,
    _context: { supportsComputeShaders: true },
    dispatchCompute() {},
  };

  ensureAtmosphereLUTResources(host, first.device);
  const firstResources = host._atmosphereLutResources;
  assert.equal(first.created.length, 9);
  assert.equal(firstResources.device, first.device);

  ensureAtmosphereLUTResources(host, first.device);
  assert.equal(host._atmosphereLutResources, firstResources);
  assert.equal(first.created.length, 9);

  ensureAtmosphereLUTResources(host, second.device);
  assert.equal(host._atmosphereLutResources.device, second.device);
  assert.equal(second.created.length, 9);
  assert.equal(first.destroyed.length, 9);
});

test("G-buffer resources are reused only by their creating device", () => {
  const first = fakeDevice("first", "GBufferCompute_Uniforms");
  const second = fakeDevice("second");
  const host = {
    _gbufferComputeResources: null,
    _context: { supportsComputeShaders: true },
  };

  const firstResources = ensureGBufferComputeResources(host, first.device);
  assert.equal(firstResources.device, first.device);
  assert.equal(first.created.length, 1);

  assert.equal(
    ensureGBufferComputeResources(host, first.device),
    firstResources,
  );
  assert.equal(first.created.length, 1);

  const secondResources = ensureGBufferComputeResources(host, second.device);
  assert.equal(secondResources.device, second.device);
  assert.equal(host._gbufferComputeResources, secondResources);
  assert.equal(second.created.length, 1);
  assert.equal(first.destroyed.length, 1);
});

test("performance-manager teardown releases every owned GPU resource", () => {
  const calls = [];
  const manager = new WebGPUPerformanceManager({
    supportsComputeShaders: false,
  });
  manager._atmosphereLutResources = atmosphereResources({}, calls);
  manager._gbufferComputeResources = {
    uniformsBuffer: destroyable("uniformsBuffer", calls),
  };

  manager.destroy();

  assert.deepEqual(
    new Set(calls),
    new Set([...atmosphereHandleNames, "uniformsBuffer"]),
  );
  assert.equal(calls.length, 10);
  assert.equal(manager._atmosphereLutResources, null);
  assert.equal(manager._gbufferComputeResources, null);
});

test("performance-manager teardown continues after one destroy throws", () => {
  const calls = [];
  const manager = new WebGPUPerformanceManager({
    supportsComputeShaders: false,
  });
  manager._atmosphereLutResources = atmosphereResources({}, calls);
  manager._gbufferComputeResources = {
    uniformsBuffer: destroyable("uniformsBuffer", calls, "uniformsBuffer"),
  };

  assert.doesNotThrow(() => manager.destroy());
  assert.deepEqual(
    new Set(calls),
    new Set([...atmosphereHandleNames, "uniformsBuffer"]),
  );
  assert.equal(calls.length, 10);
  assert.equal(manager._atmosphereLutResources, null);
  assert.equal(manager._gbufferComputeResources, null);
});

test("device-loss replacement carries the complete manager configuration", () => {
  const entries = [];
  const calls = [];
  const manager = new WebGPUPerformanceManager({
    supportsComputeShaders: false,
  });
  const expectedConfig = {
    renderBundles: false,
    indirectDraw: false,
    gpuCulling: false,
    timestampProfiling: true,
    bufferMapping: false,
    atmosphereLUT: false,
    gpuPointCloud: false,
    gpuSortKeys: false,
    renderBundleThreshold: 17,
    indirectDrawThreshold: 23,
    gpuCullingThreshold: 1234,
    gpuSortKeysThreshold: 2345,
    gpuPointCloudThreshold: 3456,
    bundleMaxIdleFrames: 41,
  };
  manager.config = expectedConfig;
  manager._atmosphereLutResources = atmosphereResources({}, calls);
  manager._gbufferComputeResources = {
    uniformsBuffer: destroyable("uniformsBuffer", calls),
  };
  manager._staticTileBundleKeys.add("stale-bundle");
  manager._computePipelines.set(1, {});
  manager._pointCloudLODPreparedSource = "old-device-source";
  manager._pointCloudLODUseSubgroups = true;
  manager._atmosphereLUTDirty = false;
  manager._moonAtmosphereLUTDirty = false;
  manager._profilerActive = true;
  manager._frameActive = true;
  const registry = {
    register(name, clear) {
      entries.push({ name, clear });
      return this;
    },
  };
  const host = {
    _cacheRegistry: registry,
    _performanceManager: manager,
    _performanceManagerConfig: null,
  };

  WebGPUContext.prototype._registerResourceCaches.call(host);
  const entry = entries.find(({ name }) => name === "performanceManager");
  assert.ok(entry);

  entry.clear();
  const detachedManager = host._performanceManager;
  const performanceManagerGetter = Object.getOwnPropertyDescriptor(
    WebGPUContext.prototype,
    "performanceManager",
  ).get;
  const replacement = performanceManagerGetter.call(host);
  assert.deepEqual(
    {
      detachedManager,
      replaced: replacement !== manager,
      installed: host._performanceManager === replacement,
      carriedConfig: replacement.config,
      pendingConfig: host._performanceManagerConfig,
      destroyedHandles: calls.slice().sort(),
      oldAtmosphereResources: manager._atmosphereLutResources,
      oldGbufferResources: manager._gbufferComputeResources,
      oldStaticBundleKeys: manager._staticTileBundleKeys.size,
      oldComputePipelines: manager._computePipelines.size,
      replacementPointCloudSource: replacement._pointCloudLODPreparedSource,
      replacementPointCloudUsesSubgroups:
        replacement._pointCloudLODUseSubgroups,
      replacementAtmosphereDirty: replacement._atmosphereLUTDirty,
      replacementMoonAtmosphereDirty: replacement._moonAtmosphereLUTDirty,
      replacementProfilerActive: replacement._profilerActive,
      replacementFrameActive: replacement._frameActive,
    },
    {
      detachedManager: null,
      replaced: true,
      installed: true,
      carriedConfig: expectedConfig,
      pendingConfig: null,
      destroyedHandles: [...atmosphereHandleNames, "uniformsBuffer"].sort(),
      oldAtmosphereResources: null,
      oldGbufferResources: null,
      oldStaticBundleKeys: 0,
      oldComputePipelines: 0,
      replacementPointCloudSource: null,
      replacementPointCloudUsesSubgroups: false,
      replacementAtmosphereDirty: true,
      replacementMoonAtmosphereDirty: true,
      replacementProfilerActive: false,
      replacementFrameActive: false,
    },
  );
});

test("normal context teardown destroys and detaches the performance manager", () => {
  const noop = () => {};
  const clearable = { clear: noop };
  const resettable = { reset: noop };
  const manager = {
    destroyCalls: 0,
    destroy() {
      this.destroyCalls += 1;
    },
  };
  const host = {
    _isDestroyed: false,
    _pendingTextureMipJobs: [],
    _drainAfterCommandEncoderSubmitCallbacks: noop,
    _drainAfterFrameSubmitCallbacks: noop,
    _unregisterFromRegistry: noop,
    _destroyFeatureRenderers: noop,
    _performanceManager: manager,
    _gpuCullerByFrustum: new Map(),
    _gpuCullerByFrustumInitializing: new Set(),
    _gpuCullerByCascade: new Map(),
    _gpuCullerByCascadeInitializing: new Set(),
    _detachPointCloudLOD: () => null,
    _pendingTextureDestroys: [],
    _environmentDemandRegistry: resettable,
    _environmentRefreshCoordinator: resettable,
    _environmentRefreshScheduler: resettable,
    _shaderCache: { destroy: noop },
    _textureCache: {},
    clearAllHDRFallbackListeners: noop,
    _bufferPool: clearable,
    _samplerCache: clearable,
    _bindGroupLayoutCache: clearable,
    _bindGroupCache: clearable,
    _deviceInvalidationBus: clearable,
    _cacheRegistry: clearable,
    _featureFlags: clearable,
    _gl: {
      destroyCompatibilityTextureHandles: noop,
      destroyCompatibilityBufferHandles: noop,
    },
  };

  WebGPUContext.prototype.destroy.call(host);

  assert.deepEqual(
    {
      destroyCalls: manager.destroyCalls,
      performanceManager: host._performanceManager,
      isDestroyed: host._isDestroyed,
    },
    {
      destroyCalls: 1,
      performanceManager: null,
      isDestroyed: true,
    },
  );
});

test("the standalone LUT destroy helper remains per-handle throw tolerant", () => {
  const calls = [];
  assert.doesNotThrow(() =>
    destroyAtmosphereLUTResources(
      atmosphereResources({}, calls, "transmittance"),
    ),
  );
  assert.equal(calls.length, 9);
});
