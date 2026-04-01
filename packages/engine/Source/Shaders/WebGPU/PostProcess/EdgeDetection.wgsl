// EdgeDetection — Detects edges in the scene for silhouette/outline effects.
// Uses luminance-based Sobel edge detection, matching CesiumJS GLSL EdgeDetection.

struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) uv: vec2<f32>,
};

struct EdgeUniforms {
  // x = 1/width, y = 1/height, z = edgeStrength, w = unused
  params: vec4<f32>,
  // x = edgeR, y = edgeG, z = edgeB, w = edgeA (edge color)
  edgeColor: vec4<f32>,
};

@group(0) @binding(0) var inputTexture: texture_2d<f32>;
@group(0) @binding(1) var inputSampler: sampler;
@group(0) @binding(2) var<uniform> uniforms: EdgeUniforms;

@vertex
fn vertexMain(@builtin(vertex_index) vertexIndex: u32) -> VertexOutput {
  var output: VertexOutput;
  let x = f32(i32(vertexIndex & 1u) * 4 - 1);
  let y = f32(i32(vertexIndex >> 1u) * 4 - 1);
  output.position = vec4<f32>(x, y, 0.0, 1.0);
  output.uv = vec2<f32>((x + 1.0) * 0.5, (1.0 - y) * 0.5);
  return output;
}

fn luminance(color: vec3<f32>) -> f32 {
  return dot(color, vec3<f32>(0.2126, 0.7152, 0.0722));
}

@fragment
fn fragmentMain(in: VertexOutput) -> @location(0) vec4<f32> {
  let ts = vec2<f32>(uniforms.params.x, uniforms.params.y);
  let strength = uniforms.params.z;

  // Sample 3x3 neighborhood luminance for Sobel operator
  let tl = luminance(textureSample(inputTexture, inputSampler, in.uv + vec2<f32>(-ts.x,  ts.y)).rgb);
  let tc = luminance(textureSample(inputTexture, inputSampler, in.uv + vec2<f32>( 0.0,   ts.y)).rgb);
  let tr = luminance(textureSample(inputTexture, inputSampler, in.uv + vec2<f32>( ts.x,  ts.y)).rgb);
  let ml = luminance(textureSample(inputTexture, inputSampler, in.uv + vec2<f32>(-ts.x,  0.0)).rgb);
  let mr = luminance(textureSample(inputTexture, inputSampler, in.uv + vec2<f32>( ts.x,  0.0)).rgb);
  let bl = luminance(textureSample(inputTexture, inputSampler, in.uv + vec2<f32>(-ts.x, -ts.y)).rgb);
  let bc = luminance(textureSample(inputTexture, inputSampler, in.uv + vec2<f32>( 0.0,  -ts.y)).rgb);
  let br = luminance(textureSample(inputTexture, inputSampler, in.uv + vec2<f32>( ts.x, -ts.y)).rgb);

  // Sobel horizontal and vertical
  let gx = (tl + 2.0 * ml + bl) - (tr + 2.0 * mr + br);
  let gy = (tl + 2.0 * tc + tr) - (bl + 2.0 * bc + br);
  let edge = sqrt(gx * gx + gy * gy);

  // Output edge intensity as alpha for compositing
  let edgeAmount = clamp(edge * strength, 0.0, 1.0);

  return vec4<f32>(uniforms.edgeColor.rgb, edgeAmount);
}
