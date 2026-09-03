// aec-residency-stall-locus.mjs — decides WHERE an E-1 settle-window stall was
// waiting, from a banked E-1 receipt. Pure Node: no browser, no GPU, no build.
//
// @purpose Decomposes an E-1 residency receipt leg into its dominant inter-frame gaps, reads the wall-clock poll cadence inside the largest gap to decide whether the renderer's main thread was blocked or free, and reports whether a pipeline-creation CAUSE is licensed by that evidence.
// @status ACTIVE
//
// ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
//
// `classifySettleWindow` in `aec-residency-e1.mjs` answers a two-axis band
// question: was the main thread busy, and was the pipeline cache pending. On
// the WebGPU leg of the AEC design-model scene both bands land where the
// `pipeline-creation-bound` hypothesis predicted, and the instrument reports
// that verdict correctly.
//
// A band verdict names a CORRELATION. It cannot separate "pipeline creation is
// what the frame loop was waiting on" from "pipeline creation and the frame
// loop were both waiting on one thing further down". Those two have the same
// signature on both of its axes: idle main thread, non-zero pending.
//
// This module adds the axis that separates them, and it reads that axis out of
// data the E-1 receipt already carries.
//
//   * A settle window whose lost time is spread across every frame is a
//     per-frame cost. A settle window whose lost time is concentrated in a
//     handful of multi-second inter-frame gaps is a small number of discrete
//     waits, and only those waits need explaining.
//
//   * The pipeline poll runs on a wall-clock timer, NOT on the frame loop
//     (`probe-aec-residency-e1.mjs` samples it on a 250 ms cadence for exactly
//     this reason). So the polls that land INSIDE a frame gap report on the
//     renderer's own event loop while no frame is being produced. If the timer
//     held its cadence right through a 30-second gap, nothing on the main
//     thread was blocking: the event loop was free, ran its timers on time, and
//     was simply never handed an animation frame. If instead the polls starved
//     alongside the frames, the main thread WAS blocked and the wait is on it.
//
// The first reading rules out every main-thread explanation for that gap. It
// also withdraws the licence to read `pending > 0` as a cause, because
// animation-frame delivery has nothing to do with the pipeline cache: if both
// stop together and neither can stop the other, they share an owner this
// instrument does not sample.
//
// ── THE THRESHOLDS ARE PRE-REGISTERED ───────────────────────────────────────
//
// `STALL_LOCUS_THRESHOLDS` is frozen and `classifyStallLocus` reads nothing
// else. Every outcome is reachable: a diffuse window returns `no-dominant-gap`,
// a gap the poll never entered returns `undetermined-no-poll-axis`, a gap the
// poll starved through returns `main-thread-blocked`, and a gap the poll rode
// out on cadence returns `off-main-thread`. The classifier can therefore come
// out against the reading that motivated it.
//
// ── WHAT IT DELIBERATELY DOES NOT DO ────────────────────────────────────────
//
// It does not name the off-thread owner. Naming it needs an axis nobody has
// sampled yet. Reporting `off-main-thread` with `pipelineCauseLicensed` false
// is the honest end of what this receipt can support, and it is a refusal, not
// a de-scoring: the measured red stands, only its attribution is withdrawn.

/**
 * Frozen decision thresholds. Registered before this module was run against
 * any receipt.
 *
 * `cadenceToleranceFactor` is a ratio against the leg's OWN nominal poll
 * cadence rather than against the probe's configured interval, so a leg whose
 * poll ran slow throughout is judged against itself.
 */
export const STALL_LOCUS_THRESHOLDS = Object.freeze({
  /** A gap must last at least this long to count as dominant. */
  dominantGapMs: 5000,
  /** Gaps at or over `reportGapMs` must own at least this share of the window. */
  dominantGapFraction: 0.25,
  /** Gaps at or over this length are reported individually. */
  reportGapMs: 1000,
  /**
   * A gap the poll axis could not have sampled this many times, at the leg's
   * own nominal cadence, is one the instrument cannot resolve. This is a
   * property of the CADENCE against the gap length, never of what was
   * observed: a main thread blocked for the whole gap observes nothing, and
   * reading that as "cannot resolve" would hide the very case the axis exists
   * to catch.
   */
  minimumPollsInGap: 8,
  /**
   * Observed in-gap polls as a share of what the nominal cadence predicts.
   * Below this the event loop missed its timers, which is starvation.
   */
  pollCoverageFloor: 0.5,
  /** Median in-gap poll interval over nominal, above which the poll is starved too. */
  cadenceToleranceFactor: 2.0,
});

/**
 * Median of a numeric array. Returns NaN for an empty array so a caller that
 * forgets to check sample count gets a value that fails comparisons rather
 * than a plausible zero.
 *
 * @param {ReadonlyArray<number>} values Values.
 * @returns {number} The median, or NaN.
 */
export function median(values) {
  if (!Array.isArray(values) || values.length === 0) {
    return Number.NaN;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const middle = sorted.length >> 1;
  return sorted.length % 2 === 1
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

/**
 * Reads one leg's frame samples as a set of inter-frame gaps.
 *
 * The first frame sample carries the interval that preceded recording rather
 * than an inter-frame interval, so it is excluded from the window and from the
 * gap set. Each returned gap is the interval that ENDS at its frame.
 *
 * @param {object} leg One `legs[]` entry from an E-1 receipt.
 * @param {object} [options] Overrides.
 * @param {number} [options.reportGapMs] Minimum gap length to report.
 * @returns {{windowMs: number, frameCount: number, gaps: object[], gapMs: number,
 *   gapFraction: number, medianFrameDeltaMs: number}} The decomposition.
 */
export function decomposeFrameGaps(leg, options = {}) {
  const reportGapMs = options.reportGapMs ?? STALL_LOCUS_THRESHOLDS.reportGapMs;
  const samples = Array.isArray(leg?.frameSamples) ? leg.frameSamples : [];
  const intervals = samples.slice(1);

  let windowMs = 0;
  const gaps = [];
  const deltas = [];
  for (let index = 0; index < intervals.length; index++) {
    const sample = intervals[index];
    const durationMs = Number(sample?.sinceLastFrameMs);
    if (!Number.isFinite(durationMs) || durationMs < 0) {
      continue;
    }
    windowMs += durationMs;
    deltas.push(durationMs);
    if (durationMs < reportGapMs) {
      continue;
    }
    const endMs = Number(sample?.atMs);
    gaps.push({
      // The index into `frameSamples`, so a reader can find the row.
      frameIndex: index + 1,
      durationMs,
      endMs: Number.isFinite(endMs) ? endMs : Number.NaN,
      startMs: Number.isFinite(endMs) ? endMs - durationMs : Number.NaN,
      commandListLength: sample?.commandListLength ?? null,
      pipelineCache: sample?.pipelineCache ?? null,
    });
  }

  gaps.sort((left, right) => right.durationMs - left.durationMs);
  const gapMs = gaps.reduce((total, gap) => total + gap.durationMs, 0);

  return {
    windowMs,
    frameCount: samples.length,
    gaps,
    gapMs,
    gapFraction: windowMs > 0 ? gapMs / windowMs : 0,
    medianFrameDeltaMs: median(deltas),
  };
}

/**
 * Reads the wall-clock poll cadence inside a time window, against the leg's
 * own nominal cadence.
 *
 * The nominal cadence is the median interval over EVERY poll in the leg. The
 * in-window cadence is the median over the polls whose timestamp falls in the
 * window. A poll is counted in the window when its timestamp is inside it; the
 * interval it carries is the one it terminates, so the first in-window poll's
 * interval may straddle the window's start. That is reported rather than
 * trimmed: a straddling first interval is exactly how a poll deferred by the
 * event that OPENED the gap shows up, and hiding it would flatter the cadence.
 *
 * `expectedPolls` is what the leg's own nominal cadence predicts for a window
 * of this length, and `pollCoverage` is the observed count over it. Coverage
 * is the reading that catches a main thread blocked for the WHOLE window,
 * which observes no intervals at all and so has no median to inflate.
 *
 * @param {object} leg One `legs[]` entry from an E-1 receipt.
 * @param {{startMs: number, endMs: number}} window Window bounds.
 * @returns {{polls: number, medianIntervalMs: number, maxIntervalMs: number,
 *   nominalIntervalMs: number, cadenceRatio: number, expectedPolls: number,
 *   pollCoverage: number}} The reading.
 */
export function pollCadenceInWindow(leg, window) {
  const samples = Array.isArray(leg?.cacheSamples) ? leg.cacheSamples : [];
  const allIntervals = [];
  const inWindowIntervals = [];

  for (const sample of samples) {
    const interval = Number(sample?.sinceLastSampleMs);
    const atMs = Number(sample?.atMs);
    if (!Number.isFinite(interval) || interval <= 0) {
      continue;
    }
    allIntervals.push(interval);
    if (
      Number.isFinite(atMs) &&
      Number.isFinite(window?.startMs) &&
      Number.isFinite(window?.endMs) &&
      atMs >= window.startMs &&
      atMs <= window.endMs
    ) {
      inWindowIntervals.push(interval);
    }
  }

  const nominalIntervalMs = median(allIntervals);
  const medianIntervalMs = median(inWindowIntervals);
  const maxIntervalMs =
    inWindowIntervals.length > 0 ? Math.max(...inWindowIntervals) : Number.NaN;
  const windowMs =
    Number.isFinite(window?.endMs) && Number.isFinite(window?.startMs)
      ? window.endMs - window.startMs
      : Number.NaN;
  const expectedPolls =
    Number.isFinite(windowMs) &&
    Number.isFinite(nominalIntervalMs) &&
    nominalIntervalMs > 0
      ? windowMs / nominalIntervalMs
      : Number.NaN;

  return {
    polls: inWindowIntervals.length,
    medianIntervalMs,
    maxIntervalMs,
    nominalIntervalMs,
    expectedPolls,
    pollCoverage:
      Number.isFinite(expectedPolls) && expectedPolls > 0
        ? inWindowIntervals.length / expectedPolls
        : Number.NaN,
    cadenceRatio:
      Number.isFinite(medianIntervalMs) &&
      Number.isFinite(nominalIntervalMs) &&
      nominalIntervalMs > 0
        ? medianIntervalMs / nominalIntervalMs
        : Number.NaN,
  };
}

/**
 * Reads how far the pipeline cache moved across a time window, from the polls
 * that fall inside it.
 *
 * @param {object} leg One `legs[]` entry from an E-1 receipt.
 * @param {{startMs: number, endMs: number}} window Window bounds.
 * @returns {{first: object|null, last: object|null, createdDelta: number|null,
 *   hitsDelta: number|null, missesDelta: number|null, pendingHeld: boolean}} The reading.
 */
export function pipelineProgressInWindow(leg, window) {
  const samples = Array.isArray(leg?.cacheSamples) ? leg.cacheSamples : [];
  const inWindow = samples.filter((sample) => {
    const atMs = Number(sample?.atMs);
    return (
      Number.isFinite(atMs) &&
      atMs >= window?.startMs &&
      atMs <= window?.endMs &&
      sample?.pipelineCache !== null &&
      sample?.pipelineCache !== undefined
    );
  });

  if (inWindow.length === 0) {
    return {
      first: null,
      last: null,
      createdDelta: null,
      hitsDelta: null,
      missesDelta: null,
      pendingHeld: false,
    };
  }

  const first = inWindow[0].pipelineCache;
  const last = inWindow[inWindow.length - 1].pipelineCache;
  const delta = (key) =>
    typeof last?.[key] === "number" && typeof first?.[key] === "number"
      ? last[key] - first[key]
      : null;

  // "Held" means every in-window reading was above zero AND never changed:
  // work was outstanding for the whole window and none of it landed.
  const pendings = inWindow.map((sample) => sample.pipelineCache.pending);
  const pendingHeld =
    pendings.every((value) => typeof value === "number" && value > 0) &&
    pendings.every((value) => value === pendings[0]);

  return {
    first,
    last,
    createdDelta: delta("created"),
    hitsDelta: delta("hits"),
    missesDelta: delta("misses"),
    pendingHeld,
  };
}

/**
 * Decides where a leg's settle-window stall was waiting.
 *
 * @param {object} leg One `legs[]` entry from an E-1 receipt.
 * @param {object} [thresholds] Overrides for {@link STALL_LOCUS_THRESHOLDS}.
 * @returns {{locus: string, reason: string, dominantGap: object|null,
 *   decomposition: object, cadence: object|null, pipeline: object|null,
 *   pipelineCauseLicensed: boolean|null}} The verdict and the evidence it rests on.
 */
export function classifyStallLocus(leg, thresholds = {}) {
  const limits = { ...STALL_LOCUS_THRESHOLDS, ...thresholds };
  const decomposition = decomposeFrameGaps(leg, limits);

  const base = {
    dominantGap: null,
    decomposition,
    cadence: null,
    pipeline: null,
    pipelineCauseLicensed: null,
  };

  const largest = decomposition.gaps[0] ?? null;
  if (
    largest === null ||
    largest.durationMs < limits.dominantGapMs ||
    decomposition.gapFraction < limits.dominantGapFraction
  ) {
    return {
      ...base,
      locus: "no-dominant-gap",
      reason:
        "the settle window's lost time is spread across its frames rather than " +
        "concentrated in a few multi-second waits, so a per-frame cost explains it",
    };
  }

  const window = { startMs: largest.startMs, endMs: largest.endMs };
  const cadence = pollCadenceInWindow(leg, window);
  const pipeline = pipelineProgressInWindow(leg, window);
  const evidence = { ...base, dominantGap: largest, cadence, pipeline };

  // Resolvability is a property of the CADENCE against the gap length, decided
  // before anything observed is read. A poll running slower than the gap can
  // accommodate could not have seen inside it whatever the loop was doing, and
  // that is genuinely undetermined; a poll fast enough to have sampled the gap
  // and absent from it anyway is starvation, which is a finding.
  if (
    !Number.isFinite(cadence.expectedPolls) ||
    cadence.expectedPolls < limits.minimumPollsInGap
  ) {
    return {
      ...evidence,
      locus: "undetermined-no-poll-axis",
      reason:
        `the leg's nominal poll cadence would fit ` +
        `${Number.isFinite(cadence.expectedPolls) ? cadence.expectedPolls.toFixed(1) : "no"}` +
        ` samples into the largest gap, below the ${limits.minimumPollsInGap} ` +
        `needed to read the event loop inside it`,
    };
  }

  const coverageShort = !(cadence.pollCoverage >= limits.pollCoverageFloor);
  const cadenceInflated = !(
    cadence.cadenceRatio <= limits.cadenceToleranceFactor
  );
  if (coverageShort || cadenceInflated) {
    return {
      ...evidence,
      // The poll starved alongside the frames, so the event loop itself was
      // not being serviced. A main-thread explanation is admissible and the
      // pipeline reading keeps whatever weight the E-1 bands gave it.
      locus: "main-thread-blocked",
      pipelineCauseLicensed: true,
      reason: coverageShort
        ? `the wall-clock poll landed ${cadence.polls} times inside the gap ` +
          `against the ${cadence.expectedPolls.toFixed(0)} its own nominal ` +
          `cadence predicts, so the event loop missed its timers`
        : `the wall-clock poll's median interval inside the gap ran ` +
          `${cadence.cadenceRatio.toFixed(2)} times its own nominal cadence, ` +
          `so the event loop was serviced late`,
    };
  }

  // The event loop kept its timer cadence for the whole gap, so nothing on the
  // main thread was blocking. A pipeline-creation CAUSE is licensed only if
  // creations were actually landing inside the gap; if `created` did not move
  // while the frame loop was also stopped, the two stopped together and
  // neither can be shown to have stopped the other.
  const createdMoved =
    typeof pipeline.createdDelta === "number" && pipeline.createdDelta > 0;
  return {
    ...evidence,
    locus: "off-main-thread",
    pipelineCauseLicensed: createdMoved,
    reason:
      `the wall-clock poll held its cadence (median ` +
      `${cadence.medianIntervalMs.toFixed(0)} ms against a nominal ` +
      `${cadence.nominalIntervalMs.toFixed(0)} ms) across the whole ` +
      `${(largest.durationMs / 1000).toFixed(1)} s gap, so the renderer's event ` +
      `loop was free and never handed a frame` +
      (createdMoved
        ? `; ${pipeline.createdDelta} pipeline creations landed inside the gap`
        : `; no pipeline creation landed inside the gap either, so pipeline ` +
          `creation is a co-victim of the wait and not a demonstrated cause`),
  };
}

/**
 * Applies {@link classifyStallLocus} to every leg of a receipt.
 *
 * @param {object} receipt A parsed E-1 receipt.
 * @param {object} [thresholds] Overrides for {@link STALL_LOCUS_THRESHOLDS}.
 * @returns {Array<object>} One row per leg, carrying the leg's backend name and
 *   the E-1 verdict alongside this module's own verdict.
 */
export function analyzeReceipt(receipt, thresholds = {}) {
  const legs = Array.isArray(receipt?.legs) ? receipt.legs : [];
  return legs.map((leg) => ({
    backend: leg?.backend ?? "(unnamed)",
    e1Verdict: leg?.classification?.verdict ?? null,
    ...classifyStallLocus(leg, thresholds),
  }));
}

/**
 * Renders {@link analyzeReceipt} rows as a Markdown report.
 *
 * @param {ReadonlyArray<object>} rows Rows from {@link analyzeReceipt}.
 * @returns {string} Markdown.
 */
export function buildStallLocusReport(rows) {
  const lines = [
    "# Stall locus — where the settle window was waiting",
    "",
    "| Backend | E-1 verdict | Locus | Largest gap | Gap share | Polls in gap | Poll coverage | Cadence x | Created in gap | Pipeline cause licensed |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
  ];
  for (const row of rows) {
    const gap = row.dominantGap;
    const cadence = row.cadence;
    const cadenceRatio =
      cadence && Number.isFinite(cadence.cadenceRatio)
        ? cadence.cadenceRatio.toFixed(2)
        : "n/a";
    const coverage =
      cadence && Number.isFinite(cadence.pollCoverage)
        ? `${(cadence.pollCoverage * 100).toFixed(0)}%`
        : "n/a";
    const created =
      row.pipeline && row.pipeline.createdDelta !== null
        ? row.pipeline.createdDelta
        : "n/a";
    const licensed =
      row.pipelineCauseLicensed === null
        ? "n/a"
        : row.pipelineCauseLicensed
          ? "yes"
          : "NO";
    lines.push(
      `| ${row.backend} | ${row.e1Verdict ?? "n/a"} | ${row.locus} | ` +
        `${gap ? `${(gap.durationMs / 1000).toFixed(1)} s` : "none"} | ` +
        `${(row.decomposition.gapFraction * 100).toFixed(1)}% | ` +
        `${cadence ? cadence.polls : "n/a"} | ${coverage} | ${cadenceRatio} | ` +
        `${created} | ${licensed} |`,
    );
  }
  lines.push("");
  for (const row of rows) {
    lines.push(`- **${row.backend}** — ${row.reason}`);
  }
  lines.push("");
  return lines.join("\n");
}
