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

// C12-27 — angular solar-glare star washout, the WebGL half.
//   u_solarGlare.xyz  = Sun direction in THIS shader's cube-map lookup frame
//                       (TEME for SkyBox, whose VS applies czm_temeToPseudoFixed)
//   u_solarGlare.w    = washout strength; EXACTLY 0 for generic panoramas and
//                       for the disabled toggle, which skips the whole block
//   u_solarGlareCurve = (angular core rad, pedestal, support rad, reserved)
// Mirrors `CubeMapPanorama.wgsl`'s `solarGlare` / `solarGlareCurve` exactly,
// including the ORDER: modulate, cloud-occlude, GLARE, then gamma-correct.
// Resolved once per frame on the CPU by `Scene/SolarGlareAppearance.js`; the
// curve numbers arrive as uniforms so this file carries no numeric copy.
uniform vec4 u_solarGlare;
uniform vec4 u_solarGlareCurve;

in vec3 v_texCoord;

// C12-27 — veiling-glare weight as a function of angular separation from the
// Sun. Character-identical to `solarGlareVeil` in
// `Shaders/WebGPU/CubeMapPanorama.wgsl`,
// `Shaders/WebGPU/Catalog/StarField.wgsl` and `Shaders/StarFieldVS.glsl`, and a
// line-for-line translation of `angularGlareVeil` in
// `Scene/SolarDiscModel.js`; `Tools/visual-regression/solar-glare-star-washout.spec.mjs`
// extracts all four texts, compiles each body as JavaScript, and requires them
// to agree with the JS reference to 1e-15.
//
//   raw(theta)  = 1 / (1 + (theta/core)^2)      -> ~ 1/theta^2 far field
//   veil(theta) = (raw - pedestal) / (1 - pedestal), clamped to [0, 1]
//
// The `1/theta^2` tail is the Stiles-Holladay / CIE disability-glare form. The
// pedestal subtraction makes the veil reach EXACTLY 0 at the support angle
// (90 deg), and the `cosSeparation <= 0.0` early-out is the same half-space,
// so a direction at or beyond 90 deg from the Sun is multiplied by exactly 1.0
// — byte-identical to the no-Sun frame, the C12-27 acceptance criterion.
float solarGlareVeil(float cosSeparation, float core, float pedestal, float support)
{
    if (cosSeparation <= 0.0) { return 0.0; }
    float theta = acos(min(cosSeparation, 1.0));
    if (theta >= support) { return 0.0; }
    float t = theta / core;
    float raw = 1.0 / (1.0 + t * t);
    float v = (raw - pedestal) / (1.0 - pedestal);
    return clamp(v, 0.0, 1.0);
}

void main()
{
    vec3 dir = normalize(v_texCoord);
    vec4 color = czm_textureCube(u_cubeMap, dir);

    if (u_starModulation.z > 0.5)
    {
        float t = clamp((u_skyBrightness - u_starModulation.x) * u_starModulation.y, 0.0, 1.0);
        float factor = 1.0 - smoothstep(0.0, 1.0, t);
        color.rgb *= factor;
    }
    color.rgb *= (1.0 - clamp(u_starModulation.w, 0.0, 1.0));

    if (u_solarGlare.w > 0.0)
    {
        float veil = solarGlareVeil(
            dot(dir, u_solarGlare.xyz),
            u_solarGlareCurve.x,
            u_solarGlareCurve.y,
            u_solarGlareCurve.z
        );
        color.rgb *= (1.0 - u_solarGlare.w * veil);
    }

    out_FragColor = vec4(czm_gammaCorrect(color).rgb, czm_morphTime);
}
