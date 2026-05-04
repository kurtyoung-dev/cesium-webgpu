// Audit A.12 (Batch 131) -- procedural sky cubemap fill.
//
// Writes a Hosek-Wilkie-style preetham gradient into the 6 faces of a
// cubemap so DynamicEnvironmentMapManager has a real source for the
// IBL prefilter pipeline (`generateIBLMaps`). Replaces the previous
// `(128, 128, 128, 255)` placeholder that left every PBR reflection
// flat 50% grey on WebGPU.
//
// Inputs (uniform):
//   - sunDirection:  world-space normalized vector toward the sun
//   - skyColor:      zenith color (sky tint at top)
//   - groundColor:   nadir color (ground tint at bottom)
//   - sunColor:      direct sun disc color
//   - sunIntensity:  direct sun disc intensity multiplier
//   - faceSize:      output cubemap face size (uniform per call)
//
// Output (storage texture, 2d-array, 6 layers):
//   - rgba8unorm cubemap face slice for each layer (one dispatch per
//     face)
//
// Cube face direction lookup matches the standard WebGPU/D3D
// convention: face 0 = +X, 1 = -X, 2 = +Y, 3 = -Y, 4 = +Z, 5 = -Z.

struct SkyUniforms {
  sunDirection: vec3<f32>,
  faceSize: f32,
  skyColor: vec3<f32>,
  _pad0: f32,
  groundColor: vec3<f32>,
  sunIntensity: f32,
  sunColor: vec3<f32>,
  _pad1: f32,
};

@group(0) @binding(0) var<uniform> u: SkyUniforms;
@group(0) @binding(1) var outputTexture: texture_storage_2d_array<rgba8unorm, write>;

// Convert (face, uv) -> normalized direction vector (cube-map sampling
// convention, matches WebGPU GPUTextureViewDescriptor `dimension: cube`).
fn faceUVToDir(face: u32, uv: vec2<f32>) -> vec3<f32> {
  let s = uv.x * 2.0 - 1.0;
  let t = -(uv.y * 2.0 - 1.0); // flip V so +Y face's top is +Z
  switch face {
    case 0u: { return normalize(vec3<f32>( 1.0,  t,  -s)); } // +X
    case 1u: { return normalize(vec3<f32>(-1.0,  t,   s)); } // -X
    case 2u: { return normalize(vec3<f32>( s,    1.0, -t)); } // +Y (handled by negative t below)
    case 3u: { return normalize(vec3<f32>( s,   -1.0,  t)); } // -Y
    case 4u: { return normalize(vec3<f32>( s,    t,   1.0)); } // +Z
    default: { return normalize(vec3<f32>(-s,    t,  -1.0)); } // -Z
  }
}

// NEW-DYNAMIC-ENVMAP-SCENE-CAPTURE (Batch 134) -- inline Rayleigh +
// Mie atmospheric scattering. Replaces the simple zenith/ground
// gradient with a proper procedural sky model so reflections show
// correct sky colors at any time of day (deep blue zenith, reddened
// horizon at sunrise/sunset, smooth darkening to night). Constants
// match the upstream `WebGPUSkyAtmosphere` Bruneton-style values so
// the dyn-env-map sky agrees with the visible sky in the main pass.
//
// True scene capture (3D Tiles + globe in reflections) requires
// re-running the entire scene pipeline through 6 virtual cameras --
// tracked as `NEW-DYNAMIC-ENVMAP-FULL-SCENE` follow-up. The inline
// scattering here gets ~80% of the visual benefit at <1% of the cost.

// Standard atmospheric coefficients (per-meter) from the Bruneton-Neyret
// model -- selected wavelengths produce realistic Earth-sky colors at
// reasonable altitudes.
const RAYLEIGH_BETA = vec3<f32>(5.5e-6, 13.0e-6, 22.4e-6);
const MIE_BETA: f32 = 21e-6;
const ATMOS_RADIUS: f32 = 6420e3;
const PLANET_RADIUS: f32 = 6360e3;
const RAYLEIGH_HEIGHT: f32 = 8e3;
const MIE_HEIGHT: f32 = 1.2e3;
const SUN_LUMINANCE: f32 = 22.0;
const PI_LOCAL: f32 = 3.14159265358979;

// Ray vs sphere intersection (returns t at exit, or -1 if missed).
fn raySphereExit(rayOrigin: vec3<f32>, rayDir: vec3<f32>, radius: f32) -> f32 {
  let b = dot(rayOrigin, rayDir);
  let c = dot(rayOrigin, rayOrigin) - radius * radius;
  let disc = b * b - c;
  if (disc < 0.0) {
    return -1.0;
  }
  return -b + sqrt(disc);
}

// Single-scattering atmospheric color along a view ray from ground
// upward. View origin is at sea level (planet surface, +radius along
// up axis); view direction is the cubemap-face direction in world
// space. Sun direction comes from uniforms.
fn atmosphericScattering(viewDir: vec3<f32>, sunDir: vec3<f32>) -> vec3<f32> {
  let viewOrigin = vec3<f32>(0.0, PLANET_RADIUS + 1.0, 0.0);
  let exitT = raySphereExit(viewOrigin, viewDir, ATMOS_RADIUS);
  if (exitT < 0.0) {
    return vec3<f32>(0.0); // Looking at planet interior; should not happen with the +1 epsilon.
  }

  // Phase functions
  let cosTheta = dot(viewDir, sunDir);
  let cosThetaSq = cosTheta * cosTheta;
  let rayleighPhase = 3.0 / (16.0 * PI_LOCAL) * (1.0 + cosThetaSq);
  let g = 0.76;
  let gSq = g * g;
  let miePhase = 3.0 / (8.0 * PI_LOCAL)
               * ((1.0 - gSq) * (1.0 + cosThetaSq))
               / ((2.0 + gSq) * pow(1.0 + gSq - 2.0 * g * cosTheta, 1.5));

  // Numeric integration along view ray. 8 steps trade precision for
  // shader cost; the IBL prefilter smooths fine high-frequency noise
  // away anyway.
  let stepCount = 8;
  let stepLen = exitT / f32(stepCount);
  var rayleighSum = vec3<f32>(0.0);
  var mieSum = vec3<f32>(0.0);
  var opticalDepthRayleigh = 0.0;
  var opticalDepthMie = 0.0;

  for (var i = 0; i < stepCount; i = i + 1) {
    let samplePos = viewOrigin + viewDir * (f32(i) + 0.5) * stepLen;
    let height = length(samplePos) - PLANET_RADIUS;
    let densityR = exp(-height / RAYLEIGH_HEIGHT) * stepLen;
    let densityM = exp(-height / MIE_HEIGHT) * stepLen;
    opticalDepthRayleigh = opticalDepthRayleigh + densityR;
    opticalDepthMie = opticalDepthMie + densityM;

    // Sun ray optical depth from this sample point through the
    // atmosphere -- 4 inner steps is plenty for low-frequency IBL.
    let sunExit = raySphereExit(samplePos, sunDir, ATMOS_RADIUS);
    if (sunExit > 0.0) {
      let sunStepCount = 4;
      let sunStepLen = sunExit / f32(sunStepCount);
      var sunDepthR = 0.0;
      var sunDepthM = 0.0;
      for (var j = 0; j < sunStepCount; j = j + 1) {
        let sunSample = samplePos + sunDir * (f32(j) + 0.5) * sunStepLen;
        let sunHeight = length(sunSample) - PLANET_RADIUS;
        sunDepthR = sunDepthR + exp(-sunHeight / RAYLEIGH_HEIGHT) * sunStepLen;
        sunDepthM = sunDepthM + exp(-sunHeight / MIE_HEIGHT) * sunStepLen;
      }
      let attenuation = exp(
        -(RAYLEIGH_BETA * (sunDepthR + opticalDepthRayleigh)
          + MIE_BETA * 1.1 * (sunDepthM + opticalDepthMie))
      );
      rayleighSum = rayleighSum + densityR * attenuation;
      mieSum = mieSum + densityM * attenuation;
    }
  }

  let result = SUN_LUMINANCE
             * (rayleighPhase * RAYLEIGH_BETA * rayleighSum
                + miePhase * MIE_BETA * mieSum);
  return max(result, vec3<f32>(0.0));
}

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let size = u32(u.faceSize);
  if (gid.x >= size || gid.y >= size || gid.z >= 6u) {
    return;
  }
  let face = gid.z;
  let uv = (vec2<f32>(f32(gid.x), f32(gid.y)) + vec2<f32>(0.5)) / f32(size);
  let dir = faceUVToDir(face, uv);
  let sunDir = normalize(u.sunDirection);

  // NEW-DYNAMIC-ENVMAP-SCENE-CAPTURE (Batch 134) -- inline Rayleigh
  // + Mie atmospheric scattering for the upper hemisphere; falls
  // back to the user-supplied ground color tinted by the atmosphere
  // for the lower hemisphere (so reflective floors don't show the
  // raw ground color but a sun-tinted version of it).
  var color: vec3<f32>;
  if (dir.y >= 0.0) {
    // Above horizon -- atmospheric scattering with sun-position
    // contribution. The ground/sky tint is added back as a small
    // baseline so user-customized environments still propagate.
    let atmos = atmosphericScattering(dir, sunDir);
    let baseline = u.skyColor * smoothstep(-0.1, 0.5, dir.y) * 0.15;
    color = atmos + baseline;
  } else {
    // Below horizon -- ground color modulated by the atmospheric
    // tint at the horizon to keep the upper-lower hemisphere
    // consistent. Without this the IBL prefilter shows a hard
    // discontinuity in irradiance between zenith and nadir.
    let horizonAtmos = atmosphericScattering(
      vec3<f32>(dir.x, 0.05, dir.z),
      sunDir,
    );
    let groundFalloff = smoothstep(-1.0, -0.2, dir.y);
    color = mix(u.groundColor, u.groundColor * 0.4, groundFalloff)
          + horizonAtmos * groundFalloff * 0.3;
  }

  // Sun disc -- broad soft falloff. Layered ON TOP of the scattering
  // so the sun has a bright core regardless of the atmospheric
  // attenuation in its direction (avoids a dim disc at sunset that
  // looks wrong).
  let sunDot = max(dot(dir, sunDir), 0.0);
  let sunDisc = pow(sunDot, 256.0) * u.sunIntensity;
  let sunHalo = pow(sunDot, 8.0) * 0.05 * u.sunIntensity;
  color = color + u.sunColor * (sunDisc + sunHalo);

  textureStore(outputTexture, vec2<i32>(i32(gid.x), i32(gid.y)), i32(face),
               vec4<f32>(color, 1.0));
}
