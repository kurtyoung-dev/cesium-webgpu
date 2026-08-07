// SolarGlareAppearance.js — C12-27 (`NEW-ANGULAR-SOLAR-GLARE-STAR-WASHOUT`).
//
// Scene Logic Extractor pattern (CLAUDE.md): the angular solar-glare washout is
// resolved HERE, exactly once per render frame, before any backend consumer
// runs, and the resolved NUMBERS are published on `frameState` — the same
// convention C12-15/16 use for `sunDiscAppearance` and C12-21/22 use for
// `moonEarthshinePhaseScale` / `moonTerminatorSoftness`. Four shaders read the
// result (star sprites and the star cube map, on both backends), so a
// re-derivation in any one of them would be a silent parity gap of exactly the
// kind this row exists to close.
//
// ─── WHAT THIS REPLACES ────────────────────────────────────────────────────
//
// The removed `enableStarBrightnessModulation` global dim (C11-176, Batch 722)
// was keyed to the SUN'S ELEVATION above the camera's local horizon. That model
// is wrong twice over: it dimmed stars 180 deg away from the Sun exactly as
// hard as stars beside it, and it was WebGPU-only, so re-adding an elevation
// term on one backend would recreate the parity bug that fix closed. What
// actually washes out stars near the Sun is veiling glare — light scattered
// inside the observer's eye and optics — which is a function of ANGULAR
// SEPARATION from the Sun and of nothing else.
//
// ─── FRAME (load-bearing) ──────────────────────────────────────────────────
//
// The published sun direction is in the TEME / inertial star frame, because
// that is the frame all four consumers already hold their star direction in:
//
//   * `StarField.wgsl`     — `input.directionFixed` IS the TEME catalogue
//                            direction; the TEME->fixed rotation is baked into
//                            `viewProjectionNoTranslation` on the CPU.
//   * `StarFieldVS.glsl`   — the `directionFixed` ATTRIBUTE is the same TEME
//                            record; the shader rotates a COPY into the fixed
//                            frame for projection, and C12-27 deliberately dots
//                            against the un-rotated attribute.
//   * `CubeMapPanorama.wgsl` / `SkyBoxFS.glsl` — the cube-map lookup direction
//                            is the raw box position; both backends apply
//                            `temeToPseudoFixed` on the way to clip space
//                            (WebGL in `SkyBoxVS.glsl`, WebGPU through
//                            `panoramaTransform`), so the lookup frame is TEME.
//
// A dot product is rotation-invariant, so resolving the Sun into TEME once is
// equivalent to rotating every star into the fixed frame — and it is the only
// arrangement in which one published vector serves all four sites.
//
// ─── COMPOSITION WITH THE EXISTING STAR MODULATION ─────────────────────────
//
// `frameState.skyBrightness` -> `computeStarBrightnessModulation` already dims
// BOTH star paths for daylight, moonlight and eclipse. C12-27 composes with it
// as an independent multiplicative factor; it does not replace, re-scale or
// gate it. In particular this term is NOT gated by
// `SkyBrightness.computeAtmosphericColumnFactor`, which takes the sky-glow
// modulation to exactly zero above the engine's 111 km scattering shell. That
// gate is correct for sky glow (no column, no glow) and WRONG for veiling glare
// (the scattering medium is the observer, and it goes to orbit with them) —
// see the note in `Scene/SolarDiscModel.js`. Orbit is precisely the case the
// maintainer reported, so inheriting the gate would make this row inert exactly
// where it was asked for.
//
// ─── SOURCE VISIBILITY (Batch 873, discharging the Batch-865 filing) ───────
//
// It IS gated on the Sun actually delivering flux to the observer. The row as
// first landed washed out stars near the Sun's sky position even with the Sun
// below the horizon or behind the Earth — glare with no glare source. The gate
// is one multiply by `eclipseState.sunVisibleFraction`; see
// {@link resolveSunVisibility} for the identity rules and for why THAT scalar
// (whose Earth-limb term S2 deliberately refuses) is the right one here.
//
// @private
// @module SolarGlareAppearance

import Cartesian3 from "../Core/Cartesian3.js";
import defined from "../Core/defined.js";
import Matrix3 from "../Core/Matrix3.js";
import {
  SOLAR_GLARE_ANGULAR_CORE,
  SOLAR_GLARE_ANGULAR_PEDESTAL,
  SOLAR_GLARE_ANGULAR_SUPPORT,
} from "./SolarDiscModel.js";

/**
 * Washout strength when the toggle is on: 1.0, i.e. a star exactly on the Sun
 * is fully extinguished. This is the amplitude the C12-27 gate measures, and
 * the only APPEARANCE parameter in the row — the curve's shape and support are
 * derived (`Scene/SolarDiscModel.js`). It is a module constant rather than a
 * public dial for the same reason C12-15/16/20/22 ship booleans: a second
 * tunable is a second thing that can disagree between backends.
 *
 * @private
 */
const SOLAR_GLARE_STRENGTH = 1.0;

/**
 * C12-27 SOURCE-VISIBILITY GATE (the finding Batch 865 filed against itself).
 *
 * Veiling glare is light from the GLARE SOURCE scattered inside the observer's
 * eye and optics. If the source delivers no flux to the observer there is
 * nothing to scatter, so the veil must vanish — and the shipped row did not
 * know that: a camera in Earth's shadow, or one looking at a midnight sky,
 * still washed out every star within 90 deg of the Sun's SKY POSITION even
 * though the Sun was below the horizon. That is physically wrong, and it is
 * user-visible as "stars disappear from a patch of the night sky".
 *
 * `eclipseState.sunVisibleFraction` is exactly the published scalar for
 * "surviving solar flux at this camera": `(1 - earthOcclusionFraction) *
 * (1 - moonObscuration)` (`Scene/EclipseState.js`). Its Earth-limb term is 1
 * for every night frame and most of twilight — the property S2 deliberately
 * refuses because dimming the WORLD by it would black out every sunset, and
 * the very same property that makes it the correct gate for a term that
 * models the observer's own optics. S1 already fades the Sun BILLBOARD by it,
 * so the veil and the disc now disappear together instead of the veil
 * outliving its source.
 *
 * Identity rules, so this cannot change a frame it should not:
 *   * no eclipse state, or `valid === false` (missing inputs, 2D/CV/MORPHING,
 *     the first frame before the ephemeris resolves) -> 1.0, i.e. the
 *     pre-gate behaviour, bit-for-bit.
 *   * `enabled === false` (`lighting.enableEclipse` off) -> 1.0, matching
 *     every other consumer's contract that the toggle's off position applies
 *     exactly 1.0 rather than a different number.
 * A resolved visibility of exactly 0 drives `strength` to exactly 0, and 0 is
 * the value every consumer's `> 0.0` guard skips its whole block on — so a
 * fully-occluded Sun is byte-identical to the no-glare frame, not merely
 * close to it.
 *
 * @param {object} [eclipseState] `frameState.eclipseState`.
 * @returns {number} Surviving solar flux fraction in [0, 1]; 1.0 when unknown.
 * @private
 */
function resolveSunVisibility(eclipseState) {
  if (
    !defined(eclipseState) ||
    eclipseState.valid !== true ||
    eclipseState.enabled !== true
  ) {
    return 1.0;
  }
  const fraction = eclipseState.sunVisibleFraction;
  if (typeof fraction !== "number" || !Number.isFinite(fraction)) {
    return 1.0;
  }
  return fraction < 0.0 ? 0.0 : fraction > 1.0 ? 1.0 : fraction;
}

const scratchTemeToFixedT = new Matrix3();

/**
 * Creates the mutable result object {@link readSolarGlareAppearance} fills in.
 * One per {@link Scene}; never reallocated per frame.
 *
 * @returns {object} The appearance state.
 * @private
 */
function createSolarGlareAppearance() {
  return {
    // Resolved toggle position.
    enabled: false,
    // Uniform payload — exactly what all four shader consumers read.
    // `strength === 0` is the EXACT identity: every consumer skips its whole
    // glare block, so the off position is byte-identical rather than close.
    strength: 0.0,
    // C12-27 source-visibility gate — REPORTED, not consumed by any shader:
    // `strength` already carries the product. Published so a probe can tell
    // "the toggle is off" (strength 0, visibility 1) apart from "the Sun is
    // behind the Earth" (strength 0, visibility 0) without re-deriving either.
    sunVisibleFraction: 1.0,
    angularCore: SOLAR_GLARE_ANGULAR_CORE,
    pedestal: SOLAR_GLARE_ANGULAR_PEDESTAL,
    support: SOLAR_GLARE_ANGULAR_SUPPORT,
    // Sun direction in the TEME / inertial star frame (see the module header).
    sunDirectionTeme: new Cartesian3(0.0, 0.0, 1.0),
  };
}

/**
 * Resolves the C12-27 angular solar-glare washout for this frame.
 *
 * Requires the facade explicitly (`=== true`), matching how {@link Moon} and
 * {@link Sun} read their C12 toggles: a scene with no globe attached keeps the
 * pre-C12-27 look exactly.
 *
 * @param {object} [lighting] The `atmosphericConditions.lighting` leaf.
 * @param {Cartesian3} [sunDirectionWC] Unit sun direction, Earth-fixed (world).
 * @param {Matrix3} [temeToPseudoFixedMatrix] The frame's TEME->fixed rotation.
 *        Absent (e.g. a context whose `UniformState` has not resolved a time)
 *        is treated as identity — the same fallback
 *        `WebGPUStarFieldRenderer.packStarUniforms` and
 *        `WebGPUCubeMapPanoramaRenderer.updateUniforms` already take, so all
 *        consumers stay consistent with one another even in that degenerate
 *        frame.
 * @param {object} [eclipseState] `frameState.eclipseState`, the source of the
 *        C12-27 visibility gate. See {@link resolveSunVisibility}; absent or
 *        invalid resolves to 1.0 and leaves the frame unchanged.
 * @param {object} result A {@link createSolarGlareAppearance} object to fill.
 * @returns {object} `result`.
 * @private
 */
function readSolarGlareAppearance(
  lighting,
  sunDirectionWC,
  temeToPseudoFixedMatrix,
  eclipseState,
  result,
) {
  const enabled =
    lighting?.enableAngularSolarGlare === true && defined(sunDirectionWC);

  // Resolved even when the toggle is off, so `sunVisibleFraction` is a pure
  // multiplier on the ON strength and the OFF position stays EXACTLY 0.
  const visibility = resolveSunVisibility(eclipseState);

  result.enabled = enabled;
  result.strength = enabled ? SOLAR_GLARE_STRENGTH * visibility : 0.0;
  result.sunVisibleFraction = visibility;
  result.angularCore = SOLAR_GLARE_ANGULAR_CORE;
  result.pedestal = SOLAR_GLARE_ANGULAR_PEDESTAL;
  result.support = SOLAR_GLARE_ANGULAR_SUPPORT;

  if (!enabled) {
    return result;
  }

  const teme = result.sunDirectionTeme;
  if (defined(temeToPseudoFixedMatrix)) {
    // fixed -> TEME is the transpose of TEME -> fixed (both are rotations).
    Matrix3.transpose(temeToPseudoFixedMatrix, scratchTemeToFixedT);
    Matrix3.multiplyByVector(scratchTemeToFixedT, sunDirectionWC, teme);
  } else {
    Cartesian3.clone(sunDirectionWC, teme);
  }
  // `sunDirectionWC` is already unit, and a rotation preserves length, so this
  // is defensive rather than corrective — but a non-unit vector here would
  // scale every cosine and silently widen the veil, which is worth one sqrt
  // per frame to rule out.
  const length = Cartesian3.magnitude(teme);
  if (length > 0.0) {
    Cartesian3.divideByScalar(teme, length, teme);
  } else {
    result.enabled = false;
    result.strength = 0.0;
  }
  return result;
}

export {
  SOLAR_GLARE_STRENGTH,
  createSolarGlareAppearance,
  readSolarGlareAppearance,
};
// Default export REQUIRED by the generated barrel: `packages/engine/index.js`
// is produced by `scripts/build.js`, which emits `export { default as X }`
// for every `Source/**/*.js` with no exclusion mechanism, so a named-exports-
// only module fails `npx gulp build` with "No matching export ... for import
// default". `npx tsc --noEmit` does NOT catch it (it never checks the
// generated barrel) — a gulp build is the only gate for this class.
export default readSolarGlareAppearance;
