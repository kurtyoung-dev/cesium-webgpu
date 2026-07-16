import {
  SORT_KEY_PARAMS_BYTES,
  SORT_MODE_FRONT_TO_BACK,
  SORT_MODE_BACK_TO_FRONT,
} from "../../../Source/Renderer/WebGPU/WebGPUGPUSortKeysDispatcher.js";

// ── Test fixtures ───────────────────────────────────────────────────
//
// WebGPUGPUSortKeysDispatcher owns real GPU resources; the allocate /
// dispatch path needs a live GPUDevice. This spec covers the layout
// constants and the sort-mode enum values that must agree with
// GPUSortKeys.wgsl.

describe("Renderer/WebGPU/WebGPUGPUSortKeysDispatcher helpers", function () {
  describe("layout constants", function () {
    it("SORT_KEY_PARAMS_BYTES matches SortKeyParams in WGSL (4 × u32 = 16)", function () {
      expect(SORT_KEY_PARAMS_BYTES).toBe(16);
    });

    it("SORT_MODE_FRONT_TO_BACK is 0 (opaque sort direction)", function () {
      expect(SORT_MODE_FRONT_TO_BACK).toBe(0);
    });

    it("SORT_MODE_BACK_TO_FRONT is 1 (translucent sort direction)", function () {
      expect(SORT_MODE_BACK_TO_FRONT).toBe(1);
    });
  });
});
