// structure-similarity.mjs — windowed SSIM (structural similarity) between
// two same-sized scalar fields.
// @purpose Compute windowed SSIM between two scalar fields (and an RGBA-reducing wrapper) so structural change is measurable where a mean or a band mean is blind to it.
// @status ACTIVE
//
// WHY THIS EXISTS. Same C15-08 requirement as `connected-components.mjs`:
// "never use a band mean for a faint sparse additive signal." A global mean
// (or a mean-absolute-difference) treats a uniform brightness offset and a
// scrambled rearrangement of the same energy as interchangeable whenever their
// average magnitude matches. SSIM does not — it is built from per-window mean,
// variance and COVARIANCE, and covariance collapses toward zero exactly when
// the two fields stop moving together pixel-for-pixel, independent of how
// their overall brightness compares. `metrics-structure.spec.mjs` test 5
// builds a brightened copy and a structurally scrambled copy of the same field
// with equal mean-absolute-difference and shows their `mssim` differ sharply.
//
// THE FORMULA (Wang et al. 2004), per window, with means mu, variances
// sigma^2, covariance sigma_xy, and `c1 = (k1*L)^2`, `c2 = (k2*L)^2` where L is
// `dynamicRange`:
//
//   SSIM = (2*mu_x*mu_y + c1)(2*sigma_xy + c2)
//          -----------------------------------
//          (mu_x^2 + mu_y^2 + c1)(sigma_x^2 + sigma_y^2 + c2)
//
// `k1 = 0.01` and `k2 = 0.03` are the constants OF THE DEFINITION (they fix
// what "structural similarity" means), not tuning knobs — they are named here
// so a caller can see them, not so a caller is expected to change them.
//
// WINDOWING. The field is tiled into non-overlapping `windowSize x
// windowSize` windows starting at (0,0), stepping by `windowSize`; a window
// that runs past the field's right/bottom edge is clipped to the pixels that
// exist rather than padded, so every window's statistics are over real data.
// `map` holds one SSIM value per window in raster order of the windows
// themselves; `mssim` is their mean. A field no larger than `windowSize` in
// both dimensions produces exactly one window — `metrics-structure.spec.mjs`
// tests 4 and 5 use that case deliberately so the expected `mssim` reduces to
// a single hand-checkable formula instead of an average over many windows.
//
// RGBA REDUCTION RULE. `structureSimilarityRgba` reduces RGBA bytes to Rec.
// 709 luma (`0.2126*R + 0.7152*G + 0.0722*B`) before calling `structureSimilarity`.
// This is the SAME constant `connected-components.mjs` uses, restated rather
// than imported so the two modules stay self-contained (see that file's RGBA
// REDUCTION RULE note) — the agreement is a rule both files obey, not a shared
// dependency.

/**
 * Rec. 709 luma of one RGBA pixel.
 *
 * @param {number} r Red, 0-255.
 * @param {number} g Green, 0-255.
 * @param {number} b Blue, 0-255.
 * @returns {number} Luma.
 */
function rec709Luma(r, g, b) {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/**
 * Validate a `{width, height, data}` scalar field.
 *
 * @param {{width: number, height: number, data: ArrayLike<number>}} field Field.
 * @param {string} label Name used in thrown messages ("a" or "b").
 */
function validateScalarField(field, label) {
  if (field === null || typeof field !== "object") {
    throw new Error(`structureSimilarity: ${label} must be an object`);
  }
  const { width, height, data } = field;
  if (!Number.isInteger(width) || width <= 0) {
    throw new Error(
      `structureSimilarity: ${label}.width must be a positive integer, got ${width}`,
    );
  }
  if (!Number.isInteger(height) || height <= 0) {
    throw new Error(
      `structureSimilarity: ${label}.height must be a positive integer, got ${height}`,
    );
  }
  if (
    data === null ||
    typeof data !== "object" ||
    typeof data.length !== "number"
  ) {
    throw new Error(`structureSimilarity: ${label}.data must be array-like`);
  }
  const expected = width * height;
  if (data.length !== expected) {
    throw new Error(
      `structureSimilarity: ${label} ${width}x${height} data length mismatch — ` +
        `got ${data.length}, expected ${expected} (scalar)`,
    );
  }
}

/**
 * Windowed SSIM between two same-sized single-channel fields.
 *
 * @param {{width: number, height: number, data: ArrayLike<number>}} a First field.
 * @param {{width: number, height: number, data: ArrayLike<number>}} b Second field.
 * @param {{windowSize?: number, dynamicRange?: number, k1?: number, k2?: number}} [options]
 *   `windowSize` (default 8) — side length of the (non-overlapping, clipped at
 *   the edges) tiling window. `dynamicRange` (default 255) — the value range
 *   `L` in the formula above. `k1` (default 0.01), `k2` (default 0.03) — the
 *   standard SSIM stabilization constants; see the module header.
 * @returns {{mssim: number, map: number[], windows: number}} `mssim` is the
 *   mean of `map`; `map` holds one SSIM value per window in raster order;
 *   `windows === map.length`.
 * @throws {Error} If `a` and `b` differ in width or height, naming both sizes.
 */
export function structureSimilarity(a, b, options = {}) {
  validateScalarField(a, "a");
  validateScalarField(b, "b");
  if (a.width !== b.width || a.height !== b.height) {
    throw new Error(
      `structureSimilarity: dimension mismatch — a is ${a.width}x${a.height}, ` +
        `b is ${b.width}x${b.height}`,
    );
  }
  const { width, height } = a;
  const windowSize = options.windowSize ?? 8;
  if (!Number.isInteger(windowSize) || windowSize <= 0) {
    throw new Error(
      `structureSimilarity: options.windowSize must be a positive integer, got ${windowSize}`,
    );
  }
  const dynamicRange = options.dynamicRange ?? 255;
  const k1 = options.k1 ?? 0.01;
  const k2 = options.k2 ?? 0.03;
  const c1 = (k1 * dynamicRange) ** 2;
  const c2 = (k2 * dynamicRange) ** 2;

  const map = [];
  for (let wy = 0; wy < height; wy += windowSize) {
    const yEnd = Math.min(wy + windowSize, height);
    for (let wx = 0; wx < width; wx += windowSize) {
      const xEnd = Math.min(wx + windowSize, width);
      const n = (xEnd - wx) * (yEnd - wy);

      let sumA = 0;
      let sumB = 0;
      for (let y = wy; y < yEnd; y++) {
        const row = y * width;
        for (let x = wx; x < xEnd; x++) {
          const idx = row + x;
          sumA += a.data[idx];
          sumB += b.data[idx];
        }
      }
      const muA = sumA / n;
      const muB = sumB / n;

      let varA = 0;
      let varB = 0;
      let covAB = 0;
      for (let y = wy; y < yEnd; y++) {
        const row = y * width;
        for (let x = wx; x < xEnd; x++) {
          const idx = row + x;
          const da = a.data[idx] - muA;
          const db = b.data[idx] - muB;
          varA += da * da;
          varB += db * db;
          covAB += da * db;
        }
      }
      varA /= n;
      varB /= n;
      covAB /= n;

      const numerator = (2 * muA * muB + c1) * (2 * covAB + c2);
      const denominator = (muA * muA + muB * muB + c1) * (varA + varB + c2);
      map.push(numerator / denominator);
    }
  }

  const windows = map.length;
  const mssim = map.reduce((sum, v) => sum + v, 0) / windows;
  return { mssim, map, windows };
}

/**
 * `structureSimilarity` over RGBA fields, reduced to Rec. 709 luma first.
 *
 * @param {{width: number, height: number, data: ArrayLike<number>}} a First
 *   field, `data.length === width*height*4`.
 * @param {{width: number, height: number, data: ArrayLike<number>}} b Second
 *   field, same layout.
 * @param {{windowSize?: number, dynamicRange?: number, k1?: number, k2?: number}} [options]
 *   Forwarded to `structureSimilarity` — see there for defaults.
 * @returns {{mssim: number, map: number[], windows: number}} Same shape as
 *   `structureSimilarity`.
 * @throws {Error} If either field's `data.length` is not `width*height*4`, or
 *   if the two fields' dimensions differ (see `structureSimilarity`).
 */
export function structureSimilarityRgba(a, b, options = {}) {
  const reduce = (field, label) => {
    if (field === null || typeof field !== "object") {
      throw new Error(`structureSimilarityRgba: ${label} must be an object`);
    }
    const { width, height, data } = field;
    const expected = width * height * 4;
    if (data?.length !== expected) {
      throw new Error(
        `structureSimilarityRgba: ${label} ${width}x${height} data length ` +
          `mismatch — got ${data?.length}, expected ${expected} (rgba)`,
      );
    }
    const luma = new Float64Array(width * height);
    for (let i = 0; i < luma.length; i++) {
      luma[i] = rec709Luma(data[i * 4], data[i * 4 + 1], data[i * 4 + 2]);
    }
    return { width, height, data: luma };
  };
  return structureSimilarity(reduce(a, "a"), reduce(b, "b"), options);
}
