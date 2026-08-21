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
} from "./lib/gsplat-multifrustum-framing.mjs";
import {
  FUSED_SNAPSHOT_BEGIN,
  FUSED_SNAPSHOT_END,
  checkEmbeddedFusedSnapshotIsCanonical,
  checkFusedCaptureUsage,
} from "./lib/same-task-capture.mjs";
import { analyzeProbeSource } from "./lib/probe-fleet-contract.mjs";
import { analyzeProhibitedReader } from "./lib/prohibited-reader-rule.mjs";

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
