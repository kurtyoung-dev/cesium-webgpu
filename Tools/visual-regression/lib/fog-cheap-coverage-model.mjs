/**
 * CPU twin of the volumetric fog's CHEAP cloud-shadow density gate
 * (CLOUD-LOW-COVERAGE-CUTOFF, fog arm).
 * @purpose Bit-faithful CPU twin of the fog cheap cloud-shadow noise gate at real ECEF magnitudes, importing the shipped normalisation and coverage response.
 * @status ACTIVE
 *
 * WHAT THIS IS FAITHFUL TO, AND WHAT IT IS NOT
 *
 * The noise construction — `hash13`, `valueNoise3d`, `fbm3d` — is transcribed
 * from `packages/engine/Source/Shaders/WebGPU/Compute/VolumetricFog.wgsl` with
 * `Math.fround` at every step WGSL rounds, and it is sampled at the REAL ECEF
 * magnitudes the shadow ray reaches (`|samplePos| * 0.0003` is about 1913), so
 * the f32 quantisation of the hash that a GPU actually sees is part of the
 * measurement rather than an f64 idealisation of it.
 *
 * The normalisation and the coverage response are NOT redefined here: they are
 * imported from `WebGPUCloudDensityDomain.ts`, the module the engine ships, so
 * this file cannot drift from the shipped curve. `hash13` is pure integer and
 * fractional arithmetic with no transcendental, so unlike the baked-shape twin
 * this port is bit-faithful to the shader rather than merely distribution
 * faithful — but every property pinned through it is still a distributional
 * one with margin, because the point of the contract is the SHAPE of the
 * response, not a luminance.
 *
 * The reference field — the baked shape channel the visible march samples and
 * the one `cloudEffectiveCoverage` was derived against — is imported from
 * `cloud-coverage-response-model.mjs` rather than restated.
 */

import {
  cloudEffectiveCoverage,
  normalizeFogCheapCloudField,
  CLOUD_SHAPE_FIELD_MEAN,
  FOG_CHEAP_FIELD_MEAN,
  FOG_CHEAP_FIELD_SIGMA_RATIO,
} from "../../../packages/engine/Source/Renderer/WebGPU/WebGPUCloudDensityDomain.ts";
import { bakedShapeBase } from "./cloud-coverage-response-model.mjs";

const f32 = Math.fround;

/** `u.cloudDensityShape.z` — the fog renderer packs 0.0003 unconditionally. */
export const FOG_CLOUD_NOISE_SCALE = 0.0003;
/** `coverage <= 1e-3` is the shader's own short-circuit to fully lit. */
export const FOG_CLOUD_COVERAGE_EPSILON = 1e-3;

function fract(value) {
  return value - Math.floor(value);
}

/** VolumetricFog.wgsl `hash13`. */
export function hash13(x, y, z) {
  const px = f32(fract(f32(f32(x) * 0.1031)));
  const py = f32(fract(f32(f32(y) * 0.1031)));
  const pz = f32(fract(f32(f32(z) * 0.1031)));
  // pp + dot(pp, pp.yzx + 33.33)
  const d = f32(
    f32(px * f32(py + 33.33)) +
      f32(py * f32(pz + 33.33)) +
      f32(pz * f32(px + 33.33)),
  );
  return f32(fract(f32(f32(f32(px + d) + f32(py + d)) * f32(pz + d))));
}

function mix(a, b, t) {
  return f32(a + f32(t * f32(b - a)));
}

/** VolumetricFog.wgsl `valueNoise3d`. */
export function valueNoise3d(x, y, z) {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const iz = Math.floor(z);
  const fx = f32(x - ix);
  const fy = f32(y - iy);
  const fz = f32(z - iz);
  const wx = f32(fx * fx * f32(3 - 2 * fx));
  const wy = f32(fy * fy * f32(3 - 2 * fy));
  const wz = f32(fz * fz * f32(3 - 2 * fz));
  const n000 = hash13(ix, iy, iz);
  const n100 = hash13(ix + 1, iy, iz);
  const n010 = hash13(ix, iy + 1, iz);
  const n110 = hash13(ix + 1, iy + 1, iz);
  const n001 = hash13(ix, iy, iz + 1);
  const n101 = hash13(ix + 1, iy, iz + 1);
  const n011 = hash13(ix, iy + 1, iz + 1);
  const n111 = hash13(ix + 1, iy + 1, iz + 1);
  return mix(
    mix(mix(n000, n100, wx), mix(n010, n110, wx), wy),
    mix(mix(n001, n101, wx), mix(n011, n111, wx), wy),
    wz,
  );
}

/** VolumetricFog.wgsl `fbm3d` — 3 octaves, output in [-1, 1]. */
export function fbm3d(x, y, z) {
  let sum = 0;
  let amp = 1;
  let freq = 1;
  let norm = 0;
  for (let octave = 0; octave < 3; octave++) {
    sum = f32(
      sum +
        f32(valueNoise3d(f32(x * freq), f32(y * freq), f32(z * freq)) * amp),
    );
    norm = f32(norm + amp);
    amp = f32(amp * 0.5);
    freq = f32(freq * 2);
  }
  return f32(f32(sum / norm) * 2 - 1);
}

/** The gate's input: `fbm3d(p) * 0.5 + 0.5`. */
export function fogCheapFieldAt(x, y, z) {
  return f32(f32(fbm3d(x, y, z) * 0.5) + 0.5);
}

/**
 * Sample the fog cheap field the way the shader reaches it: at points on the
 * cloud-layer sphere, in ECEF metres, scaled by the packed noise scale.
 *
 * Eight widely separated patches rather than one, because a single small patch
 * of a value fBM has visible sampling bias in its tails and the contract this
 * feeds is about tails.
 *
 * @param {object} [options] Grid size and deck altitude.
 * @returns {Float32Array} The sampled field.
 */
export function sampleFogCheapField(options = {}) {
  const {
    perPatch = 72,
    halfSpanRadians = 0.12,
    cloudMidAltitude = 2750,
    innerRadius = 6378137,
  } = options;

  const patches = [
    [0, 0],
    [0.7, -1.3],
    [-0.5, 2.4],
    [1.2, 0.6],
    [-1.1, -2.0],
    [0.3, 1.7],
    [-1.35, 0.2],
    [0.95, 3.0],
  ];
  const radius = innerRadius + cloudMidAltitude;
  const out = new Float32Array(patches.length * perPatch * perPatch);

  let index = 0;
  for (const [latCenter, lonCenter] of patches) {
    for (let i = 0; i < perPatch; i++) {
      const lat =
        latCenter -
        halfSpanRadians +
        (2 * halfSpanRadians * i) / (perPatch - 1);
      for (let j = 0; j < perPatch; j++) {
        const lon =
          lonCenter -
          halfSpanRadians +
          (2 * halfSpanRadians * j) / (perPatch - 1);
        const cx = radius * Math.cos(lat) * Math.cos(lon);
        const cy = radius * Math.cos(lat) * Math.sin(lon);
        const cz = radius * Math.sin(lat);
        out[index++] = fogCheapFieldAt(
          f32(cx * FOG_CLOUD_NOISE_SCALE),
          f32(cy * FOG_CLOUD_NOISE_SCALE),
          f32(cz * FOG_CLOUD_NOISE_SCALE),
        );
      }
    }
  }
  return out;
}

/**
 * Sample the baked shape channel over its full period — the reference field
 * `cloudEffectiveCoverage` was derived against.
 *
 * @param {number} [steps] Grid resolution per axis.
 * @returns {Float32Array} The sampled field.
 */
export function sampleBakedShapeField(steps = 44) {
  const out = new Float32Array(steps * steps * steps);
  let index = 0;
  for (let i = 0; i < steps; i++) {
    for (let j = 0; j < steps; j++) {
      for (let k = 0; k < steps; k++) {
        out[index++] = bakedShapeBase(
          (i + 0.5) / steps,
          (j + 0.5) / steps,
          (k + 0.5) / steps,
        );
      }
    }
  }
  return out;
}

/**
 * Moments plus an exceedance function for a sampled field.
 *
 * @param {Float32Array} samples The field.
 * @returns {object} mean/sigma/min/max/quantile/exceedance.
 */
export function summarize(samples) {
  const sorted = Float64Array.from(samples).sort();
  const n = sorted.length;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    sum += sorted[i];
  }
  const mean = sum / n;
  let variance = 0;
  for (let i = 0; i < n; i++) {
    variance += (sorted[i] - mean) ** 2;
  }
  return {
    n,
    mean,
    sigma: Math.sqrt(variance / n),
    min: sorted[0],
    max: sorted[n - 1],
    quantile: (p) => sorted[Math.min(n - 1, Math.floor(p * n))],
    // Fraction of the field strictly above `threshold` — the fraction of the
    // deck the gate admits. A BANDED/structural metric: a faint wide-band
    // change moves it, where a field mean would hide it.
    exceedance: (threshold) => {
      let count = 0;
      for (let i = n - 1; i >= 0 && sorted[i] > threshold; i--) {
        count++;
      }
      return count / n;
    },
  };
}

/** The gate's identity normalisation — the defect, for A/B and mutation. */
export function identityNormalization(value) {
  return f32(value);
}

/** The historical response: the requested coverage went to the threshold raw. */
export function historicalResponse(coverage) {
  return f32(Math.min(Math.max(coverage, 0), 1));
}

/** The coverages the sweep is evaluated at. Spans clear to overcast. */
export const SWEEP_COVERAGES = Object.freeze([
  0.05, 0.1, 0.15, 0.2, 0.25, 0.3, 0.35, 0.4, 0.45, 0.5, 0.55, 0.6, 0.7, 0.8,
  0.9, 1.0,
]);

/**
 * Compare, at each coverage, the fraction of deck the VISIBLE march's gate
 * admits against the fraction the fog's cheap gate admits.
 *
 * `smoothstep(t, 1, x) > 0` exactly when `x > t`, so the exceedance of the
 * threshold is the gate's support, and the two gates track when their
 * exceedances agree. `normalize` and `response` are injectable so a mutant can
 * be run through the identical measurement.
 *
 * @param {object} fields `{ fog, cloud }` summaries from {@link summarize}.
 * @param {object} [options] `{ normalize, response, coverages }`.
 * @returns {object[]} One row per coverage.
 */
export function gateTrackingSweep(fields, options = {}) {
  const {
    normalize = normalizeFogCheapCloudField,
    response = cloudEffectiveCoverage,
    coverages = SWEEP_COVERAGES,
  } = options;

  return coverages.map((coverage) => {
    // The visible march's gate, always the shipped shared response.
    const cloudThreshold = f32(1 - cloudEffectiveCoverage(coverage));
    const cloudAdmitted = fields.cloud.exceedance(cloudThreshold);
    // The fog gate under test. `normalize(n) > 1 - response(c)` is equivalent
    // to a threshold on the raw sample, so invert the normalisation to get a
    // threshold this field's exceedance can be evaluated at.
    const fogThreshold = invertNormalization(
      normalize,
      f32(1 - response(coverage)),
    );
    const fogAdmitted = fields.fog.exceedance(fogThreshold);
    return {
      coverage,
      cloudThreshold,
      fogThreshold,
      cloudAdmitted,
      fogAdmitted,
      delta: Math.abs(cloudAdmitted - fogAdmitted),
    };
  });
}

/**
 * Solve `normalize(x) === target` for a monotone affine normalisation, by
 * measuring its slope and offset instead of assuming them — so a mutant that
 * changes either is inverted correctly rather than silently mismeasured.
 *
 * @param {Function} normalize The normalisation under test.
 * @param {number} target The value in normalised units.
 * @returns {number} The raw-field value that maps to `target`.
 */
export function invertNormalization(normalize, target) {
  const atZero = normalize(0);
  const atOne = normalize(1);
  const slope = atOne - atZero;
  if (!(Math.abs(slope) > 1e-9)) {
    throw new Error("normalization is not invertible");
  }
  return (target - atZero) / slope;
}

/** Largest |cloudAdmitted - fogAdmitted| over a sweep, in fraction units. */
export function worstTrackingError(sweep) {
  return sweep.reduce((worst, row) => Math.max(worst, row.delta), 0);
}

function smoothstep(edge0, edge1, x) {
  const t = Math.min(Math.max(f32((x - edge0) / (edge1 - edge0)), 0), 1);
  return f32(t * f32(t * f32(3 - 2 * t)));
}

/**
 * The gate's OUTPUT — not just its support — read at fixed quantiles of the
 * field. Two gates can admit the same fraction of deck and still differ in how
 * dense that deck is, because `smoothstep`'s ramp width is `1 - threshold`.
 *
 * Point metrics by construction: each entry is the gate evaluated at one
 * order statistic, so a faint wide-band amplitude change cannot average away.
 *
 * @param {object} summary A {@link summarize} result.
 * @param {number} threshold The gate's low edge, in that field's units.
 * @param {number[]} [quantiles] Field quantiles to evaluate at.
 * @returns {number[]} The gate value at each quantile.
 */
export function gateAmplitudeAtQuantiles(
  summary,
  threshold,
  quantiles = [0.9, 0.95, 0.98, 0.999],
) {
  return quantiles.map((p) => smoothstep(threshold, 1, summary.quantile(p)));
}

export {
  cloudEffectiveCoverage,
  normalizeFogCheapCloudField,
  CLOUD_SHAPE_FIELD_MEAN,
  FOG_CHEAP_FIELD_MEAN,
  FOG_CHEAP_FIELD_SIGMA_RATIO,
};
