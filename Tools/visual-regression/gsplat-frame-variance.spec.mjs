/**
 * @purpose Certifies the C15-G9 D1-D5 frame-variance model, probe contract, source predicate, and loud mutants.
 * @status ACTIVE
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import * as model from "./lib/gsplat-frame-variance-model.mjs";
import {
  D4_SCHEDULER_HISTORY_RESET_FIELDS,
  beginConsumedSourceAttestation,
  changedFootprintExtent,
  checkEmbeddedD4SchedulerHistoryResetIsCanonical,
  d3CellRecord,
  donorAssetScale,
  partitionD1Captures,
  registeredFramingMatches,
  resetD4SchedulerHistory,
  sorterWasmBinding,
  sorterWorkerBinding,
  sourceMapBindings,
} from "./probe-gsplat-frame-variance.mjs";
import {
  checkEmbeddedFusedSnapshotIsCanonical,
  checkFusedCaptureUsage,
} from "./lib/same-task-capture.mjs";
import { S5_STATUS_EXIT_CODES } from "./lib/verdict-exit-gate.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../..");
const MODEL_PATH = path.join(HERE, "lib/gsplat-frame-variance-model.mjs");
const PROBE_PATH = path.join(HERE, "probe-gsplat-frame-variance.mjs");
const EXIT_GATE_PATH = path.join(HERE, "lib/verdict-exit-gate.mjs");
const ENGINE_PATH = path.join(
  ROOT,
  "packages/engine/Source/Scene/GaussianSplatPrimitive.js",
);
const SORTER_PATH = path.join(
  ROOT,
  "packages/engine/Source/Scene/GaussianSplatSorter.js",
);
const TASK_PROCESSOR_PATH = path.join(
  ROOT,
  "packages/engine/Source/Core/TaskProcessor.js",
);
const SORT_WORKER_PATH = path.join(
  ROOT,
  "packages/engine/Source/Workers/gaussianSplatSorter.js",
);
const SORT_WASM_PATH = path.join(
  ROOT,
  "packages/engine/Source/ThirdParty/wasm_splats_bg.wasm",
);

function readNormalizedSource(file) {
  return fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n");
}

const MODEL_SOURCE = readNormalizedSource(MODEL_PATH);
const PROBE_SOURCE = readNormalizedSource(PROBE_PATH);
const ENGINE_SOURCE = readNormalizedSource(ENGINE_PATH);

const PIXELS = 1_000_000;
const QUIET_PIXELS = 500;
const OVER_BAR_PIXELS = 501;

function countOccurrences(source, anchor) {
  assert.ok(anchor.length > 0, "mutation anchor must not be empty");
  let count = 0;
  let cursor = 0;
  while (true) {
    const next = source.indexOf(anchor, cursor);
    if (next < 0) return count;
    count++;
    cursor = next + anchor.length;
  }
}

function mustReplace(source, anchor, replacement, label) {
  const count = countOccurrences(source, anchor);
  assert.equal(
    count,
    1,
    `${label}: expected exactly one mutation anchor, found ${count}`,
  );
  const start = source.indexOf(anchor);
  const mutated =
    source.slice(0, start) + replacement + source.slice(start + anchor.length);
  assert.notEqual(
    mutated,
    source,
    `${label}: mutation must change source bytes`,
  );
  return mutated;
}

const DATA_URL_MODEL_SOURCE = mustReplace(
  MODEL_SOURCE,
  '"./verdict-exit-gate.mjs"',
  JSON.stringify(pathToFileURL(EXIT_GATE_PATH).href),
  "data-URL model dependency",
);

async function importMutatedModel(mutant) {
  const source = mustReplace(
    DATA_URL_MODEL_SOURCE,
    mutant.anchor,
    mutant.replacement,
    mutant.id,
  );
  const payload = Buffer.from(source).toString("base64");
  return import(`data:text/javascript;base64,${payload}#${mutant.id}`);
}

function record(changedPixels = 0, canvasPixels = PIXELS) {
  return { changedPixels, canvasPixels };
}

function frozenRead(changedPixels = 0, overrides = {}) {
  return {
    ...record(changedPixels),
    renderCount: 1,
    readCount: 5,
    subjectCoveragePixels: 1_000,
    fixedJulian: true,
    fixedCamera: true,
    fixedSceneState: true,
    fixedSortInput: true,
    ...overrides,
  };
}

function d1Input(towerPixels = QUIET_PIXELS, controlPixels = 0) {
  return {
    tower: frozenRead(towerPixels),
    control: frozenRead(controlPixels),
  };
}

function d2Input(orderPixels = 0, controlPixels = 0) {
  return {
    fixedJulian: true,
    fixedCameras: true,
    equivalentInitialStates: true,
    sameStateControls: [record(controlPixels), record(0)],
    oppositeOrderSameState: [record(orderPixels), record(0)],
  };
}

function d2ResetSignature(overrides = {}) {
  return JSON.stringify({
    julian: "2461274.500000000",
    camera: "fixed-camera",
    indexesSha256: "a".repeat(64),
    indexesLength: 286_868,
    positionsSha256: "b".repeat(64),
    modelViewSha256: "c".repeat(64),
    positionsLength: 860_604,
    sequence: 6,
    generation: 4,
    dataGeneration: 4,
    sortThrottleSatisfied: true,
    inFlight: false,
    ...overrides,
  });
}

function d2ResetSignatures(...overrides) {
  return [0, 1, 2, 3].map((index) => d2ResetSignature(overrides[index]));
}

function d3Input(pattern = {}) {
  const value = (name) => (pattern[name] ? OVER_BAR_PIXELS : 0);
  return {
    fixedJulian: true,
    fixedCameras: true,
    cells: {
      towerAtTower: {
        ...record(value("towerAtTower")),
        framingValid: true,
        footprintPixels: 1_000,
      },
      towerAtCube: {
        ...record(value("towerAtCube")),
        framingValid: true,
        footprintPixels: 1_000,
      },
      cubeAtTower: {
        ...record(value("cubeAtTower")),
        framingValid: true,
        footprintPixels: 1_000,
      },
      cubeAtCube: {
        ...record(value("cubeAtCube")),
        framingValid: true,
        footprintPixels: 1_000,
      },
    },
  };
}

const RECORDED_CUBE_FOOTPRINT_EXTENTS = Object.freeze([
  Object.freeze({
    valid: true,
    changed: 85_455,
    borderCoveragePixels: 40,
    extent: Object.freeze({ minX: 134, minY: 0, maxX: 889, maxY: 748 }),
    contained: false,
  }),
  Object.freeze({
    valid: true,
    changed: 85_455,
    borderCoveragePixels: 40,
    extent: Object.freeze({ minX: 134, minY: 0, maxX: 889, maxY: 748 }),
    contained: false,
  }),
]);

function validD3CellWitness(overrides = {}) {
  return {
    framing: { valid: true },
    metadata: { framingValid: true },
    registeredFramingMatch: true,
    ...overrides,
  };
}

function recordedCubeCell(subject = d3CellRecord, raw = validD3CellWitness()) {
  return subject(raw, RECORDED_CUBE_FOOTPRINT_EXTENTS, record(0));
}

function d3A1Holds(subject) {
  const cell = recordedCubeCell(subject);
  return (
    cell.framingValid === true &&
    cell.footprintPixels === 85_455 &&
    cell.subjectCoverageContained === false &&
    cell.borderCoveragePixels > 0
  );
}

function d3ReplayInput(subject = d3CellRecord) {
  const towerExtent = [
    {
      valid: true,
      changed: 90_000,
      borderCoveragePixels: 0,
      extent: { minX: 200, minY: 100, maxX: 800, maxY: 700 },
      contained: true,
    },
  ];
  return {
    fixedJulian: true,
    fixedCameras: true,
    cells: {
      towerAtTower: subject(
        validD3CellWitness(),
        towerExtent,
        record(OVER_BAR_PIXELS),
      ),
      towerAtCube: subject(
        validD3CellWitness(),
        towerExtent,
        record(OVER_BAR_PIXELS),
      ),
      cubeAtTower: recordedCubeCell(subject),
      cubeAtCube: recordedCubeCell(subject),
    },
  };
}

function sortSnapshot(overrides = {}) {
  const snapshot = {
    sourceObjectId: 11,
    permutationSha256: "a".repeat(64),
    length: 27,
    generation: 7,
    sequence: 9,
    residentBufferObjectId: 13,
    inputSignature: "fixed-input",
    ...overrides,
  };
  return {
    ...snapshot,
    cleanStart: overrides.cleanStart ?? true,
    publicationComplete: overrides.publicationComplete ?? true,
    requestSequence: overrides.requestSequence ?? snapshot.sequence,
    requestGeneration: overrides.requestGeneration ?? snapshot.generation,
    requestInputSignature:
      overrides.requestInputSignature ?? snapshot.inputSignature,
  };
}

function d4Input() {
  return {
    towerSnapshots: [
      sortSnapshot({ sourceObjectId: 11, sequence: 9 }),
      sortSnapshot({ sourceObjectId: 12, sequence: 10 }),
      sortSnapshot({ sourceObjectId: 14, sequence: 11 }),
    ],
    controlPinnedReads: [
      sortSnapshot({ sourceObjectId: 14, sequence: 11 }),
      sortSnapshot({ sourceObjectId: 14, sequence: 11 }),
    ],
    towerFrameVariance: record(OVER_BAR_PIXELS),
  };
}

function spatialRecord(options = {}) {
  const requestedChangedPixels = options.changedPixels ?? OVER_BAR_PIXELS;
  const edgeRate = options.edgeRate ?? (requestedChangedPixels > 0 ? 0.001 : 0);
  const interiorRate =
    options.interiorRate ?? (requestedChangedPixels > 0 ? 0.002 : 0);
  const edgeChanged = Math.round(edgeRate * 100_000);
  const interiorChanged = Math.round(interiorRate * 200_000);
  const changedPixels = Math.max(
    requestedChangedPixels,
    edgeChanged + interiorChanged,
  );
  const occupiedInteriorGridCells = Math.min(64, interiorChanged);
  const interiorGridChanged = new Array(64).fill(0);
  for (let index = 0; index < interiorChanged; index++) {
    interiorGridChanged[index % Math.max(1, occupiedInteriorGridCells)]++;
  }
  return {
    canvasPixels: PIXELS,
    changedPixels,
    foregroundArea: 300_000,
    edgeArea: 100_000,
    interiorArea: 200_000,
    edgeChanged,
    interiorChanged,
    edgeRate,
    interiorRate,
    isolatedInteriorChanged: interiorChanged,
    isolatedInteriorFraction: interiorChanged > 0 ? 1 : 0,
    interiorComponentCount: interiorChanged,
    largestInteriorComponent: interiorChanged > 0 ? 1 : 0,
    largestInteriorComponentFraction:
      interiorChanged > 0 ? 1 / interiorChanged : 0,
    occupiedInteriorGridCells,
    interiorGridWidth: 8,
    interiorGridHeight: 8,
    interiorGridChanged,
  };
}

function d5Input(
  tower = spatialRecord(),
  control = spatialRecord({ changedPixels: 0 }),
) {
  return { fixedJulian: true, fixedCameras: true, tower, control };
}

const EXPECTED_DESIGNS = {
  D1: {
    prediction:
      "With Julian date, camera, scene state, and sort input frozen, every pair among five canonical fused snapshots of the tower will differ by at most 0.050% of canvas pixels.",
    discrimination:
      "If any pair exceeds 0.050%, D1 identifies capture/instrument noise and D2-D5 are structurally ineligible; otherwise the capture path is sufficiently stable for downstream discrimination.",
    control:
      "The 27-splat unit cube under the same one-render/five-read protocol must remain at or below 0.050% and must not fire D1.",
  },
  D2: {
    prediction:
      "At fixed framing A and fixed framing B, both same-framing comparisons between the A->B and B->A executions remain at or below 0.050%; no state carry-over is predicted.",
    discrimination:
      "Run A->B, B->A, A->A, and B->B in four fresh pages from byte-equivalent reset witnesses. Compare A from A->B only with A from B->A, and B from A->B only with B from B->A; never compare A directly with B. An over-bar same-framing comparison implicates state carry-over only when the repeated A->A and B->B controls remain below the bar.",
    control:
      "Repeated A->A and B->B captures at frozen input must each remain at or below 0.050% and must not fire the ordering lane.",
  },
  D3: {
    prediction:
      "An asset-content mechanism produces over-bar variance for tower in both framings and at-or-below-bar variance for the unit cube in both framings; a framing mechanism produces over-bar variance for both assets at tower framing and at-or-below-bar variance for both assets at cube framing.",
    discrimination:
      "Evaluate the complete asset x framing cross only when each crossed asset is uniformly scaled about its bounding-sphere center to preserve the donor framing's absolute camera range and angular footprint, and every cell proves a centered, unclipped framing and a nonzero persisted subject footprint. Classify ASSET_CONTENT only when both tower cells fire and both cube cells do not; classify FRAMING only when both tower-framing cells fire and both cube-framing cells do not; every other pattern is MIXED_OR_UNRESOLVED.",
    control:
      "The unit cube at its registered cube framing must remain at or below 0.050% and must not fire either pure-mechanism branch.",
  },
  D4: {
    prediction:
      "At frozen Julian date, camera, asset payload, and data generation, three clean-start sort requests bound to byte-exact request-time inputs publish byte-identical permutation content; request sequence, source-object identity, and resident GPU-buffer identity are recorded separately.",
    discrimination:
      "Deliberately schedule three sort publications from a clean no-sort-in-flight state while the byte-exact request-time positions and model-view inputs remain fixed. Tower variance above 0.050% accompanied by changed permutation content implicates the sorter; tower variance above 0.050% with byte-identical permutation content excludes sorter publication as the direct mechanism. Fresh typed-array identity and advancing request sequence are expected and cannot masquerade as permutation change; resident-buffer recommit is classified separately.",
    control:
      "Two reads of the same pinned permutation with no render or sort publication between them must be byte-identical and must not fire D4.",
  },
  D5: {
    prediction:
      "When tower variance exceeds 0.050%, the area-normalized changed-pixel rate is higher in the scattered interior than in the one-pixel silhouette-edge band.",
    discrimination:
      "Classify only when total tower variance exceeds 0.050%. EDGE_RASTER requires edge-band rate greater than interior rate. VOLUMETRIC requires interior rate greater than edge-band rate plus at least two eight-neighbor interior components occupying at least two cells of the fixed 8x8 grid. Equality, a contiguous interior blob, an empty region, or an incomplete map is MIXED_OR_UNRESOLVED.",
    control:
      "The unit cube frozen-frame variance map must remain at or below 0.050% and must not fire either spatial-distribution branch.",
  },
};

test("pre-registration fixes lane order, predictions, discrimination, and controls", () => {
  assert.deepEqual(model.FRAME_VARIANCE_LANE_IDS, [
    "D1",
    "D2",
    "D3",
    "D4",
    "D5",
  ]);
  assert.deepEqual(model.FRAME_VARIANCE_DESIGNS, EXPECTED_DESIGNS);
  assert.ok(Object.isFrozen(model.FRAME_VARIANCE_DESIGNS));
  for (const lane of model.FRAME_VARIANCE_LANE_IDS) {
    assert.ok(Object.isFrozen(model.FRAME_VARIANCE_DESIGNS[lane]));
  }
});

test("the only bar is 0.0005, equality is quiet, and no override path exists", () => {
  assert.equal(model.FRAME_VARIANCE_THRESHOLD_FRACTION, 0.0005);
  assert.equal(countOccurrences(MODEL_SOURCE, "0.0005"), 1);
  assert.equal(countOccurrences(PROBE_SOURCE, "0.0005"), 0);
  assert.equal(PROBE_SOURCE.includes("--threshold"), false);
  assert.equal(
    PROBE_SOURCE.includes("PROBE_GSPLAT_FRAME_VARIANCE_THRESHOLD"),
    false,
  );
  assert.equal(model.frameVarianceFires(0.0005), false);
  assert.equal(model.frameVarianceFires(0.000500001), true);
  assert.equal(model.frameVarianceFires(Number.NaN), false);
  assert.equal(model.frameVarianceFires.length, 1);
  assert.equal(model.evaluateD1FrozenFrame.length, 1);
  assert.equal(model.evaluateD2Ordering.length, 1);
  assert.equal(model.evaluateD3AssetFramingCross.length, 1);
  assert.equal(model.evaluateD4SortedIndexIdentity.length, 1);
  assert.equal(model.evaluateD5SpatialDistribution.length, 1);
});

test("all result exits come from the frozen shared verdict table", () => {
  assert.strictEqual(model.FRAME_VARIANCE_EXIT_CODES, S5_STATUS_EXIT_CODES);
  assert.deepEqual(S5_STATUS_EXIT_CODES, {
    PASS: 0,
    FAIL: 1,
    ERROR: 2,
    STRUCTURAL: 3,
  });
  assert.equal(model.evaluateD1FrozenFrame(d1Input()).exitCode, 0);
  assert.equal(
    model.evaluateD1FrozenFrame(d1Input(OVER_BAR_PIXELS)).exitCode,
    1,
  );
  assert.equal(model.createFrameVarianceErrorResult("boom").exitCode, 2);
  const structural = d1Input();
  structural.tower.fixedJulian = false;
  assert.equal(model.evaluateD1FrozenFrame(structural).exitCode, 3);
});

test("D1 decides frozen-frame stability and its cube control never silently passes", () => {
  const boundary = model.evaluateD1FrozenFrame(d1Input(QUIET_PIXELS));
  assert.equal(boundary.status, "PASS");
  assert.equal(boundary.classification, "CAPTURE_PATH_EXONERATED");

  const noise = model.evaluateD1FrozenFrame(d1Input(OVER_BAR_PIXELS));
  assert.equal(noise.status, "FAIL");
  assert.equal(noise.classification, "CAPTURE_INSTRUMENT_NOISE");

  const control = model.evaluateD1FrozenFrame(d1Input(0, OVER_BAR_PIXELS));
  assert.equal(control.status, "FAIL");
  assert.equal(control.classification, "CONTROL_FIRED");

  const advanced = d1Input();
  advanced.tower.renderCount = 2;
  assert.equal(model.evaluateD1FrozenFrame(advanced).status, "STRUCTURAL");
});

test("D1 rejects a zero-coverage control without confusing it with zero variance", () => {
  const renderedQuiet = model.evaluateD1FrozenFrame(d1Input(0, 0));
  assert.equal(renderedQuiet.status, "PASS");
  assert.equal(renderedQuiet.measurements.control, 0);
  assert.ok(renderedQuiet.measurements.controlSubjectCoveragePixels > 0);

  const blank = d1Input(0, 0);
  blank.control.subjectCoveragePixels = 0;
  const result = model.evaluateD1FrozenFrame(blank);
  assert.equal(result.status, "STRUCTURAL");
  assert.deepEqual(result.structural, ["control:subject-not-rendered"]);
});

test("D1 is mandatory and makes requested downstream lanes ineligible", () => {
  const absent = model.foldFrameVarianceVerdict([], "D4");
  assert.equal(absent.status, "STRUCTURAL");
  assert.ok(absent.structural.includes("D1:missing-decider"));
  assert.ok(absent.structural.includes("D1:downstream-ineligible"));

  const noisy = model.evaluateD1FrozenFrame(d1Input(OVER_BAR_PIXELS));
  const blocked = model.foldFrameVarianceVerdict([noisy], "D4");
  assert.equal(blocked.status, "FAIL");
  assert.ok(blocked.structural.includes("D1:downstream-ineligible"));

  const onePassOneRed = model.foldFrameVarianceVerdict(
    [model.evaluateD1FrozenFrame(d1Input()), noisy],
    "D4",
  );
  assert.ok(onePassOneRed.structural.includes("D1:downstream-ineligible"));

  const missingSelected = model.foldFrameVarianceVerdict(
    [model.evaluateD1FrozenFrame(d1Input())],
    "D4",
  );
  assert.equal(missingSelected.status, "STRUCTURAL");
  assert.ok(missingSelected.structural.includes("D4:missing-requested-result"));
});

test("D2 compares only same framings across order and keeps AA/BB as controls", () => {
  const quiet = model.evaluateD2Ordering(d2Input());
  assert.equal(quiet.status, "PASS");
  assert.equal(quiet.classification, "ORDERING_EXONERATED");

  const carry = model.evaluateD2Ordering(d2Input(OVER_BAR_PIXELS));
  assert.equal(carry.status, "FAIL");
  assert.equal(carry.classification, "STATE_CARRY_OVER");

  const control = model.evaluateD2Ordering(d2Input(0, OVER_BAR_PIXELS));
  assert.equal(control.status, "FAIL");
  assert.equal(control.classification, "CONTROL_FIRED");

  const unpinned = d2Input();
  unpinned.fixedCameras = false;
  assert.equal(model.evaluateD2Ordering(unpinned).status, "STRUCTURAL");

  const unequalReset = d2Input();
  unequalReset.equivalentInitialStates = false;
  assert.equal(model.evaluateD2Ordering(unequalReset).status, "STRUCTURAL");
});

test("D2 accepts the observed sequence-only reset difference", () => {
  assert.deepEqual(model.D2_INITIAL_STATE_EQUIVALENCE_FIELDS, [
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
  const equivalentInitialStates = model.equivalentD2InitialStates(
    d2ResetSignatures(
      { sequence: 6 },
      { sequence: 7 },
      { sequence: 6 },
      { sequence: 7 },
    ),
  );
  assert.equal(equivalentInitialStates, true);
  assert.equal(
    model.evaluateD2Ordering({
      ...d2Input(),
      equivalentInitialStates,
    }).status,
    "PASS",
  );
});

test("D2 rejects a scene-state reset mismatch", () => {
  const equivalentInitialStates = model.equivalentD2InitialStates(
    d2ResetSignatures({}, {}, { positionsSha256: "d".repeat(64) }, {}),
  );
  assert.equal(equivalentInitialStates, false);
  const result = model.evaluateD2Ordering({
    ...d2Input(),
    equivalentInitialStates,
  });
  assert.equal(result.status, "STRUCTURAL");
  assert.deepEqual(result.structural, ["D2:initial-states-not-equivalent"]);
});

test("every equivalence field is load-bearing and the excluded three are not", () => {
  const perturbed = {
    julian: "2026-06-01T18:00:01Z",
    camera: "a-different-camera",
    indexesSha256: "e".repeat(64),
    indexesLength: 286_869,
    positionsSha256: "f".repeat(64),
    positionsLength: 860_605,
    modelViewSha256: "0".repeat(64),
    generation: 5,
    dataGeneration: 5,
  };
  assert.deepEqual(Object.keys(perturbed), [
    ...model.D2_INITIAL_STATE_EQUIVALENCE_FIELDS,
  ]);
  for (const [field, value] of Object.entries(perturbed)) {
    assert.equal(
      model.equivalentD2InitialStates(
        d2ResetSignatures({}, {}, { [field]: value }, {}),
      ),
      false,
      `${field} must break initial-state equivalence`,
    );
  }
  for (const field of ["sequence", "sortThrottleSatisfied", "inFlight"]) {
    assert.equal(
      model.equivalentD2InitialStates(
        d2ResetSignatures({}, {}, { [field]: 99 }, {}),
      ),
      true,
      `${field} must not break initial-state equivalence`,
    );
  }
  assert.ok(Object.isFrozen(model.D2_INITIAL_STATE_EQUIVALENCE_FIELDS));
});

test("D3 classifies the complete asset/framing cross without de-scoring the red", () => {
  const asset = model.evaluateD3AssetFramingCross(
    d3Input({ towerAtTower: true, towerAtCube: true }),
  );
  assert.equal(asset.status, "FAIL");
  assert.equal(asset.classification, "ASSET_CONTENT");
  assert.match(asset.failures[0], /tower-variance-over-bar/u);

  const framing = model.evaluateD3AssetFramingCross(
    d3Input({ towerAtTower: true, cubeAtTower: true }),
  );
  assert.equal(framing.status, "FAIL");
  assert.equal(framing.classification, "FRAMING");

  const interaction = model.evaluateD3AssetFramingCross(
    d3Input({ towerAtTower: true }),
  );
  assert.equal(interaction.classification, "MIXED_OR_UNRESOLVED");

  const control = model.evaluateD3AssetFramingCross(
    d3Input({ towerAtTower: true, towerAtCube: true, cubeAtCube: true }),
  );
  assert.equal(control.classification, "CONTROL_FIRED");

  assert.equal(
    model.evaluateD3AssetFramingCross(d3Input()).status,
    "STRUCTURAL",
  );
  const unpinned = d3Input({ towerAtTower: true, towerAtCube: true });
  unpinned.fixedCameras = false;
  assert.equal(
    model.evaluateD3AssetFramingCross(unpinned).status,
    "STRUCTURAL",
  );
  const clipped = d3Input({ towerAtTower: true, towerAtCube: true });
  clipped.cells.cubeAtTower.framingValid = false;
  assert.equal(model.evaluateD3AssetFramingCross(clipped).status, "STRUCTURAL");
});

test("A1 D3 records border coverage without invalidating registered framing", () => {
  const cell = recordedCubeCell();
  assert.equal(cell.framingValid, true);
  assert.equal(cell.footprintPixels, 85_455);
  assert.equal(cell.subjectCoverageContained, false);
  assert.ok(cell.borderCoveragePixels > 0);
});

test("A2 recorded cube witnesses reach a scored D3 asset classification", () => {
  const result = model.evaluateD3AssetFramingCross(d3ReplayInput());
  assert.equal(
    result.structural.some((reason) =>
      /^D3:cubeAt(?:Tower|Cube):framing-invalid$/u.test(reason),
    ),
    false,
  );
  assert.equal(result.status, "FAIL");
  assert.equal(result.classification, "ASSET_CONTENT");
});

test("A3 genuine D3 framing failures retain their cell-specific reason", () => {
  for (const raw of [
    validD3CellWitness({ framing: { valid: false } }),
    validD3CellWitness({ metadata: { framingValid: false } }),
    validD3CellWitness({ registeredFramingMatch: false }),
  ]) {
    const input = d3ReplayInput();
    input.cells.cubeAtTower = d3CellRecord(
      raw,
      RECORDED_CUBE_FOOTPRINT_EXTENTS,
      record(0),
    );
    const result = model.evaluateD3AssetFramingCross(input);
    assert.equal(result.status, "STRUCTURAL");
    assert.ok(result.structural.includes("D3:cubeAtTower:framing-invalid"));
  }
});

test("A4 an empty D3 footprint is named independently from framing", () => {
  const input = d3ReplayInput();
  input.cells.cubeAtTower = d3CellRecord(validD3CellWitness(), [], record(0));
  const result = model.evaluateD3AssetFramingCross(input);
  assert.equal(result.status, "STRUCTURAL");
  assert.ok(
    result.structural.includes("D3:cubeAtTower:subject-footprint-empty"),
  );
  assert.equal(
    result.structural.includes("D3:cubeAtTower:framing-invalid"),
    false,
  );
});

test("D4 separates permutation content, expected source identity, resident recommit, input drift, and pinned control", () => {
  const stable = model.evaluateD4SortedIndexIdentity(d4Input());
  assert.equal(stable.status, "FAIL");
  assert.equal(stable.classification, "SORTER_PUBLICATION_EXONERATED");
  assert.match(stable.failures[0], /tower-variance-over-bar/u);

  const contentInput = d4Input();
  contentInput.towerSnapshots[2].permutationSha256 = "b".repeat(64);
  const content = model.evaluateD4SortedIndexIdentity(contentInput);
  assert.equal(content.classification, "SORTER_IMPLICATED");

  const churnInput = d4Input();
  churnInput.towerSnapshots[2].sourceObjectId = 99;
  const churn = model.evaluateD4SortedIndexIdentity(churnInput);
  assert.equal(churn.classification, "SORTER_PUBLICATION_EXONERATED");

  const recommitInput = d4Input();
  recommitInput.towerSnapshots[2].residentBufferObjectId = 99;
  const recommit = model.evaluateD4SortedIndexIdentity(recommitInput);
  assert.equal(recommit.classification, "SORT_BUFFER_RECOMMIT");

  const driftInput = d4Input();
  driftInput.towerSnapshots[2].inputSignature = "different-input";
  driftInput.towerSnapshots[2].requestInputSignature = "different-input";
  assert.equal(
    model.evaluateD4SortedIndexIdentity(driftInput).status,
    "STRUCTURAL",
  );

  const controlInput = d4Input();
  controlInput.controlPinnedReads[1].sequence = 10;
  assert.equal(
    model.evaluateD4SortedIndexIdentity(controlInput).classification,
    "CONTROL_FIRED",
  );
});

function d4ResetHolds(subject) {
  const previousViewMatrix = new Float64Array(16).map(
    (_value, index) => index + 1,
  );
  const primitive = {
    _lastSteadySortFrameNumber: 42,
    _hasLastSteadySortCameraPosition: true,
    _hasLastSteadySortCameraDirection: true,
    _prevViewMatrix: previousViewMatrix,
  };
  const C = {
    Matrix4: {
      ZERO: Object.freeze(new Array(16).fill(0)),
      clone(source, result) {
        for (let index = 0; index < 16; index++) result[index] = source[index];
        return result;
      },
    },
  };
  subject(C, primitive);
  return (
    primitive._lastSteadySortFrameNumber === -1 &&
    primitive._hasLastSteadySortCameraPosition === false &&
    primitive._hasLastSteadySortCameraDirection === false &&
    primitive._prevViewMatrix === previousViewMatrix &&
    [...previousViewMatrix].every((value) => value === 0)
  );
}

test("B1 the canonical D4 reset clears all scheduler history in place", () => {
  const rawProbeSource = fs.readFileSync(PROBE_PATH, "utf8");
  assert.deepEqual(
    checkEmbeddedD4SchedulerHistoryResetIsCanonical(rawProbeSource),
    [],
  );
  assert.deepEqual(
    checkEmbeddedD4SchedulerHistoryResetIsCanonical(PROBE_SOURCE),
    [],
  );
  assert.equal(d4ResetHolds(resetD4SchedulerHistory), true);
  assert.deepEqual(D4_SCHEDULER_HISTORY_RESET_FIELDS, [
    "_lastSteadySortFrameNumber",
    "_hasLastSteadySortCameraPosition",
    "_hasLastSteadySortCameraDirection",
    "_prevViewMatrix",
  ]);
});

test("D5 uses area-normalized edge/interior rates and retains the tower red", () => {
  const volumetric = model.evaluateD5SpatialDistribution(d5Input());
  assert.equal(volumetric.status, "FAIL");
  assert.equal(volumetric.classification, "VOLUMETRIC");
  assert.match(volumetric.failures[0], /tower-variance-over-bar/u);

  const edge = model.evaluateD5SpatialDistribution(
    d5Input(spatialRecord({ edgeRate: 0.003, interiorRate: 0.001 })),
  );
  assert.equal(edge.classification, "EDGE_RASTER");

  const tied = model.evaluateD5SpatialDistribution(
    d5Input(spatialRecord({ edgeRate: 0.002, interiorRate: 0.002 })),
  );
  assert.equal(tied.classification, "MIXED_OR_UNRESOLVED");

  const blobMap = spatialRecord();
  blobMap.interiorComponentCount = 1;
  blobMap.largestInteriorComponent = blobMap.interiorChanged;
  blobMap.largestInteriorComponentFraction = 1;
  blobMap.occupiedInteriorGridCells = 1;
  blobMap.interiorGridChanged = [
    blobMap.interiorChanged,
    ...new Array(63).fill(0),
  ];
  const blob = model.evaluateD5SpatialDistribution(d5Input(blobMap));
  assert.equal(blob.classification, "MIXED_OR_UNRESOLVED");

  const control = model.evaluateD5SpatialDistribution(
    d5Input(spatialRecord(), spatialRecord({ changedPixels: OVER_BAR_PIXELS })),
  );
  assert.equal(control.classification, "CONTROL_FIRED");

  const absent = model.evaluateD5SpatialDistribution(
    d5Input(spatialRecord({ changedPixels: 0 })),
  );
  assert.equal(absent.status, "STRUCTURAL");

  const unpinned = d5Input();
  unpinned.fixedJulian = false;
  assert.equal(
    model.evaluateD5SpatialDistribution(unpinned).status,
    "STRUCTURAL",
  );
});

function image(width, height, onPixels, changedPixels = new Map()) {
  const data = new Uint8Array(width * height * 4);
  for (const pixel of onPixels) {
    const offset = pixel * 4;
    data[offset] = 100;
    data[offset + 1] = 100;
    data[offset + 2] = 100;
    data[offset + 3] = 255;
  }
  for (const [pixel, value] of changedPixels) {
    const offset = pixel * 4;
    data[offset] = value;
    data[offset + 1] = value;
    data[offset + 2] = value;
    data[offset + 3] = 255;
  }
  return { width, height, channels: 4, data };
}

function blankSpatialRecord(subject = model) {
  const blank = image(5, 5, new Set());
  return subject.analyzeSpatialDistribution(blank, blank, blank);
}

function renderedQuietDiscSpatialRecord(subject = model) {
  const foreground = new Set();
  for (let y = 0; y < 7; y++) {
    for (let x = 0; x < 7; x++) {
      if ((x - 3) ** 2 + (y - 3) ** 2 <= 4) foreground.add(y * 7 + x);
    }
  }
  const off = image(7, 7, new Set());
  const on = image(7, 7, foreground);
  return subject.analyzeSpatialDistribution(on, on, off);
}

function sliverSpatialRecord(subject = model) {
  const foreground = new Set([11, 12, 13]);
  const off = image(5, 5, new Set());
  const on = image(5, 5, foreground);
  return subject.analyzeSpatialDistribution(on, on, off);
}

test("C1 blank on/off frames report zero foreground, edge, and interior area", () => {
  const blank = blankSpatialRecord();
  assert.equal(blank.foregroundArea, 0);
  assert.equal(blank.edgeArea, 0);
  assert.equal(blank.interiorArea, 0);
});

test("C2 a blank D5 control is void with one named reason", () => {
  const result = model.evaluateD5SpatialDistribution(
    d5Input(spatialRecord(), blankSpatialRecord()),
  );
  assert.equal(result.status, "STRUCTURAL");
  assert.deepEqual(result.structural, ["D5-control:subject-not-rendered"]);
  assert.equal(
    result.structural.some((reason) =>
      /D5-control:(?:edgeRate|interiorRate|empty-edge-region|empty-interior-region)/u.test(
        reason,
      ),
    ),
    false,
  );
  assert.deepEqual(result.notes, [
    "the unit-cube control produced zero rendered coverage — the control did not render and cannot satisfy or fire the lane",
  ]);
});

test("C3 a rendered zero-variance D5 disc satisfies the coverage precondition", () => {
  const result = model.evaluateD5SpatialDistribution(
    d5Input(spatialRecord(), renderedQuietDiscSpatialRecord()),
  );
  assert.equal(result.status, "FAIL");
  assert.deepEqual(result.structural, []);
  assert.equal(result.measurements.controlEdgeRate, 0);
  assert.equal(result.measurements.controlInteriorRate, 0);
  assert.ok(result.measurements.controlForegroundArea > 0);
  assert.match(result.failures[0], /D5:tower-variance-over-bar/u);
});

test("C4 a rendered one-pixel sliver retains the empty-interior diagnosis", () => {
  const result = model.evaluateD5SpatialDistribution(
    d5Input(spatialRecord(), sliverSpatialRecord()),
  );
  assert.equal(result.status, "STRUCTURAL");
  assert.ok(result.structural.includes("D5-control:empty-interior-region"));
  assert.equal(
    result.structural.includes("D5-control:subject-not-rendered"),
    false,
  );
});

test("pixel arithmetic examines every pair and derives a silhouette boundary", () => {
  const foreground = new Set([6, 7, 8, 11, 12, 13, 16, 17, 18]);
  const off = image(5, 5, new Set());
  const base = image(5, 5, foreground);
  const interior = image(5, 5, foreground, new Map([[12, 101]]));
  const edge = image(5, 5, foreground, new Map([[6, 101]]));

  assert.equal(model.changedPixelCount(base, interior), 1);
  assert.deepEqual(model.maxPairwiseChangedPixels([base, interior, edge]), {
    changedPixels: 2,
    pair: [1, 2],
  });

  const interiorMap = model.analyzeSpatialDistribution(base, interior, off);
  assert.equal(interiorMap.foregroundArea, 9);
  assert.equal(interiorMap.edgeArea, 8);
  assert.equal(interiorMap.interiorArea, 1);
  assert.equal(interiorMap.edgeChanged, 0);
  assert.equal(interiorMap.interiorChanged, 1);
  assert.equal(interiorMap.isolatedInteriorChanged, 1);
  assert.equal(interiorMap.interiorComponentCount, 1);
  assert.equal(interiorMap.largestInteriorComponent, 1);
  assert.equal(interiorMap.occupiedInteriorGridCells, 1);

  const edgeMap = model.analyzeSpatialDistribution(base, edge, off);
  assert.equal(edgeMap.edgeChanged, 1);
  assert.equal(edgeMap.interiorChanged, 0);
  assert.equal(edgeMap.interiorComponentCount, 0);
});

function d1OffFrameExclusionHolds(subject = partitionD1Captures) {
  const rendered = image(3, 3, new Set([4]));
  const off = image(3, 3, new Set());
  const captures = [
    ...new Array(5)
      .fill(undefined)
      .map((_value, index) => ({ name: `read-${index}`, frame: rendered })),
    { name: "off", frame: off },
  ];
  const partition = subject(captures);
  const readFrames = partition.readCaptures.map((capture) => capture.frame);
  return (
    partition.readCaptures.length === 5 &&
    partition.offCapture === captures[5] &&
    model.maxPairwiseChangedPixels(readFrames).changedPixels === 0 &&
    model.maxPairwiseChangedPixels([...readFrames, partition.offCapture.frame])
      .changedPixels > 0 &&
    model.changedPixelCount(readFrames[0], partition.offCapture.frame) > 0
  );
}

test("D1 scores only five reads and uses the later off frame only for coverage", () => {
  assert.equal(d1OffFrameExclusionHolds(), true);
});

test("probe source uses only canonical fused capture and write-once evidence", () => {
  assert.deepEqual(checkEmbeddedFusedSnapshotIsCanonical(PROBE_SOURCE), []);
  assert.deepEqual(checkFusedCaptureUsage(PROBE_SOURCE), []);
  assert.match(PROBE_SOURCE, /createImmutableEvidence/u);
  assert.match(PROBE_SOURCE, /snapshotEvidenceFiles/u);
  assert.match(PROBE_SOURCE, /compareEvidenceFileSnapshots/u);
  assert.match(PROBE_SOURCE, /randomUUID/u);
  assert.match(PROBE_SOURCE, /exitCodeForS5Status/u);
  assert.match(PROBE_SOURCE, /preRegistration: FRAME_VARIANCE_DESIGNS/u);

  const d1Start = PROBE_SOURCE.indexOf('if (configuration.mode === "D1")');
  const d1End = PROBE_SOURCE.indexOf(
    'if (configuration.mode === "D2")',
    d1Start + 1,
  );
  assert.ok(d1Start >= 0 && d1End > d1Start);
  const d1Source = PROBE_SOURCE.slice(d1Start, d1End);
  assert.equal(countOccurrences(d1Source, "captureSnapshot(),"), 5);
  assert.match(d1Source, /renderCount === 0/u);
  assert.match(
    d1Source,
    /afterRender\?\.frameNumber === beforeBatch\.frameNumber \+ 1/u,
  );
});

test("capture filenames accept mixed-case evidence cell names", () => {
  // eslint-disable-next-line no-new-func
  const safeCaptureName = new Function(
    `${extractFunction(PROBE_SOURCE, "safeCaptureName")}; return safeCaptureName;`,
  )();
  assert.equal(
    safeCaptureName("webgl-d3-towerAtTower-frame-0"),
    "webgl-d3-towerAtTower-frame-0",
  );
  assert.throws(() => safeCaptureName("../unsafe"), /unsafe capture name/u);
});

test("mustReplace is loud for absent and duplicate anchors", () => {
  assert.throws(
    () => mustReplace("alpha", "missing", "x", "absent proof"),
    /expected exactly one mutation anchor, found 0/u,
  );
  assert.throws(
    () => mustReplace("alpha alpha", "alpha", "x", "duplicate proof"),
    /expected exactly one mutation anchor, found 2/u,
  );
});

const SOURCE_MAP_BASE64 =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function encodeSourceMapVlq(value) {
  let encoded = "";
  let remaining = value < 0 ? (-value << 1) | 1 : value << 1;
  do {
    let digit = remaining & 31;
    remaining >>>= 5;
    if (remaining > 0) digit |= 32;
    encoded += SOURCE_MAP_BASE64[digit];
  } while (remaining > 0);
  return encoded;
}

function sourceMapFixture(overrides = {}) {
  const primitive = readNormalizedSource(ENGINE_PATH);
  const sources = [ENGINE_PATH, SORTER_PATH, TASK_PROCESSOR_PATH].map((file) =>
    path.relative(ROOT, file).replaceAll("\\", "/"),
  );
  const sourcesContent = [ENGINE_PATH, SORTER_PATH, TASK_PROCESSOR_PATH].map(
    (file) => fs.readFileSync(file, "utf8"),
  );
  const predicateOffset = primitive.indexOf("function shouldStartSteadySort");
  assert.ok(predicateOffset >= 0);
  const predicatePrefix = primitive.slice(0, predicateOffset);
  const originalLine = predicatePrefix.split("\n").length - 1;
  const originalColumn = predicatePrefix.split("\n").at(-1).length;
  const mapping = [0, 0, originalLine, originalColumn]
    .map(encodeSourceMapVlq)
    .join("");
  const sourceMap = {
    version: 3,
    sources,
    sourcesContent,
    names: [],
    mappings: mapping,
    ...overrides,
  };
  const buildEntry = Buffer.from(
    "function shouldStartSteadySort() {}\n//# sourceMappingURL=index.js.map\n",
  );
  return { sourceMap, buildEntry };
}

test("source-map admission executes exact content and mapped-predicate bindings", () => {
  const { sourceMap, buildEntry } = sourceMapFixture();
  const evaluate = (candidate = sourceMap, entry = buildEntry) =>
    sourceMapBindings(Buffer.from(JSON.stringify(candidate)), entry);
  assert.equal(evaluate().ok, true);

  const duplicate = structuredClone(sourceMap);
  duplicate.sources.push(duplicate.sources[0]);
  duplicate.sourcesContent.push(duplicate.sourcesContent[0]);
  assert.equal(evaluate(duplicate).ok, false);

  const mismatchedContent = structuredClone(sourceMap);
  mismatchedContent.sourcesContent[0] += "\n// drift";
  assert.equal(evaluate(mismatchedContent).ok, false);

  const wrongMappedSource = structuredClone(sourceMap);
  wrongMappedSource.mappings = [0, 1, 0, 0].map(encodeSourceMapVlq).join("");
  assert.equal(evaluate(wrongMappedSource).ok, false);
  assert.equal(evaluate({ ...sourceMap, version: 2 }).ok, false);
  assert.equal(evaluate({ ...sourceMap, mappings: "" }).ok, false);
  assert.equal(
    evaluate(
      sourceMap,
      Buffer.from(
        "function shouldStartSteadySort() {}\n//# sourceMappingURL=wrong.js.map\n",
      ),
    ).ok,
    false,
  );
});

test("sort worker and WASM provenance helpers execute positive and negative fixtures", () => {
  const worker = fs.readFileSync(SORT_WORKER_PATH);
  const workerSource = worker.toString("utf8").replace(/\r\n/g, "\n");
  assert.equal(sorterWorkerBinding(worker).ok, true);
  const printerShapedWorker = Buffer.from(
    mustReplace(
      workerSource,
      "primitive.count,",
      "primitive.count",
      "esbuild worker printer fixture",
    ),
  );
  assert.equal(sorterWorkerBinding(printerShapedWorker).ok, true);
  const driftedWorker = Buffer.from(
    mustReplace(
      workerSource,
      "primitive.count,",
      "primitive.count + 1,",
      "worker semantic drift",
    ),
  );
  assert.equal(sorterWorkerBinding(driftedWorker).ok, false);

  const wasm = fs.readFileSync(SORT_WASM_PATH);
  assert.equal(sorterWasmBinding(wasm).ok, true);
  const driftedWasm = Buffer.from(wasm);
  driftedWasm[0] ^= 1;
  assert.equal(sorterWasmBinding(driftedWasm).ok, false);
});

class FakeResponsePage {
  constructor() {
    this.listeners = new Map();
  }

  on(event, listener) {
    this.listeners.set(event, listener);
  }

  off(event, listener) {
    if (this.listeners.get(event) === listener) this.listeners.delete(event);
  }

  respond(url, bytes, status = 200) {
    this.listeners.get("response")?.({
      url: () => url,
      status: () => status,
      body: async () => Buffer.from(bytes),
    });
  }
}

async function consumedSourceFixture({ divergentDuplicate = false } = {}) {
  const base = "http://localhost:8080";
  const asset = {
    url: "/test/tower/tileset.json",
    payloadUrl: "/test/tower/tower.glb",
  };
  const required = [
    "/Build/CesiumUnminified/index.js",
    "/Build/CesiumUnminified/Workers/gaussianSplatSorter.js",
    "/Build/CesiumUnminified/ThirdParty/wasm_splats_bg.wasm",
    asset.url,
    asset.payloadUrl,
  ];
  const page = new FakeResponsePage();
  const expected = new Map(
    required.map((relative, index) => {
      const bytes = Buffer.from(`bytes-${index}`);
      return [
        relative,
        {
          ok: true,
          served: {
            byteLength: bytes.length,
            sha256: createHash("sha256").update(bytes).digest("hex"),
          },
          bytes,
        },
      ];
    }),
  );
  const attestation = beginConsumedSourceAttestation(
    page,
    { base },
    asset,
    expected,
  );
  for (const relative of required) {
    page.respond(`${base}${relative}`, expected.get(relative).bytes);
  }
  if (divergentDuplicate) {
    page.respond(`${base}${asset.url}`, Buffer.from("different response"));
  }
  return attestation.finish();
}

test("consumed-source attestation accepts all exact attempts and rejects one divergent duplicate", async () => {
  const exact = await consumedSourceFixture();
  assert.equal(exact.length, 5);
  assert.equal(
    exact.every((record) => record.identityMatches),
    true,
  );
  const divergent = await consumedSourceFixture({ divergentDuplicate: true });
  assert.equal(
    divergent.find((record) => record.relative.endsWith("tileset.json"))
      .identityMatches,
    false,
  );
});

test("D3 framing helpers execute tangent, donor-scale, and persisted-edge controls", () => {
  const loadPure = (name) =>
    // eslint-disable-next-line no-new-func
    new Function(`${extractFunction(PROBE_SOURCE, name)}; return ${name};`)();
  const registeredRangeForSphere = loadPure("registeredRangeForSphere");
  const tangentSpherePixelRadii = loadPure("tangentSpherePixelRadii");
  const radius = 10;
  const angularRadius = 0.3;
  const range = registeredRangeForSphere(radius, angularRadius);
  assert.ok(Math.abs(range - radius / Math.sin(angularRadius)) < 1e-12);
  const tangent = tangentSpherePixelRadii(
    radius,
    range,
    Math.PI / 6,
    Math.PI / 8,
    1024,
    768,
  );
  assert.ok(Math.abs(tangent.angularRadius - angularRadius) < 1e-12);
  assert.ok(
    Math.abs(
      tangent.y - (Math.tan(angularRadius) / Math.tan(Math.PI / 8)) * 384,
    ) < 1e-9,
  );

  const donor = {
    valid: true,
    projectedExtentOnCanvas: true,
    range: 30,
    sphereRadius: 10,
    radiusPx: 100,
    center: [512, 384],
  };
  assert.equal(registeredFramingMatches(donor, { ...donor }), true);
  assert.equal(registeredFramingMatches(donor, { ...donor, range: 31 }), false);
  assert.equal(
    donorAssetScale(
      { framing: { sphereRadius: 20 } },
      { framing: { sphereRadius: 5 } },
    ),
    4,
  );

  const blank = { width: 4, height: 4, data: new Uint8ClampedArray(4 * 4 * 4) };
  const centered = {
    ...blank,
    data: new Uint8ClampedArray(blank.data),
  };
  centered.data[(1 * 4 + 1) * 4] = 255;
  const centeredExtent = changedFootprintExtent(centered, blank);
  assert.equal(centeredExtent.contained, true);
  assert.equal(centeredExtent.borderCoveragePixels, 0);
  const edge = { ...blank, data: new Uint8ClampedArray(blank.data) };
  edge.data[0] = 255;
  const edgeExtent = changedFootprintExtent(edge, blank);
  assert.equal(edgeExtent.contained, false);
  assert.equal(edgeExtent.borderCoveragePixels, 1);
});

const CAPTURE_MUTANTS = [
  {
    id: "C1-canonical-block-drift",
    anchor: 'const dataUrl = canvas.toDataURL("image/png");',
    replacement: 'const dataUrl = canvas.toDataURL("image/jpeg");',
    check: (source) => checkEmbeddedFusedSnapshotIsCanonical(source),
    reason: /drifted/u,
  },
  {
    id: "C2-live-canvas-drawImage",
    anchor: "const captures = [];",
    replacement:
      'const captures = [];\n  document.createElement("canvas").getContext("2d").drawImage(canvas, 0, 0);',
    check: (source) => checkFusedCaptureUsage(source),
    reason: /drawImage|live scene canvas/iu,
  },
  {
    id: "C3-probe-local-toDataURL",
    anchor: "const captures = [];",
    replacement: 'const captures = [];\n  canvas.toDataURL("image/png");',
    check: (source) => checkFusedCaptureUsage(source),
    reason: /toDataURL|pixel read or encode/iu,
  },
  {
    id: "C4-unawaited-capture",
    anchor: "const snapshot = await captureSnapshot();",
    replacement: "const snapshot = captureSnapshot();",
    check: (source) => checkFusedCaptureUsage(source),
    reason: /await/u,
  },
];

test("four loud capture-source mutants are killed and the real probe survives", async (t) => {
  assert.equal(
    CAPTURE_MUTANTS.length,
    4,
    "adding a mutant is intended — bump this count",
  );
  for (const mutant of CAPTURE_MUTANTS) {
    await t.test(mutant.id, () => {
      assert.deepEqual(
        mutant.check(PROBE_SOURCE),
        [],
        "real capture source must survive",
      );
      const source = mustReplace(
        PROBE_SOURCE,
        mutant.anchor,
        mutant.replacement,
        mutant.id,
      );
      const failures = mutant.check(source);
      assert.ok(failures.length > 0, `${mutant.id} was not killed`);
      assert.match(failures.join("\n"), mutant.reason);
    });
  }
});

function checkProbeWiring(source) {
  const failures = [];
  const require = (condition, reason) => {
    if (!condition) failures.push(reason);
  };

  const d1Call = source.indexOf("const d1 = await executeD1(");
  const downstreamLoop = source.indexOf(
    "for (const lane of selectedDownstreamLanes(options.lane))",
  );
  require(d1Call >= 0 && downstreamLoop > d1Call, "D1-not-first");
  require(source.includes(
    'if (results.some((result) => result.status !== "PASS")) {',
  ), "D1-no-downstream-short-circuit");
  require(countOccurrences(source, "      captureSnapshot(),") ===
    5, "D1-not-five-direct-fused-reads");
  require(source.includes(
    "if (renderCount === 0) {",
  ), "D1-no-one-render-guard");
  require(source.includes(
    "const towerPartition = partitionD1Captures(towerRaw.captures);",
  ) &&
    source.includes(
      "const cubePartition = partitionD1Captures(cubeRaw.captures);",
    ) &&
    source.includes("towerPartition.readCaptures.map((capture) =>") &&
    source.includes("cubePartition.readCaptures.map((capture) =>") &&
    source.includes("tower.frames.get(towerPartition.offCapture.name)") &&
    source.includes(
      "cube.frames.get(cubePartition.offCapture.name)",
    ), "D1-off-frame-not-separated-from-scored-reads");

  require(source.includes(
    'const orders = ["AA", "BB", "AB", "BA"];',
  ), "D2-not-four-fresh-histories");
  require(source.includes(
    "equivalentInitialStates: equivalentD2InitialStates(resetSignatures),",
  ), "D2-reset-equivalence-not-wired");
  require(source.includes(
    "result.measurements.resetSignatures = resetSignatures;",
  ), "D2-full-reset-signatures-not-recorded");
  require(source.includes(
    'comparisonRecord(frame("AB", "first"), frame("BA", "second"))',
  ) &&
    source.includes(
      'comparisonRecord(frame("AB", "second"), frame("BA", "first"))',
    ), "D2-like-framings-not-compared-across-order");
  require(source.includes(
    'comparisonRecord(frame("AA", "first"), frame("AA", "second"))',
  ) &&
    source.includes(
      'comparisonRecord(frame("BB", "first"), frame("BB", "second"))',
    ), "D2-controls-not-isolated");

  require(source.includes(
    "fixedCameras: Object.values(rawCells).every(",
  ), "D3-fixed-camera-witness-dropped");
  require(source.includes("range: cubeAtCubeRaw.normalRange") &&
    source.includes("range: towerAtTowerRaw.normalRange") &&
    source.includes(
      "assetScale: donorAssetScale(cubeAtCubeRaw, towerAtTowerRaw)",
    ) &&
    source.includes(
      "assetScale: donorAssetScale(towerAtTowerRaw, cubeAtCubeRaw)",
    ), "D3-donor-framing-not-normalized");
  require(source.includes(
    "function registeredFramingMatches(donor, crossed)",
  ) &&
    source.includes(
      "rawCellWitnesses?.registeredFramingMatch === true",
    ), "D3-donor-framing-match-not-proven");
  require(source.includes(
    "const footprintPixels = Math.max(",
  ), "D3-persisted-footprint-not-wired");
  require(source.includes("captureRange - sphere.radius > near") &&
    source.includes("centerOnCanvas") &&
    source.includes(
      "const unclipped = depthUnclipped && projectedExtentOnCanvas;",
    ) &&
    source.includes("const normalRange = registeredRangeForSphere(") &&
    source.includes("function tangentSpherePixelRadii(") &&
    source.includes("Math.asin(radius / range)") &&
    source.includes("configuration.framingCushionPixels") &&
    source.includes(
      "projectedExtent.left >= configuration.framingMarginPixels",
    ) &&
    source.includes("canvas.width - configuration.framingMarginPixels") &&
    source.includes(
      "projectedExtent.top >= configuration.framingMarginPixels",
    ) &&
    source.includes("canvas.height - configuration.framingMarginPixels") &&
    source.includes("radiusPx >= 1"), "D3-framing-validity-not-proven");
  require(source.includes("minX > 0") &&
    source.includes("maxX < left.width - 1") &&
    source.includes("minY > 0") &&
    source.includes("maxY < left.height - 1") &&
    source.includes("subjectCoverageContained = extents.every(") &&
    source.includes("    subjectCoverageContained,") &&
    source.includes("    borderCoveragePixels,") &&
    source.includes(
      "subjectCoverageContained: cells[cell].subjectCoverageContained",
    ) &&
    source.includes(
      "borderCoveragePixels: cells[cell].borderCoveragePixels",
    ), "D3-persisted-extent-containment-not-recorded");

  require(source.includes(
    "const initialQuiescence = await waitForSortQuiescence();",
  ) &&
    source.includes(
      "const cleanStart = !sortInFlight(primitive);",
    ), "D4-clean-start-not-proven");
  require(source.includes(
    "const { framesSinceLastSteadySort: _advancingCounter, ...stable } = witness;",
  ) &&
    countOccurrences(
      source,
      "JSON.stringify(quiescentSortWitness(primitive))",
    ) === 3, "quiescence-signature-includes-advancing-frame-counter");
  require(source.includes(
    "for (let index = 0; index < 3; index++)",
  ), "D4-not-three-output-snapshots");
  require(checkEmbeddedD4SchedulerHistoryResetIsCanonical(source).length ===
    0 &&
    source.includes("resetD4SchedulerHistory(C, primitive);") &&
    source.includes(
      "C.Matrix4.clone(C.Matrix4.ZERO, primitive._prevViewMatrix);",
    ), "D4-scheduler-history-reset-not-canonical");
  const d4RequestLoopSource = source.slice(
    source.indexOf("for (let index = 0; index < 3; index++)"),
    source.indexOf("const pinnedInputSignature = await materializeSortInput("),
  );
  // The settled-scene early return rewrites the memo on every scheduling
  // render, so a reset hoisted out of the loop only binds the first request.
  require(countOccurrences(source, "resetD4SchedulerHistory(C, primitive);") ===
    1 &&
    countOccurrences(
      d4RequestLoopSource,
      "\n      resetD4SchedulerHistory(C, primitive);\n      renderNow();\n",
    ) === 1, "D4-scheduler-history-reset-not-per-request");
  require(source.includes(
    "positionsSha256: await digestHex(rawInput.positions)",
  ) &&
    source.includes(
      "modelViewSha256: await digestHex(rawInput.modelView)",
    ), "D4-exact-input-hash-dropped");
  require(source.includes(
    "const requestInputSignature = await materializeSortInput(",
  ) &&
    source.includes("active?.requestId === requestSequence") &&
    source.includes("requestInputSignature,") &&
    source.includes(
      "publicationComplete,",
    ), "D4-request-time-publication-provenance-dropped");
  require(source.includes("permutationSha256: await digestHex(raw.indexes)") &&
    source.includes("sourceObjectId: raw.sourceObjectId") &&
    source.includes(
      "residentBufferObjectId: raw.residentBufferObjectId",
    ), "D4-output-identity-incomplete");

  require(source.includes("towerRaw.metadata.fixedJulian === true &&") &&
    source.includes(
      "towerRaw.metadata.fixedCamera === true &&",
    ), "D5-fixed-witnesses-dropped");
  const d5Source = extractFunction(source, "executeD5");
  require(countOccurrences(d5Source, "analyzeSpatialDistribution(") === 2 &&
    countOccurrences(d5Source, '.frames.get("off")') ===
      2, "D5-on-on-off-maps-not-wired");
  require(source.includes("primitive?._webgpuCache?.pipeline != null &&") &&
    source.includes("primitive?._webgpuCache?.pickPipeline != null") &&
    source.includes(
      'structural.push("webgpu-splat-pipeline-not-ready");',
    ), "webgpu-splat-pipeline-readiness-not-wired");

  for (const boundaryEntry of [
    "buildIdentity: BUILD_IDENTITY_SOURCE_PATH",
    "cloudImageAnalysis: CLOUD_ANALYSIS_SOURCE_PATH",
    "verdictExitGate: VERDICT_EXIT_SOURCE_PATH",
    "webgpuErrorGate: WEBGPU_ERROR_GATE_SOURCE_PATH",
    "engineSorter: ENGINE_SORTER_SOURCE_PATH",
    "engineTaskProcessor: ENGINE_TASK_PROCESSOR_SOURCE_PATH",
    "engineSortWorker: ENGINE_SORT_WORKER_SOURCE_PATH",
    "engineSortWasm: ENGINE_SORT_WASM_SOURCE_PATH",
    'key: "buildSourceMap"',
    'key: "sortWorker"',
    'key: "sortWasm"',
    'key: "towerPayload"',
    'key: "cubePayload"',
  ]) {
    require(source.includes(
      boundaryEntry,
    ), `evidence-boundary-missing:${boundaryEntry}`);
  }
  require(source.includes(
    "ok: response.ok && identityMatches && provenance.ok",
  ) &&
    source.includes(
      "local.sha256 === served.sha256",
    ), "served-source-not-bound-to-local-bytes");
  require(source.includes("sourceMap.sourcesContent") &&
    source.includes("expected.sha256 === embedded.sha256") &&
    source.includes("sourceMap.version !== 3") &&
    source.includes("mappedPredicate.identityMatches") &&
    source.includes(
      "sourceMapUrlBound &&\n        records.every((record) => record.identityMatches)",
    ) &&
    source.includes(
      '{ key: "taskProcessor", localPath: ENGINE_TASK_PROCESSOR_SOURCE_PATH }',
    ) &&
    source.includes(
      'return sourceMapBindings(servedBytes, servedBytesByKey.get("buildEntry"));',
    ), "build-entry-not-bound-to-engine-source-map");
  require(source.includes(
    'if (source.key === "sortWorker") return sorterWorkerBinding(servedBytes);',
  ) &&
    source.includes(
      'if (source.key === "sortWasm") return sorterWasmBinding(servedBytes);',
    ) &&
    source.includes("source.sha256 === build.sha256") &&
    source.includes(
      "semanticIdentityMatches &&\n      records.every((record) => record.sourceMatches && record.buildMatches)",
    ), "sort-worker-or-wasm-provenance-not-bound");
  const consumedAttestationSource = extractFunction(
    source,
    "beginConsumedSourceAttestation",
  );
  require(consumedAttestationSource.includes("response.body().then(") &&
    consumedAttestationSource.includes(
      "observed.sha256 === expected.served.sha256",
    ) &&
    consumedAttestationSource.includes(
      '"/Build/CesiumUnminified/Workers/gaussianSplatSorter.js"',
    ) &&
    consumedAttestationSource.includes(
      '"/Build/CesiumUnminified/ThirdParty/wasm_splats_bg.wasm"',
    ) &&
    source.includes(
      "state.consumedSources.push({ label, sources: consumedSources })",
    ), "browser-consumed-source-bytes-not-attested");
  require(!source.includes("await fetch(configuration.asset.url") &&
    consumedAttestationSource.includes("pending.get(parsed.pathname).push(") &&
    consumedAttestationSource.includes(
      "attempts.every(",
    ), "tileset-attestation-can-bind-a-nonconsumed-response");
  require(source.includes(
    "signal: controller.signal",
  ), "preflight-timeout-does-not-abort-fetch");
  require(source.includes("const operationSettled = operationPromise.then(") &&
    source.includes("operationDrain: drain") &&
    countOccurrences(
      source,
      'if (!state.accepting) throw new Error("watchdog stopped evidence writes");',
    ) === 2, "watchdog-does-not-drain-before-terminal-evidence");
  require(source.includes(
    "if (primaryError.retainRunningAuthority === true) {",
  ) &&
    source.includes("if (!retainProcessFuse) clearTimeout(processFuse);") &&
    source.includes(
      [
        "throw new Error(",
        '      "refusing to release RUNNING authority with unproven cleanup",',
        "    );",
      ].join("\n"),
    ), "unproven-cleanup-releases-running-authority");
  require(countOccurrences(
    source,
    "return sealTerminalEvidence(evidence, archive, artifact);",
  ) === 3 &&
    source.includes(
      "releasedRunningAuthority",
    ), "terminal-receipt-does-not-release-running-authority");
  require(source.includes("const results = state.results;") &&
    source.includes("results: state.results,") &&
    source.includes("receipts: evidence.receipts,") &&
    source.includes(
      "failures: partialVerdict.failures,",
    ), "partial-red-or-receipt-ledger-not-preserved");
  require(source.includes(
    [
      "const sourceEnd = snapshotEvidenceFiles(sourceBoundary());",
      "    const sourceStability = compareEvidenceFileSnapshots(",
      "      sourceStart,",
      "      sourceEnd,",
      "    );",
    ].join("\n"),
  ), "server-structural-path-skips-source-stability");
  return failures;
}

function loadProbeFunction(source, name) {
  // eslint-disable-next-line no-new-func
  return new Function(`${extractFunction(source, name)}; return ${name};`)();
}

const PROBE_WIRING_MUTANTS = [
  {
    id: "P-D1-run-downstream-after-decider-red",
    anchor: 'if (results.some((result) => result.status !== "PASS")) {',
    replacement: "if (false) {",
    reason: "D1-no-downstream-short-circuit",
  },
  {
    id: "M-D1-b-score-off-frame-as-read",
    anchor: "return { readCaptures, offCapture: offCaptures[0] };",
    replacement: "return { readCaptures: list, offCapture: offCaptures[0] };",
    reason: "D1-off-frame-not-separated-from-scored-reads",
    rule: (source) =>
      d1OffFrameExclusionHolds(
        loadProbeFunction(source, "partitionD1Captures"),
      ),
  },
  {
    id: "P-D2-drop-reverse-order-history",
    anchor: 'const orders = ["AA", "BB", "AB", "BA"];',
    replacement: 'const orders = ["AA", "BB", "AB"];',
    reason: "D2-not-four-fresh-histories",
  },
  {
    id: "P-D2-drop-full-reset-evidence",
    anchor: "result.measurements.resetSignatures = resetSignatures;",
    replacement: "result.measurements.resetSignaturesOmitted = true;",
    reason: "D2-full-reset-signatures-not-recorded",
  },
  {
    id: "P-D2-assume-equivalent-resets",
    anchor:
      "equivalentInitialStates: equivalentD2InitialStates(resetSignatures),",
    replacement:
      "equivalentInitialStates: true || equivalentD2InitialStates(resetSignatures),",
    reason: "D2-reset-equivalence-not-wired",
  },
  {
    id: "P-D3-assume-fixed-cross-cameras",
    anchor: "fixedCameras: Object.values(rawCells).every(",
    replacement: "fixedCameras: true || Object.values(rawCells).every(",
    reason: "D3-fixed-camera-witness-dropped",
  },
  {
    id: "P-D3-invent-subject-footprint",
    anchor: "const footprintPixels = Math.max(",
    replacement: "const footprintPixels = 1 || Math.max(",
    reason: "D3-persisted-footprint-not-wired",
  },
  {
    id: "P-D3-copy-invalid-absolute-range",
    anchor: "assetScale: donorAssetScale(towerAtTowerRaw, cubeAtCubeRaw),",
    replacement: "assetScale: 1,",
    reason: "D3-donor-framing-not-normalized",
  },
  {
    id: "P-D3-assume-donor-framing-match",
    anchor: "rawCellWitnesses?.registeredFramingMatch === true,",
    replacement: "true,",
    reason: "D3-donor-framing-match-not-proven",
  },
  {
    id: "P-D3-ignore-projected-canvas-extent",
    anchor: "const unclipped = depthUnclipped && projectedExtentOnCanvas;",
    replacement: "const unclipped = depthUnclipped;",
    reason: "D3-framing-validity-not-proven",
  },
  {
    id: "P-D3-use-clipped-two-radius-framing",
    anchor: [
      "const normalRange = registeredRangeForSphere(",
      "    sphere.radius,",
      "    registeredAngularRadius,",
      "  );",
    ].join("\n"),
    replacement: "const normalRange = sphere.radius * 2;",
    reason: "D3-framing-validity-not-proven",
  },
  {
    id: "P-D3-use-same-depth-radius-instead-of-tangent",
    anchor: "range > radius ? Math.asin(radius / range) : Number.NaN;",
    replacement: "range > radius ? Math.atan(radius / range) : Number.NaN;",
    reason: "D3-framing-validity-not-proven",
  },
  {
    id: "P-D3-ignore-persisted-border-containment",
    anchor: "    subjectCoverageContained,",
    replacement: "    subjectCoverageContained: true,",
    reason: "D3-persisted-extent-containment-not-recorded",
  },
  {
    id: "M-D3-a-reconflate-framing-with-coverage-containment",
    anchor: [
      "      rawCellWitnesses?.registeredFramingMatch === true,",
      "    footprintPixels,",
    ].join("\n"),
    replacement: [
      "      rawCellWitnesses?.registeredFramingMatch === true &&",
      "      extents.every((extent) => extent?.contained === true),",
      "    footprintPixels,",
    ].join("\n"),
    reason: "D3-framing-coverage-separation-not-preserved",
    rule: (source) => d3A1Holds(loadProbeFunction(source, "d3CellRecord")),
  },
  {
    id: "M-D3-c-inert-coverage-caveat-computation",
    anchor: "  if (footprintPixels > 0) {",
    replacement: "  if (false && footprintPixels > 0) {",
    reason: "D3-coverage-caveat-computation-inert",
    rule: (source) => d3A1Holds(loadProbeFunction(source, "d3CellRecord")),
  },
  {
    id: "P-Q1-quiesce-on-advancing-frame-counter",
    anchor: "let signature = JSON.stringify(quiescentSortWitness(primitive));",
    replacement: "let signature = JSON.stringify(sortWitness(primitive));",
    reason: "quiescence-signature-includes-advancing-frame-counter",
  },
  {
    id: "P-D4-assume-clean-start",
    anchor: "const cleanStart = !sortInFlight(primitive);",
    replacement: "const cleanStart = true;",
    reason: "D4-clean-start-not-proven",
  },
  {
    id: "P-D4-drop-request-publication-binding",
    anchor: "active?.requestId === requestSequence &&",
    replacement: "true &&",
    reason: "D4-request-time-publication-provenance-dropped",
  },
  {
    id: "P-D4-drop-model-view-input-hash",
    anchor: "modelViewSha256: await digestHex(rawInput.modelView),",
    replacement: 'modelViewSha256: "unchecked",',
    reason: "D4-exact-input-hash-dropped",
  },
  {
    id: "M-D4-a-drop-previous-view-matrix-reset",
    anchor: [
      "function resetD4SchedulerHistory(C, primitive) {",
      "  primitive._lastSteadySortFrameNumber = -1;",
      "  primitive._hasLastSteadySortCameraPosition = false;",
      "  primitive._hasLastSteadySortCameraDirection = false;",
      "  C.Matrix4.clone(C.Matrix4.ZERO, primitive._prevViewMatrix);",
      "}",
      "",
      "function extractEmbeddedD4SchedulerHistoryReset(probeSource) {",
    ].join("\n"),
    replacement: [
      "function resetD4SchedulerHistory(C, primitive) {",
      "  primitive._lastSteadySortFrameNumber = -1;",
      "  primitive._hasLastSteadySortCameraPosition = false;",
      "  primitive._hasLastSteadySortCameraDirection = false;",
      "}",
      "",
      "function extractEmbeddedD4SchedulerHistoryReset(probeSource) {",
    ].join("\n"),
    reason: "D4-scheduler-history-reset-not-canonical",
    rule: (source) =>
      d4ResetHolds(loadProbeFunction(source, "resetD4SchedulerHistory")),
  },
  {
    id: "M-D4-b-inert-scheduler-history-reset",
    anchor: [
      "function resetD4SchedulerHistory(C, primitive) {",
      "  primitive._lastSteadySortFrameNumber = -1;",
      "  primitive._hasLastSteadySortCameraPosition = false;",
      "  primitive._hasLastSteadySortCameraDirection = false;",
      "  C.Matrix4.clone(C.Matrix4.ZERO, primitive._prevViewMatrix);",
      "}",
      "",
      "function extractEmbeddedD4SchedulerHistoryReset(probeSource) {",
    ].join("\n"),
    replacement: [
      "function resetD4SchedulerHistory(C, primitive) {",
      "  if (false && index >= 0) {",
      "    primitive._lastSteadySortFrameNumber = -1;",
      "    primitive._hasLastSteadySortCameraPosition = false;",
      "    primitive._hasLastSteadySortCameraDirection = false;",
      "    C.Matrix4.clone(C.Matrix4.ZERO, primitive._prevViewMatrix);",
      "  }",
      "}",
      "",
      "function extractEmbeddedD4SchedulerHistoryReset(probeSource) {",
    ].join("\n"),
    reason: "D4-scheduler-history-reset-not-canonical",
    rule: (source) =>
      d4ResetHolds(loadProbeFunction(source, "resetD4SchedulerHistory")),
  },
  {
    id: "M-D4-c-hoist-scheduler-history-reset-out-of-the-request-loop",
    anchor: [
      "      resetD4SchedulerHistory(C, primitive);",
      "      renderNow();",
    ].join("\n"),
    replacement: [
      "      if (index === 0) {",
      "        resetD4SchedulerHistory(C, primitive);",
      "      }",
      "      renderNow();",
    ].join("\n"),
    reason: "D4-scheduler-history-reset-not-per-request",
  },
  {
    id: "P-D5-assume-fixed-time",
    anchor: "towerRaw.metadata.fixedJulian === true &&",
    replacement: "true ||",
    reason: "D5-fixed-witnesses-dropped",
  },
  {
    id: "P-WGPU-drop-splat-pipeline-readiness",
    anchor: [
      "primitive?._webgpuCache?.pipeline != null &&",
      "        primitive?._webgpuCache?.pickPipeline != null",
    ].join("\n"),
    replacement: "true",
    reason: "webgpu-splat-pipeline-readiness-not-wired",
  },
  {
    id: "P-E1-drop-decoder-from-source-boundary",
    anchor: "cloudImageAnalysis: CLOUD_ANALYSIS_SOURCE_PATH,",
    replacement: "// mutant dropped cloud image analysis",
    reason:
      "evidence-boundary-missing:cloudImageAnalysis: CLOUD_ANALYSIS_SOURCE_PATH",
  },
  {
    id: "P-E2-trust-unbound-served-build",
    anchor: "ok: response.ok && identityMatches && provenance.ok,",
    replacement: "ok: response.ok && provenance.ok,",
    reason: "served-source-not-bound-to-local-bytes",
  },
  {
    id: "P-E2b-drop-build-source-map-binding",
    anchor: [
      'if (source.key === "buildSourceMap") {',
      '    return sourceMapBindings(servedBytes, servedBytesByKey.get("buildEntry"));',
      "  }",
    ].join("\n"),
    replacement: [
      'if (source.key === "buildSourceMap") {',
      "    return { ok: true };",
      "  }",
    ].join("\n"),
    reason: "build-entry-not-bound-to-engine-source-map",
  },
  {
    id: "P-E2bb-ignore-mapped-predicate-location",
    anchor:
      "records.every((record) => record.identityMatches) &&\n        mappedPredicate.identityMatches,",
    replacement: "records.every((record) => record.identityMatches),",
    reason: "build-entry-not-bound-to-engine-source-map",
  },
  {
    id: "P-E2bc-ignore-source-map-url-binding",
    anchor: "sourceMapUrlBound &&",
    replacement: "true &&",
    reason: "build-entry-not-bound-to-engine-source-map",
  },
  {
    id: "P-E2c-drop-sort-wasm-source-binding",
    anchor:
      'if (source.key === "sortWasm") return sorterWasmBinding(servedBytes);',
    replacement: 'if (source.key === "sortWasm") return { ok: true };',
    reason: "sort-worker-or-wasm-provenance-not-bound",
  },
  {
    id: "P-E2d-drop-sort-worker-semantic-binding",
    anchor:
      'if (source.key === "sortWorker") return sorterWorkerBinding(servedBytes);',
    replacement: 'if (source.key === "sortWorker") return { ok: true };',
    reason: "sort-worker-or-wasm-provenance-not-bound",
  },
  {
    id: "P-E2db-ignore-worker-function-identity",
    anchor: "semanticIdentityMatches &&",
    replacement: "true &&",
    reason: "sort-worker-or-wasm-provenance-not-bound",
  },
  {
    id: "P-E2e-drop-task-processor-source-map-binding",
    anchor:
      '    { key: "taskProcessor", localPath: ENGINE_TASK_PROCESSOR_SOURCE_PATH },',
    replacement: "    // mutant dropped task-processor source binding",
    reason: "build-entry-not-bound-to-engine-source-map",
  },
  {
    id: "P-E3-leave-timed-out-fetch-running",
    anchor: "signal: controller.signal,",
    replacement: "// mutant omitted fetch abort signal",
    reason: "preflight-timeout-does-not-abort-fetch",
  },
  {
    id: "P-E4-drop-terminal-release-receipt",
    anchor: [
      'const archive = path.join(evidence.directory, "error.json");',
      "    return sealTerminalEvidence(evidence, archive, artifact);",
    ].join("\n"),
    replacement: [
      'const archive = path.join(evidence.directory, "error.json");',
      "    return { artifact, archive };",
    ].join("\n"),
    reason: "terminal-receipt-does-not-release-running-authority",
  },
  {
    id: "P-E5-erase-partial-red-on-error",
    anchor: "results: state.results,",
    replacement: "results: execution?.results ?? [],",
    reason: "partial-red-or-receipt-ledger-not-preserved",
  },
  {
    id: "P-E6-skip-source-check-on-server-structural",
    anchor: [
      "const sourceEnd = snapshotEvidenceFiles(sourceBoundary());",
      "    const sourceStability = compareEvidenceFileSnapshots(",
      "      sourceStart,",
      "      sourceEnd,",
      "    );",
    ].join("\n"),
    replacement: [
      "const sourceEnd = snapshotEvidenceFiles(sourceBoundary());",
      "    const sourceStability = { ok: true, reasons: [] };",
    ].join("\n"),
    reason: "server-structural-path-skips-source-stability",
  },
  {
    id: "P-E7-drop-tower-payload-from-source-boundary",
    anchor: 'key: "towerPayload",',
    replacement: 'key: "towerPayloadDropped",',
    reason: 'evidence-boundary-missing:key: "towerPayload"',
  },
  {
    id: "P-E8-trust-preflight-instead-of-consumed-response",
    anchor: "observed.sha256 === expected.served.sha256,",
    replacement: "expected.served.sha256 === expected.served.sha256,",
    reason: "browser-consumed-source-bytes-not-attested",
  },
  {
    id: "P-E8b-drop-consumed-sort-worker",
    anchor: [
      '    "/Build/CesiumUnminified/index.js",',
      '    "/Build/CesiumUnminified/Workers/gaussianSplatSorter.js",',
    ].join("\n"),
    replacement: '    "/Build/CesiumUnminified/index.js",',
    reason: "browser-consumed-source-bytes-not-attested",
  },
  {
    id: "P-E8c-record-only-first-matching-response",
    anchor: "attempts.every(",
    replacement: "attempts.slice(0, 1).every(",
    reason: "tileset-attestation-can-bind-a-nonconsumed-response",
  },
  {
    id: "P-E8d-reintroduce-status-only-asset-fetch",
    anchor:
      "tileset = await C.Cesium3DTileset.fromUrl(configuration.asset.url, {",
    replacement: [
      'await fetch(configuration.asset.url, { cache: "no-store" });',
      "    tileset = await C.Cesium3DTileset.fromUrl(configuration.asset.url, {",
    ].join("\n"),
    reason: "tileset-attestation-can-bind-a-nonconsumed-response",
  },
  {
    id: "P-E9-do-not-drain-timed-out-operation",
    anchor: "const operationSettled = operationPromise.then(",
    replacement:
      "const operationSettled = Promise.resolve({ settled: true }); void operationPromise.then(",
    reason: "watchdog-does-not-drain-before-terminal-evidence",
  },
  {
    id: "P-E10-write-after-watchdog-stop",
    anchor: [
      "const decoded = await decodeCloudPng(bytes);",
      '    if (!state.accepting) throw new Error("watchdog stopped evidence writes");',
    ].join("\n"),
    replacement: [
      "const decoded = await decodeCloudPng(bytes);",
      "    // mutant permits a late write",
    ].join("\n"),
    reason: "watchdog-does-not-drain-before-terminal-evidence",
  },
  {
    id: "P-E11-release-running-after-unproven-cleanup",
    anchor: "if (primaryError.retainRunningAuthority === true) {",
    replacement: "if (false) {",
    reason: "unproven-cleanup-releases-running-authority",
  },
];

test("probe lane wiring and immutable evidence kill loud source mutants", async (t) => {
  assert.equal(
    PROBE_WIRING_MUTANTS.length,
    45,
    "adding a mutant is intended — bump this count",
  );
  assert.deepEqual(checkProbeWiring(PROBE_SOURCE), []);
  for (const mutant of PROBE_WIRING_MUTANTS) {
    await t.test(mutant.id, () => {
      const source = mustReplace(
        PROBE_SOURCE,
        mutant.anchor,
        mutant.replacement,
        mutant.id,
      );
      if (mutant.rule) {
        assert.equal(
          mutant.rule(PROBE_SOURCE),
          true,
          `${mutant.id}: real probe behavior rejected`,
        );
        assert.equal(
          mutant.rule(source),
          false,
          `${mutant.id}: behavioral mutant survived`,
        );
        return;
      }
      const failures = checkProbeWiring(source);
      assert.ok(
        failures.includes(mutant.reason),
        `${mutant.id} was not killed`,
      );
    });
  }
});

const MODEL_MUTANTS = [
  {
    lane: "D1",
    id: "D1-M1-widen-threshold",
    anchor: "export const FRAME_VARIANCE_THRESHOLD_FRACTION = 0.0005;",
    replacement: "export const FRAME_VARIANCE_THRESHOLD_FRACTION = 0.001;",
    pins: "a 0.060% reading must fire",
    rule: (subject) => subject.frameVarianceFires(0.0006) === true,
  },
  {
    lane: "D1",
    id: "D1-M2-allow-two-renders",
    anchor: "if (record?.renderCount !== 1) {",
    replacement: "if (record?.renderCount !== 2) {",
    pins: "both subjects require exactly one render",
    rule: (subject) => {
      const input = d1Input();
      input.tower.renderCount = 2;
      input.control.renderCount = 2;
      return subject.evaluateD1FrozenFrame(input).status === "STRUCTURAL";
    },
  },
  {
    lane: "D1",
    id: "D1-M3-allow-extra-read",
    anchor: "if (record?.readCount !== D1_FROZEN_FRAME_READS) {",
    replacement: "if (record?.readCount < D1_FROZEN_FRAME_READS) {",
    pins: "the pre-registered read count is exact",
    rule: (subject) => {
      const input = d1Input();
      input.tower.readCount = 6;
      input.control.readCount = 6;
      return subject.evaluateD1FrozenFrame(input).status === "STRUCTURAL";
    },
  },
  {
    lane: "D1",
    id: "D1-M4-allow-missing-freeze-witness",
    anchor: "if (record?.[field] !== true) reasons.push(`${label}:${reason}`);",
    replacement:
      "if (record?.[field] === false) reasons.push(`${label}:${reason}`);",
    pins: "missing frozen-state witnesses cannot pass",
    rule: (subject) => {
      const input = d1Input();
      delete input.tower.fixedSortInput;
      delete input.control.fixedSortInput;
      return subject.evaluateD1FrozenFrame(input).status === "STRUCTURAL";
    },
  },
  {
    lane: "D1",
    id: "M-D1-a-delete-subject-coverage-precondition",
    anchor: [
      "  if (!(record?.subjectCoveragePixels > 0)) {",
      "    reasons.push(`${label}:subject-not-rendered`);",
      "  }",
    ].join("\n"),
    replacement: "  // mutant deleted the subject-coverage precondition",
    pins: "a zero-coverage control is void, never a satisfied control",
    rule: (subject) => {
      const input = d1Input(0, 0);
      input.control.subjectCoveragePixels = 0;
      const result = subject.evaluateD1FrozenFrame(input);
      return (
        result.status === "STRUCTURAL" &&
        result.structural.length === 1 &&
        result.structural[0] === "control:subject-not-rendered"
      );
    },
  },
  {
    lane: "D2",
    id: "D2-M1-allow-unfixed-camera",
    anchor:
      'if (input?.fixedCameras !== true) reasons.push("D2:cameras-not-fixed");',
    replacement:
      'if (input?.fixedCameras === false) reasons.push("D2:cameras-not-fixed");',
    pins: "a missing fixed-camera witness is structural",
    rule: (subject) => {
      const input = d2Input();
      delete input.fixedCameras;
      return subject.evaluateD2Ordering(input).status === "STRUCTURAL";
    },
  },
  {
    lane: "D2",
    id: "D2-M2-allow-one-order-comparison",
    anchor: [
      "input?.oppositeOrderSameState,",
      "    2,",
      '    "D2-order",',
    ].join("\n"),
    replacement: [
      "input?.oppositeOrderSameState,",
      "    1,",
      '    "D2-order",',
    ].join("\n"),
    pins: "both A and B same-framing order comparisons are required",
    rule: (subject) => {
      const input = d2Input();
      input.oppositeOrderSameState = [record(0)];
      return subject.evaluateD2Ordering(input).status === "STRUCTURAL";
    },
  },
  {
    lane: "D2",
    id: "D2-M3-ignore-order-signal",
    anchor: "const signalFired = comparisons.some(frameVarianceFires);",
    replacement: "const signalFired = false;",
    pins: "an over-bar same-framing order comparison implicates carry-over",
    rule: (subject) =>
      subject.evaluateD2Ordering(d2Input(OVER_BAR_PIXELS)).classification ===
      "STATE_CARRY_OVER",
  },
  {
    lane: "D2",
    id: "D2-M4-ignore-control",
    anchor: "const controlFired = controls.some(frameVarianceFires);",
    replacement: "const controlFired = false;",
    pins: "an over-bar AA/BB control cannot pass",
    rule: (subject) =>
      subject.evaluateD2Ordering(d2Input(0, OVER_BAR_PIXELS)).classification ===
      "CONTROL_FIRED",
  },
  {
    lane: "D2",
    id: "D2-M5-allow-missing-reset-proof",
    anchor: "if (input?.equivalentInitialStates !== true) {",
    replacement: "if (input?.equivalentInitialStates === false) {",
    pins: "all four order histories need an explicit equivalent reset witness",
    rule: (subject) => {
      const input = d2Input();
      delete input.equivalentInitialStates;
      return subject.evaluateD2Ordering(input).status === "STRUCTURAL";
    },
  },
  {
    lane: "D2",
    id: "D2-M6-treat-sequence-as-scene-state",
    anchor: ['  "dataGeneration",', "]);"].join("\n"),
    replacement: ['  "dataGeneration",', '  "sequence",', "]);"].join("\n"),
    pins: "fresh-page scheduling sequence is evidence, not scene state",
    rule: (subject) =>
      subject.equivalentD2InitialStates(
        d2ResetSignatures(
          { sequence: 6 },
          { sequence: 7 },
          { sequence: 6 },
          { sequence: 7 },
        ),
      ) === true,
  },
  {
    lane: "D2",
    id: "D2-M7-inert-state-mismatch",
    anchor: "if (stateMismatch) return false;",
    replacement: "if (false && stateMismatch) return false;",
    pins: "a positions hash mismatch must keep the reset proof structural",
    rule: (subject) =>
      subject.equivalentD2InitialStates(
        d2ResetSignatures({}, {}, { positionsSha256: "d".repeat(64) }, {}),
      ) === false,
  },
  {
    lane: "D3",
    id: "D3-M1-drop-cube-baseline-cell",
    anchor: '  "cubeAtCube",',
    replacement: "  // mutant dropped cubeAtCube",
    pins: "the complete two-by-two cross is mandatory",
    rule: (subject) => {
      const input = d3Input({ towerAtTower: true, towerAtCube: true });
      delete input.cells.cubeAtCube;
      return subject.evaluateD3AssetFramingCross(input).status === "STRUCTURAL";
    },
  },
  {
    lane: "D3",
    id: "D3-M2-ignore-cube-baseline-control",
    anchor: "const controlFired = fired.cubeAtCube;",
    replacement: "const controlFired = false;",
    pins: "cube at cube framing is a non-firing control",
    rule: (subject) =>
      subject.evaluateD3AssetFramingCross(
        d3Input({ towerAtTower: true, towerAtCube: true, cubeAtCube: true }),
      ).classification === "CONTROL_FIRED",
  },
  {
    lane: "D3",
    id: "D3-M3-invert-asset-branch",
    anchor: [
      "const assetContent =",
      "    fired.towerAtTower &&",
      "    fired.towerAtCube &&",
    ].join("\n"),
    replacement: [
      "const assetContent =",
      "    fired.towerAtTower &&",
      "    !fired.towerAtCube &&",
    ].join("\n"),
    pins: "asset content follows tower through both framings",
    rule: (subject) =>
      subject.evaluateD3AssetFramingCross(
        d3Input({ towerAtTower: true, towerAtCube: true }),
      ).classification === "ASSET_CONTENT",
  },
  {
    lane: "D3",
    id: "D3-M4-invert-framing-branch",
    anchor: [
      "const framing =",
      "    fired.towerAtTower &&",
      "    fired.cubeAtTower &&",
    ].join("\n"),
    replacement: [
      "const framing =",
      "    fired.towerAtTower &&",
      "    !fired.cubeAtTower &&",
    ].join("\n"),
    pins: "framing follows tower framing across both assets",
    rule: (subject) =>
      subject.evaluateD3AssetFramingCross(
        d3Input({ towerAtTower: true, cubeAtTower: true }),
      ).classification === "FRAMING",
  },
  {
    lane: "D4",
    id: "D4-M1-allow-two-tower-snapshots",
    anchor: ["input?.towerSnapshots,", "    3,", '    "D4-tower",'].join("\n"),
    replacement: ["input?.towerSnapshots,", "    2,", '    "D4-tower",'].join(
      "\n",
    ),
    pins: "D4 requires three across-frame sort snapshots",
    rule: (subject) => {
      const input = d4Input();
      input.towerSnapshots.pop();
      return (
        subject.evaluateD4SortedIndexIdentity(input).status === "STRUCTURAL"
      );
    },
  },
  {
    lane: "D4",
    id: "D4-M2-ignore-input-drift",
    anchor: "if (towerDelta.inputChanged) {",
    replacement: "if (false) {",
    pins: "sort-output changes are interpretable only at fixed input",
    rule: (subject) => {
      const input = d4Input();
      input.towerSnapshots[2].inputSignature = "drifted-input";
      input.towerSnapshots[2].requestInputSignature = "drifted-input";
      return (
        subject.evaluateD4SortedIndexIdentity(input).status === "STRUCTURAL"
      );
    },
  },
  {
    lane: "D4",
    id: "D4-M3-ignore-permutation-hash",
    anchor: '!changedFields.includes("permutationSha256") &&',
    replacement: "true &&",
    pins: "changed permutation bytes implicate the sorter",
    rule: (subject) => {
      const input = d4Input();
      input.towerSnapshots[2].permutationSha256 = "b".repeat(64);
      return (
        subject.evaluateD4SortedIndexIdentity(input).classification ===
        "SORTER_IMPLICATED"
      );
    },
  },
  {
    lane: "D4",
    id: "D4-M4-ignore-pinned-control",
    anchor: "const controlFired = !controlDelta.stable;",
    replacement: "const controlFired = false;",
    pins: "two pinned reads must preserve every identity field",
    rule: (subject) => {
      const input = d4Input();
      input.controlPinnedReads[1].sequence = 10;
      return (
        subject.evaluateD4SortedIndexIdentity(input).classification ===
        "CONTROL_FIRED"
      );
    },
  },
  {
    lane: "D4",
    id: "D4-M5-allow-non-clean-request",
    anchor: "if (snapshot?.cleanStart !== true) {",
    replacement: "if (false) {",
    pins: "every attributed permutation begins with no sort in flight",
    rule: (subject) => {
      const input = d4Input();
      input.towerSnapshots[1].cleanStart = false;
      return (
        subject.evaluateD4SortedIndexIdentity(input).status === "STRUCTURAL"
      );
    },
  },
  {
    lane: "D4",
    id: "D4-M6-allow-reused-request-sequence",
    anchor: [
      "if (",
      "        snapshots[index]?.requestSequence <=",
      "        snapshots[index - 1]?.requestSequence",
      "      ) {",
    ].join("\n"),
    replacement: "if (false) {",
    pins: "the three observations are distinct advancing sort publications",
    rule: (subject) => {
      const input = d4Input();
      input.towerSnapshots[1].sequence = 9;
      input.towerSnapshots[1].requestSequence = 9;
      return (
        subject.evaluateD4SortedIndexIdentity(input).status === "STRUCTURAL"
      );
    },
  },
  {
    lane: "D5",
    id: "M-D5-a-delete-zero-coverage-branch",
    anchor: [
      "  if (record?.foregroundArea === 0) {",
      "    reasons.push(`${label}:subject-not-rendered`);",
      "    return;",
      "  }",
    ].join("\n"),
    replacement: "  // mutant deleted the zero-coverage branch",
    pins: "zero rendered coverage has one named structural diagnosis",
    rule: (subject) => {
      const result = subject.evaluateD5SpatialDistribution(
        d5Input(spatialRecord(), blankSpatialRecord(subject)),
      );
      return (
        result.status === "STRUCTURAL" &&
        result.structural.length === 1 &&
        result.structural[0] === "D5-control:subject-not-rendered"
      );
    },
  },
  {
    lane: "D5",
    id: "M-D5-b-inert-zero-coverage-branch",
    anchor: "  if (record?.foregroundArea === 0) {",
    replacement: "  if (false && record?.foregroundArea === 0) {",
    pins: "the zero-coverage diagnosis must be reachable",
    rule: (subject) => {
      const result = subject.evaluateD5SpatialDistribution(
        d5Input(spatialRecord(), blankSpatialRecord(subject)),
      );
      return (
        result.status === "STRUCTURAL" &&
        result.structural.length === 1 &&
        result.structural[0] === "D5-control:subject-not-rendered"
      );
    },
  },
  {
    lane: "D5",
    id: "M-D5-c-unconditional-zero-coverage-reason",
    anchor: "  if (record?.foregroundArea === 0) {",
    replacement: "  if (true) {",
    pins: "a rendered quiet control must not be voided",
    rule: (subject) => {
      const result = subject.evaluateD5SpatialDistribution(
        d5Input(spatialRecord(), renderedQuietDiscSpatialRecord(subject)),
      );
      return (
        result.status === "FAIL" &&
        result.structural.length === 0 &&
        result.measurements.controlEdgeRate === 0 &&
        result.measurements.controlInteriorRate === 0
      );
    },
  },
  {
    lane: "D5",
    id: "D5-M1-allow-empty-edge-region",
    anchor:
      "if (!(record?.edgeArea > 0)) reasons.push(`${label}:empty-edge-region`);",
    replacement:
      "if (record?.edgeArea < 0) reasons.push(`${label}:empty-edge-region`);",
    pins: "an empty edge band is structurally unresolved",
    rule: (subject) => {
      const input = d5Input();
      input.tower.edgeArea = 0;
      input.tower.edgeChanged = 0;
      input.tower.edgeRate = 0;
      input.tower.foregroundArea = input.tower.interiorArea;
      return (
        subject.evaluateD5SpatialDistribution(input).status === "STRUCTURAL"
      );
    },
  },
  {
    lane: "D5",
    id: "D5-M2-ignore-cube-map-control",
    anchor: [
      "if (controlFired) {",
      '    return statusResult("D5", "FAIL", {',
    ].join("\n"),
    replacement: [
      "if (false && controlFired) {",
      '    return statusResult("D5", "FAIL", {',
    ].join("\n"),
    pins: "the frozen cube map must not exceed the bar",
    rule: (subject) =>
      subject.evaluateD5SpatialDistribution(
        d5Input(spatialRecord(), spatialRecord()),
      ).classification === "CONTROL_FIRED",
  },
  {
    lane: "D5",
    id: "D5-M3-invert-spatial-direction",
    anchor: "interiorRate > edgeRate",
    replacement: "interiorRate < edgeRate",
    pins: "higher normalized interior rate means VOLUMETRIC",
    rule: (subject) =>
      subject.evaluateD5SpatialDistribution(d5Input()).classification ===
      "VOLUMETRIC",
  },
  {
    lane: "D5",
    id: "D5-M4-classify-without-signal",
    anchor: [
      "if (!varianceFired) {",
      "    return structuralResult(",
      '      "D5",',
    ].join("\n"),
    replacement: [
      "if (false && !varianceFired) {",
      "    return structuralResult(",
      '      "D5",',
    ].join("\n"),
    pins: "D5 cannot classify without an over-bar tower map",
    rule: (subject) =>
      subject.evaluateD5SpatialDistribution(
        d5Input(spatialRecord({ changedPixels: 0 })),
      ).status === "STRUCTURAL",
  },
  {
    lane: "D5",
    id: "D5-M5-call-contiguous-blob-volumetric",
    anchor: "interiorRate > edgeRate && scatteredInterior",
    replacement: "interiorRate > edgeRate",
    pins: "VOLUMETRIC requires dispersed interior components and grid occupancy",
    rule: (subject) => {
      const blob = spatialRecord();
      blob.interiorComponentCount = 1;
      blob.largestInteriorComponent = blob.interiorChanged;
      blob.largestInteriorComponentFraction = 1;
      blob.occupiedInteriorGridCells = 1;
      blob.interiorGridChanged = [
        blob.interiorChanged,
        ...new Array(63).fill(0),
      ];
      return (
        subject.evaluateD5SpatialDistribution(d5Input(blob)).classification ===
        "MIXED_OR_UNRESOLVED"
      );
    },
  },
];

test("each D1-D5 gate kills its exact loud model-mutant set", async (t) => {
  assert.equal(
    MODEL_MUTANTS.length,
    30,
    "adding a mutant is intended — bump this count",
  );
  for (const [lane, expected] of Object.entries({
    D1: 5,
    D2: 7,
    D3: 4,
    D4: 6,
    D5: 8,
  })) {
    assert.equal(
      MODEL_MUTANTS.filter((mutant) => mutant.lane === lane).length,
      expected,
      `${lane}: adding a mutant is intended — bump this count`,
    );
  }
  for (const lane of model.FRAME_VARIANCE_LANE_IDS) {
    assert.ok(
      MODEL_MUTANTS.filter((mutant) => mutant.lane === lane).length >= 4,
      `${lane} has at least four loud mutants`,
    );
  }
  for (const mutant of MODEL_MUTANTS) {
    await t.test(`${mutant.id}: ${mutant.pins}`, async () => {
      assert.equal(
        mutant.rule(model),
        true,
        `${mutant.id}: real model rejected`,
      );
      const subject = await importMutatedModel(mutant);
      assert.equal(
        mutant.rule(subject),
        false,
        `${mutant.id}: mutant survived`,
      );
    });
  }
});

function extractFunction(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `${name}: function declaration missing`);
  const brace = source.indexOf("{", start);
  assert.ok(brace >= 0, `${name}: opening brace missing`);
  let depth = 0;
  for (let index = brace; index < source.length; index++) {
    if (source[index] === "{") depth++;
    if (source[index] === "}") {
      depth--;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  throw new Error(`${name}: unterminated function declaration`);
}

function privateReads(source, receiver) {
  return new Set(
    [
      ...source.matchAll(new RegExp(`\\b${receiver}\\.(_[A-Za-z0-9_]+)`, "gu")),
    ].map((match) => match[1]),
  );
}

function d4SchedulerMemoReads(source) {
  const settledComparison =
    "Matrix4.equals(camera.viewMatrix, this._prevViewMatrix)";
  const comparisonIndex = source.indexOf(settledComparison);
  assert.ok(comparisonIndex >= 0, "D4 settled-scene comparison is missing");
  const settledStart = source.lastIndexOf("if (", comparisonIndex);
  const settledEnd = source.indexOf("return;", comparisonIndex);
  assert.ok(
    settledStart >= 0 && settledEnd > comparisonIndex,
    "D4 settled-scene early-return condition is incomplete",
  );
  const settledCondition = source.slice(settledStart, settledEnd);
  assert.match(settledCondition, /!hasPendingWork/u);

  const predicateReads = privateReads(
    extractFunction(source, "shouldStartSteadySort"),
    "primitive",
  );
  const resetMemos = privateReads(settledCondition, "this");
  for (const field of predicateReads) {
    const guardingFlag = field.replace(/^_last/u, "_hasLast");
    const isGuardedPayload =
      guardingFlag !== field && predicateReads.has(guardingFlag);
    if (!isGuardedPayload) resetMemos.add(field);
  }
  return resetMemos;
}

function d4SchedulerResetCovers(source) {
  const resetFields = new Set(D4_SCHEDULER_HISTORY_RESET_FIELDS);
  return [...d4SchedulerMemoReads(source)].every((field) =>
    resetFields.has(field),
  );
}

test("B2 every engine scheduler memo before publication is reset by D4", () => {
  assert.deepEqual([...d4SchedulerMemoReads(ENGINE_SOURCE)].sort(), [
    "_hasLastSteadySortCameraDirection",
    "_hasLastSteadySortCameraPosition",
    "_lastSteadySortFrameNumber",
    "_prevViewMatrix",
  ]);
  assert.equal(d4SchedulerResetCovers(ENGINE_SOURCE), true);
});

function extractConstant(source, name) {
  const expression = new RegExp(`const ${name} = ([^;]+);`, "u").exec(
    source,
  )?.[1];
  assert.ok(expression, `${name}: constant declaration missing`);
  return `const ${name} = ${expression};`;
}

function loadShouldStartSteadySort(source) {
  const declarations = [
    "DEFAULT_SORT_MIN_FRAME_INTERVAL",
    "DEFAULT_SORT_MIN_ANGLE_RADIANS",
    "DEFAULT_SORT_MIN_POSITION_DELTA",
  ]
    .map((name) => extractConstant(source, name))
    .join("\n");
  const functionSource = extractFunction(source, "shouldStartSteadySort");
  const Cartesian3 = {
    distance(left, right) {
      return Math.hypot(left.x - right.x, left.y - right.y, left.z - right.z);
    },
    angleBetween(left, right) {
      const leftMagnitude = Math.hypot(left.x, left.y, left.z);
      const rightMagnitude = Math.hypot(right.x, right.y, right.z);
      const cosine =
        (left.x * right.x + left.y * right.y + left.z * right.z) /
        (leftMagnitude * rightMagnitude);
      return Math.acos(Math.max(-1, Math.min(1, cosine)));
    },
  };
  // eslint-disable-next-line no-new-func
  return new Function(
    "defined",
    "Cartesian3",
    `"use strict";\n${declarations}\n${functionSource}\nreturn shouldStartSteadySort;`,
  )((value) => value !== undefined && value !== null, Cartesian3);
}

function sortPredicateFixture({
  frameNumber = 13,
  position = { x: 0, y: 0, z: 0 },
  direction = { x: 1, y: 0, z: 0 },
  camera = true,
} = {}) {
  return {
    primitive: {
      _lastSteadySortFrameNumber: 10,
      _hasLastSteadySortCameraPosition: true,
      _hasLastSteadySortCameraDirection: true,
      _lastSteadySortCameraPosition: { x: 0, y: 0, z: 0 },
      _lastSteadySortCameraDirection: { x: 1, y: 0, z: 0 },
    },
    frameState: {
      frameNumber,
      camera: camera
        ? { positionWC: position, directionWC: direction }
        : undefined,
    },
  };
}

function runSortPredicate(predicate, fixture) {
  return predicate(fixture.primitive, fixture.frameState);
}

test("the extracted engine sort predicate executes its exact production boundaries", () => {
  const predicate = loadShouldStartSteadySort(ENGINE_SOURCE);
  assert.equal(runSortPredicate(predicate, sortPredicateFixture()), false);
  assert.equal(
    runSortPredicate(
      predicate,
      sortPredicateFixture({ frameNumber: 12, position: { x: 2, y: 0, z: 0 } }),
    ),
    false,
  );
  assert.equal(
    runSortPredicate(
      predicate,
      sortPredicateFixture({ position: { x: 1, y: 0, z: 0 } }),
    ),
    true,
  );
  const angle = 0.01;
  assert.equal(
    runSortPredicate(
      predicate,
      sortPredicateFixture({
        direction: { x: Math.cos(angle), y: Math.sin(angle), z: 0 },
      }),
    ),
    true,
  );
  assert.equal(
    runSortPredicate(predicate, sortPredicateFixture({ camera: false })),
    false,
  );
});

const ENGINE_MUTANTS = [
  {
    id: "S1-remove-three-frame-throttle",
    anchor: "const DEFAULT_SORT_MIN_FRAME_INTERVAL = 3;",
    replacement: "const DEFAULT_SORT_MIN_FRAME_INTERVAL = 0;",
    rule: (predicate) =>
      runSortPredicate(
        predicate,
        sortPredicateFixture({
          frameNumber: 12,
          position: { x: 2, y: 0, z: 0 },
        }),
      ) === false,
  },
  {
    id: "S2-widen-position-threshold",
    anchor: "const DEFAULT_SORT_MIN_POSITION_DELTA = 1.0;",
    replacement: "const DEFAULT_SORT_MIN_POSITION_DELTA = 2.0;",
    rule: (predicate) =>
      runSortPredicate(
        predicate,
        sortPredicateFixture({ position: { x: 1.1, y: 0, z: 0 } }),
      ) === true,
  },
  {
    id: "S3-widen-angle-threshold",
    anchor: "const DEFAULT_SORT_MIN_ANGLE_RADIANS = 0.008726646259971648;",
    replacement: "const DEFAULT_SORT_MIN_ANGLE_RADIANS = 0.02;",
    rule: (predicate) => {
      const angle = 0.01;
      return (
        runSortPredicate(
          predicate,
          sortPredicateFixture({
            direction: { x: Math.cos(angle), y: Math.sin(angle), z: 0 },
          }),
        ) === true
      );
    },
  },
  {
    id: "S4-sort-identical-pose",
    anchor: "return angleDelta >= DEFAULT_SORT_MIN_ANGLE_RADIANS;",
    replacement: "return true;",
    rule: (predicate) =>
      runSortPredicate(predicate, sortPredicateFixture()) === false,
  },
  {
    id: "S5-add-unreset-settled-scene-memo",
    anchor: [
      "!hasPendingWork &&",
      "        Matrix4.equals(camera.viewMatrix, this._prevViewMatrix)",
    ].join("\n"),
    replacement: [
      "!hasPendingWork &&",
      "        this._futureSteadySortMemo &&",
      "        Matrix4.equals(camera.viewMatrix, this._prevViewMatrix)",
    ].join("\n"),
    rule: (_predicate, source) => d4SchedulerResetCovers(source),
  },
];

test("five loud extracted-engine mutants are killed and production survives", async (t) => {
  assert.equal(
    ENGINE_MUTANTS.length,
    5,
    "adding a mutant is intended — bump this count",
  );
  const production = loadShouldStartSteadySort(ENGINE_SOURCE);
  for (const mutant of ENGINE_MUTANTS) {
    await t.test(mutant.id, () => {
      assert.equal(
        mutant.rule(production, ENGINE_SOURCE),
        true,
        `${mutant.id}: production rejected`,
      );
      const source = mustReplace(
        ENGINE_SOURCE,
        mutant.anchor,
        mutant.replacement,
        mutant.id,
      );
      const subject = loadShouldStartSteadySort(source);
      assert.equal(
        mutant.rule(subject, source),
        false,
        `${mutant.id}: mutant survived`,
      );
    });
  }
});
