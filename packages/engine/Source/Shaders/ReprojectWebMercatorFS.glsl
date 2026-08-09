// Reprojects a Web Mercator imagery texture to Geographic (equirectangular)
// projection by computing the Mercator-Y fraction per fragment and sampling
// the source at the resulting (u, srcV) coordinate.
//
// This is the WebGL fragment half of a shader trio; the vertex half is
// Shaders/ReprojectWebMercatorVS.glsl and the WebGPU half is
// Shaders/WebGPU/ReprojectWebMercator.wgsl. Any change here must land with the
// matching change there. See SHADER_PAIRS_LOCKSTEP.md.
//
// Uniforms, matching the WGSL `u.*` struct members one-for-one:
//   u_southLatitude         - south edge of the destination tile (radians)
//   u_northLatitude         - north edge of the destination tile (radians)
//   u_southMercatorY        - precomputed `0.5 * log((1+sin(south))/(1-sin(south)))`
//   u_oneOverMercatorHeight - `1.0 / (northMercatorY - southMercatorY)`
//
// Source-texture convention: both backends sample with v=0 at south of the
// imagery, reached by different upload paths.
//   - WebGL applies `UNPACK_FLIP_Y_WEBGL=true` at upload (the Texture
//     constructor default) to a pre-flipped ImageBitmap; combined with the
//     bottom-up OpenGL texture storage convention, source v=0 lands at south.
//   - WebGPU applies no flip at upload (the `copyExternalImageToTexture`
//     default) to the same pre-flipped ImageBitmap; the
//     `imageOrientation:"flipY"` is baked into the pixels the copy consumes,
//     so source v=0 lands at south there too — which is why the
//     direct-Mercator-texture binding path renders right-side-up.
// Both FS bodies therefore sample at (u, mercatorFraction) directly and are
// line-for-line identical. A vertical flip on either end warps every
// reprojected texture built from imagery that is not symmetric about the
// equator, so neither end may reintroduce one.

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

    // Per-fragment Mercator math: the same closed-form expression on both
    // backends. Vendor sin/log precision varies within spec tolerance
    // (~3 ULP), which dominates the cross-vendor pixel residual at high
    // latitudes. See SHADER_PAIRS_LOCKSTEP.md "Convention ledger".
    float latitude = u_southLatitude + v_geo * (u_northLatitude - u_southLatitude);
    float sinLat = sin(latitude);
    float mercatorY = 0.5 * log((1.0 + sinLat) / (1.0 - sinLat));
    float mercatorFraction = (mercatorY - u_southMercatorY) * u_oneOverMercatorHeight;

    // Source v=0 holds south content on both backends (see the source-texture
    // convention above), so sampling at (u, mercatorFraction) makes the
    // south-most target row read source v=0. The WGSL counterpart is identical.
    float srcV = mercatorFraction;
    out_FragColor = texture(u_texture, vec2(v_textureCoordinates.x, srcV));
}
