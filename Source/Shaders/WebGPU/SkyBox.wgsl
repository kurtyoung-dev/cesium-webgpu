// SkyBox.wgsl — WebGPU skybox shader for CesiumJS
//
// Renders a cubemap sky box around the scene (stars, etc.).
// Uses TEME (True Equator Mean Equinox) axes for star positions.
//
// NOTE: SkyBox does NOT need RTE precision because:
// - The box is always centered on the camera (view rotation only, no translation)
// - Positions are just direction vectors for cubemap lookup
//
// Uniform layout (144 bytes, buffer 256-aligned):
//   projection:      mat4x4<f32>  (offset 0,   64 bytes)
//   rotationMatrix:  mat4x4<f32>  (offset 64,  64 bytes) — viewRotation * temeToPseudoFixed
//   params:          vec4<f32>    (offset 128, 16 bytes) — x=far, y=morphTime, z=0, w=0

struct SkyBoxUniforms {
  projection: mat4x4<f32>,
  rotationMatrix: mat4x4<f32>,
  params: vec4<f32>,
};

@group(0) @binding(0) var<uniform> uniforms: SkyBoxUniforms;
@group(1) @binding(0) var cubeMapSampler: sampler;
@group(1) @binding(1) var cubeMapTexture: texture_cube<f32>;

struct VertexInput {
  @location(0) position: vec3<f32>,
};

struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) texCoord: vec3<f32>,
};

@vertex
fn vertexMain(input: VertexInput) -> VertexOutput {
  var output: VertexOutput;

  let far = uniforms.params.x;
  let scaledPos = far * input.position;

  // Extract 3x3 rotation from the 4x4 matrix
  // rotationMatrix = viewRotation * temeToPseudoFixed
  let rot = mat3x3<f32>(
    uniforms.rotationMatrix[0].xyz,
    uniforms.rotationMatrix[1].xyz,
    uniforms.rotationMatrix[2].xyz,
  );

  let rotated = rot * scaledPos;
  output.position = uniforms.projection * vec4<f32>(rotated, 1.0);

  // Pass original position as cubemap lookup direction
  output.texCoord = input.position;

  return output;
}

@fragment
fn fragmentMain(input: VertexOutput) -> @location(0) vec4<f32> {
  let color = textureSample(cubeMapTexture, cubeMapSampler, normalize(input.texCoord));

  let morphTime = uniforms.params.y;

  // Gamma correction (sRGB encoding) for non-HDR output
  let corrected = pow(color.rgb, vec3<f32>(1.0 / 2.2));

  return vec4<f32>(corrected, morphTime);
}
