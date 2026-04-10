import {
  registerShadowCastVariant,
  getRegisteredShadowCastVariantKeys,
  _inferShadowLayoutKey,
  _resetShadowLayoutWarningsForSpec,
} from "../../../Source/Renderer/WebGPU/WebGPUShadowMapRenderer.js";

describe("Renderer/WebGPU/WebGPUShadowMapRenderer", function () {
  describe("shadow cast variant registry", function () {
    it("ships with the rte24 default variant", function () {
      const keys = getRegisteredShadowCastVariantKeys();
      expect(keys).toContain("rte24");
    });

    it("ships with the p12 single-vec3 variant for non-RTE models", function () {
      const keys = getRegisteredShadowCastVariantKeys();
      expect(keys).toContain("p12");
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

  describe("_inferShadowLayoutKey()", function () {
    beforeEach(function () {
      _resetShadowLayoutWarningsForSpec();
    });

    it("picks rte24 for stride-24 commands", function () {
      expect(_inferShadowLayoutKey({}, 24)).toBe("rte24");
    });

    it("picks rte24 when stride is undefined (default assumption)", function () {
      expect(_inferShadowLayoutKey({}, undefined)).toBe("rte24");
    });

    it("picks p12 for stride-12 commands", function () {
      expect(_inferShadowLayoutKey({}, 12)).toBe("p12");
    });

    it("returns null and warns once for unrecognized strides", function () {
      const warnSpy = spyOn(console, "warn");
      expect(_inferShadowLayoutKey({}, 99)).toBeNull();
      expect(warnSpy).toHaveBeenCalledTimes(1);
      // Second call with the same stride must NOT warn again.
      expect(_inferShadowLayoutKey({}, 99)).toBeNull();
      expect(warnSpy).toHaveBeenCalledTimes(1);
    });

    it("warns per distinct stride", function () {
      const warnSpy = spyOn(console, "warn");
      _inferShadowLayoutKey({}, 7);
      _inferShadowLayoutKey({}, 13);
      _inferShadowLayoutKey({}, 7); // already warned
      expect(warnSpy).toHaveBeenCalledTimes(2);
    });

    it("respects explicit _shadowCastLayout override on the command", function () {
      // Even with a recognized stride, the explicit override wins.
      expect(_inferShadowLayoutKey({ _shadowCastLayout: "custom" }, 24)).toBe(
        "custom",
      );
      expect(_inferShadowLayoutKey({ _shadowCastLayout: "p12" }, 24)).toBe(
        "p12",
      );
    });
  });
});
