// C13-41 (the C12-29 S3 rider) — how the cloud + environment-map subsystem
// responds to a solar eclipse.
//
// WHAT WAS MISSING. C12-29 S2 published ONE backend-neutral scalar,
// `frameState.eclipseSceneLightFactor`, and wired it into every SUN-DRIVEN
// scene light it owned: the scene light colour (`UniformState`), the sky
// atmosphere shell on both backends, the globe's ground atmosphere and fog
// (through the single `tileProvider.atmosphereLightIntensity` mirror), and
// `frameState.skyBrightness`. Its own research note recorded "clouds + IBL" as
// C13-owned and left them out. At HEAD that omission was total:
//
//   - the volumetric cloud deck's direct term is `(msLight + silverLining) *
//     cloud.sunIntensity`, and `sunIntensity` is packed straight from
//     `config.atmosphereLightIntensity` — the globe's UNDIMMED user field, not
//     the per-frame dimmed `tileProvider` mirror;
//   - the deck's ambient term is `mix(groundAmbientColor, skyAmbientColor, h) *
//     cloud.ambientIntensity`, and those two colours are HARD-CODED constants.
//     They track no scene light at all, so nothing else in the engine could
//     ever have dimmed them;
//   - the cloud beer-shadow strength is a literal `1.0` at all four consumer
//     sites;
//   - the dynamic environment map's radiance bake reads the user's
//     `atmosphereScatteringIntensity` with no eclipse term on EITHER backend.
//
// So at totality the world, the sky and the ground all fell to the ~5-lux
// twilight floor while the cloud deck and every IBL-lit model stayed at full
// midday brightness. That is precisely the cross-backend / default-ON
// multiplier failure class the C12 exit gate names, except here it was
// cross-SUBSYSTEM within one backend.
//
// TWO DERIVED SCALARS, BOTH FROM THE S2 PUBLICATION. Nothing new is computed
// about the eclipse itself; `Scene/EclipseState.js` remains the single owner of
// the geometry and of the transfer curve.
//
//   `resolveEclipseCloudFactor`         -> S2's `eclipseSceneLightFactor`, the
//                                          same scalar every other S2 consumer
//                                          multiplies by. Drives cloud direct
//                                          light, cloud ambient, and the
//                                          environment bake.
//   `eclipseCloudDirectionalFraction`   -> the DIRECTIONAL share of the
//                                          surviving illumination. Drives the
//                                          cloud-shadow strength only.
//
// WHY THE SHADOW NEEDS ITS OWN SCALAR — AND WHY IT IS NOT S2's. The obvious
// implementation, scaling the shadow strength by `eclipseSceneLightFactor` like
// everything else, is NON-MONOTONE and was rejected on arithmetic, not taste.
// Shadowed ground renders as `F * mix(1, T, s*F)` with the beer floor `T` at
// 0.35; at `s = 1` that is `F * (1 - 0.65F)`, which PEAKS at `F = 0.769`
// (0.3846) above its un-eclipsed value at `F = 1` (0.35). A shadowed patch of
// ground would get ~10% BRIGHTER as the eclipse deepened, then fall. The lift
// of the shadow and the dimming of the world would be fighting each other.
//
// The physics says why: an eclipse dims the direct beam AND the skylight
// together, because the sky is lit by the same sun. A uniform dimming leaves
// the shadow's CONTRAST RATIO invariant — which is exactly what the beer
// floor already encodes. The one thing that does change is the END STATE: the
// light inside the umbra is `ECLIPSE_RADIOMETRIC_FLOOR`'s nonlocal multiple
// scattering from the still-sunlit penumbra tens of kilometres away
// (`EclipseState.js`), and no local cloud can shadow that. So the quantity the
// shadow must track is the share of the surviving flux that is still
// DIRECTIONAL:
//
//   visible = 1 - moonObscuration
//   flux    = visible + FLOOR * (1 - visible)      (S2's own curve, pre-adaptation)
//   Fd      = visible / flux
//
// which is EXACTLY 1 at zero obscuration (byte-identical identity), 0.99955 at
// 90% obscured, 0.9524 at 99.9%, and EXACTLY 0 at totality. Monotone: the
// derivative with respect to `visible` is `FLOOR / (FLOOR + visible*(1-FLOOR))^2
// > 0`. It reuses S2's constant and introduces no tuned number of its own.
//
// It deliberately does NOT carry S2's adaptation exponent: that exponent is a
// DISPLAY transform standing in for the eye, not a change in the physical split
// between directional and nonlocal light.
//
// THE ENVIRONMENT-REFRESH INPUT, AND THE LATCH THIS ROW EXISTS TO PREVENT.
// Dimming an environment bake is only safe if the bake's refresh gate can SEE
// the eclipse. S2 already met this trap once and backed off from it: the
// C12-29 spec pins the WebGPU sky-atmosphere LUT bake as deliberately UNdimmed
// "because it is debounced on sun direction, which barely moves across an
// eclipse, so a dimmed bake latches". Both dynamic environment managers have
// the same shape of gate — WebGPU debounces on a ~0.3 degree sun move plus
// cloud revisions, WebGL on discrete atmosphere state plus a 3600 s scene-clock
// epsilon — so dimming either bake WITHOUT an eclipse-keyed input would leave
// the environment stuck dark for up to an hour after totality ended.
//
// The input is therefore quantized the way C13-37 quantized the cloud-IBL
// revision inputs: SNAP to a grid and compare the snapped value, never a
// per-frame delta (a delta test does not accumulate, so a slow drift never
// fires). `quantizeEclipseEnvironmentRefreshInput` returns an INTEGER bucket so
// the comparison is exact, and the gate is a LEVEL comparison against committed
// bookkeeping — `bucket !== cache.lastBucket`. That is what makes recovery
// automatic rather than a second code path: the factor returning to 1.0 walks
// the bucket back to the identity bucket, which differs from the committed dark
// bucket, which fires exactly one refresh. A one-way "only re-fill when it got
// darker" gate is the stale-dark latch, and it is the mutant the spec builds.
//
// The grid is the SAME 1/256 unit grid every other unit-interval IBL input
// already uses (`IBL_REVISION_UNIT_STEP`, `CLOUD_COVERAGE_REFRESH_EPSILON`);
// introducing a private step size here would be paralleling the existing
// debounce rather than extending it. The per-frame cost ceiling is not this
// grid's job — it belongs to the C11-193 bounded refresh scheduler, which
// defers losslessly precisely because every term is a level comparison.
//
// @private
// @module EclipseCloudResponse

import defined from "../Core/defined.js";
import { ECLIPSE_RADIOMETRIC_FLOOR } from "./EclipseState.js";

/**
 * Number of quantization steps the environment-refresh input is snapped to over
 * [0, 1]. Deliberately the same 1/256 unit grid as `IBL_REVISION_UNIT_STEP` and
 * `CLOUD_COVERAGE_REFRESH_EPSILON` — one rgba8 code on the environment cube.
 * @type {number}
 * @private
 */
const ECLIPSE_ENV_REFRESH_STEPS = 256;

/**
 * The bucket an un-eclipsed frame produces. Both managers initialize their
 * committed bucket to `NaN` instead of this, so the very first frame always
 * refreshes (`NaN !== anything`), matching `lastCloudRevision`'s convention.
 * @type {number}
 * @private
 */
const ECLIPSE_ENV_REFRESH_BUCKET_IDENTITY = ECLIPSE_ENV_REFRESH_STEPS;

/**
 * S2's scene-light factor, resolved defensively. Returns exactly 1.0 — the
 * multiplicative identity, hence byte-identical output — whenever the field is
 * absent, not a number, or outside [0, 1]. `NaN` fails both range tests and
 * therefore resolves to the identity rather than poisoning a uniform.
 *
 * @param {object|undefined} frameState
 * @returns {number} in [0, 1]
 * @private
 */
function resolveEclipseCloudFactor(frameState) {
  const factor = frameState?.eclipseSceneLightFactor;
  if (typeof factor !== "number" || !(factor >= 0.0) || !(factor <= 1.0)) {
    return 1.0;
  }
  return factor;
}

/**
 * The DIRECTIONAL share of the illumination surviving a solar eclipse — the
 * quantity a cast shadow can still modulate. See the module header for why this
 * is not `eclipseSceneLightFactor` and for the non-monotonicity that rules that
 * substitution out.
 *
 * Guarded on exactly the three conditions `getEclipseSceneLightFactor` guards
 * on, and driven by `moonObscuration` alone for the same reason: the Earth-limb
 * term saturates through twilight and all night, so using `sunVisibleFraction`
 * here would erase every cloud shadow at every sunset.
 *
 * @param {object|undefined} frameState
 * @returns {number} in [0, 1]; exactly 1.0 outside an enabled solar eclipse
 * @private
 */
function eclipseCloudDirectionalFraction(frameState) {
  const state = frameState?.eclipseState;
  if (!defined(state) || state.enabled !== true || state.valid !== true) {
    return 1.0;
  }
  const obscuration = state.moonObscuration;
  if (typeof obscuration !== "number" || !(obscuration > 0.0)) {
    return 1.0;
  }
  const visible = obscuration >= 1.0 ? 0.0 : 1.0 - obscuration;
  const flux = visible + ECLIPSE_RADIOMETRIC_FLOOR * (1.0 - visible);
  return flux > 0.0 ? visible / flux : 0.0;
}

/**
 * The ONE composition every eclipse-aware cloud/environment site performs. It
 * is a plain multiply, and it exists as a named function so the contract spec
 * can prove that all seven sites compose the factor identically instead of one
 * of them quietly acquiring a curve, a lerp or a second exponent.
 *
 * `value * 1.0` is bit-exact, so every non-eclipse frame is byte-identical.
 *
 * @param {number} value The un-eclipsed quantity.
 * @param {number} factor The resolved eclipse factor.
 * @returns {number}
 * @private
 */
function applyEclipseCloudDimming(value, factor) {
  return value * factor;
}

/**
 * Snap an eclipse factor to the environment-refresh grid, as an exact integer
 * bucket in [0, {@link ECLIPSE_ENV_REFRESH_STEPS}].
 *
 * Bucket `k` covers `[(k - 0.5) / 256, (k + 0.5) / 256)`, so the identity
 * bucket 256 covers `[255.5 / 256, 1]` — a factor above 0.998046875, i.e. an
 * obscuration under ~0.6%, is treated as no eclipse for refresh purposes and
 * costs nothing.
 *
 * @param {number} factor
 * @returns {number} an integer bucket
 * @private
 */
function quantizeEclipseEnvironmentRefreshInput(factor) {
  const clamped =
    typeof factor === "number" && factor >= 0.0 && factor <= 1.0 ? factor : 1.0;
  return Math.round(clamped * ECLIPSE_ENV_REFRESH_STEPS);
}

export {
  resolveEclipseCloudFactor,
  eclipseCloudDirectionalFraction,
  applyEclipseCloudDimming,
  quantizeEclipseEnvironmentRefreshInput,
  ECLIPSE_ENV_REFRESH_STEPS,
  ECLIPSE_ENV_REFRESH_BUCKET_IDENTITY,
};
export default resolveEclipseCloudFactor;
