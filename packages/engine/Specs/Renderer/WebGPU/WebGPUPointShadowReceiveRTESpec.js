import {
  packPointLightPositionRelativeToCamera,
  POINT_LIGHT_POSITION_OFFSET,
  resolvePointShadowCameraPosition,
} from "../../../Source/Renderer/WebGPU/WebGPUEffectsBindGroup.js";
import { getShaderSource } from "../../../Source/Renderer/WebGPU/WebGPUPrimitiveShaders.js";
import GlobeTerrain from "../../../Source/Shaders/WebGPU/Globe/GlobeTerrain.js";
import ModelPBRComplete from "../../../Source/Shaders/WebGPU/Model/ModelPBRComplete.js";

describe("Renderer/WebGPU point-shadow receive RTE", function () {
  function expectPointShadowDistanceAndPcfMath(source) {
    expect(source).toMatch(
      /let\s+lightDistanceSquared\s*=\s*dot\(direction,\s*direction\)/,
    );
    expect(source).toMatch(
      /if\s*\(lightDistanceSquared\s*>=\s*farPlane\s*\*\s*farPlane\)/,
    );
    expect(source).not.toMatch(/if\s*\(axisDist\s*>=\s*farPlane\)/);
    expect(source).toMatch(
      /2\.0\s*\*\s*axisDist\s*\*\s*pcfRadius\s*\/\s*max\(/,
    );
  }

  it("subtracts Earth-scale positions before f32 packing", function () {
    const earthScale = 6378137.0;
    const camera = {
      x: earthScale,
      y: -earthScale,
      z: earthScale * 0.5,
    };
    const light = {
      x: earthScale + 0.125,
      y: -earthScale - 0.375,
      z: earthScale * 0.5 + 12.25,
    };
    const packed = new Float32Array(POINT_LIGHT_POSITION_OFFSET + 4);

    const result = packPointLightPositionRelativeToCamera(
      light,
      camera,
      1.5,
      packed,
    );

    expect(result).toBe(packed);
    expect(packed[POINT_LIGHT_POSITION_OFFSET + 0]).toBe(0.125);
    expect(packed[POINT_LIGHT_POSITION_OFFSET + 1]).toBe(-0.375);
    expect(packed[POINT_LIGHT_POSITION_OFFSET + 2]).toBe(12.25);
    expect(packed[POINT_LIGHT_POSITION_OFFSET + 3]).toBe(1.5);
    // Quantizing the absolute operands first loses the sub-meter X delta.
    expect(Math.fround(light.x) - Math.fround(camera.x)).not.toBe(0.125);
  });

  it("uses UniformState's active camera before the frame camera fallback", function () {
    const activeCamera = { x: 1.0, y: 2.0, z: 3.0 };
    const frameCamera = { x: 4.0, y: 5.0, z: 6.0 };

    expect(
      resolvePointShadowCameraPosition({
        context: { uniformState: { cameraPosition: activeCamera } },
        camera: { positionWC: frameCamera },
      }),
    ).toBe(activeCamera);
    expect(
      resolvePointShadowCameraPosition({
        context: { uniformState: {} },
        camera: { positionWC: frameCamera },
      }),
    ).toBe(frameCamera);
  });

  it("keeps model and globe point-shadow sampling camera-relative", function () {
    const modelPointBranch = ModelPBRComplete.slice(
      ModelPBRComplete.indexOf("if (effects.pointLightControl.x > 0.5)"),
      ModelPBRComplete.indexOf(
        "} else if (effects.csmControl.x > 0.5)",
        ModelPBRComplete.indexOf("if (effects.pointLightControl.x > 0.5)"),
      ),
    );
    const globePointBranch = GlobeTerrain.slice(
      GlobeTerrain.indexOf("if (effects.pointLightControl.x > 0.5)"),
      GlobeTerrain.indexOf(
        "} else if (effects.csmControl.x > 0.5)",
        GlobeTerrain.indexOf("if (effects.pointLightControl.x > 0.5)"),
      ),
    );

    expect(ModelPBRComplete).toContain("pointLightPositionRTE: vec4<f32>");
    expect(modelPointBranch).toContain("computeShadowFactorPointLight(rteWC)");
    expect(modelPointBranch).not.toContain("camera.cameraPositionWC + rteWC");
    expectPointShadowDistanceAndPcfMath(ModelPBRComplete);

    expect(GlobeTerrain).toContain("pointLightPositionRTE: vec4<f32>");
    expect(globePointBranch).toContain(
      "globeComputeShadowFactorPointLight(input.v_positionRTE)",
    );
    expect(globePointBranch).not.toContain(
      "camera.encodedCameraHigh + camera.encodedCameraLow",
    );
    expectPointShadowDistanceAndPcfMath(GlobeTerrain);
  });

  const primitivePointShadowShaders = [
    "phong",
    "phongTextured",
    "matColorLit",
    "matImageLit",
    "matCheckerLit",
    "matGridLit",
    "matStripeLit",
    "matDotLit",
    "matFadeLit",
    "matRimLightingLit",
    "matAlphaMapLit",
    "matEmissionMapLit",
    "matDiffuseMapLit",
    "matSpecularMapLit",
    "matBumpMapLit",
    "matNormalMapLit",
    "matWaterLit",
    "matElevBandLit",
    "matElevContourLit",
    "matElevRampLit",
    "matSlopeRampLit",
    "matAspectRampLit",
    "pbrSimple",
    "pbrTextured",
  ];

  for (const shaderKey of primitivePointShadowShaders) {
    it(`${shaderKey} consumes its existing camera-relative varying`, function () {
      const source = getShaderSource(shaderKey);

      expect(source).toContain("pointLightPositionRTE: vec4<f32>");
      expect(source).toContain(
        "computeShadowFactorPointLight(input.eyePosition)",
      );
      expect(source).not.toContain("let fragWC = cameraWC + input.eyePosition");
      expect(source).toContain("let direction = fragRTE - lightRTE");
      expectPointShadowDistanceAndPcfMath(source);
    });
  }
});
