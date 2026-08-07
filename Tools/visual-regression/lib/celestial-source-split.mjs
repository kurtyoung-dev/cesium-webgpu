// celestial-source-split.mjs — POST-DR-01 metrics for G1 Lane A's three
// source-split modes (`PROBE-CELESTIAL-GATES-PRE-DR01-STAR-THRESHOLDS`).
//
// WHY THIS FILE EXISTS
// --------------------
// Batch 833 (C12-11 / DR-01) made `SkyBox.defaultVariant = TYCHO_T5_DIFFUSE`.
// Every face of that bake censuses **0 resolved point sources BY CONSTRUCTION**
// (shipped peak luminance 8-28 against the detector's 40 floor); resolved stars
// are the sprite catalogue's job now. G1 Lane A's M1 baseline ("55 sources",
// filed Batch 745) was calibrated against the UN-blurred map, so all three of
// its modes census 0/0 at HEAD and the lane correctly reports STRUCTURAL. The
// instrument is not wrong — the scene changed under it.
//
// Batch 848 already performed exactly this re-scope for
// `probe-stars-catalog.mjs`: "counting pixels against a pre-DR-01 floor
// measures the REMOVED CUBEMAP, not the catalogue." Its rule, followed here:
//
//   * The census floor is NOT lowered. Lowering it would put candidates back
//     inside the diffuse band's own 8-bit range and re-create the brightness
//     count the census replaced. `m1PointSourceCensus`'s 12/255-in-linear
//     threshold is used unchanged.
//   * The claim moves from a COUNT to something the instrument can still see:
//     for the cube map, the DR-01 seam itself (zero resolved sources) becomes
//     the assertion rather than the blindness; for the sprites, lit-pixel
//     extent, cross-backend pixel agreement and chroma over the brightest
//     sprite pixels replace the count ratio.
//   * Every zero reading gets a POSITIVE CONTROL, because "no resolved sources"
//     is also what a black frame says. A seam assertion without a not-blank
//     control is a false green waiting to happen.
//
// Every bound here is either exactly zero (an existence claim) or derived from
// 8-bit quantization. Nothing is fitted to a measurement.
//
// Pure functions over RGBA buffers — no browser, no Playwright, no engine
// imports — so `celestial-g2-gate.spec.mjs` can exercise them under
// `node --test` with synthetic ground truth.

import {
  computeLinearLuminance,
  srgbToLinear,
  percentile,
  rgbToHsv,
} from "./celestial-metrics.mjs";

/**
 * One 8-bit sRGB code value expressed in linear light. The same quantity
 * `celestial-g1-gate.mjs` bounds M2e by, reused here so every "agree to within
 * the instrument's own resolution" claim in the celestial fleet cites one
 * number.
 *
 * @type {number} ~3.035e-4
 */
export const ONE_CODE_LINEAR = srgbToLinear(1 / 255);

/**
 * Live-frame tolerance for the DR-01 seam assertion, in resolved sources.
 *
 * Matched to `probe-stars-catalog.mjs`'s check (G) (`offPoints <= 2`), which
 * absorbs JPEG ringing and 8-bit dither in the diffuse band. It is a tolerance
 * on a quantity whose contract value is 0 (`DR01_LIMITS.diffuseMaxPointSources`
 * in `Tools/skybox-bake/starmap-census.mjs`), and the measured margin is large:
 * the shipped diffuse faces peak at 8-28 code values while `m1PointSourceCensus`
 * needs a local rise of 12/255 in LINEAR light, i.e. code ~61.
 *
 * @type {number}
 */
export const DR01_LIVE_MAX_RESOLVED_SOURCES = 2;

/**
 * How many of the brightest pixels the sprites-only chroma sample uses.
 *
 * NOT a brightness threshold on a census — the `sprites-only` mode turns the
 * cube map OFF, so every non-black pixel in that frame is sprite output by
 * construction and there is nothing for a diffuse band to contaminate. Taking
 * the brightest K is a way of sampling star CORES rather than antialiased quad
 * edges; K is large enough to span many stars (the field carries hundreds of
 * lit pixels) and small enough to stay inside the cores.
 *
 * @type {number}
 */
export const CHROMA_TOP_K = 200;

/**
 * @param {ArrayLike<number>} data RGBA
 * @param {number} i byte offset of the pixel
 * @returns {number} the largest 8-bit channel value
 */
function maxChannel(data, i) {
  return Math.max(data[i], Math.max(data[i + 1], data[i + 2]));
}

/**
 * M7 — LIT EXTENT AND PEAK.
 *
 * `litPixels` counts pixels with ANY channel at or above one 8-bit code value,
 * i.e. pixels that are not exactly black. The bound is zero-fitted: it is the
 * smallest signal the capture can represent, not a level chosen to make a
 * reading come out. It is what replaces the M1 count as the "did this source
 * draw anything, and did both backends draw the same amount" instrument, which
 * the census can no longer answer for sprites at their shipped exposure.
 *
 * `peakLuminance` is the largest linear-light Rec.709 luminance in the frame —
 * the quantity that says whether a diffuse cube map is present at all.
 *
 * @param {{data:ArrayLike<number>,width:number,height:number}} image
 * @param {{alreadyLinear?:boolean}} [options]
 * @returns {{litPixels:number,litFraction:number,peakLuminance:number,
 *            meanLuminance:number,totalLuminance:number,pixels:number}}
 */
export function m7LitExtent(image, options = {}) {
  const { data, width, height } = image;
  const lum = computeLinearLuminance(image, options);
  const pixels = width * height;
  let litPixels = 0;
  let peakLuminance = 0;
  let totalLuminance = 0;
  for (let p = 0, i = 0; p < pixels; p++, i += 4) {
    if (maxChannel(data, i) >= 1) {
      litPixels++;
    }
    const l = lum[p];
    totalLuminance += l;
    if (l > peakLuminance) {
      peakLuminance = l;
    }
  }
  return {
    litPixels,
    litFraction: pixels > 0 ? litPixels / pixels : 0,
    peakLuminance,
    meanLuminance: pixels > 0 ? totalLuminance / pixels : 0,
    totalLuminance,
    pixels,
  };
}

/**
 * M8 — CROSS-BACKEND PIXEL AGREEMENT.
 *
 * The sprites-only frames were measured BIT-IDENTICAL across backends at
 * Batch 873 (the two committed PNGs share a SHA-256). That is the strongest
 * parity statement available for a shared-code pass, and it is measurable
 * without resolving a single star — which is exactly what the post-DR-01 census
 * cannot do.
 *
 * Returns the exact identity (`differingPixels === 0`) alongside bounded
 * summaries, so a gate can assert the bounded form while the report still says
 * whether the frames were bit-identical.
 *
 * @param {{data:ArrayLike<number>,width:number,height:number}} a
 * @param {{data:ArrayLike<number>,width:number,height:number}} b
 * @returns {{differingPixels:number,differingFraction:number,
 *            maxChannelDelta:number,brightenedPixels:number,
 *            dimmedPixels:number,bitIdentical:boolean,pixels:number}}
 */
export function m8PixelAgreement(a, b) {
  const pixels = Math.min(a.width * a.height, b.width * b.height);
  let differingPixels = 0;
  let maxChannelDelta = 0;
  let brightenedPixels = 0;
  let dimmedPixels = 0;
  for (let p = 0, i = 0; p < pixels; p++, i += 4) {
    let differs = false;
    let up = false;
    let down = false;
    for (let c = 0; c < 3; c++) {
      const d = b.data[i + c] - a.data[i + c];
      if (d !== 0) {
        differs = true;
        if (d > 0) {
          up = true;
        } else {
          down = true;
        }
        const ad = d < 0 ? -d : d;
        if (ad > maxChannelDelta) {
          maxChannelDelta = ad;
        }
      }
    }
    if (differs) {
      differingPixels++;
    }
    if (up) {
      brightenedPixels++;
    }
    if (down) {
      dimmedPixels++;
    }
  }
  return {
    differingPixels,
    differingFraction: pixels > 0 ? differingPixels / pixels : 0,
    maxChannelDelta,
    brightenedPixels,
    dimmedPixels,
    bitIdentical: differingPixels === 0,
    pixels,
  };
}

/**
 * M3-TOPK — chroma over the brightest pixels rather than over M1 detections.
 *
 * The shipped M3 samples HSV saturation at the positions `m1PointSourceCensus`
 * returned. Post-DR-01 that set is empty on every Lane-A mode, so the criterion
 * it feeds is dead. Re-pointed here at the brightest `k` pixels of the
 * SPRITES-ONLY frame, where the cube map is switched off and every non-black
 * pixel is therefore sprite output — the star colours the fork computes from
 * B-V, which is the property "a monochrome field is a defect" is about.
 *
 * `sampleCount` is reported so a caller can route an unmeasurable chroma to
 * STRUCTURAL instead of scoring 0/0 as a defect.
 *
 * @param {{data:ArrayLike<number>,width:number,height:number}} image
 * @param {{k?:number}} [options]
 * @returns {{medianSaturation:number,hueIQR:number,sampleCount:number}}
 */
export function m3ChromaTopK(image, options = {}) {
  const { data, width, height } = image;
  const k = options.k ?? CHROMA_TOP_K;
  const pixels = width * height;
  /** @type {{i:number,v:number}[]} */
  const lit = [];
  for (let p = 0, i = 0; p < pixels; p++, i += 4) {
    const v = maxChannel(data, i);
    if (v >= 1) {
      lit.push({ i, v });
    }
  }
  if (lit.length === 0) {
    return { medianSaturation: 0, hueIQR: 0, sampleCount: 0 };
  }
  lit.sort((p, q) => q.v - p.v);
  const take = lit.slice(0, Math.min(k, lit.length));
  const sats = [];
  const hues = [];
  for (const { i } of take) {
    const hsv = rgbToHsv(data[i], data[i + 1], data[i + 2]);
    sats.push(hsv.s);
    hues.push(hsv.h);
  }
  const satSorted = sats.slice().sort((p, q) => p - q);
  const hueSorted = hues.slice().sort((p, q) => p - q);
  return {
    medianSaturation: percentile(satSorted, 0.5),
    hueIQR: percentile(hueSorted, 0.75) - percentile(hueSorted, 0.25),
    sampleCount: take.length,
  };
}

export default {
  ONE_CODE_LINEAR,
  DR01_LIVE_MAX_RESOLVED_SOURCES,
  CHROMA_TOP_K,
  m7LitExtent,
  m8PixelAgreement,
  m3ChromaTopK,
};
