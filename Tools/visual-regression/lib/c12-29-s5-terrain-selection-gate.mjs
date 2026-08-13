/**
 * Pure acceptance policy for C12-29 S5's first final-certification shard.
 *
 * The browser driver owns the real terrain/provider/pick/capture exercise and
 * immutable evidence publication. This module owns the frozen inputs, exact
 * terrain-radius arithmetic, evidence-shape checks, and verdict folding. It is
 * deliberately browser-free so every premise can be mutation-tested in Node.
 */

export const C12_29_S5_SCHEMA = "c12-29-s5-terrain-selection-evidence-v6";

export const C12_29_S5_DIAGNOSTICS_SCHEMA = "c12-29-s5-runtime-diagnostics-v2";

export const C12_29_S5_RENDERERS = Object.freeze(["webgl", "webgpu"]);

export const C12_29_S5_PHASES = Object.freeze([
  "A-ellipsoid-stable",
  "B-held-provider-swap",
  "C-fill-held",
  "D-real-x1",
  "E-real-x2",
  "F-pick-async",
  "G-retained-capture",
  "H-ellipsoid-reset",
]);

export const C12_29_S5_CAPTURE_LABELS = Object.freeze([
  "fill-on",
  "real-x1-on",
  "real-x2-off",
  "real-x2-on",
]);

export const C12_29_S5_CAPTURE_METHOD =
  "scene.render(pinnedTime)+scene.canvas.toDataURL(image/png)-same-task";

export const C12_29_S5_PICK_FRAME_DRIVER =
  "scene.render(pinnedTime)+requestAnimationFrame-until-pick-settles";

export const C12_29_S5_PICK_MAX_PUMP_FRAMES = 30;

export const C12_29_S5_WEBGPU_PREWARM_MAX_FRAMES = 180;

export const C12_29_S5_FIXTURE = Object.freeze({
  baseRoute: "/Specs/Data/CesiumTerrainTileJson/QuantizedMesh/",
  layer: Object.freeze({
    file: "Specs/Data/CesiumTerrainTileJson/QuantizedMesh/layer.json",
    byteLength: 569,
    sha256: "6c0e246c3bb2f0db6104c12560052369516a673020faee860a6e3113e57b4736",
  }),
  tile: Object.freeze({
    file: "Specs/Data/CesiumTerrainTileJson/QuantizedMesh/tile.terrain",
    byteLength: 3914,
    sha256: "8dc69d9e132d059ad77080c51daf844e255295c35a3c2654d243349b81a565b2",
    quantizedMeshHeader: Object.freeze({
      byteOrder: "little-endian",
      minimumHeightByteOffset: 24,
      maximumHeightByteOffset: 28,
      minimumHeight: -156.00425720214844,
      maximumHeight: 6827.119140625,
    }),
  }),
});

export const C12_29_S5_SCENE = Object.freeze({
  pinnedIso: "2024-04-08T18:17:16Z",
  cameraHeightMeters: 8_000_000,
  cameraFovDegrees: 55,
  terrainMaximumScreenSpaceError: 2,
  // At the pinned 8 Mm / 960 px / 55 degree view, level zero exceeds this
  // threshold while direct level one meets it. Runtime evidence must prove the
  // exact target and a same-parent sibling really are selected at level one.
  fillFrontierMaximumScreenSpaceError: 6,
  fillWarmMaximumFrames: 300,
  viewport: Object.freeze({ width: 960, height: 960 }),
  verticalExaggeration: 2,
  // This is deliberately above the pinned fixture maximum. At x2 the
  // skirted negative endpoint then controls the radius, while omitting the
  // skirt or applying it after exaggeration changes the measured result.
  verticalExaggerationRelativeHeight: 7000,
});

export const C12_29_S5_RADIUS_LAW = Object.freeze({
  fillSkirtAllowanceMeters: 1000,
  absoluteSafetyMeters: 2,
  relativeSafety: 8 * 2 ** -23,
});

export const C12_29_S5_WEBGPU_ECLIPSE_BINDING = 2;
export const C12_29_S5_WEBGPU_LAYOUT_FILE =
  "packages/engine/Source/Renderer/WebGPU/WebGPUGlobeSurfaceLayouts.ts";

/**
 * Complete S5 semantic source boundary for this shard. Raw shaders and their
 * generated modules are both present; source-map comparison uses the derived
 * list below, because esbuild's map names the generated modules.
 */
export const C12_29_S5_SOURCE_FILES = Object.freeze([
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
  C12_29_S5_WEBGPU_LAYOUT_FILE,
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

export const C12_29_S5_BUILD_SOURCE_FILES = Object.freeze(
  C12_29_S5_SOURCE_FILES.filter(
    (file) => !file.endsWith(".glsl") && !file.endsWith(".wgsl"),
  ),
);

export const C12_29_S5_BUILD_SOURCE_MAP = "Build/CesiumUnminified/index.js.map";

const FINAL_STATUSES = new Set(["PASS", "FAIL", "STRUCTURAL", "ERROR"]);
const SHA256 = /^[0-9a-f]{64}$/u;

const REQUEST_LEDGER_KEYS = Object.freeze([
  "started",
  "completed",
  "failed",
  "inFlight",
  "lastRequest",
  "lastResponse",
  "lastFailure",
]);

const TERRAIN_REQUEST_KEYS = Object.freeze([
  "attempted",
  "accepted",
  "throttled",
  "decoded",
  "held",
  "released",
  "fulfilled",
  "rejected",
  "lastTileId",
  "lastError",
]);

const nonNegativeInteger = (value) => Number.isInteger(value) && value >= 0;

function exactObjectKeys(value, keys) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}

function validRequestLedger(value) {
  if (value === null) return true;
  return (
    exactObjectKeys(value, REQUEST_LEDGER_KEYS) &&
    [value.started, value.completed, value.failed, value.inFlight].every(
      nonNegativeInteger,
    ) &&
    value.started === value.completed + value.failed + value.inFlight
  );
}

const VISIBILITY_VALUES = new Map([
  [-1, "NONE"],
  [0, "PARTIAL"],
  [1, "FULL"],
]);

function validVisibilityCall(call, index) {
  const visibilityName = VISIBILITY_VALUES.get(call?.originalVisibility);
  const returnedName = VISIBILITY_VALUES.get(call?.returnedVisibility);
  return (
    exactObjectKeys(call, [
      "ordinal",
      "frameNumber",
      "tileKey",
      "mode",
      "target",
      "originalCallCompleted",
      "originalVisibility",
      "originalVisibilityName",
      "returnedVisibility",
      "returnedVisibilityName",
      "overridden",
    ]) &&
    call.ordinal === index + 1 &&
    nonNegativeInteger(call.frameNumber) &&
    /^\d+\/\d+\/\d+$/u.test(call.tileKey) &&
    new Set(["warm-mask", "pass-through"]).has(call.mode) &&
    typeof call.target === "boolean" &&
    typeof call.originalCallCompleted === "boolean" &&
    call.originalVisibilityName === visibilityName &&
    call.returnedVisibilityName === returnedName &&
    typeof call.overridden === "boolean" &&
    call.overridden ===
      !Object.is(call.originalVisibility, call.returnedVisibility) &&
    (call.target || !call.overridden)
  );
}

function validVisibilitySeamProgress(value) {
  const config = value?.config;
  const counts = value?.counts;
  const restoration = value?.restoration;
  const calls = value?.calls;
  if (
    !exactObjectKeys(value, [
      "state",
      "targetKey",
      "mode",
      "config",
      "calls",
      "counts",
      "terminalReason",
      "restoration",
    ]) ||
    !new Set([
      "not-installed",
      "installed",
      "warm-proven",
      "revealed",
      "restored",
      "error-restored",
    ]).has(value.state) ||
    !(value.targetKey === null || /^1\/\d+\/\d+$/u.test(value.targetKey)) ||
    !new Set(["not-installed", "warm-mask", "pass-through", "restored"]).has(
      value.mode,
    ) ||
    !(value.terminalReason === null || typeof value.terminalReason === "string")
  ) {
    return false;
  }
  if (
    !exactObjectKeys(config, [
      "claim",
      "maximumScreenSpaceError",
      "cameraHeightMeters",
      "cameraFovDegrees",
      "maskMode",
    ]) ||
    config.claim !==
      "controlled-visibility-input-production-selection-request-fill-release-render" ||
    config.maximumScreenSpaceError !==
      C12_29_S5_SCENE.fillFrontierMaximumScreenSpaceError ||
    config.cameraHeightMeters !== C12_29_S5_SCENE.cameraHeightMeters ||
    config.cameraFovDegrees !== C12_29_S5_SCENE.cameraFovDegrees ||
    config.maskMode !== "warm-only-exact-target-Visibility.NONE"
  ) {
    return false;
  }
  if (
    !exactObjectKeys(counts, [
      "totalCalls",
      "originalCalls",
      "targetCalls",
      "nonTargetCalls",
      "overrideCalls",
      "nonTargetAlteredCalls",
      "skippedOriginalCalls",
    ]) ||
    !Object.values(counts).every(nonNegativeInteger) ||
    counts.totalCalls !== counts.targetCalls + counts.nonTargetCalls ||
    counts.originalCalls + counts.skippedOriginalCalls !== counts.totalCalls ||
    counts.overrideCalls > counts.targetCalls
  ) {
    return false;
  }
  if (
    !exactObjectKeys(restoration, [
      "attempted",
      "restored",
      "identityMatches",
      "descriptorMatches",
    ]) ||
    !Object.values(restoration).every((entry) => typeof entry === "boolean") ||
    (restoration.restored &&
      (!restoration.attempted ||
        !restoration.identityMatches ||
        !restoration.descriptorMatches))
  ) {
    return false;
  }
  return (
    Array.isArray(calls) &&
    calls.length <= C12_29_S5_SCENE.fillWarmMaximumFrames * 64 &&
    calls.length === counts.totalCalls &&
    calls.every(validVisibilityCall) &&
    calls.every(
      (call) =>
        value.targetKey !== null &&
        call.target === (call.tileKey === value.targetKey),
    )
  );
}

export function validateS5PageProgress(value, renderer = value?.renderer) {
  const reasons = [];
  const completed = value?.completedPhases;
  const requests = value?.terrainRequests;
  const pick = value?.pick;
  if (
    value?.schema !== C12_29_S5_DIAGNOSTICS_SCHEMA ||
    value?.renderer !== renderer ||
    !C12_29_S5_RENDERERS.includes(renderer)
  ) {
    reasons.push("page progress schema/renderer is invalid");
  }
  if (
    !new Set(["preflight", ...C12_29_S5_PHASES]).has(value?.currentPhase) ||
    typeof value?.step !== "string" ||
    value.step.length === 0 ||
    !nonNegativeInteger(value?.elapsedMs)
  ) {
    reasons.push("page progress phase/step/elapsed state is invalid");
  }
  if (
    !Array.isArray(completed) ||
    completed.length > C12_29_S5_PHASES.length ||
    !completed.every((phase, index) => phase === C12_29_S5_PHASES[index])
  ) {
    reasons.push("page progress completed phases are not an A-H prefix");
  }
  if (
    !exactObjectKeys(requests, TERRAIN_REQUEST_KEYS) ||
    ![
      requests?.attempted,
      requests?.accepted,
      requests?.throttled,
      requests?.decoded,
      requests?.held,
      requests?.released,
      requests?.fulfilled,
      requests?.rejected,
    ].every(nonNegativeInteger) ||
    requests.attempted !== requests.accepted + requests.throttled ||
    requests.accepted < requests.decoded + requests.rejected ||
    requests.held > requests.decoded ||
    requests.released > requests.held ||
    requests.fulfilled > requests.decoded
  ) {
    reasons.push("page progress terrain request ledger is inconsistent");
  }
  if (
    !exactObjectKeys(pick, [
      "started",
      "settled",
      "frameDriver",
      "renderPumpFrames",
    ]) ||
    typeof pick?.started !== "boolean" ||
    typeof pick?.settled !== "boolean" ||
    pick?.frameDriver !== C12_29_S5_PICK_FRAME_DRIVER ||
    !nonNegativeInteger(pick?.renderPumpFrames) ||
    pick.renderPumpFrames > C12_29_S5_PICK_MAX_PUMP_FRAMES ||
    (pick.settled && !pick.started)
  ) {
    reasons.push("page progress async-pick state is inconsistent");
  }
  if (!validVisibilitySeamProgress(value?.visibilitySeam)) {
    reasons.push("page progress visibility seam diagnostics are inconsistent");
  }
  return { ok: reasons.length === 0, reasons };
}

export function isUuidV4(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
    value ?? "",
  );
}

export function exitCodeForS5Status(status) {
  if (status === "PASS") return 0;
  if (status === "FAIL") return 1;
  if (status === "ERROR") return 2;
  if (status === "STRUCTURAL") return 3;
  throw new Error(`unknown S5 evidence status ${String(status)}`);
}

/** Derive the exact south level-one neighbour of the live track anchor. */
export function deriveS5SouthLevelOneTarget(longitude, latitude) {
  if (
    !Number.isFinite(longitude) ||
    !Number.isFinite(latitude) ||
    longitude < -180 ||
    longitude > 180 ||
    latitude < -90 ||
    latitude > 90
  ) {
    return undefined;
  }

  const level = 1;
  const xTiles = 4;
  const yTiles = 2;
  const tileWidth = 360 / xTiles;
  const tileHeight = 180 / yTiles;
  const anchorX = Math.min(
    xTiles - 1,
    Math.floor((longitude + 180) / tileWidth),
  );
  const anchorY = Math.min(
    yTiles - 1,
    Math.floor((90 - latitude) / tileHeight),
  );
  if (anchorY + 1 >= yTiles) return undefined;
  const targetX = anchorX;
  const targetY = anchorY + 1;
  const parentX = Math.floor(targetX / 2);
  const parentY = Math.floor(targetY / 2);
  const siblingKeys = [];
  for (let y = parentY * 2; y < parentY * 2 + 2; y++) {
    for (let x = parentX * 2; x < parentX * 2 + 2; x++) {
      if (x !== targetX || y !== targetY) {
        siblingKeys.push(`${level}/${x}/${y}`);
      }
    }
  }
  siblingKeys.sort();
  return {
    level,
    anchorKey: `${level}/${anchorX}/${anchorY}`,
    parentKey: `0/${parentX}/${parentY}`,
    key: `${level}/${targetX}/${targetY}`,
    edge: "south",
    targetX,
    targetY,
    distanceDegrees: Math.abs(latitude - (90 - (anchorY + 1) * tileHeight)),
    derivation: "south-level-1-anchor-neighbor",
    siblingKeys,
  };
}

/** Recompute one fixed-camera controlled-visibility observation. */
export function evaluateS5ControlledVisibilityObservation(target, observation) {
  if (
    !target ||
    !Array.isArray(observation?.selectedTileIds) ||
    !Array.isArray(observation?.realTileIds) ||
    !Array.isArray(observation?.fillTileIds)
  ) {
    return undefined;
  }
  const selected = new Set(observation.selectedTileIds);
  const targetSelectedDescendantTileIds = observation.selectedTileIds
    .filter((id) => levelOneAncestorKey(id) === target.key)
    .sort();
  const targetRealDescendantTileIds = observation.realTileIds
    .filter((id) => levelOneAncestorKey(id) === target.key)
    .sort();
  const targetFillDescendantTileIds = observation.fillTileIds
    .filter((id) => levelOneAncestorKey(id) === target.key)
    .sort();
  const selectedRealSiblingTileIds = observation.realTileIds
    .filter((id) => selected.has(id) && target.siblingKeys.includes(id))
    .sort();
  const targetSelected = selected.has(target.key);
  const targetReal = observation.realTileIds.includes(target.key);
  const targetFill = observation.fillTileIds.includes(target.key);
  const targetSelectedStrictDescendantTileIds =
    targetSelectedDescendantTileIds.filter((id) => id !== target.key);
  const targetRealStrictDescendantTileIds = targetRealDescendantTileIds.filter(
    (id) => id !== target.key,
  );
  const targetFillStrictDescendantTileIds = targetFillDescendantTileIds.filter(
    (id) => id !== target.key,
  );
  const siblingSelections = Array.isArray(
    observation.selectedRealSiblingObservations,
  )
    ? observation.selectedRealSiblingObservations
    : [];
  const selectedRealSiblingRendered =
    selectedRealSiblingTileIds.length > 0 &&
    selectedRealSiblingTileIds.every((id) =>
      siblingSelections.some(
        (selection) =>
          selection?.tileId === id &&
          selection?.instantiated === true &&
          selection?.resultFrame === selection?.selectionFrame &&
          selection?.sameFrame === true &&
          selection?.rawResult === 2 &&
          selection?.originalResult === 2 &&
          selection?.rawResultName === "RENDERED" &&
          selection?.originalResultName === "RENDERED" &&
          selection?.wasKicked === false,
      ),
    );
  const targetSelection = observation.targetSelection;
  const targetSameFrameRendered =
    targetSelection?.tileId === target.key &&
    targetSelection?.resultFrame === targetSelection?.selectionFrame &&
    targetSelection?.sameFrame === true &&
    targetSelection?.rawResult === 2 &&
    targetSelection?.originalResult === 2 &&
    targetSelection?.rawResultName === "RENDERED" &&
    targetSelection?.originalResultName === "RENDERED" &&
    targetSelection?.wasKicked === false;
  const targetSameFrameCulled =
    targetSelection?.tileId === target.key &&
    targetSelection?.instantiated === true &&
    targetSelection?.resultFrame === targetSelection?.selectionFrame &&
    targetSelection?.sameFrame === true &&
    targetSelection?.rawResult === 1 &&
    targetSelection?.originalResult === 1 &&
    targetSelection?.rawResultName === "CULLED" &&
    targetSelection?.originalResultName === "CULLED" &&
    targetSelection?.wasKicked === false;
  const noStrictDescendants =
    targetSelectedStrictDescendantTileIds.length === 0 &&
    targetRealStrictDescendantTileIds.length === 0 &&
    targetFillStrictDescendantTileIds.length === 0;
  const targetBranchAbsent =
    targetSelectedDescendantTileIds.length === 0 &&
    targetRealDescendantTileIds.length === 0 &&
    targetFillDescendantTileIds.length === 0;
  return {
    targetSelectedDescendantTileIds,
    targetRealDescendantTileIds,
    targetFillDescendantTileIds,
    selectedRealSiblingTileIds,
    targetSelectedStrictDescendantTileIds,
    targetRealStrictDescendantTileIds,
    targetFillStrictDescendantTileIds,
    targetSelected,
    targetReal,
    targetFill,
    noStrictDescendants,
    targetBranchAbsent,
    selectedRealSiblingRendered,
    directLevelOneNatural:
      observation.settled === true &&
      observation.tilesLoaded === true &&
      !selected.has(target.parentKey) &&
      targetSelected &&
      targetReal &&
      !targetFill &&
      noStrictDescendants &&
      targetSameFrameRendered &&
      selectedRealSiblingRendered,
    warmMaskExact:
      observation.settled === true &&
      observation.tilesLoaded === true &&
      !selected.has(target.parentKey) &&
      targetBranchAbsent &&
      targetSameFrameCulled &&
      selectedRealSiblingRendered,
  };
}

/**
 * Exact production law in GlobeSurfaceTileProvider. The fill-skirt allowance
 * is applied before exaggeration and relative height participates in both
 * endpoints. Using max(0, emax), omitting abs(emin), or adding the skirt after
 * exaggeration is not equivalent.
 */
export function computeExpectedTerrainSurfaceRadius(input) {
  const knownMinimumHeight = input?.knownMinimumHeight;
  const knownMaximumHeight = input?.knownMaximumHeight;
  const ellipsoidMaximumRadius = input?.ellipsoidMaximumRadius;
  const scale = input?.verticalExaggeration;
  const relativeHeight = input?.verticalExaggerationRelativeHeight;
  if (
    ![
      knownMinimumHeight,
      knownMaximumHeight,
      ellipsoidMaximumRadius,
      scale,
      relativeHeight,
    ].every(Number.isFinite) ||
    !(ellipsoidMaximumRadius > 0)
  ) {
    return undefined;
  }

  const exaggeratedMinimum =
    (knownMinimumHeight -
      C12_29_S5_RADIUS_LAW.fillSkirtAllowanceMeters -
      relativeHeight) *
      scale +
    relativeHeight;
  const exaggeratedMaximum =
    (knownMaximumHeight - relativeHeight) * scale + relativeHeight;
  const protectedRadius = computeProtectedTerrainSurfaceRadius(
    ellipsoidMaximumRadius,
    exaggeratedMinimum,
    exaggeratedMaximum,
  );
  return {
    exaggeratedMinimum,
    exaggeratedMaximum,
    ...protectedRadius,
  };
}

function computeProtectedTerrainSurfaceRadius(
  ellipsoidMaximumRadius,
  minimumEndpoint,
  maximumEndpoint,
) {
  const unprotectedRadius =
    ellipsoidMaximumRadius +
    Math.max(Math.abs(minimumEndpoint), Math.abs(maximumEndpoint));
  const safety = Math.max(
    C12_29_S5_RADIUS_LAW.absoluteSafetyMeters,
    unprotectedRadius * C12_29_S5_RADIUS_LAW.relativeSafety,
  );
  return {
    unprotectedRadius,
    safety,
    radius: unprotectedRadius + safety,
  };
}

export function validateS5FinalArtifactShape(artifact) {
  const reasons = [];
  if (artifact?.schema !== C12_29_S5_SCHEMA) {
    reasons.push("artifact schema is not the frozen S5 schema");
  }
  if (!isUuidV4(artifact?.runId)) {
    reasons.push("artifact runId is not an immutable UUID v4 identity");
  }
  if (!FINAL_STATUSES.has(artifact?.status)) {
    reasons.push("artifact status is not final");
  }
  if (artifact?.incomplete !== false) {
    reasons.push("final artifact must set incomplete=false");
  }
  try {
    if (artifact?.exitCode !== exitCodeForS5Status(artifact?.status)) {
      reasons.push("artifact exitCode disagrees with its final status");
    }
  } catch (error) {
    reasons.push(error.message);
  }
  if (artifact?.artifactName !== `${artifact?.runId}.json`) {
    reasons.push("artifactName is not the UUID-named immutable archive");
  }
  if (artifact?.status === "ERROR") {
    const diagnostics = artifact?.diagnostics;
    if (typeof artifact?.error !== "string" || artifact.error.length === 0) {
      reasons.push("ERROR artifact must preserve its error text");
    }
    if (
      diagnostics?.schema !== C12_29_S5_DIAGNOSTICS_SCHEMA ||
      typeof diagnostics?.stage !== "string" ||
      diagnostics.stage.length === 0 ||
      !diagnostics?.node ||
      typeof diagnostics.node.stage !== "string" ||
      diagnostics.node.stage.length === 0 ||
      !Object.hasOwn(diagnostics.node, "requestLedger") ||
      !validRequestLedger(diagnostics.node.requestLedger) ||
      !(
        diagnostics?.renderer === null ||
        C12_29_S5_RENDERERS.includes(diagnostics?.renderer)
      ) ||
      !(
        diagnostics?.page === null ||
        (diagnostics?.renderer !== null &&
          validateS5PageProgress(diagnostics?.page, diagnostics?.renderer).ok)
      )
    ) {
      reasons.push(
        "ERROR artifact must preserve exact pre-session phase/request diagnostics",
      );
    }
  }
  return { ok: reasons.length === 0, reasons };
}

function sameArrayMembers(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right)) return false;
  return (
    left.length === right.length &&
    [...left].sort().every((value, index) => value === [...right].sort()[index])
  );
}

function exactSortedUniqueStrings(value) {
  return (
    Array.isArray(value) &&
    value.every((entry) => typeof entry === "string") &&
    new Set(value).size === value.length &&
    value.every((entry, index) => index === 0 || value[index - 1] < entry)
  );
}

function exactSelectionObservation(observation, tileId, rawResult, name) {
  return (
    observation?.tileId === tileId &&
    observation?.instantiated === true &&
    Number.isInteger(observation?.selectionFrame) &&
    observation?.resultFrame === observation?.selectionFrame &&
    observation?.sameFrame === true &&
    observation?.rawResult === rawResult &&
    observation?.originalResult === rawResult &&
    observation?.rawResultName === name &&
    observation?.originalResultName === name &&
    observation?.wasKicked === false
  );
}

function levelOneAncestorKey(tileId) {
  const match = /^(\d+)\/(\d+)\/(\d+)$/u.exec(tileId ?? "");
  if (!match) return undefined;
  const level = Number(match[1]);
  const x = Number(match[2]);
  const y = Number(match[3]);
  if (![level, x, y].every(Number.isInteger) || level < 1) return undefined;
  const divisor = 2 ** (level - 1);
  return `1/${Math.floor(x / divisor)}/${Math.floor(y / divisor)}`;
}

function exactFingerprint(actual, expected) {
  return (
    actual?.exists === true &&
    actual.byteLength === expected.byteLength &&
    actual.sha256 === expected.sha256
  );
}

function normalizeIdentityPath(value) {
  return typeof value === "string" ? value.replaceAll("\\", "/") : undefined;
}

function isAbsoluteIdentityPath(value) {
  return /^(?:[A-Za-z]:\/|\/)/u.test(normalizeIdentityPath(value) ?? "");
}

function hasExactIdentityPathSuffix(value, suffix) {
  const normalized = normalizeIdentityPath(value);
  return normalized === suffix || normalized?.endsWith(`/${suffix}`) === true;
}

function validBuildSourceIdentity(value) {
  const entries = value?.entries;
  if (
    !exactObjectKeys(value, [
      "ok",
      "entries",
      "reasons",
      "sourceMapPath",
      "sourceMapByteLength",
      "sourceMapSha256",
    ]) ||
    value.ok !== true ||
    !Array.isArray(value.reasons) ||
    value.reasons.length !== 0 ||
    !isAbsoluteIdentityPath(value.sourceMapPath) ||
    !hasExactIdentityPathSuffix(
      value.sourceMapPath,
      C12_29_S5_BUILD_SOURCE_MAP,
    ) ||
    !Number.isInteger(value.sourceMapByteLength) ||
    value.sourceMapByteLength < 1 ||
    !SHA256.test(value.sourceMapSha256 ?? "") ||
    !Array.isArray(entries) ||
    entries.length !== C12_29_S5_BUILD_SOURCE_FILES.length
  ) {
    return false;
  }

  const files = entries.map((entry) => normalizeIdentityPath(entry?.file));
  const mapEntries = entries.map((entry) =>
    normalizeIdentityPath(entry?.sourceMapEntry),
  );
  if (
    new Set(files).size !== C12_29_S5_BUILD_SOURCE_FILES.length ||
    new Set(mapEntries).size !== C12_29_S5_BUILD_SOURCE_FILES.length
  ) {
    return false;
  }

  return C12_29_S5_BUILD_SOURCE_FILES.every((file) => {
    const matches = entries.filter((entry) =>
      hasExactIdentityPathSuffix(entry?.file, file),
    );
    if (matches.length !== 1) return false;
    const entry = matches[0];
    return (
      exactObjectKeys(entry, [
        "file",
        "sourceMapEntry",
        "currentByteLength",
        "embeddedByteLength",
        "currentSha256",
        "embeddedSha256",
        "exact",
        "reason",
      ]) &&
      isAbsoluteIdentityPath(entry.file) &&
      hasExactIdentityPathSuffix(entry.file, file) &&
      normalizeIdentityPath(entry.sourceMapEntry) === `../../${file}` &&
      Number.isInteger(entry.currentByteLength) &&
      entry.currentByteLength > 0 &&
      entry.embeddedByteLength === entry.currentByteLength &&
      SHA256.test(entry.currentSha256 ?? "") &&
      entry.embeddedSha256 === entry.currentSha256 &&
      entry.exact === true &&
      entry.reason === null
    );
  });
}

function validateProvenance(provenance, structural) {
  if (provenance?.ok !== true || provenance?.stable !== true) {
    structural.push("start/end source provenance is not stable and exact");
  }
  if (!/^[0-9a-f]{40}$/u.test(provenance?.gitHead ?? "")) {
    structural.push("git HEAD provenance is absent");
  }
  if (
    !exactFingerprint(provenance?.fixtures?.layer, C12_29_S5_FIXTURE.layer) ||
    !exactFingerprint(provenance?.fixtures?.tile, C12_29_S5_FIXTURE.tile)
  ) {
    structural.push("local QuantizedMesh fixture bytes do not match the pins");
  }
  const header = C12_29_S5_FIXTURE.tile.quantizedMeshHeader;
  if (
    provenance?.quantizedMeshHeader?.ok !== true ||
    provenance?.quantizedMeshHeader?.byteOrder !== header.byteOrder ||
    provenance?.quantizedMeshHeader?.minimumHeightByteOffset !==
      header.minimumHeightByteOffset ||
    provenance?.quantizedMeshHeader?.maximumHeightByteOffset !==
      header.maximumHeightByteOffset ||
    !Object.is(
      provenance?.quantizedMeshHeader?.minimumHeight,
      header.minimumHeight,
    ) ||
    !Object.is(
      provenance?.quantizedMeshHeader?.maximumHeight,
      header.maximumHeight,
    )
  ) {
    structural.push("the QuantizedMesh header height pins are not exact");
  }
  if (
    provenance?.sourceBoundary?.count !== C12_29_S5_SOURCE_FILES.length ||
    !sameArrayMembers(
      provenance?.sourceBoundary?.files,
      C12_29_S5_SOURCE_FILES,
    ) ||
    provenance?.sourceBoundary?.allReadable !== true
  ) {
    structural.push(
      `the exact ${C12_29_S5_SOURCE_FILES.length}-file S5 source boundary is not proven`,
    );
  }
  if (!validBuildSourceIdentity(provenance?.buildSourceIdentity)) {
    structural.push("source-map identity does not cover the build boundary");
  }
  if (
    provenance?.generatedShaders?.globeFsExact !== true ||
    provenance?.generatedShaders?.globeTerrainExact !== true
  ) {
    structural.push("raw/generated globe shader identity is not exact");
  }
  if (
    provenance?.webgpuEclipseBinding?.ok !== true ||
    provenance?.webgpuEclipseBinding?.file !== C12_29_S5_WEBGPU_LAYOUT_FILE ||
    provenance?.webgpuEclipseBinding?.binding !==
      C12_29_S5_WEBGPU_ECLIPSE_BINDING ||
    provenance?.webgpuEclipseBinding?.stage !== "FRAGMENT" ||
    provenance?.webgpuEclipseBinding?.hasDynamicOffset !== true ||
    provenance?.webgpuEclipseBinding?.minimumSizeSymbol !==
      "ECLIPSE_UNIFORM_BYTES"
  ) {
    structural.push("the WebGPU binding-2 eclipse layout marker is not exact");
  }
  if (
    provenance?.servedEntryIdentity?.ok !== true ||
    provenance?.servedEntryIdentity?.expectedLabels?.length !== 2
  ) {
    structural.push("served runtime identity is not exact for both sessions");
  }
  if (provenance?.harnessStable !== true) {
    structural.push("the probe/helper/spec identity changed during the run");
  }
}

function validateImages(session, runId, structural, failures) {
  const images = session?.images;
  if (
    !Array.isArray(images) ||
    images.length !== C12_29_S5_CAPTURE_LABELS.length ||
    !sameArrayMembers(
      images.map((image) => image?.label),
      C12_29_S5_CAPTURE_LABELS,
    )
  ) {
    structural.push(`${session?.renderer}: PNG capture cardinality is wrong`);
    return;
  }
  const ids = new Set();
  const names = new Set();
  for (const image of images) {
    if (
      !isUuidV4(image?.imageId) ||
      ids.has(image.imageId) ||
      image?.fileName !==
        `${runId}.${image?.imageId}.${session.renderer}.${image?.label}.png` ||
      names.has(image.fileName) ||
      !(image?.byteLength > 0) ||
      !SHA256.test(image?.sha256 ?? "") ||
      image?.fingerprintVerified !== true ||
      image?.width !== C12_29_S5_SCENE.viewport.width ||
      image?.height !== C12_29_S5_SCENE.viewport.height
    ) {
      structural.push(
        `${session.renderer}: PNG UUID/hash/byte identity is invalid`,
      );
      break;
    }
    if (
      image?.captureMethod !== C12_29_S5_CAPTURE_METHOD ||
      image?.renderTaskToken !== image?.captureTaskToken
    ) {
      structural.push(
        `${session.renderer}: PNG was not captured in its render task`,
      );
      break;
    }
    ids.add(image.imageId);
    names.add(image.fileName);
  }
  const comparison = session?.x2OffOnComparison;
  if (
    comparison?.sameDimensions !== true ||
    !(comparison?.changedPixels >= 256) ||
    !(comparison?.maximumChannelDelta >= 3)
  ) {
    failures.push(`${session.renderer}: x2 S5 OFF/ON image pair is vacuous`);
  }
}

function validatePhaseCardinality(session, structural) {
  const phases = session?.phases;
  if (
    !phases ||
    !sameArrayMembers(Object.keys(phases), C12_29_S5_PHASES) ||
    Object.keys(phases).length !== C12_29_S5_PHASES.length
  ) {
    structural.push(
      `${session?.renderer}: phase cardinality is not A-H exactly once`,
    );
    return false;
  }
  return true;
}

function validateSession(session, runId, structural, failures) {
  const renderer = session?.renderer ?? "unknown";
  if (
    !C12_29_S5_RENDERERS.includes(renderer) ||
    session.actualRenderer !== renderer
  ) {
    structural.push(`${renderer}: renderer identity is absent or mismatched`);
  }
  if (!validatePhaseCardinality(session, structural)) return;
  if (
    session?.transport?.loopback !== true ||
    session?.transport?.sameOriginOnly !== true ||
    (session?.transport?.externalRequests?.length ?? 0) !== 0 ||
    (session?.transport?.failedRequests?.length ?? 0) !== 0 ||
    (session?.transport?.httpErrors?.length ?? 0) !== 0
  ) {
    structural.push(
      `${renderer}: browser transport escaped loopback/offline scope`,
    );
  }
  if (
    session?.runtime?.pageErrors?.length !== 0 ||
    session?.runtime?.consoleErrors?.length !== 0 ||
    session?.runtime?.gpuErrors?.length !== 0 ||
    session?.runtime?.deviceLost !== false ||
    session?.runtime?.cleanupComplete !== true
  ) {
    structural.push(`${renderer}: browser/GPU error or cleanup proof is red`);
  }
  if (
    session?.sameTaskCapture?.method !== C12_29_S5_CAPTURE_METHOD ||
    session?.sameTaskCapture?.canonicalSourcePinned !== true ||
    session?.sameTaskCapture?.yieldBetweenRenderAndRead !== false
  ) {
    structural.push(`${renderer}: canonical same-task capture proof is absent`);
  }
  if (
    session?.fixture?.pinnedIso !== C12_29_S5_SCENE.pinnedIso ||
    session?.fixture?.clockIso !== C12_29_S5_SCENE.pinnedIso ||
    session?.fixture?.cameraHeightMeters !==
      C12_29_S5_SCENE.cameraHeightMeters ||
    !Number.isFinite(session?.fixture?.actualCameraHeightMeters) ||
    Math.abs(
      session?.fixture?.actualCameraHeightMeters -
        C12_29_S5_SCENE.cameraHeightMeters,
    ) > 1e-3 ||
    !Number.isFinite(session?.fixture?.cameraFovDegrees) ||
    Math.abs(
      session?.fixture?.cameraFovDegrees - C12_29_S5_SCENE.cameraFovDegrees,
    ) > 1e-12 ||
    session?.fixture?.viewport?.width !== C12_29_S5_SCENE.viewport.width ||
    session?.fixture?.viewport?.height !== C12_29_S5_SCENE.viewport.height ||
    session?.fixture?.trackDerivation !==
      "live-f64-ephemeris-global-grid-plus-two-refinements" ||
    !(session?.fixture?.deepestTrack?.magnitude > 0.95)
  ) {
    structural.push(`${renderer}: named-event camera/clock fixture is inexact`);
  }

  const phases = session.phases;
  const a = phases["A-ellipsoid-stable"];
  if (
    a?.provider !== "EllipsoidTerrainProvider" ||
    a?.stable !== true ||
    a?.tilesLoaded !== true ||
    !(a?.selectedCount > 0)
  ) {
    structural.push(`${renderer}: ellipsoid control did not settle`);
  }

  const b = phases["B-held-provider-swap"];
  const bPublicAssignment = b?.publicAssignment;
  const bPropagation = b?.firstBeginFramePropagation;
  if (
    b?.fromProvider !== "EllipsoidTerrainProvider" ||
    b?.toProvider !== "CesiumTerrainProvider-held" ||
    bPublicAssignment?.sceneProviderMatches !== true ||
    bPublicAssignment?.tileProviderAwaitingFirstBeginFrame !== true ||
    bPublicAssignment?.terrainRequestsBeforeFirstFrame !== 0 ||
    bPropagation?.observedAt !==
      "first-pinned-render-after-globe.beginFrame-before-selection-load" ||
    bPropagation?.beginFrameCallOrdinal !== 1 ||
    bPropagation?.tileProviderIdentityPreserved !== true ||
    bPropagation?.tileProviderMatchesAssigned !== true ||
    bPropagation?.publicProviderMatchesAssigned !== true ||
    bPropagation?.terrainRequestAttemptsAtObservation !== 0 ||
    bPropagation?.observedBeforeSelectionAndLoad !== true ||
    bPropagation?.observedInFirstRender !== true ||
    bPropagation?.selectionRevisionUnchanged !== true ||
    !Number.isInteger(bPropagation?.selectionRevisionBefore) ||
    bPropagation?.selectionRevisionAtObservation !==
      bPropagation?.selectionRevisionBefore ||
    !Number.isInteger(bPropagation?.contentRevisionBefore) ||
    !Number.isInteger(bPropagation?.contentRevisionAtObservation)
  ) {
    structural.push(
      `${renderer}: provider swap first-beginFrame observation is incomplete`,
    );
  }
  if (
    bPropagation?.surfaceRadiusUndefined !== true ||
    bPropagation?.knownMinimumHeight !== 0 ||
    bPropagation?.knownMaximumHeight !== 0 ||
    bPropagation?.knownBoundsValid !== true ||
    bPropagation?.contentRevisionAdvanced !== true ||
    !(
      bPropagation?.contentRevisionAtObservation >
      bPropagation?.contentRevisionBefore
    )
  ) {
    failures.push(
      `${renderer}: first beginFrame propagation did not reset S5 bounds before terrain load/selection publication`,
    );
  }

  const c = phases["C-fill-held"];
  const warmup = c?.warmup;
  const holdArm = c?.holdArm;
  const firstReveal = c?.firstRevealProof;
  const lod = a?.fillLodPrecondition;
  const seam = c?.visibilitySeam;
  const expectedHeldTarget = deriveS5SouthLevelOneTarget(
    session?.fixture?.deepestTrack?.longitude,
    session?.fixture?.deepestTrack?.latitude,
  );
  const exactTarget = (target) =>
    target?.level === expectedHeldTarget?.level &&
    target?.anchorKey === expectedHeldTarget?.anchorKey &&
    target?.parentKey === expectedHeldTarget?.parentKey &&
    target?.key === expectedHeldTarget?.key &&
    target?.edge === expectedHeldTarget?.edge &&
    target?.targetX === expectedHeldTarget?.targetX &&
    target?.targetY === expectedHeldTarget?.targetY &&
    Object.is(target?.distanceDegrees, expectedHeldTarget?.distanceDegrees) &&
    target?.derivation === expectedHeldTarget?.derivation &&
    sameArrayMembers(target?.siblingKeys, expectedHeldTarget?.siblingKeys);
  const expectedSiblingKey = expectedHeldTarget?.anchorKey;
  const sseInputs = lod?.sseInputs;
  const recomputedParentSse =
    (sseInputs?.levelZeroGeometricError * sseInputs?.drawingBufferHeight) /
    (sseInputs?.parentDistance *
      sseInputs?.sseDenominator *
      sseInputs?.pixelRatio);
  const recomputedTargetSse =
    (sseInputs?.levelOneGeometricError * sseInputs?.drawingBufferHeight) /
    (sseInputs?.targetDistance *
      sseInputs?.sseDenominator *
      sseInputs?.pixelRatio);
  const warmSseInputs = warmup?.sseInputs;
  const recomputedWarmParentSse =
    (warmSseInputs?.levelZeroGeometricError *
      warmSseInputs?.drawingBufferHeight) /
    (warmSseInputs?.parentDistance *
      warmSseInputs?.sseDenominator *
      warmSseInputs?.pixelRatio);
  const recomputedWarmTargetSse =
    (warmSseInputs?.levelOneGeometricError *
      warmSseInputs?.drawingBufferHeight) /
    (warmSseInputs?.targetDistance *
      warmSseInputs?.sseDenominator *
      warmSseInputs?.pixelRatio);
  const lodTargetDescendants = lod?.selectedTileIds?.filter(
    (id) =>
      id !== expectedHeldTarget?.key &&
      levelOneAncestorKey(id) === expectedHeldTarget?.key,
  );
  if (
    !exactTarget(lod?.target) ||
    lod?.claim !== "fixed-camera-direct-level-one-no-scan" ||
    lod?.derivation !== "pinned-sse-production-selection" ||
    lod?.siblingKey !== expectedSiblingKey ||
    lod?.maximumScreenSpaceError !==
      C12_29_S5_SCENE.fillFrontierMaximumScreenSpaceError ||
    !Object.is(lod?.longitude, session.fixture.deepestTrack.longitude) ||
    !Object.is(lod?.latitude, session.fixture.deepestTrack.latitude) ||
    Math.abs(lod?.cameraHeightMeters - C12_29_S5_SCENE.cameraHeightMeters) >
      1e-3 ||
    Math.abs(lod?.cameraFovDegrees - C12_29_S5_SCENE.cameraFovDegrees) >
      1e-12 ||
    lod?.preloadSiblings !== false ||
    lod?.preloadAncestors !== false ||
    lod?.cameraReference?.cameraCartographicInsideTarget !== false ||
    lod?.cameraReference?.referenceFrameOriginDefined !== false ||
    lod?.cameraReference?.referenceFrameOriginInsideTarget !== false ||
    lod?.cameraReference?.neededPositionInsideTarget !== false ||
    sseInputs?.drawingBufferHeight !== C12_29_S5_SCENE.viewport.height ||
    sseInputs?.pixelRatio !== 1 ||
    !(sseInputs?.sseDenominator > 0) ||
    !(sseInputs?.levelZeroGeometricError > 0) ||
    !(sseInputs?.levelOneGeometricError > 0) ||
    !Object.is(
      sseInputs?.levelOneGeometricError,
      sseInputs?.levelZeroGeometricError / 2,
    ) ||
    !(sseInputs?.parentDistance > 0) ||
    !(sseInputs?.targetDistance > 0) ||
    !Object.is(sseInputs?.parentComputedSse, recomputedParentSse) ||
    !Object.is(sseInputs?.targetComputedSse, recomputedTargetSse) ||
    !(
      sseInputs?.parentComputedSse >
      C12_29_S5_SCENE.fillFrontierMaximumScreenSpaceError
    ) ||
    !(
      sseInputs?.targetComputedSse <=
      C12_29_S5_SCENE.fillFrontierMaximumScreenSpaceError
    ) ||
    !exactSortedUniqueStrings(lod?.selectedTileIds) ||
    !exactSortedUniqueStrings(lod?.realTileIds) ||
    !exactSortedUniqueStrings(lod?.fillTileIds) ||
    !lod.selectedTileIds.includes(expectedHeldTarget?.key) ||
    !lod.realTileIds.includes(expectedHeldTarget?.key) ||
    lod.fillTileIds.includes(expectedHeldTarget?.key) ||
    lod.selectedTileIds.includes(expectedHeldTarget?.parentKey) ||
    !Array.isArray(lodTargetDescendants) ||
    lodTargetDescendants.length !== 0 ||
    !exactSelectionObservation(
      lod?.parentSelection,
      expectedHeldTarget?.parentKey,
      3,
      "REFINED",
    ) ||
    !exactSelectionObservation(
      lod?.targetSelection,
      expectedHeldTarget?.key,
      2,
      "RENDERED",
    ) ||
    !exactSelectionObservation(
      lod?.siblingSelection,
      expectedSiblingKey,
      2,
      "RENDERED",
    )
  ) {
    structural.push(
      `${renderer}: fixed-SSE direct level-one target/sibling precondition is absent`,
    );
  }

  const calls = seam?.calls;
  const counts = seam?.counts;
  const callsExact =
    Array.isArray(calls) &&
    calls.length > 0 &&
    calls.every(validVisibilityCall);
  const computedCounts = callsExact
    ? {
        totalCalls: calls.length,
        originalCalls: calls.filter((call) => call.originalCallCompleted)
          .length,
        targetCalls: calls.filter((call) => call.target).length,
        nonTargetCalls: calls.filter((call) => !call.target).length,
        overrideCalls: calls.filter((call) => call.overridden).length,
        nonTargetAlteredCalls: calls.filter(
          (call) => !call.target && call.overridden,
        ).length,
        skippedOriginalCalls: calls.filter(
          (call) => !call.originalCallCompleted,
        ).length,
      }
    : undefined;
  const warmFrameCalls = callsExact
    ? calls.filter(
        (call) =>
          call.frameNumber === warmup?.targetSelection?.selectionFrame &&
          call.tileKey === expectedHeldTarget?.key,
      )
    : [];
  const revealFrameCalls = callsExact
    ? calls.filter(
        (call) =>
          call.frameNumber === firstReveal?.targetSelection?.selectionFrame &&
          call.tileKey === expectedHeldTarget?.key,
      )
    : [];
  const allWarmTargetCalls = callsExact
    ? calls.filter((call) => call.target && call.mode === "warm-mask")
    : [];
  const descriptorRestored =
    seam?.restoration?.attempted === true &&
    seam?.restoration?.restored === true &&
    seam?.restoration?.immediateAfterReveal === true &&
    seam?.restoration?.beforeRelease === true &&
    seam?.restoration?.identityMatches === true &&
    seam?.restoration?.descriptorMatches === true &&
    seam?.restoration?.finallyVerified === true &&
    seam?.restoration?.afterHadOwn === seam?.installation?.beforeHadOwn &&
    JSON.stringify(seam?.restoration?.afterDescriptor ?? null) ===
      JSON.stringify(seam?.installation?.beforeDescriptor ?? null);
  if (
    seam?.claim !==
      "controlled-visibility-input-production-selection-request-fill-release-render" ||
    seam?.method !== "GlobeSurfaceTileProvider.computeTileVisibility" ||
    seam?.maskMode !== "warm-only-exact-target-Visibility.NONE" ||
    seam?.targetKey !== expectedHeldTarget?.key ||
    seam?.siblingKey !== expectedSiblingKey ||
    seam?.maximumScreenSpaceError !==
      C12_29_S5_SCENE.fillFrontierMaximumScreenSpaceError ||
    seam?.installation?.originalIdentityCaptured !== true ||
    seam?.installation?.prototypeDescriptorFound !== true ||
    seam?.installation?.beforeHadOwn !== false ||
    seam?.installation?.beforeDescriptor !== null ||
    seam?.installation?.installedHadOwn !== true ||
    seam?.installation?.installedDescriptor?.configurable !== true ||
    seam?.installation?.installedDescriptor?.writable !== true ||
    seam?.installation?.installedDescriptor?.hasValue !== true ||
    seam?.installation?.installedDescriptor?.hasGetter !== false ||
    seam?.installation?.installedDescriptor?.hasSetter !== false ||
    seam?.installation?.installedWrapperIdentityMatches !== true ||
    !callsExact ||
    calls.length > C12_29_S5_SCENE.fillWarmMaximumFrames * 64 ||
    !counts ||
    !Object.keys(computedCounts ?? {}).every(
      (key) => counts[key] === computedCounts[key],
    ) ||
    counts.totalCalls !== calls.length ||
    counts.originalCalls !== calls.length ||
    counts.skippedOriginalCalls !== 0 ||
    counts.nonTargetAlteredCalls !== 0 ||
    calls.some(
      (call) => call.target !== (call.tileKey === expectedHeldTarget?.key),
    ) ||
    counts.overrideCalls !== allWarmTargetCalls.length ||
    allWarmTargetCalls.length < 1 ||
    !allWarmTargetCalls.every(
      (call) =>
        new Set([0, 1]).has(call.originalVisibility) &&
        call.returnedVisibility === -1 &&
        call.overridden === true,
    ) ||
    calls.some(
      (call) => call.overridden && (!call.target || call.mode !== "warm-mask"),
    ) ||
    warmFrameCalls.length < 1 ||
    !warmFrameCalls.every(
      (call) =>
        new Set([0, 1]).has(call.originalVisibility) &&
        call.returnedVisibility === -1 &&
        call.overridden === true &&
        call.mode === "warm-mask",
    ) ||
    revealFrameCalls.length < 1 ||
    !revealFrameCalls.every(
      (call) =>
        new Set([0, 1]).has(call.originalVisibility) &&
        call.returnedVisibility === call.originalVisibility &&
        call.overridden === false &&
        call.mode === "pass-through",
    ) ||
    !sameArrayMembers(
      seam?.warmTargetCallOrdinals,
      warmFrameCalls.map((call) => call.ordinal),
    ) ||
    !sameArrayMembers(
      seam?.revealTargetCallOrdinals,
      revealFrameCalls.map((call) => call.ordinal),
    ) ||
    seam?.modeSwitch?.from !== "warm-mask" ||
    seam?.modeSwitch?.to !== "pass-through" ||
    seam?.modeSwitch?.sameTaskReveal !== true ||
    seam?.modeSwitch?.warmFrame !== warmup?.targetSelection?.selectionFrame ||
    seam?.modeSwitch?.revealFrame !==
      firstReveal?.targetSelection?.selectionFrame ||
    seam?.modeSwitch?.revealFrame !== seam?.modeSwitch?.warmFrame + 1 ||
    seam?.restoration?.attemptedAt !== "immediately-after-reveal-snapshot" ||
    !descriptorRestored
  ) {
    structural.push(
      `${renderer}: exact-target warm-only visibility seam/call/restoration proof is invalid`,
    );
  }
  const warmSiblingExact =
    Array.isArray(warmup?.selectedRealSiblingObservations) &&
    warmup?.selectedRealSiblingTileIds?.includes(expectedSiblingKey) &&
    warmup.selectedRealSiblingObservations.some((selection) =>
      exactSelectionObservation(selection, expectedSiblingKey, 2, "RENDERED"),
    );
  const revealSiblingExact =
    Array.isArray(firstReveal?.selectedRealSiblingObservations) &&
    firstReveal?.selectedRealSiblingTileIds?.includes(expectedSiblingKey) &&
    firstReveal.selectedRealSiblingObservations.some((selection) =>
      exactSelectionObservation(selection, expectedSiblingKey, 2, "RENDERED"),
    );
  if (
    !exactTarget(c?.holdTarget) ||
    warmup?.proofCompletedBeforeArm !== true ||
    warmup?.settled !== true ||
    warmup?.boundedMaxFrames !== C12_29_S5_SCENE.fillWarmMaximumFrames ||
    !Number.isInteger(warmup?.settleFrames) ||
    warmup.settleFrames < 1 ||
    warmup.settleFrames > warmup.boundedMaxFrames ||
    !Number.isInteger(warmup?.stableFrames) ||
    warmup.stableFrames < 3 ||
    warmup?.tilesLoaded !== true ||
    warmup?.fillCount !== 0 ||
    !Object.is(warmup?.longitude, session.fixture.deepestTrack.longitude) ||
    !Object.is(warmup?.latitude, session.fixture.deepestTrack.latitude) ||
    Math.abs(warmup?.cameraHeightMeters - C12_29_S5_SCENE.cameraHeightMeters) >
      1e-3 ||
    Math.abs(warmup?.cameraFovDegrees - C12_29_S5_SCENE.cameraFovDegrees) >
      1e-12 ||
    warmup?.maximumScreenSpaceError !==
      C12_29_S5_SCENE.fillFrontierMaximumScreenSpaceError ||
    warmup?.preloadSiblings !== false ||
    warmup?.preloadAncestors !== false ||
    warmup?.holdTargetUndefinedDuringWarmup !== true ||
    warmup?.holdInterceptionEnabled !== false ||
    warmup?.heldRequestCount !== 0 ||
    warmup?.reservedPromiseCount !== 0 ||
    warmup?.targetKey !== expectedHeldTarget?.key ||
    warmup?.targetRequestAttempts !== 0 ||
    warmup?.targetHeldPromisePresent !== false ||
    warmup?.targetReservedPromisePresent !== false ||
    !exactSortedUniqueStrings(warmup?.targetSelectedDescendantTileIds) ||
    warmup.targetSelectedDescendantTileIds.length !== 0 ||
    !exactSortedUniqueStrings(warmup?.targetRealDescendantTileIds) ||
    warmup.targetRealDescendantTileIds.length !== 0 ||
    !exactSortedUniqueStrings(warmup?.targetFillDescendantTileIds) ||
    warmup.targetFillDescendantTileIds.length !== 0 ||
    !exactSelectionObservation(
      warmup?.targetSelection,
      expectedHeldTarget?.key,
      1,
      "CULLED",
    ) ||
    !exactSelectionObservation(
      warmup?.parentSelection,
      expectedHeldTarget?.parentKey,
      3,
      "REFINED",
    ) ||
    warmup?.cameraReference?.cameraCartographicInsideTarget !== false ||
    warmup?.cameraReference?.referenceFrameOriginDefined !== false ||
    warmup?.cameraReference?.referenceFrameOriginInsideTarget !== false ||
    warmup?.cameraReference?.neededPositionInsideTarget !== false ||
    warmSseInputs?.drawingBufferHeight !== C12_29_S5_SCENE.viewport.height ||
    warmSseInputs?.pixelRatio !== 1 ||
    !(warmSseInputs?.sseDenominator > 0) ||
    !(warmSseInputs?.levelZeroGeometricError > 0) ||
    !(warmSseInputs?.levelOneGeometricError > 0) ||
    !Object.is(
      warmSseInputs?.levelOneGeometricError,
      warmSseInputs?.levelZeroGeometricError / 2,
    ) ||
    !(warmSseInputs?.parentDistance > 0) ||
    !(warmSseInputs?.targetDistance > 0) ||
    !Object.is(warmSseInputs?.parentComputedSse, recomputedWarmParentSse) ||
    !Object.is(warmSseInputs?.targetComputedSse, recomputedWarmTargetSse) ||
    !(
      warmSseInputs?.parentComputedSse >
      C12_29_S5_SCENE.fillFrontierMaximumScreenSpaceError
    ) ||
    !(
      warmSseInputs?.targetComputedSse <=
      C12_29_S5_SCENE.fillFrontierMaximumScreenSpaceError
    ) ||
    warmup?.siblingKey !== expectedSiblingKey ||
    !sameArrayMembers(
      warmup?.visibilityTargetCallOrdinals,
      warmFrameCalls.map((call) => call.ordinal),
    ) ||
    !warmSiblingExact ||
    holdArm?.afterSettledWarmup !== true ||
    holdArm?.assignedAfterWarmProof !== true ||
    holdArm?.warmProofFrame !== warmup?.targetSelection?.selectionFrame ||
    holdArm?.targetKey !== expectedHeldTarget?.key ||
    holdArm?.holdInterceptionEnabledBefore !== false ||
    holdArm?.holdInterceptionEnabledAfter !== true ||
    holdArm?.targetRequestAttemptsBefore !== 0 ||
    holdArm?.targetReservedBefore !== false ||
    holdArm?.heldRequestCountBefore !== 0 ||
    holdArm?.visibilityModeBefore !== "warm-mask" ||
    holdArm?.visibilityModeAfter !== "pass-through" ||
    holdArm?.cameraMovedForReveal !== false ||
    Math.abs(holdArm?.cameraFovDegrees - C12_29_S5_SCENE.cameraFovDegrees) >
      1e-12 ||
    Math.abs(holdArm?.cameraHeightMeters - C12_29_S5_SCENE.cameraHeightMeters) >
      1e-3 ||
    holdArm?.maximumScreenSpaceError !==
      C12_29_S5_SCENE.fillFrontierMaximumScreenSpaceError ||
    firstReveal?.captureWasFirstRenderAfterPassThrough !== true ||
    firstReveal?.sameTaskModeSwitchAndCapture !== true ||
    firstReveal?.noYieldBeforeCapture !== true ||
    firstReveal?.frameDelta !== 1 ||
    firstReveal?.frameAfter !== firstReveal?.frameBefore + 1 ||
    !Object.is(
      firstReveal?.longitude,
      session.fixture.deepestTrack.longitude,
    ) ||
    !Object.is(firstReveal?.latitude, session.fixture.deepestTrack.latitude) ||
    Math.abs(
      firstReveal?.cameraHeightMeters - C12_29_S5_SCENE.cameraHeightMeters,
    ) > 1e-3 ||
    Math.abs(firstReveal?.cameraFovDegrees - C12_29_S5_SCENE.cameraFovDegrees) >
      1e-12 ||
    firstReveal?.maximumScreenSpaceError !==
      C12_29_S5_SCENE.fillFrontierMaximumScreenSpaceError ||
    firstReveal?.targetRequestAttemptsBefore !== 0 ||
    firstReveal?.targetRequestAttemptsAfter !== 1 ||
    firstReveal?.postArmTargetRequestAttempts !== 1 ||
    !exactSelectionObservation(
      firstReveal?.targetSelection,
      expectedHeldTarget?.key,
      2,
      "RENDERED",
    ) ||
    !exactSortedUniqueStrings(
      firstReveal?.targetSelectedStrictDescendantTileIds,
    ) ||
    firstReveal.targetSelectedStrictDescendantTileIds.length !== 0 ||
    firstReveal?.siblingKey !== expectedSiblingKey ||
    !sameArrayMembers(
      firstReveal?.visibilityTargetCallOrdinals,
      revealFrameCalls.map((call) => call.ordinal),
    ) ||
    !revealSiblingExact ||
    firstReveal?.heldRequestCount !== 1 ||
    firstReveal?.heldKeys?.length !== 1 ||
    firstReveal.heldKeys[0] !== expectedHeldTarget?.key ||
    firstReveal?.loadedAndFillFlags !== true ||
    firstReveal?.targetSelected !== true ||
    firstReveal?.targetFill !== true ||
    firstReveal?.fillMesh?.tileId !== expectedHeldTarget?.key ||
    firstReveal?.fillMesh?.terrainFillMeshInstance !== true ||
    firstReveal?.fillMesh?.renderedMeshMatches !== true ||
    firstReveal?.fillMesh?.realMeshAbsent !== true ||
    !(firstReveal?.fillMesh?.vertexCount > 0) ||
    !(firstReveal?.fillMesh?.indexCount > 0) ||
    c?.holdInterceptionEnabled !== true ||
    Math.abs(c?.cameraFovDegrees - C12_29_S5_SCENE.cameraFovDegrees) > 1e-12 ||
    c?.maximumScreenSpaceError !==
      C12_29_S5_SCENE.fillFrontierMaximumScreenSpaceError ||
    c?.preloadSiblings !== false ||
    c?.holdTargetReserved !== true ||
    c?.holdTargetRequestAttemptsAfterArm !== 1 ||
    c?.heldRequestCount !== 1 ||
    c?.heldKeys?.length !== 1 ||
    c.heldKeys[0] !== expectedHeldTarget?.key ||
    c?.fillCount < 1 ||
    c?.loadedAndFillFlags !== true ||
    !c?.fillTileIds?.includes(expectedHeldTarget?.key) ||
    !c?.selectedTileIds?.includes(expectedHeldTarget?.key) ||
    c?.heldTargetIntersectsSelectedFill !== true ||
    !c?.realSiblingTileIds?.includes(expectedSiblingKey) ||
    !c?.realTileIds?.includes(expectedSiblingKey) ||
    !c?.selectedTileIds?.includes(expectedSiblingKey) ||
    c?.heldTargetDecodedBeforeRelease !== true
  ) {
    structural.push(
      `${renderer}: pass-through reveal did not produce exactly one direct level-one held TerrainFillMesh`,
    );
  }
  if (
    !(c?.decodedQuantizedMeshCount > 0) ||
    !(c?.realMeshCount > 0) ||
    c?.decodedFixtureIdentity !== "QuantizedMeshTerrainData-instance" ||
    c?.decodedFixtureIdentityVerified !== true
  ) {
    structural.push(`${renderer}: decoded QuantizedMesh nonvacuity is absent`);
  }
  const decodedFixtureBounds = c?.decodedFixtureBounds;
  const header = C12_29_S5_FIXTURE.tile.quantizedMeshHeader;
  if (
    !Array.isArray(decodedFixtureBounds) ||
    decodedFixtureBounds.length === 0 ||
    !decodedFixtureBounds.some((entry) =>
      c?.heldKeys?.includes(entry?.tileId),
    ) ||
    !decodedFixtureBounds.every(
      (entry) =>
        Object.is(entry?.minimumHeight, header.minimumHeight) &&
        Object.is(entry?.maximumHeight, header.maximumHeight),
    )
  ) {
    structural.push(
      `${renderer}: decoded fixture bounds do not match the independent header pins`,
    );
  }

  const d = phases["D-real-x1"];
  const trackRestore = d?.trackRestore;
  if (
    d?.holdTargetKey !== c?.holdTarget?.key ||
    d?.holdInterceptionEnabled !== false ||
    d?.visibilitySeamRestoredBeforeRelease !== true ||
    d?.heldRequestCountAfterRelease !== 0 ||
    d?.releasedKeys?.length !== 1 ||
    d?.releasedKeys?.[0] !== expectedHeldTarget?.key ||
    d?.releasedTargetKey !== expectedHeldTarget?.key ||
    d?.releasedRequestCount !== 1 ||
    d?.newHeldRequestCountAfterRelease !== 0
  ) {
    structural.push(
      `${renderer}: hold interception was not disabled before the one release`,
    );
  }
  if (
    d?.tilesLoaded !== true ||
    d?.fillCount !== 0 ||
    !(d?.decodedQuantizedMeshCount > 0) ||
    !Array.isArray(d?.transitionedKeys) ||
    d.transitionedKeys.length !== 1 ||
    d.transitionedKeys[0] !== expectedHeldTarget?.key ||
    d?.transitionObservation?.tileId !== expectedHeldTarget?.key ||
    d?.transitionObservation?.selected !== true ||
    d?.transitionObservation?.renderedReal !== true ||
    d?.transitionObservation?.renderedFill !== false ||
    !Number.isInteger(d?.transitionObservation?.frame) ||
    d.transitionObservation.frame < 1 ||
    trackRestore?.settled !== true ||
    trackRestore?.boundedMaxFrames !== 240 ||
    !Number.isInteger(trackRestore?.settleFrames) ||
    trackRestore.settleFrames < 1 ||
    trackRestore.settleFrames > trackRestore.boundedMaxFrames ||
    !Number.isInteger(trackRestore?.stableFrames) ||
    trackRestore.stableFrames < 3 ||
    Math.abs(trackRestore?.longitude - session.fixture.deepestTrack.longitude) >
      1e-12 ||
    Math.abs(trackRestore?.latitude - session.fixture.deepestTrack.latitude) >
      1e-12 ||
    !Object.is(
      trackRestore?.targetLongitude,
      session.fixture.deepestTrack.longitude,
    ) ||
    !Object.is(
      trackRestore?.targetLatitude,
      session.fixture.deepestTrack.latitude,
    ) ||
    Math.abs(
      trackRestore?.cameraHeightMeters - C12_29_S5_SCENE.cameraHeightMeters,
    ) > 1e-3 ||
    Math.abs(
      trackRestore?.cameraFovDegrees - C12_29_S5_SCENE.cameraFovDegrees,
    ) > 1e-12 ||
    trackRestore?.maximumScreenSpaceError !==
      C12_29_S5_SCENE.terrainMaximumScreenSpaceError
  ) {
    failures.push(
      `${renderer}: held fill did not transition to real x1 terrain`,
    );
  }

  const e = phases["E-real-x2"];
  const expectedRadius = computeExpectedTerrainSurfaceRadius({
    knownMinimumHeight: e?.knownMinimumHeight,
    knownMaximumHeight: e?.knownMaximumHeight,
    ellipsoidMaximumRadius: e?.ellipsoidMaximumRadius,
    verticalExaggeration: e?.verticalExaggeration,
    verticalExaggerationRelativeHeight: e?.verticalExaggerationRelativeHeight,
  });
  const knownEnvelopeAdvanced =
    Number.isFinite(e?.knownMinimumHeight) &&
    Number.isFinite(e?.knownMaximumHeight) &&
    e.knownMinimumHeight < 0 &&
    e.knownMaximumHeight > 0 &&
    e.knownMinimumHeight <= header.minimumHeight &&
    e.knownMaximumHeight >= header.maximumHeight;
  if (!knownEnvelopeAdvanced) {
    failures.push(
      `${renderer}: real-mesh terrain envelope did not advance from reset and enclose the fixture header`,
    );
  }
  const minimumWithoutFillSkirt =
    (e?.knownMinimumHeight - e?.verticalExaggerationRelativeHeight) *
      e?.verticalExaggeration +
    e?.verticalExaggerationRelativeHeight;
  const omittedSkirtRadius = computeProtectedTerrainSurfaceRadius(
    e?.ellipsoidMaximumRadius,
    minimumWithoutFillSkirt,
    expectedRadius?.exaggeratedMaximum,
  );
  const postExaggerationSkirtRadius = computeProtectedTerrainSurfaceRadius(
    e?.ellipsoidMaximumRadius,
    minimumWithoutFillSkirt - C12_29_S5_RADIUS_LAW.fillSkirtAllowanceMeters,
    expectedRadius?.exaggeratedMaximum,
  );
  const skirtPremiseNonvacuous =
    expectedRadius &&
    Math.abs(expectedRadius.exaggeratedMinimum) >
      Math.abs(expectedRadius.exaggeratedMaximum) &&
    !Object.is(expectedRadius.radius, omittedSkirtRadius.radius) &&
    !Object.is(expectedRadius.radius, postExaggerationSkirtRadius.radius);
  if (!skirtPremiseNonvacuous) {
    structural.push(
      `${renderer}: the real x2 radius does not make the fill-skirt premise nonvacuous`,
    );
  }
  if (
    e?.verticalExaggeration !== C12_29_S5_SCENE.verticalExaggeration ||
    e?.verticalExaggerationRelativeHeight !==
      C12_29_S5_SCENE.verticalExaggerationRelativeHeight ||
    !expectedRadius ||
    !Object.is(e?.expectedSurfaceRadius, expectedRadius.radius) ||
    !Object.is(e?.surfaceRadius, expectedRadius.radius)
  ) {
    failures.push(
      `${renderer}: exaggerated terrain radius is not the exact law`,
    );
  }
  if (
    e?.mainViewOwnerMatches !== true ||
    e?.prepared !== true ||
    e?.preparedSelectionRevision !== e?.providerSelectionRevision ||
    !Object.is(e?.preparedSurfaceRadius, e?.surfaceRadius) ||
    !sameArrayMembers(e?.preparedSelectedTileIds, e?.selectedTileIds)
  ) {
    failures.push(`${renderer}: main-view S5 owner/prepared tuple is inexact`);
  }
  const webgpuCommandPrewarm = e?.webgpuCommandMaterializationPrewarm;
  if (renderer === "webgl") {
    if (
      webgpuCommandPrewarm?.applicable !== false ||
      webgpuCommandPrewarm?.reason !==
        "WebGPU-only native globe command materialization"
    ) {
      structural.push(
        "webgl: native WebGPU globe prewarm must be explicit N/A",
      );
    }
  } else {
    const validCarrierState = (proof, carrierState, eclipseEnabled) => {
      const expectedShadow = eclipseEnabled
        ? proof?.frameShadowActive === true && proof?.frameShadowGate > 0.5
        : proof?.frameShadowActive === false && proof?.frameShadowGate === 0;
      return (
        proof?.applicable === true &&
        proof?.carrierState === carrierState &&
        proof?.eclipseEnabled === eclipseEnabled &&
        proof?.lightingFlagMatches === true &&
        proof?.frameShadowPrepared === true &&
        expectedShadow &&
        Number.isInteger(proof?.frameShadowRevision) &&
        Number.isInteger(proof?.frameSelectionRevision) &&
        proof?.route ===
          "scene.frameState.commandList/Pass.GLOBE/native-WebGPU" &&
        proof?.commandIdentity ===
          "isWebGPUDrawCommand===true+pass===Pass.GLOBE" &&
        proof?.boundedMaxFrames === C12_29_S5_WEBGPU_PREWARM_MAX_FRAMES &&
        Number.isInteger(proof?.frames) &&
        proof.frames >= 1 &&
        proof.frames <= C12_29_S5_WEBGPU_PREWARM_MAX_FRAMES &&
        proof?.settled === true &&
        Number.isInteger(proof?.emittedCommandCount) &&
        proof.emittedCommandCount > 0 &&
        proof?.materializedCommandCount === proof.emittedCommandCount &&
        proof?.positiveIndexCommandCount === proof.emittedCommandCount &&
        proof?.threeDynamicOffsetCommandCount === proof.emittedCommandCount &&
        Array.isArray(proof?.pipelineIdentityIds) &&
        proof.pipelineIdentityIds.length > 0 &&
        new Set(proof.pipelineIdentityIds).size ===
          proof.pipelineIdentityIds.length &&
        proof.pipelineIdentityIds.every(
          (identity) =>
            typeof identity === "string" &&
            /^pipeline-[1-9]\d*$/u.test(identity),
        ) &&
        Array.isArray(proof?.pipelineLabels) &&
        proof.pipelineLabels.every(
          (label) => typeof label === "string" && label.length > 0,
        ) &&
        Array.isArray(proof?.ownerTileIds) &&
        exactSortedUniqueStrings(proof.ownerTileIds) &&
        proof.ownerTileIds.length > 0 &&
        Number.isInteger(proof?.frameNumber)
      );
    };
    if (
      webgpuCommandPrewarm?.applicable !== true ||
      !validCarrierState(webgpuCommandPrewarm?.off, "OFF", false) ||
      !validCarrierState(webgpuCommandPrewarm?.on, "ON", true) ||
      !exactSortedUniqueStrings(webgpuCommandPrewarm?.expectedOwnerTileIds) ||
      !sameArrayMembers(
        webgpuCommandPrewarm?.expectedOwnerTileIds,
        e?.selectedTileIds,
      ) ||
      !sameArrayMembers(
        webgpuCommandPrewarm?.off?.ownerTileIds,
        e?.selectedTileIds,
      ) ||
      !sameArrayMembers(
        webgpuCommandPrewarm?.on?.ownerTileIds,
        e?.selectedTileIds,
      ) ||
      webgpuCommandPrewarm?.sameMaterializedPipelines !== true ||
      !sameArrayMembers(
        webgpuCommandPrewarm?.off?.pipelineIdentityIds,
        webgpuCommandPrewarm?.on?.pipelineIdentityIds,
      ) ||
      webgpuCommandPrewarm?.offBeforeOn !== true ||
      !(
        webgpuCommandPrewarm?.off?.frameNumber <
        webgpuCommandPrewarm?.on?.frameNumber
      ) ||
      webgpuCommandPrewarm?.terminalCapturesAfterPrewarm?.off !== true ||
      webgpuCommandPrewarm?.terminalCapturesAfterPrewarm?.on !== true
    ) {
      structural.push(
        "webgpu: OFF/ON native globe command carriers were not materially prewarmed before fused capture",
      );
    }
  }

  const f = phases["F-pick-async"];
  if (
    f?.method !== "scene.pickAsync" ||
    f?.awaited !== true ||
    f?.settlement !== "fulfilled" ||
    f?.surrogateUsed !== false ||
    f?.frameDriver !== C12_29_S5_PICK_FRAME_DRIVER ||
    !Number.isInteger(f?.renderPumpFrames) ||
    f.renderPumpFrames < (renderer === "webgl" ? 1 : 0) ||
    f.renderPumpFrames > C12_29_S5_PICK_MAX_PUMP_FRAMES
  ) {
    structural.push(
      `${renderer}: real awaited and frame-driven scene.pickAsync proof is absent`,
    );
  }
  if (
    !(f?.updateForPickCalls > 0) ||
    f?.postcondition?.prepared !== true ||
    f?.postcondition?.sampledAt !== "same-updateForPick-call" ||
    f?.expected?.sampledAt !== "same-updateForPick-call" ||
    f?.postcondition?.callOrdinal !== f?.expected?.callOrdinal ||
    f?.expected?.callOrdinal !== f?.updateForPickCalls ||
    f?.postcondition?.selectionRevision !== f?.expected?.selectionRevision ||
    !Object.is(f?.postcondition?.surfaceRadius, f?.expected?.surfaceRadius) ||
    f?.postcondition?.ownerMatches !== true
  ) {
    failures.push(
      `${renderer}: updateForPick did not publish its exact S5 tuple`,
    );
  }

  const g = phases["G-retained-capture"];
  if (renderer === "webgl") {
    if (
      g?.applicable !== false ||
      g?.reason !== "WebGPU-only manager-driven retained capture"
    ) {
      structural.push("webgl: retained capture must be an explicit N/A");
    }
  } else if (
    g?.applicable !== true ||
    g?.driver !== "DynamicEnvironmentMapManager.update" ||
    g?.directRunSceneCapture !== false ||
    g?.transientAliasesOnlyCleared !== true ||
    g?.managerResetRequested !== true
  ) {
    structural.push(
      "webgpu: manager-driven retained capture was not exercised",
    );
  } else {
    if (
      g?.preparedBeforeFirstTile !== true ||
      g?.preparedSelectionRevision !== g?.retainedSelectionRevision ||
      !Object.is(g?.preparedSurfaceRadius, g?.retainedSurfaceRadius) ||
      !sameArrayMembers(g?.calledTileIds, g?.selectedTileIds)
    ) {
      failures.push(
        "webgpu: retained capture did not re-prepare against its union",
      );
    }
    if (
      g?.status !== "SUBMITTED" ||
      g?.statusCode !== 2 ||
      g?.captureTileCalls !== 6 * g?.selectedTileIds?.length ||
      g?.expectedCaptureTileCalls !== g?.captureTileCalls ||
      !(g?.positiveDrawCalls > 0)
    ) {
      failures.push(
        "webgpu: six-face retained capture call/result proof is red",
      );
    }
    if (
      g?.eclipseBinding !== C12_29_S5_WEBGPU_ECLIPSE_BINDING ||
      !Array.isArray(g?.dynamicOffsetLengths) ||
      g.dynamicOffsetLengths.length !== g.captureTileCalls ||
      !g.dynamicOffsetLengths.every((length) => length === 3) ||
      g?.cameraRestored !== true
    ) {
      failures.push(
        "webgpu: capture carrier offsets or camera restoration is red",
      );
    }
  }
  const h = phases["H-ellipsoid-reset"];
  const hPublicAssignment = h?.publicAssignment;
  const hPropagation = h?.firstBeginFramePropagation;
  if (
    h?.fromProvider !== "CesiumTerrainProvider-held" ||
    h?.toProvider !== "EllipsoidTerrainProvider-fresh" ||
    hPublicAssignment?.sceneProviderMatches !== true ||
    hPublicAssignment?.tileProviderAwaitingFirstBeginFrame !== true ||
    hPublicAssignment?.terrainRequestsBeforeFirstFrame !== 0 ||
    hPropagation?.observedAt !==
      "first-pinned-render-after-globe.beginFrame-before-selection-load" ||
    hPropagation?.beginFrameCallOrdinal !== 1 ||
    hPropagation?.tileProviderIdentityPreserved !== true ||
    hPropagation?.tileProviderMatchesAssigned !== true ||
    hPropagation?.publicProviderMatchesAssigned !== true ||
    hPropagation?.terrainRequestAttemptsAtObservation !== 0 ||
    hPropagation?.observedBeforeSelectionAndLoad !== true ||
    hPropagation?.observedInFirstRender !== true ||
    hPropagation?.selectionRevisionUnchanged !== true ||
    !Number.isInteger(hPropagation?.selectionRevisionBefore) ||
    hPropagation?.selectionRevisionAtObservation !==
      hPropagation?.selectionRevisionBefore ||
    !Number.isInteger(hPropagation?.contentRevisionBefore) ||
    !Number.isInteger(hPropagation?.contentRevisionAtObservation)
  ) {
    structural.push(
      `${renderer}: final provider first-beginFrame observation is incomplete`,
    );
  }
  if (
    h?.nextEpoch?.claimSource !== "bounded-post-first-beginFrame-settle" ||
    h?.nextEpoch?.immediateSnapshotUsedForClaim !== false ||
    !Number.isInteger(h?.nextEpoch?.immediateSnapshot?.selectedCount) ||
    typeof h?.nextEpoch?.immediateSnapshot?.tilesLoaded !== "boolean" ||
    !Number.isInteger(h?.nextEpoch?.immediateSnapshot?.selectionRevision)
  ) {
    structural.push(
      `${renderer}: final provider next-epoch claim used the immediate reset snapshot`,
    );
  }
  if (
    hPropagation?.surfaceRadiusUndefined !== true ||
    hPropagation?.knownMinimumHeight !== 0 ||
    hPropagation?.knownMaximumHeight !== 0 ||
    hPropagation?.knownBoundsValid !== true ||
    hPropagation?.contentRevisionAdvanced !== true ||
    !(
      hPropagation?.contentRevisionAtObservation >
      hPropagation?.contentRevisionBefore
    ) ||
    h?.nextEpoch?.contentRevisionAdvanced !== true ||
    h?.nextEpoch?.providerIsFreshEllipsoid !== true ||
    h?.nextEpoch?.tileProviderMatchesFreshEllipsoid !== true ||
    h?.nextEpoch?.selectionRevisionAdvanced !== true ||
    !Number.isInteger(h?.nextEpoch?.selectionRevision) ||
    !(
      h?.nextEpoch?.selectionRevision >
      hPropagation?.selectionRevisionAtObservation
    ) ||
    !Number.isInteger(h?.nextEpoch?.contentRevision) ||
    h.nextEpoch.contentRevision < hPropagation?.contentRevisionAtObservation ||
    h?.nextEpoch?.settled !== true ||
    h?.nextEpoch?.boundedMaxFrames !== 180 ||
    !Number.isInteger(h?.nextEpoch?.settleFrames) ||
    h.nextEpoch.settleFrames < 1 ||
    h.nextEpoch.settleFrames > h.nextEpoch.boundedMaxFrames ||
    !Number.isInteger(h?.nextEpoch?.stableFrames) ||
    h.nextEpoch.stableFrames < 3 ||
    h?.nextEpoch?.tilesLoaded !== true ||
    !(h?.nextEpoch?.selectedCount > 0) ||
    !(h?.nextEpoch?.terrainRequestAttempts > 0)
  ) {
    failures.push(
      `${renderer}: final provider first-beginFrame reset/next epoch is inexact`,
    );
  }

  validateImages(session, runId, structural, failures);
}

/**
 * Fold all pre-registered predicates. Evidence invalidity is STRUCTURAL;
 * measurable engine/visual disagreement is FAIL. Structural always outranks
 * FAIL so a broken instrument can never masquerade as an engine regression.
 */
export function foldC1229S5Gate(report) {
  const structuralReasons = [];
  const failureReasons = [];
  if (report?.schema !== C12_29_S5_SCHEMA || !isUuidV4(report?.runId)) {
    structuralReasons.push("report schema/run identity is invalid");
  }
  validateProvenance(report?.provenance, structuralReasons);
  const sessions = Array.isArray(report?.sessions) ? report.sessions : [];
  if (
    sessions.length !== C12_29_S5_RENDERERS.length ||
    !sameArrayMembers(
      sessions.map((session) => session?.renderer),
      C12_29_S5_RENDERERS,
    )
  ) {
    structuralReasons.push("renderer cardinality is not exactly WebGL+WebGPU");
  } else {
    for (const renderer of C12_29_S5_RENDERERS) {
      validateSession(
        sessions.find((session) => session.renderer === renderer),
        report.runId,
        structuralReasons,
        failureReasons,
      );
    }
  }
  const allImages = sessions.flatMap((session) => session?.images ?? []);
  if (
    new Set(allImages.map((image) => image?.imageId)).size !==
      allImages.length ||
    new Set(allImages.map((image) => image?.fileName)).size !== allImages.length
  ) {
    structuralReasons.push("PNG UUID/file identities are not globally unique");
  }
  const status =
    structuralReasons.length > 0
      ? "STRUCTURAL"
      : failureReasons.length > 0
        ? "FAIL"
        : "PASS";
  return {
    status,
    exitCode: exitCodeForS5Status(status),
    structuralReasons,
    failureReasons,
    checks: {
      sourceBoundaryCount: C12_29_S5_SOURCE_FILES.length,
      buildSourceBoundaryCount: C12_29_S5_BUILD_SOURCE_FILES.length,
      rendererCount: sessions.length,
      phaseCountPerRenderer: C12_29_S5_PHASES.length,
      captureCountPerRenderer: C12_29_S5_CAPTURE_LABELS.length,
    },
  };
}
