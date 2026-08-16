// @purpose Accumulates and validates WebGPU model preparation/demand counters as measurement-window evidence for performance workloads.
// @status ACTIVE

const demandFields = Object.freeze([
  ["candidates", "candidates"],
  ["view", "viewAdmitted"],
  ["shadow", "shadowAdmitted"],
  ["capture", "captureAdmitted"],
  ["conservative", "conservativeFallbacks"],
  ["rejected", "rejected"],
]);

export const WEBGPU_MODEL_PREPARATION_WORK_FIELDS = Object.freeze([
  "preparationRuns",
  "temporalHistoryResets",
  "customShaderPreparations",
  "cameraPacks",
  "cameraWrites",
  "effectsPreparations",
  "materialPacks",
  "materialUploads",
  "lightPacks",
  "lightWrites",
  "commandsEmitted",
]);

function zeroDemandCounts() {
  return Object.fromEntries(demandFields.map(([name]) => [name, 0]));
}

function zeroWorkCounts() {
  return Object.fromEntries(
    WEBGPU_MODEL_PREPARATION_WORK_FIELDS.map((name) => [name, 0]),
  );
}

function isNonnegativeFiniteInteger(value) {
  return Number.isFinite(value) && Number.isInteger(value) && value >= 0;
}

function addViolation(accumulator, message) {
  if (
    accumulator.violations.length < 32 &&
    !accumulator.violations.includes(message)
  ) {
    accumulator.violations.push(message);
  }
}

/**
 * Mutable, bounded accumulator. It retains totals/maxima and a short unique
 * violation list, never a nested statistics copy for each rendered frame.
 */
export function createWebGPUModelPreparationEvidenceAccumulator() {
  return {
    observedFrameCount: 0,
    aggregatedFrameCount: 0,
    invalidFrameCount: 0,
    demandConservationFailureCount: 0,
    reasonConservationFailureCount: 0,
    firstFrameNumber: null,
    lastFrameNumber: null,
    sums: {
      demand: zeroDemandCounts(),
      reasons: {},
      work: zeroWorkCounts(),
    },
    maxima: {
      demand: zeroDemandCounts(),
      work: zeroWorkCounts(),
    },
    violations: [],
  };
}

/**
 * Observe one current-frame renderer statistic object. Duplicate frame numbers
 * are ignored so multiple post-render notifications cannot double-count work.
 *
 * @returns {boolean} true when the frame was valid and aggregated
 */
export function observeWebGPUModelPreparationStatistics(
  accumulator,
  statistics,
) {
  if (!accumulator || !statistics) {
    return false;
  }
  const frameNumber = statistics.frameNumber;
  if (!isNonnegativeFiniteInteger(frameNumber)) {
    addViolation(
      accumulator,
      "frameNumber is not a nonnegative finite integer",
    );
    accumulator.invalidFrameCount++;
    return false;
  }
  if (frameNumber === accumulator.lastFrameNumber) {
    return false;
  }

  accumulator.observedFrameCount++;
  accumulator.firstFrameNumber ??= frameNumber;
  if (
    accumulator.lastFrameNumber !== null &&
    frameNumber < accumulator.lastFrameNumber
  ) {
    addViolation(accumulator, "frameNumber moved backwards");
    accumulator.invalidFrameCount++;
    accumulator.lastFrameNumber = frameNumber;
    return false;
  }
  accumulator.lastFrameNumber = frameNumber;

  const demand = {};
  let valid = true;
  for (const [publicName, rendererName] of demandFields) {
    const value = statistics[rendererName];
    if (!isNonnegativeFiniteInteger(value)) {
      addViolation(
        accumulator,
        `${rendererName} is not a nonnegative finite integer`,
      );
      valid = false;
    } else {
      demand[publicName] = value;
    }
  }

  const reasons = statistics.reasons;
  let reasonTotal = 0;
  if (!reasons || typeof reasons !== "object") {
    addViolation(accumulator, "reasons is missing");
    valid = false;
  } else {
    for (const [reason, value] of Object.entries(reasons)) {
      if (!isNonnegativeFiniteInteger(value)) {
        addViolation(
          accumulator,
          `reason ${reason} is not a nonnegative finite integer`,
        );
        valid = false;
      } else {
        reasonTotal += value;
      }
    }
  }

  const work = statistics.work;
  if (!work || typeof work !== "object") {
    addViolation(accumulator, "work is missing");
    valid = false;
  } else {
    for (const field of WEBGPU_MODEL_PREPARATION_WORK_FIELDS) {
      if (!isNonnegativeFiniteInteger(work[field])) {
        addViolation(
          accumulator,
          `work.${field} is not a nonnegative finite integer`,
        );
        valid = false;
      }
    }
  }

  if (!valid) {
    accumulator.invalidFrameCount++;
    return false;
  }

  const demandTotal =
    demand.view +
    demand.shadow +
    demand.capture +
    demand.conservative +
    demand.rejected;
  if (demand.candidates !== demandTotal) {
    accumulator.demandConservationFailureCount++;
    addViolation(
      accumulator,
      `candidate demand conservation failed (${demand.candidates} != ${demandTotal})`,
    );
    return false;
  }
  if (demand.candidates !== reasonTotal) {
    accumulator.reasonConservationFailureCount++;
    addViolation(
      accumulator,
      `candidate reason conservation failed (${demand.candidates} != ${reasonTotal})`,
    );
    return false;
  }

  accumulator.aggregatedFrameCount++;
  for (const [name] of demandFields) {
    accumulator.sums.demand[name] += demand[name];
    accumulator.maxima.demand[name] = Math.max(
      accumulator.maxima.demand[name],
      demand[name],
    );
  }
  for (const [reason, value] of Object.entries(reasons)) {
    accumulator.sums.reasons[reason] =
      (accumulator.sums.reasons[reason] || 0) + value;
  }
  for (const field of WEBGPU_MODEL_PREPARATION_WORK_FIELDS) {
    accumulator.sums.work[field] += work[field];
    accumulator.maxima.work[field] = Math.max(
      accumulator.maxima.work[field],
      work[field],
    );
  }
  return true;
}

export function summarizeWebGPUModelPreparationEvidence(
  accumulator,
  options = {},
) {
  const expectedFrameCount = options.expectedFrameCount ?? null;
  const conservationValid =
    accumulator.invalidFrameCount === 0 &&
    accumulator.demandConservationFailureCount === 0 &&
    accumulator.reasonConservationFailureCount === 0;
  const complete =
    accumulator.observedFrameCount > 0 &&
    accumulator.aggregatedFrameCount === accumulator.observedFrameCount;
  const coverageValid =
    expectedFrameCount === null ||
    (isNonnegativeFiniteInteger(expectedFrameCount) &&
      expectedFrameCount > 0 &&
      accumulator.observedFrameCount === expectedFrameCount &&
      accumulator.aggregatedFrameCount === expectedFrameCount);
  const violations = [...accumulator.violations];
  if (accumulator.observedFrameCount === 0) {
    violations.push("no current-frame model-preparation statistics observed");
  } else if (!complete) {
    violations.push(
      `only ${accumulator.aggregatedFrameCount}/${accumulator.observedFrameCount} observed frames were aggregated`,
    );
  }
  if (!coverageValid) {
    violations.push(
      `model-preparation coverage ${accumulator.aggregatedFrameCount}/${accumulator.observedFrameCount}/${expectedFrameCount} aggregated/observed/expected frames`,
    );
  }
  return {
    enabled: true,
    available: true,
    observed: accumulator.observedFrameCount > 0,
    valid: conservationValid && complete && coverageValid,
    observedFrameCount: accumulator.observedFrameCount,
    aggregatedFrameCount: accumulator.aggregatedFrameCount,
    firstFrameNumber: accumulator.firstFrameNumber,
    lastFrameNumber: accumulator.lastFrameNumber,
    expectedFrameCount,
    coverage: {
      valid: coverageValid,
      expectedFrameCount,
      observedFrameCount: accumulator.observedFrameCount,
      aggregatedFrameCount: accumulator.aggregatedFrameCount,
    },
    sums: {
      demand: { ...accumulator.sums.demand },
      reasons: Object.fromEntries(
        Object.entries(accumulator.sums.reasons).sort(([left], [right]) =>
          left.localeCompare(right),
        ),
      ),
      work: { ...accumulator.sums.work },
    },
    maxima: {
      demand: { ...accumulator.maxima.demand },
      work: { ...accumulator.maxima.work },
    },
    conservation: {
      valid: conservationValid,
      invalidFrameCount: accumulator.invalidFrameCount,
      demandFailureCount: accumulator.demandConservationFailureCount,
      reasonFailureCount: accumulator.reasonConservationFailureCount,
      violations,
    },
  };
}
