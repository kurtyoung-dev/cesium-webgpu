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
    telemetryOrPickCallCount &&
    typeof telemetryOrPickCallCount === "object"
      ? telemetryOrPickCallCount
      : null;
  const pickCallCount = telemetry
    ? telemetry.publicCalls
    : telemetryOrPickCallCount;
  const positions = evidence.filter(
    (entry) =>
      Number.isFinite(entry.normalizedX) &&
      Number.isFinite(entry.normalizedY),
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

export function assessPerformanceRunQuality(run, options = {}) {
  const minTrackSegmentSamples = options.minTrackSegmentSamples ?? 30;
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

  const validForAggregation =
    cpuValid && (run.timestampEnabled !== true || gpuValid);
  return {
    status: validForAggregation ? "clean" : "invalid",
    validForAggregation,
    validForCpuAggregation: cpuValid,
    validForGpuAggregation: gpuValid && cpuValid,
    reasons,
    warnings,
    longTaskShare,
    timestampSkipRatio,
    suspectedMainThreadContamination,
  };
}

export function assessPerformanceRunStability(runs) {
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
          run.pickMetrics?.combinedCpuMs?.p95 ??
          run.trace?.summary?.cpuMs?.p95,
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
  };
}
