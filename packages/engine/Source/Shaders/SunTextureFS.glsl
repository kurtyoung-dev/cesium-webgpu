uniform float u_radiusTS;

// C12-15 — quadratic limb-darkening coefficients (a0, a1, a2) for
// I(mu) = a0 + a1*mu + a2*mu^2, mu = cos(heliocentric angle), normalised to
// I(1) = 1 at disc centre. Fed from Scene/SolarDiscModel.js so this shader
// carries NO numeric copy of the triple (the C12-15 "one constants source"
// requirement). The disabled position passes (1.0, 0.0, 0.0), which makes
// the law evaluate to exactly 1.0 everywhere and reproduces the historical
// flat `step()` disc byte-for-byte without a branch.
uniform vec3 u_limbDarkening;

// C12-16 — glare profile parameters, also fed from SolarDiscModel.js.
//   x = core radius (Lorentzian half-amplitude point)
//   y = pedestal, the raw Lorentzian's value at the outer support, so the
//       profile reaches exactly 0 there instead of leaving a hard circle
//   z = legacy edge (the historical smoothstep cutoff, 0.55)
//   w = 1.0 selects the legacy profile, 0.0 the C12-16 profile
uniform vec4 u_glareProfile;

in vec2 v_textureCoordinates;

vec2 rotate(vec2 p, vec2 direction)
{
    return vec2(p.x * direction.x - p.y * direction.y, p.x * direction.y + p.y * direction.x);
}

// C12-16 veiling-glare falloff. A Lorentzian core with a 1/radius^2 tail —
// the shape a disability-glare / stray-light PSF takes (veiling luminance
// proportional to E / theta^2) — pedestal-subtracted so it reaches exactly
// zero at the billboard's inscribed circle. The historical
// `1 - smoothstep(0.0, 0.55, radius)` reached zero at 0.55 (8.556 solar
// radii at the default glowFactor) and stayed there; this reaches zero only
// at the inscribed circle (11.0 solar radii) and decays as an inverse square
// in between. Selection is by uniform, so there is no wave divergence and
// the legacy branch is bit-for-bit the old expression.
float sunGlare(float radius)
{
    float t = radius / u_glareProfile.x;
    float raw = 1.0 / (1.0 + t * t);
    float shaped = clamp((raw - u_glareProfile.y) / (1.0 - u_glareProfile.y), 0.0, 1.0);
    float legacy = 1.0 - smoothstep(0.0, u_glareProfile.z, radius);
    return u_glareProfile.w > 0.5 ? legacy : shaped;
}

vec4 addBurst(vec2 position, vec2 direction, float lengthScalar)
{
    vec2 rotatedPosition = rotate(position, direction) * vec2(25.0, 0.75);
    float radius = length(rotatedPosition) * lengthScalar;
    // The lens-flare spikes are aperture diffraction, not veiling glare, so
    // they keep the original smoothstep envelope; C12-16 reshapes the halo
    // only. u_glareProfile.z carries the same 0.55 this literal used to.
    float burst = 1.0 - smoothstep(0.0, u_glareProfile.z, radius);
    return vec4(burst);
}

void main()
{
    float lengthScalar = 2.0 / sqrt(2.0);
    vec2 position = v_textureCoordinates - vec2(0.5);
    float radius = length(position) * lengthScalar;

    // C12-15 — limb-darkened solar disc. `surface` used to be a binary
    // `step(radius, u_radiusTS)`: a perfectly flat disc. It now carries the
    // radial intensity law, so the disc's RADIANCE falls from 1.0 at centre
    // to a0 (= 0.30) at the limb.
    //
    // HONEST LIMIT AT SDR DEFAULTS (the C12-19 seam). The alpha this bake
    // writes is `surface + 0.75 * glare + burst`, clamped to 1 at the
    // bottom of main(). Over the disc the glare term alone is ~0.73, so
    // alpha at the extreme limb is 0.30 + 0.73 = 1.03 and STILL clamps to
    // 1.0 — with the 0..1 clamp in place, limb darkening is arithmetically
    // invisible in the default bake. It is implemented at the radiance
    // level anyway so that C12-19 (removes the clamp, retunes BrightPass)
    // and C12-18 (moves the halo to the post-process chain) light it up
    // without touching the law again. NOTE FOR C12-19: the clamp count is
    // ASYMMETRIC across the pair — ONE site here (the final clamp at the
    // bottom of main()) but SIX in the WebGPU CPU twin
    // (WebGPUEnvironmentRenderer.createSunTexture: four in the half-float
    // branch, two in the 8-bit branch), and the 8-bit branch cannot carry
    // values above 1 at all. Do NOT "fix" the invisibility by
    // scaling the glare down here: that dims the entire sun on both
    // backends, and the reconciliation is exactly what C12-18/C12-19 own.
    float x = min(radius / u_radiusTS, 1.0);
    float mu = sqrt(max(0.0, 1.0 - x * x));
    float limb = u_limbDarkening.x + u_limbDarkening.y * mu + u_limbDarkening.z * mu * mu;
    float surface = step(radius, u_radiusTS) * limb;

    vec4 color = vec4(vec2(1.0), surface + 0.2, surface);

    float glow = sunGlare(radius);
    color.ba += mix(vec2(0.0), vec2(1.0), glow) * 0.75;

    vec4 burst = vec4(0.0);

    // The following loop has been manually unrolled for speed, to
    // avoid sin() and cos().
    //
    //for (float i = 0.4; i < 3.2; i += 1.047) {
    //    vec2 direction = vec2(sin(i), cos(i));
    //    burst += 0.4 * addBurst(position, direction, lengthScalar);
    //
    //    direction = vec2(sin(i - 0.08), cos(i - 0.08));
    //    burst += 0.3 * addBurst(position, direction, lengthScalar);
    //}

    burst += 0.4 * addBurst(position, vec2(0.38942,  0.92106), lengthScalar);  // angle == 0.4
    burst += 0.4 * addBurst(position, vec2(0.99235,  0.12348), lengthScalar);  // angle == 0.4 + 1.047
    burst += 0.4 * addBurst(position, vec2(0.60327, -0.79754), lengthScalar);  // angle == 0.4 + 1.047 * 2.0

    burst += 0.3 * addBurst(position, vec2(0.31457,  0.94924), lengthScalar);  // angle == 0.4 - 0.08
    burst += 0.3 * addBurst(position, vec2(0.97931,  0.20239), lengthScalar);  // angle == 0.4 + 1.047 - 0.08
    burst += 0.3 * addBurst(position, vec2(0.66507, -0.74678), lengthScalar);  // angle == 0.4 + 1.047 * 2.0 - 0.08

    // End of manual loop unrolling.

    color += clamp(burst, vec4(0.0), vec4(1.0)) * 0.15;

    out_FragColor = clamp(color, vec4(0.0), vec4(1.0));
}
