// AtmosphereLUT.wgsl — Compute shader for atmosphere scattering lookup table
//
// Precomputes a 2D transmittance LUT and a 3D inscatter LUT for Nishita-style
// Rayleigh + Mie atmospheric scattering. The LUT is sampled by fragment shaders
// (SkyAtmosphere.wgsl, GlobeTerrain.wgsl) instead of per-pixel ray marching,
// reducing fragment cost from ~32 ray march steps to a single texture fetch.
//
// The full Bruneton set also includes multiple-scattering and irradiance
// entry points. Multiple scattering supplies bounded higher-order radiance,
// particularly near the horizon and in shadow. Irradiance combines direct
// sunlight with the diffuse-sky integral on a horizontal surface. Both passes
// sample the transmittance and single-scattering LUTs through group 1, leaving
// the original write-only group-0 layout unchanged.
//
// LUT dimensions:
//   Transmittance:       256×64  (cosZenith × altitude)
//   Inscatter (single):  256×128 (cosViewZenith × altitude, sun baked per UB)
//   MultipleScattering:  256×128 (relAzimuth × Hillaire-warped view-zenith)
//   SkyView (single):    256×128 (relAzimuth × Hillaire-warped view-zenith)
//   Irradiance:          256×64  (cosSunZenith × altitude)
//
// Dispatch: ceil(width/16) × ceil(height/16) workgroups of 16×16 threads.
//
// Reference: Eric Bruneton & Fabrice Neyret, "Precomputed Atmospheric
//            Scattering" (EGSR 2008) — multiple-scattering + irradiance
//            iteration; Sébastien Hillaire (2020 Unreal sky); the technique
//            is reimplemented from the published papers, not copied from any
//            GPL/BSD reference source. Takram `three-geospatial` (MIT) folds
//            the same Bruneton LUT set into a WebGPU pipeline. The original
//            single-scattering path follows CesiumJS Nishita scattering in
//            SkyAtmosphere.wgsl.

const PI: f32 = 3.141592653589793;
const NUM_OPTICAL_DEPTH_SAMPLES: u32 = 16u;
const NUM_INSCATTER_SAMPLES: u32 = 32u;
// Sampling budgets for explicit multiple-scattering gather variants.
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
  // Cosine of the sun's zenith angle relative to the observer's local up.
  // `computeSkyView` uses it to place the sun on the canonical synthetic-frame
  // meridian; other kernels derive the elevation from `sunDirection`.
  sunCosZenith: f32,
  // Per-metre RGB Chappuis-band absorption coefficient. Ozone is a pure
  // absorber concentrated in a tent profile around 25 km; adding it to each
  // Beer-Lambert extinction term deepens long twilight paths. A zero
  // coefficient leaves the bake unchanged.
  ozoneCoefficient: vec3<f32>,
  _pad3: f32,
}

@group(0) @binding(0) var<uniform> params: AtmosphereParams;
@group(0) @binding(1) var transmittanceOutput: texture_storage_2d<rgba16float, write>;
@group(0) @binding(2) var inscatterOutput: texture_storage_2d<rgba16float, write>;

// Group 1 contains the multiple-scattering and irradiance inputs. Those
// kernels read their own parameters from binding 0 and never reference group
// 0, so their auto-derived layout needs only the bind group at index 1. The
// original entry points do not reference these bindings and retain their
// group-0-only layout.
@group(1) @binding(0) var<uniform> extParams: AtmosphereParams;
@group(1) @binding(1) var lutSampler: sampler;
@group(1) @binding(2) var transmittanceTex: texture_2d<f32>;
@group(1) @binding(3) var singleScatterTex: texture_2d<f32>;
@group(1) @binding(4) var multipleScatterOutput: texture_storage_2d<rgba16float, write>;
@group(1) @binding(5) var irradianceOutput: texture_storage_2d<rgba16float, write>;
// `computeSkyView` alone writes this output. Sharing group 1 with the
// multiple-scattering and irradiance passes avoids another bind-group layout.
@group(1) @binding(6) var skyViewOutput: texture_storage_2d<rgba16float, write>;

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

// Compute optical depth along a ray from the origin over a fixed length.
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

// Bruneton/Hillaire ozone number-density profile. Unlike exponential
// Rayleigh and Mie density, ozone occupies a symmetric linear tent centered at
// 25 km. The relative density is used only for Beer-Lambert extinction; the
// coefficient supplies the per-metre magnitude.
fn ozoneDensity(height: f32) -> f32 {
  let center = 25000.0;
  let halfWidth = 15000.0;
  return max(0.0, 1.0 - abs(height - center) / halfWidth);
}

// Ozone optical depth along a ray (same quadrature as `opticalDepth`, but with
// the tent profile instead of an exponential). Multiplied by the ozone
// coefficient at the call site to form the extinction contribution.
fn ozoneOpticalDepth(
  origin: vec3<f32>,
  dir: vec3<f32>,
  rayLength: f32,
  planetRadius: f32,
) -> f32 {
  let stepSize = rayLength / f32(NUM_OPTICAL_DEPTH_SAMPLES);
  var sum: f32 = 0.0;
  for (var i = 0u; i < NUM_OPTICAL_DEPTH_SAMPLES; i++) {
    let t = (f32(i) + 0.5) * stepSize;
    let point = origin + dir * t;
    let height = max(0.0, length(point) - planetRadius);
    sum += ozoneDensity(height) * stepSize;
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
  // Ozone contributes absorption only; a zero coefficient is the identity.
  let ozoneOD = ozoneOpticalDepth(origin, dir, rayLength, params.innerRadius);

  // Transmittance = Beer-Lambert attenuation
  let transmittance = exp(
    -(params.rayleighCoefficient * rayleighOD + params.mieCoefficient * mieOD +
      params.ozoneCoefficient * ozoneOD)
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
  // Accumulate ozone optical depth alongside Rayleigh and Mie.
  var ozoneODSum: f32 = 0.0;

  for (var i = 0u; i < NUM_INSCATTER_SAMPLES; i++) {
    let t = (f32(i) + 0.5) * stepSize;
    let point = origin + viewDir * t;
    let height = max(0.0, length(point) - params.innerRadius);

    let rayleighDensity = densityAtHeight(height, params.rayleighScaleHeight) * stepSize;
    let mieDensity = densityAtHeight(height, params.mieScaleHeight) * stepSize;

    rayleighODSum += rayleighDensity;
    mieODSum += mieDensity;
    ozoneODSum += ozoneDensity(height) * stepSize;

    // Sun ray optical depth from sample point to top of atmosphere
    let sunHit = raySphereIntersect(point, sunDir, params.outerRadius);
    if (sunHit.y > 0.0) {
      let sunRayLength = sunHit.y;
      let sunOptDepthR = opticalDepth(point, sunDir, sunRayLength, params.rayleighScaleHeight, params.innerRadius);
      let sunOptDepthM = opticalDepth(point, sunDir, sunRayLength, params.mieScaleHeight, params.innerRadius);
      let sunOptDepthO = ozoneOpticalDepth(point, sunDir, sunRayLength, params.innerRadius);

      let attenuation = exp(
        -(params.rayleighCoefficient * (rayleighODSum + sunOptDepthR) +
          params.mieCoefficient * (mieODSum + sunOptDepthM) +
          params.ozoneCoefficient * (ozoneODSum + sunOptDepthO))
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

// Build an orthonormal basis around an up vector so sky-view azimuth can be
// measured in the local horizon plane. Both sky-view kernels place the sun on
// the positive tangent meridian and sweep the view by relative azimuth. WGSL
// requires the helper to precede its first caller.
fn skyViewBasis(up: vec3<f32>) -> mat3x3<f32> {
  // Pick a reference axis least aligned with `up` to avoid a degenerate cross.
  let ref0 = select(
    vec3<f32>(0.0, 0.0, 1.0),
    vec3<f32>(1.0, 0.0, 0.0),
    abs(up.z) > 0.999,
  );
  let tangent = normalize(cross(ref0, up));
  let bitangent = cross(up, tangent);
  return mat3x3<f32>(tangent, bitangent, up);
}

// Multiple-scattering LUT: higher scattering orders.
//
// U is relative view-to-sun azimuth over [0, pi], with mirror symmetry about
// the sun meridian. V is view zenith under the Hillaire horizon warp. The
// bounded proportional model evaluates the single-scattering integral along
// that azimuth-aware view ray, preserving its directionality across sun
// elevations. A ground-level observer matches `computeSkyView`, where the
// off-meridian contribution matters most.

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

  // Decode the sky-view domain (identical to computeSkyView):
  //   U → relative azimuth [0, π]
  //   V → cosViewZenith via the Hillaire warp inverse
  //         m = 2*V - 1 ; l = sign(m) * m*m
  let relAzimuth = uv.x * PI;
  let m = uv.y * 2.0 - 1.0;
  let cosViewZenith = sign(m) * m * m;
  let sinViewZenith = sqrt(max(0.0, 1.0 - cosViewZenith * cosViewZenith));

  // Ground-level observer (altitude 0), matching computeSkyView. The synthetic
  // local-horizon frame: up = +Y, the sun placed on the +tangent meridian at
  // the observer-relative sun zenith, the view swept by `relAzimuth`. Only the
  // relative (view, sun) geometry matters for the scattering integral
  // (rotational symmetry about `up`), so a canonical meridian + view sweep
  // captures every world azimuth.
  let altitude = 0.0;
  let origin = vec3<f32>(0.0, extParams.innerRadius + altitude, 0.0);
  let up = vec3<f32>(0.0, 1.0, 0.0);
  let basis = skyViewBasis(up);
  let tangent = basis[0];
  let bitangent = basis[1];

  let cosSunZenith = clamp(extParams.sunCosZenith, -1.0, 1.0);
  let sinSunZenith = sqrt(max(0.0, 1.0 - cosSunZenith * cosSunZenith));
  let sunDir = normalize(up * cosSunZenith + tangent * sinSunZenith);

  let viewHoriz = tangent * cos(relAzimuth) + bitangent * sin(relAzimuth);
  let viewDir = normalize(up * cosViewZenith + viewHoriz * sinViewZenith);

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

  let stepSize = rayLength / f32(NUM_INSCATTER_SAMPLES);
  // Using the same view-to-sun cosine as the single-scattering integral keeps
  // the field directional along the LUT's azimuth axis.
  let cosViewSun = dot(viewDir, sunDir);
  let rayleighPhaseVal = rayleighPhase(cosViewSun);
  let miePhaseVal = miePhase(cosViewSun, extParams.mieAnisotropy);

  // Reuse the Beer-Lambert single-scattering integral along this view ray.
  // Scaling that directional field by a bounded Hillaire-style factor keeps
  // the result stable across sun elevations.
  var totalRayleigh = vec3<f32>(0.0);
  var totalMie = vec3<f32>(0.0);
  var rayleighODSum: f32 = 0.0;
  var mieODSum: f32 = 0.0;
  // Accumulate ozone extinction along the view ray.
  var ozoneODSum: f32 = 0.0;

  for (var i = 0u; i < NUM_INSCATTER_SAMPLES; i++) {
    let t = (f32(i) + 0.5) * stepSize;
    let point = origin + viewDir * t;
    let height = max(0.0, length(point) - extParams.innerRadius);

    let rayleighDensity = densityAtHeight(height, extParams.rayleighScaleHeight) * stepSize;
    let mieDensity = densityAtHeight(height, extParams.mieScaleHeight) * stepSize;
    rayleighODSum += rayleighDensity;
    mieODSum += mieDensity;
    ozoneODSum += ozoneDensity(height) * stepSize;

    let sunHit = raySphereIntersect(point, sunDir, extParams.outerRadius);
    if (sunHit.y > 0.0) {
      let sunRayLength = sunHit.y;
      let sunOptDepthR = opticalDepth(point, sunDir, sunRayLength, extParams.rayleighScaleHeight, extParams.innerRadius);
      let sunOptDepthM = opticalDepth(point, sunDir, sunRayLength, extParams.mieScaleHeight, extParams.innerRadius);
      let sunOptDepthO = ozoneOpticalDepth(point, sunDir, sunRayLength, extParams.innerRadius);

      let attenuation = exp(
        -(extParams.rayleighCoefficient * (rayleighODSum + sunOptDepthR) +
          extParams.mieCoefficient * (mieODSum + sunOptDepthM) +
          extParams.ozoneCoefficient * (ozoneODSum + sunOptDepthO))
      );

      totalRayleigh += rayleighDensity * attenuation;
      totalMie += mieDensity * attenuation;
    }
  }

  let rayleighColor = totalRayleigh * extParams.rayleighCoefficient * rayleighPhaseVal;
  let mieColor = totalMie * extParams.mieCoefficient * miePhaseVal;
  let singleScatter = rayleighColor + mieColor;

  // Bounded multiple-scattering factor (f_ms). Multiple scattering adds a
  // fraction of the single-scatter radiance back as higher-order light — large
  // enough to lift the too-dark single-scatter horizon/limb, small enough that
  // it never overpowers the single-scatter sky (which would read as a flat
  // white veil). 0.5 is a perceptual constant in the Hillaire f_ms band; the
  // final on-screen strength is set by the sky shader's MS_SCALE.
  let F_MS: f32 = 0.5;
  let accum = singleScatter * F_MS * extParams.intensity;

  // Clamp before the rgba16float store so no Inf/NaN (or a >f16-max radiance
  // near the sun, where intensity × single-scatter can be large) reaches the
  // f16 path. Matches computeSkyView's [0, 60000] guard (rgba16float max finite
  // ≈ 65504, generous margin).
  let safe = clamp(accum, vec3<f32>(0.0), vec3<f32>(60000.0));
  let msLuminance = dot(safe, vec3<f32>(0.2126, 0.7152, 0.0722));
  textureStore(multipleScatterOutput, vec2<i32>(gid.xy), vec4<f32>(safe, msLuminance));
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

// Sky-view LUT: sun-relative all-azimuth sky radiance (Hillaire 2020).
//
// The legacy single-scatter inscatter LUT uses cosViewZenith by altitude and
// has no view-to-sun azimuth axis. It remains unchanged because globe, voxel,
// splat, and point-cloud fog paths depend on that mapping. This separate table
// supplies the missing azimuth dimension for the visible sky.
//
// Parameterization (Hillaire 2020 "A Scalable and Production Ready Sky and
// Atmosphere Rendering Technique", sky-view LUT):
//   U = relative view-to-sun azimuth over [0, PI], mapped to [0, 1]. Mirror
//       symmetry about the sun meridian lets that half-plane cover every
//       azimuth. U=0 looks sunward and U=1 looks anti-sun.
//   V = view zenith under the Hillaire horizon warp, which gives the thin
//       horizon band more resolution:
//         l = cosViewZenith
//         V = 0.5 + 0.5 * sign(l) * sqrt(abs(l))
//       V=0 looks down, V=0.5 is the horizon, and V=1 is the zenith.
// Sun zenith comes from the uniform, while the observer remains at ground
// level because off-meridian differences are strongest there. Sun-direction
// changes invalidate this table through the single-scatter dirty gate.
//
// Storage is rgba16float because atmosphere radiance can be large near the
// sun. Clamping before the store prevents non-finite values downstream. RGB
// stores combined Rayleigh and Mie inscatter with intensity baked in; alpha
// stores Mie luminance for layout symmetry with the inscatter LUT.
//
// `skyViewBasis` precedes the multiple-scattering pass because both kernels
// share the local-horizon basis and WGSL requires declaration before use.

@compute @workgroup_size(16, 16, 1)
fn computeSkyView(
  @builtin(global_invocation_id) gid: vec3<u32>,
) {
  // Use the storage target's dimensions rather than `params.lutHeight`, since
  // the shared uniform carries the transmittance height.
  let dims = textureDimensions(skyViewOutput);
  if (gid.x >= dims.x || gid.y >= dims.y) {
    return;
  }

  let uv = vec2<f32>(
    (f32(gid.x) + 0.5) / f32(dims.x),
    (f32(gid.y) + 0.5) / f32(dims.y),
  );

  // Decode U → relative azimuth [0, π]; V → cosViewZenith via the Hillaire
  // horizon warp inverse: V = 0.5 + 0.5*sign(l)*sqrt(|l|)  ⇒  given V,
  //   m = 2*V - 1        (in [-1, 1])
  //   l = sign(m) * m*m  (cosViewZenith)
  let relAzimuth = uv.x * PI;
  let m = uv.y * 2.0 - 1.0;
  let cosViewZenith = sign(m) * m * m;
  let sinViewZenith = sqrt(max(0.0, 1.0 - cosViewZenith * cosViewZenith));

  // Ground-level observer (altitude 0): the off-meridian sky differences this
  // table exists to capture are dominated by the ground/low-altitude view, and
  // the sky shader's parity reference (inline czm march) is the ground sky.
  let altitude = 0.0;
  let origin = vec3<f32>(0.0, extParams.innerRadius + altitude, 0.0);
  let up = vec3<f32>(0.0, 1.0, 0.0);

  // Place the sun in the local horizon frame at the same zenith as the world
  // sun, on the +tangent meridian (azimuth 0). The view direction is then built
  // at `relAzimuth` from that meridian. Only the relative geometry matters for
  // the scattering integral (rotational symmetry about `up`), so baking the sun
  // on a canonical meridian and sweeping the view azimuth fully captures the
  // (view, sun) relationship for any world azimuth.
  let basis = skyViewBasis(up);
  let tangent = basis[0];
  let bitangent = basis[1];

  // The observer-relative sun zenith cosine is packed by JS (dot of the world
  // sun direction with the observer's local up). The synthetic-frame `up` is
  // (0,1,0), so dot(sunDirection, up) would only be correct if the sun happened
  // to share this frame's vertical — which it doesn't for a ground observer at
  // arbitrary lat/lon. Use the explicit observer-relative cosine instead.
  let cosSunZenith = clamp(extParams.sunCosZenith, -1.0, 1.0);
  let sinSunZenith = sqrt(max(0.0, 1.0 - cosSunZenith * cosSunZenith));
  // Sun on the +tangent meridian (azimuth 0).
  let sunDir = normalize(up * cosSunZenith + tangent * sinSunZenith);

  // View direction at `relAzimuth` measured from the sun meridian, around `up`.
  let viewHoriz = tangent * cos(relAzimuth) + bitangent * sin(relAzimuth);
  let viewDir = normalize(up * cosViewZenith + viewHoriz * sinViewZenith);

  // Intersect the view ray with the atmosphere; clip at the planet surface.
  let hit = raySphereIntersect(origin, viewDir, extParams.outerRadius);
  if (hit.y < 0.0) {
    textureStore(skyViewOutput, vec2<i32>(gid.xy), vec4<f32>(0.0, 0.0, 0.0, 0.0));
    return;
  }
  let earthHit = raySphereIntersect(origin, viewDir, extParams.innerRadius);
  var rayLength = hit.y;
  if (earthHit.x > 0.0) {
    rayLength = earthHit.x;
  }

  let stepSize = rayLength / f32(NUM_INSCATTER_SAMPLES);
  let cosScatterAngle = dot(viewDir, sunDir);

  var totalRayleigh = vec3<f32>(0.0);
  var totalMie = vec3<f32>(0.0);
  var rayleighODSum: f32 = 0.0;
  var mieODSum: f32 = 0.0;
  // Include ozone extinction because the visible sky samples this table.
  // A zero coefficient leaves the result unchanged.
  var ozoneODSum: f32 = 0.0;

  for (var i = 0u; i < NUM_INSCATTER_SAMPLES; i++) {
    let t = (f32(i) + 0.5) * stepSize;
    let point = origin + viewDir * t;
    let height = max(0.0, length(point) - extParams.innerRadius);

    let rayleighDensity = densityAtHeight(height, extParams.rayleighScaleHeight) * stepSize;
    let mieDensity = densityAtHeight(height, extParams.mieScaleHeight) * stepSize;

    rayleighODSum += rayleighDensity;
    mieODSum += mieDensity;
    ozoneODSum += ozoneDensity(height) * stepSize;

    // Sun ray optical depth from the sample point to the top of atmosphere.
    let sunHit = raySphereIntersect(point, sunDir, extParams.outerRadius);
    if (sunHit.y > 0.0) {
      let sunRayLength = sunHit.y;
      let sunOptDepthR = opticalDepth(point, sunDir, sunRayLength, extParams.rayleighScaleHeight, extParams.innerRadius);
      let sunOptDepthM = opticalDepth(point, sunDir, sunRayLength, extParams.mieScaleHeight, extParams.innerRadius);
      let sunOptDepthO = ozoneOpticalDepth(point, sunDir, sunRayLength, extParams.innerRadius);

      let attenuation = exp(
        -(extParams.rayleighCoefficient * (rayleighODSum + sunOptDepthR) +
          extParams.mieCoefficient * (mieODSum + sunOptDepthM) +
          extParams.ozoneCoefficient * (ozoneODSum + sunOptDepthO))
      );

      totalRayleigh += rayleighDensity * attenuation;
      totalMie += mieDensity * attenuation;
    }
  }

  let rayleighPhaseVal = rayleighPhase(cosScatterAngle);
  let miePhaseVal = miePhase(cosScatterAngle, extParams.mieAnisotropy);

  let rayleighColor = extParams.intensity * totalRayleigh * extParams.rayleighCoefficient * rayleighPhaseVal;
  let mieColor = extParams.intensity * totalMie * extParams.mieCoefficient * miePhaseVal;

  let combined = rayleighColor + mieColor;
  let mieLuminance = dot(mieColor, vec3<f32>(0.2126, 0.7152, 0.0722));

  // Clamp before the rgba16float store so no Inf/NaN reaches an f16 path.
  // rgba16float max finite ≈ 65504; keep a generous margin.
  let safe = clamp(combined, vec3<f32>(0.0), vec3<f32>(60000.0));
  textureStore(skyViewOutput, vec2<i32>(gid.xy), vec4<f32>(safe, mieLuminance));
}
