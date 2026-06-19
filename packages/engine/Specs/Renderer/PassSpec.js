import { Pass } from "../../index.js";

describe("Renderer/Pass", function () {
  // Pass slots are command-bin indices: the scene frustum loops iterate
  // over the passes in numeric order, and the WGSL shaders + the
  // automatic GLSL `czm_pass*` constants HARDCODE these numbers (a WGSL
  // shader can't import a JS enum). An upstream merge can silently
  // renumber these values (the v1.141-1.143 merge moved OVERLAY 12->13
  // and inserted CESIUM_3D_TILE_EDGES_DIRECT:12). These assertions pin
  // every slot so a renumber fails loudly in CI instead of silently
  // breaking a frustum-loop ordering or a hardcoded shader constant.

  it("pins the exact numeric value of every pass", function () {
    expect(Pass.ENVIRONMENT).toBe(0);
    expect(Pass.COMPUTE).toBe(1);
    expect(Pass.GLOBE).toBe(2);
    expect(Pass.TERRAIN_CLASSIFICATION).toBe(3);
    expect(Pass.CESIUM_3D_TILE_EDGES).toBe(4);
    expect(Pass.CESIUM_3D_TILE).toBe(5);
    expect(Pass.CESIUM_3D_TILE_CLASSIFICATION).toBe(6);
    expect(Pass.CESIUM_3D_TILE_CLASSIFICATION_IGNORE_SHOW).toBe(7);
    expect(Pass.OPAQUE).toBe(8);
    expect(Pass.TRANSLUCENT).toBe(9);
    expect(Pass.VOXELS).toBe(10);
    expect(Pass.GAUSSIAN_SPLATS).toBe(11);
    expect(Pass.CESIUM_3D_TILE_EDGES_DIRECT).toBe(12);
    expect(Pass.OVERLAY).toBe(13);
    expect(Pass.NUMBER_OF_PASSES).toBe(14);
  });

  it("keeps NUMBER_OF_PASSES equal to the count of real passes", function () {
    // NUMBER_OF_PASSES is the loop bound; it must always equal the number
    // of declared pass slots so a newly added pass without bumping the
    // bound (or vice versa) fails here.
    const realPasses = Object.keys(Pass).filter(
      (name) => name !== "NUMBER_OF_PASSES",
    );
    expect(realPasses.length).toBe(Pass.NUMBER_OF_PASSES);
  });

  it("assigns the real passes a contiguous 0..NUMBER_OF_PASSES-1 range", function () {
    // Frustum loops index command bins directly by pass value, so the
    // real passes must form a dense, gap-free range. A reorder that
    // duplicated or skipped an index would break the loop.
    const values = Object.keys(Pass)
      .filter((name) => name !== "NUMBER_OF_PASSES")
      .map((name) => Pass[name])
      .sort((a, b) => a - b);
    for (let i = 0; i < values.length; ++i) {
      expect(values[i]).toBe(i);
    }
  });

  it("is frozen so the bin indices cannot be mutated at runtime", function () {
    expect(Object.isFrozen(Pass)).toBe(true);
  });
});
