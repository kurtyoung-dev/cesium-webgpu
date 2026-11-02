struct CloudNoiseRange {
  lower: vec3<f32>,
  upper: vec3<f32>,
}

fn cloudNoiseBoundBytes(value: u32) -> vec3<f32> {
  return vec3<f32>(f32(value & 255u), f32((value >> 8u) & 255u),
    f32((value >> 16u) & 255u)) / 255.0;
}

// A box in unwrapped periodic coordinates includes both trilinear mip levels.
// Expand it to the complete level-zero support of the coarser filter. Every
// level is a convex box average, so its samples stay within these byte extrema.
fn cloudNoiseRangeForBox(
  bounds: texture_3d<u32>, lower: vec3<f32>, upper: vec3<f32>, mip: f32,
) -> CloudNoiseRange {
  let levelCount = textureNumLevels(bounds);
  let sourceSize = f32(textureDimensions(bounds).x * 2u);
  let scale = exp2(ceil(clamp(mip, 0.0, f32(levelCount))));
  let filteredSize = sourceSize / scale;
  let first = vec3<i32>(floor((lower - vec3<f32>(0.000002)) * filteredSize - 0.5)) * i32(scale);
  let last = (vec3<i32>(floor((upper + vec3<f32>(0.000002)) * filteredSize - 0.5)) + vec3<i32>(2)) * i32(scale) - vec3<i32>(1);
  let span = last - first + vec3<i32>(1);
  let width = f32(max(span.x, max(span.y, span.z)));
  let level = i32(clamp(ceil(log2(max(width, 2.0))) - 1.0, 0.0, f32(levelCount - 1u)));
  let dimensions = vec3<i32>(textureDimensions(bounds, level));
  let blockSize = i32(exp2(f32(level + 1)));
  let start = vec3<i32>(floor(vec3<f32>(first) / f32(blockSize)));
  let end = vec3<i32>(floor(vec3<f32>(last) / f32(blockSize)));
  var minimum = vec3<f32>(1.0);
  var maximum = vec3<f32>(0.0);
  for (var z = 0; z < 2; z++) {
    for (var y = 0; y < 2; y++) {
      for (var x = 0; x < 2; x++) {
        let cell = min(start + vec3<i32>(x, y, z), end);
        let wrapped = ((cell % dimensions) + dimensions) % dimensions;
        let node = textureLoad(bounds, wrapped, level);
        minimum = min(minimum, cloudNoiseBoundBytes(node.x));
        maximum = max(maximum, cloudNoiseBoundBytes(node.y));
      }
    }
  }
  return CloudNoiseRange(max(minimum - vec3<f32>(0.0000152587890625), vec3<f32>(0.0)),
    min(maximum + vec3<f32>(0.0000152587890625), vec3<f32>(1.0)));
}

// Trilinear interpolation is multiaffine within each texel cell, so extrema on
// an axis-aligned box occur at corners of its intersections with those cells.
// A bounded enumeration is useful for small warp regions; large boxes retain
// the conservative hierarchy query without unbounded texture work.
fn cloudFilteredNoiseRangeAtMip(
  source: texture_3d<f32>, noiseSampler: sampler, bounds: texture_3d<u32>,
  lower: vec3<f32>, upper: vec3<f32>, level: i32,
) -> CloudNoiseRange {
  let size = f32(textureDimensions(source, level).x);
  // Include subtexel address rounding before finding interpolation boundaries.
  let coordinateGuard = vec3<f32>(1.0 / (256.0 * size) + 0.000002);
  let lo = lower - coordinateGuard;
  let hi = upper + coordinateGuard;
  let firstPlane = vec3<i32>(ceil(lo * size - 0.5));
  let lastPlane = vec3<i32>(floor(hi * size - 0.5));
  let planes = max(lastPlane - firstPlane + vec3<i32>(1), vec3<i32>(0));
  if (any(planes > vec3<i32>(2))) {
    return cloudNoiseRangeForBox(bounds, lo, hi, f32(level));
  }
  let count = planes + vec3<i32>(2);
  var minimum = vec3<f32>(1.0);
  var maximum = vec3<f32>(0.0);
  for (var z = 0; z < count.z; z++) {
    for (var y = 0; y < count.y; y++) {
      for (var x = 0; x < count.x; x++) {
        let index = vec3<i32>(x, y, z);
        let plane = (vec3<f32>(firstPlane + index - vec3<i32>(1)) + 0.5) / size;
        let point = select(select(plane, lo, index == vec3<i32>(0)),
          hi, index == count - vec3<i32>(1));
        let value = textureSampleLevel(source, noiseSampler, point, f32(level)).rgb;
        minimum = min(minimum, value);
        maximum = max(maximum, value);
      }
    }
  }
  // UNORM8 filtering can round both these extrema and the rendered lookup.
  // Round support outward instead of relying on ideal float interpolation.
  let valueGuard = vec3<f32>(2.0 / 255.0 + 0.0000152587890625);
  return CloudNoiseRange(max(minimum - valueGuard, vec3<f32>(0.0)),
    min(maximum + valueGuard, vec3<f32>(1.0)));
}

fn cloudFilteredNoiseRange(
  source: texture_3d<f32>, noiseSampler: sampler, bounds: texture_3d<u32>,
  lower: vec3<f32>, upper: vec3<f32>, mip: f32,
) -> CloudNoiseRange {
  let lod = clamp(mip, 0.0, f32(textureNumLevels(source) - 1u));
  let first = i32(floor(lod));
  let second = i32(ceil(lod));
  let a = cloudFilteredNoiseRangeAtMip(source, noiseSampler, bounds, lower, upper, first);
  if (first == second) { return a; }
  let b = cloudFilteredNoiseRangeAtMip(source, noiseSampler, bounds, lower, upper, second);
  // Bound both contributing levels; the sampler may round its LOD blend weight.
  return CloudNoiseRange(min(a.lower, b.lower), max(a.upper, b.upper));
}

fn cloudWarpedShapeRange(
  shape: texture_3d<f32>, warpTexture: texture_3d<f32>, noiseSampler: sampler,
  shapeBounds: texture_3d<u32>, warpBounds: texture_3d<u32>,
  shapeLower: vec3<f32>, shapeUpper: vec3<f32>,
  warpLower: vec3<f32>, warpUpper: vec3<f32>,
  shapeMip: f32, warpMip: f32,
) -> CloudNoiseRange {
  let warp = cloudFilteredNoiseRange(warpTexture, noiseSampler, warpBounds, warpLower, warpUpper, warpMip);
  return cloudFilteredNoiseRange(shape, noiseSampler, shapeBounds,
    shapeLower + (warp.lower - vec3<f32>(0.5)) * 0.5,
    shapeUpper + (warp.upper - vec3<f32>(0.5)) * 0.5,
    shapeMip);
}
