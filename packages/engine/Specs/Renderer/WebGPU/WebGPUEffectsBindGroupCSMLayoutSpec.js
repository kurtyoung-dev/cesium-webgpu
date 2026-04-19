import {
  EFFECTS_UNIFORM_SIZE,
  ATMOSPHERE_LUT_CONTROL_OFFSET,
  CSM_CONTROL_OFFSET,
  CSM_PARAMS_PLACEHOLDER_BYTES,
} from "../../../Source/Renderer/WebGPU/WebGPUEffectsBindGroup.js";

// Pure-constant specs for the CSM Slice 1 extension of the effects UBO
// + BGL. We keep CSM bindings (10/11) in lockstep with the WGSL struct
// in `GlobeTerrain.wgsl` and the cascade params buffer size in
// `WebGPUCSMRenderer`. When one side moves the other MUST move too —
// these tests catch drift at spec-run time instead of silently binding
// mismatched buffers at pipeline creation.

describe("Renderer/WebGPU/WebGPUEffectsBindGroup CSM layout", function () {
  it("exports EFFECTS_UNIFORM_SIZE = 272 after the CSM control vec4 tail", function () {
    expect(EFFECTS_UNIFORM_SIZE).toBe(272);
  });

  it("places atmosphereLutControl at float offset 60 (byte 240)", function () {
    expect(ATMOSPHERE_LUT_CONTROL_OFFSET).toBe(60);
  });

  it("places csmControl at float offset 64 (byte 256), immediately after atmosphereLutControl", function () {
    expect(CSM_CONTROL_OFFSET).toBe(64);
    // atmosphereLut starts at 60, consumes 4 floats → csmControl at 64.
    expect(CSM_CONTROL_OFFSET - ATMOSPHERE_LUT_CONTROL_OFFSET).toBe(4);
  });

  it("csmControl vec4 fits within EFFECTS_UNIFORM_SIZE", function () {
    const endByte = (CSM_CONTROL_OFFSET + 4) * 4;
    expect(endByte).toBeLessThanOrEqual(EFFECTS_UNIFORM_SIZE);
  });

  it("CSM params placeholder matches the WebGPUCSMRenderer allocation (1088 bytes = 272 floats)", function () {
    expect(CSM_PARAMS_PLACEHOLDER_BYTES).toBe(1088);
    // Current layout (272 floats = 1088B, already 256-aligned):
    //   offset   0: 4 × mat4<f32>        cascade VP_RTE matrices  (256 floats)
    //   offset 256: vec4<f32>            cascadeSplits            (  4 floats)
    //   offset 260: vec4<f32>            blendBands               (  4 floats)
    //   offset 264: vec4<f32>            cascadeMinBias           (  4 floats)
    //   offset 268: vec4<f32>            cascadeMaxSlopeBias      (  4 floats)
    // Total: 272 floats × 4B = 1088B. No alignment padding needed.
    expect(CSM_PARAMS_PLACEHOLDER_BYTES % 256).toBe(0);
    // 272 floats = 1088B minimum size for the new layout.
    expect(CSM_PARAMS_PLACEHOLDER_BYTES).toBeGreaterThanOrEqual(272 * 4);
  });
});
