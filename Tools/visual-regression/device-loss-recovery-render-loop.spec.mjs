/**
 * @purpose Proves a recoverable WebGPU device loss declines the frames that arrive during recovery instead of raising the terminal-loss error out of the render loop, and that the successor device is usable without a reload.
 * @status ACTIVE
 *
 * WHAT THIS SPEC IS FOR.
 *
 * WebGPU publishes device loss as a promise and recovery takes seconds. The
 * render loop keeps producing frames throughout that window. The context used
 * to answer every one of them, at five separate entry points, with
 *
 *   DeveloperError: Context's WebGPU device is terminally lost.
 *
 * for a device that was not terminally lost at all - it was mid-recovery. One
 * such throw escapes `Scene.render`, is caught by `tryAndCatchError`, raised as
 * `scene.renderError`, and the widget's handler sets `_useDefaultRenderLoop =
 * false` and `_renderLoopRunning = false`. That is permanent: when recovery
 * later publishes a healthy successor device there is no loop left to draw on
 * it, so the canvas keeps the black it was cleared to and every lazily-rebuilt
 * subsystem stays in its post-invalidation state because no frame ever runs.
 *
 * A PREMISE THIS SPEC CORRECTS. The reported symptom put the failing `clear()`
 * on the healthy successor device. It is not there: on a successor device the
 * unavailability predicate is already false, so `clear()` returns normally both
 * before and after the fix, and an assertion written only against that state
 * discriminates nothing. The discriminating frame is the one that arrives while
 * the old device is lost - so this spec asserts that frame, and keeps the
 * successor-device assertions as the consequence they are.
 *
 * HOW IT IS TESTED. The real `WebGPUContext` prototype, the real device-liveness
 * registry, the real invalidation bus, the real scene-renderer frame entry
 * points and the real model-arena resolver - nothing on the path is
 * re-implemented. Contexts are built with `Object.create(WebGPUContext.prototype)`
 * and given only the fields the methods under test read, which is the pattern
 * `pipeline-cache-invalidation-subscriptions.spec.mjs` and
 * `texture-mip-queue-safety.spec.mjs` already use for this class. Loss is
 * published through `markDeviceLost` - the same call the engine's own
 * `device.lost` handler makes first - rather than by setting a harness boolean,
 * so the predicate under test evaluates its real input.
 *
 * The observables are behavioural, never source shape:
 *   - whether a call throws, and which message,
 *   - whether the call was ADMITTED past the guard (the clear-call counter
 *     ticks, the draw reaches the pass encoder) or DECLINED,
 *   - which device each rebuilt subsystem is bound to,
 *   - whether the recovery hook asks the scene for the frame that rebuilds it.
 *
 * INERTNESS. The last group re-imports the engine modules through a loader hook
 * that makes the fix unreachable (`if (false && ...)`) and requires the
 * behavioural tests to go red. A spec that survives its own mutant is asserting
 * the harness, not the engine.
 *
 * Run: node --test Tools/visual-regression/device-loss-recovery-render-loop.spec.mjs
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import { registerHooks } from "node:module";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import ts from "typescript";

import { enableEngineTsResolution } from "./lib/engine-ts-resolver.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const engineWebGPU = path.resolve(
  here,
  "../../packages/engine/Source/Renderer/WebGPU",
);

// ───────────────────────────────────────────────────────────────────────────
// Loader: engine TypeScript, absent shader barrels, and the inertness mutants
// ───────────────────────────────────────────────────────────────────────────
//
// A mutant is requested with a `?q65mutant=<name>` query on the module URL.
// Node keys the module cache on the full URL, so the mutated copy loads beside
// the pristine one in the same process; its own relative imports drop the query
// and therefore resolve to the SAME shared modules - in particular the one
// device-liveness registry both copies consult.

const MUTANTS = {
  /**
   * The narrowing that separates a recoverable loss from a terminal one is made
   * inert, restoring the pre-fix behaviour: throw for any unavailability.
   */
  "narrowing-inert": {
    file: "WebGPUContext.ts",
    from: "    if (this._isDeviceTerminallyUnavailable) {",
    to: "    if (!(false && this._isDeviceTerminallyUnavailable)) {",
  },
  /**
   * The whole terminal thrower is made inert. Nothing recoverable changes; the
   * terminal-path tests must go red, which is what proves they are not vacuous.
   */
  "thrower-inert": {
    file: "WebGPUContext.ts",
    from: "    if (this._isDeviceTerminallyUnavailable) {",
    to: "    if (false && this._isDeviceTerminallyUnavailable) {",
  },
  /**
   * The model-arena resolver's liveness arm is made inert, restoring the loud
   * throw on the first model frame of a recovery window.
   */
  "model-liveness-inert": {
    file: "WebGPUModelRenderer.ts",
    from: "      isDeviceLost(context.device)",
    to: "      (false && isDeviceLost(context.device))",
  },
};

function applyMutant(source, name, file) {
  const mutant = MUTANTS[name];
  if (!mutant) {
    throw new Error(`unknown mutant "${name}"`);
  }
  if (!file.endsWith(mutant.file)) {
    return source;
  }
  const parts = source.split(mutant.from);
  if (parts.length !== 2) {
    throw new Error(
      `mutant "${name}" matched ${parts.length - 1} sites in ${mutant.file}; a mutant that does not apply proves nothing`,
    );
  }
  return parts.join(mutant.to);
}

registerHooks({
  resolve(specifier, context, nextResolve) {
    // Engine shader barrels are generated by the build and are absent from a
    // source-only checkout. Nothing on the device-loss path reads one.
    if (
      (specifier.startsWith("./") || specifier.startsWith("../")) &&
      specifier.endsWith(".js") &&
      typeof context.parentURL === "string" &&
      context.parentURL.startsWith("file:")
    ) {
      const asJs = new URL(specifier, context.parentURL);
      if (
        asJs.pathname.includes("/packages/engine/Source/Shaders/") &&
        !fs.existsSync(fileURLToPath(asJs))
      ) {
        return {
          url: "data:text/javascript,export default%20%22%22%3B",
          shortCircuit: true,
        };
      }
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    const [bare, query] = url.split("?");
    if (!bare.endsWith(".ts")) {
      return nextLoad(url, context);
    }
    const file = fileURLToPath(bare);
    let source = fs.readFileSync(file, "utf8");
    const search = new URLSearchParams(query ?? "");
    const mutant = search.get("q65mutant");
    if (mutant) {
      source = applyMutant(source, mutant, file);
    }
    if (search.get("q65expose") === "1") {
      // `resolveModelCameraArenaOwner` is module-private. Appending the export
      // is how `model-camera-arena.spec.mjs` already reaches it; the function
      // body itself is untouched.
      source += "\nexport { resolveModelCameraArenaOwner };\n";
    }
    return {
      format: "module",
      source: ts.transpileModule(source, {
        compilerOptions: {
          module: ts.ModuleKind.ESNext,
          target: ts.ScriptTarget.ES2022,
          verbatimModuleSyntax: false,
        },
      }).outputText,
      shortCircuit: true,
    };
  },
});
enableEngineTsResolution();

globalThis.GPUTextureUsage ??= Object.freeze({
  STORAGE_BINDING: 1,
  TEXTURE_BINDING: 2,
  COPY_SRC: 4,
  COPY_DST: 8,
  RENDER_ATTACHMENT: 16,
});
globalThis.GPUBufferUsage ??= Object.freeze({
  UNIFORM: 1,
  COPY_DST: 2,
  STORAGE: 4,
  VERTEX: 8,
  INDEX: 16,
  COPY_SRC: 32,
});
globalThis.GPUShaderStage ??= Object.freeze({
  VERTEX: 1,
  FRAGMENT: 2,
  COMPUTE: 4,
});

const contextUrl = pathToFileURL(
  path.resolve(engineWebGPU, "WebGPUContext.ts"),
).href;
const modelRendererUrl = pathToFileURL(
  path.resolve(engineWebGPU, "WebGPUModelRenderer.ts"),
).href;

const { default: WebGPUContext } = await import(contextUrl);
const { WebGPUDeviceInvalidationBus, markDeviceLost, isDeviceLost } =
  await import(
    pathToFileURL(path.resolve(engineWebGPU, "WebGPUDeviceInvalidationBus.ts"))
      .href
  );
const { WebGPUSceneRenderer } = await import(
  pathToFileURL(path.resolve(engineWebGPU, "WebGPUSceneRenderer.ts")).href
);
const { ensureResources } = await import(
  pathToFileURL(
    path.resolve(engineWebGPU, "WebGPUSceneRendererEnsureResources.ts"),
  ).href
);
const { resolveModelCameraArenaOwner } = await import(
  `${modelRendererUrl}?q65expose=1`
);

/** Load a second copy of the context class with one mutation applied. */
async function importMutatedContext(name) {
  const module = await import(`${contextUrl}?q65mutant=${name}`);
  return module.default;
}

// ───────────────────────────────────────────────────────────────────────────
// Fixtures
// ───────────────────────────────────────────────────────────────────────────

const devices = new Set();

/** A GPUDevice stub carrying only what the lazy subsystem getters call. */
function makeDevice(name) {
  const device = {
    name,
    createBuffer: () => ({ destroy() {} }),
    features: new Set(),
  };
  devices.add(device);
  return device;
}

/**
 * A context whose methods and accessors are the real ones, holding the minimum
 * instance state the frame entry points read. `_terminallyLost` rather than
 * `_isTerminallyLost` because the latter is an accessor pair on the prototype;
 * writing the backing field is what a harness may legitimately do, and it keeps
 * the derived predicates running their real expressions.
 */
function makeContext(ContextClass, device) {
  const context = Object.create(ContextClass.prototype);
  context._id = "spec";
  context._device = device;
  context._isDestroyed = false;
  context._terminallyLost = false;
  context._context = { label: "canvas context" };
  context._currentCommandEncoder = null;
  context._currentRenderPassEncoder = null;
  context._clearCallsThisFrame = 0;
  context._clearOverflowWarned = false;
  context._drawCallCount = 0;
  context._triangleCount = 0;
  context._webgpuPipelineCache = null;
  context._webgpuComputePipelineCache = null;
  context._asyncResources = null;
  context._featureFlags = new Set(["timestamp-query"]);
  context._deviceInvalidationBus = new WebGPUDeviceInvalidationBus(
    () => context._id,
  );
  return context;
}

/**
 * The clear a frame issues. Every channel is left unrequested so the call
 * returns immediately AFTER the per-frame counter ticks: the counter is then a
 * clean witness of "the guard admitted this call", with no GPU work implied.
 */
const emptyClearCommand = Object.freeze({});

/** Put a frame's worth of encoder state on the context. */
function openFrame(context) {
  context._currentCommandEncoder = { label: "frame encoder" };
  context._currentRenderPassEncoder = { label: "frame pass" };
}

/**
 * The device-loss sequence as the engine performs it: the lost handler
 * publishes liveness first, then recovery swaps in the successor before firing
 * the invalidation that every cache listens for.
 */
function publishLoss(device) {
  markDeviceLost(device);
}
function publishSuccessor(context, successor) {
  context._device = successor;
  context._deviceInvalidationBus.fire();
}

const LAZY_DEVICE_SLOTS = [
  ["renderBundleManager", "_renderBundleManager"],
  ["computeEngine", "_computeEngine"],
  ["timestampProfiler", "_timestampProfiler"],
  ["storageBufferPool", "_storageBufferPool"],
  ["indirectDrawManager", "_indirectDrawManager"],
  ["bufferMapper", "_bufferMapper"],
  ["webgpuPipelineCache", "_webgpuPipelineCache"],
  ["webgpuComputePipelineCache", "_webgpuComputePipelineCache"],
];

function readSlot(ContextClass, context, getterName) {
  return Object.getOwnPropertyDescriptor(
    ContextClass.prototype,
    getterName,
  ).get.call(context);
}

/**
 * Every device the subsystem holds at depth one, whatever the field is called.
 * Asking for the values rather than a known field name keeps this from passing
 * on a subsystem that renamed its handle and kept the stale one.
 */
function heldDevices(subsystem) {
  return Object.keys(subsystem)
    .filter((key) => devices.has(subsystem[key]))
    .map((key) => subsystem[key]);
}

// ───────────────────────────────────────────────────────────────────────────
// (a) the frames that arrive during recovery, and the successor device
// ───────────────────────────────────────────────────────────────────────────

test("a frame issued during the recovery window is declined, not thrown at", () => {
  const lost = makeDevice("recovery-window-dev0");
  const context = makeContext(WebGPUContext, lost);
  openFrame(context);
  publishLoss(lost);

  // The exact call the reported failure came out of.
  assert.doesNotThrow(() => context.clear(emptyClearCommand));
  // Declined, not merely survived: the counter is bumped only past the guard.
  assert.equal(
    context._clearCallsThisFrame,
    0,
    "a clear on a lost device must not enter the clear path",
  );

  // The rest of the frame's context entry points behave the same way, because
  // one throw from any of them ends the loop just as finally.
  let executed = 0;
  assert.doesNotThrow(() =>
    context.draw({ execute: () => (executed += 1) }, undefined),
  );
  assert.equal(executed, 0, "a draw on a lost device must not reach the pass");
  assert.equal(context._drawCallCount, 0);
  assert.doesNotThrow(() => context.beginFrame());
  assert.doesNotThrow(() => context.endFrame());
  assert.equal(
    context.copyTexture({}, {}),
    false,
    "a copy on a lost device reports failure rather than raising",
  );
});

test("the same frame on the successor device is admitted", () => {
  const lost = makeDevice("successor-dev0");
  const successor = makeDevice("successor-dev1");
  const context = makeContext(WebGPUContext, lost);
  publishLoss(lost);
  publishSuccessor(context, successor);

  openFrame(context);
  assert.doesNotThrow(() => context.clear(emptyClearCommand));
  assert.equal(
    context._clearCallsThisFrame,
    1,
    "a clear on the successor device must be admitted to the clear path",
  );

  let executed = 0;
  context.draw({ execute: () => (executed += 1), vertexCount: 3 }, undefined);
  assert.equal(executed, 1, "a draw on the successor must reach the pass");
  assert.equal(context._drawCallCount, 1);
});

test("liveness is per device, so the successor is never implicated", () => {
  const lost = makeDevice("liveness-dev0");
  const successor = makeDevice("liveness-dev1");
  assert.equal(isDeviceLost(lost), false);
  publishLoss(lost);
  assert.equal(isDeviceLost(lost), true);
  assert.equal(
    isDeviceLost(successor),
    false,
    "a replacement must not inherit its predecessor's verdict",
  );
});

// ───────────────────────────────────────────────────────────────────────────
// (b) every device-bound subsystem rebuilds onto the successor
// ───────────────────────────────────────────────────────────────────────────

test("every device-bound lazy subsystem reads null while lost and rebuilds on the successor", () => {
  const lost = makeDevice("slots-dev0");
  const successor = makeDevice("slots-dev1");
  const context = makeContext(WebGPUContext, lost);

  const before = new Map();
  for (const [getterName] of LAZY_DEVICE_SLOTS) {
    const subsystem = readSlot(WebGPUContext, context, getterName);
    assert.ok(subsystem, `${getterName} did not build on the first device`);
    assert.deepEqual(
      heldDevices(subsystem),
      [lost],
      `${getterName} must hold exactly the device it was built for`,
    );
    before.set(getterName, subsystem);
  }

  publishLoss(lost);
  for (const [getterName] of LAZY_DEVICE_SLOTS) {
    assert.equal(
      readSlot(WebGPUContext, context, getterName),
      null,
      `${getterName} must refuse to hand out a lost-device subsystem`,
    );
  }

  publishSuccessor(context, successor);
  // Every field is checked before ANY of them is read back: several of these
  // subsystems build one another (the compute engine resolves the compute
  // pipeline cache), so a rebuild interleaved with the check would hide a slot
  // that the invalidation never dropped.
  for (const [getterName, field] of LAZY_DEVICE_SLOTS) {
    assert.equal(
      context[field],
      null,
      `${getterName} must have been dropped by the invalidation`,
    );
  }

  for (const [getterName] of LAZY_DEVICE_SLOTS) {
    const rebuilt = readSlot(WebGPUContext, context, getterName);
    assert.ok(rebuilt, `${getterName} did not rebuild on the successor`);
    assert.notEqual(
      rebuilt,
      before.get(getterName),
      `${getterName} handed back the pre-loss instance`,
    );
    assert.deepEqual(
      heldDevices(rebuilt),
      [successor],
      `${getterName} rebuilt against the wrong device`,
    );
  }
});

test("the scene renderer's own resources drop and the recovery asks for the frame that rebuilds them", () => {
  const lost = makeDevice("ensure-dev0");
  const successor = makeDevice("ensure-dev1");
  const context = makeContext(WebGPUContext, lost);

  let renderRequests = 0;
  const scene = {
    taaEnabled: false,
    requestRender: () => (renderRequests += 1),
  };
  const host = {
    _deviceInvalidationUnsub: null,
    _sceneFramebuffer: null,
    _edgeFramebuffer: null,
    _translucentTileClassification: null,
    _oit: null,
    _globeDepth: null,
    _depthPlane: null,
    _postProcess: null,
    _debugDepthOverlay: null,
    _debugFrustumOverlay: null,
    _initialized: true,
    _hiZAllocated: true,
    _hiZAllocatedFor: { width: 8, height: 8, capacity: 4 },
    _sortKeysAllocatedFor: 12,
    _clusteredLightingDispatcher: { destroy: () => {} },
  };

  // The subscription is registered at the top of the resource pass. Everything
  // after it needs a real GPUDevice, which is not what this test is about.
  try {
    ensureResources(host, { scene, context, useHDR: false });
  } catch {
    /* the framebuffer work beyond the subscription needs a real device */
  }
  assert.ok(
    typeof host._deviceInvalidationUnsub === "function",
    "the resource pass must subscribe to device invalidation",
  );
  assert.equal(renderRequests, 0, "nothing has been recovered yet");

  publishLoss(lost);
  publishSuccessor(context, successor);

  assert.equal(
    host._initialized,
    false,
    "the renderer must re-run its resource pass on the successor",
  );
  assert.equal(
    host._clusteredLightingDispatcher,
    null,
    "the clustered dispatcher captured the dead device and must be rebuilt",
  );
  assert.equal(host._sceneFramebuffer, null);
  assert.equal(host._hiZAllocated, false);
  assert.equal(host._sortKeysAllocatedFor, 0);
  assert.equal(
    renderRequests,
    1,
    "recovery must ask for the frame that rebuilds all of the above",
  );
});

test("the scene renderer declines the frame itself while the device is lost", () => {
  const lost = makeDevice("frame-decline-dev0");
  const renderer = Object.create(WebGPUSceneRenderer.prototype);
  const sentinel = { label: "previous context" };
  renderer._lastContext = sentinel;
  renderer._lastHDR = null;
  renderer._lastMsaaSamples = 4;
  renderer._width = 0;
  renderer._height = 0;
  renderer._initialized = false;
  renderer._sceneFramebuffer = null;

  const context = makeContext(WebGPUContext, lost);
  context._msaaSamples = 4;
  const scene = { taaEnabled: true, msaaSamples: 4 };

  publishLoss(lost);
  assert.doesNotThrow(() =>
    renderer.prepareFrame({ scene, context, useHDR: false }),
  );
  assert.equal(
    renderer._lastMsaaSamples,
    4,
    "prepareFrame must not re-derive scene targets on a lost device",
  );
  assert.doesNotThrow(() =>
    renderer.executeCommands({
      scene,
      context,
      passState: {},
      picking: false,
    }),
  );
  assert.equal(
    renderer._lastContext,
    sentinel,
    "executeCommands must decline the frame before adopting the context",
  );

  // Positive control: a live device gets past both guards. Neither call can
  // finish without a real GPUDevice, so what is asserted is that each one
  // reached its first write - which the lost-device legs above did not.
  const live = makeDevice("frame-decline-dev1");
  context._device = live;
  const sceneTaaOff = { taaEnabled: false, msaaSamples: 1 };
  try {
    renderer.prepareFrame({ scene: sceneTaaOff, context, useHDR: false });
  } catch {
    /* the framebuffer update needs a real device */
  }
  assert.equal(
    renderer._lastMsaaSamples,
    1,
    "prepareFrame must run on a live device",
  );
  try {
    renderer.executeCommands({
      scene: sceneTaaOff,
      context,
      passState: {},
      picking: false,
    });
  } catch {
    /* the pass chain needs a real device */
  }
  assert.equal(
    renderer._lastContext,
    context,
    "executeCommands must run on a live device",
  );
});

test("a model drawn during the recovery window skips instead of raising", () => {
  const lost = makeDevice("model-dev0");
  publishLoss(lost);

  assert.equal(
    resolveModelCameraArenaOwner({
      context: { modelCameraArena: null, device: lost },
    }),
    null,
    "a model frame in the recovery window must degrade, not raise",
  );

  // The loud path is intact for a null arena on a device nothing has reported.
  const live = makeDevice("model-dev1");
  assert.throws(
    () =>
      resolveModelCameraArenaOwner({
        context: { modelCameraArena: null, device: live },
      }),
    /Model camera arena is unavailable for an active model draw/,
  );
});

// ───────────────────────────────────────────────────────────────────────────
// (c) the terminal path keeps its error
// ───────────────────────────────────────────────────────────────────────────

const TERMINAL_STATES = [
  ["destroyed", { _isDestroyed: true }, /Context has been destroyed\./],
  [
    "terminally lost",
    { _terminallyLost: true },
    /Context's WebGPU device is terminally lost\./,
  ],
  [
    "destroyed after a terminal loss",
    { _isDestroyed: true, _terminallyLost: true },
    /Context has been destroyed\./,
  ],
];

test("a terminal state still raises out of every frame entry point", () => {
  for (const [name, state, message] of TERMINAL_STATES) {
    const device = makeDevice(`terminal-${name}`);
    const context = makeContext(WebGPUContext, device);
    Object.assign(context, state);
    openFrame(context);

    assert.throws(() => context.clear(emptyClearCommand), message, name);
    assert.throws(() => context.beginFrame(), message, name);
    assert.throws(() => context.endFrame(), message, name);
    assert.throws(() => context.draw({ execute: () => {} }), message, name);
    assert.throws(() => context.copyTexture({}, {}), message, name);
    assert.equal(
      context._clearCallsThisFrame,
      0,
      `${name} must not have entered the clear path`,
    );
  }
});

test("a terminal verdict on a device that is also lost keeps the terminal error", () => {
  // Recovery that runs out of attempts publishes BOTH facts. The permanent one
  // has to win, or an abandoned context would look like one still recovering
  // and would silently render nothing for the rest of the session.
  const device = makeDevice("terminal-and-lost");
  const context = makeContext(WebGPUContext, device);
  context._terminallyLost = true;
  publishLoss(device);
  openFrame(context);
  assert.throws(
    () => context.clear(emptyClearCommand),
    /Context's WebGPU device is terminally lost\./,
  );
});

// ───────────────────────────────────────────────────────────────────────────
// (d) inertness mutants
// ───────────────────────────────────────────────────────────────────────────

test("MUTANT: with the recoverable/terminal narrowing inert, the recovery-window frame raises again", async () => {
  const MutatedContext = await importMutatedContext("narrowing-inert");
  const lost = makeDevice("mutant-narrowing-dev0");
  const context = makeContext(MutatedContext, lost);
  openFrame(context);
  publishLoss(lost);

  assert.throws(
    () => context.clear(emptyClearCommand),
    /Context's WebGPU device is terminally lost\./,
    "the mutant must reproduce the reported failure",
  );
  assert.throws(() => context.draw({ execute: () => {} }));
  assert.throws(() => context.endFrame());

  // The terminal path is unaffected by this mutation, so a spec that only
  // watched the terminal path would have called this build healthy.
  const terminal = makeContext(MutatedContext, makeDevice("mutant-terminal"));
  terminal._terminallyLost = true;
  assert.throws(
    () => terminal.clear(emptyClearCommand),
    /Context's WebGPU device is terminally lost\./,
  );
});

test("MUTANT: with the terminal thrower inert, the terminal path stops raising", async () => {
  const MutatedContext = await importMutatedContext("thrower-inert");
  const context = makeContext(
    MutatedContext,
    makeDevice("mutant-thrower-dev0"),
  );
  context._terminallyLost = true;
  openFrame(context);

  assert.doesNotThrow(
    () => context.clear(emptyClearCommand),
    "this mutant is expected to swallow the terminal error",
  );
  assert.equal(
    context._clearCallsThisFrame,
    0,
    "the mutant still declines the call; only the error is gone",
  );
});

test("MUTANT: with the model liveness arm inert, a model frame raises during recovery", async () => {
  const { resolveModelCameraArenaOwner: mutatedResolver } = await import(
    `${modelRendererUrl}?q65expose=1&q65mutant=model-liveness-inert`
  );
  const lost = makeDevice("mutant-model-dev0");
  publishLoss(lost);
  assert.throws(
    () =>
      mutatedResolver({ context: { modelCameraArena: null, device: lost } }),
    /Model camera arena is unavailable for an active model draw/,
    "the mutant must restore the loud throw the fix removed",
  );
});
