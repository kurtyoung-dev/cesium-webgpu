import { getShadowCastVariant } from "../../../Source/Renderer/WebGPU/WebGPUShadowMapRenderer.js";
import ModelPBRComplete from "../../../Source/Shaders/WebGPU/Model/ModelPBRComplete.js";

// Bounds a region of shader source by two code statements. Release shader
// modules have their comments stripped, so only code is a landmark in both
// build flavours. Each landmark must occur exactly once and in order, or the
// region is undefined and the spec fails instead of asserting over an empty
// or runaway slice.
function sliceBetweenStatements(source, startStatement, endStatement) {
  for (const landmark of [startStatement, endStatement]) {
    const first = source.indexOf(landmark);
    if (first < 0 || source.indexOf(landmark, first + 1) >= 0) {
      throw new Error(`landmark must occur exactly once: ${landmark}`);
    }
  }
  const start = source.indexOf(startStatement);
  const end = source.indexOf(endStatement);
  if (end <= start) {
    throw new Error(`landmark out of order: ${endStatement}`);
  }
  return source.slice(start, end);
}

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
    // From the single-map branch head to the first statement after the
    // shadow routing, where punctual lighting begins.
    const singleBranch = sliceBetweenStatements(
      ModelPBRComplete,
      "} else if (effects.shadowDarkness < 1.0) {",
      "let pCount = i32(light.punctualLightCount);",
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
