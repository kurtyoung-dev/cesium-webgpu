/**
 * The teardown and device-loss steps of an E-T cell: provoke the scene with
 * the actions that rebuild GPU resources, then tear the viewer down or force
 * the device lost, reading the WebGPU error gate and the runtime's liveness
 * decision at every step.
 * @purpose Step piece for the landing program's E-T cell: runs a rig's provoking steps (resize ladder via lib/globe-resize-steps.mjs, sky-box swaps via lib/skybox-swap-steps.mjs, a water or cloud tier switch), reads the error gate and the runtime's capture-liveness decision after each, then either destroys the viewer (teardown) or forces the device lost (WebGPU device.destroy, WebGL WEBGL_lose_context) and renders on, and returns {mode, steps, terminal, deviceLost, errors, owners, consoleErrors} - the named owners' live census rows before and after, and the console errors split into the engine's device-lost sentinel and everything else; terminalShape/sameTerminal are the one reader of the terminal record.
 * @status ACTIVE
 *
 * WHAT "FORCED" MEANS, AND WHAT IT CANNOT MEAN. Script cannot make a GPU
 * reset. The only device loss a page can cause is `GPUDevice.destroy()`, whose
 * `device.lost` settles with reason `destroyed`; on WebGL, the
 * `WEBGL_lose_context` extension's `loseContext()`, which raises a real
 * `webglcontextlost`. Both are the engine's EXTERNAL-loss paths: for a WebGPU
 * device destroyed outside `WebGPUContext.destroy()` the engine prints
 * `[WebGPU] Device lost (reason: destroyed): ...` (`console.error`, the
 * device-lost sentinel), marks the context terminally lost and finalises it
 * (`WebGPUDeviceLossRecovery.setupHandler`). So the forced leg checks that a
 * loss with the owners alive is handled the way base handles it, and that
 * nothing else errors; it does not exercise recovery after a driver reset,
 * which no probe can provoke.
 *
 * THE GATE KEEPS ITS MEANING. The WebGPU error gate ignores a loss whose
 * reason is `destroyed` (`Tools/lib/webgpu-error-gate.mjs`), so after a forced
 * loss `deviceLost` still reports only a loss this module did NOT cause. That is
 * the reading every step records: an unexpected loss during the provoking steps
 * stops them, and the runtime's own `decideCaptureLiveness` names its state
 * (`live`, `lost`, `unobserved`, `teardown`) in the same words a capture uses.
 *
 * OWNERS. A wave names the GPU-owning classes it adds by the labels their
 * textures and buffers carry (`ownerLabels`; for the water landing, e.g.
 * `Global BathymetryTensorMap LUT`). The census rows for those labels are read
 * before and after the terminal action; after a teardown a row whose `live`
 * count is still above 0 is an owner that neither reached `destroy()` nor was
 * released with its device (the census counts `GPUDevice.destroy()`, and each
 * row carries `destroyed` and `freedByDevice` apart). A label
 * never seen reads `seen: false`, so an owner that was never created is not
 * mistaken for one cleanly destroyed.
 *
 * THE TERMINAL RECORD (round 4, F1; the contract lives here, once). The
 * record's `terminal` field has one shape per mode, and its fields do NOT
 * mean the same thing across modes:
 *   teardown     {action: "viewer.destroy", destroyed: boolean|null,
 *                 threw: string|null}. `threw` is the MESSAGE
 *                 `viewer.destroy()` threw (a string), or null when it
 *                 returned; it is never a count.
 *   forced-loss  {action: string|null, loss: {renderer, method, observed,
 *                 reason?}, rendered: {framesAttempted: number, throws: number,
 *                 firstThrows: string[], terminallyLost: boolean|null}}.
 *                 `rendered.throws` is the COUNT of renders after the loss
 *                 that threw; `firstThrows` holds up to five messages.
 *   skipped      {action: null, skipped: string} after an unexpected loss
 *                 during the provoking steps.
 * A reader never reads these fields by name: {@link terminalShape} folds every
 * mode into one comparable shape (`threw` a boolean with its `message`), and
 * {@link sameTerminal} compares two shapes. Reading `rendered.throws` on a
 * teardown record is how every teardown comparison reported `threw: false`
 * while the page carried "Failed to execute removeChild" (Calenhad N2).
 *
 * @module Tools/visual-regression/lib/device-loss-steps
 */

import { collectGateErrors } from "../../lib/webgpu-error-gate.mjs";
import { liveRowsForLabels } from "./gpu-device-census.mjs";
import { runGlobeResizeSteps } from "./globe-resize-steps.mjs";
import { decideCaptureLiveness } from "./probe-runtime.mjs";
import { runSkyBoxSwapSteps } from "./skybox-swap-steps.mjs";

/** The terminal actions this module performs. */
export const DEVICE_LOSS_MODES = Object.freeze(["teardown", "forced-loss"]);

/**
 * The engine's device-lost sentinel line
 * (`WebGPUDeviceLossRecovery.ts`, `console.error`).
 */
export const DEVICE_LOSS_SENTINEL_RE = /\[WebGPU\] Device lost \(reason: /;

/** The tier targets a `tierSwitch` dial may name. */
export const TIER_SWITCH_TARGETS = Object.freeze([
  "waterQualityPreset",
  "cloudVolumetricQuality",
]);

/**
 * PAGE SIDE. Move one tier dial and read it back.
 *
 * @param {{dial: string, value: string}} args
 * @returns {{ok: boolean, observed?: unknown, reason?: string}}
 */
export function pageSwitchTier({ dial, value }) {
  const scene = /** @type {any} */ (globalThis).viewer.scene;
  let target;
  let property;
  if (dial === "waterQualityPreset") {
    target = scene.globe && scene.globe.water;
    property = "qualityPreset";
  } else if (dial === "cloudVolumetricQuality") {
    const collection = scene.globe && scene.globe.defaultCloudCollection;
    target = collection && collection.volumetric;
    property = "cloudVolumetricQuality";
  } else {
    return { ok: false, reason: `unknown tier dial ${dial}` };
  }
  if (!target || !(property in target)) {
    return { ok: false, reason: `${dial}: ${property} is not a property here` };
  }
  target[property] = value;
  const observed = target[property];
  return {
    ok: String(observed).toUpperCase() === String(value).toUpperCase(),
    observed,
  };
}

/**
 * The comparable shape of a {@link runDeviceLossSteps} `terminal` record, any
 * mode (see THE TERMINAL RECORD in the module header). Pure.
 *
 * @param {object|null|undefined} terminal
 * @returns {{action: string|null, threw: boolean, message: string|null,
 *   terminallyLost: boolean|null, lossObserved: boolean,
 *   destroyed: boolean|null, skipped: string|null}} `threw` is true when
 *   `viewer.destroy()` threw (teardown) or any render after the loss threw
 *   (forced loss); `message` is the teardown's message or the first render
 *   message, null when nothing threw.
 */
export function terminalShape(terminal) {
  const rendered = terminal?.rendered ?? null;
  let threw = false;
  let message = null;
  if (typeof terminal?.threw === "string") {
    threw = true;
    message = terminal.threw;
  } else if (rendered && (rendered.throws ?? 0) > 0) {
    threw = true;
    message = rendered.firstThrows?.[0] ?? null;
  }
  return {
    action: terminal?.action ?? null,
    threw,
    message,
    terminallyLost: rendered?.terminallyLost ?? null,
    lossObserved: terminal?.loss?.observed != null,
    destroyed: terminal?.destroyed ?? null,
    skipped: terminal?.skipped ?? null,
  };
}

/**
 * Whether two {@link terminalShape} results end the same way: every field but
 * `message`, whose text may carry per-run detail. Pure.
 *
 * @param {object} a
 * @param {object} b
 * @returns {boolean}
 */
export function sameTerminal(a, b) {
  // JSON drops an undefined field, so the message takes no part.
  const key = (shape) => JSON.stringify({ ...shape, message: undefined });
  return key(a ?? terminalShape(null)) === key(b ?? terminalShape(null));
}

/**
 * PAGE SIDE. Destroy the viewer.
 *
 * @returns {{destroyed: boolean|null, threw: string|null}}
 */
export function pageDestroyViewer() {
  const viewer = /** @type {any} */ (globalThis).viewer;
  let threw = null;
  try {
    viewer.destroy();
  } catch (error) {
    threw = String(error && error.message ? error.message : error);
  }
  return {
    destroyed:
      typeof viewer.isDestroyed === "function" ? viewer.isDestroyed() : null,
    threw,
  };
}

/**
 * PAGE SIDE. Force the device lost: `device.destroy()` on WebGPU,
 * `WEBGL_lose_context.loseContext()` on WebGL, then wait (bounded) for the
 * loss to be reported.
 *
 * @param {{timeoutMs: number}} args
 * @returns {Promise<{renderer: string, method: string|null,
 *   observed: object|null, reason?: string}>} `observed` is the lost info
 *   (WebGPU) or the event type (WebGL); null when nothing was reported in time.
 */
export async function pageForceDeviceLoss({ timeoutMs }) {
  const scene = /** @type {any} */ (globalThis).viewer.scene;
  const context = scene.context;
  const device = context && context._device;
  const timeout = new Promise((resolve) =>
    setTimeout(() => resolve(null), timeoutMs),
  );
  if (device) {
    const lost = device.lost.then((info) => ({
      reason: info && info.reason,
      message: info && info.message,
    }));
    device.destroy();
    return {
      renderer: "webgpu",
      method: "GPUDevice.destroy",
      observed: await Promise.race([lost, timeout]),
    };
  }
  const gl = context && context._gl;
  const extension = gl && gl.getExtension("WEBGL_lose_context");
  if (!extension) {
    return {
      renderer: gl ? "webgl" : "unknown",
      method: null,
      observed: null,
      reason: "no WebGPU device and no WEBGL_lose_context extension",
    };
  }
  const canvas = scene.canvas;
  const lost = new Promise((resolve) =>
    canvas.addEventListener(
      "webglcontextlost",
      (event) => resolve({ type: event.type }),
      { once: true },
    ),
  );
  extension.loseContext();
  return {
    renderer: "webgl",
    method: "WEBGL_lose_context.loseContext",
    observed: await Promise.race([lost, timeout]),
  };
}

/**
 * PAGE SIDE. Keep rendering after the loss, the way the viewer's loop would,
 * and record what each render did.
 *
 * @param {{frames: number}} args
 * @returns {Promise<{framesAttempted: number, throws: number,
 *   firstThrows: string[], terminallyLost: boolean|null}>}
 */
export async function pageRenderAfterLoss({ frames }) {
  const viewer = /** @type {any} */ (globalThis).viewer;
  const scene = viewer.scene;
  let throws = 0;
  const firstThrows = [];
  for (let i = 0; i < frames; i++) {
    try {
      scene.render(viewer.clock.currentTime);
    } catch (error) {
      throws++;
      if (firstThrows.length < 5) {
        firstThrows.push(
          String(error && error.message ? error.message : error).slice(0, 300),
        );
      }
    }
    await new Promise((resolve) => requestAnimationFrame(resolve));
  }
  const context = scene.context;
  return {
    framesAttempted: frames,
    throws,
    firstThrows,
    terminallyLost:
      context && typeof context._isTerminallyLost === "boolean"
        ? context._isTerminallyLost
        : null,
  };
}

/** The frame number the page's viewer last drew, for a liveness decision. */
function pageReadFrameNumber() {
  const viewer = /** @type {any} */ (globalThis).viewer;
  const frameNumber =
    viewer && viewer.scene && viewer.scene.frameState
      ? viewer.scene.frameState.frameNumber
      : null;
  return typeof frameNumber === "number" ? frameNumber : null;
}

/**
 * Read the gate and decide liveness as a capture would. Pure apart from the
 * page reads.
 */
async function readLiveness(page) {
  const gate = await collectGateErrors(page);
  // A torn-down page may not answer; that is an unread frame, not an error.
  const frameNumber = await page
    .evaluate(pageReadFrameNumber)
    .catch(() => null);
  const decision = decideCaptureLiveness({
    gateArmed: gate.armedDevices > 0,
    deviceLost: gate.deviceLost,
    frameNumber,
  });
  return { gate, frameNumber, state: decision.state };
}

/**
 * Split console lines into the device-lost sentinel and the rest. Pure.
 *
 * @param {Array<{type: string, text: string}>} lines
 * @returns {{errors: number, sentinel: number, otherCount: number,
 *   other: string[], pageErrorCount: number, pageErrors: string[]}}
 *   `errors`, `sentinel`, `otherCount` (the non-sentinel error lines) and
 *   `pageErrorCount` count every line; `other` and `pageErrors` are samples
 *   of at most five each, so a reader's count is never their length.
 */
export function classifyConsoleErrors(lines) {
  let errors = 0;
  let sentinel = 0;
  let otherCount = 0;
  let pageErrorCount = 0;
  const other = [];
  const pageErrors = [];
  for (const line of lines ?? []) {
    if (line?.type === "pageerror") {
      pageErrorCount++;
      if (pageErrors.length < 5) {
        pageErrors.push(String(line.text).slice(0, 300));
      }
      continue;
    }
    if (line?.type !== "error") {
      continue;
    }
    errors++;
    if (DEVICE_LOSS_SENTINEL_RE.test(String(line.text))) {
      sentinel++;
    } else {
      otherCount++;
      if (other.length < 5) {
        other.push(String(line.text).slice(0, 300));
      }
    }
  }
  return { errors, sentinel, otherCount, other, pageErrorCount, pageErrors };
}

/**
 * Run an E-T cell's steps on a staged, settled page.
 *
 * @param {object} args
 * @param {object} args.page The Playwright page (error gate installed before
 *   load and armed; the GPU device census installed for owner rows).
 * @param {object} args.rig The rig; its `resizeLadder`, `swaps` and
 *   `tierSwitch` dials are the provoking steps, in that order.
 * @param {(frames: number) => Promise<unknown>} args.settle Renders frames.
 * @param {"teardown"|"forced-loss"} args.mode The terminal action.
 * @param {(page: object) => Promise<object>} [args.readCensus] Usually
 *   `readGpuDeviceCensus`; without it the owner rows are empty.
 * @param {string[]} [args.ownerLabels] The owners' resource labels.
 * @param {() => Array<{type: string, text: string}>} [args.readPageLines]
 *   The page's console and page-error lines so far, in order.
 * @param {number} [args.framesAfterLoss] Renders after a forced loss (30).
 * @param {number} [args.lossTimeoutMs] Bound on the loss report (10000).
 * @returns {Promise<object>} `{mode, steps, terminal, deviceLost, errors,
 *   owners: {before, after}, consoleErrors}`.
 */
export async function runDeviceLossSteps({
  page,
  rig,
  settle,
  mode,
  readCensus,
  ownerLabels = [],
  readPageLines,
  framesAfterLoss = 30,
  lossTimeoutMs = 10000,
}) {
  if (!DEVICE_LOSS_MODES.includes(mode)) {
    throw new TypeError(
      `device-loss mode ${String(mode)} is not one of ${DEVICE_LOSS_MODES.join(", ")}`,
    );
  }
  const dials = rig.dials ?? {};
  const settleFramesPerStep = dials.settleFramesPerStep ?? 30;
  const steps = [];
  const after = async (name, ok, detail) => {
    const liveness = await readLiveness(page);
    steps.push({
      name,
      ok,
      detail,
      liveness: liveness.state,
      deviceLost: liveness.gate.deviceLost,
      errorsSoFar: liveness.gate.errors.length,
    });
    return liveness.state !== "lost";
  };

  let alive = true;
  if (alive && Array.isArray(dials.resizeLadder)) {
    const detail = await runGlobeResizeSteps({
      page,
      rig: {
        dials: {
          resizeLadder: dials.resizeLadder,
          settleFramesPerStep,
          msaaSamples: dials.msaaSamples ?? 1,
        },
      },
      settle,
    });
    alive = await after("resize-ladder", true, detail);
  }
  if (alive && Array.isArray(dials.swaps)) {
    const detail = await runSkyBoxSwapSteps({
      page,
      rig: { dials: { swaps: dials.swaps, settleFramesPerStep } },
      settle,
    });
    const ok = (detail.steps ?? []).every((step) => step.ok !== false);
    alive = await after("skybox-swaps", ok, detail);
  }
  if (alive && dials.tierSwitch) {
    const { dial, values = [] } = dials.tierSwitch;
    const switched = [];
    let ok = TIER_SWITCH_TARGETS.includes(dial);
    for (const value of ok ? values : []) {
      const result = await page.evaluate(pageSwitchTier, { dial, value });
      switched.push({ value, ...result });
      if (!result.ok) {
        ok = false;
        break;
      }
      await settle(settleFramesPerStep);
    }
    alive = await after(`tier-switch:${dial}`, ok, { switched });
  }

  const census = readCensus ?? (async () => null);
  const before = liveRowsForLabels(await census(page), ownerLabels);

  let terminal;
  if (!alive) {
    terminal = {
      action: null,
      skipped: "an unexpected device loss during the provoking steps",
    };
  } else if (mode === "teardown") {
    terminal = {
      action: "viewer.destroy",
      ...(await page.evaluate(pageDestroyViewer)),
    };
  } else {
    const loss = await page.evaluate(pageForceDeviceLoss, {
      timeoutMs: lossTimeoutMs,
    });
    const rendered = await page.evaluate(pageRenderAfterLoss, {
      frames: framesAfterLoss,
    });
    terminal = { action: loss.method, loss, rendered };
  }

  const gate = await collectGateErrors(page);
  const ownersAfter = liveRowsForLabels(await census(page), ownerLabels);
  return {
    mode,
    steps,
    terminal,
    deviceLost: gate.deviceLost,
    errors: gate.errors.slice(0, 20),
    errorCount: gate.errors.length,
    owners: { labels: [...ownerLabels], before, after: ownersAfter },
    consoleErrors: classifyConsoleErrors(
      typeof readPageLines === "function" ? readPageLines() : [],
    ),
  };
}
