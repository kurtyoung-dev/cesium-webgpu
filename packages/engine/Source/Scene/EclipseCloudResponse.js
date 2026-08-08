// How the cloud and environment-map subsystem responds to a solar eclipse.
//
// `Scene/EclipseState.js` is the single owner of the eclipse geometry and of
// the transfer curve. It publishes one backend-neutral scalar,
// `frameState.eclipseSceneLightFactor`, which the scene light colour
// (`UniformState`), the sky-atmosphere shell on both backends, the globe's
// ground atmosphere and fog (through the `tileProvider.atmosphereLightIntensity`
// mirror) and `frameState.skyBrightness` all multiply by. Nothing new about the
// eclipse is computed here; this module derives two scalars from that
// publication:
//
//   `resolveEclipseCloudFactor`         -> the published
//                                          `eclipseSceneLightFactor` itself,
//                                          driving cloud direct light, cloud
//                                          ambient, and the environment bake.
//   `eclipseCloudDirectionalFraction`   -> the directional share of the
//                                          surviving illumination, driving the
//                                          cloud-shadow strength only.
//
// The cloud deck needs an explicit term because none of its inputs track the
// dimmed scene light on their own. Its direct term is
// `(msLight + silverLining) * cloud.sunIntensity`, and `sunIntensity` is packed
// from `config.atmosphereLightIntensity`, the globe's undimmed user field rather
// than the per-frame dimmed `tileProvider` mirror. Its ambient term is
// `mix(groundAmbientColor, skyAmbientColor, h) * cloud.ambientIntensity`, over
// two hard-coded colours that track no scene light at all. The beer-shadow
// strength is a literal `1.0` at all four consumer sites, and the dynamic
// environment map's radiance bake reads the user's
// `atmosphereScatteringIntensity` on both backends. Without the terms below,
// totality drops the world, the sky and the ground to the ~5-lux twilight floor
// while the cloud deck and every IBL-lit model stay at full midday brightness.
//
// The shadow needs a scalar of its own because scaling shadow strength by
// `eclipseSceneLightFactor`, as every other consumer does, is non-monotone.
// Shadowed ground renders as `F * mix(1, T, s*F)` with the beer floor `T` at
// 0.35; at `s = 1` that is `F * (1 - 0.65F)`, which peaks at `F = 0.769`
// (0.3846), above its un-eclipsed value at `F = 1` (0.35). A shadowed patch of
// ground would get about 10% brighter as the eclipse deepened and only then
// fall, with the lift of the shadow fighting the dimming of the world.
//
// The physics behind that: an eclipse dims the direct beam and the skylight
// together, because the sky is lit by the same sun, and a uniform dimming leaves
// the shadow's contrast ratio invariant — which is what the beer floor already
// encodes. What does change is the end state. The light inside the umbra is
// `ECLIPSE_RADIOMETRIC_FLOOR`'s nonlocal multiple scattering from the
// still-sunlit penumbra tens of kilometres away (`EclipseState.js`), and no
// local cloud can shadow that. The quantity a shadow tracks is therefore the
// share of the surviving flux that is still directional:
//
//   visible = 1 - moonObscuration
//   flux    = visible + FLOOR * (1 - visible)      (the published curve, pre-adaptation)
//   Fd      = visible / flux
//
// which is exactly 1 at zero obscuration, 0.99955 at 90% obscured, 0.9524 at
// 99.9%, and exactly 0 at totality. It is monotone — the derivative with respect
// to `visible` is `FLOOR / (FLOOR + visible*(1-FLOOR))^2 > 0` — and it reuses the
// published constant, introducing no tuned number of its own. It does not carry
// the adaptation exponent, which is a display transform standing in for the eye
// rather than a change in the physical split between directional and nonlocal
// light.
//
// Dimming an environment bake is only safe if the bake's refresh gate can see
// the eclipse. The WebGPU sky-atmosphere LUT bake is left undimmed for exactly
// that reason: it is debounced on sun direction, which barely moves across an
// eclipse, so a dimmed bake would latch. Both dynamic environment managers have
// the same shape of gate — WebGPU debounces on a ~0.3 degree sun move plus cloud
// revisions, WebGL on discrete atmosphere state plus a 3600 s scene-clock
// epsilon — so dimming either bake without an eclipse-keyed input would leave
// the environment stuck dark for up to an hour after totality ended.
//
// The input is therefore snapped to a grid and compared as a snapped value,
// never as a per-frame delta: a delta test does not accumulate, so a slow drift
// never fires. `quantizeEclipseEnvironmentRefreshInput` returns an integer
// bucket so the comparison is exact, and the gate is a level comparison against
// committed bookkeeping, `bucket !== cache.lastBucket`. That is what makes
// recovery automatic rather than a second code path: the factor returning to 1.0
// walks the bucket back to the identity bucket, which differs from the committed
// dark bucket and fires exactly one refresh. A one-way gate that re-fills only
// when the scene got darker is the stale-dark latch.
//
// The grid is the 1/256 unit grid every other unit-interval IBL input already
// uses (`IBL_REVISION_UNIT_STEP`, `CLOUD_COVERAGE_REFRESH_EPSILON`); a private
// step size here would parallel the existing debounce rather than extend it. A
// per-frame cost ceiling is not this grid's job — that belongs to the bounded
// refresh scheduler, which can defer losslessly precisely because every term is
// a level comparison.
//
// @private
// @module EclipseCloudResponse

import defined from "../Core/defined.js";
import { ECLIPSE_RADIOMETRIC_FLOOR } from "./EclipseState.js";

/**
 * Number of quantization steps the environment-refresh input is snapped to over
 * [0, 1]. The same 1/256 unit grid as `IBL_REVISION_UNIT_STEP` and
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
 * The published scene-light factor, resolved defensively. Returns exactly 1.0 — the
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
 * The directional share of the illumination surviving a solar eclipse — the
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
 * The single composition every eclipse-aware cloud and environment site
 * performs. It is a plain multiply, and it exists as a named function so the
 * contract spec can prove that all seven sites compose the factor identically
 * rather than one of them acquiring a curve, a lerp or a second exponent.
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
