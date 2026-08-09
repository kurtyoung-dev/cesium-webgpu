uniform sampler2D u_texture;

// Per-channel atmospheric transmittance along the camera-to-sun ray. Defaults
// to vec3(1.0), so the multiply is a byte-identical no-op when the atmosphere
// is hidden or the sun is viewed from orbit.
uniform vec3 u_atmosphereExtinction;

// Continuous eclipse / occultation fade: the limb-darkened fraction of the
// solar disc the camera can still see, from `Scene/EclipseState.js`. Exactly
// 1.0 when nothing occults the sun or `enableEclipse` is off, so the multiply
// below is a byte-identical no-op in those frames.
uniform float u_eclipseAlpha;

// The disc's linear radiance. Exactly 1.0 whenever the scene is not HDR, and
// whenever `lighting.enableTrueSolarRadiance === false`, so the multiply below
// is `x * 1.0 === x` for every finite float and the SDR frame is unchanged bit
// for bit rather than merely similar. Resolved once per frame in
// `Scene/SunHaloAppearance.js` from the engine's own statement of solar
// radiance, `light.intensity * max(light.color)` — the factor by which
// `czm_lightColorHdr` exceeds `czm_lightColor`.
// `SolarDiscModel.solarDiscHdrRadiance` derives it, and
// `SolarDiscModel.SOLAR_DISC_RADIANCE_CONTRAST_CEILING` shows why a radiance
// of the order of the Sun's true energy ratio would render the disc a flat
// white circle instead.
uniform float u_discRadiance;

in vec2 v_textureCoordinates;

void main()
{
    vec4 color = texture(u_texture, v_textureCoordinates);
    out_FragColor = czm_gammaCorrect(color);
    // Applied after the gamma decode: a radiance is a linear quantity, so
    // applying it before `czm_gammaCorrect` would raise it to the gamma and a
    // 2x sun would land at 2^2.2 = 4.6x. Applied to rgb only, because the
    // bake's alpha is this billboard's ALPHA_BLEND destination weight and
    // scaling it past 1 makes `1 - a` negative, which subtracts the sky.
    // `SolarDiscModel.SOLAR_DISC_SDR_RADIANCE` states both constraints.
    out_FragColor.rgb *= u_discRadiance;
    // Attenuate + redden the sun by the atmospheric extinction. Applied to
    // the (linear, when HDR) radiance so a low sun dims and warms as blue is
    // scattered out of the long slant path.
    out_FragColor.rgb *= u_atmosphereExtinction;
    // Fade the disc and glow by the visible solar fraction. Applied to alpha
    // rather than rgb: alpha is the blend weight under both `ALPHA_BLEND`,
    // `dst = src.rgb*a + dst*(1 - a)`, and an additive `src-alpha` blend, so
    // the fade stays correct whichever blend function a backend's sun pipeline
    // is built with.
    out_FragColor.a *= u_eclipseAlpha;
}
