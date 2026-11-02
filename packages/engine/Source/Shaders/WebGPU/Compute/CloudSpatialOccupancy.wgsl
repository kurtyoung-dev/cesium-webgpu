struct CloudOccupancyBuild {
  shapeOrigin: vec3<f32>, puffSize: f32,
  warpOrigin: vec3<f32>, cellSize: f32,
  physicalOffset: vec3<u32>, regional: u32,
  previousDelta: vec3<i32>, reset: u32,
}
@group(0) @binding(0) var occupancyShape: texture_3d<f32>;
@group(0) @binding(1) var occupancyWarp: texture_3d<f32>;
@group(0) @binding(2) var occupancySampler: sampler;
@group(0) @binding(3) var occupancyShapeBounds: texture_3d<u32>;
@group(0) @binding(4) var occupancyWarpBounds: texture_3d<u32>;
@group(0) @binding(5) var<uniform> occupancyBuild: CloudOccupancyBuild;
@group(0) @binding(6) var<storage, read> occupancyPages: array<vec4<u32>>;
@group(0) @binding(7) var occupancyDestination: texture_storage_3d<rgba8unorm, write>;

// The two LOD slabs remain separate through the final 1x1x2 mip. Maxima retain
// unknown leaves as occupied and never turn an averaged value into a bound.
@compute @workgroup_size(4, 4, 4)
fn reduceCloudOccupancy(@builtin(global_invocation_id) cell: vec3<u32>) {
  if (any(cell >= textureDimensions(occupancyDestination))) { return; }
  var upper = vec4<f32>(0.0);
  for (var z = 0; z < 2; z++) {
    for (var y = 0; y < 2; y++) {
      for (var x = 0; x < 2; x++) {
        upper = max(upper, textureLoad(occupancyShape, vec3<i32>(cell * 2u) + vec3<i32>(x, y, z), 0));
      }
    }
  }
  textureStore(occupancyDestination, vec3<i32>(cell), upper);
}

@compute @workgroup_size(4, 4, 4)
fn clearCloudOccupancy(@builtin(global_invocation_id) cell: vec3<u32>) {
  let previous = vec3<i32>(cell) + occupancyBuild.previousDelta;
  if (occupancyBuild.reset == 0u && all(previous >= vec3<i32>(0)) && all(previous < vec3<i32>(32))) { return; }
  let physical = vec3<i32>((cell + occupancyBuild.physicalOffset) % vec3<u32>(32u));
  textureStore(occupancyDestination, physical, vec4<f32>(1.0));
  textureStore(occupancyDestination, physical + vec3<i32>(0, 0, 32), vec4<f32>(1.0));
}

// Each channel encloses a whole shape-LOD interval. The independently filtered
// warp may cross two mip boundaries within that interval, so include every
// contributing integer level before expanding the shape-domain box.
fn cloudOccupancyBandUpper(
  shapeCenter: vec3<f32>, shapeExtent: vec3<f32>,
  warpCenter: vec3<f32>, warpExtent: vec3<f32>, band: i32,
) -> f32 {
  if (band >= i32(textureNumLevels(occupancyShape))) { return 1.0; }
  let lastShape = min(band + 1, i32(textureNumLevels(occupancyShape)) - 1);
  let bias = log2(CLOUD_DENSITY_WARP_RATIO * f32(textureDimensions(occupancyWarp).x) / f32(textureDimensions(occupancyShape).x));
  let firstWarp = i32(floor(max(0.0, f32(band) + bias)));
  let lastWarp = min(i32(ceil(max(0.0, f32(lastShape) + bias))), i32(textureNumLevels(occupancyWarp)) - 1);
  var warpLower = vec3<f32>(1.0);
  var warpUpper = vec3<f32>(0.0);
  for (var mip = firstWarp; mip <= lastWarp; mip++) {
    let range = cloudFilteredNoiseRangeAtMip(occupancyWarp, occupancySampler, occupancyWarpBounds,
      warpCenter - warpExtent, warpCenter + warpExtent, mip);
    warpLower = min(warpLower, range.lower);
    warpUpper = max(warpUpper, range.upper);
  }
  let lo = shapeCenter - shapeExtent + (warpLower - vec3<f32>(0.5)) * 0.5;
  let hi = shapeCenter + shapeExtent + (warpUpper - vec3<f32>(0.5)) * 0.5;
  var upper = 0.0;
  for (var mip = band; mip <= lastShape; mip++) {
    upper = max(upper, cloudFilteredNoiseRangeAtMip(occupancyShape, occupancySampler,
      occupancyShapeBounds, lo, hi, mip).upper.r);
  }
  // Round the stored UNORM bound outward, including the store's rounding.
  return min(1.0, (ceil(upper * 255.0) + 1.0) / 255.0);
}


@compute @workgroup_size(4, 4, 4)
fn updateCloudOccupancy(@builtin(workgroup_id) page: vec3<u32>, @builtin(local_invocation_id) local: vec3<u32>) {
  let cell = occupancyPages[page.x].xyz * 4u + local;
  let center = (vec3<f32>(cell) + vec3<f32>(0.5)) * occupancyBuild.cellSize;
  let scale = CLOUD_DENSITY_WORLD_TO_NOISE * occupancyBuild.puffSize;
  let shapeCenter = occupancyBuild.shapeOrigin + CLOUD_DENSITY_SHAPE_ROTATION * (center * scale);
  let warpCenter = occupancyBuild.warpOrigin + CLOUD_DENSITY_WARP_ROTATION * (center * scale * CLOUD_DENSITY_WARP_RATIO);
  let halfSize = occupancyBuild.cellSize * 0.5 + 0.01;
  let shapeExtent = (abs(CLOUD_DENSITY_SHAPE_ROTATION[0]) + abs(CLOUD_DENSITY_SHAPE_ROTATION[1]) + abs(CLOUD_DENSITY_SHAPE_ROTATION[2])) * halfSize * scale;
  let warpExtent = (abs(CLOUD_DENSITY_WARP_ROTATION[0]) + abs(CLOUD_DENSITY_WARP_ROTATION[1]) + abs(CLOUD_DENSITY_WARP_ROTATION[2])) * halfSize * scale * CLOUD_DENSITY_WARP_RATIO;
  let physical = vec3<i32>((cell + occupancyBuild.physicalOffset) % vec3<u32>(32u));
  for (var slab = 0; slab < 2; slab++) {
    var upper = vec4<f32>(1.0);
    for (var channel = 0; channel < 4; channel++) {
      upper[channel] = cloudOccupancyBandUpper(shapeCenter, shapeExtent, warpCenter, warpExtent, slab * 4 + channel);
    }
    textureStore(occupancyDestination, physical + vec3<i32>(0, 0, slab * 32), upper);
  }
}
