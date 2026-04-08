import FeatureRendererKey from "../../Source/Renderer/FeatureRendererKey.js";

describe("Renderer/FeatureRendererKey", function () {
  // FeatureRendererKey is a frozen numeric enum + COUNT field. The
  // GraphicsContext uses the values as direct array indices for O(1)
  // feature renderer lookup, so the contract that breaks loudest is
  // "every key < COUNT and every key is unique" — if a hand-edit
  // duplicates a value or shifts COUNT out of sync, the renderer
  // registry will silently overwrite slots and feature renderers will
  // mysteriously fail to load.

  it("is frozen", function () {
    expect(Object.isFrozen(FeatureRendererKey)).toBe(true);
  });

  it("exposes a positive COUNT", function () {
    expect(typeof FeatureRendererKey.COUNT).toBe("number");
    expect(FeatureRendererKey.COUNT).toBeGreaterThan(0);
  });

  it("has every key strictly less than COUNT", function () {
    // COUNT is the array-allocation hint used by GraphicsContext;
    // any enum value >= COUNT would be an out-of-bounds write at
    // registration time.
    const keys = Object.keys(FeatureRendererKey).filter((k) => k !== "COUNT");
    for (const k of keys) {
      const value = FeatureRendererKey[k];
      expect(typeof value).toBe("number");
      expect(value)
        .withContext(
          `${k} = ${value} should be < COUNT (${FeatureRendererKey.COUNT})`,
        )
        .toBeLessThan(FeatureRendererKey.COUNT);
      expect(value)
        .withContext(`${k} = ${value} should be >= 0`)
        .toBeGreaterThanOrEqual(0);
    }
  });

  it("uses unique values for every key", function () {
    // Manual hash + collision check — Set is overkill since the enum
    // is small, but it makes the failure message readable.
    const keys = Object.keys(FeatureRendererKey).filter((k) => k !== "COUNT");
    const seen = new Map();
    for (const k of keys) {
      const value = FeatureRendererKey[k];
      if (seen.has(value)) {
        fail(
          `Duplicate FeatureRendererKey value ${value}: ${seen.get(value)} and ${k}`,
        );
      }
      seen.set(value, k);
    }
    expect(seen.size).toBe(keys.length);
  });

  it("uses contiguous values from 0 to COUNT-1", function () {
    // The values must be dense (no holes) so that the renderer
    // registry's flat array doesn't waste slots. If you need to
    // remove a key, the convention is to renumber subsequent keys
    // to keep the range tight (see the DEFERRED_GBUFFER comment in
    // FeatureRendererKey.js for the precedent).
    const keys = Object.keys(FeatureRendererKey).filter((k) => k !== "COUNT");
    const values = keys.map((k) => FeatureRendererKey[k]).sort((a, b) => a - b);
    for (let i = 0; i < values.length; i++) {
      expect(values[i])
        .withContext(`expected dense range, hole at index ${i}`)
        .toBe(i);
    }
    expect(values.length).toBe(FeatureRendererKey.COUNT);
  });

  it("declares the canonical collection keys", function () {
    // Spot-check the keys that scene code references most often.
    // A rename of any of these is a breaking change to every
    // collection's getFeatureRenderer() call site.
    expect(typeof FeatureRendererKey.BILLBOARD_COLLECTION).toBe("number");
    expect(typeof FeatureRendererKey.POINT_PRIMITIVE_COLLECTION).toBe("number");
    expect(typeof FeatureRendererKey.POLYLINE_COLLECTION).toBe("number");
    expect(typeof FeatureRendererKey.LABEL_COLLECTION).toBe("number");
    expect(typeof FeatureRendererKey.PRIMITIVE).toBe("number");
    expect(typeof FeatureRendererKey.MODEL).toBe("number");
    expect(typeof FeatureRendererKey.GLOBE_SURFACE).toBe("number");
    expect(typeof FeatureRendererKey.SHADOW_MAP).toBe("number");
    expect(typeof FeatureRendererKey.SCENE_RENDERER).toBe("number");
  });
});
