// Finite curved air columns and contributing cloud distance.
const CLOUD_AIR_SCALE_HEIGHT_M: f32 = 8500.0;
const CLOUD_AIR_TOP_M: f32 = 111000.0;
// Normalize a 60 km sea-level grazing path to the aerial opacity cap.
const CLOUD_AERIAL_EXTINCTION_PER_M: f32 = 3.196937e-5;
const CLOUD_AERIAL_MAX: f32 = 0.85;

fn cloudAirColumnMeters(startAltitude: f32, mu: f32, pathLength: f32) -> f32 {
  let h0 = max(startAltitude, 0.0);
  let rho0 = exp(-h0 / CLOUD_AIR_SCALE_HEIGHT_M);
  // A DESCENDING path (mu < 0) is bounded where it reaches sea level: no view
  // ray continues below the surface. Without the bound the closed form's
  // `exp(-x)` grows without limit along such a path and overflows f32, which
  // then reaches the caller as a NaN haze fraction. At mu >= 0 the path is
  // unbounded and the closed form converges on its own.
  let base = max(pathLength, 0.0);
  let usable = select(base, min(base, h0 / max(-mu, 1e-6)), mu < 0.0);
  let x = usable * mu / CLOUD_AIR_SCALE_HEIGHT_M;
  // Near-horizontal paths: (1 - exp(-x))/x -> 1 - x/2 as x -> 0. Taking the
  // closed form there divides two quantities that both go to zero.
  if (abs(x) < 1e-3) {
    return rho0 * usable * (1.0 - 0.5 * x);
  }
  return rho0 * (CLOUD_AIR_SCALE_HEIGHT_M / mu) * (1.0 - exp(-x));
}


// The normal-section radius follows the oblate surface in the ray's tangent
// direction, without reconstructing a large absolute sample position.
fn cloudAirCurvatureRadius(up: vec3<f32>, direction: vec3<f32>) -> f32 {
  let axes = vec3<f32>(cloud.planetRadius, cloud.planetRadius, cloud.planetPolarRadius);
  let tangent = direction - up * dot(direction, up);
  let tangentLength = length(tangent);
  if (tangentLength < 1e-5) { return cloud.planetRadius; }
  let scaledTangent = tangent / (tangentLength * axes);
  let normalScale = length(axes * up);
  return 1.0 / max(normalScale * dot(scaledTangent, scaledTangent), 1e-12);
}

// Intersect the finite path with the air shell and stop at the first ground
// hit. A grazing path may turn upward again without ever reaching sea level.
fn cloudCurvedAirInterval(h0: f32, mu: f32, pathLength: f32, radius: f32) -> vec2<f32> {
  let r0 = radius + h0;
  let b = r0 * mu;
  let topDelta = (CLOUD_AIR_TOP_M - h0) * (2.0 * radius + CLOUD_AIR_TOP_M + h0);
  let discriminant = b * b + topDelta;
  if (discriminant < 0.0) { return vec2<f32>(0.0); }
  let root = sqrt(max(discriminant, 0.0));
  let entry = max(-b - root, 0.0);
  let exit = min(max(pathLength, 0.0), -b + root);
  let groundDelta = h0 * (2.0 * radius + h0);
  let groundDiscriminant = b * b - groundDelta;
  let groundHit = groundDelta / max(-b + sqrt(max(groundDiscriminant, 0.0)), 1e-6);
  let clippedExit = select(exit, min(exit, groundHit), mu < 0.0 && groundDiscriminant >= 0.0);
  return vec2<f32>(entry, max(entry, clippedExit));
}

fn cloudCurvedAirHeight(h0: f32, mu: f32, distance: f32, radius: f32) -> f32 {
  let r0 = radius + h0;
  let radialDelta = distance * (distance + 2.0 * r0 * mu);
  // Rationalize the height difference to preserve sub-metre changes near the
  // cloud instead of subtracting two planet-sized radii.
  let height = max(h0 + radialDelta /
    (sqrt(max(r0 * r0 + radialDelta, 0.0)) + r0), 0.0);
  return height;
}

fn cloudCurvedAirDensity(h0: f32, mu: f32, distance: f32, radius: f32) -> f32 {
  let height = cloudCurvedAirHeight(h0, mu, distance, radius);
  let density = exp(-height / CLOUD_AIR_SCALE_HEIGHT_M);
  return density;
}

fn cloudCurvedAirPair(
  h0: f32, mu: f32, middle: f32, halfWidth: f32,
  node: f32, weight: f32, radius: f32,
) -> f32 {
  return weight * (
    cloudCurvedAirDensity(h0, mu, middle - halfWidth * node, radius) +
    cloudCurvedAirDensity(h0, mu, middle + halfWidth * node, radius)
  );
}

fn cloudCurvedAirColumnMeters(
  startAltitude: f32, zenithCosine: f32, pathLength: f32, curvatureRadius: f32,
) -> f32 {
  let h0 = max(startAltitude, 0.0);
  let mu = clamp(zenithCosine, -1.0, 1.0);
  let radius = max(curvatureRadius, 1.0);
  let interval = cloudCurvedAirInterval(h0, mu, pathLength, radius);
  let middle = 0.5 * (interval.x + interval.y);
  let halfWidth = 0.5 * (interval.y - interval.x);
  // Eight-point Gauss-Legendre quadrature over air, not the possibly
  // interplanetary camera distance. It also resolves a near-tangent column.
  let integral =
    cloudCurvedAirPair(h0, mu, middle, halfWidth, 0.9602898565, 0.1012285363, radius) +
    cloudCurvedAirPair(h0, mu, middle, halfWidth, 0.7966664774, 0.2223810345, radius) +
    cloudCurvedAirPair(h0, mu, middle, halfWidth, 0.5255324099, 0.3137066459, radius) +
    cloudCurvedAirPair(h0, mu, middle, halfWidth, 0.1834346425, 0.3626837834, radius);
  return max(halfWidth * integral, 0.0);
}

// The sky-view bake is ground-based and carries the observer's sun zenith.
// Reuse its directional air-light color only near that observer's horizon.
fn cloudAerialSkyViewWeight(rayDir: vec3<f32>) -> f32 {
  let observerUp = normalize(cloud.cameraPosition);
  let heightWeight = 1.0 - smoothstep(
    CLOUD_AIR_SCALE_HEIGHT_M, 2.0 * CLOUD_AIR_SCALE_HEIGHT_M,
    max(cloud.cameraGeodeticHeight, 0.0)
  );
  return heightWeight * smoothstep(-0.02, 0.02, dot(observerUp, rayDir));
}

fn cloudAmbientSkyViewWeight(localUp: vec3<f32>, sunDir: vec3<f32>) -> f32 {
  let observerUp = normalize(cloud.cameraPosition);
  let sunZenithError = abs(dot(localUp - observerUp, sunDir));
  return 1.0 - smoothstep(0.02, 0.06, sunZenithError);
}

fn cloudAerialFraction(
  cloudAltitude: f32,
  towardCamera: vec3<f32>,
  upAtCloud: vec3<f32>,
  pathLength: f32,
  strength: f32,
  curvatureRadius: f32,
) -> f32 {
  let column = cloudCurvedAirColumnMeters(
    cloudAltitude, dot(towardCamera, upAtCloud), max(pathLength, 0.0), curvatureRadius
  );
  let opticalDepth = column * CLOUD_AERIAL_EXTINCTION_PER_M * max(strength, 0.0);
  return clamp(1.0 - exp(-opticalDepth), 0.0, CLOUD_AERIAL_MAX);
}

fn cloudVisibleAerialSample(
  distanceSum: f32,
  altitudeSum: f32,
  opacity: f32,
  entryDistance: f32,
  exitDistance: f32,
  bottom: f32,
  top: f32,
) -> vec2<f32> {
  let inverseOpacity = 1.0 / max(opacity, 1e-6);
  return vec2<f32>(
    clamp(distanceSum * inverseOpacity, entryDistance, exitDistance),
    clamp(altitudeSum * inverseOpacity, bottom, top)
  );
}
