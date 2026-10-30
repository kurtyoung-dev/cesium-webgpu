fn cloudViewPixelFootprint(distance: f32, projectionScale: f32, resolution: f32) -> f32 {
  return 2.0 * max(distance, 0.0) * abs(projectionScale) / max(resolution, 1.0);
}

// The baked-noise LOD footprint of one view-march sample: the pixel footprint
// at the sample's distance, but never wider than the fine interval the sample
// stands for. Where a pixel is finer than the interval (a ground camera looking
// across the deck) the pixel wins and distant cloud keeps detail the old
// step-length LOD blurred away. From orbit the pixel is kilometres wide (about
// 3.7 km at 6,600 km and 2,048 px) while the interval is tens of metres, and
// filtering the shape and detail noise over the pixel pulls it to its mean
// before the coverage smoothstep in cloudMacroSampleAt, which then erases most
// of the deck: shape mip 5 instead of 0 roughly halves the gated base density
// at coverage 0.6. Clamping to the interval keeps distant views at the
// step-length LOD the march used before. cloud-density-lod.spec.mjs executes
// both regimes.
fn cloudDensityLodFootprint(distance: f32, projectionScale: f32, resolution: f32, fineStep: f32) -> f32 {
  return min(cloudViewPixelFootprint(distance, projectionScale, resolution), fineStep);
}

// Integer interval boundaries keep coarse probes and refinement on one lattice.
//
// Reference: Shota Matsuda, Takram — `@takram/three-clouds` in
// three-geospatial (MIT),
// https://github.com/takram-design-engineering/three-geospatial — the
// perspective step growth that `marchStepGrowth` drives here, and the far
// ray-distance cap (`maxRayDistance`, applied in `marchDeck`), that this pair of
// dials follows. Their march accumulates the scale per iteration
// (`stepSize *= perspectiveStepScale`); the normalized exponential boundaries
// used here are ours, chosen so a coarse probe and its refinement land on the
// same samples and the finite step budget reaches the far boundary.
// Technique only — no source was copied.
fn cloudMarchIntervalBoundary(
  interval: f32, count: f32, chord: f32, entryDistance: f32,
  thickness: f32, growthExponent: f32,
) -> f32 {
  let u = clamp(interval / max(count, 1.0), 0.0, 1.0);
  let exponent = min(growthExponent, 8.0);
  if (growthExponent > 0.001) {
    return chord * (exp(exponent * u) - 1.0) / (exp(exponent) - 1.0);
  }
  let linearFraction = clamp(max(entryDistance, thickness) / max(chord, 1.0), 0.0625, 1.0);
  return chord * u * (linearFraction + (1.0 - linearFraction) * u);
}
