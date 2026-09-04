// The angular solar-glare washout is resolved once per render frame, before
// any backend consumer runs, and the resolved values are published on
// `frameState` — the same convention used for `sunDiscAppearance` and for
// `moonEarthshinePhaseScale` / `moonTerminatorSoftness`. Four shaders read the
// result (star sprites and the star cube map, on both backends), so a
// re-derivation in any one of them would reintroduce a silent parity gap.
//
// ─── WHY ANGULAR SEPARATION, NOT ELEVATION ─────────────────────────────────
//
// Washout here is a function of angular separation from the Sun only. An
// elevation-keyed dim would be wrong for this purpose: it would dim stars
// 180 deg away from the Sun exactly as hard as stars beside it, and washout
// that is not localized around the Sun's sky position is not glare.
// `enableStarBrightnessModulation` (`AtmosphericConditions.js`,
// `StarField.js`) is a separate, live dim keyed to
// `frameState.skyBrightness` for twilight/daylight/eclipse; see the
// COMPOSITION section below for how the two combine rather than substitute
// for each other.
//
// ─── FRAME (load-bearing) ──────────────────────────────────────────────────
//
// The published sun direction is in the TEME / inertial star frame, because
// that is the frame all four consumers already hold their star direction in:
//
//   * `StarField.wgsl`     — `input.directionFixed` is the TEME catalogue
//                            direction; the TEME->fixed rotation is baked into
//                            `viewProjectionNoTranslation` on the CPU.
//   * `StarFieldVS.glsl`   — the `directionFixed` attribute is the same TEME
//                            record; the shader rotates a copy into the fixed
//                            frame for projection, deliberately dotting
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
// both star paths for daylight, moonlight and eclipse. This term composes
// with it as an independent multiplicative factor; it does not replace,
// re-scale or gate it. In particular it is not gated by
// `SkyBrightness.computeAtmosphericColumnFactor`, which takes the sky-glow
// modulation to exactly zero above the engine's 111 km scattering shell. That
// gate is correct for sky glow (no column, no glow) and wrong for veiling
// glare (the scattering medium is the observer, and it goes to orbit with
// them) — see the note in `Scene/SolarDiscModel.js`. Orbit is precisely the
// case this term exists to cover, so inheriting the gate would make it inert
// exactly where it is needed.
//
// ─── SOURCE VISIBILITY ──────────────────────────────────────────────────────
//
// The washout is gated on the Sun actually delivering flux to the observer.
// Without that gate, stars near the Sun's sky position wash out even with the
// Sun below the horizon or behind the Earth — glare with no glare source. The
// gate is one multiply by `eclipseState.sunVisibleFraction`; see
// {@link resolveSunVisibility} for the identity rules and for why that scalar
// (whose Earth-limb term deliberately goes unused for scene-wide dimming) is
// the right one here.
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
 * is fully extinguished. This is the amplitude the visibility gate below
 * scales, and the only appearance parameter here — the curve's shape and
 * support are derived (`Scene/SolarDiscModel.js`). It is a module constant
 * rather than a public dial for the same reason the related lighting toggles
 * ship booleans: a second tunable is a second thing that can disagree between
 * backends.
 *
 * @private
 */
const SOLAR_GLARE_STRENGTH = 1.0;

/**
 * The source-visibility gate.
 *
 * Veiling glare is light from the glare source scattered inside the
 * observer's eye and optics. If the source delivers no flux to the observer
 * there is nothing to scatter, so the veil must vanish — and an ungated term
 * would not know that: a camera in Earth's shadow, or one looking at a
 * midnight sky, would still wash out every star within 90 deg of the Sun's
 * sky position even though the Sun is below the horizon. That would be
 * physically wrong, and user-visible as "stars disappear from a patch of the
 * night sky".
 *
 * `eclipseState.sunVisibleFraction` is exactly the published scalar for
 * "surviving solar flux at this camera": `(1 - earthOcclusionFraction) *
 * (1 - moonObscuration)` (`Scene/EclipseState.js`). Its Earth-limb term is 1
 * for every night frame and most of twilight — dimming the whole scene by it
 * would black out every sunset, which is why the scene-light eclipse dimming
 * uses a different, floored term instead — and that same property makes it
 * the correct gate for a term that models the observer's own optics. The
 * Sun's billboard already fades by the same fraction, so the veil and the
 * disc disappear together instead of the veil outliving its source.
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
    // `strength === 0` is the exact identity: every consumer skips its whole
    // glare block, so the off position is byte-identical rather than close.
    strength: 0.0,
    // The source-visibility gate is reported, not consumed by any shader:
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
 * Resolves the angular solar-glare washout for this frame.
 *
 * Requires the facade explicitly (`=== true`), matching how {@link Moon} and
 * {@link Sun} read their own lighting toggles: a scene with no globe
 * attached keeps the pre-existing look exactly.
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
 *        visibility gate. See {@link resolveSunVisibility}; absent or
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
  // multiplier on the "on" strength and the "off" position stays exactly 0.
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
// Default export required by the generated barrel: `packages/engine/index.js`
// is produced by `scripts/build.js`, which emits `export { default as X }`
// for every `Source/**/*.js` with no exclusion mechanism, so a named-exports-
// only module fails `npx gulp build` with "No matching export ... for import
// default". `npx tsc --noEmit` does not catch it (it never checks the
// generated barrel) — a gulp build is the only gate for this class.
export default readSolarGlareAppearance;
