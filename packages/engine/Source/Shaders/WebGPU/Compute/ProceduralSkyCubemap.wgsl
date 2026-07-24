// NEW-MODEL-PBR-DIRECT-LIGHT-IBL-PARITY D1 (Batch 346) -- atmosphere-
// scattering sky cubemap fill.
//
// Writes the 6 faces of a cubemap so DynamicEnvironmentMapManager has a
// real source for the IBL prefilter pipeline (`generateIBLMaps`). This
// is now a 1:1 port of the WebGL `ComputeRadianceMapFS` + the
// `czm_computeScattering` / `czm_computeAtmosphereColor` model
// (`AtmosphereCommon.glsl`) -- the SAME atmosphere math the visible
// SkyAtmosphere renders. Previously (Batch 134) this used an inline
// approximation with stale coefficients (8e3/1.2e3 scale heights,
// 22.4e-6 blue Rayleigh, g=0.76, and a hardcoded planet-local view
// origin with the live sun direction). That diverged from WebGL's IBL
// source: WebGL evaluates the sky at the model's actual world position,
// derives the light direction via `czm_getDynamicAtmosphereLightDirection`
// (which, with the default dynamicLighting=NONE, uses the local zenith
// rather than the sun direction -> a smooth radially-symmetric sky), and
// honors `atmosphereScatteringIntensity` + gamma. The mismatch left the
// WebGPU IBL ~7.6% dimmer and ~9% short on the blue channel (a flatter,
// warmer ambient). This file closes that gap.
//
// Inputs (uniform -- mirrors ComputeRadianceMapFS uniforms):
//   - positionWC, enuX/Y/Z:  model world position + ENU->fixed basis so
//                            each face direction maps to world space the
//                            same way WebGL's u_enuToFixedFrame does.
//   - sunDirectionWC:        scene sun direction (used when
//                            dynamicLighting == SUNLIGHT / SCENE_LIGHT).
//   - rayleighCoefficient/mieCoefficient/scale heights/anisotropy:
//                            frameState.atmosphere terms (so the WebGPU
//                            sky tracks the same per-scene atmosphere as
//                            WebGL instead of stale shader constants).
//   - innerRadius/outerRadius: WebGL's u_radiiAndDynamicAtmosphereColor
//                            semantics (DynamicEnvironmentMapManager.js:
//                            atmosphereNeedsUpdate): inner = |scaleToGeodeticSurface(position)|
//                            (the surface radius), outer = 1.025 × inner.
//                            The 111 km scattering shell is internal to
//                            computeScattering (ATMOSPHERE_THICKNESS).
//   - intensity:             atmosphereScatteringIntensity.
//   - gamma:                 environment gamma.
//   - groundColor (rgb) + groundAlbedo (a): ground term for down-facing
//                            directions.
//   - dynamicLightingEnum:   NONE(0)/SCENE_LIGHT(1)/SUNLIGHT(2).
//   - faceSize:              output cubemap face size.
//
// Output (storage texture, 2d-array, 6 layers): rgba8unorm cubemap face.
//
// True scene capture (3D Tiles + globe in reflections) still requires
// re-running the scene pipeline through 6 virtual cameras -- tracked as
// `NEW-DYNAMIC-ENVMAP-FULL-SCENE`. This fill matches WebGL's procedural
// IBL source, which is all the IBL prefilter consumes.

struct SkyUniforms {
  // World position of the env-map (model bounding-sphere center). Packed
  // for completeness + future SUNLIGHT-mode position work; the sky is
  // currently evaluated in a planet-local frame so this is unread here.
  positionWC: vec3<f32>,
  faceSize: f32,
  enuX: vec3<f32>,
  innerRadius: f32,
  enuY: vec3<f32>,
  outerRadius: f32,
  enuZ: vec3<f32>,
  intensity: f32,
  sunDirectionWC: vec3<f32>,
  gamma: f32,
  rayleighCoefficient: vec3<f32>,
  mieAnisotropy: f32,
  mieCoefficient: vec3<f32>,
  rayleighScaleHeight: f32,
  groundColor: vec3<f32>,
  mieScaleHeight: f32,
  groundAlbedo: f32,
  dynamicLightingEnum: f32,
  // atmosphereScatteringIntensity -- the manager-level multiplier
  // applied to the final sky/ground color (distinct from `intensity`,
  // which is atmosphere.lightIntensity baked into the phase-weighted
  // scattering, matching ComputeRadianceMapFS).
  scatteringIntensity: f32,
  // Item 2.2 (ENV-AERIAL-MS, Batch 430). When > 0.5 the sky color for each
  // sky-facing texel is sourced from the sun-relative sky-view LUT (+ the
  // multiple-scattering LUT add) — the SAME tables the visible SkyAtmosphere
  // samples — instead of the inline czm_computeScattering march below, so the
  // reflected env sky matches the visible MS sky (richer, directional, warmer
  // toward the sun). Opt-in via `contextOptions.webgpu.envMapMultiScatter`;
  // the renderer packs this only when the LUTs are baked. With the flag 0
  // (default) the LUT views are bound to a 1x1 placeholder, never sampled, and
  // the fill is byte-identical to the inline march.
  useMultiScatterLut: f32,
  // Item 4.2 (CLOUD-IBL, Batch 441). EFFECTIVE cloud coverage in [0, 1] that
  // the env-cube sky radiance is darkened + flattened toward, so an overcast
  // procedural-cloud sky produces a dim, flat ambient (the SH-L2 projection +
  // IBL prefilter that read this cube then carry the overcast look into lit
  // glTF models / 3D tiles, and into the sky-LUT-derived fog ambient that
  // shares the same atmosphere source). Driven by `globe.cloudCoverage` ×
  // `globe.cloudDensity`-derived term, gated ON only when BOTH
  // `globe.showProceduralClouds` AND `globe.cloudContributesIBL` are true; the
  // renderer packs 0.0 otherwise. With 0.0 (default) the overcast blend below
  // is skipped entirely → byte-identical to the pre-4.2 fill. This is a COARSE
  // coverage-driven darkening (a single global scalar lerps the per-texel sky
  // toward a grey overcast luminance + flattens the sun-relative directionality);
  // a true per-face cloud raymarch into the cube is deferred (CLOUD-IBL-FULL).
  cloudCoverage: f32,
  // Item 3-C (CLOUD-IBL-FULL, Batch 450). The two coarse-path pads (37, 38)
  // are repurposed (add-only — byte offsets unchanged) into the full per-face
  // cloud-march controls. cloudMarch is the gate: 0 (default) → the march is
  // skipped ENTIRELY (the whole block below is guarded on it) AND the
  // bindings 5/6/7 are placeholder 1×1×1 textures → byte-identical to the 4.2
  // fill. >0 → run the low-res per-face cloud raymarch + composite OVER the sky.
  cloudMarch: f32,         // 37 — 0 off (default) / >0 run the full per-face march
  cloudPlanetRadius: f32,  // 38 — DEAD (Batch 450, FIX 4): the march uses the
                           //      passed `innerR`/`u.innerRadius`, never this slot.
                           //      Kept add-only so the 160-byte 4.2 row layout +
                           //      all later offsets stay stable; packed as
                           //      innerRadius for documentation only.
  // NEW-MODEL-IBL-AMBIENT (re-land of the audited-GO B3 fix) — the former
  // reserved pad (39) now carries max(|position| - innerRadius, 0), the
  // model's height above the geodetic surface. ADD-ONLY: byte offset 156
  // unchanged; previously always packed 0, and a ground-level model still
  // packs 0 → identical bytes for the historical common case. Mirrors
  // ComputeRadianceMapFS's `ellipsoidHeight` (view-origin scaling +
  // skyAlpha / ground-blend height terms).
  ellipsoidHeight: f32,    // 39 — max(|position| - innerRadius, 0) in meters
  // Item 3-C — cloud-march params. Appended ADD-ONLY (new 16-byte rows). NEVER
  // read when cloudMarch == 0 (the march block is fully guarded), so the bytes
  // are inert on the default path. The cloud sun direction is in the SAME local
  // (Y-up) reference frame as `dir` (the JS packer rotates the world sun into it
  // via the ENU basis, like `sunLocal`), so the beer's-law light term is
  // consistent with the face directions the cube is filled along.
  cloudSunLocal: vec3<f32>,   // 40-42 — sun direction in the IBL local frame
  cloudDeckBottom: f32,       // 43 — deck bottom (m above surface)
  _cloudWindWorldOffset: vec3<f32>,// 44-46 — deprecated; CPU phases include wind
  cloudDeckTop: f32,          // 47 — deck top (m above surface)
  cloudBaseColor: vec3<f32>,  // 48-50 — beer's-law lit base (shadowed) cloud tint
  cloudDensityMult: f32,      // 51 — density scale (globe.cloudDensity-derived)
  cloudTopColor: vec3<f32>,   // 52-54 — sun-lit cloud tint (silver edge)
  cloudPuffSize: f32,         // 55 — baked-shape SHAPE_SCALE (puff size dial)
  // C13-37 — f64-origin phases at the environment capture position. Local
  // samples are converted through the packed ENU basis, then added to these
  // bounded planet-domain phases just like the primary camera-relative march.
  densityShapeOriginPhase: vec3<f32>, // 56-58
  _padCloudDensity0: f32,              // 59
  densityWarpOriginPhase: vec3<f32>,  // 60-62
  _padCloudDensity1: f32,              // 63
  densityDetailOriginPhase: vec3<f32>,// 64-66
  _padCloudDensity2: f32,              // 67
};

@group(0) @binding(0) var<uniform> u: SkyUniforms;
@group(0) @binding(1) var outputTexture: texture_storage_2d_array<rgba8unorm, write>;
// Item 2.2 (ENV-AERIAL-MS, Batch 430). Sun-relative sky-view LUT (256x128) +
// multiple-scattering LUT (256x128) baked by AtmosphereLUT.wgsl
// (computeSkyView / computeMultipleScattering) and shared with the visible
// SkyAtmosphere. Bound UNCONDITIONALLY so the pipeline layout never changes;
// the renderer binds a 1x1 placeholder when `useMultiScatterLut` is off (so the
// off path's descriptor set is identical and these are never sampled).
@group(0) @binding(2) var lutSampler: sampler;
@group(0) @binding(3) var skyViewLut: texture_2d<f32>;
@group(0) @binding(4) var multipleScatterLut: texture_2d<f32>;
// Item 3-C (CLOUD-IBL-FULL, Batch 450) — the baked cloud noise the visible
// volumetric clouds sample (shape = Perlin-Worley billow, detail = high-freq
// Worley), SHARED from the cloud renderer's `_cloudCache.noise`. Bound
// UNCONDITIONALLY so the BGL/pipeline layout never forks; the JS renderer binds
// a 1×1×1 placeholder when `cloudMarch` is off (mirrors the LUT placeholder
// pattern at bindings 3/4), and the per-face march below is fully gated on
// `cloudMarch > 0`, so the textures are NEVER sampled on the default path.
@group(0) @binding(5) var cloudShapeTex: texture_3d<f32>;
@group(0) @binding(6) var cloudDetailTex: texture_3d<f32>;
@group(0) @binding(7) var cloudNoiseSampler: sampler;

const ATMOSPHERE_THICKNESS: f32 = 111000.0;
const PRIMARY_STEPS_MAX: i32 = 16;
const LIGHT_STEPS_MAX: i32 = 4;

struct ScatteringResult {
  rayleigh: vec3<f32>,
  mie: vec3<f32>,
  opacity: f32,
};

// Cubemap (face, uv) -> direction in the IBL reference frame. This MUST
// match `faceUvToDirection` in RadiancePrefilter.wgsl /
// IrradianceConvolution.wgsl (the WebGPU/D3D cube convention the IBL
// prefilter + the PBR shader's `textureSampleLevel(cube, dir)` use) so a
// texel filled here is sampled back with the same direction downstream.
// The PBR shader rotates the eye-space reflection into this frame via
// `iblReferenceFrameMatrix` (= yUpToZUp * transpose(rot(view *
// referenceMatrix))) before sampling, which keeps the reflection world-
// anchored as the camera orbits. The reference frame for the env-manager
// is the model's local (Y-up) frame; the ENU basis below maps it to the
// world direction we evaluate the atmosphere scattering along.
fn faceUVToLocalDir(face: u32, uv: vec2<f32>) -> vec3<f32> {
  let s = uv.x * 2.0 - 1.0;
  let t = uv.y * 2.0 - 1.0;
  switch face {
    case 0u: { return normalize(vec3<f32>( 1.0,  -t,  -s)); } // +X
    case 1u: { return normalize(vec3<f32>(-1.0,  -t,   s)); } // -X
    case 2u: { return normalize(vec3<f32>( s,   1.0,   t)); } // +Y
    case 3u: { return normalize(vec3<f32>( s,  -1.0,  -t)); } // -Y
    case 4u: { return normalize(vec3<f32>( s,   -t,  1.0)); } // +Z
    default: { return normalize(vec3<f32>(-s,   -t, -1.0)); } // -Z
  }
}

// Port of czm_approximateTanh (approximateTanh.glsl) — the rational
// approximation the WebGL scattering march uses for its soft split weights.
fn approximateTanh(x: f32) -> f32 {
  let x2 = x * x;
  return max(-1.0, min(1.0, x * (27.0 + x2) / (27.0 + 9.0 * x2)));
}

// Port of czm_raySphereIntersectionInterval (raySphereIntersectionInterval.glsl,
// including the NEW-RAYSPHERE-PRECISION-BACKPORT Batch-304 1/radius scaling so
// the f32 discriminant stays stable at planet scale). Sphere centered at the
// origin. Returns (t0, t1, hit): hit = 1.0 when the discriminant >= 0; both
// t-values may be negative (behind the origin), matching the GLSL semantics
// the callers' `start >= 0.0` tests rely on.
fn raySphereIntersectionInterval(o: vec3<f32>, d: vec3<f32>, radius: f32) -> vec3<f32> {
  let invR = 1.0 / max(radius, 1e-7);
  let ocScaled = o * invR;
  let a = dot(d, d);
  let b = 2.0 * dot(d, o) * (invR * invR);
  let aScaled = a * (invR * invR);
  let c = dot(ocScaled, ocScaled) - 1.0;
  let det = (b * b) - (4.0 * aScaled * c);
  if (det < 0.0) {
    return vec3<f32>(0.0, 0.0, 0.0);
  }
  let sqrtDet = sqrt(det);
  let t0 = (-b - sqrtDet) / (2.0 * aScaled);
  let t1 = (-b + sqrtDet) / (2.0 * aScaled);
  return vec3<f32>(t0, t1, 1.0);
}

// Faithful port of czm_computeScattering (computeScattering.glsl). Uses the
// frameState.atmosphere coefficients passed via uniforms so the WebGPU
// sky matches the visible SkyAtmosphere + WebGL IBL exactly.
//
// NEW-MODEL-IBL-AMBIENT (re-land of the audited-GO B3 fix): the previous
// port used a uniform 16-step midpoint integrator with a fixed 111 km ray
// clamp — diverging from WebGL's ADAPTIVE scheme (tanh split weights →
// 4 primary / 2 light steps from inside the atmosphere, growing step
// length, full-step sample placement, and the caller-provided ray length
// with only the shell exit as the internal clamp). The divergence skewed
// the radiance cube's blue band and, through the SH projection, tinted
// every model's IBL ambient olive. This body now transcribes the GLSL
// line-for-line.
fn computeScattering(
  rayOrigin: vec3<f32>,
  rayDir: vec3<f32>,
  rayLength: f32,
  lightDir: vec3<f32>,
  innerRadius: f32,
) -> ScatteringResult {
  var result: ScatteringResult;
  result.rayleigh = vec3<f32>(0.0);
  result.mie = vec3<f32>(0.0);
  result.opacity = 0.0;

  let outerRadius = innerRadius + ATMOSPHERE_THICKNESS;

  // Intersection of the primary ray with the outer atmosphere sphere.
  let primary = raySphereIntersectionInterval(rayOrigin, rayDir, outerRadius);
  if (primary.z < 0.5) {
    return result;
  }

  // Sky-vs-horizon soft split weight (czm_computeScattering:46-53).
  let x = 1e-7 * primary.y / rayLength;
  let wStopGtLprl = 0.5 * (1.0 + approximateTanh(x));

  // Ray starts at the shell entry or the origin if inside; ends at the shell
  // exit or the caller's ray length, whichever is smaller.
  let start0 = primary.x;
  let intersectStart = max(primary.x, 0.0);
  let intersectStop = min(primary.y, rayLength);

  // Inside-vs-outside atmosphere weight → adaptive step counts (4 primary /
  // 2 light steps from inside the atmosphere; 16 / 4 from space) + the
  // growing-step-length compensation (czm_computeScattering:61-75).
  let xOA = start0 - ATMOSPHERE_THICKNESS;
  let wInsideAtmosphere = 1.0 - 0.5 * (1.0 + approximateTanh(xOA));
  let PRIMARY_STEPS = PRIMARY_STEPS_MAX - i32(wInsideAtmosphere * 12.0);
  let LIGHT_STEPS = LIGHT_STEPS_MAX - i32(wInsideAtmosphere * 2.0);

  var rayPositionLength = intersectStart;
  let totalRayLength = intersectStop - rayPositionLength;
  let rayStepLengthIncrease = wInsideAtmosphere *
    ((1.0 - wStopGtLprl) * totalRayLength /
      (f32(PRIMARY_STEPS * (PRIMARY_STEPS + 1)) / 2.0));
  var rayStepLength = max(1.0 - wInsideAtmosphere, wStopGtLprl) *
    totalRayLength / max(7.0 * wInsideAtmosphere, f32(PRIMARY_STEPS));

  var rayleighAccum = vec3<f32>(0.0);
  var mieAccum = vec3<f32>(0.0);
  var opticalDepthR = 0.0;
  var opticalDepthM = 0.0;

  for (var i = 0; i < PRIMARY_STEPS_MAX; i = i + 1) {
    if (i >= PRIMARY_STEPS) { break; }

    // WebGL sample placement: a FULL step ahead of the current ray position
    // (czm_computeScattering:92), not a midpoint.
    let samplePosition = rayOrigin + rayDir * (rayPositionLength + rayStepLength);
    let sampleHeight = length(samplePosition) - innerRadius;

    let densityR = exp(-sampleHeight / u.rayleighScaleHeight) * rayStepLength;
    let densityM = exp(-sampleHeight / u.mieScaleHeight) * rayStepLength;
    opticalDepthR = opticalDepthR + densityR;
    opticalDepthM = opticalDepthM + densityM;

    let lightSeg = raySphereIntersectionInterval(samplePosition, lightDir, outerRadius);
    let lightStepLength = lightSeg.y / f32(LIGHT_STEPS);
    var lightOpticalDepthR = 0.0;
    var lightOpticalDepthM = 0.0;
    var lightPositionLength = 0.0;

    for (var j = 0; j < LIGHT_STEPS_MAX; j = j + 1) {
      if (j >= LIGHT_STEPS) { break; }
      // Light samples ARE midpoint-placed (czm_computeScattering:120).
      let lightPosition = samplePosition + lightDir * (lightPositionLength + lightStepLength * 0.5);
      let lightHeight = length(lightPosition) - innerRadius;
      lightOpticalDepthR = lightOpticalDepthR + exp(-lightHeight / u.rayleighScaleHeight) * lightStepLength;
      lightOpticalDepthM = lightOpticalDepthM + exp(-lightHeight / u.mieScaleHeight) * lightStepLength;
      lightPositionLength = lightPositionLength + lightStepLength;
    }

    let attenuation = exp(
      -(u.mieCoefficient * (opticalDepthM + lightOpticalDepthM)
        + u.rayleighCoefficient * (opticalDepthR + lightOpticalDepthR))
    );

    rayleighAccum = rayleighAccum + densityR * attenuation;
    mieAccum = mieAccum + densityM * attenuation;

    // GLSL: rayPositionLength += (rayStepLength += rayStepLengthIncrease) —
    // grow the step FIRST, then advance by the grown step.
    rayStepLength = rayStepLength + rayStepLengthIncrease;
    rayPositionLength = rayPositionLength + rayStepLength;
  }

  result.rayleigh = u.rayleighCoefficient * rayleighAccum;
  result.mie = u.mieCoefficient * mieAccum;
  result.opacity = length(exp(
    -(u.mieCoefficient * opticalDepthM + u.rayleighCoefficient * opticalDepthR)
  ));
  return result;
}

// Port of czm_computeAtmosphereColor (AtmosphereCommon.glsl). Applies
// the Rayleigh + Mie phase functions and the scattering intensity. The
// view-to-light cosAngle uses the face direction vs the light direction
// (matching WebGL's cameraToPositionWCDirection vs lightDirection).
fn computeAtmosphereColor(
  viewDir: vec3<f32>,
  lightDir: vec3<f32>,
  s: ScatteringResult,
) -> vec4<f32> {
  let cosAngle = dot(viewDir, lightDir);
  let cosAngleSq = cosAngle * cosAngle;

  let G = u.mieAnisotropy;
  let GSq = G * G;

  let rayleighPhase = 3.0 / (50.2654824574) * (1.0 + cosAngleSq);
  let miePhase = 3.0 / (25.1327412287)
               * ((1.0 - GSq) * (cosAngleSq + 1.0))
               / (pow(1.0 + GSq - 2.0 * cosAngle * G, 1.5) * (2.0 + GSq));

  let color = (rayleighPhase * s.rayleigh + miePhase * s.mie) * u.intensity;
  return vec4<f32>(color, s.opacity);
}

// Item 2.2 (ENV-AERIAL-MS, Batch 430) — sample the sun-relative sky-view LUT.
// COPIED VERBATIM (same UV/basis derivation) from SkyAtmosphere.wgsl's
// `sampleSkyViewLut` so the reflected env sky agrees with the visible sky:
//   U = relativeAzimuth(rayDir, sunDir) / PI   (sky symmetric about the sun
//       meridian → [0, π] covers all azimuths)
//   V = 0.5 + 0.5 * sign(cosViewZenith) * sqrt(|cosViewZenith|)  (Hillaire warp)
// `up` is the local vertical at the (synthetic, ground-level) observer; in the
// env-cube frame that is the local +Y zenith. Returns the baked combined
// Rayleigh+Mie inscatter (intensity already applied at bake time).
fn sampleSkyViewLut(up: vec3<f32>, rayDir: vec3<f32>, sunDir: vec3<f32>) -> vec3<f32> {
  let cosViewZenith = clamp(dot(rayDir, up), -1.0, 1.0);
  let vCoord = clamp(
    0.5 + 0.5 * sign(cosViewZenith) * sqrt(abs(cosViewZenith)),
    0.0,
    1.0,
  );
  let viewHoriz = rayDir - up * cosViewZenith;
  let sunHoriz = sunDir - up * dot(sunDir, up);
  let vhLen = length(viewHoriz);
  let shLen = length(sunHoriz);
  var cosRelAzimuth: f32 = 1.0;
  if (vhLen > 1e-4 && shLen > 1e-4) {
    cosRelAzimuth = clamp(dot(viewHoriz, sunHoriz) / (vhLen * shLen), -1.0, 1.0);
  }
  let relAzimuth = acos(cosRelAzimuth); // [0, π]
  let uCoord = clamp(relAzimuth * (1.0 / PI), 0.0, 1.0);
  let s = textureSampleLevel(skyViewLut, lutSampler, vec2<f32>(uCoord, vCoord), 0.0);
  return max(s.rgb, vec3<f32>(0.0));
}

// Item 2.2 — sample the multiple-scattering LUT (same sun-relative sky-view
// domain as the sky-view LUT). Identical (U, V) derivation to sampleSkyViewLut
// so the MS add agrees directionally with the single-scatter sky-view sample.
fn sampleMultipleScatterLut(up: vec3<f32>, rayDir: vec3<f32>, sunDir: vec3<f32>) -> vec3<f32> {
  let cosViewZenith = clamp(dot(rayDir, up), -1.0, 1.0);
  let vCoord = clamp(
    0.5 + 0.5 * sign(cosViewZenith) * sqrt(abs(cosViewZenith)),
    0.0,
    1.0,
  );
  let viewHoriz = rayDir - up * cosViewZenith;
  let sunHoriz = sunDir - up * dot(sunDir, up);
  let vhLen = length(viewHoriz);
  let shLen = length(sunHoriz);
  var cosRelAzimuth: f32 = 1.0;
  if (vhLen > 1e-4 && shLen > 1e-4) {
    cosRelAzimuth = clamp(dot(viewHoriz, sunHoriz) / (vhLen * shLen), -1.0, 1.0);
  }
  let relAzimuth = acos(cosRelAzimuth); // [0, π]
  let uCoord = clamp(relAzimuth * (1.0 / PI), 0.0, 1.0);
  let s = textureSampleLevel(multipleScatterLut, lutSampler, vec2<f32>(uCoord, vCoord), 0.0);
  return max(s.rgb, vec3<f32>(0.0));
}

// Mirror of SkyAtmosphere.wgsl's MS_SCALE — the perceptual on-screen strength
// of the MS add. Same constant so the env reflection matches the visible sky.
const MS_SCALE: f32 = 0.06;
const PI: f32 = 3.14159265358979323846;

// ─── Item 3-C (CLOUD-IBL-FULL, Batch 450) — low-res per-face cloud march ───
//
// A DELIBERATELY COARSE port of ProceduralClouds.wgsl's `cloudDensity` +
// `marchDeck`: it samples the SAME baked shape/detail noise the visible clouds
// use (so the reflected cloud field tracks the rendered one), but with a small
// fixed step count, a SINGLE simplified deck, and a cheap 1-tap beer's-law sun
// shadow. The prefilter + SH that read this cube blur out high-frequency detail,
// so a low-res march is sufficient — and is the whole point of "low-res per
// face". The entire path is reached ONLY when `u.cloudMarch > 0` AND
// `u.cloudCoverage > 0`; otherwise it is never called (bindings 5/6/7 are
// placeholders) → byte-identical default parity.

// C13-37 Slice B — the IBL march uses the same ray-interval-to-voxel rule as
// the visible density field. One-level placeholders naturally clamp to LOD 0.
fn cloudNoiseMipLevelIBL(
  footprintMeters: f32,
  domainUnitsPerMeter: f32,
  baseResolution: u32,
  levelCount: u32,
) -> f32 {
  let coveredLevel0Voxels =
    max(footprintMeters, 0.0) *
    abs(domainUnitsPerMeter) *
    f32(baseResolution);
  let maxMip = f32(max(i32(levelCount) - 1, 0));
  return clamp(
    log2(max(coveredLevel0Voxels, 1.0)) - 1.0,
    0.0,
    maxMip,
  );
}

struct CloudNoiseMipLevelsIBL {
  shape: f32,
  warp: f32,
  detail: f32,
}

fn cloudDensityMipLevelsIBL(
  footprintMeters: f32,
) -> CloudNoiseMipLevelsIBL {
  let shapeResolution = textureDimensions(cloudShapeTex).x;
  let shapeLevelCount = textureNumLevels(cloudShapeTex);
  let detailResolution = textureDimensions(cloudDetailTex).x;
  let detailLevelCount = textureNumLevels(cloudDetailTex);
  return CloudNoiseMipLevelsIBL(
    cloudNoiseMipLevelIBL(
      footprintMeters,
      CLOUD_DENSITY_WORLD_TO_NOISE * u.cloudPuffSize,
      shapeResolution,
      shapeLevelCount,
    ),
    cloudNoiseMipLevelIBL(
      footprintMeters,
      CLOUD_DENSITY_WORLD_TO_NOISE *
        u.cloudPuffSize *
        CLOUD_DENSITY_WARP_RATIO,
      detailResolution,
      detailLevelCount,
    ),
    cloudNoiseMipLevelIBL(
      footprintMeters,
      CLOUD_DENSITY_WORLD_TO_NOISE * CLOUD_DENSITY_DETAIL_RATIO,
      detailResolution,
      detailLevelCount,
    ),
  );
}

// Baked cloud BASE shape — a stripped `bakedBase` from ProceduralClouds.wgsl:
// one trilinear shape fetch warped by a slow detail offset (de-tiles the bake).
fn cloudBakedBaseIBL(
  coordinates: CloudDensityCoordinates,
  mipLevels: CloudNoiseMipLevelsIBL,
) -> f32 {
  let w = textureSampleLevel(
    cloudDetailTex,
    cloudNoiseSampler,
    coordinates.warp,
    mipLevels.warp,
  ).rgb;
  let uvw = coordinates.shape + (w - vec3<f32>(0.5)) * 0.5;
  return textureSampleLevel(
    cloudShapeTex,
    cloudNoiseSampler,
    uvw,
    mipLevels.shape,
  ).r;
}

// Convert an IBL-local displacement (x=East, y=Up, z=North) into the global
// ECEF displacement used by the visible cloud renderer.
fn cloudIblLocalDeltaToWorld(delta: vec3<f32>) -> vec3<f32> {
  return u.enuX * delta.x + u.enuZ * delta.y + u.enuY * delta.z;
}

fn cloudDensityCoordinatesIBL(
  localWorldPos: vec3<f32>,
) -> CloudDensityCoordinates {
  let captureOriginLocal =
    vec3<f32>(0.0, u.innerRadius + u.ellipsoidHeight, 0.0);
  let relativeWorld =
    cloudIblLocalDeltaToWorld(localWorldPos - captureOriginLocal);
  return cloudDensityCoordinatesFromOriginPhases(
    relativeWorld * CLOUD_DENSITY_WORLD_TO_NOISE,
    u.cloudPuffSize,
    u.densityShapeOriginPhase,
    u.densityWarpOriginPhase,
    u.densityDetailOriginPhase,
  );
}

// Cloud density at a world-frame point on the deck. Mirrors the BAKED branch of
// `cloudDensity`: baked base → coverage threshold → BILLOWY height gradient →
// subtractive Worley detail erosion. No weather map, no per-genus profile (this
// is a coarse IBL field, not the cinematic march).
fn cloudDensityIBL(
  worldPos: vec3<f32>,
  heightFraction: f32,
  footprintMeters: f32,
) -> f32 {
  let coordinates = cloudDensityCoordinatesIBL(worldPos);
  let mipLevels = cloudDensityMipLevelsIBL(footprintMeters);

  var density = cloudBakedBaseIBL(coordinates, mipLevels);
  let coverage = clamp(u.cloudCoverage, 0.0, 1.0);
  density = smoothstep(1.0 - coverage, 1.0, density);

  // BILLOWY vertical gradient (the historical cumulus profile).
  let hg = smoothstep(0.0, 0.15, heightFraction) * smoothstep(1.0, 0.7, heightFraction);
  density *= hg;

  // Preserve the established IBL-specific subtractive erosion. The environment
  // march is deliberately coarser than the visible path; changing its response
  // belongs in a separately captured appearance slice.
  let detail = textureSampleLevel(
    cloudDetailTex,
    cloudNoiseSampler,
    coordinates.detail,
    mipLevels.detail,
  );
  let worleyDetail = 1.0 - detail.r;
  density -= worleyDetail * 0.35 * (1.0 - heightFraction);
  density = max(density, 0.0);

  return density * u.cloudDensityMult;
}

// Ray / sphere far-hit in the local frame (origin not at the planet center).
// Closest-point form (Haines), same as ProceduralClouds.wgsl's intersect.
fn cloudShellIntersect(ro: vec3<f32>, rd: vec3<f32>, radius: f32) -> vec2<f32> {
  let tClosest = -dot(ro, rd);
  let cp = ro + rd * tClosest;
  let half2 = radius * radius - dot(cp, cp);
  if (half2 < 0.0) {
    return vec2<f32>(-1.0);
  }
  let h = sqrt(half2);
  return vec2<f32>(tClosest - h, tClosest + h);
}

// Cheap 3-tap beer's-law sun shadow toward `u.cloudSunLocal`. Returns
// transmittance in [0,1] — 1 = fully lit, →0 = deeply shadowed.
fn cloudLightIBL(pos: vec3<f32>, innerR: f32, deckBottom: f32, deckTop: f32) -> f32 {
  let layerThickness = deckTop - deckBottom;
  let stepLen = layerThickness * 0.33;
  var opticalDepth: f32 = 0.0;
  for (var i = 0; i < 3; i = i + 1) {
    let sp = pos + u.cloudSunLocal * (stepLen * f32(i + 1));
    let altitude = length(sp) - innerR;
    let hf = clamp((altitude - deckBottom) / max(layerThickness, 1.0), 0.0, 1.0);
    opticalDepth += cloudDensityIBL(sp, hf, stepLen) * stepLen;
  }
  return exp(-opticalDepth * 0.04);
}

// Low-res cloud raymarch along the face direction `dir` from the local view
// origin. Returns premultiplied cloud color in .rgb and coverage alpha in .a.
// `innerR` is the reference-frame surface radius (== u.innerRadius); the deck
// shell sits at [innerR+deckBottom, innerR+deckTop].
fn marchCloudFaceIBL(
  viewOrigin: vec3<f32>,
  dir: vec3<f32>,
  innerR: f32,
  skyColor: vec3<f32>,
) -> vec4<f32> {
  let deckBottom = u.cloudDeckBottom;
  let deckTop = u.cloudDeckTop;
  let innerShell = innerR + deckBottom;
  let outerShell = innerR + deckTop;

  let hitInner = cloudShellIntersect(viewOrigin, dir, innerShell);
  let hitOuter = cloudShellIntersect(viewOrigin, dir, outerShell);
  // Item 3-C (CLOUD-IBL-FULL, Batch 450, FIX 2) — the view origin sits at the
  // planet surface (radius innerR), BELOW both cloud shells, so this is the
  // below-deck case (mirrors ProceduralClouds.wgsl marchDeck's `cameraAltitude
  // < deckBottom` branch): march the deck itself — enter at the inner-shell FAR
  // hit (deck bottom) and exit at the outer-shell FAR hit (deck top). The prior
  // code started at the outer NEAR hit (`hitOuter.x`, behind the surface) and
  // tried to clip at the inner NEAR hit (`hitInner.x`, always < 0 from below →
  // dead clip), so it wasted ~5 of 12 steps in the empty sub-deck region. A ray
  // that misses the deck (`hitInner.y < 0`) yields tStart=0,tEnd<0 → early-out.
  var tStart = max(hitInner.y, 0.0);
  var tEnd = hitOuter.y;
  if (tEnd <= tStart) {
    return vec4<f32>(0.0);
  }

  // Cap the marched span so a grazing ray doesn't run a huge segment at low res.
  let maxSpan = (deckTop - deckBottom) * 6.0;
  tEnd = min(tEnd, tStart + maxSpan);

  let STEPS = 12;
  let stepLen = (tEnd - tStart) / f32(STEPS);
  let layerThickness = max(deckTop - deckBottom, 1.0);

  var transmittance: f32 = 1.0;
  var accumColor = vec3<f32>(0.0);
  var t = tStart + stepLen * 0.5;
  for (var i = 0; i < STEPS; i = i + 1) {
    let p = viewOrigin + dir * t;
    let altitude = length(p) - innerR;
    let hf = clamp((altitude - deckBottom) / layerThickness, 0.0, 1.0);
    let density = cloudDensityIBL(p, hf, stepLen);
    if (density > 0.001) {
      let light = cloudLightIBL(p, innerR, deckBottom, deckTop);
      // Sun-lit tint toward `cloudTopColor`, shadowed toward `cloudBaseColor`,
      // and pick up the local sky as fill so the reflected deck doesn't read as
      // a flat grey card. Scaled by the env scattering intensity for exposure.
      let lit = mix(u.cloudBaseColor, u.cloudTopColor, light);
      let sample = (lit * u.scatteringIntensity + skyColor * 0.3);
      let stepDensity = density * stepLen * 0.02;
      let stepTrans = exp(-stepDensity);
      // Energy-conserving front-to-back composite (premultiplied).
      accumColor += transmittance * (1.0 - stepTrans) * sample;
      transmittance *= stepTrans;
      if (transmittance < 0.02) {
        break;
      }
    }
    t += stepLen;
  }

  let alpha = clamp(1.0 - transmittance, 0.0, 1.0);
  return vec4<f32>(accumColor, alpha);
}

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let size = u32(u.faceSize);
  if (gid.x >= size || gid.y >= size || gid.z >= 6u) {
    return;
  }
  let face = gid.z;
  let uv = (vec2<f32>(f32(gid.x), f32(gid.y)) + vec2<f32>(0.5)) / f32(size);

  // The cubemap is filled + sampled in the IBL REFERENCE FRAME (a planet-
  // local frame with +Y up). The PBR shader samples the prefiltered cube
  // at `Ribl = iblReferenceFrameMatrix * R` using the SAME
  // `faceUvToDirection` convention as the IBL prefilter; storing radiance
  // in this local frame (rather than transforming to world) is what keeps
  // the reflection world-anchored under the reference-frame rotation
  // (verified by the orbit-invariance check in probe-model-ibl). This
  // matches the proven Batch-134 orientation; D1 only swaps the inline
  // approximation for accurate `czm_computeScattering` math + the real
  // atmosphere coefficients/intensity/light-direction.
  let dir = faceUVToLocalDir(face, uv);

  // Planet-local view origin, +Y up (the reference frame's up axis), at the
  // model's height above the geodetic surface (ComputeRadianceMapFS:24-29:
  // the position is scaled to `ellipsoidHeight + atmosphereInnerRadius`, so
  // the sky is present even underground — ellipsoidHeight is pre-clamped to
  // >= 0 on the JS side). Scattering geometry uses innerRadius for the shell.
  let viewOrigin = vec3<f32>(0.0, u.innerRadius + u.ellipsoidHeight, 0.0);
  let atmosphereHeight = u.outerRadius - u.innerRadius;

  // onEllipsoid classification (ComputeRadianceMapFS:37-47): a primary ray
  // that hits the inner (surface) sphere AHEAD of the origin is a ground
  // texel and terminates at the hit; a sky ray's primary length is the outer
  // radius VALUE itself (1.025 × surface radius — WebGL passes
  // `atmosphereOuterRadius` as the ray length, NOT a 111 km clamp; the
  // scattering march clamps to its own 111 km shell exit internally). This
  // also fixes the two prior defects: down rays no longer march through the
  // planet, and the NONE-mode light direction below is no longer the
  // near-degenerate zenith of a 111 km-capped sky point.
  let groundHit = raySphereIntersectionInterval(viewOrigin, dir, u.innerRadius);
  let onEllipsoid = groundHit.z > 0.5 && groundHit.x >= 0.0;
  let rayLength = select(u.outerRadius, groundHit.x, onEllipsoid);
  let skyLocalPos = viewOrigin + dir * rayLength;

  // Light direction in the local frame:
  //   NONE (default)  -> normalize(skyPositionWC) — the sky-sample point at
  //                      the full 1.025R primary ray length, matching
  //                      czm_getDynamicAtmosphereLightDirection's NONE path
  //                      (czm_computeScattering sees a per-texel light that
  //                      leans toward the view direction, NOT the near-
  //                      degenerate zenith the old 111 km cap produced).
  //   SCENE_LIGHT/SUN -> the world sun direction rotated INTO the local
  //                      frame via the ENU basis (East->localX, Up->localY,
  //                      North->localZ), so the sun disc lands in the
  //                      correct local direction.
  let enumVal = u.dynamicLightingEnum;
  let sunLocal = normalize(vec3<f32>(
    dot(u.sunDirectionWC, u.enuX),
    dot(u.sunDirectionWC, u.enuZ),
    dot(u.sunDirectionWC, u.enuY),
  ));
  var lightDir: vec3<f32>;
  if (enumVal < 0.5) {
    lightDir = normalize(skyLocalPos);
  } else {
    lightDir = sunLocal;
  }

  let scattering = computeScattering(
    viewOrigin, dir, rayLength, lightDir, u.innerRadius
  );
  let atmosphereColor = computeAtmosphereColor(dir, lightDir, scattering);

  // Local zenith is +Y; upper hemisphere is dir.y >= 0.
  let up = vec3<f32>(0.0, 1.0, 0.0);
  let upDot = dir.y;

  // Item 2.2 (ENV-AERIAL-MS, Batch 430) — the per-texel sky radiance. OFF
  // (default): the inline czm_computeScattering/computeAtmosphereColor result
  // (`atmosphereColor.rgb`) verbatim → byte-identical. ON: the sun-relative
  // sky-view LUT (+ the MS add) — the SAME tables the visible SkyAtmosphere
  // samples — so reflected sky matches the visible MS sky. The LUT carries the
  // atmosphere intensity already (matching the inscatter-LUT convention), so it
  // drops in where `atmosphereColor.rgb` was. The sky-view LUT is sun-relative
  // and azimuth-aware, so the env-cube's local-frame `sunLocal` + the texel's
  // `dir` reproduce the directional (warm-toward-sun) sky the visible shell
  // shows. Gated to non-NONE dynamic lighting (the LUT bakes a single light
  // direction, like the visible sky's sky-view fast-path); the smooth NONE
  // ambient keeps the inline radially-symmetric march.
  var skyColor = atmosphereColor.rgb;
  if (u.useMultiScatterLut > 0.5 && enumVal >= 0.5) {
    let lutSky = sampleSkyViewLut(up, dir, sunLocal);
    let lutMs = sampleMultipleScatterLut(up, dir, sunLocal);
    skyColor = lutSky + lutMs * MS_SCALE;
  }

  // Item 4.2 (CLOUD-IBL, Batch 441) — coarse overcast darkening + flattening.
  // OFF (u.cloudCoverage == 0, default): this whole block is a no-op
  // (`coverage` is 0 → both lerps are identity) → byte-identical sky radiance.
  // ON: an overcast sky scatters the sun into a diffuse grey dome — it is
  // DIMMER and far less directional than clear sky. We model that as a SINGLE
  // coverage-driven lerp of the per-texel sky radiance toward a flat, DIMMED
  // overcast grey BEFORE the sky/ground composite, so the SH projection that
  // integrates this cube reconstructs a dimmer, flatter ambient (the L1/L2
  // directional bands collapse → flat; the L0 DC band drops → dim).
  //
  // The overcast target is a flat grey (this texel's own luminance, which after
  // the collapse is the same grey across the whole dome) scaled by a coverage
  // transmittance well below 1. The transmittance must be aggressive: a flat
  // grey dome of luminance L deposits MORE irradiance on a vertical facet than
  // the clear directional sky (whose high radiance is confined to the upper
  // hemisphere), so a mild scale would let the shadow-fill on the model's side
  // facets out-weigh the darkening and read BRIGHTER. A dense storm deck
  // physically transmits only ~10-15% of clear-sky illuminance, so we drive the
  // full-coverage transmittance to ~0.12 — the integrated ambient then lands
  // unambiguously DIMMER than clear AND flat (the L1/L2 directional bands
  // collapse). coverage≈0.5 reads as a hazy bright-overcast (partial collapse
  // toward a lightly-dimmed grey); coverage→1 as a dim, shadowless storm deck.
  //
  // Item 3-C (CLOUD-IBL-FULL, Batch 450) — when the full per-face march is ON
  // (`u.cloudMarch > 0`) it REPLACES this coarse darkening (the march composites
  // real cloud structure over the sky below, which is a strictly richer overcast
  // model), so the 4.2 lerp is skipped to avoid double-darkening. The coarse
  // path therefore runs ONLY when the march is off (the 4.2 fallback for
  // `cloudContributesIBL` without `cloudsInReflections`).
  let coverage = clamp(u.cloudCoverage, 0.0, 1.0);
  if (coverage > 0.0 && u.cloudMarch <= 0.0) {
    let lum = dot(skyColor, vec3<f32>(0.2126, 0.7152, 0.0722));
    // Transmittance: clear (1.0) → ~0.12 at full coverage. Applied to the grey
    // TARGET so the flattened dome is much dimmer than the texel it replaces
    // (the lerp moves toward this dimmed grey, never above it).
    let transmit = mix(1.0, 0.12, coverage);
    let dimGrey = vec3<f32>(lum) * transmit;
    // How strongly the texel collapses to the dim grey. At full coverage the
    // sky is almost entirely the flat dim dome (0.95), so directionality + the
    // bright sun-relative chroma are nearly gone.
    let blend = coverage * 0.95;
    skyColor = mix(skyColor, dimGrey, blend);
  }

  // Item 3-C (CLOUD-IBL-FULL, Batch 450) — full low-res per-face cloud march.
  // OFF (`u.cloudMarch == 0`, default): never entered → byte-identical (the
  // bindings 5/6/7 are placeholders and nothing samples them). ON (+ a non-zero
  // coverage): march the cloud deck along this face's `dir` from the local view
  // origin and composite the premultiplied result OVER the (clear or LUT) sky.
  // Clouds occlude the sky behind them (`sky*(1-a) + cloudPremult`), and the
  // sky/ground composite below then carries the cloudier radiance into the SH +
  // prefilter, so a reflective surface shows genuine cloud structure rather than
  // the 4.2 flat darkening. Only the upper hemisphere is marched (the deck sits
  // above the surface; down-facing texels use the ground term unchanged).
  if (u.cloudMarch > 0.0 && coverage > 0.0 && upDot > 0.0) {
    let cloud = marchCloudFaceIBL(viewOrigin, dir, u.innerRadius, skyColor);
    skyColor = skyColor * (1.0 - cloud.a) + cloud.rgb;
  }

  // 1:1 with ComputeRadianceMapFS: the sky is `skyColor * intensity` faded by
  // skyAlpha over the background, and the ground reuses that intensity for
  // the reflected-light occlusion term. `intensity` here is the manager's
  // atmosphereScatteringIntensity (matches the FS's
  // u_brightnessSaturationGammaIntensity.w). `skyColor` already carries
  // atmosphere.lightIntensity (u.intensity) — from computeAtmosphereColor on
  // the off path, from the LUT bake on the on path.
  let scatteringIntensity = u.scatteringIntensity;

  // skyAlpha composite (ComputeRadianceMapFS:77-85): above the atmosphere the
  // scattering fades to transparent over the background — black here (the
  // WebGPU env fill has no starmap/skybox composite; the scene default
  // background is black, so the default-path radiance matches). Black
  // scattering is treated as fully transparent (czm_epsilon7 test).
  var skyAlpha = clamp(
    (1.0 - u.ellipsoidHeight / atmosphereHeight) * atmosphereColor.a,
    0.0,
    1.0,
  );
  if (length(atmosphereColor.rgb) <= 1e-7) {
    skyAlpha = 0.0;
  }
  let combinedSkyColor = mix(
    vec3<f32>(0.0),
    skyColor * scatteringIntensity,
    skyAlpha,
  );

  // Ground (ComputeRadianceMapFS:87-93): reflected-light term, blended toward
  // the raw (intensity-free) atmosphere color as the origin climbs through
  // the atmosphere shell.
  let occlusion = max(dot(lightDir, up), 0.05);
  let groundReflected = u.groundColor * u.groundAlbedo
        * (vec3<f32>(scatteringIntensity * occlusion) + skyColor);
  let blendedGroundColor = mix(
    groundReflected,
    skyColor,
    clamp(u.ellipsoidHeight / atmosphereHeight, 0.0, 1.0),
  );

  // Sky vs ground by the ellipsoid hit test (WebGL's onEllipsoid ternary),
  // not the local hemisphere sign — from altitude the horizon sits below
  // dir.y == 0 and the classification must follow the actual surface hit.
  var color = select(combinedSkyColor, blendedGroundColor, onEllipsoid);

  // Gamma (kept even at 1.0 to match the WebGL transmittance-precision
  // workaround) -- ComputeRadianceMapFS applies pow(color, gamma) then a
  // sRGB-equivalent gamma correct. The IBL prefilter expects roughly
  // linear-ish radiance; we apply the env gamma only (the downstream PBR
  // shader handles output color management) to match the WebGL IBL
  // source values.
  color = pow(max(color, vec3<f32>(0.0)), vec3<f32>(u.gamma));

  textureStore(outputTexture, vec2<i32>(i32(gid.x), i32(gid.y)), i32(face),
               vec4<f32>(color, 1.0));
}
