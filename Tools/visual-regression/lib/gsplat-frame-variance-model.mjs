// gsplat-frame-variance-model.mjs — browser-free decision arithmetic for the
// C15-G9 tower frame-variance discriminator harness.
// @purpose Pre-registered D1-D5 gsplat frame-variance classifications with one immutable 0.050% bar and shared verdict exits.
// @status ACTIVE

import {
  S5_STATUS_EXIT_CODES,
  exitCodeForS5Status,
} from "./verdict-exit-gate.mjs";

/**
 * The mutant-pinned C15-G9 bar. This is deliberately the only fractional
 * numeric representation of 0.050% in this module. Evaluators do not accept a
 * threshold option, and the probe has no CLI or environment override for it.
 */
export const FRAME_VARIANCE_THRESHOLD_FRACTION = 0.0005;

/** Five reads are enough to expose a non-repeatable reader without an unbounded loop. */
export const D1_FROZEN_FRAME_READS = 5;

/** The exact lane order is part of the pre-registration; D1 is always first. */
export const FRAME_VARIANCE_LANE_IDS = Object.freeze([
  "D1",
  "D2",
  "D3",
  "D4",
  "D5",
]);

/** The shared status table, re-exported for probe reporting without copying it. */
export const FRAME_VARIANCE_EXIT_CODES = S5_STATUS_EXIT_CODES;

/** Fields that define comparable scene state across fresh pages. */
export const D2_INITIAL_STATE_EQUIVALENCE_FIELDS = Object.freeze([
  "julian",
  "camera",
  "indexesSha256",
  "indexesLength",
  "positionsSha256",
  "positionsLength",
  "modelViewSha256",
  "generation",
  "dataGeneration",
]);

const frozenDesign = (prediction, discrimination, control) =>
  Object.freeze({ prediction, discrimination, control });

/**
 * The designs are data, not late-authored log prose. The probe writes this
 * exact object into every immutable artifact before any measured values.
 */
export const FRAME_VARIANCE_DESIGNS = Object.freeze({
  D1: frozenDesign(
    "With Julian date, camera, scene state, and sort input frozen, every pair among five canonical fused snapshots of the tower will differ by at most 0.050% of canvas pixels.",
    "If any pair exceeds 0.050%, D1 identifies capture/instrument noise and D2-D5 are structurally ineligible; otherwise the capture path is sufficiently stable for downstream discrimination.",
    "The 27-splat unit cube under the same one-render/five-read protocol must remain at or below 0.050% and must not fire D1.",
  ),
  D2: frozenDesign(
    "At fixed framing A and fixed framing B, both same-framing comparisons between the A->B and B->A executions remain at or below 0.050%; no state carry-over is predicted.",
    "Run A->B, B->A, A->A, and B->B in four fresh pages from byte-equivalent reset witnesses. Compare A from A->B only with A from B->A, and B from A->B only with B from B->A; never compare A directly with B. An over-bar same-framing comparison implicates state carry-over only when the repeated A->A and B->B controls remain below the bar.",
    "Repeated A->A and B->B captures at frozen input must each remain at or below 0.050% and must not fire the ordering lane.",
  ),
  D3: frozenDesign(
    "An asset-content mechanism produces over-bar variance for tower in both framings and at-or-below-bar variance for the unit cube in both framings; a framing mechanism produces over-bar variance for both assets at tower framing and at-or-below-bar variance for both assets at cube framing.",
    "Evaluate the complete asset x framing cross only when each crossed asset is uniformly scaled about its bounding-sphere center to preserve the donor framing's absolute camera range and angular footprint, and every cell proves a centered, unclipped framing and a nonzero persisted subject footprint. Classify ASSET_CONTENT only when both tower cells fire and both cube cells do not; classify FRAMING only when both tower-framing cells fire and both cube-framing cells do not; every other pattern is MIXED_OR_UNRESOLVED.",
    "The unit cube at its registered cube framing must remain at or below 0.050% and must not fire either pure-mechanism branch.",
  ),
  D4: frozenDesign(
    "At frozen Julian date, camera, asset payload, and data generation, three clean-start sort requests bound to byte-exact request-time inputs publish byte-identical permutation content; request sequence, source-object identity, and resident GPU-buffer identity are recorded separately.",
    "Deliberately schedule three sort publications from a clean no-sort-in-flight state while the byte-exact request-time positions and model-view inputs remain fixed. Tower variance above 0.050% accompanied by changed permutation content implicates the sorter; tower variance above 0.050% with byte-identical permutation content excludes sorter publication as the direct mechanism. Fresh typed-array identity and advancing request sequence are expected and cannot masquerade as permutation change; resident-buffer recommit is classified separately.",
    "Two reads of the same pinned permutation with no render or sort publication between them must be byte-identical and must not fire D4.",
  ),
  D5: frozenDesign(
    "When tower variance exceeds 0.050%, the area-normalized changed-pixel rate is higher in the scattered interior than in the one-pixel silhouette-edge band.",
    "Classify only when total tower variance exceeds 0.050%. EDGE_RASTER requires edge-band rate greater than interior rate. VOLUMETRIC requires interior rate greater than edge-band rate plus at least two eight-neighbor interior components occupying at least two cells of the fixed 8x8 grid. Equality, a contiguous interior blob, an empty region, or an incomplete map is MIXED_OR_UNRESOLVED.",
    "The unit cube frozen-frame variance map must remain at or below 0.050% and must not fire either spatial-distribution branch.",
  ),
});

export const FRAME_VARIANCE_ASSETS = Object.freeze({
  tower: Object.freeze({
    name: "tower",
    url: "/Specs/Data/Cesium3DTiles/GaussianSplats/tower/tileset.json",
    payloadUrl: "/Specs/Data/Cesium3DTiles/GaussianSplats/tower/0/0.glb",
    expectedSplats: 286868,
  }),
  sh_unit_cube: Object.freeze({
    name: "sh_unit_cube",
    url: "/Specs/Data/Cesium3DTiles/GaussianSplats/sh_unit_cube/tileset.json",
    payloadUrl: "/Specs/Data/Cesium3DTiles/GaussianSplats/sh_unit_cube/0/0.glb",
    expectedSplats: 27,
  }),
});

const pct = (value) =>
  Number.isFinite(value) ? `${(value * 100).toFixed(3)}%` : "n/a";

/** A missing denominator becomes NaN and therefore cannot satisfy either side. */
export function fractionOf(count, total) {
  if (!Number.isFinite(count) || !Number.isFinite(total) || total <= 0) {
    return Number.NaN;
  }
  return count / total;
}

/** Equality belongs to the no-fire side; only a strict breach fires. */
export function frameVarianceFires(value) {
  return Number.isFinite(value) && value > FRAME_VARIANCE_THRESHOLD_FRACTION;
}

/**
 * Convert one changed-pixel record to a fraction without accepting a caller-
 * supplied bar.
 */
export function measuredFraction(record) {
  return fractionOf(record?.changedPixels, record?.canvasPixels);
}

function statusResult(lane, status, details = {}) {
  const design = FRAME_VARIANCE_DESIGNS[lane];
  if (!design) {
    throw new RangeError(`unknown frame-variance lane ${String(lane)}`);
  }
  return {
    lane,
    status,
    exitCode: exitCodeForS5Status(status),
    thresholdFraction: FRAME_VARIANCE_THRESHOLD_FRACTION,
    prediction: design.prediction,
    discrimination: design.discrimination,
    control: design.control,
    classification: details.classification ?? "UNCLASSIFIED",
    signalFired: details.signalFired ?? false,
    controlFired: details.controlFired ?? false,
    measurements: details.measurements ?? {},
    checks: details.checks ?? {},
    failures: details.failures ?? [],
    structural: details.structural ?? [],
    notes: details.notes ?? [],
  };
}

function structuralResult(lane, reasons, details = {}) {
  return statusResult(lane, "STRUCTURAL", {
    ...details,
    structural: reasons,
  });
}

function finiteFractionOrReason(record, name, reasons) {
  const value = measuredFraction(record);
  if (!Number.isFinite(value)) {
    reasons.push(`${name}:measurement-missing`);
  }
  return value;
}

function validateFrozenReadSet(record, label, reasons) {
  if (record?.renderCount !== 1) {
    reasons.push(`${label}:render-count-not-one`);
  }
  if (record?.readCount !== D1_FROZEN_FRAME_READS) {
    reasons.push(`${label}:read-count-not-five`);
  }
  if (!(record?.subjectCoveragePixels > 0)) {
    reasons.push(`${label}:subject-not-rendered`);
  }
  for (const [field, reason] of [
    ["fixedJulian", "julian-advanced"],
    ["fixedCamera", "camera-advanced"],
    ["fixedSceneState", "scene-state-advanced"],
    ["fixedSortInput", "sort-input-advanced"],
  ]) {
    if (record?.[field] !== true) reasons.push(`${label}:${reason}`);
  }
}

/** D1 — five reads of exactly one rendered frame. */
export function evaluateD1FrozenFrame(input) {
  const reasons = [];
  validateFrozenReadSet(input?.tower, "tower", reasons);
  validateFrozenReadSet(input?.control, "control", reasons);
  const tower = finiteFractionOrReason(input?.tower, "tower", reasons);
  const control = finiteFractionOrReason(input?.control, "control", reasons);
  const measurements = {
    tower,
    control,
    towerSubjectCoveragePixels: input?.tower?.subjectCoveragePixels,
    controlSubjectCoveragePixels: input?.control?.subjectCoveragePixels,
  };
  if (reasons.length > 0) {
    return structuralResult("D1", reasons, { measurements });
  }

  const controlFired = frameVarianceFires(control);
  const signalFired = frameVarianceFires(tower);
  const checks = {
    oneRender: true,
    fiveReads: true,
    frozenInput: true,
    controlDoesNotFire: !controlFired,
    predictionHolds: !signalFired,
  };
  if (controlFired) {
    return statusResult("D1", "FAIL", {
      classification: "CONTROL_FIRED",
      signalFired,
      controlFired,
      measurements,
      checks,
      failures: [
        `D1:unit-cube-control-fired — predicted <= ${pct(FRAME_VARIANCE_THRESHOLD_FRACTION)}; measured ${pct(control)}`,
      ],
    });
  }
  if (signalFired) {
    return statusResult("D1", "FAIL", {
      classification: "CAPTURE_INSTRUMENT_NOISE",
      signalFired: true,
      measurements,
      checks,
      failures: [
        `D1:tower-frozen-frame-reads-disagree — predicted <= ${pct(FRAME_VARIANCE_THRESHOLD_FRACTION)}; measured ${pct(tower)}`,
      ],
      notes: ["D1 is the decider; D2-D5 are structurally ineligible."],
    });
  }
  return statusResult("D1", "PASS", {
    classification: "CAPTURE_PATH_EXONERATED",
    measurements,
    checks,
  });
}

function validateComparisonList(records, expected, label, reasons) {
  if (!Array.isArray(records) || records.length !== expected) {
    reasons.push(`${label}:comparison-count`);
    return [];
  }
  return records.map((record, index) =>
    finiteFractionOrReason(record, `${label}-${index}`, reasons),
  );
}

function canonicalD2InitialState(signature) {
  let state;
  try {
    state = JSON.parse(signature);
  } catch {
    return null;
  }
  if (
    state === null ||
    typeof state !== "object" ||
    Array.isArray(state) ||
    !D2_INITIAL_STATE_EQUIVALENCE_FIELDS.every((field) =>
      Object.hasOwn(state, field),
    )
  ) {
    return null;
  }
  return JSON.stringify(
    Object.fromEntries(
      D2_INITIAL_STATE_EQUIVALENCE_FIELDS.map((field) => [field, state[field]]),
    ),
  );
}

/** Compare scene state without treating fresh-page scheduling history as state. */
export function equivalentD2InitialStates(resetSignatures) {
  if (!Array.isArray(resetSignatures) || resetSignatures.length !== 4) {
    return false;
  }
  const canonicalStates = resetSignatures.map(canonicalD2InitialState);
  if (canonicalStates.some((state) => state === null)) return false;
  const stateMismatch = canonicalStates.some(
    (state) => state !== canonicalStates[0],
  );
  if (stateMismatch) return false;
  return true;
}

/** D2 — compare like framing with like framing across the two orders. */
export function evaluateD2Ordering(input) {
  const reasons = [];
  if (input?.fixedJulian !== true) reasons.push("D2:julian-advanced");
  if (input?.fixedCameras !== true) reasons.push("D2:cameras-not-fixed");
  if (input?.equivalentInitialStates !== true) {
    reasons.push("D2:initial-states-not-equivalent");
  }
  const controls = validateComparisonList(
    input?.sameStateControls,
    2,
    "D2-control",
    reasons,
  );
  const comparisons = validateComparisonList(
    input?.oppositeOrderSameState,
    2,
    "D2-order",
    reasons,
  );
  const control = controls.length > 0 ? Math.max(...controls) : Number.NaN;
  const main = comparisons.length > 0 ? Math.max(...comparisons) : Number.NaN;
  const measurements = {
    controls,
    comparisons,
    controlMax: control,
    orderMax: main,
  };
  if (reasons.length > 0) {
    return structuralResult("D2", reasons, { measurements });
  }

  const controlFired = controls.some(frameVarianceFires);
  const signalFired = comparisons.some(frameVarianceFires);
  const checks = {
    fixedInputs: true,
    likeComparedWithLike: true,
    controlDoesNotFire: !controlFired,
    predictionHolds: !signalFired,
  };
  if (controlFired) {
    return statusResult("D2", "FAIL", {
      classification: "CONTROL_FIRED",
      signalFired,
      controlFired: true,
      measurements,
      checks,
      failures: [
        `D2:same-state-control-fired — predicted both A->A and B->B <= ${pct(FRAME_VARIANCE_THRESHOLD_FRACTION)}; measured ${controls.map(pct).join("/")}`,
      ],
    });
  }
  if (signalFired) {
    return statusResult("D2", "FAIL", {
      classification: "STATE_CARRY_OVER",
      signalFired: true,
      measurements,
      checks,
      failures: [
        `D2:opposite-order-dependence — predicted A and B each <= ${pct(FRAME_VARIANCE_THRESHOLD_FRACTION)} across order; measured ${comparisons.map(pct).join("/")}`,
      ],
    });
  }
  return statusResult("D2", "PASS", {
    classification: "ORDERING_EXONERATED",
    measurements,
    checks,
  });
}

const D3_CELLS = Object.freeze([
  "towerAtTower",
  "towerAtCube",
  "cubeAtTower",
  "cubeAtCube",
]);

/** D3 — the complete two-assets by two-framings cross. */
export function evaluateD3AssetFramingCross(input) {
  const reasons = [];
  if (input?.fixedJulian !== true) reasons.push("D3:julian-advanced");
  if (input?.fixedCameras !== true) reasons.push("D3:cameras-not-fixed");
  const fractions = {};
  for (const cell of D3_CELLS) {
    const record = input?.cells?.[cell];
    fractions[cell] = finiteFractionOrReason(record, `D3:${cell}`, reasons);
    if (record?.framingValid !== true) {
      reasons.push(`D3:${cell}:framing-invalid`);
    }
    if (
      !Number.isInteger(record?.footprintPixels) ||
      record.footprintPixels <= 0
    ) {
      reasons.push(`D3:${cell}:subject-footprint-empty`);
    }
  }
  if (reasons.length > 0) {
    return structuralResult("D3", reasons, { measurements: fractions });
  }

  const fired = Object.fromEntries(
    D3_CELLS.map((cell) => [cell, frameVarianceFires(fractions[cell])]),
  );
  const controlFired = fired.cubeAtCube;
  if (controlFired) {
    return statusResult("D3", "FAIL", {
      classification: "CONTROL_FIRED",
      controlFired: true,
      signalFired: true,
      measurements: { fractions, fired },
      checks: {
        controlDoesNotFire: false,
        subjectReproduced: fired.towerAtTower,
      },
      failures: [
        `D3:unit-cube-baseline-fired — predicted <= ${pct(FRAME_VARIANCE_THRESHOLD_FRACTION)}; measured ${pct(fractions.cubeAtCube)}`,
      ],
    });
  }
  if (!fired.towerAtTower) {
    return structuralResult(
      "D3",
      [
        `D3:subject-not-reproduced — tower at its registered framing measured ${pct(fractions.towerAtTower)} against the unchanged ${pct(FRAME_VARIANCE_THRESHOLD_FRACTION)} bar`,
      ],
      {
        classification: "MIXED_OR_UNRESOLVED",
        measurements: { fractions, fired },
        checks: { controlDoesNotFire: true, subjectReproduced: false },
      },
    );
  }

  const assetContent =
    fired.towerAtTower &&
    fired.towerAtCube &&
    !fired.cubeAtTower &&
    !fired.cubeAtCube;
  const framing =
    fired.towerAtTower &&
    fired.cubeAtTower &&
    !fired.towerAtCube &&
    !fired.cubeAtCube;
  const classification = assetContent
    ? "ASSET_CONTENT"
    : framing
      ? "FRAMING"
      : "MIXED_OR_UNRESOLVED";
  const checks = {
    controlDoesNotFire: true,
    subjectReproduced: true,
    predictionHolds: assetContent,
  };
  const varianceFailure = `D3:tower-variance-over-bar — registered tower framing measured ${pct(fractions.towerAtTower)} against the unchanged ${pct(FRAME_VARIANCE_THRESHOLD_FRACTION)} bar`;
  return statusResult("D3", "FAIL", {
    classification,
    signalFired: Object.values(fired).some(Boolean),
    measurements: { fractions, fired },
    checks,
    failures: assetContent
      ? [varianceFailure]
      : [
          varianceFailure,
          `D3:asset-content-prediction-missed — measured pattern ${D3_CELLS.map((cell) => `${cell}=${fired[cell] ? "FIRE" : "quiet"}`).join(" ")}; classified ${classification}`,
        ],
  });
}

const SORT_IDENTITY_FIELDS = Object.freeze([
  "sourceObjectId",
  "permutationSha256",
  "length",
  "generation",
  "sequence",
  "residentBufferObjectId",
]);

function validateSortSnapshots(
  snapshots,
  minimum,
  label,
  reasons,
  requireRequestProvenance = false,
) {
  if (!Array.isArray(snapshots) || snapshots.length < minimum) {
    reasons.push(`${label}:snapshot-count`);
    return [];
  }
  for (const [index, snapshot] of snapshots.entries()) {
    if (!/^[0-9a-f]{64}$/u.test(snapshot?.permutationSha256 ?? "")) {
      reasons.push(`${label}-${index}:permutation-sha256`);
    }
    if (!Number.isInteger(snapshot?.length) || snapshot.length <= 0) {
      reasons.push(`${label}-${index}:permutation-length`);
    }
    if (
      typeof snapshot?.inputSignature !== "string" ||
      !snapshot.inputSignature
    ) {
      reasons.push(`${label}-${index}:input-signature`);
    }
    for (const field of [
      "sourceObjectId",
      "generation",
      "sequence",
      "residentBufferObjectId",
    ]) {
      if (!Number.isInteger(snapshot?.[field])) {
        reasons.push(`${label}-${index}:${field}`);
      }
    }
    if (requireRequestProvenance) {
      if (snapshot?.cleanStart !== true) {
        reasons.push(`${label}-${index}:clean-start`);
      }
      if (snapshot?.publicationComplete !== true) {
        reasons.push(`${label}-${index}:publication-complete`);
      }
      if (snapshot?.requestSequence !== snapshot?.sequence) {
        reasons.push(`${label}-${index}:request-sequence-provenance`);
      }
      if (snapshot?.requestGeneration !== snapshot?.generation) {
        reasons.push(`${label}-${index}:request-generation-provenance`);
      }
      if (
        typeof snapshot?.requestInputSignature !== "string" ||
        snapshot.requestInputSignature !== snapshot?.inputSignature
      ) {
        reasons.push(`${label}-${index}:request-input-provenance`);
      }
    }
  }
  if (requireRequestProvenance) {
    for (let index = 1; index < snapshots.length; index++) {
      if (
        snapshots[index]?.requestSequence <=
        snapshots[index - 1]?.requestSequence
      ) {
        reasons.push(`${label}-${index}:request-sequence-not-advancing`);
      }
    }
  }
  return snapshots;
}

function sortIdentityDelta(snapshots) {
  const first = snapshots[0];
  const changedFields = SORT_IDENTITY_FIELDS.filter((field) =>
    snapshots.slice(1).some((snapshot) => snapshot[field] !== first[field]),
  );
  const inputChanged = snapshots
    .slice(1)
    .some((snapshot) => snapshot.inputSignature !== first.inputSignature);
  return {
    stable: changedFields.length === 0,
    contentStable:
      !changedFields.includes("permutationSha256") &&
      !changedFields.includes("length"),
    changedFields,
    inputChanged,
    sourceObjectStable: !changedFields.includes("sourceObjectId"),
    residentBufferStable: !changedFields.includes("residentBufferObjectId"),
  };
}

/** D4 — exact sort-output identity and permutation content across frames. */
export function evaluateD4SortedIndexIdentity(input) {
  const reasons = [];
  const towerSnapshots = validateSortSnapshots(
    input?.towerSnapshots,
    3,
    "D4-tower",
    reasons,
    true,
  );
  const controlSnapshots = validateSortSnapshots(
    input?.controlPinnedReads,
    2,
    "D4-control",
    reasons,
  );
  const towerVariance = finiteFractionOrReason(
    input?.towerFrameVariance,
    "D4:tower-frame-variance",
    reasons,
  );
  if (reasons.length > 0) {
    return structuralResult("D4", reasons, {
      measurements: { towerVariance },
    });
  }

  const towerDelta = sortIdentityDelta(towerSnapshots);
  const controlDelta = sortIdentityDelta(controlSnapshots);
  if (towerDelta.inputChanged) {
    return structuralResult("D4", ["D4:tower-input-not-frozen"], {
      measurements: { towerVariance, towerDelta, controlDelta },
    });
  }
  if (controlDelta.inputChanged) {
    return structuralResult("D4", ["D4:control-input-not-pinned"], {
      measurements: { towerVariance, towerDelta, controlDelta },
    });
  }

  const controlFired = !controlDelta.stable;
  const varianceFired = frameVarianceFires(towerVariance);
  const checks = {
    fixedInput: true,
    controlDoesNotFire: !controlFired,
    subjectReproduced: varianceFired,
    predictionHolds: towerDelta.contentStable,
  };
  if (controlFired) {
    return statusResult("D4", "FAIL", {
      classification: "CONTROL_FIRED",
      controlFired: true,
      signalFired: varianceFired,
      measurements: { towerVariance, towerDelta, controlDelta },
      checks,
      failures: [
        `D4:pinned-read-control-fired — changed ${controlDelta.changedFields.join(", ")}`,
      ],
    });
  }
  if (!varianceFired) {
    return structuralResult(
      "D4",
      [
        `D4:subject-not-reproduced — tower frame variance measured ${pct(towerVariance)} against the unchanged ${pct(FRAME_VARIANCE_THRESHOLD_FRACTION)} bar`,
      ],
      {
        classification: towerDelta.contentStable
          ? "SORTER_STABLE_NO_PIXEL_SIGNAL"
          : "SORTER_CHANGED_NO_PIXEL_SIGNAL",
        signalFired: !towerDelta.contentStable,
        measurements: { towerVariance, towerDelta, controlDelta },
        checks,
      },
    );
  }
  const varianceFailure = `D4:tower-variance-over-bar — measured ${pct(towerVariance)} against the unchanged ${pct(FRAME_VARIANCE_THRESHOLD_FRACTION)} bar`;
  if (!towerDelta.contentStable) {
    return statusResult("D4", "FAIL", {
      classification: "SORTER_IMPLICATED",
      signalFired: true,
      measurements: { towerVariance, towerDelta, controlDelta },
      checks,
      failures: [
        varianceFailure,
        `D4:permutation-changed-at-fixed-input — changed ${towerDelta.changedFields.join(", ")} while pixels varied ${pct(towerVariance)}`,
      ],
    });
  }
  if (!towerDelta.residentBufferStable) {
    return statusResult("D4", "FAIL", {
      classification: "SORT_BUFFER_RECOMMIT",
      signalFired: true,
      measurements: { towerVariance, towerDelta, controlDelta },
      checks,
      failures: [
        varianceFailure,
        `D4:resident-buffer-recommit-with-stable-permutation — changed ${towerDelta.changedFields.join(", ")} while the permutation bytes stayed identical`,
      ],
    });
  }
  return statusResult("D4", "FAIL", {
    classification: "SORTER_PUBLICATION_EXONERATED",
    signalFired: true,
    measurements: { towerVariance, towerDelta, controlDelta },
    checks,
    failures: [varianceFailure],
  });
}

function imageShape(image, label) {
  const width = image?.width;
  const height = image?.height;
  const channels = image?.channels ?? 4;
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width <= 0 ||
    height <= 0 ||
    !Number.isInteger(channels) ||
    channels < 3 ||
    !image?.data ||
    image.data.length !== width * height * channels
  ) {
    throw new TypeError(`${label} is not a complete pixel frame`);
  }
  return { width, height, channels };
}

function sameImageShape(a, b, label) {
  const left = imageShape(a, `${label} left`);
  const right = imageShape(b, `${label} right`);
  if (
    left.width !== right.width ||
    left.height !== right.height ||
    left.channels !== right.channels
  ) {
    throw new RangeError(`${label} image dimensions differ`);
  }
  return left;
}

function rgbDiffers(a, b, offsetA, offsetB) {
  return (
    a[offsetA] !== b[offsetB] ||
    a[offsetA + 1] !== b[offsetB + 1] ||
    a[offsetA + 2] !== b[offsetB + 2]
  );
}

/** Exact RGB changed-pixel count over two persisted PNG decodes. */
export function changedPixelCount(left, right) {
  const { width, height, channels } = sameImageShape(
    left,
    right,
    "changed-pixel comparison",
  );
  let changed = 0;
  for (let pixel = 0; pixel < width * height; pixel++) {
    const offset = pixel * channels;
    if (rgbDiffers(left.data, right.data, offset, offset)) changed++;
  }
  return changed;
}

/** Maximum changed-pixel count among every pair, not merely adjacent reads. */
export function maxPairwiseChangedPixels(images) {
  if (!Array.isArray(images) || images.length < 2) {
    throw new RangeError("at least two images are required");
  }
  let maximum = 0;
  let pair = null;
  for (let left = 0; left < images.length; left++) {
    for (let right = left + 1; right < images.length; right++) {
      const changed = changedPixelCount(images[left], images[right]);
      if (changed > maximum || pair === null) {
        maximum = changed;
        pair = [left, right];
      }
    }
  }
  return { changedPixels: maximum, pair };
}

/**
 * Split a persisted variance map into a one-pixel, eight-neighbour silhouette
 * boundary and the remaining foreground interior. Rates are normalized by the
 * area of their own region so a thin edge band cannot win merely by size.
 */
export function analyzeSpatialDistribution(frameA, frameB, offFrame) {
  const { width, height, channels } = sameImageShape(
    frameA,
    frameB,
    "spatial variance pair",
  );
  sameImageShape(frameA, offFrame, "spatial off frame");
  const total = width * height;
  const foreground = new Uint8Array(total);
  const changed = new Uint8Array(total);
  for (let pixel = 0; pixel < total; pixel++) {
    const offset = pixel * channels;
    const aForeground = rgbDiffers(frameA.data, offFrame.data, offset, offset);
    const bForeground = rgbDiffers(frameB.data, offFrame.data, offset, offset);
    foreground[pixel] = aForeground || bForeground ? 1 : 0;
    changed[pixel] = rgbDiffers(frameA.data, frameB.data, offset, offset)
      ? 1
      : 0;
  }

  const boundary = new Uint8Array(total);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const pixel = y * width + x;
      if (foreground[pixel] === 0) continue;
      let isBoundary = false;
      for (let oy = -1; oy <= 1 && !isBoundary; oy++) {
        for (let ox = -1; ox <= 1; ox++) {
          if (ox === 0 && oy === 0) continue;
          const nx = x + ox;
          const ny = y + oy;
          if (
            nx < 0 ||
            nx >= width ||
            ny < 0 ||
            ny >= height ||
            foreground[ny * width + nx] === 0
          ) {
            isBoundary = true;
            break;
          }
        }
      }
      boundary[pixel] = isBoundary ? 1 : 0;
    }
  }

  let changedPixels = 0;
  let edgeArea = 0;
  let interiorArea = 0;
  let edgeChanged = 0;
  let interiorChanged = 0;
  let isolatedInteriorChanged = 0;
  let interiorComponentCount = 0;
  let largestInteriorComponent = 0;
  const interiorGridWidth = 8;
  const interiorGridHeight = 8;
  const interiorGridChanged = new Array(
    interiorGridWidth * interiorGridHeight,
  ).fill(0);
  for (let pixel = 0; pixel < total; pixel++) {
    if (foreground[pixel] === 0) continue;
    if (boundary[pixel]) {
      edgeArea++;
      if (changed[pixel]) edgeChanged++;
    } else {
      interiorArea++;
      if (changed[pixel]) interiorChanged++;
    }
    if (changed[pixel]) changedPixels++;
  }

  const isInteriorChange = (pixel) =>
    pixel >= 0 &&
    pixel < total &&
    changed[pixel] === 1 &&
    foreground[pixel] === 1 &&
    boundary[pixel] === 0;
  const visited = new Uint8Array(total);
  const queue = new Int32Array(total);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const pixel = y * width + x;
      if (!isInteriorChange(pixel)) continue;
      const gridX = Math.min(
        interiorGridWidth - 1,
        Math.floor((x * interiorGridWidth) / width),
      );
      const gridY = Math.min(
        interiorGridHeight - 1,
        Math.floor((y * interiorGridHeight) / height),
      );
      interiorGridChanged[gridY * interiorGridWidth + gridX]++;

      let neighbourCount = 0;
      for (let oy = -1; oy <= 1; oy++) {
        for (let ox = -1; ox <= 1; ox++) {
          if (ox === 0 && oy === 0) continue;
          const nx = x + ox;
          const ny = y + oy;
          if (
            nx >= 0 &&
            nx < width &&
            ny >= 0 &&
            ny < height &&
            isInteriorChange(ny * width + nx)
          ) {
            neighbourCount++;
          }
        }
      }
      if (neighbourCount === 0) isolatedInteriorChanged++;

      if (visited[pixel]) continue;
      interiorComponentCount++;
      let head = 0;
      let tail = 0;
      let componentSize = 0;
      visited[pixel] = 1;
      queue[tail++] = pixel;
      while (head < tail) {
        const current = queue[head++];
        componentSize++;
        const currentX = current % width;
        const currentY = Math.floor(current / width);
        for (let oy = -1; oy <= 1; oy++) {
          for (let ox = -1; ox <= 1; ox++) {
            if (ox === 0 && oy === 0) continue;
            const nx = currentX + ox;
            const ny = currentY + oy;
            if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
            const next = ny * width + nx;
            if (!visited[next] && isInteriorChange(next)) {
              visited[next] = 1;
              queue[tail++] = next;
            }
          }
        }
      }
      largestInteriorComponent = Math.max(
        largestInteriorComponent,
        componentSize,
      );
    }
  }
  // A changed pixel outside the union foreground is still part of the total
  // variance and must not disappear from the fixed canvas-fraction bar.
  for (let pixel = 0; pixel < total; pixel++) {
    if (changed[pixel] && foreground[pixel] === 0) changedPixels++;
  }
  return {
    width,
    height,
    canvasPixels: total,
    changedPixels,
    changedFraction: fractionOf(changedPixels, total),
    foregroundArea: edgeArea + interiorArea,
    edgeArea,
    interiorArea,
    edgeChanged,
    interiorChanged,
    edgeRate: fractionOf(edgeChanged, edgeArea),
    interiorRate: fractionOf(interiorChanged, interiorArea),
    isolatedInteriorChanged,
    isolatedInteriorFraction:
      interiorChanged > 0 ? isolatedInteriorChanged / interiorChanged : 0,
    interiorComponentCount,
    largestInteriorComponent,
    largestInteriorComponentFraction:
      interiorChanged > 0 ? largestInteriorComponent / interiorChanged : 0,
    occupiedInteriorGridCells: interiorGridChanged.filter((count) => count > 0)
      .length,
    interiorGridWidth,
    interiorGridHeight,
    interiorGridChanged,
  };
}

function validateSpatial(record, label, reasons) {
  if (record?.foregroundArea === 0) {
    reasons.push(`${label}:subject-not-rendered`);
    return;
  }
  for (const field of [
    "canvasPixels",
    "changedPixels",
    "foregroundArea",
    "edgeArea",
    "interiorArea",
    "edgeChanged",
    "interiorChanged",
    "edgeRate",
    "interiorRate",
    "isolatedInteriorChanged",
    "isolatedInteriorFraction",
    "interiorComponentCount",
    "largestInteriorComponent",
    "largestInteriorComponentFraction",
    "occupiedInteriorGridCells",
  ]) {
    if (!Number.isFinite(record?.[field])) reasons.push(`${label}:${field}`);
  }
  if (!(record?.edgeArea > 0)) reasons.push(`${label}:empty-edge-region`);
  if (!(record?.interiorArea > 0))
    reasons.push(`${label}:empty-interior-region`);
  if (
    record?.interiorGridWidth !== 8 ||
    record?.interiorGridHeight !== 8 ||
    !Array.isArray(record?.interiorGridChanged) ||
    record.interiorGridChanged.length !== 64 ||
    record.interiorGridChanged.some(
      (count) => !Number.isInteger(count) || count < 0,
    )
  ) {
    reasons.push(`${label}:incomplete-interior-grid`);
  }
  if (
    !Number.isInteger(record?.changedPixels) ||
    !Number.isInteger(record?.edgeChanged) ||
    !Number.isInteger(record?.interiorChanged) ||
    !Number.isInteger(record?.isolatedInteriorChanged) ||
    !Number.isInteger(record?.interiorComponentCount) ||
    !Number.isInteger(record?.largestInteriorComponent) ||
    !Number.isInteger(record?.occupiedInteriorGridCells) ||
    record.foregroundArea !== record.edgeArea + record.interiorArea ||
    record.changedPixels < record.edgeChanged + record.interiorChanged ||
    record.edgeChanged > record.edgeArea ||
    record.interiorChanged > record.interiorArea ||
    record.isolatedInteriorChanged > record.interiorChanged ||
    record.interiorComponentCount > record.interiorChanged ||
    record.largestInteriorComponent > record.interiorChanged ||
    record.occupiedInteriorGridCells > 64 ||
    record.interiorGridChanged.reduce((sum, count) => sum + count, 0) !==
      record.interiorChanged ||
    record.interiorGridChanged.filter((count) => count > 0).length !==
      record.occupiedInteriorGridCells ||
    (record.interiorChanged === 0 &&
      (record.interiorComponentCount !== 0 ||
        record.largestInteriorComponent !== 0 ||
        record.occupiedInteriorGridCells !== 0)) ||
    (record.interiorChanged > 0 &&
      (record.interiorComponentCount < 1 ||
        record.largestInteriorComponent < 1 ||
        record.occupiedInteriorGridCells < 1))
  ) {
    reasons.push(`${label}:inconsistent-interior-scatter`);
  }
}

/** D5 — area-normalized edge-band versus scattered-interior variance. */
export function evaluateD5SpatialDistribution(input) {
  const reasons = [];
  if (input?.fixedJulian !== true) reasons.push("D5:julian-advanced");
  if (input?.fixedCameras !== true) reasons.push("D5:cameras-not-fixed");
  validateSpatial(input?.tower, "D5-tower", reasons);
  validateSpatial(input?.control, "D5-control", reasons);
  const towerFraction = fractionOf(
    input?.tower?.changedPixels,
    input?.tower?.canvasPixels,
  );
  const controlFraction = fractionOf(
    input?.control?.changedPixels,
    input?.control?.canvasPixels,
  );
  const measurements = {
    towerFraction,
    controlFraction,
    towerForegroundArea: input?.tower?.foregroundArea,
    controlForegroundArea: input?.control?.foregroundArea,
    towerEdgeRate: input?.tower?.edgeRate,
    towerInteriorRate: input?.tower?.interiorRate,
    controlEdgeRate: input?.control?.edgeRate,
    controlInteriorRate: input?.control?.interiorRate,
    towerScattering: {
      isolatedInteriorChanged: input?.tower?.isolatedInteriorChanged,
      interiorChanged: input?.tower?.interiorChanged,
      isolatedInteriorFraction: input?.tower?.isolatedInteriorFraction,
      interiorComponentCount: input?.tower?.interiorComponentCount,
      largestInteriorComponent: input?.tower?.largestInteriorComponent,
      largestInteriorComponentFraction:
        input?.tower?.largestInteriorComponentFraction,
      occupiedInteriorGridCells: input?.tower?.occupiedInteriorGridCells,
      interiorGridWidth: input?.tower?.interiorGridWidth,
      interiorGridHeight: input?.tower?.interiorGridHeight,
      interiorGridChanged: input?.tower?.interiorGridChanged,
    },
    controlScattering: {
      isolatedInteriorChanged: input?.control?.isolatedInteriorChanged,
      interiorChanged: input?.control?.interiorChanged,
      isolatedInteriorFraction: input?.control?.isolatedInteriorFraction,
      interiorComponentCount: input?.control?.interiorComponentCount,
      largestInteriorComponent: input?.control?.largestInteriorComponent,
      largestInteriorComponentFraction:
        input?.control?.largestInteriorComponentFraction,
      occupiedInteriorGridCells: input?.control?.occupiedInteriorGridCells,
      interiorGridWidth: input?.control?.interiorGridWidth,
      interiorGridHeight: input?.control?.interiorGridHeight,
      interiorGridChanged: input?.control?.interiorGridChanged,
    },
  };
  if (reasons.length > 0) {
    const notes = [];
    if (input?.control?.foregroundArea === 0) {
      notes.push(
        "the unit-cube control produced zero rendered coverage — the control did not render and cannot satisfy or fire the lane",
      );
    }
    if (input?.tower?.foregroundArea === 0) {
      notes.push(
        "the tower subject produced zero rendered coverage — the subject did not render and cannot satisfy or fire the lane",
      );
    }
    return structuralResult("D5", reasons, { measurements, notes });
  }

  const controlFired = frameVarianceFires(controlFraction);
  const varianceFired = frameVarianceFires(towerFraction);
  if (controlFired) {
    return statusResult("D5", "FAIL", {
      classification: "CONTROL_FIRED",
      controlFired: true,
      signalFired: varianceFired,
      measurements,
      checks: { controlDoesNotFire: false, subjectReproduced: varianceFired },
      failures: [
        `D5:unit-cube-map-fired — predicted <= ${pct(FRAME_VARIANCE_THRESHOLD_FRACTION)}; measured ${pct(controlFraction)}`,
      ],
    });
  }
  if (!varianceFired) {
    return structuralResult(
      "D5",
      [
        `D5:subject-not-reproduced — tower map measured ${pct(towerFraction)} against the unchanged ${pct(FRAME_VARIANCE_THRESHOLD_FRACTION)} bar`,
      ],
      {
        classification: "MIXED_OR_UNRESOLVED",
        measurements,
        checks: { controlDoesNotFire: true, subjectReproduced: false },
      },
    );
  }

  const edgeRate = input.tower.edgeRate;
  const interiorRate = input.tower.interiorRate;
  const scatteredInterior =
    input.tower.interiorComponentCount >= 2 &&
    input.tower.occupiedInteriorGridCells >= 2;
  const classification =
    interiorRate > edgeRate && scatteredInterior
      ? "VOLUMETRIC"
      : edgeRate > interiorRate
        ? "EDGE_RASTER"
        : "MIXED_OR_UNRESOLVED";
  const predictionHolds = classification === "VOLUMETRIC";
  const varianceFailure = `D5:tower-variance-over-bar — measured ${pct(towerFraction)} against the unchanged ${pct(FRAME_VARIANCE_THRESHOLD_FRACTION)} bar`;
  return statusResult("D5", "FAIL", {
    classification,
    signalFired: true,
    measurements,
    checks: {
      controlDoesNotFire: true,
      subjectReproduced: true,
      scatteredInterior,
      predictionHolds,
    },
    failures: predictionHolds
      ? [varianceFailure]
      : [
          varianceFailure,
          `D5:spatial-prediction-missed — edge rate ${pct(edgeRate)}, interior rate ${pct(interiorRate)}; classified ${classification}`,
        ],
  });
}

const EVALUATORS = Object.freeze({
  D1: evaluateD1FrozenFrame,
  D2: evaluateD2Ordering,
  D3: evaluateD3AssetFramingCross,
  D4: evaluateD4SortedIndexIdentity,
  D5: evaluateD5SpatialDistribution,
});

/** Dispatch without accepting an alternate threshold. */
export function evaluateFrameVarianceLane(lane, input) {
  const evaluate = EVALUATORS[lane];
  if (!evaluate) {
    throw new RangeError(`unknown frame-variance lane ${String(lane)}`);
  }
  return evaluate(input);
}

/** Create a bounded runtime ERROR result through the same frozen exit table. */
export function createFrameVarianceErrorResult(message) {
  const bounded = String(message ?? "frame-variance harness error").slice(
    0,
    4096,
  );
  return {
    status: "ERROR",
    exitCode: exitCodeForS5Status("ERROR"),
    failures: [],
    structural: [],
    errors: [bounded],
  };
}

/**
 * Fold executed lanes. A requested downstream lane without a passing D1 is
 * structurally ineligible; callers never get to turn D1's decider into a note.
 */
export function foldFrameVarianceVerdict(results, requestedLane = "D1") {
  if (
    !FRAME_VARIANCE_LANE_IDS.includes(requestedLane) &&
    requestedLane !== "all"
  ) {
    throw new RangeError(`unknown requested lane ${String(requestedLane)}`);
  }
  const lanes = Array.isArray(results) ? results.filter(Boolean) : [];
  const d1Results = lanes.filter((result) => result.lane === "D1");
  const d1AllPass =
    d1Results.length > 0 &&
    d1Results.every((result) => result.status === "PASS");
  const downstreamRequested = requestedLane !== "D1";
  const errors = lanes.flatMap((result) => result.errors ?? []);
  const failures = lanes.flatMap((result) => result.failures ?? []);
  const structural = lanes.flatMap((result) => result.structural ?? []);
  if (errors.length > 0) {
    return {
      status: "ERROR",
      exitCode: exitCodeForS5Status("ERROR"),
      failures,
      structural,
      errors,
      lanes,
    };
  }
  if (d1Results.length === 0) structural.push("D1:missing-decider");
  if (downstreamRequested && !d1AllPass) {
    structural.push("D1:downstream-ineligible");
  }
  if (downstreamRequested && d1AllPass) {
    const required =
      requestedLane === "all"
        ? FRAME_VARIANCE_LANE_IDS.slice(1)
        : [requestedLane];
    for (const lane of required) {
      if (!lanes.some((result) => result.lane === lane)) {
        structural.push(`${lane}:missing-requested-result`);
      }
    }
  }

  let status = "PASS";
  if (failures.length > 0) status = "FAIL";
  else if (structural.length > 0) status = "STRUCTURAL";
  return {
    status,
    exitCode: exitCodeForS5Status(status),
    failures,
    structural,
    errors,
    lanes,
  };
}

export default Object.freeze({
  FRAME_VARIANCE_THRESHOLD_FRACTION,
  D1_FROZEN_FRAME_READS,
  FRAME_VARIANCE_LANE_IDS,
  FRAME_VARIANCE_EXIT_CODES,
  D2_INITIAL_STATE_EQUIVALENCE_FIELDS,
  FRAME_VARIANCE_DESIGNS,
  FRAME_VARIANCE_ASSETS,
  fractionOf,
  frameVarianceFires,
  measuredFraction,
  changedPixelCount,
  maxPairwiseChangedPixels,
  analyzeSpatialDistribution,
  evaluateD1FrozenFrame,
  equivalentD2InitialStates,
  evaluateD2Ordering,
  evaluateD3AssetFramingCross,
  evaluateD4SortedIndexIdentity,
  evaluateD5SpatialDistribution,
  evaluateFrameVarianceLane,
  createFrameVarianceErrorResult,
  foldFrameVarianceVerdict,
});
