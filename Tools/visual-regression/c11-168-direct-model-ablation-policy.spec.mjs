// C11-168 — browser-free causal-discriminator policy and mutant suite.
//
// Run: node --test Tools/visual-regression/c11-168-direct-model-ablation-policy.spec.mjs

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  assessC11168DirectModelAblationCampaign,
  c11168LegId,
  C11_168_DIRECT_MODEL_ABLATION_CONFIG,
  C11_168_LOCAL_EXECUTION_PATHS,
  C11_168_REPORT_TOOLING_PATHS,
  C11_168_SERVED_EXECUTION_PATHS,
  createC11168DirectModelAblationController,
  evaluateC11168DirectModelInvocation,
  monitorC11168ChildProcess,
  terminateC11168ChildTree,
} from "./lib/c11-168-direct-model-ablation.mjs";

const runnerSource = await readFile(
  new URL("./run-performance-campaign.mjs", import.meta.url),
  "utf8",
);
const driverSource = await readFile(
  new URL("./probe-c11-168-direct-model-ablation.mjs", import.meta.url),
  "utf8",
);
const helperSource = await readFile(
  new URL("./lib/c11-168-direct-model-ablation.mjs", import.meta.url),
  "utf8",
);
const manifest = JSON.parse(
  await readFile(
    new URL(
      "./performance-workloads-representative-warm.json",
      import.meta.url,
    ),
    "utf8",
  ),
);

function exactInvocation() {
  return {
    condition: "hidden",
    renderer: "webgpu",
    selectedWorkloadIds: [C11_168_DIRECT_MODEL_ABLATION_CONFIG.workloadId],
    manifestRelativePath: C11_168_DIRECT_MODEL_ABLATION_CONFIG.manifestFile,
    manifestSha256: C11_168_DIRECT_MODEL_ABLATION_CONFIG.manifestSha256,
    manifest: structuredClone(manifest),
    measuredFrames: C11_168_DIRECT_MODEL_ABLATION_CONFIG.measuredFrames,
    repetitions: C11_168_DIRECT_MODEL_ABLATION_CONFIG.repetitionsPerOrder,
    apiInstrumentation: false,
    gpuTimestamps: false,
    reuseBrowser: false,
    cpuOwnerAttribution: false,
    workload: structuredClone(manifest.workloads[0]),
  };
}

function makeModels(count = 48) {
  return Array.from({ length: count }, (_, index) => ({
    ready: true,
    show: true,
    scale: 18,
    modelMatrix: Array.from({ length: 16 }, (__, component) =>
      component % 5 === 0 ? 1 : index + component / 1000,
    ),
    _resource: {
      url: "/Apps/SampleData/models/BoxInstanced/BoxInstanced.gltf",
    },
  }));
}

function makeController(condition = "hidden") {
  const models = makeModels();
  const scene = {
    primitives: { contains: (model) => models.includes(model) },
    frameState: { commandList: [] },
  };
  return {
    models,
    scene,
    controller: createC11168DirectModelAblationController({
      scene,
      models,
      condition,
    }),
  };
}

const schedules = [
  [
    ["webgl", "shown"],
    ["webgpu", "shown"],
    ["webgpu", "hidden"],
    ["webgl", "hidden"],
  ],
  [
    ["webgl", "hidden"],
    ["webgpu", "hidden"],
    ["webgpu", "shown"],
    ["webgl", "shown"],
  ],
];

function inputClosure() {
  const identities = new Map(
    C11_168_LOCAL_EXECUTION_PATHS.map((path, index) => [
      path,
      {
        path,
        byteLength:
          path === "Build/CesiumUnminified/index.js" ? 456 : 1000 + index,
        sha256:
          path === "Build/CesiumUnminified/index.js"
            ? "D".repeat(64)
            : path === C11_168_DIRECT_MODEL_ABLATION_CONFIG.manifestFile
              ? C11_168_DIRECT_MODEL_ABLATION_CONFIG.manifestSha256
              : index.toString(16).toUpperCase().padStart(64, "A").slice(-64),
      },
    ]),
  );
  return {
    schemaVersion: 1,
    localFiles: C11_168_LOCAL_EXECUTION_PATHS.map((path) =>
      structuredClone(identities.get(path)),
    ),
    servedFiles: C11_168_SERVED_EXECUTION_PATHS.map((path) => ({
      ...structuredClone(identities.get(path)),
      url: `http://localhost:8080/${path}`,
      status: 200,
      contentType: "application/octet-stream",
    })),
  };
}

function physicalEnvironment(renderer) {
  return {
    host: {
      platform: "win32",
      release: "10.0.19045",
      architecture: "x64",
      cpu: "Test CPU",
      logicalCpuCount: 8,
      totalMemoryBytes: 32_000_000_000,
      node: "v22.23.1",
    },
    browserVersion: "151.0.4129.78",
    userAgent: "Test Edge 151",
    actualRenderer: renderer,
    canvasState: {
      page: `http://localhost:8080/Apps/CesiumViewer/index.html?renderer=${renderer}&offline=true`,
      clientWidth: 1280,
      clientHeight: 720,
      canvasWidth: 1280,
      canvasHeight: 720,
      drawingBufferWidth: 1280,
      drawingBufferHeight: 720,
      devicePixelRatio: 1,
      resolutionScale: 1,
    },
    gpuProvenance:
      renderer === "webgl"
        ? {
            backend: "webgl",
            rendererString: "WebGL 2 test renderer",
            adapterInfo: null,
            complete: true,
          }
        : {
            backend: "webgpu",
            rendererString: null,
            adapterInfo: { vendor: "test", architecture: "test" },
            complete: true,
          },
  };
}

function modelDescriptors() {
  return makeModels().map((model, index) => ({
    index,
    resourceUrl: model._resource.url,
    modelMatrix: model.modelMatrix,
    scale: model.scale,
  }));
}

function cpuFor(orderPair, renderer, condition, selectorMode = "selected") {
  if (selectorMode === "negative") {
    if (renderer === "webgpu") return condition === "shown" ? 8 : 9;
    return condition === "shown" ? 5 : 4;
  }
  if (selectorMode === "below-floor") {
    const offset = orderPair === 1 ? 0 : 0.1;
    if (renderer === "webgpu") {
      return (condition === "shown" ? 8.2 : 8) + offset;
    }
    return (condition === "shown" ? 4.1 : 4) + offset;
  }
  if (selectorMode === "reversal") {
    if (orderPair === 1) {
      if (renderer === "webgpu") return condition === "shown" ? 10 : 8;
      return condition === "shown" ? 5 : 4;
    }
    if (renderer === "webgpu") return condition === "shown" ? 8 : 9;
    return condition === "shown" ? 5 : 4;
  }
  const offset = orderPair === 1 ? 0 : 0.1;
  if (renderer === "webgpu") {
    return (condition === "shown" ? 10 : 8) + offset;
  }
  return (condition === "shown" ? 5 : 4) + offset;
}

function makeRunLegs(selectorMode = "selected") {
  const descriptors = modelDescriptors();
  const runId = "00000000-0000-4000-8000-000000000001";
  let pid = 4100;
  return schedules.flatMap((schedule, orderPairIndex) =>
    schedule.map(([renderer, condition], executionIndex) => {
      const orderPair = orderPairIndex + 1;
      const id = c11168LegId({
        orderPair,
        executionIndex,
        renderer,
        condition,
      });
      const closure = inputClosure();
      const localIdentity = (path) =>
        structuredClone(
          closure.localFiles.find((record) => record.path === path),
        );
      const expectedShow = condition === "shown";
      const cpuP95 = cpuFor(orderPair, renderer, condition, selectorMode);
      const fingerprint = {
        schemaVersion: 1,
        valid: true,
        frameCount: 600,
        signature: "SAME-FINGERPRINT",
        segments: [{ segmentIndex: 0, frameCount: 600 }],
      };
      const subject = {
        expectedCount: 48,
        configuredCount: 48,
        uniqueReferenceCount: 48,
        readyCount: 48,
        primitiveMembershipCount: 48,
        descriptors: structuredClone(descriptors),
      };
      return {
        id,
        orderPair,
        executionIndex,
        renderer,
        condition,
        childProcessId: pid++,
        subprocessExitCode: 0,
        subprocessSignal: null,
        subprocessTimedOut: false,
        subprocessForcedKill: false,
        subprocessHardDeadlineExceeded: false,
        subprocessTimeoutMs:
          C11_168_DIRECT_MODEL_ABLATION_CONFIG.childProcessTimeoutMs,
        subprocessHardDeadlineMs:
          C11_168_DIRECT_MODEL_ABLATION_CONFIG.childHardTerminationDeadlineMs,
        runId,
        rawDirectory: `${C11_168_DIRECT_MODEL_ABLATION_CONFIG.rawArtifactRoot}/${runId}`,
        inputClosure: closure,
        rawIdentity: {
          path: `${C11_168_DIRECT_MODEL_ABLATION_CONFIG.rawArtifactRoot}/${runId}/${id}.json`,
          byteLength: 12_345,
          sha256: "F".repeat(64),
        },
        readError: null,
        report: {
          result: "pass",
          directModelAblation: {
            condition,
            configAssessment: { pass: true, failures: [] },
          },
          manifest: {
            path: C11_168_DIRECT_MODEL_ABLATION_CONFIG.manifestFile,
            id: "fork-representative-resident-attribution-v1",
            schemaVersion: 1,
          },
          source: {
            commit: "a".repeat(40),
            branch: "campaign11",
            dirty: false,
            runtimeBundle: localIdentity("Build/CesiumUnminified/Cesium.js"),
            runtimeEntry: localIdentity("Build/CesiumUnminified/index.js"),
            tooling: Object.fromEntries(
              Object.entries(C11_168_REPORT_TOOLING_PATHS).map(
                ([name, path]) => [name, localIdentity(path)],
              ),
            ),
          },
          protocol: {
            browserIsolation: "fresh-process-per-run",
            apiInstrumentation: false,
            gpuTimestamps: false,
            cpuOwnerAttribution: false,
            directModelAblation: condition,
            selectedRenderers: [renderer],
            selectedWorkloads: [
              C11_168_DIRECT_MODEL_ABLATION_CONFIG.workloadId,
            ],
          },
          ...physicalEnvironment(renderer),
          runs: [
            {
              result: "pass",
              quality: {
                status: "clean",
                measurementValid: true,
                validForCpuAggregation: true,
              },
              timestampEnabled: false,
              apiCounters: { enabled: false },
              workloadId: C11_168_DIRECT_MODEL_ABLATION_CONFIG.workloadId,
              measuredFrames: 600,
              ...physicalEnvironment(renderer),
              trace: { summary: { cpuMs: { p95: cpuP95 } } },
              representativeMeasurementAssessment: {
                valid: true,
                fixedFrameProgress: {
                  valid: true,
                  identical: true,
                  measuredFrameCount: 600,
                  replayFrameCount: 600,
                  maximumAbsoluteDifference: 0,
                },
              },
              representativeContentEvidence: {
                measurementTilesetResidency: {
                  tilesetCount: 4,
                  frames: 600,
                  notLoadedFrames: 0,
                  pendingRequestFrames: 0,
                  processingFrames: 0,
                  attemptedRequestFrames: 0,
                  loadedTilesTotalDelta: 0,
                  contentByteLengthDelta: 0,
                },
                measurementContent: { workloadFingerprint: fingerprint },
              },
              directModelAblation: {
                valid: true,
                condition,
                timed: {
                  applied: {
                    condition,
                    expectedShow,
                    appliedCount: 48,
                    subject,
                  },
                  retained: {
                    condition,
                    expectedShow,
                    retainedCount: 48,
                    current: structuredClone(subject),
                  },
                },
                selectorControl: {
                  valid: true,
                  reasons: [],
                  causal: false,
                  timed: false,
                  snapshotsFrozenBeforeControl: true,
                  hidden: {
                    frameCount: 600,
                    commandFrames: 0,
                    maximumCommands: 0,
                    modelOwnersWithCommands: 0,
                    foreignCapturedOwnerCount: 0,
                  },
                  shown: {
                    frameCount: 600,
                    commandFrames: 600,
                    maximumCommands: 48,
                    modelOwnersWithCommands: 48,
                  },
                },
              },
            },
          ],
        },
      };
    }),
  );
}

test("canonical invocation pins the exact resident 48-model workload", () => {
  assert.equal(manifest.protocol.measuredFrames, 600);
  assert.equal(
    manifest.workloads[0].representativeConfig.models.rows *
      manifest.workloads[0].representativeConfig.models.columns,
    48,
  );
  assert.deepEqual(evaluateC11168DirectModelInvocation(exactInvocation()), {
    pass: true,
    failures: [],
  });

  const mutants = [
    ["condition", (value) => (value.condition = "other")],
    ["renderer", (value) => (value.renderer = "both")],
    ["workload count", (value) => value.selectedWorkloadIds.push("other")],
    ["workload id", (value) => (value.selectedWorkloadIds[0] = "other")],
    ["manifest", (value) => (value.manifestRelativePath = "other.json")],
    ["manifest hash", (value) => (value.manifestSha256 = "BAD")],
    ["manifest id", (value) => (value.manifest.id = "other")],
    ["viewport", (value) => (value.manifest.protocol.viewport.width = 1279)],
    ["frames", (value) => (value.measuredFrames = 599)],
    ["repetitions", (value) => (value.repetitions = 2)],
    ["API instrumentation", (value) => (value.apiInstrumentation = true)],
    ["GPU timestamps", (value) => (value.gpuTimestamps = true)],
    ["browser reuse", (value) => (value.reuseBrowser = true)],
    ["owner instrumentation", (value) => (value.cpuOwnerAttribution = true)],
    ["content profile", (value) => (value.workload.contentProfile = "other")],
    ["content", (value) => (value.workload.content = "other")],
    ["track", (value) => (value.workload.trackId = "other")],
    ["action", (value) => (value.workload.action = "orbit")],
    [
      "route prime",
      (value) => (value.workload.representativeConfig.routePrimeSamples = 599),
    ],
    [
      "resident mode",
      (value) =>
        (value.workload.representativeConfig.measurementTerrainMode =
          "streaming"),
    ],
    [
      "model count",
      (value) => (value.workload.representativeConfig.models.rows = 5),
    ],
    [
      "tileset count",
      (value) => (value.workload.representativeConfig.tilesets.columns = 1),
    ],
  ];
  for (const [name, mutate] of mutants) {
    const candidate = exactInvocation();
    mutate(candidate);
    assert.equal(
      evaluateC11168DirectModelInvocation(candidate).pass,
      false,
      name,
    );
  }
});

test("input closure freezes loaded implementations and default runtime assets", () => {
  assert.equal(
    new Set(C11_168_LOCAL_EXECUTION_PATHS).size,
    C11_168_LOCAL_EXECUTION_PATHS.length,
  );
  assert.equal(
    new Set(C11_168_SERVED_EXECUTION_PATHS).size,
    C11_168_SERVED_EXECUTION_PATHS.length,
  );
  for (const path of [
    "node_modules/ajv/lib/ajv.js",
    "node_modules/playwright/index.mjs",
    "node_modules/playwright-core/index.mjs",
    "node_modules/playwright-core/index.js",
    "node_modules/playwright-core/lib/bootstrap.js",
    "node_modules/playwright-core/lib/coreBundle.js",
    "node_modules/playwright-core/lib/utilsBundle.js",
  ]) {
    assert.ok(C11_168_LOCAL_EXECUTION_PATHS.includes(path), path);
  }
  const runtimeAssets = [
    ...["px", "mx", "py", "my", "pz", "mz"].map(
      (face) =>
        `Build/CesiumUnminified/Assets/Textures/SkyBox/tycho2t5_80_diffuse_${face}.jpg`,
    ),
    "Build/CesiumUnminified/Assets/Textures/Moon/lroc_color_poles_2k.jpg",
    "Build/CesiumUnminified/Assets/Textures/Moon/ldem_normal_1k.png",
    "Build/CesiumUnminified/Assets/Textures/waterNormalsSmall.jpg",
    "Build/CesiumUnminified/Assets/IAU2006_XYS/IAU2006_XYS_18.json",
  ];
  for (const path of runtimeAssets) {
    assert.ok(C11_168_LOCAL_EXECUTION_PATHS.includes(path), path);
    assert.ok(C11_168_SERVED_EXECUTION_PATHS.includes(path), path);
  }
});

test("controller owns the same ready objects and proves a non-vacuous selector", () => {
  const { models, scene, controller } = makeController("hidden");
  const applied = controller.applyTimedCondition();
  assert.equal(applied.appliedCount, 48);
  assert.equal(applied.expectedShow, false);
  assert.ok(models.every((model) => model.show === false));
  assert.equal(controller.validateTimedCondition().retainedCount, 48);

  controller.enterHiddenSelectorControl();
  for (let frame = 0; frame < 600; frame++) {
    scene.frameState.commandList = [];
    controller.sampleHiddenSelectorControl();
  }
  controller.restoreShownForReplay();
  assert.ok(models.every((model) => model.show === true));
  const control = controller.selectorControlSnapshot({
    sampledFrames: 600,
    directModelCommandFrames: 600,
    maximumDirectModelCommands: 48,
    coverage: { modelOwnersWithCommands: 48 },
  });
  assert.equal(control.valid, true);
  assert.equal(control.hidden.maximumCommands, 0);
  assert.equal(control.shown.modelOwnersWithCommands, 48);
});

test("controller fails closed on count, uniqueness, readiness, membership, and drift", () => {
  const sceneFor = (models) => ({
    primitives: { contains: (model) => models.includes(model) },
    frameState: { commandList: [] },
  });
  assert.throws(() => {
    const models = makeModels(47);
    createC11168DirectModelAblationController({
      scene: sceneFor(models),
      models,
      condition: "hidden",
    });
  }, /47\/48/u);
  assert.throws(() => {
    const models = makeModels();
    models[47] = models[0];
    createC11168DirectModelAblationController({
      scene: sceneFor(models),
      models,
      condition: "hidden",
    });
  }, /unique/u);
  assert.throws(() => {
    const models = makeModels();
    models[7].ready = false;
    createC11168DirectModelAblationController({
      scene: sceneFor(models),
      models,
      condition: "hidden",
    });
  }, /ready/u);
  assert.throws(() => {
    const models = makeModels();
    const scene = {
      primitives: { contains: (model) => model !== models[4] },
      frameState: { commandList: [] },
    };
    createC11168DirectModelAblationController({
      scene,
      models,
      condition: "hidden",
    });
  }, /belong/u);

  const drift = makeController("hidden");
  drift.controller.applyTimedCondition();
  drift.models.reverse();
  assert.throws(
    () => drift.controller.validateTimedCondition(),
    /identity or order/u,
  );

  const descriptorDrift = makeController("shown");
  descriptorDrift.controller.applyTimedCondition();
  descriptorDrift.models[0].scale = 19;
  assert.throws(
    () => descriptorDrift.controller.validateTimedCondition(),
    /source, transform, or scale/u,
  );
});

test("valid reverse-order quartets select only the predeclared causal statistic", () => {
  const assessment = assessC11168DirectModelAblationCampaign(makeRunLegs());
  assert.equal(assessment.valid, true);
  assert.equal(assessment.completedMeasurement, true);
  assert.equal(assessment.reasons.length, 0);
  assert.equal(assessment.orderPairs.length, 2);
  assert.deepEqual(
    assessment.orderPairs[1].executionOrder,
    [...assessment.orderPairs[0].executionOrder].reverse(),
  );
  assert.equal(assessment.orderPairs[0].selectorMs, 1);
  assert.ok(Math.abs(assessment.orderPairs[1].selectorMs - 1) < 1e-12);
  assert.equal(assessment.hypothesis.selected, true);
  assert.equal(assessment.hypothesis.verdict, "direct-model-family-selected");
});

test("a valid null or negative hypothesis completes without becoming FAIL", () => {
  const negative = assessC11168DirectModelAblationCampaign(
    makeRunLegs("negative"),
  );
  assert.equal(negative.valid, true);
  assert.equal(negative.completedMeasurement, true);
  assert.equal(negative.hypothesis.selected, false);
  assert.equal(negative.hypothesis.verdict, "direct-model-family-not-selected");

  const belowFloor = assessC11168DirectModelAblationCampaign(
    makeRunLegs("below-floor"),
  );
  assert.equal(belowFloor.valid, true);
  assert.equal(belowFloor.hypothesis.clearsAbsoluteFloor, false);
  assert.equal(belowFloor.hypothesis.selected, false);

  const reversal = assessC11168DirectModelAblationCampaign(
    makeRunLegs("reversal"),
  );
  assert.equal(reversal.valid, true);
  assert.equal(reversal.hypothesis.noSignReversal, false);
  assert.equal(reversal.hypothesis.selected, false);
});

test("campaign gate kills structural, identity, residency, and selector mutants", () => {
  const mutants = [
    ["missing quartet leg", (legs) => legs.pop()],
    [
      "reused process",
      (legs) => (legs[1].childProcessId = legs[0].childProcessId),
    ],
    ["subprocess red", (legs) => (legs[0].subprocessExitCode = 1)],
    ["subprocess timeout", (legs) => (legs[0].subprocessTimedOut = true)],
    ["forced kill", (legs) => (legs[0].subprocessForcedKill = true)],
    [
      "hard deadline",
      (legs) => (legs[0].subprocessHardDeadlineExceeded = true),
    ],
    ["timeout drift", (legs) => (legs[0].subprocessTimeoutMs = 1)],
    ["hard deadline drift", (legs) => (legs[0].subprocessHardDeadlineMs = 1)],
    ["raw id", (legs) => (legs[0].id += "-other")],
    [
      "raw run id",
      (legs) => (legs[0].runId = "00000000-0000-4000-8000-000000000002"),
    ],
    ["raw root", (legs) => (legs[0].rawDirectory = "other")],
    ["raw path", (legs) => (legs[0].rawIdentity.path = "other.json")],
    ["extra raw run", (legs) => legs[0].report.runs.push({})],
    [
      "API instrumentation",
      (legs) => (legs[0].report.protocol.apiInstrumentation = true),
    ],
    [
      "GPU timestamps",
      (legs) => (legs[0].report.protocol.gpuTimestamps = true),
    ],
    [
      "shared browser",
      (legs) => (legs[0].report.protocol.browserIsolation = "shared"),
    ],
    ["source", (legs) => (legs[0].report.source.commit = "OTHER")],
    ["missing source", (legs) => (legs[0].report.source = null)],
    ["dirty source", (legs) => (legs[0].report.source.dirty = true)],
    [
      "missing tooling identity",
      (legs) => delete legs[0].report.source.tooling.cameraTrack,
    ],
    [
      "tooling/closure cross-binding",
      (legs) =>
        (legs[0].report.source.tooling.representativeContentHelper.sha256 =
          "E".repeat(64)),
    ],
    ["build", (legs) => (legs[0].report.source.runtimeBundle.sha256 = "OTHER")],
    [
      "actual runtime entry",
      (legs) => (legs[0].report.source.runtimeEntry.sha256 = "E".repeat(64)),
    ],
    ["missing closure file", (legs) => legs[0].inputClosure.localFiles.pop()],
    [
      "served runtime mismatch",
      (legs) =>
        (legs[0].inputClosure.servedFiles.find(
          (entry) => entry.path === "Build/CesiumUnminified/index.js",
        ).sha256 = "E".repeat(64)),
    ],
    [
      "closure/runtime cross-binding",
      (legs) => {
        const closure = legs[0].inputClosure;
        closure.localFiles.find(
          (entry) => entry.path === "Build/CesiumUnminified/index.js",
        ).sha256 = "E".repeat(64);
        closure.servedFiles.find(
          (entry) => entry.path === "Build/CesiumUnminified/index.js",
        ).sha256 = "E".repeat(64);
      },
    ],
    [
      "served fixture query",
      (legs) => (legs[0].inputClosure.servedFiles.at(-1).url += "?stale=true"),
    ],
    [
      "selected renderer",
      (legs) => (legs[0].report.protocol.selectedRenderers = ["webgpu"]),
    ],
    ["host drift", (legs) => (legs[0].report.host.cpu = "Different CPU")],
    ["browser drift", (legs) => (legs[0].report.browserVersion = "150.0.0.0")],
    [
      "canvas drift",
      (legs) => (legs[0].report.runs[0].canvasState.canvasWidth = 1279),
    ],
    [
      "extra Viewer query",
      (legs) => (legs[0].report.runs[0].canvasState.page += "&extra=true"),
    ],
    [
      "duplicate Viewer query",
      (legs) => (legs[0].report.runs[0].canvasState.page += "&offline=true"),
    ],
    [
      "GPU drift",
      (legs) => (legs[0].report.runs[0].gpuProvenance.rendererString = "other"),
    ],
    [
      "empty WebGPU adapter identity",
      (legs) => {
        const leg = legs.find((entry) => entry.renderer === "webgpu");
        leg.report.runs[0].gpuProvenance.adapterInfo = {
          vendor: " ",
          architecture: "",
          device: "",
          description: "",
          subgroupMinSize: 4,
        };
      },
    ],
    [
      "fingerprint",
      (legs) =>
        (legs[0].report.runs[0].representativeContentEvidence.measurementContent.workloadFingerprint.signature =
          "OTHER"),
    ],
    [
      "route phase",
      (legs) =>
        (legs[0].report.runs[0].representativeMeasurementAssessment.fixedFrameProgress.maximumAbsoluteDifference = 0.1),
    ],
    [
      "residency",
      (legs) =>
        (legs[0].report.runs[0].representativeContentEvidence.measurementTilesetResidency.pendingRequestFrames = 1),
    ],
    [
      "model count",
      (legs) =>
        (legs[0].report.runs[0].directModelAblation.timed.applied.subject.readyCount = 47),
    ],
    [
      "model identity",
      (legs) =>
        (legs[0].report.runs[0].directModelAblation.timed.applied.subject.descriptors[0].scale = 19),
    ],
    [
      "malformed descriptor",
      (legs) =>
        (legs[0].report.runs[0].directModelAblation.timed.applied.subject.descriptors[0].modelMatrix =
          "1234567890123456"),
    ],
    [
      "retained descriptor drift",
      (legs) =>
        (legs[0].report.runs[0].directModelAblation.timed.retained.current.descriptors[0].scale = 19),
    ],
    [
      "timed state",
      (legs) =>
        (legs[0].report.runs[0].directModelAblation.timed.applied.expectedShow = false),
    ],
    [
      "hidden commands",
      (legs) =>
        (legs[0].report.runs[0].directModelAblation.selectorControl.hidden.commandFrames = 1),
    ],
    [
      "foreign hidden owner",
      (legs) =>
        (legs[0].report.runs[0].directModelAblation.selectorControl.hidden.foreignCapturedOwnerCount = 1),
    ],
    [
      "shown owners",
      (legs) =>
        (legs[0].report.runs[0].directModelAblation.selectorControl.shown.modelOwnersWithCommands = 47),
    ],
    [
      "missing p95",
      (legs) => (legs[0].report.runs[0].trace.summary.cpuMs.p95 = null),
    ],
    [
      "order",
      (legs) =>
        ([legs[4].executionIndex, legs[5].executionIndex] = [
          legs[5].executionIndex,
          legs[4].executionIndex,
        ]),
    ],
    [
      "third order pair",
      (legs) => {
        const extra = structuredClone(legs.slice(0, 4));
        for (let index = 0; index < extra.length; index++) {
          extra[index].orderPair = 3;
          extra[index].childProcessId = 9000 + index;
          extra[index].id = `pair-3-${index}`;
        }
        legs.push(...extra);
      },
    ],
  ];
  for (const [name, mutate] of mutants) {
    const legs = makeRunLegs();
    mutate(legs);
    const assessment = assessC11168DirectModelAblationCampaign(legs);
    assert.equal(assessment.valid, false, name);
    assert.equal(assessment.hypothesis.selected, false, name);
    assert.ok(assessment.reasons.length > 0, name);
  }
});

test("runner keeps the new path default-off and brackets it outside timing", () => {
  assert.match(runnerSource, /directModelAblation: null/u);
  assert.match(runnerSource, /if \(directModelAblationCondition !== null\)/u);
  assert.match(
    runnerSource,
    /representativeHarness\?\.primeEvidence\?\.residentConvergence\s*\?\.converged !== true/u,
  );
  assert.match(
    runnerSource,
    /directModelAblationController\.applyTimedCondition\(\)/u,
  );
  const convergence = runnerSource.indexOf(
    "representative resident route start did not restabilize",
  );
  const apply = runnerSource.indexOf(
    "directModelAblationController.applyTimedCondition()",
  );
  const timedSnapshots = runnerSource.indexOf(
    "const actionCountersStart = { ...actionCounters }",
  );
  const measurementEnd = runnerSource.indexOf(
    "const measurementEndMs = performance.now()",
  );
  const hiddenControl = runnerSource.indexOf(
    "directModelAblationController.enterHiddenSelectorControl()",
  );
  const shownReplay = runnerSource.indexOf(
    "const representativeReplayFrameCount",
  );
  assert.ok(convergence < apply);
  assert.ok(apply < timedSnapshots);
  assert.ok(measurementEnd < hiddenControl);
  assert.ok(hiddenControl < shownReplay);
  assert.match(
    runnerSource,
    /directModelAblationController\.restoreShownForReplay\(\)/u,
  );
  assert.match(helperSource, /snapshotsFrozenBeforeControl: true/u);
  assert.match(runnerSource, /path: repositoryRelativePath\(identity\.path\)/u);
});

test("Windows taskkill failure falls back to a direct child kill", async () => {
  const child = new EventEmitter();
  child.pid = 4321;
  const signals = [];
  child.kill = (signal) => {
    signals.push(signal);
    return true;
  };
  const killer = new EventEmitter();
  let taskkillUnrefCount = 0;
  killer.unref = () => {
    taskkillUnrefCount += 1;
  };
  const termination = terminateC11168ChildTree({
    child,
    force: true,
    platform: "win32",
    spawnTaskkill(command, args) {
      assert.equal(command, "taskkill");
      assert.deepEqual(args, ["/pid", "4321", "/T", "/F"]);
      return killer;
    },
  });
  killer.emit("close", 1, null);
  const result = await termination;
  assert.equal(result.mechanism, "taskkill-fallback");
  assert.equal(result.taskkillExitCode, 1);
  assert.equal(taskkillUnrefCount, 1);
  assert.deepEqual(signals, ["SIGKILL"]);
});

test("Windows taskkill helpers are unref'd even if they never close", () => {
  const child = new EventEmitter();
  child.pid = 5432;
  child.kill = () => true;
  const killer = new EventEmitter();
  let taskkillUnrefCount = 0;
  killer.unref = () => {
    taskkillUnrefCount += 1;
  };
  void terminateC11168ChildTree({
    child,
    force: false,
    platform: "win32",
    spawnTaskkill(command, args) {
      assert.equal(command, "taskkill");
      assert.deepEqual(args, ["/pid", "5432", "/T"]);
      return killer;
    },
  });
  assert.equal(taskkillUnrefCount, 1);
});

test("child monitor has a hard final deadline even without close", async () => {
  const child = new EventEmitter();
  child.pid = 9876;
  let childUnrefCount = 0;
  child.unref = () => {
    childUnrefCount += 1;
  };
  const attempts = [];
  const result = await monitorC11168ChildProcess({
    child,
    timeoutMs: 5,
    terminationGraceMs: 5,
    hardDeadlineMs: 25,
    terminate(_child, force) {
      attempts.push(force);
      return Promise.resolve();
    },
  });
  assert.equal(result.timedOut, true);
  assert.equal(result.forcedKill, true);
  assert.equal(result.hardDeadlineExceeded, true);
  assert.equal(result.exitCode, null);
  assert.equal(childUnrefCount, 1);
  assert.equal(attempts[0], false);
  assert.equal(attempts.at(-1), true);
  assert.ok(attempts.length >= 2);
});

test(
  "hard deadline lets a real Node helper exit before its live grandchild",
  { timeout: 10_000 },
  async () => {
    const helperModuleUrl = new URL(
      "./lib/c11-168-direct-model-ablation.mjs",
      import.meta.url,
    ).href;
    const grandchildLifetimeMs = 5_000;
    const hardDeadlineMs = 150;
    const helperProgram = `
      import { spawn } from "node:child_process";
      import { monitorC11168ChildProcess } from ${JSON.stringify(helperModuleUrl)};
      const grandchildLifetimeMs = ${grandchildLifetimeMs};
      const child = spawn(
        process.execPath,
        ["--eval", \`setTimeout(() => process.exit(0), \${grandchildLifetimeMs})\`],
        { stdio: "ignore", windowsHide: true },
      );
      const startedAt = Date.now();
      const result = await monitorC11168ChildProcess({
        child,
        timeoutMs: 25,
        terminationGraceMs: 25,
        hardDeadlineMs: ${hardDeadlineMs},
        terminate: () => new Promise(() => {}),
      });
      process.stdout.write(JSON.stringify({
        elapsedMs: Date.now() - startedAt,
        grandchildPid: child.pid,
        result,
      }));
    `;
    const startedAt = Date.now();
    const helper = spawn(
      process.execPath,
      ["--input-type=module", "--eval", helperProgram],
      {
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      },
    );
    let stdout = "";
    let stderr = "";
    helper.stdout.setEncoding("utf8");
    helper.stderr.setEncoding("utf8");
    helper.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    helper.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    const { code, signal } = await new Promise((resolve, reject) => {
      helper.once("error", reject);
      helper.once("close", (closeCode, closeSignal) => {
        resolve({ code: closeCode, signal: closeSignal });
      });
    });
    const helperWallMs = Date.now() - startedAt;
    assert.equal(code, 0, stderr);
    assert.equal(signal, null, stderr);
    const record = JSON.parse(stdout);
    assert.equal(record.result.hardDeadlineExceeded, true);
    assert.equal(record.result.timedOut, true);
    assert.equal(record.result.forcedKill, true);
    assert.equal(record.result.exitCode, null);
    assert.equal(record.result.signal, null);
    assert.ok(record.elapsedMs >= hardDeadlineMs - 25, stdout);
    assert.ok(record.elapsedMs < 2_000, stdout);
    assert.ok(helperWallMs < grandchildLifetimeMs / 2, stdout);
    try {
      process.kill(record.grandchildPid, 0);
      process.kill(record.grandchildPid, "SIGKILL");
    } catch (error) {
      if (error?.code !== "ESRCH") throw error;
    }
  },
);

test("driver persists owned RUNNING state before fallible setup", () => {
  const acquire = driverSource.indexOf("await writeFile(lockPath,");
  const running = driverSource.indexOf("await persistInitialRunning(");
  const capture = driverSource.indexOf(
    "const identities = await captureFrozenInputIdentities()",
  );
  const rawMkdir = driverSource.indexOf(
    "await mkdir(rawDirectory, { recursive: true })",
  );
  assert.ok(acquire >= 0);
  assert.ok(acquire < running);
  assert.ok(running < capture);
  assert.ok(capture < rawMkdir);
  assert.match(driverSource, /value\?\.runId !== runId/u);
  assert.match(driverSource, /await requireOwnedLock\(lockPath, runId\)/u);
  assert.match(driverSource, /await requireCanonicalRun\(options, runId\)/u);
  assert.match(driverSource, /status: "RUNNING",\s*incomplete: true/u);
  assert.doesNotMatch(driverSource, /finally\s*\{\s*try\s*\{\s*await unlink/u);
});

test("driver locks fresh-process reverse quartets and disables instrumentation", () => {
  assert.match(driverSource, /spawn\(process\.execPath/u);
  assert.match(driverSource, /stdio: \["ignore", "ignore", "inherit"\]/u);
  assert.match(driverSource, /"--no-gpu-timestamps"/u);
  assert.doesNotMatch(driverSource, /"--api-instrumentation"/u);
  assert.doesNotMatch(driverSource, /"--reuse-browser"/u);
  assert.match(driverSource, /CONFIG\.quartetSchedules/u);
  assert.match(driverSource, /conclusionPolicy/u);
  assert.match(helperSource, /orderPairCount: 2/u);
  assert.match(helperSource, /legsPerOrderPair: 4/u);
  assert.match(helperSource, /childProcessTimeoutMs: 900_000/u);
  assert.match(helperSource, /childHardTerminationDeadlineMs: 925_000/u);
  assert.match(driverSource, /terminate: terminateChildTree/u);
  assert.match(helperSource, /"taskkill"/u);
  assert.match(helperSource, /\[\s*"\/pid",\s*String\(child\.pid\),\s*"\/T"/u);
  assert.match(driverSource, /C11_168_LOCAL_EXECUTION_PATHS/u);
  assert.match(driverSource, /C11_168_SERVED_EXECUTION_PATHS/u);
  assert.match(helperSource, /absoluteSelectorFloorMs: 0\.75/u);
  assert.match(helperSource, /noiseMultiple: 3/u);
  assert.match(
    helperSource,
    /\(WebGPU shown - WebGPU hidden\) - \(WebGL shown - WebGL hidden\)/u,
  );
});
