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

in vec2 v_textureCoordinates;

void main()
{
    vec4 color = texture(u_texture, v_textureCoordinates);
    out_FragColor = czm_gammaCorrect(color);
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
