// AtmosphereLUT.wgsl — Compute shader for atmosphere scattering lookup table
//
// Precomputes a 2D transmittance LUT and a 3D inscatter LUT for Nishita-style
// Rayleigh + Mie atmospheric scattering. The LUT is sampled by fragment shaders
// (SkyAtmosphere.wgsl, GlobeTerrain.wgsl) instead of per-pixel ray marching,
// reducing fragment cost from ~32 ray march steps to a single texture fetch.
//
// Track V-A1 (NEW-ATMO-BRUNETON-FULL-LUTS) extends the original
// transmittance + single-scattering pair to the full Bruneton precomputed
// set by adding two more entry points:
//   - computeMultipleScattering — gathers the single-scattering radiance
//     over a hemisphere of directions and integrates a bounded number of
//     higher scattering orders along the view ray. Brightens the sky
//     (especially near the horizon and in shadow) relative to single
//     scattering alone, which single-scattering models leave too dark.
//   - computeIrradiance — indirect sky irradiance landing on a horizontal
//     surface (the "delta E" / ground-irradiance LUT). Direct sun term
//     (transmittance · max(cosSunZenith, 0)) plus the diffuse-sky integral
//     of the inscattered radiance over the upper hemisphere.
// These two extra passes consume the transmittance + single-scattering LUTs
// as SAMPLED inputs (group 1) and write their own storage targets, so the
// original two entry points and their write-only group-0 layout are
// untouched.
//
// LUT dimensions:
//   Transmittance:       256×64  (cosZenith × altitude)
//   Inscatter (single):  256×128 (cosViewZenith × altitude, sun baked per UB)
//   MultipleScattering:  256×128 (same parameterization as inscatter)
//   Irradiance:          256×64  (cosSunZenith × altitude)
//
// Dispatch: ceil(width/16) × ceil(height/16) workgroups of 16×16 threads.
//
// Reference: Eric Bruneton & Fabrice Neyret, "Precomputed Atmospheric
//            Scattering" (EGSR 2008) — multiple-scattering + irradiance
//            iteration; Sébastien Hillaire (2020 Unreal sky); the technique
//            is reimplemented from the published papers, not copied from any
//            GPL/BSD reference source. Takram `three-geospatial` (MIT) folds
//            the same Bruneton LUT set into a WebGPU pipeline — credited per
//            migration_doc/RESEARCH_TAKRAM_GEOSPATIAL_VISUALS.md. Original
//            single-scattering path follows CesiumJS Nishita scattering in
//            SkyAtmosphere.wgsl.

const PI: f32 = 3.141592653589793;
const NUM_OPTICAL_DEPTH_SAMPLES: u32 = 16u;
const NUM_INSCATTER_SAMPLES: u32 = 32u;
// Multiple-scattering: directions sampled over the gather sphere and steps
// taken along the view ray when accumulating higher orders. Kept modest so
// the whole LUT (256×128) precomputes in one dispatch without timing out.
const NUM_MS_GATHER_DIRS: u32 = 32u;
const NUM_MS_RAY_SAMPLES: u32 = 16u;
// Irradiance: hemisphere directions integrated for the diffuse-sky term.
const NUM_IRRADIANCE_DIRS: u32 = 64u;

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

// ── Group 1: full-Bruneton extension (multiple-scattering + irradiance) ──
// These bindings are used ONLY by computeMultipleScattering / computeIrradiance.
// The original two entry points above declare neither group nor these bindings,
// so their auto-derived pipeline layout is unchanged. CRUCIALLY the extended
// kernels read their OWN params copy from this group (binding 0) and never
// touch @group(0) — so their auto-derived pipeline layout contains group 1
// only, and the dispatcher binds a single bind group at index 1 (no group-0
// bind group needed for these passes). The transmittance + single-scattering
// LUTs are bound here as SAMPLED inputs.
@group(1) @binding(0) var<uniform> extParams: AtmosphereParams;
@group(1) @binding(1) var lutSampler: sampler;
@group(1) @binding(2) var transmittanceTex: texture_2d<f32>;
@group(1) @binding(3) var singleScatterTex: texture_2d<f32>;
@group(1) @binding(4) var multipleScatterOutput: texture_storage_2d<rgba16float, write>;
@group(1) @binding(5) var irradianceOutput: texture_storage_2d<rgba16float, write>;

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

// ═══════════════════════════════════════════════════════════
// FULL-BRUNETON EXTENSION — sampling helpers (group 1 inputs)
// ═══════════════════════════════════════════════════════════
//
// Map physical parameters back onto the LUT UVs exactly as the write
// passes above laid them out, so the gather passes read consistent data.
//   Transmittance: u = (cosZenith + 1) / 2, v = altitude / thickness
//   Inscatter:     u = (cosViewZenith + 1) / 2, v = altitude / thickness
// `textureSampleLevel` is required in a compute stage (no implicit LOD).

fn sampleTransmittance(altitude: f32, cosZenith: f32) -> vec3<f32> {
  let thickness = extParams.outerRadius - extParams.innerRadius;
  let u = clamp(cosZenith * 0.5 + 0.5, 0.0, 1.0);
  let v = clamp(altitude / max(thickness, 1.0), 0.0, 1.0);
  return textureSampleLevel(transmittanceTex, lutSampler, vec2<f32>(u, v), 0.0).rgb;
}

fn sampleSingleScatter(altitude: f32, cosViewZenith: f32) -> vec3<f32> {
  let thickness = extParams.outerRadius - extParams.innerRadius;
  let u = clamp(cosViewZenith * 0.5 + 0.5, 0.0, 1.0);
  let v = clamp(altitude / max(thickness, 1.0), 0.0, 1.0);
  return textureSampleLevel(singleScatterTex, lutSampler, vec2<f32>(u, v), 0.0).rgb;
}

// ═══════════════════════════════════════════════════════════
// MULTIPLE-SCATTERING LUT — higher scattering orders
// ═══════════════════════════════════════════════════════════
//
// Same (cosViewZenith × altitude) parameterization as the single-scatter
// inscatter LUT. At each step along the view ray we GATHER the already-
// computed single-scattering radiance arriving from all directions (the
// in-scattered light field), weight it by the scattering phase + density,
// and integrate. This is the Bruneton "computeMultipleScattering" gather:
// the radiance scattered a second+ time toward the viewer. Adding it to the
// single-scattering term brightens the sky — most visibly near the horizon
// and on the shadowed limb where single scattering bottoms out.

@compute @workgroup_size(16, 16, 1)
fn computeMultipleScattering(
  @builtin(global_invocation_id) gid: vec3<u32>,
) {
  // Self-bound against the storage target's own dimensions (256×128) rather
  // than params.lutHeight — the shared uniform carries the transmittance
  // height (64), which would clip the bottom half of this LUT.
  let dims = textureDimensions(multipleScatterOutput);
  if (gid.x >= dims.x || gid.y >= dims.y) {
    return;
  }

  let uv = vec2<f32>(
    (f32(gid.x) + 0.5) / f32(dims.x),
    (f32(gid.y) + 0.5) / f32(dims.y),
  );

  let thickness = extParams.outerRadius - extParams.innerRadius;
  let cosViewZenith = uv.x * 2.0 - 1.0;
  let altitude = uv.y * thickness;

  let origin = vec3<f32>(0.0, extParams.innerRadius + altitude, 0.0);
  let viewDir = vec3<f32>(
    sqrt(max(0.0, 1.0 - cosViewZenith * cosViewZenith)),
    cosViewZenith,
    0.0,
  );

  let hit = raySphereIntersect(origin, viewDir, extParams.outerRadius);
  if (hit.y < 0.0) {
    textureStore(multipleScatterOutput, vec2<i32>(gid.xy), vec4<f32>(0.0, 0.0, 0.0, 0.0));
    return;
  }
  let earthHit = raySphereIntersect(origin, viewDir, extParams.innerRadius);
  var rayLength = hit.y;
  if (earthHit.x > 0.0) {
    rayLength = earthHit.x;
  }

  let stepSize = rayLength / f32(NUM_MS_RAY_SAMPLES);
  let sunDir = extParams.sunDirection;

  // Uniform-ish set of gather directions over the sphere (Fibonacci sphere).
  // The gather solid-angle weight is 4π / N for an isotropic sample set.
  let gatherWeight = (4.0 * PI) / f32(NUM_MS_GATHER_DIRS);
  let golden = PI * (3.0 - sqrt(5.0));

  var accum = vec3<f32>(0.0);
  var rayleighODSum: f32 = 0.0;
  var mieODSum: f32 = 0.0;

  for (var i = 0u; i < NUM_MS_RAY_SAMPLES; i++) {
    let t = (f32(i) + 0.5) * stepSize;
    let point = origin + viewDir * t;
    let r = length(point);
    let height = max(0.0, r - extParams.innerRadius);
    let up = point / max(r, 1.0);

    let rayleighDensity = densityAtHeight(height, extParams.rayleighScaleHeight) * stepSize;
    let mieDensity = densityAtHeight(height, extParams.mieScaleHeight) * stepSize;
    rayleighODSum += rayleighDensity;
    mieODSum += mieDensity;

    // Transmittance back to the viewer along the segment travelled so far.
    let viewAtten = exp(
      -(extParams.rayleighCoefficient * rayleighODSum + extParams.mieCoefficient * mieODSum)
    );

    // Gather the single-scattered radiance arriving at `point` from a
    // sphere of directions. Each contribution is the single-scattering LUT
    // value for (this altitude, the incoming direction's zenith) phased by
    // the angle between the incoming direction and the view direction.
    var gathered = vec3<f32>(0.0);
    for (var k = 0u; k < NUM_MS_GATHER_DIRS; k++) {
      let fk = f32(k) + 0.5;
      let cz = 1.0 - 2.0 * fk / f32(NUM_MS_GATHER_DIRS); // [-1, 1]
      let sr = sqrt(max(0.0, 1.0 - cz * cz));
      let phi = golden * fk;
      let dir = vec3<f32>(sr * cos(phi), sr * sin(phi), cz);

      let cosIncZenith = dot(dir, up);
      let incoming = sampleSingleScatter(height, cosIncZenith);

      // Phase from incoming → view direction (combined Rayleigh + Mie).
      let cosScatter = dot(dir, viewDir);
      let phase = rayleighPhase(cosScatter) + miePhase(cosScatter, extParams.mieAnisotropy);
      gathered += incoming * phase;
    }
    gathered *= gatherWeight;

    // Re-scatter the gathered field at the local medium and attenuate back.
    let localScatter =
      extParams.rayleighCoefficient * rayleighDensity + extParams.mieCoefficient * mieDensity;
    accum += gathered * localScatter * viewAtten;
  }

  accum *= extParams.intensity;

  let msLuminance = dot(accum, vec3<f32>(0.2126, 0.7152, 0.0722));
  textureStore(multipleScatterOutput, vec2<i32>(gid.xy), vec4<f32>(accum, msLuminance));
}

// ═══════════════════════════════════════════════════════════
// IRRADIANCE LUT — indirect sky irradiance on a horizontal surface
// ═══════════════════════════════════════════════════════════
//
// U axis: cos(sun zenith angle) mapped from [-1, 1] → [0, 1]
// V axis: altitude mapped from [0, thickness] → [0, 1]
//
// Stores the irradiance (W·m⁻²-ish, in LUT-relative units) landing on an
// upward-facing horizontal patch: the DIRECT term (sun transmittance ·
// max(cosSunZenith, 0)) plus the DIFFUSE term — the cosine-weighted integral
// of the inscattered sky radiance over the upper hemisphere. Positive
// everywhere the sun is up; falls off toward the horizon as cosSunZenith → 0
// and as the direct beam reddens/attenuates near grazing angles.

@compute @workgroup_size(16, 16, 1)
fn computeIrradiance(
  @builtin(global_invocation_id) gid: vec3<u32>,
) {
  let dims = textureDimensions(irradianceOutput);
  if (gid.x >= dims.x || gid.y >= dims.y) {
    return;
  }

  let uv = vec2<f32>(
    (f32(gid.x) + 0.5) / f32(dims.x),
    (f32(gid.y) + 0.5) / f32(dims.y),
  );

  let thickness = extParams.outerRadius - extParams.innerRadius;
  let cosSunZenith = uv.x * 2.0 - 1.0;
  let altitude = uv.y * thickness;

  // Direct sun irradiance on the horizontal surface: transmittance along the
  // sun zenith times the Lambert cosine term (clamped at the horizon).
  let muSun = max(cosSunZenith, 0.0);
  let directTransmittance = sampleTransmittance(altitude, cosSunZenith);
  let direct = extParams.intensity * directTransmittance * muSun;

  // Diffuse-sky irradiance: cosine-weighted hemisphere integral of the
  // inscattered radiance (single-scattering LUT). Cosine-weighted importance
  // sampling means each sample's weight is just π / N (the cosine cancels the
  // pdf), so we average the radiance and scale by π.
  let golden = PI * (3.0 - sqrt(5.0));
  var diffuse = vec3<f32>(0.0);
  for (var k = 0u; k < NUM_IRRADIANCE_DIRS; k++) {
    let fk = f32(k) + 0.5;
    // Cosine-weighted hemisphere: cz = sqrt(1 - u), u in (0,1).
    let u1 = fk / f32(NUM_IRRADIANCE_DIRS);
    let cz = sqrt(max(0.0, 1.0 - u1)); // cos(theta) ≥ 0 → upper hemisphere
    // Incoming radiance from a direction at this zenith (azimuth-averaged by
    // the LUT parameterization, which only stores the zenith dependence).
    diffuse += sampleSingleScatter(altitude, cz);
  }
  diffuse *= (PI / f32(NUM_IRRADIANCE_DIRS)) * extParams.intensity;

  let irradiance = direct + diffuse;
  let irrLuminance = dot(irradiance, vec3<f32>(0.2126, 0.7152, 0.0722));
  textureStore(irradianceOutput, vec2<i32>(gid.xy), vec4<f32>(irradiance, irrLuminance));
}
