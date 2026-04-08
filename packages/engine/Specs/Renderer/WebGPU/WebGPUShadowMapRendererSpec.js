import {
  registerShadowCastVariant,
  getRegisteredShadowCastVariantKeys,
} from "../../../Source/Renderer/WebGPU/WebGPUShadowMapRenderer.js";

describe("Renderer/WebGPU/WebGPUShadowMapRenderer", function () {
  describe("shadow cast variant registry", function () {
    it("ships with the rte24 default variant", function () {
      const keys = getRegisteredShadowCastVariantKeys();
      expect(keys).toContain("rte24");
    });

    it("registerShadowCastVariant adds new layout keys", function () {
      const before = getRegisteredShadowCastVariantKeys().length;
      // Use a unique key per run to avoid pollution between tests in the
      // same Jasmine session — registry is module-global by design.
      const key = `__test_variant_${Date.now()}_${Math.random()}`;
      registerShadowCastVariant(key, {
        vsCode: `
@vertex fn vs(@location(0) p: vec3<f32>) -> @builtin(position) vec4<f32> {
  return u.lightVP * vec4f(p, 1.0);
}`,
        buffers: [
          {
            arrayStride: 12,
            attributes: [{ shaderLocation: 0, offset: 0, format: "float32x3" }],
          },
        ],
      });
      const after = getRegisteredShadowCastVariantKeys();
      expect(after).toContain(key);
      expect(after.length).toBe(before + 1);
    });

    it("registerShadowCastVariant overwrites duplicate keys", function () {
      const key = `__test_dup_${Date.now()}`;
      const variantA = {
        vsCode: "// A",
        buffers: [{ arrayStride: 12, attributes: [] }],
      };
      const variantB = {
        vsCode: "// B",
        buffers: [{ arrayStride: 24, attributes: [] }],
      };
      registerShadowCastVariant(key, variantA);
      const countAfterA = getRegisteredShadowCastVariantKeys().length;
      registerShadowCastVariant(key, variantB);
      const countAfterB = getRegisteredShadowCastVariantKeys().length;
      // Re-registration must not duplicate the key.
      expect(countAfterB).toBe(countAfterA);
    });
  });
});
