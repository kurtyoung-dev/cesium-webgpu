// Finite plane-parallel air columns and contributing cloud distance.
// Curvature along near-limb paths requires a separate ellipsoid column solve.
const CLOUD_AIR_SCALE_HEIGHT_M: f32 = 8500.0;
const CLOUD_AERIAL_EXTINCTION_PER_M: f32 = 3.1618666e-5;
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

fn cloudAerialFraction(
  cloudAltitude: f32,
  towardCamera: vec3<f32>,
  upAtCloud: vec3<f32>,
  pathLength: f32,
  strength: f32,
) -> f32 {
  let column = cloudAirColumnMeters(
    cloudAltitude, dot(towardCamera, upAtCloud), max(pathLength, 0.0)
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
