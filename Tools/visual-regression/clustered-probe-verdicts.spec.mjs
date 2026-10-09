// clustered-probe-verdicts.spec.mjs — the clustered family's verdicts, shape and promoted label gate.
//
// @purpose Drives every migrated clustered-lighting probe's exported verdict function one step inside and one step outside each bar the pre-harvest probe applied, pins the family's runtime shape and rig transcriptions, refuses a WebGL-only run before any browser work, and runs the zero-work gate's clustered-label inventory over the real engine sources as a standing Node gate.
// @status ACTIVE
//
// WHAT "ONE STEP EACH SIDE" MEANS HERE. Every pre-harvest clause is an exact
// comparison against a literal (`>= 50`, `=== 2`, `> 0`). For each one this
// spec builds a cell that sits exactly ON the passing side of the literal and
// one that sits one unit off it, and asserts the named verdict flips. A bar
// that moved, or a clause that was dropped, turns a case red.
//
// THE LABEL INVENTORY IS PROMOTED. `probe-clustered-zero-work-route.mjs` used
// to read four engine source files at run time, inside a browser run, to
// prove no clustered GPU-resource label escapes the zero-work gate's regex.
// The scan is pure; the case below runs it over the same four files under
// plain `node --test`, so a rename that escapes the gate turns this suite red
// without an Edge slot. The probe still runs the same function as one of its
// verdicts.
//
// Pure Node: no browser, no GPU. The four engine files are read by name.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { blankNonCode } from "./lib/probe-fleet-contract.mjs";
import { CLUSTER_GRID } from "./lib/metrics/cluster-light-counts.mjs";
import { ProbeRefusal } from "./lib/probe-runtime.mjs";
import { validateRig } from "./lib/rig-registry.mjs";
import * as demoScene from "./probe-clustered-demo-scene.mjs";
import * as dispatcher from "./probe-clustered-dispatcher.mjs";
import * as lightsResize from "./probe-clustered-lights-resize.mjs";
import * as litmat from "./probe-clustered-litmat.mjs";
import * as matsweep from "./probe-clustered-matsweep.mjs";
import * as multifrustum from "./probe-clustered-multifrustum.mjs";
import * as perFrame from "./probe-clustered-per-frame.mjs";
import * as phong from "./probe-clustered-phong.mjs";
import * as visible from "./probe-clustered-visible.mjs";
import * as zeroWork from "./probe-clustered-zero-work-route.mjs";
import boundsResizeRig from "./rigs/clustered-bounds-resize-synthetic.mjs";
import dispatcherRig from "./rigs/clustered-dispatcher-synthetic.mjs";
import perFrameRig from "./rigs/clustered-per-frame-pittsburgh.mjs";
import zeroWorkRig from "./rigs/clustered-zero-work-control.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..");

/** The ten probes, by file, with the rig each one reads. */
const FAMILY = Object.freeze([
  ["probe-clustered-demo-scene.mjs", demoScene, "clustered-demo-scene"],
  [
    "probe-clustered-dispatcher.mjs",
    dispatcher,
    "clustered-dispatcher-synthetic",
  ],
  [
    "probe-clustered-lights-resize.mjs",
    lightsResize,
    "clustered-bounds-resize-synthetic",
  ],
  ["probe-clustered-litmat.mjs", litmat, "clustered-litmat-box"],
  ["probe-clustered-matsweep.mjs", matsweep, "clustered-matsweep-row"],
  [
    "probe-clustered-multifrustum.mjs",
    multifrustum,
    "clustered-multifrustum-vehicle",
  ],
  ["probe-clustered-per-frame.mjs", perFrame, "clustered-per-frame-pittsburgh"],
  ["probe-clustered-phong.mjs", phong, "clustered-phong-box"],
  ["probe-clustered-visible.mjs", visible, "clustered-visible-vehicle"],
  [
    "probe-clustered-zero-work-route.mjs",
    zeroWork,
    "clustered-zero-work-control",
  ],
]);

function byId(verdicts, prefix) {
  const found = verdicts.filter((verdict) =>
    verdict.id.startsWith(`${prefix}/`),
  );
  assert.equal(found.length, 1, `exactly one verdict ${prefix}`);
  return found[0];
}

function passes(evaluate, cell, prefix) {
  return byId(evaluate([cell]), prefix).pass;
}

const CLEAN = Object.freeze({ deviceErrors: [], deviceLost: null });

// ---------------------------------------------------------------------------
// The five OFF/ON brightness probes
// ---------------------------------------------------------------------------

const OFF_ON = Object.freeze([
  ["litmat", litmat.evaluateLitmat, litmat, "primReady", "primitive-ready"],
  ["phong", phong.evaluatePhong, phong, "primReady", "primitive-ready"],
  ["visible", visible.evaluateVisible, visible, "modelReady", "model-ready"],
  [
    "multifrustum",
    multifrustum.evaluateMultifrustum,
    multifrustum,
    "modelReady",
    "model-ready",
  ],
]);

function offOnCell(module, readyKey, overrides = {}) {
  return {
    run: 0,
    [readyKey]: true,
    earlyExit: null,
    lastActive: module.MIN_ACTIVE_LIGHTS,
    n: 76800,
    changedPx: module.MIN_CHANGED_PX,
    maxDelta: 40,
    meanOff: 100,
    meanOn: 110,
    numFrustumsOff: 3,
    numFrustumsOn: 2,
    ...CLEAN,
    ...overrides,
  };
}

test("the OFF/ON probes carry the original bars: >= 1 active light, >= 50 changed px", () => {
  for (const [name, , module] of OFF_ON) {
    assert.equal(module.MIN_ACTIVE_LIGHTS, 1, name);
    assert.equal(module.MIN_CHANGED_PX, 50, name);
  }
  assert.equal(demoScene.MIN_ACTIVE_LIGHTS, 6);
  assert.equal(demoScene.MIN_CHANGED_PX, 200);
  assert.equal(multifrustum.MIN_FRUSTUMS, 2);
  assert.deepEqual(litmat.MEASURE_BOX, {
    left: 0.3,
    right: 0.7,
    top: 0.3,
    bottom: 0.7,
  });
  assert.deepEqual(phong.MEASURE_BOX, {
    left: 0.3,
    right: 0.7,
    top: 0.3,
    bottom: 0.7,
  });
  assert.deepEqual(visible.MEASURE_BOX, {
    left: 0.25,
    right: 0.75,
    top: 0.25,
    bottom: 0.75,
  });
  assert.deepEqual(multifrustum.MEASURE_BOX, {
    left: 0.3,
    right: 0.7,
    top: 0.35,
    bottom: 0.75,
  });
  assert.deepEqual(demoScene.MEASURE_BOX, {
    left: 0,
    right: 1,
    top: 0,
    bottom: 1,
  });
});

test("each OFF/ON probe flips its light and contribution verdicts one step either side of the bar", () => {
  for (const [name, evaluate, module, readyKey] of OFF_ON) {
    const on = offOnCell(module, readyKey);
    assert.ok(
      evaluate([on]).every((verdict) => verdict.pass),
      `${name}: at the bars`,
    );
    assert.equal(
      passes(
        evaluate,
        offOnCell(module, readyKey, { lastActive: 0 }),
        "clustered-light-active",
      ),
      false,
      `${name}: 0 active lights`,
    );
    assert.equal(
      passes(
        evaluate,
        offOnCell(module, readyKey, { changedPx: 49 }),
        "visible-contribution",
      ),
      false,
      `${name}: 49 changed px`,
    );
    assert.equal(
      passes(
        evaluate,
        offOnCell(module, readyKey, { deviceErrors: ["x"] }),
        "device-errors",
      ),
      false,
      `${name}: one device error`,
    );
    assert.equal(
      passes(
        evaluate,
        offOnCell(module, readyKey, {
          deviceLost: "device lost: reason=unknown",
        }),
        "device-not-lost",
      ),
      false,
      `${name}: device lost`,
    );
  }
});

test("an OFF/ON probe whose subject never became ready fails readiness and every measured clause", () => {
  for (const [name, evaluate, module, readyKey, readyId] of OFF_ON) {
    const cell = offOnCell(module, readyKey, {
      [readyKey]: false,
      earlyExit: "not ready",
      lastActive: undefined,
      changedPx: undefined,
    });
    const verdicts = evaluate([cell]);
    assert.equal(byId(verdicts, readyId).pass, false, name);
    assert.equal(byId(verdicts, "clustered-light-active").pass, false, name);
    assert.equal(byId(verdicts, "visible-contribution").pass, false, name);
    assert.match(byId(verdicts, "visible-contribution").claim, /not measured/);
  }
});

test("multifrustum needs the larger frustum count to reach 2", () => {
  const evaluate = multifrustum.evaluateMultifrustum;
  const cell = (off, on) =>
    offOnCell(multifrustum, "modelReady", {
      numFrustumsOff: off,
      numFrustumsOn: on,
    });
  assert.equal(passes(evaluate, cell(1, 2), "multi-frustum"), true);
  assert.equal(passes(evaluate, cell(2, 1), "multi-frustum"), true);
  assert.equal(passes(evaluate, cell(1, 1), "multi-frustum"), false);
  assert.equal(passes(evaluate, cell(null, null), "multi-frustum"), false);
});

test("demo-scene: >= 6 active lights and >= 200 changed px over the whole frame", () => {
  const evaluate = demoScene.evaluateDemoScene;
  const cell = (overrides = {}) => ({
    run: 0,
    sceneLightCount: 6,
    lastActive: 6,
    n: 700000,
    changedPx: 200,
    maxDelta: 30,
    meanOff: 100,
    meanOn: 120,
    ...CLEAN,
    ...overrides,
  });
  assert.ok(evaluate([cell()]).every((verdict) => verdict.pass));
  assert.equal(
    passes(evaluate, cell({ lastActive: 5 }), "clustered-lights-active"),
    false,
  );
  assert.equal(
    passes(evaluate, cell({ changedPx: 199 }), "visible-contribution"),
    false,
  );
  assert.equal(
    passes(evaluate, cell({ deviceErrors: ["x"] }), "device-errors"),
    false,
  );
});

test("matsweep: >= 1 active light and no device error; a construct failure is recorded, not a bar", () => {
  const evaluate = matsweep.evaluateMatsweep;
  const cell = (overrides = {}) => ({
    run: 0,
    materials: ["Color", "Grid"],
    lastActive: 1,
    perType: { Grid: "material-construct-failed: x" },
    ...CLEAN,
    ...overrides,
  });
  assert.ok(evaluate([cell()]).every((verdict) => verdict.pass));
  assert.equal(
    passes(evaluate, cell({ lastActive: 0 }), "clustered-light-active"),
    false,
  );
  assert.equal(
    passes(evaluate, cell({ deviceErrors: ["x"] }), "device-errors"),
    false,
  );
});

// ---------------------------------------------------------------------------
// The three readback probes
// ---------------------------------------------------------------------------

function dispatcherCell(overrides = {}) {
  return {
    run: 0,
    earlyExit: null,
    initialToggle: false,
    afterSetToggle: true,
    afterUnsetToggle: false,
    c1: 0,
    c2: 2,
    c3: 2,
    c4: 0,
    counts: {
      cells: CLUSTER_GRID.cells,
      total: CLUSTER_GRID.cells,
      occupied: 3456,
      max: 2,
    },
    paramsEnabledActiveLightCount: 2,
    paramsDisabledActiveLightCount: 0,
    ...CLEAN,
    ...overrides,
  };
}

test("dispatcher: every clause holds at the original's exact values and flips one step off", () => {
  const evaluate = dispatcher.evaluateDispatcher;
  assert.ok(evaluate([dispatcherCell()]).every((verdict) => verdict.pass));
  const flips = [
    [{ initialToggle: true }, "toggle-initially-off"],
    [{ afterSetToggle: false }, "toggle-accepts-true"],
    [{ c1: 1 }, "disabled-dispatch"],
    [{ c2: 1 }, "enabled-dispatch"],
    [{ c3: 1 }, "repeat-dispatch-stays-active"],
    [{ c4: 1 }, "redisabled-dispatch"],
    [
      {
        counts: {
          cells: CLUSTER_GRID.cells,
          total: CLUSTER_GRID.cells - 1,
          occupied: 3455,
          max: 1,
        },
      },
      "directional-reaches-every-cluster",
    ],
    [{ counts: null }, "directional-reaches-every-cluster"],
    [{ paramsEnabledActiveLightCount: 1 }, "params-enabled-count"],
    [{ paramsDisabledActiveLightCount: 2 }, "params-disabled-count"],
    [{ deviceErrors: ["x"] }, "device-errors"],
  ];
  for (const [overrides, id] of flips) {
    assert.equal(passes(evaluate, dispatcherCell(overrides), id), false, id);
  }
  const missing = evaluate([
    dispatcherCell({ earlyExit: "dispatcher missing" }),
  ]);
  assert.equal(byId(missing, "dispatcher-exported").pass, false);
  assert.equal(byId(missing, "enabled-dispatch").pass, false);
});

function resizeCell(overrides = {}) {
  return {
    run: 0,
    earlyExit: null,
    aActive: 1,
    bActive: 1,
    a: { cells: 3456, total: 40, occupied: 40, max: 1 },
    b: { cells: 3456, total: 12, occupied: 12, max: 1 },
    diffCells: 1,
    b2DiffCells: 0,
    ...CLEAN,
    ...overrides,
  };
}

test("lights-resize: bins differ after a bounds-only change and not after a repeat", () => {
  const evaluate = lightsResize.evaluateLightsResize;
  assert.ok(evaluate([resizeCell()]).every((verdict) => verdict.pass));
  const flips = [
    [{ aActive: 2 }, "one-active-light"],
    [{ bActive: 0 }, "one-active-light"],
    [
      { a: { cells: 3456, total: 0, occupied: 0, max: 0 } },
      "light-occupies-clusters",
    ],
    [
      { b: { cells: 3456, total: 0, occupied: 0, max: 0 } },
      "light-occupies-clusters",
    ],
    [{ diffCells: 0 }, "bins-recompute-on-bounds-change"],
    [{ b2DiffCells: 1 }, "repeat-leaves-bins-unchanged"],
    [{ deviceErrors: ["x"] }, "device-errors"],
  ];
  for (const [overrides, id] of flips) {
    assert.equal(passes(evaluate, resizeCell(overrides), id), false, id);
  }
  assert.equal(
    passes(
      evaluate,
      resizeCell({ earlyExit: "dispatcher missing" }),
      "dispatcher-exported",
    ),
    false,
  );
});

function perFrameCell(overrides = {}) {
  return {
    run: 0,
    earlyExit: null,
    sceneLightsCount: 2,
    dispatcherFoundEvenWhenOff: false,
    lastActiveOff: -1,
    lastActiveOn: 2,
    lastActiveOffAgain: 0,
    dispatchCallsAfterTransition: 1,
    dispatchCallsAfterStableOff: 1,
    counts: { cells: 3456, total: 3456, occupied: 3456, max: 2 },
    ...CLEAN,
    ...overrides,
  };
}

test("per-frame: lazy while off, 2 when on, 0 after, one transition dispatch, full coverage", () => {
  const evaluate = perFrame.evaluatePerFrame;
  assert.ok(evaluate([perFrameCell()]).every((verdict) => verdict.pass));
  const flips = [
    [{ sceneLightsCount: 3 }, "scene-lights"],
    [{ dispatcherFoundEvenWhenOff: true }, "lazy-while-off"],
    [{ lastActiveOff: 0 }, "off-phase-exposes-no-state"],
    [{ lastActiveOn: 1 }, "on-count"],
    [{ lastActiveOffAgain: 2 }, "re-off-count"],
    [{ dispatchCallsAfterTransition: 2 }, "transition-dispatches-once"],
    [{ dispatchCallsAfterTransition: 0 }, "transition-dispatches-once"],
    [{ dispatchCallsAfterStableOff: 2 }, "stable-off-adds-none"],
    [
      { counts: { cells: 3456, total: 3455, occupied: 3455, max: 1 } },
      "directional-reaches-every-cluster",
    ],
    [{ counts: null }, "directional-reaches-every-cluster"],
    [{ deviceErrors: ["x"] }, "device-errors"],
  ];
  for (const [overrides, id] of flips) {
    assert.equal(passes(evaluate, perFrameCell(overrides), id), false, id);
  }
  assert.equal(
    passes(
      evaluate,
      perFrameCell({ earlyExit: "Dispatcher class not in main bundle" }),
      "runtime-api-present",
    ),
    false,
  );
});

// ---------------------------------------------------------------------------
// The zero-work route
// ---------------------------------------------------------------------------

/**
 * probe-clustered-zero-work-route.mjs:238-258 at a5b71fc17b, verbatim: the
 * `isPlaceholder` helper and the `classify` arrow, as one function.
 */
function referenceClassify(counters) {
  const isPlaceholder = (label) => /placeholder/i.test(label);
  const work = {};
  const fallback = {};
  let workTotal = 0;
  let computeWork = 0;
  let maxFallbackCount = 0;
  for (const [counter, bucket] of Object.entries(counters)) {
    for (const [label, count] of Object.entries(bucket)) {
      if (isPlaceholder(label)) {
        fallback[`${counter}:${label}`] = count;
        if (count > maxFallbackCount) maxFallbackCount = count;
      } else {
        work[`${counter}:${label}`] = count;
        workTotal += count;
        if (counter === "beginComputePass") computeWork += count;
      }
    }
  }
  return { work, fallback, workTotal, computeWork, maxFallbackCount };
}

const PHASE_A = Object.freeze({
  createBuffer: {
    "ClusteredLighting placeholder params (activeLightCount=0)": 1,
  },
  createTexture: { "LTC LUT placeholder (1x1x2 rgba16float)": 1 },
  createBindGroup: {},
  writeBuffer: {},
  writeTexture: {},
  beginComputePass: {},
});
const PHASE_B = Object.freeze({
  createBuffer: { "ClusterAssign lights": 1, "ClusteredLighting params": 1 },
  createTexture: { "LTC LUT (64x64x2 rgba16float)": 1 },
  createBindGroup: { "ClusterAssign BG": 2 },
  writeBuffer: { "ClusteredLighting params": 20 },
  writeTexture: { "LTC LUT (64x64x2 rgba16float)": 1 },
  beginComputePass: {
    "ClusterBounds compute pass": 1,
    "ClusterAssign compute pass": 20,
  },
});

test("classifyClusteredWork equals the original classify, placeholders apart from work", () => {
  for (const counters of [PHASE_A, PHASE_B]) {
    assert.deepEqual(
      zeroWork.classifyClusteredWork(counters),
      referenceClassify(counters),
    );
  }
  const a = zeroWork.classifyClusteredWork(PHASE_A);
  assert.equal(a.workTotal, 0);
  assert.equal(a.maxFallbackCount, 1);
  const b = zeroWork.classifyClusteredWork(PHASE_B);
  assert.equal(b.computeWork, 21);
  assert.equal(b.workTotal, 1 + 1 + 1 + 2 + 20 + 1 + 1 + 20);
});

function zeroWorkCell(overrides = {}) {
  return {
    run: 0,
    earlyExit: null,
    defaultEnabled: false,
    classification: {
      phaseA: zeroWork.classifyClusteredWork(PHASE_A),
      phaseB: zeroWork.classifyClusteredWork(PHASE_B),
    },
    labelInventory: { scannedCount: 25, escaped: [], unreadable: [] },
    ...CLEAN,
    ...overrides,
  };
}

test("zero-work route: nothing at defaults, work and a compute pass in the control, labels all watched", () => {
  const evaluate = zeroWork.evaluateZeroWorkRoute;
  assert.ok(evaluate([zeroWorkCell()]).every((verdict) => verdict.pass));
  const classified = (phaseA, phaseB = PHASE_B) => ({
    classification: {
      phaseA: zeroWork.classifyClusteredWork(phaseA),
      phaseB: zeroWork.classifyClusteredWork(phaseB),
    },
  });
  const flips = [
    [{ defaultEnabled: true }, "default-off"],
    [
      classified({
        ...PHASE_A,
        writeBuffer: { "ClusteredLighting params": 1 },
      }),
      "phase-a-zero-work",
    ],
    [
      classified({
        ...PHASE_A,
        beginComputePass: { "ClusterBounds compute pass": 1 },
      }),
      "phase-a-zero-compute",
    ],
    [
      classified({
        ...PHASE_A,
        createBuffer: {
          "ClusteredLighting placeholder params (activeLightCount=0)": 2,
        },
      }),
      "phase-a-placeholders-bounded",
    ],
    [
      classified(PHASE_A, { ...PHASE_B, beginComputePass: {} }),
      "phase-b-positive-control",
    ],
    [classified(PHASE_A, PHASE_A), "phase-b-positive-control"],
    [
      {
        labelInventory: {
          scannedCount: 25,
          escaped: [{ file: "x.ts", label: "Foo" }],
          unreadable: [],
        },
      },
      "label-inventory",
    ],
    [
      {
        labelInventory: {
          scannedCount: 0,
          escaped: [],
          unreadable: ["x.ts: ENOENT"],
        },
      },
      "label-inventory",
    ],
    [{ deviceErrors: ["x"] }, "device-errors"],
  ];
  for (const [overrides, id] of flips) {
    assert.equal(passes(evaluate, zeroWorkCell(overrides), id), false, id);
  }
  const noDevice = evaluate([
    zeroWorkCell({ earlyExit: "no WebGPU device", classification: null }),
  ]);
  assert.equal(byId(noDevice, "webgpu-device").pass, false);
  assert.equal(byId(noDevice, "phase-a-zero-work").pass, false);
});

test("PROMOTED: every clustered GPU-resource label in the four engine sources matches the zero-work regex", () => {
  const inventory = zeroWork.readClusteredLabelInventory(REPO_ROOT);
  assert.deepEqual(
    inventory.unreadable,
    [],
    "a clustered source file could not be read",
  );
  assert.deepEqual(
    inventory.escaped,
    [],
    `clustered labels outside ${zeroWork.CLUSTER_LABEL_RE} would escape the zero-work gate`,
  );
  // Non-vacuity: every file contributes labels (25 in all at a5b71fc17b).
  for (const file of zeroWork.CLUSTERED_SOURCE_FILES) {
    const text = readFileSync(path.join(REPO_ROOT, ...file.split("/")), "utf8");
    const own = zeroWork.scanClusteredLabelInventory([{ file, text }]);
    assert.ok(own.inventory.length > 0, `${file} contributed no label`);
  }
  assert.ok(
    inventory.scannedCount >= 20,
    `only ${inventory.scannedCount} labels scanned`,
  );
});

test("MUTATION control: a label renamed out of the regex is reported as escaping", () => {
  const sources = [
    {
      file: "packages/x/WebGPUClusterAssignRenderer.ts",
      text: 'a({ label: "ClusterAssign BG" }); b({ label: "Cluster Assign BG" });',
    },
  ];
  const scan = zeroWork.scanClusteredLabelInventory(sources);
  assert.deepEqual(scan.inventory, ["ClusterAssign BG", "Cluster Assign BG"]);
  assert.deepEqual(scan.escaped, [
    { file: "WebGPUClusterAssignRenderer.ts", label: "Cluster Assign BG" },
  ]);
});

// ---------------------------------------------------------------------------
// Family shape, rigs and the renderer refusal
// ---------------------------------------------------------------------------

test("every migrated probe is a runtime declaration: no launch, argv, hash, readback, env base or 8080", () => {
  for (const [file] of FAMILY) {
    const source = readFileSync(path.join(HERE, file), "utf8");
    const code = blankNonCode(source);
    assert.match(
      source,
      /^\/\/ @runtime lib\/probe-runtime\.mjs$/m,
      `${file}: @runtime tag`,
    );
    assert.doesNotMatch(
      source,
      /from\s+["']playwright["']/,
      `${file}: playwright import`,
    );
    assert.doesNotMatch(source, /localhost:8080/, `${file}: hard-coded 8080`);
    for (const [pattern, what] of [
      [/\.launch\s*\(/, "a private launch"],
      [/process\.argv/, "argv parsing"],
      [/process\.env/, "an env-var base"],
      [/createHash/, "a private hash"],
      [/\.screenshot\s*\(/, "an out-of-seam screenshot"],
      [/drawImage|toDataURL|getImageData/, "an in-page readback"],
      [/process\.exit\s*\(/, "a private exit"],
    ]) {
      assert.doesNotMatch(code, pattern, `${file}: ${what}`);
    }
    assert.match(
      code,
      /isEntryPoint\(import\.meta\.url\)/,
      `${file}: entry guard`,
    );
  }
});

test("every probe reads its own rig, and every rig validates and is WebGPU-only", () => {
  for (const [file, module, rigId] of FAMILY) {
    const source = readFileSync(path.join(HERE, file), "utf8");
    assert.match(
      source,
      new RegExp(`from "\\./rigs/${rigId}\\.mjs"`),
      `${file} reads ${rigId}`,
    );
    assert.equal(
      typeof module.descriptor?.cells,
      "function",
      `${file}: descriptor`,
    );
    assert.deepEqual(
      module.descriptor.servedArtifacts,
      ["Build/CesiumUnminified/index.js"],
      file,
    );
    assert.deepEqual(
      module.descriptor.args.defaults.renderers,
      ["webgpu"],
      file,
    );
  }
});

test("the rigs hold the originals' numbers exactly where a literal had to be transcribed", () => {
  for (const rig of [
    perFrameRig,
    zeroWorkRig,
    dispatcherRig,
    boundsResizeRig,
  ]) {
    assert.deepEqual(validateRig(rig), [], rig.id);
  }
  // per-frame: setView(fromDegrees(lon, lat - 0.003, 600), {pitch: toRadians(-20)}).
  assert.equal(perFrameRig.camera.lat, 40.4406 - 0.003);
  assert.equal(perFrameRig.camera.lon, perFrameRig.dials.pointLight.lon);
  assert.equal(perFrameRig.camera.pitch, -20 * (Math.PI / 180));
  assert.equal(zeroWorkRig.camera.pitch, -20 * (Math.PI / 180));
  assert.equal(dispatcherRig.dials.projection.fovYRadians, Math.PI / 3);
  assert.equal(boundsResizeRig.dials.projectionA.fovYRadians, Math.PI / 3);
  assert.equal(boundsResizeRig.dials.projectionB.fovYRadians, Math.PI / 2);
});

test("a WebGL-only run is refused before any browser work", async () => {
  const browser = {
    newContext() {
      throw new Error(
        "a browser context was opened for a renderer the probe cannot measure",
      );
    },
  };
  for (const [file, module] of FAMILY) {
    await assert.rejects(
      module.descriptor.cells({
        browser,
        run: 0,
        options: { renderers: ["webgl"] },
        origin: "http://localhost:8094",
        outputDirectory: "unused",
        repositoryRoot: REPO_ROOT,
        captures: [],
      }),
      (error) =>
        error instanceof ProbeRefusal &&
        error.reason === "renderer-unavailable",
      file,
    );
  }
});
