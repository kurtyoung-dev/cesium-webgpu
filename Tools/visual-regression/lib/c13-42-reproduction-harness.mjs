/**
 * Installs a bounded, serializable observer for an already initialized GodRay effect.
 */
export function installC13_42GodRayObserver() {
  const root = globalThis;
  const observerKey = "__c13_42GodRayObserver";
  const brandKey = "__c13_42GodRayObserverBrand";
  const brandValue = "c13-42-godray-observer-v1";
  const existingDescriptor = Object.getOwnPropertyDescriptor(root, observerKey);
  if (existingDescriptor !== undefined) {
    try {
      const existing = existingDescriptor.value;
      const existingBrand =
        existing !== null && typeof existing === "object"
          ? Object.getOwnPropertyDescriptor(existing, brandKey)
          : undefined;
      const existingObserver =
        existing !== null && typeof existing === "object"
          ? Object.getOwnPropertyDescriptor(existing, "observeGodRay")
          : undefined;
      const reusable =
        Object.prototype.hasOwnProperty.call(existingDescriptor, "value") &&
        existingDescriptor.configurable === false &&
        existingDescriptor.enumerable === false &&
        existingDescriptor.writable === false &&
        existing !== null &&
        typeof existing === "object" &&
        Object.isFrozen(existing) &&
        existingBrand !== undefined &&
        Object.prototype.hasOwnProperty.call(existingBrand, "value") &&
        existingBrand.enumerable === false &&
        existingBrand.writable === false &&
        existingBrand.configurable === false &&
        existingBrand.value === brandValue &&
        existingObserver !== undefined &&
        Object.prototype.hasOwnProperty.call(existingObserver, "value") &&
        existingObserver.enumerable === true &&
        existingObserver.writable === false &&
        existingObserver.configurable === false &&
        typeof existingObserver.value === "function";
      if (reusable) {
        return existing;
      }
    } catch {
      throw new Error("GodRay observer global is occupied");
    }
    throw new Error("GodRay observer global is occupied");
  }
  const activeEffects = new WeakSet();
  const identities = new WeakMap();
  let nextIdentity = 1;
  const CONFIG_KEYS = Object.freeze([
    "density",
    "decay",
    "weight",
    "exposure",
    "sampleCount",
    "occlusionFarCutoff",
    "sunScreenU",
    "sunScreenV",
  ]);

  const isObject = (value) =>
    value !== null &&
    (typeof value === "object" || typeof value === "function");

  const identity = (value) => {
    if (!isObject(value)) {
      return null;
    }
    let id = identities.get(value);
    if (id === undefined) {
      id = nextIdentity++;
      identities.set(value, id);
    }
    return id;
  };

  const copyValue = (value) => {
    if (value === null || typeof value !== "object") {
      return value;
    }
    if (Array.isArray(value)) {
      return value.map(copyValue);
    }
    return Object.fromEntries(
      Object.keys(value).map((key) => [key, copyValue(value[key])]),
    );
  };

  const scalarValue = (value) => {
    if (value === null) {
      return { kind: "null", value: null };
    }
    const type = typeof value;
    if (
      type === "string" ||
      type === "number" ||
      type === "boolean" ||
      type === "bigint"
    ) {
      return { kind: type, value };
    }
    if (type === "undefined") {
      return { kind: "undefined", value: undefined };
    }
    if (type === "symbol") {
      return { kind: "symbol" };
    }
    return { kind: type, identity: identity(value) };
  };

  const configSnapshot = (config) => {
    const source = config !== null && typeof config === "object" ? config : {};
    return Object.fromEntries(
      CONFIG_KEYS.map((key) => {
        const present = Object.prototype.hasOwnProperty.call(source, key);
        return [
          key,
          present
            ? { present: true, value: scalarValue(source[key]) }
            : { present: false, value: undefined },
        ];
      }),
    );
  };

  const thrownSnapshot = (value) => scalarValue(value);

  const descriptorEqual = (left, right) => {
    if (left === undefined || right === undefined) {
      return left === right;
    }
    return (
      left.configurable === right.configurable &&
      left.enumerable === right.enumerable &&
      left.writable === right.writable &&
      left.value === right.value &&
      left.get === right.get &&
      left.set === right.set
    );
  };

  const initializedState = (effect) => {
    const device = effect?._device;
    const generatePipeline = effect?._generatePipeline;
    const compositePipeline = effect?._compositePipeline;
    const rayView = effect?._rayView;
    const outputView = effect?._outputView;
    const width = effect?._width ?? 0;
    const height = effect?._height ?? 0;
    return {
      initialized:
        device != null &&
        generatePipeline != null &&
        compositePipeline != null &&
        rayView != null &&
        outputView != null &&
        width > 0 &&
        height > 0,
      device,
      generatePipeline,
      compositePipeline,
      rayView,
      outputView,
      deviceId: identity(device),
      generatePipelineId: identity(generatePipeline),
      compositePipelineId: identity(compositePipeline),
      rayViewId: identity(rayView),
      outputViewId: identity(outputView),
      width,
      height,
    };
  };

  const effectSnapshot = (scene, effect) => {
    const state = initializedState(effect);
    const config = effect?._config;
    return {
      enabled: effect?.enabled === true,
      initialized: state.initialized,
      deviceId: state.deviceId,
      effectId: identity(effect),
      width: state.width,
      height: state.height,
      rayViewId: state.rayViewId,
      outputViewId: state.outputViewId,
      generatePipelineId: state.generatePipelineId,
      compositePipelineId: state.compositePipelineId,
      requestedConfig: configSnapshot(scene?.godRayConfig),
      realizedConfig: configSnapshot(config),
      sunUV: {
        u: scalarValue(config?.sunScreenU),
        v: scalarValue(config?.sunScreenV),
      },
      cloudMask: {
        present: effect?._cloudTransView != null,
        viewId: identity(effect?._cloudTransView),
      },
    };
  };

  const findExecuteDescriptor = (effect) => {
    let owner = effect;
    while (owner !== null) {
      const descriptor = Object.getOwnPropertyDescriptor(owner, "execute");
      if (descriptor !== undefined) {
        return { owner, descriptor };
      }
      owner = Object.getPrototypeOf(owner);
    }
    return undefined;
  };

  const observeGodRay = (options = {}) => {
    if (
      !root.__cloudProbe ||
      typeof root.__cloudProbe.resolveViewer !== "function"
    ) {
      throw new Error("cloud probe viewer resolver is unavailable");
    }
    const viewer = Object.prototype.hasOwnProperty.call(options, "viewer")
      ? root.__cloudProbe.resolveViewer(options.viewer)
      : root.__cloudProbe.resolveViewer();
    const scene = viewer?.scene;
    const alternateRenderer = scene?._alternateSceneRenderer;
    const pipeline = alternateRenderer?.postProcessPipeline;
    const effect = pipeline?.godRayEffect;
    if (!scene || !pipeline || !effect) {
      throw new Error("GodRay effect is unavailable");
    }
    if (activeEffects.has(effect)) {
      throw new Error("GodRay observation overlap is refused");
    }
    const initialState = initializedState(effect);
    const initialDevice = effect._device;
    if (!initialState.initialized) {
      throw new Error("GodRay effect is not initialized");
    }
    const originalDescriptor = Object.getOwnPropertyDescriptor(
      effect,
      "execute",
    );
    const descriptorInfo = findExecuteDescriptor(effect);
    const callableDescriptor = descriptorInfo?.descriptor;
    if (
      !callableDescriptor ||
      !Object.prototype.hasOwnProperty.call(callableDescriptor, "value") ||
      typeof callableDescriptor.value !== "function"
    ) {
      throw new Error("GodRay execute method is unavailable");
    }
    if (
      originalDescriptor !== undefined &&
      originalDescriptor.writable !== true
    ) {
      throw new Error("GodRay execute method is not writable");
    }
    const originalExecute = callableDescriptor.value;

    const requestedMaxCalls = options.maxCalls ?? 32;
    if (
      !Number.isFinite(requestedMaxCalls) ||
      !Number.isInteger(requestedMaxCalls) ||
      requestedMaxCalls < 1 ||
      requestedMaxCalls > 256
    ) {
      throw new Error("GodRay maxCalls must be an integer from 1 through 256");
    }
    const maxCalls = requestedMaxCalls;
    const captureFrameWitness = options.captureFrameWitness;
    if (
      captureFrameWitness !== undefined &&
      typeof captureFrameWitness !== "function"
    ) {
      throw new Error("GodRay frame witness must be a function");
    }
    const records = [];
    let droppedCalls = 0;
    let cleanupReport;

    const stickyReasons = [];
    const addReason = (reason) => {
      if (!stickyReasons.includes(reason)) {
        stickyReasons.push(reason);
      }
    };
    const refreshPinnedState = () => {
      let currentScene;
      let currentAlternateRenderer;
      let currentPipeline;
      let currentEffect;
      let currentDevice;
      let currentGeneratePipeline;
      let currentCompositePipeline;
      let currentRayView;
      let currentOutputView;
      let currentWidth;
      let currentHeight;
      try {
        currentScene = viewer?.scene;
        currentAlternateRenderer = currentScene?._alternateSceneRenderer;
        currentPipeline = currentAlternateRenderer?.postProcessPipeline;
        currentEffect = currentPipeline?.godRayEffect;
        currentDevice = effect._device;
        currentGeneratePipeline = effect._generatePipeline;
        currentCompositePipeline = effect._compositePipeline;
        currentRayView = effect._rayView;
        currentOutputView = effect._outputView;
        currentWidth = effect._width;
        currentHeight = effect._height;
      } catch {
        addReason("viewer-path-unavailable");
        return { valid: false, diagnosticFailure: true, device: initialDevice };
      }
      if (currentScene !== scene) {
        addReason("scene-replaced");
      }
      if (currentAlternateRenderer !== alternateRenderer) {
        addReason("alternate-renderer-replaced");
      }
      if (currentPipeline !== pipeline) {
        addReason("pipeline-replaced");
      }
      if (currentEffect !== effect) {
        addReason("effect-replaced");
      }
      if (currentDevice !== initialDevice) {
        addReason("device-replaced");
      }
      if (currentGeneratePipeline !== initialState.generatePipeline) {
        addReason("generate-pipeline-replaced");
      }
      if (currentCompositePipeline !== initialState.compositePipeline) {
        addReason("composite-pipeline-replaced");
      }
      if (currentRayView !== initialState.rayView) {
        addReason("ray-view-replaced");
      }
      if (currentOutputView !== initialState.outputView) {
        addReason("output-view-replaced");
      }
      if (currentWidth !== initialState.width) {
        addReason("width-replaced");
      }
      if (currentHeight !== initialState.height) {
        addReason("height-replaced");
      }
      return {
        valid: stickyReasons.length === 0,
        scene: currentScene,
        alternateRenderer: currentAlternateRenderer,
        pipeline: currentPipeline,
        effect: currentEffect,
        device: currentDevice,
      };
    };

    const fallbackSnapshot = () => ({
      enabled: false,
      initialized: false,
      deviceId: initialState.deviceId,
      effectId: identity(effect),
      width: 0,
      height: 0,
      rayViewId: null,
      outputViewId: null,
      generatePipelineId: null,
      compositePipelineId: null,
      requestedConfig: configSnapshot({}),
      realizedConfig: configSnapshot({}),
      sunUV: {
        u: { kind: "undefined", value: undefined },
        v: { kind: "undefined", value: undefined },
      },
      cloudMask: { present: false, viewId: null },
    });

    const installedDescriptor = originalDescriptor
      ? { ...originalDescriptor, value: undefined }
      : {
          configurable: true,
          enumerable: callableDescriptor.enumerable,
          writable: true,
          value: undefined,
        };

    const append = (record) => {
      if (records.length < maxCalls) {
        records.push(record);
      } else {
        droppedCalls++;
      }
    };

    const wrappedExecute = function (...args) {
      const sourceView = args[1];
      const depthView = args[2];
      const diagnostic = {
        observationValid: true,
        phase: undefined,
        reason: undefined,
      };
      const markDiagnostic = (phase, reason) => {
        if (diagnostic.observationValid) {
          diagnostic.observationValid = false;
          diagnostic.phase = phase;
          diagnostic.reason = reason;
        }
        addReason(`${phase}-diagnostic-failure`);
      };
      let beforePin;
      let beforeEpoch;
      let before;
      try {
        beforePin = refreshPinnedState();
        if (beforePin.diagnosticFailure) {
          markDiagnostic("pre", "pinned-state-read-failed");
        }
      } catch {
        markDiagnostic("pre", "pinned-state-read-failed");
      }
      try {
        beforeEpoch = initializedState(effect);
      } catch {
        markDiagnostic("pre", "resource-state-read-failed");
        beforeEpoch = initialState;
      }
      try {
        before = effectSnapshot(scene, effect);
      } catch {
        markDiagnostic("pre", "effect-state-read-failed");
        before = fallbackSnapshot();
      }
      beforePin ??= { valid: false };
      beforeEpoch ??= initialState;
      before ??= fallbackSnapshot();
      let frameWitness = null;
      if (captureFrameWitness) {
        try {
          frameWitness = copyValue(
            captureFrameWitness({ sourceView, depthView, scene, effect }),
          );
        } catch {
          markDiagnostic("pre", "frame-witness-capture-failed");
        }
      }
      let disabled = false;
      try {
        disabled = effect.enabled === false;
      } catch {
        markDiagnostic("pre", "enabled-read-failed");
      }
      const depthPresent = depthView !== null && depthView !== undefined;
      const record = {
        call: true,
        ordinal: records.length + droppedCalls + 1,
        disabled,
        depthPresent,
        sourcePresent: sourceView !== null && sourceView !== undefined,
        sourceViewId: identity(sourceView),
        depthViewId: identity(depthView),
        devicePresent: before.deviceId !== null,
        initialized: before.initialized,
        effectId: before.effectId,
        deviceId: before.deviceId,
        requestedConfig: before.requestedConfig,
        realizedConfig: before.realizedConfig,
        sunUV: before.sunUV,
        cloudMask: before.cloudMask,
        dimensions: { width: before.width, height: before.height },
        threw: false,
        thrown: { kind: "undefined", value: undefined },
        passthrough: false,
        generatedWork: false,
        actualWork: false,
        pinnedValid: beforePin.valid,
        resourceEpochStable: false,
        receiverPinned: false,
        returnPinnedOutput: false,
        returnedViewId: null,
        observationValid: diagnostic.observationValid,
        diagnosticPhase: diagnostic.phase,
        diagnosticReason: diagnostic.reason,
        outcome: "call",
      };
      if (captureFrameWitness) {
        record.frameWitness = frameWitness;
      }
      let returned;
      let thrown = false;
      try {
        returned = Reflect.apply(originalExecute, this, args);
      } catch (error) {
        thrown = true;
        record.threw = true;
        record.thrown = thrownSnapshot(error);
        throw error;
      } finally {
        let afterPin;
        let afterEpoch;
        try {
          afterPin = refreshPinnedState();
          if (afterPin.diagnosticFailure) {
            markDiagnostic("post", "pinned-state-read-failed");
          }
        } catch {
          markDiagnostic("post", "pinned-state-read-failed");
        }
        try {
          afterEpoch = initializedState(effect);
        } catch {
          markDiagnostic("post", "resource-state-read-failed");
          afterEpoch = initialState;
        }
        afterPin ??= { valid: false };
        afterEpoch ??= initialState;
        const resourceEpochStable =
          beforeEpoch.device === afterEpoch.device &&
          beforeEpoch.generatePipeline === afterEpoch.generatePipeline &&
          beforeEpoch.compositePipeline === afterEpoch.compositePipeline &&
          beforeEpoch.rayView === afterEpoch.rayView &&
          beforeEpoch.outputView === afterEpoch.outputView &&
          beforeEpoch.width === afterEpoch.width &&
          beforeEpoch.height === afterEpoch.height;
        record.passthrough = !thrown && returned === sourceView;
        record.generatedWork = !thrown && !record.passthrough;
        record.receiverPinned = this === effect;
        record.returnPinnedOutput =
          !thrown && returned === beforeEpoch.outputView;
        record.returnedViewId = thrown ? null : identity(returned);
        record.resourceEpochStable = resourceEpochStable;
        record.pinnedValid = beforePin.valid && afterPin.valid;
        record.actualWork =
          record.generatedWork &&
          depthPresent &&
          before.initialized &&
          afterEpoch.initialized &&
          record.pinnedValid &&
          resourceEpochStable &&
          record.receiverPinned &&
          record.returnPinnedOutput &&
          diagnostic.observationValid;
        record.observationValid = diagnostic.observationValid;
        record.diagnosticPhase = diagnostic.phase;
        record.diagnosticReason = diagnostic.reason;
        if (!diagnostic.observationValid) {
          record.outcome = "invalid-observation";
        } else if (thrown) {
          record.outcome = "throw";
        } else if (record.actualWork) {
          record.outcome = "work";
        } else if (!record.pinnedValid || !resourceEpochStable) {
          record.outcome = "invalidated";
        } else if (disabled) {
          record.outcome = "disabled";
        } else if (!depthPresent) {
          record.outcome = "missing-depth";
        } else if (record.passthrough) {
          record.outcome = "passthrough";
        }
        append(record);
      }
      return returned;
    };

    const finalInstalledDescriptor = {
      ...installedDescriptor,
      value: wrappedExecute,
    };
    activeEffects.add(effect);
    try {
      Object.defineProperty(effect, "execute", finalInstalledDescriptor);
    } catch (error) {
      activeEffects.delete(effect);
      throw error;
    }
    const installedOwnDescriptor = Object.getOwnPropertyDescriptor(
      effect,
      "execute",
    );

    const recordsSnapshot = () => {
      refreshPinnedState();
      return copyValue({ records, droppedCalls }).records;
    };

    const cleanup = () => {
      if (cleanupReport !== undefined) {
        refreshPinnedState();
        return copyValue(cleanupReport);
      }
      let restored = false;
      try {
        refreshPinnedState();
        const currentDescriptor = Object.getOwnPropertyDescriptor(
          effect,
          "execute",
        );
        const ownsInstalledDescriptor = descriptorEqual(
          currentDescriptor,
          installedOwnDescriptor,
        );
        if (!ownsInstalledDescriptor) {
          addReason("execute-hook-replaced");
        } else if (originalDescriptor === undefined) {
          delete effect.execute;
        } else {
          Object.defineProperty(effect, "execute", originalDescriptor);
        }
        const restoredDescriptor = Object.getOwnPropertyDescriptor(
          effect,
          "execute",
        );
        const resolvedAfter = findExecuteDescriptor(effect);
        const inheritedUnchanged =
          originalDescriptor !== undefined ||
          (resolvedAfter?.owner === descriptorInfo.owner &&
            descriptorEqual(resolvedAfter.descriptor, callableDescriptor));
        restored =
          descriptorEqual(restoredDescriptor, originalDescriptor) &&
          inheritedUnchanged;
        if (!restored && !stickyReasons.includes("execute-hook-replaced")) {
          addReason("descriptor-restore-failed");
        }
      } catch (error) {
        addReason("descriptor-restore-failed");
        addReason(`restore-error:${thrownSnapshot(error).kind}`);
      } finally {
        if (restored) {
          activeEffects.delete(effect);
        }
      }
      cleanupReport = {
        restored,
        valid: restored && stickyReasons.length === 0,
        reasons: stickyReasons.slice(),
        effectId: identity(effect),
        deviceId: (() => {
          try {
            return identity(effect._device);
          } catch {
            return initialState.deviceId;
          }
        })(),
      };
      return copyValue(cleanupReport);
    };

    return {
      viewerId: identity(viewer),
      sceneId: identity(scene),
      pipelineId: identity(pipeline),
      effectId: identity(effect),
      deviceId: initialState.deviceId,
      get records() {
        return recordsSnapshot();
      },
      snapshot: recordsSnapshot,
      status: () => {
        const state = refreshPinnedState();
        return copyValue({
          valid: state.valid,
          reasons: stickyReasons.slice(),
          calls: records.length + droppedCalls,
          droppedCalls,
        });
      },
      cleanup,
    };
  };

  const api = { observeGodRay };
  Object.defineProperty(api, brandKey, {
    configurable: false,
    enumerable: false,
    writable: false,
    value: brandValue,
  });
  Object.freeze(api);
  Object.defineProperty(root, observerKey, {
    configurable: false,
    enumerable: false,
    writable: false,
    value: api,
  });
  return api;
}

/**
 * Installs the phase-steppable browser-side driver used by the C13-42
 * reproduction probe. The function is self-contained for init-script use.
 */
export function installC13_42ReproductionHarness() {
  const root = globalThis;
  const driverKey = "__c13_42ReproductionHarness";
  const brandKey = "__c13_42ReproductionHarnessBrand";
  const brandValue = "c13-42-reproduction-harness-v1";
  const existingDescriptor = Object.getOwnPropertyDescriptor(root, driverKey);
  if (existingDescriptor !== undefined) {
    try {
      const existing = existingDescriptor.value;
      const brand = Object.getOwnPropertyDescriptor(existing, brandKey);
      const methods = [
        "snapshotState",
        "beginCell",
        "transition",
        "driveMotion",
        "finishCell",
        "runCloudBracket",
        "runGodRayBracket",
        "runMotionRoute",
        "restore",
        "acquireControlledGodRayFixture",
        "beginControlledGodRayCase",
        "transitionControlledGodRayCase",
        "confirmControlledGodRayCapture",
        "finishControlledGodRayCase",
        "finishControlledGodRayFixture",
      ];
      const reusable =
        Object.prototype.hasOwnProperty.call(existingDescriptor, "value") &&
        existingDescriptor.configurable === false &&
        existingDescriptor.enumerable === false &&
        existingDescriptor.writable === false &&
        existing !== null &&
        typeof existing === "object" &&
        Object.isFrozen(existing) &&
        brand?.value === brandValue &&
        brand.configurable === false &&
        brand.enumerable === false &&
        brand.writable === false &&
        methods.every((name) => typeof existing[name] === "function");
      if (reusable) {
        return existing;
      }
    } catch {
      throw new Error("C13-42 reproduction harness global is occupied");
    }
    throw new Error("C13-42 reproduction harness global is occupied");
  }

  const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
  const identities = new WeakMap();
  let nextIdentity = 1;
  const identity = (value) => {
    if (
      value === null ||
      (typeof value !== "object" && typeof value !== "function")
    ) {
      return null;
    }
    let id = identities.get(value);
    if (id === undefined) {
      id = nextIdentity++;
      identities.set(value, id);
    }
    return id;
  };
  const scalar = (value) => {
    if (value === undefined) {
      return { kind: "undefined" };
    }
    if (typeof value === "bigint") {
      return { kind: "bigint", value: String(value) };
    }
    if (
      value === null ||
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean"
    ) {
      return value;
    }
    return { kind: typeof value, id: identity(value) };
  };
  const serializable = (value, depth = 0, seen = new WeakSet()) => {
    if (
      value === null ||
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean"
    ) {
      return value;
    }
    if (value === undefined || typeof value === "bigint") {
      return scalar(value);
    }
    if (typeof value !== "object" || depth >= 5 || seen.has(value)) {
      return scalar(value);
    }
    seen.add(value);
    if (Array.isArray(value)) {
      const result = value.map((item) => serializable(item, depth + 1, seen));
      seen.delete(value);
      return result;
    }
    const result = {};
    for (const key of Object.keys(value).sort()) {
      try {
        result[key] = serializable(value[key], depth + 1, seen);
      } catch {
        result[key] = { kind: "unavailable" };
      }
    }
    seen.delete(value);
    return result;
  };
  const controlledSerializable = (value, depth = 0, seen = new WeakSet()) => {
    if (
      value === null ||
      typeof value === "string" ||
      typeof value === "boolean"
    ) {
      return value;
    }
    if (typeof value === "number") {
      if (!Number.isFinite(value)) {
        throw new Error(
          "controlled GodRay witness contains a non-finite number",
        );
      }
      return value;
    }
    if (
      value === undefined ||
      typeof value !== "object" ||
      depth >= 16 ||
      seen.has(value)
    ) {
      throw new Error("controlled GodRay witness is not JSON-safe");
    }
    seen.add(value);
    const result = Array.isArray(value)
      ? value.map((item) => controlledSerializable(item, depth + 1, seen))
      : Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((key) => [
              key,
              controlledSerializable(value[key], depth + 1, seen),
            ]),
        );
    seen.delete(value);
    return result;
  };
  const stableText = (value) => JSON.stringify(value);
  const numericVector = (value) => ({
    x: scalar(value?.x),
    y: scalar(value?.y),
    z: scalar(value?.z),
  });
  const copyVector = (value) => {
    if (value == null) {
      return value;
    }
    if (typeof value.clone === "function") {
      return value.clone();
    }
    return { x: value.x, y: value.y, z: value.z };
  };
  const copyTime = (value) => {
    if (value == null) {
      return value;
    }
    if (typeof value.clone === "function") {
      return value.clone();
    }
    return { ...value };
  };
  const configSnapshot = (value) => {
    if (value === null || typeof value !== "object") {
      return scalar(value);
    }
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => {
          try {
            return [key, serializable(value[key])];
          } catch {
            return [key, { kind: "unavailable" }];
          }
        }),
    );
  };
  const frustumSnapshot = (frustum) => {
    const result = {
      type: frustum?.constructor?.name ?? null,
    };
    for (const key of ["fov", "aspectRatio", "near", "far", "width"]) {
      try {
        result[key] = scalar(frustum?.[key]);
      } catch {
        result[key] = { kind: "unavailable" };
      }
    }
    return result;
  };
  const clockSnapshot = (clock) => ({
    shouldAnimate: scalar(clock?.shouldAnimate),
    canAnimate: scalar(clock?.canAnimate),
    multiplier: scalar(clock?.multiplier),
    clockStep: scalar(clock?.clockStep),
    clockRange: scalar(clock?.clockRange),
    currentTime: serializable(clock?.currentTime),
  });
  const cameraSnapshot = (camera) => ({
    position: numericVector(camera?.positionWC ?? camera?.position),
    direction: numericVector(camera?.directionWC ?? camera?.direction),
    up: numericVector(camera?.upWC ?? camera?.up),
    right: numericVector(camera?.rightWC ?? camera?.right),
    cartographic: {
      longitude: scalar(camera?.positionCartographic?.longitude),
      latitude: scalar(camera?.positionCartographic?.latitude),
      height: scalar(camera?.positionCartographic?.height),
    },
    heading: scalar(camera?.heading),
    pitch: scalar(camera?.pitch),
    roll: scalar(camera?.roll),
    frustum: frustumSnapshot(camera?.frustum),
  });
  const canvasSnapshot = (scene) => {
    const canvas = scene?.canvas ?? scene?.context?._canvas;
    return {
      present: canvas != null,
      id: identity(canvas),
      width: scalar(canvas?.width),
      height: scalar(canvas?.height),
      clientWidth: scalar(canvas?.clientWidth),
      clientHeight: scalar(canvas?.clientHeight),
      devicePixelRatio: scalar(root.devicePixelRatio),
    };
  };
  const initializedGodRay = (effect) => {
    const width = effect?._width ?? 0;
    const height = effect?._height ?? 0;
    const device = effect?._device;
    const generatePipeline = effect?._generatePipeline;
    const compositePipeline = effect?._compositePipeline;
    const rayView = effect?._rayView;
    const outputView = effect?._outputView;
    return {
      initialized:
        device != null &&
        generatePipeline != null &&
        compositePipeline != null &&
        rayView != null &&
        outputView != null &&
        width > 0 &&
        height > 0,
      enabled: effect?.enabled === true,
      effectId: identity(effect),
      deviceId: identity(device),
      generatePipelineId: identity(generatePipeline),
      compositePipelineId: identity(compositePipeline),
      rayViewId: identity(rayView),
      outputViewId: identity(outputView),
      width,
      height,
      realizedConfig: configSnapshot(effect?._config),
      cloudMask: {
        present: effect?._cloudTransView != null,
        viewId: identity(effect?._cloudTransView),
      },
    };
  };

  const resolveViewer = (options = {}) => {
    if (
      !root.__cloudProbe ||
      typeof root.__cloudProbe.resolveViewer !== "function"
    ) {
      throw new Error("cloud probe viewer resolver is unavailable");
    }
    return own(options, "viewer")
      ? root.__cloudProbe.resolveViewer(options.viewer)
      : root.__cloudProbe.resolveViewer();
  };
  const stateForViewer = (viewer) => {
    const scene = viewer?.scene;
    if (!scene) {
      throw new Error("C13-42 reproduction harness requires viewer.scene");
    }
    const collection = scene.globe?.defaultCloudCollection;
    const volumetric = collection?.volumetric;
    const effect =
      scene?._alternateSceneRenderer?.postProcessPipeline?.godRayEffect;
    let cloudStats;
    let cloudRealization;
    try {
      cloudStats = root.__cloudProbe.cloudStatsSnapshot(viewer);
    } catch (error) {
      cloudStats = { error: String(error?.message ?? error) };
    }
    try {
      cloudRealization = root.__cloudProbe.proceduralRealization(viewer);
    } catch (error) {
      cloudRealization = { error: String(error?.message ?? error) };
    }
    return {
      selection: {
        viewerId: identity(viewer),
        sceneId: identity(scene),
      },
      camera: cameraSnapshot(scene.camera ?? viewer.camera),
      mode: scalar(scene.mode),
      requestRenderMode: scalar(scene.requestRenderMode),
      clock: clockSnapshot(viewer.clock),
      canvas: canvasSnapshot(scene),
      cloud: {
        collectionPresent: collection != null,
        collectionId: identity(collection),
        enableVolumetric: scalar(collection?.enableVolumetric),
        renderMode: scalar(collection?.renderMode),
        config: configSnapshot(volumetric),
        realization: serializable(cloudRealization),
        stats: serializable(cloudStats),
      },
      godRay: {
        requestedEnabled: scalar(scene.godRayEnabled),
        requestedConfig: configSnapshot(scene.godRayConfig),
        realized: initializedGodRay(effect),
      },
    };
  };
  const snapshotState = (options = {}) =>
    stateForViewer(resolveViewer(options));

  const invariantSnapshot = (state) => ({
    selection: state.selection,
    camera: state.camera,
    mode: state.mode,
    clock: state.clock,
    canvas: state.canvas,
  });

  const sessions = new Map();
  let nextSessionId = 1;
  const controlledFixtures = new Map();
  const controlledCases = new Map();
  let nextControlledFixtureId = 1;
  let nextControlledCaseId = 1;
  const controlledIdentityNamespace = "c13-42-reproduction-harness-identity-v1";
  const observerIdentityNamespace = "c13-42-godray-observer-identity-v1";

  const requirePlainObject = (value, label) => {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(`${label} must be an object`);
    }
    return value;
  };
  const requireIdentifier = (value, label) => {
    if (
      typeof value !== "string" ||
      !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/u.test(value)
    ) {
      throw new Error(`${label} must be a bounded DOM-safe identifier`);
    }
    return value;
  };
  const requireFiniteArray = (value, length, label) => {
    if (
      !Array.isArray(value) ||
      value.length !== length ||
      value.some((item) => !Number.isFinite(item))
    ) {
      throw new Error(`${label} must contain ${length} finite numbers`);
    }
    return value.slice();
  };
  const matrixArray = (value, label) => {
    const result = [];
    for (let index = 0; index < 16; index++) {
      const item = Number(value?.[index]);
      if (!Number.isFinite(item)) {
        throw new Error(`${label} must contain 16 finite numbers`);
      }
      result.push(item);
    }
    return result;
  };
  const multiplyPoint = (matrix, point) => {
    const x = point[0];
    const y = point[1];
    const z = point[2];
    return [
      matrix[0] * x + matrix[4] * y + matrix[8] * z + matrix[12],
      matrix[1] * x + matrix[5] * y + matrix[9] * z + matrix[13],
      matrix[2] * x + matrix[6] * y + matrix[10] * z + matrix[14],
      matrix[3] * x + matrix[7] * y + matrix[11] * z + matrix[15],
    ];
  };
  const projectPoint = (matrix, point) => {
    const clip = multiplyPoint(matrix, point);
    if (!clip.every(Number.isFinite) || !(clip[3] > 0)) {
      throw new Error("controlled GodRay corner projection is invalid");
    }
    return [0.5 * (clip[0] / clip[3]) + 0.5, 0.5 - 0.5 * (clip[1] / clip[3])];
  };
  const localBoxCorners = (dimensions) => {
    const half = dimensions.map((value) => value * 0.5);
    const corners = [];
    for (const x of [-half[0], half[0]]) {
      for (const y of [-half[1], half[1]]) {
        for (const z of [-half[2], half[2]]) {
          corners.push([x, y, z]);
        }
      }
    }
    return corners;
  };
  const errorText = (error) => {
    try {
      return String(error?.message ?? error);
    } catch {
      return "unavailable-error";
    }
  };
  const controlledVectorWitness = (value, label) => ({
    identityNamespace: controlledIdentityNamespace,
    identity: identity(value),
    value: requireFiniteArray([value?.x, value?.y, value?.z], 3, label),
  });

  const resolveControls = (specifications) => {
    if (!Array.isArray(specifications) || specifications.length === 0) {
      throw new Error("C13-42 cell requires at least one real DOM control");
    }
    return specifications.map((specification, index) => {
      const selector = specification?.selector;
      if (typeof selector !== "string" || selector.length === 0) {
        throw new Error(`C13-42 control ${index} requires a selector`);
      }
      const matches = root.document?.querySelectorAll?.(selector);
      if (!matches || matches.length !== 1) {
        throw new Error(
          `C13-42 control ${selector} resolved ${matches?.length ?? 0} elements`,
        );
      }
      const element = matches[0];
      const property =
        specification.property ??
        (element.type === "checkbox" ? "checked" : "value");
      if (property !== "checked" && property !== "value") {
        throw new Error(`C13-42 control ${selector} has invalid property`);
      }
      const event =
        specification.event ?? (property === "checked" ? "change" : "input");
      if (event !== "change" && event !== "input") {
        throw new Error(`C13-42 control ${selector} has invalid event`);
      }
      if (!own(specification, "offValue") || !own(specification, "onValue")) {
        throw new Error(`C13-42 control ${selector} requires offValue/onValue`);
      }
      return {
        name: specification.name ?? `control-${index}`,
        selector,
        property,
        event,
        offValue: specification.offValue,
        onValue: specification.onValue,
        element,
        originalValue: element[property],
        dataBind: element.getAttribute?.("data-bind") ?? null,
      };
    });
  };

  const captureFields = (value) =>
    value === null || typeof value !== "object"
      ? []
      : Object.keys(value).map((key) => ({ key, value: value[key] }));
  const restoreFields = (value, fields, reasons, label) => {
    if (value === null || typeof value !== "object") {
      reasons.push(`${label}-unavailable`);
      return;
    }
    for (const field of fields) {
      try {
        value[field.key] = field.value;
      } catch {
        reasons.push(`${label}-${field.key}-restore-failed`);
      }
    }
  };
  const restorationRecord = (viewer, controls) => {
    const scene = viewer.scene;
    const camera = scene.camera ?? viewer.camera;
    const clock = viewer.clock;
    const collection = scene.globe?.defaultCloudCollection;
    const volumetric = collection?.volumetric;
    const pipeline = scene?._alternateSceneRenderer?.postProcessPipeline;
    const effect = pipeline?.godRayEffect;
    const frustum = camera?.frustum;
    return {
      viewer,
      scene,
      camera,
      clock,
      collection,
      volumetric,
      pipeline,
      effect,
      position: copyVector(camera?.positionWC ?? camera?.position),
      direction: copyVector(camera?.directionWC ?? camera?.direction),
      up: copyVector(camera?.upWC ?? camera?.up),
      frustum,
      frustumFields: ["fov", "aspectRatio", "near", "far", "width"]
        .filter((key) => {
          try {
            return key in (frustum ?? {});
          } catch {
            return false;
          }
        })
        .map((key) => ({ key, value: frustum[key] })),
      currentTime: copyTime(clock?.currentTime),
      shouldAnimate: clock?.shouldAnimate,
      canAnimate: clock?.canAnimate,
      multiplier: clock?.multiplier,
      clockStep: clock?.clockStep,
      clockRange: clock?.clockRange,
      requestRenderMode: scene.requestRenderMode,
      enableVolumetric: collection?.enableVolumetric,
      volumetricFields: captureFields(volumetric),
      godRayEnabled: scene.godRayEnabled,
      godRayConfig: scene.godRayConfig,
      effectEnabled: effect?.enabled,
      effectConfig: effect?._config,
      controls,
    };
  };

  const requireSession = (sessionId) => {
    const session = sessions.get(sessionId);
    if (!session) {
      throw new Error(`C13-42 session ${String(sessionId)} is unavailable`);
    }
    return session;
  };
  const controlReadback = (control) => ({
    name: control.name,
    selector: control.selector,
    property: control.property,
    event: control.event,
    value: serializable(control.element[control.property]),
    dataBind: control.element.getAttribute?.("data-bind") ?? null,
    elementId: identity(control.element),
  });
  const dispatchControl = (control, value) => {
    control.element[control.property] = value;
    const event = new root.Event(control.event, { bubbles: true });
    control.element.dispatchEvent(event);
    return controlReadback(control);
  };
  const renderOneFrame = (session) => {
    const scene = session.scene;
    const beforeFrame = scene?._frameState?.frameNumber;
    scene.requestRender?.();
    scene.render(session.viewer.clock?.currentTime);
    const afterFrame = scene?._frameState?.frameNumber;
    session.renderCalls++;
    return {
      requested: true,
      renderCalls: 1,
      beforeFrame: scalar(beforeFrame),
      afterFrame: scalar(afterFrame),
      observedFrameDelta:
        typeof beforeFrame === "number" && typeof afterFrame === "number"
          ? afterFrame - beforeFrame
          : null,
    };
  };
  const cloudStats = (viewer) => {
    try {
      return root.__cloudProbe.cloudStatsSnapshot(viewer);
    } catch (error) {
      return { error: String(error?.message ?? error) };
    }
  };
  const cloudRealization = (viewer) => {
    try {
      return root.__cloudProbe.proceduralRealization(viewer);
    } catch (error) {
      return { error: String(error?.message ?? error) };
    }
  };
  const cloudWorkFacts = (before, after, realization, canvas) => {
    const raymarch = after?.raymarch;
    const passes = after?.passes;
    const halfRes = raymarch?.halfResActive === true;
    const proceduralPassName = halfRes
      ? "ProceduralClouds half-res pass"
      : "ProceduralClouds pass";
    const framesDelta =
      typeof before?.frames === "number" && typeof after?.frames === "number"
        ? after.frames - before.frames
        : null;
    const culledDelta =
      typeof before?.culledFrames === "number" &&
      typeof after?.culledFrames === "number"
        ? after.culledFrames - before.culledFrames
        : null;
    const dimensionsPositive =
      Number.isFinite(raymarch?.width) &&
      Number.isFinite(raymarch?.height) &&
      raymarch.width > 0 &&
      raymarch.height > 0;
    const pixelsConsistent =
      dimensionsPositive &&
      raymarch.pixelsDispatched === raymarch.width * raymarch.height;
    const tierDimensionsConsistent = halfRes
      ? raymarch?.width === realization?.halfWidth &&
        raymarch?.height === realization?.halfHeight
      : raymarch?.width === canvas?.width &&
        raymarch?.height === canvas?.height;
    const facts = {
      framesDelta,
      culledDelta,
      passCount: after?.passCount ?? null,
      proceduralPassName,
      proceduralPassCount: passes?.[proceduralPassName] ?? null,
      raymarch: serializable(raymarch),
      halfResActive: halfRes,
      dimensionsPositive,
      pixelsConsistent,
      tierDimensionsConsistent,
      realization: serializable(realization),
    };
    const reasons = [];
    if (!(framesDelta > 0)) reasons.push("cloud-frames-did-not-advance");
    if (culledDelta !== 0) reasons.push("cloud-frame-was-culled");
    if (!(after?.passCount > 0)) reasons.push("cloud-pass-count-not-positive");
    if (passes?.[proceduralPassName] !== 1) {
      reasons.push("cloud-procedural-pass-count-not-one");
    }
    if (!dimensionsPositive) {
      reasons.push("cloud-march-dimensions-not-positive");
    }
    if (!pixelsConsistent) reasons.push("cloud-march-pixels-inconsistent");
    if (!tierDimensionsConsistent) {
      reasons.push("cloud-tier-dimensions-inconsistent");
    }
    return { facts, reasons, actualWork: reasons.length === 0 };
  };
  const realizedConfigMatches = (requested, realized) => {
    const reasons = [];
    if (!requested || !realized) {
      return {
        matches: false,
        reasons: ["godray-requested-or-realized-config-unavailable"],
      };
    }
    for (const key of [
      "density",
      "decay",
      "weight",
      "exposure",
      "sampleCount",
      "occlusionFarCutoff",
    ]) {
      if (own(requested, key) && !Object.is(requested[key], realized[key])) {
        reasons.push(`godray-config-${key}-not-realized`);
      }
    }
    return { matches: reasons.length === 0, reasons };
  };
  const godRayWorkFacts = (records, scene, effect) => {
    const record = records.length === 1 ? records[0] : undefined;
    const initialized = initializedGodRay(effect);
    const propagation = realizedConfigMatches(
      scene.godRayConfig,
      effect?._config,
    );
    const actualWorkReasons = [];
    if (records.length !== 1) {
      actualWorkReasons.push("godray-execute-delta-not-one");
    }
    if (record?.actualWork !== true) {
      actualWorkReasons.push("godray-actual-work-absent");
    }
    if (record?.passthrough !== false) {
      actualWorkReasons.push("godray-passthrough");
    }
    if (record?.initialized !== true || !initialized.initialized) {
      actualWorkReasons.push("godray-targets-not-initialized");
    }
    if (record?.resourceEpochStable !== true) {
      actualWorkReasons.push("godray-target-epoch-unstable");
    }
    if (record?.returnPinnedOutput !== true) {
      actualWorkReasons.push("godray-output-target-not-returned");
    }
    return {
      actualWork: actualWorkReasons.length === 0,
      reasons: [...actualWorkReasons, ...propagation.reasons],
      facts: {
        executeDelta: records.length,
        record: serializable(record),
        initialized,
        propagation,
      },
    };
  };

  const beginCell = (options = {}) => {
    const kind = options.kind;
    if (kind !== "cloud" && kind !== "godRay") {
      throw new Error("C13-42 cell kind must be cloud or godRay");
    }
    const viewer = resolveViewer(options);
    const scene = viewer.scene;
    const controls = resolveControls(options.controls);
    const enabledControlName = options.enabledControlName ?? controls[0].name;
    if (!controls.some((control) => control.name === enabledControlName)) {
      throw new Error("C13-42 enabled control is unavailable");
    }
    const expectedPhases =
      kind === "cloud" ? ["off", "on", "off"] : ["off", "on", "off", "on"];
    let observation;
    try {
      if (kind === "godRay") {
        if (
          !root.__c13_42GodRayObserver ||
          typeof root.__c13_42GodRayObserver.observeGodRay !== "function"
        ) {
          throw new Error("C13-42 GodRay observer is unavailable");
        }
        observation = root.__c13_42GodRayObserver.observeGodRay({
          viewer,
          maxCalls: options.maxGodRayCalls ?? 32,
          captureFrameWitness: options.controlledFrameWitness,
        });
      }
      const entryState = stateForViewer(viewer);
      const sessionId = `c13-42-${nextSessionId++}`;
      const session = {
        id: sessionId,
        kind,
        viewer,
        scene,
        controls,
        enabledControlName,
        expectedPhases,
        nextPhase: 0,
        entryState,
        invariant: invariantSnapshot(entryState),
        restoration: restorationRecord(viewer, controls),
        observation,
        observedRecords: 0,
        transitions: [],
        renderCalls: 0,
        finished: false,
      };
      const result = {
        sessionId,
        kind,
        expectedPhases: expectedPhases.slice(),
        entryState,
        controls: controls.map(controlReadback),
        observer: observation
          ? {
              effectId: observation.effectId,
              deviceId: observation.deviceId,
            }
          : null,
      };
      sessions.set(sessionId, session);
      return result;
    } catch (error) {
      if (observation) {
        try {
          observation.cleanup();
        } catch {
          // Preserve the setup failure after a best-effort observer cleanup.
        }
      }
      throw error;
    }
  };

  const controlValueMatches = (control, expected) =>
    control.property === "checked"
      ? Object.is(control.element.checked, Boolean(expected))
      : String(control.element.value) === String(expected);
  const observationDelta = (session, from) => {
    if (!session.observation) {
      return [];
    }
    return session.observation.snapshot().slice(from);
  };
  const actuateAndRender = (session, control, value) => {
    const observationStart = session.observation
      ? session.observation.snapshot().length
      : 0;
    const beforeStats = cloudStats(session.viewer);
    const readback = dispatchControl(control, value);
    const render = renderOneFrame(session);
    const afterStats = cloudStats(session.viewer);
    const state = stateForViewer(session.viewer);
    const effect =
      session.scene?._alternateSceneRenderer?.postProcessPipeline?.godRayEffect;
    const records = observationDelta(session, observationStart);
    session.observedRecords += records.length;
    return {
      control: readback,
      readbackMatches: controlValueMatches(control, value),
      render,
      beforeStats: serializable(beforeStats),
      afterStats: serializable(afterStats),
      state,
      godRayConfig: {
        requested: configSnapshot(session.scene.godRayConfig),
        realized: configSnapshot(effect?._config),
      },
      observerRecords: records,
    };
  };

  const transition = (sessionId, phase, options = {}) => {
    const session = requireSession(sessionId);
    const expectedPhase = session.expectedPhases[session.nextPhase];
    if (phase !== expectedPhase) {
      throw new Error(
        `C13-42 session ${sessionId} expected ${String(expectedPhase)}, received ${String(phase)}`,
      );
    }
    const refreshedControls = [];
    const refreshControlNames = options.refreshControlNames ?? [];
    if (!Array.isArray(refreshControlNames)) {
      throw new Error("C13-42 refreshControlNames must be an array");
    }
    for (const name of refreshControlNames) {
      const control = session.controls.find(
        (candidate) => candidate.name === name,
      );
      if (!control || control.name === session.enabledControlName) {
        throw new Error(
          `C13-42 refresh control ${String(name)} is unavailable`,
        );
      }
      refreshedControls.push(
        actuateAndRender(session, control, control.element[control.property]),
      );
    }

    const enabledControl = session.controls.find(
      (control) => control.name === session.enabledControlName,
    );
    const enabled = phase === "on";
    const expectedValue = enabled
      ? enabledControl.onValue
      : enabledControl.offValue;
    const phaseEvent = actuateAndRender(session, enabledControl, expectedValue);
    const invariant = invariantSnapshot(phaseEvent.state);
    const invariantStable =
      stableText(invariant) === stableText(session.invariant);
    const reasons = [];
    if (!phaseEvent.readbackMatches) {
      reasons.push("control-readback-mismatch");
    }
    if (!invariantStable) {
      reasons.push("camera-clock-frustum-mode-or-canvas-drift");
    }

    let work = {
      actualWork: false,
      reasons: [],
      facts: null,
    };
    if (enabled && session.kind === "cloud") {
      const realization = cloudRealization(session.viewer);
      work = cloudWorkFacts(
        phaseEvent.beforeStats,
        phaseEvent.afterStats,
        realization,
        phaseEvent.state.canvas,
      );
      reasons.push(...work.reasons);
    } else if (enabled && session.kind === "godRay") {
      work = godRayWorkFacts(
        phaseEvent.observerRecords,
        session.scene,
        session.restoration.effect,
      );
      reasons.push(...work.reasons);
    }

    const requestedEnabled =
      session.kind === "godRay"
        ? session.scene.godRayEnabled === true
        : phaseEvent.state.cloud.enableVolumetric === true;
    const enabledStateMatches =
      enabledControl.property !== "checked" || requestedEnabled === enabled;
    if (!enabledStateMatches) {
      reasons.push(`${session.kind}-enabled-state-mismatch`);
    }
    const result = {
      sessionId,
      kind: session.kind,
      phase,
      ordinal: session.nextPhase + 1,
      expectedPhases: session.expectedPhases.slice(),
      control: phaseEvent.control,
      controlReadbackMatches: phaseEvent.readbackMatches,
      enabledStateMatches,
      renderedFrames: 1,
      render: phaseEvent.render,
      refreshedControls,
      state: phaseEvent.state,
      invariantStable,
      cloudWork: session.kind === "cloud" ? work : null,
      godRayWork: session.kind === "godRay" ? work : null,
      observerRecords: serializable(phaseEvent.observerRecords),
      requirementsMet: reasons.length === 0,
      reasons,
    };
    session.nextPhase++;
    session.transitions.push(result);
    return serializable(result);
  };

  const validatePose = (pose, index) => {
    const destination = pose?.destination;
    if (
      !destination ||
      !Number.isFinite(destination.x) ||
      !Number.isFinite(destination.y) ||
      !Number.isFinite(destination.z)
    ) {
      throw new Error(
        `C13-42 motion pose ${index} requires finite destination`,
      );
    }
    return pose;
  };
  const driveMotion = (sessionId, options = {}) => {
    const session = requireSession(sessionId);
    const poses = options.poses;
    if (!Array.isArray(poses) || poses.length < 1 || poses.length > 128) {
      throw new Error("C13-42 motion route requires 1 through 128 poses");
    }
    const camera = session.scene.camera ?? session.viewer.camera;
    if (typeof camera?.setView !== "function") {
      throw new Error("C13-42 motion route requires camera.setView");
    }
    const frames = [];
    for (let index = 0; index < poses.length; index++) {
      const pose = validatePose(poses[index], index);
      const beforeStats = cloudStats(session.viewer);
      camera.setView({
        destination: pose.destination,
        orientation: pose.orientation,
      });
      const render = renderOneFrame(session);
      const afterStats = cloudStats(session.viewer);
      const state = stateForViewer(session.viewer);
      const realization = cloudRealization(session.viewer);
      frames.push({
        index,
        render,
        camera: state.camera,
        cloudWork: cloudWorkFacts(
          beforeStats,
          afterStats,
          realization,
          state.canvas,
        ),
      });
    }
    const reasons = frames.flatMap((frame) =>
      frame.cloudWork.reasons.map(
        (reason) => `motion-${frame.index}:${reason}`,
      ),
    );
    return serializable({
      sessionId,
      bounded: true,
      requestedFrames: poses.length,
      renderedFrames: frames.length,
      frames,
      finalState: stateForViewer(session.viewer),
      requirementsMet: reasons.length === 0,
      reasons,
    });
  };

  const restoreObjectFieldsExactly = (value, fields, reasons, label) => {
    if (value === null || typeof value !== "object") {
      reasons.push(`${label}-unavailable`);
      return;
    }
    const originalKeys = new Set(fields.map((field) => field.key));
    for (const key of Object.keys(value)) {
      if (!originalKeys.has(key)) {
        try {
          delete value[key];
        } catch {
          reasons.push(`${label}-${key}-delete-failed`);
        }
      }
    }
    restoreFields(value, fields, reasons, label);
  };
  const restorableSnapshot = (state) => ({
    selection: state.selection,
    camera: state.camera,
    mode: state.mode,
    requestRenderMode: state.requestRenderMode,
    clock: state.clock,
    canvas: state.canvas,
    cloud: {
      collectionPresent: state.cloud.collectionPresent,
      collectionId: state.cloud.collectionId,
      enableVolumetric: state.cloud.enableVolumetric,
      renderMode: state.cloud.renderMode,
      config: state.cloud.config,
    },
    godRay: state.godRay,
  });
  const finishCell = (sessionId) => {
    const session = requireSession(sessionId);
    const saved = session.restoration;
    const reasons = [];
    let observerCleanup = null;
    const sceneOwned = saved.viewer.scene === saved.scene;
    if (!sceneOwned) {
      reasons.push("scene-ownership-lost");
    }

    if (sceneOwned) {
      for (const control of saved.controls) {
        let current;
        try {
          const matches = root.document?.querySelectorAll?.(control.selector);
          current = matches?.length === 1 ? matches[0] : undefined;
        } catch {
          current = undefined;
        }
        if (current !== control.element) {
          reasons.push(`control-ownership-lost:${control.name}`);
          continue;
        }
        try {
          dispatchControl(control, control.originalValue);
        } catch {
          reasons.push(`control-restore-failed:${control.name}`);
        }
      }

      if ((saved.scene.camera ?? saved.viewer.camera) !== saved.camera) {
        reasons.push("camera-ownership-lost");
      } else {
        try {
          saved.camera.setView({
            destination: saved.position,
            orientation: {
              direction: saved.direction,
              up: saved.up,
            },
          });
        } catch {
          reasons.push("camera-pose-restore-failed");
        }
        if (saved.camera.frustum !== saved.frustum) {
          reasons.push("frustum-ownership-lost");
        } else {
          restoreFields(saved.frustum, saved.frustumFields, reasons, "frustum");
        }
      }

      if (saved.viewer.clock !== saved.clock) {
        reasons.push("clock-ownership-lost");
      } else if (saved.clock) {
        try {
          saved.clock.currentTime = copyTime(saved.currentTime);
          saved.clock.shouldAnimate = saved.shouldAnimate;
          saved.clock.canAnimate = saved.canAnimate;
          saved.clock.multiplier = saved.multiplier;
          saved.clock.clockStep = saved.clockStep;
          saved.clock.clockRange = saved.clockRange;
        } catch {
          reasons.push("clock-restore-failed");
        }
      }
      try {
        saved.scene.requestRenderMode = saved.requestRenderMode;
      } catch {
        reasons.push("request-render-mode-restore-failed");
      }

      const currentCollection = saved.scene.globe?.defaultCloudCollection;
      if (
        currentCollection !== saved.collection ||
        currentCollection?.volumetric !== saved.volumetric
      ) {
        reasons.push("cloud-ownership-lost");
      } else if (saved.collection) {
        try {
          saved.collection.enableVolumetric = saved.enableVolumetric;
        } catch {
          reasons.push("cloud-enable-restore-failed");
        }
        restoreObjectFieldsExactly(
          saved.volumetric,
          saved.volumetricFields,
          reasons,
          "cloud-config",
        );
      }

      const currentPipeline =
        saved.scene?._alternateSceneRenderer?.postProcessPipeline;
      const currentEffect = currentPipeline?.godRayEffect;
      if (
        currentPipeline !== saved.pipeline ||
        currentEffect !== saved.effect
      ) {
        reasons.push("godray-ownership-lost");
      } else {
        try {
          saved.scene.godRayEnabled = saved.godRayEnabled;
          saved.scene.godRayConfig = saved.godRayConfig;
          if (saved.effect) {
            saved.effect.enabled = saved.effectEnabled;
            saved.effect._config = saved.effectConfig;
          }
        } catch {
          reasons.push("godray-state-restore-failed");
        }
      }
    }

    if (session.observation) {
      try {
        observerCleanup = session.observation.cleanup();
        if (!observerCleanup.restored) {
          reasons.push("godray-observer-hook-not-restored");
        }
        if (!observerCleanup.valid) {
          reasons.push(
            ...observerCleanup.reasons.map(
              (reason) => `godray-observer:${reason}`,
            ),
          );
        }
      } catch (error) {
        reasons.push(
          `godray-observer-cleanup:${String(error?.message ?? error)}`,
        );
      }
    }

    let finalState;
    let exactStateRestored = false;
    if (sceneOwned) {
      try {
        finalState = stateForViewer(saved.viewer);
        exactStateRestored =
          stableText(restorableSnapshot(finalState)) ===
          stableText(restorableSnapshot(session.entryState));
        if (!exactStateRestored) {
          reasons.push("exact-state-restore-mismatch");
        }
      } catch (error) {
        reasons.push(`restoration-readback:${String(error?.message ?? error)}`);
      }
    }
    const controlsRestored = saved.controls.every((control) => {
      try {
        const matches = root.document?.querySelectorAll?.(control.selector);
        return (
          matches?.length === 1 &&
          matches[0] === control.element &&
          Object.is(control.element[control.property], control.originalValue)
        );
      } catch {
        return false;
      }
    });
    if (!controlsRestored) {
      reasons.push("control-readback-not-restored");
    }
    sessions.delete(sessionId);
    session.finished = true;
    return serializable({
      sessionId,
      restored:
        exactStateRestored &&
        controlsRestored &&
        (!session.observation || observerCleanup?.restored === true) &&
        reasons.length === 0,
      exactStateRestored,
      controlsRestored,
      observerCleanup,
      completedPhases: session.transitions.map((item) => item.phase),
      expectedPhases: session.expectedPhases.slice(),
      bracketComplete: session.nextPhase === session.expectedPhases.length,
      renderCalls: session.renderCalls,
      finalState,
      reasons: Array.from(new Set(reasons)),
    });
  };

  const controlledCaseIds = Object.freeze([
    "near-occluder",
    "emitter-only",
    "far-depth",
    "full-cover",
    "exposure-zero",
  ]);
  const requireControlledFixture = (fixtureId) => {
    const fixture = controlledFixtures.get(fixtureId);
    if (!fixture) {
      throw new Error(
        `controlled GodRay fixture ${String(fixtureId)} is unavailable`,
      );
    }
    return fixture;
  };
  const requireControlledCase = (caseSessionId) => {
    const caseState = controlledCases.get(caseSessionId);
    if (!caseState) {
      throw new Error(
        `controlled GodRay case ${String(caseSessionId)} is unavailable`,
      );
    }
    return caseState;
  };
  const requireControlledCanvasOwnership = (fixture) => {
    const matches = root.document.querySelectorAll(fixture.canvasSelector);
    if (
      fixture.canvas.id !== fixture.canvasId ||
      matches?.length !== 1 ||
      matches[0] !== fixture.canvas
    ) {
      throw new Error(
        "controlled GodRay capture canvas ownership is unavailable",
      );
    }
    return fixture.canvasSelector;
  };
  const controlledProviderTime = (time) => ({
    dayNumber: scalar(time?.dayNumber),
    secondsOfDay: scalar(time?.secondsOfDay),
  });
  const controlledFrameWitness = (fixture, caseState, scene, effect) => {
    const camera = scene.camera ?? fixture.widget.camera;
    const frameState = scene._frameState;
    const uniformState = frameState?.context?.uniformState;
    const frameTime = frameState?.time;
    const ephemerisSample = frameState?.celestialEphemerisSample;
    const ephemerisSun = ephemerisSample?.sunPositionWC;
    const ephemerisMoon = ephemerisSample?.moonPositionWC;
    const uniformSun = uniformState?.sunPositionWC;
    const frameTimeId = identity(frameTime);
    const ephemerisSampleId = identity(ephemerisSample);
    const ephemerisSunWitness = controlledVectorWitness(
      ephemerisSun,
      "execute-frame ephemeris Sun",
    );
    const ephemerisMoonWitness = controlledVectorWitness(
      ephemerisMoon,
      "execute-frame ephemeris Moon",
    );
    const uniformSunWitness = controlledVectorWitness(
      uniformSun,
      "execute-frame uniform Sun",
    );
    const viewMatrix = matrixArray(camera?.viewMatrix, "camera view matrix");
    const projectionMatrix = matrixArray(
      camera?.frustum?.projectionMatrix,
      "camera projection matrix",
    );
    const viewProjection = matrixArray(
      uniformState?.viewProjection,
      "execute-frame view-projection matrix",
    );
    const primitives = caseState.members.map((member) => {
      const modelMatrix = matrixArray(
        member.instance.modelMatrix,
        `${member.id} model matrix`,
      );
      const worldCorners = member.localCorners.map((corner) =>
        multiplyPoint(modelMatrix, corner).slice(0, 3),
      );
      return {
        id: member.id,
        role: member.role,
        primitiveId: identity(member.primitive),
        geometryInstanceId: identity(member.instance),
        dimensions: member.dimensions.slice(),
        modelMatrix,
        basis: {
          columns: [
            modelMatrix.slice(0, 3),
            modelMatrix.slice(4, 7),
            modelMatrix.slice(8, 11),
          ],
          determinant: member.basisDeterminant,
        },
        localCorners: member.localCorners.map((corner) => corner.slice()),
        worldCorners,
        projectedCorners: worldCorners.map((corner) =>
          projectPoint(viewProjection, corner),
        ),
        show: member.primitive.show === true,
        ready: member.primitive.ready === true,
        requestedColorBytes: member.requestedColorBytes.slice(),
        realizedColorBytes: member.realizedColorBytes?.slice() ?? null,
        depthTest: member.depthTest,
        depthMask: member.depthMask,
      };
    });
    const rawConfig = effect?._config;
    const rawConfigValues = Object.fromEntries(
      [
        "sunScreenU",
        "sunScreenV",
        "density",
        "decay",
        "weight",
        "exposure",
        "sampleCount",
        "occlusionFarCutoff",
      ].map((key) => [key, scalar(rawConfig?.[key])]),
    );
    const packedF32Expectation = Object.fromEntries(
      Object.entries(rawConfigValues).map(([key, value]) => [
        key,
        typeof value === "number" ? Math.fround(value) : value,
      ]),
    );
    const packedF32BitExpectation = Object.fromEntries(
      Object.entries(packedF32Expectation).map(([key, value]) => {
        if (typeof value !== "number") {
          return [key, null];
        }
        const floatValue = new Float32Array(1);
        const bitValue = new Uint32Array(floatValue.buffer);
        floatValue[0] = value;
        return [key, bitValue[0]];
      }),
    );
    const witness = {
      subjectId: "C-controlled-ray",
      identityNamespace: controlledIdentityNamespace,
      caseId: caseState.caseId,
      fixtureId: fixture.id,
      phase: fixture.phase,
      runId: fixture.runId,
      witnessOrdinal: caseState.nextWitnessOrdinal++,
      frameNumber: scalar(frameState?.frameNumber),
      providerTime: controlledProviderTime(fixture.providerState.time),
      provider: serializable(fixture.providerState),
      executeFrameEphemeris: {
        identityNamespace: controlledIdentityNamespace,
        time: {
          identity: frameTimeId,
          value: controlledProviderTime(frameTime),
        },
        sample: {
          identity: ephemerisSampleId,
          sun: ephemerisSunWitness,
          moon: ephemerisMoonWitness,
          providerId: scalar(ephemerisSample?.providerId),
          providerRevision: scalar(ephemerisSample?.providerRevision),
          provenance: serializable(ephemerisSample?.provenance),
          timePolicy: serializable(ephemerisSample?.timePolicy),
          transformBranch: scalar(ephemerisSample?.transformBranch),
          outputAllocationStable: scalar(
            ephemerisSample?.outputAllocationStable,
          ),
          thirdPartyTemporaryFree: scalar(
            ephemerisSample?.thirdPartyTemporaryFree,
          ),
        },
        uniformSun: uniformSunWitness,
        relations: {
          providerTimeIsFrameTime: fixture.providerState.timeId === frameTimeId,
          providerResultIsFrameSample:
            fixture.providerState.resultId === ephemerisSampleId,
          providerReturnedResultIsFrameSample:
            fixture.providerState.returnedResultId === ephemerisSampleId,
          providerSunIsFrameSampleSun:
            fixture.providerState.sunId === ephemerisSunWitness.identity,
          providerMoonIsFrameSampleMoon:
            fixture.providerState.moonId === ephemerisMoonWitness.identity,
          uniformSunAliasesFrameSampleSun:
            uniformSunWitness.identity === ephemerisSunWitness.identity,
          uniformSunValueMatchesFrameSampleSun: uniformSunWitness.value.every(
            (value, index) =>
              Object.is(value, ephemerisSunWitness.value[index]),
          ),
        },
      },
      camera: {
        ...cameraSnapshot(camera),
        viewMatrix,
        projectionMatrix,
        viewProjection,
      },
      primitives,
      backing: canvasSnapshot(scene),
      godRay: {
        shaderVariant: effect?.useShaderF16 === true ? "f16" : "f32",
        declaredJsConfig: configSnapshot(scene.godRayConfig),
        realizedJsConfig: rawConfigValues,
        packedF32Expectation,
        packedF32BitExpectation,
        packedUpload: {
          observed: false,
          bufferId: null,
          uploadEpoch: null,
          executeFrameBound: false,
          reason:
            "the observer does not instrument the owned GPU queue writeBuffer upload",
        },
        frameFrustum: {
          near: scalar(camera?.frustum?.near),
          far: scalar(camera?.frustum?.far),
          logActive: scene?.context?._logDepthWriteEnabled === true,
        },
        effect: initializedGodRay(effect),
        observerIdentityNamespace,
      },
    };
    caseState.lastFrameWitness = witness;
    return witness;
  };

  const acquireControlledGodRayFixture = async (options = {}) => {
    const Cesium = requirePlainObject(options.Cesium, "Cesium namespace");
    const request = requirePlainObject(
      controlledSerializable(options.request),
      "controlled GodRay fixture request",
    );
    const hostViewer = root.__cloudProbe.resolveViewer(options.hostViewer);
    if (typeof Cesium.CesiumWidget?.createAsync !== "function") {
      throw new Error(
        "controlled GodRay fixture requires CesiumWidget.createAsync",
      );
    }
    for (const name of [
      "CelestialEphemerisProvider",
      "Cartesian3",
      "JulianDate",
      "PrimitiveCollection",
      "Primitive",
      "GeometryInstance",
      "BoxGeometry",
      "Color",
      "ColorGeometryInstanceAttribute",
      "PerInstanceColorAppearance",
      "Matrix4",
    ]) {
      if (typeof Cesium[name] !== "function") {
        throw new Error(`controlled GodRay fixture requires Cesium.${name}`);
      }
    }
    const requestId = requireIdentifier(request.requestId, "requestId");
    if (request.phase !== "baseline" && request.phase !== "repair") {
      throw new Error("controlled GodRay phase must be baseline or repair");
    }
    if (typeof request.runId !== "string" || request.runId.length === 0) {
      throw new Error("controlled GodRay runId is required");
    }
    const hostId = requireIdentifier(request.hostId, "hostId");
    const controlId = requireIdentifier(request.controlId, "controlId");
    const canvasHostId = `${hostId}-canvas-host`;
    const canvasId = `${hostId}-canvas`;
    const fixtureDomIds = [hostId, canvasHostId, canvasId, controlId];
    if (new Set(fixtureDomIds).size !== fixtureDomIds.length) {
      throw new Error("controlled GodRay fixture DOM identifiers overlap");
    }
    if (fixtureDomIds.some((id) => root.document.getElementById(id))) {
      throw new Error("controlled GodRay fixture DOM identifiers are occupied");
    }
    if (request.width !== 512 || request.height !== 512) {
      throw new Error("controlled GodRay fixture requires a 512 by 512 host");
    }
    if (typeof request.timeIso !== "string" || request.timeIso.length === 0) {
      throw new Error("controlled GodRay fixture timeIso is required");
    }
    requirePlainObject(request.godRayConfig, "controlled GodRay config");
    const providerRequest = requirePlainObject(
      request.provider,
      "controlled GodRay provider request",
    );
    if (
      typeof providerRequest.id !== "string" ||
      providerRequest.id.length === 0
    ) {
      throw new Error("controlled GodRay provider id is required");
    }
    if (
      !Number.isSafeInteger(providerRequest.revision) ||
      providerRequest.revision < 0
    ) {
      throw new Error("controlled GodRay provider revision is invalid");
    }
    requirePlainObject(providerRequest.provenance, "provider provenance");
    requirePlainObject(providerRequest.timePolicy, "provider timePolicy");
    if (
      typeof providerRequest.transformBranch !== "string" ||
      providerRequest.transformBranch.length === 0
    ) {
      throw new Error("controlled GodRay provider transformBranch is required");
    }
    const sunPositionWC = requireFiniteArray(
      providerRequest.sunPositionWC,
      3,
      "provider sunPositionWC",
    );
    const moonPositionWC = requireFiniteArray(
      providerRequest.moonPositionWC,
      3,
      "provider moonPositionWC",
    );
    const cameraRequest = requirePlainObject(
      request.camera,
      "controlled GodRay camera request",
    );
    const cameraPosition = requireFiniteArray(
      cameraRequest.position,
      3,
      "camera position",
    );
    const cameraDirection = requireFiniteArray(
      cameraRequest.direction,
      3,
      "camera direction",
    );
    const cameraUp = requireFiniteArray(cameraRequest.up, 3, "camera up");
    const frustumRequest = requirePlainObject(
      cameraRequest.frustum,
      "camera frustum",
    );
    for (const key of ["fov", "aspectRatio", "near", "far"]) {
      if (!Number.isFinite(frustumRequest[key])) {
        throw new Error(`camera frustum ${key} must be finite`);
      }
    }
    const colorBytes = requireFiniteArray(
      request.colorBytes,
      4,
      "fixture colorBytes",
    );
    if (stableText(colorBytes) !== "[25,25,25,255]") {
      throw new Error(
        "controlled GodRay fixture requires byte-25 opaque color",
      );
    }
    const hostEntryState = restorableSnapshot(stateForViewer(hostViewer));
    const wrapper = root.document.createElement("div");
    const canvasHost = root.document.createElement("div");
    const control = root.document.createElement("input");
    wrapper.id = hostId;
    canvasHost.id = canvasHostId;
    canvasHost.style.width = "512px";
    canvasHost.style.height = "512px";
    control.id = controlId;
    control.type = "checkbox";
    control.checked = false;
    wrapper.appendChild(canvasHost);
    wrapper.appendChild(control);
    root.document.body.appendChild(wrapper);

    const provenance = Object.freeze({ ...providerRequest.provenance });
    const timePolicy = Object.freeze({ ...providerRequest.timePolicy });
    const providerState = {
      identityNamespace: controlledIdentityNamespace,
      id: providerRequest.id,
      revision: providerRequest.revision,
      provenance,
      timePolicy,
      transformBranch: providerRequest.transformBranch,
      outputAllocationStable: true,
      thirdPartyTemporaryFree: true,
      computeCount: 0,
      time: null,
      timeId: null,
      resultId: null,
      sunId: null,
      moonId: null,
      returnedResultId: null,
      firstResultId: null,
      firstSunId: null,
      firstMoonId: null,
      identitiesStable: true,
      sunPositionWC: null,
      moonPositionWC: null,
    };
    class ControlledGodRayProvider extends Cesium.CelestialEphemerisProvider {
      get id() {
        return providerRequest.id;
      }
      get revision() {
        return providerRequest.revision;
      }
      get provenance() {
        return provenance;
      }
      get timePolicy() {
        return timePolicy;
      }
      get outputAllocationStable() {
        return true;
      }
      get thirdPartyTemporaryFree() {
        return true;
      }
      compute(time, result) {
        result.sunPositionWC.x = sunPositionWC[0];
        result.sunPositionWC.y = sunPositionWC[1];
        result.sunPositionWC.z = sunPositionWC[2];
        result.moonPositionWC.x = moonPositionWC[0];
        result.moonPositionWC.y = moonPositionWC[1];
        result.moonPositionWC.z = moonPositionWC[2];
        const returned = Cesium.CelestialEphemerisProvider.finalizeResult(
          result,
          this,
          providerRequest.transformBranch,
        );
        providerState.computeCount++;
        providerState.time = time;
        providerState.timeId = identity(time);
        providerState.resultId = identity(result);
        providerState.sunId = identity(result.sunPositionWC);
        providerState.moonId = identity(result.moonPositionWC);
        providerState.returnedResultId = identity(returned);
        if (providerState.firstResultId === null) {
          providerState.firstResultId = providerState.resultId;
          providerState.firstSunId = providerState.sunId;
          providerState.firstMoonId = providerState.moonId;
        } else {
          providerState.identitiesStable =
            providerState.identitiesStable &&
            providerState.resultId === providerState.firstResultId &&
            providerState.sunId === providerState.firstSunId &&
            providerState.moonId === providerState.firstMoonId;
        }
        providerState.sunPositionWC = sunPositionWC.slice();
        providerState.moonPositionWC = moonPositionWC.slice();
        return returned;
      }
    }

    let widget;
    let controlListener;
    try {
      const clock = new Cesium.Clock({
        currentTime: Cesium.JulianDate.fromIso8601(request.timeIso),
        shouldAnimate: false,
      });
      widget = await Cesium.CesiumWidget.createAsync(canvasHost, {
        clock,
        celestialEphemerisProvider: new ControlledGodRayProvider(),
        contextOptions: { renderer: "webgpu" },
        baseLayer: false,
        globe: false,
        skyBox: false,
        skyAtmosphere: false,
        scene3DOnly: true,
        useBrowserRecommendedResolution: true,
        useDefaultRenderLoop: false,
        requestRenderMode: false,
      });
      widget.resolutionScale = 1;
      widget.resize();
      const scene = widget.scene;
      const canvas = scene.canvas ?? scene.context?._canvas;
      canvas.id = canvasId;
      if (
        canvas.width !== 512 ||
        canvas.height !== 512 ||
        canvas.clientWidth !== 512 ||
        canvas.clientHeight !== 512
      ) {
        throw new Error("controlled GodRay canvas is not exactly 512 by 512");
      }
      scene.requestRenderMode = false;
      scene.highDynamicRange = false;
      scene.godRayCloudAware = false;
      scene.godRayEnabled = false;
      scene.godRayConfig = { ...request.godRayConfig };
      if (scene.fog) scene.fog.enabled = false;
      if (scene.skyAtmosphere) scene.skyAtmosphere.show = false;
      if (scene.sun) scene.sun.show = false;
      if (scene.moon) scene.moon.show = false;
      if (Cesium.Color?.BLACK && typeof Cesium.Color.clone === "function") {
        scene.backgroundColor = Cesium.Color.clone(
          Cesium.Color.BLACK,
          scene.backgroundColor,
        );
      }
      const camera = scene.camera ?? widget.camera;
      camera.setView({
        destination: Cesium.Cartesian3.fromArray(cameraPosition),
        orientation: {
          direction: Cesium.Cartesian3.fromArray(cameraDirection),
          up: Cesium.Cartesian3.fromArray(cameraUp),
        },
      });
      camera.frustum.fov = frustumRequest.fov;
      camera.frustum.aspectRatio = frustumRequest.aspectRatio;
      camera.frustum.near = frustumRequest.near;
      camera.frustum.far = frustumRequest.far;
      controlListener = () => {
        scene.godRayEnabled = control.checked === true;
      };
      control.addEventListener("change", controlListener);
      const canvasMatches = root.document.querySelectorAll(`#${canvasId}`);
      const controlMatches = root.document.querySelectorAll(`#${controlId}`);
      if (
        canvasMatches?.length !== 1 ||
        canvasMatches[0] !== canvas ||
        controlMatches?.length !== 1 ||
        controlMatches[0] !== control
      ) {
        throw new Error(
          "controlled GodRay fixture DOM ownership is unavailable",
        );
      }
      const fixtureId = `controlled-godray-${nextControlledFixtureId++}`;
      const fixture = {
        id: fixtureId,
        requestId,
        phase: request.phase,
        runId: request.runId,
        Cesium,
        request,
        hostViewer,
        hostEntryState,
        wrapper,
        canvasHost,
        canvas,
        canvasId,
        canvasSelector: `#${canvasId}`,
        control,
        controlListener,
        widget,
        scene,
        providerState,
        colorBytes,
        cases: new Set(),
        caseDispositions: [],
        finished: false,
      };
      controlledFixtures.set(fixtureId, fixture);
      return controlledSerializable({
        fixtureId,
        requestId,
        identityNamespace: controlledIdentityNamespace,
        hostViewerId: identity(hostViewer),
        widgetId: identity(widget),
        sceneId: identity(scene),
        canvasId: identity(canvas),
        canvasDomId: canvasId,
        canvasSelector: fixture.canvasSelector,
        canvasOwnershipVerified: true,
        controlSelector: `#${controlId}`,
        backing: canvasSnapshot(scene),
      });
    } catch (error) {
      try {
        control.removeEventListener?.("change", controlListener);
      } catch {
        // Continue releasing the remaining fixture-owned objects.
      }
      try {
        let widgetDestroyed = false;
        try {
          widgetDestroyed = widget?.isDestroyed?.() === true;
        } catch {
          // A failed status read does not waive owned cleanup.
        }
        if (widget && !widgetDestroyed) widget.destroy();
      } catch {
        // Preserve the acquisition failure.
      }
      try {
        wrapper.remove();
      } catch {
        // Preserve the acquisition failure.
      }
      throw error;
    }
  };

  const beginControlledGodRayCase = async (fixtureId, caseRequest = {}) => {
    const fixture = requireControlledFixture(fixtureId);
    const request = requirePlainObject(
      controlledSerializable(caseRequest),
      "controlled GodRay case request",
    );
    if (!controlledCaseIds.includes(request.caseId)) {
      throw new Error("controlled GodRay case id is unavailable");
    }
    if (fixture.cases.size !== 0) {
      throw new Error("controlled GodRay fixture already has an active case");
    }
    const expectedMemberCount = request.caseId === "emitter-only" ? 1 : 2;
    if (
      !Array.isArray(request.primitives) ||
      request.primitives.length !== expectedMemberCount
    ) {
      throw new Error(
        `controlled GodRay ${request.caseId} requires ${expectedMemberCount} primitives`,
      );
    }
    const roles = request.primitives.map((item) => item?.role).sort();
    const expectedRoles =
      expectedMemberCount === 1 ? ["emitter"] : ["emitter", "occluder"];
    if (stableText(roles) !== stableText(expectedRoles)) {
      throw new Error("controlled GodRay primitive roles are invalid");
    }
    const { Cesium, scene } = fixture;
    const caseConfig = requirePlainObject(
      request.godRayConfig,
      "controlled GodRay case config",
    );
    const collection = new Cesium.PrimitiveCollection({
      destroyPrimitives: true,
    });
    const caseSessionId = `controlled-case-${nextControlledCaseId++}`;
    const caseState = {
      id: caseSessionId,
      fixture,
      caseId: request.caseId,
      collection,
      parentCollection: scene.primitives,
      addAttempted: false,
      membershipKnown: true,
      admitted: false,
      removeAttempted: false,
      removed: false,
      members: [],
      entryGodRayEnabled: scene.godRayEnabled,
      entryGodRayConfig: scene.godRayConfig,
      entryControlChecked: fixture.control.checked,
      harnessSessionId: null,
      pendingCapture: null,
      lastFrameWitness: null,
      nextWitnessOrdinal: 1,
      lastTransitionWitnessOrdinal: 0,
      operationFailure: null,
      finished: false,
    };
    controlledCases.set(caseSessionId, caseState);
    fixture.cases.add(caseSessionId);
    try {
      for (const item of request.primitives) {
        const id = requireIdentifier(item.id, "controlled primitive id");
        const dimensions = requireFiniteArray(
          item.dimensions,
          3,
          `${id} dimensions`,
        );
        if (dimensions.some((value) => !(value > 0))) {
          throw new Error(`${id} dimensions must be positive`);
        }
        const requestedModelMatrix = requireFiniteArray(
          item.modelMatrix,
          16,
          `${id} modelMatrix`,
        );
        const basisDeterminant =
          requestedModelMatrix[0] *
            (requestedModelMatrix[5] * requestedModelMatrix[10] -
              requestedModelMatrix[9] * requestedModelMatrix[6]) -
          requestedModelMatrix[4] *
            (requestedModelMatrix[1] * requestedModelMatrix[10] -
              requestedModelMatrix[9] * requestedModelMatrix[2]) +
          requestedModelMatrix[8] *
            (requestedModelMatrix[1] * requestedModelMatrix[6] -
              requestedModelMatrix[5] * requestedModelMatrix[2]);
        if (!(basisDeterminant > 0)) {
          throw new Error(`${id} modelMatrix must have a proper-handed basis`);
        }
        const modelMatrix = Cesium.Matrix4.fromArray(requestedModelMatrix);
        const color = Cesium.Color.fromBytes(...fixture.colorBytes);
        const colorAttribute =
          Cesium.ColorGeometryInstanceAttribute.fromColor(color);
        const requestedColorBytes = Array.from(colorAttribute.value);
        const instance = new Cesium.GeometryInstance({
          id,
          geometry: Cesium.BoxGeometry.fromDimensions({
            dimensions: Cesium.Cartesian3.fromArray(dimensions),
          }),
          modelMatrix,
          attributes: { color: colorAttribute },
        });
        const depthTest = { enabled: true };
        const primitive = new Cesium.Primitive({
          geometryInstances: instance,
          appearance: new Cesium.PerInstanceColorAppearance({
            flat: true,
            translucent: false,
            closed: true,
            renderState: { depthTest, depthMask: true },
          }),
          asynchronous: false,
          releaseGeometryInstances: false,
          allowPicking: false,
        });
        collection.add(primitive);
        caseState.members.push({
          id,
          role: item.role,
          dimensions,
          localCorners: localBoxCorners(dimensions),
          instance,
          primitive,
          requestedColorBytes,
          realizedColorBytes: null,
          depthTest: true,
          depthMask: true,
          basisDeterminant,
        });
      }
      caseState.addAttempted = true;
      caseState.membershipKnown = false;
      caseState.parentCollection.add(collection);
      caseState.admitted =
        caseState.parentCollection.contains(collection) === true;
      caseState.membershipKnown = true;
      if (!caseState.admitted) {
        throw new Error("controlled GodRay case was not admitted to its owner");
      }
      const maxReadyFrames = request.maxReadyFrames ?? 64;
      if (
        !Number.isSafeInteger(maxReadyFrames) ||
        maxReadyFrames < 1 ||
        maxReadyFrames > 256
      ) {
        throw new Error("controlled GodRay maxReadyFrames is invalid");
      }
      scene.godRayEnabled = true;
      scene.godRayConfig = {
        ...fixture.request.godRayConfig,
        ...caseConfig,
      };
      fixture.control.checked = true;
      let ready = false;
      for (let index = 0; index < maxReadyFrames; index++) {
        scene.requestRender?.();
        scene.render(fixture.widget.clock?.currentTime);
        const effect =
          scene?._alternateSceneRenderer?.postProcessPipeline?.godRayEffect;
        ready =
          caseState.members.every(
            (member) => member.primitive.ready === true,
          ) && initializedGodRay(effect).initialized;
        if (ready) break;
        await new Promise((resolve) => {
          if (typeof root.requestAnimationFrame === "function") {
            root.requestAnimationFrame(() => resolve());
          } else {
            resolve();
          }
        });
      }
      if (!ready) {
        throw new Error("controlled GodRay case did not become ready");
      }
      for (const member of caseState.members) {
        const attributes = member.primitive.getGeometryInstanceAttributes(
          member.id,
        );
        member.realizedColorBytes = Array.from(attributes?.color ?? []);
        if (
          stableText(member.realizedColorBytes) !==
          stableText(member.requestedColorBytes)
        ) {
          throw new Error(`${member.id} color was not realized exactly`);
        }
      }
      scene.godRayEnabled = false;
      fixture.control.checked = false;
      const begun = beginCell({
        kind: "godRay",
        viewer: fixture.widget,
        controls: [
          {
            name: "enabled",
            selector: `#${fixture.control.id}`,
            property: "checked",
            event: "change",
            offValue: false,
            onValue: true,
          },
        ],
        enabledControlName: "enabled",
        controlledFrameWitness: ({ scene: observedScene, effect }) =>
          controlledFrameWitness(fixture, caseState, observedScene, effect),
      });
      caseState.harnessSessionId = begun.sessionId;
      return controlledSerializable({
        caseSessionId,
        fixtureId,
        caseId: caseState.caseId,
        harnessSessionId: begun.sessionId,
        expectedMemberCount,
        realizedMemberCount: caseState.members.length,
        primitiveIds: caseState.members.map((member) => member.id),
        readiness: caseState.members.map((member) => ({
          id: member.id,
          ready: member.primitive.ready === true,
          show: member.primitive.show === true,
          requestedColorBytes: member.requestedColorBytes,
          realizedColorBytes: member.realizedColorBytes,
          depthTest: member.depthTest,
          depthMask: member.depthMask,
        })),
      });
    } catch (error) {
      caseState.operationFailure = errorText(error);
      finishControlledGodRayCase(caseSessionId);
      throw error;
    }
  };

  const transitionControlledGodRayCase = (caseSessionId, phase) => {
    const caseState = requireControlledCase(caseSessionId);
    const canvasSelector = requireControlledCanvasOwnership(caseState.fixture);
    if (caseState.pendingCapture !== null) {
      throw new Error("controlled GodRay capture confirmation is pending");
    }
    caseState.lastFrameWitness = null;
    const harnessSession = requireSession(caseState.harnessSessionId);
    const observationStart = harnessSession.observation?.snapshot().length ?? 0;
    const transitionResult = transition(caseState.harnessSessionId, phase);
    const observerRecords = (
      harnessSession.observation?.snapshot() ?? []
    ).slice(observationStart);
    const observerRecord =
      observerRecords.length === 1 ? observerRecords[0] : null;
    let pageWitness = caseState.lastFrameWitness;
    if (phase === "on") {
      if (
        !pageWitness ||
        observerRecord === null ||
        !observerRecord.frameWitness
      ) {
        throw new Error(
          "controlled GodRay execute-frame witness is unavailable",
        );
      }
    } else if (!pageWitness) {
      const effect =
        caseState.fixture.scene?._alternateSceneRenderer?.postProcessPipeline
          ?.godRayEffect;
      pageWitness = controlledFrameWitness(
        caseState.fixture,
        caseState,
        caseState.fixture.scene,
        effect,
      );
    }
    if (
      pageWitness.witnessOrdinal !==
      caseState.lastTransitionWitnessOrdinal + 1
    ) {
      throw new Error("controlled GodRay frame witness is stale");
    }
    caseState.lastTransitionWitnessOrdinal = pageWitness.witnessOrdinal;
    const frameNumber = caseState.fixture.scene?._frameState?.frameNumber;
    const token = `${caseSessionId}-${transitionResult.ordinal}-${String(frameNumber)}`;
    caseState.pendingCapture = { token, frameNumber };
    return controlledSerializable({
      caseSessionId,
      fixtureId: caseState.fixture.id,
      caseId: caseState.caseId,
      phase,
      captureToken: token,
      canvasSelector,
      postTransitionFrame: scalar(frameNumber),
      pageWitness: {
        ...pageWitness,
        godRayInvocation:
          observerRecord === null
            ? null
            : {
                identityNamespace: observerIdentityNamespace,
                ordinal: observerRecord.ordinal,
                disabled: observerRecord.disabled,
                sourcePresent: observerRecord.sourcePresent,
                depthPresent: observerRecord.depthPresent,
                sourceViewId: observerRecord.sourceViewId,
                depthViewId: observerRecord.depthViewId,
                returnedViewId: observerRecord.returnedViewId,
                returnPinnedOutput: observerRecord.returnPinnedOutput,
                resourceEpochStable: observerRecord.resourceEpochStable,
                actualWork: observerRecord.actualWork,
                outcome: observerRecord.outcome,
              },
      },
      transition: transitionResult,
    });
  };

  const confirmControlledGodRayCapture = (caseSessionId, captureToken) => {
    const caseState = requireControlledCase(caseSessionId);
    const pending = caseState.pendingCapture;
    if (!pending || pending.token !== captureToken) {
      throw new Error("controlled GodRay capture token is unavailable");
    }
    requireControlledCanvasOwnership(caseState.fixture);
    const currentFrame = caseState.fixture.scene?._frameState?.frameNumber;
    if (!Object.is(currentFrame, pending.frameNumber)) {
      throw new Error("controlled GodRay capture frame advanced");
    }
    const result = {
      caseSessionId,
      caseId: caseState.caseId,
      captureToken,
      capturedFrame: scalar(pending.frameNumber),
      currentFrame: scalar(currentFrame),
      fixtureFrameUnchanged: true,
      canvasOwnershipVerified: true,
    };
    caseState.pendingCapture = null;
    return controlledSerializable(result);
  };

  const finishControlledGodRayCase = (caseSessionId) => {
    const caseState = requireControlledCase(caseSessionId);
    if (caseState.finished) {
      throw new Error("controlled GodRay case is already finished");
    }
    const reasons = [];
    let harnessCleanup = null;
    if (caseState.operationFailure !== null) {
      reasons.push(`case-operation-failed:${caseState.operationFailure}`);
    }
    if (caseState.pendingCapture !== null) {
      reasons.push("capture-confirmation-missing");
    }
    if (
      caseState.harnessSessionId !== null &&
      sessions.has(caseState.harnessSessionId)
    ) {
      try {
        harnessCleanup = finishCell(caseState.harnessSessionId);
        if (!harnessCleanup.restored) {
          reasons.push("harness-session-not-restored");
        }
        if (!harnessCleanup.bracketComplete) {
          reasons.push("harness-bracket-incomplete");
        }
      } catch (error) {
        reasons.push(`harness-cleanup:${errorText(error)}`);
      }
    }
    const { fixture, collection } = caseState;
    try {
      fixture.scene.godRayEnabled = caseState.entryGodRayEnabled;
      fixture.scene.godRayConfig = caseState.entryGodRayConfig;
      fixture.control.checked = caseState.entryControlChecked;
    } catch (error) {
      reasons.push(`case-state-restore:${errorText(error)}`);
    }
    let parentContains = false;
    if (caseState.addAttempted) {
      caseState.membershipKnown = false;
      try {
        parentContains =
          caseState.parentCollection.contains(collection) === true;
        caseState.membershipKnown = true;
        if (parentContains) {
          caseState.admitted = true;
        }
      } catch (error) {
        reasons.push(`fixture-collection-membership:${errorText(error)}`);
      }
    }
    if (caseState.membershipKnown) {
      if (parentContains) {
        caseState.removeAttempted = true;
        try {
          caseState.removed =
            caseState.parentCollection.remove(collection) === true;
          if (!caseState.removed) {
            reasons.push("fixture-collection-remove-failed");
          }
        } catch (error) {
          reasons.push(`fixture-collection-remove:${errorText(error)}`);
        }
        try {
          if (!collection.isDestroyed?.()) {
            reasons.push("removed-fixture-collection-not-destroyed");
          }
        } catch (error) {
          reasons.push(
            `fixture-collection-destroy-readback:${errorText(error)}`,
          );
        }
      } else if (caseState.admitted) {
        reasons.push("fixture-collection-ownership-lost");
      } else {
        try {
          if (!collection.isDestroyed?.()) collection.destroy();
        } catch (error) {
          reasons.push(
            `unparented-fixture-collection-destroy:${errorText(error)}`,
          );
        }
      }
    } else {
      reasons.push("fixture-collection-membership-unreadable");
    }
    let destroyed;
    try {
      destroyed = collection.isDestroyed?.() === true;
    } catch {
      destroyed = false;
    }
    caseState.finished = true;
    fixture.cases.delete(caseSessionId);
    controlledCases.delete(caseSessionId);
    const disposition = controlledSerializable({
      caseSessionId,
      caseId: caseState.caseId,
      sessionFinished: harnessCleanup !== null,
      observerReset: harnessCleanup?.observerCleanup?.restored === true,
      bracketComplete: harnessCleanup?.bracketComplete === true,
      addAttempted: caseState.addAttempted,
      membershipKnown: caseState.membershipKnown,
      parentContains,
      admitted: caseState.admitted,
      removeAttempted: caseState.removeAttempted,
      removed: caseState.removed,
      destroyed,
      reasons: Array.from(new Set(reasons)),
      complete: reasons.length === 0,
    });
    fixture.caseDispositions.push(disposition);
    return disposition;
  };

  const finishControlledGodRayFixture = (fixtureId) => {
    const fixture = requireControlledFixture(fixtureId);
    const reasons = [];
    for (const caseSessionId of Array.from(fixture.cases).reverse()) {
      try {
        finishControlledGodRayCase(caseSessionId);
      } catch (error) {
        reasons.push(`case-cleanup:${errorText(error)}`);
      }
    }
    for (const disposition of fixture.caseDispositions) {
      if (disposition.complete !== true) {
        reasons.push(`case-incomplete:${disposition.caseId}`);
        for (const reason of disposition.reasons ?? []) {
          reasons.push(`case:${disposition.caseId}:${reason}`);
        }
      }
    }
    let controlListenerRemoved = false;
    try {
      fixture.control.removeEventListener("change", fixture.controlListener);
      controlListenerRemoved = true;
    } catch (error) {
      reasons.push(`control-listener-cleanup:${errorText(error)}`);
    }
    let widgetDestroyAttempted = false;
    let widgetWasDestroyed = false;
    try {
      widgetWasDestroyed = fixture.widget.isDestroyed?.() === true;
    } catch (error) {
      reasons.push(`widget-destroy-status:${errorText(error)}`);
    }
    if (!widgetWasDestroyed) {
      widgetDestroyAttempted = true;
      try {
        fixture.widget.destroy();
      } catch (error) {
        reasons.push(`widget-destroy:${errorText(error)}`);
      }
    }
    let widgetDestroyed = false;
    try {
      widgetDestroyed = fixture.widget.isDestroyed?.() === true;
      if (!widgetDestroyed) reasons.push("widget-not-destroyed");
    } catch (error) {
      reasons.push(`widget-destroy-readback:${errorText(error)}`);
    }
    let canvasReleaseSettled = false;
    try {
      const currentCanvas = root.document.getElementById(fixture.canvasId);
      if (currentCanvas === null) {
        canvasReleaseSettled = true;
      } else if (currentCanvas === fixture.canvas) {
        fixture.canvas.remove();
        canvasReleaseSettled =
          root.document.getElementById(fixture.canvasId) === null;
        if (!canvasReleaseSettled) {
          reasons.push("fixture-canvas-remove-failed");
        }
      } else {
        reasons.push("fixture-canvas-ownership-lost");
      }
    } catch (error) {
      reasons.push(`fixture-canvas-release:${errorText(error)}`);
    }
    try {
      fixture.wrapper.remove();
    } catch (error) {
      reasons.push(`fixture-host-remove:${errorText(error)}`);
    }
    let hostRemoved = false;
    let canvasHostRemoved = false;
    let canvasRemoved = false;
    let controlRemoved = false;
    try {
      hostRemoved = root.document.getElementById(fixture.wrapper.id) === null;
      canvasHostRemoved =
        root.document.getElementById(fixture.canvasHost.id) === null;
      canvasRemoved = root.document.getElementById(fixture.canvasId) === null;
      controlRemoved =
        root.document.getElementById(fixture.control.id) === null;
    } catch (error) {
      reasons.push(`fixture-dom-readback:${errorText(error)}`);
    }
    if (!hostRemoved) reasons.push("fixture-host-still-present");
    if (!canvasHostRemoved) reasons.push("fixture-canvas-host-still-present");
    if (!canvasRemoved) reasons.push("fixture-canvas-still-present");
    if (!controlRemoved) reasons.push("fixture-control-still-present");
    let hostViewerUnchanged = false;
    try {
      hostViewerUnchanged =
        stableText(restorableSnapshot(stateForViewer(fixture.hostViewer))) ===
        stableText(fixture.hostEntryState);
      if (!hostViewerUnchanged) reasons.push("host-viewer-mutated");
    } catch (error) {
      reasons.push(`host-viewer-readback:${errorText(error)}`);
    }
    fixture.finished = true;
    controlledFixtures.delete(fixtureId);
    return controlledSerializable({
      fixtureId,
      caseDispositions: fixture.caseDispositions.slice(),
      nestedCasesComplete: fixture.caseDispositions.every(
        (disposition) => disposition.complete === true,
      ),
      controlListenerRemoved,
      widgetDestroyAttempted,
      widgetDestroyed,
      canvasReleaseSettled,
      hostRemoved,
      canvasHostRemoved,
      canvasRemoved,
      controlRemoved,
      hostViewerUnchanged,
      reasons: Array.from(new Set(reasons)),
      complete: reasons.length === 0,
    });
  };

  const runBracket = (kind, options = {}) => {
    let begun;
    const transitions = [];
    let error = null;
    let restoration = null;
    try {
      begun = beginCell({ ...options, kind });
      for (const phase of begun.expectedPhases) {
        transitions.push(transition(begun.sessionId, phase));
      }
    } catch (caught) {
      error = String(caught?.message ?? caught);
    } finally {
      if (begun && sessions.has(begun.sessionId)) {
        restoration = finishCell(begun.sessionId);
      }
    }
    return serializable({
      kind,
      sessionId: begun?.sessionId ?? null,
      transitions,
      restoration,
      completed:
        error === null &&
        transitions.length === begun?.expectedPhases?.length &&
        restoration?.restored === true,
      error,
    });
  };
  const runCloudBracket = (options = {}) => runBracket("cloud", options);
  const runGodRayBracket = (options = {}) => runBracket("godRay", options);
  const runMotionRoute = (options = {}) => {
    let begun;
    let motion;
    let error = null;
    let restoration = null;
    try {
      begun = beginCell({ ...options, kind: options.kind ?? "cloud" });
      motion = driveMotion(begun.sessionId, { poses: options.poses });
    } catch (caught) {
      error = String(caught?.message ?? caught);
    } finally {
      if (begun && sessions.has(begun.sessionId)) {
        restoration = finishCell(begun.sessionId);
      }
    }
    return serializable({
      sessionId: begun?.sessionId ?? null,
      motion,
      restoration,
      completed: error === null && restoration?.restored === true,
      error,
    });
  };
  const restore = () => {
    const controlledReports = [];
    for (const fixtureId of Array.from(controlledFixtures.keys()).reverse()) {
      controlledReports.push(finishControlledGodRayFixture(fixtureId));
    }
    const reports = [];
    for (const sessionId of Array.from(sessions.keys()).reverse()) {
      reports.push(finishCell(sessionId));
    }
    const result = {
      restored:
        reports.every((report) => report.restored) &&
        controlledReports.every((report) => report.complete),
      reports,
    };
    if (controlledReports.length > 0) {
      result.controlledFixtures = controlledReports;
    }
    return result;
  };

  const api = {
    snapshotState,
    beginCell,
    transition,
    driveMotion,
    finishCell,
    runCloudBracket,
    runGodRayBracket,
    runMotionRoute,
    restore,
    acquireControlledGodRayFixture,
    beginControlledGodRayCase,
    transitionControlledGodRayCase,
    confirmControlledGodRayCapture,
    finishControlledGodRayCase,
    finishControlledGodRayFixture,
  };
  Object.defineProperty(api, brandKey, {
    configurable: false,
    enumerable: false,
    writable: false,
    value: brandValue,
  });
  Object.freeze(api);
  Object.defineProperty(root, driverKey, {
    configurable: false,
    enumerable: false,
    writable: false,
    value: api,
  });
  return api;
}
