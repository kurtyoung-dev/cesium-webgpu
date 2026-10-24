/**
 * Opens one Sandcastle 2 gallery demo by id on a served tree, on one renderer,
 * and captures its scene canvas ELEMENT once the scene has drawn a declared
 * number of settled frames.
 * @purpose Capture piece for Sandcastle 2 demos on the probe runtime: given a served tree origin, a gallery demo id, a renderer and a settled-frame count, opens the demo through lib/sandcastle2-renderer-gate.mjs's guarded opener (lib/sandcastle2-origin-rewrite.mjs's rewrite and origin guard), proves the run frame built a viewer on the requested renderer, arms the WebGPU error gate, settles the frames with the clock optionally pinned, element-captures the scene canvas inside the run frame, and returns the PNG path with a {demoId, renderer, frames, origin, ionAccess} record - or NOT_RUN: ion, with no capture, for a demo that needs Cesium ion where ion is not reachable; a refusal raised after the gate is armed (a clock it could not pin, a settle short of its frames) carries the gate it read.
 * @status ACTIVE
 *
 * WHY A PIECE. A Sandcastle 2 demo runs in the app's run frame (the bucket
 * iframe), not in the top-level page: `lib/capture.mjs` navigates the top-level
 * page only, and the CesiumViewer stages (`lib/landing-cell-stage.mjs`) read
 * `window.viewer`, which a demo keeps in a local. The one probe that captured a
 * demo frame (`probe-stub-texture-uploads.mjs`, the Video demo) did the opening,
 * the frame reads and the capture inline, for that demo only. This piece is
 * that sequence once, for any demo id, so a cell that needs a gallery demo's
 * picture (the water landing's cell 1f) declares a rig and calls this.
 *
 * WHAT IT REUSES, AND ADDS. Opening is `openSandcastle2Url` (the response
 * rewrite of the build's baked origins, the persistent origin guard on the top
 * page and the run frame); the backend check is `readRendererStateInPage` and
 * `evaluateRendererGate`; the "it rendered" check is `evaluateFrameGate`; the
 * frame loop is the runtime's `driveSceneFrames` (installed in the run frame);
 * the capture is the runtime's `captureElement` on the run frame, which asks
 * the error gate whether the device is alive before it writes. What the kit
 * lacked, and this adds: waiting for the demo's viewer to exist, arming the
 * error gate on a device the demo created (its viewer is a local, so the gate's
 * viewer walk cannot reach it), the Cesium ion reachability question, the clock
 * pin, and a settle that counts only frames drawn with the globe's tiles
 * loaded.
 *
 * CESIUM ION. A demo that streams ion content (World Terrain, an ion imagery
 * asset) draws a different picture without it - an ellipsoid with no water
 * mask, a blank base layer - and that picture is not the one a cell asked for.
 * So a request that says `requiresIon: true` measures, in the run frame, that
 * an access token is set AND that the globe's terrain provider resolved to
 * something other than the ellipsoid within the ion budget. When either is
 * false, or the caller declared ion unavailable (`ionAvailable: false`, which
 * does not open the page), the answer is {@link NOT_RUN_ION} with no PNG. It is
 * never a pass, and never a capture of the wrong picture.
 *
 * SETTLED FRAMES. `frames` counts scene frames drawn while
 * `globe.tilesLoaded` is true (frames drawn while tiles stream do not count),
 * driven by the runtime's frame driver under a frame cap and a wall-clock
 * deadline. A settle that ends any other way refuses (`demo-not-settled`); a
 * picture taken mid-refinement is a different picture.
 *
 * WHAT IT DOES NOT DO. It opens no browser and no context (the probe's runtime
 * owns both; `prepareDemoCaptureContext` adds this piece's init scripts to a
 * context the probe made), decides no band, and diffs nothing.
 *
 * @module Tools/visual-regression/lib/sandcastle2-demo-capture
 */

import path from "node:path";

import {
  collectGateErrors,
  errorGateInit,
} from "../../lib/webgpu-error-gate.mjs";
import {
  ProbeRefusal,
  SCENE_FRAME_DRIVER_GLOBAL,
  captureElement,
  installSceneFrameDriver,
} from "./probe-runtime.mjs";
import {
  EVALUATE_TIMEOUT,
  SWEEPABLE_RENDERERS,
  evaluateFrameGate,
  evaluateRendererGate,
  evaluateWithDeadline,
  openSandcastle2Url,
  readRendererStateInPage,
} from "./sandcastle2-renderer-gate.mjs";

/** The answer for a demo that needs Cesium ion where ion is not reachable. */
export const NOT_RUN_ION = "NOT_RUN: ion";

/** The two outcomes a capture request has. */
export const DEMO_CAPTURE_STATUS = Object.freeze({
  CAPTURED: "CAPTURED",
  NOT_RUN: "NOT_RUN",
});

/** The scene canvas inside the run frame. */
export const DEMO_CANVAS_SELECTOR = ".cesium-widget canvas";

/** Budgets, in milliseconds, a request may override. */
export const DEMO_CAPTURE_DEFAULT_BUDGETS = Object.freeze({
  navigationMs: 120_000,
  viewerMs: 120_000,
  ionMs: 60_000,
  readMs: 30_000,
  settleMs: 240_000,
});

const DEMO_ID_RE = /^[a-z0-9][a-z0-9-]*$/;
const ISO_INSTANT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

/**
 * Validate and complete one capture request. Pure.
 *
 * @param {object} input
 * @param {string} input.origin The served tree's origin (`http://host:port`).
 * @param {string} [input.bucketOrigin] The run frame's origin; defaults to the
 *   origin's port + 1, the server's own convention (`--sandcastle-port`).
 * @param {string} input.demoId The gallery id (the demo directory's name).
 * @param {string} input.renderer `webgl` or `webgpu`.
 * @param {number} input.frames Settled frames before the capture.
 * @param {boolean} [input.requiresIon] The demo streams Cesium ion content.
 * @param {boolean|null} [input.ionAvailable] `false` declares ion unreachable
 *   (the request answers NOT_RUN without opening the page); `null` measures.
 * @param {string|null} [input.clock] An ISO-8601 UTC instant to pin the
 *   demo's clock to, or null for the demo's own clock.
 * @param {string} [input.name] The capture's name; defaults to
 *   `<demoId>-<renderer>`.
 * @param {number} [input.settleMaxFrames] The settle's frame cap.
 * @param {object} [input.budgets] Overrides of {@link DEMO_CAPTURE_DEFAULT_BUDGETS}.
 * @returns {object} The completed request.
 * @throws {TypeError} For a field that cannot be used.
 */
export function demoCaptureRequest(input) {
  const fail = (message) => {
    throw new TypeError(`sandcastle2 demo capture: ${message}`);
  };
  let origin;
  try {
    origin = new URL(String(input?.origin));
  } catch {
    fail(`origin must be an absolute URL, got ${String(input?.origin)}`);
  }
  if (origin.protocol !== "http:" || origin.port === "") {
    fail(`origin must be http with an explicit port, got ${origin.href}`);
  }
  let bucket;
  if (input.bucketOrigin !== undefined && input.bucketOrigin !== null) {
    try {
      bucket = new URL(String(input.bucketOrigin));
    } catch {
      fail(`bucketOrigin must be an absolute URL, got ${input.bucketOrigin}`);
    }
  } else {
    bucket = new URL(
      `${origin.protocol}//${origin.hostname}:${Number(origin.port) + 1}`,
    );
  }
  if (typeof input.demoId !== "string" || !DEMO_ID_RE.test(input.demoId)) {
    fail(`demoId must be a gallery id, got ${JSON.stringify(input.demoId)}`);
  }
  if (!SWEEPABLE_RENDERERS.includes(input.renderer)) {
    fail(
      `renderer must be one of ${SWEEPABLE_RENDERERS.join(", ")}, got ${JSON.stringify(input.renderer)}`,
    );
  }
  if (!Number.isInteger(input.frames) || input.frames < 1) {
    fail(`frames must be a positive integer, got ${String(input.frames)}`);
  }
  const clock = input.clock ?? null;
  if (clock !== null && !ISO_INSTANT_RE.test(String(clock))) {
    fail(`clock must be null or an ISO-8601 UTC instant, got ${clock}`);
  }
  const ionAvailable = input.ionAvailable ?? null;
  if (ionAvailable !== null && typeof ionAvailable !== "boolean") {
    fail(`ionAvailable must be a boolean or null`);
  }
  const settleMaxFrames = input.settleMaxFrames ?? input.frames * 50;
  if (!Number.isInteger(settleMaxFrames) || settleMaxFrames < input.frames) {
    fail(`settleMaxFrames must be an integer of at least frames`);
  }
  const budgets = { ...DEMO_CAPTURE_DEFAULT_BUDGETS, ...(input.budgets ?? {}) };
  for (const [key, value] of Object.entries(budgets)) {
    if (!Number.isInteger(value) || value < 1) {
      fail(`budgets.${key} must be a positive integer`);
    }
  }
  return {
    origin: origin.origin,
    bucketOrigin: bucket.origin,
    demoId: input.demoId,
    renderer: input.renderer,
    frames: input.frames,
    requiresIon: input.requiresIon === true,
    ionAvailable,
    clock,
    name: input.name ?? `${input.demoId}-${input.renderer}`,
    settleMaxFrames,
    budgets,
  };
}

/**
 * Whether ion was reachable for a request, and what that makes the request.
 * Pure.
 *
 * @param {{requiresIon: boolean, ionAvailable: boolean|null}} request
 * @param {{tokenPresent?: boolean, terrainResolved?: boolean,
 *   terrainProvider?: string|null, hasWaterMask?: boolean|null,
 *   waitedMs?: number}|null} observed What the run frame reported, or null
 *   when the page was not asked.
 * @returns {{ionAccess: object, notRun: string|null}}
 */
export function decideIonAccess(request, observed) {
  if (request.requiresIon !== true) {
    return {
      ionAccess: { required: false, ...(observed ?? {}) },
      notRun: null,
    };
  }
  if (request.ionAvailable === false) {
    return {
      ionAccess: {
        required: true,
        declaredUnavailable: true,
        tokenPresent: null,
        terrainResolved: null,
      },
      notRun: NOT_RUN_ION,
    };
  }
  const ionAccess = {
    required: true,
    declaredUnavailable: false,
    tokenPresent: observed?.tokenPresent === true,
    terrainResolved: observed?.terrainResolved === true,
    terrainProvider: observed?.terrainProvider ?? null,
    hasWaterMask: observed?.hasWaterMask ?? null,
    waitedMs: observed?.waitedMs ?? null,
  };
  return {
    ionAccess,
    notRun:
      ionAccess.tokenPresent && ionAccess.terrainResolved ? null : NOT_RUN_ION,
  };
}

/**
 * INIT SCRIPT, every frame: arm each WebGPU device with the error gate the
 * moment it is created, so a fault raised while the demo builds its viewer is
 * seen. Needs `errorGateInit` to have run first in the same frame.
 */
function demoArmDevicesOnRequest() {
  const adapterPrototype = globalThis.GPUAdapter?.prototype;
  if (!adapterPrototype || adapterPrototype.__demoCaptureArmed) {
    return;
  }
  adapterPrototype.__demoCaptureArmed = true;
  const requestDevice = adapterPrototype.requestDevice;
  adapterPrototype.requestDevice = async function (...args) {
    const device = await requestDevice.apply(this, args);
    globalThis.__armWebGPUDevice?.(device, "webgpu");
    return device;
  };
}

/**
 * Add this piece's init scripts to a browser context the probe created, before
 * its first page: the WebGPU error gate and the arm-on-request hook.
 *
 * @param {{addInitScript: Function}} context A Playwright browser context.
 * @returns {Promise<void>}
 */
export async function prepareDemoCaptureContext(context) {
  await context.addInitScript(errorGateInit);
  await context.addInitScript(demoArmDevicesOnRequest);
}

/** RUN FRAME. Whether the demo has published a viewer with a scene. */
function frameHasDemoViewer() {
  const instances = globalThis.__sandcastleInstances;
  return (
    Array.isArray(instances) &&
    instances.length > 0 &&
    !!instances[0] &&
    !!instances[0].scene
  );
}

/** RUN FRAME. Arm the error gate on every published instance's device. */
function frameArmDemoDevices() {
  const arm = globalThis.__armWebGPUDevice;
  let found = 0;
  let armed = 0;
  for (const instance of globalThis.__sandcastleInstances ?? []) {
    const context = instance && instance.scene && instance.scene.context;
    const device = context && context._device;
    if (device) {
      found += 1;
      if (typeof arm === "function" && arm(device, "webgpu")) {
        armed += 1;
      }
    }
  }
  return { found, armed, gateInstalled: typeof arm === "function" };
}

/**
 * RUN FRAME. Wait, up to `timeoutMs`, for the first instance's terrain
 * provider to be something other than the ellipsoid, and report whether an
 * ion access token is set.
 */
async function frameAwaitIonContent({ timeoutMs }) {
  const C = globalThis.Cesium;
  const started = performance.now();
  const read = () => {
    const instance = (globalThis.__sandcastleInstances ?? [])[0];
    const provider =
      instance && instance.scene && instance.scene.globe
        ? instance.scene.globe.terrainProvider
        : undefined;
    const ellipsoid =
      !provider ||
      (C && C.EllipsoidTerrainProvider
        ? provider instanceof C.EllipsoidTerrainProvider
        : true);
    return {
      tokenPresent:
        !!C &&
        !!C.Ion &&
        typeof C.Ion.defaultAccessToken === "string" &&
        C.Ion.defaultAccessToken.length > 0,
      terrainResolved: !ellipsoid,
      terrainProvider:
        provider && provider.constructor ? provider.constructor.name : null,
      hasWaterMask: provider ? provider.hasWaterMask === true : null,
    };
  };
  let state = read();
  while (!state.terrainResolved && performance.now() - started < timeoutMs) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    state = read();
  }
  return { ...state, waitedMs: Math.round(performance.now() - started) };
}

/** RUN FRAME. Freeze the first instance's clock at `iso`. */
function framePinDemoClock({ iso }) {
  const C = globalThis.Cesium;
  const instance = (globalThis.__sandcastleInstances ?? [])[0];
  const clock = instance && instance.clock;
  if (!C || !clock) {
    return { applied: false, reason: "the demo's viewer has no clock" };
  }
  clock.shouldAnimate = false;
  clock.currentTime = C.JulianDate.fromIso8601(iso);
  return {
    applied: clock.shouldAnimate === false,
    observed: C.JulianDate.toIso8601(clock.currentTime, 0),
  };
}

/**
 * RUN FRAME. Drive the first instance's scene with the runtime's frame driver
 * (installed under `driverGlobal`) until `frames` frames have been drawn with
 * the globe's tiles loaded.
 */
async function frameSettleDemo({
  frames,
  maxFrames,
  deadlineMs,
  driverGlobal,
}) {
  const drive = globalThis[driverGlobal];
  const instance = (globalThis.__sandcastleInstances ?? [])[0];
  const scene = instance && instance.scene;
  if (typeof drive !== "function" || !scene) {
    return {
      outcome: "no-driver",
      frames: 0,
      settledFrames: 0,
      elapsedMs: 0,
    };
  }
  let settledFrames = 0;
  const run = await drive(scene, {
    onFrame: () => {
      const tilesLoaded = !scene.globe || scene.globe.tilesLoaded === true;
      if (tilesLoaded) {
        settledFrames += 1;
      }
      return settledFrames >= frames;
    },
    maxFrames,
    deadlineMs,
  });
  const frameNumber = scene.frameState && scene.frameState.frameNumber;
  return {
    ...run,
    settledFrames,
    tilesLoaded: !scene.globe || scene.globe.tilesLoaded === true,
    frameNumber: typeof frameNumber === "number" ? frameNumber : null,
  };
}

/**
 * Read the run frame's error gate before a refusal, so the refusal carries
 * what the gate saw. A read that fails is recorded, never thrown: the refusal
 * is the answer either way. NODE SIDE.
 *
 * @param {Function} readGate
 * @param {object} frame
 * @returns {Promise<{gate: object|null, gateReadError?: string}>}
 */
async function readGateBeforeRefusal(readGate, frame) {
  try {
    return { gate: (await readGate(frame)) ?? null };
  } catch (error) {
    return { gate: null, gateReadError: String(error?.message ?? error) };
  }
}

/**
 * Open a demo, settle it and capture its scene canvas element. NODE SIDE.
 *
 * @param {object} args
 * @param {object} args.page A Playwright page whose context had
 *   {@link prepareDemoCaptureContext} applied.
 * @param {object} args.request The input of {@link demoCaptureRequest}.
 * @param {string} args.outputDirectory Where the PNG is written.
 * @param {object[]} [args.captures] The runtime's capture sink.
 * @param {object} [args.dependencies] Seams for a spec: `open`
 *   (`openSandcastle2Url`), `capture` (`captureElement`), `installDriver`
 *   (`installSceneFrameDriver`), `readGate` (`collectGateErrors`).
 * @returns {Promise<{status: string, notRun: string|null, png: string|null,
 *   record: {demoId: string, renderer: string, frames: number, origin: string,
 *   ionAccess: object|null}, capture: object|null, rendererGate: object|null,
 *   frameGate: object|null, settle: object|null, clock: object|null,
 *   armed: object|null, gate: object|null, urls: object|null}>}
 * @throws {ProbeRefusal} `demo-no-viewer`, `demo-frame-unreadable`,
 *   `demo-renderer-gate`, `demo-clock-not-pinned` or `demo-not-settled`; an
 *   origin breach is the origin guard's own refusal. The last two read the
 *   error gate first and carry it in `details.gate` (`details.gateReadError`
 *   when the read failed), so a device lost mid-settle reaches the caller.
 */
export async function captureSandcastle2Demo({
  page,
  request,
  outputDirectory,
  captures,
  dependencies = {},
}) {
  const {
    open = openSandcastle2Url,
    capture = captureElement,
    installDriver = installSceneFrameDriver,
    readGate = collectGateErrors,
  } = dependencies;
  const req = demoCaptureRequest(request);
  const label = `${req.demoId} on ${req.renderer}`;
  const result = {
    status: DEMO_CAPTURE_STATUS.NOT_RUN,
    notRun: null,
    png: null,
    record: {
      demoId: req.demoId,
      renderer: req.renderer,
      frames: req.frames,
      origin: req.origin,
      ionAccess: null,
    },
    capture: null,
    rendererGate: null,
    frameGate: null,
    settle: null,
    clock: null,
    armed: null,
    gate: null,
    urls: null,
  };

  if (req.requiresIon && req.ionAvailable === false) {
    const decision = decideIonAccess(req, null);
    result.record.ionAccess = decision.ionAccess;
    result.notRun = decision.notRun;
    return result;
  }

  const opened = await open(
    page,
    {
      base: req.origin,
      bucketBase: req.bucketOrigin,
      id: req.demoId,
      renderer: req.renderer,
      standalone: true,
    },
    { timeoutMs: req.budgets.navigationMs },
  );
  const frame = opened.bucketFrame;
  result.urls = {
    page: opened.url,
    finalUrl: opened.finalUrl,
    bucketFinalUrl: opened.bucketFinalUrl,
    bucketOrigin: req.bucketOrigin,
  };

  try {
    await frame.waitForFunction(frameHasDemoViewer, null, {
      timeout: req.budgets.viewerMs,
    });
  } catch (error) {
    opened.assertNoOriginBreach();
    throw new ProbeRefusal(
      "demo-no-viewer",
      `${label}: the demo published no viewer within ${req.budgets.viewerMs} ms`,
      { demoId: req.demoId, error: String(error?.message ?? error) },
    );
  }

  const state = await evaluateWithDeadline(
    frame,
    readRendererStateInPage,
    req.budgets.readMs,
  );
  if (state === EVALUATE_TIMEOUT) {
    throw new ProbeRefusal(
      "demo-frame-unreadable",
      `${label}: the run frame did not answer within ${req.budgets.readMs} ms`,
      { demoId: req.demoId },
    );
  }
  result.rendererGate = evaluateRendererGate({
    contexts: state.contexts,
    requested: req.renderer,
  });
  if (!result.rendererGate.ok) {
    throw new ProbeRefusal(
      "demo-renderer-gate",
      `${label}: ${result.rendererGate.reason}`,
      { demoId: req.demoId, rendererGate: result.rendererGate },
    );
  }
  result.armed = await frame.evaluate(frameArmDemoDevices);

  const observed = req.requiresIon
    ? await frame.evaluate(frameAwaitIonContent, {
        timeoutMs: req.budgets.ionMs,
      })
    : null;
  const decision = decideIonAccess(req, observed);
  result.record.ionAccess = decision.ionAccess;
  if (decision.notRun !== null) {
    result.notRun = decision.notRun;
    opened.assertNoOriginBreach();
    return result;
  }

  if (req.clock !== null) {
    result.clock = await frame.evaluate(framePinDemoClock, { iso: req.clock });
    if (result.clock?.applied !== true) {
      const read = await readGateBeforeRefusal(readGate, frame);
      result.gate = read.gate;
      throw new ProbeRefusal(
        "demo-clock-not-pinned",
        `${label}: the clock could not be pinned to ${req.clock}`,
        { demoId: req.demoId, clock: result.clock, ...read },
      );
    }
  }

  await installDriver(frame);
  result.settle = await frame.evaluate(frameSettleDemo, {
    frames: req.frames,
    maxFrames: req.settleMaxFrames,
    deadlineMs: req.budgets.settleMs,
    driverGlobal: SCENE_FRAME_DRIVER_GLOBAL,
  });
  if (
    result.settle?.outcome !== "done" ||
    result.settle.settledFrames < req.frames
  ) {
    // A device lost mid-settle is the likeliest reason a settle stops short:
    // the gate is read first so the refusal carries the fault.
    const read = await readGateBeforeRefusal(readGate, frame);
    result.gate = read.gate;
    throw new ProbeRefusal(
      "demo-not-settled",
      `${label}: ${result.settle?.settledFrames ?? 0} of ${req.frames} settled frames (${result.settle?.outcome ?? "no answer"})`,
      { demoId: req.demoId, settle: result.settle, ...read },
    );
  }
  result.frameGate = evaluateFrameGate(
    result.settle.frameNumber === null ? [] : [result.settle.frameNumber],
    { minimum: req.frames },
  );

  const shot = await capture({
    page: frame,
    selector: DEMO_CANVAS_SELECTOR,
    name: req.name,
    outputDirectory,
    captures,
  });
  result.gate = await readGate(frame);
  opened.assertNoOriginBreach();
  result.status = DEMO_CAPTURE_STATUS.CAPTURED;
  result.png = path.resolve(shot.path);
  result.capture = {
    name: shot.name,
    path: path.resolve(shot.path),
    sha256: shot.sha256,
    byteLength: shot.byteLength,
    liveness: shot.liveness,
  };
  return result;
}
