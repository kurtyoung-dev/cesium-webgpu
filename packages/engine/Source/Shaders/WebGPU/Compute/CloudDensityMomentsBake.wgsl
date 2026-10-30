// Sample the selected periodic field once, then reuse its distribution across
// coverage, vertical-profile and erosion-depth bins.
struct MomentBakeParameters { puffSize: f32, padding: vec3<f32>, }
@group(0) @binding(0) var momentShape: texture_3d<f32>;
@group(0) @binding(1) var momentDetail: texture_3d<f32>;
@group(0) @binding(2) var momentSampler: sampler;
@group(0) @binding(3) var<uniform> momentParameters: MomentBakeParameters;
@group(0) @binding(4) var<storage, read_write> momentSamples: array<vec2<f32>>;
@group(0) @binding(5) var momentOutput: texture_storage_3d<rgba16float, write>;

@compute @workgroup_size(64)
fn sampleCloudDensityDistribution(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= 128u) { return; }
  let index = f32(id.x) + 0.5;
  let canonical = fract(index * vec3<f32>(
    0.754877666, 0.569840291, 0.438579021
  )) * 256.0;
  let coordinates = cloudDensityCoordinatesFromWorldNoise(
    canonical, momentParameters.puffSize
  );
  let warp = textureSampleLevel(momentDetail, momentSampler, coordinates.warp, 0.0).rgb;
  let base = textureSampleLevel(
    momentShape, momentSampler, coordinates.shape + (warp - vec3<f32>(0.5)) * 0.5, 0.0
  ).r;
  let erosion = 1.0 - textureSampleLevel(
    momentDetail, momentSampler, coordinates.detail, 0.0
  ).r;
  momentSamples[id.x] = vec2<f32>(base, erosion);
}

@compute @workgroup_size(4, 4, 4)
fn bakeCloudDensityMoments(@builtin(global_invocation_id) id: vec3<u32>) {
  let size = textureDimensions(momentOutput);
  if (any(id >= size)) { return; }
  let parameters = vec3<f32>(id) / vec3<f32>(size - vec3<u32>(1u));
  let threshold = 1.0 - cloudEffectiveCoverage(parameters.x);
  var moments = vec4<f32>(0.0);
  for (var i = 0u; i < 128u; i++) {
    let sample = momentSamples[i];
    let gated = cloudCoverageGate(sample.x, threshold) * parameters.y;
    let density = cloudErodedDensity(gated, sample.y * parameters.z);
    moments += vec4<f32>(
      density, density * density, density * density * density,
      select(0.0, 1.0, density > 0.0)
    );
  }
  textureStore(momentOutput, vec3<i32>(id), moments / 128.0);
}
