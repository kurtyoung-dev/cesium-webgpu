/**
 * C11-205 resident San Francisco CPU-owner attribution.
 * @purpose Frozen config plus fail-closed policy for the resident-SF CPU owner-attribution diagnostic; instrumented timings never recertify the causal artifact.
 * @status ACTIVE
 *
 * This module is deliberately browser/Node neutral. The campaign runner loads
 * it in the page for instance-local timing and in Node for fail-closed policy
 * assessment. Timings are synchronous, instrumented, diagnostic, and
 * noncausal. They must never replace or recertify the uninstrumented causal
 * campaign artifact.
 */

export const C11_205_OWNER_ATTRIBUTION_CONFIG = Object.freeze({
  schemaVersion: 1,
  mode: "cpu-owner-attribution",
  manifestFile:
    "Tools/visual-regression/performance-workloads-representative-warm.json",
  manifestSha256:
    "2E580A9E579FFF95093E208086480490FCA9D0C2EA0A1C898848FD68BFBCDBBB",
  manifestId: "fork-representative-resident-attribution-v1",
  workloadId: "moving-camera-representative-resident-terrain-assets-3d",
  trackId: "orbit-to-ground-global-v1",
  expectedTrackWaypoints: 9,
  renderer: "both",
  renderers: Object.freeze(["webgl", "webgpu"]),
  repetitions: 2,
  measuredFrames: 600,
  viewport: Object.freeze({
    width: 1280,
    height: 720,
    deviceScaleFactor: 1,
  }),
  resolutionScale: 1,
  fixedClock: "2026-06-21T08:00:00Z",
  expectedDirectModels: 48,
  expectedTilesets: 4,
  causalReference:
    "Tools/visual-regression/output/performance/c11-205-causal-phase-prime-fixed-2026-08-10.json",
  causalReferenceSha256:
    "606C397EACC515DD184E5B736606F36D3BF479CF330ED798C36FF920DB2041AF",
  diagnosticOutput:
    "Tools/visual-regression/output/performance/c11-169-resident-sf-owner-attribution.json",
  firstRedOutput:
    "Tools/visual-regression/output/performance/c11-169-resident-sf-owner-attribution.first-red.json",
  lockOutput:
    "Tools/visual-regression/output/performance/c11-169-resident-sf-owner-attribution.lock",
});

export const C11_205_SCENE_PHASE_NAMES = Object.freeze([
  "sceneUpdate",
  "frameState",
  "contextBegin",
  "sceneEnvironmentUpdate",
  "visibilityCommandPrep",
  "primitiveTraversal",
  "computeShadows",
  "rendererOverhead",
  "frameFinalize",
  "contextEndSubmit",
  "afterRenderCreditTrace",
]);

export const C11_205_OWNER_DETAIL_NAMES = Object.freeze([
  "groundPrimitiveUpdate",
  "ordinaryPrimitiveUpdate",
  "directModelUpdate",
  "tilesetUpdate",
  "globeRender",
]);

const CONSERVATION_EPSILON_MS = 0.05;
const NESTED_EPSILON_MS = 0.1;

function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function orderedZeroRecord() {
  return Object.fromEntries(
    C11_205_OWNER_DETAIL_NAMES.map((name) => [name, 0]),
  );
}

function exactOrderedKeys(value, expected) {
  if (!value || typeof value !== "object") return false;
  const actual = Object.keys(value);
  return (
    actual.length === expected.length &&
    actual.every((name, index) => name === expected[index])
  );
}

function cloneProfile(renderer) {
  if (!renderer || typeof renderer.getCpuPassProfile !== "function") {
    return null;
  }
  const profile = renderer.getCpuPassProfile();
  const last =
    profile?.lastFrame ?? profile?.frameAccounting?.lastFrame ?? null;
  return {
    enabled: profile?.enabled === true,
    frameCount: profile?.frameCount ?? null,
    frameAccounting: profile?.frameAccounting
      ? { ...profile.frameAccounting }
      : null,
    lastFrame: last
      ? {
          ...last,
          passMs: { ...(last.passMs ?? {}) },
          phaseMs: { ...(last.phaseMs ?? {}) },
        }
      : null,
  };
}

function descriptorsEqual(left, right) {
  if (!left || !right) return left === right;
  return (
    left.configurable === right.configurable &&
    left.enumerable === right.enumerable &&
    left.writable === right.writable &&
    left.value === right.value &&
    left.get === right.get &&
    left.set === right.set
  );
}

/**
 * Reject every configuration that could silently turn this bounded diagnostic
 * into a different workload or a certification-shaped campaign.
 */
export function evaluateC11205OwnerAttributionConfig(input = {}) {
  const config = C11_205_OWNER_ATTRIBUTION_CONFIG;
  const failures = [];
  const manifest = input.manifest ?? {};
  const protocol = manifest.protocol ?? {};
  const workload = input.workload ?? {};
  const options = input.options ?? {};
  const selectedWorkloadIds = input.selectedWorkloadIds ?? [];

  if (input.manifestRelativePath !== config.manifestFile) {
    failures.push(
      `manifest path ${input.manifestRelativePath ?? "<missing>"} != ${config.manifestFile}`,
    );
  }
  if (input.outputRelativePath !== config.diagnosticOutput) {
    failures.push(
      `output path ${input.outputRelativePath ?? "<missing>"} != ${config.diagnosticOutput}`,
    );
  }
  if (input.manifestSha256 !== config.manifestSha256) {
    failures.push(
      `manifest SHA256 ${input.manifestSha256 ?? "<missing>"} != ${config.manifestSha256}`,
    );
  }
  if (input.causalReferenceRelativePath !== config.causalReference) {
    failures.push(
      `causal reference path ${input.causalReferenceRelativePath ?? "<missing>"} != ${config.causalReference}`,
    );
  }
  if (input.causalReferenceSha256 !== config.causalReferenceSha256) {
    failures.push(
      `causal reference SHA256 ${input.causalReferenceSha256 ?? "<missing>"} != ${config.causalReferenceSha256}`,
    );
  }

  if (manifest.id !== config.manifestId) {
    failures.push(
      `manifest ${manifest.id ?? "<missing>"} != ${config.manifestId}`,
    );
  }
  if (options.renderer !== config.renderer) {
    failures.push(`renderer ${options.renderer ?? "<missing>"} != both`);
  }
  if (
    selectedWorkloadIds.length !== 1 ||
    selectedWorkloadIds[0] !== config.workloadId
  ) {
    failures.push(
      `workload selection ${JSON.stringify(selectedWorkloadIds)} != [${config.workloadId}]`,
    );
  }
  if (input.repetitions !== config.repetitions) {
    failures.push(
      `repetitions ${input.repetitions ?? "<missing>"} != ${config.repetitions}`,
    );
  }
  if (options.frames !== config.measuredFrames) {
    failures.push(
      `measured frames ${options.frames ?? "<missing>"} != ${config.measuredFrames}`,
    );
  }
  if (options.apiInstrumentation === true) {
    failures.push("API instrumentation must be disabled");
  }
  if (options.gpuTimestamps === true) {
    failures.push("GPU timestamps must be disabled");
  }
  if (options.reuseBrowser === true) {
    failures.push("browser reuse must be disabled");
  }
  if (options.headed === true) {
    failures.push("headed browser mode must be disabled");
  }

  const viewport = protocol.viewport ?? {};
  for (const [name, actual, expected] of [
    ["viewport.width", viewport.width, config.viewport.width],
    ["viewport.height", viewport.height, config.viewport.height],
    [
      "viewport.deviceScaleFactor",
      viewport.deviceScaleFactor,
      config.viewport.deviceScaleFactor,
    ],
    ["resolutionScale", protocol.resolutionScale, config.resolutionScale],
    ["protocol.measuredFrames", protocol.measuredFrames, config.measuredFrames],
    ["fixedClock", protocol.fixedClock, config.fixedClock],
  ]) {
    if (actual !== expected) {
      failures.push(`${name} ${actual ?? "<missing>"} != ${expected}`);
    }
  }

  for (const [name, actual, expected] of [
    ["workload.id", workload.id, config.workloadId],
    ["workload.mode", workload.mode, "3d"],
    ["workload.action", workload.action, "camera-track"],
    ["workload.content", workload.content, "terrain-models-tiles"],
    [
      "workload.contentProfile",
      workload.contentProfile,
      "local-procedural-terrain-assets",
    ],
    ["workload.featureProfile", workload.featureProfile, "default-globe"],
    ["workload.trackId", workload.trackId, config.trackId],
    ["workload.measuredFrames", workload.measuredFrames, config.measuredFrames],
    [
      "measurementTerrainMode",
      workload.representativeConfig?.measurementTerrainMode,
      "resident",
    ],
    [
      "routePrimeSamples",
      workload.representativeConfig?.routePrimeSamples,
      config.measuredFrames,
    ],
    [
      "validationWaypoint",
      workload.representativeConfig?.validationWaypoint,
      "ground-sf",
    ],
  ]) {
    if (actual !== expected) {
      failures.push(`${name} ${actual ?? "<missing>"} != ${expected}`);
    }
  }

  const directModelCount =
    (workload.representativeConfig?.models?.rows ?? 0) *
    (workload.representativeConfig?.models?.columns ?? 0);
  const tilesetCount =
    (workload.representativeConfig?.tilesets?.rows ?? 0) *
    (workload.representativeConfig?.tilesets?.columns ?? 0);
  if (directModelCount !== config.expectedDirectModels) {
    failures.push(
      `configured direct model count ${directModelCount} != ${config.expectedDirectModels}`,
    );
  }
  if (tilesetCount !== config.expectedTilesets) {
    failures.push(
      `configured tileset count ${tilesetCount} != ${config.expectedTilesets}`,
    );
  }

  return {
    pass: failures.length === 0,
    failures,
    diagnostic: true,
    noncausal: true,
    certificationEligible: false,
  };
}

export function createC11205OwnerAttributionLockRecord(runId, acquiredAt) {
  return {
    schemaVersion: C11_205_OWNER_ATTRIBUTION_CONFIG.schemaVersion,
    mode: C11_205_OWNER_ATTRIBUTION_CONFIG.mode,
    runId,
    acquiredAt,
  };
}

export function ownsC11205OwnerAttributionLock(record, runId) {
  return (
    record?.schemaVersion === C11_205_OWNER_ATTRIBUTION_CONFIG.schemaVersion &&
    record?.mode === C11_205_OWNER_ATTRIBUTION_CONFIG.mode &&
    typeof runId === "string" &&
    runId.length > 0 &&
    record?.runId === runId
  );
}

export function createC11205OwnerAttributionRunningMarker({
  runId,
  generatedAt,
}) {
  return {
    schemaVersion: 1,
    kind: "fork-performance-campaign",
    runId,
    generatedAt,
    result: "running",
    status: "RUNNING",
    incomplete: true,
    pass: null,
    exitCode: null,
    cpuOwnerAttribution: {
      schemaVersion: C11_205_OWNER_ATTRIBUTION_CONFIG.schemaVersion,
      objective:
        "Diagnose C11-169 CPU ownership on the prior C11-205 resident San Francisco workload",
      diagnostic: true,
      noncausal: true,
      attributionOnly: true,
      certificationEligible: false,
      status: "RUNNING",
      incomplete: true,
      pass: null,
      exitCode: null,
      lock: {
        path: C11_205_OWNER_ATTRIBUTION_CONFIG.lockOutput,
        ownedByRunId: runId,
        staleRecovery:
          "A crashed run deliberately leaves this lock and RUNNING marker fail-closed; verify no owner process remains, then remove the lock manually before retrying.",
      },
    },
  };
}

export function ownerAttributionFirstRedLookupDecision(error = null) {
  if (error === null) {
    return { existedBefore: true, lookupError: null };
  }
  if (error?.code === "ENOENT") {
    return { existedBefore: false, lookupError: null };
  }
  return {
    existedBefore: null,
    lookupError: String(error?.stack ?? error),
  };
}

/**
 * Install exact instance-local timers for the measured owner categories.
 *
 * Direct-model and tileset buckets are nested subsets of ordinary primitives;
 * they are never added beside their parent. WebGPU additionally captures the
 * production profiler's exact lastFrame after Scene.render returns. WebGL
 * records no synthetic phase or pass fields.
 */
export function createC11205OwnerAttributionCollector({
  scene,
  renderer,
  actualRenderer,
  directModels,
  tilesets,
  metadataProvider = () => ({}),
}) {
  if (!scene || !["webgl", "webgpu"].includes(actualRenderer)) {
    throw new Error("owner attribution requires a Scene and resolved renderer");
  }
  const models = Array.isArray(directModels) ? directModels : [];
  const tileSets = Array.isArray(tilesets) ? tilesets : [];
  const restorations = [];
  const detailsByFrame = new Map();
  const capturedSceneFrames = new Set();
  const pendingCaptures = new Set();
  const frames = [];
  const instrumentation = {
    mode: "tools-instance-wrappers",
    installed: false,
    restored: false,
    targets: [],
  };
  const captureDiagnostics = {
    postRenderRecords: 0,
    microtasksQueued: 0,
    microtasksCompleted: 0,
    missingDetailRecords: 0,
    duplicateSceneFrames: 0,
    missingProfilerRecords: 0,
    mismatchedProfilerSceneFrames: 0,
    leftoverDetailRecords: 0,
    nonzeroOrdinaryPrimitiveDepthFrames: 0,
    errors: [],
  };
  let active = false;
  let removePostRender;
  let profilerBefore = null;
  let profilerStart = null;
  let profilerEnd = null;
  let profilerAfter = null;
  let profilerEnableAttempted = false;
  let profilerEnabledByCollector = false;
  let stopPromise = null;
  let ordinaryPrimitiveDepth = 0;
  const cleanupErrors = [];

  const emptyDetail = () => ({
    detailMs: orderedZeroRecord(),
    hits: orderedZeroRecord(),
    targetHits: Array(instrumentation.targets.length).fill(0),
    outOfOrdinaryPrimitiveCalls: 0,
  });

  const ensureDetail = (frameNumber) => {
    let detail = detailsByFrame.get(frameNumber);
    if (!detail) {
      detail = emptyDetail();
      detailsByFrame.set(frameNumber, detail);
    }
    return detail;
  };

  const installTimedWrapper = (
    owner,
    methodName,
    detailName,
    ownerLabel,
    ownerIndex = null,
  ) => {
    const original = owner?.[methodName];
    if (typeof original !== "function") {
      throw new Error(
        `owner detail ${detailName} missing ${ownerLabel}.${methodName}`,
      );
    }
    const hadOwn = Object.prototype.hasOwnProperty.call(owner, methodName);
    const descriptor = hadOwn
      ? Object.getOwnPropertyDescriptor(owner, methodName)
      : undefined;
    const targetIndex = instrumentation.targets.length;
    const isOrdinaryPrimitiveOwner =
      ownerLabel === "scene._primitives" &&
      detailName === "ordinaryPrimitiveUpdate";
    const requiresOrdinaryPrimitiveParent =
      detailName === "directModelUpdate" || detailName === "tilesetUpdate";
    const wrapper = function (...args) {
      if (!active) return original.apply(this, args);
      const frameNumber =
        args[0]?.frameNumber ?? scene.frameState?.frameNumber ?? null;
      if (!Number.isInteger(frameNumber)) {
        throw new Error(`${ownerLabel}.${methodName} had no frame number`);
      }
      const detail = ensureDetail(frameNumber);
      detail.hits[detailName]++;
      detail.targetHits[targetIndex]++;
      if (requiresOrdinaryPrimitiveParent && ordinaryPrimitiveDepth === 0) {
        detail.outOfOrdinaryPrimitiveCalls++;
      }
      const ordinaryPrimitiveDepthBefore = ordinaryPrimitiveDepth;
      if (isOrdinaryPrimitiveOwner) ordinaryPrimitiveDepth++;
      const start = performance.now();
      try {
        return original.apply(this, args);
      } finally {
        detail.detailMs[detailName] += performance.now() - start;
        if (isOrdinaryPrimitiveOwner) {
          ordinaryPrimitiveDepth = ordinaryPrimitiveDepthBefore;
        }
      }
    };
    owner[methodName] = wrapper;
    const target = {
      targetIndex,
      owner: ownerLabel,
      ownerIndex,
      methodName,
      detailName,
      hadOwn,
      installedExact: owner[methodName] === wrapper,
      restoredExact: false,
      descriptorRestoredExact: false,
    };
    instrumentation.targets.push(target);
    restorations.push({
      owner,
      methodName,
      original,
      wrapper,
      hadOwn,
      descriptor,
      target,
    });
  };

  const restore = () => {
    let restored = true;
    for (let index = restorations.length - 1; index >= 0; index--) {
      const entry = restorations[index];
      try {
        if (entry.hadOwn) {
          Object.defineProperty(
            entry.owner,
            entry.methodName,
            entry.descriptor,
          );
        } else {
          delete entry.owner[entry.methodName];
        }
      } catch (error) {
        cleanupErrors.push(
          `restore ${entry.target.owner}[${entry.target.ownerIndex ?? "-"}].${entry.methodName}: ${String(error?.stack ?? error)}`,
        );
        restored = false;
      }
      const hasOwn = Object.prototype.hasOwnProperty.call(
        entry.owner,
        entry.methodName,
      );
      const descriptorNow = hasOwn
        ? Object.getOwnPropertyDescriptor(entry.owner, entry.methodName)
        : undefined;
      entry.target.restoredExact =
        entry.owner[entry.methodName] === entry.original &&
        hasOwn === entry.hadOwn;
      entry.target.descriptorRestoredExact = entry.hadOwn
        ? descriptorsEqual(descriptorNow, entry.descriptor)
        : descriptorNow === undefined;
      restored =
        restored &&
        entry.target.restoredExact &&
        entry.target.descriptorRestoredExact;
    }
    instrumentation.restored = restored;
  };

  const removeListener = () => {
    if (!removePostRender) return;
    try {
      removePostRender();
    } catch (error) {
      cleanupErrors.push(
        `remove postRender listener: ${String(error?.stack ?? error)}`,
      );
    } finally {
      removePostRender = undefined;
    }
  };

  const disableProfiler = () => {
    if (actualRenderer !== "webgpu" || !profilerEnableAttempted) return;
    try {
      renderer.setCpuPassProfiling(false);
      profilerEnabledByCollector = false;
    } catch (error) {
      cleanupErrors.push(
        `disable WebGPU CPU profiler: ${String(error?.stack ?? error)}`,
      );
    }
  };

  const cleanupAfterStartFailure = () => {
    active = false;
    removeListener();
    disableProfiler();
    restore();
  };

  const normalizeCapturedFrame = (
    expectedSceneFrameNumber,
    metadata,
    detail,
    profile,
  ) => {
    const base = {
      ...metadata,
      expectedSceneFrameNumber,
      detailMs: { ...detail.detailMs },
      hits: { ...detail.hits },
      targetHits: [...detail.targetHits],
      outOfOrdinaryPrimitiveCalls: detail.outOfOrdinaryPrimitiveCalls,
    };
    if (actualRenderer === "webgl") {
      return base;
    }
    const last = profile?.lastFrame;
    if (!last) {
      captureDiagnostics.missingProfilerRecords++;
      return { ...base, structuralError: "missing exact WebGPU lastFrame" };
    }
    if (last.sceneFrameNumber !== expectedSceneFrameNumber) {
      captureDiagnostics.mismatchedProfilerSceneFrames++;
    }
    return {
      ...base,
      sequence: last.sequence,
      sceneFrameNumber: last.sceneFrameNumber,
      kind: last.kind,
      totalMs: last.totalMs,
      profiledPassMs: last.profiledPassMs,
      unaccountedMs: last.unaccountedMs,
      overlapMs: last.overlapMs,
      coverageRatio: last.coverageRatio,
      valid: last.valid,
      passMs: { ...(last.passMs ?? {}) },
      phaseAttributionEnabled: last.phaseAttributionEnabled,
      phaseMs: { ...(last.phaseMs ?? {}) },
      phaseTotalMs: last.phaseTotalMs,
      unattributedMs: last.unattributedMs,
      attributionOverlapMs: last.attributionOverlapMs,
      attributionValid: last.attributionValid,
    };
  };

  const queueCapture = (expectedSceneFrameNumber, metadata, detail) => {
    captureDiagnostics.microtasksQueued++;
    const pending = Promise.resolve()
      .then(() => {
        const profile =
          actualRenderer === "webgpu" ? cloneProfile(renderer) : null;
        frames.push(
          normalizeCapturedFrame(
            expectedSceneFrameNumber,
            metadata,
            detail,
            profile,
          ),
        );
      })
      .catch((error) => {
        captureDiagnostics.errors.push(String(error?.stack ?? error));
      })
      .finally(() => {
        captureDiagnostics.microtasksCompleted++;
        pendingCaptures.delete(pending);
      });
    pendingCaptures.add(pending);
  };

  const onPostRender = () => {
    if (!active) return;
    captureDiagnostics.postRenderRecords++;
    const sceneFrameNumber = scene.frameState?.frameNumber ?? null;
    if (!Number.isInteger(sceneFrameNumber)) {
      captureDiagnostics.missingDetailRecords++;
      return;
    }
    if (capturedSceneFrames.has(sceneFrameNumber)) {
      captureDiagnostics.duplicateSceneFrames++;
    }
    capturedSceneFrames.add(sceneFrameNumber);
    if (ordinaryPrimitiveDepth !== 0) {
      captureDiagnostics.nonzeroOrdinaryPrimitiveDepthFrames ??= 0;
      captureDiagnostics.nonzeroOrdinaryPrimitiveDepthFrames++;
    }
    const detail = detailsByFrame.get(sceneFrameNumber);
    if (!detail) captureDiagnostics.missingDetailRecords++;
    detailsByFrame.delete(sceneFrameNumber);
    const metadata = { ...(metadataProvider?.() ?? {}) };
    queueCapture(sceneFrameNumber, metadata, detail ?? emptyDetail());
  };

  const install = () => {
    try {
      installTimedWrapper(
        scene._groundPrimitives,
        "update",
        "groundPrimitiveUpdate",
        "scene._groundPrimitives",
      );
      installTimedWrapper(
        scene._primitives,
        "update",
        "ordinaryPrimitiveUpdate",
        "scene._primitives",
      );
      for (let index = 0; index < models.length; index++) {
        installTimedWrapper(
          models[index],
          "update",
          "directModelUpdate",
          "representativeAssets.models",
          index,
        );
      }
      for (let index = 0; index < tileSets.length; index++) {
        installTimedWrapper(
          tileSets[index],
          "update",
          "tilesetUpdate",
          "representativeAssets.tilesets",
          index,
        );
      }
      installTimedWrapper(
        scene._globe,
        "render",
        "globeRender",
        "scene._globe",
      );
      removePostRender = scene.postRender.addEventListener(onPostRender);
      instrumentation.installed = instrumentation.targets.every(
        (target) => target.installedExact,
      );
    } catch (error) {
      restore();
      throw error;
    }
  };

  return {
    start() {
      if (active || instrumentation.installed) {
        throw new Error("owner attribution collector already started");
      }
      if (
        models.length !==
          C11_205_OWNER_ATTRIBUTION_CONFIG.expectedDirectModels ||
        tileSets.length !== C11_205_OWNER_ATTRIBUTION_CONFIG.expectedTilesets
      ) {
        throw new Error(
          `owner attribution assets ${models.length} models/${tileSets.length} tilesets did not match ` +
            `${C11_205_OWNER_ATTRIBUTION_CONFIG.expectedDirectModels}/${C11_205_OWNER_ATTRIBUTION_CONFIG.expectedTilesets}`,
        );
      }
      const targetOwners = [
        scene._groundPrimitives,
        scene._primitives,
        ...models,
        ...tileSets,
        scene._globe,
      ];
      if (new Set(targetOwners).size !== targetOwners.length) {
        throw new Error(
          "owner attribution requires 55 distinct ground, ordinary, model, tileset, and globe owner identities",
        );
      }
      if (actualRenderer === "webgpu") {
        if (
          typeof renderer?.setCpuPassProfiling !== "function" ||
          typeof renderer?.getCpuPassProfile !== "function"
        ) {
          throw new Error("WebGPU CPU pass profiler unavailable");
        }
        profilerBefore = cloneProfile(renderer);
        if (profilerBefore?.enabled !== false) {
          throw new Error(
            "WebGPU CPU pass profiler was not disabled by default",
          );
        }
      }
      try {
        install();
        if (actualRenderer === "webgpu") {
          profilerEnableAttempted = true;
          renderer.setCpuPassProfiling(true);
          profilerEnabledByCollector = true;
          profilerStart = cloneProfile(renderer);
          if (profilerStart?.enabled !== true) {
            throw new Error("WebGPU CPU pass profiler did not enable");
          }
        }
        active = true;
        return {
          actualRenderer,
          modelCount: models.length,
          tilesetCount: tileSets.length,
          profilerBefore,
          profilerStart,
        };
      } catch (error) {
        cleanupAfterStartFailure();
        throw error;
      }
    },

    async stop({ aborted = false } = {}) {
      if (stopPromise) return stopPromise;
      stopPromise = (async () => {
        active = false;
        removeListener();
        const captureSettlements = await Promise.allSettled([
          ...pendingCaptures,
        ]);
        for (const settlement of captureSettlements) {
          if (settlement.status === "rejected") {
            cleanupErrors.push(
              `capture microtask: ${String(settlement.reason?.stack ?? settlement.reason)}`,
            );
          }
        }
        if (actualRenderer === "webgpu") {
          try {
            profilerEnd = cloneProfile(renderer);
          } catch (error) {
            cleanupErrors.push(
              `snapshot WebGPU CPU profiler end: ${String(error?.stack ?? error)}`,
            );
          }
        }
        disableProfiler();
        restore();
        captureDiagnostics.leftoverDetailRecords = detailsByFrame.size;
        detailsByFrame.clear();
        if (actualRenderer === "webgpu") {
          try {
            profilerAfter = cloneProfile(renderer);
          } catch (error) {
            cleanupErrors.push(
              `snapshot WebGPU CPU profiler after: ${String(error?.stack ?? error)}`,
            );
          }
        }
        return {
          schemaVersion: C11_205_OWNER_ATTRIBUTION_CONFIG.schemaVersion,
          mode: C11_205_OWNER_ATTRIBUTION_CONFIG.mode,
          diagnostic: true,
          noncausal: true,
          certificationEligible: false,
          actualRenderer,
          aborted,
          expected: {
            frames: C11_205_OWNER_ATTRIBUTION_CONFIG.measuredFrames,
            directModels: models.length,
            tilesets: tileSets.length,
          },
          instrumentation,
          captureDiagnostics,
          cleanup: {
            profilerEnableAttempted,
            profilerEnabledByCollector,
            ordinaryPrimitiveDepthAfterStop: ordinaryPrimitiveDepth,
            errors: cleanupErrors.slice(),
          },
          phaseAccounting: {
            available: actualRenderer === "webgpu",
          },
          profiler: {
            applicable: actualRenderer === "webgpu",
            before: profilerBefore,
            start: profilerStart,
            end: profilerEnd,
            after: profilerAfter,
          },
          frames,
        };
      })();
      return stopPromise;
    },
  };
}

function accountingResidual(frame) {
  return (
    frame.totalMs + frame.overlapMs - frame.profiledPassMs - frame.unaccountedMs
  );
}

function attributionResidual(frame) {
  return (
    frame.totalMs +
    frame.attributionOverlapMs -
    frame.profiledPassMs -
    frame.phaseTotalMs -
    frame.unattributedMs
  );
}

function bridgeResidual(frame) {
  return (
    frame.unaccountedMs +
    frame.attributionOverlapMs -
    frame.phaseTotalMs -
    frame.unattributedMs -
    frame.overlapMs
  );
}

function sumValues(value) {
  return Object.values(value ?? {}).reduce(
    (sum, entry) => sum + (isFiniteNumber(entry) ? entry : 0),
    0,
  );
}

function percentile(values, fraction) {
  const sorted = values.filter(isFiniteNumber).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.floor((sorted.length - 1) * fraction)),
  );
  return sorted[index];
}

function summarize(values) {
  const finite = values.filter(isFiniteNumber);
  if (finite.length === 0) return null;
  return {
    samples: finite.length,
    min: Math.min(...finite),
    median: percentile(finite, 0.5),
    p95: percentile(finite, 0.95),
    max: Math.max(...finite),
    mean: finite.reduce((sum, value) => sum + value, 0) / finite.length,
  };
}

/** Assess exact frame binding, owner nesting, WebGPU ledger, and cleanup. */
export function assessC11205OwnerAttribution(
  raw,
  { traceSamples = [], trackEvidence = [] } = {},
) {
  const failures = [];
  const expectedFrames = C11_205_OWNER_ATTRIBUTION_CONFIG.measuredFrames;
  const expectedModels = C11_205_OWNER_ATTRIBUTION_CONFIG.expectedDirectModels;
  const expectedTilesets = C11_205_OWNER_ATTRIBUTION_CONFIG.expectedTilesets;
  const expectedTrackWaypoints =
    C11_205_OWNER_ATTRIBUTION_CONFIG.expectedTrackWaypoints;
  const expectedTrackSegments = expectedTrackWaypoints - 1;
  const expectedSamplesPerSegment = expectedFrames / expectedTrackSegments;
  const renderer = raw?.actualRenderer;
  const frames = Array.isArray(raw?.frames) ? raw.frames : [];
  const diagnostics = raw?.captureDiagnostics ?? {};

  if (!raw || !["webgl", "webgpu"].includes(renderer)) {
    failures.push("owner attribution result or renderer is missing");
  }
  if (
    raw?.schemaVersion !== C11_205_OWNER_ATTRIBUTION_CONFIG.schemaVersion ||
    raw?.mode !== C11_205_OWNER_ATTRIBUTION_CONFIG.mode
  ) {
    failures.push("owner attribution schemaVersion/mode is invalid");
  }
  if (raw?.diagnostic !== true || raw?.noncausal !== true) {
    failures.push("owner attribution was not labeled diagnostic/noncausal");
  }
  if (raw?.certificationEligible !== false) {
    failures.push(
      "owner attribution incorrectly claimed certification eligibility",
    );
  }
  if (raw?.aborted !== false)
    failures.push("owner attribution collector aborted");
  if (
    raw?.expected?.frames !== expectedFrames ||
    raw?.expected?.directModels !== expectedModels ||
    raw?.expected?.tilesets !== expectedTilesets
  ) {
    failures.push("owner attribution expected N/48/4 contract is invalid");
  }
  if (raw?.instrumentation?.installed !== true) {
    failures.push("owner attribution wrappers were not installed exactly");
  }
  if (raw?.instrumentation?.restored !== true) {
    failures.push("owner attribution wrappers were not restored exactly");
  }
  const targets = raw?.instrumentation?.targets ?? [];
  const expectedTargets = [
    {
      owner: "scene._groundPrimitives",
      ownerIndex: null,
      methodName: "update",
      detailName: "groundPrimitiveUpdate",
    },
    {
      owner: "scene._primitives",
      ownerIndex: null,
      methodName: "update",
      detailName: "ordinaryPrimitiveUpdate",
    },
    ...Array.from({ length: expectedModels }, (_, ownerIndex) => ({
      owner: "representativeAssets.models",
      ownerIndex,
      methodName: "update",
      detailName: "directModelUpdate",
    })),
    ...Array.from({ length: expectedTilesets }, (_, ownerIndex) => ({
      owner: "representativeAssets.tilesets",
      ownerIndex,
      methodName: "update",
      detailName: "tilesetUpdate",
    })),
    {
      owner: "scene._globe",
      ownerIndex: null,
      methodName: "render",
      detailName: "globeRender",
    },
  ].map((target, targetIndex) => ({ targetIndex, ...target }));
  if (targets.length !== expectedTargets.length) {
    failures.push(
      `instrumentation target count ${targets.length} != ${expectedTargets.length}`,
    );
  }
  for (let index = 0; index < expectedTargets.length; index++) {
    const target = targets[index];
    const expected = expectedTargets[index];
    if (
      target?.owner !== expected.owner ||
      target?.targetIndex !== expected.targetIndex ||
      (target?.ownerIndex ?? null) !== expected.ownerIndex ||
      target?.methodName !== expected.methodName ||
      target?.detailName !== expected.detailName
    ) {
      failures.push(
        `instrumentation target[${index}] schema ${JSON.stringify(target)} != ${JSON.stringify(expected)}`,
      );
    }
    if (
      target?.installedExact !== true ||
      target?.restoredExact !== true ||
      target?.descriptorRestoredExact !== true
    ) {
      failures.push(`instrumentation target[${index}] did not restore exactly`);
    }
  }
  if ((raw?.cleanup?.errors?.length ?? -1) !== 0) {
    failures.push(
      `owner attribution cleanup had ${raw?.cleanup?.errors?.length ?? "<missing>"} errors`,
    );
  }
  if (raw?.cleanup?.ordinaryPrimitiveDepthAfterStop !== 0) {
    failures.push(
      `ordinary primitive depth after stop ${raw?.cleanup?.ordinaryPrimitiveDepthAfterStop ?? "<missing>"} != 0`,
    );
  }
  for (const [name, value] of [
    ["postRenderRecords", diagnostics.postRenderRecords],
    ["microtasksQueued", diagnostics.microtasksQueued],
    ["microtasksCompleted", diagnostics.microtasksCompleted],
  ]) {
    if (value !== expectedFrames) {
      failures.push(`${name} ${value ?? "<missing>"} != ${expectedFrames}`);
    }
  }
  for (const name of [
    "missingDetailRecords",
    "duplicateSceneFrames",
    "missingProfilerRecords",
    "mismatchedProfilerSceneFrames",
    "leftoverDetailRecords",
    "nonzeroOrdinaryPrimitiveDepthFrames",
  ]) {
    if ((diagnostics[name] ?? -1) !== 0) {
      failures.push(`${name} ${diagnostics[name] ?? "<missing>"} != 0`);
    }
  }
  if ((diagnostics.errors?.length ?? -1) !== 0) {
    failures.push(
      `capture microtasks had ${diagnostics.errors?.length ?? "<missing>"} errors`,
    );
  }
  if (frames.length !== expectedFrames) {
    failures.push(`captured ${frames.length}/${expectedFrames} owner frames`);
  }
  if (traceSamples.length !== expectedFrames) {
    failures.push(`trace has ${traceSamples.length}/${expectedFrames} frames`);
  }
  if (trackEvidence.length !== expectedFrames) {
    failures.push(
      `route evidence has ${trackEvidence.length}/${expectedFrames} frames`,
    );
  }

  const sequences = new Set();
  const sceneFrames = new Set();
  let previousSequence = null;
  let previousSceneFrame = null;
  const detailValues = Object.fromEntries(
    C11_205_OWNER_DETAIL_NAMES.map((name) => [name, []]),
  );
  const ownerPositiveSampleCounts = Object.fromEntries(
    C11_205_OWNER_DETAIL_NAMES.map((name) => [name, 0]),
  );
  const phasePositiveSampleCounts = Object.fromEntries(
    C11_205_SCENE_PHASE_NAMES.map((name) => [name, 0]),
  );
  const namedPassPositiveSampleCounts = {};
  let positiveNamedPassProfilerFrames = 0;
  const primitiveResidualValues = [];
  const ordinaryNonAssetResidualValues = [];
  const webglSceneResidualValues = [];
  const ownerSegmentSampleCounts = Array(expectedTrackSegments).fill(0);
  const routeSegmentSampleCounts = Array(expectedTrackSegments).fill(0);

  for (let index = 0; index < frames.length; index++) {
    const frame = frames[index];
    const label = `frame[${index}]`;
    const trace = traceSamples[index];
    const route = trackEvidence[index];
    if (!exactOrderedKeys(frame.detailMs, C11_205_OWNER_DETAIL_NAMES)) {
      failures.push(`${label}: detail schema was not the exact ordered set`);
    }
    if (!exactOrderedKeys(frame.hits, C11_205_OWNER_DETAIL_NAMES)) {
      failures.push(`${label}: hit schema was not the exact ordered set`);
    }
    const expectedHits = {
      groundPrimitiveUpdate: 1,
      ordinaryPrimitiveUpdate: 1,
      directModelUpdate: expectedModels,
      tilesetUpdate: expectedTilesets,
      globeRender: 1,
    };
    for (const name of C11_205_OWNER_DETAIL_NAMES) {
      const duration = frame.detailMs?.[name];
      if (!isFiniteNumber(duration) || duration < 0) {
        failures.push(`${label}: ${name} duration is invalid`);
      } else {
        detailValues[name].push(duration);
        if (duration > 0) ownerPositiveSampleCounts[name]++;
      }
      if (frame.hits?.[name] !== expectedHits[name]) {
        failures.push(
          `${label}: ${name} hits ${frame.hits?.[name]} != ${expectedHits[name]}`,
        );
      }
    }
    if (
      !Array.isArray(frame.targetHits) ||
      frame.targetHits.length !== expectedTargets.length
    ) {
      failures.push(
        `${label}: target-hit vector length ${frame.targetHits?.length ?? "<missing>"} != ${expectedTargets.length}`,
      );
    } else {
      for (
        let targetIndex = 0;
        targetIndex < expectedTargets.length;
        targetIndex++
      ) {
        if (frame.targetHits[targetIndex] !== 1) {
          failures.push(
            `${label}: targetHits[${targetIndex}] ${frame.targetHits[targetIndex]} != 1`,
          );
        }
      }
    }
    if (frame.outOfOrdinaryPrimitiveCalls !== 0) {
      failures.push(
        `${label}: out-of-ordinary primitive calls ${frame.outOfOrdinaryPrimitiveCalls ?? "<missing>"} != 0`,
      );
    }
    const expectedSceneFrame = frame.expectedSceneFrameNumber;
    if (!Number.isInteger(expectedSceneFrame)) {
      failures.push(`${label}: expected scene frame is invalid`);
    }
    if (sceneFrames.has(expectedSceneFrame)) {
      failures.push(
        `${label}: duplicate expected scene frame ${expectedSceneFrame}`,
      );
    }
    sceneFrames.add(expectedSceneFrame);
    if (
      previousSceneFrame !== null &&
      expectedSceneFrame !== previousSceneFrame + 1
    ) {
      failures.push(`${label}: scene frame sequence was not contiguous`);
    }
    previousSceneFrame = expectedSceneFrame;
    if (trace?.frameNumber !== expectedSceneFrame) {
      failures.push(
        `${label}: trace frame ${trace?.frameNumber} != owner frame ${expectedSceneFrame}`,
      );
    }
    if (!isFiniteNumber(trace?.cpuMs) || trace.cpuMs < 0) {
      failures.push(`${label}: trace.cpuMs is not finite/nonnegative`);
    }
    const expectedProgress =
      expectedFrames <= 1 ? 0 : index / (expectedFrames - 1);
    const scaledSegmentProgress = expectedProgress * expectedTrackSegments;
    const expectedSegmentIndex = Math.min(
      expectedTrackSegments - 1,
      Math.floor(scaledSegmentProgress),
    );
    const expectedSegmentProgress =
      scaledSegmentProgress - expectedSegmentIndex;
    if (frame.routeProgress !== route?.routeProgress) {
      failures.push(`${label}: owner/route progress did not match exactly`);
    }
    if (
      !isFiniteNumber(frame.routeProgress) ||
      frame.routeProgress !== expectedProgress
    ) {
      failures.push(`${label}: route progress did not equal index/(N-1)`);
    }
    if (!Number.isInteger(frame.segmentIndex)) {
      failures.push(`${label}: owner segmentIndex is not an integer`);
    } else if (
      frame.segmentIndex >= 0 &&
      frame.segmentIndex < expectedTrackSegments
    ) {
      ownerSegmentSampleCounts[frame.segmentIndex]++;
    }
    if (!Number.isInteger(route?.segmentIndex)) {
      failures.push(`${label}: route segmentIndex is not an integer`);
    } else if (
      route.segmentIndex >= 0 &&
      route.segmentIndex < expectedTrackSegments
    ) {
      routeSegmentSampleCounts[route.segmentIndex]++;
    }
    if (frame.segmentIndex !== route?.segmentIndex) {
      failures.push(`${label}: owner/route segmentIndex did not match exactly`);
    }
    if (frame.segmentIndex !== expectedSegmentIndex) {
      failures.push(
        `${label}: segmentIndex did not match the ${expectedTrackWaypoints}-waypoint route formula`,
      );
    }
    if (!isFiniteNumber(frame.segmentProgress)) {
      failures.push(`${label}: owner segmentProgress is not finite`);
    }
    if (!isFiniteNumber(route?.segmentProgress)) {
      failures.push(`${label}: route segmentProgress is not finite`);
    }
    if (frame.segmentProgress !== route?.segmentProgress) {
      failures.push(
        `${label}: owner/route segmentProgress did not match exactly`,
      );
    }
    if (frame.segmentProgress !== expectedSegmentProgress) {
      failures.push(
        `${label}: segmentProgress did not match the ${expectedTrackWaypoints}-waypoint route formula`,
      );
    }

    const ordinaryMs = frame.detailMs?.ordinaryPrimitiveUpdate;
    const directModelMs = frame.detailMs?.directModelUpdate;
    const tilesetMs = frame.detailMs?.tilesetUpdate;
    const ordinaryNonAssetResidualMs = ordinaryMs - directModelMs - tilesetMs;
    if (
      !isFiniteNumber(ordinaryNonAssetResidualMs) ||
      ordinaryNonAssetResidualMs < -NESTED_EPSILON_MS
    ) {
      failures.push(`${label}: ordinary nested-owner residual is invalid`);
    }
    ordinaryNonAssetResidualValues.push(ordinaryNonAssetResidualMs);

    if (renderer === "webgl") {
      const webglSceneResidualMs =
        trace?.cpuMs -
        frame.detailMs?.groundPrimitiveUpdate -
        frame.detailMs?.ordinaryPrimitiveUpdate -
        frame.detailMs?.globeRender;
      if (
        !isFiniteNumber(webglSceneResidualMs) ||
        webglSceneResidualMs < -NESTED_EPSILON_MS
      ) {
        failures.push(
          `${label}: WebGL owner timing did not nest in trace.cpuMs`,
        );
      }
      webglSceneResidualValues.push(webglSceneResidualMs);
      for (const forbidden of [
        "structuralError",
        "sequence",
        "sceneFrameNumber",
        "kind",
        "totalMs",
        "profiledPassMs",
        "unaccountedMs",
        "overlapMs",
        "coverageRatio",
        "valid",
        "passMs",
        "phaseAttributionEnabled",
        "phaseMs",
        "phaseTotalMs",
        "unattributedMs",
        "attributionOverlapMs",
        "attributionValid",
      ]) {
        if (Object.prototype.hasOwnProperty.call(frame, forbidden)) {
          failures.push(
            `${label}: WebGL synthesized profiler field ${forbidden}`,
          );
        }
      }
      continue;
    }

    if (frame.structuralError) {
      failures.push(`${label}: ${frame.structuralError}`);
      continue;
    }
    if (frame.sceneFrameNumber !== expectedSceneFrame) {
      failures.push(`${label}: profiler/owner scene frame mismatch`);
    }
    if (!Number.isInteger(frame.sequence)) {
      failures.push(`${label}: profiler sequence is invalid`);
    } else {
      if (sequences.has(frame.sequence)) {
        failures.push(
          `${label}: duplicate profiler sequence ${frame.sequence}`,
        );
      }
      if (
        previousSequence !== null &&
        frame.sequence !== previousSequence + 1
      ) {
        failures.push(`${label}: profiler sequence was not contiguous`);
      }
      sequences.add(frame.sequence);
      previousSequence = frame.sequence;
    }
    if (
      frame.kind !== "scene" ||
      frame.valid !== true ||
      frame.phaseAttributionEnabled !== true ||
      frame.attributionValid !== true
    ) {
      failures.push(`${label}: WebGPU ledger validity flags failed`);
    }
    if (
      isFiniteNumber(frame.totalMs) &&
      isFiniteNumber(trace?.cpuMs) &&
      frame.totalMs < trace.cpuMs - NESTED_EPSILON_MS
    ) {
      failures.push(
        `${label}: WebGPU profiler total did not enclose trace.cpuMs`,
      );
    }
    if (!exactOrderedKeys(frame.phaseMs, C11_205_SCENE_PHASE_NAMES)) {
      failures.push(
        `${label}: phase schema was not the exact fixed 11-key set`,
      );
    }
    let frameHasPositiveNamedPass = false;
    for (const [name, value] of Object.entries(frame.passMs ?? {})) {
      if (!isFiniteNumber(value) || value < 0) {
        failures.push(`${label}: pass ${name} is invalid`);
      } else if (value > 0) {
        frameHasPositiveNamedPass = true;
        namedPassPositiveSampleCounts[name] =
          (namedPassPositiveSampleCounts[name] ?? 0) + 1;
      }
    }
    for (const [name, value] of Object.entries(frame.phaseMs ?? {})) {
      if (!isFiniteNumber(value) || value < 0) {
        failures.push(`${label}: phase ${name} is invalid`);
      } else if (value > 0 && name in phasePositiveSampleCounts) {
        phasePositiveSampleCounts[name]++;
      }
    }
    if (frame.profiledPassMs > 0 && frameHasPositiveNamedPass) {
      positiveNamedPassProfilerFrames++;
    }
    for (const field of [
      "totalMs",
      "profiledPassMs",
      "unaccountedMs",
      "overlapMs",
      "coverageRatio",
      "phaseTotalMs",
      "unattributedMs",
      "attributionOverlapMs",
    ]) {
      if (!isFiniteNumber(frame[field]) || frame[field] < 0) {
        failures.push(`${label}: ${field} is invalid`);
      }
    }
    const expectedCoverage =
      frame.totalMs > 0
        ? frame.profiledPassMs / frame.totalMs
        : frame.profiledPassMs === 0
          ? 1
          : Infinity;
    if (
      frame.coverageRatio < 0 ||
      frame.coverageRatio > 1 + CONSERVATION_EPSILON_MS ||
      !isFiniteNumber(expectedCoverage) ||
      Math.abs(frame.coverageRatio - expectedCoverage) > CONSERVATION_EPSILON_MS
    ) {
      failures.push(`${label}: WebGPU coverage ratio semantics failed`);
    }
    if (
      Math.abs(accountingResidual(frame)) > CONSERVATION_EPSILON_MS ||
      Math.abs(attributionResidual(frame)) > CONSERVATION_EPSILON_MS ||
      Math.abs(bridgeResidual(frame)) > CONSERVATION_EPSILON_MS
    ) {
      failures.push(`${label}: WebGPU accounting conservation failed`);
    }
    if (
      frame.overlapMs > CONSERVATION_EPSILON_MS ||
      frame.unattributedMs > CONSERVATION_EPSILON_MS ||
      frame.attributionOverlapMs > CONSERVATION_EPSILON_MS
    ) {
      failures.push(`${label}: WebGPU overlap/unattributed hygiene failed`);
    }
    if (
      Math.abs(sumValues(frame.passMs) - frame.profiledPassMs) >
        CONSERVATION_EPSILON_MS ||
      Math.abs(sumValues(frame.phaseMs) - frame.phaseTotalMs) >
        CONSERVATION_EPSILON_MS
    ) {
      failures.push(`${label}: WebGPU pass/phase sum failed`);
    }
    const primitiveResidualMs =
      frame.phaseMs?.primitiveTraversal -
      frame.detailMs?.groundPrimitiveUpdate -
      frame.detailMs?.ordinaryPrimitiveUpdate -
      frame.detailMs?.globeRender;
    if (
      !isFiniteNumber(primitiveResidualMs) ||
      primitiveResidualMs < -NESTED_EPSILON_MS
    ) {
      failures.push(
        `${label}: primitiveTraversal nested-owner residual failed`,
      );
    }
    primitiveResidualValues.push(primitiveResidualMs);
  }

  if (!Number.isInteger(expectedSamplesPerSegment)) {
    failures.push(
      `owner route contract cannot divide ${expectedFrames} frames across ${expectedTrackSegments} segments`,
    );
  }
  for (
    let segmentIndex = 0;
    segmentIndex < expectedTrackSegments;
    segmentIndex++
  ) {
    if (ownerSegmentSampleCounts[segmentIndex] !== expectedSamplesPerSegment) {
      failures.push(
        `owner segment[${segmentIndex}] population ${ownerSegmentSampleCounts[segmentIndex]} != ${expectedSamplesPerSegment}`,
      );
    }
    if (routeSegmentSampleCounts[segmentIndex] !== expectedSamplesPerSegment) {
      failures.push(
        `route segment[${segmentIndex}] population ${routeSegmentSampleCounts[segmentIndex]} != ${expectedSamplesPerSegment}`,
      );
    }
  }

  const ownerPositiveNames = C11_205_OWNER_DETAIL_NAMES.filter(
    (name) => ownerPositiveSampleCounts[name] > 0,
  );
  if (ownerPositiveNames.length !== C11_205_OWNER_DETAIL_NAMES.length) {
    failures.push(
      `owner timing was vacuous for ${C11_205_OWNER_DETAIL_NAMES.filter((name) => ownerPositiveSampleCounts[name] === 0).join(", ")}`,
    );
  }

  if (renderer === "webgpu") {
    if (raw?.phaseAccounting?.available !== true) {
      failures.push("WebGPU phase accounting availability was not true");
    }
    if (raw?.profiler?.applicable !== true) {
      failures.push("WebGPU profiler applicability was not explicitly true");
    }
    if (raw?.profiler?.before?.enabled !== false) {
      failures.push("WebGPU profiler was not disabled before attribution");
    }
    if (raw?.profiler?.start?.enabled !== true) {
      failures.push(
        "WebGPU profiler did not enable at the measurement boundary",
      );
    }
    if (raw?.profiler?.end?.frameAccounting?.totalFrames !== expectedFrames) {
      failures.push(
        `WebGPU profiler totalFrames ${raw?.profiler?.end?.frameAccounting?.totalFrames ?? "<missing>"} != ${expectedFrames}`,
      );
    }
    if (raw?.profiler?.after?.enabled !== false) {
      failures.push("WebGPU profiler was not disabled after attribution");
    }
    if (
      raw?.cleanup?.profilerEnableAttempted !== true ||
      raw?.cleanup?.profilerEnabledByCollector !== false
    ) {
      failures.push("WebGPU profiler cleanup state is invalid");
    }
    if (
      frames[0]?.sequence !== 1 ||
      frames.at(-1)?.sequence !== expectedFrames
    ) {
      failures.push("WebGPU profiler sequence did not span exactly 1..N");
    }
    const minimumPositivePassFrames = Math.ceil(expectedFrames * 0.9);
    const positiveNamedPassNames = Object.keys(
      namedPassPositiveSampleCounts,
    ).sort();
    if (
      positiveNamedPassProfilerFrames < minimumPositivePassFrames ||
      positiveNamedPassNames.length === 0
    ) {
      failures.push(
        `WebGPU positive named-pass/profiler frames ${positiveNamedPassProfilerFrames}/${expectedFrames} < ${minimumPositivePassFrames}`,
      );
    }
    const missingPositivePhases = C11_205_SCENE_PHASE_NAMES.filter(
      (name) => phasePositiveSampleCounts[name] === 0,
    );
    if (missingPositivePhases.length > 0) {
      failures.push(
        `WebGPU phases were always zero: ${missingPositivePhases.join(", ")}`,
      );
    }
  } else {
    if (raw?.profiler?.applicable !== false) {
      failures.push("WebGL profiler applicability was not explicitly false");
    }
    for (const field of ["before", "start", "end", "after"]) {
      if (raw?.profiler?.[field] !== null) {
        failures.push(`WebGL profiler.${field} was not explicitly null`);
      }
    }
    if (raw?.phaseAccounting?.available !== false) {
      failures.push("WebGL phase accounting availability was not false");
    }
    if (
      raw?.cleanup?.profilerEnableAttempted !== false ||
      raw?.cleanup?.profilerEnabledByCollector !== false
    ) {
      failures.push("WebGL unexpectedly attempted profiler ownership");
    }
  }

  return {
    pass: failures.length === 0,
    failures,
    diagnostic: true,
    noncausal: true,
    certificationEligible: false,
    alignment: {
      ownerFrames: frames.length,
      traceFrames: traceSamples.length,
      routeFrames: trackEvidence.length,
      uniqueSceneFrames: sceneFrames.size,
      uniqueProfilerSequences: sequences.size,
      routeBinding: {
        waypointCount: expectedTrackWaypoints,
        segmentCount: expectedTrackSegments,
        expectedSamplesPerSegment,
        ownerSegmentSampleCounts,
        routeSegmentSampleCounts,
      },
    },
    summary: {
      ownerMs: Object.fromEntries(
        C11_205_OWNER_DETAIL_NAMES.map((name) => [
          name,
          summarize(detailValues[name]),
        ]),
      ),
      ordinaryNonAssetResidualMs: summarize(ordinaryNonAssetResidualValues),
      webglSceneResidualMs:
        renderer === "webgl" ? summarize(webglSceneResidualValues) : null,
      primitiveResidualMs:
        renderer === "webgpu" ? summarize(primitiveResidualValues) : null,
      nonvacuity: {
        ownerPositiveSampleCounts,
        ownerPositiveNames,
        positiveNamedPassProfilerFrames:
          renderer === "webgpu" ? positiveNamedPassProfilerFrames : null,
        positiveNamedPassNames:
          renderer === "webgpu"
            ? Object.keys(namedPassPositiveSampleCounts).sort()
            : [],
        namedPassPositiveSampleCounts:
          renderer === "webgpu" ? namedPassPositiveSampleCounts : {},
        phasePositiveSampleCounts:
          renderer === "webgpu" ? phasePositiveSampleCounts : null,
        positivePhaseNames:
          renderer === "webgpu"
            ? C11_205_SCENE_PHASE_NAMES.filter(
                (name) => phasePositiveSampleCounts[name] > 0,
              )
            : [],
      },
    },
  };
}

export function ownerAttributionFirstRedDecision({ exitCode, existedBefore }) {
  return {
    existedBefore: existedBefore === true,
    written: exitCode !== 0 && existedBefore !== true,
    preserved: existedBefore === true,
  };
}
