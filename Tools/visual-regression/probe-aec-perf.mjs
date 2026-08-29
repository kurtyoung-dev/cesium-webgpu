#!/usr/bin/env node
// @purpose AEC design-model performance probe: one page load per streaming lever, timed to Scene.renderReady, per-pass command counts, one validated pick reused on both backends, served-build preflight and origin-guard refusals, element screenshots, multi-metric receipts.
// @status ACTIVE
// DM-01 — isolated AEC streaming/performance probe.
//
// Preconditions:
//   node server.js --port 8094 --serve-built
//
// Examples:
//   node Tools/visual-regression/probe-aec-perf.mjs --runs 3
//   node Tools/visual-regression/probe-aec-perf.mjs --runs 3 --reverse
//   node Tools/visual-regression/probe-aec-perf.mjs --headed
//
// Exit codes:
//   0 measurement completed
//   2 probe/runtime error
//   3 refusal: the requested measurement could not be validated

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const EXIT_CODES = Object.freeze({
  OK: 0,
  ERROR: 2,
  REFUSAL: 3,
});

export const REQUIRED_SERVED_ARTIFACTS = Object.freeze([
  "Build/CesiumUnminified/Cesium.js",
  "packages/engine/Build/Unminified/index.js",
]);

export const STREAMING_LEVERS = Object.freeze([
  "maximumScreenSpaceError",
  "preferLeaves",
  "preloadWhenHidden",
  "cullRequestsWhileMovingMultiplier",
  "requestRenderMode",
]);

export const EXTRA_LEVERS = Object.freeze([
  "resolutionScale",
  "logarithmicDepthBuffer",
]);

const HARNESS_PATH = "/Tools/visual-regression/aec-perf-harness.html";

const LEG_DEFINITIONS = Object.freeze([
  {
    id: "baseline",
    label: "Baseline",
    lever: null,
    pageLoad: "dedicated-new-page",
    pageLoadId: "page:baseline",
    application: null,
  },
  {
    id: "maximum-screen-space-error-32",
    label: "maximumScreenSpaceError = 32",
    lever: "maximumScreenSpaceError",
    pageLoad: "dedicated-new-page",
    pageLoadId: "page:maximum-screen-space-error-32",
    application: {
      phase: "before-tileset-creation",
      target: "tileset-options",
      property: "maximumScreenSpaceError",
      value: 32,
    },
  },
  {
    id: "prefer-leaves",
    label: "preferLeaves = true",
    lever: "preferLeaves",
    pageLoad: "dedicated-new-page",
    pageLoadId: "page:prefer-leaves",
    application: {
      phase: "before-tileset-creation",
      target: "tileset-options",
      property: "preferLeaves",
      value: true,
    },
  },
  {
    id: "preload-when-hidden",
    label: "preloadWhenHidden = true",
    lever: "preloadWhenHidden",
    pageLoad: "dedicated-new-page",
    pageLoadId: "page:preload-when-hidden",
    application: {
      phase: "before-tileset-creation",
      target: "tileset-options",
      property: "preloadWhenHidden",
      value: true,
    },
  },
  {
    id: "cull-requests-while-moving-zero",
    label: "cullRequestsWhileMovingMultiplier = 0",
    lever: "cullRequestsWhileMovingMultiplier",
    pageLoad: "dedicated-new-page",
    pageLoadId: "page:cull-requests-while-moving-zero",
    application: {
      phase: "before-tileset-creation",
      target: "tileset-options",
      property: "cullRequestsWhileMovingMultiplier",
      value: 0,
    },
  },
  {
    id: "request-render-mode",
    label: "requestRenderMode = true",
    lever: "requestRenderMode",
    pageLoad: "dedicated-new-page",
    pageLoadId: "page:request-render-mode",
    application: {
      phase: "before-tileset-creation",
      target: "scene",
      property: "requestRenderMode",
      value: true,
    },
  },
  {
    id: "resolution-scale-075",
    label: "resolutionScale = 0.75",
    lever: "resolutionScale",
    pageLoad: "dedicated-new-page",
    pageLoadId: "page:resolution-scale-075",
    application: {
      phase: "before-tileset-creation",
      target: "viewer",
      property: "resolutionScale",
      value: 0.75,
    },
  },
  {
    id: "logarithmic-depth-buffer-off",
    label: "logarithmicDepthBuffer = false",
    lever: "logarithmicDepthBuffer",
    pageLoad: "dedicated-new-page",
    pageLoadId: "page:logarithmic-depth-buffer-off",
    application: {
      phase: "before-tileset-creation",
      target: "scene",
      property: "logarithmicDepthBuffer",
      value: false,
    },
  },
]);

const HARNESS_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>AEC performance probe</title>
  <link rel="stylesheet" href="/Build/CesiumUnminified/Widgets/widgets.css">
  <style>
    html, body, #cesiumContainer {
      width: 100%;
      height: 100%;
      margin: 0;
      padding: 0;
      overflow: hidden;
      background: #000;
    }
  </style>
</head>
<body>
<div id="cesiumContainer"></div>
<script type="module">
window.CESIUM_BASE_URL = "/Build/CesiumUnminified/";
const Cesium = await import("/Build/CesiumUnminified/index.js");
window.Cesium = Cesium;
window.__aecErrors = [];

window.addEventListener("error", function (event) {
  window.__aecErrors.push("window.error: " + String(event.message || event.error));
});
window.addEventListener("unhandledrejection", function (event) {
  window.__aecErrors.push("unhandledrejection: " + String(event.reason));
});

function clone(value) {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch (error) {
    return { error: String(error && error.message ? error.message : error) };
  }
}

function sameValue(left, right) {
  return typeof left === "number" && typeof right === "number"
    ? Math.abs(left - right) <= Number.EPSILON * Math.max(1, Math.abs(left), Math.abs(right))
    : Object.is(left, right);
}

window.__aecBuild = async function (input) {
  const startedAt = performance.now();
  const audit = {
    sequence: [],
    leverConfiguredAt: null,
    firstTilesetCreationStartedAt: null,
    firstTilesetAddedAt: null,
    engineReadbacks: [],
    addedAtByTitle: {},
    firstTraversal: null,
  };
  let sequenceNumber = 0;

  function mark(name, details) {
    const event = {
      order: ++sequenceNumber,
      name: name,
      details: details || null,
    };
    audit.sequence.push(event);
    return event.order;
  }

  const application = input.leg.application;
  const viewerOptions = {
    globe: false,
    useBrowserRecommendedResolution: false,
    contextOptions: { renderer: input.renderer },
  };

  if (
    application &&
    application.target === "scene" &&
    application.property === "requestRenderMode"
  ) {
    viewerOptions.requestRenderMode = application.value;
  }

  mark("viewer-create-start");
  const viewer = await Cesium.Viewer.createAsync(
    document.getElementById("cesiumContainer"),
    viewerOptions,
  );
  mark("viewer-create-complete");

  window.viewer = viewer;
  viewer.useDefaultRenderLoop = false;
  const scene = viewer.scene;

  if (typeof scene.renderReady !== "boolean") {
    return {
      ok: false,
      refusalReason: "render-ready-unavailable",
      audit: audit,
      errors: window.__aecErrors.slice(),
    };
  }

  const tilesetOptions = {};
  if (application) {
    let readback;

    if (application.target === "tileset-options") {
      tilesetOptions[application.property] = application.value;
      readback = tilesetOptions[application.property];
    } else if (application.target === "viewer") {
      viewer[application.property] = application.value;
      readback = viewer[application.property];
    } else if (application.target === "scene") {
      scene[application.property] = application.value;
      readback = scene[application.property];
    } else {
      return {
        ok: false,
        refusalReason: "unknown-lever-target",
        audit: audit,
        errors: window.__aecErrors.slice(),
      };
    }

    audit.leverConfiguredAt = mark("lever-configured", {
      lever: input.leg.lever,
      target: application.target,
      property: application.property,
      requestedValue: application.value,
      engineReadback: readback,
      readbackMatches: sameValue(readback, application.value),
    });
  }

  try {
    Cesium.CesiumDebug(viewer);
  } catch (error) {
    window.__aecErrors.push("debug: " + String(error.message || error));
  }

  scene.skyAtmosphere.show = true;
  const stages = scene.postProcessStages;
  if (Cesium.PostProcessStageLibrary.isAmbientOcclusionSupported(scene)) {
    const ao = stages.ambientOcclusion;
    ao.enabled = true;
    ao.uniforms.intensity = 2.0;
    ao.uniforms.bias = 0.1;
    ao.uniforms.lengthCap = 0.5;
    ao.uniforms.directionCount = 16;
    ao.uniforms.stepCount = 32;
  }

  viewer.clock.currentTime = Cesium.JulianDate.fromIso8601(
    "2024-11-22T18:00:00Z",
  );
  viewer.camera.setView({
    destination: Cesium.Cartesian3.fromDegrees(
      -79.886626,
      40.021649,
      235.65,
    ),
    orientation: {
      heading: 0,
      pitch: Cesium.Math.toRadians(-20),
      roll: 0,
    },
  });

  const definitions = [
    { title: "Google", assetId: 2275207, visible: true },
    { title: "Architecture", assetId: 2887123, visible: true },
    { title: "Facade", assetId: 2887125, visible: true },
    { title: "Structural", assetId: 2887130, visible: false },
    { title: "Electrical", assetId: 2887124, visible: true },
    { title: "HVAC", assetId: 2887126, visible: true },
    { title: "Plumbing", assetId: 2887127, visible: true },
    { title: "Site", assetId: 2887129, visible: true },
  ];

  const tilesets = [];
  for (const definition of definitions) {
    const createOrder = mark("tileset-create-start", {
      title: definition.title,
      options: clone(tilesetOptions),
    });
    if (audit.firstTilesetCreationStartedAt === null) {
      audit.firstTilesetCreationStartedAt = createOrder;
    }

    const tileset = await Cesium.Cesium3DTileset.fromIonAssetId(
      definition.assetId,
      clone(tilesetOptions),
    );

    const readbackOrder = mark("tileset-created-engine-readback", {
      title: definition.title,
      property: application && application.target === "tileset-options"
        ? application.property
        : null,
      value: application && application.target === "tileset-options"
        ? tileset[application.property]
        : null,
    });

    if (application && application.target === "tileset-options") {
      audit.engineReadbacks.push({
        title: definition.title,
        order: readbackOrder,
        property: application.property,
        value: tileset[application.property],
      });
    }

    tileset.show = definition.visible;

    if (definition.title === "Google") {
      const positions = Cesium.Cartesian3.fromDegreesArray([
        -79.887735, 40.022564,
        -79.886341, 40.023087,
        -79.886161, 40.023087,
        -79.885493, 40.022032,
        -79.887030, 40.021456,
        -79.887735, 40.022564,
      ]);
      tileset.clippingPolygons = new Cesium.ClippingPolygonCollection({
        polygons: [new Cesium.ClippingPolygon({ positions: positions })],
      });
    }

    const addOrder = mark("tileset-add", { title: definition.title });
    if (audit.firstTilesetAddedAt === null) {
      audit.firstTilesetAddedAt = addOrder;
    }
    audit.addedAtByTitle[definition.title] = addOrder;
    scene.primitives.add(tileset);
    tilesets.push({ title: definition.title, tileset: tileset });
  }

  window.__aecTilesets = tilesets;

  function sceneFrameNumber() {
    if (typeof scene.frameNumber === "number") {
      return scene.frameNumber;
    }
    return scene.frameState && typeof scene.frameState.frameNumber === "number"
      ? scene.frameState.frameNumber
      : null;
  }

  function captureFirstTraversal() {
    if (audit.firstTraversal !== null) {
      return;
    }

    const traversed = tilesets.some(function (entry) {
      const statistics = entry.tileset.statistics || {};
      return (
        Number(statistics.visited || 0) > 0 ||
        Number(statistics.selected || 0) > 0
      );
    });

    if (!traversed) {
      return;
    }

    audit.firstTraversal = {
      order: mark("first-tileset-traversal"),
      sceneFrameNumber: sceneFrameNumber(),
      maximumScreenSpaceErrorByTileset: tilesets.map(function (entry) {
        return {
          title: entry.title,
          value: entry.tileset.maximumScreenSpaceError,
          source: "engine-readback-at-first-traversal",
        };
      }),
    };
  }

  scene.postUpdate.addEventListener(captureFirstTraversal);

  const fixedTime = Cesium.JulianDate.clone(viewer.clock.currentTime);
  const readyStartedAt = performance.now();
  const deadline = readyStartedAt + input.timeoutMs;
  let framesToRenderReady = 0;
  let becameReady = false;

  while (performance.now() < deadline) {
    scene.requestRender();
    scene.forceRender(fixedTime);
    framesToRenderReady++;

    if (scene.renderReady === true) {
      becameReady = true;
      break;
    }

    await new Promise(function (resolve) {
      setTimeout(resolve, 0);
    });
  }

  scene.postUpdate.removeEventListener(captureFirstTraversal);

  if (!becameReady) {
    return {
      ok: false,
      refusalReason: "render-ready-timeout",
      audit: audit,
      readiness: {
        timeToRenderReadyMs: performance.now() - startedAt,
        framesToRenderReady: framesToRenderReady,
        sceneFrameNumber: sceneFrameNumber(),
      },
      errors: window.__aecErrors.slice(),
    };
  }

  const debugSnapshot = typeof scene.getDebugSnapshot === "function"
    ? clone(scene.getDebugSnapshot())
    : { error: "Scene.getDebugSnapshot is unavailable" };

  const passNames = {};
  for (const pair of Object.entries(Cesium.Pass || {})) {
    if (typeof pair[1] === "number" && pair[0] !== "NUMBER_OF_PASSES") {
      passNames[String(pair[1])] = pair[0];
    }
  }

  const frameState = {
    passNames: passNames,
    commandList: Array.from(
      scene.frameState && scene.frameState.commandList
        ? scene.frameState.commandList
        : [],
      function (command) {
        const rawPass = command && command.pass !== undefined
          ? command.pass
          : "UNKNOWN";
        return {
          pass: passNames[String(rawPass)] || String(rawPass),
        };
      },
    ),
  };

  const frameTimes = [];
  for (let index = 0; index < input.sampleFrames; index++) {
    const elapsed = await new Promise(function (resolve) {
      requestAnimationFrame(function () {
        const frameStartedAt = performance.now();
        let completed = false;

        function onPostRender() {
          if (completed) {
            return;
          }
          completed = true;
          scene.postRender.removeEventListener(onPostRender);
          resolve(performance.now() - frameStartedAt);
        }

        scene.postRender.addEventListener(onPostRender);
        scene.requestRender();
        scene.forceRender(fixedTime);
      });
    });
    frameTimes.push(elapsed);
  }

  const memory = performance.memory;
  window.__aecFixedTime = fixedTime;

  function isAECFeature(picked) {
    if (picked instanceof Cesium.Cesium3DTileFeature) {
      return true;
    }

    return tilesets.some(function (entry) {
      return (
        picked &&
        (
          picked.primitive === entry.tileset ||
          picked.tileset === entry.tileset ||
          (picked.content && picked.content.tileset === entry.tileset)
        )
      );
    });
  }

  window.__aecFindPick = async function () {
    const width = scene.canvas.clientWidth;
    const height = scene.canvas.clientHeight;
    const point = new Cesium.Cartesian2();
    const tried = [];

    for (let row = 0; row < 7; row++) {
      for (let column = 0; column < 9; column++) {
        point.x = Math.round(width * (0.15 + column * 0.0875));
        point.y = Math.round(height * (0.20 + row * 0.10));

        scene.pick(point);
        scene.requestRender();
        scene.forceRender(fixedTime);
        const picked = scene.pick(point);
        const hit = isAECFeature(picked);

        tried.push({
          x: point.x,
          y: point.y,
          hit: hit,
          type: picked && picked.constructor
            ? picked.constructor.name
            : null,
        });

        if (hit) {
          return {
            found: true,
            x: point.x,
            y: point.y,
            tried: tried,
          };
        }
      }
    }

    return { found: false, tried: tried };
  };

  window.__aecValidatePick = async function (position) {
    const point = new Cesium.Cartesian2(position.x, position.y);
    scene.pick(point);
    scene.requestRender();
    scene.forceRender(fixedTime);
    const picked = scene.pick(point);
    return {
      x: position.x,
      y: position.y,
      hit: isAECFeature(picked),
      type: picked && picked.constructor ? picked.constructor.name : null,
    };
  };

  window.__aecPickTable = async function (position, sampleCount) {
    const point = new Cesium.Cartesian2(position.x, position.y);
    const rows = [];

    scene.pick(point);
    scene.requestRender();
    scene.forceRender(fixedTime);
    scene.pick(point);
    scene.requestRender();
    scene.forceRender(fixedTime);

    for (let sample = 0; sample < sampleCount; sample++) {
      const pickStartedAt = performance.now();
      const picked = scene.pick(point);
      const wallMs = performance.now() - pickStartedAt;

      rows.push({
        sample: sample + 1,
        x: position.x,
        y: position.y,
        wallMs: wallMs,
        hit: isAECFeature(picked),
        type: picked && picked.constructor ? picked.constructor.name : null,
      });

      scene.requestRender();
      scene.forceRender(fixedTime);
      await Promise.resolve();
    }

    return rows;
  };

  return {
    ok: true,
    rendererType: scene.context.rendererType,
    readiness: {
      timeToRenderReadyMs: performance.now() - startedAt,
      readinessWaitMs: performance.now() - readyStartedAt,
      framesToRenderReady: framesToRenderReady,
      sceneFrameNumber:
        debugSnapshot &&
        debugSnapshot.scene &&
        typeof debugSnapshot.scene.frameNumber === "number"
          ? debugSnapshot.scene.frameNumber
          : sceneFrameNumber(),
    },
    audit: audit,
    debugSnapshot: debugSnapshot,
    frameState: frameState,
    frameTimes: frameTimes,
    memory: memory
      ? {
          usedJSHeapMB: memory.usedJSHeapSize / 1048576,
        }
      : {
          usedJSHeapMB: null,
        },
    errors: window.__aecErrors.slice(),
  };
};

window.__aecHarnessReady = true;
</script>
</body>
</html>`;

export class RefusalError extends Error {
  constructor(reason, message, details = null) {
    super(message);
    this.name = "AECProbeRefusal";
    this.reason = reason;
    this.exitCode = EXIT_CODES.REFUSAL;
    this.details = details;
  }
}

function acceptedDecision() {
  return {
    refuse: false,
    exitCode: EXIT_CODES.OK,
    reason: null,
  };
}

function refusedDecision(reason, details = null) {
  return {
    refuse: true,
    exitCode: EXIT_CODES.REFUSAL,
    reason,
    details,
  };
}

function copyApplication(application) {
  return application ? { ...application } : null;
}

export function buildLegMatrix() {
  return LEG_DEFINITIONS.map((leg) => ({
    ...leg,
    application: copyApplication(leg.application),
  }));
}

export function buildRunOrder({
  runs,
  reverse = false,
  legs = buildLegMatrix(),
}) {
  if (!Number.isInteger(runs) || runs < 1) {
    throw new TypeError("runs must be a positive integer");
  }

  const backends = reverse ? ["webgpu", "webgl"] : ["webgl", "webgpu"];
  const order = [];

  for (let run = 1; run <= runs; run++) {
    for (const leg of legs) {
      for (const backend of backends) {
        order.push({
          run,
          backend,
          leg: {
            ...leg,
            application: copyApplication(leg.application),
          },
        });
      }
    }
  }

  return order;
}

function optionValue(argv, index, name) {
  if (index + 1 >= argv.length || argv[index + 1].startsWith("--")) {
    throw new TypeError(`${name} requires a value`);
  }
  return argv[index + 1];
}

function positiveInteger(value, name) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new TypeError(`${name} must be a positive integer`);
  }
  return parsed;
}

export function parseArgs(argv) {
  const options = {
    port: 8094,
    runs: 1,
    reverse: false,
    headed: false,
    sampleFrames: 120,
    pickSamples: 40,
    timeoutMs: 120000,
    repositoryRoot: null,
    outputDirectory: null,
  };

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];

    if (arg === "--reverse") {
      options.reverse = true;
    } else if (arg === "--headed") {
      options.headed = true;
    } else if (arg === "--port") {
      options.port = positiveInteger(optionValue(argv, index, arg), "--port");
      index++;
    } else if (arg === "--runs") {
      options.runs = positiveInteger(optionValue(argv, index, arg), "--runs");
      index++;
    } else if (arg === "--sample-frames") {
      options.sampleFrames = positiveInteger(
        optionValue(argv, index, arg),
        "--sample-frames",
      );
      index++;
    } else if (arg === "--pick-samples") {
      options.pickSamples = positiveInteger(
        optionValue(argv, index, arg),
        "--pick-samples",
      );
      index++;
    } else if (arg === "--timeout-ms") {
      options.timeoutMs = positiveInteger(
        optionValue(argv, index, arg),
        "--timeout-ms",
      );
      index++;
    } else if (arg === "--repository-root") {
      options.repositoryRoot = optionValue(argv, index, arg);
      index++;
    } else if (arg === "--output") {
      options.outputDirectory = optionValue(argv, index, arg);
      index++;
    } else {
      throw new TypeError(`unknown argument: ${arg}`);
    }
  }

  if (options.port === 8080) {
    throw new RefusalError(
      "port-8080-forbidden",
      "DM-01 refuses port 8080; start the served build on a non-default port",
      { port: options.port },
    );
  }

  if (options.port > 65535) {
    throw new TypeError("--port must be at most 65535");
  }

  return options;
}

export function decideOriginRefusal({ requestedOrigin, actualUrl }) {
  let expected;
  let actual;

  try {
    expected = new URL(requestedOrigin).origin;
  } catch {
    return refusedDecision("requested-origin-invalid", { requestedOrigin });
  }

  try {
    actual = new URL(actualUrl).origin;
  } catch {
    return refusedDecision("navigation-url-invalid", {
      requestedOrigin: expected,
      actualUrl,
    });
  }

  if (actual !== expected) {
    return refusedDecision("origin-mismatch", {
      requestedOrigin: expected,
      actualOrigin: actual,
      actualUrl,
    });
  }

  return acceptedDecision();
}

export function decidePreflightRefusal(
  preflight,
  requiredArtifacts = REQUIRED_SERVED_ARTIFACTS,
) {
  if (!preflight || preflight.ok !== true) {
    return refusedDecision("served-build-preflight-failed", {
      preflight: preflight ?? null,
    });
  }

  const results = Array.isArray(preflight.artifacts) ? preflight.artifacts : [];
  const byPath = new Map(results.map((result) => [result.path, result]));

  const missingOrUnmatched = requiredArtifacts.filter((artifact) => {
    const result = byPath.get(artifact);
    return !result || result.match !== true;
  });

  if (missingOrUnmatched.length > 0) {
    return refusedDecision("served-build-preflight-incomplete", {
      missingOrUnmatched,
      preflight,
    });
  }

  return acceptedDecision();
}

export function decideLegDescriptorRefusal(leg) {
  if (!leg || typeof leg.id !== "string") {
    return refusedDecision("invalid-leg-descriptor");
  }

  if (leg.pageLoad !== "dedicated-new-page") {
    return refusedDecision("leg-page-load-not-isolated", { leg });
  }

  if (leg.lever === null) {
    return acceptedDecision();
  }

  if (!leg.application) {
    return refusedDecision("leg-application-missing", { leg });
  }

  if (leg.application.phase !== "before-tileset-creation") {
    return refusedDecision("lever-applied-after-tileset-creation", { leg });
  }

  if (leg.application.property !== leg.lever) {
    return refusedDecision("lever-property-mismatch", { leg });
  }

  const known = [...STREAMING_LEVERS, ...EXTRA_LEVERS];
  if (!known.includes(leg.lever)) {
    return refusedDecision("unknown-lever", { leg });
  }

  return acceptedDecision();
}

function valuesMatch(left, right) {
  if (typeof left === "number" && typeof right === "number") {
    return (
      Math.abs(left - right) <=
      Number.EPSILON * Math.max(1, Math.abs(left), Math.abs(right))
    );
  }
  return Object.is(left, right);
}

export function decideCellRefusal({ leg, raw }) {
  const descriptorDecision = decideLegDescriptorRefusal(leg);
  if (descriptorDecision.refuse) {
    return descriptorDecision;
  }

  if (!raw || raw.ok !== true) {
    return refusedDecision(
      raw?.refusalReason ?? "page-measurement-unavailable",
      { raw: raw ?? null },
    );
  }

  if (
    !raw.audit ||
    !Number.isInteger(raw.audit.firstTilesetCreationStartedAt) ||
    !Number.isInteger(raw.audit.firstTilesetAddedAt)
  ) {
    return refusedDecision("tileset-lifecycle-audit-missing", { raw });
  }

  if (!raw.audit.firstTraversal) {
    return refusedDecision("first-traversal-not-observed", {
      audit: raw.audit,
    });
  }

  if (leg.lever !== null) {
    if (
      !Number.isInteger(raw.audit.leverConfiguredAt) ||
      raw.audit.leverConfiguredAt >= raw.audit.firstTilesetCreationStartedAt
    ) {
      return refusedDecision("lever-was-inert-during-streaming", {
        leg,
        audit: raw.audit,
      });
    }

    const configured = raw.audit.sequence.find(
      (event) => event.order === raw.audit.leverConfiguredAt,
    );
    if (!configured || configured.details?.readbackMatches !== true) {
      return refusedDecision("lever-engine-readback-mismatch", {
        leg,
        configured: configured ?? null,
      });
    }
  }

  if (leg.application?.target === "tileset-options") {
    const readbacks = raw.audit.engineReadbacks;
    if (!Array.isArray(readbacks) || readbacks.length === 0) {
      return refusedDecision("tileset-option-readback-missing", { leg });
    }

    for (const readback of readbacks) {
      const addedAt = raw.audit.addedAtByTitle?.[readback.title];
      if (
        !Number.isInteger(addedAt) ||
        readback.order >= addedAt ||
        readback.property !== leg.application.property ||
        !valuesMatch(readback.value, leg.application.value)
      ) {
        return refusedDecision("tileset-option-not-applied-before-add", {
          leg,
          readback,
          addedAt: addedAt ?? null,
        });
      }
    }
  }

  const sseReadbacks =
    raw.audit.firstTraversal.maximumScreenSpaceErrorByTileset;
  if (!Array.isArray(sseReadbacks) || sseReadbacks.length === 0) {
    return refusedDecision("first-traversal-sse-readback-missing", {
      firstTraversal: raw.audit.firstTraversal,
    });
  }

  for (const readback of sseReadbacks) {
    if (
      readback.source !== "engine-readback-at-first-traversal" ||
      !Number.isFinite(readback.value)
    ) {
      return refusedDecision("first-traversal-sse-readback-invalid", {
        readback,
      });
    }
  }

  if (leg.lever === "maximumScreenSpaceError") {
    const mismatch = sseReadbacks.find(
      (readback) => !valuesMatch(readback.value, leg.application.value),
    );
    if (mismatch) {
      return refusedDecision("first-traversal-sse-mismatch", {
        expected: leg.application.value,
        readback: mismatch,
      });
    }
  }

  if (
    !raw.readiness ||
    !Number.isFinite(raw.readiness.timeToRenderReadyMs) ||
    !Number.isInteger(raw.readiness.framesToRenderReady) ||
    !Number.isFinite(raw.readiness.sceneFrameNumber)
  ) {
    return refusedDecision("render-ready-metrics-invalid", {
      readiness: raw.readiness ?? null,
    });
  }

  if (
    !raw.debugSnapshot ||
    typeof raw.debugSnapshot !== "object" ||
    raw.debugSnapshot.error
  ) {
    return refusedDecision("debug-snapshot-unavailable", {
      debugSnapshot: raw.debugSnapshot ?? null,
    });
  }

  return acceptedDecision();
}

function finiteSamples(values) {
  return Array.isArray(values)
    ? values.filter((value) => Number.isFinite(value))
    : [];
}

export function percentile(values, fraction) {
  if (!Number.isFinite(fraction) || fraction < 0 || fraction > 1) {
    throw new RangeError("percentile fraction must be between zero and one");
  }

  const sorted = finiteSamples(values).sort((left, right) => left - right);
  if (sorted.length === 0) {
    return null;
  }

  if (fraction === 0) {
    return sorted[0];
  }

  const rank = Math.ceil(fraction * sorted.length);
  return sorted[Math.max(0, rank - 1)];
}

function rounded(value, digits = 3) {
  return Number.isFinite(value) ? Number(value.toFixed(digits)) : null;
}

export function p50P95(values) {
  const samples = finiteSamples(values);
  return {
    samples: samples.length,
    p50: rounded(percentile(samples, 0.5)),
    p95: rounded(percentile(samples, 0.95)),
  };
}

function numericCount(value) {
  if (Number.isFinite(value)) {
    return Number(value);
  }
  if (Array.isArray(value)) {
    return value.length;
  }
  if (value && typeof value === "object") {
    for (const key of ["count", "commands", "commandCount", "length"]) {
      if (Number.isFinite(value[key])) {
        return Number(value[key]);
      }
    }
  }
  return null;
}

function normalizeSnapshotCounts(candidate) {
  if (!candidate || typeof candidate !== "object") {
    return null;
  }

  const normalized = {};

  if (Array.isArray(candidate)) {
    for (const row of candidate) {
      if (!row || typeof row !== "object") {
        continue;
      }
      const name = row.passName ?? row.pass ?? row.name;
      const count = numericCount(row.count ?? row.commands ?? row);
      if (name !== undefined && count !== null) {
        normalized[String(name)] = count;
      }
    }
  } else {
    for (const [name, value] of Object.entries(candidate)) {
      if (name.toLowerCase() === "total") {
        continue;
      }
      const count = numericCount(value);
      if (count !== null) {
        normalized[String(name)] = count;
      }
    }
  }

  return Object.keys(normalized).length > 0 ? normalized : null;
}

function findSnapshotPerPass(snapshot) {
  if (!snapshot || typeof snapshot !== "object") {
    return null;
  }

  const directCandidates = [
    snapshot.commandCountsByPass,
    snapshot.commandsByPass,
    snapshot.commandsPerPass,
    snapshot.perPassCommands,
    snapshot.passCommandCounts,
    snapshot.commands?.perPass,
    snapshot.commandList?.perPass,
    snapshot.scene?.commandCountsByPass,
    snapshot.scene?.commandsByPass,
    snapshot.scene?.commandsPerPass,
    snapshot.scene?.perPassCommands,
  ];

  for (const candidate of directCandidates) {
    const normalized = normalizeSnapshotCounts(candidate);
    if (normalized) {
      return normalized;
    }
  }

  const matchingKey =
    /^(?:commandCountsByPass|commandsByPass|commandsPerPass|perPassCommands|passCommandCounts)$/i;
  const queue = [{ value: snapshot, depth: 0 }];
  const seen = new Set();

  while (queue.length > 0) {
    const current = queue.shift();
    if (
      !current.value ||
      typeof current.value !== "object" ||
      seen.has(current.value)
    ) {
      continue;
    }
    seen.add(current.value);

    for (const [key, value] of Object.entries(current.value)) {
      if (matchingKey.test(key)) {
        const normalized = normalizeSnapshotCounts(value);
        if (normalized) {
          return normalized;
        }
      }

      if (current.depth < 4 && value && typeof value === "object") {
        queue.push({ value, depth: current.depth + 1 });
      }
    }
  }

  return null;
}

function passLabel(command, passNames) {
  const raw = command?.passName ?? command?.pass ?? command?._pass ?? "UNKNOWN";
  return passNames?.[String(raw)] ?? String(raw);
}

export function aggregatePerPass(snapshot, frameState) {
  const snapshotCounts = findSnapshotPerPass(snapshot);
  if (snapshotCounts) {
    return {
      source: "debug-snapshot",
      counts: Object.fromEntries(
        Object.entries(snapshotCounts).sort(([left], [right]) =>
          left.localeCompare(right),
        ),
      ),
    };
  }

  const commandList = Array.isArray(frameState)
    ? frameState
    : Array.isArray(frameState?.commandList)
      ? frameState.commandList
      : [];
  const passNames = frameState?.passNames ?? {};
  const counts = {};

  for (const command of commandList) {
    const passName = passLabel(command, passNames);
    counts[passName] = (counts[passName] ?? 0) + 1;
  }

  return {
    source: "frameState.commandList",
    counts: Object.fromEntries(
      Object.entries(counts).sort(([left], [right]) =>
        left.localeCompare(right),
      ),
    ),
  };
}

function findPipelineCandidate(snapshot) {
  if (!snapshot || typeof snapshot !== "object") {
    return null;
  }

  const directCandidates = [
    snapshot.pipelineCache,
    snapshot.pipelineCacheStats,
    snapshot.context?.pipelineCache,
    snapshot.context?.pipelineCacheStats,
    snapshot.context?.webgpuPipelineCache,
    snapshot.scene?.pipelineCache,
    snapshot.scene?.pipelineCacheStats,
    snapshot.webgpu?.pipelineCache,
  ];

  for (const candidate of directCandidates) {
    const value = candidate?.stats ?? candidate;
    if (
      value &&
      typeof value === "object" &&
      ["hits", "misses", "created", "pending"].some((key) =>
        Number.isFinite(value[key]),
      )
    ) {
      return value;
    }
  }

  const queue = [{ value: snapshot, depth: 0 }];
  const seen = new Set();

  while (queue.length > 0) {
    const current = queue.shift();
    if (
      !current.value ||
      typeof current.value !== "object" ||
      seen.has(current.value)
    ) {
      continue;
    }
    seen.add(current.value);

    for (const [key, child] of Object.entries(current.value)) {
      if (/pipeline.?cache/i.test(key)) {
        const candidate = child?.stats ?? child;
        if (
          candidate &&
          typeof candidate === "object" &&
          ["hits", "misses", "created", "pending"].some((metric) =>
            Number.isFinite(candidate[metric]),
          )
        ) {
          return candidate;
        }
      }

      if (current.depth < 4 && child && typeof child === "object") {
        queue.push({ value: child, depth: current.depth + 1 });
      }
    }
  }

  return null;
}

export function extractPipelineCacheMetrics(snapshot) {
  const candidate = findPipelineCandidate(snapshot);
  return {
    hits: Number.isFinite(candidate?.hits) ? candidate.hits : null,
    misses: Number.isFinite(candidate?.misses) ? candidate.misses : null,
    created: Number.isFinite(candidate?.created) ? candidate.created : null,
    pending: Number.isFinite(candidate?.pending) ? candidate.pending : null,
  };
}

function throwForDecision(decision, message) {
  if (decision.refuse) {
    throw new RefusalError(decision.reason, message, decision.details ?? null);
  }
}

function cellName(entry) {
  return `run${entry.run}-${entry.leg.id}-${entry.backend}`;
}

function normalizeJson(value) {
  return `${JSON.stringify(value, null, 2).replace(/\r\n/g, "\n")}\n`;
}

function markdownEscape(value) {
  return String(value).replaceAll("|", "\\|").replaceAll("\n", " ");
}

export function buildMarkdownSummary(report) {
  const lines = [
    "# AEC performance probe",
    "",
    `Generated: ${report.generatedAt}`,
    "",
    `Origin: \`${report.origin}\``,
    "",
    `Runs: ${report.options.runs}`,
    "",
    `Backend order: \`${report.options.reverse ? "webgpu, webgl" : "webgl, webgpu"}\``,
    "",
    `Validated pick coordinate: \`(${report.validatedPick.x}, ${report.validatedPick.y})\``,
    "",
    "| Run | Leg | Backend | renderReady ms | Frames | Scene.frameNumber | Frame p50 ms | Frame p95 ms | Commands per pass | Cache H/M/C/P | Heap MB | Pick hits | Pick p50/p95 ms |",
    "| ---: | --- | --- | ---: | ---: | ---: | ---: | ---: | --- | --- | ---: | ---: | --- |",
  ];

  for (const cell of report.cells) {
    const commandText = JSON.stringify(cell.perPassCommands.counts);
    const cache = cell.pipelineCache;
    const pickHits = cell.pickTable.filter((row) => row.hit).length;

    lines.push(
      [
        cell.run,
        markdownEscape(cell.leg.label),
        cell.backend,
        cell.timeToRenderReadyMs,
        cell.framesToRenderReady,
        cell.sceneFrameNumber,
        cell.frameTime.p50,
        cell.frameTime.p95,
        markdownEscape(commandText),
        `${cache.hits}/${cache.misses}/${cache.created}/${cache.pending}`,
        cell.usedJSHeapMB,
        `${pickHits}/${cell.pickTable.length}`,
        `${cell.pickTime.p50}/${cell.pickTime.p95}`,
      ]
        .join(" | ")
        .replace(/^/, "| ")
        .replace(/$/, " |"),
    );
  }

  lines.push(
    "",
    "Each backend/leg/run cell used a fresh page. Lever configuration was audited before the first tileset creation, and maximumScreenSpaceError was read back from each tileset at the first observed traversal.",
    "",
  );

  return lines.join("\n");
}

async function installRewriteOnPage(page, requestedOrigin) {
  const rewriteModule = await import("./lib/sandcastle2-origin-rewrite.mjs");
  if (typeof rewriteModule.installOriginRewrite !== "function") {
    throw new TypeError(
      "sandcastle2-origin-rewrite.mjs does not export installOriginRewrite",
    );
  }

  await rewriteModule.installOriginRewrite(page, {
    requestedOrigin,
    expectedOrigin: requestedOrigin,
    outerOrigin: requestedOrigin,
    innerOrigin: requestedOrigin,
    bucketOrigin: requestedOrigin,
    requestedOuterOrigin: requestedOrigin,
    requestedBucketOrigin: requestedOrigin,
  });
}

export function buildCellReport({
  entry,
  raw,
  perPassSamples,
  validatedPick,
  pickValidation,
  pickTable,
  imagePath,
  consoleLines = [],
}) {
  const frameTime = p50P95(raw.frameTimes);
  const pickTime = p50P95(pickTable.map((row) => row.wallMs));
  const perPassCommands = aggregatePerPass(
    perPassSamples.snapshot,
    perPassSamples.frameState,
  );

  return {
    run: entry.run,
    backend: entry.backend,
    rendererType: raw.rendererType,
    leg: entry.leg,
    pageLoad: entry.leg.pageLoad,
    imagePath,
    timeToRenderReadyMs: rounded(raw.readiness.timeToRenderReadyMs),
    framesToRenderReady: raw.readiness.framesToRenderReady,
    sceneFrameNumber: raw.readiness.sceneFrameNumber,
    firstTraversalSceneFrameNumber: raw.audit.firstTraversal.sceneFrameNumber,
    maximumScreenSpaceErrorAtFirstTraversal:
      raw.audit.firstTraversal.maximumScreenSpaceErrorByTileset,
    frameTime,
    perPassCommands,
    pipelineCache: extractPipelineCacheMetrics(raw.debugSnapshot),
    usedJSHeapMB: rounded(raw.memory.usedJSHeapMB),
    validatedPick: {
      x: validatedPick.x,
      y: validatedPick.y,
      validation: pickValidation,
    },
    pickTime,
    pickTable: pickTable.map((row) => ({
      ...row,
      wallMs: rounded(row.wallMs),
    })),
    applicationAudit: raw.audit,
    pageErrors: raw.errors,
    consoleTail: consoleLines.slice(-40),
  };
}

async function runCell({
  browser,
  entry,
  origin,
  outputDirectory,
  timeoutMs,
  sampleFrames,
  pickSamples,
  validatedPick,
}) {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 720 },
    deviceScaleFactor: 1,
  });
  const page = await context.newPage();
  const consoleLines = [];

  page.on("console", (message) => {
    consoleLines.push(`${message.type()}: ${message.text()}`.slice(0, 500));
  });
  page.on("pageerror", (error) => {
    consoleLines.push(`pageerror: ${error.message}`.slice(0, 500));
  });

  try {
    await installRewriteOnPage(page, origin);

    await page.route(`**${HARNESS_PATH}`, (route) =>
      route.fulfill({
        status: 200,
        contentType: "text/html; charset=utf-8",
        body: HARNESS_HTML,
      }),
    );

    await page.goto(`${origin}${HARNESS_PATH}`, {
      waitUntil: "domcontentloaded",
      timeout: 60000,
    });

    throwForDecision(
      decideOriginRefusal({
        requestedOrigin: origin,
        actualUrl: page.url(),
      }),
      "navigation left the requested served-build origin",
    );

    await page.waitForFunction(() => window.__aecHarnessReady === true, null, {
      timeout: 60000,
    });

    const raw = await page.evaluate((input) => window.__aecBuild(input), {
      renderer: entry.backend,
      leg: entry.leg,
      timeoutMs,
      sampleFrames,
    });

    throwForDecision(
      decideCellRefusal({ leg: entry.leg, raw }),
      `${cellName(entry)} could not produce a validated streaming measurement`,
    );

    let discoveredPick = null;
    if (validatedPick === null) {
      const search = await page.evaluate(() => window.__aecFindPick());
      if (!search.found) {
        throw new RefusalError(
          "pick-position-not-found",
          `${cellName(entry)} found no AEC feature to establish the shared pick coordinate`,
          { search },
        );
      }
      discoveredPick = {
        x: search.x,
        y: search.y,
        foundBy: {
          run: entry.run,
          leg: entry.leg.id,
          backend: entry.backend,
        },
      };
      validatedPick = discoveredPick;
    }

    const pickValidation = await page.evaluate(
      (position) => window.__aecValidatePick(position),
      validatedPick,
    );
    if (pickValidation.hit !== true) {
      throw new RefusalError(
        "validated-pick-missed",
        `${cellName(entry)} missed the shared validated pick coordinate`,
        {
          position: validatedPick,
          validation: pickValidation,
        },
      );
    }

    const pickTable = await page.evaluate(
      ({ position, samples }) => window.__aecPickTable(position, samples),
      {
        position: validatedPick,
        samples: pickSamples,
      },
    );

    throwForDecision(
      decideOriginRefusal({
        requestedOrigin: origin,
        actualUrl: page.url(),
      }),
      "page origin changed during the measurement",
    );

    const imagePath = path.join(
      outputDirectory,
      "images",
      `${cellName(entry)}.png`,
    );
    mkdirSync(path.dirname(imagePath), { recursive: true });
    await page.locator("canvas").first().screenshot({ path: imagePath });

    return {
      discoveredPick,
      cell: buildCellReport({
        entry,
        raw,
        perPassSamples: {
          snapshot: raw.debugSnapshot,
          frameState: raw.frameState,
        },
        validatedPick,
        pickValidation,
        pickTable,
        imagePath,
        consoleLines,
      }),
    };
  } finally {
    await context.close();
  }
}

async function writeReports(outputDirectory, report) {
  mkdirSync(outputDirectory, { recursive: true });

  writeFileSync(
    path.join(outputDirectory, "aec-perf-report.json"),
    normalizeJson(report),
  );

  for (const leg of report.legs) {
    const legReport = {
      generatedAt: report.generatedAt,
      origin: report.origin,
      runs: report.options.runs,
      reverse: report.options.reverse,
      validatedPick: report.validatedPick,
      preflight: report.preflight,
      leg,
      cells: report.cells.filter((cell) => cell.leg.id === leg.id),
    };

    writeFileSync(
      path.join(outputDirectory, `aec-perf-${leg.id}.json`),
      normalizeJson(legReport),
    );
  }

  writeFileSync(
    path.join(outputDirectory, "aec-perf-summary.md"),
    buildMarkdownSummary(report),
  );
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
  const repositoryRoot = path.resolve(
    options.repositoryRoot ?? path.join(moduleDirectory, "..", ".."),
  );
  const outputDirectory = path.resolve(
    options.outputDirectory ?? path.join(moduleDirectory, "output", "aec-perf"),
  );
  const origin = `http://localhost:${options.port}`;

  const { preflightServedBuildArtifacts } =
    await import("./lib/served-build-preflight.mjs");

  const preflight = await preflightServedBuildArtifacts({
    origin,
    repositoryRoot,
    artifacts: [...REQUIRED_SERVED_ARTIFACTS],
  });

  throwForDecision(
    decidePreflightRefusal(preflight),
    "served-build preflight did not match both required on-disk bundles",
  );

  const { chromium } = await import("playwright");
  const browser = await chromium.launch({
    channel: "msedge",
    headless: !options.headed,
    args: [
      "--enable-unsafe-webgpu",
      "--enable-features=Vulkan",
      "--use-vulkan",
      "--enable-precise-memory-info",
    ],
  });

  const legs = buildLegMatrix();
  for (const leg of legs) {
    throwForDecision(
      decideLegDescriptorRefusal(leg),
      `invalid leg descriptor: ${leg.id}`,
    );
  }

  const order = buildRunOrder({
    runs: options.runs,
    reverse: options.reverse,
    legs,
  });
  const cells = [];
  let validatedPick = null;

  try {
    for (const entry of order) {
      const result = await runCell({
        browser,
        entry,
        origin,
        outputDirectory,
        timeoutMs: options.timeoutMs,
        sampleFrames: options.sampleFrames,
        pickSamples: options.pickSamples,
        validatedPick,
      });

      if (result.discoveredPick) {
        validatedPick = result.discoveredPick;
      }

      cells.push(result.cell);
      process.stdout.write(`${normalizeJson(result.cell)}`);
    }
  } finally {
    await browser.close();
  }

  if (!validatedPick) {
    throw new RefusalError(
      "validated-pick-missing",
      "the probe completed without establishing a shared pick coordinate",
    );
  }

  const report = {
    generatedAt: new Date().toISOString(),
    origin,
    repositoryRoot,
    outputDirectory,
    options: {
      port: options.port,
      runs: options.runs,
      reverse: options.reverse,
      headed: options.headed,
      sampleFrames: options.sampleFrames,
      pickSamples: options.pickSamples,
      timeoutMs: options.timeoutMs,
    },
    preflight,
    legs,
    cellOrder: order.map(cellName),
    validatedPick,
    cells,
  };

  await writeReports(outputDirectory, report);
  process.stdout.write(
    `report: ${path.join(outputDirectory, "aec-perf-report.json")}\n`,
  );
  process.stdout.write(
    `summary: ${path.join(outputDirectory, "aec-perf-summary.md")}\n`,
  );

  return EXIT_CODES.OK;
}

function isMainModule() {
  if (!process.argv[1]) {
    return false;
  }
  return pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
}

if (isMainModule()) {
  main()
    .then((exitCode) => {
      process.exitCode = exitCode;
    })
    .catch((error) => {
      const refusal =
        error instanceof RefusalError ||
        error?.name === "OriginRewriteRefusal" ||
        error?.name === "AECProbeRefusal";
      const exitCode = refusal ? EXIT_CODES.REFUSAL : EXIT_CODES.ERROR;

      process.stderr.write(
        normalizeJson({
          ok: false,
          exitCode,
          reason: refusal
            ? (error.reason ?? "origin-rewrite-refusal")
            : "probe-error",
          name: error?.name ?? "Error",
          message: String(error?.message ?? error),
          details: error?.details ?? null,
        }),
      );
      process.exitCode = exitCode;
    });
}
