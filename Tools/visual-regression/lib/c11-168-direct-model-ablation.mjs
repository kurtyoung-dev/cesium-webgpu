/**
 * C11-168 resident direct-model causal discriminator.
 * @purpose Renderer-neutral C11-168 causal discriminator: rejects incomparable run quartets and computes the predeclared difference-in-differences fail-closed.
 * @status ACTIVE
 *
 * This module is deliberately renderer-neutral. The browser half owns the
 * direct-model subject and its post-timing selector control; the Node half
 * rejects incomparable run quartets and computes the predeclared
 * difference-in-differences without turning a null hypothesis into a product
 * failure.
 */

const C11_168_WIDGET_CSS_PATHS = Object.freeze([
  "Source/Widgets/Animation/Animation.css",
  "Source/Widgets/Animation/lighter.css",
  "Source/Widgets/BaseLayerPicker/BaseLayerPicker.css",
  "Source/Widgets/BaseLayerPicker/lighter.css",
  "Source/Widgets/Cesium3DTilesInspector/Cesium3DTilesInspector.css",
  "Source/Widgets/CesiumInspector/CesiumInspector.css",
  "Source/Widgets/CesiumWidget/CesiumWidget.css",
  "Source/Widgets/CesiumWidget/lighter.css",
  "Source/Widgets/FullscreenButton/FullscreenButton.css",
  "Source/Widgets/Geocoder/Geocoder.css",
  "Source/Widgets/Geocoder/lighter.css",
  "Source/Widgets/I3SBuildingSceneLayerExplorer/I3SBuildingSceneLayerExplorer.css",
  "Source/Widgets/InfoBox/InfoBox.css",
  "Source/Widgets/InfoBox/InfoBoxDescription.css",
  "Source/Widgets/lighter.css",
  "Source/Widgets/lighterShared.css",
  "Source/Widgets/NavigationHelpButton/lighter.css",
  "Source/Widgets/NavigationHelpButton/NavigationHelpButton.css",
  "Source/Widgets/PerformanceWatchdog/PerformanceWatchdog.css",
  "Source/Widgets/ProjectionPicker/ProjectionPicker.css",
  "Source/Widgets/SceneModePicker/SceneModePicker.css",
  "Source/Widgets/SelectionIndicator/SelectionIndicator.css",
  "Source/Widgets/shared.css",
  "Source/Widgets/Timeline/lighter.css",
  "Source/Widgets/Timeline/Timeline.css",
  "Source/Widgets/Viewer/Viewer.css",
  "Source/Widgets/VoxelInspector/VoxelInspector.css",
  "Source/Widgets/VRButton/VRButton.css",
  "Source/Widgets/widgets.css",
]);

const C11_168_RUNTIME_ASSET_PATHS = Object.freeze([
  "Build/CesiumUnminified/Assets/Textures/SkyBox/tycho2t5_80_diffuse_px.jpg",
  "Build/CesiumUnminified/Assets/Textures/SkyBox/tycho2t5_80_diffuse_mx.jpg",
  "Build/CesiumUnminified/Assets/Textures/SkyBox/tycho2t5_80_diffuse_py.jpg",
  "Build/CesiumUnminified/Assets/Textures/SkyBox/tycho2t5_80_diffuse_my.jpg",
  "Build/CesiumUnminified/Assets/Textures/SkyBox/tycho2t5_80_diffuse_pz.jpg",
  "Build/CesiumUnminified/Assets/Textures/SkyBox/tycho2t5_80_diffuse_mz.jpg",
  "Build/CesiumUnminified/Assets/Textures/Moon/lroc_color_poles_2k.jpg",
  "Build/CesiumUnminified/Assets/Textures/Moon/ldem_normal_1k.png",
  "Build/CesiumUnminified/Assets/Textures/waterNormalsSmall.jpg",
  "Build/CesiumUnminified/Assets/IAU2006_XYS/IAU2006_XYS_18.json",
]);

const C11_168_AJV_IMPLEMENTATION_PATHS = Object.freeze([
  "node_modules/ajv/lib/ajv.js",
  "node_modules/ajv/lib/compile/index.js",
  "node_modules/ajv/lib/compile/resolve.js",
  "node_modules/ajv/lib/compile/util.js",
  "node_modules/ajv/lib/compile/ucs2length.js",
  "node_modules/ajv/lib/compile/schema_obj.js",
  "node_modules/ajv/lib/compile/error_classes.js",
  "node_modules/ajv/lib/compile/formats.js",
  "node_modules/ajv/lib/compile/rules.js",
  "node_modules/ajv/lib/compile/async.js",
  "node_modules/ajv/lib/cache.js",
  "node_modules/ajv/lib/data.js",
  "node_modules/ajv/lib/keyword.js",
  "node_modules/ajv/lib/definition_schema.js",
  "node_modules/ajv/lib/dotjs/index.js",
  "node_modules/ajv/lib/dotjs/validate.js",
  "node_modules/ajv/lib/dotjs/ref.js",
  "node_modules/ajv/lib/dotjs/allOf.js",
  "node_modules/ajv/lib/dotjs/anyOf.js",
  "node_modules/ajv/lib/dotjs/comment.js",
  "node_modules/ajv/lib/dotjs/const.js",
  "node_modules/ajv/lib/dotjs/contains.js",
  "node_modules/ajv/lib/dotjs/dependencies.js",
  "node_modules/ajv/lib/dotjs/enum.js",
  "node_modules/ajv/lib/dotjs/format.js",
  "node_modules/ajv/lib/dotjs/if.js",
  "node_modules/ajv/lib/dotjs/items.js",
  "node_modules/ajv/lib/dotjs/_limit.js",
  "node_modules/ajv/lib/dotjs/_limitItems.js",
  "node_modules/ajv/lib/dotjs/_limitLength.js",
  "node_modules/ajv/lib/dotjs/_limitProperties.js",
  "node_modules/ajv/lib/dotjs/multipleOf.js",
  "node_modules/ajv/lib/dotjs/not.js",
  "node_modules/ajv/lib/dotjs/oneOf.js",
  "node_modules/ajv/lib/dotjs/pattern.js",
  "node_modules/ajv/lib/dotjs/properties.js",
  "node_modules/ajv/lib/dotjs/propertyNames.js",
  "node_modules/ajv/lib/dotjs/required.js",
  "node_modules/ajv/lib/dotjs/uniqueItems.js",
  "node_modules/ajv/lib/dotjs/custom.js",
  "node_modules/ajv/lib/refs/json-schema-draft-07.json",
  "node_modules/fast-deep-equal/package.json",
  "node_modules/fast-deep-equal/index.js",
  "node_modules/fast-json-stable-stringify/package.json",
  "node_modules/fast-json-stable-stringify/index.js",
  "node_modules/json-schema-traverse/package.json",
  "node_modules/json-schema-traverse/index.js",
  "node_modules/uri-js/package.json",
  "node_modules/uri-js/dist/es5/uri.all.js",
]);

const C11_168_PLAYWRIGHT_IMPLEMENTATION_PATHS = Object.freeze([
  "node_modules/playwright/index.mjs",
  "node_modules/playwright-core/index.mjs",
  "node_modules/playwright-core/index.js",
  "node_modules/playwright-core/lib/bootstrap.js",
  "node_modules/playwright-core/lib/coreBundle.js",
  "node_modules/playwright-core/lib/utilsBundle.js",
  "node_modules/playwright-core/browsers.json",
]);

export const C11_168_REPORT_TOOLING_PATHS = Object.freeze({
  runner: "Tools/visual-regression/run-performance-campaign.mjs",
  manifest:
    "Tools/visual-regression/performance-workloads-representative-warm.json",
  representativeContentHelper:
    "Tools/visual-regression/lib/representative-performance-content.mjs",
  cameraTrack: "Tools/visual-regression/lib/globe-camera-track.mjs",
  directModelAblationHelper:
    "Tools/visual-regression/lib/c11-168-direct-model-ablation.mjs",
});

export const C11_168_LOCAL_EXECUTION_PATHS = Object.freeze([
  "Tools/visual-regression/probe-c11-168-direct-model-ablation.mjs",
  "Tools/visual-regression/run-performance-campaign.mjs",
  "Tools/visual-regression/lib/c11-168-direct-model-ablation.mjs",
  "Tools/visual-regression/performance-workloads-representative-warm.json",
  "Tools/visual-regression/performance-workloads.schema.json",
  "Tools/visual-regression/lib/globe-camera-track.mjs",
  "Tools/visual-regression/lib/performance-campaign-utils.mjs",
  "Tools/visual-regression/lib/settle-attribution.mjs",
  "Tools/visual-regression/lib/performance-workload-manifest.mjs",
  "Tools/visual-regression/lib/representative-performance-content.mjs",
  "Tools/visual-regression/lib/representative-tileset-request-ledger.mjs",
  "Tools/visual-regression/lib/c11-205-evidence.mjs",
  "Tools/visual-regression/lib/c11-205-owner-attribution.mjs",
  "Tools/visual-regression/lib/performance-viewer-url.mjs",
  "Tools/visual-regression/lib/performance-workload-selection.mjs",
  "Apps/CesiumViewer/index.html",
  "Apps/CesiumViewer/CesiumViewer.js",
  "Apps/CesiumViewer/CesiumViewerStartupOptions.js",
  "Apps/CesiumViewer/CesiumViewerDevUi.js",
  "Apps/CesiumViewer/CesiumViewerStartMode.js",
  "Apps/CesiumViewer/CesiumViewerLoadingIndicator.js",
  "Apps/CesiumViewer/CesiumViewer.css",
  ...C11_168_WIDGET_CSS_PATHS,
  "Source/Widgets/Images/info-loading.gif",
  "Source/Widgets/Images/TimelineIcons.png",
  "Apps/CesiumViewer/Images/ajax-loader.gif",
  "Apps/CesiumViewer/favicon.ico",
  "Build/CesiumUnminified/Cesium.js",
  "Build/CesiumUnminified/index.js",
  ...C11_168_RUNTIME_ASSET_PATHS,
  "Apps/SampleData/models/BoxInstanced/BoxInstanced.gltf",
  "Apps/SampleData/models/BoxInstanced/geometry.bin",
  "Apps/SampleData/models/BoxInstanced/instances.bin",
  "Apps/SampleData/models/BoxInstanced/metadata.bin",
  "Apps/SampleData/Cesium3DTiles/Tilesets/Tileset/tileset.json",
  "Apps/SampleData/Cesium3DTiles/Tilesets/Tileset/ll.b3dm",
  "Apps/SampleData/Cesium3DTiles/Tilesets/Tileset/lr.b3dm",
  "Apps/SampleData/Cesium3DTiles/Tilesets/Tileset/parent.b3dm",
  "Apps/SampleData/Cesium3DTiles/Tilesets/Tileset/ul.b3dm",
  "Apps/SampleData/Cesium3DTiles/Tilesets/Tileset/ur.b3dm",
  "package.json",
  "package-lock.json",
  "node_modules/ajv/package.json",
  ...C11_168_AJV_IMPLEMENTATION_PATHS,
  "node_modules/playwright/package.json",
  "node_modules/playwright-core/package.json",
  ...C11_168_PLAYWRIGHT_IMPLEMENTATION_PATHS,
]);

export const C11_168_SERVED_EXECUTION_PATHS = Object.freeze([
  "Apps/CesiumViewer/index.html",
  "Apps/CesiumViewer/CesiumViewer.js",
  "Apps/CesiumViewer/CesiumViewerStartupOptions.js",
  "Apps/CesiumViewer/CesiumViewerDevUi.js",
  "Apps/CesiumViewer/CesiumViewerStartMode.js",
  "Apps/CesiumViewer/CesiumViewerLoadingIndicator.js",
  "Apps/CesiumViewer/CesiumViewer.css",
  ...C11_168_WIDGET_CSS_PATHS,
  "Source/Widgets/Images/info-loading.gif",
  "Source/Widgets/Images/TimelineIcons.png",
  "Apps/CesiumViewer/Images/ajax-loader.gif",
  "Apps/CesiumViewer/favicon.ico",
  "Build/CesiumUnminified/index.js",
  ...C11_168_RUNTIME_ASSET_PATHS,
  "Tools/visual-regression/lib/c11-168-direct-model-ablation.mjs",
  "Tools/visual-regression/lib/representative-performance-content.mjs",
  "Tools/visual-regression/lib/performance-campaign-utils.mjs",
  "Tools/visual-regression/lib/representative-tileset-request-ledger.mjs",
  "Apps/SampleData/models/BoxInstanced/BoxInstanced.gltf",
  "Apps/SampleData/models/BoxInstanced/geometry.bin",
  "Apps/SampleData/models/BoxInstanced/instances.bin",
  "Apps/SampleData/models/BoxInstanced/metadata.bin",
  "Apps/SampleData/Cesium3DTiles/Tilesets/Tileset/tileset.json",
  "Apps/SampleData/Cesium3DTiles/Tilesets/Tileset/ll.b3dm",
  "Apps/SampleData/Cesium3DTiles/Tilesets/Tileset/lr.b3dm",
  "Apps/SampleData/Cesium3DTiles/Tilesets/Tileset/parent.b3dm",
  "Apps/SampleData/Cesium3DTiles/Tilesets/Tileset/ul.b3dm",
  "Apps/SampleData/Cesium3DTiles/Tilesets/Tileset/ur.b3dm",
]);

export const C11_168_DIRECT_MODEL_ABLATION_CONFIG = Object.freeze({
  schemaVersion: 1,
  manifestFile:
    "Tools/visual-regression/performance-workloads-representative-warm.json",
  manifestId: "fork-representative-resident-attribution-v1",
  manifestSha256:
    "2E580A9E579FFF95093E208086480490FCA9D0C2EA0A1C898848FD68BFBCDBBB",
  workloadId: "moving-camera-representative-resident-terrain-assets-3d",
  contentProfile: "local-procedural-terrain-assets",
  content: "terrain-models-tiles",
  trackId: "orbit-to-ground-global-v1",
  measurementTerrainMode: "resident",
  expectedDirectModels: 48,
  expectedTilesets: 4,
  measuredFrames: 600,
  repetitionsPerOrder: 1,
  orderPairCount: 2,
  legsPerOrderPair: 4,
  childProcessTimeoutMs: 900_000,
  childTerminationGraceMs: 10_000,
  childHardTerminationDeadlineMs: 925_000,
  rawArtifactRoot:
    "Tools/visual-regression/output/performance/c11-168-direct-model-ablation-runs",
  quartetSchedules: Object.freeze([
    Object.freeze([
      Object.freeze({ renderer: "webgl", condition: "shown" }),
      Object.freeze({ renderer: "webgpu", condition: "shown" }),
      Object.freeze({ renderer: "webgpu", condition: "hidden" }),
      Object.freeze({ renderer: "webgl", condition: "hidden" }),
    ]),
    Object.freeze([
      Object.freeze({ renderer: "webgl", condition: "hidden" }),
      Object.freeze({ renderer: "webgpu", condition: "hidden" }),
      Object.freeze({ renderer: "webgpu", condition: "shown" }),
      Object.freeze({ renderer: "webgl", condition: "shown" }),
    ]),
  ]),
  conditions: Object.freeze(["shown", "hidden"]),
  renderers: Object.freeze(["webgl", "webgpu"]),
  absoluteSelectorFloorMs: 0.75,
  noiseMultiple: 3,
});

const isObject = (value) => value !== null && typeof value === "object";
const isFiniteNumber = (value) => Number.isFinite(value);

function stableValue(value) {
  if (Array.isArray(value)) {
    return value.map(stableValue);
  }
  if (isObject(value)) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, stableValue(value[key])]),
    );
  }
  return value;
}

export function stableC11168Json(value) {
  return JSON.stringify(stableValue(value));
}

function childKillFallback(child, force) {
  const signal = force ? "SIGKILL" : "SIGTERM";
  try {
    return { issued: child.kill(signal), error: null, signal };
  } catch (error) {
    return { issued: false, error: String(error?.stack ?? error), signal };
  }
}

/**
 * Terminate one child process tree without trusting a successfully spawned
 * Windows `taskkill` process to have succeeded. A non-zero/signal/error result
 * falls back to ChildProcess.kill; the caller's independent hard deadline is
 * still authoritative if neither mechanism produces a `close` event.
 */
export function terminateC11168ChildTree({
  child,
  force,
  platform,
  spawnTaskkill,
}) {
  if (platform !== "win32" || !Number.isInteger(child?.pid) || child.pid < 1) {
    return Promise.resolve({
      mechanism: "child.kill",
      taskkillExitCode: null,
      taskkillSignal: null,
      taskkillError: null,
      fallback: childKillFallback(child, force),
    });
  }
  return new Promise((resolveTermination) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolveTermination(value);
    };
    const fallback = ({ exitCode = null, signal = null, error = null }) => {
      finish({
        mechanism: "taskkill-fallback",
        taskkillExitCode: exitCode,
        taskkillSignal: signal,
        taskkillError: error,
        fallback: childKillFallback(child, force),
      });
    };
    let killer;
    try {
      killer = spawnTaskkill("taskkill", [
        "/pid",
        String(child.pid),
        "/T",
        ...(force ? ["/F"] : []),
      ]);
    } catch (error) {
      fallback({ error: String(error?.stack ?? error) });
      return;
    }
    try {
      // A stuck taskkill helper must not keep the certification driver alive
      // after the monitor's independent hard deadline has won.
      killer.unref();
    } catch (error) {
      fallback({ error: String(error?.stack ?? error) });
      return;
    }
    killer.once("error", (error) => {
      fallback({ error: String(error?.stack ?? error) });
    });
    killer.once("close", (code, signal) => {
      const normalizedSignal = signal ?? null;
      if (code !== 0 || normalizedSignal !== null) {
        fallback({
          exitCode: Number.isInteger(code) ? code : null,
          signal: normalizedSignal,
        });
        return;
      }
      finish({
        mechanism: "taskkill",
        taskkillExitCode: 0,
        taskkillSignal: null,
        taskkillError: null,
        fallback: null,
      });
    });
  });
}

/**
 * Bound the complete lifetime of a spawned leg. The hard deadline resolves
 * even when the child ignores signals and `taskkill` itself hangs, preventing
 * a certification driver from waiting forever on a missing `close` event.
 */
export function monitorC11168ChildProcess({
  child,
  timeoutMs,
  terminationGraceMs,
  hardDeadlineMs,
  terminate,
  unrefTimers = false,
}) {
  if (
    !child?.once ||
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 1 ||
    !Number.isInteger(terminationGraceMs) ||
    terminationGraceMs < 1 ||
    !Number.isInteger(hardDeadlineMs) ||
    hardDeadlineMs <= timeoutMs + terminationGraceMs ||
    typeof terminate !== "function"
  ) {
    throw new Error("invalid C11-168 child-process monitor configuration");
  }
  return new Promise((resolveChild, rejectChild) => {
    let settled = false;
    let timedOut = false;
    let forcedKill = false;
    let hardDeadlineExceeded = false;
    const terminationErrors = [];
    let forceKillTimer = null;
    const childProcessId = child.pid;
    const finish = (value, error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      clearTimeout(hardDeadlineTimer);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      if (error) rejectChild(error);
      else resolveChild(value);
    };
    const requestTermination = (force, phase) => {
      try {
        Promise.resolve(terminate(child, force)).catch((error) => {
          terminationErrors.push({
            phase,
            error: String(error?.stack ?? error),
          });
        });
      } catch (error) {
        terminationErrors.push({
          phase,
          error: String(error?.stack ?? error),
        });
      }
    };
    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      requestTermination(false, "timeout");
      forceKillTimer = setTimeout(() => {
        forcedKill = true;
        requestTermination(true, "forced");
      }, terminationGraceMs);
      if (unrefTimers) forceKillTimer.unref?.();
    }, timeoutMs);
    const hardDeadlineTimer = setTimeout(() => {
      timedOut = true;
      forcedKill = true;
      hardDeadlineExceeded = true;
      requestTermination(true, "hard-deadline");
      try {
        // The child may never emit `close` after the hard deadline. Detach its
        // process handle before resolving so that it cannot anchor Node's event
        // loop after the caller has persisted the structural timeout result.
        child.unref?.();
      } catch (error) {
        terminationErrors.push({
          phase: "hard-deadline-unref",
          error: String(error?.stack ?? error),
        });
      }
      finish({
        childProcessId,
        exitCode: null,
        signal: null,
        timedOut,
        forcedKill,
        hardDeadlineExceeded,
        timeoutMs,
        hardDeadlineMs,
        terminationErrors,
      });
    }, hardDeadlineMs);
    if (unrefTimers) {
      timeoutTimer.unref?.();
    }
    // The hard deadline deliberately remains referenced: an uncooperative
    // child must end in a persisted structural record, not a silent Node exit.
    child.once("error", (error) => {
      finish(null, error);
    });
    child.once("close", (code, signal) => {
      finish({
        childProcessId,
        exitCode: Number.isInteger(code) ? code : null,
        signal: signal ?? null,
        timedOut,
        forcedKill,
        hardDeadlineExceeded,
        timeoutMs,
        hardDeadlineMs,
        terminationErrors,
      });
    });
  });
}

export function c11168LegId({
  orderPair,
  executionIndex,
  renderer,
  condition,
}) {
  return `pair-${orderPair}-${String(executionIndex + 1).padStart(2, "0")}-${renderer}-${condition}`;
}

function modelResourceUrl(model) {
  return (
    model?._resource?.url ??
    model?._resource?._url ??
    model?._gltfResource?.url ??
    null
  );
}

function modelMatrixValues(model) {
  const matrix = model?.modelMatrix;
  if (!matrix) return null;
  const values = [];
  for (let index = 0; index < 16; index++) {
    const value = matrix[index];
    if (!Number.isFinite(value)) return null;
    values.push(value);
  }
  return values;
}

function describeModel(model, index) {
  return {
    index,
    resourceUrl: modelResourceUrl(model),
    modelMatrix: modelMatrixValues(model),
    scale: Number.isFinite(model?.scale) ? model.scale : null,
  };
}

/**
 * Validate the explicit runner invocation. The ordinary campaign path never
 * calls this function; default-off behavior therefore remains unchanged.
 */
export function evaluateC11168DirectModelInvocation(input) {
  const config = C11_168_DIRECT_MODEL_ABLATION_CONFIG;
  const failures = [];
  if (!config.conditions.includes(input?.condition)) {
    failures.push("condition must be shown or hidden");
  }
  if (!config.renderers.includes(input?.renderer)) {
    failures.push("exactly one canonical renderer is required");
  }
  if (input?.selectedWorkloadIds?.length !== 1) {
    failures.push("exactly one workload must be selected");
  }
  if (input?.selectedWorkloadIds?.[0] !== config.workloadId) {
    failures.push(`workload must be ${config.workloadId}`);
  }
  if (input?.manifestRelativePath !== config.manifestFile) {
    failures.push(`manifest must be ${config.manifestFile}`);
  }
  if (input?.manifestSha256 !== config.manifestSha256) {
    failures.push("manifest bytes do not match the frozen canonical workload");
  }
  if (input?.manifest?.id !== config.manifestId) {
    failures.push(`manifest id must be ${config.manifestId}`);
  }
  if (
    input?.manifest?.protocol?.viewport?.width !== 1280 ||
    input?.manifest?.protocol?.viewport?.height !== 720 ||
    input?.manifest?.protocol?.viewport?.deviceScaleFactor !== 1 ||
    input?.manifest?.protocol?.resolutionScale !== 1 ||
    input?.manifest?.protocol?.fixedClock !== "2026-06-21T08:00:00Z"
  ) {
    failures.push("viewport, resolution scale, or fixed clock drifted");
  }
  if (input?.measuredFrames !== config.measuredFrames) {
    failures.push(`measured frame count must be ${config.measuredFrames}`);
  }
  if (input?.repetitions !== config.repetitionsPerOrder) {
    failures.push(
      `each fresh-process leg must have ${config.repetitionsPerOrder} repetition`,
    );
  }
  if (input?.apiInstrumentation !== false) {
    failures.push("GPU API instrumentation must be disabled");
  }
  if (input?.gpuTimestamps !== false) {
    failures.push("GPU timestamps must be disabled");
  }
  if (input?.reuseBrowser !== false) {
    failures.push("each leg must use a fresh browser process");
  }
  if (input?.cpuOwnerAttribution !== false) {
    failures.push("CPU owner instrumentation must be disabled");
  }
  const workload = input?.workload;
  if (workload?.contentProfile !== config.contentProfile) {
    failures.push(`contentProfile must be ${config.contentProfile}`);
  }
  if (workload?.content !== config.content) {
    failures.push(`content must be ${config.content}`);
  }
  if (workload?.trackId !== config.trackId) {
    failures.push(`trackId must be ${config.trackId}`);
  }
  if (
    workload?.mode !== "3d" ||
    workload?.action !== "camera-track" ||
    workload?.featureProfile !== "default-globe" ||
    workload?.representativeConfig?.routePrimeSamples !== config.measuredFrames
  ) {
    failures.push(
      "3D mode, camera action, feature profile, or route prime drifted",
    );
  }
  if (
    workload?.representativeConfig?.measurementTerrainMode !==
    config.measurementTerrainMode
  ) {
    failures.push("measurement terrain mode must be resident");
  }
  const configuredModels =
    workload?.representativeConfig?.models?.rows *
    workload?.representativeConfig?.models?.columns;
  if (configuredModels !== config.expectedDirectModels) {
    failures.push(
      `configured direct model count must be ${config.expectedDirectModels}`,
    );
  }
  const configuredTilesets =
    workload?.representativeConfig?.tilesets?.rows *
    workload?.representativeConfig?.tilesets?.columns;
  if (configuredTilesets !== config.expectedTilesets) {
    failures.push(
      `configured tileset count must be ${config.expectedTilesets}`,
    );
  }
  return { pass: failures.length === 0, failures };
}

/**
 * Capture and own the exact 48 Model references for one fresh-process leg.
 * Models are loaded and convergence-tested while shown. The requested timed
 * state is applied synchronously only after convergence and before the caller
 * opens any timing snapshot.
 */
export function createC11168DirectModelAblationController({
  scene,
  models,
  condition,
  expectedCount = C11_168_DIRECT_MODEL_ABLATION_CONFIG.expectedDirectModels,
}) {
  if (!scene || !Array.isArray(models)) {
    throw new Error("C11-168 direct-model subject is missing");
  }
  if (!C11_168_DIRECT_MODEL_ABLATION_CONFIG.conditions.includes(condition)) {
    throw new Error(`unsupported C11-168 condition ${condition}`);
  }
  const capturedModels = [...models];
  const capturedSet = new Set(capturedModels);
  const originalShow = capturedModels.map((model) => model?.show);
  const subject = () => ({
    expectedCount,
    configuredCount: capturedModels.length,
    uniqueReferenceCount: capturedSet.size,
    readyCount: capturedModels.filter((model) => model?.ready === true).length,
    primitiveMembershipCount: capturedModels.filter((model) =>
      scene.primitives?.contains?.(model),
    ).length,
    descriptors: capturedModels.map(describeModel),
  });
  const initial = subject();
  const failures = [];
  if (capturedModels.length !== expectedCount) {
    failures.push(`captured ${capturedModels.length}/${expectedCount} models`);
  }
  if (capturedSet.size !== expectedCount) {
    failures.push(
      `captured ${capturedSet.size}/${expectedCount} unique model references`,
    );
  }
  if (initial.readyCount !== expectedCount) {
    failures.push(
      `only ${initial.readyCount}/${expectedCount} models are ready`,
    );
  }
  if (initial.primitiveMembershipCount !== expectedCount) {
    failures.push(
      `only ${initial.primitiveMembershipCount}/${expectedCount} models belong to the scene`,
    );
  }
  if (originalShow.some((show) => show !== true)) {
    failures.push("all models must enter the ablation boundary shown");
  }
  if (
    initial.descriptors.some(
      (descriptor) =>
        typeof descriptor.resourceUrl !== "string" ||
        descriptor.resourceUrl.length === 0 ||
        !Array.isArray(descriptor.modelMatrix) ||
        descriptor.modelMatrix.length !== 16 ||
        !Number.isFinite(descriptor.scale),
    )
  ) {
    failures.push("model source/transform descriptors are incomplete");
  }
  if (failures.length > 0) {
    throw new Error(
      `[structural] invalid C11-168 direct-model subject: ${failures.join("; ")}`,
    );
  }

  const expectedShown = condition === "shown";
  let timedStateApplied = false;
  let restoredForReplay = false;
  const hiddenControl = {
    frameCount: 0,
    commandFrames: 0,
    maximumCommands: 0,
    ownerIndices: new Set(),
    foreignCapturedOwnerCount: 0,
  };
  const capturedIndex = new WeakMap(
    capturedModels.map((model, index) => [model, index]),
  );

  const assertSameSubject = (label) => {
    const reasons = [];
    if (
      models.length !== capturedModels.length ||
      models.some((model, index) => model !== capturedModels[index])
    ) {
      reasons.push("the representative model array changed identity or order");
    }
    const current = subject();
    if (
      current.configuredCount !== expectedCount ||
      current.uniqueReferenceCount !== expectedCount ||
      current.readyCount !== expectedCount ||
      current.primitiveMembershipCount !== expectedCount
    ) {
      reasons.push("model count, uniqueness, readiness, or membership changed");
    }
    if (
      stableC11168Json(current.descriptors) !==
      stableC11168Json(initial.descriptors)
    ) {
      reasons.push("model source, transform, or scale changed");
    }
    if (reasons.length > 0) {
      throw new Error(
        `[structural] C11-168 ${label} subject drift: ${reasons.join("; ")}`,
      );
    }
    return current;
  };

  const setShown = (shown) => {
    for (const model of capturedModels) model.show = shown;
  };

  return {
    applyTimedCondition() {
      assertSameSubject("pre-measurement");
      setShown(expectedShown);
      const appliedCount = capturedModels.filter(
        (model) => model.show === expectedShown,
      ).length;
      if (appliedCount !== expectedCount) {
        throw new Error(
          `[structural] C11-168 timed condition reached ${appliedCount}/${expectedCount} models`,
        );
      }
      timedStateApplied = true;
      return {
        condition,
        expectedShow: expectedShown,
        appliedCount,
        subject: initial,
      };
    },

    validateTimedCondition() {
      if (!timedStateApplied) {
        throw new Error("C11-168 timed condition was never applied");
      }
      const current = assertSameSubject("post-measurement");
      const retainedCount = capturedModels.filter(
        (model) => model.show === expectedShown,
      ).length;
      if (retainedCount !== expectedCount) {
        throw new Error(
          `[structural] C11-168 timed condition retained ${retainedCount}/${expectedCount} models`,
        );
      }
      return { condition, expectedShow: expectedShown, retainedCount, current };
    },

    enterHiddenSelectorControl() {
      assertSameSubject("selector-control");
      setShown(false);
    },

    sampleHiddenSelectorControl() {
      hiddenControl.frameCount++;
      let commands = 0;
      for (const command of scene.frameState?.commandList ?? []) {
        const ownerIndex = capturedIndex.get(command?.owner);
        if (ownerIndex !== undefined) {
          commands++;
          hiddenControl.ownerIndices.add(ownerIndex);
        } else if (capturedSet.has(command?.owner)) {
          hiddenControl.foreignCapturedOwnerCount++;
        }
      }
      if (commands > 0) hiddenControl.commandFrames++;
      hiddenControl.maximumCommands = Math.max(
        hiddenControl.maximumCommands,
        commands,
      );
    },

    restoreShownForReplay() {
      assertSameSubject("pre-replay");
      setShown(true);
      restoredForReplay =
        capturedModels.filter((model) => model.show === true).length ===
        expectedCount;
      if (!restoredForReplay) {
        throw new Error(
          "[structural] C11-168 failed to restore every model for identity replay",
        );
      }
    },

    selectorControlSnapshot(shownReplay) {
      const hidden = {
        frameCount: hiddenControl.frameCount,
        commandFrames: hiddenControl.commandFrames,
        maximumCommands: hiddenControl.maximumCommands,
        modelOwnersWithCommands: hiddenControl.ownerIndices.size,
        foreignCapturedOwnerCount: hiddenControl.foreignCapturedOwnerCount,
      };
      const shown = {
        frameCount: shownReplay?.sampledFrames ?? null,
        commandFrames: shownReplay?.directModelCommandFrames ?? null,
        maximumCommands: shownReplay?.maximumDirectModelCommands ?? null,
        modelOwnersWithCommands:
          shownReplay?.coverage?.modelOwnersWithCommands ?? null,
      };
      const reasons = [];
      if (!restoredForReplay) reasons.push("shown replay was not restored");
      if (hidden.frameCount !== shown.frameCount || !(hidden.frameCount > 0)) {
        reasons.push(
          "hidden and shown controls did not cover the same route frames",
        );
      }
      if (
        hidden.commandFrames !== 0 ||
        hidden.maximumCommands !== 0 ||
        hidden.modelOwnersWithCommands !== 0 ||
        hidden.foreignCapturedOwnerCount !== 0
      ) {
        reasons.push("hidden control still emitted direct-model commands");
      }
      if (
        !(shown.commandFrames > 0) ||
        !(shown.maximumCommands > 0) ||
        shown.modelOwnersWithCommands !== expectedCount
      ) {
        reasons.push("shown control did not exercise every direct model");
      }
      return {
        schemaVersion: 1,
        valid: reasons.length === 0,
        reasons,
        causal: false,
        timed: false,
        snapshotsFrozenBeforeControl: true,
        hidden,
        shown,
      };
    },

    restoreOriginal() {
      for (let index = 0; index < capturedModels.length; index++) {
        capturedModels[index].show = originalShow[index];
      }
    },
  };
}

function readRunCpuP95(run) {
  return (
    run?.pickMetrics?.combinedCpuMs?.p95 ?? run?.trace?.summary?.cpuMs?.p95
  );
}

function summarizeLeg(leg) {
  const report = leg?.report;
  const run = report?.runs?.[0];
  return {
    id: leg?.id ?? null,
    orderPair: leg?.orderPair ?? null,
    executionIndex: leg?.executionIndex ?? null,
    condition: leg?.condition ?? null,
    renderer: leg?.renderer ?? null,
    childProcessId: leg?.childProcessId ?? null,
    subprocessExitCode: leg?.subprocessExitCode ?? null,
    subprocessSignal: leg?.subprocessSignal ?? null,
    subprocessTimedOut: leg?.subprocessTimedOut ?? null,
    subprocessForcedKill: leg?.subprocessForcedKill ?? null,
    subprocessHardDeadlineExceeded: leg?.subprocessHardDeadlineExceeded ?? null,
    subprocessTimeoutMs: leg?.subprocessTimeoutMs ?? null,
    subprocessHardDeadlineMs: leg?.subprocessHardDeadlineMs ?? null,
    runId: leg?.runId ?? null,
    rawDirectory: leg?.rawDirectory ?? null,
    inputClosure: leg?.inputClosure ?? null,
    rawIdentity: leg?.rawIdentity ?? null,
    readError: leg?.readError ?? null,
    reportResult: report?.result ?? null,
    reportRunCount: Array.isArray(report?.runs) ? report.runs.length : null,
    reportAblation: report?.directModelAblation ?? null,
    runResult: run?.result ?? null,
    qualityStatus: run?.quality?.status ?? null,
    qualityMeasurementValid: run?.quality?.measurementValid ?? null,
    qualityValidForCpuAggregation: run?.quality?.validForCpuAggregation ?? null,
    cpuP95Ms: readRunCpuP95(run),
    measuredFrames: run?.measuredFrames ?? null,
    browserIsolation: report?.protocol?.browserIsolation ?? null,
    apiInstrumentation: report?.protocol?.apiInstrumentation ?? null,
    gpuTimestamps: report?.protocol?.gpuTimestamps ?? null,
    cpuOwnerAttribution: report?.protocol?.cpuOwnerAttribution ?? null,
    protocolCondition: report?.protocol?.directModelAblation ?? null,
    selectedRenderers: report?.protocol?.selectedRenderers ?? null,
    selectedWorkloads: report?.protocol?.selectedWorkloads ?? null,
    timestampEnabled: run?.timestampEnabled ?? null,
    apiCountersEnabled: run?.apiCounters?.enabled ?? null,
    source: report?.source ?? null,
    host: report?.host ?? null,
    browserVersion: report?.browserVersion ?? null,
    manifest: report?.manifest ?? null,
    workloadId: run?.workloadId ?? null,
    fixedFrameProgress:
      run?.representativeMeasurementAssessment?.fixedFrameProgress ?? null,
    measurementAssessmentValid:
      run?.representativeMeasurementAssessment?.valid ?? null,
    residency:
      run?.representativeContentEvidence?.measurementTilesetResidency ?? null,
    workloadFingerprint:
      run?.representativeContentEvidence?.measurementContent
        ?.workloadFingerprint ?? null,
    ablation: run?.directModelAblation ?? null,
    actualRenderer: run?.actualRenderer ?? null,
    canvasState: run?.canvasState ?? null,
    gpuProvenance: run?.gpuProvenance ?? null,
    userAgent: run?.userAgent ?? null,
  };
}

function equalityKey(value) {
  return stableC11168Json(value);
}

function allEqual(values) {
  return values.length > 0 && new Set(values.map(equalityKey)).size === 1;
}

function findCell(legs, pair, condition, renderer) {
  return legs.find(
    (leg) =>
      leg.orderPair === pair &&
      leg.condition === condition &&
      leg.renderer === renderer,
  );
}

function summarizeNoise(orderPairs, cells) {
  const cellRepeatRanges = {};
  for (const condition of C11_168_DIRECT_MODEL_ABLATION_CONFIG.conditions) {
    for (const renderer of C11_168_DIRECT_MODEL_ABLATION_CONFIG.renderers) {
      const key = `${renderer}:${condition}`;
      const values = orderPairs
        .map((pair) => findCell(cells, pair.orderPair, condition, renderer))
        .map((cell) => cell?.cpuP95Ms)
        .filter(isFiniteNumber);
      cellRepeatRanges[key] =
        values.length > 1 ? Math.max(...values) - Math.min(...values) : null;
    }
  }
  const finiteCellRanges =
    Object.values(cellRepeatRanges).filter(isFiniteNumber);
  const selectorValues = orderPairs
    .map((pair) => pair.selectorMs)
    .filter(isFiniteNumber);
  const selectorRepeatRangeMs =
    selectorValues.length > 1
      ? Math.max(...selectorValues) - Math.min(...selectorValues)
      : null;
  return {
    method:
      "maximum of the repeated-cell p95 range and repeated selector range across reverse-order quartets",
    cellRepeatRangesMs: cellRepeatRanges,
    selectorRepeatRangeMs,
    noiseFloorMs:
      selectorRepeatRangeMs === null || finiteCellRanges.length === 0
        ? null
        : Math.max(selectorRepeatRangeMs, ...finiteCellRanges),
  };
}

const sha256Pattern = /^[0-9A-F]{64}$/u;

function identityRecordIsValid(record, expectedPath) {
  return (
    record?.path === expectedPath &&
    Number.isInteger(record?.byteLength) &&
    record.byteLength > 0 &&
    sha256Pattern.test(record?.sha256 ?? "")
  );
}

function inputClosureIsValid(closure) {
  if (
    closure?.schemaVersion !== 1 ||
    !Array.isArray(closure?.localFiles) ||
    !Array.isArray(closure?.servedFiles) ||
    closure.localFiles.length !== C11_168_LOCAL_EXECUTION_PATHS.length ||
    closure.servedFiles.length !== C11_168_SERVED_EXECUTION_PATHS.length
  ) {
    return false;
  }
  const local = new Map();
  for (let index = 0; index < C11_168_LOCAL_EXECUTION_PATHS.length; index++) {
    const expectedPath = C11_168_LOCAL_EXECUTION_PATHS[index];
    const record = closure.localFiles[index];
    if (!identityRecordIsValid(record, expectedPath)) return false;
    if (local.has(expectedPath)) return false;
    local.set(expectedPath, record);
  }
  const servedPaths = new Set();
  for (let index = 0; index < C11_168_SERVED_EXECUTION_PATHS.length; index++) {
    const expectedPath = C11_168_SERVED_EXECUTION_PATHS[index];
    const record = closure.servedFiles[index];
    if (
      !identityRecordIsValid(record, expectedPath) ||
      record.status !== 200 ||
      typeof record.contentType !== "string" ||
      record.contentType.length === 0 ||
      typeof record.url !== "string"
    ) {
      return false;
    }
    let url;
    try {
      url = new URL(record.url);
    } catch {
      return false;
    }
    if (
      url.protocol !== "http:" ||
      url.hostname !== "localhost" ||
      url.port !== "8080" ||
      url.pathname !== `/${expectedPath}` ||
      url.search !== "" ||
      url.hash !== "" ||
      url.username !== "" ||
      url.password !== "" ||
      servedPaths.has(expectedPath)
    ) {
      return false;
    }
    servedPaths.add(expectedPath);
    const localRecord = local.get(expectedPath);
    if (
      !localRecord ||
      localRecord.byteLength !== record.byteLength ||
      localRecord.sha256 !== record.sha256
    ) {
      return false;
    }
  }
  return true;
}

function reportSourceMatchesClosure(source, closure) {
  const local = new Map(
    closure.localFiles.map((record) => [record.path, record]),
  );
  const tooling = source?.tooling;
  if (
    !isObject(tooling) ||
    equalityKey(Object.keys(tooling).sort()) !==
      equalityKey(Object.keys(C11_168_REPORT_TOOLING_PATHS).sort())
  ) {
    return false;
  }
  for (const [name, expectedPath] of Object.entries(
    C11_168_REPORT_TOOLING_PATHS,
  )) {
    const reportIdentity = tooling[name];
    const closureIdentity = local.get(expectedPath);
    if (
      !identityRecordIsValid(reportIdentity, expectedPath) ||
      !closureIdentity ||
      reportIdentity.byteLength !== closureIdentity.byteLength ||
      reportIdentity.sha256 !== closureIdentity.sha256
    ) {
      return false;
    }
  }
  const runtimeBundle = local.get("Build/CesiumUnminified/Cesium.js");
  const runtimeEntry = local.get("Build/CesiumUnminified/index.js");
  return (
    identityRecordIsValid(
      source?.runtimeBundle,
      "Build/CesiumUnminified/Cesium.js",
    ) &&
    runtimeBundle?.byteLength === source.runtimeBundle.byteLength &&
    runtimeBundle?.sha256 === source.runtimeBundle.sha256 &&
    identityRecordIsValid(
      source?.runtimeEntry,
      "Build/CesiumUnminified/index.js",
    ) &&
    runtimeEntry?.byteLength === source.runtimeEntry.byteLength &&
    runtimeEntry?.sha256 === source.runtimeEntry.sha256
  );
}

function physicalEnvironmentIsValid(leg) {
  const host = leg.host;
  const canvas = leg.canvasState;
  const gpu = leg.gpuProvenance;
  let page;
  try {
    page = new URL(canvas?.page);
  } catch {
    return false;
  }
  const hostValid =
    typeof host?.platform === "string" &&
    host.platform.length > 0 &&
    typeof host?.release === "string" &&
    host.release.length > 0 &&
    typeof host?.architecture === "string" &&
    host.architecture.length > 0 &&
    typeof host?.cpu === "string" &&
    host.cpu.length > 0 &&
    Number.isInteger(host?.logicalCpuCount) &&
    host.logicalCpuCount > 0 &&
    Number.isFinite(host?.totalMemoryBytes) &&
    host.totalMemoryBytes > 0 &&
    /^v\d+\./u.test(host?.node ?? "");
  const canvasValid =
    canvas?.clientWidth === 1280 &&
    canvas?.clientHeight === 720 &&
    canvas?.canvasWidth === 1280 &&
    canvas?.canvasHeight === 720 &&
    canvas?.drawingBufferWidth === 1280 &&
    canvas?.drawingBufferHeight === 720 &&
    canvas?.devicePixelRatio === 1 &&
    canvas?.resolutionScale === 1 &&
    page.protocol === "http:" &&
    page.hostname === "localhost" &&
    page.port === "8080" &&
    page.pathname === "/Apps/CesiumViewer/index.html" &&
    page.searchParams.size === 2 &&
    page.searchParams.getAll("renderer").length === 1 &&
    page.searchParams.get("renderer") === leg.renderer &&
    page.searchParams.getAll("offline").length === 1 &&
    page.searchParams.get("offline") === "true" &&
    page.username === "" &&
    page.password === "" &&
    page.hash === "";
  const gpuValid =
    gpu?.complete === true &&
    gpu?.backend === leg.renderer &&
    (leg.renderer === "webgl"
      ? typeof gpu.rendererString === "string" && gpu.rendererString.length > 0
      : isObject(gpu.adapterInfo) &&
        ["vendor", "architecture", "device", "description"].some(
          (name) =>
            typeof gpu.adapterInfo[name] === "string" &&
            gpu.adapterInfo[name].trim().length > 0,
        ));
  return (
    hostValid &&
    typeof leg.browserVersion === "string" &&
    /^\d+\.\d+\.\d+\.\d+$/u.test(leg.browserVersion) &&
    typeof leg.userAgent === "string" &&
    leg.userAgent.length > 0 &&
    leg.actualRenderer === leg.renderer &&
    canvasValid &&
    gpuValid
  );
}

function commonPhysicalEnvironment(leg) {
  const canvas = leg.canvasState;
  return {
    host: leg.host,
    browserVersion: leg.browserVersion,
    userAgent: leg.userAgent,
    canvas: {
      clientWidth: canvas?.clientWidth ?? null,
      clientHeight: canvas?.clientHeight ?? null,
      canvasWidth: canvas?.canvasWidth ?? null,
      canvasHeight: canvas?.canvasHeight ?? null,
      drawingBufferWidth: canvas?.drawingBufferWidth ?? null,
      drawingBufferHeight: canvas?.drawingBufferHeight ?? null,
      devicePixelRatio: canvas?.devicePixelRatio ?? null,
      resolutionScale: canvas?.resolutionScale ?? null,
    },
  };
}

/**
 * Assess two or more reverse-order quartets. A valid negative/null selector is
 * a completed discriminator, not a product failure.
 */
export function assessC11168DirectModelAblationCampaign(rawLegs) {
  const config = C11_168_DIRECT_MODEL_ABLATION_CONFIG;
  const legs = rawLegs.map(summarizeLeg);
  const reasons = [];
  const pairIds = [...new Set(legs.map((leg) => leg.orderPair))].sort(
    (left, right) => left - right,
  );
  const expectedPairIds = Array.from(
    { length: config.orderPairCount },
    (_, index) => index + 1,
  );
  if (equalityKey(pairIds) !== equalityKey(expectedPairIds)) {
    reasons.push(
      `order-pair identities must be exactly ${expectedPairIds.join(",")}`,
    );
  }
  const expectedLegCount = config.orderPairCount * config.legsPerOrderPair;
  if (legs.length !== expectedLegCount) {
    reasons.push(
      `campaign has ${legs.length}/${expectedLegCount} quartet legs`,
    );
  }
  const processIds = legs.map((leg) => leg.childProcessId);
  if (
    processIds.some((id) => !Number.isInteger(id) || id < 1) ||
    new Set(processIds).size !== processIds.length
  ) {
    reasons.push("fresh Node process identity is missing or reused");
  }
  for (const pairId of pairIds) {
    for (const condition of config.conditions) {
      for (const renderer of config.renderers) {
        const matches = legs.filter(
          (leg) =>
            leg.orderPair === pairId &&
            leg.condition === condition &&
            leg.renderer === renderer,
        );
        if (matches.length !== 1) {
          reasons.push(
            `order pair ${pairId} has ${matches.length} ${renderer}/${condition} legs`,
          );
        }
      }
    }
    const executionIndexes = legs
      .filter((leg) => leg.orderPair === pairId)
      .map((leg) => leg.executionIndex)
      .sort((left, right) => left - right);
    if (
      equalityKey(executionIndexes) !==
      equalityKey(
        Array.from({ length: config.legsPerOrderPair }, (_, index) => index),
      )
    ) {
      reasons.push(
        `order pair ${pairId} must have execution indexes 0 through ${config.legsPerOrderPair - 1}`,
      );
    }
  }
  for (const leg of legs) {
    const prefix = leg.id ?? `${leg.renderer}/${leg.condition}`;
    if (
      leg.subprocessExitCode !== 0 ||
      leg.subprocessSignal !== null ||
      leg.subprocessTimedOut !== false ||
      leg.subprocessForcedKill !== false ||
      leg.subprocessHardDeadlineExceeded !== false ||
      leg.subprocessTimeoutMs !== config.childProcessTimeoutMs ||
      leg.subprocessHardDeadlineMs !== config.childHardTerminationDeadlineMs ||
      leg.reportResult !== "pass" ||
      leg.reportRunCount !== 1 ||
      leg.runResult !== "pass" ||
      leg.qualityStatus !== "clean" ||
      leg.qualityMeasurementValid !== true ||
      leg.qualityValidForCpuAggregation !== true
    ) {
      reasons.push(`${prefix}: runner leg did not pass cleanly`);
    }
    const uuidV4 =
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
    const expectedId = c11168LegId(leg);
    const expectedRawDirectory = `${config.rawArtifactRoot}/${leg.runId}`;
    const expectedRawPath = `${expectedRawDirectory}/${expectedId}.json`;
    if (
      leg.readError !== null ||
      !uuidV4.test(leg.runId ?? "") ||
      leg.id !== expectedId ||
      leg.rawDirectory !== expectedRawDirectory ||
      !identityRecordIsValid(leg.rawIdentity, expectedRawPath)
    ) {
      reasons.push(`${prefix}: unique raw artifact identity is invalid`);
    }
    if (
      leg.browserIsolation !== "fresh-process-per-run" ||
      leg.apiInstrumentation !== false ||
      leg.gpuTimestamps !== false ||
      leg.cpuOwnerAttribution !== false ||
      leg.timestampEnabled !== false ||
      leg.apiCountersEnabled !== false ||
      leg.protocolCondition !== leg.condition ||
      equalityKey(leg.selectedRenderers) !== equalityKey([leg.renderer]) ||
      equalityKey(leg.selectedWorkloads) !== equalityKey([config.workloadId])
    ) {
      reasons.push(
        `${prefix}: process isolation or instrumentation policy drifted`,
      );
    }
    if (
      leg.workloadId !== config.workloadId ||
      leg.measuredFrames !== config.measuredFrames ||
      !isFiniteNumber(leg.cpuP95Ms)
    ) {
      reasons.push(
        `${prefix}: canonical workload, frame count, or CPU p95 is missing`,
      );
    }
    const sha256 = sha256Pattern;
    const commit = /^[0-9a-f]{40}$/u;
    const source = leg.source;
    if (
      !commit.test(source?.commit ?? "") ||
      typeof source?.branch !== "string" ||
      source?.dirty !== false ||
      source?.runtimeBundle?.path !== "Build/CesiumUnminified/Cesium.js" ||
      !sha256.test(source?.runtimeBundle?.sha256 ?? "") ||
      !(source?.runtimeBundle?.byteLength > 0) ||
      source?.runtimeEntry?.path !== "Build/CesiumUnminified/index.js" ||
      !sha256.test(source?.runtimeEntry?.sha256 ?? "") ||
      !(source?.runtimeEntry?.byteLength > 0) ||
      source?.tooling?.manifest?.sha256 !== config.manifestSha256 ||
      leg.manifest?.id !== config.manifestId ||
      leg.reportAblation?.condition !== leg.condition ||
      leg.reportAblation?.configAssessment?.pass !== true
    ) {
      reasons.push(`${prefix}: source/build/config identity is incomplete`);
    }
    if (!inputClosureIsValid(leg.inputClosure)) {
      reasons.push(
        `${prefix}: exact local/served execution closure is invalid`,
      );
    } else if (!reportSourceMatchesClosure(source, leg.inputClosure)) {
      reasons.push(
        `${prefix}: report source/tooling identities do not match the frozen closure`,
      );
    }
    if (!physicalEnvironmentIsValid(leg)) {
      reasons.push(`${prefix}: physical browser/GPU environment is invalid`);
    }
    const fixed = leg.fixedFrameProgress;
    if (
      fixed?.valid !== true ||
      fixed.identical !== true ||
      fixed.measuredFrameCount !== config.measuredFrames ||
      fixed.replayFrameCount !== config.measuredFrames ||
      fixed.maximumAbsoluteDifference !== 0
    ) {
      reasons.push(
        `${prefix}: exact 600-frame route/replay equality is unproven`,
      );
    }
    if (leg.measurementAssessmentValid !== true) {
      reasons.push(
        `${prefix}: representative measurement assessment is invalid`,
      );
    }
    const residency = leg.residency;
    if (
      residency?.tilesetCount !== config.expectedTilesets ||
      residency.frames !== config.measuredFrames ||
      residency.notLoadedFrames !== 0 ||
      residency.pendingRequestFrames !== 0 ||
      residency.processingFrames !== 0 ||
      residency.attemptedRequestFrames !== 0 ||
      residency.loadedTilesTotalDelta !== 0 ||
      residency.contentByteLengthDelta !== 0
    ) {
      reasons.push(`${prefix}: measured 3D Tiles residency is not quiescent`);
    }
    if (
      leg.workloadFingerprint?.valid !== true ||
      leg.workloadFingerprint.frameCount !== config.measuredFrames
    ) {
      reasons.push(`${prefix}: workload identity fingerprint is invalid`);
    }
    const ablation = leg.ablation;
    const subject = ablation?.timed?.applied?.subject;
    if (
      ablation?.valid !== true ||
      ablation.condition !== leg.condition ||
      ablation.timed?.applied?.condition !== leg.condition ||
      ablation.timed?.retained?.condition !== leg.condition ||
      subject?.expectedCount !== config.expectedDirectModels ||
      subject.configuredCount !== config.expectedDirectModels ||
      subject.uniqueReferenceCount !== config.expectedDirectModels ||
      subject.readyCount !== config.expectedDirectModels ||
      subject.primitiveMembershipCount !== config.expectedDirectModels ||
      subject.descriptors?.length !== config.expectedDirectModels
    ) {
      reasons.push(`${prefix}: exact 48-object timed subject is unproven`);
    }
    const descriptors = Array.isArray(subject?.descriptors)
      ? subject.descriptors
      : [];
    const descriptorIndices = descriptors.map(
      (descriptor) => descriptor?.index,
    );
    if (
      !Array.isArray(subject?.descriptors) ||
      descriptorIndices?.length !== config.expectedDirectModels ||
      new Set(descriptorIndices).size !== config.expectedDirectModels ||
      descriptorIndices.some((index, position) => index !== position) ||
      descriptors.some(
        (descriptor) =>
          typeof descriptor.resourceUrl !== "string" ||
          descriptor.resourceUrl.length === 0 ||
          !Array.isArray(descriptor.modelMatrix) ||
          descriptor.modelMatrix.length !== 16 ||
          descriptor.modelMatrix.some((value) => !isFiniteNumber(value)) ||
          !isFiniteNumber(descriptor.scale),
      ) ||
      equalityKey(subject) !== equalityKey(ablation?.timed?.retained?.current)
    ) {
      reasons.push(`${prefix}: direct-model descriptor identity is incomplete`);
    }
    const expectedShow = leg.condition === "shown";
    if (
      ablation?.timed?.applied?.expectedShow !== expectedShow ||
      ablation?.timed?.retained?.expectedShow !== expectedShow ||
      ablation?.timed?.applied?.appliedCount !== config.expectedDirectModels ||
      ablation?.timed?.retained?.retainedCount !== config.expectedDirectModels
    ) {
      reasons.push(
        `${prefix}: requested shown/hidden state did not span all models`,
      );
    }
    if (
      ablation?.selectorControl?.valid !== true ||
      ablation.selectorControl.snapshotsFrozenBeforeControl !== true ||
      ablation.selectorControl.hidden?.frameCount !== config.measuredFrames ||
      ablation.selectorControl.hidden?.commandFrames !== 0 ||
      ablation.selectorControl.hidden?.maximumCommands !== 0 ||
      ablation.selectorControl.hidden?.modelOwnersWithCommands !== 0 ||
      ablation.selectorControl.hidden?.foreignCapturedOwnerCount !== 0 ||
      ablation.selectorControl.shown?.frameCount !== config.measuredFrames ||
      !(ablation.selectorControl.shown?.commandFrames > 0) ||
      !(ablation.selectorControl.shown?.maximumCommands > 0) ||
      ablation.selectorControl.shown?.modelOwnersWithCommands !==
        config.expectedDirectModels ||
      ablation.selectorControl.causal !== false ||
      ablation.selectorControl.timed !== false
    ) {
      reasons.push(
        `${prefix}: shown/hidden selector control is vacuous or invalid`,
      );
    }
  }

  const sourceKeys = legs.map((leg) => ({
    commit: leg.source?.commit ?? null,
    branch: leg.source?.branch ?? null,
    dirty: leg.source?.dirty ?? null,
    runtimeBundle: leg.source?.runtimeBundle ?? null,
    runtimeEntry: leg.source?.runtimeEntry ?? null,
    tooling: leg.source?.tooling ?? null,
    manifest: leg.manifest ?? null,
  }));
  if (!allEqual(sourceKeys)) {
    reasons.push(
      "source, runtime build, manifest, or tooling identities differ",
    );
  }
  if (!allEqual(legs.map((leg) => leg.inputClosure))) {
    reasons.push("local/served execution closure differs across legs");
  }
  if (!allEqual(legs.map((leg) => leg.runId))) {
    reasons.push("raw artifacts do not share one canonical driver run id");
  }
  if (!allEqual(legs.map(commonPhysicalEnvironment))) {
    reasons.push("host, browser, or canvas environment differs across legs");
  }
  for (const renderer of config.renderers) {
    const rendererGpuProvenance = legs
      .filter((leg) => leg.renderer === renderer)
      .map((leg) => leg.gpuProvenance);
    if (!allEqual(rendererGpuProvenance)) {
      reasons.push(`${renderer} GPU provenance differs across legs`);
    }
  }
  const workloadFingerprints = legs.map((leg) => leg.workloadFingerprint);
  if (!allEqual(workloadFingerprints)) {
    reasons.push("ordinary shown workload fingerprints differ across legs");
  }
  const modelDescriptors = legs.map(
    (leg) => leg.ablation?.timed?.applied?.subject?.descriptors ?? null,
  );
  if (!allEqual(modelDescriptors)) {
    reasons.push("direct-model source/transform identities differ across legs");
  }

  const orderPairs = pairIds.map((orderPair) => {
    const shownWebgpu = findCell(legs, orderPair, "shown", "webgpu");
    const hiddenWebgpu = findCell(legs, orderPair, "hidden", "webgpu");
    const shownWebgl = findCell(legs, orderPair, "shown", "webgl");
    const hiddenWebgl = findCell(legs, orderPair, "hidden", "webgl");
    const webgpuFullMinusHiddenMs =
      shownWebgpu?.cpuP95Ms - hiddenWebgpu?.cpuP95Ms;
    const webglFullMinusHiddenMs = shownWebgl?.cpuP95Ms - hiddenWebgl?.cpuP95Ms;
    const selectorMs = webgpuFullMinusHiddenMs - webglFullMinusHiddenMs;
    return {
      orderPair,
      executionOrder: legs
        .filter((leg) => leg.orderPair === orderPair)
        .sort((left, right) => left.executionIndex - right.executionIndex)
        .map((leg) => `${leg.renderer}:${leg.condition}`),
      cpuP95Ms: {
        webgpu: {
          shown: shownWebgpu?.cpuP95Ms ?? null,
          hidden: hiddenWebgpu?.cpuP95Ms ?? null,
          fullMinusHidden: webgpuFullMinusHiddenMs,
        },
        webgl: {
          shown: shownWebgl?.cpuP95Ms ?? null,
          hidden: hiddenWebgl?.cpuP95Ms ?? null,
          fullMinusHidden: webglFullMinusHiddenMs,
        },
      },
      selectorMs,
    };
  });
  if (orderPairs.some((pair) => !isFiniteNumber(pair.selectorMs))) {
    reasons.push("one or more order-pair statistics are incomplete");
  }
  const expectedOrders = config.quartetSchedules.map((schedule) =>
    schedule.map((leg) => `${leg.renderer}:${leg.condition}`),
  );
  if (
    equalityKey(orderPairs.map((pair) => pair.executionOrder)) !==
    equalityKey(expectedOrders)
  ) {
    reasons.push("quartet execution order does not match the exact protocol");
  }

  const noise = summarizeNoise(orderPairs, legs);
  const selectorValues = orderPairs.map((pair) => pair.selectorMs);
  const sortedSelectorValues = selectorValues
    .filter(isFiniteNumber)
    .sort((left, right) => left - right);
  const medianSelectorMs =
    sortedSelectorValues.length === 0
      ? null
      : sortedSelectorValues.length % 2 === 1
        ? sortedSelectorValues[(sortedSelectorValues.length - 1) / 2]
        : (sortedSelectorValues[sortedSelectorValues.length / 2 - 1] +
            sortedSelectorValues[sortedSelectorValues.length / 2]) /
          2;
  const positiveEveryOrderPair =
    selectorValues.length === config.orderPairCount &&
    selectorValues.every((value) => isFiniteNumber(value) && value > 0);
  const noSignReversal =
    selectorValues.length === config.orderPairCount &&
    (selectorValues.every((value) => value > 0) ||
      selectorValues.every((value) => value < 0));
  const clearsAbsoluteFloor =
    isFiniteNumber(medianSelectorMs) &&
    medianSelectorMs >= config.absoluteSelectorFloorMs;
  const clearsNoiseFloor =
    isFiniteNumber(medianSelectorMs) &&
    isFiniteNumber(noise.noiseFloorMs) &&
    medianSelectorMs > config.noiseMultiple * noise.noiseFloorMs;
  const evidenceValid = reasons.length === 0;
  const selected =
    evidenceValid &&
    positiveEveryOrderPair &&
    noSignReversal &&
    (clearsAbsoluteFloor || clearsNoiseFloor);

  return {
    schemaVersion: config.schemaVersion,
    valid: evidenceValid,
    reasons,
    completedMeasurement: evidenceValid,
    hypothesis: {
      statistic:
        "(WebGPU shown - WebGPU hidden) - (WebGL shown - WebGL hidden), using whole-route Scene.render CPU p95 milliseconds",
      selected,
      verdict: evidenceValid
        ? selected
          ? "direct-model-family-selected"
          : "direct-model-family-not-selected"
        : "structural",
      medianSelectorMs,
      positiveEveryOrderPair,
      noSignReversal,
      clearsAbsoluteFloor,
      clearsNoiseFloor,
      thresholds: {
        absoluteFloorMs: config.absoluteSelectorFloorMs,
        noiseMultiple: config.noiseMultiple,
      },
    },
    noise,
    orderPairs,
    legs,
  };
}
