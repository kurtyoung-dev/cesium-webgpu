// @purpose Certifies the S5 eclipse-shadow replacement-device evidence pipeline: schemas, phases, ledger/provenance validators, gate fold of its probe+lib pair.
// @status ACTIVE

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { deflateSync } from "node:zlib";

import {
  C12_29_S5_REPLACEMENT_CONFIG,
  C12_29_S5_REPLACEMENT_CONTRACT,
  C12_29_S5_REPLACEMENT_CONTROL_PHASES,
  C12_29_S5_REPLACEMENT_LOCAL_FILES,
  C12_29_S5_REPLACEMENT_NATIVE_LEDGER_SCHEMA,
  C12_29_S5_REPLACEMENT_PAGE_PROGRESS_SCHEMA,
  C12_29_S5_REPLACEMENT_PHASES,
  C12_29_S5_REPLACEMENT_POLICY_BOUNDARY_SCHEMA,
  C12_29_S5_REPLACEMENT_POLICY_EDGES,
  C12_29_S5_REPLACEMENT_POLICY_EXTERNALS,
  C12_29_S5_REPLACEMENT_POLICY_FILES,
  C12_29_S5_REPLACEMENT_POLICY_ROOTS,
  C12_29_S5_REPLACEMENT_PROVENANCE_SCHEMA,
  C12_29_S5_REPLACEMENT_RUNTIME_DIAGNOSTICS_SCHEMA,
  C12_29_S5_REPLACEMENT_SCHEMA,
  C12_29_S5_REPLACEMENT_SERVED_FILES,
  C12_29_S5_REPLACEMENT_SOURCE_FILES,
  C12_29_S5_REPLACEMENT_SOURCE_BOUNDARY_SCHEMA,
  C12_29_S5_REPLACEMENT_THRESHOLD_DERIVATION,
  C12_29_S5_REPLACEMENT_WEBGPU_PHASES,
  createC1229S5ReplacementErrorArtifact,
  createC1229S5ReplacementErrorDiagnostics,
  deriveC1229S5ReplacementPreflightSha256,
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
  C12_29_S5_REPLACEMENT_CAPTURE_PROOF_SCHEMA,
  C12_29_S5_REPLACEMENT_CAPTURE_TRANSACTION_SCHEMA,
  C12_29_S5_REPLACEMENT_FUSED_SOURCE_SHA256,
  C12_29_S5_REPLACEMENT_RUNTIME_ATTESTATION_SCHEMA,
  C12_29_S5_REPLACEMENT_RUNTIME_ATTESTOR_SOURCE_SHA256,
  C12_29_S5_REPLACEMENT_SAMPLER_BEGIN,
  C12_29_S5_REPLACEMENT_SAMPLER_END,
  C12_29_S5_REPLACEMENT_SAMPLER_SCHEMA,
  C12_29_S5_REPLACEMENT_SAMPLER_SOURCE_SHA256,
  analyzeC1229S5ReplacementCaptureSource,
  deriveC1229S5ReplacementCaptureFrameSha256,
  deriveC1229S5ReplacementCaptureTransactionSha256,
  inspectC1229S5ReplacementPng,
  sampleC1229S5ReplacementRgba,
} from "./lib/c12-29-s5-replacement-device-capture.mjs";
import {
  FUSED_SNAPSHOT_BEGIN,
  FUSED_SNAPSHOT_END,
} from "./lib/same-task-capture.mjs";
import {
  beginC1229S5ReplacementEvidenceRun,
  collectC1229S5ReplacementPolicyBoundary,
  collectC1229S5ReplacementSourceBoundary,
  createC1229S5ReplacementArtifactPaths,
  finalizeC1229S5ReplacementEvidence,
  installC1229S5ReplacementMethodPatch,
  installC1229S5ReplacementNativeLedger,
  resumeC1229S5ReplacementEvidenceCandidate,
  validateC1229S5ReplacementLoopbackBase,
  withC1229S5ReplacementWatchdog,
} from "./probe-c12-29-s5-replacement-device.mjs";
const toolDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(toolDirectory, "../..");
const RUN_ID = "123e4567-e89b-42d3-a456-426614174000";
const SHA = "a".repeat(64);
const CAPTURE_NONCES = Object.freeze({
  "control-before": "223e4567-e89b-42d3-a456-426614174001",
  "control-after-gap": "223e4567-e89b-42d3-a456-426614174002",
  "webgpu-before": "223e4567-e89b-42d3-a456-426614174003",
  "webgpu-after": "223e4567-e89b-42d3-a456-426614174004",
});
const CAPTURE_ORDINALS = Object.freeze({
  "control-before": 1,
  "control-after-gap": 2,
  "webgpu-before": 1,
  "webgpu-after": 2,
});
const SESSION_IDS = Object.freeze({
  webgl: "323e4567-e89b-42d3-a456-426614174000",
  webgpu: "323e4567-e89b-42d3-a456-426614174001",
});
const WITNESS_NONCES = Object.freeze({
  webgl: "423e4567-e89b-42d3-a456-426614174000",
  webgpu: "423e4567-e89b-42d3-a456-426614174001",
});

const captureSourceProof = () => ({
  schema: C12_29_S5_REPLACEMENT_CAPTURE_PROOF_SCHEMA,
  measurement: {
    declarationCount: 1,
    identifierUses: 4,
    pageEvaluateCalls: 1,
    phaseSnapshotCalls: 4,
    phaseSnapshotLabels: [
      "control-before",
      "control-after-gap",
      "webgpu-before",
      "webgpu-after",
    ],
    finishCalls: 4,
    executedSha256: SHA,
  },
  fused: {
    beginMarkerCount: 1,
    endMarkerCount: 1,
    canonicalSha256: C12_29_S5_REPLACEMENT_FUSED_SOURCE_SHA256,
    embeddedSha256: C12_29_S5_REPLACEMENT_FUSED_SOURCE_SHA256,
    executedSha256: C12_29_S5_REPLACEMENT_FUSED_SOURCE_SHA256,
  },
  sampler: {
    schema: C12_29_S5_REPLACEMENT_SAMPLER_SCHEMA,
    beginMarkerCount: 1,
    endMarkerCount: 1,
    canonicalSha256: C12_29_S5_REPLACEMENT_SAMPLER_SOURCE_SHA256,
    embeddedSha256: C12_29_S5_REPLACEMENT_SAMPLER_SOURCE_SHA256,
    executedSha256: C12_29_S5_REPLACEMENT_SAMPLER_SOURCE_SHA256,
  },
  frameReader: {
    declarationCount: 1,
    executedSha256: SHA,
    restricted: true,
  },
  attestor: {
    schema: C12_29_S5_REPLACEMENT_RUNTIME_ATTESTATION_SCHEMA,
    installerSha256: C12_29_S5_REPLACEMENT_RUNTIME_ATTESTOR_SOURCE_SHA256,
    initScriptCalls: 1,
    exposeBindingCalls: 1,
    prepareCalls: 1,
    captureCalls: 1,
    finishCalls: 4,
    restrictedDialect: true,
    randomBindingNames: 1,
    eventSinkWrites: 1,
    bodyBindings: 1,
    runnerRestricted: true,
  },
  helperInstalls: 1,
  captureCalls: 1,
  samplerCalls: 1,
  documentaryOrigins: 1,
  sampleOrigins: 1,
  sameOrigin: true,
  failureCount: 0,
});

function replacementCaptureFailures(source) {
  return analyzeC1229S5ReplacementCaptureSource(source).failures;
}

const clone = (value) => structuredClone(value);
const image = (label, seed = 0) => {
  const renderer = label.startsWith("control-") ? "webgl" : "webgpu";
  const afterReplacement = label === "webgpu-after";
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
    sessionId: SESSION_IDS[renderer],
    renderer,
    witnessNonce: WITNESS_NONCES[renderer],
    witnessSequence: CAPTURE_ORDINALS[label] + 1,
    sceneToken: `${renderer}-scene`,
    contextToken: `${renderer}-context`,
    canvasToken: `${renderer}-canvas`,
    adapterToken:
      renderer === "webgpu"
        ? afterReplacement
          ? "webgpu-adapter-D1"
          : "webgpu-adapter-D0"
        : null,
    deviceToken:
      renderer === "webgpu"
        ? afterReplacement
          ? "webgpu-device-D1"
          : "webgpu-device-D0"
        : null,
    resourceGeneration:
      renderer === "webgpu" ? (afterReplacement ? 1 : 0) : null,
    captureNonce: CAPTURE_NONCES[label],
    captureOrdinal: CAPTURE_ORDINALS[label],
    frameSha256: SHA,
    transactionSha256: SHA,
    width: C12_29_S5_REPLACEMENT_CONFIG.viewport.width,
    height: C12_29_S5_REPLACEMENT_CONFIG.viewport.height,
    pngFile: `${RUN_ID}.${label}.png`,
    byteLength: 1024 + seed,
    sha256: SHA,
    sampleSha256: createHash("sha256")
      .update(JSON.stringify(sampleRgba))
      .digest("hex"),
    samplerSchema: C12_29_S5_REPLACEMENT_SAMPLER_SCHEMA,
    sampleWidth: C12_29_S5_REPLACEMENT_CONFIG.sampleWidth,
    sampleHeight: C12_29_S5_REPLACEMENT_CONFIG.sampleHeight,
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

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const PNG_CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < table.length; index++) {
    let value = index;
    for (let bit = 0; bit < 8; bit++) {
      value = (value & 1) !== 0 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

function pngCrc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc = PNG_CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const typeBytes = Buffer.from(type, "ascii");
  const chunk = Buffer.alloc(12 + data.byteLength);
  chunk.writeUInt32BE(data.byteLength, 0);
  typeBytes.copy(chunk, 4);
  data.copy(chunk, 8);
  chunk.writeUInt32BE(
    pngCrc32(Buffer.concat([typeBytes, data])),
    8 + data.length,
  );
  return chunk;
}

function solidPng(red, green, blue, alpha = 255) {
  const { width, height } = C12_29_S5_REPLACEMENT_CONFIG.viewport;
  const scanlines = Buffer.alloc(height * (width * 4 + 1));
  let offset = 0;
  for (let y = 0; y < height; y++) {
    scanlines[offset++] = 0;
    for (let x = 0; x < width; x++) {
      scanlines[offset++] = red;
      scanlines[offset++] = green;
      scanlines[offset++] = blue;
      scanlines[offset++] = alpha;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(scanlines)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function persistedImage(runId, label, bytes, frame) {
  const decoded = inspectC1229S5ReplacementPng(bytes);
  assert.equal(decoded.ok, true, decoded.reasons?.join("; "));
  const proof = decoded.proof;
  const renderer = label.startsWith("control-") ? "webgl" : "webgpu";
  const afterReplacement = label === "webgpu-after";
  const value = {
    label,
    sessionId: SESSION_IDS[renderer],
    renderer,
    witnessNonce: WITNESS_NONCES[renderer],
    witnessSequence: CAPTURE_ORDINALS[label] + 1,
    sceneToken: `${renderer}-scene`,
    contextToken: `${renderer}-context`,
    canvasToken: `${renderer}-canvas`,
    adapterToken:
      renderer === "webgpu"
        ? afterReplacement
          ? "webgpu-adapter-D1"
          : "webgpu-adapter-D0"
        : null,
    deviceToken:
      renderer === "webgpu"
        ? afterReplacement
          ? "webgpu-device-D1"
          : "webgpu-device-D0"
        : null,
    resourceGeneration:
      renderer === "webgpu" ? (afterReplacement ? 1 : 0) : null,
    captureNonce: CAPTURE_NONCES[label],
    captureOrdinal: CAPTURE_ORDINALS[label],
    frameSha256: deriveC1229S5ReplacementCaptureFrameSha256(frame),
    transactionSha256: SHA,
    width: proof.width,
    height: proof.height,
    pngFile: `${runId}.${label}.png`,
    byteLength: proof.byteLength,
    sha256: proof.sha256,
    sampleSha256: createHash("sha256")
      .update(JSON.stringify(proof.sampleRgba))
      .digest("hex"),
    samplerSchema: proof.samplerSchema,
    sampleWidth: proof.sampleWidth,
    sampleHeight: proof.sampleHeight,
    nonBlackPixels: proof.nonBlackPixels,
    meanLuminance: proof.meanLuminance,
    sampleRgba: proof.sampleRgba,
  };
  value.transactionSha256 =
    deriveC1229S5ReplacementCaptureTransactionSha256(value);
  return value;
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
  const value = {
    frameNumber,
    selectionRevision: 9,
    surfaceRadius: 6_379_389,
    selectedTileIds: ["1/0/0", "1/1/0"],
    providerToken: "provider-1",
    s5: s5(),
    image: image(label, seed),
  };
  value.image.frameSha256 = deriveC1229S5ReplacementCaptureFrameSha256(value);
  value.image.transactionSha256 =
    deriveC1229S5ReplacementCaptureTransactionSha256(value.image);
  return value;
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

function runtimeAttestation(renderer, sessionId, snapshots = []) {
  const witnessNonce = WITNESS_NONCES[renderer];
  const sceneToken = `${renderer}-scene`;
  const contextToken = `${renderer}-context`;
  const canvasToken = `${renderer}-canvas`;
  const sourceProof = captureSourceProof();
  const captureEvents = snapshots.map((entry, index) => {
    const value = entry.image;
    return {
      schema: C12_29_S5_REPLACEMENT_RUNTIME_ATTESTATION_SCHEMA,
      sessionId,
      renderer,
      witnessNonce,
      sequence: index + 2,
      kind: "capture",
      label: value.label,
      captureOrdinal: value.captureOrdinal,
      captureNonce: value.captureNonce,
      frameSha256: value.frameSha256,
      pngSha256: value.sha256,
      sampleSha256: value.sampleSha256,
      transactionSha256: value.transactionSha256,
      beforeFrameNumber: Math.max(0, entry.frameNumber - 1),
      frameNumber: entry.frameNumber,
      renderCalls: 1,
      freezeCalls: 1,
      witnessSequence: index + 2,
      sceneToken: value.sceneToken,
      contextToken: value.contextToken,
      canvasToken: value.canvasToken,
      adapterToken: value.adapterToken,
      deviceToken: value.deviceToken,
      resourceGeneration: value.resourceGeneration,
    };
  });
  const finalImage = snapshots.at(-1)?.image;
  return {
    schema: C12_29_S5_REPLACEMENT_RUNTIME_ATTESTATION_SCHEMA,
    sessionId,
    renderer,
    installerSha256: C12_29_S5_REPLACEMENT_RUNTIME_ATTESTOR_SOURCE_SHA256,
    events: [
      {
        schema: C12_29_S5_REPLACEMENT_RUNTIME_ATTESTATION_SCHEMA,
        sessionId,
        renderer,
        witnessNonce,
        sequence: 1,
        kind: "begin",
        installerSha256: C12_29_S5_REPLACEMENT_RUNTIME_ATTESTOR_SOURCE_SHA256,
        measurementSha256: sourceProof.measurement.executedSha256,
        captureFactorySha256: C12_29_S5_REPLACEMENT_FUSED_SOURCE_SHA256,
        samplerSha256: C12_29_S5_REPLACEMENT_SAMPLER_SOURCE_SHA256,
        frameReaderSha256: sourceProof.frameReader.executedSha256,
        sceneToken,
        contextToken,
        canvasToken,
      },
      ...captureEvents,
      {
        schema: C12_29_S5_REPLACEMENT_RUNTIME_ATTESTATION_SCHEMA,
        sessionId,
        renderer,
        witnessNonce,
        sequence: captureEvents.length + 2,
        kind: "finish",
        bodySha256: SHA,
        captureCount: captureEvents.length,
        finalSceneToken: finalImage?.sceneToken ?? sceneToken,
        finalContextToken: finalImage?.contextToken ?? contextToken,
        finalCanvasToken: finalImage?.canvasToken ?? canvasToken,
        finalAdapterToken:
          finalImage?.adapterToken ??
          (renderer === "webgpu" ? "webgpu-adapter-D1" : null),
        finalDeviceToken:
          finalImage?.deviceToken ??
          (renderer === "webgpu" ? "webgpu-device-D1" : null),
        finalResourceGeneration:
          finalImage?.resourceGeneration ?? (renderer === "webgpu" ? 1 : null),
      },
    ],
  };
}

function attachRuntimeAttestation(report) {
  if (report.webgpu.classification === "eligible-replacement") {
    report.webgpu.before.image.resourceGeneration =
      report.webgpu.generations.before;
    report.webgpu.terrain.before.image.resourceGeneration =
      report.webgpu.generations.before;
    report.webgpu.terrain.after.image.resourceGeneration =
      report.webgpu.generations.after;
    for (const value of [
      report.webgpu.before.image,
      report.webgpu.terrain.before.image,
      report.webgpu.terrain.after.image,
    ]) {
      value.transactionSha256 =
        deriveC1229S5ReplacementCaptureTransactionSha256(value);
    }
    report.webgpu.render.beforeImage = report.webgpu.terrain.before.image;
    report.webgpu.render.afterImage = report.webgpu.terrain.after.image;
  }
  report.provenance.sessions[0].attestation = runtimeAttestation(
    "webgl",
    SESSION_IDS.webgl,
    [report.control.before, report.control.afterGap],
  );
  report.provenance.sessions[1].attestation = runtimeAttestation(
    "webgpu",
    SESSION_IDS.webgpu,
    report.webgpu.before
      ? report.webgpu.classification === "eligible-replacement"
        ? [report.webgpu.before, report.webgpu.terrain.after]
        : [report.webgpu.before]
      : [],
  );
  return report;
}

function provenance() {
  const files = C12_29_S5_REPLACEMENT_LOCAL_FILES.map(fingerprint);
  const sourceBoundary = {
    schema: C12_29_S5_REPLACEMENT_SOURCE_BOUNDARY_SCHEMA,
    sourceMapByteLength: 4096,
    sourceMapSha256: SHA,
    sourceMapEntryCount: 2202,
    resolvedEntryCount: 2202,
    exactEntryCount: 2202,
    pathSetSha256: SHA,
    currentSetSha256: SHA,
    embeddedSetSha256: SHA,
    roots: [...C12_29_S5_REPLACEMENT_SOURCE_FILES],
    rootsPresent: true,
    duplicatePaths: [],
    missingPaths: [],
    allExact: true,
  };
  const value = {
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
    captureSourceProof: captureSourceProof(),
    policyBoundary: {
      schema: C12_29_S5_REPLACEMENT_POLICY_BOUNDARY_SCHEMA,
      roots: [...C12_29_S5_REPLACEMENT_POLICY_ROOTS],
      files: C12_29_S5_REPLACEMENT_POLICY_FILES.map(fingerprint),
      edges: clone(C12_29_S5_REPLACEMENT_POLICY_EDGES),
      externalSpecifiers: [...C12_29_S5_REPLACEMENT_POLICY_EXTERNALS],
      dynamicImports: [
        {
          from: "Tools/visual-regression/probe-c12-29-s5-replacement-device.mjs",
          expression: "contract.runtimePath",
        },
      ],
      closed: true,
    },
    sourceBoundaryStart: clone(sourceBoundary),
    sourceBoundaryEnd: clone(sourceBoundary),
    preflightSha256: "",
    stable: true,
    buildEntryMatchesServed: true,
    servedMatchesLocal: true,
    browserResponsesMatchLocal: true,
    launch: {
      channel: "msedge",
      headless: true,
      args: ["--enable-gpu-benchmarking"],
    },
    browser: { name: "chromium", version: "140.0.0.0" },
    sessions: ["webgl", "webgpu"].map((renderer) => ({
      sessionId: SESSION_IDS[renderer],
      renderer,
      runtimeIdentity: {
        renderer,
        userAgent: "fixture Chromium",
        platform: "Win32",
        language: "en-US",
        devicePixelRatio: 1,
        secureContext: true,
        webdriver: true,
      },
      responses: C12_29_S5_REPLACEMENT_SERVED_FILES.map((file) => ({
        path: file,
        url: `http://localhost:8080/${file}`,
        status: 200,
        method: "GET",
        resourceType: file.endsWith(".html") ? "document" : "script",
        fromServiceWorker: false,
        byteLength: 100,
        sha256: SHA,
      })),
      attestation: runtimeAttestation(renderer, SESSION_IDS[renderer]),
    })),
  };
  value.preflightSha256 = deriveC1229S5ReplacementPreflightSha256(value);
  return value;
}

function preflightProvenance() {
  const value = provenance();
  value.localEnd = [];
  value.sourceBoundaryEnd = null;
  value.stable = false;
  value.browserResponsesMatchLocal = false;
  value.browser = null;
  value.sessions = [];
  return value;
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

function gpuDeviceIdentity(role) {
  const limits = {
    maxBindGroups: 4,
    maxBufferSize: 268_435_456,
    maxTextureDimension2D: 8192,
    maxUniformBufferBindingSize: 65_536,
    minUniformBufferOffsetAlignment: 256,
  };
  return {
    adapterInfo: {
      vendor: "fixture-vendor",
      architecture: "fixture-architecture",
      device: `fixture-${role}`,
      description: "fixture WebGPU adapter",
    },
    adapterFeatures: ["bgra8unorm-storage"],
    adapterLimits: { ...limits },
    deviceLabel: `replacement-${role}`,
    deviceFeatures: ["bgra8unorm-storage"],
    deviceLimits: { ...limits },
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
        identity: gpuDeviceIdentity("D0"),
      },
      {
        role: "D1",
        token: "device-2",
        firstOrdinal: 20,
        armedAtAcquisition: true,
        createBufferCount: 10,
        createBindGroupCount: 10,
        identity: gpuDeviceIdentity("D1"),
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

// A faithful ownership-survival break: the witnessed owner tokens diverge
// across the replacement while webgpu.identity still claims survival, so only
// the derived check can catch it.  attachRuntimeAttestation re-seals the
// WebGPU capture transactions, which is why these leave the seals alone.
function divergeReplacementOwnerToken(report, key) {
  const after = report.webgpu.terrain.after.image;
  after[key] = `${after[key]}-replaced`;
}

function reuseReplacementDevice(report) {
  const before = report.webgpu.before.image;
  const after = report.webgpu.terrain.after.image;
  after.adapterToken = before.adapterToken;
  after.deviceToken = before.deviceToken;
}

function divergeControlOwnerToken(report, key) {
  const image = report.control.afterGap.image;
  image[key] = `${image[key]}-replaced`;
  image.transactionSha256 =
    deriveC1229S5ReplacementCaptureTransactionSha256(image);
}

function ownershipBreakReport() {
  const report = passingReport();
  divergeReplacementOwnerToken(report, "sceneToken");
  return attachRuntimeAttestation(report);
}

function passingReport() {
  const before = snapshot("webgpu-before", 100);
  const after = snapshot("webgpu-after", 120, 1);
  // Keep CPU S5/terrain exact while permitting a small post-recovery image delta.
  const renderDelta = sampleDelta(
    before.image.sampleRgba,
    after.image.sampleRgba,
  );
  const report = {
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
        nonVacuous: true,
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
  return attachRuntimeAttestation(report);
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

function persistableArtifact(runId = RUN_ID) {
  const report = passingReport();
  report.runId = runId;
  const bytes = solidPng(96, 128, 160);
  const images = {
    controlBefore: persistedImage(
      runId,
      "control-before",
      bytes,
      report.control.before,
    ),
    controlAfterGap: persistedImage(
      runId,
      "control-after-gap",
      bytes,
      report.control.afterGap,
    ),
    webgpuBefore: persistedImage(
      runId,
      "webgpu-before",
      bytes,
      report.webgpu.before,
    ),
    webgpuAfter: persistedImage(
      runId,
      "webgpu-after",
      bytes,
      report.webgpu.terrain.after,
    ),
  };
  report.control.before.image = images.controlBefore;
  report.control.afterGap.image = images.controlAfterGap;
  report.control.continuity.renderComparable = true;
  report.control.continuity.nonVacuous = true;
  report.webgpu.before.image = images.webgpuBefore;
  report.webgpu.terrain.before.image = images.webgpuBefore;
  report.webgpu.terrain.after.image = images.webgpuAfter;
  report.webgpu.render.beforeImage = images.webgpuBefore;
  report.webgpu.render.afterImage = images.webgpuAfter;
  report.webgpu.render.meanAbsoluteDelta = 0;
  report.webgpu.render.changedPixelShare = 0;
  report.webgpu.render.comparable = true;
  report.webgpu.render.nonVacuous = true;
  attachRuntimeAttestation(report);
  const imageBytes = new Map(
    Object.values(images).map((entry) => [entry.pngFile, bytes]),
  );
  return { artifact: artifactFrom(report), imageBytes };
}

function rgbaImage(width, height, pixel) {
  const data = [];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) data.push(...pixel(x, y));
  }
  return { data, width, height };
}

test("passing fixture proves every bounded replacement-device claim", () => {
  assert.equal(
    C12_29_S5_REPLACEMENT_CONTRACT.schemas.captureTransaction,
    C12_29_S5_REPLACEMENT_CAPTURE_TRANSACTION_SCHEMA,
  );
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

test("versioned box-grid sampler pins axes, full coverage, averaging, and rounding", () => {
  assert.equal(
    C12_29_S5_REPLACEMENT_CONFIG.samplerSchema,
    C12_29_S5_REPLACEMENT_SAMPLER_SCHEMA,
  );

  const checkerboard = rgbaImage(4, 4, (x, y) => {
    const value = (x + y) % 2 === 0 ? 0 : 200;
    return [value, value, value, 255];
  });
  const checkerboardSample = sampleC1229S5ReplacementRgba(checkerboard, 2, 2);
  assert.deepEqual(
    checkerboardSample,
    Array.from({ length: 4 }, () => [100, 100, 100, 255]).flat(),
    "checkerboard must be box-averaged rather than nearest-neighbor sampled",
  );

  const nondivisible = rgbaImage(5, 3, (x, y) => [x + 10 * y, x, y, 255]);
  assert.deepEqual(
    sampleC1229S5ReplacementRgba(nondivisible, 2, 2),
    [1, 1, 0, 255, 3, 3, 0, 255, 16, 1, 2, 255, 18, 3, 2, 255],
    "non-divisible boxes must retain the trailing row and column",
  );

  const rectangular = rgbaImage(3, 2, (x, y) => [10 * y + x, x, y, 255]);
  assert.deepEqual(
    sampleC1229S5ReplacementRgba(rectangular, 3, 2),
    rectangular.data,
    "width/height axes may not be swapped",
  );
  assert.deepEqual(
    sampleC1229S5ReplacementRgba(
      rgbaImage(2, 1, (x) => (x === 0 ? [0, 0, 0, 0] : [1, 2, 3, 255])),
      1,
      1,
    ),
    [1, 1, 2, 128],
    "each channel uses Math.round after exact box accumulation",
  );
  assert.deepEqual(
    sampleC1229S5ReplacementRgba(
      { data: [7, 8, 9, 10], width: 1, height: 1 },
      1,
      1,
    ),
    [7, 8, 9, 10],
  );
  assert.throws(() =>
    sampleC1229S5ReplacementRgba(
      { data: [0, 0, 0, 255], width: 1, height: 1 },
      2,
      1,
    ),
  );

  const nearestNeighborMutant = [
    0, 0, 0, 255, 0, 0, 0, 255, 0, 0, 0, 255, 0, 0, 0, 255,
  ];
  assert.notDeepEqual(checkerboardSample, nearestNeighborMutant);
  const omittedTrailingEdgeMutant = [
    1, 1, 0, 255, 3, 3, 0, 255, 11, 1, 1, 255, 13, 3, 1, 255,
  ];
  assert.notDeepEqual(
    sampleC1229S5ReplacementRgba(nondivisible, 2, 2),
    omittedTrailingEdgeMutant,
  );
});

test("threshold derivations preserve the discrete v5 acceptance set", () => {
  const bars = C12_29_S5_REPLACEMENT_THRESHOLD_DERIVATION;
  assert.equal(bars.sampleCount, 256);
  assert.equal(bars.minimumNonBlackSamplePixels, 32);
  assert.equal(bars.controlMaximumMeanAbsoluteDelta, 4);
  assert.equal(bars.replacementMaximumMeanAbsoluteDelta, 12);
  assert.equal(bars.controlMaximumChangedSamples, 12);
  assert.equal(bars.controlMaximumChangedPixelShare, 12 / 256);
  assert.equal(bars.replacementMaximumChangedSamples, 51);
  assert.equal(bars.replacementMaximumChangedPixelShare, 51 / 256);
  assert.equal(12 / 256 <= 0.05, true);
  assert.equal(13 / 256 <= 0.05, false);
  assert.equal(51 / 256 <= 0.2, true);
  assert.equal(52 / 256 <= 0.2, false);
  assert.equal(
    bars.controlMaximumMeanAbsoluteDelta,
    bars.pairedSamplerRoundingMad + bars.controlRerasterizationMad,
  );
  assert.equal(
    bars.replacementMaximumMeanAbsoluteDelta,
    bars.controlMaximumMeanAbsoluteDelta +
      bars.replacementAdditionalRerasterizationMad,
  );
});

test("capture marker and executable digests are structural provenance", () => {
  const mutations = [
    (proof) => {
      proof.fused.beginMarkerCount = 2;
    },
    (proof) => {
      proof.fused.embeddedSha256 = SHA;
    },
    (proof) => {
      proof.fused.executedSha256 = SHA;
    },
    (proof) => {
      proof.sampler.endMarkerCount = 0;
    },
    (proof) => {
      proof.sampler.schema = "stale-sampler";
    },
    (proof) => {
      proof.sampler.executedSha256 = SHA;
    },
    (proof) => {
      proof.captureCalls = 2;
    },
    (proof) => {
      proof.helperInstalls = 2;
    },
    (proof) => {
      proof.samplerCalls = 2;
    },
    (proof) => {
      proof.sameOrigin = false;
    },
    (proof) => {
      proof.failureCount = 1;
    },
    (proof) => {
      proof.attestor.randomBindingNames = 0;
    },
    (proof) => {
      proof.attestor.eventSinkWrites = 2;
    },
    (proof) => {
      proof.attestor.bodyBindings = 0;
    },
    (proof) => {
      proof.attestor.runnerRestricted = false;
    },
  ];
  for (const mutate of mutations) {
    const report = passingReport();
    mutate(report.provenance.captureSourceProof);
    assert.equal(foldC1229S5ReplacementDeviceGate(report).status, "STRUCTURAL");
  }
});

test("derived policy and source-map closures reject omitted helper and product-byte mutants", () => {
  const actualFiles = C12_29_S5_REPLACEMENT_LOCAL_FILES.map((file) => {
    const bytes = fs.readFileSync(path.join(repositoryRoot, file));
    return {
      path: file,
      byteLength: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
  });
  const policy = collectC1229S5ReplacementPolicyBoundary(actualFiles);
  assert.equal(policy.closed, true);
  assert.deepEqual(policy.edges, C12_29_S5_REPLACEMENT_POLICY_EDGES);
  assert.equal(
    policy.files.some(
      (entry) =>
        entry.path === "Tools/visual-regression/lib/verdict-exit-gate.mjs",
    ),
    true,
  );

  const omittedHelper = Object.create(fs);
  omittedHelper.readFileSync = (file, ...args) => {
    const value = fs.readFileSync(file, ...args);
    if (
      path.resolve(String(file)) ===
      path.join(toolDirectory, "lib/c12-29-s5-replacement-device-gate.mjs")
    ) {
      return String(value).replace(
        '"./verdict-exit-gate.mjs"',
        '"node:crypto"',
      );
    }
    return value;
  };
  assert.equal(
    collectC1229S5ReplacementPolicyBoundary(actualFiles, omittedHelper).closed,
    false,
  );

  const boundary = collectC1229S5ReplacementSourceBoundary();
  // NOT a pin on the whole build's total module count (Q-81): that count
  // drifts with every unrelated engine landing — an executor run measured
  // 2202 against a build that had drifted to 2207 with nothing in this gate
  // touched, redding the gate on work it has no stake in. What the gate
  // actually needs is that its OWN named root files — a fixed, narrow set
  // this module exports — are all present and byte-exact in the current
  // build. That set's size changes only when this file's own export is
  // edited, never as a side effect of unrelated work elsewhere in the tree.
  assert.equal(
    C12_29_S5_REPLACEMENT_SOURCE_FILES.length,
    27,
    "the replacement-device root file list changed size — update this pin deliberately",
  );
  assert.equal(
    boundary.rootsPresent,
    true,
    "every named replacement-device root file must be embedded in the build source map",
  );
  assert.ok(
    boundary.sourceMapEntryCount >= C12_29_S5_REPLACEMENT_SOURCE_FILES.length,
    "the whole-build source map must contain at least the replacement-device root files",
  );
  assert.equal(boundary.allExact, true);
  const productPath = path.join(
    repositoryRoot,
    "packages/engine/Source/Renderer/WebGPU/WebGPUContextDeviceLoss.ts",
  );
  const productMutation = Object.create(fs);
  productMutation.readFileSync = (file, ...args) => {
    const value = fs.readFileSync(file, ...args);
    return path.resolve(String(file)) === productPath
      ? Buffer.concat([Buffer.from(value), Buffer.from("\n// mutant")])
      : value;
  };
  const mutatedBoundary =
    collectC1229S5ReplacementSourceBoundary(productMutation);
  assert.equal(mutatedBoundary.allExact, false);
  assert.equal(
    mutatedBoundary.missingPaths.includes(
      "packages/engine/Source/Renderer/WebGPU/WebGPUContextDeviceLoss.ts",
    ),
    true,
  );
});

/**
 * A minimal, internally-consistent v3 source map + matching `readFileSync`
 * stub, built entirely from `paths` — no real `Build/` output is read. This
 * exercises `collectC1229S5ReplacementSourceBoundary`'s real resolution and
 * root-presence logic (Q-81) through its documented `operations` injection
 * seam, independent of whatever the repository's actual build state is.
 *
 * ZERO POWER OVER THE NAMES THEMSELVES: the synthetic map is built FROM the
 * same `paths` the assertions below check against, so it is self-consistent
 * for any list of names — including a list of names that are wrong for the
 * REAL build (station-3 review, Q-81 pass 1: the lane initially "corrected"
 * `C12_29_S5_REPLACEMENT_SOURCE_FILES` to the raw `.glsl`/`.wgsl` shader
 * paths, which this test happily passed, while main's real build source map
 * only ever contains the build-generated, gitignored `.js` forms those
 * shaders compile to — `packages/engine/.gitignore:5`,
 * `lib/c12-29-s5-dense-cost-gate.mjs`'s `..._RAW_GENERATED_PAIRS`). This test
 * proves the RESOLUTION/PRESENCE LOGIC; it can never catch a wrong root
 * name — only a real build's source map (or a fixture independently derived
 * from one) can do that.
 */
function syntheticSourceBoundaryOperations(paths) {
  const sourceMapPath = path.join(
    repositoryRoot,
    "Build/CesiumUnminified/index.js.map",
  );
  const sources = paths.map((file) => `../../${file}`);
  const sourcesContent = paths.map((file) => `// synthetic body for ${file}`);
  const sourceMapBytes = Buffer.from(
    JSON.stringify({ version: 3, sourceRoot: "", sources, sourcesContent }),
  );
  const contentByResolvedPath = new Map(
    paths.map((file, index) => [
      path.join(repositoryRoot, file),
      Buffer.from(sourcesContent[index]),
    ]),
  );
  return {
    readFileSync(file) {
      const resolved = path.resolve(String(file));
      if (resolved === sourceMapPath) {
        return sourceMapBytes;
      }
      const content = contentByResolvedPath.get(resolved);
      if (content === undefined) {
        const error = new Error(`ENOENT (synthetic): ${resolved}`);
        error.code = "ENOENT";
        throw error;
      }
      return content;
    },
  };
}

test("Q-81: root-presence is keyed on the named set, not the whole-build total, and reds when a named module is dropped", () => {
  const allRootsBoundary = collectC1229S5ReplacementSourceBoundary(
    syntheticSourceBoundaryOperations([
      ...C12_29_S5_REPLACEMENT_SOURCE_FILES,
      // An unrelated extra "build" entry the whole-build total would count —
      // proves the fixed assertions key off the NAMED set, not the total.
      "packages/engine/Source/Core/defined.js",
    ]),
  );
  assert.equal(allRootsBoundary.rootsPresent, true);
  assert.equal(allRootsBoundary.allExact, true);
  assert.equal(
    allRootsBoundary.sourceMapEntryCount,
    C12_29_S5_REPLACEMENT_SOURCE_FILES.length + 1,
    "the synthetic whole-build total includes the one extra unrelated file",
  );

  const droppedRoot = C12_29_S5_REPLACEMENT_SOURCE_FILES[0];
  const missingRootBoundary = collectC1229S5ReplacementSourceBoundary(
    syntheticSourceBoundaryOperations(
      C12_29_S5_REPLACEMENT_SOURCE_FILES.filter((file) => file !== droppedRoot),
    ),
  );
  assert.equal(
    missingRootBoundary.rootsPresent,
    false,
    `dropping ${droppedRoot} from the build must be caught, not silently pass`,
  );
  assert.equal(missingRootBoundary.allExact, false);
});

test("both renderer lanes reject vacuous black grids and non-960 images", () => {
  const blacken = (target) => {
    target.sampleRgba.fill(0);
    for (let index = 3; index < target.sampleRgba.length; index += 4) {
      target.sampleRgba[index] = 255;
    }
    target.nonBlackPixels = 0;
    target.meanLuminance = 0;
    target.sampleSha256 = createHash("sha256")
      .update(JSON.stringify(target.sampleRgba))
      .digest("hex");
    target.transactionSha256 =
      deriveC1229S5ReplacementCaptureTransactionSha256(target);
  };
  const control = passingReport();
  blacken(control.control.before.image);
  blacken(control.control.afterGap.image);
  control.control.continuity.nonVacuous = false;
  attachRuntimeAttestation(control);
  assert.equal(foldC1229S5ReplacementDeviceGate(control).status, "FAIL");

  const webgpu = passingReport();
  blacken(webgpu.webgpu.terrain.before.image);
  blacken(webgpu.webgpu.terrain.after.image);
  webgpu.webgpu.before.image = webgpu.webgpu.terrain.before.image;
  webgpu.webgpu.render.beforeImage = webgpu.webgpu.terrain.before.image;
  webgpu.webgpu.render.afterImage = webgpu.webgpu.terrain.after.image;
  webgpu.webgpu.render.meanAbsoluteDelta = 0;
  webgpu.webgpu.render.changedPixelShare = 0;
  webgpu.webgpu.render.comparable = true;
  webgpu.webgpu.render.nonVacuous = false;
  attachRuntimeAttestation(webgpu);
  assert.equal(foldC1229S5ReplacementDeviceGate(webgpu).status, "FAIL");

  for (const [axis, value] of [
    ["width", 959],
    ["height", 961],
  ]) {
    const mutant = passingReport();
    mutant.control.before.image[axis] = value;
    assert.equal(foldC1229S5ReplacementDeviceGate(mutant).status, "STRUCTURAL");
  }
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
    "verdict policy helper omitted",
    (r) => {
      r.provenance.policyBoundary.files =
        r.provenance.policyBoundary.files.filter(
          (entry) =>
            entry.path !== "Tools/visual-regression/lib/verdict-exit-gate.mjs",
        );
    },
    "STRUCTURAL",
  ],
  [
    "verdict policy edge omitted",
    (r) => {
      r.provenance.policyBoundary.edges =
        r.provenance.policyBoundary.edges.filter(
          (edge) =>
            edge.to !== "Tools/visual-regression/lib/verdict-exit-gate.mjs",
        );
    },
    "STRUCTURAL",
  ],
  [
    "closed source-map current set drift",
    (r) => {
      r.provenance.sourceBoundaryEnd.currentSetSha256 = "c".repeat(64);
    },
    "STRUCTURAL",
  ],
  [
    "closed source-map product root omitted",
    (r) => {
      r.provenance.sourceBoundaryStart.roots.pop();
    },
    "STRUCTURAL",
  ],
  [
    "preflight digest drift",
    (r) => {
      r.provenance.preflightSha256 = "c".repeat(64);
    },
    "STRUCTURAL",
  ],
  [
    "browser response missing",
    (r) => {
      r.provenance.sessions[0].responses.pop();
    },
    "STRUCTURAL",
  ],
  [
    "browser response duplicated",
    (r) => {
      r.provenance.sessions[1].responses.push(
        clone(r.provenance.sessions[1].responses.at(-1)),
      );
    },
    "STRUCTURAL",
  ],
  [
    "browser response path splice",
    (r) => {
      r.provenance.sessions[0].responses[1].path =
        C12_29_S5_REPLACEMENT_SERVED_FILES[2];
    },
    "STRUCTURAL",
  ],
  [
    "browser response body drift",
    (r) => {
      r.provenance.sessions[1].responses[2].sha256 = "c".repeat(64);
    },
    "STRUCTURAL",
  ],
  [
    "browser contexts swapped",
    (r) => {
      r.provenance.sessions.reverse();
    },
    "STRUCTURAL",
  ],
  [
    "browser session identity reused",
    (r) => {
      r.provenance.sessions[1].sessionId = r.provenance.sessions[0].sessionId;
    },
    "STRUCTURAL",
  ],
  [
    "runtime renderer identity splice",
    (r) => {
      r.provenance.sessions[0].runtimeIdentity.renderer = "webgpu";
    },
    "STRUCTURAL",
  ],
  [
    "service-worker response substituted",
    (r) => {
      r.provenance.sessions[1].responses[0].fromServiceWorker = true;
    },
    "STRUCTURAL",
  ],
  [
    "actual browser identity absent",
    (r) => {
      r.provenance.browser.name = "";
    },
    "STRUCTURAL",
  ],
  [
    "device identity omitted",
    (r) => {
      delete r.webgpu.ledger.devices[0].identity;
    },
    "STRUCTURAL",
  ],
  [
    "device limit identity invalid",
    (r) => {
      r.webgpu.ledger.devices[1].identity.deviceLimits.maxBindGroups = 0;
    },
    "STRUCTURAL",
  ],
  [
    "capture nonce reused across phase images",
    (r) => {
      r.control.afterGap.image.captureNonce =
        r.control.before.image.captureNonce;
      r.control.afterGap.image.transactionSha256 =
        deriveC1229S5ReplacementCaptureTransactionSha256(
          r.control.afterGap.image,
        );
    },
    "STRUCTURAL",
  ],
  [
    "capture transaction seal spliced",
    (r) => {
      r.webgpu.terrain.after.image.transactionSha256 =
        r.webgpu.terrain.before.image.transactionSha256;
      r.webgpu.render.afterImage = r.webgpu.terrain.after.image;
    },
    "STRUCTURAL",
  ],
  [
    "capture frame seal does not match frame slots",
    (r) => {
      r.webgpu.before.image.frameSha256 = "c".repeat(64);
      r.webgpu.before.image.transactionSha256 =
        deriveC1229S5ReplacementCaptureTransactionSha256(r.webgpu.before.image);
      r.webgpu.terrain.before.image = r.webgpu.before.image;
      r.webgpu.render.beforeImage = r.webgpu.before.image;
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
    "STRUCTURAL",
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
    "replacement scene token diverges while identity claims survival",
    (r) => {
      divergeReplacementOwnerToken(r, "sceneToken");
    },
    "FAIL",
  ],
  [
    "replacement canvas token diverges while identity claims survival",
    (r) => {
      divergeReplacementOwnerToken(r, "canvasToken");
    },
    "FAIL",
  ],
  [
    "replacement device token is reused while identity claims freshness",
    reuseReplacementDevice,
    "FAIL",
  ],
  [
    "control owner tokens diverge across the no-loss gap",
    (r) => {
      divergeControlOwnerToken(r, "contextToken");
    },
    "FAIL",
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
  assert.equal(MUTANTS.length, 88);
  for (const [name, mutate, expected] of MUTANTS) {
    const report = passingReport();
    mutate(report);
    if (expected === "FAIL") attachRuntimeAttestation(report);
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
  const artifact = createC1229S5ReplacementErrorArtifact(
    RUN_ID,
    diagnostics,
    SHA,
  );
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
  const source = fs
    .readFileSync(
      path.join(toolDirectory, "probe-c12-29-s5-replacement-device.mjs"),
      "utf8",
    )
    .replace(/\r\n/g, "\n");
  assert.match(source, /--enable-gpu-benchmarking/u);
  assert.match(source, /terminateGpuProcessNormally/u);
  assert.match(source, /Reflect\.apply\(methodValue, benchmark, \[\]\)/u);
  assert.doesNotMatch(source, /GPUDevice\.prototype\s*\.\s*destroy/u);
  assert.doesNotMatch(source, /oldDevice\s*\.\s*destroy\s*\(/u);
  assert.doesNotMatch(source, /newDevice\s*\.\s*destroy\s*\(/u);
  assert.doesNotMatch(source, /\.crashGpuProcess(?:ForTesting)?\s*\(/u);
  assert.doesNotMatch(source, /--disable-gpu/u);
});

test("semantic capture substitutions are structurally ineligible while inverse controls remain eligible", () => {
  const source = fs
    .readFileSync(
      path.join(toolDirectory, "probe-c12-29-s5-replacement-device.mjs"),
      "utf8",
    )
    .replace(/\r\n/g, "\n");
  assert.deepEqual(replacementCaptureFailures(source), []);
  assert.equal(
    C12_29_S5_REPLACEMENT_LOCAL_FILES.filter(
      (file) => file === "Tools/visual-regression/lib/same-task-capture.mjs",
    ).length,
    1,
    "the canonical capture helper is not bound exactly once in provenance",
  );

  const replaceExact = (name, needle, replacement) => {
    const mutant = source.replace(needle, replacement);
    assert.notEqual(mutant, source, `${name} mutant was a no-op`);
    return mutant;
  };
  const snapshotRoute =
    "  const snapshot = (label) => attestedCapture.capture(label);";
  const mutants = [
    [
      "computed live-canvas monkeypatch",
      replaceExact(
        "computed live-canvas monkeypatch",
        snapshotRoute,
        `${snapshotRoute}\n  canvas["to" + "DataURL"] = () => forgedPng;`,
      ),
      /computed or critical member mutation/u,
    ],
    [
      "dead canonical snapshot call site",
      replaceExact(
        "dead canonical snapshot call site",
        'const before = await snapshot("control-before");',
        'const before = false ? await snapshot("control-before") : forgedBefore;',
      ),
      /four canonical phase snapshots/u,
    ],
    [
      "eval capture replacement",
      replaceExact(
        "eval capture replacement",
        snapshotRoute,
        `${snapshotRoute}\n  eval("attestedCapture.capture = forgedCapture");`,
      ),
      /dynamic code generation/u,
    ],
    [
      "reflective capture replacement",
      replaceExact(
        "reflective capture replacement",
        snapshotRoute,
        `${snapshotRoute}\n  Reflect.set(attestedCapture, "capture", forgedCapture);`,
      ),
      /reflection|critical member/u,
    ],
    [
      "second render with internally consistent but wrong frame lineage",
      replaceExact(
        "second render with internally consistent but wrong frame lineage",
        "      frameNumber: scene.frameState.frameNumber,",
        "      frameNumber: (scene.render(pinnedTime), scene.frameState.frameNumber),",
      ),
      /synchronous restricted slot read/u,
    ],
    [
      "Function constructor capture replacement",
      replaceExact(
        "Function constructor capture replacement",
        snapshotRoute,
        `${snapshotRoute}\n  Function("capture", "return capture")(forgedCapture);`,
      ),
      /dynamic code generation/u,
    ],
    [
      "computed global eval replacement",
      replaceExact(
        "computed global eval replacement",
        snapshotRoute,
        `${snapshotRoute}\n  globalThis["ev" + "al"]("attestedCapture = forgedCapture");`,
      ),
      /dynamic critical member access/u,
    ],
    [
      "Object.assign live-canvas replacement",
      replaceExact(
        "Object.assign live-canvas replacement",
        snapshotRoute,
        `${snapshotRoute}\n  Object.assign(canvas, { toDataURL: () => forgedPng });`,
      ),
      /Object reflection or aggregation/u,
    ],
    [
      "scene context identity replacement",
      replaceExact(
        "scene context identity replacement",
        snapshotRoute,
        `${snapshotRoute}\n  scene.context = forgedContext;`,
      ),
      /computed or critical member mutation/u,
    ],
    [
      "global property enumeration",
      replaceExact(
        "global property enumeration",
        snapshotRoute,
        `${snapshotRoute}\n  for (const key in globalThis) void key;`,
      ),
      /property enumeration/u,
    ],
    [
      "script element execution",
      replaceExact(
        "script element execution",
        'document.createElement("div")',
        'document.createElement("script")',
      ),
      /dynamic DOM execution/u,
    ],
    [
      "unbound runtime import",
      replaceExact(
        "unbound runtime import",
        "await import(contract.runtimePath)",
        "await import(globalThis.runtimePath)",
      ),
      /dynamic import|contract-bound runtime import/u,
    ],
    [
      "computed attested capture route",
      replaceExact(
        "computed attested capture route",
        snapshotRoute,
        '  const snapshot = (label) => attestedCapture["cap" + "ture"](label);',
      ),
      /snapshot route|dynamic critical member access/u,
    ],
    [
      "wrapper substituted capture factory",
      replaceExact(
        "wrapper substituted capture factory",
        "      captureFactory: makeFusedSnapshotCapture,",
        "      captureFactory: (...args) => makeFusedSnapshotCapture(...args),",
      ),
      /prepare one exact sealed runtime attestor/u,
    ],
    [
      "measurement page.evaluate decoy",
      replaceExact(
        "measurement page.evaluate decoy",
        "    measured = await Promise.race([",
        "    await page.evaluate(() => null);\n    measured = await Promise.race([",
      ),
      /sole measurement page\.evaluate route/u,
    ],
    [
      "runtime installer decoy",
      replaceExact(
        "runtime installer decoy",
        "  await page.addInitScript(installC1229S5ReplacementRuntimeAttestor, {",
        "  await page.addInitScript(() => installC1229S5ReplacementRuntimeAttestor, {",
      ),
      /one pre-page installer/u,
    ],
    [
      "fixed witness binding name",
      replaceExact(
        "fixed witness binding name",
        '  const witnessBindingName = `__c1229S5ReplacementWitness_${randomUUID().replaceAll("-", "")}`;',
        '  const witnessBindingName = "__c1229S5ReplacementWitness_fixed";',
      ),
      /one randomized binding/u,
    ],
    [
      "forged event sink",
      replaceExact(
        "forged event sink",
        "    attestationEvents.push(structuredClone(event));",
        "    attestationEvents.push(structuredClone({ ...event, frameNumber: 7 }));",
      ),
      /exact event sink/u,
    ],
    [
      "returned-body digest bypass",
      replaceExact(
        "returned-body digest bypass",
        "      finishEvent?.bodySha256 !== sha256(Buffer.from(JSON.stringify(measured)))",
        "      finishEvent?.bodySha256 !== finishEvent?.bodySha256",
      ),
      /returned-body digest/u,
    ],
    [
      "finish bypass",
      replaceExact(
        "finish bypass",
        "return await attestedCapture.finish({",
        "return await forgedFinish({",
      ),
      /every measurement return/u,
    ],
    [
      "fused marker decoy",
      replaceExact(
        "fused marker decoy",
        FUSED_SNAPSHOT_BEGIN,
        `${FUSED_SNAPSHOT_BEGIN}\n  ${FUSED_SNAPSHOT_BEGIN}`,
      ),
      /markers must each occur exactly once/u,
    ],
    [
      "sampler marker decoy",
      replaceExact(
        "sampler marker decoy",
        C12_29_S5_REPLACEMENT_SAMPLER_BEGIN,
        `${C12_29_S5_REPLACEMENT_SAMPLER_BEGIN}\n  ${C12_29_S5_REPLACEMENT_SAMPLER_BEGIN}`,
      ),
      /sampler markers must each occur exactly once/u,
    ],
    [
      "sampler end-marker decoy",
      replaceExact(
        "sampler end-marker decoy",
        C12_29_S5_REPLACEMENT_SAMPLER_END,
        `${C12_29_S5_REPLACEMENT_SAMPLER_END}\n  ${C12_29_S5_REPLACEMENT_SAMPLER_END}`,
      ),
      /sampler markers must each occur exactly once/u,
    ],
  ];

  const fusedStart = source.indexOf(FUSED_SNAPSHOT_BEGIN);
  const fusedFinish =
    source.indexOf(FUSED_SNAPSHOT_END, fusedStart) + FUSED_SNAPSHOT_END.length;
  const markedFused = source.slice(fusedStart, fusedFinish);
  const executableFused = markedFused
    .replace(`${FUSED_SNAPSHOT_BEGIN}\n`, "")
    .replace(`\n  ${FUSED_SNAPSHOT_END}`, "")
    .replace("fused PNG decode failed", "drifted executable decode");
  mutants.push([
    "dead canonical marker block beside drifted executable helper",
    `${source.slice(0, fusedStart)}/*\n  ${markedFused}\n  */\n${executableFused}${source.slice(fusedFinish)}`,
    /executed fused snapshot declaration/u,
  ]);

  for (const [name, mutant, expected] of mutants) {
    const failures = replacementCaptureFailures(mutant).join("\n");
    assert.notEqual(failures, "", `${name} unexpectedly passed`);
    assert.match(failures, expected, `${name}: ${failures}`);
    const analysis = analyzeC1229S5ReplacementCaptureSource(mutant);
    const report = passingReport();
    report.provenance.captureSourceProof = analysis.proof;
    assert.equal(
      foldC1229S5ReplacementDeviceGate(report).status,
      "STRUCTURAL",
      `${name} must be structurally ineligible`,
    );
  }

  const commentOnlyInverse = source.replace(
    snapshotRoute,
    `${snapshotRoute}\n  // eval and Reflect.set are documentary text only.`,
  );
  assert.deepEqual(replacementCaptureFailures(commentOnlyInverse), []);
  const numericInverse = replaceExact(
    "unrelated numeric spelling inverse",
    "      timeout: 90_000,",
    "      timeout: 90000,",
  );
  assert.deepEqual(replacementCaptureFailures(numericInverse), []);
});

test("out-of-band runtime attestor witnesses one origin and rejects live substitution or a second render", () => {
  const captureModule = new URL(
    "./lib/c12-29-s5-replacement-device-capture.mjs",
    import.meta.url,
  ).href;
  const runScenario = (mode) => {
    const script = `
      import { webcrypto } from "node:crypto";
      import { installC1229S5ReplacementRuntimeAttestor as install } from ${JSON.stringify(captureModule)};
      if (!globalThis.crypto) {
        Object.defineProperty(globalThis, "crypto", { value: webcrypto });
      }
      const mode = ${JSON.stringify(mode)};
      const outcome = await (async () => {
        const events = [];
        globalThis.__testWitness = async (event) => events.push(event);
        install({
          bindingName: "__testWitness",
          schema: ${JSON.stringify(C12_29_S5_REPLACEMENT_RUNTIME_ATTESTATION_SCHEMA)},
          sessionId: ${JSON.stringify(SESSION_IDS.webgpu)},
          renderer: "webgpu",
        });
        const originalToDataURL = () => "data:image/png;base64,AA==";
        const canvas = { toDataURL: originalToDataURL };
        const scene = {
          context: {
            _adapter: {},
            _device: {},
            resourceGeneration: 0,
          },
          frameState: { frameNumber: 0 },
          canvas,
          render() {
            this.frameState.frameNumber++;
          },
        };
        async function measurement() {}
        function captureFactory(targetScene, targetCanvas, timeFn) {
          return {
            async captureSnapshot() {
              targetScene.render(timeFn());
              const dataUrl = targetCanvas.toDataURL("image/png");
              return {
                dataUrl,
                imageData: { width: 1, height: 1, data: [12, 34, 56, 255] },
              };
            },
          };
        }
        function sampler(imageData) {
          return [...imageData.data];
        }
        function frameReader() {
          if (mode === "second-render") scene.render(0);
          return {
            frameNumber: scene.frameState.frameNumber,
            selectionRevision: 1,
            surfaceRadius: 1,
            selectedTileIds: ["tile"],
            providerToken: "provider",
            s5: { prepared: true, revision: 1, gate: 1, payload: [1, 2, 3, 4] },
          };
        }
        const sourceSha256 = async (value) =>
          Array.from(
            new Uint8Array(
              await crypto.subtle.digest(
                "SHA-256",
                new TextEncoder().encode(Function.prototype.toString.call(value)),
              ),
            ),
            (byte) => byte.toString(16).padStart(2, "0"),
          ).join("");
        const expected = {
          installerSha256: ${JSON.stringify(C12_29_S5_REPLACEMENT_RUNTIME_ATTESTOR_SOURCE_SHA256)},
          measurementSha256: await sourceSha256(measurement),
          captureFactorySha256: await sourceSha256(captureFactory),
          samplerSha256: await sourceSha256(sampler),
          frameReaderSha256: await sourceSha256(frameReader),
          captureTransactionSchema: ${JSON.stringify(C12_29_S5_REPLACEMENT_CAPTURE_TRANSACTION_SCHEMA)},
          samplerSchema: ${JSON.stringify(C12_29_S5_REPLACEMENT_SAMPLER_SCHEMA)},
          sampleWidth: 1,
          sampleHeight: 1,
        };
        try {
          const attested =
            await globalThis.__c1229S5ReplacementRuntimeAttestor.prepare({
              measurement,
              captureFactory,
              sampler,
              frameReader,
              scene,
              canvas,
              timeFn: () => 0,
              expected,
            });
          if (mode === "monkeypatch") {
            canvas.toDataURL = () => "data:image/png;base64,AQ==";
          }
          if (mode === "context-swap") {
            scene.context = {
              _adapter: {},
              _device: {},
              resourceGeneration: 0,
            };
          }
          const capture = await attested.capture("webgpu-before");
          const body = await attested.finish({ capture });
          return JSON.parse(JSON.stringify({ events, body }));
        } catch (error) {
          return JSON.parse(JSON.stringify({ events, error: error.message }));
        }
      })();
      console.log(JSON.stringify(outcome));`;
    const child = spawnSync(
      process.execPath,
      ["--input-type=module", "--eval", script],
      {
        cwd: repositoryRoot,
        encoding: "utf8",
        timeout: 30_000,
      },
    );
    assert.equal(child.status, 0, child.stderr || child.stdout);
    return JSON.parse(child.stdout);
  };

  const valid = runScenario("valid");
  assert.equal(valid.error, undefined);
  assert.deepEqual(
    valid.events.map((event) => event.kind),
    ["begin", "capture", "finish"],
  );
  assert.equal(valid.events[1].renderCalls, 1);
  assert.equal(valid.events[1].freezeCalls, 1);
  assert.equal(valid.events[1].frameNumber, valid.body.capture.frameNumber);
  assert.equal(
    valid.events[1].pngSha256,
    valid.body.capture.image.capturePngSha256,
  );
  assert.equal(
    valid.events[1].sampleSha256,
    valid.body.capture.image.sampleSha256,
  );

  const monkeypatch = runScenario("monkeypatch");
  assert.deepEqual(
    monkeypatch.events.map((event) => event.kind),
    ["begin"],
  );
  assert.match(monkeypatch.error, /render\/freeze lineage changed/u);

  const secondRender = runScenario("second-render");
  assert.deepEqual(
    secondRender.events.map((event) => event.kind),
    ["begin"],
  );
  assert.match(
    secondRender.error,
    /one synchronous render\/freeze\/frame origin/u,
  );

  const contextSwap = runScenario("context-swap");
  assert.deepEqual(
    contextSwap.events.map((event) => event.kind),
    ["begin"],
  );
  assert.match(contextSwap.error, /scene\/context\/canvas lineage changed/u);
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
    const ownership = beginC1229S5ReplacementEvidenceRun(
      paths,
      RUN_ID,
      preflightProvenance(),
    );
    const { artifact, imageBytes } = persistableArtifact();
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
      imageBytes,
    );
    assert.equal(publication.sha256.length, 64);
    assert.equal(publication.images.length, 4);
    for (const image of publication.images) {
      assert.equal(fs.existsSync(image.path), true);
      assert.equal(
        inspectC1229S5ReplacementPng(fs.readFileSync(image.path)).ok,
        true,
      );
    }
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
    const finalizedLatest = fs.readFileSync(paths.latest);
    assert.throws(
      () =>
        beginC1229S5ReplacementEvidenceRun(
          paths,
          RUN_ID,
          preflightProvenance(),
        ),
      /already finalized/u,
    );
    assert.deepEqual(fs.readFileSync(paths.latest), finalizedLatest);
    assert.throws(() =>
      fs.writeFileSync(paths.archive, "replace", { flag: "wx" }),
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("invalid preflight cannot create or replace canonical authority", () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "c1229-s5-replacement-preflight-"),
  );
  try {
    const paths = createC1229S5ReplacementArtifactPaths(RUN_ID, directory);
    const prior = Buffer.from('{"prior":"authority"}\n');
    fs.writeFileSync(paths.latest, prior, { flag: "wx" });
    const invalid = preflightProvenance();
    invalid.policyBoundary.files = invalid.policyBoundary.files.filter(
      (entry) =>
        entry.path !== "Tools/visual-regression/lib/verdict-exit-gate.mjs",
    );
    invalid.preflightSha256 = deriveC1229S5ReplacementPreflightSha256(invalid);
    assert.throws(
      () => beginC1229S5ReplacementEvidenceRun(paths, RUN_ID, invalid),
      /preflight provenance is invalid/u,
    );
    assert.deepEqual(fs.readFileSync(paths.latest), prior);
    assert.equal(fs.existsSync(paths.running), false);
    assert.equal(fs.existsSync(paths.lock), false);
    assert.equal(fs.existsSync(paths.finalizing), false);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("every begin transition is crash-idempotent before it returns ownership", () => {
  const cases = [
    ["directory preparation", "mkdirSync", (paths) => paths.directory],
    ["begin transition write", "writeFileSync", (paths) => paths.finalizing],
    ["canonical RUNNING write", "writeFileSync", (paths) => paths.latest],
    ["begin transition release", "unlinkSync", (paths) => paths.finalizing],
    ["lock write", "writeFileSync", (paths) => paths.lock],
    ["RUNNING sidecar write", "writeFileSync", (paths) => paths.running],
  ];
  for (const [label, method, target] of cases) {
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), "c1229-s5-replacement-begin-transition-"),
    );
    try {
      const paths = createC1229S5ReplacementArtifactPaths(RUN_ID, directory);
      const operations = Object.create(fs);
      let injected = false;
      operations[method] = (...args) => {
        const result = fs[method](...args);
        if (!injected && path.resolve(String(args[0])) === target(paths)) {
          injected = true;
          throw new Error(`injected ${label} crash`);
        }
        return result;
      };
      assert.throws(
        () =>
          beginC1229S5ReplacementEvidenceRun(
            paths,
            RUN_ID,
            preflightProvenance(),
            operations,
          ),
        new RegExp(`injected ${label}`, "u"),
      );
      assert.equal(injected, true, label);
      const ownership = beginC1229S5ReplacementEvidenceRun(
        paths,
        RUN_ID,
        preflightProvenance(),
      );
      assert.deepEqual(fs.readFileSync(paths.latest), ownership.runningBytes);
      assert.deepEqual(fs.readFileSync(paths.running), ownership.runningBytes);
      assert.deepEqual(fs.readFileSync(paths.lock), ownership.lockBytes);
      assert.equal(fs.existsSync(paths.finalizing), false);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  }
});

test("prior-latest claim and release are crash-idempotent and foreign receipts are preserved", () => {
  for (const [label, method] of [
    ["prior latest claim", "renameSync"],
    ["prior latest receipt release", "unlinkSync"],
  ]) {
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), "c1229-s5-replacement-prior-transition-"),
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
        preflightProvenance(),
      );
      const { artifact, imageBytes } = persistableArtifact(firstRun);
      finalizeC1229S5ReplacementEvidence(
        firstPaths,
        artifact,
        firstOwnership,
        imageBytes,
      );
      const paths = createC1229S5ReplacementArtifactPaths(RUN_ID, directory);
      const target =
        method === "renameSync" ? paths.latest : paths.receipts.priorLatest;
      const operations = Object.create(fs);
      let injected = false;
      operations[method] = (...args) => {
        const result = fs[method](...args);
        if (!injected && path.resolve(String(args[0])) === target) {
          injected = true;
          throw new Error(`injected ${label} crash`);
        }
        return result;
      };
      assert.throws(
        () =>
          beginC1229S5ReplacementEvidenceRun(
            paths,
            RUN_ID,
            preflightProvenance(),
            operations,
          ),
        new RegExp(`injected ${label}`, "u"),
      );
      assert.equal(injected, true, label);
      const ownership = beginC1229S5ReplacementEvidenceRun(
        paths,
        RUN_ID,
        preflightProvenance(),
      );
      assert.deepEqual(fs.readFileSync(paths.latest), ownership.runningBytes);
      assert.equal(fs.existsSync(paths.receipts.priorLatest), false);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  }

  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "c1229-s5-replacement-foreign-receipt-"),
  );
  try {
    const paths = createC1229S5ReplacementArtifactPaths(RUN_ID, directory);
    const ownership = beginC1229S5ReplacementEvidenceRun(
      paths,
      RUN_ID,
      preflightProvenance(),
    );
    const foreign = Buffer.from('{"foreign":"receipt"}\n');
    fs.writeFileSync(paths.receipts.priorLatest, foreign, { flag: "wx" });
    assert.throws(
      () =>
        beginC1229S5ReplacementEvidenceRun(
          paths,
          RUN_ID,
          preflightProvenance(),
        ),
      /prior latest receipt exists without its owned begin transition/u,
    );
    assert.deepEqual(fs.readFileSync(paths.receipts.priorLatest), foreign);
    assert.deepEqual(fs.readFileSync(paths.latest), ownership.runningBytes);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("publication rejects coordinated sample metadata or PNG-byte lineage mutations", () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "c1229-s5-replacement-png-lineage-"),
  );
  try {
    const paths = createC1229S5ReplacementArtifactPaths(RUN_ID, directory);
    const ownership = beginC1229S5ReplacementEvidenceRun(
      paths,
      RUN_ID,
      preflightProvenance(),
    );
    const { artifact, imageBytes } = persistableArtifact();
    const report = clone(artifact);
    delete report.status;
    delete report.exitCode;
    delete report.reasons;
    delete report.checks;
    const sample = report.control.before.image.sampleRgba;
    sample.fill(0);
    for (let index = 3; index < sample.length; index += 4) sample[index] = 255;
    report.control.before.image.nonBlackPixels = 0;
    report.control.before.image.meanLuminance = 0;
    report.control.before.image.transactionSha256 =
      deriveC1229S5ReplacementCaptureTransactionSha256(
        report.control.before.image,
      );
    report.control.continuity.renderComparable = false;
    report.control.continuity.nonVacuous = false;
    const coordinated = artifactFrom(report);
    assert.equal(
      validateC1229S5ReplacementFinalArtifact(coordinated).ok,
      true,
      "coordinated JSON mutation must reach the byte-lineage check",
    );
    assert.throws(
      () =>
        finalizeC1229S5ReplacementEvidence(
          paths,
          coordinated,
          ownership,
          imageBytes,
        ),
      /metadata does not rederive from its persisted PNG bytes/u,
    );
    assert.equal(fs.existsSync(paths.images.controlBefore), false);

    const changedBytes = new Map(imageBytes);
    changedBytes.set(`${RUN_ID}.control-before.png`, solidPng(10, 20, 30));
    assert.throws(
      () =>
        finalizeC1229S5ReplacementEvidence(
          paths,
          artifact,
          ownership,
          changedBytes,
        ),
      /metadata does not rederive from its persisted PNG bytes/u,
    );
    assert.equal(fs.existsSync(paths.images.controlBefore), false);

    finalizeC1229S5ReplacementEvidence(paths, artifact, ownership, imageBytes);
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
    const ownership = beginC1229S5ReplacementEvidenceRun(
      paths,
      RUN_ID,
      preflightProvenance(),
    );
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
    assert.deepEqual(fs.readFileSync(paths.latest), ownership.runningBytes);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("every publication transition is crash-idempotent and never exposes final latest beside RUNNING authority", () => {
  const cases = [
    ["candidate receipt write", "writeFileSync", (paths) => paths.candidate],
    ["first PNG write", "writeFileSync", (paths) => paths.images.controlBefore],
    ["archive write", "writeFileSync", (paths) => paths.archive],
    [
      "finalizing transition write",
      "writeFileSync",
      (paths) => paths.finalizing,
    ],
    ["RUNNING claim", "renameSync", (paths) => paths.running],
    [
      "RUNNING receipt release",
      "unlinkSync",
      (paths) => paths.receipts.runningRelease,
    ],
    ["lock claim", "renameSync", (paths) => paths.lock],
    [
      "lock receipt release",
      "unlinkSync",
      (paths) => paths.receipts.lockRelease,
    ],
    ["canonical RUNNING claim", "renameSync", (paths) => paths.latest],
    ["final latest write", "writeFileSync", (paths) => paths.latest],
    [
      "canonical receipt release",
      "unlinkSync",
      (paths) => paths.receipts.latestRelease,
    ],
    ["finalizing receipt release", "unlinkSync", (paths) => paths.finalizing],
    ["candidate receipt release", "unlinkSync", (paths) => paths.candidate],
  ];
  for (const [label, method, target] of cases) {
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), "c1229-s5-replacement-transition-"),
    );
    try {
      const paths = createC1229S5ReplacementArtifactPaths(RUN_ID, directory);
      const ownership = beginC1229S5ReplacementEvidenceRun(
        paths,
        RUN_ID,
        preflightProvenance(),
      );
      assert.deepEqual(fs.readFileSync(paths.latest), ownership.runningBytes);
      const { artifact, imageBytes } = persistableArtifact();
      const operations = Object.create(fs);
      let injected = false;
      operations[method] = (...args) => {
        const result = fs[method](...args);
        if (!injected && path.resolve(String(args[0])) === target(paths)) {
          injected = true;
          throw new Error(`injected ${label} crash`);
        }
        return result;
      };
      assert.throws(
        () =>
          finalizeC1229S5ReplacementEvidence(
            paths,
            artifact,
            ownership,
            imageBytes,
            operations,
          ),
        new RegExp(`injected ${label}`, "u"),
      );
      assert.equal(injected, true, `${label} boundary was not exercised`);
      const latest = fs.existsSync(paths.latest)
        ? JSON.parse(fs.readFileSync(paths.latest, "utf8"))
        : null;
      if (latest?.status !== "RUNNING") {
        assert.equal(fs.existsSync(paths.running), false, label);
        assert.equal(fs.existsSync(paths.lock), false, label);
      }
      const publication = finalizeC1229S5ReplacementEvidence(
        paths,
        artifact,
        ownership,
        imageBytes,
      );
      assert.equal(publication.sha256.length, 64, label);
      assert.equal(
        JSON.parse(fs.readFileSync(paths.latest, "utf8")).status,
        "PASS",
        label,
      );
      assert.equal(fs.existsSync(paths.running), false, label);
      assert.equal(fs.existsSync(paths.lock), false, label);
      assert.equal(fs.existsSync(paths.finalizing), false, label);
      assert.equal(fs.existsSync(paths.candidate), false, label);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  }
});

test("post-archive crash resumes only the exact immutable candidate and preserves conflicts", () => {
  const crashAfterArchive = (paths) => {
    const operations = Object.create(fs);
    let injected = false;
    operations.writeFileSync = (...args) => {
      const result = fs.writeFileSync(...args);
      if (!injected && path.resolve(String(args[0])) === paths.archive) {
        injected = true;
        throw new Error("injected post-archive crash");
      }
      return result;
    };
    return { operations, wasInjected: () => injected };
  };

  const exactDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), "c1229-s5-replacement-candidate-resume-"),
  );
  try {
    const paths = createC1229S5ReplacementArtifactPaths(RUN_ID, exactDirectory);
    const ownership = beginC1229S5ReplacementEvidenceRun(
      paths,
      RUN_ID,
      preflightProvenance(),
    );
    const { artifact, imageBytes } = persistableArtifact();
    const fault = crashAfterArchive(paths);
    assert.throws(
      () =>
        finalizeC1229S5ReplacementEvidence(
          paths,
          artifact,
          ownership,
          imageBytes,
          fault.operations,
        ),
      /injected post-archive crash/u,
    );
    assert.equal(fault.wasInjected(), true);
    assert.equal(fs.existsSync(paths.candidate), true);
    assert.equal(fs.existsSync(paths.archive), true);
    assert.equal(fs.existsSync(paths.running), true);
    assert.equal(fs.existsSync(paths.lock), true);
    assert.equal(
      JSON.parse(fs.readFileSync(paths.latest, "utf8")).status,
      "RUNNING",
      "an immutable archive is not final authority while cleanup is incomplete",
    );

    const resumedOwnership = beginC1229S5ReplacementEvidenceRun(
      paths,
      RUN_ID,
      preflightProvenance(),
    );
    assert.equal(resumedOwnership.resumeCandidate, true);
    const resumed = resumeC1229S5ReplacementEvidenceCandidate(
      paths,
      resumedOwnership,
    );
    assert.equal(resumed.artifact.status, "PASS");
    assert.equal(
      JSON.parse(fs.readFileSync(paths.latest, "utf8")).status,
      "PASS",
    );
    assert.equal(fs.existsSync(paths.candidate), false);
    assert.equal(fs.existsSync(paths.running), false);
    assert.equal(fs.existsSync(paths.lock), false);
    assert.equal(fs.existsSync(paths.finalizing), false);
  } finally {
    fs.rmSync(exactDirectory, { recursive: true, force: true });
  }

  const conflictDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), "c1229-s5-replacement-candidate-conflict-"),
  );
  try {
    const paths = createC1229S5ReplacementArtifactPaths(
      RUN_ID,
      conflictDirectory,
    );
    const ownership = beginC1229S5ReplacementEvidenceRun(
      paths,
      RUN_ID,
      preflightProvenance(),
    );
    const { artifact, imageBytes } = persistableArtifact();
    const fault = crashAfterArchive(paths);
    assert.throws(
      () =>
        finalizeC1229S5ReplacementEvidence(
          paths,
          artifact,
          ownership,
          imageBytes,
          fault.operations,
        ),
      /injected post-archive crash/u,
    );
    const preserved = new Map(
      [
        paths.candidate,
        paths.archive,
        paths.latest,
        paths.running,
        paths.lock,
      ].map((file) => [file, fs.readFileSync(file)]),
    );
    const conflictingArtifact = createC1229S5ReplacementErrorArtifact(
      RUN_ID,
      createC1229S5ReplacementErrorDiagnostics({
        message: "conflicting same-run final bytes",
      }),
      ownership.preflightSha256,
    );
    assert.throws(
      () =>
        finalizeC1229S5ReplacementEvidence(
          paths,
          conflictingArtifact,
          ownership,
        ),
      /publication candidate bytes differ/u,
    );
    for (const [file, bytes] of preserved) {
      assert.deepEqual(fs.readFileSync(file), bytes, file);
    }
    assert.equal(
      JSON.parse(fs.readFileSync(paths.latest, "utf8")).status,
      "RUNNING",
    );
    const resumed = resumeC1229S5ReplacementEvidenceCandidate(paths, ownership);
    assert.equal(resumed.artifact.status, "PASS");
  } finally {
    fs.rmSync(conflictDirectory, { recursive: true, force: true });
  }

  const foreignDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), "c1229-s5-replacement-candidate-foreign-"),
  );
  try {
    const paths = createC1229S5ReplacementArtifactPaths(
      RUN_ID,
      foreignDirectory,
    );
    const ownership = beginC1229S5ReplacementEvidenceRun(
      paths,
      RUN_ID,
      preflightProvenance(),
    );
    const foreign = Buffer.from('{"foreign":"candidate-owner"}\n');
    fs.writeFileSync(paths.candidate, foreign, { flag: "wx" });
    const { artifact, imageBytes } = persistableArtifact();
    assert.throws(
      () =>
        finalizeC1229S5ReplacementEvidence(
          paths,
          artifact,
          ownership,
          imageBytes,
        ),
      /publication candidate bytes differ/u,
    );
    assert.deepEqual(fs.readFileSync(paths.candidate), foreign);
    assert.equal(
      JSON.parse(fs.readFileSync(paths.latest, "utf8")).status,
      "RUNNING",
    );
    assert.equal(fs.existsSync(paths.archive), false);
  } finally {
    fs.rmSync(foreignDirectory, { recursive: true, force: true });
  }
});

test("an orphan archive without its candidate is never treated as complete", () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "c1229-s5-replacement-orphan-archive-"),
  );
  try {
    const paths = createC1229S5ReplacementArtifactPaths(RUN_ID, directory);
    const ownership = beginC1229S5ReplacementEvidenceRun(
      paths,
      RUN_ID,
      preflightProvenance(),
    );
    const { artifact, imageBytes } = persistableArtifact();
    const operations = Object.create(fs);
    let injected = false;
    operations.writeFileSync = (...args) => {
      const result = fs.writeFileSync(...args);
      if (!injected && path.resolve(String(args[0])) === paths.archive) {
        injected = true;
        throw new Error("injected orphan setup crash");
      }
      return result;
    };
    assert.throws(
      () =>
        finalizeC1229S5ReplacementEvidence(
          paths,
          artifact,
          ownership,
          imageBytes,
          operations,
        ),
      /injected orphan setup crash/u,
    );
    fs.rmSync(paths.candidate);
    assert.throws(
      () =>
        beginC1229S5ReplacementEvidenceRun(
          paths,
          RUN_ID,
          preflightProvenance(),
        ),
      /orphan immutable archive/u,
    );
    assert.equal(
      JSON.parse(fs.readFileSync(paths.latest, "utf8")).status,
      "RUNNING",
    );
    assert.equal(fs.existsSync(paths.running), true);
    assert.equal(fs.existsSync(paths.lock), true);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("foreign latest swapped after authority release is preserved and blocks final CAS and retry", () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "c1229-s5-replacement-foreign-latest-"),
  );
  try {
    const paths = createC1229S5ReplacementArtifactPaths(RUN_ID, directory);
    const ownership = beginC1229S5ReplacementEvidenceRun(
      paths,
      RUN_ID,
      preflightProvenance(),
    );
    const { artifact, imageBytes } = persistableArtifact();
    const foreign = Buffer.from('{"foreign":"owner"}\n');
    const operations = Object.create(fs);
    let injected = false;
    operations.writeFileSync = (file, bytes, options) => {
      if (
        !injected &&
        path.resolve(String(file)) === paths.latest &&
        options?.flag === "wx"
      ) {
        injected = true;
        fs.writeFileSync(file, foreign, { flag: "wx" });
      }
      return fs.writeFileSync(file, bytes, options);
    };
    assert.throws(
      () =>
        finalizeC1229S5ReplacementEvidence(
          paths,
          artifact,
          ownership,
          imageBytes,
          operations,
        ),
      /canonical final authority bytes differ/u,
    );
    assert.equal(injected, true);
    assert.deepEqual(fs.readFileSync(paths.latest), foreign);
    assert.equal(fs.existsSync(paths.running), false);
    assert.equal(fs.existsSync(paths.lock), false);
    assert.throws(
      () =>
        finalizeC1229S5ReplacementEvidence(
          paths,
          artifact,
          ownership,
          imageBytes,
        ),
      /canonical latest belongs to a foreign owner/u,
    );
    assert.deepEqual(fs.readFileSync(paths.latest), foreign);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("a prior latest must be canonical and backed by its exact immutable archive and PNGs", () => {
  for (const corrupt of ["latest-format", "missing-archive", "missing-png"]) {
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
        preflightProvenance(),
      );
      const { artifact: firstArtifact, imageBytes } =
        persistableArtifact(firstRun);
      finalizeC1229S5ReplacementEvidence(
        firstPaths,
        firstArtifact,
        ownership,
        imageBytes,
      );
      if (corrupt === "latest-format") {
        fs.appendFileSync(firstPaths.latest, "\n");
      } else if (corrupt === "missing-archive") {
        fs.rmSync(firstPaths.archive);
      } else {
        fs.rmSync(firstPaths.images.controlBefore);
      }
      const nextPaths = createC1229S5ReplacementArtifactPaths(
        RUN_ID,
        directory,
      );
      assert.throws(
        () =>
          beginC1229S5ReplacementEvidenceRun(
            nextPaths,
            RUN_ID,
            preflightProvenance(),
          ),
        corrupt === "latest-format"
          ? /prior latest is not canonical/u
          : corrupt === "missing-archive"
            ? /prior latest immutable replacement-device archive bytes differ/u
            : /prior latest control-before immutable PNG is absent/u,
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
      preflightProvenance(),
    );
    const diagnostics = createC1229S5ReplacementErrorDiagnostics({
      message: "expected setup red",
    });
    const errorArtifact = createC1229S5ReplacementErrorArtifact(
      firstRun,
      diagnostics,
      firstOwnership.preflightSha256,
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
      preflightProvenance(),
    );
    const { artifact: passArtifact, imageBytes } = persistableArtifact();
    finalizeC1229S5ReplacementEvidence(
      secondPaths,
      passArtifact,
      secondOwnership,
      imageBytes,
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

test("schema identifiers are pinned string literals - a silent version bump is a red", () => {
  assert.equal(
    C12_29_S5_REPLACEMENT_SCHEMA,
    "c12-29-s5-replacement-device-evidence-v8",
  );
  assert.equal(
    C12_29_S5_REPLACEMENT_NATIVE_LEDGER_SCHEMA,
    "c12-29-s5-replacement-device-native-resource-ledger-v8",
  );
  assert.equal(
    C12_29_S5_REPLACEMENT_PAGE_PROGRESS_SCHEMA,
    "c12-29-s5-replacement-device-page-progress-v8",
  );
  assert.equal(
    C12_29_S5_REPLACEMENT_RUNTIME_DIAGNOSTICS_SCHEMA,
    "c12-29-s5-replacement-device-runtime-diagnostics-v8",
  );
  assert.equal(
    C12_29_S5_REPLACEMENT_PROVENANCE_SCHEMA,
    "c12-29-s5-replacement-device-provenance-v8",
  );
  assert.equal(
    C12_29_S5_REPLACEMENT_POLICY_BOUNDARY_SCHEMA,
    "c12-29-s5-replacement-device-policy-boundary-v1",
  );
  assert.equal(
    C12_29_S5_REPLACEMENT_SOURCE_BOUNDARY_SCHEMA,
    "c12-29-s5-replacement-device-source-map-boundary-v1",
  );
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

const GATE_MODULE_PATH = path.join(
  toolDirectory,
  "lib/c12-29-s5-replacement-device-gate.mjs",
);
const NEWLINE_CHARACTERS = /[\r\n]/u;

// Source mutants are applied one line at a time and every substitution asserts
// its own occurrence count: the checkout is CRLF, so a pattern carrying a
// literal newline would match nothing and report a false green.
function foldWithMutatedGate(substitutions, report) {
  const source = fs.readFileSync(GATE_MODULE_PATH, "utf8");
  let mutated = source;
  for (const [from, to] of substitutions) {
    assert.equal(NEWLINE_CHARACTERS.test(from), false, from);
    assert.equal(mutated.split(from).length - 1, 1, `mutant anchor: ${from}`);
    mutated = mutated.replace(from, to);
  }
  assert.notEqual(mutated, source);
  const libUrl = new URL("./lib/", import.meta.url).href;
  mutated = mutated.replaceAll('from "./', `from "${libUrl}`);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "c12-29-s5-mutant-"));
  try {
    const modulePath = path.join(directory, "mutant-gate.mjs");
    const reportPath = path.join(directory, "report.json");
    fs.writeFileSync(modulePath, mutated);
    fs.writeFileSync(reportPath, stableC1229S5ReplacementJson(report));
    const script = `
      import fs from "node:fs";
      import { foldC1229S5ReplacementDeviceGate as fold } from ${JSON.stringify(pathToFileURL(modulePath).href)};
      const report = JSON.parse(fs.readFileSync(${JSON.stringify(reportPath)}, "utf8"));
      const verdict = fold(report);
      console.log(
        JSON.stringify({
          status: verdict.status,
          structuralReasons: verdict.structuralReasons,
          failureReasons: verdict.failureReasons,
        }),
      );`;
    const child = spawnSync(
      process.execPath,
      ["--input-type=module", "--eval", script],
      { cwd: repositoryRoot, encoding: "utf8", timeout: 60_000 },
    );
    assert.equal(child.status, 0, child.stderr || child.stdout);
    return JSON.parse(child.stdout);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

test("an ownership-survival break is a product FAIL, never harness blindness", () => {
  const verdict = foldC1229S5ReplacementDeviceGate(ownershipBreakReport());
  assert.deepEqual(verdict.structuralReasons, []);
  assert.equal(verdict.status, "FAIL", verdict.failureReasons.join("; "));
  assert.equal(verdict.exitCode, 1);
  assert.notEqual(verdict.failureReasons.length, 0);
  assert.match(
    verdict.failureReasons.join("; "),
    /ownership did not survive onto a fresh adapter[/]device/u,
  );
  assert.equal(verdict.checks.sameOwners, false);

  // The same break reported honestly by the engine is still a FAIL: the tier is
  // a property of the claim, not of whether the self-report agrees with it.
  const honest = ownershipBreakReport();
  honest.webgpu.identity.sameScene = false;
  const honestVerdict = foldC1229S5ReplacementDeviceGate(honest);
  assert.deepEqual(honestVerdict.structuralReasons, []);
  assert.equal(honestVerdict.status, "FAIL");
  assert.notEqual(honestVerdict.failureReasons.length, 0);
});

test("owner-token survival is executed and load-bearing under source mutation", () => {
  // Neutering both derivations must hand the ownership break back its PASS:
  // that proves these two functions are the sole authors of the new FAIL.
  const neutered = foldWithMutatedGate(
    [
      [
        "function sameOwnerTokens(left, right) {",
        "function sameOwnerTokens(left, right) { return true;",
      ],
      [
        "function attestedOwnerTokensConstant(session) {",
        "function attestedOwnerTokensConstant(session) { return true;",
      ],
    ],
    ownershipBreakReport(),
  );
  assert.equal(
    neutered.status,
    "PASS",
    neutered.structuralReasons.concat(neutered.failureReasons).join("; "),
  );

  // Inverting the comparison must red the healthy fixture: that proves the
  // comparison is reached on the passing path rather than being a no-op.
  const inverted = foldWithMutatedGate(
    [
      [
        "return OWNER_TOKEN_KEYS.every((key) => left[key] === right[key]);",
        "return OWNER_TOKEN_KEYS.every((key) => left[key] !== right[key]);",
      ],
    ],
    passingReport(),
  );
  assert.equal(inverted.status, "FAIL");
  assert.deepEqual(inverted.structuralReasons, []);
  assert.notEqual(inverted.failureReasons.length, 0);
});
