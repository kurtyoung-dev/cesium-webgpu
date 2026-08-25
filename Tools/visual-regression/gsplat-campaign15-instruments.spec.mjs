// Browser-free source-execution and mutation suite for C15-G7 and C15-G6.
// @purpose Extract and execute the real gsplat classification predicates and View frustum binning, mutant-test both, and pin the C15-G7/G6 pure instrument models.
// @status ACTIVE

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  GSPLAT_CLASSIFICATION_CONFIG,
  GSPLAT_CLASSIFICATION_SCHEMA,
  evaluateGsplatClassificationDepth,
  summarizeClassificationPixels,
} from "./lib/gsplat-classification-model.mjs";
import {
  GSPLAT_MULTIFRUSTUM_CONFIG,
  GSPLAT_MULTIFRUSTUM_PAGE_INSTRUMENT_SOURCE,
  GSPLAT_MULTIFRUSTUM_SCHEMA,
  acquireGsplatBoundingVolumeControl,
  applyGsplatMultifrustumPageFraming,
  createGsplatMultifrustumPlan,
  deriveFarNadirRange,
  evaluateGsplatMultifrustumFraming,
  settleGsplatMultifrustumPageFraming,
  summarizeGsplatFrustumBands,
} from "./lib/gsplat-multifrustum-framing.mjs";
import {
  FUSED_SNAPSHOT_BEGIN,
  FUSED_SNAPSHOT_END,
  checkEmbeddedFusedSnapshotIsCanonical,
  checkFusedCaptureUsage,
} from "./lib/same-task-capture.mjs";
import { analyzeProbeSource } from "./lib/probe-fleet-contract.mjs";
import { analyzeProhibitedReader } from "./lib/prohibited-reader-rule.mjs";
import { exitCodeForS5Status } from "./lib/verdict-exit-gate.mjs";
import { purposeHeaderViolations } from "../lib/purpose-header.mjs";
import {
  MAX_LABEL_DISAGREEMENT_FRACTION,
  compareGsplatBackendFraming,
  deriveGsplatTopologyRegistration,
  evaluateGsplatLabelTopology,
  evaluateGsplatMultifrustumProbeResult,
  partitionGsplatTopologyFrame,
} from "./probe-gsplat-multifrustum.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const tilePath = path.join(
  root,
  "packages/engine/Source/Scene/Cesium3DTile.js",
);
const drawCommandPath = path.join(
  root,
  "packages/engine/Source/Renderer/WebGPU/WebGPUDrawCommand.ts",
);
const viewPath = path.join(root, "packages/engine/Source/Scene/View.js");
const probePath = path.join(here, "probe-gsplat-classification-depth.mjs");
const multifrustumProbePath = path.join(here, "probe-gsplat-multifrustum.mjs");
const readNormalized = (file) =>
  fs.readFileSync(file, "utf8").replaceAll("\r\n", "\n");

let tagPredicateSource;
let pipelinePredicateSource;
let pvsMethodSource;
let updateFrustumsSource;
let insertIntoBinSource;
let realFrustumSources;

function occurrences(source, needle) {
  if (needle.length === 0) return 0;
  let count = 0;
  let cursor = 0;
  while ((cursor = source.indexOf(needle, cursor)) >= 0) {
    count++;
    cursor += needle.length;
  }
  return count;
}

function mustReplaceOne(source, needle, replacement, label) {
  assert.equal(
    occurrences(source, needle),
    1,
    `${label}: mutation anchor must occur exactly once`,
  );
  const mutated = source.replace(needle, replacement);
  assert.notEqual(mutated, source, `${label}: mutation did not apply`);
  return mutated;
}

function extractBetween(source, begin, end, label) {
  const start = source.indexOf(begin);
  assert.notEqual(start, -1, `${label}: begin anchor is gone`);
  const finish = source.indexOf(end, start);
  assert.notEqual(finish, -1, `${label}: end anchor is gone`);
  return source.slice(start, finish + end.length);
}

function extractBalanced(source, anchor, label) {
  const start = source.indexOf(anchor);
  assert.notEqual(start, -1, `${label}: source anchor is gone`);
  const open = source.indexOf("{", start);
  assert.notEqual(open, -1, `${label}: opening brace is gone`);
  let depth = 0;
  let quote = null;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  for (let index = open; index < source.length; index++) {
    const character = source[index];
    const next = source[index + 1];
    if (lineComment) {
      if (character === "\n") lineComment = false;
      continue;
    }
    if (blockComment) {
      if (character === "*" && next === "/") {
        blockComment = false;
        index++;
      }
      continue;
    }
    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === quote) {
        quote = null;
      }
      continue;
    }
    if (character === "/" && next === "/") {
      lineComment = true;
      index++;
      continue;
    }
    if (character === "/" && next === "*") {
      blockComment = true;
      index++;
      continue;
    }
    if (character === '"' || character === "'" || character === "`") {
      quote = character;
      continue;
    }
    if (character === "{") depth++;
    if (character === "}") {
      depth--;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  throw new Error(`${label}: unbalanced source block`);
}

// ---------------------------------------------------------------------------
// C15-G7: execute both real route predicates.
// ---------------------------------------------------------------------------

test.before(() => {
  const tileSource = readNormalized(tilePath);
  const drawCommandSource = readNormalized(drawCommandPath);
  const viewSource = readNormalized(viewPath);
  tagPredicateSource = extractBetween(
    tileSource,
    "      const translucent =",
    "      command.depthForTranslucentClassification = translucent;",
    "Cesium3DTile classification tag predicate",
  );
  pipelinePredicateSource = extractBetween(
    drawCommandSource,
    "    const pipelineToBind =",
    "    passEncoder.setPipeline(pipelineToBind);",
    "WebGPUDrawCommand pipeline predicate",
  );
  pvsMethodSource = extractBalanced(
    viewSource,
    "  createPotentiallyVisibleSet(scene) {",
    "View.createPotentiallyVisibleSet",
  );
  updateFrustumsSource = extractBalanced(
    viewSource,
    "function updateFrustums(",
    "updateFrustums",
  );
  insertIntoBinSource = extractBalanced(
    viewSource,
    "function insertIntoBin(",
    "insertIntoBin",
  );
  realFrustumSources = Object.freeze({
    pvs: pvsMethodSource,
    update: updateFrustumsSource,
    insert: insertIntoBinSource,
  });
});

const TAG_PASS = Object.freeze({
  OPAQUE: 9,
  TRANSLUCENT: 10,
  GAUSSIAN_SPLATS: 12,
});

function compileTagPredicate(source) {
  // eslint-disable-next-line no-new-func
  return new Function(
    "command",
    "Pass",
    `${source}\nreturn command.depthForTranslucentClassification;`,
  );
}

function tagTruthFailures(source) {
  const predicate = compileTagPredicate(source);
  const cases = [
    ["gaussian-splat-pass", TAG_PASS.GAUSSIAN_SPLATS, true],
    ["translucent-pass", TAG_PASS.TRANSLUCENT, true],
    ["opaque-pass", TAG_PASS.OPAQUE, false],
    ["undefined-pass", undefined, false],
  ];
  return cases.flatMap(([label, pass, expected]) => {
    const actual = predicate({ pass }, TAG_PASS);
    return actual === expected ? [] : [label];
  });
}

function compilePipelinePredicate(source) {
  const erased = mustReplaceOne(
    source,
    "this.classificationDepthPipeline!",
    "this.classificationDepthPipeline",
    "TypeScript non-null erasure",
  );
  // eslint-disable-next-line no-new-func
  const execute = new Function(
    "defined",
    `return function executeExtract(passEncoder) {\n${erased}\n};`,
  )((value) => value !== undefined && value !== null);
  return (command) => {
    const passEncoder = {
      bound: undefined,
      setPipeline(pipeline) {
        this.bound = pipeline;
      },
    };
    execute.call(command, passEncoder);
    return passEncoder.bound;
  };
}

function pipelineTruthFailures(source) {
  const select = compilePipelinePredicate(source);
  const base = { identity: "base" };
  const variant = { identity: "classification-depth" };
  const cases = [
    ["flagged-with-variant", true, variant, variant],
    ["flagged-without-variant", true, null, base],
    ["unflagged-with-variant", false, variant, base],
    ["unflagged-without-variant", false, undefined, base],
  ];
  return cases.flatMap(
    ([label, flag, classificationDepthPipeline, expected]) =>
      select({
        depthForTranslucentClassification: flag,
        classificationDepthPipeline,
        pipeline: base,
      }) === expected
        ? []
        : [label],
  );
}

test("G7 real Cesium3DTile predicate tags translucent and Gaussian-splat commands", () => {
  assert.deepEqual(tagTruthFailures(tagPredicateSource), []);
});

const tagMutants = [
  {
    name: "remove Gaussian-splat arm",
    needle: "command.pass === Pass.GAUSSIAN_SPLATS",
    replacement: "false",
    failures: ["gaussian-splat-pass"],
  },
  {
    name: "require both passes with AND",
    needle:
      "command.pass === Pass.TRANSLUCENT ||\n        command.pass === Pass.GAUSSIAN_SPLATS",
    replacement:
      "command.pass === Pass.TRANSLUCENT &&\n        command.pass === Pass.GAUSSIAN_SPLATS",
    failures: ["gaussian-splat-pass", "translucent-pass"],
  },
  {
    name: "invert the Gaussian-splat equality",
    needle: "command.pass === Pass.GAUSSIAN_SPLATS",
    replacement: "command.pass !== Pass.GAUSSIAN_SPLATS",
    failures: ["gaussian-splat-pass", "opaque-pass", "undefined-pass"],
  },
  {
    name: "tag opaque instead of Gaussian splats",
    needle: "Pass.GAUSSIAN_SPLATS",
    replacement: "Pass.OPAQUE",
    failures: ["gaussian-splat-pass", "opaque-pass"],
  },
];

function registerTagMutantTest(mutant) {
  test(`G7 tag mutant rejected: ${mutant.name}`, () => {
    const source = tagPredicateSource;
    assert.deepEqual(
      tagTruthFailures(source),
      [],
      "real source must pass before its mutant is meaningful",
    );
    const mutated = mustReplaceOne(
      source,
      mutant.needle,
      mutant.replacement,
      mutant.name,
    );
    assert.deepEqual(tagTruthFailures(mutated), mutant.failures);
  });
}

for (const mutant of tagMutants) {
  registerTagMutantTest(mutant);
}

test("G7 real WebGPUDrawCommand predicate binds the variant only in its one valid cell", () => {
  assert.deepEqual(pipelineTruthFailures(pipelinePredicateSource), []);
});

const pipelineMutants = [
  {
    name: "OR the flag and variant guard",
    needle:
      "this.depthForTranslucentClassification &&\n      defined(this.classificationDepthPipeline)",
    replacement:
      "this.depthForTranslucentClassification ||\n      defined(this.classificationDepthPipeline)",
    failures: ["flagged-without-variant", "unflagged-with-variant"],
  },
  {
    name: "negate the depth-classification flag",
    needle: "this.depthForTranslucentClassification &&",
    replacement: "!this.depthForTranslucentClassification &&",
    failures: ["flagged-with-variant", "unflagged-with-variant"],
  },
  {
    name: "negate the defined variant guard",
    needle: "defined(this.classificationDepthPipeline)",
    replacement: "!defined(this.classificationDepthPipeline)",
    failures: ["flagged-with-variant", "flagged-without-variant"],
  },
  {
    name: "swap variant and base ternary arms",
    needle: "? this.classificationDepthPipeline!\n        : this.pipeline;",
    replacement:
      "? this.pipeline\n        : this.classificationDepthPipeline!;",
    failures: [
      "flagged-with-variant",
      "flagged-without-variant",
      "unflagged-with-variant",
      "unflagged-without-variant",
    ],
  },
];

function registerPipelineMutantTest(mutant) {
  test(`G7 selector mutant rejected: ${mutant.name}`, () => {
    const source = pipelinePredicateSource;
    assert.deepEqual(
      pipelineTruthFailures(source),
      [],
      "real source must pass before its mutant is meaningful",
    );
    const mutated = mustReplaceOne(
      source,
      mutant.needle,
      mutant.replacement,
      mutant.name,
    );
    assert.deepEqual(pipelineTruthFailures(mutated), mutant.failures);
  });
}

for (const mutant of pipelineMutants) {
  registerPipelineMutantTest(mutant);
}

// ---------------------------------------------------------------------------
// C15-G6: execute complete real View PVS/update/bin source.
// ---------------------------------------------------------------------------

const FRUSTUM_PASS = Object.freeze({
  ENVIRONMENT: 0,
  COMPUTE: 1,
  GLOBE: 2,
  GAUSSIAN_SPLATS: 12,
  OVERLAY: 14,
  NUMBER_OF_PASSES: 15,
});
const SCENE3D = 3;

function compileFrustumExecutor(sources) {
  class FrustumCommandsStub {
    constructor(near, far) {
      this.near = near;
      this.far = far;
      this.indices = Array(FRUSTUM_PASS.NUMBER_OF_PASSES).fill(0);
      this.commands = Array.from(
        { length: FRUSTUM_PASS.NUMBER_OF_PASSES },
        () => [],
      );
    }
  }
  const defined = (value) => value !== undefined && value !== null;
  // eslint-disable-next-line no-new-func
  const updateFrustums = new Function(
    "SceneMode",
    "CesiumMath",
    "defined",
    "FrustumCommands",
    `${sources.update}\nreturn updateFrustums;`,
  )({ SCENE2D: 2 }, { EPSILON2: 0.0001 }, defined, FrustumCommandsStub);
  // Pass is injected even though only the wrong-pass mutant needs it.  That
  // lets the mutant execute and fail the same battery instead of failing to
  // compile for an irrelevant missing shim.
  // eslint-disable-next-line no-new-func
  const insertIntoBin = new Function(
    "defined",
    "Pass",
    `${sources.insert}\nreturn insertIntoBin;`,
  )(defined, FRUSTUM_PASS);
  const open = sources.pvs.indexOf("{");
  const body = sources.pvs.slice(open + 1, -1);
  class ClearCommandStub {}
  class CommandExtentStub {
    constructor() {
      this.command = undefined;
      this.near = undefined;
      this.far = undefined;
    }
  }
  // eslint-disable-next-line no-new-func
  const pvs = new Function(
    "Pass",
    "defined",
    "ClearCommand",
    "CommandExtent",
    "ShadowMap",
    "SceneMode",
    "scratchCullingVolume",
    "scratchNearFarInterval",
    "isShadowedPass",
    "mergeShadowOnlyCasterCandidates",
    "needsEnvironmentOnlyFrustum",
    "updateFrustums",
    "insertIntoBin",
    `return function createPotentiallyVisibleSet(scene) {${body}};`,
  )(
    FRUSTUM_PASS,
    defined,
    ClearCommandStub,
    CommandExtentStub,
    { MAXIMUM_DISTANCE: 10_000 },
    { SCENE3D },
    { planes: Array(5).fill(null) },
    { start: 0, stop: 0 },
    Array(FRUSTUM_PASS.NUMBER_OF_PASSES).fill(false),
    () => {},
    () => false,
    updateFrustums,
    insertIntoBin,
  );
  return { pvs, insertIntoBin, FrustumCommandsStub };
}

function boundingVolume(start, stop) {
  return {
    computePlaneDistances(_position, _direction, result) {
      result.start = start;
      result.stop = stop;
      return result;
    },
  };
}

function createPvsFixture(executor) {
  const globe = {
    pass: FRUSTUM_PASS.GLOBE,
    boundingVolume: boundingVolume(100, 10_000),
    castShadows: false,
    executeInClosestFrustum: false,
  };
  const splat = {
    pass: FRUSTUM_PASS.GAUSSIAN_SPLATS,
    boundingVolume: boundingVolume(500, 600),
    castShadows: false,
    executeInClosestFrustum: false,
  };
  const view = {
    frustumCommandsList: [],
    _shadowCasters: [],
    _commandExtents: [],
    _shadowCasterSeen: new Set(),
  };
  const scene = {
    frameState: {
      camera: {
        positionWC: {},
        directionWC: {},
        position: { z: 1_000 },
        frustum: { near: 0.1, far: 1e10 },
      },
      commandList: [globe, splat],
      shadowState: {
        shadowsEnabled: false,
        prePvsCasterCommands: [],
      },
      mode: SCENE3D,
      occluder: undefined,
      cullingVolume: { planes: Array(6).fill(null) },
      frustumSplits: [],
      useLogDepth: true,
    },
    _computeCommandList: [],
    _overlayCommandList: [],
    debugShowFrustums: false,
    logarithmicDepthFarToNearRatio: 2,
    farToNearRatio: 1_000,
    mode: SCENE3D,
    nearToFarDistance2D: 1_000,
    isVisible: () => true,
    updateDerivedCommands: () => {},
    _alternateSceneRenderer: {},
  };
  return { view, scene, globe, splat };
}

function splatVector(view) {
  return view.frustumCommandsList.map(
    (band) => band.indices[FRUSTUM_PASS.GAUSSIAN_SPLATS],
  );
}

function frustumBatteryFailures(sources) {
  const failures = [];
  const executor = compileFrustumExecutor(sources);
  const fixture = createPvsFixture(executor);
  executor.pvs.call(fixture.view, fixture.scene);
  if (fixture.view.frustumCommandsList.length !== 7) {
    failures.push("clean-band-count");
  }
  if (
    JSON.stringify(splatVector(fixture.view)) !==
    JSON.stringify([0, 0, 1, 0, 0, 0, 0])
  ) {
    failures.push("clean-bounded-splat-vector");
  }

  fixture.splat.boundingVolume = undefined;
  executor.pvs.call(fixture.view, fixture.scene);
  if (fixture.view.frustumCommandsList.length !== 37) {
    failures.push("suppressed-band-count");
  }
  if (!splatVector(fixture.view).every((index) => index > 0)) {
    failures.push("suppressed-splat-not-in-every-band");
  }
  if (
    !fixture.view.frustumCommandsList.some(
      (band) =>
        band.indices[FRUSTUM_PASS.GAUSSIAN_SPLATS] > 0 &&
        band.indices[FRUSTUM_PASS.GLOBE] === 0,
    )
  ) {
    failures.push("suppressed-no-splat-only-band");
  }

  const boundaryView = {
    frustumCommandsList: [
      new executor.FrustumCommandsStub(100, 200),
      new executor.FrustumCommandsStub(200, 400),
    ],
  };
  executor.insertIntoBin(
    boundaryView,
    {
      debugShowFrustums: false,
      _alternateSceneRenderer: {},
      updateDerivedCommands: () => {},
    },
    {
      command: {
        pass: FRUSTUM_PASS.GAUSSIAN_SPLATS,
        executeInClosestFrustum: false,
      },
      near: 200,
      far: 200,
    },
  );
  const boundaryVector = boundaryView.frustumCommandsList.map(
    (band) => band.indices[FRUSTUM_PASS.GAUSSIAN_SPLATS],
  );
  if (JSON.stringify(boundaryVector) !== JSON.stringify([1, 1])) {
    failures.push("inclusive-boundary-overlap");
  }
  return failures;
}

test("G6 real View PVS derives seven clean bands and 37 every-band suppression bands", () => {
  assert.deepEqual(frustumBatteryFailures(realFrustumSources), []);
});

const frustumMutants = [
  {
    name: "make bounding volumes inert",
    component: "pvs",
    needle: "if (defined(boundingVolume)) {",
    replacement: "if (false && defined(boundingVolume)) {",
    pinnedFailure: "clean-band-count",
  },
  {
    name: "collapse the BV-less far span",
    component: "pvs",
    needle:
      "          // If command has no bounding volume we need to use the camera's\n" +
      "          // worst-case near and far planes to avoid clipping something important.\n" +
      "          commandNear = frustum.near;\n" +
      "          commandFar = frustum.far;",
    replacement:
      "          // If command has no bounding volume we need to use the camera's\n" +
      "          // worst-case near and far planes to avoid clipping something important.\n" +
      "          commandNear = frustum.near;\n" +
      "          commandFar = commandNear;",
    pinnedFailure: "suppressed-band-count",
  },
  {
    name: "ignore logarithmic-depth ratio",
    component: "update",
    needle:
      "  const farToNearRatio = useLogDepth\n" +
      "    ? scene.logarithmicDepthFarToNearRatio\n" +
      "    : scene.farToNearRatio;",
    replacement:
      "  const farToNearRatio = useLogDepth\n" +
      "    ? scene.farToNearRatio\n" +
      "    : scene.farToNearRatio;",
    pinnedFailure: "clean-band-count",
  },
  {
    name: "drop the terminal band with floor",
    component: "update",
    needle:
      "numFrustums = Math.ceil(Math.log(far / near) / Math.log(farToNearRatio));",
    replacement:
      "numFrustums = Math.floor(Math.log(far / near) / Math.log(farToNearRatio));",
    pinnedFailure: "clean-band-count",
  },
  {
    name: "make touching-band overlap exclusive",
    component: "insert",
    needle: "if (far < frustumCommands.near) {",
    replacement: "if (far <= frustumCommands.near) {",
    pinnedFailure: "inclusive-boundary-overlap",
  },
  {
    name: "increment the globe slot instead of the command pass",
    component: "insert",
    needle: "const index = frustumCommands.indices[pass]++;",
    replacement: "const index = frustumCommands.indices[Pass.GLOBE]++;",
    pinnedFailure: "clean-bounded-splat-vector",
  },
  {
    name: "break after the closest frustum unconditionally",
    component: "insert",
    needle: "if (command.executeInClosestFrustum) {",
    replacement: "if (true || command.executeInClosestFrustum) {",
    pinnedFailure: "suppressed-splat-not-in-every-band",
  },
];

function registerFrustumMutantTest(mutant) {
  test(`G6 View mutant rejected: ${mutant.name}`, () => {
    const sources = realFrustumSources;
    assert.deepEqual(
      frustumBatteryFailures(sources),
      [],
      "real source must pass before its mutant is meaningful",
    );
    const mutated = {
      ...sources,
      [mutant.component]: mustReplaceOne(
        sources[mutant.component],
        mutant.needle,
        mutant.replacement,
        mutant.name,
      ),
    };
    const failures = frustumBatteryFailures(mutated);
    assert.ok(
      failures.includes(mutant.pinnedFailure),
      `${mutant.name}: expected ${mutant.pinnedFailure}, got ${failures}`,
    );
  });
}

for (const mutant of frustumMutants) {
  registerFrustumMutantTest(mutant);
}

// ---------------------------------------------------------------------------
// Pure G7 pixel/verdict model.
// ---------------------------------------------------------------------------

function rgbaFrame(width = 100, height = 100) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let offset = 0; offset < data.length; offset += 4) {
    data[offset] = 38;
    data[offset + 1] = 38;
    data[offset + 2] = 44;
    data[offset + 3] = 255;
  }
  return { width, height, data };
}

function cloneFrame(frame) {
  return {
    width: frame.width,
    height: frame.height,
    data: new Uint8ClampedArray(frame.data),
  };
}

function paint(frame, centerX, centerY, radius, color) {
  for (let y = centerY - radius; y <= centerY + radius; y++) {
    for (let x = centerX - radius; x <= centerX + radius; x++) {
      const offset = (y * frame.width + x) * 4;
      frame.data[offset] = color[0];
      frame.data[offset + 1] = color[1];
      frame.data[offset + 2] = color[2];
      frame.data[offset + 3] = 255;
    }
  }
}

function pixelFrames(options = {}) {
  const baseline = rgbaFrame();
  const tower = cloneFrame(baseline);
  paint(tower, 70, 50, 8, [170, 170, 180]);
  const towerRepeat = cloneFrame(tower);
  const terrainReference = cloneFrame(baseline);
  paint(terrainReference, 25, 50, 3, [240, 5, 210]);
  if (options.terrainCoversSplat) {
    paint(terrainReference, 70, 50, 3, [240, 5, 210]);
  }
  const positive = cloneFrame(tower);
  paint(positive, 25, 50, 3, [240, 5, 210]);
  if (!options.positiveOnTerrain) {
    paint(positive, 70, 50, 3, [240, 5, 210]);
  }
  const suppressed = cloneFrame(tower);
  paint(suppressed, 25, 50, 3, [240, 5, 210]);
  if (options.suppressedOnSplat) {
    paint(suppressed, 70, 50, 3, [240, 5, 210]);
  }
  const restored = cloneFrame(tower);
  paint(restored, 25, 50, 3, [240, 5, 210]);
  paint(restored, 70, 50, 3, [240, 5, 210]);
  return {
    baseline,
    tower,
    towerRepeat,
    terrainReference,
    positive,
    suppressed,
    restored,
  };
}

function pixelSummary(options = {}) {
  const summarizer = options.serialized
    ? // eslint-disable-next-line no-new-func
      new Function(`return (${summarizeClassificationPixels.toString()});`)()
    : summarizeClassificationPixels;
  return summarizer(
    {
      frames: pixelFrames(options),
      anchors: {
        splat: { x: 70, y: 50 },
        terrain: { x: 25, y: 50 },
      },
    },
    GSPLAT_CLASSIFICATION_CONFIG,
  );
}

function counter(kind) {
  return {
    executions: 1,
    selectedExecutions: kind === "selected" ? 1 : 0,
    fallbackExecutions: kind === "fallback" ? 1 : 0,
    unexpectedReadExecutions: 0,
  };
}

function classificationInput(overrides = {}) {
  const commonRuntime = {
    ready: true,
    globeTilesLoaded: true,
    globeCommands: 1,
    splatCommands: 1,
    tilesetReady: true,
    classifierReady: true,
  };
  const webgpu = {
    pixels: pixelSummary(),
    runtime: {
      ...commonRuntime,
      rendererType: "webgpu",
      gpuGateArmedDevices: 1,
    },
    route: {
      instrument: {
        commandLocated: true,
        commandInFrustum: true,
        gaussianSplatPass: true,
        depthClassificationFlag: true,
        variantDefined: true,
        variantDistinctFromBase: true,
        bundleAbsent: true,
        stableCommandIdentity: true,
        suppressionGetterHeld: true,
        descriptorRestored: true,
      },
      positive: counter("selected"),
      suppressed: counter("fallback"),
      restored: counter("selected"),
    },
  };
  return {
    schema: GSPLAT_CLASSIFICATION_SCHEMA,
    captureContract: {
      canonical: true,
      singleBlock: true,
      usageValid: true,
      writeOnce: true,
    },
    cleanup: { complete: true },
    harnessErrors: [],
    productErrors: [],
    webgl: {
      pixels: pixelSummary(),
      runtime: { ...commonRuntime, rendererType: "webgl" },
    },
    webgpu,
    ...overrides,
  };
}

test("G7 serialized pixel summarizer resolves terrain, splat, suppression, and restoration masks", () => {
  const summary = pixelSummary({ serialized: true });
  assert.equal(summary.ok, true);
  assert.ok(
    summary.states.positiveLift.distanceToSplat <
      summary.states.positiveLift.distanceToTerrain,
  );
  assert.ok(
    summary.states.suppressed.distanceToTerrain <
      summary.states.suppressed.distanceToSplat,
  );
  assert.ok(summary.states.positiveLift.towerOverlapPixels > 16);
});

test("G7 pure model accepts a live selected route with a structural terrain-return control", () => {
  const result = evaluateGsplatClassificationDepth(classificationInput());
  assert.equal(result.status, "PASS");
  assert.equal(result.exitCode, 0);
});

test("G7 positive terrain placement remains a product failure even when route selection is live", () => {
  const input = classificationInput();
  input.webgpu.pixels = pixelSummary({ positiveOnTerrain: true });
  const result = evaluateGsplatClassificationDepth(input);
  assert.equal(result.status, "FAIL");
  assert.ok(result.failures.includes("webgpu:positive:polygon-not-on-splat"));
});

test("G7 terrain reference over the splat ROI makes subtraction structurally invalid", () => {
  const input = classificationInput();
  input.webgl.pixels = pixelSummary({ terrainCoversSplat: true });
  const result = evaluateGsplatClassificationDepth(input);
  assert.equal(result.status, "STRUCTURAL");
  assert.ok(
    result.structural.includes("webgl:terrain-reference:overlaps-splat-roi"),
  );
});

test("G7 a terrain-dominant suppression frame with a residual splat lobe is structural", () => {
  const input = classificationInput();
  input.webgpu.pixels = pixelSummary({ suppressedOnSplat: true });
  const result = evaluateGsplatClassificationDepth(input);
  assert.equal(result.status, "STRUCTURAL");
  assert.ok(result.structural.includes("webgpu:negative:splat-lift-remains"));
  assert.equal(result.exitCode, 3);
});

test("G7 cleanup failure is harness ERROR, never STRUCTURAL", () => {
  const input = classificationInput({ cleanup: { complete: false } });
  const result = evaluateGsplatClassificationDepth(input);
  assert.equal(result.status, "ERROR");
  assert.ok(result.harnessErrors.includes("cleanup:incomplete"));
  assert.equal(result.exitCode, 2);
});

test("G7 backend fallback and an unarmed WebGPU error gate are structural", () => {
  const input = classificationInput();
  input.webgl.runtime.rendererType = "webgpu";
  input.webgpu.runtime.gpuGateArmedDevices = 0;
  const result = evaluateGsplatClassificationDepth(input);
  assert.equal(result.status, "STRUCTURAL");
  assert.ok(
    result.structural.includes("webgl:runtime:backend-identity-unproven"),
  );
  assert.ok(result.structural.includes("webgpu:runtime:error-gate-unarmed"));
});

test("G7 selected-pipeline counter miss is a product failure after instrumentation standing is proven", () => {
  const input = classificationInput();
  input.webgpu.route.positive = counter("fallback");
  const result = evaluateGsplatClassificationDepth(input);
  assert.equal(result.status, "FAIL");
  assert.ok(
    result.failures.includes(
      "webgpu:route:classification-depth-pipeline-not-selected",
    ),
  );
});

// ---------------------------------------------------------------------------
// Pure G6 framing/order model.
// ---------------------------------------------------------------------------

const cleanBands = Object.freeze([
  Object.freeze({
    index: 0,
    near: 100,
    far: 200,
    globeIndex: 1,
    splatIndex: 0,
  }),
  Object.freeze({
    index: 1,
    near: 200,
    far: 400,
    globeIndex: 1,
    splatIndex: 1,
  }),
  Object.freeze({
    index: 2,
    near: 400,
    far: 800,
    globeIndex: 0,
    splatIndex: 0,
  }),
]);
const suppressedBands = Object.freeze([
  Object.freeze({
    index: 0,
    near: 0.1,
    far: 0.2,
    globeIndex: 0,
    splatIndex: 1,
  }),
  Object.freeze({
    index: 1,
    near: 0.2,
    far: 0.4,
    globeIndex: 0,
    splatIndex: 1,
  }),
  Object.freeze({
    index: 2,
    near: 0.4,
    far: 0.8,
    globeIndex: 1,
    splatIndex: 1,
  }),
  Object.freeze({
    index: 3,
    near: 0.8,
    far: 1.6,
    globeIndex: 1,
    splatIndex: 1,
  }),
]);

function framingBackend(overrides = {}) {
  return {
    ok: true,
    structural: [],
    settle: {
      ready: true,
      activeFrusta: cleanBands.length,
      globeCommands: 2,
      splatCommands: 1,
      logDepthEnabled: true,
      logarithmicDepthFarToNearRatio: 2,
    },
    clean: { bands: cleanBands.map((band) => ({ ...band })) },
    suppressed: {
      bands: suppressedBands.map((band) => ({ ...band })),
    },
    restored: { bands: cleanBands.map((band) => ({ ...band })) },
    commandCount: 1,
    allBoundingVolumesDefined: true,
    suppressionAppliedCount: 1,
    boundingVolumeIdentitiesRestored: true,
    restorationPvsRan: true,
    ...overrides,
  };
}

function framingInput() {
  const radius = 38.472;
  const fovyRadians = Math.PI / 3;
  const viewportHeightFraction =
    GSPLAT_MULTIFRUSTUM_CONFIG.towerViewportHeightFraction;
  return {
    schema: GSPLAT_MULTIFRUSTUM_SCHEMA,
    passes: { globe: 2, gaussianSplats: 12 },
    framing: {
      assetUrl: GSPLAT_MULTIFRUSTUM_CONFIG.assetUrl,
      globeShown: true,
      headingRadians: GSPLAT_MULTIFRUSTUM_CONFIG.headingRadians,
      logDepthEnabled: true,
      logarithmicDepthFarToNearRatio: 2,
      pitchRadians: -Math.PI / 2,
      radius,
      fovyRadians,
      viewportHeightFraction,
      range: deriveFarNadirRange(radius, fovyRadians, viewportHeightFraction),
    },
    backends: {
      webgl: framingBackend(),
      webgpu: framingBackend(),
    },
  };
}

test("G6 far-nadir range is derived from radius/FOV and the plan carries the real split knob", () => {
  const range = deriveFarNadirRange(38.472, Math.PI / 3);
  assert.ok(Math.abs(range - 667.443) < 0.1, `unexpected range ${range}`);
  const plan = createGsplatMultifrustumPlan({
    radius: 38.472,
    fovyRadians: Math.PI / 3,
  });
  assert.equal(plan.pitchRadians, -Math.PI / 2);
  assert.equal(
    plan.logarithmicDepthFarToNearRatio,
    GSPLAT_MULTIFRUSTUM_CONFIG.logarithmicDepthFarToNearRatio,
  );
});

test("G6 parity-page payload is direct-embed CSP-safe and carries all three reviewed helpers", () => {
  assert.doesNotMatch(
    GSPLAT_MULTIFRUSTUM_PAGE_INSTRUMENT_SOURCE,
    /\b(?:eval|Function)\s*\(/u,
  );
  for (const helper of [
    acquireGsplatBoundingVolumeControl,
    applyGsplatMultifrustumPageFraming,
    settleGsplatMultifrustumPageFraming,
  ]) {
    assert.ok(
      GSPLAT_MULTIFRUSTUM_PAGE_INSTRUMENT_SOURCE.includes(helper.toString()),
      `${helper.name} drifted out of the direct-embed payload`,
    );
  }
  // Node compiles the exact declarations only to prove that direct embedding
  // leaves the instrument in the consumer callback's lexical scope.  The page
  // never receives source text and never invokes eval/new Function at runtime.
  // eslint-disable-next-line no-new-func
  const instrument = new Function(
    `${GSPLAT_MULTIFRUSTUM_PAGE_INSTRUMENT_SOURCE}\n` +
      "return gsplatMultifrustumPageInstrument;",
  )();
  assert.deepEqual(Object.keys(instrument).sort(), [
    "acquireBoundingVolumeControl",
    "apply",
    "settle",
  ]);
});

test("G6 page framing derives the tower range and rejects the wrong asset", () => {
  const cameraCalls = [];
  const fakeViewer = {
    scene: {
      globe: {
        show: false,
        imageryLayers: { removeAll() {} },
      },
      camera: { frustum: { fovy: Math.PI / 3 } },
      logarithmicDepthFarToNearRatio: 1e9,
    },
    camera: {
      viewBoundingSphere(sphere, offset) {
        cameraCalls.push({ sphere, offset });
      },
      lookAtTransform(transform) {
        cameraCalls.push({ transform });
      },
    },
  };
  const fakeC = {
    Color: { fromCssColorString: (value) => ({ value }) },
    EllipsoidTerrainProvider: class {},
    HeadingPitchRange: class {
      constructor(heading, pitch, range) {
        Object.assign(this, { heading, pitch, range });
      }
    },
    Matrix4: { IDENTITY: { identity: true } },
  };
  const tileset = {
    boundingSphere: { radius: 38.472 },
    resource: { url: GSPLAT_MULTIFRUSTUM_CONFIG.assetUrl },
  };
  const plan = applyGsplatMultifrustumPageFraming(fakeC, fakeViewer, tileset);
  assert.equal(plan.assetUrl, GSPLAT_MULTIFRUSTUM_CONFIG.assetUrl);
  assert.equal(fakeViewer.scene.globe.show, true);
  assert.equal(fakeViewer.scene.logarithmicDepthFarToNearRatio, 2);
  assert.equal(plan.pitchRadians, -Math.PI / 2);
  assert.equal(cameraCalls.length, 2);
  assert.throws(
    () =>
      applyGsplatMultifrustumPageFraming(fakeC, fakeViewer, {
        boundingSphere: { radius: 38.472 },
        resource: { url: "/wrong/asset.json" },
      }),
    /perspective tower\/globe scene/u,
  );
});

function liveBands(serialized) {
  return serialized.map((band) => {
    const indices = Array(FRUSTUM_PASS.NUMBER_OF_PASSES).fill(0);
    indices[FRUSTUM_PASS.GLOBE] = band.globeIndex;
    indices[FRUSTUM_PASS.GAUSSIAN_SPLATS] = band.splatIndex;
    return { near: band.near, far: band.far, indices };
  });
}

test("G6 settle reads a live >=2-frustum tower/globe topology", async () => {
  let renders = 0;
  const scene = {
    globe: { tilesLoaded: true },
    frameState: { useLogDepth: true },
    logarithmicDepthFarToNearRatio: 2,
    _view: { frustumCommandsList: liveBands(cleanBands) },
    requestRender() {},
    render() {
      renders++;
    },
  };
  const result = await settleGsplatMultifrustumPageFraming(
    {
      JulianDate: { fromIso8601: (value) => value },
      Pass: FRUSTUM_PASS,
    },
    { scene },
    { tilesLoaded: true },
    100,
  );
  assert.equal(result.ready, true);
  assert.equal(result.activeFrusta, cleanBands.length);
  assert.equal(result.globeCommands, 2);
  assert.equal(result.splatCommands, 1);
  assert.equal(renders, 1);
});

function boundingControlFixture(options = {}) {
  const originalBoundingVolume = { identity: "tower-bv" };
  const command = {
    pass: FRUSTUM_PASS.GAUSSIAN_SPLATS,
    boundingVolume: options.nullBoundingVolume ? null : originalBoundingVolume,
  };
  let pvsCalls = 0;
  const view = {
    frustumCommandsList: liveBands(cleanBands),
    createPotentiallyVisibleSet() {
      pvsCalls++;
      if (command.boundingVolume === undefined) {
        if (options.throwWhenSuppressed) {
          throw new Error("synthetic suppressed PVS failure");
        }
        this.frustumCommandsList = liveBands(suppressedBands);
      } else {
        this.frustumCommandsList = liveBands(cleanBands);
      }
    },
  };
  return {
    command,
    originalBoundingVolume,
    scene: { _view: view, frameState: { commandList: [command] } },
    pvsCalls: () => pvsCalls,
  };
}

test("G6 BV control executes clean/suppressed/restored PVS and preserves identity", () => {
  const fixture = boundingControlFixture();
  const result = acquireGsplatBoundingVolumeControl(
    fixture.scene,
    FRUSTUM_PASS.GLOBE,
    FRUSTUM_PASS.GAUSSIAN_SPLATS,
  );
  assert.equal(result.ok, true);
  assert.equal(result.commandCount, 1);
  assert.equal(result.suppressionAppliedCount, 1);
  assert.ok(result.suppressed.bands.every((band) => band.splatIndex > 0));
  assert.deepEqual(result.restored.bands, result.clean.bands);
  assert.equal(fixture.command.boundingVolume, fixture.originalBoundingVolume);
  assert.equal(result.boundingVolumeIdentitiesRestored, true);
  assert.equal(result.restorationPvsRan, true);
  assert.equal(fixture.pvsCalls(), 2);

  const nullFixture = boundingControlFixture({ nullBoundingVolume: true });
  const nullResult = acquireGsplatBoundingVolumeControl(
    nullFixture.scene,
    FRUSTUM_PASS.GLOBE,
    FRUSTUM_PASS.GAUSSIAN_SPLATS,
  );
  assert.equal(nullResult.ok, false);
  assert.equal(nullResult.allBoundingVolumesDefined, false);
  assert.ok(
    nullResult.structural.includes("pvs:clean-bounding-volume-missing"),
  );
  assert.equal(nullFixture.command.boundingVolume, null);
});

test("G6 BV control restores identity and reruns PVS after suppressed PVS throws", () => {
  const fixture = boundingControlFixture({ throwWhenSuppressed: true });
  const result = acquireGsplatBoundingVolumeControl(
    fixture.scene,
    FRUSTUM_PASS.GLOBE,
    FRUSTUM_PASS.GAUSSIAN_SPLATS,
  );
  assert.equal(result.ok, false);
  assert.ok(
    result.structural.some((reason) => reason.startsWith("pvs:control-error:")),
  );
  assert.equal(fixture.command.boundingVolume, fixture.originalBoundingVolume);
  assert.equal(result.boundingVolumeIdentitiesRestored, true);
  assert.equal(result.restorationPvsRan, true);
  assert.deepEqual(result.restored.bands, result.clean.bands);
  assert.equal(fixture.pvsCalls(), 2);
});

test("G6 topology reads both frustum lists before invoking the lazy occlusion reader", () => {
  let reads = 0;
  const result = evaluateGsplatMultifrustumFraming(framingInput(), () => {
    reads++;
    return { occludedSplatPixels: 123 };
  });
  assert.equal(result.eligible, true);
  assert.equal(reads, 1);
  assert.deepEqual(
    result.readOrder.map((entry) => entry.kind),
    ["frustumCommands", "frustumCommands", "occlusion"],
  );
  assert.deepEqual(result.activeFrusta, { webgl: 3, webgpu: 3 });
});

test("G6 one-frustum topology returns structural without touching occlusion", () => {
  const input = framingInput();
  input.backends.webgpu.clean.bands = [input.backends.webgpu.clean.bands[0]];
  let reads = 0;
  const result = evaluateGsplatMultifrustumFraming(input, () => {
    reads++;
    throw new Error("occlusion was read before anti-vacuity standing");
  });
  assert.equal(result.eligible, false);
  assert.equal(result.occlusionRead, false);
  assert.equal(reads, 0);
  assert.ok(result.structural.includes("webgpu:active-frusta:1-below-2"));
});

test("G6 suppression missing one band is structural and still cannot read occlusion", () => {
  const input = framingInput();
  input.backends.webgl.suppressed.bands[2].splatIndex = 0;
  let reads = 0;
  const result = evaluateGsplatMultifrustumFraming(input, () => {
    reads++;
    return { forbidden: true };
  });
  assert.equal(result.eligible, false);
  assert.equal(reads, 0);
  assert.ok(
    result.structural.includes("webgl:negative:splat-not-in-every-band"),
  );
});

test("G7 probe source embeds exactly one canonical fused capture and satisfies fleet readers/lifecycle", () => {
  const source = readNormalized(probePath);
  assert.equal(occurrences(source, FUSED_SNAPSHOT_BEGIN), 1);
  assert.equal(occurrences(source, FUSED_SNAPSHOT_END), 1);
  assert.deepEqual(checkEmbeddedFusedSnapshotIsCanonical(source), []);
  assert.deepEqual(checkFusedCaptureUsage(source), []);
  assert.deepEqual(analyzeProbeSource(source).violations, []);
  assert.deepEqual(analyzeProhibitedReader(source).violations, []);
  assert.match(source, /renderer=\$\{renderer\}&offline=true/u);
  assert.doesNotMatch(source, /\bnew Function\s*\(/u);
  assert.match(source, /persistAndRederiveCaptureImages\(/u);
  assert.match(source, /decodedAfterWrite/u);
  assert.match(source, /pixels\[backend\] = summarizeClassificationPixels\(/u);
});

// ---------------------------------------------------------------------------
// Standalone C15-G6 probe: fleet, page-helper pins, row gates and mutations.
// ---------------------------------------------------------------------------

const G6_PAGE_INSTRUMENT_BEGIN =
  "// ==BEGIN gsplat-multifrustum-page-instrument==";
const G6_PAGE_INSTRUMENT_END = "// ==END gsplat-multifrustum-page-instrument==";
const G6_NODE_MODEL_BEGIN = "// ==BEGIN gsplat-multifrustum-node-model==";
const G6_NODE_MODEL_END = "// ==END gsplat-multifrustum-node-model==";

function g6ProbeSource() {
  return readNormalized(multifrustumProbePath);
}

function extractG6PageInstrument(source) {
  return extractBetween(
    source,
    G6_PAGE_INSTRUMENT_BEGIN,
    G6_PAGE_INSTRUMENT_END,
    "G6 probe page instrument",
  );
}

function compileG6PageInstrument(source) {
  const block = extractG6PageInstrument(source);
  // This browser-free spec compiles the extracted declarations so their
  // behavior can be compared with the imports. The probe sends declarations
  // directly through page.evaluate and contains no runtime source evaluation.
  // eslint-disable-next-line no-new-func
  return new Function(
    `${block}\nreturn {` +
      "summarize: summarizeGsplatFrustumBands," +
      "acquire: acquireGsplatBoundingVolumeControl," +
      "apply: applyGsplatMultifrustumPageFraming," +
      "settle: settleGsplatMultifrustumPageFraming" +
      "};",
  )();
}

function compileG6NodeModel(source) {
  const block = extractBetween(
    source,
    G6_NODE_MODEL_BEGIN,
    G6_NODE_MODEL_END,
    "G6 probe Node model",
  ).replace(/\bexport\s+/gu, "");
  // This browser-free mutation harness compiles only the marked pure model.
  // No compiled source reaches the page or the acquisition runtime.
  // eslint-disable-next-line no-new-func
  return new Function(
    "GSPLAT_MULTIFRUSTUM_CONFIG",
    "exitCodeForS5Status",
    `${block}\nreturn {` +
      "MAX_LABEL_DISAGREEMENT_FRACTION," +
      "partitionGsplatTopologyFrame," +
      "deriveGsplatTopologyRegistration," +
      "evaluateGsplatLabelTopology," +
      "compareGsplatBackendFraming," +
      "evaluateGsplatMultifrustumProbeResult" +
      "};",
  )(GSPLAT_MULTIFRUSTUM_CONFIG, exitCodeForS5Status);
}

function compileG6LiveColorReader(source) {
  const block = extractBalanced(
    source,
    "const readLiveColorRgb = (color) => {",
    "G6 probe live Cesium color reader",
  );
  // This browser-free check compiles only the page callback's local colour
  // reader, so the live Color.toBytes evidence path is behaviorally pinned.
  // No compiled source reaches a page or the acquisition runtime.
  // eslint-disable-next-line no-new-func
  return new Function(`${block};\nreturn readLiveColorRgb;`)();
}

function normalizeWhitespaceOutsideLiterals(value) {
  const source = value.replaceAll("\r\n", "\n");
  let result = "";
  let state = "code";
  let escaped = false;
  const appendSpace = () => {
    if (result.length > 0 && !result.endsWith(" ")) result += " ";
  };
  for (let index = 0; index < source.length; index++) {
    const character = source[index];
    const next = source[index + 1];
    if (state === "single" || state === "double" || state === "template") {
      result += character;
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (
        (state === "single" && character === "'") ||
        (state === "double" && character === '"') ||
        (state === "template" && character === "`")
      ) {
        state = "code";
      }
      continue;
    }
    if (state === "line-comment") {
      if (character === "\n") {
        appendSpace();
        state = "code";
      } else if (/\s/u.test(character)) {
        appendSpace();
      } else {
        result += character;
      }
      continue;
    }
    if (state === "block-comment") {
      if (character === "*" && next === "/") {
        result += "*/";
        index++;
        state = "code";
      } else if (/\s/u.test(character)) {
        appendSpace();
      } else {
        result += character;
      }
      continue;
    }
    if (/\s/u.test(character)) {
      appendSpace();
    } else if (character === "/" && next === "/") {
      result += "//";
      index++;
      state = "line-comment";
    } else if (character === "/" && next === "*") {
      result += "/*";
      index++;
      state = "block-comment";
    } else {
      result += character;
      if (character === "'") state = "single";
      if (character === '"') state = "double";
      if (character === "`") state = "template";
    }
  }
  return result.trim();
}

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

function createG6ApplyFixture(assetUrl = GSPLAT_MULTIFRUSTUM_CONFIG.assetUrl) {
  const cameraCalls = [];
  const viewer = {
    scene: {
      globe: {
        show: false,
        imageryLayers: { removeAll() {} },
      },
      camera: { frustum: { fovy: Math.PI / 3 } },
      logarithmicDepthFarToNearRatio: 1e9,
    },
    camera: {
      viewBoundingSphere(sphere, offset) {
        cameraCalls.push({ sphere, offset });
      },
      lookAtTransform(transform) {
        cameraCalls.push({ transform });
      },
    },
  };
  const C = {
    Color: { fromCssColorString: (value) => ({ value }) },
    EllipsoidTerrainProvider: class {},
    HeadingPitchRange: class {
      constructor(heading, pitch, range) {
        Object.assign(this, { heading, pitch, range });
      }
    },
    Matrix4: { IDENTITY: { identity: true } },
  };
  return {
    C,
    viewer,
    cameraCalls,
    tileset: {
      boundingSphere: { radius: 38.472 },
      resource: { url: assetUrl },
    },
  };
}

function serializedReadyBands(activeFrusta) {
  return Array.from({ length: activeFrusta }, (_, index) => ({
    index,
    near: index + 1,
    far: index + 2,
    globeIndex: index === 0 ? 1 : 0,
    splatIndex: index === 0 ? 1 : 0,
  }));
}

function createG6SettleFixture(activeFrusta = cleanBands.length) {
  const bands =
    activeFrusta === cleanBands.length
      ? cleanBands
      : serializedReadyBands(activeFrusta);
  let renders = 0;
  const scene = {
    globe: { tilesLoaded: true },
    frameState: { useLogDepth: true },
    logarithmicDepthFarToNearRatio: 2,
    _view: { frustumCommandsList: liveBands(bands) },
    requestRender() {},
    render() {
      renders++;
    },
  };
  return {
    C: {
      JulianDate: { fromIso8601: (value) => value },
      Pass: FRUSTUM_PASS,
    },
    viewer: { scene },
    tileset: { tilesLoaded: true },
    renders: () => renders,
  };
}

async function runExtractedSettler(settle, activeFrusta, timeoutMs = 100) {
  const fixture = createG6SettleFixture(activeFrusta);
  const savedPerformance = globalThis.performance;
  const savedSetTimeout = globalThis.setTimeout;
  let clockMs = 0;
  globalThis.performance = { now: () => clockMs };
  globalThis.setTimeout = (resolve, delayMs) => {
    clockMs += delayMs;
    resolve();
    return 0;
  };
  try {
    const result = await settle(
      fixture.C,
      fixture.viewer,
      fixture.tileset,
      timeoutMs,
    );
    return { ...result, renders: fixture.renders() };
  } finally {
    globalThis.performance = savedPerformance;
    globalThis.setTimeout = savedSetTimeout;
  }
}

function rgbaLabelFrame(width, height, labels) {
  const data = new Uint8ClampedArray(width * height * 4);
  const colors = {
    background: [16, 16, 20, 255],
    globe: [38, 38, 44, 255],
    splat: [180, 120, 90, 255],
  };
  for (let pixel = 0; pixel < width * height; pixel++) {
    const label = labels(pixel, width * height);
    data.set(colors[label], pixel * 4);
  }
  return { width, height, data };
}

function decidableTopologyFrames(
  disagreementPixels = 0,
  width = 20,
  height = 20,
) {
  const webgl = rgbaLabelFrame(width, height, (pixel, total) => {
    if (pixel < total / 4) return "background";
    if (pixel < total / 2) return "splat";
    return "globe";
  });
  const webgpu = cloneFrame(webgl);
  const firstSplat = Math.floor((width * height) / 4);
  for (let index = 0; index < disagreementPixels; index++) {
    const offset = (firstSplat + index) * 4;
    webgpu.data.set([38, 38, 44, 255], offset);
  }
  return { webgl, webgpu };
}

function twoLabelFrames(left, right, width = 20, height = 20) {
  const frame = rgbaLabelFrame(width, height, (pixel, total) =>
    pixel < total / 2 ? left : right,
  );
  return { webgl: frame, webgpu: cloneFrame(frame) };
}

function standingWithTopology(topology) {
  return {
    eligible: true,
    structural: [],
    activeFrusta: { webgl: 3, webgpu: 3 },
    occlusionRead: true,
    occlusion: topology,
    readOrder: [
      { ordinal: 1, kind: "frustumCommands", backend: "webgl" },
      { ordinal: 2, kind: "frustumCommands", backend: "webgpu" },
      { ordinal: 3, kind: "occlusion" },
    ],
  };
}

function g6ProbeResultInput(standing, overrides = {}) {
  return {
    captureContract: { failures: [] },
    cleanup: { complete: true },
    harnessErrors: [],
    framingAgreement: { agree: true, structural: [] },
    standing,
    ...overrides,
  };
}

function matchingRuntime(renderer) {
  const references = deriveGsplatTopologyRegistration(20, 20).labelPartition;
  return {
    rendererType: renderer,
    gpuGateArmedDevices: renderer === "webgpu" ? 1 : 0,
    backgroundColorRgb: [...references.backgroundRgb],
    globeBaseColorRgb: [...references.globeRgb],
  };
}

function matchingBackendRecords(input = framingInput()) {
  return Object.fromEntries(
    ["webgl", "webgpu"].map((renderer) => [
      renderer,
      {
        framing: { ...input.framing },
        passes: { ...input.passes },
        runtime: matchingRuntime(renderer),
      },
    ]),
  );
}

function evaluateStandingWithFrames(frames, input = framingInput()) {
  return evaluateGsplatMultifrustumFraming(input, () =>
    evaluateGsplatLabelTopology(frames.webgl, frames.webgpu),
  );
}

test("G6 probe S1 satisfies fleet, capture, reader, purpose, URL, and source-evaluation contracts", () => {
  const source = g6ProbeSource();
  const analysis = analyzeProbeSource(source);
  assert.deepEqual(analysis.violations, []);
  assert.deepEqual(analyzeProhibitedReader(source).violations, []);
  assert.deepEqual(checkEmbeddedFusedSnapshotIsCanonical(source), []);
  assert.deepEqual(checkFusedCaptureUsage(source), []);
  assert.equal(occurrences(source, FUSED_SNAPSHOT_BEGIN), 1);
  assert.equal(occurrences(source, FUSED_SNAPSHOT_END), 1);
  assert.deepEqual(purposeHeaderViolations(source), []);
  assert.match(source, /renderer=\$\{renderer\}&offline=true/u);
  assert.match(
    source,
    /chromium\.launch\(\{[\s\S]*?channel:\s*"msedge",[\s\S]*?headless:\s*!options\.headed,[\s\S]*?args:\s*\["--enable-unsafe-webgpu"\],[\s\S]*?timeout:\s*BROWSER_LAUNCH_TIMEOUT_MS/u,
  );
  assert.doesNotMatch(source, /\bnew\s+Function\s*\(/u);
  assert.doesNotMatch(source, /\beval\s*\(/u);
  assert.match(
    source,
    /backgroundColorRgb:\s*readLiveColorRgb\(scene\.backgroundColor\)/u,
  );
  assert.match(
    source,
    /globeBaseColorRgb:\s*readLiveColorRgb\(scene\.globe\.baseColor\)/u,
  );
  assert.match(
    source,
    /runtime:\s*byRenderer\[renderer\]\?\.measurement\?\.runtime/u,
  );
  assert.match(source, /runtime:\s*session\.measurement\.runtime/u);
  assert.match(
    source,
    /evaluateGsplatMultifrustumFraming\(evaluationInput, \(\) =>\s*evaluateGsplatLabelTopology\(\s*persisted\.frames\.webgl\?\.clean,\s*persisted\.frames\.webgpu\?\.clean,\s*\),\s*\)/u,
  );
  const persistence = extractBalanced(
    source,
    "async function persistAndRederiveCaptureImages(",
    "G6 capture persistence",
  );
  assert.ok(
    persistence.indexOf("writeOnceExact(") <
      persistence.indexOf("decodedAfterWrite"),
    "persisted bytes must be exclusively written and reread before Node decode",
  );
});

test("G6 probe S2 extracted page helpers match library behavior on every required fixture", async () => {
  const extracted = compileG6PageInstrument(g6ProbeSource());
  assert.deepEqual(
    extracted.summarize(
      liveBands(cleanBands),
      FRUSTUM_PASS.GLOBE,
      FRUSTUM_PASS.GAUSSIAN_SPLATS,
    ),
    summarizeGsplatFrustumBands(
      liveBands(cleanBands),
      FRUSTUM_PASS.GLOBE,
      FRUSTUM_PASS.GAUSSIAN_SPLATS,
    ),
  );

  for (const options of [{}, { nullBoundingVolume: true }]) {
    const libraryFixture = boundingControlFixture(options);
    const extractedFixture = boundingControlFixture(options);
    const libraryResult = acquireGsplatBoundingVolumeControl(
      libraryFixture.scene,
      FRUSTUM_PASS.GLOBE,
      FRUSTUM_PASS.GAUSSIAN_SPLATS,
    );
    const extractedResult = extracted.acquire(
      extractedFixture.scene,
      FRUSTUM_PASS.GLOBE,
      FRUSTUM_PASS.GAUSSIAN_SPLATS,
    );
    assert.deepEqual(extractedResult, libraryResult);
    assert.equal(extractedFixture.pvsCalls(), libraryFixture.pvsCalls());
    assert.equal(extractedFixture.pvsCalls(), 2);
    assert.equal(
      extractedFixture.command.boundingVolume,
      options.nullBoundingVolume
        ? null
        : extractedFixture.originalBoundingVolume,
    );
  }

  const libraryThrow = boundingControlFixture({ throwWhenSuppressed: true });
  const extractedThrow = boundingControlFixture({ throwWhenSuppressed: true });
  const savedStackTraceLimit = Error.stackTraceLimit;
  let libraryThrowResult;
  let extractedThrowResult;
  try {
    Error.stackTraceLimit = 0;
    libraryThrowResult = acquireGsplatBoundingVolumeControl(
      libraryThrow.scene,
      FRUSTUM_PASS.GLOBE,
      FRUSTUM_PASS.GAUSSIAN_SPLATS,
    );
    extractedThrowResult = extracted.acquire(
      extractedThrow.scene,
      FRUSTUM_PASS.GLOBE,
      FRUSTUM_PASS.GAUSSIAN_SPLATS,
    );
  } finally {
    Error.stackTraceLimit = savedStackTraceLimit;
  }
  assert.deepEqual(extractedThrowResult, libraryThrowResult);
  assert.equal(extractedThrow.pvsCalls(), libraryThrow.pvsCalls());
  assert.equal(extractedThrow.pvsCalls(), 2);

  assert.deepEqual(
    await runExtractedSettler(extracted.settle, cleanBands.length),
    await runExtractedSettler(
      settleGsplatMultifrustumPageFraming,
      cleanBands.length,
    ),
  );

  const libraryApply = createG6ApplyFixture();
  const extractedApply = createG6ApplyFixture();
  const libraryPlan = applyGsplatMultifrustumPageFraming(
    libraryApply.C,
    libraryApply.viewer,
    libraryApply.tileset,
  );
  const extractedPlan = extracted.apply(
    extractedApply.C,
    extractedApply.viewer,
    extractedApply.tileset,
  );
  assert.deepEqual(extractedPlan, libraryPlan);
  assert.deepEqual(
    plain(extractedApply.cameraCalls),
    plain(libraryApply.cameraCalls),
  );
  const wrongAssetErrors = [];
  for (const apply of [applyGsplatMultifrustumPageFraming, extracted.apply]) {
    const wrong = createG6ApplyFixture("/wrong/asset.json");
    let caught = null;
    try {
      apply(wrong.C, wrong.viewer, wrong.tileset);
    } catch (error) {
      caught = { name: error?.name, message: error?.message };
    }
    assert.notEqual(caught, null);
    wrongAssetErrors.push(caught);
  }
  assert.deepEqual(wrongAssetErrors[1], wrongAssetErrors[0]);
  assert.deepEqual(wrongAssetErrors[0], {
    name: "Error",
    message: "G6 framing requires a perspective tower/globe scene",
  });
});

test("G6 probe S3 page-helper token identity tolerates only declared non-literal whitespace reflow", () => {
  const block = extractG6PageInstrument(g6ProbeSource());
  const helpers = [
    summarizeGsplatFrustumBands,
    acquireGsplatBoundingVolumeControl,
    applyGsplatMultifrustumPageFraming,
    settleGsplatMultifrustumPageFraming,
  ];
  for (const helper of helpers) {
    const declarationAnchor = helper.toString().startsWith("async function ")
      ? `async function ${helper.name}(`
      : `function ${helper.name}(`;
    const embedded = extractBalanced(
      block,
      declarationAnchor,
      `G6 embedded ${helper.name}`,
    );
    assert.equal(occurrences(block, declarationAnchor), 1);
    // Declared fragility class: CRLF is normalized and whitespace runs outside
    // string/template literals collapse; every other token remains identity-pinned.
    assert.equal(
      normalizeWhitespaceOutsideLiterals(embedded),
      normalizeWhitespaceOutsideLiterals(helper.toString()),
      `${helper.name} changed by more than formatter whitespace reflow`,
    );
  }
});

test("G6 probe S4 maps all four row clauses to live counters and the lazy label reader", () => {
  const frames = decidableTopologyFrames();
  const standing = evaluateStandingWithFrames(frames);
  assert.equal(standing.eligible, true);
  assert.deepEqual(standing.activeFrusta, { webgl: 3, webgpu: 3 });
  assert.deepEqual(
    standing.readOrder.map((entry) => entry.kind),
    ["frustumCommands", "frustumCommands", "occlusion"],
  );
  assert.ok(standing.occlusion.summaries.webgl.counts.splat > 0);
  assert.ok(standing.occlusion.summaries.webgpu.counts.splat > 0);
  assert.equal(standing.occlusion.g3.passes, true);
  for (const backend of ["webgl", "webgpu"]) {
    assert.ok(
      framingInput().backends[backend].suppressed.bands.every(
        (band) => band.splatIndex > 0,
      ),
    );
  }
  const result = evaluateGsplatMultifrustumProbeResult(
    g6ProbeResultInput(standing),
  );
  assert.equal(result.status, "PASS");
  assert.equal(result.exitCode, exitCodeForS5Status("PASS"));
});

test("G6 probe S4 G-1 failure cannot invoke the occlusion closure", () => {
  const input = framingInput();
  input.backends.webgpu.clean.bands = [input.backends.webgpu.clean.bands[0]];
  let reads = 0;
  const standing = evaluateGsplatMultifrustumFraming(input, () => {
    reads++;
    throw new Error("pixel reader must remain lazy on G-1 failure");
  });
  assert.equal(reads, 0);
  assert.equal(standing.eligible, false);
  assert.ok(standing.structural.includes("webgpu:active-frusta:1-below-2"));
  const result = evaluateGsplatMultifrustumProbeResult(
    g6ProbeResultInput(standing),
  );
  assert.equal(result.status, "STRUCTURAL");
  assert.ok(result.structural.includes("webgpu:active-frusta:1-below-2"));
});

test("G6 probe S4 G-4 failure is every-band counter evidence and remains pixel-lazy", () => {
  const input = framingInput();
  input.backends.webgl.suppressed.bands[1].splatIndex = 0;
  let reads = 0;
  const standing = evaluateGsplatMultifrustumFraming(input, () => {
    reads++;
    throw new Error("pixel reader must remain lazy on G-4 failure");
  });
  assert.equal(reads, 0);
  assert.equal(standing.eligible, false);
  assert.ok(
    standing.structural.includes("webgl:negative:splat-not-in-every-band"),
  );
});

test("G6 probe S4 G-3 exact boundary passes and the next pixel is a product failure", () => {
  const totalPixels = 20 * 20;
  const exactPixels = Math.round(totalPixels * MAX_LABEL_DISAGREEMENT_FRACTION);
  assert.equal(exactPixels / totalPixels, MAX_LABEL_DISAGREEMENT_FRACTION);
  const exact = evaluateGsplatLabelTopology(
    ...Object.values(decidableTopologyFrames(exactPixels)),
  );
  const above = evaluateGsplatLabelTopology(
    ...Object.values(decidableTopologyFrames(exactPixels + 1)),
  );
  assert.equal(exact.g3.passes, true);
  assert.equal(above.g3.passes, false);
  assert.equal(
    evaluateGsplatMultifrustumProbeResult(
      g6ProbeResultInput(standingWithTopology(above)),
    ).status,
    "FAIL",
  );
});

test("G6 probe F2c publishes footprint-relative disagreement without gating it", () => {
  const frames = decidableTopologyFrames(1);
  const topology = evaluateGsplatLabelTopology(frames.webgl, frames.webgpu);
  const minimumSplatPixels = Math.min(
    topology.summaries.webgl.counts.splat,
    topology.summaries.webgpu.counts.splat,
  );
  assert.equal(topology.disagreementPixels, 1);
  assert.equal(
    topology.disagreementToSplatFootprintRatio,
    topology.disagreementPixels / minimumSplatPixels,
  );
  assert.ok(
    topology.disagreementToSplatFootprintRatio >
      MAX_LABEL_DISAGREEMENT_FRACTION,
  );
  const result = evaluateGsplatMultifrustumProbeResult(
    g6ProbeResultInput(standingWithTopology(topology)),
  );
  assert.equal(result.status, "PASS");
  assert.equal(
    result.topology.disagreementToSplatFootprintRatio,
    topology.disagreementToSplatFootprintRatio,
  );

  const zeroSplatFrames = twoLabelFrames("background", "globe");
  const zeroSplat = evaluateGsplatLabelTopology(
    zeroSplatFrames.webgl,
    zeroSplatFrames.webgpu,
  );
  assert.equal(zeroSplat.disagreementToSplatFootprintRatio, null);

  const source = g6ProbeSource();
  const nodeModel = extractBetween(
    source,
    G6_NODE_MODEL_BEGIN,
    G6_NODE_MODEL_END,
    "G6 probe Node model",
  );
  assert.equal(occurrences(nodeModel, "disagreementToSplatFootprintRatio"), 3);
  const verdictFold = extractBalanced(
    source,
    "export function evaluateGsplatMultifrustumProbeResult(",
    "G6 probe verdict fold",
  );
  assert.doesNotMatch(verdictFold, /disagreementToSplatFootprintRatio/u);
  assert.match(source, /topology:\s*evaluation\.topology/u);
});

test("G6 probe G-2 splat occupancy is read per backend even when standing is structural", () => {
  // Structural for a reason INDEPENDENT of splat occupancy (mismatched frame
  // dimensions), so this still exercises the ineligible record after
  // R-2026-08-24-14 moved asymmetric absence off the structural path.
  const frames = {
    webgl: decidableTopologyFrames().webgl,
    webgpu: twoLabelFrames("background", "globe", 21, 20).webgpu,
  };
  const topology = evaluateGsplatLabelTopology(frames.webgl, frames.webgpu);
  assert.equal(topology.eligible, false);
  assert.ok(topology.structural.includes("labels:frame-dimensions-mismatch"));
  assert.deepEqual(topology.g2, { webgl: true, webgpu: false });
});

test("G6 probe G-2 mutant caught: WebGPU occupancy read from the WebGL partition", () => {
  const source = g6ProbeSource();
  const mutated = mustReplaceOne(
    source,
    "webgpu: partitions.webgpu.valid ? partitions.webgpu.counts.splat > 0 : null,",
    "webgpu: partitions.webgl.valid ? partitions.webgl.counts.splat > 0 : null,",
    "G-2 cross-backend occupancy read",
  );
  const canonicalModel = compileG6NodeModel(source);
  const mutantModel = compileG6NodeModel(mutated);
  const frames = {
    webgl: decidableTopologyFrames().webgl,
    webgpu: twoLabelFrames("background", "globe").webgpu,
  };
  const canonical = canonicalModel.evaluateGsplatLabelTopology(
    frames.webgl,
    frames.webgpu,
  );
  const mutation = mutantModel.evaluateGsplatLabelTopology(
    frames.webgl,
    frames.webgpu,
  );
  assert.notDeepEqual(mutation.g2, canonical.g2);
});

// R-2026-08-24-14 tier routing: asymmetric absence is a FAIL the lane saw;
// symmetric absence is blindness and stays STRUCTURAL.
function asymmetricSplatFrames() {
  return {
    webgl: decidableTopologyFrames().webgl,
    webgpu: twoLabelFrames("background", "globe").webgpu,
  };
}

test("G6 probe R-2026-08-24-14 asymmetric splat absence is FAIL exit 1, not structural", () => {
  const frames = asymmetricSplatFrames();
  const topology = evaluateGsplatLabelTopology(frames.webgl, frames.webgpu);
  assert.deepEqual(topology.failures, ["webgpu:labels:zero-splat-asymmetric"]);
  assert.ok(!topology.structural.includes("webgpu:labels:zero-splat"));
  const standing = standingWithTopology(topology);
  const verdict = evaluateGsplatMultifrustumProbeResult(
    g6ProbeResultInput(standing),
  );
  assert.equal(verdict.status, "FAIL");
  assert.equal(verdict.exitCode, 1);
  assert.ok(verdict.failures.includes("webgpu:labels:zero-splat-asymmetric"));
  assert.deepEqual(verdict.structural, []);
});

test("G6 probe R-2026-08-24-14 symmetric splat absence stays STRUCTURAL exit 3", () => {
  const both = twoLabelFrames("background", "globe");
  const topology = evaluateGsplatLabelTopology(both.webgl, both.webgpu);
  assert.deepEqual(topology.failures, []);
  assert.ok(topology.structural.includes("webgl:labels:zero-splat"));
  assert.ok(topology.structural.includes("webgpu:labels:zero-splat"));
  const standing = standingWithTopology(topology);
  const verdict = evaluateGsplatMultifrustumProbeResult(
    g6ProbeResultInput(standing),
  );
  assert.equal(verdict.status, "STRUCTURAL");
  assert.equal(verdict.exitCode, 3);
});

test("G6 probe R-2026-08-24-14 mutant caught: inertness re-routes asymmetric absence to structural", () => {
  const source = g6ProbeSource();
  const mutated = mustReplaceOne(
    source,
    "      : splatOccupancy.webgpu === 0 && splatOccupancy.webgl > 0",
    "      : false && splatOccupancy.webgpu === 0 && splatOccupancy.webgl > 0",
    "R-2026-08-24-14 asymmetric routing inertness",
  );
  const canonicalModel = compileG6NodeModel(source);
  const mutantModel = compileG6NodeModel(mutated);
  const frames = asymmetricSplatFrames();
  const canonical = canonicalModel.evaluateGsplatLabelTopology(
    frames.webgl,
    frames.webgpu,
  );
  const mutation = mutantModel.evaluateGsplatLabelTopology(
    frames.webgl,
    frames.webgpu,
  );
  // The canonical build reports the asymmetry as a FAIL reason; the inert
  // build silently returns it to the structural path, which is the exact
  // regression R-2026-08-24-14 forbids.
  assert.deepEqual(canonical.failures, ["webgpu:labels:zero-splat-asymmetric"]);
  assert.deepEqual(mutation.failures, []);
  assert.ok(mutation.structural.includes("webgpu:labels:zero-splat"));
  assert.notDeepEqual(mutation.structural, canonical.structural);
});

// R-2026-08-24-16 fixture d4: WebGL composes 40 splat + 100 globe pixels;
// WebGPU composes nothing but background. Pixel 0 is background on both, so
// the corner precondition passes and the only reasons in play are the
// asymmetric FAIL and WebGPU's own consequence reasons.
function d4AsymmetricFrames(webgpuWidth = 20) {
  const webgl = rgbaLabelFrame(20, 20, (pixel) => {
    if (pixel < 260) return "background";
    if (pixel < 300) return "splat";
    return "globe";
  });
  const webgpu = rgbaLabelFrame(webgpuWidth, 20, () => "background");
  return { webgl, webgpu };
}

test("G6 probe R-2026-08-24-16 (e) asymmetric FAIL outranks the same-backend consequence reasons", () => {
  const frames = d4AsymmetricFrames();
  const topology = evaluateGsplatLabelTopology(frames.webgl, frames.webgpu);
  assert.equal(topology.summaries.webgl.counts.splat, 40);
  assert.equal(topology.summaries.webgl.counts.globe, 100);
  assert.equal(topology.summaries.webgpu.counts.splat, 0);
  assert.deepEqual(topology.structural, []);
  assert.equal(topology.eligible, true);
  assert.deepEqual(topology.failures, ["webgpu:labels:zero-splat-asymmetric"]);
  // The consequence reasons are published, not discarded.
  assert.deepEqual(topology.suppressedStructural, [
    "webgpu:labels:zero-globe",
    "webgpu:labels:single-label-frame",
  ]);
  const verdict = evaluateGsplatMultifrustumProbeResult(
    g6ProbeResultInput(standingWithTopology(topology)),
  );
  assert.equal(verdict.status, "FAIL");
  assert.equal(verdict.exitCode, 1);
  assert.ok(verdict.failures.includes("webgpu:labels:zero-splat-asymmetric"));
  assert.deepEqual(verdict.structural, []);
});

test("G6 probe R-2026-08-24-16 (f) an unproven settled frame outranks the asymmetric FAIL", () => {
  const frames = d4AsymmetricFrames();
  const topology = evaluateGsplatLabelTopology(frames.webgl, frames.webgpu);
  const input = framingInput();
  // The library requires BOTH globeCommands >= 1 and splatCommands >= 1 on the
  // settled frame; zeroing globe commands is what makes the frame unproven.
  input.backends.webgpu.settle.globeCommands = 0;
  let reads = 0;
  const standing = evaluateGsplatMultifrustumFraming(input, () => {
    reads++;
    return topology;
  });
  assert.equal(standing.eligible, false);
  assert.ok(
    standing.structural.includes("webgpu:settled-tower-globe-frame-unproven"),
  );
  // True behaviour, pinned: a framing-layer structural short-circuits the lazy
  // reader, so no topology record exists and the asymmetric reason cannot
  // survive here - unlike the label-layer case in (g).
  assert.equal(reads, 0);
  assert.equal(standing.occlusionRead, false);
  const verdict = evaluateGsplatMultifrustumProbeResult(
    g6ProbeResultInput(standing),
  );
  assert.equal(verdict.status, "STRUCTURAL");
  assert.equal(verdict.exitCode, 3);
  assert.equal(verdict.topology, null);
});

test("G6 probe R-2026-08-24-16 (g) an unrelated dims mismatch outranks, and the asymmetric reason survives", () => {
  const frames = d4AsymmetricFrames(21);
  const topology = evaluateGsplatLabelTopology(frames.webgl, frames.webgpu);
  assert.equal(topology.eligible, false);
  assert.ok(topology.structural.includes("labels:frame-dimensions-mismatch"));
  assert.deepEqual(topology.failures, ["webgpu:labels:zero-splat-asymmetric"]);
  const verdict = evaluateGsplatMultifrustumProbeResult(
    g6ProbeResultInput(standingWithTopology(topology)),
  );
  assert.equal(verdict.status, "STRUCTURAL");
  assert.equal(verdict.exitCode, 3);
  assert.ok(
    verdict.topology.failures.includes("webgpu:labels:zero-splat-asymmetric"),
  );
});

test("G6 probe R-2026-08-24-16 (h) mutant caught: inertness restores the old precedence", () => {
  const source = g6ProbeSource();
  const mutated = mustReplaceOne(
    source,
    "      backend === asymmetricZeroSplatBackend",
    "      false && backend === asymmetricZeroSplatBackend",
    "R-2026-08-24-16 precedence inertness",
  );
  const canonicalModel = compileG6NodeModel(source);
  const mutantModel = compileG6NodeModel(mutated);
  const frames = d4AsymmetricFrames();
  const canonical = canonicalModel.evaluateGsplatLabelTopology(
    frames.webgl,
    frames.webgpu,
  );
  const mutation = mutantModel.evaluateGsplatLabelTopology(
    frames.webgl,
    frames.webgpu,
  );
  assert.equal(canonical.eligible, true);
  assert.equal(mutation.eligible, false);
  assert.ok(mutation.structural.includes("webgpu:labels:zero-globe"));
  assert.deepEqual(mutation.suppressedStructural, []);
});

test("G6 probe S5 library-fixture G-1 standing and per-band counters cannot be replaced by perfect pixels", () => {
  const perfectPixels = evaluateGsplatLabelTopology(
    ...Object.values(decidableTopologyFrames()),
  );
  assert.equal(perfectPixels.eligible, true);
  const counterCases = [
    {
      name: "activeFrusta",
      mutate(input) {
        input.backends.webgpu.clean.bands = [
          input.backends.webgpu.clean.bands[0],
        ];
      },
      reason: "webgpu:active-frusta:1-below-2",
    },
    {
      name: "clean.bands[*].splatIndex",
      mutate(input) {
        for (const band of input.backends.webgpu.clean.bands) {
          band.splatIndex = 0;
        }
      },
      reason: "webgpu:bounded-splat:not-selectively-binned",
    },
    {
      name: "clean.bands[*].globeIndex",
      mutate(input) {
        for (const band of input.backends.webgpu.clean.bands) {
          if (band.splatIndex > 0) band.globeIndex = 0;
        }
      },
      reason: "webgpu:clean:no-shared-globe-splat-band",
    },
  ];
  for (const counterCase of counterCases) {
    const input = framingInput();
    counterCase.mutate(input);
    let reads = 0;
    const standing = evaluateGsplatMultifrustumFraming(input, () => {
      reads++;
      return perfectPixels;
    });
    assert.equal(reads, 0, `${counterCase.name} must precede pixel work`);
    assert.equal(standing.eligible, false, counterCase.name);
    assert.equal(standing.occlusion, null, counterCase.name);
    assert.ok(
      standing.structural.includes(counterCase.reason),
      `${counterCase.name} must remain load-bearing`,
    );
  }
});

test("G6 probe S6 zero splat labels are structural with a dedicated reason", () => {
  const frames = twoLabelFrames("background", "globe");
  const topology = evaluateGsplatLabelTopology(frames.webgl, frames.webgpu);
  assert.equal(topology.eligible, false);
  assert.ok(topology.structural.includes("webgl:labels:zero-splat"));
  assert.ok(topology.structural.includes("webgpu:labels:zero-splat"));
  const result = evaluateGsplatMultifrustumProbeResult(
    g6ProbeResultInput(standingWithTopology(topology)),
  );
  assert.equal(result.status, "STRUCTURAL");
  assert.equal(result.exitCode, exitCodeForS5Status("STRUCTURAL"));
  assert.ok(result.structural.includes("webgl:labels:zero-splat"));
});

test("G6 probe S6 zero globe labels are structural with a dedicated reason", () => {
  const frames = twoLabelFrames("background", "splat");
  const topology = evaluateGsplatLabelTopology(frames.webgl, frames.webgpu);
  assert.equal(topology.eligible, false);
  assert.ok(topology.structural.includes("webgl:labels:zero-globe"));
  assert.ok(topology.structural.includes("webgpu:labels:zero-globe"));
  const result = evaluateGsplatMultifrustumProbeResult(
    g6ProbeResultInput(standingWithTopology(topology)),
  );
  assert.equal(result.status, "STRUCTURAL");
  assert.equal(result.exitCode, exitCodeForS5Status("STRUCTURAL"));
  assert.ok(result.structural.includes("webgl:labels:zero-globe"));
});

test("G6 probe S6 an entirely single-label frame is structural with its own reason", () => {
  const frame = rgbaLabelFrame(20, 20, () => "background");
  const topology = evaluateGsplatLabelTopology(frame, cloneFrame(frame));
  assert.equal(topology.eligible, false);
  assert.ok(topology.structural.includes("webgl:labels:single-label-frame"));
  assert.ok(topology.structural.includes("webgpu:labels:single-label-frame"));
  const result = evaluateGsplatMultifrustumProbeResult(
    g6ProbeResultInput(standingWithTopology(topology)),
  );
  assert.equal(result.status, "STRUCTURAL");
  assert.equal(result.exitCode, exitCodeForS5Status("STRUCTURAL"));
  assert.ok(result.structural.includes("webgl:labels:single-label-frame"));
});

test("G6 probe S6 mismatched backend dimensions are structural with a dedicated reason", () => {
  const webgl = decidableTopologyFrames(0, 20, 20).webgl;
  const webgpu = decidableTopologyFrames(0, 21, 20).webgpu;
  const topology = evaluateGsplatLabelTopology(webgl, webgpu);
  assert.equal(topology.eligible, false);
  assert.ok(topology.structural.includes("labels:frame-dimensions-mismatch"));
  const result = evaluateGsplatMultifrustumProbeResult(
    g6ProbeResultInput(standingWithTopology(topology)),
  );
  assert.equal(result.status, "STRUCTURAL");
  assert.equal(result.exitCode, exitCodeForS5Status("STRUCTURAL"));
  assert.ok(result.structural.includes("labels:frame-dimensions-mismatch"));
});

test("G6 probe S7 bar has one source representation and publishes registered plus actual geometry", () => {
  const source = g6ProbeSource();
  assert.equal(occurrences(source, String(MAX_LABEL_DISAGREEMENT_FRACTION)), 1);
  const registration = deriveGsplatTopologyRegistration(1280, 720);
  assert.equal(
    registration.registeredRationale.projectedRadiusPixels /
      registration.actualProjection.projectedRadiusPixels,
    2,
  );
  assert.equal(
    registration.registeredRationale.derivedPerimeterFraction /
      registration.actualProjection.derivedPerimeterFraction,
    2,
  );
  assert.equal(
    registration.maximumLabelDisagreementFraction,
    MAX_LABEL_DISAGREEMENT_FRACTION,
  );
  assert.equal(registration.actualProjection.projectedRadiusPixels, 36);
  assert.equal(registration.registeredRationale.projectedRadiusPixels, 72);
  assert.ok(
    Math.abs(registration.barToActualPerimeterRatio - 10.1859163579) < 1e-10,
  );
  assert.ok(
    Math.abs(registration.actualFootprintToBarRatio - 1.76714586764) < 1e-10,
  );
  assert.match(
    registration.registeredRationale.geometry,
    /^Recorded erratum:/u,
  );
  assert.match(source, /corrected analytic disc is/u);
  assert.match(
    source,
    /0\.4418% of the canvas and its one-pixel perimeter is 0\.0245%/u,
  );
  assert.match(
    source,
    /Recorded erratum:[\s\S]*1\.7672% disc and a 0\.0491% one-pixel perimeter/u,
  );
  assert.match(source, /10\.185916 times the/u);
  assert.match(source, /corrected one-pixel perimeter/u);
  assert.match(source, /1\.767146 times the bar/u);
  assert.match(source, /reaching two active frusta is nearly/u);
  assert.match(source, /free: almost any far camera over a globe splits/u);
  assert.match(source, /bounded-splat:not-selectively-binned/u);
  assert.match(source, /clean:no-shared-globe-splat-band/u);
  assert.match(source, /negative:splat-not-in-every-band/u);
  assert.match(source, /negative:no-splat-only-band/u);
});

test("G6 probe S7 widening the single bar turns a required FAIL into PASS", () => {
  const source = g6ProbeSource();
  const literal = String(MAX_LABEL_DISAGREEMENT_FRACTION);
  const widened = String(MAX_LABEL_DISAGREEMENT_FRACTION * 4);
  const mutatedSource = mustReplaceOne(
    source,
    `export const MAX_LABEL_DISAGREEMENT_FRACTION = ${literal};`,
    `export const MAX_LABEL_DISAGREEMENT_FRACTION = ${widened};`,
    "G6 disagreement bar widening",
  );
  const canonicalModel = compileG6NodeModel(source);
  const widenedModel = compileG6NodeModel(mutatedSource);
  const totalPixels = 20 * 20;
  const disagreements =
    Math.ceil(totalPixels * MAX_LABEL_DISAGREEMENT_FRACTION) + 1;
  const frames = decidableTopologyFrames(disagreements);
  const canonicalTopology = canonicalModel.evaluateGsplatLabelTopology(
    frames.webgl,
    frames.webgpu,
  );
  const widenedTopology = widenedModel.evaluateGsplatLabelTopology(
    frames.webgl,
    frames.webgpu,
  );
  const canonical = canonicalModel.evaluateGsplatMultifrustumProbeResult(
    g6ProbeResultInput(standingWithTopology(canonicalTopology)),
  );
  const mutation = widenedModel.evaluateGsplatMultifrustumProbeResult(
    g6ProbeResultInput(standingWithTopology(widenedTopology)),
  );
  assert.equal(canonical.status, "FAIL");
  assert.equal(mutation.status, "PASS");
});

test("G6 probe S8 maps every tier through the shared exit table", () => {
  const passTopology = evaluateGsplatLabelTopology(
    ...Object.values(decidableTopologyFrames()),
  );
  const failTopology = evaluateGsplatLabelTopology(
    ...Object.values(decidableTopologyFrames(2)),
  );
  const cases = [
    evaluateGsplatMultifrustumProbeResult(
      g6ProbeResultInput(standingWithTopology(passTopology)),
    ),
    evaluateGsplatMultifrustumProbeResult(
      g6ProbeResultInput(standingWithTopology(failTopology)),
    ),
    evaluateGsplatMultifrustumProbeResult(
      g6ProbeResultInput({
        eligible: false,
        structural: ["webgpu:active-frusta:1-below-2"],
        occlusion: null,
      }),
    ),
    evaluateGsplatMultifrustumProbeResult(
      g6ProbeResultInput(null, { harnessErrors: ["synthetic harness error"] }),
    ),
  ];
  assert.deepEqual(
    cases.map(({ status, exitCode }) => [status, exitCode]),
    [
      ["PASS", 0],
      ["FAIL", 1],
      ["STRUCTURAL", 3],
      ["ERROR", 2],
    ],
  );
  for (const { status, exitCode } of cases) {
    assert.equal(exitCode, exitCodeForS5Status(status));
  }
  assert.equal(exitCodeForS5Status("PASS"), 0);
  assert.equal(exitCodeForS5Status("FAIL"), 1);
  assert.equal(exitCodeForS5Status("ERROR"), 2);
  assert.equal(exitCodeForS5Status("STRUCTURAL"), 3);
  const analysis = analyzeProbeSource(g6ProbeSource());
  assert.deepEqual(analysis.structuralRoutedToTwo, []);
  assert.deepEqual(analysis.verdictExitViolations, []);
  assert.deepEqual(analysis.violations, []);
  const captureStructural = evaluateGsplatMultifrustumProbeResult(
    g6ProbeResultInput(standingWithTopology(passTopology), {
      captureContract: { failures: ["capture-contract:synthetic"] },
    }),
  );
  assert.equal(captureStructural.status, "STRUCTURAL");
  assert.equal(captureStructural.exitCode, exitCodeForS5Status("STRUCTURAL"));
  assert.deepEqual(captureStructural.structural, [
    "capture-contract:synthetic",
  ]);
});

// G-1 coverage is embedded-settle-predicate fidelity plus library-fixture
// standing: these mutants pin page readiness, while S5's one-frustum library
// fixture is the actual row G-1 standing proof.
const g6EmbeddedSettlePredicateMutants = [
  {
    name: "deletion removes the embedded-settle active-frustum predicate",
    needle: "latest.activeFrusta >= 2 &&",
    replacement: "",
    activeFrusta: 1,
    caughtBy: "one-band settle.ready differs from the canonical false result",
  },
  {
    name: "inversion lets embedded settle accept fewer than two frusta",
    needle: "latest.activeFrusta >= 2 &&",
    replacement: "latest.activeFrusta < 2 &&",
    activeFrusta: 1,
    caughtBy: "one-band settle.ready differs from the canonical false result",
  },
  {
    name: "boundary makes embedded settle reject exactly two frusta",
    needle: "latest.activeFrusta >= 2 &&",
    replacement: "latest.activeFrusta > 2 &&",
    activeFrusta: 2,
    caughtBy: "exactly-two settle.ready differs from the canonical true result",
  },
  {
    name: "inertness makes the embedded-settle predicate unreachable",
    needle: "latest.activeFrusta >= 2 &&",
    replacement: "false && latest.activeFrusta >= 2 &&",
    activeFrusta: 2,
    caughtBy: "exactly-two settle.ready differs from the canonical true result",
  },
];

for (const mutant of g6EmbeddedSettlePredicateMutants) {
  test(`G6 probe embedded-settle-predicate fidelity plus library-fixture standing mutant caught: ${mutant.name}`, async () => {
    const source = g6ProbeSource();
    const mutated = mustReplaceOne(
      source,
      mutant.needle,
      mutant.replacement,
      `embedded settle predicate ${mutant.name}`,
    );
    const canonical = await runExtractedSettler(
      compileG6PageInstrument(source).settle,
      mutant.activeFrusta,
      10,
    );
    const mutation = await runExtractedSettler(
      compileG6PageInstrument(mutated).settle,
      mutant.activeFrusta,
      10,
    );
    assert.notEqual(mutation.ready, canonical.ready, mutant.caughtBy);
  });
}

const g6G2Mutants = [
  {
    name: "deletion removes the zero-splat reason",
    needle: "structural.push(`${backend}:labels:zero-splat`);",
    replacement: "void summary.counts.splat;",
    fixture: () => twoLabelFrames("background", "globe"),
    caughtBy: "zero-splat fixture loses its required structural standing",
  },
  {
    name: "inversion rejects positive splat occupancy",
    needle: "summary.counts.splat === 0",
    replacement: "summary.counts.splat > 0",
    fixture: () => decidableTopologyFrames(),
    caughtBy: "decidable splat fixture changes eligibility",
  },
  {
    name: "boundary makes zero occupancy unreachable",
    needle: "summary.counts.splat === 0",
    replacement: "summary.counts.splat < 0",
    fixture: () => twoLabelFrames("background", "globe"),
    caughtBy: "zero-splat fixture changes eligibility",
  },
  {
    name: "inertness makes the zero-splat guard unreachable",
    needle:
      "if (summary.counts.splat === 0 && asymmetricZeroSplatBackend === null) {",
    replacement:
      "if (false && summary.counts.splat === 0 && asymmetricZeroSplatBackend === null) {",
    fixture: () => twoLabelFrames("background", "globe"),
    caughtBy: "zero-splat fixture changes eligibility",
  },
];

for (const mutant of g6G2Mutants) {
  test(`G6 probe G-2 mutant caught: ${mutant.name}`, () => {
    const source = g6ProbeSource();
    const mutated = mustReplaceOne(
      source,
      mutant.needle,
      mutant.replacement,
      `G-2 ${mutant.name}`,
    );
    const canonicalModel = compileG6NodeModel(source);
    const mutantModel = compileG6NodeModel(mutated);
    const frames = mutant.fixture();
    const canonical = canonicalModel.evaluateGsplatLabelTopology(
      frames.webgl,
      frames.webgpu,
    );
    const mutation = mutantModel.evaluateGsplatLabelTopology(
      frames.webgl,
      frames.webgpu,
    );
    assert.notEqual(mutation.eligible, canonical.eligible, mutant.caughtBy);
  });
}

const g6G3Mutants = [
  {
    name: "deletion removes the disagreement failure",
    needle:
      'failures.push("G-3:backend-label-topology-disagreement-above-bar");',
    replacement: "void topology.g3.passes;",
    disagreement: "above",
    caughtBy: "above-bar fixture changes FAIL to PASS",
  },
  {
    name: "inversion rewards disagreement above the bar",
    needle: "disagreementFraction <= MAX_LABEL_DISAGREEMENT_FRACTION",
    replacement: "disagreementFraction > MAX_LABEL_DISAGREEMENT_FRACTION",
    disagreement: "zero",
    caughtBy: "zero-disagreement fixture changes PASS to FAIL",
  },
  {
    name: "boundary excludes exact equality",
    needle: "disagreementFraction <= MAX_LABEL_DISAGREEMENT_FRACTION",
    replacement: "disagreementFraction < MAX_LABEL_DISAGREEMENT_FRACTION",
    disagreement: "exact",
    caughtBy: "exact-bar fixture changes PASS to FAIL",
  },
  {
    name: "inertness makes the disagreement failure unreachable",
    needle: "if (topology.g3.passes !== true) {",
    replacement: "if (false && topology.g3.passes !== true) {",
    disagreement: "above",
    caughtBy: "above-bar fixture changes FAIL to PASS",
  },
];

for (const mutant of g6G3Mutants) {
  test(`G6 probe G-3 mutant caught: ${mutant.name}`, () => {
    const source = g6ProbeSource();
    const mutated = mustReplaceOne(
      source,
      mutant.needle,
      mutant.replacement,
      `G-3 ${mutant.name}`,
    );
    const canonicalModel = compileG6NodeModel(source);
    const mutantModel = compileG6NodeModel(mutated);
    const totalPixels = 20 * 20;
    const exact = Math.round(totalPixels * MAX_LABEL_DISAGREEMENT_FRACTION);
    const disagreementPixels =
      mutant.disagreement === "zero"
        ? 0
        : mutant.disagreement === "exact"
          ? exact
          : exact + 1;
    const frames = decidableTopologyFrames(disagreementPixels);
    const canonicalTopology = canonicalModel.evaluateGsplatLabelTopology(
      frames.webgl,
      frames.webgpu,
    );
    const mutantTopology = mutantModel.evaluateGsplatLabelTopology(
      frames.webgl,
      frames.webgpu,
    );
    const canonical = canonicalModel.evaluateGsplatMultifrustumProbeResult(
      g6ProbeResultInput(standingWithTopology(canonicalTopology)),
    );
    const mutation = mutantModel.evaluateGsplatMultifrustumProbeResult(
      g6ProbeResultInput(standingWithTopology(mutantTopology)),
    );
    assert.notEqual(mutation.status, canonical.status, mutant.caughtBy);
  });
}

const g6G4Mutants = [
  {
    name: "deletion removes BV suppression",
    needle: "command.boundingVolume = undefined;",
    replacement: "void command;",
    caughtBy: "control.ok and every-band suppressed counters differ",
  },
  {
    name: "inversion counts defined BVs instead of suppressed BVs",
    needle: "command.boundingVolume === undefined",
    replacement: "command.boundingVolume !== undefined",
    caughtBy: "suppressionAppliedCount no longer establishes G-4",
  },
  {
    name: "boundary rejects the one-command control",
    needle: "commands.length < 1",
    replacement: "commands.length <= 1",
    caughtBy: "one-command fixture is wrongly declared commandless",
  },
  {
    name: "inertness makes BV suppression unreachable",
    needle: "command.boundingVolume = undefined;",
    replacement:
      "if (false && (command.boundingVolume = undefined)) void command;",
    caughtBy: "control.ok and every-band suppressed counters differ",
  },
];

for (const mutant of g6G4Mutants) {
  test(`G6 probe G-4 mutant caught: ${mutant.name}`, () => {
    const source = g6ProbeSource();
    const mutated = mustReplaceOne(
      source,
      mutant.needle,
      mutant.replacement,
      `G-4 ${mutant.name}`,
    );
    const canonicalFixture = boundingControlFixture();
    const mutantFixture = boundingControlFixture();
    const canonical = compileG6PageInstrument(source).acquire(
      canonicalFixture.scene,
      FRUSTUM_PASS.GLOBE,
      FRUSTUM_PASS.GAUSSIAN_SPLATS,
    );
    const mutation = compileG6PageInstrument(mutated).acquire(
      mutantFixture.scene,
      FRUSTUM_PASS.GLOBE,
      FRUSTUM_PASS.GAUSSIAN_SPLATS,
    );
    assert.equal(canonical.ok, true);
    assert.equal(
      canonical.suppressed.bands.every((band) => band.splatIndex > 0),
      true,
    );
    assert.notEqual(mutation.ok, canonical.ok, mutant.caughtBy);
  });
}

test("G6 probe framing-record disagreement is structural before standing or pixels", () => {
  const input = framingInput();
  const records = matchingBackendRecords(input);
  records.webgpu.framing.range = input.framing.range + 1;
  const agreement = compareGsplatBackendFraming(records);
  assert.equal(agreement.agree, false);
  assert.deepEqual(agreement.structural, [
    "framing:backend-record-disagreement:range",
  ]);
  const result = evaluateGsplatMultifrustumProbeResult(
    g6ProbeResultInput(null, { framingAgreement: agreement }),
  );
  assert.equal(result.status, "STRUCTURAL");
  assert.deepEqual(result.structural, agreement.structural);
});

test("G6 probe backend identity and WebGPU error-gate standing are structural", () => {
  const input = framingInput();
  const records = matchingBackendRecords(input);
  records.webgl.runtime.rendererType = "webgpu";
  records.webgpu.runtime.gpuGateArmedDevices = 0;
  const agreement = compareGsplatBackendFraming(records);
  assert.equal(agreement.agree, false);
  assert.ok(
    agreement.structural.includes("webgl:runtime:backend-identity-unproven"),
  );
  assert.ok(agreement.structural.includes("webgpu:runtime:error-gate-unarmed"));
});

test("G6 probe F3 live scene reference colours are mandatory per backend", () => {
  const readLiveColorRgb = compileG6LiveColorReader(g6ProbeSource());
  let readCount = 0;
  assert.deepEqual(
    readLiveColorRgb({
      toBytes() {
        readCount++;
        return [1, 2, 3, 255];
      },
    }),
    [1, 2, 3],
  );
  assert.equal(readCount, 1);
  assert.equal(readLiveColorRgb({ toBytes: () => [1, 2.5, 3, 255] }), null);
  assert.equal(
    readLiveColorRgb({
      toBytes() {
        throw new Error("synthetic colour read failure");
      },
    }),
    null,
  );
  const cases = [
    {
      backend: "webgl",
      field: "backgroundColorRgb",
      reason: "webgl:runtime:background-rgb-mismatch",
    },
    {
      backend: "webgpu",
      field: "backgroundColorRgb",
      reason: "webgpu:runtime:background-rgb-mismatch",
    },
    {
      backend: "webgl",
      field: "globeBaseColorRgb",
      reason: "webgl:runtime:globe-base-rgb-mismatch",
    },
    {
      backend: "webgpu",
      field: "globeBaseColorRgb",
      reason: "webgpu:runtime:globe-base-rgb-mismatch",
    },
  ];
  for (const fixture of cases) {
    const records = matchingBackendRecords();
    records[fixture.backend].runtime[fixture.field][0]++;
    const agreement = compareGsplatBackendFraming(records);
    assert.equal(agreement.agree, false, fixture.reason);
    assert.ok(agreement.structural.includes(fixture.reason), fixture.reason);
    const result = evaluateGsplatMultifrustumProbeResult(
      g6ProbeResultInput(null, { framingAgreement: agreement }),
    );
    assert.equal(result.status, "STRUCTURAL", fixture.reason);
    assert.equal(
      result.exitCode,
      exitCodeForS5Status("STRUCTURAL"),
      fixture.reason,
    );
    assert.ok(result.structural.includes(fixture.reason), fixture.reason);
  }
});

test("G6 probe F3 decoded corner reference is inclusive at tolerance and structural above it", () => {
  const reference = deriveGsplatTopologyRegistration(20, 20).labelPartition;
  const boundaryFrames = decidableTopologyFrames();
  boundaryFrames.webgl.data[0] =
    reference.backgroundRgb[0] + reference.referenceColorTolerance;
  const boundary = evaluateGsplatLabelTopology(
    boundaryFrames.webgl,
    boundaryFrames.webgpu,
  );
  assert.equal(boundary.eligible, true);
  assert.equal(
    boundary.summaries.webgl.corner.backgroundMaximumChannelDelta,
    reference.referenceColorTolerance,
  );
  assert.equal(boundary.summaries.webgl.corner.withinBackgroundTolerance, true);

  for (const backend of ["webgl", "webgpu"]) {
    const frames = decidableTopologyFrames();
    frames[backend].data[0] =
      reference.backgroundRgb[0] + reference.referenceColorTolerance + 1;
    const topology = evaluateGsplatLabelTopology(frames.webgl, frames.webgpu);
    const reason = `${backend}:labels:corner-background-mismatch`;
    assert.equal(topology.eligible, false, reason);
    assert.ok(topology.structural.includes(reason), reason);
    const result = evaluateGsplatMultifrustumProbeResult(
      g6ProbeResultInput(standingWithTopology(topology)),
    );
    assert.equal(result.status, "STRUCTURAL", reason);
    assert.equal(result.exitCode, exitCodeForS5Status("STRUCTURAL"), reason);
    assert.ok(result.structural.includes(reason), reason);
  }
});

test("G6 probe F3 corner sampling stays lazy when library G-1 standing fails", () => {
  const input = framingInput();
  input.backends.webgpu.clean.bands = [input.backends.webgpu.clean.bands[0]];
  let reads = 0;
  const standing = evaluateGsplatMultifrustumFraming(input, () => {
    reads++;
    const frames = decidableTopologyFrames();
    frames.webgl.data[0] = 255;
    return evaluateGsplatLabelTopology(frames.webgl, frames.webgpu);
  });
  assert.equal(reads, 0);
  assert.equal(standing.eligible, false);
  assert.ok(standing.structural.includes("webgpu:active-frusta:1-below-2"));
  assert.equal(
    standing.structural.some((reason) => reason.includes("corner-background")),
    false,
  );
});

test("G6 probe partition labels only the two reference colours as background/globe", () => {
  const frame = rgbaLabelFrame(
    3,
    1,
    (pixel) => ["background", "globe", "splat"][pixel],
  );
  const partition = partitionGsplatTopologyFrame(frame, "synthetic");
  assert.equal(partition.valid, true);
  assert.deepEqual(partition.counts, {
    background: 1,
    globe: 1,
    splat: 1,
  });
});

function asymmetricCornerMismatchFrames() {
  const frames = d4AsymmetricFrames();
  // The corner leaves background tolerance while the backend still composes no
  // splat pixel: painting it the globe reference is the only shape in which the
  // corner precondition and the asymmetric FAIL compete for precedence.
  const globeRgb = deriveGsplatTopologyRegistration(20, 20).labelPartition
    .globeRgb;
  frames.webgpu.data[0] = globeRgb[0];
  frames.webgpu.data[1] = globeRgb[1];
  frames.webgpu.data[2] = globeRgb[2];
  return frames;
}

test("G6 probe R-2026-08-24-16 (i) a corner-precondition mismatch on the zero-splat backend outranks the asymmetric FAIL", () => {
  const frames = asymmetricCornerMismatchFrames();
  const topology = evaluateGsplatLabelTopology(frames.webgl, frames.webgpu);
  assert.equal(topology.summaries.webgpu.counts.splat, 0);
  assert.equal(topology.eligible, false);
  assert.deepEqual(topology.structural, [
    "webgpu:labels:corner-background-mismatch",
  ]);
  // Unrelated blindness must never reach the consequence sink.
  assert.deepEqual(topology.suppressedStructural, []);
  assert.deepEqual(topology.failures, ["webgpu:labels:zero-splat-asymmetric"]);
  const verdict = evaluateGsplatMultifrustumProbeResult(
    g6ProbeResultInput(standingWithTopology(topology)),
  );
  assert.equal(verdict.status, "STRUCTURAL");
  assert.equal(verdict.exitCode, 3);
  assert.deepEqual(verdict.structural, [
    "webgpu:labels:corner-background-mismatch",
  ]);
  assert.ok(
    verdict.topology.failures.includes("webgpu:labels:zero-splat-asymmetric"),
  );
});

test("G6 probe R-2026-08-24-16 (j) mutant caught: the corner precondition routed into the consequence sink", () => {
  const source = g6ProbeSource();
  const mutated = mustReplaceOne(
    source,
    "      structural.push(`${backend}:labels:corner-background-mismatch`);",
    "      consequenceSink.push(`${backend}:labels:corner-background-mismatch`);",
    "R-2026-08-24-16 corner precondition demoted to a consequence",
  );
  const canonicalModel = compileG6NodeModel(source);
  const mutantModel = compileG6NodeModel(mutated);
  const frames = asymmetricCornerMismatchFrames();
  const canonical = canonicalModel.evaluateGsplatLabelTopology(
    frames.webgl,
    frames.webgpu,
  );
  const mutation = mutantModel.evaluateGsplatLabelTopology(
    frames.webgl,
    frames.webgpu,
  );
  assert.equal(canonical.eligible, false);
  assert.equal(mutation.eligible, true);
  assert.deepEqual(mutation.suppressedStructural, [
    "webgpu:labels:corner-background-mismatch",
  ]);
  const required = canonicalModel.evaluateGsplatMultifrustumProbeResult(
    g6ProbeResultInput(standingWithTopology(canonical)),
  );
  const produced = mutantModel.evaluateGsplatMultifrustumProbeResult(
    g6ProbeResultInput(standingWithTopology(mutation)),
  );
  assert.equal(required.exitCode, 3);
  assert.equal(produced.exitCode, 1);
});

test("G6 probe R-2026-08-24-16 (k) a demoted run still publishes the consequence reasons, and only as diagnostics", () => {
  const frames = d4AsymmetricFrames(21);
  const topology = evaluateGsplatLabelTopology(frames.webgl, frames.webgpu);
  const verdict = evaluateGsplatMultifrustumProbeResult(
    g6ProbeResultInput(standingWithTopology(topology)),
  );
  // The consequence reasons are neither lost from the artifact nor promoted
  // into the top-level structural list.
  assert.deepEqual(verdict.structural, ["labels:frame-dimensions-mismatch"]);
  assert.deepEqual(verdict.topology.suppressedStructural, [
    "webgpu:labels:zero-globe",
    "webgpu:labels:single-label-frame",
  ]);
});
