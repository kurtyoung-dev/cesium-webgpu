import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  GLOBE_CAMERA_TRACK,
  GLOBE_CAMERA_TRACK_DURATION_SECONDS,
  GLOBE_CAMERA_TRACK_ID,
} from "./lib/globe-camera-track.mjs";
import {
  assessPerformanceRunQuality,
  assessPerformanceRunStability,
  buildCounterbalancedSchedule,
  diffCounterLabelSnapshots,
  diffFlatCounterSnapshots,
  selectLongTasksInMeasurementWindow,
  summarizeFramePacing,
  summarizeMovingPickMetrics,
  summarizeTrackMetrics,
} from "./lib/performance-campaign-utils.mjs";
import { buildPerformanceViewerUrl } from "./lib/performance-viewer-url.mjs";
import {
  renderersForWorkload,
  selectWorkloadsForRenderers,
} from "./lib/performance-workload-selection.mjs";
import resolveCesiumViewerStartupOptions from "../../Apps/CesiumViewer/CesiumViewerStartupOptions.js";

const directory = dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(
  await readFile(resolve(directory, "performance-workloads.json"), "utf8"),
);
const schema = JSON.parse(
  await readFile(
    resolve(directory, "performance-workloads.schema.json"),
    "utf8",
  ),
);

test("performance workload manifest has stable unique identities", () => {
  assert.equal(manifest.schemaVersion, 1);
  assert.match(manifest.id, /^[a-z0-9-]+$/);
  const ids = manifest.workloads.map((workload) => workload.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const id of ids) {
    assert.match(id, /^[a-z0-9-]+$/);
  }
});

test("performance protocol is bounded and not an FPS-only smoke", () => {
  assert.ok(manifest.protocol.warmupFrames >= 1);
  assert.ok(manifest.protocol.measuredFrames >= 600);
  assert.ok(manifest.protocol.settleStableFrames >= 1);
  assert.ok(manifest.protocol.settleTimeoutMs >= 1);
  assert.ok(manifest.protocol.repetitions >= 3);
  assert.ok(manifest.protocol.counterbalancedPairs >= 6);
  assert.equal(manifest.protocol.browser, "msedge");
  assert.equal(manifest.protocol.viewport.deviceScaleFactor, 1);
});

test("manifest covers core hot-path states with local deterministic content", () => {
  const actions = new Set(
    manifest.workloads.map((workload) => workload.action),
  );
  for (const required of [
    "static",
    "orbit",
    "camera-track",
    "camera-track-pick",
    "sparse-point-mutation",
    "full-point-mutation",
    "pick-center",
    "resize-cycle",
    "morph-roundtrip",
    "destroy-recreate-content",
  ]) {
    assert.ok(actions.has(required), `missing action ${required}`);
  }
  const modes = new Set(manifest.workloads.map((workload) => workload.mode));
  assert.deepEqual(modes, new Set(["3d", "2d", "columbus"]));
  assert.equal(new globalThis.URL(manifest.baseUrl).hostname, "localhost");
  for (const workload of manifest.workloads) {
    assert.ok(["globe-only", "points-4096"].includes(workload.content));
    assert.equal(workload.contentProfile, "local-grid-ellipsoid");
    assert.ok(
      ["deterministic-core", "default-globe", "volumetric-clouds"].includes(
        workload.featureProfile,
      ),
    );
    if (workload.renderers !== undefined) {
      assert.ok(workload.renderers.length > 0);
      assert.equal(new Set(workload.renderers).size, workload.renderers.length);
      assert.ok(
        workload.renderers.every((renderer) =>
          ["webgl", "webgpu"].includes(renderer),
        ),
      );
    }
  }
});

test("performance navigation opts into deterministic offline viewer boot", () => {
  const url = buildPerformanceViewerUrl(
    `${manifest.baseUrl}?existing=preserved`,
    "webgpu",
  );
  assert.equal(url.searchParams.get("existing"), "preserved");
  assert.equal(url.searchParams.get("renderer"), "webgpu");
  assert.equal(url.searchParams.get("offline"), "true");
});

test("offline viewer boot creates no online startup resources", () => {
  const calls = [];
  const options = resolveCesiumViewerStartupOptions(
    {
      offline: "true",
      tmsImageryUrl: "https://example.invalid/tiles",
      scene3DOnly: "true",
    },
    {
      createTmsBaseLayer: () => calls.push("tms"),
      createWorldTerrain: () => calls.push("terrain"),
    },
  );

  assert.deepEqual(calls, []);
  assert.deepEqual(options, {
    baseLayer: false,
    hasBaseLayerPicker: false,
    terrain: undefined,
    scene3DOnly: "true",
    requestRenderMode: true,
  });
});

test("normal viewer boot preserves world and credentialed TMS paths", () => {
  const worldTerrain = { id: "world-terrain" };
  const defaultCalls = [];
  const defaultOptions = resolveCesiumViewerStartupOptions(
    {},
    {
      createTmsBaseLayer: () => defaultCalls.push("tms"),
      createWorldTerrain: () => {
        defaultCalls.push("terrain");
        return worldTerrain;
      },
    },
  );
  assert.deepEqual(defaultCalls, ["terrain"]);
  assert.equal(defaultOptions.baseLayer, undefined);
  assert.equal(defaultOptions.hasBaseLayerPicker, true);
  assert.equal(defaultOptions.terrain, worldTerrain);

  const tmsLayer = { id: "tms-layer" };
  const tmsCalls = [];
  const tmsOptions = resolveCesiumViewerStartupOptions(
    { offline: "false", tmsImageryUrl: "https://tiles.example.test" },
    {
      createTmsBaseLayer: (url) => {
        tmsCalls.push(["tms", url]);
        return tmsLayer;
      },
      createWorldTerrain: () => {
        tmsCalls.push(["terrain"]);
        return worldTerrain;
      },
    },
  );
  assert.deepEqual(tmsCalls, [
    ["tms", "https://tiles.example.test"],
    ["terrain"],
  ]);
  assert.equal(tmsOptions.baseLayer, tmsLayer);
  assert.equal(tmsOptions.hasBaseLayerPicker, false);
  assert.equal(tmsOptions.terrain, worldTerrain);
});

test("altitude flight workload uses the shared complete route", () => {
  const workload = manifest.workloads.find(
    (entry) => entry.action === "camera-track",
  );
  assert.ok(workload);
  assert.equal(workload.trackId, GLOBE_CAMERA_TRACK_ID);
  assert.equal(workload.featureProfile, "default-globe");
  assert.equal(workload.measuredSeconds, GLOBE_CAMERA_TRACK_DURATION_SECONDS);
  assert.ok(
    schema.properties.workloads.items.properties.action.enum.includes(
      "camera-track",
    ),
  );

  assert.equal(GLOBE_CAMERA_TRACK.length, 9);
  assert.equal(
    new Set(GLOBE_CAMERA_TRACK.map((waypoint) => waypoint.name)).size,
    9,
  );
  const heights = GLOBE_CAMERA_TRACK.map((waypoint) => waypoint.height);
  assert.equal(Math.max(...heights), 18_000_000);
  assert.equal(Math.min(...heights), 300);
  assert.equal(GLOBE_CAMERA_TRACK.at(-1).name, "orbit-himalaya");
});

test("continuous pick workload combines the altitude route with cursor motion", () => {
  const workload = manifest.workloads.find(
    (entry) => entry.action === "camera-track-pick",
  );
  assert.ok(workload);
  assert.equal(workload.id, "moving-pick-camera-altitude-track-3d");
  assert.equal(workload.trackId, GLOBE_CAMERA_TRACK_ID);
  assert.equal(workload.featureProfile, "default-globe");
  assert.equal(workload.content, "points-4096");
  assert.equal(workload.measuredSeconds, GLOBE_CAMERA_TRACK_DURATION_SECONDS);
  assert.ok(
    schema.properties.workloads.items.properties.action.enum.includes(
      "camera-track-pick",
    ),
  );
  const trackRequirement = schema.properties.workloads.items.allOf[0];
  assert.ok(
    trackRequirement.if.properties.action.enum.includes("camera-track-pick"),
  );
  assert.deepEqual(trackRequirement.then.required, [
    "trackId",
    "measuredSeconds",
  ]);
});

test("volumetric-cloud workload uses the moving route and WebGPU only", () => {
  const workload = manifest.workloads.find(
    (entry) => entry.id === "moving-camera-cloud-altitude-track-3d",
  );
  assert.ok(workload);
  assert.equal(workload.action, "camera-track");
  assert.equal(workload.trackId, GLOBE_CAMERA_TRACK_ID);
  assert.equal(workload.featureProfile, "volumetric-clouds");
  assert.deepEqual(workload.renderers, ["webgpu"]);
  assert.equal(workload.measuredSeconds, GLOBE_CAMERA_TRACK_DURATION_SECONDS);
  assert.ok(
    schema.properties.workloads.items.properties.featureProfile.enum.includes(
      "volumetric-clouds",
    ),
  );
  assert.deepEqual(
    schema.properties.workloads.items.properties.renderers.items.enum,
    ["webgl", "webgpu"],
  );
});

test("implicit renderer-specific workloads skip while explicit requests fail", () => {
  const workloads = [
    { id: "shared" },
    { id: "webgpu-only", renderers: ["webgpu"] },
  ];

  assert.deepEqual(renderersForWorkload(workloads[0], ["webgl"]), ["webgl"]);
  assert.deepEqual(
    selectWorkloadsForRenderers(workloads, ["webgl"]),
    {
      selected: [workloads[0]],
      skipped: [
        {
          id: "webgpu-only",
          reason: "unsupported-renderer",
          selectedRenderers: ["webgl"],
          supportedRenderers: ["webgpu"],
        },
      ],
      skippedRenderers: [],
    },
  );
  assert.throws(
    () =>
      selectWorkloadsForRenderers([workloads[1]], ["webgl"], {
        strict: true,
      }),
    /Explicit workload request does not support selected renderer/,
  );
  assert.deepEqual(
    selectWorkloadsForRenderers(workloads, ["webgl", "webgpu"]),
    {
      selected: workloads,
      skipped: [],
      skippedRenderers: [
        {
          id: "webgpu-only",
          reason: "unsupported-renderer",
          skippedRenderers: ["webgl"],
          compatibleRenderers: ["webgpu"],
          supportedRenderers: ["webgpu"],
        },
      ],
    },
  );
  assert.throws(
    () =>
      selectWorkloadsForRenderers([workloads[1]], ["webgl", "webgpu"], {
        strict: true,
      }),
    /Explicit workload request does not support selected renderer/,
  );
});

test("renderer repetitions are truly counterbalanced AB then BA", () => {
  const schedule = buildCounterbalancedSchedule(["webgl", "webgpu"], 6);
  assert.deepEqual(
    schedule.map((entry) => entry.order.join(",")),
    [
      "webgl,webgpu",
      "webgpu,webgl",
      "webgl,webgpu",
      "webgpu,webgl",
      "webgl,webgpu",
      "webgpu,webgl",
    ],
  );
  assert.equal(
    schedule.filter((entry) => entry.order[0] === "webgl").length,
    3,
  );
  assert.equal(
    schedule.filter((entry) => entry.order[0] === "webgpu").length,
    3,
  );
  assert.deepEqual(buildCounterbalancedSchedule(["webgpu"], 2), [
    { repetition: 1, order: ["webgpu"] },
    { repetition: 2, order: ["webgpu"] },
  ]);
});

test("API owner-label snapshots produce a bounded exact measurement delta", () => {
  const start = {
    webgpuBuffersCreated: {
      terrain: 4,
      shared: 2,
    },
    webgpuRenderPassesBegun: {
      scene: 10,
    },
  };
  const end = {
    webgpuBuffersCreated: {
      terrain: 9,
      shared: 2,
      atmosphere: 1,
    },
    webgpuRenderPassesBegun: {
      scene: 13,
      post: 2,
    },
  };

  assert.deepEqual(diffCounterLabelSnapshots(start, end), {
    webgpuBuffersCreated: {
      atmosphere: 1,
      terrain: 5,
    },
    webgpuRenderPassesBegun: {
      post: 2,
      scene: 3,
    },
  });
});

test("logical counter snapshots retain exact measured-window deltas", () => {
  assert.deepEqual(
    diffFlatCounterSnapshots(
      { tileCalls: 10, liveBytes: 100, unchanged: 2 },
      { tileCalls: 14, liveBytes: 175, unchanged: 2, uploads: 3 },
    ),
    { liveBytes: 75, tileCalls: 4, uploads: 3 },
  );
});

test("long-task selection excludes late setup delivery and keeps the terminal task", () => {
  const selected = selectLongTasksInMeasurementWindow(
    [
      { startTime: 90, duration: 30 },
      { startTime: 120, duration: 60 },
      { startTime: 195, duration: 80 },
      { startTime: 200, duration: 55 },
    ],
    100,
    200,
  );

  assert.deepEqual(selected, [
    { startTime: 120, duration: 60, rawDuration: 60 },
    { startTime: 195, duration: 5, rawDuration: 80 },
  ]);
});

test("frame pacing reports FPS, one-percent low, and dropped frames", () => {
  const pacing = summarizeFramePacing([
    { wallDtMs: 16 },
    { wallDtMs: 16 },
    { wallDtMs: 34 },
  ]);
  assert.equal(pacing.sampleCount, 3);
  assert.ok(pacing.averageFps > 45 && pacing.averageFps < 46);
  assert.ok(pacing.onePercentLowFps > 29 && pacing.onePercentLowFps < 30);
  assert.equal(pacing.droppedFramesAtRefreshRate, 1);
});

test("per-segment metrics require exact trace/evidence alignment", () => {
  const evidence = GLOBE_CAMERA_TRACK.slice(0, -1).map(
    (waypoint, index, entries) => ({
      segmentIndex: index,
      height: waypoint.height,
      routeProgress: index / (entries.length - 1),
    }),
  );
  let sampleIndex = 0;
  const samples = evidence.map(() => {
    const index = sampleIndex++;
    return {
      cpuMs: index + 1,
      wallDtMs: 16 + index,
      gpuMs: 0.5 + index,
    };
  });
  const summary = summarizeTrackMetrics(samples, evidence, GLOBE_CAMERA_TRACK);
  assert.equal(summary.aligned, true);
  assert.equal(summary.coveredAllSegments, true);
  assert.equal(summary.completedRoute, true);
  assert.equal(summary.segments.length, GLOBE_CAMERA_TRACK.length - 1);
  assert.equal(summary.segments[0].cpuMs.count, 1);
  assert.equal(summary.gpuSegmentAlignment.aligned, false);
  assert.equal(summary.segments[0].gpuMs, null);

  const misaligned = summarizeTrackMetrics(
    samples.slice(1),
    evidence,
    GLOBE_CAMERA_TRACK,
  );
  assert.equal(misaligned.aligned, false);
  assert.equal(misaligned.segments, null);
});

test("moving-pick metrics reject a fixed cursor and accept a continuous sweep", () => {
  const samples = Array.from({ length: 60 }, () => ({ cpuMs: 1 }));
  const movingEvidence = samples.map((_, index) => ({
    x: index,
    y: index * 2,
    normalizedX: index / 59,
    normalizedY: 1 - index / 59,
  }));
  const moving = summarizeMovingPickMetrics(samples, movingEvidence, 60);
  assert.equal(moving.aligned, true);
  assert.equal(moving.continuous, true);
  assert.equal(moving.cursorMovedAcrossViewport, true);
  assert.equal(moving.uniquePositionCount, 60);

  const fixedEvidence = samples.map(() => ({
    x: 640,
    y: 360,
    normalizedX: 0.5,
    normalizedY: 0.5,
  }));
  const fixed = summarizeMovingPickMetrics(samples, fixedEvidence, 60);
  assert.equal(fixed.cursorMovedAcrossViewport, false);
  const quality = assessPerformanceRunQuality({
    timestampEnabled: false,
    measurement: { elapsedMs: 1_000 },
    longTasks: { available: true, count: 0, totalMs: 0 },
    pickMetrics: fixed,
  });
  assert.equal(quality.validForAggregation, false);
});

test("moving-pick metrics include out-of-render CPU and reject hover starvation", () => {
  const samples = Array.from({ length: 60 }, () => ({ cpuMs: 2 }));
  const evidence = samples.map((_, index) => ({
    x: index,
    y: index,
    normalizedX: index / 59,
    normalizedY: 1 - index / 59,
    pickCpuMs: 0.5,
  }));
  const telemetry = {
    publicApi: "pickHoverAsync",
    publicCalls: 60,
    completedCalls: 60,
    completedBeforeDrain: 50,
    completedDuringDrain: 10,
    rejectedCalls: 0,
    pendingCalls: 0,
    executionCount: 60,
    publicCallCpuMs: Array(60).fill(0.2),
    executionCpuMs: Array(60).fill(0.4),
    asyncExecutionCpuMs: Array(30).fill(0.6),
    executionCpuUnbucketedMs: 0,
    drainStatus: "drained",
    drainElapsedMs: 2,
  };
  const summary = summarizeMovingPickMetrics(samples, evidence, telemetry);
  assert.equal(summary.telemetryValid, true);
  assert.equal(summary.cpuEvidenceAligned, true);
  assert.equal(summary.cpuAccountingAligned, true);
  assert.equal(summary.combinedCpuMs.p95, 2.5);
  assert.ok(Math.abs(summary.accountedPickCpuMs - 30) < 1e-10);

  const starved = summarizeMovingPickMetrics(samples, evidence, {
    ...telemetry,
    completedBeforeDrain: 0,
    completedDuringDrain: 60,
  });
  assert.equal(starved.telemetryValid, false);
  const quality = assessPerformanceRunQuality({
    timestampEnabled: false,
    measurement: { elapsedMs: 1_000 },
    longTasks: { available: true, count: 0, totalMs: 0 },
    pickMetrics: starved,
  });
  assert.equal(quality.validForAggregation, false);
});

test("performance quality rejects the observed long-task/readback collapse", () => {
  const healthy = {
    measurement: { elapsedMs: 20_000 },
    longTasks: { available: true, count: 0, totalMs: 0 },
    timestampEnabled: true,
    timestampResults: {
      attemptedFrameCount: 1_200,
      readbackSkipCount: 5,
      failedReadbackCount: 0,
    },
    trackMetrics: {
      aligned: true,
      coveredAllSegments: true,
      completedRoute: true,
      segments: Array.from({ length: 8 }, (_, index) => ({
        index,
        sampleCount: 100,
      })),
    },
  };
  const collapsed = {
    ...healthy,
    longTasks: { available: true, count: 104, totalMs: 7_491 },
    timestampResults: {
      attemptedFrameCount: 290,
      readbackSkipCount: 105,
      failedReadbackCount: 0,
    },
    trackMetrics: {
      ...healthy.trackMetrics,
      segments: Array.from({ length: 8 }, (_, index) => ({
        index,
        sampleCount: index === 6 ? 10 : 30,
      })),
    },
  };

  assert.equal(assessPerformanceRunQuality(healthy).validForAggregation, true);
  const quality = assessPerformanceRunQuality(collapsed);
  assert.equal(quality.validForAggregation, false);
  assert.equal(quality.suspectedMainThreadContamination, true);
  assert.ok(quality.reasons.some((reason) => reason.includes("10/30")));
  assert.ok(quality.reasons.some((reason) => reason.includes("36.2%")));
});

test("performance aggregate stability rejects bimodal repetitions", () => {
  const makeRun = (cpuP95, measuredFrames) => ({
    result: "pass",
    quality: { validForCpuAggregation: true },
    requestedMeasurement: { mode: "duration" },
    measuredFrames,
    trace: { summary: { cpuMs: { p95: cpuP95 } } },
  });
  const stability = assessPerformanceRunStability([
    makeRun(10, 1_150),
    makeRun(90, 290),
  ]);

  assert.equal(stability.stable, false);
  assert.ok(stability.reasons.some((reason) => reason.includes("9.00")));
  assert.ok(stability.reasons.some((reason) => reason.includes("3.97")));
});
