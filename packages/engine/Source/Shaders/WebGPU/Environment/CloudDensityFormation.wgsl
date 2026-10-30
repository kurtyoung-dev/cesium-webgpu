// Post-profile erosion shared by the detailed field and its statistical bake.
fn cloudErodedDensity(preErosion: f32, erosionLow: f32) -> f32 {
  if (erosionLow >= 1.0) { return 0.0; }
  return clamp((preErosion - erosionLow) / (1.0 - erosionLow), 0.0, 1.0);
}

// Moments contain density, density squared, density cubed and occupied area.
// A two-node quadrature for occupied samples retains the clear-area mass.
fn cloudMomentTransmittance(moments: vec4<f32>, opticalScale: f32) -> f32 {
  let occupied = clamp(moments.w, 0.0, 1.0);
  if (occupied <= 0.0 || opticalScale <= 0.0) { return 1.0; }
  let mean = max(moments.x / occupied, 0.0);
  let second = max(moments.y / occupied, mean * mean);
  let variance = max(second - mean * mean, 0.0);
  if (variance < 1e-5) {
    return 1.0 - occupied + occupied * exp(-mean * opticalScale);
  }
  let third = moments.z / occupied;
  let sum = (third - mean * second) / variance;
  let product = sum * mean - second;
  let root = sqrt(max(sum * sum - 4.0 * product, 0.0));
  let lower = clamp(0.5 * (sum - root), 0.0, mean);
  let upper = max(0.5 * (sum + root), mean);
  let upperWeight = clamp((mean - lower) / max(upper - lower, 1e-5), 0.0, 1.0);
  return clamp(1.0 - occupied + occupied * mix(
    exp(-lower * opticalScale), exp(-upper * opticalScale), upperWeight
  ), 0.0, 1.0);
}


// Minkowski sums approximate positive rank correlation along a column. They
// are exact for a fixed density distribution scaled by its vertical profile.
fn cloudOpticalMomentIncrement(moments: vec4<f32>, opticalScale: f32) -> vec3<f32> {
  return vec3<f32>(
    moments.x, sqrt(max(moments.y, 0.0)), pow(max(moments.z, 0.0), 1.0 / 3.0)
  ) * max(opticalScale, 0.0);
}

fn cloudColumnMomentTransmittance(sums: vec3<f32>, occupied: f32) -> f32 {
  return cloudMomentTransmittance(vec4<f32>(
    sums.x, sums.y * sums.y, sums.z * sums.z * sums.z, occupied
  ), 1.0);
}


// The baked base starts at two cycles per tile. Fade from its half-wavelength
// sampling limit to a fully unresolved wavelength; grazing rays retain detail.
fn cloudDistantDensityWeight(footprint: f32, tilePeriod: f32, viewCosine: f32) -> f32 {
  let wavelength = max(tilePeriod * 0.5, 1e-4);
  return smoothstep(0.5 * wavelength, wavelength, footprint) *
    smoothstep(0.25, 0.5, abs(viewCosine));
}


// Equal smoothstep edges are undefined; zero coverage is structurally empty.
fn cloudCoverageGate(baseNoise: f32, threshold: f32) -> f32 {
  if (threshold >= 1.0) { return 0.0; }
  return smoothstep(threshold, 1.0, baseNoise);
}
