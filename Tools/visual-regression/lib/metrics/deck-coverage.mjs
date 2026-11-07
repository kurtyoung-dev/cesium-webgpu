// deck-coverage.mjs - how much of a frame a cloud deck covers, and the pre-registered rule that compares a populations-on frame to its populations-off twin.
// @purpose Pure metric over decoded RGBA for the E-WX-populations cell: the covered-pixel count and share (a pixel is covered when its Rec. 601 luma exceeds 8 on 0..255) and the mean luma over the covered pixels, and the pre-registered populations verdict over two such readings (UNMEASURED when the single-layer frame covers under 1 % of the frame; FAIL when the populations frame covers under 25 % of the single-layer frame's covered pixels or its mean covered luma is under 25 % of the single-layer frame's; otherwise PASS).
// @status ACTIVE
//
// THE RULE IS PRE-REGISTERED, and these constants ARE the rule (the cell table
// and the rig header quote them):
//   covered pixel      Rec. 601 luma > COVERED_LUMA_ABOVE (8), luma on 0..255
//   UNMEASURED         single-layer covered share < UNMEASURED_BELOW_FRACTION (1 %)
//   FAIL               populations covered count < MIN_COVERED_RATIO (25 %) of the
//                      single-layer covered count, OR populations mean covered
//                      luma < MIN_MEAN_LUMA_RATIO (25 %) of the single-layer one
//   PASS               otherwise
// The comparisons are strict: a value exactly on a limit does not cross it.
//
// WHAT IT CERTIFIES, AND WHAT IT DOES NOT. The frame holds no ground, no sky
// box, no atmosphere and no sun (the rig hides them over a black background and
// looks above the horizon), so every non-black pixel is cloud. The rule asks
// whether the population march PUBLISHED the colour it marched: a populations
// page that marches decks but writes none of their colour covers (almost) no
// pixels and reads black, which is the failure the rule exists to catch. It is
// not a parity or an appearance measure; two populations frames that cover half
// the single-layer frame's pixels at full brightness pass.
//
// THE FLOORS ARE THE SECOND CONDITION. This rule reads pixels only, so two
// identical frames pass it whether or not the population march ran. The cell's
// first condition is the engine's own request flag (`lib/cloud-engagement-read.mjs`),
// which `lib/metrics/landing-cross-page.mjs` judges beside this rule: the flag
// true on the populations page and false on the single-layer page.
//
// REC. 601, NOT REC. 709. The luma is `rec601Luma` of `lib/metrics/luma-regions.mjs`
// (0.299 / 0.587 / 0.114), the kit's luma for cloud-deck shares; the alpha
// channel is not read.

import { rec601Luma } from "./luma-regions.mjs";

/** A pixel is covered when its Rec. 601 luma (0..255) exceeds this. */
export const COVERED_LUMA_ABOVE = 8;

/** The single-layer frame must cover at least this share of the frame to be measured. */
export const UNMEASURED_BELOW_FRACTION = 0.01;

/** The populations frame must keep at least this share of the single-layer covered pixels. */
export const MIN_COVERED_RATIO = 0.25;

/** The populations frame must keep at least this share of the single-layer mean covered luma. */
export const MIN_MEAN_LUMA_RATIO = 0.25;

const requireFrame = (frame, what) => {
  if (
    !frame ||
    !Number.isInteger(frame.width) ||
    !Number.isInteger(frame.height) ||
    frame.width <= 0 ||
    frame.height <= 0 ||
    !frame.data ||
    frame.data.length < frame.width * frame.height * 4
  ) {
    throw new TypeError(
      `${what}: needs a decoded RGBA frame {width, height, data}`,
    );
  }
};

/**
 * The covered pixels of one decoded frame.
 *
 * @param {{width: number, height: number, data: ArrayLike<number>}} frame
 * @param {{lumaAbove?: number}} [options] `lumaAbove` defaults to
 *   {@link COVERED_LUMA_ABOVE}.
 * @returns {{covered: number, total: number, fraction: number,
 *   meanLuma: number|null}} `fraction` is covered / total; `meanLuma` is the
 *   mean Rec. 601 luma over the covered pixels, `null` when none is covered
 *   (a mean of nothing is not zero).
 * @throws {TypeError} For a frame that is not decoded RGBA.
 */
export function deckCoverage(frame, { lumaAbove = COVERED_LUMA_ABOVE } = {}) {
  requireFrame(frame, "deckCoverage");
  const { data, width, height } = frame;
  const total = width * height;
  let covered = 0;
  let lumaSum = 0;
  for (let i = 0; i < total * 4; i += 4) {
    const luma = rec601Luma(data[i], data[i + 1], data[i + 2]);
    if (luma > lumaAbove) {
      covered++;
      lumaSum += luma;
    }
  }
  return {
    covered,
    total,
    fraction: covered / total,
    meanLuma: covered === 0 ? null : lumaSum / covered,
  };
}

/**
 * The populations verdict over two coverage readings. Pure.
 *
 * @param {ReturnType<typeof deckCoverage>} single The populations-off frame.
 * @param {ReturnType<typeof deckCoverage>} populations The populations-on frame.
 * @returns {{outcome: "PASS"|"FAIL"|"UNMEASURED", reasons: string[],
 *   coveredRatio: number|null, meanLumaRatio: number|null}} `UNMEASURED`
 *   carries no standing to pass or fail: the single-layer frame covers under
 *   1 % of the frame, or the two frames differ in size.
 */
export function populationsCoverageVerdict(single, populations) {
  const measured = {
    coveredRatio: null,
    meanLumaRatio: null,
  };
  if (single.total !== populations.total) {
    return {
      outcome: "UNMEASURED",
      reasons: [
        `the frames differ in size (${single.total} px against ${populations.total} px)`,
      ],
      ...measured,
    };
  }
  if (single.fraction < UNMEASURED_BELOW_FRACTION) {
    return {
      outcome: "UNMEASURED",
      reasons: [
        `the single-layer frame covers ${(single.fraction * 100).toFixed(3)} % of the frame, under the ${UNMEASURED_BELOW_FRACTION * 100} % a deck must cover to be measured`,
      ],
      ...measured,
    };
  }
  const coveredRatio = populations.covered / single.covered;
  const meanLumaRatio = (populations.meanLuma ?? 0) / single.meanLuma;
  const reasons = [];
  if (coveredRatio < MIN_COVERED_RATIO) {
    reasons.push(
      `the populations frame covers ${populations.covered} px, ${(coveredRatio * 100).toFixed(2)} % of the single-layer frame's ${single.covered} px (limit ${MIN_COVERED_RATIO * 100} %)`,
    );
  }
  if (meanLumaRatio < MIN_MEAN_LUMA_RATIO) {
    reasons.push(
      `the populations frame's mean covered luma ${(populations.meanLuma ?? 0).toFixed(2)} is ${(meanLumaRatio * 100).toFixed(2)} % of the single-layer frame's ${single.meanLuma.toFixed(2)} (limit ${MIN_MEAN_LUMA_RATIO * 100} %)`,
    );
  }
  return {
    outcome: reasons.length > 0 ? "FAIL" : "PASS",
    reasons,
    coveredRatio,
    meanLumaRatio,
  };
}
