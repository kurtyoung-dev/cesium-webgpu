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
//   - innerRadius/outerRadius: atmosphere shell radii at the position.
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
  _pad0: f32,
};

@group(0) @binding(0) var<uniform> u: SkyUniforms;
@group(0) @binding(1) var outputTexture: texture_storage_2d_array<rgba8unorm, write>;

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

fn raySphereExit(origin: vec3<f32>, dir: vec3<f32>, radius: f32) -> f32 {
  let b = dot(origin, dir);
  let c = dot(origin, origin) - radius * radius;
  let disc = b * b - c;
  if (disc < 0.0) {
    return -1.0;
  }
  return -b + sqrt(disc);
}

// Port of czm_computeScattering (AtmosphereCommon.glsl). Uses the
// frameState.atmosphere coefficients passed via uniforms so the WebGPU
// sky matches the visible SkyAtmosphere + WebGL IBL exactly.
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
  let origin = vec3<f32>(0.0);

  // Intersection of the primary ray with the outer atmosphere sphere.
  let primExit = raySphereExit(rayOrigin, rayDir, outerRadius);
  if (primExit <= 0.0) {
    return result;
  }

  let PRIMARY_STEPS = PRIMARY_STEPS_MAX;
  let LIGHT_STEPS = LIGHT_STEPS_MAX;

  let rayStart = 0.0;
  let rayStop = min(primExit, rayLength);
  let totalRayLength = rayStop - rayStart;
  let rayStepLength = totalRayLength / f32(PRIMARY_STEPS);

  var rayleighAccum = vec3<f32>(0.0);
  var mieAccum = vec3<f32>(0.0);
  var opticalDepthR = 0.0;
  var opticalDepthM = 0.0;
  var rayPos = rayStart;

  for (var i = 0; i < PRIMARY_STEPS_MAX; i = i + 1) {
    if (i >= PRIMARY_STEPS) { break; }

    let samplePos = rayOrigin + rayDir * (rayPos + rayStepLength * 0.5);
    let sampleHeight = length(samplePos) - innerRadius;

    let densityR = exp(-sampleHeight / u.rayleighScaleHeight) * rayStepLength;
    let densityM = exp(-sampleHeight / u.mieScaleHeight) * rayStepLength;
    opticalDepthR = opticalDepthR + densityR;
    opticalDepthM = opticalDepthM + densityM;

    let lightExit = raySphereExit(samplePos, lightDir, outerRadius);
    let lightStepLength = lightExit / f32(LIGHT_STEPS);
    var lightOpticalDepthR = 0.0;
    var lightOpticalDepthM = 0.0;
    var lightPos = 0.0;

    for (var j = 0; j < LIGHT_STEPS_MAX; j = j + 1) {
      if (j >= LIGHT_STEPS) { break; }
      let lightSample = samplePos + lightDir * (lightPos + lightStepLength * 0.5);
      let lightHeight = length(lightSample) - innerRadius;
      lightOpticalDepthR = lightOpticalDepthR + exp(-lightHeight / u.rayleighScaleHeight) * lightStepLength;
      lightOpticalDepthM = lightOpticalDepthM + exp(-lightHeight / u.mieScaleHeight) * lightStepLength;
      lightPos = lightPos + lightStepLength;
    }

    let attenuation = exp(
      -(u.mieCoefficient * (opticalDepthM + lightOpticalDepthM)
        + u.rayleighCoefficient * (opticalDepthR + lightOpticalDepthR))
    );

    rayleighAccum = rayleighAccum + densityR * attenuation;
    mieAccum = mieAccum + densityM * attenuation;
    rayPos = rayPos + rayStepLength;
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

  // Planet-local view origin at the surface, +Y up (the reference frame's
  // up axis). Scattering geometry uses innerRadius for the shell.
  let viewOrigin = vec3<f32>(0.0, u.innerRadius, 0.0);
  let rayLength = u.outerRadius - u.innerRadius;
  let skyLocalPos = viewOrigin + dir * rayLength;

  // Light direction in the local frame:
  //   NONE (default)  -> local zenith of the sky sample (smooth radially-
  //                      symmetric sky; matches WebGL's at-rest IBL).
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

  // 1:1 with ComputeRadianceMapFS: the sky is `atmosphereColor.rgb *
  // intensity` and the ground reuses that intensity for the reflected-
  // light occlusion term. `intensity` here is the manager's
  // atmosphereScatteringIntensity (matches the FS's
  // u_brightnessSaturationGammaIntensity.w). `atmosphereColor` already
  // carries atmosphere.lightIntensity (u.intensity) from
  // computeAtmosphereColor.
  let scatteringIntensity = u.scatteringIntensity;
  var color: vec3<f32>;
  if (upDot >= 0.0) {
    color = atmosphereColor.rgb * scatteringIntensity;
  } else {
    let occlusion = max(dot(lightDir, up), 0.05);
    color = u.groundColor * u.groundAlbedo
          * (vec3<f32>(scatteringIntensity * occlusion) + atmosphereColor.rgb);
  }

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
