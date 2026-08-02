import {
  createBatchGPUTexture,
  createFeatureIdGPUTexture,
  ensurePerFeaturePickIds,
  getSelectedImplicitFeatureId,
  synthesizeImplicitFeatureIdData,
} from "../../../Source/Renderer/WebGPU/WebGPUModelFeatureId.js";
import { ModelComponents } from "../../../index.js";

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

describe("Renderer/WebGPU/WebGPUModel feature texture construction", function () {
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

describe("Renderer/WebGPU/WebGPUModel implicit feature-ID lookup", function () {
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

describe("Renderer/WebGPU/WebGPUModel implicit feature-ID synthesis", function () {
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
