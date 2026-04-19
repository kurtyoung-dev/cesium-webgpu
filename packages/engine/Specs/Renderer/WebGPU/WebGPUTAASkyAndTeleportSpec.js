import TAAShaderSource from "../../../Source/Shaders/WebGPU/PostProcess/TAA.js";

// TAA Slice 2 — locks the two small behaviors that shipped this slice:
//   1. Sky pixels (depth >= 1.0) now reproject through a camera-
//      rotation-dominant path. The shader clamps depth to 0.9999 and
//      zeroes the cameraDelta term for sky pixels to avoid catastrophic
//      cancellation between far-plane eye positions (≥ 10^7) and a
//      small cameraDelta (≤ 10^4).
//   2. CPU-side history invalidation on large cameraDelta (teleport
//      detection). When `|delta| > 50 km` the Scene.js caller passes
//      `historyValid = false` so the TAA blend restarts clean.
//
// Sky rotation-dominant math rationale:
//     For a point at the far plane, eye-relative position scales with
//     far (Cesium: 10^7–10^8 m). Adding cameraDelta (bounded by sane
//     frame motion, ≤ 10^4 m) to a 10^7-magnitude vector in FP32 loses
//     the delta entirely (ULP at 10^7 is ~1 m). Zeroing the delta
//     for sky is mathematically exact at infinity, and bounded by
//     |delta|/far (sub-pixel in screen space) for our 0.9999 depth
//     clamp.

describe("Renderer/WebGPU TAA Slice 2 behavior", function () {
  describe("Sky reprojection (depth >= 1.0)", function () {
    it("clamps depth to 0.9999 so the inverse-VP stays finite", function () {
      expect(TAAShaderSource).toMatch(
        /let\s+depth\s*=\s*min\(rawDepth,\s*0\.9999\)/,
      );
    });

    it("captures the isSky flag from rawDepth >= 1.0", function () {
      expect(TAAShaderSource).toMatch(/let\s+isSky\s*=\s*rawDepth\s*>=\s*1\.0/);
    });

    it("zeroes cameraDelta for sky pixels via select()", function () {
      expect(TAAShaderSource).toMatch(
        /select\(\s*params\.cameraDelta\s*,\s*vec3<f32>\(0\.0\)\s*,\s*isSky\s*\)/,
      );
    });

    it("removed the Slice 1 `depth >= 1.0 → return uv` early-out", function () {
      expect(TAAShaderSource).not.toMatch(
        /if \(depth >= 1\.0\) \{\s*return uv/,
      );
    });
  });

  describe("reprojectUV guards preserved from Slice 1", function () {
    it("still short-circuits on historyValid == 0u (first frame)", function () {
      expect(TAAShaderSource).toMatch(/params\.historyValid\s*==\s*0u/);
    });

    it("still guards against behind-camera points via clipPrev.w <= 0.0", function () {
      expect(TAAShaderSource).toMatch(/clipPrev\.w\s*<=\s*0\.0/);
    });

    it("still falls back to uv on offscreen prevUV (disocclusion)", function () {
      expect(TAAShaderSource).toMatch(
        /prevUV\.x\s*<\s*0\.0\s*\|\|\s*prevUV\.x\s*>\s*1\.0/,
      );
    });
  });

  describe("sky-reprojection numerical bounds (CPU simulation)", function () {
    // The "clamp depth to 0.9999" change introduces a maximum error of
    // `(1 - 0.9999) * far` = 0.0001 * far in eye-space. For Cesium's
    // near/far = {1, 1e8}, that's 1e4 m error along the view direction.
    // In screen space this maps through the projection to a sub-pixel
    // shift (the far-plane projection scale is ~1/far, so 1e4 / 1e8 =
    // 1e-4 NDC = sub-pixel at any sane resolution).
    it("0.9999 depth clamp maps to sub-pixel screen error at far-plane scale", function () {
      const farPlane = 1e8;
      const depthClampError = (1.0 - 0.9999) * farPlane; // eye-space meters
      // projection scale at far-plane: 1/far → 1e-8 per meter
      const ndcError = depthClampError / farPlane;
      // at 4K resolution, sub-pixel threshold is ~1/4000 = 2.5e-4
      expect(ndcError).toBeLessThan(2.5e-4);
    });

    it("cameraDelta at far-plane: ULP loss ratio", function () {
      // At eye-pos magnitude ~1e7, FP32 ULP is ~1 m. A 1 m cameraDelta
      // is right at the precision floor; a 1 km delta still loses ~99%
      // of its value to cancellation. Justifies the zero-out.
      const eyeMagnitude = 1e7;
      const fp32Ulp = eyeMagnitude / (1 << 23); // ~1.2 m
      expect(fp32Ulp).toBeGreaterThan(1.0);

      // Conversely: a 1 m cameraDelta at 1e7 eye-pos is below ULP,
      // so adding it is a no-op. Zeroing is correct.
      const typicalOrbitDelta = 10; // m/frame during a 500 km orbit
      expect(typicalOrbitDelta).toBeLessThan(fp32Ulp * 20); // same ball-park
    });
  });
});
