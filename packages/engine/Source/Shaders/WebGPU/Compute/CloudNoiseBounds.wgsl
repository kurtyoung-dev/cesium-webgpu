// Each node encloses its eight children. Byte packing preserves the source
// rgba8unorm extrema exactly; an averaged mip is never used as an upper bound.
@group(0) @binding(0) var noiseSource: texture_3d<f32>;
@group(0) @binding(1) var boundsSource: texture_3d<u32>;
@group(0) @binding(2) var boundsDestination: texture_storage_3d<rg32uint, write>;

fn packCloudNoiseBound(value: vec3<u32>) -> u32 {
  return value.x | (value.y << 8u) | (value.z << 16u);
}

fn unpackCloudNoiseBound(value: u32) -> vec3<u32> {
  return vec3<u32>(value & 255u, (value >> 8u) & 255u, (value >> 16u) & 255u);
}

@compute @workgroup_size(4, 4, 4)
fn seedCloudNoiseBounds(@builtin(global_invocation_id) id: vec3<u32>) {
  if (any(id >= textureDimensions(boundsDestination))) { return; }
  let limit = textureDimensions(noiseSource) - vec3<u32>(1u);
  var lower = vec3<u32>(255u);
  var upper = vec3<u32>(0u);
  for (var z = 0u; z < 2u; z++) {
    for (var y = 0u; y < 2u; y++) {
      for (var x = 0u; x < 2u; x++) {
        let coord = min(id * 2u + vec3<u32>(x, y, z), limit);
        let sample = textureLoad(noiseSource, vec3<i32>(coord), 0).rgb;
        let bytes = vec3<u32>(round(clamp(sample, vec3<f32>(0.0), vec3<f32>(1.0)) * 255.0));
        lower = min(lower, bytes);
        upper = max(upper, bytes);
      }
    }
  }
  textureStore(boundsDestination, vec3<i32>(id),
    vec4<u32>(packCloudNoiseBound(lower), packCloudNoiseBound(upper), 0u, 0u));
}

@compute @workgroup_size(4, 4, 4)
fn reduceCloudNoiseBounds(@builtin(global_invocation_id) id: vec3<u32>) {
  if (any(id >= textureDimensions(boundsDestination))) { return; }
  let limit = textureDimensions(boundsSource) - vec3<u32>(1u);
  var lower = vec3<u32>(255u);
  var upper = vec3<u32>(0u);
  for (var z = 0u; z < 2u; z++) {
    for (var y = 0u; y < 2u; y++) {
      for (var x = 0u; x < 2u; x++) {
        let coord = min(id * 2u + vec3<u32>(x, y, z), limit);
        let sample = textureLoad(boundsSource, vec3<i32>(coord), 0);
        lower = min(lower, unpackCloudNoiseBound(sample.x));
        upper = max(upper, unpackCloudNoiseBound(sample.y));
      }
    }
  }
  textureStore(boundsDestination, vec3<i32>(id),
    vec4<u32>(packCloudNoiseBound(lower), packCloudNoiseBound(upper), 0u, 0u));
}
