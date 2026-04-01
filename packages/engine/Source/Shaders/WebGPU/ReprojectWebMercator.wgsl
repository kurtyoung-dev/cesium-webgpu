/**
 * Reprojects a Web Mercator imagery texture to Geographic (equirectangular)
 * projection using a full-screen triangle render pass.
 *
 * The vertex shader emits a full-screen triangle. The fragment shader computes
 * the Web Mercator T coordinate for each output geographic T coordinate and
 * samples the source texture.
 *
 * Uniforms:
 *   southLatitude     - south edge of the tile rectangle (radians)
 *   northLatitude     - north edge of the tile rectangle (radians)
 *   southMercatorY    - Mercator Y at the south edge
 *   oneOverMercHeight - 1.0 / (northMercatorY - southMercatorY)
 */

struct ReprojectUniforms {
  southLatitude: f32,
  northLatitude: f32,
  southMercatorY: f32,
  oneOverMercHeight: f32,
};

@group(0) @binding(0) var<uniform> u: ReprojectUniforms;
@group(0) @binding(1) var srcTexture: texture_2d<f32>;
@group(0) @binding(2) var srcSampler: sampler;

struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) texCoord: vec2<f32>,
};

// Full-screen triangle — 3 vertices, no vertex buffer needed
@vertex
fn vertexMain(@builtin(vertex_index) vertexIndex: u32) -> VertexOutput {
  var out: VertexOutput;
  // Positions: (-1,-1), (3,-1), (-1,3) — covers the full clip space
  let x = f32(i32(vertexIndex & 1u) * 4 - 1);
  let y = f32(i32(vertexIndex >> 1u) * 4 - 1);
  out.position = vec4<f32>(x, y, 0.0, 1.0);
  // Map clip coords to UV: (0,1) at top-left, (1,0) at bottom-right
  // WebGPU texture origin is top-left, so V=0 is north (top), V=1 is south (bottom)
  out.texCoord = vec2<f32>((x + 1.0) * 0.5, (1.0 - y) * 0.5);
  return out;
}

@fragment
fn fragmentMain(in: VertexOutput) -> @location(0) vec4<f32> {
  let s = in.texCoord.x;
  // V=0 is north (top of texture), V=1 is south (bottom)
  // Geographic fraction: 0 at south, 1 at north
  let geographicFraction = 1.0 - in.texCoord.y;

  // Compute geographic latitude from the fraction
  let latitude = u.southLatitude + geographicFraction * (u.northLatitude - u.southLatitude);

  // Convert geographic latitude to Web Mercator Y
  let sinLat = sin(latitude);
  let mercatorY = 0.5 * log((1.0 + sinLat) / (1.0 - sinLat));

  // Normalize to 0..1 range within the source tile's Mercator extent
  let mercatorFraction = (mercatorY - u.southMercatorY) * u.oneOverMercHeight;

  // Sample the Web Mercator source texture
  // In the source texture, V=0 is north, V=1 is south, so invert
  let srcV = 1.0 - mercatorFraction;
  return textureSample(srcTexture, srcSampler, vec2<f32>(s, srcV));
}
