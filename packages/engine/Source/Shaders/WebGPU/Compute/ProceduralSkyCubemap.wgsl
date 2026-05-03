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

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let size = u32(u.faceSize);
  if (gid.x >= size || gid.y >= size || gid.z >= 6u) {
    return;
  }
  let face = gid.z;
  let uv = (vec2<f32>(f32(gid.x), f32(gid.y)) + vec2<f32>(0.5)) / f32(size);
  let dir = faceUVToDir(face, uv);

  // Vertical gradient: sky at +Y, horizon at Y=0, ground at -Y. Smooth
  // hemispherical blend gives a realistic studio HDR look out of the
  // box. y in [-1, 1]; gradT in [0, 1] with 0.5 at horizon.
  let y = dir.y;
  let horizonBlend = smoothstep(-0.1, 0.3, y);
  let skyDiffuse = mix(u.groundColor, u.skyColor, horizonBlend);

  // Sun disc -- broad soft falloff so the IBL prefilter produces a
  // recognizable direct-light highlight in glossy reflections without
  // aliasing. Width is tuned for the typical 128x128 cubemap face; at
  // higher resolutions the disc remains readable through the prefilter.
  let sunDot = max(dot(dir, normalize(u.sunDirection)), 0.0);
  let sunDisc = pow(sunDot, 256.0) * u.sunIntensity;
  let sunHalo = pow(sunDot, 8.0) * 0.05 * u.sunIntensity;
  let sunContribution = u.sunColor * (sunDisc + sunHalo);

  let color = skyDiffuse + sunContribution;
  textureStore(outputTexture, vec2<i32>(i32(gid.x), i32(gid.y)), i32(face),
               vec4<f32>(color, 1.0));
}
