// perf-metric-vector.mjs -- the C11-170 multi-metric performance vector.
//
// @purpose Builds and adjudicates the C11-170 multi-metric resource-write vector - churn call counts, self time, wall-clock dispersion, allocation and memory - so that no performance verdict rests on one number.
// @status ACTIVE
//
// WHY THIS MODULE EXISTS (maintainer ruling, 2026-08-25). The C11-170 gate
// scored a re-upload regression on ONE number: the resource-write family's
// share of self time, against the frozen point bar 0.193. The clean-build
// control run that day showed that number moving roughly 2x between identical
// runs purely with idle share, because `pct` is a share of TOTAL sampled wall
// time including `(idle)` and `(program)` -- of which only about a quarter was
// named work. A single run against a point bar was noise-dominated well above
// the bar it was being compared to.
//
// The ruling is explicitly BOTH, not a replacement: Signal A stays exactly as
// it is, and the gate additionally carries counts, timings, allocation and
// memory, publishing every axis whether or not it is scored, with each metric's
// noise behaviour stated beside its bar. A disagreement between two axes is
// then a finding rather than an ambiguity.
//
// WHAT IS SCORED AND WHAT IS ONLY PUBLISHED. Two kinds of signal live here and
// the distinction is load-bearing:
//
//   magnitude     - a value is compared against a bar. Only M1 qualifies today,
//                   because only M1 has a bar that derives from the run's own
//                   trial count rather than from a frozen historical point.
//   observability - the axis must be MEASURABLE. A missing axis is STRUCTURAL,
//                   never a skip: a metric nobody can read is blindness, and
//                   blindness is what this row exists to remove.
//
// Every axis is published in full either way. Where a bar could be derived but
// is not fit to gate, the bound is recorded WITH the evidence that disqualifies
// it (see `dispersion.notFitToGateBecause`) instead of being quietly dropped.
//
// THIS MODULE IS PURE. It imports nothing, reads no file, and has no clock. The
// caller supplies the four banked producer reports and the freshness predicate.
// That is what lets the spec mutate it like any other predicate and lets teeth
// execute the real adjudicator rather than asserting on its source text.

/**
 * The resource-write family split by its STEADY-STATE expectation.
 *
 * The partition is not a taste call: it is read off the banked evidence. No
 * member of `texture` appears in either published top-self-time list of the
 * banked 2026-07-19 profile, and none appeared in the 2026-08-25 run either --
 * in a settled scene, image and texture uploads happen at load, not per frame,
 * so their steady-state count is zero and a non-zero count IS the Batch-717
 * re-upload storm. `buffer` writes are legitimately per-frame (uniforms), and
 * on 2026-08-25 `writeBuffer` was the sole family carrier at 0.534 % self time,
 * so a zero bar would be wrong for them.
 *
 * Union and disjointness against `RESOURCE_WRITE_FAMILY` are checked by
 * `metricBarViolations`, so the partition cannot silently drop a member the way
 * a hand-maintained second list would.
 */
export const RESOURCE_WRITE_SUBFAMILIES = Object.freeze({
  texture: Object.freeze([
    "copyExternalImageToTexture",
    "writeTexture",
    "copyBufferToTexture",
    "copyTextureToTexture",
    "createTexture",
    "texImage2D",
    "texSubImage2D",
    "texImage3D",
    "texSubImage3D",
    "compressedTexImage2D",
    "compressedTexSubImage2D",
    "texStorage2D",
    "uploadImageSource",
  ]),
  buffer: Object.freeze([
    "writeBuffer",
    "createBuffer",
    "bufferData",
    "bufferSubData",
  ]),
});

// The measured zero-count census exists: fixtures/c11-170/
// perf-metric-texture-call-rate-zero-census.json (90 frames, zero texture
// calls, twelve observable wrapped members, acquired on the pinned offline
// scene at the tip this value first shipped against). The bound is
// churnBound(fixture.frames, 3) - the rule-of-three ceiling over the run
// length the census actually measured - and the gate spec re-derives it from
// the checked-in fixture on every run, so this value cannot drift from its
// source without a red test. This module stays import-free on purpose, which
// is why the derivation is cross-checked rather than computed here.
export const M1_TEXTURE_CALLS_PER_FRAME_BOUND_PLACEHOLDER = churnBound(90, 3);

export const PERF_METRIC_BARS = Object.freeze({
  churn: Object.freeze({
    id: "M1",
    metric: "texture-write calls per frame",
    kind: "magnitude",
    scored: true,
    comparator: "<",
    numeratorSource: "PERF_GATE_BARS.ruleOfThree.numerator",
    derivation:
      "The steady-state expectation for the texture sub-family is zero calls per frame, so the bar is the same Rule-of-Three bound signals B and C already use: with 0 events observed in n measured frames the 95 % upper bound on the per-frame rate is numerator/n, with n read from the run. Nothing is frozen except the numerator the gate already froze, and no historical magnitude is involved -- which is exactly why this axis needs one run where a self-time share needs several.",
    sourceRows: Object.freeze([
      "cpu.webgpuTopSelfTime[]: no texture sub-family member is published (banked 2026-07-19)",
      "cpu.webglTopSelfTime[]: no texture sub-family member is published (banked 2026-07-19)",
      "backend.lanes[].resourceWrites.frames: n is the run's own measured-frame count",
    ]),
  }),
  normalizedSelfTime: Object.freeze({
    id: "M2",
    metric: "resource-write share of NAMED work, and self-time cost per frame",
    kind: "observability",
    scored: false,
    comparator: "published-not-scored",
    derivation:
      "namedWorkPct = 100 - idlePct - programPct, and familyShareOfNamedWorkPct = familySelfPct / namedWorkPct * 100. Signal A's `pct` is a share of total sampled wall time INCLUDING idle, so it moves when the machine goes quieter even though the work did not change. This axis removes that term. It is published and NOT scored because the banked profile's family share is 0, so no magnitude bar can be derived from it -- a bar would have to be chosen, and chosen numbers are what this repair exists to eliminate.",
    sourceRows: Object.freeze([
      "cpu.webgpuTopSelfTime[0].(idle) = 68.688 pct, [1].(program) = 16.417 pct -> namedWork 14.894999999999996 (banked 2026-07-19)",
      "cpu.webglTopSelfTime[0].(idle) = 69.111 pct, [1].(program) = 15.782 pct -> namedWork 15.106999999999996 (banked 2026-07-19)",
    ]),
  }),
  dispersion: Object.freeze({
    id: "M3",
    metric: "within-run wall-clock dispersion, p95 / median",
    kind: "observability",
    scored: false,
    comparator: "published-not-scored",
    provisionalMaxRatioInclusive: 1.9151785715284921,
    derivation:
      "Derived by the SAME construction the maintainer already ratified for Signal E: max(subject ratios) * (max(all) / min(all)). Subjects are the two banked backend-solo lanes (1.230769231017216 and 1.2857142859043516); the four request-probe lanes are derivation-only because they run a different requestRenderMode. max(all) = 1.833333333527359, min(all) = 1.230769231017216, so the bound is 1.2857142859043516 * 1.489583333190846 = 1.9151785715284921.",
    notFitToGateBecause:
      "The very next run reached 1.7499999627470975 on the WebGPU solo lane -- 91.4 % of a bound derived from n=1. A bar a clean re-run nearly breaches is not a bar. Publish it, do not gate on it, until there are at least three runs per arm (see PERF_METRIC_NOISE.rankTest).",
    sourceRows: Object.freeze([
      "backend.lanes[webgpu-solo].frameMs: median 1.2999999998137355, p95 1.6000000000931323 -> 1.230769231017216 (banked)",
      "backend.lanes[webgl-solo].frameMs: median 0.7000000001862645, p95 0.900000000372529 -> 1.2857142859043516 (banked)",
      "request.webgl.laneA.renderMs: median 1.1999999997206032, p95 2.1999999997206032 -> 1.833333333527359 (banked, derivation-only)",
      "request.webgpu.laneA.renderMs: 1.8181818180278806 (banked, derivation-only)",
      "request.webgpu.laneB.renderMs: 1.666666666839134 (banked, derivation-only)",
      "request.webgl.laneB.renderMs: 1.3333333328159318 (banked, derivation-only)",
    ]),
  }),
  allocation: Object.freeze({
    id: "M4",
    metric: "allocation pressure, from the profiler's garbage-collector row",
    kind: "observability",
    scored: false,
    comparator: "published-not-scored",
    derivation:
      "The V8 sampling profiler attributes self time to `(garbage collector)`, which is the only allocation observation this fleet already produces. Banked WebGPU: 4.645 ms over 120 frames = 0.03870833333333333 ms/frame at 0.193 pct. It is NOT scored: 0.193 is also the profile's visibility floor, so a `<` bar would red the banked run itself, and on 2026-08-25 the row fell out of the published top-20 entirely -- censored below 0.237 pct, i.e. below 0.04862... ms/frame, an upper bound ABOVE the banked value and therefore unable to discriminate. The axis is required to be UNCENSORED so that a magnitude bar becomes derivable later.",
    sourceRows: Object.freeze([
      "cpu.webgpuTopSelfTime[19].(garbage collector) = 0.193 pct / 4.645 ms over frames 120 (banked 2026-07-19)",
      "cpu.webglTopSelfTime: no (garbage collector) row -- censored below 0.208 pct (banked 2026-07-19)",
    ]),
  }),
  memory: Object.freeze({
    id: "M5",
    metric: "JS heap retained across the measured window",
    kind: "observability",
    scored: false,
    comparator: "published-not-scored",
    derivation:
      "No bar. The four banked reports contain no memory observation of any kind -- the frame-breakdown report has no heap, byte or allocation field, and neither profiler lane records one -- so a memory bar cannot be derived from banked evidence and must not be invented. The axis is sourced from the CDP session the CPU profiler already opens (Performance.getMetrics -> JSHeapUsedSize) and is required to be PRESENT so that the retention question stops being unanswerable.",
    sourceRows: Object.freeze([
      "cpu.*: no heap field in the banked report",
      "frame.*: no heap, byte or allocation field in the banked 838395-byte report",
    ]),
  }),
});

/**
 * Each metric's observed noise behaviour, stated beside its bar as the ruling
 * requires. `runsForVerdict` is DERIVED, not chosen -- see `rankTest`.
 */
export const PERF_METRIC_NOISE = Object.freeze({
  rankTest: Object.freeze({
    alpha: 0.05,
    minimumRunsPerArm: 3,
    derivation:
      "The self-time share has no known distribution, so the honest comparison between two build arms is a distribution-free rank test. A one-sided exact Wilcoxon-Mann-Whitney test over n and m observations cannot report a p-value below 1 / C(n+m, n) even under PERFECT separation. Requiring that minimum to reach alpha = 0.05 gives C(2k, k) >= 20, whose smallest solution is k = 3 (C(6,3) = 20, p = 0.05 exactly). Fewer than three runs per arm cannot produce a significant result no matter how large the effect.",
    todayControl:
      "The 2026-08-25 control ran n=2 clean against m=4 dirty. C(6,2) = 15, so its smallest achievable one-sided p-value was 0.06666666666666667 -- above alpha before a single number was looked at. The arms also overlapped almost entirely, but the design could not have decided the question either way.",
  }),
  selfTimeShare: Object.freeze({
    metric: "A-webgpu / A-webgl: resource-write share of TOTAL sampled time",
    claim: Object.freeze({
      figure: 1.8457350272232302,
      derivation:
        "max(controlArms[].familySelfPct) / min(controlArms[].familySelfPct)",
    }),
    behaviour:
      "Across the fixture's identical-run control arms, the resource-write share has a max/min spread of 1.8457350272232302. It includes (idle) and (program), so the total-time share is not stable enough to judge from one run.",
    evidence: Object.freeze([
      "2026-08-25 control arms, in reported order: 0.981, 0.831, 0.718 (dirty), then 1.017 (clean), 0.551 (dirty), 0.599 (clean). max/min = 1.8457350272232302.",
      "clean mean 0.8079999999999999 over n=2; dirty mean 0.77025 over n=4; the ranges overlap in both directions (dirty max 0.981 > clean min 0.599, clean max 1.017 > dirty min 0.551).",
      "Named work moved 1.7563611950318903x between the two ARTIFACT-BACKED profiles (banked namedWork 14.894999999999996 pct at 68.688 idle; 2026-08-25 namedWork 26.161 pct at 51.411 idle) while idle itself moved only 1.3360564859660384x.",
      "The profiler's own visibility floor moved with it: 0.193 banked, 0.237 on 2026-08-25, a factor of 1.2279792746113989 -- so the frozen bar is at or below the live floor on some runs.",
    ]),
    runsForVerdict:
      "At least 3 per arm, and only ever against a comparison arm -- never against a frozen point bar on a single run.",
  }),
  churnCounts: Object.freeze({
    metric: "M1: texture-write calls per frame",
    claim: Object.freeze({
      figure: 0,
      derivation:
        "count artifactBackedArms[] entries that carry a resourceWrites census",
    }),
    behaviour:
      "The noise fixture carries 0 artifact-backed churn-census observations, so it cannot yet characterise churn-count noise. The owed offline acquire run must supply that observation.",
    evidence: Object.freeze([
      "The Batch-717 defect was an ocean-normal texture re-uploaded every frame -- a per-frame COUNT of 1 where the steady-state count is 0. It survived two campaigns undetected while timing-based instruments looked at it.",
      "No texture sub-family member appears in either banked published top-self-time list, nor in the 2026-08-25 run: at the banked visibility floor the axis is unobservable in the time domain at all.",
    ]),
    runsForVerdict:
      "One run. The Rule-of-Three bound is computed from the run's own measured-frame count, so a single 90-frame lane bounds the per-frame rate at 3/90 = 0.03333333333333333 with no historical baseline.",
  }),
  dispersion: Object.freeze({
    metric: "M3: p95 / median wall-clock render time",
    claim: Object.freeze({
      figure: 0.9137528942538414,
      derivation:
        "dispersionBoundInstability.maxSubjectRatioLive / dispersionBoundInstability.boundFromBankedReports",
    }),
    behaviour:
      "The live maximum subject ratio consumed 0.9137528942538414 of the bound derived from the banked reports. That observed utilisation makes the one-run bound provisional rather than fit to gate.",
    evidence: Object.freeze([
      "banked backend lanes: 1.230769231017216 (webgpu-solo) and 1.2857142859043516 (webgl-solo).",
      "2026-08-25 backend lanes: 1.7499999627470975 (webgpu-solo) and 1.4666666587193806 (webgl-solo) -- 91.4 % and 76.6 % of a bound derived from the banked run alone.",
    ]),
    runsForVerdict:
      "One run to observe; at least 3 per arm before any bound is allowed to gate.",
  }),
  allocation: Object.freeze({
    metric: "M4: garbage-collector self time",
    claim: Object.freeze({
      figure: 1.2279792746113989,
      derivation:
        "max(artifactBackedArms[].visibilityFloorPct) / min(artifactBackedArms[].visibilityFloorPct)",
    }),
    behaviour:
      "The artifact-backed profile visibility floor moved by a factor of 1.2279792746113989 between observations. Allocation remains censored at that moving publication floor, so absence cannot be read as a measured zero.",
    evidence: Object.freeze([
      "banked WebGPU: 0.193 pct / 4.645 ms / 0.03870833333333333 ms per frame -- present, but exactly AT the visibility floor.",
      "banked WebGL: absent, censored below 0.208 pct.",
      "2026-08-25 WebGPU: absent, censored below 0.237 pct, i.e. below 0.04862... ms per frame -- an upper bound ABOVE the banked value, so the censored observation cannot discriminate at the banked level.",
    ]),
    runsForVerdict:
      "Not comparable until the producer publishes the row uncensored. That is why M4 is an observability signal today.",
  }),
  memory: Object.freeze({
    metric: "M5: JS heap used across the measured window",
    claim: Object.freeze({
      figure: 0,
      derivation:
        "count artifactBackedArms[] entries that carry any memory observation",
    }),
    behaviour:
      "The noise fixture carries 0 artifact-backed memory observations, so memory noise is unknown. The acquire run owes the first before/after heap observation.",
    evidence: Object.freeze([
      "No memory observation exists in any of the four banked reports.",
    ]),
    runsForVerdict:
      "Cannot be stated until the axis has been measured at least once. Stating one now would be a chosen number.",
  }),
});

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isFiniteNonNegative(value) {
  return Number.isFinite(value) && value >= 0;
}

function functionNameComponent(fn) {
  return fn.split(" @ ", 1)[0].split(".").at(-1);
}

/**
 * Percentile summary using the SAME quantile rule the producers use, so a
 * summary recomputed here is comparable with one the producer published.
 *
 * @param {number[]} values Raw samples.
 * @returns {object|null} `{n, median, p95, min, max, mean}` or null when empty.
 */
export function summarizeSeries(values) {
  if (!Array.isArray(values)) {
    return null;
  }
  const sorted = values
    .filter((value) => typeof value === "number" && Number.isFinite(value))
    .slice()
    .sort((a, b) => a - b);
  if (sorted.length === 0) {
    return null;
  }
  const quantile = (p) =>
    sorted[
      Math.min(
        sorted.length - 1,
        Math.max(0, Math.floor(p * (sorted.length - 1))),
      )
    ];
  return {
    n: sorted.length,
    median: quantile(0.5),
    p95: quantile(0.95),
    min: sorted[0],
    max: sorted[sorted.length - 1],
    mean: sorted.reduce((sum, value) => sum + value, 0) / sorted.length,
  };
}

/**
 * The Rule-of-Three per-frame bound for the churn axis.
 *
 * @param {number} frames Measured frames in the run.
 * @param {number} numerator The gate's frozen Rule-of-Three numerator.
 * @returns {number} The exclusive upper bound on the per-frame event rate.
 */
export function churnBound(frames, numerator) {
  if (!Number.isInteger(frames) || frames <= 0) {
    throw new RangeError(
      `churnBound requires a positive integer n, got ${frames}`,
    );
  }
  if (!Number.isInteger(numerator) || numerator <= 0) {
    throw new RangeError(
      `churnBound requires a positive integer numerator, got ${numerator}`,
    );
  }
  return numerator / frames;
}

function binomial(n, k) {
  if (!Number.isInteger(n) || !Number.isInteger(k) || k < 0 || k > n) {
    throw new RangeError(`binomial requires 0 <= k <= n, got ${k} of ${n}`);
  }
  let result = 1;
  for (let index = 1; index <= k; index++) {
    result = (result * (n - k + index)) / index;
  }
  return Math.round(result);
}

/**
 * The smallest one-sided p-value an exact rank test over two arms can report,
 * reached only under perfect separation.
 *
 * @param {number} n First arm size.
 * @param {number} m Second arm size.
 * @returns {number} 1 / C(n+m, n).
 */
export function minimumAchievablePValue(n, m) {
  return 1 / binomial(n + m, n);
}

/**
 * The smallest equal arm size at which an exact rank test can reach `alpha`.
 *
 * @param {number} alpha Significance level.
 * @param {number} [limit] Search ceiling, so a bad alpha cannot loop forever.
 * @returns {number} Runs required per arm.
 */
export function rankTestMinimumRunsPerArm(alpha, limit = 64) {
  if (!Number.isFinite(alpha) || alpha <= 0 || alpha >= 1) {
    throw new RangeError(
      `rankTestMinimumRunsPerArm requires 0 < alpha < 1, got ${alpha}`,
    );
  }
  for (let k = 1; k <= limit; k++) {
    if (minimumAchievablePValue(k, k) <= alpha) {
      return k;
    }
  }
  throw new RangeError(`no arm size up to ${limit} reaches alpha ${alpha}`);
}

function topSelfTimeRows(cpuReport, backend) {
  const rows = cpuReport?.[`${backend}TopSelfTime`];
  if (!Array.isArray(rows) || rows.length === 0) {
    return { reasons: [`${backend}TopSelfTime is absent or empty`] };
  }
  for (const [index, row] of rows.entries()) {
    if (
      !isPlainObject(row) ||
      typeof row.fn !== "string" ||
      !isFiniteNonNegative(row.pct)
    ) {
      return {
        reasons: [
          `${backend}TopSelfTime[${index}] lacks a string fn or finite non-negative pct`,
        ],
      };
    }
  }
  return { rows };
}

/**
 * The self-time axis: Signal A's scored share, plus the companions that make it
 * interpretable -- absolute cost, cost per frame, and the idle-free share.
 *
 * @param {object} cpuReport The cpu-sampling-profile report.
 * @param {string} backend `webgpu` or `webgl`.
 * @param {string[]} family The resource-write family.
 * @returns {object} The published self-time leaf.
 */
export function selfTimeMetrics(cpuReport, backend, family) {
  const read = topSelfTimeRows(cpuReport, backend);
  if (!read.rows) {
    return { available: false, reasons: read.reasons };
  }
  const rows = read.rows;
  const frames = cpuReport.frames;
  const members = new Set(family);
  const carriers = rows
    .filter((row) => members.has(functionNameComponent(row.fn)))
    .map((row) => ({ fn: row.fn, pct: row.pct, ms: row.ms ?? null }));
  const familySelfPct = carriers.reduce((sum, row) => sum + row.pct, 0);
  const familySelfMs = carriers.every((row) => isFiniteNonNegative(row.ms))
    ? carriers.reduce((sum, row) => sum + row.ms, 0)
    : null;
  const idleRow = rows.find(
    (row) => functionNameComponent(row.fn) === "(idle)",
  );
  const programRow = rows.find(
    (row) => functionNameComponent(row.fn) === "(program)",
  );
  const visibilityFloorPct = Math.min(...rows.map((row) => row.pct));
  const reasons = [];
  if (!idleRow) {
    reasons.push(`${backend}TopSelfTime publishes no (idle) row`);
  }
  if (!programRow) {
    reasons.push(`${backend}TopSelfTime publishes no (program) row`);
  }
  const namedWorkPct =
    idleRow && programRow ? 100 - idleRow.pct - programRow.pct : null;
  if (namedWorkPct !== null && !(namedWorkPct > 0)) {
    reasons.push(
      `${backend} named work resolves to ${namedWorkPct} pct, so the share cannot be normalised`,
    );
  }
  const normalisable = reasons.length === 0;
  return {
    available: normalisable,
    reasons,
    frames: Number.isInteger(frames) && frames > 0 ? frames : null,
    sampledTotalMs: cpuReport?.[backend]?.sampledTotalMs ?? null,
    familySelfPct,
    familySelfMs,
    familyMsPerFrame:
      familySelfMs !== null && Number.isInteger(frames) && frames > 0
        ? familySelfMs / frames
        : null,
    carriers,
    idlePct: idleRow ? idleRow.pct : null,
    programPct: programRow ? programRow.pct : null,
    namedWorkPct,
    familyShareOfNamedWorkPct: normalisable
      ? (familySelfPct / namedWorkPct) * 100
      : null,
    visibilityFloorPct,
    visibilityFloorNormalizedPct: normalisable
      ? (visibilityFloorPct / namedWorkPct) * 100
      : null,
  };
}

/**
 * The allocation axis, and whether the producer censored it.
 *
 * @param {object} cpuReport The cpu-sampling-profile report.
 * @param {string} backend `webgpu` or `webgl`.
 * @returns {object} The published allocation leaf.
 */
export function allocationMetrics(cpuReport, backend) {
  const read = topSelfTimeRows(cpuReport, backend);
  if (!read.rows) {
    return { available: false, censored: null, reasons: read.reasons };
  }
  const rows = read.rows;
  const frames = cpuReport.frames;
  const perFrame = (ms) =>
    isFiniteNonNegative(ms) && Number.isInteger(frames) && frames > 0
      ? ms / frames
      : null;
  const floorPct = Math.min(...rows.map((row) => row.pct));
  // The producer's explicit, uncensored publication wins when it is present.
  const published = cpuReport?.[backend]?.allocation;
  if (
    isPlainObject(published) &&
    isFiniteNonNegative(published.gcSelfMs) &&
    isFiniteNonNegative(published.gcSelfPct)
  ) {
    return {
      available: true,
      censored: false,
      reasons: [],
      source: "producer-allocation-field",
      gcSelfMs: published.gcSelfMs,
      gcSelfPct: published.gcSelfPct,
      gcMsPerFrame: perFrame(published.gcSelfMs),
      censoringFloorPct: floorPct,
      upperBoundPct: null,
      upperBoundMsPerFrame: null,
    };
  }
  const gcRow = rows.find(
    (row) => functionNameComponent(row.fn) === "(garbage collector)",
  );
  if (gcRow) {
    return {
      available: true,
      censored: false,
      reasons: [],
      source: "published-top-row",
      gcSelfMs: isFiniteNonNegative(gcRow.ms) ? gcRow.ms : null,
      gcSelfPct: gcRow.pct,
      gcMsPerFrame: perFrame(gcRow.ms),
      censoringFloorPct: floorPct,
      upperBoundPct: null,
      upperBoundMsPerFrame: null,
    };
  }
  const sampledTotalMs = cpuReport?.[backend]?.sampledTotalMs;
  const upperBoundMs = isFiniteNonNegative(sampledTotalMs)
    ? (floorPct / 100) * sampledTotalMs
    : null;
  return {
    available: false,
    censored: true,
    reasons: [
      `${backend} publishes no (garbage collector) row and no allocation field, so allocation is censored below the ${floorPct} pct visibility floor`,
    ],
    source: "censored",
    gcSelfMs: null,
    gcSelfPct: null,
    gcMsPerFrame: null,
    censoringFloorPct: floorPct,
    upperBoundPct: floorPct,
    upperBoundMsPerFrame: perFrame(upperBoundMs),
  };
}

/**
 * The memory axis. Absent is blindness, not a skip.
 *
 * @param {object} cpuReport The cpu-sampling-profile report.
 * @param {string} backend `webgpu` or `webgl`.
 * @returns {object} The published memory leaf.
 */
export function memoryMetrics(cpuReport, backend) {
  const memory = cpuReport?.[backend]?.memory;
  if (!isPlainObject(memory)) {
    return {
      available: false,
      reasons: [
        `${backend}.memory is absent: no banked report in this fleet carries a heap observation`,
      ],
    };
  }
  const before = memory.jsHeapUsedBytesBefore;
  const after = memory.jsHeapUsedBytesAfter;
  const reasons = [];
  if (!isFiniteNonNegative(before)) {
    reasons.push(
      `${backend}.memory.jsHeapUsedBytesBefore is absent or invalid`,
    );
  }
  if (!isFiniteNonNegative(after)) {
    reasons.push(`${backend}.memory.jsHeapUsedBytesAfter is absent or invalid`);
  }
  if (reasons.length > 0) {
    return { available: false, reasons };
  }
  const frames = cpuReport.frames;
  return {
    available: true,
    reasons: [],
    jsHeapUsedBytesBefore: before,
    jsHeapUsedBytesAfter: after,
    deltaBytes: after - before,
    deltaBytesPerFrame:
      Number.isInteger(frames) && frames > 0 ? (after - before) / frames : null,
    jsHeapTotalBytesAfter: isFiniteNonNegative(memory.jsHeapTotalBytesAfter)
      ? memory.jsHeapTotalBytesAfter
      : null,
    note: "a before/after pair is a BOUND on retention, not a rate: collection is not synchronous with the measured window",
  };
}

/**
 * The churn axis: how many resource-write calls each measured frame made.
 *
 * @param {object} backendReport The backend-isolation report.
 * @param {string} backend `webgpu` or `webgl`.
 * @returns {object} The published churn leaf.
 */
export function churnMetrics(backendReport, backend) {
  const lanes = backendReport?.lanes;
  if (!Array.isArray(lanes)) {
    return {
      available: false,
      reasons: ["backend.lanes is absent or malformed"],
    };
  }
  const laneName = `${backend}-solo`;
  const lane = lanes.find((entry) => entry?.name === laneName);
  if (!isPlainObject(lane)) {
    return {
      available: false,
      reasons: [`backend lane ${laneName} is absent`],
    };
  }
  const census = lane.resourceWrites;
  if (!isPlainObject(census)) {
    return {
      available: false,
      reasons: [
        `${laneName}.resourceWrites is absent: the resource-write census has never been run, so the churn axis is unmeasured`,
      ],
    };
  }
  const wrapped = Array.isArray(census.wrapped) ? census.wrapped : [];
  const unwrappable = Array.isArray(census.unwrappable)
    ? census.unwrappable
    : [];
  const wrappedNames = new Set(
    wrapped
      .filter((entry) => typeof entry === "string")
      .map(functionNameComponent),
  );
  const unwrappableNames = new Set(
    unwrappable
      .filter((entry) => typeof entry === "string")
      .map(functionNameComponent),
  );
  const wrappedTextureMembers = RESOURCE_WRITE_SUBFAMILIES.texture.filter(
    (name) => wrappedNames.has(name),
  );
  const unwrappableTextureMembers = RESOURCE_WRITE_SUBFAMILIES.texture.filter(
    (name) => unwrappableNames.has(name),
  );
  const reasons = [];
  const frames = census.frames;
  if (!Number.isInteger(frames) || frames <= 0) {
    reasons.push(`${laneName}.resourceWrites.frames is absent or not positive`);
  }
  const textureFramesNonZero = census.textureFramesNonZero;
  if (
    !Number.isInteger(textureFramesNonZero) ||
    textureFramesNonZero < 0 ||
    (Number.isInteger(frames) && textureFramesNonZero > frames)
  ) {
    reasons.push(
      `${laneName}.resourceWrites.textureFramesNonZero is absent or out of range`,
    );
  }
  if (!isFiniteNonNegative(census.textureCallsTotal)) {
    reasons.push(`${laneName}.resourceWrites.textureCallsTotal is absent`);
  }
  if (!isFiniteNonNegative(census.bufferCallsTotal)) {
    reasons.push(`${laneName}.resourceWrites.bufferCallsTotal is absent`);
  }
  if (wrappedTextureMembers.length === 0) {
    reasons.push(
      `${laneName}.resourceWrites wrapped no texture sub-family member: the churn census is instrument-blind even if it reports a zero rate`,
    );
  }
  if (reasons.length > 0) {
    return {
      available: false,
      reasons,
      wrapped,
      unwrappable,
      wrappedTextureMembers,
      unwrappableTextureMembers,
    };
  }
  const bufferSeries = Array.isArray(census.bufferPerFrame)
    ? census.bufferPerFrame
    : null;
  return {
    available: true,
    reasons: [],
    frames,
    textureCallsTotal: census.textureCallsTotal,
    textureFramesNonZero,
    textureCallsPerFrame: census.textureCallsTotal / frames,
    bufferCallsTotal: census.bufferCallsTotal,
    bufferCallsPerFrame: census.bufferCallsTotal / frames,
    bufferPerFrameSummary: bufferSeries ? summarizeSeries(bufferSeries) : null,
    totals: isPlainObject(census.totals) ? census.totals : null,
    wrapped,
    unwrappable,
    wrappedTextureMembers,
    unwrappableTextureMembers,
    bufferBarNote:
      "buffer writes are legitimately per-frame and are PUBLISHED, not scored: no bar for them is derivable from banked evidence",
  };
}

const DISPERSION_SUBJECT_LANES = Object.freeze(["webgpu-solo", "webgl-solo"]);

/**
 * The wall-clock dispersion axis, from every lane the fleet already publishes.
 *
 * @param {object} backendReport The backend-isolation report.
 * @param {object} requestReport The request-render-asymmetry report.
 * @returns {object} The published dispersion leaf.
 */
export function dispersionMetrics(backendReport, requestReport) {
  const observations = [];
  const reasons = [];
  const lanes = backendReport?.lanes;
  if (!Array.isArray(lanes)) {
    reasons.push("backend.lanes is absent or malformed");
  } else {
    for (const name of DISPERSION_SUBJECT_LANES) {
      const lane = lanes.find((entry) => entry?.name === name);
      const frameMs = lane?.frameMs;
      if (
        !isPlainObject(frameMs) ||
        !isFiniteNonNegative(frameMs.median) ||
        !isFiniteNonNegative(frameMs.p95) ||
        !(frameMs.median > 0)
      ) {
        reasons.push(
          `backend lane ${name} publishes no usable frameMs summary`,
        );
        continue;
      }
      observations.push({
        source: `backend.lanes[${name}].frameMs`,
        subject: true,
        n: frameMs.n ?? null,
        median: frameMs.median,
        p95: frameMs.p95,
        ratio: frameMs.p95 / frameMs.median,
      });
    }
  }
  for (const backend of ["webgpu", "webgl"]) {
    for (const laneKey of ["laneA", "laneB"]) {
      const series = requestReport?.[backend]?.[laneKey]?.renderMs;
      const summary = summarizeSeries(series);
      if (!summary || !(summary.median > 0)) {
        continue;
      }
      observations.push({
        source: `request.${backend}.${laneKey}.renderMs`,
        subject: false,
        n: summary.n,
        median: summary.median,
        p95: summary.p95,
        ratio: summary.p95 / summary.median,
      });
    }
  }
  const subjects = observations.filter((entry) => entry.subject);
  if (subjects.length === 0) {
    reasons.push("no subject lane produced a dispersion observation");
  }
  if (reasons.length > 0) {
    return { available: false, reasons, observations };
  }
  const maxSubjectRatio = Math.max(...subjects.map((entry) => entry.ratio));
  const bound = PERF_METRIC_BARS.dispersion.provisionalMaxRatioInclusive;
  return {
    available: true,
    reasons: [],
    observations,
    maxSubjectRatio,
    provisionalBound: bound,
    provisionalBoundUtilisation: maxSubjectRatio / bound,
    scored: false,
    note: PERF_METRIC_BARS.dispersion.notFitToGateBecause,
  };
}

/**
 * The whole vector: every axis, published whether or not it is scored.
 *
 * @param {object} reports The four banked producer reports.
 * @param {string[]} family The resource-write family.
 * @returns {object} The published metric vector.
 */
export function metricVector(reports, family) {
  const cpu = reports?.cpu;
  const backendReport = reports?.backend;
  const requestReport = reports?.request;
  return {
    churn: {
      webgpu: churnMetrics(backendReport, "webgpu"),
      webgl: churnMetrics(backendReport, "webgl"),
      subfamilies: RESOURCE_WRITE_SUBFAMILIES,
    },
    selfTime: {
      webgpu: selfTimeMetrics(cpu, "webgpu", family),
      webgl: selfTimeMetrics(cpu, "webgl", family),
    },
    dispersion: dispersionMetrics(backendReport, requestReport),
    allocation: {
      webgpu: allocationMetrics(cpu, "webgpu"),
      webgl: allocationMetrics(cpu, "webgl"),
    },
    memory: {
      webgpu: memoryMetrics(cpu, "webgpu"),
      webgl: memoryMetrics(cpu, "webgl"),
    },
  };
}

/**
 * Re-derive every NEW bar from the banked reports it claims to come from, and
 * name each disagreement. Same contract as the gate's `derivationViolations`:
 * a pure function of its arguments so a mutant of it is detectable, and it
 * reads no file so no run's leftovers can satisfy it.
 *
 * @param {object} reports The four banked producer reports.
 * @param {object} [bars] Metric bar table to check.
 * @param {object} [subfamilies] Sub-family partition to check.
 * @param {string[]} [family] The resource-write family the partition covers.
 * @returns {string[]} One sentence per disagreement, empty when every bar holds.
 */
export function metricBarViolations(
  reports,
  bars = PERF_METRIC_BARS,
  subfamilies = RESOURCE_WRITE_SUBFAMILIES,
  family = null,
) {
  const violations = [];

  // M1: the partition must cover the family exactly, with no member in both
  // halves and none dropped.
  if (Array.isArray(family)) {
    const union = [...subfamilies.texture, ...subfamilies.buffer];
    const unionSet = new Set(union);
    if (union.length !== unionSet.size) {
      violations.push("M1: the sub-family partition repeats a member");
    }
    const missing = family.filter((name) => !unionSet.has(name));
    if (missing.length > 0) {
      violations.push(
        `M1: the sub-family partition drops ${JSON.stringify(missing)} from the resource-write family`,
      );
    }
    const extra = union.filter((name) => !family.includes(name));
    if (extra.length > 0) {
      violations.push(
        `M1: the sub-family partition invents ${JSON.stringify(extra)}, which is not in the resource-write family`,
      );
    }
  }

  // M1: the texture half's steady-state expectation is zero, and the banked
  // profile is what says so -- no texture member is published on either lane.
  for (const backend of ["webgpu", "webgl"]) {
    const rows = reports?.cpu?.[`${backend}TopSelfTime`];
    if (!Array.isArray(rows)) {
      violations.push(`M1: cpu.${backend}TopSelfTime is absent`);
      continue;
    }
    const present = rows
      .map((row) => functionNameComponent(String(row?.fn ?? "")))
      .filter((name) => subfamilies.texture.includes(name));
    if (present.length > 0) {
      violations.push(
        `M1: the banked ${backend} profile publishes texture-write ${JSON.stringify(present)}, so zero is not its steady state`,
      );
    }
  }

  // M2: the normalisation must be computable on both banked lanes, or the
  // companion the ruling asked for is not actually available.
  for (const backend of ["webgpu", "webgl"]) {
    const leaf = selfTimeMetrics(reports?.cpu, backend, family ?? []);
    if (!leaf.available) {
      violations.push(
        `M2: the banked ${backend} profile cannot be normalised: ${leaf.reasons.join("; ")}`,
      );
    }
  }

  // M3: the provisional bound must still be max(subjects) scaled by the spread
  // across every banked observation, using the Signal E construction verbatim.
  const dispersion = dispersionMetrics(reports?.backend, reports?.request);
  if (!dispersion.available) {
    violations.push(
      `M3: the banked reports produce no dispersion observations: ${dispersion.reasons.join("; ")}`,
    );
  } else {
    const all = dispersion.observations.map((entry) => entry.ratio);
    const subjects = dispersion.observations
      .filter((entry) => entry.subject)
      .map((entry) => entry.ratio);
    const derived =
      Math.max(...subjects) * (Math.max(...all) / Math.min(...all));
    if (bars.dispersion.provisionalMaxRatioInclusive !== derived) {
      violations.push(
        `M3: bound ${bars.dispersion.provisionalMaxRatioInclusive} is not max(subjects) scaled by the observed spread ${derived}`,
      );
    }
    if (bars.dispersion.scored !== false) {
      violations.push(
        "M3: the provisional bound is marked scored, but a bound the next run reached 91 % of cannot gate",
      );
    }
  }

  // M4: the banked WebGPU allocation observation is what the derivation cites,
  // and it must still sit exactly at the visibility floor -- that is the whole
  // reason the axis is published rather than scored.
  const allocation = allocationMetrics(reports?.cpu, "webgpu");
  if (!allocation.available) {
    violations.push(
      `M4: the banked WebGPU allocation observation is gone: ${allocation.reasons.join("; ")}`,
    );
  } else if (allocation.gcSelfPct !== allocation.censoringFloorPct) {
    violations.push(
      `M4: the banked GC row sits at ${allocation.gcSelfPct} pct, no longer at the ${allocation.censoringFloorPct} pct visibility floor the derivation cites`,
    );
  }

  // M5: the derivation's whole claim is that no banked report carries memory.
  for (const backend of ["webgpu", "webgl"]) {
    if (memoryMetrics(reports?.cpu, backend).available) {
      violations.push(
        `M5: the banked ${backend} profile now carries a heap observation, so "no bar is derivable" is stale`,
      );
    }
  }

  return violations;
}

function bindNoiseClaim(violations, key, entry, recomputedFigure, derivation) {
  const claimedFigure = entry?.claim?.figure;
  const figureMatches = Object.is(claimedFigure, recomputedFigure);
  const behaviourQuotes =
    typeof entry?.behaviour === "string" &&
    entry.behaviour.includes(String(recomputedFigure));
  if (!figureMatches || !behaviourQuotes) {
    violations.push(
      `${key}: claim figure ${String(claimedFigure)} must equal the fixture-derived ${String(recomputedFigure)} (${derivation}), and behaviour must quote that figure`,
    );
  }
}

/**
 * Re-derive the published noise characterisation from the checked-in control
 * observations, so the noise claims are mutation-testable rather than prose.
 *
 * @param {object} fixture The noise fixture.
 * @param {object} [noise] The noise table to check.
 * @returns {string[]} One sentence per disagreement, empty when every claim holds.
 */
export function noiseViolations(fixture, noise = PERF_METRIC_NOISE) {
  const violations = [];
  const observations = fixture?.controlArms;
  if (!Array.isArray(observations) || observations.length === 0) {
    return ["noise: the fixture publishes no control arms"];
  }
  const values = observations.map((entry) => entry.familySelfPct);
  if (values.some((value) => !Number.isFinite(value))) {
    return ["noise: a control arm carries a non-numeric observation"];
  }
  const clean = observations
    .filter((entry) => entry.tree === "clean")
    .map((entry) => entry.familySelfPct);
  const dirty = observations
    .filter((entry) => entry.tree === "dirty")
    .map((entry) => entry.familySelfPct);
  const mean = (list) =>
    list.reduce((sum, value) => sum + value, 0) / list.length;
  const derived = fixture.derived ?? {};

  if (clean.length === 0 || dirty.length === 0) {
    violations.push("noise: the control arms do not form two arms");
  } else {
    if (derived.cleanMean !== mean(clean)) {
      violations.push(
        `noise: recorded cleanMean ${derived.cleanMean} is not the arm mean ${mean(clean)}`,
      );
    }
    if (derived.dirtyMean !== mean(dirty)) {
      violations.push(
        `noise: recorded dirtyMean ${derived.dirtyMean} is not the arm mean ${mean(dirty)}`,
      );
    }
    const overlap =
      Math.max(...dirty) > Math.min(...clean) &&
      Math.max(...clean) > Math.min(...dirty);
    if (derived.armsOverlap !== overlap) {
      violations.push(
        `noise: recorded armsOverlap ${derived.armsOverlap} is not the observed ${overlap}`,
      );
    }
    const achievable = minimumAchievablePValue(clean.length, dirty.length);
    if (derived.minimumAchievablePValue !== achievable) {
      violations.push(
        `noise: recorded minimumAchievablePValue ${derived.minimumAchievablePValue} is not 1/C(${clean.length + dirty.length}, ${clean.length}) = ${achievable}`,
      );
    }
    if (!(achievable > noise.rankTest.alpha)) {
      violations.push(
        `noise: the recorded control could reach alpha ${noise.rankTest.alpha}, so the design claim is stale`,
      );
    }
  }

  const spread = Math.max(...values) / Math.min(...values);
  if (derived.spreadRatio !== spread) {
    violations.push(
      `noise: recorded spreadRatio ${derived.spreadRatio} is not max/min ${spread}`,
    );
  }
  // The ABSOLUTE cost is checked as well as the share. If only the share were
  // recorded, a reader could conclude that normalising by named work is the
  // whole fix; the ms observations show the raw cost swinging just as far.
  const msValues = Array.isArray(fixture.familySelfMsObservations)
    ? fixture.familySelfMsObservations.map((entry) => entry.writeBufferMs)
    : [];
  if (
    msValues.length === 0 ||
    msValues.some((value) => !Number.isFinite(value))
  ) {
    violations.push(
      "noise: the fixture publishes no absolute self-time observations",
    );
  } else {
    const msSwing = Math.max(...msValues) / Math.min(...msValues);
    if (derived.msSwingRatio !== msSwing) {
      violations.push(
        `noise: recorded msSwingRatio ${derived.msSwingRatio} is not max/min ${msSwing}`,
      );
    }
  }

  const artifactBackedArms = Array.isArray(fixture?.artifactBackedArms)
    ? fixture.artifactBackedArms
    : [];
  const churnObservationCount = artifactBackedArms.filter((entry) =>
    Object.hasOwn(entry ?? {}, "resourceWrites"),
  ).length;
  const dispersionEvidence = fixture?.dispersionBoundInstability;
  const dispersionUtilisation =
    Number.isFinite(dispersionEvidence?.maxSubjectRatioLive) &&
    Number.isFinite(dispersionEvidence?.boundFromBankedReports) &&
    dispersionEvidence.boundFromBankedReports > 0
      ? dispersionEvidence.maxSubjectRatioLive /
        dispersionEvidence.boundFromBankedReports
      : null;
  const visibilityFloors = artifactBackedArms
    .map((entry) => entry?.visibilityFloorPct)
    .filter((value) => Number.isFinite(value) && value > 0);
  const visibilityFloorRatio =
    visibilityFloors.length > 0
      ? Math.max(...visibilityFloors) / Math.min(...visibilityFloors)
      : null;
  const memoryObservationCount = artifactBackedArms.filter((entry) =>
    [
      "memory",
      "jsHeapUsedBytesBefore",
      "jsHeapUsedBytesAfter",
      "jsHeapTotalBytesAfter",
    ].some((key) => Object.hasOwn(entry ?? {}, key)),
  ).length;
  for (const [key, recomputedFigure, derivation] of [
    [
      "selfTimeShare",
      spread,
      "max(controlArms[].familySelfPct) / min(controlArms[].familySelfPct)",
    ],
    [
      "churnCounts",
      churnObservationCount,
      "artifact-backed churn-census observation count",
    ],
    [
      "dispersion",
      dispersionUtilisation,
      "live maximum subject ratio / banked bound",
    ],
    [
      "allocation",
      visibilityFloorRatio,
      "max/min artifact-backed visibility floor",
    ],
    [
      "memory",
      memoryObservationCount,
      "artifact-backed memory-observation count",
    ],
  ]) {
    bindNoiseClaim(violations, key, noise?.[key], recomputedFigure, derivation);
  }
  const requiredRuns = rankTestMinimumRunsPerArm(noise.rankTest.alpha);
  if (noise.rankTest.minimumRunsPerArm !== requiredRuns) {
    violations.push(
      `noise: minimumRunsPerArm ${noise.rankTest.minimumRunsPerArm} is not the smallest arm size reaching alpha ${noise.rankTest.alpha}, which is ${requiredRuns}`,
    );
  }
  return violations;
}

function metricSignal({
  id,
  metric,
  kind,
  probe,
  fieldPaths,
  observed = null,
  bar = null,
  comparator = null,
  verdict,
  reason,
  noise = null,
}) {
  return {
    id,
    metric,
    kind,
    probe,
    fieldPaths,
    observed,
    bar,
    comparator,
    verdict,
    reason,
    ...(noise === null ? {} : { noise }),
  };
}

function structuralMetricSignal(base, reason) {
  return metricSignal({ ...base, verdict: "STRUCTURAL", reason });
}

/**
 * Adjudicate every metric axis. Absent evidence is STRUCTURAL, never a skip.
 *
 * @param {object} input The gate input, plus a prebuilt `vector`.
 * @param {object} options `{reportProblem, ruleOfThreeNumerator}`.
 * @returns {object[]} One signal per axis and backend.
 */
export function adjudicateMetricVector(input, options) {
  const reportProblem = options?.reportProblem ?? (() => null);
  const numerator = options?.ruleOfThreeNumerator;
  const vector = input?.vector ?? metricVector(input?.reports ?? {}, []);
  const signals = [];

  for (const backend of ["webgpu", "webgl"]) {
    const base = {
      id: `M1-${backend}`,
      metric: PERF_METRIC_BARS.churn.metric,
      kind: PERF_METRIC_BARS.churn.kind,
      probe: "probe-backend-isolation.mjs",
      fieldPaths: [
        `lanes[${backend}-solo].resourceWrites.frames`,
        `lanes[${backend}-solo].resourceWrites.textureFramesNonZero`,
        `lanes[${backend}-solo].resourceWrites.textureCallsTotal`,
        `lanes[${backend}-solo].resourceWrites.bufferCallsTotal`,
        `lanes[${backend}-solo].resourceWrites.wrapped`,
        `lanes[${backend}-solo].resourceWrites.unwrappable`,
      ],
      noise: PERF_METRIC_NOISE.churnCounts.behaviour,
    };
    const leaf = vector.churn?.[backend];
    const coverage = {
      wrapped: leaf?.wrapped ?? [],
      unwrappable: leaf?.unwrappable ?? [],
      wrappedTextureMembers: leaf?.wrappedTextureMembers ?? [],
      unwrappableTextureMembers: leaf?.unwrappableTextureMembers ?? [],
    };
    const problem = reportProblem("backend");
    if (problem) {
      signals.push(
        structuralMetricSignal({ ...base, observed: coverage }, problem),
      );
      continue;
    }
    if (!leaf?.available) {
      signals.push(
        structuralMetricSignal(
          { ...base, observed: coverage },
          (leaf?.reasons ?? ["the churn axis produced no leaf"]).join("; "),
        ),
      );
      continue;
    }
    if (!Number.isInteger(numerator) || numerator <= 0) {
      signals.push(
        structuralMetricSignal(
          { ...base, observed: coverage },
          `the Rule-of-Three numerator was not supplied, so the bound cannot be derived from the run (got ${String(numerator)})`,
        ),
      );
      continue;
    }
    const rate = leaf.textureCallsPerFrame;
    const observed = {
      textureFramesNonZero: leaf.textureFramesNonZero,
      frames: leaf.frames,
      rate,
      textureCallsPerFrame: leaf.textureCallsPerFrame,
      bufferCallsPerFrame: leaf.bufferCallsPerFrame,
      ...coverage,
    };
    // The authorization record is the census-derived constant; the live bound
    // derives from THIS run's own frame count, per the Rule-of-Three shape:
    // a three-frame run tolerates two event frames, a ninety-frame run
    // tolerates two, and the ceiling scales with what was actually measured.
    const bound =
      M1_TEXTURE_CALLS_PER_FRAME_BOUND_PLACEHOLDER === null
        ? null
        : churnBound(leaf.frames, numerator);
    if (bound === null) {
      signals.push(
        structuralMetricSignal(
          { ...base, observed },
          "the measured texture-call-rate bound is unresolved: the owed offline acquire run has not supplied an immutable zero-count census fixture",
        ),
      );
      continue;
    }
    const pass = rate < bound;
    signals.push(
      metricSignal({
        ...base,
        observed,
        bar: bound,
        comparator: PERF_METRIC_BARS.churn.comparator,
        verdict: pass ? "PASS" : "FAIL",
        reason: `${leaf.textureCallsTotal}/${leaf.frames} = ${rate} texture-write calls per frame; measured call-rate bound is ${bound}`,
      }),
    );
  }

  for (const backend of ["webgpu", "webgl"]) {
    const base = {
      id: `M2-${backend}`,
      metric: PERF_METRIC_BARS.normalizedSelfTime.metric,
      kind: PERF_METRIC_BARS.normalizedSelfTime.kind,
      probe: "probe-cpu-sampling-profile.mjs",
      fieldPaths: [
        `${backend}TopSelfTime[]{fn,pct,ms}`,
        "frames",
        `${backend}.sampledTotalMs`,
      ],
      noise: PERF_METRIC_NOISE.selfTimeShare.behaviour,
    };
    const problem = reportProblem("cpu");
    if (problem) {
      signals.push(structuralMetricSignal(base, problem));
      continue;
    }
    const leaf = vector.selfTime?.[backend];
    if (!leaf?.available) {
      signals.push(
        structuralMetricSignal(
          base,
          (leaf?.reasons ?? ["the self-time axis produced no leaf"]).join("; "),
        ),
      );
      continue;
    }
    signals.push(
      metricSignal({
        ...base,
        observed: {
          familySelfPct: leaf.familySelfPct,
          familySelfMs: leaf.familySelfMs,
          familyMsPerFrame: leaf.familyMsPerFrame,
          idlePct: leaf.idlePct,
          programPct: leaf.programPct,
          namedWorkPct: leaf.namedWorkPct,
          familyShareOfNamedWorkPct: leaf.familyShareOfNamedWorkPct,
          visibilityFloorPct: leaf.visibilityFloorPct,
          visibilityFloorNormalizedPct: leaf.visibilityFloorNormalizedPct,
          carriers: leaf.carriers,
        },
        bar: null,
        comparator: PERF_METRIC_BARS.normalizedSelfTime.comparator,
        verdict: "PASS",
        reason: `the idle-free companion to Signal A is observable: family ${leaf.familySelfPct} pct of total is ${leaf.familyShareOfNamedWorkPct} pct of the ${leaf.namedWorkPct} pct that is named work`,
      }),
    );
  }

  {
    const base = {
      id: "M3",
      metric: PERF_METRIC_BARS.dispersion.metric,
      kind: PERF_METRIC_BARS.dispersion.kind,
      probe: "probe-backend-isolation.mjs + probe-request-render-asymmetry.mjs",
      fieldPaths: [
        "backend.lanes[].frameMs{median,p95}",
        "request.*.laneA.renderMs",
        "request.*.laneB.renderMs",
      ],
      noise: PERF_METRIC_NOISE.dispersion.behaviour,
    };
    const problem = reportProblem("backend") ?? reportProblem("request");
    if (problem) {
      signals.push(structuralMetricSignal(base, problem));
    } else {
      const leaf = vector.dispersion;
      if (!leaf?.available) {
        signals.push(
          structuralMetricSignal(
            base,
            (leaf?.reasons ?? ["the dispersion axis produced no leaf"]).join(
              "; ",
            ),
          ),
        );
      } else {
        signals.push(
          metricSignal({
            ...base,
            observed: {
              maxSubjectRatio: leaf.maxSubjectRatio,
              provisionalBoundUtilisation: leaf.provisionalBoundUtilisation,
              observations: leaf.observations,
            },
            bar: leaf.provisionalBound,
            comparator: PERF_METRIC_BARS.dispersion.comparator,
            verdict: "PASS",
            reason: `dispersion is observable: max subject ratio ${leaf.maxSubjectRatio} against a PROVISIONAL, unscored bound ${leaf.provisionalBound} (${leaf.provisionalBoundUtilisation} of it). ${PERF_METRIC_BARS.dispersion.notFitToGateBecause}`,
          }),
        );
      }
    }
  }

  for (const backend of ["webgpu", "webgl"]) {
    const base = {
      id: `M4-${backend}`,
      metric: PERF_METRIC_BARS.allocation.metric,
      kind: PERF_METRIC_BARS.allocation.kind,
      probe: "probe-cpu-sampling-profile.mjs",
      fieldPaths: [
        `${backend}.allocation{gcSelfMs,gcSelfPct}`,
        `${backend}TopSelfTime[](garbage collector)`,
      ],
      noise: PERF_METRIC_NOISE.allocation.behaviour,
    };
    const problem = reportProblem("cpu");
    if (problem) {
      signals.push(structuralMetricSignal(base, problem));
      continue;
    }
    const leaf = vector.allocation?.[backend];
    if (!leaf?.available) {
      signals.push(
        structuralMetricSignal(
          base,
          (leaf?.reasons ?? ["the allocation axis produced no leaf"]).join(
            "; ",
          ),
        ),
      );
      continue;
    }
    signals.push(
      metricSignal({
        ...base,
        observed: {
          source: leaf.source,
          gcSelfPct: leaf.gcSelfPct,
          gcSelfMs: leaf.gcSelfMs,
          gcMsPerFrame: leaf.gcMsPerFrame,
          censoringFloorPct: leaf.censoringFloorPct,
        },
        bar: null,
        comparator: PERF_METRIC_BARS.allocation.comparator,
        verdict: "PASS",
        reason: `allocation is observable from ${leaf.source}: ${leaf.gcSelfPct} pct, ${leaf.gcMsPerFrame} ms per frame. Published, not scored`,
      }),
    );
  }

  for (const backend of ["webgpu", "webgl"]) {
    const base = {
      id: `M5-${backend}`,
      metric: PERF_METRIC_BARS.memory.metric,
      kind: PERF_METRIC_BARS.memory.kind,
      probe: "probe-cpu-sampling-profile.mjs",
      fieldPaths: [
        `${backend}.memory.jsHeapUsedBytesBefore`,
        `${backend}.memory.jsHeapUsedBytesAfter`,
      ],
      noise: PERF_METRIC_NOISE.memory.behaviour,
    };
    const problem = reportProblem("cpu");
    if (problem) {
      signals.push(structuralMetricSignal(base, problem));
      continue;
    }
    const leaf = vector.memory?.[backend];
    if (!leaf?.available) {
      signals.push(
        structuralMetricSignal(
          base,
          (leaf?.reasons ?? ["the memory axis produced no leaf"]).join("; "),
        ),
      );
      continue;
    }
    signals.push(
      metricSignal({
        ...base,
        observed: {
          jsHeapUsedBytesBefore: leaf.jsHeapUsedBytesBefore,
          jsHeapUsedBytesAfter: leaf.jsHeapUsedBytesAfter,
          deltaBytes: leaf.deltaBytes,
          deltaBytesPerFrame: leaf.deltaBytesPerFrame,
        },
        bar: null,
        comparator: PERF_METRIC_BARS.memory.comparator,
        verdict: "PASS",
        reason: `heap is observable: ${leaf.deltaBytes} bytes retained across the measured window. Published, not scored -- no bar is derivable from one observation`,
      }),
    );
  }

  return signals;
}
