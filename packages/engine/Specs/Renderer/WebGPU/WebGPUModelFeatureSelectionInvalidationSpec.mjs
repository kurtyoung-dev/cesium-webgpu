/**
 * Pure-Node coverage for coherent WebGPU model feature-resource generations.
 *
 * Run:
 * npm run test-model-webgpu
 */
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { setImmediate } from "node:timers";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

const HERE = dirname(fileURLToPath(import.meta.url));
const ENGINE_SOURCE = resolve(HERE, "../../../Source");
const FEATURE_MODULE_PATH = resolve(
  ENGINE_SOURCE,
  "Renderer/WebGPU/WebGPUModelFeatureId.js",
);
const BATCH_TEXTURE_PATH = resolve(ENGINE_SOURCE, "Scene/BatchTexture.js");

globalThis.GPUTextureUsage ??= {
  TEXTURE_BINDING: 0x01,
  COPY_DST: 0x02,
  RENDER_ATTACHMENT: 0x04,
};
globalThis.GPUBufferUsage ??= {
  UNIFORM: 0x01,
  COPY_DST: 0x02,
};

async function importBundle(options) {
  const result = await build(options);
  const moduleUrl = `data:text/javascript;base64,${Buffer.from(
    result.outputFiles[0].text,
  ).toString("base64")}`;
  return import(moduleUrl);
}

async function loadFeatureModule(featureModuleSource) {
  const plugins = [];
  if (featureModuleSource !== undefined) {
    plugins.push({
      name: "feature-module-source-substitution",
      setup(buildApi) {
        buildApi.onLoad({ filter: /WebGPUModelFeatureId\.js$/ }, (args) => {
          if (resolve(args.path) !== FEATURE_MODULE_PATH) {
            return undefined;
          }
          return {
            contents: featureModuleSource,
            loader: "js",
            resolveDir: dirname(args.path),
          };
        });
      },
    });
  }
  return importBundle({
    stdin: {
      contents: `
        export { default as Color } from "./Core/Color.js";
        export {
          destroyFeatureIdResources,
          encodeFeatureIdCompatibilityToken,
          ensureFeatureIdResources
        } from "./Renderer/WebGPU/WebGPUModelFeatureId.js";
        export { default as BatchTexture } from "./Scene/BatchTexture.js";
        export * as ModelComponents from "./Scene/ModelComponents.js";
      `,
      resolveDir: ENGINE_SOURCE,
      sourcefile: "model-feature-selection-invalidation-entry.mjs",
    },
    bundle: true,
    format: "esm",
    platform: "node",
    target: "es2022",
    write: false,
    logLevel: "silent",
    plugins,
  });
}

const featureModule = await loadFeatureModule();
const {
  BatchTexture,
  Color,
  ModelComponents,
  destroyFeatureIdResources,
  encodeFeatureIdCompatibilityToken,
} = featureModule;

async function loadBatchTextureModule(batchTextureSource) {
  return importBundle({
    stdin: {
      contents:
        'export { default as TestBatchTexture } from "./Scene/BatchTexture.js";',
      resolveDir: ENGINE_SOURCE,
      sourcefile: "batch-texture-retry-entry.mjs",
    },
    bundle: true,
    format: "esm",
    platform: "node",
    target: "es2022",
    write: false,
    logLevel: "silent",
    plugins: [
      {
        name: "batch-texture-source-substitution",
        setup(buildApi) {
          buildApi.onLoad({ filter: /BatchTexture\.js$/ }, (args) => {
            if (
              batchTextureSource === undefined ||
              resolve(args.path) !== BATCH_TEXTURE_PATH
            ) {
              return undefined;
            }
            return {
              contents: batchTextureSource,
              loader: "js",
              resolveDir: dirname(args.path),
            };
          });
        },
      },
      {
        name: "batch-texture-instrumented-texture",
        setup(buildApi) {
          buildApi.onResolve(
            { filter: /^\.\.\/Renderer\/Texture\.js$/ },
            () => ({
              path: "instrumented-texture",
              namespace: "batch-texture-test",
            }),
          );
          buildApi.onLoad(
            { filter: /.*/, namespace: "batch-texture-test" },
            () => ({
              loader: "js",
              contents: [
                "export default class InstrumentedTexture {",
                "  constructor(options) {",
                "    const control = options.context.__batchTextureTextureControl;",
                "    control.createCalls++;",
                "    if (control.failCreateCount > 0) {",
                "      control.failCreateCount--;",
                '      throw new Error("instrumented texture creation failed");',
                "    }",
                "    this.control = control;",
                "    this.copyCalls = 0;",
                "    this.destroyCalls = 0;",
                "    this.sizeInBytes = options.source.arrayBufferView.byteLength;",
                "    this.initialBytes = Array.from(options.source.arrayBufferView);",
                "    control.textures.push(this);",
                "  }",
                "  copyFrom({ source }) {",
                "    this.copyCalls++;",
                "    this.control.copyCalls++;",
                "    this.control.copySources.push(Array.from(source.arrayBufferView));",
                "    if (this.control.failCopyCount > 0) {",
                "      this.control.failCopyCount--;",
                '      throw new Error("instrumented texture copy failed");',
                "    }",
                "  }",
                "  destroy() {",
                "    this.destroyCalls++;",
                "  }",
                "}",
              ].join("\n"),
            }),
          );
        },
      },
    ],
  });
}

const { TestBatchTexture } = await loadBatchTextureModule();

const FLAG_FEATURE_TEXTURE = 0x10000;
const FLAG_FEATURE_ATTRIBUTE = 0x20000;
const FLAG_BATCH_TABLE = 0x40000;
const FEATURE_PICK_ENABLED_OFFSET = 40;
const COMPATIBILITY_TOKEN = encodeFeatureIdCompatibilityToken(true, false);
const IMPLICIT_COMPATIBILITY_TOKEN = encodeFeatureIdCompatibilityToken(
  true,
  true,
);

function tick() {
  return new Promise((resolvePromise) => setImmediate(resolvePromise));
}

function replaceOnce(candidate, anchor, replacement, label) {
  const mutated = candidate.replace(anchor, replacement);
  assert.notEqual(mutated, candidate, `${label} mutation anchor must match`);
  return mutated;
}

function replaceFunctionBodyOnce(candidate, functionName, replacementBody) {
  const start = candidate.indexOf(`function ${functionName}(`);
  assert.notEqual(start, -1, `${functionName} must exist`);
  const bodyStart = candidate.indexOf("{", start);
  assert.notEqual(bodyStart, -1, `${functionName} body must exist`);
  let depth = 1;
  let end = bodyStart + 1;
  for (; end < candidate.length && depth > 0; end++) {
    if (candidate[end] === "{") {
      depth++;
    } else if (candidate[end] === "}") {
      depth--;
    }
  }
  assert.equal(depth, 0, `${functionName} body must close`);
  const original = candidate.slice(start, end);
  const signature = candidate.slice(start, bodyStart + 1);
  return replaceOnce(
    candidate,
    original,
    `${signature}\n${replacementBody}\n}`,
    functionName,
  );
}

function isAssertionErrorWith(message) {
  return (error) =>
    error instanceof assert.AssertionError && error.message.includes(message);
}

function consumeFailure(state, kind, label = "") {
  const failure = state.failures[kind];
  if (
    !failure ||
    failure.count <= 0 ||
    (failure.prefix && !label.startsWith(failure.prefix))
  ) {
    return false;
  }
  failure.count--;
  return true;
}

class FakeTexture {
  constructor(state, descriptor, borrowed = false) {
    this.state = state;
    this.descriptor = descriptor;
    this.borrowed = borrowed;
    this.viewCalls = 0;
    this.destroyCalls = 0;
    this.throwOnDestroy = false;
  }

  createView() {
    this.viewCalls++;
    this.state.hooks.createView?.(this);
    if (consumeFailure(this.state, "createView", this.descriptor.label ?? "")) {
      throw new Error(`view failed: ${this.descriptor.label}`);
    }
    return { texture: this, viewIndex: this.viewCalls };
  }

  destroy() {
    this.destroyCalls++;
    if (this.throwOnDestroy) {
      throw new Error(`destroy failed: ${this.descriptor.label}`);
    }
  }
}

class FakeBuffer {
  constructor(state, descriptor) {
    this.state = state;
    this.descriptor = descriptor;
    this.bytes = new Uint8Array(descriptor.size);
    this.destroyCalls = 0;
    this.throwOnDestroy = false;
  }

  destroy() {
    this.destroyCalls++;
    if (this.throwOnDestroy) {
      throw new Error(`destroy failed: ${this.descriptor.label}`);
    }
  }
}

class FakeQueue {
  constructor(state, label) {
    this.state = state;
    this.label = label;
    this.textureWrites = [];
    this.externalCopies = [];
    this.bufferWrites = [];
    this.fences = [];
  }

  writeTexture(destination, data, layout, size) {
    const texture = destination.texture;
    this.state.hooks.writeTexture?.(texture, data);
    if (
      consumeFailure(this.state, "writeTexture", texture.descriptor.label ?? "")
    ) {
      throw new Error(`texture upload failed: ${texture.descriptor.label}`);
    }
    this.textureWrites.push({
      texture,
      bytes: Array.from(
        new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
      ),
      layout,
      size,
    });
  }

  copyExternalImageToTexture(source, destination, size) {
    const texture = destination.texture;
    this.state.hooks.copyExternalImage?.(texture, source.source);
    if (consumeFailure(this.state, "copyExternalImage")) {
      throw new Error("external texture upload failed");
    }
    this.externalCopies.push({ texture, source: source.source, size });
  }

  writeBuffer(buffer, offset, data) {
    this.state.hooks.writeBuffer?.(buffer, offset, data);
    const failureLabel = `${buffer.descriptor.label}:${offset}`;
    if (consumeFailure(this.state, "writeBuffer", failureLabel)) {
      throw new Error(`buffer upload failed: ${failureLabel}`);
    }
    const bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    buffer.bytes.set(bytes, offset);
    this.bufferWrites.push({ buffer, offset, bytes: Array.from(bytes) });
  }

  onSubmittedWorkDone() {
    if (consumeFailure(this.state, "fenceThrow")) {
      throw new Error("fence acquisition failed");
    }
    let resolvePromise;
    let rejectPromise;
    const promise = new Promise((resolveFence, rejectFence) => {
      resolvePromise = resolveFence;
      rejectPromise = rejectFence;
    });
    const fence = {
      settled: false,
      resolve() {
        if (!fence.settled) {
          fence.settled = true;
          resolvePromise();
        }
      },
      reject() {
        if (!fence.settled) {
          fence.settled = true;
          rejectPromise(new Error("device lost"));
        }
      },
    };
    this.fences.push(fence);
    return promise;
  }
}

class FakeDevice {
  constructor(state, label) {
    this.state = state;
    this.label = label;
    this.queue = new FakeQueue(state, `${label}-queue`);
    state.queues.push(this.queue);
  }

  createTexture(descriptor) {
    this.state.hooks.createTexture?.(descriptor);
    if (consumeFailure(this.state, "createTexture", descriptor.label ?? "")) {
      throw new Error(`texture creation failed: ${descriptor.label}`);
    }
    const texture = new FakeTexture(this.state, descriptor);
    this.state.textures.push(texture);
    this.state.hooks.textureCreated?.(texture);
    return texture;
  }

  createBuffer(descriptor) {
    this.state.hooks.createBuffer?.(descriptor);
    if (consumeFailure(this.state, "createBuffer", descriptor.label ?? "")) {
      throw new Error(`buffer creation failed: ${descriptor.label}`);
    }
    const buffer = new FakeBuffer(this.state, descriptor);
    this.state.buffers.push(buffer);
    return buffer;
  }
}

function makeContext(state) {
  const context = {
    currentCommandEncoder: { label: "encoder-a" },
    resourceGeneration: 0,
    enqueueMode: "accept",
    enqueueCalls: [],
    callbacks: [],
    wrongSchedulerCalls: 0,
    enqueueAfterCommandEncoderSubmit(encoder, callback) {
      context.enqueueCalls.push({ encoder, callback });
      if (context.enqueueMode === "callback-then-throw") {
        callback();
        throw new Error("enlistment failed");
      }
      if (context.enqueueMode === "throw") {
        throw new Error("enlistment failed");
      }
      if (context.enqueueMode === "callback-then-false") {
        callback();
        return false;
      }
      if (context.enqueueMode === "false") {
        return false;
      }
      if (context.enqueueMode === "callback-then-accept") {
        callback();
        return true;
      }
      context.callbacks.push(callback);
      return true;
    },
    scheduleTextureDestroy() {
      context.wrongSchedulerCalls++;
      throw new Error("frame-wide scheduler is forbidden");
    },
    fireNextCallback() {
      const callback = context.callbacks.shift();
      assert.ok(callback, "expected an exact-encoder retirement callback");
      callback();
    },
    createPickId(target, kind) {
      state.hooks.createPickId?.(target, kind);
      const index = state.pickIds.length + 1;
      const pickId = {
        target,
        kind,
        color: { red: index / 255, green: 0, blue: 0, alpha: 1 },
        destroyCalls: 0,
        destroy() {
          pickId.destroyCalls++;
        },
      };
      state.pickIds.push(pickId);
      return pickId;
    },
  };
  return context;
}

function attributeSource(
  label,
  positionalLabel = `featureId_${label}`,
  setIndex = 0,
  components = ModelComponents,
) {
  const source = new components.FeatureIdAttribute();
  source.label = label;
  source.positionalLabel = positionalLabel;
  source.featureCount = 2;
  source.nullFeatureId = -1;
  source.propertyTableId = 0;
  source.setIndex = setIndex;
  source._featureResourceRevision = 0;
  return source;
}

function implicitSource(
  label,
  positionalLabel = `featureId_${label}`,
  components = ModelComponents,
) {
  const source = new components.FeatureIdImplicitRange();
  source.label = label;
  source.positionalLabel = positionalLabel;
  source.featureCount = 2;
  source.nullFeatureId = -1;
  source.propertyTableId = 0;
  source.offset = 3;
  source.repeat = 2;
  source._featureResourceRevision = 0;
  return source;
}

function textureSource(
  label,
  {
    positionalLabel = `featureId_${label}`,
    channels = "r",
    texCoord = 0,
    width = 2,
    height = 2,
    ready = true,
  } = {},
) {
  const source = new ModelComponents.FeatureIdTexture();
  source.label = label;
  source.positionalLabel = positionalLabel;
  source.featureCount = 2;
  source.nullFeatureId = -1;
  source.propertyTableId = 0;
  source._featureResourceRevision = 0;
  source.textureReader = {
    channels,
    texCoord,
    texture: ready ? { _source: { label, width, height } } : {},
  };
  return source;
}

function makeOwner(label, featuresLength) {
  const features = new Array(featuresLength);
  for (let featureId = 0; featureId < featuresLength; featureId++) {
    features[featureId] = {
      label,
      featureId,
    };
  }
  return {
    label,
    features,
    getFeature(featureId) {
      return features[featureId];
    },
  };
}

function makeBatchTexture(
  label,
  featuresLength = 2,
  BatchTextureClass = BatchTexture,
) {
  const batchTexture = new BatchTextureClass({
    owner: makeOwner(label, featuresLength),
    featuresLength,
  });
  const dimensions = batchTexture._textureDimensions;
  batchTexture._batchValues = new Uint8Array(
    dimensions.x * dimensions.y * 4,
  ).fill(255);
  return batchTexture;
}

function makeBatchTextureFrameState(maximumTextureSize = 4096) {
  return {
    context: {
      defaultTexture: undefined,
      limits: { maximumTextureSize },
    },
    passes: {
      pick: false,
      postProcess: false,
    },
  };
}

function makeInstrumentedBatchTexture(
  label,
  control,
  {
    featuresLength = 1,
    maximumTextureSize = 4096,
    BatchTextureClass = TestBatchTexture,
  } = {},
) {
  const statistics = { batchTableByteLength: 0 };
  const batchTexture = new BatchTextureClass({
    owner: makeOwner(label, featuresLength),
    featuresLength,
    statistics,
  });
  const frameState = makeBatchTextureFrameState(maximumTextureSize);
  frameState.context.__batchTextureTextureControl = control;
  return { batchTexture, frameState, statistics };
}

function makeBatchTextureControl({
  failCreateCount = 0,
  failCopyCount = 0,
} = {}) {
  return {
    createCalls: 0,
    copyCalls: 0,
    failCreateCount,
    failCopyCount,
    textures: [],
    copySources: [],
  };
}

function assertBatchTextureLayoutRebuild(BatchTextureClass) {
  const control = makeBatchTextureControl();
  const { batchTexture, frameState } = makeInstrumentedBatchTexture(
    "layout-rebuild",
    control,
    {
      featuresLength: 5,
      maximumTextureSize: 2,
      BatchTextureClass,
    },
  );
  batchTexture.setShow(0, false);
  batchTexture.update(undefined, frameState, false);
  const initialTexture = batchTexture._batchTexture;
  assert.ok(initialTexture, "initial batch texture must be created");
  assert.equal(batchTexture._batchValues.length, 24);

  frameState.context.limits.maximumTextureSize = 4;
  batchTexture.update(undefined, frameState, false);

  assert.ok(
    batchTexture._batchTexture,
    "layout change must recreate the batch texture in the same update",
  );
  assert.notEqual(batchTexture._batchTexture, initialTexture);
  assert.equal(initialTexture.destroyCalls, 1);
  assert.equal(control.createCalls, 2);
  assert.equal(control.copyCalls, 2);
  assert.equal(batchTexture._batchValues.length, 32);
  assert.deepEqual(
    batchTexture._batchTexture.initialBytes,
    Array.from(batchTexture._batchValues),
  );
  assert.deepEqual(
    control.copySources.at(-1),
    Array.from(batchTexture._batchValues),
  );
}

function assertCapturedBatchDirtyGuard(featureApi, retained) {
  const source = attributeSource(
    "dirty-guard",
    "featureId_0",
    0,
    featureApi.ModelComponents,
  );
  const harness = createHarness({
    sources: [source],
    selectedLabel: source.label,
    featureApi,
    compatibilityToken: featureApi.encodeFeatureIdCompatibilityToken(
      true,
      false,
    ),
  });
  if (retained) {
    assert.ok(harness.ensure(false), "retained fixture must publish initially");
  }

  const batchTexture = harness.batchTexture;
  batchTexture.setShow(0, false);
  const uploadedBytes = Array.from(batchTexture._batchValues);
  let generation = harness.primCache._featureIdGeneration;
  let uploadFinished = false;
  let reentered = false;
  harness.state.hooks.writeTexture = (texture) => {
    if (texture.descriptor.label.startsWith("Batch texture")) {
      uploadFinished = true;
    }
  };
  Object.defineProperty(harness.primCache, "_featureIdGeneration", {
    configurable: true,
    get() {
      if (uploadFinished && !reentered) {
        reentered = true;
        batchTexture.setColor(1, featureApi.Color.YELLOW);
      }
      return generation;
    },
    set(value) {
      generation = value;
    },
  });

  let result;
  assert.doesNotThrow(() => {
    result = harness.ensure(false);
  });
  assert.ok(result, "dirty-guard fixture must return resources");
  assert.equal(
    reentered,
    true,
    `${retained ? "retained" : "candidate"} post-refresh observation must reenter`,
  );
  assert.equal(
    batchTexture._batchValuesDirty,
    true,
    `${retained ? "retained" : "candidate"} newer batch bytes must remain dirty (live revision ${batchTexture._featureResourceRevision}, captured revision ${harness.primCache._featureIdGeneration.provenance.batchContentRevision})`,
  );
  assert.notDeepEqual(
    uploadedBytes,
    Array.from(batchTexture._batchValues),
    "reentrant edit must be newer than the uploaded bytes",
  );
  const batchGPUTexture = entry(result.featureIdEntries, 28).resource.texture;
  const writes = harness.device.queue.textureWrites.filter(
    (write) => write.texture === batchGPUTexture,
  );
  assert.deepEqual(writes.at(-1).bytes, uploadedBytes);
}

function createHarness({
  sources,
  selectedLabel,
  featuresLength = 2,
  featureApi = featureModule,
  compatibilityToken = COMPATIBILITY_TOKEN,
} = {}) {
  const state = {
    textures: [],
    buffers: [],
    queues: [],
    pickIds: [],
    failures: {},
    hooks: {},
  };
  let device = new FakeDevice(state, "device-a");
  const context = makeContext(state);
  const fallbackTexture = new FakeTexture(
    state,
    { label: "borrowed fallback white" },
    true,
  );
  const batchTexture = makeBatchTexture(
    "batch-a",
    featuresLength,
    featureApi.BatchTexture,
  );
  const featureTable = {
    featuresLength,
    batchTexture,
    _featureResourceRevision: 0,
  };
  const primitive = {
    featureIds: sources ?? [
      attributeSource("a", "featureId_0", 0, featureApi.ModelComponents),
    ],
    _featureResourceRevision: 0,
  };
  const runtimeNode = {
    node: undefined,
    _featureResourceRevision: 0,
  };
  const model = {
    featureIdLabel: selectedLabel ?? primitive.featureIds[0].label,
    instanceFeatureIdLabel: undefined,
    featureTableId: 0,
    featureTables: [featureTable],
    _featureResourceRevision: 0,
  };
  const pipelineCache = {
    defaultWhiteTexture: fallbackTexture,
    defaultSampler: { label: "default sampler" },
    propertyTextureSampler: { label: "nearest sampler" },
  };
  const modelCache = { primitives: {} };
  const primCache = {};
  modelCache.primitives.p0 = primCache;

  const harness = {
    state,
    context,
    fallbackTexture,
    model,
    modelCache,
    pipelineCache,
    primCache,
    primitive,
    runtimeNode,
    compatibilityToken,
    get device() {
      return device;
    },
    set device(value) {
      device = value;
    },
    get batchTexture() {
      return model.featureTables[model.featureTableId]?.batchTexture;
    },
    ensure(
      pickPassActive = false,
      compatibilityToken = harness.compatibilityToken,
    ) {
      return harness.ensureFor(primCache, pickPassActive, compatibilityToken);
    },
    ensureFor(
      targetPrimCache,
      pickPassActive = false,
      compatibilityToken = harness.compatibilityToken,
    ) {
      return featureApi.ensureFeatureIdResources(
        device,
        targetPrimCache,
        model,
        primitive,
        runtimeNode,
        pipelineCache,
        context,
        modelCache,
        pickPassActive,
        compatibilityToken,
      );
    },
    replaceDevice(label = "device-b") {
      const oldDevice = device;
      device = new FakeDevice(state, label);
      return { oldDevice, newDevice: device };
    },
  };
  return harness;
}

function entry(entries, binding) {
  const value = entries.find((candidate) => candidate.binding === binding);
  assert.ok(value, `missing binding ${binding}`);
  return value;
}

function uniformValues(entries) {
  const buffer = entry(entries, 30).resource.buffer;
  return {
    buffer,
    i32: Array.from(new Int32Array(buffer.bytes.buffer, 0, 12)),
    f32: Array.from(new Float32Array(buffer.bytes.buffer, 0, 12)),
  };
}

function counters(harness) {
  return {
    textures: harness.state.textures.length,
    buffers: harness.state.buffers.length,
    views:
      harness.fallbackTexture.viewCalls +
      harness.state.textures.reduce(
        (sum, texture) => sum + texture.viewCalls,
        0,
      ),
    textureWrites: harness.state.queues.reduce(
      (sum, queue) => sum + queue.textureWrites.length,
      0,
    ),
    externalCopies: harness.state.queues.reduce(
      (sum, queue) => sum + queue.externalCopies.length,
      0,
    ),
    bufferWrites: harness.state.queues.reduce(
      (sum, queue) => sum + queue.bufferWrites.length,
      0,
    ),
    enqueues: harness.context.enqueueCalls.length,
    fences: harness.state.queues.reduce(
      (sum, queue) => sum + queue.fences.length,
      0,
    ),
  };
}

async function settleAcceptedRetirements(harness, reject = false) {
  while (harness.context.callbacks.length > 0) {
    harness.context.fireNextCallback();
  }
  await tick();
  for (const queue of harness.state.queues) {
    for (const fence of queue.fences) {
      if (!fence.settled) {
        if (reject) {
          fence.reject();
        } else {
          fence.resolve();
        }
      }
    }
  }
  await tick();
  await tick();
}

function ownedResources(entries, fallbackTexture) {
  const resources = [
    entry(entries, 26).resource.texture,
    entry(entries, 28).resource.texture,
    entry(entries, 30).resource.buffer,
  ];
  return resources.filter((resource) => resource !== fallbackTexture);
}

function assertDestroyedExactly(resources, expected) {
  for (const resource of resources) {
    assert.equal(
      resource.destroyCalls,
      expected,
      `${resource.descriptor.label} destroy count`,
    );
  }
}

test("cold attribute, implicit, and texture generations bind exact resources and stay allocation-stable", () => {
  const cases = [
    {
      name: "attribute",
      source: attributeSource("a", "featureId_0"),
      flags: FLAG_FEATURE_ATTRIBUTE | FLAG_BATCH_TABLE,
      textures: 1,
      copies: 0,
      channelCount: 1,
      texCoord: 0,
    },
    {
      name: "implicit",
      source: implicitSource("i", "featureId_0"),
      compatibilityToken: IMPLICIT_COMPATIBILITY_TOKEN,
      flags: FLAG_FEATURE_ATTRIBUTE | FLAG_BATCH_TABLE,
      textures: 1,
      copies: 0,
      channelCount: 1,
      texCoord: 0,
    },
    {
      name: "texture",
      source: textureSource("t", {
        positionalLabel: "featureId_0",
        channels: "rg",
        texCoord: 1,
      }),
      flags: FLAG_FEATURE_TEXTURE | FLAG_BATCH_TABLE,
      textures: 2,
      copies: 1,
      channelCount: 2,
      texCoord: 1,
    },
  ];

  for (const expected of cases) {
    const harness = createHarness({
      sources: [expected.source],
      selectedLabel: expected.source.label,
      compatibilityToken: expected.compatibilityToken ?? COMPATIBILITY_TOKEN,
    });
    const cold = harness.ensure(false);
    assert.ok(cold, `${expected.name} must publish`);
    assert.equal(cold.flags, expected.flags);
    assert.equal(cold.featureIdEntries.length, 7);
    assert.equal(counters(harness).textures, expected.textures);
    assert.equal(counters(harness).buffers, 1);
    assert.equal(counters(harness).textureWrites, 1);
    assert.equal(counters(harness).externalCopies, expected.copies);
    assert.equal(counters(harness).bufferWrites, 1);
    assert.equal(
      entry(cold.featureIdEntries, 31).resource.texture,
      harness.fallbackTexture,
    );
    const uniform = uniformValues(cold.featureIdEntries);
    assert.equal(uniform.i32[0], 2);
    assert.equal(uniform.i32[1], expected.channelCount);
    assert.equal(uniform.i32[2], expected.texCoord);
    assert.equal(uniform.i32[3], 0);
    assert.deepEqual(uniform.f32.slice(4, 10), [0.5, 0.25, 1, 0.5, 2, 1]);
    assert.equal(uniform.f32[10], 0);

    const stableCounts = counters(harness);
    const stable = harness.ensure(false);
    assert.equal(stable.featureIdEntries, cold.featureIdEntries);
    assert.deepEqual(counters(harness), stableCounts);

    harness.model.featureIdLabel = expected.source.positionalLabel;
    const aliasStable = harness.ensure(false);
    assert.equal(aliasStable.featureIdEntries, cold.featureIdEntries);
    assert.deepEqual(counters(harness), stableCounts);
  }
});

function assertAttributeSetCompatibility(featureApi) {
  function makeHarness(selectedLabel, isSynthesizedImplicit = false) {
    const set0 = attributeSource(
      "set-zero",
      "featureId_0",
      0,
      featureApi.ModelComponents,
    );
    const set1 = attributeSource(
      "set-one",
      "featureId_1",
      1,
      featureApi.ModelComponents,
    );
    return createHarness({
      sources: [set0, set1],
      selectedLabel,
      featureApi,
      compatibilityToken: featureApi.encodeFeatureIdCompatibilityToken(
        true,
        isSynthesizedImplicit,
      ),
    });
  }

  // The bound buffer carries whichever explicit set the geometry extractor
  // kept, which need not be the selected one. Styling then reads the other
  // set, but the primitive still draws; suppressing the command instead would
  // remove a model that renders today.
  assert.ok(
    makeHarness("set-one").ensure(false),
    "a selected set the bound buffer did not come from still renders",
  );
  assert.ok(
    makeHarness("set-zero").ensure(false),
    "matching attribute set must publish resources",
  );
  // A synthesized buffer holds implicit IDs, so no explicit attribute
  // selection can be served by it.
  assert.equal(
    makeHarness("set-zero", true).ensure(false),
    null,
    "attribute selection on a synthesized buffer must fail closed",
  );
}

function assertImplicitBufferCompatibility(featureApi) {
  function makeHarness(isSynthesizedImplicit) {
    const source = implicitSource(
      "implicit",
      "featureId_0",
      featureApi.ModelComponents,
    );
    return createHarness({
      sources: [source],
      selectedLabel: source.label,
      featureApi,
      compatibilityToken: featureApi.encodeFeatureIdCompatibilityToken(
        true,
        isSynthesizedImplicit,
      ),
    });
  }

  assert.equal(
    makeHarness(false).ensure(false),
    null,
    "implicit buffer mismatch must fail closed",
  );
  assert.ok(
    makeHarness(true).ensure(false),
    "synthesized implicit buffer must publish resources",
  );
}

test("compatibility token binds primitive selection to the actual feature-ID buffer", () => {
  assertAttributeSetCompatibility(featureModule);
  assertImplicitBufferCompatibility(featureModule);
});

test("feature-buffer compatibility absence and inertness mutants are rejected", async () => {
  const source = (await readFile(FEATURE_MODULE_PATH, "utf8")).replace(
    /\r\n/g,
    "\n",
  );
  const absenceSource = replaceFunctionBodyOnce(
    source,
    "featureResourceCompatibilityAllows",
    [
      "  if (!defined(provenance.compatibilityToken)) {",
      "    return true;",
      "  }",
      "  const requiresPrimitiveFeatureAttribute =",
      "    provenance.selectedDomain === 2 &&",
      "    (provenance.selectedKind === FEATURE_SOURCE_ATTRIBUTE ||",
      "      provenance.selectedKind === FEATURE_SOURCE_IMPLICIT);",
      "  return (",
      "    !requiresPrimitiveFeatureAttribute ||",
      "    (provenance.compatibilityToken & 1) === 1",
      "  );",
    ].join("\n"),
  );
  const unconditionalSource = replaceFunctionBodyOnce(
    source,
    "featureResourceCompatibilityAllows",
    "  return true;",
  );
  const predicateAnchor = [
    "  const requiresPrimitiveFeatureAttribute =",
    "    provenance.selectedKind === FEATURE_SOURCE_ATTRIBUTE ||",
    "    provenance.selectedKind === FEATURE_SOURCE_IMPLICIT;",
  ].join("\n");
  const predicateSource = replaceOnce(
    source,
    predicateAnchor,
    [
      "  const requiresPrimitiveFeatureAttribute =",
      "    false &&",
      "    (provenance.selectedKind === FEATURE_SOURCE_ATTRIBUTE ||",
      "      provenance.selectedKind === FEATURE_SOURCE_IMPLICIT);",
    ].join("\n"),
    "primitive feature predicate",
  );
  const [absenceModule, unconditionalModule, predicateModule] =
    await Promise.all([
      loadFeatureModule(absenceSource),
      loadFeatureModule(unconditionalSource),
      loadFeatureModule(predicateSource),
    ]);

  for (const mutantModule of [
    absenceModule,
    unconditionalModule,
    predicateModule,
  ]) {
    assert.throws(
      () => assertAttributeSetCompatibility(mutantModule),
      isAssertionErrorWith(
        "attribute selection on a synthesized buffer must fail closed",
      ),
    );
    assert.throws(
      () => assertImplicitBufferCompatibility(mutantModule),
      isAssertionErrorWith("implicit buffer mismatch must fail closed"),
    );
  }
});

test("active pick binds 26, 28, and 31 coherently and decodes the enabled uniform", () => {
  const harness = createHarness();
  const first = harness.ensure(true);
  assert.ok(first);
  assert.equal(
    entry(first.featureIdEntries, 26).resource.texture,
    harness.fallbackTexture,
  );
  assert.notEqual(
    entry(first.featureIdEntries, 28).resource.texture,
    harness.fallbackTexture,
  );
  assert.equal(
    entry(first.featureIdEntries, 31).resource.texture,
    harness.modelCache._featurePickGPUTexture,
  );
  assert.equal(uniformValues(first.featureIdEntries).f32[10], 1);
  assert.equal(harness.state.pickIds.length, 2);
  assert.equal(counters(harness).textures, 2);
  assert.equal(counters(harness).textureWrites, 2);
  assert.equal(counters(harness).bufferWrites, 2);

  const stableCounts = counters(harness);
  const stable = harness.ensure(true);
  assert.equal(stable.featureIdEntries, first.featureIdEntries);
  assert.deepEqual(counters(harness), stableCounts);
});

test("selected source propertyTableId owns styling and pick targets with legacy fallback only when undefined", async () => {
  const source = attributeSource("a", "featureId_0");
  source.propertyTableId = 1;
  const harness = createHarness({ sources: [source], selectedLabel: "a" });
  const legacyTable = harness.model.featureTables[0];
  legacyTable.batchTexture._batchValues.fill(17);
  const selectedBatchTexture = makeBatchTexture("batch-selected", 3);
  selectedBatchTexture._batchValues.fill(41);
  const selectedTable = {
    featuresLength: 3,
    batchTexture: selectedBatchTexture,
    _featureResourceRevision: 0,
  };
  harness.model.featureTables = [legacyTable, selectedTable];
  harness.model.featureTableId = 0;
  const scheduledTextures = [];
  harness.context.scheduleTextureDestroy = (texture) => {
    scheduledTextures.push(texture);
  };

  const selected = harness.ensure(true);
  assert.ok(selected);
  assert.equal(uniformValues(selected.featureIdEntries).i32[0], 3);
  const selectedBatchGPUTexture = entry(selected.featureIdEntries, 28).resource
    .texture;
  assert.deepEqual(
    harness.device.queue.textureWrites.find(
      (write) => write.texture === selectedBatchGPUTexture,
    ).bytes,
    Array.from(selectedBatchTexture._batchValues),
  );
  assert.ok(
    [...harness.modelCache._featurePickIds.values()].every(
      (pickId) => pickId.target.label === "batch-selected",
    ),
  );

  const selectedEntries = selected.featureIdEntries;
  source.propertyTableId = 7;
  source._featureResourceRevision++;
  assert.equal(harness.ensure(false), null);
  assert.equal(harness.primCache._featureIdEntries, selectedEntries);

  source.propertyTableId = undefined;
  source._featureResourceRevision++;
  const fallback = harness.ensure(true);
  assert.ok(fallback);
  assert.equal(uniformValues(fallback.featureIdEntries).i32[0], 2);
  assert.ok(
    [...harness.modelCache._featurePickIds.values()].every(
      (pickId) => pickId.target.label === "batch-a",
    ),
  );
  await settleAcceptedRetirements(harness);
  for (const texture of scheduledTextures) {
    texture.destroy();
  }
});

test("same-kind source replacement rebuilds flags, bindings, and uniforms while alias-only spelling stays stable", async () => {
  const sourceA = textureSource("a", {
    positionalLabel: "featureId_0",
    channels: "r",
    texCoord: 0,
    width: 2,
  });
  const sourceB = textureSource("b", {
    positionalLabel: "featureId_1",
    channels: "rg",
    texCoord: 1,
    width: 3,
  });
  const harness = createHarness({
    sources: [sourceA, sourceB],
    selectedLabel: "a",
  });
  const first = harness.ensure(false);
  const firstEntries = first.featureIdEntries;
  const firstOwned = ownedResources(firstEntries, harness.fallbackTexture);

  harness.model.featureIdLabel = "b";
  const replacement = harness.ensure(false);
  assert.ok(replacement);
  assert.equal(replacement.flags, first.flags);
  assert.notEqual(replacement.featureIdEntries, firstEntries);
  assert.notEqual(
    entry(replacement.featureIdEntries, 26).resource.texture,
    entry(firstEntries, 26).resource.texture,
  );
  assert.notEqual(
    entry(replacement.featureIdEntries, 28).resource.texture,
    entry(firstEntries, 28).resource.texture,
  );
  assert.notEqual(
    entry(replacement.featureIdEntries, 30).resource.buffer,
    entry(firstEntries, 30).resource.buffer,
  );
  assert.equal(uniformValues(replacement.featureIdEntries).i32[1], 2);
  assert.equal(uniformValues(replacement.featureIdEntries).i32[2], 1);
  assertDestroyedExactly(firstOwned, 0);

  const stableCounts = counters(harness);
  harness.model.featureIdLabel = "featureId_1";
  const alias = harness.ensure(false);
  assert.equal(alias.featureIdEntries, replacement.featureIdEntries);
  assert.deepEqual(counters(harness), stableCounts);

  assert.equal(harness.context.enqueueCalls[0].encoder.label, "encoder-a");
  assert.equal(harness.context.wrongSchedulerCalls, 0);
  await settleAcceptedRetirements(harness);
  assertDestroyedExactly(firstOwned, 1);
  assert.equal(harness.fallbackTexture.destroyCalls, 0);
});

test("table, owner, dimensions, step, device, resource generation, and compatibility token cannot hit stale", async () => {
  const harness = createHarness();
  let current = harness.ensure(false);
  let currentEntries = current.featureIdEntries;

  async function replace(mutator, verify) {
    const prior = currentEntries;
    const priorOwned = ownedResources(prior, harness.fallbackTexture);
    mutator();
    current = harness.ensure(false);
    assert.ok(current);
    assert.notEqual(current.featureIdEntries, prior);
    currentEntries = current.featureIdEntries;
    verify?.(current);
    assertDestroyedExactly(priorOwned, 0);
    await settleAcceptedRetirements(harness);
    assertDestroyedExactly(priorOwned, 1);
  }

  await replace(
    () => {
      const batchTexture = makeBatchTexture("batch-table-b", 3);
      harness.model.featureTables = [
        {
          featuresLength: 3,
          batchTexture,
          _featureResourceRevision: 1,
        },
      ];
    },
    (result) => {
      assert.equal(uniformValues(result.featureIdEntries).i32[0], 3);
    },
  );

  await replace(() => {
    harness.batchTexture._owner = makeOwner("owner-c", 3);
  });

  await replace(
    () => {
      const batchTexture = harness.batchTexture;
      batchTexture._textureDimensions = { x: 2, y: 2 };
      batchTexture._textureStep = { x: 0.5, y: 0.25, z: 0.5, w: 0.25 };
      batchTexture._batchValues = new Uint8Array(16).fill(127);
      batchTexture._featureResourceRevision++;
    },
    (result) => {
      const uniform = uniformValues(result.featureIdEntries);
      assert.equal(uniform.i32[3], 1);
      assert.deepEqual(uniform.f32.slice(4, 10), [0.5, 0.25, 0.5, 0.25, 2, 2]);
    },
  );

  const oldQueue = harness.device.queue;
  const oldEncoder = harness.context.currentCommandEncoder;
  await replace(() => {
    harness.replaceDevice();
  });
  assert.equal(harness.context.enqueueCalls.at(-1).encoder, oldEncoder);
  assert.ok(
    oldQueue.fences.length > 0,
    "the retired generation must use its captured old queue",
  );

  await replace(() => {
    harness.context.resourceGeneration++;
  });

  const beforeIncompatible = counters(harness);
  const incompatible = harness.ensure(false, COMPATIBILITY_TOKEN + 1);
  assert.equal(incompatible, null);
  assert.equal(harness.primCache._featureIdEntries, currentEntries);
  assert.deepEqual(counters(harness), beforeIncompatible);
});

test("dense pick generation cannot cross owner, device, or resource-generation transitions", async () => {
  const harness = createHarness();
  const scheduledTextures = [];
  harness.context.scheduleTextureDestroy = (texture) => {
    scheduledTextures.push(texture);
  };
  const first = harness.ensure(true);
  assert.ok(first);
  let previousDenseTexture = harness.modelCache._featurePickGPUTexture;
  let previousPickIds = [...harness.modelCache._featurePickIds.values()];

  harness.batchTexture._owner = makeOwner("owner-b", 2);
  harness.batchTexture._featureResourceRevision++;
  const ownerReplacement = harness.ensure(true);
  assert.ok(ownerReplacement);
  assert.notEqual(
    harness.modelCache._featurePickGPUTexture,
    previousDenseTexture,
  );
  assert.ok(
    [...harness.modelCache._featurePickIds.values()].every(
      (pickId) => pickId.target.label === "owner-b",
    ),
  );
  await settleAcceptedRetirements(harness);
  assert.ok(previousPickIds.every((pickId) => pickId.destroyCalls === 1));
  assert.deepEqual(scheduledTextures, [previousDenseTexture]);
  scheduledTextures.shift().destroy();

  previousDenseTexture = harness.modelCache._featurePickGPUTexture;
  previousPickIds = [...harness.modelCache._featurePickIds.values()];
  harness.replaceDevice();
  const deviceReplacement = harness.ensure(true);
  assert.ok(deviceReplacement);
  assert.notEqual(
    harness.modelCache._featurePickGPUTexture,
    previousDenseTexture,
  );
  assert.equal(
    entry(deviceReplacement.featureIdEntries, 31).resource.texture,
    harness.modelCache._featurePickGPUTexture,
  );
  await settleAcceptedRetirements(harness);
  assert.ok(previousPickIds.every((pickId) => pickId.destroyCalls === 0));
  assert.deepEqual(scheduledTextures, [previousDenseTexture]);
  scheduledTextures.shift().destroy();

  previousDenseTexture = harness.modelCache._featurePickGPUTexture;
  harness.context.resourceGeneration++;
  const generationReplacement = harness.ensure(true);
  assert.ok(generationReplacement);
  assert.notEqual(
    harness.modelCache._featurePickGPUTexture,
    previousDenseTexture,
  );
  assert.equal(
    entry(generationReplacement.featureIdEntries, 31).resource.texture,
    harness.modelCache._featurePickGPUTexture,
  );
  await settleAcceptedRetirements(harness);
  assert.deepEqual(scheduledTextures, [previousDenseTexture]);
  scheduledTextures.shift().destroy();
});

test("dense pick captures scalar dimensions across callbacks before publication", () => {
  const harness = createHarness();
  const cold = harness.ensure(false);
  assert.ok(cold);
  const batchTexture = harness.batchTexture;
  const dimensions = batchTexture._textureDimensions;
  assert.deepEqual([dimensions.x, dimensions.y], [2, 1]);
  let resized = false;
  harness.state.hooks.createPickId = () => {
    if (resized) {
      return;
    }
    resized = true;
    dimensions.x = 3;
    batchTexture._textureStep = {
      x: 1 / 3,
      y: 1 / 6,
      z: 1,
      w: 0.5,
    };
    batchTexture._batchValues = new Uint8Array(12).fill(255);
    batchTexture._featureResourceRevision++;
  };

  const promoted = harness.ensure(true);
  assert.ok(promoted);
  const denseTextures = harness.state.textures.filter((texture) =>
    texture.descriptor.label.startsWith("Feature pick texture"),
  );
  assert.equal(denseTextures.length, 2);
  assert.deepEqual(denseTextures[0].descriptor.size, [2, 1, 1]);
  assert.equal(denseTextures[0].destroyCalls, 1);
  assert.deepEqual(denseTextures[1].descriptor.size, [3, 1, 1]);
  assert.equal(denseTextures[1].destroyCalls, 0);
  assert.equal(
    harness.modelCache._featurePickGeneration.texture,
    denseTextures[1],
  );
  assert.equal(harness.modelCache._featurePickGeneration.width, 3);
  assert.equal(harness.modelCache._featurePickGeneration.height, 1);

  const denseWrites = harness.device.queue.textureWrites.filter((write) =>
    write.texture.descriptor.label.startsWith("Feature pick texture"),
  );
  assert.equal(denseWrites.length, 2);
  assert.equal(denseWrites[0].bytes.length, 8);
  assert.equal(denseWrites[0].layout.bytesPerRow, 8);
  assert.equal(denseWrites[0].size.width, 2);
  assert.equal(denseWrites[1].bytes.length, 12);
  assert.equal(denseWrites[1].layout.bytesPerRow, 12);
  assert.equal(denseWrites[1].size.width, 3);
});

test("dense pick rejects non-integer or undersized extents without replacing the incumbent", () => {
  for (const [width, height] of [
    [1, 1],
    [1.5, 2],
    [-1, 2],
  ]) {
    const harness = createHarness();
    const incumbent = harness.ensure(false);
    const incumbentEntries = incumbent.featureIdEntries;
    harness.batchTexture._textureDimensions = { x: width, y: height };
    harness.batchTexture._textureStep = { x: 1, y: 0.5, z: 1, w: 0.5 };
    const byteLength = Math.max(0, Math.floor(width * height * 4));
    harness.batchTexture._batchValues = new Uint8Array(byteLength).fill(255);
    harness.batchTexture._featureResourceRevision++;

    const invalid = harness.ensure(true);
    assert.equal(invalid, null, `${width}x${height}`);
    assert.equal(harness.primCache._featureIdEntries, incumbentEntries);
    assert.equal(harness.modelCache._featurePickGeneration, undefined);
    assert.equal(
      harness.state.textures.filter((texture) =>
        texture.descriptor.label.startsWith("Feature pick texture"),
      ).length,
      0,
    );
  }
});

test("dense pick cache and ID reuse require the exact createPickId factory", async () => {
  const harness = createHarness();
  const scheduledTextures = [];
  harness.context.scheduleTextureDestroy = (texture) => {
    scheduledTextures.push(texture);
  };
  const initial = harness.ensure(true);
  assert.ok(initial);
  const previousGeneration = harness.modelCache._featurePickGeneration;
  const previousPickIds = [...previousGeneration.pickIds.values()];
  const originalCreatePickId = harness.context.createPickId;
  let replacementFactoryCalls = 0;
  harness.context.createPickId = function (target, kind) {
    replacementFactoryCalls++;
    const pickId = originalCreatePickId.call(this, target, kind);
    pickId.factory = "replacement";
    return pickId;
  };

  const replacement = harness.ensure(true);
  assert.ok(replacement);
  const nextGeneration = harness.modelCache._featurePickGeneration;
  assert.notEqual(nextGeneration, previousGeneration);
  assert.notEqual(nextGeneration.texture, previousGeneration.texture);
  assert.equal(replacementFactoryCalls, 2);
  assert.ok(
    [...nextGeneration.pickIds.values()].every(
      (pickId) => pickId.factory === "replacement",
    ),
  );
  await settleAcceptedRetirements(harness);
  assert.ok(previousPickIds.every((pickId) => pickId.destroyCalls === 1));
  assert.deepEqual(scheduledTextures, [previousGeneration.texture]);
  scheduledTextures[0].destroy();
});

test("in-place content revision uploads once and remains retryable after a failed write with dirty false", () => {
  const harness = createHarness();
  const initial = harness.ensure(false);
  const entries = initial.featureIdEntries;
  const batchTexture = harness.batchTexture;
  const batchGPUTexture = entry(entries, 28).resource.texture;

  const beforeSuccess = counters(harness);
  batchTexture.setShow(0, false);
  assert.equal(batchTexture._featureResourceRevision, 1);
  const refreshed = harness.ensure(false);
  assert.equal(refreshed.featureIdEntries, entries);
  assert.equal(
    counters(harness).textureWrites,
    beforeSuccess.textureWrites + 1,
  );
  assert.equal(counters(harness).textures, beforeSuccess.textures);
  assert.equal(counters(harness).buffers, beforeSuccess.buffers);
  assert.equal(
    harness.device.queue.textureWrites.at(-1).texture,
    batchGPUTexture,
  );
  assert.equal(batchTexture._batchValuesDirty, false);

  batchTexture.setShow(0, true);
  assert.equal(batchTexture._featureResourceRevision, 2);
  harness.state.failures.writeTexture = {
    prefix: "Batch texture",
    count: 1,
  };
  const failed = harness.ensure(false);
  assert.equal(failed, null);
  assert.equal(harness.primCache._featureIdEntries, entries);

  batchTexture._batchValuesDirty = false;
  const beforeRetry = counters(harness);
  const retry = harness.ensure(false);
  assert.equal(retry.featureIdEntries, entries);
  assert.equal(counters(harness).textureWrites, beforeRetry.textureWrites + 1);
  assert.equal(
    harness.device.queue.textureWrites.at(-1).texture,
    batchGPUTexture,
  );

  const replacementValues = new Uint8Array(batchTexture._batchValues.length);
  replacementValues.fill(93);
  batchTexture._batchValues = replacementValues;
  batchTexture._batchValuesDirty = false;
  batchTexture._featureResourceRevision++;
  const beforeArrayReplacement = counters(harness);
  const arrayReplacement = harness.ensure(false);
  assert.equal(arrayReplacement.featureIdEntries, entries);
  assert.equal(
    counters(harness).textureWrites,
    beforeArrayReplacement.textureWrites + 1,
  );
  assert.deepEqual(
    harness.device.queue.textureWrites.at(-1).bytes,
    Array.from(replacementValues),
  );
});

test("retained batch upload reentry cannot certify stale outer bytes as the nested revision", () => {
  const harness = createHarness();
  const initial = harness.ensure(false);
  const entries = initial.featureIdEntries;
  const batchTexture = harness.batchTexture;
  const batchGPUTexture = entry(entries, 28).resource.texture;
  const outerValues = new Uint8Array(batchTexture._batchValues.length).fill(31);
  const nestedValues = new Uint8Array(batchTexture._batchValues.length).fill(
    197,
  );
  batchTexture._batchValues = outerValues;
  batchTexture._batchValuesDirty = true;
  batchTexture._featureResourceRevision = 1;
  let nested;
  let reentered = false;
  harness.state.hooks.writeTexture = (texture) => {
    if (texture !== batchGPUTexture || reentered) {
      return;
    }
    reentered = true;
    batchTexture._batchValues = nestedValues;
    batchTexture._batchValuesDirty = true;
    batchTexture._featureResourceRevision = 2;
    nested = harness.ensure(false);
  };

  const outer = harness.ensure(false);
  assert.ok(nested);
  assert.ok(outer);
  assert.equal(outer.featureIdEntries, entries);
  assert.equal(
    harness.primCache._featureIdGeneration.provenance.batchContentRevision,
    2,
  );
  const writes = harness.device.queue.textureWrites.filter(
    (write) => write.texture === batchGPUTexture,
  );
  assert.ok(writes.length >= 3);
  assert.deepEqual(writes.at(-1).bytes, Array.from(nestedValues));
  assert.equal(batchTexture._batchValuesDirty, false);
});

test("captured dirty clearing preserves newer candidate and retained batch edits", () => {
  assertCapturedBatchDirtyGuard(featureModule, false);
  assertCapturedBatchDirtyGuard(featureModule, true);
});

test("captured dirty-guard absence and inertness mutants clear newer bytes", async () => {
  const source = (await readFile(FEATURE_MODULE_PATH, "utf8")).replace(
    /\r\n/g,
    "\n",
  );
  const guardAnchor = [
    "    if (",
    "      batchTexture._featureResourceRevision ===",
    "        provenance.batchContentRevision &&",
    "      batchTexture._batchValues === provenance.batchValues",
    "    ) {",
    "      batchTexture._batchValuesDirty = false;",
    "    }",
  ].join("\n");
  const absenceSource = replaceOnce(
    source,
    guardAnchor,
    "    batchTexture._batchValuesDirty = false;",
    "captured dirty guard absence",
  );
  const inertnessSource = replaceOnce(
    source,
    guardAnchor,
    [
      "    if (true) {",
      "      batchTexture._batchValuesDirty = false;",
      "    }",
    ].join("\n"),
    "captured dirty guard inertness",
  );
  const [absenceModule, inertnessModule] = await Promise.all([
    loadFeatureModule(absenceSource),
    loadFeatureModule(inertnessSource),
  ]);

  for (const mutantModule of [absenceModule, inertnessModule]) {
    for (const retained of [false, true]) {
      assert.throws(
        () => assertCapturedBatchDirtyGuard(mutantModule, retained),
        isAssertionErrorWith("newer batch bytes must remain dirty"),
      );
    }
  }
});

test("layout changes recreate and upload resized batch values in the same update", () => {
  assertBatchTextureLayoutRebuild(TestBatchTexture);
});

test("layout dirty-marking absence and inertness mutants lose same-update recreation", async () => {
  const source = (await readFile(BATCH_TEXTURE_PATH, "utf8")).replace(
    /\r\n/g,
    "\n",
  );
  const callAnchor = [
    "  markFeatureResourcesChanged(",
    "    batchTexture,",
    "    resizeBatchValues || (recreateBatchTexture && defined(oldValues)),",
    "  );",
  ].join("\n");
  const absenceSource = replaceOnce(
    source,
    callAnchor,
    "",
    "layout dirty-marking absence",
  );
  const inertnessSource = replaceOnce(
    source,
    callAnchor,
    [
      "  markFeatureResourcesChanged(",
      "    batchTexture,",
      "    false &&",
      "      (resizeBatchValues ||",
      "        (recreateBatchTexture && defined(oldValues))),",
      "  );",
    ].join("\n"),
    "layout dirty-marking inertness",
  );
  const [absenceModule, inertnessModule] = await Promise.all([
    loadBatchTextureModule(absenceSource),
    loadBatchTextureModule(inertnessSource),
  ]);

  for (const mutantModule of [absenceModule, inertnessModule]) {
    assert.throws(
      () => assertBatchTextureLayoutRebuild(mutantModule.TestBatchTexture),
      isAssertionErrorWith(
        "layout change must recreate the batch texture in the same update",
      ),
    );
  }
});

test("WebGL batch upload failure keeps dirty state and retries the existing texture exactly once", () => {
  const batchTexture = makeBatchTexture("webgl-retry", 1);
  const frameState = makeBatchTextureFrameState();
  batchTexture.update(undefined, frameState, false);

  const uploads = [];
  const texture = {
    copyCalls: 0,
    copyFrom({ source }) {
      this.copyCalls++;
      uploads.push(Array.from(source.arrayBufferView));
      if (this.copyCalls === 1) {
        throw new Error("copy failed");
      }
    },
  };
  batchTexture._batchTexture = texture;
  batchTexture.setShow(0, false);

  assert.throws(
    () => batchTexture.update(undefined, frameState, false),
    /copy failed/,
  );
  assert.equal(texture.copyCalls, 1);
  assert.equal(batchTexture._batchTexture, texture);
  assert.equal(batchTexture._batchValuesDirty, true);

  batchTexture.update(undefined, frameState, false);
  assert.equal(texture.copyCalls, 2);
  assert.equal(batchTexture._batchValuesDirty, false);
  assert.equal(uploads.at(-1)[3], 0);

  batchTexture.update(undefined, frameState, false);
  assert.equal(texture.copyCalls, 2);
});

test("WebGL batch upload clears dirty only when show/color revision and value-array identity remain exact", () => {
  for (const mutation of ["show", "color", "values"]) {
    const batchTexture = makeBatchTexture(`webgl-reentry-${mutation}`, 1);
    const frameState = makeBatchTextureFrameState();
    batchTexture.update(undefined, frameState, false);

    const uploads = [];
    let mutateDuringFirstCopy = true;
    const texture = {
      copyCalls: 0,
      copyFrom({ source }) {
        this.copyCalls++;
        uploads.push(Array.from(source.arrayBufferView));
        if (!mutateDuringFirstCopy) {
          return;
        }
        mutateDuringFirstCopy = false;
        if (mutation === "show") {
          batchTexture.setShow(0, true);
        } else if (mutation === "color") {
          batchTexture.setColor(0, Color.YELLOW);
        } else {
          batchTexture._batchValues = new Uint8Array(
            source.arrayBufferView.length,
          ).fill(73);
          batchTexture._batchValuesDirty = true;
        }
      },
    };
    batchTexture._batchTexture = texture;
    batchTexture.setShow(0, false);
    const revisionBeforeUpload = batchTexture._featureResourceRevision;

    batchTexture.update(undefined, frameState, false);
    assert.equal(texture.copyCalls, 1, mutation);
    assert.equal(batchTexture._batchValuesDirty, true, mutation);
    if (mutation !== "values") {
      assert.equal(
        batchTexture._featureResourceRevision,
        revisionBeforeUpload + 1,
      );
    } else {
      assert.equal(batchTexture._featureResourceRevision, revisionBeforeUpload);
    }

    batchTexture.update(undefined, frameState, false);
    assert.equal(texture.copyCalls, 2, mutation);
    assert.equal(batchTexture._batchValuesDirty, false, mutation);
    assert.deepEqual(
      uploads.at(-1),
      Array.from(batchTexture._batchValues),
      mutation,
    );

    batchTexture.update(undefined, frameState, false);
    assert.equal(texture.copyCalls, 2, mutation);
  }
});

test("WebGL batch texture creation failure remains dirty and retries one clean owner", () => {
  const control = makeBatchTextureControl({ failCreateCount: 1 });
  const { batchTexture, frameState, statistics } = makeInstrumentedBatchTexture(
    "webgl-create-retry",
    control,
  );
  batchTexture.setShow(0, false);

  assert.throws(
    () => batchTexture.update(undefined, frameState, false),
    /instrumented texture creation failed/,
  );
  assert.equal(control.createCalls, 1);
  assert.equal(control.copyCalls, 0);
  assert.equal(control.textures.length, 0);
  assert.equal(batchTexture._batchTexture, undefined);
  assert.equal(batchTexture._batchValuesDirty, true);
  assert.equal(statistics.batchTableByteLength, 0);

  batchTexture.update(undefined, frameState, false);
  assert.equal(control.createCalls, 2);
  assert.equal(control.copyCalls, 1);
  assert.equal(control.textures.length, 1);
  assert.equal(batchTexture._batchTexture, control.textures[0]);
  assert.equal(batchTexture._batchValuesDirty, false);
  assert.equal(statistics.batchTableByteLength, 4);
  assert.deepEqual(control.textures[0].initialBytes, [255, 255, 255, 0]);
  assert.deepEqual(control.copySources.at(-1), [255, 255, 255, 0]);

  batchTexture.update(undefined, frameState, false);
  assert.equal(control.createCalls, 2);
  assert.equal(control.copyCalls, 1);
  assert.equal(statistics.batchTableByteLength, 4);
});

test("WebGL retains a newly created texture and statistics across copy failure", () => {
  const control = makeBatchTextureControl({ failCopyCount: 1 });
  const { batchTexture, frameState, statistics } = makeInstrumentedBatchTexture(
    "webgl-created-copy-retry",
    control,
  );
  batchTexture.setShow(0, false);

  assert.throws(
    () => batchTexture.update(undefined, frameState, false),
    /instrumented texture copy failed/,
  );
  const createdTexture = control.textures[0];
  assert.ok(createdTexture);
  assert.equal(control.createCalls, 1);
  assert.equal(control.copyCalls, 1);
  assert.equal(createdTexture.copyCalls, 1);
  assert.equal(batchTexture._batchTexture, createdTexture);
  assert.equal(batchTexture._batchValuesDirty, true);
  assert.equal(statistics.batchTableByteLength, 4);

  batchTexture.update(undefined, frameState, false);
  assert.equal(control.createCalls, 1);
  assert.equal(control.copyCalls, 2);
  assert.equal(createdTexture.copyCalls, 2);
  assert.equal(batchTexture._batchTexture, createdTexture);
  assert.equal(batchTexture._batchValuesDirty, false);
  assert.equal(statistics.batchTableByteLength, 4);
  assert.deepEqual(control.copySources.at(-1), [255, 255, 255, 0]);

  batchTexture.update(undefined, frameState, false);
  assert.equal(control.createCalls, 1);
  assert.equal(control.copyCalls, 2);
  assert.equal(statistics.batchTableByteLength, 4);
});

function batchTextureRetryContract(source) {
  const updateStart = source.indexOf(
    "  update(tileset, frameState, legacyPickTextureDemand) {",
  );
  assert.notEqual(updateStart, -1);
  const updateEnd = source.indexOf("\n  /**", updateStart + 1);
  assert.ok(updateEnd > updateStart);
  const update = source.slice(updateStart, updateEnd);
  const dirtyBranchIndex = update.indexOf("if (this._batchValuesDirty) {");
  const valuesIndex = update.indexOf("const batchValues = this._batchValues;");
  const revisionIndex = update.indexOf(
    "const featureResourceRevision = this._featureResourceRevision;",
  );
  const successInitIndex = update.indexOf("let uploadSucceeded = false;");
  const tryIndex = update.indexOf("try {", successInitIndex);
  const createIndex = update.indexOf(
    "this._batchTexture = createTexture(this, context, batchValues);",
  );
  const copyIndex = update.indexOf("updateBatchTexture(this);");
  const successIndex = update.indexOf("uploadSucceeded = true;");
  const finallyIndex = update.indexOf("} finally {", successIndex);
  const dirtyCommitIndex = update.indexOf(
    "this._batchValuesDirty =",
    finallyIndex,
  );
  assert.ok(dirtyBranchIndex >= 0);
  assert.ok(valuesIndex > dirtyBranchIndex);
  assert.ok(revisionIndex > valuesIndex);
  assert.ok(successInitIndex > revisionIndex);
  assert.ok(tryIndex > successInitIndex);
  assert.ok(createIndex > tryIndex);
  assert.ok(copyIndex > createIndex);
  assert.ok(successIndex > copyIndex);
  assert.ok(finallyIndex > successIndex);
  assert.ok(dirtyCommitIndex > finallyIndex);
  assert.match(
    update,
    /this\._batchValuesDirty =\s*!uploadSucceeded \|\|\s*this\._batchValues !== batchValues \|\|\s*this\._featureResourceRevision !== featureResourceRevision;/,
  );
  assert.doesNotMatch(
    update.slice(dirtyBranchIndex, tryIndex),
    /this\._batchValuesDirty\s*=\s*false;/,
  );
}

test("WebGL dirty policy rejects early-clear and unconditional-postcopy mutants", async () => {
  const source = (
    await readFile(resolve(ENGINE_SOURCE, "Scene/BatchTexture.js"), "utf8")
  ).replace(/\r\n/g, "\n");
  batchTextureRetryContract(source);

  const earlyClearMutant = source.replace("!uploadSucceeded ||", "false ||");
  assert.notEqual(earlyClearMutant, source);
  assert.throws(() => batchTextureRetryContract(earlyClearMutant));

  const exactCommit = [
    "this._batchValuesDirty =",
    "          !uploadSucceeded ||",
    "          this._batchValues !== batchValues ||",
    "          this._featureResourceRevision !== featureResourceRevision;",
  ].join("\n");
  const unconditionalPostCopyMutant = source.replace(
    exactCommit,
    "this._batchValuesDirty = false;",
  );
  assert.notEqual(unconditionalPostCopyMutant, source);
  assert.throws(() => batchTextureRetryContract(unconditionalPostCopyMutant));
});

const REQUIRED_FAILURES = [
  ["feature upload", "copyExternalImage", undefined],
  ["batch upload", "writeTexture", "Batch texture"],
  ["buffer create", "createBuffer", "Feature ID uniforms"],
  ["uniform write", "writeBuffer", "Feature ID uniforms:0"],
  ["feature view", "createView", "FeatureId texture"],
  ["batch view", "createView", "Batch texture"],
];

test("required texture, upload, buffer, uniform, and view failures publish nothing and leak nothing", () => {
  for (const [name, kind, prefix] of REQUIRED_FAILURES) {
    const source = textureSource("a", { positionalLabel: "featureId_0" });
    const harness = createHarness({ sources: [source], selectedLabel: "a" });
    harness.state.failures[kind] = { prefix, count: 1 };
    const failed = harness.ensure(false);
    assert.equal(failed, null, `${name} must fail closed`);
    assert.equal(harness.primCache._featureIdEntries, undefined);
    assert.equal(harness.primCache._featureIdFlags, undefined);
    assert.equal(harness.context.enqueueCalls.length, 0);
    assertDestroyedExactly(harness.state.textures, 1);
    assertDestroyedExactly(harness.state.buffers, 1);
    assert.equal(harness.fallbackTexture.destroyCalls, 0);

    const retry = harness.ensure(false);
    assert.ok(retry, `${name} must remain retryable`);
  }
});

test("partial candidate cleanup calls a throwing provisional texture destroy only once", () => {
  const source = textureSource("a", { positionalLabel: "featureId_0" });
  const harness = createHarness({ sources: [source], selectedLabel: "a" });
  let provisionalFeatureTexture;
  harness.state.hooks.textureCreated = (texture) => {
    if (texture.descriptor.label.startsWith("FeatureId texture")) {
      provisionalFeatureTexture = texture;
      texture.throwOnDestroy = true;
    }
  };
  harness.state.failures.writeTexture = {
    prefix: "Batch texture",
    count: 1,
  };

  const failed = harness.ensure(false);
  assert.equal(failed, null);
  assert.ok(provisionalFeatureTexture);
  assert.equal(provisionalFeatureTexture.destroyCalls, 1);
  assert.equal(harness.primCache._featureIdEntries, undefined);

  harness.state.hooks.textureCreated = undefined;
  const retry = harness.ensure(false);
  assert.ok(retry);
});

test("replacement failures preserve the exact incumbent and drain only provisional owners", () => {
  for (const [name, kind, prefix] of REQUIRED_FAILURES) {
    const sourceA = textureSource("a", {
      positionalLabel: "featureId_0",
      width: 2,
    });
    const sourceB = textureSource("b", {
      positionalLabel: "featureId_1",
      width: 3,
    });
    const harness = createHarness({
      sources: [sourceA, sourceB],
      selectedLabel: "a",
    });
    const initial = harness.ensure(false);
    const incumbent = initial.featureIdEntries;
    const incumbentOwned = ownedResources(incumbent, harness.fallbackTexture);
    const textureStart = harness.state.textures.length;
    const bufferStart = harness.state.buffers.length;
    harness.model.featureIdLabel = "b";
    harness.state.failures[kind] = { prefix, count: 1 };

    const failed = harness.ensure(false);
    assert.equal(failed, null, `${name} replacement must fail closed`);
    assert.equal(harness.primCache._featureIdEntries, incumbent);
    assertDestroyedExactly(incumbentOwned, 0);
    assertDestroyedExactly(harness.state.textures.slice(textureStart), 1);
    assertDestroyedExactly(harness.state.buffers.slice(bufferStart), 1);
    assert.equal(harness.context.enqueueCalls.length, 0);

    const retry = harness.ensure(false);
    assert.ok(retry, `${name} replacement must remain retryable`);
    assert.notEqual(retry.featureIdEntries, incumbent);
  }
});

test("unavailable selected texture fails closed, ready recovery publishes, and borrowed native texture is never destroyed", async () => {
  const source = textureSource("a", {
    positionalLabel: "featureId_0",
    ready: false,
  });
  const harness = createHarness({ sources: [source], selectedLabel: "a" });
  assert.equal(harness.ensure(false), null);
  assert.equal(harness.primCache._featureIdEntries, undefined);

  source.textureReader.texture._source = {
    label: "ready",
    width: 2,
    height: 2,
  };
  source._featureResourceRevision++;
  const ready = harness.ensure(false);
  assert.ok(ready);
  const readyEntries = ready.featureIdEntries;
  const ownedFeatureTexture = entry(readyEntries, 26).resource.texture;

  const borrowed = new FakeTexture(
    harness.state,
    { label: "stub-owned native" },
    true,
  );
  const borrowedRealization = { texture: borrowed };
  source.textureReader.texture = {
    _texture: {
      _getWebGPUTextureForDevice(device, resourceGeneration) {
        assert.equal(device, harness.device);
        assert.equal(resourceGeneration, harness.context.resourceGeneration);
        return borrowedRealization;
      },
    },
  };
  source._featureResourceRevision++;
  const borrowedResult = harness.ensure(false);
  assert.ok(borrowedResult);
  assert.equal(
    entry(borrowedResult.featureIdEntries, 26).resource.texture,
    borrowed,
  );
  await settleAcceptedRetirements(harness);
  assert.equal(ownedFeatureTexture.destroyCalls, 1);

  destroyFeatureIdResources(harness.primCache);
  assert.equal(borrowed.destroyCalls, 0);
  assert.equal(harness.fallbackTexture.destroyCalls, 0);
});

test("nested A to B publication cannot be overwritten by the outer candidate", async () => {
  const sourceA = textureSource("a", {
    positionalLabel: "featureId_0",
    channels: "r",
    width: 2,
  });
  const sourceB = textureSource("b", {
    positionalLabel: "featureId_1",
    channels: "rgba",
    texCoord: 1,
    width: 4,
  });
  const harness = createHarness({
    sources: [sourceA, sourceB],
    selectedLabel: "a",
  });
  let nested;
  harness.state.hooks.createBuffer = () => {
    harness.state.hooks.createBuffer = undefined;
    harness.model.featureIdLabel = "b";
    nested = harness.ensure(false);
  };

  const outer = harness.ensure(false);
  assert.ok(nested);
  assert.ok(outer);
  assert.equal(outer.featureIdEntries, harness.primCache._featureIdEntries);
  assert.equal(uniformValues(outer.featureIdEntries).i32[1], 4);
  assert.equal(uniformValues(outer.featureIdEntries).i32[2], 1);
  assert.equal(
    entry(outer.featureIdEntries, 26).resource.texture.descriptor.size[0],
    4,
  );
  assert.equal(harness.model.featureIdLabel, "b");
  assert.ok(
    [...harness.state.textures, ...harness.state.buffers].some(
      (resource) => resource.destroyCalls === 1,
    ),
  );
  await settleAcceptedRetirements(harness);
});

test("getter re-entry that publishes B makes the outer A observation stale", async () => {
  const sourceA = textureSource("a", {
    positionalLabel: "featureId_0",
    channels: "r",
    width: 2,
  });
  const sourceB = textureSource("b", {
    positionalLabel: "featureId_1",
    channels: "rgb",
    texCoord: 1,
    width: 3,
  });
  const harness = createHarness({
    sources: [sourceA, sourceB],
    selectedLabel: "a",
  });
  let nested;
  let reentered = false;
  Object.defineProperty(harness.model, "featureIdLabel", {
    configurable: true,
    get() {
      if (!reentered) {
        reentered = true;
        Object.defineProperty(harness.model, "featureIdLabel", {
          configurable: true,
          writable: true,
          value: "b",
        });
        nested = harness.ensure(false);
        return "a";
      }
      return "b";
    },
  });

  const outer = harness.ensure(false);
  assert.ok(nested);
  assert.ok(outer);
  assert.equal(outer.featureIdEntries, harness.primCache._featureIdEntries);
  assert.equal(uniformValues(outer.featureIdEntries).i32[1], 3);
  assert.equal(uniformValues(outer.featureIdEntries).i32[2], 1);
  assert.equal(harness.model.featureIdLabel, "b");
  await settleAcceptedRetirements(harness);
});

test("dense-pick candidate reentry cannot overwrite a nested newer owner generation", async () => {
  const harness = createHarness();
  const ownerB = makeOwner("owner-b", 2);
  const scheduledTextures = [];
  harness.context.scheduleTextureDestroy = (texture) => {
    scheduledTextures.push(texture);
  };
  let nested;
  let reentered = false;
  harness.state.hooks.createPickId = () => {
    if (reentered) {
      return;
    }
    reentered = true;
    harness.state.hooks.createPickId = undefined;
    harness.batchTexture._owner = ownerB;
    harness.batchTexture._featureResourceRevision++;
    nested = harness.ensure(true);
  };

  const outer = harness.ensure(true);
  assert.ok(nested);
  assert.ok(outer);
  assert.equal(outer.featureIdEntries, harness.primCache._featureIdEntries);
  assert.equal(
    entry(outer.featureIdEntries, 31).resource.texture,
    harness.modelCache._featurePickGPUTexture,
  );
  assert.ok(
    [...harness.modelCache._featurePickIds.values()].every(
      (pickId) => pickId.target.label === "owner-b",
    ),
  );
  assert.ok(
    harness.state.pickIds
      .filter((pickId) => pickId.target.label === "batch-a")
      .every((pickId) => pickId.destroyCalls === 1),
  );
  const denseTextures = harness.state.textures.filter((texture) =>
    texture.descriptor.label.startsWith("Feature pick texture"),
  );
  const losingDenseTextures = denseTextures.filter(
    (texture) => texture !== harness.modelCache._featurePickGPUTexture,
  );
  assert.equal(losingDenseTextures.length, 1);
  assert.equal(losingDenseTextures[0].destroyCalls, 1);
  assert.equal(harness.modelCache._featurePickGPUTexture.destroyCalls, 0);
  await settleAcceptedRetirements(harness);
  for (const texture of scheduledTextures) {
    texture.destroy();
  }
});

test("primitive promotion reentry cannot overwrite nested source entries or split generation aliases", async () => {
  for (const boundary of ["createView", "writeBuffer"]) {
    const sourceA = textureSource("a", {
      positionalLabel: "featureId_0",
      channels: "r",
      width: 2,
    });
    const sourceB = textureSource("b", {
      positionalLabel: "featureId_1",
      channels: "rgb",
      texCoord: 1,
      width: 3,
    });
    const harness = createHarness({
      sources: [sourceA, sourceB],
      selectedLabel: "a",
    });
    harness.context.scheduleTextureDestroy = () => {};
    const cold = harness.ensure(false);
    assert.ok(cold);
    let nested;
    let reentered = false;
    const reenter = () => {
      if (reentered) {
        return;
      }
      reentered = true;
      harness.state.hooks.createView = undefined;
      harness.state.hooks.writeBuffer = undefined;
      harness.model.featureIdLabel = "b";
      nested = harness.ensure(true);
    };
    if (boundary === "createView") {
      harness.state.hooks.createView = (texture) => {
        if (texture.descriptor.label.startsWith("Feature pick texture")) {
          reenter();
        }
      };
    } else {
      harness.state.hooks.writeBuffer = (...args) => {
        if (args[1] === FEATURE_PICK_ENABLED_OFFSET) {
          reenter();
        }
      };
    }

    const outer = harness.ensure(true);
    assert.ok(nested, boundary);
    assert.ok(outer, boundary);
    assert.equal(
      outer.featureIdEntries,
      harness.primCache._featureIdEntries,
      boundary,
    );
    assert.equal(
      harness.primCache._featureIdGeneration.entries,
      harness.primCache._featureIdEntries,
      boundary,
    );
    assert.equal(uniformValues(outer.featureIdEntries).i32[1], 3, boundary);
    assert.equal(uniformValues(outer.featureIdEntries).i32[2], 1, boundary);
    assert.equal(
      entry(outer.featureIdEntries, 26).resource.texture.descriptor.size[0],
      3,
      boundary,
    );
    assert.equal(
      entry(outer.featureIdEntries, 31).resource.texture,
      harness.modelCache._featurePickGPUTexture,
      boundary,
    );
    const stableCounts = counters(harness);
    const stable = harness.ensure(true);
    assert.equal(stable.featureIdEntries, outer.featureIdEntries, boundary);
    assert.deepEqual(counters(harness), stableCounts, boundary);
    await settleAcceptedRetirements(harness);
  }
});

test("one primitive promotion cannot mutate or retire its sibling generation", async () => {
  const sourceA = textureSource("a", {
    positionalLabel: "featureId_0",
    width: 2,
  });
  const sourceB = textureSource("b", {
    positionalLabel: "featureId_1",
    width: 3,
  });
  const harness = createHarness({
    sources: [sourceA, sourceB],
    selectedLabel: "a",
  });
  const siblingCache = {};
  harness.modelCache.primitives.p1 = siblingCache;
  const first = harness.ensure(false);
  const sibling = harness.ensureFor(siblingCache, false);
  const siblingEntries = sibling.featureIdEntries;
  const siblingOwned = ownedResources(siblingEntries, harness.fallbackTexture);

  harness.model.featureIdLabel = "b";
  const replacement = harness.ensure(false);
  assert.notEqual(replacement.featureIdEntries, first.featureIdEntries);
  assert.equal(siblingCache._featureIdEntries, siblingEntries);
  assertDestroyedExactly(siblingOwned, 0);
  await settleAcceptedRetirements(harness);
  assertDestroyedExactly(siblingOwned, 0);

  const siblingReplacement = harness.ensureFor(siblingCache, false);
  assert.notEqual(siblingReplacement.featureIdEntries, siblingEntries);
  await settleAcceptedRetirements(harness);
  assertDestroyedExactly(siblingOwned, 1);
});

test("one four-attempt budget bounds post-upload instability and the next stable call recovers", () => {
  const sourceA = attributeSource("a", "featureId_0");
  const sourceB = attributeSource("b", "featureId_1");
  const harness = createHarness({
    sources: [sourceA, sourceB],
    selectedLabel: "a",
  });
  const incumbent = harness.ensure(false);
  const incumbentEntries = incumbent.featureIdEntries;
  harness.model.featureIdLabel = "b";
  const textureStart = harness.state.textures.length;
  const bufferStart = harness.state.buffers.length;
  const textureWriteStart = counters(harness).textureWrites;
  const bufferWriteStart = counters(harness).bufferWrites;
  harness.state.hooks.createBuffer = () => {
    sourceB._featureResourceRevision++;
  };

  const exhausted = harness.ensure(false);
  assert.equal(exhausted, null);
  assert.equal(harness.primCache._featureIdEntries, incumbentEntries);
  assert.equal(harness.state.textures.length - textureStart, 4);
  assert.equal(harness.state.buffers.length - bufferStart, 4);
  assert.equal(counters(harness).textureWrites - textureWriteStart, 4);
  assert.equal(counters(harness).bufferWrites - bufferWriteStart, 4);
  assertDestroyedExactly(harness.state.textures.slice(textureStart), 1);
  assertDestroyedExactly(harness.state.buffers.slice(bufferStart), 1);

  harness.state.hooks.createBuffer = undefined;
  const recovered = harness.ensure(false);
  assert.ok(recovered);
  assert.notEqual(recovered.featureIdEntries, incumbentEntries);
});

for (const mode of [
  "false",
  "throw",
  "callback-then-false",
  "callback-then-throw",
]) {
  test(`retirement enlistment ${mode} remains node-owned and retries without rebuilding`, async () => {
    const sourceA = textureSource("a", {
      positionalLabel: "featureId_0",
      width: 2,
    });
    const sourceB = textureSource("b", {
      positionalLabel: "featureId_1",
      width: 3,
    });
    const harness = createHarness({
      sources: [sourceA, sourceB],
      selectedLabel: "a",
    });
    const initial = harness.ensure(false);
    const oldOwned = ownedResources(
      initial.featureIdEntries,
      harness.fallbackTexture,
    );
    harness.model.featureIdLabel = "b";
    harness.context.enqueueMode = mode;
    const replacement = harness.ensure(false);
    assert.ok(replacement);
    assertDestroyedExactly(oldOwned, 0);
    assert.equal(counters(harness).fences, 0);
    const afterBuild = counters(harness);

    harness.context.enqueueMode = "accept";
    const retry = harness.ensure(false);
    assert.equal(retry.featureIdEntries, replacement.featureIdEntries);
    assert.equal(counters(harness).textures, afterBuild.textures);
    assert.equal(counters(harness).buffers, afterBuild.buffers);
    assert.equal(harness.context.wrongSchedulerCalls, 0);
    await settleAcceptedRetirements(harness);
    assertDestroyedExactly(oldOwned, 1);
  });
}

test("callback-before-return waits for one fence; resolution destroys once and rejection never calls a lost device", async () => {
  for (const reject of [false, true]) {
    const sourceA = textureSource("a", {
      positionalLabel: "featureId_0",
      width: 2,
    });
    const sourceB = textureSource("b", {
      positionalLabel: "featureId_1",
      width: 3,
    });
    const harness = createHarness({
      sources: [sourceA, sourceB],
      selectedLabel: "a",
    });
    const initial = harness.ensure(false);
    const oldOwned = ownedResources(
      initial.featureIdEntries,
      harness.fallbackTexture,
    );
    harness.model.featureIdLabel = "b";
    harness.context.enqueueMode = "callback-then-accept";
    const replacement = harness.ensure(false);
    assert.ok(replacement);
    assert.equal(counters(harness).fences, 1);
    assertDestroyedExactly(oldOwned, 0);
    await settleAcceptedRetirements(harness, reject);
    assertDestroyedExactly(oldOwned, reject ? 0 : 1);
    assert.equal(counters(harness).fences, 1);
  }
});

test("teardown tombstones and drains current plus node-owned retired resources exactly once", () => {
  const sourceA = textureSource("a", {
    positionalLabel: "featureId_0",
    width: 2,
  });
  const sourceB = textureSource("b", {
    positionalLabel: "featureId_1",
    width: 3,
  });
  const harness = createHarness({
    sources: [sourceA, sourceB],
    selectedLabel: "a",
  });
  const initial = harness.ensure(false);
  const oldOwned = ownedResources(
    initial.featureIdEntries,
    harness.fallbackTexture,
  );
  harness.model.featureIdLabel = "b";
  harness.context.enqueueMode = "false";
  const replacement = harness.ensure(false);
  const newOwned = ownedResources(
    replacement.featureIdEntries,
    harness.fallbackTexture,
  );

  destroyFeatureIdResources(harness.primCache);
  destroyFeatureIdResources(harness.primCache);
  assertDestroyedExactly(oldOwned, 1);
  assertDestroyedExactly(newOwned, 1);
  assert.equal(harness.fallbackTexture.destroyCalls, 0);
  assert.equal(harness.ensure(false), null);
});

test("instance selection wins over primitive selection and semantic none retires without fabricating a result", async () => {
  const primitiveTexture = textureSource("primitive", {
    positionalLabel: "featureId_0",
  });
  const instanceAttribute = attributeSource("instance", "instanceFeatureId_0");
  const harness = createHarness({
    sources: [primitiveTexture],
    selectedLabel: "primitive",
  });
  harness.runtimeNode.node = {
    instances: {
      featureIds: [instanceAttribute],
      _featureResourceRevision: 0,
    },
  };
  harness.model.instanceFeatureIdLabel = "instance";
  const instanceResult = harness.ensure(false);
  assert.equal(instanceResult.flags, FLAG_FEATURE_ATTRIBUTE | FLAG_BATCH_TABLE);
  assert.equal(
    entry(instanceResult.featureIdEntries, 26).resource.texture,
    harness.fallbackTexture,
  );

  harness.model.instanceFeatureIdLabel = "missing";
  const primitiveResult = harness.ensure(false);
  assert.equal(primitiveResult.flags, FLAG_FEATURE_TEXTURE | FLAG_BATCH_TABLE);
  assert.notEqual(
    entry(primitiveResult.featureIdEntries, 26).resource.texture,
    harness.fallbackTexture,
  );

  harness.model.featureIdLabel = "missing";
  const semanticNone = harness.ensure(false);
  assert.equal(semanticNone, undefined);
  assert.equal(harness.primCache._featureIdEntries, undefined);
  await settleAcceptedRetirements(harness);
  assert.equal(harness.fallbackTexture.destroyCalls, 0);

  harness.model.featureIdLabel = "primitive";
  const restored = harness.ensure(false);
  assert.ok(restored);
  assert.equal(restored.flags, FLAG_FEATURE_TEXTURE | FLAG_BATCH_TABLE);
});

function rendererFailClosedContract(source) {
  const ensureCall = source.indexOf(
    "const featureIdRes = ensureFeatureIdResources(",
  );
  assert.notEqual(ensureCall, -1);
  const blockEnd = source.indexOf(
    "// Set instancing and feature ID flags after packMaterialUniforms.",
    ensureCall,
  );
  assert.ok(blockEnd > ensureCall, "missing feature-result block boundary");
  const block = source.slice(ensureCall, blockEnd);
  assert.match(block, /if \(featureIdRes === null\) \{\s*continue;\s*\}/);
  const materialUpload = source.indexOf(
    "uploadPackedMaterialUniformsIfChanged(",
    blockEnd,
  );
  const commandConstruction = source.indexOf(
    "new WebGPUDrawCommand(",
    blockEnd,
  );
  assert.ok(materialUpload > blockEnd);
  assert.ok(commandConstruction > materialUpload);
}

test("renderer source distinguishes null fail-closed from legitimate undefined before command emission", async () => {
  const rendererSource = (
    await readFile(
      resolve(ENGINE_SOURCE, "Renderer/WebGPU/WebGPUModelRenderer.ts"),
      "utf8",
    )
  ).replace(/\r\n/g, "\n");
  rendererFailClosedContract(rendererSource);

  const nullGuardMutant = rendererSource.replace(
    "featureIdRes === null",
    "featureIdRes === undefined",
  );
  assert.notEqual(nullGuardMutant, rendererSource);
  assert.throws(() => rendererFailClosedContract(nullGuardMutant));

  const guardStart = rendererSource.indexOf("featureIdRes === null");
  const continueStart = rendererSource.indexOf("continue;", guardStart);
  assert.ok(guardStart >= 0 && continueStart > guardStart);
  const inertContinueMutant =
    rendererSource.slice(0, continueStart) +
    rendererSource.slice(continueStart).replace("continue;", "void 0;");
  assert.throws(() => rendererFailClosedContract(inertContinueMutant));
});

const GEOMETRY_MODULE_PATH = resolve(
  ENGINE_SOURCE,
  "Scene/Model/ModelPrimitiveGeometry.js",
);

async function loadGeometryModule(geometryModuleSource) {
  const plugins = [];
  if (geometryModuleSource !== undefined) {
    plugins.push({
      name: "geometry-module-source-substitution",
      setup(buildApi) {
        buildApi.onLoad({ filter: /ModelPrimitiveGeometry\.js$/ }, (args) => {
          if (resolve(args.path) !== GEOMETRY_MODULE_PATH) {
            return undefined;
          }
          return {
            contents: geometryModuleSource,
            loader: "js",
            resolveDir: dirname(args.path),
          };
        });
      },
    });
  }
  return importBundle({
    stdin: {
      contents: `
        export {
          createPrimitiveGeometryView,
          resetPrimitiveGeometryView
        } from "./Scene/Model/ModelPrimitiveGeometry.js";
      `,
      resolveDir: ENGINE_SOURCE,
      sourcefile: "model-primitive-geometry-view-entry.mjs",
    },
    bundle: true,
    format: "esm",
    platform: "node",
    target: "es2022",
    write: false,
    logLevel: "silent",
    plugins,
  });
}

// The renderer annotates the reusable view in place each frame. Everything it
// may overwrite has to come back from the immutable base, or one frame's
// feature-ID decision silently describes the next frame's buffer.
function assertGeometryViewReset(geometryApi) {
  const baseData = new Float32Array([1, 2, 3]);
  const base = {
    featureId0Data: baseData,
    featureId0SetIndex: 7,
    featureId0Synthesized: false,
    hasFeatureId0: true,
    indexData: null,
    indexCount: 0,
    indexType: "UNSIGNED_SHORT",
    indexSourceComponentBytes: 2,
  };
  const view = geometryApi.createPrimitiveGeometryView(base);
  view.featureId0Data = new Float32Array([9, 9, 9]);
  view.featureId0SetIndex = 99;
  view.featureId0Synthesized = true;

  geometryApi.resetPrimitiveGeometryView(view, base);

  assert.equal(
    view.featureId0SetIndex,
    7,
    "the view must forget an annotated set index",
  );
  assert.equal(
    view.featureId0Synthesized,
    false,
    "the view must forget an annotated synthesis decision",
  );
  assert.equal(
    view.featureId0Data,
    baseData,
    "the view must return to the base feature-ID data",
  );
}

test("the reusable geometry view forgets per-frame feature-ID annotations", async () => {
  const source = await readFile(GEOMETRY_MODULE_PATH, "utf8");
  const liveModule = await loadGeometryModule(source);
  assertGeometryViewReset(liveModule);

  const setIndexSource = replaceOnce(
    source,
    / {2}view\.featureId0SetIndex = baseGeometry\.featureId0SetIndex;\r?\n/,
    "",
    "view set-index restore",
  );
  const synthesizedSource = replaceOnce(
    source,
    / {2}view\.featureId0Synthesized = false;\r?\n/,
    "",
    "view synthesis reset",
  );
  const [setIndexModule, synthesizedModule] = await Promise.all([
    loadGeometryModule(setIndexSource),
    loadGeometryModule(synthesizedSource),
  ]);

  assert.throws(
    () => assertGeometryViewReset(setIndexModule),
    isAssertionErrorWith("the view must forget an annotated set index"),
  );
  assert.throws(
    () => assertGeometryViewReset(synthesizedModule),
    isAssertionErrorWith(
      "the view must forget an annotated synthesis decision",
    ),
  );
});
