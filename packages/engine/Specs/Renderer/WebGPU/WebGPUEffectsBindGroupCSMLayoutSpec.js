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
  it("exports EFFECTS_UNIFORM_SIZE = 480 after the model-clipping-polygon tail", function () {
    // Grown 272 → 480 across later batches: the CSM control vec4 tail put
    // it at 272, then edge-inline (304), point-light-receive (336), and
    // finally the Batch 160 model-clipping-polygon control + per-extent UV
    // remap block (336 → 480). See WebGPUEffectsBindGroup.js:198 and the
    // size-history comment at lines 104-197; CSM_DESIGN.md:99 also records
    // 480B at HEAD.
    expect(EFFECTS_UNIFORM_SIZE).toBe(480);
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

  it("CSM params placeholder matches the WebGPUCSMRenderer allocation (1088 bytes)", function () {
    expect(CSM_PARAMS_PLACEHOLDER_BYTES).toBe(1088);
    // WGSL CSMParams natural std140-style layout (float offsets):
    //   offset  0:  4 × mat4x4<f32>  cascade VP_RTE matrices  (64 floats)
    //   offset 64:  vec4<f32>        cascadeSplits             ( 4 floats)
    //   offset 68:  vec4<f32>        blendBands                ( 4 floats)
    //   offset 72:  vec4<f32>        cascadeMinBias            ( 4 floats)
    //   offset 76:  vec4<f32>        cascadeMaxSlopeBias       ( 4 floats)
    // Shader-visible struct: 80 floats = 320 bytes.
    // The placeholder is over-allocated to 1088 bytes (272 floats) to
    // match `WebGPUCSMRenderer._cascadeParamsData = new Float32Array(272)`
    // (WebGPUCSMRenderer.ts:311), keeping the placeholder and the renderer's
    // CPU staging array the same length. 1088 is NOT 256-aligned — a UBO's
    // buffer *size* has no alignment requirement (only dynamic binding
    // *offsets* must be 256-aligned). The renderer separately rounds the
    // real GPU buffer up to 1280 via `Math.ceil(byteLength/256)*256`
    // (WebGPUCSMRenderer.ts:372-373). Bytes beyond 320 are unwritten zeros —
    // the shader never reads them.
    expect(CSM_PARAMS_PLACEHOLDER_BYTES).toBe(272 * 4);
    // Must be at least the shader-visible struct size (the real
    // minBindingSize invariant for binding 10).
    expect(CSM_PARAMS_PLACEHOLDER_BYTES).toBeGreaterThanOrEqual(320);
  });
});
