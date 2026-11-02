//>>ifdef CLOUD_SPATIAL_OCCUPANCY
struct CloudOccupancyUniforms {
  originRelativeToEye: vec3<f32>, cellSize: f32,
  physicalOffset: vec3<u32>, enabled: u32,
}
@group(0) @binding(17) var cloudOccupancyTexture: texture_3d<f32>;
@group(0) @binding(18) var<uniform> cloudOccupancy: CloudOccupancyUniforms;

fn cloudSpatialNoiseUpper(position: vec3<f32>, mip: f32) -> f32 {
  if (cloudOccupancy.enabled == 0u || mip < 0.0 || mip > 7.0) { return 1.0; }
  let local = (position - cloudOccupancy.originRelativeToEye) / cloudOccupancy.cellSize;
  if (any(local < vec3<f32>(0.0)) || any(local >= vec3<f32>(32.0))) { return 1.0; }
  let cell = (vec3<u32>(floor(local)) + cloudOccupancy.physicalOffset) % vec3<u32>(32u);
  let band = u32(floor(mip));
  let value = textureLoad(cloudOccupancyTexture,
    vec3<i32>(cell) + vec3<i32>(0, 0, i32(band / 4u) * 32), 0);
  return min(1.0, value[band % 4u] + 0.0000152587890625);
}

fn cloudSpatialSampleEmpty(relativeNoise: vec3<f32>, footprint: f32, coverage: f32) -> bool {
  let mip = cloudNoiseMipLevel(footprint,
    CLOUD_DENSITY_WORLD_TO_NOISE * cloud.puffSize,
    textureDimensions(cloudShapeTex).x, textureNumLevels(cloudShapeTex));
  let upper = cloudSpatialNoiseUpper(relativeNoise / CLOUD_DENSITY_WORLD_TO_NOISE, mip);
  return upper + 0.0000152587890625 < 1.0 - cloudEffectiveCoverage(coverage);
}

fn cloudSpatialEmptyDistance(start: vec3<f32>, direction: vec3<f32>, mip: f32, threshold: f32) -> f32 {
  if (cloudSpatialNoiseUpper(start, mip) >= threshold) { return 0.0; }
  let local = (start - cloudOccupancy.originRelativeToEye) / cloudOccupancy.cellSize;
  let shifted = local + vec3<f32>(cloudOccupancy.physicalOffset);
  let band = u32(floor(mip));
  var blockSize = 1.0;
  for (var level = 1u; level < 6u; level++) {
    let side = 32u >> level;
    let cell = (vec3<u32>(floor(shifted)) >> vec3<u32>(level)) % vec3<u32>(side);
    let upper = textureLoad(cloudOccupancyTexture,
      vec3<i32>(cell) + vec3<i32>(0, 0, i32(band / 4u * side)), i32(level))[band % 4u];
    if (upper + 0.0000152587890625 >= threshold) { break; }
    blockSize *= 2.0;
  }
  // A toroidal block is clipped to the current logical window before it is
  // treated as one convex, certified-empty region.
  let blockMinimum = floor(shifted / blockSize) * blockSize - vec3<f32>(cloudOccupancy.physicalOffset);
  let lo = max(blockMinimum, vec3<f32>(0.0));
  let hi = min(blockMinimum + vec3<f32>(blockSize), vec3<f32>(32.0));
  let face = select(lo, hi, direction >= vec3<f32>(0.0));
  let moving = abs(direction) > vec3<f32>(1e-8);
  let divisor = select(vec3<f32>(1.0), direction, moving);
  let distances = select(vec3<f32>(1e20), (face - local) * cloudOccupancy.cellSize / divisor, moving);
  return max(0.0, min(distances.x, min(distances.y, distances.z)) - 0.01);
}

fn cloudSpatialSpanEmpty(direction: vec3<f32>, start: f32, end: f32) -> bool {
  if (end <= start) { return false; }
  var coverage = cloud.coverage;
  if (cloud.weatherMapEnabled > 0.5) {
//>>ifdef CLOUD_WEATHER_VOLUME_BOUNDS
    coverage = clamp(cloudWeatherCoverageUpper(direction, start, end) * cloud.weatherStrength, 0.0, 1.0);
    if (coverage <= 0.0) { return true; }
//>>else
    // Weather at one point cannot certify a whole interval.
    return false;
//>>endif
  }
  let first = cloudNoiseMipLevel(
    cloudViewPixelFootprint(start, cloud.inverseProjection[1].y, cloud.resolution.y),
    CLOUD_DENSITY_WORLD_TO_NOISE * cloud.puffSize,
    textureDimensions(cloudShapeTex).x, textureNumLevels(cloudShapeTex));
  let last = cloudNoiseMipLevel(
    cloudViewPixelFootprint(end, cloud.inverseProjection[1].y, cloud.resolution.y),
    CLOUD_DENSITY_WORLD_TO_NOISE * cloud.puffSize,
    textureDimensions(cloudShapeTex).x, textureNumLevels(cloudShapeTex));
  if (floor(first) != floor(last)) { return false; }
  let threshold = 1.0 - cloudEffectiveCoverage(coverage);
  return end - start <= cloudSpatialEmptyDistance(direction * start, direction, first, threshold);
}
//>>else
//>>endif
