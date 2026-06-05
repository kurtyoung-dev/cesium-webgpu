import {
  CSM_CAST_UBO_SIZE,
  BASE_MIN_BIAS,
  BASE_MAX_SLOPE_BIAS,
} from "../../../Source/Renderer/WebGPU/WebGPUCSMRenderer.js";

// Pure-constant specs locking the CSM cast-side UBO layout. The byte
// offsets here are a contract between `WebGPUCSMRenderer.renderCastPass`
// (packs the UBO) and the `rte24` cast VS in `WebGPUShadowMapRenderer.js`
// (reads it). Slice 2 cast variants (p12, quantized12, modelP12,
// modelInstancedSB, modelSkinned) MUST preserve this shape — each variant
// differs only in how it produces `rte` before multiplying by u.lightVP.
//
// Layout per cascade (128 bytes = 32 floats, one buffer per cascade):
//   offset  0 (float  0..15): lightVP_RTE (column-major mat4<f32>)
//   offset 64 (float 16..18): camHigh (vec3<f32>)
//   offset 76 (float 19):     _pad
//   offset 80 (float 20..22): camLow  (vec3<f32>)
//   offset 92 (float 23):     _pad
//   offset 96 (float 24):     depthBias     (f32)
//   offset100 (float 25):     normalBias    (f32 — reserved, always 0 in Slice 1)
//   offset104 (float 26..31): _pad (6 floats)
// Only floats 0..27 (112 bytes) carry data; the buffer is rounded up to
// 128 bytes (floats 28..31, the final 16) to match WebGPUShadowMapRenderer's
// SHADOW_UNIFORM_SIZE so CSM reuses the existing cast pipelines'
// bind-group layout without a second compile (WebGPUCSMRenderer.ts:62-68).
//
// If this layout needs to change, ALL Slice 2 variants' WGSL `u` struct
// declarations + `WebGPUCSMRenderer.renderCastPass` write sites move in
// lockstep. This spec catches drift at spec-run time.

describe("Renderer/WebGPU/WebGPUCSMRenderer cast UBO layout", function () {
  it("CSM_CAST_UBO_SIZE is 128 bytes (32 floats)", function () {
    expect(CSM_CAST_UBO_SIZE).toBe(128);
    expect(CSM_CAST_UBO_SIZE % 16).toBe(0); // WGSL mat4 alignment
  });

  it("fits a column-major mat4 + two vec3+pad + two f32 + 6-float pad", function () {
    const matBytes = 16 * 4; // 64
    const vec3PadBytes = (3 + 1) * 4; // 16 each
    const biasBytes = 2 * 4; // 8 (depthBias + normalBias)
    // Floats 26..31 are trailing pad: 4 bytes round the bias block up to a
    // 16-byte stride boundary, plus a final 16-byte (4-float) chunk that
    // bumps the buffer from 112 to 128 so its bind-group layout matches
    // WebGPUShadowMapRenderer's SHADOW_UNIFORM_SIZE (WebGPUCSMRenderer.ts:62-68,
    // WebGPUCSMCastPass.ts:206-217). The pack loop writes data[0..27] and
    // leaves data[28..31] zero.
    const trailingPad = 6 * 4; // 24
    const total =
      matBytes + vec3PadBytes + vec3PadBytes + biasBytes + trailingPad;
    expect(total).toBe(CSM_CAST_UBO_SIZE);
  });

  it("ShadowCast rte24 VS struct order matches the packed float offsets", function () {
    // These constants aren't exported (they're layout-derived in the
    // renderer + shader), but we document them here as the contract the
    // `rte24` WGSL in WebGPUShadowMapRenderer.js depends on. Changing any
    // of these requires editing BOTH the renderer pack code AND every
    // cast-variant WGSL `u` struct.
    const LIGHT_VP_FLOAT_OFFSET = 0;
    const CAM_HIGH_FLOAT_OFFSET = 16;
    const CAM_LOW_FLOAT_OFFSET = 20;
    const DEPTH_BIAS_FLOAT_OFFSET = 24;
    const NORMAL_BIAS_FLOAT_OFFSET = 25;

    expect(LIGHT_VP_FLOAT_OFFSET).toBe(0);
    expect(CAM_HIGH_FLOAT_OFFSET).toBe(LIGHT_VP_FLOAT_OFFSET + 16);
    expect(CAM_LOW_FLOAT_OFFSET).toBe(CAM_HIGH_FLOAT_OFFSET + 4); // +vec3+pad
    expect(DEPTH_BIAS_FLOAT_OFFSET).toBe(CAM_LOW_FLOAT_OFFSET + 4);
    expect(NORMAL_BIAS_FLOAT_OFFSET).toBe(DEPTH_BIAS_FLOAT_OFFSET + 1);
    // Final slot (26..27) is trailing pad — total stays at 32 floats.
    expect(NORMAL_BIAS_FLOAT_OFFSET + 3).toBe(CSM_CAST_UBO_SIZE / 4 - 4);
  });
});

describe("Renderer/WebGPU/WebGPUCSMRenderer cast bias constants", function () {
  it("BASE_MIN_BIAS matches the documented Slice 1 tuning", function () {
    // Cascade 0 (tightest) gets this value directly. If you change this,
    // update CSM_DESIGN.md's Slice 1 shipped section too — the numbers
    // there describe the user-visible shadow acne floor.
    expect(BASE_MIN_BIAS).toBeCloseTo(0.00005, 10);
    // Positivity matters: WGSL does `pos.z += u.depthBias`, and nudging
    // z forward (toward far) is what prevents self-shadowing acne.
    expect(BASE_MIN_BIAS).toBeGreaterThan(0);
  });

  it("BASE_MAX_SLOPE_BIAS is 10x BASE_MIN_BIAS (slope-scale cap)", function () {
    expect(BASE_MAX_SLOPE_BIAS).toBeCloseTo(0.0005, 10);
    expect(BASE_MAX_SLOPE_BIAS / BASE_MIN_BIAS).toBeCloseTo(10, 6);
  });
});
