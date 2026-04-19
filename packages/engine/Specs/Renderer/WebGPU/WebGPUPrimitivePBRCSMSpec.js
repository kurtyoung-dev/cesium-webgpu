import PrimitivePBRSimple from "../../../Source/Shaders/WebGPU/Primitive/PrimitivePBRSimple.js";
import PrimitivePBRTextured from "../../../Source/Shaders/WebGPU/Primitive/PrimitivePBRTextured.js";
import PrimitivePhongColor from "../../../Source/Shaders/WebGPU/Primitive/PrimitivePhongColor.js";
import PrimitivePhongTexturedColor from "../../../Source/Shaders/WebGPU/Primitive/PrimitivePhongTexturedColor.js";

// CSM Slice 2d specs — lock the WGSL bindings + varyings on the PBR
// receivers to the same layout the Phong receivers ship with. Catch
// drift at spec time before a broken pipeline hits runtime.

function countMatches(source, regex) {
  const matches = source.match(regex);
  return matches ? matches.length : 0;
}

describe("Renderer/WebGPU PBR CSM receive layout", function () {
  describe("PrimitivePBRSimple (no-texture)", function () {
    const src = PrimitivePBRSimple;

    it("declares effects UBO at @group(2) @binding(0)", function () {
      expect(src).toMatch(
        /@group\(2\)\s*@binding\(0\)\s*var<uniform>\s*effects\s*:\s*EffectsUniforms/,
      );
    });

    it("declares CSM cascade params UBO at @group(2) @binding(10)", function () {
      expect(src).toMatch(
        /@group\(2\)\s*@binding\(10\)\s*var<uniform>\s*csmParams\s*:\s*CSMParams/,
      );
    });

    it("declares cascade depth array at @group(2) @binding(11)", function () {
      expect(src).toMatch(
        /@group\(2\)\s*@binding\(11\)\s*var\s+cascadeDepthArray\s*:\s*texture_depth_2d_array/,
      );
    });

    it("carries eyePosition varying at @location(3)", function () {
      expect(src).toMatch(/@location\(3\)\s+eyePosition\s*:\s*vec3<f32>/);
    });

    it("populates output.eyePosition from RTE-translated position in VS", function () {
      expect(src).toMatch(/output\.eyePosition\s*=\s*eyePos\.xyz/);
    });

    it("gates shadow modulation on effects.csmControl.x > 0.5 in FS", function () {
      expect(src).toMatch(/effects\.csmControl\.x\s*>\s*0\.5/);
    });

    it("applies shadow factor to direct lighting but NOT ambient", function () {
      expect(src).toMatch(/direct\s*=\s*direct\s*\*\s*shadowFactor/);
      // Ambient is not multiplied by shadowFactor anywhere.
      expect(src).not.toMatch(/ambient\s*=\s*ambient\s*\*\s*shadowFactor/);
      expect(src).not.toMatch(/ambient\s*\*\s*shadowFactor/);
    });

    it("inlines the CSM helper stack (parity with PhongColor)", function () {
      const helpers = [
        "fn selectCascade(",
        "fn getCascadeVP(",
        "fn cascadeDepthBias(",
        "fn sampleOneCascade(",
        "fn sampleCascadeShadow(",
        "fn computeShadowFactorCSM(",
      ];
      for (const h of helpers) {
        expect(src.indexOf(h)).toBeGreaterThan(-1);
      }
    });
  });

  describe("PrimitivePBRTextured", function () {
    const src = PrimitivePBRTextured;

    it("keeps the texture bind group at @group(2) (sampler + baseColorTexture)", function () {
      expect(src).toMatch(/@group\(2\)\s*@binding\(0\)\s*var\s+textureSampler/);
      expect(src).toMatch(
        /@group\(2\)\s*@binding\(1\)\s*var\s+baseColorTexture\s*:\s*texture_2d<f32>/,
      );
    });

    it("declares effects UBO at @group(3) @binding(0) (one slot past texture group)", function () {
      expect(src).toMatch(
        /@group\(3\)\s*@binding\(0\)\s*var<uniform>\s*effects\s*:\s*EffectsUniforms/,
      );
    });

    it("declares CSM cascade params UBO at @group(3) @binding(10)", function () {
      expect(src).toMatch(
        /@group\(3\)\s*@binding\(10\)\s*var<uniform>\s*csmParams\s*:\s*CSMParams/,
      );
    });

    it("declares cascade depth array at @group(3) @binding(11)", function () {
      expect(src).toMatch(
        /@group\(3\)\s*@binding\(11\)\s*var\s+cascadeDepthArray\s*:\s*texture_depth_2d_array/,
      );
    });

    it("carries eyePosition varying at @location(3)", function () {
      expect(src).toMatch(/@location\(3\)\s+eyePosition\s*:\s*vec3<f32>/);
    });

    it("populates output.eyePosition from RTE-translated position in VS", function () {
      expect(src).toMatch(/output\.eyePosition\s*=\s*eyePos\.xyz/);
    });

    it("gates shadow modulation on effects.csmControl.x > 0.5 in FS", function () {
      expect(src).toMatch(/effects\.csmControl\.x\s*>\s*0\.5/);
    });

    it("applies shadow factor to direct lighting but NOT ambient", function () {
      expect(src).toMatch(/direct\s*=\s*direct\s*\*\s*shadowFactor/);
      expect(src).not.toMatch(/ambient\s*\*\s*shadowFactor/);
    });
  });

  describe("EffectsUniforms WGSL struct parity", function () {
    // The EffectsUniforms layout must match byte-for-byte across every
    // receiver that binds the same UBO — otherwise csmControl reads
    // from the wrong bytes. Sanity-check each receiver has the same
    // tail fields.
    const tailFields = [
      "atmosphereLutControl: vec4<f32>",
      "csmControl: vec4<f32>",
    ];
    const shaders = {
      PrimitivePBRSimple,
      PrimitivePBRTextured,
      PrimitivePhongColor,
      PrimitivePhongTexturedColor,
    };

    for (const [name, src] of Object.entries(shaders)) {
      for (const field of tailFields) {
        it(`${name} declares '${field}' in EffectsUniforms`, function () {
          expect(src.indexOf(field)).toBeGreaterThan(-1);
        });
      }
    }
  });

  describe("CSMParams WGSL struct parity (direct-layout consumers)", function () {
    const shaders = {
      PrimitivePBRSimple,
      PrimitivePBRTextured,
      PrimitivePhongColor,
      PrimitivePhongTexturedColor,
    };
    // The 4 cascade VPs + cascadeSplits + blendBands + per-cascade
    // biases. Ordering matters — JS buffer writes at `cascadeParamsData`
    // pack into the same offsets.
    const fields = [
      "cascadeVP0: mat4x4<f32>",
      "cascadeVP1: mat4x4<f32>",
      "cascadeVP2: mat4x4<f32>",
      "cascadeVP3: mat4x4<f32>",
      "cascadeSplits: vec4<f32>",
      "blendBands: vec4<f32>",
      "cascadeMinBias: vec4<f32>",
      "cascadeMaxSlopeBias: vec4<f32>",
    ];

    for (const [name, src] of Object.entries(shaders)) {
      it(`${name} declares all 8 CSMParams fields in canonical order`, function () {
        let cursor = 0;
        for (const field of fields) {
          const idx = src.indexOf(field, cursor);
          expect(idx).toBeGreaterThan(-1, `Missing field: ${field}`);
          cursor = idx + field.length;
        }
      });
    }
  });

  describe("Shader-module size sanity (regression guard)", function () {
    // Catch accidental deletion of the CSM helper block.
    it("PBRSimple source carries the full CSM helper suite", function () {
      expect(PrimitivePBRSimple.length).toBeGreaterThan(6000);
      // 5 bind declarations (effects UBO + shadow tex + sampler + csmParams + cascadeDepthArray)
      expect(
        countMatches(PrimitivePBRSimple, /@group\(2\)\s*@binding\(/g),
      ).toBe(5);
    });

    it("PBRTextured source carries the full CSM helper suite", function () {
      expect(PrimitivePBRTextured.length).toBeGreaterThan(6000);
      // 5 bindings on @group(3) for effects + shadow + CSM
      expect(
        countMatches(PrimitivePBRTextured, /@group\(3\)\s*@binding\(/g),
      ).toBe(5);
      // 2 bindings on @group(2) for sampler + texture
      expect(
        countMatches(PrimitivePBRTextured, /@group\(2\)\s*@binding\(/g),
      ).toBe(2);
    });
  });
});
