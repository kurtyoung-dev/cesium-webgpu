import {
  createBatchGPUTexture,
  createFeatureIdGPUTexture,
  destroyFeatureIdResources,
  destroyPerFeaturePickResources,
  ensureFeatureIdResources,
  ensurePerFeaturePickIds,
  getSelectedImplicitFeatureId,
  synthesizeImplicitFeatureIdData,
} from "../../../Source/Renderer/WebGPU/WebGPUModelFeatureId.js";
import ModelComponents from "../../../Source/Scene/ModelComponents.js";

// C9-17 Slice C (invariant 4) — certifies that the implicit feature-ID lookup is
// allocation-free: it returns the EXACT selected FeatureIdImplicitRange instance
// (no wrapper object) or a literal null, and the per-vertex synthesis honors the
// EXT_mesh_features offset/repeat rule. Spec-only; no product change expected.

const { FeatureIdImplicitRange, FeatureIdAttribute, FeatureIdTexture } =
  ModelComponents;

function makeFailingTextureDevice(uploadMethod) {
  const candidates = [];
  const device = {
    createTexture() {
      const candidate = {
        destroy: jasmine.createSpy("candidate.destroy"),
      };
      candidates.push(candidate);
      return candidate;
    },
    queue: {
      copyExternalImageToTexture() {
        if (uploadMethod === "copy") {
          throw new Error("copy upload failed");
        }
      },
      writeTexture() {
        if (uploadMethod === "write") {
          throw new Error("byte upload failed");
        }
      },
    },
  };
  return { device, candidates };
}

function makeFeatureResourceHarness(options = {}) {
  const textures = [];
  const buffers = [];
  const bufferWrites = [];
  const pickIds = [];
  let failPromotionWriteCount = options.failPromotionWriteCount ?? 0;
  let failFeaturePickViewCount = options.failFeaturePickViewCount ?? 0;

  function makeTexture(descriptor) {
    const texture = {
      descriptor,
      destroy: jasmine.createSpy(`${descriptor.label}.destroy`),
      createView: function () {
        if (
          descriptor.label.startsWith("Feature pick texture") &&
          failFeaturePickViewCount > 0
        ) {
          failFeaturePickViewCount--;
          throw new Error("feature pick view failed");
        }
        return { texture: texture };
      },
    };
    textures.push(texture);
    return texture;
  }

  const fallbackTexture = makeTexture({ label: "fallback white" });
  const device = {
    createTexture: makeTexture,
    createBuffer: function (descriptor) {
      const buffer = {
        descriptor,
        destroy: jasmine.createSpy(`${descriptor.label}.destroy`),
      };
      buffers.push(buffer);
      return buffer;
    },
    queue: {
      writeTexture: function () {},
      writeBuffer: function (buffer, offset, data) {
        if (offset === 40 && failPromotionWriteCount > 0) {
          failPromotionWriteCount--;
          throw new Error("feature pick uniform write failed");
        }
        bufferWrites.push({ buffer, offset, values: Array.from(data) });
      },
    },
  };
  const context = {
    resourceGeneration: 0,
    createPickId: function (target, kind) {
      const index = pickIds.length + 1;
      const pickId = {
        target,
        kind,
        color: {
          red: index / 255,
          green: 0,
          blue: 0,
          alpha: 1,
        },
        destroy: jasmine.createSpy("pickId.destroy"),
      };
      pickIds.push(pickId);
      return pickId;
    },
  };
  const batchTexture = {
    _featuresLength: 2,
    _textureDimensions: { x: 2, y: 1 },
    textureDimensions: { x: 2, y: 1 },
    textureStep: { x: 0.5, y: 1.0, z: 0.25, w: 0.5 },
    _batchValues: new Uint8Array(8).fill(255),
    _owner: {
      getFeature: function (featureId) {
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
  const primitive = { featureIds: [new FeatureIdAttribute()] };
  const runtimeNode = { node: undefined };
  const pipelineCache = {
    defaultWhiteTexture: fallbackTexture,
    defaultSampler: { label: "default sampler" },
    propertyTextureSampler: { label: "nearest sampler" },
  };
  const modelCache = {};

  function ensure(primCache, pickDemand) {
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
  }

  return {
    batchTexture,
    bufferWrites,
    buffers,
    context,
    ensure,
    failNextFeaturePickView: function () {
      failFeaturePickViewCount++;
    },
    failNextPromotionWrite: function () {
      failPromotionWriteCount++;
    },
    fallbackTexture,
    model,
    modelCache,
    pickIds,
    textures,
  };
}

function replaceBatchTextureOwner(harness, source = "replacement") {
  const replacementFeatures = [
    { source, featureId: 0 },
    { source, featureId: 1 },
  ];
  const replacementBatchTexture = {
    ...harness.batchTexture,
    _owner: {
      getFeature: function (featureId) {
        return replacementFeatures[featureId];
      },
    },
  };
  harness.model.featureTables[0].batchTexture = replacementBatchTexture;
  return { replacementBatchTexture, replacementFeatures };
}

describe("Renderer/WebGPU/WebGPUModelFeatureId feature texture construction", function () {
  it("destroys an unpublished feature-ID texture after copy failure", function () {
    const { device, candidates } = makeFailingTextureDevice("copy");
    const reader = { texture: { _source: { width: 2, height: 2 } } };

    expect(createFeatureIdGPUTexture(device, 4, reader)).toBeNull();
    expect(candidates.length).toBe(1);
    expect(candidates[0].destroy).toHaveBeenCalledTimes(1);
  });

  it("destroys an unpublished byte-backed batch texture after write failure", function () {
    const { device, candidates } = makeFailingTextureDevice("write");
    const batchTexture = {
      _batchValues: new Uint8Array(16),
      _textureDimensions: { x: 2, y: 2 },
    };

    expect(createBatchGPUTexture(device, batchTexture)).toBeNull();
    expect(candidates.length).toBe(1);
    expect(candidates[0].destroy).toHaveBeenCalledTimes(1);
  });

  it("destroys an unpublished image-backed batch texture after copy failure", function () {
    const { device, candidates } = makeFailingTextureDevice("copy");
    const batchTexture = {
      batchTexture: { _source: { width: 2, height: 2 } },
    };

    expect(createBatchGPUTexture(device, batchTexture)).toBeNull();
    expect(candidates.length).toBe(1);
    expect(candidates[0].destroy).toHaveBeenCalledTimes(1);
  });

  it("rolls back unpublished per-feature pick IDs and texture after upload failure", function () {
    const { device, candidates } = makeFailingTextureDevice("write");
    const pickIds = [];
    const context = {
      createPickId: function () {
        const pickId = {
          color: { red: 0, green: 0, blue: 0, alpha: 1 },
          destroy: jasmine.createSpy("pickId.destroy"),
        };
        pickIds.push(pickId);
        return pickId;
      },
    };
    const primCache = {};
    const cache = {};

    expect(function () {
      ensurePerFeaturePickIds(
        device,
        primCache,
        cache,
        context,
        {},
        {
          _featuresLength: 2,
          _textureDimensions: { x: 2, y: 1 },
        },
      );
    }).toThrowError("byte upload failed");

    expect(candidates.length).toBe(1);
    expect(candidates[0].destroy).toHaveBeenCalledTimes(1);
    expect(pickIds.length).toBe(2);
    expect(pickIds[0].destroy).toHaveBeenCalledTimes(1);
    expect(pickIds[1].destroy).toHaveBeenCalledTimes(1);
    expect(cache._featurePickIds).toBeUndefined();
    expect(cache._featurePickGPUTexture).toBeUndefined();
    expect(cache._featurePickFeaturesLength).toBeUndefined();
    expect(primCache._featurePickGPUTexture).toBeUndefined();
  });

  it("keeps ordinary feature styling resources and promotes picking once on demand", function () {
    const harness = makeFeatureResourceHarness();
    const primCache = {};

    const cold = harness.ensure(primCache, false);
    const coldEntries = cold.featureIdEntries;
    const coldPickEntry = coldEntries.find((entry) => entry.binding === 31);

    expect(coldPickEntry.resource.texture).toBe(harness.fallbackTexture);
    expect(harness.pickIds.length).toBe(0);
    expect(harness.modelCache._featurePickIds).toBeUndefined();
    expect(harness.modelCache._featurePickGPUTexture).toBeUndefined();
    expect(harness.bufferWrites.length).toBe(1);
    expect(harness.bufferWrites[0].offset).toBe(0);
    expect(harness.bufferWrites[0].values[10]).toBe(0);

    const firstPick = harness.ensure(primCache, true);
    const promotedEntries = firstPick.featureIdEntries;
    const promotedPickEntry = promotedEntries.find(
      (entry) => entry.binding === 31,
    );

    expect(harness.pickIds.length).toBe(2);
    expect(harness.pickIds.map((pickId) => pickId.kind)).toEqual([
      "tile-feature",
      "tile-feature",
    ]);
    expect(harness.pickIds.map((pickId) => pickId.target.featureId)).toEqual([
      0, 1,
    ]);
    expect(promotedEntries).not.toBe(coldEntries);
    expect(promotedPickEntry.resource.texture).toBe(
      harness.modelCache._featurePickGPUTexture,
    );
    for (let i = 0; i < coldEntries.length; i++) {
      if (coldEntries[i].binding !== 31) {
        expect(promotedEntries[i]).toBe(coldEntries[i]);
      }
    }
    expect(harness.bufferWrites.length).toBe(2);
    expect(harness.bufferWrites[1].offset).toBe(40);
    expect(harness.bufferWrites[1].values).toEqual([1]);

    const textureCount = harness.textures.length;
    const repeatPick = harness.ensure(primCache, true);
    expect(repeatPick.featureIdEntries).toBe(promotedEntries);
    expect(harness.pickIds.length).toBe(2);
    expect(harness.textures.length).toBe(textureCount);
    expect(harness.bufferWrites.length).toBe(2);

    destroyFeatureIdResources(primCache);
    expect(primCache._featurePickBoundGPUTexture).toBeUndefined();
  });

  it("retries promotion without reallocating IDs after a uniform write failure", function () {
    const harness = makeFeatureResourceHarness({
      failPromotionWriteCount: 1,
    });
    const primCache = {};
    const coldEntries = harness.ensure(primCache, false).featureIdEntries;

    expect(function () {
      harness.ensure(primCache, true);
    }).toThrowError("feature pick uniform write failed");
    expect(primCache._featureIdEntries).toBe(coldEntries);
    expect(primCache._featurePickBoundGPUTexture).toBeUndefined();
    expect(harness.pickIds.length).toBe(2);
    expect(harness.bufferWrites.length).toBe(1);

    const textureCount = harness.textures.length;
    const retry = harness.ensure(primCache, true);
    expect(retry.featureIdEntries).not.toBe(coldEntries);
    expect(primCache._featurePickBoundGPUTexture).toBe(
      harness.modelCache._featurePickGPUTexture,
    );
    expect(harness.pickIds.length).toBe(2);
    expect(harness.textures.length).toBe(textureCount);
    expect(harness.bufferWrites.length).toBe(2);
    expect(harness.bufferWrites[1].offset).toBe(40);
  });

  for (const failureKind of ["view", "uniform write"]) {
    it(`keeps an old two-primitive owner generation coherent across replacement ${failureKind} failure`, function () {
      const harness = makeFeatureResourceHarness();
      const firstPrimCache = {};
      const secondPrimCache = {};
      harness.modelCache.primitives = {
        first: firstPrimCache,
        second: secondPrimCache,
      };
      const scheduledTextures = [];
      harness.context.scheduleTextureDestroy = jasmine
        .createSpy("scheduleTextureDestroy")
        .and.callFake(function (texture) {
          scheduledTextures.push(texture);
        });

      harness.ensure(firstPrimCache, true);
      harness.ensure(secondPrimCache, true);
      const oldEntries = firstPrimCache._featureIdEntries;
      const oldTexture = firstPrimCache._featurePickBoundGPUTexture;
      const oldPickIds = harness.pickIds.slice();

      replaceBatchTextureOwner(harness);
      if (failureKind === "view") {
        harness.failNextFeaturePickView();
      } else {
        harness.failNextPromotionWrite();
      }

      expect(function () {
        harness.ensure(firstPrimCache, true);
      }).toThrowError(
        failureKind === "view"
          ? "feature pick view failed"
          : "feature pick uniform write failed",
      );
      expect(firstPrimCache._featureIdEntries).toBe(oldEntries);
      expect(firstPrimCache._featurePickBoundGPUTexture).toBe(oldTexture);
      expect(secondPrimCache._featurePickBoundGPUTexture).toBe(oldTexture);
      expect(oldTexture.destroy).not.toHaveBeenCalled();
      const retiredPickIds =
        harness.modelCache._retiredFeaturePickGenerations.get(oldTexture);
      expect(retiredPickIds.size).toBe(2);
      expect(retiredPickIds.has(oldPickIds[0])).toBe(true);
      expect(retiredPickIds.has(oldPickIds[1])).toBe(true);
      expect(oldPickIds[0].destroy).not.toHaveBeenCalled();
      expect(oldPickIds[1].destroy).not.toHaveBeenCalled();
      expect(scheduledTextures.length).toBe(0);

      const replacementTexture = harness.modelCache._featurePickGPUTexture;
      const retry = harness.ensure(firstPrimCache, true);
      expect(retry.featureIdEntries).not.toBe(oldEntries);
      expect(firstPrimCache._featurePickBoundGPUTexture).toBe(
        replacementTexture,
      );
      expect(secondPrimCache._featurePickBoundGPUTexture).toBe(oldTexture);
      expect(scheduledTextures.length).toBe(0);
      expect(oldPickIds[0].destroy).not.toHaveBeenCalled();
      expect(oldPickIds[1].destroy).not.toHaveBeenCalled();

      harness.ensure(secondPrimCache, true);
      expect(scheduledTextures).toEqual([oldTexture]);
      expect(oldPickIds[0].destroy).toHaveBeenCalledTimes(1);
      expect(oldPickIds[1].destroy).toHaveBeenCalledTimes(1);
      expect(oldTexture.destroy).not.toHaveBeenCalled();
      expect(harness.modelCache._retiredFeaturePickGenerations).toBeUndefined();
      expect(harness.pickIds.length).toBe(4);
    });
  }

  it("rebuilds same-count feature picking for a new BatchTexture owner", function () {
    const harness = makeFeatureResourceHarness();
    const primCache = {};
    harness.modelCache.primitives = { primitive: primCache };

    harness.ensure(primCache, true);
    const oldTexture = harness.modelCache._featurePickGPUTexture;
    const oldPickIds = harness.pickIds.slice();
    const { replacementBatchTexture, replacementFeatures } =
      replaceBatchTextureOwner(harness);

    const replacement = harness.ensure(primCache, true);

    expect(harness.modelCache._featurePickBatchTexture).toBe(
      replacementBatchTexture,
    );
    expect(harness.modelCache._featurePickGPUTexture).not.toBe(oldTexture);
    expect(harness.pickIds.length).toBe(4);
    expect(oldTexture.destroy).toHaveBeenCalledTimes(1);
    expect(oldPickIds[0].destroy).toHaveBeenCalledTimes(1);
    expect(oldPickIds[1].destroy).toHaveBeenCalledTimes(1);
    expect(harness.modelCache._featurePickIds.get(0)).toBe(harness.pickIds[2]);
    expect(harness.modelCache._featurePickIds.get(1)).toBe(harness.pickIds[3]);
    expect(harness.pickIds[2].target).toBe(replacementFeatures[0]);
    expect(harness.pickIds[3].target).toBe(replacementFeatures[1]);
    expect(
      replacement.featureIdEntries.find((entry) => entry.binding === 31)
        .resource.texture,
    ).toBe(harness.modelCache._featurePickGPUTexture);

    const textureCount = harness.textures.length;
    harness.ensure(primCache, true);
    expect(harness.pickIds.length).toBe(4);
    expect(harness.textures.length).toBe(textureCount);
  });

  it("rebuilds a same-count lookup when the exact texture layout changes", function () {
    const harness = makeFeatureResourceHarness();
    const primCache = {};
    harness.modelCache.primitives = { primitive: primCache };

    harness.ensure(primCache, true);
    const oldTexture = harness.modelCache._featurePickGPUTexture;
    const oldPickIds = harness.pickIds.slice();
    harness.batchTexture._textureDimensions = { x: 1, y: 2 };
    harness.batchTexture.textureDimensions = { x: 1, y: 2 };

    harness.ensure(primCache, true);

    expect(harness.modelCache._featurePickGPUTexture).not.toBe(oldTexture);
    expect(harness.modelCache._featurePickTextureWidth).toBe(1);
    expect(harness.modelCache._featurePickTextureHeight).toBe(2);
    expect(harness.pickIds).toEqual(oldPickIds);
    expect(oldPickIds[0].destroy).not.toHaveBeenCalled();
    expect(oldPickIds[1].destroy).not.toHaveBeenCalled();
  });

  it("defers a multi-primitive replacement texture until the last marker migrates", function () {
    const harness = makeFeatureResourceHarness();
    const firstPrimCache = {};
    const secondPrimCache = {};
    harness.modelCache.primitives = {
      first: firstPrimCache,
      second: secondPrimCache,
    };
    const scheduledTextures = [];
    harness.context.scheduleTextureDestroy = jasmine
      .createSpy("scheduleTextureDestroy")
      .and.callFake(function (texture) {
        scheduledTextures.push(texture);
      });

    harness.ensure(firstPrimCache, true);
    harness.ensure(secondPrimCache, true);
    const oldTexture = harness.modelCache._featurePickGPUTexture;

    harness.batchTexture._featuresLength = 3;
    harness.batchTexture._textureDimensions = { x: 3, y: 1 };
    harness.batchTexture.textureDimensions = { x: 3, y: 1 };
    harness.batchTexture._batchValues = new Uint8Array(12).fill(255);
    harness.model.featureTables[0].featuresLength = 3;

    harness.ensure(firstPrimCache, true);
    expect(scheduledTextures.length).toBe(0);
    expect(oldTexture.destroy).not.toHaveBeenCalled();
    expect(secondPrimCache._featurePickBoundGPUTexture).toBe(oldTexture);

    harness.ensure(secondPrimCache, true);
    expect(scheduledTextures).toEqual([oldTexture]);
    expect(harness.context.scheduleTextureDestroy).toHaveBeenCalledTimes(1);
    expect(oldTexture.destroy).not.toHaveBeenCalled();
    expect(harness.modelCache._retiredFeaturePickGenerations).toBeUndefined();

    harness.ensure(firstPrimCache, true);
    harness.ensure(secondPrimCache, true);
    expect(harness.context.scheduleTextureDestroy).toHaveBeenCalledTimes(1);

    // Simulate the context's post-submit settlement callback. Product code must
    // not call destroy before this point.
    scheduledTextures[0].destroy();
    expect(oldTexture.destroy).toHaveBeenCalledTimes(1);
  });

  it("retries an exact-owner retired generation after the texture scheduler throws", function () {
    const harness = makeFeatureResourceHarness();
    const firstPrimCache = {};
    const secondPrimCache = {};
    harness.modelCache.primitives = {
      first: firstPrimCache,
      second: secondPrimCache,
    };
    let failScheduleCount = 1;
    harness.context.scheduleTextureDestroy = jasmine
      .createSpy("scheduleTextureDestroy")
      .and.callFake(function () {
        if (failScheduleCount > 0) {
          failScheduleCount--;
          throw new Error("schedule failed");
        }
      });

    harness.ensure(firstPrimCache, true);
    harness.ensure(secondPrimCache, true);
    const oldTexture = harness.modelCache._featurePickGPUTexture;
    const oldPickIds = harness.pickIds.slice();
    replaceBatchTextureOwner(harness);

    harness.ensure(firstPrimCache, true);
    harness.ensure(secondPrimCache, true);

    expect(harness.context.scheduleTextureDestroy).toHaveBeenCalledTimes(1);
    expect(
      harness.modelCache._retiredFeaturePickGenerations.get(oldTexture).size,
    ).toBe(2);
    expect(oldPickIds[0].destroy).not.toHaveBeenCalled();
    expect(oldPickIds[1].destroy).not.toHaveBeenCalled();
    expect(oldTexture.destroy).not.toHaveBeenCalled();

    const textureCount = harness.textures.length;
    harness.ensure(firstPrimCache, true);

    expect(harness.context.scheduleTextureDestroy).toHaveBeenCalledTimes(2);
    expect(
      harness.context.scheduleTextureDestroy.calls.mostRecent().args[0],
    ).toBe(oldTexture);
    expect(oldPickIds[0].destroy).toHaveBeenCalledTimes(1);
    expect(oldPickIds[1].destroy).toHaveBeenCalledTimes(1);
    expect(harness.modelCache._retiredFeaturePickGenerations).toBeUndefined();
    expect(harness.pickIds.length).toBe(4);
    expect(harness.textures.length).toBe(textureCount);
  });

  it("tears down current and retained feature-pick generations exactly once", function () {
    const harness = makeFeatureResourceHarness();
    const primCache = {};
    harness.modelCache.primitives = { primitive: primCache };

    harness.ensure(primCache, true);
    const oldTexture = harness.modelCache._featurePickGPUTexture;
    const oldPickIds = harness.pickIds.slice();
    replaceBatchTextureOwner(harness);
    harness.failNextFeaturePickView();

    expect(function () {
      harness.ensure(primCache, true);
    }).toThrowError("feature pick view failed");
    const currentTexture = harness.modelCache._featurePickGPUTexture;
    const currentPickIds = harness.pickIds.slice(2);

    destroyPerFeaturePickResources(harness.modelCache);
    destroyPerFeaturePickResources(harness.modelCache);

    for (const pickId of [...oldPickIds, ...currentPickIds]) {
      expect(pickId.destroy).toHaveBeenCalledTimes(1);
    }
    expect(oldTexture.destroy).toHaveBeenCalledTimes(1);
    expect(currentTexture.destroy).toHaveBeenCalledTimes(1);
    expect(harness.modelCache._featurePickIds).toBeUndefined();
    expect(harness.modelCache._featurePickGPUTexture).toBeUndefined();
    expect(harness.modelCache._retiredFeaturePickGenerations).toBeUndefined();
  });
});

function makeImplicit(offset, repeat) {
  const featureId = new FeatureIdImplicitRange();
  featureId.offset = offset ?? 0;
  featureId.repeat = repeat;
  return featureId;
}

// A model with no labels selects the first feature-ID set in each array
// (getFeatureIdsByLabel matches undefined label === undefined positionalLabel).
function makeModel() {
  return { featureIdLabel: undefined, instanceFeatureIdLabel: undefined };
}

describe("Renderer/WebGPU/WebGPUModelFeatureId implicit feature-ID lookup", function () {
  it("returns the exact selected FeatureIdImplicitRange instance (no wrapper)", function () {
    const implicit = makeImplicit(0, 1);
    const model = makeModel();
    const runtimeNode = { node: undefined };
    const primitive = { featureIds: [implicit] };

    const result = getSelectedImplicitFeatureId(model, runtimeNode, primitive);

    // toBe (reference identity) proves no classification wrapper is allocated.
    expect(result).toBe(implicit);
  });

  it("returns the same instance on repeated calls (allocation-free)", function () {
    const implicit = makeImplicit(3, 2);
    const model = makeModel();
    const runtimeNode = { node: undefined };
    const primitive = { featureIds: [implicit] };

    const first = getSelectedImplicitFeatureId(model, runtimeNode, primitive);
    const second = getSelectedImplicitFeatureId(model, runtimeNode, primitive);

    expect(first).toBe(implicit);
    expect(second).toBe(implicit);
  });

  it("returns null for a per-instance implicit feature ID (transport rule)", function () {
    const instanceImplicit = makeImplicit(0, 1);
    const model = makeModel();
    const runtimeNode = {
      node: { instances: { featureIds: [instanceImplicit] } },
    };
    const primitive = { featureIds: [makeImplicit(0, 1)] };

    const result = getSelectedImplicitFeatureId(model, runtimeNode, primitive);

    // Instance IDs ride the instance-transform pad slot, not per-vertex synthesis.
    expect(result).toBeNull();
  });

  it("returns null when the selected set is an attribute", function () {
    const model = makeModel();
    const runtimeNode = { node: undefined };
    const primitive = { featureIds: [new FeatureIdAttribute()] };

    expect(
      getSelectedImplicitFeatureId(model, runtimeNode, primitive),
    ).toBeNull();
  });

  it("returns null when the selected set is a texture", function () {
    const model = makeModel();
    const runtimeNode = { node: undefined };
    const primitive = { featureIds: [new FeatureIdTexture()] };

    expect(
      getSelectedImplicitFeatureId(model, runtimeNode, primitive),
    ).toBeNull();
  });

  it("returns null when the primitive has no feature IDs", function () {
    const model = makeModel();
    const runtimeNode = { node: undefined };

    expect(
      getSelectedImplicitFeatureId(model, runtimeNode, { featureIds: [] }),
    ).toBeNull();
    expect(getSelectedImplicitFeatureId(model, runtimeNode, {})).toBeNull();
  });
});

describe("Renderer/WebGPU/WebGPUModelFeatureId implicit feature-ID synthesis", function () {
  it("materializes id = offset + floor(vertex / repeat)", function () {
    const model = makeModel();
    const runtimeNode = { node: undefined };
    const primitive = { featureIds: [makeImplicit(5, 2)] };

    const data = synthesizeImplicitFeatureIdData(
      model,
      runtimeNode,
      primitive,
      6,
    );

    expect(data).toBeInstanceOf(Float32Array);
    expect(Array.from(data)).toEqual([5, 5, 6, 6, 7, 7]);
  });

  it("defaults offset=0 / repeat=1 per EXT_mesh_features", function () {
    const model = makeModel();
    const runtimeNode = { node: undefined };
    const primitive = { featureIds: [makeImplicit(undefined, undefined)] };

    const data = synthesizeImplicitFeatureIdData(
      model,
      runtimeNode,
      primitive,
      4,
    );

    expect(Array.from(data)).toEqual([0, 1, 2, 3]);
  });

  it("returns null when no implicit feature ID is selected", function () {
    const model = makeModel();
    const runtimeNode = { node: undefined };
    const primitive = { featureIds: [new FeatureIdTexture()] };

    expect(
      synthesizeImplicitFeatureIdData(model, runtimeNode, primitive, 8),
    ).toBeNull();
  });

  it("returns null for a non-positive vertex count", function () {
    const model = makeModel();
    const runtimeNode = { node: undefined };
    const primitive = { featureIds: [makeImplicit(0, 1)] };

    expect(
      synthesizeImplicitFeatureIdData(model, runtimeNode, primitive, 0),
    ).toBeNull();
  });
});
