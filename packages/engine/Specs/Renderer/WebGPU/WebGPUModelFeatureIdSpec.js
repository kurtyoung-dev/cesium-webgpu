import {
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
