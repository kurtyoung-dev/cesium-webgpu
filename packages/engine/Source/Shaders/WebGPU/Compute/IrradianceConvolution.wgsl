// IrradianceConvolution.wgsl — Diffuse Irradiance Cubemap Compute Shader
//
// Convolves an input environment cubemap into a small diffuse irradiance
// cubemap (typically 32×32 per face). Each output texel integrates the
// incoming radiance over the cosine-weighted hemisphere.
//
// This is used for the diffuse component of IBL in the split-sum PBR pipeline:
//   diffuseIBL = irradiance(N) * diffuseColor
//
// Alternative: Spherical harmonics (L2 band, 9 coefficients) can replace this
// cubemap for diffuse irradiance. CesiumJS supports both paths — when SH
// coefficients are provided by the user, this convolution is skipped.
//
// Reference: Brian Karis, "Real Shading in Unreal Engine 4" (SIGGRAPH 2013
// Physically Based Shading course) — the split-sum approximation whose diffuse
// half this convolution precomputes. The cosine-weighted hemisphere sum below
// is the direct form of that integral, not an importance-sampled estimate.
//
// Dispatch: 6 × ceil(size/8) × ceil(size/8) workgroups
//   Each invocation writes one texel of one cubemap face.

struct Params {
  faceIndex: u32,     // 0-5: +X, -X, +Y, -Y, +Z, -Z
  outputSize: u32,    // e.g. 32
  _pad0: u32,
  _pad1: u32,
};

@group(0) @binding(0) var envCubemap: texture_cube<f32>;
@group(0) @binding(1) var envSampler: sampler;
@group(0) @binding(2) var outputTex: texture_storage_2d_array<rgba16float, write>;
@group(0) @binding(3) var<uniform> params: Params;

const PI: f32 = 3.14159265358979323846;
const SAMPLE_DELTA: f32 = 0.025; // Angular step for hemisphere sampling

// Maps a cubemap face index + UV to a world-space direction
fn faceUvToDirection(face: u32, uv: vec2<f32>) -> vec3<f32> {
  // UV in [-1, 1]
  let u = uv.x * 2.0 - 1.0;
  let v = uv.y * 2.0 - 1.0;

  switch (face) {
    case 0u: { return normalize(vec3<f32>( 1.0,   -v,   -u)); } // +X
    case 1u: { return normalize(vec3<f32>(-1.0,   -v,    u)); } // -X
    case 2u: { return normalize(vec3<f32>(   u,  1.0,    v)); } // +Y
    case 3u: { return normalize(vec3<f32>(   u, -1.0,   -v)); } // -Y
    case 4u: { return normalize(vec3<f32>(   u,   -v,  1.0)); } // +Z
    default: { return normalize(vec3<f32>(  -u,   -v, -1.0)); } // -Z
  }
}

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let size = params.outputSize;
  if (gid.x >= size || gid.y >= size) {
    return;
  }

  let uv = vec2<f32>(
    (f32(gid.x) + 0.5) / f32(size),
    (f32(gid.y) + 0.5) / f32(size),
  );

  let N = faceUvToDirection(params.faceIndex, uv);

  // Build tangent frame from N
  let up = select(vec3<f32>(1.0, 0.0, 0.0), vec3<f32>(0.0, 0.0, 1.0), abs(N.y) < 0.999);
  let right = normalize(cross(up, N));
  let forward = cross(N, right);

  // Cosine-weighted hemisphere integration via uniform sampling
  var irradiance = vec3<f32>(0.0);
  var sampleCount: f32 = 0.0;

  // Uniform angular sampling over the hemisphere
  var phi: f32 = 0.0;
  while (phi < 2.0 * PI) {
    var theta: f32 = 0.0;
    while (theta < 0.5 * PI) {
      let sinT = sin(theta);
      let cosT = cos(theta);

      // Spherical to cartesian (tangent space)
      let tangentSample = vec3<f32>(sinT * cos(phi), sinT * sin(phi), cosT);

      // Tangent space to world space
      let sampleDir = tangentSample.x * right + tangentSample.y * forward + tangentSample.z * N;

      let envColor = textureSampleLevel(envCubemap, envSampler, sampleDir, 0.0).rgb;
      irradiance = irradiance + envColor * cosT * sinT;
      sampleCount = sampleCount + 1.0;

      theta = theta + SAMPLE_DELTA;
    }
    phi = phi + SAMPLE_DELTA;
  }

  irradiance = PI * irradiance / sampleCount;

  textureStore(outputTex, vec2<i32>(gid.xy), i32(params.faceIndex),
               vec4<f32>(irradiance, 1.0));
}
