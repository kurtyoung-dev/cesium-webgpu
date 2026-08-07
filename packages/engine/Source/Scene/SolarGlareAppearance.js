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
 * @param {object} result A {@link createSolarGlareAppearance} object to fill.
 * @returns {object} `result`.
 * @private
 */
function readSolarGlareAppearance(
  lighting,
  sunDirectionWC,
  temeToPseudoFixedMatrix,
  result,
) {
  const enabled =
    lighting?.enableAngularSolarGlare === true && defined(sunDirectionWC);

  result.enabled = enabled;
  result.strength = enabled ? SOLAR_GLARE_STRENGTH : 0.0;
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
