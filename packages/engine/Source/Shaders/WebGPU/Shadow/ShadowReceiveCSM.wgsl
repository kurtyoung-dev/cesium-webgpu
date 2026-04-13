// ShadowReceiveCSM.wgsl — Cascade selection + blended shadow sampling
//
// Fragment-side helper for Cascaded Shadow Maps. Call selectCascade()
// with the fragment's view-space depth to determine which cascade to
// sample, then sampleCascadeShadow() to get the shadow factor with
// inter-cascade blending.
//
// Bind group contract (effects group, typically @group(3)):
//   @binding(N+0) cascadeParams: uniform CSMParams
//   @binding(N+1) cascadeDepth:  texture_depth_2d_array
//   @binding(N+2) cascadeSampler: sampler_comparison
//
// Included by terrain + primitive receive shaders when CSM is active.

struct CSMParams {
  // 4 cascade view-projection matrices (column-major, 64 bytes each)
  cascadeVP0: mat4x4<f32>,
  cascadeVP1: mat4x4<f32>,
  cascadeVP2: mat4x4<f32>,
  cascadeVP3: mat4x4<f32>,
  // Split distances (view-space far depth for each cascade)
  cascadeSplits: vec4<f32>,
  // Blend band widths per cascade (fraction of split range)
  blendBands: vec4<f32>,
}

// Select the smallest cascade that covers this fragment's depth.
fn selectCascade(viewDepth: f32, splits: vec4<f32>) -> u32 {
  if (viewDepth < splits.x) { return 0u; }
  if (viewDepth < splits.y) { return 1u; }
  if (viewDepth < splits.z) { return 2u; }
  return 3u;
}

// Get the cascade VP matrix by index.
fn getCascadeVP(idx: u32, params: CSMParams) -> mat4x4<f32> {
  switch (idx) {
    case 0u: { return params.cascadeVP0; }
    case 1u: { return params.cascadeVP1; }
    case 2u: { return params.cascadeVP2; }
    default: { return params.cascadeVP3; }
  }
}

// Sample a single cascade's shadow map.
fn sampleOneCascade(
  worldPos: vec3<f32>,
  cascadeIdx: u32,
  params: CSMParams,
  shadowMap: texture_depth_2d_array,
  shadowSampler: sampler_comparison,
) -> f32 {
  let vp = getCascadeVP(cascadeIdx, params);
  let clipPos = vp * vec4<f32>(worldPos, 1.0);
  let ndc = clipPos.xyz / clipPos.w;

  // Map from NDC [-1,1] to texture UV [0,1].
  let uv = ndc.xy * 0.5 + 0.5;
  let depth = ndc.z;

  // Bounds check: if outside [0,1], this pixel isn't in the cascade.
  if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) {
    return 1.0;
  }

  // Hardware comparison sample (PCF-ready via comparison sampler).
  return textureSampleCompareLevel(
    shadowMap,
    shadowSampler,
    uv,
    i32(cascadeIdx),
    depth,
  );
}

// Sample shadow with inter-cascade blending to hide seams.
fn sampleCascadeShadow(
  worldPos: vec3<f32>,
  viewDepth: f32,
  params: CSMParams,
  shadowMap: texture_depth_2d_array,
  shadowSampler: sampler_comparison,
) -> f32 {
  let cascadeIdx = selectCascade(viewDepth, params.cascadeSplits);
  let s0 = sampleOneCascade(worldPos, cascadeIdx, params, shadowMap, shadowSampler);

  // Blend with next cascade near the split boundary.
  let splitDist = params.cascadeSplits[cascadeIdx];
  let blendBand = params.blendBands[cascadeIdx];
  let blendStart = splitDist - blendBand;

  if (viewDepth > blendStart && cascadeIdx < 3u) {
    let nextIdx = cascadeIdx + 1u;
    let s1 = sampleOneCascade(worldPos, nextIdx, params, shadowMap, shadowSampler);
    let blendT = smoothstep(blendStart, splitDist, viewDepth);
    return mix(s0, s1, blendT);
  }

  return s0;
}
