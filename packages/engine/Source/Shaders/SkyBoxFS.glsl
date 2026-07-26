// ┌─────────────────────────────────────────────────────────────────────┐
// │ PAIR: WebGL GLSL FS (this file)                                      │
// │       WebGL GLSL VS: Shaders/SkyBoxVS.glsl / CubeMapPanoramaVS.glsl  │
// │       WebGPU WGSL:   Shaders/WebGPU/CubeMapPanorama.wgsl             │
// │       (the production WGSL is the JS-embedded copy in                │
// │        Renderer/WebGPU/WebGPUCubeMapPanoramaRenderer.js; the .wgsl   │
// │        file is kept byte-equivalent for debug pages + tooling)       │
// │ Last lockstep audit: 2026-07-25, C12-29 S6                           │
// └─────────────────────────────────────────────────────────────────────┘
// Any change here MUST land with a matching change in the WGSL counterpart.
// See migration_doc/SHADER_PAIRS_LOCKSTEP.md.

uniform samplerCube u_cubeMap;

// C12-29 S6 / ruling E3 — star-brightness modulation, the WebGL half.
//   x = curve inflection      (atmosphericConditions.skyAtmosphere.starModulationCurve)
//   y = curve steepness
//   z = enable flag (0/1)     (enableStarBrightnessModulation AND the sky
//                              atmosphere actually being drawn)
//   w = cloud cover 0..1      (weather-gated; 0 unless scene.enableWeather)
// Mirrors `CubeMapPanorama.wgsl`'s `starModulation` vec4 exactly, including
// the ORDER of operations: modulate, then cloud-occlude, then gamma-correct.
// `czm_gammaCorrect` is a no-op without HDR, so on the default path this is a
// plain multiply; with HDR it must stay BEFORE the sRGB->linear decode or the
// two backends stop agreeing (WGSL applies its `hdr.x` pow last).
uniform vec4 u_starModulation;
// `frameState.skyBrightness` — the CPU sky-brightness estimate, already
// scaled by the C12-29 S2 eclipse factor, so an eclipse reveals stars through
// this one input rather than through a parallel path.
uniform float u_skyBrightness;

in vec3 v_texCoord;

void main()
{
    vec4 color = czm_textureCube(u_cubeMap, normalize(v_texCoord));

    if (u_starModulation.z > 0.5)
    {
        float t = clamp((u_skyBrightness - u_starModulation.x) * u_starModulation.y, 0.0, 1.0);
        float factor = 1.0 - smoothstep(0.0, 1.0, t);
        color.rgb *= factor;
    }
    color.rgb *= (1.0 - clamp(u_starModulation.w, 0.0, 1.0));

    out_FragColor = vec4(czm_gammaCorrect(color).rgb, czm_morphTime);
}
