// ┌─────────────────────────────────────────────────────────────────────┐
// │ PAIR: WebGL GLSL FS (this file)                                      │
// │       WebGL GLSL VS: Shaders/ReprojectWebMercatorVS.glsl             │
// │       WebGPU WGSL: Shaders/WebGPU/ReprojectWebMercator.wgsl          │
// │ Last lockstep audit: 2026-05-18, Batch 67                            │
// └─────────────────────────────────────────────────────────────────────┘
// Any change in this file MUST land with a matching change in the WGSL
// counterpart. See migration_doc/SHADER_PAIRS_LOCKSTEP.md.
//
// PURPOSE
// Reprojects a Web Mercator imagery texture to Geographic (equirectangular)
// projection by computing the Mercator-Y fraction per fragment and
// sampling the source at the resulting (u, srcV) coordinate.
//
// UNIFORMS (matches WGSL `u.*` struct members one-for-one)
//   u_southLatitude         - south edge of the destination tile (radians)
//   u_northLatitude         - north edge of the destination tile (radians)
//   u_southMercatorY        - precomputed `0.5 * log((1+sin(south))/(1-sin(south)))`
//   u_oneOverMercatorHeight - `1.0 / (northMercatorY - southMercatorY)`
//
// CONVENTION LEDGER (see SHADER_PAIRS_LOCKSTEP.md)
// The two backends have OPPOSITE source-texture V conventions, despite
// both consuming the same Cesium pre-flipped ImageBitmap source:
//   - WebGL applies `UNPACK_FLIP_Y_WEBGL=true` at upload (Texture
//     constructor default). Combined with the bottom-up OpenGL texture
//     storage convention, source v=0 lands at SOUTH of the imagery.
//   - WebGPU applies no flip at upload (`copyExternalImageToTexture`
//     default), and `imageOrientation:"flipY"` from createImageBitmap
//     does NOT actually flip the underlying pixel buffer (it only
//     changes presentation metadata, which copyExternalImageToTexture
//     ignores). Combined with the top-down WebGPU pixel-row convention,
//     source v=0 lands at NORTH of the imagery.
// The downstream sampling in each FS therefore differs:
//   - GLSL (this file): samples at (u, mercatorFraction) directly.
//     south-target (mercatorFraction=0) → source v=0 = SOUTH content.
//   - WGSL: samples at (u, 1 - mercatorFraction). south-target
//     (mercatorFraction=0) → source v=1 = SOUTH content.
// Both produce reprojected output textures whose downstream globe FS
// sees v=0 = south. The shaders LOOK different at the final sample
// line because the upload pipeline is different — this single
// asymmetry is documented here and ledgered, and it's the ONLY
// algorithmic divergence between the pair.

uniform sampler2D u_texture;
uniform float u_southLatitude;
uniform float u_northLatitude;
uniform float u_southMercatorY;
uniform float u_oneOverMercatorHeight;

in vec2 v_textureCoordinates;

void main()
{
    // v_geo: geographic-V fraction across the destination tile.
    //   0 = south edge, 1 = north edge. Matches the WGSL FS local `v_geo`.
    // The VS forwards `position.xy` directly here (no flip) because
    // OpenGL's render-target origin is bottom-left, so position.y=0
    // already lands at the south edge of the framebuffer. The WGSL
    // counterpart inverts y in its VS to land at the same convention
    // under WebGPU's top-left render-target origin.
    float v_geo = v_textureCoordinates.y;

    // Per-fragment Mercator math: same closed-form expression on both
    // backends. Vendor sin/log precision varies within spec tolerance
    // (~3 ULP), which dominates the cross-vendor pixel residual at high
    // latitudes. See SHADER_PAIRS_LOCKSTEP.md "Convention ledger".
    float latitude = u_southLatitude + v_geo * (u_northLatitude - u_southLatitude);
    float sinLat = sin(latitude);
    float mercatorY = 0.5 * log((1.0 + sinLat) / (1.0 - sinLat));
    float mercatorFraction = (mercatorY - u_southMercatorY) * u_oneOverMercatorHeight;

    // Source v=0 holds SOUTH content on WebGL (see convention ledger
    // above). Sample at (u, mercatorFraction) so south-target reads from
    // source v=0 = SOUTH. WGSL counterpart computes `srcV = 1 -
    // mercatorFraction` instead because its source v=0 = NORTH.
    float srcV = mercatorFraction;
    out_FragColor = texture(u_texture, vec2(v_textureCoordinates.x, srcV));
}
