// @purpose Node harness contracts around the moon/globe depth-occlusion probe: run lock, provenance, continuity images, watchdog, evidence finalization.
// @status ACTIVE

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { deflateSync } from "node:zlib";

import {
  computeMoonPhysicalDepthGap,
  shouldPrewarmMoonPhysicalDepth,
  updateMoonPhysicalDepthDemand,
} from "../../packages/engine/Source/Scene/Moon.js";
import { isWebGPULogDepthActive } from "../../packages/engine/Source/Renderer/WebGPU/WebGPULogDepth.ts";
import {
  C12_37_EXPECTED_OVERLAP_KEYS,
  acquireC1237RunLock,
  assessC1237DualBodyMoonPresence,
  assessC1237Provenance,
  assessC1237RoutePreservingControls,
  captureC1237PriorLatest,
  createC1237OperationTracker,
  createC1237ArtifactPaths,
  finalizeC1237Evidence,
  expectedC1237ContinuityKeys,
  prepareCapturedC1237LatestForRun,
  publishC1237Running,
  publishC1237ContinuityImages,
  releaseC1237RunLock,
  runC1237Probe,
  validateC1237ContinuityPng,
  validateC1237Backend,
  verifyC1237ContinuityImages,
  withC1237Watchdog,
} from "./probe-moon-globe-depth-occlusion.mjs";

const root = path.resolve(import.meta.dirname, "../..");
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");

const moonSource = read("packages/engine/Source/Scene/Moon.js");
const probeSource = read(
  "Tools/visual-regression/probe-moon-globe-depth-occlusion.mjs",
);
const engineIndex = read("packages/engine/index.js");
const sceneSource = read("packages/engine/Source/Scene/Scene.js");
const sceneRendererSource = read(
  "packages/engine/Source/Scene/SceneRenderer.js",
);
const ellipsoidSource = read(
  "packages/engine/Source/Scene/EllipsoidPrimitive.js",
);
const ellipsoidFragment = read(
  "packages/engine/Source/Shaders/EllipsoidFS.glsl",
);
const webgpuRenderer = read(
  "packages/engine/Source/Renderer/WebGPU/WebGPUEnvironmentRenderer.js",
);
const moonWgsl = read(
  "packages/engine/Source/Shaders/WebGPU/Environment/Moon.wgsl",
);
const octreeSource = read("packages/engine/Source/Scene/SceneOctree.js");
const occlusionSource = read(
  "packages/engine/Source/Scene/OcclusionCulling.js",
);
const webgpuSceneRenderer = read(
  "packages/engine/Source/Renderer/WebGPU/WebGPUSceneRenderer.ts",
);
// A real 193x193 RGBA canvas capture from C12-37 run
// 5557e434-7617-4c53-9504-38e0b99b0a92 (SHA-256 59D365A5...5522A9).
// Keeping the same-task bytes here makes the container oracle independent of
// an external evidence checkout while still exercising Chromium's PNG shape.
const sameTaskContinuityPngDataUrl =
  "data:image/png;base64," +
  "iVBORw0KGgoAAAANSUhEUgAAAMEAAADBCAYAAAB2QtScAAAFyElEQVR4AezTWW7bWhBFUePNf84vCWDpw2osknXJahaQQDKb" +
  "uqf20f7v6+vrf/8xmPwb+CfB3/39Q2AuARLM7d7m3wRI8A3Cx1wCJJjbvc2/CQyR4HtbHwg8IUCCJ1BcmkWABLP6tu0TAiR4" +
  "AsWlWQRIMKtv2z4hQIInUMpeEnwXARLswualTgRI0KlNu+wiQIJd2LzUiQAJOrVpl10ESLALm5euJBB9NgmiiZpXjgAJylUm" +
  "cDQBEkQTNa8cARKUq0zgaAIkiCZqXjkCSSUox1HgwgRIULg80WMIkCCGoymFCZCgcHmixxAgQQxHUwoTIMGV5Tk7BQESpKhB" +
  "iCsJkOBK+s5OQYAEKWoQ4koCJLiSvrNTECBBihp6h8i+HQmyNyTfcgIkWI7YAdkJkCB7Q/ItJ0CC5YgdkJ0ACbI3JN9yAkES" +
  "LM/pAASWESDBMrQGVyFAgipNybmMAAmWoTW4CgESVGlKzmUESLAFrWdbEiBBy1ottYUACbbQ8mxLAiRoWaulthAgwRZanm1J" +
  "gAQtaz221LS3STCtcfs+ECDBAxIXphEgwbTG7ftAgAQPSFyYRoAE0xq3743A/ZMEdxS+TCVAgqnN2/tOgAR3FL5MJUCCqc3b" +
  "+06ABHcUvkwl0FuCqa3aexMBEmzC5eGOBEjQsVU7bSJAgk24PNyRAAk6tmqnTQRIsAlXzoelOkaABMf4ebsBARI0KNEKxwiQ" +
  "4Bg/bzcgQIIGJVrhGAESHOPn7fMILDuJBMvQGlyFAAmqNCXnMgIkWIbW4CoESFClKTmXESDBMrQGVyGQS4Iq1ORsRYAEreq0" +
  "zB4CJNhDzTutCJCgVZ2W2UOABHuoeacVARJcUKcjcxEgQa4+pLmAAAkugO7IXARIkKsPaS4gQIILoDsyFwES5OqjU5oyu5Cg" +
  "TFWCriJAglVkzS1DgARlqhJ0FQESrCJrbhkCJChTlaCrCByTYFUqcxE4kQAJToTtqJwESJCzF6lOJECCE2E7KicBEuTsRaoT" +
  "CZDgA9ge6U2ABL37td0HBEjwASSP9CZAgt792u4DAiT4AJJHehMgQe9+t2w39lkSjK3e4jcCJLiR8DmWAAnGVm/xGwES3Ej4" +
  "HEuABGOrn7r4494keGTiyjACJBhWuHUfCZDgkYkrwwiQYFjh1n0kQIJHJq4MI9BSgmEdWvcgARIcBOj1+gRIUL9DGxwkQIKD" +
  "AL1enwAJ6ndog4MESHAQ4IWvOzqIAAmCQBpTlwAJ6nYneRABEgSBNKYuARLU7U7yIAIkCAJpzCoC6+eSYD1jJyQnQILkBYm3" +
  "ngAJ1jN2QnICJEhekHjrCZBgPWMnJCeQQoLkjMRrToAEzQu23u8ESPA7I080J0CC5gVb73cCJPidkSeaEyDBeQU7KSkBEiQt" +
  "RqzzCJDgPNZOSkqABEmLEes8AiQ4j7WTkhIgQdJi6saql5wE9TqTOJgACYKBGlePAAnqdSZxMAESBAM1rh4BEtTrTOJgArsk" +
  "CM5gHAKXEiDBpfgdnoEACTK0IMOlBEhwKX6HZyBAggwtyHApARK8xu/OEAIkGFK0NV8TIMFrNu4MIUCCIUVb8zUBErxm484Q" +
  "AiQYUvTrNd0hgd/AeAIkGP8TAIAEfgPjCZBg/E8AABL4Dcwg8GZLEryB49YMAiSY0bMt3xAgwRs4bs0gQIIZPdvyDQESvIHj" +
  "1gwCnSSY0ZgtwwmQIBypgdUIkKBaY/KGEyBBOFIDqxEgQbXG5A0nQIJwpKsHmh9NgATRRM0rR4AE5SoTOJoACaKJmleOAAnK" +
  "VSZwNAESRBM1L4bAiVNIcCJsR+UkQIKcvUh1IgESnAjbUTkJkCBnL1KdSIAEJ8J2VE4CV0qQk4hU4wiQYFzlFv5JgAQ/ifh7" +
  "HAESjKvcwj8JkOAnEX+PI0CC5ZU7IDsBEmRvSL7lBEiwHLEDshMgQfaG5FtOgATLETsgOwESZG+oSr7COUlQuDzRYwiQIIaj" +
  "KYUJ/AEAAP//0pBwMQAAAAZJREFUAwBiCcHCjxcq+gAAAABJRU5ErkJggg==";

const sameTaskContinuityPngBytes = Buffer.from(
  sameTaskContinuityPngDataUrl.slice("data:image/png;base64,".length),
  "base64",
);
const fixturePngCrcTable = Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; bit++) {
    crc = (crc & 1) === 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  }
  return crc >>> 0;
});
function fixturePngCrc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc = fixturePngCrcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function fixturePngWithout(...removedTypes) {
  const frames = [sameTaskContinuityPngBytes.subarray(0, 8)];
  let offset = 8;
  while (offset < sameTaskContinuityPngBytes.byteLength) {
    const length = sameTaskContinuityPngBytes.readUInt32BE(offset);
    const nextOffset = offset + 12 + length;
    const type = sameTaskContinuityPngBytes
      .subarray(offset + 4, offset + 8)
      .toString("ascii");
    if (!removedTypes.includes(type)) {
      frames.push(sameTaskContinuityPngBytes.subarray(offset, nextOffset));
    }
    offset = nextOffset;
  }
  return Buffer.concat(frames);
}
function fixturePngWithWidth(width) {
  const bytes = Buffer.from(sameTaskContinuityPngBytes);
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(fixturePngCrc32(bytes.subarray(12, 29)), 29);
  return bytes;
}
function fixturePngChunk(type, data) {
  const typeBytes = Buffer.from(type, "ascii");
  const frame = Buffer.alloc(12 + data.byteLength);
  frame.writeUInt32BE(data.byteLength, 0);
  typeBytes.copy(frame, 4);
  data.copy(frame, 8);
  frame.writeUInt32BE(
    fixturePngCrc32(Buffer.concat([typeBytes, data])),
    8 + data.byteLength,
  );
  return frame;
}
function fixturePngWithIdatPayload(payload) {
  const frames = [sameTaskContinuityPngBytes.subarray(0, 8)];
  let offset = 8;
  let replacementWritten = false;
  while (offset < sameTaskContinuityPngBytes.byteLength) {
    const length = sameTaskContinuityPngBytes.readUInt32BE(offset);
    const nextOffset = offset + 12 + length;
    const type = sameTaskContinuityPngBytes
      .subarray(offset + 4, offset + 8)
      .toString("ascii");
    if (type === "IDAT") {
      if (!replacementWritten) {
        frames.push(fixturePngChunk("IDAT", payload));
        replacementWritten = true;
      }
    } else {
      frames.push(sameTaskContinuityPngBytes.subarray(offset, nextOffset));
    }
    offset = nextOffset;
  }
  return Buffer.concat(frames);
}

const sha = "a".repeat(64);
const fingerprint = (file = "fixture") => ({
  file,
  exists: true,
  byteLength: 100,
  sha256: sha,
});
const absentFingerprint = (file = "fixture") => ({
  file,
  exists: false,
  byteLength: null,
  sha256: null,
  error: "ENOENT",
});
const gpuIdentity = (backend) => ({
  backend,
  rendererString:
    backend === "webgpu" ? "WebGPU - fixture" : "WebGL 2: fixture",
  adapterInfo:
    backend === "webgpu"
      ? { vendor: "fixture", architecture: "", device: "", description: "" }
      : null,
});

function syntheticBackend(renderer, overrides = {}) {
  const route = (actualPhysical, changes = {}) => ({
    moonShown: true,
    globeShown: true,
    globeVisible: true,
    globeClippingCollectionPresent: false,
    globeExecutionFilterActive: false,
    globeExecutionFilterStrategy: "none",
    depthPlaneSuppressed: false,
    globeCommandsSeen: 0,
    globeCommandsRejected: 0,
    globeCommandsAccepted: 0,
    moonOcclusionBypassActive: false,
    moonOcclusionBypassCalls: 0,
    controlRestored: true,
    actualPhysical,
    physicalCommands: actualPhysical ? 1 : 0,
    uniquePhysicalCommands: actualPhysical ? 1 : 0,
    physicalFrustumExecutions: actualPhysical ? 1 : 0,
    legacyCommandPresent: !actualPhysical,
    legacyVisible: !actualPhysical,
    ...changes,
  });
  const controlRoutes = (actualPhysical, combinedLegacyVisible = true) => ({
    combined: route(actualPhysical, {
      legacyVisible: actualPhysical ? false : combinedLegacyVisible,
    }),
    earthOnly: route(false, {
      moonShown: false,
      legacyCommandPresent: false,
      legacyVisible: false,
    }),
    moonWithSuppressedGlobe: route(actualPhysical, {
      globeExecutionFilterActive: true,
      globeExecutionFilterStrategy:
        "debug-command-filter:rendered-globe-tile-owner",
      depthPlaneSuppressed: true,
      globeCommandsSeen: 5,
      globeCommandsRejected: 5,
      moonOcclusionBypassActive: true,
      moonOcclusionBypassCalls: actualPhysical ? 0 : 5,
      controlRestored: true,
      legacyVisible: !actualPhysical,
    }),
  });
  const image = (kind) => ({
    file: `fixture.${kind}.png`,
    exists: true,
    byteLength: 100,
    sha256: sha,
  });
  const region = () => ({
    sampleCount: 64,
    errorP50: 0,
    errorP95: 0,
    errorMax: 0,
    aboveBandCount: 0,
    aboveBandFraction: 0,
  });
  const comparisons = expectedC1237ContinuityKeys().map((key) => {
    const [, transition, mode, repetitionText] = key.match(
      /^(entry|exit)-(raw|first-frame)-r([1-3])$/u,
    );
    const repetition = Number(repetitionText);
    const firstFrame = mode === "first-frame";
    const referencePhysical = firstFrame
      ? transition === "entry"
      : transition === "exit";
    const observedPhysical = transition === "entry";
    return {
      key,
      transition,
      mode,
      repetition,
      samePosition: true,
      gap: 1,
      fovDegrees: 20,
      routeProvenance: {
        reference: route(referencePhysical),
        observed: route(observedPhysical),
      },
      taaState: {
        reference: {
          sceneEnabled: firstFrame,
          effectEnabled: renderer === "webgpu" && firstFrame,
        },
        observed: {
          sceneEnabled: firstFrame,
          effectEnabled: renderer === "webgpu" && firstFrame,
        },
      },
      resetDeltas: {
        automatic: {
          before: 0,
          after: renderer === "webgpu" && firstFrame ? 1 : 0,
          delta: renderer === "webgpu" && firstFrame ? 1 : 0,
        },
        manual: {
          before: 0,
          after: renderer === "webgpu" && firstFrame ? 1 : 0,
          delta: renderer === "webgpu" && firstFrame ? 1 : 0,
        },
        enable: {
          before: 0,
          after:
            renderer === "webgpu" && firstFrame && transition === "entry"
              ? 1
              : 0,
          delta:
            renderer === "webgpu" && firstFrame && transition === "entry"
              ? 1
              : 0,
        },
      },
      mask: {
        method: "perspective-sphere-angular-radius+drawing-buffer-center",
        centerX: 96,
        centerY: 96,
        radiusPixels: 40,
        annulusPixels: 3,
        analyticSamples: 64,
        referenceVisibleSamples: 64,
        observedVisibleSamples: 64,
        observedOnlySamples: 0,
        unionSamples: 64,
      },
      regions: {
        unionSilhouette: region(),
        annulus: region(),
        interior: region(),
      },
      errorHistogram: [
        { minimumExclusive: -1, maximumInclusive: 0, count: 64 },
        ...[1, 2, 4, 8, 16, 32, 64, 128, 256, 512, 765].map(
          (maximumInclusive, index, edges) => ({
            minimumExclusive: index === 0 ? 0 : edges[index - 1],
            maximumInclusive,
            count: 0,
          }),
        ),
      ],
      errorLocations: [],
      images: {
        reference: image("reference"),
        observed: image("observed"),
        diff: image("diff"),
      },
    };
  });
  const continuityImages = comparisons.flatMap((comparison) =>
    ["reference", "observed", "diff"].map((kind) => ({
      renderer,
      comparisonKey: comparison.key,
      kind,
      ...comparison.images[kind],
    })),
  );
  const overlaps = C12_37_EXPECTED_OVERLAP_KEYS.map((key) => {
    const moonWins = key.startsWith("moon-near-");
    return {
      key,
      fixture: moonWins ? "moon-near" : "earth-near",
      ray: moonWins
        ? { moonDistance: 1, earthDistance: 2 }
        : { moonDistance: 2, earthDistance: 1 },
      route: {
        actualPhysical: moonWins,
        physicalCommands: moonWins ? 1 : 0,
        uniquePhysicalCommands: moonWins ? 1 : 0,
        physicalFrustumExecutions: moonWins ? 1 : 0,
      },
      fovDegrees: 60,
      controlRoutes: controlRoutes(moonWins, false),
      overlapScores: {
        geometricSampleCount: 64,
        scoredSampleCount: 64,
        winnerCloserFraction: 1,
        winnerErrorP95: 0,
        controlSeparationP50: 100,
      },
    };
  });
  const dualBodyMoonPresenceEvidence = {
    actualPhysical: true,
    physicalCommands: 1,
    uniquePhysicalCommands: 1,
    moonOwnedPhysicalCommands: 1,
    physicalFrustumExecutions: 1,
    legacyCommandPresent: false,
    legacyVisible: false,
  };
  return {
    ok: true,
    renderer,
    actualRenderer: renderer,
    gpuProvenance: gpuIdentity(renderer),
    webgpuDeviceEvidence: {
      applicable: renderer === "webgpu",
      devicePresent: renderer === "webgpu",
      uncapturedErrorListenerInstalledBeforeMeasurement: renderer === "webgpu",
      deviceLostObserverInstalledBeforeMeasurement: renderer === "webgpu",
      validationScopePushedBeforeMeasurement: renderer === "webgpu",
      validationErrorCount: 0,
      validationErrors: [],
      uncapturedErrors: [],
      deviceLostDuringMeasurement: false,
      deviceLostInfo: null,
      queueDrainedAfterMeasurement: renderer === "webgpu",
      postDrainEventTurn: renderer === "webgpu",
    },
    consoleErrors: [],
    preflight: { fullyBehind: true, moonVisible: false },
    overlaps,
    dualBodyNonOverlap: {
      fixture: "dual-body-non-overlap",
      fovDegrees: 100,
      bothBodiesShown: true,
      projectedSeparationPixels: 128,
      moonCommandPresent: true,
      moonPresenceEvidence: dualBodyMoonPresenceEvidence,
      moonPresence: assessC1237DualBodyMoonPresence(
        dualBodyMoonPresenceEvidence,
      ),
      controlRoutes: controlRoutes(true),
      globeCommandPresent: true,
      moonCenterRayHitsMoon: true,
      earthCenterRayHitsEarth: true,
      moonRegion: {
        sampleCount: 64,
        combinedErrorP95: 0,
        separationP50: 100,
      },
      earthRegion: {
        sampleCount: 64,
        combinedErrorP95: 0,
        separationP50: 100,
      },
    },
    multifrustum: {
      fovDegrees: 20,
      ray: { moonDistance: 1 },
      route: {
        actualPhysical: true,
        uniquePhysicalCommands: 1,
        activeFrustumCount: 4,
        physicalFrustumExecutions: 3,
        frusta: [{}, {}],
      },
      controlRoutes: controlRoutes(true),
      centerScore: {
        controlSeparation: 100,
        winnerError: 0,
        loserError: 100,
      },
    },
    crossing: {
      fovDegrees: 20,
      repetitionCount: 3,
      steps: [
        { label: "beforePrewarm", prewarm: false, actualPhysical: false },
        { label: "prewarm", prewarm: true, actualPhysical: false },
        { label: "beforeEntry", prewarm: true, actualPhysical: false },
        { label: "enter", actualPhysical: true },
        { label: "hold", actualPhysical: true },
        { label: "exit", actualPhysical: false },
      ],
      pipelineReadyBeforeEntry: true,
      pipelineFailed: false,
      runtimeConfiguration: {
        requestedMsaaSamples: renderer === "webgpu" ? 1 : null,
        effectiveMsaaSamplesAtStart: renderer === "webgpu" ? 1 : null,
        effectiveMsaaSamplesAtEnd: renderer === "webgpu" ? 1 : null,
        pipelineFormatGenerationAtStart: renderer === "webgpu" ? 7 : null,
        pipelineFormatGenerationAtEnd: renderer === "webgpu" ? 7 : null,
      },
      taaEffectAvailable: renderer === "webgpu",
      taaResetCount: renderer === "webgpu" ? 15 : 0,
      automaticTaaResetCount: renderer === "webgpu" ? 6 : 0,
      manualTaaResetCount: renderer === "webgpu" ? 6 : 0,
      enableTaaResetCount: renderer === "webgpu" ? 3 : 0,
      pinnedJitterFrameIndex: renderer === "webgpu" ? 424_242 : null,
      pinnedJitterCallCount: renderer === "webgpu" ? 15 : 0,
      comparisons,
    },
    continuityImagePublications: continuityImages,
    continuityImageVerification: structuredClone(continuityImages),
    ...overrides,
  };
}

function syntheticProvenance() {
  return {
    ok: true,
    reasons: [],
    gitHead: "b".repeat(40),
    localIdentity: { buildEntry: fingerprint("entry") },
  };
}

test("C12-37 uses exact f64 entry, one-radius exit, and prewarm-only margin", () => {
  const radius = 1737400.0;
  assert.equal(updateMoonPhysicalDepthDemand(false, 1.0e-6, radius), false);
  assert.equal(updateMoonPhysicalDepthDemand(false, 0.0, radius), true);
  assert.equal(updateMoonPhysicalDepthDemand(true, radius, radius), true);
  assert.equal(
    updateMoonPhysicalDepthDemand(true, radius + 1.0e-6, radius),
    false,
  );
  assert.equal(shouldPrewarmMoonPhysicalDepth(radius, radius), true);
  assert.equal(updateMoonPhysicalDepthDemand(false, radius, radius), false);

  const gap = computeMoonPhysicalDepthGap(
    { x: 1.0e9, y: 0.0, z: 0.0 },
    { x: 1.0e9 + radius + 1.0, y: 0.0, z: 0.0 },
    radius,
    6378137.0,
  );
  assert.ok(
    gap < 0.0,
    "Moon-near/Earth-far fixture must demand physical depth",
  );

  const distance = 384400000.0;
  const earthRadius = 6378137.0;
  const boundary = (distance - radius - earthRadius) * 0.5;
  assert.equal(
    computeMoonPhysicalDepthGap(
      { x: boundary - 0.25, y: 0.0, z: 0.0 },
      { x: distance, y: 0.0, z: 0.0 },
      radius,
      earthRadius,
    ),
    0.5,
  );
  assert.equal(
    computeMoonPhysicalDepthGap(
      { x: boundary + 0.25, y: 0.0, z: 0.0 },
      { x: distance, y: 0.0, z: 0.0 },
      radius,
      earthRadius,
    ),
    -0.5,
  );
});

test("the supplied saved view is STRUCTURAL, not a visible-Moon oracle", () => {
  // Settled browser ICRF values at 2026-08-10T15:45:30Z. The Moon is more
  // than 132 degrees from view center and wholly behind the camera.
  const camera = {
    x: 14417476.455457024,
    y: -308629935.37637526,
    z: 150404577.4052196,
  };
  const direction = {
    x: -0.041926717722495,
    y: 0.897510755173764,
    z: -0.43899498253219,
  };
  const moon = {
    x: 35303168.64999246,
    y: -326064075.14897263,
    z: 155682101.20976824,
  };
  const delta = {
    x: moon.x - camera.x,
    y: moon.y - camera.y,
    z: moon.z - camera.z,
  };
  const forward =
    delta.x * direction.x + delta.y * direction.y + delta.z * direction.z;
  const distance = Math.hypot(delta.x, delta.y, delta.z);
  const angle = Math.acos(forward / distance) * (180.0 / Math.PI);

  assert.ok(forward < -1737400.0, "the full Moon sphere must be behind camera");
  assert.ok(angle > 132.0);
});

test("shared ownership is decided before either backend and emits one route", () => {
  const decision = moonSource.indexOf("computeMoonPhysicalDepthGap(");
  const backendBranch = moonSource.indexOf(
    "context.getFeatureRenderer(FeatureRendererKey.MOON)",
  );
  assert.ok(decision >= 0 && decision < backendBranch);
  assert.match(moonSource, /gap <= \(wasPhysical \? moonRadius : 0\.0\)/);
  assert.match(moonSource, /gap <= moonRadius/);
  assert.match(moonSource, /scratchCommandList\.length === 1/);
  assert.match(moonSource, /sceneCommandList\.push\(command\)/);
  assert.match(moonSource, /return undefined;/);
});

test("physical route helpers remain private to Moon instead of expanding the API", () => {
  assert.equal(
    fs.existsSync(
      path.join(root, "packages/engine/Source/Scene/MoonDepthRoute.js"),
    ),
    false,
  );
  assert.doesNotMatch(engineIndex, /MoonDepthRoute/);
});

test("clearGlobeDepth stays unconditional across render and pick branches", () => {
  const updateEnvironment = sceneSource.indexOf("updateEnvironment() {");
  const clearAssignment = sceneSource.indexOf(
    "environmentState.clearGlobeDepth = clearGlobeDepth",
    updateEnvironment,
  );
  const earlyBranch = sceneSource.indexOf("!renderPass", updateEnvironment);
  assert.ok(updateEnvironment >= 0);
  assert.ok(
    clearAssignment > updateEnvironment && clearAssignment < earlyBranch,
  );
});

test("WebGL physical route is bounded OPAQUE depth with packed terrain compare", () => {
  assert.match(ellipsoidSource, /fs\.defines\.push\("MOON_PHYSICAL_DEPTH"\)/);
  assert.match(ellipsoidSource, /colorCommand\.occlude = !moonPhysicalDepth/);
  assert.match(ellipsoidSource, /_moonPhysicalDepthRoute = moonPhysicalDepth/);
  assert.match(ellipsoidFragment, /#ifdef MOON_PHYSICAL_GLOBE_DEPTH/);
  assert.match(ellipsoidFragment, /#ifdef MOON_PHYSICAL_DEPTH/);
  assert.match(ellipsoidFragment, /sliceDepth < 0\.0 \|\| sliceDepth > 1\.0/);
  assert.match(
    ellipsoidFragment,
    /\(positionCC\.w - czm_currentFrustum\.x\) \+ 1\.0/,
  );
  assert.match(ellipsoidFragment, /czm_globeDepthTexture/);
  assert.match(ellipsoidFragment, /moonDepth >= globeDepth/);
  assert.match(ellipsoidFragment, /gl_FragDepth = moonDepth/);
  assert.match(
    sceneSource,
    /skipHdrDerivedCommand = command\._moonPhysicalDepthRoute === true/,
  );
  assert.match(
    sceneSource,
    /scene\._hdr && command\._moonPhysicalDepthRoute !== true/,
  );
  assert.match(
    sceneSource,
    /derivedCommands\.logDepth\.command\._moonPhysicalDepthRoute\s*=\s*\n?\s*command\._moonPhysicalDepthRoute === true/,
  );
  assert.match(
    sceneRendererSource,
    /scene\._hdr &&\s*command\._moonPhysicalDepthRoute !== true/,
  );
});

test("WebGL physical log depth subtracts a nonzero slice near exactly once", () => {
  const clipW = 12_000_000.0;
  const near = 10_000_000.0;
  const far = 20_000_000.0;
  const factor = 1.0 / Math.log2(far - near + 1.0);
  const canonical = Math.log2(clipW - near + 1.0) * factor;
  const oldWrong = Math.log2(clipW + 1.0) * factor;
  assert.ok(canonical > 0.0 && canonical < 1.0);
  assert.ok(oldWrong > 1.0);
});

test("WebGPU physical route late-binds canonical depth without a bundle", () => {
  const physicalBuilderStart = webgpuRenderer.indexOf(
    "function buildPhysicalMoonPipelineResources",
  );
  const physicalBuilderEnd = webgpuRenderer.indexOf(
    "function createMoonTextureRequestHooks",
    physicalBuilderStart,
  );
  const physicalBuilder = webgpuRenderer.slice(
    physicalBuilderStart,
    physicalBuilderEnd,
  );
  assert.match(physicalBuilder, /entryPoint: "vsPhysical"/);
  assert.match(physicalBuilder, /entryPoint: "fsPhysical"/);
  assert.match(physicalBuilder, /targets: makeSceneFBTargets\(format\)/);
  assert.doesNotMatch(physicalBuilder, /blend:/);
  assert.match(physicalBuilder, /depthWriteEnabled: true/);

  assert.match(webgpuRenderer, /isWebGPULogDepthActive\(context, frameState\)/);
  assert.match(webgpuRenderer, /context\._globeDepthView/);
  assert.match(webgpuRenderer, /physicalExecutionCursor\+\+/);
  assert.match(webgpuRenderer, /executeInClosestFrustum: false/);
  assert.match(webgpuRenderer, /command\.bundle = undefined/);
  assert.match(webgpuRenderer, /command\._moonPhysicalDepthRoute = true/);
  assert.match(webgpuRenderer, /_physicalDepthPrewarmRequested === true/);
  assert.match(webgpuRenderer, /entry\.failed === true/);
  assert.match(webgpuRenderer, /tryResolvePhysicalMoonPipeline\(/);
  assert.match(webgpuRenderer, /retaining the legacy ENVIRONMENT route/);
  assert.match(moonWgsl, /@group\(0\) @binding\(4\)/);
  assert.match(moonWgsl, /@builtin\(frag_depth\)/);
  assert.match(moonWgsl, /fn fsPhysical/);
  assert.match(moonWgsl, /depthFromNearPlusOne > farDepthFromNearPlusOne/);
  assert.match(moonWgsl, /sliceDepth < 0\.0 \|\| sliceDepth > 1\.0/);
  assert.match(moonWgsl, /moonDepth >= globeDepth/);
});

test("camera-inside Moon keeps all intersecting frusta until depth ownership", () => {
  assert.doesNotMatch(
    ellipsoidSource,
    /executeInClosestFrustum\s*=\s*translucent \|\| moonPhysicalDepth/,
  );
  assert.match(ellipsoidSource, /executeInClosestFrustum = translucent/);
  assert.match(webgpuRenderer, /command\.executeInClosestFrustum = false/);
});

test("WebGPU physical depth obeys the renderer-wide log-depth master switch", () => {
  assert.equal(
    isWebGPULogDepthActive(
      { _logDepthWriteEnabled: false },
      { useLogDepth: true },
    ),
    false,
  );
  assert.equal(
    isWebGPULogDepthActive(
      { _logDepthWriteEnabled: true },
      { useLogDepth: true },
    ),
    true,
  );
  assert.match(
    webgpuRenderer,
    /slot\.uniformData\[69\] = isWebGPULogDepthActive\(context, frameState\)/,
  );
});

test("Earth-local octree and CPU/GPU Hi-Z remain conservative", () => {
  assert.match(octreeSource, /command\._moonPhysicalDepthRoute === true/);
  assert.match(occlusionSource, /command\.occlude === false/);
  assert.match(webgpuSceneRenderer, /commands\[i\]\.occlude === false/);
});

const runningMarker = (paths) => ({
  schema: "c12-37-moon-globe-depth-occlusion-v5",
  campaign: "C12-37",
  runId: paths.runId,
  status: "RUNNING",
  incomplete: true,
});

const finalArtifact = (paths, status = "ERROR") => ({
  schema: "c12-37-moon-globe-depth-occlusion-v5",
  campaign: "C12-37",
  runId: paths.runId,
  status,
  incomplete: false,
  exitCode: status === "PASS" ? 0 : 2,
});

const beginLifecycle = (paths) => {
  acquireC1237RunLock(paths);
  publishC1237Running(paths, runningMarker(paths));
};

test("C12-37 lifecycle is atomic, immutable, unique, and first-red write-once", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "c12-37-evidence-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const historical = path.join(
    directory,
    "campaign12-c12-37-moon-globe-depth-occlusion.json",
  );
  fs.writeFileSync(historical, "historical-green\n");
  const historicalBefore = fs.readFileSync(historical);

  const firstPaths = createC1237ArtifactPaths(directory, randomUUID());
  beginLifecycle(firstPaths);
  assert.equal(
    JSON.parse(fs.readFileSync(firstPaths.latest)).status,
    "RUNNING",
  );
  const first = finalizeC1237Evidence(
    firstPaths,
    finalArtifact(firstPaths, "FAIL"),
  );
  assert.equal(first.firstRed.written, true);
  const firstRedBytes = fs.readFileSync(firstPaths.firstRed);
  assert.deepEqual(fs.readFileSync(historical), historicalBefore);
  assert.throws(
    () => finalizeC1237Evidence(firstPaths, finalArtifact(firstPaths, "PASS")),
    /run lock is absent/u,
  );

  const secondPaths = createC1237ArtifactPaths(directory, randomUUID());
  beginLifecycle(secondPaths);
  // A new invocation immediately removes the prior canonical PASS/FAIL claim.
  assert.equal(
    JSON.parse(fs.readFileSync(secondPaths.latest)).status,
    "RUNNING",
  );
  const second = finalizeC1237Evidence(secondPaths, finalArtifact(secondPaths));
  assert.equal(second.firstRed.written, false);
  assert.deepEqual(fs.readFileSync(secondPaths.firstRed), firstRedBytes);
  assert.deepEqual(fs.readFileSync(historical), historicalBefore);
  assert.notEqual(firstPaths.run, secondPaths.run);
  assert.equal(
    fs.readdirSync(directory).filter((file) => file.endsWith(".receipt"))
      .length,
    0,
  );
});

test("C12-37 continuity PNG validation fails closed on every structural boundary", () => {
  assert.deepEqual(validateC1237ContinuityPng(sameTaskContinuityPngBytes), {
    width: 193,
    height: 193,
    bitDepth: 8,
    colorType: 6,
    idatCount: 2,
  });

  const malformedLength = Buffer.from(sameTaskContinuityPngBytes);
  malformedLength.writeUInt32BE(0x80000000, 8);
  const badCrc = Buffer.from(sameTaskContinuityPngBytes);
  badCrc[29] ^= 1;
  const decodedByteLength = (1 + 193 * 4) * 193;
  const wrongScanlineLength = fixturePngWithIdatPayload(
    deflateSync(Buffer.alloc(decodedByteLength - 1)),
  );
  const invalidFilterScanlines = Buffer.alloc(decodedByteLength);
  invalidFilterScanlines[0] = 5;
  const validEmptyScanlines = Buffer.alloc(decodedByteLength);
  const trailingCompressedBytes = fixturePngWithIdatPayload(
    Buffer.concat([deflateSync(validEmptyScanlines), Buffer.from([0])]),
  );
  const mutants = [
    [
      "truncated chunk",
      sameTaskContinuityPngBytes.subarray(
        0,
        sameTaskContinuityPngBytes.byteLength - 5,
      ),
      /truncated chunk frame|malformed chunk length/u,
    ],
    ["missing IHDR", fixturePngWithout("IHDR"), /IHDR is not the first/u],
    ["malformed length", malformedLength, /malformed chunk length/u],
    ["bad CRC", badCrc, /IHDR CRC is invalid/u],
    ["missing IDAT", fixturePngWithout("IDAT"), /missing IDAT/u],
    [
      "invalid zlib stream",
      fixturePngWithIdatPayload(Buffer.from([0])),
      /IDAT zlib stream is invalid/u,
    ],
    [
      "wrong decoded scanline length",
      wrongScanlineLength,
      /decoded scanlines must contain exactly/u,
    ],
    [
      "invalid row filter",
      fixturePngWithIdatPayload(deflateSync(invalidFilterScanlines)),
      /row 0 has invalid filter 5/u,
    ],
    [
      "trailing compressed bytes",
      trailingCompressedBytes,
      /trailing compressed bytes/u,
    ],
    ["missing IEND", fixturePngWithout("IEND"), /missing IEND/u],
    [
      "trailing bytes",
      Buffer.concat([sameTaskContinuityPngBytes, Buffer.from([0])]),
      /trailing bytes after IEND/u,
    ],
    [
      "wrong dimensions",
      fixturePngWithWidth(192),
      /dimensions must be 193x193/u,
    ],
  ];
  for (const [name, bytes, expected] of mutants) {
    assert.throws(
      () => validateC1237ContinuityPng(bytes),
      expected,
      `${name} mutant must fail closed`,
    );
  }
});

test("C12-37 continuity PNGs are UUID-bound, immutable, and removed from JSON payloads", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "c12-37-pngs-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const paths = createC1237ArtifactPaths(directory, randomUUID());
  const result = {
    renderer: "webgpu",
    crossing: {
      comparisons: [
        {
          key: "entry-raw-r1",
          repetition: 1,
          imageDataUrls: {
            reference: sameTaskContinuityPngDataUrl,
            observed: sameTaskContinuityPngDataUrl,
            diff: sameTaskContinuityPngDataUrl,
          },
        },
      ],
    },
  };
  const publications = publishC1237ContinuityImages(paths, result);
  assert.equal(publications.length, 3);
  assert.equal(result.crossing.comparisons[0].imageDataUrls, undefined);
  for (const kind of ["reference", "observed", "diff"]) {
    const image = result.crossing.comparisons[0].images[kind];
    assert.equal(image.exists, true);
    assert.match(image.file, new RegExp(paths.runId, "u"));
    assert.match(image.file, new RegExp(`\\.${kind}\\.png$`, "u"));
  }
  assert.throws(
    () => verifyC1237ContinuityImages(paths, result),
    /expected 36 verified continuity PNGs/u,
  );
  assert.throws(
    () =>
      publishC1237ContinuityImages(paths, {
        renderer: "webgpu",
        crossing: {
          comparisons: [
            {
              key: "entry-raw-r1",
              imageDataUrls: {
                reference: sameTaskContinuityPngDataUrl,
                observed: sameTaskContinuityPngDataUrl,
                diff: sameTaskContinuityPngDataUrl,
              },
            },
          ],
        },
      }),
    /EEXIST/u,
  );
  const invalidImageResult = {
    renderer: "webgpu",
    crossing: {
      comparisons: [
        {
          key: "invalid-png-r1",
          imageDataUrls: {
            reference: "data:image/png;base64,AA==",
            observed: sameTaskContinuityPngDataUrl,
            diff: sameTaskContinuityPngDataUrl,
          },
        },
      ],
    },
  };
  assert.throws(
    () => publishC1237ContinuityImages(paths, invalidImageResult),
    /invalid PNG signature/u,
  );
  assert.equal(
    invalidImageResult.crossing.comparisons[0].imageDataUrls,
    undefined,
  );
  result.crossing.comparisons = [
    ...result.crossing.comparisons,
    ...expectedC1237ContinuityKeys()
      .filter((key) => key !== "entry-raw-r1")
      .map((key) => ({
        key,
        repetition: Number(key.at(-1)),
        imageDataUrls: {
          reference: sameTaskContinuityPngDataUrl,
          observed: sameTaskContinuityPngDataUrl,
          diff: sameTaskContinuityPngDataUrl,
        },
      })),
  ];
  publishC1237ContinuityImages(paths, result);
  assert.equal(verifyC1237ContinuityImages(paths, result).length, 36);
  fs.writeFileSync(
    result.crossing.comparisons[1].images.diff.file,
    Buffer.from("tampered\n"),
  );
  assert.throws(
    () => verifyC1237ContinuityImages(paths, result),
    /changed after publication/u,
  );
});

test("C12-37 strips pending PNG data URLs when a later backend aborts", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "c12-37-png-abort-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  let backendCalls = 0;
  const closeableBrowser = {
    close: async () => {},
  };
  const result = await runC1237Probe({
    outputDirectory: directory,
    runId: randomUUID(),
    collectProvenance: async () => ({ ok: true, reasons: [] }),
    launchBrowser: async () => closeableBrowser,
    runBackend: async (_browser, renderer) => {
      backendCalls++;
      if (backendCalls === 2) {
        throw new Error("synthetic second-backend abort");
      }
      return {
        ok: true,
        renderer,
        crossing: {
          comparisons: [
            {
              key: "entry-raw-r1",
              repetition: 1,
              imageDataUrls: {
                reference: sameTaskContinuityPngDataUrl,
                observed: sameTaskContinuityPngDataUrl,
                diff: sameTaskContinuityPngDataUrl,
              },
            },
          ],
        },
      };
    },
    hardLimitMs: 1_000,
    operationTimeouts: {
      browserClose: 100,
      losingTaskDrain: 100,
    },
  });
  assert.equal(result.artifact.status, "ERROR");
  assert.match(result.artifact.error, /second-backend abort/u);
  assert.equal(
    result.artifact.results[0].crossing.comparisons[0].imageDataUrls,
    undefined,
  );
  assert.doesNotMatch(
    fs.readFileSync(result.paths.run, "utf8"),
    /data:image\/png;base64/u,
  );
  process.exitCode = 0;
});

test("C12-37 finalizes a clipping-control backend fault as FAIL with only verified prior-backend images", async (t) => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "c12-37-clipping-fault-"),
  );
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const clippingFault =
    "page.evaluate: TypeError: this._clippingPlanesTexture.destroy is not a function";
  const result = await runC1237Probe({
    outputDirectory: directory,
    runId: randomUUID(),
    collectProvenance: async () => syntheticProvenance(),
    launchBrowser: async () => ({ close: async () => {} }),
    runBackend: async (_browser, renderer) => {
      if (renderer === "webgpu") {
        return {
          ok: false,
          renderer,
          consoleErrors: [],
          error: clippingFault,
        };
      }
      const backend = syntheticBackend("webgl");
      backend.runtimeEntry = {
        sessionLabel: "webgl",
        url: "http://localhost:8090/Build/CesiumUnminified/index.js",
        ok: true,
        status: 200,
        byteLength: 100,
        sha256: sha,
      };
      for (const comparison of backend.crossing.comparisons) {
        comparison.imageDataUrls = {
          reference: sameTaskContinuityPngDataUrl,
          observed: sameTaskContinuityPngDataUrl,
          diff: sameTaskContinuityPngDataUrl,
        };
      }
      return backend;
    },
    hardLimitMs: 1_000,
    operationTimeouts: {
      browserClose: 100,
      losingTaskDrain: 100,
    },
  });

  assert.equal(result.artifact.status, "FAIL");
  assert.equal(result.artifact.incomplete, false);
  assert.match(result.artifact.failures.join("\n"), /clippingPlanesTexture/u);
  assert.equal(
    result.artifact.results[0].continuityImagePublications.length,
    36,
  );
  assert.equal(
    result.artifact.results[0].continuityImageVerification.length,
    36,
  );
  assert.equal(result.artifact.results[1].ok, false);
  assert.equal(result.artifact.results[1].error, clippingFault);
  assert.equal(
    fs.readdirSync(directory).filter((file) => file.endsWith(".png")).length,
    36,
  );
  assert.doesNotMatch(fs.readFileSync(result.paths.run, "utf8"), /data:image/u);
  assert.deepEqual(
    fs.readFileSync(result.paths.latest),
    fs.readFileSync(result.paths.run),
  );
  assert.equal(fs.existsSync(result.paths.lock), false);
  process.exitCode = 0;
});

test("C12-37 lifecycle rejects cross-run ownership and malformed final states", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "c12-37-owner-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const paths = createC1237ArtifactPaths(directory, randomUUID());
  acquireC1237RunLock(paths);
  assert.throws(
    () =>
      publishC1237Running(paths, {
        runId: randomUUID(),
        status: "RUNNING",
        incomplete: true,
      }),
    /does not own/u,
  );
  assert.throws(
    () =>
      finalizeC1237Evidence(paths, {
        runId: paths.runId,
        status: "PASS",
        incomplete: true,
      }),
    /malformed/u,
  );
  publishC1237Running(paths, runningMarker(paths));
  fs.writeFileSync(
    paths.latest,
    `${JSON.stringify({ runId: randomUUID(), status: "RUNNING", incomplete: true })}\n`,
  );
  assert.throws(
    () => finalizeC1237Evidence(paths, finalArtifact(paths)),
    /ownership was lost/u,
  );
  assert.throws(
    () => createC1237ArtifactPaths(directory, "not-a-run-id"),
    /UUID v4/u,
  );
});

test("C12-37 prior lifecycle archives accept v2-v5 only with UUID-v4 path identity", (t) => {
  const rootDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), "c12-37-prior-schema-"),
  );
  t.after(() => fs.rmSync(rootDirectory, { recursive: true, force: true }));

  for (const version of [2, 3, 4, 5]) {
    const directory = path.join(rootDirectory, `v${version}`);
    fs.mkdirSync(directory);
    const paths = createC1237ArtifactPaths(directory, randomUUID());
    const priorRunId = randomUUID();
    const priorBytes = Buffer.from(
      `${JSON.stringify({
        schema: `c12-37-moon-globe-depth-occlusion-v${version}`,
        runId: priorRunId,
        status: "PASS",
        incomplete: false,
      })}\n`,
    );
    fs.writeFileSync(paths.latest, priorBytes);
    fs.writeFileSync(paths.archiveForRunId(priorRunId), priorBytes, {
      flag: "wx",
    });
    const prepared = prepareCapturedC1237LatestForRun(
      captureC1237PriorLatest(paths.latest),
      paths,
    );
    assert.equal(prepared.mode, "prior-lifecycle-run");
    assert.deepEqual(
      fs.readFileSync(prepared.immutableRunArtifact.file),
      priorBytes,
    );
  }

  const directory = path.join(rootDirectory, "traversal");
  fs.mkdirSync(directory);
  const paths = createC1237ArtifactPaths(directory, randomUUID());
  const traversalRunId = "../../outside/00000000-0000-4000-8000-000000000000";
  assert.throws(
    () => paths.archiveForRunId(traversalRunId),
    /prior C12-37 runId must be a UUID v4/u,
  );
  const traversalBytes = Buffer.from(
    `${JSON.stringify({
      schema: "c12-37-moon-globe-depth-occlusion-v2",
      runId: traversalRunId,
      status: "PASS",
      incomplete: false,
    })}\n`,
  );
  fs.writeFileSync(paths.latest, traversalBytes);
  assert.throws(
    () =>
      prepareCapturedC1237LatestForRun(
        captureC1237PriorLatest(paths.latest),
        paths,
      ),
    /prior C12-37 latest lifecycle state is unsupported/u,
  );
  assert.deepEqual(fs.readFileSync(paths.priorQuarantine), traversalBytes);
});

test("C12-37 owned RUNNING precedes fallible preflight and preserves malformed or empty prior bytes", async (t) => {
  const rootDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), "c12-37-preflight-"),
  );
  t.after(() => fs.rmSync(rootDirectory, { recursive: true, force: true }));

  const absent = absentFingerprint();
  const provenanceFailure = async () => {
    throw new Error("synthetic provenance preflight failure");
  };
  const launchMustNotRun = async () => {
    throw new Error("browser launch must not run");
  };

  // runC1237Probe itself must invalidate a seeded PASS before a provenance
  // throw, finalize ERROR, release ownership, and never launch a browser.
  {
    const directory = path.join(rootDirectory, "preflight-throw");
    fs.mkdirSync(directory);
    const priorRunId = randomUUID();
    const priorPaths = createC1237ArtifactPaths(directory, priorRunId);
    const prior = `${JSON.stringify({
      schema: "c12-37-moon-globe-depth-occlusion-v2",
      runId: priorRunId,
      status: "PASS",
      incomplete: false,
    })}\n`;
    fs.writeFileSync(priorPaths.latest, prior);
    fs.writeFileSync(priorPaths.run, prior, { flag: "wx" });
    const runId = randomUUID();
    const result = await runC1237Probe({
      outputDirectory: directory,
      runId,
      collectProvenance: provenanceFailure,
      launchBrowser: launchMustNotRun,
      hardLimitMs: 1_000,
      operationTimeouts: { losingTaskDrain: 100 },
    });
    assert.equal(result.artifact.status, "ERROR");
    assert.match(result.artifact.error, /preflight failure/u);
    assert.equal(JSON.parse(fs.readFileSync(result.paths.latest)).runId, runId);
    assert.deepEqual(
      fs.readFileSync(result.paths.latest),
      fs.readFileSync(result.paths.run),
    );
    assert.equal(fs.existsSync(result.paths.lock), false);
    process.exitCode = 0;
  }

  for (const [caseName, priorBytes] of [
    ["malformed", Buffer.from("{broken\n")],
    ["zero-byte", Buffer.alloc(0)],
  ]) {
    const directory = path.join(rootDirectory, caseName);
    fs.mkdirSync(directory);
    const paths = createC1237ArtifactPaths(directory, randomUUID());
    fs.writeFileSync(paths.latest, priorBytes);
    acquireC1237RunLock(paths);
    const captured = captureC1237PriorLatest(paths.latest);
    assert.equal(captured.latest.exists, true);
    assert.equal(captured.latest.byteLength, priorBytes.byteLength);
    publishC1237Running(paths, runningMarker(paths));
    assert.throws(
      () => prepareCapturedC1237LatestForRun(captured, paths),
      /exact bytes quarantined/u,
    );
    assert.deepEqual(fs.readFileSync(paths.priorQuarantine), priorBytes);
    const result = finalizeC1237Evidence(paths, finalArtifact(paths));
    assert.equal(result.lockReleased, true);
    assert.equal(fs.existsSync(paths.lock), false);
    assert.equal(absent.exists, false);
  }
});

test("C12-37 preserves a genuine prior RUNNING marker and refuses the new invocation", async (t) => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "c12-37-prior-running-"),
  );
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const paths = createC1237ArtifactPaths(directory, randomUUID());
  const priorBytes = `${JSON.stringify({
    schema: "c12-37-moon-globe-depth-occlusion-v2",
    runId: randomUUID(),
    status: "RUNNING",
    incomplete: true,
  })}\n`;
  fs.writeFileSync(paths.latest, priorBytes);
  await assert.rejects(
    runC1237Probe({ outputDirectory: directory, runId: paths.runId }),
    /previous C12-37 RUNNING marker/u,
  );
  assert.equal(fs.readFileSync(paths.latest, "utf8"), priorBytes);
  assert.equal(fs.existsSync(paths.lock), false);
});

test("C12-37 restores owned RUNNING and retains the lock on final verification/release faults", (t) => {
  const rootDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), "c12-37-final-faults-"),
  );
  t.after(() => fs.rmSync(rootDirectory, { recursive: true, force: true }));

  const executeFault = (caseName, makeOperations) => {
    const directory = path.join(rootDirectory, caseName);
    fs.mkdirSync(directory);
    const paths = createC1237ArtifactPaths(directory, randomUUID());
    beginLifecycle(paths);
    const operations = makeOperations(paths);
    assert.throws(
      () =>
        finalizeC1237Evidence(paths, finalArtifact(paths, "PASS"), operations),
      /owned RUNNING marker restored/u,
    );
    assert.deepEqual(
      JSON.parse(fs.readFileSync(paths.latest)),
      runningMarker(paths),
    );
    assert.equal(fs.existsSync(paths.lock), true);
    assert.deepEqual(fs.readFileSync(paths.run), fs.readFileSync(paths.run));
    releaseC1237RunLock(paths);
  };

  executeFault("post-replace-read", (paths) => {
    let latestReads = 0;
    return {
      ...fs,
      readFileSync(file, ...args) {
        if (path.resolve(file) === path.resolve(paths.latest)) {
          latestReads++;
          if (latestReads === 2) {
            const error = new Error("synthetic post-final read failure");
            error.code = "EACCES";
            throw error;
          }
        }
        return fs.readFileSync(file, ...args);
      },
    };
  });

  executeFault("post-replace-mismatch", (paths) => {
    let latestReads = 0;
    return {
      ...fs,
      readFileSync(file, ...args) {
        if (path.resolve(file) === path.resolve(paths.latest)) {
          latestReads++;
          if (latestReads === 2) {
            return Buffer.from("fabricated final bytes\n");
          }
        }
        return fs.readFileSync(file, ...args);
      },
    };
  });

  executeFault("release", (paths) => ({
    ...fs,
    unlinkSync(file) {
      if (String(file).endsWith(".receipt")) {
        throw new Error("synthetic release failure");
      }
      return fs.unlinkSync(file);
    },
  }));

  // Ambiguous unlink: delete the lock and then throw. Finalization must
  // recreate this run's exact ownership before restoring RUNNING.
  executeFault("release-after-delete", (paths) => ({
    ...fs,
    unlinkSync(file) {
      if (String(file).endsWith(".receipt")) {
        fs.unlinkSync(file);
        throw new Error("synthetic release failure after delete");
      }
      return fs.unlinkSync(file);
    },
  }));
});

test("C12-37 release claim preserves a late foreign lock and RUNNING latest", (t) => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "c12-37-release-interleave-"),
  );
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const paths = createC1237ArtifactPaths(directory, randomUUID());
  beginLifecycle(paths);

  const foreignRunId = randomUUID();
  const foreignLockBytes = Buffer.from(
    `${JSON.stringify(
      {
        runId: foreignRunId,
        acquiredAt: "2026-08-12T22:00:00.000Z",
      },
      null,
      2,
    )}\n`,
  );
  const foreignLatestBytes = Buffer.from(
    `${JSON.stringify(
      {
        schema: "c12-37-moon-globe-depth-occlusion-v5",
        runId: foreignRunId,
        status: "RUNNING",
        incomplete: true,
      },
      null,
      2,
    )}\n`,
  );
  let interleaved = false;
  const operations = {
    ...fs,
    renameSync(from, to) {
      if (
        !interleaved &&
        path.resolve(from) === path.resolve(paths.lock) &&
        String(to).endsWith(".receipt")
      ) {
        interleaved = true;
        // This is the exact old read -> atomic claim boundary. A competing run
        // swaps both authority records before the rename captures the pathname.
        // The synthetic post-rename throw also makes syscall completion
        // ambiguous, so recovery cannot rely on the return value.
        fs.writeFileSync(paths.lock, foreignLockBytes);
        fs.writeFileSync(paths.latest, foreignLatestBytes);
        fs.renameSync(from, to);
        throw new Error("synthetic rename failure after foreign claim");
      }
      return fs.renameSync(from, to);
    },
  };

  assert.throws(
    () => finalizeC1237Evidence(paths, finalArtifact(paths), operations),
    /RUNNING restoration failed; run lock retained/u,
  );
  assert.equal(interleaved, true);
  assert.deepEqual(fs.readFileSync(paths.lock), foreignLockBytes);
  assert.deepEqual(fs.readFileSync(paths.latest), foreignLatestBytes);
  const receipts = fs
    .readdirSync(directory)
    .filter((file) => file.endsWith(".receipt"));
  assert.equal(receipts.length, 1);
  assert.deepEqual(
    fs.readFileSync(path.join(directory, receipts[0])),
    foreignLockBytes,
  );
});

test("C12-37 RUNNING rollback cannot overwrite authority arriving at exclusive publication", (t) => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "c12-37-rollback-interleave-"),
  );
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const paths = createC1237ArtifactPaths(directory, randomUUID());
  beginLifecycle(paths);

  const foreignRunId = randomUUID();
  const foreignLockBytes = Buffer.from(
    `${JSON.stringify({ runId: foreignRunId, acquiredAt: "late" })}\n`,
  );
  const foreignLatestBytes = Buffer.from(
    `${JSON.stringify({
      schema: "c12-37-moon-globe-depth-occlusion-v5",
      runId: foreignRunId,
      status: "RUNNING",
      incomplete: true,
    })}\n`,
  );
  let releaseFailed = false;
  let interleaved = false;
  const operations = {
    ...fs,
    unlinkSync(file) {
      if (String(file).endsWith(".receipt") && !releaseFailed) {
        releaseFailed = true;
        throw new Error("force finalization into RUNNING rollback");
      }
      return fs.unlinkSync(file);
    },
    writeFileSync(file, bytes, options) {
      if (
        releaseFailed &&
        !interleaved &&
        path.resolve(file) === path.resolve(paths.latest) &&
        options?.flag === "wx"
      ) {
        interleaved = true;
        // The rollback has claimed this invocation's final latest into its
        // receipt. A competing invocation now atomically owns both canonical
        // authority paths immediately before our exclusive RUNNING publish.
        fs.unlinkSync(paths.lock);
        fs.writeFileSync(paths.lock, foreignLockBytes, { flag: "wx" });
        fs.writeFileSync(paths.latest, foreignLatestBytes, { flag: "wx" });
      }
      return fs.writeFileSync(file, bytes, options);
    },
  };

  assert.throws(
    () => finalizeC1237Evidence(paths, finalArtifact(paths), operations),
    /RUNNING restoration failed; run lock retained/u,
  );
  assert.equal(releaseFailed, true);
  assert.equal(interleaved, true);
  assert.deepEqual(fs.readFileSync(paths.lock), foreignLockBytes);
  assert.deepEqual(fs.readFileSync(paths.latest), foreignLatestBytes);
});

test("C12-37 RUNNING restoration retries atomic failure and reports irrecoverable rollback", (t) => {
  const rootDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), "c12-37-restore-faults-"),
  );
  t.after(() => fs.rmSync(rootDirectory, { recursive: true, force: true }));

  {
    const directory = path.join(rootDirectory, "retry");
    fs.mkdirSync(directory);
    const paths = createC1237ArtifactPaths(directory, randomUUID());
    beginLifecycle(paths);
    let lockReleaseFailed = false;
    let restoreRenameFailed = false;
    const operations = {
      ...fs,
      unlinkSync(file) {
        if (String(file).endsWith(".receipt") && !lockReleaseFailed) {
          lockReleaseFailed = true;
          throw new Error("release failure");
        }
        return fs.unlinkSync(file);
      },
      renameSync(from, to) {
        if (
          lockReleaseFailed &&
          path.resolve(from) === path.resolve(paths.latest) &&
          String(to).includes(".running-restore-") &&
          !restoreRenameFailed
        ) {
          restoreRenameFailed = true;
          throw new Error("first restore rename failure");
        }
        return fs.renameSync(from, to);
      },
    };
    assert.throws(
      () => finalizeC1237Evidence(paths, finalArtifact(paths), operations),
      /owned RUNNING marker restored/u,
    );
    assert.equal(JSON.parse(fs.readFileSync(paths.latest)).status, "RUNNING");
    assert.equal(fs.existsSync(paths.lock), true);
    assert.equal(restoreRenameFailed, true);
    releaseC1237RunLock(paths);
  }

  {
    const directory = path.join(rootDirectory, "irrecoverable");
    fs.mkdirSync(directory);
    const paths = createC1237ArtifactPaths(directory, randomUUID());
    beginLifecycle(paths);
    let releaseFailed = false;
    const operations = {
      ...fs,
      unlinkSync(file) {
        if (String(file).endsWith(".receipt")) {
          releaseFailed = true;
          throw new Error("release failure");
        }
        return fs.unlinkSync(file);
      },
      renameSync(from, to) {
        if (
          releaseFailed &&
          path.resolve(from) === path.resolve(paths.latest) &&
          String(to).includes(".running-restore-")
        ) {
          throw new Error("restore rename failure");
        }
        return fs.renameSync(from, to);
      },
    };
    assert.throws(
      () => finalizeC1237Evidence(paths, finalArtifact(paths), operations),
      /RUNNING restoration failed; run lock retained/u,
    );
    assert.equal(fs.existsSync(paths.lock), true);
  }
});

test("C12-37 watchdog closes and drains, while a hung loser remains RUNNING", async (t) => {
  const makeControl = (browser) => ({
    abortController: new AbortController(),
    browser,
    browserClosed: false,
    browserCloseAttempted: false,
    browserClosePromise: null,
    cleanupErrors: [],
    tracker: createC1237OperationTracker(),
    timeouts: { browserClose: 100 },
    measurementTaskDrained: false,
    watchdogTimedOut: false,
    watchdogCloseAttempted: false,
  });
  let releaseTask;
  const task = new Promise((resolve) => {
    releaseTask = resolve;
  });
  const control = makeControl({ close: async () => releaseTask("closed") });
  await assert.rejects(
    withC1237Watchdog(task, control, 10, 100),
    /whole-probe watchdog/u,
  );
  assert.equal(control.watchdogTimedOut, true);
  assert.equal(control.browserClosed, true);
  assert.equal(control.measurementTaskDrained, true);

  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "c12-37-hung-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const runId = randomUUID();
  const never = new Promise(() => {});
  await assert.rejects(
    runC1237Probe({
      outputDirectory: directory,
      runId,
      collectProvenance: () => never,
      hardLimitMs: 10,
      operationTimeouts: { losingTaskDrain: 20, browserClose: 20 },
    }),
    /RUNNING marker and lock retained/u,
  );
  const paths = createC1237ArtifactPaths(directory, runId);
  assert.equal(JSON.parse(fs.readFileSync(paths.latest)).status, "RUNNING");
  assert.equal(fs.existsSync(paths.lock), true);
});

test("C12-37 provenance fails closed for source, served build, evidence, and GPU drift", () => {
  const start = syntheticProvenance();
  const end = structuredClone(start);
  const results = [syntheticBackend("webgl"), syntheticBackend("webgpu")];
  const servedEntries = ["webgl", "webgpu"].map((sessionLabel) => ({
    sessionLabel,
    ok: true,
    status: 200,
    byteLength: 100,
    sha256: sha,
  }));
  const absent = absentFingerprint();
  const assess = (changes = {}) =>
    assessC1237Provenance({
      start,
      end,
      results,
      servedEntries,
      historicalAtStart: absent,
      historicalAtEnd: absent,
      firstRedAtStart: absent,
      firstRedAtEnd: absent,
      ...changes,
    });
  assert.equal(assess().ok, true);

  const changedSource = structuredClone(end);
  changedSource.localIdentity.buildEntry.sha256 = "c".repeat(64);
  assert.equal(assess({ end: changedSource }).ok, false);
  assert.equal(
    assess({
      servedEntries: servedEntries.map((entry, index) =>
        index === 0 ? { ...entry, sha256: "d".repeat(64) } : entry,
      ),
    }).ok,
    false,
  );
  assert.equal(
    assess({ historicalAtEnd: fingerprint("changed-history") }).ok,
    false,
  );
  assert.equal(
    assess({
      results: [
        results[0],
        {
          ...results[1],
          gpuProvenance: { ...results[1].gpuProvenance, adapterInfo: null },
        },
      ],
    }).ok,
    false,
  );
});

test("C12-37 acceptance rejects vacuous center, route controls, continuity, and reset provenance", () => {
  const expectFailure = (result, pattern) => {
    const failures = [];
    validateC1237Backend(result, failures);
    assert.match(failures.join("\n"), pattern);
  };
  const green = syntheticBackend("webgpu");
  const failures = [];
  validateC1237Backend(green, failures);
  assert.deepEqual(failures, []);

  for (const steps of [
    green.crossing.steps.filter((step) => step.label !== "beforeEntry"),
    green.crossing.steps.toReversed(),
    [...green.crossing.steps, { ...green.crossing.steps[0] }],
  ]) {
    expectFailure(
      syntheticBackend("webgpu", {
        crossing: { ...green.crossing, steps },
      }),
      /route crossing steps or diagnostic FOV are incomplete/u,
    );
  }

  for (const overlaps of [
    [],
    green.overlaps.slice(0, 9),
    [...green.overlaps.slice(0, 9), green.overlaps[0]],
    [
      ...green.overlaps.slice(0, 9),
      { ...green.overlaps[9], key: "fabricated-extra-lane" },
    ],
  ]) {
    expectFailure(
      syntheticBackend("webgpu", { overlaps }),
      /expected exactly 10 unique overlap lanes/u,
    );
  }

  for (const dualBodyNonOverlap of [
    { ...green.dualBodyNonOverlap, bothBodiesShown: false },
    { ...green.dualBodyNonOverlap, moonCommandPresent: false },
    {
      ...green.dualBodyNonOverlap,
      // A hardcoded public boolean must not hide contradictory measured
      // command-list evidence.
      moonCommandPresent: true,
      moonPresenceEvidence: {
        ...green.dualBodyNonOverlap.moonPresenceEvidence,
        moonOwnedPhysicalCommands: 0,
      },
    },
    { ...green.dualBodyNonOverlap, globeCommandPresent: false },
    { ...green.dualBodyNonOverlap, projectedSeparationPixels: 0 },
    {
      ...green.dualBodyNonOverlap,
      moonRegion: { ...green.dualBodyNonOverlap.moonRegion, sampleCount: 0 },
    },
    {
      ...green.dualBodyNonOverlap,
      earthRegion: {
        ...green.dualBodyNonOverlap.earthRegion,
        combinedErrorP95: 17,
      },
    },
  ]) {
    expectFailure(
      syntheticBackend("webgpu", { dualBodyNonOverlap }),
      /dual-body non-overlap PVS/u,
    );
  }

  for (const deviceMutation of [
    { devicePresent: false },
    { uncapturedErrorListenerInstalledBeforeMeasurement: false },
    { deviceLostObserverInstalledBeforeMeasurement: false },
    { validationScopePushedBeforeMeasurement: false },
    { validationErrorCount: 1, validationErrors: ["fabricated validation"] },
    { uncapturedErrors: ["fabricated uncaptured error"] },
    { deviceLostDuringMeasurement: true },
    { queueDrainedAfterMeasurement: false },
    { postDrainEventTurn: false },
  ]) {
    expectFailure(
      syntheticBackend("webgpu", {
        webgpuDeviceEvidence: {
          ...green.webgpuDeviceEvidence,
          ...deviceMutation,
        },
      }),
      /WebGPU validation\/device-loss capture/u,
    );
  }

  expectFailure(
    syntheticBackend("webgpu", {
      multifrustum: {
        ...green.multifrustum,
        centerScore: {
          controlSeparation: 0,
          winnerError: 0,
          loserError: 0,
        },
      },
    }),
    /center pixel/u,
  );
  for (const mutation of [
    { automaticTaaResetCount: 5 },
    { manualTaaResetCount: 5 },
    { enableTaaResetCount: 2 },
    { taaResetCount: 14 },
    { pinnedJitterFrameIndex: 7 },
    { pinnedJitterCallCount: 14 },
  ]) {
    expectFailure(
      syntheticBackend("webgpu", {
        crossing: { ...green.crossing, ...mutation },
      }),
      /expected 6 automatic, 6 manual, 3 enable, and 15 total TAA resets|symmetric TAA jitter pinning is incomplete/u,
    );
  }
  for (const runtimeConfiguration of [
    { ...green.crossing.runtimeConfiguration, requestedMsaaSamples: 4 },
    { ...green.crossing.runtimeConfiguration, effectiveMsaaSamplesAtEnd: 4 },
    {
      ...green.crossing.runtimeConfiguration,
      pipelineFormatGenerationAtEnd:
        green.crossing.runtimeConfiguration.pipelineFormatGenerationAtStart + 1,
    },
  ]) {
    expectFailure(
      syntheticBackend("webgpu", {
        crossing: { ...green.crossing, runtimeConfiguration },
      }),
      /crossing MSAA or scene-pipeline generation/u,
    );
  }

  const mutateComparison = (key, mutation) => {
    const comparisons = structuredClone(green.crossing.comparisons);
    const index = comparisons.findIndex((comparison) => comparison.key === key);
    comparisons[index] = mutation(comparisons[index]);
    return syntheticBackend("webgpu", {
      crossing: { ...green.crossing, comparisons },
    });
  };
  for (const invalidFov of [undefined, Number.NaN]) {
    expectFailure(
      syntheticBackend("webgpu", {
        crossing: { ...green.crossing, fovDegrees: invalidFov },
      }),
      /route crossing steps or diagnostic FOV are incomplete/u,
    );
    expectFailure(
      syntheticBackend("webgpu", {
        overlaps: [
          { ...green.overlaps[0], fovDegrees: invalidFov },
          ...green.overlaps.slice(1),
        ],
      }),
      /normal overlap FOV/u,
    );
    expectFailure(
      syntheticBackend("webgpu", {
        dualBodyNonOverlap: {
          ...green.dualBodyNonOverlap,
          fovDegrees: invalidFov,
        },
      }),
      /dual-body non-overlap PVS/u,
    );
    expectFailure(
      syntheticBackend("webgpu", {
        multifrustum: { ...green.multifrustum, fovDegrees: invalidFov },
      }),
      /forced inside-Moon multi-frustum route is vacuous/u,
    );
    expectFailure(
      mutateComparison("entry-raw-r1", (comparison) => ({
        ...comparison,
        fovDegrees: invalidFov,
      })),
      /comparison identity, repetition, position, or FOV is invalid/u,
    );
  }
  expectFailure(
    mutateComparison("entry-raw-r1", (comparison) => ({
      ...comparison,
      routeProvenance: {
        ...comparison.routeProvenance,
        observed: {
          ...comparison.routeProvenance.observed,
          actualPhysical: false,
        },
      },
    })),
    /route provenance contradicts/u,
  );
  expectFailure(
    mutateComparison("exit-first-frame-r1", (comparison) => ({
      ...comparison,
      resetDeltas: {
        ...comparison.resetDeltas,
        automatic: {
          ...comparison.resetDeltas.automatic,
          after: comparison.resetDeltas.automatic.before,
          delta: 0,
        },
      },
    })),
    /per-pair measured TAA reset deltas/u,
  );
  expectFailure(
    mutateComparison("entry-first-frame-r1", (comparison) => ({
      ...comparison,
      resetDeltas: {
        ...comparison.resetDeltas,
        automatic: {
          ...comparison.resetDeltas.automatic,
          before: comparison.resetDeltas.automatic.before,
          after: comparison.resetDeltas.automatic.after + 1,
          delta: 2,
        },
      },
    })),
    /per-pair measured TAA reset deltas/u,
  );
  const aggregatedCounterMutant = syntheticBackend("webgpu");
  aggregatedCounterMutant.crossing.comparisons[0].resetDeltas.automatic.delta = 1;
  aggregatedCounterMutant.crossing.comparisons[0].resetDeltas.automatic.after = 1;
  aggregatedCounterMutant.crossing.comparisons[1].resetDeltas.automatic.delta = 0;
  aggregatedCounterMutant.crossing.comparisons[1].resetDeltas.automatic.after = 0;
  assert.equal(
    aggregatedCounterMutant.crossing.comparisons.reduce(
      (total, comparison) => total + comparison.resetDeltas.automatic.delta,
      0,
    ),
    aggregatedCounterMutant.crossing.automaticTaaResetCount,
  );
  expectFailure(aggregatedCounterMutant, /per-pair measured TAA reset deltas/u);
  expectFailure(
    mutateComparison("entry-first-frame-r1", (comparison) => ({
      ...comparison,
      taaState: {
        ...comparison.taaState,
        observed: {
          ...comparison.taaState.observed,
          effectEnabled: false,
        },
      },
    })),
    /enabled TAA state/u,
  );
  expectFailure(
    mutateComparison("entry-first-frame-r1", (comparison) => ({
      ...comparison,
      mask: {
        ...comparison.mask,
        observedOnlySamples: undefined,
      },
    })),
    /union silhouette mask is vacuous/u,
  );
  expectFailure(
    mutateComparison("exit-raw-r2", (comparison) => ({
      ...comparison,
      regions: {
        ...comparison.regions,
        annulus: {
          ...comparison.regions.annulus,
          errorP95: 17,
        },
      },
    })),
    /annulus continuity score failed closed/u,
  );
  expectFailure(
    mutateComparison("entry-raw-r3", (comparison) => ({
      ...comparison,
      errorHistogram: comparison.errorHistogram.slice(0, -1),
    })),
    /error histogram is absent/u,
  );
  expectFailure(
    mutateComparison("entry-first-frame-r2", (comparison) => {
      const errorHistogram = structuredClone(comparison.errorHistogram);
      errorHistogram[0].count = 63;
      errorHistogram[6].count = 1;
      return {
        ...comparison,
        errorHistogram,
        errorLocations: [],
      };
    }),
    /worst-error location evidence is malformed/u,
  );
  expectFailure(
    mutateComparison("exit-first-frame-r1", (comparison) => ({
      ...comparison,
      images: { ...comparison.images, diff: undefined },
    })),
    /PNG evidence is absent/u,
  );

  const invalidMoonControl = structuredClone(green.overlaps[0]);
  invalidMoonControl.controlRoutes.moonWithSuppressedGlobe.globeShown = false;
  invalidMoonControl.controlRoutes.moonWithSuppressedGlobe.globeVisible = false;
  invalidMoonControl.controlRoutes.moonWithSuppressedGlobe.actualPhysical = false;
  invalidMoonControl.controlRoutes.moonWithSuppressedGlobe.physicalCommands = 0;
  expectFailure(
    syntheticBackend("webgpu", {
      overlaps: [invalidMoonControl, ...green.overlaps.slice(1)],
    }),
    /route-preserving controls failed/u,
  );
  expectFailure(
    syntheticBackend("webgpu", {
      continuityImageVerification: green.continuityImageVerification.slice(
        0,
        -1,
      ),
    }),
    /PNG publication\/verification set is incomplete/u,
  );
});

test("route-preserving Moon control is backend-safe, non-vacuous, and exactly restored", () => {
  assert.match(
    probeSource,
    /const artifactSchema = "c12-37-moon-globe-depth-occlusion-v5"/u,
  );
  assert.match(
    probeSource,
    /"c12-37-moon-globe-depth-occlusion-v4",\s*artifactSchema/u,
  );
  const physical = {
    moonShown: true,
    globeShown: true,
    globeVisible: true,
    globeClippingCollectionPresent: false,
    globeExecutionFilterActive: false,
    globeExecutionFilterStrategy: "none",
    depthPlaneSuppressed: false,
    globeCommandsSeen: 0,
    globeCommandsRejected: 0,
    globeCommandsAccepted: 0,
    moonOcclusionBypassActive: false,
    moonOcclusionBypassCalls: 0,
    controlRestored: true,
    actualPhysical: true,
    physicalCommands: 1,
    uniquePhysicalCommands: 1,
    physicalFrustumExecutions: 1,
    legacyCommandPresent: false,
    legacyVisible: false,
  };
  const controls = {
    combined: physical,
    earthOnly: {
      ...physical,
      moonShown: false,
      actualPhysical: false,
      physicalCommands: 0,
      uniquePhysicalCommands: 0,
      physicalFrustumExecutions: 0,
    },
    moonWithSuppressedGlobe: {
      ...physical,
      globeExecutionFilterActive: true,
      globeExecutionFilterStrategy:
        "debug-command-filter:rendered-globe-tile-owner",
      depthPlaneSuppressed: true,
      globeCommandsSeen: 5,
      globeCommandsRejected: 5,
      moonOcclusionBypassActive: true,
      controlRestored: true,
    },
  };
  assert.equal(assessC1237RoutePreservingControls(controls).ok, true);
  const physicalBypassMutant = structuredClone(controls);
  physicalBypassMutant.moonWithSuppressedGlobe.moonOcclusionBypassCalls = 1;
  assert.equal(
    assessC1237RoutePreservingControls(physicalBypassMutant).ok,
    false,
  );
  const oldMoonOnly = structuredClone(controls);
  oldMoonOnly.moonWithSuppressedGlobe.globeShown = false;
  oldMoonOnly.moonWithSuppressedGlobe.globeVisible = false;
  oldMoonOnly.moonWithSuppressedGlobe.globeExecutionFilterActive = false;
  oldMoonOnly.moonWithSuppressedGlobe.globeExecutionFilterStrategy = "none";
  oldMoonOnly.moonWithSuppressedGlobe.depthPlaneSuppressed = false;
  oldMoonOnly.moonWithSuppressedGlobe.globeCommandsSeen = 0;
  oldMoonOnly.moonWithSuppressedGlobe.globeCommandsRejected = 0;
  oldMoonOnly.moonWithSuppressedGlobe.moonOcclusionBypassActive = false;
  oldMoonOnly.moonWithSuppressedGlobe.controlRestored = false;
  oldMoonOnly.moonWithSuppressedGlobe.actualPhysical = false;
  oldMoonOnly.moonWithSuppressedGlobe.physicalCommands = 0;
  oldMoonOnly.moonWithSuppressedGlobe.uniquePhysicalCommands = 0;
  oldMoonOnly.moonWithSuppressedGlobe.physicalFrustumExecutions = 0;
  assert.equal(assessC1237RoutePreservingControls(oldMoonOnly).ok, false);

  for (const mutation of [
    { globeCommandsSeen: 0, globeCommandsRejected: 0 },
    { globeCommandsSeen: 5, globeCommandsRejected: 4 },
    { globeCommandsAccepted: 1 },
    { moonOcclusionBypassActive: false },
    { controlRestored: false },
    { globeClippingCollectionPresent: true },
  ]) {
    const mutant = structuredClone(controls);
    Object.assign(mutant.moonWithSuppressedGlobe, mutation);
    assert.equal(assessC1237RoutePreservingControls(mutant).ok, false);
  }
  for (const controlName of ["combined", "earthOnly"]) {
    const mutant = structuredClone(controls);
    mutant[controlName].controlRestored = false;
    assert.equal(assessC1237RoutePreservingControls(mutant).ok, false);
  }

  // Reproduce the exact old WebGPU teardown shape: ClippingPlaneCollection
  // assumes a WebGL-style texture with destroy(), while the WebGPU sentinel did
  // not expose that method. The replacement never creates or clears a clipping
  // collection and restores every temporary scene hook in a finally block.
  const oldWebGpuCollection = {
    _clippingPlanesTexture: {},
    destroy() {
      this._clippingPlanesTexture.destroy();
    },
  };
  assert.throws(
    () => oldWebGpuCollection.destroy(),
    /destroy is not a function/u,
  );
  assert.doesNotMatch(probeSource, /scene\.globe\.show = false;/u);
  assert.doesNotMatch(probeSource, /new C\.ClippingPlaneCollection/u);
  assert.doesNotMatch(probeSource, /scene\.globe\.clippingPlanes = undefined/u);
  assert.match(probeSource, /scene\.debugCommandFilter = \(command\) =>/u);
  assert.match(probeSource, /scene\.debugSkipDepthPlane = true/u);
  assert.match(probeSource, /finally \{\s*restored =/u);
  assert.match(
    probeSource,
    /originalSceneIsVisibleDescriptor:\s*Object\.getOwnPropertyDescriptor/u,
  );
  assert.match(probeSource, /delete scene\.isVisible/u);
  assert.match(
    probeSource,
    /Object\.defineProperty\(\s*scene,\s*"isVisible",\s*state\.originalSceneIsVisibleDescriptor/u,
  );

  const inherited = { isVisible() {} };
  const simulatedScene = Object.create(inherited);
  const original = simulatedScene.isVisible;
  const descriptor = Object.getOwnPropertyDescriptor(
    simulatedScene,
    "isVisible",
  );
  simulatedScene.isVisible = original;
  assert.equal(
    Object.hasOwn(simulatedScene, "isVisible"),
    true,
    "the old equality-only restore leaves an observable own property",
  );
  if (descriptor === undefined) {
    delete simulatedScene.isVisible;
  } else {
    Object.defineProperty(simulatedScene, "isVisible", descriptor);
  }
  assert.equal(Object.hasOwn(simulatedScene, "isVisible"), false);
  assert.equal(simulatedScene.isVisible, original);
});

test("Earth-near PVS accepts an emitted legacy command that ordinary Earth occlusion hides", () => {
  const green = syntheticBackend("webgl");
  const earthNear = green.overlaps.find((lane) =>
    lane.key.startsWith("earth-near-"),
  );
  assert.equal(earthNear.controlRoutes.combined.actualPhysical, false);
  assert.equal(earthNear.controlRoutes.combined.legacyCommandPresent, true);
  assert.equal(earthNear.controlRoutes.combined.legacyVisible, false);
  assert.equal(
    earthNear.controlRoutes.moonWithSuppressedGlobe.actualPhysical,
    false,
  );
  assert.equal(
    earthNear.controlRoutes.moonWithSuppressedGlobe.legacyVisible,
    true,
  );
  assert.ok(
    earthNear.controlRoutes.moonWithSuppressedGlobe.moonOcclusionBypassCalls >
      0,
  );
  assert.deepEqual(
    assessC1237RoutePreservingControls(earthNear.controlRoutes),
    { ok: true, reasons: [] },
  );

  for (const mutation of [
    { target: "combined", legacyCommandPresent: false },
    { target: "moonWithSuppressedGlobe", legacyVisible: false },
    { target: "moonWithSuppressedGlobe", moonOcclusionBypassCalls: 0 },
    { target: "moonWithSuppressedGlobe", actualPhysical: true },
  ]) {
    const controls = structuredClone(earthNear.controlRoutes);
    controls[mutation.target] = {
      ...controls[mutation.target],
      ...mutation,
    };
    delete controls[mutation.target].target;
    assert.equal(assessC1237RoutePreservingControls(controls).ok, false);
  }

  const failures = [];
  validateC1237Backend(green, failures);
  assert.deepEqual(failures, []);
});

test("continuity oracle pins FOV, symmetric pairs, union masks, and UUID PNGs", () => {
  assert.match(probeSource, /normal: 60\.0/u);
  assert.match(probeSource, /diagnostic: 20\.0/u);
  assert.match(probeSource, /continuityRepetitions: 3/u);
  assert.match(
    probeSource,
    /const inUnion =\s*analytic \|\| referenceVisible \|\| observedVisible/u,
  );
  assert.match(probeSource, /observedVisible && !referenceVisible/u);
  assert.match(
    probeSource,
    /"perspective-sphere-angular-radius\+drawing-buffer-center"/u,
  );
  assert.match(probeSource, /manualResetScope = true/u);
  assert.match(probeSource, /captureAfterManualReset\(\)/u);
  assert.match(probeSource, /scene\.msaaSamples = 1/u);
  assert.match(probeSource, /effectiveMsaaSamplesAtStart/u);
  assert.match(probeSource, /pipelineFormatGenerationAtStart/u);
  assert.match(probeSource, /resetDeltaEvidence\(/u);
  assert.match(probeSource, /command\?\._moonPhysicalDepthRoute !== true/u);
  assert.match(probeSource, /canvas\.toDataURL\("image\/png"\)/u);
  assert.match(
    probeSource,
    /createImmutableEvidence\(file, bytes, operations\)/u,
  );
  assert.doesNotMatch(
    probeSource,
    /function scoreContinuity\(reference, observed\)/u,
  );
});

test("dual-body PVS follows emitted route and rejects the legacy-visibility mutant", () => {
  const physicalEvidence = {
    actualPhysical: true,
    physicalCommands: 1,
    uniquePhysicalCommands: 1,
    moonOwnedPhysicalCommands: 1,
    physicalFrustumExecutions: 1,
    legacyCommandPresent: false,
    legacyVisible: false,
  };
  assert.deepEqual(assessC1237DualBodyMoonPresence(physicalEvidence), {
    route: "physical",
    present: true,
    evidence: physicalEvidence,
  });

  const legacyEvidence = {
    actualPhysical: false,
    physicalCommands: 0,
    uniquePhysicalCommands: 0,
    moonOwnedPhysicalCommands: 0,
    physicalFrustumExecutions: 0,
    legacyCommandPresent: true,
    legacyVisible: true,
  };
  assert.deepEqual(assessC1237DualBodyMoonPresence(legacyEvidence), {
    route: "legacy",
    present: true,
    evidence: legacyEvidence,
  });

  // This is the real physical-route shape: Moon.update returned no legacy
  // environment command, so the old `owned && isMoonVisible` predicate is
  // necessarily false even though the physical command is present and binned.
  const legacyVisibilityMutant =
    physicalEvidence.moonOwnedPhysicalCommands > 0 &&
    physicalEvidence.legacyVisible;
  assert.equal(legacyVisibilityMutant, false);

  const expectedWiring =
    "result.dualBodyNonOverlap.moonCommandPresent = dualBodyMoonPresence.present;";
  assert.ok(
    probeSource.includes(expectedWiring),
    "probe must publish the route-aware presence verdict",
  );
  const mutant = probeSource.replace(
    expectedWiring,
    "result.dualBodyNonOverlap.moonCommandPresent =\n      result.dualBodyNonOverlap.moonPresenceEvidence\n        .moonOwnedPhysicalCommands > 0 &&\n      result.dualBodyNonOverlap.moonPresenceEvidence.legacyVisible;",
  );
  assert.notEqual(
    mutant,
    probeSource,
    "the legacy-visibility mutation must match current source",
  );
  assert.equal(
    mutant.includes(expectedWiring),
    false,
    "the source contract must reject synthetic legacy-visibility wiring",
  );
});

test("Naga validates the two-entrypoint Moon WGSL module", async () => {
  const nagaDirectory = path.join(
    root,
    "Tools/shader-pipeline/naga-wasm-tools",
  );
  const naga = await import(
    pathToFileURL(path.join(nagaDirectory, "naga_wasm_tools.js")).href
  );
  await naga.default(
    fs.readFileSync(path.join(nagaDirectory, "naga_wasm_tools_bg.wasm")),
  );
  assert.doesNotThrow(() => naga.validate_wgsl(moonWgsl));
});
