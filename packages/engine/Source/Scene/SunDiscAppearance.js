// Shared resolver for the two sun-bake appearance toggles.
//
// Following the scene-logic-extractor pattern, they are resolved here, once,
// before `Sun.update` branches into the feature renderer, and the resolved
// numbers are published on `frameState` the same way
// `sunAtmosphereExtinction` and `sunEclipseAlpha` are. That is what makes the
// two bakes — GLSL `SunTextureFS.glsl` on WebGL, the CPU loop in
// `WebGPUEnvironmentRenderer.createSunTexture` on WebGPU — read the same
// values instead of each re-deriving them from `atmosphericConditions`.
//
// Both toggles default on, and both have an exact identity position:
//   enableSolarLimbDarkening === false -> (a0, a1, a2) = (1, 0, 0), so
//     I(mu) == 1 everywhere and the disc is a flat step().
//   enableSolarGlareFalloff  === false -> `glareLegacy` = 1, selecting the
//     `1 - smoothstep(0, 0.55, radius)` expression verbatim.
// With both false the bake is byte-identical on both backends.
//
// @private
// @module SunDiscAppearance

import {
  SOLAR_LIMB_DARKENING_A0,
  SOLAR_LIMB_DARKENING_A1,
  SOLAR_LIMB_DARKENING_A2,
  SOLAR_GLARE_CORE,
  SOLAR_GLARE_PEDESTAL,
  SOLAR_GLARE_LEGACY_EDGE,
} from "./SolarDiscModel.js";

/**
 * Creates the mutable result object `readSunDiscAppearance` fills in. One per
 * `Sun` instance; never reallocated per frame.
 *
 * @returns {object} The appearance state.
 * @private
 */
function createSunDiscAppearance() {
  return {
    // Resolved toggle positions.
    limbDarkening: true,
    glareFalloff: true,
    // Uniform payload — exactly what both bakes consume.
    a0: SOLAR_LIMB_DARKENING_A0,
    a1: SOLAR_LIMB_DARKENING_A1,
    a2: SOLAR_LIMB_DARKENING_A2,
    glareCore: SOLAR_GLARE_CORE,
    glarePedestal: SOLAR_GLARE_PEDESTAL,
    glareLegacyEdge: SOLAR_GLARE_LEGACY_EDGE,
    glareLegacy: 0.0,
    // Two-bit cache key: bit 0 = limb darkening, bit 1 = glare falloff. Both
    // bakes rebuild their texture when this changes.
    key: 3,
  };
}

/**
 * Resolves the two sun-bake toggles from the frame's
 * `atmosphericConditions.lighting` leaf, defaulting both to on when the
 * facade is absent because no globe is attached.
 *
 * @param {object} frameState The frame state.
 * @param {object} result A `createSunDiscAppearance()` object to fill.
 * @returns {object} `result`.
 * @private
 */
function readSunDiscAppearance(frameState, result) {
  const lighting = frameState?.atmosphericConditions?.lighting;
  const limbDarkening = lighting?.enableSolarLimbDarkening !== false;
  const glareFalloff = lighting?.enableSolarGlareFalloff !== false;

  result.limbDarkening = limbDarkening;
  result.glareFalloff = glareFalloff;
  result.a0 = limbDarkening ? SOLAR_LIMB_DARKENING_A0 : 1.0;
  result.a1 = limbDarkening ? SOLAR_LIMB_DARKENING_A1 : 0.0;
  result.a2 = limbDarkening ? SOLAR_LIMB_DARKENING_A2 : 0.0;
  result.glareCore = SOLAR_GLARE_CORE;
  result.glarePedestal = SOLAR_GLARE_PEDESTAL;
  result.glareLegacyEdge = SOLAR_GLARE_LEGACY_EDGE;
  result.glareLegacy = glareFalloff ? 0.0 : 1.0;
  result.key = (limbDarkening ? 1 : 0) | (glareFalloff ? 2 : 0);
  return result;
}

export { createSunDiscAppearance, readSunDiscAppearance };
// Default export required by the generated barrel: `packages/engine/index.js`
// is produced by `scripts/build.js`, which emits `export { default as X }`
// for every `Source/**/*.js` with no exclusion mechanism, so a module with
// named exports only fails `npx gulp build` with "No matching export ... for
// import default". `npx tsc --noEmit` does not catch it, because it never
// checks the generated barrel; a gulp build is the only gate for this class.
export default readSunDiscAppearance;
