/**
 * Geometry model for NEW-WEBGPU-GROUND-FOG-RENDERS-NOTHING.
 *
 * The DENSITY arithmetic is NOT re-implemented here — `ground-fog-band.spec.mjs`
 * imports the shipped functions out of
 * `packages/engine/Source/Renderer/WebGPU/WebGPUGroundFogBand.ts`. What lives in
 * this file is only the scene geometry the shipped functions are evaluated
 * against: WGS84 positions, the froxel-altitude reconstruction that
 * `VolumetricFog.wgsl::densityInjection` performs, and a march that turns a
 * per-metre extinction field into the optical depth a view ray accumulates.
 *
 * The camera is `probe-ground-fog.mjs`'s: 10.5E 46.4N at 3500 m, heading north,
 * pitch -8 deg, 1280x720 with Cesium's default 60 deg vertical field of view. The
 * probe scores the bottom 30% of rows against the top 30%, so those two row
 * groups map to two elevation ranges and this model marches both.
 */

// WGS84, the ellipsoid Cesium ships as its default.
export const WGS84 = {
  a: 6378137.0,
  b: 6356752.314245,
};

/** The inscribed sphere `VolumetricFog.wgsl` measures froxel altitude from. */
export const INNER_RADIUS = WGS84.b;

/** `probe-ground-fog.mjs`'s camera. */
export const PROBE_CAMERA = {
  longitudeDeg: 10.5,
  latitudeDeg: 46.4,
  heightMeters: 3500,
  pitchDeg: -8,
  headingDeg: 0,
  verticalFovDeg: 60,
};

/**
 * The lower-band mean the defect report measured (identical with fog on and
 * off). Used as the scene luminance a fog contribution has to move by at least
 * one 8-bit count to be visible at all.
 */
export const MEASURED_LOWER_BAND_MEAN = 101.31;

const toRadians = (degrees) => (degrees * Math.PI) / 180;

/**
 * ECEF position for a geodetic coordinate on WGS84.
 *
 * @param {number} latitudeDeg Geodetic latitude in degrees.
 * @param {number} longitudeDeg Longitude in degrees.
 * @param {number} heightMeters Height above the ellipsoid in metres.
 * @returns {{x: number, y: number, z: number}} ECEF position in metres.
 */
export function ecefFromGeodetic(latitudeDeg, longitudeDeg, heightMeters) {
  const phi = toRadians(latitudeDeg);
  const lambda = toRadians(longitudeDeg);
  const eSquared = 1 - (WGS84.b * WGS84.b) / (WGS84.a * WGS84.a);
  const sinPhi = Math.sin(phi);
  const n = WGS84.a / Math.sqrt(1 - eSquared * sinPhi * sinPhi);
  return {
    x: (n + heightMeters) * Math.cos(phi) * Math.cos(lambda),
    y: (n + heightMeters) * Math.cos(phi) * Math.sin(lambda),
    z: (n * (1 - eSquared) + heightMeters) * sinPhi,
  };
}

/**
 * Everything `WebGPUVolumetricFogRenderer.update()` derives from the camera
 * position before it packs the altitude uniforms.
 *
 * @param {number} latitudeDeg Geodetic latitude in degrees.
 * @param {number} longitudeDeg Longitude in degrees.
 * @param {number} heightMeters Height above the ellipsoid in metres.
 * @returns {object} Camera frame: ECEF position, radial unit vector, geocentric
 *   magnitude, the inscribed-sphere altitude and the curvature denominator.
 */
export function cameraFrame(latitudeDeg, longitudeDeg, heightMeters) {
  const position = ecefFromGeodetic(latitudeDeg, longitudeDeg, heightMeters);
  const magnitude = Math.hypot(position.x, position.y, position.z);
  const unit = {
    x: position.x / magnitude,
    y: position.y / magnitude,
    z: position.z / magnitude,
  };
  return {
    position,
    unit,
    magnitude,
    cameraAltitude: magnitude - INNER_RADIUS,
    oneOverDenom: 1 / (2 * magnitude),
    latitudeDeg,
    longitudeDeg,
    heightMeters,
  };
}

/**
 * `densityInjection`'s 2nd-order Taylor altitude for a froxel at `offset` from
 * the camera, in metres above the INSCRIBED SPHERE.
 *
 * @param {object} frame A {@link cameraFrame}.
 * @param {{x: number, y: number, z: number}} offset Offset from the camera in metres.
 * @returns {number} Altitude above the inscribed sphere, clamped at 0 as the shader does.
 */
export function froxelAltitude(frame, offset) {
  const d = Math.hypot(offset.x, offset.y, offset.z);
  const cosGamma =
    d < 1e-6
      ? 0
      : (offset.x * frame.unit.x +
          offset.y * frame.unit.y +
          offset.z * frame.unit.z) /
        Math.max(d, 1e-6);
  const deltaLinear = d * cosGamma;
  const deltaCurvature = d * d * (1 - cosGamma * cosGamma) * frame.oneOverDenom;
  return Math.max(0, frame.cameraAltitude + deltaLinear + deltaCurvature);
}

/**
 * Local east/north/up basis at the camera. `up` is the RADIAL direction, which
 * is the one the froxel altitude frame uses.
 *
 * @param {object} frame A {@link cameraFrame}.
 * @returns {{east: object, north: object, up: object}} Orthonormal local basis.
 */
export function localBasis(frame) {
  const up = frame.unit;
  const eastRaw = { x: -up.y, y: up.x, z: 0 };
  const eastLength = Math.hypot(eastRaw.x, eastRaw.y, eastRaw.z);
  const east = {
    x: eastRaw.x / eastLength,
    y: eastRaw.y / eastLength,
    z: eastRaw.z / eastLength,
  };
  const north = {
    x: up.y * east.z - up.z * east.y,
    y: up.z * east.x - up.x * east.z,
    z: up.x * east.y - up.y * east.x,
  };
  return { east, north, up };
}

/**
 * A unit view direction at a given elevation above the local horizon, on the
 * heading-north vertical plane the probe looks along.
 *
 * @param {object} frame A {@link cameraFrame}.
 * @param {number} elevationDeg Elevation above the local horizon in degrees.
 * @returns {{x: number, y: number, z: number}} Unit direction in ECEF.
 */
export function viewDirection(frame, elevationDeg) {
  const { north, up } = localBasis(frame);
  const e = toRadians(elevationDeg);
  const c = Math.cos(e);
  const s = Math.sin(e);
  return {
    x: north.x * c + up.x * s,
    y: north.y * c + up.y * s,
    z: north.z * c + up.z * s,
  };
}

/**
 * The elevation range a row band of the probe's frame subtends.
 *
 * @param {number} fromFraction Row fraction at the START of the band (0 = top).
 * @param {number} toFraction Row fraction at the END of the band.
 * @param {object} [camera] Camera description; defaults to {@link PROBE_CAMERA}.
 * @returns {{topDeg: number, bottomDeg: number}} Elevations in degrees.
 */
export function bandElevations(
  fromFraction,
  toFraction,
  camera = PROBE_CAMERA,
) {
  const half = camera.verticalFovDeg / 2;
  const at = (fraction) =>
    camera.pitchDeg + half - fraction * camera.verticalFovDeg;
  return { topDeg: at(fromFraction), bottomDeg: at(toFraction) };
}

/**
 * March one view ray and accumulate the optical depth the ground-fog band adds.
 *
 * The march stops at the TERRAIN surface — the composite only samples the
 * volume up to the scene depth, so froxels behind opaque geometry contribute
 * nothing — or at `maxDistance`. `terrainAltitude` is therefore separate from
 * the fog's `referenceAltitude`: the mutation cases move the fog datum without
 * moving the ground the ray actually stops at.
 *
 * @param {object} options Options.
 * @param {object} options.frame A {@link cameraFrame}.
 * @param {{x: number, y: number, z: number}} options.direction Unit view direction.
 * @param {Function} options.boost The shipped `groundFogDensityBoost`.
 * @param {number} options.intensity Ground-fog intensity, 0..1.
 * @param {number} options.peakDensity Extinction at the datum for intensity 1.
 * @param {number} options.bandHeight Band falloff scale in metres.
 * @param {number} options.referenceAltitude Ground datum, inscribed-sphere frame.
 * @param {number} [options.terrainAltitude] Terrain surface in the same frame;
 *   defaults to `referenceAltitude`.
 * @param {number} [options.maxDistance] March cap in metres.
 * @param {number} [options.stepMeters] Integration step in metres.
 * @returns {{opticalDepth: number, transmittance: number, marchedMeters: number,
 *   hitGround: boolean}} The accumulated march.
 */
export function marchOpticalDepth({
  frame,
  direction,
  boost,
  intensity,
  peakDensity,
  bandHeight,
  referenceAltitude,
  terrainAltitude,
  maxDistance = 50000,
  stepMeters = 5,
}) {
  const ground = terrainAltitude ?? referenceAltitude;
  let opticalDepth = 0;
  let marched = 0;
  let hitGround = false;
  for (let d = stepMeters * 0.5; d < maxDistance; d += stepMeters) {
    const offset = {
      x: direction.x * d,
      y: direction.y * d,
      z: direction.z * d,
    };
    const altitude = froxelAltitude(frame, offset);
    if (altitude < ground) {
      hitGround = true;
      break;
    }
    opticalDepth +=
      boost(intensity, peakDensity, bandHeight, altitude, referenceAltitude) *
      stepMeters;
    marched = d;
  }
  return {
    opticalDepth,
    transmittance: Math.exp(-opticalDepth),
    marchedMeters: marched,
    hitGround,
  };
}

/**
 * The worst (largest) optical depth any ray in a row band accumulates, plus the
 * band mean — the probe scores a band mean, so both are reported.
 *
 * @param {object} options Same options as {@link marchOpticalDepth} minus
 *   `direction`, plus `fromFraction`/`toFraction` row bounds and `rayCount`.
 * @returns {{max: number, mean: number, rays: object[]}} Band statistics.
 */
export function bandOpticalDepth({
  fromFraction,
  toFraction,
  rayCount = 9,
  ...options
}) {
  const { topDeg, bottomDeg } = bandElevations(fromFraction, toFraction);
  const rays = [];
  for (let i = 0; i < rayCount; i++) {
    const t = rayCount === 1 ? 0.5 : i / (rayCount - 1);
    const elevationDeg = topDeg + (bottomDeg - topDeg) * t;
    const march = marchOpticalDepth({
      ...options,
      direction: viewDirection(options.frame, elevationDeg),
    });
    rays.push({ elevationDeg, ...march });
  }
  return {
    max: Math.max(...rays.map((r) => r.opticalDepth)),
    mean: rays.reduce((sum, r) => sum + r.opticalDepth, 0) / rays.length,
    rays,
  };
}

/**
 * How many 8-bit counts an optical depth moves a pixel of the measured scene
 * luminance. Attenuation alone, ignoring in-scatter, so it is a LOWER bound on
 * the change a frame differ would see.
 *
 * @param {number} opticalDepth Accumulated optical depth.
 * @param {number} [sceneLuminance] Scene luminance in 0..255.
 * @returns {number} Change in 8-bit counts.
 */
export function eightBitCounts(
  opticalDepth,
  sceneLuminance = MEASURED_LOWER_BAND_MEAN,
) {
  return (1 - Math.exp(-opticalDepth)) * sceneLuminance;
}

/**
 * Meteorological visibility implied by an extinction coefficient (the inverse
 * of the Koschmieder relation the engine constant is derived from).
 *
 * @param {number} extinction Extinction per metre.
 * @returns {number} Visibility in metres.
 */
export function visibilityForExtinction(extinction) {
  return 3.912 / extinction;
}
