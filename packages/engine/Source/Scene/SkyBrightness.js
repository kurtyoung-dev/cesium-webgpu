/**
 * CPU-side estimator that maps sun + moon altitude (relative to the local
 * up at the camera) to a 0..1 sky brightness scalar. Phase 1.3 of the
 * celestial atmosphere design uses this to drive star modulation in the
 * cubemap panorama shader and (later) night-sky dimming in the sky
 * atmosphere shader.
 *
 * The estimate is intentionally cheap — a few dot products and two
 * smoothsteps — so it can run unconditionally in `Scene.updateFrameState()`
 * once per frame. A GPU readback of actual rendered sky color would be
 * more accurate but cost an extra round-trip; for star modulation this
 * approximation is indistinguishable from the truth at any reasonable
 * viewing distance.
 *
 * Why not put this on `AtmosphericConditions`? It's a derived per-frame
 * value, not a configuration knob. The B-series toggles live on
 * `AtmosphericConditions`; the *result* of running them lives on
 * `frameState`.
 *
 * @private
 * @module SkyBrightness
 */

import defined from "../Core/defined.js";

/**
 * Standard smoothstep — same Hermite curve `smoothstep` from GLSL/WGSL.
 *
 * @param {number} edge0
 * @param {number} edge1
 * @param {number} x
 * @returns {number}
 * @private
 */
function smoothstep(edge0, edge1, x) {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

/**
 * Compute the sky brightness scalar for the current frame.
 *
 * The model is two-source: a daylight term driven by the sun's altitude
 * relative to the local horizon, and a moon term scaled by the moon's
 * altitude AND its illuminated fraction (so a new moon contributes
 * nothing even when overhead).
 *
 * Local up is approximated as the normalized camera position vector,
 * which is exact on a sphere and within sub-degree of accurate on the
 * WGS84 ellipsoid for any near-surface camera. Off-planet cameras
 * (lunar orbit, deep space) get the same formula — the result is
 * still meaningful as "how bright the sky LOOKS to me here".
 *
 * @param {Cartesian3|undefined} sunDirWC Sun direction in world (ECEF)
 *   coordinates, normalized. Pass `undefined` to skip sun contribution.
 * @param {Cartesian3|undefined} moonDirWC Moon direction in world (ECEF)
 *   coordinates, normalized. Pass `undefined` to skip moon contribution.
 *   On the first frame this is `undefined` because `Moon.update()` has
 *   not yet run; subsequent frames see the previous frame's value, which
 *   is visually indistinguishable from the current value at any
 *   reasonable simulation rate.
 * @param {number} moonPhaseFraction Moon illuminated fraction in [0..1].
 *   0 = new moon (no contribution), 1 = full moon. When `enableMoonPhase`
 *   is off this should be passed as `1.0` so the moon term acts as a
 *   constant (matching the legacy "always-full" assumption).
 * @param {Cartesian3} cameraPositionWC Camera position in world coords,
 *   used to derive local up. Must be non-zero — the function returns
 *   `1.0` (full bright) for a degenerate origin camera.
 * @returns {number} Sky brightness in [0..1]. `0` = full astronomical
 *   night, `1` = noon under a clear sky.
 */
export function computeSkyBrightness(
  sunDirWC,
  moonDirWC,
  moonPhaseFraction,
  cameraPositionWC,
) {
  if (!defined(cameraPositionWC)) {
    return 1.0;
  }

  const upX = cameraPositionWC.x;
  const upY = cameraPositionWC.y;
  const upZ = cameraPositionWC.z;
  const upMag = Math.sqrt(upX * upX + upY * upY + upZ * upZ);
  if (upMag < 1e-6) {
    // Camera at the planet center — no meaningful "up" direction.
    // Return full bright so star modulation doesn't dim everything to
    // black for a misconfigured scene.
    return 1.0;
  }
  const invMag = 1.0 / upMag;
  const upXn = upX * invMag;
  const upYn = upY * invMag;
  const upZn = upZ * invMag;

  // Sun contribution. The transition from -0.1 to +0.4 cosθ covers
  // astronomical twilight (sun ~6° below horizon) up through "sun
  // fully clear of the horizon haze." Below the lower edge the sky
  // is dark; above the upper edge it's full daylight.
  let sunContrib = 0;
  if (defined(sunDirWC)) {
    const sunAlt = sunDirWC.x * upXn + sunDirWC.y * upYn + sunDirWC.z * upZn;
    sunContrib = smoothstep(-0.1, 0.4, sunAlt);
  }

  // Moon contribution. The visual brightness of the full moon is
  // ~1/400000 of the sun, but for star modulation we care about
  // perceived sky brightness, where moonlight scattering through the
  // atmosphere reads as ~3-5% of full daylight to a dark-adapted eye.
  // We use 4% with phase scaling — full moon overhead at midnight
  // gives skyBrightness ~0.04, enough to dim the brightest stars but
  // leave most of the field visible.
  let moonContrib = 0;
  if (defined(moonDirWC) && moonPhaseFraction > 0) {
    const moonAlt =
      moonDirWC.x * upXn + moonDirWC.y * upYn + moonDirWC.z * upZn;
    const moonAboveHorizon = smoothstep(-0.05, 0.15, moonAlt);
    moonContrib = moonAboveHorizon * moonPhaseFraction * 0.04;
  }

  const total = sunContrib + moonContrib;
  return total < 1.0 ? total : 1.0;
}

export default computeSkyBrightness;
