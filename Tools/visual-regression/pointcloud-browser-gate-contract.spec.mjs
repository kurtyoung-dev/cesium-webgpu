// pointcloud-browser-gate-contract.spec.mjs — browser-free verdict contracts.
// @purpose Executes point-cloud browser-gate decision functions against raw synthetic counters and mutation teeth without launching a browser.
// @status ACTIVE

import assert from "node:assert/strict";
import test from "node:test";

import {
  POINTCLOUD_COLOR_FORMATS,
  POINTCLOUD_COLOR_PROBE_BUDGETS,
  evaluatePointCloudColorRunGate,
  pointCloudColorLocalEntryReasons,
  pointCloudColorServedEntryReasons,
  scorePointCloudColorControls,
  scorePointCloudColorFormats,
} from "./probe-pointcloud-color-formats.mjs";
import {
  POINTCLOUD_DRACO_TIMEDYNAMIC_BUDGET,
  POINTCLOUD_DRACO_TIMEDYNAMIC_CONFIG,
  POINTCLOUD_DRACO_TIMEDYNAMIC_SCHEMA,
  evaluatePointcloudDracoTimedynamic,
} from "./probe-pointcloud-draco-timedynamic.mjs";
import {
  POINT_SPRITE_TINT_REPEAT_BUDGET,
  POINT_SPRITE_TINT_REPEAT_SCHEMA,
  evaluatePointSpriteTintRepeat,
} from "./probe-point-sprite-tint-repeat.mjs";

function colorRuntime(featureRendererPresent) {
  return {
    ready: true,
    readyIteration: 2,
    renderIterations: 3,
    waitedMs: 12,
    pointsLength: 1000,
    featureRendererPresent,
  };
}

function colorLeg(translucent) {
  const leg = {
    webgl: {
      nonBackgroundPixelCount: 100,
      channelSampleCount: 100,
      channelSums: [10_000, 12_000, 8_000],
    },
    webgpu: {
      nonBackgroundPixelCount: 100,
      channelSampleCount: 100,
      channelSums: [10_000, 12_000, 8_000],
    },
    mismatch: {
      downsampleFactor: 4,
      channelTolerance: 40,
      mismatchedCellCount: 0,
      comparedCellCount: 100,
    },
    runtime: {
      webgl: colorRuntime(false),
      webgpu: colorRuntime(true),
    },
  };
  if (translucent) {
    leg.alpha = {
      webgl: {
        visiblePixelCount: 100,
        alphaDependentPixelCount: 80,
        transmissionSum: 60,
      },
      webgpu: {
        visiblePixelCount: 100,
        alphaDependentPixelCount: 80,
        transmissionSum: 60,
      },
    };
  }
  return leg;
}

function validColorInput() {
  return {
    captureContract: {
      canonical: true,
      singleBlock: true,
      usageValid: true,
      writeOnce: true,
    },
    cleanup: { complete: true },
    harnessErrors: [],
    backend: {
      webglRendererType: "webgl",
      webgpuRendererType: "webgpu",
      webgpuErrorGateArmedDevices: 1,
    },
    legs: Object.fromEntries(
      POINTCLOUD_COLOR_FORMATS.map((format) => [
        format.id,
        colorLeg(format.translucent),
      ]),
    ),
  };
}

function colorControlScenario(target) {
  const input = validColorInput();
  input.legs[target].mismatch.mismatchedCellCount = 100;
  input.controlMutation = {
    target,
    preRealization: true,
    changedUnits: 1,
    mutation: `synthetic-${target}-decoder-substitution`,
  };
  return input;
}

function validDecoder() {
  return {
    status: 200,
    redirected: false,
    bodyBytes: 285_948,
    magicHex: "0061736d",
    persisted: true,
    sha256: "a".repeat(64),
  };
}

function validDracoRuntime(rendererType) {
  return {
    rendererType,
    intervalCount: 5,
    fixtureUriCount: 5,
    gpuGateArmedDevices: rendererType === "webgpu" ? 1 : 0,
    readyRenderIteration: 4,
    readyIntervalIndex: 0,
    readySceneFrameNumber: 9,
    readinessRenderCount: 5,
    readinessElapsedMs: 120,
    readinessBudgetMs: POINTCLOUD_DRACO_TIMEDYNAMIC_CONFIG.readinessBudgetMs,
    boundingSphereRadius: 4,
    totalMemoryUsageInBytes: 16_064,
    requestedFrameCount: 1,
    readyFrameCount: 1,
    frameFailedCount: 0,
  };
}

function validDracoPixels() {
  return {
    width: 600,
    height: 600,
    totalPixels: 360_000,
    nonBackgroundPixels: 100,
    channelSums: [10_000, 10_000, 10_000],
  };
}

function validDracoInput() {
  return {
    schema: POINTCLOUD_DRACO_TIMEDYNAMIC_SCHEMA,
    captureContract: {
      canonical: true,
      singleBlock: true,
      usageValid: true,
      writeOnce: true,
    },
    decoder: validDecoder(),
    cleanup: { complete: true },
    harnessErrors: [],
    fixtureResponses: [
      {
        renderer: "webgl",
        url: "http://localhost/fixtures/0.pnts",
        status: 200,
      },
    ],
    servedEntryIdentity: { ok: true, reasons: [] },
    webgl: {
      runtime: validDracoRuntime("webgl"),
      pixels: validDracoPixels(),
    },
    webgpu: {
      runtime: validDracoRuntime("webgpu"),
      pixels: validDracoPixels(),
    },
    parity: {
      comparedCells: 100,
      rawMismatchedCells: 0,
      normalizedMismatchedCells: 0,
      channelGains: [1, 1, 1],
      webglChannelMeans: [100, 100, 100],
      webgpuChannelMeans: [100, 100, 100],
    },
  };
}

const NON_MONOTONE_GAINS = Object.freeze([
  1, 1.01, 0.995, 1.005, 0.99, 1.015, 1,
]);

function validTintInput(
  gainSequences = [NON_MONOTONE_GAINS, NON_MONOTONE_GAINS, NON_MONOTONE_GAINS],
) {
  const subjectSum = 10_000;
  return {
    schema: POINT_SPRITE_TINT_REPEAT_SCHEMA,
    captureContract: {
      canonical: true,
      singleBlock: true,
      usageValid: true,
      writeOnce: true,
    },
    cleanup: { complete: true },
    provenance: { servedEntryIdentity: { ok: true, reasons: [] } },
    harnessErrors: [],
    session: { browserLaunches: 1, contexts: 1, pages: 2 },
    runtime: {
      webgl: { rendererType: "webgl", ready: true },
      webgpu: {
        rendererType: "webgpu",
        ready: true,
        gpuGateArmedDevices: 1,
      },
    },
    samples: Array.from({ length: 7 }, (_, index) => ({
      index,
      dimensions: {
        webgl: { width: 600, height: 600 },
        webgpu: { width: 600, height: 600 },
      },
      captureFrames: {
        webgl: { before: index * 2, after: index * 2 + 1, sequence: index },
        webgpu: {
          before: index * 2 + 20,
          after: index * 2 + 21,
          sequence: index,
        },
      },
      webglNonBackgroundPixels: 100,
      webgpuNonBackgroundPixels: 100,
      rawDs4: {
        factor: 4,
        width: 150,
        height: 150,
        skippedRows: 15,
        litCellCount: 100,
        webglChannelSums: gainSequences.map(
          (sequence) => sequence[index] * subjectSum,
        ),
        webgpuChannelSums: [subjectSum, subjectSum, subjectSum],
      },
    })),
  };
}

test("probe inner budgets fit inside their run watchdogs", () => {
  const color = POINTCLOUD_COLOR_PROBE_BUDGETS;
  assert.equal(color.positiveLegCount, color.backendCount * color.formatCount);
  assert.equal(color.controlLegCount, color.formatCount * color.formatCount);
  assert.equal(
    color.totalLegCount,
    color.positiveLegCount + color.controlLegCount,
  );
  assert.equal(color.webglLegCount, color.formatCount);
  assert.equal(color.webgpuLegCount, color.formatCount + color.controlLegCount);
  assert.deepEqual(color.pageMeasurementTimeoutMs, {
    webgl:
      color.pageMeasurementSetupTimeoutMs +
      color.webglLegCount * color.colorLegTimeoutMs,
    webgpu:
      color.pageMeasurementSetupTimeoutMs +
      color.webgpuLegCount * color.colorLegTimeoutMs,
  });
  const colorDerived =
    color.backendCount * color.backendSessionSetupTimeoutMs +
    color.backendCount *
      color.navigationStagesPerBackend *
      color.navigationTimeoutMs +
    color.pageMeasurementTimeoutMs.webgl +
    color.pageMeasurementTimeoutMs.webgpu +
    color.webgpuArmOperations * color.webgpuArmTimeoutMs +
    color.diagnosticsOperations * color.diagnosticsTimeoutMs +
    color.backendCount * color.servedEntryTimeoutMs +
    color.backendCount *
      color.sessionCloseStagesPerBackend *
      color.sessionCloseTimeoutMs +
    color.browserCloseStages * color.browserCloseTimeoutMs;
  assert.equal(color.worstCaseRunMs, colorDerived);
  assert.ok(color.worstCaseRunMs < color.runWatchdogMs);
  assert.equal(
    color.worstCaseProcessMs,
    color.browserLaunchTimeoutMs + color.worstCaseRunMs,
  );
  assert.ok(color.worstCaseProcessMs < color.processWatchdogMs);

  const tint = POINT_SPRITE_TINT_REPEAT_BUDGET;
  const tintDerived =
    tint.contextCreationTimeoutMs +
    tint.backendCount * tint.backendInitializationTimeoutMs +
    tint.backendCount * tint.repeatCount * tint.captureTimeoutMs +
    tint.backendCount * tint.diagnosticsTimeoutMs +
    tint.cleanupWorstCaseMs;
  assert.equal(tint.worstCaseRunMs, tintDerived);
  assert.ok(tint.worstCaseRunMs < tint.runWatchdogMs);
  assert.equal(
    tint.worstCaseProcessMs,
    tint.browserLaunchTimeoutMs + tint.worstCaseRunMs,
  );
  assert.ok(tint.worstCaseProcessMs < tint.processWatchdogMs);

  const draco = POINTCLOUD_DRACO_TIMEDYNAMIC_BUDGET;
  const dracoDerived =
    draco.backendCount *
      (draco.setupOperationsPerBackend * draco.setupTimeoutMs +
        draco.navigationOperationsPerBackend * draco.navigationTimeoutMs +
        draco.pageMeasurementTimeoutMs +
        draco.servedEntryTimeoutMs +
        draco.diagnosticOperationsPerBackend * draco.diagnosticTimeoutMs +
        draco.sessionCloseOperationsPerBackend * draco.sessionCloseTimeoutMs) +
    draco.browserCloseOperations * draco.browserCloseTimeoutMs;
  assert.equal(draco.worstCaseRunMs, dracoDerived);
  assert.ok(draco.worstCaseRunMs < draco.runWatchdogMs);
  assert.equal(
    draco.worstCaseProcessMs,
    draco.decoderFetchTimeoutMs +
      draco.browserLaunchTimeoutMs +
      draco.worstCaseRunMs,
  );
  assert.ok(draco.worstCaseProcessMs < draco.processWatchdogMs);
});

test("all three pure evaluators use the frozen PASS/FAIL/ERROR/STRUCTURAL exit tiers", () => {
  const colorPass = validColorInput();
  const colorFail = validColorInput();
  colorFail.legs.rgb.mismatch.mismatchedCellCount = 100;
  const colorError = validColorInput();
  colorError.harnessErrors.push("synthetic harness error");
  const colorStructural = validColorInput();
  colorStructural.backend.webgpuRendererType = "webgl";

  const dracoPass = validDracoInput();
  const dracoFail = validDracoInput();
  dracoFail.webgpu.runtime.readyRenderIteration = -1;
  dracoFail.webgpu.runtime.readyIntervalIndex = -1;
  dracoFail.webgpu.runtime.readySceneFrameNumber = -1;
  dracoFail.webgpu.runtime.boundingSphereRadius = 0;
  dracoFail.webgpu.runtime.totalMemoryUsageInBytes = 0;
  dracoFail.webgpu.runtime.readyFrameCount = 0;
  const dracoError = validDracoInput();
  dracoError.harnessErrors.push("synthetic harness error");
  const dracoStructural = validDracoInput();
  dracoStructural.decoder.status = 404;

  const tintPass = validTintInput();
  const tintFail = validTintInput();
  tintFail.samples[0].rawDs4.webglChannelSums[0] = 9_600;
  const tintError = validTintInput();
  tintError.harnessErrors.push("synthetic harness error");
  const tintStructural = validTintInput();
  tintStructural.session.pages = 1;

  for (const [name, evaluate, fixtures] of [
    [
      "color",
      scorePointCloudColorFormats,
      [colorPass, colorFail, colorError, colorStructural],
    ],
    [
      "draco",
      evaluatePointcloudDracoTimedynamic,
      [dracoPass, dracoFail, dracoError, dracoStructural],
    ],
    [
      "tint",
      evaluatePointSpriteTintRepeat,
      [tintPass, tintFail, tintError, tintStructural],
    ],
  ]) {
    assert.deepEqual(
      fixtures.map((fixture) => {
        const result = evaluate(fixture);
        return [result.status, result.exitCode];
      }),
      [
        ["PASS", 0],
        ["FAIL", 1],
        ["ERROR", 2],
        ["STRUCTURAL", 3],
      ],
      name,
    );
  }
});

test("color tooth: all four decoder substitutions make exactly their target red", () => {
  const scenarios = Object.fromEntries(
    POINTCLOUD_COLOR_FORMATS.map(({ id }) => [id, colorControlScenario(id)]),
  );
  const result = scorePointCloudColorControls(scenarios);
  assert.equal(result.valid, true);
  for (const { id } of POINTCLOUD_COLOR_FORMATS) {
    assert.deepEqual(result.results[id].redLegs, [id]);
    assert.equal(result.results[id].greenLegs.length, 3);
    assert.equal(result.results[id].mutationValid, true);
  }
});

test("color tooth: collateral red in another format invalidates isolation", () => {
  const scenarios = Object.fromEntries(
    POINTCLOUD_COLOR_FORMATS.map(({ id }) => [id, colorControlScenario(id)]),
  );
  scenarios.rgb.legs.rgba.mismatch.mismatchedCellCount = 100;
  const result = scorePointCloudColorControls(scenarios);
  assert.equal(result.valid, false);
  assert.deepEqual(result.results.rgb.redLegs, ["rgb", "rgba"]);
});

test("color tooth: a control that reddens the wrong leg is not isolation", () => {
  const scenarios = Object.fromEntries(
    POINTCLOUD_COLOR_FORMATS.map((format) => [
      format.id,
      colorControlScenario(format.id),
    ]),
  );
  // The rgb control must redden rgb. Redirect its only red onto rgba and
  // leave rgb green: the leg count still reads one red and three green, so
  // only the target-identity clause can tell this apart from isolation.
  scenarios.rgb.legs.rgb.mismatch.mismatchedCellCount = 0;
  scenarios.rgb.legs.rgba.mismatch.mismatchedCellCount = 100;
  const result = scorePointCloudColorControls(scenarios);
  assert.deepEqual(result.results.rgb.redLegs, ["rgba"]);
  assert.equal(result.results.rgb.greenLegs.length, 3);
  assert.equal(result.results.rgb.isolated, false);
  assert.equal(result.valid, false);
});

test("color tooth: translucent counters carry the alpha decision", () => {
  const input = validColorInput();
  input.legs.rgba.alpha.webgpu.alphaDependentPixelCount = 0;
  input.legs.rgba.alpha.webgpu.transmissionSum = 0;
  const result = scorePointCloudColorFormats(input);
  assert.equal(result.status, "FAIL");
  assert.ok(result.failures.some((reason) => reason.includes("rgba")));
});

test("color tooth: the dedicated WebGPU point-cloud route is load-bearing", () => {
  const input = validColorInput();
  input.legs.rgb.runtime.webgpu.featureRendererPresent = false;
  const result = scorePointCloudColorFormats(input);
  assert.equal(result.status, "FAIL");
  assert.ok(
    result.failures.some((reason) =>
      reason.includes("dedicated point-cloud feature renderer"),
    ),
  );
});

test("color inertness tooth: narrated green cannot override red counters", () => {
  const input = validColorInput();
  input.legs.rgb.status = "PASS";
  input.legs.rgb.passes = true;
  input.legs.rgb.mismatch.mismatchedCellCount = 100;
  assert.equal(scorePointCloudColorFormats(input).status, "FAIL");
});

test("draco tooth: a missing served decoder is STRUCTURAL, never FAIL", () => {
  const input = validDracoInput();
  input.decoder.status = 404;
  const result = evaluatePointcloudDracoTimedynamic(input);
  assert.equal(result.status, "STRUCTURAL");
  assert.equal(result.exitCode, 3);
  assert.equal(result.failures.length, 0);
});

test("draco tooth: a missing point fixture is STRUCTURAL, never FAIL", () => {
  const input = validDracoInput();
  input.fixtureResponses[0].status = 404;
  const result = evaluatePointcloudDracoTimedynamic(input);
  assert.equal(result.status, "STRUCTURAL");
  assert.equal(result.exitCode, 3);
  assert.equal(result.failures.length, 0);
  assert.ok(
    result.structural.some((reason) => reason.includes("fixture-status-404")),
  );
});

test("draco tooth: a served build mismatch is STRUCTURAL before product scoring", () => {
  const input = validDracoInput();
  input.servedEntryIdentity = {
    ok: false,
    reasons: ["webgpu: served runtime entry differs from disk"],
  };
  input.webgpu.pixels.nonBackgroundPixels = 0;
  const result = evaluatePointcloudDracoTimedynamic(input);
  assert.equal(result.status, "STRUCTURAL");
  assert.equal(result.failures.length, 0);
});

test("draco tooth: bounded readiness exhaustion is a product FAIL", () => {
  const input = validDracoInput();
  Object.assign(input.webgpu.runtime, {
    readyRenderIteration: -1,
    readyIntervalIndex: -1,
    readySceneFrameNumber: -1,
    readinessElapsedMs: POINTCLOUD_DRACO_TIMEDYNAMIC_CONFIG.readinessBudgetMs,
    boundingSphereRadius: 0,
    totalMemoryUsageInBytes: 0,
    readyFrameCount: 0,
  });
  const result = evaluatePointcloudDracoTimedynamic(input);
  assert.equal(result.status, "FAIL");
  assert.ok(result.failures.some((reason) => reason.includes("60000/60000ms")));
});

test("draco inertness tooth: narrated readiness cannot hide zero pixels", () => {
  const input = validDracoInput();
  input.webgpu.runtime.ready = true;
  input.webgpu.pixels.nonBackgroundPixels = 0;
  input.webgpu.pixels.channelSums = [0, 0, 0];
  const result = evaluatePointcloudDracoTimedynamic(input);
  assert.equal(result.status, "FAIL");
  assert.ok(result.failures.includes("webgpu:pixels:no-rendered-content"));
});

test("draco tooth: excessive persisted parity mismatch is a FAIL", () => {
  const input = validDracoInput();
  input.parity.normalizedMismatchedCells = 16;
  const result = evaluatePointcloudDracoTimedynamic(input);
  assert.equal(result.status, "FAIL");
  assert.ok(result.failures.includes("parity:normalized-mismatch-over-limit"));
});

test("draco tooth: frame-load failures remain visible after readiness", () => {
  const input = validDracoInput();
  input.webgpu.runtime.frameFailedCount = 1;
  const result = evaluatePointcloudDracoTimedynamic(input);
  assert.equal(result.status, "FAIL");
  assert.ok(result.failures.includes("webgpu:runtime:frame-load-failures"));
});

test("tint tooth: a strictly increasing seven-sample channel is a FAIL", () => {
  const increasing = [0.98, 0.985, 0.99, 0.995, 1, 1.005, 1.01];
  const result = evaluatePointSpriteTintRepeat(
    validTintInput([increasing, NON_MONOTONE_GAINS, NON_MONOTONE_GAINS]),
  );
  assert.equal(result.status, "FAIL");
  assert.equal(result.channelSequences[0].direction, "increasing");
});

test("tint tooth: a strictly decreasing seven-sample channel is a FAIL", () => {
  const decreasing = [1.02, 1.015, 1.01, 1.005, 1, 0.995, 0.99];
  const result = evaluatePointSpriteTintRepeat(
    validTintInput([NON_MONOTONE_GAINS, decreasing, NON_MONOTONE_GAINS]),
  );
  assert.equal(result.status, "FAIL");
  assert.equal(result.channelSequences[1].direction, "decreasing");
});

test("tint tooth: a non-monotone seven-sample sequence inside the band passes", () => {
  const result = evaluatePointSpriteTintRepeat(validTintInput());
  assert.equal(result.status, "PASS");
  assert.deepEqual(
    result.samples.map((sample) => sample.gains),
    Array.from({ length: 7 }, (_, index) => [
      NON_MONOTONE_GAINS[index],
      NON_MONOTONE_GAINS[index],
      NON_MONOTONE_GAINS[index],
    ]),
  );
});

test("tint tooth: structured harness errors remain diagnosable", () => {
  const input = validTintInput();
  const structured = {
    name: "SyntheticCaptureError",
    message: "capture failed",
    stack: "SyntheticCaptureError: capture failed\n    at synthetic",
  };
  input.harnessErrors = [structured, "plain string"];
  const result = evaluatePointSpriteTintRepeat(input);
  assert.equal(result.status, "ERROR");
  assert.deepEqual(result.harnessErrors, [structured, "plain string"]);
});

test("tint tooth: a served build mismatch is STRUCTURAL before gain scoring", () => {
  const input = validTintInput();
  input.provenance.servedEntryIdentity = {
    ok: false,
    reasons: ["webgpu: served runtime entry differs from disk"],
  };
  const result = evaluatePointSpriteTintRepeat(input);
  assert.equal(result.status, "STRUCTURAL");
  assert.equal(result.exitCode, 3);
  assert.deepEqual(result.samples, []);
  assert.deepEqual(result.failures, []);
});

test("tint inertness tooth: narrated gains cannot override an out-of-band raw sum", () => {
  const input = validTintInput();
  input.samples[3].gains = [1, 1, 1];
  input.samples[3].passes = true;
  input.samples[3].monotone = false;
  input.samples[3].rawDs4.webglChannelSums[2] = 10_400;
  const result = evaluatePointSpriteTintRepeat(input);
  assert.equal(result.status, "FAIL");
  assert.ok(result.failures.includes("sample-3:blue-gain-out-of-band"));
});

test("colour tooth: a served build mismatch is STRUCTURAL before any scoring", () => {
  const gate = evaluatePointCloudColorRunGate({
    captureFailures: [],
    localEntryValidation: { ok: true, reasons: [] },
    servedEntryValidation: {
      ok: false,
      reasons: ["webgpu: served runtime entry differs from disk"],
    },
    harnessErrors: [],
  });
  assert.equal(gate.status, "STRUCTURAL");
  assert.equal(gate.exitCode, 3);
  assert.deepEqual(gate.structural, [
    "webgpu: served runtime entry differs from disk",
  ]);
});

test("colour tooth: the local-entry preflight reaches the same gate", () => {
  const gate = evaluatePointCloudColorRunGate({
    captureFailures: [],
    localEntryValidation: { ok: false, reasons: ["local build entry absent"] },
    servedEntryValidation: null,
    harnessErrors: [],
  });
  assert.equal(gate.status, "STRUCTURAL");
  assert.deepEqual(gate.structural, ["local build entry absent"]);
  assert.deepEqual(
    pointCloudColorLocalEntryReasons({ ok: false, reasons: ["x"] }),
    ["x"],
  );
  assert.deepEqual(
    pointCloudColorLocalEntryReasons({ ok: true, reasons: [] }),
    [],
  );
});

test("colour tooth: capture-contract failures still route through the gate", () => {
  const gate = evaluatePointCloudColorRunGate({
    captureFailures: ["capture:not-write-once"],
    localEntryValidation: { ok: true, reasons: [] },
    servedEntryValidation: { ok: true, reasons: [] },
    harnessErrors: [],
  });
  assert.equal(gate.status, "STRUCTURAL");
  assert.deepEqual(gate.structural, ["capture:not-write-once"]);
});

test("colour tooth: harness errors promote a structural run to ERROR", () => {
  const gate = evaluatePointCloudColorRunGate({
    captureFailures: [],
    localEntryValidation: { ok: true, reasons: [] },
    servedEntryValidation: { ok: false, reasons: ["mismatch"] },
    harnessErrors: ["webgpu:device-lost"],
  });
  assert.equal(gate.status, "ERROR");
  assert.equal(gate.exitCode, 2);
});

test("colour tooth: a proven run proceeds, so the gate is not vacuously structural", () => {
  const gate = evaluatePointCloudColorRunGate({
    captureFailures: [],
    localEntryValidation: { ok: true, reasons: [] },
    servedEntryValidation: { ok: true, reasons: [] },
    harnessErrors: [],
  });
  assert.equal(gate.status, "PROCEED");
  assert.deepEqual(gate.structural, []);
});

test("colour inertness tooth: an unproven served entry cannot yield a reasonless STRUCTURAL", () => {
  const gate = evaluatePointCloudColorRunGate({
    captureFailures: [],
    localEntryValidation: { ok: true, reasons: [] },
    servedEntryValidation: { ok: false, reasons: [] },
    harnessErrors: [],
  });
  assert.equal(gate.status, "STRUCTURAL");
  assert.deepEqual(gate.structural, ["served-entry-identity-unproven"]);
  assert.deepEqual(pointCloudColorServedEntryReasons(null), []);
});
