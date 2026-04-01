// GroundAtmosphere.wgsl — Nishita-style scattering for ground-level atmosphere
//
// Provides functions for computing atmospheric scattering on terrain surfaces.
// This is the WGSL equivalent of the GLSL GroundAtmosphere.glsl + AtmosphereCommon.glsl.
//
// The ground atmosphere adds:
// - Color shift near the horizon (blue haze at distance)
// - Reduced contrast at distance (aerial perspective)
// - Day/night transition effects with dynamic atmosphere lighting
//
// Usage in GlobeTerrain.wgsl:
//   let atmo = computeGroundAtmosphere(worldPos, lightDir, cameraPos, params);
//   color = mix(color, atmo.color, atmo.opacity);
//
// Atmosphere parameters are passed via a uniform struct from the globe's
// atmosphere settings (Globe.showGroundAtmosphere, atmosphereLightIntensity, etc.)

struct AtmosphereParams {
  // Inner radius (Earth radius) and outer radius (Earth + atmosphere thickness)
  innerRadius: f32,
  outerRadius: f32,
  // Scattering coefficients
  rayleighScaleHeight: f32,
  mieScaleHeight: f32,
  rayleighCoefficient: vec3<f32>,
  _pad0: f32,
  mieCoefficient: vec3<f32>,
  mieAnisotropy: f32,
  // Light intensity and dynamic lighting flags
  lightIntensity: f32,
  dynamicLighting: f32, // 0=off, 1=sunDirection, 2=viewerDirection
  _pad1: f32,
  _pad2: f32,
};

struct AtmosphereResult {
  color: vec3<f32>,
  opacity: f32,
};

const ATMOSPHERE_PI: f32 = 3.14159265358979323846;
const ATMOSPHERE_THICKNESS: f32 = 111000.0; // meters
const PRIMARY_STEPS: i32 = 16;
const LIGHT_STEPS: i32 = 4;

// Rayleigh phase function
fn rayleighPhase(cosAngle: f32) -> f32 {
  return 3.0 / (16.0 * ATMOSPHERE_PI) * (1.0 + cosAngle * cosAngle);
}

// Henyey-Greenstein phase function for Mie scattering
fn miePhase(cosAngle: f32, g: f32) -> f32 {
  let g2 = g * g;
  let num = 3.0 * (1.0 - g2) * (1.0 + cosAngle * cosAngle);
  let denom = 8.0 * ATMOSPHERE_PI * (2.0 + g2) * pow(1.0 + g2 - 2.0 * g * cosAngle, 1.5);
  return num / denom;
}

// Ray-sphere intersection. Returns (near, far) distances, or (-1, -1) if no hit.
fn raySphereIntersect(origin: vec3<f32>, dir: vec3<f32>, radius: f32) -> vec2<f32> {
  let a = dot(dir, dir);
  let b = 2.0 * dot(dir, origin);
  let c = dot(origin, origin) - radius * radius;
  let discriminant = b * b - 4.0 * a * c;
  if (discriminant < 0.0) {
    return vec2<f32>(-1.0, -1.0);
  }
  let sqrtD = sqrt(discriminant);
  return vec2<f32>((-b - sqrtD) / (2.0 * a), (-b + sqrtD) / (2.0 * a));
}

// Compute optical depth along a ray segment for both Rayleigh and Mie
fn computeOpticalDepth(
  origin: vec3<f32>,
  dir: vec3<f32>,
  rayLength: f32,
  innerRadius: f32,
  rayleighScale: f32,
  mieScale: f32,
  steps: i32,
) -> vec2<f32> {
  let stepSize = rayLength / f32(steps);
  var opticalDepthR: f32 = 0.0;
  var opticalDepthM: f32 = 0.0;

  for (var i: i32 = 0; i < steps; i = i + 1) {
    let samplePos = origin + dir * (f32(i) + 0.5) * stepSize;
    let altitude = length(samplePos) - innerRadius;
    opticalDepthR = opticalDepthR + exp(-altitude / rayleighScale) * stepSize;
    opticalDepthM = opticalDepthM + exp(-altitude / mieScale) * stepSize;
  }

  return vec2<f32>(opticalDepthR, opticalDepthM);
}

// Main scattering computation — Nishita single-scattering model
fn computeScattering(
  rayOrigin: vec3<f32>,
  rayDir: vec3<f32>,
  rayLength: f32,
  lightDir: vec3<f32>,
  params: AtmosphereParams,
) -> AtmosphereResult {
  var result: AtmosphereResult;
  result.color = vec3<f32>(0.0);
  result.opacity = 0.0;

  let stepSize = rayLength / f32(PRIMARY_STEPS);
  var totalRayleigh = vec3<f32>(0.0);
  var totalMie = vec3<f32>(0.0);
  var opticalDepthR: f32 = 0.0;
  var opticalDepthM: f32 = 0.0;

  for (var i: i32 = 0; i < PRIMARY_STEPS; i = i + 1) {
    let samplePos = rayOrigin + rayDir * (f32(i) + 0.5) * stepSize;
    let altitude = length(samplePos) - params.innerRadius;

    // Density at this point
    let hr = exp(-altitude / params.rayleighScaleHeight) * stepSize;
    let hm = exp(-altitude / params.mieScaleHeight) * stepSize;
    opticalDepthR = opticalDepthR + hr;
    opticalDepthM = opticalDepthM + hm;

    // Light ray optical depth (from sample point toward sun)
    let lightHit = raySphereIntersect(samplePos, lightDir, params.outerRadius);
    if (lightHit.y > 0.0) {
      let lightDepth = computeOpticalDepth(
        samplePos, lightDir, lightHit.y, params.innerRadius,
        params.rayleighScaleHeight, params.mieScaleHeight, LIGHT_STEPS
      );

      // Combined attenuation: primary ray + light ray
      let tau = params.rayleighCoefficient * (opticalDepthR + lightDepth.x)
              + params.mieCoefficient * 1.1 * (opticalDepthM + lightDepth.y);
      let attenuation = exp(-tau);

      totalRayleigh = totalRayleigh + hr * attenuation;
      totalMie = totalMie + hm * attenuation;
    }
  }

  // Phase functions
  let cosAngle = dot(rayDir, lightDir);
  let phaseR = rayleighPhase(cosAngle);
  let phaseM = miePhase(cosAngle, params.mieAnisotropy);

  // Combine Rayleigh and Mie
  let scattering = params.lightIntensity * (
    phaseR * params.rayleighCoefficient * totalRayleigh +
    phaseM * params.mieCoefficient * totalMie
  );

  // Opacity based on total optical depth
  let totalTau = params.rayleighCoefficient * opticalDepthR
               + params.mieCoefficient * 1.1 * opticalDepthM;
  let opacity = 1.0 - exp(-max(max(totalTau.r, totalTau.g), totalTau.b));

  result.color = scattering;
  result.opacity = clamp(opacity, 0.0, 1.0);
  return result;
}

// Convenience function: compute ground atmosphere for a terrain fragment
fn computeGroundAtmosphere(
  positionWC: vec3<f32>,
  lightDirection: vec3<f32>,
  cameraPositionWC: vec3<f32>,
  params: AtmosphereParams,
) -> AtmosphereResult {
  let cameraToPosition = positionWC - cameraPositionWC;
  let rayDir = normalize(cameraToPosition);
  let rayLength = length(cameraToPosition);

  return computeScattering(
    cameraPositionWC,
    rayDir,
    rayLength,
    lightDirection,
    params,
  );
}

// Apply atmosphere color to a surface color with fading based on distance
fn applyGroundAtmosphere(
  surfaceColor: vec3<f32>,
  atmosphereResult: AtmosphereResult,
  fadeDistance: f32,
  currentDistance: f32,
) -> vec3<f32> {
  // Fade in atmosphere effect based on distance
  let fadeFactor = clamp(currentDistance / max(fadeDistance, 1.0), 0.0, 1.0);
  let effectiveOpacity = atmosphereResult.opacity * fadeFactor;

  return mix(surfaceColor, atmosphereResult.color, effectiveOpacity);
}
