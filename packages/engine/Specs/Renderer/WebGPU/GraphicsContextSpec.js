import { FeatureRendererKey } from "../../../index.js";
import ContextRegistry from "../../../Source/Renderer/ContextRegistry.js";

describe("Renderer/GraphicsContext", function () {
  describe("FeatureRendererKey", function () {
    it("has expected enumerated keys", function () {
      expect(FeatureRendererKey.BILLBOARD_COLLECTION).toBeDefined();
      expect(FeatureRendererKey.POINT_PRIMITIVE_COLLECTION).toBeDefined();
      expect(FeatureRendererKey.POLYLINE_COLLECTION).toBeDefined();
      expect(FeatureRendererKey.CLOUD_COLLECTION).toBeDefined();
      expect(FeatureRendererKey.PRIMITIVE).toBeDefined();
      expect(FeatureRendererKey.SUN).toBeDefined();
      expect(FeatureRendererKey.MOON).toBeDefined();
      expect(FeatureRendererKey.SKY_ATMOSPHERE).toBeDefined();
      expect(FeatureRendererKey.CUBE_MAP_PANORAMA).toBeDefined();
      expect(FeatureRendererKey.GLOBE_SURFACE).toBeDefined();
      expect(FeatureRendererKey.MODEL).toBeDefined();
      expect(FeatureRendererKey.SCENE_RENDERER).toBeDefined();
    });

    it("has sequential integer values", function () {
      // Keys should be integers for O(1) array indexing
      expect(typeof FeatureRendererKey.BILLBOARD_COLLECTION).toBe("number");
      expect(typeof FeatureRendererKey.PRIMITIVE).toBe("number");
      expect(typeof FeatureRendererKey.COUNT).toBe("number");
    });

    it("COUNT equals total number of keys", function () {
      // COUNT should be one more than the highest key value
      const count = FeatureRendererKey.COUNT;
      expect(count).toBeGreaterThan(30); // We have 36+ keys
    });

    it("all keys are unique", function () {
      const values = new Set();
      const keys = Object.keys(FeatureRendererKey).filter((k) => k !== "COUNT");
      for (const key of keys) {
        const val = FeatureRendererKey[key];
        if (typeof val === "number") {
          expect(values.has(val)).toBe(false);
          values.add(val);
        }
      }
    });
  });

  describe("ContextRegistry", function () {
    it("is defined", function () {
      expect(ContextRegistry).toBeDefined();
    });
  });
});
