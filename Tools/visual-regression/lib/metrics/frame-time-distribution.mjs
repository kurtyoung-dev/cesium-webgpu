/**
 * PF-1, the frame-time distribution of a settled scene, and its base-against-
 * tip reading under a pre-registered band.
 * @purpose PF-1 for the R-2026-10-22-3 performance leg: per-run p50/p95/p99/max/mean and a stutter count (frames over 2 x p50) from per-frame times, the percentiles taken through performance-campaign-utils' summarizeFramePacing, and the base-vs-tip verdict per statistic (median across same-build repeats, band from lib/metrics/perf-band.mjs).
 * @status ACTIVE
 *
 * THE INPUT IS ONE ARRAY OF FRAME TIMES PER RUN, in milliseconds, as
 * `lib/frame-timing-steps.mjs`'s sampler returns them (`frameMs`: from the
 * `scene.render` call to the device reporting the frame's work done). The
 * window is the same on both arms: the wave brief sets it and the probe's
 * `--frames` carries it.
 *
 * PERCENTILES ARE NOT RE-IMPLEMENTED HERE. `summarizeFramePacing` in
 * `lib/performance-campaign-utils.mjs` already computes p50/p95/p99 by linear
 * interpolation over a sample's `wallDtMs`; this module hands it the frame
 * times under that name and reads `wallMs` back. Its frame-budget fields
 * (refresh rate, dropped frames) describe display pacing, not this window, and
 * are not carried.
 *
 * THE STUTTER COUNT is reported per run and in the verdict record, but it is
 * not banded: a count of a few frames has no stable relative spread, and the
 * plan bands the distribution's percentiles. The verdict is the worst of p50,
 * p95 and p99.
 *
 * @module Tools/visual-regression/lib/metrics/frame-time-distribution
 */

import { summarizeFramePacing } from "../performance-campaign-utils.mjs";
import {
  compareToBase,
  finiteValues,
  guardStatistic,
  worstVerdict,
} from "./perf-band.mjs";

/** The statistics PF-1 bands, in the order they are reported. */
export const PF1_STATISTICS = Object.freeze(["p50", "p95", "p99"]);

/** A frame over this multiple of the run's p50 is a stutter. */
export const DEFAULT_STUTTER_FACTOR = 2;

/**
 * One run's frame-time distribution.
 *
 * @param {unknown} frameMs Per-frame times in milliseconds.
 * @param {{stutterFactor?: number}} [options]
 * @returns {{n: number, p50: number|null, p95: number|null, p99: number|null,
 *   max: number|null, mean: number|null, stutterCount: number|null,
 *   stutterFactor: number}} Nulls (and n 0) when no finite frame time exists.
 */
export function summarizeFrameTimes(frameMs, options = {}) {
  const stutterFactor = options.stutterFactor ?? DEFAULT_STUTTER_FACTOR;
  const finite = finiteValues(frameMs);
  const pacing = summarizeFramePacing(finite.map((wallDtMs) => ({ wallDtMs })));
  const wall = pacing.wallMs;
  if (!wall) {
    return {
      n: 0,
      p50: null,
      p95: null,
      p99: null,
      max: null,
      mean: null,
      stutterCount: null,
      stutterFactor,
    };
  }
  const threshold = stutterFactor * wall.p50;
  return {
    n: wall.count,
    p50: wall.p50,
    p95: wall.p95,
    p99: wall.p99,
    max: wall.max,
    mean: wall.avg,
    stutterCount: finite.filter((value) => value > threshold).length,
    stutterFactor,
  };
}

/**
 * PF-1, base arm against tip arm.
 *
 * @param {object} input
 * @param {unknown[]} input.baseRuns One `frameMs` array per base repeat.
 * @param {unknown[]} input.tipRuns One `frameMs` array per tip repeat.
 * @param {object} [input.bands] Pre-registered band overrides.
 * @param {number} [input.stutterFactor]
 * @param {object} [input.contention] A `contentionGuard` result for this arm
 *   pair (`lib/metrics/perf-band.mjs`); applied to every statistic.
 * @returns {{metric: "PF-1", verdict: string, statistics: object,
 *   stutter: {base: Array<number|null>, tip: Array<number|null>},
 *   runs: {base: object[], tip: object[]}}}
 */
export function frameTimeVerdict({
  baseRuns,
  tipRuns,
  bands,
  stutterFactor,
  contention,
}) {
  const summarize = (runs) =>
    (Array.isArray(runs) ? runs : []).map((run) =>
      summarizeFrameTimes(run, { stutterFactor }),
    );
  const base = summarize(baseRuns);
  const tip = summarize(tipRuns);
  const statistics = {};
  for (const statistic of PF1_STATISTICS) {
    statistics[statistic] = guardStatistic(
      compareToBase({
        metric: "PF-1",
        statistic,
        baseRepeats: base.map((run) => run[statistic]),
        tipRepeats: tip.map((run) => run[statistic]),
        bands,
      }),
      contention,
    );
  }
  return {
    metric: "PF-1",
    verdict: worstVerdict(Object.values(statistics)),
    statistics,
    stutter: {
      base: base.map((run) => run.stutterCount),
      tip: tip.map((run) => run.stutterCount),
    },
    runs: { base, tip },
  };
}
