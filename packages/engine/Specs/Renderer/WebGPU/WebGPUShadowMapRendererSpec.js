import {
  registerShadowCastVariant,
  getRegisteredShadowCastVariantKeys,
  _inferShadowLayoutKey,
  _resetShadowLayoutWarningsForSpec,
  _resetShadowCastVariantRegistryForSpec,
} from "../../../Source/Renderer/WebGPU/WebGPUShadowMapRenderer.js";

describe("Renderer/WebGPU/WebGPUShadowMapRenderer", function () {
  describe("shadow cast variant registry", function () {
    afterEach(function () {
      // Strip any test-added variants so the registry returns to its
      // module-load state. Built-in keys (rte24, p12, ...) are preserved.
      _resetShadowCastVariantRegistryForSpec();
    });

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
      const key = "__test_variant_adds_layout_key";
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
      const key = "__test_dup_overwrites_key";
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

    it("_resetShadowCastVariantRegistryForSpec restores built-ins only", function () {
      const builtinKeys = getRegisteredShadowCastVariantKeys().slice();
      registerShadowCastVariant("__test_reset_check", {
        vsCode: "// noop",
        buffers: [{ arrayStride: 12, attributes: [] }],
      });
      expect(getRegisteredShadowCastVariantKeys()).toContain(
        "__test_reset_check",
      );
      _resetShadowCastVariantRegistryForSpec();
      const afterReset = getRegisteredShadowCastVariantKeys();
      expect(afterReset).not.toContain("__test_reset_check");
      // Built-in keys preserved in the same order.
      expect(afterReset.sort()).toEqual(builtinKeys.sort());
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
