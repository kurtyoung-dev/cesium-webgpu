/**
 * Geometry model for NEW-WEBGPU-GROUND-FOG-RENDERS-NOTHING.
 * @purpose Scene-geometry model for the ground-fog fix: WGS84 froxel-altitude reconstruction and the band optical-depth march at the probe's exact camera.
 * @status ACTIVE
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
 * pitch -8 deg, 1280x720 with Cesium's default 60 deg field of view. The
 * probe scores the bottom 30% of rows against the top 30%, so those two row
 * groups map to two elevation ranges and this model marches both.
 *
 * ── What this file models, and what it deliberately does not
 *
 * The composite the frame actually shows is `scene * transmittance +
 * scatteredLight`, so a band optical depth turns into a SIGNED change of
 * `(fogLuminance - sceneLuminance) * (1 - transmittance)`. Attenuation alone
 * ({@link eightBitCounts}) is a DARKENING and is not the quantity the probe
 * scores; {@link compositeDeltaCounts} is. Reading one for the other is what
 * produced the "~40 counts" prediction recorded against a measured +3.6 in
 * NEW-WEBGPU-GROUND-FOG-RENDERS-NOTHING (Batch 844) — see the entry for the
 * settlement.
 *
 * The march here is a FINE quadrature of a LEVEL band over LEVEL ground at the
 * datum. Neither idealisation is free: {@link froxelBandOpticalDepth} models
 * the coarse log-sliced quadrature the shader really integrates, and
 * {@link impliedTerrainOffset} converts a measured shortfall into the height
 * of terrain above the datum that would explain it — the level datum's known
 * failure mode, and the one the rendered frame turned out to be in.
 */

// WGS84, the ellipsoid Cesium ships as its default.
export const WGS84 = {
  a: 6378137.0,
  b: 6356752.314245,
};

/** The inscribed sphere `VolumetricFog.wgsl` measures froxel altitude from. */
export const INNER_RADIUS = WGS84.b;

/**
 * Cesium's VERTICAL field of view. `PerspectiveFrustum.fov` is applied to the
 * WIDER screen axis, so a landscape viewport sees a NARROWER vertical angle
 * than the configured 60 deg — `PerspectiveFrustum.js` computes exactly this
 * (`aspectRatio <= 1 ? fov : 2*atan(tan(fov/2)/aspectRatio)`).
 *
 * This is not a detail: at 1280x720 the true vertical FOV is 35.98 deg, not 60,
 * and the model used to map the probe's row bands to elevations with 60. The
 * rendered frame settles it — the ground-fog delta first appears at row ~216,
 * which is -0.8 deg (just under the horizon) at 35.98 and +12 deg (open sky,
 * where fog cannot reach) at 60.
 *
 * @param {number} fieldOfViewDeg `camera.frustum.fov` in degrees.
 * @param {number} width Viewport width in pixels.
 * @param {number} height Viewport height in pixels.
 * @returns {number} Vertical field of view in degrees.
 */
export function verticalFieldOfView(fieldOfViewDeg, width, height) {
  const aspectRatio = width / height;
  if (aspectRatio <= 1) {
    return fieldOfViewDeg;
  }
  return (
    (2 *
      Math.atan(Math.tan((fieldOfViewDeg * Math.PI) / 360) / aspectRatio) *
      180) /
    Math.PI
  );
}

/** `probe-ground-fog.mjs`'s camera. */
export const PROBE_CAMERA = {
  longitudeDeg: 10.5,
  latitudeDeg: 46.4,
  heightMeters: 3500,
  pitchDeg: -8,
  headingDeg: 0,
  fieldOfViewDeg: 60,
  viewportWidth: 1280,
  viewportHeight: 720,
  verticalFovDeg: verticalFieldOfView(60, 1280, 720),
};

/**
 * The froxel grid the shipped renderer marches on the probe's path: the "low"
 * quality preset (the default, since the VPT auto-tier is opt-in) is
 * 80 x 45 x 64, sliced logarithmically from the camera near plane to
 * `volumetricFog.maxDistance`.
 *
 * `nearMeters` is Cesium's default camera near plane; it only shifts WHICH
 * slice the band lands in, and the conclusion {@link froxelBandOpticalDepth}
 * supports — that the shipped quadrature OVERSHOOTS the ideal integral rather
 * than undershooting it — holds across 0.1, 1 and 10 m (1.09x, 1.51x, 1.38x the
 * fine march at the probe's -20 deg ray).
 */
export const FROXEL_GRID = {
  depthSlices: 64,
  nearMeters: 1.0,
  maxDistanceMeters: 50000,
};

/**
 * The lower-band mean the defect report measured (identical with fog on and
 * off). Used as the scene luminance a fog contribution has to move by at least
 * one 8-bit count to be visible at all.
 */
export const MEASURED_LOWER_BAND_MEAN = 101.31;

/**
 * The Batch 844 acceptance frames, re-measured per pixel.
 *
 * Batch 844 recorded ONE number — the ground band brightened by 3.60 where the
 * derivation had predicted "~40" — and could not say which half of the
 * composite was responsible. Running {@link invertCompositeDelta} over the
 * probe's own `ground-fog-{off,on}-webgpu.png` (277,760 lower-band pixels)
 * separates them, and the answer is not ambiguous:
 *
 *   in-scatter   170.65 counts — the shipped uniforms predict 171.6..215.7
 *                (albedo x (ambient 0.7 + a bounded HG sun term)), so the
 *                scattering half lands on its prediction with NO free
 *                parameter;
 *   transmittance 0.9481, i.e. optical depth 0.0533 against the level-ground
 *                model's 0.687 — the whole shortfall is here.
 *
 * The per-row structure says what causes it: the shortfall is not a constant
 * factor (which is what a diluted composite would give) but swings between 6x
 * and 40x from row to row with terrain, and {@link impliedTerrainOffset} turns
 * that into 220-500 m of terrain standing above the camera's ONE-SCALAR datum.
 * The level band is doing exactly what a level band does in the Alps.
 */
export const BATCH_844_MEASUREMENT = {
  lowerMeanOff: 101.32,
  lowerMeanOn: 104.92,
  lowerBandBrighten: 3.6,
  upperBandBrighten: 0.0,
  // Terrain height beneath the camera, echoed by the probe: Cesium World
  // Terrain at 10.5E 46.4N. The camera therefore sits 1458.7 m above its datum.
  terrainHeightUnderCamera: 2041.31,
  effectiveTransmittance: 0.94811,
  effectiveOpticalDepth: 0.05328,
  inScatterCounts: 170.65,
  // The raw regression sums over the 277,760 ground-band pixels, so the two
  // numbers above are re-derivable from this file alone via
  // {@link invertCompositeSums} rather than being asserted from a write-up.
  lowerBandSums: {
    count: 277760,
    sumScene: 28142488.84440744,
    sumDelta: 999218.9772007887,
    sumSceneScene: 3138436685.3654,
    sumSceneDelta: 86345750.22949111,
  },
};

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
 * How many 8-bit counts of ATTENUATION an optical depth removes from a pixel of
 * the measured scene luminance — the `scene * transmittance` half of the
 * composite, on its own.
 *
 * This is a MAGNITUDE, and on its own it is a DARKENING. It is NOT what
 * `probe-ground-fog.mjs` scores: the probe measures the SIGNED band-mean change
 * of the full composite, which adds the mist's own in-scatter back on top. Use
 * {@link compositeDeltaCounts} for that. Treating this number as the probe's
 * "brighten" is the error the 2026-08-06 calibration question was opened over.
 *
 * @param {number} opticalDepth Accumulated optical depth.
 * @param {number} [sceneLuminance] Scene luminance in 0..255.
 * @returns {number} Attenuation in 8-bit counts (a positive magnitude).
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

// ─────────────────────────────────────────────────────────────────────────────
// The composite, which is what a frame differ actually sees
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `VolumetricFog.wgsl::henyeyGreenstein`, CPU side — including the anisotropy
 * clamp, the physical denominator floor and the phase ceiling the shader
 * applies (the raw glory peak is deliberately not wanted in fog).
 *
 * @param {number} cosTheta Cosine between the view direction and the light.
 * @param {number} g Henyey-Greenstein anisotropy.
 * @returns {number} Phase function value.
 */
export function henyeyGreensteinPhase(cosTheta, g) {
  const gc = Math.min(Math.max(g, -0.95), 0.95);
  const g2 = gc * gc;
  const physicalMinimum = (1 - Math.abs(gc)) * (1 - Math.abs(gc));
  const denominator = Math.max(
    1 + g2 - 2 * gc * cosTheta,
    Math.max(physicalMinimum, 1e-3),
  );
  return Math.min((1 - g2) / (4 * Math.PI * Math.pow(denominator, 1.5)), 4.0);
}

/**
 * The in-scatter SOURCE RADIANCE the scattering pass writes, in 8-bit counts.
 *
 * `sourceRadiance = albedo * (sunScatter + moonScatter + ambient)` with
 * `sunScatter = sunIntensity * HG(cosSun, g) * occlusion`. It is
 * density-INDEPENDENT (Batch 421 moved extinction to the integrate pass), so
 * the whole march contributes `sourceRadiance * (1 - transmittance)` — which is
 * why the composite delta below has exactly two unknowns.
 *
 * @param {object} options Options.
 * @param {{r: number, g: number, b: number}} options.albedo Fog single-scatter albedo.
 * @param {number} options.ambientStrength Flat ambient term (`occlusion.y`).
 * @param {number} options.sunIntensity Sun intensity (the renderer packs 1.0).
 * @param {number} options.cosSunAngle Cosine between the view ray and the sun.
 * @param {number} options.anisotropy Henyey-Greenstein g.
 * @param {number} [options.occlusion] Sun shadow factor; 1 when occlusion is off.
 * @param {number} [options.moonScale] `moonPhase * moonIntensity`.
 * @param {number} [options.cosMoonAngle] Cosine between the view ray and the moon.
 * @returns {number} Source-radiance luminance in 8-bit counts.
 */
export function fogSourceRadianceCounts({
  albedo,
  ambientStrength,
  sunIntensity,
  cosSunAngle,
  anisotropy,
  occlusion = 1.0,
  moonScale = 0.0,
  cosMoonAngle = 0.0,
}) {
  const sunScatter =
    sunIntensity * henyeyGreensteinPhase(cosSunAngle, anisotropy) * occlusion;
  const moonScatter =
    moonScale * henyeyGreensteinPhase(cosMoonAngle, anisotropy);
  const scalar = sunScatter + moonScatter + ambientStrength;
  const luminance =
    0.2126 * (albedo.r * scalar) +
    0.7152 * (albedo.g * scalar) +
    0.0722 * (albedo.b * scalar);
  return luminance * 255;
}

/**
 * The SIGNED change the composite makes to a pixel, in 8-bit counts — the
 * quantity `probe-ground-fog.mjs` scores as `lowerBandBrighten`.
 *
 * `out = scene * T + S` with `S = sourceRadiance * (1 - T)`, so
 * `delta = (fogLuminance - sceneLuminance) * (1 - T)`. A mist BRIGHTER than the
 * terrain it hazes brightens the band; one darker than the terrain darkens it.
 * The magnitude is the DIFFERENCE of two large terms, so a prediction that
 * quotes only the attenuation is not a prediction of this number.
 *
 * @param {number} opticalDepth Band optical depth along the ray.
 * @param {number} sceneLuminance Scene luminance in 0..255.
 * @param {number} fogLuminanceCounts Fog source radiance in 0..255.
 * @returns {number} Signed change in 8-bit counts.
 */
export function compositeDeltaCounts(
  opticalDepth,
  sceneLuminance,
  fogLuminanceCounts,
) {
  return (fogLuminanceCounts - sceneLuminance) * (1 - Math.exp(-opticalDepth));
}

/**
 * Recover BOTH composite unknowns from a rendered pair, by least squares.
 *
 * Per pixel `delta = fogLuminance*(1-T) - scene*(1-T)`, which is linear in the
 * OFF-frame luminance: slope `-(1-T)`, intercept `fogLuminance*(1-T)`. So a
 * regression of (scene, delta) pairs separates the transmittance from the fog's
 * own radiance — which a single band mean cannot do, and which is precisely why
 * the Batch 844 "+3.6 vs ~40" gap could not be settled from band means.
 *
 * The recovered `fogLuminance` is invariant to any uniform scaling of the whole
 * fog contribution, so comparing it against {@link fogSourceRadianceCounts}
 * tests the in-scatter half independently of the optical-depth half.
 *
 * @param {{scene: number[]|Float64Array, delta: number[]|Float64Array}} samples
 *   Per-pixel OFF luminance and (ON - OFF) luminance.
 * @returns {{transmittance: number, opticalDepth: number, fogLuminance: number,
 *   slope: number, intercept: number, count: number}} The inversion.
 */
export function invertCompositeDelta({ scene, delta }) {
  const count = scene.length;
  let sumScene = 0,
    sumDelta = 0,
    sumSceneScene = 0,
    sumSceneDelta = 0;
  for (let i = 0; i < count; i++) {
    sumScene += scene[i];
    sumDelta += delta[i];
    sumSceneScene += scene[i] * scene[i];
    sumSceneDelta += scene[i] * delta[i];
  }
  return invertCompositeSums({
    count,
    sumScene,
    sumDelta,
    sumSceneScene,
    sumSceneDelta,
  });
}

/**
 * {@link invertCompositeDelta} from pre-accumulated sums.
 *
 * The probe accumulates these inside `page.evaluate` over a quarter-million
 * pixels and returns five numbers rather than two quarter-million-element
 * arrays; the inversion itself stays here so there is exactly one copy of it.
 *
 * @param {object} sums Regression sums.
 * @param {number} sums.count Sample count.
 * @param {number} sums.sumScene Sum of OFF luminances.
 * @param {number} sums.sumDelta Sum of (ON - OFF) luminances.
 * @param {number} sums.sumSceneScene Sum of squared OFF luminances.
 * @param {number} sums.sumSceneDelta Sum of OFF luminance times delta.
 * @returns {{transmittance: number, opticalDepth: number, fogLuminance: number,
 *   slope: number, intercept: number, count: number}} The inversion.
 */
export function invertCompositeSums({
  count,
  sumScene,
  sumDelta,
  sumSceneScene,
  sumSceneDelta,
}) {
  const sumX = sumScene;
  const sumY = sumDelta;
  const sumXX = sumSceneScene;
  const sumXY = sumSceneDelta;
  const denominator = count * sumXX - sumX * sumX;
  const slope =
    denominator === 0 ? 0 : (count * sumXY - sumX * sumY) / denominator;
  const intercept = (sumY - slope * sumX) / Math.max(count, 1);
  const transmittance = 1 + slope;
  return {
    slope,
    intercept,
    count,
    transmittance,
    opticalDepth: -Math.log(Math.max(transmittance, 1e-9)),
    fogLuminance: slope < 0 ? intercept / -slope : Number.NaN,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// What the SHIPPED march integrates, as opposed to the ideal integral
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `VolumetricFog.wgsl::sliceToLinearDepth` — the log slice distribution shared
 * by the integrate pass and the composite's depth lookup.
 *
 * @param {number} slice Slice coordinate (may be fractional).
 * @param {object} [grid] Grid description; defaults to {@link FROXEL_GRID}.
 * @returns {number} Linear depth in metres.
 */
export function froxelSliceDepth(slice, grid = FROXEL_GRID) {
  const t = slice / Math.max(grid.depthSlices, 1);
  return (
    grid.nearMeters *
    Math.pow(grid.maxDistanceMeters / Math.max(grid.nearMeters, 1e-3), t)
  );
}

/**
 * The band optical depth the SHIPPED path actually delivers to a pixel: density
 * sampled once per froxel at the slice CENTRE, multiplied by the whole slice
 * thickness, accumulated front-to-back, then read back by the composite with a
 * LINEAR filter at the scene's depth fraction.
 *
 * The slices are ~18% of their own depth (a log distribution over 1 m..50 km in
 * 64 steps), so the slice a 120 m band lives in is several hundred metres thick
 * — the quadrature is coarse where the band is, and the filtered read straddles
 * the terrain boundary, where froxels below the datum carry the clamped PEAK
 * density. Both effects are in here; neither is in the fine march.
 *
 * @param {object} options Options.
 * @param {object} options.frame A {@link cameraFrame}.
 * @param {{x: number, y: number, z: number}} options.direction Unit view direction.
 * @param {Function} options.boost The shipped `groundFogDensityBoost`.
 * @param {number} options.intensity Ground-fog intensity, 0..1.
 * @param {number} options.peakDensity Extinction at the datum for intensity 1.
 * @param {number} options.bandHeight Band falloff scale in metres.
 * @param {number} options.referenceAltitude Ground datum, inscribed-sphere frame.
 * @param {number} [options.terrainAltitude] Terrain surface in the same frame.
 * @param {object} [options.grid] Grid description; defaults to {@link FROXEL_GRID}.
 * @param {number} [options.sliceOffset] Diagnostic shift of the composite's read,
 *   in texels — used to test depth-decode misalignment as a hypothesis.
 * @returns {{opticalDepth: number, marchedOpticalDepth: number,
 *   sceneDistance: number, texel: number}} The delivered optical depth
 *   (`opticalDepth`), the whole-volume march (`marchedOpticalDepth`), and where
 *   the composite read it.
 */
export function froxelBandOpticalDepth({
  frame,
  direction,
  boost,
  intensity,
  peakDensity,
  bandHeight,
  referenceAltitude,
  terrainAltitude,
  grid = FROXEL_GRID,
  sliceOffset = 0,
}) {
  const ground = terrainAltitude ?? referenceAltitude;
  const slices = grid.depthSlices;
  const cumulative = new Float64Array(slices);
  let accumulated = 0;
  let previousDepth = froxelSliceDepth(0, grid);
  for (let k = 0; k < slices; k++) {
    const centre = froxelSliceDepth(k + 0.5, grid);
    const far = froxelSliceDepth(k + 1, grid);
    const thickness = Math.max(far - previousDepth, 0);
    previousDepth = far;
    const altitude = froxelAltitude(frame, {
      x: direction.x * centre,
      y: direction.y * centre,
      z: direction.z * centre,
    });
    accumulated +=
      boost(intensity, peakDensity, bandHeight, altitude, referenceAltitude) *
      thickness;
    cumulative[k] = accumulated;
  }

  // Where the scene surface is, which is where the composite stops.
  let low = 0;
  let high = grid.maxDistanceMeters;
  const altitudeAt = (distance) =>
    froxelAltitude(frame, {
      x: direction.x * distance,
      y: direction.y * distance,
      z: direction.z * distance,
    });
  let sceneDistance = grid.maxDistanceMeters;
  if (altitudeAt(high) < ground) {
    for (let i = 0; i < 120; i++) {
      const middle = 0.5 * (low + high);
      if (altitudeAt(middle) >= ground) low = middle;
      else high = middle;
    }
    sceneDistance = 0.5 * (low + high);
  }

  const fraction = Math.min(
    1,
    Math.max(
      0,
      Math.log(sceneDistance / grid.nearMeters) /
        Math.log(grid.maxDistanceMeters / grid.nearMeters),
    ),
  );
  // Texel centres sit at (k + 0.5) / slices in the sampled coordinate.
  const texel = Math.min(
    slices - 1,
    Math.max(0, fraction * slices - 0.5 + sliceOffset),
  );
  const k0 = Math.floor(texel);
  const k1 = Math.min(slices - 1, k0 + 1);
  const weight = texel - k0;
  // The volume stores TRANSMITTANCE, so that is what the filter interpolates.
  const transmittance =
    Math.exp(-cumulative[k0]) * (1 - weight) +
    Math.exp(-cumulative[k1]) * weight;
  return {
    opticalDepth: -Math.log(Math.max(transmittance, 1e-12)),
    marchedOpticalDepth: accumulated,
    sceneDistance,
    texel,
  };
}

/**
 * How far ABOVE the datum the visible terrain must sit to explain a measured
 * shortfall against the level-ground model.
 *
 * The band is `peak * exp(-height / bandHeight)`, so terrain standing `dh`
 * above the datum removes the part of the column below it and scales the whole
 * optical depth by `exp(-dh / bandHeight)`. Inverting gives the relief the
 * ONE-SCALAR datum is failing to follow — the level band's documented limit,
 * expressed as a number instead of a caveat.
 *
 * @param {number} measuredOpticalDepth Optical depth measured from the frame.
 * @param {number} modelOpticalDepth Level-ground optical depth from the march.
 * @param {number} bandHeight Band falloff scale in metres.
 * @returns {number} Implied terrain height above the datum, in metres.
 */
export function impliedTerrainOffset(
  measuredOpticalDepth,
  modelOpticalDepth,
  bandHeight,
) {
  if (!(modelOpticalDepth > 0) || !(measuredOpticalDepth > 0)) {
    return Number.NaN;
  }
  return -bandHeight * Math.log(measuredOpticalDepth / modelOpticalDepth);
}
