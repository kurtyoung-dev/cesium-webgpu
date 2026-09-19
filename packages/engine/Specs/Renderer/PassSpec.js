import { Pass } from "../../index.js";

describe("Renderer/Pass", function () {
  // Pass slots are command-bin indices: the scene frustum loops iterate
  // over the passes in numeric order, and the WGSL shaders + the automatic
  // GLSL `czm_pass*` constants HARDCODE these numbers (a WGSL shader can't
  // import a JS enum). An upstream merge can silently renumber them. The
  // v1.141-1.143 merge moved OVERLAY 12->13 and inserted
  // CESIUM_3D_TILE_EDGES_DIRECT:12; the v1.144 merge (65a194d24e, carrying
  // upstream 1c72b330f4 via PR #13178) then inserted
  // CESIUM_3D_TILE_PLANAR_FILL_ID:5 and shifted every slot above it by one,
  // which is where the values below come from.
  //
  // WHAT THIS SPEC GUARDS, exactly: the JS enum's values, its contiguity,
  // and that it is frozen. It reads no shader source, so it cannot detect a
  // `czm_pass*` constant that a renumber left behind -- and it did not.
  // Compared against all sixteen GLSL twins at 0f0fa444e8: thirteen agree
  // with the Pass member they name and two are stale. (The sixteenth,
  // passClassification.glsl, names {@link Pass#CLASSIFICATION}, which
  // Pass.js no longer has; #13178 shifted its value 7.0 -> 8.0 along with
  // the rest of the tail, so it still aliases the slot it always did
  // (CESIUM_3D_TILE_CLASSIFICATION_IGNORE_SHOW) -- a stale doc link, not a
  // stale value. #13192 never touched it, having inserted above it.)
  // Upstream PR #13192 authored both of the stale ones, and PR #13178
  // branched before it, so #13178's +1 shift never reached those two
  // files:
  //   Shaders/Builtin/Constants/passCesium3DTileEdgesDirect.glsl:9 = 12.0,
  //     but Pass.CESIUM_3D_TILE_EDGES_DIRECT = 13 (it aliases
  //     czm_passGaussianSplats = 12.0)
  //   Shaders/Builtin/Constants/passOverlay.glsl:9 = 13.0, but
  //     Pass.OVERLAY = 14
  // Both are tracked as CI-L11 / maintainer question Q5 and are not this
  // spec's to fix. The real JS<->GLSL parity guard is MISSING; it belongs in
  // `npm run test-build-infra`, because a karma spec cannot read `.glsl`
  // sources.

  it("pins the exact numeric value of every pass", function () {
    expect(Pass.ENVIRONMENT).toBe(0);
    expect(Pass.COMPUTE).toBe(1);
    expect(Pass.GLOBE).toBe(2);
    expect(Pass.TERRAIN_CLASSIFICATION).toBe(3);
    expect(Pass.CESIUM_3D_TILE_EDGES).toBe(4);
    expect(Pass.CESIUM_3D_TILE_PLANAR_FILL_ID).toBe(5);
    expect(Pass.CESIUM_3D_TILE).toBe(6);
    expect(Pass.CESIUM_3D_TILE_CLASSIFICATION).toBe(7);
    expect(Pass.CESIUM_3D_TILE_CLASSIFICATION_IGNORE_SHOW).toBe(8);
    expect(Pass.OPAQUE).toBe(9);
    expect(Pass.TRANSLUCENT).toBe(10);
    expect(Pass.VOXELS).toBe(11);
    expect(Pass.GAUSSIAN_SPLATS).toBe(12);
    expect(Pass.CESIUM_3D_TILE_EDGES_DIRECT).toBe(13);
    expect(Pass.OVERLAY).toBe(14);
    expect(Pass.NUMBER_OF_PASSES).toBe(15);
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
