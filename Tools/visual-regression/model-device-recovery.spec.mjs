// C11-194 — device/resource-generation recovery contracts for native Models.
//
// Run: node --test Tools/visual-regression/model-device-recovery.spec.mjs

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const directory = dirname(fileURLToPath(import.meta.url));
const engineRoot = resolve(directory, "../../packages/engine/Source");
const deviceResourcesPath = resolve(
  engineRoot,
  "Renderer/WebGPU/WebGPUModelDeviceResources.ts",
);
const stubTexturePath = resolve(
  engineRoot,
  "Renderer/WebGPU/Stubs/WebGLStubTexture.ts",
);
const featureIdPath = resolve(
  engineRoot,
  "Renderer/WebGPU/WebGPUModelFeatureId.js",
);

const readSource = async (relative) =>
  (await readFile(resolve(engineRoot, relative), "utf8")).replace(
    /\r\n/g,
    "\n",
  );

const rendererSource = await readSource(
  "Renderer/WebGPU/WebGPUModelRenderer.ts",
);
const pipelineSource = await readSource(
  "Renderer/WebGPU/WebGPUModelPipelineCache.ts",
);
const deviceResourcesSource = await readSource(
  "Renderer/WebGPU/WebGPUModelDeviceResources.ts",
);
const stubTextureSource = await readSource(
  "Renderer/WebGPU/Stubs/WebGLStubTexture.ts",
);
const contextSource = await readSource("Renderer/WebGPU/WebGPUContext.ts");
const textureSource = await readSource("Renderer/Texture.js");
const gltfTextureLoaderSource = await readSource("Scene/GltfTextureLoader.js");
const textureManagerSource = await readSource("Scene/Model/TextureManager.js");
const featureIdSource = await readSource(
  "Renderer/WebGPU/WebGPUModelFeatureId.js",
);

const bundle = await build({
  entryPoints: [deviceResourcesPath],
  bundle: true,
  format: "esm",
  target: "es2022",
  write: false,
  logLevel: "silent",
});
const moduleUrl = `data:text/javascript;base64,${Buffer.from(
  bundle.outputFiles[0].text,
).toString("base64")}`;
const { acquireWebGPUModelDeviceResources, releaseWebGPUModelDeviceResources } =
  await import(moduleUrl);

const stubBundle = await build({
  entryPoints: [stubTexturePath],
  bundle: true,
  format: "esm",
  target: "es2022",
  write: false,
  logLevel: "silent",
});
const stubModuleUrl = `data:text/javascript;base64,${Buffer.from(
  stubBundle.outputFiles[0].text,
).toString("base64")}`;
const {
  createTextureStubs,
  getWebGPUTextureForDevice,
  WebGLStubTextureRegistry,
} = await import(stubModuleUrl);

const featureIdBundle = await build({
  entryPoints: [featureIdPath],
  bundle: true,
  format: "esm",
  target: "es2022",
  write: false,
  logLevel: "silent",
});
const featureIdModuleUrl = `data:text/javascript;base64,${Buffer.from(
  featureIdBundle.outputFiles[0].text,
).toString("base64")}`;
const { destroyPerFeaturePickResources, ensurePerFeaturePickIds } =
  await import(featureIdModuleUrl);

globalThis.GPUShaderStage = { VERTEX: 1, FRAGMENT: 2, COMPUTE: 4 };
globalThis.GPUTextureUsage = {
  TEXTURE_BINDING: 1,
  COPY_DST: 2,
  RENDER_ATTACHMENT: 4,
};
globalThis.GPUBufferUsage = {
  VERTEX: 1,
  COPY_DST: 2,
  UNIFORM: 4,
  STORAGE: 8,
};

function makeDevice() {
  const created = {
    textures: [],
    buffers: [],
    bindGroupLayouts: [],
  };
  return {
    created,
    features: new Set([
      "texture-compression-bc",
      "texture-compression-astc",
      "texture-compression-etc2",
    ]),
    queue: {
      writeTexture() {},
      writeBuffer() {},
    },
    createTexture(descriptor) {
      const texture = {
        descriptor,
        destroyed: false,
        createView(viewDescriptor) {
          return { texture, descriptor: viewDescriptor };
        },
        destroy() {
          assert.equal(this.destroyed, false, "texture destroyed twice");
          this.destroyed = true;
        },
      };
      created.textures.push(texture);
      return texture;
    },
    createBuffer(descriptor) {
      const buffer = {
        descriptor,
        destroyed: false,
        destroy() {
          assert.equal(this.destroyed, false, "buffer destroyed twice");
          this.destroyed = true;
        },
      };
      created.buffers.push(buffer);
      return buffer;
    },
    createSampler(descriptor) {
      return { descriptor };
    },
    createBindGroupLayout(descriptor) {
      const layout = { descriptor };
      created.bindGroupLayouts.push(layout);
      return layout;
    },
    createBindGroup(descriptor) {
      return { descriptor };
    },
  };
}

function functionSlice(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `missing function ${name}`);
  const next = source.indexOf("\nfunction ", start + 1);
  return source.slice(start, next === -1 ? source.length : next);
}

function makeStubHarness(device, resourceGeneration = 0) {
  const mipJobs = [];
  const writes = [];
  const state = {
    device,
    resourceGeneration,
    context: null,
    currentCommandEncoder: null,
    currentRenderPassEncoder: null,
    activeTextureUnit: 0,
    textureBindings: new Map(),
    textureRegistry: new WebGLStubTextureRegistry(),
    pixelStore: {
      unpackFlipY: false,
      unpackPremultiplyAlpha: false,
      unpackAlignment: 4,
    },
    mipmapGenerator: null,
    enqueueMipGeneration(texture, format, mipLevelCount, options) {
      mipJobs.push({ texture, format, mipLevelCount, options });
    },
    cancelMipGeneration() {},
  };
  device.queue.writeTexture = (destination, data, layout, size) => {
    writes.push({
      destination,
      data: Array.from(
        new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
      ),
      layout,
      size,
    });
  };
  device.queue.submit = () => {
    throw new Error("private submit");
  };
  const stubs = createTextureStubs(state, () => {});
  return { state, stubs, mipJobs, writes };
}

test("same device and generation share; a new generation is isolated", () => {
  const device = makeDevice();
  const first = acquireWebGPUModelDeviceResources(device, 11);
  const same = acquireWebGPUModelDeviceResources(device, 11);
  const firstTextures = device.created.textures.slice();
  const firstBuffers = device.created.buffers.slice();

  assert.equal(same, first);

  const next = acquireWebGPUModelDeviceResources(device, 12);
  const nextTextures = device.created.textures.slice(firstTextures.length);
  const nextBuffers = device.created.buffers.slice(firstBuffers.length);
  assert.notEqual(next, first);
  assert.notEqual(next.cameraBGL, first.cameraBGL);

  // A mismatched release tuple owns nothing and must be a no-op.
  releaseWebGPUModelDeviceResources(device, 12, first);
  assert.ok(firstTextures.every((resource) => !resource.destroyed));
  assert.ok(firstBuffers.every((resource) => !resource.destroyed));

  releaseWebGPUModelDeviceResources(device, 11, first);
  assert.ok(firstTextures.every((resource) => !resource.destroyed));
  releaseWebGPUModelDeviceResources(device, 11, same);
  assert.ok(firstTextures.every((resource) => resource.destroyed));
  assert.ok(firstBuffers.every((resource) => resource.destroyed));
  assert.ok(nextTextures.every((resource) => !resource.destroyed));
  assert.ok(nextBuffers.every((resource) => !resource.destroyed));

  releaseWebGPUModelDeviceResources(device, 12, next);
  assert.ok(nextTextures.every((resource) => resource.destroyed));
  assert.ok(nextBuffers.every((resource) => resource.destroyed));
});

test("failed shared-resource construction rolls back and never publishes", () => {
  const device = makeDevice();
  const createBindGroup = device.createBindGroup;
  let rejectCreation = true;
  device.createBindGroup = function (descriptor) {
    if (rejectCreation) {
      throw new Error("late shared-resource construction failure");
    }
    return createBindGroup.call(this, descriptor);
  };

  assert.throws(
    () => acquireWebGPUModelDeviceResources(device, 19),
    /late shared-resource construction failure/,
  );
  const failedTextures = device.created.textures.slice();
  const failedBuffers = device.created.buffers.slice();
  assert.ok(failedTextures.length > 0);
  assert.ok(failedBuffers.length > 0);
  assert.ok(failedTextures.every((resource) => resource.destroyed));
  assert.ok(failedBuffers.every((resource) => resource.destroyed));

  rejectCreation = false;
  const recovered = acquireWebGPUModelDeviceResources(device, 19);
  const recoveredTextures = device.created.textures.slice(
    failedTextures.length,
  );
  const recoveredBuffers = device.created.buffers.slice(failedBuffers.length);
  assert.ok(recoveredTextures.every((resource) => !resource.destroyed));
  assert.ok(recoveredBuffers.every((resource) => !resource.destroyed));

  releaseWebGPUModelDeviceResources(device, 19, recovered);
  assert.ok(recoveredTextures.every((resource) => resource.destroyed));
  assert.ok(recoveredBuffers.every((resource) => resource.destroyed));
});

test("shared-resource release drains siblings before rethrowing", () => {
  const device = makeDevice();
  const resources = acquireWebGPUModelDeviceResources(device, 21);
  const textures = device.created.textures.slice();
  const buffers = device.created.buffers.slice();
  const firstError = new Error("lost-device destroy failed");
  textures[0].destroy = function () {
    assert.equal(this.destroyed, false, "texture destroyed twice");
    this.destroyed = true;
    throw firstError;
  };

  assert.throws(
    () => releaseWebGPUModelDeviceResources(device, 21, resources),
    firstError,
  );
  assert.ok(textures.every((resource) => resource.destroyed));
  assert.ok(buffers.every((resource) => resource.destroyed));

  // The logical pool lease was removed before native destruction began.
  const replacement = acquireWebGPUModelDeviceResources(device, 21);
  assert.notEqual(replacement, resources);
  releaseWebGPUModelDeviceResources(device, 21, replacement);
});

test("the shared pool and pipeline lease use the full ownership tuple", () => {
  assert.match(
    deviceResourcesSource,
    /WeakMap<[\s\S]*GPUDevice,[\s\S]*Map<number, PoolEntry>/,
  );
  assert.match(deviceResourcesSource, /generations\.get\(resourceGeneration\)/);
  assert.match(pipelineSource, /declare _resourceGeneration: number;/);
  assert.match(
    pipelineSource,
    /acquireWebGPUModelDeviceResources\(\s*device,\s*resourceGeneration,\s*\)/,
  );
  assert.match(
    pipelineSource,
    /releaseWebGPUModelDeviceResources\(\s*this\._device,\s*this\._resourceGeneration,/,
  );
});

test("pipeline teardown clears every private pipeline and module map", () => {
  const destroy = pipelineSource.slice(
    pipelineSource.lastIndexOf("  destroy() {"),
  );
  for (const field of [
    "_pipelines",
    "_pendingColorPipelines",
    "_errorPipelines",
    "_pickPipelines",
    "_snapPipelines",
    "_depthWritePipelines",
    "_velocityPipelines",
    "_classificationPipelines",
    "_silhouetteModelPipelines",
    "_silhouetteColorPipelines",
    "_pickHoverPipelines",
    "_pickPrecisePass1Pipelines",
    "_pickPrecisePass2Pipelines",
    "_capturePipelines",
    "_pickMetadataPipelines",
    "_shaderModuleCache",
    "_metadataShaderModuleCache",
  ]) {
    assert.match(destroy, new RegExp(`this\\.${field}\\.clear\\(\\)`), field);
  }
});

test("ordinary update validates ownership only after admission", () => {
  const update = functionSlice(rendererSource, "updateWebGPUModel");
  const rejection = update.indexOf(
    "preparationDecision.demand === WebGPUModelPreparationDemand.REJECTED",
  );
  const deviceRead = update.indexOf("const device = context.device;");
  const ownershipCheck = update.indexOf("disposeStaleWebGPUModelCache(");
  const construction = update.indexOf("new WebGPUModelPipelineCache(");

  assert.ok(rejection !== -1 && rejection < deviceRead);
  assert.ok(deviceRead < ownershipCheck && ownershipCheck < construction);
  assert.match(
    update,
    /const resourceGeneration = context\.resourceGeneration \?\? 0;/,
  );
  assert.match(
    update,
    /new WebGPUModelPipelineCache\([\s\S]*context\.webgpuPipelineCache \?\? null,[\s\S]*resourceGeneration,/,
  );
  assert.match(
    update,
    /try \{\s*subscribeWebGPUModelCacheInvalidation\([\s\S]*catch \(error\) \{\s*\/\/ Subscription is part of cache construction:[\s\S]*disposeWebGPUModelCache\(model, newCache\);\s*throw error;/,
  );
});

test("tile and standalone preparation retain their distinct admission paths", () => {
  const prepare = functionSlice(rendererSource, "prepareWebGPUModel");
  const tileFastReturn = prepare.indexOf(
    "if (!model.show || defined(model._content))",
  );
  const contextRead = prepare.indexOf("const context = frameState.context");
  const rejection = prepare.indexOf(
    "decision.demand === WebGPUModelPreparationDemand.REJECTED",
  );
  const ownershipCheck = prepare.indexOf("disposeStaleWebGPUModelCache(");
  const readinessPoll = prepare.indexOf("areWebGPUModelColorPipelinesReady");

  assert.ok(tileFastReturn !== -1 && tileFastReturn < contextRead);
  assert.ok(contextRead < rejection && rejection < ownershipCheck);
  assert.ok(ownershipCheck < readinessPoll);

  // Tile-owned models skip standalone prewarm, then reach the same ownership
  // check through their normal visible update path.
  const update = functionSlice(rendererSource, "updateWebGPUModel");
  assert.match(
    update,
    /disposeStaleWebGPUModelCache\(model, device, resourceGeneration\)/,
  );
});

test("invalidation and explicit teardown converge on one identity-safe disposer", () => {
  const subscribe = functionSlice(
    rendererSource,
    "subscribeWebGPUModelCacheInvalidation",
  );
  const dispose = functionSlice(rendererSource, "disposeWebGPUModelCache");
  const publicDestroy = functionSlice(
    rendererSource,
    "destroyWebGPUModelResources",
  );

  assert.match(subscribe, /defined\(activeCache\) && activeCache !== cache/);
  assert.match(subscribe, /disposeWebGPUModelCache\(model, cache\)/);
  assert.match(dispose, /cache\._disposeInProgress === true/);
  assert.match(dispose, /defined\(activeCache\) && activeCache !== cache/);
  assert.match(dispose, /model\._webgpuCache = undefined;/);
  assert.match(dispose, /cache\.primitives = \{\};/);
  assert.match(dispose, /cache\.geometryViews = \{\};/);
  assert.match(dispose, /cache\.nodes = \{\};/);
  assert.match(dispose, /const destroyBestEffort =/);
  const firstOwner = dispose.indexOf("destroyBestEffort(() =>");
  const pipelineLease = dispose.indexOf(
    "destroyBestEffort(() => cache.pipelineCache.destroy())",
  );
  const rethrow = dispose.indexOf("throw firstDestroyError");
  assert.ok(firstOwner !== -1 && firstOwner < pipelineLease);
  assert.ok(pipelineLease < rethrow);
  assert.match(publicDestroy, /disposeWebGPUModelCache\(model, cache\)/);
});

test("model teardown drains every per-feature pick owner after a throwing first ID", () => {
  const firstError = new Error("first tile-feature pick ID destroy failed");
  const destroyed = [];
  const makePickId = (name, error) => ({
    destroy() {
      destroyed.push(name);
      if (error) {
        throw error;
      }
    },
  });
  const texture = {
    destroy() {
      destroyed.push("texture");
    },
  };
  const pickIds = new Map([
    [0, makePickId("pick-0", firstError)],
    [1, makePickId("pick-1")],
    [2, makePickId("pick-2")],
  ]);
  const cache = {
    _featurePickIds: pickIds,
    _featurePickGPUTexture: texture,
    _featurePickFeaturesLength: 3,
  };

  assert.throws(() => destroyPerFeaturePickResources(cache), firstError);
  assert.deepEqual(destroyed, ["pick-0", "pick-1", "pick-2", "texture"]);
  assert.equal(cache._featurePickIds, undefined);
  assert.equal(cache._featurePickGPUTexture, undefined);
  assert.equal(cache._featurePickFeaturesLength, undefined);
  assert.equal(pickIds.size, 0);

  // Detached state makes a second teardown inert rather than double-destroying.
  destroyPerFeaturePickResources(cache);
  assert.deepEqual(destroyed, ["pick-0", "pick-1", "pick-2", "texture"]);
});

test("per-feature pick upload rolls back candidates and replacement retires old owners", () => {
  const destroyed = [];
  const candidates = [];
  const createdPickIds = [];
  let rejectUpload = true;
  const device = {
    createTexture() {
      const index = candidates.length;
      const texture = {
        destroy() {
          destroyed.push(`texture-${index}`);
        },
      };
      candidates.push(texture);
      return texture;
    },
    queue: {
      writeTexture() {
        if (rejectUpload) {
          throw new Error("feature-pick upload failed");
        }
      },
    },
  };
  const context = {
    createPickId(target) {
      const index = createdPickIds.length;
      const pickId = {
        target,
        color: {
          red: index / 255,
          green: 0,
          blue: 0,
          alpha: 1,
        },
        destroy() {
          destroyed.push(`pick-${index}`);
          if (index === 0) {
            throw new Error("synthetic pick cleanup failure");
          }
        },
      };
      createdPickIds.push(pickId);
      return pickId;
    },
  };
  const model = {};
  const primCache = {};
  const cache = {};
  const batchTexture = {
    _featuresLength: 3,
    _textureDimensions: { x: 3, y: 1 },
  };

  assert.throws(
    () =>
      ensurePerFeaturePickIds(
        device,
        primCache,
        cache,
        context,
        model,
        batchTexture,
      ),
    /feature-pick upload failed/,
  );
  assert.deepEqual(destroyed, ["texture-0", "pick-0", "pick-1", "pick-2"]);
  assert.equal(cache._featurePickIds, undefined);
  assert.equal(cache._featurePickGPUTexture, undefined);
  assert.equal(cache._featurePickFeaturesLength, undefined);
  assert.equal(primCache._featurePickGPUTexture, undefined);

  // A retry creates a complete transaction. Shrinking the feature table then
  // reuses ID 0, retires IDs 1/2, and destroys the superseded texture only
  // after the replacement upload is published.
  destroyed.length = 0;
  createdPickIds.length = 0;
  rejectUpload = false;
  const firstTexture = ensurePerFeaturePickIds(
    device,
    primCache,
    cache,
    context,
    model,
    batchTexture,
  );
  const firstIds = new Map(cache._featurePickIds);
  assert.equal(firstIds.size, 3);

  batchTexture._featuresLength = 4;
  batchTexture._textureDimensions = { x: 4, y: 1 };
  rejectUpload = true;
  assert.throws(
    () =>
      ensurePerFeaturePickIds(
        device,
        primCache,
        cache,
        context,
        model,
        batchTexture,
      ),
    /feature-pick upload failed/,
  );
  assert.deepEqual(destroyed, ["texture-2", "pick-3"]);
  assert.equal(cache._featurePickGPUTexture, firstTexture);
  assert.equal(cache._featurePickFeaturesLength, 3);
  assert.deepEqual(Array.from(cache._featurePickIds.entries()), [
    ...firstIds.entries(),
  ]);
  assert.equal(primCache._featurePickGPUTexture, firstTexture);

  batchTexture._featuresLength = 1;
  batchTexture._textureDimensions = { x: 1, y: 1 };
  rejectUpload = false;
  destroyed.length = 0;
  const replacementTexture = ensurePerFeaturePickIds(
    device,
    primCache,
    cache,
    context,
    model,
    batchTexture,
  );

  assert.notEqual(replacementTexture, firstTexture);
  assert.equal(cache._featurePickIds.size, 1);
  assert.equal(cache._featurePickIds.get(0), firstIds.get(0));
  assert.equal(cache._featurePickGPUTexture, replacementTexture);
  assert.equal(cache._featurePickFeaturesLength, 1);
  assert.equal(primCache._featurePickGPUTexture, replacementTexture);
  assert.deepEqual(destroyed, ["pick-1", "pick-2", "texture-1"]);
});

test("late async pipeline completions cannot republish after teardown", () => {
  const pendingOwnershipGuard =
    "if (this._pendingColorPipelines.get(key) !== pendingPipeline)";
  const guard = pipelineSource.indexOf(pendingOwnershipGuard);
  const publish = pipelineSource.indexOf("this._pipelines.set(key, p);", guard);
  const destroy = pipelineSource.lastIndexOf("  destroy() {");
  const clearPending = pipelineSource.indexOf(
    "this._pendingColorPipelines.clear();",
    destroy,
  );

  assert.ok(guard !== -1 && guard < publish);
  assert.ok(destroy !== -1 && clearPending > destroy);
  assert.match(pipelineSource, /declare _lifecycleEpoch: number;/);
  assert.match(
    pipelineSource.slice(destroy, destroy + 180),
    /this\._lifecycleEpoch\+\+;/,
  );
  assert.ok(
    [...pipelineSource.matchAll(/this\._device\.popErrorScope\(\)\.then/g)]
      .length >= 4,
  );
  assert.ok(
    [...pipelineSource.matchAll(/this\._lifecycleEpoch === validationEpoch/g)]
      .length >= 4,
  );
});

test("custom shader textures use only the exact compatibility ownership tuple", () => {
  assert.match(rendererSource, /const wgpuView = stubTexture\?\.view;/);
  assert.doesNotMatch(
    rendererSource,
    /stubTexture\?\.view\s*\?\?\s*tex\?\._webgpuTexture\?\.view/,
  );
});

test("compatibility textures reject stale ownership until explicitly re-uploaded", () => {
  const deviceA = makeDevice();
  const deviceB = makeDevice();
  const harness = makeStubHarness(deviceA, 4);
  const texture = harness.stubs.createTexture();
  harness.stubs.bindTexture(0x0de1, texture);
  const pixels = new Uint8Array(16).fill(37);
  harness.stubs.texImage2D(0x0de1, 0, 0x1908, 2, 2, 0, 0x1908, 0x1401, pixels);
  harness.stubs.generateMipmap(0x0de1);
  const original = texture._webgpuTexture.texture;
  const writesBeforeInvalidation = harness.writes.length;
  const mipJobsBeforeInvalidation = harness.mipJobs.length;

  assert.ok(getWebGPUTextureForDevice(texture, deviceA, 4));
  assert.equal(getWebGPUTextureForDevice(texture, deviceB, 4), null);
  assert.equal(getWebGPUTextureForDevice(texture, deviceA, 5), null);
  assert.equal(
    getWebGPUTextureForDevice(
      { _isPlaceholder: true, _webgpuTexture: texture._webgpuTexture },
      deviceA,
      4,
    ),
    null,
    "wrappers without tuple ownership metadata must not use a direct fallback",
  );

  harness.stubs.invalidateCompatibilityTextureHandles();
  assert.equal(original.destroyed, true);
  assert.equal(getWebGPUTextureForDevice(texture, deviceA, 4), null);
  assert.equal(harness.writes.length, writesBeforeInvalidation);
  assert.equal(harness.mipJobs.length, mipJobsBeforeInvalidation);

  harness.state.device = deviceB;
  harness.state.resourceGeneration = 5;
  deviceB.queue.writeTexture = deviceA.queue.writeTexture;
  const replacementPixels = new Uint8Array(16).fill(91);
  assert.equal(getWebGPUTextureForDevice(texture, deviceB, 5), null);
  harness.stubs.texImage2D(
    0x0de1,
    0,
    0x1908,
    2,
    2,
    0,
    0x1908,
    0x1401,
    replacementPixels,
  );
  const replacement = getWebGPUTextureForDevice(texture, deviceB, 5);
  assert.ok(replacement);
  assert.notEqual(replacement.texture, original);
  assert.deepEqual(harness.writes.at(-1).data, Array.from(replacementPixels));
  assert.equal(getWebGPUTextureForDevice(texture, deviceA, 4), null);

  harness.stubs.invalidateCompatibilityTextureHandles();
  harness.state.resourceGeneration = 6;
  assert.equal(getWebGPUTextureForDevice(texture, deviceB, 6), null);
  harness.stubs.texImage2D(
    0x0de1,
    0,
    0x1908,
    2,
    2,
    0,
    0x1908,
    0x1401,
    new Uint8Array(16).fill(12),
  );
  const sameDeviceNextGeneration = getWebGPUTextureForDevice(
    texture,
    deviceB,
    6,
  );
  assert.ok(sameDeviceNextGeneration);
  assert.notEqual(sameDeviceNextGeneration.texture, replacement.texture);
  assert.equal(replacement.texture.destroyed, true);
});

test("compatibility invalidation retains no upload source or replay work", () => {
  const device = makeDevice();
  const { stubs, writes, mipJobs } = makeStubHarness(device);
  const texture = stubs.createTexture();
  stubs.bindTexture(0x0de1, texture);
  stubs.texImage2D(
    0x0de1,
    0,
    0x1908,
    2,
    2,
    0,
    0x1908,
    0x1401,
    new Uint8Array(16),
  );
  stubs.generateMipmap(0x0de1);
  assert.deepEqual(stubs.getCompatibilityTextureDiagnostics(), {
    registeredHandleCount: 1,
    liveTextureCount: 1,
  });

  const writeCount = writes.length;
  const mipJobCount = mipJobs.length;
  stubs.invalidateCompatibilityTextureHandles();
  assert.equal(writes.length, writeCount);
  assert.equal(mipJobs.length, mipJobCount);
  assert.deepEqual(stubs.getCompatibilityTextureDiagnostics(), {
    registeredHandleCount: 1,
    liveTextureCount: 0,
  });

  stubs.deleteTexture(texture);
  assert.deepEqual(stubs.getCompatibilityTextureDiagnostics(), {
    registeredHandleCount: 0,
    liveTextureCount: 0,
  });
  stubs.destroyCompatibilityTextureHandles();
  assert.equal(
    stubs.getCompatibilityTextureDiagnostics().registeredHandleCount,
    0,
  );
});

test("compatibility texture invalidation drains every owner before rethrowing", () => {
  const device = makeDevice();
  const { state, stubs } = makeStubHarness(device);
  const first = stubs.createTexture();
  const second = stubs.createTexture();
  const upload = (texture, value) => {
    stubs.bindTexture(0x0de1, texture);
    stubs.texImage2D(
      0x0de1,
      0,
      0x1908,
      2,
      2,
      0,
      0x1908,
      0x1401,
      new Uint8Array(16).fill(value),
    );
  };
  upload(first, 1);
  upload(second, 2);
  const firstNative = first._webgpuTexture.texture;
  const secondNative = second._webgpuTexture.texture;
  const firstError = new Error("lost first native destroy failed");
  firstNative.destroy = function () {
    this.destroyed = true;
    throw firstError;
  };
  let mipOwnerDestroyed = false;
  state.mipmapGenerator = {
    destroy() {
      mipOwnerDestroyed = true;
    },
  };

  assert.throws(
    () => stubs.invalidateCompatibilityTextureHandles(),
    firstError,
  );
  assert.equal(firstNative.destroyed, true);
  assert.equal(secondNative.destroyed, true);
  assert.equal(first._webgpuTexture, null);
  assert.equal(second._webgpuTexture, null);
  assert.equal(mipOwnerDestroyed, true);
  assert.equal(state.mipmapGenerator, null);
  assert.deepEqual(stubs.getCompatibilityTextureDiagnostics(), {
    registeredHandleCount: 2,
    liveTextureCount: 0,
  });
});

test("compressed texture tail mips use physical blocks and reject invalid writes", () => {
  const device = makeDevice();
  const { stubs, writes, mipJobs } = makeStubHarness(device);
  const texture = stubs.createTexture();
  stubs.bindTexture(0x0de1, texture);
  const block = new Uint8Array(8).fill(17);

  stubs.compressedTexImage2D(0x0de1, 0, 0x83f1, 4, 4, 0, block);
  stubs.compressedTexImage2D(0x0de1, 1, 0x83f1, 2, 2, 0, block);
  stubs.compressedTexSubImage2D(0x0de1, 2, 0, 0, 1, 1, 0x83f1, block);
  stubs.generateMipmap(0x0de1);
  assert.equal(mipJobs.length, 0);

  for (const write of writes.slice(-2)) {
    assert.equal(write.layout.bytesPerRow, 8);
    assert.equal(write.layout.rowsPerImage, 1);
    assert.deepEqual(write.size, {
      width: 4,
      height: 4,
      depthOrArrayLayers: 1,
    });
  }

  const writeCount = writes.length;
  stubs.compressedTexImage2D(0x0de1, 3, 0x83f1, 1, 1, 0, block);
  stubs.compressedTexSubImage2D(0x0de1, 3, 0, 0, 1, 1, 0x83f1, block);
  stubs.compressedTexSubImage2D(0x0de1, 0, 2, 0, 2, 4, 0x83f1, block);
  stubs.compressedTexSubImage2D(0x0de1, 0, -4, 0, 4, 4, 0x83f1, block);
  stubs.compressedTexImage2D(0x0de1, 1, 0x83f3, 2, 2, 0, new Uint8Array(16));
  stubs.compressedTexSubImage2D(
    0x0de1,
    1,
    0,
    0,
    2,
    2,
    0x83f3,
    new Uint8Array(16),
  );
  assert.equal(writes.length, writeCount);
});

test("compressed base allocation requires the device feature and block alignment", () => {
  const device = makeDevice();
  device.features.delete("texture-compression-bc");
  const { stubs, writes } = makeStubHarness(device);
  const unsupported = stubs.createTexture();
  stubs.bindTexture(0x0de1, unsupported);
  stubs.compressedTexImage2D(0x0de1, 0, 0x83f1, 4, 4, 0, new Uint8Array(8));
  assert.equal(device.created.textures.length, 0);
  assert.equal(unsupported._webgpuTexture, null);

  device.features.add("texture-compression-bc");
  const misaligned = stubs.createTexture();
  stubs.bindTexture(0x0de1, misaligned);
  stubs.compressedTexImage2D(0x0de1, 0, 0x83f1, 6, 4, 0, new Uint8Array(16));
  assert.equal(device.created.textures.length, 0);
  assert.equal(misaligned._webgpuTexture, null);
  assert.equal(writes.length, 0);
});

test("lost-native cleanup cannot roll back an otherwise healthy recovery tuple", () => {
  const clearStart = contextSource.indexOf("public _clearAllCaches(");
  const clearEnd = contextSource.indexOf(
    "public _rollbackRecoveredDevice(",
    clearStart,
  );
  assert.ok(clearStart !== -1 && clearEnd > clearStart);
  const clear = contextSource.slice(clearStart, clearEnd);
  const textures = clear.indexOf("invalidateCompatibilityTextureHandles");
  const buffers = clear.indexOf("invalidateCompatibilityBufferHandles");
  const generation = clear.indexOf("this._deviceResourceGeneration += 1");
  const listeners = clear.indexOf("this._fireDeviceInvalidated()");
  const report = clear.indexOf(
    "[WebGPU] Recovered with an old-device cleanup error:",
  );
  assert.ok(textures !== -1 && textures < buffers);
  assert.ok(buffers < generation && generation < listeners);
  assert.ok(listeners < report);
  assert.doesNotMatch(clear, /throw firstLostNativeCleanupError/);
});

test("model texture recovery stays identity-safe without retained replay", () => {
  assert.doesNotMatch(textureSource, /retainForDeviceRecovery/);
  assert.doesNotMatch(gltfTextureLoaderSource, /retainForDeviceRecovery/);
  assert.doesNotMatch(textureManagerSource, /retainForDeviceRecovery/);
  assert.match(rendererSource, /getWebGPUTextureForDevice\(/);
  assert.match(featureIdSource, /getWebGPUTextureForDevice\(/);
  assert.doesNotMatch(stubTextureSource, /UploadReplay|RecoveryReplay/);
  assert.doesNotMatch(stubTextureSource, /restoreDeviceGeneration\(/);
  assert.doesNotMatch(stubTextureSource, /\.queue\.submit\(/);
  assert.match(
    contextSource,
    /this\._gl\.invalidateCompatibilityTextureHandles\(\)/,
  );
  assert.doesNotMatch(contextSource, /restoreCompatibilityTextureHandles/);
  assert.match(
    stubTextureSource,
    /state\.enqueueMipGeneration\([\s\S]*realization\.texture/,
  );
});
