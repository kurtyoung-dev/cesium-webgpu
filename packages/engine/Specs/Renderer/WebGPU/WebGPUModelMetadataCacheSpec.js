import ModelComponents from "../../../Source/Scene/ModelComponents.js";
import {
  getWebGPUModelMetadataCacheDiagnostics,
  resetWebGPUModelMetadataCacheForSpecs,
  resolveWebGPUModelMetadata,
} from "../../../Source/Renderer/WebGPU/WebGPUModelMetadataCache.js";

describe("Renderer/WebGPU/WebGPUModelMetadataCache", function () {
  function createClassProperty(id) {
    return {
      id,
      type: "SCALAR",
      componentType: "UINT8",
      valueType: "UINT8",
      normalized: false,
      isArray: false,
      isVariableLengthArray: false,
      arrayLength: undefined,
      hasValueTransform: true,
      offset: [0],
      scale: [1],
      isGpuCompatible: function () {
        return true;
      },
    };
  }

  function createTransformProperty(classProperty) {
    return {
      classProperty,
      hasValueTransform: classProperty.hasValueTransform,
      offset: classProperty.offset,
      scale: classProperty.scale,
    };
  }

  function createFixture() {
    const attributeClassProperty = createClassProperty("temperature");
    const textureClassProperty = createClassProperty("category");
    const tableClassProperty = createClassProperty("height");

    const attribute = {
      name: "_TEMPERATURE",
      type: "SCALAR",
      typedArray: new Uint8Array([1, 2, 3]),
      quantization: {
        quantizedVolumeOffset: [0],
        quantizedVolumeStepSize: [1],
      },
    };
    const attributeProperty = {
      ...createTransformProperty(attributeClassProperty),
      attribute: "_TEMPERATURE",
    };

    const physicalTexture = {};
    const textureReader = {
      texture: physicalTexture,
      channels: "r",
      texCoord: 0,
    };
    const textureProperty = {
      ...createTransformProperty(textureClassProperty),
      textureReader,
    };

    const featureId = new ModelComponents.FeatureIdAttribute();
    featureId.positionalLabel = "featureId_0";
    featureId.propertyTableId = 0;

    const packedTableData = {
      width: 3,
      height: 1,
      data: new Uint8Array([10, 0, 0, 0, 20, 0, 0, 0, 30, 0, 0, 0]),
    };
    const tableProperty = createTransformProperty(tableClassProperty);
    const propertyTable = {
      id: 0,
      class: {
        properties: {
          height: tableClassProperty,
        },
      },
      properties: {
        height: tableProperty,
      },
      texture: {
        _propertyTableTextureData: packedTableData,
      },
    };

    const structuralMetadata = {
      propertyAttributes: [
        {
          properties: {
            temperature: attributeProperty,
          },
        },
      ],
      propertyTextures: [
        {
          properties: {
            category: textureProperty,
          },
        },
      ],
      propertyTables: [propertyTable],
    };
    const primitive = {
      attributes: [attribute],
      featureIds: [featureId],
    };
    const model = {
      structuralMetadata,
      featureIdLabel: "featureId_0",
      instanceFeatureIdLabel: "instanceFeatureId_0",
      featureTableId: 0,
      featureTables: [{ featuresLength: 3 }],
    };
    const runtimeNode = { node: {} };

    return {
      model,
      primitive,
      runtimeNode,
      structuralMetadata,
      attribute,
      attributeClassProperty,
      textureReader,
      packedTableData,
      featureId,
    };
  }

  beforeEach(function () {
    resetWebGPUModelMetadataCacheForSpecs();
  });

  it("packs and generates once across 100 unchanged frames", function () {
    const fixture = createFixture();
    const first = resolveWebGPUModelMetadata(
      fixture.model,
      fixture.primitive,
      fixture.runtimeNode,
    );

    for (let frame = 0; frame < 100; frame++) {
      expect(
        resolveWebGPUModelMetadata(
          fixture.model,
          fixture.primitive,
          fixture.runtimeNode,
        ),
      ).toBe(first);
    }

    expect(first.hasMetadata).toBe(true);
    expect(first.hasPropertyTextures).toBe(true);
    expect(first.hasPropertyTables).toBe(true);
    expect(first.metadataData).toEqual(
      new Float32Array([1, 0, 0, 0, 2, 0, 0, 0, 3, 0, 0, 0]),
    );
    expect(first.metadataCodegen.propertyTextureLayout).toBe(
      first.propertyTextureLayout,
    );
    expect(first.metadataCodegen.propertyTableLayout).toBe(
      first.propertyTableLayout,
    );
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.propertyTextureLayout)).toBe(true);
    expect(Object.isFrozen(first.propertyTableLayout)).toBe(true);
    expect(getWebGPUModelMetadataCacheDiagnostics()).toEqual({
      hitCount: 100,
      missCount: 1,
      invalidationCount: 0,
      descriptorBuildCount: 1,
      attributePackBuildCount: 1,
      propertyTextureLayoutBuildCount: 1,
      propertyTableLayoutBuildCount: 1,
      codegenBuildCount: 1,
    });
  });

  it("invalidates once for relevant identity, scalar, and revision changes", function () {
    const fixture = createFixture();
    let previous = resolveWebGPUModelMetadata(
      fixture.model,
      fixture.primitive,
      fixture.runtimeNode,
    );

    function expectOneInvalidation(mutate) {
      const before = getWebGPUModelMetadataCacheDiagnostics();
      mutate();
      const next = resolveWebGPUModelMetadata(
        fixture.model,
        fixture.primitive,
        fixture.runtimeNode,
      );
      expect(next).not.toBe(previous);
      expect(
        resolveWebGPUModelMetadata(
          fixture.model,
          fixture.primitive,
          fixture.runtimeNode,
        ),
      ).toBe(next);
      const after = getWebGPUModelMetadataCacheDiagnostics();
      expect(after.invalidationCount).toBe(before.invalidationCount + 1);
      expect(after.descriptorBuildCount).toBe(before.descriptorBuildCount + 1);
      previous = next;
    }

    expectOneInvalidation(function () {
      fixture.attribute.typedArray = new Uint8Array([4, 5, 6]);
    });
    expectOneInvalidation(function () {
      fixture.attribute.quantization.quantizedVolumeStepSize[0] = 2;
    });
    expectOneInvalidation(function () {
      fixture.attributeClassProperty.offset[0] = 7;
    });
    expectOneInvalidation(function () {
      fixture.textureReader.channels = "rg";
    });
    expectOneInvalidation(function () {
      fixture.textureReader.texture = {};
    });
    expectOneInvalidation(function () {
      fixture.packedTableData.data = new Uint8Array(
        fixture.packedTableData.data,
      );
    });
    expectOneInvalidation(function () {
      fixture.featureId.propertyTableId = 1;
    });
    expectOneInvalidation(function () {
      fixture.model._metadataRevision = 1;
    });

    const diagnostics = getWebGPUModelMetadataCacheDiagnostics();
    expect(diagnostics.invalidationCount).toBe(8);
    expect(diagnostics.descriptorBuildCount).toBe(9);
    expect(diagnostics.hitCount).toBe(8);
  });

  it("negative-caches late materialization without sharing model or node state", function () {
    const fixture = createFixture();
    const structuralMetadata = fixture.model.structuralMetadata;
    fixture.model.structuralMetadata = undefined;

    const empty = resolveWebGPUModelMetadata(
      fixture.model,
      fixture.primitive,
      fixture.runtimeNode,
    );
    for (let frame = 0; frame < 100; frame++) {
      expect(
        resolveWebGPUModelMetadata(
          fixture.model,
          fixture.primitive,
          fixture.runtimeNode,
        ),
      ).toBe(empty);
    }
    expect(empty.hasMetadata).toBe(false);
    expect(empty.metadataWGSL).toBeUndefined();

    fixture.model.structuralMetadata = structuralMetadata;
    const materialized = resolveWebGPUModelMetadata(
      fixture.model,
      fixture.primitive,
      fixture.runtimeNode,
    );
    expect(materialized).not.toBe(empty);
    expect(materialized.hasMetadata).toBe(true);

    const otherModel = {
      ...fixture.model,
    };
    const otherModelDescriptor = resolveWebGPUModelMetadata(
      otherModel,
      fixture.primitive,
      fixture.runtimeNode,
    );
    expect(otherModelDescriptor).not.toBe(materialized);

    const otherRuntimeNode = { node: {} };
    const otherNodeDescriptor = resolveWebGPUModelMetadata(
      fixture.model,
      fixture.primitive,
      otherRuntimeNode,
    );
    expect(otherNodeDescriptor).not.toBe(materialized);

    expect(getWebGPUModelMetadataCacheDiagnostics()).toEqual({
      hitCount: 100,
      missCount: 4,
      invalidationCount: 1,
      descriptorBuildCount: 4,
      attributePackBuildCount: 4,
      propertyTextureLayoutBuildCount: 4,
      propertyTableLayoutBuildCount: 4,
      codegenBuildCount: 3,
    });
  });
});
