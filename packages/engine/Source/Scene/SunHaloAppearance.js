// Shared resolver for the sun's disc size and for where its halo comes from.
//
// Following the scene-logic-extractor pattern, everything the two backends
// need in order to agree about those two questions is resolved here, once,
// before `Sun.update` branches into the feature renderer, and published on
// `frameState.sunHalo` the same way `sunAtmosphereExtinction`,
// `sunEclipseAlpha` and `sunDiscAppearance` are.
//
// The invariant the module enforces is that exactly one halo source is active
// at a time. The halo can be baked into the sun billboard's texture — a
// pedestal-subtracted Lorentzian truncated at the quad's inscribed circle,
// 11 R_sun — or drawn by the post-process chain in screen space. Both at once
// is a double halo; neither, which is what happens if the bake is stripped on
// a path where the screen-space stage never runs (`sunBloom = false`), leaves
// the sun with no glow. So `bakeHaloGain` is derived from `screenHalo` and is
// never assigned independently:
//
//   screenHalo === true   ->  bakeHaloGain = 0   (halo from the PP chain)
//   screenHalo === false  ->  bakeHaloGain = 1   (halo from the bake)
//
// `sun-halo-composition.spec.mjs` pins that as an exhaustive truth table and
// rejects a mutant that leaves the bake halo on while the screen halo runs.
//
// Also resolved here:
//
//   * `discEdge` — the bake radius at which the solar disc terminates.
//     `SolarDiscModel.solarDiscBakeEdgeLegacy` derives why the legacy value
//     makes the disc subtend 1/sqrt(2) of the Sun's true angular radius.
//   * `haloAmplitude` / `haloCoreRadii` — the screen-space veiling-glare
//     profile's two parameters, both derived from the same curve the bake
//     uses. `haloAmplitude` is scaled by `discRadiance`; the block at its
//     assignment says why that is required rather than cosmetic.
//   * `discRadiance` — the disc's linear radiance, and the
//     `brightPassThreshold` / `brightPassOffset` pair derived from it.
//     Neither is bake payload: both are consumed downstream of the bake, and
//     neither joins `key`.
//   * `eclipseFactor` — the eclipse factor multiplies the post-process halo's
//     input, or the halo survives totality and the corona sits inside an
//     undimmed glow. Because the screen-space halo is synthesised rather than
//     extracted from the framebuffer, multiplying its input is literally
//     multiplying its amplitude, which is what `haloIntensity` is. The bloom
//     paths — WebGL's `SunPostProcess` bright-pass chain and WebGPU's global
//     `BloomEffect` — inherit the factor without a second multiply, because
//     what they bloom is the sun billboard whose alpha `Sun.update` has
//     already scaled by `sunEclipseAlpha`; adding one there would square the
//     fade.
//   * screen geometry (`centerX`, `centerY`, `limbPx`, `visible`) — computed
//     once here so the WebGL stage and the WebGPU effect cannot disagree
//     about where the Sun is.
//
// @private
// @module SunHaloAppearance

import Cartesian3 from "../Core/Cartesian3.js";
import Cartesian4 from "../Core/Cartesian4.js";
import defined from "../Core/defined.js";
import CesiumMath from "../Core/Math.js";
import Matrix4 from "../Core/Matrix4.js";
import {
  SOLAR_DISC_SDR_RADIANCE,
  SOLAR_HALO_AMPLITUDE,
  SUN_BRIGHT_PASS_AVG_LUMINANCE,
  solarBrightPassTuning,
  solarDiscBakeEdge,
  solarDiscBakeEdgeLegacy,
  solarDiscHdrRadiance,
  solarHaloCoreRadii,
} from "./SolarDiscModel.js";

const scratchSunEC = new Cartesian4();
const scratchSunClip = new Cartesian4();
// Reused every frame so the bright-pass derivation allocates nothing.
const scratchBrightPass = { threshold: 0.0, offset: 0.0 };

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
    trueRadiance: true,
    // Bake payload — consumed by `SunTextureFS.glsl` (as uniforms) and by
    // `WebGPUEnvironmentRenderer.createSunTexture` (as plain numbers).
    discEdge: 0.0,
    bakeHaloGain: 1.0,
    // The disc's linear radiance, applied in the sun fragment shaders after
    // `czm_gammaCorrect` — `u_discRadiance` on WebGL, the `discRadiance`
    // uniform slot on WebGPU. Not part of the bake, and deliberately not part
    // of `key`: it is a per-frame scalar, so folding it into the rebuild
    // signature would re-run the WebGPU CPU bake every frame that
    // `scene.light` moves, and the `aerialPerspective` path swaps in a
    // continuously varying derived `SunLight`.
    discRadiance: SOLAR_DISC_SDR_RADIANCE,
    // `SunPostProcess` stage-1 bright-pass tuning, derived from
    // `discRadiance`. Exactly (0.25, 0.1) in the SDR position.
    brightPassThreshold: 0.25,
    brightPassOffset: 0.1,
    // Screen-space payload — consumed by the WebGL `SolarHalo` stage inside
    // `SunPostProcess` and by the WebGPU `SunHaloEffect`.
    haloAmplitude: SOLAR_HALO_AMPLITUDE,
    haloCoreRadii: 0.0,
    eclipseFactor: 1.0,
    haloIntensity: 0.0,
    // Halo tint: the same per-channel atmospheric transmittance the disc is
    // multiplied by, `frameState.sunAtmosphereExtinction`. Veiling glare is
    // the observer's response to the light that actually arrives, so a sun
    // reddened by a long slant path must have a reddened halo, and a fully
    // extinguished sun none at all. (1, 1, 1) with the atmosphere hidden.
    haloColorR: 1.0,
    haloColorG: 1.0,
    haloColorB: 1.0,
    // Screen geometry, drawing-buffer pixels, GL convention (y UP from the
    // bottom-left). The WebGPU consumer flips y; see `SolarHalo.wgsl`.
    centerX: 0.0,
    centerY: 0.0,
    limbPx: 0.0,
    visible: false,
    // Whether `centerX/centerY/limbPx` describe a Sun that is in front of the
    // camera with finite geometry. Separate from `visible`, which additionally
    // requires the screen halo to be switched on: the bright-pass glow and the
    // halo are independent stages of the same chain, and an app that turns the
    // halo off still gets a glow around a Sun the projection can locate.
    geometryValid: false,
    // Two-bit bake-rebuild signature: bit 0 = true disc size, bit 1 = the
    // bake still owns the halo. Both bakes rebuild their texture when it
    // changes, exactly as they do for `sunDiscAppearance.key`.
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
 * Resolves the disc-size and halo-source decisions for this frame.
 *
 * The toggles live on the same `atmosphericConditions.lighting` leaf as the
 * disc-appearance pair and follow the same `!== false` convention — on
 * without a facade — with an exact identity in the off position:
 *
 *   `enableTrueSolarDiscSize === false`  -> `discEdge` is
 *      `0.5 / (1 + 2*glowLengthTS)` exactly, the undersized disc, bit for
 *      bit.
 *   `enableScreenSpaceSunHalo === false` -> `bakeHaloGain = 1` and
 *      `haloIntensity = 0`: the halo stays in the bake and no screen-space
 *      stage runs.
 *   `enableTrueSolarRadiance === false`  -> `discRadiance = 1.0` and the
 *      `(0.25, 0.1)` bright-pass pair, an exact identity in both dynamic
 *      ranges.
 *
 * With all three false the sun bake is byte-identical on both backends and no
 * post-process stage is added.
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
  // The third toggle on the same leaf, same `!== false` convention. Off pins
  // the disc radiance at exactly 1.0 and the bright pass at (0.25, 0.1),
  // which together make the radiance path an identity in both dynamic
  // ranges — the escape hatch for an app that wants an unbrightened sun
  // without leaving HDR.
  const trueRadiance = lighting?.enableTrueSolarRadiance !== false;

  // The screen-space halo only exists where the post-process chain that draws
  // it actually runs. `frameState.sunBloomActive` is published by
  // `Scene.updateEnvironment` from `scene.sunBloom`, the same flag that gates
  // `SunPostProcess` on WebGL and `SunHaloEffect` on WebGPU. Reading it here
  // is what keeps `bakeHaloGain` honest: an app that sets `sunBloom = false`
  // keeps the baked halo instead of silently losing the sun's glow.
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

  // The disc's linear radiance, and the bright-pass pair derived from it.
  // Resolved here, with the rest of the sun's per-frame appearance, so the
  // WebGL uniform, the WebGPU uniform slot and the `SunPostProcess` stage all
  // read one number instead of three derivations of it.
  result.trueRadiance = trueRadiance;
  result.discRadiance = trueRadiance
    ? solarDiscHdrRadiance(frameState?.useHDR === true, frameState?.light)
    : SOLAR_DISC_SDR_RADIANCE;
  solarBrightPassTuning(
    result.discRadiance,
    SUN_BRIGHT_PASS_AVG_LUMINANCE,
    scratchBrightPass,
  );
  result.brightPassThreshold = scratchBrightPass.threshold;
  result.brightPassOffset = scratchBrightPass.offset;

  // `SOLAR_HALO_AMPLITUDE` is the bake's own 0.75 glare weight, adopted by
  // the screen halo so the two compositions are continuous at the centre.
  // That continuity holds only for a disc whose composited peak is 1.0: once
  // the disc peaks at `discRadiance`, an unscaled 0.75 halo is
  // `0.75 / discRadiance` of the disc — less than half as glowing as the
  // glare curve says at the shipped radiance, and worse for any app that
  // brightens its light. Scaling by the same scalar the disc is scaled by
  // keeps the continuity an identity rather than a coincidence at one
  // radiance.
  result.haloAmplitude = SOLAR_HALO_AMPLITUDE * result.discRadiance;
  result.haloCoreRadii = solarHaloCoreRadii(glowLengthTS);

  // The eclipse factor multiplies the halo's amplitude, which for a
  // synthesised halo is its input. `sunEclipseAlpha` is published by
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

  result.geometryValid = geometryOk;
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
// Default export required by the generated barrel: `packages/engine/index.js`
// is produced by `scripts/build.js`, which emits `export { default as X }`
// for every `Source/**/*.js` with no exclusion mechanism, so a module with
// named exports only fails `npx gulp build` with "No matching export ... for
// import default". `npx tsc --noEmit` does not catch it, because it never
// checks the generated barrel; a gulp build is the only gate for this class.
export default readSunHaloAppearance;
