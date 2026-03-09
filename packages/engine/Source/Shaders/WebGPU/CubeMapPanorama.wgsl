// CubeMapPanorama.wgsl — WebGPU cubemap panorama shader for CesiumJS
//
// Renders a cubemap panorama (used by both SkyBox and CubeMapPanorama).
// Replaces the older SkyBox.wgsl with panorama transform support.
//
// NOTE: Does NOT need RTE precision because:
// - The box is always centered on the camera (view rotation only, no translation)
// - Positions are just direction vectors for cubemap lookup
//
// Uniform layout (208 bytes, buffer 256-aligned):
//   projection:         mat4x4<f32>  (offset 0,   64 bytes)
//   viewRotation:       mat4x4<f32>  (offset 64,  64 bytes) — camera view rotation (3x3 in 4x4)
//   panoramaTransform:  mat4x4<f32>  (offset 128, 64 bytes) — panorama orientation (identity for SkyBox)
//   params:             vec4<f32>    (offset 192, 16 bytes) — x=far, y=morphTime, z=0, w=0

struct CubeMapPanoramaUniforms {
  projection: mat4x4<f32>,
  viewRotation: mat4x4<f32>,
  panoramaTransform: mat4x4<f32>,
  params: vec4<f32>,
};

@group(0) @binding(0) var<uniform> uniforms: CubeMapPanoramaUniforms;
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

  // Extract 3x3 panorama transform from 4x4 (identity for SkyBox)
  let pt = mat3x3<f32>(
    uniforms.panoramaTransform[0].xyz,
    uniforms.panoramaTransform[1].xyz,
    uniforms.panoramaTransform[2].xyz,
  );
  let transformed = pt * scaledPos;

  // Extract 3x3 view rotation from 4x4
  let vr = mat3x3<f32>(
    uniforms.viewRotation[0].xyz,
    uniforms.viewRotation[1].xyz,
    uniforms.viewRotation[2].xyz,
  );
  let rotated = vr * transformed;

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
