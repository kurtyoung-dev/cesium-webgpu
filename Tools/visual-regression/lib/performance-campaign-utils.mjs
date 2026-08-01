function percentile(values, fraction) {
  const sorted = values
    .filter(Number.isFinite)
    .slice()
    .sort((left, right) => left - right);
  if (!sorted.length) {
    return null;
  }
  if (sorted.length === 1) {
    return sorted[0];
  }
  const position = (sorted.length - 1) * fraction;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

function distribution(values) {
  const finite = values.filter(Number.isFinite);
  if (!finite.length) {
    return null;
  }
  const total = finite.reduce((sum, value) => sum + value, 0);
  return {
    count: finite.length,
    avg: total / finite.length,
    total,
    min: Math.min(...finite),
    max: Math.max(...finite),
    p50: percentile(finite, 0.5),
    p95: percentile(finite, 0.95),
    p99: percentile(finite, 0.99),
  };
}

/**
 * Diff cumulative API owner-label histograms at a measured-window boundary.
 * Empty/zero buckets are omitted so instrumented artifacts remain bounded.
 */
export function diffCounterLabelSnapshots(start = {}, end = {}) {
  const result = {};
  const counters = new Set([...Object.keys(start), ...Object.keys(end)]);
  for (const counter of [...counters].sort()) {
    const startBucket = start[counter] || {};
    const endBucket = end[counter] || {};
    const labels = new Set([
      ...Object.keys(startBucket),
      ...Object.keys(endBucket),
    ]);
    const delta = {};
    for (const label of [...labels].sort()) {
      const value = (endBucket[label] || 0) - (startBucket[label] || 0);
      if (value !== 0) {
        delta[label] = value;
      }
    }
    if (Object.keys(delta).length > 0) {
      result[counter] = delta;
    }
  }
  return result;
}

/** Diff a flat cumulative logical-counter snapshot at a measured boundary. */
export function diffFlatCounterSnapshots(start = {}, end = {}) {
  return Object.fromEntries(
    [...new Set([...Object.keys(start), ...Object.keys(end)])]
      .sort()
      .map((name) => [name, (end[name] || 0) - (start[name] || 0)])
      .filter(([, value]) => value !== 0),
  );
}

/**
 * Select long tasks that began inside the measured window and clip a terminal
 * task at the exact end boundary. A setup task delivered asynchronously after
 * measurement starts is excluded because its start timestamp precedes the
 * window.
 */
export function selectLongTasksInMeasurementWindow(
  entries = [],
  windowStartMs,
  windowEndMs,
) {
  return entries
    .filter(
      (entry) =>
        Number.isFinite(entry?.startTime) &&
        Number.isFinite(entry?.duration) &&
        entry.startTime >= windowStartMs &&
        entry.startTime < windowEndMs,
    )
    .map((entry) => ({
      ...entry,
      rawDuration: entry.duration,
      duration: Math.min(
        entry.duration,
        Math.max(0, windowEndMs - entry.startTime),
      ),
    }));
}

/**
 * Build alternating A/B then B/A execution order. Each repetition still means
 * one run per selected renderer, preserving the runner's public CLI semantics.
 */
export function buildCounterbalancedSchedule(renderers, repetitions) {
  const selected = [...renderers];
  const schedule = [];
  for (let repetition = 1; repetition <= repetitions; repetition++) {
    const order =
      selected.length === 2 && repetition % 2 === 0
        ? [selected[1], selected[0]]
        : [...selected];
    schedule.push({ repetition, order });
  }
  return schedule;
}

export function summarizeFramePacing(samples, refreshHz = 60) {
  // C11-173 — callers pass the measured display rate; a bad measurement
  // must not poison the frame budget with a NaN/Infinity divisor.
  if (!Number.isFinite(refreshHz) || refreshHz <= 0) {
    refreshHz = 60;
  }
  const wallValues = samples
    .map((sample) => sample.wallDtMs)
    .filter(Number.isFinite);
  const wall = distribution(wallValues);
  if (!wall) {
    return {
      sampleCount: 0,
      averageFps: null,
      onePercentLowFps: null,
      droppedFramesAtRefreshRate: null,
      framesOverBudget: null,
      refreshHz,
    };
  }
  const budgetMs = 1000 / refreshHz;
  let droppedFrames = 0;
  let framesOverBudget = 0;
  for (const wallMs of wallValues) {
    if (wallMs > budgetMs) {
      framesOverBudget++;
    }
    droppedFrames += Math.max(0, Math.floor(wallMs / budgetMs) - 1);
  }
  return {
    sampleCount: wall.count,
    elapsedMs: wall.total ?? wallValues.reduce((sum, value) => sum + value, 0),
    averageFps: wall.avg > 0 ? 1000 / wall.avg : null,
    onePercentLowFps: wall.p99 > 0 ? 1000 / wall.p99 : null,
    droppedFramesAtRefreshRate: droppedFrames,
    framesOverBudget,
    refreshHz,
    frameBudgetMs: budgetMs,
    wallMs: wall,
  };
}

/**
 * Join route evidence to trace samples only when there is a one-to-one match.
 * This avoids publishing misleading per-segment GPU/CPU values after an event
 * ordering change or timestamp readback skew.
 */
export function summarizeTrackMetrics(samples, evidence, waypoints) {
  const expectedSegmentCount = Math.max(0, waypoints.length - 1);
  const observedHeights = evidence
    .map((entry) => entry.height)
    .filter(Number.isFinite);
  const observedProgress = evidence
    .map((entry) => entry.routeProgress)
    .filter(Number.isFinite);
  const observedSegments = [
    ...new Set(evidence.map((entry) => entry.segmentIndex)),
  ]
    .filter((index) => Number.isInteger(index))
    .sort((left, right) => left - right);
  const aligned = samples.length > 0 && samples.length === evidence.length;
  const result = {
    aligned,
    traceSampleCount: samples.length,
    evidenceSampleCount: evidence.length,
    expectedSegmentCount,
    observedSegments,
    coveredAllSegments:
      observedSegments.length === expectedSegmentCount &&
      observedSegments.every((segment, index) => segment === index),
    observedProgressRange: observedProgress.length
      ? {
          min: Math.min(...observedProgress),
          max: Math.max(...observedProgress),
        }
      : null,
    completedRoute:
      observedProgress.length > 0 && Math.max(...observedProgress) >= 0.999,
    expectedHeightRange: {
      min: Math.min(...waypoints.map((waypoint) => waypoint.height)),
      max: Math.max(...waypoints.map((waypoint) => waypoint.height)),
    },
    observedHeightRange: observedHeights.length
      ? { min: Math.min(...observedHeights), max: Math.max(...observedHeights) }
      : null,
    gpuSegmentAlignment: {
      aligned: false,
      reason:
        "WebGPU timestamp readback is asynchronous and does not expose the originating scene frame number",
    },
    segments: null,
  };
  if (!aligned) {
    return result;
  }

  result.segments = [];
  for (
    let segmentIndex = 0;
    segmentIndex < expectedSegmentCount;
    segmentIndex++
  ) {
    const indexes = [];
    for (let index = 0; index < evidence.length; index++) {
      if (evidence[index].segmentIndex === segmentIndex) {
        indexes.push(index);
      }
    }
    const metric = (name) =>
      distribution(indexes.map((index) => samples[index]?.[name]));
    const start = waypoints[segmentIndex];
    const end = waypoints[segmentIndex + 1];
    result.segments.push({
      index: segmentIndex,
      name: `${start.name}->${end.name}`,
      sampleCount: indexes.length,
      cpuMs: metric("cpuMs"),
      wallMs: metric("wallDtMs"),
      gpuMs: null,
      observedHeightRange: indexes.length
        ? {
            min: Math.min(...indexes.map((index) => evidence[index].height)),
            max: Math.max(...indexes.map((index) => evidence[index].height)),
          }
        : null,
    });
  }
  return result;
}

/**
 * Verify that the hover-pick workload remained aligned with the measured render
 * trace and actually traversed the viewport. A fixed center pick can hide edge
 * clipping, changing-frustum, and readback-pipeline costs, so it is not accepted
 * as evidence for the continuous-pick lane.
 */
export function summarizeMovingPickMetrics(
  samples,
  evidence,
  telemetryOrPickCallCount,
) {
  const telemetry =
    telemetryOrPickCallCount && typeof telemetryOrPickCallCount === "object"
      ? telemetryOrPickCallCount
      : null;
  const pickCallCount = telemetry
    ? telemetry.publicCalls
    : telemetryOrPickCallCount;
  const positions = evidence.filter(
    (entry) =>
      Number.isFinite(entry.normalizedX) && Number.isFinite(entry.normalizedY),
  );
  const normalizedX = positions.map((entry) => entry.normalizedX);
  const normalizedY = positions.map((entry) => entry.normalizedY);
  const xSpan = normalizedX.length
    ? Math.max(...normalizedX) - Math.min(...normalizedX)
    : 0;
  const ySpan = normalizedY.length
    ? Math.max(...normalizedY) - Math.min(...normalizedY)
    : 0;
  const uniquePositionCount = new Set(
    positions.map((entry) => `${entry.x},${entry.y}`),
  ).size;
  const aligned = samples.length > 0 && samples.length === evidence.length;
  const callsPerTraceFrame = samples.length
    ? pickCallCount / samples.length
    : 0;
  const cursorMovedAcrossViewport =
    xSpan >= 0.5 && ySpan >= 0.5 && uniquePositionCount >= 30;
  const continuous =
    aligned &&
    Number.isFinite(pickCallCount) &&
    callsPerTraceFrame >= 0.95 &&
    callsPerTraceFrame <= 1.05;
  const cpuEvidenceAligned =
    aligned && evidence.every((entry) => Number.isFinite(entry.pickCpuMs));
  const pickCpuValues = cpuEvidenceAligned
    ? evidence.map((entry) => entry.pickCpuMs)
    : [];
  const combinedCpuValues = cpuEvidenceAligned
    ? samples.map((sample, index) =>
        Number.isFinite(sample?.cpuMs)
          ? sample.cpuMs + pickCpuValues[index]
          : Number.NaN,
      )
    : [];
  const unbucketedCpuMs = telemetry?.executionCpuUnbucketedMs ?? 0;
  const expectedPickCpuMs = telemetry
    ? (telemetry.publicCallCpuMs || []).reduce(
        (sum, value) => sum + (Number.isFinite(value) ? value : 0),
        0,
      ) +
      (telemetry.asyncExecutionCpuMs || []).reduce(
        (sum, value) => sum + (Number.isFinite(value) ? value : 0),
        0,
      )
    : null;
  const bucketedPickCpuMs = pickCpuValues.reduce(
    (sum, value) => sum + value,
    0,
  );
  const accountedPickCpuMs = bucketedPickCpuMs + unbucketedCpuMs;
  const cpuAccountingErrorMs = telemetry
    ? Math.abs(expectedPickCpuMs - accountedPickCpuMs)
    : null;
  const cpuAccountingAligned =
    !telemetry ||
    cpuAccountingErrorMs <= Math.max(0.05, expectedPickCpuMs * 0.01);
  const telemetryValid =
    !telemetry ||
    (telemetry.publicApi === "pickHoverAsync" &&
      telemetry.executionCount > 0 &&
      telemetry.completedBeforeDrain > 0 &&
      telemetry.rejectedCalls === 0 &&
      telemetry.pendingCalls === 0 &&
      telemetry.drainStatus === "drained" &&
      telemetry.completedCalls === telemetry.publicCalls &&
      cpuEvidenceAligned &&
      cpuAccountingAligned);
  return {
    aligned,
    continuous,
    cursorMovedAcrossViewport,
    traceSampleCount: samples.length,
    evidenceSampleCount: evidence.length,
    pickCallCount,
    callsPerTraceFrame,
    uniquePositionCount,
    normalizedRange: positions.length
      ? {
          x: { min: Math.min(...normalizedX), max: Math.max(...normalizedX) },
          y: { min: Math.min(...normalizedY), max: Math.max(...normalizedY) },
        }
      : null,
    normalizedSpan: { x: xSpan, y: ySpan },
    telemetryObserved: telemetry !== null,
    telemetryValid,
    cpuEvidenceAligned,
    cpuAccountingAligned,
    expectedPickCpuMs,
    bucketedPickCpuMs,
    unbucketedPickCpuMs: unbucketedCpuMs,
    accountedPickCpuMs,
    cpuAccountingErrorMs,
    pickCpuMs: distribution(pickCpuValues),
    combinedCpuMs: distribution(combinedCpuValues),
    publicCallCpuMs: telemetry
      ? distribution(telemetry.publicCallCpuMs || [])
      : null,
    physicalExecutionCpuMs: telemetry
      ? distribution(telemetry.executionCpuMs || [])
      : null,
    asyncExecutionCpuMs: telemetry
      ? distribution(telemetry.asyncExecutionCpuMs || [])
      : null,
    executionCount: telemetry?.executionCount ?? null,
    executionsPerTraceFrame:
      telemetry && samples.length
        ? telemetry.executionCount / samples.length
        : null,
    completedBeforeDrain: telemetry?.completedBeforeDrain ?? null,
    completedDuringDrain: telemetry?.completedDuringDrain ?? null,
    drainStatus: telemetry?.drainStatus ?? null,
    drainElapsedMs: telemetry?.drainElapsedMs ?? null,
  };
}

/**
 * Validate the C12-29 S5 moving-route evidence. A useful eclipse performance
 * run must prove both sides of the spatial classifier: at least one frame that
 * executes local globe-shadow geometry (gate 1/2) and at least one frame that
 * bypasses it or performs correction-only composition (gate 0/3/4).
 *
 * @param {Array<object>} samples
 * @param {Array<object>} evidence
 * @returns {object}
 */
export function summarizeEclipseGlobeShadowEvidence(samples, evidence) {
  const reasons = [];
  const aligned =
    Array.isArray(samples) &&
    Array.isArray(evidence) &&
    samples.length > 0 &&
    evidence.length === samples.length;
  if (!aligned) {
    reasons.push(
      `eclipse evidence/sample alignment ${evidence?.length ?? 0}/${samples?.length ?? 0}`,
    );
  }

  const gateCounts = {
    0: 0,
    1: 0,
    2: 0,
    3: 0,
    4: 0,
  };
  let invalidGateCount = 0;
  let invalidRevisionCount = 0;
  let invalidObscurationCount = 0;
  for (const row of evidence || []) {
    const gate = row?.eclipseGlobeShadowGate;
    if (
      !Number.isFinite(gate) ||
      !Number.isInteger(gate) ||
      gate < 0 ||
      gate > 4
    ) {
      invalidGateCount++;
    } else {
      gateCounts[gate]++;
    }

    if (!Number.isFinite(row?.eclipseGlobeShadowRevision)) {
      invalidRevisionCount++;
    }
    const obscuration = row?.eclipseMoonObscuration;
    if (
      !Number.isFinite(obscuration) ||
      obscuration < 0.0 ||
      obscuration > 1.0
    ) {
      invalidObscurationCount++;
    }
  }

  if (invalidGateCount > 0) {
    reasons.push(
      `${invalidGateCount} eclipse evidence rows have invalid gates`,
    );
  }
  if (invalidRevisionCount > 0) {
    reasons.push(
      `${invalidRevisionCount} eclipse evidence rows have invalid revisions`,
    );
  }
  if (invalidObscurationCount > 0) {
    reasons.push(
      `${invalidObscurationCount} eclipse evidence rows have invalid obscuration`,
    );
  }

  const localShadowFrameCount = gateCounts[1] + gateCounts[2];
  const bypassOrCorrectionFrameCount =
    gateCounts[0] + gateCounts[3] + gateCounts[4];
  if (localShadowFrameCount === 0) {
    reasons.push("eclipse route never executed local globe-shadow geometry");
  }
  if (bypassOrCorrectionFrameCount === 0) {
    reasons.push(
      "eclipse route never exercised the inactive/correction-only spatial path",
    );
  }

  return {
    valid: reasons.length === 0,
    aligned,
    sampleCount: samples?.length ?? 0,
    evidenceCount: evidence?.length ?? 0,
    gateCounts,
    localShadowFrameCount,
    bypassOrCorrectionFrameCount,
    invalidGateCount,
    invalidRevisionCount,
    invalidObscurationCount,
    reasons,
  };
}

export function assessPerformanceRunQuality(run, options = {}) {
  const minTrackSegmentSamples = options.minTrackSegmentSamples ?? 30;
  const attributionOnly =
    run.apiInstrumentationEnabled === true || run.apiCounters?.enabled === true;
  const reasons = [];
  const warnings = [];
  const elapsedMs = run.measurement?.elapsedMs || 0;
  const longTaskShare =
    elapsedMs > 0 && Number.isFinite(run.longTasks?.totalMs)
      ? run.longTasks.totalMs / elapsedMs
      : 0;
  const timestamps = run.timestampResults;
  const timestampAttempts = timestamps?.attemptedFrameCount || 0;
  const timestampSkipRatio =
    timestampAttempts > 0
      ? (timestamps?.readbackSkipCount || 0) / timestampAttempts
      : 0;
  let cpuValid = true;
  let gpuValid = run.timestampEnabled === true;

  if (run.trackMetrics) {
    if (
      !run.trackMetrics.aligned ||
      !run.trackMetrics.coveredAllSegments ||
      !run.trackMetrics.completedRoute
    ) {
      cpuValid = false;
      gpuValid = false;
      reasons.push("camera track did not produce aligned full-route evidence");
    }
    const segmentCounts = (run.trackMetrics.segments || []).map(
      (segment) => segment.sampleCount || 0,
    );
    const minimumSegmentSamples = segmentCounts.length
      ? Math.min(...segmentCounts)
      : 0;
    if (minimumSegmentSamples < minTrackSegmentSamples) {
      cpuValid = false;
      gpuValid = false;
      reasons.push(
        `camera-track segment has ${minimumSegmentSamples}/${minTrackSegmentSamples} required samples`,
      );
    }
  }

  if (
    run.pickMetrics &&
    (!run.pickMetrics.aligned ||
      !run.pickMetrics.continuous ||
      !run.pickMetrics.cursorMovedAcrossViewport ||
      !run.pickMetrics.telemetryValid)
  ) {
    cpuValid = false;
    gpuValid = false;
    reasons.push(
      "moving-pick workload did not produce aligned, continuous, full-viewport, fully-drained physical-pick evidence",
    );
  }

  if (
    run.eclipseGlobeShadowEvidence &&
    run.eclipseGlobeShadowEvidence.valid !== true
  ) {
    cpuValid = false;
    gpuValid = false;
    reasons.push(...run.eclipseGlobeShadowEvidence.reasons);
  }

  if (run.timestampEnabled) {
    if ((timestamps?.failedReadbackCount || 0) > 0) {
      gpuValid = false;
      reasons.push(
        `${timestamps.failedReadbackCount} timestamp readbacks failed`,
      );
    }
    if (timestampSkipRatio > 0.1) {
      gpuValid = false;
      reasons.push(
        `timestamp readback skipped ${(timestampSkipRatio * 100).toFixed(1)}% of attempted frames`,
      );
    }
    if (timestampSkipRatio > 0.2) {
      warnings.push("timestamp backpressure exceeded the hard 20% limit");
    }
  }

  const suspectedMainThreadContamination =
    run.longTasks?.available === true &&
    longTaskShare > 0.25 &&
    timestampSkipRatio > 0.1;
  if (suspectedMainThreadContamination) {
    cpuValid = false;
    gpuValid = false;
    reasons.push(
      `long-task occupancy ${(longTaskShare * 100).toFixed(1)}% coincided with timestamp backpressure`,
    );
  }

  const measurementValid =
    cpuValid && (run.timestampEnabled !== true || gpuValid);
  if (attributionOnly) {
    warnings.push(
      "GPU API instrumentation is attribution-only and excluded from timing aggregation and certification",
    );
  }
  return {
    status: !measurementValid
      ? "invalid"
      : attributionOnly
        ? "attribution-only"
        : "clean",
    attributionOnly,
    certificationEligible: measurementValid && !attributionOnly,
    measurementValid,
    validForAggregation: measurementValid && !attributionOnly,
    validForCpuAggregation: cpuValid && !attributionOnly,
    validForGpuAggregation: gpuValid && cpuValid && !attributionOnly,
    reasons,
    warnings,
    longTaskShare,
    timestampSkipRatio,
    suspectedMainThreadContamination,
  };
}

export function assessPerformanceRunStability(runs) {
  const attributionOnly =
    runs.length > 0 &&
    runs.every((run) => run.quality?.attributionOnly === true);
  if (attributionOnly) {
    return {
      stable: true,
      reasons: [],
      comparedRunCount: 0,
      attributionOnly: true,
      certificationEligible: false,
    };
  }
  const usable = runs.filter(
    (run) =>
      run.result === "pass" && run.quality?.validForCpuAggregation !== false,
  );
  if (runs.length < 2) {
    return { stable: true, reasons: [], comparedRunCount: usable.length };
  }
  const reasons = [];
  if (usable.length < 2) {
    reasons.push("fewer than two quality-valid repetitions remain");
  } else {
    const cpuP95 = usable
      .map(
        (run) =>
          run.pickMetrics?.combinedCpuMs?.p95 ?? run.trace?.summary?.cpuMs?.p95,
      )
      .filter((value) => Number.isFinite(value) && value > 0);
    if (cpuP95.length >= 2) {
      const ratio = Math.max(...cpuP95) / Math.min(...cpuP95);
      if (ratio > 2) {
        reasons.push(`CPU p95 max/min ratio ${ratio.toFixed(2)} exceeds 2.00`);
      }
    }
    const durationFrames = usable
      .filter((run) => run.requestedMeasurement?.mode === "duration")
      .map((run) => run.measuredFrames)
      .filter((value) => Number.isFinite(value) && value > 0);
    if (durationFrames.length >= 2) {
      const ratio = Math.max(...durationFrames) / Math.min(...durationFrames);
      if (ratio > 1.5) {
        reasons.push(
          `duration-run frame-count max/min ratio ${ratio.toFixed(2)} exceeds 1.50`,
        );
      }
    }
  }
  return {
    stable: reasons.length === 0,
    reasons,
    comparedRunCount: usable.length,
    attributionOnly: false,
    certificationEligible: true,
  };
}

function symmetricDeltaRatio(left, right) {
  if (!Number.isFinite(left) || !Number.isFinite(right)) {
    return null;
  }
  if (left === 0 && right === 0) {
    return 0;
  }
  return Math.abs(left - right) / ((Math.abs(left) + Math.abs(right)) / 2);
}

function levelCountComparison(left = {}, right = {}) {
  return Object.fromEntries(
    [...new Set([...Object.keys(left), ...Object.keys(right)])]
      .sort((a, b) => Number(a) - Number(b))
      .map((level) => [
        level,
        {
          webgl: left[level] || 0,
          webgpu: right[level] || 0,
          symmetricDeltaRatio: symmetricDeltaRatio(
            left[level] || 0,
            right[level] || 0,
          ),
        },
      ]),
  );
}

function jaccardSimilarity(left = [], right = []) {
  const leftSet = new Set(left);
  const rightSet = new Set(right);
  const union = new Set([...leftSet, ...rightSet]);
  if (union.size === 0) {
    return 1;
  }
  let intersectionSize = 0;
  for (const key of leftSet) {
    if (rightSet.has(key)) {
      intersectionSize++;
    }
  }
  return intersectionSize / union.size;
}

function readRepresentativeWorkloadFingerprint(run) {
  return run?.representativeContentEvidence?.measurementContent
    ?.workloadFingerprint;
}

function summarizeRepresentativeWorkloadFingerprint(fingerprint) {
  return fingerprint
    ? {
        schemaVersion: fingerprint.schemaVersion ?? null,
        valid: fingerprint.valid === true,
        frameCount: fingerprint.frameCount ?? null,
        signature: fingerprint.signature ?? null,
        segmentCount: fingerprint.segments?.length ?? null,
      }
    : null;
}

const representativeWorkloadFingerprintMetricNames = Object.freeze([
  "terrainTilesToRender",
  "terrainMeshTiles",
  "terrainSelectionIdentityA",
  "terrainSelectionIdentityB",
  "terrainUnidentifiedTiles",
  "directModelInstancesConfigured",
  "directModelInstancesReady",
  "directModelIdentityA",
  "directModelIdentityB",
  "tilesetsWithSelection",
  "tilesetSelected",
  "tilesetSelectionIdentityA",
  "tilesetSelectionIdentityB",
  "tilesetSelectionCountMismatch",
  "tilesetUnidentifiedSelected",
  // C11-205 ready-tile identity. Must stay byte-identical, and in the same
  // order, as `representativeFingerprintMetricNames` in
  // `representative-performance-content.mjs` — the per-metric hash salt is the
  // array index, so a reordering silently re-bases every signature.
  "tilesetsWithReadyContent",
  "tilesetContentReady",
  "tilesetReadyIdentityA",
  "tilesetReadyIdentityB",
  "tilesetReadyCountMismatch",
  "tilesetUnidentifiedReady",
]);

/**
 * Identity-bearing metric groups.
 *
 * The single per-frame signature already fails a pair whose work differed, but
 * "the signature differs" is not an answer to WHICH renderer did different
 * work. Each group is therefore compared metric-by-metric so a rejection names
 * the set that diverged, and each group declares the completeness metrics that
 * must be zero for its identities to mean anything at all.
 */
const representativeWorkloadIdentityGroups = Object.freeze([
  Object.freeze({
    key: "terrainSelection",
    label: "terrain selection",
    counts: Object.freeze(["terrainTilesToRender", "terrainMeshTiles"]),
    identityA: "terrainSelectionIdentityA",
    identityB: "terrainSelectionIdentityB",
    completeness: Object.freeze([
      Object.freeze({
        metric: "terrainUnidentifiedTiles",
        description: "terrain tiles without an x/y/level identity",
      }),
    ]),
  }),
  Object.freeze({
    key: "directModel",
    label: "direct model",
    counts: Object.freeze([
      "directModelInstancesConfigured",
      "directModelInstancesReady",
    ]),
    identityA: "directModelIdentityA",
    identityB: "directModelIdentityB",
    completeness: Object.freeze([]),
  }),
  Object.freeze({
    key: "tilesetSelected",
    label: "3D Tiles selected",
    counts: Object.freeze(["tilesetsWithSelection", "tilesetSelected"]),
    identityA: "tilesetSelectionIdentityA",
    identityB: "tilesetSelectionIdentityB",
    completeness: Object.freeze([
      Object.freeze({
        metric: "tilesetUnidentifiedSelected",
        description: "selected tiles without a path identity",
      }),
      Object.freeze({
        metric: "tilesetSelectionCountMismatch",
        description:
          "disagreement between statistics.selected and the _selectedTiles set",
      }),
    ]),
  }),
  Object.freeze({
    key: "tilesetReady",
    label: "3D Tiles ready",
    counts: Object.freeze(["tilesetsWithReadyContent", "tilesetContentReady"]),
    identityA: "tilesetReadyIdentityA",
    identityB: "tilesetReadyIdentityB",
    completeness: Object.freeze([
      Object.freeze({
        metric: "tilesetUnidentifiedReady",
        description: "resident ready tiles without a path identity",
      }),
      Object.freeze({
        metric: "tilesetReadyCountMismatch",
        description:
          "disagreement between statistics.numberOfTilesWithContentReady and the resident ready set",
      }),
    ]),
  }),
]);

function fingerprintMetricsAgree(left, right, name) {
  const leftMetric = left?.[name];
  const rightMetric = right?.[name];
  return (
    leftMetric?.total === rightMetric?.total &&
    leftMetric?.min === rightMetric?.min &&
    leftMetric?.max === rightMetric?.max
  );
}

function describeFingerprintMetric(metrics, name) {
  const metric = metrics?.[name];
  return `total ${metric?.total ?? "n/a"} min ${metric?.min ?? "n/a"} max ${
    metric?.max ?? "n/a"
  }`;
}

function hasValidFingerprintMetrics(metrics) {
  return representativeWorkloadFingerprintMetricNames.every((name) => {
    const metric = metrics?.[name];
    return (
      Number.isInteger(metric?.total) &&
      metric.total >= 0 &&
      Number.isInteger(metric?.min) &&
      metric.min >= 0 &&
      Number.isInteger(metric?.max) &&
      metric.max >= metric.min
    );
  });
}

function validateRepresentativeWorkloadFingerprint(
  label,
  fingerprint,
  expectedFrames,
  reasons,
) {
  const segments = fingerprint?.segments;
  const signaturePattern = /^[0-9a-f]{8}-[0-9a-f]{8}$/;
  const segmentFrameCount = Array.isArray(segments)
    ? segments.reduce(
        (sum, segment) =>
          sum +
          (Number.isInteger(segment?.frameCount) ? segment.frameCount : 0),
        0,
      )
    : 0;
  // Every identity-bearing group states the defects that would make its hashes
  // meaningless. Reporting them individually is the difference between "this
  // pair is not comparable" and an answer a maintainer can act on. The detail
  // is only emitted once the metric block is structurally sound; on a missing
  // or malformed fingerprint the umbrella reason below is the honest one.
  const metricsWellFormed = hasValidFingerprintMetrics(fingerprint?.metrics);
  const identityDefects = [];
  for (const group of representativeWorkloadIdentityGroups) {
    for (const entry of group.completeness) {
      const metric = fingerprint?.metrics?.[entry.metric];
      if (metric?.max !== 0) {
        identityDefects.push(
          `${label} resident ${group.label} identity is incomplete: ` +
            `${entry.metric} (${entry.description}) reached ` +
            `${metric?.max ?? "an unreported value"} on a replay frame`,
        );
      }
    }
  }
  const identitiesComplete = identityDefects.length === 0;
  if (metricsWellFormed) {
    reasons.push(...identityDefects);
  }
  // `causal` must be decomposed into the two facts that produce it, otherwise
  // a single boolean restating the workload's configured terrain mode would
  // again certify the replay rather than the timed window it stands in for.
  const provenanceValid =
    fingerprint?.provenance?.timed === false &&
    fingerprint?.provenance?.phase === "post-measurement-untimed-replay" &&
    fingerprint?.provenance?.traceEndedBeforeReplay === true &&
    fingerprint?.provenance?.measurementSnapshotsFrozenBeforeReplay === true &&
    fingerprint?.provenance?.replayModeFixedFrame === true &&
    fingerprint?.provenance?.renderedProgressIdentical === true &&
    fingerprint?.provenance?.causal === true;
  const segmentsValid =
    Array.isArray(segments) &&
    segments.length > 0 &&
    new Set(segments.map((segment) => segment?.segmentIndex)).size ===
      segments.length &&
    segments.every(
      (segment) =>
        Number.isInteger(segment?.segmentIndex) &&
        segment.segmentIndex >= 0 &&
        Number.isInteger(segment?.frameCount) &&
        segment.frameCount > 0 &&
        signaturePattern.test(segment?.signature) &&
        hasValidFingerprintMetrics(segment?.metrics),
    );
  const valid =
    fingerprint?.schemaVersion === 1 &&
    fingerprint?.valid === true &&
    Number.isInteger(fingerprint?.frameCount) &&
    fingerprint.frameCount > 0 &&
    fingerprint.frameCount === expectedFrames &&
    signaturePattern.test(fingerprint?.signature) &&
    fingerprint?.invalidSampleCount === 0 &&
    metricsWellFormed &&
    segmentsValid &&
    segmentFrameCount === fingerprint.frameCount &&
    identitiesComplete &&
    provenanceValid;
  if (!valid) {
    reasons.push(
      `${label} resident workload fingerprint is missing, invalid, identity-incomplete, lacks untimed causal replay provenance (the replay must be fixed-frame AND proven to have re-rendered the measured window's per-frame camera phase), or is not aligned to ${expectedFrames ?? "unknown"} measured frames`,
    );
  }
  return valid;
}

/**
 * Name the first replay frame on which the attribution-only 3D Tiles lifecycle
 * diagnostics saw the two legs hold different ready sets, and the first tile
 * identity that differed.
 *
 * This can only ever ENRICH a rejection the ordinary fingerprint already
 * produced. The diagnostics are opt-in and explicitly non-certifying, so their
 * absence must never soften a rejection and their presence must never create
 * comparability — hence a plain `null` when they are missing rather than a
 * fallback that would make the reason read as if it had been checked.
 */
function describeFirstDivergentReadyIdentity(tilesetLifecycle) {
  const mismatch =
    tilesetLifecycle?.available === true
      ? tilesetLifecycle.comparison?.firstReadyMismatch
      : null;
  if (!mismatch) {
    return null;
  }
  return {
    frameIndex: mismatch.frameIndex ?? null,
    segmentIndex: mismatch.segmentIndex ?? null,
    routeProgress: mismatch.routeProgress ?? null,
    webglCount: mismatch.webglCount ?? null,
    webgpuCount: mismatch.webgpuCount ?? null,
    firstWebglOnlyIdentity: mismatch.webglOnly?.identities?.[0] ?? null,
    firstWebgpuOnlyIdentity: mismatch.webgpuOnly?.identities?.[0] ?? null,
    webglOnlyCount: mismatch.webglOnly?.total ?? null,
    webgpuOnlyCount: mismatch.webgpuOnly?.total ?? null,
    source: "attribution-only-tileset-lifecycle-diagnostics",
  };
}

function compareRepresentativeWorkloadFingerprints(
  webglRun,
  webgpuRun,
  reasons,
  tilesetLifecycle = null,
) {
  const webgl = readRepresentativeWorkloadFingerprint(webglRun);
  const webgpu = readRepresentativeWorkloadFingerprint(webgpuRun);
  const webglValid = validateRepresentativeWorkloadFingerprint(
    "WebGL",
    webgl,
    webglRun?.measuredFrames,
    reasons,
  );
  const webgpuValid = validateRepresentativeWorkloadFingerprint(
    "WebGPU",
    webgpu,
    webgpuRun?.measuredFrames,
    reasons,
  );

  const segmentComparisons = [];
  const identityGroupComparisons = [];
  let firstDivergentReadyIdentity = null;
  let signatureMatch = false;
  if (webglValid && webgpuValid) {
    signatureMatch = webgl.signature === webgpu.signature;
    if (!signatureMatch) {
      reasons.push(
        `resident per-frame workload signature differs (${webgl.signature}/${webgpu.signature})`,
      );
    }

    const webglSegments = new Map(
      webgl.segments.map((segment) => [segment.segmentIndex, segment]),
    );
    const webgpuSegments = new Map(
      webgpu.segments.map((segment) => [segment.segmentIndex, segment]),
    );
    for (const group of representativeWorkloadIdentityGroups) {
      const groupMetricNames = [
        ...group.counts,
        group.identityA,
        group.identityB,
      ];
      const differingMetrics = groupMetricNames.filter(
        (name) => !fingerprintMetricsAgree(webgl.metrics, webgpu.metrics, name),
      );
      // Find the first segment that disagrees so a long route reports where the
      // sets parted rather than only that they did.
      let firstDivergentSegmentIndex = null;
      for (const webgpuSegment of webgpu.segments) {
        const webglSegment = webglSegments.get(webgpuSegment.segmentIndex);
        const segmentDiffers = groupMetricNames.some(
          (name) =>
            !fingerprintMetricsAgree(
              webglSegment?.metrics,
              webgpuSegment?.metrics,
              name,
            ),
        );
        if (segmentDiffers) {
          firstDivergentSegmentIndex = webgpuSegment.segmentIndex;
          break;
        }
      }
      const identityAMatch = fingerprintMetricsAgree(
        webgl.metrics,
        webgpu.metrics,
        group.identityA,
      );
      const identityBMatch = fingerprintMetricsAgree(
        webgl.metrics,
        webgpu.metrics,
        group.identityB,
      );
      const comparison = {
        key: group.key,
        label: group.label,
        match: differingMetrics.length === 0,
        identityAMatch,
        identityBMatch,
        // The whole point of carrying two algebraically independent hashes: if
        // exactly one of them matches, the matching one collided and would
        // have validated a set the other rejects.
        collisionCaughtBySecondConstruction: identityAMatch !== identityBMatch,
        differingMetrics,
        firstDivergentSegmentIndex,
        metrics: Object.fromEntries(
          groupMetricNames.map((name) => [
            name,
            {
              webgl: webgl.metrics?.[name] ?? null,
              webgpu: webgpu.metrics?.[name] ?? null,
              match: fingerprintMetricsAgree(
                webgl.metrics,
                webgpu.metrics,
                name,
              ),
            },
          ]),
        ),
      };
      if (group.key === "tilesetReady" && !comparison.match) {
        firstDivergentReadyIdentity =
          describeFirstDivergentReadyIdentity(tilesetLifecycle);
        comparison.firstDivergentIdentity = firstDivergentReadyIdentity;
      }
      identityGroupComparisons.push(comparison);

      if (!comparison.match) {
        for (const name of differingMetrics) {
          reasons.push(
            `resident ${group.label} identity differs between renderer legs: ` +
              `${name} WebGL ${describeFingerprintMetric(webgl.metrics, name)} ` +
              `vs WebGPU ${describeFingerprintMetric(webgpu.metrics, name)}` +
              (firstDivergentSegmentIndex === null
                ? ""
                : ` (first divergent route segment ${firstDivergentSegmentIndex})`),
          );
        }
        if (comparison.collisionCaughtBySecondConstruction) {
          reasons.push(
            `resident ${group.label} identity hashes disagree asymmetrically ` +
              `(${group.identityA} match=${identityAMatch}, ${group.identityB} ` +
              `match=${identityBMatch}) — one construction collided and the ` +
              `second refused it`,
          );
        }
        if (firstDivergentReadyIdentity) {
          reasons.push(
            `first divergent resident ready tile (attribution-only lifecycle ` +
              `evidence, replay frame ${firstDivergentReadyIdentity.frameIndex}, ` +
              `segment ${firstDivergentReadyIdentity.segmentIndex}): ` +
              `WebGL-only ${firstDivergentReadyIdentity.firstWebglOnlyIdentity ?? "none"} / ` +
              `WebGPU-only ${firstDivergentReadyIdentity.firstWebgpuOnlyIdentity ?? "none"} ` +
              `(${firstDivergentReadyIdentity.webglCount}/${firstDivergentReadyIdentity.webgpuCount} ready)`,
          );
        }
      }
    }

    const segmentIndexes = [
      ...new Set([...webglSegments.keys(), ...webgpuSegments.keys()]),
    ].sort((left, right) => left - right);
    for (const segmentIndex of segmentIndexes) {
      const webglSegment = webglSegments.get(segmentIndex);
      const webgpuSegment = webgpuSegments.get(segmentIndex);
      const frameCountMatch =
        webglSegment?.frameCount === webgpuSegment?.frameCount;
      const segmentSignatureMatch =
        webglSegment?.signature === webgpuSegment?.signature;
      if (!webglSegment || !webgpuSegment) {
        reasons.push(
          `resident workload segment ${segmentIndex} is missing from one renderer`,
        );
      } else {
        if (!frameCountMatch) {
          reasons.push(
            `resident workload segment ${segmentIndex} frame count differs (${webglSegment.frameCount}/${webgpuSegment.frameCount})`,
          );
        }
        if (!segmentSignatureMatch) {
          reasons.push(
            `resident workload segment ${segmentIndex} signature differs (${webglSegment.signature}/${webgpuSegment.signature})`,
          );
        }
      }
      segmentComparisons.push({
        segmentIndex,
        webglFrameCount: webglSegment?.frameCount ?? null,
        webgpuFrameCount: webgpuSegment?.frameCount ?? null,
        frameCountMatch,
        webglSignature: webglSegment?.signature ?? null,
        webgpuSignature: webgpuSegment?.signature ?? null,
        signatureMatch: segmentSignatureMatch,
      });
    }
  }

  const readyIdentity =
    identityGroupComparisons.find(
      (comparison) => comparison.key === "tilesetReady",
    ) ?? null;
  return {
    webgl: summarizeRepresentativeWorkloadFingerprint(webgl),
    webgpu: summarizeRepresentativeWorkloadFingerprint(webgpu),
    signatureMatch,
    segmentComparisons,
    identityGroups: identityGroupComparisons,
    // Promoted to the top of the block because "were the ready sets identical"
    // is the question that gates every causal resident timing claim. `false`
    // when the legs disagreed, `null` when neither leg produced a valid
    // fingerprint to compare — the two are not the same and must not read the
    // same in the report.
    readyIdentityMatch: readyIdentity ? readyIdentity.match : null,
    firstDivergentReadyIdentity,
  };
}

function flattenTilesetLifecycleIdentities(frame, property) {
  return (frame?.tilesets || [])
    .flatMap((tileset) => tileset?.[property] || [])
    .sort();
}

function identitySetDifference(left, right, limit = 128) {
  const rightSet = new Set(right);
  const difference = left.filter((identity) => !rightSet.has(identity));
  return {
    total: difference.length,
    identities: difference.slice(0, limit),
    truncated: difference.length > limit,
  };
}

function summarizeTilesetLifecycleEndpoint(diagnostics) {
  return diagnostics
    ? {
        schemaVersion: diagnostics.schemaVersion ?? null,
        enabled: diagnostics.enabled === true,
        nonCertifying: diagnostics.nonCertifying === true,
        frameCount: diagnostics.frames?.length ?? null,
        eventsTruncated: diagnostics.eventsTruncated === true,
        framesTruncated: diagnostics.framesTruncated === true,
        totals: diagnostics.totals ? { ...diagnostics.totals } : null,
      }
    : null;
}

/**
 * Compare opt-in, untimed 3D Tiles lifecycle diagnostics without changing the
 * exact workload fingerprint or pair validity. This attribution-only evidence
 * explains which ready/selected identities first diverged and whether request
 * cancellation/reissue preceded that selection drift.
 */
export function compareRepresentativeTilesetLifecycleDiagnostics(
  webglRun,
  webgpuRun,
) {
  const webgl =
    webglRun?.representativeContentEvidence?.tilesetLifecycleDiagnostics;
  const webgpu =
    webgpuRun?.representativeContentEvidence?.tilesetLifecycleDiagnostics;
  const provenanceValid = (diagnostics) =>
    diagnostics?.provenance?.timed === false &&
    diagnostics.provenance.phase === "post-measurement-untimed-replay" &&
    diagnostics.provenance.traceEndedBeforeReplay === true &&
    diagnostics.provenance.measurementSnapshotsFrozenBeforeReplay === true;
  const endpointValid = (diagnostics) =>
    diagnostics?.schemaVersion === 1 &&
    diagnostics.enabled === true &&
    diagnostics.nonCertifying === true &&
    Array.isArray(diagnostics.frames) &&
    diagnostics.frames.length > 0 &&
    diagnostics.framesTruncated !== true &&
    provenanceValid(diagnostics);
  const webglValid = endpointValid(webgl);
  const webgpuValid = endpointValid(webgpu);
  if (!webglValid || !webgpuValid) {
    return {
      available: false,
      valid: false,
      reasons: [
        "both renderer legs require complete opt-in untimed tileset lifecycle diagnostics",
      ],
      webgl: summarizeTilesetLifecycleEndpoint(webgl),
      webgpu: summarizeTilesetLifecycleEndpoint(webgpu),
    };
  }

  const reasons = [];
  if (webgl.frames.length !== webgpu.frames.length) {
    reasons.push(
      `lifecycle replay frame count differs (${webgl.frames.length}/${webgpu.frames.length})`,
    );
  }
  const frameCount = Math.min(webgl.frames.length, webgpu.frames.length);
  let selectedMismatchFrames = 0;
  let readyMismatchFrames = 0;
  let firstSelectedMismatch = null;
  let firstReadyMismatch = null;
  const segments = new Map();
  for (let index = 0; index < frameCount; index++) {
    const webglFrame = webgl.frames[index];
    const webgpuFrame = webgpu.frames[index];
    const segmentIndex = webglFrame.segmentIndex;
    const segment = segments.get(segmentIndex) || {
      segmentIndex,
      frameCount: 0,
      selectedMismatchFrames: 0,
      readyMismatchFrames: 0,
    };
    segment.frameCount++;

    const selectedMatch =
      webglFrame.selectedIdentitySignature ===
      webgpuFrame.selectedIdentitySignature;
    const readyMatch =
      webglFrame.readyIdentitySignature === webgpuFrame.readyIdentitySignature;
    if (!selectedMatch) {
      selectedMismatchFrames++;
      segment.selectedMismatchFrames++;
      if (!firstSelectedMismatch) {
        const webglSelected = flattenTilesetLifecycleIdentities(
          webglFrame,
          "selected",
        );
        const webgpuSelected = flattenTilesetLifecycleIdentities(
          webgpuFrame,
          "selected",
        );
        firstSelectedMismatch = {
          frameIndex: index,
          segmentIndex,
          routeProgress: webglFrame.routeProgress,
          webglCount: webglSelected.length,
          webgpuCount: webgpuSelected.length,
          webglOnly: identitySetDifference(webglSelected, webgpuSelected),
          webgpuOnly: identitySetDifference(webgpuSelected, webglSelected),
          webglTilesets: structuredClone(webglFrame.tilesets),
          webgpuTilesets: structuredClone(webgpuFrame.tilesets),
        };
      }
    }
    if (!readyMatch) {
      readyMismatchFrames++;
      segment.readyMismatchFrames++;
      if (!firstReadyMismatch) {
        const webglReady = flattenTilesetLifecycleIdentities(
          webglFrame,
          "ready",
        );
        const webgpuReady = flattenTilesetLifecycleIdentities(
          webgpuFrame,
          "ready",
        );
        firstReadyMismatch = {
          frameIndex: index,
          segmentIndex,
          routeProgress: webglFrame.routeProgress,
          webglCount: webglReady.length,
          webgpuCount: webgpuReady.length,
          webglOnly: identitySetDifference(webglReady, webgpuReady),
          webgpuOnly: identitySetDifference(webgpuReady, webglReady),
        };
      }
    }
    segments.set(segmentIndex, segment);
  }

  return {
    available: true,
    valid: reasons.length === 0,
    reasons,
    nonCertifying: true,
    webgl: summarizeTilesetLifecycleEndpoint(webgl),
    webgpu: summarizeTilesetLifecycleEndpoint(webgpu),
    comparison: {
      frameCount,
      selectedMismatchFrames,
      readyMismatchFrames,
      firstSelectedMismatch,
      firstReadyMismatch,
      readyDivergencePrecedesOrMatchesSelection:
        firstReadyMismatch !== null &&
        (firstSelectedMismatch === null ||
          firstReadyMismatch.frameIndex <= firstSelectedMismatch.frameIndex),
      segments: [...segments.values()].sort(
        (left, right) => left.segmentIndex - right.segmentIndex,
      ),
    },
  };
}

export function assessWebGPUModelPreparationEvidence(evidence, options = {}) {
  const renderer = options.renderer;
  const apiInstrumentation = options.apiInstrumentation === true;
  const modelAttributionContent = options.modelAttributionContent === true;
  const reasons = [];

  if (renderer === "webgl") {
    if (evidence !== null) {
      reasons.push("WebGL fabricated WebGPU model-preparation evidence");
    }
  } else if (!apiInstrumentation) {
    if (
      evidence?.enabled !== false ||
      evidence?.reason !== "api-instrumentation-disabled"
    ) {
      reasons.push(
        "clean WebGPU timing run unexpectedly enabled model-preparation diagnostics",
      );
    }
  } else if (!modelAttributionContent) {
    if (
      evidence?.enabled !== false ||
      evidence?.reason !== "no-model-attribution-content"
    ) {
      reasons.push(
        "model-free WebGPU API lane unexpectedly enabled model-preparation diagnostics",
      );
    }
  } else if (
    evidence?.enabled !== true ||
    evidence?.valid !== true ||
    evidence?.conservation?.valid !== true ||
    evidence?.coverage?.valid !== true
  ) {
    reasons.push(
      `WebGPU model-preparation evidence invalid: ${
        evidence?.conservation?.violations?.join("; ") ||
        "missing enabled/conserved/full-coverage summary"
      }`,
    );
  }

  return { valid: reasons.length === 0, reasons };
}

const FIXED_FRAME_PROGRESS_DIVERGENCE_SAMPLE_LIMIT = 8;

/**
 * Compare the per-frame camera route progress a timed measurement window
 * actually rendered against the sequence an untimed replay rendered.
 *
 * This is the evidence behind `identicalFixedFrameProgress` / `causal`. Those
 * flags used to be restatements of the workload's configured terrain mode,
 * which proved nothing about the timed window: the replay applies
 * `index/(frameCount-1)` while the measured window's action rAF applies
 * `min(1, cameraTrackFrameIndex/(frames-1))` with an intentionally
 * unspecified viewer/action rAF order. Only an observation of both sequences
 * can establish that the replayed content corresponds to the measured frames,
 * so both the in-page recorder and the Node-side gate run this same function.
 *
 * Both inputs must be the rendered sequences (one entry per presented frame),
 * not the formula that generated them.
 */
export function compareFixedFrameProgressSequences(
  measuredRenderedProgress,
  replayRenderedProgress,
  options = {},
) {
  const tolerance = Number.isFinite(options.tolerance)
    ? options.tolerance
    : 1e-9;
  const measured = Array.isArray(measuredRenderedProgress)
    ? measuredRenderedProgress
    : null;
  const replayed = Array.isArray(replayRenderedProgress)
    ? replayRenderedProgress
    : null;
  if (!measured || !replayed) {
    return {
      schemaVersion: 1,
      identical: false,
      reason: "missing-rendered-progress-sequence",
      tolerance,
      measuredFrameCount: measured?.length ?? null,
      replayFrameCount: replayed?.length ?? null,
      comparedFrames: 0,
      firstDivergenceIndex: null,
      maximumAbsoluteDifference: null,
      divergenceCount: 0,
      divergences: [],
      divergencesTruncated: false,
    };
  }
  const comparedFrames = Math.min(measured.length, replayed.length);
  const divergences = [];
  let firstDivergenceIndex = null;
  let maximumAbsoluteDifference = 0;
  let divergenceCount = 0;
  for (let index = 0; index < comparedFrames; index++) {
    const measuredValue = measured[index];
    const replayValue = replayed[index];
    const comparable =
      Number.isFinite(measuredValue) && Number.isFinite(replayValue);
    const difference = comparable
      ? Math.abs(measuredValue - replayValue)
      : Number.POSITIVE_INFINITY;
    if (comparable && difference > maximumAbsoluteDifference) {
      maximumAbsoluteDifference = difference;
    }
    if (!(difference <= tolerance)) {
      divergenceCount++;
      if (firstDivergenceIndex === null) {
        firstDivergenceIndex = index;
      }
      if (divergences.length < FIXED_FRAME_PROGRESS_DIVERGENCE_SAMPLE_LIMIT) {
        divergences.push({
          frameIndex: index,
          measured: comparable ? measuredValue : null,
          replay: comparable ? replayValue : null,
        });
      }
    }
  }
  const frameCountsMatch = measured.length === replayed.length;
  const identical =
    measured.length > 0 && frameCountsMatch && firstDivergenceIndex === null;
  return {
    schemaVersion: 1,
    identical,
    reason: identical
      ? null
      : measured.length === 0
        ? "no-measured-rendered-frames"
        : !frameCountsMatch
          ? "rendered-frame-count-mismatch"
          : "rendered-progress-divergence",
    tolerance,
    measuredFrameCount: measured.length,
    replayFrameCount: replayed.length,
    comparedFrames,
    firstDivergenceIndex,
    maximumAbsoluteDifference:
      comparedFrames > 0 ? maximumAbsoluteDifference : null,
    divergenceCount,
    divergences,
    divergencesTruncated:
      divergenceCount > FIXED_FRAME_PROGRESS_DIVERGENCE_SAMPLE_LIMIT,
  };
}

/**
 * Re-derive the resident replay's fixed-frame progress provenance from the
 * recorded sequences instead of trusting the flags the page wrote. A stored
 * `true` that the raw sequences do not support fails here, which is what stops
 * the flag from silently regressing back into a config restatement.
 */
function assessResidentFixedFrameProgressEvidence(replay) {
  const comparison = replay?.fixedFrameProgressComparison;
  const recomputed = compareFixedFrameProgressSequences(
    replay?.renderedProgress?.measured,
    replay?.renderedProgress?.replay,
  );
  if (recomputed.reason === "missing-rendered-progress-sequence") {
    return {
      valid: false,
      reason:
        "the measured and replayed per-frame progress sequences were not recorded",
      recomputed,
    };
  }
  if (comparison?.schemaVersion !== 1) {
    return {
      valid: false,
      reason: "the replay carries no per-frame progress comparison",
      recomputed,
    };
  }
  if (comparison.identical !== recomputed.identical) {
    return {
      valid: false,
      reason: `the reported comparison (identical=${comparison.identical}) disagrees with the recorded sequences (identical=${recomputed.identical})`,
      recomputed,
    };
  }
  if (recomputed.identical !== true) {
    return {
      valid: false,
      reason: `${recomputed.reason} (measured ${recomputed.measuredFrameCount} frames, replay ${recomputed.replayFrameCount} frames, first divergence at index ${recomputed.firstDivergenceIndex})`,
      recomputed,
    };
  }
  if (replay?.identicalFixedFrameProgress !== true) {
    return {
      valid: false,
      reason:
        "identicalFixedFrameProgress was not asserted even though the recorded sequences match",
      recomputed,
    };
  }
  if (
    recomputed.measuredFrameCount !== replay.frameCount ||
    recomputed.replayFrameCount !== replay.frameCount
  ) {
    return {
      valid: false,
      reason: `the recorded sequences cover ${recomputed.measuredFrameCount}/${recomputed.replayFrameCount} frames, not the ${replay.frameCount} replayed frames`,
      recomputed,
    };
  }
  return { valid: true, reason: null, recomputed };
}

/**
 * Validate timed terrain activity together with the post-trace deterministic
 * content replay. Resident replay follows the exact fixed-frame route and is
 * causal only when the timed window is proven to have rendered that same
 * per-frame camera phase sequence; bounded streaming replay is explicitly
 * non-causal coverage evidence.
 */
export function assessRepresentativeMeasurementEvidence(
  representativeContentEvidence,
  options = {},
) {
  const measurementTerrainMode = options.measurementTerrainMode ?? "streaming";
  const activity = representativeContentEvidence?.measurementTerrainActivity;
  const delta = activity?.delta;
  const content = representativeContentEvidence?.measurementContent;
  const reasons = [];
  let residentFixedFrameProgress = null;

  if (!delta) {
    reasons.push("measured representative terrain activity is missing");
  }
  if (!content || !(content.sampledFrames > 0)) {
    reasons.push("no representative content replay frame was sampled");
  } else {
    const sampling = content.sampling;
    const provenance = sampling?.provenance;
    const replay = sampling?.replay;
    const validationWaypoint = sampling?.validationWaypoint;
    const commandWindow = sampling?.commandTriggeredPreWaypoint;
    const commandWindowBoundsValid =
      Number.isFinite(commandWindow?.startRouteProgress) &&
      Number.isFinite(commandWindow?.endRouteProgress) &&
      commandWindow.startRouteProgress >= 0 &&
      commandWindow.startRouteProgress < commandWindow.endRouteProgress &&
      commandWindow.endRouteProgress <= 1 &&
      commandWindow.endExclusive === true &&
      Number.isFinite(validationWaypoint?.routeProgress) &&
      commandWindow.endRouteProgress === validationWaypoint.routeProgress;
    const commandWindowSamplesValid =
      Number.isInteger(commandWindow?.configuredTilesets) &&
      commandWindow.configuredTilesets > 0 &&
      Number.isInteger(commandWindow?.maximumSamples) &&
      commandWindow.maximumSamples > 0 &&
      commandWindow.sampledFrames === commandWindow.maximumSamples &&
      Number.isInteger(commandWindow?.inspectedFrames) &&
      commandWindow.inspectedFrames >= commandWindow.sampledFrames &&
      commandWindow.maximumObservedCommands > 0 &&
      Number.isFinite(commandWindow?.firstSampleRouteProgress) &&
      commandWindow.firstSampleRouteProgress >=
        commandWindow.startRouteProgress &&
      commandWindow.firstSampleRouteProgress < commandWindow.endRouteProgress &&
      Number.isFinite(commandWindow?.lastSampleRouteProgress) &&
      commandWindow.lastSampleRouteProgress >=
        commandWindow.firstSampleRouteProgress &&
      commandWindow.lastSampleRouteProgress < commandWindow.endRouteProgress;
    const provenanceValid =
      provenance?.timed === false &&
      provenance?.phase === "post-measurement-untimed-replay" &&
      provenance?.traceEndedBeforeReplay === true &&
      provenance?.measurementSnapshotsFrozenBeforeReplay === true &&
      provenance?.causal === (measurementTerrainMode === "resident");
    const replayValid =
      Number.isInteger(replay?.frameCount) &&
      replay.frameCount > 0 &&
      replay.frameCount === content.sampledFrames &&
      replay.sourceMeasuredFrames > 0 &&
      replay.progressFormula === "index/(frameCount-1)" &&
      (measurementTerrainMode === "resident"
        ? replay.streamingFrameLimit === null &&
          content.workloadFingerprint?.frameCount === replay.frameCount
        : replay.identicalFixedFrameProgress === false &&
          Number.isInteger(replay.streamingFrameLimit) &&
          replay.streamingFrameLimit > 0 &&
          replay.frameCount <= replay.streamingFrameLimit);
    // The resident "exact workload identity" claim is only as good as the
    // proof that the timed window rendered the sequence the replay re-rendered.
    // Re-derive it from the recorded sequences so a hard-coded flag cannot
    // certify a window it never observed.
    residentFixedFrameProgress =
      measurementTerrainMode === "resident"
        ? assessResidentFixedFrameProgressEvidence(replay)
        : null;
    if (residentFixedFrameProgress && !residentFixedFrameProgress.valid) {
      reasons.push(
        `the resident replay is not proven to re-render the measured window's per-frame camera phase: ${residentFixedFrameProgress.reason}`,
      );
    }
    if (
      sampling?.mode !== "untimed-deterministic-route-replay" ||
      !provenanceValid ||
      !replayValid ||
      !commandWindowBoundsValid ||
      !commandWindowSamplesValid
    ) {
      reasons.push(
        "representative untimed route replay or its bounded pre-waypoint 3D Tiles command window evidence was invalid",
      );
    }
    for (const [label, value] of [
      ["terrain mesh", content.terrainMeshFrames],
      ["terrain water-mask texture", content.terrainWaterMaskTextureFrames],
      ["terrain water effect", content.waterEffectFrames],
      ["direct model command", content.directModelCommandFrames],
      ["3D Tiles command", content.tilesetCommandFrames],
      [
        "combined terrain/model/3D Tiles command",
        content.allContentCommandFrames,
      ],
    ]) {
      if (!(value > 0)) {
        reasons.push(`${label} work was absent from the representative replay`);
      }
    }
  }

  if (measurementTerrainMode === "streaming" && delta) {
    if (!(delta.requestCount > 0)) {
      reasons.push("streaming measurement issued no terrain requests");
    }
    if (!(delta.tileGenerationCount > 0)) {
      reasons.push("streaming measurement generated no terrain tiles");
    }
    if (
      !Array.isArray(delta.generatedTileKeys) ||
      delta.generatedTileKeys.length < 1
    ) {
      reasons.push("streaming measurement generated no terrain-key evidence");
    }
  }

  return {
    valid: reasons.length === 0,
    measurementTerrainMode,
    reasons,
    // Reported for every mode so the artifact carries the measured phase
    // agreement, not just the pass/fail it produced.
    fixedFrameProgress: residentFixedFrameProgress
      ? {
          valid: residentFixedFrameProgress.valid,
          reason: residentFixedFrameProgress.reason,
          identical: residentFixedFrameProgress.recomputed.identical,
          measuredFrameCount:
            residentFixedFrameProgress.recomputed.measuredFrameCount,
          replayFrameCount:
            residentFixedFrameProgress.recomputed.replayFrameCount,
          firstDivergenceIndex:
            residentFixedFrameProgress.recomputed.firstDivergenceIndex,
          maximumAbsoluteDifference:
            residentFixedFrameProgress.recomputed.maximumAbsoluteDifference,
          divergences: residentFixedFrameProgress.recomputed.divergences,
        }
      : null,
    metrics: {
      requestCount: delta?.requestCount ?? null,
      tileGenerationCount: delta?.tileGenerationCount ?? null,
      generatedTileKeyCount: delta?.generatedTileKeys?.length ?? null,
      sampledContentCheckpoints: content?.sampledFrames ?? null,
      terrainMeshCheckpoints: content?.terrainMeshFrames ?? null,
      waterEffectCheckpoints: content?.waterEffectFrames ?? null,
      directModelCommandCheckpoints: content?.directModelCommandFrames ?? null,
      tilesetCommandCheckpoints: content?.tilesetCommandFrames ?? null,
      allContentCommandCheckpoints: content?.allContentCommandFrames ?? null,
      commandTriggeredPreWaypointSamples:
        content?.sampling?.commandTriggeredPreWaypoint?.sampledFrames ?? null,
    },
  };
}

/**
 * Summarize a counterbalanced representative WebGL/WebGPU pair.
 *
 * A fixed-frame resident pair is a causal renderer comparison, so unequal
 * work invalidates it. A duration-driven streaming pair instead reports frame
 * and streaming-work deltas as outcomes: a slower renderer naturally presents
 * fewer frames and may consequently request fewer tiles. Discarding that leg
 * would select away the performance deficit being measured.
 */
export function assessRepresentativePairComparability(
  webglRun,
  webgpuRun,
  options = {},
) {
  const measurementTerrainMode = options.measurementTerrainMode ?? "streaming";
  const causalRendererComparison = measurementTerrainMode === "resident";
  const attributionOnly =
    webglRun?.quality?.attributionOnly === true ||
    webgpuRun?.quality?.attributionOnly === true ||
    webglRun?.apiCounters?.enabled === true ||
    webgpuRun?.apiCounters?.enabled === true;
  const ordinaryQualityEligible =
    webglRun?.quality?.status === "clean" &&
    webglRun?.quality?.certificationEligible === true &&
    webgpuRun?.quality?.status === "clean" &&
    webgpuRun?.quality?.certificationEligible === true;
  const certificationEligible = !attributionOnly && ordinaryQualityEligible;
  const maximumDeltaRatio = options.maximumDeltaRatio ?? 0.05;
  const minimumGeneratedKeyJaccard = options.minimumGeneratedKeyJaccard ?? 0.95;
  const requireGeneratedKeySimilarity =
    options.requireGeneratedKeySimilarity ??
    measurementTerrainMode === "streaming";
  const webglDelta =
    webglRun?.representativeContentEvidence?.measurementTerrainActivity?.delta;
  const webgpuDelta =
    webgpuRun?.representativeContentEvidence?.measurementTerrainActivity?.delta;
  const reasons = [];
  const outcomeDifferences = [];
  const certificationExclusions = [];
  if (attributionOnly) {
    certificationExclusions.push(
      "API-instrumented renderer pairs are attribution-only and cannot certify causal timing",
    );
  } else if (!ordinaryQualityEligible) {
    certificationExclusions.push(
      "both ordinary renderer legs must have clean, certification-eligible run quality",
    );
  }
  if (!webglDelta || !webgpuDelta) {
    reasons.push("representative terrain activity is missing");
  }
  // Computed first so a ready-set rejection can name the tile that diverged.
  // It is passed in as attribution only: the fingerprint comparison rejects on
  // its own evidence and never consults this to pass.
  const tilesetLifecycle = compareRepresentativeTilesetLifecycleDiagnostics(
    webglRun,
    webgpuRun,
  );
  const workloadFingerprint = causalRendererComparison
    ? compareRepresentativeWorkloadFingerprints(
        webglRun,
        webgpuRun,
        reasons,
        tilesetLifecycle,
      )
    : null;

  const requestDeltaRatio = symmetricDeltaRatio(
    webglDelta?.requestCount,
    webgpuDelta?.requestCount,
  );
  const generationDeltaRatio = symmetricDeltaRatio(
    webglDelta?.tileGenerationCount,
    webgpuDelta?.tileGenerationCount,
  );
  const frameDeltaRatio = symmetricDeltaRatio(
    webglRun?.measuredFrames,
    webgpuRun?.measuredFrames,
  );
  const generatedKeyJaccard = requireGeneratedKeySimilarity
    ? jaccardSimilarity(
        webglDelta?.generatedTileKeys,
        webgpuDelta?.generatedTileKeys,
      )
    : null;

  for (const [name, value] of [
    ["terrain request", requestDeltaRatio],
    ["terrain generation", generationDeltaRatio],
    ["measured frame", frameDeltaRatio],
  ]) {
    if (!Number.isFinite(value)) {
      reasons.push(`${name} comparison is unavailable`);
    } else if (value > maximumDeltaRatio) {
      const message =
        `${name} symmetric delta ${(value * 100).toFixed(2)}% exceeds ` +
        `${(maximumDeltaRatio * 100).toFixed(2)}%`;
      if (causalRendererComparison) {
        reasons.push(message);
      } else {
        outcomeDifferences.push(message);
      }
    }
  }
  if (
    requireGeneratedKeySimilarity &&
    Number.isFinite(generatedKeyJaccard) &&
    generatedKeyJaccard < minimumGeneratedKeyJaccard
  ) {
    const message =
      `generated terrain-key Jaccard ${generatedKeyJaccard.toFixed(4)} is ` +
      `below ${minimumGeneratedKeyJaccard.toFixed(4)}`;
    if (causalRendererComparison) {
      reasons.push(message);
    } else {
      outcomeDifferences.push(message);
    }
  }

  return {
    valid: reasons.length === 0,
    reasons,
    outcomeDifferences,
    measurementTerrainMode,
    causalRendererComparison,
    attributionOnly,
    ordinaryQualityEligible,
    certificationEligible,
    certificationExclusions,
    maximumDeltaRatio,
    minimumGeneratedKeyJaccard: requireGeneratedKeySimilarity
      ? minimumGeneratedKeyJaccard
      : null,
    metrics: {
      requestCount: {
        webgl: webglDelta?.requestCount ?? null,
        webgpu: webgpuDelta?.requestCount ?? null,
        symmetricDeltaRatio: requestDeltaRatio,
        byLevel: levelCountComparison(
          webglDelta?.requestsByLevel,
          webgpuDelta?.requestsByLevel,
        ),
      },
      tileGenerationCount: {
        webgl: webglDelta?.tileGenerationCount ?? null,
        webgpu: webgpuDelta?.tileGenerationCount ?? null,
        symmetricDeltaRatio: generationDeltaRatio,
        byLevel: levelCountComparison(
          webglDelta?.generationsByLevel,
          webgpuDelta?.generationsByLevel,
        ),
      },
      measuredFrames: {
        webgl: webglRun?.measuredFrames ?? null,
        webgpu: webgpuRun?.measuredFrames ?? null,
        symmetricDeltaRatio: frameDeltaRatio,
      },
      generatedTileKeyJaccard: generatedKeyJaccard,
      workloadFingerprint,
      tilesetLifecycle,
    },
  };
}
