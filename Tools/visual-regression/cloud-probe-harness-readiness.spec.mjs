// @purpose Pins awaitProceduralReady's two waits (render pipeline cache drained first, then moving frames counted against a budget derived from the measured frame period) with a fake scene and a fake clock, plus the distinct pipeline-timeout refusal and the receipt figures.
// @status ACTIVE
//
// WHAT THIS GROUP IS FOR. `DX-KIT-INGEST-HARNESS-READINESS-BUDGET`: the cloud
// march pipelines compile asynchronously, so a fixed count of moving frames
// (120, from the probes) ran out while the pipelines were still compiling and
// `probe-weather-ingest` refused on every run. These cases assert the repaired
// contract by what the harness WAITS ON and REPORTS, against a scene whose
// pipeline cache drains after N frames, a scene whose cache never drains, and a
// scene with a slow frame period. The fake clock is advanced by the fake
// `requestAnimationFrame`, so no case waits in real time.

import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { installCloudProbeHarness } from "./lib/cloud-probe-harness.mjs";
import { importMutated } from "./lib/import-mutated.mjs";
import { pageReadPendingPipelines } from "./lib/landing-cell-stage.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const HARNESS_PATH = path.join(here, "lib", "cloud-probe-harness.mjs");
const FRAME_TIME = Object.freeze({ authored: true });

const recordingRenderer = () => ({
  prepareCloudFrameAndEncodeMask: () => ({ kind: "prepared" }),
  executePreparedCloudFrame: () => true,
});
const silentRenderer = () => ({
  prepareCloudFrameAndEncodeMask: () => ({ kind: "prepared" }),
  executePreparedCloudFrame: () => false,
});
const compose = (renderer) => {
  renderer.executePreparedCloudFrame(renderer.prepareCloudFrameAndEncodeMask());
};

/**
 * Drive `awaitProceduralReady` against a fake scene on a fake clock.
 *
 * @param {object} setup
 * @param {object} setup.renderer The feature renderer the context resolves.
 * @param {number} [setup.liveFrom] Render index from which the renderer
 *   composes and the cloud cache exists.
 * @param {number|Function} [setup.frameMs] Fake ms each frame takes, or a
 *   function of the render index.
 * @param {Function|null} [setup.pending] `renderIndex => pending count`
 *   (null reads as no count); `null` for a context with no statistics.
 * @param {object} [setup.options] Options for `awaitProceduralReady`.
 * @param {Function} [setup.install] The harness installer under test.
 * @param {object} [setup.webgl] Make the context a WebGL one.
 * @returns {Promise<object>} `{ outcome, error, renderCalls }`.
 */
async function drive({
  renderer,
  liveFrom = 2,
  frameMs = 16,
  pending = () => 0,
  options = {},
  install = installCloudProbeHarness,
  webgl = false,
  statisticsThrows = false,
}) {
  const uniformData = new Float32Array(176);
  let renderCalls = 0;
  let clock = 1000;
  const context = {
    rendererType: webgl ? "webgl" : "webgpu",
    isWebGPU: !webgl,
    async getFeatureRendererAsync() {
      return renderer;
    },
  };
  if (pending !== null) {
    context.getRendererStatistics = () => {
      if (statisticsThrows) {
        throw new Error("statistics unavailable");
      }
      const value = pending(renderCalls);
      return {
        pipelineCache:
          value === undefined ? {} : { pending: value, created: renderCalls },
      };
    };
  }
  globalThis.viewer = {
    clock: { currentTime: FRAME_TIME },
    scene: {
      context,
      render() {
        renderCalls++;
        if (renderCalls >= liveFrom) {
          compose(renderer);
          context._cloudCache ??= {
            initialized: true,
            pipeline: {},
            uniformData,
            halfWidth: 0,
            halfHeight: 0,
            temporalWidth: 0,
            temporalHeight: 0,
            temporalPipeline: null,
            frameCounter: 0,
          };
        }
      },
    },
  };
  globalThis.requestAnimationFrame = (callback) => {
    clock += typeof frameMs === "function" ? frameMs(renderCalls) : frameMs;
    callback();
  };
  const performanceDescriptor = Object.getOwnPropertyDescriptor(
    globalThis,
    "performance",
  );
  Object.defineProperty(globalThis, "performance", {
    value: { now: () => clock },
    configurable: true,
    writable: true,
  });
  try {
    install();
    const outcome = await globalThis.__cloudProbe.awaitProceduralReady({
      featureRendererKey: 32,
      frameTime: FRAME_TIME,
      ...options,
    });
    return { outcome, error: null, renderCalls };
  } catch (error) {
    return { outcome: null, error, renderCalls };
  } finally {
    Object.defineProperty(globalThis, "performance", performanceDescriptor);
    delete globalThis.__cloudProbe;
    delete globalThis.viewer;
    delete globalThis.requestAnimationFrame;
  }
}

test("readiness waits on the pipeline cache before it counts moving frames", async () => {
  // 300 frames with pipelines pending, a frame cap of 10 (exact: budget 0).
  // The renderer goes live only when the pipelines have drained. A count of
  // moving frames from frame one would refuse at frame 10; a wait on the cache
  // arrives with 300 frames waited and almost none counted.
  const { outcome, error, renderCalls } = await drive({
    renderer: recordingRenderer(),
    liveFrom: 301,
    pending: (frame) => (frame <= 300 ? 4 : 0),
    options: { maxFrames: 10, frameBudgetMs: 0 },
  });

  assert.equal(error, null, error?.message);
  assert.equal(outcome.ok, true);
  assert.equal(outcome.endedBy, "recorded");
  assert.equal(renderCalls, 301);
  assert.equal(outcome.pipelineWait.available, true);
  assert.equal(
    outcome.pipelineWait.frames,
    300,
    "the recording frame ends the wait",
  );
  assert.equal(outcome.pipelineWait.pendingAtStart, 4);
  assert.equal(outcome.pipelineWait.pendingMax, 4);
  assert.equal(outcome.pipelineWait.timedOut, false);
  assert.ok(outcome.pipelineWait.waitedMs >= 300 * 16);
  assert.equal(outcome.countedFrames, 0);
  assert.equal(outcome.waitedFrames, 301);
});

test("pipelines that drain, then a renderer that records nothing, refuse on the counted frames only", async () => {
  // The drain takes 40 frames, which must not be charged to the 6-frame cap.
  const { outcome, error } = await drive({
    renderer: silentRenderer(),
    pending: (frame) => (frame <= 40 ? 2 : 0),
    options: { maxFrames: 6, frameBudgetMs: 0 },
  });

  assert.equal(outcome, null);
  assert.match(error.message, /recorded no frame in 6 moving frames/u);
  assert.doesNotMatch(error.message, /pipeline wait timed out/u);
  const figuresText = error.message.slice(
    error.message.indexOf("figures=") + "figures=".length,
    error.message.indexOf('): {"cachePresent"'),
  );
  const figures = JSON.parse(figuresText);
  assert.equal(figures.countedFrames, 6);
  assert.equal(figures.pipelineWait.drained, true);
  assert.ok(figures.pipelineWait.frames >= 40);
});

test("a pipeline cache that never drains refuses with a distinct pipeline-timeout error", async () => {
  const { outcome, error, renderCalls } = await drive({
    renderer: silentRenderer(),
    pending: () => 3,
    frameMs: 10,
    options: { maxFrames: 5, pipelineWaitMs: 500 },
  });

  assert.equal(outcome, null);
  assert.match(error.message, /pipeline wait timed out/u);
  assert.match(error.message, /3 pipelines still pending/u);
  assert.match(error.message, /of a 500 ms budget/u);
  assert.doesNotMatch(
    error.message,
    /recorded no frame in \d+ moving frames/u,
    "a compile that never finishes is not a renderer that recorded nothing",
  );
  assert.match(error.message, /"timedOut":true/u);
  assert.equal(renderCalls, 50, "500 ms of 10 ms frames");
});

test("pipelines requested after the first drain send the wait back to the cache", async () => {
  // Reads 0 on frames 1-5 (drained), 4 pending on frames 6-30, 0 afterwards.
  // The 10-frame cap would be spent on frames 6-15 if the late pipelines
  // counted as moving frames.
  const { outcome, error } = await drive({
    renderer: recordingRenderer(),
    liveFrom: 35,
    pending: (frame) => (frame >= 6 && frame <= 30 ? 4 : 0),
    options: { maxFrames: 10, frameBudgetMs: 0 },
  });

  assert.equal(error, null, error?.message);
  assert.ok(outcome.pipelineWait.rewaits >= 1);
  assert.equal(outcome.pipelineWait.pendingMax, 4);
  assert.ok(outcome.countedFrames < 10);
});

test("a context with no pipeline statistics skips the first wait and says so", async () => {
  for (const setup of [
    { pending: null, webgl: false },
    { pending: () => 0, webgl: true },
    { pending: () => 0, statisticsThrows: true },
  ]) {
    const { outcome, error } = await drive({
      renderer: recordingRenderer(),
      ...setup,
    });

    assert.equal(error, null, error?.message);
    assert.equal(outcome.pipelineWait.available, false);
    assert.equal(typeof outcome.pipelineWait.reason, "string");
    assert.equal(outcome.pipelineWait.frames, 0);
    assert.equal(outcome.waitedFrames, 2);
  }
});

test("a cache that reads no count after a frame is treated as drained, not waited out", async () => {
  const { outcome, error, renderCalls } = await drive({
    renderer: recordingRenderer(),
    liveFrom: 50,
    pending: () => undefined,
    options: { maxFrames: 100, frameBudgetMs: 0, pipelineWaitMs: 1e9 },
  });

  assert.equal(error, null, error?.message);
  assert.equal(outcome.pipelineWait.drained, true);
  assert.equal(outcome.pipelineWait.pendingAtEnd, null);
  assert.equal(renderCalls, 50);
});

test("the harness reads the pending count as the kit's landing reader does", async () => {
  const cases = [
    { name: "webgpu zero", setup: { pending: () => 0 } },
    { name: "webgpu pending", setup: { pending: () => 7, liveFrom: 1 } },
    { name: "webgl", setup: { pending: () => 0, webgl: true } },
    { name: "no statistics fn", setup: { pending: null } },
    { name: "throws", setup: { pending: () => 0, statisticsThrows: true } },
    { name: "no count", setup: { pending: () => undefined } },
  ];
  for (const { name, setup } of cases) {
    // The kit's reader, on the same context shape, before any frame renders.
    let kit;
    const { outcome } = await drive({
      renderer: recordingRenderer(),
      liveFrom: 1,
      ...setup,
      options: { maxFrames: 1, frameBudgetMs: 0, pipelineWaitMs: 0 },
      install: () => {
        installCloudProbeHarness();
        kit = pageReadPendingPipelines();
      },
    });
    assert.equal(
      outcome.pipelineWait.available,
      kit.available,
      `${name}: available`,
    );
    assert.equal(
      outcome.pipelineWait.pendingAtStart,
      kit.pending,
      `${name}: pending`,
    );
    if (!kit.available) {
      assert.equal(outcome.pipelineWait.reason, kit.reason, `${name}: reason`);
    }
  }
});

test("the frame budget is the time budget over the measured frame period", async () => {
  const refused = (frameMs, options) =>
    drive({
      renderer: silentRenderer(),
      pending: null,
      frameMs,
      options: { maxFrames: 5, frameBudgetMs: 1000, ...options },
    }).then(({ error }) => {
      const match = /recorded no frame in (\d+) moving frames/u.exec(
        error?.message ?? "",
      );
      assert.ok(match, error?.message);
      return Number(match[1]);
    });

  assert.equal(await refused(10), 100, "1000 ms / 10 ms");
  assert.equal(
    await refused(50),
    20,
    "1000 ms / 50 ms: a slower period, fewer frames",
  );
  assert.equal(await refused(1000), 5, "never below the floor");
  assert.equal(
    await refused(0.001, { maxFramesCeiling: 40 }),
    40,
    "never above the ceiling",
  );
});

test("an explicit cap is a floor the derivation only raises, and 0 ms makes it exact", async () => {
  const counted = async (options) => {
    const { error } = await drive({
      renderer: silentRenderer(),
      pending: null,
      frameMs: 100,
      options,
    });
    return Number(
      /recorded no frame in (\d+) moving frames/u.exec(error.message)[1],
    );
  };

  assert.equal(
    await counted({ maxFrames: 30, frameBudgetMs: 1000 }),
    30,
    "10 frames derived, the caller's 30 holds as the floor",
  );
  assert.equal(
    await counted({ maxFrames: 30, frameBudgetMs: 6000 }),
    60,
    "60 frames derived raise the floor",
  );
  assert.equal(await counted({ maxFrames: 7, frameBudgetMs: 0 }), 7);
  assert.equal(
    await counted({ frameBudgetMs: 0 }),
    180,
    "no cap given: the historical 180 is the floor",
  );
});

test("the receipt records which wait ended and the figures", async () => {
  const { outcome } = await drive({
    renderer: recordingRenderer(),
    liveFrom: 20,
    frameMs: 25,
    pending: (frame) => (frame < 10 ? 1 : 0),
    options: { maxFrames: 4 },
  });

  assert.equal(outcome.endedBy, "recorded");
  assert.deepEqual(Object.keys(outcome.pipelineWait).sort(), [
    "available",
    "budgetMs",
    "drained",
    "frames",
    "pendingAtEnd",
    "pendingAtStart",
    "pendingMax",
    "rewaits",
    "timedOut",
    "waitedMs",
  ]);
  assert.equal(outcome.pipelineWait.drained, true);
  assert.equal(outcome.pipelineWait.budgetMs, 60_000);
  assert.equal(outcome.framePeriodMs, 25);
  assert.equal(outcome.frameBudget.floor, 4);
  assert.equal(outcome.frameBudget.budgetMs, 10_000);
  assert.equal(outcome.frameBudget.frames, 400, "10 s / 25 ms");
  assert.equal(
    outcome.pipelineWait.frames,
    12,
    "nine pending frames and three zero reads",
  );
  assert.equal(outcome.countedFrames, 7);
  assert.equal(outcome.waitedFrames, 20);
});

// INERTNESS: each clause made unreachable must turn a case above red.

test("INERTNESS: without the pipeline wait the late-pipeline scene refuses", async () => {
  const mutated = await importMutated(HARNESS_PATH, [
    [
      "let draining = firstRead.available;",
      "let draining = false && firstRead.available;",
    ],
    [
      "if (!draining && pending !== null && pending > 0) {",
      "if (false && !draining && pending !== null && pending > 0) {",
    ],
  ]);
  const { outcome, error } = await drive({
    renderer: recordingRenderer(),
    liveFrom: 301,
    pending: (frame) => (frame <= 300 ? 4 : 0),
    options: { maxFrames: 10, frameBudgetMs: 0 },
    install: mutated.installCloudProbeHarness,
  });

  assert.equal(outcome, null);
  assert.match(error.message, /recorded no frame in 10 moving frames/u);
});

test("INERTNESS: a fixed 180 in place of the derived budget changes the refusal", async () => {
  const mutated = await importMutated(HARNESS_PATH, [
    [
      "if (countedFrames >= frameBudgetFrames()) {",
      "if (countedFrames >= 180) {",
    ],
  ]);
  const { error } = await drive({
    renderer: silentRenderer(),
    pending: null,
    frameMs: 50,
    options: { maxFrames: 5, frameBudgetMs: 1000 },
    install: mutated.installCloudProbeHarness,
  });

  assert.doesNotMatch(
    error.message,
    /recorded no frame in 20 moving frames/u,
    "the derived 20 frames is the live behaviour; 180 means the derivation was bypassed",
  );
  assert.match(error.message, /recorded no frame in 180 moving frames/u);
});
