import defined from "../Core/defined.js";

/**
 * The celestial-reflection control law, shared by the two oceans.
 *
 * Both water surfaces reflect the Sun and the Moon through the same microfacet
 * lobe: the opt-in FFT surface in <code>Shaders/WebGPU/Ocean/OceanSurface.wgsl</code>
 * and the globe's own water-mask ocean in
 * <code>Shaders/WebGPU/Globe/GlobeTerrain.wgsl</code>. They pack their uniforms
 * into different buffers and reach different shaders, but the values they pack
 * are resolved here, once. Two copies of a clamp, a floor and a stale-bearing
 * guard would drift, and the drift would be invisible until the two oceans
 * disagreed in a scene showing both.
 *
 * The module is a leaf under <code>Scene/</code> with a single
 * <code>Core/defined</code> import, so the WebGPU renderer's camera-uniform
 * packer can reach it the same way it already reaches
 * <code>isUndergroundVisible</code>.
 *
 * @module CelestialWaterReflection
 * @private
 */

/**
 * Sine of the Sun's mean angular radius, 959.63 arcseconds. The reflected disc
 * has a finite width, and the shader uses this to put a floor under the
 * microfacet lobe so smooth water cannot collapse the glint to a spike. Each
 * body carries its own: the two discs are famously close, and relying on that
 * coincidence would be relying on a coincidence.
 *
 * @type {number}
 * @private
 */
const CELESTIAL_SUN_SIN_ANGULAR_RADIUS = 0.0046524;

/**
 * Sine of the Moon's mean angular radius, 932.58 arcseconds.
 *
 * @type {number}
 * @private
 */
const CELESTIAL_MOON_SIN_ANGULAR_RADIUS = 0.0045213;

/**
 * Default weight of the reflected lunar disc. Full moonlight is about four
 * millionths of noon sunlight, which is not what this number is: the ocean's
 * radiance is not calibrated in physical units, so this is an appearance dial
 * chosen to read as moonlight beside the tone-mapped night water rather than a
 * ratio derived from illuminance. Deriving it belongs with an HDR-calibrated
 * ocean radiance, which does not exist yet.
 *
 * @type {number}
 * @private
 */
const CELESTIAL_DEFAULT_MOON_INTENSITY = 0.35;

/**
 * Default weight of the reflected solar disc.
 *
 * @type {number}
 * @private
 */
const CELESTIAL_DEFAULT_SUN_INTENSITY = 1.0;

/**
 * Base roughness of the near water, and the range both shaders share.
 *
 * @type {number}
 * @private
 */
const CELESTIAL_DEFAULT_ROUGHNESS = 0.06;

/**
 * @type {number}
 * @private
 */
const CELESTIAL_MIN_ROUGHNESS = 0.02;

/**
 * @type {number}
 * @private
 */
const CELESTIAL_MAX_ROUGHNESS = 1.0;

/**
 * The resolved tail, in the packing order both shaders declare.
 *
 * @typedef {object} CelestialWaterTail
 * @property {number} enable 1 while the feature is on, exactly 0 otherwise.
 * @property {number} roughness Base microfacet roughness of the near water.
 * @property {number} sunIntensity Multiplier on the reflected solar disc.
 * @property {number} sinAngularRadius Sine of the Sun's angular radius.
 * @property {{x: number, y: number, z: number}} moonDirection Unit direction to
 *   the Moon in whichever frame the caller supplied, or exact zeros.
 * @property {number} moonPhase Illuminated fraction, 0 at new Moon.
 * @property {number} moonIntensity Multiplier on the reflected lunar disc.
 * @property {number} moonSinAngularRadius Sine of the Moon's angular radius.
 * @private
 */

/**
 * Resolve the celestial-reflection uniform tail.
 *
 * Every field is exactly 0 while the feature is off — not merely small — so
 * nothing either shader reads differs from what it read before the tail
 * existed, and both fragments stay on the highlight they have always drawn.
 *
 * The Moon's direction is supplied by the caller in the frame its shader wants:
 * world coordinates for the FFT surface, eye coordinates for the globe. The
 * frame is the caller's business; the guard against a stale one is not. The
 * engine clears the illuminated fraction every frame and only a Moon that
 * actually updated writes it back, so a zero fraction is the engine's own
 * statement that there is no Moon this frame — while the direction beside it
 * may still hold the last one's. Zeroing the direction on that signal is what
 * keeps a stale bearing from steering a glint.
 *
 * @param {object} controls The requested controls.
 * @param {boolean} controls.enabled Whether the feature is on. Only a strict
 *   <code>true</code> enables; a truthy value is not enough.
 * @param {number} [controls.roughness] Requested base roughness.
 * @param {number} [controls.sunIntensity] Requested solar multiplier.
 * @param {number} [controls.moonIntensity] Requested lunar multiplier.
 * @param {{x: number, y: number, z: number}} [moonDirection] Direction to the
 *   Moon, of any magnitude; normalised here because neither shader normalises
 *   it. Absent means no Moon.
 * @param {number} [moonPhaseFraction] Illuminated fraction of the lunar disc.
 * @returns {CelestialWaterTail} The packed tail.
 * @private
 */
function resolveCelestialWaterTail(controls, moonDirection, moonPhaseFraction) {
  if (controls?.enabled !== true) {
    return {
      enable: 0.0,
      roughness: 0.0,
      sunIntensity: 0.0,
      sinAngularRadius: 0.0,
      moonDirection: { x: 0.0, y: 0.0, z: 0.0 },
      moonPhase: 0.0,
      moonIntensity: 0.0,
      moonSinAngularRadius: 0.0,
    };
  }

  const requestedRoughness = controls.roughness;
  const roughness = Number.isFinite(requestedRoughness)
    ? Math.min(
        Math.max(requestedRoughness, CELESTIAL_MIN_ROUGHNESS),
        CELESTIAL_MAX_ROUGHNESS,
      )
    : CELESTIAL_DEFAULT_ROUGHNESS;

  // A negative multiplier would subtract light from the water rather than
  // dim the disc, so the floor is 0 and not the default.
  const requestedIntensity = controls.sunIntensity;
  const sunIntensity = Number.isFinite(requestedIntensity)
    ? Math.max(requestedIntensity, 0.0)
    : CELESTIAL_DEFAULT_SUN_INTENSITY;

  let moonX = 0.0;
  let moonY = 0.0;
  let moonZ = 0.0;
  let phase = 0.0;
  if (
    defined(moonDirection) &&
    Number.isFinite(moonPhaseFraction) &&
    moonPhaseFraction > 0.0
  ) {
    const magnitude = Math.sqrt(
      moonDirection.x * moonDirection.x +
        moonDirection.y * moonDirection.y +
        moonDirection.z * moonDirection.z,
    );
    if (magnitude > 0.0 && Number.isFinite(magnitude)) {
      // Both shaders consume this direction without normalising it, so the
      // unit length is this seam's obligation.
      moonX = moonDirection.x / magnitude;
      moonY = moonDirection.y / magnitude;
      moonZ = moonDirection.z / magnitude;
      phase = Math.min(moonPhaseFraction, 1.0);
    }
  }

  const requestedMoonIntensity = controls.moonIntensity;
  const moonIntensity = Number.isFinite(requestedMoonIntensity)
    ? Math.max(requestedMoonIntensity, 0.0)
    : CELESTIAL_DEFAULT_MOON_INTENSITY;

  return {
    enable: 1.0,
    roughness: roughness,
    sunIntensity: sunIntensity,
    sinAngularRadius: CELESTIAL_SUN_SIN_ANGULAR_RADIUS,
    moonDirection: { x: moonX, y: moonY, z: moonZ },
    moonPhase: phase,
    moonIntensity: moonIntensity,
    moonSinAngularRadius: CELESTIAL_MOON_SIN_ANGULAR_RADIUS,
  };
}

export {
  CELESTIAL_DEFAULT_MOON_INTENSITY,
  CELESTIAL_DEFAULT_ROUGHNESS,
  CELESTIAL_DEFAULT_SUN_INTENSITY,
  CELESTIAL_MAX_ROUGHNESS,
  CELESTIAL_MIN_ROUGHNESS,
  CELESTIAL_MOON_SIN_ANGULAR_RADIUS,
  CELESTIAL_SUN_SIN_ANGULAR_RADIUS,
  resolveCelestialWaterTail,
};
