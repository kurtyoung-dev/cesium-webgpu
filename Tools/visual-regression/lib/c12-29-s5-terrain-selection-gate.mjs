/**
 * Pure acceptance policy for C12-29 S5's first final-certification shard.
 *
 * The browser driver owns the real terrain/provider/pick/capture exercise and
 * immutable evidence publication. This module owns the frozen inputs, exact
 * terrain-radius arithmetic, evidence-shape checks, and verdict folding. It is
 * deliberately browser-free so every premise can be mutation-tested in Node.
 */

import { createHash } from "node:crypto";

export const C12_29_S5_SCHEMA = "c12-29-s5-terrain-selection-evidence-v9";

export const C12_29_S5_DIAGNOSTICS_SCHEMA = "c12-29-s5-runtime-diagnostics-v5";

export const C12_29_S5_RAW_PAGE_MAX_JSON_LENGTH = 65_536;
export const C12_29_S5_PAGE_VALIDATION_MAX_REASONS = 16;
export const C12_29_S5_PAGE_VALIDATION_MAX_REASON_LENGTH = 256;
export const C12_29_S5_RAW_PAGE_MAX_DEPTH = 8;
export const C12_29_S5_RAW_PAGE_MAX_OBJECT_KEYS = 64;
export const C12_29_S5_RAW_PAGE_MAX_ARRAY_LENGTH = 64;
export const C12_29_S5_RAW_PAGE_MAX_STRING_LENGTH = 2_048;
export const C12_29_S5_RAW_PAGE_MAX_KEY_LENGTH = 256;

const C12_29_S5_ARRAY_SUMMARY_SCHEMA = "c12-29-s5-validation-array-summary-v1";
const C12_29_S5_ARRAY_SUMMARY_THRESHOLD = 16;
const C12_29_S5_ARRAY_SUMMARY_KEYS = Object.freeze([
  "schema",
  "path",
  "length",
  "sha256",
  "facts",
  "summarySha256",
]);
const C12_29_S5_ARRAY_SUMMARY_FACT_KEYS = Object.freeze([
  "visibilityCallsValid",
  "visibilityTargetsExact",
  "orderShowCallsValid",
  "orderEndCallsValid",
  "orderEventOrdinalsExact",
  "firstRevealArrayRelationsValid",
  "firstRevealPredicateResults",
]);
const S5_VALIDATION_WITNESS_BRAND = Symbol("c12-29-s5-validation-witness");

export const C12_29_S5_PAGE_VALIDATION_REASONS = Object.freeze([
  "page progress top-level shape is invalid",
  "page progress schema/renderer is invalid",
  "page progress phase/step/elapsed state is invalid",
  "page progress completed phases are not an A-H prefix",
  "page progress terrain request ledger is inconsistent",
  "page progress async-pick state is inconsistent",
  "page progress visibility seam diagnostics are inconsistent",
  "page progress reveal diagnostics began out of order",
  "page progress first-reveal/order diagnostics are inconsistent",
  "page progress reveal failure lacks a named false predicate",
]);

export const C12_29_S5_PAGE_VALIDATION_FAILURE_FIELDS = Object.freeze([
  "topLevelShape",
  "schemaRenderer",
  "phaseStepElapsed",
  "completedPhases",
  "terrainRequests",
  "asyncPick",
  "visibilitySeam",
  "revealOrder",
  "firstRevealOrder",
  "namedFalsePredicate",
]);

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

export const C12_29_S5_LOW_DETAIL_FILL = Object.freeze({
  width: 9,
  height: 9,
  vertexCountWithoutSkirts: 81,
  indexCountWithoutSkirts: 384,
  derivedVertexCount: 117,
  totalIndexCount: 576,
});

export const C12_29_S5_REVEAL_LIFECYCLE = Object.freeze({
  quadtreeStart: 0,
  quadtreeLoading: 1,
  terrainUnloaded: 1,
  terrainReceiving: 2,
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
  "packages/engine/Source/Core/HeightmapTerrainData.js",
  "packages/engine/Source/Core/HeightmapTessellator.js",
  "packages/engine/Source/Core/TerrainMesh.js",
  "packages/engine/Source/Core/TerrainProvider.js",
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
  "packages/engine/Source/Scene/QuadtreeTileLoadState.js",
  "packages/engine/Source/Scene/TerrainState.js",
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

const hashS5DiagnosticJson = (json) =>
  createHash("sha256").update(json, "utf8").digest("hex");

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

const FIRST_REVEAL_PREDICATE_KEYS = Object.freeze([
  "captureWasFirstRenderAfterPassThrough",
  "sameTaskModeSwitchAndCapture",
  "noYieldBeforeCapture",
  "consecutiveWarmAndRevealFrames",
  "exactlyOnePostArmTargetRequest",
  "exactHeldTargetSet",
  "exactReservedTargetSet",
  "targetSameFrameRendered",
  "targetVisibilityPassThrough",
  "targetSelected",
  "targetFill",
  "targetRealAbsent",
  "terrainFillMeshInstance",
  "renderedMeshMatchesFill",
  "realMeshAbsent",
  "positiveVertexCount",
  "positiveIndexCount",
  "noSelectedStrictDescendants",
  "noRealStrictDescendants",
  "noFillStrictDescendants",
  "anchorSiblingRendered",
  "providerLoadedAndFillFlags",
  "targetShownExactlyOnce",
  "targetShowBeforeEndUpdate",
  "endUpdateExactlyOnce",
  "coherentSameFrameOrderSurfaces",
  "postEndUpdateLoadTransitionExact",
  "showMarkedFillBeforeEndUpdate",
  "exactLowDetailFillMeshShape",
  "endUpdateConstructedFill",
  "visibilityRestored",
  "orderInstrumentationRestored",
]);

export const C12_29_S5_RAW_PAGE_TOP_LEVEL_FIELDS = Object.freeze([
  "schema",
  "renderer",
  "currentPhase",
  "step",
  "completedPhases",
  "elapsedMs",
  "terrainRequests",
  "pick",
  "firstReveal",
  "orderProof",
  "visibilitySeam",
  "validationFailures",
  "validationBasis",
  "validationWitness",
]);

export const C12_29_S5_RAW_PAGE_TERRAIN_REQUEST_FIELDS = TERRAIN_REQUEST_KEYS;

export const C12_29_S5_RAW_PAGE_PICK_FIELDS = Object.freeze([
  "started",
  "settled",
  "frameDriver",
  "renderPumpFrames",
]);

export const C12_29_S5_RAW_PAGE_FIRST_REVEAL_FIELDS = Object.freeze([
  "state",
  "targetKey",
  "predicateResults",
]);

export const C12_29_S5_RAW_PAGE_PREDICATE_FIELDS = FIRST_REVEAL_PREDICATE_KEYS;

export const C12_29_S5_RAW_PAGE_ORDER_PROOF_FIELDS = Object.freeze([
  "state",
  "targetKey",
  "eventCount",
]);

export const C12_29_S5_RAW_PAGE_VISIBILITY_SEAM_FIELDS = Object.freeze([
  "state",
  "targetKey",
  "mode",
  "terminalReason",
]);

export const C12_29_S5_RAW_PAGE_VALIDATION_BASIS_FIELDS = Object.freeze([
  "validationFailureFields",
  "falsePredicateFields",
]);

const TILE_MESH_STATE_KEYS = Object.freeze([
  "instantiated",
  "quadtreeState",
  "renderable",
  "dataDefined",
  "terrainState",
  "terrainDataDefined",
  "realMeshDefined",
  "vertexArrayDefined",
  "fillDefined",
  "fillMeshDefined",
  "renderedMeshDefined",
  "renderedMeshMatchesReal",
  "renderedMeshMatchesFill",
  "terrainFillMeshInstance",
  "vertexCountWithoutSkirts",
  "indexCountWithoutSkirts",
  "verticesLength",
  "stride",
  "derivedVertexCount",
  "indexCount",
]);

const TILE_MESH_STATE_KEYS_EXCEPT_TERRAIN_STATE = Object.freeze(
  TILE_MESH_STATE_KEYS.filter((key) => key !== "terrainState"),
);

const MESH_MEASUREMENT_KEYS = Object.freeze([
  "vertexCountWithoutSkirts",
  "indexCountWithoutSkirts",
  "verticesLength",
  "stride",
  "derivedVertexCount",
  "indexCount",
]);

const PROVIDER_FRAME_FLAG_KEYS = Object.freeze([
  "hasLoadedTilesThisFrame",
  "hasFillTilesThisFrame",
  "loadedAndFillFlags",
]);

const FIRST_REVEAL_KEYS = Object.freeze([
  "state",
  "targetKey",
  "captureWasFirstRenderAfterPassThrough",
  "sameTaskModeSwitchAndCapture",
  "noYieldBeforeCapture",
  "warmFrame",
  "frameBefore",
  "frameAfter",
  "frameDelta",
  "longitude",
  "latitude",
  "cameraHeightMeters",
  "cameraFovDegrees",
  "maximumScreenSpaceError",
  "targetRequestAttemptsBefore",
  "targetRequestAttemptsAfter",
  "postArmTargetRequestAttempts",
  "targetSelection",
  "visibilityTargetCallOrdinals",
  "visibilityCalls",
  "selectedTileIds",
  "realTileIds",
  "fillTileIds",
  "selectedCount",
  "realMeshCount",
  "fillCount",
  "targetSelectedDescendantTileIds",
  "targetRealDescendantTileIds",
  "targetFillDescendantTileIds",
  "targetSelectedStrictDescendantTileIds",
  "targetRealStrictDescendantTileIds",
  "targetFillStrictDescendantTileIds",
  "selectedRealSiblingTileIds",
  "selectedRealSiblingObservations",
  "siblingKey",
  "heldKeys",
  "reservedKeys",
  "heldRequestCount",
  "reservedPromiseCount",
  "releasedRequestCount",
  "rejectedRequestCount",
  "targetHeldPromisePresent",
  "targetReservedPromisePresent",
  "providerFlags",
  "loadedAndFillFlags",
  "tilesLoaded",
  "targetSelected",
  "targetReal",
  "targetFill",
  "targetState",
  "fillMesh",
  "restoration",
  "predicateResults",
]);

/**
 * Every property name that may survive in the canonical validation witness.
 * Unknown source keys are represented by numbered, value-free sentinels so a
 * malformed shape remains malformed without persisting attacker-controlled
 * key names or values.
 */
export const C12_29_S5_VALIDATION_WITNESS_KEYS = Object.freeze([
  ...new Set([
    "schema",
    "renderer",
    "currentPhase",
    "step",
    "completedPhases",
    "elapsedMs",
    "settle",
    "detail",
    "terrainRequests",
    "pick",
    "firstReveal",
    "orderProof",
    "visibilitySeam",
    ...TERRAIN_REQUEST_KEYS,
    ...C12_29_S5_RAW_PAGE_PICK_FIELDS,
    ...FIRST_REVEAL_KEYS,
    ...FIRST_REVEAL_PREDICATE_KEYS,
    ...TILE_MESH_STATE_KEYS,
    ...PROVIDER_FRAME_FLAG_KEYS,
    "config",
    "calls",
    "counts",
    "terminalReason",
    "restoration",
    "claim",
    "maximumScreenSpaceError",
    "cameraHeightMeters",
    "cameraFovDegrees",
    "maskMode",
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
    "totalCalls",
    "originalCalls",
    "targetCalls",
    "nonTargetCalls",
    "overrideCalls",
    "nonTargetAlteredCalls",
    "skippedOriginalCalls",
    "attempted",
    "restored",
    "identityMatches",
    "descriptorMatches",
    "eventCount",
    "installation",
    "showTileThisFrame",
    "endUpdate",
    "showTileThisFrameCalls",
    "endUpdateCalls",
    "originalIdentityCaptured",
    "prototypeDescriptorFound",
    "beforeHadOwn",
    "beforeDescriptor",
    "installedHadOwn",
    "installedDescriptor",
    "installedWrapperIdentityMatches",
    "configurable",
    "enumerable",
    "writable",
    "hasValue",
    "hasGetter",
    "hasSetter",
    "enterEventOrdinal",
    "exitEventOrdinal",
    "tileStateBefore",
    "tileStateAfter",
    "providerFlagsBefore",
    "providerFlagsAfter",
    "targetStateBefore",
    "targetStateAfter",
    "attemptedAt",
    "showIdentityMatches",
    "showDescriptorMatches",
    "endIdentityMatches",
    "endDescriptorMatches",
    "finallyVerified",
    "tileId",
    "selectionFrame",
    "resultFrame",
    "sameFrame",
    "rawResult",
    "rawResultName",
    "originalResult",
    "originalResultName",
    "wasKicked",
    "fillDefined",
    "fillMeshDefined",
    "renderedMeshDefined",
    "realMeshDefined",
    "renderedMeshMatches",
    "realMeshAbsent",
    "visibilityRestored",
    "orderInstrumentationRestored",
  ]),
]);

const S5_VALIDATION_WITNESS_OBJECT_FIELDS = new Map(
  [
    [
      "",
      [
        "schema",
        "renderer",
        "currentPhase",
        "step",
        "completedPhases",
        "elapsedMs",
        "settle",
        "terrainRequests",
        "pick",
        "firstReveal",
        "orderProof",
        "visibilitySeam",
        "detail",
      ],
    ],
    ["terrainRequests", TERRAIN_REQUEST_KEYS],
    ["pick", C12_29_S5_RAW_PAGE_PICK_FIELDS],
    ["firstReveal", FIRST_REVEAL_KEYS],
    [
      "firstReveal.targetSelection",
      [
        "tileId",
        "instantiated",
        "selectionFrame",
        "resultFrame",
        "sameFrame",
        "rawResult",
        "rawResultName",
        "originalResult",
        "originalResultName",
        "wasKicked",
      ],
    ],
    [
      "firstReveal.visibilityCalls[]",
      [
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
      ],
    ],
    [
      "firstReveal.selectedRealSiblingObservations[]",
      [
        "tileId",
        "instantiated",
        "selectionFrame",
        "resultFrame",
        "sameFrame",
        "rawResult",
        "rawResultName",
        "originalResult",
        "originalResultName",
        "wasKicked",
      ],
    ],
    ["firstReveal.providerFlags", PROVIDER_FRAME_FLAG_KEYS],
    ["firstReveal.targetState", TILE_MESH_STATE_KEYS],
    [
      "firstReveal.fillMesh",
      [
        "tileId",
        "fillDefined",
        "fillMeshDefined",
        "renderedMeshDefined",
        "realMeshDefined",
        "terrainFillMeshInstance",
        "renderedMeshMatches",
        "realMeshAbsent",
        "vertexCountWithoutSkirts",
        "indexCountWithoutSkirts",
        "verticesLength",
        "stride",
        "derivedVertexCount",
        "indexCount",
      ],
    ],
    [
      "firstReveal.restoration",
      ["visibilityRestored", "orderInstrumentationRestored"],
    ],
    ["firstReveal.predicateResults", FIRST_REVEAL_PREDICATE_KEYS],
    [
      "orderProof",
      [
        "state",
        "targetKey",
        "eventCount",
        "installation",
        "showTileThisFrameCalls",
        "endUpdateCalls",
        "restoration",
      ],
    ],
    ["orderProof.installation", ["showTileThisFrame", "endUpdate"]],
    [
      "orderProof.installation.showTileThisFrame",
      [
        "originalIdentityCaptured",
        "prototypeDescriptorFound",
        "beforeHadOwn",
        "beforeDescriptor",
        "installedHadOwn",
        "installedDescriptor",
        "installedWrapperIdentityMatches",
      ],
    ],
    [
      "orderProof.installation.endUpdate",
      [
        "originalIdentityCaptured",
        "prototypeDescriptorFound",
        "beforeHadOwn",
        "beforeDescriptor",
        "installedHadOwn",
        "installedDescriptor",
        "installedWrapperIdentityMatches",
      ],
    ],
    [
      "orderProof.installation.showTileThisFrame.beforeDescriptor",
      [
        "configurable",
        "enumerable",
        "writable",
        "hasValue",
        "hasGetter",
        "hasSetter",
      ],
    ],
    [
      "orderProof.installation.showTileThisFrame.installedDescriptor",
      [
        "configurable",
        "enumerable",
        "writable",
        "hasValue",
        "hasGetter",
        "hasSetter",
      ],
    ],
    [
      "orderProof.installation.endUpdate.beforeDescriptor",
      [
        "configurable",
        "enumerable",
        "writable",
        "hasValue",
        "hasGetter",
        "hasSetter",
      ],
    ],
    [
      "orderProof.installation.endUpdate.installedDescriptor",
      [
        "configurable",
        "enumerable",
        "writable",
        "hasValue",
        "hasGetter",
        "hasSetter",
      ],
    ],
    [
      "orderProof.showTileThisFrameCalls[]",
      [
        "ordinal",
        "enterEventOrdinal",
        "exitEventOrdinal",
        "frameNumber",
        "tileKey",
        "target",
        "tileStateBefore",
        "tileStateAfter",
        "providerFlagsBefore",
        "providerFlagsAfter",
      ],
    ],
    [
      "orderProof.showTileThisFrameCalls[].tileStateBefore",
      TILE_MESH_STATE_KEYS,
    ],
    [
      "orderProof.showTileThisFrameCalls[].tileStateAfter",
      TILE_MESH_STATE_KEYS,
    ],
    [
      "orderProof.showTileThisFrameCalls[].providerFlagsBefore",
      PROVIDER_FRAME_FLAG_KEYS,
    ],
    [
      "orderProof.showTileThisFrameCalls[].providerFlagsAfter",
      PROVIDER_FRAME_FLAG_KEYS,
    ],
    [
      "orderProof.endUpdateCalls[]",
      [
        "ordinal",
        "enterEventOrdinal",
        "exitEventOrdinal",
        "frameNumber",
        "targetStateBefore",
        "targetStateAfter",
        "providerFlagsBefore",
        "providerFlagsAfter",
      ],
    ],
    ["orderProof.endUpdateCalls[].targetStateBefore", TILE_MESH_STATE_KEYS],
    ["orderProof.endUpdateCalls[].targetStateAfter", TILE_MESH_STATE_KEYS],
    [
      "orderProof.endUpdateCalls[].providerFlagsBefore",
      PROVIDER_FRAME_FLAG_KEYS,
    ],
    [
      "orderProof.endUpdateCalls[].providerFlagsAfter",
      PROVIDER_FRAME_FLAG_KEYS,
    ],
    [
      "orderProof.restoration",
      [
        "attempted",
        "attemptedAt",
        "restored",
        "showIdentityMatches",
        "showDescriptorMatches",
        "endIdentityMatches",
        "endDescriptorMatches",
        "finallyVerified",
      ],
    ],
    [
      "visibilitySeam",
      [
        "state",
        "targetKey",
        "mode",
        "config",
        "calls",
        "counts",
        "terminalReason",
        "restoration",
      ],
    ],
    [
      "visibilitySeam.config",
      [
        "claim",
        "maximumScreenSpaceError",
        "cameraHeightMeters",
        "cameraFovDegrees",
        "maskMode",
      ],
    ],
    [
      "visibilitySeam.calls[]",
      [
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
      ],
    ],
    [
      "visibilitySeam.counts",
      [
        "totalCalls",
        "originalCalls",
        "targetCalls",
        "nonTargetCalls",
        "overrideCalls",
        "nonTargetAlteredCalls",
        "skippedOriginalCalls",
      ],
    ],
    [
      "visibilitySeam.restoration",
      ["attempted", "restored", "identityMatches", "descriptorMatches"],
    ],
  ].map(([path, fields]) => [path, new Set(fields)]),
);

const S5_VALIDATION_WITNESS_ARRAY_PATHS = new Set([
  "completedPhases",
  "firstReveal.visibilityTargetCallOrdinals",
  "firstReveal.visibilityCalls",
  "firstReveal.selectedTileIds",
  "firstReveal.realTileIds",
  "firstReveal.fillTileIds",
  "firstReveal.targetSelectedDescendantTileIds",
  "firstReveal.targetRealDescendantTileIds",
  "firstReveal.targetFillDescendantTileIds",
  "firstReveal.targetSelectedStrictDescendantTileIds",
  "firstReveal.targetRealStrictDescendantTileIds",
  "firstReveal.targetFillStrictDescendantTileIds",
  "firstReveal.selectedRealSiblingTileIds",
  "firstReveal.selectedRealSiblingObservations",
  "firstReveal.heldKeys",
  "firstReveal.reservedKeys",
  "orderProof.showTileThisFrameCalls",
  "orderProof.endUpdateCalls",
  "visibilitySeam.calls",
]);

const C12_29_S5_PROGRESS_LEDGER_MAX_LENGTH =
  C12_29_S5_SCENE.fillWarmMaximumFrames * 64;
const S5_VALIDATION_WITNESS_ARRAY_MAX_LENGTHS = new Map(
  [...S5_VALIDATION_WITNESS_ARRAY_PATHS].map((path) => [
    path,
    path === "completedPhases"
      ? C12_29_S5_PHASES.length
      : path === "orderProof.showTileThisFrameCalls"
        ? 64
        : path === "orderProof.endUpdateCalls"
          ? 4
          : C12_29_S5_PROGRESS_LEDGER_MAX_LENGTH,
  ]),
);

const S5_VALIDATION_WITNESS_BOOLEAN_PATHS = new Set([
  "pick.started",
  "pick.settled",
  "firstReveal.captureWasFirstRenderAfterPassThrough",
  "firstReveal.sameTaskModeSwitchAndCapture",
  "firstReveal.noYieldBeforeCapture",
  "firstReveal.targetSelection.instantiated",
  "firstReveal.targetSelection.sameFrame",
  "firstReveal.targetSelection.wasKicked",
  "firstReveal.visibilityCalls[].target",
  "firstReveal.visibilityCalls[].originalCallCompleted",
  "firstReveal.visibilityCalls[].overridden",
  "firstReveal.selectedRealSiblingObservations[].instantiated",
  "firstReveal.selectedRealSiblingObservations[].sameFrame",
  "firstReveal.selectedRealSiblingObservations[].wasKicked",
  "firstReveal.targetHeldPromisePresent",
  "firstReveal.targetReservedPromisePresent",
  "firstReveal.loadedAndFillFlags",
  "firstReveal.tilesLoaded",
  "firstReveal.targetSelected",
  "firstReveal.targetReal",
  "firstReveal.targetFill",
  ...PROVIDER_FRAME_FLAG_KEYS.map(
    (field) => `firstReveal.providerFlags.${field}`,
  ),
  ...TILE_MESH_STATE_KEYS.filter(
    (field) =>
      !new Set([
        "quadtreeState",
        "terrainState",
        "vertexCountWithoutSkirts",
        "indexCountWithoutSkirts",
        "verticesLength",
        "stride",
        "derivedVertexCount",
        "indexCount",
      ]).has(field),
  ).map((field) => `firstReveal.targetState.${field}`),
  "firstReveal.fillMesh.fillDefined",
  "firstReveal.fillMesh.fillMeshDefined",
  "firstReveal.fillMesh.renderedMeshDefined",
  "firstReveal.fillMesh.realMeshDefined",
  "firstReveal.fillMesh.terrainFillMeshInstance",
  "firstReveal.fillMesh.renderedMeshMatches",
  "firstReveal.fillMesh.realMeshAbsent",
  "firstReveal.restoration.visibilityRestored",
  "firstReveal.restoration.orderInstrumentationRestored",
  ...FIRST_REVEAL_PREDICATE_KEYS.map(
    (field) => `firstReveal.predicateResults.${field}`,
  ),
  "orderProof.installation.showTileThisFrame.originalIdentityCaptured",
  "orderProof.installation.showTileThisFrame.prototypeDescriptorFound",
  "orderProof.installation.showTileThisFrame.beforeHadOwn",
  "orderProof.installation.showTileThisFrame.installedHadOwn",
  "orderProof.installation.showTileThisFrame.installedWrapperIdentityMatches",
  "orderProof.installation.endUpdate.originalIdentityCaptured",
  "orderProof.installation.endUpdate.prototypeDescriptorFound",
  "orderProof.installation.endUpdate.beforeHadOwn",
  "orderProof.installation.endUpdate.installedHadOwn",
  "orderProof.installation.endUpdate.installedWrapperIdentityMatches",
  ...[
    "orderProof.installation.showTileThisFrame.beforeDescriptor",
    "orderProof.installation.showTileThisFrame.installedDescriptor",
    "orderProof.installation.endUpdate.beforeDescriptor",
    "orderProof.installation.endUpdate.installedDescriptor",
  ].flatMap((prefix) =>
    [
      "configurable",
      "enumerable",
      "writable",
      "hasValue",
      "hasGetter",
      "hasSetter",
    ].map((field) => `${prefix}.${field}`),
  ),
  "orderProof.showTileThisFrameCalls[].target",
  ...["tileStateBefore", "tileStateAfter"].flatMap((state) =>
    TILE_MESH_STATE_KEYS.filter(
      (field) =>
        !new Set([
          "quadtreeState",
          "terrainState",
          "vertexCountWithoutSkirts",
          "indexCountWithoutSkirts",
          "verticesLength",
          "stride",
          "derivedVertexCount",
          "indexCount",
        ]).has(field),
    ).map((field) => `orderProof.showTileThisFrameCalls[].${state}.${field}`),
  ),
  ...["providerFlagsBefore", "providerFlagsAfter"].flatMap((flags) =>
    PROVIDER_FRAME_FLAG_KEYS.map(
      (field) => `orderProof.showTileThisFrameCalls[].${flags}.${field}`,
    ),
  ),
  ...["targetStateBefore", "targetStateAfter"].flatMap((state) =>
    TILE_MESH_STATE_KEYS.filter(
      (field) =>
        !new Set([
          "quadtreeState",
          "terrainState",
          "vertexCountWithoutSkirts",
          "indexCountWithoutSkirts",
          "verticesLength",
          "stride",
          "derivedVertexCount",
          "indexCount",
        ]).has(field),
    ).map((field) => `orderProof.endUpdateCalls[].${state}.${field}`),
  ),
  ...["providerFlagsBefore", "providerFlagsAfter"].flatMap((flags) =>
    PROVIDER_FRAME_FLAG_KEYS.map(
      (field) => `orderProof.endUpdateCalls[].${flags}.${field}`,
    ),
  ),
  "orderProof.restoration.attempted",
  "orderProof.restoration.restored",
  "orderProof.restoration.showIdentityMatches",
  "orderProof.restoration.showDescriptorMatches",
  "orderProof.restoration.endIdentityMatches",
  "orderProof.restoration.endDescriptorMatches",
  "orderProof.restoration.finallyVerified",
  "visibilitySeam.calls[].target",
  "visibilitySeam.calls[].originalCallCompleted",
  "visibilitySeam.calls[].overridden",
  "visibilitySeam.restoration.attempted",
  "visibilitySeam.restoration.restored",
  "visibilitySeam.restoration.identityMatches",
  "visibilitySeam.restoration.descriptorMatches",
]);

const S5_VALIDATION_WITNESS_NUMBER_PATHS = new Set([
  "elapsedMs",
  ...[
    "attempted",
    "accepted",
    "throttled",
    "decoded",
    "held",
    "released",
    "fulfilled",
    "rejected",
  ].map((field) => `terrainRequests.${field}`),
  "pick.renderPumpFrames",
  "firstReveal.warmFrame",
  "firstReveal.frameBefore",
  "firstReveal.frameAfter",
  "firstReveal.frameDelta",
  "firstReveal.longitude",
  "firstReveal.latitude",
  "firstReveal.cameraHeightMeters",
  "firstReveal.cameraFovDegrees",
  "firstReveal.maximumScreenSpaceError",
  "firstReveal.targetRequestAttemptsBefore",
  "firstReveal.targetRequestAttemptsAfter",
  "firstReveal.postArmTargetRequestAttempts",
  "firstReveal.targetSelection.selectionFrame",
  "firstReveal.targetSelection.resultFrame",
  "firstReveal.targetSelection.rawResult",
  "firstReveal.targetSelection.originalResult",
  "firstReveal.visibilityTargetCallOrdinals[]",
  "firstReveal.visibilityCalls[].ordinal",
  "firstReveal.visibilityCalls[].frameNumber",
  "firstReveal.visibilityCalls[].originalVisibility",
  "firstReveal.visibilityCalls[].returnedVisibility",
  "firstReveal.selectedCount",
  "firstReveal.realMeshCount",
  "firstReveal.fillCount",
  "firstReveal.selectedRealSiblingObservations[].selectionFrame",
  "firstReveal.selectedRealSiblingObservations[].resultFrame",
  "firstReveal.selectedRealSiblingObservations[].rawResult",
  "firstReveal.selectedRealSiblingObservations[].originalResult",
  "firstReveal.heldRequestCount",
  "firstReveal.reservedPromiseCount",
  "firstReveal.releasedRequestCount",
  "firstReveal.rejectedRequestCount",
  "firstReveal.targetState.quadtreeState",
  "firstReveal.targetState.terrainState",
  ...[
    "vertexCountWithoutSkirts",
    "indexCountWithoutSkirts",
    "verticesLength",
    "stride",
    "derivedVertexCount",
    "indexCount",
  ].flatMap((field) => [
    `firstReveal.targetState.${field}`,
    `firstReveal.fillMesh.${field}`,
  ]),
  "orderProof.eventCount",
  "orderProof.showTileThisFrameCalls[].ordinal",
  "orderProof.showTileThisFrameCalls[].enterEventOrdinal",
  "orderProof.showTileThisFrameCalls[].exitEventOrdinal",
  "orderProof.showTileThisFrameCalls[].frameNumber",
  ...["tileStateBefore", "tileStateAfter"].flatMap((state) =>
    [
      "quadtreeState",
      "terrainState",
      "vertexCountWithoutSkirts",
      "indexCountWithoutSkirts",
      "verticesLength",
      "stride",
      "derivedVertexCount",
      "indexCount",
    ].map((field) => `orderProof.showTileThisFrameCalls[].${state}.${field}`),
  ),
  "orderProof.endUpdateCalls[].ordinal",
  "orderProof.endUpdateCalls[].enterEventOrdinal",
  "orderProof.endUpdateCalls[].exitEventOrdinal",
  "orderProof.endUpdateCalls[].frameNumber",
  ...["targetStateBefore", "targetStateAfter"].flatMap((state) =>
    [
      "quadtreeState",
      "terrainState",
      "vertexCountWithoutSkirts",
      "indexCountWithoutSkirts",
      "verticesLength",
      "stride",
      "derivedVertexCount",
      "indexCount",
    ].map((field) => `orderProof.endUpdateCalls[].${state}.${field}`),
  ),
  "visibilitySeam.config.maximumScreenSpaceError",
  "visibilitySeam.config.cameraHeightMeters",
  "visibilitySeam.config.cameraFovDegrees",
  "visibilitySeam.calls[].ordinal",
  "visibilitySeam.calls[].frameNumber",
  "visibilitySeam.calls[].originalVisibility",
  "visibilitySeam.calls[].returnedVisibility",
  ...[
    "totalCalls",
    "originalCalls",
    "targetCalls",
    "nonTargetCalls",
    "overrideCalls",
    "nonTargetAlteredCalls",
    "skippedOriginalCalls",
  ].map((field) => `visibilitySeam.counts.${field}`),
]);
const S5_VALIDATION_WITNESS_SENTINEL_KEY = /^__unexpected_s5_\d{4}$/u;
const S5_VALIDATION_WITNESS_SENTINEL_STRINGS = new Set([
  "[invalid-node-overflow]",
  "[invalid-array-overflow]",
  "[invalid-object-overflow]",
  "[invalid-depth]",
  "[invalid-cycle]",
  "[non-finite-number]",
  "[redacted-string]",
  "[unexpected]",
  "[undefined]",
  "[bigint]",
  "[function]",
  "[symbol]",
]);
const S5_VALIDATION_WITNESS_SAFE_STRINGS = new Set([
  "controlled-visibility-input-production-selection-request-fill-release-render",
  "warm-only-exact-target-Visibility.NONE",
  "not-installed",
  "installed",
  "warm-proven",
  "revealed",
  "restored",
  "error-restored",
  "started",
  "captured",
  "evaluated",
  "warm-mask",
  "pass-through",
  "NONE",
  "PARTIAL",
  "FULL",
  "RENDERED",
]);
const S5_VALIDATION_WITNESS_LAST_ERROR_CODES = new Set([
  "none",
  "message",
  "url",
  "url-query",
  "url-fragment",
  "url-userinfo",
  "non-string",
]);
const S5_VALIDATION_WITNESS_PATH_STRINGS = new Map([
  ["schema", new Set([C12_29_S5_DIAGNOSTICS_SCHEMA])],
  ["renderer", new Set(C12_29_S5_RENDERERS)],
  ["currentPhase", new Set(["preflight", ...C12_29_S5_PHASES])],
  ["completedPhases[]", new Set(C12_29_S5_PHASES)],
  ["pick.frameDriver", new Set([C12_29_S5_PICK_FRAME_DRIVER])],
  [
    "step",
    new Set(["first-pass-through-render-and-fused-fill-capture", "other-step"]),
  ],
  ["terrainRequests.lastError", S5_VALIDATION_WITNESS_LAST_ERROR_CODES],
  ["terrainRequests.lastTileId", new Set(["present"])],
  ["orderProof.restoration.attemptedAt", new Set(["message"])],
  [
    "visibilitySeam.terminalReason",
    new Set([
      "first pass-through render did not produce the exact held L1 fill",
      "other-terminal-reason",
    ]),
  ],
]);
const S5_VALIDATION_WITNESS_TILE_ID_PATHS = new Set([
  "terrainRequests.lastTileId",
  "firstReveal.targetKey",
  "firstReveal.siblingKey",
  "firstReveal.targetSelection.tileId",
  "firstReveal.visibilityCalls[].tileKey",
  "firstReveal.selectedTileIds[]",
  "firstReveal.realTileIds[]",
  "firstReveal.fillTileIds[]",
  "firstReveal.targetSelectedDescendantTileIds[]",
  "firstReveal.targetRealDescendantTileIds[]",
  "firstReveal.targetFillDescendantTileIds[]",
  "firstReveal.targetSelectedStrictDescendantTileIds[]",
  "firstReveal.targetRealStrictDescendantTileIds[]",
  "firstReveal.targetFillStrictDescendantTileIds[]",
  "firstReveal.selectedRealSiblingTileIds[]",
  "firstReveal.selectedRealSiblingObservations[].tileId",
  "firstReveal.heldKeys[]",
  "firstReveal.reservedKeys[]",
  "firstReveal.fillMesh.tileId",
  "orderProof.targetKey",
  "orderProof.showTileThisFrameCalls[].tileKey",
  "visibilitySeam.targetKey",
  "visibilitySeam.calls[].tileKey",
]);
const S5_VALIDATION_WITNESS_STRING_PATHS = new Set([
  ...S5_VALIDATION_WITNESS_PATH_STRINGS.keys(),
  ...S5_VALIDATION_WITNESS_TILE_ID_PATHS,
  "firstReveal.state",
  "firstReveal.targetSelection.rawResultName",
  "firstReveal.targetSelection.originalResultName",
  "firstReveal.visibilityCalls[].mode",
  "firstReveal.visibilityCalls[].originalVisibilityName",
  "firstReveal.visibilityCalls[].returnedVisibilityName",
  "firstReveal.selectedRealSiblingObservations[].rawResultName",
  "firstReveal.selectedRealSiblingObservations[].originalResultName",
  "orderProof.state",
  "visibilitySeam.state",
  "visibilitySeam.mode",
  "visibilitySeam.config.claim",
  "visibilitySeam.config.maskMode",
  "visibilitySeam.calls[].mode",
  "visibilitySeam.calls[].originalVisibilityName",
  "visibilitySeam.calls[].returnedVisibilityName",
]);
const S5_VALIDATION_WITNESS_MAX_TILE_ID_LENGTH = 32;
const S5_VALIDATION_WITNESS_MAX_TILE_LEVEL = 30;

function validS5ValidationWitnessTileId(value) {
  if (
    typeof value !== "string" ||
    value.length > S5_VALIDATION_WITNESS_MAX_TILE_ID_LENGTH
  ) {
    return false;
  }
  const match = /^(0|[1-9]\d*)\/(0|[1-9]\d*)\/(0|[1-9]\d*)$/u.exec(value);
  if (match === null) return false;
  const level = Number(match[1]);
  const x = Number(match[2]);
  const y = Number(match[3]);
  return (
    Number.isSafeInteger(level) &&
    Number.isSafeInteger(x) &&
    Number.isSafeInteger(y) &&
    level <= S5_VALIDATION_WITNESS_MAX_TILE_LEVEL &&
    x < 2 ** (level + 1) &&
    y < 2 ** level
  );
}

const nonNegativeInteger = (value) => Number.isInteger(value) && value >= 0;

/**
 * Accept only canonical dense arrays. Array iteration intentionally skips
 * holes, and JSON serialization can read inherited indices while discarding
 * extra properties, so neither mechanism is a cardinality proof by itself.
 */
function s5ArrayPrototypeHasNumericKeys() {
  try {
    return Reflect.ownKeys(Array.prototype).some(
      (key) =>
        typeof key === "string" &&
        /^(?:0|[1-9]\d*)$/u.test(key) &&
        Number(key) < 2 ** 32 - 1,
    );
  } catch {
    return true;
  }
}

function exactDenseS5Array(value, maximumLength) {
  if (
    !Array.isArray(value) ||
    !Number.isSafeInteger(maximumLength) ||
    maximumLength < 0 ||
    value.length > maximumLength
  ) {
    return false;
  }
  try {
    if (Object.getPrototypeOf(value) !== Array.prototype) return false;
    if (s5ArrayPrototypeHasNumericKeys()) return false;
    const ownKeys = Reflect.ownKeys(value);
    if (ownKeys.length !== value.length + 1 || !ownKeys.includes("length")) {
      return false;
    }
    for (let index = 0; index < value.length; index++) {
      if (!Object.hasOwn(value, String(index))) return false;
    }
    return true;
  } catch {
    return false;
  }
}

const S5_FINAL_ARRAY_MAX_LENGTHS = new Map([
  ["provenance.reasons", C12_29_S5_PROGRESS_LEDGER_MAX_LENGTH],
  ["provenance.sourceBoundary.files", C12_29_S5_SOURCE_FILES.length],
  ["provenance.sourceBoundary.identities", C12_29_S5_SOURCE_FILES.length],
  [
    "provenance.buildSourceIdentity.entries",
    C12_29_S5_BUILD_SOURCE_FILES.length,
  ],
  [
    "provenance.buildSourceIdentity.reasons",
    C12_29_S5_PROGRESS_LEDGER_MAX_LENGTH,
  ],
  ["provenance.servedEntryIdentity.expectedLabels", C12_29_S5_RENDERERS.length],
  ["provenance.servedEntryIdentity.observedLabels", C12_29_S5_RENDERERS.length],
  [
    "provenance.servedEntryIdentity.reasons",
    C12_29_S5_PROGRESS_LEDGER_MAX_LENGTH,
  ],
  ["provenance.start.reasons", C12_29_S5_PROGRESS_LEDGER_MAX_LENGTH],
  [
    "provenance.start.buildSourceIdentity.entries",
    C12_29_S5_BUILD_SOURCE_FILES.length,
  ],
  [
    "provenance.start.buildSourceIdentity.reasons",
    C12_29_S5_PROGRESS_LEDGER_MAX_LENGTH,
  ],
  ["provenance.end.reasons", C12_29_S5_PROGRESS_LEDGER_MAX_LENGTH],
  [
    "provenance.end.buildSourceIdentity.entries",
    C12_29_S5_BUILD_SOURCE_FILES.length,
  ],
  [
    "provenance.end.buildSourceIdentity.reasons",
    C12_29_S5_PROGRESS_LEDGER_MAX_LENGTH,
  ],
  ["sessions", C12_29_S5_RENDERERS.length],

  [
    "sessions[].phases.A-ellipsoid-stable.selectedTileIds",
    C12_29_S5_PROGRESS_LEDGER_MAX_LENGTH,
  ],
  [
    "sessions[].phases.A-ellipsoid-stable.fillLodPrecondition.target.siblingKeys",
    3,
  ],
  [
    "sessions[].phases.A-ellipsoid-stable.fillLodPrecondition.selectedTileIds",
    C12_29_S5_PROGRESS_LEDGER_MAX_LENGTH,
  ],
  [
    "sessions[].phases.A-ellipsoid-stable.fillLodPrecondition.realTileIds",
    C12_29_S5_PROGRESS_LEDGER_MAX_LENGTH,
  ],
  [
    "sessions[].phases.A-ellipsoid-stable.fillLodPrecondition.fillTileIds",
    C12_29_S5_PROGRESS_LEDGER_MAX_LENGTH,
  ],

  [
    "sessions[].phases.C-fill-held.selectedTileIds",
    C12_29_S5_PROGRESS_LEDGER_MAX_LENGTH,
  ],
  [
    "sessions[].phases.C-fill-held.realTileIds",
    C12_29_S5_PROGRESS_LEDGER_MAX_LENGTH,
  ],
  ["sessions[].phases.C-fill-held.holdTarget.siblingKeys", 3],
  [
    "sessions[].phases.C-fill-held.warmup.selectedTileIds",
    C12_29_S5_PROGRESS_LEDGER_MAX_LENGTH,
  ],
  [
    "sessions[].phases.C-fill-held.warmup.realTileIds",
    C12_29_S5_PROGRESS_LEDGER_MAX_LENGTH,
  ],
  [
    "sessions[].phases.C-fill-held.warmup.fillTileIds",
    C12_29_S5_PROGRESS_LEDGER_MAX_LENGTH,
  ],
  [
    "sessions[].phases.C-fill-held.warmup.targetSelectedDescendantTileIds",
    C12_29_S5_PROGRESS_LEDGER_MAX_LENGTH,
  ],
  [
    "sessions[].phases.C-fill-held.warmup.targetRealDescendantTileIds",
    C12_29_S5_PROGRESS_LEDGER_MAX_LENGTH,
  ],
  [
    "sessions[].phases.C-fill-held.warmup.targetFillDescendantTileIds",
    C12_29_S5_PROGRESS_LEDGER_MAX_LENGTH,
  ],
  [
    "sessions[].phases.C-fill-held.warmup.visibilityTargetCallOrdinals",
    C12_29_S5_PROGRESS_LEDGER_MAX_LENGTH,
  ],
  ["sessions[].phases.C-fill-held.warmup.selectedRealSiblingTileIds", 3],
  ["sessions[].phases.C-fill-held.warmup.selectedRealSiblingObservations", 3],
  [
    "sessions[].phases.C-fill-held.firstRevealProof.visibilityTargetCallOrdinals",
    C12_29_S5_PROGRESS_LEDGER_MAX_LENGTH,
  ],
  [
    "sessions[].phases.C-fill-held.firstRevealProof.visibilityCalls",
    C12_29_S5_PROGRESS_LEDGER_MAX_LENGTH,
  ],
  [
    "sessions[].phases.C-fill-held.firstRevealProof.selectedTileIds",
    C12_29_S5_PROGRESS_LEDGER_MAX_LENGTH,
  ],
  [
    "sessions[].phases.C-fill-held.firstRevealProof.realTileIds",
    C12_29_S5_PROGRESS_LEDGER_MAX_LENGTH,
  ],
  [
    "sessions[].phases.C-fill-held.firstRevealProof.fillTileIds",
    C12_29_S5_PROGRESS_LEDGER_MAX_LENGTH,
  ],
  [
    "sessions[].phases.C-fill-held.firstRevealProof.targetSelectedDescendantTileIds",
    C12_29_S5_PROGRESS_LEDGER_MAX_LENGTH,
  ],
  [
    "sessions[].phases.C-fill-held.firstRevealProof.targetRealDescendantTileIds",
    C12_29_S5_PROGRESS_LEDGER_MAX_LENGTH,
  ],
  [
    "sessions[].phases.C-fill-held.firstRevealProof.targetFillDescendantTileIds",
    C12_29_S5_PROGRESS_LEDGER_MAX_LENGTH,
  ],
  [
    "sessions[].phases.C-fill-held.firstRevealProof.targetSelectedStrictDescendantTileIds",
    C12_29_S5_PROGRESS_LEDGER_MAX_LENGTH,
  ],
  [
    "sessions[].phases.C-fill-held.firstRevealProof.targetRealStrictDescendantTileIds",
    C12_29_S5_PROGRESS_LEDGER_MAX_LENGTH,
  ],
  [
    "sessions[].phases.C-fill-held.firstRevealProof.targetFillStrictDescendantTileIds",
    C12_29_S5_PROGRESS_LEDGER_MAX_LENGTH,
  ],
  [
    "sessions[].phases.C-fill-held.firstRevealProof.selectedRealSiblingTileIds",
    3,
  ],
  [
    "sessions[].phases.C-fill-held.firstRevealProof.selectedRealSiblingObservations",
    3,
  ],
  [
    "sessions[].phases.C-fill-held.firstRevealProof.heldKeys",
    C12_29_S5_PROGRESS_LEDGER_MAX_LENGTH,
  ],
  [
    "sessions[].phases.C-fill-held.firstRevealProof.reservedKeys",
    C12_29_S5_PROGRESS_LEDGER_MAX_LENGTH,
  ],
  ["sessions[].phases.C-fill-held.orderProof.showTileThisFrameCalls", 64],
  ["sessions[].phases.C-fill-held.orderProof.endUpdateCalls", 4],
  [
    "sessions[].phases.C-fill-held.visibilitySeam.calls",
    C12_29_S5_PROGRESS_LEDGER_MAX_LENGTH,
  ],
  [
    "sessions[].phases.C-fill-held.visibilitySeam.warmTargetCallOrdinals",
    C12_29_S5_PROGRESS_LEDGER_MAX_LENGTH,
  ],
  [
    "sessions[].phases.C-fill-held.visibilitySeam.revealTargetCallOrdinals",
    C12_29_S5_PROGRESS_LEDGER_MAX_LENGTH,
  ],
  [
    "sessions[].phases.C-fill-held.heldKeys",
    C12_29_S5_PROGRESS_LEDGER_MAX_LENGTH,
  ],
  [
    "sessions[].phases.C-fill-held.fillTileIds",
    C12_29_S5_PROGRESS_LEDGER_MAX_LENGTH,
  ],
  ["sessions[].phases.C-fill-held.realSiblingTileIds", 3],
  [
    "sessions[].phases.C-fill-held.decodedFixtureBounds",
    C12_29_S5_PROGRESS_LEDGER_MAX_LENGTH,
  ],

  [
    "sessions[].phases.D-real-x1.selectedTileIds",
    C12_29_S5_PROGRESS_LEDGER_MAX_LENGTH,
  ],
  [
    "sessions[].phases.D-real-x1.realTileIds",
    C12_29_S5_PROGRESS_LEDGER_MAX_LENGTH,
  ],
  [
    "sessions[].phases.D-real-x1.fillTileIds",
    C12_29_S5_PROGRESS_LEDGER_MAX_LENGTH,
  ],
  [
    "sessions[].phases.D-real-x1.releasedKeys",
    C12_29_S5_PROGRESS_LEDGER_MAX_LENGTH,
  ],
  [
    "sessions[].phases.D-real-x1.transitionedKeys",
    C12_29_S5_PROGRESS_LEDGER_MAX_LENGTH,
  ],

  [
    "sessions[].phases.E-real-x2.preparedSelectedTileIds",
    C12_29_S5_PROGRESS_LEDGER_MAX_LENGTH,
  ],
  [
    "sessions[].phases.E-real-x2.selectedTileIds",
    C12_29_S5_PROGRESS_LEDGER_MAX_LENGTH,
  ],
  [
    "sessions[].phases.E-real-x2.realTileIds",
    C12_29_S5_PROGRESS_LEDGER_MAX_LENGTH,
  ],
  [
    "sessions[].phases.E-real-x2.fillTileIds",
    C12_29_S5_PROGRESS_LEDGER_MAX_LENGTH,
  ],
  [
    "sessions[].phases.E-real-x2.webgpuCommandMaterializationPrewarm.off.pipelineIdentityIds",
    C12_29_S5_PROGRESS_LEDGER_MAX_LENGTH,
  ],
  [
    "sessions[].phases.E-real-x2.webgpuCommandMaterializationPrewarm.off.pipelineLabels",
    C12_29_S5_PROGRESS_LEDGER_MAX_LENGTH,
  ],
  [
    "sessions[].phases.E-real-x2.webgpuCommandMaterializationPrewarm.off.ownerTileIds",
    C12_29_S5_PROGRESS_LEDGER_MAX_LENGTH,
  ],
  [
    "sessions[].phases.E-real-x2.webgpuCommandMaterializationPrewarm.on.pipelineIdentityIds",
    C12_29_S5_PROGRESS_LEDGER_MAX_LENGTH,
  ],
  [
    "sessions[].phases.E-real-x2.webgpuCommandMaterializationPrewarm.on.pipelineLabels",
    C12_29_S5_PROGRESS_LEDGER_MAX_LENGTH,
  ],
  [
    "sessions[].phases.E-real-x2.webgpuCommandMaterializationPrewarm.on.ownerTileIds",
    C12_29_S5_PROGRESS_LEDGER_MAX_LENGTH,
  ],
  [
    "sessions[].phases.E-real-x2.webgpuCommandMaterializationPrewarm.expectedOwnerTileIds",
    C12_29_S5_PROGRESS_LEDGER_MAX_LENGTH,
  ],

  [
    "sessions[].phases.G-retained-capture.selectedTileIds",
    C12_29_S5_PROGRESS_LEDGER_MAX_LENGTH,
  ],
  [
    "sessions[].phases.G-retained-capture.calledTileIds",
    C12_29_S5_PROGRESS_LEDGER_MAX_LENGTH,
  ],
  [
    "sessions[].phases.G-retained-capture.dynamicOffsetLengths",
    C12_29_S5_PROGRESS_LEDGER_MAX_LENGTH,
  ],
  ["sessions[].images", C12_29_S5_CAPTURE_LABELS.length],
  [
    "sessions[].transport.externalRequests",
    C12_29_S5_PROGRESS_LEDGER_MAX_LENGTH,
  ],
  ["sessions[].transport.failedRequests", C12_29_S5_PROGRESS_LEDGER_MAX_LENGTH],
  ["sessions[].transport.httpErrors", C12_29_S5_PROGRESS_LEDGER_MAX_LENGTH],
  ["sessions[].runtime.pageErrors", C12_29_S5_PROGRESS_LEDGER_MAX_LENGTH],
  ["sessions[].runtime.consoleErrors", C12_29_S5_PROGRESS_LEDGER_MAX_LENGTH],
  ["sessions[].runtime.gpuErrors", C12_29_S5_PROGRESS_LEDGER_MAX_LENGTH],
]);

function maximumS5FinalArrayLength(path) {
  return S5_FINAL_ARRAY_MAX_LENGTHS.get(path);
}

/**
 * Reject sparse arrays, inherited numeric indices, custom prototypes, and
 * non-index own properties before the final fold performs any array method or
 * index access. The recursive boundary also covers nested provenance records
 * retained in the report even when only their aggregate is consumed below.
 */
function firstInvalidS5FinalArray(value, path = "", active = new WeakSet()) {
  if (value === null || typeof value !== "object") return null;
  if (active.has(value)) return path === "" ? "<root cycle>" : `${path} cycle`;
  active.add(value);
  try {
    if (Array.isArray(value)) {
      if (!exactDenseS5Array(value, maximumS5FinalArrayLength(path))) {
        return path === "" ? "<root>" : path;
      }
      for (let index = 0; index < value.length; index++) {
        const nested = firstInvalidS5FinalArray(
          value[index],
          `${path}[]`,
          active,
        );
        if (nested !== null) return nested;
      }
      return null;
    }
    for (const key of Object.keys(value)) {
      const nested = firstInvalidS5FinalArray(
        value[key],
        path === "" ? key : `${path}.${key}`,
        active,
      );
      if (nested !== null) return nested;
    }
    return null;
  } catch {
    return path === "" ? "<root access>" : `${path} access`;
  } finally {
    active.delete(value);
  }
}

function exactS5ArrayValues(value, expected) {
  return (
    exactDenseS5Array(value, expected.length) &&
    value.length === expected.length &&
    value.every((entry, index) => entry === expected[index])
  );
}

const exactEmptyS5Array = (value) => exactDenseS5Array(value, 0);

function exactDenseS5ArrayAtPath(value, path) {
  const maximumLength = S5_VALIDATION_WITNESS_ARRAY_MAX_LENGTHS.get(path);
  return maximumLength !== undefined && exactDenseS5Array(value, maximumLength);
}

function validS5ArrayOrSummaryAtPath(value, path, allowArraySummaries) {
  return (
    exactDenseS5ArrayAtPath(value, path) ||
    (allowArraySummaries && validS5ValidationArraySummary(value, path))
  );
}

function exactObjectKeys(value, keys) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}

function validS5ArraySummaryPredicateResults(value) {
  return (
    value === null ||
    (exactObjectKeys(value, FIRST_REVEAL_PREDICATE_KEYS) &&
      FIRST_REVEAL_PREDICATE_KEYS.every(
        (key) => typeof value[key] === "boolean",
      ))
  );
}

function validS5ValidationArraySummary(value, path) {
  const maximumLength = S5_VALIDATION_WITNESS_ARRAY_MAX_LENGTHS.get(path);
  const summarySha256 = hashS5DiagnosticJson(
    JSON.stringify({
      schema: value?.schema,
      path: value?.path,
      length: value?.length,
      sha256: value?.sha256,
      facts: value?.facts,
    }),
  );
  return (
    exactObjectKeys(value, C12_29_S5_ARRAY_SUMMARY_KEYS) &&
    value.schema === C12_29_S5_ARRAY_SUMMARY_SCHEMA &&
    value.path === path &&
    path !== "completedPhases" &&
    S5_VALIDATION_WITNESS_ARRAY_PATHS.has(path) &&
    maximumLength !== undefined &&
    Number.isSafeInteger(value.length) &&
    value.length > C12_29_S5_ARRAY_SUMMARY_THRESHOLD &&
    value.length <= maximumLength &&
    SHA256.test(value.sha256 ?? "") &&
    SHA256.test(value.summarySha256 ?? "") &&
    value.summarySha256 === summarySha256 &&
    exactObjectKeys(value.facts, C12_29_S5_ARRAY_SUMMARY_FACT_KEYS) &&
    [
      value.facts.visibilityCallsValid,
      value.facts.visibilityTargetsExact,
      value.facts.orderShowCallsValid,
      value.facts.orderEndCallsValid,
      value.facts.orderEventOrdinalsExact,
    ].every((entry) => typeof entry === "boolean") &&
    (value.facts.firstRevealArrayRelationsValid === null ||
      typeof value.facts.firstRevealArrayRelationsValid === "boolean") &&
    validS5ArraySummaryPredicateResults(value.facts.firstRevealPredicateResults)
  );
}

function createS5ValidationArraySummary(value, path, source) {
  if (
    !exactDenseS5ArrayAtPath(value, path) ||
    value.length <= C12_29_S5_ARRAY_SUMMARY_THRESHOLD ||
    path === "completedPhases" ||
    !S5_VALIDATION_WITNESS_ARRAY_PATHS.has(path)
  ) {
    return null;
  }
  const visibilityCalls = source?.visibilitySeam?.calls;
  const visibilityCallsValid =
    exactDenseS5ArrayAtPath(visibilityCalls, "visibilitySeam.calls") &&
    visibilityCalls.length === source?.visibilitySeam?.counts?.totalCalls &&
    visibilityCalls.every(validVisibilityCall);
  const visibilityTargetsExact =
    exactDenseS5ArrayAtPath(visibilityCalls, "visibilitySeam.calls") &&
    visibilityCalls.every(
      (call) =>
        source?.visibilitySeam?.targetKey !== null &&
        call.target === (call.tileKey === source?.visibilitySeam?.targetKey),
    );
  const showCalls = source?.orderProof?.showTileThisFrameCalls;
  const endCalls = source?.orderProof?.endUpdateCalls;
  const orderShowCallsValid =
    exactDenseS5ArrayAtPath(showCalls, "orderProof.showTileThisFrameCalls") &&
    showCalls.every((call, index) =>
      validShowTileOrderCall(call, index, source?.orderProof?.targetKey),
    );
  const orderEndCallsValid =
    exactDenseS5ArrayAtPath(endCalls, "orderProof.endUpdateCalls") &&
    endCalls.every(validEndUpdateOrderCall);
  const eventOrdinals =
    exactDenseS5ArrayAtPath(showCalls, "orderProof.showTileThisFrameCalls") &&
    exactDenseS5ArrayAtPath(endCalls, "orderProof.endUpdateCalls")
      ? [
          ...showCalls.flatMap((call) => [
            call?.enterEventOrdinal,
            call?.exitEventOrdinal,
          ]),
          ...endCalls.flatMap((call) => [
            call?.enterEventOrdinal,
            call?.exitEventOrdinal,
          ]),
        ].sort((left, right) => left - right)
      : [];
  const orderEventOrdinalsExact =
    eventOrdinals.length === source?.orderProof?.eventCount &&
    eventOrdinals.every((ordinal, index) => ordinal === index + 1);
  const firstRevealArrayRelationsValid =
    source?.firstReveal === null || source?.firstReveal === undefined
      ? null
      : validFirstRevealProgress(
          source.firstReveal,
          source.orderProof,
          source.visibilitySeam,
        );
  const firstRevealPredicateResults =
    source?.firstReveal?.state === "evaluated" &&
    firstRevealArrayRelationsValid === true
      ? computeFirstRevealPredicateResults(
          source.firstReveal,
          source.orderProof,
        )
      : null;
  const json = JSON.stringify(value);
  const summary = {
    schema: C12_29_S5_ARRAY_SUMMARY_SCHEMA,
    path,
    length: value.length,
    sha256: hashS5DiagnosticJson(json),
    facts: {
      visibilityCallsValid,
      visibilityTargetsExact,
      orderShowCallsValid,
      orderEndCallsValid,
      orderEventOrdinalsExact,
      firstRevealArrayRelationsValid,
      firstRevealPredicateResults,
    },
  };
  return {
    ...summary,
    summarySha256: hashS5DiagnosticJson(JSON.stringify(summary)),
  };
}

function s5ValidationArraySummary(value, path) {
  return validS5ValidationArraySummary(value, path) ? value : null;
}

function s5ValidationArrayLength(value, path) {
  if (exactDenseS5ArrayAtPath(value, path)) return value.length;
  return s5ValidationArraySummary(value, path)?.length ?? null;
}

function consistentS5ArraySummaryFacts(entries) {
  const summaries = entries
    .map(([value, path]) => s5ValidationArraySummary(value, path))
    .filter((value) => value !== null);
  if (summaries.length === 0) return null;
  const facts = JSON.stringify(summaries[0].facts);
  return summaries.every((summary) => JSON.stringify(summary.facts) === facts)
    ? summaries[0].facts
    : undefined;
}

function validCanonicalS5PageValidationReasons(value, allowEmpty = true) {
  if (
    !exactDenseS5Array(value, C12_29_S5_PAGE_VALIDATION_MAX_REASONS) ||
    (!allowEmpty && value.length === 0) ||
    value.length > C12_29_S5_PAGE_VALIDATION_REASONS.length
  ) {
    return false;
  }
  let priorIndex = -1;
  for (const reason of value) {
    if (
      typeof reason !== "string" ||
      reason.length === 0 ||
      reason.length > C12_29_S5_PAGE_VALIDATION_MAX_REASON_LENGTH
    ) {
      return false;
    }
    const index = C12_29_S5_PAGE_VALIDATION_REASONS.indexOf(reason);
    if (index <= priorIndex) return false;
    priorIndex = index;
  }
  return true;
}

function validBoundedS5RawJsonTree(value, depth = 0) {
  if (value === null || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value === "string") {
    return value.length <= C12_29_S5_RAW_PAGE_MAX_STRING_LENGTH;
  }
  if (typeof value !== "object" || depth >= C12_29_S5_RAW_PAGE_MAX_DEPTH) {
    return false;
  }
  if (Array.isArray(value)) {
    return (
      exactDenseS5Array(value, C12_29_S5_RAW_PAGE_MAX_ARRAY_LENGTH) &&
      value.every((entry) => validBoundedS5RawJsonTree(entry, depth + 1))
    );
  }
  const keys = Object.keys(value);
  return (
    keys.length <= C12_29_S5_RAW_PAGE_MAX_OBJECT_KEYS &&
    keys.every(
      (key) =>
        key.length <= C12_29_S5_RAW_PAGE_MAX_KEY_LENGTH &&
        validBoundedS5RawJsonTree(value[key], depth + 1),
    )
  );
}

const validS5RawLeaf = (value) =>
  value === null ||
  typeof value === "boolean" ||
  (typeof value === "number" && Number.isFinite(value)) ||
  (typeof value === "string" &&
    value.length <= C12_29_S5_RAW_PAGE_MAX_STRING_LENGTH);

function validExactS5RawLeafObject(value, fields) {
  return (
    exactObjectKeys(value, fields) &&
    fields.every((key) => validS5RawLeaf(value[key]))
  );
}

function reasonsFromS5ValidationFailures(value) {
  if (
    !exactObjectKeys(value, C12_29_S5_PAGE_VALIDATION_FAILURE_FIELDS) ||
    !C12_29_S5_PAGE_VALIDATION_FAILURE_FIELDS.every(
      (key) => typeof value[key] === "boolean",
    )
  ) {
    return null;
  }
  return C12_29_S5_PAGE_VALIDATION_REASONS.filter(
    (_reason, index) => value[C12_29_S5_PAGE_VALIDATION_FAILURE_FIELDS[index]],
  );
}

function validS5ValidationWitnessTree(value, depth = 0, path = "") {
  if (value === null) return true;
  if (typeof value === "boolean") {
    return S5_VALIDATION_WITNESS_BOOLEAN_PATHS.has(path);
  }
  if (typeof value === "number") {
    return (
      S5_VALIDATION_WITNESS_NUMBER_PATHS.has(path) && Number.isFinite(value)
    );
  }
  if (typeof value === "string") {
    if (value.length > C12_29_S5_RAW_PAGE_MAX_STRING_LENGTH) return false;
    if (value === "[non-finite-number]") {
      return S5_VALIDATION_WITNESS_NUMBER_PATHS.has(path);
    }
    if (S5_VALIDATION_WITNESS_SENTINEL_STRINGS.has(value)) {
      return true;
    }
    if (!S5_VALIDATION_WITNESS_STRING_PATHS.has(path)) return false;
    if (value === "") return true;
    if (S5_VALIDATION_WITNESS_TILE_ID_PATHS.has(path)) {
      return (
        validS5ValidationWitnessTileId(value) ||
        S5_VALIDATION_WITNESS_PATH_STRINGS.get(path)?.has(value) === true
      );
    }
    const pathStrings = S5_VALIDATION_WITNESS_PATH_STRINGS.get(path);
    return (
      pathStrings?.has(value) ?? S5_VALIDATION_WITNESS_SAFE_STRINGS.has(value)
    );
  }
  if (typeof value !== "object" || depth >= C12_29_S5_RAW_PAGE_MAX_DEPTH) {
    return false;
  }
  if (validS5ValidationArraySummary(value, path)) return true;
  if (Array.isArray(value)) {
    return (
      S5_VALIDATION_WITNESS_ARRAY_PATHS.has(path) &&
      exactDenseS5ArrayAtPath(value, path) &&
      value.length <= C12_29_S5_RAW_PAGE_MAX_ARRAY_LENGTH &&
      value.every((entry) =>
        validS5ValidationWitnessTree(entry, depth + 1, `${path}[]`),
      )
    );
  }
  const allowedFields = S5_VALIDATION_WITNESS_OBJECT_FIELDS.get(path);
  if (allowedFields === undefined) return false;
  const keys = Object.keys(value);
  const sentinelKeys = keys.filter((key) =>
    S5_VALIDATION_WITNESS_SENTINEL_KEY.test(key),
  );
  return (
    keys.length <= C12_29_S5_RAW_PAGE_MAX_OBJECT_KEYS &&
    sentinelKeys.every(
      (key, index) =>
        key === `__unexpected_s5_${String(index + 1).padStart(4, "0")}` &&
        value[key] === "[unexpected]",
    ) &&
    keys.every(
      (key) =>
        (S5_VALIDATION_WITNESS_SENTINEL_KEY.test(key) &&
          value[key] === "[unexpected]") ||
        (allowedFields.has(key) &&
          validS5ValidationWitnessTree(
            value[key],
            depth + 1,
            path === "" ? key : `${path}.${key}`,
          )),
    )
  );
}

function categoricalS5WitnessLastError(value) {
  if (value === null) return null;
  if (typeof value !== "string") return "non-string";
  if (S5_VALIDATION_WITNESS_LAST_ERROR_CODES.has(value)) {
    return value;
  }
  try {
    const url = new URL(value);
    if (url.username !== "" || url.password !== "") return "url-userinfo";
    if (url.search !== "") return "url-query";
    if (url.hash !== "") return "url-fragment";
    return "url";
  } catch {
    return value.length === 0 ? "none" : "message";
  }
}

function categoricalS5WitnessString(value, path) {
  if (value === "") return "";
  if (path === "step") {
    return S5_VALIDATION_WITNESS_PATH_STRINGS.get(path).has(value)
      ? value
      : "other-step";
  }
  if (path === "visibilitySeam.terminalReason") {
    return S5_VALIDATION_WITNESS_PATH_STRINGS.get(path).has(value)
      ? value
      : "other-terminal-reason";
  }
  if (path === "terrainRequests.lastTileId") {
    return validS5ValidationWitnessTileId(value) ? value : "present";
  }
  if (S5_VALIDATION_WITNESS_TILE_ID_PATHS.has(path)) {
    return validS5ValidationWitnessTileId(value) ? value : "[redacted-string]";
  }
  if (path === "orderProof.restoration.attemptedAt") return "message";
  const pathStrings = S5_VALIDATION_WITNESS_PATH_STRINGS.get(path);
  if (pathStrings !== undefined) {
    return pathStrings.has(value) ? value : "[redacted-string]";
  }
  if (S5_VALIDATION_WITNESS_SAFE_STRINGS.has(value)) return value;
  return "[redacted-string]";
}

function brandS5ValidationWitness(value) {
  if (value !== null && typeof value === "object") {
    Object.defineProperty(value, S5_VALIDATION_WITNESS_BRAND, {
      value: true,
    });
  }
  return value;
}

/**
 * Build the canonical, bounded, secret-free primary-fact witness on which both
 * classification and final-artifact validation run. It deliberately does not
 * emit validation booleans or reasons.
 */
export function createS5PageValidationWitness(source) {
  if (source?.[S5_VALIDATION_WITNESS_BRAND] === true) {
    try {
      if (!validS5ValidationWitnessTree(source)) return null;
      const canonical = JSON.parse(
        JSON.stringify(canonicalS5ValidationWitness(source)),
      );
      return validS5ValidationWitnessTree(canonical)
        ? brandS5ValidationWitness(canonical)
        : null;
    } catch {
      return null;
    }
  }
  const active = new WeakSet();
  let remainingNodes = 4_096;
  const visit = (value, path, depth) => {
    if (--remainingNodes < 0) return "[invalid-node-overflow]";
    if (path === "settle" || path === "detail") return null;
    if (path === "terrainRequests.lastError") {
      return categoricalS5WitnessLastError(value);
    }
    if (value === null) return null;
    if (typeof value === "boolean") {
      return S5_VALIDATION_WITNESS_BOOLEAN_PATHS.has(path)
        ? value
        : "[unexpected]";
    }
    if (typeof value === "number") {
      if (!S5_VALIDATION_WITNESS_NUMBER_PATHS.has(path)) return "[unexpected]";
      return Number.isFinite(value) ? value : "[non-finite-number]";
    }
    if (typeof value === "string") {
      return S5_VALIDATION_WITNESS_STRING_PATHS.has(path)
        ? categoricalS5WitnessString(value, path)
        : "[unexpected]";
    }
    if (value === undefined) return "[undefined]";
    if (typeof value !== "object") return `[${typeof value}]`;
    if (depth >= C12_29_S5_RAW_PAGE_MAX_DEPTH - 2) {
      return "[invalid-depth]";
    }
    if (validS5ValidationArraySummary(value, path)) {
      return JSON.parse(JSON.stringify(value));
    }
    if (active.has(value)) return "[invalid-cycle]";
    active.add(value);
    try {
      if (Array.isArray(value)) {
        if (!S5_VALIDATION_WITNESS_ARRAY_PATHS.has(path)) {
          return "[unexpected]";
        }
        if (!exactDenseS5ArrayAtPath(value, path)) {
          return "[invalid-array-overflow]";
        }
        const summary = createS5ValidationArraySummary(value, path, source);
        if (summary !== null) return summary;
        if (value.length > C12_29_S5_RAW_PAGE_MAX_ARRAY_LENGTH) {
          return "[invalid-array-overflow]";
        }
        return value.map((entry) => visit(entry, `${path}[]`, depth + 1));
      }
      const allowedFields = S5_VALIDATION_WITNESS_OBJECT_FIELDS.get(path);
      if (allowedFields === undefined) return "[unexpected]";
      const sourceKeys = Object.keys(value);
      if (sourceKeys.length > C12_29_S5_RAW_PAGE_MAX_OBJECT_KEYS) {
        return "[invalid-object-overflow]";
      }
      const known = sourceKeys
        .filter((entry) => allowedFields.has(entry))
        .sort(
          (left, right) =>
            C12_29_S5_VALIDATION_WITNESS_KEYS.indexOf(left) -
            C12_29_S5_VALIDATION_WITNESS_KEYS.indexOf(right),
        );
      const unexpectedCount = sourceKeys.length - known.length;
      const result = {};
      for (const entry of known) {
        result[entry] = visit(
          value[entry],
          path === "" ? entry : `${path}.${entry}`,
          depth + 1,
        );
      }
      for (let index = 0; index < unexpectedCount; index++) {
        result[`__unexpected_s5_${String(index + 1).padStart(4, "0")}`] =
          "[unexpected]";
      }
      return result;
    } finally {
      active.delete(value);
    }
  };
  try {
    const witness = visit(source, "", 0);
    const canonical = JSON.parse(
      JSON.stringify(canonicalS5ValidationWitness(witness)),
    );
    if (!validS5ValidationWitnessTree(canonical)) return null;
    return brandS5ValidationWitness(canonical);
  } catch {
    return null;
  }
}

function canonicalS5ValidationWitness(value, path = "") {
  if (Array.isArray(value)) {
    if (!exactDenseS5ArrayAtPath(value, path)) {
      return "[invalid-array-overflow]";
    }
    return value.map((entry) =>
      canonicalS5ValidationWitness(entry, `${path}[]`),
    );
  }
  if (value === null || typeof value !== "object") return value;
  if (value.schema === C12_29_S5_ARRAY_SUMMARY_SCHEMA) {
    const predicateResults = value.facts?.firstRevealPredicateResults;
    return {
      schema: value.schema,
      path: value.path,
      length: value.length,
      sha256: value.sha256,
      facts: Object.fromEntries(
        C12_29_S5_ARRAY_SUMMARY_FACT_KEYS.map((key) => [
          key,
          key === "firstRevealPredicateResults" &&
          predicateResults !== null &&
          typeof predicateResults === "object"
            ? Object.fromEntries(
                FIRST_REVEAL_PREDICATE_KEYS.map((predicate) => [
                  predicate,
                  predicateResults[predicate],
                ]),
              )
            : value.facts?.[key],
        ]),
      ),
      summarySha256: value.summarySha256,
    };
  }
  const rank = (key) => {
    const index = C12_29_S5_VALIDATION_WITNESS_KEYS.indexOf(key);
    return index < 0 ? Number.MAX_SAFE_INTEGER : index;
  };
  return Object.fromEntries(
    Object.keys(value)
      .sort(
        (left, right) =>
          rank(left) - rank(right) ||
          (left < right ? -1 : left > right ? 1 : 0),
      )
      .map((key) => [
        key,
        canonicalS5ValidationWitness(
          value[key],
          path === "" ? key : `${path}.${key}`,
        ),
      ]),
  );
}

const diagnosticLeafFromS5Witness = (value) => {
  if (value === undefined) return "[undefined]";
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "number" ||
    typeof value === "string"
  ) {
    return value;
  }
  return `[${typeof value}]`;
};

function projectS5WitnessLeafObject(value, fields) {
  const source = value !== null && typeof value === "object" ? value : null;
  return Object.fromEntries(
    fields.map((field) => [
      field,
      diagnosticLeafFromS5Witness(source?.[field]),
    ]),
  );
}

function exactS5DiagnosticSummaryFromWitness(value, witness) {
  const expected = {
    schema: diagnosticLeafFromS5Witness(witness?.schema),
    renderer: diagnosticLeafFromS5Witness(witness?.renderer),
    currentPhase: diagnosticLeafFromS5Witness(witness?.currentPhase),
    step: diagnosticLeafFromS5Witness(witness?.step),
    completedPhases: exactDenseS5ArrayAtPath(
      witness?.completedPhases,
      "completedPhases",
    )
      ? witness.completedPhases.map(diagnosticLeafFromS5Witness)
      : [],
    elapsedMs: diagnosticLeafFromS5Witness(witness?.elapsedMs),
    terrainRequests: projectS5WitnessLeafObject(
      witness?.terrainRequests,
      C12_29_S5_RAW_PAGE_TERRAIN_REQUEST_FIELDS,
    ),
    pick: projectS5WitnessLeafObject(
      witness?.pick,
      C12_29_S5_RAW_PAGE_PICK_FIELDS,
    ),
    firstReveal: {
      ...projectS5WitnessLeafObject(
        witness?.firstReveal,
        C12_29_S5_RAW_PAGE_FIRST_REVEAL_FIELDS.filter(
          (field) => field !== "predicateResults",
        ),
      ),
      predicateResults: projectS5WitnessLeafObject(
        witness?.firstReveal?.predicateResults,
        C12_29_S5_RAW_PAGE_PREDICATE_FIELDS,
      ),
    },
    orderProof: projectS5WitnessLeafObject(
      witness?.orderProof,
      C12_29_S5_RAW_PAGE_ORDER_PROOF_FIELDS,
    ),
    visibilitySeam: projectS5WitnessLeafObject(
      witness?.visibilitySeam,
      C12_29_S5_RAW_PAGE_VISIBILITY_SEAM_FIELDS,
    ),
  };
  return [
    "schema",
    "renderer",
    "currentPhase",
    "step",
    "completedPhases",
    "elapsedMs",
    "terrainRequests",
    "pick",
    "firstReveal",
    "orderProof",
    "visibilitySeam",
  ].every(
    (field) =>
      JSON.stringify(value?.[field]) === JSON.stringify(expected[field]),
  );
}

function exactCanonicalSubset(value, canonicalValues, selectedValues) {
  return (
    exactDenseS5Array(value, canonicalValues.length) &&
    exactDenseS5Array(selectedValues, canonicalValues.length) &&
    value.length === selectedValues.length &&
    value.every(
      (entry, index) =>
        entry === selectedValues[index] && canonicalValues.includes(entry),
    )
  );
}

function validS5PageDiagnosticProjection(
  value,
  requireValidationFailure,
  expectedRenderer = value?.validationWitness?.renderer,
) {
  if (!validS5ValidationWitnessTree(value?.validationWitness)) return false;
  const recomputedValidation = validateS5PageProgress(
    value.validationWitness,
    expectedRenderer,
    true,
  );
  const validationReasons = recomputedValidation.reasons;
  const assertedValidationReasons = reasonsFromS5ValidationFailures(
    value?.validationFailures,
  );
  const validationFailureFields =
    C12_29_S5_PAGE_VALIDATION_FAILURE_FIELDS.filter((_field, index) =>
      validationReasons.includes(C12_29_S5_PAGE_VALIDATION_REASONS[index]),
    );
  const falsePredicateFields = C12_29_S5_RAW_PAGE_PREDICATE_FIELDS.filter(
    (field) =>
      value?.validationWitness?.firstReveal?.predicateResults?.[field] ===
      false,
  );
  const namedFalsePredicateFailure =
    value?.validationWitness?.visibilitySeam?.terminalReason ===
      "first pass-through render did not produce the exact held L1 fill" &&
    (value?.validationWitness?.firstReveal?.state !== "evaluated" ||
      falsePredicateFields.length === 0);
  const exactD866FailureRetained =
    value?.validationWitness?.visibilitySeam?.terminalReason ===
    "first pass-through render did not produce the exact held L1 fill";
  const evaluatedFalsePredicateRetained =
    value?.validationWitness?.firstReveal?.state === "evaluated" &&
    falsePredicateFields.length > 0;
  return (
    exactObjectKeys(value, C12_29_S5_RAW_PAGE_TOP_LEVEL_FIELDS) &&
    ["schema", "renderer", "currentPhase", "step", "elapsedMs"].every((key) =>
      validS5RawLeaf(value[key]),
    ) &&
    exactDenseS5ArrayAtPath(value.completedPhases, "completedPhases") &&
    value.completedPhases.every(validS5RawLeaf) &&
    validExactS5RawLeafObject(
      value.terrainRequests,
      C12_29_S5_RAW_PAGE_TERRAIN_REQUEST_FIELDS,
    ) &&
    validExactS5RawLeafObject(value.pick, C12_29_S5_RAW_PAGE_PICK_FIELDS) &&
    exactObjectKeys(
      value.firstReveal,
      C12_29_S5_RAW_PAGE_FIRST_REVEAL_FIELDS,
    ) &&
    validS5RawLeaf(value.firstReveal.state) &&
    validS5RawLeaf(value.firstReveal.targetKey) &&
    validExactS5RawLeafObject(
      value.firstReveal.predicateResults,
      C12_29_S5_RAW_PAGE_PREDICATE_FIELDS,
    ) &&
    validExactS5RawLeafObject(
      value.orderProof,
      C12_29_S5_RAW_PAGE_ORDER_PROOF_FIELDS,
    ) &&
    validExactS5RawLeafObject(
      value.visibilitySeam,
      C12_29_S5_RAW_PAGE_VISIBILITY_SEAM_FIELDS,
    ) &&
    assertedValidationReasons !== null &&
    validationReasons.length === assertedValidationReasons.length &&
    validationReasons.every(
      (reason, index) => reason === assertedValidationReasons[index],
    ) &&
    (requireValidationFailure
      ? validationReasons.length > 0
      : validationReasons.length === 0) &&
    exactObjectKeys(
      value.validationBasis,
      C12_29_S5_RAW_PAGE_VALIDATION_BASIS_FIELDS,
    ) &&
    exactCanonicalSubset(
      value.validationBasis.validationFailureFields,
      C12_29_S5_PAGE_VALIDATION_FAILURE_FIELDS,
      validationFailureFields,
    ) &&
    exactCanonicalSubset(
      value.validationBasis.falsePredicateFields,
      C12_29_S5_RAW_PAGE_PREDICATE_FIELDS,
      falsePredicateFields,
    ) &&
    value.validationFailures.namedFalsePredicate ===
      namedFalsePredicateFailure &&
    exactS5DiagnosticSummaryFromWitness(value, value.validationWitness) &&
    (requireValidationFailure ||
      exactD866FailureRetained === evaluatedFalsePredicateRetained) &&
    validBoundedS5RawJsonTree(value)
  );
}

export function validateS5PageDiagnosticProjection(value, renderer) {
  try {
    const json = JSON.stringify(value);
    return (
      value?.schema === C12_29_S5_DIAGNOSTICS_SCHEMA &&
      value?.renderer === renderer &&
      C12_29_S5_RENDERERS.includes(renderer) &&
      new TextEncoder().encode(json).byteLength <=
        C12_29_S5_RAW_PAGE_MAX_JSON_LENGTH &&
      JSON.stringify(canonicalS5PageDiagnosticProjection(value)) === json &&
      validS5PageDiagnosticProjection(value, false, renderer)
    );
  } catch {
    return false;
  }
}

function canonicalS5PageDiagnosticProjection(value) {
  const ordered = Object.fromEntries(
    C12_29_S5_RAW_PAGE_TOP_LEVEL_FIELDS.map((field) => [field, value?.[field]]),
  );
  ordered.terrainRequests = Object.fromEntries(
    C12_29_S5_RAW_PAGE_TERRAIN_REQUEST_FIELDS.map((field) => [
      field,
      value?.terrainRequests?.[field],
    ]),
  );
  ordered.pick = Object.fromEntries(
    C12_29_S5_RAW_PAGE_PICK_FIELDS.map((field) => [
      field,
      value?.pick?.[field],
    ]),
  );
  ordered.firstReveal = Object.fromEntries(
    C12_29_S5_RAW_PAGE_FIRST_REVEAL_FIELDS.map((field) => [
      field,
      field === "predicateResults"
        ? Object.fromEntries(
            C12_29_S5_RAW_PAGE_PREDICATE_FIELDS.map((predicate) => [
              predicate,
              value?.firstReveal?.predicateResults?.[predicate],
            ]),
          )
        : value?.firstReveal?.[field],
    ]),
  );
  ordered.orderProof = Object.fromEntries(
    C12_29_S5_RAW_PAGE_ORDER_PROOF_FIELDS.map((field) => [
      field,
      value?.orderProof?.[field],
    ]),
  );
  ordered.visibilitySeam = Object.fromEntries(
    C12_29_S5_RAW_PAGE_VISIBILITY_SEAM_FIELDS.map((field) => [
      field,
      value?.visibilitySeam?.[field],
    ]),
  );
  ordered.validationFailures = Object.fromEntries(
    C12_29_S5_PAGE_VALIDATION_FAILURE_FIELDS.map((field) => [
      field,
      value?.validationFailures?.[field],
    ]),
  );
  ordered.validationBasis = Object.fromEntries(
    C12_29_S5_RAW_PAGE_VALIDATION_BASIS_FIELDS.map((field) => [
      field,
      value?.validationBasis?.[field],
    ]),
  );
  ordered.validationWitness = canonicalS5ValidationWitness(
    value?.validationWitness,
  );
  return ordered;
}

export function validateS5RawPageDiagnosticJson(json, renderer) {
  if (
    typeof json !== "string" ||
    json.length === 0 ||
    new TextEncoder().encode(json).byteLength >
      C12_29_S5_RAW_PAGE_MAX_JSON_LENGTH
  ) {
    return { ok: false, value: null };
  }
  try {
    const value = JSON.parse(json);
    return {
      ok:
        JSON.stringify(canonicalS5PageDiagnosticProjection(value)) === json &&
        validS5PageDiagnosticProjection(value, true, renderer),
      value,
    };
  } catch {
    return { ok: false, value: null };
  }
}

function exactObjectValues(left, right, keys) {
  return (
    exactObjectKeys(left, keys) &&
    exactObjectKeys(right, keys) &&
    keys.every((key) => Object.is(left[key], right[key]))
  );
}

function exactTileMeshStateExceptTerrainState(left, right) {
  return (
    exactObjectKeys(left, TILE_MESH_STATE_KEYS) &&
    exactObjectKeys(right, TILE_MESH_STATE_KEYS) &&
    TILE_MESH_STATE_KEYS_EXCEPT_TERRAIN_STATE.every((key) =>
      Object.is(left[key], right[key]),
    )
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

function validVisibilitySeamProgress(value, allowArraySummaries = false) {
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
  const callSummary = s5ValidationArraySummary(calls, "visibilitySeam.calls");
  if (callSummary !== null) {
    return (
      allowArraySummaries &&
      callSummary.length <= C12_29_S5_SCENE.fillWarmMaximumFrames * 64 &&
      callSummary.length === counts.totalCalls &&
      callSummary.facts.visibilityCallsValid &&
      callSummary.facts.visibilityTargetsExact
    );
  }
  return (
    exactDenseS5ArrayAtPath(calls, "visibilitySeam.calls") &&
    calls.length === counts.totalCalls &&
    calls.every(validVisibilityCall) &&
    calls.every(
      (call) =>
        value.targetKey !== null &&
        call.target === (call.tileKey === value.targetKey),
    )
  );
}

function validMeshMeasurements(value) {
  return (
    MESH_MEASUREMENT_KEYS.every((key) => nonNegativeInteger(value?.[key])) &&
    (value.stride === 0
      ? value.verticesLength === 0 && value.derivedVertexCount === 0
      : value.verticesLength === value.derivedVertexCount * value.stride) &&
    value.vertexCountWithoutSkirts <= value.derivedVertexCount &&
    value.indexCountWithoutSkirts <= value.indexCount
  );
}

function validTileMeshState(value) {
  if (!exactObjectKeys(value, TILE_MESH_STATE_KEYS)) return false;
  const booleanKeys = [
    "instantiated",
    "renderable",
    "dataDefined",
    "terrainDataDefined",
    "realMeshDefined",
    "vertexArrayDefined",
    "fillDefined",
    "fillMeshDefined",
    "renderedMeshDefined",
    "renderedMeshMatchesReal",
    "renderedMeshMatchesFill",
    "terrainFillMeshInstance",
  ];
  return (
    booleanKeys.every((key) => typeof value[key] === "boolean") &&
    (value.quadtreeState === null || Number.isInteger(value.quadtreeState)) &&
    (value.terrainState === null || Number.isInteger(value.terrainState)) &&
    validMeshMeasurements(value) &&
    (!value.terrainDataDefined || value.dataDefined) &&
    (!value.realMeshDefined || value.dataDefined) &&
    (!value.fillDefined || value.dataDefined) &&
    (!value.fillMeshDefined || value.fillDefined) &&
    (!value.renderedMeshDefined || value.dataDefined) &&
    (!value.renderedMeshMatchesReal ||
      (value.renderedMeshDefined && value.realMeshDefined)) &&
    (!value.renderedMeshMatchesFill ||
      (value.renderedMeshDefined && value.fillMeshDefined)) &&
    (!value.terrainFillMeshInstance || value.fillDefined) &&
    (value.fillMeshDefined ||
      MESH_MEASUREMENT_KEYS.every((key) => value[key] === 0))
  );
}

function exactLowDetailFillMeshMeasurements(value) {
  return (
    value?.vertexCountWithoutSkirts ===
      C12_29_S5_LOW_DETAIL_FILL.vertexCountWithoutSkirts &&
    value?.indexCountWithoutSkirts ===
      C12_29_S5_LOW_DETAIL_FILL.indexCountWithoutSkirts &&
    value?.derivedVertexCount ===
      C12_29_S5_LOW_DETAIL_FILL.derivedVertexCount &&
    value?.indexCount === C12_29_S5_LOW_DETAIL_FILL.totalIndexCount &&
    Number.isInteger(value?.stride) &&
    value.stride > 0 &&
    Number.isInteger(value?.verticesLength) &&
    value.verticesLength === value.derivedVertexCount * value.stride
  );
}

function validProviderFrameFlags(value) {
  return (
    exactObjectKeys(value, PROVIDER_FRAME_FLAG_KEYS) &&
    PROVIDER_FRAME_FLAG_KEYS.every((key) => typeof value[key] === "boolean") &&
    value.loadedAndFillFlags ===
      (value.hasLoadedTilesThisFrame && value.hasFillTilesThisFrame)
  );
}

function validOrderPropertyInstallation(value) {
  return (
    exactObjectKeys(value, [
      "originalIdentityCaptured",
      "prototypeDescriptorFound",
      "beforeHadOwn",
      "beforeDescriptor",
      "installedHadOwn",
      "installedDescriptor",
      "installedWrapperIdentityMatches",
    ]) &&
    [
      value.originalIdentityCaptured,
      value.prototypeDescriptorFound,
      value.beforeHadOwn,
      value.installedHadOwn,
      value.installedWrapperIdentityMatches,
    ].every((entry) => typeof entry === "boolean") &&
    (value.beforeDescriptor === null ||
      typeof value.beforeDescriptor === "object") &&
    (value.installedDescriptor === null ||
      typeof value.installedDescriptor === "object")
  );
}

function exactOrderPropertyInstallation(value) {
  return (
    validOrderPropertyInstallation(value) &&
    value.originalIdentityCaptured === true &&
    value.prototypeDescriptorFound === true &&
    value.beforeHadOwn === false &&
    value.beforeDescriptor === null &&
    value.installedHadOwn === true &&
    exactObjectKeys(value.installedDescriptor, [
      "configurable",
      "enumerable",
      "writable",
      "hasValue",
      "hasGetter",
      "hasSetter",
    ]) &&
    value.installedDescriptor?.configurable === true &&
    value.installedDescriptor?.enumerable === false &&
    value.installedDescriptor?.writable === true &&
    value.installedDescriptor?.hasValue === true &&
    value.installedDescriptor?.hasGetter === false &&
    value.installedDescriptor?.hasSetter === false &&
    value.installedWrapperIdentityMatches === true
  );
}

function validShowTileOrderCall(call, index, targetKey) {
  return (
    exactObjectKeys(call, [
      "ordinal",
      "enterEventOrdinal",
      "exitEventOrdinal",
      "frameNumber",
      "tileKey",
      "target",
      "tileStateBefore",
      "tileStateAfter",
      "providerFlagsBefore",
      "providerFlagsAfter",
    ]) &&
    call.ordinal === index + 1 &&
    nonNegativeInteger(call.enterEventOrdinal) &&
    nonNegativeInteger(call.exitEventOrdinal) &&
    call.enterEventOrdinal < call.exitEventOrdinal &&
    nonNegativeInteger(call.frameNumber) &&
    /^\d+\/\d+\/\d+$/u.test(call.tileKey) &&
    call.target === (call.tileKey === targetKey) &&
    validTileMeshState(call.tileStateBefore) &&
    validTileMeshState(call.tileStateAfter) &&
    validProviderFrameFlags(call.providerFlagsBefore) &&
    validProviderFrameFlags(call.providerFlagsAfter)
  );
}

function validEndUpdateOrderCall(call, index) {
  return (
    exactObjectKeys(call, [
      "ordinal",
      "enterEventOrdinal",
      "exitEventOrdinal",
      "frameNumber",
      "targetStateBefore",
      "targetStateAfter",
      "providerFlagsBefore",
      "providerFlagsAfter",
    ]) &&
    call.ordinal === index + 1 &&
    nonNegativeInteger(call.enterEventOrdinal) &&
    nonNegativeInteger(call.exitEventOrdinal) &&
    call.enterEventOrdinal < call.exitEventOrdinal &&
    nonNegativeInteger(call.frameNumber) &&
    validTileMeshState(call.targetStateBefore) &&
    validTileMeshState(call.targetStateAfter) &&
    validProviderFrameFlags(call.providerFlagsBefore) &&
    validProviderFrameFlags(call.providerFlagsAfter)
  );
}

function validOrderProofProgress(value, allowArraySummaries = false) {
  const showSummary = s5ValidationArraySummary(
    value?.showTileThisFrameCalls,
    "orderProof.showTileThisFrameCalls",
  );
  const endSummary = s5ValidationArraySummary(
    value?.endUpdateCalls,
    "orderProof.endUpdateCalls",
  );
  if (
    !exactObjectKeys(value, [
      "state",
      "targetKey",
      "eventCount",
      "installation",
      "showTileThisFrameCalls",
      "endUpdateCalls",
      "restoration",
    ]) ||
    !new Set(["installed", "restored", "error-restored"]).has(value.state) ||
    !/^1\/\d+\/\d+$/u.test(value.targetKey) ||
    !nonNegativeInteger(value.eventCount) ||
    !exactObjectKeys(value.installation, ["showTileThisFrame", "endUpdate"]) ||
    !validOrderPropertyInstallation(value.installation.showTileThisFrame) ||
    !validOrderPropertyInstallation(value.installation.endUpdate) ||
    (showSummary === null &&
      (!exactDenseS5ArrayAtPath(
        value.showTileThisFrameCalls,
        "orderProof.showTileThisFrameCalls",
      ) ||
        !value.showTileThisFrameCalls.every((call, index) =>
          validShowTileOrderCall(call, index, value.targetKey),
        ))) ||
    (endSummary === null &&
      (!exactDenseS5ArrayAtPath(
        value.endUpdateCalls,
        "orderProof.endUpdateCalls",
      ) ||
        !value.endUpdateCalls.every(validEndUpdateOrderCall))) ||
    !exactObjectKeys(value.restoration, [
      "attempted",
      "attemptedAt",
      "restored",
      "showIdentityMatches",
      "showDescriptorMatches",
      "endIdentityMatches",
      "endDescriptorMatches",
      "finallyVerified",
    ]) ||
    ![
      value.restoration.attempted,
      value.restoration.restored,
      value.restoration.showIdentityMatches,
      value.restoration.showDescriptorMatches,
      value.restoration.endIdentityMatches,
      value.restoration.endDescriptorMatches,
      value.restoration.finallyVerified,
    ].every((entry) => typeof entry === "boolean") ||
    !(
      value.restoration.attemptedAt === null ||
      typeof value.restoration.attemptedAt === "string"
    )
  ) {
    return false;
  }
  const summaryFacts = consistentS5ArraySummaryFacts([
    [value.showTileThisFrameCalls, "orderProof.showTileThisFrameCalls"],
    [value.endUpdateCalls, "orderProof.endUpdateCalls"],
  ]);
  if (summaryFacts === undefined) return false;
  if (summaryFacts !== null) {
    if (
      !allowArraySummaries ||
      (showSummary !== null &&
        (showSummary.length > 64 || !summaryFacts.orderShowCallsValid)) ||
      (endSummary !== null &&
        (endSummary.length > 4 || !summaryFacts.orderEndCallsValid))
    ) {
      return false;
    }
  }
  const eventOrdinals =
    summaryFacts === null
      ? [
          ...value.showTileThisFrameCalls.flatMap((call) => [
            call.enterEventOrdinal,
            call.exitEventOrdinal,
          ]),
          ...value.endUpdateCalls.flatMap((call) => [
            call.enterEventOrdinal,
            call.exitEventOrdinal,
          ]),
        ].sort((left, right) => left - right)
      : null;
  const eventOrdinalsExact =
    summaryFacts === null
      ? eventOrdinals.length === value.eventCount &&
        eventOrdinals.every((ordinal, index) => ordinal === index + 1)
      : summaryFacts.orderEventOrdinalsExact;
  const restorationExact =
    !value.restoration.restored ||
    (value.restoration.attempted &&
      value.restoration.showIdentityMatches &&
      value.restoration.showDescriptorMatches &&
      value.restoration.endIdentityMatches &&
      value.restoration.endDescriptorMatches);
  return (
    eventOrdinalsExact &&
    restorationExact &&
    (value.state === "installed" || value.restoration.restored)
  );
}

function s5ProgressArraySummaryEntries(
  firstReveal,
  orderProof,
  visibilitySeam,
) {
  const entries = [];
  for (const path of S5_VALIDATION_WITNESS_ARRAY_PATHS) {
    let value;
    if (path.startsWith("firstReveal.")) {
      value = firstReveal?.[path.slice("firstReveal.".length)];
    } else if (path.startsWith("orderProof.")) {
      value = orderProof?.[path.slice("orderProof.".length)];
    } else if (path === "visibilitySeam.calls") {
      value = visibilitySeam?.calls;
    } else {
      continue;
    }
    entries.push([value, path]);
  }
  return entries;
}

function computeFirstRevealPredicateResults(
  firstReveal,
  orderProof,
  allowArraySummaries = false,
) {
  const summaryFacts = consistentS5ArraySummaryFacts(
    s5ProgressArraySummaryEntries(firstReveal, orderProof, undefined),
  );
  const summarizedPredicates =
    summaryFacts !== null && summaryFacts !== undefined && allowArraySummaries
      ? summaryFacts.firstRevealPredicateResults
      : null;
  const summarizedPredicate = (key, fallback) =>
    summarizedPredicates === null ? fallback() : summarizedPredicates[key];
  const targetKey = firstReveal?.targetKey;
  const siblingKey = firstReveal?.siblingKey;
  const targetShowCalls =
    summarizedPredicates === null
      ? orderProof?.showTileThisFrameCalls?.filter(
          (call) => call.target && call.frameNumber === firstReveal?.frameAfter,
        )
      : undefined;
  const revealEndCalls =
    summarizedPredicates === null
      ? orderProof?.endUpdateCalls?.filter(
          (call) => call.frameNumber === firstReveal?.frameAfter,
        )
      : undefined;
  const targetShow = targetShowCalls?.[0];
  const revealEnd = revealEndCalls?.[0];
  const siblingRendered =
    summarizedPredicates === null &&
    firstReveal?.selectedRealSiblingTileIds?.includes(siblingKey) === true &&
    firstReveal?.selectedRealSiblingObservations?.some((selection) =>
      exactSelectionObservation(selection, siblingKey, 2, "RENDERED"),
    ) === true;
  return {
    captureWasFirstRenderAfterPassThrough:
      firstReveal?.frameDelta === 1 &&
      firstReveal?.frameAfter === firstReveal?.frameBefore + 1,
    sameTaskModeSwitchAndCapture:
      firstReveal?.sameTaskModeSwitchAndCapture === true,
    noYieldBeforeCapture: firstReveal?.noYieldBeforeCapture === true,
    consecutiveWarmAndRevealFrames:
      firstReveal?.frameBefore === firstReveal?.warmFrame &&
      firstReveal?.targetSelection?.selectionFrame ===
        firstReveal?.frameAfter &&
      firstReveal?.targetSelection?.selectionFrame ===
        firstReveal?.warmFrame + 1,
    exactlyOnePostArmTargetRequest:
      firstReveal?.postArmTargetRequestAttempts === 1 &&
      firstReveal?.targetRequestAttemptsAfter ===
        firstReveal?.targetRequestAttemptsBefore + 1,
    exactHeldTargetSet: summarizedPredicate(
      "exactHeldTargetSet",
      () =>
        firstReveal?.heldRequestCount === 1 &&
        firstReveal?.heldKeys?.length === 1 &&
        firstReveal?.heldKeys?.[0] === targetKey &&
        firstReveal?.targetHeldPromisePresent === true,
    ),
    exactReservedTargetSet: summarizedPredicate(
      "exactReservedTargetSet",
      () =>
        firstReveal?.reservedPromiseCount === 1 &&
        firstReveal?.reservedKeys?.length === 1 &&
        firstReveal?.reservedKeys?.[0] === targetKey &&
        firstReveal?.targetReservedPromisePresent === true,
    ),
    targetSameFrameRendered: exactSelectionObservation(
      firstReveal?.targetSelection,
      targetKey,
      2,
      "RENDERED",
    ),
    targetVisibilityPassThrough: summarizedPredicate(
      "targetVisibilityPassThrough",
      () =>
        firstReveal?.visibilityCalls?.length > 0 &&
        firstReveal.visibilityCalls.every(
          (call) =>
            call.tileKey === targetKey &&
            call.frameNumber === firstReveal?.targetSelection?.selectionFrame &&
            new Set([0, 1]).has(call.originalVisibility) &&
            call.returnedVisibility === call.originalVisibility &&
            call.overridden === false &&
            call.mode === "pass-through",
        ),
    ),
    targetSelected: summarizedPredicate(
      "targetSelected",
      () => firstReveal?.selectedTileIds?.includes(targetKey) === true,
    ),
    targetFill: summarizedPredicate(
      "targetFill",
      () => firstReveal?.fillTileIds?.includes(targetKey) === true,
    ),
    targetRealAbsent: summarizedPredicate(
      "targetRealAbsent",
      () => firstReveal?.realTileIds?.includes(targetKey) === false,
    ),
    terrainFillMeshInstance:
      firstReveal?.fillMesh?.terrainFillMeshInstance === true,
    renderedMeshMatchesFill:
      firstReveal?.fillMesh?.renderedMeshMatches === true,
    realMeshAbsent: firstReveal?.fillMesh?.realMeshAbsent === true,
    positiveVertexCount:
      Number.isInteger(firstReveal?.fillMesh?.vertexCountWithoutSkirts) &&
      firstReveal.fillMesh.vertexCountWithoutSkirts > 0,
    positiveIndexCount:
      Number.isInteger(firstReveal?.fillMesh?.indexCount) &&
      firstReveal.fillMesh.indexCount > 0,
    noSelectedStrictDescendants: summarizedPredicate(
      "noSelectedStrictDescendants",
      () => firstReveal?.targetSelectedStrictDescendantTileIds?.length === 0,
    ),
    noRealStrictDescendants: summarizedPredicate(
      "noRealStrictDescendants",
      () => firstReveal?.targetRealStrictDescendantTileIds?.length === 0,
    ),
    noFillStrictDescendants: summarizedPredicate(
      "noFillStrictDescendants",
      () => firstReveal?.targetFillStrictDescendantTileIds?.length === 0,
    ),
    anchorSiblingRendered: summarizedPredicate(
      "anchorSiblingRendered",
      () => siblingRendered,
    ),
    providerLoadedAndFillFlags:
      firstReveal?.providerFlags?.hasLoadedTilesThisFrame === true &&
      firstReveal?.providerFlags?.hasFillTilesThisFrame === true &&
      firstReveal?.providerFlags?.loadedAndFillFlags === true,
    targetShownExactlyOnce: summarizedPredicate(
      "targetShownExactlyOnce",
      () => targetShowCalls?.length === 1,
    ),
    targetShowBeforeEndUpdate: summarizedPredicate(
      "targetShowBeforeEndUpdate",
      () =>
        targetShowCalls?.length === 1 &&
        revealEndCalls?.length === 1 &&
        targetShow.exitEventOrdinal < revealEnd.enterEventOrdinal,
    ),
    endUpdateExactlyOnce: summarizedPredicate(
      "endUpdateExactlyOnce",
      () => revealEndCalls?.length === 1,
    ),
    coherentSameFrameOrderSurfaces: summarizedPredicate(
      "coherentSameFrameOrderSurfaces",
      () =>
        targetShowCalls?.length === 1 &&
        revealEndCalls?.length === 1 &&
        targetShow.tileStateBefore.quadtreeState ===
          C12_29_S5_REVEAL_LIFECYCLE.quadtreeStart &&
        targetShow.tileStateBefore.terrainState ===
          C12_29_S5_REVEAL_LIFECYCLE.terrainUnloaded &&
        exactObjectValues(
          targetShow.tileStateBefore,
          targetShow.tileStateAfter,
          TILE_MESH_STATE_KEYS,
        ) &&
        exactObjectValues(
          targetShow.tileStateAfter,
          revealEnd.targetStateBefore,
          TILE_MESH_STATE_KEYS,
        ) &&
        exactObjectValues(
          targetShow.providerFlagsAfter,
          revealEnd.providerFlagsBefore,
          PROVIDER_FRAME_FLAG_KEYS,
        ) &&
        exactObjectValues(
          revealEnd.providerFlagsAfter,
          firstReveal?.providerFlags,
          PROVIDER_FRAME_FLAG_KEYS,
        ) &&
        revealEnd.providerFlagsAfter.loadedAndFillFlags ===
          firstReveal?.loadedAndFillFlags,
    ),
    postEndUpdateLoadTransitionExact: summarizedPredicate(
      "postEndUpdateLoadTransitionExact",
      () =>
        revealEndCalls?.length === 1 &&
        revealEnd.targetStateAfter.quadtreeState ===
          C12_29_S5_REVEAL_LIFECYCLE.quadtreeLoading &&
        revealEnd.targetStateAfter.terrainState ===
          C12_29_S5_REVEAL_LIFECYCLE.terrainUnloaded &&
        firstReveal?.targetState?.quadtreeState ===
          C12_29_S5_REVEAL_LIFECYCLE.quadtreeLoading &&
        firstReveal?.targetState?.terrainState ===
          C12_29_S5_REVEAL_LIFECYCLE.terrainReceiving &&
        exactTileMeshStateExceptTerrainState(
          revealEnd.targetStateAfter,
          firstReveal.targetState,
        ) &&
        firstReveal?.postArmTargetRequestAttempts === 1 &&
        firstReveal?.heldRequestCount === 1 &&
        firstReveal?.reservedPromiseCount === 1 &&
        firstReveal?.releasedRequestCount === 0 &&
        firstReveal?.rejectedRequestCount === 0 &&
        firstReveal?.heldKeys?.length === 1 &&
        firstReveal.heldKeys[0] === targetKey &&
        firstReveal?.reservedKeys?.length === 1 &&
        firstReveal.reservedKeys[0] === targetKey &&
        firstReveal?.targetHeldPromisePresent === true &&
        firstReveal?.targetReservedPromisePresent === true,
    ),
    showMarkedFillBeforeEndUpdate: summarizedPredicate(
      "showMarkedFillBeforeEndUpdate",
      () =>
        targetShowCalls?.length === 1 &&
        targetShow.providerFlagsAfter.hasFillTilesThisFrame === true &&
        revealEndCalls?.length === 1 &&
        revealEnd.providerFlagsBefore.hasLoadedTilesThisFrame === true &&
        revealEnd.providerFlagsBefore.hasFillTilesThisFrame === true,
    ),
    exactLowDetailFillMeshShape:
      exactLowDetailFillMeshMeasurements(firstReveal?.fillMesh) &&
      exactLowDetailFillMeshMeasurements(firstReveal?.targetState),
    endUpdateConstructedFill: summarizedPredicate(
      "endUpdateConstructedFill",
      () =>
        revealEndCalls?.length === 1 &&
        revealEnd.targetStateBefore.fillMeshDefined === false &&
        revealEnd.targetStateAfter.terrainFillMeshInstance === true &&
        revealEnd.targetStateAfter.fillMeshDefined === true &&
        revealEnd.targetStateAfter.renderedMeshMatchesFill === true &&
        revealEnd.targetStateAfter.realMeshDefined === false &&
        exactLowDetailFillMeshMeasurements(revealEnd.targetStateAfter),
    ),
    visibilityRestored: firstReveal?.restoration?.visibilityRestored === true,
    orderInstrumentationRestored:
      firstReveal?.restoration?.orderInstrumentationRestored === true,
  };
}

function validFirstRevealProgress(
  value,
  orderProof,
  visibilitySeam,
  allowArraySummaries = false,
) {
  if (
    !exactObjectKeys(value, FIRST_REVEAL_KEYS) ||
    !new Set(["started", "captured", "evaluated"]).has(value.state) ||
    !/^1\/\d+\/\d+$/u.test(value.targetKey) ||
    value.siblingKey === value.targetKey ||
    !/^1\/\d+\/\d+$/u.test(value.siblingKey) ||
    ![value.sameTaskModeSwitchAndCapture, value.noYieldBeforeCapture].every(
      (entry) => typeof entry === "boolean",
    ) ||
    !Number.isInteger(value.warmFrame) ||
    !Number.isInteger(value.frameBefore)
  ) {
    return false;
  }
  const progressArrayEntries = s5ProgressArraySummaryEntries(
    value,
    orderProof,
    visibilitySeam,
  );
  if (
    !progressArrayEntries.every(([entry, path]) =>
      validS5ArrayOrSummaryAtPath(entry, path, allowArraySummaries),
    )
  ) {
    return false;
  }
  const summaryFacts = consistentS5ArraySummaryFacts(progressArrayEntries);
  if (summaryFacts === undefined) return false;
  if (summaryFacts !== null) {
    const computedPredicates =
      value.state === "evaluated"
        ? computeFirstRevealPredicateResults(value, orderProof, true)
        : null;
    const derivedTarget = deriveS5SouthLevelOneTarget(
      value.longitude,
      value.latitude,
    );
    return (
      allowArraySummaries &&
      summaryFacts.firstRevealArrayRelationsValid === true &&
      (value.state === "evaluated"
        ? summaryFacts.firstRevealPredicateResults !== null &&
          exactObjectKeys(
            value.predicateResults,
            FIRST_REVEAL_PREDICATE_KEYS,
          ) &&
          FIRST_REVEAL_PREDICATE_KEYS.every(
            (key) =>
              typeof value.predicateResults[key] === "boolean" &&
              value.predicateResults[key] === computedPredicates[key],
          ) &&
          [
            value.longitude,
            value.latitude,
            value.cameraHeightMeters,
            value.cameraFovDegrees,
            value.maximumScreenSpaceError,
          ].every(Number.isFinite) &&
          derivedTarget?.key === value.targetKey &&
          derivedTarget?.anchorKey === value.siblingKey &&
          value.selectedCount ===
            s5ValidationArrayLength(
              value.selectedTileIds,
              "firstReveal.selectedTileIds",
            ) &&
          value.realMeshCount ===
            s5ValidationArrayLength(
              value.realTileIds,
              "firstReveal.realTileIds",
            ) &&
          value.fillCount ===
            s5ValidationArrayLength(
              value.fillTileIds,
              "firstReveal.fillTileIds",
            ) &&
          value.heldRequestCount ===
            s5ValidationArrayLength(value.heldKeys, "firstReveal.heldKeys") &&
          value.reservedPromiseCount ===
            s5ValidationArrayLength(
              value.reservedKeys,
              "firstReveal.reservedKeys",
            ) &&
          s5ValidationArrayLength(
            value.visibilityTargetCallOrdinals,
            "firstReveal.visibilityTargetCallOrdinals",
          ) ===
            s5ValidationArrayLength(
              value.visibilityCalls,
              "firstReveal.visibilityCalls",
            ) &&
          s5ValidationArrayLength(
            value.selectedRealSiblingTileIds,
            "firstReveal.selectedRealSiblingTileIds",
          ) ===
            s5ValidationArrayLength(
              value.selectedRealSiblingObservations,
              "firstReveal.selectedRealSiblingObservations",
            )
        : summaryFacts.firstRevealPredicateResults === null &&
          value.predicateResults === null)
    );
  }
  if (value.state === "started") {
    const exactNullKeys = [
      "captureWasFirstRenderAfterPassThrough",
      "frameAfter",
      "frameDelta",
      "longitude",
      "latitude",
      "cameraHeightMeters",
      "cameraFovDegrees",
      "maximumScreenSpaceError",
      "targetRequestAttemptsAfter",
      "postArmTargetRequestAttempts",
      "targetSelection",
      "selectedCount",
      "realMeshCount",
      "fillCount",
      "heldRequestCount",
      "reservedPromiseCount",
      "releasedRequestCount",
      "rejectedRequestCount",
      "targetHeldPromisePresent",
      "targetReservedPromisePresent",
      "providerFlags",
      "loadedAndFillFlags",
      "tilesLoaded",
      "targetSelected",
      "targetReal",
      "targetFill",
      "targetState",
      "fillMesh",
      "predicateResults",
    ];
    const exactEmptyArrayKeys = [
      "visibilityTargetCallOrdinals",
      "visibilityCalls",
      "selectedTileIds",
      "realTileIds",
      "fillTileIds",
      "targetSelectedDescendantTileIds",
      "targetRealDescendantTileIds",
      "targetFillDescendantTileIds",
      "targetSelectedStrictDescendantTileIds",
      "targetRealStrictDescendantTileIds",
      "targetFillStrictDescendantTileIds",
      "selectedRealSiblingTileIds",
      "selectedRealSiblingObservations",
      "heldKeys",
      "reservedKeys",
    ];
    return (
      nonNegativeInteger(value.targetRequestAttemptsBefore) &&
      exactNullKeys.every((key) => value[key] === null) &&
      exactEmptyArrayKeys.every(
        (key) =>
          exactDenseS5ArrayAtPath(value[key], `firstReveal.${key}`) &&
          value[key].length === 0,
      ) &&
      exactObjectKeys(value.restoration, [
        "visibilityRestored",
        "orderInstrumentationRestored",
      ]) &&
      value.restoration.visibilityRestored ===
        visibilitySeam?.restoration?.restored &&
      value.restoration.orderInstrumentationRestored ===
        orderProof?.restoration?.restored &&
      validOrderProofProgress(orderProof) &&
      orderProof.targetKey === value.targetKey &&
      new Set(["installed", "restored", "error-restored"]).has(orderProof.state)
    );
  }
  const stringArrayKeys = [
    "selectedTileIds",
    "realTileIds",
    "fillTileIds",
    "targetSelectedDescendantTileIds",
    "targetRealDescendantTileIds",
    "targetFillDescendantTileIds",
    "targetSelectedStrictDescendantTileIds",
    "targetRealStrictDescendantTileIds",
    "targetFillStrictDescendantTileIds",
    "selectedRealSiblingTileIds",
    "heldKeys",
    "reservedKeys",
  ];
  const fillMesh = value.fillMesh;
  const targetDescendantsFrom = (tileIds) =>
    tileIds.filter((id) => levelOneAncestorKey(id) === value.targetKey).sort();
  const targetSelectedDescendants = targetDescendantsFrom(
    value.selectedTileIds,
  );
  const targetRealDescendants = targetDescendantsFrom(value.realTileIds);
  const targetFillDescendants = targetDescendantsFrom(value.fillTileIds);
  const strictDescendants = (tileIds) =>
    tileIds.filter((id) => id !== value.targetKey);
  const observedSiblingIds = value.selectedRealSiblingObservations
    .map((selection) => selection?.tileId)
    .sort();
  const derivedTarget = deriveS5SouthLevelOneTarget(
    value.longitude,
    value.latitude,
  );
  if (
    !Number.isInteger(value.frameAfter) ||
    !Number.isInteger(value.frameDelta) ||
    value.frameDelta !== value.frameAfter - value.frameBefore ||
    value.captureWasFirstRenderAfterPassThrough !==
      (value.frameDelta === 1 && value.frameAfter === value.frameBefore + 1) ||
    ![
      value.longitude,
      value.latitude,
      value.cameraHeightMeters,
      value.cameraFovDegrees,
      value.maximumScreenSpaceError,
    ].every(Number.isFinite) ||
    ![
      value.targetRequestAttemptsBefore,
      value.targetRequestAttemptsAfter,
      value.postArmTargetRequestAttempts,
      value.selectedCount,
      value.realMeshCount,
      value.fillCount,
      value.heldRequestCount,
      value.reservedPromiseCount,
      value.releasedRequestCount,
      value.rejectedRequestCount,
    ].every(nonNegativeInteger) ||
    value.postArmTargetRequestAttempts !==
      value.targetRequestAttemptsAfter - value.targetRequestAttemptsBefore ||
    !stringArrayKeys.every((key) => exactSortedUniqueTileIds(value[key])) ||
    !exactTerrainSnapshotPartition(
      value.selectedTileIds,
      value.realTileIds,
      value.fillTileIds,
    ) ||
    !exactS5ArrayValues(
      value.targetSelectedDescendantTileIds,
      targetSelectedDescendants,
    ) ||
    !exactS5ArrayValues(
      value.targetRealDescendantTileIds,
      targetRealDescendants,
    ) ||
    !exactS5ArrayValues(
      value.targetFillDescendantTileIds,
      targetFillDescendants,
    ) ||
    !exactS5ArrayValues(
      value.targetSelectedStrictDescendantTileIds,
      strictDescendants(targetSelectedDescendants),
    ) ||
    !exactS5ArrayValues(
      value.targetRealStrictDescendantTileIds,
      strictDescendants(targetRealDescendants),
    ) ||
    !exactS5ArrayValues(
      value.targetFillStrictDescendantTileIds,
      strictDescendants(targetFillDescendants),
    ) ||
    value.selectedCount !== value.selectedTileIds.length ||
    value.realMeshCount !== value.realTileIds.length ||
    value.fillCount !== value.fillTileIds.length ||
    value.heldRequestCount !== value.heldKeys.length ||
    value.reservedPromiseCount !== value.reservedKeys.length ||
    value.targetHeldPromisePresent !==
      value.heldKeys.includes(value.targetKey) ||
    value.targetReservedPromisePresent !==
      value.reservedKeys.includes(value.targetKey) ||
    derivedTarget?.key !== value.targetKey ||
    derivedTarget?.anchorKey !== value.siblingKey ||
    !value.selectedRealSiblingTileIds.includes(value.siblingKey) ||
    !value.selectedRealSiblingTileIds.every((id) =>
      derivedTarget.siblingKeys.includes(id),
    ) ||
    !exactS5ArrayValues(value.selectedRealSiblingTileIds, observedSiblingIds) ||
    !value.selectedRealSiblingObservations.every(
      (selection) =>
        value.selectedTileIds.includes(selection?.tileId) &&
        value.realTileIds.includes(selection?.tileId) &&
        selection?.tileId !== value.targetKey &&
        exactSelectionObservation(selection, selection?.tileId, 2, "RENDERED"),
    ) ||
    value.visibilityCalls.length === 0 ||
    !value.visibilityCalls.every(
      (call, index) =>
        Number.isInteger(call?.ordinal) &&
        call.ordinal > 0 &&
        (index === 0 ||
          value.visibilityCalls[index - 1].ordinal < call.ordinal) &&
        call.tileKey === value.targetKey &&
        call.frameNumber === value.targetSelection?.selectionFrame &&
        JSON.stringify(call) ===
          JSON.stringify(visibilitySeam?.calls?.[call.ordinal - 1]),
    ) ||
    new Set(value.visibilityCalls.map((call) => call.ordinal)).size !==
      value.visibilityCalls.length ||
    !exactS5ArrayValues(
      value.visibilityTargetCallOrdinals,
      value.visibilityCalls.map((call) => call.ordinal),
    ) ||
    !validProviderFrameFlags(value.providerFlags) ||
    value.loadedAndFillFlags !== value.providerFlags.loadedAndFillFlags ||
    typeof value.tilesLoaded !== "boolean" ||
    value.targetSelected !== value.selectedTileIds.includes(value.targetKey) ||
    value.targetReal !== value.realTileIds.includes(value.targetKey) ||
    value.targetFill !== value.fillTileIds.includes(value.targetKey) ||
    !validTileMeshState(value.targetState) ||
    !exactObjectKeys(fillMesh, [
      "tileId",
      "fillDefined",
      "fillMeshDefined",
      "renderedMeshDefined",
      "realMeshDefined",
      "terrainFillMeshInstance",
      "renderedMeshMatches",
      "realMeshAbsent",
      ...MESH_MEASUREMENT_KEYS,
    ]) ||
    fillMesh.tileId !== value.targetKey ||
    ![
      fillMesh.fillDefined,
      fillMesh.fillMeshDefined,
      fillMesh.renderedMeshDefined,
      fillMesh.realMeshDefined,
      fillMesh.terrainFillMeshInstance,
      fillMesh.renderedMeshMatches,
      fillMesh.realMeshAbsent,
    ].every((entry) => typeof entry === "boolean") ||
    !validMeshMeasurements(fillMesh) ||
    fillMesh.fillDefined !== value.targetState.fillDefined ||
    fillMesh.fillMeshDefined !== value.targetState.fillMeshDefined ||
    fillMesh.renderedMeshDefined !== value.targetState.renderedMeshDefined ||
    fillMesh.realMeshDefined !== value.targetState.realMeshDefined ||
    fillMesh.terrainFillMeshInstance !==
      value.targetState.terrainFillMeshInstance ||
    fillMesh.renderedMeshMatches !==
      value.targetState.renderedMeshMatchesFill ||
    fillMesh.realMeshAbsent !== !value.targetState.realMeshDefined ||
    !MESH_MEASUREMENT_KEYS.every((key) =>
      Object.is(fillMesh[key], value.targetState[key]),
    ) ||
    !exactObjectKeys(value.restoration, [
      "visibilityRestored",
      "orderInstrumentationRestored",
    ]) ||
    !Object.values(value.restoration).every(
      (entry) => typeof entry === "boolean",
    ) ||
    !validOrderProofProgress(orderProof) ||
    orderProof.targetKey !== value.targetKey ||
    visibilitySeam?.targetKey !== value.targetKey
  ) {
    return false;
  }
  if (value.state === "captured") {
    return value.predicateResults === null;
  }
  const computed = computeFirstRevealPredicateResults(
    value,
    orderProof,
    allowArraySummaries,
  );
  return (
    exactObjectKeys(value.predicateResults, FIRST_REVEAL_PREDICATE_KEYS) &&
    FIRST_REVEAL_PREDICATE_KEYS.every(
      (key) =>
        typeof value.predicateResults[key] === "boolean" &&
        value.predicateResults[key] === computed[key],
    ) &&
    value.restoration.visibilityRestored ===
      visibilitySeam?.restoration?.restored &&
    value.restoration.orderInstrumentationRestored ===
      orderProof.restoration.restored
  );
}

export function validateS5PageProgress(
  value,
  renderer = value?.renderer,
  allowArraySummaries = value?.[S5_VALIDATION_WITNESS_BRAND] === true,
) {
  const reasons = [];
  const completed = value?.completedPhases;
  const completedIsExact = exactDenseS5ArrayAtPath(
    completed,
    "completedPhases",
  );
  const requests = value?.terrainRequests;
  const pick = value?.pick;
  const optionalDetailKey = Object.hasOwn(value ?? {}, "detail")
    ? ["detail"]
    : [];
  if (
    !exactObjectKeys(value, [
      "schema",
      "renderer",
      "currentPhase",
      "step",
      "completedPhases",
      "elapsedMs",
      "settle",
      "terrainRequests",
      "pick",
      "firstReveal",
      "orderProof",
      "visibilitySeam",
      ...optionalDetailKey,
    ])
  ) {
    reasons.push(C12_29_S5_PAGE_VALIDATION_REASONS[0]);
  }
  if (
    value?.schema !== C12_29_S5_DIAGNOSTICS_SCHEMA ||
    value?.renderer !== renderer ||
    !C12_29_S5_RENDERERS.includes(renderer)
  ) {
    reasons.push(C12_29_S5_PAGE_VALIDATION_REASONS[1]);
  }
  if (
    !new Set(["preflight", ...C12_29_S5_PHASES]).has(value?.currentPhase) ||
    typeof value?.step !== "string" ||
    value.step.length === 0 ||
    !nonNegativeInteger(value?.elapsedMs)
  ) {
    reasons.push(C12_29_S5_PAGE_VALIDATION_REASONS[2]);
  }
  if (
    !completedIsExact ||
    (completedIsExact &&
      !completed.every((phase, index) => phase === C12_29_S5_PHASES[index]))
  ) {
    reasons.push(C12_29_S5_PAGE_VALIDATION_REASONS[3]);
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
    reasons.push(C12_29_S5_PAGE_VALIDATION_REASONS[4]);
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
    reasons.push(C12_29_S5_PAGE_VALIDATION_REASONS[5]);
  }
  if (
    !validVisibilitySeamProgress(value?.visibilitySeam, allowArraySummaries)
  ) {
    reasons.push(C12_29_S5_PAGE_VALIDATION_REASONS[6]);
  }
  const revealStarted =
    (completedIsExact && completed.includes(C12_29_S5_PHASES[2])) ||
    (value?.currentPhase === C12_29_S5_PHASES[2] &&
      value?.step === "first-pass-through-render-and-fused-fill-capture");
  if (!revealStarted) {
    if (value?.firstReveal !== null || value?.orderProof !== null) {
      reasons.push(C12_29_S5_PAGE_VALIDATION_REASONS[7]);
    }
  } else if (
    !validOrderProofProgress(value?.orderProof, allowArraySummaries) ||
    !validFirstRevealProgress(
      value?.firstReveal,
      value?.orderProof,
      value?.visibilitySeam,
      allowArraySummaries,
    )
  ) {
    reasons.push(C12_29_S5_PAGE_VALIDATION_REASONS[8]);
  }
  if (
    value?.visibilitySeam?.terminalReason ===
      "first pass-through render did not produce the exact held L1 fill" &&
    (value?.firstReveal?.state !== "evaluated" ||
      !Object.values(value.firstReveal.predicateResults ?? {}).some(
        (entry) => entry === false,
      ))
  ) {
    reasons.push(C12_29_S5_PAGE_VALIDATION_REASONS[9]);
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
    !exactDenseS5ArrayAtPath(
      observation?.selectedTileIds,
      "firstReveal.selectedTileIds",
    ) ||
    !exactDenseS5ArrayAtPath(
      observation?.realTileIds,
      "firstReveal.realTileIds",
    ) ||
    !exactDenseS5ArrayAtPath(
      observation?.fillTileIds,
      "firstReveal.fillTileIds",
    ) ||
    !exactDenseS5ArrayAtPath(
      observation?.selectedRealSiblingObservations,
      "firstReveal.selectedRealSiblingObservations",
    )
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
  const siblingSelections = observation.selectedRealSiblingObservations;
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
    const pageValidation = diagnostics?.pageValidation;
    const rawPage = diagnostics?.rawPage;
    const validPageValidation =
      exactObjectKeys(pageValidation, [
        "status",
        "reasons",
        "diagnosticSha256",
      ]) &&
      new Set([
        "not-read",
        "fulfilled-valid",
        "fulfilled-invalid",
        "rejected",
        "timeout",
      ]).has(pageValidation?.status) &&
      validCanonicalS5PageValidationReasons(pageValidation?.reasons);
    const parsedRawPage =
      rawPage === null
        ? { ok: true, value: null }
        : validateS5RawPageDiagnosticJson(
            rawPage?.json,
            diagnostics?.renderer ?? undefined,
          );
    const validRawPage =
      rawPage === null ||
      (exactObjectKeys(rawPage, [
        "format",
        "truncated",
        "originalByteLength",
        "json",
      ]) &&
        rawPage.format === "bounded-json-v1" &&
        rawPage.truncated === true &&
        rawPage.originalByteLength === null &&
        typeof rawPage.json === "string" &&
        rawPage.json.length > 0 &&
        parsedRawPage.ok);
    const diagnosticPageStateExact =
      validPageValidation &&
      validRawPage &&
      (pageValidation.status === "fulfilled-valid"
        ? diagnostics?.page !== null &&
          rawPage === null &&
          pageValidation.reasons.length === 0 &&
          SHA256.test(pageValidation.diagnosticSha256 ?? "") &&
          pageValidation.diagnosticSha256 ===
            hashS5DiagnosticJson(JSON.stringify(diagnostics.page)) &&
          diagnostics?.renderer !== null &&
          validateS5PageDiagnosticProjection(
            diagnostics.page,
            diagnostics.renderer,
          )
        : pageValidation.status === "fulfilled-invalid"
          ? diagnostics?.page === null &&
            rawPage !== null &&
            diagnostics?.renderer !== null &&
            C12_29_S5_RENDERERS.includes(diagnostics?.renderer) &&
            pageValidation.reasons.length > 0 &&
            SHA256.test(pageValidation.diagnosticSha256 ?? "") &&
            pageValidation.diagnosticSha256 ===
              hashS5DiagnosticJson(rawPage.json) &&
            pageValidation.reasons.length ===
              reasonsFromS5ValidationFailures(
                parsedRawPage.value.validationFailures,
              ).length &&
            pageValidation.reasons.every(
              (reason, index) =>
                reason ===
                reasonsFromS5ValidationFailures(
                  parsedRawPage.value.validationFailures,
                )[index],
            )
          : diagnostics?.page === null &&
            rawPage === null &&
            pageValidation.reasons.length === 0 &&
            pageValidation.diagnosticSha256 === null);
    if (typeof artifact?.error !== "string" || artifact.error.length === 0) {
      reasons.push("ERROR artifact must preserve its error text");
    }
    if (
      !exactObjectKeys(diagnostics, [
        "schema",
        "renderer",
        "stage",
        "timeoutMs",
        "node",
        "page",
        "pageValidation",
        "rawPage",
      ]) ||
      diagnostics?.schema !== C12_29_S5_DIAGNOSTICS_SCHEMA ||
      typeof diagnostics?.stage !== "string" ||
      diagnostics.stage.length === 0 ||
      !Number.isInteger(diagnostics?.timeoutMs) ||
      diagnostics.timeoutMs <= 0 ||
      !diagnostics?.node ||
      typeof diagnostics.node.stage !== "string" ||
      diagnostics.node.stage.length === 0 ||
      !Object.hasOwn(diagnostics.node, "requestLedger") ||
      !validRequestLedger(diagnostics.node.requestLedger) ||
      !(
        diagnostics?.renderer === null ||
        C12_29_S5_RENDERERS.includes(diagnostics?.renderer)
      ) ||
      !diagnosticPageStateExact
    ) {
      reasons.push(
        "ERROR artifact must preserve exact pre-session phase/request diagnostics",
      );
    }
  }
  return { ok: reasons.length === 0, reasons };
}

function exactSortedUniqueStrings(value) {
  return (
    exactDenseS5Array(value, C12_29_S5_PROGRESS_LEDGER_MAX_LENGTH) &&
    value.every((entry) => typeof entry === "string") &&
    new Set(value).size === value.length &&
    value.every((entry, index) => index === 0 || value[index - 1] < entry)
  );
}

function exactSortedUniqueTileIds(value) {
  return (
    exactSortedUniqueStrings(value) &&
    value.every(validS5ValidationWitnessTileId)
  );
}

/**
 * A terrain snapshot is a related selection/carrier tuple, not three
 * unrelated ledgers. Every rendered carrier must be selected, and a carrier
 * cannot be both real and fill. Selected tiles without a materialized mesh are
 * permitted because selection can precede renderability in the same frame.
 */
function exactTerrainSnapshotPartition(selected, real, fill) {
  if (
    !exactSortedUniqueTileIds(selected) ||
    !exactSortedUniqueTileIds(real) ||
    !exactSortedUniqueTileIds(fill)
  ) {
    return false;
  }
  const selectedSet = new Set(selected);
  const realSet = new Set(real);
  const fillSet = new Set(fill);
  return (
    real.every((tileId) => selectedSet.has(tileId)) &&
    fill.every((tileId) => selectedSet.has(tileId)) &&
    real.every((tileId) => !fillSet.has(tileId)) &&
    (real.length > 0 || fill.length > 0) &&
    selectedSet.size >= new Set([...realSet, ...fillSet]).size
  );
}

function exactSelectionObservation(observation, tileId, rawResult, name) {
  return (
    exactObjectKeys(observation, [
      "tileId",
      "instantiated",
      "selectionFrame",
      "resultFrame",
      "sameFrame",
      "rawResult",
      "rawResultName",
      "originalResult",
      "originalResultName",
      "wasKicked",
    ]) &&
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

function validReadableSourceFingerprint(value, expectedFile) {
  return (
    exactObjectKeys(value, ["file", "exists", "byteLength", "sha256"]) &&
    isAbsoluteIdentityPath(value.file) &&
    hasExactIdentityPathSuffix(value.file, expectedFile) &&
    value.exists === true &&
    Number.isInteger(value.byteLength) &&
    value.byteLength > 0 &&
    SHA256.test(value.sha256 ?? "")
  );
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
    !exactDenseS5Array(value.reasons, 0) ||
    value.reasons.length !== 0 ||
    !isAbsoluteIdentityPath(value.sourceMapPath) ||
    !hasExactIdentityPathSuffix(
      value.sourceMapPath,
      C12_29_S5_BUILD_SOURCE_MAP,
    ) ||
    !Number.isInteger(value.sourceMapByteLength) ||
    value.sourceMapByteLength < 1 ||
    !SHA256.test(value.sourceMapSha256 ?? "") ||
    !exactDenseS5Array(entries, C12_29_S5_BUILD_SOURCE_FILES.length) ||
    entries.length !== C12_29_S5_BUILD_SOURCE_FILES.length
  ) {
    return false;
  }

  return C12_29_S5_BUILD_SOURCE_FILES.every((file, index) => {
    const entry = entries[index];
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
  const sourceIdentities = provenance?.sourceBoundary?.identities;
  const startSourceIdentity = provenance?.start?.localIdentity;
  const endSourceIdentity = provenance?.end?.localIdentity;
  const provenanceArraysExact =
    exactEmptyS5Array(provenance?.reasons) &&
    exactEmptyS5Array(provenance?.start?.reasons) &&
    exactEmptyS5Array(provenance?.end?.reasons) &&
    exactEmptyS5Array(provenance?.servedEntryIdentity?.reasons) &&
    exactS5ArrayValues(
      provenance?.servedEntryIdentity?.expectedLabels,
      C12_29_S5_RENDERERS,
    ) &&
    exactS5ArrayValues(
      provenance?.servedEntryIdentity?.observedLabels,
      C12_29_S5_RENDERERS,
    ) &&
    exactDenseS5Array(sourceIdentities, C12_29_S5_SOURCE_FILES.length) &&
    sourceIdentities.length === C12_29_S5_SOURCE_FILES.length &&
    C12_29_S5_SOURCE_FILES.every((file, index) => {
      const key = `source${String(index).padStart(2, "0")}`;
      const retained = sourceIdentities[index];
      const start = startSourceIdentity?.[key];
      const end = endSourceIdentity?.[key];
      return (
        validReadableSourceFingerprint(retained, file) &&
        validReadableSourceFingerprint(start, file) &&
        validReadableSourceFingerprint(end, file) &&
        retained.byteLength === start.byteLength &&
        retained.sha256 === start.sha256 &&
        retained.byteLength === end.byteLength &&
        retained.sha256 === end.sha256
      );
    }) &&
    C12_29_S5_BUILD_SOURCE_FILES.every((file, index) => {
      const sourceIndex = C12_29_S5_SOURCE_FILES.indexOf(file);
      const source = sourceIdentities[sourceIndex];
      const build = provenance?.buildSourceIdentity?.entries?.[index];
      return (
        sourceIndex >= 0 &&
        build?.currentByteLength === source?.byteLength &&
        build?.currentSha256 === source?.sha256
      );
    }) &&
    validBuildSourceIdentity(provenance?.start?.buildSourceIdentity) &&
    validBuildSourceIdentity(provenance?.end?.buildSourceIdentity) &&
    JSON.stringify(provenance.start.buildSourceIdentity) ===
      JSON.stringify(provenance.buildSourceIdentity) &&
    JSON.stringify(provenance.end.buildSourceIdentity) ===
      JSON.stringify(provenance.buildSourceIdentity);
  if (!provenanceArraysExact) {
    structural.push(
      "start/end provenance arrays are not exact frozen boundaries and digests",
    );
  }
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
    !exactS5ArrayValues(
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
    !exactS5ArrayValues(
      provenance?.servedEntryIdentity?.expectedLabels,
      C12_29_S5_RENDERERS,
    )
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
    !exactDenseS5Array(images, C12_29_S5_CAPTURE_LABELS.length) ||
    images.length !== C12_29_S5_CAPTURE_LABELS.length ||
    !exactS5ArrayValues(
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
    !exactS5ArrayValues(Object.keys(phases), C12_29_S5_PHASES) ||
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
    !exactEmptyS5Array(session?.transport?.externalRequests) ||
    !exactEmptyS5Array(session?.transport?.failedRequests) ||
    !exactEmptyS5Array(session?.transport?.httpErrors)
  ) {
    structural.push(
      `${renderer}: browser transport escaped loopback/offline scope`,
    );
  }
  if (
    !exactEmptyS5Array(session?.runtime?.pageErrors) ||
    !exactEmptyS5Array(session?.runtime?.consoleErrors) ||
    !exactEmptyS5Array(session?.runtime?.gpuErrors) ||
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
  const orderProof = c?.orderProof;
  const lod = a?.fillLodPrecondition;
  const seam = c?.visibilitySeam;
  const aSnapshotExact =
    exactTerrainSnapshotPartition(
      lod?.selectedTileIds,
      lod?.realTileIds,
      lod?.fillTileIds,
    ) &&
    exactS5ArrayValues(a?.selectedTileIds, lod.selectedTileIds) &&
    a?.selectedCount === a.selectedTileIds.length &&
    lod.fillTileIds.length === 0 &&
    exactS5ArrayValues(lod.selectedTileIds, lod.realTileIds);
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
    exactS5ArrayValues(target?.siblingKeys, expectedHeldTarget?.siblingKeys);
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
    !aSnapshotExact ||
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
    exactDenseS5Array(calls, C12_29_S5_PROGRESS_LEDGER_MAX_LENGTH) &&
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
  const computedFirstRevealPredicates = computeFirstRevealPredicateResults(
    firstReveal,
    orderProof,
  );
  const firstRevealPredicatesExact =
    firstReveal?.state === "evaluated" &&
    validFirstRevealProgress(firstReveal, orderProof, seam) &&
    validOrderProofProgress(orderProof) &&
    exactOrderPropertyInstallation(
      orderProof?.installation?.showTileThisFrame,
    ) &&
    exactOrderPropertyInstallation(orderProof?.installation?.endUpdate) &&
    orderProof?.restoration?.attemptedAt ===
      "immediately-after-reveal-snapshot" &&
    orderProof?.restoration?.finallyVerified === true &&
    exactObjectKeys(
      firstReveal?.predicateResults,
      FIRST_REVEAL_PREDICATE_KEYS,
    ) &&
    FIRST_REVEAL_PREDICATE_KEYS.every(
      (key) =>
        firstReveal.predicateResults[key] === true &&
        firstReveal.predicateResults[key] ===
          computedFirstRevealPredicates[key],
    );
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
    !exactS5ArrayValues(
      seam?.warmTargetCallOrdinals,
      warmFrameCalls.map((call) => call.ordinal),
    ) ||
    !exactS5ArrayValues(
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
    exactSortedUniqueTileIds(warmup?.selectedRealSiblingTileIds) &&
    exactDenseS5Array(warmup?.selectedRealSiblingObservations, 3) &&
    warmup.selectedRealSiblingObservations.length ===
      warmup.selectedRealSiblingTileIds.length &&
    warmup?.selectedRealSiblingTileIds?.includes(expectedSiblingKey) &&
    warmup.selectedRealSiblingObservations.every((selection, index) =>
      exactSelectionObservation(
        selection,
        warmup.selectedRealSiblingTileIds[index],
        2,
        "RENDERED",
      ),
    );
  const revealSiblingExact =
    exactSortedUniqueTileIds(firstReveal?.selectedRealSiblingTileIds) &&
    exactDenseS5Array(firstReveal?.selectedRealSiblingObservations, 3) &&
    firstReveal.selectedRealSiblingObservations.length ===
      firstReveal.selectedRealSiblingTileIds.length &&
    firstReveal?.selectedRealSiblingTileIds?.includes(expectedSiblingKey) &&
    firstReveal.selectedRealSiblingObservations.every((selection, index) =>
      exactSelectionObservation(
        selection,
        firstReveal.selectedRealSiblingTileIds[index],
        2,
        "RENDERED",
      ),
    );
  const warmSnapshotExact =
    exactTerrainSnapshotPartition(
      warmup?.selectedTileIds,
      warmup?.realTileIds,
      warmup?.fillTileIds,
    ) &&
    warmup.fillCount === warmup.fillTileIds.length &&
    warmup.fillTileIds.length === 0 &&
    exactS5ArrayValues(warmup.selectedTileIds, warmup.realTileIds);
  const cSnapshotExact =
    exactTerrainSnapshotPartition(
      c?.selectedTileIds,
      c?.realTileIds,
      c?.fillTileIds,
    ) &&
    exactTerrainSnapshotPartition(
      firstReveal?.selectedTileIds,
      firstReveal?.realTileIds,
      firstReveal?.fillTileIds,
    ) &&
    c.selectedCount === c.selectedTileIds.length &&
    c.realMeshCount === c.realTileIds.length &&
    c.fillCount === c.fillTileIds.length &&
    exactS5ArrayValues(c.selectedTileIds, firstReveal.selectedTileIds) &&
    exactS5ArrayValues(c.realTileIds, firstReveal.realTileIds) &&
    exactS5ArrayValues(c.fillTileIds, firstReveal.fillTileIds) &&
    exactS5ArrayValues(
      c.realSiblingTileIds,
      firstReveal.selectedRealSiblingTileIds,
    );
  if (
    !exactTarget(c?.holdTarget) ||
    !warmSnapshotExact ||
    !cSnapshotExact ||
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
    !exactSortedUniqueTileIds(warmup?.targetSelectedDescendantTileIds) ||
    warmup.targetSelectedDescendantTileIds.length !== 0 ||
    !exactSortedUniqueTileIds(warmup?.targetRealDescendantTileIds) ||
    warmup.targetRealDescendantTileIds.length !== 0 ||
    !exactSortedUniqueTileIds(warmup?.targetFillDescendantTileIds) ||
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
    !exactS5ArrayValues(
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
    firstReveal?.targetKey !== expectedHeldTarget?.key ||
    !firstRevealPredicatesExact ||
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
    firstReveal?.reservedPromiseCount !== 1 ||
    firstReveal?.releasedRequestCount !== 0 ||
    firstReveal?.rejectedRequestCount !== 0 ||
    !exactS5ArrayValues(firstReveal?.reservedKeys, [expectedHeldTarget?.key]) ||
    firstReveal?.targetHeldPromisePresent !== true ||
    firstReveal?.targetReservedPromisePresent !== true ||
    !exactSelectionObservation(
      firstReveal?.targetSelection,
      expectedHeldTarget?.key,
      2,
      "RENDERED",
    ) ||
    !exactSortedUniqueTileIds(
      firstReveal?.targetSelectedStrictDescendantTileIds,
    ) ||
    firstReveal.targetSelectedStrictDescendantTileIds.length !== 0 ||
    !exactSortedUniqueTileIds(firstReveal?.targetRealStrictDescendantTileIds) ||
    firstReveal.targetRealStrictDescendantTileIds.length !== 0 ||
    !exactSortedUniqueTileIds(firstReveal?.targetFillStrictDescendantTileIds) ||
    firstReveal.targetFillStrictDescendantTileIds.length !== 0 ||
    firstReveal?.siblingKey !== expectedSiblingKey ||
    !exactS5ArrayValues(
      firstReveal?.visibilityTargetCallOrdinals,
      revealFrameCalls.map((call) => call.ordinal),
    ) ||
    !revealSiblingExact ||
    firstReveal?.heldRequestCount !== 1 ||
    !exactS5ArrayValues(firstReveal?.heldKeys, [expectedHeldTarget?.key]) ||
    firstReveal?.loadedAndFillFlags !== true ||
    firstReveal?.targetSelected !== true ||
    firstReveal?.targetReal !== false ||
    firstReveal?.targetFill !== true ||
    !validTileMeshState(firstReveal?.targetState) ||
    !validProviderFrameFlags(firstReveal?.providerFlags) ||
    firstReveal?.providerFlags?.loadedAndFillFlags !== true ||
    firstReveal?.fillMesh?.tileId !== expectedHeldTarget?.key ||
    firstReveal?.fillMesh?.terrainFillMeshInstance !== true ||
    firstReveal?.fillMesh?.renderedMeshMatches !== true ||
    firstReveal?.fillMesh?.realMeshAbsent !== true ||
    !exactLowDetailFillMeshMeasurements(firstReveal?.fillMesh) ||
    firstReveal?.restoration?.visibilityRestored !== true ||
    firstReveal?.restoration?.orderInstrumentationRestored !== true ||
    c?.holdInterceptionEnabled !== true ||
    Math.abs(c?.cameraFovDegrees - C12_29_S5_SCENE.cameraFovDegrees) > 1e-12 ||
    c?.maximumScreenSpaceError !==
      C12_29_S5_SCENE.fillFrontierMaximumScreenSpaceError ||
    c?.preloadSiblings !== false ||
    c?.holdTargetReserved !== true ||
    c?.holdTargetRequestAttemptsAfterArm !== 1 ||
    c?.heldRequestCount !== 1 ||
    !exactS5ArrayValues(c?.heldKeys, [expectedHeldTarget?.key]) ||
    c?.fillCount !== 1 ||
    c?.loadedAndFillFlags !== true ||
    !exactSortedUniqueTileIds(c?.fillTileIds) ||
    !exactSortedUniqueTileIds(c?.selectedTileIds) ||
    !exactSortedUniqueTileIds(c?.realSiblingTileIds) ||
    !exactSortedUniqueTileIds(c?.realTileIds) ||
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
    !exactDenseS5Array(
      decodedFixtureBounds,
      C12_29_S5_PROGRESS_LEDGER_MAX_LENGTH,
    ) ||
    decodedFixtureBounds.length === 0 ||
    !decodedFixtureBounds.some((entry) =>
      c?.heldKeys?.includes(entry?.tileId),
    ) ||
    !decodedFixtureBounds.every(
      (entry, index) =>
        exactObjectKeys(entry, ["tileId", "minimumHeight", "maximumHeight"]) &&
        validS5ValidationWitnessTileId(entry.tileId) &&
        (index === 0 ||
          decodedFixtureBounds[index - 1].tileId < entry.tileId) &&
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
  const dSnapshotExact =
    exactTerrainSnapshotPartition(
      d?.selectedTileIds,
      d?.realTileIds,
      d?.fillTileIds,
    ) &&
    d.selectedCount === d.selectedTileIds.length &&
    d.realMeshCount === d.realTileIds.length &&
    d.fillCount === d.fillTileIds.length &&
    d.fillTileIds.length === 0 &&
    exactS5ArrayValues(d.selectedTileIds, d.realTileIds);
  if (
    !dSnapshotExact ||
    d?.settled !== true ||
    d?.holdTargetKey !== c?.holdTarget?.key ||
    d?.holdInterceptionEnabled !== false ||
    d?.visibilitySeamRestoredBeforeRelease !== true ||
    d?.heldRequestCountAfterRelease !== 0 ||
    !exactS5ArrayValues(d?.releasedKeys, [expectedHeldTarget?.key]) ||
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
    !exactS5ArrayValues(d?.transitionedKeys, [expectedHeldTarget?.key]) ||
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
  const eSnapshotExact =
    exactTerrainSnapshotPartition(
      e?.selectedTileIds,
      e?.realTileIds,
      e?.fillTileIds,
    ) &&
    e.selectedCount === e.selectedTileIds.length &&
    e.realMeshCount === e.realTileIds.length &&
    e.fillCount === e.fillTileIds.length &&
    e.fillTileIds.length === 0 &&
    exactS5ArrayValues(e.selectedTileIds, e.realTileIds);
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
    !eSnapshotExact ||
    e?.settled !== true ||
    e?.tilesLoaded !== true ||
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
    !exactS5ArrayValues(e?.preparedSelectedTileIds, e?.selectedTileIds)
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
        exactDenseS5Array(
          proof?.pipelineIdentityIds,
          C12_29_S5_PROGRESS_LEDGER_MAX_LENGTH,
        ) &&
        proof.pipelineIdentityIds.length > 0 &&
        new Set(proof.pipelineIdentityIds).size ===
          proof.pipelineIdentityIds.length &&
        proof.pipelineIdentityIds.every(
          (identity) =>
            typeof identity === "string" &&
            /^pipeline-[1-9]\d*$/u.test(identity),
        ) &&
        exactDenseS5Array(
          proof?.pipelineLabels,
          C12_29_S5_PROGRESS_LEDGER_MAX_LENGTH,
        ) &&
        exactSortedUniqueStrings(proof.pipelineLabels) &&
        proof.pipelineLabels.length <= proof.pipelineIdentityIds.length &&
        proof.pipelineLabels.every((label) => label.length > 0) &&
        exactDenseS5Array(
          proof?.ownerTileIds,
          C12_29_S5_PROGRESS_LEDGER_MAX_LENGTH,
        ) &&
        exactSortedUniqueTileIds(proof.ownerTileIds) &&
        proof.ownerTileIds.length > 0 &&
        Number.isInteger(proof?.frameNumber)
      );
    };
    if (
      webgpuCommandPrewarm?.applicable !== true ||
      !validCarrierState(webgpuCommandPrewarm?.off, "OFF", false) ||
      !validCarrierState(webgpuCommandPrewarm?.on, "ON", true) ||
      !exactSortedUniqueTileIds(webgpuCommandPrewarm?.expectedOwnerTileIds) ||
      !exactS5ArrayValues(
        webgpuCommandPrewarm?.expectedOwnerTileIds,
        e?.selectedTileIds,
      ) ||
      !exactS5ArrayValues(
        webgpuCommandPrewarm?.off?.ownerTileIds,
        e?.selectedTileIds,
      ) ||
      !exactS5ArrayValues(
        webgpuCommandPrewarm?.on?.ownerTileIds,
        e?.selectedTileIds,
      ) ||
      webgpuCommandPrewarm?.sameMaterializedPipelines !== true ||
      !exactS5ArrayValues(
        webgpuCommandPrewarm?.off?.pipelineIdentityIds,
        webgpuCommandPrewarm?.on?.pipelineIdentityIds,
      ) ||
      !exactS5ArrayValues(
        webgpuCommandPrewarm?.off?.pipelineLabels,
        webgpuCommandPrewarm?.on?.pipelineLabels,
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
      !exactSortedUniqueTileIds(g?.selectedTileIds) ||
      !exactSortedUniqueTileIds(g?.calledTileIds) ||
      g?.preparedBeforeFirstTile !== true ||
      g?.preparedSelectionRevision !== g?.retainedSelectionRevision ||
      !Object.is(g?.preparedSurfaceRadius, g?.retainedSurfaceRadius) ||
      !exactS5ArrayValues(g?.calledTileIds, g?.selectedTileIds)
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
      !exactDenseS5Array(
        g?.dynamicOffsetLengths,
        C12_29_S5_PROGRESS_LEDGER_MAX_LENGTH,
      ) ||
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
  if (s5ArrayPrototypeHasNumericKeys()) {
    return {
      status: "STRUCTURAL",
      exitCode: exitCodeForS5Status("STRUCTURAL"),
      structuralReasons: [
        "final report array is not canonical dense bounded data: Array.prototype",
      ],
      failureReasons: [],
      checks: {
        sourceBoundaryCount: C12_29_S5_SOURCE_FILES.length,
        buildSourceBoundaryCount: C12_29_S5_BUILD_SOURCE_FILES.length,
        rendererCount: 0,
        phaseCountPerRenderer: C12_29_S5_PHASES.length,
        captureCountPerRenderer: C12_29_S5_CAPTURE_LABELS.length,
      },
    };
  }
  const structuralReasons = [];
  const failureReasons = [];
  const invalidArrayPath = firstInvalidS5FinalArray(report);
  if (invalidArrayPath !== null) {
    structuralReasons.push(
      `final report array is not canonical dense bounded data: ${invalidArrayPath}`,
    );
    return {
      status: "STRUCTURAL",
      exitCode: exitCodeForS5Status("STRUCTURAL"),
      structuralReasons,
      failureReasons,
      checks: {
        sourceBoundaryCount: C12_29_S5_SOURCE_FILES.length,
        buildSourceBoundaryCount: C12_29_S5_BUILD_SOURCE_FILES.length,
        rendererCount: 0,
        phaseCountPerRenderer: C12_29_S5_PHASES.length,
        captureCountPerRenderer: C12_29_S5_CAPTURE_LABELS.length,
      },
    };
  }
  if (report?.schema !== C12_29_S5_SCHEMA || !isUuidV4(report?.runId)) {
    structuralReasons.push("report schema/run identity is invalid");
  }
  validateProvenance(report?.provenance, structuralReasons);
  const sessions = exactDenseS5Array(
    report?.sessions,
    C12_29_S5_RENDERERS.length,
  )
    ? report.sessions
    : [];
  if (
    sessions.length !== C12_29_S5_RENDERERS.length ||
    !exactS5ArrayValues(
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
