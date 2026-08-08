uniform sampler2D u_texture;

// C7-SUN-STARS-EXTINCTION — per-channel atmospheric transmittance along the
// camera→sun ray. Defaults to vec3(1.0), so the multiply is a no-op (byte-
// identical) when the atmosphere is hidden or the sun is viewed from orbit.
uniform vec3 u_atmosphereExtinction;

// C12-29 S1 — continuous eclipse / occultation fade. The limb-darkened
// fraction of the solar disc the camera can still see (EclipseState.js).
// Exactly 1.0 when nothing occults the sun or `enableEclipse` is off, so
// the multiply below is a byte-identical no-op in those frames.
uniform float u_eclipseAlpha;

// C12-19 — the disc's LINEAR radiance. Exactly 1.0 whenever the scene is not
// HDR (and whenever `lighting.enableTrueSolarRadiance === false`), so the
// multiply below is `x * 1.0 === x` for every finite float — the SDR frame is
// unchanged bit-for-bit, not "visually similar". Resolved once per frame in
// Scene/SunHaloAppearance.js from the engine's OWN statement of solar
// radiance (`light.intensity * max(light.color)`, i.e. the factor by which
// `czm_lightColorHdr` exceeds `czm_lightColor`); see the C12-19 block in
// Scene/SolarDiscModel.js for why it is that number and not 10^5.
uniform float u_discRadiance;

in vec2 v_textureCoordinates;

void main()
{
    vec4 color = texture(u_texture, v_textureCoordinates);
    out_FragColor = czm_gammaCorrect(color);
    // AFTER the gamma decode, deliberately: a radiance is a LINEAR quantity,
    // and applying it before `czm_gammaCorrect` would raise it to the gamma
    // (a 2x sun would land at 2^2.2 = 4.6x). It is also applied to rgb ONLY —
    // the bake's alpha is this billboard's ALPHA_BLEND destination weight, and
    // scaling it past 1 makes `1 - a` negative, which SUBTRACTS the sky.
    // See the two premise corrections in Scene/SolarDiscModel.js.
    out_FragColor.rgb *= u_discRadiance;
    // Attenuate + redden the sun by the atmospheric extinction. Applied to
    // the (linear, when HDR) radiance so a low sun dims and warms as blue is
    // scattered out of the long slant path.
    out_FragColor.rgb *= u_atmosphereExtinction;
    // Fade the disc + glow by the visible solar fraction. ALPHA, not rgb:
    // this billboard blends with ALPHA_BLEND on WebGL and additively with
    // src-alpha on WebGPU, and an alpha-only multiply fades correctly under
    // both (invariant to the C11-115 blend flip).
    out_FragColor.a *= u_eclipseAlpha;
}
