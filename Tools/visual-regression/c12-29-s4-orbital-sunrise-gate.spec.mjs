import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  C12_29_S4_ATMOSPHERE,
  C12_29_S4_BANDS,
  C12_29_S4_CAPTURE_METHOD,
  C12_29_S4_HIDDEN_ANCHORS_KM,
  C12_29_S4_NEUTRAL_SCENE,
  C12_29_S4_NORMAL_ANCHORS_KM,
  C12_29_S4_ORBIT,
  C12_29_S4_SAMPLE_OFFSETS_SECONDS,
  C12_29_S4_SCHEMA,
  C12_29_S4_VIEWPORT,
  computeIndependentExtinction,
  exitCodeForS4Status,
  foldC1229S4Gate,
  isUuidV4,
  sameEvidenceFingerprint,
  validateS4FinalArtifactShape,
} from "./lib/c12-29-s4-orbital-sunrise-gate.mjs";
import { BUILD_ABSENT_REASON } from "./lib/build-source-identity.mjs";
import {
  captureS4PageRuntimeViewerRoutes,
  captureS4ServedViewerRoutes,
  createS4ArtifactPaths,
  finalizeS4Evidence,
  inspectS4PriorLatest,
  redactS4OutputPayload,
  releaseS4LockOrRestoreRunning,
  runC1229S4Probe,
  serializeS4Artifact,
  validateS4LoopbackBase,
  withS4Watchdog,
} from "./probe-c12-29-s4-orbital-sunrise.mjs";

const directory = path.dirname(fileURLToPath(import.meta.url));
const probeSource = fs.readFileSync(
  path.join(directory, "probe-c12-29-s4-orbital-sunrise.mjs"),
  "utf8",
);
const gateSource = fs.readFileSync(
  path.join(directory, "lib/c12-29-s4-orbital-sunrise-gate.mjs"),
  "utf8",
);
const RUN_ID = "123e4567-e89b-42d3-a456-426614174000";

// Build-absence is STRUCTURAL, not a product FAIL.
//
// Two checks below drive the whole probe, which resolves the served viewer's
// reference closure and binds itself to `Build/CesiumUnminified`. In a tree
// that has never been built those references do not exist, so the checks have
// no subject rather than a broken one and report the shared structural reason
// instead of failing. The predicate names the artifacts, so a built tree still
// runs both.
const root = path.resolve(directory, "../..");
const BUILD_ARTIFACTS = Object.freeze([
  path.join(root, "Build/CesiumUnminified/index.js"),
  path.join(root, "Build/CesiumUnminified/index.js.map"),
  path.join(root, "Source/Widgets/widgets.css"),
  path.join(root, "packages/engine/Source/Shaders/SunFS.js"),
]);
const missingBuildArtifacts = BUILD_ARTIFACTS.filter(
  (file) => !fs.existsSync(file),
);

/**
 * Skip a build-bound check with the shared named structural reason.
 *
 * @param {import("node:test").TestContext} t Test context.
 * @returns {boolean} True when the check cannot see its subject.
 */
function skipWithoutBuild(t) {
  if (missingBuildArtifacts.length === 0) {
    return false;
  }
  t.skip(
    `${BUILD_ABSENT_REASON}: ${missingBuildArtifacts.length} artifact(s) absent, first ${path.relative(root, missingBuildArtifacts[0]).replaceAll("\\", "/")}`,
  );
  return true;
}

const EARTH_RADIUS = C12_29_S4_ORBIT.innerRadiusMeters;
const ORBIT_RADIUS = EARTH_RADIUS + C12_29_S4_ORBIT.altitudeMeters;
const SUN_DISTANCE = 1.496e11;
const ORBIT_BASIS = Object.freeze({
  sunDirectionWC: [1, 0, 0],
  tangentAxisWC: [0, 1, 0],
  upAxisWC: [0, 0, 1],
});
const VIEWER_ROUTES = Object.freeze([
  "/Apps/CesiumViewer/index.html",
  "/Apps/CesiumViewer/CesiumViewer.js",
  "/Apps/CesiumViewer/CesiumViewer.css",
  "/Apps/CesiumViewer/CesiumViewerStartupOptions.js",
  "/Apps/CesiumViewer/CesiumViewerDevUi.js",
  "/Apps/CesiumViewer/CesiumViewerStartMode.js",
  "/Apps/CesiumViewer/CesiumViewerLoadingIndicator.js",
  "/Build/CesiumUnminified/index.js",
  "/Source/Widgets/widgets.css",
  "/Source/Widgets/lighter.css",
  "/Source/Widgets/shared.css",
  "/Apps/CesiumViewer/favicon.ico",
  "/Apps/CesiumViewer/Images/ajax-loader.gif",
]);
const REQUIRED_VIEWER_ROUTES = Object.freeze(
  VIEWER_ROUTES.filter(
    (route) => !route.endsWith(".ico") && !route.endsWith(".gif"),
  ),
);
const SCRIPT_WORKER_CHUNK_ROUTE =
  "/Build/CesiumUnminified/Workers/chunk-ABC123.js";
const INVALID_SCRIPT_SUPPORT_ROUTES = Object.freeze([
  "/Build/CesiumUnminified/chunk-ABC123.js",
  "/Build/CesiumUnminified/Workers/nested/chunk-ABC123.js",
  "/Build/CesiumUnminified/Workers/chunk-ABC123.css",
  "/Build/CesiumUnminified/Workers/chunk-AbC123.js",
  "/Build/CesiumUnminified/Workers/chunk-ABC-123.js",
  "/Build/CesiumUnminified/Workers/chunk-.js",
  "/Build/CesiumUnminified/Workers/createVerticesFromHeightmap.js",
]);

function syntheticResourceType(route) {
  if (route.endsWith(".html")) {
    return "document";
  }
  if (route.endsWith(".css")) {
    return "css";
  }
  return "script";
}

function isoAt(offsetSeconds) {
  return new Date(
    Date.parse(C12_29_S4_ORBIT.epochIso) + offsetSeconds * 1000,
  ).toISOString();
}

function sourceInputsAt(offsetSeconds) {
  const meanMotion = Math.sqrt(
    C12_29_S4_ORBIT.gravitationalParameter / ORBIT_RADIUS ** 3,
  );
  const shellAngle =
    Math.PI -
    Math.asin(
      (EARTH_RADIUS + C12_29_S4_ORBIT.atmosphereShellMeters) / ORBIT_RADIUS,
    );
  const orbitPhaseRadians = shellAngle - meanMotion * offsetSeconds;
  const cameraPositionWC = [
    ORBIT_RADIUS * Math.cos(orbitPhaseRadians),
    ORBIT_RADIUS * Math.sin(orbitPhaseRadians),
    0,
  ];
  const bodyPositionWC = [SUN_DISTANCE, 0, 0];
  const ray = bodyPositionWC.map(
    (value, index) => value - cameraPositionWC[index],
  );
  const rayLength = Math.hypot(...ray);
  const cameraDirectionWC = ray.map((value) => value / rayLength);
  const along = Math.max(
    0,
    -cameraPositionWC.reduce(
      (sum, value, index) => sum + value * cameraDirectionWC[index],
      0,
    ),
  );
  const closest = cameraPositionWC.map(
    (value, index) => value + cameraDirectionWC[index] * along,
  );
  const tangentHeightKm = (Math.hypot(...closest) - EARTH_RADIUS) / 1000;
  return {
    orbitPhaseRadians,
    tangentHeightKm,
    sourceInputs: {
      cameraPositionWC,
      bodyPositionWC,
      cameraDirectionWC,
      cameraUpWC: [0, 0, 1],
      timeIso: isoAt(offsetSeconds),
      innerRadius: EARTH_RADIUS,
      atmosphere: structuredClone(C12_29_S4_ATMOSPHERE),
    },
  };
}

function syntheticImage(extinction, scale = 1, sha = "a".repeat(64)) {
  const clearRgb = [2.5, 2, 1.25];
  const observableExtinction = extinction.map((transmittance) =>
    transmittance * 255 < 0.5 ? 0 : transmittance,
  );
  const rgb = observableExtinction.map(
    (transmittance, channel) => transmittance * clearRgb[channel] * scale,
  );
  const maxCodeByChannel = observableExtinction.map((transmittance) =>
    Math.max(0, Math.min(255, Math.round(255 * transmittance ** (1 / 2.2)))),
  );
  const maxCode = Math.max(...maxCodeByChannel);
  return {
    width: C12_29_S4_VIEWPORT.width,
    height: C12_29_S4_VIEWPORT.height,
    pngByteLength: 1024,
    pngSha256: sha,
    nonBlackPixels: maxCode > 1 ? 500 : 0,
    maxCode,
    maxCodeByChannel,
    aboveFloorPixelsByChannel: maxCodeByChannel.map((code) =>
      code > 1 ? 500 : 0,
    ),
    minimumAlphaCode: 255,
    maximumAlphaCode: 255,
    linearEnergy: {
      rgb,
      luminance: 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2],
    },
  };
}

function syntheticSession(renderer, renderedScale = 1) {
  const samples = C12_29_S4_SAMPLE_OFFSETS_SECONDS.map((offsetSeconds) => {
    const physical = sourceInputsAt(offsetSeconds);
    const { tangentHeightKm, orbitPhaseRadians, sourceInputs } = physical;
    const extinction = computeIndependentExtinction(sourceInputs);
    return {
      offsetSeconds,
      tangentHeightKm,
      orbitPhaseRadians,
      extinction,
      sunEclipseAlpha: 1,
      sourceInputs,
      sceneSnapshot: { ...structuredClone(C12_29_S4_NEUTRAL_SCENE) },
      image: syntheticImage(extinction, renderedScale),
    };
  });
  const executionLedger = REQUIRED_VIEWER_ROUTES.map((route) => ({
    route,
    resourceType: syntheticResourceType(route),
    sameOrigin: true,
  }));
  const supportResourceLedger = [
    {
      route: "/Build/CesiumUnminified/Assets/IAU2006_XYS/IAU2006_XYS_18.json",
      resourceType: "xmlhttprequest",
      sameOrigin: true,
    },
    {
      route: "/Build/CesiumUnminified/Widgets/Images/NavigationHelp/Mouse.svg",
      resourceType: "img",
      sameOrigin: true,
    },
    {
      route: "/Build/CesiumUnminified/Workers/example.js",
      resourceType: "other",
      sameOrigin: true,
    },
  ];
  return {
    requestedRenderer: renderer,
    actualRenderer: renderer,
    runtimeIdentity: {
      ok: true,
      viewerClosure: {
        expectedRoutes: [...VIEWER_ROUTES],
        requiredExecutionRoutes: [...REQUIRED_VIEWER_ROUTES],
        conditionalRoutes: VIEWER_ROUTES.filter(
          (route) => !REQUIRED_VIEWER_ROUTES.includes(route),
        ),
        executedBeforeExplicitFetch: true,
        sameOriginResourceLedger: [
          ...executionLedger,
          ...supportResourceLedger,
        ],
        executionLedger,
        supportResourceLedger,
        executedRoutes: [...REQUIRED_VIEWER_ROUTES],
        fetchedRoutes: [...VIEWER_ROUTES],
        servedRoutes: [...VIEWER_ROUTES],
        unregisteredExecutedRoutes: [],
        routeIdentities: VIEWER_ROUTES.map((route) => ({
          route,
          local: { exists: true, byteLength: 8, sha256: "d".repeat(64) },
          served: {
            ok: true,
            status: 200,
            byteLength: 8,
            sha256: "d".repeat(64),
          },
          runtime: {
            ok: true,
            status: 200,
            byteLength: 8,
            sha256: "d".repeat(64),
          },
        })),
      },
    },
    gpuProvenance: {
      backend: renderer,
      rendererString: renderer === "webgpu" ? "NVIDIA WebGPU" : "ANGLE D3D11",
      adapterInfo:
        renderer === "webgpu"
          ? { vendor: "nvidia", architecture: "pascal" }
          : null,
    },
    externalRequests: [],
    failedRequests: [],
    httpErrors: [],
    consoleErrors: [],
    pageErrors: [],
    deviceErrors: [],
    transport: {
      loopbackBaseAccepted: true,
      credentialFreeBase: true,
      sameOriginOnly: true,
      origin: "http://127.0.0.1:8080",
    },
    graphicsCompletion:
      renderer === "webgpu"
        ? {
            backend: "webgpu",
            queueFenceAttempted: true,
            queueFenceCompleted: true,
            queueFenceError: null,
            errorScopes: ["out-of-memory", "internal", "validation"].map(
              (filter) => ({ filter, popped: true, error: null }),
            ),
            deviceErrorListenerArmed: true,
            deviceLossListenerArmed: true,
            uncapturedErrors: [],
            deviceLossEvents: [],
            lateEventTurns: 2,
          }
        : {
            backend: "webgl",
            finishAttempted: true,
            finishCompleted: true,
            finishError: null,
            getErrorDrained: true,
            getErrorCalls: 1,
            terminalErrorCode: 0,
            nonZeroErrorCodes: [],
          },
    sunPipelineReadiness:
      renderer === "webgpu"
        ? {
            renderer: "webgpu",
            status: "READY",
            prewarmOffsetSeconds: C12_29_S4_SAMPLE_OFFSETS_SECONDS.at(-1),
            attemptedFrames: 2,
            yieldedTurns: 1,
            commandReady: true,
            pipelineReady: true,
            ownerExact: true,
            vertexCount: 6,
          }
        : {
            renderer: "webgl",
            status: "N/A",
            prewarmOffsetSeconds: null,
            attemptedFrames: 0,
            yieldedTurns: 0,
            commandReady: null,
            pipelineReady: null,
            ownerExact: null,
            vertexCount: null,
          },
    neutral: {
      captureMethod: C12_29_S4_CAPTURE_METHOD,
      sceneContract: {
        epochIso: C12_29_S4_ORBIT.epochIso,
        innerRadiusMeters: EARTH_RADIUS,
        orbitAltitudeMeters: C12_29_S4_ORBIT.altitudeMeters,
        atmosphereShellMeters: C12_29_S4_ORBIT.atmosphereShellMeters,
        gravitationalParameter: C12_29_S4_ORBIT.gravitationalParameter,
        durationSeconds: C12_29_S4_ORBIT.durationSeconds,
        stepSeconds: C12_29_S4_ORBIT.stepSeconds,
        ...structuredClone(C12_29_S4_NEUTRAL_SCENE),
        orbitBasis: structuredClone(ORBIT_BASIS),
      },
      samples,
      hiddenControls: C12_29_S4_HIDDEN_ANCHORS_KM.map((anchor) => {
        const target = anchor === "clear" ? 115 : anchor;
        const sample = samples.reduce((best, candidate) =>
          Math.abs(candidate.tangentHeightKm - target) <
          Math.abs(best.tangentHeightKm - target)
            ? candidate
            : best,
        );
        return {
          targetTangentHeightKm: anchor,
          offsetSeconds: sample.offsetSeconds,
          tangentHeightKm: sample.tangentHeightKm,
          captureMethod: C12_29_S4_CAPTURE_METHOD,
          sceneSnapshot: {
            ...structuredClone(C12_29_S4_NEUTRAL_SCENE),
            sunShown: false,
          },
          image: syntheticImage([0, 0, 0], 1, "b".repeat(64)),
        };
      }),
    },
    normal: {
      captureMethod: C12_29_S4_CAPTURE_METHOD,
      captures: C12_29_S4_NORMAL_ANCHORS_KM.map((heightKm) => {
        const image = syntheticImage([1, 1, 1], 1, "c".repeat(64));
        return {
          targetTangentHeightKm: heightKm,
          tangentHeightKm: heightKm,
          tilesLoaded: true,
          settledFrames: 8,
          image: {
            ...image,
            immutableFile: {
              exists: true,
              byteLength: image.pngByteLength,
              sha256: image.pngSha256,
            },
          },
        };
      }),
    },
  };
}

function greenReport() {
  return {
    schema: C12_29_S4_SCHEMA,
    runId: RUN_ID,
    provenance: { ok: true, reasons: [] },
    lifecycle: { firstRedStable: true },
    sessions: [syntheticSession("webgl"), syntheticSession("webgpu")],
  };
}

function runningMarker(
  paths,
  supersedesLatest = { exists: false, error: "ENOENT" },
) {
  return {
    schema: C12_29_S4_SCHEMA,
    campaign: "C12-29 S4",
    probe: "orbital-sunrise limb-glow acceptance",
    runId: RUN_ID,
    status: "RUNNING",
    incomplete: true,
    startedAt: "2026-08-12T00:00:00.000Z",
    authority: "exclusive-lock",
    phase: "MEASURING",
    paths: {
      immutableRun: paths.run,
      firstRed: paths.firstRed,
    },
    supersedesLatest,
  };
}

function finalLifecycleArtifact() {
  return {
    schema: C12_29_S4_SCHEMA,
    runId: RUN_ID,
    status: "PASS",
    incomplete: false,
    exitCode: 0,
  };
}

function fsOperations(overrides = {}) {
  return {
    readFileSync: fs.readFileSync,
    writeFileSync: fs.writeFileSync,
    renameSync: fs.renameSync,
    unlinkSync: fs.unlinkSync,
    ...overrides,
  };
}

function expectStatus(mutator, status, reasonPattern) {
  const report = greenReport();
  mutator(report);
  const verdict = foldC1229S4Gate(report);
  assert.equal(verdict.status, status);
  assert.equal(verdict.exitCode, exitCodeForS4Status(status));
  const reasons = [
    ...verdict.structuralReasons,
    ...verdict.failedPredicates,
  ].join("\n");
  assert.match(reasons, reasonPattern);
}

test("green synthetic report closes every pre-registered S4 predicate", () => {
  const verdict = foldC1229S4Gate(greenReport());
  assert.equal(verdict.status, "PASS");
  assert.equal(verdict.exitCode, 0);
  assert.equal(verdict.pass, true);
  assert.deepEqual(verdict.structuralReasons, []);
  assert.deepEqual(verdict.failedPredicates, []);
  assert.ok(
    verdict.metrics.sessions.webgl.neutral.transitionSeconds >=
      C12_29_S4_BANDS.minimumTransitionSeconds,
  );
});

test("UUID, status, and fingerprint lifecycle contracts fail closed", () => {
  assert.equal(isUuidV4(RUN_ID), true);
  assert.equal(isUuidV4("not-a-run"), false);
  assert.equal(
    sameEvidenceFingerprint(
      { exists: true, byteLength: 8, sha256: "d".repeat(64) },
      { exists: true, byteLength: 8, sha256: "d".repeat(64) },
    ),
    true,
  );
  assert.equal(
    sameEvidenceFingerprint(
      { exists: false, error: "ENOENT" },
      { exists: false, error: "EACCES" },
    ),
    false,
  );
  const valid = validateS4FinalArtifactShape({
    schema: C12_29_S4_SCHEMA,
    runId: RUN_ID,
    status: "PASS",
    incomplete: false,
    exitCode: 0,
  });
  assert.equal(valid.ok, true);
  const invalid = validateS4FinalArtifactShape({
    schema: C12_29_S4_SCHEMA,
    runId: RUN_ID,
    status: "PASS",
    incomplete: true,
    exitCode: 1,
  });
  assert.equal(invalid.ok, false);
  assert.match(invalid.reasons.join("\n"), /incomplete=false|exitCode/u);
});

test("provenance, lifecycle, session ownership, and runtime mutants are STRUCTURAL", () => {
  expectStatus(
    (report) => {
      report.provenance = { ok: false, reasons: ["built source mismatch"] };
    },
    "STRUCTURAL",
    /built source mismatch/u,
  );
  expectStatus(
    (report) => {
      report.lifecycle.firstRedStable = false;
    },
    "STRUCTURAL",
    /first-red bytes changed/u,
  );
  expectStatus(
    (report) => {
      report.sessions.pop();
    },
    "STRUCTURAL",
    /webgpu: expected one fresh browser session/u,
  );
  expectStatus(
    (report) => {
      report.sessions[1].actualRenderer = "webgl";
    },
    "STRUCTURAL",
    /requested renderer resolved/u,
  );
  expectStatus(
    (report) => {
      report.sessions[1].gpuProvenance.adapterInfo = {};
    },
    "STRUCTURAL",
    /adapter identity is incomplete/u,
  );
  expectStatus(
    (report) => {
      report.sessions[0].runtimeIdentity.ok = false;
    },
    "STRUCTURAL",
    /served\/runtime Viewer/u,
  );
  expectStatus(
    (report) => {
      const identity =
        report.sessions[0].runtimeIdentity.viewerClosure.routeIdentities[2];
      identity.runtime.sha256 = "e".repeat(64);
      // Same byte length: hash identity, not size, must carry the CSS bytes.
    },
    "STRUCTURAL",
    /served\/runtime Viewer/u,
  );
  expectStatus(
    (report) => {
      const closure = report.sessions[0].runtimeIdentity.viewerClosure;
      closure.routeIdentities.pop();
      closure.servedRoutes.push(closure.servedRoutes[0]);
    },
    "STRUCTURAL",
    /served\/runtime Viewer/u,
  );
  expectStatus(
    (report) => {
      const closure = report.sessions[0].runtimeIdentity.viewerClosure;
      const route = closure.requiredExecutionRoutes[1];
      closure.executedRoutes = closure.executedRoutes.filter(
        (entry) => entry !== route,
      );
      closure.executionLedger = closure.executionLedger.filter(
        (entry) => entry.route !== route,
      );
      // The route remains explicitly fetched and byte-exact, but did not run.
    },
    "STRUCTURAL",
    /served\/runtime Viewer/u,
  );
  expectStatus(
    (report) => {
      const closure = report.sessions[0].runtimeIdentity.viewerClosure;
      const route = "/Build/CesiumUnminified/chunk-surprise.js";
      const entry = {
        route,
        resourceType: "script",
        sameOrigin: true,
      };
      closure.sameOriginResourceLedger.push(entry);
      closure.supportResourceLedger.push(entry);
      closure.unregisteredExecutedRoutes.push(route);
    },
    "STRUCTURAL",
    /served\/runtime Viewer/u,
  );
});

test("registered Viewer closure and known support-resource ledger stay disjoint", async () => {
  const origin = "http://127.0.0.1:8080";
  const routes = [
    "/Apps/CesiumViewer/index.html",
    "/Apps/CesiumViewer/CesiumViewer.js",
    "/Apps/CesiumViewer/CesiumViewer.css",
  ];
  const acceptedSupport = [
    {
      name: `${origin}/Build/CesiumUnminified/Assets/approximateTerrainHeights.json`,
      initiatorType: "xmlhttprequest",
    },
    {
      name: `${origin}/Build/CesiumUnminified/Widgets/Images/NavigationHelp/Mouse.svg`,
      initiatorType: "img",
    },
    {
      name: `${origin}/Build/CesiumUnminified/Workers/createVerticesFromHeightmap.js`,
      initiatorType: "worker",
    },
    {
      name: `${origin}${SCRIPT_WORKER_CHUNK_ROUTE}`,
      initiatorType: "script",
    },
  ];
  const capture = async (resourceEntries) =>
    captureS4PageRuntimeViewerRoutes({
      viewerRoutePaths: routes,
      requiredViewerRoutePaths: routes,
      requestedRenderer: "webgpu",
      routeFetchNonce: "partition-test",
      origin,
      documentPath: routes[0],
      resourceEntries,
      digestImpl: async () => "e".repeat(64),
      fetchImpl: async (url) => {
        const bytes = new TextEncoder().encode(new URL(url).pathname);
        return {
          ok: true,
          status: 200,
          async arrayBuffer() {
            return bytes.buffer.slice(
              bytes.byteOffset,
              bytes.byteOffset + bytes.byteLength,
            );
          },
        };
      },
    });

  const valid = await capture([
    { name: `${origin}${routes[1]}`, initiatorType: "script" },
    { name: `${origin}${routes[2]}`, initiatorType: "css" },
    ...acceptedSupport,
    { name: "https://outside.invalid/ignored.js", initiatorType: "script" },
  ]);
  assert.deepEqual(valid.executedRoutes, [...routes].sort());
  assert.deepEqual(valid.executedRouteCounts, {
    [routes[0]]: 1,
    [routes[1]]: 1,
    [routes[2]]: 1,
  });
  assert.equal(valid.executionLedger.length, routes.length);
  assert.equal(valid.supportResourceLedger.length, acceptedSupport.length);
  assert.equal(
    valid.sameOriginResourceLedger.length,
    valid.executionLedger.length + valid.supportResourceLedger.length,
  );
  assert.deepEqual(valid.unregisteredExecutedRoutes, []);
  assert.equal(valid.fetches.length, routes.length);

  const fetchedOnly = await capture(acceptedSupport);
  assert.equal(fetchedOnly.executedRouteCounts[routes[1]], 0);
  assert.equal(fetchedOnly.fetches.length, routes.length);

  const duplicate = await capture([
    { name: `${origin}${routes[1]}`, initiatorType: "script" },
    { name: `${origin}${routes[1]}`, initiatorType: "script" },
    { name: `${origin}${routes[2]}`, initiatorType: "css" },
  ]);
  assert.equal(duplicate.executedRouteCounts[routes[1]], 2);

  for (const [route, resourceType] of [
    ...INVALID_SCRIPT_SUPPORT_ROUTES.map((route) => [route, "script"]),
    ["/Build/CesiumUnminified/chunk-surprise.css", "css"],
    ["/injected-document.html", "document"],
    ["/injected-stylesheet.css", "stylesheet"],
  ]) {
    const mutant = await capture([
      { name: `${origin}${routes[1]}`, initiatorType: "script" },
      { name: `${origin}${routes[2]}`, initiatorType: "css" },
      { name: `${origin}${route}`, initiatorType: resourceType },
    ]);
    assert.deepEqual(mutant.unregisteredExecutedRoutes, [route]);
  }
});

test("closure exact-once, hash, and unknown support mutants are STRUCTURAL", () => {
  // The green fixture carries accepted XHR, image, and worker support records.
  assert.equal(foldC1229S4Gate(greenReport()).status, "PASS");
  const scriptChunkReport = greenReport();
  const scriptChunkClosure =
    scriptChunkReport.sessions[0].runtimeIdentity.viewerClosure;
  const scriptChunkEntry = {
    route: SCRIPT_WORKER_CHUNK_ROUTE,
    resourceType: "script",
    sameOrigin: true,
  };
  scriptChunkClosure.sameOriginResourceLedger.push(scriptChunkEntry);
  scriptChunkClosure.supportResourceLedger.push(scriptChunkEntry);
  assert.equal(foldC1229S4Gate(scriptChunkReport).status, "PASS");
  expectStatus(
    (report) => {
      const closure = report.sessions[0].runtimeIdentity.viewerClosure;
      const duplicate = { ...closure.executionLedger[1] };
      closure.executionLedger.push(duplicate);
      closure.sameOriginResourceLedger.push(duplicate);
    },
    "STRUCTURAL",
    /served\/runtime Viewer/u,
  );
  for (const [route, resourceType] of [
    ...INVALID_SCRIPT_SUPPORT_ROUTES.map((route) => [route, "script"]),
    ["/Build/CesiumUnminified/chunk-surprise.css", "css"],
  ]) {
    expectStatus(
      (report) => {
        const closure = report.sessions[0].runtimeIdentity.viewerClosure;
        const entry = { route, resourceType, sameOrigin: true };
        closure.sameOriginResourceLedger.push(entry);
        closure.supportResourceLedger.push(entry);
      },
      "STRUCTURAL",
      /served\/runtime Viewer/u,
    );
  }
  expectStatus(
    (report) => {
      report.sessions[0].runtimeIdentity.viewerClosure.routeIdentities[0].runtime.sha256 =
        "0".repeat(64);
    },
    "STRUCTURAL",
    /served\/runtime Viewer/u,
  );
});

test("offline transport and direct-capture mutants are STRUCTURAL", () => {
  assert.equal(C12_29_S4_NEUTRAL_SCENE.atmosphereLightIntensity, 1e-12);
  assert.ok(C12_29_S4_NEUTRAL_SCENE.atmosphereLightIntensity > 0);
  assert.equal(validateS4LoopbackBase("http://[::1]:8080").hostname, "::1");
  for (const [field, value, pattern] of [
    ["externalRequests", ["https://example.test/a"], /external requests/u],
    ["failedRequests", ["http://localhost/missing"], /failed requests/u],
    ["httpErrors", ["404 /missing"], /HTTP errors/u],
  ]) {
    expectStatus(
      (report) => {
        report.sessions[0][field] = value;
      },
      "STRUCTURAL",
      pattern,
    );
  }
  expectStatus(
    (report) => {
      report.sessions[0].neutral.captureMethod = "drawImage-readback";
    },
    "STRUCTURAL",
    /direct same-task capture/u,
  );
  expectStatus(
    (report) => {
      report.sessions[0].neutral.sceneContract.atmosphereLightIntensity = 0;
      for (const sample of report.sessions[0].neutral.samples) {
        sample.sceneSnapshot.atmosphereLightIntensity = 0;
      }
      for (const control of report.sessions[0].neutral.hiddenControls) {
        control.sceneSnapshot.atmosphereLightIntensity = 0;
      }
    },
    "STRUCTURAL",
    /scene\/orbit contract|non-neutral live samples|sun-hidden/u,
  );
});

test("sweep coverage, decode, tangent anchors, and black control mutants are STRUCTURAL", () => {
  expectStatus(
    (report) => {
      report.sessions[0].neutral.samples.pop();
    },
    "STRUCTURAL",
    /exact 181-second sweep/u,
  );
  expectStatus(
    (report) => {
      for (const sample of report.sessions[0].neutral.samples) {
        sample.tangentHeightKm = 20;
      }
    },
    "STRUCTURAL",
    /reported tangent height/u,
  );
  expectStatus(
    (report) => {
      report.sessions[0].neutral.samples[50].image.pngSha256 = "bad";
    },
    "STRUCTURAL",
    /malformed, wrong-sized, or non-neutral/u,
  );
  expectStatus(
    (report) => {
      report.sessions[0].neutral.hiddenControls[0].image.maxCode = 12;
    },
    "STRUCTURAL",
    /sun-hidden 60\/40\/25\/15\/10\/0\/clear controls/u,
  );
  expectStatus(
    (report) => {
      for (const sample of report.sessions[0].neutral.samples) {
        sample.image.linearEnergy = { rgb: [0, 0, 0], luminance: 0 };
        sample.image.nonBlackPixels = 0;
      }
    },
    "STRUCTURAL",
    /clear Sun lacks robust multi-frame pixel support/u,
  );
  expectStatus(
    (report) => {
      report.sessions[0].neutral.sceneContract.enableEclipse = true;
    },
    "STRUCTURAL",
    /declared scene\/orbit contract/u,
  );
  expectStatus(
    (report) => {
      report.sessions[0].neutral.samples[90].sunEclipseAlpha = 0.75;
    },
    "STRUCTURAL",
    /non-identity eclipse alpha/u,
  );
});

test("WebGPU Sun prewarm must yield and prove an executable environment command", () => {
  for (const mutate of [
    (readiness) => {
      readiness.yieldedTurns = 0;
      readiness.attemptedFrames = 1;
    },
    (readiness) => {
      readiness.status = "PENDING";
      readiness.commandReady = false;
      readiness.pipelineReady = false;
      readiness.ownerExact = false;
      readiness.vertexCount = null;
      readiness.attemptedFrames = 36;
      readiness.yieldedTurns = 36;
    },
    (readiness) => {
      readiness.pipelineReady = false;
    },
    (readiness) => {
      readiness.ownerExact = false;
    },
  ]) {
    expectStatus(
      (report) => mutate(report.sessions[1].sunPipelineReadiness),
      "STRUCTURAL",
      /Sun pipeline readiness/u,
    );
  }
  expectStatus(
    (report) => {
      for (const sample of report.sessions[1].neutral.samples) {
        sample.image.linearEnergy = { rgb: [0, 0, 0], luminance: 0 };
        sample.image.nonBlackPixels = 0;
      }
    },
    "STRUCTURAL",
    /clear Sun lacks robust multi-frame pixel support/u,
  );
  const blind = greenReport();
  for (const sample of blind.sessions[1].neutral.samples) {
    sample.image.linearEnergy = { rgb: [0, 0, 0], luminance: 0 };
    sample.image.nonBlackPixels = 0;
  }
  const verdict = foldC1229S4Gate(blind);
  assert.equal(verdict.status, "STRUCTURAL");
  assert.equal(verdict.metrics.parity, null);
});

test("source extinction identity, monotonicity, and reddening mutants are FAIL", () => {
  expectStatus(
    (report) => {
      const samples = report.sessions[0].neutral.samples;
      samples[80].extinction[0] = Math.max(0, samples[79].extinction[0] - 0.1);
    },
    "FAIL",
    /source extinction reverses/u,
  );
  expectStatus(
    (report) => {
      for (const sample of report.sessions[0].neutral.samples) {
        if (sample.tangentHeightKm >= 115) {
          sample.extinction = [0.999, 0.999, 0.999];
        }
      }
    },
    "FAIL",
    /not exact identity/u,
  );
  expectStatus(
    (report) => {
      for (const sample of report.sessions[0].neutral.samples) {
        sample.extinction = [
          sample.extinction[2],
          sample.extinction[2],
          sample.extinction[2],
        ];
      }
    },
    "FAIL",
    /reddening is absent/u,
  );
  expectStatus(
    (report) => {
      report.sessions[0].neutral.samples[100].extinction[1] += 1e-5;
    },
    "FAIL",
    /independent scalar recomputation/u,
  );
});

test("rendered monotonicity, one-second continuity, and duration mutants are FAIL", () => {
  expectStatus(
    (report) => {
      const samples = report.sessions[0].neutral.samples;
      samples[110].image.linearEnergy = { rgb: [0, 0, 0], luminance: 0 };
    },
    "FAIL",
    /rendered sunrise curve reverses/u,
  );
  expectStatus(
    (report) => {
      const samples = report.sessions[0].neutral.samples;
      samples[90].image.linearEnergy.luminance = 0;
      samples[90].image.linearEnergy.rgb = [0, 0, 0];
      samples[91].image.linearEnergy.rgb = [0.5, 0.5, 0.5];
      samples[91].image.linearEnergy.luminance = 0.5;
    },
    "FAIL",
    /greater-than-10%-of-peak/u,
  );
  expectStatus(
    (report) => {
      for (const sample of report.sessions[0].neutral.samples) {
        const q = sample.offsetSeconds < 0 ? 0 : 1;
        sample.image.linearEnergy = { rgb: [q, q, q], luminance: q };
      }
    },
    "FAIL",
    /greater-than-10%-of-peak|multi-second development/u,
  );
  expectStatus(
    (report) => {
      for (const sample of report.sessions[0].neutral.samples) {
        const luminance = sample.image.linearEnergy.luminance;
        sample.image.linearEnergy.rgb = [luminance, luminance, luminance];
      }
    },
    "FAIL",
    /red-over-blue anchors/u,
  );
});

test("rendered color anchors distinguish supported blue from source-predicted sub-code blue", () => {
  const nearest = (report, rendererIndex, heightKm) =>
    report.sessions[rendererIndex].neutral.samples.reduce((best, sample) =>
      Math.abs(sample.tangentHeightKm - heightKm) <
      Math.abs(best.tangentHeightKm - heightKm)
        ? sample
        : best,
    );

  expectStatus(
    (report) => {
      const anchor25 = nearest(report, 0, 25);
      assert.ok(anchor25.extinction[2] * 255 >= 0.5);
      anchor25.image.linearEnergy.rgb[2] = 0;
      anchor25.image.linearEnergy.luminance =
        0.2126 * anchor25.image.linearEnergy.rgb[0] +
        0.7152 * anchor25.image.linearEnergy.rgb[1];
      anchor25.image.maxCodeByChannel[2] = 0;
      anchor25.image.aboveFloorPixelsByChannel[2] = 0;
    },
    "FAIL",
    /source-derived red-over-blue anchors/u,
  );
  expectStatus(
    (report) => {
      const anchor10 = nearest(report, 0, 10);
      assert.ok(anchor10.extinction[2] * 255 < 0.5);
      anchor10.image.maxCodeByChannel[2] = 1;
    },
    "FAIL",
    /source-derived red-over-blue anchors/u,
  );
  expectStatus(
    (report) => {
      const anchor10 = nearest(report, 0, 10);
      assert.equal(anchor10.image.maxCodeByChannel[2], 0);
      anchor10.image.aboveFloorPixelsByChannel[0] = 0;
    },
    "FAIL",
    /source-derived red-over-blue anchors/u,
  );

  const webglUnsupported = greenReport();
  const anchor25 = nearest(webglUnsupported, 0, 25);
  anchor25.image.linearEnergy.rgb[2] = 0;
  anchor25.image.linearEnergy.luminance =
    0.2126 * anchor25.image.linearEnergy.rgb[0] +
    0.7152 * anchor25.image.linearEnergy.rgb[1];
  anchor25.image.maxCodeByChannel[2] = 0;
  anchor25.image.aboveFloorPixelsByChannel[2] = 0;
  const verdict = foldC1229S4Gate(webglUnsupported);
  assert.equal(verdict.status, "FAIL");
  assert.match(verdict.failedPredicates.join("\n"), /red-over-blue/u);
});

test("path identity, prior ownership, redaction, and cooperative watchdog are adversarial", async () => {
  assert.throws(
    () => createS4ArtifactPaths(os.tmpdir(), "../../stale-pass"),
    /UUID v4 before artifact paths exist/u,
  );
  assert.equal(createS4ArtifactPaths(os.tmpdir(), RUN_ID).runId, RUN_ID);

  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "c12-29-s4-"));
  try {
    const latest = path.join(directory, "latest.json");
    fs.writeFileSync(
      latest,
      JSON.stringify({ status: "PASS", incomplete: false }),
    );
    assert.equal(inspectS4PriorLatest(latest).parsed.status, "PASS");
    fs.writeFileSync(latest, "{malformed");
    assert.match(inspectS4PriorLatest(latest).error, /malformed/u);
    fs.writeFileSync(
      latest,
      JSON.stringify({ runId: RUN_ID, status: "RUNNING", incomplete: true }),
    );
    assert.throws(
      () => inspectS4PriorLatest(latest),
      /previous RUNNING marker/u,
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }

  const redacted = redactS4OutputPayload({
    url: "https://user:password@example.invalid/x?ACCESS_TOKEN=one&subscription-key=two&se%73sion=three&client%5Fsecret=four&plain=five",
  });
  assert.equal(
    redacted.url,
    "https://[REDACTED]@example.invalid/x?ACCESS_TOKEN=[REDACTED]&subscription-key=[REDACTED]&se%73sion=[REDACTED]&client%5Fsecret=[REDACTED]&plain=[REDACTED]",
  );

  let releaseTask;
  const task = new Promise((resolve) => {
    releaseTask = resolve;
  });
  const control = {
    abortController: new AbortController(),
    browser: {
      async close() {
        releaseTask("drained");
      },
    },
    browserClosed: false,
    cleanupErrors: [],
    taskDrained: false,
    watchdogTimedOut: false,
    watchdogCloseAttempted: false,
    watchdogBrowserClosed: false,
  };
  await assert.rejects(
    withS4Watchdog(task, control, 5),
    /WATCHDOG exceeded 5 ms; drained task after timeout/u,
  );
  assert.equal(control.watchdogCloseAttempted, true);
  assert.equal(control.watchdogBrowserClosed, true);
  assert.equal(control.taskDrained, true);
});

test("served route capture gives each response body one sequential API owner", async () => {
  const routes = [
    "/Apps/CesiumViewer/favicon.ico",
    "/Build/CesiumUnminified/index.js",
  ];
  const calls = [];
  let active = 0;
  let maxActive = 0;
  let bodyReads = 0;
  const requestContext = {
    async get(url, options) {
      calls.push({ url, options });
      active++;
      maxActive = Math.max(maxActive, active);
      const bytes = Buffer.from(url, "utf8");
      return {
        async body() {
          bodyReads++;
          await new Promise((resolve) => setImmediate(resolve));
          active--;
          return bytes;
        },
        url: () => url,
        ok: () => true,
        status: () => 200,
      };
    },
  };
  const identities = await captureS4ServedViewerRoutes({
    requestContext,
    routes,
    baseOrigin: "http://localhost:8090",
    sessionLabel: "webgl",
  });
  assert.deepEqual(
    identities.map((entry) => entry.route),
    routes,
  );
  assert.equal(bodyReads, routes.length);
  assert.equal(maxActive, 1);
  assert.ok(
    calls.every(
      (call) =>
        call.options.failOnStatusCode === false &&
        call.options.maxRedirects === 0 &&
        call.options.timeout === 15_000,
    ),
  );
  assert.ok(
    identities.every(
      (entry) =>
        entry.ok === true &&
        entry.status === 200 &&
        entry.byteLength > 0 &&
        /^[0-9a-f]{64}$/u.test(entry.sha256),
    ),
  );
});

test("route07 failure publishes exact pre-session diagnostics and skips served capture", async (t) => {
  if (skipWithoutBuild(t)) {
    return;
  }
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "c12-29-s4-route07-"),
  );
  const listeners = new Map();
  const emit = (name, value) => {
    for (const listener of listeners.get(name) ?? []) {
      listener(value);
    }
  };
  let routeCount;
  let pageFetchCalls = 0;
  let servedRouteCalls = 0;
  let contextClosed = false;
  let browserClosed = false;
  const page = {
    on(name, listener) {
      const entries = listeners.get(name) ?? [];
      entries.push(listener);
      listeners.set(name, entries);
    },
    async goto() {},
    async waitForFunction() {},
    async evaluate(evaluateFunction, options) {
      assert.equal(evaluateFunction, captureS4PageRuntimeViewerRoutes);
      routeCount = options.viewerRoutePaths.length;
      assert.equal(routeCount, 39);
      assert.equal(
        options.viewerRoutePaths[7],
        "/Apps/CesiumViewer/favicon.ico",
      );
      emit("response", {
        url: () => "http://localhost:8080/Source/Widgets/shared.css",
        status: () => 503,
      });
      emit("request", {
        url: () => "https://outside.invalid/resource?token=secret",
      });
      return evaluateFunction({
        ...options,
        origin: "http://localhost:8080",
        documentPath: "/Apps/CesiumViewer/index.html",
        resourceEntries: [],
        digestImpl: async () => "a".repeat(64),
        fetchImpl: async (url, fetchOptions) => {
          const routeIndex = pageFetchCalls++;
          const parsed = new URL(url);
          assert.equal(parsed.origin, "http://localhost:8080");
          assert.equal(parsed.pathname, options.viewerRoutePaths[routeIndex]);
          assert.match(parsed.searchParams.get("__s4_identity"), /.+/u);
          assert.deepEqual(fetchOptions, {
            cache: "no-store",
            credentials: "same-origin",
            redirect: "error",
          });
          if (routeIndex === 7) {
            emit("requestfailed", {
              url: () => url,
              failure: () => ({
                errorText: "synthetic favicon transport failure",
              }),
            });
            throw new TypeError("synthetic favicon transport failure");
          }
          const bytes = new TextEncoder().encode(parsed.pathname);
          return {
            ok: true,
            status: 200,
            async arrayBuffer() {
              return bytes.buffer.slice(
                bytes.byteOffset,
                bytes.byteOffset + bytes.byteLength,
              );
            },
          };
        },
      });
    },
  };
  const context = {
    request: {
      async get() {
        servedRouteCalls++;
        throw new Error("served-route phase must not run");
      },
    },
    async route() {},
    async newPage() {
      return page;
    },
    async close() {
      contextClosed = true;
    },
  };
  const browser = {
    async newContext() {
      return context;
    },
    async close() {
      browserClosed = true;
    },
  };
  const previousExitCode = process.exitCode;
  const originalLog = console.log;
  console.log = () => {};
  try {
    const result = await runC1229S4Probe({
      runId: RUN_ID,
      outputDirectory: directory,
      launchBrowser: async () => browser,
      watchdogMs: 10_000,
    });
    assert.equal(result.artifact.status, "ERROR");
    assert.equal(result.artifact.exitCode, 2);
    assert.equal(result.artifact.sessions.length, 0);
    assert.equal(pageFetchCalls, 8);
    assert.equal(servedRouteCalls, 0);
    assert.equal(contextClosed, true);
    assert.equal(browserClosed, true);
    assert.equal(fs.existsSync(result.paths.run), true);
    const immutable = JSON.parse(fs.readFileSync(result.paths.run, "utf8"));
    assert.equal(immutable.status, "ERROR");
    assert.equal(immutable.exitCode, 2);
    assert.equal(immutable.backendDiagnostics.length, 1);
    const diagnostics = immutable.backendDiagnostics[0];
    assert.equal(diagnostics.requestedRenderer, "webgl");
    assert.equal(diagnostics.phase, "page-runtime-route-identity-error");
    assert.equal(diagnostics.servedRoutePhaseStarted, false);
    assert.equal(diagnostics.runtimeRouteFailure.renderer, "webgl");
    assert.equal(diagnostics.runtimeRouteFailure.routeIndex, 7);
    assert.equal(diagnostics.runtimeRouteFailure.routeOrdinal, 8);
    assert.equal(diagnostics.runtimeRouteFailure.routeCount, routeCount);
    assert.equal(
      diagnostics.runtimeRouteFailure.route,
      "/Apps/CesiumViewer/favicon.ico",
    );
    assert.equal(
      diagnostics.runtimeRouteFailure.path,
      "/Apps/CesiumViewer/favicon.ico",
    );
    assert.equal(
      diagnostics.runtimeRouteFailure.url,
      "http://localhost:8080/Apps/CesiumViewer/favicon.ico?__s4_identity=[REDACTED]",
    );
    assert.equal(
      diagnostics.runtimeRouteFailure.originalError,
      "synthetic favicon transport failure",
    );
    assert.deepEqual(diagnostics.httpErrors, [
      "503 http://localhost:8080/Source/Widgets/shared.css",
    ]);
    assert.deepEqual(diagnostics.externalRequests, [
      "https://outside.invalid/resource?token=[REDACTED]",
    ]);
    assert.equal(diagnostics.failedRequests.length, 1);
    assert.match(
      diagnostics.failedRequests[0],
      /^http:\/\/localhost:8080\/Apps\/CesiumViewer\/favicon\.ico\?__s4_identity=\[REDACTED\] :: synthetic favicon transport failure$/u,
    );
  } finally {
    console.log = originalLog;
    process.exitCode = previousExitCode;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("malformed prior latest becomes an owned immutable ERROR without launching", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "c12-29-s4-owned-"));
  const paths = createS4ArtifactPaths(directory, RUN_ID);
  fs.writeFileSync(paths.latest, "{malformed-stale-pass");
  let launched = false;
  const previousExitCode = process.exitCode;
  const originalLog = console.log;
  console.log = () => {};
  try {
    const result = await runC1229S4Probe({
      runId: RUN_ID,
      outputDirectory: directory,
      launchBrowser: async () => {
        launched = true;
        throw new Error("must not launch");
      },
      watchdogMs: 100,
    });
    assert.equal(launched, false);
    assert.equal(result.artifact.status, "ERROR");
    assert.equal(result.artifact.exitCode, 2);
    assert.equal(
      JSON.parse(fs.readFileSync(paths.latest, "utf8")).runId,
      RUN_ID,
    );
    assert.equal(fs.existsSync(paths.run), true);
    assert.equal(fs.existsSync(paths.firstRed), true);
    assert.equal(fs.existsSync(paths.lock), false);
  } finally {
    console.log = originalLog;
    process.exitCode = previousExitCode;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("browser close rejection retains authoritative RUNNING and lock", async (t) => {
  if (skipWithoutBuild(t)) {
    return;
  }
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "c12-29-s4-close-"));
  const paths = createS4ArtifactPaths(directory, RUN_ID);
  let closeAttempts = 0;
  const previousExitCode = process.exitCode;
  const originalLog = console.log;
  console.log = () => {};
  try {
    await assert.rejects(
      runC1229S4Probe({
        runId: RUN_ID,
        outputDirectory: directory,
        launchBrowser: async () => ({
          async close() {
            closeAttempts++;
            throw new Error("synthetic close rejection");
          },
          async newContext() {
            throw new Error("synthetic measurement failure");
          },
        }),
        watchdogMs: 100,
      }),
      /cleanup is uncertified/u,
    );
    assert.ok(closeAttempts >= 1);
    assert.equal(fs.existsSync(paths.lock), true);
    assert.equal(fs.existsSync(paths.run), false);
    const latest = JSON.parse(fs.readFileSync(paths.latest, "utf8"));
    assert.equal(latest.runId, RUN_ID);
    assert.equal(latest.status, "RUNNING");
    assert.equal(latest.incomplete, true);
  } finally {
    console.log = originalLog;
    process.exitCode = previousExitCode;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("lock-release failure restores owned RUNNING after final publication", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "c12-29-s4-lock-"));
  const paths = createS4ArtifactPaths(directory, RUN_ID);
  const marker = runningMarker(paths);
  fs.writeFileSync(paths.lock, serializeS4Artifact(marker));
  fs.writeFileSync(
    paths.latest,
    JSON.stringify({ runId: RUN_ID, status: "PASS", incomplete: false }),
  );
  try {
    assert.throws(
      () =>
        releaseS4LockOrRestoreRunning(
          paths,
          marker,
          fsOperations({
            unlinkSync(file) {
              // Model a filesystem that completes the unlink but reports a
              // post-operation failure. Recovery must recreate authority.
              fs.unlinkSync(file);
              const error = new Error("synthetic release denial");
              error.code = "EACCES";
              throw error;
            },
          }),
        ),
      /synthetic release denial/u,
    );
    assert.deepEqual(JSON.parse(fs.readFileSync(paths.latest, "utf8")), marker);
    assert.equal(fs.existsSync(paths.lock), true);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("silent lock-release no-op restores owned RUNNING instead of reporting final", () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "c12-29-s4-lock-noop-"),
  );
  const paths = createS4ArtifactPaths(directory, RUN_ID);
  const marker = runningMarker(paths);
  const markerBytes = serializeS4Artifact(marker);
  fs.writeFileSync(paths.lock, markerBytes);
  fs.writeFileSync(paths.latest, markerBytes);
  try {
    assert.throws(
      () =>
        finalizeS4Evidence(
          paths,
          finalLifecycleArtifact(),
          marker,
          fsOperations({
            unlinkSync(file) {
              if (String(file) === paths.lock) {
                return;
              }
              return fs.unlinkSync(file);
            },
          }),
        ),
      /S4 lock remained readable after release/u,
    );
    assert.equal(fs.readFileSync(paths.lock, "utf8"), markerBytes);
    assert.equal(fs.readFileSync(paths.latest, "utf8"), markerBytes);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("alien final UUID cannot be published through an owned S4 path", () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "c12-29-s4-alien-final-"),
  );
  const paths = createS4ArtifactPaths(directory, RUN_ID);
  const alienRunId = "223e4567-e89b-42d3-a456-426614174001";
  const alienPaths = createS4ArtifactPaths(directory, alienRunId);
  const marker = runningMarker(paths);
  const markerBytes = serializeS4Artifact(marker);
  fs.writeFileSync(paths.lock, markerBytes);
  fs.writeFileSync(paths.latest, markerBytes);
  try {
    assert.throws(
      () =>
        finalizeS4Evidence(
          paths,
          { ...finalLifecycleArtifact(), runId: alienRunId },
          marker,
        ),
      /final S4 artifact runId differs from its canonical path or owned RUNNING identity/u,
    );
    assert.equal(fs.readFileSync(paths.lock, "utf8"), markerBytes);
    assert.equal(fs.readFileSync(paths.latest, "utf8"), markerBytes);
    assert.equal(fs.existsSync(paths.run), false);
    assert.equal(fs.existsSync(alienPaths.run), false);
    assert.equal(fs.existsSync(paths.firstRed), false);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("identically corrupted archive/latest bytes cannot unlock publication", () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "c12-29-s4-corrupt-final-"),
  );
  const paths = createS4ArtifactPaths(directory, RUN_ID);
  const marker = runningMarker(paths);
  const artifact = finalLifecycleArtifact();
  const expectedBytes = serializeS4Artifact(artifact);
  const corruptBytes = Buffer.from("identically corrupted final bytes\n");
  fs.writeFileSync(paths.lock, serializeS4Artifact(marker));
  fs.writeFileSync(paths.latest, serializeS4Artifact(marker));
  try {
    let error;
    try {
      finalizeS4Evidence(
        paths,
        artifact,
        marker,
        fsOperations({
          writeFileSync(file, bytes, options) {
            const target = String(file);
            const corruptFinalWrite =
              target === paths.run ||
              (target.startsWith(`${paths.latest}.`) &&
                target.endsWith(".tmp") &&
                String(bytes) === expectedBytes);
            return fs.writeFileSync(
              file,
              corruptFinalWrite ? corruptBytes : bytes,
              options,
            );
          },
        }),
      );
    } catch (caught) {
      error = caught;
    }
    assert.match(error?.message ?? "", /exact serialized final artifact/u);
    assert.equal(error instanceof AggregateError, false);
    assert.equal(fs.existsSync(paths.lock), true);
    assert.deepEqual(JSON.parse(fs.readFileSync(paths.latest, "utf8")), marker);
    assert.equal(fs.readFileSync(paths.run).equals(corruptBytes), true);
    assert.notEqual(fs.readFileSync(paths.run, "utf8"), expectedBytes);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("silently corrupted new first-red bytes retain RUNNING authority", () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "c12-29-s4-corrupt-first-red-"),
  );
  const paths = createS4ArtifactPaths(directory, RUN_ID);
  const marker = runningMarker(paths);
  const artifact = {
    ...finalLifecycleArtifact(),
    status: "FAIL",
    exitCode: 1,
  };
  const artifactBytes = serializeS4Artifact(artifact);
  const corruptBytes = Buffer.from("silently corrupted first-red bytes\n");
  fs.writeFileSync(paths.lock, serializeS4Artifact(marker));
  fs.writeFileSync(paths.latest, serializeS4Artifact(marker));
  try {
    assert.throws(
      () =>
        finalizeS4Evidence(
          paths,
          artifact,
          marker,
          fsOperations({
            writeFileSync(file, bytes, options) {
              return fs.writeFileSync(
                file,
                String(file) === paths.firstRed ? corruptBytes : bytes,
                options,
              );
            },
          }),
        ),
      /new first-red S4 artifact differs from the exact serialized final artifact/u,
    );
    assert.deepEqual(JSON.parse(fs.readFileSync(paths.latest, "utf8")), marker);
    assert.deepEqual(JSON.parse(fs.readFileSync(paths.lock, "utf8")), marker);
    assert.equal(fs.readFileSync(paths.run, "utf8"), artifactBytes);
    assert.equal(fs.readFileSync(paths.firstRed).equals(corruptBytes), true);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("silently corrupted RUNNING recovery is repaired or removes final-looking latest", () => {
  for (const corruptEveryRecovery of [false, true]) {
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), "c12-29-s4-corrupt-recovery-"),
    );
    const paths = createS4ArtifactPaths(directory, RUN_ID);
    const marker = runningMarker(paths);
    const artifact = finalLifecycleArtifact();
    const markerBytes = serializeS4Artifact(marker);
    const finalBytes = serializeS4Artifact(artifact);
    fs.writeFileSync(paths.lock, markerBytes);
    fs.writeFileSync(paths.latest, markerBytes);
    let releaseAttempts = 0;
    let recoveryWrites = 0;
    try {
      let error;
      try {
        finalizeS4Evidence(
          paths,
          artifact,
          marker,
          fsOperations({
            writeFileSync(file, bytes, options) {
              const target = String(file);
              const isRecoveryWrite =
                (target === paths.latest ||
                  (target.startsWith(`${paths.latest}.`) &&
                    target.endsWith(".tmp"))) &&
                String(bytes) === markerBytes;
              if (isRecoveryWrite) {
                recoveryWrites++;
              }
              return fs.writeFileSync(
                file,
                isRecoveryWrite &&
                  (corruptEveryRecovery || recoveryWrites === 1)
                  ? finalBytes
                  : bytes,
                options,
              );
            },
            unlinkSync(file) {
              if (String(file) === paths.lock && releaseAttempts++ === 0) {
                const failure = new Error("synthetic lock release denial");
                failure.code = "EACCES";
                throw failure;
              }
              return fs.unlinkSync(file);
            },
          }),
        );
      } catch (caught) {
        error = caught;
      }
      assert.equal(error instanceof AggregateError, true);
      assert.match(
        error.message,
        /RUNNING authority recovery encountered additional failures/u,
      );
      assert.ok(recoveryWrites >= 2);
      assert.equal(fs.readFileSync(paths.lock, "utf8"), markerBytes);
      if (corruptEveryRecovery) {
        assert.equal(fs.existsSync(paths.latest), false);
      } else {
        assert.equal(fs.readFileSync(paths.latest, "utf8"), markerBytes);
      }
      assert.equal(fs.readFileSync(paths.run, "utf8"), finalBytes);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  }
});

test("silently corrupted recreated lock is repaired and aggregated", () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "c12-29-s4-corrupt-recreated-lock-"),
  );
  const paths = createS4ArtifactPaths(directory, RUN_ID);
  const marker = runningMarker(paths);
  const artifact = finalLifecycleArtifact();
  const markerBytes = serializeS4Artifact(marker);
  const corruptBytes = serializeS4Artifact(artifact);
  fs.writeFileSync(paths.lock, markerBytes);
  fs.writeFileSync(paths.latest, markerBytes);
  let releaseAttempted = false;
  let recreatedWrites = 0;
  try {
    let error;
    try {
      finalizeS4Evidence(
        paths,
        artifact,
        marker,
        fsOperations({
          writeFileSync(file, bytes, options) {
            if (
              String(file) === paths.lock &&
              options?.flag === "wx" &&
              releaseAttempted
            ) {
              recreatedWrites++;
              return fs.writeFileSync(file, corruptBytes, options);
            }
            return fs.writeFileSync(file, bytes, options);
          },
          unlinkSync(file) {
            if (String(file) === paths.lock && !releaseAttempted) {
              releaseAttempted = true;
              fs.unlinkSync(file);
              const failure = new Error("synthetic post-unlink failure");
              failure.code = "EACCES";
              throw failure;
            }
            return fs.unlinkSync(file);
          },
        }),
      );
    } catch (caught) {
      error = caught;
    }
    assert.equal(error instanceof AggregateError, true);
    assert.match(
      error.message,
      /RUNNING authority recovery encountered additional failures/u,
    );
    assert.equal(recreatedWrites, 1);
    assert.equal(fs.readFileSync(paths.lock, "utf8"), markerBytes);
    assert.equal(fs.readFileSync(paths.latest, "utf8"), markerBytes);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("pre-unlink lock EIO still restores canonical RUNNING and aggregates", () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "c12-29-s4-lock-read-eio-"),
  );
  const paths = createS4ArtifactPaths(directory, RUN_ID);
  const marker = runningMarker(paths);
  const artifact = finalLifecycleArtifact();
  fs.writeFileSync(paths.lock, serializeS4Artifact(marker));
  fs.writeFileSync(paths.latest, serializeS4Artifact(marker));
  let lockReads = 0;
  try {
    let error;
    try {
      finalizeS4Evidence(
        paths,
        artifact,
        marker,
        fsOperations({
          readFileSync(file, ...args) {
            if (String(file) === paths.lock && ++lockReads >= 2) {
              const failure = new Error("synthetic pre-unlink lock read EIO");
              failure.code = "EIO";
              throw failure;
            }
            return fs.readFileSync(file, ...args);
          },
        }),
      );
    } catch (caught) {
      error = caught;
    }
    assert.match(
      error?.message ?? "",
      /RUNNING authority recovery encountered additional failures/u,
    );
    assert.equal(error instanceof AggregateError, true);
    assert.equal(error.errors.length, 2);
    assert.ok(
      error.errors.every((failure) => failure.code === "EIO"),
      "release and authority-read EIO failures must both remain visible",
    );
    assert.equal(fs.existsSync(paths.lock), true);
    assert.deepEqual(JSON.parse(fs.readFileSync(paths.latest, "utf8")), marker);
    assert.equal(
      fs.readFileSync(paths.run, "utf8"),
      serializeS4Artifact(artifact),
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("backend source and rendered parity mutants are independently red-capable", () => {
  expectStatus(
    (report) => {
      report.sessions[1].neutral.samples[100].extinction[0] += 1e-5;
    },
    "FAIL",
    /source extinction is not numerically identical/u,
  );
  expectStatus(
    (report) => {
      for (const sample of report.sessions[1].neutral.samples) {
        const q = sample.offsetSeconds < 10 ? 0.1 : 1;
        sample.image.linearEnergy.rgb = [q, q, q];
        sample.image.linearEnergy.luminance = q;
      }
    },
    "FAIL",
    /rendered (?:luminance|red|green|blue) curves differ/u,
  );
});

test("normal appearance and runtime error surfaces are gated", () => {
  expectStatus(
    (report) => {
      const capture = report.sessions[0].normal.captures[0];
      capture.tilesLoaded = false;
      capture.settledFrames = 36;
    },
    "STRUCTURAL",
    /loaded, immutable registered visual-review anchor/u,
  );
  expectStatus(
    (report) => {
      report.sessions[0].normal.captures[0].settledFrames = 7;
    },
    "STRUCTURAL",
    /loaded, immutable registered visual-review anchor/u,
  );
  expectStatus(
    (report) => {
      report.sessions[0].normal.captures.at(-1).image.nonBlackPixels = 0;
    },
    "FAIL",
    /normal appearance lane is black/u,
  );
  for (const [field, pattern] of [
    ["consoleErrors", /console errors/u],
    ["pageErrors", /page errors/u],
    ["deviceErrors", /device\/GPU errors/u],
  ]) {
    expectStatus(
      (report) => {
        report.sessions[0][field] = ["synthetic failure"];
      },
      "FAIL",
      pattern,
    );
  }
});

test("probe source hard-pins lifecycle publication order and cleanup", () => {
  assert.match(probeSource, /randomUUID\(\)/u);
  assert.match(probeSource, /status: "RUNNING",\s*incomplete: true/u);
  const lockRunning = probeSource.indexOf(
    "replaceOwnedS4RunLock(paths, runningMarker, operations)",
  );
  const running = probeSource.indexOf(
    "publishS4Running(paths, runningMarker, operations)",
  );
  const firstRedRead = probeSource.indexOf(
    "fingerprintEvidenceFile(paths.firstRed)",
  );
  const provenanceRead = probeSource.indexOf("collectS4Provenance()", running);
  const launch = probeSource.indexOf("launchBrowser(browserLaunch)");
  assert.ok(
    lockRunning >= 0 && lockRunning < running && running < launch,
    "RUNNING must persist before setup",
  );
  assert.ok(running < firstRedRead && running < provenanceRead);
  const archive = probeSource.indexOf(
    "createImmutableEvidence(paths.run, bytes, operations)",
  );
  const firstRed = probeSource.indexOf(
    "preserveFirstRedEvidence(paths.firstRed, bytes, operations)",
  );
  const latest = probeSource.indexOf(
    "atomicReplaceEvidence(paths.latest, bytes, operations)",
    archive,
  );
  assert.ok(archive >= 0 && archive < firstRed && firstRed < latest);
  assert.match(probeSource, /status: "ERROR"/u);
  assert.match(probeSource, /finally\s*\{[\s\S]*?browser\.close\(\)/u);
  assert.match(probeSource, /watchdog\.unref\(\)/u);
  assert.match(probeSource, /process\.exitCode = artifact\.exitCode/u);
  assert.match(probeSource, /withS4Watchdog\(/u);
  assert.match(probeSource, /const drained = await Promise\.race/u);
  assert.match(
    probeSource,
    /releaseS4RunLock\(paths, runningMarker, operations\)/u,
  );
  assert.match(
    probeSource,
    /ensureAuthoritativeRunningLock\(paths, runningMarker, operations\)/u,
  );
});

test("probe source hard-pins exact evidence and same-task direct canvas capture", () => {
  assert.match(probeSource, /inspectBuildSourceIdentity\(/u);
  assert.match(probeSource, /validateServedEntryIdentities\(/u);
  assert.match(probeSource, /runtimeImportIdentity/u);
  assert.match(probeSource, /runtimeViewerRouteIdentity/u);
  assert.match(probeSource, /servedViewerRoutes/u);
  assert.match(probeSource, /requiredViewerRoutePaths/u);
  assert.match(probeSource, /sameOriginResourceLedger/u);
  assert.match(probeSource, /executionLedger/u);
  assert.match(probeSource, /supportResourceLedger/u);
  assert.match(probeSource, /resourceType: entry\.initiatorType/u);
  assert.match(probeSource, /unregisteredExecutedRoutes/u);
  const exactScriptWorkerChunkPattern = String.raw`/^\/Build\/CesiumUnminified\/Workers\/chunk-[A-Z0-9]+\.js$/u`;
  assert.equal(probeSource.split(exactScriptWorkerChunkPattern).length - 1, 2);
  assert.equal(gateSource.split(exactScriptWorkerChunkPattern).length - 1, 1);
  assert.equal(
    probeSource.split('(resourceType === "script" && scriptWorkerChunkRoute)')
      .length - 1,
    2,
  );
  assert.equal(
    gateSource.split('(resourceType === "script" && scriptWorkerChunkRoute)')
      .length - 1,
    1,
  );
  assert.match(probeSource, /file\.endsWith\("\.html"\)/u);
  assert.match(probeSource, /file\.endsWith\("\.css"\)/u);
  assert.match(
    probeSource,
    /page\.evaluate\(captureS4PageRuntimeViewerRoutes/u,
  );
  assert.match(probeSource, /const requestUrl = new URL\(route, origin\)/u);
  assert.match(
    probeSource,
    /requestUrl\.searchParams\.set\(\s*"__s4_identity"/u,
  );
  assert.match(probeSource, /cache: "no-store"/u);
  assert.match(probeSource, /credentials: "same-origin"/u);
  assert.match(probeSource, /redirect: "error"/u);
  assert.match(probeSource, /S4_RUNTIME_ROUTE_FETCH_ERROR/u);
  assert.match(probeSource, /backendDiagnostics/u);
  assert.match(probeSource, /servedRoutePhaseStarted: false/u);
  assert.doesNotMatch(
    probeSource,
    /await fetch\(route, \{ cache: "no-store" \}\)/u,
  );
  assert.match(probeSource, /const response = await requestContext\.get/u);
  assert.match(probeSource, /requestContext: context\.request/u);
  const pageResponseStart = probeSource.indexOf('page.on("response"');
  const pageRequestStart = probeSource.indexOf(
    'page.on("request"',
    pageResponseStart,
  );
  assert.ok(pageResponseStart >= 0 && pageRequestStart > pageResponseStart);
  assert.doesNotMatch(
    probeSource.slice(pageResponseStart, pageRequestStart),
    /response\.body\(\)/u,
    "live page response streams must not compete with explicit runtime fetches",
  );
  assert.match(probeSource, /browser\.newContext\(/u);
  assert.match(
    probeSource,
    /scene\.camera\.frustum\.fov = neutralScene\.cameraFovRadians/u,
  );
  assert.doesNotMatch(probeSource, /C\.Math\.toRadians\(6\)/u);
  assert.match(probeSource, /const sunPipelineReadiness =/u);
  assert.match(probeSource, /scene\.environmentState\.sunDrawCommand/u);
  assert.match(probeSource, /sunCommand\?\.pipeline/u);
  assert.match(probeSource, /sunPipelineReadiness\.yieldedTurns\+\+;/u);
  assert.match(probeSource, /status = "READY"/u);
  assert.match(probeSource, /scene\.canvas\.toDataURL\("image\/png"\)/u);
  assert.doesNotMatch(probeSource, /drawImage\s*\(/u);
  assert.match(probeSource, /requestfailed/u);
  assert.match(probeSource, /externalRequests/u);
  assert.match(probeSource, /deviceErrors/u);
  const queueDrain = probeSource.indexOf("device.queue.onSubmittedWorkDone()");
  const deviceSnapshot = probeSource.indexOf("graphicsCompletion,", queueDrain);
  assert.ok(queueDrain >= 0 && queueDrain < deviceSnapshot);
  assert.match(probeSource, /const gl = scene\.context\._gl/u);
  assert.match(probeSource, /gl\.finish\(\)/u);
  assert.match(probeSource, /errorCode = gl\.getError\(\)/u);
  assert.match(
    probeSource,
    /atmosphereLightIntensity =\s*neutralScene\.atmosphereLightIntensity/u,
  );
  assert.match(probeSource, /enableEclipse = false/u);
  assert.match(probeSource, /sourceInputs/u);
  assert.match(probeSource, /redactS4OutputPayload/u);
  assert.match(probeSource, /captureMethod: C12_29_S4_CAPTURE_METHOD/u);
  assert.match(probeSource, /const cleanupCertified =/u);
  assert.match(probeSource, /browserControl\.browserAcquired/u);
  assert.match(probeSource, /S4_CLEANUP_UNCERTIFIED/u);

  const normalSettleStart = probeSource.indexOf(
    "const captureSettledNormalFrame = async (frame) =>",
  );
  const terminalStart = probeSource.indexOf(
    "// S4_TERMINAL_NORMAL_CAPTURE_START",
    normalSettleStart,
  );
  const terminalEnd = probeSource.indexOf(
    "// S4_TERMINAL_NORMAL_CAPTURE_END",
    terminalStart,
  );
  const terminalRender = probeSource.lastIndexOf(
    "scene.render(frame.time);",
    terminalStart,
  );
  assert.ok(
    normalSettleStart >= 0 &&
      terminalRender > normalSettleStart &&
      terminalStart > terminalRender &&
      terminalEnd > terminalStart,
  );
  const fusedTerminalCapture = probeSource.slice(terminalRender, terminalEnd);
  assert.match(fusedTerminalCapture, /scene\.render\(frame\.time\)/u);
  assert.match(
    fusedTerminalCapture,
    /scene\.canvas\.toDataURL\("image\/png"\)/u,
  );
  assert.doesNotMatch(fusedTerminalCapture, /\bawait\b|setTimeout/u);
  const normalSettleSource = probeSource.slice(
    normalSettleStart,
    probeSource.indexOf("const normalCaptures = []", normalSettleStart),
  );
  assert.match(
    normalSettleSource,
    /await new Promise\(\(resolve\) => setTimeout\(resolve, 0\)\)/u,
  );
});
