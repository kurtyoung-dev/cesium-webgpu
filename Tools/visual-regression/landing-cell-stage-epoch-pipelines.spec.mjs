// landing-cell-stage-epoch-pipelines.spec.mjs - a part of the landing-cell-stage spec. Pure Node: no browser, no GPU.
// @purpose Drives the waterSimulationEpoch dial (S6, K5-1) and the opt-in pending-pipeline wait (S7, K5-2) of landing-cell-stage on a fake viewer and a fake pipeline-cache page.
// @status ACTIVE
//
// One part of the landing-cell-stage spec, split by concern (row DX-KIT-LANDING-SPECS-OVER-SIZE); the test names and
// bodies are unchanged. The fixtures it shares with its siblings live in fixtures/landing-cell-stage-support.mjs.
// S6 and S7 are the lead's ROUND 5 additions (Celos), written from the seat's item text.

import assert from "node:assert/strict";
import test from "node:test";
import {
  LANDING_WATER_DIALS,
  PIPELINE_WAIT_DEFAULTS,
  landingStagePayload,
  readPendingPipelines,
  stageLandingCell,
  stageLandingCellInPage,
} from "./lib/landing-cell-stage.mjs";
import { ProbeRefusal } from "./lib/probe-refusal.mjs";
import { blockingDials } from "./probe-landing-cells.mjs";
import {
  FAKE_CESIUM_URL,
  createFakeViewer,
} from "./fixtures/landing-cell-stage-support.mjs";

test.afterEach(() => {
  delete globalThis.viewer;
  delete globalThis.__cloudProbe;
  delete globalThis._webgpuGlobeDebugMode;
  delete globalThis.__webgpuGlobeFragmentDebugRegistry;
});

// -----------------------------------------------------------------------------
// S6: (ROUND 5, K5-1) waterSimulationEpoch: the ocean's wave epoch, applied by
// the stage before any frame and read back as the ISO instant observed.
// Lead addition (Celos, round 5).
// -----------------------------------------------------------------------------

const EPOCH = "2026-07-18T20:10:00Z";

function epochPayload(id, value = EPOCH) {
  return landingStagePayload({
    id,
    camera: null,
    clock: "2026-07-18T20:10:00Z",
    dials: { waterSimulationEpoch: value },
  });
}

function epochPagePayload(id) {
  return { ...epochPayload(id), moduleUrl: FAKE_CESIUM_URL };
}

// An ocean facade shaped like GlobeWaterOcean: the setter keeps a copy.
function epochOcean(setter) {
  return {
    _epoch: undefined,
    sets: [],
    get simulationEpoch() {
      return this._epoch;
    },
    set simulationEpoch(v) {
      this.sets.push(v);
      this._epoch = setter ? setter(v) : v && { iso: v.iso };
    },
  };
}

test("S6: (ROUND 5, K5-1) waterSimulationEpoch is a water dial, carried as the ISO instant", () => {
  assert.ok(LANDING_WATER_DIALS.includes("waterSimulationEpoch"));
  const payload = epochPayload("test-s6-payload");
  assert.deepEqual(payload.water, { waterSimulationEpoch: EPOCH });
  assert.deepEqual(JSON.parse(JSON.stringify(payload)), payload);
});

test("S6: (ROUND 5, K5-1) a value that is not an ISO-8601 UTC instant is refused in Node", () => {
  for (const bad of [
    "2026-07-18 20:10",
    1784405400000,
    null,
    "2026-07-18T20:10:00+01:00",
  ]) {
    assert.throws(
      () => epochPayload("test-s6-bad", bad),
      (error) =>
        error instanceof ProbeRefusal &&
        error.reason === "rig-dial-unsupported" &&
        /waterSimulationEpoch=/.test(error.message),
      `${JSON.stringify(bad)} must be refused`,
    );
  }
});

test("S6: (ROUND 5, K5-1) the stage sets ocean.simulationEpoch as a JulianDate and reads it back applied", async () => {
  const viewer = createFakeViewer();
  const ocean = epochOcean();
  viewer.scene.globe.water = { qualityPreset: "LOW", ocean };
  globalThis.viewer = viewer;
  const staged = await stageLandingCellInPage(
    epochPagePayload("test-s6-applied"),
  );
  assert.equal(ocean.sets.length, 1, "the epoch is assigned exactly once");
  assert.equal(typeof ocean.sets[0], "object");
  assert.equal(
    ocean.sets[0].iso,
    EPOCH,
    "assigned as a JulianDate of the instant",
  );
  assert.deepEqual(staged.dials.waterSimulationEpoch, {
    requested: EPOCH,
    observed: EPOCH,
    applied: true,
  });
  assert.ok(!staged.notApplied.includes("waterSimulationEpoch"));
});

test("S6: (ROUND 5, K5-1) a tree without water.ocean.simulationEpoch reads applied: false, not blocking", async () => {
  for (const water of [
    { qualityPreset: "LOW" },
    { qualityPreset: "LOW", ocean: {} },
    undefined,
  ]) {
    const viewer = createFakeViewer();
    viewer.scene.globe.water = water;
    globalThis.viewer = viewer;
    const staged = await stageLandingCellInPage(
      epochPagePayload("test-s6-absent"),
    );
    const dial = staged.dials.waterSimulationEpoch;
    assert.equal(dial.applied, false);
    assert.equal(dial.requested, EPOCH);
    assert.equal(dial.observed, undefined);
    assert.match(dial.reason, /simulationEpoch is not a property here/);
    assert.ok(staged.notApplied.includes("waterSimulationEpoch"));
    assert.deepEqual(
      blockingDials(staged),
      [],
      "a water dial the tree lacks is the BEFORE arm's answer, not a NOT RUN",
    );
  }
});

test("S6: (ROUND 5, K5-1) an ocean that ignores or moves the epoch reads applied: false with what it holds", async () => {
  const cases = [
    { setter: () => undefined, observed: undefined },
    {
      setter: () => ({ iso: "2026-07-18T20:10:01Z" }),
      observed: "2026-07-18T20:10:01Z",
    },
  ];
  for (const { setter, observed } of cases) {
    const viewer = createFakeViewer();
    viewer.scene.globe.water = { ocean: epochOcean(setter) };
    globalThis.viewer = viewer;
    const staged = await stageLandingCellInPage(
      epochPagePayload("test-s6-moved"),
    );
    assert.equal(staged.dials.waterSimulationEpoch.applied, false);
    assert.equal(staged.dials.waterSimulationEpoch.observed, observed);
    assert.equal(staged.dials.waterSimulationEpoch.requested, EPOCH);
  }
});

// -----------------------------------------------------------------------------
// S7: (ROUND 5, K5-2) waitForPendingPipelines: opt-in; drives frames until the
// render pipeline cache reads 0 pending or the deadline, and records it.
// Lead addition (Celos, round 5).
// -----------------------------------------------------------------------------

// A page whose evaluate runs the page function in Node against a fake WebGPU
// viewer whose pipeline cache drains by the given schedule, one entry per
// frame rendered (the last entry repeats; null = no statistics published yet).
function pipelinePage({ schedule, webgpu = true, statistics = true }) {
  const viewer = createFakeViewer();
  const state = { renders: 0, evaluates: 0 };
  viewer.scene.render = () => {
    state.renders++;
  };
  viewer.scene.context = {
    rendererType: webgpu ? "webgpu" : "webgl",
    isWebGPU: webgpu,
    ...(statistics
      ? {
          getRendererStatistics: () => {
            const pending =
              schedule[Math.min(state.renders, schedule.length - 1)];
            return pending === null
              ? {}
              : { pipelineCache: { pending, created: 10 + state.renders } };
          },
        }
      : {}),
  };
  const page = {
    async evaluate(fn, arg) {
      state.evaluates++;
      globalThis.viewer = viewer;
      return fn(
        arg && arg.moduleUrl ? { ...arg, moduleUrl: FAKE_CESIUM_URL } : arg,
      );
    },
  };
  return { page, state };
}

const PIPELINE_RIG = { id: "test-s7", camera: null, clock: null, dials: {} };

test.before(() => {
  globalThis.requestAnimationFrame ??= (callback) => setImmediate(callback);
});

test("S7: (ROUND 5, K5-2) off by default: no wait, no frame, pipelines null", async () => {
  const { page, state } = pipelinePage({ schedule: [5] });
  const result = await stageLandingCell({ page, rig: PIPELINE_RIG });
  assert.equal(result.pipelines, null);
  assert.equal(state.renders, 0);
  assert.equal(state.evaluates, 1);
});

test("S7: (ROUND 5, K5-2) on: frames are driven until the cache reads 0 pending, and recorded", async () => {
  const { page, state } = pipelinePage({ schedule: [5, 5, 3, 1, 0] });
  const { pipelines } = await stageLandingCell({
    page,
    rig: PIPELINE_RIG,
    waitForPendingPipelines: true,
  });
  assert.equal(pipelines.requested, true);
  assert.equal(pipelines.available, true);
  assert.equal(pipelines.pendingAtStart, 5);
  assert.equal(pipelines.pendingAtEnd, 0);
  assert.equal(pipelines.pendingMax, 5);
  assert.equal(pipelines.timedOut, false);
  assert.equal(pipelines.framesWaited, state.renders);
  // Four frames to drain, then settleReads - 1 more frames reading 0.
  assert.equal(
    pipelines.framesWaited,
    4 + PIPELINE_WAIT_DEFAULTS.settleReads - 1,
  );
  assert.ok(pipelines.waitedMs >= 0);
});

test("S7: (ROUND 5, K5-2) a cache that reads 0 before any frame is not yet drained: frames render first", async () => {
  const { page, state } = pipelinePage({ schedule: [0] });
  const { pipelines } = await stageLandingCell({
    page,
    rig: PIPELINE_RIG,
    waitForPendingPipelines: true,
  });
  assert.equal(pipelines.timedOut, false);
  assert.ok(state.renders >= 1);
  assert.equal(pipelines.framesWaited, PIPELINE_WAIT_DEFAULTS.settleReads);
});

test("S7: (ROUND 5, K5-2) statistics not yet published read as not drained", async () => {
  const { page } = pipelinePage({ schedule: [null, null, 2, 0] });
  const { pipelines } = await stageLandingCell({
    page,
    rig: PIPELINE_RIG,
    waitForPendingPipelines: { settleReads: 1 },
  });
  assert.equal(pipelines.pendingAtStart, null);
  assert.equal(pipelines.pendingAtEnd, 0);
  assert.equal(pipelines.framesWaited, 3);
  assert.equal(pipelines.timedOut, false);
});

test("S7: (ROUND 5, K5-2) a cache that never drains times out at the frame cap, recording what is still pending", async () => {
  const { page, state } = pipelinePage({ schedule: [5] });
  const { pipelines } = await stageLandingCell({
    page,
    rig: PIPELINE_RIG,
    waitForPendingPipelines: { maxFrames: 4, deadlineMs: 1e9 },
  });
  assert.equal(pipelines.timedOut, true);
  assert.equal(pipelines.framesWaited, 4);
  assert.equal(state.renders, 4);
  assert.equal(pipelines.pendingAtEnd, 5);
});

test("S7: (ROUND 5, K5-2) on WebGL there is no pipeline cache: nothing renders and the record says why", async () => {
  const { page, state } = pipelinePage({ schedule: [5], webgpu: false });
  const { pipelines } = await stageLandingCell({
    page,
    rig: PIPELINE_RIG,
    waitForPendingPipelines: true,
  });
  assert.equal(pipelines.available, false);
  assert.equal(pipelines.framesWaited, 0);
  assert.equal(pipelines.timedOut, false);
  assert.equal(state.renders, 0);
  assert.match(pipelines.reason, /WebGPU-only/);
  const now = await readPendingPipelines(page);
  assert.equal(now.available, false);
  assert.equal(now.pending, null);
});

test("S7: (ROUND 5, K5-2) readPendingPipelines reads the cache's pending and created counts", async () => {
  const { page } = pipelinePage({ schedule: [7] });
  assert.deepEqual(await readPendingPipelines(page), {
    available: true,
    rendererType: "webgpu",
    pending: 7,
    created: 10,
  });
  const bare = pipelinePage({ schedule: [7], statistics: false });
  const none = await readPendingPipelines(bare.page);
  assert.equal(none.available, false);
  assert.match(none.reason, /getRendererStatistics/);
});
