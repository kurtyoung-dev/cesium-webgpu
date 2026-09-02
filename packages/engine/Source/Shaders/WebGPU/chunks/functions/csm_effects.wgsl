// csm_effects.wgsl — Shadow receive + clipping plane helper functions
//
// Shadow: PCF or hard shadow sampling from a depth comparison texture.
// Clipping: per-fragment plane tests for intersection and union modes.
//
// These functions are inlined into shaders that declare an EffectsUniforms
// bind group with shadow depth texture, comparison sampler, and clipping
// planes texture.

// Shadow receive.

fn csm_sampleShadowMap(
  shadowMap: texture_depth_2d,
  shadowSampler: sampler_comparison,
  uv: vec2<f32>,
  depth: f32,
) -> f32 {
  if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0 || depth > 1.0) {
    return 1.0;
  }
  return textureSampleCompareLevel(shadowMap, shadowSampler, uv, depth);
}

fn csm_sampleShadowMapPCF(
  shadowMap: texture_depth_2d,
  shadowSampler: sampler_comparison,
  uv: vec2<f32>,
  depth: f32,
  texelSize: vec2<f32>,
) -> f32 {
  if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0 || depth > 1.0) {
    return 1.0;
  }
  var shadow: f32 = 0.0;
  for (var x: i32 = -1; x <= 1; x++) {
    for (var y: i32 = -1; y <= 1; y++) {
      let offset = vec2<f32>(f32(x), f32(y)) * texelSize;
      shadow += textureSampleCompareLevel(shadowMap, shadowSampler, uv + offset, depth);
    }
  }
  return shadow / 9.0;
}

// Computes the shadow attenuation factor: 1.0 is fully lit and
// `effects.shadowDarkness` is fully shadowed.
// `worldPosition` is the fragment's RTE eye-space position after
// `translateRelativeToEye`.
fn csm_computeShadowFactor(
  worldPosition: vec3<f32>,
  effects: EffectsUniforms,
  shadowMap: texture_depth_2d,
  shadowSampler: sampler_comparison,
) -> f32 {
  // Shadow darkness of 1.0 means shadows are disabled (placeholder)
  if (effects.shadowDarkness >= 1.0) {
    return 1.0;
  }

  let shadowPos = effects.shadowMatrix * vec4<f32>(worldPosition, 1.0);
  // Already WebGPU shadow-texture space — scale/bias from
  // `ShadowMap.getViewProjection`, v-origin flip from
  // `toWebGPUShadowReceiveMatrix` (`WebGPUShadowReceiveTransform.ts`).
  // Reapplying `*0.5 + 0.5` here would squeeze every lookup into the wrong
  // quadrant, causing receivers to sample cleared depth and report the
  // fragment as lit. Cascaded receivers instead receive a raw clip-space
  // cascade view-projection matrix and perform the full remap themselves.
  let coord = shadowPos.xyz / shadowPos.w;
  let uv = coord.xy;
  let texelSize = 1.0 / effects.shadowMapSize;

  var visibility: f32;
  if (effects.shadowSoftShadows > 0.5) {
    visibility = csm_sampleShadowMapPCF(shadowMap, shadowSampler, uv, coord.z, texelSize);
  } else {
    visibility = csm_sampleShadowMap(shadowMap, shadowSampler, uv, coord.z);
  }

  return mix(effects.shadowDarkness, 1.0, visibility);
}

// Clipping planes.

// Tests a fragment against clipping planes in an RGBA32Float texture.
// Each texel: (normal.x, normal.y, normal.z, distance).
// Returns true if the fragment should be discarded.
fn csm_clipByPlanes(
  worldPosition: vec3<f32>,
  effects: EffectsUniforms,
  clippingTex: texture_2d<f32>,
  clippingSampler: sampler,
) -> bool {
  let count = effects.clippingPlaneCount;
  if (count == 0u) {
    return false;
  }

  let isUnion = effects.clippingUnionMode == 1u;
  let texWidth = f32(count);

  // Intersection mode discards when all planes clip the fragment, meaning it
  // is outside all half-spaces. Union mode discards when any plane clips it.
  var clippedCount: u32 = 0u;

  for (var i: u32 = 0u; i < count; i++) {
    let texelU = (f32(i) + 0.5) / texWidth;
    let planeData = textureSampleLevel(clippingTex, clippingSampler, vec2<f32>(texelU, 0.5), 0.0);
    let planeNormal = planeData.xyz;
    let planeDist = planeData.w;
    let dist = dot(worldPosition, planeNormal) + planeDist;

    if (dist < 0.0) {
      clippedCount++;
      if (isUnion) {
        return true; // Union: any plane clips → discard
      }
    }
  }

  // Intersection mode discards only when all planes clip the fragment.
  if (!isUnion && clippedCount == count) {
    return true;
  }

  return false;
}

// Computes distance to nearest clipping plane for edge highlighting.
// Returns the minimum absolute distance, or a large value if no clipping.
fn csm_clippingEdgeDistance(
  worldPosition: vec3<f32>,
  effects: EffectsUniforms,
  clippingTex: texture_2d<f32>,
  clippingSampler: sampler,
) -> f32 {
  let count = effects.clippingPlaneCount;
  if (count == 0u) {
    return 1e10;
  }

  let texWidth = f32(count);
  var minDist: f32 = 1e10;

  for (var i: u32 = 0u; i < count; i++) {
    let texelU = (f32(i) + 0.5) / texWidth;
    let planeData = textureSampleLevel(clippingTex, clippingSampler, vec2<f32>(texelU, 0.5), 0.0);
    let dist = abs(dot(worldPosition, planeData.xyz) + planeData.w);
    minDist = min(minDist, dist);
  }

  return minDist;
}
