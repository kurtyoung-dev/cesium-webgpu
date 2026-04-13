// EffectsUniforms.wgsl — Combined shadow receive + clipping plane uniforms
//
// Used by lit and flat primitive shaders + globe terrain shader.
// Shadow: comparison-sampled depth texture with PCF.
// Clipping: plane data packed into RGBA32Float texture, per-fragment discard,
//   plus optional Phase 5 WGF-1 hardware clip distances (precomputed dPrime).
//
// Placeholder resources (1×1 depth=1.0, planeCount=0) make this bind group
// always present — no pipeline-variant branching needed.
//
// Phase 5 WGF-1: `clipPlaneDPrime` carries the per-frame precomputed
// `dPrime[i] = plane[i].d + dot(plane[i].normal, cameraInPlaneSpace)`
// values used by the hardware clip distances variant of the globe terrain
// pipeline. Slots beyond `clippingPlaneCount` (or beyond 8 — the
// MAX_HARDWARE_CLIP_PLANES limit) carry +Infinity so the rasterizer never
// clips against them. The CPU helper at WebGPUClipDistancePrecompute.ts
// owns the precomputation; this struct just consumes the result.

struct EffectsUniforms {
  // ── Shadow receive ──
  shadowMatrix: mat4x4<f32>,   // world → shadow-map NDC
  shadowMapSize: vec2<f32>,    // shadow texture dimensions (for PCF texel size)
  shadowDarkness: f32,         // 0..1 shadow minimum brightness
  shadowSoftShadows: f32,      // 0.0 = hard, 1.0 = PCF soft

  // ── Clipping planes ──
  clippingPlaneCount: u32,     // 0 = no clipping
  clippingUnionMode: u32,      // 0 = intersection (AND), 1 = union (OR)
  clippingEdgeWidth: f32,      // edge highlight width in world units
  clippingPolygonCount: u32,   // >0 = polygon SDF clipping active
  clippingEdgeColor: vec4<f32>, // RGBA edge highlight color

  // ── Hardware clip distances (Phase 5 WGF-1) ──
  // Each entry packs `(plane.normal.xyz, dPrime)` where
  //   dPrime = plane.distance + dot(plane.normal, cameraInPlaneSpace)
  // is precomputed per-frame in FP64 on the CPU. The vertex shader
  // computes `dot(eqHW.xyz, eyeRelativePos) + eqHW.w` to get the clip
  // distance for plane i, with no texture sampling required.
  //
  // Unused slots carry (0,0,0,+Infinity) so the rasterizer's
  // `clip_distances[i] >= 0` check trivially passes for them. Only the
  // hardware-clip-distances pipeline variant reads this field; the
  // legacy fragment-discard path ignores it.
  clipPlaneEqHW: array<vec4<f32>, 8>,
};
