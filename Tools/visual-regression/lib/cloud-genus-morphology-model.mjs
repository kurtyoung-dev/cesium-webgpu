/**
 * CPU twin of the C13-16 per-genus cloud morphology
 * (`genusFibreFactor` / `genusErosionHeightWeight` / `genusForwardG` in
 * `packages/engine/Source/Shaders/WebGPU/Environment/ProceduralClouds.wgsl`).
 * @purpose f32 CPU twin of C13-16 per-genus cloud morphology (wind frame, fallstreak shear, fibre carve); genus rows imported from CloudTypeProfile.js.
 * @status ACTIVE
 *
 * WHAT THIS IS FAITHFUL TO, AND WHAT IT IS NOT
 *
 * The morphology ARITHMETIC — the wind frame, the fallstreak shear, the
 * anisotropic domain division, the Worley carve, the erosion height weight, and
 * the phase offset — is reproduced step for step in f32 (`Math.fround` wherever
 * the shader rounds), so the identity cases below are exact rather than
 * approximate: they are the same expressions with the same guards.
 *
 * The NOISE is distribution-faithful, not bit-faithful, for the same reason the
 * coverage-response twin states: `hash33`'s `fract(p * 0.1031)` chain is
 * evaluated by a GPU in f32 and by Node in f64 at intermediate steps that
 * `Math.fround` cannot fully pin, so the two produce different but
 * statistically equivalent permutations of the same construction. Every
 * property measured through the noise is therefore a STRUCTURAL one — the ratio
 * of correlation lengths along and across the wind, the sign and magnitude of
 * the fallstreak lag — never an exact sample value. Those ratios are properties
 * of the coordinate transform, not of the permutation, which is precisely why
 * they survive the f32/f64 difference.
 *
 * A banded or whole-field MEAN would NOT survive and is deliberately absent:
 * this campaign has repeatedly found that faint wide-band cloud changes are
 * invisible to band-mean statistics. Everything exported here is banded by
 * height, pointwise, or structural.
 *
 * The genus parameter rows are NOT redefined here — they are imported from
 * `Scene/CloudTypeProfile.js`, the same module the renderer packs from, so this
 * file cannot drift from the shipped table.
 */

import CloudTypeProfile from "../../../packages/engine/Source/Scene/CloudTypeProfile.js";

const f32 = Math.fround;

/** `GENUS_PHASE_G_LIMIT` in ProceduralClouds.wgsl. */
export const GENUS_PHASE_G_LIMIT = 0.95;
/** The `smoothstep` edges of the fibre carve in `genusFibreFactor`. */
export const FIBRE_CARVE_EDGE_LOW = 0.12;
export const FIBRE_CARVE_EDGE_HIGH = 0.72;
/** The vertical compression and overall frequency of the fibre domain. */
export const FIBRE_VERTICAL_COMPRESSION = 0.35;
export const FIBRE_DOMAIN_FREQUENCY = 3.0;

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

function mix(a, b, t) {
  return f32(a * f32(1 - t) + b * t);
}

/** ProceduralClouds.wgsl `hash33`. */
function hash33(px, py, pz) {
  let qx = fract(f32(px * 0.1031));
  let qy = fract(f32(py * 0.103));
  let qz = fract(f32(pz * 0.0973));
  // q += dot(q, q.yxz + 33.33)
  const d = f32(
    f32(qx * f32(qy + 33.33)) +
      f32(qy * f32(qx + 33.33)) +
      f32(qz * f32(qz + 33.33)),
  );
  qx = f32(qx + d);
  qy = f32(qy + d);
  qz = f32(qz + d);
  // fract((q.xxy + q.yxx) * q.zyx)
  return [
    fract(f32(f32(qx + qy) * qz)),
    fract(f32(f32(qx + qx) * qy)),
    fract(f32(f32(qy + qx) * qx)),
  ];
}

/** ProceduralClouds.wgsl `worleyF1` — F1 distance over the 3x3x3 neighbourhood. */
export function worleyF1(px, py, pz) {
  const ix = Math.floor(px);
  const iy = Math.floor(py);
  const iz = Math.floor(pz);
  const fx = f32(px - ix);
  const fy = f32(py - iy);
  const fz = f32(pz - iz);
  let minDistSq = 1;
  for (let x = -1; x <= 1; x++) {
    for (let y = -1; y <= 1; y++) {
      for (let z = -1; z <= 1; z++) {
        const h = hash33(ix + x, iy + y, iz + z);
        const dx = f32(x + h[0] - fx);
        const dy = f32(y + h[1] - fy);
        const dz = f32(z + h[2] - fz);
        const distSq = f32(f32(dx * dx) + f32(dy * dy) + f32(dz * dz));
        if (distSq < minDistSq) {
          minDistSq = distSq;
        }
      }
    }
  }
  return f32(Math.sqrt(minDistSq));
}

/**
 * ProceduralClouds.wgsl `genusFibreFactor`.
 *
 * @param {number[]} sp Noise-space sample position `[x, y, z]`.
 * @param {number} h Shell height fraction, 0 base .. 1 top.
 * @param {object} row `{strength, anisotropy, shear}` from CloudTypeProfile.
 * @param {number[]} [windDirection] `[x, y]` wind direction; defaults to +X.
 * @returns {number} Density multiplier in [0, 1]; exactly 1 at strength 0.
 */
export function genusFibreFactor(sp, h, row, windDirection = [1, 0]) {
  const strength = clamp(row.strength, 0, 1);
  if (strength <= 0) {
    return 1;
  }
  const wlen = f32(
    Math.sqrt(
      f32(
        f32(windDirection[0] * windDirection[0]) +
          f32(windDirection[1] * windDirection[1]),
      ),
    ),
  );
  const useWind = wlen > 1e-5;
  const wx = useWind ? f32(windDirection[0] / Math.max(wlen, 1e-5)) : 1;
  const wy = useWind ? f32(windDirection[1] / Math.max(wlen, 1e-5)) : 0;
  const cx = -wy;
  const cy = wx;
  const along = f32(
    f32(f32(sp[0] * wx) + f32(sp[2] * wy)) - f32(f32(1 - h) * row.shear),
  );
  const acr = f32(f32(sp[0] * cx) + f32(sp[2] * cy));
  const aspect = Math.max(row.anisotropy, 1);
  const streak = worleyF1(
    f32(f32(along / aspect) * FIBRE_DOMAIN_FREQUENCY),
    f32(f32(sp[1] * FIBRE_VERTICAL_COMPRESSION) * FIBRE_DOMAIN_FREQUENCY),
    f32(acr * FIBRE_DOMAIN_FREQUENCY),
  );
  const carve = f32(
    smoothstep(FIBRE_CARVE_EDGE_LOW, FIBRE_CARVE_EDGE_HIGH, streak) * strength,
  );
  return clamp(f32(1 - carve), 0, 1);
}

/**
 * ProceduralClouds.wgsl `genusErosionHeightWeight`.
 *
 * @param {number} h Shell height fraction.
 * @param {number} fibreStrength `cloud.genusFibreStrength`.
 * @returns {number} Erosion height weight; exactly `1 - h` at strength 0.
 */
export function genusErosionHeightWeight(h, fibreStrength) {
  const fibre = clamp(fibreStrength, 0, 1);
  if (fibre <= 0) {
    return f32(1 - h);
  }
  return mix(f32(1 - h), 1, fibre);
}

/**
 * ProceduralClouds.wgsl `genusForwardG`.
 *
 * @param {number} phaseG1 `cloud.phaseG1`.
 * @param {number} genusPhaseDelta `cloud.genusPhaseDelta`.
 * @returns {number} Forward-lobe eccentricity; exactly `phaseG1` at delta 0.
 */
export function genusForwardG(phaseG1, genusPhaseDelta) {
  if (genusPhaseDelta === 0) {
    return phaseG1;
  }
  return clamp(
    f32(phaseG1 + genusPhaseDelta),
    -GENUS_PHASE_G_LIMIT,
    GENUS_PHASE_G_LIMIT,
  );
}

/**
 * The renderer's own derivation of slot 171 — kept here so the spec asserts the
 * shipped rule rather than a restatement of it.
 *
 * @param {number} cloudType The genus.
 * @returns {number} `profile.phaseG - CUMULUS.phaseG`.
 */
export function genusPhaseDeltaFor(cloudType) {
  return (
    CloudTypeProfile.get(cloudType).phaseG -
    CloudTypeProfile.get(0 /* CloudType.CUMULUS */).phaseG
  );
}

function normalizedAutocorrelationHalfLength(samples, step) {
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
  if (variance <= 1e-12) {
    // A constant line has no structure to measure; report the whole span so a
    // degenerate field never masquerades as a short correlation length.
    return n * step;
  }
  let previous = 1;
  for (let lag = 1; lag < n; lag++) {
    let sum = 0;
    for (let i = 0; i + lag < n; i++) {
      sum += (samples[i] - mean) * (samples[i + lag] - mean);
    }
    const r = sum / ((n - lag) * variance);
    if (r < 0.5) {
      // Linear interpolation between the bracketing lags.
      const t = (previous - 0.5) / Math.max(previous - r, 1e-9);
      return (lag - 1 + t) * step;
    }
    previous = r;
  }
  return n * step;
}

/**
 * Structural anisotropy of the fibre field: the ratio of its correlation length
 * ALONG the wind to its correlation length ACROSS the wind.
 *
 * This is the metric the row exists to move. It is a property of the coordinate
 * transform rather than of the noise permutation, so it is stable under the
 * model's f32/f64 hash difference, and it is blind to overall brightness — a
 * change that only dims the deck cannot move it.
 *
 * @param {object} row `{strength, anisotropy, shear}`.
 * @param {object} [options] Sampling geometry.
 * @returns {{alongLength: number, acrossLength: number, elongation: number}}
 *   Correlation lengths in noise units and their ratio.
 */
export function fibreElongation(row, options = {}) {
  const {
    heightFraction = 0.5,
    verticalCoordinate = 3.0,
    lineCount = 24,
    sampleCount = 320,
    step = 0.05,
    lineSpacing = 0.37,
  } = options;

  const measure = (alongAxis) => {
    let total = 0;
    for (let line = 0; line < lineCount; line++) {
      const offset = (line + 1) * lineSpacing;
      const samples = new Float64Array(sampleCount);
      for (let i = 0; i < sampleCount; i++) {
        const t = i * step;
        const sp = alongAxis
          ? [t, verticalCoordinate, offset]
          : [offset, verticalCoordinate, t];
        samples[i] = genusFibreFactor(sp, heightFraction, row);
      }
      total += normalizedAutocorrelationHalfLength(samples, step);
    }
    return total / lineCount;
  };

  const alongLength = measure(true);
  const acrossLength = measure(false);
  return {
    alongLength,
    acrossLength,
    elongation: alongLength / Math.max(acrossLength, 1e-9),
  };
}

/**
 * Structural fallstreak tilt: the along-wind lag (in noise units) at which the
 * fibre field sampled at the deck TOP best matches the field sampled at the
 * deck BASE. A filament hanging straight down gives 0; a sheared fallstreak
 * gives the shear magnitude with the sign of the downwind lag.
 *
 * @param {object} row `{strength, anisotropy, shear}`.
 * @param {object} [options] Sampling geometry.
 * @returns {number} Best-match lag in noise units.
 */
export function fallstreakLag(row, options = {}) {
  const {
    verticalCoordinate = 3.0,
    sampleCount = 400,
    step = 0.02,
    maxLagSteps = 120,
    lineCount = 8,
    lineSpacing = 0.41,
  } = options;

  const lineAt = (h, shift) => {
    const lines = [];
    for (let line = 0; line < lineCount; line++) {
      const across = (line + 1) * lineSpacing;
      const samples = new Float64Array(sampleCount);
      for (let i = 0; i < sampleCount; i++) {
        samples[i] = genusFibreFactor(
          [i * step + shift, verticalCoordinate, across],
          h,
          row,
        );
      }
      lines.push(samples);
    }
    return lines;
  };

  const top = lineAt(1, 0);
  let bestLag = 0;
  let bestScore = -Infinity;
  for (let lagStep = -maxLagSteps; lagStep <= maxLagSteps; lagStep++) {
    const shift = lagStep * step;
    const base = lineAt(0, shift);
    let score = 0;
    for (let line = 0; line < lineCount; line++) {
      const a = top[line];
      const b = base[line];
      for (let i = 0; i < sampleCount; i++) {
        score -= (a[i] - b[i]) ** 2;
      }
    }
    if (score > bestScore) {
      bestScore = score;
      bestLag = shift;
    }
  }
  return bestLag;
}

/**
 * Height-BANDED profile of the fibre carve: the mean factor within each of
 * `bandCount` equal shell-height bands. Banded rather than whole-deck because a
 * whole-deck mean is exactly the statistic this campaign found blind to faint
 * wide-band cloud change.
 *
 * @param {object} row `{strength, anisotropy, shear}`.
 * @param {object} [options] Sampling geometry.
 * @returns {number[]} Per-band mean factor, base band first.
 */
export function fibreHeightBands(row, options = {}) {
  const {
    bandCount = 5,
    columns = 40,
    span = 8.0,
    verticalCoordinate = 3.0,
  } = options;
  const bands = [];
  for (let band = 0; band < bandCount; band++) {
    const h = (band + 0.5) / bandCount;
    let sum = 0;
    for (let j = 0; j < columns; j++) {
      for (let i = 0; i < columns; i++) {
        sum += genusFibreFactor(
          [(i / columns) * span, verticalCoordinate, (j / columns) * span],
          h,
          row,
        );
      }
    }
    bands.push(sum / (columns * columns));
  }
  return bands;
}

export { CloudTypeProfile };
