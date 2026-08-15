#!/usr/bin/env node
/**
 * C12-37 Moon/globe physical-depth browser oracle.
 *
 * This probe deliberately does not trust the originally supplied screenshot
 * as geometry. Its exact saved view is run first and MUST classify STRUCTURAL:
 * at the recorded clock the complete Moon sphere is behind the camera. The
 * certifying lanes are then derived from the live ICRF Moon center:
 *
 *   moon-near  camera beyond the Moon, looking inward; Moon and Earth overlap
 *              and the Moon must win physical depth;
 *   earth-near camera beyond the opposite Earth limb, looking through Earth
 *              toward the Moon; Earth must retain the legacy foreground win;
 *   crossing   camera walks the f64 route gap through prewarm, entry,
 *              hysteresis hold and exit while TAA-reset provenance is counted.
 *
 * Both backends run the same fixed clock. The overlap lanes sweep HDR/bloom
 * 2x2 under log depth and one hyperbolic control. Every render receives the
 * pinned JulianDate explicitly, and measured render/readback/provenance happen
 * in one page task. This file is browser work authored in Node/Playwright; do
 * not run it without a local dev server and explicit browser authorization.
 *
 * Usage (later, not as part of source validation):
 *   node Tools/visual-regression/probe-moon-globe-depth-occlusion.mjs
 *
 * Every invocation owns a UUID-named immutable run artifact. The mutable
 * `.latest.json` lifecycle record is changed to RUNNING before fallible setup
 * and finalized only after the immutable archive and write-once first-red are
 * safe. The original 2026-08-10 artifact is historical evidence and is never
 * a write target.
 */

import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { inflateSync } from "node:zlib";
import { chromium } from "playwright";
import {
  assertEvidenceReadableOrAbsent,
  atomicReplaceEvidence,
  compareEvidenceFileSnapshots,
  createImmutableEvidence,
  fingerprintEvidenceFile,
  inspectBuildSourceIdentity,
  safeGitHead,
  preserveFirstRedEvidence,
  snapshotEvidenceFiles,
  validateServedEntryIdentities,
} from "./lib/build-source-identity.mjs";

const toolDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(toolDirectory, "../..");
const defaultOutputDirectory = path.join(
  toolDirectory,
  "output",
  "performance",
);
const base = process.env.PROBE_BASE ?? "http://localhost:8080";
const viewerPath = "/Apps/CesiumViewer/index.html";
const pinnedIso = "2026-08-10T15:45:30Z";
const suppliedView =
  "-87.32540380650026,25.959575250510497,337256333.87659246," +
  "359.99999999999997,-89.93123587136975,0";
const viewport = { width: 1280, height: 720 };
const settleBudgetMs = 3000;
const settleMinimumFrames = 32;
const artifactPrefix = "campaign12-c12-37-moon-globe-depth-occlusion";
const artifactSchema = "c12-37-moon-globe-depth-occlusion-v5";
const readablePriorArtifactSchemas = Object.freeze([
  "c12-37-moon-globe-depth-occlusion-v2",
  "c12-37-moon-globe-depth-occlusion-v3",
  "c12-37-moon-globe-depth-occlusion-v4",
  artifactSchema,
]);
const browserLaunch = Object.freeze({
  channel: "msedge",
  headless: true,
  args: ["--enable-unsafe-webgpu", "--use-vulkan", "--disable-cache"],
});
const acceptanceBands = Object.freeze({
  minimumSamples: 8,
  winnerCloserFraction: 0.95,
  winnerErrorP95: 16,
  controlSeparation: 12,
  winnerMargin: 4,
  continuityRepetitions: 3,
  continuityCaptureSize: 193,
  continuityAnnulusPixels: 3,
  continuityHistogramEdges: Object.freeze([
    0, 1, 2, 4, 8, 16, 32, 64, 128, 256, 512, 765,
  ]),
});
const explicitFovDegrees = Object.freeze({
  normal: 60.0,
  diagnostic: 20.0,
  dualBody: 100.0,
});
const overlapConfigurations = Object.freeze([
  Object.freeze({ logDepth: true, hdr: false, bloom: false }),
  Object.freeze({ logDepth: true, hdr: false, bloom: true }),
  Object.freeze({ logDepth: true, hdr: true, bloom: false }),
  Object.freeze({ logDepth: true, hdr: true, bloom: true }),
  Object.freeze({ logDepth: false, hdr: false, bloom: false }),
]);
export const C12_37_EXPECTED_OVERLAP_KEYS = Object.freeze(
  ["moon-near", "earth-near"].flatMap((fixture) =>
    overlapConfigurations.map(
      (configuration) =>
        `${fixture}-log${Number(configuration.logDepth)}-hdr${Number(configuration.hdr)}-bloom${Number(configuration.bloom)}`,
    ),
  ),
);

/**
 * Interpret Moon command presence according to the route that was actually
 * emitted. A physical Moon is owned by the ordinary Scene command list, while
 * a legacy Moon is returned to the environment pass. The two routes are
 * intentionally exclusive, so the environment visibility bit is not evidence
 * against a correctly emitted physical command.
 */
export function assessC1237DualBodyMoonPresence(evidence) {
  const physical = evidence?.actualPhysical === true;
  const present = physical
    ? evidence?.physicalCommands === 1 &&
      evidence?.uniquePhysicalCommands === 1 &&
      evidence?.moonOwnedPhysicalCommands === 1 &&
      evidence?.physicalFrustumExecutions >= 1 &&
      evidence?.legacyCommandPresent === false &&
      evidence?.legacyVisible === false
    : evidence?.physicalCommands === 0 &&
      evidence?.uniquePhysicalCommands === 0 &&
      evidence?.moonOwnedPhysicalCommands === 0 &&
      evidence?.physicalFrustumExecutions === 0 &&
      evidence?.legacyCommandPresent === true &&
      evidence?.legacyVisible === true;
  return Object.freeze({
    route: physical ? "physical" : "legacy",
    present,
    evidence: Object.freeze({ ...evidence }),
  });
}

function validC1237EmittedMoonRoute(route, requireVisible = false) {
  if (route?.actualPhysical === true) {
    return (
      route?.physicalCommands === 1 &&
      route?.uniquePhysicalCommands === 1 &&
      route?.physicalFrustumExecutions >= 1 &&
      route?.legacyCommandPresent === false &&
      route?.legacyVisible === false
    );
  }

  // A legacy environment command can be emitted but rejected by the ordinary
  // Earth occluder. That is the expected combined-PVS state in an Earth-near
  // overlap lane, not evidence that Moon.update lost the legacy route. The
  // execution-filtered single-body control below bypasses that occluder only
  // while Earth execution is suppressed, and therefore requires visibility.
  return (
    route?.actualPhysical === false &&
    route?.physicalCommands === 0 &&
    route?.uniquePhysicalCommands === 0 &&
    route?.physicalFrustumExecutions === 0 &&
    route?.legacyCommandPresent === true &&
    typeof route?.legacyVisible === "boolean" &&
    (!requireVisible || route.legacyVisible === true)
  );
}

/**
 * Prove that a single-body visual control did not silently change the route
 * being tested. In particular, the Moon control must keep globe.show and
 * frameState.globeVisible true while suppressing globe execution with the
 * backend-neutral debug command filter. Turning globe.show off is not a valid
 * control because Moon.update uses frameState.globeVisible as part of
 * physical-route eligibility. A ClippingPlaneCollection is also unsuitable:
 * its WebGPU texture is not a WebGL-style destroyable Texture object.
 */
export function assessC1237RoutePreservingControls(controls) {
  const combined = controls?.combined;
  const earthOnly = controls?.earthOnly;
  const moonWithSuppressedGlobe = controls?.moonWithSuppressedGlobe;
  const reasons = [];
  const commonGlobeState = (route) =>
    route?.globeShown === true && route?.globeVisible === true;
  const ordinaryExecution = (route) =>
    route?.globeClippingCollectionPresent !== true &&
    route?.globeExecutionFilterActive === false &&
    route?.globeExecutionFilterStrategy === "none" &&
    route?.depthPlaneSuppressed === false &&
    route?.moonOcclusionBypassActive === false &&
    route?.moonOcclusionBypassCalls === 0 &&
    route?.controlRestored === true;

  if (
    combined?.moonShown !== true ||
    !commonGlobeState(combined) ||
    !ordinaryExecution(combined) ||
    !validC1237EmittedMoonRoute(combined)
  ) {
    reasons.push(
      "combined control did not retain the ordinary emitted dual-body route",
    );
  }
  if (
    earthOnly?.moonShown !== false ||
    !commonGlobeState(earthOnly) ||
    !ordinaryExecution(earthOnly) ||
    earthOnly?.actualPhysical !== false ||
    earthOnly?.physicalCommands !== 0 ||
    earthOnly?.uniquePhysicalCommands !== 0 ||
    earthOnly?.physicalFrustumExecutions !== 0 ||
    earthOnly?.legacyCommandPresent !== false ||
    earthOnly?.legacyVisible !== false
  ) {
    reasons.push("Earth-only control emitted or hid the wrong scene route");
  }
  if (
    moonWithSuppressedGlobe?.moonShown !== true ||
    !commonGlobeState(moonWithSuppressedGlobe) ||
    moonWithSuppressedGlobe?.globeClippingCollectionPresent !== false ||
    moonWithSuppressedGlobe?.globeExecutionFilterActive !== true ||
    moonWithSuppressedGlobe?.globeExecutionFilterStrategy !==
      "debug-command-filter:rendered-globe-tile-owner" ||
    moonWithSuppressedGlobe?.depthPlaneSuppressed !== true ||
    moonWithSuppressedGlobe?.moonOcclusionBypassActive !== true ||
    !(moonWithSuppressedGlobe?.globeCommandsRejected > 0) ||
    moonWithSuppressedGlobe?.globeCommandsSeen !==
      moonWithSuppressedGlobe?.globeCommandsRejected ||
    moonWithSuppressedGlobe?.globeCommandsAccepted !== 0 ||
    moonWithSuppressedGlobe?.controlRestored !== true ||
    moonWithSuppressedGlobe?.actualPhysical !== combined?.actualPhysical
  ) {
    reasons.push(
      "execution-filtered Moon control changed physical eligibility or did not suppress a non-vacuous globe",
    );
  } else if (
    !validC1237EmittedMoonRoute(moonWithSuppressedGlobe, true) ||
    (moonWithSuppressedGlobe.actualPhysical === false &&
      !(moonWithSuppressedGlobe.moonOcclusionBypassCalls > 0)) ||
    (moonWithSuppressedGlobe.actualPhysical === true &&
      moonWithSuppressedGlobe.moonOcclusionBypassCalls !== 0)
  ) {
    reasons.push(
      "execution-filtered Moon control lost its emitted or visible command route",
    );
  }

  return Object.freeze({ ok: reasons.length === 0, reasons });
}
const defaultOperationTimeouts = Object.freeze({
  launch: 60_000,
  newContext: 30_000,
  newPage: 30_000,
  navigation: 100_000,
  viewerReady: 100_000,
  evaluate: 300_000,
  runtimeEntry: 15_000,
  contextClose: 30_000,
  browserClose: 30_000,
  losingTaskDrain: 30_000,
});
// The per-operation bounds above catch a single stuck Playwright call. The
// primary watchdog bounds the whole two-backend probe and asks Edge to close;
// the outer fuse exists only for a close/launch operation that remains live
// after cancellation. That case retains RUNNING and the lock intentionally.
const defaultHardLimitMs = 720_000;
const defaultOuterWatchdogGraceMs = 60_000;

export const C12_37_PACKET_RELATIVE_FILES = Object.freeze([
  "packages/engine/Source/Scene/Moon.js",
  "packages/engine/Source/Scene/EllipsoidPrimitive.js",
  "packages/engine/Source/Scene/SceneOctree.js",
  "packages/engine/Source/Scene/OcclusionCulling.js",
  "packages/engine/Source/Renderer/WebGPU/WebGPUEnvironmentRenderer.js",
  "packages/engine/Source/Shaders/EllipsoidFS.glsl",
  "packages/engine/Source/Shaders/WebGPU/Environment/Moon.wgsl",
  "packages/engine/Source/Scene/Scene.js",
  "packages/engine/Source/Renderer/WebGPU/WebGPUSceneRenderer.ts",
  "packages/engine/Source/Scene/SceneRenderer.js",
  "packages/engine/Specs/Scene/ShadowCasterFilteringSpec.js",
  "packages/engine/Specs/Scene/MoonDepthRouteSpec.js",
  "packages/engine/Specs/Renderer/WebGPU/WebGPUMoonDepthRoutingSpec.js",
  "Tools/visual-regression/moon-globe-depth-routing.spec.mjs",
  "Tools/visual-regression/probe-moon-globe-depth-occlusion.mjs",
]);

const buildSourceRelativeFiles = Object.freeze([
  "packages/engine/Source/Scene/Moon.js",
  "packages/engine/Source/Scene/EllipsoidPrimitive.js",
  "packages/engine/Source/Scene/SceneOctree.js",
  "packages/engine/Source/Scene/OcclusionCulling.js",
  "packages/engine/Source/Renderer/WebGPU/WebGPUEnvironmentRenderer.js",
  "packages/engine/Source/Scene/Scene.js",
  "packages/engine/Source/Renderer/WebGPU/WebGPUSceneRenderer.ts",
  "packages/engine/Source/Scene/SceneRenderer.js",
  // Raw shader files are generated into these modules before bundling. Their
  // raw/generated equality is certified separately below, and the generated
  // module bytes are then compared exactly with sourcesContent in the map.
  "packages/engine/Source/Shaders/EllipsoidFS.js",
  "packages/engine/Source/Shaders/WebGPU/Environment/Moon.js",
]);

const generatedShaderPairs = Object.freeze([
  {
    name: "ellipsoidFragment",
    raw: "packages/engine/Source/Shaders/EllipsoidFS.glsl",
    generated: "packages/engine/Source/Shaders/EllipsoidFS.js",
  },
  {
    name: "moonWebgpu",
    raw: "packages/engine/Source/Shaders/WebGPU/Environment/Moon.wgsl",
    generated: "packages/engine/Source/Shaders/WebGPU/Environment/Moon.js",
  },
]);

const buildEntryPath = path.join(
  repositoryRoot,
  "Build",
  "CesiumUnminified",
  "index.js",
);
const buildSourceMapPath = `${buildEntryPath}.map`;
const identityHelperPath = fileURLToPath(
  new URL("./lib/build-source-identity.mjs", import.meta.url),
);
const localEvidenceFiles = Object.freeze({
  ...Object.fromEntries(
    C12_37_PACKET_RELATIVE_FILES.map((file, index) => [
      `packet${String(index).padStart(2, "0")}`,
      path.join(repositoryRoot, file),
    ]),
  ),
  generatedEllipsoidFragment: path.join(
    repositoryRoot,
    generatedShaderPairs[0].generated,
  ),
  generatedMoonWebgpu: path.join(
    repositoryRoot,
    generatedShaderPairs[1].generated,
  ),
  buildEntry: buildEntryPath,
  buildSourceMap: buildSourceMapPath,
  identityHelper: identityHelperPath,
});

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const artifactBytes = (value) => `${JSON.stringify(value, null, 2)}\n`;

export class C1237TimeoutError extends Error {
  constructor(label, milliseconds) {
    super(`${label} timed out after ${milliseconds} ms`);
    this.name = "C1237TimeoutError";
    this.label = label;
    this.milliseconds = milliseconds;
  }
}

export class C1237StructuralError extends Error {
  constructor(message, details = null) {
    super(message);
    this.name = "C1237StructuralError";
    this.details = details;
  }
}

export class C1237UnsettledOperationsError extends Error {
  constructor(message, details = null) {
    super(message);
    this.name = "C1237UnsettledOperationsError";
    this.details = details;
  }
}

export async function boundedC1237Promise(promise, milliseconds, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((resolve, reject) => {
        timer = setTimeout(
          () => reject(new C1237TimeoutError(label, milliseconds)),
          milliseconds,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export function resolveC1237OperationTimeouts(overrides = {}) {
  const resolved = { ...defaultOperationTimeouts, ...overrides };
  for (const [name, milliseconds] of Object.entries(resolved)) {
    if (!(Number.isFinite(milliseconds) && milliseconds > 0)) {
      throw new Error(
        `C12-37 operation timeout ${name} must be finite and positive`,
      );
    }
  }
  return Object.freeze(resolved);
}

/**
 * Track promises that lose a timeout race. Closing their owning context or
 * browser is not enough evidence by itself: final publication waits for every
 * tracked loser to settle. If one stays live, the invocation retains RUNNING.
 */
export function createC1237OperationTracker() {
  const pending = new Set();
  const timedOut = [];
  const run = async (
    operation,
    milliseconds,
    label,
    { onLateFulfilled } = {},
  ) => {
    let timeoutWon = false;
    const operationPromise = Promise.resolve().then(operation);
    const completion = operationPromise.then(async (value) => {
      if (timeoutWon && onLateFulfilled) {
        await onLateFulfilled(value);
      }
      return value;
    });
    pending.add(completion);
    void completion.then(
      () => pending.delete(completion),
      () => pending.delete(completion),
    );
    try {
      return await boundedC1237Promise(completion, milliseconds, label);
    } catch (error) {
      if (error instanceof C1237TimeoutError) {
        timeoutWon = true;
        timedOut.push({ label, milliseconds });
      }
      throw error;
    }
  };
  const drain = async (milliseconds) => {
    const observed = [...pending];
    if (observed.length === 0) {
      return { ok: true, pendingCount: 0, timedOut: [...timedOut] };
    }
    try {
      await boundedC1237Promise(
        Promise.allSettled(observed),
        milliseconds,
        "C12-37 losing operation drain",
      );
      return {
        ok: pending.size === 0,
        pendingCount: pending.size,
        timedOut: [...timedOut],
      };
    } catch (error) {
      return {
        ok: false,
        pendingCount: pending.size,
        timedOut: [...timedOut],
        error: error?.message ?? String(error),
      };
    }
  };
  return Object.freeze({
    run,
    drain,
    snapshot() {
      return {
        pendingCount: pending.size,
        timedOut: [...timedOut],
      };
    },
  });
}

export function sameC1237Fingerprint(left, right) {
  if (left?.exists === true && right?.exists === true) {
    return left.byteLength === right.byteLength && left.sha256 === right.sha256;
  }
  return (
    left?.exists === false &&
    left.error === "ENOENT" &&
    right?.exists === false &&
    right.error === "ENOENT"
  );
}

const c1237UuidV4Pattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export function isC1237UuidV4(value) {
  return typeof value === "string" && c1237UuidV4Pattern.test(value);
}

export function createC1237ArtifactPaths(outputDirectory, runId) {
  if (!isC1237UuidV4(runId)) {
    throw new Error("runId must be a UUID v4");
  }
  const directory = path.resolve(outputDirectory);
  return Object.freeze({
    runId,
    directory,
    // The pre-lifecycle green is retained under its original name forever.
    historical: path.join(directory, `${artifactPrefix}.json`),
    latest: path.join(directory, `${artifactPrefix}.latest.json`),
    firstRed: path.join(directory, `${artifactPrefix}.first-red.json`),
    lock: path.join(directory, `${artifactPrefix}.lock`),
    run: path.join(directory, `${artifactPrefix}.run-${runId}.json`),
    priorQuarantine: path.join(
      directory,
      `${artifactPrefix}.prior-${runId}.json`,
    ),
    image(renderer, comparisonKey, kind) {
      if (
        !["webgl", "webgpu"].includes(renderer) ||
        !/^[a-z0-9-]+$/u.test(comparisonKey) ||
        !["reference", "observed", "diff"].includes(kind)
      ) {
        throw new Error("invalid C12-37 continuity image identity");
      }
      return path.join(
        directory,
        `${artifactPrefix}.run-${runId}.${renderer}.${comparisonKey}.${kind}.png`,
      );
    },
    archiveForRunId(priorRunId) {
      if (!isC1237UuidV4(priorRunId)) {
        throw new Error("prior C12-37 runId must be a UUID v4");
      }
      return path.join(directory, `${artifactPrefix}.run-${priorRunId}.json`);
    },
  });
}

const c1237PngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const c1237PngCrcTable = Object.freeze(
  Array.from({ length: 256 }, (_, value) => {
    let crc = value;
    for (let bit = 0; bit < 8; bit++) {
      crc = (crc & 1) === 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
    }
    return crc >>> 0;
  }),
);

function c1237PngCrc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc = c1237PngCrcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * Validate the complete PNG container emitted by the same-task continuity
 * canvas. This deliberately validates framing and integrity, not just magic
 * bytes: lifecycle evidence must never publish a truncated or relabeled file.
 */
export function validateC1237ContinuityPng(bytes) {
  if (!Buffer.isBuffer(bytes)) {
    throw new Error("C12-37 continuity image bytes are not a Buffer");
  }
  if (
    bytes.byteLength <= c1237PngSignature.byteLength ||
    !bytes.subarray(0, c1237PngSignature.byteLength).equals(c1237PngSignature)
  ) {
    throw new Error("C12-37 continuity image has an invalid PNG signature");
  }

  let offset = c1237PngSignature.byteLength;
  let chunkCount = 0;
  let ihdrCount = 0;
  let idatCount = 0;
  let idatBytes = 0;
  const idatChunks = [];
  let plteSeen = false;
  let idatSequenceEnded = false;
  let iendSeen = false;
  while (offset < bytes.byteLength) {
    const remaining = bytes.byteLength - offset;
    if (remaining < 12) {
      throw new Error("C12-37 continuity PNG has a truncated chunk frame");
    }
    const length = bytes.readUInt32BE(offset);
    if (length > 0x7fffffff || length > remaining - 12) {
      throw new Error("C12-37 continuity PNG has a malformed chunk length");
    }
    const typeStart = offset + 4;
    const dataStart = typeStart + 4;
    const dataEnd = dataStart + length;
    const crcOffset = dataEnd;
    const nextOffset = crcOffset + 4;
    const typeBytes = bytes.subarray(typeStart, dataStart);
    if (
      ![...typeBytes].every(
        (byte) =>
          (byte >= 0x41 && byte <= 0x5a) || (byte >= 0x61 && byte <= 0x7a),
      ) ||
      (typeBytes[2] & 0x20) !== 0
    ) {
      throw new Error("C12-37 continuity PNG has an invalid chunk type");
    }
    const type = typeBytes.toString("ascii");
    const expectedCrc = bytes.readUInt32BE(crcOffset);
    const actualCrc = c1237PngCrc32(bytes.subarray(typeStart, dataEnd));
    if (actualCrc !== expectedCrc) {
      throw new Error(`C12-37 continuity PNG ${type} CRC is invalid`);
    }

    if (chunkCount === 0 && type !== "IHDR") {
      throw new Error("C12-37 continuity PNG IHDR is not the first chunk");
    }
    if (type === "IHDR") {
      ihdrCount++;
      if (ihdrCount !== 1 || chunkCount !== 0 || length !== 13) {
        throw new Error("C12-37 continuity PNG has an invalid IHDR chunk");
      }
      const width = bytes.readUInt32BE(dataStart);
      const height = bytes.readUInt32BE(dataStart + 4);
      const bitDepth = bytes[dataStart + 8];
      const colorType = bytes[dataStart + 9];
      const compression = bytes[dataStart + 10];
      const filter = bytes[dataStart + 11];
      const interlace = bytes[dataStart + 12];
      if (
        width !== acceptanceBands.continuityCaptureSize ||
        height !== acceptanceBands.continuityCaptureSize
      ) {
        throw new Error(
          `C12-37 continuity PNG dimensions must be ${acceptanceBands.continuityCaptureSize}x${acceptanceBands.continuityCaptureSize}`,
        );
      }
      if (
        bitDepth !== 8 ||
        colorType !== 6 ||
        compression !== 0 ||
        filter !== 0 ||
        interlace !== 0
      ) {
        throw new Error(
          "C12-37 continuity PNG IHDR is not an 8-bit non-interlaced RGBA screenshot",
        );
      }
    } else if (type === "PLTE") {
      if (
        plteSeen ||
        idatCount > 0 ||
        length === 0 ||
        length > 768 ||
        length % 3 !== 0
      ) {
        throw new Error("C12-37 continuity PNG has an invalid PLTE chunk");
      }
      plteSeen = true;
    } else if (type === "IDAT") {
      if (idatSequenceEnded) {
        throw new Error(
          "C12-37 continuity PNG has non-consecutive IDAT chunks",
        );
      }
      idatCount++;
      idatBytes += length;
      idatChunks.push(bytes.subarray(dataStart, dataEnd));
    } else if (type === "IEND") {
      if (length !== 0 || iendSeen) {
        throw new Error("C12-37 continuity PNG has an invalid IEND chunk");
      }
      iendSeen = true;
      if (nextOffset !== bytes.byteLength) {
        throw new Error("C12-37 continuity PNG has trailing bytes after IEND");
      }
    } else {
      if ((typeBytes[0] & 0x20) === 0) {
        throw new Error(
          `C12-37 continuity PNG has unknown critical chunk ${type}`,
        );
      }
      if (idatCount > 0) idatSequenceEnded = true;
    }

    chunkCount++;
    offset = nextOffset;
    if (iendSeen) break;
  }
  if (ihdrCount !== 1) {
    throw new Error("C12-37 continuity PNG is missing IHDR");
  }
  if (idatCount === 0 || idatBytes === 0) {
    throw new Error("C12-37 continuity PNG is missing IDAT image data");
  }
  if (!iendSeen) {
    throw new Error("C12-37 continuity PNG is missing IEND");
  }

  // A framed IDAT is not necessarily an image. Decode the complete zlib
  // stream and require exactly one filter byte plus four RGBA bytes per pixel
  // for every row. This rejects CRC-correct truncated, bomb, trailing-stream,
  // and invalid-filter payloads before they can become immutable evidence.
  const compressedImage = Buffer.concat(idatChunks, idatBytes);
  const rowByteLength = 1 + acceptanceBands.continuityCaptureSize * 4;
  const decodedByteLength =
    rowByteLength * acceptanceBands.continuityCaptureSize;
  let decodedImage;
  let compressedBytesConsumed;
  try {
    const inflated = inflateSync(compressedImage, {
      info: true,
      maxOutputLength: decodedByteLength + 1,
    });
    decodedImage = inflated.buffer;
    compressedBytesConsumed = inflated.engine.bytesWritten;
  } catch (error) {
    throw new Error("C12-37 continuity PNG IDAT zlib stream is invalid", {
      cause: error,
    });
  }
  if (compressedBytesConsumed !== compressedImage.byteLength) {
    throw new Error("C12-37 continuity PNG IDAT has trailing compressed bytes");
  }
  if (decodedImage.byteLength !== decodedByteLength) {
    throw new Error(
      `C12-37 continuity PNG decoded scanlines must contain exactly ${decodedByteLength} bytes`,
    );
  }
  for (let row = 0; row < acceptanceBands.continuityCaptureSize; row++) {
    const filter = decodedImage[row * rowByteLength];
    if (filter > 4) {
      throw new Error(
        `C12-37 continuity PNG row ${row} has invalid filter ${filter}`,
      );
    }
  }
  return Object.freeze({
    width: acceptanceBands.continuityCaptureSize,
    height: acceptanceBands.continuityCaptureSize,
    bitDepth: 8,
    colorType: 6,
    idatCount,
  });
}

function decodeC1237PngDataUrl(dataUrl) {
  const prefix = "data:image/png;base64,";
  if (typeof dataUrl !== "string" || !dataUrl.startsWith(prefix)) {
    throw new Error("C12-37 continuity image is not a PNG data URL");
  }
  const encoded = dataUrl.slice(prefix.length);
  if (
    encoded.length === 0 ||
    encoded.length % 4 !== 0 ||
    !/^[a-z0-9+/]+={0,2}$/iu.test(encoded)
  ) {
    throw new Error("C12-37 continuity image has invalid base64 bytes");
  }
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.toString("base64") !== encoded) {
    throw new Error("C12-37 continuity image has non-canonical base64 bytes");
  }
  validateC1237ContinuityPng(bytes);
  return bytes;
}

/**
 * Convert page-returned PNG data URLs into UUID-bound immutable files before
 * the final JSON can claim PASS. The returned result contains only verified
 * fingerprints, keeping large base64 payloads out of the lifecycle artifact.
 */
export function publishC1237ContinuityImages(paths, result, operations = fs) {
  const comparisons = result?.crossing?.comparisons;
  if (!Array.isArray(comparisons)) {
    return [];
  }
  const captures = [];
  try {
    for (const comparison of comparisons) {
      const dataUrls = comparison?.imageDataUrls;
      if (!dataUrls) continue;
      for (const kind of ["reference", "observed", "diff"]) {
        captures.push({
          comparison,
          kind,
          file: paths.image(result.renderer, comparison.key, kind),
          bytes: decodeC1237PngDataUrl(dataUrls[kind]),
        });
      }
    }
  } finally {
    // Never serialize multi-megabyte base64 captures into an ERROR or
    // first-red JSON, including when one decode fails before publication.
    for (const comparison of comparisons) {
      delete comparison?.imageDataUrls;
    }
  }
  const publications = [];
  for (const { comparison, kind, file, bytes } of captures) {
    createImmutableEvidence(file, bytes, operations);
    validateC1237ContinuityPng(operations.readFileSync(file));
    const fingerprint = fingerprintEvidenceFile(file, operations);
    assertEvidenceReadableOrAbsent(
      fingerprint,
      `C12-37 ${comparison.key} ${kind} PNG`,
    );
    if (
      fingerprint.exists !== true ||
      fingerprint.byteLength !== bytes.byteLength ||
      fingerprint.sha256 !== sha256(bytes)
    ) {
      throw new Error(
        `immutable C12-37 ${comparison.key} ${kind} PNG differs from captured bytes`,
      );
    }
    comparison.images ??= {};
    comparison.images[kind] = fingerprint;
    publications.push({
      renderer: result.renderer,
      comparisonKey: comparison.key,
      kind,
      ...fingerprint,
    });
  }
  return publications;
}

export function verifyC1237ContinuityImages(paths, result, operations = fs) {
  const comparisons = result?.crossing?.comparisons;
  if (!Array.isArray(comparisons)) {
    throw new Error("C12-37 continuity comparisons are absent at image verify");
  }
  const verified = [];
  for (const comparison of comparisons) {
    for (const kind of ["reference", "observed", "diff"]) {
      const expectedFile = paths.image(result.renderer, comparison.key, kind);
      const claimed = comparison?.images?.[kind];
      if (path.resolve(claimed?.file ?? "") !== path.resolve(expectedFile)) {
        throw new Error(
          `C12-37 ${comparison?.key} ${kind} PNG is not bound to this run`,
        );
      }
      const current = fingerprintEvidenceFile(expectedFile, operations);
      assertEvidenceReadableOrAbsent(
        current,
        `C12-37 ${comparison.key} ${kind} PNG at final verify`,
      );
      if (!sameC1237Fingerprint(claimed, current)) {
        throw new Error(
          `C12-37 ${comparison.key} ${kind} PNG changed after publication`,
        );
      }
      validateC1237ContinuityPng(operations.readFileSync(expectedFile));
      const afterValidation = fingerprintEvidenceFile(expectedFile, operations);
      if (!sameC1237Fingerprint(current, afterValidation)) {
        throw new Error(
          `C12-37 ${comparison.key} ${kind} PNG changed during final validation`,
        );
      }
      verified.push({
        renderer: result.renderer,
        comparisonKey: comparison.key,
        kind,
        ...afterValidation,
      });
    }
  }
  const expectedCount = expectedC1237ContinuityKeys().length * 3;
  if (verified.length !== expectedCount) {
    throw new Error(
      `C12-37 ${result?.renderer} expected ${expectedCount} verified continuity PNGs; observed ${verified.length}`,
    );
  }
  return verified;
}

function discardC1237ContinuityImageDataUrls(results) {
  let discarded = 0;
  for (const result of results) {
    for (const comparison of result?.crossing?.comparisons ?? []) {
      if (comparison?.imageDataUrls !== undefined) {
        delete comparison.imageDataUrls;
        discarded++;
      }
    }
  }
  return discarded;
}

export function captureC1237PriorLatest(file, operations = fs) {
  try {
    const value = operations.readFileSync(file);
    const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
    const latest = {
      file,
      exists: true,
      byteLength: bytes.byteLength,
      sha256: sha256(bytes),
    };
    try {
      return {
        latest,
        bytes,
        parsed: JSON.parse(bytes.toString("utf8")),
        parseError: null,
      };
    } catch (error) {
      return {
        latest,
        bytes,
        parsed: null,
        parseError: error?.message ?? String(error),
      };
    }
  } catch (error) {
    return {
      latest: {
        file,
        exists: false,
        byteLength: null,
        sha256: null,
        error: error?.code ?? error?.message ?? String(error),
      },
      bytes: null,
      parsed: null,
      parseError: null,
    };
  }
}

function summarizeC1237PriorLatest(captured) {
  return {
    latest: captured?.latest,
    parsedStatus: captured?.parsed?.status ?? null,
    parsedRunId: captured?.parsed?.runId ?? null,
    parseError: captured?.parseError ?? null,
  };
}

export function assertNoPriorC1237Running(captured) {
  if (
    captured?.parsed?.status === "RUNNING" ||
    captured?.parsed?.incomplete === true
  ) {
    throw new Error(
      `previous C12-37 RUNNING marker ${String(captured.parsed.runId)} must be investigated before retry`,
    );
  }
}

export function acquireC1237RunLock(paths, operations = fs) {
  operations.writeFileSync(
    paths.lock,
    artifactBytes({
      runId: paths.runId,
      acquiredAt: new Date().toISOString(),
    }),
    { flag: "wx" },
  );
  assertC1237RunLockOwnership(paths, operations);
}

function ensureC1237RunLockOwnership(paths, lockRecord, operations = fs) {
  try {
    return assertC1237RunLockOwnership(paths, operations);
  } catch (error) {
    const fingerprint = fingerprintEvidenceFile(paths.lock, operations);
    if (!(fingerprint.exists === false && fingerprint.error === "ENOENT")) {
      throw error;
    }
    operations.writeFileSync(paths.lock, artifactBytes(lockRecord), {
      flag: "wx",
    });
    return assertC1237RunLockOwnership(paths, operations);
  }
}

export function assertC1237RunLockOwnership(paths, operations = fs) {
  let bytes;
  let lock;
  try {
    const value = operations.readFileSync(paths.lock);
    bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
    lock = JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    throw new Error("C12-37 run lock is absent or unreadable", {
      cause: error,
    });
  }
  if (lock?.runId !== paths.runId) {
    throw new Error("C12-37 run lock ownership changed during the run");
  }
  if (!bytes.equals(Buffer.from(artifactBytes(lock)))) {
    throw new Error("C12-37 run lock bytes are not the exact owned record");
  }
  return lock;
}

function restoreClaimedC1237RunLock(paths, bytes, operations = fs) {
  try {
    operations.writeFileSync(paths.lock, bytes, { flag: "wx" });
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
  }
  const canonicalValue = operations.readFileSync(paths.lock);
  const canonicalBytes = Buffer.isBuffer(canonicalValue)
    ? canonicalValue
    : Buffer.from(canonicalValue);
  if (!canonicalBytes.equals(bytes)) {
    throw new Error(
      "C12-37 canonical lock is occupied by different authority; release receipt retained",
    );
  }
}

function restoreClaimedC1237Latest(paths, bytes, operations = fs) {
  let creationError;
  try {
    operations.writeFileSync(paths.latest, bytes, { flag: "wx" });
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    creationError = error;
  }
  let canonicalValue;
  try {
    canonicalValue = operations.readFileSync(paths.latest);
  } catch (error) {
    throw new AggregateError(
      [creationError, error].filter(Boolean),
      "C12-37 claimed latest could not be restored exactly",
      { cause: error },
    );
  }
  const canonicalBytes = Buffer.isBuffer(canonicalValue)
    ? canonicalValue
    : Buffer.from(canonicalValue);
  if (!canonicalBytes.equals(bytes)) {
    throw new Error(
      "C12-37 canonical latest is occupied by different authority; rollback receipt retained",
    );
  }
}

export function releaseC1237RunLock(paths, operations = fs) {
  const ownedRecord = assertC1237RunLockOwnership(paths, operations);
  const ownedBytes = Buffer.from(artifactBytes(ownedRecord));
  const receipt = path.join(
    paths.directory,
    `${artifactPrefix}.lock-release-${paths.runId}.${randomUUID()}.receipt`,
  );

  // Rename atomically claims the pathname identity that was canonical at the
  // exact release instant. A competitor can replace the lock after our read,
  // but it cannot make us unlink those foreign bytes under the old pathname.
  let renameError;
  try {
    operations.renameSync(paths.lock, receipt);
  } catch (error) {
    renameError = error;
  }
  let claimedValue;
  try {
    claimedValue = operations.readFileSync(receipt);
  } catch (claimError) {
    if (renameError !== undefined && claimError?.code === "ENOENT") {
      throw renameError;
    }
    throw new AggregateError(
      [renameError, claimError].filter(Boolean),
      "C12-37 release claim could not be inspected; canonical lock was not deleted",
      { cause: claimError },
    );
  }
  const claimedBytes = Buffer.isBuffer(claimedValue)
    ? claimedValue
    : Buffer.from(claimedValue);
  if (!claimedBytes.equals(ownedBytes)) {
    const ownershipError = new Error(
      "C12-37 release claim captured foreign lock authority",
    );
    try {
      // Restore byte-for-byte with exclusive creation. Never overwrite a new
      // canonical owner, never touch canonical latest, and retain the receipt
      // as recovery evidence even when restoration succeeds.
      restoreClaimedC1237RunLock(paths, claimedBytes, operations);
    } catch (restoreError) {
      throw new AggregateError(
        [ownershipError, restoreError],
        "C12-37 release captured foreign lock authority and could not restore it canonically; receipt retained",
        { cause: restoreError },
      );
    }
    throw ownershipError;
  }
  if (renameError !== undefined) {
    try {
      restoreClaimedC1237RunLock(paths, ownedBytes, operations);
    } catch (restoreError) {
      throw new AggregateError(
        [renameError, restoreError],
        "C12-37 release rename reported failure after claiming the owned lock; receipt retained",
        { cause: restoreError },
      );
    }
    throw renameError;
  }

  const canonicalBeforeDelete = fingerprintEvidenceFile(paths.lock, operations);
  assertEvidenceReadableOrAbsent(
    canonicalBeforeDelete,
    "C12-37 canonical lock after release claim",
  );
  if (
    canonicalBeforeDelete.exists !== false ||
    canonicalBeforeDelete.error !== "ENOENT"
  ) {
    throw new Error(
      "C12-37 new canonical lock authority appeared during release; owned receipt retained",
    );
  }

  try {
    operations.unlinkSync(receipt);
  } catch (error) {
    try {
      // A reported unlink failure is ambiguous even if the directory entry is
      // already gone. Reconstitute exact ownership under the canonical name so
      // finalization can restore RUNNING and fail closed.
      restoreClaimedC1237RunLock(paths, ownedBytes, operations);
    } catch (restoreError) {
      throw new AggregateError(
        [error, restoreError],
        "C12-37 release receipt deletion failed and owned lock restoration failed",
        { cause: restoreError },
      );
    }
    throw error;
  }

  const receiptAfterDelete = fingerprintEvidenceFile(receipt, operations);
  const canonicalAfterDelete = fingerprintEvidenceFile(paths.lock, operations);
  assertEvidenceReadableOrAbsent(
    receiptAfterDelete,
    "C12-37 deleted release receipt",
  );
  assertEvidenceReadableOrAbsent(
    canonicalAfterDelete,
    "C12-37 released canonical lock",
  );
  if (
    receiptAfterDelete.exists !== false ||
    receiptAfterDelete.error !== "ENOENT" ||
    canonicalAfterDelete.exists !== false ||
    canonicalAfterDelete.error !== "ENOENT"
  ) {
    try {
      restoreClaimedC1237RunLock(paths, ownedBytes, operations);
    } catch (restoreError) {
      throw new Error(
        "C12-37 release could not prove receipt and canonical lock absence",
        { cause: restoreError },
      );
    }
    throw new Error(
      "C12-37 release could not prove receipt and canonical lock absence; ownership restored",
    );
  }
}

export function publishC1237Running(paths, marker, operations = fs) {
  if (
    marker?.runId !== paths.runId ||
    marker?.status !== "RUNNING" ||
    marker?.incomplete !== true
  ) {
    throw new Error("RUNNING marker does not own this C12-37 run");
  }
  assertC1237RunLockOwnership(paths, operations);
  const bytes = artifactBytes(marker);
  atomicReplaceEvidence(paths.latest, bytes, operations);
  const published = fingerprintEvidenceFile(paths.latest, operations);
  if (
    published.exists !== true ||
    published.byteLength !== Buffer.byteLength(bytes) ||
    published.sha256 !== sha256(bytes)
  ) {
    throw new Error(
      "published C12-37 RUNNING marker failed exact verification",
    );
  }
  assertC1237RunningOwnership(paths, operations);
}

export function assertC1237RunningOwnership(paths, operations = fs) {
  assertC1237RunLockOwnership(paths, operations);
  let marker;
  try {
    marker = JSON.parse(operations.readFileSync(paths.latest, "utf8"));
  } catch (error) {
    throw new Error("C12-37 RUNNING marker is absent or unreadable", {
      cause: error,
    });
  }
  if (
    marker?.runId !== paths.runId ||
    marker?.status !== "RUNNING" ||
    marker?.incomplete !== true
  ) {
    throw new Error("C12-37 RUNNING marker ownership was lost");
  }
  return marker;
}

function restoreOwnedC1237Running(
  paths,
  runningMarker,
  lockRecord,
  expectedLatestBytes,
  operations = fs,
) {
  const bytes = artifactBytes(runningMarker);
  const runningBytes = Buffer.from(bytes);
  const expectedBytes = Buffer.isBuffer(expectedLatestBytes)
    ? expectedLatestBytes
    : Buffer.from(expectedLatestBytes);
  const allowedClaimBytes = [runningBytes, expectedBytes];
  const failures = [];
  const assertExactRestoredRunning = () => {
    assertC1237RunningOwnership(paths, operations);
    const currentValue = operations.readFileSync(paths.latest);
    const currentBytes = Buffer.isBuffer(currentValue)
      ? currentValue
      : Buffer.from(currentValue);
    if (!currentBytes.equals(runningBytes)) {
      throw new Error(
        "C12-37 restored RUNNING bytes are not the exact owned marker",
      );
    }
  };

  // Atomically move the canonical latest pathname to a unique receipt, verify
  // that the claimed bytes belong to this invocation, then recreate RUNNING
  // with exclusive creation. Unlike rename-overwrite, the final write cannot
  // replace a competing invocation's late lock/latest pair. Retry once for an
  // interrupted claim; every ambiguous receipt remains recovery evidence.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      ensureC1237RunLockOwnership(paths, lockRecord, operations);
      const receipt = path.join(
        paths.directory,
        `${artifactPrefix}.running-restore-${paths.runId}.${randomUUID()}.receipt`,
      );
      let renameError;
      try {
        operations.renameSync(paths.latest, receipt);
      } catch (error) {
        renameError = error;
      }
      let claimedValue;
      try {
        claimedValue = operations.readFileSync(receipt);
      } catch (claimError) {
        if (renameError !== undefined && claimError?.code === "ENOENT") {
          throw renameError;
        }
        throw new AggregateError(
          [renameError, claimError].filter(Boolean),
          "C12-37 RUNNING rollback claim could not be inspected",
          { cause: claimError },
        );
      }
      const claimedBytes = Buffer.isBuffer(claimedValue)
        ? claimedValue
        : Buffer.from(claimedValue);
      const restoreClaimAndThrow = (error, message) => {
        try {
          restoreClaimedC1237Latest(paths, claimedBytes, operations);
        } catch (restoreError) {
          throw new AggregateError([error, restoreError], message, {
            cause: restoreError,
          });
        }
        throw error;
      };
      if (renameError !== undefined) {
        restoreClaimAndThrow(
          renameError,
          "C12-37 RUNNING rollback rename was ambiguous and its claim could not be restored",
        );
      }
      if (!allowedClaimBytes.some((allowed) => claimedBytes.equals(allowed))) {
        restoreClaimAndThrow(
          new Error(
            "C12-37 RUNNING rollback captured foreign latest authority",
          ),
          "C12-37 RUNNING rollback captured foreign latest authority and could not restore it canonically",
        );
      }
      try {
        assertC1237RunLockOwnership(paths, operations);
      } catch (authorityError) {
        restoreClaimAndThrow(
          authorityError,
          "C12-37 RUNNING rollback lost lock authority and could not restore its claimed latest",
        );
      }

      let publishError;
      try {
        operations.writeFileSync(paths.latest, runningBytes, { flag: "wx" });
      } catch (error) {
        publishError = error;
      }
      if (publishError !== undefined) {
        // A reported exclusive-create failure may be ambiguous. Accept it only
        // when exact owned RUNNING is already canonical; otherwise retain the
        // receipt and leave any late foreign latest untouched.
        try {
          assertExactRestoredRunning();
        } catch (verificationError) {
          throw new AggregateError(
            [publishError, verificationError],
            "C12-37 RUNNING rollback exclusive publication failed",
            { cause: verificationError },
          );
        }
      } else {
        assertExactRestoredRunning();
      }

      let receiptCleanupError;
      try {
        operations.unlinkSync(receipt);
      } catch (error) {
        receiptCleanupError = error;
      }
      const receiptAfterCleanup = fingerprintEvidenceFile(receipt, operations);
      assertEvidenceReadableOrAbsent(
        receiptAfterCleanup,
        "C12-37 RUNNING rollback receipt after cleanup",
      );
      assertExactRestoredRunning();
      return {
        method: "receipt-cas",
        attempt: attempt + 1,
        receiptRetained: receiptAfterCleanup.exists === true,
        receiptCleanupError:
          receiptCleanupError?.message ??
          (receiptAfterCleanup.exists === true ? "receipt retained" : null),
      };
    } catch (error) {
      failures.push(error);
    }
  }
  throw new AggregateError(
    failures,
    "C12-37 could not restore its owned RUNNING marker; run lock retained",
  );
}

function quarantineCapturedC1237Latest(captured, paths, operations) {
  try {
    createImmutableEvidence(paths.priorQuarantine, captured.bytes, operations);
  } catch (error) {
    if (error?.code !== "EEXIST") {
      throw error;
    }
  }
  const quarantine = fingerprintEvidenceFile(paths.priorQuarantine, operations);
  // Zero bytes are corrupt JSON but still readable evidence. The shared
  // positive-length assertion is intentionally not used on this quarantine.
  if (
    quarantine.exists !== true ||
    !Number.isInteger(quarantine.byteLength) ||
    quarantine.byteLength < 0 ||
    !/^[0-9a-f]{64}$/u.test(quarantine.sha256 ?? "") ||
    !sameC1237Fingerprint(captured.latest, quarantine)
  ) {
    throw new Error(
      "prior C12-37 latest quarantine differs from captured bytes",
    );
  }
  return quarantine;
}

export function prepareCapturedC1237LatestForRun(
  captured,
  paths,
  operations = fs,
) {
  const latest = captured?.latest;
  if (latest?.exists !== true) {
    assertEvidenceReadableOrAbsent(latest, "prior C12-37 latest artifact");
    return { mode: "absent", latest };
  }
  if (
    captured.parseError !== null ||
    typeof captured.parsed !== "object" ||
    captured.parsed === null ||
    Array.isArray(captured.parsed)
  ) {
    const quarantine = quarantineCapturedC1237Latest(
      captured,
      paths,
      operations,
    );
    throw new Error(
      `prior C12-37 latest JSON is malformed; exact bytes quarantined at ${quarantine.file}`,
    );
  }

  assertEvidenceReadableOrAbsent(latest, "prior C12-37 latest artifact");
  assertNoPriorC1237Running(captured);
  const previous = captured.parsed;
  if (
    !readablePriorArtifactSchemas.includes(previous.schema) ||
    !isC1237UuidV4(previous.runId) ||
    !["PASS", "FAIL", "STRUCTURAL", "ERROR"].includes(previous.status) ||
    previous.incomplete !== false
  ) {
    const quarantine = quarantineCapturedC1237Latest(
      captured,
      paths,
      operations,
    );
    throw new Error(
      `prior C12-37 latest lifecycle state is unsupported; exact bytes quarantined at ${quarantine.file}`,
    );
  }
  const previousArchive = fingerprintEvidenceFile(
    paths.archiveForRunId(previous.runId),
    operations,
  );
  assertEvidenceReadableOrAbsent(
    previousArchive,
    "prior immutable C12-37 run artifact",
  );
  if (!sameC1237Fingerprint(latest, previousArchive)) {
    throw new Error(
      `prior C12-37 latest is not bound to immutable run ${previous.runId}`,
    );
  }
  return {
    mode: "prior-lifecycle-run",
    latest,
    immutableRunArtifact: previousArchive,
  };
}

export function finalizeC1237Evidence(paths, artifact, operations = fs) {
  if (
    artifact?.runId !== paths.runId ||
    artifact?.schema !== artifactSchema ||
    !["PASS", "FAIL", "STRUCTURAL", "ERROR"].includes(artifact?.status) ||
    artifact?.incomplete !== false
  ) {
    throw new Error(
      "final C12-37 artifact is malformed or owned by another run",
    );
  }
  const lockRecord = assertC1237RunLockOwnership(paths, operations);
  const runningMarker = assertC1237RunningOwnership(paths, operations);
  const bytes = artifactBytes(artifact);
  const expected = {
    byteLength: Buffer.byteLength(bytes),
    sha256: sha256(bytes),
  };
  createImmutableEvidence(paths.run, bytes, operations);
  const immutableRun = fingerprintEvidenceFile(paths.run, operations);
  assertEvidenceReadableOrAbsent(
    immutableRun,
    "new immutable C12-37 run artifact",
  );
  if (
    immutableRun.exists !== true ||
    immutableRun.byteLength !== expected.byteLength ||
    immutableRun.sha256 !== expected.sha256
  ) {
    throw new Error(
      "new immutable C12-37 run artifact differs from serialized final bytes",
    );
  }
  const firstRed =
    artifact.status === "PASS"
      ? null
      : preserveFirstRedEvidence(
          paths.firstRed,
          bytes,
          operations,
          fingerprintEvidenceFile,
        );
  let latest;
  try {
    atomicReplaceEvidence(paths.latest, bytes, operations);
    latest = fingerprintEvidenceFile(paths.latest, operations);
    assertEvidenceReadableOrAbsent(latest, "final C12-37 latest artifact");
    if (
      latest.exists !== true ||
      latest.byteLength !== expected.byteLength ||
      latest.sha256 !== expected.sha256 ||
      !sameC1237Fingerprint(immutableRun, latest)
    ) {
      throw new Error("latest C12-37 artifact differs from its immutable run");
    }
    releaseC1237RunLock(paths, operations);
  } catch (error) {
    // A final claim exists only if its exact bytes verify and ownership is
    // relinquished. Restore this invocation's marker and retain the lock on
    // any post-publication verification or release failure.
    let restoration;
    try {
      restoration = restoreOwnedC1237Running(
        paths,
        runningMarker,
        lockRecord,
        bytes,
        operations,
      );
    } catch (restoreError) {
      throw new AggregateError(
        [error, restoreError],
        "C12-37 final verification/release and RUNNING restoration failed; run lock retained",
        { cause: restoreError },
      );
    }
    throw new Error(
      `C12-37 final verification or lock release failed; owned RUNNING marker restored (${restoration.method})`,
      {
        cause: error,
      },
    );
  }
  return { immutableRun, latest, firstRed, lockReleased: true };
}

async function inspectGeneratedShaderPair(pair) {
  const rawPath = path.join(repositoryRoot, pair.raw);
  const generatedPath = path.join(repositoryRoot, pair.generated);
  const rawBytes = fs.readFileSync(rawPath);
  const generatedBytes = fs.readFileSync(generatedPath);
  const generatedModule = await import(
    `${pathToFileURL(generatedPath).href}?c12_37_identity=${randomUUID()}`
  );
  const normalizedRaw = rawBytes.toString("utf8").replaceAll("\r\n", "\n");
  const generatedText = generatedModule.default;
  return {
    name: pair.name,
    raw: {
      file: rawPath,
      byteLength: rawBytes.byteLength,
      sha256: sha256(rawBytes),
    },
    generated: {
      file: generatedPath,
      byteLength: generatedBytes.byteLength,
      sha256: sha256(generatedBytes),
    },
    exact: typeof generatedText === "string" && normalizedRaw === generatedText,
  };
}

export async function collectC1237Provenance() {
  const capturedAt = new Date().toISOString();
  const localIdentity = snapshotEvidenceFiles(localEvidenceFiles);
  const reasons = Object.entries(localIdentity)
    .filter(([, identity]) => identity.exists !== true)
    .map(
      ([name, identity]) =>
        `${name}: required identity is unreadable (${String(identity.error)})`,
    );
  let buildSourceIdentity;
  try {
    buildSourceIdentity = inspectBuildSourceIdentity({
      sourceMapPath: buildSourceMapPath,
      sourceFiles: buildSourceRelativeFiles.map((file) =>
        path.join(repositoryRoot, file),
      ),
    });
  } catch (error) {
    buildSourceIdentity = {
      ok: false,
      sourceMapPath: buildSourceMapPath,
      entries: [],
      reasons: [error?.message ?? String(error)],
    };
  }
  reasons.push(
    ...buildSourceIdentity.reasons.map(
      (reason) => `build/source identity: ${reason}`,
    ),
  );

  const generatedShaders = [];
  for (const pair of generatedShaderPairs) {
    try {
      const identity = await inspectGeneratedShaderPair(pair);
      generatedShaders.push(identity);
      if (!identity.exact) {
        reasons.push(
          `${pair.name}: generated shader module differs from normalized raw source`,
        );
      }
    } catch (error) {
      generatedShaders.push({
        name: pair.name,
        exact: false,
        error: error?.message ?? String(error),
      });
      reasons.push(`${pair.name}: generated shader identity could not be read`);
    }
  }

  const gitHead = safeGitHead(repositoryRoot) ?? null;
  if (!/^[0-9a-f]{40}$/u.test(gitHead ?? "")) {
    reasons.push("git HEAD identity is unavailable");
  }
  return {
    capturedAt,
    gitHead,
    packetRelativeFiles: [...C12_37_PACKET_RELATIVE_FILES],
    localIdentity,
    buildSourceIdentity,
    generatedShaders,
    ok: reasons.length === 0,
    reasons,
  };
}

function validGpuIdentity(result) {
  const gpu = result?.gpuProvenance;
  if (
    result?.ok !== true ||
    gpu?.backend !== result.actualRenderer ||
    typeof gpu?.rendererString !== "string" ||
    gpu.rendererString.length === 0
  ) {
    return false;
  }
  if (result.actualRenderer !== "webgpu") {
    return true;
  }
  const info = gpu.adapterInfo;
  return [
    info?.vendor,
    info?.architecture,
    info?.device,
    info?.description,
  ].some((value) => typeof value === "string" && value.length > 0);
}

export function assessC1237Provenance(options) {
  const reasons = [];
  const start = options?.start;
  const end = options?.end;
  if (start?.ok !== true) {
    reasons.push(
      `start identity is not exact: ${(start?.reasons ?? ["missing"]).join("; ")}`,
    );
  }
  if (end?.ok !== true) {
    reasons.push(
      `end identity is not exact: ${(end?.reasons ?? ["missing"]).join("; ")}`,
    );
  }
  if (start?.gitHead !== end?.gitHead) {
    reasons.push("git HEAD changed during the run");
  }
  const localStability = compareEvidenceFileSnapshots(
    start?.localIdentity,
    end?.localIdentity,
  );
  reasons.push(...localStability.reasons);
  const servedEntryIdentity = validateServedEntryIdentities({
    entries: options?.servedEntries,
    expectedLabels: ["webgl", "webgpu"],
    localEntry: start?.localIdentity?.buildEntry,
  });
  reasons.push(...servedEntryIdentity.reasons);
  if (
    !sameC1237Fingerprint(options?.historicalAtStart, options?.historicalAtEnd)
  ) {
    reasons.push("historical pre-lifecycle artifact changed during the run");
  }
  if (!sameC1237Fingerprint(options?.firstRedAtStart, options?.firstRedAtEnd)) {
    reasons.push("write-once first-red artifact changed during the run");
  }
  for (const renderer of ["webgl", "webgpu"]) {
    const matches = (options?.results ?? []).filter(
      (result) => result?.renderer === renderer,
    );
    if (matches.length !== 1 || !validGpuIdentity(matches[0])) {
      reasons.push(`${renderer}: renderer/adapter identity is incomplete`);
    }
  }
  return {
    ok: reasons.length === 0,
    reasons,
    localStability,
    servedEntryIdentity,
  };
}

function viewerUrl(renderer, includeSuppliedView) {
  const url = new URL(viewerPath, base);
  url.searchParams.set("renderer", renderer);
  url.searchParams.set("offline", "true");
  if (includeSuppliedView) {
    url.searchParams.set("view", suppliedView);
  }
  return url.href;
}

export function expectedC1237ContinuityKeys(
  repetitions = acceptanceBands.continuityRepetitions,
) {
  return Object.freeze(
    Array.from({ length: repetitions }, (_, index) => index + 1).flatMap(
      (repetition) =>
        ["entry", "exit"].flatMap((transition) =>
          ["raw", "first-frame"].map(
            (mode) => `${transition}-${mode}-r${repetition}`,
          ),
        ),
    ),
  );
}

function validC1237ImageFingerprint(value) {
  return (
    value?.exists === true &&
    Number.isInteger(value.byteLength) &&
    value.byteLength > 8 &&
    /^[0-9a-f]{64}$/u.test(value.sha256 ?? "") &&
    typeof value.file === "string" &&
    value.file.endsWith(".png")
  );
}

export function assessC1237ContinuityComparison(
  comparison,
  renderer,
  bands = acceptanceBands,
) {
  const reasons = [];
  const expectedReferencePhysical =
    comparison?.mode === "first-frame"
      ? comparison?.transition === "entry"
      : comparison?.transition === "exit";
  const expectedObservedPhysical = comparison?.transition === "entry";
  const referenceRoute = comparison?.routeProvenance?.reference;
  const observedRoute = comparison?.routeProvenance?.observed;
  const ordinaryPvs = (route) =>
    route?.moonShown === true &&
    route?.globeShown === true &&
    route?.globeVisible === true &&
    route?.globeClippingCollectionPresent !== true &&
    route?.globeExecutionFilterActive === false &&
    route?.globeExecutionFilterStrategy === "none" &&
    route?.depthPlaneSuppressed === false &&
    route?.moonOcclusionBypassActive === false &&
    route?.moonOcclusionBypassCalls === 0 &&
    route?.controlRestored === true;

  if (
    !["entry", "exit"].includes(comparison?.transition) ||
    !["raw", "first-frame"].includes(comparison?.mode) ||
    !Number.isInteger(comparison?.repetition) ||
    comparison.repetition < 1 ||
    comparison.repetition > bands.continuityRepetitions ||
    comparison.samePosition !== true ||
    !Number.isFinite(comparison?.fovDegrees) ||
    Math.abs(comparison.fovDegrees - explicitFovDegrees.diagnostic) > 1.0e-9
  ) {
    reasons.push(
      "comparison identity, repetition, position, or FOV is invalid",
    );
  }
  if (!ordinaryPvs(referenceRoute) || !ordinaryPvs(observedRoute)) {
    reasons.push("comparison changed Moon/globe visibility or clipping state");
  }
  if (
    !validC1237EmittedMoonRoute(referenceRoute) ||
    !validC1237EmittedMoonRoute(observedRoute)
  ) {
    reasons.push("comparison route did not emit exactly one valid Moon route");
  }
  if (
    referenceRoute?.actualPhysical !== expectedReferencePhysical ||
    observedRoute?.actualPhysical !== expectedObservedPhysical
  ) {
    reasons.push("comparison route provenance contradicts its transition");
  }
  const firstFrame = comparison?.mode === "first-frame";
  const expectedResetDeltas = {
    automatic: renderer === "webgpu" && firstFrame ? 1 : 0,
    manual: renderer === "webgpu" && firstFrame ? 1 : 0,
    enable:
      renderer === "webgpu" && firstFrame && comparison?.transition === "entry"
        ? 1
        : 0,
  };
  const validMeasuredResetDelta = (measurement, expected) =>
    Number.isInteger(measurement?.before) &&
    measurement.before >= 0 &&
    Number.isInteger(measurement?.after) &&
    measurement.after >= measurement.before &&
    Number.isInteger(measurement?.delta) &&
    measurement.delta === measurement.after - measurement.before &&
    measurement.delta === expected;
  if (
    !Object.entries(expectedResetDeltas).every(([kind, expected]) =>
      validMeasuredResetDelta(comparison?.resetDeltas?.[kind], expected),
    )
  ) {
    reasons.push("per-pair measured TAA reset deltas are invalid");
  }
  const referenceTaa = comparison?.taaState?.reference;
  const observedTaa = comparison?.taaState?.observed;
  const expectedSceneTaaEnabled = firstFrame;
  const expectedEffectTaaEnabled = renderer === "webgpu" && firstFrame;
  if (
    referenceTaa?.sceneEnabled !== expectedSceneTaaEnabled ||
    observedTaa?.sceneEnabled !== expectedSceneTaaEnabled ||
    referenceTaa?.effectEnabled !== expectedEffectTaaEnabled ||
    observedTaa?.effectEnabled !== expectedEffectTaaEnabled
  ) {
    reasons.push(
      firstFrame
        ? "first-frame pair did not measure an enabled TAA state"
        : "raw parity was not captured with TAA disabled",
    );
  }

  const mask = comparison?.mask;
  const regions = comparison?.regions;
  if (
    mask?.method !==
      "perspective-sphere-angular-radius+drawing-buffer-center" ||
    !(mask?.radiusPixels > bands.continuityAnnulusPixels * 2.0) ||
    mask?.annulusPixels !== bands.continuityAnnulusPixels ||
    !(mask?.analyticSamples >= bands.minimumSamples) ||
    !(mask?.unionSamples >= mask?.analyticSamples) ||
    !(mask?.referenceVisibleSamples >= bands.minimumSamples) ||
    !(mask?.observedVisibleSamples >= bands.minimumSamples) ||
    !Number.isInteger(mask?.observedOnlySamples) ||
    mask.observedOnlySamples < 0
  ) {
    reasons.push("analytic/visible union silhouette mask is vacuous");
  }
  for (const regionName of ["unionSilhouette", "annulus", "interior"]) {
    const region = regions?.[regionName];
    if (
      !(region?.sampleCount >= bands.minimumSamples) ||
      !(region?.errorP95 <= bands.winnerErrorP95) ||
      !Number.isInteger(region?.aboveBandCount) ||
      region.aboveBandCount < 0 ||
      !Number.isFinite(region?.aboveBandFraction) ||
      Math.abs(
        region.aboveBandFraction - region.aboveBandCount / region.sampleCount,
      ) > 1.0e-12
    ) {
      reasons.push(`${regionName} continuity score failed closed`);
    }
  }
  const histogram = comparison?.errorHistogram;
  const histogramNonzeroCount = Array.isArray(histogram)
    ? histogram
        .slice(1)
        .reduce(
          (sum, bin) => sum + (Number.isInteger(bin?.count) ? bin.count : 0),
          0,
        )
    : null;
  if (
    !Array.isArray(histogram) ||
    histogram.length !== bands.continuityHistogramEdges.length ||
    histogram.some(
      (bin, index) =>
        bin?.minimumExclusive !==
          (index === 0 ? -1 : bands.continuityHistogramEdges[index - 1]) ||
        bin?.maximumInclusive !== bands.continuityHistogramEdges[index] ||
        !Number.isInteger(bin?.count) ||
        bin.count < 0,
    ) ||
    histogram.reduce((sum, bin) => sum + bin.count, 0) !==
      regions?.unionSilhouette?.sampleCount
  ) {
    reasons.push("error histogram is absent or does not cover the union mask");
  }
  if (
    !Array.isArray(comparison?.errorLocations) ||
    comparison.errorLocations.length !==
      Math.min(32, histogramNonzeroCount ?? -1) ||
    comparison.errorLocations.length > 32 ||
    comparison.errorLocations.some(
      (location) =>
        !Number.isInteger(location?.x) ||
        location.x < 0 ||
        !Number.isInteger(location?.y) ||
        location.y < 0 ||
        !["annulus", "interior"].includes(location?.region) ||
        !(location?.error > 0 && location.error <= 765) ||
        !Array.isArray(location?.reference) ||
        location.reference.length !== 4 ||
        !Array.isArray(location?.observed) ||
        location.observed.length !== 4,
    ) ||
    comparison.errorLocations.some(
      (location, index, locations) =>
        index > 0 && location.error > locations[index - 1].error,
    )
  ) {
    reasons.push("worst-error location evidence is malformed");
  }
  if (
    !["reference", "observed", "diff"].every((kind) =>
      validC1237ImageFingerprint(comparison?.images?.[kind]),
    )
  ) {
    reasons.push("UUID-bound reference/observed/diff PNG evidence is absent");
  }
  if (comparison?.imageDataUrls !== undefined) {
    reasons.push("unpublished PNG data URLs leaked into final evidence");
  }
  return Object.freeze({ ok: reasons.length === 0, reasons });
}

export function validateC1237Backend(result, failures) {
  if (!result.ok) {
    failures.push(`${result.renderer}: ${result.error}`);
    return;
  }
  if (result.actualRenderer !== result.renderer) {
    failures.push(
      `${result.renderer}: requested backend resolved as ${result.actualRenderer}`,
    );
  }
  if (!result.preflight.fullyBehind || result.preflight.moonVisible) {
    failures.push(
      `${result.renderer}: supplied record stopped being STRUCTURAL/behind-camera`,
    );
  }
  if (result.consoleErrors.length > 0) {
    failures.push(
      `${result.renderer}: console errors: ${result.consoleErrors.join(" | ")}`,
    );
  }
  if (!validGpuIdentity(result)) {
    failures.push(
      `${result.renderer}: renderer/adapter identity is absent or incomplete`,
    );
  }
  if (result.renderer === "webgpu") {
    const deviceEvidence = result.webgpuDeviceEvidence;
    if (
      deviceEvidence?.applicable !== true ||
      deviceEvidence?.devicePresent !== true ||
      deviceEvidence?.uncapturedErrorListenerInstalledBeforeMeasurement !==
        true ||
      deviceEvidence?.deviceLostObserverInstalledBeforeMeasurement !== true ||
      deviceEvidence?.validationScopePushedBeforeMeasurement !== true ||
      deviceEvidence?.validationErrorCount !== 0 ||
      deviceEvidence?.validationErrors?.length !== 0 ||
      deviceEvidence?.uncapturedErrors?.length !== 0 ||
      deviceEvidence?.deviceLostDuringMeasurement !== false ||
      deviceEvidence?.queueDrainedAfterMeasurement !== true ||
      deviceEvidence?.postDrainEventTurn !== true
    ) {
      failures.push(
        `${result.renderer}: WebGPU validation/device-loss capture or post-measurement queue drain is incomplete`,
      );
    }
  }

  const overlaps = Array.isArray(result.overlaps) ? result.overlaps : [];
  const observedKeys = overlaps.map((lane) => lane?.key);
  const keyCounts = new Map();
  for (const key of observedKeys) {
    keyCounts.set(key, (keyCounts.get(key) ?? 0) + 1);
  }
  if (
    overlaps.length !== C12_37_EXPECTED_OVERLAP_KEYS.length ||
    C12_37_EXPECTED_OVERLAP_KEYS.some((key) => keyCounts.get(key) !== 1) ||
    observedKeys.some((key) => !C12_37_EXPECTED_OVERLAP_KEYS.includes(key))
  ) {
    failures.push(
      `${result.renderer}: expected exactly ${C12_37_EXPECTED_OVERLAP_KEYS.length} unique overlap lanes (${C12_37_EXPECTED_OVERLAP_KEYS.join(", ")}); observed ${observedKeys.join(", ")}`,
    );
  }
  for (const lane of overlaps) {
    if (!(lane.ray.moonDistance > 0.0 && lane.ray.earthDistance > 0.0)) {
      failures.push(`${result.renderer}/${lane.key}: center ray misses a body`);
      continue;
    }
    const moonWins = lane.fixture !== "earth-near";
    if (moonWins) {
      if (!(lane.ray.moonDistance < lane.ray.earthDistance)) {
        failures.push(`${result.renderer}/${lane.key}: Moon is not nearer`);
      }
      if (
        !lane.route.actualPhysical ||
        lane.route.uniquePhysicalCommands !== 1
      ) {
        failures.push(
          `${result.renderer}/${lane.key}: did not emit exactly one physical command`,
        );
      }
    } else {
      if (!(lane.ray.earthDistance < lane.ray.moonDistance)) {
        failures.push(`${result.renderer}/${lane.key}: Earth is not nearer`);
      }
      if (lane.route.actualPhysical) {
        failures.push(
          `${result.renderer}/${lane.key}: Earth-near lane left legacy route`,
        );
      }
    }
    const scores = lane.overlapScores;
    if (
      scores.geometricSampleCount < acceptanceBands.minimumSamples ||
      scores.scoredSampleCount < acceptanceBands.minimumSamples
    ) {
      failures.push(`${result.renderer}/${lane.key}: overlap mask is vacuous`);
    } else {
      if (scores.winnerCloserFraction < acceptanceBands.winnerCloserFraction) {
        failures.push(
          `${result.renderer}/${lane.key}: nearer-body score ${scores.winnerCloserFraction} < 0.95`,
        );
      }
      if (scores.winnerErrorP95 > acceptanceBands.winnerErrorP95) {
        failures.push(
          `${result.renderer}/${lane.key}: winner mismatch/halo p95 ${scores.winnerErrorP95} > 16`,
        );
      }
      if (scores.controlSeparationP50 < acceptanceBands.controlSeparation) {
        failures.push(
          `${result.renderer}/${lane.key}: winner/loser controls are not discriminating`,
        );
      }
    }
    if (lane.route.physicalCommands > lane.route.physicalFrustumExecutions) {
      failures.push(
        `${result.renderer}/${lane.key}: inconsistent frustum provenance`,
      );
    }
    if (
      !Number.isFinite(lane?.fovDegrees) ||
      Math.abs(lane.fovDegrees - explicitFovDegrees.normal) > 1.0e-9
    ) {
      failures.push(
        `${result.renderer}/${lane.key}: normal overlap FOV is not explicitly ${explicitFovDegrees.normal} degrees`,
      );
    }
    const controlAssessment = assessC1237RoutePreservingControls(
      lane.controlRoutes,
    );
    if (!controlAssessment.ok) {
      failures.push(
        `${result.renderer}/${lane.key}: route-preserving controls failed: ${controlAssessment.reasons.join("; ")}`,
      );
    }
  }

  const visibility = result.dualBodyNonOverlap;
  const assessedMoonPresence = assessC1237DualBodyMoonPresence(
    visibility?.moonPresenceEvidence,
  );
  if (
    visibility?.fixture !== "dual-body-non-overlap" ||
    !Number.isFinite(visibility?.fovDegrees) ||
    Math.abs(visibility.fovDegrees - explicitFovDegrees.dualBody) > 1.0e-9 ||
    visibility?.bothBodiesShown !== true ||
    !(
      Number.isFinite(visibility?.projectedSeparationPixels) &&
      visibility.projectedSeparationPixels >= 64
    ) ||
    visibility?.moonCommandPresent !== true ||
    assessedMoonPresence.present !== true ||
    visibility?.moonPresence?.present !== assessedMoonPresence.present ||
    visibility?.moonPresence?.route !== assessedMoonPresence.route ||
    visibility?.globeCommandPresent !== true ||
    visibility?.moonCenterRayHitsMoon !== true ||
    visibility?.earthCenterRayHitsEarth !== true ||
    visibility?.moonRegion?.sampleCount < acceptanceBands.minimumSamples ||
    visibility?.earthRegion?.sampleCount < acceptanceBands.minimumSamples ||
    visibility?.moonRegion?.combinedErrorP95 > acceptanceBands.winnerErrorP95 ||
    visibility?.earthRegion?.combinedErrorP95 >
      acceptanceBands.winnerErrorP95 ||
    visibility?.moonRegion?.separationP50 < acceptanceBands.controlSeparation ||
    visibility?.earthRegion?.separationP50 < acceptanceBands.controlSeparation
  ) {
    failures.push(
      `${result.renderer}: dual-body non-overlap PVS/visibility control is missing or non-discriminating`,
    );
  }
  const dualBodyControlAssessment = assessC1237RoutePreservingControls(
    visibility?.controlRoutes,
  );
  if (!dualBodyControlAssessment.ok) {
    failures.push(
      `${result.renderer}: dual-body route-preserving controls failed: ${dualBodyControlAssessment.reasons.join("; ")}`,
    );
  }

  const multifrustum = result.multifrustum;
  if (
    !Number.isFinite(multifrustum?.fovDegrees) ||
    Math.abs(multifrustum.fovDegrees - explicitFovDegrees.diagnostic) >
      1.0e-9 ||
    !multifrustum.route.actualPhysical ||
    multifrustum.route.uniquePhysicalCommands !== 1 ||
    multifrustum.route.activeFrustumCount < 2 ||
    multifrustum.route.physicalFrustumExecutions < 2 ||
    multifrustum.route.frusta.length < 2
  ) {
    failures.push(
      `${result.renderer}: forced inside-Moon multi-frustum route is vacuous`,
    );
  }
  const multifrustumControlAssessment = assessC1237RoutePreservingControls(
    multifrustum?.controlRoutes,
  );
  if (!multifrustumControlAssessment.ok) {
    failures.push(
      `${result.renderer}: multi-frustum route-preserving controls failed: ${multifrustumControlAssessment.reasons.join("; ")}`,
    );
  }
  if (!(multifrustum.ray.moonDistance > 0.0)) {
    failures.push(
      `${result.renderer}: inside-Moon exit surface is not visible`,
    );
  }
  const center = multifrustum.centerScore;
  if (
    !(center?.controlSeparation >= acceptanceBands.controlSeparation) ||
    !(center?.winnerError <= acceptanceBands.winnerErrorP95) ||
    !(center?.winnerError + acceptanceBands.winnerMargin <= center?.loserError)
  ) {
    failures.push(
      `${result.renderer}: inside-Moon center pixel does not match the visible Moon exit surface`,
    );
  }

  const crossing = result.crossing;
  const crossingSteps = Array.isArray(crossing?.steps) ? crossing.steps : [];
  const expectedCrossingLabels = [
    "beforePrewarm",
    "prewarm",
    "beforeEntry",
    "enter",
    "hold",
    "exit",
  ];
  const byLabel = Object.fromEntries(
    crossingSteps.map((step) => [step.label, step]),
  );
  if (
    crossingSteps.length !== expectedCrossingLabels.length ||
    expectedCrossingLabels.some(
      (label, index) =>
        crossingSteps[index]?.label !== label || byLabel[label] === undefined,
    ) ||
    !Number.isFinite(crossing?.fovDegrees) ||
    Math.abs(crossing.fovDegrees - explicitFovDegrees.diagnostic) > 1.0e-9
  ) {
    failures.push(
      `${result.renderer}: route crossing steps or diagnostic FOV are incomplete`,
    );
    return;
  }
  if (byLabel.beforePrewarm.prewarm || byLabel.prewarm.actualPhysical) {
    failures.push(`${result.renderer}: prewarm changed exact route ownership`);
  }
  if (!byLabel.enter.actualPhysical || !byLabel.hold.actualPhysical) {
    failures.push(
      `${result.renderer}: entry/hold hysteresis did not stay physical`,
    );
  }
  if (byLabel.exit.actualPhysical) {
    failures.push(
      `${result.renderer}: route did not exit beyond one lunar radius`,
    );
  }
  if (
    result.renderer === "webgpu" &&
    (!crossing.pipelineReadyBeforeEntry || crossing.pipelineFailed)
  ) {
    failures.push(
      `${result.renderer}: prewarm did not prepare physical pipeline`,
    );
  }
  const runtimeConfiguration = crossing?.runtimeConfiguration;
  if (
    result.renderer === "webgpu" &&
    (runtimeConfiguration?.requestedMsaaSamples !== 1 ||
      runtimeConfiguration?.effectiveMsaaSamplesAtStart !== 1 ||
      runtimeConfiguration?.effectiveMsaaSamplesAtEnd !== 1 ||
      !Number.isInteger(
        runtimeConfiguration?.pipelineFormatGenerationAtStart,
      ) ||
      runtimeConfiguration.pipelineFormatGenerationAtStart < 0 ||
      runtimeConfiguration?.pipelineFormatGenerationAtEnd !==
        runtimeConfiguration.pipelineFormatGenerationAtStart)
  ) {
    failures.push(
      `${result.renderer}: crossing MSAA or scene-pipeline generation was not pinned and stable`,
    );
  }
  const expectedAutomaticResets =
    result.renderer === "webgpu"
      ? acceptanceBands.continuityRepetitions * 2
      : 0;
  const expectedManualResets =
    result.renderer === "webgpu"
      ? acceptanceBands.continuityRepetitions * 2
      : 0;
  const expectedEnableResets =
    result.renderer === "webgpu" ? acceptanceBands.continuityRepetitions : 0;
  const expectedTotalResets =
    expectedAutomaticResets + expectedManualResets + expectedEnableResets;
  if (
    crossing.automaticTaaResetCount !== expectedAutomaticResets ||
    crossing.manualTaaResetCount !== expectedManualResets ||
    crossing.enableTaaResetCount !== expectedEnableResets ||
    crossing.taaResetCount !== expectedTotalResets
  ) {
    failures.push(
      `${result.renderer}: expected ${expectedAutomaticResets} automatic, ${expectedManualResets} manual, ${expectedEnableResets} enable, and ${expectedTotalResets} total TAA resets; observed ${crossing.automaticTaaResetCount}/${crossing.manualTaaResetCount}/${crossing.enableTaaResetCount}/${crossing.taaResetCount}`,
    );
  }
  if (result.renderer === "webgpu" && !crossing.taaEffectAvailable) {
    failures.push(
      `${result.renderer}: TAA effect was unavailable after settle`,
    );
  }
  const expectedPinnedJitterCalls =
    result.renderer === "webgpu"
      ? acceptanceBands.continuityRepetitions * 5
      : 0;
  if (
    (result.renderer === "webgpu" &&
      crossing.pinnedJitterFrameIndex !== 424_242) ||
    (result.renderer !== "webgpu" &&
      crossing.pinnedJitterFrameIndex !== null) ||
    crossing.pinnedJitterCallCount !== expectedPinnedJitterCalls
  ) {
    failures.push(
      `${result.renderer}: symmetric TAA jitter pinning is incomplete; frame/count ${crossing.pinnedJitterFrameIndex}/${crossing.pinnedJitterCallCount}`,
    );
  }
  const comparisons = Array.isArray(crossing.comparisons)
    ? crossing.comparisons
    : [];
  const expectedComparisonKeys = expectedC1237ContinuityKeys();
  const observedComparisonKeys = comparisons.map(
    (comparison) => comparison?.key,
  );
  const comparisonCounts = new Map();
  for (const key of observedComparisonKeys) {
    comparisonCounts.set(key, (comparisonCounts.get(key) ?? 0) + 1);
  }
  if (
    crossing.repetitionCount !== acceptanceBands.continuityRepetitions ||
    comparisons.length !== expectedComparisonKeys.length ||
    expectedComparisonKeys.some((key) => comparisonCounts.get(key) !== 1) ||
    observedComparisonKeys.some((key) => !expectedComparisonKeys.includes(key))
  ) {
    failures.push(
      `${result.renderer}: expected exactly ${expectedComparisonKeys.length} paired continuity comparisons (${expectedComparisonKeys.join(", ")}); observed ${observedComparisonKeys.join(",")}`,
    );
  }
  const measuredResetTotals = {
    automatic: 0,
    manual: 0,
    enable: 0,
  };
  let measuredResetTotalsValid = true;
  for (const comparison of comparisons) {
    for (const kind of Object.keys(measuredResetTotals)) {
      const delta = comparison?.resetDeltas?.[kind]?.delta;
      if (!Number.isInteger(delta) || delta < 0) {
        measuredResetTotalsValid = false;
      } else {
        measuredResetTotals[kind] += delta;
      }
    }
  }
  if (
    !measuredResetTotalsValid ||
    measuredResetTotals.automatic !== crossing.automaticTaaResetCount ||
    measuredResetTotals.manual !== crossing.manualTaaResetCount ||
    measuredResetTotals.enable !== crossing.enableTaaResetCount
  ) {
    failures.push(
      `${result.renderer}: per-pair measured TAA reset deltas do not aggregate to the published counters`,
    );
  }
  const imagePublications = Array.isArray(result.continuityImagePublications)
    ? result.continuityImagePublications
    : [];
  const imageVerification = Array.isArray(result.continuityImageVerification)
    ? result.continuityImageVerification
    : [];
  const expectedImageCount = expectedComparisonKeys.length * 3;
  const imageIdentity = (entry) =>
    `${entry?.comparisonKey}/${entry?.kind}/${entry?.sha256}`;
  const publishedIdentities = imagePublications.map(imageIdentity).sort();
  const verifiedIdentities = imageVerification.map(imageIdentity).sort();
  if (
    imagePublications.length !== expectedImageCount ||
    imageVerification.length !== expectedImageCount ||
    publishedIdentities.some(
      (identity, index) => identity !== verifiedIdentities[index],
    )
  ) {
    failures.push(
      `${result.renderer}: continuity PNG publication/verification set is incomplete or changed`,
    );
  }
  for (const comparison of comparisons) {
    const assessment = assessC1237ContinuityComparison(
      comparison,
      result.renderer,
    );
    if (!assessment.ok) {
      failures.push(
        `${result.renderer}/${comparison?.key ?? "unknown"}: continuity failed: ${assessment.reasons.join("; ")}`,
      );
    }
  }
}

function describeC1237Error(error) {
  return error?.stack ?? error?.message ?? String(error);
}

async function closeC1237Browser(control, reason) {
  if (!control.browser) {
    return control.browserClosed;
  }
  if (!control.browserClosePromise) {
    const browserHandle = control.browser;
    control.browserCloseAttempted = true;
    control.browserClosePromise = control.tracker
      .run(
        async () => {
          await browserHandle.close();
          control.browser = null;
          control.browserClosed = true;
        },
        control.timeouts.browserClose,
        `browser.close (${reason})`,
      )
      .then(
        () => true,
        (error) => {
          control.cleanupErrors.push({
            scope: "browser",
            operation: "browser.close",
            reason,
            error: error?.message ?? String(error),
          });
          return false;
        },
      );
  }
  return control.browserClosePromise;
}

/**
 * Bound the complete measurement, close the browser on expiry, and prove that
 * the losing measurement task has settled before permitting publication.
 */
export async function withC1237Watchdog(
  task,
  control,
  hardLimitMs,
  losingTaskDrainMs,
) {
  if (!(Number.isFinite(hardLimitMs) && hardLimitMs > 0)) {
    throw new Error(
      "C12-37 hard watchdog duration must be finite and positive",
    );
  }
  if (!(Number.isFinite(losingTaskDrainMs) && losingTaskDrainMs > 0)) {
    throw new Error(
      "C12-37 losing-task drain duration must be finite and positive",
    );
  }
  const observed = Promise.resolve(task).then(
    (value) => ({ kind: "fulfilled", value }),
    (error) => ({ kind: "rejected", error }),
  );
  let timer;
  const winner = await Promise.race([
    observed,
    new Promise((resolve) => {
      timer = setTimeout(() => resolve({ kind: "watchdog" }), hardLimitMs);
    }),
  ]);
  clearTimeout(timer);

  if (winner.kind === "fulfilled") {
    control.measurementTaskDrained = true;
    return winner.value;
  }
  if (winner.kind === "rejected") {
    control.measurementTaskDrained = true;
    throw winner.error;
  }

  control.watchdogTimedOut = true;
  control.watchdogCloseAttempted = control.browser !== null;
  control.abortController.abort(
    new C1237TimeoutError("C12-37 whole-probe watchdog", hardLimitMs),
  );
  await closeC1237Browser(control, "whole-probe watchdog");

  let losingOutcome;
  try {
    losingOutcome = await boundedC1237Promise(
      observed,
      losingTaskDrainMs,
      "C12-37 losing measurement task drain",
    );
    control.measurementTaskDrained = true;
  } catch (error) {
    throw new C1237UnsettledOperationsError(
      "C12-37 watchdog could not drain the losing measurement task; RUNNING must remain canonical",
      {
        cause: error?.message ?? String(error),
        tracker: control.tracker.snapshot(),
      },
    );
  }
  const detail =
    losingOutcome.kind === "rejected"
      ? `; drained task error: ${losingOutcome.error?.message ?? String(losingOutcome.error)}`
      : "; drained task after timeout";
  throw new C1237TimeoutError(
    `C12-37 whole-probe watchdog${detail}`,
    hardLimitMs,
  );
}

async function runBackend(
  browser,
  renderer,
  { tracker, timeouts, cleanupErrors, signal },
) {
  let context;
  let page;
  const consoleErrors = [];
  try {
    signal.throwIfAborted();
    context = await tracker.run(
      () => browser.newContext({ viewport }),
      timeouts.newContext,
      `${renderer} browser.newContext`,
      {
        onLateFulfilled: (lateContext) => lateContext.close(),
      },
    );
    signal.throwIfAborted();
    page = await tracker.run(
      () => context.newPage(),
      timeouts.newPage,
      `${renderer} context.newPage`,
    );
    let runtimeEntryCaptured = false;
    const runtimeEntryPromise = new Promise((resolve, reject) => {
      page.on("response", (response) => {
        let pathname;
        try {
          pathname = new URL(response.url()).pathname;
        } catch {
          return;
        }
        if (
          runtimeEntryCaptured ||
          pathname !== "/Build/CesiumUnminified/index.js"
        ) {
          return;
        }
        runtimeEntryCaptured = true;
        void response.body().then(
          (bytes) =>
            resolve({
              sessionLabel: renderer,
              url: response.url(),
              ok: response.ok(),
              status: response.status(),
              byteLength: bytes.byteLength,
              sha256: sha256(bytes),
            }),
          reject,
        );
      });
      page.once("close", () => {
        if (!runtimeEntryCaptured) {
          reject(
            new Error(
              `${renderer} page closed before served runtime identity was captured`,
            ),
          );
        }
      });
    });
    page.on("console", (message) => {
      if (message.type() === "error") {
        consoleErrors.push(message.text().slice(0, 300));
      }
    });
    page.on("pageerror", (error) => {
      consoleErrors.push(
        `pageerror: ${String(error?.message ?? error).slice(0, 300)}`,
      );
    });

    signal.throwIfAborted();
    await tracker.run(
      () =>
        page.goto(viewerUrl(renderer, true), {
          waitUntil: "domcontentloaded",
          timeout: 90_000,
        }),
      timeouts.navigation,
      `${renderer} page.goto`,
    );
    await tracker.run(
      () =>
        page.waitForFunction(
          () => Boolean(window.viewer?.scene?.context),
          null,
          { timeout: 90_000 },
        ),
      timeouts.viewerReady,
      `${renderer} viewer readiness`,
    );
    signal.throwIfAborted();

    const result = await tracker.run(
      () =>
        page.evaluate(
          async ({
            pinnedIso,
            settleBudgetMs,
            settleMinimumFrames,
            renderer,
            acceptanceBands,
            explicitFovDegrees,
          }) => {
            const C = await import("/Build/CesiumUnminified/index.js");
            const viewer = window.viewer;
            const scene = viewer.scene;
            const device = scene.context.device ?? scene.context._device;
            const webgpuDeviceEvidence = {
              applicable: renderer === "webgpu",
              devicePresent: Boolean(device),
              uncapturedErrorListenerInstalledBeforeMeasurement: false,
              deviceLostObserverInstalledBeforeMeasurement: false,
              validationScopePushedBeforeMeasurement: false,
              validationErrorCount: 0,
              validationErrors: [],
              uncapturedErrors: [],
              deviceLostDuringMeasurement: false,
              deviceLostInfo: null,
              queueDrainedAfterMeasurement: false,
              postDrainEventTurn: false,
            };
            const onUncapturedError = (event) => {
              webgpuDeviceEvidence.uncapturedErrors.push(
                event?.error?.message ?? String(event?.error),
              );
            };
            if (renderer === "webgpu" && device) {
              device.addEventListener("uncapturederror", onUncapturedError);
              webgpuDeviceEvidence.uncapturedErrorListenerInstalledBeforeMeasurement = true;
              void device.lost.then((info) => {
                webgpuDeviceEvidence.deviceLostDuringMeasurement = true;
                webgpuDeviceEvidence.deviceLostInfo = {
                  reason: info?.reason ?? "unknown",
                  message: info?.message ?? "",
                };
              });
              webgpuDeviceEvidence.deviceLostObserverInstalledBeforeMeasurement = true;
              device.pushErrorScope("validation");
              webgpuDeviceEvidence.validationScopePushedBeforeMeasurement = true;
            }
            const pinnedTime = C.JulianDate.fromIso8601(pinnedIso);
            viewer.useDefaultRenderLoop = false;
            viewer.clock.shouldAnimate = false;
            viewer.clock.currentTime = C.JulianDate.clone(pinnedTime);
            scene.requestRenderMode = false;

            await C.Transforms.preloadIcrfFixed(
              new C.TimeInterval({
                start: pinnedTime,
                stop: C.JulianDate.addSeconds(
                  pinnedTime,
                  1.0,
                  new C.JulianDate(),
                ),
              }),
            );

            const render = () => scene.render(viewer.clock.currentTime);
            const settle = async () => {
              const start = performance.now();
              let frames = 0;
              while (
                performance.now() - start < settleBudgetMs ||
                frames < settleMinimumFrames
              ) {
                render();
                frames++;
                await new Promise((resolve) => setTimeout(resolve, 16));
              }
              return frames;
            };
            const xyz = (value) => ({ x: value.x, y: value.y, z: value.z });
            const magnitude = (value) => C.Cartesian3.magnitude(value);
            const angleDegrees = (a, b) =>
              C.Math.toDegrees(C.Cartesian3.angleBetween(a, b));
            const aimCamera = (position, direction) => {
              const seed =
                Math.abs(direction.z) < 0.9
                  ? C.Cartesian3.UNIT_Z
                  : C.Cartesian3.UNIT_X;
              const right = C.Cartesian3.normalize(
                C.Cartesian3.cross(direction, seed, new C.Cartesian3()),
                new C.Cartesian3(),
              );
              const up = C.Cartesian3.normalize(
                C.Cartesian3.cross(right, direction, new C.Cartesian3()),
                new C.Cartesian3(),
              );
              scene.camera.setView({
                destination: position,
                orientation: { direction, up },
              });
              // Repair Camera.setView's local-ENU gimbal-lock round trip. The
              // applied world basis is the oracle, not the reconstructed HPR.
              C.Cartesian3.clone(direction, scene.camera.direction);
              C.Cartesian3.clone(up, scene.camera.up);
              C.Cartesian3.clone(right, scene.camera.right);
              return angleDegrees(direction, scene.camera.directionWC);
            };
            const setExplicitFov = (degrees) => {
              scene.camera.frustum.fov = C.Math.toRadians(degrees);
              return C.Math.toDegrees(scene.camera.frustum.fov);
            };
            const moonCenter = () =>
              C.Matrix4.getTranslation(
                scene.moon._ellipsoidPrimitive.modelMatrix,
                new C.Cartesian3(),
              );

            // The user record is provenance only. Settle ICRF and prove the entire
            // sphere is behind this exact decoded camera before deriving fixtures.
            for (let i = 0; i < 20; i++) {
              render();
              await new Promise((resolve) => setTimeout(resolve, 25));
            }
            const suppliedMoon = moonCenter();
            const suppliedDelta = C.Cartesian3.subtract(
              suppliedMoon,
              scene.camera.positionWC,
              new C.Cartesian3(),
            );
            const suppliedForward = C.Cartesian3.dot(
              suppliedDelta,
              scene.camera.directionWC,
            );
            const preflight = {
              cameraPositionWC: xyz(scene.camera.positionWC),
              cameraMagnitude: magnitude(scene.camera.positionWC),
              cameraHeight: scene.camera.positionCartographic.height,
              cameraDirectionWC: xyz(scene.camera.directionWC),
              moonCenterWC: xyz(suppliedMoon),
              moonMagnitude: magnitude(suppliedMoon),
              cameraMoonDistance: magnitude(suppliedDelta),
              dotForward: suppliedForward,
              angleFromViewCenterDegrees: angleDegrees(
                suppliedDelta,
                scene.camera.directionWC,
              ),
              fullyBehind:
                suppliedForward < -scene.moon.ellipsoid.maximumRadius,
              moonVisible: scene._environmentState?.isMoonVisible === true,
            };

            // Deterministic bare-body oracle. Flags are pinned in both directions
            // per lane below; this setup only removes unrelated emitters/effects.
            scene.backgroundColor = C.Color.BLACK;
            scene.globe.show = true;
            scene.globe.depthTestAgainstTerrain = false;
            scene.globe.imageryLayers.removeAll();
            scene.globe.baseColor = new C.Color(0.06, 0.18, 0.35, 1.0);
            scene.moon.show = true;
            scene.sun.show = false;
            if (scene.skyBox) scene.skyBox.show = false;
            if (scene.skyAtmosphere) scene.skyAtmosphere.show = false;
            if (scene.fog) scene.fog.enabled = false;
            if (scene.postProcessStages?.fxaa) {
              scene.postProcessStages.fxaa.enabled = false;
            }
            scene.taaEnabled = false;
            render();
            const liveMoon = C.Cartesian3.clone(
              moonCenter(),
              new C.Cartesian3(),
            );
            const moonAxis = C.Cartesian3.normalize(
              liveMoon,
              new C.Cartesian3(),
            );
            const moonRadius = scene.moon.ellipsoid.maximumRadius;
            const earthRadius = scene.ellipsoid.maximumRadius;
            const moonMagnitude = magnitude(liveMoon);
            if (scene.globe.clippingPlanes) {
              throw new Error(
                "STRUCTURAL: viewer started with an unexpected globe clipping collection",
              );
            }
            if (scene.debugCommandFilter !== undefined) {
              throw new Error(
                "STRUCTURAL: viewer started with an unexpected debug command filter",
              );
            }
            if (scene.debugSkipDepthPlane === true) {
              throw new Error(
                "STRUCTURAL: viewer started with the depth plane disabled",
              );
            }

            // The Moon-only visual control must leave globe.show and
            // frameState.globeVisible true because both participate in physical
            // route eligibility. A ClippingPlaneCollection cannot be used here:
            // WebGPU owns a non-WebGL clipping texture whose collection teardown
            // calls a nonexistent `.destroy()`. Instead, reject only rendered
            // globe-tile commands at the backend-neutral debug execution hook,
            // disable the matching depth plane, and bypass CPU Earth occlusion
            // only for the legacy Moon command during that bounded control.
            let activeGlobeSuppressionControl = null;
            const beginGlobeSuppressedMoonControl = () => {
              if (activeGlobeSuppressionControl !== null) {
                throw new Error(
                  "STRUCTURAL: nested globe suppression control is not allowed",
                );
              }
              if (scene.globe.clippingPlanes) {
                throw new Error(
                  "STRUCTURAL: globe clipping collection appeared before suppression control",
                );
              }
              const state = {
                originalDebugCommandFilter: scene.debugCommandFilter,
                originalDebugSkipDepthPlane: scene.debugSkipDepthPlane,
                originalSceneIsVisible: scene.isVisible,
                originalSceneIsVisibleDescriptor:
                  Object.getOwnPropertyDescriptor(scene, "isVisible"),
                selectedGlobeTiles: new Set(
                  scene.globe._surface._tilesRenderedThisFrame,
                ),
                globeCommandsSeen: 0,
                globeCommandsRejected: 0,
                globeCommandsAccepted: 0,
                moonOcclusionBypassCalls: 0,
              };
              scene.debugSkipDepthPlane = true;
              scene.debugCommandFilter = (command) => {
                const isRenderedGlobeTile =
                  state.selectedGlobeTiles.has(command?.owner) ||
                  scene.globe?._surface?._tilesRenderedThisFrame?.has(
                    command?.owner,
                  ) === true;
                if (isRenderedGlobeTile) {
                  state.globeCommandsSeen++;
                  state.globeCommandsRejected++;
                  return false;
                }
                return true;
              };
              scene.isVisible = function (cullingVolume, command, occluder) {
                if (
                  command?.owner === scene.moon &&
                  command?._moonPhysicalDepthRoute !== true
                ) {
                  state.moonOcclusionBypassCalls++;
                  return state.originalSceneIsVisible.call(
                    this,
                    cullingVolume,
                    command,
                    undefined,
                  );
                }
                return state.originalSceneIsVisible.call(
                  this,
                  cullingVolume,
                  command,
                  occluder,
                );
              };
              activeGlobeSuppressionControl = state;
              return state;
            };
            const restoreGlobeSuppressedMoonControl = (state) => {
              if (activeGlobeSuppressionControl !== state) {
                throw new Error(
                  "STRUCTURAL: globe suppression control lost ownership",
                );
              }
              scene.debugCommandFilter = state.originalDebugCommandFilter;
              scene.debugSkipDepthPlane = state.originalDebugSkipDepthPlane;
              if (state.originalSceneIsVisibleDescriptor === undefined) {
                delete scene.isVisible;
              } else {
                Object.defineProperty(
                  scene,
                  "isVisible",
                  state.originalSceneIsVisibleDescriptor,
                );
              }
              activeGlobeSuppressionControl = null;
              const restoredSceneIsVisibleDescriptor =
                Object.getOwnPropertyDescriptor(scene, "isVisible");
              return (
                scene.debugCommandFilter === state.originalDebugCommandFilter &&
                scene.debugSkipDepthPlane ===
                  state.originalDebugSkipDepthPlane &&
                scene.isVisible === state.originalSceneIsVisible &&
                restoredSceneIsVisibleDescriptor?.value ===
                  state.originalSceneIsVisibleDescriptor?.value &&
                restoredSceneIsVisibleDescriptor?.get ===
                  state.originalSceneIsVisibleDescriptor?.get &&
                restoredSceneIsVisibleDescriptor?.set ===
                  state.originalSceneIsVisibleDescriptor?.set &&
                restoredSceneIsVisibleDescriptor?.writable ===
                  state.originalSceneIsVisibleDescriptor?.writable &&
                restoredSceneIsVisibleDescriptor?.enumerable ===
                  state.originalSceneIsVisibleDescriptor?.enumerable &&
                restoredSceneIsVisibleDescriptor?.configurable ===
                  state.originalSceneIsVisibleDescriptor?.configurable &&
                scene.globe.clippingPlanes === undefined
              );
            };

            function makeFixture(name) {
              if (name === "moon-near") {
                return {
                  position: C.Cartesian3.add(
                    liveMoon,
                    C.Cartesian3.multiplyByScalar(
                      moonAxis,
                      20_000_000.0,
                      new C.Cartesian3(),
                    ),
                    new C.Cartesian3(),
                  ),
                  direction: C.Cartesian3.negate(moonAxis, new C.Cartesian3()),
                };
              }
              if (name === "moon-inside-multifrustum") {
                return {
                  position: C.Cartesian3.clone(liveMoon, new C.Cartesian3()),
                  direction: C.Cartesian3.negate(moonAxis, new C.Cartesian3()),
                };
              }
              return {
                position: C.Cartesian3.multiplyByScalar(
                  moonAxis,
                  -(earthRadius + 20_000_000.0),
                  new C.Cartesian3(),
                ),
                direction: C.Cartesian3.clone(moonAxis, new C.Cartesian3()),
              };
            }

            function positiveHitDistance(interval) {
              if (interval?.start > 1.0e-6) return interval.start;
              if (interval?.stop > 1.0e-6) return interval.stop;
              return null;
            }

            function pixelRayOracle(canvasX, canvasY) {
              const canvas = scene.canvas;
              const pixel = new C.Cartesian2(
                ((canvasX + 0.5) / canvas.width) * canvas.clientWidth,
                ((canvasY + 0.5) / canvas.height) * canvas.clientHeight,
              );
              const ray = scene.camera.getPickRay(pixel, new C.Ray());
              const earthInterval = C.IntersectionTests.rayEllipsoid(
                ray,
                scene.ellipsoid,
              );
              const inverseMoon = C.Matrix4.inverseTransformation(
                scene.moon._ellipsoidPrimitive.modelMatrix,
                new C.Matrix4(),
              );
              const moonRay = new C.Ray(
                C.Matrix4.multiplyByPoint(
                  inverseMoon,
                  ray.origin,
                  new C.Cartesian3(),
                ),
                C.Cartesian3.normalize(
                  C.Matrix4.multiplyByPointAsVector(
                    inverseMoon,
                    ray.direction,
                    new C.Cartesian3(),
                  ),
                  new C.Cartesian3(),
                ),
              );
              const moonInterval = C.IntersectionTests.rayEllipsoid(
                moonRay,
                scene.moon.ellipsoid,
              );
              return {
                earthDistance: positiveHitDistance(earthInterval),
                moonDistance: positiveHitDistance(moonInterval),
              };
            }

            function centerRayOracle() {
              return pixelRayOracle(
                scene.canvas.width * 0.5,
                scene.canvas.height * 0.5,
              );
            }

            function commandProvenance() {
              const frameCommands = scene.frameState.commandList.filter(
                (command) => command?._moonPhysicalDepthRoute === true,
              );
              const identities = new Set(frameCommands);
              let physicalFrustumExecutions = 0;
              const frusta = [];
              for (const frustum of scene._view.frustumCommandsList) {
                const storedCommands = frustum.commands[C.Pass.OPAQUE] ?? [];
                const activeCount = frustum.indices[C.Pass.OPAQUE] ?? 0;
                const count = storedCommands
                  .slice(0, activeCount)
                  .filter(
                    (command) => command?._moonPhysicalDepthRoute === true,
                  ).length;
                physicalFrustumExecutions += count;
                if (count > 0) {
                  frusta.push({ near: frustum.near, far: frustum.far, count });
                }
              }
              const slots = scene.moon._webgpuCache?.physicalUniformSlots ?? [];
              const legacyMoonCommand = scene._environmentState?.moonCommand;
              const suppression = activeGlobeSuppressionControl;
              return {
                moonShown: scene.moon.show === true,
                globeShown: scene.globe.show === true,
                globeVisible: scene.frameState.globeVisible === true,
                globeClippingCollectionPresent:
                  scene.globe.clippingPlanes !== undefined,
                globeExecutionFilterActive: suppression !== null,
                globeExecutionFilterStrategy:
                  suppression === null
                    ? "none"
                    : "debug-command-filter:rendered-globe-tile-owner",
                depthPlaneSuppressed:
                  suppression !== null && scene.debugSkipDepthPlane === true,
                globeCommandsSeen: suppression?.globeCommandsSeen ?? 0,
                globeCommandsRejected: suppression?.globeCommandsRejected ?? 0,
                globeCommandsAccepted: suppression?.globeCommandsAccepted ?? 0,
                moonOcclusionBypassActive: suppression !== null,
                moonOcclusionBypassCalls:
                  suppression?.moonOcclusionBypassCalls ?? 0,
                controlRestored: false,
                distanceDemand:
                  scene.moon._physicalDepthDistanceDemand === true,
                prewarm: scene.moon._physicalDepthPrewarmRequested === true,
                requested: scene.moon._physicalDepthRequested === true,
                actualPhysical: scene.moon._physicalDepthActual === true,
                routeChanged:
                  scene.frameState._moonPhysicalDepthRouteChanged === true,
                physicalCommands: frameCommands.length,
                uniquePhysicalCommands: identities.size,
                physicalFrustumExecutions,
                legacyCommandPresent: legacyMoonCommand?.owner === scene.moon,
                legacyVisible: scene._environmentState?.isMoonVisible === true,
                activeFrustumCount: scene._view.frustumCommandsList.length,
                frusta,
                slots: slots
                  .slice(0, physicalFrustumExecutions)
                  .map((slot) => ({
                    useLogDepth: slot.uniformData[69] === 1.0,
                    encodeFar: slot.uniformData[72],
                    encodeNear: slot.uniformData[73],
                    encodeFactor: slot.uniformData[74],
                    packedGlobeDepthMode: slot.uniformData[75],
                  })),
              };
            }

            function markOrdinaryControlRestored(route) {
              route.controlRestored =
                activeGlobeSuppressionControl === null &&
                scene.debugCommandFilter === undefined &&
                scene.debugSkipDepthPlane !== true &&
                scene.globe.clippingPlanes === undefined;
              return route;
            }

            function quantile(values, percentile) {
              if (values.length === 0) return null;
              const sorted = values.slice().sort((a, b) => a - b);
              return sorted[Math.floor((sorted.length - 1) * percentile)];
            }

            function captureRegionSameTask(size = 193, renderFirst = true) {
              if (renderFirst) render();
              const canvas = scene.canvas;
              const copy = document.createElement("canvas");
              copy.width = canvas.width;
              copy.height = canvas.height;
              const context = copy.getContext("2d", {
                willReadFrequently: true,
              });
              context.drawImage(canvas, 0, 0);
              const width = Math.min(size, canvas.width);
              const height = Math.min(size, canvas.height);
              const x = Math.floor((canvas.width - width) * 0.5);
              const y = Math.floor((canvas.height - height) * 0.5);
              return {
                x,
                y,
                width,
                height,
                pixels: context.getImageData(x, y, width, height).data,
              };
            }

            function captureMoonWithSuppressedGlobe(size = 193) {
              const state = beginGlobeSuppressedMoonControl();
              let capture;
              let route;
              let restored;
              try {
                for (let i = 0; i < 4; i++) render();
                capture = captureRegionSameTask(size);
                route = commandProvenance();
              } finally {
                restored = restoreGlobeSuppressedMoonControl(state);
                if (route) route.controlRestored = restored;
              }
              if (!restored) {
                throw new Error(
                  "STRUCTURAL: globe suppression control did not restore exact scene state",
                );
              }
              return { capture, route };
            }

            function capturePngDataUrl(capture) {
              const canvas = document.createElement("canvas");
              canvas.width = capture.width;
              canvas.height = capture.height;
              const context = canvas.getContext("2d");
              context.putImageData(
                new ImageData(
                  new Uint8ClampedArray(capture.pixels),
                  capture.width,
                  capture.height,
                ),
                0,
                0,
              );
              return canvas.toDataURL("image/png");
            }

            function rgbL1(a, b, index) {
              return (
                Math.abs(a[index] - b[index]) +
                Math.abs(a[index + 1] - b[index + 1]) +
                Math.abs(a[index + 2] - b[index + 2])
              );
            }

            function centerRgb(capture) {
              const x = Math.floor(capture.width * 0.5);
              const y = Math.floor(capture.height * 0.5);
              const index = (y * capture.width + x) * 4;
              return Array.from(capture.pixels.slice(index, index + 4));
            }

            function scoreCenter(combined, winner, loser) {
              const combinedCenter = centerRgb(combined);
              const winnerCenter = centerRgb(winner);
              const loserCenter = centerRgb(loser);
              return {
                combined: combinedCenter,
                winner: winnerCenter,
                loser: loserCenter,
                winnerError: rgbL1(combinedCenter, winnerCenter, 0),
                loserError: rgbL1(combinedCenter, loserCenter, 0),
                controlSeparation: rgbL1(winnerCenter, loserCenter, 0),
              };
            }

            function projectedMoonSilhouette(capture) {
              const windowCenter =
                C.SceneTransforms.worldToDrawingBufferCoordinates(
                  scene,
                  liveMoon,
                  new C.Cartesian2(),
                );
              const cameraToMoon = C.Cartesian3.distance(
                scene.camera.positionWC,
                liveMoon,
              );
              const angularRadius = Math.asin(
                Math.min(1.0, moonRadius / cameraToMoon),
              );
              const radiusPixels =
                (Math.tan(angularRadius) /
                  Math.tan(scene.camera.frustum.fovy * 0.5)) *
                (scene.canvas.height * 0.5);
              return {
                centerX: windowCenter.x - capture.x,
                centerY: windowCenter.y - capture.y,
                radiusPixels,
                annulusPixels: acceptanceBands.continuityAnnulusPixels,
                method:
                  "perspective-sphere-angular-radius+drawing-buffer-center",
              };
            }

            function summarizeContinuityErrors(errors) {
              const aboveBandCount = errors.filter(
                (error) => error > acceptanceBands.winnerErrorP95,
              ).length;
              return {
                sampleCount: errors.length,
                errorP50: quantile(errors, 0.5),
                errorP95: quantile(errors, 0.95),
                errorMax: errors.length > 0 ? Math.max(...errors) : null,
                aboveBandCount,
                aboveBandFraction:
                  errors.length > 0 ? aboveBandCount / errors.length : null,
              };
            }

            function continuityHistogram(errors) {
              const edges = acceptanceBands.continuityHistogramEdges;
              return edges.map((maximum, index) => ({
                minimumExclusive: index === 0 ? -1 : edges[index - 1],
                maximumInclusive: maximum,
                count: errors.filter(
                  (error) =>
                    error <= maximum &&
                    (index === 0 || error > edges[index - 1]),
                ).length,
              }));
            }

            function scoreContinuityPair(
              reference,
              observed,
              { emitImages = false } = {},
            ) {
              if (
                reference.width !== observed.width ||
                reference.height !== observed.height ||
                reference.x !== observed.x ||
                reference.y !== observed.y
              ) {
                throw new Error(
                  "STRUCTURAL: continuity pair did not use the same crop",
                );
              }
              const silhouette = projectedMoonSilhouette(reference);
              const radius = silhouette.radiusPixels;
              const annulus = silhouette.annulusPixels;
              if (!(Number.isFinite(radius) && radius > annulus * 2.0)) {
                throw new Error(
                  "STRUCTURAL: diagnostic Moon silhouette is too small for annulus/interior scoring",
                );
              }
              const unionErrors = [];
              const annulusErrors = [];
              const interiorErrors = [];
              const locations = [];
              const diffPixels = new Uint8ClampedArray(reference.pixels.length);
              let analyticSamples = 0;
              let referenceVisibleSamples = 0;
              let observedVisibleSamples = 0;
              let observedOnlySamples = 0;

              for (let y = 0; y < reference.height; y++) {
                for (let x = 0; x < reference.width; x++) {
                  const index = (y * reference.width + x) * 4;
                  const dx = x + 0.5 - silhouette.centerX;
                  const dy = y + 0.5 - silhouette.centerY;
                  const distance = Math.hypot(dx, dy);
                  const analytic = distance <= radius;
                  const analyticAnnulus =
                    distance >= radius - annulus &&
                    distance <= radius + annulus;
                  const referenceEnergy =
                    reference.pixels[index] +
                    reference.pixels[index + 1] +
                    reference.pixels[index + 2];
                  const observedEnergy =
                    observed.pixels[index] +
                    observed.pixels[index + 1] +
                    observed.pixels[index + 2];
                  const referenceVisible =
                    referenceEnergy >= acceptanceBands.controlSeparation;
                  const observedVisible =
                    observedEnergy >= acceptanceBands.controlSeparation;
                  // The union includes the analytic disc and every visible
                  // pixel from either capture. Thus an observed-only halo is
                  // scored instead of disappearing behind a reference mask.
                  const inUnion =
                    analytic || referenceVisible || observedVisible;
                  if (!inUnion) continue;
                  if (analytic) analyticSamples++;
                  if (referenceVisible) referenceVisibleSamples++;
                  if (observedVisible) observedVisibleSamples++;
                  if (observedVisible && !referenceVisible) {
                    observedOnlySamples++;
                  }
                  const error = rgbL1(reference.pixels, observed.pixels, index);
                  unionErrors.push(error);
                  const region =
                    analytic && !analyticAnnulus ? "interior" : "annulus";
                  (region === "interior" ? interiorErrors : annulusErrors).push(
                    error,
                  );
                  if (error > 0) {
                    locations.push({
                      x: reference.x + x,
                      y: reference.y + y,
                      region,
                      distanceFromAnalyticLimbPixels: distance - radius,
                      error,
                      reference: Array.from(
                        reference.pixels.slice(index, index + 4),
                      ),
                      observed: Array.from(
                        observed.pixels.slice(index, index + 4),
                      ),
                    });
                  }
                  diffPixels[index] = Math.abs(
                    reference.pixels[index] - observed.pixels[index],
                  );
                  diffPixels[index + 1] = Math.abs(
                    reference.pixels[index + 1] - observed.pixels[index + 1],
                  );
                  diffPixels[index + 2] = Math.abs(
                    reference.pixels[index + 2] - observed.pixels[index + 2],
                  );
                  diffPixels[index + 3] = 255;
                }
              }
              locations.sort(
                (left, right) =>
                  right.error - left.error ||
                  left.y - right.y ||
                  left.x - right.x,
              );
              const score = {
                mask: {
                  ...silhouette,
                  analyticSamples,
                  referenceVisibleSamples,
                  observedVisibleSamples,
                  observedOnlySamples,
                  unionSamples: unionErrors.length,
                },
                regions: {
                  unionSilhouette: summarizeContinuityErrors(unionErrors),
                  annulus: summarizeContinuityErrors(annulusErrors),
                  interior: summarizeContinuityErrors(interiorErrors),
                },
                errorHistogram: continuityHistogram(unionErrors),
                errorLocations: locations.slice(0, 32),
              };
              if (emitImages) {
                score.imageDataUrls = {
                  reference: capturePngDataUrl(reference),
                  observed: capturePngDataUrl(observed),
                  diff: capturePngDataUrl({
                    ...reference,
                    pixels: diffPixels,
                  }),
                };
              }
              return score;
            }

            function scoreOverlap(combined, earthOnly, moonOnly, moonWins) {
              const winner = moonWins ? moonOnly.pixels : earthOnly.pixels;
              const loser = moonWins ? earthOnly.pixels : moonOnly.pixels;
              const winnerErrors = [];
              const loserErrors = [];
              const controlSeparations = [];
              let geometricSampleCount = 0;
              let winnerCloserCount = 0;

              for (let y = 0; y < combined.height; y++) {
                for (let x = 0; x < combined.width; x++) {
                  const ray = pixelRayOracle(combined.x + x, combined.y + y);
                  if (
                    !Number.isFinite(ray.moonDistance) ||
                    !Number.isFinite(ray.earthDistance)
                  ) {
                    continue;
                  }
                  geometricSampleCount++;
                  const index = (y * combined.width + x) * 4;
                  const separation = rgbL1(winner, loser, index);
                  // Only score pixels whose single-body controls can distinguish
                  // the winner. Geometry still records every overlap pixel.
                  if (separation < acceptanceBands.controlSeparation) continue;
                  const winnerError = rgbL1(combined.pixels, winner, index);
                  const loserError = rgbL1(combined.pixels, loser, index);
                  winnerErrors.push(winnerError);
                  loserErrors.push(loserError);
                  controlSeparations.push(separation);
                  if (
                    winnerError + acceptanceBands.winnerMargin <=
                    loserError
                  ) {
                    winnerCloserCount++;
                  }
                }
              }

              return {
                geometricSampleCount,
                scoredSampleCount: winnerErrors.length,
                winner: moonWins ? "moon" : "earth",
                winnerCloserFraction:
                  winnerErrors.length > 0
                    ? winnerCloserCount / winnerErrors.length
                    : 0.0,
                winnerErrorP50: quantile(winnerErrors, 0.5),
                winnerErrorP95: quantile(winnerErrors, 0.95),
                loserErrorP50: quantile(loserErrors, 0.5),
                controlSeparationP50: quantile(controlSeparations, 0.5),
              };
            }

            const configurations = [
              { logDepth: true, hdr: false, bloom: false },
              { logDepth: true, hdr: false, bloom: true },
              { logDepth: true, hdr: true, bloom: false },
              { logDepth: true, hdr: true, bloom: true },
              { logDepth: false, hdr: false, bloom: false },
            ];
            const defaultFarToNearRatio = scene.logarithmicDepthFarToNearRatio;
            const overlaps = [];
            for (const fixtureName of ["moon-near", "earth-near"]) {
              for (const configuration of configurations) {
                const fixture = makeFixture(fixtureName);
                const aimResidualDegrees = aimCamera(
                  fixture.position,
                  fixture.direction,
                );
                const fovDegrees = setExplicitFov(explicitFovDegrees.normal);
                scene.logarithmicDepthBuffer = configuration.logDepth;
                scene.logarithmicDepthFarToNearRatio = defaultFarToNearRatio;
                scene.highDynamicRange = configuration.hdr;
                if (scene.postProcessStages?.bloom) {
                  scene.postProcessStages.bloom.enabled = configuration.bloom;
                }
                scene.globe.show = true;
                scene.moon.show = true;
                await settle();
                // Each control render and readback is synchronous in this page
                // task. The geometric overlap mask scores every discriminating
                // overlap pixel, including limb pixels where a halo can appear.
                captureRegionSameTask();
                const combined = captureRegionSameTask();
                const ray = centerRayOracle();
                const route = markOrdinaryControlRestored(commandProvenance());
                scene.moon.show = false;
                for (let i = 0; i < 4; i++) render();
                const earthOnly = captureRegionSameTask();
                const earthOnlyRoute =
                  markOrdinaryControlRestored(commandProvenance());
                scene.moon.show = true;
                const {
                  capture: moonWithSuppressedGlobe,
                  route: moonWithSuppressedGlobeRoute,
                } = captureMoonWithSuppressedGlobe();
                const moonWins = fixtureName === "moon-near";
                const overlapScores = scoreOverlap(
                  combined,
                  earthOnly,
                  moonWithSuppressedGlobe,
                  moonWins,
                );
                const controlRoutes = {
                  combined: route,
                  earthOnly: earthOnlyRoute,
                  moonWithSuppressedGlobe: moonWithSuppressedGlobeRoute,
                };
                overlaps.push({
                  key: `${fixtureName}-log${Number(configuration.logDepth)}-hdr${Number(configuration.hdr)}-bloom${Number(configuration.bloom)}`,
                  fixture: fixtureName,
                  configuration,
                  fovDegrees,
                  aimResidualDegrees,
                  ray,
                  route,
                  controls: {
                    combinedCenter: centerRgb(combined),
                    earthOnlyCenter: centerRgb(earthOnly),
                    moonWithSuppressedGlobeCenter: centerRgb(
                      moonWithSuppressedGlobe,
                    ),
                  },
                  controlRoutes,
                  overlapScores,
                });
              }
            }

            // PVS/non-overlap control: both real bodies remain enabled and visible
            // in one frame, but occupy disjoint image regions. This proves the
            // route did not "fix" overlap by culling one body globally. Each region
            // is compared with a same-camera single-body negative control.
            const midpoint = C.Cartesian3.multiplyByScalar(
              liveMoon,
              0.5,
              new C.Cartesian3(),
            );
            let transverse = C.Cartesian3.cross(
              moonAxis,
              C.Cartesian3.UNIT_Z,
              new C.Cartesian3(),
            );
            if (magnitude(transverse) < 1.0e-6) {
              transverse = C.Cartesian3.cross(
                moonAxis,
                C.Cartesian3.UNIT_Y,
                transverse,
              );
            }
            C.Cartesian3.normalize(transverse, transverse);
            const dualBodyPosition = C.Cartesian3.add(
              midpoint,
              C.Cartesian3.multiplyByScalar(
                transverse,
                moonMagnitude * 0.62,
                new C.Cartesian3(),
              ),
              new C.Cartesian3(),
            );
            const earthLookDirection = C.Cartesian3.normalize(
              C.Cartesian3.negate(dualBodyPosition, new C.Cartesian3()),
              new C.Cartesian3(),
            );
            const moonLookDirection = C.Cartesian3.normalize(
              C.Cartesian3.subtract(
                liveMoon,
                dualBodyPosition,
                new C.Cartesian3(),
              ),
              new C.Cartesian3(),
            );
            const dualBodyDirection = C.Cartesian3.normalize(
              C.Cartesian3.add(
                earthLookDirection,
                moonLookDirection,
                new C.Cartesian3(),
              ),
              new C.Cartesian3(),
            );
            aimCamera(dualBodyPosition, dualBodyDirection);
            const dualBodyFovDegrees = setExplicitFov(
              explicitFovDegrees.dualBody,
            );
            scene.logarithmicDepthBuffer = true;
            scene.logarithmicDepthFarToNearRatio = defaultFarToNearRatio;
            scene.highDynamicRange = false;
            if (scene.postProcessStages?.bloom) {
              scene.postProcessStages.bloom.enabled = false;
            }
            scene.globe.show = true;
            scene.moon.show = true;
            await settle();
            captureRegionSameTask(
              Math.min(scene.canvas.width, scene.canvas.height),
            );
            const legacyMoonCommandWithBothBodies =
              scene._environmentState?.moonCommand;
            const legacyMoonVisibleWithBothBodies =
              scene._environmentState?.isMoonVisible === true;
            const bothBodiesShownAtCapture =
              scene.globe.show === true && scene.moon.show === true;
            const globeCommandsWithBothBodies =
              scene.frameState.commandList.filter(
                (command) =>
                  scene.globe?._surface?._tilesRenderedThisFrame?.has(
                    command?.owner,
                  ) === true,
              ).length;
            const moonCommandsWithBothBodies =
              scene.frameState.commandList.filter(
                (command) => command?.owner === scene.moon,
              );
            const physicalMoonCommandsWithBothBodies =
              moonCommandsWithBothBodies.filter(
                (command) => command?._moonPhysicalDepthRoute === true,
              );
            const dualBodyMoonRoute =
              markOrdinaryControlRestored(commandProvenance());
            const dualBodyMoonPresenceEvidence = {
              actualPhysical: dualBodyMoonRoute.actualPhysical,
              physicalCommands: dualBodyMoonRoute.physicalCommands,
              uniquePhysicalCommands: dualBodyMoonRoute.uniquePhysicalCommands,
              moonOwnedPhysicalCommands:
                physicalMoonCommandsWithBothBodies.length,
              physicalFrustumExecutions:
                dualBodyMoonRoute.physicalFrustumExecutions,
              legacyCommandPresent:
                legacyMoonCommandWithBothBodies?.owner === scene.moon,
              legacyVisible: legacyMoonVisibleWithBothBodies,
            };
            const earthSurfacePosition = C.Cartesian3.multiplyByScalar(
              C.Cartesian3.normalize(dualBodyPosition, new C.Cartesian3()),
              earthRadius,
              new C.Cartesian3(),
            );
            const moonWindow =
              C.SceneTransforms.worldToDrawingBufferCoordinates(
                scene,
                liveMoon,
                new C.Cartesian2(),
              );
            const earthWindow =
              C.SceneTransforms.worldToDrawingBufferCoordinates(
                scene,
                earthSurfacePosition,
                new C.Cartesian2(),
              );
            const combinedCanvas = document.createElement("canvas");
            combinedCanvas.width = scene.canvas.width;
            combinedCanvas.height = scene.canvas.height;
            const combinedContext = combinedCanvas.getContext("2d", {
              willReadFrequently: true,
            });
            combinedContext.drawImage(scene.canvas, 0, 0);

            scene.moon.show = false;
            for (let i = 0; i < 4; i++) render();
            const dualBodyEarthOnlyRoute =
              markOrdinaryControlRestored(commandProvenance());
            const earthOnlyCanvas = document.createElement("canvas");
            earthOnlyCanvas.width = scene.canvas.width;
            earthOnlyCanvas.height = scene.canvas.height;
            const earthOnlyContext = earthOnlyCanvas.getContext("2d", {
              willReadFrequently: true,
            });
            earthOnlyContext.drawImage(scene.canvas, 0, 0);

            scene.moon.show = true;
            const {
              capture: dualBodyMoonControlCapture,
              route: dualBodyMoonControlRoute,
            } = captureMoonWithSuppressedGlobe(
              Math.max(scene.canvas.width, scene.canvas.height),
            );
            const moonOnlyCanvas = document.createElement("canvas");
            moonOnlyCanvas.width = scene.canvas.width;
            moonOnlyCanvas.height = scene.canvas.height;
            const moonOnlyContext = moonOnlyCanvas.getContext("2d", {
              willReadFrequently: true,
            });
            moonOnlyContext.putImageData(
              new ImageData(
                new Uint8ClampedArray(dualBodyMoonControlCapture.pixels),
                dualBodyMoonControlCapture.width,
                dualBodyMoonControlCapture.height,
              ),
              dualBodyMoonControlCapture.x,
              dualBodyMoonControlCapture.y,
            );

            function scoreProjectedBody(
              windowPosition,
              bodyOnlyContext,
              radius,
            ) {
              if (!windowPosition) {
                return {
                  sampleCount: 0,
                  combinedErrorP95: null,
                  separationP50: null,
                };
              }
              const cx = Math.round(windowPosition.x);
              const cy = Math.round(windowPosition.y);
              const errors = [];
              const separations = [];
              for (let y = -radius; y <= radius; y++) {
                for (let x = -radius; x <= radius; x++) {
                  if (x * x + y * y > radius * radius) continue;
                  const px = cx + x;
                  const py = cy + y;
                  if (
                    px < 0 ||
                    py < 0 ||
                    px >= scene.canvas.width ||
                    py >= scene.canvas.height
                  ) {
                    continue;
                  }
                  const combined = combinedContext.getImageData(
                    px,
                    py,
                    1,
                    1,
                  ).data;
                  const bodyOnly = bodyOnlyContext.getImageData(
                    px,
                    py,
                    1,
                    1,
                  ).data;
                  const black = new Uint8ClampedArray([0, 0, 0, 255]);
                  const separation = rgbL1(bodyOnly, black, 0);
                  if (separation < acceptanceBands.controlSeparation) continue;
                  errors.push(rgbL1(combined, bodyOnly, 0));
                  separations.push(separation);
                }
              }
              return {
                sampleCount: errors.length,
                combinedErrorP95: quantile(errors, 0.95),
                separationP50: quantile(separations, 0.5),
              };
            }

            const dualBodyNonOverlap = {
              fixture: "dual-body-non-overlap",
              bothBodiesShown: bothBodiesShownAtCapture,
              fovDegrees: dualBodyFovDegrees,
              moonWindow: moonWindow ? xyz({ ...moonWindow, z: 0 }) : null,
              earthWindow: earthWindow ? xyz({ ...earthWindow, z: 0 }) : null,
              moonPresenceEvidence: dualBodyMoonPresenceEvidence,
              moonControlRoute: dualBodyMoonControlRoute,
              controlRoutes: {
                combined: dualBodyMoonRoute,
                earthOnly: dualBodyEarthOnlyRoute,
                moonWithSuppressedGlobe: dualBodyMoonControlRoute,
              },
              globeCommandPresent: globeCommandsWithBothBodies > 0,
              projectedSeparationPixels:
                moonWindow && earthWindow
                  ? C.Cartesian2.distance(moonWindow, earthWindow)
                  : null,
              moonCenterRayHitsMoon:
                Boolean(moonWindow) &&
                Number.isFinite(
                  pixelRayOracle(moonWindow.x, moonWindow.y).moonDistance,
                ),
              earthCenterRayHitsEarth:
                Boolean(earthWindow) &&
                Number.isFinite(
                  pixelRayOracle(earthWindow.x, earthWindow.y).earthDistance,
                ),
              moonRegion: scoreProjectedBody(moonWindow, moonOnlyContext, 16),
              earthRegion: scoreProjectedBody(
                earthWindow,
                earthOnlyContext,
                16,
              ),
            };
            scene.globe.show = true;
            scene.moon.show = true;

            // A camera inside the lunar sphere forces the bounded command through
            // more than one intersecting frustum. Each shader then accepts only
            // its current projection slice, including the visible exit surface.
            const multifrustumFixture = makeFixture("moon-inside-multifrustum");
            const multifrustumAimResidualDegrees = aimCamera(
              multifrustumFixture.position,
              multifrustumFixture.direction,
            );
            const multifrustumFovDegrees = setExplicitFov(
              explicitFovDegrees.diagnostic,
            );
            scene.globe.show = true;
            scene.moon.show = true;
            scene.logarithmicDepthBuffer = true;
            scene.logarithmicDepthFarToNearRatio = 1.0e3;
            scene.highDynamicRange = false;
            if (scene.postProcessStages?.bloom) {
              scene.postProcessStages.bloom.enabled = false;
            }
            await settle();
            captureRegionSameTask();
            const multifrustumCombined = captureRegionSameTask();
            const multifrustumRay = centerRayOracle();
            const multifrustumRoute =
              markOrdinaryControlRestored(commandProvenance());
            scene.moon.show = false;
            for (let i = 0; i < 4; i++) render();
            const multifrustumEarthOnly = captureRegionSameTask();
            const multifrustumEarthOnlyRoute =
              markOrdinaryControlRestored(commandProvenance());
            scene.moon.show = true;
            const {
              capture: multifrustumMoonOnly,
              route: multifrustumMoonControlRoute,
            } = captureMoonWithSuppressedGlobe();
            scene.moon.show = true;
            const multifrustum = {
              logarithmicDepthFarToNearRatio:
                scene.logarithmicDepthFarToNearRatio,
              aimResidualDegrees: multifrustumAimResidualDegrees,
              fovDegrees: multifrustumFovDegrees,
              ray: multifrustumRay,
              route: multifrustumRoute,
              controlRoutes: {
                combined: multifrustumRoute,
                earthOnly: multifrustumEarthOnlyRoute,
                moonWithSuppressedGlobe: multifrustumMoonControlRoute,
              },
              centerScore: scoreCenter(
                multifrustumCombined,
                multifrustumMoonOnly,
                multifrustumEarthOnly,
              ),
            };

            // Route crossing has two independent oracles. First, with TAA off,
            // hysteresis lets the legacy and physical routes be captured at the
            // exact same camera position. Second, each automatic route-reset
            // frame is compared with a manually reset same-route frame at that
            // same position. Three paired repetitions make a one-off jitter phase
            // incapable of certifying the transition.
            scene.logarithmicDepthBuffer = true;
            scene.logarithmicDepthFarToNearRatio = defaultFarToNearRatio;
            scene.highDynamicRange = false;
            if (renderer === "webgpu") {
              // TAA requires single-sample attachments. Pin the user-facing
              // sample count before prewarm so toggling TAA cannot alternate
              // 4x/1x framebuffers, bump the scene-pipeline generation, and
              // invalidate both lazy Moon pipelines inside a same-task pair.
              scene.msaaSamples = 1;
            }
            const crossingFovDegrees = setExplicitFov(
              explicitFovDegrees.diagnostic,
            );
            if (scene.postProcessStages?.bloom) {
              scene.postProcessStages.bloom.enabled = false;
            }
            const crossingDefinitions = [
              { label: "beforePrewarm", gap: moonRadius + 1000.0 },
              { label: "prewarm", gap: moonRadius, settle: true },
              { label: "beforeEntry", gap: 1.0, settle: true },
              { label: "enter", gap: -1.0 },
              { label: "hold", gap: moonRadius * 0.5 },
              { label: "exit", gap: moonRadius + 1.0 },
            ];
            const crossingSteps = [];
            let pipelineReadyBeforeEntry = renderer !== "webgpu";
            let pipelineFailed = false;
            const positionForGap = (gap) => {
              const radiusFromEarth =
                (moonMagnitude - moonRadius - earthRadius - gap) * 0.5;
              return {
                radiusFromEarth,
                position: C.Cartesian3.multiplyByScalar(
                  moonAxis,
                  radiusFromEarth,
                  new C.Cartesian3(),
                ),
              };
            };
            const moveToGap = async (gap, shouldSettle = false) => {
              const fixture = positionForGap(gap);
              aimCamera(fixture.position, moonAxis);
              if (shouldSettle) {
                await settle();
              } else {
                render();
              }
              return fixture;
            };

            // Prewarm and prove the exact entry/hold/exit ownership once with
            // temporal processing disabled. This also makes the physical
            // pipeline ready before any measured pair.
            scene.taaEnabled = false;
            for (const definition of crossingDefinitions) {
              const fixture = await moveToGap(
                definition.gap,
                definition.settle === true,
              );
              const cache = scene.moon._webgpuCache;
              if (definition.label === "prewarm") {
                pipelineReadyBeforeEntry =
                  renderer !== "webgpu" ||
                  Boolean(cache?.physicalPipelineEntry?.pipeline);
                pipelineFailed = cache?.physicalPipelineEntry?.failed === true;
              }
              crossingSteps.push({
                ...definition,
                radiusFromEarth: fixture.radiusFromEarth,
                prewarm: scene.moon._physicalDepthPrewarmRequested === true,
                requested: scene.moon._physicalDepthRequested === true,
                actualPhysical: scene.moon._physicalDepthActual === true,
                routeChanged:
                  scene.frameState._moonPhysicalDepthRouteChanged === true,
              });
            }

            // TAA is lazy on WebGPU. Initialize it on an established legacy
            // route before installing counters so setup cannot masquerade as a
            // route reset.
            await moveToGap(moonRadius + 1000.0);
            scene.taaEnabled = true;
            await settle();
            const taa = scene._alternateSceneRenderer?._postProcess?.taaEffect;
            const taaEffectAvailable = Boolean(taa);
            const effectiveMsaaSamplesAtStart =
              renderer === "webgpu" ? scene.context._msaaSamples : null;
            const pipelineFormatGenerationAtStart =
              renderer === "webgpu"
                ? scene.context._scenePipelineFormatGeneration
                : null;
            if (
              renderer === "webgpu" &&
              (!Number.isInteger(effectiveMsaaSamplesAtStart) ||
                effectiveMsaaSamplesAtStart !== 1 ||
                !Number.isInteger(pipelineFormatGenerationAtStart) ||
                pipelineFormatGenerationAtStart < 0)
            ) {
              throw new Error(
                "STRUCTURAL: crossing setup did not establish a single-sample scene pipeline",
              );
            }
            const originalResetHistory = taa?.resetHistory;
            let manualResetScope = false;
            let enableResetScope = false;
            let manualTaaResetCount = 0;
            let enableTaaResetCount = 0;
            let automaticTaaResetCount = 0;
            const pinnedJitterFrameIndex = 424_242;
            let pinnedJitterCallCount = 0;
            const originalComputeJitter = taa?.computeJitter;
            if (taa && typeof originalResetHistory === "function") {
              taa.resetHistory = function (...args) {
                if (manualResetScope) {
                  manualTaaResetCount++;
                } else if (enableResetScope) {
                  enableTaaResetCount++;
                } else {
                  automaticTaaResetCount++;
                }
                return originalResetHistory.apply(this, args);
              };
            }
            if (taa && typeof originalComputeJitter === "function") {
              taa.computeJitter = function (
                _frameIndex,
                screenWidth,
                screenHeight,
              ) {
                pinnedJitterCallCount++;
                return originalComputeJitter.call(
                  this,
                  pinnedJitterFrameIndex,
                  screenWidth,
                  screenHeight,
                );
              };
            }

            const readResetCounters = () => ({
              automatic: automaticTaaResetCount,
              manual: manualTaaResetCount,
              enable: enableTaaResetCount,
            });
            const resetDeltaEvidence = (before, after) =>
              Object.fromEntries(
                Object.keys(before).map((kind) => [
                  kind,
                  {
                    before: before[kind],
                    after: after[kind],
                    delta: after[kind] - before[kind],
                  },
                ]),
              );
            const captureCurrent = (renderFirst = false) => ({
              capture: captureRegionSameTask(
                acceptanceBands.continuityCaptureSize,
                renderFirst,
              ),
              route: markOrdinaryControlRestored(commandProvenance()),
              taaState: {
                sceneEnabled: scene.taaEnabled === true,
                effectEnabled: taa?.enabled === true,
              },
            });
            const captureAfterManualReset = () => {
              if (taa && typeof originalResetHistory === "function") {
                manualResetScope = true;
                try {
                  taa.resetHistory();
                } finally {
                  manualResetScope = false;
                }
              }
              return captureCurrent(true);
            };
            const comparisons = [];
            const addComparison = ({
              transition,
              mode,
              repetition,
              gap,
              reference,
              observed,
              resetDeltas,
            }) => {
              const key = `${transition}-${mode}-r${repetition}`;
              const score = scoreContinuityPair(
                reference.capture,
                observed.capture,
                { emitImages: true },
              );
              comparisons.push({
                key,
                transition,
                mode,
                repetition,
                samePosition: true,
                gap,
                fovDegrees: crossingFovDegrees,
                routeProvenance: {
                  reference: reference.route,
                  observed: observed.route,
                },
                taaState: {
                  reference: reference.taaState,
                  observed: observed.taaState,
                },
                resetDeltas,
                ...score,
              });
            };

            try {
              for (
                let repetition = 1;
                repetition <= acceptanceBands.continuityRepetitions;
                repetition++
              ) {
                // Raw same-position parity. At +1 m, hysteresis can hold the
                // physical route after an entry while a fresh approach remains
                // legacy. At exactly one lunar radius, the inverse is true.
                scene.taaEnabled = false;
                const entryRawResetCountersBefore = readResetCounters();
                await moveToGap(moonRadius + 1.0);
                await moveToGap(1.0);
                const entryRawLegacy = captureCurrent();
                await moveToGap(-1.0);
                await moveToGap(1.0);
                const entryRawPhysical = captureCurrent();
                const entryRawResetCountersAfter = readResetCounters();
                addComparison({
                  transition: "entry",
                  mode: "raw",
                  repetition,
                  gap: 1.0,
                  reference: entryRawLegacy,
                  observed: entryRawPhysical,
                  resetDeltas: resetDeltaEvidence(
                    entryRawResetCountersBefore,
                    entryRawResetCountersAfter,
                  ),
                });

                const exitRawResetCountersBefore = readResetCounters();
                await moveToGap(moonRadius);
                const exitRawPhysical = captureCurrent();
                await moveToGap(moonRadius + 1.0);
                await moveToGap(moonRadius);
                const exitRawLegacy = captureCurrent();
                const exitRawResetCountersAfter = readResetCounters();
                addComparison({
                  transition: "exit",
                  mode: "raw",
                  repetition,
                  gap: moonRadius,
                  reference: exitRawPhysical,
                  observed: exitRawLegacy,
                  resetDeltas: resetDeltaEvidence(
                    exitRawResetCountersBefore,
                    exitRawResetCountersAfter,
                  ),
                });

                // Automatic reset frames are compared with a manually reset
                // same-route control at exactly the same camera position.
                scene.taaEnabled = true;
                enableResetScope = true;
                const entryResetCountersBefore = readResetCounters();
                try {
                  await moveToGap(moonRadius + 1.0);
                } finally {
                  enableResetScope = false;
                }
                const entryAutomatic = await (async () => {
                  const fixture = positionForGap(-1.0);
                  aimCamera(fixture.position, moonAxis);
                  return captureCurrent(true);
                })();
                const entryManual = captureAfterManualReset();
                const entryResetCountersAfter = readResetCounters();
                addComparison({
                  transition: "entry",
                  mode: "first-frame",
                  repetition,
                  gap: -1.0,
                  reference: entryManual,
                  observed: entryAutomatic,
                  resetDeltas: resetDeltaEvidence(
                    entryResetCountersBefore,
                    entryResetCountersAfter,
                  ),
                });

                const exitResetCountersBefore = readResetCounters();
                const exitAutomatic = await (async () => {
                  const fixture = positionForGap(moonRadius + 1.0);
                  aimCamera(fixture.position, moonAxis);
                  return captureCurrent(true);
                })();
                const exitManual = captureAfterManualReset();
                const exitResetCountersAfter = readResetCounters();
                addComparison({
                  transition: "exit",
                  mode: "first-frame",
                  repetition,
                  gap: moonRadius + 1.0,
                  reference: exitManual,
                  observed: exitAutomatic,
                  resetDeltas: resetDeltaEvidence(
                    exitResetCountersBefore,
                    exitResetCountersAfter,
                  ),
                });
              }
            } finally {
              if (taa && typeof originalResetHistory === "function") {
                taa.resetHistory = originalResetHistory;
              }
              if (taa && typeof originalComputeJitter === "function") {
                taa.computeJitter = originalComputeJitter;
              }
            }
            const taaResetCount =
              manualTaaResetCount +
              automaticTaaResetCount +
              enableTaaResetCount;
            const effectiveMsaaSamplesAtEnd =
              renderer === "webgpu" ? scene.context._msaaSamples : null;
            const pipelineFormatGenerationAtEnd =
              renderer === "webgpu"
                ? scene.context._scenePipelineFormatGeneration
                : null;

            // Fence every render/readback before observing the scoped and global
            // WebGPU error lanes. The event-turn yield allows uncapturederror and
            // device.lost handlers queued by the completed work to run before the
            // evidence object is cloned back to Node.
            if (renderer === "webgpu" && device) {
              await device.queue.onSubmittedWorkDone();
              webgpuDeviceEvidence.queueDrainedAfterMeasurement = true;
              const validationError = await device.popErrorScope();
              if (validationError) {
                webgpuDeviceEvidence.validationErrorCount = 1;
                webgpuDeviceEvidence.validationErrors.push(
                  validationError.message ?? String(validationError),
                );
              }
              await new Promise((resolve) => setTimeout(resolve, 0));
              webgpuDeviceEvidence.postDrainEventTurn = true;
              device.removeEventListener?.(
                "uncapturederror",
                onUncapturedError,
              );
            } else {
              scene.context._gl?.finish?.();
            }

            const graphicsContext = scene.context;
            const adapterInfo = graphicsContext.adapter?.info
              ? {
                  vendor: graphicsContext.adapter.info.vendor || "",
                  architecture: graphicsContext.adapter.info.architecture || "",
                  device: graphicsContext.adapter.info.device || "",
                  description: graphicsContext.adapter.info.description || "",
                  subgroupMinSize: graphicsContext.adapter.info.subgroupMinSize,
                  subgroupMaxSize: graphicsContext.adapter.info.subgroupMaxSize,
                }
              : null;
            const rendererString =
              typeof graphicsContext.getRendererString === "function"
                ? graphicsContext.getRendererString()
                : "";
            const gpuProvenance = {
              backend: scene.context.rendererType,
              rendererString,
              adapterInfo,
            };

            return {
              actualRenderer: scene.context.rendererType,
              gpuProvenance,
              webgpuDeviceEvidence,
              preflight,
              geometry: {
                pinnedIso,
                moonCenterWC: xyz(liveMoon),
                moonMagnitude,
                moonRadius,
                earthRadius,
              },
              overlaps,
              dualBodyNonOverlap,
              multifrustum,
              crossing: {
                steps: crossingSteps,
                fovDegrees: crossingFovDegrees,
                repetitionCount: acceptanceBands.continuityRepetitions,
                pipelineReadyBeforeEntry,
                pipelineFailed,
                runtimeConfiguration: {
                  requestedMsaaSamples:
                    renderer === "webgpu" ? scene.msaaSamples : null,
                  effectiveMsaaSamplesAtStart,
                  effectiveMsaaSamplesAtEnd,
                  pipelineFormatGenerationAtStart,
                  pipelineFormatGenerationAtEnd,
                },
                taaEffectAvailable,
                taaResetCount,
                automaticTaaResetCount,
                manualTaaResetCount,
                enableTaaResetCount,
                pinnedJitterFrameIndex:
                  renderer === "webgpu" ? pinnedJitterFrameIndex : null,
                pinnedJitterCallCount,
                comparisons,
              },
            };
          },
          {
            pinnedIso,
            settleBudgetMs,
            settleMinimumFrames,
            renderer,
            acceptanceBands,
            explicitFovDegrees,
          },
        ),
      timeouts.evaluate,
      `${renderer} page.evaluate`,
    );
    const dualBodyMoonPresence = assessC1237DualBodyMoonPresence(
      result.dualBodyNonOverlap.moonPresenceEvidence,
    );
    result.dualBodyNonOverlap.moonPresence = dualBodyMoonPresence;
    result.dualBodyNonOverlap.moonCommandPresent = dualBodyMoonPresence.present;
    const runtimeEntry = await tracker.run(
      () => runtimeEntryPromise,
      timeouts.runtimeEntry,
      `${renderer} served runtime identity`,
    );
    signal.throwIfAborted();

    return { ok: true, renderer, consoleErrors, runtimeEntry, ...result };
  } catch (error) {
    if (error instanceof C1237TimeoutError) {
      throw error;
    }
    return {
      ok: false,
      renderer,
      consoleErrors,
      error: String(error?.stack ?? error),
    };
  } finally {
    if (context) {
      try {
        await tracker.run(
          () => context.close(),
          timeouts.contextClose,
          `${renderer} context.close`,
        );
      } catch (error) {
        cleanupErrors.push({
          scope: renderer,
          operation: "context.close",
          error: error?.message ?? String(error),
        });
      }
    }
  }
}

export async function runC1237Probe(options = {}) {
  const outputDirectory = path.resolve(
    options.outputDirectory ??
      process.env.C12_37_OUTPUT_DIR ??
      defaultOutputDirectory,
  );
  const runId = options.runId ?? randomUUID();
  const paths = createC1237ArtifactPaths(outputDirectory, runId);
  const operations = options.operations ?? fs;
  const launchBrowser =
    options.launchBrowser ?? ((launch) => chromium.launch(launch));
  const collectProvenance = options.collectProvenance ?? collectC1237Provenance;
  const executeBackend = options.runBackend ?? runBackend;
  const hardLimitMs = options.hardLimitMs ?? defaultHardLimitMs;
  const outerWatchdogGraceMs =
    options.outerWatchdogGraceMs ?? defaultOuterWatchdogGraceMs;
  const startedAt = new Date().toISOString();
  fs.mkdirSync(outputDirectory, { recursive: true });

  // Only directory creation and the exclusive lock itself precede ownership.
  // Capture is deliberately non-throwing. A genuine prior RUNNING marker is
  // preserved, while every other stale claim is replaced by this invocation's
  // verified RUNNING marker before parsing, archive checks, source snapshots,
  // provenance, browser launch, or any other fallible preflight begins.
  acquireC1237RunLock(paths, operations);
  const priorLatestCapture = captureC1237PriorLatest(paths.latest, operations);
  try {
    assertNoPriorC1237Running(priorLatestCapture);
  } catch (error) {
    try {
      releaseC1237RunLock(paths, operations);
    } catch (releaseError) {
      throw new AggregateError(
        [error, releaseError],
        "prior C12-37 RUNNING rejection and new-lock release both failed",
        { cause: releaseError },
      );
    }
    throw error;
  }
  const runningMarker = {
    schema: artifactSchema,
    campaign: "C12-37",
    probe: "Moon/globe physical-depth dual-backend acceptance",
    runId,
    status: "RUNNING",
    incomplete: true,
    startedAt,
    base,
    browserLaunch,
    paths: {
      immutableRun: paths.run,
      firstRed: paths.firstRed,
      historical: paths.historical,
    },
    priorLatestAtStart: summarizeC1237PriorLatest(priorLatestCapture),
  };
  publishC1237Running(paths, runningMarker, operations);

  let timeouts;
  const tracker = createC1237OperationTracker();
  const control = {
    abortController: new AbortController(),
    browser: null,
    browserWasCreated: false,
    browserClosed: true,
    browserCloseAttempted: false,
    browserClosePromise: null,
    lateBrowserCleanupAttempted: false,
    lateBrowserClosed: false,
    measurementTaskDrained: true,
    watchdogTimedOut: false,
    watchdogCloseAttempted: false,
    cleanupErrors: [],
    tracker,
    timeouts: null,
  };
  const results = [];
  let previousLatest;
  let historicalAtStart;
  let historicalAtEnd;
  let firstRedAtStart;
  let firstRedAtEnd;
  let startProvenance;
  let endProvenance;
  let artifact;
  let exitCode;
  let unsafeError;
  let trackerDrain = {
    ok: false,
    pendingCount: null,
    timedOut: [],
    error: "cleanup not attempted",
  };
  let outerWatchdog;

  try {
    timeouts = resolveC1237OperationTimeouts(options.operationTimeouts);
    control.timeouts = timeouts;
    if (!(Number.isFinite(hardLimitMs) && hardLimitMs > 0)) {
      throw new Error(
        "C12-37 hard watchdog duration must be finite and positive",
      );
    }
    if (!(Number.isFinite(outerWatchdogGraceMs) && outerWatchdogGraceMs > 0)) {
      throw new Error(
        "C12-37 outer watchdog grace must be finite and positive",
      );
    }
    if (options.enableOuterWatchdog === true) {
      outerWatchdog = setTimeout(() => {
        const message =
          `C12-37 OUTER WATCHDOG exceeded ${hardLimitMs + outerWatchdogGraceMs} ms; ` +
          "owned RUNNING marker and lock intentionally retained";
        console.error(message);
        if (typeof options.outerWatchdogAction === "function") {
          options.outerWatchdogAction({ message, paths, runId });
        } else {
          process.exit(2);
        }
      }, hardLimitMs + outerWatchdogGraceMs);
      outerWatchdog.unref?.();
    }

    previousLatest = prepareCapturedC1237LatestForRun(
      priorLatestCapture,
      paths,
      operations,
    );
    historicalAtStart = fingerprintEvidenceFile(paths.historical, operations);
    firstRedAtStart = fingerprintEvidenceFile(paths.firstRed, operations);
    assertEvidenceReadableOrAbsent(
      historicalAtStart,
      "historical pre-lifecycle C12-37 artifact",
    );
    assertEvidenceReadableOrAbsent(
      firstRedAtStart,
      "C12-37 first-red artifact",
    );

    control.measurementTaskDrained = false;
    const measurement = await withC1237Watchdog(
      (async () => {
        startProvenance = await collectProvenance();
        control.abortController.signal.throwIfAborted();
        if (startProvenance.ok !== true) {
          throw new C1237StructuralError(
            `STRUCTURAL: start source/build identity is not exact: ${(startProvenance.reasons ?? []).join("; ")}`,
            startProvenance,
          );
        }

        control.browserClosed = false;
        const launchedBrowser = await tracker.run(
          () => launchBrowser(browserLaunch),
          timeouts.launch,
          "browser launch",
          {
            onLateFulfilled: async (lateBrowser) => {
              control.lateBrowserCleanupAttempted = true;
              try {
                await lateBrowser.close();
                control.lateBrowserClosed = true;
              } catch (error) {
                control.cleanupErrors.push({
                  scope: "late-browser",
                  operation: "browser.close",
                  error: error?.message ?? String(error),
                });
                throw error;
              }
            },
          },
        );
        control.browser = launchedBrowser;
        control.browserWasCreated = true;
        control.abortController.signal.throwIfAborted();

        for (const renderer of ["webgl", "webgpu"]) {
          control.abortController.signal.throwIfAborted();
          results.push(
            await executeBackend(launchedBrowser, renderer, {
              tracker,
              timeouts,
              cleanupErrors: control.cleanupErrors,
              signal: control.abortController.signal,
            }),
          );
        }
        for (const result of results) {
          if (result.ok === true) {
            result.continuityImagePublications = publishC1237ContinuityImages(
              paths,
              result,
              operations,
            );
          }
        }
        if (!(await closeC1237Browser(control, "measurement complete"))) {
          throw new Error("C12-37 browser did not close after measurement");
        }
        control.abortController.signal.throwIfAborted();

        for (const result of results) {
          if (result.ok === true) {
            result.continuityImageVerification = verifyC1237ContinuityImages(
              paths,
              result,
              operations,
            );
          }
        }

        endProvenance = await collectProvenance();
        historicalAtEnd = fingerprintEvidenceFile(paths.historical, operations);
        firstRedAtEnd = fingerprintEvidenceFile(paths.firstRed, operations);
        assertEvidenceReadableOrAbsent(
          historicalAtEnd,
          "historical pre-lifecycle C12-37 artifact before finalization",
        );
        assertEvidenceReadableOrAbsent(
          firstRedAtEnd,
          "C12-37 first-red artifact before finalization",
        );
        return { endProvenance, historicalAtEnd, firstRedAtEnd };
      })(),
      control,
      hardLimitMs,
      timeouts.losingTaskDrain,
    );

    const provenance = assessC1237Provenance({
      start: startProvenance,
      end: measurement.endProvenance,
      servedEntries: results
        .map((result) => result.runtimeEntry)
        .filter(Boolean),
      results,
      historicalAtStart,
      historicalAtEnd: measurement.historicalAtEnd,
      firstRedAtStart,
      firstRedAtEnd: measurement.firstRedAtEnd,
    });
    const failures = provenance.reasons.map(
      (reason) => `provenance: ${reason}`,
    );
    for (const result of results) {
      validateC1237Backend(result, failures);
    }
    const status = failures.length === 0 ? "PASS" : "FAIL";
    exitCode = status === "PASS" ? 0 : 1;
    artifact = {
      schema: artifactSchema,
      campaign: "C12-37",
      probe: "Moon/globe physical-depth dual-backend acceptance",
      runId,
      status,
      incomplete: false,
      exitCode,
      startedAt,
      completedAt: new Date().toISOString(),
      base,
      browserLaunch,
      pinnedIso,
      suppliedView,
      suppliedRecordClassification: "STRUCTURAL",
      viewport,
      acceptanceBands,
      provenance: {
        start: startProvenance,
        end: measurement.endProvenance,
        assessment: provenance,
      },
      previousLatest,
      historicalAtStart,
      historicalAtEnd: measurement.historicalAtEnd,
      firstRedAtStart,
      firstRedAtEnd: measurement.firstRedAtEnd,
      results,
      failures,
      pass: status === "PASS",
    };
  } catch (error) {
    discardC1237ContinuityImageDataUrls(results);
    if (error instanceof C1237UnsettledOperationsError) {
      unsafeError = error;
    }
    const message = describeC1237Error(error);
    const structural =
      error instanceof C1237StructuralError || /STRUCTURAL:/u.test(message);
    exitCode = structural ? 3 : 2;
    artifact = {
      schema: artifactSchema,
      campaign: "C12-37",
      probe: "Moon/globe physical-depth dual-backend acceptance",
      runId,
      status: structural ? "STRUCTURAL" : "ERROR",
      incomplete: false,
      exitCode,
      startedAt,
      completedAt: new Date().toISOString(),
      base,
      browserLaunch,
      pinnedIso,
      previousLatest,
      startProvenance,
      historicalAtStart,
      firstRedAtStart,
      results,
      error: message,
      pass: false,
    };
  } finally {
    if (control.browser) {
      if (control.browserClosePromise) {
        await control.browserClosePromise;
      } else {
        const browser = control.browser;
        control.browserCloseAttempted = true;
        try {
          await tracker.run(
            async () => {
              await browser.close();
              control.browser = null;
              control.browserClosed = true;
            },
            timeouts.browserClose,
            "browser.close (final cleanup)",
          );
        } catch (error) {
          control.cleanupErrors.push({
            scope: "browser",
            operation: "browser.close",
            reason: "final cleanup",
            error: error?.message ?? String(error),
          });
        }
      }
    }
    if (timeouts) {
      trackerDrain = await tracker.drain(timeouts.losingTaskDrain);
    }
  }

  const cleanup = {
    browserWasCreated: control.browserWasCreated,
    browserClosed: control.browserClosed,
    browserCloseAttempted: control.browserCloseAttempted,
    lateBrowserCleanupAttempted: control.lateBrowserCleanupAttempted,
    lateBrowserClosed: control.lateBrowserClosed,
    measurementTaskDrained: control.measurementTaskDrained,
    watchdogTimedOut: control.watchdogTimedOut,
    watchdogCloseAttempted: control.watchdogCloseAttempted,
    trackerDrain,
    errors: control.cleanupErrors,
  };
  artifact.cleanup = cleanup;

  const browserSafe =
    (!control.browserWasCreated || control.browserClosed) &&
    (!control.lateBrowserCleanupAttempted || control.lateBrowserClosed);
  const publicationSafe =
    unsafeError === undefined &&
    control.measurementTaskDrained &&
    trackerDrain.ok === true &&
    trackerDrain.pendingCount === 0 &&
    browserSafe;
  if (!publicationSafe) {
    throw new C1237UnsettledOperationsError(
      "C12-37 cleanup could not prove all browser/context/losing tasks settled; owned RUNNING marker and lock retained",
      {
        original: unsafeError?.message ?? artifact.error ?? null,
        cleanup,
      },
    );
  }
  // Only a proof that every losing task and browser/context close settled may
  // disarm the process-level fuse. If unsafe asynchronous work survives, the
  // CLI keeps this timer armed and retains RUNNING plus the lock.
  clearTimeout(outerWatchdog);

  if (control.cleanupErrors.length > 0) {
    const cleanupMessage = `browser cleanup reported errors: ${control.cleanupErrors
      .map((entry) => entry.error ?? String(entry))
      .join(" | ")}`;
    artifact.status = "ERROR";
    artifact.exitCode = 2;
    artifact.pass = false;
    artifact.error = artifact.error
      ? `${artifact.error}\n${cleanupMessage}`
      : cleanupMessage;
    exitCode = 2;
  }
  // Re-read immutable historical evidence only after all asynchronous work is
  // drained. It is never a write target for this lifecycle.
  historicalAtEnd ??= fingerprintEvidenceFile(paths.historical, operations);
  firstRedAtEnd ??= fingerprintEvidenceFile(paths.firstRed, operations);
  assertEvidenceReadableOrAbsent(
    historicalAtEnd,
    "historical pre-lifecycle C12-37 artifact at publication",
  );
  assertEvidenceReadableOrAbsent(
    firstRedAtEnd,
    "C12-37 first-red artifact at publication",
  );
  if (
    historicalAtStart !== undefined &&
    !sameC1237Fingerprint(historicalAtStart, historicalAtEnd)
  ) {
    artifact.status = "ERROR";
    artifact.exitCode = 2;
    artifact.pass = false;
    artifact.error = artifact.error
      ? `${artifact.error}\nhistorical pre-lifecycle artifact changed`
      : "historical pre-lifecycle artifact changed";
    exitCode = 2;
  }

  try {
    artifact.continuityImagesAtPublication = results
      .filter((result) => result.ok === true)
      .map((result) => ({
        renderer: result.renderer,
        images: verifyC1237ContinuityImages(paths, result, operations),
      }));
  } catch (error) {
    const imageError = `continuity PNG final verification failed: ${describeC1237Error(error)}`;
    artifact.status = "ERROR";
    artifact.exitCode = 2;
    artifact.pass = false;
    artifact.failures ??= [];
    artifact.failures.push(imageError);
    artifact.error = artifact.error
      ? `${artifact.error}\n${imageError}`
      : imageError;
    exitCode = 2;
  }

  const publication = finalizeC1237Evidence(paths, artifact, operations);
  const summary = {
    campaign: artifact.campaign,
    runId,
    status: artifact.status,
    exitCode,
    immutableRun: publication.immutableRun,
    latest: publication.latest,
    firstRed: publication.firstRed,
    failures: artifact.failures ?? [artifact.error].filter(Boolean),
  };
  console.log(artifactBytes(summary).trimEnd());
  process.exitCode = exitCode;
  return { artifact, paths, publication };
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  await runC1237Probe({ enableOuterWatchdog: true });
}
