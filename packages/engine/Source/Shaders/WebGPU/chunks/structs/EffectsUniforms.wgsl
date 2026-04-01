// EffectsUniforms.wgsl — Combined shadow receive + clipping plane uniforms
//
// Used by lit and flat primitive shaders + globe terrain shader.
// Shadow: comparison-sampled depth texture with PCF.
// Clipping: plane data packed into RGBA32Float texture, per-fragment discard.
//
// Placeholder resources (1×1 depth=1.0, planeCount=0) make this bind group
// always present — no pipeline-variant branching needed.

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
};
