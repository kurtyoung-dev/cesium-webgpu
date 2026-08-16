/**
 * Pure contract and browser-side utilities for the C12-29 S5 dense
 * ACTIVE/INACTIVE cost characterization.
 *
 * Node owns process isolation, provenance, publication, and browser launch.
 * This module owns the frozen experiment and the fail-closed fold.  Runtime
 * helpers accept Cesium explicitly so importing this file in Node has no DOM,
 * filesystem, or renderer side effects.
 */

// A hand-written SHA-256 lived here so the fold could run "anywhere". Nothing
// ever ran it outside Node, and a second implementation of a hash is a second
// thing that can disagree with the bytes the evidence was banked under.
import { sha256 } from "./visual-gate-policy.mjs";
import {
  S5_STATUS_EXIT_CODES,
  exitCodeForS5StatusOrStructural as exitCodeForC1229S5DenseStatus,
} from "./verdict-exit-gate.mjs";

export const C12_29_S5_DENSE_LEGACY_SCHEMA = "c12-29-s5-dense-cost-evidence-v1";
export const C12_29_S5_DENSE_SUPERSEDED_SCHEMA =
  "c12-29-s5-dense-cost-evidence-v2";
export const C12_29_S5_DENSE_SCHEMA = "c12-29-s5-dense-cost-evidence-v3";
export const C12_29_S5_DENSE_RUNTIME_SCHEMA = "c12-29-s5-dense-cost-runtime-v1";
export const C12_29_S5_DENSE_WORKLOAD_SCHEMA =
  "c12-29-s5-dense-cost-workload-v1";
export const C12_29_S5_DENSE_RENDERERS = Object.freeze(["webgl", "webgpu"]);
export const C12_29_S5_DENSE_CONDITIONS = Object.freeze(["active", "inactive"]);
export const C12_29_S5_DENSE_STATUSES = Object.freeze([
  "RUNNING",
  "PASS",
  "FAIL",
  "ERROR",
  "STRUCTURAL",
]);

const C12_29_S5_DENSE_WORKLOAD_PATH =
  "Tools/visual-regression/performance-workloads-s5-dense-cost.json";

export const C12_29_S5_DENSE_CONFIG = Object.freeze({
  workloadByteLength: 7137,
  workloadSha256:
    "748a95681177ea2cbd637dcad864b765d8f38f8dc55a400b24ba2dc96113117d",
  measuredFrames: 600,
  refreshSemantics:
    "one explicit scene.render between successive requestAnimationFrame callbacks",
  settleStableFrames: 30,
  settleTimeoutMs: 90_000,
  gpuReadbackTimeoutMs: 10_000,
  legTimeoutMs: 900_000,
  postKillCloseTimeoutMs: 30_000,
  fixedClock: "2024-04-08T18:17:16Z",
  anchor: Object.freeze({ longitudeDegrees: -104.1, latitudeDegrees: 25.3 }),
  viewport: Object.freeze({ width: 1280, height: 720, deviceScaleFactor: 1 }),
  routeSegments: 8,
  minimumFramesPerSegment: 30,
  minimumHeightMeters: 25_000,
  maximumHeightMeters: 45_000,
  heightmapWidth: 33,
  waterMaskWidth: 16,
  waterMaskPattern: "((row*3+column*5)%11)<5?0:255",
  waterMaskSha256:
    "2e88659bc8181a5b0aa6cd626ab3fc5164678b369f08de790bf5bbe5ee27b960",
  maximumTerrainLevel: 12,
  tileCacheSize: 8192,
  maximumScreenSpaceError: 0.1,
  sentinelWidth: 8,
  sentinelHeight: 8,
  activeGateValues: Object.freeze([1, 2]),
  inactiveGateValues: Object.freeze([0]),
  repetitions: 6,
  expectedLegs: 24,
  maximumLongTaskShare: 0.25,
  maximumP95SpreadRatio: 2,
  webgpuTimestampAttempts: 600,
  webgpuMinimumTimestampSamples: 540,
  webgpuMaximumTimestampSkipShare: 0.1,
  outputNamespace:
    "Tools/visual-regression/output/performance/c12-29-s5-dense-cost",
  exitCodes: S5_STATUS_EXIT_CODES,
});

export const C12_29_S5_DENSE_SCHEDULE = Object.freeze(
  [
    [1, "webgl", "active"],
    [1, "webgl", "inactive"],
    [1, "webgpu", "active"],
    [1, "webgpu", "inactive"],
    [2, "webgpu", "inactive"],
    [2, "webgpu", "active"],
    [2, "webgl", "inactive"],
    [2, "webgl", "active"],
    [3, "webgl", "inactive"],
    [3, "webgl", "active"],
    [3, "webgpu", "inactive"],
    [3, "webgpu", "active"],
    [4, "webgpu", "active"],
    [4, "webgpu", "inactive"],
    [4, "webgl", "active"],
    [4, "webgl", "inactive"],
    [5, "webgl", "active"],
    [5, "webgl", "inactive"],
    [5, "webgpu", "inactive"],
    [5, "webgpu", "active"],
    [6, "webgpu", "active"],
    [6, "webgpu", "inactive"],
    [6, "webgl", "inactive"],
    [6, "webgl", "active"],
  ].map(([repetition, renderer, condition], index) =>
    Object.freeze({
      ordinal: index + 1,
      repetition,
      withinRepetition: (index % 4) + 1,
      renderer,
      condition,
    }),
  ),
);

export const C12_29_S5_DENSE_PREREQUISITES = Object.freeze({
  terrain: Object.freeze({
    producer: "c12-29-s5-terrain-selection",
    schema: "c12-29-s5-terrain-selection-evidence-v10",
  }),
  // Advanced v4 -> v5 with the NASA-SVS repair (ruling R-2026-08-14-8). Only
  // the CURRENT rung moves: the superseded and legacy rungs below record what
  // dense-v2 and dense-v1 artifacts actually required when they were written,
  // and rewriting them would falsify history rather than reconcile it. Moving
  // this rung invalidates no banked evidence — there are no dense-cost
  // publications in the evidence library, and the dense run is serialized
  // after a fresh NASA publication by design.
  nasa: Object.freeze({
    producer: "c12-29-s5-svs-footprint",
    schema: "c12-29-s5-svs-5073-footprint-evidence-v5",
  }),
  publicationSchema: "cesium-visual-evidence-publication/v2",
});

export const C12_29_S5_DENSE_SUPERSEDED_PREREQUISITES = Object.freeze({
  terrain: Object.freeze({
    producer: "c12-29-s5-terrain-selection",
    schema: "c12-29-s5-terrain-selection-evidence-v10",
  }),
  nasa: Object.freeze({
    producer: "c12-29-s5-svs-footprint",
    schema: "c12-29-s5-svs-5073-footprint-evidence-v3",
  }),
  publicationSchema: "cesium-visual-evidence-publication/v2",
});

export const C12_29_S5_DENSE_LEGACY_PREREQUISITES = Object.freeze({
  terrain: Object.freeze({
    producer: "c12-29-s5-terrain-selection",
    schema: "c12-29-s5-terrain-selection-evidence-v8",
  }),
  nasa: Object.freeze({
    producer: "c12-29-s5-svs-footprint",
    schema: "c12-29-s5-svs-5073-footprint-evidence-v2",
  }),
  publicationSchema: "cesium-visual-evidence-publication/v2",
});

const WIDGET_CSS = Object.freeze([
  "Source/Widgets/Animation/Animation.css",
  "Source/Widgets/BaseLayerPicker/BaseLayerPicker.css",
  "Source/Widgets/CesiumWidget/CesiumWidget.css",
  "Source/Widgets/FullscreenButton/FullscreenButton.css",
  "Source/Widgets/Geocoder/Geocoder.css",
  "Source/Widgets/InfoBox/InfoBox.css",
  "Source/Widgets/InfoBox/InfoBoxDescription.css",
  "Source/Widgets/NavigationHelpButton/NavigationHelpButton.css",
  "Source/Widgets/PerformanceWatchdog/PerformanceWatchdog.css",
  "Source/Widgets/ProjectionPicker/ProjectionPicker.css",
  "Source/Widgets/SceneModePicker/SceneModePicker.css",
  "Source/Widgets/SelectionIndicator/SelectionIndicator.css",
  "Source/Widgets/Timeline/Timeline.css",
  "Source/Widgets/Viewer/Viewer.css",
  "Source/Widgets/widgets.css",
]);

const TERRAIN_V8_SEMANTIC_SOURCE_FILES = Object.freeze([
  "packages/engine/Source/Core/VerticalExaggeration.js",
  "packages/engine/Source/Core/Visibility.js",
  "packages/engine/Source/Core/CesiumTerrainProvider.js",
  "packages/engine/Source/Core/QuantizedMeshTerrainData.js",
  "packages/engine/Source/Scene/GridImageryProvider.js",
  "packages/engine/Source/Scene/EclipseGlobeShadow.js",
  "packages/engine/Source/Scene/EclipseState.js",
  "packages/engine/Source/Scene/Scene.js",
  "packages/engine/Source/Scene/View.js",
  "packages/engine/Source/Scene/FrameState.js",
  "packages/engine/Source/Scene/SceneUtilities.js",
  "packages/engine/Source/Scene/Globe.js",
  "packages/engine/Source/Scene/GlobeSurfaceTile.js",
  "packages/engine/Source/Scene/GlobeSurfaceTileProvider.js",
  "packages/engine/Source/Scene/GlobeSurfaceTileProviderRendering.js",
  "packages/engine/Source/Scene/GlobeSurfaceShaderSet.js",
  "packages/engine/Source/Scene/TerrainFillMesh.js",
  "packages/engine/Source/Scene/QuadtreePrimitive.js",
  "packages/engine/Source/Scene/TileSelectionResult.js",
  "packages/engine/Source/Scene/Picking.js",
  "packages/engine/Source/Scene/PickFramebuffer.js",
  "packages/engine/Source/Renderer/Sync.js",
  "packages/engine/Source/Renderer/WebGPU/WebGPUDynamicEnvironmentMapManager.ts",
  "packages/engine/Source/Renderer/WebGPU/WebGPUDynamicEnvironmentMapCapture.ts",
  "packages/engine/Source/Renderer/WebGPU/WebGPUGlobeSurfaceRenderer.ts",
  "packages/engine/Source/Renderer/WebGPU/WebGPUGlobeSurfaceLayouts.ts",
  "packages/engine/Source/Renderer/WebGPU/WebGPUGlobeEclipseUniforms.ts",
  "packages/engine/Source/Renderer/WebGPU/WebGPUGlobeSurfaceTypes.ts",
  "packages/engine/Source/Renderer/WebGPU/WebGPUGlobeSurfaceShaders.ts",
  "packages/engine/Source/Renderer/WebGPU/WebGPUGlobeSurfaceTileUB.ts",
  "packages/engine/Source/Shaders/GlobeFS.glsl",
  "packages/engine/Source/Shaders/GlobeFS.js",
  "packages/engine/Source/Shaders/WebGPU/Globe/GlobeTerrain.wgsl",
  "packages/engine/Source/Shaders/WebGPU/Globe/GlobeTerrain.js",
  "packages/engine/Source/Scene/DynamicEnvironmentMapManager.js",
  "packages/engine/Source/Renderer/FeatureRendererKey.js",
  "packages/engine/Source/Renderer/WebGPU/WebGPUFeatureRenderers.ts",
]);

// This list is deliberately duplicated from the exact NASA-SVS v5 contract.
// The helper is imported by the browser, so importing the Node-only NASA gate
// module here would break the runtime lane.  The Node spec cross-checks the two
// arrays byte-for-byte and order-for-order to keep this boundary fail closed.
//
// The mirror moves with the prerequisite pin above because the two are one
// boundary: a gate that accepts a v5 publication while checking a v4 source
// closure is no longer fail closed. The v5 closure is a strict superset of the
// v4 one (+6 files, none removed — Ellipsoid, AtmosphericConditions, Camera,
// CameraHelpers, CameraInternals, WebGPUGlobeSurfacePipelines, the sources the
// v5 repair added to derive the frozen camera and footprint), so widening it
// can only make the dense source closure more fail closed, never less.
export const C12_29_S5_DENSE_NASA_V5_SOURCE_FILES = Object.freeze([
  "packages/engine/Source/Core/Cartesian2.js",
  "packages/engine/Source/Core/Cartesian3.js",
  "packages/engine/Source/Core/Cartographic.js",
  "packages/engine/Source/Core/Color.js",
  "packages/engine/Source/Core/Ellipsoid.js",
  "packages/engine/Source/Core/EllipsoidGeodesic.js",
  "packages/engine/Source/Core/JulianDate.js",
  "packages/engine/Source/Core/Math.js",
  "packages/engine/Source/Core/Matrix3.js",
  "packages/engine/Source/Core/TimeInterval.js",
  "packages/engine/Source/Core/VerticalExaggeration.js",
  "packages/engine/Source/Core/Visibility.js",
  "packages/engine/Source/Core/CelestialEphemerisProvider.js",
  "packages/engine/Source/Core/Simon1994EphemerisProvider.js",
  "packages/engine/Source/Core/Transforms.js",
  "packages/engine/Source/Core/Iau2006XysData.js",
  "packages/engine/Source/Core/Simon1994PlanetaryPositions.js",
  "packages/engine/Source/Core/CesiumTerrainProvider.js",
  "packages/engine/Source/Core/QuantizedMeshTerrainData.js",
  "packages/engine/Source/Scene/AtmosphericConditions.js",
  "packages/engine/Source/Scene/Camera.js",
  "packages/engine/Source/Scene/CameraHelpers.js",
  "packages/engine/Source/Scene/CameraInternals.js",
  "packages/engine/Source/Scene/GridImageryProvider.js",
  "packages/engine/Source/Scene/EclipseState.js",
  "packages/engine/Source/Scene/EclipseGlobeShadow.js",
  "packages/engine/Source/Scene/Scene.js",
  "packages/engine/Source/Scene/SceneTransforms.js",
  "packages/engine/Source/Scene/View.js",
  "packages/engine/Source/Scene/FrameState.js",
  "packages/engine/Source/Scene/SceneUtilities.js",
  "packages/engine/Source/Scene/Globe.js",
  "packages/engine/Source/Scene/GlobeSurfaceTile.js",
  "packages/engine/Source/Scene/GlobeSurfaceTileProvider.js",
  "packages/engine/Source/Scene/GlobeSurfaceTileProviderRendering.js",
  "packages/engine/Source/Scene/GlobeSurfaceShaderSet.js",
  "packages/engine/Source/Scene/TerrainFillMesh.js",
  "packages/engine/Source/Scene/QuadtreePrimitive.js",
  "packages/engine/Source/Scene/TileSelectionResult.js",
  "packages/engine/Source/Scene/Picking.js",
  "packages/engine/Source/Scene/PickFramebuffer.js",
  "packages/engine/Source/Renderer/Sync.js",
  "packages/engine/Source/Renderer/Pass.js",
  "packages/engine/Source/Renderer/UniformStateComputations.js",
  "packages/engine/Source/Renderer/WebGPU/WebGPUDynamicEnvironmentMapManager.ts",
  "packages/engine/Source/Renderer/WebGPU/WebGPUDynamicEnvironmentMapCapture.ts",
  "packages/engine/Source/Renderer/WebGPU/WebGPUGlobeSurfaceRenderer.ts",
  "packages/engine/Source/Renderer/WebGPU/WebGPUGlobeSurfacePipelines.ts",
  "packages/engine/Source/Renderer/WebGPU/WebGPUGlobeSurfaceLayouts.ts",
  "packages/engine/Source/Renderer/WebGPU/WebGPUGlobeEclipseUniforms.ts",
  "packages/engine/Source/Renderer/WebGPU/WebGPUGlobeSurfaceTypes.ts",
  "packages/engine/Source/Renderer/WebGPU/WebGPUGlobeSurfaceShaders.ts",
  "packages/engine/Source/Renderer/WebGPU/WebGPUGlobeSurfaceTileUB.ts",
  "packages/engine/Source/Shaders/GlobeFS.glsl",
  "packages/engine/Source/Shaders/GlobeFS.js",
  "packages/engine/Source/Shaders/WebGPU/Globe/GlobeTerrain.wgsl",
  "packages/engine/Source/Shaders/WebGPU/Globe/GlobeTerrain.js",
  "packages/engine/Source/Scene/DynamicEnvironmentMapManager.js",
  "packages/engine/Source/Scene/Moon.js",
  "packages/engine/Source/Renderer/FeatureRendererKey.js",
  "packages/engine/Source/Renderer/WebGPU/WebGPUFeatureRenderers.ts",
  "packages/engine/Source/Widget/CesiumWidget.js",
]);

const DENSE_TIMING_SEMANTIC_SOURCE_FILES = Object.freeze([
  "packages/engine/Source/Core/GeographicTilingScheme.js",
  "packages/engine/Source/Core/HeightmapTerrainData.js",
  "packages/engine/Source/Core/TerrainProvider.js",
  "packages/engine/Source/Scene/AtmosphericConditions.js",
  "packages/engine/Source/Scene/CesiumDebug.js",
  "packages/engine/Source/Renderer/WebGPU/WebGPUContext.ts",
  "packages/engine/Source/Renderer/WebGPU/WebGPUPerformanceManager.ts",
  "packages/engine/Source/Renderer/WebGPU/WebGPUTimestampAccounting.ts",
  "packages/engine/Source/Renderer/WebGPU/WebGPUTimestampProfiler.ts",
]);

export const C12_29_S5_DENSE_RAW_GENERATED_PAIRS = Object.freeze([
  Object.freeze({
    raw: "packages/engine/Source/Shaders/GlobeFS.glsl",
    generated: "packages/engine/Source/Shaders/GlobeFS.js",
  }),
  Object.freeze({
    raw: "packages/engine/Source/Shaders/WebGPU/Globe/GlobeTerrain.wgsl",
    generated: "packages/engine/Source/Shaders/WebGPU/Globe/GlobeTerrain.js",
  }),
]);

export const C12_29_S5_DENSE_SOURCE_FILES = Object.freeze([
  ...new Set([
    ...C12_29_S5_DENSE_NASA_V5_SOURCE_FILES,
    ...DENSE_TIMING_SEMANTIC_SOURCE_FILES,
  ]),
]);

export const C12_29_S5_DENSE_SUPERSEDED_SOURCE_FILES = Object.freeze([
  ...new Set([
    ...TERRAIN_V8_SEMANTIC_SOURCE_FILES,
    ...DENSE_TIMING_SEMANTIC_SOURCE_FILES,
  ]),
]);

// Raw GLSL/WGSL do not occur in the JavaScript bundle's sourcesContent. Their
// generated module is source-map checked and the raw/generated text equality
// is proved independently by the probe.
export const C12_29_S5_DENSE_BUILD_SOURCE_FILES = Object.freeze(
  C12_29_S5_DENSE_SOURCE_FILES.filter(
    (file) => !file.endsWith(".glsl") && !file.endsWith(".wgsl"),
  ),
);

export const C12_29_S5_DENSE_SUPERSEDED_BUILD_SOURCE_FILES = Object.freeze(
  C12_29_S5_DENSE_SUPERSEDED_SOURCE_FILES.filter(
    (file) => !file.endsWith(".glsl") && !file.endsWith(".wgsl"),
  ),
);

const C12_29_S5_DENSE_LOCAL_FILE_PREFIX = Object.freeze([
  "Tools/visual-regression/performance-workloads-s5-dense-cost.json",
  "Tools/visual-regression/lib/c12-29-s5-dense-cost-gate.mjs",
  "Tools/visual-regression/c12-29-s5-dense-cost-gate.spec.mjs",
  "Tools/visual-regression/probe-c12-29-s5-dense-cost.mjs",
  "Tools/visual-regression/lib/build-source-identity.mjs",
  "Tools/visual-regression/lib/representative-performance-content.mjs",
  "Apps/CesiumViewer/index.html",
  "Apps/CesiumViewer/CesiumViewer.js",
  "Apps/CesiumViewer/CesiumViewerStartupOptions.js",
  "Apps/CesiumViewer/CesiumViewerDevUi.js",
  "Apps/CesiumViewer/CesiumViewerStartMode.js",
  "Apps/CesiumViewer/CesiumViewerLoadingIndicator.js",
  "Apps/CesiumViewer/CesiumViewer.css",
  ...WIDGET_CSS,
]);

const C12_29_S5_DENSE_LOCAL_FILE_SUFFIX = Object.freeze([
  "Build/CesiumUnminified/index.js",
  "Build/CesiumUnminified/index.js.map",
  "Build/CesiumUnminified/Assets/IAU2006_XYS/IAU2006_XYS_18.json",
  "Build/CesiumUnminified/Assets/Textures/SkyBox/tycho2t5_80_diffuse_px.jpg",
  "Build/CesiumUnminified/Assets/Textures/SkyBox/tycho2t5_80_diffuse_mx.jpg",
  "Build/CesiumUnminified/Assets/Textures/SkyBox/tycho2t5_80_diffuse_py.jpg",
  "Build/CesiumUnminified/Assets/Textures/SkyBox/tycho2t5_80_diffuse_my.jpg",
  "Build/CesiumUnminified/Assets/Textures/SkyBox/tycho2t5_80_diffuse_pz.jpg",
  "Build/CesiumUnminified/Assets/Textures/SkyBox/tycho2t5_80_diffuse_mz.jpg",
  "Build/CesiumUnminified/Assets/Textures/Moon/lroc_color_poles_2k.jpg",
  "Build/CesiumUnminified/Assets/Textures/Moon/ldem_normal_1k.png",
  "Build/CesiumUnminified/Assets/Textures/waterNormalsSmall.jpg",
  "package.json",
  "package-lock.json",
  "node_modules/playwright/package.json",
  "node_modules/playwright/index.mjs",
  "node_modules/playwright-core/package.json",
  "node_modules/playwright-core/index.mjs",
]);

const denseLocalFilesForSourceFiles = (sourceFiles) =>
  Object.freeze([
    ...C12_29_S5_DENSE_LOCAL_FILE_PREFIX,
    ...sourceFiles,
    ...C12_29_S5_DENSE_LOCAL_FILE_SUFFIX,
  ]);

export const C12_29_S5_DENSE_LOCAL_FILES = denseLocalFilesForSourceFiles(
  C12_29_S5_DENSE_SOURCE_FILES,
);

export const C12_29_S5_DENSE_SUPERSEDED_LOCAL_FILES =
  denseLocalFilesForSourceFiles(C12_29_S5_DENSE_SUPERSEDED_SOURCE_FILES);

export const C12_29_S5_DENSE_SERVED_FILES = Object.freeze([
  "Tools/visual-regression/performance-workloads-s5-dense-cost.json",
  "Tools/visual-regression/lib/c12-29-s5-dense-cost-gate.mjs",
  "Apps/CesiumViewer/index.html",
  "Apps/CesiumViewer/CesiumViewer.js",
  "Apps/CesiumViewer/CesiumViewerStartupOptions.js",
  "Apps/CesiumViewer/CesiumViewerDevUi.js",
  "Apps/CesiumViewer/CesiumViewerStartMode.js",
  "Apps/CesiumViewer/CesiumViewerLoadingIndicator.js",
  "Apps/CesiumViewer/CesiumViewer.css",
  ...WIDGET_CSS,
  "Build/CesiumUnminified/index.js",
  "Build/CesiumUnminified/Assets/IAU2006_XYS/IAU2006_XYS_18.json",
  "Build/CesiumUnminified/Assets/Textures/SkyBox/tycho2t5_80_diffuse_px.jpg",
  "Build/CesiumUnminified/Assets/Textures/SkyBox/tycho2t5_80_diffuse_mx.jpg",
  "Build/CesiumUnminified/Assets/Textures/SkyBox/tycho2t5_80_diffuse_py.jpg",
  "Build/CesiumUnminified/Assets/Textures/SkyBox/tycho2t5_80_diffuse_my.jpg",
  "Build/CesiumUnminified/Assets/Textures/SkyBox/tycho2t5_80_diffuse_pz.jpg",
  "Build/CesiumUnminified/Assets/Textures/SkyBox/tycho2t5_80_diffuse_mz.jpg",
  "Build/CesiumUnminified/Assets/Textures/Moon/lroc_color_poles_2k.jpg",
  "Build/CesiumUnminified/Assets/Textures/Moon/ldem_normal_1k.png",
  "Build/CesiumUnminified/Assets/Textures/waterNormalsSmall.jpg",
]);

const isObject = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const finite = (value) => Number.isFinite(value);
const nonNegativeInteger = (value) => Number.isInteger(value) && value >= 0;
const positiveInteger = (value) => Number.isInteger(value) && value > 0;
const exactKeys = (value, keys) =>
  isObject(value) &&
  Object.keys(value).sort().join("\u0000") === [...keys].sort().join("\u0000");
const sameJson = (left, right) =>
  stableC1229S5DenseJson(left) === stableC1229S5DenseJson(right);

function canonicalIsoMilliseconds(value) {
  if (typeof value !== "string") return null;
  const milliseconds = Date.parse(value);
  if (!finite(milliseconds)) return null;
  try {
    return new Date(milliseconds).toISOString() === value ? milliseconds : null;
  } catch {
    return null;
  }
}

function deriveDenseGpuIdentityComplete(renderer, rendererEvidence) {
  if (
    !exactKeys(rendererEvidence, [
      "requested",
      "actual",
      "rendererString",
      "adapterInfo",
      "gpuIdentityComplete",
    ]) ||
    typeof rendererEvidence.rendererString !== "string"
  ) {
    return false;
  }
  if (renderer === "webgl") {
    return rendererEvidence.rendererString.trim().length > 0;
  }
  if (renderer !== "webgpu") return false;
  const adapterInfo = rendererEvidence.adapterInfo;
  const keys = ["vendor", "architecture", "device", "description"];
  return (
    exactKeys(adapterInfo, keys) &&
    keys.every((key) => typeof adapterInfo[key] === "string") &&
    keys.some((key) => adapterInfo[key].trim().length > 0)
  );
}

function validateIdentityList(actual, expectedPaths, label) {
  const reasons = [];
  if (!Array.isArray(actual) || actual.length !== expectedPaths.length) {
    return [
      `${label} identity list does not have ${expectedPaths.length} entries`,
    ];
  }
  if (
    new Set(actual.map((identity) => identity?.path)).size !== actual.length
  ) {
    reasons.push(`${label} identity paths are not unique`);
  }
  for (let index = 0; index < expectedPaths.length; index++) {
    const identity = actual[index];
    if (
      identity?.path !== expectedPaths[index] ||
      !positiveInteger(identity?.byteLength) ||
      !/^[0-9a-f]{64}$/i.test(identity?.sha256 ?? "")
    ) {
      reasons.push(`${label} identity ${index} differs`);
      break;
    }
  }
  return reasons;
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!isObject(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, stableValue(value[key])]),
  );
}

export function stableC1229S5DenseJson(value, space) {
  if (space !== undefined) {
    return JSON.stringify(stableValue(value), null, space);
  }
  return JSON.stringify(stableValue(value));
}

export function isC1229S5DenseUuidV4(value) {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value,
    )
  );
}

// The tolerant reader over the shared verdict-tier table: this gate resolves
// statuses read out of untrusted artifact and subprocess data, where an
// unreadable tier means the record cannot vouch for what it saw.
export { exitCodeForC1229S5DenseStatus };

export function c1229S5DenseLegId(leg) {
  return `r${String(leg.repetition).padStart(2, "0")}-${String(leg.withinRepetition).padStart(2, "0")}-${leg.renderer}-${leg.condition}`;
}

export function percentileC1229S5Dense(values, quantile) {
  if (
    !Array.isArray(values) ||
    values.length === 0 ||
    values.some((value) => !finite(value)) ||
    !finite(quantile) ||
    quantile < 0 ||
    quantile > 1
  ) {
    return null;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const position = (sorted.length - 1) * quantile;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  const fraction = position - lower;
  return sorted[lower] * (1 - fraction) + sorted[upper] * fraction;
}

export function summarizeC1229S5DenseSamples(values) {
  if (
    !Array.isArray(values) ||
    values.length === 0 ||
    values.some((value) => !finite(value))
  ) {
    return null;
  }
  const p50 = percentileC1229S5Dense(values, 0.5);
  const deviations = values.map((value) => Math.abs(value - p50));
  return {
    count: values.length,
    minimum: Math.min(...values),
    maximum: Math.max(...values),
    mean: values.reduce((sum, value) => sum + value, 0) / values.length,
    p50,
    p95: percentileC1229S5Dense(values, 0.95),
    p99: percentileC1229S5Dense(values, 0.99),
    mad: percentileC1229S5Dense(deviations, 0.5),
  };
}

/** Select only measured-window long tasks and clip the terminal boundary. */
export function selectC1229S5DenseLongTasks(
  entries,
  measurementStartMs,
  measurementEndMs,
) {
  if (
    !Array.isArray(entries) ||
    !finite(measurementStartMs) ||
    !finite(measurementEndMs) ||
    measurementEndMs <= measurementStartMs
  ) {
    return [];
  }
  return entries
    .filter((entry) => {
      const rawDuration = finite(entry?.rawDuration)
        ? entry.rawDuration
        : entry?.duration;
      return (
        finite(entry?.startTime) &&
        finite(rawDuration) &&
        rawDuration >= 0 &&
        entry.startTime >= measurementStartMs &&
        entry.startTime < measurementEndMs
      );
    })
    .sort((left, right) => left.startTime - right.startTime)
    .map((entry) => {
      const rawDuration = finite(entry.rawDuration)
        ? entry.rawDuration
        : entry.duration;
      return {
        startTime: entry.startTime,
        rawDuration,
        duration: Math.min(
          rawDuration,
          Math.max(0, measurementEndMs - entry.startTime),
        ),
      };
    });
}

export function sampleC1229S5DenseRoute(route, frameIndex, frameCount = 600) {
  if (
    !isObject(route) ||
    !Array.isArray(route.waypoints) ||
    route.waypoints.length !== 9 ||
    !nonNegativeInteger(frameIndex) ||
    !positiveInteger(frameCount) ||
    frameIndex >= frameCount
  ) {
    throw new Error("invalid dense route sample request");
  }
  const progress = frameCount === 1 ? 0 : frameIndex / (frameCount - 1);
  const scaled = progress * (route.waypoints.length - 1);
  const segmentIndex = Math.min(route.waypoints.length - 2, Math.floor(scaled));
  const local =
    segmentIndex === route.waypoints.length - 2 && progress === 1
      ? 1
      : scaled - segmentIndex;
  const start = route.waypoints[segmentIndex];
  const end = route.waypoints[segmentIndex + 1];
  const lerp = (a, b) => a + (b - a) * local;
  return {
    frameIndex,
    progress,
    segmentIndex,
    segmentProgress: local,
    longitude: lerp(start.longitude, end.longitude),
    latitude: lerp(start.latitude, end.latitude),
    height: lerp(start.height, end.height),
    heading: route.orientationDegrees.heading,
    pitch: route.orientationDegrees.pitch,
    roll: route.orientationDegrees.roll,
  };
}

export function deriveC1229S5DenseSentinel(route, level = 12) {
  if (
    !isObject(route) ||
    !Array.isArray(route.waypoints) ||
    route.waypoints.length !== C12_29_S5_DENSE_CONFIG.routeSegments + 1 ||
    !nonNegativeInteger(level)
  ) {
    throw new Error("invalid dense sentinel route");
  }
  const xTiles = 2 ** (level + 1);
  const yTiles = 2 ** level;
  const longitudes = route.waypoints.map((waypoint) => waypoint.longitude);
  const latitudes = route.waypoints.map((waypoint) => waypoint.latitude);
  if ([...longitudes, ...latitudes].some((value) => !finite(value))) {
    throw new Error("invalid dense sentinel route coordinates");
  }
  const routeBounds = {
    west: Math.min(...longitudes),
    south: Math.min(...latitudes),
    east: Math.max(...longitudes),
    north: Math.max(...latitudes),
  };
  const longitudeToX = (longitude) =>
    Math.floor(((longitude + 180) / 360) * xTiles);
  const latitudeToY = (latitude) =>
    Math.floor(((90 - latitude) / 180) * yTiles);
  const routeTileBounds = {
    minimumX: longitudeToX(routeBounds.west),
    maximumX: longitudeToX(routeBounds.east),
    minimumY: latitudeToY(routeBounds.north),
    maximumY: latitudeToY(routeBounds.south),
  };
  const routeColumns = routeTileBounds.maximumX - routeTileBounds.minimumX + 1;
  const routeRows = routeTileBounds.maximumY - routeTileBounds.minimumY + 1;
  if (
    routeColumns > C12_29_S5_DENSE_CONFIG.sentinelWidth ||
    routeRows > C12_29_S5_DENSE_CONFIG.sentinelHeight
  ) {
    throw new Error("dense route does not fit the frozen 8x8 L12 sentinel");
  }
  const missingColumns = C12_29_S5_DENSE_CONFIG.sentinelWidth - routeColumns;
  const missingRows = C12_29_S5_DENSE_CONFIG.sentinelHeight - routeRows;
  // Split padding symmetrically; an odd remainder is assigned east/south.
  const padding = {
    west: Math.floor(missingColumns / 2),
    east: Math.ceil(missingColumns / 2),
    north: Math.floor(missingRows / 2),
    south: Math.ceil(missingRows / 2),
  };
  const sentinelTileBounds = {
    minimumX: routeTileBounds.minimumX - padding.west,
    maximumX: routeTileBounds.maximumX + padding.east,
    minimumY: routeTileBounds.minimumY - padding.north,
    maximumY: routeTileBounds.maximumY + padding.south,
  };
  if (
    sentinelTileBounds.minimumX < 0 ||
    sentinelTileBounds.maximumX >= xTiles ||
    sentinelTileBounds.minimumY < 0 ||
    sentinelTileBounds.maximumY >= yTiles
  ) {
    throw new Error("dense sentinel crossed the tiling-scheme boundary");
  }
  const keys = [];
  for (
    let y = sentinelTileBounds.minimumY;
    y <= sentinelTileBounds.maximumY;
    y++
  ) {
    for (
      let x = sentinelTileBounds.minimumX;
      x <= sentinelTileBounds.maximumX;
      x++
    ) {
      keys.push(`${level}/${x}/${y}`);
    }
  }
  return {
    level,
    routeBounds,
    routeTileBounds,
    padding,
    sentinelTileBounds,
    keys,
  };
}

function compareSchedule(schedule) {
  return (
    Array.isArray(schedule) &&
    schedule.length === C12_29_S5_DENSE_SCHEDULE.length &&
    schedule.every((leg, index) =>
      sameJson(leg, C12_29_S5_DENSE_SCHEDULE[index]),
    )
  );
}

export function validateC1229S5DenseWorkload(workload) {
  const reasons = [];
  const config = C12_29_S5_DENSE_CONFIG;
  if (!isObject(workload))
    return { valid: false, reasons: ["workload is not an object"] };
  if (
    workload.schema !== C12_29_S5_DENSE_WORKLOAD_SCHEMA ||
    workload.schemaVersion !== 1
  ) {
    reasons.push("workload schema differs");
  }
  if (workload.id !== "c12-29-s5-dense-eclipse-active-inactive-cost-v1") {
    reasons.push("workload id differs");
  }
  if (
    workload.baseUrl !== "http://localhost:8080/Apps/CesiumViewer/index.html"
  ) {
    reasons.push("workload base URL differs");
  }
  if (workload.outputNamespace !== config.outputNamespace)
    reasons.push("output namespace differs");
  const protocol = workload.protocol;
  if (
    !isObject(protocol) ||
    protocol.browser !== "msedge" ||
    !sameJson(protocol.viewport, config.viewport) ||
    protocol.fixedClock !== config.fixedClock ||
    protocol.freshProcessPerLeg !== true ||
    protocol.refreshSemantics !== config.refreshSemantics ||
    protocol.measuredFrames !== config.measuredFrames ||
    protocol.routePrimeFramesPerCondition !== config.measuredFrames ||
    protocol.settleStableFrames !== config.settleStableFrames ||
    protocol.settleTimeoutMs !== config.settleTimeoutMs ||
    protocol.gpuReadbackTimeoutMs !== config.gpuReadbackTimeoutMs ||
    protocol.legTimeoutMs !== config.legTimeoutMs ||
    protocol.repetitions !== config.repetitions ||
    !sameJson(protocol.renderers, C12_29_S5_DENSE_RENDERERS) ||
    !sameJson(protocol.conditions, C12_29_S5_DENSE_CONDITIONS)
  ) {
    reasons.push("protocol differs");
  }
  const scene = workload.scene;
  if (
    !isObject(scene) ||
    scene.mode !== "3d" ||
    scene.offline !== true ||
    !sameJson(scene.anchor, config.anchor) ||
    scene.maximumScreenSpaceError !== config.maximumScreenSpaceError ||
    scene.tileCacheSize !== config.tileCacheSize ||
    scene.globeLighting !== true ||
    scene.retainDefaultGlobeFeatures !== true ||
    scene.requestRenderMode !== true ||
    scene.shouldAnimate !== false
  ) {
    reasons.push("scene contract differs");
  }
  const terrain = workload.terrain;
  if (
    !isObject(terrain) ||
    terrain.kind !== "deterministic-global-heightmap-water" ||
    terrain.tilingScheme !== "GeographicTilingScheme" ||
    terrain.heightmapWidth !== config.heightmapWidth ||
    terrain.waterMaskWidth !== config.waterMaskWidth ||
    terrain.waterMaskPattern !== config.waterMaskPattern ||
    terrain.waterMaskSha256 !== config.waterMaskSha256 ||
    terrain.maximumLevel !== config.maximumTerrainLevel ||
    terrain.tileCacheSize !== config.tileCacheSize ||
    terrain.sentinel?.level !== config.maximumTerrainLevel ||
    terrain.sentinel?.columns !== config.sentinelWidth ||
    terrain.sentinel?.rows !== config.sentinelHeight ||
    terrain.sentinel?.derivation !==
      "minimal route-bounds L12 tile envelope, symmetrically padded to 8x8 with an odd remainder assigned east/south"
  ) {
    reasons.push("terrain contract differs");
  }
  const route = workload.route;
  if (
    !isObject(route) ||
    route.id !== "greatest-eclipse-dense-eight-segment-v1" ||
    route.interpolation !== "linear-cartographic-segments" ||
    route.progressFormula !== "frameIndex/(measuredFrames-1)" ||
    route.closedGroundTrack !== true ||
    !sameJson(route.orientationDegrees, { heading: 0, pitch: -90, roll: 0 }) ||
    !Array.isArray(route.waypoints) ||
    route.waypoints.length !== config.routeSegments + 1
  ) {
    reasons.push("route contract differs");
  } else {
    const routeTuples = new Set();
    for (const waypoint of route.waypoints) {
      if (
        !exactKeys(waypoint, ["longitude", "latitude", "height"]) ||
        !finite(waypoint.longitude) ||
        !finite(waypoint.latitude) ||
        !finite(waypoint.height) ||
        waypoint.height < config.minimumHeightMeters ||
        waypoint.height > config.maximumHeightMeters ||
        Math.abs(waypoint.longitude - config.anchor.longitudeDegrees) > 0.121 ||
        Math.abs(waypoint.latitude - config.anchor.latitudeDegrees) > 0.121
      ) {
        reasons.push("route waypoint differs");
        break;
      }
      routeTuples.add(stableC1229S5DenseJson(waypoint));
    }
    if (routeTuples.size !== route.waypoints.length)
      reasons.push("route waypoints are not unique");
    const firstWaypoint = route.waypoints[0];
    const finalWaypoint = route.waypoints.at(-1);
    if (
      firstWaypoint.longitude !== finalWaypoint.longitude ||
      firstWaypoint.latitude !== finalWaypoint.latitude ||
      firstWaypoint.height === finalWaypoint.height
    ) {
      reasons.push(
        "route ground track is not closed with a unique terminal camera state",
      );
    }
    const samples = Array.from({ length: config.measuredFrames }, (_, index) =>
      sampleC1229S5DenseRoute(route, index, config.measuredFrames),
    );
    if (samples[0].progress !== 0 || samples.at(-1).progress !== 1)
      reasons.push("route does not span progress zero through one");
    if (
      new Set(
        samples.map((sample) =>
          stableC1229S5DenseJson([
            sample.longitude,
            sample.latitude,
            sample.height,
          ]),
        ),
      ).size !== config.measuredFrames
    ) {
      reasons.push("route camera states are not unique");
    }
    const segmentCounts = Array(config.routeSegments).fill(0);
    for (const sample of samples) segmentCounts[sample.segmentIndex]++;
    if (segmentCounts.some((count) => count < config.minimumFramesPerSegment))
      reasons.push("route segment coverage is too sparse");
    const derivedSentinel = deriveC1229S5DenseSentinel(
      route,
      config.maximumTerrainLevel,
    );
    const transcript = {
      routeBounds: derivedSentinel.routeBounds,
      routeTileBounds: derivedSentinel.routeTileBounds,
      padding: derivedSentinel.padding,
      sentinelTileBounds: derivedSentinel.sentinelTileBounds,
    };
    if (!sameJson(terrain?.sentinel?.transcript, transcript)) {
      reasons.push("route-bounds sentinel derivation transcript differs");
    }
  }
  if (
    !sameJson(workload.conditions?.active, {
      enableEclipse: true,
      enableEclipseGlobeShadow: true,
      requiredGateValues: [1, 2],
    }) ||
    !sameJson(workload.conditions?.inactive, {
      enableEclipse: true,
      enableEclipseGlobeShadow: false,
      requiredGateValues: [0],
      untimedCounterfactualRequiredGateValues: [1, 2],
    })
  ) {
    reasons.push("condition contract differs");
  }
  if (!compareSchedule(workload.schedule))
    reasons.push("fresh-process schedule differs");
  const validity = workload.validity;
  if (
    !isObject(validity) ||
    validity.cpuSampleCount !== config.measuredFrames ||
    validity.wallSampleCount !== config.measuredFrames ||
    validity.minimumFramesPerSegment !== config.minimumFramesPerSegment ||
    validity.maximumLongTaskShare !== config.maximumLongTaskShare ||
    validity.maximumWithinConditionP95SpreadRatio !==
      config.maximumP95SpreadRatio ||
    validity.webgpuTimestampAttemptCount !== config.webgpuTimestampAttempts ||
    validity.webgpuMinimumTimestampSamples !==
      config.webgpuMinimumTimestampSamples ||
    validity.webgpuMaximumTimestampSkipShare !==
      config.webgpuMaximumTimestampSkipShare ||
    validity.webglGpuTiming !== "not-applicable" ||
    validity.terrainActivityDuringMeasurement !== 0 ||
    validity.fillMeshesDuringMeasurement !== 0 ||
    !String(validity.conclusion ?? "").includes(
      "regardless of sign or magnitude",
    )
  ) {
    reasons.push("validity/conclusion contract differs");
  }
  return { valid: reasons.length === 0, reasons };
}

function deterministicHeight(longitude, latitude) {
  return (
    320 +
    95 * Math.sin(longitude * 17) * Math.cos(latitude * 19) +
    35 * Math.sin((longitude + latitude) * 37)
  );
}

export function createC1229S5DenseWaterMask(width = 16) {
  if (width !== C12_29_S5_DENSE_CONFIG.waterMaskWidth) {
    throw new Error("dense water-mask width differs");
  }
  const waterMask = new Uint8Array(width * width);
  for (let row = 0; row < width; row++) {
    for (let column = 0; column < width; column++) {
      waterMask[row * width + column] =
        (row * 3 + column * 5) % 11 < 5 ? 0 : 255;
    }
  }
  return waterMask;
}

/** Create the deterministic global 33x33 heightmap/water provider in-page. */
export function createC1229S5DenseTerrain(C, terrainConfig) {
  if (!C || !isObject(terrainConfig))
    throw new Error("Cesium and terrain config are required");
  const tilingScheme = new C.GeographicTilingScheme();
  const payloads = new Map();
  const issuedTerrainData = new WeakSet();
  const diagnostics = {
    requestCount: 0,
    generationCount: 0,
    cacheHitCount: 0,
    requestedKeys: new Set(),
    generatedKeys: new Set(),
  };
  const levelZeroError =
    C.TerrainProvider.getEstimatedLevelZeroGeometricErrorForAHeightmap(
      tilingScheme.ellipsoid,
      terrainConfig.heightmapWidth,
      tilingScheme.getNumberOfXTilesAtLevel(0),
    );
  const provider = {
    tilingScheme,
    errorEvent: new C.Event(),
    credit: undefined,
    hasWaterMask: true,
    hasVertexNormals: false,
    availability: undefined,
    requestTileGeometry(x, y, level) {
      diagnostics.requestCount++;
      const key = `${level}/${x}/${y}`;
      diagnostics.requestedKeys.add(key);
      let payload = payloads.get(key);
      if (payload) {
        diagnostics.cacheHitCount++;
      } else {
        const rectangle = tilingScheme.tileXYToRectangle(x, y, level);
        const width = terrainConfig.heightmapWidth;
        const buffer = new Float32Array(width * width);
        for (let row = 0; row < width; row++) {
          const latitude =
            rectangle.north +
            (rectangle.south - rectangle.north) * (row / (width - 1));
          for (let column = 0; column < width; column++) {
            const longitude =
              rectangle.west +
              (rectangle.east - rectangle.west) * (column / (width - 1));
            buffer[row * width + column] = deterministicHeight(
              longitude,
              latitude,
            );
          }
        }
        const waterMask = createC1229S5DenseWaterMask(
          terrainConfig.waterMaskWidth,
        );
        payload = { buffer, waterMask };
        payloads.set(key, payload);
        diagnostics.generationCount++;
        diagnostics.generatedKeys.add(key);
      }
      const data = new C.HeightmapTerrainData({
        buffer: payload.buffer.slice(),
        width: terrainConfig.heightmapWidth,
        height: terrainConfig.heightmapWidth,
        childTileMask: level < terrainConfig.maximumLevel ? 15 : 0,
        waterMask: payload.waterMask.slice(),
      });
      issuedTerrainData.add(data);
      return Promise.resolve(data);
    },
    getLevelMaximumGeometricError(level) {
      return level >= terrainConfig.maximumLevel
        ? 0
        : levelZeroError / 2 ** level;
    },
    getTileDataAvailable(x, y, level) {
      return level <= terrainConfig.maximumLevel;
    },
    loadTileDataAvailability() {
      return undefined;
    },
  };
  const snapshot = () => ({
    requestCount: diagnostics.requestCount,
    generationCount: diagnostics.generationCount,
    cacheHitCount: diagnostics.cacheHitCount,
    requestedKeys: [...diagnostics.requestedKeys].sort(),
    generatedKeys: [...diagnostics.generatedKeys].sort(),
    waterMaskWidth: terrainConfig.waterMaskWidth,
    waterMaskPattern: C12_29_S5_DENSE_CONFIG.waterMaskPattern,
    waterMaskSha256: C12_29_S5_DENSE_CONFIG.waterMaskSha256,
  });
  return {
    provider,
    ownsTerrainData: (value) => issuedTerrainData.has(value),
    snapshot,
  };
}

export function diffC1229S5DenseTerrainDiagnostics(start, end) {
  const startRequested = new Set(start?.requestedKeys ?? []);
  const startGenerated = new Set(start?.generatedKeys ?? []);
  return {
    requestCount: (end?.requestCount ?? 0) - (start?.requestCount ?? 0),
    generationCount:
      (end?.generationCount ?? 0) - (start?.generationCount ?? 0),
    cacheHitCount: (end?.cacheHitCount ?? 0) - (start?.cacheHitCount ?? 0),
    requestedKeys: (end?.requestedKeys ?? []).filter(
      (key) => !startRequested.has(key),
    ),
    generatedKeys: (end?.generatedKeys ?? []).filter(
      (key) => !startGenerated.has(key),
    ),
  };
}

export function inspectC1229S5DenseTerrainFrame(scene, terrain) {
  const selected = scene?.globe?._surface?._tilesToRender ?? [];
  const selectedKeys = [];
  const realMeshKeys = [];
  const ownRealMeshKeys = [];
  const fillMeshKeys = [];
  const foreignTerrainKeys = [];
  for (const tile of selected) {
    if (
      !nonNegativeInteger(tile?.level) ||
      !nonNegativeInteger(tile?.x) ||
      !nonNegativeInteger(tile?.y)
    )
      continue;
    const key = `${tile.level}/${tile.x}/${tile.y}`;
    selectedKeys.push(key);
    const surface = tile.data;
    const realMesh = surface?.mesh ?? null;
    const renderedMesh = surface?.renderedMesh ?? null;
    const fillMesh = surface?.fill?.mesh ?? null;
    if (realMesh && renderedMesh === realMesh) realMeshKeys.push(key);
    if (fillMesh && renderedMesh === fillMesh) fillMeshKeys.push(key);
    if (
      realMesh &&
      renderedMesh === realMesh &&
      terrain.ownsTerrainData(surface?.terrainData)
    )
      ownRealMeshKeys.push(key);
    if (surface?.terrainData && !terrain.ownsTerrainData(surface.terrainData))
      foreignTerrainKeys.push(key);
  }
  const sortUnique = (values) => [...new Set(values)].sort();
  const gate = scene?.frameState?.eclipseGlobeShadow?.params?.x;
  const traceCommandList = scene?.frameState?.commandList ?? [];
  return {
    selectedKeys: sortUnique(selectedKeys),
    realMeshKeys: sortUnique(realMeshKeys),
    ownRealMeshKeys: sortUnique(ownRealMeshKeys),
    fillMeshKeys: sortUnique(fillMeshKeys),
    foreignTerrainKeys: sortUnique(foreignTerrainKeys),
    selectedCount: selected.length,
    realMeshCount: realMeshKeys.length,
    ownRealMeshCount: ownRealMeshKeys.length,
    fillMeshCount: fillMeshKeys.length,
    gate: finite(gate) ? gate : null,
    logicalDrawCount: realMeshKeys.length + fillMeshKeys.length,
    commandCount: traceCommandList.length,
  };
}

function validatePrerequisite(value, expected, publicationSchema, label) {
  const reasons = [];
  if (
    !isObject(value) ||
    value.kind !== label ||
    value.producer !== expected.producer
  ) {
    return [`${label} prerequisite identity differs`];
  }
  const publication = value.publication;
  const artifact = value.artifact;
  if (
    !exactKeys(publication, [
      "path",
      "schema",
      "runId",
      "status",
      "exitCode",
      "certificationEligible",
      "byteLength",
      "sha256",
    ]) ||
    publication.schema !== publicationSchema ||
    !isC1229S5DenseUuidV4(publication.runId) ||
    publication.status !== "PASS" ||
    publication.exitCode !== 0 ||
    publication.certificationEligible !== true ||
    !positiveInteger(publication.byteLength) ||
    !/^[0-9a-f]{64}$/i.test(publication.sha256 ?? "") ||
    typeof publication.path !== "string" ||
    publication.path.length === 0
  ) {
    reasons.push(
      `${label} publication manifest identity is not an immutable PASS`,
    );
  }
  if (
    !exactKeys(artifact, [
      "path",
      "name",
      "schema",
      "runId",
      "status",
      "incomplete",
      "exitCode",
      "byteLength",
      "sha256",
    ]) ||
    artifact.schema !== expected.schema ||
    artifact.runId !== publication?.runId ||
    artifact.status !== "PASS" ||
    artifact.incomplete !== false ||
    artifact.exitCode !== 0 ||
    !positiveInteger(artifact.byteLength) ||
    !/^[0-9a-f]{64}$/i.test(artifact.sha256 ?? "") ||
    typeof artifact.path !== "string" ||
    typeof artifact.name !== "string" ||
    !artifact.name.includes(artifact.runId) ||
    !artifact.name.endsWith(".json")
  ) {
    reasons.push(`${label} artifact identity is not an immutable PASS`);
  }
  return reasons;
}

function validateDensePrerequisites(value, expected) {
  if (!exactKeys(value, ["terrain", "nasa"])) {
    return { valid: false, reasons: ["prerequisite set shape differs"] };
  }
  const reasons = [
    ...validatePrerequisite(
      value.terrain,
      expected.terrain,
      expected.publicationSchema,
      "terrain",
    ),
    ...validatePrerequisite(
      value.nasa,
      expected.nasa,
      expected.publicationSchema,
      "nasa",
    ),
  ];
  if (value.terrain?.artifact?.runId === value.nasa?.artifact?.runId) {
    reasons.push("prerequisite run identities collide");
  }
  return { valid: reasons.length === 0, reasons };
}

export function validateC1229S5DensePrerequisites(value) {
  return validateDensePrerequisites(value, C12_29_S5_DENSE_PREREQUISITES);
}

function routeEvidenceReasons(routeEvidence, workload, label) {
  const reasons = [];
  const count = C12_29_S5_DENSE_CONFIG.measuredFrames;
  if (!Array.isArray(routeEvidence) || routeEvidence.length !== count) {
    return [`${label} route evidence does not contain ${count} frames`];
  }
  const actualKeys = new Set();
  const segmentCounts = Array(C12_29_S5_DENSE_CONFIG.routeSegments).fill(0);
  for (let index = 0; index < count; index++) {
    const observed = routeEvidence[index];
    const expected = sampleC1229S5DenseRoute(workload.route, index, count);
    if (
      !isObject(observed) ||
      observed.frameIndex !== index ||
      observed.progress !== expected.progress ||
      observed.segmentIndex !== expected.segmentIndex ||
      observed.segmentProgress !== expected.segmentProgress ||
      observed.longitude !== expected.longitude ||
      observed.latitude !== expected.latitude ||
      observed.height !== expected.height ||
      observed.heading !== expected.heading ||
      observed.pitch !== expected.pitch ||
      observed.roll !== expected.roll ||
      !isObject(observed.actual) ||
      !exactKeys(observed.actual, [
        "longitude",
        "latitude",
        "height",
        "heading",
        "pitch",
        "roll",
      ]) ||
      !finite(observed.actual.longitude) ||
      !finite(observed.actual.latitude) ||
      !finite(observed.actual.height) ||
      !finite(observed.actual.heading) ||
      !finite(observed.actual.pitch) ||
      !finite(observed.actual.roll) ||
      Math.abs(observed.actual.longitude - expected.longitude) > 1e-9 ||
      Math.abs(observed.actual.latitude - expected.latitude) > 1e-9 ||
      Math.abs(observed.actual.height - expected.height) > 1e-4 ||
      Math.abs(observed.actual.heading - expected.heading) > 1e-9 ||
      Math.abs(observed.actual.pitch - expected.pitch) > 1e-9 ||
      Math.abs(observed.actual.roll - expected.roll) > 1e-9
    ) {
      reasons.push(`${label} route frame ${index} differs`);
      break;
    }
    actualKeys.add(stableC1229S5DenseJson(observed.actual));
    segmentCounts[observed.segmentIndex]++;
  }
  if (
    routeEvidence[0]?.progress !== 0 ||
    routeEvidence.at(-1)?.progress !== 1
  ) {
    reasons.push(`${label} route does not span exact progress 0 through 1`);
  }
  if (actualKeys.size !== count)
    reasons.push(`${label} route camera states are not unique`);
  if (
    segmentCounts.some(
      (value) => value < C12_29_S5_DENSE_CONFIG.minimumFramesPerSegment,
    )
  ) {
    reasons.push(`${label} route segment coverage is too sparse`);
  }
  return reasons;
}

function terrainFrameReasons(frames, condition, sentinelKeys, label) {
  const reasons = [];
  const expectedGates = condition === "active" ? [1, 2] : [0];
  if (
    !Array.isArray(frames) ||
    frames.length !== C12_29_S5_DENSE_CONFIG.measuredFrames
  ) {
    return [`${label} terrain evidence does not contain 600 frames`];
  }
  const sentinel = new Set(sentinelKeys);
  const sentinelSeen = new Set();
  for (let index = 0; index < frames.length; index++) {
    const frame = frames[index];
    if (
      !isObject(frame) ||
      frame.frameIndex !== index ||
      !Array.isArray(frame.selectedKeys) ||
      !Array.isArray(frame.realMeshKeys) ||
      !Array.isArray(frame.ownRealMeshKeys) ||
      !Array.isArray(frame.fillMeshKeys) ||
      !Array.isArray(frame.foreignTerrainKeys) ||
      frame.fillMeshKeys.length !== 0 ||
      frame.fillMeshCount !== 0 ||
      frame.foreignTerrainKeys.length !== 0 ||
      frame.selectedKeys.length === 0 ||
      !sameJson(frame.selectedKeys, frame.realMeshKeys) ||
      !sameJson(frame.realMeshKeys, frame.ownRealMeshKeys) ||
      frame.selectedCount !== frame.selectedKeys.length ||
      frame.realMeshCount !== frame.realMeshKeys.length ||
      frame.ownRealMeshCount !== frame.ownRealMeshKeys.length ||
      frame.logicalDrawCount !== frame.realMeshKeys.length ||
      !nonNegativeInteger(frame.commandCount) ||
      !expectedGates.includes(frame.gate)
    ) {
      reasons.push(`${label} terrain frame ${index} differs`);
      break;
    }
    for (const key of frame.ownRealMeshKeys) {
      if (sentinel.has(key)) sentinelSeen.add(key);
    }
  }
  if (!sameJson([...sentinelSeen].sort(), [...sentinelKeys].sort())) {
    reasons.push(`${label} did not render all 64 own-real L12 sentinel meshes`);
  }
  return reasons;
}

function traceReasons(trace, frames, label, requireWallSamples = false) {
  const reasons = [];
  if (
    !isObject(trace) ||
    !Array.isArray(trace.samples) ||
    trace.samples.length !== C12_29_S5_DENSE_CONFIG.measuredFrames
  ) {
    return [`${label} trace does not contain 600 samples`];
  }
  const frameNumbers = new Set();
  for (let index = 0; index < trace.samples.length; index++) {
    const sample = trace.samples[index];
    if (
      !isObject(sample) ||
      !exactKeys(sample, [
        "frameNumber",
        "relFrame",
        "wallDtMs",
        "cpuMs",
        "drawCount",
        "commandCount",
        "snapshotFrozen",
      ]) ||
      !positiveInteger(sample.frameNumber) ||
      sample.relFrame !== index ||
      (requireWallSamples
        ? !finite(sample.wallDtMs) || sample.wallDtMs <= 0
        : !(
            sample.wallDtMs === null ||
            (finite(sample.wallDtMs) && sample.wallDtMs >= 0)
          )) ||
      !finite(sample.cpuMs) ||
      sample.cpuMs < 0 ||
      !nonNegativeInteger(sample.drawCount) ||
      !nonNegativeInteger(sample.commandCount) ||
      sample.commandCount !== frames[index]?.commandCount ||
      sample.snapshotFrozen !== false
    ) {
      reasons.push(`${label} trace sample ${index} differs`);
      break;
    }
    frameNumbers.add(sample.frameNumber);
  }
  if (frameNumbers.size !== trace.samples.length) {
    reasons.push(`${label} trace frame numbers are not unique`);
  }
  const firstFrameNumber = trace.samples[0]?.frameNumber;
  if (
    !positiveInteger(firstFrameNumber) ||
    trace.samples.some(
      (sample, index) => sample?.frameNumber !== firstFrameNumber + index,
    )
  ) {
    reasons.push(`${label} trace frame numbers are not consecutive`);
  }
  return reasons;
}

function sameTimedReplayWork(measurement, replay) {
  if (
    !Array.isArray(measurement?.route) ||
    !Array.isArray(replay?.route) ||
    !Array.isArray(measurement?.frames) ||
    !Array.isArray(replay?.frames) ||
    !Array.isArray(measurement?.trace?.samples) ||
    !Array.isArray(replay?.trace?.samples) ||
    measurement.route.length !== replay.route.length ||
    measurement.frames.length !== replay.frames.length ||
    measurement.trace.samples.length !== replay.trace.samples.length
  ) {
    return false;
  }
  for (let index = 0; index < measurement.route.length; index++) {
    if (!sameJson(measurement.route[index], replay.route[index])) return false;
    const work = (frame) => ({
      selectedKeys: frame.selectedKeys,
      realMeshKeys: frame.realMeshKeys,
      ownRealMeshKeys: frame.ownRealMeshKeys,
      fillMeshKeys: frame.fillMeshKeys,
      foreignTerrainKeys: frame.foreignTerrainKeys,
      selectedCount: frame.selectedCount,
      realMeshCount: frame.realMeshCount,
      ownRealMeshCount: frame.ownRealMeshCount,
      fillMeshCount: frame.fillMeshCount,
      logicalDrawCount: frame.logicalDrawCount,
      commandCount: frame.commandCount,
    });
    if (!sameJson(work(measurement.frames[index]), work(replay.frames[index])))
      return false;
    const timedTrace = measurement.trace.samples[index];
    const replayTrace = replay.trace.samples[index];
    if (
      timedTrace.drawCount !== replayTrace.drawCount ||
      timedTrace.commandCount !== replayTrace.commandCount
    ) {
      return false;
    }
  }
  return true;
}

function gpuReasons(gpu, renderer) {
  const reasons = [];
  if (renderer === "webgl") {
    if (
      !exactKeys(gpu, [
        "applicability",
        "reason",
        "attemptedFrameCount",
        "samples",
      ]) ||
      gpu.applicability !== "N/A" ||
      gpu.reason !== "WebGL has no WebGPU timestamp-query lane" ||
      gpu.attemptedFrameCount !== 0 ||
      !Array.isArray(gpu.samples) ||
      gpu.samples.length !== 0
    ) {
      reasons.push("WebGL GPU evidence is not exact N/A");
    }
    return reasons;
  }
  const results = gpu?.results;
  const attempted = results?.attemptedFrameCount;
  const sampled = results?.frameCount;
  const skipped = results?.readbackSkipCount;
  const failed = results?.failedReadbackCount;
  const lost = results?.lostSampleCount;
  const pending = results?.pendingReadbackCount;
  const empty = results?.emptyFrameCount;
  const ledgerValues = [
    attempted,
    sampled,
    skipped,
    failed,
    lost,
    pending,
    empty,
  ];
  const ledgerBalanced =
    ledgerValues.every(nonNegativeInteger) &&
    attempted === sampled + skipped + failed + lost + pending + empty;
  if (
    !isObject(gpu) ||
    gpu.applicability !== "mandatory" ||
    gpu.timestampFeatureAvailable !== true ||
    gpu.armed !== true ||
    gpu.fullFrameOnly !== true ||
    gpu.wrapper?.installed !== true ||
    gpu.wrapper?.restored !== true ||
    gpu.wrapper?.originalIdentityRestored !== true ||
    !Array.isArray(gpu.samples) ||
    !isObject(results) ||
    results.enabled !== true ||
    results.attemptedFrameCount !==
      C12_29_S5_DENSE_CONFIG.webgpuTimestampAttempts ||
    results.frameCount < C12_29_S5_DENSE_CONFIG.webgpuMinimumTimestampSamples ||
    gpu.samples.length !== results.frameCount ||
    gpu.samples.some((sample) => !finite(sample) || sample < 0) ||
    results.readbackSkipCount / results.attemptedFrameCount >
      C12_29_S5_DENSE_CONFIG.webgpuMaximumTimestampSkipShare ||
    results.failedReadbackCount !== 0 ||
    results.lostSampleCount !== 0 ||
    results.pendingReadbackCount !== 0 ||
    results.unaccountedSampleCount !== 0 ||
    results.invertedSampleCount !== 0 ||
    results.droppedPassCount !== 0 ||
    results.emptyFrameCount !== 0 ||
    results.sampleLedgerBalanced !== true ||
    ledgerBalanced !== true ||
    results.unaccountedSampleCount !== 0 ||
    !exactKeys(gpu.drain, ["drained", "undrained", "abandoned", "timedOut"]) ||
    !nonNegativeInteger(gpu.drain.drained) ||
    !nonNegativeInteger(gpu.drain.undrained) ||
    !nonNegativeInteger(gpu.drain.abandoned) ||
    gpu.drain.abandoned !== 0 ||
    gpu.drain?.timedOut !== false ||
    gpu.drain?.undrained !== 0 ||
    gpu.drain?.abandoned !== 0 ||
    !sameJson(gpu.summary, summarizeC1229S5DenseSamples(gpu.samples))
  ) {
    reasons.push("WebGPU timestamp evidence is incomplete or unbalanced");
  }
  return reasons;
}

function qualityReasons(measurement) {
  const reasons = [];
  const cpu = measurement?.trace?.samples?.map((sample) => sample.cpuMs) ?? [];
  const wall =
    measurement?.trace?.samples?.map((sample) => sample.wallDtMs) ?? [];
  if (
    measurement?.frameCount !== C12_29_S5_DENSE_CONFIG.measuredFrames ||
    cpu.length !== C12_29_S5_DENSE_CONFIG.measuredFrames ||
    !sameJson(measurement?.cpuSummary, summarizeC1229S5DenseSamples(cpu))
  ) {
    reasons.push("CPU summary does not recompute from exactly 600 samples");
  }
  const wallSummary = summarizeC1229S5DenseSamples(wall);
  const wallElapsedMs = wall.reduce((sum, value) => sum + value, 0);
  if (
    wall.length !== C12_29_S5_DENSE_CONFIG.measuredFrames ||
    wall.some((value) => !finite(value) || value <= 0) ||
    measurement?.framePacing?.semantics !==
      C12_29_S5_DENSE_CONFIG.refreshSemantics ||
    measurement?.framePacing?.requestAnimationFrameYieldCount !==
      C12_29_S5_DENSE_CONFIG.measuredFrames ||
    measurement?.framePacing?.elapsedMs !== wallElapsedMs ||
    !sameJson(measurement?.framePacing?.wallSummary, wallSummary)
  ) {
    reasons.push(
      "refresh-paced wall evidence does not recompute from 600 yields",
    );
  }
  const longTasks = measurement?.longTasks;
  const selectedLongTasks = selectC1229S5DenseLongTasks(
    longTasks?.entries,
    longTasks?.measurementStartMs,
    longTasks?.measurementEndMs,
  );
  const longTaskDuration = selectedLongTasks.reduce(
    (sum, entry) => sum + entry.duration,
    0,
  );
  const duration = longTasks?.measurementEndMs - longTasks?.measurementStartMs;
  const entriesDoNotOverlap = selectedLongTasks.every(
    (entry, index) =>
      index === 0 ||
      entry.startTime >=
        selectedLongTasks[index - 1].startTime +
          selectedLongTasks[index - 1].duration,
  );
  if (
    longTasks?.observerAvailable !== true ||
    !finite(longTasks?.measurementStartMs) ||
    !finite(longTasks?.measurementEndMs) ||
    duration <= 0 ||
    longTasks?.measurementDurationMs !== duration ||
    Math.abs(duration - wallElapsedMs) > 1e-6 ||
    !sameJson(longTasks?.entries, selectedLongTasks) ||
    entriesDoNotOverlap !== true ||
    longTasks?.totalDurationMs !== longTaskDuration ||
    longTasks?.share !== longTaskDuration / duration ||
    longTasks?.share > C12_29_S5_DENSE_CONFIG.maximumLongTaskShare
  ) {
    reasons.push("long-task share is invalid");
  }
  const terrainActivity = measurement?.terrainActivity;
  const terrainSnapshotReasons = (snapshot, label) => {
    if (
      !exactKeys(snapshot, [
        "requestCount",
        "generationCount",
        "cacheHitCount",
        "requestedKeys",
        "generatedKeys",
        "waterMaskWidth",
        "waterMaskPattern",
        "waterMaskSha256",
      ]) ||
      !nonNegativeInteger(snapshot.requestCount) ||
      !nonNegativeInteger(snapshot.generationCount) ||
      !nonNegativeInteger(snapshot.cacheHitCount) ||
      !Array.isArray(snapshot.requestedKeys) ||
      snapshot.requestedKeys.some((key) => typeof key !== "string") ||
      !Array.isArray(snapshot.generatedKeys) ||
      snapshot.generatedKeys.some((key) => typeof key !== "string") ||
      !sameJson(
        snapshot.requestedKeys,
        [...new Set(snapshot.requestedKeys)].sort(),
      ) ||
      !sameJson(
        snapshot.generatedKeys,
        [...new Set(snapshot.generatedKeys)].sort(),
      ) ||
      snapshot.requestCount !==
        snapshot.generationCount + snapshot.cacheHitCount ||
      snapshot.generationCount !== snapshot.generatedKeys.length ||
      snapshot.generatedKeys.some(
        (key) => !snapshot.requestedKeys.includes(key),
      ) ||
      snapshot.waterMaskWidth !== C12_29_S5_DENSE_CONFIG.waterMaskWidth ||
      snapshot.waterMaskPattern !== C12_29_S5_DENSE_CONFIG.waterMaskPattern ||
      snapshot.waterMaskSha256 !== C12_29_S5_DENSE_CONFIG.waterMaskSha256
    ) {
      return [`${label} terrain snapshot differs`];
    }
    return [];
  };
  reasons.push(
    ...terrainSnapshotReasons(terrainActivity?.start, "start"),
    ...terrainSnapshotReasons(terrainActivity?.end, "end"),
  );
  if (
    terrainActivity?.start?.requestedKeys?.some(
      (key) => !terrainActivity?.end?.requestedKeys?.includes(key),
    ) ||
    terrainActivity?.start?.generatedKeys?.some(
      (key) => !terrainActivity?.end?.generatedKeys?.includes(key),
    )
  ) {
    reasons.push("terrain cumulative key sets regressed");
  }
  const recomputedDelta = diffC1229S5DenseTerrainDiagnostics(
    terrainActivity?.start,
    terrainActivity?.end,
  );
  const delta = terrainActivity?.delta;
  if (
    !sameJson(delta, recomputedDelta) ||
    delta?.requestCount !== 0 ||
    delta?.generationCount !== 0 ||
    delta?.cacheHitCount !== 0 ||
    !sameJson(delta?.requestedKeys, []) ||
    !sameJson(delta?.generatedKeys, [])
  ) {
    reasons.push("terrain activity occurred inside the measured window");
  }
  return reasons;
}

function defaultFeatureSnapshotReasons(snapshot) {
  const keys = [
    "highDynamicRange",
    "sunBloom",
    "taaEnabled",
    "motionBlur",
    "msaaSamples",
    "fogEnabled",
    "skyAtmosphereShown",
    "skyBoxShown",
    "sunShown",
    "moonShown",
    "globeShown",
    "groundAtmosphereShown",
    "waterEffectShown",
    "imageryLayerCount",
    "postProcessStageCount",
    "fxaaEnabled",
    "bloomEnabled",
  ];
  if (!exactKeys(snapshot, keys))
    return ["default feature snapshot shape differs"];
  if (
    typeof snapshot.highDynamicRange !== "boolean" ||
    snapshot.sunBloom !== true ||
    snapshot.taaEnabled !== false ||
    snapshot.motionBlur !== false ||
    snapshot.msaaSamples !== 4 ||
    snapshot.postProcessStageCount !== 0 ||
    snapshot.fxaaEnabled !== false ||
    snapshot.bloomEnabled !== false ||
    snapshot.fogEnabled !== true ||
    snapshot.skyAtmosphereShown !== true ||
    snapshot.skyBoxShown !== true ||
    snapshot.sunShown !== true ||
    snapshot.moonShown !== true ||
    snapshot.globeShown !== true ||
    snapshot.groundAtmosphereShown !== true ||
    snapshot.waterEffectShown !== true ||
    snapshot.imageryLayerCount !== 0
  ) {
    return [
      "default globe feature snapshot removed or changed a required lane",
    ];
  }
  return [];
}

/**
 * Validate one fresh-process runtime artifact. Reasons are split so the final
 * fold never turns malformed timing into a product regression.
 */
export function validateC1229S5DenseRuntimeLeg(leg, workload, context = {}) {
  const structural = [];
  const behavioral = [];
  const errors = [];
  const workloadValidation = validateC1229S5DenseWorkload(workload);
  if (!workloadValidation.valid) structural.push(...workloadValidation.reasons);
  const expected =
    C12_29_S5_DENSE_SCHEDULE[(leg?.scheduleLeg?.ordinal ?? 0) - 1];
  const startedAt = canonicalIsoMilliseconds(leg?.startedAt);
  const completedAt = canonicalIsoMilliseconds(leg?.completedAt);
  if (
    !isObject(leg) ||
    leg.schema !== C12_29_S5_DENSE_RUNTIME_SCHEMA ||
    !isC1229S5DenseUuidV4(leg.runId) ||
    typeof leg.legId !== "string" ||
    !sameJson(leg.scheduleLeg, expected) ||
    leg.legId !== c1229S5DenseLegId(expected ?? {}) ||
    leg.incomplete !== false ||
    !["PASS", "FAIL", "ERROR", "STRUCTURAL"].includes(leg.status)
  ) {
    structural.push("runtime leg envelope differs");
  }
  if (startedAt === null || completedAt === null || startedAt >= completedAt) {
    structural.push("runtime leg timestamp envelope differs");
  }
  if (leg?.status === "ERROR" || leg?.error)
    errors.push("runtime leg reported an error");
  if (leg?.status === "STRUCTURAL")
    structural.push("runtime leg reported STRUCTURAL");
  if (leg?.status === "FAIL") behavioral.push("runtime leg reported FAIL");
  if (
    !exactKeys(leg?.workloadIdentity, ["path", "byteLength", "sha256"]) ||
    leg.workloadIdentity.path !== C12_29_S5_DENSE_WORKLOAD_PATH ||
    leg.workloadIdentity.byteLength !==
      C12_29_S5_DENSE_CONFIG.workloadByteLength ||
    !/^[0-9a-f]{64}$/i.test(leg.workloadIdentity.sha256 ?? "")
  ) {
    structural.push("runtime leg workload identity differs");
  }
  const gpuIdentityComplete = deriveDenseGpuIdentityComplete(
    expected?.renderer,
    leg?.renderer,
  );
  if (
    context.runId !== undefined &&
    (leg.runId !== context.runId ||
      leg.sourceIdentitySha256 !== context.sourceIdentitySha256 ||
      leg.prerequisitesSha256 !== context.prerequisitesSha256 ||
      leg.workloadIdentity?.sha256 !== context.workloadSha256)
  ) {
    structural.push("runtime leg input closure differs");
  }
  if (context.requireSubprocess === true) {
    const subprocess = leg?.subprocess;
    if (
      !isObject(subprocess) ||
      !exactKeys(subprocess, [
        "exitCode",
        "signal",
        "timedOut",
        "childProcessId",
        "launchId",
      ]) ||
      subprocess.exitCode !== exitCodeForC1229S5DenseStatus(leg?.status) ||
      subprocess.signal !== null ||
      subprocess.timedOut !== false ||
      !positiveInteger(subprocess.childProcessId) ||
      !isC1229S5DenseUuidV4(subprocess.launchId)
    ) {
      structural.push("fresh leg subprocess identity or exit differs");
    }
  }
  if (
    leg?.browser?.channel !== "msedge" ||
    !sameJson(leg?.browser?.viewport, C12_29_S5_DENSE_CONFIG.viewport) ||
    typeof leg?.browser?.version !== "string" ||
    leg.browser.version.length === 0 ||
    typeof leg?.browser?.userAgent !== "string" ||
    leg.browser.userAgent.length === 0 ||
    leg?.renderer?.requested !== expected?.renderer ||
    leg?.renderer?.actual !== expected?.renderer ||
    gpuIdentityComplete !== true ||
    leg?.renderer?.gpuIdentityComplete !== gpuIdentityComplete
  ) {
    structural.push("browser, viewport, renderer, or adapter identity differs");
  }
  if (
    leg?.browser?.canvas?.clientWidth !==
      C12_29_S5_DENSE_CONFIG.viewport.width ||
    leg?.browser?.canvas?.clientHeight !==
      C12_29_S5_DENSE_CONFIG.viewport.height ||
    leg?.browser?.canvas?.width !== C12_29_S5_DENSE_CONFIG.viewport.width ||
    leg?.browser?.canvas?.height !== C12_29_S5_DENSE_CONFIG.viewport.height ||
    leg?.browser?.canvas?.drawingBufferWidth !==
      C12_29_S5_DENSE_CONFIG.viewport.width ||
    leg?.browser?.canvas?.drawingBufferHeight !==
      C12_29_S5_DENSE_CONFIG.viewport.height ||
    leg?.browser?.canvas?.resolutionScale !== 1
  ) {
    structural.push("canvas/drawing-buffer 1280x720@1 identity differs");
  }
  if (
    context.servedEntry !== undefined &&
    (leg?.servedEntry?.status !== 200 ||
      leg?.servedEntry?.ok !== true ||
      leg?.servedEntry?.byteLength !== context.servedEntry.byteLength ||
      leg?.servedEntry?.sha256 !== context.servedEntry.sha256)
  ) {
    structural.push(
      "browser-served runtime entry differs from the frozen build entry",
    );
  }
  const transport = leg?.transport;
  if (
    !isObject(transport) ||
    !sameJson(transport.externalRequests, []) ||
    !sameJson(transport.failedRequests, []) ||
    !sameJson(transport.pageErrors, []) ||
    !sameJson(transport.consoleErrors, []) ||
    !sameJson(transport.dialogs, [])
  ) {
    errors.push("browser transport or error surfaces are not clean");
  }
  if (
    !isObject(leg?.errors) ||
    !sameJson(leg.errors.gpu, []) ||
    leg.errors.deviceLost !== false
  ) {
    errors.push("GPU error or device-loss surface is not clean");
  }
  const configuration = leg?.configuration;
  structural.push(
    ...defaultFeatureSnapshotReasons(configuration?.defaultFeatureSnapshot),
    ...defaultFeatureSnapshotReasons(configuration?.defaultFeatureSnapshotEnd),
  );
  if (
    configuration?.fixedClock !== C12_29_S5_DENSE_CONFIG.fixedClock ||
    configuration?.shouldAnimate !== false ||
    configuration?.maximumScreenSpaceError !==
      C12_29_S5_DENSE_CONFIG.maximumScreenSpaceError ||
    configuration?.tileCacheSize !== C12_29_S5_DENSE_CONFIG.tileCacheSize ||
    configuration?.globeLighting !== true ||
    !sameJson(
      configuration?.defaultFeatureSnapshot,
      configuration?.defaultFeatureSnapshotEnd,
    ) ||
    configuration?.defaultFeaturesRetained !== true ||
    configuration?.requestRenderMode !== true ||
    configuration?.explicitMeasuredRenders !==
      C12_29_S5_DENSE_CONFIG.measuredFrames ||
    configuration?.enableEclipse !== true ||
    configuration?.enableEclipseGlobeShadow !==
      (expected?.condition === "active")
  ) {
    structural.push("runtime scene configuration differs");
  }
  const sentinel = deriveC1229S5DenseSentinel(workload.route);
  if (
    !sameJson(leg?.prime?.sentinel, sentinel) ||
    !sameJson(leg?.prime?.seenOwnRealSentinelKeys, sentinel.keys) ||
    !nonNegativeInteger(leg?.prime?.settledFrames) ||
    leg?.prime?.settledFrames < workload?.protocol?.settleStableFrames ||
    !sameJson(
      leg?.prime?.variants?.map((variant) => ({
        condition: variant.condition,
        frameCount: variant.frameCount,
      })),
      [
        { condition: "active", frameCount: 600 },
        { condition: "inactive", frameCount: 600 },
      ],
    )
  ) {
    structural.push("route prime or 8x8 own-real sentinel differs");
  }
  if (
    leg?.prime?.waterMask?.width !== C12_29_S5_DENSE_CONFIG.waterMaskWidth ||
    !sameJson(leg?.prime?.waterMask?.values, [0, 255]) ||
    leg?.prime?.waterMask?.pattern !==
      C12_29_S5_DENSE_CONFIG.waterMaskPattern ||
    leg?.prime?.waterMask?.sha256 !== C12_29_S5_DENSE_CONFIG.waterMaskSha256
  ) {
    structural.push("deterministic mixed water-mask bytes differ");
  }
  structural.push(
    ...routeEvidenceReasons(leg?.measurement?.route, workload, "measurement"),
  );
  structural.push(
    ...routeEvidenceReasons(leg?.replay?.route, workload, "replay"),
  );
  behavioral.push(
    ...terrainFrameReasons(
      leg?.measurement?.frames,
      expected?.condition,
      sentinel.keys,
      "measurement",
    ),
  );
  behavioral.push(
    ...terrainFrameReasons(
      leg?.replay?.frames,
      expected?.condition,
      sentinel.keys,
      "replay",
    ),
  );
  structural.push(
    ...traceReasons(
      leg?.measurement?.trace,
      leg?.measurement?.frames ?? [],
      "measurement",
      true,
    ),
  );
  structural.push(
    ...traceReasons(leg?.replay?.trace, leg?.replay?.frames ?? [], "replay"),
  );
  structural.push(...qualityReasons(leg?.measurement));
  structural.push(...gpuReasons(leg?.gpu, expected?.renderer));
  if (
    leg?.replay?.timed !== false ||
    leg?.replay?.frameCount !== 600 ||
    sameTimedReplayWork(leg?.measurement, leg?.replay) !== true ||
    leg?.replay?.alignment?.camera !== true ||
    leg?.replay?.alignment?.selection !== true ||
    leg?.replay?.alignment?.draw !== true ||
    leg?.replay?.alignment?.command !== true
  ) {
    structural.push(
      "timed/untimed route, selection, draw, or command alignment differs",
    );
  }
  if (
    leg?.counterfactual?.timed !== false ||
    leg?.counterfactual?.frameIndex !==
      Math.floor(C12_29_S5_DENSE_CONFIG.measuredFrames / 2) ||
    leg?.counterfactual?.enableEclipse !== true ||
    leg?.counterfactual?.enableEclipseGlobeShadow !== true ||
    ![1, 2].includes(leg?.counterfactual?.gate) ||
    !Array.isArray(leg?.counterfactual?.selectedKeys) ||
    leg.counterfactual.selectedKeys.length === 0 ||
    !sameJson(
      leg.counterfactual.selectedKeys,
      leg.counterfactual.ownRealMeshKeys,
    ) ||
    !sameJson(
      leg.counterfactual.selectedKeys,
      leg?.replay?.frames?.[leg.counterfactual.frameIndex]?.selectedKeys,
    )
  ) {
    behavioral.push(
      "untimed ACTIVE counterfactual did not prove gate 1/2 on the same real selection",
    );
  }
  if (
    leg?.cleanup?.viewerDestroyed !== true ||
    leg?.cleanup?.timestampWrapperRestored !== true ||
    leg?.cleanup?.timestampProfilingRestored !== true ||
    leg?.cleanup?.longTaskObserverDisconnected !== true ||
    leg?.cleanup?.conditionRestored !== true
  ) {
    errors.push("runtime cleanup is incomplete");
  }
  return {
    valid:
      structural.length === 0 && behavioral.length === 0 && errors.length === 0,
    structural,
    behavioral,
    errors,
  };
}

function pairKey(leg) {
  return `${leg.scheduleLeg.repetition}/${leg.scheduleLeg.renderer}`;
}

function alignmentProjection(leg) {
  return {
    route: leg.measurement.route,
    frames: leg.measurement.frames.map((frame) => ({
      selectedKeys: frame.selectedKeys,
      realMeshKeys: frame.realMeshKeys,
      ownRealMeshKeys: frame.ownRealMeshKeys,
      fillMeshKeys: frame.fillMeshKeys,
      logicalDrawCount: frame.logicalDrawCount,
      commandCount: frame.commandCount,
    })),
    traceWork: leg.measurement.trace.samples.map((sample) => ({
      drawCount: sample.drawCount,
      commandCount: sample.commandCount,
    })),
  };
}

function conditionInvariantProjection(leg) {
  const configuration = { ...leg.configuration };
  delete configuration.enableEclipseGlobeShadow;
  return {
    browser: leg.browser,
    renderer: leg.renderer,
    configuration,
    prime: {
      variants: leg.prime?.variants,
      sentinel: leg.prime?.sentinel,
      seenOwnRealSentinelKeys: leg.prime?.seenOwnRealSentinelKeys,
      waterMask: leg.prime?.waterMask,
    },
  };
}

function deltaRecord(active, inactive, field) {
  const a = active[field];
  const i = inactive[field];
  return {
    active: a,
    inactive: i,
    delta: a - i,
    ratio: i === 0 ? null : a / i,
  };
}

function pairedSummary(records, field) {
  const deltas = records.map((record) => record[field].delta);
  const ratios = records.map((record) => record[field].ratio).filter(finite);
  const deltaMedian = percentileC1229S5Dense(deltas, 0.5);
  const ratioMedian =
    ratios.length > 0 ? percentileC1229S5Dense(ratios, 0.5) : null;
  return {
    pairs: records.length,
    deltaMedian,
    deltaMinimum: Math.min(...deltas),
    deltaMaximum: Math.max(...deltas),
    deltaRange: Math.max(...deltas) - Math.min(...deltas),
    deltaMad: percentileC1229S5Dense(
      deltas.map((value) => Math.abs(value - deltaMedian)),
      0.5,
    ),
    ratioMedian,
    ratioMinimum: ratios.length > 0 ? Math.min(...ratios) : null,
    ratioMaximum: ratios.length > 0 ? Math.max(...ratios) : null,
    ratioRange:
      ratios.length > 0 ? Math.max(...ratios) - Math.min(...ratios) : null,
    ratioMad:
      ratios.length > 0
        ? percentileC1229S5Dense(
            ratios.map((value) => Math.abs(value - ratioMedian)),
            0.5,
          )
        : null,
  };
}

export function characterizeC1229S5DenseCost(legs) {
  const pairs = new Map();
  for (const leg of legs) {
    const key = pairKey(leg);
    const pair = pairs.get(key) ?? {};
    pair[leg.scheduleLeg.condition] = leg;
    pairs.set(key, pair);
  }
  const records = [];
  for (const [key, pair] of [...pairs.entries()].sort()) {
    if (!pair.active || !pair.inactive) continue;
    const cpuActive = pair.active.measurement.cpuSummary;
    const cpuInactive = pair.inactive.measurement.cpuSummary;
    const record = {
      pair: key,
      repetition: pair.active.scheduleLeg.repetition,
      renderer: pair.active.scheduleLeg.renderer,
      cpuP50: deltaRecord(cpuActive, cpuInactive, "p50"),
      cpuP95: deltaRecord(cpuActive, cpuInactive, "p95"),
      cpuP99: deltaRecord(cpuActive, cpuInactive, "p99"),
      gpuP50: null,
      gpuP95: null,
      gpuP99: null,
    };
    if (record.renderer === "webgpu") {
      record.gpuP50 = deltaRecord(
        pair.active.gpu.summary,
        pair.inactive.gpu.summary,
        "p50",
      );
      record.gpuP95 = deltaRecord(
        pair.active.gpu.summary,
        pair.inactive.gpu.summary,
        "p95",
      );
      record.gpuP99 = deltaRecord(
        pair.active.gpu.summary,
        pair.inactive.gpu.summary,
        "p99",
      );
    }
    records.push(record);
  }
  const byRenderer = {};
  for (const renderer of C12_29_S5_DENSE_RENDERERS) {
    const subset = records.filter((record) => record.renderer === renderer);
    byRenderer[renderer] = {
      cpuP50: pairedSummary(subset, "cpuP50"),
      cpuP95: pairedSummary(subset, "cpuP95"),
      cpuP99: pairedSummary(subset, "cpuP99"),
      gpuP50: renderer === "webgpu" ? pairedSummary(subset, "gpuP50") : null,
      gpuP95: renderer === "webgpu" ? pairedSummary(subset, "gpuP95") : null,
      gpuP99: renderer === "webgpu" ? pairedSummary(subset, "gpuP99") : null,
    };
  }
  return {
    policy: "threshold-free-characterization",
    passIndependentOfCostSignOrMagnitude: true,
    pairRecords: records,
    byRenderer,
  };
}

function campaignShapeReasons(report, contract) {
  const reasons = [];
  const startedAt = canonicalIsoMilliseconds(report?.startedAt);
  const completedAt = canonicalIsoMilliseconds(report?.completedAt);
  if (
    !isObject(report) ||
    report.schema !== contract.schema ||
    report.schemaVersion !== contract.schemaVersion ||
    !isC1229S5DenseUuidV4(report.runId) ||
    !["RUNNING", "PASS", "FAIL", "ERROR", "STRUCTURAL"].includes(
      report.status,
    ) ||
    typeof report.incomplete !== "boolean" ||
    !isObject(report.workload) ||
    !isObject(report.prerequisites) ||
    !isObject(report.provenance) ||
    !isObject(report.lifecycle) ||
    !Array.isArray(report.legs)
  ) {
    reasons.push("campaign envelope differs");
  }
  if (startedAt === null || completedAt === null || startedAt >= completedAt) {
    reasons.push("campaign timestamp envelope differs");
  }
  return reasons;
}

function provenanceSnapshotReasons(snapshot, label, contract) {
  const reasons = [];
  if (
    !isObject(snapshot) ||
    snapshot.ok !== true ||
    !sameJson(snapshot.reasons, []) ||
    typeof snapshot.capturedAt !== "string" ||
    Number.isNaN(Date.parse(snapshot.capturedAt))
  ) {
    return [`${label} provenance snapshot is not valid`];
  }
  reasons.push(
    ...validateIdentityList(
      snapshot.localFiles,
      contract.localFiles,
      `${label} local`,
    ),
    ...validateIdentityList(
      snapshot.servedFiles,
      contract.servedFiles,
      `${label} served`,
    ),
  );
  const localByPath = new Map(
    (snapshot.localFiles ?? []).map((identity) => [identity.path, identity]),
  );
  for (const served of snapshot.servedFiles ?? []) {
    const local = localByPath.get(served?.path);
    if (
      served?.status !== 200 ||
      served?.ok !== true ||
      !local ||
      served.byteLength !== local.byteLength ||
      String(served.sha256).toLowerCase() !== String(local.sha256).toLowerCase()
    ) {
      reasons.push(
        `${label} served ${String(served?.path)} differs from local`,
      );
      break;
    }
  }
  const build = snapshot.buildSourceIdentity;
  const sourceMapLocal = localByPath.get("Build/CesiumUnminified/index.js.map");
  if (
    !isObject(build) ||
    build.ok !== true ||
    !Array.isArray(build.entries) ||
    build.entries.length !== contract.buildSourceFiles.length ||
    build.sourceMapPath !== "Build/CesiumUnminified/index.js.map" ||
    !positiveInteger(build.sourceMapByteLength) ||
    !/^[0-9a-f]{64}$/i.test(build.sourceMapSha256 ?? "") ||
    build.sourceMapByteLength !== sourceMapLocal?.byteLength ||
    String(build.sourceMapSha256).toLowerCase() !==
      String(sourceMapLocal?.sha256).toLowerCase() ||
    !sameJson(build.reasons, [])
  ) {
    reasons.push(`${label} build source-map closure differs`);
  } else {
    const expected = contract.buildSourceFiles;
    for (let index = 0; index < expected.length; index++) {
      const entry = build.entries[index];
      if (
        entry?.file !== expected[index] ||
        typeof entry?.sourceMapEntry !== "string" ||
        entry.sourceMapEntry.length === 0 ||
        entry?.exact !== true ||
        !positiveInteger(entry?.currentByteLength) ||
        entry.currentByteLength !== entry.embeddedByteLength ||
        !/^[0-9a-f]{64}$/i.test(entry?.currentSha256 ?? "") ||
        String(entry.currentSha256).toLowerCase() !==
          String(entry.embeddedSha256).toLowerCase() ||
        entry.currentByteLength !==
          localByPath.get(expected[index])?.byteLength ||
        String(entry.currentSha256).toLowerCase() !==
          String(localByPath.get(expected[index])?.sha256).toLowerCase()
      ) {
        reasons.push(`${label} build source entry ${index} differs`);
        break;
      }
    }
  }
  const rawGenerated = snapshot.rawGenerated;
  if (
    !Array.isArray(rawGenerated) ||
    rawGenerated.length !== C12_29_S5_DENSE_RAW_GENERATED_PAIRS.length
  ) {
    reasons.push(`${label} raw/generated identity list differs`);
  } else {
    for (let index = 0; index < rawGenerated.length; index++) {
      const identity = rawGenerated[index];
      const expected = C12_29_S5_DENSE_RAW_GENERATED_PAIRS[index];
      if (
        identity?.raw !== expected.raw ||
        identity?.generated !== expected.generated ||
        identity?.exact !== true ||
        identity?.rawIdentity?.path !== expected.raw ||
        identity?.generatedIdentity?.path !== expected.generated ||
        !positiveInteger(identity?.rawIdentity?.byteLength) ||
        !positiveInteger(identity?.generatedIdentity?.byteLength) ||
        !/^[0-9a-f]{64}$/i.test(identity?.rawIdentity?.sha256 ?? "") ||
        !/^[0-9a-f]{64}$/i.test(identity?.generatedIdentity?.sha256 ?? "") ||
        !sameJson(identity.rawIdentity, localByPath.get(expected.raw)) ||
        !sameJson(
          identity.generatedIdentity,
          localByPath.get(expected.generated),
        )
      ) {
        reasons.push(`${label} raw/generated identity ${index} differs`);
        break;
      }
    }
  }
  const identity = {
    gitHead: snapshot.gitHead,
    localFiles: snapshot.localFiles,
    servedFiles: snapshot.servedFiles,
    buildSourceIdentity: snapshot.buildSourceIdentity,
    rawGenerated: snapshot.rawGenerated,
  };
  if (
    !/^[0-9a-f]{40}$/i.test(snapshot.gitHead ?? "") ||
    snapshot.identitySha256 !== sha256(stableC1229S5DenseJson(identity))
  ) {
    reasons.push(`${label} provenance digest does not recompute`);
  }
  return reasons;
}

function provenanceReasons(provenance, contract) {
  const reasons = [
    ...provenanceSnapshotReasons(provenance?.start, "start", contract),
    ...provenanceSnapshotReasons(provenance?.end, "end", contract),
  ];
  if (
    provenance?.stable !== true ||
    !isObject(provenance?.start) ||
    !isObject(provenance?.end) ||
    provenance.start.ok !== true ||
    provenance.end.ok !== true ||
    provenance.start.identitySha256 !== provenance.end.identitySha256 ||
    provenance.start.gitHead !== provenance.end.gitHead ||
    !sameJson(provenance.start.localFiles, provenance.end.localFiles) ||
    !sameJson(provenance.start.servedFiles, provenance.end.servedFiles) ||
    !sameJson(
      provenance.start.buildSourceIdentity,
      provenance.end.buildSourceIdentity,
    ) ||
    !sameJson(provenance.start.rawGenerated, provenance.end.rawGenerated)
  ) {
    reasons.push("source/build/served provenance is incomplete or changed");
  }
  return reasons;
}

function lifecycleReasons(report, contract) {
  const lifecycle = report?.lifecycle;
  const final = report?.status !== "RUNNING";
  const reasons = [];
  if (
    lifecycle?.lockCreatedExclusively !== true ||
    lifecycle?.runningReceiptCreatedExclusively !== true ||
    lifecycle?.runningLatestPublishedBeforeLaunch !== true
  ) {
    reasons.push("RUNNING authority was not published before fallible work");
  }
  if (
    final &&
    (lifecycle?.immutableRunCreatedExclusively !== true ||
      lifecycle?.firstRedFingerprintPolicy !==
        "write-once-exact-sha256-byte-length" ||
      lifecycle?.finalReceiptCreatedExclusively !== true ||
      lifecycle?.latestEqualsImmutableRunBeforeUnlock !== true ||
      lifecycle?.lockReleasedByOwnedReceipt !== true ||
      lifecycle?.publicationOrder?.join(",") !==
        "lock,running-receipt,running-latest,immutable-run,first-red,final-latest,final-receipt,unlock")
  ) {
    reasons.push("final immutable/latest/first-red/receipt lifecycle differs");
  }
  if (
    final &&
    contract.schemaVersion === 3 &&
    (lifecycle?.predecessorAuthorityBoundToRunningReceipt !== true ||
      lifecycle?.publicationAuthorityReverifiedThroughUnlock !== true ||
      lifecycle?.runningReceiptReverifiedThroughUnlock !== true)
  ) {
    reasons.push("v3 predecessor/RUNNING publication authority differs");
  }
  if (
    contract.schemaVersion < 3 &&
    (Object.hasOwn(
      lifecycle ?? {},
      "predecessorAuthorityBoundToRunningReceipt",
    ) ||
      Object.hasOwn(
        lifecycle ?? {},
        "publicationAuthorityReverifiedThroughUnlock",
      ) ||
      Object.hasOwn(lifecycle ?? {}, "runningReceiptReverifiedThroughUnlock"))
  ) {
    reasons.push("historical lifecycle contains v3-only authority fields");
  }
  if (
    final &&
    report.status !== "PASS" &&
    lifecycle?.firstRedPreserved !== true
  ) {
    reasons.push("first-red evidence was not preserved");
  }
  return reasons;
}

/** Fold the complete 24-process campaign with STRUCTURAL > ERROR > FAIL > PASS. */
function foldDenseCostGate(report, contract) {
  const structural = campaignShapeReasons(report, contract);
  const errors = [];
  const behavioral = [];
  const workloadValidation = validateC1229S5DenseWorkload(
    report?.workload?.value,
  );
  if (!workloadValidation.valid) structural.push(...workloadValidation.reasons);
  const prerequisiteValidation = validateDensePrerequisites(
    report?.prerequisites,
    contract.prerequisites,
  );
  if (!prerequisiteValidation.valid)
    structural.push(...prerequisiteValidation.reasons);
  if (
    report?.prerequisitesSha256 !==
    sha256(stableC1229S5DenseJson(report?.prerequisites))
  ) {
    structural.push("prerequisite digest does not recompute");
  }
  if (
    report?.workload?.path !== C12_29_S5_DENSE_WORKLOAD_PATH ||
    report.workload.byteLength !== C12_29_S5_DENSE_CONFIG.workloadByteLength ||
    report.workload.sha256 !== C12_29_S5_DENSE_CONFIG.workloadSha256
  ) {
    structural.push("workload byte identity does not recompute");
  }
  const workloadLocal = report?.provenance?.start?.localFiles?.find(
    (identity) => identity.path === report?.workload?.path,
  );
  if (
    workloadLocal?.byteLength !== report?.workload?.byteLength ||
    String(workloadLocal?.sha256).toLowerCase() !==
      String(report?.workload?.sha256).toLowerCase()
  ) {
    structural.push("workload identity differs from provenance closure");
  }
  structural.push(...provenanceReasons(report?.provenance, contract));
  structural.push(...lifecycleReasons(report, contract));
  if (
    !Array.isArray(report?.legs) ||
    report.legs.length !== C12_29_S5_DENSE_CONFIG.expectedLegs
  ) {
    structural.push("campaign does not contain exactly 24 fresh-process legs");
  } else {
    const campaignStartedAt = canonicalIsoMilliseconds(report.startedAt);
    const campaignCompletedAt = canonicalIsoMilliseconds(report.completedAt);
    let previousLegCompletedAt = campaignStartedAt;
    for (let index = 0; index < report.legs.length; index++) {
      const leg = report.legs[index];
      if (!sameJson(leg.scheduleLeg, C12_29_S5_DENSE_SCHEDULE[index])) {
        structural.push(`leg ${index + 1} schedule differs`);
        continue;
      }
      const assessment = validateC1229S5DenseRuntimeLeg(
        leg,
        report.workload.value,
        {
          runId: report.runId,
          sourceIdentitySha256: report.provenance?.start?.identitySha256,
          prerequisitesSha256: report.prerequisitesSha256,
          workloadSha256: report.workload?.sha256,
          requireSubprocess: true,
          servedEntry: report.provenance?.start?.servedFiles?.find(
            (identity) => identity.path === "Build/CesiumUnminified/index.js",
          ),
        },
      );
      structural.push(
        ...assessment.structural.map((reason) => `${leg.legId}: ${reason}`),
      );
      errors.push(
        ...assessment.errors.map((reason) => `${leg.legId}: ${reason}`),
      );
      behavioral.push(
        ...assessment.behavioral.map((reason) => `${leg.legId}: ${reason}`),
      );
      const legStartedAt = canonicalIsoMilliseconds(leg?.startedAt);
      const legCompletedAt = canonicalIsoMilliseconds(leg?.completedAt);
      if (
        campaignStartedAt !== null &&
        campaignCompletedAt !== null &&
        legStartedAt !== null &&
        legCompletedAt !== null &&
        (legStartedAt < campaignStartedAt ||
          legCompletedAt > campaignCompletedAt ||
          (previousLegCompletedAt !== null &&
            legStartedAt < previousLegCompletedAt))
      ) {
        structural.push(
          `${leg.legId}: runtime leg timestamp is outside campaign/schedule order`,
        );
      }
      if (legCompletedAt !== null) previousLegCompletedAt = legCompletedAt;
    }
    const launchIds = report.legs.map((leg) => leg?.subprocess?.launchId);
    if (
      launchIds.some((value) => !isC1229S5DenseUuidV4(value)) ||
      new Set(launchIds).size !== C12_29_S5_DENSE_CONFIG.expectedLegs
    ) {
      structural.push("campaign did not use 24 distinct fresh subprocesses");
    }
    const byPair = new Map();
    for (const leg of report.legs) {
      const key = pairKey(leg);
      const pair = byPair.get(key) ?? {};
      pair[leg.scheduleLeg.condition] = leg;
      byPair.set(key, pair);
    }
    if (byPair.size !== 12)
      structural.push("campaign does not contain 12 ACTIVE/INACTIVE pairs");
    for (const [key, pair] of byPair) {
      if (!pair.active || !pair.inactive) {
        structural.push(`${key} lacks one condition`);
      } else if (
        !sameJson(
          conditionInvariantProjection(pair.active),
          conditionInvariantProjection(pair.inactive),
        ) ||
        pair.active.configuration?.enableEclipseGlobeShadow !== true ||
        pair.inactive.configuration?.enableEclipseGlobeShadow !== false
      ) {
        structural.push(
          `${key} condition pair differs outside enableEclipseGlobeShadow`,
        );
      } else if (
        !sameJson(
          alignmentProjection(pair.active),
          alignmentProjection(pair.inactive),
        )
      ) {
        structural.push(
          `${key} ACTIVE/INACTIVE camera, selection, draw, or command work differs`,
        );
      }
    }
    for (const renderer of C12_29_S5_DENSE_RENDERERS) {
      for (const condition of C12_29_S5_DENSE_CONDITIONS) {
        const p95 = report.legs
          .filter(
            (leg) =>
              leg.scheduleLeg.renderer === renderer &&
              leg.scheduleLeg.condition === condition,
          )
          .map((leg) => leg.measurement?.cpuSummary?.p95);
        if (
          p95.length !== 6 ||
          p95.some((value) => !finite(value) || value < 0) ||
          (Math.min(...p95) === 0
            ? Math.max(...p95) !== 0
            : Math.max(...p95) / Math.min(...p95) >
              C12_29_S5_DENSE_CONFIG.maximumP95SpreadRatio)
        ) {
          structural.push(`${renderer}/${condition} CPU p95 spread exceeds 2x`);
        }
      }
    }
  }
  const characterization =
    structural.length === 0 && errors.length === 0 && behavioral.length === 0
      ? characterizeC1229S5DenseCost(report.legs)
      : null;
  let status = "PASS";
  if (behavioral.length > 0) status = "FAIL";
  if (errors.length > 0) status = "ERROR";
  if (structural.length > 0) status = "STRUCTURAL";
  return {
    status,
    exitCode: exitCodeForC1229S5DenseStatus(status),
    pass: status === "PASS",
    structural,
    errors,
    behavioral,
    characterization,
  };
}

const CURRENT_DENSE_CONTRACT = Object.freeze({
  schema: C12_29_S5_DENSE_SCHEMA,
  schemaVersion: 3,
  prerequisites: C12_29_S5_DENSE_PREREQUISITES,
  localFiles: C12_29_S5_DENSE_LOCAL_FILES,
  servedFiles: C12_29_S5_DENSE_SERVED_FILES,
  buildSourceFiles: C12_29_S5_DENSE_BUILD_SOURCE_FILES,
});

const SUPERSEDED_DENSE_CONTRACT = Object.freeze({
  schema: C12_29_S5_DENSE_SUPERSEDED_SCHEMA,
  schemaVersion: 2,
  prerequisites: C12_29_S5_DENSE_SUPERSEDED_PREREQUISITES,
  localFiles: C12_29_S5_DENSE_SUPERSEDED_LOCAL_FILES,
  servedFiles: C12_29_S5_DENSE_SERVED_FILES,
  buildSourceFiles: C12_29_S5_DENSE_SUPERSEDED_BUILD_SOURCE_FILES,
});

const LEGACY_DENSE_CONTRACT = Object.freeze({
  schema: C12_29_S5_DENSE_LEGACY_SCHEMA,
  schemaVersion: 1,
  prerequisites: C12_29_S5_DENSE_LEGACY_PREREQUISITES,
  localFiles: C12_29_S5_DENSE_SUPERSEDED_LOCAL_FILES,
  servedFiles: C12_29_S5_DENSE_SERVED_FILES,
  buildSourceFiles: C12_29_S5_DENSE_SUPERSEDED_BUILD_SOURCE_FILES,
});

export function foldC1229S5DenseCostGate(report) {
  return foldDenseCostGate(report, CURRENT_DENSE_CONTRACT);
}

export function foldC1229S5DenseSupersededCostGate(report) {
  return foldDenseCostGate(report, SUPERSEDED_DENSE_CONTRACT);
}

export function foldC1229S5DenseLegacyCostGate(report) {
  return foldDenseCostGate(report, LEGACY_DENSE_CONTRACT);
}

function validateDenseFinalArtifact(report, contract) {
  const reasons = campaignShapeReasons(report, contract);
  if (
    report?.status === "RUNNING" ||
    report?.incomplete !== false ||
    report?.exitCode !== exitCodeForC1229S5DenseStatus(report?.status) ||
    report?.pass !== (report?.status === "PASS") ||
    !isObject(report?.assessment) ||
    report.assessment.status !== report.status ||
    report.assessment.exitCode !== report.exitCode ||
    report.assessment.pass !== report.pass
  ) {
    reasons.push("final status/exit/assessment envelope differs");
  }
  let folded;
  try {
    folded = foldDenseCostGate(report, contract);
  } catch (error) {
    reasons.push(
      `final assessment recomputation threw: ${String(error?.message ?? error)}`,
    );
    return { valid: false, reasons, folded: null };
  }
  if (
    folded.status !== report?.status ||
    folded.exitCode !== report?.exitCode ||
    folded.pass !== report?.pass ||
    !sameJson(folded.structural, report?.assessment?.structural) ||
    !sameJson(folded.errors, report?.assessment?.errors) ||
    !sameJson(folded.behavioral, report?.assessment?.behavioral) ||
    !sameJson(folded.characterization, report?.assessment?.characterization)
  ) {
    reasons.push("final assessment does not recompute from raw evidence");
  }
  return { valid: reasons.length === 0, reasons, folded };
}

export function validateC1229S5DenseFinalArtifact(report) {
  return validateDenseFinalArtifact(report, CURRENT_DENSE_CONTRACT);
}

export function validateC1229S5DenseSupersededFinalArtifact(report) {
  return validateDenseFinalArtifact(report, SUPERSEDED_DENSE_CONTRACT);
}

export function validateC1229S5DenseLegacyFinalArtifact(report) {
  return validateDenseFinalArtifact(report, LEGACY_DENSE_CONTRACT);
}
