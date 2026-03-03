// MipmapBlit.wgsl — Fullscreen quad blit shader for mipmap generation.
// Samples the source mip level with linear filtering and outputs to the target mip level.
// Used by WebGPUMipmapGenerator to progressively downsample textures.

@group(0) @binding(0) var srcSampler: sampler;
@group(0) @binding(1) var srcTexture: texture_2d<f32>;

struct VertexOutput {
  @builtin(position) position: vec4f,
  @location(0) texCoord: vec2f,
};

// Fullscreen triangle — 3 vertices, no vertex buffer needed.
// Vertex IDs 0,1,2 produce a triangle covering the entire [-1,1] clip space.
@vertex
fn vertexMain(@builtin(vertex_index) vertexIndex: u32) -> VertexOutput {
  var pos = array<vec2f, 3>(
    vec2f(-1.0, -1.0),
    vec2f( 3.0, -1.0),
    vec2f(-1.0,  3.0)
  );
  var uv = array<vec2f, 3>(
    vec2f(0.0, 1.0),
    vec2f(2.0, 1.0),
    vec2f(0.0, -1.0)
  );

  var output: VertexOutput;
  output.position = vec4f(pos[vertexIndex], 0.0, 1.0);
  output.texCoord = uv[vertexIndex];
  return output;
}

@fragment
fn fragmentMain(@location(0) texCoord: vec2f) -> @location(0) vec4f {
  return textureSample(srcTexture, srcSampler, texCoord);
}
