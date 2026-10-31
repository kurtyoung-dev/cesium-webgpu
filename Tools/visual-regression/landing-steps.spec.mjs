// landing-steps.spec.mjs - lane KT round 2 (Calenardhon). Pure Node: no browser, no GPU.
// @purpose Step piece tests for runClockSteps, runDeviceLossSteps, classifyConsoleErrors, and measureLandingPerformance.
// @status ACTIVE
//
// Covers behaviours T1, T2, T3, and T4 from BEHAVIOUR_CELOS.md. T5 (the terminal
// record's one reader) is the lead's ROUND 4 addition for the seat's item F1
// (Celos), written from the item text and Calenhad's N2.
// Written as an independent specification from the behaviour statement without
// inspecting unlanded changes.

import assert from "node:assert/strict";
import test from "node:test";

import {
  CLOCK_STEPS_MODULE_URL,
  pageReadSunState,
  pageSetClock,
  runClockSteps,
} from "./lib/clock-steps.mjs";
import {
  DEVICE_LOSS_MODES,
  DEVICE_LOSS_SENTINEL_RE,
  classifyConsoleErrors,
  pageDestroyViewer,
  pageForceDeviceLoss,
  pageRenderAfterLoss,
  pageSwitchTier,
  runDeviceLossSteps,
  sameTerminal,
  terminalShape,
} from "./lib/device-loss-steps.mjs";
import {
  measureLandingPerformance,
  pageSampleFrameTimes,
  pageSampleGpuPassCost,
} from "./lib/frame-timing-steps.mjs";
import {
  pageReadCanvasSize,
  pageSetMsaaSamples,
} from "./lib/globe-resize-steps.mjs";
import { pageSwapSkyBoxSources } from "./lib/skybox-swap-steps.mjs";

/**
 * Creates a stub page recording evaluate calls and answering with canned results.
 *
 * @param {object} [options]
 * @param {{errors?: string[], deviceLost?: string|null, armedDevices?: number}} [options.gate]
 * @param {number|null} [options.frameNumber]
 * @param {Record<string, Function>} [options.handlers]
 * @returns {object}
 */
function makeStubPage({
  gate = { errors: [], deviceLost: null, armedDevices: 1 },
  frameNumber = 100,
  handlers = {},
} = {}) {
  const calls = [];
  const viewportSizes = [];
  const page = {
    calls,
    viewportSizes,
    async setViewportSize({ width, height }) {
      viewportSizes.push({ width, height });
      calls.push({ type: "setViewportSize", width, height });
    },
    async evaluate(fn, arg) {
      const name = fn?.name || "";
      const src = typeof fn === "function" ? fn.toString() : String(fn);
      calls.push({ type: "evaluate", name, arg });

      if (handlers[name]) {
        return await handlers[name](arg, { fn, src });
      }

      if (src.includes("__webgpuGate")) {
        return {
          errors: gate.errors ? [...gate.errors] : [],
          deviceLost: gate.deviceLost ?? null,
          armedDevices: gate.armedDevices ?? 1,
        };
      }

      if (
        name === "pageReadFrameNumber" ||
        src.includes("pageReadFrameNumber")
      ) {
        return frameNumber;
      }

      if (fn === pageSetClock || name === "pageSetClock") {
        return { ok: true, observed: arg?.iso };
      }
      if (fn === pageReadSunState || name === "pageReadSunState") {
        return {
          frameNumber: 42,
          sunDirectionWC: [0, 0, 1],
        };
      }

      if (fn === pageSwitchTier || name === "pageSwitchTier") {
        return { ok: true, observed: arg?.value };
      }
      if (fn === pageDestroyViewer || name === "pageDestroyViewer") {
        return { destroyed: true, threw: null };
      }
      if (fn === pageForceDeviceLoss || name === "pageForceDeviceLoss") {
        return {
          renderer: "webgpu",
          method: "GPUDevice.destroy",
          observed: { reason: "destroyed", message: "forced loss" },
        };
      }
      if (fn === pageRenderAfterLoss || name === "pageRenderAfterLoss") {
        return {
          framesAttempted: arg?.frames ?? 30,
          throws: 0,
          firstThrows: [],
          terminallyLost: true,
        };
      }

      if (fn === pageSetMsaaSamples || name === "pageSetMsaaSamples") {
        return { sceneMsaaSamples: arg?.samples ?? 1 };
      }
      if (fn === pageReadCanvasSize || name === "pageReadCanvasSize") {
        const lastVp = viewportSizes[viewportSizes.length - 1] ?? {
          width: 800,
          height: 600,
        };
        return {
          width: lastVp.width,
          height: lastVp.height,
          contextMsaaSamples: 1,
        };
      }

      if (fn === pageSwapSkyBoxSources || name === "pageSwapSkyBoxSources") {
        return { ok: true };
      }

      if (fn === pageSampleFrameTimes || name === "pageSampleFrameTimes") {
        return {
          renderer: "webgpu",
          frameMs: [16.6, 16.7],
          cpuMs: [2.1, 2.2],
          workDoneTimeouts: 0,
          outcome: "done",
          frames: arg?.frames,
          warmupFrames: arg?.warmupFrames,
        };
      }
      if (fn === pageSampleGpuPassCost || name === "pageSampleGpuPassCost") {
        return {
          available: true,
          passes: [{ name: "globe", totalMs: 4.2 }],
        };
      }

      throw new Error(`Unhandled evaluate call: ${name || src.slice(0, 80)}`);
    },
  };
  return page;
}

/**
 * Creates a stub settle function tracking settle frame calls.
 *
 * @returns {((frames: number) => Promise<void>) & { calls: number[] }}
 */
function makeStubSettle() {
  const calls = [];
  const settle = async (frames) => {
    calls.push(frames);
  };
  settle.calls = calls;
  return settle;
}

// ---------------------------------------------------------------------------
// T1. runClockSteps
// ---------------------------------------------------------------------------

test("T1: runClockSteps sets clock to each instant in order and calls settle after each", async () => {
  const instants = [
    "2026-06-21T06:00:00Z",
    "2026-06-21T12:00:00Z",
    "2026-06-21T18:00:00Z",
  ];
  const rig = {
    dials: {
      clockSteps: instants,
      settleFramesPerStep: 15,
    },
  };
  const page = makeStubPage();
  const settle = makeStubSettle();

  const result = await runClockSteps({ page, rig, settle });

  assert.equal(result.steps.length, 3, "expected 3 steps");
  assert.deepEqual(settle.calls, [15, 15, 15], "settle called after each step");

  for (let i = 0; i < instants.length; i++) {
    const step = result.steps[i];
    assert.equal(step.name, instants[i]);
    assert.equal(step.ok, true);
    assert.equal(step.observed, instants[i]);
    assert.equal(step.frameNumber, 42);
    assert.deepEqual(step.sunDirectionWC, [0, 0, 1]);
  }

  const setClockCalls = page.calls.filter((c) => c.name === "pageSetClock");
  assert.equal(setClockCalls.length, 3);
  for (let i = 0; i < instants.length; i++) {
    assert.equal(setClockCalls[i].arg.iso, instants[i]);
    assert.equal(setClockCalls[i].arg.moduleUrl, CLOCK_STEPS_MODULE_URL);
  }
});

test("T1: runClockSteps stops at first step whose page call answers ok: false", async () => {
  const instants = [
    "2026-06-21T06:00:00Z",
    "2026-06-21T12:00:00Z",
    "2026-06-21T18:00:00Z",
  ];
  const rig = {
    dials: {
      clockSteps: instants,
      settleFramesPerStep: 10,
    },
  };
  const page = makeStubPage({
    handlers: {
      pageSetClock: (arg) => {
        if (arg.iso === "2026-06-21T12:00:00Z") {
          return { ok: false, reason: "JulianDate parse failure" };
        }
        return { ok: true, observed: arg.iso };
      },
    },
  });
  const settle = makeStubSettle();

  const result = await runClockSteps({ page, rig, settle });

  assert.equal(result.steps.length, 2, "stops after failing step");
  assert.equal(result.steps[0].ok, true);
  assert.equal(result.steps[1].ok, false);
  assert.equal(result.steps[1].name, "2026-06-21T12:00:00Z");
  assert.equal(result.steps[1].reason, "JulianDate parse failure");

  assert.equal(
    settle.calls.length,
    1,
    "settle called only for successful step",
  );
  assert.equal(settle.calls[0], 10);

  const setClockCalls = page.calls.filter((c) => c.name === "pageSetClock");
  assert.equal(setClockCalls.length, 2, "third instant never evaluated");
});

test("T1: runClockSteps handles empty clockSteps or omitted dials cleanly", async () => {
  const page = makeStubPage();
  const settle = makeStubSettle();

  const resultEmpty = await runClockSteps({
    page,
    rig: { dials: { clockSteps: [] } },
    settle,
  });
  assert.deepEqual(resultEmpty.steps, []);
  assert.equal(page.calls.length, 0);
  assert.equal(settle.calls.length, 0);

  const resultNoDials = await runClockSteps({
    page,
    rig: {},
    settle,
  });
  assert.deepEqual(resultNoDials.steps, []);
  assert.equal(page.calls.length, 0);
  assert.equal(settle.calls.length, 0);
});

// ---------------------------------------------------------------------------
// T2. runDeviceLossSteps
// ---------------------------------------------------------------------------

test("T2: runDeviceLossSteps refuses a mode other than teardown or forced-loss with TypeError", async () => {
  const page = makeStubPage();
  const rig = { dials: {} };
  const settle = makeStubSettle();

  const invalidModes = ["restart", "lost", "reboot", "", null, undefined];
  for (const mode of invalidModes) {
    await assert.rejects(
      async () => {
        await runDeviceLossSteps({ page, rig, settle, mode });
      },
      { name: "TypeError" },
      `expected TypeError for invalid mode: ${String(mode)}`,
    );
  }

  assert.deepEqual(
    DEVICE_LOSS_MODES,
    ["teardown", "forced-loss"],
    "DEVICE_LOSS_MODES must contain exactly teardown and forced-loss",
  );
});

test("T2: runDeviceLossSteps runs provoking steps in order: resize ladder, sky-box swaps, tier switch", async () => {
  const rig = {
    dials: {
      resizeLadder: [
        [640, 480],
        [800, 600],
      ],
      msaaSamples: 4,
      swaps: [{ name: "sunset", rgb: [255, 128, 0], faceSize: 64 }],
      tierSwitch: {
        dial: "waterQualityPreset",
        values: ["low", "high"],
      },
      settleFramesPerStep: 10,
    },
  };
  const page = makeStubPage();
  const settle = makeStubSettle();

  const result = await runDeviceLossSteps({
    page,
    rig,
    settle,
    mode: "teardown",
  });

  const stepNames = result.steps.map((s) => s.name);
  assert.deepEqual(
    stepNames,
    ["resize-ladder", "skybox-swaps", "tier-switch:waterQualityPreset"],
    "provoking steps must execute in order: resize, swaps, tierSwitch",
  );

  for (const step of result.steps) {
    assert.equal(step.ok, true);
  }

  const evaluateCalls = page.calls.map((c) => c.name || c.type);
  const msaaIndex = evaluateCalls.indexOf("pageSetMsaaSamples");
  const swapIndex = evaluateCalls.indexOf("pageSwapSkyBoxSources");
  const tierIndex = evaluateCalls.indexOf("pageSwitchTier");

  assert.ok(
    msaaIndex >= 0 && swapIndex > msaaIndex && tierIndex > swapIndex,
    "resize steps must run before skybox swaps, and skybox swaps before tier switch",
  );
});

test("T2: runDeviceLossSteps records each step with liveness state from decideCaptureLiveness", async () => {
  const rig = {
    dials: {
      tierSwitch: {
        dial: "waterQualityPreset",
        values: ["high"],
      },
      settleFramesPerStep: 5,
    },
  };

  // Case A: Gate is armed, no loss -> "live"
  {
    const page = makeStubPage({
      gate: { errors: [], deviceLost: null, armedDevices: 1 },
    });
    const settle = makeStubSettle();
    const result = await runDeviceLossSteps({
      page,
      rig,
      settle,
      mode: "teardown",
    });
    assert.equal(result.steps.length, 1);
    assert.equal(result.steps[0].liveness, "live");
  }

  // Case B: Gate is not armed -> "unobserved"
  {
    const page = makeStubPage({
      gate: { errors: [], deviceLost: null, armedDevices: 0 },
    });
    const settle = makeStubSettle();
    const result = await runDeviceLossSteps({
      page,
      rig,
      settle,
      mode: "teardown",
    });
    assert.equal(result.steps.length, 1);
    assert.equal(result.steps[0].liveness, "unobserved");
  }
});

test("T2: runDeviceLossSteps skips terminal action when gate reports unexpected loss during provoking steps", async () => {
  const gateState = { errors: [], deviceLost: null, armedDevices: 1 };
  const rig = {
    dials: {
      resizeLadder: [[640, 480]],
      tierSwitch: {
        dial: "waterQualityPreset",
        values: ["high"],
      },
      settleFramesPerStep: 5,
    },
  };
  const page = makeStubPage({
    gate: gateState,
    handlers: {
      pageReadCanvasSize: () => {
        gateState.errors.push("fatal GPU fault");
        gateState.deviceLost =
          "[WebGPU] Device lost (reason: unknown): GPU crash";
        return { width: 640, height: 480, contextMsaaSamples: 1 };
      },
    },
  });
  const settle = makeStubSettle();

  const result = await runDeviceLossSteps({
    page,
    rig,
    settle,
    mode: "teardown",
  });

  assert.equal(result.steps.length, 1, "provoking steps halted after loss");
  assert.equal(result.steps[0].name, "resize-ladder");
  assert.equal(result.steps[0].liveness, "lost");

  assert.equal(result.terminal.action, null, "terminal action must be null");
  assert.ok(
    typeof result.terminal.skipped === "string" &&
      result.terminal.skipped.length > 0,
    "terminal.skipped must state the reason for skipping",
  );

  const destroyCalls = page.calls.filter((c) => c.name === "pageDestroyViewer");
  assert.equal(destroyCalls.length, 0, "pageDestroyViewer was skipped");
});

test("T2: runDeviceLossSteps reads owner rows before and after terminal action in teardown mode", async () => {
  const rig = { dials: {} };
  const ownerLabels = ["Global BathymetryTensorMap LUT", "UnseenOwner"];
  let censusCalls = 0;

  const readCensus = async () => {
    censusCalls++;
    if (censusCalls === 1) {
      return {
        byLabel: {
          lut: {
            label: "Global BathymetryTensorMap LUT",
            kind: "texture",
            created: 3,
            destroyed: 0,
            liveBytes: 4096,
          },
        },
      };
    }
    return {
      byLabel: {
        lut: {
          label: "Global BathymetryTensorMap LUT",
          kind: "texture",
          created: 3,
          destroyed: 3,
          liveBytes: 0,
        },
      },
    };
  };

  const page = makeStubPage();
  const settle = makeStubSettle();

  const result = await runDeviceLossSteps({
    page,
    rig,
    settle,
    mode: "teardown",
    readCensus,
    ownerLabels,
  });

  assert.equal(censusCalls, 2, "readCensus called before and after terminal");
  assert.equal(result.terminal.action, "viewer.destroy");
  assert.equal(result.terminal.destroyed, true);

  assert.deepEqual(result.owners.labels, ownerLabels);

  const beforeSeen = result.owners.before.find(
    (r) => r.label === "Global BathymetryTensorMap LUT",
  );
  const beforeUnseen = result.owners.before.find(
    (r) => r.label === "UnseenOwner",
  );
  assert.equal(beforeSeen.seen, true);
  assert.equal(beforeSeen.live, 3);
  assert.equal(beforeSeen.destroyed, 0);
  assert.equal(beforeSeen.liveBytes, 4096);
  assert.equal(beforeUnseen.seen, false);
  assert.equal(beforeUnseen.live, 0);

  const afterSeen = result.owners.after.find(
    (r) => r.label === "Global BathymetryTensorMap LUT",
  );
  const afterUnseen = result.owners.after.find(
    (r) => r.label === "UnseenOwner",
  );
  assert.equal(afterSeen.seen, true);
  assert.equal(afterSeen.live, 0);
  assert.equal(afterSeen.destroyed, 3);
  assert.equal(afterSeen.liveBytes, 0);
  assert.equal(afterUnseen.seen, false);
});

test("T2: runDeviceLossSteps reads owner rows before and after terminal action in forced-loss mode", async () => {
  const rig = { dials: {} };
  const ownerLabels = ["BathymetryLUT"];
  let censusCalls = 0;

  const readCensus = async () => {
    censusCalls++;
    return {
      byLabel: {
        b: {
          label: "BathymetryLUT",
          kind: "texture",
          created: 1,
          destroyed: 0,
          liveBytes: 1024,
        },
      },
    };
  };

  const page = makeStubPage();
  const settle = makeStubSettle();

  const result = await runDeviceLossSteps({
    page,
    rig,
    settle,
    mode: "forced-loss",
    readCensus,
    ownerLabels,
  });

  assert.equal(censusCalls, 2, "census read before and after terminal action");
  assert.equal(result.terminal.action, "GPUDevice.destroy");
  assert.equal(result.terminal.loss.renderer, "webgpu");
  assert.equal(result.terminal.rendered.framesAttempted, 30);
  assert.equal(result.owners.before.length, 1);
  assert.equal(result.owners.after.length, 1);
});

// ---------------------------------------------------------------------------
// T3. classifyConsoleErrors
// ---------------------------------------------------------------------------

test("T3: classifyConsoleErrors counts sentinel lines, other errors, page errors, and ignores warnings", () => {
  const lines = [
    {
      type: "error",
      text: "[WebGPU] Device lost (reason: destroyed): context was destroyed",
    },
    {
      type: "error",
      text: "[WebGPU] Device lost (reason: unknown): GPU hang",
    },
    {
      type: "error",
      text: "TypeError: Cannot read properties of undefined",
    },
    {
      type: "error",
      text: "Shader compilation failed: parse error at line 42",
    },
    {
      type: "pageerror",
      text: "Uncaught ReferenceError: Cesium is not defined",
    },
    {
      type: "warning",
      text: "WebGL: PERFORMANCE WARNING: Some warning",
    },
    {
      type: "info",
      text: "Cesium ready",
    },
    {
      type: "log",
      text: "Render loop tick",
    },
  ];

  const result = classifyConsoleErrors(lines);

  assert.equal(result.sentinel, 2, "2 sentinel error lines");
  assert.equal(result.errors, 4, "total 4 error lines (2 sentinel + 2 other)");
  assert.deepEqual(result.other, [
    "TypeError: Cannot read properties of undefined",
    "Shader compilation failed: parse error at line 42",
  ]);
  assert.deepEqual(result.pageErrors, [
    "Uncaught ReferenceError: Cesium is not defined",
  ]);

  assert.ok(DEVICE_LOSS_SENTINEL_RE.test("[WebGPU] Device lost (reason: foo)"));
});

test("T3: classifyConsoleErrors caps other error lines and page errors at five entries each", () => {
  const lines = [];
  for (let i = 1; i <= 8; i++) {
    lines.push({ type: "error", text: `Other error message ${i}` });
  }
  for (let i = 1; i <= 7; i++) {
    lines.push({ type: "pageerror", text: `Page exception ${i}` });
  }

  const result = classifyConsoleErrors(lines);

  assert.equal(result.errors, 8, "total 8 error lines counted");
  assert.equal(result.sentinel, 0);
  assert.equal(result.other.length, 5, "other errors capped at first 5");
  assert.deepEqual(result.other, [
    "Other error message 1",
    "Other error message 2",
    "Other error message 3",
    "Other error message 4",
    "Other error message 5",
  ]);

  assert.equal(result.pageErrors.length, 5, "pageErrors capped at first 5");
  assert.deepEqual(result.pageErrors, [
    "Page exception 1",
    "Page exception 2",
    "Page exception 3",
    "Page exception 4",
    "Page exception 5",
  ]);
});

test("T3: classifyConsoleErrors handles empty, null, or undefined lines cleanly", () => {
  const empty = {
    errors: 0,
    sentinel: 0,
    otherCount: 0,
    other: [],
    pageErrorCount: 0,
    pageErrors: [],
  };
  assert.deepEqual(classifyConsoleErrors([]), empty);
  assert.deepEqual(classifyConsoleErrors(null), empty);
  assert.deepEqual(classifyConsoleErrors(undefined), empty);
});

// ---------------------------------------------------------------------------
// T4. measureLandingPerformance (ROUND 2)
// ---------------------------------------------------------------------------

test("T4: measureLandingPerformance renders warm-up frames before first census snapshot and brackets measured frames (warmupFrames 30)", async () => {
  const trace = [];
  let censusCount = 0;

  const page = {
    async evaluate(fn, arg) {
      if (fn === pageSampleFrameTimes || fn?.name === "pageSampleFrameTimes") {
        trace.push({ type: "pageSampleFrameTimes", args: arg });
        if (arg?.warmupFrames > 0 && arg?.frames === 0) {
          return {
            renderer: "webgpu",
            frameMs: [],
            cpuMs: [],
            outcome: "done",
            phase: "warmup",
          };
        }
        return {
          renderer: "webgpu",
          frameMs: [16.6, 16.5],
          cpuMs: [2.1, 2.0],
          outcome: "done",
          phase: "measured",
        };
      }
      if (
        fn === pageSampleGpuPassCost ||
        fn?.name === "pageSampleGpuPassCost"
      ) {
        trace.push({ type: "pageSampleGpuPassCost", args: arg });
        return {
          available: true,
          passes: [{ name: "globe", totalMs: 5.1 }],
        };
      }
      throw new Error(`Unexpected evaluate call: ${fn?.name}`);
    },
  };

  const readCensus = async () => {
    censusCount++;
    trace.push({ type: "readCensus", snapshotId: censusCount });
    return { snapshotId: censusCount, liveBytes: 1024 * censusCount };
  };

  const result = await measureLandingPerformance({
    page,
    readCensus,
    frames: 60,
    warmupFrames: 30,
    passFrames: 10,
    workDoneTimeoutMs: 8000,
  });

  // Call sequence per BEHAVIOUR_CELOS.md T4:
  // 1. warm-up pageSampleFrameTimes with {frames: 0, warmupFrames: 30}
  // 2. readCensus (start)
  // 3. measured pageSampleFrameTimes with {frames: 60, warmupFrames: 0}
  // 4. readCensus (end)
  // 5. pageSampleGpuPassCost with passFrames > 0
  assert.equal(trace.length, 5, "expected 5 calls in total trace");

  assert.equal(
    trace[0].type,
    "pageSampleFrameTimes",
    "call 0 must be warm-up frame times",
  );
  assert.equal(
    trace[0].args.frames,
    0,
    "warm-up call must request 0 measured frames",
  );
  assert.equal(
    trace[0].args.warmupFrames,
    30,
    "warm-up call must pass N warmupFrames",
  );

  assert.equal(trace[1].type, "readCensus", "call 1 must be first census read");
  assert.equal(trace[1].snapshotId, 1);

  assert.equal(
    trace[2].type,
    "pageSampleFrameTimes",
    "call 2 must be measured frame times",
  );
  assert.equal(trace[2].args.frames, 60, "measured call must request F frames");
  assert.equal(
    trace[2].args.warmupFrames,
    0,
    "measured call must have warmupFrames: 0",
  );

  assert.equal(
    trace[3].type,
    "readCensus",
    "call 3 must be second census read",
  );
  assert.equal(trace[3].snapshotId, 2);

  assert.equal(
    trace[4].type,
    "pageSampleGpuPassCost",
    "call 4 must be GPU pass cost",
  );
  assert.equal(trace[4].args.frames, 10);

  // Return value assertions
  assert.ok(
    result.warmup !== null && typeof result.warmup === "object",
    "warmup must be present and non-null",
  );
  assert.equal(result.warmup.phase, "warmup");
  assert.equal(result.frameTimes.phase, "measured");
  assert.equal(result.census.start.snapshotId, 1);
  assert.equal(result.census.end.snapshotId, 2);
  assert.equal(result.passCost.available, true);
});

test("T4: measureLandingPerformance omits warm-up call and sets warmup to null when warmupFrames is 0", async () => {
  const trace = [];
  let censusCount = 0;

  const page = {
    async evaluate(fn, arg) {
      if (fn === pageSampleFrameTimes || fn?.name === "pageSampleFrameTimes") {
        trace.push({ type: "pageSampleFrameTimes", args: arg });
        return {
          renderer: "webgpu",
          frameMs: [16.6],
          cpuMs: [2.0],
          outcome: "done",
          phase: "measured",
        };
      }
      if (
        fn === pageSampleGpuPassCost ||
        fn?.name === "pageSampleGpuPassCost"
      ) {
        trace.push({ type: "pageSampleGpuPassCost", args: arg });
        return { available: true, passes: [] };
      }
      throw new Error(`Unexpected evaluate call: ${fn?.name}`);
    },
  };

  const readCensus = async () => {
    censusCount++;
    trace.push({ type: "readCensus", snapshotId: censusCount });
    return { snapshotId: censusCount };
  };

  const result = await measureLandingPerformance({
    page,
    readCensus,
    frames: 50,
    warmupFrames: 0,
    passFrames: 10,
  });

  // Call sequence per BEHAVIOUR_CELOS.md T4 when warmupFrames is 0:
  // 1. readCensus (start)
  // 2. measured pageSampleFrameTimes with {frames: 50, warmupFrames: 0}
  // 3. readCensus (end)
  // 4. pageSampleGpuPassCost
  assert.equal(trace.length, 4, "expected 4 calls when warmupFrames is 0");

  assert.equal(trace[0].type, "readCensus", "call 0 must be first census read");
  assert.equal(
    trace[1].type,
    "pageSampleFrameTimes",
    "call 1 must be measured frame times",
  );
  assert.equal(trace[1].args.frames, 50);
  assert.equal(trace[1].args.warmupFrames, 0);
  assert.equal(
    trace[2].type,
    "readCensus",
    "call 2 must be second census read",
  );
  assert.equal(
    trace[3].type,
    "pageSampleGpuPassCost",
    "call 3 must be pass cost",
  );

  assert.equal(
    result.warmup,
    null,
    "result.warmup must be null when warmupFrames is 0",
  );
  assert.equal(result.frameTimes.phase, "measured");
});

test("T4: measureLandingPerformance requests pass cost window only when passFrames > 0", async () => {
  const makeTimingPage = (trace) => ({
    async evaluate(fn, arg) {
      if (fn === pageSampleFrameTimes || fn?.name === "pageSampleFrameTimes") {
        trace.push({ type: "pageSampleFrameTimes", args: arg });
        return { renderer: "webgpu", frameMs: [], cpuMs: [], outcome: "done" };
      }
      if (
        fn === pageSampleGpuPassCost ||
        fn?.name === "pageSampleGpuPassCost"
      ) {
        trace.push({ type: "pageSampleGpuPassCost", args: arg });
        return { available: true, passes: [{ name: "draw", totalMs: 1.0 }] };
      }
      throw new Error(`Unexpected evaluate call: ${fn?.name}`);
    },
  });

  // Case A: passFrames is 0 -> pageSampleGpuPassCost is NOT called
  {
    const trace = [];
    const page = makeTimingPage(trace);
    const readCensus = async () => ({ bytes: 0 });

    const result = await measureLandingPerformance({
      page,
      readCensus,
      frames: 30,
      warmupFrames: 0,
      passFrames: 0,
    });

    const passCostCalls = trace.filter(
      (c) => c.type === "pageSampleGpuPassCost",
    );
    assert.equal(
      passCostCalls.length,
      0,
      "passCost must not be called when passFrames is 0",
    );
    assert.equal(result.passCost?.available, false);
  }

  // Case B: passFrames is 8 -> pageSampleGpuPassCost IS called
  {
    const trace = [];
    const page = makeTimingPage(trace);
    const readCensus = async () => ({ bytes: 0 });

    const result = await measureLandingPerformance({
      page,
      readCensus,
      frames: 30,
      warmupFrames: 0,
      passFrames: 8,
    });

    const passCostCalls = trace.filter(
      (c) => c.type === "pageSampleGpuPassCost",
    );
    assert.equal(
      passCostCalls.length,
      1,
      "passCost must be called when passFrames > 0",
    );
    assert.equal(passCostCalls[0].args.frames, 8);
    assert.equal(result.passCost?.available, true);
  }
});

// ---------------------------------------------------------------------------
// T5 (ROUND 4, F1): the terminal record's one reader. Lead addition (Celos).
// ---------------------------------------------------------------------------

test("T5: (ROUND 4, F1) a teardown whose viewer.destroy threw reads threw: true with the message", () => {
  const shape = terminalShape({
    action: "viewer.destroy",
    destroyed: false,
    threw: "Failed to execute 'removeChild' on 'Node'",
  });
  assert.equal(shape.threw, true);
  assert.equal(shape.message, "Failed to execute 'removeChild' on 'Node'");
  assert.equal(shape.destroyed, false);
  assert.equal(shape.action, "viewer.destroy");
});

test("T5: (ROUND 4, F1) a teardown that returned reads threw: false and no message", () => {
  const shape = terminalShape({
    action: "viewer.destroy",
    destroyed: true,
    threw: null,
  });
  assert.equal(shape.threw, false);
  assert.equal(shape.message, null);
  assert.equal(shape.destroyed, true);
});

test("T5: (ROUND 4, F1) a forced loss reads the render-throw count and its first message", () => {
  const threw = terminalShape({
    action: "GPUDevice.destroy",
    loss: { observed: { reason: "destroyed" } },
    rendered: {
      framesAttempted: 30,
      throws: 2,
      firstThrows: ["render after loss", "again"],
      terminallyLost: true,
    },
  });
  assert.equal(threw.threw, true);
  assert.equal(threw.message, "render after loss");
  assert.equal(threw.terminallyLost, true);
  assert.equal(threw.lossObserved, true);
  const clean = terminalShape({
    action: "GPUDevice.destroy",
    loss: { observed: null },
    rendered: { framesAttempted: 30, throws: 0, firstThrows: [] },
  });
  assert.equal(clean.threw, false);
  assert.equal(clean.lossObserved, false);
});

test("T5: (ROUND 4, F1) the record runDeviceLossSteps returns for a throwing teardown reads threw: true", async () => {
  const page = makeStubPage({
    handlers: {
      pageDestroyViewer: () => ({
        destroyed: false,
        threw: "Failed to execute 'removeChild' on 'Node'",
      }),
    },
  });
  const result = await runDeviceLossSteps({
    page,
    rig: { dials: {} },
    settle: async () => {},
    mode: "teardown",
  });
  assert.equal(terminalShape(result.terminal).threw, true);
  assert.match(terminalShape(result.terminal).message, /removeChild/);
});

test("T5: (ROUND 4, F1) sameTerminal ignores the message text and compares the rest", () => {
  const a = terminalShape({
    action: "viewer.destroy",
    destroyed: false,
    threw: "x at line 1",
  });
  const b = terminalShape({
    action: "viewer.destroy",
    destroyed: false,
    threw: "x at line 2",
  });
  const c = terminalShape({
    action: "viewer.destroy",
    destroyed: true,
    threw: null,
  });
  assert.equal(sameTerminal(a, b), true);
  assert.equal(sameTerminal(a, c), false);
});
