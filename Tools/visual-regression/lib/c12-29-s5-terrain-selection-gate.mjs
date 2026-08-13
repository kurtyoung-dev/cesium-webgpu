/**
 * Pure acceptance policy for C12-29 S5's first final-certification shard.
 *
 * The browser driver owns the real terrain/provider/pick/capture exercise and
 * immutable evidence publication. This module owns the frozen inputs, exact
 * terrain-radius arithmetic, evidence-shape checks, and verdict folding. It is
 * deliberately browser-free so every premise can be mutation-tested in Node.
 */

export const C12_29_S5_SCHEMA = "c12-29-s5-terrain-selection-evidence-v1";

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
  if (
    b?.fromProvider !== "EllipsoidTerrainProvider" ||
    b?.toProvider !== "CesiumTerrainProvider-held" ||
    b?.synchronousReset?.surfaceRadiusUndefined !== true ||
    b?.synchronousReset?.knownMinimumHeight !== 0 ||
    b?.synchronousReset?.knownMaximumHeight !== 0 ||
    b?.synchronousReset?.knownBoundsValid !== true ||
    b?.synchronousReset?.contentRevisionAdvanced !== true
  ) {
    failures.push(
      `${renderer}: provider swap did not synchronously reset S5 bounds`,
    );
  }

  const c = phases["C-fill-held"];
  if (
    !(c?.heldRequestCount > 0) ||
    !(c?.fillCount > 0) ||
    c?.loadedAndFillFlags !== true ||
    !Array.isArray(c?.fillTileIds) ||
    c.fillTileIds.length === 0 ||
    !c.fillTileIds.some((id) => c?.heldKeys?.includes(id))
  ) {
    structural.push(
      `${renderer}: held request did not produce a real TerrainFillMesh`,
    );
  }
  if (
    !(c?.decodedQuantizedMeshCount > 0) ||
    !(c?.realMeshCount > 0) ||
    c?.decodedFixtureClass !== "QuantizedMeshTerrainData"
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
    d?.tilesLoaded !== true ||
    d?.fillCount !== 0 ||
    !(d?.decodedQuantizedMeshCount > 0) ||
    !Array.isArray(d?.transitionedKeys) ||
    d.transitionedKeys.length === 0 ||
    !d.transitionedKeys.every((id) => c.heldKeys.includes(id))
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
  if (
    h?.fromProvider !== "CesiumTerrainProvider-held" ||
    h?.toProvider !== "EllipsoidTerrainProvider-fresh" ||
    h?.synchronousReset?.surfaceRadiusUndefined !== true ||
    h?.synchronousReset?.knownMinimumHeight !== 0 ||
    h?.synchronousReset?.knownMaximumHeight !== 0 ||
    h?.nextEpoch?.contentRevisionAdvanced !== true ||
    h?.nextEpoch?.providerIsFreshEllipsoid !== true
  ) {
    failures.push(`${renderer}: final provider reset/next epoch is inexact`);
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
