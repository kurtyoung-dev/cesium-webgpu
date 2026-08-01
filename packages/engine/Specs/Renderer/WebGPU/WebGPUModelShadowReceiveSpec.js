import { getShadowCastVariant } from "../../../Source/Renderer/WebGPU/WebGPUShadowMapRenderer.js";
import ModelPBRComplete from "../../../Source/Shaders/WebGPU/Model/ModelPBRComplete.js";

describe("Renderer/WebGPU/WebGPU model shadow receive", function () {
  it("samples the default one-pass directional shadow map", function () {
    expect(ModelPBRComplete).toContain("fn computeShadowFactorSingle(");
    expect(ModelPBRComplete).toContain(
      "computeShadowFactorSingle(input.positionEC)",
    );
    expect(ModelPBRComplete).toMatch(
      /else if\s*\(effects\.shadowDarkness\s*<\s*1\.0\)/,
    );
    expect(ModelPBRComplete).toMatch(
      /textureSampleCompareLevel\(\s*shadowDepthTex,\s*shadowCompSampler/,
    );
  });

  it("keeps point, CSM, and single-map receive routes mutually ordered", function () {
    const point = ModelPBRComplete.indexOf(
      "if (effects.pointLightControl.x > 0.5)",
    );
    const csm = ModelPBRComplete.indexOf(
      "} else if (effects.csmControl.x > 0.5)",
      point,
    );
    const single = ModelPBRComplete.indexOf(
      "} else if (effects.shadowDarkness < 1.0)",
      csm,
    );

    expect(point).toBeGreaterThan(-1);
    expect(csm).toBeGreaterThan(point);
    expect(single).toBeGreaterThan(csm);
  });

  it("modulates direct lighting without shadowing ambient", function () {
    const singleBranch = ModelPBRComplete.slice(
      ModelPBRComplete.indexOf("} else if (effects.shadowDarkness < 1.0)"),
      ModelPBRComplete.indexOf("// ── Punctual lights", 0),
    );

    expect(singleBranch).toContain("direct = direct * shadowFactor");
    expect(singleBranch).not.toMatch(/ambient\s*=\s*ambient\s*\*/);
  });

  for (const layout of ["modelP12", "modelSkinned", "modelInstancedSB"]) {
    it(`${layout} casts from model-space RTE without reconstructing world position`, function () {
      const source = getShadowCastVariant(layout).vsCode;

      expect(source).toContain("cameraMCHigh");
      expect(source).toContain("cameraMCLow");
      expect(source).toContain("modelLinear");
      expect(source).toContain("rteWC");
      expect(source).not.toContain("let worldPos");
    });
  }

  it("keeps split instance translation split through camera cancellation", function () {
    const source = getShadowCastVariant("modelInstancedSB").vsCode;

    expect(source).toMatch(
      /inst\.translationHigh\.xyz\s*-\s*m\.cameraMCHigh\.xyz/,
    );
    expect(source).toMatch(
      /inst\.translationLow\.xyz\s*-\s*m\.cameraMCLow\.xyz/,
    );
    expect(source).not.toContain(
      "inst.translationHigh.xyz + inst.translationLow.xyz",
    );
  });
});
