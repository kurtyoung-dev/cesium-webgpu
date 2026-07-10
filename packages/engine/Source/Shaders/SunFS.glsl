uniform sampler2D u_texture;

// C7-SUN-STARS-EXTINCTION — per-channel atmospheric transmittance along the
// camera→sun ray. Defaults to vec3(1.0), so the multiply is a no-op (byte-
// identical) when the atmosphere is hidden or the sun is viewed from orbit.
uniform vec3 u_atmosphereExtinction;

in vec2 v_textureCoordinates;

void main()
{
    vec4 color = texture(u_texture, v_textureCoordinates);
    out_FragColor = czm_gammaCorrect(color);
    // Attenuate + redden the sun by the atmospheric extinction. Applied to
    // the (linear, when HDR) radiance so a low sun dims and warms as blue is
    // scattered out of the long slant path.
    out_FragColor.rgb *= u_atmosphereExtinction;
}
