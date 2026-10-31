/**
 * The pre-registered performance band the landing program's PF-1..PF-4 legs
 * are judged against: same-build repeat spread, the band it implies, and the
 * base-against-tip comparison that reads a band.
 * @purpose Pure band arithmetic for the R-2026-10-22-3 performance leg: the seat's default bands (3 % floor, 2 x repeat factor, 10 % startup band floor, 2.5 s startup ceiling, 0 declared allocation), the relative spread of same-build repeats, the band fraction b = max(factor x base-arm spread, floor) (PF-3 reads the startup band floor in the floor's place), verdict objects ({within, over, unmeasured, unmeasured-contended}) for a lower-is-better statistic and for the startup ceiling rule, each carrying the band it was given, and the pre-registered machine-CPU contention guard (a run's mean CPU, the arms' mean delta, and a streak of consecutive busy samples) that turns a PF-1..PF-3 statistic read on a busy machine into unmeasured-contended.
 * @status ACTIVE
 *
 * WHERE THE RULES COME FROM. `CLOUD_WATER_LANDING_PLAN_2026-10-21.md` §2.2
 * (E-PF): "PF-1 and PF-2: tip <= base x (1 + b), where b = max(2 x the
 * same-build repeat spread on that arm, 3 %)"; "PF-3: tip < 2.0 s on every
 * cell, and tip <= base x (1 + b). If base itself is at or over 2.0 s on a
 * cell ... the move is admitted only at tip <= base, with no band slack";
 * "PF-4: tip <= base + the unit's allocation as declared in the brief". The
 * 3 % floor and the factor 2 are the plan's proposal, confirmed by the seat in
 * the first wave brief; a wave pre-registers its own bands and passes them in.
 *
 * THE PF-3 RULE THE SEAT CHANGED (row DX-KIT-PF3-STARTUP-CEILING-WEBGL). The
 * plan's PF-3 text above has two parts the seat replaced. Same-build WebGL
 * arms measured 1,950-2,224 ms navigation-to-first-frame with medians 5 %
 * apart, so a fixed 2.0 s ceiling failed same-build tip arms. (a) The ceiling
 * is resized to 2.5 s: a startup blow-up guard, not a noise band. (b) PF-3
 * reads `startupBandFloor` (10 %) where PF-1 and PF-2 read `floorFraction`
 * (3 %): b = max(repeatFactor x base-arm spread, startupBandFloor).
 * (c) The plan's "no band slack" rule for a base already at or over the
 * ceiling is gone: that verdict now uses the same banded compare, tip median
 * <= base median x (1 + b), and the ceiling clause is not applied (the base is
 * itself over it). `baseOverCeiling` stays set and the rule reads
 * `base-over-ceiling-banded`, so the wave packet still reports the cell.
 *
 * "ON THAT ARM" IS READ AS THE BASE ARM. The band is a tolerance around the
 * base measurement, so it is sized by the base arm's own repeat spread. The
 * tip arm's spread is reported beside it (`tipSpread`) so a reader can see a
 * tip that is noisier than its base; it does not widen the band. A seat that
 * rules otherwise changes `bandFraction`, in one place.
 *
 * A VERDICT IS NEVER A PASS TOKEN. The vocabulary is `within`, `over` and
 * `unmeasured`; a value that is absent or not finite is `unmeasured`, never
 * `within`, because a cell that could not be measured has not been shown to
 * be no worse than base.
 *
 * THE CONTENTION GUARD (round 4, F3; pre-registered, seat item F3). A
 * statistic read while the machine was busy with something else measures the
 * machine, not the tree. Each run of a PF-1, PF-2 or PF-3 arm carries the mean
 * machine CPU over its page (`lib/cpu-sampler.mjs`). The guard reads
 * `unmeasured-contended` (the D4 class: NOT RUN, never a pass and never an
 * `over`) when any run of either arm had a mean CPU above
 * `contendedCpuPct` (default 60 %), or when the base and tip arms' mean CPU
 * differ by more than `cpuArmDeltaPct` (default 20 points). A run whose CPU
 * was not read makes the statistic `unmeasured` (a report written before
 * round 4 carries none). The verdict the statistic would have read is kept as
 * `verdictIfUncontended`, for the reader, never for a decision.
 *
 * THE SAMPLE CLAUSE (round 5, K5-6; seat ruling S5). A mean can hide a burst:
 * the 2026-10-23 E11-PF pass-1 A1 invocation carried 17 samples above 60 %
 * while every page mean read clear. Beside the two mean clauses, the guard
 * reads `contended` when any run of either arm has `contendedRunSamples`
 * (default 10) CONSECUTIVE 1 Hz samples above `contendedCpuPct`. The samples
 * are the run's own page samples (`record.cpu.samples`): the stretch of the
 * machine-CPU series during which that run's statistic was measured. A caller
 * that passes no sample lists leaves the clause unread on its record
 * (`sampleClause: "not-supplied"`); one that passes lists with a run missing
 * makes the statistic `unmeasured`, as a missing mean does.
 *
 * @module Tools/visual-regression/lib/metrics/perf-band
 */

/**
 * The seat's default bands (plan §2.2 and the W2 brief skeleton, §7), and the
 * contention guard's thresholds (seat item F3, round 4), in percent of the
 * whole machine.
 */
export const SEAT_DEFAULT_BANDS = Object.freeze({
  floorFraction: 0.03,
  repeatFactor: 2,
  startupBandFloor: 0.1,
  startupCeilingMs: 2500,
  allocationBytes: 0,
  contendedCpuPct: 60,
  cpuArmDeltaPct: 20,
  contendedRunSamples: 10,
});

/**
 * The PF-3 band floor of a WebGL arm (the WebGPU floor is
 * `SEAT_DEFAULT_BANDS.startupBandFloor`, 10 %). Same-build WebGL arms of the
 * 2D identity cell moved 13.2 % between two invocations of one build
 * (navigation to first frame 2167.6 ms against 2453.1 ms; the E-ID-2d WebGL
 * rows of `EDGE_RECEIPT_EOWYN_KIT3.md` section 4, whose other same-build
 * WebGL pairs moved +10.7 %, +7.9 % and +3.5 %) and read `over` against the
 * 10 % floor. 15 % clears that spread with under two points of margin, and is
 * still under a 20 % startup regression. WebGPU arms moved -3.4 % to +5.4 % on
 * the same build (the same rows, measured with the pipeline wait inside the
 * interval), inside 10 %, so its floor stays. A wave that pre-registers
 * `startupBandFloor` explicitly overrides both renderers' floor.
 */
export const STARTUP_BAND_FLOOR_WEBGL = 0.15;

/**
 * The bands a PF-3 verdict for `renderer` reads: `bands` unchanged, except a
 * WebGL arm without a pre-registered `startupBandFloor` reads
 * {@link STARTUP_BAND_FLOOR_WEBGL}. Pure.
 *
 * @param {string|undefined} renderer `webgl` or `webgpu`.
 * @param {object} [bands] A wave's pre-registered overrides.
 * @returns {object} Overrides to hand to {@link resolveBands}.
 */
export function startupBandsFor(renderer, bands) {
  if (renderer !== "webgl" || Object.hasOwn(bands ?? {}, "startupBandFloor")) {
    return bands;
  }
  return { ...bands, startupBandFloor: STARTUP_BAND_FLOOR_WEBGL };
}

/** The verdict vocabulary. */
export const PERF_VERDICTS = Object.freeze({
  WITHIN: "within",
  OVER: "over",
  UNMEASURED: "unmeasured",
  UNMEASURED_CONTENDED: "unmeasured-contended",
});

/** What the contention guard found. */
export const CONTENTION_STATUS = Object.freeze({
  CLEAR: "clear",
  CONTENDED: "contended",
  UNREAD: "unread",
});

const isFiniteNumber = (value) =>
  typeof value === "number" && Number.isFinite(value);

/**
 * The seat defaults with a wave's pre-registered overrides on top.
 *
 * @param {object} [overrides] Any of the {@link SEAT_DEFAULT_BANDS} keys.
 * @returns {{floorFraction: number, repeatFactor: number,
 *   startupBandFloor: number, startupCeilingMs: number,
 *   allocationBytes: number}} The bands, frozen.
 * @throws {TypeError} For an unknown key or a value that is not a finite,
 *   non-negative number.
 */
export function resolveBands(overrides = {}) {
  const bands = { ...SEAT_DEFAULT_BANDS };
  for (const [key, value] of Object.entries(overrides ?? {})) {
    if (!Object.hasOwn(SEAT_DEFAULT_BANDS, key)) {
      throw new TypeError(
        `unknown band ${key}; the bands are ${Object.keys(SEAT_DEFAULT_BANDS).join(", ")}`,
      );
    }
    if (!isFiniteNumber(value) || value < 0) {
      throw new TypeError(
        `band ${key} must be a finite non-negative number, got ${String(value)}`,
      );
    }
    bands[key] = value;
  }
  return Object.freeze(bands);
}

/**
 * The finite members of a list, in order.
 *
 * @param {unknown} values
 * @returns {number[]}
 */
export function finiteValues(values) {
  return Array.isArray(values) ? values.filter(isFiniteNumber) : [];
}

/**
 * The median of the finite members, or null when there are none.
 *
 * @param {unknown} values
 * @returns {number|null}
 */
export function median(values) {
  const sorted = finiteValues(values)
    .slice()
    .sort((a, b) => a - b);
  if (sorted.length === 0) {
    return null;
  }
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

/**
 * The relative spread of same-build repeats: (max - min) / min.
 *
 * @param {unknown} values One statistic per repeat.
 * @returns {number|null} 0 when every repeat is 0; null with fewer than two
 *   finite repeats, or when the smallest is not positive while another is
 *   (a relative spread over a zero or negative floor means nothing).
 */
export function repeatSpread(values) {
  const finite = finiteValues(values);
  if (finite.length < 2) {
    return null;
  }
  const min = Math.min(...finite);
  const max = Math.max(...finite);
  if (min === 0 && max === 0) {
    return 0;
  }
  if (min <= 0) {
    return null;
  }
  return (max - min) / min;
}

/**
 * The band fraction b = max(repeatFactor x base-arm spread, floorFraction);
 * with `startup` set, the floor term is `startupBandFloor` (PF-3).
 *
 * @param {{baseRepeats?: unknown, bands?: object, startup?: boolean}} input
 * @returns {{bandFraction: number, baseSpread: number|null,
 *   source: "repeat"|"floor"|"startup-floor"}} `source` names the term that
 *   set b; a base arm with no usable spread (one repeat) falls back to the
 *   floor and says so.
 */
export function bandFraction({ baseRepeats, bands, startup = false } = {}) {
  const resolved = resolveBands(bands);
  const baseSpread = repeatSpread(baseRepeats);
  const floor = startup ? resolved.startupBandFloor : resolved.floorFraction;
  const fromRepeat =
    baseSpread === null ? null : resolved.repeatFactor * baseSpread;
  if (fromRepeat !== null && fromRepeat > floor) {
    return { bandFraction: fromRepeat, baseSpread, source: "repeat" };
  }
  return {
    bandFraction: floor,
    baseSpread,
    source: startup ? "startup-floor" : "floor",
  };
}

/**
 * Compare a lower-is-better statistic, base arm against tip arm: within when
 * median(tip) <= median(base) x (1 + b).
 *
 * @param {object} input
 * @param {string} input.metric e.g. `PF-1`.
 * @param {string} [input.statistic] e.g. `p95`.
 * @param {unknown} input.baseRepeats The statistic, one value per base repeat.
 * @param {unknown} input.tipRepeats The statistic, one value per tip repeat.
 * @param {object} [input.bands] Pre-registered overrides of the seat defaults.
 * @param {boolean} [input.startup] Read `startupBandFloor` as the band floor
 *   (PF-3 only; {@link ceilingVerdict} sets it).
 * @returns {object} `{metric, statistic, verdict, base, tip, ratio,
 *   bandFraction, bandSource, baseSpread, tipSpread, limit, bands, reasons}`.
 */
export function compareToBase({
  metric,
  statistic = null,
  baseRepeats,
  tipRepeats,
  bands,
  startup = false,
}) {
  const resolved = resolveBands(bands);
  const base = median(baseRepeats);
  const tip = median(tipRepeats);
  const band = bandFraction({ baseRepeats, bands: resolved, startup });
  const record = {
    metric,
    statistic,
    verdict: PERF_VERDICTS.UNMEASURED,
    base,
    tip,
    ratio: null,
    bandFraction: band.bandFraction,
    bandSource: band.source,
    baseSpread: band.baseSpread,
    tipSpread: repeatSpread(tipRepeats),
    limit: null,
    bands: resolved,
    reasons: [],
  };
  if (base === null) {
    record.reasons.push("no finite base measurement");
  }
  if (tip === null) {
    record.reasons.push("no finite tip measurement");
  }
  if (base === null || tip === null) {
    return record;
  }
  record.limit = base * (1 + band.bandFraction);
  record.ratio = base === 0 ? (tip === 0 ? 1 : null) : tip / base;
  record.verdict =
    tip <= record.limit ? PERF_VERDICTS.WITHIN : PERF_VERDICTS.OVER;
  if (record.verdict === PERF_VERDICTS.OVER) {
    record.reasons.push(
      `tip ${tip} exceeds base ${base} x (1 + ${band.bandFraction}) = ${record.limit}`,
    );
  }
  return record;
}

/**
 * The startup rule (PF-3): every tip repeat strictly under the ceiling
 * (`startupCeilingMs`, 2.5 s, a blow-up guard) and median(tip) <=
 * median(base) x (1 + b), with b = max(repeatFactor x base-arm spread,
 * `startupBandFloor`). When median(base) is already at or over the ceiling the
 * ceiling clause is not applied (the base is itself over it): the verdict is
 * the banded compare alone, rule `base-over-ceiling-banded`, with
 * `baseOverCeiling` set and a reason saying so, so the wave packet reports
 * the cell to the seat. The seat replaced the plan's "no band slack" rule for
 * that case and resized the plan's 2.0 s ceiling for this row.
 *
 * @param {object} input As {@link compareToBase}, in milliseconds.
 * @returns {object} The {@link compareToBase} record plus `ceilingMs`,
 *   `tipMax`, `baseOverCeiling` and the `rule` that applied.
 */
export function ceilingVerdict({
  metric,
  statistic = null,
  baseRepeats,
  tipRepeats,
  bands,
}) {
  const resolved = resolveBands(bands);
  const record = compareToBase({
    metric,
    statistic,
    baseRepeats,
    tipRepeats,
    bands: resolved,
    startup: true,
  });
  const tipFinite = finiteValues(tipRepeats);
  const tipMax = tipFinite.length > 0 ? Math.max(...tipFinite) : null;
  const ceilingMs = resolved.startupCeilingMs;
  const out = {
    ...record,
    ceilingMs,
    tipMax,
    baseOverCeiling: record.base !== null && record.base >= ceilingMs,
    rule: "ceiling-and-band",
  };
  if (record.verdict === PERF_VERDICTS.UNMEASURED) {
    return out;
  }
  out.reasons = [];
  const withinBand = record.tip <= record.limit;
  if (out.baseOverCeiling) {
    out.rule = "base-over-ceiling-banded";
    out.verdict = withinBand ? PERF_VERDICTS.WITHIN : PERF_VERDICTS.OVER;
    out.reasons.push(
      `base ${record.base} ms is at or over the ${ceilingMs} ms ceiling: the ceiling clause is not applied, the banded compare was applied instead`,
    );
    if (!withinBand) {
      out.reasons.push(
        `tip ${record.tip} ms exceeds base ${record.base} ms x (1 + ${record.bandFraction}) = ${record.limit} ms`,
      );
    }
    return out;
  }
  const underCeiling = tipMax < ceilingMs;
  out.verdict =
    underCeiling && withinBand ? PERF_VERDICTS.WITHIN : PERF_VERDICTS.OVER;
  if (!underCeiling) {
    out.reasons.push(
      `a tip repeat took ${tipMax} ms, not under the ${ceilingMs} ms ceiling`,
    );
  }
  if (!withinBand) {
    out.reasons.push(
      `tip ${record.tip} ms exceeds base ${record.base} ms x (1 + ${record.bandFraction}) = ${record.limit} ms`,
    );
  }
  return out;
}

/**
 * The longest streak of consecutive samples above `threshold`. Pure.
 *
 * @param {unknown} samples Percentages, in time order.
 * @param {number} threshold
 * @returns {number|null} null when `samples` is not a list.
 */
export function longestRunAbove(samples, threshold) {
  if (!Array.isArray(samples)) {
    return null;
  }
  let longest = 0;
  let current = 0;
  for (const value of samples) {
    current = isFiniteNumber(value) && value > threshold ? current + 1 : 0;
    longest = Math.max(longest, current);
  }
  return longest;
}

/**
 * The contention guard over one arm pair (see THE CONTENTION GUARD and THE
 * SAMPLE CLAUSE in the module header). Pure.
 *
 * @param {object} input
 * @param {unknown} input.baseCpu The mean machine CPU (%) of each base run.
 * @param {unknown} input.tipCpu The same for each tip run.
 * @param {unknown} [input.baseSamples] Each base run's 1 Hz CPU samples (%),
 *   in time order; omitted (with `tipSamples`), the sample clause is not read.
 * @param {unknown} [input.tipSamples] The same for each tip run.
 * @param {object} [input.bands] Pre-registered overrides.
 * @returns {{status: string, baseCpu: Array<number|null>,
 *   tipCpu: Array<number|null>, baseMeanCpu: number|null,
 *   tipMeanCpu: number|null, armDeltaPct: number|null,
 *   contendedCpuPct: number, cpuArmDeltaPct: number,
 *   contendedRunSamples: number, sampleClause: string,
 *   baseLongestRun: Array<number|null>, tipLongestRun: Array<number|null>,
 *   reasons: string[]}}
 */
export function contentionGuard({
  baseCpu,
  tipCpu,
  baseSamples,
  tipSamples,
  bands,
} = {}) {
  const resolved = resolveBands(bands);
  const list = (values) =>
    (Array.isArray(values) ? values : []).map((value) =>
      isFiniteNumber(value) ? value : null,
    );
  const base = list(baseCpu);
  const tip = list(tipCpu);
  const mean = (values) =>
    values.length === 0 || values.some((value) => value === null)
      ? null
      : values.reduce((sum, value) => sum + value, 0) / values.length;
  const record = {
    status: CONTENTION_STATUS.CLEAR,
    baseCpu: base,
    tipCpu: tip,
    baseMeanCpu: mean(base),
    tipMeanCpu: mean(tip),
    armDeltaPct: null,
    contendedCpuPct: resolved.contendedCpuPct,
    cpuArmDeltaPct: resolved.cpuArmDeltaPct,
    contendedRunSamples: resolved.contendedRunSamples,
    sampleClause: "not-supplied",
    baseLongestRun: [],
    tipLongestRun: [],
    reasons: [],
  };
  const samplesSupplied = baseSamples !== undefined || tipSamples !== undefined;
  const streaks = (lists, count) =>
    Array.from({ length: count }, (_, index) =>
      longestRunAbove(
        Array.isArray(lists) ? lists[index] : undefined,
        resolved.contendedCpuPct,
      ),
    );
  if (samplesSupplied) {
    record.sampleClause = "read";
    record.baseLongestRun = streaks(baseSamples, base.length);
    record.tipLongestRun = streaks(tipSamples, tip.length);
  }
  const unread = [
    ...(base.length === 0 ? ["no base run"] : []),
    ...(tip.length === 0 ? ["no tip run"] : []),
    ...base.flatMap((value, index) =>
      value === null ? [`base run ${index}`] : [],
    ),
    ...tip.flatMap((value, index) =>
      value === null ? [`tip run ${index}`] : [],
    ),
    ...record.baseLongestRun.flatMap((value, index) =>
      value === null ? [`base run ${index} samples`] : [],
    ),
    ...record.tipLongestRun.flatMap((value, index) =>
      value === null ? [`tip run ${index} samples`] : [],
    ),
  ];
  if (unread.length > 0) {
    record.status = CONTENTION_STATUS.UNREAD;
    record.reasons.push(
      `machine CPU not read for ${unread.join(", ")}: the contention guard cannot clear the statistic`,
    );
    return record;
  }
  record.armDeltaPct = Math.abs(record.tipMeanCpu - record.baseMeanCpu);
  const busy = [
    ...base.flatMap((value, index) =>
      value > resolved.contendedCpuPct ? [`base run ${index} ${value} %`] : [],
    ),
    ...tip.flatMap((value, index) =>
      value > resolved.contendedCpuPct ? [`tip run ${index} ${value} %`] : [],
    ),
  ];
  if (busy.length > 0) {
    record.status = CONTENTION_STATUS.CONTENDED;
    record.reasons.push(
      `mean machine CPU above ${resolved.contendedCpuPct} % on ${busy.join(", ")}`,
    );
  }
  if (record.armDeltaPct > resolved.cpuArmDeltaPct) {
    record.status = CONTENTION_STATUS.CONTENDED;
    record.reasons.push(
      `base and tip mean machine CPU differ by ${record.armDeltaPct} points (${record.baseMeanCpu} % against ${record.tipMeanCpu} %), more than ${resolved.cpuArmDeltaPct}`,
    );
  }
  const streaky = [
    ...record.baseLongestRun.flatMap((value, index) =>
      value >= resolved.contendedRunSamples
        ? [`base run ${index} (${value})`]
        : [],
    ),
    ...record.tipLongestRun.flatMap((value, index) =>
      value >= resolved.contendedRunSamples
        ? [`tip run ${index} (${value})`]
        : [],
    ),
  ];
  if (streaky.length > 0) {
    record.status = CONTENTION_STATUS.CONTENDED;
    record.reasons.push(
      `${resolved.contendedRunSamples} or more consecutive machine CPU samples above ${resolved.contendedCpuPct} % on ${streaky.join(", ")}`,
    );
  }
  return record;
}

/**
 * Apply a {@link contentionGuard} result to one statistic record, in place: a
 * clear guard leaves the verdict; a contended one makes it
 * `unmeasured-contended`, an unread one `unmeasured`, keeping what it would
 * have read as `verdictIfUncontended`. A record with no guard is returned
 * untouched (the metric was called without one).
 *
 * @param {object} record A {@link compareToBase} or {@link ceilingVerdict}
 *   record.
 * @param {object|null|undefined} guard
 * @returns {object} The same record.
 */
export function guardStatistic(record, guard) {
  if (!record || !guard) {
    return record;
  }
  record.contention = guard.status;
  if (guard.status === CONTENTION_STATUS.CLEAR) {
    return record;
  }
  record.verdictIfUncontended = record.verdict;
  record.verdict =
    guard.status === CONTENTION_STATUS.CONTENDED
      ? PERF_VERDICTS.UNMEASURED_CONTENDED
      : PERF_VERDICTS.UNMEASURED;
  record.reasons = [...(record.reasons ?? []), ...guard.reasons];
  return record;
}

/**
 * The worst of several verdicts: `over` beats `unmeasured-contended` beats
 * `unmeasured` beats `within`. An empty list is `unmeasured`.
 *
 * @param {Array<{verdict: string}|null|undefined>} records
 * @returns {string}
 */
export function worstVerdict(records) {
  const verdicts = (records ?? []).map((r) => r?.verdict);
  if (verdicts.length === 0) {
    return PERF_VERDICTS.UNMEASURED;
  }
  if (verdicts.includes(PERF_VERDICTS.OVER)) {
    return PERF_VERDICTS.OVER;
  }
  if (verdicts.includes(PERF_VERDICTS.UNMEASURED_CONTENDED)) {
    return PERF_VERDICTS.UNMEASURED_CONTENDED;
  }
  if (verdicts.every((v) => v === PERF_VERDICTS.WITHIN)) {
    return PERF_VERDICTS.WITHIN;
  }
  return PERF_VERDICTS.UNMEASURED;
}
