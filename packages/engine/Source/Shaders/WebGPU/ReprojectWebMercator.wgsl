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
// CONVENTION LEDGER (see SHADER_PAIRS_LOCKSTEP.md) — corrected 2026-07-02
// (GLOBE-POLAR-STRETCH). On BOTH backends the source mercator texture is
// laid out with SOUTH of the imagery at sampled v=0:
//   - WebGL uses `UNPACK_FLIP_Y_WEBGL=true` on a pre-flipped ImageBitmap
//     → double-flip under GL's bottom-up texture convention → v=0 = SOUTH.
//   - WebGPU uses `copyExternalImageToTexture` with default flipY=false on
//     the same pre-flipped ImageBitmap. The `imageOrientation: "flipY"`
//     from `Resource.fetchImage` IS baked into the pixel data that
//     `copyExternalImageToTexture` consumes → v=0 = SOUTH here too.
//     PROOF: the direct-Mercator binding path (tiles with
//     `useWebMercatorT=true`) samples the SAME uploaded texture at the
//     per-vertex `webMercatorT` (v=0 = south semantics) and renders
//     right-side-up at pixel parity with WebGL.
// Both shaders therefore sample at srcV = mercatorFraction, and both
// write south content at output v=0 — the FS math is line-for-line
// identical between the pair.
//
// HISTORY: until 2026-07-02 this file double-flipped (v_geo = 1-y AND
// srcV = 1-mercatorFraction) based on the false "flipY is metadata-only"
// theory. The two flips cancel ONLY for imagery tiles symmetric about
// the equator; for asymmetric tiles they produce a latitude-MIRRORED
// Mercator warp (content at geographic fraction g came from mercator
// fraction 1-mercFrac(mirror(g)) instead of mercFrac(g)), which dragged
// high-latitude imagery toward the equator at far zoom — the
// long-standing "polar stretch" of the zoomed-out WebGPU globe.

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
  // texCoord.y equals the output texel's sampled V (see VS comment), and
  // the downstream globe FS samples reprojected textures with v=0 = south,
  // so v_geo IS texCoord.y — no flip. (The pre-2026-07-02 `1.0 - y` flip
  // paired with the `1.0 - mercatorFraction` flip below to produce the
  // latitude-mirrored warp described in the header ledger.)
  let v_geo = in.texCoord.y;

  // Per-fragment Mercator math: same closed-form expression on both
  // backends. Vendor sin/log precision varies within spec tolerance
  // (~3 ULP), which dominates the cross-vendor pixel residual at high
  // latitudes. See SHADER_PAIRS_LOCKSTEP.md "Convention ledger".
  let latitude = u.southLatitude + v_geo * (u.northLatitude - u.southLatitude);
  let sinLat = sin(latitude);
  let mercatorY = 0.5 * log((1.0 + sinLat) / (1.0 - sinLat));
  let mercatorFraction = (mercatorY - u.southMercatorY) * u.oneOverMercHeight;

  // Source v=0 holds SOUTH content on both backends (see convention
  // ledger above — the pre-flipped ImageBitmap's flip IS baked into the
  // pixels `copyExternalImageToTexture` reads). Sample at
  // (u, mercatorFraction) directly, matching the GLSL FS line-for-line.
  let srcV = mercatorFraction;
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
