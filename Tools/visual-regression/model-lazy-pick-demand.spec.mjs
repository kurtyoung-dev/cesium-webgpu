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
    encoderEnlistments: [],
    fences: [],
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
      onSubmittedWorkDone() {
        let resolveFence;
        let rejectFence;
        const promise = new Promise((resolve, reject) => {
          resolveFence = resolve;
          rejectFence = reject;
        });
        const fence = {
          promise,
          resolve: resolveFence,
          reject: rejectFence,
          settled: false,
          queue: this,
        };
        state.fences.push(fence);
        return promise;
      },
    },
  };
  const context = {
    resourceGeneration: 0,
    currentCommandEncoder: { label: "lazy-pick exact encoder" },
    enqueueAfterCommandEncoderSubmit(encoder, callback) {
      state.encoderEnlistments.push({ encoder, callback });
      return true;
    },
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
    fireEncoderCallbacks(limit = Number.POSITIVE_INFINITY) {
      const count = Math.min(limit, state.encoderEnlistments.length);
      const enlistments = state.encoderEnlistments.splice(0, count);
      for (let i = 0; i < enlistments.length; i++) {
        enlistments[i].callback();
      }
      return enlistments;
    },
    async resolveFences(limit = Number.POSITIVE_INFINITY) {
      const fences = state.fences
        .filter((fence) => !fence.settled)
        .slice(0, limit);
      for (let i = 0; i < fences.length; i++) {
        fences[i].settled = true;
        fences[i].resolve();
      }
      await Promise.allSettled(fences.map((fence) => fence.promise));
      await Promise.resolve();
      return fences;
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

test("same-count BatchTexture replacement rebuilds exact feature targets", async () => {
  const harness = createHarness();
  const primCache = harness.makePrimitiveCache("p0");
  const scheduledTextures = [];
  harness.context.scheduleTextureDestroy = (texture) => {
    scheduledTextures.push(texture);
  };
  const incumbent = harness.ensure(primCache, true);
  const oldEntries = incumbent.featureIdEntries;
  const oldBatchTexture = entry(oldEntries, 28).resource.texture;
  const oldUniformBuffer = entry(oldEntries, 30).resource.buffer;
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
  assert.equal(oldBatchTexture.destroyed, false);
  assert.equal(oldUniformBuffer.destroyed, false);
  assert.equal(oldTexture.destroyed, false);
  assert.ok(oldPickIds.every((pickId) => !pickId.destroyed));
  assert.equal(scheduledTextures.length, 0);
  assert.equal(harness.state.encoderEnlistments.length, 1);
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

  const [enlistment] = harness.fireEncoderCallbacks();
  assert.equal(enlistment.encoder, harness.context.currentCommandEncoder);
  assert.equal(harness.state.fences.length, 1);
  assert.equal(oldBatchTexture.destroyed, false);
  assert.equal(oldUniformBuffer.destroyed, false);
  assert.equal(oldTexture.destroyed, false);
  assert.equal(scheduledTextures.length, 0);

  const [fence] = await harness.resolveFences();
  assert.equal(fence.queue, harness.device.queue);
  assert.equal(oldBatchTexture.destroyed, true);
  assert.equal(oldUniformBuffer.destroyed, true);
  assert.deepEqual(scheduledTextures, [oldTexture]);
  assert.ok(oldPickIds.every((pickId) => pickId.destroyed));
  assert.equal(oldTexture.destroyed, false);
  scheduledTextures[0].destroy();
  assert.equal(oldTexture.destroyed, true);

  const textureCount = harness.countTextures("Feature pick texture");
  harness.ensure(primCache, true);
  assert.equal(harness.state.pickIds.length, 4);
  assert.equal(harness.countTextures("Feature pick texture"), textureCount);
  assert.equal(harness.state.encoderEnlistments.length, 0);
  assert.equal(harness.state.fences.length, 1);
  assert.equal(scheduledTextures.length, 1);
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
  test(`replacement ${failure} failure keeps the old two-primitive owner generation coherent`, async () => {
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
    const oldFirstBatchTexture = firstPrimitive._batchGPUTexture;
    const oldFirstUniformBuffer = firstPrimitive._featureUniformBuffer;
    const oldSecondBatchTexture = secondPrimitive._batchGPUTexture;
    const oldSecondUniformBuffer = secondPrimitive._featureUniformBuffer;
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
    assert.equal(harness.state.encoderEnlistments.length, 0);

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
    assert.equal(harness.state.encoderEnlistments.length, 1);

    harness.ensure(secondPrimitive, true);
    assert.equal(harness.state.encoderEnlistments.length, 2);
    assert.equal(scheduledTextures.length, 0);

    const [firstEnlistment] = harness.fireEncoderCallbacks(1);
    assert.equal(
      firstEnlistment.encoder,
      harness.context.currentCommandEncoder,
    );
    assert.equal(harness.state.fences.length, 1);
    assert.equal(oldFirstBatchTexture.destroyed, false);
    assert.equal(oldFirstUniformBuffer.destroyed, false);
    await harness.resolveFences(1);
    assert.equal(oldFirstBatchTexture.destroyed, true);
    assert.equal(oldFirstUniformBuffer.destroyed, true);
    assert.equal(oldSecondBatchTexture.destroyed, false);
    assert.equal(oldSecondUniformBuffer.destroyed, false);
    assert.equal(scheduledTextures.length, 0);
    assert.ok(oldPickIds.every((pickId) => !pickId.destroyed));

    const [secondEnlistment] = harness.fireEncoderCallbacks(1);
    assert.equal(
      secondEnlistment.encoder,
      harness.context.currentCommandEncoder,
    );
    assert.equal(harness.state.fences.length, 2);
    assert.equal(oldSecondBatchTexture.destroyed, false);
    assert.equal(oldSecondUniformBuffer.destroyed, false);
    await harness.resolveFences(1);
    assert.equal(oldSecondBatchTexture.destroyed, true);
    assert.equal(oldSecondUniformBuffer.destroyed, true);
    assert.deepEqual(scheduledTextures, [oldTexture]);
    assert.ok(oldPickIds.every((pickId) => pickId.destroyed));
    assert.equal(oldTexture.destroyed, false);
    assert.equal(harness.modelCache._retiredFeaturePickGenerations, undefined);
    assert.equal(harness.modelCache._featurePickIds.size, 2);
    scheduledTextures[0].destroy();
    assert.equal(oldTexture.destroyed, true);
  });
}

test("multi-primitive replacement defers the incumbent until the last marker migrates", async () => {
  const harness = createHarness();
  const firstPrimitive = harness.makePrimitiveCache("p0");
  const secondPrimitive = harness.makePrimitiveCache("p1");
  const scheduledTextures = [];
  harness.context.scheduleTextureDestroy = (texture) => {
    scheduledTextures.push(texture);
  };

  harness.ensure(firstPrimitive, true);
  harness.ensure(secondPrimitive, true);
  const oldFirstBatchTexture = firstPrimitive._batchGPUTexture;
  const oldFirstUniformBuffer = firstPrimitive._featureUniformBuffer;
  const oldSecondBatchTexture = secondPrimitive._batchGPUTexture;
  const oldSecondUniformBuffer = secondPrimitive._featureUniformBuffer;
  const oldTexture = harness.modelCache._featurePickGPUTexture;
  const oldPickIds = harness.state.pickIds.slice();

  harness.resizeFeatures(3);
  harness.ensure(firstPrimitive, true);
  assert.equal(scheduledTextures.length, 0);
  assert.equal(oldTexture.destroyed, false);
  assert.equal(secondPrimitive._featurePickBoundGPUTexture, oldTexture);
  assert.equal(harness.state.encoderEnlistments.length, 1);

  const [firstEnlistment] = harness.fireEncoderCallbacks(1);
  assert.equal(firstEnlistment.encoder, harness.context.currentCommandEncoder);
  assert.equal(harness.state.fences.length, 1);
  assert.equal(oldFirstBatchTexture.destroyed, false);
  assert.equal(oldFirstUniformBuffer.destroyed, false);
  await harness.resolveFences(1);
  assert.equal(oldFirstBatchTexture.destroyed, true);
  assert.equal(oldFirstUniformBuffer.destroyed, true);
  assert.equal(scheduledTextures.length, 0);
  assert.ok(oldPickIds.every((pickId) => !pickId.destroyed));

  harness.ensure(secondPrimitive, true);
  assert.equal(harness.state.encoderEnlistments.length, 1);
  assert.equal(scheduledTextures.length, 0);
  const [secondEnlistment] = harness.fireEncoderCallbacks(1);
  assert.equal(secondEnlistment.encoder, harness.context.currentCommandEncoder);
  assert.equal(harness.state.fences.length, 2);
  assert.equal(oldSecondBatchTexture.destroyed, false);
  assert.equal(oldSecondUniformBuffer.destroyed, false);
  await harness.resolveFences(1);
  assert.equal(oldSecondBatchTexture.destroyed, true);
  assert.equal(oldSecondUniformBuffer.destroyed, true);
  assert.deepEqual(scheduledTextures, [oldTexture]);
  assert.ok(oldPickIds.every((pickId) => !pickId.destroyed));
  assert.equal(harness.modelCache._featurePickIds.get(0), oldPickIds[0]);
  assert.equal(harness.modelCache._featurePickIds.get(1), oldPickIds[1]);
  assert.equal(harness.modelCache._featurePickIds.size, 3);
  assert.equal(oldTexture.destroyed, false);
  assert.equal(harness.modelCache._retiredFeaturePickGenerations, undefined);

  harness.ensure(firstPrimitive, true);
  harness.ensure(secondPrimitive, true);
  assert.equal(scheduledTextures.length, 1);
  assert.equal(harness.state.encoderEnlistments.length, 0);

  // The model-wide dense-pick scheduler owns this texture after both exact base
  // generations have settled; its later submission callback destroys it.
  scheduledTextures[0].destroy();
  assert.equal(oldTexture.destroyed, true);
});

test("dense-pick scheduler failure retains and retries its exact-owner generation", async () => {
  const harness = createHarness();
  const firstPrimitive = harness.makePrimitiveCache("p0");
  const secondPrimitive = harness.makePrimitiveCache("p1");
  let scheduleAttempts = 0;
  let acceptedTexture;
  harness.context.scheduleTextureDestroy = (texture) => {
    scheduleAttempts++;
    if (scheduleAttempts === 1) {
      throw new Error("schedule failed");
    }
    acceptedTexture = texture;
  };

  harness.ensure(firstPrimitive, true);
  harness.ensure(secondPrimitive, true);
  const oldTexture = harness.modelCache._featurePickGPUTexture;
  const oldPickIds = harness.state.pickIds.slice();
  harness.replaceBatchTextureOwner();

  harness.ensure(firstPrimitive, true);
  harness.ensure(secondPrimitive, true);
  assert.equal(scheduleAttempts, 0);
  assert.equal(harness.state.encoderEnlistments.length, 2);
  const enlistments = harness.fireEncoderCallbacks();
  assert.equal(enlistments.length, 2);
  assert.ok(
    enlistments.every(
      (enlistment) =>
        enlistment.encoder === harness.context.currentCommandEncoder,
    ),
  );
  assert.equal(harness.state.fences.length, 2);
  assert.equal(scheduleAttempts, 0);
  await harness.resolveFences();
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
  assert.equal(harness.state.encoderEnlistments.length, 0);
  assert.equal(acceptedTexture, oldTexture);
  assert.equal(oldTexture.destroyed, false);
  acceptedTexture.destroy();
  assert.equal(oldTexture.destroyed, true);
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

function exactFrozenArraySlice(source, name) {
  const start = source.indexOf(`const ${name} = Object.freeze([`);
  assert.notEqual(start, -1, `missing frozen array ${name}`);
  const end = source.indexOf("]);", start);
  assert.notEqual(end, -1, `unterminated frozen array ${name}`);
  return source.slice(start, end + 3);
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
  assert.match(
    update,
    /cache,\s*pickDemand,\s*encodeFeatureIdCompatibilityToken\(\s*geometry\.hasFeatureId0,\s*geometry\.featureId0Synthesized,\s*\),/,
  );
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
  const ensureIndex = update.indexOf(
    "const featureIdRes = ensureFeatureIdResources(",
  );
  const nullGuardIndex = update.indexOf(
    "if (featureIdRes === null) {\n        continue;\n      }",
  );
  const commandContinuationIndex = update.indexOf(
    "// Set instancing",
    ensureIndex,
  );
  assert.ok(ensureIndex >= 0);
  assert.ok(nullGuardIndex > ensureIndex);
  assert.ok(commandContinuationIndex > nullGuardIndex);
}

function enforceFeaturePromotionPolicy(source) {
  const retire = exactFunctionSlice(
    source,
    "destroyUnboundRetiredFeaturePickGenerations",
  );
  const promote = exactFunctionSlice(source, "promoteFeaturePickResources");
  const candidate = exactFunctionSlice(
    source,
    "createFeatureResourceCandidate",
  );
  const attempt = exactFunctionSlice(source, "ensureFeatureIdResourcesAttempt");
  const generation = exactFunctionSlice(
    source,
    "ensureFeatureIdResourcesGeneration",
  );
  const retireBase = exactFunctionSlice(
    source,
    "scheduleRetiredFeatureResourceGenerations",
  );
  const provenanceRegistry = exactFrozenArraySlice(
    source,
    "FEATURE_RESOURCE_PROVENANCE_KEYS",
  );
  const provenanceComparator = exactFunctionSlice(
    source,
    "sameFeatureResourceProvenance",
  );
  const matchPickGeneration = exactFunctionSlice(
    source,
    "featurePickGenerationMatchesInputs",
  );
  const livePickInputs = exactFunctionSlice(
    source,
    "featurePickInputsRemainCurrent",
  );
  const applyPickGeneration = exactFunctionSlice(
    source,
    "applyFeaturePickGeneration",
  );
  const destroyProvisionalPickGeneration = exactFunctionSlice(
    source,
    "destroyProvisionalFeaturePickGeneration",
  );
  const pickGenerationCurrent = exactFunctionSlice(
    source,
    "featurePickGenerationIsCurrent",
  );
  const primitivePromotionCurrent = exactFunctionSlice(
    source,
    "primitiveFeaturePromotionStillCurrent",
  );
  const applyResourceGeneration = exactFunctionSlice(
    source,
    "applyFeatureResourceGeneration",
  );
  const uploadedContentMatches = exactFunctionSlice(
    source,
    "uploadedFeatureResourceContentMatches",
  );
  const allocate = exactFunctionSlice(source, "ensurePerFeaturePickGeneration");
  const wrapper = exactFunctionSlice(source, "ensurePerFeaturePickIds");
  const assertContains = (slice, name, fragment) => {
    assert.ok(slice.includes(fragment), name + " missing: " + fragment);
  };

  const requiredProvenanceKeys = [
    "device",
    "queue",
    "resourceGeneration",
    "compatibilityToken",
    "pipelineCache",
    "defaultTexture",
    "defaultSampler",
    "featureSampler",
    "runtimeNode",
    "nodeRevision",
    "primitive",
    "primitiveFeatureIds",
    "selectedDomain",
    "selectedSource",
    "selectedKind",
    "selectedRevision",
    "selectedPropertyTableId",
    "textureReader",
    "cesiumTexture",
    "stubNativeTexture",
    "textureSourceRevision",
    "featureTables",
    "featureTable",
    "featureTableRevision",
    "batchTexture",
    "batchTextureRevision",
    "batchOwner",
    "featuresLength",
    "batchDimensions",
    "batchStep",
    "batchValues",
    "batchValuesRevision",
    "batchContentRevision",
  ];
  for (const key of requiredProvenanceKeys) {
    assertContains(
      provenanceRegistry,
      "feature resource provenance registry",
      `"${key}",`,
    );
  }
  assertContains(
    provenanceComparator,
    "feature resource provenance comparator",
    "for (let i = 0; i < FEATURE_RESOURCE_PROVENANCE_KEYS.length; i++) {",
  );
  assertContains(
    provenanceComparator,
    "feature resource provenance comparator",
    "const key = FEATURE_RESOURCE_PROVENANCE_KEYS[i];",
  );
  assertContains(
    provenanceComparator,
    "feature resource provenance comparator",
    "if (ignoreContent && FEATURE_RESOURCE_CONTENT_KEYS.includes(key)) {",
  );
  assertContains(
    provenanceComparator,
    "feature resource provenance comparator",
    "if (!Object.is(left[key], right[key])) {",
  );

  const promotionCasIndexes = Array.from(
    promote.matchAll(/primitiveFeaturePromotionStillCurrent\(/g),
    (match) => match.index,
  );
  const viewIndex = promote.indexOf("const featurePickView");
  const entriesIndex = promote.indexOf("const promotedEntries");
  const writeIndex = promote.indexOf("device.queue.writeBuffer(");
  const generationEntriesIndex = promote.indexOf(
    "generation.entries = promotedEntries;",
  );
  const boundTextureIndex = promote.indexOf(
    "generation.featurePickBoundTexture = featurePickGeneration.texture;",
  );
  const boundGenerationIndex = promote.indexOf(
    "generation.featurePickBoundGeneration = featurePickGeneration;",
  );
  const applyIndex = promote.indexOf(
    "applyFeatureResourceGeneration(primCache, generation);",
  );
  const retireAfterPublishIndex = promote.indexOf(
    "destroyUnboundRetiredFeaturePickGenerations(",
    applyIndex,
  );

  assert.equal(promotionCasIndexes.length, 3);
  assert.ok(promotionCasIndexes[0] < viewIndex);
  assert.ok(viewIndex >= 0);
  assert.ok(promotionCasIndexes[1] > viewIndex);
  assert.ok(entriesIndex > promotionCasIndexes[1]);
  assert.ok(writeIndex > entriesIndex);
  assert.ok(promotionCasIndexes[2] > writeIndex);
  assert.ok(generationEntriesIndex > promotionCasIndexes[2]);
  assert.ok(boundTextureIndex > generationEntriesIndex);
  assert.ok(boundGenerationIndex > boundTextureIndex);
  assert.ok(applyIndex > boundGenerationIndex);
  assert.ok(retireAfterPublishIndex > applyIndex);
  assert.match(promote, /const promotedEntries = currentEntries\.slice\(\);/);
  assert.match(promote, /binding: 31,\s*resource: featurePickView,/);
  assert.match(
    promote,
    /const featurePickView = featurePickGeneration\.texture\.createView\(\);\s*if \(\s*!primitiveFeaturePromotionStillCurrent\(/,
  );
  assert.match(
    promote,
    /FEATURE_PICK_ENABLED_DATA,\s*\);\s*if \(\s*!primitiveFeaturePromotionStillCurrent\(/,
  );
  assertContains(
    primitivePromotionCurrent,
    "primitive promotion currentness",
    "primCache._featureResourcesDestroyed !== true",
  );
  assertContains(
    primitivePromotionCurrent,
    "primitive promotion currentness",
    "primCache._featureIdGeneration === generation",
  );
  assertContains(
    primitivePromotionCurrent,
    "primitive promotion currentness",
    "(primCache._featureIdPublicationEpoch ?? 0) === publicationEpoch",
  );
  assertContains(
    primitivePromotionCurrent,
    "primitive promotion currentness",
    "primCache._featureIdEntries === entries",
  );
  assertContains(
    primitivePromotionCurrent,
    "primitive promotion currentness",
    "primCache._featureUniformBuffer === uniformBuffer",
  );
  assertContains(
    primitivePromotionCurrent,
    "primitive promotion currentness",
    "generation?.entries === entries",
  );
  assertContains(
    primitivePromotionCurrent,
    "primitive promotion currentness",
    "generation?.uniformBuffer === uniformBuffer",
  );
  assertContains(
    primitivePromotionCurrent,
    "primitive promotion currentness",
    "featurePickGenerationIsCurrent(modelCache, featurePickGeneration)",
  );
  assertContains(
    pickGenerationCurrent,
    "pick generation currentness",
    "cache?._featurePickResourcesDestroyed !== true",
  );
  assertContains(
    pickGenerationCurrent,
    "pick generation currentness",
    "cache?._featurePickGeneration === generation",
  );
  assertContains(
    pickGenerationCurrent,
    "pick generation currentness",
    "generation?.publicationEpoch",
  );
  assertContains(
    pickGenerationCurrent,
    "pick generation currentness",
    "cache?._featurePickGPUTexture === generation?.texture",
  );
  assertContains(
    pickGenerationCurrent,
    "pick generation currentness",
    "cache?._featurePickIds === generation?.pickIds",
  );
  assertContains(
    applyResourceGeneration,
    "feature resource publication",
    "primCache._featurePickGPUTexture = generation?.featurePickBoundTexture;",
  );
  assertContains(
    applyResourceGeneration,
    "feature resource publication",
    "primCache._featurePickBoundGPUTexture = generation?.featurePickBoundTexture;",
  );
  assertContains(
    applyResourceGeneration,
    "feature resource publication",
    "primCache._featurePickBoundGeneration =\n    generation?.featurePickBoundGeneration;",
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
  assert.match(candidate, /uniformData\[10\] = 0\.0;/);
  assert.match(
    candidate,
    /resource: provenance\.defaultTexture\.createView\(\),/,
  );
  assert.match(attempt, /if \(pickPassActive === true/);
  assert.doesNotMatch(attempt, /void pickPassActive/);
  assert.match(
    generation,
    /ensureFeatureIdResourcesAttempt\([\s\S]*?pickPassActive,\s*compatibilityToken,\s*callerDepth,\s*\)/,
  );
  const reserveIndex = retireBase.indexOf(
    "primCache._scheduledFeatureIdGenerations.add(generation);",
  );
  const enqueueIndex = retireBase.indexOf("enqueue.call(context, encoder");
  assert.match(retireBase, /const encoder = context\?\.currentCommandEncoder;/);
  assert.match(
    retireBase,
    /const enqueue = context\?\.enqueueAfterCommandEncoderSubmit;/,
  );
  assert.ok(reserveIndex >= 0);
  assert.ok(enqueueIndex > reserveIndex);
  assert.match(
    retireBase,
    /settlement = generation\.queue\.onSubmittedWorkDone\(\);/,
  );
  assert.match(
    retireBase,
    /settlement\.then\(\s*function \(\) \{[\s\S]*?destroyFeatureResourceGeneration\(generation\);/,
  );
  assert.match(
    retireBase,
    /primCache\._retiredFeatureIdGenerations\.add\(generation\);/,
  );

  const matchTerms = [
    "defined(generation)",
    "generation.destroyed !== true",
    "generation.device === device",
    "generation.queue === queue",
    "generation.context === context",
    "Object.is(generation.resourceGeneration, resourceGeneration)",
    "generation.batchTexture === batchTexture",
    "generation.owner === owner",
    "generation.ownerGetFeature === ownerGetFeature",
    "generation.createPickId === createPickId",
    "generation.dimensions === dimensions",
    "generation.featuresLength === featuresLength",
    "generation.width === width",
    "generation.height === height",
  ];
  for (const term of matchTerms) {
    assertContains(matchPickGeneration, "pick generation input match", term);
  }
  assert.match(
    allocate,
    /featurePickGenerationMatchesInputs\(\s*incumbent,\s*device,\s*queue,\s*context,\s*resourceGeneration,\s*batchTexture,\s*owner,\s*ownerGetFeature,\s*createPickId,\s*dimensions,\s*width,\s*height,\s*featuresLength,\s*\)/,
  );

  const liveTerms = [
    "cache._featurePickResourcesDestroyed !== true",
    "cache._featurePickGeneration === incumbent",
    "(cache._featurePickPublicationEpoch ?? 0) === publicationEpoch",
    "device.queue === queue",
    "context.createPickId === createPickId",
    "Object.is(context.resourceGeneration, resourceGeneration)",
    "batchTexture._owner === owner",
    "owner?.getFeature === ownerGetFeature",
    "batchTexture._featuresLength === featuresLength",
    "batchTexture._textureDimensions === dimensions",
    "dimensions.x === width",
    "dimensions.y === height",
  ];
  for (const term of liveTerms) {
    assertContains(livePickInputs, "live pick input CAS", term);
  }
  assert.match(
    allocate,
    /featurePickInputsRemainCurrent\(\s*cache,\s*incumbent,\s*publicationEpoch,\s*device,\s*queue,\s*context,\s*createPickId,\s*resourceGeneration,\s*batchTexture,\s*owner,\s*ownerGetFeature,\s*dimensions,\s*width,\s*height,\s*featuresLength,\s*\)/,
  );

  const capacityTerms = [
    "const texelCount = width * height;",
    "const byteLength = texelCount * 4;",
    "!Number.isSafeInteger(width)",
    "!Number.isSafeInteger(height)",
    "!Number.isSafeInteger(texelCount)",
    "texelCount < featuresLength",
    "!Number.isSafeInteger(byteLength)",
    "const data = new Uint8Array(byteLength);",
    "size: [width, height, 1],",
    "{ bytesPerRow: width * 4, rowsPerImage: height },",
    "{ width, height, depthOrArrayLayers: 1 },",
  ];
  for (const term of capacityTerms) {
    assertContains(allocate, "captured dense allocation", term);
  }

  const reuseTerms = [
    "incumbent?.batchTexture === batchTexture",
    "incumbent?.owner === owner",
    "incumbent?.context === context",
    "incumbent?.ownerGetFeature === ownerGetFeature",
    "incumbent?.createPickId === createPickId",
    "ownerGetFeature.call(owner, fid)",
    'createPickId.call(context, target, "tile-feature")',
    "canReusePreviousPickIds ? previousPickIds?.get(fid) : undefined",
  ];
  for (const term of reuseTerms) {
    assertContains(allocate, "pick ID reuse provenance", term);
  }

  const createTextureIndex = allocate.indexOf("tex = device.createTexture(");
  const uploadIndex = allocate.indexOf("device.queue.writeTexture(");
  const uploadFailureCleanupIndex = allocate.indexOf(
    "destroyProvisionalFeaturePickGeneration({",
  );
  const candidateIndex = allocate.indexOf("const candidate = {");
  const liveCasIndex = allocate.indexOf("!featurePickInputsRemainCurrent(");
  const staleCleanupIndex = allocate.indexOf(
    "destroyProvisionalFeaturePickGeneration(candidate);",
  );
  const epochPublishIndex = allocate.indexOf(
    "cache._featurePickPublicationEpoch = candidate.publicationEpoch;",
  );
  const detachCreatedIdsIndex = allocate.indexOf(
    "candidate.createdPickIds = undefined;",
  );
  const applyPickIndex = allocate.indexOf(
    "applyFeaturePickGeneration(cache, candidate);",
  );
  const retirementIndex = allocate.indexOf("const retiredPickIds = new Set();");
  assert.ok(createTextureIndex >= 0);
  assert.ok(uploadIndex > createTextureIndex);
  assert.ok(uploadFailureCleanupIndex > uploadIndex);
  assert.ok(candidateIndex > uploadFailureCleanupIndex);
  assert.ok(liveCasIndex > candidateIndex);
  assert.ok(staleCleanupIndex > liveCasIndex);
  assert.ok(epochPublishIndex > staleCleanupIndex);
  assert.ok(detachCreatedIdsIndex > epochPublishIndex);
  assert.ok(applyPickIndex > detachCreatedIdsIndex);
  assert.ok(retirementIndex > applyPickIndex);
  assertContains(
    allocate,
    "pick generation publication",
    "publicationEpoch: publicationEpoch + 1,",
  );
  assertContains(
    allocate,
    "pick generation stale candidate",
    "return FEATURE_RESOURCE_RETRY;",
  );
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
  assert.doesNotMatch(allocate, /previousTexture\.destroy\(\)/);

  const pickAliases = [
    "cache._featurePickGeneration = generation;",
    "cache._featurePickIds = generation?.pickIds;",
    "cache._featurePickGPUTexture = generation?.texture;",
    "cache._featurePickBatchTexture = generation?.batchTexture;",
    "cache._featurePickFeaturesLength = generation?.featuresLength;",
    "cache._featurePickTextureWidth = generation?.width;",
    "cache._featurePickTextureHeight = generation?.height;",
    "cache._featurePickDevice = generation?.device;",
    "cache._featurePickQueue = generation?.queue;",
    "cache._featurePickContext = generation?.context;",
    "cache._featurePickResourceGeneration = generation?.resourceGeneration;",
    "cache._featurePickOwner = generation?.owner;",
    "cache._featurePickCreatePickId = generation?.createPickId;",
  ];
  for (const alias of pickAliases) {
    assertContains(
      applyPickGeneration,
      "pick generation publication alias",
      alias,
    );
  }

  const tombstoneIndex = destroyProvisionalPickGeneration.indexOf(
    "candidate.destroyed = true;",
  );
  const captureTextureIndex = destroyProvisionalPickGeneration.indexOf(
    "const texture = candidate.texture;",
  );
  const captureCreatedIdsIndex = destroyProvisionalPickGeneration.indexOf(
    "const createdPickIds = candidate.createdPickIds;",
  );
  const detachTextureIndex = destroyProvisionalPickGeneration.indexOf(
    "candidate.texture = undefined;",
  );
  const detachPickIdsIndex = destroyProvisionalPickGeneration.indexOf(
    "candidate.pickIds = undefined;",
  );
  const detachCreatedIndex = destroyProvisionalPickGeneration.indexOf(
    "candidate.createdPickIds = undefined;",
  );
  const destroyTextureIndex = destroyProvisionalPickGeneration.indexOf(
    "texture?.destroy();",
  );
  const destroyCreatedIdsIndex = destroyProvisionalPickGeneration.indexOf(
    "createdPickIds[i].destroy();",
  );
  const drainCreatedIdsIndex = destroyProvisionalPickGeneration.indexOf(
    "createdPickIds.length = 0;",
  );
  assert.ok(tombstoneIndex >= 0);
  assert.ok(captureTextureIndex > tombstoneIndex);
  assert.ok(captureCreatedIdsIndex > captureTextureIndex);
  assert.ok(detachTextureIndex > captureCreatedIdsIndex);
  assert.ok(detachPickIdsIndex > detachTextureIndex);
  assert.ok(detachCreatedIndex > detachPickIdsIndex);
  assert.ok(destroyTextureIndex > detachCreatedIndex);
  assert.ok(destroyCreatedIdsIndex > destroyTextureIndex);
  assert.ok(drainCreatedIdsIndex > destroyCreatedIdsIndex);

  assertContains(
    candidate,
    "feature resource upload witness",
    "uploadedBatchValues: provenance.batchValues,",
  );
  assertContains(
    candidate,
    "feature resource upload witness",
    "uploadedBatchContentRevision: provenance.batchContentRevision,",
  );
  assertContains(
    uploadedContentMatches,
    "uploaded content comparator",
    "Object.is(generation.uploadedBatchValues, provenance.batchValues)",
  );
  assertContains(
    uploadedContentMatches,
    "uploaded content comparator",
    "generation.uploadedBatchContentRevision",
  );
  assertContains(
    uploadedContentMatches,
    "uploaded content comparator",
    "provenance.batchContentRevision",
  );
  assertContains(
    attempt,
    "uploaded content refresh gate",
    "const uploadedContentChanged = !uploadedFeatureResourceContentMatches(",
  );
  assertContains(
    attempt,
    "uploaded content refresh gate",
    "contentChanged || uploadedContentChanged || accepted.batchDirty === true",
  );
  const nativeRefreshIndex = attempt.indexOf("!updateBatchGPUTexture(");
  const acceptedValuesIndex = attempt.indexOf(
    "incumbent.uploadedBatchValues = accepted.batchValues;",
  );
  const acceptedRevisionIndex = attempt.indexOf(
    "incumbent.uploadedBatchContentRevision = accepted.batchContentRevision;",
  );
  const postRefreshIndex = attempt.indexOf(
    "const postRefresh = observeFeatureResourcePair(",
  );
  assert.ok(nativeRefreshIndex >= 0);
  assert.ok(acceptedValuesIndex > nativeRefreshIndex);
  assert.ok(acceptedRevisionIndex > acceptedValuesIndex);
  assert.ok(postRefreshIndex > acceptedRevisionIndex);

  assert.match(
    wrapper,
    /const generation = ensurePerFeaturePickGeneration\(\s*device,\s*primCache,\s*cache,\s*context,\s*model,\s*batchTexture,\s*\);/,
  );
  assert.match(
    wrapper,
    /return generation === FEATURE_RESOURCE_RETRY \? null : generation\?\.texture;/,
  );
  assert.doesNotMatch(
    wrapper,
    /createTexture|writeTexture|createPickId\.call|applyFeaturePickGeneration/,
  );
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

function replaceOnceInFunction(source, name, before, after) {
  const originalFunction = exactFunctionSlice(source, name);
  const mutatedFunction = replaceOnce(originalFunction, before, after);
  return source.replace(originalFunction, mutatedFunction);
}

function replaceOnceInFrozenArray(source, name, before, after) {
  const originalArray = exactFrozenArraySlice(source, name);
  const mutatedArray = replaceOnce(originalArray, before, after);
  return source.replace(originalArray, mutatedArray);
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
    replaceOnce(rendererSource, "encodeFeatureIdCompatibilityToken(", "(("),
    replaceOnce(
      rendererSource,
      "if (featureIdRes === null) {\n        continue;\n      }",
      "if (featureIdRes === null) {\n        void featureIdRes;\n      }",
    ),
    replaceOnce(rendererSource, "models[i] = entry;", "models.push(entry);"),
  ];
  for (const mutant of rendererMutants) {
    assert.throws(() => enforceRendererPolicy(mutant));
  }

  const provenanceKeyMutants = [
    "device",
    "queue",
    "resourceGeneration",
    "compatibilityToken",
    "pipelineCache",
    "defaultTexture",
    "defaultSampler",
    "runtimeNode",
    "primitiveFeatureIds",
    "selectedDomain",
    "selectedSource",
    "selectedPropertyTableId",
    "textureReader",
    "stubNativeTexture",
    "featureTable",
    "batchTexture",
    "batchOwner",
    "featuresLength",
    "batchDimensions",
    "batchStep",
    "batchValues",
    "batchContentRevision",
  ].map((key) =>
    replaceOnceInFrozenArray(
      featureIdSource,
      "FEATURE_RESOURCE_PROVENANCE_KEYS",
      `  "${key}",\n`,
      "",
    ),
  );
  const featureMutants = [
    ...provenanceKeyMutants,
    replaceOnceInFunction(
      featureIdSource,
      "sameFeatureResourceProvenance",
      "for (let i = 0; i < FEATURE_RESOURCE_PROVENANCE_KEYS.length; i++) {",
      "for (let i = 0; i < 0; i++) {",
    ),
    replaceOnce(
      featureIdSource,
      "uniformData[10] = 0.0;",
      "uniformData[10] = 1.0;",
    ),
    replaceOnce(
      featureIdSource,
      "generation.entries = promotedEntries;",
      "generation.entries = currentEntries;",
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
      "const encoder = context?.currentCommandEncoder;",
      "const encoder = undefined;",
    ),
    replaceOnce(
      featureIdSource,
      "settlement = generation.queue.onSubmittedWorkDone();",
      "settlement = Promise.resolve();",
    ),
    replaceOnce(
      featureIdSource,
      "primCache._scheduledFeatureIdGenerations.add(generation);",
      "void generation;",
    ),
    replaceOnce(
      featureIdSource,
      "    } else {\n      primCache._retiredFeatureIdGenerations ??= new Set();\n      primCache._retiredFeatureIdGenerations.add(generation);\n    }",
      "    } else {\n      primCache._retiredFeatureIdGenerations ??= new Set();\n      void generation;\n    }",
    ),
    replaceOnceInFunction(
      featureIdSource,
      "featurePickGenerationMatchesInputs",
      "generation.device === device &&",
      "true &&",
    ),
    replaceOnceInFunction(
      featureIdSource,
      "featurePickGenerationMatchesInputs",
      "generation.queue === queue &&",
      "true &&",
    ),
    replaceOnceInFunction(
      featureIdSource,
      "featurePickGenerationMatchesInputs",
      "generation.context === context &&",
      "true &&",
    ),
    replaceOnceInFunction(
      featureIdSource,
      "featurePickGenerationMatchesInputs",
      "Object.is(generation.resourceGeneration, resourceGeneration) &&",
      "true &&",
    ),
    replaceOnceInFunction(
      featureIdSource,
      "featurePickGenerationMatchesInputs",
      "generation.batchTexture === batchTexture &&",
      "true &&",
    ),
    replaceOnceInFunction(
      featureIdSource,
      "featurePickGenerationMatchesInputs",
      "generation.owner === owner &&",
      "true &&",
    ),
    replaceOnceInFunction(
      featureIdSource,
      "featurePickGenerationMatchesInputs",
      "generation.ownerGetFeature === ownerGetFeature &&",
      "true &&",
    ),
    replaceOnceInFunction(
      featureIdSource,
      "featurePickGenerationMatchesInputs",
      "generation.createPickId === createPickId &&",
      "true &&",
    ),
    replaceOnceInFunction(
      featureIdSource,
      "featurePickGenerationMatchesInputs",
      "generation.dimensions === dimensions &&",
      "true &&",
    ),
    replaceOnceInFunction(
      featureIdSource,
      "featurePickGenerationMatchesInputs",
      "generation.featuresLength === featuresLength &&",
      "true &&",
    ),
    replaceOnceInFunction(
      featureIdSource,
      "featurePickGenerationMatchesInputs",
      "generation.width === width &&",
      "true &&",
    ),
    replaceOnceInFunction(
      featureIdSource,
      "featurePickGenerationMatchesInputs",
      "generation.height === height",
      "true",
    ),
    replaceOnceInFunction(
      featureIdSource,
      "ensurePerFeaturePickGeneration",
      "texelCount < featuresLength ||",
      "false ||",
    ),
    replaceOnceInFunction(
      featureIdSource,
      "ensurePerFeaturePickGeneration",
      "    device.queue.writeTexture(\n      { texture: tex },",
      "    void (\n      { texture: tex },",
    ),
    replaceOnceInFunction(
      featureIdSource,
      "ensurePerFeaturePickGeneration",
      "incumbent?.owner === owner &&",
      "true &&",
    ),
    replaceOnceInFunction(
      featureIdSource,
      "ensurePerFeaturePickGeneration",
      "incumbent?.ownerGetFeature === ownerGetFeature &&",
      "true &&",
    ),
    replaceOnceInFunction(
      featureIdSource,
      "ensurePerFeaturePickGeneration",
      "incumbent?.createPickId === createPickId;",
      "true;",
    ),
    replaceOnceInFunction(
      featureIdSource,
      "featurePickInputsRemainCurrent",
      "cache._featurePickGeneration === incumbent &&",
      "true &&",
    ),
    replaceOnceInFunction(
      featureIdSource,
      "featurePickInputsRemainCurrent",
      "(cache._featurePickPublicationEpoch ?? 0) === publicationEpoch &&",
      "true &&",
    ),
    replaceOnceInFunction(
      featureIdSource,
      "featurePickInputsRemainCurrent",
      "device.queue === queue &&",
      "true &&",
    ),
    replaceOnceInFunction(
      featureIdSource,
      "featurePickInputsRemainCurrent",
      "context.createPickId === createPickId &&",
      "true &&",
    ),
    replaceOnceInFunction(
      featureIdSource,
      "featurePickInputsRemainCurrent",
      "Object.is(context.resourceGeneration, resourceGeneration) &&",
      "true &&",
    ),
    replaceOnceInFunction(
      featureIdSource,
      "featurePickInputsRemainCurrent",
      "batchTexture._owner === owner &&",
      "true &&",
    ),
    replaceOnceInFunction(
      featureIdSource,
      "featurePickInputsRemainCurrent",
      "owner?.getFeature === ownerGetFeature &&",
      "true &&",
    ),
    replaceOnceInFunction(
      featureIdSource,
      "featurePickInputsRemainCurrent",
      "batchTexture._featuresLength === featuresLength &&",
      "true &&",
    ),
    replaceOnceInFunction(
      featureIdSource,
      "featurePickInputsRemainCurrent",
      "batchTexture._textureDimensions === dimensions &&",
      "true &&",
    ),
    replaceOnceInFunction(
      featureIdSource,
      "featurePickInputsRemainCurrent",
      "dimensions.x === width &&",
      "true &&",
    ),
    replaceOnceInFunction(
      featureIdSource,
      "featurePickInputsRemainCurrent",
      "dimensions.y === height",
      "true",
    ),
    replaceOnceInFunction(
      featureIdSource,
      "ensurePerFeaturePickGeneration",
      "cache._featurePickPublicationEpoch = candidate.publicationEpoch;",
      "void candidate.publicationEpoch;",
    ),
    replaceOnceInFunction(
      featureIdSource,
      "primitiveFeaturePromotionStillCurrent",
      "primCache._featureResourcesDestroyed !== true &&",
      "true &&",
    ),
    replaceOnceInFunction(
      featureIdSource,
      "primitiveFeaturePromotionStillCurrent",
      "primCache._featureIdGeneration === generation &&",
      "true &&",
    ),
    replaceOnceInFunction(
      featureIdSource,
      "primitiveFeaturePromotionStillCurrent",
      "(primCache._featureIdPublicationEpoch ?? 0) === publicationEpoch &&",
      "true &&",
    ),
    replaceOnceInFunction(
      featureIdSource,
      "primitiveFeaturePromotionStillCurrent",
      "primCache._featureIdEntries === entries &&",
      "true &&",
    ),
    replaceOnceInFunction(
      featureIdSource,
      "primitiveFeaturePromotionStillCurrent",
      "primCache._featureUniformBuffer === uniformBuffer &&",
      "true &&",
    ),
    replaceOnceInFunction(
      featureIdSource,
      "primitiveFeaturePromotionStillCurrent",
      "generation?.entries === entries &&",
      "true &&",
    ),
    replaceOnceInFunction(
      featureIdSource,
      "primitiveFeaturePromotionStillCurrent",
      "generation?.uniformBuffer === uniformBuffer &&",
      "true &&",
    ),
    replaceOnceInFunction(
      featureIdSource,
      "primitiveFeaturePromotionStillCurrent",
      "featurePickGenerationIsCurrent(modelCache, featurePickGeneration)",
      "true",
    ),
    replaceOnceInFunction(
      featureIdSource,
      "promoteFeaturePickResources",
      "const featurePickView = featurePickGeneration.texture.createView();\n  if (\n    !primitiveFeaturePromotionStillCurrent(",
      "const featurePickView = featurePickGeneration.texture.createView();\n  if (\n    false &&\n    !primitiveFeaturePromotionStillCurrent(",
    ),
    replaceOnceInFunction(
      featureIdSource,
      "promoteFeaturePickResources",
      "    FEATURE_PICK_ENABLED_DATA,\n  );\n  if (\n    !primitiveFeaturePromotionStillCurrent(",
      "    FEATURE_PICK_ENABLED_DATA,\n  );\n  if (\n    false &&\n    !primitiveFeaturePromotionStillCurrent(",
    ),
    replaceOnceInFunction(
      featureIdSource,
      "promoteFeaturePickResources",
      "generation.featurePickBoundTexture = featurePickGeneration.texture;",
      "generation.featurePickBoundTexture = undefined;",
    ),
    replaceOnceInFunction(
      featureIdSource,
      "promoteFeaturePickResources",
      "generation.featurePickBoundGeneration = featurePickGeneration;",
      "generation.featurePickBoundGeneration = undefined;",
    ),
    replaceOnceInFunction(
      featureIdSource,
      "applyFeatureResourceGeneration",
      "primCache._featurePickBoundGeneration =\n    generation?.featurePickBoundGeneration;",
      "primCache._featurePickBoundGeneration = undefined;",
    ),
    replaceOnceInFunction(
      featureIdSource,
      "destroyProvisionalFeaturePickGeneration",
      "candidate.texture = undefined;",
      "void candidate.texture;",
    ),
    replaceOnceInFunction(
      featureIdSource,
      "destroyProvisionalFeaturePickGeneration",
      "candidate.pickIds = undefined;",
      "void candidate.pickIds;",
    ),
    replaceOnceInFunction(
      featureIdSource,
      "destroyProvisionalFeaturePickGeneration",
      "candidate.createdPickIds = undefined;",
      "void candidate.createdPickIds;",
    ),
    replaceOnceInFunction(
      featureIdSource,
      "destroyProvisionalFeaturePickGeneration",
      "texture?.destroy();",
      "void texture;",
    ),
    replaceOnceInFunction(
      featureIdSource,
      "destroyProvisionalFeaturePickGeneration",
      "createdPickIds[i].destroy();",
      "void createdPickIds[i];",
    ),
    replaceOnceInFunction(
      featureIdSource,
      "createFeatureResourceCandidate",
      "uploadedBatchValues: provenance.batchValues,",
      "uploadedBatchValues: undefined,",
    ),
    replaceOnceInFunction(
      featureIdSource,
      "createFeatureResourceCandidate",
      "uploadedBatchContentRevision: provenance.batchContentRevision,",
      "uploadedBatchContentRevision: undefined,",
    ),
    replaceOnceInFunction(
      featureIdSource,
      "uploadedFeatureResourceContentMatches",
      "Object.is(generation.uploadedBatchValues, provenance.batchValues)",
      "true",
    ),
    replaceOnceInFunction(
      featureIdSource,
      "uploadedFeatureResourceContentMatches",
      "Object.is(\n      generation.uploadedBatchContentRevision,\n      provenance.batchContentRevision,\n    )",
      "true",
    ),
    replaceOnceInFunction(
      featureIdSource,
      "ensureFeatureIdResourcesAttempt",
      "contentChanged || uploadedContentChanged || accepted.batchDirty === true",
      "contentChanged || false || accepted.batchDirty === true",
    ),
    replaceOnceInFunction(
      featureIdSource,
      "ensureFeatureIdResourcesAttempt",
      "incumbent.uploadedBatchValues = accepted.batchValues;",
      "void accepted.batchValues;",
    ),
    replaceOnceInFunction(
      featureIdSource,
      "ensureFeatureIdResourcesAttempt",
      "incumbent.uploadedBatchContentRevision = accepted.batchContentRevision;",
      "void accepted.batchContentRevision;",
    ),
    replaceOnceInFunction(
      featureIdSource,
      "ensureFeatureIdResourcesAttempt",
      "const postRefresh = observeFeatureResourcePair(",
      "const postRefresh = void observeFeatureResourcePair(",
    ),
    replaceOnceInFunction(
      featureIdSource,
      "ensurePerFeaturePickIds",
      "const generation = ensurePerFeaturePickGeneration(",
      "const generation = void ensurePerFeaturePickGeneration(",
    ),
    replaceOnceInFunction(
      featureIdSource,
      "ensurePerFeaturePickIds",
      "return generation === FEATURE_RESOURCE_RETRY ? null : generation?.texture;",
      "return generation?.texture;",
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
