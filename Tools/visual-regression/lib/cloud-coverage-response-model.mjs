/**
 * CPU twin of the volumetric cloud coverage -> density response
 * (CLOUD-LOW-COVERAGE-CUTOFF).
 *
 * WHAT THIS IS FAITHFUL TO, AND WHAT IT IS NOT
 *
 * The response arithmetic — the coverage gate, the BILLOWY height gradient, the
 * subtractive Worley erosion, and the Beer-Lambert column integration — is
 * reproduced in f32 (`Math.fround` at every step the shader rounds) from the
 * engine's own definitions. The coverage response itself is NOT redefined here:
 * it is imported from `WebGPUCloudDensityDomain.ts`, the same module the
 * renderer uses, so this file cannot drift from the shipped curve.
 *
 * The NOISE is distribution-faithful, not bit-faithful. The bake's hash is
 * `fract(sin(dot(p, k)) * 43758.5453123)`; a GPU evaluates that `sin` in f32 and
 * Node evaluates it in f64, so the two produce DIFFERENT but statistically
 * equivalent permutations of the same construction. Every property this model
 * is used to pin is therefore a distributional one (is the field's support wide
 * enough for the threshold, is the response monotone, is 0.35 sparse relative to
 * the anchor) with margin — never an exact luminance. The exact rendered result
 * is the tour's and the coverage sweep's job.
 *
 * Sources mirrored here:
 *   packages/engine/Source/Shaders/WebGPU/Compute/CloudNoiseBake.wgsl
 *     `valueNoisePeriodic` / `valueFBM` (shape R) and `worleyInv` (detail R)
 *   packages/engine/Source/Shaders/WebGPU/Environment/ProceduralClouds.wgsl
 *     `cloudMacroSampleAt` gate + `heightGradientFor` BILLOWY + the
 *     `remap(density, erosionLo, 1, 0, 1)` erosion in `cloudDensityFromMacro`
 *
 * Deliberate simplifications (they change WHERE a sample lands, never the
 * distribution of what it finds): the C13-37 domain rotations/offsets and the
 * slow warp of the shape lookup are omitted, and the texture is treated as its
 * underlying continuous field rather than a trilinear fetch of a 128^3 bake.
 */

import {
  cloudEffectiveCoverage,
  CLOUD_COVERAGE_ANCHOR,
} from "../../../packages/engine/Source/Renderer/WebGPU/WebGPUCloudDensityDomain.ts";

const f32 = Math.fround;

/** CloudNoiseBake.wgsl `bakeShape`: R = valueFBM(p, 2.0), 4 octaves. */
export const BAKE_SHAPE_FREQUENCY = 2.0;
export const BAKE_SHAPE_OCTAVES = 4;
/** CloudNoiseBake.wgsl `bakeDetail`: R = worleyInv(p, 4.0). */
export const BAKE_DETAIL_FREQUENCY = 4.0;
/** CloudUniforms defaults the ProceduralClouds march runs with. */
export const CLOUD_ABSORPTION_COEFF = 0.04;
export const CLOUD_EROSION_STRENGTH = 0.18;
/** `if (density > 0.001)` — the march's own contribution floor. */
export const MARCH_DENSITY_FLOOR = 0.001;

function fract(value) {
  return value - Math.floor(value);
}

function pmod(value, modulus) {
  return value - Math.floor(value / modulus) * modulus;
}

function valueHashP(x, y, z) {
  return fract(Math.sin(x * 127.1 + y * 311.7 + z * 74.7) * 43758.5453123);
}

function featHashComponent(x, y, z, kx, ky, kz) {
  return fract(Math.sin(x * kx + y * ky + z * kz) * 43758.5453123);
}

function valueNoisePeriodic(px, py, pz, freq) {
  const ax = px * freq;
  const ay = py * freq;
  const az = pz * freq;
  const ix = Math.floor(ax);
  const iy = Math.floor(ay);
  const iz = Math.floor(az);
  const fx = ax - ix;
  const fy = ay - iy;
  const fz = az - iz;
  const ux = fx * fx * (3 - 2 * fx);
  const uy = fy * fy * (3 - 2 * fy);
  const uz = fz * fz * (3 - 2 * fz);
  let total = 0;
  for (let corner = 0; corner < 8; corner++) {
    const cx = corner & 1;
    const cy = (corner >> 1) & 1;
    const cz = (corner >> 2) & 1;
    const hash = valueHashP(
      pmod(ix + cx, freq),
      pmod(iy + cy, freq),
      pmod(iz + cz, freq),
    );
    const weight = (cx ? ux : 1 - ux) * (cy ? uy : 1 - uy) * (cz ? uz : 1 - uz);
    total += weight * hash;
  }
  return total;
}

/** Periodic 4-octave value fBM in [0, 1] — the baked shape texture's R. */
export function bakedShapeBase(px, py, pz) {
  let value = 0;
  let amplitude = 0.5;
  let freq = BAKE_SHAPE_FREQUENCY;
  for (let octave = 0; octave < BAKE_SHAPE_OCTAVES; octave++) {
    value += amplitude * valueNoisePeriodic(px, py, pz, freq);
    freq *= 2;
    amplitude *= 0.5;
  }
  return f32(value / 0.9375);
}

function worleyPeriodic(px, py, pz, freq) {
  const ax = px * freq;
  const ay = py * freq;
  const az = pz * freq;
  const ix = Math.floor(ax);
  const iy = Math.floor(ay);
  const iz = Math.floor(az);
  const fx = ax - ix;
  const fy = ay - iy;
  const fz = az - iz;
  let minDistanceSquared = 1;
  for (let cell = 0; cell < 27; cell++) {
    const ox = (cell % 3) - 1;
    const oy = (Math.floor(cell / 3) % 3) - 1;
    const oz = Math.floor(cell / 9) - 1;
    const cellX = pmod(ix + ox, freq);
    const cellY = pmod(iy + oy, freq);
    const cellZ = pmod(iz + oz, freq);
    const dx =
      ox + featHashComponent(cellX, cellY, cellZ, 127.1, 311.7, 74.7) - fx;
    const dy =
      oy + featHashComponent(cellX, cellY, cellZ, 269.5, 183.3, 246.1) - fy;
    const dz =
      oz + featHashComponent(cellX, cellY, cellZ, 113.5, 271.9, 124.6) - fz;
    const distanceSquared = dx * dx + dy * dy + dz * dz;
    if (distanceSquared < minDistanceSquared) {
      minDistanceSquared = distanceSquared;
    }
  }
  return Math.sqrt(Math.min(minDistanceSquared, 1));
}

/** Periodic inverted Worley in [0, 1] — the baked detail texture's R. */
export function bakedDetailR(px, py, pz) {
  return f32(1 - worleyPeriodic(px, py, pz, BAKE_DETAIL_FREQUENCY));
}

/** rgba8unorm storage quantization, as `textureStore` applies it. */
function quantizeUnorm8(value) {
  return Math.round(Math.min(Math.max(value, 0), 1) * 255) / 255;
}

function smoothstep(edge0, edge1, x) {
  const t = Math.min(Math.max(f32((x - edge0) / (edge1 - edge0)), 0), 1);
  return f32(t * t * f32(3 - 2 * t));
}

/** ProceduralClouds.wgsl `heightGradientFor`, BILLOWY branch (shape 1). */
export function billowyHeightGradient(heightFraction) {
  return f32(
    smoothstep(0.0, 0.15, heightFraction) *
      smoothstep(1.0, 0.7, heightFraction),
  );
}

/**
 * Sample the baked density inputs over a deck slab once. The result is reused
 * across coverages so a sweep costs one field build, not one per point.
 *
 * @param {object} [options] Deck geometry and grid size.
 * @returns {object} Frozen field with `base`, `detailWorley`, and the geometry.
 */
export function sampleDeckField(options = {}) {
  const {
    deckBottom = 1500,
    deckTop = 3200,
    horizontalSpanMeters = 24000,
    columns = 64,
    levels = 20,
    worldToNoise = 0.0003,
    puffSize = 0.45,
    detailRatio = 5.0,
  } = options;

  const columnCount = columns * columns;
  const base = new Float32Array(columnCount * levels);
  const detailWorley = new Float32Array(columnCount * levels);
  const heightFractions = new Float64Array(levels);
  const layerHeight = (deckTop - deckBottom) / levels;

  let index = 0;
  for (let k = 0; k < levels; k++) {
    const worldZ = deckBottom + (k + 0.5) * layerHeight;
    heightFractions[k] = (k + 0.5) / levels;
    for (let j = 0; j < columns; j++) {
      const worldY = (j / columns) * horizontalSpanMeters;
      for (let i = 0; i < columns; i++) {
        const worldX = (i / columns) * horizontalSpanMeters;
        const nx = worldX * worldToNoise;
        const ny = worldY * worldToNoise;
        const nz = worldZ * worldToNoise;
        base[index] = quantizeUnorm8(
          bakedShapeBase(
            pmod(nx * puffSize, 1),
            pmod(ny * puffSize, 1),
            pmod(nz * puffSize, 1),
          ),
        );
        // The shader reads `1.0 - detail.r`, and `detail.r` is the QUANTIZED
        // stored value — quantize first, then invert, in that order.
        detailWorley[index] =
          1 -
          quantizeUnorm8(
            bakedDetailR(
              pmod(nx * detailRatio, 1),
              pmod(ny * detailRatio, 1),
              pmod(nz * detailRatio, 1),
            ),
          );
        index++;
      }
    }
  }

  return Object.freeze({
    base,
    detailWorley,
    heightFractions,
    columnCount,
    levels,
    layerHeight,
  });
}

/** Distribution summary of the baked base field this model sampled. */
export function summarizeBaseField(field) {
  const sorted = Float64Array.from(field.base).sort();
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
  const quantile = (p) => sorted[Math.min(n - 1, Math.floor(p * n))];
  return {
    mean,
    sigma: Math.sqrt(variance / n),
    min: sorted[0],
    max: sorted[n - 1],
    q95: quantile(0.95),
    q98: quantile(0.98),
    q99: quantile(0.99),
    exceedance: (threshold) => {
      let count = 0;
      for (let i = n - 1; i >= 0 && sorted[i] > threshold; i--) {
        count++;
      }
      return count / n;
    },
  };
}

/**
 * Evaluate the deck's density response at one coverage.
 *
 * `response` defaults to the shipped engine twin; pass `(c) => c` to reproduce
 * the historical gate for an A/B.
 *
 * @param {object} field Result of {@link sampleDeckField}.
 * @param {object} options Coverage plus the CloudUniforms scalars.
 * @returns {object} Volume/mean/peak plus Beer-Lambert column statistics.
 */
export function deckResponseStats(field, options) {
  const {
    coverage,
    densityMultiplier = 0.7,
    erosionStrength = CLOUD_EROSION_STRENGTH,
    absorption = CLOUD_ABSORPTION_COEFF,
    response = cloudEffectiveCoverage,
  } = options;

  const effectiveCoverage = response(coverage);
  const threshold = f32(1 - effectiveCoverage);
  const columnOpticalDepth = new Float64Array(field.columnCount);
  let nonzero = 0;
  let sum = 0;
  let peak = 0;

  let index = 0;
  for (let k = 0; k < field.levels; k++) {
    const heightFraction = field.heightFractions[k];
    const gradient = billowyHeightGradient(heightFraction);
    for (let column = 0; column < field.columnCount; column++, index++) {
      const erosionLo = f32(
        field.detailWorley[index] * erosionStrength * (1 - heightFraction),
      );
      const gated = f32(
        smoothstep(threshold, 1.0, field.base[index]) * gradient,
      );
      const eroded = Math.min(
        Math.max(f32((gated - erosionLo) / f32(1 - erosionLo)), 0),
        1,
      );
      const density = f32(eroded * densityMultiplier);
      if (density > MARCH_DENSITY_FLOOR) {
        nonzero++;
        sum += density;
        if (density > peak) {
          peak = density;
        }
        columnOpticalDepth[column] += density * field.layerHeight * absorption;
      }
    }
  }

  let cloudyColumns = 0;
  let solidColumns = 0;
  for (let column = 0; column < field.columnCount; column++) {
    const transmittance = Math.exp(-columnOpticalDepth[column]);
    if (transmittance < 0.5) {
      cloudyColumns++;
    }
    if (transmittance < 0.05) {
      solidColumns++;
    }
  }

  const sampleCount = field.columnCount * field.levels;
  return {
    coverage,
    effectiveCoverage,
    threshold,
    volumeFraction: nonzero / sampleCount,
    meanDensity: sum / sampleCount,
    peakDensity: peak,
    // Fraction of columns a viewer would read as cloud (transmittance < 0.5)
    // and as solid overcast (< 0.05) looking straight through the deck.
    skyCover: cloudyColumns / field.columnCount,
    solidCover: solidColumns / field.columnCount,
  };
}

/** The historical gate: the coverage went to the threshold unmodified. */
export function historicalEffectiveCoverage(coverage) {
  return f32(Math.min(Math.max(coverage, 0), 1));
}

export { cloudEffectiveCoverage, CLOUD_COVERAGE_ANCHOR };
