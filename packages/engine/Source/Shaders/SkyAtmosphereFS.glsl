// ┌─────────────────────────────────────────────────────────────────────┐
// │ PAIR: WebGL GLSL FS (this file)                                       │
// │       WebGL GLSL VS: Shaders/SkyAtmosphereVS.glsl                    │
// │       WebGL GLSL helpers: Shaders/SkyAtmosphereCommon.glsl           │
// │       WebGPU WGSL: Shaders/WebGPU/Environment/SkyAtmosphere.wgsl     │
// │       (single file containing @vertex + @fragment + helpers)         │
// │ Last lockstep audit: 2026-05-19, Batch 76                            │
// └─────────────────────────────────────────────────────────────────────┘
// Any change in this file MUST land with a matching change in the WGSL
// counterpart. See migration_doc/SHADER_PAIRS_LOCKSTEP.md.
//
// Structural divergence summary (full ledger in the WGSL counterpart):
// - 16-step adaptive ray-march (`rayStepLengthIncrease` in
//   AtmosphereCommon.glsl) vs WGSL's 64-step uniform-stride ray-march.
//   Same visual result.
// - GLSL has `#ifdef PER_FRAGMENT_ATMOSPHERE` branch that selects
//   between vertex-interpolated colors and per-fragment evaluation.
//   WGSL is always per-fragment.
// - GLSL has NO LUT fast-path; WGSL has a `useLut > 0.5` branch that
//   replaces the ray-march with a single inscatter LUT sample
//   (WebGL2 has no compute shaders, so no LUT bake exists).
// - GLSL has NO dual-light (sun+moon) scattering; WGSL adds moon
//   inscatter contribution scaled by phase × intensity.
// - GLSL has NO debug magenta bypass; WGSL has Tier 1 debug at
//   `u.debug.x > 0.5`.
// - Tonemap chain: GLSL gates `czm_pbrNeutralTonemapping` +
//   `czm_inverseGamma` on `#ifndef HDR` and HSB shift on `#ifdef
//   COLOR_CORRECT`. WGSL always applies the tonemap + sRGB encode and
//   gates HSB shift on |hsbShift| > 0.001 (HDR is handled via the
//   WebGPU post-process pipeline, not the sky shader).
// - GLSL has a `#ifdef GLOBE_TRANSLUCENT` brightening path in
//   SkyAtmosphereCommon; WGSL has none yet (translucent globe not
//   wired through WebGPU pipeline).

in vec3 v_outerPositionWC;

uniform vec3 u_hsbShift;

#ifndef PER_FRAGMENT_ATMOSPHERE
in vec3 v_mieColor;
in vec3 v_rayleighColor;
in float v_opacity;
in float v_translucent;
#endif

void main (void)
{
    float lightEnum = u_radiiAndDynamicAtmosphereColor.z;
    vec3 lightDirection = czm_getDynamicAtmosphereLightDirection(v_outerPositionWC, lightEnum);

    vec3 mieColor;
    vec3 rayleighColor;
    float opacity;
    float translucent;

    #ifdef PER_FRAGMENT_ATMOSPHERE
        computeAtmosphereScattering(
            v_outerPositionWC,
            lightDirection,
            rayleighColor,
            mieColor,
            opacity,
            translucent
        );
    #else
        mieColor = v_mieColor;
        rayleighColor = v_rayleighColor;
        opacity = v_opacity;
        translucent = v_translucent;
    #endif

    vec4 color = computeAtmosphereColor(v_outerPositionWC, lightDirection, rayleighColor, mieColor, opacity);

    #ifndef HDR
        color.rgb = czm_pbrNeutralTonemapping(color.rgb);
        color.rgb = czm_inverseGamma(color.rgb);
    #endif

    #ifdef COLOR_CORRECT
        const bool ignoreBlackPixels = true;
        color.rgb = czm_applyHSBShift(color.rgb, u_hsbShift, ignoreBlackPixels);
    #endif

    // For the parts of the sky atmosphere that are not behind a translucent globe,
    // we mix in the default opacity so that the sky atmosphere still appears at distance.
    // This is needed because the opacity in the sky atmosphere is initially adjusted based
    // on the camera height.
    if (translucent == 0.0) {
        color.a = mix(color.b, 1.0, color.a) * smoothstep(0.0, 1.0, czm_morphTime);
    }

    out_FragColor = color;
}
