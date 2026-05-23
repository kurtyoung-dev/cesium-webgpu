// ┌─────────────────────────────────────────────────────────────────────┐
// │ PAIR: WebGPU WGSL (this file)                                        │
// │       WebGL GLSL: Shaders/ReprojectWebMercator{VS,FS}.glsl           │
// │ Last lockstep audit: 2026-05-18, Batch 67                            │
// └─────────────────────────────────────────────────────────────────────┘
// Any change in this file MUST land with a matching change in the GLSL
// counterpart. See migration_doc/SHADER_PAIRS_LOCKSTEP.md.
//
// PURPOSE
// Reprojects a Web Mercator imagery texture to Geographic (equirectangular)
// projection by computing the Mercator-Y fraction per fragment and
// sampling the source at the resulting (u, srcV) coordinate.
//
// UNIFORMS (matches GLSL `u_*` scalar uniforms one-for-one)
//   southLatitude     - south edge of the destination tile (radians)
//   northLatitude     - north edge of the destination tile (radians)
//   southMercatorY    - precomputed `0.5 * log((1+sin(south))/(1-sin(south)))`
//   oneOverMercHeight - `1.0 / (northMercatorY - southMercatorY)`
//
// CONVENTION LEDGER (see SHADER_PAIRS_LOCKSTEP.md)
// On BOTH backends the source mercator texture is laid out with NORTH
// of the imagery at v=0 (when sampled). The two upload paths reach
// this convention by different means:
//   - WebGL uses `UNPACK_FLIP_Y_WEBGL=true` on a pre-flipped
//     ImageBitmap → double-flip → texture v=0 = NORTH.
//   - WebGPU uses `copyExternalImageToTexture` with default flipY=false
//     on the same pre-flipped ImageBitmap; the underlying ImageBitmap
//     memory still holds PNG-row-order (NORTH at row 0) because the
//     `imageOrientation: "flipY"` only changes the presentation
//     metadata, not the underlying pixel buffer. Net: texture v=0 =
//     NORTH on WebGPU too.
// Both shaders therefore sample at v=(1 - mercatorFraction) so that
// south-target (mercatorFraction=0) maps to source v=1 = SOUTH content,
// and north-target (mercatorFraction=1) maps to source v=0 = NORTH.
// This invariant is what makes the downstream globe FS see a consistent
// "v=0 = south" reprojected texture on both backends.

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
  // left (NDC y=+1 → pixel row 0), so we invert y here. The GLSL pair
  // does NOT invert because OpenGL's render-target origin is bottom-
  // left. Both result in the downstream globe FS seeing v=0 = south
  // when it samples the output reprojected texture.
  out.texCoord = vec2<f32>((x + 1.0) * 0.5, (1.0 - y) * 0.5);
  return out;
}

@fragment
fn fragmentMain(in: VertexOutput) -> @location(0) vec4<f32> {
  // v_geo: geographic-V fraction across the destination tile.
  //   0 = south edge, 1 = north edge. Matches the GLSL FS local `v_geo`.
  // The VS arithmetic above ensures this convention regardless of the
  // backend's NDC-to-pixel-row mapping.
  let v_geo = 1.0 - in.texCoord.y;

  // Per-fragment Mercator math: same closed-form expression on both
  // backends. Vendor sin/log precision varies within spec tolerance
  // (~3 ULP), which dominates the cross-vendor pixel residual at high
  // latitudes. See SHADER_PAIRS_LOCKSTEP.md "Convention ledger".
  let latitude = u.southLatitude + v_geo * (u.northLatitude - u.southLatitude);
  let sinLat = sin(latitude);
  let mercatorY = 0.5 * log((1.0 + sinLat) / (1.0 - sinLat));
  let mercatorFraction = (mercatorY - u.southMercatorY) * u.oneOverMercHeight;

  // Source v=0 holds NORTH content on both backends (see convention
  // ledger above). Flip mercatorFraction so south-target reads from
  // source v=1 (SOUTH content). Matches the GLSL FS.
  let srcV = 1.0 - mercatorFraction;
  let sampled = textureSample(srcTexture, srcSampler, vec2<f32>(in.texCoord.x, srcV));

  // Batch 56 — force alpha=1.0. The source imagery texture coming from
  // copyExternalImageToTexture on an opaque JPEG often arrives with
  // alpha=0 in WebGPU (the alpha channel isn't populated from non-alpha
  // source formats). Downstream globe-surface fragment shader multiplies
  // by tex.a in its effectiveAlpha chain, so alpha=0 made every
  // reprojected-imagery composite produce zero contribution → black
  // tiles. Source imagery from the Mercator providers is always opaque
  // (Bing aerial JPEG, Esri WorldImagery JPEG, etc.), so forcing alpha=1
  // is safe here. If/when transparent imagery providers need support,
  // this needs to be conditional on the source format/provider.
  // GLSL pair: the WebGL Texture upload populates alpha=255 for opaque
  // JPEGs, so the WebGL FS doesn't need the explicit alpha=1 — but
  // emits a vec4 implicitly via texture() that already has a=1.
  return vec4<f32>(sampled.rgb, 1.0);
}
