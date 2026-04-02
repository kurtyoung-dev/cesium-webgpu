/**
 * Compute shader for polygon signed distance field (SDF) generation.
 *
 * Equivalent to PolygonSignedDistanceFS.glsl (WebGL compute-via-fragment).
 * Generates a 2D SDF atlas where each region corresponds to a polygon.
 * Output: 0.5 = on edge, <0.5 = inside polygon, >0.5 = outside polygon.
 *
 * Used by ClippingPolygonCollection for polygon-based clipping in
 * primitive and globe shaders.
 *
 * Upstream sync (April 2026): Ported performance optimizations from
 * PolygonSignedDistanceFS.glsl — early-out for empty regions, per-polygon
 * bounding box reject with 5% padding, sorted-polygon early break,
 * vertex caching to halve texture reads per edge iteration.
 */

struct PolygonParams {
  polygonsLength: u32,
  extentsLength: u32,
  positionsWidth: u32,
  _pad: u32,
};

@group(0) @binding(0) var<uniform> params: PolygonParams;
@group(0) @binding(1) var positionsTexture: texture_2d<f32>;
@group(0) @binding(2) var extentsTexture: texture_2d<f32>;
@group(0) @binding(3) var outputSDF: texture_storage_2d<r32float, write>;

fn getPolygonPosition(index: u32) -> vec2<f32> {
  let width = params.positionsWidth;
  let x = index % width;
  let y = index / width;
  return textureLoad(positionsTexture, vec2<u32>(x, y), 0).xy;
}

fn getExtents(index: u32) -> vec4<f32> {
  return textureLoad(extentsTexture, vec2<u32>(index, 0u), 0);
}

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let outputSize = textureDimensions(outputSDF);
  if (gid.x >= outputSize.x || gid.y >= outputSize.y) {
    return;
  }

  let uv = vec2<f32>(
    (f32(gid.x) + 0.5) / f32(outputSize.x),
    (f32(gid.y) + 0.5) / f32(outputSize.y),
  );

  // Determine atlas dimension and which region this texel belongs to
  var dimension = f32(params.extentsLength);
  if (params.extentsLength > 2u) {
    dimension = ceil(log2(f32(params.extentsLength)));
  }
  let regionX = u32(floor(uv.x * dimension));
  let regionY = u32(floor(uv.y * dimension));
  let regionIndex = regionY * u32(dimension) + regionX;

  // Early-out: no polygons mapped to this region
  if (regionIndex >= params.extentsLength) {
    textureStore(outputSDF, vec2<u32>(gid.x, gid.y), vec4<f32>(1.0, 0.0, 0.0, 0.0));
    return;
  }

  var result = 1.0; // Default: outside all polygons
  var lastPolygonIndex = 0u;

  for (var polygonIndex = 0u; polygonIndex < params.polygonsLength; polygonIndex++) {
    // First entry for each polygon encodes (positionsLength, extentsIndex)
    let header = getPolygonPosition(lastPolygonIndex);
    let positionsLength = u32(header.x);
    let polygonExtentsIndex = u32(header.y);
    lastPolygonIndex += 1u;

    // Read per-polygon bounding box extents (2 pixels: south/west, latRange/lonRange)
    let extentsSW = getPolygonPosition(lastPolygonIndex);
    let extentsRange = getPolygonPosition(lastPolygonIndex + 1u);
    let polygonExtent = vec4<f32>(extentsSW, extentsRange);
    lastPolygonIndex += 2u;

    // Sorted-polygon early break: polygons are sorted by regionIndex
    if (polygonExtentsIndex < regionIndex) {
      lastPolygonIndex += positionsLength;
      continue;
    } else if (polygonExtentsIndex > regionIndex) {
      break;
    }

    // Compute geographic coordinates from atlas UV
    let extents = getExtents(polygonExtentsIndex);
    let textureOffset = vec2<f32>(
      f32(polygonExtentsIndex % u32(dimension)),
      floor(f32(polygonExtentsIndex) / dimension),
    ) / dimension;
    let localUV = (uv - textureOffset) * dimension;
    let latitude = mix(extents.x, extents.x + 1.0 / extents.z, localUV.y);
    let longitude = mix(extents.y, extents.y + 1.0 / extents.w, localUV.x);
    let p = vec2<f32>(latitude, longitude);

    // Per-polygon bounding box reject with 5% padding
    let padding = 0.05;
    let polygonNorth = polygonExtent.x + polygonExtent.z;
    let polygonEast = polygonExtent.y + polygonExtent.w;
    let latPadding = padding * polygonExtent.z;
    let lonPadding = padding * polygonExtent.w;
    if (p.x < polygonExtent.x - latPadding || p.x > polygonNorth + latPadding ||
        p.y < polygonExtent.y - lonPadding || p.y > polygonEast + lonPadding) {
      lastPolygonIndex += positionsLength;
      continue;
    }

    var clipAmount = 1e10;
    var s = 1.0;

    // Check each edge for absolute distance + winding number sign.
    // Cache previous vertex to halve texture reads per iteration.
    var prev = getPolygonPosition(lastPolygonIndex + positionsLength - 1u);
    for (var i = 0u; i < positionsLength; i++) {
      let a = getPolygonPosition(lastPolygonIndex + i);
      let b = prev;
      prev = a;

      let ab = b - a;
      let pa = p - a;
      let t = clamp(dot(pa, ab) / dot(ab, ab), 0.0, 1.0);
      let pq = pa - t * ab;
      let d = length(pq);

      // Inside/outside via winding parity
      let c1 = p.y >= a.y;
      let c2 = p.y < b.y;
      let c3 = ab.x * pa.y > ab.y * pa.x;
      if ((c1 && c2 && c3) || (!c1 && !c2 && !c3)) {
        s = -s;
      }
      if (abs(d) < abs(clipAmount)) {
        clipAmount = d;
      }
    }

    // Normalize to [0,1]: 0.5 = edge, <0.5 = inside, >0.5 = outside
    let normalized = (s * clipAmount * length(extents.zw)) / 2.0 + 0.5;
    result = min(result, normalized);

    lastPolygonIndex += positionsLength;
  }

  textureStore(outputSDF, vec2<u32>(gid.x, gid.y), vec4<f32>(result, 0.0, 0.0, 0.0));
}
