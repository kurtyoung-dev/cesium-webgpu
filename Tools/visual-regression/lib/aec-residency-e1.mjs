// aec-residency-e1.mjs — the pure half of the E-1 residency instrument.
//
// @purpose Pure decision, aggregation and pre-registered-classification logic for the E-1 AEC residency measurement: refusal rules, CPU-profile self-time aggregation, per-frame pipeline-cache summarisation and the frozen hypothesis discriminator.
// @status ACTIVE
//
// WHY THIS EXISTS. Cirdan's station-3 review of the AEC design-model lane
// (`REVIEW_DESIGN_MODEL_PERF_CIRDAN.md`, sections 2, 3b E-1 and 5) rules that no
// fix for the WebGPU residency stall may be funded before one corrected,
// interleaved measurement exists. Two code-reading diagnoses have already failed
// on magnitude (V-3, V-4), so the review's instruction is explicitly to build the
// INSTRUMENT and not the fix. Everything in this module is the part of that
// instrument that runs without a browser, so it can be pinned by a hermetic spec
// rather than only by a live run that costs minutes of Edge time to observe once.
//
// THE PRE-REGISTRATION IS THE POINT. `E1_PREDICTIONS` is frozen at authoring
// time, before any run, and `classifySettleWindow` may read nothing else. A
// discriminator whose bands are chosen after seeing the data is not a
// discriminator; it is a description. The bands deliberately leave a
// no-man's-land and a "neither" quadrant, because a prediction that cannot come
// out "neither" cannot be wrong and therefore cannot be evidence.
//
// THE READINESS TRAP THIS MODULE GUARDS. `Scene#renderReady`
// (`packages/engine/Source/Scene/Scene.js:2721`) is
// `commandsDeferred === 0 && pendingResourceCount === 0`, and its own JSDoc at
// `:2715-2717` states that on a scene that has never rendered it reads true,
// "because nothing has been deferred and nothing is inflight". A gate written as
// `renderReady === true` alone is therefore satisfied vacuously by the very
// stall it is meant to exclude. `decideReadinessRefusal` requires a produced
// frame and a non-empty command list alongside it.

export const EXIT_CODES = Object.freeze({
  OK: 0,
  ERROR: 2,
  REFUSAL: 3,
});

/** The entry module a run loads when the operator names none. */
export const DEFAULT_ENTRY = "/Build/CesiumUnminified/index.js";

/**
 * Derive everything that must follow the entry module from the entry module.
 *
 * A run that loads `/Build/Cesium/index.js` against a `CESIUM_BASE_URL` and a
 * widgets stylesheet hardcoded to `/Build/CesiumUnminified/` is a cross-build
 * page, and a byte preflight over the unminified artifacts proves bytes that run
 * never loads. Both follow from the entry, so both are derived from it here and
 * the probe holds no build path of its own.
 *
 * `entryArtifact` is the file the page actually imports. `witnessArtifact` is
 * the sibling `Cesium.js` of the same build directory: the page does NOT load
 * it, and it is carried only as a staleness canary for the build that produced
 * the entry. The roles are kept distinct in the receipt so neither is read as
 * the other.
 *
 * @param {string} entry Root-relative served module path, e.g. `/Build/Cesium/index.js`.
 * @returns {{baseUrl: string, stylesheetUrl: string, entryArtifact: string, witnessArtifact: string, requiredArtifacts: string[]}}
 *   The derived context.
 */
export function deriveEntryContext(entry) {
  if (typeof entry !== "string" || !entry.startsWith("/")) {
    throw new TypeError("entry must be a root-relative served path");
  }
  const lastSlash = entry.lastIndexOf("/");
  const baseUrl = entry.slice(0, lastSlash + 1);
  const entryArtifact = entry.slice(1);
  const witnessArtifact = `${baseUrl.slice(1)}Cesium.js`;
  return {
    baseUrl,
    stylesheetUrl: `${baseUrl}Widgets/widgets.css`,
    entryArtifact,
    witnessArtifact,
    requiredArtifacts: [entryArtifact, witnessArtifact],
  };
}

/**
 * The served artifacts a run of the DEFAULT entry must prove are byte-identical
 * to disk before it measures anything. A run with `--entry` derives its own set
 * from `deriveEntryContext` instead; this constant is only the default's value.
 */
export const REQUIRED_SERVED_ARTIFACTS = Object.freeze(
  deriveEntryContext(DEFAULT_ENTRY).requiredArtifacts,
);

/**
 * Verdicts `classifySettleWindow` may return. Exported so the receipt reader and
 * the spec share one vocabulary and a typo becomes a failure rather than a new
 * category.
 */
export const E1_VERDICTS = Object.freeze({
  PIPELINE_CREATION_BOUND: "pipeline-creation-bound",
  MAIN_THREAD_STARVED: "main-thread-starved",
  BOTH_PRESENT: "both-present",
  NEITHER_UNMODELLED_WAIT: "neither-unmodelled-wait",
  INDETERMINATE: "indeterminate-between-bands",
  UNDECIDABLE: "undecidable-insufficient-samples",
});

/**
 * THE PRE-REGISTRATION. Written before any run of this probe, and frozen.
 *
 * Two hypotheses are on the table for the WebGPU settle window, and they make
 * opposite predictions about the same two numbers.
 *
 * V-4, pipeline-creation bound. Central render-pipeline creation is what the
 * window is spent waiting on. `createRenderPipelineAsync` compiles off the main
 * thread, so the main thread is mostly IDLE while `pipelineCache.pending` stays
 * above zero and `created` climbs in steps. Signature: `mainThreadBusyFraction`
 * at or below `busyLow`, `pipelinePendingFraction` at or above `pendingHigh`.
 *
 * Main-thread starvation. Something on the main thread — content preparation,
 * upload, or garbage collection under the roughly 2.4 GB heap of V-5 — consumes
 * the window, and the pipeline cache is not what the frames wait for. Signature:
 * `mainThreadBusyFraction` at or above `busyHigh`,
 * `pipelinePendingFrameFraction` at or below `pendingLow`, with the owner named
 * by `topSelfTime`.
 *
 * BOTH AXES ARE TIME-WEIGHTED. `mainThreadBusyFraction` comes from a continuous
 * 200 us V8 sampler, so it measures the whole window including the gaps between
 * frames. The pending axis must be weighted the same way or the two are not
 * comparable: on the leg this row is about, frames arrive roughly 18 times in
 * 75 s, so a per-frame cache reading samples 18 instants and never the intervals
 * between them — which is exactly where V-4 says the wait lives. The window is
 * therefore polled on a wall-clock cadence as well, each poll sample weighted by
 * the interval it terminates, and `classifySettleWindow` classifies on that
 * time-weighted fraction. The per-frame fraction is still computed and reported
 * beside it as the secondary reading, and is used only when no poll sample
 * carried a cache at all.
 *
 * `minimumCacheSamples` is the sufficiency floor for the axis actually in use.
 * Keeping the frame floor as the only floor would have made the instrument LOSE
 * power as the defect worsened: a stall bad enough to produce seven frames would
 * return `undecidable` while the poll held hundreds of readings of the same
 * window.
 *
 * Both may hold at once (`both-present`), and — the outcome that makes this a
 * real prediction rather than a narration — NEITHER may hold: an idle main
 * thread with an idle pipeline cache means the wait is unmodelled (network, GPU
 * queue, or a wait held off-thread), and the row reopens instead of being told
 * as one of the two existing stories.
 *
 * `sampleCoverageFloor` guards the degenerate case where the profiler produced
 * far less sampled time than the wall clock it covered: that is a broken
 * instrument, not a measurement, and it yields
 * `undecidable-insufficient-samples` instead of a verdict.
 */
export const E1_PREDICTIONS = Object.freeze({
  registeredOn: "2026-09-02",
  registeredBefore: "any run of probe-aec-residency-e1.mjs",
  busyLow: 0.35,
  busyHigh: 0.7,
  pendingLow: 0.2,
  pendingHigh: 0.5,
  sampleCoverageFloor: 0.5,
  minimumFrameSamples: 8,
  minimumCacheSamples: 8,
  hypotheses: Object.freeze({
    "pipeline-creation-bound": Object.freeze({
      source: "Cirdan V-4",
      predicts:
        "main thread mostly idle over the settle window while pipelineCache.pending stays above zero and created climbs in steps",
      requires: "busyFraction <= busyLow AND pendingFraction >= pendingHigh",
      axis: "time-weighted pipelinePendingFraction",
    }),
    "main-thread-starved": Object.freeze({
      source: "Cirdan V-1 open question 1, with V-5 as a candidate mechanism",
      predicts:
        "sampled self-time accounts for most of the settle window and topSelfTime names JS owners, while the pipeline cache stays quiet",
      requires: "busyFraction >= busyHigh AND pendingFraction <= pendingLow",
      axis: "time-weighted pipelinePendingFraction",
    }),
  }),
});

/**
 * V8 call frames that are not the main thread doing work. `(program)` is
 * deliberately NOT here: it is time inside the VM outside JS (native calls,
 * compilation, browser work reached from script), which is a busy main thread
 * for the purpose of the starvation question even though it is not attributable
 * JS.
 */
export const IDLE_CALL_FRAMES = Object.freeze(["(idle)", "(root)"]);

export class E1RefusalError extends Error {
  constructor(reason, message, details = null) {
    super(message);
    this.name = "AECResidencyE1Refusal";
    this.reason = reason;
    this.exitCode = EXIT_CODES.REFUSAL;
    this.details = details;
  }
}

function acceptedDecision() {
  return {
    refuse: false,
    exitCode: EXIT_CODES.OK,
    reason: null,
    details: null,
  };
}

function refusedDecision(reason, details = null) {
  return { refuse: true, exitCode: EXIT_CODES.REFUSAL, reason, details };
}

/**
 * Raise a decision as a refusal, or return quietly when it accepted.
 *
 * @param {{refuse: boolean, reason: string|null, details: unknown}} decision The decision.
 * @param {string} message Operator-facing message.
 * @returns {void}
 */
export function throwForDecision(decision, message) {
  if (decision.refuse) {
    throw new E1RefusalError(
      decision.reason,
      message,
      decision.details ?? null,
    );
  }
}

function optionValue(argv, index, name) {
  if (index + 1 >= argv.length || argv[index + 1].startsWith("--")) {
    throw new TypeError(`${name} requires a value`);
  }
  return argv[index + 1];
}

function positiveInteger(value, name) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new TypeError(`${name} must be a positive integer`);
  }
  return parsed;
}

/**
 * Parse the probe's command line.
 *
 * Port 8080 is refused rather than merely defaulted away from: the worker
 * charter reserves it, and a probe that silently measured whatever is already
 * listening there would attribute another lane's build to this row.
 *
 * Every phase that waits on the page carries its own deadline.
 * `--settle-deadline-ms` bounds the settle window and
 * `--equal-content-deadline-ms` bounds the equal-content phase, which waits on
 * frames from a scene just observed struggling to produce them.
 *
 * @param {string[]} argv Arguments after the script name.
 * @returns {object} Parsed options.
 */
export function parseArgs(argv) {
  const options = {
    port: 8094,
    entry: DEFAULT_ENTRY,
    reverse: false,
    headed: false,
    settleDeadlineMs: 90000,
    equalContentDeadlineMs: 30000,
    sampleFrames: 120,
    pickSamples: 40,
    samplingIntervalUs: 200,
    heapSnapshot: false,
    outputDirectory: null,
    repositoryRoot: null,
  };

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--reverse") {
      options.reverse = true;
    } else if (arg === "--headed") {
      options.headed = true;
    } else if (arg === "--heap-snapshot") {
      options.heapSnapshot = true;
    } else if (arg === "--port") {
      options.port = positiveInteger(optionValue(argv, index, arg), "--port");
      index++;
    } else if (arg === "--entry") {
      options.entry = optionValue(argv, index, arg);
      index++;
    } else if (arg === "--settle-deadline-ms") {
      options.settleDeadlineMs = positiveInteger(
        optionValue(argv, index, arg),
        "--settle-deadline-ms",
      );
      index++;
    } else if (arg === "--equal-content-deadline-ms") {
      options.equalContentDeadlineMs = positiveInteger(
        optionValue(argv, index, arg),
        "--equal-content-deadline-ms",
      );
      index++;
    } else if (arg === "--sample-frames") {
      options.sampleFrames = positiveInteger(
        optionValue(argv, index, arg),
        "--sample-frames",
      );
      index++;
    } else if (arg === "--pick-samples") {
      options.pickSamples = positiveInteger(
        optionValue(argv, index, arg),
        "--pick-samples",
      );
      index++;
    } else if (arg === "--sampling-interval-us") {
      options.samplingIntervalUs = positiveInteger(
        optionValue(argv, index, arg),
        "--sampling-interval-us",
      );
      index++;
    } else if (arg === "--output") {
      options.outputDirectory = optionValue(argv, index, arg);
      index++;
    } else if (arg === "--repository-root") {
      options.repositoryRoot = optionValue(argv, index, arg);
      index++;
    } else {
      throw new TypeError(`unknown argument: ${arg}`);
    }
  }

  if (options.port === 8080) {
    throw new E1RefusalError(
      "port-8080-forbidden",
      "E-1 refuses port 8080; start the served build on a lane port such as 8094",
      { port: options.port },
    );
  }
  if (options.port > 65535) {
    throw new TypeError("--port must be at most 65535");
  }
  if (!options.entry.startsWith("/")) {
    throw new TypeError("--entry must be a root-relative served path");
  }

  return options;
}

/**
 * Refuse a run whose page did not stay on the origin the operator named.
 *
 * @param {{requestedOrigin: string, actualUrl: string}} input The two origins.
 * @returns {object} A decision.
 */
export function decideOriginRefusal({ requestedOrigin, actualUrl }) {
  let expected;
  let actual;
  try {
    expected = new URL(requestedOrigin).origin;
  } catch {
    return refusedDecision("requested-origin-invalid", { requestedOrigin });
  }
  try {
    actual = new URL(actualUrl).origin;
  } catch {
    return refusedDecision("navigation-url-invalid", {
      requestedOrigin: expected,
      actualUrl,
    });
  }
  if (actual !== expected) {
    return refusedDecision("origin-mismatch", {
      requestedOrigin: expected,
      actualOrigin: actual,
      actualUrl,
    });
  }
  return acceptedDecision();
}

/**
 * Refuse a run whose served bundles are not the bytes on disk.
 *
 * @param {object} preflight Result from `preflightServedBuildArtifacts`.
 * @param {readonly string[]} requiredArtifacts Artifacts that must match.
 * @returns {object} A decision.
 */
export function decidePreflightRefusal(
  preflight,
  requiredArtifacts = REQUIRED_SERVED_ARTIFACTS,
) {
  if (!preflight || preflight.ok !== true) {
    return refusedDecision("served-build-preflight-failed", {
      preflight: preflight ?? null,
    });
  }
  const results = Array.isArray(preflight.artifacts) ? preflight.artifacts : [];
  const byPath = new Map(results.map((result) => [result.path, result]));
  const missingOrUnmatched = requiredArtifacts.filter((artifact) => {
    const result = byPath.get(artifact);
    return !result || result.match !== true;
  });
  if (missingOrUnmatched.length > 0) {
    return refusedDecision("served-build-preflight-incomplete", {
      missingOrUnmatched,
      preflight,
    });
  }
  return acceptedDecision();
}

/**
 * Decide whether a readiness observation is real or vacuous.
 *
 * `Scene#renderReady` reads `true` on a scene that has never rendered
 * (`Scene.js:2715-2717`), so a lane that gates on it alone certifies the very
 * stall it is trying to exclude. A real observation additionally shows a
 * produced frame and a non-empty command list.
 *
 * `reached === false` is NOT a refusal here — a backend that never becomes ready
 * is the measured outcome of the settle window, and refusing it would delete the
 * finding. In particular `renderReady === true` with zero produced frames is
 * ACCEPTED and recorded as `reached: false`: that pair is the stall's signature,
 * not a broken observation. What is refused is a record whose own `reached` flag
 * contradicts the numbers beside it in either direction.
 *
 * @param {object} readiness Readiness observation taken from the page.
 * @returns {object} A decision.
 */
export function decideReadinessRefusal(readiness) {
  if (!readiness || typeof readiness !== "object") {
    return refusedDecision("readiness-observation-missing", {
      readiness: readiness ?? null,
    });
  }
  if (typeof readiness.renderReady !== "boolean") {
    return refusedDecision("render-ready-not-boolean", { readiness });
  }
  if (!Number.isInteger(readiness.framesProduced)) {
    return refusedDecision("frames-produced-not-counted", { readiness });
  }
  if (!Number.isInteger(readiness.commandListLength)) {
    return refusedDecision("command-list-not-counted", { readiness });
  }
  const nonVacuous =
    readiness.renderReady === true &&
    readiness.framesProduced >= 1 &&
    readiness.commandListLength >= 1;
  if (readiness.reached === true && !nonVacuous) {
    return refusedDecision("readiness-gate-vacuous", { readiness, nonVacuous });
  }
  if (readiness.reached === false && nonVacuous) {
    return refusedDecision("readiness-flag-inconsistent", {
      readiness,
      nonVacuous,
    });
  }
  return acceptedDecision();
}

/**
 * Decide whether the equal-content comparison between two legs may be reported.
 *
 * The 2026-08-29 dataset's pick ratio was void for exactly two reasons — the
 * legs used different cursor positions, and the WebGPU leg was sampled inside a
 * window that produced no frames (Cirdan C-6, V-7). Both are refused here by
 * construction, so a void comparison cannot reach the receipt as a number.
 *
 * @param {{legs: object[]}} input The per-backend legs.
 * @returns {object} A decision.
 */
export function decideEqualContentRefusal({ legs }) {
  if (!Array.isArray(legs) || legs.length < 2) {
    return refusedDecision("equal-content-needs-two-legs", {
      legCount: Array.isArray(legs) ? legs.length : 0,
    });
  }
  const notReady = legs.filter((leg) => leg?.readiness?.reached !== true);
  if (notReady.length > 0) {
    return refusedDecision("equal-content-leg-void", {
      backends: notReady.map((leg) => leg?.backend ?? null),
      note: "a backend that never reached a non-vacuous renderReady cannot be compared at equal content",
    });
  }
  const positions = legs.map((leg) =>
    leg?.validatedPick
      ? `${leg.validatedPick.x},${leg.validatedPick.y}`
      : "none",
  );
  if (positions.some((position) => position === "none")) {
    return refusedDecision("pick-position-missing", { positions });
  }
  if (new Set(positions).size !== 1) {
    return refusedDecision("pick-position-not-shared", { positions });
  }
  return acceptedDecision();
}

/**
 * Aggregate a CDP `.cpuprofile` into self-time per call frame.
 *
 * @param {object} profile A profile returned by `Profiler.stop`.
 * @returns {{rows: object[], totalMs: number, idleMs: number, busyMs: number, sampleCount: number}}
 *   The aggregation.
 */
export function aggregateSelfTime(profile) {
  const nodes = Array.isArray(profile?.nodes) ? profile.nodes : [];
  const samples = Array.isArray(profile?.samples) ? profile.samples : [];
  const timeDeltas = Array.isArray(profile?.timeDeltas)
    ? profile.timeDeltas
    : [];

  const byId = new Map();
  for (const node of nodes) {
    byId.set(node.id, node);
  }

  const selfTimeUs = new Map();
  for (let index = 0; index < samples.length; index++) {
    const id = samples[index];
    const delta = Number.isFinite(timeDeltas[index]) ? timeDeltas[index] : 0;
    if (delta <= 0) {
      continue;
    }
    selfTimeUs.set(id, (selfTimeUs.get(id) ?? 0) + delta);
  }

  const byFunction = new Map();
  let idleUs = 0;
  let totalUs = 0;
  for (const [id, microseconds] of selfTimeUs) {
    const node = byId.get(id);
    const frame = node?.callFrame ?? {};
    const name = frame.functionName || "(anonymous)";
    const url = (frame.url || "").split("/").slice(-1)[0] || "(native)";
    const key = `${name} @ ${url}:${frame.lineNumber ?? "?"}`;
    totalUs += microseconds;
    if (IDLE_CALL_FRAMES.includes(name)) {
      idleUs += microseconds;
    }
    const existing = byFunction.get(key) ?? { name, url, microseconds: 0 };
    existing.microseconds += microseconds;
    byFunction.set(key, existing);
  }

  const denominator = totalUs > 0 ? totalUs : 1;
  const rows = [...byFunction.entries()]
    .map(([fn, entry]) => ({
      fn,
      name: entry.name,
      ms: entry.microseconds / 1000,
      pct: (entry.microseconds / denominator) * 100,
    }))
    .sort((left, right) => right.ms - left.ms);

  return {
    rows,
    totalMs: totalUs / 1000,
    idleMs: idleUs / 1000,
    busyMs: (totalUs - idleUs) / 1000,
    sampleCount: samples.length,
  };
}

/**
 * Aggregate a CDP `HeapProfiler.stopSampling` profile into allocation-site
 * buckets, largest first.
 *
 * NAMING HONESTY, because the review asked for something adjacent and this is
 * not it. Cirdan's E-1 asks for "a Chrome heap snapshot at the end of each
 * settle window bucketed by RETAINER". A retainer view requires the full
 * `.heapsnapshot` graph, which on the 2.4 GB heap of V-5 is gigabytes of JSON
 * that a probe must not parse in-process. This function buckets by ALLOCATION
 * SITE instead, which is bounded, cheap, and answers the actionable half of the
 * question ("who allocated it"). The retainer half is served by streaming the
 * full snapshot to disk under `--heap-snapshot` and opening it in DevTools; the
 * probe never parses that file. Do not report an allocation-site bucket as a
 * retainer bucket.
 *
 * @param {object} profile A profile from `HeapProfiler.stopSampling`.
 * @param {number} limit How many buckets to keep.
 * @returns {{totalSelfBytes: number, buckets: object[]}} The aggregation.
 */
export function aggregateHeapSamplingProfile(profile, limit = 20) {
  const head = profile?.head ?? profile?.profile?.head ?? null;
  const bySite = new Map();
  let totalSelfBytes = 0;

  const stack = head ? [head] : [];
  const seen = new Set();
  while (stack.length > 0) {
    const node = stack.pop();
    if (!node || typeof node !== "object" || seen.has(node)) {
      continue;
    }
    seen.add(node);
    const selfSize = Number.isFinite(node.selfSize) ? node.selfSize : 0;
    if (selfSize > 0) {
      const frame = node.callFrame ?? {};
      const name = frame.functionName || "(anonymous)";
      const url = (frame.url || "").split("/").slice(-1)[0] || "(native)";
      const key = `${name} @ ${url}:${frame.lineNumber ?? "?"}`;
      bySite.set(key, (bySite.get(key) ?? 0) + selfSize);
      totalSelfBytes += selfSize;
    }
    if (Array.isArray(node.children)) {
      for (const child of node.children) {
        stack.push(child);
      }
    }
  }

  const denominator = totalSelfBytes > 0 ? totalSelfBytes : 1;
  const buckets = [...bySite.entries()]
    .map(([site, bytes]) => ({
      site,
      bytes,
      pct: Math.round((bytes / denominator) * 100000) / 1000,
    }))
    .sort((left, right) => right.bytes - left.bytes)
    .slice(0, limit);

  return { totalSelfBytes, bucketedBy: "allocation-site", buckets };
}

function finiteSamples(values) {
  return Array.isArray(values)
    ? values.filter((value) => Number.isFinite(value))
    : [];
}

/**
 * Nearest-rank percentile over the finite samples of a set.
 *
 * @param {number[]} values Samples.
 * @param {number} fraction Fraction in [0, 1].
 * @returns {number|null} The percentile, or null when there is nothing to rank.
 */
export function percentile(values, fraction) {
  if (!Number.isFinite(fraction) || fraction < 0 || fraction > 1) {
    throw new RangeError("percentile fraction must be between zero and one");
  }
  const sorted = finiteSamples(values).sort((left, right) => left - right);
  if (sorted.length === 0) {
    return null;
  }
  const rank = Math.max(
    0,
    Math.min(sorted.length - 1, Math.ceil(fraction * sorted.length) - 1),
  );
  return sorted[rank];
}

function rounded(value, digits = 3) {
  if (!Number.isFinite(value)) {
    return null;
  }
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/**
 * p50, p95 and max of a sample set, rounded for the receipt.
 *
 * @param {number[]} values Samples.
 * @returns {{n: number, p50: number|null, p95: number|null, max: number|null}} The stats.
 */
export function p50P95(values) {
  const samples = finiteSamples(values);
  return {
    n: samples.length,
    p50: rounded(percentile(samples, 0.5)),
    p95: rounded(percentile(samples, 0.95)),
    max: samples.length > 0 ? rounded(Math.max(...samples)) : null,
  };
}

/**
 * Pending-fraction denominator, shared by both axes so one rule governs both.
 *
 * Only readings that actually carried a cache count. `_webgpuPipelineCache` is
 * created lazily (`WebGPUContext.ts:7137`) from a field initialised to `null`
 * (`:658`), and `getRendererStatistics` publishes no `pipelineCache` key until
 * it exists (`:6924`), so a mixed null/non-null set occurs on EVERY WebGPU run,
 * not as an edge case. Dividing by the full sample count instead would silently
 * dilute the fraction toward zero by however long the cache took to appear —
 * biasing the window away from the pipeline-creation hypothesis it exists to
 * test.
 *
 * @param {Array<{cache: object|null|undefined, weight: number}>} readings Weighted readings.
 * @returns {{sampleCount: number, weight: number, pendingWeight: number, fraction: number|null}}
 *   The counted denominator and the fraction over it.
 */
export function pendingFractionOf(readings) {
  const counted = (Array.isArray(readings) ? readings : []).filter(
    (reading) =>
      Number.isFinite(reading?.cache?.pending) &&
      Number.isFinite(reading?.weight) &&
      reading.weight > 0,
  );
  let weight = 0;
  let pendingWeight = 0;
  for (const reading of counted) {
    weight += reading.weight;
    if (reading.cache.pending > 0) {
      pendingWeight += reading.weight;
    }
  }
  return {
    sampleCount: counted.length,
    weight,
    pendingWeight,
    fraction: weight > 0 ? pendingWeight / weight : null,
  };
}

/**
 * Summarise the wall-clock-cadence cache poll taken across a settle window.
 *
 * Each sample is weighted by `sinceLastSampleMs`, the interval it terminates, so
 * a poll tick deferred behind a long task still accounts for the whole time it
 * covered rather than counting as one tick like every other. That is what makes
 * this axis comparable with the continuous CPU sampler.
 *
 * @param {object[]} samples Poll samples.
 * @returns {object} The time-weighted summary.
 */
export function summarizeCacheSamples(samples) {
  const rows = Array.isArray(samples) ? samples : [];
  const counted = pendingFractionOf(
    rows.map((row) => ({
      cache: row?.pipelineCache,
      weight: row?.sinceLastSampleMs,
    })),
  );
  const createdValues = rows
    .map((row) => row?.pipelineCache?.created)
    .filter((value) => Number.isFinite(value));
  return {
    pollSampleCount: rows.length,
    cacheSampleCount: counted.sampleCount,
    weightedSpanMs: rounded(counted.weight),
    pendingSpanMs: rounded(counted.pendingWeight),
    pipelinePendingTimeFraction: counted.fraction,
    pipelineCreatedFirst: createdValues.length > 0 ? createdValues[0] : null,
    pipelineCreatedLast:
      createdValues.length > 0 ? createdValues[createdValues.length - 1] : null,
    pipelineCreatedDelta:
      createdValues.length > 0
        ? createdValues[createdValues.length - 1] - createdValues[0]
        : null,
  };
}

/**
 * Summarise the per-frame samples taken across a settle window.
 *
 * @param {object[]} samples Per-frame records.
 * @returns {object} A summary including the pending-frame fraction the
 *   discriminator reads.
 */
export function summarizeFrameSamples(samples) {
  const rows = Array.isArray(samples) ? samples : [];
  const counted = pendingFractionOf(
    rows.map((row) => ({ cache: row?.pipelineCache, weight: 1 })),
  );
  const createdValues = rows
    .map((row) => row?.pipelineCache?.created)
    .filter((value) => Number.isFinite(value));
  const frameDeltas = rows
    .map((row) => row?.sinceLastFrameMs)
    .filter((value) => Number.isFinite(value));
  const commandCounts = rows
    .map((row) => row?.commandListLength)
    .filter((value) => Number.isFinite(value));

  return {
    frameSampleCount: rows.length,
    cacheSampleCount: counted.sampleCount,
    pipelinePendingFrameFraction: counted.fraction,
    pipelineCreatedFirst: createdValues.length > 0 ? createdValues[0] : null,
    pipelineCreatedLast:
      createdValues.length > 0 ? createdValues[createdValues.length - 1] : null,
    pipelineCreatedDelta:
      createdValues.length > 0
        ? createdValues[createdValues.length - 1] - createdValues[0]
        : null,
    frameDeltaMs: p50P95(frameDeltas),
    commandListLength: p50P95(commandCounts),
  };
}

/**
 * THE DISCRIMINATOR. Reads only the frozen `E1_PREDICTIONS` bands.
 *
 * @param {object} input The window's profile, frame samples and wall clock.
 * @returns {object} The verdict plus every number it was computed from.
 */
export function classifySettleWindow({
  profile,
  frameSamples,
  cacheSamples,
  windowMs,
  predictions = E1_PREDICTIONS,
}) {
  const aggregate = aggregateSelfTime(profile);
  const frames = summarizeFrameSamples(frameSamples);
  const poll = summarizeCacheSamples(cacheSamples);
  const sampleCoverage =
    Number.isFinite(windowMs) && windowMs > 0
      ? aggregate.totalMs / windowMs
      : null;
  const mainThreadBusyFraction =
    aggregate.totalMs > 0 ? aggregate.busyMs / aggregate.totalMs : null;
  // The time-weighted poll is the axis. The frame-weighted fraction is the
  // fallback for a run that predates the poll or whose poll never saw a cache,
  // and the axis in use travels with the verdict so no reader has to guess.
  const timeWeighted = poll.pipelinePendingTimeFraction;
  const usePoll = Number.isFinite(timeWeighted);
  const pendingFraction = usePoll
    ? timeWeighted
    : frames.pipelinePendingFrameFraction;
  const pendingAxis = usePoll ? "time-weighted-poll" : "frame-weighted";
  const garbageCollector = aggregate.rows.find(
    (row) => row.name === "(garbage collector)",
  );

  const evidence = {
    sampleCoverage: rounded(sampleCoverage, 4),
    sampledTotalMs: rounded(aggregate.totalMs),
    sampledIdleMs: rounded(aggregate.idleMs),
    sampledBusyMs: rounded(aggregate.busyMs),
    mainThreadBusyFraction: rounded(mainThreadBusyFraction, 4),
    pipelinePendingFraction: rounded(pendingFraction, 4),
    pipelinePendingFractionAxis: pendingAxis,
    pipelinePendingTimeFraction: rounded(timeWeighted, 4),
    pipelinePendingFrameFraction: rounded(
      frames.pipelinePendingFrameFraction,
      4,
    ),
    cachePoll: poll,
    gcSelfMs: garbageCollector ? rounded(garbageCollector.ms) : null,
    gcSelfPct: garbageCollector ? rounded(garbageCollector.pct, 3) : null,
    frames,
    topSelfTime: aggregate.rows.slice(0, 20).map((row) => ({
      fn: row.fn,
      ms: rounded(row.ms),
      pct: rounded(row.pct, 3),
    })),
  };

  const undecidable = (reason) => ({
    verdict: E1_VERDICTS.UNDECIDABLE,
    reason,
    predictions,
    ...evidence,
  });

  if (!Number.isFinite(sampleCoverage)) {
    return undecidable("settle-window-wall-clock-unknown");
  }
  if (sampleCoverage < predictions.sampleCoverageFloor) {
    return undecidable("sample-coverage-below-floor");
  }
  // The sufficiency floor applies to the axis actually in use. Gating a
  // time-weighted verdict on the frame count would make the instrument weakest
  // exactly where the defect is worst.
  if (usePoll) {
    if (poll.cacheSampleCount < predictions.minimumCacheSamples) {
      return undecidable("too-few-cache-samples");
    }
  } else if (frames.frameSampleCount < predictions.minimumFrameSamples) {
    return undecidable("too-few-frame-samples");
  }
  if (!Number.isFinite(mainThreadBusyFraction)) {
    return undecidable("no-sampled-self-time");
  }
  if (!Number.isFinite(pendingFraction)) {
    return undecidable("pipeline-cache-never-sampled");
  }

  const busyHigh = mainThreadBusyFraction >= predictions.busyHigh;
  const busyLow = mainThreadBusyFraction <= predictions.busyLow;
  const pendingHigh = pendingFraction >= predictions.pendingHigh;
  const pendingLow = pendingFraction <= predictions.pendingLow;

  let verdict = E1_VERDICTS.INDETERMINATE;
  if (busyLow && pendingHigh) {
    verdict = E1_VERDICTS.PIPELINE_CREATION_BOUND;
  } else if (busyHigh && pendingLow) {
    verdict = E1_VERDICTS.MAIN_THREAD_STARVED;
  } else if (busyHigh && pendingHigh) {
    verdict = E1_VERDICTS.BOTH_PRESENT;
  } else if (busyLow && pendingLow) {
    verdict = E1_VERDICTS.NEITHER_UNMODELLED_WAIT;
  }

  return { verdict, reason: null, predictions, ...evidence };
}

/**
 * Compare the engine bytes a leg actually loaded against the bytes its preflight
 * proved.
 *
 * The preflight proves a named artifact list. The page loads whatever its entry
 * module pulls in — for a code-split build, a directory of chunks nobody named.
 * Rather than assert a coverage this probe cannot guarantee, each leg records
 * which loaded modules were proven and which were not, so a reader sees the gap
 * instead of inferring its absence.
 *
 * @param {{loadedUrls: string[], requiredArtifacts: readonly string[], origin: string}} input
 *   Observed responses, the proven set and the run's origin.
 * @returns {{loadedCount: number, provenCount: number, unproven: string[]}} The comparison.
 */
export function summarizeModuleCoverage({
  loadedUrls,
  requiredArtifacts,
  origin,
}) {
  const proven = new Set(
    (requiredArtifacts ?? []).map((artifact) => `/${artifact}`),
  );
  const paths = [];
  for (const url of loadedUrls ?? []) {
    let pathname;
    try {
      pathname = new URL(url, origin || "http://localhost").pathname;
    } catch {
      continue;
    }
    if (!pathname.endsWith(".js") && !pathname.endsWith(".mjs")) {
      continue;
    }
    if (!paths.includes(pathname)) {
      paths.push(pathname);
    }
  }
  const unproven = paths.filter((pathname) => !proven.has(pathname));
  return {
    loadedCount: paths.length,
    provenCount: paths.length - unproven.length,
    unproven: unproven.slice(0, 40),
  };
}

/**
 * Assemble the receipt this probe writes.
 *
 * @param {object} input Run inputs and per-leg results.
 * @returns {object} The receipt.
 */
export function buildReceipt({
  startedAt,
  origin,
  entry,
  entryContext,
  reverse,
  preflight,
  legs,
  equalContent,
}) {
  return {
    probe: "aec-residency-e1",
    row: "Q-143 / DM-09",
    startedAt,
    origin,
    entry,
    entryContext: entryContext ?? null,
    runOrder: reverse ? ["webgpu", "webgl"] : ["webgl", "webgpu"],
    reverse: reverse === true,
    predictions: E1_PREDICTIONS,
    preflight,
    legs,
    equalContent,
  };
}

function markdownEscape(value) {
  return String(value ?? "")
    .split("|")
    .join("\\|");
}

/**
 * Render the receipt as the Markdown summary the executor pastes into a report.
 *
 * @param {object} receipt A receipt from `buildReceipt`.
 * @returns {string} Markdown.
 */
export function buildMarkdownSummary(receipt) {
  const lines = [
    "# E-1 — AEC residency measurement (Q-143 / DM-09)",
    "",
    `Origin: \`${markdownEscape(receipt.origin)}\``,
    `Entry: \`${markdownEscape(receipt.entry)}\``,
    `Run order: ${markdownEscape((receipt.runOrder ?? []).join(" then "))}`,
    "",
    "| Backend | renderReady | Frames | Settle ms | Busy frac | Pending frac (axis) | Verdict |",
    "| --- | --- | --- | --- | --- | --- | --- |",
  ];

  for (const leg of receipt.legs ?? []) {
    lines.push(
      `| ${markdownEscape(leg.backend)} | ${leg.readiness?.reached === true ? "yes" : "NO"} | ` +
        `${leg.readiness?.framesProduced ?? "n/a"} | ${leg.settleWindowMs ?? "n/a"} | ` +
        `${leg.classification?.mainThreadBusyFraction ?? "n/a"} | ` +
        `${leg.classification?.pipelinePendingFraction ?? "n/a"} ` +
        `(${markdownEscape(leg.classification?.pipelinePendingFractionAxis ?? "none")}) | ` +
        `${markdownEscape(leg.classification?.verdict ?? "n/a")} |`,
    );
  }

  lines.push("");
  for (const leg of receipt.legs ?? []) {
    const coverage = leg.moduleCoverage;
    if (coverage && coverage.unproven?.length > 0) {
      lines.push(
        `${markdownEscape(leg.backend)}: ${coverage.unproven.length} of ` +
          `${coverage.loadedCount} loaded engine modules were NOT covered by ` +
          `the byte preflight; first unproven: ` +
          `${markdownEscape(coverage.unproven[0])}.`,
      );
    }
    if (leg.equalContent?.timedOut === true) {
      lines.push(
        `${markdownEscape(leg.backend)}: the equal-content phase hit its ` +
          `deadline and reports partial samples.`,
      );
    }
  }
  if (receipt.equalContent?.refused === true) {
    lines.push(
      `Equal-content comparison REFUSED: \`${markdownEscape(receipt.equalContent.reason)}\`.`,
    );
  } else if (receipt.equalContent) {
    lines.push(
      `Equal-content pick position: \`(${receipt.equalContent.validatedPick?.x}, ${receipt.equalContent.validatedPick?.y})\`.`,
    );
  }
  return `${lines.join("\n")}\n`;
}
