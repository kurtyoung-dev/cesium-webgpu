// 4-vertex quad (2 triangles, 6 indices) that fills the destination
// reprojection viewport. Sets `v_textureCoordinates = position.xy` so the FS
// receives a (u, v_geo) coordinate in [0, 1]² across the output tile, where
// v_geo=0 is south and v_geo=1 is north. The FS computes Mercator-Y per
// fragment and samples the source mercator texture.
//
// This is the WebGL vertex half of a shader trio; the fragment half is
// Shaders/ReprojectWebMercatorFS.glsl and the WebGPU half is
// Shaders/WebGPU/ReprojectWebMercator.wgsl. Any change here must land with the
// matching change in that file's `vertexMain`. See SHADER_PAIRS_LOCKSTEP.md.
//
// The WGSL counterpart is a full-screen triangle (3 vertices, no vertex buffer
// needed) because WebGPU's pipeline API is more permissive about empty vertex
// layouts; both rasterize the same destination viewport. It computes
// `texCoord = ((x+1)/2, (1-y)/2)` to invert clip y, which lands on the same
// convention as this shader's plain `position.y` forwarding under OpenGL's
// bottom-left render-target origin.

in vec4 position;

uniform vec2 u_textureDimensions;

out vec2 v_textureCoordinates;

void main()
{
    // position.xy is in [0, 1] across the destination tile, with position.y=0
    // at the south edge — the lower-left of the destination tile under
    // OpenGL's bottom-left framebuffer origin. The FS reads `position.y` as
    // the linear geographic-V fraction (`v_geo`) and computes Mercator-Y per
    // fragment, as the WGSL counterpart does.
    v_textureCoordinates = position.xy;
    gl_Position = czm_viewportOrthographic * (position * vec4(u_textureDimensions, 1.0, 1.0));
}
