// Stable ray/ellipsoid intersection in scaled space. The returned roots remain in
// world metres because the scaled ray keeps the original t parameter.
fn rayEllipsoidIntersect(
  ro: vec3<f32>,
  rd: vec3<f32>,
  axes: vec3<f32>,
) -> vec2<f32> {
  let roScaled = ro / axes;
  let rdScaled = rd / axes;
  let a = max(dot(rdScaled, rdScaled), 1e-20);
  let tClosest = -dot(roScaled, rdScaled) / a;
  let closest = roScaled + rdScaled * tClosest;
  let halfChordSq = (1.0 - dot(closest, closest)) / a;
  if (halfChordSq < 0.0) {
    return vec2<f32>(-1.0);
  }
  let halfChord = sqrt(halfChordSq);
  return vec2<f32>(tClosest - halfChord, tClosest + halfChord);
}

// Camera-relative counterpart. Scale high and low independently, then cancel the
// large high component before applying the low refinement.
fn rayEllipsoidIntersectRTE(
  rd: vec3<f32>,
  centerHigh: vec3<f32>,
  centerLow: vec3<f32>,
  axes: vec3<f32>,
) -> vec2<f32> {
  let rdScaled = rd / axes;
  let centerHighScaled = centerHigh / axes;
  let centerLowScaled = centerLow / axes;
  let a = max(dot(rdScaled, rdScaled), 1e-20);
  let tClosest =
    (dot(rdScaled, centerHighScaled) + dot(rdScaled, centerLowScaled)) / a;
  let closest =
    (rdScaled * tClosest - centerHighScaled) - centerLowScaled;
  let halfChordSq = (1.0 - dot(closest, closest)) / a;
  if (halfChordSq < 0.0) {
    return vec2<f32>(-1.0);
  }
  let halfChord = sqrt(halfChordSq);
  return vec2<f32>(tClosest - halfChord, tClosest + halfChord);
}
