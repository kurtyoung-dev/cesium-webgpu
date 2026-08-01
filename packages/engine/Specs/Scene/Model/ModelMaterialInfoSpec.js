import {
  AlphaModes,
  MaterialFlags,
  createMaterialInfoView,
  extractMaterialInfo,
  getMaterialInfoCacheDiagnostics,
  getOrCreateMaterialInfo,
  resetMaterialInfoCacheForSpecs,
  resetMaterialInfoView,
  setMaterialInfoCacheDiagnosticsEnabled,
} from "../../../Source/Scene/Model/ModelMaterialInfo.js";

describe("Scene/Model/ModelMaterialInfo", function () {
  function createMaterial() {
    return {
      alphaMode: "MASK",
      alphaCutoff: 0.25,
      doubleSided: true,
      emissiveFactor: [0.1, 0.2, 0.3],
      metallicRoughness: {
        baseColorFactor: [0.2, 0.4, 0.6, 0.8],
        metallicFactor: 0.7,
        roughnessFactor: 0.3,
      },
    };
  }

  beforeEach(function () {
    resetMaterialInfoCacheForSpecs();
    setMaterialInfoCacheDiagnosticsEnabled(true);
  });

  it("preserves the fresh mutable extractMaterialInfo helper contract", function () {
    const info = extractMaterialInfo(createMaterial(), false, true);

    expect(Object.isFrozen(info)).toBe(false);
    expect(Object.isFrozen(info.baseColorFactor)).toBe(false);
    info.alphaMode = AlphaModes.BLEND;
    expect(info.alphaMode).toBe(AlphaModes.BLEND);
  });

  it("keeps diagnostics writes disabled on the production path", function () {
    setMaterialInfoCacheDiagnosticsEnabled(false);
    const runtimePrimitive = {};
    const material = createMaterial();
    const base = getOrCreateMaterialInfo(
      runtimePrimitive,
      material,
      false,
      true,
    );
    getOrCreateMaterialInfo(runtimePrimitive, material, false, true);
    resetMaterialInfoView(createMaterialInfoView(base), base);

    expect(getMaterialInfoCacheDiagnostics()).toEqual({
      hitCount: 0,
      missCount: 0,
      invalidationCount: 0,
      descriptorBuildCount: 0,
      viewBuildCount: 0,
      viewResetCount: 0,
    });
  });

  it("builds one immutable descriptor across settled frames", function () {
    const runtimePrimitive = {};
    const material = createMaterial();
    const first = getOrCreateMaterialInfo(
      runtimePrimitive,
      material,
      true,
      true,
    );

    for (let frame = 0; frame < 100; frame++) {
      expect(
        getOrCreateMaterialInfo(runtimePrimitive, material, true, true),
      ).toBe(first);
    }

    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.baseColorFactor)).toBe(true);
    expect(Object.isFrozen(first.emissiveFactor)).toBe(true);
    expect(first.materialFlags & MaterialFlags.HAS_VERTEX_COLORS).not.toBe(0);
    expect(getMaterialInfoCacheDiagnostics()).toEqual({
      hitCount: 100,
      missCount: 1,
      invalidationCount: 0,
      descriptorBuildCount: 1,
      viewBuildCount: 0,
      viewResetCount: 0,
    });
  });

  it("invalidates precisely for material identity and normalized geometry capabilities", function () {
    const runtimePrimitive = {};
    const firstMaterial = createMaterial();
    const first = getOrCreateMaterialInfo(
      runtimePrimitive,
      firstMaterial,
      false,
      true,
    );

    const replacementMaterial = createMaterial();
    const replacement = getOrCreateMaterialInfo(
      runtimePrimitive,
      replacementMaterial,
      false,
      true,
    );
    expect(replacement).not.toBe(first);

    // Vertex-color extraction requires exact boolean true, so numeric truthy
    // input remains the same effective false capability generation.
    expect(
      getOrCreateMaterialInfo(runtimePrimitive, replacementMaterial, 1, true),
    ).toBe(replacement);

    const withVertexColors = getOrCreateMaterialInfo(
      runtimePrimitive,
      replacementMaterial,
      true,
      true,
    );
    expect(withVertexColors).not.toBe(replacement);
    expect(
      withVertexColors.materialFlags & MaterialFlags.HAS_VERTEX_COLORS,
    ).not.toBe(0);

    const withoutNormals = getOrCreateMaterialInfo(
      runtimePrimitive,
      replacementMaterial,
      true,
      false,
    );
    expect(withoutNormals).not.toBe(withVertexColors);
    expect(withoutNormals.isUnlit).toBe(true);
    expect(withoutNormals.materialFlags & MaterialFlags.IS_UNLIT).not.toBe(0);

    const diagnostics = getMaterialInfoCacheDiagnostics();
    expect(diagnostics.hitCount).toBe(1);
    expect(diagnostics.missCount).toBe(4);
    expect(diagnostics.invalidationCount).toBe(3);
    expect(diagnostics.descriptorBuildCount).toBe(4);
  });

  it("isolates mutable effective alpha from the cached base and other views", function () {
    const base = getOrCreateMaterialInfo({}, createMaterial(), false, true);
    const firstView = createMaterialInfoView(base);
    const secondView = createMaterialInfoView(base);

    firstView.alphaMode = AlphaModes.BLEND;

    expect(base.alphaMode).toBe(AlphaModes.MASK);
    expect(secondView.alphaMode).toBe(AlphaModes.MASK);
    expect(firstView.baseColorFactor).toBe(base.baseColorFactor);
    expect(secondView.baseColorFactor).toBe(base.baseColorFactor);
    expect(Object.isFrozen(firstView.baseColorFactor)).toBe(true);

    expect(resetMaterialInfoView(firstView, base)).toBe(firstView);
    expect(firstView.alphaMode).toBe(AlphaModes.MASK);
    expect(getMaterialInfoCacheDiagnostics().viewBuildCount).toBe(2);
    expect(getMaterialInfoCacheDiagnostics().viewResetCount).toBe(1);
  });

  it("creates a valid immutable default descriptor without a material", function () {
    const info = getOrCreateMaterialInfo({}, undefined, false, false);

    expect(info.alphaMode).toBe(AlphaModes.OPAQUE);
    expect(info.isUnlit).toBe(true);
    expect(Object.isFrozen(info)).toBe(true);
  });
});
