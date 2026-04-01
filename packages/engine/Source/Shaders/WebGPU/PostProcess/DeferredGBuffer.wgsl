// Deferred Rendering — G-Buffer Pack Shader
//
// Writes scene geometry data into a multi-render-target (MRT) G-buffer:
//   RT0 (rgba16float): albedo.rgb + metallic
//   RT1 (rgba16float): normal.xyz (eye-space, encoded) + roughness
//   RT2 (rgba16float): emission.rgb + occlusion
//   Depth: depth24plus-stencil8 (standard depth buffer)
//
// This shader replaces the standard forward fragment output when deferred
// rendering is active. Vertex processing is unchanged — only fragment
// output changes from a single color to MRT G-buffer writes.
//
// The G-buffer is consumed by DeferredLighting.wgsl which runs all
// lighting calculations in screen space.
//
// Benefits of deferred rendering for CesiumJS:
//   - O(pixels × lights) instead of O(objects × lights)
//   - Decouples geometry complexity from lighting complexity
//   - Enables efficient many-lights for urban scenes (>100 lights)
//   - SSAO/SSR can read G-buffer normals directly
//
// Activation:
//   scene.deferredLighting = true; // opt-in, forward rendering is default

// G-buffer output for MRT
struct GBufferOutput {
  @location(0) albedoMetallic: vec4<f32>,   // rgb=albedo, a=metallic
  @location(1) normalRoughness: vec4<f32>,  // rgb=normal (eye-space), a=roughness
  @location(2) emissionOcclusion: vec4<f32>, // rgb=emission, a=occlusion
};

// Encode eye-space normal to [0,1] range for storage
fn encodeNormal(n: vec3<f32>) -> vec3<f32> {
  return n * 0.5 + 0.5;
}

// Decode stored normal back to [-1,1] range
fn decodeNormal(encoded: vec3<f32>) -> vec3<f32> {
  return encoded * 2.0 - 1.0;
}

// Pack PBR material properties into G-buffer
fn packGBuffer(
  albedo: vec3<f32>,
  normalEC: vec3<f32>,
  metallic: f32,
  roughness: f32,
  emission: vec3<f32>,
  occlusion: f32,
) -> GBufferOutput {
  var out: GBufferOutput;
  out.albedoMetallic = vec4<f32>(albedo, metallic);
  out.normalRoughness = vec4<f32>(encodeNormal(normalize(normalEC)), roughness);
  out.emissionOcclusion = vec4<f32>(emission, occlusion);
  return out;
}
