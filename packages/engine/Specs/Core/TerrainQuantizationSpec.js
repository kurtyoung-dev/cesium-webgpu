import { TerrainQuantization } from "../../index.js";

describe("Core/TerrainQuantization", function () {
  // The quantization value selects the terrain-vertex decode path. The
  // WGSL globe terrain shader and the CPU-side TerrainEncoding both
  // branch on these exact numbers; a WGSL shader can't import a JS enum,
  // so it HARDCODES them. An upstream merge could renumber these during a
  // modernization pass (the v1.141-1.143 merge modernized this file but
  // happened to leave the values intact). These assertions pin the values
  // so a future renumber fails loudly instead of silently selecting the
  // wrong decode path.

  it("pins the exact numeric value of every quantization mode", function () {
    expect(TerrainQuantization.NONE).toBe(0);
    expect(TerrainQuantization.BITS12).toBe(1);
  });

  it("is frozen so the decode-path selector cannot be mutated at runtime", function () {
    expect(Object.isFrozen(TerrainQuantization)).toBe(true);
  });

  it("declares no value besides NONE and BITS12", function () {
    // Adding a mode is allowed, but it must come with a deliberate update
    // to this spec AND the WGSL/CPU decode branches. This guard makes a
    // silent addition (with no shader update) fail here.
    expect(Object.keys(TerrainQuantization).sort()).toEqual(["BITS12", "NONE"]);
  });
});
