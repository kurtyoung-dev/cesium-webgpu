/**
 * Fail-closed acceptance policy for C12-29 S5 replacement-device recovery.
 *
 * The browser probe owns the genuine Chromium GPU-process termination and the
 * runtime observations.  This module is deliberately browser- and filesystem-
 * free: it freezes the claim, validates every evidence ledger, and separates
 * an ineligible/structurally-invalid experiment from an engaged product
 * failure.
 */

export const C12_29_S5_REPLACEMENT_SCHEMA =
  "c12-29-s5-replacement-device-evidence-v5";
export const C12_29_S5_REPLACEMENT_NATIVE_LEDGER_SCHEMA =
  "c12-29-s5-replacement-device-native-resource-ledger-v5";
export const C12_29_S5_REPLACEMENT_PAGE_PROGRESS_SCHEMA =
  "c12-29-s5-replacement-device-page-progress-v5";
export const C12_29_S5_REPLACEMENT_RUNTIME_DIAGNOSTICS_SCHEMA =
  "c12-29-s5-replacement-device-runtime-diagnostics-v5";
export const C12_29_S5_REPLACEMENT_PROVENANCE_SCHEMA =
  "c12-29-s5-replacement-device-provenance-v5";

export const C12_29_S5_REPLACEMENT_PHASES = Object.freeze([
  "control.before",
  "control.after_gap",
  "webgpu.eligibility_before_loss",
  "webgpu.before_loss",
  "webgpu.loss_retirement",
  "webgpu.replacement_healthy",
  "webgpu.replacement_render",
  "webgpu.replacement_pick",
  "webgpu.replacement_capture_cleanup",
]);

export const C12_29_S5_REPLACEMENT_CONTROL_PHASES = Object.freeze(
  C12_29_S5_REPLACEMENT_PHASES.slice(0, 2),
);
export const C12_29_S5_REPLACEMENT_WEBGPU_PHASES = Object.freeze(
  C12_29_S5_REPLACEMENT_PHASES.slice(2),
);
export const C12_29_S5_REPLACEMENT_RENDERERS = Object.freeze([
  "webgl",
  "webgpu",
]);

export const C12_29_S5_REPLACEMENT_CONFIG = Object.freeze({
  eventIso: "2024-04-08T18:17:16Z",
  viewport: Object.freeze({ width: 960, height: 960 }),
  terrainWidth: 9,
  terrainHeight: 9,
  terrainMeters: 250,
  maximumScreenSpaceError: 2,
  cameraHeightMeters: 8_000_000,
  cameraFovDegrees: 55,
  controlGapFrames: 12,
  maximumSettleFrames: 300,
  maximumRecoveryMs: 120_000,
  maximumPickFrames: 60,
  maximumCaptureFrames: 300,
  sampleWidth: 16,
  sampleHeight: 16,
  minimumNonBlackSamplePixels: 32,
  controlMaximumMeanAbsoluteDelta: 4,
  controlMaximumChangedPixelShare: 0.05,
  replacementMaximumMeanAbsoluteDelta: 12,
  replacementMaximumChangedPixelShare: 0.2,
  pageTimeoutMs: 300_000,
  watchdogMs: 600_000,
  eclipseBinding: 2,
  eclipseBytes: 64,
  eclipseFloats: 16,
  captureSubmittedCode: 2,
  triggerObject: "chrome.gpuBenchmarking",
  triggerMethod: "terminateGpuProcessNormally",
  launchFlag: "--enable-gpu-benchmarking",
  recoveryIntervalBeginMarker:
    "[C12-29 replacement] recovery-console interval begin",
  recoveryIntervalEndMarker:
    "[C12-29 replacement] recovery-console interval end",
  tinyModelRoute:
    "/Specs/Data/Models/glTF-2.0/BoxTextured/glTF-Binary/BoxTextured.glb",
  outputNamespace:
    "Tools/visual-regression/output/c12-29-s5-replacement-device-v5",
});

export const C12_29_S5_REPLACEMENT_SOURCE_FILES = Object.freeze([
  "packages/engine/Source/Core/CustomHeightmapTerrainProvider.js",
  "packages/engine/Source/Core/HeightmapTerrainData.js",
  "packages/engine/Source/Core/HeightmapTessellator.js",
  "packages/engine/Source/Scene/DynamicEnvironmentMapManager.js",
  "packages/engine/Source/Scene/EclipseGlobeShadow.js",
  "packages/engine/Source/Scene/EclipseState.js",
  "packages/engine/Source/Scene/FrameState.js",
  "packages/engine/Source/Scene/Globe.js",
  "packages/engine/Source/Scene/GlobeSurfaceTileProvider.js",
  "packages/engine/Source/Scene/GlobeSurfaceTileProviderRendering.js",
  "packages/engine/Source/Scene/Picking.js",
  "packages/engine/Source/Scene/Scene.js",
  "packages/engine/Source/Scene/View.js",
  "packages/engine/Source/Renderer/WebGPU/WebGPUContext.ts",
  "packages/engine/Source/Renderer/WebGPU/WebGPUContextDeviceLoss.ts",
  "packages/engine/Source/Renderer/WebGPU/WebGPUDeviceInvalidationBus.ts",
  "packages/engine/Source/Renderer/WebGPU/WebGPUDeviceLossRecovery.ts",
  "packages/engine/Source/Renderer/WebGPU/WebGPUDevicePool.ts",
  "packages/engine/Source/Renderer/WebGPU/WebGPUDynamicEnvironmentMapCapture.ts",
  "packages/engine/Source/Renderer/WebGPU/WebGPUDynamicEnvironmentMapManager.ts",
  "packages/engine/Source/Renderer/WebGPU/WebGPUGlobeEclipseUniforms.ts",
  "packages/engine/Source/Renderer/WebGPU/WebGPUGlobeSurfaceLayouts.ts",
  "packages/engine/Source/Renderer/WebGPU/WebGPUGlobeSurfaceRenderer.ts",
  "packages/engine/Source/Renderer/WebGPU/WebGPURingBufferAllocator.ts",
  "packages/engine/Source/Renderer/WebGPU/WebGPUSceneRenderer.ts",
  "packages/engine/Source/Shaders/GlobeFS.js",
  "packages/engine/Source/Shaders/WebGPU/Globe/GlobeTerrain.js",
]);

export const C12_29_S5_REPLACEMENT_LOCAL_FILES = Object.freeze([
  "Tools/visual-regression/lib/c12-29-s5-replacement-device-gate.mjs",
  "Tools/visual-regression/c12-29-s5-replacement-device-gate.spec.mjs",
  "Tools/visual-regression/probe-c12-29-s5-replacement-device.mjs",
  "Tools/visual-regression/lib/build-source-identity.mjs",
  "Tools/lib/webgpu-error-gate.mjs",
  ...C12_29_S5_REPLACEMENT_SOURCE_FILES,
  "Apps/CesiumViewer/index.html",
  "Apps/CesiumViewer/CesiumViewer.js",
  "Build/CesiumUnminified/index.js",
  "Build/CesiumUnminified/index.js.map",
  "package.json",
  "package-lock.json",
  "node_modules/playwright/package.json",
]);

export const C12_29_S5_REPLACEMENT_SERVED_FILES = Object.freeze([
  "Apps/CesiumViewer/index.html",
  "Apps/CesiumViewer/CesiumViewer.js",
  "Build/CesiumUnminified/index.js",
]);

export const C12_29_S5_REPLACEMENT_CONTRACT = Object.freeze({
  claim:
    "same Scene/context/canvas/GPUCanvasContext/View recovers from one genuine non-destroyed Chromium GPU-process termination onto a fresh adapter/device generation while retiring and never reusing the witnessed D0 S5 binding-2 carrier; D1 then renders terrain/S5, picks, and submits retained capture",
  scope:
    "one Chromium process, one WebGL no-loss gap control, one WebGPU same-owner D0-to-D1 recovery; witnessed S5 group-0 binding-2 native resources only",
  phases: C12_29_S5_REPLACEMENT_PHASES,
  schemas: Object.freeze({
    evidence: C12_29_S5_REPLACEMENT_SCHEMA,
    nativeLedger: C12_29_S5_REPLACEMENT_NATIVE_LEDGER_SCHEMA,
    pageProgress: C12_29_S5_REPLACEMENT_PAGE_PROGRESS_SCHEMA,
    runtimeDiagnostics: C12_29_S5_REPLACEMENT_RUNTIME_DIAGNOSTICS_SCHEMA,
    provenance: C12_29_S5_REPLACEMENT_PROVENANCE_SCHEMA,
  }),
  trigger: Object.freeze({
    launchFlag: C12_29_S5_REPLACEMENT_CONFIG.launchFlag,
    object: C12_29_S5_REPLACEMENT_CONFIG.triggerObject,
    method: C12_29_S5_REPLACEMENT_CONFIG.triggerMethod,
    requiredInvocations: 1,
    forbidden: Object.freeze([
      "GPUDevice.destroy",
      "chrome.gpuBenchmarking.crashGpuProcess",
      "chrome.gpuBenchmarking.crashGpuProcessForTesting",
    ]),
    destroyedReasonIsReplacementEvidence: false,
  }),
  binding: Object.freeze({
    group: 0,
    binding: C12_29_S5_REPLACEMENT_CONFIG.eclipseBinding,
    byteLength: C12_29_S5_REPLACEMENT_CONFIG.eclipseBytes,
    floatCount: C12_29_S5_REPLACEMENT_CONFIG.eclipseFloats,
    baseOffset: 0,
    dynamicOffsetOrdinal: 2,
  }),
});

const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SHA256 = /^[0-9a-f]{64}$/u;
const FINAL_STATUSES = new Set(["PASS", "FAIL", "STRUCTURAL", "ERROR"]);
const SESSION_RUNTIME_KEYS = Object.freeze([
  "schema",
  "renderer",
  "pageErrors",
  "consoleErrors",
  "expectedRecoveryConsole",
  "expectedPoolRecoveryConsole",
  "recoveryConsoleInterval",
  "gpuErrors",
  "unexpectedDeviceLoss",
  "externalRequests",
  "failedRequests",
  "httpErrors",
  "pendingRequests",
  "armedDevices",
]);
const PROGRESS_KEYS = Object.freeze([
  "schema",
  "renderer",
  "currentPhase",
  "completedPhases",
  "step",
  "elapsedMs",
]);
const CHECK_KEYS = Object.freeze([
  "phaseOrderExact",
  "provenanceStable",
  "controlGapHealthy",
  "genuineTrigger",
  "nonDestroyedLoss",
  "sameOwners",
  "generationAdvanced",
  "invalidationOrdered",
  "oldCarrierRetired",
  "replacementCarrierExact",
  "nativeErrorsArmedEarly",
  "terrainCpuContinuous",
  "replacementRenderHealthy",
  "replacementPickHealthy",
  "replacementCaptureSubmitted",
  "runtimeClean",
  "cleanupComplete",
]);
const RECOVERY_CONSOLE_INTERVAL_KEYS = Object.freeze([
  "beginCount",
  "endCount",
  "openAtEnd",
]);

function plain(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function properArray(value) {
  return (
    Array.isArray(value) && Object.getPrototypeOf(value) === Array.prototype
  );
}

function exactKeys(value, keys) {
  if (!plain(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === expected[index])
  );
}

/**
 * Copy evidence without invoking accessors, `toJSON`, iterators, or symbol
 * hooks.  Validation and publication both operate on this same plain snapshot,
 * so the bytes written after a green validation cannot describe a different
 * value from the one that was validated.
 */
export function materializeC1229S5ReplacementEvidence(value) {
  const active = new WeakSet();
  let nodes = 0;
  const copy = (entry, depth) => {
    if (depth > 128 || ++nodes > 200_000) {
      throw new TypeError(
        "replacement-device evidence exceeds materialization bounds",
      );
    }
    if (
      entry === null ||
      typeof entry === "string" ||
      typeof entry === "boolean"
    ) {
      return entry;
    }
    if (typeof entry === "number") {
      if (!Number.isFinite(entry)) {
        throw new TypeError(
          "replacement-device evidence contains a non-finite number",
        );
      }
      return Object.is(entry, -0) ? 0 : entry;
    }
    if (typeof entry !== "object") {
      throw new TypeError(
        `replacement-device evidence contains unsupported ${typeof entry}`,
      );
    }
    if (active.has(entry)) {
      throw new TypeError("cyclic replacement-device evidence");
    }
    active.add(entry);
    try {
      const prototype = Object.getPrototypeOf(entry);
      const descriptors = Object.getOwnPropertyDescriptors(entry);
      const keys = Reflect.ownKeys(descriptors);
      if (Array.isArray(entry)) {
        if (prototype !== Array.prototype) {
          throw new TypeError(
            "replacement-device evidence array prototype is invalid",
          );
        }
        const length = descriptors.length?.value;
        if (!Number.isSafeInteger(length) || length < 0) {
          throw new TypeError(
            "replacement-device evidence array length is invalid",
          );
        }
        if (
          keys.some(
            (key) =>
              typeof key !== "string" ||
              (key !== "length" && !/^(?:0|[1-9][0-9]*)$/u.test(key)),
          )
        ) {
          throw new TypeError(
            "replacement-device evidence array has extra keys",
          );
        }
        const result = new Array(length);
        for (let index = 0; index < length; index++) {
          const descriptor = descriptors[String(index)];
          if (
            !descriptor ||
            descriptor.enumerable !== true ||
            !("value" in descriptor)
          ) {
            throw new TypeError(
              "replacement-device evidence arrays must be dense data properties",
            );
          }
          result[index] = copy(descriptor.value, depth + 1);
        }
        return result;
      }
      if (prototype !== Object.prototype && prototype !== null) {
        throw new TypeError(
          "replacement-device evidence object prototype is invalid",
        );
      }
      if (keys.some((key) => typeof key !== "string")) {
        throw new TypeError("replacement-device evidence contains symbol keys");
      }
      const result = Object.create(null);
      for (const key of /** @type {string[]} */ (keys).sort()) {
        const descriptor = descriptors[key];
        if (descriptor.enumerable !== true || !("value" in descriptor)) {
          throw new TypeError(
            "replacement-device evidence contains hidden or accessor properties",
          );
        }
        result[key] = copy(descriptor.value, depth + 1);
      }
      return result;
    } finally {
      active.delete(entry);
    }
  };
  return copy(value, 0);
}

function finite(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function nonnegativeInteger(value) {
  return Number.isInteger(value) && value >= 0;
}

function positiveInteger(value) {
  return Number.isInteger(value) && value > 0;
}

function boundedString(value, maximum = 2048) {
  return (
    typeof value === "string" && value.length > 0 && value.length <= maximum
  );
}

function stringArray(value, maximum = 64) {
  return (
    properArray(value) &&
    value.length <= maximum &&
    value.every((entry) => typeof entry === "string" && entry.length <= 2048)
  );
}

function exactArray(left, right) {
  return (
    properArray(left) &&
    left.length === right.length &&
    left.every((value, index) => Object.is(value, right[index]))
  );
}

function sameJson(left, right) {
  try {
    return (
      stableC1229S5ReplacementJson(left) === stableC1229S5ReplacementJson(right)
    );
  } catch {
    return false;
  }
}

function numericArray(value, length) {
  return (
    properArray(value) &&
    value.length === length &&
    value.every((entry) => finite(entry))
  );
}

function exactBooleanObject(value, keys) {
  return (
    exactKeys(value, keys) &&
    keys.every((key) => typeof value[key] === "boolean")
  );
}

function materializedForValidation(value, reasons, label) {
  try {
    return materializeC1229S5ReplacementEvidence(value);
  } catch (error) {
    reasons.push(
      `${label} is not descriptor-safe plain data: ${String(error?.message ?? error)}`,
    );
    return null;
  }
}

export function isC1229S5ReplacementUuidV4(value) {
  return typeof value === "string" && UUID_V4.test(value);
}

export function exitCodeForC1229S5ReplacementStatus(status) {
  return status === "PASS"
    ? 0
    : status === "FAIL"
      ? 1
      : status === "ERROR"
        ? 2
        : 3;
}

export function stableC1229S5ReplacementJson(value, space) {
  return JSON.stringify(
    materializeC1229S5ReplacementEvidence(value),
    null,
    space,
  );
}

function validFingerprint(value) {
  return (
    exactKeys(value, ["path", "byteLength", "sha256"]) &&
    boundedString(value.path, 1024) &&
    nonnegativeInteger(value.byteLength) &&
    typeof value.sha256 === "string" &&
    SHA256.test(value.sha256)
  );
}

function validServedFingerprint(value) {
  return (
    exactKeys(value, ["path", "url", "status", "byteLength", "sha256"]) &&
    boundedString(value.path, 1024) &&
    boundedString(value.url, 4096) &&
    value.status === 200 &&
    nonnegativeInteger(value.byteLength) &&
    typeof value.sha256 === "string" &&
    SHA256.test(value.sha256)
  );
}

function exactFingerprintSet(values, expectedPaths, served = false) {
  if (!properArray(values) || values.length !== expectedPaths.length)
    return false;
  const paths = values.map((entry) => entry?.path);
  return (
    exactArray(paths, expectedPaths) &&
    values.every(served ? validServedFingerprint : validFingerprint)
  );
}

function validBuildSourceEntry(value, expectedPath, localStart) {
  if (
    !exactKeys(value, [
      "path",
      "sourceMapEntry",
      "currentByteLength",
      "embeddedByteLength",
      "currentSha256",
      "embeddedSha256",
      "exact",
      "reason",
    ]) ||
    value.path !== expectedPath ||
    !(
      value.sourceMapEntry === null || boundedString(value.sourceMapEntry, 4096)
    ) ||
    !nonnegativeInteger(value.currentByteLength) ||
    !(
      value.embeddedByteLength === null ||
      nonnegativeInteger(value.embeddedByteLength)
    ) ||
    !(
      typeof value.currentSha256 === "string" &&
      SHA256.test(value.currentSha256)
    ) ||
    !(
      value.embeddedSha256 === null ||
      (typeof value.embeddedSha256 === "string" &&
        SHA256.test(value.embeddedSha256))
    ) ||
    typeof value.exact !== "boolean" ||
    !(value.reason === null || boundedString(value.reason, 2048))
  ) {
    return false;
  }
  const local = properArray(localStart)
    ? localStart.find((entry) => entry?.path === expectedPath)
    : undefined;
  const derivedExact = Boolean(
    value.sourceMapEntry !== null &&
    value.embeddedByteLength !== null &&
    value.embeddedSha256 !== null &&
    value.currentByteLength === value.embeddedByteLength &&
    value.currentSha256 === value.embeddedSha256,
  );
  return (
    local?.byteLength === value.currentByteLength &&
    local?.sha256 === value.currentSha256 &&
    value.exact === derivedExact &&
    (value.exact ? value.reason === null : value.reason !== null)
  );
}

export function validateC1229S5ReplacementProvenance(value) {
  const reasons = [];
  value = materializedForValidation(value, reasons, "provenance");
  const keys = [
    "schema",
    "gitHead",
    "localStart",
    "localEnd",
    "served",
    "buildSourceIdentity",
    "stable",
    "buildEntryMatchesServed",
    "servedMatchesLocal",
    "launch",
  ];
  if (!exactKeys(value, keys))
    reasons.push("provenance top-level shape is invalid");
  if (value?.schema !== C12_29_S5_REPLACEMENT_PROVENANCE_SCHEMA)
    reasons.push("provenance schema is invalid");
  if (!(
    value?.gitHead === null ||
    (typeof value?.gitHead === "string" &&
      /^[0-9a-f]{40}$/u.test(value.gitHead))
  ))
    reasons.push("provenance git head is invalid");
  if (
    !exactFingerprintSet(value?.localStart, C12_29_S5_REPLACEMENT_LOCAL_FILES)
  )
    reasons.push("provenance start file set is invalid");
  if (!exactFingerprintSet(value?.localEnd, C12_29_S5_REPLACEMENT_LOCAL_FILES))
    reasons.push("provenance end file set is invalid");
  if (
    !exactFingerprintSet(
      value?.served,
      C12_29_S5_REPLACEMENT_SERVED_FILES,
      true,
    )
  )
    reasons.push("provenance served file set is invalid");
  if (
    !exactKeys(value?.buildSourceIdentity, [
      "ok",
      "sourceMapByteLength",
      "sourceMapSha256",
      "entryCount",
      "entries",
      "reasons",
    ]) ||
    typeof value?.buildSourceIdentity?.ok !== "boolean" ||
    !nonnegativeInteger(value?.buildSourceIdentity?.sourceMapByteLength) ||
    !(
      typeof value?.buildSourceIdentity?.sourceMapSha256 === "string" &&
      SHA256.test(value.buildSourceIdentity.sourceMapSha256)
    ) ||
    value?.buildSourceIdentity?.entryCount !==
      C12_29_S5_REPLACEMENT_SOURCE_FILES.length ||
    !properArray(value?.buildSourceIdentity?.entries) ||
    value.buildSourceIdentity.entries.length !==
      C12_29_S5_REPLACEMENT_SOURCE_FILES.length ||
    !stringArray(value?.buildSourceIdentity?.reasons)
  )
    reasons.push("provenance build-source identity is invalid");
  if (
    properArray(value?.buildSourceIdentity?.entries) &&
    !value.buildSourceIdentity.entries.every((entry, index) =>
      validBuildSourceEntry(
        entry,
        C12_29_S5_REPLACEMENT_SOURCE_FILES[index],
        value?.localStart ?? [],
      ),
    )
  ) {
    reasons.push("provenance build-source entries do not recompute exactly");
  }
  const buildSourceOk =
    properArray(value?.buildSourceIdentity?.entries) &&
    value.buildSourceIdentity.entries.length ===
      C12_29_S5_REPLACEMENT_SOURCE_FILES.length &&
    value.buildSourceIdentity.entries.every((entry) => entry?.exact === true) &&
    value?.buildSourceIdentity?.reasons?.length === 0;
  if (
    typeof value?.buildSourceIdentity?.ok === "boolean" &&
    value.buildSourceIdentity.ok !== buildSourceOk
  ) {
    reasons.push(
      "provenance build-source result contradicts recomputed entries",
    );
  }
  if (
    !exactKeys(value?.launch, ["channel", "headless", "args"]) ||
    !boundedString(value?.launch?.channel, 128) ||
    typeof value?.launch?.headless !== "boolean" ||
    !exactArray(value?.launch?.args, [C12_29_S5_REPLACEMENT_CONFIG.launchFlag])
  )
    reasons.push("provenance browser launch identity is invalid");
  if (
    typeof value?.stable !== "boolean" ||
    typeof value?.buildEntryMatchesServed !== "boolean" ||
    typeof value?.servedMatchesLocal !== "boolean"
  )
    reasons.push("provenance result flags are invalid");
  const localBuildEntry = properArray(value?.localStart)
    ? value.localStart.find(
        (entry) => entry?.path === "Build/CesiumUnminified/index.js",
      )
    : undefined;
  const servedBuildEntry = properArray(value?.served)
    ? value.served.find(
        (entry) => entry?.path === "Build/CesiumUnminified/index.js",
      )
    : undefined;
  const buildEntryMatchesServed = Boolean(
    localBuildEntry &&
    servedBuildEntry &&
    localBuildEntry.byteLength === servedBuildEntry.byteLength &&
    localBuildEntry.sha256 === servedBuildEntry.sha256,
  );
  if (
    typeof value?.buildEntryMatchesServed === "boolean" &&
    value.buildEntryMatchesServed !== buildEntryMatchesServed
  ) {
    reasons.push("provenance served-build result contradicts its fingerprints");
  }
  const servedMatchesLocal =
    properArray(value?.localStart) &&
    properArray(value?.served) &&
    C12_29_S5_REPLACEMENT_SERVED_FILES.every((servedPath) => {
      const local = value.localStart.find(
        (entry) => entry?.path === servedPath,
      );
      const served = value.served.find((entry) => entry?.path === servedPath);
      return (
        local !== undefined &&
        served !== undefined &&
        local.byteLength === served.byteLength &&
        local.sha256 === served.sha256
      );
    });
  if (
    typeof value?.servedMatchesLocal === "boolean" &&
    value.servedMatchesLocal !== servedMatchesLocal
  ) {
    reasons.push("provenance served-file result contradicts its fingerprints");
  }
  const sourceMap = properArray(value?.localStart)
    ? value.localStart.find(
        (entry) => entry?.path === "Build/CesiumUnminified/index.js.map",
      )
    : undefined;
  if (
    sourceMap &&
    (value?.buildSourceIdentity?.sourceMapByteLength !== sourceMap.byteLength ||
      value?.buildSourceIdentity?.sourceMapSha256 !== sourceMap.sha256)
  ) {
    reasons.push(
      "provenance source-map summary contradicts local fingerprints",
    );
  }
  if (
    properArray(value?.localStart) &&
    properArray(value?.localEnd) &&
    !sameJson(value.localStart, value.localEnd)
  )
    reasons.push("provenance changed during the run");
  return { ok: reasons.length === 0, reasons };
}

export function validateC1229S5ReplacementPageProgress(value) {
  const reasons = [];
  value = materializedForValidation(value, reasons, "page progress");
  if (!exactKeys(value, PROGRESS_KEYS))
    reasons.push("page progress shape is invalid");
  if (value?.schema !== C12_29_S5_REPLACEMENT_PAGE_PROGRESS_SCHEMA)
    reasons.push("page progress schema is invalid");
  if (!C12_29_S5_REPLACEMENT_RENDERERS.includes(value?.renderer))
    reasons.push("page progress renderer is invalid");
  const allowed =
    value?.renderer === "webgl"
      ? C12_29_S5_REPLACEMENT_CONTROL_PHASES
      : C12_29_S5_REPLACEMENT_WEBGPU_PHASES;
  if (
    !properArray(value?.completedPhases) ||
    value.completedPhases.length > allowed.length
  )
    reasons.push("page progress completed phases are invalid");
  else if (
    !value.completedPhases.every((phase, index) => phase === allowed[index])
  )
    reasons.push("page progress phases are not an exact prefix");
  if (!(
    allowed.includes(value?.currentPhase) || value?.currentPhase === "preflight"
  ))
    reasons.push("page progress current phase is invalid");
  if (
    !boundedString(value?.step, 256) ||
    !finite(value?.elapsedMs) ||
    value.elapsedMs < 0
  )
    reasons.push("page progress step/elapsed state is invalid");
  if (properArray(value?.completedPhases)) {
    const phaseIndex = allowed.indexOf(value?.currentPhase);
    const expectedLength =
      value?.currentPhase === "preflight"
        ? 0
        : phaseIndex + (value?.step === "complete" ? 1 : 0);
    if (
      phaseIndex < -1 ||
      value.completedPhases.length !== expectedLength ||
      (value.currentPhase === "preflight" && value.step === "complete")
    ) {
      reasons.push("page progress phase and completion state disagree");
    }
  }
  return { ok: reasons.length === 0, reasons };
}

export function validateC1229S5ReplacementRuntimeDiagnostics(value, renderer) {
  const reasons = [];
  value = materializedForValidation(value, reasons, "runtime diagnostics");
  if (!exactKeys(value, SESSION_RUNTIME_KEYS))
    reasons.push("runtime diagnostics shape is invalid");
  if (value?.schema !== C12_29_S5_REPLACEMENT_RUNTIME_DIAGNOSTICS_SCHEMA)
    reasons.push("runtime diagnostics schema is invalid");
  if (value?.renderer !== renderer)
    reasons.push("runtime diagnostics renderer is invalid");
  for (const key of [
    "pageErrors",
    "consoleErrors",
    "expectedRecoveryConsole",
    "expectedPoolRecoveryConsole",
    "gpuErrors",
    "externalRequests",
    "failedRequests",
    "httpErrors",
  ]) {
    if (!stringArray(value?.[key]))
      reasons.push(`runtime ${key} ledger is invalid`);
  }
  if (
    !exactKeys(
      value?.recoveryConsoleInterval,
      RECOVERY_CONSOLE_INTERVAL_KEYS,
    ) ||
    !nonnegativeInteger(value?.recoveryConsoleInterval?.beginCount) ||
    !nonnegativeInteger(value?.recoveryConsoleInterval?.endCount) ||
    typeof value?.recoveryConsoleInterval?.openAtEnd !== "boolean"
  ) {
    reasons.push("runtime recovery-console interval ledger is invalid");
  }
  if (!(
    value?.unexpectedDeviceLoss === null ||
    boundedString(value?.unexpectedDeviceLoss, 2048)
  ))
    reasons.push("runtime unexpected device-loss value is invalid");
  if (
    !nonnegativeInteger(value?.pendingRequests) ||
    !nonnegativeInteger(value?.armedDevices)
  )
    reasons.push("runtime counters are invalid");
  return { ok: reasons.length === 0, reasons };
}

function deriveImageSampleStats(rgba) {
  let nonBlackPixels = 0;
  let luminance = 0;
  for (let index = 0; index < rgba.length; index += 4) {
    if (rgba[index] || rgba[index + 1] || rgba[index + 2]) nonBlackPixels++;
    luminance +=
      0.2126 * rgba[index] +
      0.7152 * rgba[index + 1] +
      0.0722 * rgba[index + 2];
  }
  return { nonBlackPixels, meanLuminance: luminance / (rgba.length / 4) };
}

function deriveImageSampleDelta(left, right) {
  let absolute = 0;
  let changed = 0;
  for (let index = 0; index < left.length; index += 4) {
    const delta =
      Math.abs(left[index] - right[index]) +
      Math.abs(left[index + 1] - right[index + 1]) +
      Math.abs(left[index + 2] - right[index + 2]);
    absolute += delta / 3;
    if (delta > 9) changed++;
  }
  return {
    meanAbsoluteDelta: absolute / (left.length / 4),
    changedPixelShare: changed / (left.length / 4),
  };
}

function validImage(value) {
  const shaped =
    exactKeys(value, [
      "label",
      "width",
      "height",
      "byteLength",
      "sha256",
      "nonBlackPixels",
      "meanLuminance",
      "sampleRgba",
    ]) &&
    boundedString(value.label, 128) &&
    positiveInteger(value.width) &&
    positiveInteger(value.height) &&
    positiveInteger(value.byteLength) &&
    typeof value.sha256 === "string" &&
    SHA256.test(value.sha256) &&
    nonnegativeInteger(value.nonBlackPixels) &&
    finite(value.meanLuminance) &&
    numericArray(
      value.sampleRgba,
      C12_29_S5_REPLACEMENT_CONFIG.sampleWidth *
        C12_29_S5_REPLACEMENT_CONFIG.sampleHeight *
        4,
    ) &&
    value.sampleRgba.every(
      (entry) => Number.isInteger(entry) && entry >= 0 && entry <= 255,
    );
  if (!shaped) return false;
  const derived = deriveImageSampleStats(value.sampleRgba);
  return (
    value.nonBlackPixels === derived.nonBlackPixels &&
    Object.is(value.meanLuminance, derived.meanLuminance)
  );
}

function validS5Snapshot(value) {
  return (
    exactKeys(value, ["prepared", "revision", "gate", "payload"]) &&
    value.prepared === true &&
    finite(value.revision) &&
    finite(value.gate) &&
    numericArray(value.payload, C12_29_S5_REPLACEMENT_CONFIG.eclipseFloats)
  );
}

function validTerrainSnapshot(value) {
  return (
    exactKeys(value, [
      "frameNumber",
      "selectionRevision",
      "surfaceRadius",
      "selectedTileIds",
      "providerToken",
      "s5",
      "image",
    ]) &&
    nonnegativeInteger(value.frameNumber) &&
    finite(value.selectionRevision) &&
    finite(value.surfaceRadius) &&
    stringArray(value.selectedTileIds, 512) &&
    value.selectedTileIds.length > 0 &&
    boundedString(value.providerToken, 128) &&
    validS5Snapshot(value.s5) &&
    validImage(value.image)
  );
}

function validControl(value) {
  return (
    exactKeys(value, [
      "renderer",
      "progress",
      "before",
      "afterGap",
      "gap",
      "continuity",
      "runtime",
      "cleanup",
    ]) &&
    value.renderer === "webgl" &&
    validateC1229S5ReplacementPageProgress(value.progress).ok &&
    exactArray(
      value.progress.completedPhases,
      C12_29_S5_REPLACEMENT_CONTROL_PHASES,
    ) &&
    validTerrainSnapshot(value.before) &&
    validTerrainSnapshot(value.afterGap) &&
    exactKeys(value.gap, [
      "requestedFrames",
      "observedFrames",
      "elapsedMs",
      "triggerInvocations",
    ]) &&
    value.gap.requestedFrames ===
      C12_29_S5_REPLACEMENT_CONFIG.controlGapFrames &&
    value.gap.observedFrames === value.gap.requestedFrames &&
    finite(value.gap.elapsedMs) &&
    value.gap.elapsedMs >= 0 &&
    value.gap.triggerInvocations === 0 &&
    exactBooleanObject(value.continuity, [
      "sameScene",
      "sameContext",
      "sameCanvas",
      "sameView",
      "sameProvider",
      "frameAdvanced",
      "terrainExact",
      "s5PayloadExact",
      "renderComparable",
    ]) &&
    validateC1229S5ReplacementRuntimeDiagnostics(value.runtime, "webgl").ok &&
    exactBooleanObject(value.cleanup, [
      "complete",
      "pageClosed",
      "contextClosed",
      "pendingRequestsDrained",
    ])
  );
}

function validEligibility(value) {
  const shaped =
    exactKeys(value, [
      "secureContext",
      "navigatorGpu",
      "objectPath",
      "objectPresent",
      "method",
      "methodType",
      "launchFlag",
      "eligible",
    ]) &&
    typeof value.secureContext === "boolean" &&
    typeof value.navigatorGpu === "boolean" &&
    value.objectPath === C12_29_S5_REPLACEMENT_CONFIG.triggerObject &&
    typeof value.objectPresent === "boolean" &&
    value.method === C12_29_S5_REPLACEMENT_CONFIG.triggerMethod &&
    ["function", "undefined", "other"].includes(value.methodType) &&
    value.launchFlag === C12_29_S5_REPLACEMENT_CONFIG.launchFlag &&
    typeof value.eligible === "boolean";
  if (!shaped) return false;
  const derived =
    value.secureContext &&
    value.navigatorGpu &&
    value.objectPresent &&
    value.methodType === "function";
  return value.eligible === derived;
}

function validTrigger(value) {
  return (
    exactKeys(value, [
      "objectPath",
      "method",
      "invocations",
      "returned",
      "destroyCalls",
      "crashHookCalls",
      "onlyAuthorizedTrigger",
    ]) &&
    value.objectPath === C12_29_S5_REPLACEMENT_CONFIG.triggerObject &&
    value.method === C12_29_S5_REPLACEMENT_CONFIG.triggerMethod &&
    value.invocations === 1 &&
    value.returned === true &&
    value.destroyCalls === 0 &&
    value.crashHookCalls === 0 &&
    typeof value.onlyAuthorizedTrigger === "boolean"
  );
}

function validLoss(value) {
  return (
    exactKeys(value, [
      "observed",
      "reason",
      "message",
      "recoverable",
      "eventCount",
      "elapsedMs",
      "classification",
    ]) &&
    typeof value.observed === "boolean" &&
    (value.reason === null || boundedString(value.reason, 256)) &&
    (value.message === null || typeof value.message === "string") &&
    typeof value.recoverable === "boolean" &&
    value.eventCount === (value.observed ? 1 : 0) &&
    finite(value.elapsedMs) &&
    value.elapsedMs >= 0 &&
    [
      "replacement",
      "destroyed-terminal-not-replacement",
      "not-observed",
    ].includes(value.classification)
  );
}

function validBindingProof(value, role) {
  return (
    exactKeys(value, [
      "role",
      "deviceToken",
      "bufferToken",
      "bindGroupToken",
      "group",
      "binding",
      "bindingSize",
      "bindingOffset",
      "dynamicOffset",
      "dynamicOffsets",
      "alignment",
      "descriptorOrdinal",
      "passLabel",
      "renderPassToken",
      "commandEncoderToken",
      "commandBufferToken",
      "bindOrdinal",
      "finishOrdinal",
      "uploadOrdinal",
      "uploadOffset",
      "uploadByteLength",
      "submitOrdinal",
      "expectedPayload",
      "observedPayload",
      "payloadExact",
      "ownedByDevice",
      "coveredByUpload",
    ]) &&
    value.role === role &&
    boundedString(value.deviceToken, 128) &&
    boundedString(value.bufferToken, 128) &&
    boundedString(value.bindGroupToken, 128) &&
    value.group === 0 &&
    value.binding === C12_29_S5_REPLACEMENT_CONFIG.eclipseBinding &&
    value.bindingSize === C12_29_S5_REPLACEMENT_CONFIG.eclipseBytes &&
    value.bindingOffset === C12_29_S5_REPLACEMENT_CONTRACT.binding.baseOffset &&
    nonnegativeInteger(value.dynamicOffset) &&
    numericArray(value.dynamicOffsets, 3) &&
    value.dynamicOffsets.every(nonnegativeInteger) &&
    value.dynamicOffsets[2] === value.dynamicOffset &&
    positiveInteger(value.alignment) &&
    (role === "D0"
      ? value.descriptorOrdinal === null
      : positiveInteger(value.descriptorOrdinal)) &&
    boundedString(value.passLabel, 256) &&
    (role === "D0"
      ? /^(?:Scene Main|Scene Framebuffer) Render Pass$/u.test(value.passLabel)
      : /^DynEnvMap Capture Face [0-5]$/u.test(value.passLabel)) &&
    boundedString(value.renderPassToken, 128) &&
    boundedString(value.commandEncoderToken, 128) &&
    boundedString(value.commandBufferToken, 128) &&
    positiveInteger(value.bindOrdinal) &&
    positiveInteger(value.finishOrdinal) &&
    positiveInteger(value.uploadOrdinal) &&
    nonnegativeInteger(value.uploadOffset) &&
    positiveInteger(value.uploadByteLength) &&
    positiveInteger(value.submitOrdinal) &&
    numericArray(
      value.expectedPayload,
      C12_29_S5_REPLACEMENT_CONFIG.eclipseFloats,
    ) &&
    numericArray(
      value.observedPayload,
      C12_29_S5_REPLACEMENT_CONFIG.eclipseFloats,
    ) &&
    typeof value.payloadExact === "boolean" &&
    typeof value.ownedByDevice === "boolean" &&
    typeof value.coveredByUpload === "boolean" &&
    (value.descriptorOrdinal === null ||
      value.descriptorOrdinal < value.bindOrdinal) &&
    value.bindOrdinal < value.uploadOrdinal &&
    value.uploadOrdinal < value.finishOrdinal &&
    value.bindOrdinal < value.finishOrdinal &&
    value.finishOrdinal < value.submitOrdinal &&
    value.uploadOrdinal < value.submitOrdinal &&
    value.coveredByUpload ===
      (value.uploadOffset <= value.bindingOffset + value.dynamicOffset &&
        value.bindingOffset +
          value.dynamicOffset +
          C12_29_S5_REPLACEMENT_CONFIG.eclipseBytes <=
          value.uploadOffset + value.uploadByteLength)
  );
}

function validResourceRecord(value, role) {
  return (
    exactKeys(value, [
      "role",
      "deviceToken",
      "bufferToken",
      "createdOrdinal",
      "destroyedOrdinal",
      "destroyCount",
      "boundOrdinals",
      "writeOrdinals",
    ]) &&
    value.role === role &&
    boundedString(value.deviceToken, 128) &&
    boundedString(value.bufferToken, 128) &&
    positiveInteger(value.createdOrdinal) &&
    (value.destroyedOrdinal === null ||
      positiveInteger(value.destroyedOrdinal)) &&
    nonnegativeInteger(value.destroyCount) &&
    (value.destroyedOrdinal === null
      ? value.destroyCount === 0
      : value.destroyCount > 0) &&
    properArray(value.boundOrdinals) &&
    value.boundOrdinals.every(positiveInteger) &&
    properArray(value.writeOrdinals) &&
    value.writeOrdinals.every(positiveInteger)
  );
}

const NATIVE_MARK_KINDS = new Set([
  "loss",
  "invalidation",
  "healthy",
  "retirement-observed",
  "capture-native-start",
  "capture-descriptor",
]);
const NATIVE_MARK_STAGES = Object.freeze({
  loss: "after-loss",
  invalidation: "after-loss",
  healthy: "after-loss",
  "retirement-observed": "replacement-healthy",
  "capture-native-start": "replacement-healthy",
  "capture-descriptor": "replacement-capture",
});

function validNativeSequenceReceipt(value, role) {
  const stage = role === "D0" ? "before-loss" : "replacement-capture";
  return (
    exactKeys(value, [
      "role",
      "device",
      "buffer",
      "bind",
      "upload",
      "finish",
      "submit",
    ]) &&
    value.role === role &&
    exactKeys(value.device, ["token", "firstOrdinal", "armedAtAcquisition"]) &&
    boundedString(value.device.token, 128) &&
    positiveInteger(value.device.firstOrdinal) &&
    typeof value.device.armedAtAcquisition === "boolean" &&
    exactKeys(value.buffer, [
      "deviceToken",
      "bufferToken",
      "createdOrdinal",
      "destroyedOrdinal",
      "destroyCount",
    ]) &&
    boundedString(value.buffer.deviceToken, 128) &&
    boundedString(value.buffer.bufferToken, 128) &&
    positiveInteger(value.buffer.createdOrdinal) &&
    (value.buffer.destroyedOrdinal === null ||
      positiveInteger(value.buffer.destroyedOrdinal)) &&
    nonnegativeInteger(value.buffer.destroyCount) &&
    (value.buffer.destroyedOrdinal === null
      ? value.buffer.destroyCount === 0
      : value.buffer.destroyCount > 0) &&
    exactKeys(value.bind, [
      "ordinal",
      "stage",
      "group",
      "deviceToken",
      "bindGroupToken",
      "dynamicOffsets",
      "renderPassToken",
      "passLabel",
      "commandEncoderToken",
    ]) &&
    positiveInteger(value.bind.ordinal) &&
    value.bind.stage === stage &&
    value.bind.group === 0 &&
    boundedString(value.bind.deviceToken, 128) &&
    boundedString(value.bind.bindGroupToken, 128) &&
    numericArray(value.bind.dynamicOffsets, 3) &&
    value.bind.dynamicOffsets.every(nonnegativeInteger) &&
    boundedString(value.bind.renderPassToken, 128) &&
    boundedString(value.bind.passLabel, 256) &&
    boundedString(value.bind.commandEncoderToken, 128) &&
    exactKeys(value.upload, [
      "ordinal",
      "stage",
      "deviceToken",
      "bufferToken",
      "offset",
      "byteLength",
      "effectiveOffset",
      "observedPayload",
    ]) &&
    positiveInteger(value.upload.ordinal) &&
    value.upload.stage === stage &&
    boundedString(value.upload.deviceToken, 128) &&
    boundedString(value.upload.bufferToken, 128) &&
    nonnegativeInteger(value.upload.offset) &&
    positiveInteger(value.upload.byteLength) &&
    nonnegativeInteger(value.upload.effectiveOffset) &&
    numericArray(
      value.upload.observedPayload,
      C12_29_S5_REPLACEMENT_CONFIG.eclipseFloats,
    ) &&
    exactKeys(value.finish, [
      "ordinal",
      "stage",
      "deviceToken",
      "commandEncoderToken",
      "commandBufferToken",
    ]) &&
    positiveInteger(value.finish.ordinal) &&
    value.finish.stage === stage &&
    boundedString(value.finish.deviceToken, 128) &&
    boundedString(value.finish.commandEncoderToken, 128) &&
    boundedString(value.finish.commandBufferToken, 128) &&
    exactKeys(value.submit, [
      "ordinal",
      "stage",
      "deviceToken",
      "commandBufferTokens",
    ]) &&
    positiveInteger(value.submit.ordinal) &&
    value.submit.stage === stage &&
    boundedString(value.submit.deviceToken, 128) &&
    stringArray(value.submit.commandBufferTokens, 8) &&
    value.submit.commandBufferTokens.length === 1 &&
    value.buffer.createdOrdinal < value.bind.ordinal &&
    value.bind.ordinal < value.upload.ordinal &&
    value.upload.ordinal < value.finish.ordinal &&
    value.finish.ordinal < value.submit.ordinal
  );
}

function validNativeSequence(value) {
  return (
    exactKeys(value, ["marks", "receipts"]) &&
    properArray(value.marks) &&
    value.marks.length >= 6 &&
    value.marks.length <= 100_000 &&
    value.marks.every(
      (mark) =>
        exactKeys(mark, ["kind", "ordinal", "stage"]) &&
        NATIVE_MARK_KINDS.has(mark.kind) &&
        positiveInteger(mark.ordinal) &&
        mark.stage === NATIVE_MARK_STAGES[mark.kind],
    ) &&
    value.marks.every(
      (mark, index) =>
        index === 0 || value.marks[index - 1].ordinal < mark.ordinal,
    ) &&
    properArray(value.receipts) &&
    value.receipts.length === 2 &&
    validNativeSequenceReceipt(value.receipts[0], "D0") &&
    validNativeSequenceReceipt(value.receipts[1], "D1")
  );
}

function nativeSequenceReceiptMatches(receipt, device, resource, proof) {
  return (
    receipt.role === proof.role &&
    receipt.device.token === device.token &&
    receipt.device.firstOrdinal === device.firstOrdinal &&
    receipt.device.armedAtAcquisition === device.armedAtAcquisition &&
    receipt.buffer.deviceToken === resource.deviceToken &&
    receipt.buffer.bufferToken === resource.bufferToken &&
    receipt.buffer.createdOrdinal === resource.createdOrdinal &&
    receipt.buffer.destroyedOrdinal === resource.destroyedOrdinal &&
    receipt.buffer.destroyCount === resource.destroyCount &&
    receipt.bind.ordinal === proof.bindOrdinal &&
    receipt.bind.group === proof.group &&
    receipt.bind.deviceToken === proof.deviceToken &&
    receipt.bind.bindGroupToken === proof.bindGroupToken &&
    exactArray(receipt.bind.dynamicOffsets, proof.dynamicOffsets) &&
    receipt.bind.renderPassToken === proof.renderPassToken &&
    receipt.bind.passLabel === proof.passLabel &&
    receipt.bind.commandEncoderToken === proof.commandEncoderToken &&
    receipt.upload.ordinal === proof.uploadOrdinal &&
    receipt.upload.deviceToken === proof.deviceToken &&
    receipt.upload.bufferToken === proof.bufferToken &&
    receipt.upload.offset === proof.uploadOffset &&
    receipt.upload.byteLength === proof.uploadByteLength &&
    receipt.upload.effectiveOffset ===
      proof.bindingOffset + proof.dynamicOffset &&
    exactArray(receipt.upload.observedPayload, proof.observedPayload) &&
    receipt.finish.ordinal === proof.finishOrdinal &&
    receipt.finish.deviceToken === proof.deviceToken &&
    receipt.finish.commandEncoderToken === proof.commandEncoderToken &&
    receipt.finish.commandBufferToken === proof.commandBufferToken &&
    receipt.submit.ordinal === proof.submitOrdinal &&
    receipt.submit.deviceToken === proof.deviceToken &&
    exactArray(receipt.submit.commandBufferTokens, [proof.commandBufferToken])
  );
}

export function validateC1229S5ReplacementNativeLedger(value) {
  const reasons = [];
  value = materializedForValidation(value, reasons, "native ledger");
  const keys = [
    "schema",
    "instrumentation",
    "devices",
    "binding2",
    "resources",
    "retirement",
    "sequence",
  ];
  if (!exactKeys(value, keys))
    reasons.push("native ledger top-level shape is invalid");
  if (value?.schema !== C12_29_S5_REPLACEMENT_NATIVE_LEDGER_SCHEMA)
    reasons.push("native ledger schema is invalid");
  if (
    !exactKeys(value?.instrumentation, [
      "installedBeforeViewer",
      "adapterPrototypeWrapped",
      "devicePrototypeWrapped",
      "commandEncoderPrototypeWrapped",
      "queuePrototypeWrapped",
      "bufferPrototypeWrapped",
      "renderPassPrototypeWrapped",
      "createBufferCalls",
      "createBindGroupCalls",
      "writeBufferCalls",
      "setBindGroupCalls",
      "createCommandEncoderCalls",
      "beginRenderPassCalls",
      "finishCommandEncoderCalls",
      "submitCalls",
      "requestDeviceCalls",
      "armedAtAcquisitionCalls",
    ]) ||
    ![
      "installedBeforeViewer",
      "adapterPrototypeWrapped",
      "devicePrototypeWrapped",
      "commandEncoderPrototypeWrapped",
      "queuePrototypeWrapped",
      "bufferPrototypeWrapped",
      "renderPassPrototypeWrapped",
    ].every((key) => typeof value?.instrumentation?.[key] === "boolean") ||
    ![
      "createBufferCalls",
      "createBindGroupCalls",
      "writeBufferCalls",
      "setBindGroupCalls",
      "createCommandEncoderCalls",
      "beginRenderPassCalls",
      "finishCommandEncoderCalls",
      "submitCalls",
      "requestDeviceCalls",
      "armedAtAcquisitionCalls",
    ].every((key) => nonnegativeInteger(value?.instrumentation?.[key]))
  )
    reasons.push("native instrumentation ledger is invalid");
  if (
    !properArray(value?.devices) ||
    value.devices.length !== 2 ||
    !value.devices.every(
      (entry, index) =>
        exactKeys(entry, [
          "role",
          "token",
          "firstOrdinal",
          "armedAtAcquisition",
          "createBufferCount",
          "createBindGroupCount",
        ]) &&
        entry.role === (index === 0 ? "D0" : "D1") &&
        boundedString(entry.token, 128) &&
        positiveInteger(entry.firstOrdinal) &&
        typeof entry.armedAtAcquisition === "boolean" &&
        nonnegativeInteger(entry.createBufferCount) &&
        nonnegativeInteger(entry.createBindGroupCount),
    )
  )
    reasons.push("native device ownership ledger is invalid");
  if (
    !exactKeys(value?.binding2, [
      "group",
      "binding",
      "byteLength",
      "floatCount",
      "before",
      "after",
    ]) ||
    value?.binding2?.group !== 0 ||
    value?.binding2?.binding !== C12_29_S5_REPLACEMENT_CONFIG.eclipseBinding ||
    value?.binding2?.byteLength !== C12_29_S5_REPLACEMENT_CONFIG.eclipseBytes ||
    value?.binding2?.floatCount !==
      C12_29_S5_REPLACEMENT_CONFIG.eclipseFloats ||
    !validBindingProof(value?.binding2?.before, "D0") ||
    !validBindingProof(value?.binding2?.after, "D1")
  )
    reasons.push("native binding-2 proof is invalid");
  if (
    !exactKeys(value?.resources, ["d0Binding2", "d1Binding2"]) ||
    !validResourceRecord(value?.resources?.d0Binding2, "D0") ||
    !validResourceRecord(value?.resources?.d1Binding2, "D1")
  )
    reasons.push("native resource records are invalid");
  if (
    !exactKeys(value?.retirement, [
      "lossOrdinal",
      "oldDestroyOrdinal",
      "invalidationOrdinal",
      "healthyOrdinal",
      "firstD1CreateOrdinal",
      "oldDestroyCount",
      "postLossD0CreateCount",
      "postLossD0WriteCount",
      "postLossD0BindCount",
      "invalidationCount",
      "ordered",
    ]) ||
    ![
      "lossOrdinal",
      "oldDestroyOrdinal",
      "invalidationOrdinal",
      "healthyOrdinal",
      "firstD1CreateOrdinal",
    ].every((key) => positiveInteger(value?.retirement?.[key])) ||
    ![
      "oldDestroyCount",
      "postLossD0CreateCount",
      "postLossD0WriteCount",
      "postLossD0BindCount",
      "invalidationCount",
    ].every((key) => nonnegativeInteger(value?.retirement?.[key])) ||
    typeof value?.retirement?.ordered !== "boolean"
  )
    reasons.push("native retirement ledger is invalid");
  if (!validNativeSequence(value?.sequence))
    reasons.push("native raw sequence is invalid");
  const d0 = value?.devices?.[0];
  const d1 = value?.devices?.[1];
  const before = value?.binding2?.before;
  const after = value?.binding2?.after;
  const d0Resource = value?.resources?.d0Binding2;
  const d1Resource = value?.resources?.d1Binding2;
  const retirement = value?.retirement;
  const sequence = value?.sequence;
  if (
    d0 &&
    d1 &&
    before &&
    after &&
    d0Resource &&
    d1Resource &&
    retirement &&
    validNativeSequence(sequence)
  ) {
    if (
      d0.token === d1.token ||
      before.deviceToken !== d0.token ||
      after.deviceToken !== d1.token ||
      d0Resource.deviceToken !== d0.token ||
      d1Resource.deviceToken !== d1.token
    ) {
      reasons.push("native device tokens are internally inconsistent");
    }
    if (
      before.bufferToken !== d0Resource.bufferToken ||
      after.bufferToken !== d1Resource.bufferToken ||
      d0Resource.bufferToken === d1Resource.bufferToken
    ) {
      reasons.push("native binding/resource buffer tokens are inconsistent");
    }
    if (
      retirement.oldDestroyOrdinal !== d0Resource.destroyedOrdinal ||
      retirement.oldDestroyCount !== d0Resource.destroyCount ||
      retirement.invalidationOrdinal >= retirement.healthyOrdinal ||
      !(d0Resource.createdOrdinal < before.bindOrdinal) ||
      !(before.bindOrdinal < before.uploadOrdinal) ||
      !(before.uploadOrdinal < before.finishOrdinal) ||
      !(before.finishOrdinal < before.submitOrdinal) ||
      !(before.submitOrdinal < retirement.lossOrdinal) ||
      !(before.bindOrdinal < retirement.lossOrdinal) ||
      !(retirement.lossOrdinal < d0Resource.destroyedOrdinal) ||
      !(d0Resource.destroyedOrdinal <= retirement.invalidationOrdinal) ||
      !(retirement.healthyOrdinal < d1Resource.createdOrdinal) ||
      !(d1Resource.createdOrdinal < after.descriptorOrdinal) ||
      !(after.descriptorOrdinal < after.bindOrdinal) ||
      !(d1Resource.createdOrdinal < after.bindOrdinal) ||
      !(after.bindOrdinal < after.uploadOrdinal) ||
      !(after.uploadOrdinal < after.finishOrdinal) ||
      !(after.finishOrdinal < after.submitOrdinal) ||
      d1Resource.destroyedOrdinal !== null ||
      d1Resource.destroyCount !== 0 ||
      !(retirement.lossOrdinal < retirement.firstD1CreateOrdinal) ||
      !(retirement.firstD1CreateOrdinal <= retirement.healthyOrdinal)
    ) {
      reasons.push("native resource lifetime ordinals are inconsistent");
    }
    if (
      !d0Resource.boundOrdinals.includes(before.bindOrdinal) ||
      !d0Resource.writeOrdinals.includes(before.uploadOrdinal) ||
      !d1Resource.boundOrdinals.includes(after.bindOrdinal) ||
      !d1Resource.writeOrdinals.includes(after.uploadOrdinal)
    ) {
      reasons.push("native proof ordinals are absent from resource ledgers");
    }
    const marks = (kind) =>
      sequence.marks.filter((entry) => entry.kind === kind);
    const lossMarks = marks("loss");
    const invalidationMarks = marks("invalidation");
    const healthyMarks = marks("healthy");
    const retirementMarks = marks("retirement-observed");
    const captureStartMarks = marks("capture-native-start");
    const captureDescriptorMarks = marks("capture-descriptor");
    if (
      !nativeSequenceReceiptMatches(
        sequence.receipts[0],
        d0,
        d0Resource,
        before,
      ) ||
      !nativeSequenceReceiptMatches(
        sequence.receipts[1],
        d1,
        d1Resource,
        after,
      ) ||
      lossMarks.length !== 1 ||
      lossMarks[0]?.ordinal !== retirement.lossOrdinal ||
      invalidationMarks.length !== 1 ||
      invalidationMarks[0]?.ordinal !== retirement.invalidationOrdinal ||
      healthyMarks.length !== 1 ||
      healthyMarks[0]?.ordinal !== retirement.healthyOrdinal ||
      retirementMarks.length !== 1 ||
      !(healthyMarks[0]?.ordinal < retirementMarks[0]?.ordinal) ||
      captureStartMarks.length !== 1 ||
      !(retirementMarks[0]?.ordinal < captureStartMarks[0]?.ordinal) ||
      captureDescriptorMarks.length < 1 ||
      !captureDescriptorMarks.some(
        (entry) => entry.ordinal === after.descriptorOrdinal,
      ) ||
      !(captureStartMarks[0]?.ordinal < after.descriptorOrdinal)
    ) {
      reasons.push("native raw sequence contradicts derived ledger fields");
    }
  }
  return { ok: reasons.length === 0, reasons };
}

function validRecovery(value) {
  return (
    exactKeys(value, [
      "healthy",
      "state",
      "attempts",
      "elapsedMs",
      "deviceLostEvents",
      "recoveredEvents",
    ]) &&
    typeof value.healthy === "boolean" &&
    boundedString(value.state, 128) &&
    nonnegativeInteger(value.attempts) &&
    finite(value.elapsedMs) &&
    value.elapsedMs >= 0 &&
    positiveInteger(value.deviceLostEvents) &&
    positiveInteger(value.recoveredEvents)
  );
}

function validIdentity(value) {
  return exactBooleanObject(value, [
    "sameScene",
    "sameContext",
    "sameCanvas",
    "sameCanvasContext",
    "sameView",
    "sameGlobe",
    "sameProvider",
    "sameModel",
    "sameManager",
    "freshAdapter",
    "freshDevice",
  ]);
}

function validGeneration(value) {
  return (
    exactKeys(value, ["before", "after", "delta"]) &&
    nonnegativeInteger(value.before) &&
    nonnegativeInteger(value.after) &&
    Number.isInteger(value.delta) &&
    value.delta === value.after - value.before
  );
}

function validInvalidation(value) {
  return (
    exactKeys(value, ["count", "ordinals", "afterLossBeforeHealthy"]) &&
    nonnegativeInteger(value.count) &&
    properArray(value.ordinals) &&
    value.ordinals.length === value.count &&
    value.ordinals.every(positiveInteger) &&
    typeof value.afterLossBeforeHealthy === "boolean"
  );
}

function validTerrainContinuity(value) {
  return (
    exactKeys(value, [
      "before",
      "after",
      "sameProvider",
      "selectedIdsExact",
      "surfaceRadiusExact",
      "s5PayloadExact",
      "activeBoth",
    ]) &&
    validTerrainSnapshot(value.before) &&
    validTerrainSnapshot(value.after) &&
    [
      "sameProvider",
      "selectedIdsExact",
      "surfaceRadiusExact",
      "s5PayloadExact",
      "activeBoth",
    ].every((key) => typeof value[key] === "boolean")
  );
}

function validRender(value) {
  return (
    exactKeys(value, [
      "beforeImage",
      "afterImage",
      "meanAbsoluteDelta",
      "changedPixelShare",
      "comparable",
      "nonVacuous",
    ]) &&
    validImage(value.beforeImage) &&
    validImage(value.afterImage) &&
    finite(value.meanAbsoluteDelta) &&
    value.meanAbsoluteDelta >= 0 &&
    finite(value.changedPixelShare) &&
    value.changedPixelShare >= 0 &&
    value.changedPixelShare <= 1 &&
    typeof value.comparable === "boolean" &&
    typeof value.nonVacuous === "boolean"
  );
}

function validPick(value) {
  return (
    exactKeys(value, [
      "method",
      "invoked",
      "awaited",
      "settled",
      "renderPumpFrames",
      "resultKind",
      "resultPrimitiveIdentity",
      "sameScene",
      "sameContext",
      "s5Active",
      "generation",
    ]) &&
    value.method === "scene.pickAsync" &&
    [
      "invoked",
      "awaited",
      "settled",
      "resultPrimitiveIdentity",
      "sameScene",
      "sameContext",
      "s5Active",
    ].every((key) => typeof value[key] === "boolean") &&
    nonnegativeInteger(value.renderPumpFrames) &&
    boundedString(value.resultKind, 128) &&
    nonnegativeInteger(value.generation)
  );
}

function validCapture(value) {
  return (
    exactKeys(value, [
      "managerDriven",
      "directHelperCall",
      "sameModel",
      "sameManager",
      "submitted",
      "statusCode",
      "settleFrames",
      "selectedTileCount",
      "s5Active",
      "generation",
      "d1Binding2Observed",
      "modelRemoved",
      "modelDestroyed",
      "captureSourcesCleared",
    ]) &&
    [
      "managerDriven",
      "directHelperCall",
      "sameModel",
      "sameManager",
      "submitted",
      "s5Active",
      "d1Binding2Observed",
      "modelRemoved",
      "modelDestroyed",
      "captureSourcesCleared",
    ].every((key) => typeof value[key] === "boolean") &&
    nonnegativeInteger(value.statusCode) &&
    nonnegativeInteger(value.settleFrames) &&
    positiveInteger(value.selectedTileCount) &&
    nonnegativeInteger(value.generation)
  );
}

function validWebgpu(value) {
  const reasons = [];
  const keys = [
    "renderer",
    "progress",
    "classification",
    "eligibility",
    "before",
    "trigger",
    "loss",
    "recovery",
    "identity",
    "generations",
    "invalidation",
    "ledger",
    "terrain",
    "render",
    "pick",
    "capture",
    "runtime",
    "cleanup",
  ];
  if (!exactKeys(value, keys)) reasons.push("WebGPU evidence shape is invalid");
  if (value?.renderer !== "webgpu")
    reasons.push("WebGPU renderer identity is invalid");
  const progress = validateC1229S5ReplacementPageProgress(value?.progress);
  if (!progress.ok) reasons.push(...progress.reasons);
  if (
    ![
      "eligible-replacement",
      "hook-unavailable",
      "destroyed-not-replacement",
    ].includes(value?.classification)
  )
    reasons.push("WebGPU classification is invalid");
  if (!validEligibility(value?.eligibility))
    reasons.push("WebGPU eligibility is invalid");
  const runtime = validateC1229S5ReplacementRuntimeDiagnostics(
    value?.runtime,
    "webgpu",
  );
  if (!runtime.ok) reasons.push(...runtime.reasons);
  if (
    !exactBooleanObject(value?.cleanup, [
      "complete",
      "pageClosed",
      "contextClosed",
      "pendingRequestsDrained",
      "listenersRemoved",
    ])
  )
    reasons.push("WebGPU cleanup is invalid");

  if (value?.classification === "hook-unavailable") {
    for (const key of [
      "before",
      "trigger",
      "loss",
      "recovery",
      "identity",
      "generations",
      "invalidation",
      "ledger",
      "terrain",
      "render",
      "pick",
      "capture",
    ])
      if (value?.[key] !== null)
        reasons.push(`hook-unavailable ${key} must be null`);
    if (
      !exactArray(value?.progress?.completedPhases, [
        C12_29_S5_REPLACEMENT_WEBGPU_PHASES[0],
      ])
    )
      reasons.push("hook-unavailable phase prefix is invalid");
    return { ok: reasons.length === 0, reasons };
  }

  if (!validTerrainSnapshot(value?.before))
    reasons.push("WebGPU pre-loss snapshot is invalid");
  if (!validTrigger(value?.trigger))
    reasons.push("WebGPU trigger ledger is invalid");
  if (!validLoss(value?.loss)) reasons.push("WebGPU loss ledger is invalid");
  if (value?.classification === "destroyed-not-replacement") {
    for (const key of [
      "recovery",
      "identity",
      "generations",
      "invalidation",
      "ledger",
      "terrain",
      "render",
      "pick",
      "capture",
    ])
      if (value?.[key] !== null)
        reasons.push(`destroyed-not-replacement ${key} must be null`);
    if (
      !exactArray(
        value?.progress?.completedPhases,
        C12_29_S5_REPLACEMENT_WEBGPU_PHASES.slice(0, 3),
      )
    )
      reasons.push("destroyed-not-replacement phase prefix is invalid");
    return { ok: reasons.length === 0, reasons };
  }

  if (
    !exactArray(
      value?.progress?.completedPhases,
      C12_29_S5_REPLACEMENT_WEBGPU_PHASES,
    )
  )
    reasons.push("eligible replacement did not complete every WebGPU phase");
  if (!validRecovery(value?.recovery))
    reasons.push("WebGPU recovery ledger is invalid");
  if (!validIdentity(value?.identity))
    reasons.push("WebGPU owner identity ledger is invalid");
  if (!validGeneration(value?.generations))
    reasons.push("WebGPU generation ledger is invalid");
  if (!validInvalidation(value?.invalidation))
    reasons.push("WebGPU invalidation ledger is invalid");
  const ledger = validateC1229S5ReplacementNativeLedger(value?.ledger);
  if (!ledger.ok) reasons.push(...ledger.reasons);
  if (!validTerrainContinuity(value?.terrain))
    reasons.push("WebGPU terrain/S5 continuity is invalid");
  if (!validRender(value?.render))
    reasons.push("WebGPU render continuity is invalid");
  if (!validPick(value?.pick)) reasons.push("WebGPU pick evidence is invalid");
  if (!validCapture(value?.capture))
    reasons.push("WebGPU capture evidence is invalid");
  return { ok: reasons.length === 0, reasons };
}

function runtimeClean(runtime, allowExpectedRecovery) {
  return (
    runtime.pageErrors.length === 0 &&
    runtime.consoleErrors.length === 0 &&
    runtime.gpuErrors.length === 0 &&
    runtime.unexpectedDeviceLoss === null &&
    runtime.externalRequests.length === 0 &&
    runtime.failedRequests.length === 0 &&
    runtime.httpErrors.length === 0 &&
    runtime.pendingRequests === 0 &&
    (allowExpectedRecovery ||
      (runtime.expectedRecoveryConsole.length === 0 &&
        runtime.expectedPoolRecoveryConsole.length === 0 &&
        runtime.recoveryConsoleInterval.beginCount === 0 &&
        runtime.recoveryConsoleInterval.endCount === 0 &&
        runtime.recoveryConsoleInterval.openAtEnd === false))
  );
}

function deriveTerrainContinuity(before, after) {
  return {
    sameProvider: before.providerToken === after.providerToken,
    selectedIdsExact: exactArray(before.selectedTileIds, after.selectedTileIds),
    surfaceRadiusExact: Object.is(before.surfaceRadius, after.surfaceRadius),
    s5PayloadExact: exactArray(before.s5.payload, after.s5.payload),
    activeBoth: before.s5.gate > 0.5 && after.s5.gate > 0.5,
  };
}

function renderEvidencePass(render) {
  const delta = deriveImageSampleDelta(
    render.beforeImage.sampleRgba,
    render.afterImage.sampleRgba,
  );
  const comparable =
    delta.meanAbsoluteDelta <=
      C12_29_S5_REPLACEMENT_CONFIG.replacementMaximumMeanAbsoluteDelta &&
    delta.changedPixelShare <=
      C12_29_S5_REPLACEMENT_CONFIG.replacementMaximumChangedPixelShare;
  const nonVacuous =
    render.beforeImage.nonBlackPixels >=
      C12_29_S5_REPLACEMENT_CONFIG.minimumNonBlackSamplePixels &&
    render.afterImage.nonBlackPixels >=
      C12_29_S5_REPLACEMENT_CONFIG.minimumNonBlackSamplePixels;
  return (
    Object.is(render.meanAbsoluteDelta, delta.meanAbsoluteDelta) &&
    Object.is(render.changedPixelShare, delta.changedPixelShare) &&
    render.comparable === comparable &&
    render.nonVacuous === nonVacuous &&
    comparable &&
    nonVacuous
  );
}

function instrumentationEngaged(instrumentation) {
  return (
    instrumentation.installedBeforeViewer &&
    instrumentation.adapterPrototypeWrapped &&
    instrumentation.devicePrototypeWrapped &&
    instrumentation.commandEncoderPrototypeWrapped &&
    instrumentation.queuePrototypeWrapped &&
    instrumentation.bufferPrototypeWrapped &&
    instrumentation.renderPassPrototypeWrapped &&
    instrumentation.createBufferCalls > 0 &&
    instrumentation.createBindGroupCalls > 0 &&
    instrumentation.writeBufferCalls > 0 &&
    instrumentation.setBindGroupCalls > 0 &&
    instrumentation.createCommandEncoderCalls > 0 &&
    instrumentation.beginRenderPassCalls > 0 &&
    instrumentation.finishCommandEncoderCalls > 0 &&
    instrumentation.submitCalls > 0 &&
    instrumentation.requestDeviceCalls >= 2 &&
    instrumentation.armedAtAcquisitionCalls >= 2
  );
}

function recoveryConsolePass(webgpu) {
  const runtime = webgpu.runtime;
  const loss = webgpu.loss;
  if (!loss) return false;
  const expectedContextLine = `[WebGPU] Device lost (reason: ${loss.reason}): ${loss.message}`;
  const expectedPoolLine = `[CesiumJS:WebGPUDevicePool] Device lost: ${loss.reason} — ${loss.message}`;
  return (
    exactArray(runtime.expectedRecoveryConsole, [expectedContextLine]) &&
    exactArray(runtime.expectedPoolRecoveryConsole, [expectedPoolLine]) &&
    runtime.recoveryConsoleInterval.beginCount === 1 &&
    runtime.recoveryConsoleInterval.endCount === 1 &&
    runtime.recoveryConsoleInterval.openAtEnd === false &&
    loss.reason !== "destroyed"
  );
}

function controlPass(control) {
  const terrain = deriveTerrainContinuity(control.before, control.afterGap);
  const delta = deriveImageSampleDelta(
    control.before.image.sampleRgba,
    control.afterGap.image.sampleRgba,
  );
  const renderComparable =
    delta.meanAbsoluteDelta <=
      C12_29_S5_REPLACEMENT_CONFIG.controlMaximumMeanAbsoluteDelta &&
    delta.changedPixelShare <=
      C12_29_S5_REPLACEMENT_CONFIG.controlMaximumChangedPixelShare;
  return (
    Object.values(control.continuity).every(Boolean) &&
    control.continuity.frameAdvanced ===
      control.afterGap.frameNumber > control.before.frameNumber &&
    control.continuity.sameProvider === terrain.sameProvider &&
    control.continuity.terrainExact === terrain.selectedIdsExact &&
    control.continuity.s5PayloadExact === terrain.s5PayloadExact &&
    control.continuity.renderComparable === renderComparable &&
    terrain.surfaceRadiusExact &&
    terrain.activeBoth &&
    control.before.s5.gate > 0.5 &&
    control.afterGap.s5.gate > 0.5 &&
    runtimeClean(control.runtime, false) &&
    Object.values(control.cleanup).every(Boolean)
  );
}

function payloadProofPass(proof) {
  const effectiveOffset = proof.bindingOffset + proof.dynamicOffset;
  const covered =
    proof.uploadOffset <= effectiveOffset &&
    effectiveOffset + C12_29_S5_REPLACEMENT_CONFIG.eclipseBytes <=
      proof.uploadOffset + proof.uploadByteLength;
  return (
    proof.payloadExact &&
    proof.ownedByDevice &&
    proof.coveredByUpload === covered &&
    covered &&
    (proof.descriptorOrdinal === null ||
      proof.descriptorOrdinal < proof.bindOrdinal) &&
    proof.bindOrdinal < proof.uploadOrdinal &&
    proof.uploadOrdinal < proof.finishOrdinal &&
    proof.finishOrdinal < proof.submitOrdinal &&
    proof.bindingOffset === C12_29_S5_REPLACEMENT_CONTRACT.binding.baseOffset &&
    proof.dynamicOffsets.every((offset) => offset % proof.alignment === 0) &&
    exactArray(proof.expectedPayload, proof.observedPayload)
  );
}

function checkObject(report) {
  const webgpu = report.webgpu;
  const full = webgpu.classification === "eligible-replacement";
  const ledger = full ? webgpu.ledger : null;
  const retirement = ledger?.retirement;
  const terrain = full
    ? deriveTerrainContinuity(webgpu.terrain.before, webgpu.terrain.after)
    : null;
  return {
    phaseOrderExact: exactArray(
      report.phaseOrder,
      C12_29_S5_REPLACEMENT_PHASES,
    ),
    provenanceStable:
      report.provenance.stable &&
      report.provenance.buildEntryMatchesServed &&
      report.provenance.servedMatchesLocal &&
      report.provenance.buildSourceIdentity.ok,
    controlGapHealthy: controlPass(report.control),
    genuineTrigger:
      full &&
      webgpu.eligibility.eligible &&
      webgpu.trigger.returned &&
      webgpu.trigger.onlyAuthorizedTrigger &&
      webgpu.trigger.invocations === 1 &&
      webgpu.trigger.destroyCalls === 0 &&
      webgpu.trigger.crashHookCalls === 0,
    nonDestroyedLoss:
      full &&
      webgpu.loss.observed &&
      boundedString(webgpu.loss.reason, 256) &&
      webgpu.loss.reason !== "destroyed" &&
      webgpu.loss.recoverable &&
      webgpu.loss.eventCount === 1 &&
      webgpu.loss.classification === "replacement",
    sameOwners:
      full &&
      webgpu.recovery.healthy &&
      webgpu.recovery.state === "healthy" &&
      webgpu.recovery.deviceLostEvents === 1 &&
      webgpu.recovery.recoveredEvents === 1 &&
      Object.values(webgpu.identity).every(Boolean),
    generationAdvanced:
      full &&
      webgpu.generations.delta === 1 &&
      webgpu.generations.after === webgpu.generations.before + 1 &&
      webgpu.recovery.healthy,
    invalidationOrdered:
      full &&
      webgpu.invalidation.count === 1 &&
      webgpu.invalidation.ordinals[0] === retirement?.invalidationOrdinal &&
      webgpu.invalidation.afterLossBeforeHealthy &&
      retirement?.invalidationCount === 1 &&
      retirement?.ordered === true,
    oldCarrierRetired:
      full &&
      retirement?.oldDestroyCount === 1 &&
      retirement?.postLossD0CreateCount === 0 &&
      retirement?.postLossD0WriteCount === 0 &&
      retirement?.postLossD0BindCount === 0 &&
      ledger.resources.d0Binding2.destroyCount === 1 &&
      ledger.resources.d0Binding2.destroyedOrdinal !== null,
    replacementCarrierExact:
      full &&
      ledger.devices[0].token !== ledger.devices[1].token &&
      instrumentationEngaged(ledger.instrumentation) &&
      ledger.resources.d0Binding2.bufferToken !==
        ledger.resources.d1Binding2.bufferToken &&
      ledger.resources.d1Binding2.destroyedOrdinal === null &&
      ledger.resources.d1Binding2.destroyCount === 0 &&
      ledger.sequence.receipts[1].buffer.destroyedOrdinal === null &&
      ledger.sequence.receipts[1].buffer.destroyCount === 0 &&
      payloadProofPass(ledger.binding2.before) &&
      payloadProofPass(ledger.binding2.after) &&
      exactArray(
        ledger.binding2.before.expectedPayload,
        webgpu.terrain.before.s5.payload,
      ) &&
      exactArray(
        ledger.binding2.after.expectedPayload,
        webgpu.terrain.after.s5.payload,
      ),
    nativeErrorsArmedEarly:
      full &&
      ledger.devices.length === 2 &&
      ledger.devices.every((device) => device.armedAtAcquisition) &&
      ledger.instrumentation.adapterPrototypeWrapped &&
      ledger.instrumentation.armedAtAcquisitionCalls >= 2,
    terrainCpuContinuous:
      full &&
      webgpu.terrain.sameProvider &&
      webgpu.terrain.selectedIdsExact &&
      webgpu.terrain.surfaceRadiusExact &&
      webgpu.terrain.s5PayloadExact &&
      webgpu.terrain.activeBoth &&
      webgpu.terrain.sameProvider === terrain.sameProvider &&
      webgpu.terrain.selectedIdsExact === terrain.selectedIdsExact &&
      webgpu.terrain.surfaceRadiusExact === terrain.surfaceRadiusExact &&
      webgpu.terrain.s5PayloadExact === terrain.s5PayloadExact &&
      webgpu.terrain.activeBoth === terrain.activeBoth &&
      webgpu.terrain.after.frameNumber > webgpu.terrain.before.frameNumber,
    replacementRenderHealthy: full && renderEvidencePass(webgpu.render),
    replacementPickHealthy:
      full &&
      webgpu.pick.invoked &&
      webgpu.pick.awaited &&
      webgpu.pick.settled &&
      webgpu.pick.resultPrimitiveIdentity &&
      webgpu.pick.sameScene &&
      webgpu.pick.sameContext &&
      webgpu.pick.s5Active &&
      webgpu.pick.generation === webgpu.generations.after,
    replacementCaptureSubmitted:
      full &&
      webgpu.capture.managerDriven &&
      !webgpu.capture.directHelperCall &&
      webgpu.capture.sameModel &&
      webgpu.capture.sameManager &&
      webgpu.capture.submitted &&
      webgpu.capture.statusCode ===
        C12_29_S5_REPLACEMENT_CONFIG.captureSubmittedCode &&
      webgpu.capture.s5Active &&
      webgpu.capture.generation === webgpu.generations.after &&
      webgpu.capture.d1Binding2Observed &&
      webgpu.capture.modelRemoved &&
      webgpu.capture.modelDestroyed &&
      webgpu.capture.captureSourcesCleared,
    runtimeClean:
      runtimeClean(report.control.runtime, false) &&
      runtimeClean(webgpu.runtime, full) &&
      (!full ||
        (webgpu.runtime.armedDevices >= 2 && recoveryConsolePass(webgpu))),
    cleanupComplete:
      report.cleanup.complete &&
      report.cleanup.browserClosed &&
      report.cleanup.contextsClosed &&
      report.cleanup.pagesClosed &&
      Object.values(report.control.cleanup).every(Boolean) &&
      Object.values(webgpu.cleanup).every(Boolean),
  };
}

export function foldC1229S5ReplacementDeviceGate(report) {
  const structuralReasons = [];
  const failureReasons = [];
  report = materializedForValidation(
    report,
    structuralReasons,
    "replacement-device report",
  );
  const topKeys = [
    "schema",
    "runId",
    "incomplete",
    "contract",
    "phaseOrder",
    "provenance",
    "control",
    "webgpu",
    "cleanup",
  ];
  if (!exactKeys(report, topKeys))
    structuralReasons.push("report top-level shape is invalid");
  if (report?.schema !== C12_29_S5_REPLACEMENT_SCHEMA)
    structuralReasons.push("report schema is invalid");
  if (!isC1229S5ReplacementUuidV4(report?.runId))
    structuralReasons.push("report runId is invalid");
  if (report?.incomplete !== false)
    structuralReasons.push("report is incomplete");
  if (!sameJson(report?.contract, C12_29_S5_REPLACEMENT_CONTRACT))
    structuralReasons.push("frozen replacement-device contract drifted");
  if (!exactArray(report?.phaseOrder, C12_29_S5_REPLACEMENT_PHASES))
    structuralReasons.push("canonical phase order drifted");
  const provenance = validateC1229S5ReplacementProvenance(report?.provenance);
  if (!provenance.ok) structuralReasons.push(...provenance.reasons);
  if (!validControl(report?.control))
    structuralReasons.push("WebGL control evidence is malformed");
  const webgpu = validWebgpu(report?.webgpu);
  if (!webgpu.ok) structuralReasons.push(...webgpu.reasons);
  if (
    !exactBooleanObject(report?.cleanup, [
      "complete",
      "browserClosed",
      "contextsClosed",
      "pagesClosed",
    ])
  )
    structuralReasons.push("top-level cleanup ledger is malformed");

  let checks = Object.fromEntries(CHECK_KEYS.map((key) => [key, false]));
  if (structuralReasons.length === 0) {
    checks = checkObject(report);
    if (!checks.provenanceStable)
      structuralReasons.push(
        "provenance did not bind a stable exact build/source set",
      );
    if (!checks.phaseOrderExact)
      structuralReasons.push("phase order is not exact");
    if (report.webgpu.classification === "hook-unavailable")
      structuralReasons.push(
        "genuine Chromium GPU-process termination hook was unavailable",
      );
    else if (report.webgpu.classification === "destroyed-not-replacement")
      structuralReasons.push(
        "device loss reason destroyed is terminal teardown, not replacement evidence",
      );
    else {
      if (!checks.genuineTrigger)
        structuralReasons.push(
          "replacement experiment was not engaged by the sole authorized hook",
        );
      if (!checks.nonDestroyedLoss)
        structuralReasons.push(
          "a non-destroyed recoverable loss was not observed",
        );
      for (const [key, reason] of [
        ["controlGapHealthy", "WebGL no-loss gap control changed or failed"],
        [
          "sameOwners",
          "Scene/context/canvas/GPUCanvasContext/View ownership did not survive",
        ],
        [
          "generationAdvanced",
          "replacement generation did not advance by exactly one",
        ],
        ["invalidationOrdered", "device invalidation count/order is wrong"],
        [
          "oldCarrierRetired",
          "D0 S5 carrier was not retired exactly once or was used after loss",
        ],
        [
          "replacementCarrierExact",
          "D1 binding-2 carrier ownership/64-byte payload proof failed",
        ],
        [
          "nativeErrorsArmedEarly",
          "D0/D1 uncaptured-error gates were not armed at device acquisition",
        ],
        [
          "terrainCpuContinuous",
          "terrain/S5 CPU state did not remain continuous",
        ],
        [
          "replacementRenderHealthy",
          "replacement-device render continuity failed",
        ],
        ["replacementPickHealthy", "replacement-device real pick failed"],
        [
          "replacementCaptureSubmitted",
          "replacement-device retained capture did not submit and clean up",
        ],
        ["runtimeClean", "runtime/transport/GPU error ledger is not clean"],
        ["cleanupComplete", "probe cleanup did not complete"],
      ])
        if (!checks[key]) failureReasons.push(reason);
    }
  }
  const status =
    structuralReasons.length > 0
      ? "STRUCTURAL"
      : failureReasons.length > 0
        ? "FAIL"
        : "PASS";
  return {
    status,
    exitCode: exitCodeForC1229S5ReplacementStatus(status),
    structuralReasons,
    failureReasons,
    checks,
  };
}

export function createC1229S5ReplacementErrorDiagnostics({
  stage = "node",
  phase = "preflight",
  renderer = null,
  kind = "exception",
  message,
  stack = null,
  timeoutMs = null,
  pageProgress = null,
}) {
  return {
    schema: C12_29_S5_REPLACEMENT_RUNTIME_DIAGNOSTICS_SCHEMA,
    stage,
    phase,
    renderer,
    kind,
    message,
    stack,
    timeoutMs,
    pageProgress,
  };
}

function validErrorDiagnostics(value) {
  if (
    !exactKeys(value, [
      "schema",
      "stage",
      "phase",
      "renderer",
      "kind",
      "message",
      "stack",
      "timeoutMs",
      "pageProgress",
    ]) ||
    value.schema !== C12_29_S5_REPLACEMENT_RUNTIME_DIAGNOSTICS_SCHEMA ||
    ![
      "node",
      "browser-launch",
      "control-page",
      "webgpu-page",
      "publication",
      "watchdog",
    ].includes(value.stage) ||
    !["exception", "timeout", "cleanup", "publication"].includes(value.kind) ||
    !boundedString(value.message, 4096) ||
    !(
      value.stack === null ||
      (typeof value.stack === "string" && value.stack.length <= 16_384)
    ) ||
    (value.kind === "timeout"
      ? !positiveInteger(value.timeoutMs)
      : value.timeoutMs !== null)
  ) {
    return false;
  }

  const pageRenderer =
    value.stage === "control-page"
      ? "webgl"
      : value.stage === "webgpu-page"
        ? "webgpu"
        : null;
  if (pageRenderer === null) {
    if (
      value.renderer !== null ||
      value.phase !== "preflight" ||
      value.pageProgress !== null
    ) {
      return false;
    }
  } else {
    const allowedPhases =
      pageRenderer === "webgl"
        ? C12_29_S5_REPLACEMENT_CONTROL_PHASES
        : C12_29_S5_REPLACEMENT_WEBGPU_PHASES;
    if (
      value.renderer !== pageRenderer ||
      !(value.phase === "preflight" || allowedPhases.includes(value.phase))
    ) {
      return false;
    }
    if (
      value.pageProgress !== null &&
      (!validateC1229S5ReplacementPageProgress(value.pageProgress).ok ||
        value.pageProgress.renderer !== pageRenderer ||
        value.pageProgress.currentPhase !== value.phase)
    ) {
      return false;
    }
    if (value.phase !== "preflight" && value.pageProgress === null) {
      return false;
    }
    if (value.pageProgress !== null) {
      const phaseIndex = allowedPhases.indexOf(value.phase);
      const expectedLength =
        value.phase === "preflight"
          ? 0
          : phaseIndex + (value.pageProgress.step === "complete" ? 1 : 0);
      if (
        value.pageProgress.completedPhases.length !== expectedLength ||
        !value.pageProgress.completedPhases.every(
          (phase, index) => phase === allowedPhases[index],
        )
      ) {
        return false;
      }
    }
  }

  if (
    (value.stage === "browser-launch" && value.kind !== "exception") ||
    (value.stage === "watchdog" && value.kind !== "timeout") ||
    (value.stage === "publication") !== (value.kind === "publication")
  ) {
    return false;
  }
  return true;
}

export function createC1229S5ReplacementErrorArtifact(runId, diagnostics) {
  return {
    schema: C12_29_S5_REPLACEMENT_SCHEMA,
    runId,
    incomplete: false,
    status: "ERROR",
    exitCode: 2,
    reasons: { structural: [], failures: [diagnostics.message] },
    diagnostics,
  };
}

export function validateC1229S5ReplacementFinalArtifact(artifact) {
  const reasons = [];
  artifact = materializedForValidation(
    artifact,
    reasons,
    "replacement-device final artifact",
  );
  if (artifact?.status === "ERROR") {
    if (
      !exactKeys(artifact, [
        "schema",
        "runId",
        "incomplete",
        "status",
        "exitCode",
        "reasons",
        "diagnostics",
      ])
    )
      reasons.push("ERROR artifact top-level shape is invalid");
    if (
      artifact?.schema !== C12_29_S5_REPLACEMENT_SCHEMA ||
      !isC1229S5ReplacementUuidV4(artifact?.runId) ||
      artifact?.incomplete !== false ||
      artifact?.exitCode !== 2
    )
      reasons.push("ERROR artifact identity/status is invalid");
    if (
      !exactKeys(artifact?.reasons, ["structural", "failures"]) ||
      !exactArray(artifact?.reasons?.structural, []) ||
      !stringArray(artifact?.reasons?.failures) ||
      artifact?.reasons?.failures?.length !== 1
    )
      reasons.push("ERROR artifact reasons are invalid");
    if (!validErrorDiagnostics(artifact?.diagnostics))
      reasons.push("ERROR diagnostics are invalid");
    if (artifact?.diagnostics?.message !== artifact?.reasons?.failures?.[0])
      reasons.push("ERROR diagnostics and failure reason disagree");
    return { ok: reasons.length === 0, reasons };
  }

  if (!FINAL_STATUSES.has(artifact?.status))
    reasons.push("artifact status is invalid");
  if (
    !exactKeys(artifact, [
      "schema",
      "runId",
      "incomplete",
      "contract",
      "phaseOrder",
      "provenance",
      "control",
      "webgpu",
      "cleanup",
      "status",
      "exitCode",
      "reasons",
      "checks",
    ])
  )
    reasons.push("artifact top-level shape is invalid");
  const report = artifact && {
    schema: artifact.schema,
    runId: artifact.runId,
    incomplete: artifact.incomplete,
    contract: artifact.contract,
    phaseOrder: artifact.phaseOrder,
    provenance: artifact.provenance,
    control: artifact.control,
    webgpu: artifact.webgpu,
    cleanup: artifact.cleanup,
  };
  const verdict = foldC1229S5ReplacementDeviceGate(report);
  if (
    artifact?.status !== verdict.status ||
    artifact?.exitCode !== verdict.exitCode
  )
    reasons.push("artifact verdict does not match the fail-closed fold");
  if (
    !exactKeys(artifact?.reasons, ["structural", "failures"]) ||
    !sameJson(artifact?.reasons?.structural, verdict.structuralReasons) ||
    !sameJson(artifact?.reasons?.failures, verdict.failureReasons)
  )
    reasons.push("artifact reasons do not match the fold");
  if (
    !exactKeys(artifact?.checks, CHECK_KEYS) ||
    !sameJson(artifact?.checks, verdict.checks)
  )
    reasons.push("artifact checks do not match the fold");
  return { ok: reasons.length === 0, reasons };
}
