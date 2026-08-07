// SolarHalo.glsl — C12-18 screen-space solar veiling glare (WebGL half).
//
// The WGSL twin is Shaders/WebGPU/PostProcess/SolarHalo.wgsl and the JS
// reference implementation both are translated from is
// `solarScreenHaloProfile` in Scene/SolarDiscModel.js. All three bodies are
// extracted, compiled and compared by
// Tools/visual-regression/sun-halo-composition.spec.mjs — keep them in
// lockstep (SHADER_PAIRS_LOCKSTEP.md).
//
// WHY THIS EXISTS. The halo used to be baked into the sun billboard's texture,
// where a finite quad forced it to terminate at the quad's inscribed circle
// (11 solar radii). Real veiling glare never terminates: it falls as
// 1/theta^2 (the CIE stray-light form). In screen space there is no quad to
// fall off, so the same Lorentzian runs without the pedestal subtraction and
// without the support clamp.
//
// The halo is deliberately drawn OVER everything, including terrain in front
// of the Sun. Veiling glare is scattering inside the observer's eye and
// optics, which travel with the observer — it is not a scene-space volume,
// so it is not occluded by scene geometry. What DOES extinguish it is
// (a) the Sun going behind the Earth, which drops this whole stage
// (`environmentState.isSunVisible` gates SunPostProcess), (b) atmospheric
// extinction, carried in u_haloColor, and (c) an eclipse, carried in
// u_haloIntensity (CLT-C4).

uniform sampler2D colorTexture;

// Projected solar centre in drawing-buffer pixels, GL convention (y UP from
// the bottom-left) — the same space gl_FragCoord.xy is in.
uniform vec2 u_haloCenter;

// Pixels per solar radius at the current camera distance and field of view.
uniform float u_haloLimbPx;

// Half-amplitude radius of the veil, in SOLAR RADII. Derived from the C12-16
// glare core through the bake's own radius->solar-radii map, so the screen
// halo and the (former) baked halo are the same curve: 4.27800 R_sun at the
// default glowFactor = 1, i.e. 1.1397 degrees.
uniform float u_haloCoreRadii;

// Amplitude x eclipse factor. Exactly 0.0 disables the stage arithmetically
// (the add below becomes + 0.0), which is what the disabled toggle position
// and total eclipse both produce.
uniform float u_haloIntensity;

// Per-channel atmospheric transmittance along the camera->sun ray
// (C7-SUN-STARS-EXTINCTION). vec3(1.0) from orbit / atmosphere hidden.
uniform vec3 u_haloColor;

in vec2 v_textureCoordinates;

void main()
{
    vec4 color = texture(colorTexture, v_textureCoordinates);

    // Distance from the projected solar centre, in solar radii.
    float rho = length(gl_FragCoord.xy - u_haloCenter) / u_haloLimbPx;
    float t = rho / u_haloCoreRadii;
    float veil = 1.0 / (1.0 + t * t);

    // ADDITIVE, and only in rgb: veiling glare adds light to the retina, it
    // does not composite over the scene, and it must not disturb the alpha
    // the rest of the post-process chain carries.
    out_FragColor = vec4(color.rgb + u_haloColor * (veil * u_haloIntensity), color.a);
}
