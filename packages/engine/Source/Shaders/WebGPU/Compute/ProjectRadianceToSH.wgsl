// ProjectRadianceToSH.wgsl — Radiance Cubemap → Spherical-Harmonic (L2) Projection
//
// NEW-WEBGPU-KHR-SPECULAR-IBL-OVERBRIGHT (Batch 354). WebGPU parity for
// the WebGL diffuse-IBL SH path. WebGL feeds a model's diffuse IBL via 9
// atmosphere-derived SH-L2 coefficients (czm_sphericalHarmonics); WebGPU
// previously had no SH producer, so models fell back to sampling the
// irradiance cubemap — a ~20-30% different energy reconstruction (worst
// in blue), reading as a +15% luminance / +24% blue overbright vs WebGL.
//
// This is a byte-faithful transcription of the WebGL projection in
// `ComputeIrradianceFS.glsl` (computeShBasis + the 256-sample Monte-Carlo
// loop), INCLUDING WebGL's `(-x, -y, z)` cube-lookup flip
// (ComputeIrradianceFS.glsl:94-95). NEW-MODEL-IBL-AMBIENT (re-land of the
// audited-GO B3 fix): the Batch-354 claim that raw-direction sampling was
// an intentional backend difference was NUMERICALLY DISPROVEN — a JS
// re-projection of the live WebGPU radiance cube at the 256 Hammersley
// directions WITH the flip reproduces WebGL's measured SH c1 blue
// coefficient (0.151 vs 0.152), while raw sampling gives 0.029 (5x short
// on the sky-blue directional band = the olive model tint). The flip is
// required for parity.
//
// One backend-specific difference that IS intentional:
//
//   Output is written straight into a storage buffer (9 vec4 + a
//   control vec4) instead of WebGL's 3×3 render-to-texture + readback.
//   The same buffer is bound as the model's `SHUniforms` uniform
//   (binding 36) — no CPU round-trip.
//
// Energy: the WebGPU radiance cube already bakes `atmosphereScatteringIntensity`
// (ProceduralSkyCubemap.wgsl:295), exactly as WebGL's radiance map does
// (ComputeRadianceMapFS.glsl:85, `.w` = atmosphereScatteringIntensity).
// WebGL then multiplies the projected coeffs by atmosphereScatteringIntensity
// AGAIN (DynamicEnvironmentMapManager.js:979) — a deliberate double-apply.
// `params.intensity` carries that second multiply so the result matches.
//
// Dispatch: 1 workgroup of 9 invocations — invocation i computes coeff i.

@group(0) @binding(0) var radianceCube: texture_cube<f32>;
@group(0) @binding(1) var radianceSampler: sampler;
@group(0) @binding(2) var<storage, read_write> shOut: SHOut;
@group(0) @binding(3) var<uniform> params: Params;

struct SHOut {
  // 9 L2 coefficients, padded to vec4 to match the model's SHUniforms
  // uniform layout (c0..c8 at offsets 0..128), then a control slot at 144.
  c: array<vec4<f32>, 9>,
  // .w == 1.0 marks the SH as active so the model's `sh.control.w > 0.5`
  // gate evaluates SH instead of sampling the irradiance cubemap.
  control: vec4<f32>,
};

struct Params {
  // atmosphereScatteringIntensity — the WebGL step-3 multiply (the cube
  // already has the step-1 bake), kept in .x; .yzw padding.
  intensity: f32,
  _pad0: f32,
  _pad1: f32,
  _pad2: f32,
};

// 2 * sqrt(pi). Literal to avoid relying on const-eval of sqrt().
const TWO_SQRT_PI: f32 = 3.5449077018110318;
const PI: f32 = 3.14159265358979323846;
const SAMPLES: i32 = 256;
const SOLID_ANGLE: f32 = 1.0 / 256.0;

// Courtesy of https://www.ppsloan.org/publications/StupidSH36.pdf —
// identical to ComputeIrradianceFS.glsl::computeShBasis.
fn computeShBasis(index: u32, s: vec3<f32>) -> f32 {
  switch (index) {
    case 0u: { return 1.0 / TWO_SQRT_PI; }                              // l=0,m=0
    case 1u: { return -sqrt(3.0) * s.y / TWO_SQRT_PI; }                 // l=1,m=-1
    case 2u: { return sqrt(3.0) * s.z / TWO_SQRT_PI; }                  // l=1,m=0
    case 3u: { return -sqrt(3.0) * s.x / TWO_SQRT_PI; }                 // l=1,m=1
    case 4u: { return sqrt(15.0) * s.y * s.x / TWO_SQRT_PI; }           // l=2,m=-2
    case 5u: { return -sqrt(15.0) * s.y * s.z / TWO_SQRT_PI; }          // l=2,m=-1
    case 6u: { return sqrt(5.0) * (3.0 * s.z * s.z - 1.0) / 2.0 / TWO_SQRT_PI; } // l=2,m=0
    case 7u: { return -sqrt(15.0) * s.x * s.z / TWO_SQRT_PI; }          // l=2,m=1
    case 8u: { return sqrt(15.0) * (s.x * s.x - s.y * s.y) / 2.0 / TWO_SQRT_PI; } // l=2,m=2
    default: { return 0.0; }
  }
}

// Van der Corput radical inverse (base 2) — matches GLSL vdcRadicalInverse.
fn vdcRadicalInverse(iIn: i32) -> f32 {
  var i = iIn;
  var value: f32 = 0.0;
  var invBi: f32 = 0.5;
  for (var x: i32 = 0; x < 100; x = x + 1) {
    if (i <= 0) {
      break;
    }
    let r = f32(i % 2);
    value = value + r * invBi;
    invBi = invBi * 0.5;
    i = i / 2;
  }
  return value;
}

fn hammersley2D(i: i32, N: i32) -> vec2<f32> {
  return vec2<f32>(f32(i) / f32(N), vdcRadicalInverse(i));
}

@compute @workgroup_size(9)
fn main(@builtin(local_invocation_id) lid: vec3<u32>) {
  let coeffIndex = lid.x;
  if (coeffIndex >= 9u) {
    return;
  }

  var accum = vec3<f32>(0.0);
  for (var i: i32 = 0; i < SAMPLES; i = i + 1) {
    let xi = hammersley2D(i, SAMPLES);
    let phi = 2.0 * PI * xi.x;
    let cosTheta = 1.0 - 2.0 * sqrt(1.0 - xi.y * xi.y);
    let sinTheta = sqrt(1.0 - cosTheta * cosTheta);
    let direction = normalize(
      vec3<f32>(sinTheta * cos(phi), cosTheta, sinTheta * sin(phi)),
    );

    let Ylm = computeShBasis(coeffIndex, direction);
    // WebGL's cube-lookup flip (ComputeIrradianceFS.glsl:94-95):
    // lookupDirection = -direction; lookupDirection.z = -lookupDirection.z
    // → (-x, -y, z). Required for SH parity — see header.
    let lookupDirection = vec3<f32>(-direction.x, -direction.y, direction.z);
    let color = textureSampleLevel(radianceCube, radianceSampler, lookupDirection, 0.0);

    accum = accum + Ylm * color.rgb * SOLID_ANGLE * sinTheta;
  }

  // WebGL's step-3 atmosphereScatteringIntensity multiply (the cube
  // already carries the step-1 bake).
  accum = accum * params.intensity;

  shOut.c[coeffIndex] = vec4<f32>(accum, 0.0);
  if (coeffIndex == 0u) {
    shOut.control = vec4<f32>(0.0, 0.0, 0.0, 1.0);
  }
}
