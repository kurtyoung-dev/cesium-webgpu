// SolarHalo.wgsl — screen-space solar veiling glare, the WebGPU half.
//
// Twin of Shaders/PostProcessStages/SolarHalo.glsl; both are translations of
// `solarScreenHaloProfile` in Scene/SolarDiscModel.js, and an acceptance spec
// extracts, compiles and compares all three bodies. A change here must land
// with the matching change there. See SHADER_PAIRS_LOCKSTEP.md.
//
// This is the WebGPU consumer of `scene.sunBloom`:
// `WebGPUContext.supportsLegacySunBloom` returns false, so without this stage
// nothing on the WebGPU backend reads the flag and the sun has no
// screen-space halo at all.
//
// Everything variable here is a runtime uniform rather than a shader define,
// because the low-word define registry is exhausted.

struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) uv: vec2<f32>,
};

struct SolarHaloUniforms {
  // x, y = projected solar centre in drawing-buffer pixels, GL convention
  //        (y UP from the bottom-left) — the SAME publication the WebGL stage
  //        reads, converted below rather than duplicated CPU-side.
  // z     = pixels per solar radius.
  // w     = half-amplitude radius of the veil, in solar radii.
  geometry: vec4<f32>,
  // xyz = per-channel atmospheric transmittance,
  //       (1,1,1) from orbit / atmosphere hidden.
  // w   = amplitude x eclipse factor (CLT-C4); exactly 0 disables the add.
  tint: vec4<f32>,
  // x = drawing-buffer height in pixels, needed for the y flip below.
  // y, z, w = unused.
  viewport: vec4<f32>,
};

@group(0) @binding(0) var inputTexture: texture_2d<f32>;
@group(0) @binding(1) var inputSampler: sampler;
@group(0) @binding(2) var<uniform> halo: SolarHaloUniforms;

@vertex
fn vertexMain(@builtin(vertex_index) vertexIndex: u32) -> VertexOutput {
  var output: VertexOutput;
  let x = f32(i32(vertexIndex & 1u) * 4 - 1);
  let y = f32(i32(vertexIndex >> 1u) * 4 - 1);
  output.position = vec4<f32>(x, y, 0.0, 1.0);
  output.uv = vec2<f32>((x + 1.0) * 0.5, (1.0 - y) * 0.5);
  return output;
}

@fragment
fn fragmentMain(in: VertexOutput) -> @location(0) vec4<f32> {
  let color = textureSample(inputTexture, inputSampler, in.uv);

  // `@builtin(position)` in WGSL is pixel-centred with y DOWN from the
  // top-left; `gl_FragCoord` in the GLSL twin is pixel-centred with y UP from
  // the bottom-left. The published centre is in the GL convention, so the
  // FRAGMENT is converted here (height - y) rather than the centre being
  // pre-flipped on the CPU — one publication, one flip, at the only place
  // that knows which convention it is reading.
  let fragGL = vec2<f32>(in.position.x, halo.viewport.x - in.position.y);

  let rho = length(fragGL - halo.geometry.xy) / halo.geometry.z;
  let t = rho / halo.geometry.w;
  let veil = 1.0 / (1.0 + t * t);

  // ADDITIVE, rgb only — see the GLSL twin's note.
  return vec4<f32>(color.rgb + halo.tint.xyz * (veil * halo.tint.w), color.a);
}
