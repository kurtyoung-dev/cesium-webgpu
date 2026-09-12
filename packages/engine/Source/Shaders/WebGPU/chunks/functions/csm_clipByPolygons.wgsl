// csm_clipByPolygons.wgsl — Polygon SDF clipping function
//
// Samples the pre-computed signed distance field (SDF) texture to determine
// if a fragment's geographic position falls inside a clipping polygon.
// The SDF is generated per-frame by PolygonSignedDistance.wgsl (compute).
//
// SDF encoding: 0.5 = on polygon edge, <0.5 = inside, >0.5 = outside.
// Clipping inverts CesiumJS convention: fragments INSIDE polygons are kept,
// fragments outside are clipped (discarded).
//
// Requires effects bind group bindings 5 (SDF texture) and 6 (SDF sampler),
// plus effects.clippingPolygonCount > 0 to be active.
//
// Usage in fragment shader:
//   if (csm_clipByPolygons(geographicCoord)) { discard; }
//
// DISPOSITION (2026-09-06): KEEP, pending the clipping-algorithm-divergence
// epic that this stub's follow-up work belongs to (currently blocked on the
// polygon-tables prerequisite landing elsewhere). Zero callers repo-wide,
// re-verified as of this date. This is a knowingly-wrong stub: the UV
// mapping below (lines that build `u`/`v` from `geoCoord`) is a naive
// normalized lon/lat — the LIVE production clip paths
// (`GlobeTerrain.wgsl`'s `globeClipByPolygon`, `ModelPBRComplete.wgsl`'s
// `modelClipByPolygon`) instead use the per-extent atlas-slot mapping with
// `czm_fastApproximateAtan2`, and this stub was never updated to match. Its
// most recent maintenance repaired an implicit-derivative texture-sampling
// hazard in place rather than removing the file, so the standing disposition
// is keep-and-fix, not delete; no removal date has ever been set anywhere in
// the fork's records.
//
// AUTHORITY. The governing disposition row is `UP-1` in the upstream-absorb
// table of the 2026-09-02 architecture review, which names this file
// explicitly and dispositions the whole clipping-polygon cluster ABSORB/DEBT
// and unowned. `UP-1`, not any worker-branch record, is what KEEP rests on;
// re-derive from that row, never from an illustrative anecdote in a
// governance document.
//
// Re-evaluate once the blocking prerequisite lands, alongside `UP-1`: either
// rewrite the atlas mapping to match and wire this in as the shared WGSL twin
// (retiring the duplicated inline logic in `GlobeTerrain.wgsl` and
// `ModelPBRComplete.wgsl`), or remove it then. Do not delete in this patch.

/**
 * Returns true if the fragment should be discarded based on polygon SDF clipping.
 * @param sdfTex The polygon SDF texture (r32float, [0..1] signed distance)
 * @param sdfSamp The SDF sampler (linear filtering)
 * @param geoCoord Geographic coordinate (longitude, latitude) in radians
 * @param polygonCount Number of active clipping polygons (from effects uniform)
 * @returns true if the fragment is OUTSIDE all clipping polygons (should discard)
 */
fn csm_clipByPolygons(
  sdfTex: texture_2d<f32>,
  sdfSamp: sampler,
  geoCoord: vec2<f32>,
  polygonCount: u32,
) -> bool {
  if (polygonCount == 0u) {
    return false; // No polygon clipping active
  }

  // Map geographic coordinates to SDF atlas UV space.
  // The SDF atlas is normalized to [0,1]×[0,1] with sub-regions per polygon.
  // Geographic coords need to be mapped to the atlas UV based on the
  // polygon extents that were used to generate the SDF.
  // For a simple implementation: use normalized lon/lat as UV.
  // Full implementation would use the same atlas region mapping as the compute shader.
  let PI = 3.14159265358979;
  let u = (geoCoord.x + PI) / (2.0 * PI);       // longitude → [0,1]
  let v = (geoCoord.y + PI * 0.5) / PI;          // latitude → [0,1]
  let uv = clamp(vec2<f32>(u, v), vec2<f32>(0.0), vec2<f32>(1.0));

  let sdfValue = textureSampleLevel(sdfTex, sdfSamp, uv, 0.0).r;

  // SDF < 0.5 means inside polygon → keep fragment (return false)
  // SDF >= 0.5 means outside polygon → discard fragment (return true)
  return sdfValue >= 0.5;
}

/**
 * Returns the minimum distance to any clipping polygon edge.
 * Used for edge highlighting (similar to plane-based clipping edge highlight).
 */
fn csm_polygonClipDistance(
  sdfTex: texture_2d<f32>,
  sdfSamp: sampler,
  geoCoord: vec2<f32>,
  polygonCount: u32,
) -> f32 {
  if (polygonCount == 0u) {
    return 1.0; // Far from any edge
  }

  let PI = 3.14159265358979;
  let u = (geoCoord.x + PI) / (2.0 * PI);
  let v = (geoCoord.y + PI * 0.5) / PI;
  let uv = clamp(vec2<f32>(u, v), vec2<f32>(0.0), vec2<f32>(1.0));

  let sdfValue = textureSampleLevel(sdfTex, sdfSamp, uv, 0.0).r;

  // Return distance from edge (0.5 = on edge, abs(sdfValue - 0.5) = distance)
  return abs(sdfValue - 0.5) * 2.0;
}
