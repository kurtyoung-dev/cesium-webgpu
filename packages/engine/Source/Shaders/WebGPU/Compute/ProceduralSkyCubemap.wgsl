// Procedural atmosphere-scattering cubemap fill.
//
// Writes the 6 faces of a cubemap so DynamicEnvironmentMapManager has a
// source for the IBL prefilter pipeline (`generateIBLMaps`). The scattering
// path ports WebGL's `ComputeRadianceMapFS`, `czm_computeScattering`, and
// `czm_computeAtmosphereColor` model from `AtmosphereCommon.glsl`. It evaluates
// the sky at the model position, resolves the dynamic atmosphere light, and
// honors the scene atmosphere coefficients, intensity, and environment gamma.
//
// Inputs (uniform -- mirrors ComputeRadianceMapFS uniforms):
//   - positionWC, enuX/Y/Z:  model world position and ENU-to-fixed basis so
//                            each face direction maps to world space like
//                            WebGL's u_enuToFixedFrame.
//   - sunDirectionWC:        scene sun direction (used when
//                            dynamicLighting == SUNLIGHT / SCENE_LIGHT).
//   - rayleighCoefficient/mieCoefficient/scale heights/anisotropy:
//                            frameState.atmosphere terms shared with WebGL.
//   - innerRadius/outerRadius: WebGL's u_radiiAndDynamicAtmosphereColor
//                            semantics (DynamicEnvironmentMapManager.js:
//                            atmosphereNeedsUpdate): inner is the surface
//                            radius and outer is 1.025 times inner. The 111 km
//                            scattering shell is internal to
//                            `computeScattering`.
//   - intensity:             atmosphereScatteringIntensity.
//   - gamma:                 environment gamma.
//   - groundColor (rgb) + groundAlbedo (a): ground term for down-facing
//                            directions.
//   - dynamicLightingEnum:   NONE(0)/SCENE_LIGHT(1)/SUNLIGHT(2)/
//                            LEGACY_OVERHEAD(3).
//   - faceSize:              output cubemap face size.
//
// Output (storage texture, 2d-array, 6 layers): rgba8unorm cubemap face.
//
// Full-scene capture can include 3D Tiles and the globe in reflections. Its
// virtual cameras still share the primary camera's tile LOD; this procedural
// fill remains the WebGL-compatible fallback source for the IBL prefilter.

struct SkyUniforms {
  // World position of the environment map's model bounding-sphere center.
  // This slot mirrors the shared layout; the planet-local sky path does not
  // read it directly.
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
  // Manager-level multiplier applied to the final sky and ground color. This
  // differs from `intensity`, which bakes `atmosphere.lightIntensity` into the
  // phase-weighted scattering like `ComputeRadianceMapFS`.
  scatteringIntensity: f32,
  // Selects the sun-relative sky-view and multiple-scattering LUTs used by the
  // visible sky. This makes reflected sky radiance share the visible sky's
  // directional response. When disabled, placeholder LUTs remain unsampled
  // and the inline scattering march supplies the texel.
  useMultiScatterLut: f32,
  // Effective cloud coverage in [0, 1]. The coarse fallback darkens and
  // flattens environment radiance so SH projection and IBL prefiltering carry
  // an overcast ambient into lit geometry. The renderer supplies zero unless
  // procedural clouds contribute to IBL; the coarse blend is skipped when the
  // full per-face march is active.
  cloudCoverage: f32,
  // Controls the low-resolution per-face cloud march. The slot reuses a
  // coarse-path pad without changing byte offsets. Zero skips the guarded
  // march while bindings 5, 6, and 7 hold placeholders; positive values march
  // and composite clouds over the sky.
  cloudMarch: f32,         // 37: zero disables the per-face march
  // Deprecated layout slot. The march uses `innerR` or `u.innerRadius`, but
  // retaining this field preserves the 160-byte row and every later offset.
  cloudPlanetRadius: f32,
  // Model height above the geodetic surface. Reusing the reserved slot keeps
  // byte offset 156 stable and mirrors `ComputeRadianceMapFS` view-origin,
  // sky-alpha, and ground-blend height terms.
  ellipsoidHeight: f32,    // 39 — max(|position| - innerRadius, 0) in meters
  // Appended cloud-march parameters occupy new 16-byte rows and remain inert
  // when `cloudMarch` is zero. The JS packer rotates the cloud sun direction
  // into the same local Y-up frame as `dir`, keeping the Beer-Lambert light
  // term consistent with cubemap face directions.
  cloudSunLocal: vec3<f32>,   // 40-42 — sun direction in the IBL local frame
  cloudDeckBottom: f32,       // 43 — deck bottom (m above surface)
  _cloudWindWorldOffset: vec3<f32>, // 44-46: CPU phases include wind
  cloudDeckTop: f32,          // 47 — deck top (m above surface)
  cloudBaseColor: vec3<f32>,  // 48-50: shadowed cloud tint
  cloudDensityMult: f32,      // 51 — density scale (globe.cloudDensity-derived)
  cloudTopColor: vec3<f32>,   // 52-54 — sun-lit cloud tint (silver edge)
  cloudPuffSize: f32,         // 55 — baked-shape SHAPE_SCALE (puff size dial)
  // F64-derived origin phases at the environment capture position. Local
  // samples pass through the packed ENU basis before being added to these
  // bounded planet-domain phases, matching the camera-relative march.
  densityShapeOriginPhase: vec3<f32>, // 56-58
  _padCloudDensity0: f32,              // 59
  densityWarpOriginPhase: vec3<f32>,  // 60-62
  _padCloudDensity1: f32,              // 63
  densityDetailOriginPhase: vec3<f32>,// 64-66
  _padCloudDensity2: f32,              // 67
};

@group(0) @binding(0) var<uniform> u: SkyUniforms;
@group(0) @binding(1) var outputTexture: texture_storage_2d_array<rgba8unorm, write>;
// The 256-by-128 sun-relative sky-view and multiple-scattering LUTs are shared
// with the visible sky. Always declaring the bindings keeps the pipeline layout
// stable; the renderer supplies placeholders when `useMultiScatterLut` is off.
@group(0) @binding(2) var lutSampler: sampler;
@group(0) @binding(3) var skyViewLut: texture_2d<f32>;
@group(0) @binding(4) var multipleScatterLut: texture_2d<f32>;
// Baked shape and detail noise are shared with the visible volumetric clouds.
// Always declaring these bindings prevents layout forks; placeholders are
// supplied and remain unsampled while `cloudMarch` is off.
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

// Port of `czm_raySphereIntersectionInterval`. Scaling by inverse radius keeps
// the f32 discriminant stable at planet scale. The sphere is centered at the
// origin. The result is `(t0, t1, hit)`, and both distances may be negative as
// required by the callers' `start >= 0.0` tests.
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

// Port of `czm_computeScattering` using scene atmosphere coefficients. Matching
// WebGL requires tanh split weights, adaptive primary and light step counts,
// growing step lengths, full-step primary sample placement, and the caller's
// ray length with only the shell exit as an internal clamp.
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

// Sample the sun-relative sky-view LUT with the same UV and basis derivation as
// `SkyAtmosphere.wgsl`, keeping reflected and visible sky radiance aligned:
//   U = relativeAzimuth(rayDir, sunDir) / PI
//   V = 0.5 + 0.5 * sign(cosViewZenith) * sqrt(abs(cosViewZenith))
// Mirror symmetry about the sun meridian lets [0, PI] cover every azimuth.
// `up` is local positive Y at the synthetic ground observer. The returned
// Rayleigh and Mie inscatter already includes bake-time intensity.
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

// Sample multiple scattering on the same sun-relative domain and with the same
// UV derivation as `sampleSkyViewLut`, preserving directional agreement.
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

// Match `SkyAtmosphere.wgsl` so reflected and visible multiple-scattering
// strength remain consistent.
const MS_SCALE: f32 = 0.06;
const PI: f32 = 3.14159265358979323846;

// Low-resolution per-face cloud march.
//
// This deliberately coarse port of `ProceduralClouds.wgsl` samples the visible
// cloud path's baked shape and detail noise with a small fixed step count, one
// simplified deck, and a cheap Beer-Lambert sun shadow. The downstream
// prefilter and SH projection remove high-frequency detail, so a low-resolution
// march is sufficient. It runs only for positive `cloudMarch` and coverage;
// otherwise the noise bindings contain unsampled placeholders.

// Use the visible density field's ray-interval-to-voxel rule. One-level
// placeholders naturally clamp to LOD 0.
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

// Baked cloud base shape: one trilinear shape fetch warped by a slow detail
// offset to reduce tiling, matching `ProceduralClouds.wgsl`.
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
  // Share `cloudEffectiveCoverage` with the visible march so reflected and
  // ambient cloud density cannot diverge and silently mis-light models.
  density = smoothstep(1.0 - cloudEffectiveCoverage(coverage), 1.0, density);

  // Billowy vertical gradient for the cumulus profile.
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
  // The view origin is below both cloud shells at the planet surface. Enter at
  // the far hit on the inner shell and exit at the far hit on the outer shell,
  // matching the below-deck branch in `ProceduralClouds.wgsl`. A missed deck
  // produces an empty interval and exits below.
  var tStart = max(hitInner.y, 0.0);
  var tEnd = hitOuter.y;
  if (tEnd <= tStart) {
    return vec4<f32>(0.0);
  }

  // Cap the span so a low-resolution grazing ray cannot cover a huge segment.
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

  // Fill and sample the cubemap in the planet-local IBL reference frame with
  // positive Y up. The PBR shader samples at
  // `iblReferenceFrameMatrix * reflectionDirection` using the prefilter's
  // `faceUvToDirection` convention. Keeping radiance in this local frame makes
  // reflections remain world-anchored as the camera orbits.
  let dir = faceUVToLocalDir(face, uv);

  // Planet-local view origin, +Y up (the reference frame's up axis), at the
  // model's height above the geodetic surface (ComputeRadianceMapFS:24-29:
  // the position is scaled to `ellipsoidHeight + atmosphereInnerRadius`, so
  // the sky is present even underground — ellipsoidHeight is pre-clamped to
  // >= 0 on the JS side). Scattering geometry uses innerRadius for the shell.
  let viewOrigin = vec3<f32>(0.0, u.innerRadius + u.ellipsoidHeight, 0.0);
  let atmosphereHeight = u.outerRadius - u.innerRadius;

  // `ComputeRadianceMapFS` classifies a ray as ground when it hits the inner
  // sphere ahead of the origin and terminates it at that hit. A sky ray instead
  // uses the outer-radius value as its primary length. The scattering march
  // applies its own 111 km shell-exit clamp. This keeps downward rays out of
  // the planet and gives `NONE` lighting the correct sky-sample position.
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
  // `LEGACY_OVERHEAD` follows the `NONE` local-up arm. The IBL bake keeps local
  // up for `NONE` because its WebGL counterpart in `ComputeRadianceMapFS.glsl`
  // resolves that mode through `czm_getDynamicAtmosphereLightDirection`.
  let enumVal = u.dynamicLightingEnum;
  let sunLocal = normalize(vec3<f32>(
    dot(u.sunDirectionWC, u.enuX),
    dot(u.sunDirectionWC, u.enuZ),
    dot(u.sunDirectionWC, u.enuY),
  ));
  var lightDir: vec3<f32>;
  if (enumVal < 0.5 || enumVal > 2.5) {
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

  // Use the inline atmosphere color unless the sun-relative LUT path is
  // enabled. The LUTs include bake-time atmosphere intensity and use `sunLocal`
  // with the texel direction to match the visible sky's directional response.
  // `NONE` lighting remains on the radially symmetric inline march because the
  // LUT bakes one light direction.
  var skyColor = atmosphereColor.rgb;
  if (u.useMultiScatterLut > 0.5 && enumVal >= 0.5) {
    let lutSky = sampleSkyViewLut(up, dir, sunLocal);
    let lutMs = sampleMultipleScatterLut(up, dir, sunLocal);
    skyColor = lutSky + lutMs * MS_SCALE;
  }

  // Coarse overcast fallback. Zero coverage makes both blends identities.
  // Otherwise, lerping each texel toward a dim grey dome before the sky-ground
  // composite lets SH projection reconstruct a flatter and darker ambient.
//
  // A flat dome deposits more irradiance on vertical facets than a clear sky
  // whose brightest radiance occupies the upper hemisphere. The target must
  // therefore be substantially dimmer to avoid brighter shadow fill. Dense
  // storm decks transmit roughly 10–15 percent of clear-sky illuminance, so
  // full coverage uses about 0.12 transmittance. Half coverage reads as hazy
  // bright overcast; full coverage approaches a dim, shadowless storm deck.
//
  // The per-face cloud march replaces this approximation when enabled, so the
  // coarse path is skipped to avoid double darkening.
  let coverage = clamp(u.cloudCoverage, 0.0, 1.0);
  if (coverage > 0.0 && u.cloudMarch <= 0.0) {
    let lum = dot(skyColor, vec3<f32>(0.2126, 0.7152, 0.0722));
    // Apply transmittance to the grey target so flattening cannot brighten the
    // texel it replaces.
    let transmit = mix(1.0, 0.12, coverage);
    let dimGrey = vec3<f32>(lum) * transmit;
    // How strongly the texel collapses to the dim grey. At full coverage the
    // sky is almost entirely the flat dim dome (0.95), so directionality + the
    // bright sun-relative chroma are nearly gone.
    let blend = coverage * 0.95;
    skyColor = mix(skyColor, dimGrey, blend);
  }

  // March the cloud deck only for enabled, covered upper-hemisphere texels.
  // Premultiplied compositing occludes the sky behind each cloud and carries
  // structured radiance into SH projection and prefiltering. Down-facing texels
  // retain the ground term.
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
