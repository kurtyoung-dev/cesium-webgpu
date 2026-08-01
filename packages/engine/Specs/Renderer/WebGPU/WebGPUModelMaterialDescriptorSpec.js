import CustomShaderTranslucencyMode from "../../../Source/Scene/Model/CustomShaderTranslucencyMode.js";
import {
  AlphaModes,
  MaterialFlags,
  createMaterialInfoView,
  getOrCreateMaterialInfo,
  resetMaterialInfoCacheForSpecs,
} from "../../../Source/Scene/Model/ModelMaterialInfo.js";
import {
  applyCustomShaderTranslucency,
  hasMaterialGenerationChanged,
  resolveCustomShaderAlphaMode,
} from "../../../Source/Renderer/WebGPU/WebGPUModelRenderer.js";

describe("Renderer/WebGPU/WebGPUModelMaterialDescriptor", function () {
  beforeEach(function () {
    resetMaterialInfoCacheForSpecs();
  });

  it("resolves dynamic custom-shader alpha from the authored base every update", function () {
    const base = getOrCreateMaterialInfo(
      {},
      { alphaMode: "MASK" },
      false,
      true,
    );
    const view = createMaterialInfoView(base);
    const model = {
      customShader: {
        translucencyMode: CustomShaderTranslucencyMode.TRANSLUCENT,
      },
    };
    const primitiveGeneration = {
      _materialBase: base,
      _effectiveAlphaMode: base.alphaMode,
    };

    applyCustomShaderTranslucency(view, base, model);
    expect(view.alphaMode).toBe(AlphaModes.BLEND);
    expect(view.materialFlags & MaterialFlags.ALPHA_MODE_BLEND).not.toBe(0);
    expect(view.materialFlags & MaterialFlags.ALPHA_MODE_MASK).toBe(0);
    expect(base.alphaMode).toBe(AlphaModes.MASK);
    expect(base.materialFlags & MaterialFlags.ALPHA_MODE_MASK).not.toBe(0);
    expect(
      hasMaterialGenerationChanged(
        primitiveGeneration,
        base,
        resolveCustomShaderAlphaMode(base.alphaMode, model),
      ),
    ).toBe(true);

    // Once rebuilt for BLEND, a settled frame does not invalidate again.
    primitiveGeneration._effectiveAlphaMode = AlphaModes.BLEND;
    expect(
      hasMaterialGenerationChanged(
        primitiveGeneration,
        base,
        resolveCustomShaderAlphaMode(base.alphaMode, model),
      ),
    ).toBe(false);

    model.customShader.translucencyMode = CustomShaderTranslucencyMode.OPAQUE;
    applyCustomShaderTranslucency(view, base, model);
    expect(view.alphaMode).toBe(AlphaModes.OPAQUE);
    expect(
      view.materialFlags &
        (MaterialFlags.ALPHA_MODE_MASK | MaterialFlags.ALPHA_MODE_BLEND),
    ).toBe(0);
    expect(base.alphaMode).toBe(AlphaModes.MASK);
    expect(
      hasMaterialGenerationChanged(
        primitiveGeneration,
        base,
        resolveCustomShaderAlphaMode(base.alphaMode, model),
      ),
    ).toBe(true);

    primitiveGeneration._effectiveAlphaMode = AlphaModes.OPAQUE;
    model.customShader.translucencyMode = CustomShaderTranslucencyMode.INHERIT;
    applyCustomShaderTranslucency(view, base, model);
    expect(view.alphaMode).toBe(AlphaModes.MASK);
    expect(view.materialFlags & MaterialFlags.ALPHA_MODE_MASK).not.toBe(0);
    expect(view.materialFlags & MaterialFlags.ALPHA_MODE_BLEND).toBe(0);
    expect(base.alphaMode).toBe(AlphaModes.MASK);
    expect(
      hasMaterialGenerationChanged(
        primitiveGeneration,
        base,
        resolveCustomShaderAlphaMode(base.alphaMode, model),
      ),
    ).toBe(true);

    model.customShader = undefined;
    applyCustomShaderTranslucency(view, base, model);
    expect(view.alphaMode).toBe(AlphaModes.MASK);
  });

  it("does not alias effective alpha between renderer views", function () {
    const base = getOrCreateMaterialInfo(
      {},
      { alphaMode: "OPAQUE" },
      false,
      true,
    );
    const translucentView = createMaterialInfoView(base);
    const inheritedView = createMaterialInfoView(base);

    applyCustomShaderTranslucency(translucentView, base, {
      customShader: {
        translucencyMode: CustomShaderTranslucencyMode.TRANSLUCENT,
      },
    });
    applyCustomShaderTranslucency(inheritedView, base, {
      customShader: {
        translucencyMode: CustomShaderTranslucencyMode.INHERIT,
      },
    });

    expect(translucentView.alphaMode).toBe(AlphaModes.BLEND);
    expect(inheritedView.alphaMode).toBe(AlphaModes.OPAQUE);
    expect(base.alphaMode).toBe(AlphaModes.OPAQUE);
  });
});
