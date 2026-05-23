// ┌─────────────────────────────────────────────────────────────────────┐
// │ PAIR: WebGL GLSL VS (this file)                                      │
// │       WebGL GLSL FS: Shaders/ReprojectWebMercatorFS.glsl             │
// │       WebGPU WGSL: Shaders/WebGPU/ReprojectWebMercator.wgsl          │
// │ Last lockstep audit: 2026-05-18, Batch 67                            │
// └─────────────────────────────────────────────────────────────────────┘
// Any change in this file MUST land with a matching change in the WGSL
// counterpart's `vertexMain` function. See
// migration_doc/SHADER_PAIRS_LOCKSTEP.md.
//
// PURPOSE
// 4-vertex quad (2 triangles, 6 indices) that fills the destination
// reprojection viewport. Sets `v_textureCoordinates = position.xy` so
// the FS receives a (u, v_geo) coordinate in [0, 1]² across the output
// tile, where v_geo=0 = south and v_geo=1 = north. The FS computes
// Mercator-Y per-fragment and samples the source mercator texture.
//
// CONVENTION LEDGER (see SHADER_PAIRS_LOCKSTEP.md)
// The WGSL counterpart is a full-screen triangle (3 vertices, no vertex
// buffer needed) because WebGPU's pipeline API is more permissive
// about empty vertex layouts. Both rasterize the same destination
// viewport. The WGSL VS computes `texCoord = ((x+1)/2, (1-y)/2)` to
// invert clip y, matching the GLSL VS's `position.y` forwarding under
// OpenGL's bottom-left render-target origin. See the WGSL file for the
// matching VS code path.

in vec4 position;

uniform vec2 u_textureDimensions;

out vec2 v_textureCoordinates;

void main()
{
    // position.xy is in [0, 1] across the destination tile. position.y=0
    // is the SOUTH edge (lower-left of the destination tile in OpenGL's
    // bottom-left framebuffer origin). The FS reads `position.y` as the
    // linear geographic-V fraction (`v_geo`) and computes Mercator-Y
    // per fragment (Batch 66, lockstep with WGSL).
    v_textureCoordinates = position.xy;
    gl_Position = czm_viewportOrthographic * (position * vec4(u_textureDimensions, 1.0, 1.0));
}
