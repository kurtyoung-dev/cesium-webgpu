// cloud-reconstruction-timeline.spec.mjs - the reconstruction start-up timeline: the real page functions against a scripted stand-in page, the Node-side record and verdicts on real records, the stage and init-record wiring, the fake browser's console emission and its routing of the timeline functions.
// @purpose Pins lib/cloud-reconstruction-timeline.mjs: the page step turns reconstruction on from the first frame of a cold page (retrying, never throwing), records one row per frame from scene.postRender, reads which family the half-resolution emit pipeline was built for from the cache's pipeline map (label as a cross-check), derives "coherent on N of M emitted frames" and the keys requested against the frame's selected family, and reports what it cannot read; the stage runs it in place of the readiness step before the pending-pipeline wait; each rule has an inertness mutant that turns its case red.
// @status ACTIVE
//
// The stand-in page is a node:vm world holding a scene with a real-shaped postRender event, a scripted cloud cache
// (the engine's own field names, a real Map of pipeline objects with the engine's label) and the public
// CesiumDebug.cloudReconstruction switch. Each case is a behaviour function taking the module under test, so the
// same body runs against the real module and against a mutated copy that must fail it.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test, { after, before } from "node:test";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

import { attachPageDiagnostics } from "../lib/attach-page-diagnostics.mjs";
import { mkLaneTmp, removeLaneTmp } from "../lib/lane-tmp.mjs";
import { landingRunners } from "./fixtures/probe-landing-cells-support.mjs";
import * as timeline from "./lib/cloud-reconstruction-timeline.mjs";
import { importMutated } from "./lib/import-mutated.mjs";
import { makeFakeBrowser } from "./lib/landing-fake-browser.mjs";
import * as stage from "./lib/landing-cell-stage.mjs";
import * as initScripts from "./lib/landing-init-scripts.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const TIMELINE_FILE = path.join(here, "lib/cloud-reconstruction-timeline.mjs");
const STAGE_FILE = path.join(here, "lib/landing-cell-stage.mjs");
const INIT_FILE = path.join(here, "lib/landing-init-scripts.mjs");
const PROBE_FILE = path.join(here, "probe-landing-cells.mjs");
const FAKE_FILE = path.join(here, "lib/landing-fake-browser.mjs");
let tempRoot;
before(() => {
  tempRoot = mkLaneTmp("recon-timeline-");
});
after(() => {
  removeLaneTmp(tempRoot);
});
const { p14Run } = landingRunners(() => tempRoot);

const ENGINE = path.join(here, "../../packages/engine/Source/Renderer/WebGPU");

/** The directional-lighting and deep-shadow family, as the readiness step's rig selects. */
const FULL = 196608;
const EMIT = 16;
const REUSE = 2048;
const F16 = "rgba16float";
const key = (definesHi, format = F16) => `${format}:${definesHi}`;

/**
 * A stand-in page: `script[i]` is what the engine does on render i (the last
 * row repeats once the script ends). Row fields: `sel` (selected family),
 * `preview`, `emitted`, `consumed`, `reuse`, `pending` (the pipeline cache's
 * pending count after the frame), `add` / `addPending` / `publish` (march
 * pipeline keys put in the cache's map as an object, as a null, and the null
 * replaced by an object), `half` / `emit` (the key the half and emit pipelines
 * are, or null). `labels` overrides a pipeline's label by key.
 */
function makeWorld({
  script,
  nullActivations = 0,
  neverActivates = false,
  labels = {},
  withDebug = true,
  withWebGPU = true,
}) {
  const marchPipelines = new Map();
  const listeners = [];
  let renders = 0;
  let calls = 0;
  const pipelineFor = (k) => ({ label: labels[k] ?? `ProceduralClouds ${k}` });
  const context = {
    isWebGPU: withWebGPU,
    _cloudCache: undefined,
    webgpuPipelineCache: {
      getStats: () => ({
        pending:
          script[Math.min(Math.max(renders - 1, 0), script.length - 1)]
            .pending ?? 0,
      }),
    },
  };
  const apply = (row) => {
    context._cloudCache ??= {
      reconstructionEnabled: false,
      attachmentsEnabled: false,
      selectedMarchDefinesHi: 0,
      usingStartupPreview: false,
      reconstructionEmittedThisFrame: false,
      reconstructionConsumedThisFrame: false,
      primaryReuseApplied: false,
      halfPipeline: null,
      halfEmitPipeline: null,
      marchPipelines,
    };
    const cache = context._cloudCache;
    for (const k of row.add ?? []) {
      if (!marchPipelines.has(k)) marchPipelines.set(k, pipelineFor(k));
    }
    for (const k of row.addPending ?? []) {
      if (!marchPipelines.has(k)) marchPipelines.set(k, null);
    }
    for (const k of row.publish ?? []) marchPipelines.set(k, pipelineFor(k));
    cache.selectedMarchDefinesHi = row.sel ?? 0;
    cache.usingStartupPreview = row.preview === true;
    cache.reconstructionEmittedThisFrame = row.emitted === true;
    cache.reconstructionConsumedThisFrame = row.consumed === true;
    cache.primaryReuseApplied = row.reuse === true;
    if ("half" in row)
      cache.halfPipeline = marchPipelines.get(row.half) ?? null;
    if ("emit" in row) {
      cache.halfEmitPipeline = marchPipelines.get(row.emit) ?? null;
    }
  };
  const scene = {
    context,
    frameState: { frameNumber: 0 },
    postRender: {
      addEventListener(fn) {
        listeners.push(fn);
        return () => {
          const at = listeners.indexOf(fn);
          if (at >= 0) listeners.splice(at, 1);
        };
      },
    },
    requestRender() {},
    render() {
      renders++;
      scene.frameState.frameNumber++;
      apply(script[Math.min(renders - 1, script.length - 1)]);
      for (const listener of [...listeners]) listener();
    },
  };
  const globals = {
    viewer: {
      scene,
      useDefaultRenderLoop: false,
      clock: { shouldAnimate: false, currentTime: {} },
    },
    performance: { now: () => renders * 100 },
    requestAnimationFrame: (callback) => setImmediate(() => callback(0)),
  };
  if (withDebug) {
    globals.CesiumDebug = {
      cloudReconstruction(flag) {
        calls++;
        const cache = context._cloudCache;
        if (!cache || neverActivates || calls <= nullActivations) return null;
        cache.reconstructionEnabled = flag === true;
        cache.attachmentsEnabled = flag === true;
        return { requested: flag === true };
      },
    };
  }
  globals.window = globals;
  return { globals, listeners, marchPipelines, scene };
}

const OPTIONS = { ...timeline.RECONSTRUCTION_TIMELINE_DEFAULTS };

/** Run the page step and the page read in the world, and build the record. */
async function runTimeline(mod, world, options = {}) {
  const sandbox = vm.createContext(world.globals);
  const exec = (fn, arg) => vm.runInContext(`(${String(fn)})`, sandbox)(arg);
  const json = (value) => JSON.parse(JSON.stringify(value));
  const run = json(
    await exec(mod.pageRunReconstructionTimeline, { ...OPTIONS, ...options }),
  );
  const raw = json(await exec(mod.pageReadReconstructionTimeline));
  return { run, raw, record: mod.buildReconstructionTimelineRecord(raw) };
}

// ---------------------------------------------------------------------------
// The scripts.
// ---------------------------------------------------------------------------

/** A start-up that falls back for two rungs, then reaches the full family; every emit pipeline is the selected family's. */
const COHERENT = [
  { sel: 0 },
  {
    sel: 1,
    preview: true,
    pending: 1,
    add: [key(1, "rgba8unorm"), key(1)],
    half: key(1),
  },
  { sel: 1, preview: true, pending: 1 },
  {
    sel: 3,
    pending: 1,
    add: [key(3, "rgba8unorm"), key(3)],
    addPending: [key(3 | EMIT)],
    half: key(3),
  },
  {
    sel: 3,
    pending: 1,
    publish: [key(3 | EMIT)],
    emit: key(3 | EMIT),
    emitted: true,
    consumed: true,
  },
  {
    sel: FULL,
    pending: 1,
    add: [key(FULL, "rgba8unorm"), key(FULL)],
    addPending: [key(FULL | EMIT)],
    half: key(FULL),
    emit: null,
  },
  ...[6, 7, 8].map((i) => ({
    sel: FULL,
    pending: 1,
    publish: i === 6 ? [key(FULL | EMIT)] : [],
    emit: key(FULL | EMIT),
    emitted: true,
    consumed: true,
  })),
  {
    sel: FULL,
    pending: 0,
    emit: key(FULL | EMIT),
    emitted: true,
    consumed: true,
  },
];

/** The same start-up on a tree whose emit request ignores the selected family: three emitted frames carry the full family's emit pipeline while the ladder has fallen back. */
const INCOHERENT = [
  { sel: 0 },
  {
    sel: 1,
    preview: true,
    pending: 1,
    add: [key(1, "rgba8unorm"), key(1)],
    half: key(1),
  },
  { sel: 1, preview: true, pending: 1 },
  {
    sel: 3,
    pending: 1,
    add: [key(3, "rgba8unorm"), key(3), key(FULL | EMIT)],
    half: key(3),
    emit: key(FULL | EMIT),
    emitted: true,
  },
  { sel: 3, pending: 1, emitted: true },
  { sel: 3, pending: 1, emitted: true },
  {
    sel: FULL,
    pending: 0,
    add: [key(FULL, "rgba8unorm"), key(FULL)],
    half: key(FULL),
    emitted: true,
  },
];

// ---------------------------------------------------------------------------
// Case behaviours (each takes the module under test).
// ---------------------------------------------------------------------------

async function behaviourCoherent(mod) {
  const { run, record } = await runTimeline(
    mod,
    makeWorld({ script: COHERENT }),
  );
  assert.equal(run.installed, true);
  assert.equal(run.reason, "pipelines-settled");
  assert.equal(record.available, true);
  const d = record.derived;
  assert.equal(record.frames.count, 12);
  assert.equal(d.emittedFrames, 7, "rows 4 and 6 to 11 emitted");
  assert.equal(d.coherentEmitted, 7);
  assert.equal(d.incoherentCount, 0);
  assert.deepEqual(d.incoherent, []);
  assert.equal(d.firstEmitted.row, 4);
  assert.equal(d.firstEmitted.msSinceActivation, 300, "rows 1 to 4");
  assert.equal(d.finalSelected, FULL);
  assert.equal(d.fullFamilyEmitted.row, 6);
  assert.equal(d.fullFamilyEmitted.msSinceActivation, 500);
  assert.equal(d.emitPipelineUnkeyed, 0);
  assert.equal(d.labelDisagreements, 0);
  assert.equal(d.halfKeyNotSelected, 0);
  assert.equal(d.previewRows, 2);
  assert.deepEqual(
    [d.requestedEmitKeys.count, d.requestedEmitKeys.coherent],
    [2, 2],
  );
  assert.deepEqual(d.requestedEmitKeys.incoherent, []);
}

async function behaviourIncoherent(mod) {
  const { record } = await runTimeline(mod, makeWorld({ script: INCOHERENT }));
  const d = record.derived;
  assert.equal(d.emittedFrames, 6);
  assert.equal(
    d.incoherentCount,
    3,
    "three emitted frames on the wrong family",
  );
  assert.equal(d.coherentEmitted, 3);
  assert.deepEqual(
    d.incoherent.map((row) => [row.row, row.frameNumber, row.selected]),
    [
      [3, 4, 3],
      [4, 5, 3],
      [5, 6, 3],
    ],
  );
  assert.ok(d.incoherent.every((row) => row.emitDefinesHi === (FULL | EMIT)));
  assert.deepEqual(
    d.requestedEmitKeys.incoherent,
    [{ row: 3, key: key(FULL | EMIT), selected: 3 }],
    "the full family's emit key was requested on a frame whose selected family had fallen back",
  );
  assert.equal(d.requestedEmitKeys.coherent, 0);
}

async function behaviourLabel(mod) {
  const script = [
    { sel: 0 },
    {
      sel: 3,
      pending: 1,
      add: [key(3 | EMIT)],
      emit: key(3 | EMIT),
      emitted: true,
    },
    { sel: 3, pending: 1, emit: null },
    { sel: 3, pending: 0, emit: null },
  ];
  const { record } = await runTimeline(
    mod,
    makeWorld({
      script,
      labels: { [key(3 | EMIT)]: `ProceduralClouds ${key(7)}` },
    }),
  );
  const d = record.derived;
  assert.equal(d.labelDisagreements, 1);
  assert.equal(d.emittedFrames, 1);
  assert.equal(d.coherentEmitted, 1, "the map key decides, not the label");
  assert.equal(record.frames.columns.emitLabelOk[1], false);
}

async function behaviourRowsBeforeActivation(mod) {
  const { run, record } = await runTimeline(
    mod,
    makeWorld({ script: COHERENT }),
  );
  const at = record.activation.rowIndex;
  assert.equal(run.activation.applied, true);
  assert.equal(
    at,
    1,
    "the cache exists after the first render; the switch is applied before the second",
  );
  assert.ok(at > 0, "a row precedes the activation");
  const { columns } = record.frames;
  assert.equal(columns.cache[0], true);
  for (let row = 0; row < at; row++) {
    assert.equal(columns.enabled[row], false, `row ${row} precedes the switch`);
  }
  assert.equal(columns.enabled[at], true);
}

async function behaviourRetry(mod) {
  const script = [{ sel: 0 }, { sel: 1 }, { sel: 1 }, { sel: 1 }];
  const { run, record } = await runTimeline(
    mod,
    makeWorld({ script, nullActivations: 2 }),
  );
  assert.equal(run.activation.attempts, 3, "the first two answers were null");
  assert.equal(run.activation.applied, true);
  assert.equal(record.activation.rowIndex, 3);
  assert.equal(run.reason, "pipelines-settled");
}

async function behaviourNeverActivates(mod) {
  const script = [{ sel: 0 }, { sel: 1 }];
  const { run, record } = await runTimeline(
    mod,
    makeWorld({ script, neverActivates: true }),
    { maxRenders: 6 },
  );
  assert.equal(run.installed, true);
  assert.equal(run.settled, false);
  assert.equal(run.reason, "activation-not-applied");
  assert.equal(run.activation.applied, false);
  assert.ok(run.activation.attempts >= 1);
  assert.equal(record.available, true);
  const cells = { "E-RECON-timeline": { reconstructionTimeline: true } };
  const [verdict] = mod.reconstructionTimelineVerdicts(
    [pageRecord({ record, run })],
    cells,
  );
  assert.equal(verdict.notRun, true);
  assert.equal(verdict.pass, false);
  assert.match(verdict.reason, /not switched on.*activation-not-applied/);
}

async function behaviourMissingApi(mod) {
  const { run, raw, record } = await runTimeline(
    mod,
    makeWorld({ script: [{ sel: 0 }], withDebug: false }),
  );
  assert.deepEqual(run, {
    installed: false,
    reason: "NOT AVAILABLE: window.CesiumDebug.cloudReconstruction",
  });
  assert.deepEqual(raw, { installed: false });
  assert.equal(record.available, false);
  assert.match(record.reason, /^NOT AVAILABLE: /);
  const [verdict] = mod.reconstructionTimelineVerdicts(
    [pageRecord({ record, run })],
    { "E-RECON-timeline": { reconstructionTimeline: true } },
  );
  assert.deepEqual(
    [verdict.pass, verdict.notRun, verdict.reason],
    [false, true, run.reason],
  );
  const noGpu = await runTimeline(
    mod,
    makeWorld({ script: [{ sel: 0 }], withWebGPU: false }),
  );
  assert.equal(noGpu.run.installed, false);
  assert.match(noGpu.run.reason, /isWebGPU/);
}

async function behaviourReuseKeys(mod) {
  const script = (reuseFamily) => [
    { sel: 0 },
    {
      sel: FULL,
      reuse: true,
      add: [
        key(FULL, "rgba8unorm"),
        key(FULL),
        key(FULL | EMIT),
        key(reuseFamily | REUSE | EMIT),
      ],
    },
    { sel: FULL, reuse: true },
    { sel: FULL, reuse: true },
  ];
  const good = (await runTimeline(mod, makeWorld({ script: script(FULL) })))
    .record.derived;
  assert.deepEqual([good.reuseKeys.count, good.reuseKeys.coherent], [1, 1]);
  assert.deepEqual(good.reuseKeys.unexpected, []);
  assert.deepEqual(
    [good.requestedEmitKeys.count, good.requestedEmitKeys.coherent],
    [1, 1],
    "the reuse key is not counted as an emit key",
  );
  assert.equal(good.reuseBinding, timeline.REUSE_BINDING_NOT_AVAILABLE);
  assert.match(good.reuseBinding, /^NOT AVAILABLE: /);
  const wrong = (await runTimeline(mod, makeWorld({ script: script(7) })))
    .record.derived;
  assert.equal(wrong.reuseKeys.coherent, 0);
  assert.deepEqual(wrong.reuseKeys.unexpected, [
    { row: 1, key: key(7 | REUSE | EMIT), selected: FULL },
  ]);
}

async function behaviourCap(mod) {
  const script = [{ sel: 0 }, { sel: 1, pending: 1 }];
  const { run, record } = await runTimeline(mod, makeWorld({ script }), {
    capFrames: 5,
    maxRenders: 8,
  });
  assert.equal(run.renders, 8);
  assert.equal(run.reason, "render-cap");
  assert.equal(record.frames.count, 5);
  assert.equal(record.frames.truncated, 3);
}

/** A probe page record for the verdict function. */
function pageRecord({ record, run }) {
  return {
    cell: "E-RECON-timeline",
    page: "reuse-off",
    renderer: "webgpu",
    run: 0,
    stage: { reconstructionTimeline: run },
    reconstructionTimeline: record,
  };
}

// ---------------------------------------------------------------------------
// Cases on the real module.
// ---------------------------------------------------------------------------

test("4.7-1: a start-up that selects a fallback family, then the full one, is coherent on every emitted frame", async () => {
  await behaviourCoherent(timeline);
});

test("4.7-2: three emitted frames on the full family's emit pipeline while a fallback is selected are listed as incoherent", async () => {
  await behaviourIncoherent(timeline);
});

test("4.7-3: an emit pipeline whose label names another key is a label disagreement; coherence still reads the map key", async () => {
  await behaviourLabel(timeline);
});

test("4.7-4: rows start before the activation and every row before it reads reconstruction off", async () => {
  await behaviourRowsBeforeActivation(timeline);
});

test("4.7-5: a null answer from the public switch is retried until the cache takes it", async () => {
  await behaviourRetry(timeline);
});

test("4.7-6: a switch that never takes ends without a throw, the record is available and the verdict is NOT RUN", async () => {
  await behaviourNeverActivates(timeline);
});

test("4.7-7: a page without the public switch or the WebGPU context answers NOT AVAILABLE, no throw", async () => {
  await behaviourMissingApi(timeline);
});

test("4.7-8: reuse keys are checked at the frame each was first requested; the bound reuse pipeline is NOT AVAILABLE", async () => {
  await behaviourReuseKeys(timeline);
});

test("4.7-10: the row cap stops recording and counts what it dropped", async () => {
  await behaviourCap(timeline);
});

test("4.7-9: the constants and cache fields the page reads are the engine's, and the page's restated constants equal the module's", async () => {
  const cloud = fs.readFileSync(
    path.join(ENGINE, "WebGPUProceduralCloudRenderer.ts"),
    "utf8",
  );
  const defines = fs.readFileSync(
    path.join(ENGINE, "WebGPUShaderDefines.ts"),
    "utf8",
  );
  const pipelineCache = fs.readFileSync(
    path.join(ENGINE, "WebGPURenderPipelineCache.ts"),
    "utf8",
  );
  assert.match(defines, /CLOUD_MARCH_EMIT_RECONSTRUCTION: hiDefineBit\(4\)/);
  assert.match(defines, /CLOUD_PRIMARY_REUSE: hiDefineBit\(11\)/);
  assert.equal(
    timeline.RECONSTRUCTION_TIMELINE_CONSTANTS.emitBit,
    1 << 4,
    "bit 4 of the define word",
  );
  assert.equal(timeline.RECONSTRUCTION_TIMELINE_CONSTANTS.reuseBit, 1 << 11);
  assert.ok(cloud.includes("name: `ProceduralClouds ${key}`"));
  assert.ok(cloud.includes("const key = `${format}:${definesHi}`"));
  assert.ok(
    cloud.includes('const CLOUD_HALF_FORMAT: GPUTextureFormat = "rgba16float"'),
  );
  assert.ok(pipelineCache.includes("label: descriptor.name"));
  for (const field of [
    "marchPipelines",
    "halfEmitPipeline",
    "halfPipeline",
    "selectedMarchDefinesHi",
    "usingStartupPreview",
    "reconstructionEmittedThisFrame",
    "reconstructionConsumedThisFrame",
    "primaryReuseApplied",
    "reconstructionEnabled",
    "attachmentsEnabled",
  ]) {
    assert.match(
      cloud,
      new RegExp(`^\\s+${field}\\??: `, "m"),
      `the cloud cache declares ${field}`,
    );
  }
  const { raw } = await runTimeline(
    timeline,
    makeWorld({ script: [{ sel: 0 }, { sel: 1 }, { sel: 1 }, { sel: 1 }] }),
  );
  assert.deepEqual(raw.constants, timeline.RECONSTRUCTION_TIMELINE_CONSTANTS);
});

// ---------------------------------------------------------------------------
// Stage and init-record wiring.
// ---------------------------------------------------------------------------

/** A recording page whose evaluate answers the stage's three page functions by name. */
function recordingPage(calls) {
  const answer = {
    installed: true,
    settled: true,
    reason: "pipelines-settled",
  };
  return {
    answer,
    evaluate: async (fn) => {
      calls.push(fn.name);
      if (fn.name === "stageLandingCellInPage") {
        return { notApplied: [], dials: {} };
      }
      if (fn.name === "pageRunReconstructionTimeline") return answer;
      if (fn.name === "pageStageCloudReconstruction") {
        return { requested: true, applied: true, ready: true };
      }
      if (fn.name === "pageWaitForPendingPipelines") {
        return { pending: 0, settled: true };
      }
      throw new Error(`unexpected stage call ${fn.name}`);
    },
  };
}

async function behaviourStageWiring(mod) {
  const rig = { id: "timeline-wiring", camera: null, clock: null, dials: {} };
  const calls = [];
  const page = recordingPage(calls);
  const withTimeline = await mod.stageLandingCell({
    page,
    rig: { ...rig, reconstruction: true },
    waitForPendingPipelines: true,
    reconstructionTimeline: true,
  });
  assert.deepEqual(calls, [
    "stageLandingCellInPage",
    "pageRunReconstructionTimeline",
    "pageWaitForPendingPipelines",
  ]);
  assert.deepEqual(withTimeline.staged.reconstructionTimeline, page.answer);
  assert.equal(Object.hasOwn(withTimeline.staged, "reconstruction"), false);

  calls.length = 0;
  const noRigFlag = await mod.stageLandingCell({
    page,
    rig,
    reconstructionTimeline: true,
  });
  assert.deepEqual(calls, [
    "stageLandingCellInPage",
    "pageRunReconstructionTimeline",
  ]);
  assert.deepEqual(noRigFlag.staged.reconstructionTimeline, page.answer);

  calls.length = 0;
  const without = await mod.stageLandingCell({
    page,
    rig: { ...rig, reconstruction: true },
    waitForPendingPipelines: true,
  });
  assert.deepEqual(calls, [
    "stageLandingCellInPage",
    "pageStageCloudReconstruction",
    "pageWaitForPendingPipelines",
  ]);
  assert.equal(Object.hasOwn(without.staged, "reconstructionTimeline"), false);
}

test("4.7-11: reconstructionTimeline runs the timeline step in place of the readiness step, before the pending-pipeline wait", async () => {
  await behaviourStageWiring(stage);
});

async function behaviourInitRecords(mod) {
  const calls = [];
  const raw = {
    installed: true,
    constants: timeline.RECONSTRUCTION_TIMELINE_CONSTANTS,
    rows: Object.fromEntries(
      [
        "frameNumber",
        "t",
        "cache",
        "enabled",
        "selected",
        "preview",
        "emitted",
        "consumed",
        "reuse",
        "emitKey",
        "emitLabelOk",
        "halfKey",
        "added",
        "pending",
      ].map((name) => [name, []]),
    ),
    keys: [],
    truncated: 0,
    activation: null,
  };
  const page = {
    evaluate: async (fn) => {
      calls.push(fn.name);
      if (fn.name === "pageReadReconstructionTimeline") return raw;
      throw new Error(`unexpected read ${fn.name}`);
    },
  };
  const asked = await mod.readCellInitRecords(page, {
    reconstructionTimeline: true,
  });
  assert.deepEqual(calls, ["pageReadReconstructionTimeline"]);
  assert.equal(asked.reconstructionTimeline.available, true);
  assert.equal(asked.reconstructionTimeline.frames.count, 0);
  calls.length = 0;
  const notAsked = await mod.readCellInitRecords(page, {});
  assert.deepEqual(calls, []);
  assert.equal(Object.hasOwn(notAsked, "reconstructionTimeline"), false);
}

test("4.7-12: readCellInitRecords reads the timeline only for a cell that asks", async () => {
  await behaviourInitRecords(initScripts);
});

// ---------------------------------------------------------------------------
// The fake browser: console emission and routing of the timeline functions.
// ---------------------------------------------------------------------------

async function behaviourFakeConsole(mod) {
  const log = {
    events: [],
    urls: [],
    scripts: [],
    selectors: [],
    contexts: [],
  };
  const browser = mod.makeFakeBrowser(log, {
    consoleMessages: [
      { type: "error", text: "first" },
      { type: "warning", text: "second" },
      { type: "pageerror", text: "third" },
    ],
  });
  const context = await browser.newContext({});
  const page = await context.newPage();
  const diagnostics = attachPageDiagnostics(page);
  await page.goto("http://fake/page");
  assert.deepEqual(
    diagnostics.console.map((m) => [m.type, m.text]),
    [
      ["error", "first"],
      ["warning", "second"],
    ],
  );
  assert.deepEqual(
    diagnostics.errors.map((m) => [m.type, m.text]),
    [["pageerror", "third"]],
  );
  assert.deepEqual(
    [...diagnostics.console, ...diagnostics.errors].map((m) => m.seq).sort(),
    [0, 1, 2],
  );
  diagnostics.detach();
  const quiet = mod.makeFakeBrowser(log);
  const quietPage = await (await quiet.newContext({})).newPage();
  const quietDiagnostics = attachPageDiagnostics(quietPage);
  await quietPage.goto("http://fake/page");
  assert.equal(quietDiagnostics.console.length, 0);
  assert.equal(quietDiagnostics.errors.length, 0);
  // A function form is asked per page with the page's index and url.
  const asked = [];
  const fnBrowser = mod.makeFakeBrowser(log, {
    consoleMessages: ({ pageIndex, url }) => {
      asked.push([pageIndex, url]);
      return pageIndex === 1 ? [{ type: "log", text: "only page 1" }] : [];
    },
  });
  const fnContext = await fnBrowser.newContext({});
  const seen = [];
  for (const u of ["a", "b"]) {
    const p = await fnContext.newPage();
    const d = attachPageDiagnostics(p);
    await p.goto(u);
    seen.push(d.console.length);
  }
  assert.deepEqual(asked, [
    [0, "a"],
    [1, "b"],
  ]);
  assert.deepEqual(seen, [0, 1]);
}

test("8-1: the fake browser emits the console lines and page errors it was given at load, and none by default", async () => {
  await behaviourFakeConsole({ makeFakeBrowser });
});

test("8-2: the fake browser runs the timeline page functions in the page's reader world by name", async () => {
  const log = {
    events: [],
    urls: [],
    scripts: [],
    selectors: [],
    contexts: [],
    timelineCalls: [],
  };
  const world = makeWorld({ script: COHERENT });
  const browser = makeFakeBrowser(log, { readerWorld: world.globals });
  const page = await (await browser.newContext({})).newPage();
  const run = await page.evaluate(timeline.pageRunReconstructionTimeline, {
    ...OPTIONS,
  });
  assert.equal(run.reason, "pipelines-settled");
  const raw = await page.evaluate(timeline.pageReadReconstructionTimeline);
  assert.equal(raw.installed, true);
  assert.equal(raw.rows.frameNumber.length, 12);
  assert.deepEqual(log.timelineCalls, [
    "pageRunReconstructionTimeline",
    "pageReadReconstructionTimeline",
  ]);
});

// ---------------------------------------------------------------------------
// Through the landing probe on the fake browser.
// ---------------------------------------------------------------------------

/** The timeline cell over the real probe: each page gets its own scripted world. */
async function behaviourProbeRun(name, probe) {
  const run = await p14Run(
    name,
    ["--cells", "E-RECON-timeline"],
    { readerWorld: () => makeWorld({ script: COHERENT }).globals },
    probe,
  );
  const pages = run.report.pages.filter((p) => p.cell === "E-RECON-timeline");
  assert.deepEqual(
    pages.map((p) => [p.renderer, p.page]),
    [
      ["webgpu", "reuse-off"],
      ["webgpu", "reuse-on"],
    ],
  );
  for (const page of pages) {
    assert.equal(page.notRun ?? null, null, page.page);
    assert.ok(
      page.stage.reconstructionTimeline,
      `${page.page}: the stage ran the timeline step`,
    );
    assert.equal(page.stage.reconstructionTimeline.installed, true, page.page);
    assert.equal(page.stage.reconstructionTimeline.settled, true, page.page);
    assert.equal(
      Object.hasOwn(page.stage, "reconstruction"),
      false,
      "the readiness step did not run",
    );
    assert.equal(page.reconstructionTimeline.available, true, page.page);
    assert.equal(
      page.reconstructionTimeline.derived.emittedFrames,
      7,
      page.page,
    );
    assert.equal(
      page.reconstructionTimeline.derived.coherentEmitted,
      7,
      page.page,
    );
  }
  const ids = run.verdicts
    .filter((v) => v.id.includes(":reconstruction-timeline:"))
    .map((v) => [v.id, v.pass]);
  assert.deepEqual(ids, [
    [
      "E-RECON-timeline:reuse-off:reconstruction-timeline:webgpu:run0:measured",
      true,
    ],
    [
      "E-RECON-timeline:reuse-on:reconstruction-timeline:webgpu:run0:measured",
      true,
    ],
  ]);
}

test("4.7-13: --cells E-RECON-timeline on the fake browser records the timeline on both pages and two :measured verdicts, the readiness step not run", async () => {
  await behaviourProbeRun("probe-timeline", undefined);
});

// ---------------------------------------------------------------------------
// Inertness mutants: each makes one rule unreachable and must turn its case
// red with an assertion failure, not a crash.
// ---------------------------------------------------------------------------

async function mutantFails(file, pairs, behaviour, wrap = (mod) => mod) {
  const mutated = await importMutated(file, pairs);
  let failure = null;
  try {
    await behaviour(wrap(mutated));
  } catch (error) {
    failure = error;
  }
  assert.ok(
    failure instanceof assert.AssertionError,
    `the mutant must fail ${behaviour.name} with an assertion, got ${failure}`,
  );
  if (process.env.MUTANT_REPORT === "1") {
    console.log(
      `MUTANT-FAILED-ON ${behaviour.name}: ${String(failure.message).split(/\r?\n/)[0]}`,
    );
  }
}

test("M4-1: the coherence comparison unreachable (every emitted row counts coherent) turns the incoherent start-up case red", async () => {
  await mutantFails(
    TIMELINE_FILE,
    [
      [
        "if (isEmitVariantOf(key, columns.selected[row], emitBit)) {",
        "if (true || isEmitVariantOf(key, columns.selected[row], emitBit)) {",
      ],
    ],
    behaviourIncoherent,
  );
});

test("M4-2: the emit key taken from the label instead of the map (lookup unreachable) turns the label case red", async () => {
  await mutantFails(
    TIMELINE_FILE,
    [
      [
        "      if (held === pipeline) {",
        "      if (`ProceduralClouds ${key}` === pipeline.label) {",
      ],
    ],
    behaviourLabel,
  );
});

test("M4-3: the activation retry unreachable (stop after the first answer) turns the retry case red", async () => {
  await mutantFails(
    TIMELINE_FILE,
    [
      [
        "if (!activation.applied && context._cloudCache) {",
        "if (!activation.applied && activation.attempts === 0 && context._cloudCache) {",
      ],
    ],
    behaviourRetry,
  );
});

test("M4-4: the listener recording only from the activation (rows before it dropped) turns the rows-before-activation case red", async () => {
  await mutantFails(
    TIMELINE_FILE,
    [
      [
        "    const cache = context._cloudCache;\n    const present = !!cache;",
        "    if (!state.activation?.applied) {\n      return;\n    }\n    const cache = context._cloudCache;\n    const present = !!cache;",
      ],
    ],
    behaviourRowsBeforeActivation,
  );
});

test("M4-5: the stage ignoring reconstructionTimeline (readiness step runs) turns the wiring case red", async () => {
  await mutantFails(
    STAGE_FILE,
    [
      [
        "if (reconstructionTimeline === true) {",
        "if (false && reconstructionTimeline === true) {",
      ],
    ],
    behaviourStageWiring,
  );
});

test("M4-6: the reuse-key check unreachable turns the reuse-key case red", async () => {
  await mutantFails(
    TIMELINE_FILE,
    [
      [
        "if ((word & reuseBit) === reuseBit) {",
        "if (false && (word & reuseBit) === reuseBit) {",
      ],
    ],
    behaviourReuseKeys,
  );
});

test("M4-7: the row cap unreachable turns the cap case red", async () => {
  await mutantFails(
    TIMELINE_FILE,
    [
      [
        "if (rows.frameNumber.length >= capFrames) {",
        "if (false && rows.frameNumber.length >= capFrames) {",
      ],
    ],
    behaviourCap,
  );
});

test("M4-8: the capture-time timeline read unreachable turns the init-record case red", async () => {
  await mutantFails(
    INIT_FILE,
    [
      [
        "if (wantsReconstructionTimeline(cell)) {",
        "if (false && wantsReconstructionTimeline(cell)) {",
      ],
    ],
    behaviourInitRecords,
  );
});

test("M8-1: the fake browser's console emission unreachable turns the console case red", async () => {
  await mutantFails(
    FAKE_FILE,
    [["emitConsoleMessages(url);", "if (false) emitConsoleMessages(url);"]],
    behaviourFakeConsole,
  );
});

test("M4-9: the probe not passing the cell's reconstructionTimeline to the stage turns the probe-level case red", async () => {
  const mutated = await importMutated(PROBE_FILE, [
    [
      "reconstructionTimeline: cell.reconstructionTimeline === true,",
      "reconstructionTimeline: false,",
    ],
  ]);
  let failure = null;
  try {
    await behaviourProbeRun("probe-timeline-mutant", mutated.descriptor);
  } catch (error) {
    failure = error;
  }
  assert.ok(
    failure instanceof assert.AssertionError,
    `the mutant must fail the probe-level case with an assertion, got ${failure}`,
  );
  if (process.env.MUTANT_REPORT === "1") {
    console.log(
      `MUTANT-FAILED-ON behaviourProbeRun: ${String(failure.message).split(/\r?\n/)[0]}`,
    );
  }
});

test("4.7-8b: an emitted frame where primary reuse applied is counted apart and never judged against the half emit pipeline", async () => {
  const script = [
    { sel: 0 },
    {
      sel: FULL,
      add: [key(FULL), key(FULL | EMIT)],
      emit: key(FULL | EMIT),
      emitted: true,
    },
    { sel: FULL, reuse: true, emitted: true, emit: null },
    { sel: FULL, reuse: true, emitted: true, emit: null },
  ];
  const { record } = await runTimeline(timeline, makeWorld({ script }));
  assert.deepEqual(
    [
      record.derived.emittedFrames,
      record.derived.coherentEmitted,
      record.derived.emittedViaReuse,
    ],
    [1, 1, 2],
  );
});

test("4.7-5b: a switch that answers but leaves the cache off is not an activation", async () => {
  const world = makeWorld({ script: [{ sel: 0 }, { sel: 1 }] });
  world.globals.CesiumDebug.cloudReconstruction = () => ({ requested: true });
  const { run } = await runTimeline(timeline, world, { maxRenders: 6 });
  assert.equal(run.activation.applied, false);
  assert.equal(run.reason, "activation-not-applied");
});
