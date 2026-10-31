/**
 * The black-first-frame guard of a probe whose first scored capture can land before the globe is drawn.
 * @purpose Decides, from a decoded capture's non-black share, whether a probe's first frame is a frame at all, re-settles a bounded number of times when it is not, and REFUSES (first-frame-black, exit 3) when it stays black, so an undrawn globe is never scored as a product FAIL.
 * @status ACTIVE
 *
 * WHY. `probe-weather-map.mjs` rendered a fixed 90 frames and captured; on one
 * of three tip runs (Edge, 2026-10-31) the first located capture was an
 * all-black canvas, `offMin` read 0.000 and three gates failed as if the engine
 * had stopped drawing clouds. A black canvas is a probe readiness gap, not a
 * measurement. The banked frames (`located-off-lon-120-lat45.png`) read
 * `nonBlackPct` 0.004 for the black one and 99.981-100.000 for the other
 * nineteen located frames of the same run, so the bar sits far from both
 * populations: only an essentially-black frame is refused, and a dim legitimate
 * frame (a dark globe base under a night clock) still reaches the scored gates
 * rather than being masked as a refusal.
 *
 * The decision is a pure function and the retry loop takes its page work as
 * injected callbacks, so both run in Node over synthetic frames.
 *
 * @module Tools/visual-regression/lib/first-frame-guard
 */

import { frameStats } from "../../lib/png-decode.mjs";
import { ProbeRefusal } from "./probe-refusal.mjs";

/** A first frame with a smaller non-black share than this is "black". */
export const FIRST_FRAME_MIN_NON_BLACK_PCT = 1;

/** Extra settle-and-recapture rounds after a black first capture. */
export const FIRST_FRAME_MAX_RESETTLES = 2;

/**
 * Pure. Whether one measured frame is acceptable, and what to do if not.
 *
 * @param {number} nonBlackPct Percent of pixels with any channel above the
 *   `frameStats` black threshold; a non-finite value counts as black.
 * @param {number} resettlesDone Re-settles already spent.
 * @param {{minNonBlackPct?: number, maxResettles?: number}} [config]
 * @returns {{action: "accept"|"resettle"|"refuse", black: boolean}}
 */
export function decideFirstFrame(
  nonBlackPct,
  resettlesDone,
  {
    minNonBlackPct = FIRST_FRAME_MIN_NON_BLACK_PCT,
    maxResettles = FIRST_FRAME_MAX_RESETTLES,
  } = {},
) {
  const black = !(nonBlackPct >= minNonBlackPct);
  if (!black) return { action: "accept", black };
  return {
    action: resettlesDone < maxResettles ? "resettle" : "refuse",
    black,
  };
}

/**
 * Capture the first frame, and re-settle and recapture while it is black.
 *
 * @param {object} args
 * @param {(attempt: number) => Promise<{name: string, image: {width: number,
 *   height: number, data: Uint8Array|Buffer}}>} args.capture Takes and decodes
 *   one capture; `attempt` is 0 for the first.
 * @param {(attempt: number) => Promise<unknown>} args.resettle Drives the page
 *   back to a settled state before capture number `attempt`; its answer is
 *   recorded verbatim.
 * @param {number} [args.minNonBlackPct]
 * @param {number} [args.maxResettles]
 * @returns {Promise<{accepted: object, attempts: Array<{attempt: number,
 *   name: string, nonBlackPct: number, black: boolean, resettleBefore: unknown}>,
 *   minNonBlackPct: number, maxResettles: number}>} The accepted capture
 *   (what `capture` returned) and what the guard saw on each attempt.
 * @throws {ProbeRefusal} `first-frame-black` when every attempt was black.
 */
export async function guardFirstFrame({
  capture,
  resettle,
  minNonBlackPct = FIRST_FRAME_MIN_NON_BLACK_PCT,
  maxResettles = FIRST_FRAME_MAX_RESETTLES,
}) {
  const config = { minNonBlackPct, maxResettles };
  const attempts = [];
  let resettleBefore = null;
  for (let attempt = 0; ; attempt++) {
    const taken = await capture(attempt);
    const nonBlackPct = frameStats(taken.image).nonBlackPct;
    const decision = decideFirstFrame(nonBlackPct, attempt, config);
    attempts.push({
      attempt,
      name: taken.name,
      nonBlackPct,
      black: decision.black,
      resettleBefore,
    });
    if (decision.action === "accept") {
      return { accepted: taken, attempts, ...config };
    }
    if (decision.action === "refuse") {
      throw new ProbeRefusal(
        "first-frame-black",
        `the first capture was black on all ${attempts.length} attempts ` +
          `(non-black share ${attempts
            .map((entry) => entry.nonBlackPct.toFixed(3))
            .join(", ")} % against a ${minNonBlackPct} % bar): the globe was ` +
          "not drawn, which is a probe readiness gap and not a measurement",
        { attempts, ...config },
      );
    }
    resettleBefore = await resettle(attempt + 1);
  }
}
