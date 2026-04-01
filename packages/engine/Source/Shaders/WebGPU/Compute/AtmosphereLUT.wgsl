// AtmosphereLUT.wgsl — Compute shader for atmosphere scattering lookup table
//
// Precomputes a 2D transmittance LUT and a 3D inscatter LUT for Nishita-style
// Rayleigh + Mie atmospheric scattering. The LUT is sampled by fragment shaders
// (SkyAtmosphere.wgsl, GlobeTerrain.wgsl) instead of per-pixel ray marching,
// reducing fragment cost from ~32 ray march steps to a single texture fetch.
//
// LUT dimensions:
//   Transmittance: 256×64 (cosZenith × altitude)
//   Inscatter:     256×128 (cosZenith × altitude, sun angle baked per row)
//
// Dispatch: ceil(width/16) × ceil(height/16) workgroups of 16×16 threads.
//
// Reference: Bruneton & Neyret (2008), Hillaire (2020 Unreal sky),
//            CesiumJS Nishita scattering in SkyAtmosphere.wgsl

const PI: f32 = 3.141592653589793;
const NUM_OPTICAL_DEPTH_SAMPLES: u32 = 16u;
const NUM_INSCATTER_SAMPLES: u32 = 32u;

struct AtmosphereParams {
  // Planet geometry
  innerRadius: f32,        // Earth surface radius (m)
  outerRadius: f32,        // Atmosphere outer radius (m)
  // Scattering scale heights
  rayleighScaleHeight: f32,
  mieScaleHeight: f32,
  // Phase function
  mieAnisotropy: f32,      // Henyey-Greenstein g parameter
  intensity: f32,           // Overall intensity multiplier
  // LUT dimensions
  lutWidth: u32,
  lutHeight: u32,
  // Scattering coefficients
  rayleighCoefficient: vec3<f32>,
  _pad0: f32,
  mieCoefficient: vec3<f32>,
  _pad1: f32,
  // Sun direction for inscatter LUT
  sunDirection: vec3<f32>,
  _pad2: f32,
}

@group(0) @binding(0) var<uniform> params: AtmosphereParams;
@group(0) @binding(1) var transmittanceOutput: texture_storage_2d<rgba16float, write>;
@group(0) @binding(2) var inscatterOutput: texture_storage_2d<rgba16float, write>;

// Density at a given altitude using exponential falloff
fn densityAtHeight(height: f32, scaleHeight: f32) -> f32 {
  return exp(-height / scaleHeight);
}

// Ray-sphere intersection: returns (tNear, tFar), negative if no hit
fn raySphereIntersect(origin: vec3<f32>, dir: vec3<f32>, radius: f32) -> vec2<f32> {
  let b = dot(origin, dir);
  let c = dot(origin, origin) - radius * radius;
  let discriminant = b * b - c;
  if (discriminant < 0.0) {
    return vec2<f32>(-1.0, -1.0);
  }
  let sqrtD = sqrt(discriminant);
  return vec2<f32>(-b - sqrtD, -b + sqrtD);
}

// Compute optical depth along a ray from origin in direction dir for a given length
fn opticalDepth(
  origin: vec3<f32>,
  dir: vec3<f32>,
  rayLength: f32,
  scaleHeight: f32,
  planetRadius: f32,
) -> f32 {
  let stepSize = rayLength / f32(NUM_OPTICAL_DEPTH_SAMPLES);
  var sum: f32 = 0.0;
  for (var i = 0u; i < NUM_OPTICAL_DEPTH_SAMPLES; i++) {
    let t = (f32(i) + 0.5) * stepSize;
    let point = origin + dir * t;
    let height = max(0.0, length(point) - planetRadius);
    sum += densityAtHeight(height, scaleHeight) * stepSize;
  }
  return sum;
}

// Rayleigh phase function
fn rayleighPhase(cosAngle: f32) -> f32 {
  return 3.0 / (16.0 * PI) * (1.0 + cosAngle * cosAngle);
}

// Henyey-Greenstein Mie phase function
fn miePhase(cosAngle: f32, g: f32) -> f32 {
  let g2 = g * g;
  let denom = 1.0 + g2 - 2.0 * g * cosAngle;
  return (1.0 - g2) / (4.0 * PI * pow(denom, 1.5));
}

// ═══════════════════════════════════════════════════════════
// TRANSMITTANCE LUT — optical depth from altitude to top of atmosphere
// ═══════════════════════════════════════════════════════════
//
// U axis: cos(zenith angle) mapped from [-1, 1] → [0, 1]
// V axis: altitude mapped from [0, atmosphereThickness] → [0, 1]
//
// Stores: transmittance = exp(-(rayleighOD * rayleighCoeff + mieOD * mieCoeff))

@compute @workgroup_size(16, 16, 1)
fn computeTransmittance(
  @builtin(global_invocation_id) gid: vec3<u32>,
) {
  if (gid.x >= params.lutWidth || gid.y >= params.lutHeight) {
    return;
  }

  let uv = vec2<f32>(
    (f32(gid.x) + 0.5) / f32(params.lutWidth),
    (f32(gid.y) + 0.5) / f32(params.lutHeight),
  );

  // Map UV to physical parameters
  let atmosphereThickness = params.outerRadius - params.innerRadius;
  let altitude = uv.y * atmosphereThickness;
  let cosZenith = uv.x * 2.0 - 1.0; // [-1, 1]

  // Ray origin at this altitude
  let origin = vec3<f32>(0.0, params.innerRadius + altitude, 0.0);
  let dir = vec3<f32>(sqrt(max(0.0, 1.0 - cosZenith * cosZenith)), cosZenith, 0.0);

  // Intersect with outer atmosphere sphere
  let hit = raySphereIntersect(origin, dir, params.outerRadius);
  if (hit.y < 0.0) {
    textureStore(transmittanceOutput, vec2<i32>(gid.xy), vec4<f32>(1.0, 1.0, 1.0, 1.0));
    return;
  }

  // Check if ray hits the planet surface
  let earthHit = raySphereIntersect(origin, dir, params.innerRadius);
  var rayLength = hit.y;
  if (earthHit.x > 0.0) {
    rayLength = earthHit.x; // Truncate at surface
  }

  // Compute optical depths along the ray
  let rayleighOD = opticalDepth(origin, dir, rayLength, params.rayleighScaleHeight, params.innerRadius);
  let mieOD = opticalDepth(origin, dir, rayLength, params.mieScaleHeight, params.innerRadius);

  // Transmittance = Beer-Lambert attenuation
  let transmittance = exp(
    -(params.rayleighCoefficient * rayleighOD + params.mieCoefficient * mieOD)
  );

  textureStore(transmittanceOutput, vec2<i32>(gid.xy), vec4<f32>(transmittance, 1.0));
}

// ═══════════════════════════════════════════════════════════
// INSCATTER LUT — single-scattering integral for sky color
// ═══════════════════════════════════════════════════════════
//
// U axis: cos(view zenith angle) → [0, 1]
// V axis: altitude + sun zenith angle encoded → [0, 1]
//
// Stores: Rayleigh inscatter (RGB) + Mie inscatter (A)

@compute @workgroup_size(16, 16, 1)
fn computeInscatter(
  @builtin(global_invocation_id) gid: vec3<u32>,
) {
  if (gid.x >= params.lutWidth || gid.y >= params.lutHeight) {
    return;
  }

  let uv = vec2<f32>(
    (f32(gid.x) + 0.5) / f32(params.lutWidth),
    (f32(gid.y) + 0.5) / f32(params.lutHeight),
  );

  let atmosphereThickness = params.outerRadius - params.innerRadius;

  // Decode UV: x = cosViewZenith, y = altitude (sun angle baked from uniform)
  let cosViewZenith = uv.x * 2.0 - 1.0;
  let altitude = uv.y * atmosphereThickness;

  let origin = vec3<f32>(0.0, params.innerRadius + altitude, 0.0);
  let viewDir = vec3<f32>(
    sqrt(max(0.0, 1.0 - cosViewZenith * cosViewZenith)),
    cosViewZenith,
    0.0,
  );

  // Intersect view ray with atmosphere
  let hit = raySphereIntersect(origin, viewDir, params.outerRadius);
  if (hit.y < 0.0) {
    textureStore(inscatterOutput, vec2<i32>(gid.xy), vec4<f32>(0.0, 0.0, 0.0, 0.0));
    return;
  }

  let earthHit = raySphereIntersect(origin, viewDir, params.innerRadius);
  var rayLength = hit.y;
  if (earthHit.x > 0.0) {
    rayLength = earthHit.x;
  }

  let stepSize = rayLength / f32(NUM_INSCATTER_SAMPLES);
  let sunDir = params.sunDirection;
  let cosAngle = dot(viewDir, sunDir);

  var totalRayleigh = vec3<f32>(0.0);
  var totalMie = vec3<f32>(0.0);
  var rayleighODSum: f32 = 0.0;
  var mieODSum: f32 = 0.0;

  for (var i = 0u; i < NUM_INSCATTER_SAMPLES; i++) {
    let t = (f32(i) + 0.5) * stepSize;
    let point = origin + viewDir * t;
    let height = max(0.0, length(point) - params.innerRadius);

    let rayleighDensity = densityAtHeight(height, params.rayleighScaleHeight) * stepSize;
    let mieDensity = densityAtHeight(height, params.mieScaleHeight) * stepSize;

    rayleighODSum += rayleighDensity;
    mieODSum += mieDensity;

    // Sun ray optical depth from sample point to top of atmosphere
    let sunHit = raySphereIntersect(point, sunDir, params.outerRadius);
    if (sunHit.y > 0.0) {
      let sunRayLength = sunHit.y;
      let sunOptDepthR = opticalDepth(point, sunDir, sunRayLength, params.rayleighScaleHeight, params.innerRadius);
      let sunOptDepthM = opticalDepth(point, sunDir, sunRayLength, params.mieScaleHeight, params.innerRadius);

      let attenuation = exp(
        -(params.rayleighCoefficient * (rayleighODSum + sunOptDepthR) +
          params.mieCoefficient * (mieODSum + sunOptDepthM))
      );

      totalRayleigh += rayleighDensity * attenuation;
      totalMie += mieDensity * attenuation;
    }
  }

  let rayleighPhaseVal = rayleighPhase(cosAngle);
  let miePhaseVal = miePhase(cosAngle, params.mieAnisotropy);

  let rayleighColor = params.intensity * totalRayleigh * params.rayleighCoefficient * rayleighPhaseVal;
  let mieColor = params.intensity * totalMie * params.mieCoefficient * miePhaseVal;

  // Pack: RGB = Rayleigh + Mie combined, A = Mie luminance for separate phase
  let combined = rayleighColor + mieColor;
  let mieLuminance = dot(mieColor, vec3<f32>(0.2126, 0.7152, 0.0722));

  textureStore(inscatterOutput, vec2<i32>(gid.xy), vec4<f32>(combined, mieLuminance));
}
