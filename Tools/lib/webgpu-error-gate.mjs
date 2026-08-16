/**
 * Shared WebGPU error / crash gate for the Playwright harnesses.
 * @purpose Shared Playwright gate catching unscoped WebGPU validation/OOM errors (onuncapturederror) and device loss, plus a console-error listener.
 * @status ACTIVE
 *
 * Motivation (FORK-34, Batch 207): a five-bug pick regression shipped while
 * BOTH automated harnesses stayed green. The WebGPU draws were raising
 * "Attachment state of [RenderPipeline] is not compatible with
 * [RenderPassEncoder]" validation errors that invalidated whole command
 * buffers — yet `variant-smoke-test` (renders the default globe, never picks)
 * and `capture-and-diff` (pixel-diff only, no error capture at all) both
 * passed. The class of bug "engine emits WebGPU validation errors / loses the
 * device but the page keeps limping along" was completely unguarded.
 *
 * This module is the gate. It catches the two failure classes that surface as
 * runtime GPU faults rather than thrown JS exceptions:
 *
 *   1. **Validation / out-of-memory / internal errors** that are NOT inside a
 *      Cesium `pushErrorScope` — via `device.onuncapturederror`. Cesium never
 *      assigns `onuncapturederror` itself (it uses scoped `popErrorScope` for
 *      pipeline/shader creation, which `console.error`s on failure), so the
 *      gate owns that slot and catches the unscoped draw-time errors — exactly
 *      the FORK-34 class.
 *   2. **Device loss** ("crash to desktop" equivalent) — via the `device.lost`
 *      promise. `.then` is additive, so the gate coexists with Cesium's own
 *      `WebGPUDeviceLossRecovery` / `WebGPUDevicePool` handlers. The normal
 *      teardown path (`viewer.destroy()` → `device.destroy()`) resolves with
 *      `reason === "destroyed"` and is intentionally ignored.
 *
 * It also provides a Node-side console listener that flags the SCOPED
 * validation errors Cesium (and Dawn) print to the console, so both scoped and
 * unscoped faults are covered.
 *
 * Usage (both harnesses):
 *   import { errorGateInit, armWebGPUDevices, collectGateErrors,
 *            attachConsoleErrorGate } from "../lib/webgpu-error-gate.mjs";
 *   const consoleErrors = attachConsoleErrorGate(page); // Node-side
 *   await page.addInitScript(errorGateInit);            // before page.goto
 *   // ... after the viewer(s) exist:
 *   await armWebGPUDevices(page);
 *   // ... after the run:
 *   const gate = await collectGateErrors(page);
 *   const fatal = [...consoleErrors, ...gate.errors,
 *                  ...(gate.deviceLost ? [gate.deviceLost] : [])];
 *
 * @module Tools/lib/webgpu-error-gate
 */

/**
 * Page-context initializer. Pass to `page.addInitScript(errorGateInit)` so it
 * runs before any page script — it only DEFINES the gate + the
 * `window.__armWebGPUDevice(device, label)` arming helper; nothing is armed
 * until a device exists and {@link armWebGPUDevices} (or the page itself) calls
 * the helper. Self-contained: runs in the browser with no Node scope.
 */
export function errorGateInit() {
  const w = /** @type {any} */ (window);
  if (w.__webgpuGate) {
    return;
  }
  const gate = { errors: [], deviceLost: null, armedDevices: 0 };
  w.__webgpuGate = gate;

  // Arm one GPUDevice. Idempotent per device (marks `__gateArmed`). Returns
  // true if it armed this call, false if already armed / not a device.
  w.__armWebGPUDevice = function (device, label) {
    if (!device || device.__gateArmed) {
      return false;
    }
    device.__gateArmed = true;
    gate.armedDevices++;
    const tag = label ? "[" + label + "] " : "";

    // Single-handler slot; Cesium leaves it unset, so the gate owns it.
    device.onuncapturederror = function (ev) {
      const err = ev && ev.error;
      const msg = err && err.message ? err.message : String(ev);
      gate.errors.push(tag + "uncaptured GPU error: " + msg);
    };

    // device.lost is a Promise — additive with Cesium's recovery handler.
    if (device.lost && typeof device.lost.then === "function") {
      device.lost
        .then(function (info) {
          // Normal teardown (viewer.destroy → device.destroy) → ignore.
          if (info && info.reason === "destroyed") {
            return;
          }
          gate.deviceLost =
            tag +
            "device lost: reason=" +
            (info && info.reason) +
            " message=" +
            (info && info.message);
        })
        .catch(function () {
          /* device.lost never rejects, but be defensive */
        });
    }
    return true;
  };
}

/**
 * Walk the known viewer globals and arm every WebGPU device found. Safe to
 * call repeatedly (arming is idempotent per device). Call AFTER the viewer(s)
 * have been constructed so `scene.context._device` exists.
 *
 * @param {import("playwright").Page} page
 * @returns {Promise<{armed:number, found:number, total:number}>}
 */
export async function armWebGPUDevices(page) {
  return await page.evaluate(() => {
    const w = /** @type {any} */ (window);
    const arm = w.__armWebGPUDevice;
    if (!arm) {
      return { armed: 0, found: 0, total: 0 };
    }
    const candidates = [w.viewer, w.webgpuViewer, w.webglViewer, w.__viewer];
    let armed = 0;
    let found = 0;
    for (const v of candidates) {
      const ctx = v && v.scene && v.scene.context;
      const dev = ctx && ctx._device;
      if (dev) {
        found++;
        if (arm(dev, ctx.rendererType || "webgpu")) {
          armed++;
        }
      }
    }
    return {
      armed,
      found,
      total: w.__webgpuGate ? w.__webgpuGate.armedDevices : 0,
    };
  });
}

/**
 * Read the accumulated gate state (uncaptured GPU errors + device loss).
 *
 * @param {import("playwright").Page} page
 * @returns {Promise<{errors:string[], deviceLost:(string|null), armedDevices:number}>}
 */
export async function collectGateErrors(page) {
  return await page.evaluate(() => {
    const w = /** @type {any} */ (window);
    const g = w.__webgpuGate || {
      errors: [],
      deviceLost: null,
      armedDevices: 0,
    };
    return {
      errors: g.errors.slice(),
      deviceLost: g.deviceLost,
      armedDevices: g.armedDevices,
    };
  });
}

/**
 * Pattern matching the console prints that indicate a WebGPU fault. Covers
 * Dawn's own validation messages and Cesium's `popErrorScope().then` handlers,
 * which `console.error` the SCOPED validation errors that never reach
 * `onuncapturederror`.
 */
const WEBGPU_FAULT_RE =
  /validation|not compatible|incompatible|GPUValidationError|out of memory|device(?: was)? lost|popErrorScope|createRenderPipeline|createBindGroup|Attachment state/i;

/**
 * Attach a Node-side console + pageerror listener that collects WebGPU-fault
 * console messages (the SCOPED-error half) and uncaught page exceptions. Call
 * once, right after creating the page, BEFORE `page.goto`. Returns the array it
 * fills so the caller can fold it into the pass/fail decision.
 *
 * @param {import("playwright").Page} page
 * @returns {string[]} live array, appended to as messages arrive
 */
export function attachConsoleErrorGate(page) {
  /** @type {string[]} */
  const consoleErrors = [];
  page.on("console", (msg) => {
    const type = msg.type();
    if (type !== "error" && type !== "warning") {
      return;
    }
    const text = msg.text();
    if (WEBGPU_FAULT_RE.test(text)) {
      consoleErrors.push(`console.${type}: ${text}`);
    }
  });
  page.on("pageerror", (err) => {
    consoleErrors.push(`pageerror: ${err.message}`);
  });
  return consoleErrors;
}
