/**
 * @purpose Guards the sky, fog and cloud consumers of the shared device-identity predicate so presence-only cache admission cannot survive a device recovery.
 * @status ACTIVE
 *
 * Device-identity gating for the three atmosphere-LUT consumers.
 *
 * Each of these caches hangs off an object that outlives a device-loss
 * recovery — the Context for procedural clouds, a context-keyed WeakMap for
 * volumetric fog, the Scene-side SkyAtmosphere for the sky pass. A
 * presence-only guard therefore survives the recovery and keeps binding
 * handles built on the device that was lost. These tests drive the real guards
 * and assert the consequence a caller can see: after the device changes, the
 * consumer must hand back different resources, and must not churn while the
 * device is unchanged.
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

const cloudModule = await import(
  pathToFileURL(resolve(engineWebGPU, "WebGPUProceduralCloudRenderer.ts")).href
);
const fogModule = await import(
  pathToFileURL(resolve(engineWebGPU, "WebGPUVolumetricFogRenderer.ts")).href
);
const skyModule = await import(
  pathToFileURL(resolve(engineWebGPU, "WebGPUSkyAtmosphereRenderer.js")).href
);

/**
 * A GPUDevice stand-in whose every factory returns a labelled stub carrying
 * `ownerDevice`, so a test can prove which device a resource was built on
 * rather than trusting a call count.
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
  device.queue = { writeBuffer() {}, submit() {} };
  return { device, created };
}

// ── Procedural clouds: the cache hangs off the Context ──────────────────────

test("the cloud cache is replaced when the context comes back on a new device", () => {
  const first = fakeDevice("first");
  const second = fakeDevice("second");
  const context = { device: first.device };

  const original = cloudModule.ensureCloudCache(context);
  assert.equal(original.device, first.device);

  // Steady state: an unchanged device must not churn the cache, which owns the
  // pipelines and the uniform buffer for the whole cloud pass.
  assert.equal(cloudModule.ensureCloudCache(context), original);

  context.device = second.device;
  const rebuilt = cloudModule.ensureCloudCache(context);

  assert.notEqual(
    rebuilt,
    original,
    "a recovered device must not inherit the dead device's cloud cache",
  );
  assert.equal(rebuilt.device, second.device);
  assert.equal(rebuilt.initialized, false);
  assert.equal(rebuilt.pipeline, null);
});

test("a cloud cache created before a device exists adopts one rather than being discarded", () => {
  const later = fakeDevice("later");
  const context = { device: undefined };

  // Consumers stash flags on the cache before the first cloud frame, so it can
  // legitimately predate the device. That must not read as a stale device.
  const early = cloudModule.ensureCloudCache(context);
  early.maskCaptureEnabled = true;
  assert.equal(early.device, null);

  context.device = later.device;
  const adopted = cloudModule.ensureCloudCache(context);

  assert.equal(adopted, early, "adopting a device must not discard the cache");
  assert.equal(adopted.device, later.device);
  assert.equal(adopted.maskCaptureEnabled, true);

  // And once adopted, a further device change does replace it.
  const third = fakeDevice("third");
  context.device = third.device;
  assert.notEqual(cloudModule.ensureCloudCache(context), early);
});

// ── Volumetric fog: a context-keyed WeakMap of renderers ────────────────────

/**
 * Drives the exported per-frame entry point, which resolves the cached
 * renderer before `update()` runs. Fog is left disabled so `update()` takes its
 * early return and the test exercises the cache resolution alone.
 */
function updateFog(context) {
  fogModule.updateWebGPUVolumetricFog(
    context,
    { atmosphericConditions: undefined },
    {},
  );
}

test("the fog renderer cache follows the device across a recovery", () => {
  const first = fakeDevice("first");
  const second = fakeDevice("second");
  const context = { device: first.device };

  updateFog(context);

  // The WeakMap is module-private, so identity is observed through the
  // renderer's own destroy: a replacement must tear the previous one down.
  const destroyed = [];
  const proto = fogModule.WebGPUVolumetricFogRenderer.prototype;
  const originalDestroy = proto.destroy;
  proto.destroy = function patchedDestroy(...args) {
    destroyed.push(this);
    return originalDestroy.apply(this, args);
  };
  try {
    // Steady state: same context, same device — nothing may be destroyed.
    updateFog(context);
    assert.equal(
      destroyed.length,
      0,
      "an unchanged device must keep the same fog renderer",
    );

    context.device = second.device;
    updateFog(context);

    assert.equal(
      destroyed.length,
      1,
      "the renderer built on the dead device must be destroyed",
    );
    assert.equal(
      destroyed[0].device,
      first.device,
      "the destroyed renderer must be the one holding the dead device",
    );

    // The replacement must be bound to the live device, and must itself be
    // stable while that device stands.
    updateFog(context);
    assert.equal(destroyed.length, 1);
  } finally {
    proto.destroy = originalDestroy;
  }
});

// ── Sky atmosphere: the cache hangs off the Scene-side object ───────────────

/**
 * Drives the exported sky update far enough to pass the device-identity guard.
 * Everything past the guard needs a real device, so the resulting throw is
 * swallowed — the guard's effect on the cache is what is under test, and it
 * runs first.
 */
function updateSky(skyAtmosphere, device) {
  try {
    skyModule.updateWebGPUSkyAtmosphere(skyAtmosphere, {
      context: {
        device,
        presentationFormat: "bgra8unorm",
        depthFormat: "depth24plus-stencil8",
        scenePipelineFormat: "bgra8unorm",
        _msaaSamples: 1,
        _scenePipelineFormatGeneration: 0,
        supportsComputeShaders: false,
        performanceManager: null,
      },
      mode: 3,
      passes: { render: true },
    });
  } catch {
    // The pipeline build past the guard needs a real device.
  }
}

test("the sky cache is replaced when the device changes underneath it", () => {
  const first = fakeDevice("first");
  const second = fakeDevice("second");
  const skyAtmosphere = { show: true };

  updateSky(skyAtmosphere, first.device);
  const original = skyAtmosphere._webgpuCache;
  assert.ok(original, "the first update must populate the cache");
  assert.equal(original.device, first.device);

  // Steady state: the sampler, placeholder texture and bind-group layouts on
  // this cache are built once, so churning it every frame would rebuild them.
  updateSky(skyAtmosphere, first.device);
  assert.equal(skyAtmosphere._webgpuCache, original);

  updateSky(skyAtmosphere, second.device);
  const rebuilt = skyAtmosphere._webgpuCache;
  assert.notEqual(
    rebuilt,
    original,
    "a recovered device must not inherit the dead device's sampler and layouts",
  );
  assert.equal(rebuilt.device, second.device);
});

test("a throwing sky teardown still clears the stale cache", () => {
  const first = fakeDevice("first");
  const second = fakeDevice("second");
  const skyAtmosphere = { show: true };

  updateSky(skyAtmosphere, first.device);
  const original = skyAtmosphere._webgpuCache;
  assert.ok(original);

  // A lost device can reject native teardown. If that exception escaped, the
  // dead cache would stay installed and every later frame would rebind it.
  original.placeholderLutTexture = {
    destroy() {
      throw new Error("device lost");
    },
  };

  updateSky(skyAtmosphere, second.device);

  assert.notEqual(skyAtmosphere._webgpuCache, original);
  assert.equal(skyAtmosphere._webgpuCache.device, second.device);
});
