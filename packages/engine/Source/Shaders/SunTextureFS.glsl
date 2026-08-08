// C12-18 — the bake `radius` at which the solar disc terminates. This used to
// be `0.5 / (1 + 2*glowLengthTS)` computed in Sun.js and compared against the
// CORNER-normalised `radius`, which made the disc subtend 1/sqrt(2) of the
// Sun's true angular radius (0.3767 deg of diameter instead of 0.5327 deg).
// It is now resolved by Scene/SunHaloAppearance.js; `enableTrueSolarDiscSize
// = false` passes the historical value bit-for-bit.
uniform float u_radiusTS;

// C12-18 — bake halo weight. 1.0 = the historical baked glare halo + lens-
// flare bursts. 0.0 = the post-process chain owns the halo this frame
// (`SolarHalo.glsl` on WebGL, `SolarHalo.wgsl` on WebGPU), so the bake carries
// the DISC ONLY and the two halo sources can never both be live. Derived from
// one boolean in SunHaloAppearance.js — see the invariant in its header.
uniform float u_haloGain;

// Reference: the quadratic limb-darkening law I(mu)/I(1) = a0 + a1*mu +
// a2*mu^2 is the standard two-coefficient form tabulated for stellar
// atmospheres; see A. Claret, "A new non-linear limb-darkening law for LTE
// stellar atmosphere models", Astronomy and Astrophysics 363, 1081 (2000),
// which introduces it alongside the four-coefficient law it generalises. The
// solar coefficients themselves are supplied as uniforms rather than written
// here.
//
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
    // C12-19 RESOLUTION OF THE OLD "HONEST LIMIT" NOTE HERE. That note said
    // limb darkening was arithmetically invisible because alpha
    // (`surface + 0.75*glare + burst`) clamped to 1. That was true of the
    // BAKED-HALO composition — and C12-18 retired it: at the shipped default
    // `u_haloGain` is 0, the glare and burst terms vanish exactly, and the
    // alpha this bake writes is `surface` = `limb(x)`, which never reaches
    // the clamp. So C12-18 was its own unmasking row, and over a dark sky
    // this law already composites at 255 -> 77 codes on both backends.
    // The saturation at the bottom of main() still binds on exactly one
    // channel at the default — BLUE, where `surface + 0.2 > 1` — and there
    // it is a WHITE POINT, not a radiance clamp: the `+0.2` is the hue term
    // that makes the halo orange and the core white, so removing it turns
    // the sun's core blue. C12-19 therefore delivers true radiance as an
    // explicit LINEAR scale in `SunFS.glsl` (`u_discRadiance`, applied after
    // `czm_gammaCorrect`) rather than by deleting a clamp. Do NOT "fix" any
    // remaining alpha saturation on the `u_haloGain = 1` path by removing
    // the clamp either — see the note at the bottom of main().
    float x = min(radius / u_radiusTS, 1.0);
    float mu = sqrt(max(0.0, 1.0 - x * x));
    float limb = u_limbDarkening.x + u_limbDarkening.y * mu + u_limbDarkening.z * mu * mu;
    float surface = step(radius, u_radiusTS) * limb;

    vec4 color = vec4(vec2(1.0), surface + 0.2, surface);

    // C12-18 — `u_haloGain` gates the BAKED halo. At the shipped default it is
    // 0.0 and this term vanishes exactly, leaving the disc alone in the bake;
    // the halo is drawn in screen space instead, where it can carry a genuine
    // non-terminating 1/rho^2 tail (see Scene/SolarDiscModel.js
    // `solarScreenHaloProfile`). At 1.0 the expression is bit-for-bit the
    // historical one.
    float glow = sunGlare(radius);
    color.ba += mix(vec2(0.0), vec2(1.0), glow) * (0.75 * u_haloGain);

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

    // The lens-flare bursts are part of the same instrument-response layer as
    // the halo, so they follow `u_haloGain` rather than staying behind after
    // the halo moves to the post-process chain — a disc with six spikes and no
    // surrounding glow would read as a bug.
    color += clamp(burst, vec4(0.0), vec4(1.0)) * (0.15 * u_haloGain);

    // C12-19 — the final saturation, SPLIT so that its two jobs are named and
    // separable. Componentwise this is bit-for-bit the historical
    // `clamp(color, vec4(0.0), vec4(1.0))`; nothing about the bake changes.
    // What changes is that the next reader can see WHY neither half may be
    // deleted:
    //
    //   * rgb is CHROMA — a white point, not a radiance. `+0.2` on blue is
    //     what makes the halo orange and the core white; letting blue run to
    //     1.2 gives a blue-cored sun. The disc's radiance is applied later,
    //     in LINEAR space, by `SunFS.glsl`'s `u_discRadiance` multiply.
    //
    //   * alpha is a BLEND WEIGHT. Since C11-115 both backends draw this
    //     billboard with ALPHA_BLEND, i.e. `dst = src.rgb*a + dst*(1 - a)`.
    //     An alpha above 1 makes `1 - a` NEGATIVE and subtracts the sky — a
    //     dark ring around the sun, which is the Batch-364 black-sky class.
    //     On the `u_haloGain = 1` path the legacy baked halo drives alpha to
    //     about 1.9, so the ring would be severe. This clamp is load-bearing.
    //
    // `sun-hdr-radiance.spec.mjs` REJECTS the mutant that removes either
    // half, and the WebGPU CPU twin in
    // `WebGPUEnvironmentRenderer.createSunTexture` carries the same split.
    vec3 chroma = clamp(color.rgb, vec3(0.0), vec3(1.0));
    float blendWeight = clamp(color.a, 0.0, 1.0);
    out_FragColor = vec4(chroma, blendWeight);
}
