/**
 * Pure policy and independent numeric oracle for the C12-29 S5 custom-
 * ellipsoid runtime certification shard.
 *
 * This module is deliberately browser-free.  The probe owns acquisition;
 * this file owns the frozen contract and refuses incomplete or self-attested
 * evidence.  In particular, no production eclipse helper is imported here:
 * the f64 reference and strict stepwise-f32 twin below are independent.
 */

import { types as utilTypes } from "node:util";

export const C12_29_S5_CUSTOM_SCHEMA = "c12-29-s5-custom-ellipsoid-evidence-v7";
export const C12_29_S5_CUSTOM_DIAGNOSTICS_SCHEMA =
  "c12-29-s5-custom-ellipsoid-runtime-diagnostics-v7";

const C1229_S5_CUSTOM_V6_SCHEMA = "c12-29-s5-custom-ellipsoid-evidence-v6";
const C1229_S5_CUSTOM_V6_DIAGNOSTICS_SCHEMA =
  "c12-29-s5-custom-ellipsoid-runtime-diagnostics-v6";

export const C12_29_S5_CUSTOM_EPHEMERIS = Object.freeze({
  providerConstructor: "Simon1994EphemerisProvider",
  providerId: "cesium-simon1994-ecef",
  providerRevision: 2,
  referenceFrame: "ECEF",
  units: "metres",
  transformBranch: "SIMON1994_ICRF_TO_FIXED_IAU2006_XYS",
  maximumIndependentDeltaMeters: 1e-3,
  outputAllocationStable: true,
  thirdPartyTemporaryFree: true,
  independentMethod:
    "Simon1994PlanetaryPositions+Transforms.computeIcrfToFixedMatrix",
  provenance: Object.freeze({
    id: "cesium-simon1994-planetary-positions/current-engine-series",
    sunAndMoonSeries: "Simon1994PlanetaryPositions",
    outputFrame: "ECEF",
    outputUnits: "metres",
    eventSpecificCorrections: false,
    angularRadiusCorrections: false,
    revisionPolicy:
      "1=TEME pseudo-fixed fallback; 2=ICRF-to-fixed IAU2006 XYS branch",
    outputAllocationStable: true,
    sampleValidationTemporaryFree: true,
    sampleValidationPolicy:
      "WeakSet brand with fixed sealed output structure; no per-call descriptor/state records",
    thirdPartyTemporaryFree: true,
  }),
  timePolicy: Object.freeze({
    id: "cesium-julian-date-tai/simon1994-tdb/icrf-with-teme-fallback",
    inputTimeScale: "TAI",
    ephemerisDynamicalScale: "TDB_APPROXIMATION",
    primaryEarthRotation: "IAU2006_XYS",
    fallbackEarthRotation: "IAU1982_GMST_TEME_PSEUDO_FIXED",
  }),
});

export const C12_29_S5_CUSTOM_RENDERERS = Object.freeze(["webgl", "webgpu"]);

export const C12_29_S5_CUSTOM_PHASES = Object.freeze([
  "custom-scene-construction",
  "selected-terrain-preparation",
  "event-s5-off",
  "event-s5-on",
  "antipode-horizon-control",
  "behavioral-pick",
  "retained-capture",
  "noneclipse-identity-control",
  "session-cleanup",
]);

export const C12_29_S5_CUSTOM_AGGREGATION = "cross-backend-oracle";

export const C12_29_S5_CUSTOM_CAPTURE_LABELS = Object.freeze([
  "event-off",
  "event-on",
  "antipode-off",
  "antipode-on",
  "control-off",
  "control-on",
]);

export const C12_29_S5_CUSTOM_CAPTURE_METHOD =
  "scene.render(pinnedTime)+scene.canvas.toDataURL(image/png)+decode-same-snapshot";
export const C12_29_S5_CUSTOM_STABILITY_METHOD =
  "render-first-consecutive-fused-snapshots-v1";

export const C12_29_S5_CUSTOM_OUTPUT_DIRECTORY =
  "Tools/visual-regression/output/c12-29-s5-custom-ellipsoid";
export const C12_29_S5_CUSTOM_ARTIFACT_PREFIX =
  "campaign12-c12-29-s5-custom-ellipsoid";

export const C12_29_S5_CUSTOM_SCENE = Object.freeze({
  eventIso: "2024-04-08T18:17:16Z",
  controlIso: "2024-04-09T18:17:16Z",
  radii: Object.freeze({ x: 8_000_000, y: 8_000_000, z: 5_000_000 }),
  heightMeters: 24_000,
  terrainWidth: 17,
  terrainHeight: 17,
  terrainLevel: 0,
  verticalExaggeration: 1,
  verticalExaggerationRelativeHeight: 0,
  viewport: Object.freeze({ width: 960, height: 960 }),
  cameraHeightMeters: 12_000_000,
  cameraFovDegrees: 55,
  maximumScreenSpaceError: 2,
  minimumOffLuminance: 32 / 255,
  // The centre-sampled metric pixel owns a half-pixel square. Its exact
  // circumradius, not a fitted ROI margin, proves the footprint is interior.
  tileInteriorPixelFootprintRadius: Math.hypot(0.5, 0.5),
  minimumOracleSamplesPerClass: 3,
  minimumStableFrames: 3,
  maximumStabilityFrames: 60,
  maximumSettleFrames: 360,
  maximumPickPumpFrames: 60,
  maximumPickWarmupAttempts: 8,
  maximumRetainedCaptureFrames: 360,
});

export const C12_29_S5_CUSTOM_RADIUS_LAW = Object.freeze({
  fillSkirtAllowanceMeters: 1000,
  absoluteSafetyMeters: 2,
  relativeSafety: 8 * 2 ** -23,
});

export const C12_29_S5_CUSTOM_WEBGPU_CAMERA_INDICES = Object.freeze({
  inverseRadiiX: 51,
  inverseRadiiY: 55,
  inverseRadiiZ: 59,
  maximumRadius: 86,
});
export const C12_29_S5_CUSTOM_WEBGPU_ECLIPSE_BINDING = 2;
export const C12_29_S5_CUSTOM_ECLIPSE_FLOATS = 16;

export const C12_29_S5_CUSTOM_SOLAR_RADIUS = 695_700_000;
export const C12_29_S5_CUSTOM_LUNAR_RADIUS = 1_737_400;
export const C12_29_S5_CUSTOM_F32_SAFETY_FACTOR = 0.999996185302734375;

const operationBudget = (breakdown) =>
  Object.freeze({
    ...breakdown,
    total: Object.values(breakdown).reduce((sum, count) => sum + count, 0),
  });

// Every f64 geometry equivalence starts with maxRadius * Number.EPSILON. The
// multiplier is an explicit count of the elementary operations that can carry
// one ulp into the compared reconstruction; it is not a fitted pass band.
export const C12_29_S5_CUSTOM_GEOMETRY_EPSILON_METERS =
  C12_29_S5_CUSTOM_SCENE.radii.x * Number.EPSILON;
export const C12_29_S5_CUSTOM_GEOMETRY_OPERATION_BUDGETS = Object.freeze({
  ecefPosition: operationBudget({
    eccentricity: 4,
    trigonometry: 4,
    primeVerticalRadius: 5,
    coordinates: 10,
  }),
  axisDirection: operationBudget({
    subtraction: 3,
    squaredLength: 5,
    squareRoot: 1,
    normalization: 4,
  }),
  axisIntersectionPoint: operationBudget({
    direction: 12,
    inverseSquaredRadii: 6,
    quadraticCoefficients: 26,
    discriminantAndRoots: 13,
    pointReconstruction: 6,
    // The forward-root subtraction operates in Moon-distance coordinates
    // before reconstructing an ellipsoid-radius point. Bound that frozen
    // coordinate condition number as effective max-radius ulp operations;
    // otherwise a mathematically exact surface intersection can be rejected
    // by a few micrometres of ordinary f64 cancellation.
    conditionedForwardRoot: 4096,
  }),
  horizonIntermediate: operationBudget({
    commonRayReconstruction: 13,
    scaledUnitSphere: 6,
    dotAndCrossProducts: 24,
    quotient: 1,
  }),
});

export function c1229S5CustomGeometryTolerance(comparison, unit = "meters") {
  const budget = C12_29_S5_CUSTOM_GEOMETRY_OPERATION_BUDGETS[comparison];
  if (!budget || (unit !== "meters" && unit !== "dimensionless")) {
    return undefined;
  }
  const base =
    unit === "meters"
      ? C12_29_S5_CUSTOM_GEOMETRY_EPSILON_METERS
      : Number.EPSILON;
  return base * budget.total;
}

/**
 * Exact semantic source boundary. Raw shaders coexist with generated modules;
 * only JavaScript/TypeScript production entries participate in source-map
 * identity. Tool files are pinned as local provenance instead.
 */
export const C12_29_S5_CUSTOM_SOURCE_FILES = Object.freeze([
  "packages/engine/Source/Core/Ellipsoid.js",
  "packages/engine/Source/Core/GeographicProjection.js",
  "packages/engine/Source/Core/GeographicTilingScheme.js",
  "packages/engine/Source/Core/CustomHeightmapTerrainProvider.js",
  "packages/engine/Source/Core/HeightmapTerrainData.js",
  "packages/engine/Source/Core/CelestialEphemerisProvider.js",
  "packages/engine/Source/Core/Simon1994EphemerisProvider.js",
  "packages/engine/Source/Core/Simon1994PlanetaryPositions.js",
  "packages/engine/Source/Core/Transforms.js",
  "packages/engine/Source/Core/Iau2006XysData.js",
  "packages/engine/Source/Renderer/AutomaticUniforms.js",
  "packages/engine/Source/Renderer/UniformStateComputations.js",
  "packages/engine/Source/Renderer/FeatureRendererKey.js",
  "packages/engine/Source/Renderer/GraphicsContext.ts",
  "packages/engine/Source/Renderer/PickId.js",
  "packages/engine/Source/Renderer/WebGPU/WebGPUContext.ts",
  "packages/engine/Source/Renderer/WebGPU/WebGPUFeatureRenderers.ts",
  "packages/engine/Source/Renderer/WebGPU/WebGPUGlobeSurfaceCameraUB.ts",
  "packages/engine/Source/Renderer/WebGPU/WebGPUGlobeSurfaceLayouts.ts",
  "packages/engine/Source/Renderer/WebGPU/WebGPUGlobeSurfaceTypes.ts",
  "packages/engine/Source/Renderer/WebGPU/WebGPUGlobeSurfaceRenderer.ts",
  "packages/engine/Source/Renderer/WebGPU/WebGPUGlobeEclipseUniforms.ts",
  "packages/engine/Source/Renderer/WebGPU/WebGPUDynamicEnvironmentMapManager.ts",
  "packages/engine/Source/Renderer/WebGPU/WebGPUDynamicEnvironmentMapCapture.ts",
  "packages/engine/Source/Scene/GridImageryProvider.js",
  "packages/engine/Source/Scene/Globe.js",
  "packages/engine/Source/Scene/GlobeSurfaceTile.js",
  "packages/engine/Source/Scene/GlobeSurfaceTileProvider.js",
  "packages/engine/Source/Scene/GlobeSurfaceTileProviderRendering.js",
  "packages/engine/Source/Scene/QuadtreePrimitive.js",
  "packages/engine/Source/Scene/TileSelectionResult.js",
  "packages/engine/Source/Scene/Picking.js",
  "packages/engine/Source/Scene/PickFramebuffer.js",
  "packages/engine/Source/Scene/SceneTransforms.js",
  "packages/engine/Source/Scene/Model/Model.js",
  "packages/engine/Source/Scene/EclipseGlobeShadow.js",
  "packages/engine/Source/Scene/EclipseState.js",
  "packages/engine/Source/Scene/Moon.js",
  "packages/engine/Source/Scene/Scene.js",
  "packages/engine/Source/Scene/View.js",
  "packages/engine/Source/Scene/FrameState.js",
  "packages/engine/Source/Scene/DynamicEnvironmentMapManager.js",
  "packages/engine/Source/Shaders/GlobeFS.glsl",
  "packages/engine/Source/Shaders/GlobeFS.js",
  "packages/engine/Source/Shaders/WebGPU/Globe/GlobeTerrain.wgsl",
  "packages/engine/Source/Shaders/WebGPU/Globe/GlobeTerrain.js",
  "packages/engine/Source/Widget/CesiumWidget.js",
  "packages/widgets/Source/Viewer/Viewer.js",
  "Tools/visual-regression/lib/same-task-capture.mjs",
  "Tools/visual-regression/lib/build-source-identity.mjs",
  "Tools/visual-regression/lib/c12-29-s5-custom-ellipsoid-gate.mjs",
  "Tools/visual-regression/c12-29-s5-custom-ellipsoid-gate.spec.mjs",
  "Tools/visual-regression/probe-c12-29-s5-custom-ellipsoid.mjs",
  "Tools/visual-regression/c12-29-s5-custom-ellipsoid-harness.html",
]);

const C1229_S5_CUSTOM_V6_SOURCE_FILES = Object.freeze(
  C12_29_S5_CUSTOM_SOURCE_FILES.filter(
    (file) =>
      file !==
      "Tools/visual-regression/c12-29-s5-custom-ellipsoid-harness.html",
  ),
);

export const C12_29_S5_CUSTOM_BUILD_SOURCE_FILES = Object.freeze(
  C12_29_S5_CUSTOM_SOURCE_FILES.filter(
    (file) =>
      !file.startsWith("Tools/") &&
      !file.endsWith(".glsl") &&
      !file.endsWith(".wgsl"),
  ),
);

export const C12_29_S5_CUSTOM_LOCAL_FILES = Object.freeze(
  C12_29_S5_CUSTOM_SOURCE_FILES,
);

export const C12_29_S5_CUSTOM_BUILD_SOURCE_MAP =
  "Build/CesiumUnminified/index.js.map";

const FINAL_STATUSES = new Set(["PASS", "FAIL", "STRUCTURAL", "ERROR"]);
const SHA256 = /^[0-9a-f]{64}$/u;
const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const WEBGL_AUTOMATIC_UNIFORMS_IDENTITY_KEYS = Object.freeze([
  "exportName",
  "servedBundleExport",
  "bundleExportIdentity",
  "radiiUniformIdentity",
  "inverseRadiiUniformIdentity",
  "radii",
  "inverseRadii",
  "radiiExact",
  "inverseRadiiExact",
  "radiiSource",
  "inverseRadiiSource",
]);
const WEBGL_AUTOMATIC_UNIFORMS_RADII_SOURCE =
  "C.AutomaticUniforms.czm_ellipsoidRadii.getValue(scene.context.uniformState)";
const WEBGL_AUTOMATIC_UNIFORMS_INVERSE_RADII_SOURCE =
  "C.AutomaticUniforms.czm_ellipsoidInverseRadii.getValue(scene.context.uniformState)";

function finite(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function exactKeys(value, keys) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}

/**
 * Validate the fail-closed ownership handoff used by the custom-ellipsoid
 * browser shard. CesiumWidget deliberately leaves `scene.moon` absent for
 * this non-default scene topology; the probe must install the served Moon
 * constructor itself and then leave that resource under Scene ownership.
 */
export function validateC1229S5CustomMoonTopology(topology) {
  return (
    exactKeys(topology, [
      "widgetDefaultAbsent",
      "explicitlyConstructed",
      "servedConstructorIdentity",
      "sceneIdentity",
      "lifecycleOwner",
      "updateIsFunction",
      "destroyIsFunction",
    ]) &&
    topology.widgetDefaultAbsent === true &&
    topology.explicitlyConstructed === true &&
    topology.servedConstructorIdentity === true &&
    topology.sceneIdentity === true &&
    topology.lifecycleOwner === "scene.moon" &&
    topology.updateIsFunction === true &&
    topology.destroyIsFunction === true
  );
}

function exactOwnPropertyDescriptor(left, right) {
  if (left === undefined || right === undefined) {
    return left === right;
  }
  if (
    left.configurable !== right.configurable ||
    left.enumerable !== right.enumerable
  ) {
    return false;
  }
  const leftIsData = Object.hasOwn(left, "value");
  const rightIsData = Object.hasOwn(right, "value");
  if (leftIsData !== rightIsData) {
    return false;
  }
  return leftIsData
    ? left.writable === right.writable && Object.is(left.value, right.value)
    : Object.is(left.get, right.get) && Object.is(left.set, right.set);
}

function frozenOwnPropertyDescriptor(descriptor) {
  return descriptor === undefined
    ? undefined
    : Object.freeze({ ...descriptor });
}

function descriptorShape(descriptor) {
  if (descriptor === undefined) {
    return Object.freeze({
      kind: "absent",
      writable: false,
      enumerable: false,
      configurable: false,
    });
  }
  const data = Object.hasOwn(descriptor, "value");
  return Object.freeze({
    kind: data ? "data" : "accessor",
    writable: data && descriptor.writable === true,
    enumerable: descriptor.enumerable === true,
    configurable: descriptor.configurable === true,
  });
}

function capturePropertyAuthorityState(target, key) {
  const ownDescriptor = Object.getOwnPropertyDescriptor(target, key);
  const hadOwn = Object.hasOwn(target, key);
  if (hadOwn !== (ownDescriptor !== undefined)) {
    throw new TypeError("descriptor ownership raced during capture");
  }
  const prototypeChain = [];
  const visited = new Set([target]);
  let authority = target;
  for (let depth = 1; ; depth++) {
    authority = Object.getPrototypeOf(authority);
    if (authority === null) break;
    if (depth > 64 || visited.has(authority)) {
      throw new TypeError("descriptor prototype chain is cyclic or unbounded");
    }
    if (utilTypes.isProxy(authority)) {
      throw new TypeError("instrumentation prototype must not be a Proxy");
    }
    visited.add(authority);
    const descriptor = Object.getOwnPropertyDescriptor(authority, key);
    const owns = Object.hasOwn(authority, key);
    if (owns !== (descriptor !== undefined)) {
      throw new TypeError(
        "prototype descriptor ownership raced during capture",
      );
    }
    prototypeChain.push(
      Object.freeze({
        authority,
        descriptor: frozenOwnPropertyDescriptor(descriptor),
      }),
    );
  }
  const prototypeOwnerIndex = prototypeChain.findIndex(
    (entry) => entry.descriptor !== undefined,
  );
  const ownerDepth = hadOwn
    ? 0
    : prototypeOwnerIndex < 0
      ? -1
      : prototypeOwnerIndex + 1;
  const ownerDescriptor =
    ownerDepth === 0
      ? ownDescriptor
      : ownerDepth > 0
        ? prototypeChain[ownerDepth - 1].descriptor
        : undefined;
  return Object.freeze({
    hadOwn,
    ownDescriptor: frozenOwnPropertyDescriptor(ownDescriptor),
    prototypeChain: Object.freeze(prototypeChain),
    ownerDepth,
    ownerDescriptor: frozenOwnPropertyDescriptor(ownerDescriptor),
  });
}

function exactPropertyAuthorityState(left, right) {
  return (
    left.hadOwn === right.hadOwn &&
    exactOwnPropertyDescriptor(left.ownDescriptor, right.ownDescriptor) &&
    left.ownerDepth === right.ownerDepth &&
    exactOwnPropertyDescriptor(left.ownerDescriptor, right.ownerDescriptor) &&
    left.prototypeChain.length === right.prototypeChain.length &&
    left.prototypeChain.every(
      (entry, index) =>
        entry.authority === right.prototypeChain[index].authority &&
        exactOwnPropertyDescriptor(
          entry.descriptor,
          right.prototypeChain[index].descriptor,
        ),
    )
  );
}

/**
 * Capture the exact own-property shape plus the currently resolved value.
 * The target/key binding prevents a receipt from being replayed elsewhere.
 */
export function captureC1229S5CustomPropertyDescriptor(target, key) {
  if (
    (typeof target !== "object" || target === null) &&
    typeof target !== "function"
  ) {
    throw new TypeError("descriptor target must be an object");
  }
  if (utilTypes.isProxy(target)) {
    throw new TypeError("instrumentation target must not be a Proxy");
  }
  const authorityBefore = capturePropertyAuthorityState(target, key);
  if (
    authorityBefore.ownerDescriptor === undefined ||
    !Object.hasOwn(authorityBefore.ownerDescriptor, "value")
  ) {
    throw new TypeError("instrumentation property must resolve through data");
  }
  const resolvedValue = Reflect.get(target, key);
  const authority = capturePropertyAuthorityState(target, key);
  if (!exactPropertyAuthorityState(authorityBefore, authority)) {
    throw new TypeError("descriptor authority drifted during resolved read");
  }
  return Object.freeze({
    target,
    key,
    authority,
    resolvedValue,
  });
}

/** Restore an instrumentation seam without leaving an inherited method own. */
export function restoreC1229S5CustomPropertyDescriptor(target, key, receipt) {
  if (receipt?.target !== target || receipt?.key !== key) {
    throw new TypeError("descriptor receipt target/key mismatch");
  }
  if (receipt.authority.hadOwn) {
    Object.defineProperty(target, key, receipt.authority.ownDescriptor);
  } else if (!Reflect.deleteProperty(target, key)) {
    throw new TypeError("inherited instrumentation override is not deletable");
  }
  // Resolve before the final descriptor snapshots. A hostile getter may
  // mutate the target or prototype authority; the snapshots below then catch
  // that drift without invoking the property again.
  const authorityBeforeResolvedRead = capturePropertyAuthorityState(
    target,
    key,
  );
  const preResolvedAuthorityExact = exactPropertyAuthorityState(
    authorityBeforeResolvedRead,
    receipt.authority,
  );
  const resolvedValueAfter = preResolvedAuthorityExact
    ? Reflect.get(target, key)
    : undefined;
  const authorityAfter = capturePropertyAuthorityState(target, key);
  const ownershipExact = authorityAfter.hadOwn === receipt.authority.hadOwn;
  const ownDescriptorExact = exactOwnPropertyDescriptor(
    authorityAfter.ownDescriptor,
    receipt.authority.ownDescriptor,
  );
  const targetPrototypeExact =
    authorityAfter.prototypeChain[0]?.authority ===
    receipt.authority.prototypeChain[0]?.authority;
  const prototypeChainExact =
    authorityAfter.prototypeChain.length ===
      receipt.authority.prototypeChain.length &&
    authorityAfter.prototypeChain.every(
      (entry, index) =>
        entry.authority === receipt.authority.prototypeChain[index].authority &&
        exactOwnPropertyDescriptor(
          entry.descriptor,
          receipt.authority.prototypeChain[index].descriptor,
        ),
    );
  const ownerDescriptorExact =
    authorityAfter.ownerDepth === receipt.authority.ownerDepth &&
    exactOwnPropertyDescriptor(
      authorityAfter.ownerDescriptor,
      receipt.authority.ownerDescriptor,
    );
  const authorityExact = exactPropertyAuthorityState(
    authorityAfter,
    receipt.authority,
  );
  const resolvedIdentityExact =
    preResolvedAuthorityExact &&
    Object.is(resolvedValueAfter, receipt.resolvedValue);
  return Object.freeze({
    hadOwnBefore: receipt.authority.hadOwn,
    hasOwnAfter: authorityAfter.hadOwn,
    ownerDepthBefore: receipt.authority.ownerDepth,
    ownerDepthAfter: authorityAfter.ownerDepth,
    ownerDescriptorBefore: descriptorShape(receipt.authority.ownerDescriptor),
    ownerDescriptorAfter: descriptorShape(authorityAfter.ownerDescriptor),
    preResolvedAuthorityExact,
    ownershipExact,
    ownDescriptorExact,
    targetPrototypeExact,
    prototypeChainExact,
    ownerDescriptorExact,
    resolvedIdentityExact,
    restored:
      preResolvedAuthorityExact && authorityExact && resolvedIdentityExact,
  });
}

function exactPlainKeys(value, keys) {
  return (
    exactKeys(value, keys) &&
    Object.getPrototypeOf(value) === Object.prototype &&
    Object.getOwnPropertySymbols(value).length === 0 &&
    keys.every((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return (
        descriptor?.enumerable === true && Object.hasOwn(descriptor, "value")
      );
    })
  );
}

function exactDenseStringArray(value, maximumLength) {
  if (
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    value.length > maximumLength ||
    Object.getOwnPropertySymbols(value).length !== 0
  ) {
    return false;
  }
  const keys = Reflect.ownKeys(value);
  if (keys.length !== value.length + 1 || keys[keys.length - 1] !== "length") {
    return false;
  }
  for (let index = 0; index < value.length; index++) {
    if (keys[index] !== String(index)) return false;
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (
      descriptor?.enumerable !== true ||
      !Object.hasOwn(descriptor, "value") ||
      typeof descriptor.value !== "string" ||
      descriptor.value.length === 0 ||
      descriptor.value.length > 128
    ) {
      return false;
    }
  }
  return true;
}

function validCustomErrorDiagnosticsForSchema(diagnostics, schema) {
  if (
    !exactPlainKeys(diagnostics, [
      "schema",
      "renderer",
      "stage",
      "timeoutMs",
      "page",
    ]) ||
    diagnostics.schema !== schema ||
    !C12_29_S5_CUSTOM_RENDERERS.includes(diagnostics.renderer) ||
    !Number.isInteger(diagnostics.timeoutMs) ||
    !new Set([240_000, 540_000]).has(diagnostics.timeoutMs)
  ) {
    return false;
  }
  if (diagnostics.page === null) {
    return new Set(["node", "node-session", "watchdog"]).has(diagnostics.stage);
  }
  const page = diagnostics.page;
  if (
    !exactPlainKeys(page, [
      "schema",
      "renderer",
      "currentPhase",
      "completedPhases",
      "step",
      "elapsedMs",
    ]) ||
    page.schema !== schema ||
    page.renderer !== diagnostics.renderer ||
    diagnostics.stage !== page.currentPhase ||
    !new Set(["preflight", ...C12_29_S5_CUSTOM_PHASES]).has(
      page.currentPhase,
    ) ||
    typeof page.step !== "string" ||
    page.step.length === 0 ||
    page.step.length > 128 ||
    !finite(page.elapsedMs) ||
    page.elapsedMs < 0 ||
    page.elapsedMs > diagnostics.timeoutMs + 30_000 ||
    !exactDenseStringArray(page.completedPhases, C12_29_S5_CUSTOM_PHASES.length)
  ) {
    return false;
  }
  if (
    !page.completedPhases.every(
      (phase, index) => phase === C12_29_S5_CUSTOM_PHASES[index],
    )
  ) {
    return false;
  }
  if (page.currentPhase === "preflight") {
    return page.completedPhases.length === 0 && page.step === "start";
  }
  const phaseIndex = C12_29_S5_CUSTOM_PHASES.indexOf(page.currentPhase);
  return (
    page.completedPhases.length ===
    phaseIndex + (page.step === "complete" ? 1 : 0)
  );
}

function validCustomErrorDiagnostics(diagnostics) {
  return validCustomErrorDiagnosticsForSchema(
    diagnostics,
    C12_29_S5_CUSTOM_DIAGNOSTICS_SCHEMA,
  );
}

function sameOrdered(left, right) {
  return (
    Array.isArray(left) &&
    left.length === right.length &&
    left.every((entry, index) => entry === right[index])
  );
}

function fingerprint(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    value.exists === true &&
    Number.isInteger(value.byteLength) &&
    value.byteLength > 0 &&
    SHA256.test(value.sha256)
  );
}

function normalizeIdentityPath(value) {
  return typeof value === "string" ? value.replaceAll("\\", "/") : undefined;
}

function hasIdentitySuffix(value, suffix) {
  const normalized = normalizeIdentityPath(value);
  return normalized === suffix || normalized?.endsWith(`/${suffix}`) === true;
}

function validBuildSourceIdentity(value) {
  if (
    value?.ok !== true ||
    !Array.isArray(value?.entries) ||
    value.entries.length !== C12_29_S5_CUSTOM_BUILD_SOURCE_FILES.length ||
    !Array.isArray(value?.reasons) ||
    value.reasons.length !== 0 ||
    !Number.isInteger(value?.sourceMapByteLength) ||
    value.sourceMapByteLength <= 0 ||
    !SHA256.test(value?.sourceMapSha256 ?? "")
  ) {
    return false;
  }
  return C12_29_S5_CUSTOM_BUILD_SOURCE_FILES.every((file, index) => {
    const entry = value.entries[index];
    return (
      hasIdentitySuffix(entry?.file, file) &&
      entry.exact === true &&
      entry.reason === null &&
      Number.isInteger(entry.currentByteLength) &&
      entry.currentByteLength > 0 &&
      entry.embeddedByteLength === entry.currentByteLength &&
      SHA256.test(entry.currentSha256 ?? "") &&
      entry.embeddedSha256 === entry.currentSha256 &&
      normalizeIdentityPath(entry.sourceMapEntry) === `../../${file}`
    );
  });
}

function vec3(value) {
  return (
    exactKeys(value, ["x", "y", "z"]) &&
    finite(value.x) &&
    finite(value.y) &&
    finite(value.z)
  );
}

function vec4(value) {
  return (
    exactKeys(value, ["x", "y", "z", "w"]) &&
    finite(value.x) &&
    finite(value.y) &&
    finite(value.z) &&
    finite(value.w)
  );
}

function exactNumber(left, right) {
  // JSON has one representation for both signed zeros. All evidence numbers
  // are finite, so strict equality preserves every serializable numeric bit
  // distinction while allowing a retained `0` to reproduce a runtime `-0`.
  return typeof left === "number" && finite(left) && left === right;
}

function finiteOrNull(value) {
  return value === null || finite(value);
}

function exactVec3(left, right) {
  return (
    vec3(left) &&
    vec3(right) &&
    exactNumber(left.x, right.x) &&
    exactNumber(left.y, right.y) &&
    exactNumber(left.z, right.z)
  );
}

function exactNumericArray(left, right) {
  return (
    Array.isArray(left) &&
    Array.isArray(right) &&
    left.length === right.length &&
    left.every((value, index) => exactNumber(value, right[index]))
  );
}

function validRgba(value) {
  return (
    Array.isArray(value) &&
    value.length === 4 &&
    value.every(
      (channel) => Number.isInteger(channel) && channel >= 0 && channel <= 255,
    ) &&
    value[3] === 255
  );
}

function rgbaLuminance(value) {
  return (0.2126 * value[0] + 0.7152 * value[1] + 0.0722 * value[2]) / 255;
}

/**
 * Stable identity for one measured pixel. The identity is deliberately
 * derived from acquisition-primary coordinates instead of a caller-supplied
 * ordinal, so independently acquired backend samples cannot be joined by an
 * arbitrary matching label.
 */
export function deriveC1229S5CustomSampleId({ cartographic, pixel, tileId }) {
  if (
    !exactKeys(cartographic, ["longitude", "latitude", "height"]) ||
    !finite(cartographic.longitude) ||
    !finite(cartographic.latitude) ||
    !finite(cartographic.height) ||
    !exactKeys(pixel, ["x", "y"]) ||
    !Number.isInteger(pixel.x) ||
    !Number.isInteger(pixel.y) ||
    typeof tileId !== "string" ||
    !/^\d+\/\d+\/\d+$/u.test(tileId)
  ) {
    return undefined;
  }
  return `${tileId}@${pixel.x},${pixel.y}@${cartographic.longitude.toExponential(16)},${cartographic.latitude.toExponential(16)},${cartographic.height.toExponential(16)}`;
}

function deriveGeographicTileCoordinates(cartographic, tileId) {
  const match = /^(\d+)\/(\d+)\/(\d+)$/u.exec(tileId ?? "");
  if (!match || !exactKeys(cartographic, ["longitude", "latitude", "height"])) {
    return undefined;
  }
  const level = Number(match[1]);
  const x = Number(match[2]);
  const y = Number(match[3]);
  if (
    !Number.isSafeInteger(level) ||
    level < 0 ||
    level > 30 ||
    !Number.isSafeInteger(x) ||
    !Number.isSafeInteger(y) ||
    !finite(cartographic.longitude) ||
    !finite(cartographic.latitude)
  ) {
    return undefined;
  }
  const scale = 2 ** level;
  const tilesX = 2 * scale;
  const tilesY = scale;
  if (x < 0 || x >= tilesX || y < 0 || y >= tilesY) return undefined;
  if (`${level}/${x}/${y}` !== tileId) return undefined;
  const tileWidth = (2 * Math.PI) / tilesX;
  const tileHeight = Math.PI / tilesY;
  const expectedX = Math.min(
    tilesX - 1,
    Math.floor((cartographic.longitude + Math.PI) / tileWidth),
  );
  const expectedY = Math.min(
    tilesY - 1,
    Math.floor((Math.PI / 2 - cartographic.latitude) / tileHeight),
  );
  if (expectedX !== x || expectedY !== y) return undefined;
  const west = -Math.PI + x * tileWidth;
  const south = Math.PI / 2 - (y + 1) * tileHeight;
  return {
    tileUv: [
      (cartographic.longitude - west) / tileWidth,
      (cartographic.latitude - south) / tileHeight,
    ],
  };
}

function exactPreparedTuple(value) {
  return (
    exactKeys(value, [
      "prepared",
      "selectionRevision",
      "surfaceRadius",
      "selectedTileIds",
    ]) &&
    value.prepared === true &&
    Number.isInteger(value.selectionRevision) &&
    finite(value.surfaceRadius) &&
    value.surfaceRadius > 0 &&
    Array.isArray(value.selectedTileIds) &&
    value.selectedTileIds.length > 0 &&
    value.selectedTileIds.every(
      (id) => typeof id === "string" && /^\d+\/\d+\/\d+$/u.test(id),
    ) &&
    new Set(value.selectedTileIds).size === value.selectedTileIds.length &&
    sameOrdered(value.selectedTileIds, [...value.selectedTileIds].sort())
  );
}

function samePreparedTuple(left, right) {
  return (
    exactPreparedTuple(left) &&
    exactPreparedTuple(right) &&
    left.prepared === right.prepared &&
    left.selectionRevision === right.selectionRevision &&
    Object.is(left.surfaceRadius, right.surfaceRadius) &&
    sameOrdered(left.selectedTileIds, right.selectedTileIds)
  );
}

function samePreparedContent(left, right) {
  return (
    exactPreparedTuple(left) &&
    exactPreparedTuple(right) &&
    left.prepared === right.prepared &&
    Object.is(left.surfaceRadius, right.surfaceRadius) &&
    sameOrdered(left.selectedTileIds, right.selectedTileIds)
  );
}

function exactFreshUnpreparedTuple(value) {
  return (
    exactKeys(value, [
      "prepared",
      "selectionRevision",
      "surfaceRadius",
      "selectedTileIds",
    ]) &&
    value.prepared === false &&
    value.selectionRevision === null &&
    value.surfaceRadius === null &&
    Array.isArray(value.selectedTileIds) &&
    value.selectedTileIds.length > 0 &&
    value.selectedTileIds.every(
      (id) => typeof id === "string" && /^\d+\/\d+\/\d+$/u.test(id),
    ) &&
    new Set(value.selectedTileIds).size === value.selectedTileIds.length &&
    sameOrdered(value.selectedTileIds, [...value.selectedTileIds].sort())
  );
}

export function isC1229S5CustomUuidV4(value) {
  return typeof value === "string" && UUID_V4.test(value);
}

export function exitCodeForC1229S5CustomStatus(status) {
  if (status === "PASS") return 0;
  if (status === "FAIL") return 1;
  if (status === "STRUCTURAL" || status === "ERROR") return 2;
  throw new RangeError(`unknown custom-ellipsoid status ${String(status)}`);
}

function cloneC1229S5CustomJsonSafe(
  value,
  location = "$",
  ancestors = new Set(),
  state = { nodes: 0 },
) {
  state.nodes++;
  if (state.nodes > 1_000_000) {
    throw new TypeError("custom-ellipsoid JSON-safe value exceeds node cap");
  }
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError(
        `custom-ellipsoid JSON-safe value rejects a lossy number at ${location}`,
      );
    }
    // Camera/vector math can legitimately produce signed zero. JSON has no
    // signed-zero representation, so normalize it deliberately before the
    // first fold rather than letting JSON.stringify change it implicitly.
    return Object.is(value, -0) ? 0 : value;
  }
  if (!value || typeof value !== "object") {
    throw new TypeError(
      `custom-ellipsoid JSON-safe value rejects ${typeof value} at ${location}`,
    );
  }
  try {
    if (ancestors.has(value)) {
      throw new TypeError(
        `custom-ellipsoid JSON-safe value rejects a cycle at ${location}`,
      );
    }
    if (utilTypes.isProxy(value)) {
      throw new TypeError(
        `custom-ellipsoid JSON-safe value rejects a Proxy at ${location}`,
      );
    }
    const array = Array.isArray(value);
    const prototype = Object.getPrototypeOf(value);
    if (
      (array && prototype !== Array.prototype) ||
      (!array && prototype !== Object.prototype && prototype !== null)
    ) {
      throw new TypeError(
        `custom-ellipsoid JSON-safe value rejects a custom prototype at ${location}`,
      );
    }
    const keys = Reflect.ownKeys(value);
    if (keys.some((key) => typeof key !== "string")) {
      throw new TypeError(
        `custom-ellipsoid JSON-safe value rejects a symbol key at ${location}`,
      );
    }
    ancestors.add(value);
    if (array) {
      const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
      if (
        lengthDescriptor === undefined ||
        !Object.hasOwn(lengthDescriptor, "value") ||
        lengthDescriptor.value !== value.length ||
        !Number.isInteger(lengthDescriptor.value) ||
        lengthDescriptor.value < 0 ||
        lengthDescriptor.value > 1_000_000 ||
        lengthDescriptor.enumerable !== false ||
        lengthDescriptor.configurable !== false ||
        keys.length !== lengthDescriptor.value + 1 ||
        keys.at(-1) !== "length"
      ) {
        throw new TypeError(
          `custom-ellipsoid JSON-safe value rejects a noncanonical array at ${location}`,
        );
      }
      const clone = [];
      for (let index = 0; index < lengthDescriptor.value; index++) {
        const key = String(index);
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (
          keys[index] !== key ||
          descriptor === undefined ||
          !Object.hasOwn(descriptor, "value") ||
          descriptor.enumerable !== true
        ) {
          throw new TypeError(
            `custom-ellipsoid JSON-safe value rejects holes, accessors, or hidden keys at ${location}[${index}]`,
          );
        }
        clone.push(
          cloneC1229S5CustomJsonSafe(
            descriptor.value,
            `${location}[${index}]`,
            ancestors,
            state,
          ),
        );
      }
      ancestors.delete(value);
      return clone;
    }
    const clone = {};
    for (const key of [...keys].sort()) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (
        descriptor === undefined ||
        !Object.hasOwn(descriptor, "value") ||
        descriptor.enumerable !== true
      ) {
        throw new TypeError(
          `custom-ellipsoid JSON-safe value rejects accessors or hidden keys at ${location}.${key}`,
        );
      }
      clone[key] = cloneC1229S5CustomJsonSafe(
        descriptor.value,
        `${location}.${key}`,
        ancestors,
        state,
      );
    }
    ancestors.delete(value);
    return clone;
  } catch (error) {
    ancestors.delete(value);
    if (
      error instanceof TypeError &&
      /^custom-ellipsoid JSON-safe/u.test(error.message)
    ) {
      throw error;
    }
    throw new TypeError(
      `custom-ellipsoid JSON-safe value is not inspectable at ${location}`,
      { cause: error },
    );
  }
}

export function stableC1229S5CustomJson(value, space) {
  const normalized = cloneC1229S5CustomJsonSafe(value);
  const json = JSON.stringify(normalized, null, space);
  if (typeof json !== "string") {
    throw new TypeError("custom-ellipsoid JSON-safe root is not serializable");
  }
  return `${json}\n`;
}

export function computeC1229S5CustomSurfaceRadius({
  maximumRadius,
  minimumHeight,
  maximumHeight,
}) {
  if (
    !finite(maximumRadius) ||
    maximumRadius <= 0 ||
    !finite(minimumHeight) ||
    !finite(maximumHeight)
  ) {
    return undefined;
  }
  const unprotectedRadius =
    maximumRadius +
    Math.max(
      Math.abs(
        minimumHeight - C12_29_S5_CUSTOM_RADIUS_LAW.fillSkirtAllowanceMeters,
      ),
      Math.abs(maximumHeight),
    );
  const safety = Math.max(
    C12_29_S5_CUSTOM_RADIUS_LAW.absoluteSafetyMeters,
    unprotectedRadius * C12_29_S5_CUSTOM_RADIUS_LAW.relativeSafety,
  );
  return { unprotectedRadius, safety, radius: unprotectedRadius + safety };
}

const add = (a, b) => a + b;
const sub = (a, b) => a - b;
const mul = (a, b) => a * b;
const div = (a, b) => a / b;
const sqrt = Math.sqrt;
const inverseSqrt = (value) => 1 / Math.sqrt(value);
const sin = Math.sin;
const cos = Math.cos;
const asin = Math.asin;
const acos = Math.acos;
const atan2 = Math.atan2;
const pow = Math.pow;

const F = Math.fround;
const fadd = (a, b) => F(F(a) + F(b));
const fsub = (a, b) => F(F(a) - F(b));
const fmul = (a, b) => F(F(a) * F(b));
const fdiv = (a, b) => F(F(a) / F(b));
const fsqrt = (a) => F(Math.sqrt(F(a)));
const finverseSqrt = (a) => F(1 / Math.sqrt(F(a)));
const fsin = (a) => F(Math.sin(F(a)));
const fcos = (a) => F(Math.cos(F(a)));
const fasin = (a) => F(Math.asin(F(a)));
const facos = (a) => F(Math.acos(F(a)));
const fatan2 = (a, b) => F(Math.atan2(F(a), F(b)));
const fpow = (a, b) => F(Math.pow(F(a), F(b)));

function operations(mode) {
  return mode === "f32"
    ? {
        round: F,
        add: fadd,
        sub: fsub,
        mul: fmul,
        div: fdiv,
        sqrt: fsqrt,
        inverseSqrt: finverseSqrt,
        sin: fsin,
        cos: fcos,
        asin: fasin,
        acos: facos,
        atan2: fatan2,
        pow: fpow,
      }
    : {
        round: (value) => value,
        add,
        sub,
        mul,
        div,
        sqrt,
        inverseSqrt,
        sin,
        cos,
        asin,
        acos,
        atan2,
        pow,
      };
}

function clamp(value, minimum, maximum, op) {
  return op.round(Math.min(Math.max(value, minimum), maximum));
}

function dot3(left, right, op) {
  return op.add(
    op.add(op.mul(left.x, right.x), op.mul(left.y, right.y)),
    op.mul(left.z, right.z),
  );
}

function cross3(left, right, op) {
  return {
    x: op.sub(op.mul(left.y, right.z), op.mul(left.z, right.y)),
    y: op.sub(op.mul(left.z, right.x), op.mul(left.x, right.z)),
    z: op.sub(op.mul(left.x, right.y), op.mul(left.y, right.x)),
  };
}

function add3(left, right, op) {
  return {
    x: op.add(left.x, right.x),
    y: op.add(left.y, right.y),
    z: op.add(left.z, right.z),
  };
}

function sub3(left, right, op) {
  return {
    x: op.sub(left.x, right.x),
    y: op.sub(left.y, right.y),
    z: op.sub(left.z, right.z),
  };
}

function scale3(value, scalar, op) {
  return {
    x: op.mul(value.x, scalar),
    y: op.mul(value.y, scalar),
    z: op.mul(value.z, scalar),
  };
}

function length3(value, op) {
  return op.sqrt(dot3(value, value, op));
}

function normalize3(value, op) {
  const magnitude = length3(value, op);
  if (!(magnitude > 0)) return undefined;
  return scale3(value, op.div(1, magnitude), op);
}

/** Independent oblate geodetic -> fixed-frame ECEF conversion. */
export function customEllipsoidGeodeticToEcef(
  { longitude, latitude, height },
  mode = "f64",
) {
  const op = operations(mode);
  const a = op.round(C12_29_S5_CUSTOM_SCENE.radii.x);
  const b = op.round(C12_29_S5_CUSTOM_SCENE.radii.z);
  const lon = op.round(longitude);
  const lat = op.round(latitude);
  const h = op.round(height);
  if (![lon, lat, h].every(finite)) return undefined;
  const a2 = op.mul(a, a);
  const b2 = op.mul(b, b);
  const e2 = op.sub(1, op.div(b2, a2));
  const sinLat = op.sin(lat);
  const cosLat = op.cos(lat);
  const sinLon = op.sin(lon);
  const cosLon = op.cos(lon);
  const n = op.div(a, op.sqrt(op.sub(1, op.mul(e2, op.mul(sinLat, sinLat)))));
  return {
    x: op.mul(op.mul(op.add(n, h), cosLat), cosLon),
    y: op.mul(op.mul(op.add(n, h), cosLat), sinLon),
    z: op.mul(op.add(op.mul(n, op.sub(1, e2)), h), sinLat),
  };
}

function distance3(left, right) {
  return Math.hypot(left.x - right.x, left.y - right.y, left.z - right.z);
}

/** Independent f64 Moon-to-anti-Sun axis/custom-ellipsoid intersection. */
export function deriveC1229S5CustomAxisIntersection({ sun, moon }) {
  if (!vec3(sun) || !vec3(moon)) return undefined;
  const direction = normalize3(
    sub3(moon, sun, operations("f64")),
    operations("f64"),
  );
  if (!direction) return undefined;
  const radii = C12_29_S5_CUSTOM_SCENE.radii;
  const inverseSquared = {
    x: 1 / (radii.x * radii.x),
    y: 1 / (radii.y * radii.y),
    z: 1 / (radii.z * radii.z),
  };
  const a =
    direction.x * direction.x * inverseSquared.x +
    direction.y * direction.y * inverseSquared.y +
    direction.z * direction.z * inverseSquared.z;
  const b =
    2 *
    (moon.x * direction.x * inverseSquared.x +
      moon.y * direction.y * inverseSquared.y +
      moon.z * direction.z * inverseSquared.z);
  const c =
    moon.x * moon.x * inverseSquared.x +
    moon.y * moon.y * inverseSquared.y +
    moon.z * moon.z * inverseSquared.z -
    1;
  const discriminant = b * b - 4 * a * c;
  if (!(discriminant >= 0)) return undefined;
  const root = Math.sqrt(discriminant);
  const roots = [(-b - root) / (2 * a), (-b + root) / (2 * a)]
    .filter((value) => value > 0)
    .sort((left, right) => left - right);
  if (roots.length === 0) return undefined;
  const forwardRoot = roots[0];
  return {
    direction,
    forwardRoot,
    point: add3(
      moon,
      scale3(direction, forwardRoot, operations("f64")),
      operations("f64"),
    ),
  };
}

/** Build the camera-independent common-ray payload without engine helpers. */
export function packC1229S5CustomCommonRay(
  { sun, moon, params, params2 },
  mode = "f64",
) {
  if (!vec3(sun) || !vec3(moon) || !vec4(params) || !vec4(params2)) {
    return undefined;
  }
  if (mode !== "f64" && mode !== "f32") return undefined;
  // The CPU builds this common block in f64 and the backend then stores each
  // scalar in a Float32Array.  Recomputing its normalization in f32 would be a
  // different algorithm, so the packed oracle is exactly fround(f64 payload).
  const op = operations("f64");
  const sunRange = length3(sun, op);
  const moonRange = length3(moon, op);
  if (!(sunRange > 0) || !(moonRange > 0)) return undefined;
  const sunDirection = scale3(sun, op.div(1, sunRange), op);
  const moonDirection = scale3(moon, op.div(1, moonRange), op);
  const delta = sub3(moonDirection, sunDirection, op);
  const result = [
    sunDirection.x,
    sunDirection.y,
    sunDirection.z,
    op.div(1, sunRange),
    delta.x,
    delta.y,
    delta.z,
    op.div(1, moonRange),
    params.x,
    params.y,
    params.z,
    params.w,
    params2.x,
    params2.y,
    params2.z,
    params2.w,
  ];
  return mode === "f32" ? new Float32Array(result) : result;
}

function geometricObscuration(rs, ro, distance, op) {
  if (distance >= op.add(rs, ro)) return op.round(0);
  if (op.add(distance, rs) <= ro) return op.round(1);
  if (op.add(distance, ro) <= rs) {
    const ratio = op.div(ro, rs);
    return op.mul(ratio, ratio);
  }
  const d2 = op.mul(distance, distance);
  const rs2 = op.mul(rs, rs);
  const ro2 = op.mul(ro, ro);
  const alpha = op.acos(
    clamp(
      op.div(op.sub(op.add(d2, rs2), ro2), op.mul(op.mul(2, distance), rs)),
      -1,
      1,
      op,
    ),
  );
  const beta = op.acos(
    clamp(
      op.div(op.sub(op.add(d2, ro2), rs2), op.mul(op.mul(2, distance), ro)),
      -1,
      1,
      op,
    ),
  );
  const first = op.add(op.add(op.sub(0, distance), rs), ro);
  const second = op.sub(op.add(distance, rs), ro);
  const third = op.add(op.sub(distance, rs), ro);
  const fourth = op.add(op.add(distance, rs), ro);
  const product = op.mul(op.mul(op.mul(first, second), third), fourth);
  const lens = op.sub(
    op.add(op.mul(rs2, alpha), op.mul(ro2, beta)),
    op.mul(0.5, op.sqrt(Math.max(product, 0))),
  );
  return clamp(op.div(lens, op.mul(op.round(Math.PI), rs2)), 0, 1, op);
}

function limbDarken(amount, payload, op) {
  const polynomial = op.add(
    op.add(payload[10], op.mul(payload[11], amount)),
    op.mul(op.mul(payload[15], amount), amount),
  );
  return op.add(amount, op.mul(op.mul(amount, op.sub(1, amount)), polynomial));
}

/**
 * Independent twin of the fragment law. `payload` must be the f64 or packed
 * f32 common-ray array from `packC1229S5CustomCommonRay`.
 */
export function evaluateC1229S5CustomFragment(
  { position, inverseRadii, payload },
  mode = "f64",
) {
  const op = operations(mode);
  if (
    !vec3(position) ||
    !vec3(inverseRadii) ||
    !Array.from(payload ?? []).every(finite)
  ) {
    return undefined;
  }
  if (payload.length !== C12_29_S5_CUSTOM_ECLIPSE_FLOATS) return undefined;
  const p = {
    x: op.round(position.x),
    y: op.round(position.y),
    z: op.round(position.z),
  };
  const inv = {
    x: op.round(inverseRadii.x),
    y: op.round(inverseRadii.y),
    z: op.round(inverseRadii.z),
  };
  const sunInvRange = op.round(payload[3]);
  const moonInvRange = op.round(payload[7]);
  if (!(sunInvRange > 0) || !(moonInvRange > 0)) {
    return { factor: 1, horizonRejected: false, supportRejected: true };
  }
  const sunDirection = { x: payload[0], y: payload[1], z: payload[2] };
  const directionDelta = { x: payload[4], y: payload[5], z: payload[6] };
  const s = sub3(sunDirection, scale3(p, sunInvRange, op), op);
  const invRangeDelta = op.sub(sunInvRange, moonInvRange);
  const delta = add3(directionDelta, scale3(p, invRangeDelta, op), op);
  const s2 = dot3(s, s, op);
  const sDotD = dot3(s, delta, op);
  const moon2 = op.round(
    Math.max(
      op.add(op.add(s2, op.mul(2, sDotD)), dot3(delta, delta, op)),
      op.round(1e-30),
    ),
  );
  if (!(s2 > 0)) {
    return { factor: 1, horizonRejected: false, supportRejected: true };
  }
  const dotSunMoon = op.add(s2, sDotD);
  const sunScale = op.mul(C12_29_S5_CUSTOM_SOLAR_RADIUS, sunInvRange);
  const moonScale = op.mul(C12_29_S5_CUSTOM_LUNAR_RADIUS, moonInvRange);
  const supportDot = op.add(dotSunMoon, op.mul(sunScale, moonScale));
  const supportRadicand = op.mul(
    op.round(Math.max(op.sub(s2, op.mul(sunScale, sunScale)), 0)),
    op.round(Math.max(op.sub(moon2, op.mul(moonScale, moonScale)), 0)),
  );
  if (
    supportDot <= 0 ||
    op.mul(supportDot, supportDot) <=
      op.mul(C12_29_S5_CUSTOM_F32_SAFETY_FACTOR, supportRadicand)
  ) {
    return { factor: 1, horizonRejected: false, supportRejected: true };
  }
  const ellipsoidPosition = {
    x: op.mul(p.x, inv.x),
    y: op.mul(p.y, inv.y),
    z: op.mul(p.z, inv.z),
  };
  const ellipsoidSunRay = {
    x: op.mul(s.x, inv.x),
    y: op.mul(s.y, inv.y),
    z: op.mul(s.z, inv.z),
  };
  const rayLength2 = dot3(ellipsoidSunRay, ellipsoidSunRay, op);
  const positionDotRay = dot3(ellipsoidPosition, ellipsoidSunRay, op);
  if (!(rayLength2 > 0)) {
    return { factor: 1, horizonRejected: true, supportRejected: false };
  }
  let closestRadiusSquared;
  if (positionDotRay < 0) {
    const limb = cross3(ellipsoidPosition, ellipsoidSunRay, op);
    closestRadiusSquared = op.div(dot3(limb, limb, op), rayLength2);
    if (closestRadiusSquared < op.round(C12_29_S5_CUSTOM_F32_SAFETY_FACTOR)) {
      return {
        factor: 1,
        horizonRejected: true,
        supportRejected: false,
        closestRadiusSquared,
      };
    }
  }
  const inverseSunDistance = op.inverseSqrt(s2);
  const inverseMoonDistance = op.inverseSqrt(moon2);
  const rs = op.asin(clamp(op.mul(sunScale, inverseSunDistance), 0, 1, op));
  const ro = op.asin(clamp(op.mul(moonScale, inverseMoonDistance), 0, 1, op));
  const separation = op.atan2(length3(cross3(s, delta, op), op), dotSunMoon);
  const geometric = geometricObscuration(rs, ro, separation, op);
  if (!(geometric > 0)) {
    return {
      factor: 1,
      horizonRejected: false,
      supportRejected: false,
      closestRadiusSquared,
    };
  }
  let obscuration;
  if (geometric >= 1) {
    obscuration = op.round(1);
  } else {
    const antumbraInner = op.sub(rs, ro);
    const fitted = limbDarken(geometric, payload, op);
    if (antumbraInner > 0 && separation <= antumbraInner) {
      const t = op.div(separation, antumbraInner);
      obscuration = clamp(
        op.add(fitted, op.mul(payload[14], op.sub(1, op.mul(t, t)))),
        0,
        1,
        op,
      );
    } else {
      obscuration = clamp(fitted, 0, 1, op);
    }
  }
  const visible = op.sub(1, obscuration);
  const flux = op.add(visible, op.mul(payload[12], op.sub(1, visible)));
  return {
    factor: op.pow(flux, payload[13]),
    horizonRejected: false,
    supportRejected: false,
    geometric,
    rs,
    ro,
    separation,
    closestRadiusSquared,
  };
}

export function deriveC1229S5CustomOracleSample(input) {
  const position64 = customEllipsoidGeodeticToEcef(input.cartographic, "f64");
  const position32 = customEllipsoidGeodeticToEcef(input.cartographic, "f32");
  const payload64 = packC1229S5CustomCommonRay(input, "f64");
  const payload32 = packC1229S5CustomCommonRay(input, "f32");
  if (!position64 || !position32 || !payload64 || !payload32) return undefined;
  const inverse64 = {
    x: 1 / C12_29_S5_CUSTOM_SCENE.radii.x,
    y: 1 / C12_29_S5_CUSTOM_SCENE.radii.y,
    z: 1 / C12_29_S5_CUSTOM_SCENE.radii.z,
  };
  const inverse32 = {
    x: F(inverse64.x),
    y: F(inverse64.y),
    z: F(inverse64.z),
  };
  const f64 = evaluateC1229S5CustomFragment(
    { position: position64, inverseRadii: inverse64, payload: payload64 },
    "f64",
  );
  const f32 = evaluateC1229S5CustomFragment(
    { position: position32, inverseRadii: inverse32, payload: payload32 },
    "f32",
  );
  if (!f64 || !f32) return undefined;
  let geometryIdentity;
  if (vec3(input.runtimePosition)) {
    const runtimeF64 = evaluateC1229S5CustomFragment(
      {
        position: input.runtimePosition,
        inverseRadii: inverse64,
        payload: payload64,
      },
      "f64",
    );
    const ecefDifferenceMeters = distance3(input.runtimePosition, position64);
    const ecefToleranceMeters = c1229S5CustomGeometryTolerance(
      "ecefPosition",
      "meters",
    );
    const independentClosest = f64.closestRadiusSquared;
    const runtimeClosest = runtimeF64?.closestRadiusSquared;
    const hasHorizonIntermediate =
      finite(independentClosest) && finite(runtimeClosest);
    const horizonDifference = hasHorizonIntermediate
      ? Math.abs(runtimeClosest - independentClosest)
      : null;
    const horizonTolerance = c1229S5CustomGeometryTolerance(
      "horizonIntermediate",
      "dimensionless",
    );
    geometryIdentity = {
      ecefDifferenceMeters,
      ecefToleranceMeters,
      ecefWithinTolerance: ecefDifferenceMeters <= ecefToleranceMeters,
      horizonCompared: hasHorizonIntermediate,
      horizonDifference,
      horizonTolerance,
      horizonWithinTolerance:
        !hasHorizonIntermediate || horizonDifference <= horizonTolerance,
    };
    geometryIdentity.withinTolerance =
      geometryIdentity.ecefWithinTolerance &&
      geometryIdentity.horizonWithinTolerance;
  }
  const classify = (result) => {
    if (result.horizonRejected) return "horizon";
    if (!(result.geometric > 0)) return "clear";
    if (result.geometric >= 1) return "umbra";
    return "penumbra";
  };
  const classificationF64 = classify(f64);
  const classificationF32 = classify(f32);
  const offLuminance = input.offLuminance;
  const onLuminance = input.onLuminance;
  if (!finite(offLuminance) || !finite(onLuminance)) return undefined;
  const denominator = Math.max(
    offLuminance - 1 / 255,
    C12_29_S5_CUSTOM_SCENE.minimumOffLuminance,
  );
  const f32Error = Math.abs(f32.factor - f64.factor);
  const quantizationBound = (1 + f64.factor) / (255 * denominator);
  const tolerance = 4 * f32Error + quantizationBound;
  const observedFactor = onLuminance / offLuminance;
  return {
    f64: f64.factor,
    f32: f32.factor,
    f32Error,
    quantizationBound,
    tolerance,
    observedFactor,
    absoluteError: Math.abs(observedFactor - f64.factor),
    withinTolerance: Math.abs(observedFactor - f64.factor) <= tolerance,
    horizonRejectedF64: f64.horizonRejected,
    horizonRejectedF32: f32.horizonRejected,
    classificationF64,
    classificationF32,
    boundaryAmbiguous: classificationF64 !== classificationF32,
    geometricF64: f64.geometric ?? 0,
    geometricF32: f32.geometric ?? 0,
    packedF32: Array.from(payload32),
    positionF64: position64,
    positionF32: position32,
    geometryIdentity,
  };
}

export function deriveC1229S5CustomCrossBackend(left, right) {
  if (!left || !right) return undefined;
  const maximumF32Error = Math.max(left.f32Error, right.f32Error);
  const quantizationBound = left.quantizationBound + right.quantizationBound;
  const tolerance = 4 * maximumF32Error + quantizationBound;
  const absoluteDifference = Math.abs(
    left.observedFactor - right.observedFactor,
  );
  return {
    maximumF32Error,
    quantizationBound,
    tolerance,
    absoluteDifference,
    withinTolerance: absoluteDifference <= tolerance,
  };
}

function finiteArray(value, length) {
  return (
    Array.isArray(value) &&
    value.length === length &&
    value.every((entry) => finite(entry))
  );
}

function exactDeep(left, right) {
  if (
    left === null ||
    right === null ||
    typeof left !== "object" ||
    typeof right !== "object"
  ) {
    return typeof left === "number" ? exactNumber(left, right) : left === right;
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((entry, index) => exactDeep(entry, right[index]))
    );
  }
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return (
    sameOrdered(leftKeys, rightKeys) &&
    leftKeys.every((key) => exactDeep(left[key], right[key]))
  );
}

function normalizedMatrix3Vector(matrix, vector) {
  if (
    !Array.isArray(matrix) ||
    matrix.length !== 9 ||
    matrix.some((value) => !finite(value)) ||
    !vec3(vector)
  ) {
    return undefined;
  }
  const rotated = matrix3MultiplyByVector(matrix, vector);
  const magnitude = Math.sqrt(
    rotated.x * rotated.x + rotated.y * rotated.y + rotated.z * rotated.z,
  );
  if (!(magnitude > 0) || !finite(magnitude)) return undefined;
  return {
    x: rotated.x / magnitude,
    y: rotated.y / magnitude,
    z: rotated.z / magnitude,
  };
}

export function validateC1229S5CustomEphemerisLineage(
  lineage,
  expectedFrameNumber,
  expectedIso,
) {
  const provider = lineage?.provider;
  const sample = lineage?.sample;
  const independent = lineage?.independent;
  const eclipse = lineage?.eclipseState;
  const consumers = lineage?.consumers;
  const identities = lineage?.identities;
  if (
    !exactKeys(lineage, [
      "frameNumber",
      "clockIso",
      "provider",
      "sample",
      "independent",
      "eclipseState",
      "consumers",
      "identities",
    ]) ||
    lineage.frameNumber !== expectedFrameNumber ||
    lineage.clockIso !== expectedIso ||
    !exactKeys(provider, [
      "constructor",
      "id",
      "revision",
      "provenance",
      "timePolicy",
      "provenanceFrozen",
      "timePolicyFrozen",
    ]) ||
    provider.constructor !== C12_29_S5_CUSTOM_EPHEMERIS.providerConstructor ||
    provider.id !== C12_29_S5_CUSTOM_EPHEMERIS.providerId ||
    provider.revision !== C12_29_S5_CUSTOM_EPHEMERIS.providerRevision ||
    !exactDeep(provider.provenance, C12_29_S5_CUSTOM_EPHEMERIS.provenance) ||
    !exactDeep(provider.timePolicy, C12_29_S5_CUSTOM_EPHEMERIS.timePolicy) ||
    provider.provenanceFrozen !== true ||
    provider.timePolicyFrozen !== true ||
    !exactKeys(sample, [
      "providerId",
      "providerRevision",
      "provenance",
      "timePolicy",
      "referenceFrame",
      "units",
      "transformBranch",
      "outputAllocationStable",
      "thirdPartyTemporaryFree",
      "sunPositionWC",
      "moonPositionWC",
    ]) ||
    sample.providerId !== C12_29_S5_CUSTOM_EPHEMERIS.providerId ||
    sample.providerRevision !== C12_29_S5_CUSTOM_EPHEMERIS.providerRevision ||
    !exactDeep(sample.provenance, C12_29_S5_CUSTOM_EPHEMERIS.provenance) ||
    !exactDeep(sample.timePolicy, C12_29_S5_CUSTOM_EPHEMERIS.timePolicy) ||
    sample.referenceFrame !== C12_29_S5_CUSTOM_EPHEMERIS.referenceFrame ||
    sample.units !== C12_29_S5_CUSTOM_EPHEMERIS.units ||
    sample.transformBranch !== C12_29_S5_CUSTOM_EPHEMERIS.transformBranch ||
    sample.outputAllocationStable !== true ||
    sample.thirdPartyTemporaryFree !== true ||
    !vec3(sample.sunPositionWC) ||
    !vec3(sample.moonPositionWC) ||
    !exactKeys(independent, [
      "method",
      "sunPositionWC",
      "moonPositionWC",
      "sunDeltaMeters",
      "moonDeltaMeters",
    ]) ||
    independent.method !== C12_29_S5_CUSTOM_EPHEMERIS.independentMethod ||
    !vec3(independent.sunPositionWC) ||
    !vec3(independent.moonPositionWC) ||
    !exactKeys(eclipse, [
      "sunPositionWC",
      "moonPositionWC",
      "sunDeltaMeters",
      "moonDeltaMeters",
      "sunStorageDistinct",
      "moonStorageDistinct",
    ]) ||
    !vec3(eclipse.sunPositionWC) ||
    !vec3(eclipse.moonPositionWC) ||
    !exactKeys(consumers, [
      "uniformSunPositionWC",
      "uniformSunStorageDistinct",
      "viewRotation3D",
      "moonDirectionEC",
      "moonDirectionStorageDistinct",
      "moonModelTranslation",
      "moonModelStorageDistinct",
    ]) ||
    !vec3(consumers.uniformSunPositionWC) ||
    !Array.isArray(consumers.viewRotation3D) ||
    consumers.viewRotation3D.length !== 9 ||
    consumers.viewRotation3D.some((value) => !finite(value)) ||
    !vec3(consumers.moonDirectionEC) ||
    !vec3(consumers.moonModelTranslation) ||
    !exactKeys(identities, [
      "providerIsSceneProvider",
      "sampleIsFrameStateSample",
      "sampleProvenanceIsProviderProvenance",
      "sampleTimePolicyIsProviderTimePolicy",
    ]) ||
    Object.values(identities).some((value) => value !== true) ||
    consumers.uniformSunStorageDistinct !== true ||
    consumers.moonDirectionStorageDistinct !== true ||
    consumers.moonModelStorageDistinct !== true ||
    eclipse.sunStorageDistinct !== true ||
    eclipse.moonStorageDistinct !== true
  ) {
    return false;
  }
  const sunDelta = distance3(independent.sunPositionWC, sample.sunPositionWC);
  const moonDelta = distance3(
    independent.moonPositionWC,
    sample.moonPositionWC,
  );
  const eclipseSunDelta = distance3(
    eclipse.sunPositionWC,
    sample.sunPositionWC,
  );
  const eclipseMoonDelta = distance3(
    eclipse.moonPositionWC,
    sample.moonPositionWC,
  );
  const expectedMoonDirection = normalizedMatrix3Vector(
    consumers.viewRotation3D,
    sample.moonPositionWC,
  );
  return (
    exactNumber(independent.sunDeltaMeters, sunDelta) &&
    exactNumber(independent.moonDeltaMeters, moonDelta) &&
    sunDelta <= C12_29_S5_CUSTOM_EPHEMERIS.maximumIndependentDeltaMeters &&
    moonDelta <= C12_29_S5_CUSTOM_EPHEMERIS.maximumIndependentDeltaMeters &&
    exactVec3(eclipse.sunPositionWC, sample.sunPositionWC) &&
    exactVec3(eclipse.moonPositionWC, sample.moonPositionWC) &&
    exactNumber(eclipse.sunDeltaMeters, eclipseSunDelta) &&
    exactNumber(eclipse.moonDeltaMeters, eclipseMoonDelta) &&
    eclipseSunDelta === 0 &&
    eclipseMoonDelta === 0 &&
    exactVec3(consumers.uniformSunPositionWC, sample.sunPositionWC) &&
    exactVec3(consumers.moonModelTranslation, sample.moonPositionWC) &&
    exactVec3(consumers.moonDirectionEC, expectedMoonDirection)
  );
}

function array3Distance(left, right) {
  return Math.hypot(left[0] - right[0], left[1] - right[1], left[2] - right[2]);
}

function normalizeArray3(value) {
  const magnitude = Math.hypot(value[0], value[1], value[2]);
  return value.map((entry) => entry / magnitude);
}

function crossArray3(left, right) {
  return [
    left[1] * right[2] - left[2] * right[1],
    left[2] * right[0] - left[0] * right[2],
    left[0] * right[1] - left[1] * right[0],
  ];
}

function cameraMatchesTarget(state) {
  const target = state.cameraTarget;
  const expectedPosition = customEllipsoidGeodeticToEcef(
    {
      longitude: target.longitude,
      latitude: target.latitude,
      height: C12_29_S5_CUSTOM_SCENE.cameraHeightMeters,
    },
    "f64",
  );
  if (!expectedPosition) return false;
  const position = [expectedPosition.x, expectedPosition.y, expectedPosition.z];
  const direction = normalizeArray3(position.map((value) => -value));
  const north = [
    -Math.sin(target.latitude) * Math.cos(target.longitude),
    -Math.sin(target.latitude) * Math.sin(target.longitude),
    Math.cos(target.latitude),
  ];
  const right = normalizeArray3(crossArray3(direction, north));
  const up = normalizeArray3(crossArray3(right, direction));
  const positionTolerance =
    c1229S5CustomGeometryTolerance("ecefPosition", "meters") *
    ((C12_29_S5_CUSTOM_SCENE.radii.x +
      C12_29_S5_CUSTOM_SCENE.cameraHeightMeters) /
      C12_29_S5_CUSTOM_SCENE.radii.x);
  const orientationTolerance = c1229S5CustomGeometryTolerance(
    "horizonIntermediate",
    "dimensionless",
  );
  return (
    array3Distance(state.camera.positionWC, position) <= positionTolerance &&
    array3Distance(state.camera.directionWC, direction) <=
      orientationTolerance &&
    array3Distance(state.camera.rightWC, right) <= orientationTolerance &&
    array3Distance(state.camera.upWC, up) <= orientationTolerance &&
    exactNumber(
      state.camera.frustum.fov,
      (C12_29_S5_CUSTOM_SCENE.cameraFovDegrees * Math.PI) / 180,
    ) &&
    exactNumber(
      state.camera.frustum.aspectRatio,
      C12_29_S5_CUSTOM_SCENE.viewport.width /
        C12_29_S5_CUSTOM_SCENE.viewport.height,
    )
  );
}

function validMainPipelineProof(proof, content, frameNumber, renderer) {
  if (renderer === "webgl") {
    return (
      exactKeys(proof, ["applicability"]) && proof.applicability === "N/A-WebGL"
    );
  }
  const draws = proof?.draws;
  const expectedCamera = {
    inverseRadiiX: Math.fround(1 / C12_29_S5_CUSTOM_SCENE.radii.x),
    inverseRadiiY: Math.fround(1 / C12_29_S5_CUSTOM_SCENE.radii.y),
    inverseRadiiZ: Math.fround(1 / C12_29_S5_CUSTOM_SCENE.radii.z),
    maximumRadius: Math.fround(C12_29_S5_CUSTOM_SCENE.radii.x),
  };
  const drawsValid =
    Array.isArray(draws) &&
    draws.length === content?.length &&
    draws.every(
      (draw, index) =>
        exactKeys(draw, [
          "tileId",
          "meshIdentity",
          "descriptorCount",
          "positiveDrawCount",
          "pipelinesReady",
          "cameraUbo",
        ]) &&
        draw.tileId === content[index]?.tileId &&
        draw.meshIdentity === content[index]?.meshIdentity &&
        Number.isInteger(draw.descriptorCount) &&
        draw.descriptorCount > 0 &&
        Number.isInteger(draw.positiveDrawCount) &&
        draw.positiveDrawCount > 0 &&
        draw.positiveDrawCount <= draw.descriptorCount &&
        draw.pipelinesReady === true &&
        exactKeys(draw.cameraUbo, Object.keys(expectedCamera)) &&
        Object.keys(expectedCamera).every((key) =>
          Object.is(draw.cameraUbo[key], expectedCamera[key]),
        ),
    );
  return (
    exactKeys(proof, [
      "applicability",
      "method",
      "frameNumber",
      "draws",
      "currentFramePositiveDraw",
      "cameraUboExact",
      "cohortExact",
    ]) &&
    proof.applicability === "required" &&
    proof.method === "globeRenderer.createTileCommands" &&
    proof.frameNumber === frameNumber &&
    drawsValid &&
    proof.currentFramePositiveDraw === drawsValid &&
    proof.cameraUboExact === drawsValid &&
    proof.cohortExact === drawsValid
  );
}

function validTemporalFrameState(state, renderer, legacyV6 = false) {
  const camera = state?.camera;
  const provider = state?.provider;
  const eclipse = state?.eclipse;
  const content = state?.content;
  const blockShapeValid =
    eclipse?.blockPresent === true
      ? Number.isInteger(eclipse.revision) &&
        eclipse.revision >= 0 &&
        vec4(eclipse.sunDirectionAndInvRange) &&
        vec4(eclipse.moonDirectionDeltaAndInvRange) &&
        vec4(eclipse.params) &&
        vec4(eclipse.params2)
      : eclipse?.revision === null &&
        eclipse?.sunDirectionAndInvRange === null &&
        eclipse?.moonDirectionDeltaAndInvRange === null &&
        eclipse?.params === null &&
        eclipse?.params2 === null;
  return (
    exactKeys(state, [
      "clockIso",
      "cameraTarget",
      "camera",
      "provider",
      "preparedTuple",
      "content",
      ...(legacyV6 ? [] : ["mainPipeline"]),
      "eclipse",
      "ephemeris",
    ]) &&
    typeof state.clockIso === "string" &&
    exactKeys(state.cameraTarget, ["longitude", "latitude", "height"]) &&
    finite(state.cameraTarget.longitude) &&
    finite(state.cameraTarget.latitude) &&
    state.cameraTarget.height === C12_29_S5_CUSTOM_SCENE.heightMeters &&
    exactKeys(camera, [
      "positionWC",
      "directionWC",
      "upWC",
      "rightWC",
      "viewMatrix",
      "projectionMatrix",
      "frustum",
    ]) &&
    finiteArray(camera.positionWC, 3) &&
    finiteArray(camera.directionWC, 3) &&
    finiteArray(camera.upWC, 3) &&
    finiteArray(camera.rightWC, 3) &&
    finiteArray(camera.viewMatrix, 16) &&
    finiteArray(camera.projectionMatrix, 16) &&
    exactKeys(camera.frustum, ["fov", "aspectRatio", "near", "far"]) &&
    finite(camera.frustum.fov) &&
    camera.frustum.fov > 0 &&
    finite(camera.frustum.aspectRatio) &&
    camera.frustum.aspectRatio > 0 &&
    finite(camera.frustum.near) &&
    camera.frustum.near > 0 &&
    finite(camera.frustum.far) &&
    camera.frustum.far > camera.frustum.near &&
    cameraMatchesTarget(state) &&
    exactKeys(provider, [
      "constructor",
      "objectIdentity",
      "tilingSchemeIdentity",
      "width",
      "height",
      "constantHeight",
      "requestCount",
    ]) &&
    provider.constructor === "CustomHeightmapTerrainProvider" &&
    provider.objectIdentity === true &&
    provider.tilingSchemeIdentity === true &&
    provider.width === C12_29_S5_CUSTOM_SCENE.terrainWidth &&
    provider.height === C12_29_S5_CUSTOM_SCENE.terrainHeight &&
    provider.constantHeight === C12_29_S5_CUSTOM_SCENE.heightMeters &&
    Number.isInteger(provider.requestCount) &&
    provider.requestCount > 0 &&
    exactPreparedTuple(state.preparedTuple) &&
    Array.isArray(content) &&
    content.length === state.preparedTuple.selectedTileIds.length &&
    sameOrdered(
      content.map((entry) => entry?.tileId),
      state.preparedTuple.selectedTileIds,
    ) &&
    content.every(
      (entry) =>
        exactKeys(entry, ["tileId", "meshIdentity", "renderedMesh"]) &&
        /^mesh-\d+$/u.test(entry.meshIdentity ?? "") &&
        entry.renderedMesh === true,
    ) &&
    new Set(content.map((entry) => entry.meshIdentity)).size ===
      content.length &&
    (legacyV6 ||
      validMainPipelineProof(
        state.mainPipeline,
        content,
        state.ephemeris?.frameNumber,
        renderer,
      )) &&
    exactKeys(eclipse, [
      "lightingEnabled",
      "blockPresent",
      "active",
      "revision",
      "sunDirectionAndInvRange",
      "moonDirectionDeltaAndInvRange",
      "params",
      "params2",
    ]) &&
    typeof eclipse.lightingEnabled === "boolean" &&
    typeof eclipse.blockPresent === "boolean" &&
    typeof eclipse.active === "boolean" &&
    blockShapeValid &&
    eclipse.active ===
      (eclipse.blockPresent === true && (eclipse.params?.x ?? 0) > 0.5) &&
    validateC1229S5CustomEphemerisLineage(
      state.ephemeris,
      state.ephemeris?.frameNumber,
      state.clockIso,
    )
  );
}

function temporalExpectation(label, phases, legacyV6 = false) {
  const event = phases?.["event-s5-on"];
  const antipode = phases?.["antipode-horizon-control"];
  const control = phases?.["noneclipse-identity-control"];
  const eventTarget = {
    longitude: event?.eventCentre?.longitude,
    latitude: event?.eventCentre?.latitude,
    height: C12_29_S5_CUSTOM_SCENE.heightMeters,
  };
  const antipodeTarget = {
    longitude: antipode?.centre?.longitude,
    latitude: antipode?.centre?.latitude,
    height: C12_29_S5_CUSTOM_SCENE.heightMeters,
  };
  const values = {
    "event-off": {
      clockIso: C12_29_S5_CUSTOM_SCENE.eventIso,
      target: eventTarget,
      preparedTuple: phases?.["event-s5-off"]?.preparedTuple,
      lightingEnabled: false,
      active: false,
    },
    "event-on": {
      clockIso: C12_29_S5_CUSTOM_SCENE.eventIso,
      target: eventTarget,
      preparedTuple: event?.preparedTuple,
      lightingEnabled: true,
      active: true,
    },
    "antipode-off": {
      clockIso: C12_29_S5_CUSTOM_SCENE.eventIso,
      target: antipodeTarget,
      preparedTuple: antipode?.offPreparedTuple,
      lightingEnabled: false,
      active: false,
    },
    "antipode-on": {
      clockIso: C12_29_S5_CUSTOM_SCENE.eventIso,
      target: antipodeTarget,
      preparedTuple: antipode?.onPreparedTuple,
      lightingEnabled: true,
      active: legacyV6 ? false : null,
    },
    "control-off": {
      clockIso: C12_29_S5_CUSTOM_SCENE.controlIso,
      target: eventTarget,
      preparedTuple: control?.offPreparedTuple,
      lightingEnabled: false,
      active: false,
    },
    "control-on": {
      clockIso: C12_29_S5_CUSTOM_SCENE.controlIso,
      target: eventTarget,
      preparedTuple: control?.onPreparedTuple,
      lightingEnabled: true,
      active: false,
    },
  };
  return values[label];
}

function validTemporalStability(image, phases, renderer, legacyV6 = false) {
  const stability = image?.temporalStability;
  const observations = stability?.observations;
  const expectation = temporalExpectation(image?.label, phases, legacyV6);
  if (
    !exactKeys(stability, [
      "method",
      "requiredConsecutiveFrames",
      "maximumFrames",
      "attemptedFrames",
      "observations",
      "captureFrameNumber",
      "captureState",
      "captureOutput",
      "renderFirst",
      "sameTaskFusedCapture",
    ]) ||
    stability.method !== C12_29_S5_CUSTOM_STABILITY_METHOD ||
    stability.requiredConsecutiveFrames !==
      C12_29_S5_CUSTOM_SCENE.minimumStableFrames ||
    stability.maximumFrames !== C12_29_S5_CUSTOM_SCENE.maximumStabilityFrames ||
    !Number.isInteger(stability.attemptedFrames) ||
    stability.attemptedFrames <
      C12_29_S5_CUSTOM_SCENE.minimumStableFrames + 1 ||
    stability.attemptedFrames > C12_29_S5_CUSTOM_SCENE.maximumStabilityFrames ||
    !Array.isArray(observations) ||
    observations.length !== C12_29_S5_CUSTOM_SCENE.minimumStableFrames ||
    stability.renderFirst !== true ||
    stability.sameTaskFusedCapture !== true ||
    !validTemporalFrameState(stability.captureState, renderer, legacyV6) ||
    !exactKeys(stability.captureOutput, [
      "byteLength",
      "sha256",
      "width",
      "height",
    ])
  ) {
    return false;
  }
  const observationShapeValid = observations.every(
    (observation) =>
      exactKeys(observation, [
        "ordinal",
        "frameNumber",
        "byteLength",
        "sha256",
        "width",
        "height",
        "state",
      ]) &&
      Number.isInteger(observation.ordinal) &&
      observation.ordinal > 0 &&
      Number.isInteger(observation.frameNumber) &&
      observation.frameNumber > 0 &&
      Number.isInteger(observation.byteLength) &&
      observation.byteLength > 0 &&
      SHA256.test(observation.sha256 ?? "") &&
      observation.width === C12_29_S5_CUSTOM_SCENE.viewport.width &&
      observation.height === C12_29_S5_CUSTOM_SCENE.viewport.height &&
      validTemporalFrameState(observation.state, renderer, legacyV6),
  );
  if (!observationShapeValid || !expectation) return false;
  const reference = observations[0];
  const ordinalConsecutive = observations.every(
    (observation, index) => observation.ordinal === reference.ordinal + index,
  );
  const frameConsecutive = observations.every(
    (observation, index) =>
      observation.frameNumber === reference.frameNumber + index,
  );
  const revisionConsecutive = [
    ...observations.map((observation) => observation.state),
    stability.captureState,
  ].every(
    (state, index) =>
      state.preparedTuple.selectionRevision ===
      reference.state.preparedTuple.selectionRevision + index,
  );
  const sameStableState = (left, right) =>
    samePreparedContent(left.preparedTuple, right.preparedTuple) &&
    exactDeep(
      {
        ...left,
        preparedTuple: { ...left.preparedTuple, selectionRevision: 0 },
        ephemeris: { ...left.ephemeris, frameNumber: 0 },
        ...(legacyV6
          ? {}
          : {
              mainPipeline:
                left.mainPipeline?.applicability === "required"
                  ? { ...left.mainPipeline, frameNumber: 0 }
                  : left.mainPipeline,
            }),
      },
      {
        ...right,
        preparedTuple: { ...right.preparedTuple, selectionRevision: 0 },
        ephemeris: { ...right.ephemeris, frameNumber: 0 },
        ...(legacyV6
          ? {}
          : {
              mainPipeline:
                right.mainPipeline?.applicability === "required"
                  ? { ...right.mainPipeline, frameNumber: 0 }
                  : right.mainPipeline,
            }),
      },
    );
  const statesStable = [
    ...observations,
    { state: stability.captureState },
  ].every((observation) => sameStableState(observation.state, reference.state));
  const outputStable = observations.every(
    (observation) =>
      observation.byteLength === image.byteLength &&
      observation.sha256 === image.sha256 &&
      observation.width === image.width &&
      observation.height === image.height,
  );
  const captureOutputBound =
    stability.captureOutput.byteLength === image.byteLength &&
    stability.captureOutput.sha256 === image.sha256 &&
    stability.captureOutput.width === image.width &&
    stability.captureOutput.height === image.height;
  const expectedStateBound =
    reference.state.clockIso === expectation.clockIso &&
    exactDeep(reference.state.cameraTarget, expectation.target) &&
    samePreparedTuple(
      stability.captureState.preparedTuple,
      expectation.preparedTuple,
    ) &&
    reference.state.eclipse.lightingEnabled === expectation.lightingEnabled &&
    (expectation.active === null ||
      reference.state.eclipse.active === expectation.active);
  const ephemerisFramesBound =
    observations.every(
      (observation) =>
        observation.state.ephemeris.frameNumber === observation.frameNumber,
    ) &&
    stability.captureState.ephemeris.frameNumber ===
      stability.captureFrameNumber;
  return (
    ordinalConsecutive &&
    observations.at(-1).ordinal === stability.attemptedFrames - 1 &&
    frameConsecutive &&
    revisionConsecutive &&
    Number.isInteger(stability.captureFrameNumber) &&
    stability.captureFrameNumber === observations.at(-1).frameNumber + 1 &&
    statesStable &&
    outputStable &&
    captureOutputBound &&
    ephemerisFramesBound &&
    expectedStateBound
  );
}

function validImage(image, session, runId, phases, legacyV6 = false) {
  return (
    exactKeys(image, [
      "label",
      "imageId",
      "fileName",
      "byteLength",
      "sha256",
      "width",
      "height",
      "captureMethod",
      "renderTaskToken",
      "captureTaskToken",
      "metricImageId",
      "fingerprintVerified",
      "temporalStability",
    ]) &&
    C12_29_S5_CUSTOM_CAPTURE_LABELS.includes(image.label) &&
    isC1229S5CustomUuidV4(image.imageId) &&
    image.fileName ===
      `${runId}.${image.imageId}.${session.renderer}.${image.label}.png` &&
    Number.isInteger(image.byteLength) &&
    image.byteLength > 0 &&
    SHA256.test(image.sha256) &&
    image.width === C12_29_S5_CUSTOM_SCENE.viewport.width &&
    image.height === C12_29_S5_CUSTOM_SCENE.viewport.height &&
    image.captureMethod === C12_29_S5_CUSTOM_CAPTURE_METHOD &&
    isC1229S5CustomUuidV4(image.renderTaskToken) &&
    isC1229S5CustomUuidV4(image.captureTaskToken) &&
    image.renderTaskToken === image.captureTaskToken &&
    image.metricImageId === image.imageId &&
    image.fingerprintVerified === true &&
    validTemporalStability(image, phases, session.renderer, legacyV6)
  );
}

function validPhasePrefix(session) {
  const keys = Object.keys(session?.phases ?? {});
  return (
    keys.length === C12_29_S5_CUSTOM_PHASES.length &&
    C12_29_S5_CUSTOM_PHASES.every((phase) =>
      Object.hasOwn(session?.phases ?? {}, phase),
    ) &&
    sameOrdered(session?.phaseOrder, C12_29_S5_CUSTOM_PHASES) &&
    sameOrdered(session?.completedPhases, C12_29_S5_CUSTOM_PHASES)
  );
}

const ORACLE_SAMPLE_KEYS = Object.freeze([
  "id",
  "cartographic",
  "pixel",
  "tileId",
  "tileUv",
  "normalizedBoundaryDistance",
  "tileBoundaryPixels",
  "tileBoundaryDistancesPixels",
  "boundaryDistancePixels",
  "flatTileInterior",
  "runtimePosition",
  "offRgba",
  "onRgba",
  "offMetricImageId",
  "onMetricImageId",
  "boundaryAmbiguous",
  "classification",
  "classificationF32",
  "offLuminance",
  "onLuminance",
  "f64",
  "f32",
  "f32Error",
  "quantizationBound",
  "tolerance",
  "observedFactor",
  "absoluteError",
  "withinTolerance",
  "horizonRejectedF64",
  "horizonRejectedF32",
  "geometricF64",
  "geometricF32",
  "geometryIdentity",
]);

const GEOMETRY_IDENTITY_KEYS = Object.freeze([
  "ecefDifferenceMeters",
  "ecefToleranceMeters",
  "ecefWithinTolerance",
  "horizonCompared",
  "horizonDifference",
  "horizonTolerance",
  "horizonWithinTolerance",
  "withinTolerance",
]);

function exactGeometryIdentity(actual, expected) {
  return (
    exactKeys(actual, GEOMETRY_IDENTITY_KEYS) &&
    exactKeys(expected, GEOMETRY_IDENTITY_KEYS) &&
    exactNumber(actual.ecefDifferenceMeters, expected.ecefDifferenceMeters) &&
    exactNumber(actual.ecefToleranceMeters, expected.ecefToleranceMeters) &&
    actual.ecefWithinTolerance === expected.ecefWithinTolerance &&
    actual.horizonCompared === expected.horizonCompared &&
    finiteOrNull(actual.horizonDifference) &&
    Object.is(actual.horizonDifference, expected.horizonDifference) &&
    exactNumber(actual.horizonTolerance, expected.horizonTolerance) &&
    actual.horizonWithinTolerance === expected.horizonWithinTolerance &&
    actual.withinTolerance === expected.withinTolerance
  );
}

function validateDerivedOracleSample(sample, event, offImageId, onImageId) {
  if (
    !exactKeys(sample, ORACLE_SAMPLE_KEYS) ||
    typeof sample.id !== "string" ||
    sample.id.length === 0 ||
    sample.id.length > 192 ||
    !exactKeys(sample.cartographic, ["longitude", "latitude", "height"]) ||
    !finite(sample.cartographic.longitude) ||
    sample.cartographic.longitude < -Math.PI ||
    sample.cartographic.longitude > Math.PI ||
    !finite(sample.cartographic.latitude) ||
    sample.cartographic.latitude < -Math.PI / 2 ||
    sample.cartographic.latitude > Math.PI / 2 ||
    sample.cartographic.height !== C12_29_S5_CUSTOM_SCENE.heightMeters ||
    !exactKeys(sample.pixel, ["x", "y"]) ||
    !Number.isInteger(sample.pixel.x) ||
    !Number.isInteger(sample.pixel.y) ||
    sample.pixel.x < 1 ||
    sample.pixel.y < 1 ||
    sample.pixel.x >= C12_29_S5_CUSTOM_SCENE.viewport.width - 1 ||
    sample.pixel.y >= C12_29_S5_CUSTOM_SCENE.viewport.height - 1 ||
    typeof sample.tileId !== "string" ||
    !/^\d+\/\d+\/\d+$/u.test(sample.tileId) ||
    !Array.isArray(sample.tileUv) ||
    sample.tileUv.length !== 2 ||
    sample.tileUv.some((value) => !finite(value) || value < 0 || value > 1) ||
    !finite(sample.normalizedBoundaryDistance) ||
    !Array.isArray(sample.tileBoundaryPixels) ||
    sample.tileBoundaryPixels.length !== 4 ||
    sample.tileBoundaryPixels.some(
      (pixel) =>
        !exactKeys(pixel, ["x", "y"]) ||
        !finite(pixel.x) ||
        !finite(pixel.y) ||
        Math.abs(pixel.x) > C12_29_S5_CUSTOM_SCENE.viewport.width * 16 ||
        Math.abs(pixel.y) > C12_29_S5_CUSTOM_SCENE.viewport.height * 16,
    ) ||
    !Array.isArray(sample.tileBoundaryDistancesPixels) ||
    sample.tileBoundaryDistancesPixels.length !== 4 ||
    sample.tileBoundaryDistancesPixels.some(
      (value) => !finite(value) || !(value > 0),
    ) ||
    !finite(sample.boundaryDistancePixels) ||
    !(sample.boundaryDistancePixels > 0) ||
    !vec3(sample.runtimePosition) ||
    !validRgba(sample.offRgba) ||
    !validRgba(sample.onRgba) ||
    sample.offMetricImageId !== offImageId ||
    sample.onMetricImageId !== onImageId ||
    !vec3(event?.runtimeBodies?.sun) ||
    !vec3(event?.runtimeBodies?.moon) ||
    !vec4(event?.shadowBlock?.params) ||
    !vec4(event?.shadowBlock?.params2)
  ) {
    return false;
  }
  const derivedId = deriveC1229S5CustomSampleId(sample);
  const tileCoordinates = deriveGeographicTileCoordinates(
    sample.cartographic,
    sample.tileId,
  );
  if (!derivedId || sample.id !== derivedId || !tileCoordinates) return false;
  const tileCoordinateTolerance = 32 * Number.EPSILON;
  if (
    sample.tileUv.some(
      (value, index) =>
        Math.abs(value - tileCoordinates.tileUv[index]) >
        tileCoordinateTolerance,
    )
  ) {
    return false;
  }
  const normalizedBoundaryDistance = Math.min(
    sample.tileUv[0],
    1 - sample.tileUv[0],
    sample.tileUv[1],
    1 - sample.tileUv[1],
  );
  const tileBoundaryDistancesPixels = sample.tileBoundaryPixels.map((pixel) =>
    Math.hypot(pixel.x - sample.pixel.x, pixel.y - sample.pixel.y),
  );
  const boundaryDistancePixels = Math.min(...tileBoundaryDistancesPixels);
  const flatTileInterior =
    normalizedBoundaryDistance > 0 &&
    sample.boundaryDistancePixels >
      C12_29_S5_CUSTOM_SCENE.tileInteriorPixelFootprintRadius;
  const offLuminance = rgbaLuminance(sample.offRgba);
  const onLuminance = rgbaLuminance(sample.onRgba);
  const derived = deriveC1229S5CustomOracleSample({
    cartographic: sample.cartographic,
    sun: event.runtimeBodies.sun,
    moon: event.runtimeBodies.moon,
    params: event.shadowBlock.params,
    params2: event.shadowBlock.params2,
    offLuminance,
    onLuminance,
    runtimePosition: sample.runtimePosition,
  });
  if (!derived?.geometryIdentity) return false;
  return (
    Object.is(sample.normalizedBoundaryDistance, normalizedBoundaryDistance) &&
    exactNumericArray(
      sample.tileBoundaryDistancesPixels,
      tileBoundaryDistancesPixels,
    ) &&
    Object.is(sample.boundaryDistancePixels, boundaryDistancePixels) &&
    sample.flatTileInterior === flatTileInterior &&
    sample.flatTileInterior === true &&
    exactNumber(sample.offLuminance, offLuminance) &&
    exactNumber(sample.onLuminance, onLuminance) &&
    sample.classification === derived.classificationF64 &&
    sample.classificationF32 === derived.classificationF32 &&
    sample.boundaryAmbiguous === derived.boundaryAmbiguous &&
    exactNumber(sample.f64, derived.f64) &&
    exactNumber(sample.f32, derived.f32) &&
    exactNumber(sample.f32Error, derived.f32Error) &&
    exactNumber(sample.quantizationBound, derived.quantizationBound) &&
    exactNumber(sample.tolerance, derived.tolerance) &&
    exactNumber(sample.observedFactor, derived.observedFactor) &&
    exactNumber(sample.absoluteError, derived.absoluteError) &&
    sample.withinTolerance === derived.withinTolerance &&
    sample.horizonRejectedF64 === derived.horizonRejectedF64 &&
    sample.horizonRejectedF32 === derived.horizonRejectedF32 &&
    exactNumber(sample.geometricF64, derived.geometricF64) &&
    exactNumber(sample.geometricF32, derived.geometricF32) &&
    exactGeometryIdentity(sample.geometryIdentity, derived.geometryIdentity) &&
    sample.boundaryAmbiguous === false &&
    sample.offLuminance >= C12_29_S5_CUSTOM_SCENE.minimumOffLuminance &&
    sample.tolerance >= 0 &&
    sample.withinTolerance === true &&
    sample.geometryIdentity.withinTolerance === true
  );
}

function validateEventAxis(event) {
  const centre = event?.eventCentre;
  const bodies = event?.runtimeBodies;
  if (
    centre?.derivedFromRuntimeBodies !== true ||
    centre?.hardcodedLongitude !== false ||
    !finite(centre?.longitude) ||
    centre.longitude < -Math.PI ||
    centre.longitude > Math.PI ||
    !finite(centre?.latitude) ||
    centre.latitude < -Math.PI / 2 ||
    centre.latitude > Math.PI / 2 ||
    !vec3(centre?.point) ||
    !vec3(centre?.direction) ||
    !finite(centre?.forwardRoot) ||
    !(centre.forwardRoot > 0) ||
    !validRuntimeBodies(bodies)
  ) {
    return false;
  }
  const independent = deriveC1229S5CustomAxisIntersection(bodies);
  const cartographicPoint = customEllipsoidGeodeticToEcef({
    longitude: centre.longitude,
    latitude: centre.latitude,
    height: 0,
  });
  if (!independent || !cartographicPoint) return false;
  const pointDifferenceMeters = distance3(independent.point, centre.point);
  const directionDifference = distance3(
    independent.direction,
    centre.direction,
  );
  const rootDifferenceMeters = Math.abs(
    independent.forwardRoot - centre.forwardRoot,
  );
  const surfacePointDifferenceMeters = distance3(
    cartographicPoint,
    centre.point,
  );
  const pointToleranceMeters = c1229S5CustomGeometryTolerance(
    "axisIntersectionPoint",
    "meters",
  );
  const directionTolerance = c1229S5CustomGeometryTolerance(
    "axisDirection",
    "dimensionless",
  );
  const surfacePointToleranceMeters =
    pointToleranceMeters +
    c1229S5CustomGeometryTolerance("ecefPosition", "meters");
  const expectedIdentity = {
    baseEpsilonMeters: C12_29_S5_CUSTOM_GEOMETRY_EPSILON_METERS,
    pointDifferenceMeters,
    pointToleranceMeters,
    directionDifference,
    directionTolerance,
    rootDifferenceMeters,
    rootToleranceMeters: pointToleranceMeters,
    surfacePointDifferenceMeters,
    surfacePointToleranceMeters,
    withinTolerance:
      pointDifferenceMeters <= pointToleranceMeters &&
      directionDifference <= directionTolerance &&
      rootDifferenceMeters <= pointToleranceMeters &&
      surfacePointDifferenceMeters <= surfacePointToleranceMeters,
  };
  const identity = centre.geometryIdentity;
  return (
    exactKeys(identity, Object.keys(expectedIdentity)) &&
    Object.entries(expectedIdentity).every(([key, value]) =>
      typeof value === "number"
        ? exactNumber(identity[key], value)
        : identity[key] === value,
    ) &&
    identity.withinTolerance === true
  );
}

function matrix3MultiplyByVector(matrix, vector) {
  return {
    x: matrix[0] * vector.x + matrix[3] * vector.y + matrix[6] * vector.z,
    y: matrix[1] * vector.x + matrix[4] * vector.y + matrix[7] * vector.z,
    z: matrix[2] * vector.x + matrix[5] * vector.y + matrix[8] * vector.z,
  };
}

function validRuntimeBodies(bodies) {
  if (
    !exactKeys(bodies, [
      "sun",
      "moon",
      "sunInertial",
      "moonInertial",
      "icrfToFixed",
    ]) ||
    !vec3(bodies.sun) ||
    !vec3(bodies.moon) ||
    !vec3(bodies.sunInertial) ||
    !vec3(bodies.moonInertial) ||
    !Array.isArray(bodies.icrfToFixed) ||
    bodies.icrfToFixed.length !== 9 ||
    bodies.icrfToFixed.some((value) => !finite(value))
  ) {
    return false;
  }
  const matrix = bodies.icrfToFixed;
  const column = (index) => ({
    x: matrix[index * 3],
    y: matrix[index * 3 + 1],
    z: matrix[index * 3 + 2],
  });
  const c0 = column(0);
  const c1 = column(1);
  const c2 = column(2);
  const orthogonalityTolerance = 64 * Number.EPSILON;
  const determinant = dot3(
    c0,
    cross3(c1, c2, operations("f64")),
    operations("f64"),
  );
  const orthonormal =
    Math.abs(dot3(c0, c0, operations("f64")) - 1) <= orthogonalityTolerance &&
    Math.abs(dot3(c1, c1, operations("f64")) - 1) <= orthogonalityTolerance &&
    Math.abs(dot3(c2, c2, operations("f64")) - 1) <= orthogonalityTolerance &&
    Math.abs(dot3(c0, c1, operations("f64"))) <= orthogonalityTolerance &&
    Math.abs(dot3(c0, c2, operations("f64"))) <= orthogonalityTolerance &&
    Math.abs(dot3(c1, c2, operations("f64"))) <= orthogonalityTolerance &&
    Math.abs(determinant - 1) <= orthogonalityTolerance;
  if (!orthonormal) return false;
  const derivedSun = matrix3MultiplyByVector(matrix, bodies.sunInertial);
  const derivedMoon = matrix3MultiplyByVector(matrix, bodies.moonInertial);
  const vectorTolerance = (vector) =>
    Math.max(Math.abs(vector.x), Math.abs(vector.y), Math.abs(vector.z), 1) *
    Number.EPSILON *
    16;
  const sunRange = Math.hypot(bodies.sun.x, bodies.sun.y, bodies.sun.z);
  const moonRange = Math.hypot(bodies.moon.x, bodies.moon.y, bodies.moon.z);
  return (
    sunRange > 10_000_000_000 &&
    sunRange < 1_000_000_000_000 &&
    moonRange > 10_000_000 &&
    moonRange < 10_000_000_000 &&
    distance3(derivedSun, bodies.sun) <= vectorTolerance(bodies.sun) &&
    distance3(derivedMoon, bodies.moon) <= vectorTolerance(bodies.moon)
  );
}

function froundedShadowPayload(block) {
  if (
    !vec4(block?.sunDirectionAndInvRange) ||
    !vec4(block?.moonDirectionDeltaAndInvRange) ||
    !vec4(block?.params) ||
    !vec4(block?.params2)
  ) {
    return undefined;
  }
  return [
    block.sunDirectionAndInvRange.x,
    block.sunDirectionAndInvRange.y,
    block.sunDirectionAndInvRange.z,
    block.sunDirectionAndInvRange.w,
    block.moonDirectionDeltaAndInvRange.x,
    block.moonDirectionDeltaAndInvRange.y,
    block.moonDirectionDeltaAndInvRange.z,
    block.moonDirectionDeltaAndInvRange.w,
    block.params.x,
    block.params.y,
    block.params.z,
    block.params.w,
    block.params2.x,
    block.params2.y,
    block.params2.z,
    block.params2.w,
  ].map(Math.fround);
}

function imageFingerprintEqual(left, right) {
  return (
    left?.byteLength === right?.byteLength &&
    left?.sha256 === right?.sha256 &&
    left?.width === right?.width &&
    left?.height === right?.height
  );
}

function validC1229S5CustomV6BehavioralPick(
  pick,
  renderer,
  preparationTuple,
  antipode,
) {
  const before = pick?.postcondition?.before;
  const after = pick?.postcondition?.after;
  const expectedKind = renderer === "webgpu" ? "globe" : "undefined";
  return (
    exactKeys(pick, [
      "method",
      "invoked",
      "awaited",
      "settled",
      "renderPumpFrames",
      "maximumPumpFrames",
      "directUpdateForPickCall",
      "pickableBefore",
      "pickableRequested",
      "pickIdAllocated",
      "pickIdKey",
      "pickIdRegistryOwnsGlobe",
      "pickColorMirrorExact",
      "updateForPickObserved",
      "updateForPickCalls",
      "resultKind",
      "resultPrimitiveIdentity",
      "pickableAfterRestore",
      "pickableRestored",
      "postcondition",
    ]) &&
    exactKeys(pick?.postcondition, [
      "before",
      "after",
      "surfaceRadius",
      "selectionRevision",
      "selectedTileIds",
    ]) &&
    pick.method === "scene.pickAsync" &&
    pick.invoked === true &&
    pick.awaited === true &&
    pick.settled === true &&
    Number.isInteger(pick.renderPumpFrames) &&
    pick.renderPumpFrames >= 1 &&
    pick.renderPumpFrames <= C12_29_S5_CUSTOM_SCENE.maximumPickPumpFrames &&
    pick.maximumPumpFrames === C12_29_S5_CUSTOM_SCENE.maximumPickPumpFrames &&
    pick.directUpdateForPickCall === false &&
    pick.pickableBefore === false &&
    pick.pickableRequested === true &&
    pick.pickIdAllocated === true &&
    Number.isInteger(pick.pickIdKey) &&
    pick.pickIdKey > 0 &&
    pick.pickIdRegistryOwnsGlobe === true &&
    pick.pickColorMirrorExact === true &&
    pick.updateForPickObserved === true &&
    Number.isInteger(pick.updateForPickCalls) &&
    pick.updateForPickCalls >= 1 &&
    pick.updateForPickCalls <= C12_29_S5_CUSTOM_SCENE.maximumPickPumpFrames &&
    pick.updateForPickCalls <= pick.renderPumpFrames &&
    pick.resultKind === expectedKind &&
    pick.resultPrimitiveIdentity === (renderer === "webgpu") &&
    pick.pickableAfterRestore === false &&
    pick.pickableRestored === true &&
    exactFreshUnpreparedTuple(before) &&
    exactPreparedTuple(after) &&
    sameOrdered(before.selectedTileIds, after.selectedTileIds) &&
    samePreparedContent(after, preparationTuple) &&
    after.selectionRevision > antipode?.onPreparedTuple?.selectionRevision &&
    pick.postcondition.surfaceRadius === after.surfaceRadius &&
    pick.postcondition.selectionRevision === after.selectionRevision &&
    sameOrdered(pick.postcondition.selectedTileIds, after.selectedTileIds)
  );
}

const C1229_S5_CUSTOM_COMMON_INSTRUMENTATION = Object.freeze([
  "moon.show",
  "moon.update",
]);
const C1229_S5_CUSTOM_WEBGPU_INSTRUMENTATION = Object.freeze([
  "globeRenderer.createTileCommands",
  "captureGlobeRenderer.getOrCreateCaptureTileCommands",
  "eclipseManager.prepare",
  ...C1229_S5_CUSTOM_COMMON_INSTRUMENTATION,
]);
const C1229_S5_CUSTOM_V6_COMMON_INSTRUMENTATION = Object.freeze([
  "moon.show",
  "moon.update",
  "pickProvider.updateForPick",
]);
const C1229_S5_CUSTOM_V6_WEBGPU_INSTRUMENTATION = Object.freeze([
  "captureGlobeRenderer.getOrCreateCaptureTileCommands",
  "eclipseManager.prepare",
  ...C1229_S5_CUSTOM_V6_COMMON_INSTRUMENTATION,
]);
const C1229_S5_CUSTOM_OWN_DATA_SHAPE = Object.freeze({
  kind: "data",
  writable: true,
  enumerable: true,
  configurable: true,
});
const C1229_S5_CUSTOM_INHERITED_METHOD_SHAPE = Object.freeze({
  kind: "data",
  writable: true,
  enumerable: false,
  configurable: true,
});

function exactDescriptorShape(value, expected) {
  return (
    exactKeys(value, ["kind", "writable", "enumerable", "configurable"]) &&
    value.kind === expected.kind &&
    value.writable === expected.writable &&
    value.enumerable === expected.enumerable &&
    value.configurable === expected.configurable
  );
}

function validInstrumentationRestorations(
  restorations,
  renderer,
  legacyV6 = false,
) {
  const expected =
    renderer === "webgpu"
      ? legacyV6
        ? C1229_S5_CUSTOM_V6_WEBGPU_INSTRUMENTATION
        : C1229_S5_CUSTOM_WEBGPU_INSTRUMENTATION
      : legacyV6
        ? C1229_S5_CUSTOM_V6_COMMON_INSTRUMENTATION
        : C1229_S5_CUSTOM_COMMON_INSTRUMENTATION;
  return (
    Array.isArray(restorations) &&
    restorations.length === expected.length &&
    restorations.every((restoration, index) => {
      const own = restoration?.label === "moon.show";
      const expectedShape = own
        ? C1229_S5_CUSTOM_OWN_DATA_SHAPE
        : C1229_S5_CUSTOM_INHERITED_METHOD_SHAPE;
      return (
        exactKeys(restoration, [
          "label",
          "hadOwnBefore",
          "hasOwnAfter",
          "ownerDepthBefore",
          "ownerDepthAfter",
          "ownerDescriptorBefore",
          "ownerDescriptorAfter",
          "preResolvedAuthorityExact",
          "ownershipExact",
          "ownDescriptorExact",
          "targetPrototypeExact",
          "prototypeChainExact",
          "ownerDescriptorExact",
          "resolvedIdentityExact",
          "restored",
        ]) &&
        restoration.label === expected[index] &&
        restoration.hadOwnBefore === own &&
        restoration.hasOwnAfter === own &&
        restoration.ownerDepthBefore === (own ? 0 : 1) &&
        restoration.ownerDepthAfter === (own ? 0 : 1) &&
        exactDescriptorShape(
          restoration.ownerDescriptorBefore,
          expectedShape,
        ) &&
        exactDescriptorShape(restoration.ownerDescriptorAfter, expectedShape) &&
        restoration.preResolvedAuthorityExact === true &&
        restoration.ownershipExact === true &&
        restoration.ownDescriptorExact === true &&
        restoration.targetPrototypeExact === true &&
        restoration.prototypeChainExact === true &&
        restoration.ownerDescriptorExact === true &&
        restoration.resolvedIdentityExact === true &&
        restoration.restored === true
      );
    })
  );
}

function validateSession(
  session,
  runId,
  structural,
  failures,
  legacyV6 = false,
) {
  const renderer = session?.renderer ?? "unknown";
  const phases = session?.phases ?? {};
  if (
    !exactKeys(session, [
      "renderer",
      "actualRenderer",
      "phaseOrder",
      "completedPhases",
      "phases",
      "images",
      "transport",
      "runtime",
      "oracleSamples",
      "cleanup",
    ]) ||
    !C12_29_S5_CUSTOM_RENDERERS.includes(renderer) ||
    session.actualRenderer !== renderer
  ) {
    structural.push(`${renderer}: renderer/session shape is invalid`);
    return;
  }
  if (!validPhasePrefix(session)) {
    structural.push(`${renderer}: exact nine-phase order/prefix is absent`);
  }
  const images = session.images;
  if (
    !Array.isArray(images) ||
    images.length !== C12_29_S5_CUSTOM_CAPTURE_LABELS.length ||
    !sameOrdered(
      images.map((image) => image?.label),
      C12_29_S5_CUSTOM_CAPTURE_LABELS,
    ) ||
    images.some((image) => !validImage(image, session, runId, phases, legacyV6))
  ) {
    structural.push(
      `${renderer}: six stable, bound same-snapshot PNGs are not exact`,
    );
  } else {
    const frameWindows = images.map((image) => ({
      first: image.temporalStability.observations[0].frameNumber,
      last: image.temporalStability.captureFrameNumber,
    }));
    if (
      frameWindows.some(
        (window, index) =>
          index > 0 && window.first <= frameWindows[index - 1].last,
      ) ||
      new Set(
        images.flatMap((image) => [
          ...image.temporalStability.observations.map(
            (observation) => observation.frameNumber,
          ),
          image.temporalStability.captureFrameNumber,
        ]),
      ).size !==
        images.length * (C12_29_S5_CUSTOM_SCENE.minimumStableFrames + 1)
    ) {
      structural.push(
        `${renderer}: capture stability frames overlap or regress`,
      );
    }
  }
  const imageFor = (label) => images?.find((image) => image?.label === label);
  const imageIdFor = (label) => imageFor(label)?.imageId;
  if (
    [
      ["event-off", "event-on"],
      ["antipode-off", "antipode-on"],
      ["control-off", "control-on"],
    ].some(
      ([offLabel, onLabel]) =>
        !exactDeep(
          imageFor(offLabel)?.temporalStability?.captureState?.content,
          imageFor(onLabel)?.temporalStability?.captureState?.content,
        ),
    )
  ) {
    structural.push(`${renderer}: paired OFF/ON prepared content changed`);
  }
  if (
    !exactKeys(session?.transport, [
      "loopback",
      "sameOriginOnly",
      "externalRequests",
      "failedRequests",
      "httpErrors",
      ...(legacyV6 ? [] : ["measurementEpoch"]),
    ]) ||
    session?.transport?.loopback !== true ||
    session?.transport?.sameOriginOnly !== true ||
    session?.transport?.externalRequests?.length !== 0 ||
    session?.transport?.failedRequests?.length !== 0 ||
    session?.transport?.httpErrors?.length !== 0
  ) {
    structural.push(`${renderer}: transport escaped the offline loopback lane`);
  }
  if (
    !legacyV6 &&
    (!exactKeys(session?.transport?.measurementEpoch, [
      "id",
      "harnessRoute",
      "beganAfterHarnessReady",
      "harnessViewerAbsent",
      "endedBeforePageClose",
      "responseTasksDrained",
      "firstResponseOrdinal",
      "lastResponseOrdinal",
      "responseCount",
    ]) ||
      !isC1229S5CustomUuidV4(session.transport.measurementEpoch.id) ||
      session.transport.measurementEpoch.harnessRoute !==
        "/Tools/visual-regression/c12-29-s5-custom-ellipsoid-harness.html" ||
      session.transport.measurementEpoch.beganAfterHarnessReady !== true ||
      session.transport.measurementEpoch.harnessViewerAbsent !== true ||
      session.transport.measurementEpoch.endedBeforePageClose !== true ||
      session.transport.measurementEpoch.responseTasksDrained !== true ||
      session.transport.measurementEpoch.firstResponseOrdinal !== 1 ||
      !Number.isInteger(
        session.transport.measurementEpoch.lastResponseOrdinal,
      ) ||
      session.transport.measurementEpoch.lastResponseOrdinal !==
        session.transport.measurementEpoch.responseCount ||
      !(session.transport.measurementEpoch.responseCount >= 2))
  ) {
    structural.push(`${renderer}: owned measurement epoch receipt is inexact`);
  }
  if (
    session?.runtime?.pageErrors?.length !== 0 ||
    session?.runtime?.consoleErrors?.length !== 0 ||
    session?.runtime?.gpuErrors?.length !== 0 ||
    session?.runtime?.deviceLost !== false
  ) {
    structural.push(`${renderer}: browser/GPU diagnostics are red`);
  }
  const construction = phases["custom-scene-construction"];
  if (
    !exactKeys(
      construction?.ellipsoid,
      legacyV6
        ? ["constructor", "radii", "sceneIdentity"]
        : ["servedConstructorIdentity", "radii", "sceneIdentity"],
    ) ||
    (legacyV6
      ? construction?.ellipsoid?.constructor !== "Ellipsoid"
      : construction?.ellipsoid?.servedConstructorIdentity !== true) ||
    construction?.ellipsoid?.radii?.x !== C12_29_S5_CUSTOM_SCENE.radii.x ||
    construction?.ellipsoid?.radii?.y !== C12_29_S5_CUSTOM_SCENE.radii.y ||
    construction?.ellipsoid?.radii?.z !== C12_29_S5_CUSTOM_SCENE.radii.z ||
    construction?.ellipsoid?.sceneIdentity !== true ||
    construction?.provider?.constructor !== "CustomHeightmapTerrainProvider" ||
    construction?.provider?.width !== C12_29_S5_CUSTOM_SCENE.terrainWidth ||
    construction?.provider?.height !== C12_29_S5_CUSTOM_SCENE.terrainHeight ||
    construction?.provider?.constantHeight !==
      C12_29_S5_CUSTOM_SCENE.heightMeters ||
    construction?.provider?.tilingSchemeIdentity !== true ||
    construction?.projection?.constructor !== "GeographicProjection" ||
    construction?.projection?.ellipsoidIdentity !== true ||
    construction?.projection?.sceneIdentity !== true ||
    construction?.tilingScheme?.constructor !== "GeographicTilingScheme" ||
    construction?.tilingScheme?.ellipsoidIdentity !== true ||
    construction?.globe?.ellipsoidIdentity !== true ||
    construction?.globe?.sceneIdentity !== true ||
    construction?.imagery?.constructor !== "GridImageryProvider" ||
    construction?.imagery?.tilingSchemeIdentity !== true ||
    !validateC1229S5CustomMoonTopology(construction?.moon)
  ) {
    structural.push(`${renderer}: custom scene construction is not exact`);
  }
  const preparation = phases["selected-terrain-preparation"];
  const expectedRadius = computeC1229S5CustomSurfaceRadius({
    maximumRadius: C12_29_S5_CUSTOM_SCENE.radii.x,
    minimumHeight: C12_29_S5_CUSTOM_SCENE.heightMeters,
    maximumHeight: C12_29_S5_CUSTOM_SCENE.heightMeters,
  });
  const preparationTuple = {
    prepared: preparation?.prepared,
    selectionRevision: preparation?.selectionRevision,
    surfaceRadius: preparation?.surfaceRadius,
    selectedTileIds: preparation?.selectedTileIds,
  };
  if (
    !exactPreparedTuple(preparationTuple) ||
    preparation?.tilesLoaded !== true ||
    preparation?.knownMinimumHeight !== 0 ||
    preparation?.knownMaximumHeight !== C12_29_S5_CUSTOM_SCENE.heightMeters ||
    preparation?.knownBoundsValid !== true ||
    !Object.is(preparation?.surfaceRadius, expectedRadius.radius) ||
    preparation?.radiusLaw?.maximumRadius !== C12_29_S5_CUSTOM_SCENE.radii.x ||
    preparation?.radiusLaw?.minimumHeight !== 0 ||
    preparation?.radiusLaw?.maximumHeight !==
      C12_29_S5_CUSTOM_SCENE.heightMeters ||
    preparation?.radiusLaw?.height !== C12_29_S5_CUSTOM_SCENE.heightMeters ||
    !(preparation?.terrainRequestCount > 0) ||
    !Array.isArray(preparation?.terrainRequests) ||
    preparation.terrainRequests.length !== preparation.terrainRequestCount ||
    preparation.terrainRequests.some(
      (request) =>
        !Number.isInteger(request?.x) ||
        !Number.isInteger(request?.y) ||
        !Number.isInteger(request?.level) ||
        request.height !== C12_29_S5_CUSTOM_SCENE.heightMeters,
    )
  ) {
    failures.push(`${renderer}: selected custom terrain/radius law is wrong`);
  }
  const eventOff = phases["event-s5-off"];
  if (
    eventOff?.enabled !== false ||
    eventOff?.clockIso !== C12_29_S5_CUSTOM_SCENE.eventIso ||
    !samePreparedContent(eventOff?.preparedTuple, preparationTuple) ||
    eventOff?.preparedTuple?.selectionRevision !==
      preparationTuple.selectionRevision +
        (imageFor("event-off")?.temporalStability?.attemptedFrames ?? NaN)
  ) {
    failures.push(`${renderer}: event OFF control is not prepared and exact`);
  }
  const eventOn = phases["event-s5-on"];
  const eventEphemeris =
    imageFor("event-on")?.temporalStability?.captureState?.ephemeris;
  const expectedPayload = Array.from(
    packC1229S5CustomCommonRay(
      {
        sun: eventOn?.runtimeBodies?.sun,
        moon: eventOn?.runtimeBodies?.moon,
        params: eventOn?.shadowBlock?.params,
        params2: eventOn?.shadowBlock?.params2,
      },
      "f32",
    ) ?? [],
  );
  const shadowPayload = froundedShadowPayload(eventOn?.shadowBlock);
  const identity = preparation?.backendIdentity;
  if (renderer === "webgl") {
    const automaticUniforms = identity?.automaticUniforms;
    if (
      !exactKeys(automaticUniforms, WEBGL_AUTOMATIC_UNIFORMS_IDENTITY_KEYS) ||
      automaticUniforms.exportName !== "AutomaticUniforms" ||
      automaticUniforms.radiiSource !== WEBGL_AUTOMATIC_UNIFORMS_RADII_SOURCE ||
      automaticUniforms.inverseRadiiSource !==
        WEBGL_AUTOMATIC_UNIFORMS_INVERSE_RADII_SOURCE
    ) {
      structural.push(
        `${renderer}: served AutomaticUniforms evidence shape is invalid`,
      );
    } else if (
      automaticUniforms.servedBundleExport !== true ||
      automaticUniforms.bundleExportIdentity !== true ||
      automaticUniforms.radiiUniformIdentity !== true ||
      automaticUniforms.inverseRadiiUniformIdentity !== true ||
      automaticUniforms.radiiExact !== true ||
      automaticUniforms.inverseRadiiExact !== true ||
      !exactVec3(automaticUniforms.radii, C12_29_S5_CUSTOM_SCENE.radii) ||
      !exactVec3(automaticUniforms.inverseRadii, {
        x: 1 / C12_29_S5_CUSTOM_SCENE.radii.x,
        y: 1 / C12_29_S5_CUSTOM_SCENE.radii.y,
        z: 1 / C12_29_S5_CUSTOM_SCENE.radii.z,
      })
    ) {
      failures.push(
        `${renderer}: served AutomaticUniforms identity/custom radii are not exact`,
      );
    }
  } else {
    const expectedCamera = {
      inverseRadiiX: Math.fround(1 / C12_29_S5_CUSTOM_SCENE.radii.x),
      inverseRadiiY: Math.fround(1 / C12_29_S5_CUSTOM_SCENE.radii.y),
      inverseRadiiZ: Math.fround(1 / C12_29_S5_CUSTOM_SCENE.radii.z),
      maximumRadius: Math.fround(C12_29_S5_CUSTOM_SCENE.radii.x),
    };
    if (
      identity?.cameraUbo?.indices?.inverseRadiiX !==
        C12_29_S5_CUSTOM_WEBGPU_CAMERA_INDICES.inverseRadiiX ||
      identity?.cameraUbo?.indices?.inverseRadiiY !==
        C12_29_S5_CUSTOM_WEBGPU_CAMERA_INDICES.inverseRadiiY ||
      identity?.cameraUbo?.indices?.inverseRadiiZ !==
        C12_29_S5_CUSTOM_WEBGPU_CAMERA_INDICES.inverseRadiiZ ||
      identity?.cameraUbo?.indices?.maximumRadius !==
        C12_29_S5_CUSTOM_WEBGPU_CAMERA_INDICES.maximumRadius ||
      !exactKeys(identity?.cameraUbo?.values, Object.keys(expectedCamera)) ||
      Object.keys(expectedCamera).some(
        (key) =>
          !Object.is(identity.cameraUbo.values[key], expectedCamera[key]),
      ) ||
      identity?.cameraUbo?.valuesExact !== true
    ) {
      failures.push(
        "webgpu: current-frame custom camera UBO is absent or inexact",
      );
    }
    if (!legacyV6) {
      const eventOnStability = imageFor("event-on")?.temporalStability;
      const eventOnStates = [
        ...(eventOnStability?.observations ?? []).map(
          (observation) => observation.state,
        ),
        eventOnStability?.captureState,
      ];
      const captureMain = eventOnStability?.captureState?.mainPipeline;
      const mainIdentity = identity?.mainPipeline;
      const expectedFrameNumbers = [
        ...(eventOnStability?.observations ?? []).map(
          (observation) => observation.frameNumber,
        ),
        eventOnStability?.captureFrameNumber,
      ];
      const expectedPositiveDrawCount = captureMain?.draws?.reduce(
        (sum, draw) => sum + draw.positiveDrawCount,
        0,
      );
      if (
        !exactKeys(mainIdentity, [
          "method",
          "stableFrameNumbers",
          "selectedTileIds",
          "meshIdentities",
          "positiveDrawCount",
          "currentFramePositiveDraw",
          "cameraUboExact",
          "stableCohortExact",
        ]) ||
        mainIdentity.method !== "globeRenderer.createTileCommands" ||
        !sameOrdered(mainIdentity.stableFrameNumbers, expectedFrameNumbers) ||
        !sameOrdered(
          mainIdentity.selectedTileIds,
          captureMain?.draws?.map((draw) => draw.tileId),
        ) ||
        !sameOrdered(
          mainIdentity.meshIdentities,
          captureMain?.draws?.map((draw) => draw.meshIdentity),
        ) ||
        mainIdentity.positiveDrawCount !== expectedPositiveDrawCount ||
        !(mainIdentity.positiveDrawCount > 0) ||
        mainIdentity.currentFramePositiveDraw !== true ||
        mainIdentity.cameraUboExact !== true ||
        mainIdentity.stableCohortExact !== true ||
        eventOnStates.some(
          (state) =>
            state?.mainPipeline?.currentFramePositiveDraw !== true ||
            state?.mainPipeline?.cameraUboExact !== true ||
            state?.mainPipeline?.cohortExact !== true,
        )
      ) {
        failures.push(
          "webgpu: stable main-pipeline draw/camera cohort is absent or cold",
        );
      }
    }
    if (
      identity?.eclipseBinding?.binding !==
        C12_29_S5_CUSTOM_WEBGPU_ECLIPSE_BINDING ||
      identity?.eclipseBinding?.offsetAligned !== true ||
      identity?.eclipseBinding?.size !== 64 ||
      !exactNumericArray(identity?.eclipseBinding?.payload, expectedPayload) ||
      !exactNumericArray(
        froundedShadowPayload(identity?.eclipseBinding?.block),
        expectedPayload,
      ) ||
      identity?.eclipseBinding?.payloadExact !== true
    ) {
      failures.push("webgpu: binding-2 custom eclipse payload is wrong");
    }
  }
  if (
    eventOn?.enabled !== true ||
    eventOn?.clockIso !== C12_29_S5_CUSTOM_SCENE.eventIso ||
    !samePreparedContent(eventOn?.preparedTuple, preparationTuple) ||
    eventOn?.preparedTuple?.selectionRevision !==
      eventOff?.preparedTuple?.selectionRevision +
        (imageFor("event-on")?.temporalStability?.attemptedFrames ?? NaN) ||
    !exactVec3(
      eventOn?.runtimeBodies?.sun,
      eventEphemeris?.sample?.sunPositionWC,
    ) ||
    !exactVec3(
      eventOn?.runtimeBodies?.moon,
      eventEphemeris?.sample?.moonPositionWC,
    ) ||
    !validateEventAxis(eventOn) ||
    !vec4(eventOn?.shadowBlock?.sunDirectionAndInvRange) ||
    !vec4(eventOn?.shadowBlock?.moonDirectionDeltaAndInvRange) ||
    !vec4(eventOn?.shadowBlock?.params) ||
    !vec4(eventOn?.shadowBlock?.params2)
  ) {
    failures.push(`${renderer}: event visual/axis evidence is incomplete`);
  }
  if (
    !exactNumericArray(shadowPayload, expectedPayload) ||
    expectedPayload.length !== C12_29_S5_CUSTOM_ECLIPSE_FLOATS
  ) {
    failures.push(`${renderer}: runtime shadow vectors are disconnected`);
  }
  if (
    renderer === "webgl" &&
    (!Array.isArray(eventOn?.shadowBlock?.webglPackedUniform) ||
      !exactNumericArray(
        eventOn.shadowBlock.webglPackedUniform.map(Math.fround),
        expectedPayload,
      ) ||
      !exactNumericArray(
        eventOn?.shadowBlock?.webglPackedF32,
        expectedPayload,
      ) ||
      eventOn?.shadowBlock?.payloadExact !== true)
  ) {
    failures.push(
      "webgl: packed S5 mat4 does not match the independent payload",
    );
  }

  const samples = session.oracleSamples;
  const classOrder = ["umbra", "penumbra", "clear"];
  const expectedClassSequence = classOrder.flatMap((classification) =>
    Array(3).fill(classification),
  );
  const sampleIds = Array.isArray(samples)
    ? samples.map((sample) => sample?.id)
    : [];
  const mainSamplesValid =
    Array.isArray(samples) &&
    samples.length === 9 &&
    new Set(sampleIds).size === samples.length &&
    sameOrdered(
      samples.map((sample) => sample?.classification),
      expectedClassSequence,
    ) &&
    classOrder.every((classification) => {
      const ids = samples
        .filter((sample) => sample?.classification === classification)
        .map((sample) => sample.id);
      return sameOrdered(ids, [...ids].sort());
    }) &&
    samples.every((sample) =>
      validateDerivedOracleSample(
        sample,
        eventOn,
        imageIdFor("event-off"),
        imageIdFor("event-on"),
      ),
    );
  const sampleCounts = Object.fromEntries(
    classOrder.map((classification) => [
      classification,
      Array.isArray(samples)
        ? samples.filter((sample) => sample?.classification === classification)
            .length
        : 0,
    ]),
  );
  if (
    !mainSamplesValid ||
    eventOn?.oracleSampleCount !== 9 ||
    !exactKeys(eventOn?.oracleSampleCounts, classOrder) ||
    classOrder.some(
      (classification) =>
        eventOn.oracleSampleCounts[classification] !==
        sampleCounts[classification],
    ) ||
    eventOn?.allSamplesWithinDerivedTolerance !==
      samples?.every((sample) => sample.withinTolerance) ||
    eventOn?.hasUmbra !== (sampleCounts.umbra === 3) ||
    eventOn?.hasPenumbra !== (sampleCounts.penumbra === 3) ||
    eventOn?.hasClear !== (sampleCounts.clear === 3)
  ) {
    failures.push(
      `${renderer}: oracle samples are disconnected, vacuous, or out of tolerance`,
    );
  }

  const antipode = phases["antipode-horizon-control"];
  const antipodeSamples = antipode?.samples;
  const antipodeIds = Array.isArray(antipodeSamples)
    ? antipodeSamples.map((sample) => sample?.id)
    : [];
  const antipodeImagesEqual = imageFingerprintEqual(
    imageFor("antipode-off"),
    imageFor("antipode-on"),
  );
  const antipodeSamplesValid =
    Array.isArray(antipodeSamples) &&
    antipodeSamples.length >= 3 &&
    antipodeSamples.length <= 8 &&
    new Set(antipodeIds).size === antipodeSamples.length &&
    sameOrdered(antipodeIds, [...antipodeIds].sort()) &&
    antipodeSamples.every(
      (sample) =>
        validateDerivedOracleSample(
          sample,
          eventOn,
          imageIdFor("antipode-off"),
          imageIdFor("antipode-on"),
        ) &&
        sample.classification === "horizon" &&
        sample.classificationF32 === "horizon" &&
        sample.geometryIdentity.horizonCompared === true &&
        sample.horizonRejectedF64 === true &&
        sample.horizonRejectedF32 === true &&
        Object.is(sample.f64, 1) &&
        Object.is(sample.f32, 1) &&
        Object.is(sample.observedFactor, 1) &&
        Object.is(sample.absoluteError, 0),
    );
  const antipodeOffStates = [
    ...(imageFor("antipode-off")?.temporalStability?.observations ?? []).map(
      (observation) => observation.state,
    ),
    imageFor("antipode-off")?.temporalStability?.captureState,
  ];
  const antipodeOnStates = [
    ...(imageFor("antipode-on")?.temporalStability?.observations ?? []).map(
      (observation) => observation.state,
    ),
    imageFor("antipode-on")?.temporalStability?.captureState,
  ];
  const offContent =
    imageFor("antipode-off")?.temporalStability?.captureState?.content;
  const onContent =
    imageFor("antipode-on")?.temporalStability?.captureState?.content;
  if (
    (!legacyV6 &&
      (antipode?.activeSemantics !==
        "conservative-frame-active-per-fragment-horizon-v1" ||
        antipode?.offActive !== false ||
        typeof antipode?.onActive !== "boolean" ||
        antipodeOffStates.some((state) => state?.eclipse?.active !== false) ||
        antipodeOnStates.some(
          (state) => state?.eclipse?.active !== antipode?.onActive,
        ) ||
        antipode?.stableTileMeshCohort !== true ||
        !exactDeep(offContent, onContent))) ||
    !samePreparedContent(
      antipode?.preparedTupleBefore,
      antipode?.offPreparedTuple,
    ) ||
    !samePreparedContent(
      antipode?.offPreparedTuple,
      antipode?.onPreparedTuple,
    ) ||
    (legacyV6
      ? antipode?.offPreparedTuple?.selectionRevision !==
          antipode?.preparedTupleBefore?.selectionRevision +
            (imageFor("antipode-off")?.temporalStability?.attemptedFrames ??
              NaN) ||
        antipode?.onPreparedTuple?.selectionRevision !==
          antipode?.offPreparedTuple?.selectionRevision +
            (imageFor("antipode-on")?.temporalStability?.attemptedFrames ?? NaN)
      : !(
          antipode?.offPreparedTuple?.selectionRevision >
          antipode?.preparedTupleBefore?.selectionRevision
        ) ||
        !(
          antipode?.onPreparedTuple?.selectionRevision >
          antipode?.offPreparedTuple?.selectionRevision
        )) ||
    antipode?.allCandidatesHorizonRejected !== antipodeSamplesValid ||
    antipode?.offOnByteIdentical !== antipodeImagesEqual ||
    antipodeImagesEqual !== true ||
    !antipodeSamplesValid
  ) {
    failures.push(`${renderer}: antipodal horizon control is red`);
  }

  const pick = phases["behavioral-pick"];
  const pickBefore = pick?.freshCohort?.before;
  const pickAfter = pick?.freshCohort?.after;
  const expectedPickKind = renderer === "webgpu" ? "globe" : "undefined";
  const validPickCohort = (cohort) =>
    exactKeys(cohort, ["preparedTuple", "content"]) &&
    exactPreparedTuple(cohort.preparedTuple) &&
    Array.isArray(cohort.content) &&
    cohort.content.length === cohort.preparedTuple.selectedTileIds.length &&
    sameOrdered(
      cohort.content.map((entry) => entry?.tileId),
      cohort.preparedTuple.selectedTileIds,
    ) &&
    cohort.content.every(
      (entry) =>
        exactKeys(entry, ["tileId", "meshIdentity", "renderedMesh"]) &&
        /^mesh-\d+$/u.test(entry.meshIdentity ?? "") &&
        entry.renderedMesh === true,
    );
  const warmupResults = pick?.warmupResults;
  const warmupResultsValid =
    Array.isArray(warmupResults) &&
    warmupResults.length === pick?.warmupAttempts &&
    warmupResults.every(
      (result) =>
        exactKeys(result, [
          "settled",
          "renderPumpFrames",
          "resultKind",
          "resultPrimitiveIdentity",
        ]) &&
        result.settled === true &&
        Number.isInteger(result.renderPumpFrames) &&
        result.renderPumpFrames >= 1 &&
        result.renderPumpFrames <=
          C12_29_S5_CUSTOM_SCENE.maximumPickPumpFrames &&
        (renderer === "webgl"
          ? result.resultKind === "undefined" &&
            result.resultPrimitiveIdentity === false
          : (result.resultKind === "undefined" &&
              result.resultPrimitiveIdentity === false) ||
            (result.resultKind === "globe" &&
              result.resultPrimitiveIdentity === true)),
    );
  if (
    legacyV6
      ? !validC1229S5CustomV6BehavioralPick(
          pick,
          renderer,
          preparationTuple,
          antipode,
        )
      : !exactKeys(pick, [
          "method",
          "warmupMethod",
          "warmupAttempts",
          "maximumWarmupAttempts",
          "warmupReady",
          "warmupResults",
          "invoked",
          "awaited",
          "settled",
          "renderPumpFrames",
          "maximumPumpFrames",
          "pickableBefore",
          "pickableRequested",
          "pickIdAllocated",
          "pickIdKey",
          "pickIdRegistryOwnsGlobe",
          "pickColorMirrorExact",
          "resultKind",
          "resultPrimitiveIdentity",
          "pickableAfterRestore",
          "pickableRestored",
          "freshCohort",
        ]) ||
        !exactKeys(pick?.freshCohort, ["before", "after", "stable"]) ||
        pick?.method !== "scene.pickAsync" ||
        pick?.warmupMethod !== "scene.pickAsync" ||
        !Number.isInteger(pick?.warmupAttempts) ||
        pick.warmupAttempts < 1 ||
        pick.warmupAttempts >
          C12_29_S5_CUSTOM_SCENE.maximumPickWarmupAttempts ||
        pick?.maximumWarmupAttempts !==
          C12_29_S5_CUSTOM_SCENE.maximumPickWarmupAttempts ||
        pick?.warmupReady !== true ||
        !warmupResultsValid ||
        warmupResults.at(-1)?.resultKind !== expectedPickKind ||
        warmupResults.at(-1)?.resultPrimitiveIdentity !==
          (renderer === "webgpu") ||
        pick?.invoked !== true ||
        pick?.awaited !== true ||
        pick?.settled !== true ||
        !Number.isInteger(pick?.renderPumpFrames) ||
        pick.renderPumpFrames < 1 ||
        pick.renderPumpFrames > C12_29_S5_CUSTOM_SCENE.maximumPickPumpFrames ||
        pick?.maximumPumpFrames !==
          C12_29_S5_CUSTOM_SCENE.maximumPickPumpFrames ||
        pick?.pickableBefore !== false ||
        pick?.pickableRequested !== true ||
        pick?.pickIdAllocated !== true ||
        !Number.isInteger(pick?.pickIdKey) ||
        !(pick.pickIdKey > 0) ||
        pick?.pickIdRegistryOwnsGlobe !== true ||
        pick?.pickColorMirrorExact !== true ||
        pick?.resultKind !== expectedPickKind ||
        pick?.resultPrimitiveIdentity !== (renderer === "webgpu") ||
        pick?.pickableAfterRestore !== false ||
        pick?.pickableRestored !== true ||
        !validPickCohort(pickBefore) ||
        !validPickCohort(pickAfter) ||
        !exactDeep(pickBefore?.content, pickAfter?.content) ||
        !samePreparedContent(
          pickBefore?.preparedTuple,
          pickAfter?.preparedTuple,
        ) ||
        !(
          pickBefore?.preparedTuple?.selectionRevision >
          antipode?.onPreparedTuple?.selectionRevision
        ) ||
        !(
          pickAfter?.preparedTuple?.selectionRevision >
          pickBefore?.preparedTuple?.selectionRevision
        ) ||
        pick?.freshCohort?.stable !== true
  ) {
    failures.push(
      `${renderer}: real pickAsync route/postcondition is not exact`,
    );
  }

  const retained = phases["retained-capture"];
  if (renderer === "webgl") {
    if (retained?.applicability !== "N/A-WebGPU-only") {
      structural.push("webgl: retained capture must be explicit N/A");
    }
  } else if (
    retained?.applicability !== "required" ||
    retained?.managerDriven !== true ||
    retained?.directCaptureHelperCall !== false ||
    retained?.tinyLocalModel !== true ||
    retained?.faceCount !== 6 ||
    retained?.faceTileCardinalityExact !== true ||
    !(retained?.terrainDrawCount > 0) ||
    retained?.cameraRestored !== true ||
    retained?.preparedTuplePreserved !== true ||
    retained?.cameraUboInverseRadiiExact !== true ||
    retained?.eclipseBindingOffsetsExact !== true ||
    !Array.isArray(retained?.eclipseBindingPayloads) ||
    retained.eclipseBindingPayloads.length === 0 ||
    retained.eclipseBindingPayloads.some(
      (payload) => !exactNumericArray(payload, expectedPayload),
    ) ||
    retained?.eclipseBindingPayloadsExact !== true ||
    retained?.submittedWork !== true
  ) {
    failures.push("webgpu: retained manager capture proof is incomplete");
  }

  const control = phases["noneclipse-identity-control"];
  const controlImagesEqual = imageFingerprintEqual(
    imageFor("control-off"),
    imageFor("control-on"),
  );
  if (
    control?.clockIso !== C12_29_S5_CUSTOM_SCENE.controlIso ||
    control?.inactive !== true ||
    !samePreparedContent(
      control?.preparedTupleBefore,
      control?.offPreparedTuple,
    ) ||
    !samePreparedContent(control?.offPreparedTuple, control?.onPreparedTuple) ||
    control?.offPreparedTuple?.selectionRevision !==
      control?.preparedTupleBefore?.selectionRevision +
        (imageFor("control-off")?.temporalStability?.attemptedFrames ?? NaN) ||
    control?.onPreparedTuple?.selectionRevision !==
      control?.offPreparedTuple?.selectionRevision +
        (imageFor("control-on")?.temporalStability?.attemptedFrames ?? NaN) ||
    control?.offOnByteIdentical !== controlImagesEqual ||
    controlImagesEqual !== true
  ) {
    failures.push(`${renderer}: +24h identity control is red`);
  }
  const cleanupPhase = phases["session-cleanup"];
  if (
    !exactKeys(cleanupPhase, [
      "complete",
      "timersCleared",
      "cleanupFailures",
      "instrumentationRestorations",
      "instrumentationRestored",
      "defaultEllipsoidRestored",
    ]) ||
    cleanupPhase.complete !== true ||
    cleanupPhase.timersCleared !== true ||
    !Array.isArray(cleanupPhase.cleanupFailures) ||
    cleanupPhase.cleanupFailures.length !== 0 ||
    cleanupPhase.instrumentationRestored !== true ||
    !validInstrumentationRestorations(
      cleanupPhase.instrumentationRestorations,
      renderer,
      legacyV6,
    ) ||
    cleanupPhase.defaultEllipsoidRestored !== true ||
    session.cleanup?.complete !== true ||
    session.cleanup?.pageClosed !== true ||
    session.cleanup?.contextClosed !== true ||
    session.cleanup?.timersCleared !== true ||
    session.cleanup?.pendingRequests !== 0 ||
    session.cleanup?.pageCloseTimedOut !== false ||
    session.cleanup?.contextCloseTimedOut !== false
  ) {
    structural.push(`${renderer}: cleanup is incomplete`);
  }
}

function validateProvenance(provenance, structural, legacyV6 = false) {
  const sourceFiles = legacyV6
    ? C1229_S5_CUSTOM_V6_SOURCE_FILES
    : C12_29_S5_CUSTOM_SOURCE_FILES;
  if (
    !exactKeys(provenance, [
      "ok",
      "stable",
      "reasons",
      "gitHead",
      "sourceBoundary",
      "localFiles",
      "generatedShaders",
      "buildSourceIdentity",
      "servedEntryIdentity",
      ...(legacyV6 ? [] : ["servedHarnessIdentity"]),
      "xys",
      "sameTaskCapture",
      "harnessStable",
    ]) ||
    provenance?.ok !== true ||
    provenance?.stable !== true ||
    !Array.isArray(provenance?.reasons) ||
    provenance.reasons.length !== 0 ||
    !exactKeys(provenance?.gitHead, ["start", "end", "stable"]) ||
    !/^[0-9a-f]{40}$/u.test(provenance?.gitHead?.start ?? "") ||
    provenance.gitHead.end !== provenance.gitHead.start ||
    provenance.gitHead.stable !== true ||
    provenance?.sourceBoundary?.count !== sourceFiles.length ||
    !sameOrdered(provenance?.sourceBoundary?.files, sourceFiles) ||
    provenance?.sourceBoundary?.allReadable !== true
  ) {
    structural.push("exact start/end source provenance is absent");
  }
  if (
    !Array.isArray(provenance?.localFiles) ||
    provenance.localFiles.length !== sourceFiles.length ||
    provenance.localFiles.some(
      (entry, index) =>
        entry.file !== sourceFiles[index] ||
        !fingerprint(entry.start) ||
        !fingerprint(entry.end) ||
        entry.start.byteLength !== entry.end.byteLength ||
        entry.start.sha256 !== entry.end.sha256,
    )
  ) {
    structural.push(
      "local source start/end fingerprints changed or are missing",
    );
  }
  if (
    !exactKeys(provenance?.generatedShaders, ["start", "end", "stable"]) ||
    provenance.generatedShaders?.start?.globeFsExact !== true ||
    provenance.generatedShaders?.start?.globeTerrainExact !== true ||
    provenance.generatedShaders?.end?.globeFsExact !== true ||
    provenance.generatedShaders?.end?.globeTerrainExact !== true ||
    provenance.generatedShaders?.stable !== true
  ) {
    structural.push("raw/generated globe shader identity is not exact");
  }
  if (
    !exactKeys(provenance?.buildSourceIdentity, ["start", "end", "stable"]) ||
    !validBuildSourceIdentity(provenance?.buildSourceIdentity?.start) ||
    !validBuildSourceIdentity(provenance?.buildSourceIdentity?.end) ||
    provenance.buildSourceIdentity?.stable !== true ||
    provenance.buildSourceIdentity?.start?.sourceMapSha256 !==
      provenance.buildSourceIdentity?.end?.sourceMapSha256
  ) {
    structural.push("build source-map identity is incomplete");
  }
  if (
    !exactKeys(provenance?.servedEntryIdentity, [
      "ok",
      "reasons",
      "expectedLabels",
      "observedLabels",
      "localStart",
      "localEnd",
      "stable",
    ]) ||
    provenance.servedEntryIdentity.ok !== true ||
    !Array.isArray(provenance.servedEntryIdentity.reasons) ||
    provenance.servedEntryIdentity.reasons.length !== 0 ||
    !sameOrdered(
      provenance.servedEntryIdentity.expectedLabels,
      C12_29_S5_CUSTOM_RENDERERS,
    ) ||
    !sameOrdered(
      provenance.servedEntryIdentity.observedLabels,
      C12_29_S5_CUSTOM_RENDERERS,
    ) ||
    !fingerprint(provenance.servedEntryIdentity.localStart) ||
    !fingerprint(provenance.servedEntryIdentity.localEnd) ||
    provenance.servedEntryIdentity.localStart.byteLength !==
      provenance.servedEntryIdentity.localEnd.byteLength ||
    provenance.servedEntryIdentity.localStart.sha256 !==
      provenance.servedEntryIdentity.localEnd.sha256 ||
    provenance.servedEntryIdentity.stable !== true
  ) {
    structural.push(
      "served entry identity is not exact against stable start/end bytes",
    );
  }
  if (!legacyV6) {
    const harnessFile =
      "Tools/visual-regression/c12-29-s5-custom-ellipsoid-harness.html";
    const harnessRoute = `/${harnessFile}`;
    const identity = provenance?.servedHarnessIdentity;
    const localHarness = provenance?.localFiles?.find(
      (entry) => entry?.file === harnessFile,
    );
    const served = identity?.served;
    if (
      !exactKeys(identity, [
        "ok",
        "reasons",
        "expectedLabels",
        "observedLabels",
        "route",
        "served",
        "localStart",
        "localEnd",
        "stable",
      ]) ||
      identity.ok !== true ||
      !Array.isArray(identity.reasons) ||
      identity.reasons.length !== 0 ||
      !sameOrdered(identity.expectedLabels, C12_29_S5_CUSTOM_RENDERERS) ||
      !sameOrdered(identity.observedLabels, C12_29_S5_CUSTOM_RENDERERS) ||
      identity.route !== harnessRoute ||
      !fingerprint(identity.localStart) ||
      !fingerprint(identity.localEnd) ||
      identity.localStart.byteLength !== identity.localEnd.byteLength ||
      identity.localStart.sha256 !== identity.localEnd.sha256 ||
      identity.localStart.byteLength !== localHarness?.start?.byteLength ||
      identity.localStart.sha256 !== localHarness?.start?.sha256 ||
      identity.localEnd.byteLength !== localHarness?.end?.byteLength ||
      identity.localEnd.sha256 !== localHarness?.end?.sha256 ||
      !Array.isArray(served) ||
      served.length !== C12_29_S5_CUSTOM_RENDERERS.length ||
      served.some(
        (entry, index) =>
          !exactKeys(entry, [
            "renderer",
            "route",
            "ok",
            "status",
            "byteLength",
            "sha256",
          ]) ||
          entry.renderer !== C12_29_S5_CUSTOM_RENDERERS[index] ||
          entry.route !== harnessRoute ||
          entry.ok !== true ||
          entry.status !== 200 ||
          entry.byteLength !== identity.localStart.byteLength ||
          entry.sha256 !== identity.localStart.sha256,
      ) ||
      identity.stable !== true
    ) {
      structural.push(
        "served owned harness bytes are not exact against the stable local harness",
      );
    }
  }
  if (
    !Array.isArray(provenance?.xys) ||
    provenance.xys.length < 1 ||
    C12_29_S5_CUSTOM_RENDERERS.some(
      (renderer) =>
        !provenance.xys.some((entry) => entry?.renderer === renderer),
    ) ||
    new Set(provenance.xys.map((entry) => `${entry?.renderer}/${entry?.file}`))
      .size !== provenance.xys.length ||
    (!legacyV6 &&
      new Set(
        provenance.xys.map(
          (entry) => `${entry?.renderer}/${entry?.requestOrdinal}`,
        ),
      ).size !== provenance.xys.length) ||
    provenance.xys.some(
      (entry) =>
        !exactKeys(
          entry,
          legacyV6
            ? ["renderer", "file", "localStart", "localEnd", "served"]
            : [
                "renderer",
                "epochId",
                "requestOrdinal",
                "file",
                "localStart",
                "localEnd",
                "served",
              ],
        ) ||
        !C12_29_S5_CUSTOM_RENDERERS.includes(entry?.renderer) ||
        (!legacyV6 &&
          (!isC1229S5CustomUuidV4(entry?.epochId) ||
            !Number.isInteger(entry?.requestOrdinal) ||
            entry.requestOrdinal < 1)) ||
        !/^IAU2006_XYS_\d+\.json$/u.test(entry?.file ?? "") ||
        !fingerprint(entry.localStart) ||
        !fingerprint(entry.localEnd) ||
        !fingerprint(entry.served) ||
        entry.localStart.sha256 !== entry.localEnd.sha256 ||
        entry.localStart.sha256 !== entry.served.sha256 ||
        entry.localStart.byteLength !== entry.localEnd.byteLength ||
        entry.localStart.byteLength !== entry.served.byteLength,
    )
  ) {
    structural.push(
      "owned-epoch XYS responses are duplicate, out of epoch, or not exact local bytes",
    );
  }
  const helperFile = "Tools/visual-regression/lib/same-task-capture.mjs";
  const localHelper = provenance?.localFiles?.find(
    (entry) => entry?.file === helperFile,
  );
  if (
    !exactKeys(provenance?.sameTaskCapture, [
      "canonical",
      "usageExact",
      "helperPinned",
      "helperIdentity",
    ]) ||
    provenance.sameTaskCapture?.canonical !== true ||
    provenance.sameTaskCapture?.usageExact !== true ||
    provenance.sameTaskCapture?.helperPinned !== true ||
    provenance.sameTaskCapture?.helperIdentity?.file !== helperFile ||
    !fingerprint(provenance.sameTaskCapture?.helperIdentity?.start) ||
    !fingerprint(provenance.sameTaskCapture?.helperIdentity?.end) ||
    provenance.sameTaskCapture.helperIdentity.start.sha256 !==
      provenance.sameTaskCapture.helperIdentity.end.sha256 ||
    provenance.sameTaskCapture.helperIdentity.start.sha256 !==
      localHelper?.start?.sha256 ||
    provenance?.harnessStable !== true
  ) {
    structural.push("capture/helper/harness provenance is not pinned");
  }
}

function foldC1229S5CustomEllipsoidGateVersion(report, legacyV6 = false) {
  const structuralReasons = [];
  const failureReasons = [];
  const expectedSchema = legacyV6
    ? C1229_S5_CUSTOM_V6_SCHEMA
    : C12_29_S5_CUSTOM_SCHEMA;
  const sourceFiles = legacyV6
    ? C1229_S5_CUSTOM_V6_SOURCE_FILES
    : C12_29_S5_CUSTOM_SOURCE_FILES;
  if (
    report?.schema !== expectedSchema ||
    !isC1229S5CustomUuidV4(report?.runId) ||
    report?.aggregation !== C12_29_S5_CUSTOM_AGGREGATION ||
    report?.incomplete !== false
  ) {
    structuralReasons.push("top-level schema/run/aggregation is invalid");
  }
  if (
    !exactKeys(report?.contract, [
      "eventIso",
      "controlIso",
      "radii",
      "heightMeters",
      "cameraHeightMeters",
      "terrainDimensions",
      "phaseOrder",
      "captureLabels",
      "temporalStability",
      "cameraUboIndices",
      "eclipseBinding",
      "radiusLaw",
      "tileInteriorPixelFootprintRadius",
      "geometryEpsilonMeters",
      "geometryOperationBudgets",
    ]) ||
    report.contract.eventIso !== C12_29_S5_CUSTOM_SCENE.eventIso ||
    report.contract.controlIso !== C12_29_S5_CUSTOM_SCENE.controlIso ||
    report.contract.radii?.x !== C12_29_S5_CUSTOM_SCENE.radii.x ||
    report.contract.radii?.y !== C12_29_S5_CUSTOM_SCENE.radii.y ||
    report.contract.radii?.z !== C12_29_S5_CUSTOM_SCENE.radii.z ||
    report.contract.heightMeters !== C12_29_S5_CUSTOM_SCENE.heightMeters ||
    report.contract.cameraHeightMeters !==
      C12_29_S5_CUSTOM_SCENE.cameraHeightMeters ||
    report.contract.terrainDimensions?.width !==
      C12_29_S5_CUSTOM_SCENE.terrainWidth ||
    report.contract.terrainDimensions?.height !==
      C12_29_S5_CUSTOM_SCENE.terrainHeight ||
    !sameOrdered(report.contract.phaseOrder, C12_29_S5_CUSTOM_PHASES) ||
    !sameOrdered(
      report.contract.captureLabels,
      C12_29_S5_CUSTOM_CAPTURE_LABELS,
    ) ||
    !exactKeys(report.contract.temporalStability, [
      "method",
      "minimumConsecutiveFrames",
      "maximumFrames",
    ]) ||
    report.contract.temporalStability?.method !==
      C12_29_S5_CUSTOM_STABILITY_METHOD ||
    report.contract.temporalStability?.minimumConsecutiveFrames !==
      C12_29_S5_CUSTOM_SCENE.minimumStableFrames ||
    report.contract.temporalStability?.maximumFrames !==
      C12_29_S5_CUSTOM_SCENE.maximumStabilityFrames ||
    report.contract.cameraUboIndices?.inverseRadiiX !==
      C12_29_S5_CUSTOM_WEBGPU_CAMERA_INDICES.inverseRadiiX ||
    report.contract.cameraUboIndices?.inverseRadiiY !==
      C12_29_S5_CUSTOM_WEBGPU_CAMERA_INDICES.inverseRadiiY ||
    report.contract.cameraUboIndices?.inverseRadiiZ !==
      C12_29_S5_CUSTOM_WEBGPU_CAMERA_INDICES.inverseRadiiZ ||
    report.contract.cameraUboIndices?.maximumRadius !==
      C12_29_S5_CUSTOM_WEBGPU_CAMERA_INDICES.maximumRadius ||
    report.contract.eclipseBinding !==
      C12_29_S5_CUSTOM_WEBGPU_ECLIPSE_BINDING ||
    report.contract.radiusLaw?.fillSkirtAllowanceMeters !==
      C12_29_S5_CUSTOM_RADIUS_LAW.fillSkirtAllowanceMeters ||
    report.contract.radiusLaw?.absoluteSafetyMeters !==
      C12_29_S5_CUSTOM_RADIUS_LAW.absoluteSafetyMeters ||
    report.contract.radiusLaw?.relativeSafety !==
      C12_29_S5_CUSTOM_RADIUS_LAW.relativeSafety ||
    report.contract.tileInteriorPixelFootprintRadius !==
      C12_29_S5_CUSTOM_SCENE.tileInteriorPixelFootprintRadius ||
    report.contract.geometryEpsilonMeters !==
      C12_29_S5_CUSTOM_GEOMETRY_EPSILON_METERS ||
    stableC1229S5CustomJson(report.contract.geometryOperationBudgets) !==
      stableC1229S5CustomJson(C12_29_S5_CUSTOM_GEOMETRY_OPERATION_BUDGETS)
  ) {
    structuralReasons.push("frozen custom-ellipsoid contract is missing");
  }
  validateProvenance(report?.provenance, structuralReasons, legacyV6);
  const sessions = report?.sessions;
  if (
    !Array.isArray(sessions) ||
    sessions.length !== C12_29_S5_CUSTOM_RENDERERS.length ||
    !sameOrdered(
      sessions.map((session) => session?.renderer),
      C12_29_S5_CUSTOM_RENDERERS,
    )
  ) {
    structuralReasons.push("sessions are not exact WebGL then WebGPU order");
  } else {
    for (const session of sessions) {
      validateSession(
        session,
        report.runId,
        structuralReasons,
        failureReasons,
        legacyV6,
      );
    }
    if (
      !legacyV6 &&
      sessions.some((session) => {
        const epoch = session.transport?.measurementEpoch;
        const entries = report?.provenance?.xys?.filter(
          (entry) => entry?.renderer === session.renderer,
        );
        return (
          !Array.isArray(entries) ||
          entries.length < 1 ||
          entries.some(
            (entry) =>
              entry.epochId !== epoch?.id ||
              entry.requestOrdinal > (epoch?.lastResponseOrdinal ?? -1),
          )
        );
      })
    ) {
      structuralReasons.push(
        "renderer XYS proof is not bound to its owned measurement epoch",
      );
    }
  }
  const cross = report?.crossBackendOracle;
  const leftSamples = Array.isArray(sessions?.[0]?.oracleSamples)
    ? sessions[0].oracleSamples
    : [];
  const rightSamples = Array.isArray(sessions?.[1]?.oracleSamples)
    ? sessions[1].oracleSamples
    : [];
  const leftIds = leftSamples.map((sample) => sample?.id);
  const rightIds = rightSamples.map((sample) => sample?.id);
  const crossSamples = Array.isArray(cross?.samples) ? cross.samples : [];
  const crossKeys = [
    "id",
    "classification",
    "webglObservedFactor",
    "webgpuObservedFactor",
    "maximumF32Error",
    "quantizationBound",
    "tolerance",
    "absoluteDifference",
    "withinTolerance",
  ];
  const derivedCrossValid =
    leftSamples.length === 9 &&
    rightSamples.length === 9 &&
    sameOrdered(leftIds, rightIds) &&
    crossSamples.length === 9 &&
    sameOrdered(
      crossSamples.map((sample) => sample?.id),
      leftIds,
    ) &&
    crossSamples.every((sample, index) => {
      const left = leftSamples[index];
      const right = rightSamples[index];
      const derived = deriveC1229S5CustomCrossBackend(left, right);
      return (
        exactKeys(sample, crossKeys) &&
        sample.id === left.id &&
        sample.classification === left.classification &&
        right.classification === left.classification &&
        exactNumber(sample.webglObservedFactor, left.observedFactor) &&
        exactNumber(sample.webgpuObservedFactor, right.observedFactor) &&
        exactNumber(sample.maximumF32Error, derived?.maximumF32Error) &&
        exactNumber(sample.quantizationBound, derived?.quantizationBound) &&
        exactNumber(sample.tolerance, derived?.tolerance) &&
        exactNumber(sample.absoluteDifference, derived?.absoluteDifference) &&
        sample.withinTolerance === derived?.withinTolerance &&
        sample.withinTolerance === true &&
        sample.maximumF32Error >= 0 &&
        sample.quantizationBound >= 0 &&
        sample.tolerance >= 0 &&
        sample.absoluteDifference >= 0
      );
    });
  if (
    !exactKeys(cross, [
      "aggregation",
      "matchedSampleCount",
      "allWithinDerivedTolerance",
      "samples",
    ]) ||
    cross.aggregation !== C12_29_S5_CUSTOM_AGGREGATION ||
    cross.matchedSampleCount !== 9 ||
    cross.allWithinDerivedTolerance !==
      crossSamples.every((sample) => sample?.withinTolerance === true) ||
    cross.allWithinDerivedTolerance !== true ||
    !derivedCrossValid
  ) {
    failureReasons.push("cross-backend derived oracle comparison is red");
  }
  const allImages = Array.isArray(sessions)
    ? sessions.flatMap((session) => session?.images ?? [])
    : [];
  if (
    new Set(allImages.map((image) => image?.imageId)).size !==
      allImages.length ||
    new Set(allImages.map((image) => image?.fileName)).size !==
      allImages.length ||
    new Set(allImages.map((image) => image?.renderTaskToken)).size !==
      allImages.length
  ) {
    structuralReasons.push(
      "PNG UUID/file/task identities are not globally unique",
    );
  }
  if (
    report?.cleanup?.complete !== true ||
    report?.cleanup?.browserClosed !== true ||
    report?.cleanup?.contextsClosed !== true ||
    report?.cleanup?.timersCleared !== true ||
    report?.cleanup?.pendingRequests !== 0
  ) {
    structuralReasons.push("browser/session cleanup is incomplete");
  }
  const status =
    structuralReasons.length > 0
      ? "STRUCTURAL"
      : failureReasons.length > 0
        ? "FAIL"
        : "PASS";
  return {
    status,
    exitCode: exitCodeForC1229S5CustomStatus(status),
    structuralReasons,
    failureReasons,
    checks: {
      sourceBoundaryCount: sourceFiles.length,
      buildSourceBoundaryCount: C12_29_S5_CUSTOM_BUILD_SOURCE_FILES.length,
      rendererCount: Array.isArray(sessions) ? sessions.length : 0,
      phaseCountPerRenderer: C12_29_S5_CUSTOM_PHASES.length,
      captureCountPerRenderer: C12_29_S5_CUSTOM_CAPTURE_LABELS.length,
    },
  };
}

export function foldC1229S5CustomEllipsoidGate(report) {
  return foldC1229S5CustomEllipsoidGateVersion(report, false);
}

export function foldC1229S5CustomV6EllipsoidGate(report) {
  return foldC1229S5CustomEllipsoidGateVersion(report, true);
}

function validateC1229S5CustomFinalArtifactVersion(artifact, legacyV6 = false) {
  const reasons = [];
  try {
    const canonicalBytes = stableC1229S5CustomJson(artifact, 2);
    artifact = JSON.parse(canonicalBytes);
    if (stableC1229S5CustomJson(artifact, 2) !== canonicalBytes) {
      reasons.push("final artifact canonical roundtrip is unstable");
      return { ok: false, reasons };
    }
  } catch (error) {
    reasons.push(
      `final artifact is not canonical JSON-safe data: ${error.message}`,
    );
    return { ok: false, reasons };
  }
  if (
    artifact?.schema !==
    (legacyV6 ? C1229_S5_CUSTOM_V6_SCHEMA : C12_29_S5_CUSTOM_SCHEMA)
  ) {
    reasons.push("final schema is invalid");
  }
  if (!isC1229S5CustomUuidV4(artifact?.runId)) {
    reasons.push("final runId is invalid");
  }
  if (!FINAL_STATUSES.has(artifact?.status)) {
    reasons.push("status is not final");
  }
  if (artifact?.incomplete !== false) {
    reasons.push("final artifact is incomplete");
  }
  try {
    if (
      artifact?.exitCode !== exitCodeForC1229S5CustomStatus(artifact?.status)
    ) {
      reasons.push("exit code disagrees with final status");
    }
  } catch (error) {
    reasons.push(error.message);
  }
  if (artifact?.artifactName !== `${artifact?.runId}.json`) {
    reasons.push("immutable artifact name is not runId.json");
  }
  if (artifact?.status === "ERROR") {
    if (
      !exactKeys(artifact, [
        "schema",
        "runId",
        "status",
        "incomplete",
        "exitCode",
        "artifactName",
        "error",
        "diagnostics",
      ])
    ) {
      reasons.push("ERROR artifact top-level keys are not exact");
    }
    if (
      !(legacyV6
        ? validCustomErrorDiagnosticsForSchema(
            artifact?.diagnostics,
            C1229_S5_CUSTOM_V6_DIAGNOSTICS_SCHEMA,
          )
        : validCustomErrorDiagnostics(artifact?.diagnostics)) ||
      typeof artifact?.error !== "string" ||
      artifact.error.length === 0 ||
      artifact.error.length > 65_536
    ) {
      reasons.push("ERROR diagnostics are incomplete");
    }
  } else {
    if (
      !exactKeys(artifact, [
        "schema",
        "runId",
        "aggregation",
        "incomplete",
        "artifactName",
        "contract",
        "provenance",
        "sessions",
        "crossBackendOracle",
        "cleanup",
        "status",
        "exitCode",
        "reasons",
        "checks",
      ])
    ) {
      reasons.push("final artifact top-level keys are not exact");
    }
    const folded = foldC1229S5CustomEllipsoidGateVersion(artifact, legacyV6);
    if (
      artifact.status !== folded.status ||
      artifact.exitCode !== folded.exitCode ||
      !sameOrdered(artifact?.reasons?.structural, folded.structuralReasons) ||
      !sameOrdered(artifact?.reasons?.failures, folded.failureReasons) ||
      stableC1229S5CustomJson(artifact?.checks) !==
        stableC1229S5CustomJson(folded.checks)
    ) {
      reasons.push("final verdict is not the pure fold result");
    }
  }
  return { ok: reasons.length === 0, reasons };
}

export function validateC1229S5CustomFinalArtifact(artifact) {
  return validateC1229S5CustomFinalArtifactVersion(artifact, false);
}

export function validateC1229S5CustomV6FinalArtifact(artifact) {
  return validateC1229S5CustomFinalArtifactVersion(artifact, true);
}

export default {
  C12_29_S5_CUSTOM_SCHEMA,
  C12_29_S5_CUSTOM_EPHEMERIS,
  C12_29_S5_CUSTOM_PHASES,
  C12_29_S5_CUSTOM_SOURCE_FILES,
  computeC1229S5CustomSurfaceRadius,
  customEllipsoidGeodeticToEcef,
  packC1229S5CustomCommonRay,
  evaluateC1229S5CustomFragment,
  deriveC1229S5CustomOracleSample,
  deriveC1229S5CustomSampleId,
  deriveC1229S5CustomCrossBackend,
  validateC1229S5CustomEphemerisLineage,
  foldC1229S5CustomEllipsoidGate,
  validateC1229S5CustomFinalArtifact,
  validateC1229S5CustomV6FinalArtifact,
};
