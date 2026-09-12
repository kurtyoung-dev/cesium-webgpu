/**
 * Pure spectral + fractal statistics for Campaign 13 cloud probes (O5 Structure).
 * @purpose Radially averaged power-spectrum slope fit and area-perimeter fractal
 *   dimension for cloud-alpha fields, plus a seeded synthetic fBm field generator
 *   for validating the analyzer against a KNOWN answer before it is ever pointed
 *   at a render (C13-N04, O5 gate: target slope -5/3 +/- 0.3, D = 1.35 +/- 0.15).
 * @status ACTIVE
 *
 * No npm dependency, no browser API. The 2-D transform below is a hand-rolled
 * separable DFT (see `dft1d`/`transform2d`), not an FFT — O(N^2) per 1-D pass,
 * O(N^3) for a full square transform. That is deliberate: this module is
 * exercised on the 64-256px synthetic fields the spec builds and on
 * probe-captured cloud-alpha crops at similar scale, where a few million
 * multiply-adds costs low single-digit milliseconds in Node. It would NOT be
 * an appropriate choice for a full-resolution capture frame; that would want
 * a real FFT, which this module intentionally does not implement.
 */

const MIN_BAND_BINS = 5;
const MIN_BLOB_COUNT = 5;
// A 1-pixel or few-pixel blob's perimeter is dominated by which side of a
// pixel-grid diagonal it happened to fall on, not by the underlying shape's
// geometry — e.g. a single pixel has area=1, perimeter=4, which plots as an
// extreme outlier on any area-perimeter power law regardless of the true
// fractal dimension. 12px (roughly a 3x4 block) is the floor below which
// quantization, not shape, dominates the perimeter measurement.
const MINIMUM_BLOB_AREA_PIXELS = 12;

/**
 * Deterministic 32-bit PRNG (mulberry32). Same seed -> same byte stream, which
 * is what lets `syntheticFractionalBrownianField` promise reproducible fields.
 * @param {number} seed
 * @returns {() => number} generator of floats in [0, 1)
 */
function createSeededRandom(seed) {
  let state = seed >>> 0;
  return function nextUnitFloat() {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function assertField(field, width, height, label = "field") {
  if (!Number.isInteger(width) || width < 2) {
    throw new RangeError(`${label}: width must be an integer >= 2`);
  }
  if (!Number.isInteger(height) || height < 2) {
    throw new RangeError(`${label}: height must be an integer >= 2`);
  }
  if (
    !field ||
    typeof field.length !== "number" ||
    field.length !== width * height
  ) {
    throw new TypeError(
      `${label} must be an array-like of length width*height`,
    );
  }
}

/**
 * Maps a 0-based FFT bin index to its signed frequency component (cycles per
 * whole-domain length). Works for even and odd sizes; sign is irrelevant to
 * every caller here because they only ever consume the radial magnitude, but
 * using the same convention in the analyzer and the generator is what makes
 * the generator's authored slope land where the analyzer expects it.
 * @param {number} index
 * @param {number} size
 */
function signedFrequencyComponent(index, size) {
  return index <= size / 2 ? index : index - size;
}

/**
 * One column/row of a separable real-input DFT (or its inverse). O(N^2).
 * @param {Float64Array} re
 * @param {Float64Array} im
 * @param {boolean} inverse
 */
function dft1d(re, im, inverse) {
  const n = re.length;
  const outRe = new Float64Array(n);
  const outIm = new Float64Array(n);
  const sign = inverse ? 1 : -1;
  for (let k = 0; k < n; k++) {
    let sumRe = 0;
    let sumIm = 0;
    for (let t = 0; t < n; t++) {
      const angle = (sign * 2 * Math.PI * k * t) / n;
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);
      sumRe += re[t] * cos - im[t] * sin;
      sumIm += re[t] * sin + im[t] * cos;
    }
    if (inverse) {
      sumRe /= n;
      sumIm /= n;
    }
    outRe[k] = sumRe;
    outIm[k] = sumIm;
  }
  return { re: outRe, im: outIm };
}

/**
 * Separable 2-D DFT (or inverse), row pass then column pass. The 2-D kernel
 * exp(-2*pi*i*(kx*x/W + ky*y/H)) factors exactly into a per-axis product, so
 * two 1-D passes reproduce the full 2-D transform with no approximation.
 * @param {Float64Array} reField length width*height, row-major
 * @param {Float64Array} imField length width*height, row-major
 */
function transform2d(reField, imField, width, height, inverse) {
  const rowRe = new Float64Array(width * height);
  const rowIm = new Float64Array(width * height);
  const bufRe = new Float64Array(width);
  const bufIm = new Float64Array(width);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      bufRe[x] = reField[y * width + x];
      bufIm[x] = imField[y * width + x];
    }
    const { re: outRe, im: outIm } = dft1d(bufRe, bufIm, inverse);
    for (let x = 0; x < width; x++) {
      rowRe[y * width + x] = outRe[x];
      rowIm[y * width + x] = outIm[x];
    }
  }
  const outRe = new Float64Array(width * height);
  const outIm = new Float64Array(width * height);
  const colRe = new Float64Array(height);
  const colIm = new Float64Array(height);
  for (let x = 0; x < width; x++) {
    for (let y = 0; y < height; y++) {
      colRe[y] = rowRe[y * width + x];
      colIm[y] = rowIm[y * width + x];
    }
    const { re: cRe, im: cIm } = dft1d(colRe, colIm, inverse);
    for (let y = 0; y < height; y++) {
      outRe[y * width + x] = cRe[y];
      outIm[y * width + x] = cIm[y];
    }
  }
  return { re: outRe, im: outIm };
}

function hannWeight(index, size) {
  if (size <= 1) {
    return 1;
  }
  return 0.5 * (1 - Math.cos((2 * Math.PI * index) / (size - 1)));
}

/**
 * Separable Hann taper. A field crop has a hard, non-periodic edge that the
 * DFT implicitly treats as if it repeated — the resulting discontinuity
 * injects energy across every wavenumber (spectral leakage), and because
 * that leaked energy does not follow the field's own k^slope law it biases a
 * naive log-log fit, typically steepening (over-negative) the recovered
 * slope. Tapering both axes to zero at the border removes the discontinuity
 * at the cost of a small, well-understood loss of low-k resolution.
 */
function applyHannWindow(field, width, height) {
  const wx = new Float64Array(width);
  for (let x = 0; x < width; x++) {
    wx[x] = hannWeight(x, width);
  }
  const wy = new Float64Array(height);
  for (let y = 0; y < height; y++) {
    wy[y] = hannWeight(y, height);
  }
  const windowed = new Float64Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      windowed[y * width + x] = field[y * width + x] * wx[x] * wy[y];
    }
  }
  return windowed;
}

function meanOf(field) {
  let sum = 0;
  for (let i = 0; i < field.length; i++) {
    sum += field[i];
  }
  return sum / field.length;
}

/**
 * Ordinary least squares on (x, y) pairs, shared by the spectral slope fit
 * and the area-perimeter fractal fit. Returns null when x has no spread
 * (every sample the same wavenumber/area) rather than dividing by ~0.
 */
function linearLeastSquares(xs, ys) {
  const n = xs.length;
  let sumX = 0;
  let sumY = 0;
  let sumXX = 0;
  let sumXY = 0;
  for (let i = 0; i < n; i++) {
    sumX += xs[i];
    sumY += ys[i];
    sumXX += xs[i] * xs[i];
    sumXY += xs[i] * ys[i];
  }
  const meanX = sumX / n;
  const meanY = sumY / n;
  const denominator = sumXX - n * meanX * meanX;
  if (!(Math.abs(denominator) > 1e-12)) {
    return null;
  }
  const slope = (sumXY - n * meanX * meanY) / denominator;
  const intercept = meanY - slope * meanX;
  let ssRes = 0;
  let ssTot = 0;
  for (let i = 0; i < n; i++) {
    const predicted = slope * xs[i] + intercept;
    ssRes += (ys[i] - predicted) ** 2;
    ssTot += (ys[i] - meanY) ** 2;
  }
  const r2 = ssTot > 1e-12 ? 1 - ssRes / ssTot : ssRes < 1e-12 ? 1 : 0;
  return { slope, intercept, r2, sampleCount: n };
}

/**
 * Radially averaged power spectrum of a scalar field (e.g. cloud-alpha).
 * Removes the mean, applies a separable Hann window, forward-transforms, and
 * bins |F(kx,ky)|^2 by physical radial wavenumber (cycles/metre).
 * @param {ArrayLike<number>} field length width*height, row-major
 * @param {{width:number, height:number, metresPerPixel:number}} options
 * @returns {{bins: Array<{k:number, wavelengthMetres:number, power:number, count:number}>, width:number, height:number, metresPerPixel:number, binCount:number, nyquistWavenumberPerMetre:number}}
 */
export function radialPowerSpectrum(field, options) {
  const { width, height, metresPerPixel } = options ?? {};
  assertField(field, width, height);
  if (!(metresPerPixel > 0)) {
    throw new RangeError("metresPerPixel must be a positive number");
  }

  // A genuinely constant field should detrend to EXACT zero, but summing
  // many copies of the same value to compute a mean is not perfectly
  // associative in floating point, so `field[i] - mean` can leave a few ULPs
  // of residue — and that residue's error bound GROWS with field.length, so
  // no fixed epsilon on the subtracted result is safe at every field size.
  // Sidestep the arithmetic entirely: check constancy directly on the raw
  // values (an exact, size-independent comparison) before computing any
  // mean, and short-circuit straight to an exact-zero detrended field.
  // Otherwise that residue rides through the window and DFT as spurious
  // "signal" and produces a confident-looking but meaningless slope.
  let isConstant = true;
  for (let i = 1; i < field.length; i++) {
    if (field[i] !== field[0]) {
      isConstant = false;
      break;
    }
  }
  const detrended = new Float64Array(field.length);
  if (!isConstant) {
    const mean = meanOf(field);
    for (let i = 0; i < field.length; i++) {
      detrended[i] = field[i] - mean;
    }
  }
  const windowed = applyHannWindow(detrended, width, height);
  const imZero = new Float64Array(windowed.length);
  const { re, im } = transform2d(windowed, imZero, width, height, false);

  const domainWidthMetres = width * metresPerPixel;
  const domainHeightMetres = height * metresPerPixel;
  // Isotropic pixel size means the true Nyquist limit is the same on both
  // axes; a non-square field just samples that same k-range unevenly.
  const nyquistWavenumberPerMetre = 1 / (2 * metresPerPixel);
  const binCount = Math.max(1, Math.floor(Math.min(width, height) / 2));
  const binWidth = nyquistWavenumberPerMetre / binCount;

  const sumPower = new Float64Array(binCount);
  const sumK = new Float64Array(binCount);
  const count = new Uint32Array(binCount);

  for (let y = 0; y < height; y++) {
    const fy = signedFrequencyComponent(y, height);
    const kyPerMetre = fy / domainHeightMetres;
    for (let x = 0; x < width; x++) {
      const fx = signedFrequencyComponent(x, width);
      if (fx === 0 && fy === 0) {
        continue; // DC already removed; skip rather than let it pollute bin 0
      }
      const kxPerMetre = fx / domainWidthMetres;
      const k = Math.hypot(kxPerMetre, kyPerMetre);
      let binIndex = Math.floor(k / binWidth);
      if (binIndex >= binCount) {
        binIndex = binCount - 1; // corner frequencies exceed the isotropic Nyquist circle
      }
      const index = y * width + x;
      const power = re[index] * re[index] + im[index] * im[index];
      sumPower[binIndex] += power;
      sumK[binIndex] += k;
      count[binIndex]++;
    }
  }

  const bins = [];
  for (let b = 0; b < binCount; b++) {
    if (count[b] === 0) {
      continue;
    }
    const meanK = sumK[b] / count[b];
    bins.push({
      k: meanK,
      wavelengthMetres: meanK > 0 ? 1 / meanK : Infinity,
      power: sumPower[b] / count[b],
      count: count[b],
    });
  }
  bins.sort((left, right) => left.k - right.k);

  return {
    bins,
    width,
    height,
    metresPerPixel,
    binCount,
    nyquistWavenumberPerMetre,
  };
}

/**
 * Least-squares fit of log10(power) vs log10(k) restricted to a physical
 * wavelength band. Returns a `failures` array instead of throwing so callers
 * can distinguish "measured a slope" from "could not measure one" without a
 * try/catch — but the contract is the same either way: an empty `failures`
 * array is the only condition under which `slope` is a real measurement.
 * @param {ReturnType<typeof radialPowerSpectrum>} spectrum
 * @param {{minWavelengthMetres:number, maxWavelengthMetres:number, minimumBandBins?:number}} options
 */
export function fitSpectralSlope(spectrum, options) {
  const { minWavelengthMetres, maxWavelengthMetres } = options ?? {};
  const minimumBandBins = options?.minimumBandBins ?? MIN_BAND_BINS;
  if (!(minWavelengthMetres > 0) || !(maxWavelengthMetres > 0)) {
    throw new RangeError(
      "minWavelengthMetres and maxWavelengthMetres must be positive",
    );
  }
  const lowWavelength = Math.min(minWavelengthMetres, maxWavelengthMetres);
  const highWavelength = Math.max(minWavelengthMetres, maxWavelengthMetres);

  const bandBins = spectrum.bins.filter(
    (bin) =>
      bin.wavelengthMetres >= lowWavelength &&
      bin.wavelengthMetres <= highWavelength &&
      bin.power > 0 &&
      Number.isFinite(bin.power),
  );

  if (bandBins.length < minimumBandBins) {
    return {
      slope: null,
      intercept: null,
      r2: null,
      sampleCount: bandBins.length,
      bandBins,
      failures: [
        `insufficient-band-bins: found ${bandBins.length} usable bin(s) in ` +
          `[${lowWavelength}, ${highWavelength}] m, need >= ${minimumBandBins}`,
      ],
    };
  }

  const xs = bandBins.map((bin) => Math.log10(bin.k));
  const ys = bandBins.map((bin) => Math.log10(bin.power));
  const fit = linearLeastSquares(xs, ys);
  if (!fit) {
    return {
      slope: null,
      intercept: null,
      r2: null,
      sampleCount: bandBins.length,
      bandBins,
      failures: [
        "degenerate-band: every surviving bin has the same wavenumber",
      ],
    };
  }
  return {
    slope: fit.slope,
    intercept: fit.intercept,
    r2: fit.r2,
    sampleCount: fit.sampleCount,
    bandBins,
    failures: [],
  };
}

/**
 * 4-connected component labeling of a binary mask via BFS flood fill.
 * @returns {Array<{pixels: number[], touchesBorder: boolean}>}
 */
function labelConnectedComponents(mask, width, height) {
  const visited = new Uint8Array(mask.length);
  const queue = new Int32Array(mask.length);
  const components = [];
  for (let start = 0; start < mask.length; start++) {
    if (!mask[start] || visited[start]) {
      continue;
    }
    let head = 0;
    let tail = 0;
    queue[tail++] = start;
    visited[start] = 1;
    const pixels = [];
    let touchesBorder = false;
    while (head < tail) {
      const index = queue[head++];
      pixels.push(index);
      const x = index % width;
      const y = (index / width) | 0;
      if (x === 0 || x === width - 1 || y === 0 || y === height - 1) {
        touchesBorder = true;
      }
      if (x > 0 && mask[index - 1] && !visited[index - 1]) {
        visited[index - 1] = 1;
        queue[tail++] = index - 1;
      }
      if (x < width - 1 && mask[index + 1] && !visited[index + 1]) {
        visited[index + 1] = 1;
        queue[tail++] = index + 1;
      }
      if (y > 0 && mask[index - width] && !visited[index - width]) {
        visited[index - width] = 1;
        queue[tail++] = index - width;
      }
      if (y < height - 1 && mask[index + width] && !visited[index + width]) {
        visited[index + width] = 1;
        queue[tail++] = index + width;
      }
    }
    components.push({ pixels, touchesBorder });
  }
  return components;
}

/** Count of pixel edges in `pixels` facing a non-cloud pixel or the border. */
function measurePerimeter(mask, width, height, pixels) {
  let perimeter = 0;
  for (const index of pixels) {
    const x = index % width;
    const y = (index / width) | 0;
    perimeter += y === 0 || !mask[index - width] ? 1 : 0;
    perimeter += y === height - 1 || !mask[index + width] ? 1 : 0;
    perimeter += x === 0 || !mask[index - 1] ? 1 : 0;
    perimeter += x === width - 1 || !mask[index + 1] ? 1 : 0;
  }
  return perimeter;
}

/**
 * Area-perimeter fractal dimension (Lovejoy 1982): threshold the field at
 * each of `thresholds`, label the resulting 4-connected blobs, and fit
 * log(perimeter) = (D/2)*log(area) + c across every surviving blob pooled
 * from every threshold. Blobs touching the image border are excluded (their
 * true area/perimeter is truncated by the crop, not by the cloud edge), and
 * blobs below `minimumAreaPixels` are excluded (perimeter is quantization-
 * dominated at that size — see MINIMUM_BLOB_AREA_PIXELS).
 * @param {ArrayLike<number>} field length width*height, row-major
 * @param {{width:number, height:number, thresholds:number[], minimumAreaPixels?:number, minimumBlobCount?:number}} options
 */
export function areaPerimeterFractalDimension(field, options) {
  const { width, height, thresholds } = options ?? {};
  assertField(field, width, height);
  if (!Array.isArray(thresholds) || thresholds.length === 0) {
    throw new TypeError("thresholds must be a non-empty array");
  }
  const minimumAreaPixels =
    options?.minimumAreaPixels ?? MINIMUM_BLOB_AREA_PIXELS;
  const minimumBlobCount = options?.minimumBlobCount ?? MIN_BLOB_COUNT;

  const blobs = [];
  for (const threshold of thresholds) {
    const mask = new Uint8Array(width * height);
    for (let i = 0; i < field.length; i++) {
      mask[i] = field[i] >= threshold ? 1 : 0;
    }
    const components = labelConnectedComponents(mask, width, height);
    for (const component of components) {
      if (component.touchesBorder) {
        continue;
      }
      const area = component.pixels.length;
      if (area < minimumAreaPixels) {
        continue;
      }
      const perimeter = measurePerimeter(mask, width, height, component.pixels);
      if (perimeter <= 0) {
        continue;
      }
      blobs.push({ threshold, area, perimeter });
    }
  }

  if (blobs.length < minimumBlobCount) {
    return {
      dimension: null,
      intercept: null,
      r2: null,
      blobCount: blobs.length,
      blobs,
      failures: [
        `insufficient-blobs: found ${blobs.length} usable blob(s), need >= ${minimumBlobCount}`,
      ],
    };
  }

  const xs = blobs.map((blob) => Math.log(blob.area));
  const ys = blobs.map((blob) => Math.log(blob.perimeter));
  const fit = linearLeastSquares(xs, ys);
  if (!fit) {
    return {
      dimension: null,
      intercept: null,
      r2: null,
      blobCount: blobs.length,
      blobs,
      failures: ["degenerate-blobs: every surviving blob has the same area"],
    };
  }
  return {
    dimension: fit.slope * 2,
    intercept: fit.intercept,
    r2: fit.r2,
    blobCount: blobs.length,
    blobs,
    failures: [],
  };
}

/**
 * Seeded fractional-Brownian scalar field with a KNOWN radial power-spectrum
 * slope, for validating `radialPowerSpectrum`/`fitSpectralSlope` before they
 * are ever pointed at a render. Built directly in the frequency domain: each
 * bin gets amplitude proportional to k^(slope/2) (so power ~ k^slope) and a
 * seeded random phase, Hermitian-mirrored so the inverse transform is exactly
 * real (up to floating-point noise, which is discarded).
 * @param {{width:number, height:number, slope:number, seed:number}} options
 * @returns {Float64Array} length width*height, row-major
 */
export function syntheticFractionalBrownianField(options) {
  const { width, height, slope, seed } = options ?? {};
  if (!Number.isInteger(width) || width < 2) {
    throw new RangeError("width must be an integer >= 2");
  }
  if (!Number.isInteger(height) || height < 2) {
    throw new RangeError("height must be an integer >= 2");
  }
  if (!Number.isFinite(slope)) {
    throw new RangeError("slope must be a finite number");
  }
  const rng = createSeededRandom(seed ?? 0);

  const specRe = new Float64Array(width * height);
  const specIm = new Float64Array(width * height);
  const visited = new Uint8Array(width * height);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const index = y * width + x;
      if (visited[index]) {
        continue;
      }
      const mirrorX = (width - x) % width;
      const mirrorY = (height - y) % height;
      const mirrorIndex = mirrorY * width + mirrorX;

      const fx = signedFrequencyComponent(x, width);
      const fy = signedFrequencyComponent(y, height);
      const k = Math.hypot(fx, fy);
      const amplitude = k === 0 ? 0 : Math.pow(k, slope / 2);

      if (mirrorIndex === index) {
        // Self-conjugate cell (DC, and the Nyquist row/column/corner when a
        // dimension is even) must be real or the inverse transform picks up
        // a spurious imaginary residue at that exact bin.
        const sign = rng() < 0.5 ? -1 : 1;
        specRe[index] = amplitude * sign;
        specIm[index] = 0;
        visited[index] = 1;
      } else {
        const phase = rng() * 2 * Math.PI;
        const re = amplitude * Math.cos(phase);
        const im = amplitude * Math.sin(phase);
        specRe[index] = re;
        specIm[index] = im;
        specRe[mirrorIndex] = re;
        specIm[mirrorIndex] = -im;
        visited[index] = 1;
        visited[mirrorIndex] = 1;
      }
    }
  }

  const { re } = transform2d(specRe, specIm, width, height, true);
  return re;
}
