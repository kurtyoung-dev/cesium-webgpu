// ShadowReceiveCSM.wgsl — Cascade selection + blended shadow sampling
//
// Fragment-side helper for Cascaded Shadow Maps. Call selectCascade()
// with the fragment's view-space depth to determine which cascade to
// sample, then sampleCascadeShadow() to get the shadow factor with
// inter-cascade blending.
//
// RTE precision contract:
//   The cascade VP matrices in `CSMParams` are RTE-aware — they are
//   pre-multiplied by T(+cameraWC) on the CPU side (see
//   WebGPUCSMRenderer._applyCameraTranslationToVP). Callers MUST pass
//   a camera-relative position (`eyePos = positionHigh - camHigh +
//   positionLow - camLow`), NOT a reconstructed world position. Feeding
//   a lossy FP32 `worldPos = positionHigh + positionLow` breaks shadows
//   at Earth scale (6.37M m → ~1m quantization → acne everywhere).
//
// Bind group contract (effects group, typically @group(3)):
//   @binding(N+0) cascadeParams: uniform CSMParams
//   @binding(N+1) cascadeDepth:  texture_depth_2d_array
//   @binding(N+2) cascadeSampler: sampler_comparison
//
// Included by terrain + primitive receive shaders when CSM is active.

struct CSMParams {
  // 4 cascade view-projection matrices (RTE-aware, column-major, 64 bytes each)
  cascadeVP0: mat4x4<f32>,
  cascadeVP1: mat4x4<f32>,
  cascadeVP2: mat4x4<f32>,
  cascadeVP3: mat4x4<f32>,
  // Split distances (view-space far depth for each cascade)
  cascadeSplits: vec4<f32>,
  // Blend band widths per cascade (fraction of split range)
  blendBands: vec4<f32>,
  // Per-cascade minimum depth bias in NDC depth units (scaled by cascade
  // extent). Acts as a floor on grazing-free fragments.
  cascadeMinBias: vec4<f32>,
  // Per-cascade slope-scaled depth bias ceiling. Actual bias is
  //   max(minBias, slopeBias * (1 - dot(N, L)))
  // where N is surface normal and L is the light direction.
  cascadeMaxSlopeBias: vec4<f32>,
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

// Compute per-cascade slope-scaled depth bias. Larger bias at grazing
// angles to prevent acne; minBias acts as a floor for surfaces facing
// the light directly.
fn cascadeDepthBias(
  cascadeIdx: u32,
  normal: vec3<f32>,
  lightDir: vec3<f32>,
  params: CSMParams,
) -> f32 {
  let nDotL = clamp(dot(normalize(normal), normalize(lightDir)), 0.0, 1.0);
  let minBias = params.cascadeMinBias[cascadeIdx];
  let maxSlope = params.cascadeMaxSlopeBias[cascadeIdx];
  let slopeBias = maxSlope * (1.0 - nDotL);
  return max(minBias, slopeBias);
}

// Sample a single cascade's shadow map. `eyePos` is the camera-relative
// position (RTE); the cascade VP is pre-multiplied by T(+cameraWC) so
// we skip the lossy worldPos reconstruction.
//
// `pcfRadius` (in shadow texels) softens the cascade edge with a 3x3 PCF
// box kernel, matching WebGL's czm_shadowVisibility USE_SOFT_SHADOWS path
// (9-tap box averaged 1/9). 0 keeps a single hardware-comparison tap
// (hard aliased edge — bit-exact with the pre-PCF behavior). Callers wire
// `effects.csmControl.y` into this; the inlined copies in the receive
// shaders (GlobeTerrain / ModelPBRComplete / Primitive*) carry the same
// kernel verbatim. `textureSampleCompareLevel` (explicit LOD) is used so
// the taps are valid even inside the non-uniform cascade-select branch.
fn sampleOneCascade(
  eyePos: vec3<f32>,
  cascadeIdx: u32,
  depthBias: f32,
  pcfRadius: f32,
  params: CSMParams,
  shadowMap: texture_depth_2d_array,
  shadowSampler: sampler_comparison,
) -> f32 {
  let vp = getCascadeVP(cascadeIdx, params);
  let clipPos = vp * vec4<f32>(eyePos, 1.0);
  let ndc = clipPos.xyz / clipPos.w;

  // Map from NDC to texture UV. WebGPU viewport Y-flip: fragments at
  // NDC +y land at framebuffer y=0 (top), which is UV.y=0. So
  // `uv.y = (1 - ndc.y) / 2` to match what the cast pass stored.
  let uv = vec2<f32>(ndc.x * 0.5 + 0.5, 1.0 - (ndc.y * 0.5 + 0.5));
  let depth = ndc.z - depthBias;

  // Bounds check: fully lit if outside the cascade's XY footprint OR
  // past the far plane (depth > 1) OR behind the light's near plane
  // (depth < 0 — nearby fragments when the cascade eye sits deep).
  if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0 ||
      depth > 1.0 || depth < 0.0) {
    return 1.0;
  }

  // CSM-PCF-SOFT: hard single tap when pcfRadius <= 0.
  if (pcfRadius <= 0.0) {
    return textureSampleCompareLevel(
      shadowMap, shadowSampler, uv, i32(cascadeIdx), depth);
  }
  let dim = vec2<f32>(textureDimensions(shadowMap, 0));
  let texel = pcfRadius / max(dim, vec2<f32>(1.0));
  var vis = 0.0;
  for (var sx: i32 = -1; sx <= 1; sx++) {
    for (var sy: i32 = -1; sy <= 1; sy++) {
      let off = vec2<f32>(f32(sx), f32(sy)) * texel;
      vis = vis + textureSampleCompareLevel(
        shadowMap, shadowSampler, uv + off, i32(cascadeIdx), depth);
    }
  }
  return vis * (1.0 / 9.0);
}

// Sample shadow with inter-cascade blending to hide seams. Applies the
// slope-scaled depth bias from `cascadeDepthBias` internally so callers
// only need to pass N and L.
fn sampleCascadeShadow(
  eyePos: vec3<f32>,
  viewDepth: f32,
  normal: vec3<f32>,
  lightDir: vec3<f32>,
  pcfRadius: f32,
  params: CSMParams,
  shadowMap: texture_depth_2d_array,
  shadowSampler: sampler_comparison,
) -> f32 {
  let cascadeIdx = selectCascade(viewDepth, params.cascadeSplits);
  let bias0 = cascadeDepthBias(cascadeIdx, normal, lightDir, params);
  let s0 = sampleOneCascade(eyePos, cascadeIdx, bias0, pcfRadius, params, shadowMap, shadowSampler);

  // Blend with next cascade near the split boundary.
  let splitDist = params.cascadeSplits[cascadeIdx];
  let blendBand = params.blendBands[cascadeIdx];
  let blendStart = splitDist - blendBand;

  if (viewDepth > blendStart && cascadeIdx < 3u) {
    let nextIdx = cascadeIdx + 1u;
    let bias1 = cascadeDepthBias(nextIdx, normal, lightDir, params);
    let s1 = sampleOneCascade(eyePos, nextIdx, bias1, pcfRadius, params, shadowMap, shadowSampler);
    let blendT = smoothstep(blendStart, splitDist, viewDepth);
    return mix(s0, s1, blendT);
  }

  return s0;
}
