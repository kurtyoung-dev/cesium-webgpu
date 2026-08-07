// SunHaloAppearance.js — C12-18 shared resolver (absorbs C11-160, C11-115).
//
// Scene Logic Extractor pattern (CLAUDE.md): everything the two backends need
// in order to agree about the sun's DISC SIZE and about WHERE ITS HALO COMES
// FROM is resolved HERE, once, before `Sun.update` branches into the feature
// renderer, and published on `frameState.sunHalo` exactly the way
// C7-SUN-STARS-EXTINCTION publishes `sunAtmosphereExtinction`, C12-29 S1
// publishes `sunEclipseAlpha` and C12-15/16 publish `sunDiscAppearance`.
//
// ─── THE ONE INVARIANT THIS MODULE EXISTS TO ENFORCE ───────────────────────
//
//   EXACTLY ONE HALO SOURCE IS ACTIVE AT A TIME.
//
// Before C12-18 the halo was baked into the sun billboard's texture (a
// pedestal-subtracted Lorentzian truncated at the quad's inscribed circle,
// 11 R_sun) AND, on WebGL only, bloomed a second time by `SunPostProcess`.
// C12-18 moves the halo into the post-process chain on BOTH backends. The
// failure mode of a half-done move is a DOUBLE halo (bake + screen space),
// and the failure mode of an over-eager move is NO halo at all (bake removed
// on a path where the screen-space stage never runs — e.g. `sunBloom = false`).
// So `bakeHaloGain` is derived from `screenHalo`, never set independently:
//
//   screenHalo === true   ->  bakeHaloGain = 0   (halo from the PP chain)
//   screenHalo === false  ->  bakeHaloGain = 1   (historical baked halo)
//
// `sun-halo-composition.spec.mjs` pins that as an exhaustive truth table and
// REJECTS a mutant that leaves the bake halo on while the screen halo runs.
//
// ─── WHAT ELSE IS RESOLVED HERE ────────────────────────────────────────────
//
//   * `discEdge` — the bake radius at which the solar disc terminates. The
//     shipped value made the disc subtend 1/sqrt(2) of the Sun's true angular
//     radius; see the C12-18 derivation block in `SolarDiscModel.js`.
//   * `haloAmplitude` / `haloCoreRadii` — the screen-space veiling-glare
//     profile's two parameters, both derived from the SAME C12-16 curve.
//   * `eclipseFactor` — CLT-C4. The eclipse factor must multiply the PP halo's
//     INPUT or the halo survives totality; a corona inside an undimmed halo is
//     the named failure mode. Because the screen-space halo is SYNTHESISED
//     rather than extracted from the framebuffer, "multiply the input" is
//     literally "multiply the amplitude", which is what `haloIntensity` is.
//     The DERIVED bloom paths (WebGL `SunPostProcess`'s bright-pass chain,
//     WebGPU's global `BloomEffect`) inherit the factor for free, because what
//     they bloom is the sun billboard whose ALPHA `Sun.update` already scaled
//     by `sunEclipseAlpha` — so nothing there needs a second multiply, and
//     adding one would square the fade.
//   * screen geometry (`centerX`, `centerY`, `limbPx`, `visible`) — computed
//     once here so the WebGL stage and the WebGPU effect cannot disagree about
//     where the Sun is.
//
// @private
// @module SunHaloAppearance

import Cartesian3 from "../Core/Cartesian3.js";
import Cartesian4 from "../Core/Cartesian4.js";
import defined from "../Core/defined.js";
import CesiumMath from "../Core/Math.js";
import Matrix4 from "../Core/Matrix4.js";
import {
  SOLAR_HALO_AMPLITUDE,
  solarDiscBakeEdge,
  solarDiscBakeEdgeLegacy,
  solarHaloCoreRadii,
} from "./SolarDiscModel.js";

const scratchSunEC = new Cartesian4();
const scratchSunClip = new Cartesian4();

/**
 * Creates the mutable result object {@link readSunHaloAppearance} fills in.
 * One per `Sun` instance; never reallocated per frame.
 *
 * @returns {object} The halo state.
 * @private
 */
function createSunHaloAppearance() {
  return {
    // Resolved toggle positions.
    trueDiscSize: true,
    screenHalo: false,
    // Bake payload — consumed by `SunTextureFS.glsl` (as uniforms) and by
    // `WebGPUEnvironmentRenderer.createSunTexture` (as plain numbers).
    discEdge: 0.0,
    bakeHaloGain: 1.0,
    // Screen-space payload — consumed by the WebGL `SolarHalo` stage inside
    // `SunPostProcess` and by the WebGPU `SunHaloEffect`.
    haloAmplitude: SOLAR_HALO_AMPLITUDE,
    haloCoreRadii: 0.0,
    eclipseFactor: 1.0,
    haloIntensity: 0.0,
    // Halo tint = the SAME per-channel atmospheric transmittance the disc is
    // multiplied by (`frameState.sunAtmosphereExtinction`, C7-SUN-STARS-
    // EXTINCTION). Veiling glare is the observer's response to the light that
    // actually arrives, so a sun reddened by a long slant path must have a
    // reddened halo, and a fully extinguished sun must have none at all.
    // (1, 1, 1) from orbit / with the atmosphere hidden.
    haloColorR: 1.0,
    haloColorG: 1.0,
    haloColorB: 1.0,
    // Screen geometry, drawing-buffer pixels, GL convention (y UP from the
    // bottom-left). The WebGPU consumer flips y; see `SolarHalo.wgsl`.
    centerX: 0.0,
    centerY: 0.0,
    limbPx: 0.0,
    visible: false,
    // 2-bit bake-rebuild signature: bit 0 = true disc size, bit 1 = the bake
    // still owns the halo. Both bakes rebuild their texture when it changes,
    // exactly like `sunDiscAppearance.key` does.
    key: 1,
  };
}

/**
 * Projects the Sun into drawing-buffer pixels and measures its limb in the
 * same units.
 *
 * `limbPx` is the on-axis small-angle form both existing consumers already
 * use — `Sun.update`'s `_size` computation (WebGL) and `packSunUniforms`'s
 * `angHalf * |proj[0 or 5]|` (WebGPU). For the symmetric perspective frustum
 * both backends build, `proj[0] * width === proj[5] * height`, so the X and Y
 * measurements agree and the halo is circular in pixels; the Y axis is used
 * because it is the axis the vertical field of view is defined on.
 *
 * @param {object} frameState The frame state.
 * @param {object} result A {@link createSunHaloAppearance} object to fill.
 * @returns {boolean} `true` when the Sun is in front of the camera and the
 *          geometry is finite — i.e. when `centerX/centerY/limbPx` are usable.
 * @private
 */
function computeSunScreenGeometry(frameState, result) {
  result.centerX = 0.0;
  result.centerY = 0.0;
  result.limbPx = 0.0;

  const context = frameState?.context;
  const uniformState = context?.uniformState;
  const camera = frameState?.camera;
  if (!defined(uniformState) || !defined(camera)) {
    return false;
  }
  const sunPositionWC = uniformState.sunPositionWC;
  if (!defined(sunPositionWC)) {
    return false;
  }
  const width = context.drawingBufferWidth;
  const height = context.drawingBufferHeight;
  if (!(width > 0) || !(height > 0)) {
    return false;
  }

  // Eye space. Cesium's view matrix looks down -Z, so a Sun in front of the
  // camera has z < 0. Without this guard a Sun BEHIND the camera projects to
  // a mirrored on-screen position and would paint a phantom halo — the
  // classic screen-space-effect bug.
  const ec = Matrix4.multiplyByPoint(
    uniformState.view,
    sunPositionWC,
    scratchSunEC,
  );
  if (!(ec.z < 0.0)) {
    return false;
  }

  const clip = Matrix4.multiplyByVector(
    uniformState.projection,
    Cartesian4.fromElements(ec.x, ec.y, ec.z, 1.0, scratchSunClip),
    scratchSunClip,
  );
  if (!(clip.w > 0.0)) {
    return false;
  }
  const ndcX = clip.x / clip.w;
  const ndcY = clip.y / clip.w;
  if (!isFinite(ndcX) || !isFinite(ndcY)) {
    return false;
  }

  const sunDist = Cartesian3.distance(sunPositionWC, camera.positionWC);
  if (!(sunDist > 0.0)) {
    return false;
  }
  const proj = uniformState.projection;
  const angHalf = CesiumMath.SOLAR_RADIUS / sunDist;
  const limbPx = angHalf * Math.abs(proj[5]) * height * 0.5;
  if (!(limbPx > 0.0) || !isFinite(limbPx)) {
    return false;
  }

  result.centerX = (ndcX * 0.5 + 0.5) * width;
  result.centerY = (ndcY * 0.5 + 0.5) * height;
  result.limbPx = limbPx;
  return true;
}

/**
 * Resolves the C12-18 disc-size and halo-source decisions for this frame.
 *
 * Both toggles live on the same `atmosphericConditions.lighting` leaf as the
 * C12-15/16 pair and follow the same `!== false` convention (ON without a
 * facade), with exact identity in the OFF position:
 *
 *   `enableTrueSolarDiscSize === false`  -> `discEdge` is the legacy
 *      `0.5 / (1 + 2*glowLengthTS)` EXACTLY, i.e. the historical undersized
 *      disc, bit-for-bit.
 *   `enableScreenSpaceSunHalo === false` -> `bakeHaloGain = 1` and
 *      `haloIntensity = 0`, i.e. the historical baked halo and no
 *      screen-space stage at all.
 *
 * With both false the sun bake is byte-identical to the pre-C12-18 engine on
 * both backends and no post-process stage is added.
 *
 * @param {object} frameState The frame state.
 * @param {number} glowLengthTS `glowFactor * 5`, as both bakes compute it.
 * @param {object} result A {@link createSunHaloAppearance} object to fill.
 * @returns {object} `result`.
 * @private
 */
function readSunHaloAppearance(frameState, glowLengthTS, result) {
  const lighting = frameState?.atmosphericConditions?.lighting;
  const trueDiscSize = lighting?.enableTrueSolarDiscSize !== false;
  const haloRequested = lighting?.enableScreenSpaceSunHalo !== false;

  // The screen-space halo only exists where the post-process chain that draws
  // it actually runs. `frameState.sunBloomActive` is published by
  // `Scene.updateEnvironment` from `scene.sunBloom` (the same flag that gates
  // `SunPostProcess` on WebGL and, since C11-160, the `SunHaloEffect` on
  // WebGPU). Reading it here is what keeps `bakeHaloGain` honest: an app that
  // sets `sunBloom = false` keeps the historical baked halo instead of
  // silently losing the sun's glow.
  const chainAvailable = frameState?.sunBloomActive === true;
  const geometryOk = computeSunScreenGeometry(frameState, result);
  const screenHalo = haloRequested && chainAvailable;

  result.trueDiscSize = trueDiscSize;
  result.screenHalo = screenHalo;
  result.discEdge = trueDiscSize
    ? solarDiscBakeEdge(glowLengthTS, true)
    : solarDiscBakeEdgeLegacy(glowLengthTS);
  // DERIVED, never assigned independently — see the module header.
  result.bakeHaloGain = screenHalo ? 0.0 : 1.0;

  result.haloAmplitude = SOLAR_HALO_AMPLITUDE;
  result.haloCoreRadii = solarHaloCoreRadii(glowLengthTS);

  // CLT-C4 — the eclipse factor multiplies the halo's amplitude, which for a
  // synthesised halo IS its input. `sunEclipseAlpha` is published by
  // `Sun.update` immediately above this call and is exactly 1.0 whenever
  // nothing occults the Sun or `enableEclipse` is off.
  const eclipseAlpha = frameState?.sunEclipseAlpha;
  result.eclipseFactor =
    typeof eclipseAlpha === "number" && eclipseAlpha >= 0.0 && eclipseAlpha <= 1
      ? eclipseAlpha
      : 1.0;

  const extinction = frameState?.sunAtmosphereExtinction;
  result.haloColorR = defined(extinction) ? extinction.x : 1.0;
  result.haloColorG = defined(extinction) ? extinction.y : 1.0;
  result.haloColorB = defined(extinction) ? extinction.z : 1.0;

  result.visible = screenHalo && geometryOk;
  result.haloIntensity = result.visible
    ? result.haloAmplitude * result.eclipseFactor
    : 0.0;

  result.key = (trueDiscSize ? 1 : 0) | (screenHalo ? 0 : 2);
  return result;
}

export {
  createSunHaloAppearance,
  readSunHaloAppearance,
  computeSunScreenGeometry,
};
// Default export REQUIRED by the generated barrel: `packages/engine/index.js`
// is produced by `scripts/build.js`, which emits `export { default as X }`
// for every `Source/**/*.js` with no exclusion mechanism, so a named-exports-
// only module fails `npx gulp build` with "No matching export ... for import
// default". `npx tsc --noEmit` does NOT catch it (it never checks the
// generated barrel) — a gulp build is the only gate for this class.
export default readSunHaloAppearance;
