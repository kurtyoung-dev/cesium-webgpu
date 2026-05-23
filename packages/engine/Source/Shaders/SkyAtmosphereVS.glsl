// ┌─────────────────────────────────────────────────────────────────────┐
// │ PAIR: WebGL GLSL VS (this file)                                       │
// │       WebGL GLSL FS: Shaders/SkyAtmosphereFS.glsl                    │
// │       WebGL GLSL helpers: Shaders/SkyAtmosphereCommon.glsl           │
// │       WebGPU WGSL: Shaders/WebGPU/Environment/SkyAtmosphere.wgsl     │
// │       (single file containing @vertex + @fragment + helpers)         │
// │ Last lockstep audit: 2026-05-19, Batch 76                            │
// └─────────────────────────────────────────────────────────────────────┘
// Any change in this file MUST land with a matching change in the WGSL
// counterpart. See migration_doc/SHADER_PAIRS_LOCKSTEP.md.
//
// Structural divergence summary (full ledger in the WGSL counterpart):
// - GLSL splits VS+FS+Common; WGSL is one module.
// - GLSL has `#ifdef PER_FRAGMENT_ATMOSPHERE` per-vertex vs per-fragment
//   branch; WGSL is always per-fragment (`v_mieColor` / `v_rayleighColor`
//   varyings are absent from VertexOutput).
// - GLSL uses `czm_model * position` (no RTE); WGSL uses
//   `mvpRelativeToEye × translateRelativeToEye(positionHigh, positionLow,
//   encodedCameraHigh, encodedCameraLow)`. Atmosphere shell mesh is
//   centered at the planet origin so RTE is not strictly required, but
//   WGSL uses it uniformly for consistency across shaders.

in vec4 position;

out vec3 v_outerPositionWC;

#ifndef PER_FRAGMENT_ATMOSPHERE
out vec3 v_mieColor;
out vec3 v_rayleighColor;
out float v_opacity;
out float v_translucent;
#endif

void main(void)
{
    vec4 positionWC = czm_model * position;
    float lightEnum = u_radiiAndDynamicAtmosphereColor.z;
    vec3 lightDirection = czm_getDynamicAtmosphereLightDirection(positionWC.xyz, lightEnum);

    #ifndef PER_FRAGMENT_ATMOSPHERE
        computeAtmosphereScattering(
            positionWC.xyz,
            lightDirection,
            v_rayleighColor,
            v_mieColor,
            v_opacity,
            v_translucent
        );
    #endif

    v_outerPositionWC = positionWC.xyz;
    vec4 positionEC = czm_modelView * position;
    gl_Position = czm_projection * positionEC;
}
