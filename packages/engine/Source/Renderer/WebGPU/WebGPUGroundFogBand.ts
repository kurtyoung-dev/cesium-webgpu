/**
 * Ground-fog band geometry + extinction — the CPU half of the WebGPU froxel
 * fog's near-surface mist (`atmosphericConditions.effects.groundFog`).
 *
 * This module is a LEAF: no imports, pure functions, no GPU types. That is
 * deliberate — `ground-fog-band.spec.mjs` executes these exact functions, so
 * the numbers this file ships and the numbers the spec pins cannot drift.
 *
 * ── Why the band needs its own altitude datum
 * (NEW-WEBGPU-GROUND-FOG-RENDERS-NOTHING)
 *
 * `VolumetricFog.wgsl::densityInjection` reconstructs a froxel's `altitude` as
 * a height above the ellipsoid's INSCRIBED SPHERE (radius = the minimum of the
 * three radii, i.e. the WGS84 polar radius 6,356,752 m). That frame is chosen
 * so a camera over a pole can never produce a negative altitude, and it is
 * perfectly adequate for the base height fog, whose falloff scale is ~10 km:
 * the sphere-vs-ellipsoid offset just scales the density globally.
 *
 * The ground-fog band's falloff scale is ~120 m, and the same offset is 21,385 m
 * at the equator, 10,215 m at 46.4 deg N, and 0 only at the poles. Feeding the raw
 * `altitude` into `exp(-altitude / 120)` therefore evaluates `e^-85` at Alpine
 * latitudes — a denormal (2.1e-40), and an exact f32 zero nearer the equator. The
 * optical depth a ray accumulated over the whole march came to ~1e-44, which left
 * the f32 transmittance at EXACTLY 1.0 and the in-scatter at EXACTLY 0, so the
 * composite's `scene.rgb * transmittance + scatteredLight` returned the scene
 * colour bit for bit. That is the "ground fog renders nothing / the ON frame is
 * byte-identical to OFF" defect, present since Phase C landed in Batch 420.
 *
 * The fix is to express a GROUND DATUM in the same inscribed-sphere frame and
 * subtract it in the shader. The sphere-vs-ellipsoid error is common to both
 * terms, so it cancels exactly and the band lands on the ground it is named
 * for.
 *
 * ── What the datum is
 *
 * The camera-local ground elevation: the ellipsoid's geocentric radius along
 * the camera's radial direction, plus the terrain height directly beneath the
 * camera when a terrain surface can supply one (0 = sea level otherwise). A
 * single scalar per frame, which is the standard cheap approximation for a
 * level fog layer — real radiation fog pools with a roughly flat top, so a
 * level band is closer to the physics than a terrain-following one. Its known
 * limit is a camera parked on a peak high above the valley it is looking at;
 * a per-froxel-column datum reconstructed from the depth buffer is the tracked
 * follow-up (see migration_doc/DEFERRED_WORK.md).
 */

/**
 * Meteorological-visibility -> extinction, the Koschmieder relation with the
 * conventional 2% contrast threshold: `sigma = ln(50) / V = 3.912 / V` per metre.
 *
 * @param visibilityMeters - Meteorological visibility range in metres.
 * @returns Volume extinction coefficient in inverse metres.
 */
export function extinctionForVisibility(visibilityMeters: number): number {
  return 3.912 / Math.max(visibilityMeters, 1.0);
}

/**
 * Exponential falloff scale of the mist band, in metres. ~63% of the column
 * density sits below this height and the boost is negligible above ~3x it,
 * which matches the 30-300 m depth range of real radiation fog.
 */
export const GROUND_FOG_BAND_HEIGHT = 120.0;

/**
 * Extinction at the band core for `intensity = 1`, in inverse metres.
 *
 * DERIVED, not tuned: `extinctionForVisibility(2000)`. 2 km is the mist/fog
 * boundary of the WMO visibility scale, so a fully saturated band reads as a
 * real fog while the near field stays legible — the acceptance criterion for
 * this effect is explicitly "terrain visible THROUGH the haze, not a whiteout".
 * Intensity scales it linearly, so 0.3 -> ~6.7 km visibility (haze) and
 * 0.6 -> ~3.3 km (mist).
 *
 * The previous value (1.2e-4) was tuned in Batch 421 against a whiteout that
 * was DENSITY-INDEPENDENT — the pre-421 integrate pass took a degenerate
 * `select(scattered * sliceThickness, ...)` branch whenever optical depth fell
 * below 1e-6, which is precisely what a zero density does — so it never
 * measured this coefficient at all. 1.2e-4 corresponds to 32 km of visibility:
 * clear air, not fog, and below the 8-bit quantisation floor of a frame.
 */
export const GROUND_FOG_PEAK_EXTINCTION = extinctionForVisibility(2000);

/**
 * Geocentric radius of the ellipsoid surface along a unit direction from the
 * centre. Solving `(R*ux/a)^2 + (R*uy/b)^2 + (R*uz/c)^2 = 1` for R.
 *
 * The froxel altitude frame is radial (it measures `|P| - innerRadius`), so
 * this — not the geodetic normal — is the radius the datum must use for the
 * offset to cancel.
 *
 * @param ux - X of the unit direction from the ellipsoid centre.
 * @param uy - Y of the unit direction.
 * @param uz - Z of the unit direction.
 * @param radiiX - Ellipsoid X semi-axis in metres.
 * @param radiiY - Ellipsoid Y semi-axis in metres.
 * @param radiiZ - Ellipsoid Z semi-axis in metres.
 * @returns Distance from the centre to the ellipsoid surface along the direction.
 */
export function ellipsoidRadiusAlongDirection(
  ux: number,
  uy: number,
  uz: number,
  radiiX: number,
  radiiY: number,
  radiiZ: number,
): number {
  const x = ux / radiiX;
  const y = uy / radiiY;
  const z = uz / radiiZ;
  const denom = Math.sqrt(x * x + y * y + z * z);
  return denom > 0 ? 1 / denom : 0;
}

/**
 * The ground datum the shader subtracts, in metres above the inscribed sphere
 * — the same frame as `cameraAltitudeRTE.w`.
 *
 * Computed in f64 on the CPU and uploaded as one f32: the magnitudes here are
 * ~1e4 m, where an f32 ulp is ~1e-3 m, so the band keeps millimetre precision.
 *
 * @param ux - X of the unit direction from the ellipsoid centre to the camera.
 * @param uy - Y of that unit direction.
 * @param uz - Z of that unit direction.
 * @param radiiX - Ellipsoid X semi-axis in metres.
 * @param radiiY - Ellipsoid Y semi-axis in metres.
 * @param radiiZ - Ellipsoid Z semi-axis in metres.
 * @param innerRadius - The inscribed-sphere radius the froxel altitude frame uses.
 * @param terrainHeight - Terrain height above the ellipsoid beneath the camera;
 *   0 (sea level) when no terrain surface can supply one.
 * @returns The datum in metres above the inscribed sphere.
 */
export function groundFogReferenceAltitude(
  ux: number,
  uy: number,
  uz: number,
  radiiX: number,
  radiiY: number,
  radiiZ: number,
  innerRadius: number,
  terrainHeight: number,
): number {
  const surfaceRadius = ellipsoidRadiusAlongDirection(
    ux,
    uy,
    uz,
    radiiX,
    radiiY,
    radiiZ,
  );
  return surfaceRadius + terrainHeight - innerRadius;
}

/**
 * CPU twin of the WGSL ground-fog density boost, evaluated in f32 so the
 * underflow behaviour matches the GPU exactly.
 *
 * @param intensity - `effects.groundFog.intensity`, 0..1.
 * @param peakDensity - Extinction at the datum for intensity 1 (per metre).
 * @param bandHeight - Exponential falloff scale in metres.
 * @param altitude - Froxel altitude above the inscribed sphere.
 * @param referenceAltitude - The ground datum in the same frame.
 * @returns Extinction added to the froxel, per metre.
 */
export function groundFogDensityBoost(
  intensity: number,
  peakDensity: number,
  bandHeight: number,
  altitude: number,
  referenceAltitude: number,
): number {
  if (!(intensity > 0.0)) {
    return 0.0;
  }
  const band = Math.max(bandHeight, 1.0);
  const heightAboveGround = Math.max(0.0, altitude - referenceAltitude);
  return Math.fround(
    Math.fround(intensity * peakDensity) *
      Math.fround(Math.exp(-heightAboveGround / band)),
  );
}
