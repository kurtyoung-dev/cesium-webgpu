// StarFieldFS.glsl — WebGL Yale Bright Star Catalog point starfield.
//
// GLSL parity port of Shaders/WebGPU/Catalog/StarField.wgsl (fragmentMain).
// The output rgb is PREMULTIPLIED by the radial profile (so the additive
// blend uses srcRGB = ONE, matching the WGSL pipeline's premultiplied
// additive blend — using SOURCE_ALPHA would attenuate by the falloff
// twice and crush every star to a sub-threshold smudge).
//
// Reference: A. F. J. Moffat, "A Theoretical Investigation of Focal Stellar
// Images in the Photographic Emulsion and Application to Photographic
// Photometry", Astronomy and Astrophysics 3, 455 (1969) — the
// (1 + (r/alpha)^2)^(-beta) wing profile the halo term below evaluates.
//
// C12-05/06/07 — Moffat core+wing glare PSF, chroma-preserving amplitude
// split. These constants MUST stay byte-identical to the WGSL twin
// (Shaders/WebGPU/Catalog/StarField.wgsl) — Principle 5 shared shading;
// the Node spec Tools/visual-regression/starfield-psf.spec.mjs extracts
// and compares them, and also asserts the analytic G2 shape
// (r_1e-3/r_core ≥ 8 vs < 2 for the old truncated Gaussian).
//
//   core = exp(−(r·coreScale)² / (2σ²)) — the resolved stellar image.
//     σ is BASE-quad-relative; multiplying r by v_coreScale (the C12-06
//     quad enlargement, 1 + sizeBoost) keeps the core at a constant
//     on-screen pixel size (σ ≈ 0.60 px at 1920×1080) while the quad
//     grows, so quad growth is pure halo extent — never a bigger disc.
//   halo = (1 + (r/α)²)^(−β) — Moffat (1969) power-law wing, log-log
//     slope −2β = −4.0: the vacuum/ocular glare regime (Stiles–Holladay
//     inverse-square family; Spencer et al., SIGGRAPH '95), NOT the
//     ground-seeing β=4.765. α is quad-relative and deliberately NOT
//     coreScale-compensated: the wing widens with the boosted quad —
//     that IS the C12-06 halo-extent mechanism.
//   window = smoothstep(1.0, 0.92, r) — narrow AA band at the quad edge
//     (moved from 0.45: the old wide fade would multiply the wing to
//     zero across the outer 55% of the quad and make it inert). At
//     r = 0.92 even Sirius' wing is ≈ 3e−4 — below 1/255 — so the
//     window trims nothing visible; it exists to reach exactly zero at
//     the quad edge (no square sprites, the Celestia failure mode).
//
// Amplitude (C12-07): rgb = color·prof, where color = chroma·I from the
// VS. The halo share I·K_HALO ≤ 5.87·0.08 ≈ 0.47 < 1 for the brightest
// catalogue star (I_max = EXPOSURE·10^(0.4·1.46), StarFieldMath.ts), so
// on the DEFAULT LDR target the halo NEVER clips and keeps full
// blackbody hue. Only the tight core may exceed 1.0 and clip to white —
// correct, saturated detector cores ARE white — over ≤ ~1.3 px radius
// at 1920×1080 (solve I_max·exp(−r²/(2·0.60²)) + 0.47·halo = 1 →
// r ≈ 1.2 px). Do NOT re-widen the clip by raising intensities: under
// an LDR clamp that strictly widens the white disc. No HDR/bloom
// dependency; with HDR+bloom on, the same core overflow feeds the
// bright-pass.

in vec2 v_corner;      // [-1, 1] quad-local coordinate
in vec3 v_color;       // HDR color (already intensity-weighted in the VS)
in float v_coreScale;  // C12-06 quad enlargement factor (1 + sizeBoost)

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
