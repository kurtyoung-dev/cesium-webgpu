import {
  generateVoxelUserShaderChunk,
  hashStringFNV1a,
  sanitizeWgslIdentifier,
  voxelUserShaderHasUniforms,
} from "../../../Source/Renderer/WebGPU/WebGPUVoxelCustomShaderCodegen.js";
import { ShaderDefine } from "../../../Source/Renderer/WebGPU/WebGPUShaderDefines.js";

describe("Renderer/WebGPU/WebGPUVoxelCustomShaderCodegen", function () {
  // Pure-function coverage for the VOXEL-USER-CUSTOMSHADER codegen (B503).
  // Nothing here needs a GPUDevice — the module is a pure string→string/
  // string→number transform whose stability is load-bearing: the FNV-1a
  // fingerprint doubles as the shader-module cache keySalt and the
  // pipeline-cache name discriminator, so a silent change to either the
  // hash or the emitted chunk would alias (or needlessly duplicate)
  // cached modules across variants.

  const USER_FRAGMENT =
    "fn czm_voxelCustomFragmentMain(fsInput: czm_voxelCustomFragmentInput, material: ptr<function, czm_voxelCustomMaterial>) {\n" +
    "  (*material).diffuse = vec3<f32>(fsInput.metadata.temperature, 0.0, 0.0);\n" +
    "  (*material).alpha = 1.0;\n" +
    "}";

  describe("hashStringFNV1a", function () {
    it("matches the published FNV-1a 32-bit reference vectors", function () {
      // Offset basis for the empty string, then classic test vectors.
      expect(hashStringFNV1a("")).toBe(0x811c9dc5);
      expect(hashStringFNV1a("a")).toBe(0xe40c292c);
      expect(hashStringFNV1a("foobar")).toBe(0xbf9cf968);
      expect(hashStringFNV1a("hello world")).toBe(0xd58b3fa7);
    });

    it("is stable across calls and always an unsigned 32-bit value", function () {
      const s = "fn czm_voxelCustomFragmentMain() {}";
      const first = hashStringFNV1a(s);
      expect(hashStringFNV1a(s)).toBe(first);
      expect(first).toBeGreaterThanOrEqual(0);
      expect(first).toBeLessThanOrEqual(0xffffffff);
      expect(Number.isInteger(first)).toBe(true);
    });

    it("distinguishes nearby inputs", function () {
      expect(hashStringFNV1a("abc")).not.toBe(hashStringFNV1a("abd"));
      expect(hashStringFNV1a("abc")).not.toBe(hashStringFNV1a("acb"));
    });
  });

  describe("sanitizeWgslIdentifier", function () {
    it("passes valid identifiers through unchanged", function () {
      expect(sanitizeWgslIdentifier("temperature")).toBe("temperature");
      expect(sanitizeWgslIdentifier("_private")).toBe("_private");
      expect(sanitizeWgslIdentifier("prop2")).toBe("prop2");
      expect(sanitizeWgslIdentifier("camelCase_99")).toBe("camelCase_99");
    });

    it("maps every invalid character to underscore", function () {
      expect(sanitizeWgslIdentifier("my-prop")).toBe("my_prop");
      expect(sanitizeWgslIdentifier("a b.c")).toBe("a_b_c");
      expect(sanitizeWgslIdentifier("näme")).toBe("n_me");
    });

    it("prefixes an underscore when the name starts with a digit", function () {
      expect(sanitizeWgslIdentifier("2theta")).toBe("_2theta");
      expect(sanitizeWgslIdentifier("0")).toBe("_0");
    });

    it("produces a valid WGSL identifier for degenerate input", function () {
      // "!" → "_" (replace), which already starts with an alpha/underscore.
      expect(sanitizeWgslIdentifier("!")).toBe("_");
      // "" → "" → "_" via the leading-character rule.
      expect(sanitizeWgslIdentifier("")).toBe("_");
      expect(sanitizeWgslIdentifier("!@#")).toMatch(/^[a-zA-Z_][0-9a-zA-Z_]*$/);
    });
  });

  describe("voxelUserShaderHasUniforms", function () {
    it("returns false when uniforms is absent", function () {
      expect(voxelUserShaderHasUniforms({})).toBe(false);
      expect(voxelUserShaderHasUniforms({ uniforms: undefined })).toBe(false);
    });

    it("returns false for an empty uniforms object", function () {
      expect(voxelUserShaderHasUniforms({ uniforms: {} })).toBe(false);
    });

    it("returns true when at least one uniform is declared", function () {
      expect(
        voxelUserShaderHasUniforms({
          uniforms: { u_time: { type: "FLOAT", value: 0.0 } },
        }),
      ).toBe(true);
    });

    it("ignores inherited (prototype) properties", function () {
      const proto = { u_inherited: 1 };
      const uniforms = Object.create(proto);
      expect(voxelUserShaderHasUniforms({ uniforms })).toBe(false);
    });
  });

  describe("generateVoxelUserShaderChunk", function () {
    const provider = {
      names: ["temperature"],
      types: ["SCALAR"],
    };

    it("returns undefined when there is no native-WGSL fragment text", function () {
      expect(generateVoxelUserShaderChunk({}, provider)).toBeUndefined();
      expect(
        generateVoxelUserShaderChunk({ wgslFragmentShaderText: "" }, provider),
      ).toBeUndefined();
      // GLSL-only customShaders stay on the warn + default-gray path.
      expect(
        generateVoxelUserShaderChunk(
          { fragmentShaderText: "void fragmentMain() {}" },
          provider,
        ),
      ).toBeUndefined();
    });

    it("emits the bridge structs, the metadata reader, and the user body", function () {
      const info = generateVoxelUserShaderChunk(
        { wgslFragmentShaderText: USER_FRAGMENT },
        provider,
      );
      expect(info).toBeDefined();
      const { chunk } = info;
      expect(chunk).toContain("struct czm_voxelCustomMetadata {");
      expect(chunk).toContain("struct czm_voxelCustomAttributes {");
      expect(chunk).toContain("struct czm_voxelCustomFragmentInput {");
      expect(chunk).toContain("struct czm_voxelCustomMaterial {");
      expect(chunk).toContain(
        "fn czm_voxelReadCustomMetadata(s: vec4<f32>) -> czm_voxelCustomMetadata {",
      );
      expect(chunk).toContain(USER_FRAGMENT);
      // Attribute bridge fields the user contract documents.
      expect(chunk).toContain("normalLocal: vec3<f32>,");
      expect(chunk).toContain("lightDirectionLocal: vec3<f32>,");
      expect(chunk).toContain("shapeUv: vec3<f32>,");
      expect(chunk).toContain("diffuse: vec3<f32>,");
      expect(chunk).toContain("alpha: f32,");
    });

    it("types the metadata field and swizzle per MetadataType", function () {
      const cs = { wgslFragmentShaderText: USER_FRAGMENT };
      const cases = [
        { type: "SCALAR", wgsl: "p: f32,", read: "m.p = s.x;" },
        { type: "VEC2", wgsl: "p: vec2<f32>,", read: "m.p = s.xy;" },
        { type: "VEC3", wgsl: "p: vec3<f32>,", read: "m.p = s.xyz;" },
        { type: "VEC4", wgsl: "p: vec4<f32>,", read: "m.p = s;" },
        // Unknown types fall back to the full vec4 texel.
        { type: "MAT2", wgsl: "p: vec4<f32>,", read: "m.p = s;" },
      ];
      for (const c of cases) {
        const info = generateVoxelUserShaderChunk(cs, {
          names: ["p"],
          types: [c.type],
        });
        expect(info.chunk).toContain(c.wgsl);
        expect(info.chunk).toContain(c.read);
      }
    });

    it("sanitizes the metadata property name into a WGSL identifier", function () {
      const info = generateVoxelUserShaderChunk(
        { wgslFragmentShaderText: USER_FRAGMENT },
        { names: ["2-theta value"], types: ["SCALAR"] },
      );
      expect(info.chunk).toContain("_2_theta_value: f32,");
      expect(info.chunk).toContain("m._2_theta_value = s.x;");
    });

    it("falls back to 'property'/vec4 when provider metadata is missing", function () {
      const cs = { wgslFragmentShaderText: USER_FRAGMENT };
      for (const p of [undefined, {}, { names: [], types: [] }]) {
        const info = generateVoxelUserShaderChunk(cs, p);
        expect(info.chunk).toContain("property: vec4<f32>,");
        expect(info.chunk).toContain("m.property = s;");
      }
    });

    it("produces a stable hash for identical inputs", function () {
      const cs = { wgslFragmentShaderText: USER_FRAGMENT };
      const a = generateVoxelUserShaderChunk(cs, provider);
      const b = generateVoxelUserShaderChunk(cs, provider);
      expect(a.chunk).toBe(b.chunk);
      expect(a.hash).toBe(b.hash);
    });

    it("produces distinct hashes for distinct user bodies and metadata", function () {
      const a = generateVoxelUserShaderChunk(
        { wgslFragmentShaderText: USER_FRAGMENT },
        provider,
      );
      const b = generateVoxelUserShaderChunk(
        { wgslFragmentShaderText: `${USER_FRAGMENT}\n// v2` },
        provider,
      );
      const c = generateVoxelUserShaderChunk(
        { wgslFragmentShaderText: USER_FRAGMENT },
        { names: ["density"], types: ["VEC3"] },
      );
      expect(a.hash).not.toBe(b.hash);
      expect(a.hash).not.toBe(c.hash);
    });

    it("never returns zero or the legacy Batch 476 reserved hash", function () {
      // Zero selects the unsalted key. The old constant-salt value remains
      // remapped to keep generated-source hashes stable across key widening.
      const reserved = ShaderDefine.VOXEL_CUSTOM_SHADER_COLOR >>> 0;
      const bodies = [
        USER_FRAGMENT,
        "fn czm_voxelCustomFragmentMain() {}",
        "// minimal",
        "x",
      ];
      for (const body of bodies) {
        const info = generateVoxelUserShaderChunk(
          { wgslFragmentShaderText: body },
          provider,
        );
        expect(info.hash).not.toBe(0);
        expect(info.hash).not.toBe(reserved);
      }
    });

    it("keeps the chunk hash consistent with hashing the chunk text (modulo the reserved-value remap)", function () {
      const info = generateVoxelUserShaderChunk(
        { wgslFragmentShaderText: USER_FRAGMENT },
        provider,
      );
      const raw = hashStringFNV1a(info.chunk);
      const reserved = ShaderDefine.VOXEL_CUSTOM_SHADER_COLOR >>> 0;
      const expected =
        raw === 0 || raw === reserved ? (raw ^ 0x9e3779b9) >>> 0 : raw;
      expect(info.hash).toBe(expected);
    });
  });
});
