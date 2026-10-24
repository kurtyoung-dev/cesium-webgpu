/**
 * The pixel band of a landing cell's base-against-tip capture pair: WebGPU
 * identical, WebGL inside twice its same-build repeat floor.
 * @purpose Pixel metric for the landing cells (seat ruling F5, round 4): the changed-pixel count between two captures at tolerance 0 (lib/image-diff.mjs over lib/png-decode.mjs), an arm's same-build repeat floor (the largest run-0-against-run-k count) and the band verdict - a WebGPU arm within only at 0 changed pixels, a WebGL arm within at changedPx <= 2 x the larger of the base and tip arms' repeat floors (the L-08 convention).
 * @status ACTIVE
 *
 * WHY WEBGL HAS A FLOOR. The 2026-10-22 water E11 run measured WebGL's own
 * same-build repeats moving 337, 1 and 1,057 pixels (max delta <= 9/255) on
 * E-D, E-D-HDR and E-H, and the base-against-tip pairs 445, 2 and 1,046: inside
 * that noise, outside the old letter (0). WebGPU's repeats were byte-identical,
 * so WebGPU keeps the band 0. The seat's ruling is not retroactive.
 *
 * NOT A RUNTIME VERDICT. `probe-landing-cells.mjs` writes the band into
 * `comparison[arm].pixels`; which cells claim pixel identity is a wave's
 * pre-registration (the E11 sheet names them), so the probe's exit code does
 * not read it.
 *
 * @module Tools/visual-regression/lib/metrics/landing-pixel-band
 */

import { readPng } from "../../../lib/png-decode.mjs";
import { diffImages } from "../image-diff.mjs";
import { PERF_VERDICTS } from "./perf-band.mjs";

/** Pixel pairs are compared exactly. */
export const PIXEL_PAIR_TOLERANCE = 0;

/**
 * A WebGL arm's pixel band is this multiple of the same-build repeat floor
 * (seat ruling F5, round 4; the L-08 convention). A WebGPU arm's band is 0.
 */
export const WEBGL_PIXEL_FLOOR_FACTOR = 2;

/**
 * Changed pixels between two captures at {@link PIXEL_PAIR_TOLERANCE}. Node only.
 *
 * @returns {{measured: true, changedPx: number, mismatchPct: number,
 *   bbox: object}|{measured: false, reason: string}}
 */
export function pixelDiff(fromShot, toShot) {
  try {
    const a = readPng(fromShot.path);
    const b = readPng(toShot.path);
    if (a.width !== b.width || a.height !== b.height) {
      return {
        measured: false,
        reason: `size ${a.width}x${a.height} vs ${b.width}x${b.height}`,
      };
    }
    const diff = diffImages(a, b, { tolerance: PIXEL_PAIR_TOLERANCE });
    return {
      measured: true,
      changedPx: diff.changedPx,
      mismatchPct: diff.mismatchPct,
      bbox: diff.bbox,
    };
  } catch (error) {
    return { measured: false, reason: String(error?.message ?? error) };
  }
}

/**
 * An arm's same-build repeat floor: the largest changed-pixel count between
 * its run-0 capture and each later run's. Node only.
 *
 * @returns {{floorPx: number|null, pairs: number[], reason?: string}}
 */
export function repeatFloor(arm) {
  const shots = arm?.captures ?? [];
  if (shots.length < 2) {
    return { floorPx: null, pairs: [], reason: "fewer than two runs" };
  }
  const pairs = [];
  for (const shot of shots.slice(1)) {
    const diff = pixelDiff(shots[0], shot);
    if (!diff.measured) {
      return { floorPx: null, pairs, reason: diff.reason };
    }
    pairs.push(diff.changedPx);
  }
  return { floorPx: Math.max(...pairs), pairs };
}

/**
 * The pixel band of one arm (seat ruling F5): WebGPU within only at 0 changed
 * pixels; WebGL within at changedPx <= {@link WEBGL_PIXEL_FLOOR_FACTOR} x the
 * larger of the base and tip arms' same-build repeat floors. Node only (it
 * reads the repeat captures).
 *
 * @param {{renderer: string, changedPx: number, baseArm: object,
 *   tipArm: object}} input
 * @returns {object} `{rule, verdict, limitPx, floorPx?, baseFloor?,
 *   tipFloor?, reasons}`.
 */
export function pixelBand({ renderer, changedPx, baseArm, tipArm }) {
  if (renderer !== "webgl") {
    return {
      rule: "identical",
      limitPx: 0,
      verdict: changedPx === 0 ? PERF_VERDICTS.WITHIN : PERF_VERDICTS.OVER,
      reasons:
        changedPx === 0 ? [] : [`${changedPx} px changed; the band is 0`],
    };
  }
  const baseFloor = repeatFloor(baseArm);
  const tipFloor = repeatFloor(tipArm);
  const band = {
    rule: "webgl-repeat-floor",
    factor: WEBGL_PIXEL_FLOOR_FACTOR,
    baseFloor,
    tipFloor,
    floorPx: null,
    limitPx: null,
    verdict: PERF_VERDICTS.UNMEASURED,
    reasons: [],
  };
  if (baseFloor.floorPx !== null && tipFloor.floorPx !== null) {
    band.floorPx = Math.max(baseFloor.floorPx, tipFloor.floorPx);
    band.limitPx = WEBGL_PIXEL_FLOOR_FACTOR * band.floorPx;
  }
  if (changedPx === 0) {
    band.verdict = PERF_VERDICTS.WITHIN;
    return band;
  }
  if (band.limitPx === null) {
    band.reasons.push(
      `no same-build repeat floor (base: ${baseFloor.reason ?? "read"}; tip: ${tipFloor.reason ?? "read"})`,
    );
    return band;
  }
  band.verdict =
    changedPx <= band.limitPx ? PERF_VERDICTS.WITHIN : PERF_VERDICTS.OVER;
  if (band.verdict === PERF_VERDICTS.OVER) {
    band.reasons.push(
      `${changedPx} px changed exceeds ${WEBGL_PIXEL_FLOOR_FACTOR} x the repeat floor ${band.floorPx} px = ${band.limitPx} px`,
    );
  }
  return band;
}
