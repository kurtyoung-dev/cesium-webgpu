// celestial-g3-gate.mjs — pure metrics + verdict logic for the Campaign-12
// **G3** gate ("asset upgrade": the star-map cube faces themselves).
// @purpose Pure metrics and verdicts for G3 (star-map cube-face asset quality), criterion 2 re-pointed after DR-01 moved resolved stars to the sprite catalogue.
// @status ACTIVE
//
// WHAT G3 IS — VERBATIM
// ---------------------
// `QUEUE_2026-07-19_CAMPAIGN12.md` §5:
//
//   G3 | Asset upgrade | <= 2.0 arcmin/px; >=10x sources/steradian vs the t3
//   baseline; median chroma >= 0.20 (**fails immediately under 4:2:0 JPEG**, so
//   it doubles as the format gate); **dust-lane structure** via low-pass
//   residual IQR >= 3x current.
//
// and, longer, `CELESTIAL_APPEARANCE_RESEARCH_2026-07-19.md:274`:
//
//   G3 — Asset upgrade (C11-178). Cubemap-only, both backends. PASS:
//   (1) angular sampling <= 2.0 arcmin/px (>= 2700 px/face; 4096 recommended);
//   (2) M1 sources per steradian >= 10x the tycho2t3 baseline;
//   (3) M3 median chroma >= 0.20 — which fails immediately under 4:2:0 JPEG and
//       so doubles as the format gate;
//   (4) dust-lane structure: low-pass a Milky-Way-centred crop (sigma ~ 16 px)
//       to remove point sources, then require the IQR of the residual diffuse
//       background >= 3x the current asset's. Dust lanes are large-scale
//       NEGATIVE structure in the diffuse component; no point-source metric can
//       see them. The sigma and 3x need one calibration pass against the chosen
//       asset.
//
// The two texts agree numerically, and the research text supplies the missing
// operational detail: (1)'s px/face equivalent (2700), (4)'s kernel and the
// statement that its constants are owed one calibration pass. That calibration
// pass is `Tools/visual-regression/output/celestial-g3.json` plus the DERIVATION
// table recorded against each constant below.
//
// ─── WHAT CHANGED UNDER THE ASSET, AND WHY CRITERION (2) IS RE-POINTED ─────
//
// G3 was written in W1, BEFORE ruling DR-01 (§6c, 2026-07-19) assigned one
// physical owner to each celestial signal: the cube map carries DIFFUSE Milky
// Way light only, and every RESOLVED star comes from the sprite catalogue.
// `C12-11` (Batch 833) shipped that seam — `SkyBox.defaultVariant` is
// `TYCHO_T5_DIFFUSE`, whose six faces census **0 resolved point sources BY
// CONSTRUCTION**.
//
// So criterion (2), read literally ("the CUBE MAP must resolve >= 10x the t3
// baseline's sources per steradian"), now asks the shipped asset to do the
// exact thing a ratified decision removed from it. It is not measurable as a
// cube-map property any more, and lowering it to fit would be re-litigating
// DR-01 with a threshold.
//
// This module therefore does what Batch 848 did for `probe-stars-catalog.mjs`
// and CO-3 did for G1 Lane A: **the claim moves to what owns it now, the
// superseded form is still MEASURED, and the supersession is recorded rather
// than silently dropped.** Concretely, (2) becomes three bound predicates —
//
//   (2a) the DIFFUSE faces census ~0 resolved sources        — the seam holds;
//   (2b) the UN-BLURRED reversal artifact censuses many       — the detector is
//        not simply blind (a positive control, not a bar to clear);
//   (2c) the sprite catalogue supplies the resolved stars     — record count and
//        limiting magnitude at or beyond what `C12-09` shipped;
//
// — while the literal ratio (delivered resolved sources per steradian vs the
// measured t3 cube-map census) is computed every run and reported under
// {@link REVERSAL_TRIGGER}. It is DR-01's own reversal trigger #2 ("sprite count
// required for ISS-reference density proves prohibitive"), and DR-01 says to
// decide those on evidence. G3 measures the trigger; it does not rule on it.
//
// ─── WHY THESE METRICS AND NOT THE OBVIOUS ONES ────────────────────────────
//
// §5's own opening applies here more than anywhere: "Acceptance is measured,
// never eyeballed — and never by mean luminance. Convolution with any
// normalized kernel preserves the mean exactly." Every metric below is
// second-order or better:
//
//   * ANGULAR SAMPLING is a geometric fact of the decoded face, not a statistic.
//   * DUST-LANE STRUCTURE is the IQR of the LOW-PASSED image. Dust lanes are
//     large-scale NEGATIVE structure: they are holes in the diffuse component,
//     invisible to any point metric and invisible to the mean (a lane and its
//     surrounding band average back to the same number).
//   * CHROMA is a median over the band pixels, so it survives the JPEG ringing
//     that would wreck a max, and it is taken in HSV saturation, which is
//     exactly the quantity 4:2:0 chroma decimation attacks.
//   * The FORMAT arm additionally reads the JPEG SOF component sampling factors
//     straight out of the served bytes. That is not a proxy for 4:2:0 — it IS
//     4:2:0, decided by the file's own header, and it costs no decode.
//
// ─── BOTH BACKENDS, IDENTICALLY ────────────────────────────────────────────
//
// Campaign principle 5. The cube faces are backend-neutral bytes, so the ASSET
// arms must come out identical on WebGL and WebGPU by construction — which
// makes a disagreement there a real finding (a variant default that resolved
// differently per backend, or a served-byte difference), not noise. The LIVE
// arms (the on-screen split census and the moving-camera legs) are genuinely
// per-backend. {@link foldG3Verdict} evaluates every criterion per backend and
// names the backend in each failure string; a one-backend pass is a FAIL.
//
// Pure functions over typed arrays: no browser, no Playwright, no engine
// imports, no image-decode dependency. `celestial-g3-gate.spec.mjs` exercises
// every function under `node --test` with synthetic ground truth and with the
// REAL bundled t3/t5/t5-diffuse measurements as fixtures.

import { createHash } from "node:crypto";

import { percentile, rgbToHsv } from "./celestial-metrics.mjs";
import { replaceOwnedResourceTransaction } from "./owned-resource-transaction.mjs";
import {
  DR01_LIMITS,
  bandStructure,
  pointSourceCensus,
} from "../../skybox-bake/starmap-census.mjs";

export { replaceOwnedResourceTransaction } from "./owned-resource-transaction.mjs";

// ---------------------------------------------------------------------------
// GEOMETRY — angular sampling of a cube face.
// ---------------------------------------------------------------------------

/**
 * Angular span of one cube-map face edge, in degrees. A cube face is the image
 * of a 90-degree-by-90-degree pyramid; this is the number the research text's
 * "2700 px/face" equivalence is built on.
 * @type {number}
 */
export const CUBE_FACE_SPAN_DEG = 90;

/**
 * Arcminutes per pixel for a square cube face of `faceSizePx` pixels a side.
 *
 * DEFINITION PIN. This is the NOMINAL sampling `span / size`, i.e.
 * `90 * 60 / faceSizePx`, NOT the tangent-corrected density at the face centre.
 * The definition is fixed by the research text's own arithmetic, which is
 * reproduced exactly by this formula and by no other: it states "1024/face
 * gives ~5.3 arcmin/px" (5400/1024 = 5.273), "4096/face gives ~1.3 arcmin/px"
 * (5400/4096 = 1.318), and gives ">= 2700 px/face" as the equivalent of the
 * <= 2.0 bar (5400/2700 = 2.000). The tangent-corrected centre density is
 * coarser by 4/pi ~ 1.27 and would make every one of those three statements
 * wrong, so it is not what the gate means.
 *
 * @param {number} faceSizePx
 * @returns {number} arcmin per pixel, or NaN for a non-positive/absent size
 */
export function arcminPerPixel(faceSizePx) {
  if (!Number.isFinite(faceSizePx) || faceSizePx <= 0) {
    return NaN;
  }
  return (CUBE_FACE_SPAN_DEG * 60) / faceSizePx;
}

/**
 * Degrees per pixel for a square cube face — the conversion that lets a single
 * ANGULAR low-pass sigma be applied to faces of different pixel sizes.
 *
 * @param {number} faceSizePx
 * @returns {number}
 */
export function degreesPerPixel(faceSizePx) {
  if (!Number.isFinite(faceSizePx) || faceSizePx <= 0) {
    return NaN;
  }
  return CUBE_FACE_SPAN_DEG / faceSizePx;
}

/**
 * Solid angle of one cube face, in steradians. Six faces tile the whole sphere,
 * so each is exactly `4*pi/6`; the tangent distortion redistributes sources
 * WITHIN a face but cannot change the total the face subtends.
 * @type {number}
 */
export const STERADIANS_PER_FACE = (4 * Math.PI) / 6;

/** Full sphere, in steradians. @type {number} */
export const STERADIANS_FULL_SKY = 4 * Math.PI;

// ---------------------------------------------------------------------------
// LUMINANCE + LOW-PASS.
// ---------------------------------------------------------------------------

/**
 * Rec.709 luma of an interleaved 8-bit buffer, in the STORED (sRGB-encoded)
 * domain and on a caller-supplied stride.
 *
 * The stored domain rather than linear light is deliberate and matches
 * `Tools/skybox-bake/starmap-census.mjs`'s `toLuminance`, so the census floors
 * that module derives (minPeak 40, minContrast 24) mean the same thing here.
 * The stride exists because the same face arrives as RGB from a Node decode and
 * as RGBA from a canvas readback.
 *
 * @param {ArrayLike<number>} data
 * @param {number} width
 * @param {number} height
 * @param {number} [stride=4] 3 for packed RGB, 4 for RGBA
 * @returns {Float32Array} length width*height
 */
export function luminanceStrided(data, width, height, stride = 4) {
  const n = width * height;
  const out = new Float32Array(n);
  for (let p = 0; p < n; p++) {
    const i = p * stride;
    out[p] = 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
  }
  return out;
}

/**
 * Box width that makes THREE successive box passes approximate a Gaussian of
 * standard deviation `sigmaPx`.
 *
 * A box of width w has variance (w^2 - 1)/12; n independent passes add
 * variances, so n*(w^2 - 1)/12 = sigma^2 gives w = sqrt(12*sigma^2/n + 1). The
 * result is rounded to the nearest ODD integer so the kernel stays centred (an
 * even box shifts the image by half a pixel, which would show up as a spurious
 * gradient at exactly the scale this metric measures).
 *
 * The odd constraint biases the REALIZED sigma up by a consistent ~0.5 px,
 * because the ideal width is ~2*sigma and lands on an even number for the sigmas
 * this lane uses. Stated rather than corrected: the identical kernel is applied
 * to every tier, so the bias cancels out of criterion (4)'s ratio, and pinning
 * an exact sigma would cost either the centring or the O(pixels) running sum.
 * `celestial-g3-gate.spec.mjs` asserts the bias stays in [0, 0.6].
 *
 * Three passes rather than a true Gaussian convolution because the box form is
 * O(pixels) per pass via a running sum — the 2048-px faces are 4.2 Mpx each and
 * a direct sigma=16 Gaussian would be ~100 taps per pixel per axis — and
 * because an integer running sum is bit-reproducible across the Node and
 * in-page evaluations of this same function.
 *
 * @param {number} sigmaPx
 * @param {number} [passes=3]
 * @returns {number} odd box width >= 1
 */
export function boxWidthForSigma(sigmaPx, passes = 3) {
  if (!Number.isFinite(sigmaPx) || sigmaPx <= 0) {
    return 1;
  }
  const ideal = Math.sqrt((12 * sigmaPx * sigmaPx) / passes + 1);
  let w = Math.round(ideal);
  if (w % 2 === 0) {
    w += 1;
  }
  return Math.max(1, w);
}

/**
 * Number of box passes used by {@link lowPass}. Exported so the spec can build
 * the same kernel independently.
 * @type {number}
 */
export const LOW_PASS_BOX_PASSES = 3;

/**
 * One separable box-blur pass with edge REPLICATION, over a Float32 plane.
 *
 * Replication rather than wrap: a cube face is not periodic, and wrapping would
 * fold the opposite limb of the galaxy onto the near one. The contamination
 * replication does introduce is bounded by the kernel support, and
 * {@link dustLaneStructure} discards a margin wider than that support before it
 * samples, so no replicated value ever reaches a reported number.
 *
 * @param {Float32Array} src
 * @param {number} width
 * @param {number} height
 * @param {number} boxWidth odd
 * @returns {Float32Array} new plane
 */
export function boxBlurPass(src, width, height, boxWidth) {
  const radius = (boxWidth - 1) / 2;
  const denom = boxWidth;
  const horizontal = new Float32Array(width * height);
  for (let y = 0; y < height; y++) {
    const row = y * width;
    let sum = 0;
    for (let d = -radius; d <= radius; d++) {
      const x = d < 0 ? 0 : d >= width ? width - 1 : d;
      sum += src[row + x];
    }
    for (let x = 0; x < width; x++) {
      horizontal[row + x] = sum / denom;
      const outX = x - radius;
      const inX = x + radius + 1;
      const outIdx = outX < 0 ? 0 : outX >= width ? width - 1 : outX;
      const inIdx = inX < 0 ? 0 : inX >= width ? width - 1 : inX;
      sum += src[row + inIdx] - src[row + outIdx];
    }
  }
  const vertical = new Float32Array(width * height);
  for (let x = 0; x < width; x++) {
    let sum = 0;
    for (let d = -radius; d <= radius; d++) {
      const y = d < 0 ? 0 : d >= height ? height - 1 : d;
      sum += horizontal[y * width + x];
    }
    for (let y = 0; y < height; y++) {
      vertical[y * width + x] = sum / denom;
      const outY = y - radius;
      const inY = y + radius + 1;
      const outIdx = outY < 0 ? 0 : outY >= height ? height - 1 : outY;
      const inIdx = inY < 0 ? 0 : inY >= height ? height - 1 : inY;
      sum += horizontal[inIdx * width + x] - horizontal[outIdx * width + x];
    }
  }
  return vertical;
}

/**
 * Approximate Gaussian low-pass of `sigmaPx` via {@link LOW_PASS_BOX_PASSES}
 * box passes.
 *
 * @param {Float32Array} lum
 * @param {number} width
 * @param {number} height
 * @param {number} sigmaPx
 * @returns {{plane:Float32Array,boxWidth:number,supportPx:number}}
 *   `supportPx` is the half-width of the combined kernel — the margin that must
 *   be discarded before sampling.
 */
export function lowPass(lum, width, height, sigmaPx) {
  const boxWidth = boxWidthForSigma(sigmaPx, LOW_PASS_BOX_PASSES);
  let plane = lum;
  for (let i = 0; i < LOW_PASS_BOX_PASSES; i++) {
    plane = boxBlurPass(plane, width, height, boxWidth);
  }
  return {
    plane,
    boxWidth,
    supportPx: (LOW_PASS_BOX_PASSES * (boxWidth - 1)) / 2,
  };
}

// ---------------------------------------------------------------------------
// CRITERION (4) — DUST-LANE STRUCTURE.
// ---------------------------------------------------------------------------

/**
 * The research text's low-pass sigma, expressed as an ANGLE rather than a pixel
 * count.
 *
 * DERIVATION. The text says "sigma ~ 16 px" without naming a resolution, and it
 * was written against a cube face whose recommended size is 2700-4096 px. Left
 * in pixels, the SAME constant low-passes a 1024-px t3 face over 1.41 degrees
 * and a 2048-px t5 face over 0.70 degrees — i.e. the legacy asset would be
 * smoothed twice as hard as the candidate, and the "3x" ratio between them
 * would be measuring the kernel rather than the maps. So the sigma is pinned in
 * ANGLE and converted per face:
 *
 *     16 px at the SHIPPED 2048-px face size
 *   = 16 * (90 / 2048) deg
 *   = 0.703125 deg
 *
 * which is the same number the text intends at the resolution the fork actually
 * ships, and which is comfortably wider than the DR-01 bake's own low-pass
 * (sigma 0.4395 deg, FWHM 1.0349 deg per `skybox-manifest.json`) — so this
 * metric sits on the LARGE-scale side of the blur that made the diffuse map and
 * measures what that blur was supposed to KEEP.
 * @type {number}
 */
export const DUST_LANE_SIGMA_DEG = 16 * (CUBE_FACE_SPAN_DEG / 2048);

/**
 * Fraction of the face edge discarded on every side before the dust-lane IQR is
 * sampled.
 *
 * Two things have to be excluded and one kept. EXCLUDED: the replication margin
 * of the low-pass (bounded by `supportPx`, ~1.2% of a 2048 face) and the cube
 * SEAM neighbourhood, where the reprojection's own bilinear resampling and the
 * JPEG's block grid both misbehave. KEPT: the band itself, which crosses whole
 * faces — a crop small enough to sit inside one lane would measure the lane's
 * interior rather than the lane against its surroundings.
 *
 * 10% of the edge on each side leaves the central 64% of the face area, i.e.
 * the central ~72-degree-by-72-degree cone. At 2048 px that is a 205-px margin
 * against a `supportPx` of 48 — a 4x margin over the kernel — and the sampled
 * region still spans several times the ~10-degree width of the galactic band.
 * @type {number}
 */
export const DUST_LANE_MARGIN_FRACTION = 0.1;

/**
 * IQR of the LOW-PASSED image over the interior crop — criterion (4)'s
 * "dust-lane structure".
 *
 * WHY IQR AND NOT VARIANCE. The quantity of interest is how far the diffuse
 * background swings between lane and band. A variance is dominated by whatever
 * extreme survives the low-pass (a saturated star core smeared into a broad
 * bump still moves it a long way); the interquartile range is a rank statistic,
 * so it reports the bulk swing and ignores the tails that criterion (4)
 * explicitly does not want ("no point-source metric can see them").
 *
 * WHY THE LOW-PASSED IMAGE AND NOT THE RESIDUAL. §5's phrase is "low-pass
 * residual IQR", and the research text disambiguates it: "low-pass ... to remove
 * point sources, then require the IQR of the residual DIFFUSE BACKGROUND". The
 * "residual" is what is LEFT after the point sources are removed — the smoothed
 * plane — not the high-frequency remainder, which is the point sources
 * themselves. {@link granularityIQR} measures that other quantity separately,
 * because the DR-01 smear trigger needs both.
 *
 * @param {Float32Array} lum
 * @param {number} width
 * @param {number} height
 * @param {{sigmaPx?:number,marginFraction?:number}} [options]
 * @returns {{iqr:number,p25:number,p50:number,p75:number,samples:number,
 *            sigmaPx:number,boxWidth:number,supportPx:number,marginPx:number}}
 */
export function dustLaneStructure(lum, width, height, options = {}) {
  const sigmaPx = options.sigmaPx ?? 16;
  const marginFraction = options.marginFraction ?? DUST_LANE_MARGIN_FRACTION;
  const { plane, boxWidth, supportPx } = lowPass(lum, width, height, sigmaPx);
  const marginX = Math.floor(width * marginFraction);
  const marginY = Math.floor(height * marginFraction);
  /** @type {number[]} */
  const values = [];
  for (let y = marginY; y < height - marginY; y++) {
    const row = y * width;
    for (let x = marginX; x < width - marginX; x++) {
      values.push(plane[row + x]);
    }
  }
  values.sort((a, b) => a - b);
  const p25 = percentile(values, 0.25);
  const p75 = percentile(values, 0.75);
  return {
    iqr: p75 - p25,
    p25,
    p50: percentile(values, 0.5),
    p75,
    samples: values.length,
    sigmaPx,
    boxWidth,
    supportPx,
    marginPx: Math.min(marginX, marginY),
  };
}

/**
 * IQR of the HIGH-frequency remainder (`lum - lowPass(lum)`) over the same
 * interior crop.
 *
 * This is the complement of {@link dustLaneStructure} and it is what the DR-01
 * seam DELETES: resolved stars, and the sub-degree granularity a reader calls
 * "grain". It certifies nothing on its own — a JPEG's own ringing lands here
 * too — but the ratio of a candidate's granularity to the un-blurred bake's is
 * the measurable half of reversal trigger #1 ("the blurred Milky Way reads as a
 * SMEAR rather than granular structure").
 *
 * @param {Float32Array} lum
 * @param {number} width
 * @param {number} height
 * @param {{sigmaPx?:number,marginFraction?:number}} [options]
 * @returns {{iqr:number,p25:number,p75:number,samples:number,sigmaPx:number}}
 */
export function granularityIQR(lum, width, height, options = {}) {
  const sigmaPx = options.sigmaPx ?? 16;
  const marginFraction = options.marginFraction ?? DUST_LANE_MARGIN_FRACTION;
  const { plane } = lowPass(lum, width, height, sigmaPx);
  const marginX = Math.floor(width * marginFraction);
  const marginY = Math.floor(height * marginFraction);
  /** @type {number[]} */
  const values = [];
  for (let y = marginY; y < height - marginY; y++) {
    const row = y * width;
    for (let x = marginX; x < width - marginX; x++) {
      values.push(lum[row + x] - plane[row + x]);
    }
  }
  values.sort((a, b) => a - b);
  const p25 = percentile(values, 0.25);
  const p75 = percentile(values, 0.75);
  return { iqr: p75 - p25, p25, p75, samples: values.length, sigmaPx };
}

// ---------------------------------------------------------------------------
// CRITERION (3) — CHROMA, AND THE FORMAT ARM.
// ---------------------------------------------------------------------------

/**
 * Luminance percentile above which a pixel counts as "band" for the chroma
 * sample.
 *
 * The shipped M3 (`celestial-metrics.m3Chroma`) samples HSV saturation at the
 * positions `m1PointSourceCensus` returned. On a DIFFUSE face that set is empty
 * by construction, so the criterion it feeds is dead — the same dead end CO-3
 * hit on G1 Lane A, and it is re-pointed the same way: at the pixels that carry
 * the signal the asset is now supposed to deliver, which for a diffuse map is
 * the galactic band rather than any star.
 *
 * The 90th percentile is a rank cut, so it selects "the brightest tenth of THIS
 * face" without reference to any absolute level — a face that points away from
 * the galactic centre is legitimately fainter (`skybox-manifest.json`: peak
 * luminance 8 on `px` against 28 on `py`) and an absolute floor tuned to either
 * would mis-sample the other. It also keeps the sample far from the near-black
 * pixels where 8-bit quantization makes HSV saturation meaningless: one code
 * value of chroma noise on a luminance-2 pixel reads as saturation 0.5.
 * @type {number}
 */
export const CHROMA_BAND_PERCENTILE = 0.9;

/**
 * Median HSV saturation over the band pixels, plus the sample size.
 *
 * Histogrammed rather than sorted: a 2048-px face is 4.2 Mpx and the callers run
 * this over 18 faces per invocation. Saturation is bounded in [0,1] so a
 * 1024-bin histogram resolves the median to ~1e-3, which is two orders finer
 * than the 0.20 bar.
 *
 * @param {ArrayLike<number>} data interleaved 8-bit
 * @param {number} width
 * @param {number} height
 * @param {number} [stride=4]
 * @param {{bandPercentile?:number}} [options]
 * @returns {{medianSaturation:number,meanSaturation:number,sampleCount:number,
 *            bandThreshold:number}}
 */
export function bandChroma(data, width, height, stride = 4, options = {}) {
  const bandPercentile = options.bandPercentile ?? CHROMA_BAND_PERCENTILE;
  const lum = luminanceStrided(data, width, height, stride);
  const n = width * height;

  // Luminance histogram over the stored 0..255 domain -> band threshold.
  const lumHist = new Uint32Array(256);
  for (let p = 0; p < n; p++) {
    const b = Math.min(255, Math.max(0, Math.round(lum[p])));
    lumHist[b]++;
  }
  const wanted = bandPercentile * n;
  let cumulative = 0;
  let bandThreshold = 0;
  for (let b = 0; b < 256; b++) {
    cumulative += lumHist[b];
    if (cumulative >= wanted) {
      bandThreshold = b;
      break;
    }
  }

  const SAT_BINS = 1024;
  const satHist = new Uint32Array(SAT_BINS + 1);
  let sampleCount = 0;
  let satSum = 0;
  for (let p = 0; p < n; p++) {
    if (lum[p] < bandThreshold) {
      continue;
    }
    const i = p * stride;
    const { s } = rgbToHsv(data[i], data[i + 1], data[i + 2]);
    satHist[Math.min(SAT_BINS, Math.max(0, Math.round(s * SAT_BINS)))]++;
    satSum += s;
    sampleCount++;
  }
  if (sampleCount === 0) {
    return {
      medianSaturation: 0,
      meanSaturation: 0,
      sampleCount: 0,
      bandThreshold,
    };
  }
  let seen = 0;
  let medianSaturation = 0;
  for (let b = 0; b <= SAT_BINS; b++) {
    seen += satHist[b];
    if (seen >= sampleCount / 2) {
      medianSaturation = b / SAT_BINS;
      break;
    }
  }
  return {
    medianSaturation,
    meanSaturation: satSum / sampleCount,
    sampleCount,
    bandThreshold,
  };
}

/**
 * Read the chroma-subsampling factors out of a JPEG's own SOF marker.
 *
 * Criterion (3) says the chroma bar "fails immediately under 4:2:0 JPEG, so it
 * doubles as the format gate". That is an inference about pixels; the header is
 * the fact. A baseline/progressive JPEG's SOFn segment lists, per component, a
 * packed byte of horizontal (high nibble) and vertical (low nibble) sampling
 * factors. 4:2:0 luma is 2x2 against 1x1 chroma; 4:4:4 is 1x1 throughout.
 *
 * Parses headers only — no entropy decode, no dependency, and it is safe to run
 * on the SERVED bytes inside a probe as well as on the repo file inside a spec.
 * Fails CLOSED: anything it cannot parse returns `subsampling: "unknown"` rather
 * than a guess.
 *
 * @param {Uint8Array|ArrayLike<number>} bytes
 * @returns {{subsampling:string,components:number,
 *            factors:{id:number,h:number,v:number}[],marker:string|null}}
 */
export function jpegChromaSubsampling(bytes) {
  const unknown = {
    subsampling: "unknown",
    components: 0,
    factors: [],
    marker: null,
  };
  if (!bytes || bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) {
    return unknown;
  }
  let i = 2;
  // Bounded: every iteration advances `i` by at least 2, and the loop is capped
  // by the buffer length regardless.
  const LIMIT = bytes.length;
  let guard = 0;
  while (i + 3 < bytes.length && guard++ < LIMIT) {
    if (bytes[i] !== 0xff) {
      i += 1;
      continue;
    }
    const marker = bytes[i + 1];
    if (
      marker === 0xd8 ||
      marker === 0x01 ||
      (marker >= 0xd0 && marker <= 0xd7)
    ) {
      i += 2;
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) {
      return unknown; // reached scan data without an SOF
    }
    const length = (bytes[i + 2] << 8) | bytes[i + 3];
    const isSof =
      marker >= 0xc0 &&
      marker <= 0xcf &&
      marker !== 0xc4 &&
      marker !== 0xc8 &&
      marker !== 0xcc;
    if (isSof) {
      const base = i + 4;
      const componentCount = bytes[base + 5];
      const factors = [];
      for (let c = 0; c < componentCount; c++) {
        const off = base + 6 + c * 3;
        if (off + 1 >= bytes.length) {
          return unknown;
        }
        factors.push({
          id: bytes[off],
          h: bytes[off + 1] >> 4,
          v: bytes[off + 1] & 0x0f,
        });
      }
      let subsampling = "unknown";
      if (componentCount === 1) {
        subsampling = "grayscale";
      } else if (factors.length >= 3) {
        const [y, cb, cr] = factors;
        const chromaIs1x1 =
          cb.h === 1 && cb.v === 1 && cr.h === 1 && cr.v === 1;
        if (chromaIs1x1 && y.h === 1 && y.v === 1) {
          subsampling = "4:4:4";
        } else if (chromaIs1x1 && y.h === 2 && y.v === 2) {
          subsampling = "4:2:0";
        } else if (chromaIs1x1 && y.h === 2 && y.v === 1) {
          subsampling = "4:2:2";
        } else if (chromaIs1x1 && y.h === 1 && y.v === 2) {
          subsampling = "4:4:0";
        }
      }
      return {
        subsampling,
        components: componentCount,
        factors,
        marker: `0x${marker.toString(16)}`,
      };
    }
    i += 2 + length;
  }
  return unknown;
}

/**
 * The chroma subsampling a G3-passing face must carry.
 *
 * Not a derived number — it is what criterion (3) names as the immediate
 * failure ("fails immediately under 4:2:0 JPEG"), and what
 * `Tools/skybox-bake/skybox-manifest.json` records the shipped bake as
 * producing (`chromaSubsampling: "4:4:4"`).
 * @type {string}
 */
export const REQUIRED_CHROMA_SUBSAMPLING = "4:4:4";

// ---------------------------------------------------------------------------
// PER-FACE ANALYSIS — one decoded cube face in, one metric record out.
// ---------------------------------------------------------------------------

/**
 * Run every asset-side G3 metric over one decoded cube face.
 *
 * The point census and the band-structure metric are IMPORTED from
 * `Tools/skybox-bake/starmap-census.mjs` rather than re-implemented: that module
 * is the detector `skybox-diffuse-seam.spec.mjs` already validates against
 * synthetic ground truth and mutates to prove it has teeth, and its floors carry
 * a written derivation tied to the bake's own blur width. A second census would
 * be a second thing to keep in step.
 *
 * @param {{data:ArrayLike<number>,width:number,height:number,stride?:number,
 *          bytes?:Uint8Array}} face
 * @returns {object} metric record
 */
export function analyzeFace(face) {
  const { data, width, height } = face;
  const stride = face.stride ?? 4;
  const lum = luminanceStrided(data, width, height, stride);
  const sigmaPx = DUST_LANE_SIGMA_DEG / degreesPerPixel(width);
  const census = pointSourceCensus(lum, width, height);
  const band = bandStructure(lum, width, height, Math.max(8, width >> 4));
  const dust = dustLaneStructure(lum, width, height, { sigmaPx });
  const grain = granularityIQR(lum, width, height, { sigmaPx });
  const chroma = bandChroma(data, width, height, stride);
  return {
    width,
    height,
    arcminPerPixel: arcminPerPixel(width),
    sources: census.count,
    peakLuminance: census.peakMax,
    strongestContrast: census.strongest,
    bandStdDev: band.stdDev,
    bandMean: band.mean,
    dustLaneIQR: dust.iqr,
    dustLaneP25: dust.p25,
    dustLaneP75: dust.p75,
    dustLaneSigmaPx: dust.sigmaPx,
    dustLaneBoxWidth: dust.boxWidth,
    granularityIQR: grain.iqr,
    medianChroma: chroma.medianSaturation,
    meanChroma: chroma.meanSaturation,
    chromaSamples: chroma.sampleCount,
    chromaBandThreshold: chroma.bandThreshold,
    sourcesPerSteradian: census.count / STERADIANS_PER_FACE,
    subsampling: face.bytes
      ? jpegChromaSubsampling(face.bytes).subsampling
      : null,
  };
}

/**
 * Fold six per-face records into one variant-level record.
 *
 * MEDIAN, not mean, for every per-face quantity. Band strength is a property of
 * where a face points, not of the bake (`skybox-manifest.json`: `bandStdDev`
 * 0.70 on `mx` against 1.94 on `mz`), so a mean is dragged by whichever face
 * holds the galactic centre; the median names the TYPICAL face. Counts are
 * summed, because a source census over the whole sky genuinely is the sum.
 *
 * @param {Record<string,object>} faces face-key -> {@link analyzeFace} record
 * @returns {object}
 */
export function foldVariant(faces) {
  const records = Object.values(faces).filter(Boolean);
  const med = (pick) => {
    const xs = records
      .map(pick)
      .filter((x) => Number.isFinite(x))
      .sort((a, b) => a - b);
    return xs.length > 0 ? percentile(xs, 0.5) : NaN;
  };
  const minOf = (pick) =>
    records.reduce(
      (a, r) => (Number.isFinite(pick(r)) ? Math.min(a, pick(r)) : a),
      Infinity,
    );
  const maxOf = (pick) =>
    records.reduce(
      (a, r) => (Number.isFinite(pick(r)) ? Math.max(a, pick(r)) : a),
      -Infinity,
    );
  const totalSources = records.reduce((a, r) => a + (r.sources ?? 0), 0);
  const subsamplings = Array.from(
    new Set(records.map((r) => r.subsampling).filter((s) => s !== null)),
  );
  return {
    faceCount: records.length,
    faceSize: med((r) => r.width),
    faceSizeMin: minOf((r) => r.width),
    arcminPerPixel: med((r) => r.arcminPerPixel),
    arcminPerPixelWorst: maxOf((r) => r.arcminPerPixel),
    totalSources,
    maxFaceSources: maxOf((r) => r.sources),
    sourcesPerSteradian: totalSources / STERADIANS_FULL_SKY,
    peakLuminance: maxOf((r) => r.peakLuminance),
    medianDustLaneIQR: med((r) => r.dustLaneIQR),
    medianGranularityIQR: med((r) => r.granularityIQR),
    medianBandStdDev: med((r) => r.bandStdDev),
    medianChroma: med((r) => r.medianChroma),
    subsampling: subsamplings.length === 1 ? subsamplings[0] : "mixed",
    subsamplings,
    faces,
  };
}

// ---------------------------------------------------------------------------
// THRESHOLDS.
//
// Every constant in this block is one of exactly three kinds, and each one says
// which it is:
//
//   RATIFIED  — copied verbatim from §5 / the research text. NOT re-derived
//               here, NOT softened, and red is red.
//   SHIPPED   — the value the codebase already ships and already gates on
//               elsewhere (`DR01_LIMITS`, `MAG_CUTOFF`, the C12-09 record
//               count). Used as an anti-regression floor; nothing is invented.
//   DERIVED   — computed here, with the computation written down. Any DERIVED
//               constant that has not yet survived an Edge run is additionally
//               marked FIRST-PASS.
// ---------------------------------------------------------------------------

/**
 * RATIFIED — §5 criterion (1). "<= 2.0 arcmin/px".
 * @type {number}
 */
export const G3_MAX_ARCMIN_PER_PIXEL = 2.0;

/**
 * RATIFIED — the research text's equivalent statement of the same criterion,
 * ">= 2700 px/face". Bound as well as the arcmin form, not instead of it: the
 * two are algebraically identical (5400/2700 = 2.000) and carrying both makes a
 * red gate readable in whichever unit the reader is holding.
 * @type {number}
 */
export const G3_MIN_FACE_SIZE_PX = 2700;

/**
 * G3's shipped product subject and optional upgrade request.
 *
 * The probe asks the resolution policy for 4096 so the report can say whether
 * that separately filed upgrade exists, but the exact tier that actually
 * resolves is the product subject. A complete 2048 source proof is therefore
 * eligible for scoring and misses the ratified 2700px / 2 arcmin bars as FAIL;
 * resolution is not a structural precondition for evaluating those bars.
 */
export const G3_CERTIFICATION_VARIANT = "TYCHO_T5_DIFFUSE";
export const G3_PREFERRED_UPGRADE_RESOLUTION = "4096";
export const G3_PREFERRED_UPGRADE_FACE_SIZE_PX = 4096;
export const G3_CUBE_FACE_COUNT = 6;
export const G3_EXPECTED_DEFAULT_RESOLUTION = "2048";
export const G3_EXPECTED_DEFAULT_FACE_SIZE_PX = 2048;
const G3_EXPECTED_DEFAULT_VRAM_BYTES =
  G3_CUBE_FACE_COUNT *
  G3_EXPECTED_DEFAULT_FACE_SIZE_PX *
  G3_EXPECTED_DEFAULT_FACE_SIZE_PX *
  4;
export const G3_PREFERRED_UPGRADE_VRAM_BYTES =
  G3_CUBE_FACE_COUNT *
  G3_PREFERRED_UPGRADE_FACE_SIZE_PX *
  G3_PREFERRED_UPGRADE_FACE_SIZE_PX *
  4;
const G3_RESOLUTION_FACE_SIZE_PX = Object.freeze({
  1024: 1024,
  2048: 2048,
  4096: 4096,
});
export const G3_CUBE_FACE_KEYS = Object.freeze([
  "px",
  "mx",
  "py",
  "my",
  "pz",
  "mz",
]);
export const G3_CUBE_SOURCE_KEYS = Object.freeze({
  px: "positiveX",
  mx: "negativeX",
  py: "positiveY",
  my: "negativeY",
  pz: "positiveZ",
  mz: "negativeZ",
});

const G3_LOOPBACK_IPV4 = /^127(?:\.\d{1,3}){3}$/u;
const G3_LOCAL_ASSET_PATH = /^\/[A-Za-z0-9._~/-]+$/u;

function isG3LoopbackHostname(hostname) {
  return (
    hostname === "localhost" ||
    hostname === "[::1]" ||
    G3_LOOPBACK_IPV4.test(hostname)
  );
}

function g3LoopbackHttpOrigin(value) {
  try {
    const parsed = new URL(value);
    if (
      typeof value !== "string" ||
      (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
      !isG3LoopbackHostname(parsed.hostname) ||
      parsed.username !== "" ||
      parsed.password !== "" ||
      parsed.pathname !== "/" ||
      parsed.search !== "" ||
      parsed.hash !== ""
    ) {
      return null;
    }
    return parsed.origin;
  } catch {
    return null;
  }
}

// Turn one face URL into the two facts the preflight must bind across the
// complete cube: its local origin and its path template. Root-relative URLs
// retain an explicit same-origin marker; absolute URLs are eligible only when
// they name a loopback HTTP(S) origin. Percent escapes, dot segments, query
// strings, and fragments are rejected rather than normalized because the
// retained string is itself part of the source fingerprint.
function g3ActiveSourceUrlDescriptor(value, faceKey, servedOrigin) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.trim() !== value ||
    /[\s\\%]/u.test(value) ||
    /(?:^|\/)\.{1,2}(?:\/|$)/u.test(value)
  ) {
    return null;
  }

  let parsed;
  let origin;
  try {
    if (value.startsWith("/")) {
      if (value.startsWith("//")) {
        return null;
      }
      parsed = new URL(value, servedOrigin);
      origin = parsed.origin;
    } else {
      parsed = new URL(value);
      if (
        (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
        !isG3LoopbackHostname(parsed.hostname)
      ) {
        return null;
      }
      origin = parsed.origin;
    }
  } catch {
    return null;
  }

  if (
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.search !== "" ||
    parsed.hash !== "" ||
    origin !== servedOrigin ||
    !G3_LOCAL_ASSET_PATH.test(parsed.pathname) ||
    parsed.pathname.includes("//")
  ) {
    return null;
  }

  const faceSuffix = new RegExp(`^(.*)([_-])${faceKey}(\\.jpg)$`, "u");
  const pathMatch = parsed.pathname.match(faceSuffix);
  if (!pathMatch || pathMatch[1].length === 0) {
    return null;
  }
  return {
    origin,
    canonicalUrl: parsed.href,
    pathGrammar: `${pathMatch[1]}${pathMatch[2]}{face}${pathMatch[3]}`,
  };
}

/**
 * Versioned serialization contract for the active-source aggregate. The
 * aggregate is deliberately narrower than a whole-run fingerprint: it binds
 * the exact live certification variant, resolution, decoded dimensions, and
 * the six served URL/byte-digest pairs in canonical cube-face order.
 */
export const G3_ACTIVE_SOURCE_FINGERPRINT_SCHEMA = "cesium-g3-active-source-v1";

/**
 * Serialize one ordered active-source aggregate without hashing it. Keeping
 * the payload function public lets the producer hash its own ordered fetch
 * records while the evaluator separately reconstructs and hashes the retained
 * per-face proof. JSON avoids delimiter ambiguity in URLs.
 *
 * @param {{resolvedVariant:unknown,resolvedResolution:unknown,
 *          resolvedFaceSize:unknown,records:Array<object>}} input
 * @returns {string}
 */
export function canonicalG3ActiveSourceFingerprintPayload(input) {
  const records = Array.isArray(input?.records) ? input.records : [];
  return JSON.stringify({
    schema: G3_ACTIVE_SOURCE_FINGERPRINT_SCHEMA,
    resolvedVariant: input?.resolvedVariant ?? null,
    resolvedResolution: input?.resolvedResolution ?? null,
    resolvedFaceSize: input?.resolvedFaceSize ?? null,
    faces: records.map((record) => ({
      faceKey: record?.faceKey ?? null,
      sourceKey: record?.sourceKey ?? null,
      url: record?.url ?? null,
      sha256: record?.sha256 ?? null,
      decodedWidth: record?.decodedWidth ?? null,
      decodedHeight: record?.decodedHeight ?? null,
    })),
  });
}

/**
 * SHA-256 the canonical active-source payload.
 *
 * @param {{resolvedVariant:unknown,resolvedResolution:unknown,
 *          resolvedFaceSize:unknown,records:Array<object>}} input
 * @returns {string}
 */
export function computeG3ActiveSourceFingerprint(input) {
  return createHash("sha256")
    .update(canonicalG3ActiveSourceFingerprintPayload(input))
    .digest("hex");
}

function activeSourceFingerprintInputFromProof(proof) {
  return {
    resolvedVariant: proof?.resolvedVariant ?? null,
    resolvedResolution: proof?.resolvedResolution ?? null,
    resolvedFaceSize: proof?.resolvedFaceSize ?? null,
    records: G3_CUBE_FACE_KEYS.map((faceKey) => {
      const face = proof?.faces?.[faceKey];
      return {
        faceKey,
        sourceKey: face?.sourceKey ?? null,
        url: face?.url ?? null,
        sha256: face?.sha256 ?? null,
        decodedWidth: face?.decodedWidth ?? null,
        decodedHeight: face?.decodedHeight ?? null,
      };
    }),
  };
}

/**
 * RATIFIED — §5 criterion (3). "median chroma >= 0.20".
 * @type {number}
 */
export const G3_MIN_MEDIAN_CHROMA = 0.2;

/**
 * RATIFIED — §5 criterion (4). "low-pass residual IQR >= 3x current", where
 * "current" is the t3 baseline the upgrade replaces. The baseline is MEASURED
 * IN THE SAME RUN from the bundled t3 faces rather than read from a stored
 * number, so the ratio cannot drift as either asset changes.
 *
 * ⚠ THE RESEARCH TEXT ITSELF MARKS THIS CONSTANT AS OWED A CALIBRATION PASS:
 * "The sigma and 3x need one calibration pass against the chosen asset."
 * {@link BUNDLED_ASSET_DERIVATION} is that pass, and it reports the shipped
 * asset at 0.585x — i.e. the bar as ratified is not reachable by the asset that
 * was chosen. That is a finding for the maintainer, NOT a licence to move the
 * number, so the number does not move here.
 * @type {number}
 */
export const G3_MIN_DUST_LANE_IQR_RATIO = 3.0;

/**
 * RATIFIED — §5 criterion (2). ">=10x sources/steradian vs the t3 baseline".
 *
 * SUPERSEDED AS A CERTIFYING CRITERION BY DR-01, MEASURED ANYWAY. See this
 * module's header: the cube map no longer carries resolved sources at all, by
 * ruling, so a cube-map source-density bar is unmeasurable on the shipped
 * asset. The ratio is computed every run against the DELIVERED resolved-source
 * supply (the sprite catalogue) and reported as reversal trigger
 * `spriteDensity`; the certifying replacements are the split and catalogue
 * arms.
 * @type {number}
 */
export const G3_MIN_SOURCE_DENSITY_RATIO = 10.0;

/**
 * SHIPPED — the catalogue depth `C12-09` landed (Batch 804): 2,868 records.
 * An anti-regression floor, not a target; the row records the count and
 * `BrightStarCatalog.js`'s docblock repeats it.
 * @type {number}
 */
export const CATALOGUE_MIN_RECORDS = 2868;

/**
 * SHIPPED — `MAG_CUTOFF` in `Scene/StarFieldMath.ts`. The catalogue is vendored
 * to vmag 5.5 and the renderer drops everything fainter, so this is the
 * limiting magnitude the sky actually delivers.
 * @type {number}
 */
export const CATALOGUE_MIN_LIMITING_MAGNITUDE = 5.5;

/**
 * SHIPPED — reused from `lib/celestial-source-split.mjs` /
 * `Tools/skybox-bake/starmap-census.mjs` rather than restated: the live-frame
 * tolerance on the DR-01 seam, in resolved sources.
 * @type {number}
 */
export const DR01_LIVE_MAX_RESOLVED_SOURCES = 2;

/**
 * ⚠ FIRST-PASS DERIVED — the sub-pixel twinkle bar, as a peak-brightness RATIO
 * over one sub-pixel phase sweep.
 *
 * DERIVATION (perceptual, not fitted): stellar variability is judged in
 * magnitudes, and the naked-eye threshold for noticing a star change brightness
 * is conventionally ~0.2 mag. By the Pogson relation a ratio r corresponds to
 * 2.5*log10(r) magnitudes, so 0.2 mag is r = 10^(0.2/2.5) = 1.2023. The bar is
 * therefore 1.20 — a star whose rendered peak swings by more than 0.2 mag as the
 * camera translates it across a pixel is twinkling in the sense DR-01's reversal
 * trigger #4 means ("faint-star sprites alias or twinkle unacceptably under
 * camera motion (sub-pixel sprites are the classic failure)").
 *
 * ANALYTIC PREDICTION FOR THE SHIPPED PSF, at the lane's own framing (60 deg
 * horizontal FOV over a 1280-px canvas, so 8.1812e-4 rad/px; quad half-extent
 * `BASE_QUAD_DIAMETER_RAD/2` = 0.003 rad = 3.667 px; core sigma =
 * `STAR_PSF_SIGMA` 0.12 x 3.667 = 0.440 px), sampling
 * `(core + 0.08*halo) * smoothstep(1, 0.92, r)` on a 16x16 grid of sub-pixel
 * phases:
 *
 *   faint star (coreScale 1)          peak 0.2863..1.0800  ratio 3.77x (1.44 mag)
 *   brightest star (coreScale 2.909)  peak 0.9145..1.0800  ratio 1.18x (0.18 mag)
 *
 * So the trigger is predicted MET for faint sprites and NOT met for the
 * brightest — which is why the lane measures BOTH and treats the bright star as
 * the contrast control. FIRST-PASS because the analytic model omits the LDR
 * clamp, the premultiplied additive blend and any MSAA the real pipeline
 * applies; the Edge run re-derives it at pixels.
 * @type {number}
 */
export const TWINKLE_TRIGGER_PEAK_RATIO = 1.2;

/**
 * DERIVED (exactly zero) — the moving-camera legs must actually move. A sweep
 * whose frames are pixel-identical measured nothing about sampling phase, so
 * the leg is STRUCTURAL rather than a clean sheet. Zero is the honest bound: it
 * is an existence claim, not a level.
 * @type {number}
 */
export const MOTION_MIN_CHANGED_PIXELS = 1;

/**
 * Named reversal triggers from DR-01's "What would justify reversing (decide on
 * evidence, not impression)" list. G3 MEASURES these; it does not rule on them,
 * and none of them can turn the gate red on its own.
 */
export const REVERSAL_TRIGGER = Object.freeze({
  SMEARED_MILKY_WAY: "smearedMilkyWay",
  SPRITE_DENSITY: "spriteDensity",
  ALIAS_TWINKLE: "aliasTwinkle",
});

/**
 * The offline derivation pass over the SHIPPED bytes, recorded so that (a) the
 * spec can assert the verdict half against real numbers rather than only
 * synthetic ones, (b) the Edge run has a pre-registered expectation to be
 * checked against, and (c) the calibration the research text asked for exists
 * in writing.
 *
 * PROVENANCE. Produced by decoding the 18 bundled JPEGs under
 * `packages/engine/Source/Assets/Textures/SkyBox` and running the functions in
 * THIS file over them (median across the six faces of each variant; source
 * counts summed over the sky). Numbers differ by <1% from
 * `Tools/skybox-bake/skybox-manifest.json`'s census because the manifest counts
 * the PRE-ENCODE pixels and this counts the decoded JPEG — the bytes that
 * actually ship.
 *
 * READ THE `t5` COLUMN. Three of the four ratified criteria are missed by the
 * un-blurred t5 bake as well, so they were never reachable with the SVS product
 * Q1 selected at the size C12-10 encoded — this is not a consequence of DR-01.
 */
export const BUNDLED_ASSET_DERIVATION = Object.freeze({
  measuredAt: "2026-08-07 (CO-24, offline, from the bundled bytes)",
  t3: Object.freeze({
    faceSize: 1024,
    arcminPerPixel: 5.2734375,
    totalSources: 16474,
    sourcesPerSteradian: 1310.96,
    medianDustLaneIQR: 2.996,
    medianGranularityIQR: 5.411,
    medianBandStdDev: 2.409,
    medianChroma: 0,
    subsampling: "4:2:0",
  }),
  t5: Object.freeze({
    faceSize: 2048,
    arcminPerPixel: 2.63671875,
    totalSources: 43673,
    sourcesPerSteradian: 3475.39,
    medianDustLaneIQR: 1.94,
    medianGranularityIQR: 3.505,
    medianBandStdDev: 1.603,
    medianChroma: 0,
    subsampling: "4:4:4",
  }),
  t5diffuse: Object.freeze({
    faceSize: 2048,
    arcminPerPixel: 2.63671875,
    totalSources: 0,
    sourcesPerSteradian: 0,
    medianDustLaneIQR: 1.753,
    medianGranularityIQR: 0.4215,
    medianBandStdDev: 1.488,
    medianChroma: 0,
    peakLuminance: 28.08,
    subsampling: "4:4:4",
  }),
  ratios: Object.freeze({
    dustLaneIQR_t5diffuse_over_t3: 0.5853,
    dustLaneIQR_t5_over_t3: 0.6476,
    dustLaneIQR_t5diffuse_over_t5: 0.9038,
    granularityIQR_t5diffuse_over_t5: 0.1203,
    sourcesPerSteradian_t5_over_t3: 2.6511,
    sourcesPerSteradian_catalogue_over_t3: 0.174,
  }),
});

/** Verdict exit codes — the same contract as G1 and G2. */
export const EXIT_CODE = Object.freeze({
  PASS: 0,
  FAIL: 1,
  ERROR: 2,
  STRUCTURAL: 3,
});

// ---------------------------------------------------------------------------
// SUB-LANE EVALUATION. Every function returns `{criteria, structural, pass}`,
// and `pass` is guarded explicitly against the vacuous `{}.every(Boolean)`.
// ---------------------------------------------------------------------------

// Environment-only invariants shared by the cheap preflight and the complete
// source sub-lane. Keeping these predicates in one function prevents a target
// from clearing preflight under weaker resolution/lifecycle/VRAM rules than the
// final proof applies.
function g3UpgradeTargetFromProof(proof) {
  return {
    preferredResolution: G3_PREFERRED_UPGRADE_RESOLUTION,
    preferredFaceSize: G3_PREFERRED_UPGRADE_FACE_SIZE_PX,
    requestedResolution: proof?.requestedResolution ?? null,
    resolvedResolution: proof?.resolvedResolution ?? null,
    resolvedFaceSize: proof?.resolvedFaceSize ?? null,
    probed: proof?.requestedResolution === G3_PREFERRED_UPGRADE_RESOLUTION,
    available:
      proof?.requestedResolution === G3_PREFERRED_UPGRADE_RESOLUTION &&
      proof?.resolvedResolution === G3_PREFERRED_UPGRADE_RESOLUTION &&
      proof?.resolvedFaceSize === G3_PREFERRED_UPGRADE_FACE_SIZE_PX,
    certifyingPrerequisite: false,
  };
}

function sourceEnvironmentStructural(proof) {
  const structural = [];
  const servedOrigin = g3LoopbackHttpOrigin(proof?.servedOrigin);
  if (servedOrigin === null) {
    structural.push(
      `the served page origin was ${proof?.servedOrigin ?? "null"}; G3 active ` +
        "sources require a bound loopback HTTP(S) origin",
    );
  }
  if (proof?.requestedVariant !== G3_CERTIFICATION_VARIANT) {
    structural.push(
      `the probe requested variant ${proof?.requestedVariant ?? "null"}; G3 ` +
        `certification requires ${G3_CERTIFICATION_VARIANT}`,
    );
  }
  if (
    !Number.isInteger(G3_RESOLUTION_FACE_SIZE_PX[proof?.requestedResolution])
  ) {
    structural.push(
      `the probe requested resolution ${proof?.requestedResolution ?? "null"}; ` +
        "the requested tier must be a known resolution label",
    );
  }
  if (proof?.defaultResolution !== G3_EXPECTED_DEFAULT_RESOLUTION) {
    structural.push(
      `the runtime default resolution was ` +
        `${proof?.defaultResolution ?? "null"}; G3 must probe the optional ` +
        `upgrade without ` +
        `changing the ${G3_EXPECTED_DEFAULT_RESOLUTION} application default`,
    );
  }
  if (!Number.isFinite(proof?.maximumCubeMapSize)) {
    structural.push(
      `the device maximumCubeMapSize was ` +
        `${proof?.maximumCubeMapSize ?? "null"}; the active subject's ` +
        "allocability cannot be established",
    );
  }
  if (proof?.resolvedVariant !== G3_CERTIFICATION_VARIANT) {
    structural.push(
      `the live sky box resolved variant ${proof?.resolvedVariant ?? "null"}; ` +
        `the requested ${G3_CERTIFICATION_VARIANT} asset was not active`,
    );
  }
  const expectedResolvedFaceSize =
    G3_RESOLUTION_FACE_SIZE_PX[proof?.resolvedResolution];
  if (
    !Number.isInteger(expectedResolvedFaceSize) ||
    proof?.resolvedFaceSize !== expectedResolvedFaceSize
  ) {
    structural.push(
      `the resolution request resolved to ` +
        `${proof?.resolvedResolution ?? "null"} / ` +
        `${proof?.resolvedFaceSize ?? "null"}px; the active subject needs a ` +
        "known resolution label with its exact face size",
    );
  }
  if (
    Number.isFinite(proof?.maximumCubeMapSize) &&
    Number.isFinite(proof?.resolvedFaceSize) &&
    proof.maximumCubeMapSize < proof.resolvedFaceSize
  ) {
    structural.push(
      `the device maximumCubeMapSize ${proof.maximumCubeMapSize} cannot host ` +
        `the resolved ${proof.resolvedFaceSize}px active subject`,
    );
  }
  if (
    proof?.previousSkyBoxPresent !== true ||
    proof?.previousSkyBoxResident !== true ||
    proof?.replacementInstalled !== true ||
    proof?.previousSkyBoxDestroyed !== true ||
    proof?.candidateSkyBoxDestroyed !== false ||
    proof?.replacementHadRenderOverlap !== false
  ) {
    structural.push(
      "the resident default sky box was not replaced with a complete " +
        "single-owner transaction before any render overlap",
    );
  }
  const previousEstimatedBytes = proof?.previousEstimatedVramBytes;
  const priorResidentBytes = proof?.previousResidentEstimatedVramBytes;
  const currentBytes = proof?.currentEstimatedVramBytes;
  const peakBytes = proof?.peakEstimatedVramBytes;
  const expectedPeak = Math.max(priorResidentBytes ?? NaN, currentBytes ?? NaN);
  const expectedPriorResident =
    proof?.previousSkyBoxResident === true ? previousEstimatedBytes : 0;
  const expectedCurrentBytes = Number.isInteger(proof?.resolvedFaceSize)
    ? G3_CUBE_FACE_COUNT * proof.resolvedFaceSize * proof.resolvedFaceSize * 4
    : NaN;
  if (
    !Number.isFinite(previousEstimatedBytes) ||
    proof?.previousResolution !== G3_EXPECTED_DEFAULT_RESOLUTION ||
    proof?.previousFaceSize !== G3_EXPECTED_DEFAULT_FACE_SIZE_PX ||
    previousEstimatedBytes !== G3_EXPECTED_DEFAULT_VRAM_BYTES ||
    !Number.isFinite(priorResidentBytes) ||
    priorResidentBytes < 0 ||
    priorResidentBytes !== expectedPriorResident ||
    proof?.resolvedEstimatedVramBytes !== currentBytes ||
    currentBytes !== expectedCurrentBytes ||
    !Number.isFinite(peakBytes) ||
    peakBytes !== expectedPeak
  ) {
    structural.push(
      `the replacement residency proof was prior/current/peak ` +
        `${priorResidentBytes ?? "null"}/${currentBytes ?? "null"}/` +
        `${peakBytes ?? "null"} bytes; the exact resolved subject requires ` +
        `current ${Number.isFinite(expectedCurrentBytes) ? expectedCurrentBytes : "unknown"} ` +
        "and peak max(prior,current)",
    );
  }
  if (proof?.activeSourceCount !== G3_CUBE_FACE_COUNT) {
    structural.push(
      `the live sky box exposed ${proof?.activeSourceCount ?? "null"} face ` +
        `URLs; all ${G3_CUBE_FACE_COUNT} active sources are required`,
    );
  }
  const activeSourceKeys = Object.values(G3_CUBE_SOURCE_KEYS);
  const exactFaceKeys =
    proof?.faces !== null &&
    typeof proof?.faces === "object" &&
    Object.keys(proof.faces).length === G3_CUBE_FACE_COUNT &&
    G3_CUBE_FACE_KEYS.every((faceKey) => Object.hasOwn(proof.faces, faceKey));
  const exactActiveSourceKeys =
    proof?.activeSources !== null &&
    typeof proof?.activeSources === "object" &&
    Object.keys(proof.activeSources).length === G3_CUBE_FACE_COUNT &&
    activeSourceKeys.every((sourceKey) =>
      Object.hasOwn(proof.activeSources, sourceKey),
    );
  const exactActiveSources =
    exactFaceKeys &&
    exactActiveSourceKeys &&
    G3_CUBE_FACE_KEYS.every((faceKey) => {
      const face = proof?.faces?.[faceKey];
      const sourceKey = G3_CUBE_SOURCE_KEYS[faceKey];
      return (
        face?.sourceKey === sourceKey &&
        typeof face?.url === "string" &&
        proof?.activeSources?.[sourceKey] === face.url
      );
    });
  if (!exactActiveSources) {
    structural.push(
      "the proof requires exactly the six canonical face keys and their six " +
        "records must bind exactly to environment.activeSources",
    );
  } else {
    const descriptors = G3_CUBE_FACE_KEYS.map((faceKey) =>
      g3ActiveSourceUrlDescriptor(
        proof.faces[faceKey].url,
        faceKey,
        servedOrigin,
      ),
    );
    const first = descriptors[0];
    const exactLocalSourceSet =
      first !== null &&
      descriptors.every(
        (descriptor) =>
          descriptor !== null &&
          descriptor.origin === first.origin &&
          descriptor.pathGrammar === first.pathGrammar,
      );
    if (!exactLocalSourceSet) {
      structural.push(
        "the six active source URLs must be nonblank local assets on one " +
          "same origin with one canonical path grammar differing only by " +
          "px/mx/py/my/pz/mz",
      );
    }
  }

  return structural;
}

/**
 * Cheap source reachability preflight. This deliberately stops before any
 * capture, fetch, decode, or pixel analysis; the full source sub-lane below
 * adds those workload-dependent requirements after the requested tier exists.
 *
 * @param {object} proof environment-only source proof
 * @returns {{criteria:Object<string,boolean>,structural:string[],pass:boolean,
 *            measured:object}}
 */
export function evaluateG3SourcePreflight(proof) {
  const structural = sourceEnvironmentStructural(proof);
  const criteria =
    structural.length === 0
      ? { assetSource_preflightActiveSubjectReachable: true }
      : {};
  return {
    criteria,
    structural,
    measured: proof
      ? { ...proof, upgradeTarget: g3UpgradeTargetFromProof(proof) }
      : { upgradeTarget: g3UpgradeTargetFromProof(proof) },
    pass: structural.length === 0 && Object.values(criteria).every(Boolean),
  };
}

/**
 * SOURCE sub-lane — prove that the asset metrics came from the exact URLs on
 * the live sky box produced by an explicit `TYCHO_T5_DIFFUSE` request.
 *
 * The probe prefers 4096 so its availability is reported, but the exact tier
 * that resolves is the product subject. A complete 2048 proof reaches the
 * quality fold, where it honestly fails the ratified angular bars. Missing,
 * malformed, unhashed, or dimensionally incoherent source identity remains
 * STRUCTURAL.
 *
 * @param {object} proof
 * @returns {{criteria:Object<string,boolean>,structural:string[],pass:boolean,
 *            measured:object}}
 */
export function evaluateAssetSourceSubLane(proof) {
  const structural = sourceEnvironmentStructural(proof);
  const exactActiveResponses = G3_CUBE_FACE_KEYS.every((faceKey) => {
    const face = proof?.faces?.[faceKey];
    const descriptor = g3ActiveSourceUrlDescriptor(
      face?.url,
      faceKey,
      g3LoopbackHttpOrigin(proof?.servedOrigin),
    );
    return (
      face?.responseOk === true &&
      Number.isInteger(face?.responseStatus) &&
      face.responseStatus >= 200 &&
      face.responseStatus < 300 &&
      face?.responseRedirected === false &&
      face?.responseUrl === descriptor?.canonicalUrl
    );
  });
  if (!exactActiveResponses) {
    structural.push(
      "the active source response set was absent, non-OK, or redirected; all " +
        "six exact local URLs require successful unredirected HTTP responses " +
        "whose final URLs equal their canonical resolved requests",
    );
  }
  if (
    proof?.fetchedSourceCount !== G3_CUBE_FACE_COUNT ||
    proof?.decodedFaceCount !== G3_CUBE_FACE_COUNT
  ) {
    structural.push(
      `the fetched/decoded face counts were ` +
        `${proof?.fetchedSourceCount ?? "null"}/` +
        `${proof?.decodedFaceCount ?? "null"}; all ${G3_CUBE_FACE_COUNT} live ` +
        "sources must be fetched and decoded",
    );
  }
  const exactDecodedFaces = G3_CUBE_FACE_KEYS.every((faceKey) => {
    const face = proof?.faces?.[faceKey];
    return (
      /^[0-9a-f]{64}$/u.test(face?.sha256 ?? "") &&
      Number.isFinite(face?.bytes) &&
      face.bytes > 0 &&
      face?.decodedWidth === proof?.resolvedFaceSize &&
      face?.decodedHeight === proof?.resolvedFaceSize &&
      face.decodedWidth === face.decodedHeight
    );
  });
  if (!exactDecodedFaces) {
    structural.push(
      `all ${G3_CUBE_FACE_COUNT} faces require their own served-byte SHA-256 ` +
        `and must decode square at the resolved ` +
        `${proof?.resolvedFaceSize ?? "unknown"}px subject size`,
    );
  }
  if (proof?.decodedFaceSizeMin !== proof?.resolvedFaceSize) {
    structural.push(
      `the decoded active faces measured ` +
        `${proof?.decodedFaceSizeMin ?? "null"}px but the live sky box reported ` +
        `${proof?.resolvedFaceSize ?? "null"}px`,
    );
  }
  if (proof?.fetchedSourcesMatchEnvironmentActiveSources !== true) {
    structural.push(
      "the fetched and hashed URLs were not exactly environment.activeSources",
    );
  }
  const recomputedFingerprintSha256 = computeG3ActiveSourceFingerprint(
    activeSourceFingerprintInputFromProof(proof),
  );
  if (
    !/^[0-9a-f]{64}$/u.test(proof?.fingerprintSha256 ?? "") ||
    proof.fingerprintSha256 !== recomputedFingerprintSha256
  ) {
    structural.push(
      "the active source-set SHA-256 fingerprint is absent, malformed, or " +
        "does not match the independently recomputed ordered face URL/SHA " +
        "aggregate",
    );
  }

  const measured = proof
    ? {
        ...proof,
        recomputedFingerprintSha256,
        upgradeTarget: g3UpgradeTargetFromProof(proof),
      }
    : {
        recomputedFingerprintSha256,
        upgradeTarget: g3UpgradeTargetFromProof(proof),
      };
  const criteria =
    structural.length === 0
      ? { assetSource_exactActiveSourceSet_proven: true }
      : {};
  return {
    criteria,
    structural,
    measured,
    pass: structural.length === 0 && Object.values(criteria).every(Boolean),
  };
}

/**
 * ASSET sub-lane — criteria (1), (3) and (4), measured on the SERVED cube
 * faces of the ACTIVE variant, with the bundled t3 set measured in the same run
 * as criterion (4)'s baseline.
 *
 * @param {{active:object,t3:object,unblurred:object,activeVariant:string,
 *          chromaControl:{medianSaturation:number,expected:number}}} m
 * @returns {{criteria:Object<string,boolean>,structural:string[],pass:boolean,
 *            measured:object}}
 */
export function evaluateAssetSubLane(m) {
  const structural = [];
  const active = m?.active;
  const t3 = m?.t3;
  const unblurred = m?.unblurred;
  if (!active || !(active.faceCount > 0)) {
    structural.push(
      "the active variant's faces were never measured — no asset criterion can " +
        "be evaluated",
    );
  }
  if (!t3 || !(t3.faceCount > 0)) {
    structural.push(
      "the t3 baseline faces were never measured — criterion (4) is a RATIO " +
        "against them and is undefined without one",
    );
  }
  if (!unblurred || !(unblurred.faceCount > 0)) {
    structural.push(
      "the un-blurred t5 reversal artifact was never measured — the smear " +
        "retention arm and DR-01's reversal promise both need it",
    );
  }
  // POSITIVE CONTROL for the chroma detector. Median saturation reads 0.000 on
  // every bundled tier, which is also what a broken chroma metric reads. The
  // control feeds a synthetic swatch of KNOWN saturation through the same
  // function; if that does not come back, the 0.000 is the instrument and the
  // criterion says nothing.
  const control = m?.chromaControl;
  if (
    !control ||
    !Number.isFinite(control.medianSaturation) ||
    Math.abs(control.medianSaturation - control.expected) > 0.02
  ) {
    structural.push(
      `the chroma detector's positive control returned ` +
        `${control?.medianSaturation ?? "null"} against an expected ` +
        `${control?.expected ?? "?"} — a median chroma of 0 would be the ` +
        "instrument, not the asset",
    );
  }
  if (structural.length > 0) {
    return { criteria: {}, structural, pass: false, measured: {} };
  }

  const dustRatio =
    t3.medianDustLaneIQR > 0
      ? active.medianDustLaneIQR / t3.medianDustLaneIQR
      : NaN;
  const bandRetention =
    unblurred.medianBandStdDev > 0
      ? active.medianBandStdDev / unblurred.medianBandStdDev
      : NaN;

  const criteria = {
    // (1) RATIFIED, both forms.
    asset_arcminPerPixel_le_2_0:
      Number.isFinite(active.arcminPerPixelWorst) &&
      active.arcminPerPixelWorst <= G3_MAX_ARCMIN_PER_PIXEL,
    asset_faceSize_ge_2700:
      Number.isFinite(active.faceSizeMin) &&
      active.faceSizeMin >= G3_MIN_FACE_SIZE_PX,
    // SUPPLEMENTARY, never a substitute for the two above: an "asset UPGRADE"
    // gate must at minimum require the candidate to beat the asset it replaces.
    // This is the predicate the t3 adversarial arm turns on.
    asset_angularSampling_beats_t3:
      Number.isFinite(active.arcminPerPixel) &&
      Number.isFinite(t3.arcminPerPixel) &&
      active.arcminPerPixel < t3.arcminPerPixel,
    // (3) RATIFIED level + the header fact that decides the format question.
    format_chromaSubsampling_is_444:
      active.subsampling === REQUIRED_CHROMA_SUBSAMPLING,
    format_medianChroma_ge_0_20:
      Number.isFinite(active.medianChroma) &&
      active.medianChroma >= G3_MIN_MEDIAN_CHROMA,
    // (4) RATIFIED ratio, plus the retention arm that says the DR-01 low-pass
    // kept the structure it was supposed to keep (SHIPPED bound).
    fidelity_dustLaneIQR_ratio_ge_3:
      Number.isFinite(dustRatio) && dustRatio >= G3_MIN_DUST_LANE_IQR_RATIO,
    fidelity_bandStructure_retained:
      Number.isFinite(bandRetention) &&
      bandRetention >= DR01_LIMITS.diffuseMinBandRatio,
  };
  return {
    criteria,
    structural,
    measured: {
      activeVariant: m.activeVariant ?? null,
      arcminPerPixel: active.arcminPerPixel,
      arcminPerPixelWorst: active.arcminPerPixelWorst,
      faceSizeMin: active.faceSizeMin,
      subsampling: active.subsampling,
      medianChroma: active.medianChroma,
      chromaControl: control.medianSaturation,
      dustLaneIQR: active.medianDustLaneIQR,
      dustLaneIQR_t3Baseline: t3.medianDustLaneIQR,
      dustLaneIQR_ratio: dustRatio,
      bandStructureRetention: bandRetention,
      granularityIQR: active.medianGranularityIQR,
      granularityIQR_unblurred: unblurred.medianGranularityIQR,
    },
    pass: Object.values(criteria).every(Boolean),
  };
}

/**
 * SPLIT sub-lane — the DR-01 seam, on the served faces AND on a live frame.
 *
 * Both halves matter and neither substitutes for the other: the faces prove the
 * shipped BYTES carry no resolved sources, the live frame proves the RENDERER
 * is actually showing those faces (a default flipped back to the un-blurred
 * variant at runtime would leave the bytes innocent). The un-blurred census is
 * the detector's positive control — "0 sources" and "the detector is broken"
 * are the same reading otherwise.
 *
 * @param {{diffuseMaxFaceSources:number,unblurredMinFaceSources:number,
 *          liveResolvedSources:number,liveLitPixels:number}} m
 * @returns {{criteria:Object<string,boolean>,structural:string[],pass:boolean}}
 */
export function evaluateSplitSubLane(m) {
  const structural = [];
  if (!(m?.liveLitPixels > 0)) {
    structural.push(
      `the live cubemap-only frame carried ${m?.liveLitPixels ?? "no"} lit ` +
        "pixels — a black frame censuses zero resolved sources too, so the seam " +
        "assertion would pass vacuously",
    );
  }
  if (structural.length > 0) {
    return { criteria: {}, structural, pass: false };
  }
  const criteria = {
    split_diffuseFaces_resolvedSources_le_2:
      Number.isFinite(m.diffuseMaxFaceSources) &&
      m.diffuseMaxFaceSources <= DR01_LIVE_MAX_RESOLVED_SOURCES,
    split_unblurredFaces_resolvedSources_ge_bound:
      Number.isFinite(m.unblurredMinFaceSources) &&
      m.unblurredMinFaceSources >= DR01_LIMITS.unblurredMinPointSources,
    split_liveCubemapOnly_resolvedSources_le_2:
      Number.isFinite(m.liveResolvedSources) &&
      m.liveResolvedSources <= DR01_LIVE_MAX_RESOLVED_SOURCES,
  };
  return { criteria, structural, pass: Object.values(criteria).every(Boolean) };
}

/**
 * CATALOGUE sub-lane — the supply that DR-01 moved the resolved stars onto.
 *
 * This is where criterion (2)'s intent now lives: with the cube map out of the
 * resolved-source business by ruling, "does the sky deliver resolved stars at
 * all, and to what depth" is a question about `BrightStarCatalog` and
 * `MAG_CUTOFF`. The live arm is what stops it being a claim about a data file:
 * a catalogue of 2,868 rows that draws nothing is not a supply.
 *
 * @param {{records:number,limitingMagnitude:number,liveResolvedSources:number,
 *          liveLitPixels:number}} m
 * @returns {{criteria:Object<string,boolean>,structural:string[],pass:boolean}}
 */
export function evaluateCatalogueSubLane(m) {
  const structural = [];
  if (!Number.isFinite(m?.records) || m.records <= 0) {
    structural.push(
      "the shipped catalogue could not be read from the page — its depth is " +
        "unmeasurable and so is everything downstream of it",
    );
  }
  if (!(m?.liveLitPixels > 0)) {
    structural.push(
      "the live sprites-only frame was blank, so a census of 0 resolved stars " +
        "would be describing an empty capture rather than the catalogue",
    );
  }
  if (structural.length > 0) {
    return { criteria: {}, structural, pass: false };
  }
  const criteria = {
    catalogue_records_ge_shipped: m.records >= CATALOGUE_MIN_RECORDS,
    catalogue_limitingMagnitude_ge_shipped:
      Number.isFinite(m.limitingMagnitude) &&
      m.limitingMagnitude >= CATALOGUE_MIN_LIMITING_MAGNITUDE,
    catalogue_liveResolvedSources_present:
      Number.isFinite(m.liveResolvedSources) && m.liveResolvedSources >= 1,
  };
  return { criteria, structural, pass: Object.values(criteria).every(Boolean) };
}

/**
 * ADVERSARIAL sub-lane — the legacy t3 faces pushed through the SAME metrics.
 *
 * A gate that cannot reject the asset it was written to replace is measuring
 * nothing. This runs the t3 set through the asset arms and REQUIRES it to fail:
 * on the format arm (t3 is 4:2:0, which criterion (3) names as the immediate
 * failure), on the DR-01 split arm (t3's faces carry thousands of resolved
 * sources), and on the upgrade arm (t3 cannot beat itself). If t3 came back
 * clean, the discriminator is void and that is a gate FAILURE, not a t3 pass.
 *
 * @param {{t3:object}} m
 * @returns {{criteria:Object<string,boolean>,structural:string[],pass:boolean,
 *            measured:object}}
 */
export function evaluateAdversarialSubLane(m) {
  const structural = [];
  const t3 = m?.t3;
  if (!t3 || !(t3.faceCount > 0)) {
    structural.push(
      "the t3 negative control was never measured — the discriminator is " +
        "unproven and every fidelity reading above is uncalibrated",
    );
    return { criteria: {}, structural, pass: false, measured: {} };
  }
  const t3Format = t3.subsampling === REQUIRED_CHROMA_SUBSAMPLING;
  const t3Sampling =
    Number.isFinite(t3.arcminPerPixelWorst) &&
    t3.arcminPerPixelWorst <= G3_MAX_ARCMIN_PER_PIXEL;
  const t3Seam =
    Number.isFinite(t3.maxFaceSources) &&
    t3.maxFaceSources <= DR01_LIVE_MAX_RESOLVED_SOURCES;
  const criteria = {
    adversarial_t3_fails_format: t3Format === false,
    adversarial_t3_fails_angularSampling: t3Sampling === false,
    adversarial_t3_fails_dr01Seam: t3Seam === false,
  };
  return {
    criteria,
    structural,
    measured: {
      t3Subsampling: t3.subsampling,
      t3ArcminPerPixel: t3.arcminPerPixel,
      t3MaxFaceSources: t3.maxFaceSources,
      t3SourcesPerSteradian: t3.sourcesPerSteradian,
    },
    pass: Object.values(criteria).every(Boolean),
  };
}

/**
 * MOTION sub-lane — DR-01's reversal triggers, measured.
 *
 * NON-CERTIFYING BY DESIGN for the trigger readings themselves. DR-01 is a
 * ratified decision with a written reversal plan, and its own instruction is to
 * "decide on evidence, not impression". So this lane's job is to produce the
 * evidence in a form a maintainer can rule on; it is not to rule. What IS
 * certifying here is instrument validity — the camera moved, a star was found —
 * and the CROSS-BACKEND agreement of the trigger states, because the sprite
 * path is shared code and a backend-dependent twinkle is a parity defect no
 * matter which way the ruling goes.
 *
 * THE CONTROL IS PEAK-VERSUS-SUM ON THE SAME STAR, NOT A SECOND STAR. Sub-pixel
 * resampling moves energy BETWEEN pixels; it does not create or destroy it. So
 * the box SUM around a star is near phase-invariant while the box PEAK is not,
 * and the gap between the two swings is the signature of sampling. Analytic
 * prediction for the shipped PSF at this lane's framing: peak ratio 3.77x, sum
 * ratio 1.226x. A sweep in which the two swing TOGETHER is modulating the star's
 * total flux — an exposure, extinction or fade term — and says nothing about
 * aliasing, so that is the vacuity this control refuses. A second (bright) star
 * is carried too, but only as a diagnostic: the brightest catalogue star CLIPS
 * on the SDR target, so its peak is pinned at the white point by construction
 * and a "control" built on it would pass for the wrong reason.
 *
 * @param {{changedPixels:number,faintPeakRatio:number,faintSumRatio:number,
 *          brightSumRatio:number,faintFound:boolean,brightFound:boolean,
 *          frames:number}} m
 * @returns {{criteria:Object<string,boolean>,structural:string[],pass:boolean,
 *            triggers:object}}
 */
export function evaluateMotionSubLane(m) {
  const structural = [];
  if (!(m?.changedPixels >= MOTION_MIN_CHANGED_PIXELS)) {
    structural.push(
      `the moving-camera sweep changed ${m?.changedPixels ?? 0} pixels — the ` +
        "camera did not actually move, so no sub-pixel phase was sampled",
    );
  }
  if (m?.faintFound !== true) {
    structural.push(
      "the faint target box never carried a signal above its own local " +
        "background — the twinkle trigger is about faint sprites and there was " +
        "none to measure",
    );
  }
  if (m?.brightFound !== true) {
    structural.push(
      "the bright diagnostic box never carried a signal — the sweep was not " +
        "looking at the star field it thinks it was",
    );
  }
  const basisSamples = m?.basisEvidence?.samples;
  const finiteVector = (v) =>
    Number.isFinite(v?.x) && Number.isFinite(v?.y) && Number.isFinite(v?.z);
  const observedSamples = Array.isArray(basisSamples) ? basisSamples : [];
  const magnitude = (v) => Math.hypot(v.x, v.y, v.z);
  const unitVector = (v) =>
    finiteVector(v) && Math.abs(magnitude(v) - 1.0) <= 1.0e-6;
  const normalized = (v) => {
    const length = magnitude(v);
    return { x: v.x / length, y: v.y / length, z: v.z / length };
  };
  const dot = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;
  const angleBetweenDeg = (left, right) => {
    const a = normalized(left);
    const b = normalized(right);
    const cross = {
      x: a.y * b.z - a.z * b.y,
      y: a.z * b.x - a.x * b.z,
      z: a.x * b.y - a.y * b.x,
    };
    return (Math.atan2(magnitude(cross), dot(a, b)) * 180.0) / Math.PI;
  };
  const close = (a, b, tolerance = 1.0e-10) =>
    Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= tolerance;
  const inRange = (value, low, high) =>
    Number.isFinite(value) && value >= low && value <= high;
  const recomputeBasisSample = (sample) => {
    const vectors = [
      sample?.requestedDirection,
      sample?.requestedRight,
      sample?.requestedUp,
      sample?.appliedDirectionWC,
      sample?.appliedRightWC,
      sample?.appliedUpWC,
    ];
    if (!vectors.every(unitVector)) {
      return null;
    }
    const directionResidualDeg = angleBetweenDeg(
      sample.requestedDirection,
      sample.appliedDirectionWC,
    );
    const rightResidualDeg = angleBetweenDeg(
      sample.requestedRight,
      sample.appliedRightWC,
    );
    const upResidualDeg = angleBetweenDeg(
      sample.requestedUp,
      sample.appliedUpWC,
    );
    const appliedDirection = normalized(sample.appliedDirectionWC);
    const appliedRight = normalized(sample.appliedRightWC);
    const appliedUp = normalized(sample.appliedUpWC);
    const appliedMaxAbsDot = Math.max(
      Math.abs(dot(appliedDirection, appliedRight)),
      Math.abs(dot(appliedDirection, appliedUp)),
      Math.abs(dot(appliedRight, appliedUp)),
    );
    if (
      !inRange(sample.directionResidualDeg, 0, 180) ||
      !inRange(sample.rightResidualDeg, 0, 180) ||
      !inRange(sample.upResidualDeg, 0, 180) ||
      !inRange(sample.appliedMaxAbsDot, 0, 1) ||
      !close(sample.directionResidualDeg, directionResidualDeg) ||
      !close(sample.rightResidualDeg, rightResidualDeg) ||
      !close(sample.upResidualDeg, upResidualDeg) ||
      !close(sample.appliedMaxAbsDot, appliedMaxAbsDot) ||
      appliedMaxAbsDot > 1.0e-6 ||
      sample.brightProjectionBasis !== "applied-WC" ||
      sample.faintProjectionBasis !== "applied-WC"
    ) {
      return null;
    }
    return {
      directionResidualDeg,
      rightResidualDeg,
      upResidualDeg,
      appliedMaxAbsDot,
    };
  };
  const recomputedSamples = observedSamples.map(recomputeBasisSample);
  const maxRecomputed = (key) =>
    recomputedSamples.length > 0 && recomputedSamples.every(Boolean)
      ? Math.max(...recomputedSamples.map((sample) => sample[key]))
      : NaN;
  const recomputedMaxima = {
    direction: maxRecomputed("directionResidualDeg"),
    right: maxRecomputed("rightResidualDeg"),
    up: maxRecomputed("upResidualDeg"),
  };
  const recomputedMaxAppliedAbsDot = maxRecomputed("appliedMaxAbsDot");
  const reportedMax = m?.basisEvidence?.maxRequestedAppliedResidualDeg;
  const summaryConsistent =
    close(reportedMax?.direction, recomputedMaxima.direction) &&
    close(reportedMax?.right, recomputedMaxima.right) &&
    close(reportedMax?.up, recomputedMaxima.up) &&
    close(m?.basisEvidence?.maxAppliedAbsDot, recomputedMaxAppliedAbsDot);
  if (
    m?.basisEvidence?.coordinateSpace !== "WC" ||
    m?.basisEvidence?.projectionBasis !== "post-Camera.setView" ||
    !Array.isArray(basisSamples) ||
    basisSamples.length !== m?.frames ||
    !recomputedSamples.every(Boolean) ||
    !summaryConsistent
  ) {
    structural.push(
      "the motion boxes were not backed by complete finite unit requested/" +
        "applied direction/up/right bases, independently recomputed angular " +
        "finite residuals, an orthogonal applied basis, applied-WC bindings " +
        "for both targets, and exact recomputed, consistent maxima on every frame",
    );
  }
  if (structural.length > 0) {
    return {
      criteria: {},
      structural,
      pass: false,
      triggers: {},
      measured: {},
    };
  }
  const triggers = {
    [REVERSAL_TRIGGER.ALIAS_TWINKLE]: {
      measured: m.faintPeakRatio,
      bound: TWINKLE_TRIGGER_PEAK_RATIO,
      boundKind: "FIRST-PASS DERIVED (0.2 mag, Pogson)",
      triggered: m.faintPeakRatio >= TWINKLE_TRIGGER_PEAK_RATIO,
      magnitudes: Number.isFinite(m.faintPeakRatio)
        ? 2.5 * Math.log10(m.faintPeakRatio)
        : NaN,
      control: {
        faintSumRatio: m.faintSumRatio,
        brightSumRatio: m.brightSumRatio,
        isolatesSubPixelPhase: m.faintPeakRatio > m.faintSumRatio,
      },
    },
  };
  const criteria = {
    // Certifying: if the box SUM swings as hard as the box PEAK, the sweep is
    // measuring something global and the trigger reading is not about
    // sub-pixel sampling at all.
    motion_control_isolatesSubPixelPhase:
      Number.isFinite(m.faintPeakRatio) &&
      Number.isFinite(m.faintSumRatio) &&
      m.faintPeakRatio > m.faintSumRatio,
  };
  return {
    criteria,
    structural,
    triggers,
    measured: {
      basisSampleCount: basisSamples.length,
      coordinateSpace: m.basisEvidence.coordinateSpace,
      projectionBasis: m.basisEvidence.projectionBasis,
      maxRequestedAppliedResidualDeg: recomputedMaxima,
      maxAppliedAbsDot: recomputedMaxAppliedAbsDot,
      firstBasis: basisSamples[0] ?? null,
      lastBasis: basisSamples[basisSamples.length - 1] ?? null,
    },
    pass: Object.values(criteria).every(Boolean),
  };
}

/**
 * Evaluate one backend's whole G3 lane.
 *
 * @param {object} backend
 * @returns {object}
 */
export function evaluateG3Backend(backend) {
  const assetSource = evaluateAssetSourceSubLane(backend.asset?.sourceProof);
  if (!assetSource.pass) {
    // SOURCE ELIGIBILITY PRECEDES PRODUCT VERDICT. Suppress product criteria
    // only when the exact active subject or its provenance/lifecycle proof is
    // absent or malformed. Resolution below the ratified bar is deliberately
    // not handled here: an exact 2048 subject passes this source arm and then
    // produces ordinary angular-sampling FAIL entries below.
    return {
      renderer: backend.renderer,
      subLanes: { assetSource },
      assetFingerprint: null,
      triggers: {},
      criteria: {},
      structural: assetSource.structural.map((s) => `assetSource: ${s}`),
      pass: false,
    };
  }
  const asset = evaluateAssetSubLane(backend.asset);
  const split = evaluateSplitSubLane(backend.split);
  const catalogue = evaluateCatalogueSubLane(backend.catalogue);
  const adversarial = evaluateAdversarialSubLane(backend.adversarial);
  const motion = evaluateMotionSubLane(backend.motion);
  const assetFingerprint = backend.asset?.fingerprint ?? null;
  const fingerprintStructural = [];
  if (
    !/^[0-9a-f]{64}$/u.test(assetFingerprint ?? "") ||
    assetFingerprint !== assetSource.measured.recomputedFingerprintSha256
  ) {
    fingerprintStructural.push(
      "assetFingerprint: the producer aggregate is absent, malformed, or " +
        "does not match the evaluator's independently recomputed active " +
        "source fingerprint",
    );
  }
  const criteria = {
    ...assetSource.criteria,
    ...asset.criteria,
    ...split.criteria,
    ...catalogue.criteria,
    ...adversarial.criteria,
    ...motion.criteria,
  };
  const structural = [
    ...assetSource.structural.map((s) => `assetSource: ${s}`),
    ...asset.structural.map((s) => `asset: ${s}`),
    ...split.structural.map((s) => `split: ${s}`),
    ...catalogue.structural.map((s) => `catalogue: ${s}`),
    ...adversarial.structural.map((s) => `adversarial: ${s}`),
    ...motion.structural.map((s) => `motion: ${s}`),
    ...fingerprintStructural,
  ];
  return {
    renderer: backend.renderer,
    subLanes: { assetSource, asset, split, catalogue, adversarial, motion },
    // Retain the producer's value for cross-backend reporting only after the
    // structural arm above has compared it with the independent recomputation.
    assetFingerprint,
    triggers: {
      ...(backend.triggers ?? {}),
      ...(motion.triggers ?? {}),
    },
    criteria,
    structural,
    // Explicit: an empty criteria set (every sub-lane structural) must NOT read
    // as a clean sheet.
    pass:
      structural.length === 0 &&
      Object.keys(criteria).length > 0 &&
      Object.values(criteria).every(Boolean),
  };
}

/**
 * Compute the two asset-side reversal triggers that need no rendering.
 *
 * @param {{active:object,unblurred:object,t3:object,catalogueRecords:number}} m
 * @returns {object}
 */
export function computeAssetTriggers(m) {
  const active = m?.active;
  const unblurred = m?.unblurred;
  const t3 = m?.t3;
  // Null-safe on BOTH operands. A trigger block is printed even when a sub-lane
  // went structural, so this runs on inputs the asset sub-lane already refused;
  // a NaN reading there must not become a thrown probe.
  const retention =
    active && unblurred?.medianBandStdDev > 0
      ? active.medianBandStdDev / unblurred.medianBandStdDev
      : NaN;
  const deliveredPerSr =
    Number.isFinite(m?.catalogueRecords) && m.catalogueRecords >= 0
      ? m.catalogueRecords / STERADIANS_FULL_SKY
      : NaN;
  const densityRatio =
    t3?.sourcesPerSteradian > 0 ? deliveredPerSr / t3.sourcesPerSteradian : NaN;
  return {
    [REVERSAL_TRIGGER.SMEARED_MILKY_WAY]: {
      measured: retention,
      bound: DR01_LIMITS.diffuseMinBandRatio,
      boundKind: "SHIPPED (DR01_LIMITS.diffuseMinBandRatio)",
      // The trigger fires when the low-pass took the STRUCTURE with it, not
      // merely when it took the grain — removing the grain is the seam working.
      triggered: !(retention >= DR01_LIMITS.diffuseMinBandRatio),
      granularityRatio:
        active && unblurred?.medianGranularityIQR > 0
          ? active.medianGranularityIQR / unblurred.medianGranularityIQR
          : NaN,
    },
    [REVERSAL_TRIGGER.SPRITE_DENSITY]: {
      measured: densityRatio,
      bound: G3_MIN_SOURCE_DENSITY_RATIO,
      boundKind: "RATIFIED criterion (2), superseded as certifying by DR-01",
      triggered: !(densityRatio >= G3_MIN_SOURCE_DENSITY_RATIO),
      deliveredSourcesPerSteradian: deliveredPerSr,
      t3SourcesPerSteradian: t3?.sourcesPerSteradian ?? null,
    },
  };
}

/**
 * Fold the two backends into one G3 verdict.
 *
 * PRECEDENCE, identical to G1's and G2's: a criterion failure on a backend that
 * COULD see its subject outranks a structural leg, and a structural leg
 * outranks a clean sheet. A backend that passes while the other fails is a FAIL
 * for the gate.
 *
 * TWO CROSS-BACKEND ARMS. The cube faces are backend-neutral bytes, so the
 * ASSET fingerprint must match exactly — a difference there means the two
 * backends resolved different sources or were served different bytes, which no
 * per-backend criterion would catch. The TRIGGER STATES must also match,
 * because the sprite path is shared code (`StarField.wgsl` and
 * `StarFieldFS.glsl` are character-identical): a twinkle that appears on one
 * backend only is a parity defect regardless of how DR-01 is eventually ruled.
 *
 * @param {{webgl:object,webgpu:object}} evaluated
 * @returns {{verdict:string,exitCode:number,failures:string[],structural:string[]}}
 */
export function foldG3Verdict(evaluated) {
  const failures = [];
  const structural = [];
  const requiredTriggerKeys = Object.values(REVERSAL_TRIGGER);
  const validFingerprint = (value) => /^[0-9a-f]{64}$/u.test(value ?? "");
  const sourceValid = (backend) =>
    backend?.subLanes?.assetSource?.pass === true;
  const fingerprintProofValid = (backend) => {
    const fingerprint = backend?.assetFingerprint;
    const measured = backend?.subLanes?.assetSource?.measured;
    const retainedRecomputation = measured?.recomputedFingerprintSha256;
    const independentlyRecomputed = computeG3ActiveSourceFingerprint(
      activeSourceFingerprintInputFromProof(measured),
    );
    return (
      sourceValid(backend) &&
      validFingerprint(fingerprint) &&
      validFingerprint(measured?.fingerprintSha256) &&
      validFingerprint(retainedRecomputation) &&
      fingerprint === independentlyRecomputed &&
      measured.fingerprintSha256 === independentlyRecomputed &&
      retainedRecomputation === independentlyRecomputed
    );
  };
  const validTriggerState = (backend, key) =>
    typeof backend?.triggers?.[key]?.triggered === "boolean";

  for (const renderer of ["webgl", "webgpu"]) {
    const b = evaluated?.[renderer];
    if (!b) {
      structural.push(
        `${renderer} — lane absent; G3 cannot certify the shipped asset`,
      );
      continue;
    }
    for (const [name, ok] of Object.entries(b.criteria)) {
      if (!ok) {
        failures.push(`${renderer}:${name}`);
      }
    }
    for (const note of b.structural) {
      structural.push(`${renderer}:${note}`);
    }
    if (b.structural.length === 0 && Object.keys(b.criteria).length === 0) {
      structural.push(
        `${renderer} — no criterion was evaluated at all; an empty criteria set ` +
          "is not a pass",
      );
    }
    if (sourceValid(b)) {
      if (!fingerprintProofValid(b)) {
        structural.push(
          `${renderer}:asset fingerprint is missing, malformed, or does not ` +
            "match that backend's independently recomputed source proof",
        );
      }
      const observedTriggerKeys = Object.keys(b.triggers ?? {});
      const exactTriggerSet =
        observedTriggerKeys.length === requiredTriggerKeys.length &&
        requiredTriggerKeys.every(
          (key) =>
            observedTriggerKeys.includes(key) && validTriggerState(b, key),
        );
      if (!exactTriggerSet) {
        structural.push(
          `${renderer}:required reversal-trigger states are missing, malformed, ` +
            "or contain unexpected records",
        );
      }
    }
  }

  const gl = evaluated?.webgl;
  const gpu = evaluated?.webgpu;
  if (sourceValid(gl) && sourceValid(gpu)) {
    if (
      fingerprintProofValid(gl) &&
      fingerprintProofValid(gpu) &&
      gl.assetFingerprint !== gpu.assetFingerprint
    ) {
      failures.push(
        `cross-backend:asset_fingerprint_identical (webgl ${gl.assetFingerprint}, ` +
          `webgpu ${gpu.assetFingerprint})`,
      );
    }
    for (const key of Object.values(REVERSAL_TRIGGER)) {
      const a = gl.triggers?.[key];
      const b = gpu.triggers?.[key];
      if (!validTriggerState(gl, key) || !validTriggerState(gpu, key)) {
        continue;
      }
      if (a.triggered !== b.triggered) {
        failures.push(
          `cross-backend:reversalTrigger_${key}_agrees (webgl ${a.triggered}, ` +
            `webgpu ${b.triggered}) — the sprite path is shared code`,
        );
      }
    }
  }

  let verdict = "PASS";
  let exitCode = EXIT_CODE.PASS;
  if (failures.length > 0) {
    verdict = "FAIL";
    exitCode = EXIT_CODE.FAIL;
  } else if (structural.length > 0) {
    verdict = "STRUCTURAL";
    exitCode = EXIT_CODE.STRUCTURAL;
  }
  return { verdict, exitCode, failures, structural };
}

/**
 * Build the printed G3 summary. Every bound travels WITH the number it bounds,
 * and every bound says whether it is RATIFIED, SHIPPED or DERIVED, so a red gate
 * can be triaged without opening this file.
 *
 * @param {object} result
 * @returns {object}
 */
export function buildG3Summary(result) {
  const backend = (b) =>
    b
      ? {
          criteria: b.criteria,
          structural: b.structural,
          assetSource: b.subLanes?.assetSource?.measured ?? null,
          asset: b.subLanes?.asset?.measured ?? null,
          adversarial: b.subLanes?.adversarial?.measured ?? null,
          motion: b.subLanes?.motion?.measured ?? null,
          triggers: b.triggers ?? null,
        }
      : null;
  return {
    gate: "G3",
    verdict: result.verdict,
    exitCode: result.exitCode,
    bounds: {
      RATIFIED: {
        G3_MAX_ARCMIN_PER_PIXEL,
        G3_MIN_FACE_SIZE_PX,
        G3_MIN_MEDIAN_CHROMA,
        G3_MIN_DUST_LANE_IQR_RATIO,
        G3_MIN_SOURCE_DENSITY_RATIO,
      },
      SHIPPED: {
        REQUIRED_CHROMA_SUBSAMPLING,
        CATALOGUE_MIN_RECORDS,
        CATALOGUE_MIN_LIMITING_MAGNITUDE,
        DR01_LIVE_MAX_RESOLVED_SOURCES,
        diffuseMinBandRatio: DR01_LIMITS.diffuseMinBandRatio,
        unblurredMinPointSources: DR01_LIMITS.unblurredMinPointSources,
      },
      DERIVED: {
        DUST_LANE_SIGMA_DEG,
        DUST_LANE_MARGIN_FRACTION,
        CHROMA_BAND_PERCENTILE,
        TWINKLE_TRIGGER_PEAK_RATIO,
        MOTION_MIN_CHANGED_PIXELS,
      },
      OPTIONAL_UPGRADE: {
        resolution: G3_PREFERRED_UPGRADE_RESOLUTION,
        faceSize: G3_PREFERRED_UPGRADE_FACE_SIZE_PX,
        estimatedVramBytes: G3_PREFERRED_UPGRADE_VRAM_BYTES,
        certifyingPrerequisite: false,
      },
    },
    failures: result.failures,
    structural: result.structural,
    backends: {
      webgl: backend(result.backends?.webgl),
      webgpu: backend(result.backends?.webgpu),
    },
  };
}

export { DR01_LIMITS };

export default {
  CUBE_FACE_SPAN_DEG,
  STERADIANS_PER_FACE,
  STERADIANS_FULL_SKY,
  DUST_LANE_SIGMA_DEG,
  DUST_LANE_MARGIN_FRACTION,
  CHROMA_BAND_PERCENTILE,
  REQUIRED_CHROMA_SUBSAMPLING,
  G3_MAX_ARCMIN_PER_PIXEL,
  G3_MIN_FACE_SIZE_PX,
  G3_CERTIFICATION_VARIANT,
  G3_PREFERRED_UPGRADE_RESOLUTION,
  G3_PREFERRED_UPGRADE_FACE_SIZE_PX,
  G3_CUBE_FACE_COUNT,
  G3_EXPECTED_DEFAULT_RESOLUTION,
  G3_EXPECTED_DEFAULT_FACE_SIZE_PX,
  G3_PREFERRED_UPGRADE_VRAM_BYTES,
  G3_CUBE_FACE_KEYS,
  G3_CUBE_SOURCE_KEYS,
  G3_ACTIVE_SOURCE_FINGERPRINT_SCHEMA,
  G3_MIN_MEDIAN_CHROMA,
  G3_MIN_DUST_LANE_IQR_RATIO,
  G3_MIN_SOURCE_DENSITY_RATIO,
  CATALOGUE_MIN_RECORDS,
  CATALOGUE_MIN_LIMITING_MAGNITUDE,
  DR01_LIVE_MAX_RESOLVED_SOURCES,
  TWINKLE_TRIGGER_PEAK_RATIO,
  MOTION_MIN_CHANGED_PIXELS,
  REVERSAL_TRIGGER,
  BUNDLED_ASSET_DERIVATION,
  EXIT_CODE,
  replaceOwnedResourceTransaction,
  canonicalG3ActiveSourceFingerprintPayload,
  computeG3ActiveSourceFingerprint,
  arcminPerPixel,
  degreesPerPixel,
  luminanceStrided,
  boxWidthForSigma,
  boxBlurPass,
  lowPass,
  dustLaneStructure,
  granularityIQR,
  bandChroma,
  jpegChromaSubsampling,
  analyzeFace,
  foldVariant,
  evaluateG3SourcePreflight,
  evaluateAssetSourceSubLane,
  evaluateAssetSubLane,
  evaluateSplitSubLane,
  evaluateCatalogueSubLane,
  evaluateAdversarialSubLane,
  evaluateMotionSubLane,
  evaluateG3Backend,
  computeAssetTriggers,
  foldG3Verdict,
  buildG3Summary,
};
