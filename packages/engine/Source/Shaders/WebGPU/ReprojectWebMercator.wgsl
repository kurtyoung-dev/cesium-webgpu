// Reprojects a Web Mercator imagery texture to Geographic (equirectangular)
// projection by computing the Mercator-Y fraction per fragment and sampling
// the source at the resulting (u, srcV) coordinate.
//
// This is the WebGPU half of a shader pair; the WebGL half is
// Shaders/ReprojectWebMercator{VS,FS}.glsl. Any change here must land with the
// matching change there. See SHADER_PAIRS_LOCKSTEP.md.
//
// Uniforms, matching the GLSL `u_*` scalar uniforms one-for-one:
//   southLatitude     - south edge of the destination tile (radians)
//   northLatitude     - north edge of the destination tile (radians)
//   southMercatorY    - precomputed `0.5 * log((1+sin(south))/(1-sin(south)))`
//   oneOverMercHeight - `1.0 / (northMercatorY - southMercatorY)`
//
// Source-texture convention: on both backends the source mercator texture is
// laid out with south of the imagery at sampled v=0, reached by different
// upload paths.
//   - WebGL uses `UNPACK_FLIP_Y_WEBGL=true` on a pre-flipped ImageBitmap, so
//     GL's bottom-up texture convention double-flips it back to v=0 = south.
//   - WebGPU uses `copyExternalImageToTexture` with the default flipY=false on
//     the same pre-flipped ImageBitmap. The `imageOrientation: "flipY"` from
//     `Resource.fetchImage` is baked into the pixel data the copy consumes, so
//     v=0 = south here too. The direct-Mercator binding path (tiles with
//     `useWebMercatorT=true`) samples that same uploaded texture at the
//     per-vertex `webMercatorT`, whose v=0 is south, and renders right-side-up
//     at pixel parity with WebGL.
// Both shaders therefore sample at srcV = mercatorFraction and both write
// south content at output v=0, which is what keeps the FS math line-for-line
// identical across the pair. A vertical flip on either end warps every
// reprojected texture built from imagery that is not symmetric about the
// equator, so neither end may reintroduce one.

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

// Full-screen triangle — 3 vertices, no vertex buffer needed.
// Equivalent to the GLSL pair's 4-vertex quad + 6-index buffer; both
// rasterize the same destination viewport.
@vertex
fn vertexMain(@builtin(vertex_index) vertexIndex: u32) -> VertexOutput {
  var out: VertexOutput;
  // Positions: (-1,-1), (3,-1), (-1,3) — covers the full clip space.
  let x = f32(i32(vertexIndex & 1u) * 4 - 1);
  let y = f32(i32(vertexIndex >> 1u) * 4 - 1);
  out.position = vec4<f32>(x, y, 0.0, 1.0);
  // Map clip coords to texCoord. WebGPU's render-target origin is top-
  // left (NDC y=+1 → pixel row 0) and sampling v=0 also reads row 0, so
  // `texCoord.y` here equals the output texel's sampled V coordinate.
  // The GLSL pair forwards position.y unchanged because under OpenGL's
  // bottom-left origin + bottom-up texture storage, position.y likewise
  // equals the output texel's sampled V. Both FS bodies can therefore
  // treat texCoord.y directly as v_geo (v=0 = south).
  out.texCoord = vec2<f32>((x + 1.0) * 0.5, (1.0 - y) * 0.5);
  return out;
}

@fragment
fn fragmentMain(in: VertexOutput) -> @location(0) vec4<f32> {
  // v_geo: geographic-V fraction across the destination tile.
  //   0 = south edge, 1 = north edge. Matches the GLSL FS local `v_geo`.
  // texCoord.y equals the output texel's sampled V (see the VS comment), and
  // the downstream globe FS samples reprojected textures with v=0 = south, so
  // v_geo is texCoord.y with no flip.
  let v_geo = in.texCoord.y;

  // Per-fragment Mercator math: same closed-form expression on both
  // backends. Vendor sin/log precision varies within spec tolerance
  // (~3 ULP), which dominates the cross-vendor pixel residual at high
  // latitudes. See SHADER_PAIRS_LOCKSTEP.md "Convention ledger".
  let latitude = u.southLatitude + v_geo * (u.northLatitude - u.southLatitude);
  let sinLat = sin(latitude);
  let mercatorY = 0.5 * log((1.0 + sinLat) / (1.0 - sinLat));
  let mercatorFraction = (mercatorY - u.southMercatorY) * u.oneOverMercHeight;

  // Source v=0 holds south content on both backends (see the source-texture
  // convention above), so sampling at (u, mercatorFraction) directly matches
  // the GLSL FS line-for-line.
  let srcV = mercatorFraction;
  let sampled = textureSample(srcTexture, srcSampler, vec2<f32>(in.texCoord.x, srcV));

  // Alpha is forced to 1.0. `copyExternalImageToTexture` does not populate the
  // destination alpha channel from a non-alpha source format, so an opaque
  // JPEG arrives with alpha=0; the globe-surface FS multiplies by tex.a in its
  // effectiveAlpha chain, which would zero every reprojected-imagery composite
  // and render the tiles black. Imagery from the Mercator providers is always
  // opaque (Bing aerial JPEG, Esri WorldImagery JPEG), so the constant is safe
  // here, but supporting a transparent imagery provider means making it
  // conditional on the source format. The GLSL pair needs no equivalent: the
  // WebGL Texture upload populates alpha=255 for opaque JPEGs.
  return vec4<f32>(sampled.rgb, 1.0);
}
