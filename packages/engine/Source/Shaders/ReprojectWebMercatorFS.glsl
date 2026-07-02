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
// CONVENTION LEDGER (see SHADER_PAIRS_LOCKSTEP.md) — corrected 2026-07-02
// (GLOBE-POLAR-STRETCH). The two backends share the SAME source-texture V
// convention (sampled v=0 = SOUTH of the imagery), reached by different
// upload paths:
//   - WebGL applies `UNPACK_FLIP_Y_WEBGL=true` at upload (Texture
//     constructor default) to a pre-flipped ImageBitmap; combined with
//     the bottom-up OpenGL texture storage convention, source v=0 lands
//     at SOUTH of the imagery.
//   - WebGPU applies no flip at upload (`copyExternalImageToTexture`
//     default) to the same pre-flipped ImageBitmap; the
//     `imageOrientation:"flipY"` IS baked into the pixels the copy
//     consumes, so source v=0 lands at SOUTH there too (proven by the
//     direct-Mercator-texture binding path rendering right-side-up).
// Both FS bodies therefore sample at (u, mercatorFraction) directly and
// are line-for-line identical. (Until 2026-07-02 the WGSL pair carried a
// spurious double-flip based on a "flipY is metadata-only" theory; the
// flips cancel only for equator-symmetric imagery tiles and produced the
// far-zoom polar-stretch warp on asymmetric tiles.)

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

    // Source v=0 holds SOUTH content on BOTH backends (see convention
    // ledger above). Sample at (u, mercatorFraction) so south-target
    // reads from source v=0 = SOUTH. The WGSL counterpart is identical.
    float srcV = mercatorFraction;
    out_FragColor = texture(u_texture, vec2(v_textureCoordinates.x, srcV));
}
