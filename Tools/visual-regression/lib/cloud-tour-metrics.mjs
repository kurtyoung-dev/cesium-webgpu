/**
 * C13-01 cloud-tour METRICS — the measurement half of the repaired tour.
 *
 * Everything here is a PURE function over already-captured data: pixel buffers,
 * CPU frame samples, the WebGPU timestamp profiler's result object, and whole
 * run manifests. Nothing in this module renders, launches, or reads a canvas.
 * That is deliberate — the C13-01 row asks for "complete per-sequence metrics",
 * and a metric whose only definition lives inside a `page.evaluate` callback can
 * be neither reviewed nor regression-tested. Here, each metric has a Node-side
 * definition the spec exercises directly, including its degenerate cases.
 *
 * WHAT THE ROW ASKS TO BE RECORDED, and where it lands:
 *   source/build hash            -> record.provenance.{commit,runtimeBundle.sha256}
 *   adapter                      -> record.environment.adapterInfo
 *   canvas resolution            -> record.environment.canvas
 *   tier                         -> record.realization.{tier,tierName,tierEvidence}
 *   current/history target dims  -> record.realization.{currentTarget,historyTarget}
 *   CPU frame distribution       -> record.cpuFrames (p50/p95/p99 + spread)
 *   available GPU timestamps     -> record.gpu.{supported,passes,profiler}
 *   temporal-delta/ghost metrics -> record.temporal.{phases,framewise,ghost}
 *   screenshots                  -> record.screenshots[]
 * `validateSequenceMetricRecord` enforces every one of those paths, so a
 * silently-thinned manifest is a RED run rather than a quiet gap.
 *
 * ON GPU TIMING (C13-39's byte-inert timestamps). `assessInterleavedAb` is the
 * enforcement of the interleaved-A/B protocol that `probe-cloud-lod-hoist-perf.mjs`
 * states in prose: build both bundles once, alternate within one session, run at
 * least two rounds with at least one in REVERSE order, and discard — never
 * interpret — a round whose untouched control passes moved. That protocol exists
 * because the 2026-07-24 non-interleaved attempt produced impossible
 * bidirectional deltas on shaders the change never touched. Prose did not stop
 * it, so here it is a function that returns a status.
 *
 * @module cloud-tour-metrics
 */

import { stableStringify } from "./cloud-tour-fixtures.mjs";

/** Bumped whenever the manifest shape changes incompatibly. */
export const SEQUENCE_MANIFEST_VERSION = "c13-01-tour-sequences/1";

// ── CPU frame distribution ─────────────────────────────────────────────────

function percentile(sorted, fraction) {
  if (sorted.length === 0) {
    return null;
  }
  // Nearest-rank. With the small samples a per-sequence window produces, linear
  // interpolation invents values between two measured frames; nearest-rank only
  // ever reports a frame that actually happened.
  const rank = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(fraction * sorted.length) - 1),
  );
  return sorted[rank];
}

/**
 * Distribution of per-frame CPU costs.
 *
 * @param {number[]} samples Milliseconds, one per measured frame.
 * @returns {object} `{count, meanMs, p50Ms, p95Ms, p99Ms, minMs, maxMs}`; the
 *   statistics are `null` for an empty sample so a missing measurement can
 *   never be mistaken for a zero-cost frame.
 */
export function frameDistribution(samples) {
  const finite = (Array.isArray(samples) ? samples : []).filter((value) =>
    Number.isFinite(value),
  );
  if (finite.length === 0) {
    return {
      count: 0,
      meanMs: null,
      p50Ms: null,
      p95Ms: null,
      p99Ms: null,
      minMs: null,
      maxMs: null,
    };
  }
  const sorted = [...finite].sort((a, b) => a - b);
  const sum = finite.reduce((total, value) => total + value, 0);
  const round = (value) => (value === null ? null : +value.toFixed(4));
  return {
    count: finite.length,
    meanMs: round(sum / finite.length),
    p50Ms: round(percentile(sorted, 0.5)),
    p95Ms: round(percentile(sorted, 0.95)),
    p99Ms: round(percentile(sorted, 0.99)),
    minMs: round(sorted[0]),
    maxMs: round(sorted[sorted.length - 1]),
  };
}

// ── Image deltas ───────────────────────────────────────────────────────────

/** Default per-pixel channel-sum threshold for "this pixel changed".
 * Matches the OFF/ON contribution threshold the planetary oracle already uses,
 * so a number produced here is comparable with one produced there. */
export const CHANGED_PIXEL_THRESHOLD = 18;

/**
 * Compare two RGBA buffers of identical length.
 *
 * @param {ArrayLike<number>} a
 * @param {ArrayLike<number>} b
 * @param {object} [options]
 * @param {number} [options.threshold] Channel-sum above which a pixel counts as changed.
 * @returns {object} `{pixels, changedPixels, changedFraction, meanAbsRgbDelta, maxChannelDelta}`
 */
export function imageDeltaMetrics(a, b, options = {}) {
  const threshold = options.threshold ?? CHANGED_PIXEL_THRESHOLD;
  if (
    !a ||
    !b ||
    a.length !== b.length ||
    a.length === 0 ||
    a.length % 4 !== 0
  ) {
    // A structural mismatch is NOT a delta of zero. Returning `null` metrics
    // forces the caller to treat it as the structural failure it is.
    return {
      ok: false,
      reason:
        !a || !b
          ? "missing buffer"
          : a.length !== b.length
            ? "buffer length mismatch"
            : "buffer is empty or not RGBA",
      pixels: 0,
      changedPixels: null,
      changedFraction: null,
      meanAbsRgbDelta: null,
      maxChannelDelta: null,
    };
  }
  let changedPixels = 0;
  let total = 0;
  let maxChannelDelta = 0;
  for (let i = 0; i < a.length; i += 4) {
    const dr = Math.abs(a[i] - b[i]);
    const dg = Math.abs(a[i + 1] - b[i + 1]);
    const db = Math.abs(a[i + 2] - b[i + 2]);
    const sum = dr + dg + db;
    total += sum;
    if (dr > maxChannelDelta) maxChannelDelta = dr;
    if (dg > maxChannelDelta) maxChannelDelta = dg;
    if (db > maxChannelDelta) maxChannelDelta = db;
    if (sum > threshold) {
      changedPixels++;
    }
  }
  const pixels = a.length / 4;
  return {
    ok: true,
    reason: null,
    pixels,
    changedPixels,
    changedFraction: +(changedPixels / pixels).toFixed(6),
    meanAbsRgbDelta: +(total / (pixels * 3)).toFixed(6),
    maxChannelDelta,
  };
}

/**
 * Consecutive-frame deltas across an ordered capture series. This is the
 * framewise motion metric the wind/time lanes compare against each other.
 *
 * @param {Array<ArrayLike<number>>} frames Ordered RGBA buffers.
 * @param {object} [options] Passed through to {@link imageDeltaMetrics}.
 * @returns {object} `{steps, meanAbsRgbDelta, maxAbsRgbDelta, maxChangedFraction, series, ok}`
 */
export function framewiseDeltaSeries(frames, options = {}) {
  const list = Array.isArray(frames) ? frames : [];
  if (list.length < 2) {
    return {
      ok: false,
      reason: "need at least two frames to form a delta",
      steps: 0,
      meanAbsRgbDelta: null,
      maxAbsRgbDelta: null,
      maxChangedFraction: null,
      series: [],
    };
  }
  const series = [];
  for (let i = 1; i < list.length; i++) {
    series.push(imageDeltaMetrics(list[i - 1], list[i], options));
  }
  const bad = series.find((entry) => entry.ok === false);
  if (bad) {
    return {
      ok: false,
      reason: bad.reason,
      steps: series.length,
      meanAbsRgbDelta: null,
      maxAbsRgbDelta: null,
      maxChangedFraction: null,
      series,
    };
  }
  const means = series.map((entry) => entry.meanAbsRgbDelta);
  return {
    ok: true,
    reason: null,
    steps: series.length,
    meanAbsRgbDelta: +(
      means.reduce((total, value) => total + value, 0) / means.length
    ).toFixed(6),
    maxAbsRgbDelta: +Math.max(...means).toFixed(6),
    maxChangedFraction: +Math.max(
      ...series.map((entry) => entry.changedFraction),
    ).toFixed(6),
    series,
  };
}

/**
 * Ghost metric for the pan-and-return sequence.
 *
 * THE ORACLE. With a pinned clock and zero wind the scene is time-invariant, so
 * a frame captured at pose P before a pan and a frame captured at the SAME pose
 * P after the pan and a full reconvergence must agree. Whatever they disagree by
 * is history the reconstruction failed to discard — a comet trail, a doubled
 * edge, a disocclusion hole. The reference is the run's own earlier frame, so
 * this needs no stored baseline and cannot drift with the content.
 *
 * `floorMeanAbsRgbDelta` is the same run's static frame-to-frame noise: the
 * ghost is only meaningful ABOVE the floor, and reporting the ratio keeps a
 * reader from treating dither as ghosting.
 *
 * @param {object} inputs
 * @param {ArrayLike<number>} inputs.reference Converged frame at pose P, pre-motion.
 * @param {ArrayLike<number>} inputs.reconverged Converged frame at pose P, post-motion.
 * @param {ArrayLike<number>} [inputs.motionMid] A frame captured mid-motion (context only).
 * @param {number} [inputs.floorMeanAbsRgbDelta] Static noise floor from the same run.
 * @returns {object}
 */
export function ghostMetrics(inputs = {}) {
  const residual = imageDeltaMetrics(inputs.reference, inputs.reconverged);
  const motion =
    inputs.motionMid !== undefined
      ? imageDeltaMetrics(inputs.reference, inputs.motionMid)
      : null;
  const floor = Number.isFinite(inputs.floorMeanAbsRgbDelta)
    ? inputs.floorMeanAbsRgbDelta
    : null;
  const ratio =
    residual.ok && floor !== null && floor > 0
      ? +(residual.meanAbsRgbDelta / floor).toFixed(4)
      : null;
  return {
    ok: residual.ok,
    reason: residual.reason,
    residual,
    motion,
    floorMeanAbsRgbDelta: floor,
    // How many times the run's own static noise the residual is. `null` when no
    // floor was supplied — an unanchored ghost number is not a verdict.
    ghostOverFloor: ratio,
  };
}

// ── Temporal history reset decoding ────────────────────────────────────────

/**
 * Bit index -> name, mirroring `WebGPUCloudTemporalHistory.ts`.
 *
 * This table is a MIRROR and is treated as one: `cloud-tour-sequences.spec.mjs`
 * imports the engine's own `CLOUD_TEMPORAL_RESET_*` constants and asserts that
 * every one of them decodes to exactly one name here and that this table holds
 * no bit the engine does not define. A renamed or renumbered engine bit is
 * therefore a Node-test failure, not a probe that quietly reports the wrong
 * cause.
 */
export const CLOUD_TEMPORAL_RESET_BIT_NAMES = Object.freeze({
  0: "INITIAL",
  1: "MISSING_TRANSFORM",
  2: "FRAME_GAP",
  3: "TELEPORT",
  4: "SCENE_MODE",
  5: "MORPH",
  6: "PROJECTION",
  7: "REACTIVATED",
  8: "DECK_BOUNDS",
  9: "MULTI_DECK",
  10: "RESOURCE",
});

/**
 * Decode a reset bitmask into names.
 *
 * @param {number} bits
 * @returns {string[]} Names, ascending by bit. An unknown bit decodes as
 *   `BIT_<n>` rather than being dropped — a silently ignored bit is how a probe
 *   comes to report "no reset" for a reset it does not recognize.
 */
export function decodeResetReasons(bits) {
  if (!Number.isInteger(bits) || bits === 0) {
    return [];
  }
  const names = [];
  for (let bit = 0; bit < 32; bit++) {
    if ((bits & (1 << bit)) === 0) {
      continue;
    }
    names.push(CLOUD_TEMPORAL_RESET_BIT_NAMES[bit] ?? `BIT_${bit}`);
  }
  return names;
}

/**
 * Judge one phase's observed reset mask against its declaration.
 *
 * @param {object} phase Sequence phase carrying `expectResetBits`/`forbidResetBits`.
 * @param {number} observedBits Mask observed on the phase's frames.
 * @returns {object} `{ok, expected, forbidden, observed, missing, unexpected}`
 */
export function assessPhaseReset(phase, observedBits) {
  const expected = Number.isInteger(phase?.expectResetBits)
    ? phase.expectResetBits
    : null;
  const forbidden = Number.isInteger(phase?.forbidResetBits)
    ? phase.forbidResetBits
    : 0;
  const observed = Number.isInteger(observedBits) ? observedBits : null;
  if (observed === null) {
    return {
      ok: false,
      reason: "no reset mask observed",
      expected,
      forbidden,
      observed,
      missing: [],
      unexpected: [],
    };
  }
  const missingBits = expected === null ? 0 : expected & ~observed;
  const unexpectedBits = observed & forbidden;
  // `expectResetBits: 0` means "this phase must not reset AT ALL" — a settled
  // phase that still resets is the failure mode a nonzero-only check misses.
  const strayBits = expected === 0 ? observed : 0;
  return {
    ok: missingBits === 0 && unexpectedBits === 0 && strayBits === 0,
    reason: null,
    expected,
    forbidden,
    observed,
    expectedNames: expected === null ? null : decodeResetReasons(expected),
    observedNames: decodeResetReasons(observed),
    missing: decodeResetReasons(missingBits),
    unexpected: decodeResetReasons(unexpectedBits | strayBits),
  };
}

// ── Tier derivation ────────────────────────────────────────────────────────

/**
 * Quality-flag bit positions consumed by the tier derivation, mirroring
 * `WebGPUCloudTierPresets.ts`. Pinned against the engine's exported constants by
 * the spec for the same reason as the reset-bit table.
 */
export const CLOUD_QF_BITS = Object.freeze({
  NOISE_BAKED: 1 << 0,
  HALF_RES: 1 << 1,
  TEMPORAL: 1 << 2,
  JITTER: 1 << 3,
  LIGHT_CONE: 1 << 10,
  PLANET_DENSITY: 1 << 13,
});

/**
 * Derive the ACTIVE tier from what the shader actually took.
 *
 * The renderer stores no tier index on its cache, so the honest options are to
 * re-run `resolveCloudPreset` on the CPU (a twin that will drift) or to read the
 * realized uniforms back. This does the latter: the tier is identified by the
 * quality-flag bits plus the realized light-step count, which the preset table
 * makes unique. When they do not identify a single preset the result says so
 * (`confidence: "ambiguous"`) instead of guessing — a manifest that reports the
 * wrong tier is worse than one that reports an unknown tier.
 *
 * @param {object} realization `{qualityFlags, lightSteps, maxSteps}` read from
 *   `context._cloudCache.uniformData`.
 * @param {object} [bits] Override for {@link CLOUD_QF_BITS} (the spec injects the
 *   engine's own constants).
 * @returns {object} `{tier, tierName, confidence, evidence}`
 */
export function deriveCloudTier(realization = {}, bits = CLOUD_QF_BITS) {
  const flags = Number.isInteger(realization.qualityFlags)
    ? realization.qualityFlags
    : null;
  const lightSteps = Number.isFinite(realization.lightSteps)
    ? realization.lightSteps
    : null;
  const evidence = {
    qualityFlags: flags,
    lightSteps,
    maxSteps: Number.isFinite(realization.maxSteps)
      ? realization.maxSteps
      : null,
    baked: flags === null ? null : (flags & bits.NOISE_BAKED) !== 0,
    halfRes: flags === null ? null : (flags & bits.HALF_RES) !== 0,
    temporal: flags === null ? null : (flags & bits.TEMPORAL) !== 0,
    lightCone: flags === null ? null : (flags & bits.LIGHT_CONE) !== 0,
    planetDensity: flags === null ? null : (flags & bits.PLANET_DENSITY) !== 0,
  };
  if (flags === null) {
    return {
      tier: null,
      tierName: "unknown",
      confidence: "unrealized",
      evidence,
    };
  }
  if (!evidence.baked) {
    // The power-user escape hatch forces LIVE noise with no reconstruction. It
    // is not one of the four presets and must not be reported as T1 just
    // because `resolveCloudPreset` labels it `tier: 1`.
    return {
      tier: null,
      tierName: "escape-hatch-live",
      confidence: "escape-hatch",
      evidence,
    };
  }
  if (evidence.halfRes && evidence.temporal && evidence.lightCone) {
    if (lightSteps === 3) {
      return { tier: 1, tierName: "T1-low", confidence: "exact", evidence };
    }
    if (lightSteps === 4) {
      return { tier: 2, tierName: "T2-medium", confidence: "exact", evidence };
    }
    return {
      tier: null,
      tierName: "T1-or-T2",
      confidence: "ambiguous",
      evidence,
    };
  }
  if (!evidence.halfRes && !evidence.temporal && !evidence.lightCone) {
    return { tier: 3, tierName: "T3-cinematic", confidence: "exact", evidence };
  }
  return {
    tier: null,
    tierName: "unmatched",
    confidence: "ambiguous",
    evidence,
  };
}

// ── GPU timestamps ─────────────────────────────────────────────────────────

/**
 * Reduce the WebGPU timestamp profiler's result object to the passes a sequence
 * declared, keeping the profiler's own health counters alongside.
 *
 * A pass the profiler never saw is recorded as `present: false` with `null`
 * timings — never as zero. A zero would average into an A/B as a real, very fast
 * pass.
 *
 * @param {object|null} results `context.timestampProfiler.getResults()`.
 * @param {string[]} passNames Labels the sequence declared.
 * @returns {object}
 */
export function summarizeGpuPasses(results, passNames) {
  const names = Array.isArray(passNames) ? passNames : [];
  const passes = {};
  for (const name of names) {
    const timing = results?.passes?.[name];
    passes[name] = timing
      ? {
          present: true,
          avgMs: timing.avgMs ?? null,
          minMs: timing.minMs ?? null,
          maxMs: timing.maxMs ?? null,
          lastMs: timing.lastMs ?? null,
        }
      : {
          present: false,
          avgMs: null,
          minMs: null,
          maxMs: null,
          lastMs: null,
        };
  }
  return {
    passes,
    profiler: results
      ? {
          enabled: results.enabled ?? null,
          frameCount: results.frameCount ?? null,
          attemptedFrameCount: results.attemptedFrameCount ?? null,
          droppedPassCount: results.droppedPassCount ?? null,
          readbackSkipCount: results.readbackSkipCount ?? null,
          failedReadbackCount: results.failedReadbackCount ?? null,
          coverageRatio: results.coverageRatio ?? null,
          observedPassNames: Object.keys(results.passes ?? {}),
        }
      : null,
    observedCount: names.filter((name) => passes[name].present).length,
    declaredCount: names.length,
  };
}

// ── Per-sequence metric completeness ───────────────────────────────────────

/**
 * Every path a per-sequence record MUST carry, straight out of the C13-01 row's
 * recording sentence. `null` is an acceptable VALUE for the GPU timings (a
 * device without `timestamp-query` is a fact, not a gap) but the KEY must exist,
 * which is why this checks presence rather than truthiness.
 */
export const REQUIRED_SEQUENCE_METRIC_PATHS = Object.freeze([
  "id",
  "kind",
  "fixtureId",
  "replayKey",
  "provenance.commit",
  "provenance.runtimeBundle.sha256",
  "provenance.runtimeBundle.byteLength",
  "environment.adapterInfo",
  "environment.browserVersion",
  "environment.canvas.width",
  "environment.canvas.height",
  "configuration.requestedVolumetric",
  "configuration.configTruth",
  "clock.baseIso",
  "clock.stepSeconds",
  "clock.frames",
  "realization.tier",
  "realization.tierName",
  "realization.tierEvidence",
  "realization.currentTarget.width",
  "realization.currentTarget.height",
  "realization.historyTarget.width",
  "realization.historyTarget.height",
  "cpuFrames.count",
  "cpuFrames.p50Ms",
  "cpuFrames.p95Ms",
  "cpuFrames.p99Ms",
  "gpu.supported",
  "gpu.passes",
  "gpu.profiler",
  "temporal.phases",
  "temporal.framewise",
  "temporal.ghost",
  "screenshots",
  "structural.ok",
]);

function hasPath(object, path) {
  let cursor = object;
  for (const key of path.split(".")) {
    if (cursor === null || typeof cursor !== "object" || !(key in cursor)) {
      return false;
    }
    cursor = cursor[key];
  }
  return true;
}

/**
 * Completeness + internal-consistency check for one per-sequence record.
 *
 * @param {object} record
 * @returns {string[]} Failures; empty means the record is complete.
 */
export function validateSequenceMetricRecord(record) {
  const failures = [];
  const id = record?.id ?? "(unnamed)";
  for (const path of REQUIRED_SEQUENCE_METRIC_PATHS) {
    if (!hasPath(record, path)) {
      failures.push(`${id}: missing required metric path ${path}`);
    }
  }
  if (!Array.isArray(record?.screenshots) || record.screenshots.length === 0) {
    failures.push(`${id}: no screenshots recorded`);
  } else {
    for (const shot of record.screenshots) {
      if (typeof shot?.phase !== "string" || typeof shot?.path !== "string") {
        failures.push(`${id}: a screenshot entry lacks phase/path`);
      }
      if (typeof shot?.sha256 !== "string" || shot.sha256.length !== 64) {
        failures.push(
          `${id}: screenshot ${String(shot?.phase)} lacks a sha256 — without ` +
            "one a stale artifact from a previous run cannot be told from this run's",
        );
      }
    }
  }
  if (Array.isArray(record?.temporal?.phases)) {
    for (const phase of record.temporal.phases) {
      if (typeof phase?.id !== "string") {
        failures.push(`${id}: a temporal phase entry lacks an id`);
      }
      if (
        phase?.reset !== undefined &&
        phase.reset?.ok === false &&
        !phase.reset.reason
      ) {
        // A failing reset assessment must name what was missing/unexpected.
        if (
          (phase.reset.missing?.length ?? 0) === 0 &&
          (phase.reset.unexpected?.length ?? 0) === 0
        ) {
          failures.push(
            `${id}/${phase.id}: reset assessment failed without naming a cause`,
          );
        }
      }
    }
  }
  if (record?.gpu?.supported === true && record?.gpu?.profiler === null) {
    failures.push(
      `${id}: GPU timestamps reported as supported but no profiler result was captured`,
    );
  }
  if (
    Number.isFinite(record?.clock?.stepSeconds) &&
    record.clock.stepSeconds > 0 &&
    typeof record?.clock?.endIso !== "string"
  ) {
    failures.push(
      `${id}: an advancing clock must record its end instant, or the walk is unverifiable`,
    );
  }
  return failures;
}

// ── Interleaved A/B ────────────────────────────────────────────────────────

/** Percent band inside which a control pass is considered stable. */
export const DEFAULT_DRIFT_BAND_PCT = 2;

/**
 * Default drift CONTROLS for a sequence set.
 *
 * A control pass is one the change under test is not supposed to touch; if it
 * moves, the session is drifting and the round is discarded rather than
 * interpreted. The default treats every declared pass that is NOT a cloud march
 * as a control — the reconstruction resolve and the upscale composite sit
 * downstream of the density/march work a cloud change usually targets.
 *
 * THIS IS A GUESS ABOUT THE CHANGE, not a fact about the renderer. If the change
 * under test touches the resolve or the composite, override it, or every round
 * will be discarded as drift.
 *
 * @param {object[]} sequences
 * @returns {Record<string, string[]>}
 */
export function defaultControlPasses(sequences) {
  const controls = {};
  for (const sequence of sequences ?? []) {
    const passes = (sequence.gpuPasses ?? []).filter(
      (name) => !name.startsWith("ProceduralClouds"),
    );
    if (passes.length > 0) {
      controls[sequence.id] = passes;
    }
  }
  return controls;
}

/**
 * Parse a `TOUR_CONTROL_PASSES` override of the form
 * `seqId:Pass A|Pass B,otherSeq:Pass C`. An empty spec falls back to
 * {@link defaultControlPasses}.
 *
 * @param {string|undefined} spec
 * @param {object[]} sequences
 * @returns {Record<string, string[]>}
 */
export function parseControlPasses(spec, sequences) {
  if (!spec) {
    return defaultControlPasses(sequences);
  }
  const controls = {};
  for (const entry of String(spec).split(",")) {
    const separator = entry.indexOf(":");
    if (separator < 0) {
      throw new Error(
        `control-pass entry must be "<sequenceId>:<pass>|<pass>": ${entry}`,
      );
    }
    const id = entry.slice(0, separator).trim();
    const passes = entry
      .slice(separator + 1)
      .split("|")
      .map((name) => name.trim())
      .filter(Boolean);
    if (id.length === 0 || passes.length === 0) {
      throw new Error(
        `control-pass entry names no sequence or no pass: ${entry}`,
      );
    }
    controls[id] = passes;
  }
  return controls;
}

function environmentKey(manifest) {
  return stableStringify({
    manifestVersion: manifest?.manifestVersion ?? null,
    adapterInfo: manifest?.environment?.adapterInfo ?? null,
    browserVersion: manifest?.environment?.browserVersion ?? null,
    canvas: manifest?.environment?.canvas ?? null,
    viewport: manifest?.environment?.viewport ?? null,
    measurement: manifest?.measurement ?? null,
  });
}

function passDelta(preMs, postMs) {
  if (!Number.isFinite(preMs) || !Number.isFinite(postMs) || preMs <= 0) {
    return {
      preMs: preMs ?? null,
      postMs: postMs ?? null,
      deltaMs: null,
      deltaPct: null,
    };
  }
  const deltaMs = +(postMs - preMs).toFixed(6);
  return {
    preMs,
    postMs,
    deltaMs,
    deltaPct: +((deltaMs / preMs) * 100).toFixed(2),
  };
}

/**
 * Assess a set of manifests as an INTERLEAVED A/B.
 *
 * The protocol this enforces, and why each clause exists:
 *   1. Both bundles must be BUILT ONCE and swapped, so a `pre` and a `post` in
 *      the same round must differ by `runtimeBundle.sha256`. Identical shas mean
 *      the same binary was measured twice and there is no A/B at all.
 *   2. At least TWO rounds. One round cannot distinguish an effect from a
 *      session's thermal/residency drift.
 *   3. At least one round in each ORDER. A real effect reproduces when the post
 *      bundle is measured first; drift does not.
 *   4. Untouched CONTROL passes must stay inside the drift band. A round whose
 *      controls moved is DISCARDED, not interpreted — that is precisely the
 *      failure that invented the 2026-07-24 numbers.
 *   5. The two halves must have replayed the same definitions: identical
 *      environment, measurement settings, and per-sequence replay keys.
 *
 * @param {object} input
 * @param {object[]} input.manifests All manifests belonging to one pair id.
 * @param {Record<string, string[]>} [input.controlPasses] sequenceId -> pass labels
 *   expected to be unaffected by the change under test.
 * @param {number} [input.driftBandPct]
 * @returns {object} `{status, failures, rounds, verdict}`
 */
export function assessInterleavedAb(input = {}) {
  const manifests = Array.isArray(input.manifests) ? input.manifests : [];
  const controlPasses = input.controlPasses ?? {};
  const band = input.driftBandPct ?? DEFAULT_DRIFT_BAND_PCT;
  const failures = [];

  if (manifests.length === 0) {
    return {
      status: "no-manifests",
      failures: ["no manifests supplied"],
      rounds: [],
      verdict: null,
    };
  }
  const pairIds = new Set(
    manifests.map((manifest) => manifest?.pairId ?? null),
  );
  if (pairIds.size !== 1 || pairIds.has(null)) {
    return {
      status: "incomparable-pair",
      failures: [
        `manifests must share exactly one non-null pairId (saw ${[...pairIds].join(", ")})`,
      ],
      rounds: [],
      verdict: null,
    };
  }
  const environmentKeys = new Set(manifests.map(environmentKey));
  if (environmentKeys.size !== 1) {
    return {
      status: "incomparable-environment",
      failures: [
        "manifest version, adapter, browser, canvas, viewport and measurement " +
          "settings must be identical across every manifest in the pair",
      ],
      rounds: [],
      verdict: null,
    };
  }

  const byRound = new Map();
  for (const manifest of manifests) {
    const round = manifest?.round;
    if (!Number.isInteger(round) || round < 0) {
      failures.push(
        `a manifest carries a non-integer round (${String(round)})`,
      );
      continue;
    }
    const entry = byRound.get(round) ?? {
      round,
      order: manifest?.order ?? null,
    };
    if (manifest?.tag === "pre") {
      entry.pre = manifest;
    } else if (manifest?.tag === "post") {
      entry.post = manifest;
    } else {
      failures.push(`round ${round}: unknown tag ${String(manifest?.tag)}`);
    }
    if (entry.order !== (manifest?.order ?? null)) {
      failures.push(
        `round ${round}: the two halves disagree about the measurement order`,
      );
    }
    byRound.set(round, entry);
  }

  const rounds = [];
  for (const entry of [...byRound.values()].sort((a, b) => a.round - b.round)) {
    const roundFailures = [];
    if (!entry.pre || !entry.post) {
      roundFailures.push("incomplete round (needs one pre and one post)");
      rounds.push({
        round: entry.round,
        order: entry.order,
        complete: false,
        usable: false,
        failures: roundFailures,
        sequences: [],
      });
      continue;
    }
    const preSha = entry.pre.source?.runtimeBundle?.sha256;
    const postSha = entry.post.source?.runtimeBundle?.sha256;
    if (typeof preSha !== "string" || typeof postSha !== "string") {
      roundFailures.push("a half is missing its runtime-bundle sha256");
    } else if (preSha === postSha) {
      roundFailures.push(
        "pre and post measured the SAME runtime bundle — this is one binary " +
          "measured twice, not an A/B",
      );
    }
    if (!["pre-first", "post-first"].includes(entry.order)) {
      roundFailures.push(
        `round order must be declared as pre-first or post-first (saw ${String(entry.order)})`,
      );
    }

    const preSequences = new Map(
      (entry.pre.sequences ?? []).map((record) => [record.id, record]),
    );
    const sequences = [];
    let controlDrifted = false;
    for (const postRecord of entry.post.sequences ?? []) {
      const preRecord = preSequences.get(postRecord.id);
      if (!preRecord) {
        roundFailures.push(`sequence ${postRecord.id} has no pre companion`);
        continue;
      }
      const sameReplay = preRecord.replayKey === postRecord.replayKey;
      if (!sameReplay) {
        roundFailures.push(
          `sequence ${postRecord.id}: replay keys differ — the two halves did ` +
            "not run the same definition",
        );
      }
      const bothValid =
        preRecord.structural?.ok === true && postRecord.structural?.ok === true;
      const passes = {};
      const controls = controlPasses[postRecord.id] ?? [];
      for (const name of Object.keys(postRecord.gpu?.passes ?? {})) {
        const delta = passDelta(
          preRecord.gpu?.passes?.[name]?.avgMs,
          postRecord.gpu?.passes?.[name]?.avgMs,
        );
        const isControl = controls.includes(name);
        const stable =
          delta.deltaPct === null ? null : Math.abs(delta.deltaPct) <= band;
        if (isControl && stable === false) {
          controlDrifted = true;
        }
        passes[name] = { ...delta, control: isControl, withinBand: stable };
      }
      sequences.push({
        id: postRecord.id,
        sameReplay,
        bothValid,
        passes,
      });
    }
    const usable =
      roundFailures.length === 0 &&
      !controlDrifted &&
      sequences.length > 0 &&
      sequences.every((sequence) => sequence.bothValid && sequence.sameReplay);
    if (controlDrifted) {
      roundFailures.push(
        `a control pass moved by more than ${band}% — this round is DISCARDED as ` +
          "session drift and must not be interpreted",
      );
    }
    rounds.push({
      round: entry.round,
      order: entry.order,
      complete: true,
      usable,
      controlDrifted,
      failures: roundFailures,
      sequences,
    });
  }

  const usableRounds = rounds.filter((round) => round.usable);
  const orders = new Set(usableRounds.map((round) => round.order));
  if (rounds.length < 2) {
    return {
      status: "insufficient-rounds",
      failures: [
        ...failures,
        `only ${rounds.length} round(s) — the protocol requires at least two ` +
          "alternating rounds within one session",
      ],
      rounds,
      verdict: null,
    };
  }
  if (usableRounds.length < 2) {
    return {
      status: "session-drifting",
      failures: [
        ...failures,
        `only ${usableRounds.length} usable round(s) after discarding drifting or ` +
          "incomplete rounds — the session cannot answer the question",
      ],
      rounds,
      verdict: null,
    };
  }
  if (!(orders.has("pre-first") && orders.has("post-first"))) {
    return {
      status: "no-reverse-order",
      failures: [
        ...failures,
        "every usable round ran in the same order — a real effect must reproduce " +
          "with the post bundle measured first",
      ],
      rounds,
      verdict: null,
    };
  }

  // An effect is only reported when it reproduces in EVERY usable round with the
  // same sign and outside the band.
  // Pass identity is the PAIR (sequenceId, passName), and pass labels contain
  // spaces ("ProceduralClouds pass"), so a joined string key cannot be split
  // back apart on any separator that reads naturally. Carry the pair itself and
  // build the display key once, at the end.
  const verdict = {};
  const passPairs = new Map();
  for (const round of usableRounds) {
    for (const sequence of round.sequences) {
      for (const name of Object.keys(sequence.passes)) {
        passPairs.set(`${sequence.id} / ${name}`, {
          sequenceId: sequence.id,
          passName: name,
        });
      }
    }
  }
  for (const [displayKey, { sequenceId, passName }] of passPairs) {
    const deltas = usableRounds.map((round) => {
      const sequence = round.sequences.find((entry) => entry.id === sequenceId);
      return sequence?.passes?.[passName]?.deltaPct ?? null;
    });
    const present = deltas.filter((value) => value !== null);
    let direction = "inconclusive";
    if (present.length === deltas.length && present.length > 0) {
      if (present.every((value) => value < -band)) {
        direction = "faster";
      } else if (present.every((value) => value > band)) {
        direction = "slower";
      } else if (present.every((value) => Math.abs(value) <= band)) {
        direction = "unchanged";
      }
    }
    verdict[displayKey] = {
      sequenceId,
      passName,
      deltaPctPerRound: deltas,
      direction,
      reproducible: direction !== "inconclusive",
    };
  }

  return {
    status: "assessed",
    failures,
    rounds,
    verdict,
  };
}

export default {
  SEQUENCE_MANIFEST_VERSION,
  CHANGED_PIXEL_THRESHOLD,
  CLOUD_TEMPORAL_RESET_BIT_NAMES,
  CLOUD_QF_BITS,
  REQUIRED_SEQUENCE_METRIC_PATHS,
  DEFAULT_DRIFT_BAND_PCT,
  defaultControlPasses,
  parseControlPasses,
  frameDistribution,
  imageDeltaMetrics,
  framewiseDeltaSeries,
  ghostMetrics,
  decodeResetReasons,
  assessPhaseReset,
  deriveCloudTier,
  summarizeGpuPasses,
  validateSequenceMetricRecord,
  assessInterleavedAb,
};
