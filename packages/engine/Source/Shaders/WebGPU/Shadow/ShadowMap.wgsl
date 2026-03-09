// ShadowMap.wgsl — Shadow map generation and sampling for CesiumJS WebGPU
// Separate vertex/fragment for shadow pass (depth-only) and shadow receiving

// ============== Shadow Cast Pass (depth-only) ==============

struct ShadowCastUniforms {
  lightViewProjection: mat4x4<f32>,
  encodedCameraHigh: vec3<f32>,
  _pad0: f32,
  encodedCameraLow: vec3<f32>,
  _pad1: f32,
  depthBias: f32,
  normalBias: f32,
  _pad2: vec2<f32>,
};

@group(0) @binding(0) var<uniform> shadowCast: ShadowCastUniforms;

struct ShadowCastVertexInput {
  @location(0) positionHigh: vec3<f32>,
  @location(1) positionLow: vec3<f32>,
};

struct ShadowCastVertexOutput {
  @builtin(position) position: vec4<f32>,
};

fn translateRelativeToEye(posHigh: vec3<f32>, posLow: vec3<f32>, camHigh: vec3<f32>, camLow: vec3<f32>) -> vec3<f32> {
  return (posHigh - camHigh) + (posLow - camLow);
}

@vertex
fn shadowCastVertex(input: ShadowCastVertexInput) -> ShadowCastVertexOutput {
  var output: ShadowCastVertexOutput;
  let posRTE = translateRelativeToEye(
    input.positionHigh, input.positionLow,
    shadowCast.encodedCameraHigh, shadowCast.encodedCameraLow
  );
  output.position = shadowCast.lightViewProjection * vec4<f32>(posRTE, 1.0);
  // Apply depth bias
  output.position.z += shadowCast.depthBias;
  return output;
}

// Fragment shader for shadow cast pass — no color output, depth only
@fragment
fn shadowCastFragment() {
  // Depth-only pass — no color output needed
}

// ============== Shadow Receive Functions ==============
// These are meant to be imported by other shaders

struct ShadowReceiveUniforms {
  shadowMatrix: mat4x4<f32>,  // transforms world→shadow map UV+depth
  shadowMapSize: vec2<f32>,
  shadowDarkness: f32,
  softShadows: f32,           // 0.0 = hard, 1.0 = PCF soft
};

fn sampleShadowMap(
  shadowMap: texture_depth_2d,
  shadowSampler: sampler_comparison,
  shadowCoord: vec3<f32>,
  shadowMapSize: vec2<f32>,
) -> f32 {
  let uv = shadowCoord.xy;
  let depth = shadowCoord.z;

  // Out of shadow map bounds = fully lit
  if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0 || depth > 1.0) {
    return 1.0;
  }

  return textureSampleCompare(shadowMap, shadowSampler, uv, depth);
}

fn sampleShadowMapPCF(
  shadowMap: texture_depth_2d,
  shadowSampler: sampler_comparison,
  shadowCoord: vec3<f32>,
  shadowMapSize: vec2<f32>,
) -> f32 {
  let uv = shadowCoord.xy;
  let depth = shadowCoord.z;

  if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0 || depth > 1.0) {
    return 1.0;
  }

  let texelSize = 1.0 / shadowMapSize;
  var shadow: f32 = 0.0;

  // 3x3 PCF kernel
  for (var x: i32 = -1; x <= 1; x++) {
    for (var y: i32 = -1; y <= 1; y++) {
      let offset = vec2<f32>(f32(x), f32(y)) * texelSize;
      shadow += textureSampleCompare(shadowMap, shadowSampler, uv + offset, depth);
    }
  }

  return shadow / 9.0;
}

fn computeShadowFactor(
  worldPosition: vec3<f32>,
  shadowReceive: ShadowReceiveUniforms,
  shadowMap: texture_depth_2d,
  shadowSampler: sampler_comparison,
) -> f32 {
  let shadowPos = shadowReceive.shadowMatrix * vec4<f32>(worldPosition, 1.0);
  let shadowCoord = shadowPos.xyz / shadowPos.w;
  // Remap from NDC [-1,1] to UV [0,1]
  let uv = shadowCoord.xy * 0.5 + 0.5;
  let remappedCoord = vec3<f32>(uv.x, 1.0 - uv.y, shadowCoord.z);

  var visibility: f32;
  if (shadowReceive.softShadows > 0.5) {
    visibility = sampleShadowMapPCF(shadowMap, shadowSampler, remappedCoord, shadowReceive.shadowMapSize);
  } else {
    visibility = sampleShadowMap(shadowMap, shadowSampler, remappedCoord, shadowReceive.shadowMapSize);
  }

  return mix(shadowReceive.shadowDarkness, 1.0, visibility);
}
