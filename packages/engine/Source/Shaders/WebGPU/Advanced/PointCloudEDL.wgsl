// Point Cloud Eye-Dome Lighting (EDL) shader for WebGPU
// Applies eye-dome lighting as a post-process to point cloud rendering.
// EDL enhances depth perception by darkening edges based on depth discontinuities.
// Reference: "Eye-Dome Lighting: A Non-Photorealistic Shading Technique" (Boucheny, 2009)

struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) uv: vec2<f32>,
};

struct EDLUniforms {
  texelSize: vec2<f32>,   // 1.0 / textureSize
  strength: f32,          // EDL strength (typically 1.0-5.0)
  radius: f32,            // Sample radius in pixels (typically 1.0-3.0)
  nearPlane: f32,
  farPlane: f32,
  _pad0: f32,
  _pad1: f32,
};

@group(0) @binding(0) var colorTexture: texture_2d<f32>;
@group(0) @binding(1) var depthTexture: texture_2d<f32>;
@group(0) @binding(2) var edlSampler: sampler;
@group(0) @binding(3) var<uniform> params: EDLUniforms;

@vertex
fn vertexMain(@builtin(vertex_index) vertexIndex: u32) -> VertexOutput {
  var output: VertexOutput;
  let x = f32(i32(vertexIndex & 1u) * 4 - 1);
  let y = f32(i32(vertexIndex >> 1u) * 4 - 1);
  output.position = vec4<f32>(x, y, 0.0, 1.0);
  output.uv = vec2<f32>((x + 1.0) * 0.5, (1.0 - y) * 0.5);
  return output;
}

// Convert depth buffer value to linear eye-space depth
fn linearizeDepth(depth: f32) -> f32 {
  let near = params.nearPlane;
  let far = params.farPlane;
  // WebGPU depth range is [0, 1]
  return near * far / (far - depth * (far - near));
}

// Compute log2 of the linear depth for EDL
fn logDepth(uv: vec2<f32>) -> f32 {
  let depth = textureSample(depthTexture, edlSampler, uv).r;
  if (depth >= 1.0) {
    return 0.0; // Background
  }
  let linear = linearizeDepth(depth);
  return log2(max(linear, 0.001));
}

@fragment
fn fragmentMain(input: VertexOutput) -> @location(0) vec4<f32> {
  let color = textureSample(colorTexture, edlSampler, input.uv);
  let centerDepth = textureSample(depthTexture, edlSampler, input.uv).r;

  // Skip background pixels
  if (centerDepth >= 1.0) {
    return color;
  }

  let centerLogDepth = logDepth(input.uv);

  // 8-neighbor EDL sampling pattern
  let offsets = array<vec2<f32>, 8>(
    vec2<f32>(-1.0,  0.0),
    vec2<f32>( 1.0,  0.0),
    vec2<f32>( 0.0, -1.0),
    vec2<f32>( 0.0,  1.0),
    vec2<f32>(-1.0, -1.0),
    vec2<f32>( 1.0, -1.0),
    vec2<f32>(-1.0,  1.0),
    vec2<f32>( 1.0,  1.0),
  );

  var response: f32 = 0.0;
  for (var i = 0u; i < 8u; i = i + 1u) {
    let sampleUV = input.uv + offsets[i] * params.texelSize * params.radius;
    let neighborLogDepth = logDepth(sampleUV);
    // EDL response: max(0, centerLogDepth - neighborLogDepth)
    response = response + max(0.0, centerLogDepth - neighborLogDepth);
  }

  // Average the response over 8 neighbors
  response = response / 8.0;

  // Apply EDL shading: darken based on depth discontinuity
  let shade = exp(-response * 300.0 * params.strength);

  return vec4<f32>(color.rgb * shade, color.a);
}
