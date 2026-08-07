/**
 * C13-16 — the MARCH TRANSFER model. Maintainer ruling R3 (2026-08-06,
 * `migration_doc/DEFERRED_WORK.md#RULING-2026-08-06`).
 *
 * WHY THIS EXISTS, AND WHAT IT IS NOT
 *
 * `lib/cloud-genus-morphology-model.mjs` is the CPU twin of the morphology
 * ARITHMETIC and measures the FIELD: `fibreElongation` samples
 * `genusFibreFactor` alone and recovers 5.743 / 4.543 / 1.964 / 1.000 for
 * CIRRUS / CIRROSTRATUS / CIRROCUMULUS / CUMULUS against authored aspects
 * 9 / 5 / 2 / 1. `probe-cloud-genus-morphology.mjs --phase=direction` measures
 * the INTEGRATED IMAGE and recovered 1.178 / 0.978 / 0.905 / 0.971. Both are
 * correct; they measure different quantities. Gates C, D and E were predicted
 * from the first and scored against the second, which is why all three fail as
 * ONE phenomenon.
 *
 * This module predicts the second. It reconstructs, in Node, the chain that
 * stands between the anisotropic domain and a canvas pixel:
 *
 *   1. a perspective ray per pixel from the probe's camera (nadir, 250 km,
 *      1024x768, Cesium's 60 deg HORIZONTAL fov -> 46.83 deg fovy),
 *   2. its entry/exit against the SHIPPED single shell (1500..4000 m — the
 *      renderer's `cloudLayerBottom`/`cloudLayerTop` defaults, which the probe
 *      does NOT override, so every genus marches the same 2500 m slab),
 *   3. `maxSteps` fine samples along that segment (32 at the probe's
 *      `directionQuality`),
 *   4. at each sample the SHIPPED LIVE density chain — `fbmNoise` base,
 *      `cloudEffectiveCoverage` threshold, `heightGradientFor`, the subtractive
 *      Worley erosion weighted by `genusErosionHeightWeight`, and the
 *      `genusFibreFactor` carve,
 *   5. the march's own saturating transfer, `alpha = 1 - exp(-tau)`, which is
 *      EXACTLY what the shader's per-sample `(1 - sampleTransmittance) *
 *      transmittance` accumulation sums to when the scattered colour is
 *      constant across the column,
 *   6. the probe's OWN estimator (r < 0.5 with linear interpolation between
 *      bracketing lags, 16 parallel lines, `maxLag = sampleCount / 3`),
 *      re-implemented here at the same pixel scale so the numbers are directly
 *      comparable rather than merely both "some correlation statistic".
 *
 * WHAT IS DELIBERATELY OMITTED, AND WHY THE OMISSION IS SAFE FOR THIS METRIC
 *
 *   - The light march, multi-scatter octaves, silver lining, sky/ground ambient
 *     and the HG phase. These modulate the scattered COLOUR per sample. The
 *     metric is a ratio of correlation half-lengths of a zero-mean-removed,
 *     variance-normalised field, so any spatially-slow multiplicative gain
 *     cancels. What does NOT cancel is any structure the light march itself
 *     imprints at the metric's scale — see LIMITATIONS.
 *   - The adaptive coarse/fine march. `ProceduralClouds.wgsl:2237-2241` states
 *     the fine comb is the same grid as the old fixed march and "preserves the
 *     image"; the coarse phase only skips empty space.
 *   - Tone mapping and 8-bit quantisation. Exposed as `clipLevel` /
 *     `radianceScale` so the sensitivity can be measured rather than assumed;
 *     the estimator is invariant to `radianceScale` alone.
 *
 * THE NOISE IS DISTRIBUTION-FAITHFUL, NOT BIT-FAITHFUL, for the reason the
 * genus twin already records: `hash3` / `hash33` evaluate in f32 on a GPU and
 * partly in f64 in Node. Everything measured here is therefore STRUCTURAL — a
 * ratio of correlation lengths — never a sample value.
 *
 * The morphology functions are IMPORTED from `cloud-genus-morphology-model.mjs`
 * rather than restated, so this module cannot drift from the shipped table or
 * from the twin the spec fleet already pins.
 */

import CloudType from "../../../packages/engine/Source/Scene/CloudType.js";
import {
  CLOUD_COVERAGE_ANCHOR,
  CLOUD_COVERAGE_EXPONENT,
  CLOUD_DENSITY_WORLD_TO_NOISE,
  cloudEffectiveCoverage,
} from "../../../packages/engine/Source/Renderer/WebGPU/WebGPUCloudDensityDomain.ts";
import {
  CloudTypeProfile,
  genusErosionHeightWeight,
  genusFibreFactor,
  worleyF1,
} from "./cloud-genus-morphology-model.mjs";

const f32 = Math.fround;

// THE COVERAGE RESPONSE AND THE WORLD->NOISE SCALE ARE IMPORTED, NOT COPIED.
//
// They were local literals plus a local re-statement of `cloudEffectiveCoverage`
// until 2026-08-07. The engine ships all four as an importable CPU twin
// (`WebGPUCloudDensityDomain.ts`), a sibling model in this same fleet
// (`fog-cheap-coverage-model.mjs`) already imports it, and the copy had already
// drifted in ROUNDING — the shipped twin rounds `anchor`, `c / anchor` and the
// `pow` result to f32 the way WGSL evaluates them, the copy did not. Re-deriving
// `CLOUD_COVERAGE_ANCHOR` or `CLOUD_COVERAGE_EXPONENT` in the product (which
// `CLOUD-LOW-COVERAGE-CUTOFF` already did once) would have left this model
// answering R3's transfer-curve question about a coverage gate the engine no
// longer ships, with nothing in the spec able to notice.
//
// Re-exported under the historical names so the spec and any consumer keep one
// import site; `cloud-march-transfer.spec.mjs` asserts these ARE the engine's
// own bindings rather than equal-valued copies.
export {
  cloudEffectiveCoverage,
  CLOUD_COVERAGE_ANCHOR as COVERAGE_ANCHOR,
  CLOUD_COVERAGE_EXPONENT as COVERAGE_EXPONENT,
  CLOUD_DENSITY_WORLD_TO_NOISE as WORLD_TO_NOISE,
};
const WORLD_TO_NOISE = CLOUD_DENSITY_WORLD_TO_NOISE;

/** `WGS84_EQUATORIAL_RADIUS` as the renderer packs `planetRadius`. */
export const PLANET_RADIUS = 6378137.0;
/** `absorptionCoeff`, hard-coded at WebGPUProceduralCloudRenderer.ts:1982. */
export const ABSORPTION_COEFF = 0.04;

/**
 * The probe's camera and canvas, and the renderer defaults the probe does not
 * override. Every value here is read off a shipped artifact — the provenance is
 * in the comment beside it — so a change in the product surfaces as a spec
 * failure rather than as a silently stale constant.
 */
export const PROBE_GEOMETRY = Object.freeze({
  canvasWidth: 1024, // manifest-direction.json `canvasSize`
  canvasHeight: 768,
  cameraHeightMeters: 250_000.0, // probe `CAMERA_HEIGHT`
  fovDegrees: 60.0, // Camera.js:211 — HORIZONTAL, aspect > 1
  shellBottomMeters: 1500.0, // renderer `cloudLayerBottom` default
  shellTopMeters: 4000.0, // renderer `cloudLayerTop` default
});

/**
 * The march + density inputs the probe's `direction` phase runs with.
 */
export const PROBE_MARCH = Object.freeze({
  steps: 32, // `directionQuality: 32` through resolveCloudQuality's escape hatch
  coverage: 0.8, // probe `baseVolumetric.cloudCoverage`
  densityMultiplier: 0.5, // probe `cloudDensity`
  puffSize: 0.45, // renderer `cloudPuffSize` default (LIVE path ignores it)
  anvilBias: 0.0,
});

/**
 * The probe's estimator geometry, taken from the measured run rather than
 * guessed: `contributionBbox` was the FULL frame on all five lanes, so
 * `halfExtent = min(1024, 768) * 0.5 * 0.8 = 307.2`,
 * `sampleCount = min(256, floor(2 * halfExtent)) = 256`,
 * `maxLag = floor(256 / 3) = 85`, and the 16 line offsets span
 * `+/- halfExtent * 0.85 = +/- 261.12` px.
 */
export const PROBE_ESTIMATOR = Object.freeze({
  halfExtent: 307.2,
  sampleCount: 256,
  lineCount: 16,
  lineSpreadFactor: 0.85,
});

/** The measured ground truth this model has to reproduce. */
export const MEASURED_SCREEN_ELONGATION = Object.freeze({
  CUMULUS: Object.freeze({
    cloudType: CloudType.CUMULUS,
    alongLength: 3.5925374949768836,
    acrossLength: 3.6995948332536472,
    elongation: 0.9710624154530427,
  }),
  CIRRUS: Object.freeze({
    cloudType: CloudType.CIRRUS,
    alongLength: 7.676733508288986,
    acrossLength: 6.51479166538404,
    elongation: 1.178354412939842,
  }),
  CIRROSTRATUS: Object.freeze({
    cloudType: CloudType.CIRROSTRATUS,
    alongLength: 7.208795101194443,
    acrossLength: 7.370006421532012,
    elongation: 0.9781260271542535,
  }),
  CIRROCUMULUS: Object.freeze({
    cloudType: CloudType.CIRROCUMULUS,
    alongLength: 6.930084844936492,
    acrossLength: 7.661269984772423,
    elongation: 0.9045608441825914,
  }),
});

function fract(value) {
  return f32(value - Math.floor(value));
}

function clamp(value, low, high) {
  return Math.min(Math.max(value, low), high);
}

function smoothstep(edge0, edge1, x) {
  const t = clamp(f32((x - edge0) / (edge1 - edge0)), 0, 1);
  return f32(t * t * f32(3 - 2 * t));
}

/** ProceduralClouds.wgsl `hash3`. */
function hash3(px, py, pz) {
  let qx = fract(f32(px * 0.1031));
  let qy = fract(f32(py * 0.1031));
  let qz = fract(f32(pz * 0.1031));
  const d = f32(
    f32(qx * f32(qz + 31.32)) +
      f32(qy * f32(qy + 31.32)) +
      f32(qz * f32(qx + 31.32)),
  );
  qx = f32(qx + d);
  qy = f32(qy + d);
  qz = f32(qz + d);
  return fract(f32(f32(qx + qy) * qz));
}

/** ProceduralClouds.wgsl `valueNoise`. */
export function valueNoise(px, py, pz) {
  const ix = Math.floor(px);
  const iy = Math.floor(py);
  const iz = Math.floor(pz);
  const fx = f32(px - ix);
  const fy = f32(py - iy);
  const fz = f32(pz - iz);
  const ux = f32(fx * fx * f32(3 - 2 * fx));
  const uy = f32(fy * fy * f32(3 - 2 * fy));
  const uz = f32(fz * fz * f32(3 - 2 * fz));
  const lerp = (a, b, t) => f32(a + (b - a) * t);
  const c000 = hash3(ix, iy, iz);
  const c100 = hash3(ix + 1, iy, iz);
  const c010 = hash3(ix, iy + 1, iz);
  const c110 = hash3(ix + 1, iy + 1, iz);
  const c001 = hash3(ix, iy, iz + 1);
  const c101 = hash3(ix + 1, iy, iz + 1);
  const c011 = hash3(ix, iy + 1, iz + 1);
  const c111 = hash3(ix + 1, iy + 1, iz + 1);
  return lerp(
    lerp(lerp(c000, c100, ux), lerp(c010, c110, ux), uy),
    lerp(lerp(c001, c101, ux), lerp(c011, c111, ux), uy),
    uz,
  );
}

/** ProceduralClouds.wgsl `fbmNoise` — 5 octaves, +0.13 z drift per octave. */
export function fbmNoise(px, py, pz) {
  let value = 0;
  let amplitude = 0.5;
  let frequency = 1;
  // Only z drifts; the shader's `pos += vec3(0, 0, 0.13)` leaves x and y alone.
  let z = pz;
  for (let i = 0; i < 5; i++) {
    value = f32(
      value +
        f32(
          amplitude *
            valueNoise(
              f32(px * frequency),
              f32(py * frequency),
              f32(z * frequency),
            ),
        ),
    );
    frequency = f32(frequency * 2);
    amplitude = f32(amplitude * 0.5);
    z = f32(z + 0.13);
  }
  return value;
}

/** ProceduralClouds.wgsl `heightGradientFor`. */
export function heightGradientFor(h, shape, anvil) {
  if (shape < 0.5) {
    return f32(smoothstep(0.0, 0.08, h) * smoothstep(1.0, 0.92, h));
  }
  if (shape < 1.5) {
    return f32(smoothstep(0.0, 0.15, h) * smoothstep(1.0, 0.7, h));
  }
  const base = smoothstep(0.0, 0.12, h);
  const anvilTop = smoothstep(
    1.0,
    f32(0.85 + (0.6 - 0.85) * clamp(anvil, 0, 1)),
    h,
  );
  return f32(base * anvilTop);
}

/**
 * The per-genus march inputs the renderer derives from the SHIPPED profile
 * table — not restated here, read from `CloudTypeProfile` so the model tracks
 * the product.
 *
 * @param {number} cloudType A {@link CloudType} genus.
 * @returns {object} `{row, profileShape, profileDensityScale, profileExtinction}`.
 */
export function genusMarchParameters(cloudType) {
  const profile = CloudTypeProfile.get(cloudType);
  const cumulus = CloudTypeProfile.get(CloudType.CUMULUS);
  return {
    row: CloudTypeProfile.getFibreMorphology(cloudType),
    profileShape: profile.shape,
    profileDensityScale:
      cumulus.baseDensity > 0 ? profile.baseDensity / cumulus.baseDensity : 1,
    profileExtinction:
      cumulus.extinction > 0 ? profile.extinction / cumulus.extinction : 1,
  };
}

/**
 * ProceduralClouds.wgsl `legacyCloudDensity`, LIVE branch (the probe's escape
 * hatch forces `noiseSource: LIVE`, so the baked texture branch is dead here),
 * with the weather map off (`weatherMapEnabled` 0 -> densityScale 1,
 * baseShiftFrac 0, perGenusShape = profileShape) and wind speed 0.
 *
 * @param {number[]} sp Noise-space sample position.
 * @param {number} h Shell height fraction.
 * @param {object} p Model parameters.
 * @returns {number} Density, including the density and profile multipliers.
 */
export function marchedDensity(sp, h, p) {
  let density = fbmNoise(sp[0], sp[1], sp[2]);
  if (p.includeBaseField === false) {
    // MUTATION lane: replace the isotropic base with its own mean so the fibre
    // carve is the only structure left. Not a product path.
    density = 0.484375;
  }
  density = smoothstep(
    f32(1 - cloudEffectiveCoverage(p.coverage)),
    1.0,
    density,
  );
  const heightGradient = heightGradientFor(h, p.profileShape, p.anvilBias);
  density = f32(density * heightGradient);
  if (p.includeErosion !== false) {
    const worleyDetail = worleyF1(
      f32(sp[0] * 5),
      f32(sp[1] * 5),
      f32(sp[2] * 5),
    );
    density = f32(
      density -
        f32(
          f32(worleyDetail * 0.18) *
            genusErosionHeightWeight(h, p.row.strength),
        ),
    );
    density = Math.max(density, 0);
  }
  let fibre = 1;
  if (p.includeFibre !== false) {
    // `fibreFrequencyScale` is a WHAT-IF lever, not a product path. Because
    // `genusFibreFactor` builds its domain as `vec3(along/aspect, sp.y*0.35,
    // acr) * FIBRE_DOMAIN_FREQUENCY`, pre-scaling `sp` by k is exactly
    // equivalent to authoring `FIBRE_DOMAIN_FREQUENCY = 3.0 * k` — including
    // the shear term, which is also linear in the horizontal coordinate. It is
    // spelled this way so the shipped `genusFibreFactor` stays the single
    // definition of the carve rather than being forked for a study.
    const k = p.fibreFrequencyScale;
    const scaled =
      k === 1 ? sp : [f32(sp[0] * k), f32(sp[1] * k), f32(sp[2] * k)];
    const row = k === 1 ? p.row : { ...p.row, shear: f32(p.row.shear * k) };
    fibre = genusFibreFactor(scaled, h, row, p.windDirection);
  }
  return f32(
    f32(f32(density * p.densityMultiplier) * p.profileDensityScale) * fibre,
  );
}

/**
 * Optical depth of ONE pixel's column, i.e. the quantity the march integrates.
 *
 * @param {number} screenX Pixel offset from the frame centre, +right.
 * @param {number} screenY Pixel offset from the frame centre, +down.
 * @param {object} p Model parameters (see {@link buildModelParameters}).
 * @returns {number} `tau`; the image value is `1 - exp(-tau)`.
 */
export function columnOpticalDepth(screenX, screenY, p) {
  // Screen -> world ray. Local frame at lon 90 / lat 0: up is ECEF +Y, screen
  // right is ECEF -X and screen up is ECEF +Z (verified against the probe's own
  // `projectedWindAzimuthDeg`, which reported wind (1,0) at screen azimuth 0 and
  // wind (0,1) at 90). Sign conventions cannot move a correlation LENGTH; they
  // are kept faithful so the fallstreak shear keeps its downwind sense.
  const u = (screenX / (p.canvasWidth / 2)) * p.tanHalfFovX;
  const v = (-screenY / (p.canvasHeight / 2)) * p.tanHalfFovY;
  // forward = (0,-1,0); right = (-1,0,0); up = (0,0,1).
  let dx = -u;
  let dy = -1;
  let dz = v;
  const inverseLength = 1 / Math.sqrt(dx * dx + dy * dy + dz * dz);
  dx *= inverseLength;
  dy *= inverseLength;
  dz *= inverseLength;

  const originY = PLANET_RADIUS + p.cameraHeightMeters;
  const outer = PLANET_RADIUS + p.shellTopMeters;
  const inner = PLANET_RADIUS + p.shellBottomMeters;
  // Ray-sphere from (0, originY, 0). b = dot(o, d) = originY * dy.
  const b = originY * dy;
  const originSquared = originY * originY;
  const hit = (radius) => {
    const disc = b * b - (originSquared - radius * radius);
    if (disc < 0) {
      return null;
    }
    const root = Math.sqrt(disc);
    const near = -b - root;
    const far = -b + root;
    return { near, far };
  };
  const outerHit = hit(outer);
  if (outerHit === null || outerHit.far <= 0) {
    return 0;
  }
  const innerHit = hit(inner);
  const tStart = Math.max(outerHit.near, 0);
  const tEnd =
    innerHit !== null && innerHit.near > tStart ? innerHit.near : outerHit.far;
  if (!(tEnd > tStart)) {
    return 0;
  }

  const fineStep = (tEnd - tStart) / p.steps;
  const thickness = p.shellTopMeters - p.shellBottomMeters;
  let tau = 0;
  const sp = [0, 0, 0];
  for (let k = 0; k < p.steps; k++) {
    const t = tStart + k * fineStep;
    const wx = dx * t;
    const wy = originY + dy * t;
    const wz = dz * t;
    const radius = Math.sqrt(wx * wx + wy * wy + wz * wz);
    const h = clamp(
      (radius - PLANET_RADIUS - p.shellBottomMeters) / thickness,
      0,
      1,
    );
    sp[0] = f32(wx * WORLD_TO_NOISE);
    sp[1] = f32(wy * WORLD_TO_NOISE);
    sp[2] = f32(wz * WORLD_TO_NOISE);
    const density = marchedDensity(sp, h, p);
    if (density > 0) {
      tau += density * fineStep * p.absorption;
    }
  }
  return tau;
}

/**
 * Assemble the full parameter block. Everything defaults to the SHIPPED value;
 * an override is how a what-if (a different authored aspect, a different step
 * count, a mutation) is expressed.
 *
 * @param {object} [overrides] Field-by-field overrides.
 * @returns {object} The parameter block the model functions consume.
 */
export function buildModelParameters(overrides = {}) {
  const cloudType = overrides.cloudType ?? CloudType.CIRRUS;
  const genus = genusMarchParameters(cloudType);
  const row = overrides.row ?? genus.row;
  const geometry = { ...PROBE_GEOMETRY, ...(overrides.geometry ?? {}) };
  const fovX = (geometry.fovDegrees * Math.PI) / 180;
  const aspect = geometry.canvasWidth / geometry.canvasHeight;
  const fovY =
    aspect <= 1 ? fovX : 2 * Math.atan(Math.tan(fovX * 0.5) / aspect);
  const p = {
    cloudType,
    row,
    profileShape: overrides.profileShape ?? genus.profileShape,
    profileDensityScale:
      overrides.profileDensityScale ?? genus.profileDensityScale,
    profileExtinction: overrides.profileExtinction ?? genus.profileExtinction,
    coverage: overrides.coverage ?? PROBE_MARCH.coverage,
    densityMultiplier:
      overrides.densityMultiplier ?? PROBE_MARCH.densityMultiplier,
    anvilBias: overrides.anvilBias ?? PROBE_MARCH.anvilBias,
    steps: overrides.steps ?? PROBE_MARCH.steps,
    windDirection: overrides.windDirection ?? [1, 0],
    includeBaseField: overrides.includeBaseField ?? true,
    includeErosion: overrides.includeErosion ?? true,
    includeFibre: overrides.includeFibre ?? true,
    fibreFrequencyScale: overrides.fibreFrequencyScale ?? 1,
    saturate: overrides.saturate ?? true,
    radianceScale: overrides.radianceScale ?? 255,
    clipLevel: overrides.clipLevel ?? Infinity,
    ...geometry,
    tanHalfFovX: Math.tan(fovX * 0.5),
    tanHalfFovY: Math.tan(fovY * 0.5),
  };
  p.absorption =
    ABSORPTION_COEFF *
    (p.profileExtinction > 0 ? p.profileExtinction : 1) *
    (overrides.absorptionScale ?? 1);
  return p;
}

/**
 * Metres of ground covered by one canvas pixel at the shell mid-height — the
 * conversion that turns a noise-space correlation length into the pixel units
 * the probe reports.
 *
 * @param {object} p A parameter block.
 * @returns {number} Metres per pixel.
 */
export function metersPerPixel(p) {
  const midHeight = (p.shellBottomMeters + p.shellTopMeters) * 0.5;
  const distance = p.cameraHeightMeters - midHeight;
  return (2 * distance * p.tanHalfFovX) / p.canvasWidth;
}

/** The image value of one pixel: the march's saturating transfer, then the canvas clip. */
export function pixelValue(screenX, screenY, p) {
  const tau = columnOpticalDepth(screenX, screenY, p);
  const alpha = p.saturate ? 1 - Math.exp(-tau) : tau;
  return Math.min(p.radianceScale * alpha, p.clipLevel);
}

/**
 * The probe's `halfLength`, verbatim in behaviour: first lag whose normalised
 * autocorrelation drops below 0.5, linearly interpolated between the bracketing
 * lags; a flat line reports saturation at `maxLag`.
 *
 * @param {Float64Array} samples One sample line.
 * @param {number} maxLag Largest lag examined.
 * @returns {{length: number, saturated: boolean}} Half-length in samples.
 */
export function halfLength(samples, maxLag) {
  const n = samples.length;
  let mean = 0;
  for (let i = 0; i < n; i++) {
    mean += samples[i];
  }
  mean /= n;
  let variance = 0;
  for (let i = 0; i < n; i++) {
    variance += (samples[i] - mean) ** 2;
  }
  variance /= n;
  if (variance <= 1e-9) {
    return { length: maxLag, saturated: true };
  }
  let previous = 1;
  for (let lag = 1; lag <= maxLag; lag++) {
    let sum = 0;
    for (let i = 0; i + lag < n; i++) {
      sum += (samples[i] - mean) * (samples[i + lag] - mean);
    }
    const r = sum / ((n - lag) * variance);
    if (r < 0.5) {
      const t = (previous - 0.5) / Math.max(previous - r, 1e-9);
      return { length: lag - 1 + t, saturated: false };
    }
    previous = r;
  }
  return { length: maxLag, saturated: true };
}

/**
 * Mean correlation half-length of the modelled image along a screen direction,
 * on the probe's own line geometry.
 *
 * @param {number} directionDeg Screen azimuth, degrees, y down.
 * @param {object} p A parameter block.
 * @param {object} [estimator] Estimator geometry; defaults to the probe's.
 * @returns {{length: number, accepted: number, saturated: number}} The mean.
 */
export function directionalLength(directionDeg, p, estimator = {}) {
  const {
    halfExtent = PROBE_ESTIMATOR.halfExtent,
    sampleCount = PROBE_ESTIMATOR.sampleCount,
    lineCount = PROBE_ESTIMATOR.lineCount,
    lineSpreadFactor = PROBE_ESTIMATOR.lineSpreadFactor,
  } = estimator;
  const maxLag = Math.max(8, Math.floor(sampleCount / 3));
  const radians = (directionDeg * Math.PI) / 180;
  const ux = Math.cos(radians);
  const uy = Math.sin(radians);
  const px = -uy;
  const py = ux;
  let total = 0;
  let accepted = 0;
  let saturated = 0;
  for (let line = 0; line < lineCount; line++) {
    const offset =
      (line / (lineCount - 1) - 0.5) * 2 * halfExtent * lineSpreadFactor;
    const startX = px * offset - (ux * sampleCount) / 2;
    const startY = py * offset - (uy * sampleCount) / 2;
    const samples = new Float64Array(sampleCount);
    for (let i = 0; i < sampleCount; i++) {
      samples[i] = pixelValue(startX + ux * i, startY + uy * i, p);
    }
    const measured = halfLength(samples, maxLag);
    total += measured.length;
    accepted++;
    if (measured.saturated) {
      saturated++;
    }
  }
  return { length: total / accepted, accepted, saturated };
}

/**
 * The model's answer to gate C/D/E's question: the along/across elongation of
 * the INTEGRATED IMAGE, plus the azimuth scan whose argmax gate D reads.
 *
 * @param {object} [overrides] Passed to {@link buildModelParameters}.
 * @param {object} [options] `{alongDeg, estimator, scanStepDeg, scan}`.
 * @returns {object} `{alongLength, acrossLength, elongation, argmaxDeg, scan}`.
 */
export function screenAnisotropy(overrides = {}, options = {}) {
  const p = buildModelParameters(overrides);
  const {
    alongDeg = 0,
    estimator = {},
    scanStepDeg = 15,
    scan = false,
  } = options;
  const along = directionalLength(alongDeg, p, estimator);
  const across = directionalLength(alongDeg + 90, p, estimator);
  const result = {
    alongDeg,
    alongLength: along.length,
    acrossLength: across.length,
    elongation: along.length / Math.max(across.length, 1e-6),
    saturatedLines: along.saturated + across.saturated,
    metersPerPixel: metersPerPixel(p),
  };
  if (scan) {
    const entries = [];
    for (let deg = 0; deg < 180; deg += scanStepDeg) {
      entries.push({
        deg,
        length: directionalLength(deg, p, estimator).length,
      });
    }
    result.scan = entries;
    result.argmaxDeg = entries.reduce((best, entry) =>
      entry.length > best.length ? entry : best,
    ).deg;
  }
  return result;
}

/**
 * The transfer curve R3 asks for: authored aspect -> on-screen elongation, with
 * every other input held at the CIRRUS row's shipped values.
 *
 * @param {number[]} aspects Authored `anisotropy` values to evaluate.
 * @param {object} [overrides] Passed through; `row.anisotropy` is replaced.
 * @param {object} [options] Passed to {@link screenAnisotropy}.
 * @returns {object[]} `[{aspect, alongLength, acrossLength, elongation}]`.
 */
export function transferCurve(aspects, overrides = {}, options = {}) {
  const base = buildModelParameters(overrides);
  return aspects.map((aspect) => {
    const measured = screenAnisotropy(
      { ...overrides, row: { ...base.row, anisotropy: aspect } },
      options,
    );
    return { aspect, ...measured };
  });
}

/**
 * Invert the curve: the authored aspect required to reach a target on-screen
 * elongation. Returns `reachable: false` rather than an extrapolated number
 * when the curve never gets there — the whole point of R3 is to find out
 * WHETHER it can, so an extrapolation would beg the question.
 *
 * @param {object[]} curve Output of {@link transferCurve}, ascending in aspect.
 * @param {number} targetElongation The gate's floor.
 * @returns {object} `{reachable, aspect, why}`.
 */
export function invertTransfer(curve, targetElongation) {
  for (let i = 1; i < curve.length; i++) {
    const a = curve[i - 1];
    const b = curve[i];
    if (a.elongation < targetElongation && b.elongation >= targetElongation) {
      const t =
        (targetElongation - a.elongation) /
        Math.max(b.elongation - a.elongation, 1e-12);
      return {
        reachable: true,
        aspect: a.aspect + t * (b.aspect - a.aspect),
        bracket: [a.aspect, b.aspect],
      };
    }
  }
  if (
    curve.length > 0 &&
    curve[curve.length - 1].elongation >= targetElongation
  ) {
    return { reachable: true, aspect: curve[0].aspect, bracket: null };
  }
  const best = curve.reduce(
    (top, entry) => (entry.elongation > top.elongation ? entry : top),
    curve[0],
  );
  return {
    reachable: false,
    aspect: null,
    why:
      `the curve tops out at elongation ${best.elongation.toFixed(3)} ` +
      `at aspect ${best.aspect}, below the ${targetElongation} target`,
    ceiling: best,
  };
}

export { CloudType, CloudTypeProfile };
