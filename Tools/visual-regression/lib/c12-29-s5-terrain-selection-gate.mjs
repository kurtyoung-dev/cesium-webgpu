/**
 * Pure acceptance policy for C12-29 S5's first final-certification shard.
 *
 * The browser driver owns the real terrain/provider/pick/capture exercise and
 * immutable evidence publication. This module owns the frozen inputs, exact
 * terrain-radius arithmetic, evidence-shape checks, and verdict folding. It is
 * deliberately browser-free so every premise can be mutation-tested in Node.
 */

export const C12_29_S5_SCHEMA = "c12-29-s5-terrain-selection-evidence-v4";

export const C12_29_S5_DIAGNOSTICS_SCHEMA = "c12-29-s5-runtime-diagnostics-v1";

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

export const C12_29_S5_WEBGPU_PREWARM_MAX_FRAMES = 60;

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
  warmupCameraFovDegrees: 20,
  terrainMaximumScreenSpaceError: 2,
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

/**
 * Enumerate every valid cardinal level-one neighbour of the tile containing
 * the live ephemeris track. Target selection is deliberately deferred until
 * the browser has completed and recorded its narrow-FOV warm-up.
 */
export function deriveS5CardinalLevelOneCandidates(longitude, latitude) {
  if (
    !Number.isFinite(longitude) ||
    !Number.isFinite(latitude) ||
    longitude < -180 ||
    longitude > 180 ||
    latitude < -90 ||
    latitude > 90
  ) {
    return [];
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
  const west = -180 + anchorX * tileWidth;
  const east = west + tileWidth;
  const north = 90 - anchorY * tileHeight;
  const south = north - tileHeight;
  const candidates = [];
  const addCandidate = (edge, distanceDegrees, targetX, targetY) => {
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
    candidates.push({
      level,
      anchorKey: `${level}/${anchorX}/${anchorY}`,
      parentKey: `0/${parentX}/${parentY}`,
      key: `${level}/${targetX}/${targetY}`,
      edge,
      targetX,
      targetY,
      distanceDegrees,
      derivation: "valid-cardinal-level-1-anchor-neighbor",
      siblingKeys,
    });
  };
  if (anchorX + 1 < xTiles) {
    addCandidate("east", Math.abs(east - longitude), anchorX + 1, anchorY);
  }
  if (anchorX > 0) {
    addCandidate("west", Math.abs(longitude - west), anchorX - 1, anchorY);
  }
  if (anchorY > 0) {
    addCandidate("north", Math.abs(north - latitude), anchorX, anchorY - 1);
  }
  if (anchorY + 1 < yTiles) {
    addCandidate("south", Math.abs(latitude - south), anchorX, anchorY + 1);
  }
  return candidates;
}

/**
 * Recompute the selection-dependent part of one candidate observation. Only
 * rendered selection arrays participate; an instantiated-but-unselected tile
 * is intentionally irrelevant to eligibility.
 */
export function evaluateS5HoldCandidateObservation(
  candidate,
  observation,
  snapshot,
) {
  const selectedTileIds = snapshot?.selectedTileIds;
  const realTileIds = snapshot?.realTileIds;
  const fillTileIds = snapshot?.fillTileIds;
  if (
    !candidate ||
    !Array.isArray(candidate.siblingKeys) ||
    !Array.isArray(selectedTileIds) ||
    !Array.isArray(realTileIds) ||
    !Array.isArray(fillTileIds)
  ) {
    return undefined;
  }
  const selected = new Set(selectedTileIds);
  const selectedDescendantTileIds = selectedTileIds
    .filter((id) => levelOneAncestorKey(id) === candidate.key)
    .sort();
  const realDescendantTileIds = realTileIds
    .filter((id) => levelOneAncestorKey(id) === candidate.key)
    .sort();
  const fillDescendantTileIds = fillTileIds
    .filter((id) => levelOneAncestorKey(id) === candidate.key)
    .sort();
  const selectedRealSiblingTileIds = realTileIds
    .filter(
      (id) =>
        selected.has(id) &&
        candidate.siblingKeys.includes(levelOneAncestorKey(id)),
    )
    .sort();
  const eligibility = {
    requestUnseen: observation?.requestAttempts === 0,
    noHeldPromise: observation?.heldPromisePresent === false,
    noReservedPromise: observation?.reservedPromisePresent === false,
    noSelectedDescendant: selectedDescendantTileIds.length === 0,
    noRealDescendant: realDescendantTileIds.length === 0,
    noFillDescendant: fillDescendantTileIds.length === 0,
    hasSelectedRealSibling: selectedRealSiblingTileIds.length > 0,
  };
  return {
    selectedDescendantTileIds,
    realDescendantTileIds,
    fillDescendantTileIds,
    selectedRealSiblingTileIds,
    eligibility,
    eligible: Object.values(eligibility).every(Boolean),
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
  if (
    provenance?.buildSourceIdentity?.ok !== true ||
    provenance?.buildSourceIdentity?.entries?.length !==
      C12_29_S5_BUILD_SOURCE_FILES.length
  ) {
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
  const expectedCandidates = deriveS5CardinalLevelOneCandidates(
    session?.fixture?.deepestTrack?.longitude,
    session?.fixture?.deepestTrack?.latitude,
  );
  const observedCandidates = warmup?.candidateObservations;
  let candidateContractExact =
    expectedCandidates.length > 0 &&
    Array.isArray(observedCandidates) &&
    observedCandidates.length === expectedCandidates.length;
  const recomputedCandidates = [];
  if (candidateContractExact) {
    for (let index = 0; index < expectedCandidates.length; index++) {
      const expected = expectedCandidates[index];
      const observed = observedCandidates[index];
      const recomputed = evaluateS5HoldCandidateObservation(
        expected,
        observed,
        warmup,
      );
      const eligibility = recomputed?.eligibility;
      const recordedEligibility = observed?.eligibility;
      const exact =
        observed?.level === expected.level &&
        observed?.anchorKey === expected.anchorKey &&
        observed?.parentKey === expected.parentKey &&
        observed?.key === expected.key &&
        observed?.edge === expected.edge &&
        observed?.targetX === expected.targetX &&
        observed?.targetY === expected.targetY &&
        Object.is(observed?.distanceDegrees, expected.distanceDegrees) &&
        observed?.derivation === expected.derivation &&
        sameArrayMembers(observed?.siblingKeys, expected.siblingKeys) &&
        nonNegativeInteger(observed?.requestAttempts) &&
        observed?.heldPromisePresent === false &&
        observed?.reservedPromisePresent === false &&
        recomputed !== undefined &&
        sameArrayMembers(
          observed?.selectedDescendantTileIds,
          recomputed?.selectedDescendantTileIds,
        ) &&
        sameArrayMembers(
          observed?.realDescendantTileIds,
          recomputed?.realDescendantTileIds,
        ) &&
        sameArrayMembers(
          observed?.fillDescendantTileIds,
          recomputed?.fillDescendantTileIds,
        ) &&
        sameArrayMembers(
          observed?.selectedRealSiblingTileIds,
          recomputed?.selectedRealSiblingTileIds,
        ) &&
        recordedEligibility?.requestUnseen === eligibility?.requestUnseen &&
        recordedEligibility?.noHeldPromise === eligibility?.noHeldPromise &&
        recordedEligibility?.noReservedPromise ===
          eligibility?.noReservedPromise &&
        recordedEligibility?.noSelectedDescendant ===
          eligibility?.noSelectedDescendant &&
        recordedEligibility?.noRealDescendant ===
          eligibility?.noRealDescendant &&
        recordedEligibility?.noFillDescendant ===
          eligibility?.noFillDescendant &&
        recordedEligibility?.hasSelectedRealSibling ===
          eligibility?.hasSelectedRealSibling &&
        observed?.eligible === recomputed?.eligible;
      if (!exact) candidateContractExact = false;
      recomputedCandidates.push({ candidate: expected, ...recomputed });
    }
  }
  const eligibleCandidates = recomputedCandidates.filter(
    (candidate) => candidate.eligible,
  );
  const expectedHeldTarget =
    eligibleCandidates.length === 1
      ? eligibleCandidates[0].candidate
      : undefined;
  if (
    !candidateContractExact ||
    eligibleCandidates.length !== 1 ||
    !expectedHeldTarget ||
    c?.holdTarget?.level !== 1 ||
    c?.holdTarget?.key !== expectedHeldTarget?.key ||
    c?.holdTarget?.anchorKey !== expectedHeldTarget?.anchorKey ||
    c?.holdTarget?.parentKey !== expectedHeldTarget?.parentKey ||
    c?.holdTarget?.edge !== expectedHeldTarget?.edge ||
    c?.holdTarget?.targetX !== expectedHeldTarget?.targetX ||
    c?.holdTarget?.targetY !== expectedHeldTarget?.targetY ||
    c?.holdTarget?.derivation !== expectedHeldTarget?.derivation ||
    !sameArrayMembers(
      c?.holdTarget?.siblingKeys,
      expectedHeldTarget?.siblingKeys,
    ) ||
    !Object.is(
      c?.holdTarget?.distanceDegrees,
      expectedHeldTarget?.distanceDegrees,
    ) ||
    warmup?.settled !== true ||
    warmup?.boundedMaxFrames !== 300 ||
    !Number.isInteger(warmup?.settleFrames) ||
    warmup.settleFrames < 1 ||
    warmup.settleFrames > warmup.boundedMaxFrames ||
    !Number.isInteger(warmup?.stableFrames) ||
    warmup.stableFrames < 3 ||
    warmup?.tilesLoaded !== true ||
    !Number.isFinite(warmup?.cameraFovDegrees) ||
    Math.abs(warmup.cameraFovDegrees - C12_29_S5_SCENE.warmupCameraFovDegrees) >
      1e-12 ||
    warmup?.maximumScreenSpaceError !==
      C12_29_S5_SCENE.terrainMaximumScreenSpaceError ||
    warmup?.preloadSiblings !== false ||
    warmup?.fillCount !== 0 ||
    warmup?.holdTargetUndefinedDuringWarmup !== true ||
    warmup?.holdInterceptionEnabled !== false ||
    warmup?.heldRequestCount !== 0 ||
    warmup?.reservedPromiseCount !== 0 ||
    warmup?.candidateDerivation !==
      "all-valid-cardinal-level-1-neighbors-then-post-warmup-eligibility" ||
    !sameArrayMembers(warmup?.eligibleCandidateKeys, [
      expectedHeldTarget?.key,
    ]) ||
    !Array.isArray(warmup?.selectedTileIds) ||
    !Array.isArray(warmup?.realTileIds) ||
    !Array.isArray(warmup?.fillTileIds) ||
    holdArm?.afterSettledWarmup !== true ||
    holdArm?.assignedAfterCandidateSnapshot !== true ||
    holdArm?.targetKey !== expectedHeldTarget?.key ||
    holdArm?.holdInterceptionEnabledBefore !== false ||
    holdArm?.holdInterceptionEnabledAfter !== true ||
    holdArm?.targetRequestAttemptsBefore !== 0 ||
    holdArm?.targetReservedBefore !== false ||
    holdArm?.heldRequestCountBefore !== 0 ||
    !Number.isFinite(holdArm?.cameraFovDegreesBefore) ||
    Math.abs(
      holdArm.cameraFovDegreesBefore - C12_29_S5_SCENE.warmupCameraFovDegrees,
    ) > 1e-12 ||
    !Number.isFinite(holdArm?.cameraFovDegreesAfter) ||
    Math.abs(holdArm.cameraFovDegreesAfter - C12_29_S5_SCENE.cameraFovDegrees) >
      1e-12 ||
    c?.settled !== true ||
    c?.holdInterceptionEnabled !== true ||
    !Number.isFinite(c?.cameraFovDegrees) ||
    Math.abs(c.cameraFovDegrees - C12_29_S5_SCENE.cameraFovDegrees) > 1e-12 ||
    c?.maximumScreenSpaceError !==
      C12_29_S5_SCENE.terrainMaximumScreenSpaceError ||
    c?.preloadSiblings !== false ||
    c?.holdTargetReserved !== true ||
    !Number.isInteger(c?.holdTargetRequestAttemptsAfterArm) ||
    c.holdTargetRequestAttemptsAfterArm !== 1 ||
    c?.heldRequestCount !== 1 ||
    c?.heldKeys?.length !== 1 ||
    c?.heldKeys?.[0] !== expectedHeldTarget?.key ||
    !(c?.fillCount > 0) ||
    c?.loadedAndFillFlags !== true ||
    !Array.isArray(c?.fillTileIds) ||
    c.fillTileIds.length === 0 ||
    !c.fillTileIds.includes(expectedHeldTarget.key) ||
    !c?.selectedTileIds?.includes(expectedHeldTarget.key) ||
    c?.heldTargetIntersectsSelectedFill !== true ||
    !Array.isArray(c?.realSiblingTileIds) ||
    c.realSiblingTileIds.length === 0 ||
    !c.realSiblingTileIds.every(
      (id) =>
        expectedHeldTarget.siblingKeys.includes(levelOneAncestorKey(id)) &&
        c?.realTileIds?.includes(id) &&
        c?.selectedTileIds?.includes(id),
    )
  ) {
    structural.push(
      `${renderer}: exactly one derived level-one hold did not intersect a selected TerrainFillMesh`,
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
  if (
    d?.holdTargetKey !== c?.holdTarget?.key ||
    d?.holdInterceptionEnabled !== false ||
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
    d.transitionObservation.frame < 1
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
        proof.ownerTileIds.length > 0 &&
        Number.isInteger(proof?.frameNumber)
      );
    };
    if (
      webgpuCommandPrewarm?.applicable !== true ||
      !validCarrierState(webgpuCommandPrewarm?.off, "OFF", false) ||
      !validCarrierState(webgpuCommandPrewarm?.on, "ON", true) ||
      webgpuCommandPrewarm?.sameMaterializedPipelines !== true ||
      !sameArrayMembers(
        webgpuCommandPrewarm?.off?.pipelineIdentityIds,
        webgpuCommandPrewarm?.on?.pipelineIdentityIds,
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
