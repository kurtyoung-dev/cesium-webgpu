// StarFieldFS.glsl — WebGL Yale Bright Star Catalog point starfield.
//
// GLSL parity port of Shaders/WebGPU/Catalog/StarField.wgsl (fragmentMain).
// The output rgb is premultiplied by the radial profile, so the additive
// blend uses srcRGB = ONE, matching the WGSL pipeline's premultiplied
// additive blend — using SOURCE_ALPHA would attenuate by the falloff
// twice and crush every star to a sub-threshold smudge.
//
// Reference: A. F. J. Moffat, "A Theoretical Investigation of Focal Stellar
// Images in the Photographic Emulsion and Application to Photographic
// Photometry", Astronomy and Astrophysics 3, 455 (1969) — the
// (1 + (r/alpha)^2)^(-beta) wing profile the halo term below evaluates.
//
// Moffat core-plus-wing glare PSF with a chroma-preserving amplitude split.
// These constants stay byte-identical to the WGSL twin
// (Shaders/WebGPU/Catalog/StarField.wgsl) under the shared-shading rule;
// Tools/visual-regression/starfield-psf.spec.mjs extracts both texts,
// compares them, and asserts the analytic shape r_1e-3 / r_core ≥ 8.
//
//   core = exp(−(r·coreScale)² / (2σ²)) — the resolved stellar image.
//     σ is relative to the base quad; multiplying r by v_coreScale (the
//     quad enlargement, 1 + sizeBoost) holds the core at a constant
//     on-screen pixel size (σ ≈ 0.60 px at 1920×1080) while the quad
//     grows, so quad growth is pure halo extent and never a bigger disc.
//   halo = (1 + (r/α)²)^(−β) — Moffat (1969) power-law wing, log-log
//     slope −2β = −4.0: the vacuum/ocular glare regime (Stiles–Holladay
//     inverse-square family; Spencer et al., SIGGRAPH '95), not the
//     ground-seeing β=4.765. α is quad-relative and deliberately not
//     coreScale-compensated, so the wing widens with the boosted quad —
//     that is the halo-extent mechanism.
//   window = smoothstep(1.0, 0.92, r) — narrow AA band at the quad edge.
//     The band has to stay narrow: one as wide as (1.0, 0.45) multiplies
//     the wing to zero across the outer 55% of the quad and makes it
//     inert. At r = 0.92 even Sirius' wing is ≈ 3e−4 — below 1/255 — so
//     the window trims nothing visible; it exists to reach exactly zero
//     at the quad edge, which is what stops the sprite reading as a
//     square (CelestiaProject/Celestia#1948).
//
// Amplitude: rgb = color·prof, where color = chroma·I from the vertex
// stage. The halo share I·K_HALO ≤ 5.87·0.08 ≈ 0.47 < 1 for the brightest
// catalogue star (I_max = EXPOSURE·10^(0.4·1.46), StarFieldMath.ts), so
// on the default LDR target the halo never clips and keeps full blackbody
// hue. Only the tight core may exceed 1.0 and clip to white — which is
// correct, saturated detector cores are white — over ≤ ~1.3 px radius at
// 1920×1080 (solve I_max·exp(−r²/(2·0.60²)) + 0.47·halo = 1 →
// r ≈ 1.2 px). Raising intensities re-widens that clip rather than
// brightening the star: under an LDR clamp it strictly widens the white
// disc. HDR and bloom are an optional enhancement rather than a
// dependency; with them on, the same core overflow feeds the bloom
// bright-pass.

in vec2 v_corner;      // [-1, 1] quad-local coordinate
in vec3 v_color;       // HDR color (already intensity-weighted in the VS)
in float v_coreScale;  // quad enlargement factor (1 + sizeBoost)

const float STAR_PSF_SIGMA = 0.12;
const float STAR_PSF_ALPHA = 0.15;
const float STAR_PSF_BETA = 2.0;
const float STAR_PSF_K_HALO = 0.08;

void main()
{
    float r = length(v_corner);
    float rCore = r * v_coreScale;
    float core = exp(-(rCore * rCore) / (2.0 * STAR_PSF_SIGMA * STAR_PSF_SIGMA));
    float haloBase = r / STAR_PSF_ALPHA;
    float halo = pow(1.0 + haloBase * haloBase, -STAR_PSF_BETA);
    float win = smoothstep(1.0, 0.92, r);
    float prof = (core + STAR_PSF_K_HALO * halo) * win;

    // Additive premultiplied output: RGB is the blackbody color already
    // weighted by linear Pogson intensity in the VS, times the PSF profile.
    vec3 rgb = v_color * prof;
    out_FragColor = vec4(rgb, prof);
}
