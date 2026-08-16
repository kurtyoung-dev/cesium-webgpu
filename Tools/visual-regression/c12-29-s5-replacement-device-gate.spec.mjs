// @purpose Certifies the S5 eclipse-shadow replacement-device evidence pipeline: schemas, phases, ledger/provenance validators, gate fold of its probe+lib pair.
// @status ACTIVE

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  C12_29_S5_REPLACEMENT_CONFIG,
  C12_29_S5_REPLACEMENT_CONTRACT,
  C12_29_S5_REPLACEMENT_CONTROL_PHASES,
  C12_29_S5_REPLACEMENT_LOCAL_FILES,
  C12_29_S5_REPLACEMENT_NATIVE_LEDGER_SCHEMA,
  C12_29_S5_REPLACEMENT_PAGE_PROGRESS_SCHEMA,
  C12_29_S5_REPLACEMENT_PHASES,
  C12_29_S5_REPLACEMENT_PROVENANCE_SCHEMA,
  C12_29_S5_REPLACEMENT_RUNTIME_DIAGNOSTICS_SCHEMA,
  C12_29_S5_REPLACEMENT_SCHEMA,
  C12_29_S5_REPLACEMENT_SERVED_FILES,
  C12_29_S5_REPLACEMENT_SOURCE_FILES,
  C12_29_S5_REPLACEMENT_WEBGPU_PHASES,
  createC1229S5ReplacementErrorArtifact,
  createC1229S5ReplacementErrorDiagnostics,
  foldC1229S5ReplacementDeviceGate,
  materializeC1229S5ReplacementEvidence,
  stableC1229S5ReplacementJson,
  validateC1229S5ReplacementFinalArtifact,
  validateC1229S5ReplacementNativeLedger,
  validateC1229S5ReplacementPageProgress,
  validateC1229S5ReplacementProvenance,
  validateC1229S5ReplacementRuntimeDiagnostics,
} from "./lib/c12-29-s5-replacement-device-gate.mjs";
import {
  beginC1229S5ReplacementEvidenceRun,
  createC1229S5ReplacementArtifactPaths,
  finalizeC1229S5ReplacementEvidence,
  installC1229S5ReplacementMethodPatch,
  installC1229S5ReplacementNativeLedger,
  validateC1229S5ReplacementLoopbackBase,
  withC1229S5ReplacementWatchdog,
} from "./probe-c12-29-s5-replacement-device.mjs";

const toolDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(toolDirectory, "../..");
const RUN_ID = "123e4567-e89b-42d3-a456-426614174000";
const SHA = "a".repeat(64);

const clone = (value) => structuredClone(value);
const image = (label, seed = 0) => {
  const samplePixels =
    C12_29_S5_REPLACEMENT_CONFIG.sampleWidth *
    C12_29_S5_REPLACEMENT_CONFIG.sampleHeight;
  const sampleRgba = Array.from({ length: samplePixels * 4 }, (_, index) =>
    index % 4 === 3 ? 255 : (80 + seed + index) % 256,
  );
  let nonBlackPixels = 0;
  let luminance = 0;
  for (let index = 0; index < sampleRgba.length; index += 4) {
    if (sampleRgba[index] || sampleRgba[index + 1] || sampleRgba[index + 2])
      nonBlackPixels++;
    luminance +=
      0.2126 * sampleRgba[index] +
      0.7152 * sampleRgba[index + 1] +
      0.0722 * sampleRgba[index + 2];
  }
  return {
    label,
    width: 960,
    height: 960,
    byteLength: 1024 + seed,
    sha256: SHA,
    nonBlackPixels,
    meanLuminance: luminance / samplePixels,
    sampleRgba,
  };
};

function sampleDelta(left, right) {
  let absolute = 0;
  let changed = 0;
  for (let index = 0; index < left.length; index += 4) {
    const delta =
      Math.abs(left[index] - right[index]) +
      Math.abs(left[index + 1] - right[index + 1]) +
      Math.abs(left[index + 2] - right[index + 2]);
    absolute += delta / 3;
    if (delta > 9) changed++;
  }
  return {
    meanAbsoluteDelta: absolute / (left.length / 4),
    changedPixelShare: changed / (left.length / 4),
  };
}

const s5 = () => ({
  prepared: true,
  revision: 17,
  gate: 2,
  payload: [
    0.25,
    0.5,
    0.75,
    1e-9,
    -0.01,
    0.02,
    -0.03,
    2e-9,
    2,
    0.8,
    1.2,
    0,
    5e-5,
    1 / 3,
    0,
    0,
  ].map(Math.fround),
});

function snapshot(label, frameNumber, seed = 0) {
  return {
    frameNumber,
    selectionRevision: 9,
    surfaceRadius: 6_379_389,
    selectedTileIds: ["1/0/0", "1/1/0"],
    providerToken: "provider-1",
    s5: s5(),
    image: image(label, seed),
  };
}

function progress(renderer, completed) {
  return {
    schema: C12_29_S5_REPLACEMENT_PAGE_PROGRESS_SCHEMA,
    renderer,
    currentPhase: completed.at(-1) ?? "preflight",
    completedPhases: [...completed],
    step: "complete",
    elapsedMs: 1000,
  };
}

function runtime(renderer) {
  return {
    schema: C12_29_S5_REPLACEMENT_RUNTIME_DIAGNOSTICS_SCHEMA,
    renderer,
    pageErrors: [],
    consoleErrors: [],
    expectedRecoveryConsole:
      renderer === "webgpu"
        ? ["[WebGPU] Device lost (reason: unknown): GPU process terminated"]
        : [],
    expectedPoolRecoveryConsole:
      renderer === "webgpu"
        ? [
            "[CesiumJS:WebGPUDevicePool] Device lost: unknown — GPU process terminated",
          ]
        : [],
    recoveryConsoleInterval:
      renderer === "webgpu"
        ? { beginCount: 1, endCount: 1, openAtEnd: false }
        : { beginCount: 0, endCount: 0, openAtEnd: false },
    gpuErrors: [],
    unexpectedDeviceLoss: null,
    externalRequests: [],
    failedRequests: [],
    httpErrors: [],
    pendingRequests: 0,
    armedDevices: renderer === "webgpu" ? 2 : 0,
  };
}

function fingerprint(file) {
  return {
    path: file,
    byteLength: file === "Build/CesiumUnminified/index.js.map" ? 4096 : 100,
    sha256: SHA,
  };
}

function served(file) {
  return {
    path: file,
    url: `http://localhost:8080/${file}`,
    status: 200,
    byteLength: 100,
    sha256: SHA,
  };
}

function provenance() {
  const files = C12_29_S5_REPLACEMENT_LOCAL_FILES.map(fingerprint);
  return {
    schema: C12_29_S5_REPLACEMENT_PROVENANCE_SCHEMA,
    gitHead: "b".repeat(40),
    localStart: clone(files),
    localEnd: clone(files),
    served: C12_29_S5_REPLACEMENT_SERVED_FILES.map(served),
    buildSourceIdentity: {
      ok: true,
      sourceMapByteLength: 4096,
      sourceMapSha256: SHA,
      entryCount: C12_29_S5_REPLACEMENT_SOURCE_FILES.length,
      entries: C12_29_S5_REPLACEMENT_SOURCE_FILES.map((sourcePath) => ({
        path: sourcePath,
        sourceMapEntry: `../../${sourcePath}`,
        currentByteLength: 100,
        embeddedByteLength: 100,
        currentSha256: SHA,
        embeddedSha256: SHA,
        exact: true,
        reason: null,
      })),
      reasons: [],
    },
    stable: true,
    buildEntryMatchesServed: true,
    servedMatchesLocal: true,
    launch: {
      channel: "msedge",
      headless: true,
      args: ["--enable-gpu-benchmarking"],
    },
  };
}

function bindingProof(role, deviceToken, bufferToken, bindGroupToken, ordinal) {
  const payload = s5().payload;
  return {
    role,
    deviceToken,
    bufferToken,
    bindGroupToken,
    group: 0,
    binding: 2,
    bindingSize: 64,
    bindingOffset: 0,
    dynamicOffset: 256,
    dynamicOffsets: [0, 256, 256],
    alignment: 256,
    descriptorOrdinal: role === "D1" ? ordinal - 1 : null,
    passLabel:
      role === "D1" ? "DynEnvMap Capture Face 5" : "Scene Main Render Pass",
    renderPassToken: `pass-${role}`,
    commandEncoderToken: `encoder-${role}`,
    commandBufferToken: `command-buffer-${role}`,
    bindOrdinal: ordinal,
    finishOrdinal: ordinal + 2,
    uploadOrdinal: ordinal + 1,
    uploadOffset: 0,
    uploadByteLength: 512,
    submitOrdinal: ordinal + 3,
    expectedPayload: [...payload],
    observedPayload: [...payload],
    payloadExact: true,
    ownedByDevice: true,
    coveredByUpload: true,
  };
}

function ledger() {
  const before = bindingProof("D0", "device-1", "buffer-1", "bind-group-1", 6);
  const after = bindingProof("D1", "device-2", "buffer-2", "bind-group-2", 31);
  const d0Resource = {
    role: "D0",
    deviceToken: "device-1",
    bufferToken: "buffer-1",
    createdOrdinal: 3,
    destroyedOrdinal: 15,
    destroyCount: 1,
    boundOrdinals: [6],
    writeOrdinals: [7],
  };
  const d1Resource = {
    role: "D1",
    deviceToken: "device-2",
    bufferToken: "buffer-2",
    createdOrdinal: 24,
    destroyedOrdinal: null,
    destroyCount: 0,
    boundOrdinals: [31],
    writeOrdinals: [32],
  };
  const receipt = (role, proof, resource) => ({
    role,
    device: {
      token: proof.deviceToken,
      firstOrdinal: role === "D0" ? 1 : 20,
      armedAtAcquisition: true,
    },
    buffer: {
      deviceToken: resource.deviceToken,
      bufferToken: resource.bufferToken,
      createdOrdinal: resource.createdOrdinal,
      destroyedOrdinal: resource.destroyedOrdinal,
      destroyCount: resource.destroyCount,
    },
    bind: {
      ordinal: proof.bindOrdinal,
      stage: role === "D0" ? "before-loss" : "replacement-capture",
      group: proof.group,
      deviceToken: proof.deviceToken,
      bindGroupToken: proof.bindGroupToken,
      dynamicOffsets: [...proof.dynamicOffsets],
      renderPassToken: proof.renderPassToken,
      passLabel: proof.passLabel,
      commandEncoderToken: proof.commandEncoderToken,
    },
    upload: {
      ordinal: proof.uploadOrdinal,
      stage: role === "D0" ? "before-loss" : "replacement-capture",
      deviceToken: proof.deviceToken,
      bufferToken: proof.bufferToken,
      offset: proof.uploadOffset,
      byteLength: proof.uploadByteLength,
      effectiveOffset: proof.bindingOffset + proof.dynamicOffset,
      observedPayload: [...proof.observedPayload],
    },
    finish: {
      ordinal: proof.finishOrdinal,
      stage: role === "D0" ? "before-loss" : "replacement-capture",
      deviceToken: proof.deviceToken,
      commandEncoderToken: proof.commandEncoderToken,
      commandBufferToken: proof.commandBufferToken,
    },
    submit: {
      ordinal: proof.submitOrdinal,
      stage: role === "D0" ? "before-loss" : "replacement-capture",
      deviceToken: proof.deviceToken,
      commandBufferTokens: [proof.commandBufferToken],
    },
  });
  return {
    schema: C12_29_S5_REPLACEMENT_NATIVE_LEDGER_SCHEMA,
    instrumentation: {
      installedBeforeViewer: true,
      adapterPrototypeWrapped: true,
      devicePrototypeWrapped: true,
      commandEncoderPrototypeWrapped: true,
      queuePrototypeWrapped: true,
      bufferPrototypeWrapped: true,
      renderPassPrototypeWrapped: true,
      createBufferCalls: 20,
      createBindGroupCalls: 20,
      writeBufferCalls: 20,
      setBindGroupCalls: 20,
      createCommandEncoderCalls: 4,
      beginRenderPassCalls: 20,
      finishCommandEncoderCalls: 4,
      submitCalls: 4,
      requestDeviceCalls: 3,
      armedAtAcquisitionCalls: 3,
    },
    devices: [
      {
        role: "D0",
        token: "device-1",
        firstOrdinal: 1,
        armedAtAcquisition: true,
        createBufferCount: 10,
        createBindGroupCount: 10,
      },
      {
        role: "D1",
        token: "device-2",
        firstOrdinal: 20,
        armedAtAcquisition: true,
        createBufferCount: 10,
        createBindGroupCount: 10,
      },
    ],
    binding2: {
      group: 0,
      binding: 2,
      byteLength: 64,
      floatCount: 16,
      before,
      after,
    },
    resources: { d0Binding2: d0Resource, d1Binding2: d1Resource },
    retirement: {
      lossOrdinal: 12,
      oldDestroyOrdinal: 15,
      invalidationOrdinal: 16,
      healthyOrdinal: 22,
      firstD1CreateOrdinal: 20,
      oldDestroyCount: 1,
      postLossD0CreateCount: 0,
      postLossD0WriteCount: 0,
      postLossD0BindCount: 0,
      invalidationCount: 1,
      ordered: true,
    },
    sequence: {
      marks: [
        { kind: "loss", ordinal: 12, stage: "after-loss" },
        { kind: "invalidation", ordinal: 16, stage: "after-loss" },
        { kind: "healthy", ordinal: 22, stage: "after-loss" },
        {
          kind: "retirement-observed",
          ordinal: 23,
          stage: "replacement-healthy",
        },
        {
          kind: "capture-native-start",
          ordinal: 29,
          stage: "replacement-healthy",
        },
        {
          kind: "capture-descriptor",
          ordinal: 30,
          stage: "replacement-capture",
        },
      ],
      receipts: [
        receipt("D0", before, d0Resource),
        receipt("D1", after, d1Resource),
      ],
    },
  };
}

function spreadD1ExecutionOrdinals(report) {
  const proof = report.webgpu.ledger.binding2.after;
  const resource = report.webgpu.ledger.resources.d1Binding2;
  const receipt = report.webgpu.ledger.sequence.receipts[1];
  proof.bindOrdinal = 32;
  proof.uploadOrdinal = 34;
  proof.finishOrdinal = 36;
  proof.submitOrdinal = 38;
  resource.boundOrdinals = [proof.bindOrdinal];
  resource.writeOrdinals = [proof.uploadOrdinal];
  receipt.bind.ordinal = proof.bindOrdinal;
  receipt.upload.ordinal = proof.uploadOrdinal;
  receipt.finish.ordinal = proof.finishOrdinal;
  receipt.submit.ordinal = proof.submitOrdinal;
}

function setD1CarrierDestruction(report, destroyedOrdinal, destroyCount) {
  const resource = report.webgpu.ledger.resources.d1Binding2;
  const receipt = report.webgpu.ledger.sequence.receipts[1].buffer;
  resource.destroyedOrdinal = destroyedOrdinal;
  resource.destroyCount = destroyCount;
  receipt.destroyedOrdinal = destroyedOrdinal;
  receipt.destroyCount = destroyCount;
}

function passingReport() {
  const before = snapshot("webgpu-before-loss", 100);
  const after = snapshot("webgpu-replacement-render", 120, 1);
  // Keep CPU S5/terrain exact while permitting a small post-recovery image delta.
  after.image = image("webgpu-replacement-render", 1);
  const renderDelta = sampleDelta(
    before.image.sampleRgba,
    after.image.sampleRgba,
  );
  return {
    schema: C12_29_S5_REPLACEMENT_SCHEMA,
    runId: RUN_ID,
    incomplete: false,
    contract: C12_29_S5_REPLACEMENT_CONTRACT,
    phaseOrder: [...C12_29_S5_REPLACEMENT_PHASES],
    provenance: provenance(),
    control: {
      renderer: "webgl",
      progress: progress("webgl", C12_29_S5_REPLACEMENT_CONTROL_PHASES),
      before: snapshot("control-before", 10),
      afterGap: snapshot("control-after-gap", 30),
      gap: {
        requestedFrames: 12,
        observedFrames: 12,
        elapsedMs: 200,
        triggerInvocations: 0,
      },
      continuity: {
        sameScene: true,
        sameContext: true,
        sameCanvas: true,
        sameView: true,
        sameProvider: true,
        frameAdvanced: true,
        terrainExact: true,
        s5PayloadExact: true,
        renderComparable: true,
      },
      runtime: runtime("webgl"),
      cleanup: {
        complete: true,
        pageClosed: true,
        contextClosed: true,
        pendingRequestsDrained: true,
      },
    },
    webgpu: {
      renderer: "webgpu",
      progress: progress("webgpu", C12_29_S5_REPLACEMENT_WEBGPU_PHASES),
      classification: "eligible-replacement",
      eligibility: {
        secureContext: true,
        navigatorGpu: true,
        objectPath: "chrome.gpuBenchmarking",
        objectPresent: true,
        method: "terminateGpuProcessNormally",
        methodType: "function",
        launchFlag: "--enable-gpu-benchmarking",
        eligible: true,
      },
      before,
      trigger: {
        objectPath: "chrome.gpuBenchmarking",
        method: "terminateGpuProcessNormally",
        invocations: 1,
        returned: true,
        destroyCalls: 0,
        crashHookCalls: 0,
        onlyAuthorizedTrigger: true,
      },
      loss: {
        observed: true,
        reason: "unknown",
        message: "GPU process terminated",
        recoverable: true,
        eventCount: 1,
        elapsedMs: 50,
        classification: "replacement",
      },
      recovery: {
        healthy: true,
        state: "healthy",
        attempts: 0,
        elapsedMs: 1000,
        deviceLostEvents: 1,
        recoveredEvents: 1,
      },
      identity: {
        sameScene: true,
        sameContext: true,
        sameCanvas: true,
        sameCanvasContext: true,
        sameView: true,
        sameGlobe: true,
        sameProvider: true,
        sameModel: true,
        sameManager: true,
        freshAdapter: true,
        freshDevice: true,
      },
      generations: { before: 0, after: 1, delta: 1 },
      invalidation: { count: 1, ordinals: [16], afterLossBeforeHealthy: true },
      ledger: ledger(),
      terrain: {
        before,
        after,
        sameProvider: true,
        selectedIdsExact: true,
        surfaceRadiusExact: true,
        s5PayloadExact: true,
        activeBoth: true,
      },
      render: {
        beforeImage: before.image,
        afterImage: after.image,
        meanAbsoluteDelta: renderDelta.meanAbsoluteDelta,
        changedPixelShare: renderDelta.changedPixelShare,
        comparable:
          renderDelta.meanAbsoluteDelta <=
            C12_29_S5_REPLACEMENT_CONFIG.replacementMaximumMeanAbsoluteDelta &&
          renderDelta.changedPixelShare <=
            C12_29_S5_REPLACEMENT_CONFIG.replacementMaximumChangedPixelShare,
        nonVacuous: true,
      },
      pick: {
        method: "scene.pickAsync",
        invoked: true,
        awaited: true,
        settled: true,
        renderPumpFrames: 2,
        resultKind: "globe",
        resultPrimitiveIdentity: true,
        sameScene: true,
        sameContext: true,
        s5Active: true,
        generation: 1,
      },
      capture: {
        managerDriven: true,
        directHelperCall: false,
        sameModel: true,
        sameManager: true,
        submitted: true,
        statusCode: 2,
        settleFrames: 20,
        selectedTileCount: 2,
        s5Active: true,
        generation: 1,
        d1Binding2Observed: true,
        modelRemoved: true,
        modelDestroyed: true,
        captureSourcesCleared: true,
      },
      runtime: runtime("webgpu"),
      cleanup: {
        complete: true,
        pageClosed: true,
        contextClosed: true,
        pendingRequestsDrained: true,
        listenersRemoved: true,
      },
    },
    cleanup: {
      complete: true,
      browserClosed: true,
      contextsClosed: true,
      pagesClosed: true,
    },
  };
}

function artifactFrom(report) {
  const verdict = foldC1229S5ReplacementDeviceGate(report);
  return {
    ...report,
    status: verdict.status,
    exitCode: verdict.exitCode,
    reasons: {
      structural: verdict.structuralReasons,
      failures: verdict.failureReasons,
    },
    checks: verdict.checks,
  };
}

test("passing fixture proves every bounded replacement-device claim", () => {
  const report = passingReport();
  const verdict = foldC1229S5ReplacementDeviceGate(report);
  assert.equal(
    verdict.status,
    "PASS",
    verdict.structuralReasons.concat(verdict.failureReasons).join("\n"),
  );
  assert.equal(verdict.exitCode, 0);
  assert.ok(Object.values(verdict.checks).every(Boolean));
  assert.deepEqual(
    validateC1229S5ReplacementFinalArtifact(artifactFrom(report)),
    { ok: true, reasons: [] },
  );
});

test("canonical materialization rejects hidden, accessor, symbol, sparse, and non-finite evidence without invoking hooks", () => {
  const artifact = artifactFrom(passingReport());
  const canonical = stableC1229S5ReplacementJson(artifact, 2);
  const materialized = materializeC1229S5ReplacementEvidence(artifact);
  assert.deepEqual(JSON.parse(canonical), artifact);
  assert.equal(
    stableC1229S5ReplacementJson(JSON.parse(canonical), 2),
    canonical,
  );
  assert.equal(stableC1229S5ReplacementJson(materialized, 2), canonical);

  let toJsonCalls = 0;
  const hidden = artifactFrom(passingReport());
  Object.defineProperty(hidden, "toJSON", {
    enumerable: false,
    value() {
      toJsonCalls++;
      return null;
    },
  });
  assert.equal(validateC1229S5ReplacementFinalArtifact(hidden).ok, false);
  assert.equal(toJsonCalls, 0);
  assert.throws(
    () => stableC1229S5ReplacementJson(hidden),
    /hidden or accessor properties/u,
  );
  assert.equal(toJsonCalls, 0);

  let getterCalls = 0;
  const accessor = artifactFrom(passingReport());
  Object.defineProperty(accessor.webgpu.ledger, "trap", {
    enumerable: true,
    get() {
      getterCalls++;
      return true;
    },
  });
  assert.equal(validateC1229S5ReplacementFinalArtifact(accessor).ok, false);
  assert.equal(getterCalls, 0);

  const symbol = artifactFrom(passingReport());
  symbol[Symbol("unpublishable")] = true;
  assert.equal(validateC1229S5ReplacementFinalArtifact(symbol).ok, false);

  const sparse = artifactFrom(passingReport());
  delete sparse.phaseOrder[0];
  assert.equal(validateC1229S5ReplacementFinalArtifact(sparse).ok, false);

  const nonFinite = artifactFrom(passingReport());
  nonFinite.webgpu.recovery.elapsedMs = Number.POSITIVE_INFINITY;
  assert.equal(validateC1229S5ReplacementFinalArtifact(nonFinite).ok, false);
});

test("the four public schema validators accept only their exact fixture shapes", () => {
  const report = passingReport();
  assert.equal(
    validateC1229S5ReplacementPageProgress(report.webgpu.progress).ok,
    true,
  );
  assert.equal(
    validateC1229S5ReplacementRuntimeDiagnostics(
      report.webgpu.runtime,
      "webgpu",
    ).ok,
    true,
  );
  assert.equal(
    validateC1229S5ReplacementProvenance(report.provenance).ok,
    true,
  );
  assert.equal(
    validateC1229S5ReplacementNativeLedger(report.webgpu.ledger).ok,
    true,
  );
  for (const [validator, value] of [
    [validateC1229S5ReplacementPageProgress, report.webgpu.progress],
    [
      (entry) => validateC1229S5ReplacementRuntimeDiagnostics(entry, "webgpu"),
      report.webgpu.runtime,
    ],
    [validateC1229S5ReplacementProvenance, report.provenance],
    [validateC1229S5ReplacementNativeLedger, report.webgpu.ledger],
  ]) {
    const extra = clone(value);
    extra.unexpected = true;
    assert.equal(validator(extra).ok, false);
    const polluted = clone(value);
    Object.setPrototypeOf(polluted, { inherited: true });
    assert.equal(validator(polluted).ok, false);
  }
});

const MUTANTS = [
  ["phase reorder", (r) => r.phaseOrder.reverse(), "STRUCTURAL"],
  [
    "unstable local bytes",
    (r) => {
      r.provenance.localEnd[0].sha256 = "c".repeat(64);
    },
    "STRUCTURAL",
  ],
  [
    "missing build source",
    (r) => {
      r.provenance.buildSourceIdentity.entryCount--;
    },
    "STRUCTURAL",
  ],
  [
    "served bundle fingerprint drift with asserted match",
    (r) => {
      r.provenance.served.find(
        (entry) => entry.path === "Build/CesiumUnminified/index.js",
      ).sha256 = "c".repeat(64);
    },
    "STRUCTURAL",
  ],
  [
    "launch flag omitted",
    (r) => {
      r.provenance.launch.args = [];
    },
    "STRUCTURAL",
  ],
  [
    "WebGL trigger used",
    (r) => {
      r.control.gap.triggerInvocations = 1;
    },
    "STRUCTURAL",
  ],
  [
    "WebGL context replaced",
    (r) => {
      r.control.continuity.sameContext = false;
    },
    "FAIL",
  ],
  [
    "WebGL terrain changed",
    (r) => {
      r.control.continuity.terrainExact = false;
    },
    "FAIL",
  ],
  [
    "WebGL S5 changed",
    (r) => {
      r.control.continuity.s5PayloadExact = false;
    },
    "FAIL",
  ],
  [
    "hook unavailable",
    (r) => {
      r.webgpu.classification = "hook-unavailable";
      r.webgpu.eligibility.eligible = false;
      r.webgpu.eligibility.methodType = "undefined";
      r.webgpu.progress = progress("webgpu", [
        C12_29_S5_REPLACEMENT_WEBGPU_PHASES[0],
      ]);
      for (const key of [
        "before",
        "trigger",
        "loss",
        "recovery",
        "identity",
        "generations",
        "invalidation",
        "ledger",
        "terrain",
        "render",
        "pick",
        "capture",
      ])
        r.webgpu[key] = null;
    },
    "STRUCTURAL",
  ],
  [
    "destroyed reason",
    (r) => {
      r.webgpu.classification = "destroyed-not-replacement";
      r.webgpu.loss.reason = "destroyed";
      r.webgpu.loss.recoverable = false;
      r.webgpu.loss.classification = "destroyed-terminal-not-replacement";
      r.webgpu.progress = progress(
        "webgpu",
        C12_29_S5_REPLACEMENT_WEBGPU_PHASES.slice(0, 3),
      );
      for (const key of [
        "recovery",
        "identity",
        "generations",
        "invalidation",
        "ledger",
        "terrain",
        "render",
        "pick",
        "capture",
      ])
        r.webgpu[key] = null;
    },
    "STRUCTURAL",
  ],
  [
    "wrong trigger object",
    (r) => {
      r.webgpu.trigger.objectPath = "navigator.gpu";
    },
    "STRUCTURAL",
  ],
  [
    "wrong trigger method",
    (r) => {
      r.webgpu.trigger.method = "crashGpuProcess";
    },
    "STRUCTURAL",
  ],
  [
    "duplicate normal trigger",
    (r) => {
      r.webgpu.trigger.invocations = 2;
    },
    "STRUCTURAL",
  ],
  [
    "device destroy trigger",
    (r) => {
      r.webgpu.trigger.destroyCalls = 1;
    },
    "STRUCTURAL",
  ],
  [
    "crash hook trigger",
    (r) => {
      r.webgpu.trigger.crashHookCalls = 1;
    },
    "STRUCTURAL",
  ],
  [
    "loss absent",
    (r) => {
      r.webgpu.loss.observed = false;
    },
    "STRUCTURAL",
  ],
  [
    "loss unrecoverable",
    (r) => {
      r.webgpu.loss.recoverable = false;
    },
    "STRUCTURAL",
  ],
  [
    "Scene replaced",
    (r) => {
      r.webgpu.identity.sameScene = false;
    },
    "FAIL",
  ],
  [
    "context replaced",
    (r) => {
      r.webgpu.identity.sameContext = false;
    },
    "FAIL",
  ],
  [
    "canvas replaced",
    (r) => {
      r.webgpu.identity.sameCanvas = false;
    },
    "FAIL",
  ],
  [
    "GPUCanvasContext replaced",
    (r) => {
      r.webgpu.identity.sameCanvasContext = false;
    },
    "FAIL",
  ],
  [
    "View replaced",
    (r) => {
      r.webgpu.identity.sameView = false;
    },
    "FAIL",
  ],
  [
    "same native device",
    (r) => {
      r.webgpu.identity.freshDevice = false;
    },
    "FAIL",
  ],
  [
    "generation unchanged",
    (r) => {
      r.webgpu.generations.after = 0;
      r.webgpu.generations.delta = 0;
    },
    "FAIL",
  ],
  [
    "generation skipped",
    (r) => {
      r.webgpu.generations.after = 2;
      r.webgpu.generations.delta = 2;
    },
    "FAIL",
  ],
  [
    "invalidation absent",
    (r) => {
      r.webgpu.invalidation.count = 0;
      r.webgpu.invalidation.ordinals = [];
      r.webgpu.ledger.retirement.invalidationCount = 0;
    },
    "FAIL",
  ],
  [
    "invalidation duplicated",
    (r) => {
      r.webgpu.invalidation.count = 2;
      r.webgpu.invalidation.ordinals = [16, 17];
      r.webgpu.ledger.retirement.invalidationCount = 2;
    },
    "FAIL",
  ],
  [
    "retirement out of order",
    (r) => {
      r.webgpu.ledger.retirement.ordered = false;
    },
    "FAIL",
  ],
  [
    "old carrier destroy count contradicts its retained destruction ordinal",
    (r) => {
      r.webgpu.ledger.retirement.oldDestroyCount = 0;
      r.webgpu.ledger.resources.d0Binding2.destroyCount = 0;
      r.webgpu.ledger.sequence.receipts[0].buffer.destroyCount = 0;
    },
    "STRUCTURAL",
  ],
  [
    "old carrier rebound",
    (r) => {
      r.webgpu.ledger.retirement.postLossD0BindCount = 1;
    },
    "FAIL",
  ],
  [
    "D1 reuses D0 buffer",
    (r) => {
      r.webgpu.ledger.resources.d1Binding2.bufferToken = "buffer-1";
    },
    "STRUCTURAL",
  ],
  [
    "D1 carrier destroyed after its descriptor but before bind",
    (r) => {
      spreadD1ExecutionOrdinals(r);
      setD1CarrierDestruction(r, 31, 1);
    },
    "STRUCTURAL",
  ],
  [
    "D1 carrier destroyed after bind but before upload",
    (r) => {
      spreadD1ExecutionOrdinals(r);
      setD1CarrierDestruction(r, 33, 1);
    },
    "STRUCTURAL",
  ],
  [
    "D1 carrier destroyed after finish but before submit",
    (r) => {
      spreadD1ExecutionOrdinals(r);
      setD1CarrierDestruction(r, 37, 1);
    },
    "STRUCTURAL",
  ],
  [
    "D1 null destruction ordinal has a positive destroy count",
    (r) => {
      setD1CarrierDestruction(r, null, 1);
    },
    "STRUCTURAL",
  ],
  [
    "D1 destruction ordinal has a zero destroy count",
    (r) => {
      setD1CarrierDestruction(r, 35, 0);
    },
    "STRUCTURAL",
  ],
  [
    "binding not 2",
    (r) => {
      r.webgpu.ledger.binding2.after.binding = 1;
    },
    "STRUCTURAL",
  ],
  [
    "binding not 64 bytes",
    (r) => {
      r.webgpu.ledger.binding2.after.bindingSize = 256;
    },
    "STRUCTURAL",
  ],
  [
    "binding offset misaligned",
    (r) => {
      r.webgpu.ledger.binding2.after.dynamicOffset = 1;
      r.webgpu.ledger.binding2.after.dynamicOffsets[2] = 1;
      r.webgpu.ledger.sequence.receipts[1].bind.dynamicOffsets[2] = 1;
      r.webgpu.ledger.sequence.receipts[1].upload.effectiveOffset = 1;
    },
    "FAIL",
  ],
  [
    "payload byte drift",
    (r) => {
      r.webgpu.ledger.binding2.after.observedPayload[3] += 1;
      r.webgpu.ledger.sequence.receipts[1].upload.observedPayload[3] += 1;
    },
    "FAIL",
  ],
  [
    "D1 binding carrier has a foreign owner",
    (r) => {
      r.webgpu.ledger.binding2.after.ownedByDevice = false;
    },
    "FAIL",
  ],
  [
    "pre-bind upload substituted",
    (r) => {
      r.webgpu.ledger.binding2.after.uploadOrdinal = 30;
      r.webgpu.ledger.resources.d1Binding2.writeOrdinals = [30];
      r.webgpu.ledger.sequence.receipts[1].upload.ordinal = 30;
    },
    "STRUCTURAL",
  ],
  [
    "encoder finished before the selected upload",
    (r) => {
      r.webgpu.ledger.binding2.after.uploadOrdinal = 33;
      r.webgpu.ledger.binding2.after.finishOrdinal = 32;
      r.webgpu.ledger.resources.d1Binding2.writeOrdinals = [33];
      r.webgpu.ledger.sequence.receipts[1].upload.ordinal = 33;
      r.webgpu.ledger.sequence.receipts[1].finish.ordinal = 32;
    },
    "STRUCTURAL",
  ],
  [
    "proof command encoder identity is not in its native receipt",
    (r) => {
      r.webgpu.ledger.binding2.after.commandEncoderToken = "forged-encoder";
    },
    "STRUCTURAL",
  ],
  [
    "native submit receipt omits the proved command buffer",
    (r) => {
      r.webgpu.ledger.sequence.receipts[1].submit.commandBufferTokens = [
        "foreign-command-buffer",
      ];
    },
    "STRUCTURAL",
  ],
  [
    "upload does not cover effective binding offset",
    (r) => {
      r.webgpu.ledger.binding2.after.uploadOffset = 1024;
      r.webgpu.ledger.binding2.after.uploadByteLength = 64;
    },
    "STRUCTURAL",
  ],
  [
    "binding base offset drift",
    (r) => {
      r.webgpu.ledger.binding2.after.bindingOffset = 256;
    },
    "STRUCTURAL",
  ],
  [
    "D0 error gate armed late",
    (r) => {
      r.webgpu.ledger.devices[0].armedAtAcquisition = false;
      r.webgpu.ledger.sequence.receipts[0].device.armedAtAcquisition = false;
    },
    "FAIL",
  ],
  [
    "adapter request seam unwrapped",
    (r) => {
      r.webgpu.ledger.instrumentation.adapterPrototypeWrapped = false;
    },
    "FAIL",
  ],
  [
    "pool loss diagnostic absent",
    (r) => {
      r.webgpu.runtime.expectedPoolRecoveryConsole = [];
    },
    "FAIL",
  ],
  [
    "pool loss diagnostic duplicated",
    (r) => {
      r.webgpu.runtime.expectedPoolRecoveryConsole.push(
        r.webgpu.runtime.expectedPoolRecoveryConsole[0],
      );
    },
    "FAIL",
  ],
  [
    "pool loss diagnostic has wrong reason",
    (r) => {
      r.webgpu.runtime.expectedPoolRecoveryConsole[0] =
        "[CesiumJS:WebGPUDevicePool] Device lost: destroyed — GPU process terminated";
    },
    "FAIL",
  ],
  [
    "pool loss diagnostic outside exact interval",
    (r) => {
      const [line] = r.webgpu.runtime.expectedPoolRecoveryConsole;
      r.webgpu.runtime.expectedPoolRecoveryConsole = [];
      r.webgpu.runtime.consoleErrors.push(`error: ${line}`);
    },
    "FAIL",
  ],
  [
    "unrelated console error",
    (r) => {
      r.webgpu.runtime.consoleErrors.push("error: unrelated console.error");
    },
    "FAIL",
  ],
  [
    "context loss diagnostic not cross-bound",
    (r) => {
      r.webgpu.runtime.expectedRecoveryConsole[0] =
        "[WebGPU] Device lost (reason: internal): GPU process terminated";
    },
    "FAIL",
  ],
  [
    "terrain selection drift",
    (r) => {
      r.webgpu.terrain.selectedIdsExact = false;
    },
    "FAIL",
  ],
  [
    "S5 CPU drift",
    (r) => {
      r.webgpu.terrain.s5PayloadExact = false;
    },
    "FAIL",
  ],
  [
    "render vacuous",
    (r) => {
      r.webgpu.render.nonVacuous = false;
    },
    "FAIL",
  ],
  [
    "pick direct/failed",
    (r) => {
      r.webgpu.pick.resultPrimitiveIdentity = false;
    },
    "FAIL",
  ],
  [
    "capture helper shortcut",
    (r) => {
      r.webgpu.capture.directHelperCall = true;
    },
    "FAIL",
  ],
  [
    "capture not submitted",
    (r) => {
      r.webgpu.capture.submitted = false;
      r.webgpu.capture.statusCode = 1;
    },
    "FAIL",
  ],
  [
    "cleanup incomplete",
    (r) => {
      r.cleanup.complete = false;
    },
    "FAIL",
  ],
  [
    "raw loss ordinal contradicts retirement ledger",
    (r) => {
      r.webgpu.ledger.sequence.marks.find(
        (entry) => entry.kind === "loss",
      ).ordinal = 13;
    },
    "STRUCTURAL",
  ],
  [
    "raw capture descriptor stage is misattributed",
    (r) => {
      r.webgpu.ledger.sequence.marks.find(
        (entry) => entry.kind === "capture-descriptor",
      ).stage = "replacement-healthy";
    },
    "STRUCTURAL",
  ],
];

test(`all ${MUTANTS.length} adversarial replacement-device mutants are rejected with the expected class`, () => {
  assert.equal(MUTANTS.length, 65);
  for (const [name, mutate, expected] of MUTANTS) {
    const report = passingReport();
    mutate(report);
    const verdict = foldC1229S5ReplacementDeviceGate(report);
    assert.equal(
      verdict.status,
      expected,
      `${name}: ${verdict.structuralReasons.concat(verdict.failureReasons).join("; ")}`,
    );
    assert.notEqual(verdict.status, "PASS", name);
  }
});

test("spaced D1 event ordinals remain valid until a lifetime violation is introduced", () => {
  const report = passingReport();
  spreadD1ExecutionOrdinals(report);
  assert.equal(foldC1229S5ReplacementDeviceGate(report).status, "PASS");
});

test("ERROR artifacts have an exact bounded diagnostics contract", () => {
  const diagnostics = createC1229S5ReplacementErrorDiagnostics({
    stage: "webgpu-page",
    phase: "webgpu.loss_retirement",
    renderer: "webgpu",
    kind: "timeout",
    message: "deliberate timeout",
    stack: "Error: deliberate timeout",
    timeoutMs: 120000,
    pageProgress: progress(
      "webgpu",
      C12_29_S5_REPLACEMENT_WEBGPU_PHASES.slice(0, 3),
    ),
  });
  const artifact = createC1229S5ReplacementErrorArtifact(RUN_ID, diagnostics);
  assert.deepEqual(validateC1229S5ReplacementFinalArtifact(artifact), {
    ok: true,
    reasons: [],
  });
  for (const mutate of [
    (value) => {
      value.diagnostics = {};
    },
    (value) => {
      delete value.diagnostics.stage;
    },
    (value) => {
      value.diagnostics.extra = true;
    },
    (value) => {
      value.diagnostics.renderer = "vulkan";
    },
    (value) => {
      value.diagnostics.timeoutMs = Number.NaN;
    },
    (value) => {
      value.diagnostics.timeoutMs = null;
    },
    (value) => {
      value.diagnostics.stage = "node";
    },
    (value) => {
      value.diagnostics.pageProgress = null;
    },
    (value) => {
      value.diagnostics.renderer = "webgl";
    },
    (value) => {
      value.diagnostics.pageProgress.currentPhase =
        C12_29_S5_REPLACEMENT_WEBGPU_PHASES[1];
    },
    (value) => {
      value.diagnostics.kind = "publication";
      value.diagnostics.timeoutMs = null;
    },
    (value) => {
      value.diagnostics.stage = "browser-launch";
      value.diagnostics.phase = "preflight";
      value.diagnostics.renderer = null;
      value.diagnostics.pageProgress = null;
      value.diagnostics.kind = "cleanup";
      value.diagnostics.timeoutMs = null;
    },
    (value) => {
      value.reasons.failures[0] = "different";
    },
  ]) {
    const mutant = clone(artifact);
    mutate(mutant);
    assert.equal(validateC1229S5ReplacementFinalArtifact(mutant).ok, false);
  }
});

test("probe source uses only the genuine normal termination hook and never device.destroy/crash hooks", () => {
  const source = fs.readFileSync(
    path.join(toolDirectory, "probe-c12-29-s5-replacement-device.mjs"),
    "utf8",
  );
  assert.match(source, /--enable-gpu-benchmarking/u);
  assert.match(source, /terminateGpuProcessNormally/u);
  assert.match(source, /Reflect\.apply\(methodValue, benchmark, \[\]\)/u);
  assert.doesNotMatch(source, /GPUDevice\.prototype\s*\.\s*destroy/u);
  assert.doesNotMatch(source, /oldDevice\s*\.\s*destroy\s*\(/u);
  assert.doesNotMatch(source, /newDevice\s*\.\s*destroy\s*\(/u);
  assert.doesNotMatch(source, /\.crashGpuProcess(?:ForTesting)?\s*\(/u);
  assert.doesNotMatch(source, /--disable-gpu/u);
});

test("pool loss allowlist is exact, interval-scoped, and derived from the production diagnostic", () => {
  const probe = fs.readFileSync(
    path.join(toolDirectory, "probe-c12-29-s5-replacement-device.mjs"),
    "utf8",
  );
  const pool = fs.readFileSync(
    path.join(
      repositoryRoot,
      "packages/engine/Source/Renderer/WebGPU/WebGPUDevicePool.ts",
    ),
    "utf8",
  );
  assert.match(
    pool,
    /`\[CesiumJS:WebGPUDevicePool\] Device lost: \$\{info\.reason\} — \$\{info\.message\}`/u,
  );
  assert.match(probe, /const POOL_DEVICE_LOSS_CONSOLE =/u);
  assert.match(
    probe,
    /recoveryConsoleInterval\.openAtEnd &&\s*POOL_DEVICE_LOSS_CONSOLE\.test\(text\)/u,
  );
  assert.match(
    probe,
    /console\.info\(contract\.recoveryIntervalBeginMarker\)/u,
  );
  assert.match(probe, /console\.info\(contract\.recoveryIntervalEndMarker\)/u);
});

test("native instrumentation is installed before viewer construction and observes the required native seams", () => {
  const source = installC1229S5ReplacementNativeLedger.toString();
  const probe = fs.readFileSync(
    path.join(toolDirectory, "probe-c12-29-s5-replacement-device.mjs"),
    "utf8",
  );
  assert.match(source, /GPUAdapter\?\.prototype,\s*"requestDevice"/u);
  assert.match(source, /GPUDevice\?\.prototype,\s*"createBuffer"/u);
  assert.match(source, /GPUDevice\?\.prototype,\s*"createBindGroup"/u);
  assert.match(source, /GPUDevice\?\.prototype,\s*"createCommandEncoder"/u);
  assert.match(source, /GPUCommandEncoder\?\.prototype,\s*"beginRenderPass"/u);
  assert.match(source, /GPUCommandEncoder\?\.prototype,\s*"finish"/u);
  assert.match(source, /GPUQueue\?\.prototype,\s*"writeBuffer"/u);
  assert.match(source, /GPUQueue\?\.prototype,\s*"submit"/u);
  assert.match(source, /GPUBuffer\?\.prototype,\s*"destroy"/u);
  assert.match(source, /GPURenderPassEncoder\?\.prototype,\s*"setBindGroup"/u);
  assert.match(source, /candidate\.binding === 2 && candidate\.size === 64/u);
  assert.match(source, /bind\.dynamicOffsets\.length !== 3/u);
  assert.match(source, /requireScenePass/u);
  assert.match(source, /Scene Main\|Scene Framebuffer/u);
  assert.match(source, /\^DynEnvMap Capture Face \[0-5\]\$/u);
  assert.match(source, /arm\(device, `replacement-\$\{info\.token\}`\)/u);
  assert.match(source, /write\.offset >= effectiveEnd/u);
  assert.match(source, /write\.ordinal >= commandBuffer\.finishOrdinal/u);
  assert.match(probe, /await withMethodPatch\(/u);
  assert.doesNotMatch(
    probe,
    /captureGlobeRenderer\.getOrCreateCaptureTileCommands\s*=/u,
  );
  assert.match(probe, /cleanup\?\.cleanupComplete === true/u);
});

test("native instrumentation proves runtime-shaped bind/upload/finish/submit ownership and capture attribution", async () => {
  class FakeBuffer {
    destroy() {}
  }
  class FakeCommandBuffer {}
  class FakePass {
    setBindGroup() {}
  }
  class FakeCommandEncoder {
    beginRenderPass() {
      return new FakePass();
    }
    finish() {
      return new FakeCommandBuffer();
    }
  }
  class FakeQueue {
    writeBuffer() {}
    submit() {}
  }
  class FakeDevice {
    constructor() {
      this.queue = new FakeQueue();
    }
    createBuffer() {
      return new FakeBuffer();
    }
    createBindGroup() {
      return {};
    }
    createCommandEncoder() {
      return new FakeCommandEncoder();
    }
  }
  class FakeAdapter {
    async requestDevice() {
      return new FakeDevice();
    }
  }
  const previousWindow = globalThis.window;
  try {
    globalThis.window = {
      GPUDevice: FakeDevice,
      GPUAdapter: FakeAdapter,
      GPUQueue: FakeQueue,
      GPUBuffer: FakeBuffer,
      GPUCommandEncoder: FakeCommandEncoder,
      GPURenderPassEncoder: FakePass,
      GPUBufferUsage: { UNIFORM: 64 },
      navigator: { gpu: {} },
      viewer: null,
      __armWebGPUDevice(device) {
        device.__gateArmed = true;
        return true;
      },
    };
    installC1229S5ReplacementNativeLedger();
    const native = globalThis.window.__c1229S5ReplacementNative;
    const device = await new FakeAdapter().requestDevice();
    assert.equal(device.__gateArmed, true);
    native.trackDevice(device, "D0");
    const buffer = device.createBuffer({
      label: "typed-array proof",
      size: 256,
      usage: 64,
    });
    const bindGroup = device.createBindGroup({
      entries: [
        { binding: 0, resource: { buffer, offset: 0, size: 64 } },
        { binding: 1, resource: { buffer, offset: 0, size: 64 } },
        { binding: 2, resource: { buffer, offset: 0, size: 64 } },
      ],
    });
    const data = new Float32Array(24);
    for (let index = 0; index < data.length; index++) data[index] = index / 8;
    const encodeUploadSubmit = (
      targetDevice,
      targetGroup,
      offsets,
      upload,
      label = "Scene Main Render Pass",
    ) => {
      const encoder = targetDevice.createCommandEncoder({
        label: `${label} encoder`,
      });
      const pass = encoder.beginRenderPass({ label });
      pass.setBindGroup(0, targetGroup, offsets);
      upload?.();
      const commandBuffer = encoder.finish();
      targetDevice.queue.submit([commandBuffer]);
    };
    // Offset/size are elements for a typed array. The witnessed bytes must be
    // exactly elements 4..19, not bytes 4..19.
    encodeUploadSubmit(device, bindGroup, [0, 0, 0], () =>
      device.queue.writeBuffer(buffer, 0, data, 4, 16),
    );
    const expected = Array.from(data.slice(4, 20), Math.fround);
    const proof = native.proof("D0", expected, {
      requiredBindGroupToken: native.bindGroupToken(bindGroup),
      requiredDynamicOffsets: [0, 0, 0],
      requiredPassLabel: "Scene Main Render Pass",
    });
    assert.equal(proof.uploadByteLength, 64);
    assert.deepEqual(proof.observedPayload, expected);
    assert.equal(proof.payloadExact, true);
    assert.equal(proof.ownedByDevice, true);
    assert.match(proof.renderPassToken, /^pass-/u);
    assert.ok(proof.bindOrdinal < proof.uploadOrdinal);
    assert.ok(proof.uploadOrdinal < proof.finishOrdinal);
    assert.ok(proof.finishOrdinal < proof.submitOrdinal);
    const futureBuffer = device.createBuffer({
      label: "pre-bind write must not prove later bind",
      size: 256,
      usage: 64,
    });
    const futureGroup = device.createBindGroup({
      entries: [
        { binding: 0, resource: { buffer: futureBuffer, offset: 0, size: 64 } },
        { binding: 1, resource: { buffer: futureBuffer, offset: 0, size: 64 } },
        { binding: 2, resource: { buffer: futureBuffer, offset: 0, size: 64 } },
      ],
    });
    device.queue.writeBuffer(futureBuffer, 0, data, 4, 16);
    encodeUploadSubmit(device, futureGroup, [0, 0, 0]);
    assert.throws(() =>
      native.proof("D0", expected, {
        requiredBindGroupToken: native.bindGroupToken(futureGroup),
        requiredDynamicOffsets: [0, 0, 0],
      }),
    );
    const partialBuffer = device.createBuffer({
      label: "partial overwrite must invalidate older full upload",
      size: 256,
      usage: 64,
    });
    const partialGroup = device.createBindGroup({
      entries: [
        {
          binding: 0,
          resource: { buffer: partialBuffer, offset: 0, size: 64 },
        },
        {
          binding: 1,
          resource: { buffer: partialBuffer, offset: 0, size: 64 },
        },
        {
          binding: 2,
          resource: { buffer: partialBuffer, offset: 0, size: 64 },
        },
      ],
    });
    encodeUploadSubmit(device, partialGroup, [0, 0, 0], () => {
      device.queue.writeBuffer(partialBuffer, 0, data, 4, 16);
      device.queue.writeBuffer(partialBuffer, 0, new Uint32Array([0]));
    });
    assert.throws(() =>
      native.proof("D0", expected, {
        requiredBindGroupToken: native.bindGroupToken(partialGroup),
        requiredDynamicOffsets: [0, 0, 0],
      }),
    );
    const lateUploadBuffer = device.createBuffer({
      label: "finish-before-upload must not certify",
      size: 256,
      usage: 64,
    });
    const lateUploadGroup = device.createBindGroup({
      entries: [
        {
          binding: 0,
          resource: { buffer: lateUploadBuffer, offset: 0, size: 64 },
        },
        {
          binding: 1,
          resource: { buffer: lateUploadBuffer, offset: 0, size: 64 },
        },
        {
          binding: 2,
          resource: { buffer: lateUploadBuffer, offset: 0, size: 64 },
        },
      ],
    });
    const lateEncoder = device.createCommandEncoder({
      label: "finish-before-upload encoder",
    });
    const latePass = lateEncoder.beginRenderPass({
      label: "Scene Main Render Pass",
    });
    latePass.setBindGroup(0, lateUploadGroup, [0, 0, 0]);
    const lateCommandBuffer = lateEncoder.finish();
    device.queue.writeBuffer(lateUploadBuffer, 0, data, 4, 16);
    device.queue.submit([lateCommandBuffer]);
    assert.throws(() =>
      native.proof("D0", expected, {
        requiredBindGroupToken: native.bindGroupToken(lateUploadGroup),
        requiredDynamicOffsets: [0, 0, 0],
      }),
    );
    const foreignDevice = await new FakeAdapter().requestDevice();
    const foreignBuffer = foreignDevice.createBuffer({
      label: "foreign buffer owner",
      size: 256,
      usage: 64,
    });
    const foreignGroup = device.createBindGroup({
      entries: [
        {
          binding: 0,
          resource: { buffer: foreignBuffer, offset: 0, size: 64 },
        },
        {
          binding: 1,
          resource: { buffer: foreignBuffer, offset: 0, size: 64 },
        },
        {
          binding: 2,
          resource: { buffer: foreignBuffer, offset: 0, size: 64 },
        },
      ],
    });
    encodeUploadSubmit(device, foreignGroup, [0, 0, 0], () =>
      foreignDevice.queue.writeBuffer(foreignBuffer, 0, data, 4, 16),
    );
    const foreignProof = native.proof("D0", expected, {
      requiredBindGroupToken: native.bindGroupToken(foreignGroup),
      requiredDynamicOffsets: [0, 0, 0],
    });
    assert.equal(foreignProof.ownedByDevice, false);

    const replacement = await new FakeAdapter().requestDevice();
    native.trackDevice(replacement, "D1");
    const replacementBuffer = replacement.createBuffer({
      label: "replacement capture binding 2",
      size: 256,
      usage: 64,
    });
    const replacementGroup = replacement.createBindGroup({
      entries: [
        {
          binding: 0,
          resource: { buffer: replacementBuffer, offset: 0, size: 64 },
        },
        {
          binding: 1,
          resource: { buffer: replacementBuffer, offset: 0, size: 64 },
        },
        {
          binding: 2,
          resource: { buffer: replacementBuffer, offset: 0, size: 64 },
        },
      ],
    });
    const descriptorOrdinal = native.mark("capture-descriptor");
    encodeUploadSubmit(
      replacement,
      replacementGroup,
      [0, 0, 0],
      () => replacement.queue.writeBuffer(replacementBuffer, 0, data, 4, 16),
      "DynEnvMap Capture Face 2",
    );
    encodeUploadSubmit(
      replacement,
      replacementGroup,
      [0, 0, 0],
      () => replacement.queue.writeBuffer(replacementBuffer, 0, data, 4, 16),
      "Scene Main Render Pass",
    );
    const laterMainProof = native.proof("D1", expected, {
      requiredBindGroupToken: native.bindGroupToken(replacementGroup),
      requiredDynamicOffsets: [0, 0, 0],
      requiredPassLabel: "Scene Main Render Pass",
    });
    const captureProof = native.proof("D1", expected, {
      requiredBindGroupToken: native.bindGroupToken(replacementGroup),
      requiredDynamicOffsets: [0, 0, 0],
      descriptorOrdinal,
      requireCapturePass: true,
      minimumBindOrdinal: descriptorOrdinal,
    });
    assert.equal(captureProof.passLabel, "DynEnvMap Capture Face 2");
    assert.equal(captureProof.descriptorOrdinal, descriptorOrdinal);
    assert.ok(captureProof.bindOrdinal < captureProof.uploadOrdinal);
    assert.ok(captureProof.uploadOrdinal < captureProof.finishOrdinal);
    assert.ok(captureProof.finishOrdinal < captureProof.submitOrdinal);
    assert.ok(captureProof.bindOrdinal < laterMainProof.bindOrdinal);

    buffer.destroy();
    const resource = native.resource("D0", proof);
    assert.equal(resource.destroyCount, 1);
    assert.equal(resource.deviceToken, proof.deviceToken);
    assert.equal(resource.bufferToken, proof.bufferToken);
  } finally {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  }
});

test("retained-capture method patch restores exact own and inherited descriptors from every exit", async () => {
  const previousWindow = globalThis.window;
  try {
    globalThis.window = {};
    installC1229S5ReplacementMethodPatch();
    const withPatch = globalThis.window.__withC1229S5ReplacementMethodPatch;
    const inherited = function () {
      return "inherited";
    };
    const prototype = {};
    Object.defineProperty(prototype, "capture", {
      value: inherited,
      writable: true,
      enumerable: false,
      configurable: true,
    });
    const inheritedTarget = Object.create(prototype);
    const replacement = function () {
      return "replacement";
    };
    await assert.rejects(
      withPatch(inheritedTarget, "capture", replacement, async (original) => {
        assert.equal(original, inherited);
        assert.equal(inheritedTarget.capture, replacement);
        assert.equal(
          Object.prototype.hasOwnProperty.call(inheritedTarget, "capture"),
          true,
        );
        throw new Error("capture failed after patch installation");
      }),
      /capture failed/u,
    );
    assert.equal(
      Object.prototype.hasOwnProperty.call(inheritedTarget, "capture"),
      false,
    );
    assert.equal(inheritedTarget.capture, inherited);

    const ownTarget = {};
    const own = function () {
      return "own";
    };
    Object.defineProperty(ownTarget, "capture", {
      value: own,
      writable: false,
      enumerable: true,
      configurable: true,
    });
    const before = Object.getOwnPropertyDescriptor(ownTarget, "capture");
    assert.equal(
      await withPatch(ownTarget, "capture", replacement, async (original) => {
        assert.equal(original, own);
        assert.equal(ownTarget.capture, replacement);
        return 17;
      }),
      17,
    );
    assert.deepEqual(
      Object.getOwnPropertyDescriptor(ownTarget, "capture"),
      before,
    );
    assert.equal(ownTarget.capture, own);
  } finally {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  }
});

test("current engine source contains the production recovery and S5 invalidation contract", () => {
  const context = fs.readFileSync(
    path.join(
      repositoryRoot,
      "packages/engine/Source/Renderer/WebGPU/WebGPUContext.ts",
    ),
    "utf8",
  );
  const recovery = fs.readFileSync(
    path.join(
      repositoryRoot,
      "packages/engine/Source/Renderer/WebGPU/WebGPUDeviceLossRecovery.ts",
    ),
    "utf8",
  );
  const eclipse = fs.readFileSync(
    path.join(
      repositoryRoot,
      "packages/engine/Source/Renderer/WebGPU/WebGPUGlobeEclipseUniforms.ts",
    ),
    "utf8",
  );
  const layouts = fs.readFileSync(
    path.join(
      repositoryRoot,
      "packages/engine/Source/Renderer/WebGPU/WebGPUGlobeSurfaceLayouts.ts",
    ),
    "utf8",
  );
  const sceneRenderer = fs.readFileSync(
    path.join(
      repositoryRoot,
      "packages/engine/Source/Renderer/WebGPU/WebGPUSceneRenderer.ts",
    ),
    "utf8",
  );
  const capture = fs.readFileSync(
    path.join(
      repositoryRoot,
      "packages/engine/Source/Renderer/WebGPU/WebGPUDynamicEnvironmentMapCapture.ts",
    ),
    "utf8",
  );
  assert.match(recovery, /if \(reason === "destroyed"\)/u);
  assert.match(recovery, /this\._host\._clearAllCaches\(previous\.device\)/u);
  assert.match(context, /this\._deviceResourceGeneration \+= 1/u);
  assert.match(context, /this\._fireDeviceInvalidated\(\)/u);
  assert.match(context, /this\._uniformAllocator\?\.destroy\(\)/u);
  assert.match(context, /label: string = "Scene Main Render Pass"/u);
  assert.match(sceneRenderer, /label: "Scene Framebuffer Render Pass"/u);
  assert.match(eclipse, /ECLIPSE_UNIFORM_FLOATS = 16/u);
  assert.match(eclipse, /ECLIPSE_UNIFORM_BYTES = ECLIPSE_UNIFORM_FLOATS \* 4/u);
  assert.match(layouts, /uniformBuffer\(2, Stage\.FRAGMENT/u);
  assert.match(capture, /label: `DynEnvMap Capture Face \$\{face\}`/u);
  assert.match(
    capture,
    /pass\.setBindGroup\([\s\S]*ctx\.flushPendingUniformUploads\?\.\(\);[\s\S]*device\.queue\.submit\(\[encoder\.finish\(\)\]\)/u,
  );
});

test("loopback validation rejects credentials, non-HTTP, non-loopback, search, and hash", () => {
  assert.equal(
    validateC1229S5ReplacementLoopbackBase("http://localhost:8080").origin,
    "http://localhost:8080",
  );
  for (const value of [
    "https://localhost:8080",
    "http://example.com",
    "http://user:pass@localhost:8080",
    "http://localhost:8080/?x=1",
    "http://localhost:8080/#x",
  ])
    assert.throws(() => validateC1229S5ReplacementLoopbackBase(value));
  assert.throws(
    () => createC1229S5ReplacementArtifactPaths("../../escape", os.tmpdir()),
    /runId must be a UUID v4/u,
  );
});

test("evidence lifecycle finalizes immutable archive/latest and removes RUNNING/lock", () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "c1229-s5-replacement-"),
  );
  try {
    const paths = createC1229S5ReplacementArtifactPaths(RUN_ID, directory);
    const ownership = beginC1229S5ReplacementEvidenceRun(paths, RUN_ID);
    const artifact = artifactFrom(passingReport());
    const wrongRun = clone(artifact);
    wrongRun.runId = "123e4567-e89b-42d3-a456-426614174099";
    assert.throws(
      () => finalizeC1229S5ReplacementEvidence(paths, wrongRun, ownership),
      /artifact runId does not match owned evidence run/u,
    );
    assert.equal(fs.existsSync(paths.running), true);
    assert.equal(fs.existsSync(paths.lock), true);
    const publication = finalizeC1229S5ReplacementEvidence(
      paths,
      artifact,
      ownership,
    );
    assert.equal(publication.sha256.length, 64);
    assert.deepEqual(
      JSON.parse(fs.readFileSync(paths.archive, "utf8")),
      artifact,
    );
    assert.deepEqual(
      JSON.parse(fs.readFileSync(paths.latest, "utf8")),
      artifact,
    );
    assert.equal(fs.existsSync(paths.running), false);
    assert.equal(fs.existsSync(paths.lock), false);
    assert.throws(() =>
      fs.writeFileSync(paths.archive, "replace", { flag: "wx" }),
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("finalization refuses descriptor-hostile evidence and preserves its owned RUNNING checkpoint", () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "c1229-s5-replacement-hostile-"),
  );
  try {
    const paths = createC1229S5ReplacementArtifactPaths(RUN_ID, directory);
    const ownership = beginC1229S5ReplacementEvidenceRun(paths, RUN_ID);
    let calls = 0;
    const artifact = artifactFrom(passingReport());
    Object.defineProperty(artifact, "toJSON", {
      enumerable: false,
      value() {
        calls++;
        return null;
      },
    });
    assert.throws(
      () => finalizeC1229S5ReplacementEvidence(paths, artifact, ownership),
      /refusing non-materializable final artifact/u,
    );
    assert.equal(calls, 0);
    assert.equal(fs.existsSync(paths.running), true);
    assert.equal(fs.existsSync(paths.lock), true);
    assert.equal(fs.existsSync(paths.archive), false);
    assert.equal(fs.existsSync(paths.latest), false);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("a lock-release failure restores the exact owned RUNNING checkpoint", () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "c1229-s5-replacement-release-failure-"),
  );
  try {
    const paths = createC1229S5ReplacementArtifactPaths(RUN_ID, directory);
    const ownership = beginC1229S5ReplacementEvidenceRun(paths, RUN_ID);
    const operations = Object.create(fs);
    let injected = false;
    operations.unlinkSync = (file) => {
      if (
        !injected &&
        String(file).includes("active.lock.json.") &&
        String(file).endsWith(".receipt")
      ) {
        injected = true;
        throw new Error("injected lock receipt unlink failure");
      }
      return fs.unlinkSync(file);
    };
    assert.throws(
      () =>
        finalizeC1229S5ReplacementEvidence(
          paths,
          artifactFrom(passingReport()),
          ownership,
          operations,
        ),
      (error) => {
        assert.equal(error.retainReplacementRunning, true);
        assert.match(error.message, /injected lock receipt unlink failure/u);
        return true;
      },
    );
    assert.equal(injected, true);
    assert.deepEqual(fs.readFileSync(paths.running), ownership.runningBytes);
    assert.deepEqual(fs.readFileSync(paths.lock), ownership.lockBytes);
    assert.equal(fs.existsSync(paths.archive), true);
    assert.equal(fs.existsSync(paths.latest), true);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("a prior latest must be canonical and backed by its exact immutable archive", () => {
  for (const corrupt of ["latest-format", "missing-archive"]) {
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), `c1229-s5-replacement-prior-${corrupt}-`),
    );
    try {
      const firstRun = "123e4567-e89b-42d3-a456-426614174001";
      const firstPaths = createC1229S5ReplacementArtifactPaths(
        firstRun,
        directory,
      );
      const ownership = beginC1229S5ReplacementEvidenceRun(
        firstPaths,
        firstRun,
      );
      const firstArtifact = artifactFrom(passingReport());
      firstArtifact.runId = firstRun;
      finalizeC1229S5ReplacementEvidence(firstPaths, firstArtifact, ownership);
      if (corrupt === "latest-format") {
        fs.appendFileSync(firstPaths.latest, "\n");
      } else {
        fs.rmSync(firstPaths.archive);
      }
      const nextPaths = createC1229S5ReplacementArtifactPaths(
        RUN_ID,
        directory,
      );
      assert.throws(
        () => beginC1229S5ReplacementEvidenceRun(nextPaths, RUN_ID),
        corrupt === "latest-format"
          ? /prior latest is not canonical/u
          : /prior immutable replacement-device archive bytes differ/u,
      );
      assert.equal(fs.existsSync(nextPaths.running), false);
      assert.equal(fs.existsSync(nextPaths.lock), false);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  }
});

test("lifecycle accepts finalized ERROR as prior latest, then supersedes it without deleting its archive", () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "c1229-s5-replacement-error-"),
  );
  try {
    const firstRun = "123e4567-e89b-42d3-a456-426614174001";
    const firstPaths = createC1229S5ReplacementArtifactPaths(
      firstRun,
      directory,
    );
    const firstOwnership = beginC1229S5ReplacementEvidenceRun(
      firstPaths,
      firstRun,
    );
    const diagnostics = createC1229S5ReplacementErrorDiagnostics({
      message: "expected setup red",
    });
    const errorArtifact = createC1229S5ReplacementErrorArtifact(
      firstRun,
      diagnostics,
    );
    finalizeC1229S5ReplacementEvidence(
      firstPaths,
      errorArtifact,
      firstOwnership,
    );
    const errorBytes = fs.readFileSync(firstPaths.archive);

    const secondPaths = createC1229S5ReplacementArtifactPaths(
      RUN_ID,
      directory,
    );
    const secondOwnership = beginC1229S5ReplacementEvidenceRun(
      secondPaths,
      RUN_ID,
    );
    const passArtifact = artifactFrom(passingReport());
    finalizeC1229S5ReplacementEvidence(
      secondPaths,
      passArtifact,
      secondOwnership,
    );
    assert.deepEqual(fs.readFileSync(firstPaths.archive), errorBytes);
    assert.equal(
      JSON.parse(fs.readFileSync(secondPaths.latest, "utf8")).status,
      "PASS",
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("watchdog returns operation results and invokes bounded timeout cleanup", async () => {
  assert.equal(
    await withC1229S5ReplacementWatchdog(
      async () => 7,
      async () => {},
      100,
    ),
    7,
  );
  let cleaned = false;
  await assert.rejects(
    withC1229S5ReplacementWatchdog(
      () => new Promise(() => {}),
      async () => {
        cleaned = true;
        return { cleanupComplete: true };
      },
      10,
    ),
    /watchdog expired/u,
  );
  assert.equal(cleaned, true);
  await assert.rejects(
    withC1229S5ReplacementWatchdog(
      () => new Promise(() => {}),
      async () => undefined,
      10,
    ),
    (error) => {
      assert.equal(error.retainReplacementRunning, true);
      assert.match(error.message, /cleanup remained unproven/u);
      return true;
    },
  );
  let rejectOperation;
  await assert.rejects(
    withC1229S5ReplacementWatchdog(
      () =>
        new Promise((_, reject) => {
          rejectOperation = reject;
        }),
      async () => {
        rejectOperation(new Error("page closed by timeout cleanup"));
        throw new Error("bounded browser close failed");
      },
      10,
    ),
    (error) => {
      assert.match(error.message, /watchdog and browser close failed/u);
      assert.deepEqual(error.c1229Replacement, {
        stage: "watchdog",
        phase: "preflight",
        renderer: null,
        kind: "timeout",
        timeoutMs: 10,
        pageProgress: null,
      });
      return true;
    },
  );

  const checkpoint = {
    stage: "webgpu-page",
    phase: "webgpu.replacement_capture_cleanup",
    renderer: "webgpu",
    kind: "timeout",
    timeoutMs: null,
    pageProgress: progress(
      "webgpu",
      C12_29_S5_REPLACEMENT_WEBGPU_PHASES.slice(0, 6),
    ),
  };
  await assert.rejects(
    withC1229S5ReplacementWatchdog(
      () => new Promise(() => {}),
      async () => ({ cleanupComplete: false, checkpoint }),
      10,
    ),
    (error) => {
      assert.equal(error.retainReplacementRunning, true);
      assert.deepEqual(error.c1229Replacement, {
        ...checkpoint,
        timeoutMs: 10,
      });
      assert.equal(checkpoint.timeoutMs, null);
      assert.match(error.message, /cleanup remained unproven/u);
      return true;
    },
  );

  await assert.rejects(
    withC1229S5ReplacementWatchdog(
      () => new Promise(() => {}),
      async () => ({ cleanupComplete: true, checkpoint }),
      10,
    ),
    (error) => {
      assert.equal(error.retainReplacementRunning, undefined);
      assert.deepEqual(error.c1229Replacement, {
        ...checkpoint,
        timeoutMs: 10,
      });
      return true;
    },
  );
});
