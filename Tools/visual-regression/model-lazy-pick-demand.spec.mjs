// C11-196 — lazy native Model pick-resource realization contracts.
// @purpose Contracts for lazy realization of native Model pick resources across renderer, feature-id, Model, feature table and batch texture sources.
// @status ACTIVE
//
// Run: node --test Tools/visual-regression/model-lazy-pick-demand.spec.mjs

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { build, transform } from "esbuild";

const directory = dirname(fileURLToPath(import.meta.url));
const engineRoot = resolve(directory, "../../packages/engine/Source");

const readSource = async (relative) =>
  (await readFile(resolve(engineRoot, relative), "utf8")).replace(
    /\r\n/g,
    "\n",
  );

const [
  rendererSource,
  featureIdSource,
  modelSource,
  modelFeatureTableSource,
  batchTextureSource,
] = await Promise.all([
  readSource("Renderer/WebGPU/WebGPUModelRenderer.ts"),
  readSource("Renderer/WebGPU/WebGPUModelFeatureId.js"),
  readSource("Scene/Model/Model.js"),
  readSource("Scene/Model/ModelFeatureTable.js"),
  readSource("Scene/BatchTexture.js"),
]);

globalThis.GPUTextureUsage ??= {
  TEXTURE_BINDING: 1,
  COPY_DST: 2,
  RENDER_ATTACHMENT: 4,
};
globalThis.GPUBufferUsage ??= {
  COPY_DST: 1,
  UNIFORM: 2,
};

const bundle = await build({
  stdin: {
    contents: `
      export {
        destroyFeatureIdResources,
        destroyPerFeaturePickResources,
        ensureFeatureIdResources
      } from "./Renderer/WebGPU/WebGPUModelFeatureId.js";
      export { default as ModelComponents } from "./Scene/ModelComponents.js";
    `,
    resolveDir: engineRoot,
    sourcefile: "model-lazy-pick-demand-entry.mjs",
  },
  bundle: true,
  format: "esm",
  platform: "node",
  target: "es2022",
  write: false,
  logLevel: "silent",
});
const moduleUrl = `data:text/javascript;base64,${Buffer.from(
  bundle.outputFiles[0].text,
).toString("base64")}`;
const {
  destroyFeatureIdResources,
  destroyPerFeaturePickResources,
  ensureFeatureIdResources,
  ModelComponents,
} = await import(moduleUrl);

function createHarness() {
  const state = {
    textures: [],
    buffers: [],
    textureWrites: [],
    bufferWrites: [],
    pickIds: [],
    failPickUploadCount: 0,
    failPickViewCount: 0,
    failPromotionWriteCount: 0,
  };

  function createTexture(descriptor) {
    const texture = {
      descriptor,
      destroyed: false,
      viewCount: 0,
      createView() {
        if (
          descriptor.label.startsWith("Feature pick texture") &&
          state.failPickViewCount > 0
        ) {
          state.failPickViewCount--;
          throw new Error("feature pick view failed");
        }
        texture.viewCount++;
        return { texture, viewIndex: texture.viewCount };
      },
      destroy() {
        assert.equal(texture.destroyed, false, "texture destroyed twice");
        texture.destroyed = true;
      },
    };
    state.textures.push(texture);
    return texture;
  }

  const fallbackTexture = createTexture({ label: "fallback white" });
  const device = {
    createTexture,
    createBuffer(descriptor) {
      const buffer = {
        descriptor,
        destroyed: false,
        destroy() {
          assert.equal(buffer.destroyed, false, "buffer destroyed twice");
          buffer.destroyed = true;
        },
      };
      state.buffers.push(buffer);
      return buffer;
    },
    queue: {
      writeTexture(destination, data, layout, size) {
        const texture = destination.texture;
        if (
          texture.descriptor.label.startsWith("Feature pick texture") &&
          state.failPickUploadCount > 0
        ) {
          state.failPickUploadCount--;
          throw new Error("feature pick upload failed");
        }
        state.textureWrites.push({ texture, data, layout, size });
      },
      writeBuffer(buffer, offset, data) {
        if (offset === 40 && state.failPromotionWriteCount > 0) {
          state.failPromotionWriteCount--;
          throw new Error("feature pick uniform write failed");
        }
        state.bufferWrites.push({
          buffer,
          offset,
          values: Array.from(data),
        });
      },
    },
  };
  const context = {
    resourceGeneration: 0,
    createPickId(target, kind) {
      const index = state.pickIds.length + 1;
      const pickId = {
        target,
        kind,
        destroyed: false,
        color: {
          red: index / 255,
          green: 0,
          blue: 0,
          alpha: 1,
        },
        destroy() {
          assert.equal(pickId.destroyed, false, "pick ID destroyed twice");
          pickId.destroyed = true;
        },
      };
      state.pickIds.push(pickId);
      return pickId;
    },
  };
  const batchTexture = {
    _featuresLength: 2,
    _textureDimensions: { x: 2, y: 1 },
    textureDimensions: { x: 2, y: 1 },
    textureStep: { x: 0.5, y: 1, z: 0.25, w: 0.5 },
    _batchValues: new Uint8Array(8).fill(255),
    _owner: {
      getFeature(featureId) {
        return { featureId };
      },
    },
  };
  const model = {
    featureIdLabel: undefined,
    instanceFeatureIdLabel: undefined,
    featureTableId: 0,
    featureTables: [{ featuresLength: 2, batchTexture }],
  };
  const primitive = {
    featureIds: [new ModelComponents.FeatureIdAttribute()],
  };
  const runtimeNode = { node: undefined };
  const pipelineCache = {
    defaultWhiteTexture: fallbackTexture,
    defaultSampler: { label: "default sampler" },
    propertyTextureSampler: { label: "nearest sampler" },
  };
  const modelCache = { primitives: {} };

  return {
    batchTexture,
    context,
    device,
    fallbackTexture,
    model,
    modelCache,
    state,
    makePrimitiveCache(key) {
      const primCache = {};
      modelCache.primitives[key] = primCache;
      return primCache;
    },
    ensure(primCache, pickDemand) {
      return ensureFeatureIdResources(
        device,
        primCache,
        model,
        primitive,
        runtimeNode,
        pipelineCache,
        context,
        modelCache,
        pickDemand,
      );
    },
    resizeFeatures(featuresLength) {
      batchTexture._featuresLength = featuresLength;
      batchTexture._textureDimensions = { x: featuresLength, y: 1 };
      batchTexture.textureDimensions = { x: featuresLength, y: 1 };
      batchTexture._batchValues = new Uint8Array(featuresLength * 4).fill(255);
      model.featureTables[0].featuresLength = featuresLength;
    },
    replaceBatchTextureOwner(source = "replacement") {
      const replacementFeatures = [
        { source, featureId: 0 },
        { source, featureId: 1 },
      ];
      const replacementBatchTexture = {
        ...batchTexture,
        _owner: {
          getFeature(featureId) {
            return replacementFeatures[featureId];
          },
        },
      };
      model.featureTables[0].batchTexture = replacementBatchTexture;
      return { replacementBatchTexture, replacementFeatures };
    },
    countTextures(labelPrefix) {
      return state.textures.filter((texture) =>
        texture.descriptor.label.startsWith(labelPrefix),
      ).length;
    },
  };
}

function entry(entries, binding) {
  return entries.find((candidate) => candidate.binding === binding);
}

test("cold color retains styling, first pick promotes synchronously, and repeat is stable", () => {
  const harness = createHarness();
  const primCache = harness.makePrimitiveCache("p0");

  const cold = harness.ensure(primCache, false);
  const coldEntries = cold.featureIdEntries;
  assert.ok((cold.flags & 0x40000) !== 0, "batch styling must be non-vacuous");
  assert.equal(coldEntries.length, 7);
  assert.equal(
    entry(coldEntries, 31).resource.texture,
    harness.fallbackTexture,
  );
  assert.equal(harness.state.pickIds.length, 0);
  assert.equal(harness.modelCache._featurePickIds, undefined);
  assert.equal(harness.modelCache._featurePickGPUTexture, undefined);
  assert.equal(harness.state.bufferWrites.length, 1);
  assert.equal(harness.state.bufferWrites[0].offset, 0);
  assert.equal(harness.state.bufferWrites[0].values[10], 0);

  const firstPick = harness.ensure(primCache, true);
  const promotedEntries = firstPick.featureIdEntries;
  const pickTexture = harness.modelCache._featurePickGPUTexture;
  assert.equal(harness.state.pickIds.length, 2);
  assert.deepEqual(
    harness.state.pickIds.map((pickId) => pickId.kind),
    ["tile-feature", "tile-feature"],
  );
  assert.deepEqual(
    harness.state.pickIds.map((pickId) => pickId.target.featureId),
    [0, 1],
  );
  assert.equal(harness.countTextures("Feature pick texture"), 1);
  assert.notEqual(promotedEntries, coldEntries);
  assert.equal(entry(promotedEntries, 31).resource.texture, pickTexture);
  for (let i = 0; i < coldEntries.length; i++) {
    if (coldEntries[i].binding !== 31) {
      assert.equal(promotedEntries[i], coldEntries[i]);
    }
  }
  assert.deepEqual(
    harness.state.bufferWrites.map((write) => write.offset),
    [0, 40],
  );
  assert.deepEqual(harness.state.bufferWrites[1].values, [1]);

  const repeat = harness.ensure(primCache, true);
  const ordinaryAfterPick = harness.ensure(primCache, false);
  assert.equal(repeat.featureIdEntries, promotedEntries);
  assert.equal(ordinaryAfterPick.featureIdEntries, promotedEntries);
  assert.equal(harness.state.pickIds.length, 2);
  assert.equal(harness.countTextures("Feature pick texture"), 1);
  assert.equal(harness.state.bufferWrites.length, 2);
});

test("a cold model can promote in the same first-pick traversal", () => {
  const harness = createHarness();
  const primCache = harness.makePrimitiveCache("p0");

  const firstCall = harness.ensure(primCache, true);
  assert.equal(
    entry(firstCall.featureIdEntries, 31).resource.texture,
    harness.modelCache._featurePickGPUTexture,
  );
  assert.deepEqual(
    harness.state.bufferWrites.map((write) => write.offset),
    [0, 40],
  );
  assert.equal(harness.state.pickIds.length, 2);
});

test("multiple primitives share one model texture and promote independently once", () => {
  const harness = createHarness();
  const firstPrimitive = harness.makePrimitiveCache("p0");
  const secondPrimitive = harness.makePrimitiveCache("p1");
  const firstColdEntries = harness.ensure(
    firstPrimitive,
    false,
  ).featureIdEntries;
  const secondColdEntries = harness.ensure(
    secondPrimitive,
    false,
  ).featureIdEntries;

  const firstPickEntries = harness.ensure(
    firstPrimitive,
    true,
  ).featureIdEntries;
  const secondPickEntries = harness.ensure(
    secondPrimitive,
    true,
  ).featureIdEntries;
  const sharedTexture = harness.modelCache._featurePickGPUTexture;

  assert.equal(harness.state.pickIds.length, 2);
  assert.equal(harness.countTextures("Feature pick texture"), 1);
  assert.notEqual(firstPickEntries, firstColdEntries);
  assert.notEqual(secondPickEntries, secondColdEntries);
  assert.equal(entry(firstPickEntries, 31).resource.texture, sharedTexture);
  assert.equal(entry(secondPickEntries, 31).resource.texture, sharedTexture);
  assert.equal(harness.state.bufferWrites.length, 4);

  harness.ensure(firstPrimitive, true);
  harness.ensure(secondPrimitive, true);
  assert.equal(harness.state.bufferWrites.length, 4);
  assert.equal(harness.state.pickIds.length, 2);
});

test("same-count BatchTexture replacement rebuilds exact feature targets", () => {
  const harness = createHarness();
  const primCache = harness.makePrimitiveCache("p0");
  harness.ensure(primCache, true);
  const oldTexture = harness.modelCache._featurePickGPUTexture;
  const oldPickIds = harness.state.pickIds.slice();
  const { replacementBatchTexture, replacementFeatures } =
    harness.replaceBatchTextureOwner();

  const replacement = harness.ensure(primCache, true);

  assert.equal(
    harness.modelCache._featurePickBatchTexture,
    replacementBatchTexture,
  );
  assert.notEqual(harness.modelCache._featurePickGPUTexture, oldTexture);
  assert.equal(harness.state.pickIds.length, 4);
  assert.equal(oldTexture.destroyed, true);
  assert.ok(oldPickIds.every((pickId) => pickId.destroyed));
  assert.equal(
    harness.modelCache._featurePickIds.get(0),
    harness.state.pickIds[2],
  );
  assert.equal(
    harness.modelCache._featurePickIds.get(1),
    harness.state.pickIds[3],
  );
  assert.equal(harness.state.pickIds[2].target, replacementFeatures[0]);
  assert.equal(harness.state.pickIds[3].target, replacementFeatures[1]);
  assert.equal(
    entry(replacement.featureIdEntries, 31).resource.texture,
    harness.modelCache._featurePickGPUTexture,
  );

  const textureCount = harness.countTextures("Feature pick texture");
  harness.ensure(primCache, true);
  assert.equal(harness.state.pickIds.length, 4);
  assert.equal(harness.countTextures("Feature pick texture"), textureCount);
});

for (const failure of ["upload", "view", "uniform-write"]) {
  test(`cold promotion ${failure} failure remains fallback-coherent and retries`, () => {
    const harness = createHarness();
    const primCache = harness.makePrimitiveCache("p0");
    const coldEntries = harness.ensure(primCache, false).featureIdEntries;
    if (failure === "upload") {
      harness.state.failPickUploadCount = 1;
    } else if (failure === "view") {
      harness.state.failPickViewCount = 1;
    } else {
      harness.state.failPromotionWriteCount = 1;
    }

    assert.throws(() => harness.ensure(primCache, true));
    assert.equal(primCache._featureIdEntries, coldEntries);
    assert.equal(primCache._featurePickBoundGPUTexture, undefined);
    assert.equal(
      entry(coldEntries, 31).resource.texture,
      harness.fallbackTexture,
    );
    assert.equal(
      harness.state.bufferWrites.filter((write) => write.offset === 40).length,
      0,
    );
    if (failure === "upload") {
      assert.equal(harness.modelCache._featurePickGPUTexture, undefined);
      assert.ok(harness.state.pickIds.every((pickId) => pickId.destroyed));
    } else {
      assert.ok(harness.modelCache._featurePickGPUTexture);
      assert.ok(harness.state.pickIds.every((pickId) => !pickId.destroyed));
    }

    const retry = harness.ensure(primCache, true);
    assert.notEqual(retry.featureIdEntries, coldEntries);
    assert.equal(
      entry(retry.featureIdEntries, 31).resource.texture,
      harness.modelCache._featurePickGPUTexture,
    );
    assert.equal(
      harness.state.bufferWrites.filter((write) => write.offset === 40).length,
      1,
    );
  });
}

for (const failure of ["view", "uniform-write"]) {
  test(`replacement ${failure} failure keeps the old two-primitive owner generation coherent`, () => {
    const harness = createHarness();
    const firstPrimitive = harness.makePrimitiveCache("p0");
    const secondPrimitive = harness.makePrimitiveCache("p1");
    const scheduledTextures = [];
    harness.context.scheduleTextureDestroy = (texture) => {
      scheduledTextures.push(texture);
    };
    harness.ensure(firstPrimitive, true);
    harness.ensure(secondPrimitive, true);
    const oldEntries = firstPrimitive._featureIdEntries;
    const oldTexture = firstPrimitive._featurePickBoundGPUTexture;
    const oldPickIds = harness.state.pickIds.slice();

    harness.replaceBatchTextureOwner();
    if (failure === "view") {
      harness.state.failPickViewCount = 1;
    } else {
      harness.state.failPromotionWriteCount = 1;
    }
    assert.throws(() => harness.ensure(firstPrimitive, true));
    assert.equal(firstPrimitive._featureIdEntries, oldEntries);
    assert.equal(firstPrimitive._featurePickBoundGPUTexture, oldTexture);
    assert.equal(secondPrimitive._featurePickBoundGPUTexture, oldTexture);
    assert.equal(oldTexture.destroyed, false);
    const retiredPickIds =
      harness.modelCache._retiredFeaturePickGenerations.get(oldTexture);
    assert.equal(retiredPickIds.size, 2);
    assert.ok(oldPickIds.every((pickId) => retiredPickIds.has(pickId)));
    assert.ok(oldPickIds.every((pickId) => !pickId.destroyed));
    assert.equal(scheduledTextures.length, 0);

    const replacementTexture = harness.modelCache._featurePickGPUTexture;
    const retry = harness.ensure(firstPrimitive, true);
    assert.notEqual(retry.featureIdEntries, oldEntries);
    assert.equal(
      firstPrimitive._featurePickBoundGPUTexture,
      replacementTexture,
    );
    assert.equal(secondPrimitive._featurePickBoundGPUTexture, oldTexture);
    assert.ok(oldPickIds.every((pickId) => !pickId.destroyed));
    assert.equal(scheduledTextures.length, 0);

    harness.ensure(secondPrimitive, true);
    assert.deepEqual(scheduledTextures, [oldTexture]);
    assert.ok(oldPickIds.every((pickId) => pickId.destroyed));
    assert.equal(oldTexture.destroyed, false);
    assert.equal(harness.modelCache._retiredFeaturePickGenerations, undefined);
    assert.equal(harness.modelCache._featurePickIds.size, 2);
  });
}

test("multi-primitive replacement defers the incumbent until the last marker migrates", () => {
  const harness = createHarness();
  const firstPrimitive = harness.makePrimitiveCache("p0");
  const secondPrimitive = harness.makePrimitiveCache("p1");
  const scheduledTextures = [];
  harness.context.scheduleTextureDestroy = (texture) => {
    scheduledTextures.push(texture);
  };

  harness.ensure(firstPrimitive, true);
  harness.ensure(secondPrimitive, true);
  const oldTexture = harness.modelCache._featurePickGPUTexture;

  harness.resizeFeatures(3);
  harness.ensure(firstPrimitive, true);
  assert.equal(scheduledTextures.length, 0);
  assert.equal(oldTexture.destroyed, false);
  assert.equal(secondPrimitive._featurePickBoundGPUTexture, oldTexture);

  harness.ensure(secondPrimitive, true);
  assert.deepEqual(scheduledTextures, [oldTexture]);
  assert.equal(oldTexture.destroyed, false);
  assert.equal(harness.modelCache._retiredFeaturePickGenerations, undefined);

  harness.ensure(firstPrimitive, true);
  harness.ensure(secondPrimitive, true);
  assert.equal(scheduledTextures.length, 1);

  // Simulate WebGPUContext's post-submit settlement callback. No product path
  // may destroy the borrowed texture before this point.
  scheduledTextures[0].destroy();
  assert.equal(oldTexture.destroyed, true);
});

test("scheduler failure retains and retries the entire exact-owner generation", () => {
  const harness = createHarness();
  const firstPrimitive = harness.makePrimitiveCache("p0");
  const secondPrimitive = harness.makePrimitiveCache("p1");
  let scheduleAttempts = 0;
  harness.context.scheduleTextureDestroy = () => {
    scheduleAttempts++;
    if (scheduleAttempts === 1) {
      throw new Error("schedule failed");
    }
  };

  harness.ensure(firstPrimitive, true);
  harness.ensure(secondPrimitive, true);
  const oldTexture = harness.modelCache._featurePickGPUTexture;
  const oldPickIds = harness.state.pickIds.slice();
  harness.replaceBatchTextureOwner();

  harness.ensure(firstPrimitive, true);
  harness.ensure(secondPrimitive, true);
  assert.equal(scheduleAttempts, 1);
  assert.equal(
    harness.modelCache._retiredFeaturePickGenerations.get(oldTexture).size,
    2,
  );
  assert.ok(oldPickIds.every((pickId) => !pickId.destroyed));
  assert.equal(oldTexture.destroyed, false);

  const textureCount = harness.countTextures("Feature pick texture");
  harness.ensure(firstPrimitive, true);
  assert.equal(scheduleAttempts, 2);
  assert.ok(oldPickIds.every((pickId) => pickId.destroyed));
  assert.equal(harness.modelCache._retiredFeaturePickGenerations, undefined);
  assert.equal(harness.state.pickIds.length, 4);
  assert.equal(harness.countTextures("Feature pick texture"), textureCount);
});

test("teardown drains current and retained generations exactly once", () => {
  const harness = createHarness();
  const primCache = harness.makePrimitiveCache("p0");
  harness.ensure(primCache, true);
  const oldTexture = harness.modelCache._featurePickGPUTexture;
  const oldPickIds = harness.state.pickIds.slice();
  harness.replaceBatchTextureOwner();
  harness.state.failPickViewCount = 1;
  assert.throws(() => harness.ensure(primCache, true));
  const currentTexture = harness.modelCache._featurePickGPUTexture;
  const currentPickIds = harness.state.pickIds.slice(2);

  destroyFeatureIdResources(primCache);
  assert.equal(primCache._featurePickBoundGPUTexture, undefined);
  destroyPerFeaturePickResources(harness.modelCache);
  destroyPerFeaturePickResources(harness.modelCache);
  assert.equal(oldTexture.destroyed, true);
  assert.equal(currentTexture.destroyed, true);
  assert.ok(
    [...oldPickIds, ...currentPickIds].every((pickId) => pickId.destroyed),
  );
  assert.equal(harness.modelCache._featurePickGPUTexture, undefined);
  assert.equal(harness.modelCache._retiredFeaturePickGenerations, undefined);
});

function functionSlice(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `missing function ${name}`);
  const next = source.indexOf("\nfunction ", start + 1);
  return source.slice(start, next === -1 ? source.length : next);
}

function exactFunctionSlice(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `missing function ${name}`);
  const bodyStart = source.indexOf("{", start);
  assert.notEqual(bodyStart, -1, `missing body for function ${name}`);
  let depth = 0;
  for (let i = bodyStart; i < source.length; i++) {
    if (source[i] === "{") {
      depth++;
    } else if (source[i] === "}") {
      depth--;
      if (depth === 0) {
        return source.slice(start, i + 1);
      }
    }
  }
  assert.fail(`unterminated function ${name}`);
}

test("same-frame capture republish replaces the model entry without stale duplicates", async () => {
  const helperSource = exactFunctionSlice(
    rendererSource,
    "upsertModelCapturePublishEntry",
  );
  const compiled = await transform(
    `${helperSource}\nexport { upsertModelCapturePublishEntry };`,
    {
      loader: "ts",
      format: "esm",
      target: "es2022",
    },
  );
  const helperUrl = `data:text/javascript;base64,${Buffer.from(
    compiled.code,
  ).toString("base64")}`;
  const { upsertModelCapturePublishEntry } = await import(helperUrl);

  const modelA = { name: "A" };
  const modelB = { name: "B" };
  const modelC = { name: "C" };
  const other = { model: modelB, records: ["B"] };
  const stale = { model: modelA, records: ["T0"] };
  const models = [other, stale];

  const firstRepublish = { model: modelA, records: ["T1"] };
  upsertModelCapturePublishEntry(models, firstRepublish);
  assert.equal(models.length, 2);
  assert.equal(models[0], other);
  assert.equal(models[1], firstRepublish);
  assert.equal(models.includes(stale), false);

  const secondRepublish = { model: modelA, records: ["T2"] };
  upsertModelCapturePublishEntry(models, secondRepublish);
  assert.equal(models.length, 2);
  assert.equal(models[1], secondRepublish);
  assert.equal(
    models.filter((candidate) => candidate.model === modelA).length,
    1,
  );

  const newModel = { model: modelC, records: ["C"] };
  upsertModelCapturePublishEntry(models, newModel);
  assert.equal(models.length, 3);
  assert.equal(models[2], newModel);
});

function enforceRendererPolicy(source) {
  const update = functionSlice(source, "updateWebGPUModel");
  const captureUpsert = exactFunctionSlice(
    source,
    "upsertModelCapturePublishEntry",
  );
  assert.match(
    update,
    /const pickDemand =\s*passes\?\.pick === true &&\s*!isClassifier &&\s*model\.allowPicking !== false;/,
  );
  assert.match(update, /allowAllocate: pickDemand,/);
  assert.match(update, /detail: \{ model: model \},/);
  assert.match(update, /cache,\s*pickDemand,\s*\)/);
  assert.match(update, /if \(pickDemand && pickColor && !isClassifier\) \{/);
  assert.doesNotMatch(update, /passes\.pick\s*\|\|\s*passes\.render/);
  assert.match(captureUpsert, /if \(models\[i\]\.model === entry\.model\) \{/);
  assert.match(captureUpsert, /models\[i\] = entry;\s*return;/);
  assert.match(captureUpsert, /models\.push\(entry\);/);
  assert.match(
    update,
    /upsertModelCapturePublishEntry\(pub\.models, capturePublishEntry\);/,
  );
  assert.doesNotMatch(update, /pub\.models\.push\(capturePublishEntry\)/);
}

function enforceFeaturePromotionPolicy(source) {
  const retire = functionSlice(
    source,
    "destroyUnboundRetiredFeaturePickGenerations",
  );
  const promote = functionSlice(source, "promoteFeaturePickResources");
  const ensure = functionSlice(source, "ensureFeatureIdResources");
  const allocate = functionSlice(source, "ensurePerFeaturePickIds");
  const viewIndex = promote.indexOf("const featurePickView");
  const entriesIndex = promote.indexOf("const promotedEntries");
  const writeIndex = promote.indexOf("device.queue.writeBuffer(");
  const publishIndex = promote.indexOf(
    "primCache._featureIdEntries = promotedEntries;",
  );

  assert.ok(viewIndex >= 0);
  assert.ok(entriesIndex > viewIndex);
  assert.ok(writeIndex > entriesIndex);
  assert.ok(publishIndex > writeIndex);
  assert.match(promote, /const promotedEntries = currentEntries\.slice\(\);/);
  assert.match(promote, /binding: 31,\s*resource: featurePickView,/);
  assert.match(
    promote,
    /primCache\._featurePickBoundGPUTexture = featurePickTexture;/,
  );
  assert.match(retire, /scheduleTextureDestroy\.call\(context, texture\);/);
  assert.ok(
    retire.indexOf("retiredGenerations.delete(texture);") >
      retire.indexOf("scheduleTextureDestroy.call(context, texture);"),
  );
  assert.ok(
    retire.indexOf("pickId.destroy();") >
      retire.indexOf("scheduleTextureDestroy.call(context, texture);"),
  );
  assert.match(retire, /else \{\s*try \{\s*texture\.destroy\(\);/);
  assert.match(ensure, /uniformData\[10\] = 0\.0;/);
  assert.match(ensure, /resource: fallbackTex\.createView\(\),/);
  assert.match(ensure, /if \(pickPassActive === true\) \{/);
  assert.doesNotMatch(ensure, /void pickPassActive/);
  assert.match(
    allocate,
    /const retiredGenerations =\s*cache\._retiredFeaturePickGenerations \?\?\s*\(cache\._retiredFeaturePickGenerations = new Map\(\)\);/,
  );
  assert.match(
    allocate,
    /retiredGenerations\.set\(previousTexture, generationPickIds\);/,
  );
  assert.match(
    allocate,
    /for \(const pickId of retiredPickIds\) \{\s*generationPickIds\.add\(pickId\);\s*\}/,
  );
  assert.match(
    allocate,
    /cache\._featurePickBatchTexture === batchTexture &&\s*cache\._featurePickFeaturesLength === featuresLength &&\s*cache\._featurePickTextureWidth === dimensions\.x &&\s*cache\._featurePickTextureHeight === dimensions\.y/,
  );
  assert.match(
    allocate,
    /const canReusePreviousPickIds =\s*cache\._featurePickBatchTexture === batchTexture;/,
  );
  assert.match(
    allocate,
    /let pid = canReusePreviousPickIds\s*\? previousPickIds\?\.get\(fid\)\s*: undefined;/,
  );
  assert.match(
    allocate,
    /cache\._featurePickBatchTexture = batchTexture;\s*cache\._featurePickFeaturesLength = featuresLength;\s*cache\._featurePickTextureWidth = dimensions\.x;\s*cache\._featurePickTextureHeight = dimensions\.y;/,
  );
  assert.doesNotMatch(allocate, /previousTexture\.destroy\(\)/);
}

function enforceFrontendOwnershipPolicy(
  model,
  modelFeatureTable,
  batchTexture,
) {
  const ownerStart = model.indexOf("const modelFeatureRenderer =");
  const ownerEnd = model.indexOf("updateFeatureTableId(this);", ownerStart);
  assert.ok(ownerStart >= 0);
  assert.ok(ownerEnd > ownerStart);
  const ownerBlock = model.slice(ownerStart, ownerEnd);
  const build = functionSlice(model, "buildDrawCommands");
  const submit = functionSlice(model, "submitDrawCommands");

  assert.equal((model.match(/\.getFeatureRenderer\(/g) ?? []).length, 1);
  assert.match(
    ownerBlock,
    /frameState\.context\.getFeatureRenderer\(\s*FeatureRendererKey\.MODEL,?\s*\)/,
  );
  assert.match(
    ownerBlock,
    /defined\(modelFeatureRenderer\) && !defined\(this\.classificationType\)/,
  );
  assert.match(
    ownerBlock,
    /passes\.postProcess === true \|\|\s*\(passes\.pick === true && !nativeOwnsDensePick\)/,
  );
  assert.doesNotMatch(ownerBlock, /allowPicking|isWebGPU/);
  assert.match(
    model,
    /updateFeatureTables\(this, frameState, legacyPickTextureDemand\);/,
  );
  assert.match(
    model,
    /buildDrawCommands\(\s*this,\s*frameState,\s*modelFeatureRenderer,?\s*\)/,
  );
  assert.match(
    model,
    /submitDrawCommands\(this, frameState, modelFeatureRenderer\);/,
  );
  assert.doesNotMatch(build, /getFeatureRenderer/);
  assert.doesNotMatch(submit, /getFeatureRenderer/);
  assert.match(
    modelFeatureTable,
    /update\(frameState, legacyPickTextureDemand\)/,
  );
  assert.match(
    modelFeatureTable,
    /this\._batchTexture\.update\(\s*undefined,\s*frameState,\s*legacyPickTextureDemand,?\s*\);/,
  );
  assert.match(
    batchTexture,
    /legacyPickTextureDemand \?\? \(passes\.pick \|\| passes\.postProcess\)/,
  );
}

test("frontend owner law preserves WebGL, postprocess, native, and classifier demand", () => {
  enforceFrontendOwnershipPolicy(
    modelSource,
    modelFeatureTableSource,
    batchTextureSource,
  );

  const legacyDemand = ({ modelFr, classifier, pick, postProcess }) => {
    const nativeOwnsDensePick = modelFr && !classifier;
    return postProcess || (pick && !nativeOwnsDensePick);
  };
  assert.equal(
    legacyDemand({
      modelFr: false,
      classifier: false,
      pick: true,
      postProcess: false,
    }),
    true,
  );
  assert.equal(
    legacyDemand({
      modelFr: false,
      classifier: false,
      pick: false,
      postProcess: true,
    }),
    true,
  );
  assert.equal(
    legacyDemand({
      modelFr: true,
      classifier: false,
      pick: true,
      postProcess: false,
    }),
    false,
  );
  assert.equal(
    legacyDemand({
      modelFr: true,
      classifier: true,
      pick: true,
      postProcess: false,
    }),
    true,
  );
  assert.equal(
    legacyDemand({
      modelFr: true,
      classifier: false,
      pick: false,
      postProcess: true,
    }),
    true,
  );
  assert.equal(
    legacyDemand({
      modelFr: false,
      classifier: false,
      pick: false,
      postProcess: false,
    }),
    false,
  );
});

test("source policy preserves exact demand, defensive exclusions, and sync pick traversal", () => {
  enforceRendererPolicy(rendererSource);
  enforceFeaturePromotionPolicy(featureIdSource);
  enforceFrontendOwnershipPolicy(
    modelSource,
    modelFeatureTableSource,
    batchTextureSource,
  );
  assert.match(
    modelSource,
    /passes\.render \|\| \(passes\.pick && model\.allowPicking\)/,
  );
});

function replaceOnce(source, before, after) {
  const result = source.replace(before, after);
  assert.notEqual(result, source, `mutation anchor missing: ${before}`);
  return result;
}

test("source contracts independently reject plausible eager-allocation mutants", () => {
  const rendererMutants = [
    replaceOnce(
      rendererSource,
      "allowAllocate: pickDemand,",
      "allowAllocate: pickDemand || passes.render,",
    ),
    replaceOnce(
      rendererSource,
      "if (pickDemand && pickColor && !isClassifier) {",
      "if (pickColor && !isClassifier) {",
    ),
    replaceOnce(
      rendererSource,
      "passes?.pick === true && !isClassifier && model.allowPicking !== false;",
      "passes?.pick === true && model.allowPicking !== false;",
    ),
    replaceOnce(rendererSource, "models[i] = entry;", "models.push(entry);"),
  ];
  for (const mutant of rendererMutants) {
    assert.throws(() => enforceRendererPolicy(mutant));
  }

  const featureMutants = [
    replaceOnce(
      featureIdSource,
      "uniformData[10] = 0.0;",
      "uniformData[10] = 1.0;",
    ),
    replaceOnce(
      featureIdSource,
      "primCache._featureIdEntries = promotedEntries;",
      "primCache._featureIdEntries = currentEntries;",
    ),
    replaceOnce(
      featureIdSource,
      "cache._retiredFeaturePickGenerations ??",
      "undefined ??",
    ),
    replaceOnce(
      featureIdSource,
      "generationPickIds.add(pickId);",
      "void pickId;",
    ),
    replaceOnce(
      featureIdSource,
      "scheduleTextureDestroy.call(context, texture);",
      "texture.destroy();",
    ),
    replaceOnce(
      featureIdSource,
      "cache._featurePickBatchTexture === batchTexture &&",
      "true &&",
    ),
    replaceOnce(
      featureIdSource,
      "const canReusePreviousPickIds =\n    cache._featurePickBatchTexture === batchTexture;",
      "const canReusePreviousPickIds = true;",
    ),
    replaceOnce(
      featureIdSource,
      "cache._featurePickTextureWidth === dimensions.x &&",
      "true &&",
    ),
  ];
  for (const mutant of featureMutants) {
    assert.throws(() => enforceFeaturePromotionPolicy(mutant));
  }

  const frontendMutants = [
    [
      replaceOnce(modelSource, "!defined(this.classificationType);", "true;"),
      modelFeatureTableSource,
      batchTextureSource,
    ],
    [
      replaceOnce(modelSource, "passes.postProcess === true ||", "false ||"),
      modelFeatureTableSource,
      batchTextureSource,
    ],
    [
      replaceOnce(
        modelSource,
        "passes.pick === true && !nativeOwnsDensePick",
        "passes.pick === true",
      ),
      modelFeatureTableSource,
      batchTextureSource,
    ],
    [
      modelSource,
      replaceOnce(
        modelFeatureTableSource,
        "this._batchTexture.update(undefined, frameState, legacyPickTextureDemand);",
        "this._batchTexture.update(undefined, frameState, undefined);",
      ),
      batchTextureSource,
    ],
    [
      modelSource,
      modelFeatureTableSource,
      replaceOnce(
        batchTextureSource,
        "legacyPickTextureDemand ?? (passes.pick || passes.postProcess)",
        "legacyPickTextureDemand ?? false",
      ),
    ],
  ];
  for (const [model, table, batch] of frontendMutants) {
    assert.throws(() => enforceFrontendOwnershipPolicy(model, table, batch));
  }
});
