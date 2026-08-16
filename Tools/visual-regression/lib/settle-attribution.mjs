// C11-146 / S8-7 — settle-window attribution rule + first-complete-frame metric.
// @purpose First-complete-frame metric plus the rule that stable-time credit requires a main-thread long-task reduction (GPU-bound settles book none).
// @status ACTIVE
//
// WHY THIS EXISTS
// ---------------
// The performance runner's time-to-first-frame proxy is `frameNumber > 0`: it
// fires when the FIRST frame renders, not when the scene is actually complete.
// On the moving-altitude route WebGPU's tile-stable time lags that proxy by
// ~1.3–1.7 s, and that lag is GPU-submit-traffic bound — the settle window
// contains zero main-thread long tasks. A closure/churn fix that removes
// main-thread allocation can therefore appear to improve "TTFF" while the
// perceived time-to-stable is unchanged.
//
// Two guards close that gap, and both live here as pure functions so the rule
// is a testable artifact rather than a convention someone has to remember:
//
//   * FIRST-COMPLETE-FRAME — the frame at which every selected globe tile is
//     rendering its own loaded geometry with its imagery ready, held for N
//     frames so mid-stream flicker cannot declare a false-early complete. This
//     is the perceived-TTFF a boot claim has to move.
//   * SETTLE-WINDOW ATTRIBUTION — a stable-time improvement is bookable ONLY
//     when a main-thread long-task reduction accompanies it. When the settle
//     window holds no main-thread long tasks, the settle is GPU-submit bound
//     and no main-thread fix may claim credit for shortening it.
//
// Neither replaces the existing metrics: `frameNumber > 0` and
// `navigationToStableMs` keep their meaning so the C9-30 / Gate-A anchors stay
// comparable (never re-derive a baseline).

/** Recorded verbatim into runner output so an artifact carries its own rule. */
export const SETTLE_ATTRIBUTION_RULE =
  "A settle/tile-stable-time improvement is creditable only when a main-thread " +
  "long-task reduction accompanies it. A settle window with no main-thread long " +
  "tasks is GPU-submit bound: main-thread closure/churn fixes must not book " +
  "stable-time credit against it.";

/**
 * Consecutive complete frames required before the scene is declared complete.
 * `rendered == selected` can flicker while tiles stream, so a single frame is
 * not evidence.
 */
export const FIRST_COMPLETE_FRAME_STABLE_FRAMES = 3;

/**
 * Share of the settle window that must be main-thread long-task time before
 * the settle counts as main-thread bound rather than mixed.
 */
export const MAIN_THREAD_BOUND_FRACTION = 0.2;

/**
 * @typedef {object} LongTaskEntry
 * @property {number} startTime
 * @property {number} duration
 */

/**
 * Sums the main-thread long-task time that overlaps a window. Entries are
 * clipped to the window rather than counted whole — a long task straddling the
 * boundary contributes only the part inside.
 *
 * @param {readonly LongTaskEntry[]} longTasks
 * @param {number} windowStartMs
 * @param {number} windowEndMs
 * @returns {{count: number, totalMs: number, longestMs: number}}
 */
export function sumLongTasksInWindow(longTasks, windowStartMs, windowEndMs) {
  let count = 0;
  let totalMs = 0;
  let longestMs = 0;
  for (const entry of longTasks ?? []) {
    const start = Math.max(entry.startTime, windowStartMs);
    const end = Math.min(entry.startTime + entry.duration, windowEndMs);
    const overlap = end - start;
    if (overlap <= 0) {
      continue;
    }
    count++;
    totalMs += overlap;
    longestMs = Math.max(longestMs, overlap);
  }
  return { count, totalMs, longestMs };
}

/**
 * @typedef {object} SettleAttribution
 * @property {boolean} available False when longtask observation was unsupported.
 * @property {{startMs: number, endMs: number, durationMs: number}} window
 * @property {{count: number, totalMs: number, longestMs: number, fraction: number}} longTasks
 * @property {"main-thread"|"mixed"|"gpu-submit"|"unknown"} bound
 * @property {boolean} creditable Whether a main-thread fix may book settle credit.
 * @property {string} reason
 * @property {string} rule
 */

/**
 * Classifies a settle window as main-thread bound or GPU-submit bound and
 * emits the attribution flag the runner records alongside its timings.
 *
 * @param {object} options
 * @param {readonly LongTaskEntry[]} [options.longTasks]
 * @param {number} options.windowStartMs
 * @param {number} options.windowEndMs
 * @param {boolean} [options.available=true] Whether longtask entries could be observed.
 * @param {number} [options.mainThreadBoundFraction]
 * @returns {SettleAttribution}
 */
export function classifySettleAttribution(options) {
  const {
    longTasks = [],
    windowStartMs,
    windowEndMs,
    available = true,
    mainThreadBoundFraction = MAIN_THREAD_BOUND_FRACTION,
  } = options;

  const durationMs = Math.max(0, (windowEndMs ?? 0) - (windowStartMs ?? 0));
  const window = {
    startMs: windowStartMs ?? null,
    endMs: windowEndMs ?? null,
    durationMs,
  };

  if (!available || !Number.isFinite(durationMs) || durationMs <= 0) {
    return {
      available: false,
      window,
      longTasks: { count: 0, totalMs: 0, longestMs: 0, fraction: 0 },
      bound: "unknown",
      // Unknown is not permission. Without observation there is no evidence a
      // main-thread reduction moved anything.
      creditable: false,
      reason: !available
        ? "long-task observation unavailable — settle attribution cannot be established"
        : "settle window has no measurable duration",
      rule: SETTLE_ATTRIBUTION_RULE,
    };
  }

  const summary = sumLongTasksInWindow(longTasks, windowStartMs, windowEndMs);
  const fraction = summary.totalMs / durationMs;

  if (summary.count === 0) {
    return {
      available: true,
      window,
      longTasks: { ...summary, fraction: 0 },
      bound: "gpu-submit",
      creditable: false,
      reason:
        "zero main-thread long tasks in the settle window — the settle is GPU-submit bound, so a main-thread closure/churn fix may not book stable-time credit",
      rule: SETTLE_ATTRIBUTION_RULE,
    };
  }

  const mainThreadBound = fraction >= mainThreadBoundFraction;
  return {
    available: true,
    window,
    longTasks: { ...summary, fraction },
    bound: mainThreadBound ? "main-thread" : "mixed",
    creditable: true,
    reason: mainThreadBound
      ? `main-thread long tasks cover ${(fraction * 100).toFixed(1)}% of the settle window — a main-thread reduction can move it`
      : `main-thread long tasks cover only ${(fraction * 100).toFixed(1)}% of the settle window — credit requires an accompanying long-task reduction`,
    rule: SETTLE_ATTRIBUTION_RULE,
  };
}

/**
 * Applies the rule to a baseline/candidate pair: a settle-time improvement is
 * bookable only when the candidate also reduced main-thread long-task time.
 *
 * @param {object} options
 * @param {{settleMs: number, attribution: SettleAttribution}} options.baseline
 * @param {{settleMs: number, attribution: SettleAttribution}} options.candidate
 * @returns {{settleDeltaMs: number, longTaskDeltaMs: number, improved: boolean, bookable: boolean, reason: string, rule: string}}
 */
export function classifySettleDelta({ baseline, candidate }) {
  const settleDeltaMs = candidate.settleMs - baseline.settleMs;
  const longTaskDeltaMs =
    candidate.attribution.longTasks.totalMs -
    baseline.attribution.longTasks.totalMs;
  const improved = settleDeltaMs < 0;

  if (!improved) {
    return {
      settleDeltaMs,
      longTaskDeltaMs,
      improved: false,
      bookable: false,
      reason: "settle time did not improve",
      rule: SETTLE_ATTRIBUTION_RULE,
    };
  }

  if (!baseline.attribution.available || !candidate.attribution.available) {
    return {
      settleDeltaMs,
      longTaskDeltaMs,
      improved: true,
      bookable: false,
      reason:
        "long-task attribution unavailable on at least one side — the improvement cannot be attributed",
      rule: SETTLE_ATTRIBUTION_RULE,
    };
  }

  const bookable = longTaskDeltaMs < 0;
  return {
    settleDeltaMs,
    longTaskDeltaMs,
    improved: true,
    bookable,
    reason: bookable
      ? `settle improved by ${(-settleDeltaMs).toFixed(1)} ms alongside a ${(-longTaskDeltaMs).toFixed(1)} ms main-thread long-task reduction`
      : `settle improved by ${(-settleDeltaMs).toFixed(1)} ms with no main-thread long-task reduction (${longTaskDeltaMs.toFixed(1)} ms) — GPU-submit bound, not bookable`,
    rule: SETTLE_ATTRIBUTION_RULE,
  };
}

/**
 * @typedef {object} CompletionSample
 * @property {number|null} frameNumber
 * @property {number} tSinceSetupMs
 * @property {number} selectedTileCount
 * @property {number} completeTileCount
 */

/**
 * Finds the first frame that begins a run of `stableFrames` consecutive frames
 * where every selected globe tile is complete. Returns the FIRST frame of the
 * run — the run length is anti-flicker, not part of the metric.
 *
 * @param {readonly CompletionSample[]} samples
 * @param {object} [options]
 * @param {number} [options.stableFrames]
 * @returns {(CompletionSample & {stableFrames: number, index: number})|null}
 */
export function findFirstCompleteFrame(samples, options = {}) {
  const stableFrames =
    options.stableFrames ?? FIRST_COMPLETE_FRAME_STABLE_FRAMES;
  let run = 0;
  let runStart = -1;
  const list = samples ?? [];
  for (let index = 0; index < list.length; index++) {
    const sample = list[index];
    const complete =
      sample.selectedTileCount > 0 &&
      sample.completeTileCount === sample.selectedTileCount;
    if (!complete) {
      run = 0;
      runStart = -1;
      continue;
    }
    if (run === 0) {
      runStart = index;
    }
    run++;
    if (run >= stableFrames) {
      return { ...list[runStart], stableFrames, index: runStart };
    }
  }
  return null;
}
