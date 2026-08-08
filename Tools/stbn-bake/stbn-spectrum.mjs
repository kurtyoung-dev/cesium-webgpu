// stbn-spectrum.mjs — Fourier certification of a spatiotemporal blue-noise
// volume, and the exact mutants that prove the certification discriminates.
// Campaign-13 row C13-11.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHAT "BLUE" MEANS HERE, AND WHERE THE NUMBERS COME FROM
// ─────────────────────────────────────────────────────────────────────────────
// Ulichney [1] characterises blue noise by its RADIALLY-AVERAGED POWER
// SPECTRUM: energy suppressed below a principal frequency, rising above it,
// and radially isotropic (no directional lobes). Wolfe et al. [3] add the
// property that makes a mask SPATIOTEMPORAL: the same suppression must hold
// along each pixel's TIME LINE, independently of the spatial suppression. A
// stack of unrelated 2D blue-noise slices satisfies the first and fails the
// second, and that is precisely the failure a temporal accumulator sees as
// per-pixel sparkle.
//
// Those are qualitative statements. The numeric bars below turn them into a
// gate using two anchors:
//
//   * The WHITE-NOISE NULL. A radially-averaged power spectrum normalised by
//     its own mean is identically 1.0 at every radius for white noise. So
//     "energy is suppressed at low frequency" means "the normalised low-band
//     average is materially below 1", and "energy is elevated at high
//     frequency" means "the normalised high-band average is materially above
//     1". The null is not a fitted constant — it is what the metric returns
//     for the thing blue noise is defined against.
//
//   * MEASURED MARGIN. Each bar is placed strictly between the null (1.0) and
//     what a good bake achieves, so it fails white noise by a wide margin and
//     passes a healthy bake by a wide margin. The values are recorded here
//     with the measurement that motivated them; a bake that drifts toward
//     white trips the bar long before the artefact becomes visible.
//
// The bands are fixed fractions of the Nyquist range rather than absolute
// frequencies, so the same bars apply to a 64x64x32 volume and a 128x128x64
// one: LOW = the bottom eighth, HIGH = the top half.
//
// [1] R. A. Ulichney, "The void-and-cluster method for dither array
//     generation", Proc. SPIE 1913, 1993. DOI 10.1117/12.152707.
// [2] I. Georgiev, M. Fajardo, "Blue-noise dithered sampling", SIGGRAPH 2016
//     Talks. DOI 10.1145/2897839.2927430.
// [3] A. Wolfe, N. Morrical, T. Akenine-Moller, R. Ramamoorthi,
//     "Spatiotemporal Blue Noise Masks", EGSR 2022. DOI 10.2312/sr.20221161.
//
// Linted by the `Tools/**` block in eslint.config.js.

import { StbnRandom } from "./stbn-rng.mjs";

/**
 * In-place radix-2 decimation-in-time FFT. Length must be a power of two.
 *
 * Written from the Cooley-Tukey factorisation rather than adapted from a
 * library: the twiddles are evaluated directly per stage instead of carried in
 * a recurrence, which costs a few microseconds at these lengths and removes
 * the recurrence's accumulated phase error from a measurement that the gate
 * depends on.
 *
 * @param {Float64Array} re real parts, overwritten with the transform
 * @param {Float64Array} im imaginary parts, overwritten with the transform
 */
export function fft(re, im) {
  const n = re.length;
  if (n !== im.length || (n & (n - 1)) !== 0) {
    throw new Error("fft: inputs must be equal-length powers of two");
  }
  if (n < 2) {
    return;
  }

  // Permute into bit-reversed order. `bits` is log2(n).
  let bits = 0;
  while (1 << bits < n) {
    bits++;
  }
  for (let i = 0; i < n; i++) {
    let r = 0;
    for (let b = 0; b < bits; b++) {
      r |= ((i >> b) & 1) << (bits - 1 - b);
    }
    if (r > i) {
      let t = re[i];
      re[i] = re[r];
      re[r] = t;
      t = im[i];
      im[i] = im[r];
      im[r] = t;
    }
  }

  for (let size = 2; size <= n; size <<= 1) {
    const half = size >> 1;
    const step = (-2 * Math.PI) / size;
    for (let k = 0; k < half; k++) {
      const wr = Math.cos(step * k);
      const wi = Math.sin(step * k);
      for (let base = 0; base < n; base += size) {
        const i = base + k;
        const j = i + half;
        const vr = re[j] * wr - im[j] * wi;
        const vi = re[j] * wi + im[j] * wr;
        re[j] = re[i] - vr;
        im[j] = im[i] - vi;
        re[i] += vr;
        im[i] += vi;
      }
    }
  }
}

/**
 * Power spectrum of one 2D slice, DC removed.
 * @param {Uint8Array} slice `width*height` bytes, row-major
 * @param {number} width slice width
 * @param {number} height slice height
 * @returns {Float64Array} `width*height` power values, index `ky*width + kx`
 */
function power2D(slice, width, height) {
  const n = width * height;
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  let mean = 0;
  for (let i = 0; i < n; i++) {
    mean += slice[i];
  }
  mean /= n;
  for (let i = 0; i < n; i++) {
    re[i] = slice[i] - mean;
  }

  // Rows, then columns.
  const rowRe = new Float64Array(width);
  const rowIm = new Float64Array(width);
  for (let y = 0; y < height; y++) {
    rowRe.set(re.subarray(y * width, y * width + width));
    rowIm.set(im.subarray(y * width, y * width + width));
    fft(rowRe, rowIm);
    re.set(rowRe, y * width);
    im.set(rowIm, y * width);
  }
  const colRe = new Float64Array(height);
  const colIm = new Float64Array(height);
  for (let x = 0; x < width; x++) {
    for (let y = 0; y < height; y++) {
      colRe[y] = re[y * width + x];
      colIm[y] = im[y * width + x];
    }
    fft(colRe, colIm);
    for (let y = 0; y < height; y++) {
      re[y * width + x] = colRe[y];
      im[y * width + x] = colIm[y];
    }
  }

  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    out[i] = re[i] * re[i] + im[i] * im[i];
  }
  return out;
}

/**
 * Radially-averaged, mean-normalised spatial power spectrum of a whole volume
 * (averaged over slices), plus Ulichney's anisotropy measure.
 *
 * Anisotropy is reported as `10*log10(variance / mean^2)` within each radial
 * ring, averaged over the rings. For white noise the per-frequency power is
 * exponentially distributed, so variance equals mean-squared and the figure
 * sits at 0 dB; a directional lobe pushes it up. It is REPORTED, not gated —
 * on a mask (as opposed to a thresholded binary pattern) the statistic is
 * dominated by the exponential sampling noise of individual bins, so it makes
 * a good diagnostic and a bad gate.
 *
 * @param {Uint8Array} bytes slice-major volume bytes
 * @param {number} width slice width
 * @param {number} height slice height
 * @param {number} frames temporal depth
 * @returns {{radial: Float64Array, low: number, mid: number, high: number, anisotropyDb: number}} metrics
 */
export function spatialSpectrum(bytes, width, height, frames) {
  const sliceSize = width * height;
  const maxR = Math.min(width, height) / 2;
  const bins = Math.floor(maxR) + 1;
  const sum = new Float64Array(bins);
  const sumSq = new Float64Array(bins);
  const count = new Float64Array(bins);

  for (let t = 0; t < frames; t++) {
    const p = power2D(
      bytes.subarray(t * sliceSize, (t + 1) * sliceSize),
      width,
      height,
    );
    for (let ky = 0; ky < height; ky++) {
      const fy = ky <= height / 2 ? ky : ky - height;
      for (let kx = 0; kx < width; kx++) {
        const fx = kx <= width / 2 ? kx : kx - width;
        const r = Math.sqrt(fx * fx + fy * fy);
        if (r < 0.5 || r > maxR) {
          continue;
        }
        const bin = Math.round(r);
        const v = p[ky * width + kx];
        sum[bin] += v;
        sumSq[bin] += v * v;
        count[bin] += 1;
      }
    }
  }

  let total = 0;
  let totalCount = 0;
  for (let b = 1; b < bins; b++) {
    total += sum[b];
    totalCount += count[b];
  }
  const globalMean = total / totalCount;

  const radial = new Float64Array(bins);
  let anisoSum = 0;
  let anisoCount = 0;
  for (let b = 1; b < bins; b++) {
    if (count[b] === 0) {
      continue;
    }
    const m = sum[b] / count[b];
    radial[b] = m / globalMean;
    const variance = Math.max(0, sumSq[b] / count[b] - m * m);
    if (m > 0) {
      anisoSum += 10 * Math.log10(variance / (m * m));
      anisoCount++;
    }
  }

  const nyquist = bins - 1;
  const lowEnd = Math.max(1, Math.round(nyquist / 8));
  const highStart = Math.round(nyquist / 2);
  return {
    radial,
    low: bandMean(radial, count, 1, lowEnd),
    mid: bandMean(radial, count, lowEnd + 1, highStart - 1),
    high: bandMean(radial, count, highStart, nyquist),
    anisotropyDb: anisoCount > 0 ? anisoSum / anisoCount : 0,
  };
}

/**
 * Count-weighted mean of a normalised radial spectrum over a bin range.
 *
 * Weighting by the number of frequencies in each ring — rather than averaging
 * the ring means — keeps the band figure equal to "the fraction of this band's
 * energy relative to a flat spectrum", which is the quantity the bars are
 * stated in. An unweighted mean would over-count the sparse inner rings.
 *
 * @param {Float64Array} radial normalised radial spectrum
 * @param {Float64Array} count frequencies per ring
 * @param {number} from first bin, inclusive
 * @param {number} to last bin, inclusive
 * @returns {number} the band mean
 */
function bandMean(radial, count, from, to) {
  let num = 0;
  let den = 0;
  for (let b = from; b <= to && b < radial.length; b++) {
    num += radial[b] * count[b];
    den += count[b];
  }
  return den > 0 ? num / den : 0;
}

/**
 * Mean-normalised temporal power spectrum: the per-pixel time series is
 * transformed on its own, its DC removed, and the powers averaged over every
 * pixel in the volume.
 *
 * This is the measurement that separates a genuine spatiotemporal mask from a
 * stack of independent blue-noise slices. The latter is white here.
 *
 * @param {Uint8Array} bytes slice-major volume bytes
 * @param {number} width slice width
 * @param {number} height slice height
 * @param {number} frames temporal depth
 * @returns {{radial: Float64Array, low: number, high: number}} metrics
 */
export function temporalSpectrum(bytes, width, height, frames) {
  const sliceSize = width * height;
  const half = frames / 2;
  const acc = new Float64Array(half + 1);
  const re = new Float64Array(frames);
  const im = new Float64Array(frames);

  for (let i = 0; i < sliceSize; i++) {
    let mean = 0;
    for (let t = 0; t < frames; t++) {
      mean += bytes[t * sliceSize + i];
    }
    mean /= frames;
    for (let t = 0; t < frames; t++) {
      re[t] = bytes[t * sliceSize + i] - mean;
      im[t] = 0;
    }
    fft(re, im);
    for (let k = 1; k <= half; k++) {
      acc[k] += re[k] * re[k] + im[k] * im[k];
    }
  }

  let total = 0;
  for (let k = 1; k <= half; k++) {
    total += acc[k];
  }
  const globalMean = total / half;

  const radial = new Float64Array(half + 1);
  for (let k = 1; k <= half; k++) {
    radial[k] = acc[k] / globalMean;
  }

  const lowEnd = Math.max(1, Math.round(half / 8));
  const highStart = Math.round(half / 2) + 1;
  let lowSum = 0;
  let lowCount = 0;
  for (let k = 1; k <= lowEnd; k++) {
    lowSum += radial[k];
    lowCount++;
  }
  let highSum = 0;
  let highCount = 0;
  for (let k = highStart; k <= half; k++) {
    highSum += radial[k];
    highCount++;
  }
  return {
    radial,
    low: lowSum / lowCount,
    high: highSum / highCount,
  };
}

/**
 * Root-mean-square Pearson correlation between the time series of randomly
 * chosen pixel pairs.
 *
 * This is the degeneracy canary described in `stbn-core.mjs`: the rejected
 * "one mask plus a temporally-blue value offset" construction scores a
 * near-perfect temporal spectrum while every pixel shares one time line, and
 * this number is what tells the two apart. Independent time lines sit at the
 * chance level `1/sqrt(frames-1)`, which is also returned so the figure can be
 * read without knowing the volume's depth.
 *
 * @param {Uint8Array} bytes slice-major volume bytes
 * @param {number} width slice width
 * @param {number} height slice height
 * @param {number} frames temporal depth
 * @param {number} [pairs=4096] number of random pairs to sample
 * @returns {{rms: number, chance: number, ratio: number}} correlation figures
 */
export function crossPixelTemporalCorrelation(
  bytes,
  width,
  height,
  frames,
  pairs = 4096,
) {
  const sliceSize = width * height;
  const rand = new StbnRandom("stbn|cross-pixel-correlation|v1");
  const a = new Float64Array(frames);
  const b = new Float64Array(frames);
  let sumSq = 0;

  for (let n = 0; n < pairs; n++) {
    const p = rand.nextInt(sliceSize);
    let q = rand.nextInt(sliceSize);
    if (q === p) {
      q = (q + 1) % sliceSize;
    }
    let ma = 0;
    let mb = 0;
    for (let t = 0; t < frames; t++) {
      a[t] = bytes[t * sliceSize + p];
      b[t] = bytes[t * sliceSize + q];
      ma += a[t];
      mb += b[t];
    }
    ma /= frames;
    mb /= frames;
    let num = 0;
    let da = 0;
    let db = 0;
    for (let t = 0; t < frames; t++) {
      const x = a[t] - ma;
      const y = b[t] - mb;
      num += x * y;
      da += x * x;
      db += y * y;
    }
    const denom = Math.sqrt(da * db);
    const r = denom > 0 ? num / denom : 0;
    sumSq += r * r;
  }

  const rms = Math.sqrt(sumSq / pairs);
  const chance = 1 / Math.sqrt(frames - 1);
  return { rms, chance, ratio: rms / chance };
}

/**
 * The certification bars.
 *
 * Every entry is a distance from the white-noise null of 1.0. The comment on
 * each records the value a healthy 128x128x64 bake measures, so the margin is
 * visible at the point of change rather than buried in a report.
 */
export const BARS = Object.freeze({
  // Spatial low band (bottom eighth of the radial range). White noise: 1.00.
  // Measured on the shipped bake: see stbn-manifest.json. A stack of pure
  // void-and-cluster slices reaches roughly 0.02; the annealing trades some
  // of that away for temporal structure, and the bar is placed well above
  // both so an ordinary parameter change cannot trip it while a collapse
  // toward white cannot pass it.
  spatialLowMax: 0.3,
  // Spatial high band (top half). White noise: 1.00.
  spatialHighMin: 1.1,
  // The radial spectrum must actually RISE across the three bands, which is
  // the shape statement in the published characterisation and is not implied
  // by the two band bars on their own.
  spatialMonotone: true,
  // Temporal low band (bottom eighth of the temporal Nyquist range).
  // White noise, and a stack of independent blue slices, both sit at 1.00.
  temporalLowMax: 0.6,
  // Temporal high band (top half).
  temporalHighMin: 1.05,
  // Cross-pixel temporal correlation, as a multiple of the chance level. The
  // degenerate value-offset construction scores near `sqrt(frames-1)` times
  // chance; independent time lines score ~1.
  crossCorrelationRatioMax: 2.0,
});

/**
 * Measure a volume and check it against {@link BARS}.
 *
 * @param {Uint8Array} bytes slice-major volume bytes
 * @param {number} width slice width
 * @param {number} height slice height
 * @param {number} frames temporal depth
 * @returns {{spatial: object, temporal: object, crossCorrelation: object, failures: Array<string>, pass: boolean}} verdict
 */
export function certify(bytes, width, height, frames) {
  const spatial = spatialSpectrum(bytes, width, height, frames);
  const temporal = temporalSpectrum(bytes, width, height, frames);
  const crossCorrelation = crossPixelTemporalCorrelation(
    bytes,
    width,
    height,
    frames,
  );

  /** @type {Array<string>} */
  const failures = [];
  if (!(spatial.low <= BARS.spatialLowMax)) {
    failures.push(
      `spatial low band ${spatial.low.toFixed(4)} > ${BARS.spatialLowMax}`,
    );
  }
  if (!(spatial.high >= BARS.spatialHighMin)) {
    failures.push(
      `spatial high band ${spatial.high.toFixed(4)} < ${BARS.spatialHighMin}`,
    );
  }
  if (BARS.spatialMonotone && !(spatial.low < spatial.mid)) {
    failures.push(
      `spatial spectrum not rising: low ${spatial.low.toFixed(4)} >= ` +
        `mid ${spatial.mid.toFixed(4)}`,
    );
  }
  if (BARS.spatialMonotone && !(spatial.mid < spatial.high)) {
    failures.push(
      `spatial spectrum not rising: mid ${spatial.mid.toFixed(4)} >= ` +
        `high ${spatial.high.toFixed(4)}`,
    );
  }
  if (!(temporal.low <= BARS.temporalLowMax)) {
    failures.push(
      `temporal low band ${temporal.low.toFixed(4)} > ${BARS.temporalLowMax}`,
    );
  }
  if (!(temporal.high >= BARS.temporalHighMin)) {
    failures.push(
      `temporal high band ${temporal.high.toFixed(4)} < ${BARS.temporalHighMin}`,
    );
  }
  if (!(crossCorrelation.ratio <= BARS.crossCorrelationRatioMax)) {
    failures.push(
      `cross-pixel temporal correlation ${crossCorrelation.ratio.toFixed(3)}x ` +
        `chance > ${BARS.crossCorrelationRatioMax}x`,
    );
  }

  return {
    spatial,
    temporal,
    crossCorrelation,
    failures,
    pass: failures.length === 0,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// MUTANTS
// ─────────────────────────────────────────────────────────────────────────────
// Each mutant is an EXACT construction derived from a certified volume, not an
// approximation and not a second bake. That matters: a mutant built by running
// a degraded generator would leave open the question of whether it failed
// because the criterion works or because the degraded generator was simply
// bad. These three are transformations whose spectral consequence is provable
// from the transformation itself.

/**
 * White in space and in time: an independent uniform permutation per slice.
 * Keeps the per-slice histogram exactly uniform, so it fails the spectra and
 * nothing else — the discriminator cannot be passing on a histogram artefact.
 *
 * @param {Uint8Array} bytes slice-major volume bytes
 * @param {number} width slice width
 * @param {number} height slice height
 * @param {number} frames temporal depth
 * @returns {Uint8Array} the mutant
 */
export function mutantWhite(bytes, width, height, frames) {
  const sliceSize = width * height;
  const out = new Uint8Array(bytes.length);
  const rand = new StbnRandom("stbn|mutant|white|v1");
  for (let t = 0; t < frames; t++) {
    const base = t * sliceSize;
    const perm = rand.permutation(sliceSize);
    for (let i = 0; i < sliceSize; i++) {
      out[base + i] = bytes[base + perm[i]];
    }
  }
  return out;
}

/**
 * Blue in space, white in time: every slice is a toroidal SHIFT of slice 0.
 *
 * Spatial blueness is preserved exactly — the power spectrum is invariant
 * under a cyclic shift, so each slice's radial spectrum is byte-for-byte the
 * spectrum of a certified blue slice. Each pixel's time series becomes 64
 * readings of that mask at 64 unrelated locations, i.e. white. This is the
 * mutant that the temporal criterion exists to reject, and it is a STRONGER
 * test than a spatial-only generator would be, because there is no doubt at
 * all about its spatial quality.
 *
 * @param {Uint8Array} bytes slice-major volume bytes
 * @param {number} width slice width
 * @param {number} height slice height
 * @param {number} frames temporal depth
 * @returns {Uint8Array} the mutant
 */
export function mutantSpatialOnlyBlue(bytes, width, height, frames) {
  const sliceSize = width * height;
  const out = new Uint8Array(bytes.length);
  const rand = new StbnRandom("stbn|mutant|spatial-only|v1");
  for (let t = 0; t < frames; t++) {
    const sx = rand.nextInt(width);
    const sy = rand.nextInt(height);
    for (let y = 0; y < height; y++) {
      const srcY = (y + sy) % height;
      for (let x = 0; x < width; x++) {
        const srcX = (x + sx) % width;
        out[t * sliceSize + y * width + x] = bytes[srcY * width + srcX];
      }
    }
  }
  return out;
}

/**
 * White in space, blue in time: one global pixel permutation applied to EVERY
 * slice.
 *
 * Because the same permutation is used for all slices, pixel `p`'s entire time
 * series moves intact to position `perm(p)` — so the temporal spectrum is
 * identical to the source volume's, while the spatial arrangement within each
 * slice is uniformly scrambled. It proves the SPATIAL half of the gate fires,
 * which the two mutants above cannot.
 *
 * @param {Uint8Array} bytes slice-major volume bytes
 * @param {number} width slice width
 * @param {number} height slice height
 * @param {number} frames temporal depth
 * @returns {Uint8Array} the mutant
 */
export function mutantTemporalOnlyBlue(bytes, width, height, frames) {
  const sliceSize = width * height;
  const out = new Uint8Array(bytes.length);
  const rand = new StbnRandom("stbn|mutant|temporal-only|v1");
  const perm = rand.permutation(sliceSize);
  for (let t = 0; t < frames; t++) {
    const base = t * sliceSize;
    for (let i = 0; i < sliceSize; i++) {
      out[base + i] = bytes[base + perm[i]];
    }
  }
  return out;
}
