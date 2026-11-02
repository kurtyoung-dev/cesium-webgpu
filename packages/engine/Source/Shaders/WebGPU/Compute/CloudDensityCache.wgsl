struct CloudDensityCacheBuild {
  originRelativeToEye: vec3<f32>, cellSize: f32,
  firstSlice: u32, size: u32, sliceCount: u32, pad: u32,
}
@group(1) @binding(0) var densityCacheOut: texture_storage_3d<rgba16float, write>;
@group(1) @binding(1) var<uniform> densityCacheBuild: CloudDensityCacheBuild;

fn cloudDensityCachePoint(relative: vec3<f32>) -> vec3<f32> {
  let centerHigh = -cloud.encodedCameraHigh;
  let centerLow = -cloud.encodedCameraLow;
  let coordinates = cloudDensityCoordinatesAtRelative(relative);
  let morphology = cloudMorphologyCoordinateAtRelative(relative);
  let world = (relative - centerHigh) - centerLow;
  var density = vec3<f32>(0.0);
  let count = select(1u, 3u, multiDeckEnabled());
  for (var deck = 0u; deck < count; deck++) {
    var bounds = vec2<f32>(cloud.cloudLayerBottom, cloud.cloudLayerTop);
    if (multiDeckEnabled()) {
      bounds = cloud.deckBoundsLow;
      if (deck == 1u) { bounds = cloud.deckBoundsMid; }
      if (deck == 2u) { bounds = cloud.deckBoundsHigh; }
    }
    if (bounds.y <= bounds.x) { continue; }
    let height = ellipsoidShellHeightFractionRTE(relative, centerHigh, centerLow,
      vec3<f32>(1.0) / cloudShellAxes(bounds.x), vec3<f32>(1.0) / cloudShellAxes(bounds.y));
    if (height <= 0.0 || height >= 1.0) { continue; }
    density[deck] = clamp(cloudDensityAtCoordinates(world, coordinates, morphology,
      height, bounds.x, bounds.y, 0.0), 0.0, 65504.0);
  }
  return density;
}

@compute @workgroup_size(4, 4, 1)
fn cloudDensityCacheBuildMain(@builtin(global_invocation_id) invocation: vec3<u32>) {
  if (invocation.x >= densityCacheBuild.size || invocation.y >= densityCacheBuild.size ||
      invocation.z >= densityCacheBuild.sliceCount) { return; }
  let id = invocation + vec3<u32>(0u, 0u, densityCacheBuild.firstSlice);
  var density = vec3<f32>(0.0);
  // Average the nonlinear, eroded density rather than its underlying noise.
  for (var sample = 0u; sample < 8u; sample++) {
    let offset = vec3<f32>(0.25 + f32(sample & 1u) * 0.5,
      0.25 + f32((sample >> 1u) & 1u) * 0.5, 0.25 + f32((sample >> 2u) & 1u) * 0.5);
    let relative = densityCacheBuild.originRelativeToEye + (vec3<f32>(id) + offset) * densityCacheBuild.cellSize;
    density += cloudDensityCachePoint(relative);
  }
  textureStore(densityCacheOut, vec3<i32>(id), vec4<f32>(density * 0.125, 1.0));
}
