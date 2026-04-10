import {
  computeMipLevels,
  halveDim,
  HI_Z_PARAMS_BYTES,
  OCCLUSION_PARAMS_BYTES,
} from "../../../Source/Renderer/WebGPU/WebGPUHiZOcclusionDispatcher.js";

// ── Test fixtures ───────────────────────────────────────────────────
//
// The dispatcher owns real GPU resources (textures, pipelines, bind
// groups) so the `allocate` / `buildHiZPyramid` / `dispatchOcclusionTest`
// paths need a live GPUDevice. Those are covered by the in-browser
// spec runner. This file covers the pure-JS helpers + the layout
// constants that the dispatcher and the WGSL shaders must agree on.

describe("Renderer/WebGPU/WebGPUHiZOcclusionDispatcher helpers", function () {
  describe("halveDim()", function () {
    it("clamps to 1 at the bottom", function () {
      expect(halveDim(1)).toBe(1);
      expect(halveDim(0)).toBe(1);
      expect(halveDim(-5)).toBe(1);
    });

    it("halves even dimensions", function () {
      expect(halveDim(2)).toBe(1);
      expect(halveDim(4)).toBe(2);
      expect(halveDim(256)).toBe(128);
      expect(halveDim(1920)).toBe(960);
    });

    it("uses floor for odd dimensions", function () {
      expect(halveDim(3)).toBe(1);
      expect(halveDim(5)).toBe(2);
      expect(halveDim(1081)).toBe(540);
    });
  });

  describe("computeMipLevels()", function () {
    it("returns 1 for 1×1 input", function () {
      expect(computeMipLevels(1, 1, 12)).toBe(1);
    });

    it("returns 2 for 2×2 input (mip 0 + mip 1 = 1×1)", function () {
      expect(computeMipLevels(2, 2, 12)).toBe(2);
    });

    it("produces the expected count for 1920×1080", function () {
      // 1920 → 960 → 480 → 240 → 120 → 60 → 30 → 15 → 7 → 3 → 1
      // 1080 → 540 → 270 → 135 → 67 → 33 → 16 → 8 → 4 → 2 → 1
      // The loop stops when BOTH dims reach 1, so the slower side
      // drives the count.
      const count = computeMipLevels(1920, 1080, 12);
      expect(count).toBeGreaterThanOrEqual(10);
      expect(count).toBeLessThanOrEqual(12);
    });

    it("honors the maxLevels cap", function () {
      // Very large input should still clamp to maxLevels.
      expect(computeMipLevels(8192, 8192, 4)).toBe(4);
      expect(computeMipLevels(8192, 8192, 1)).toBe(1);
    });

    it("handles non-square inputs without hanging", function () {
      expect(computeMipLevels(1024, 16, 12)).toBeGreaterThan(0);
      expect(computeMipLevels(1, 1024, 12)).toBeGreaterThan(0);
    });
  });

  describe("layout constants", function () {
    it("HI_Z_PARAMS_BYTES matches HiZPyramid.wgsl HiZParams size", function () {
      // HiZParams = 8 × u32 = 32 bytes (including padding).
      expect(HI_Z_PARAMS_BYTES).toBe(32);
    });

    it("OCCLUSION_PARAMS_BYTES matches OcclusionTest.wgsl OcclusionParams size", function () {
      // OcclusionParams = mat4 (64) + 4 × f32 (16) + 4 × u32 (16) = 96 bytes.
      expect(OCCLUSION_PARAMS_BYTES).toBe(96);
    });
  });
});
