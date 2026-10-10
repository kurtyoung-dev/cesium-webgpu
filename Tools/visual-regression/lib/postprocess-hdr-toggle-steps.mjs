// postprocess-hdr-toggle-steps.mjs — the HDR toggle sequence a probe takes a live WebGPU viewer through, and how one step is read and judged.
// @purpose The HDR canvas-output and highDynamicRange toggle steps as data, the page functions that apply a rig's dials, apply one step and read the post-process state after it, and the pure judgement of one step's record.
// @status ACTIVE
//
// WHY A MODULE AND NOT A CAPTURE OPTION. The capture kit takes one frame of a
// settled scene; it has no notion of "change this, render, capture, change the
// next thing". The toggles here are runtime changes of the canvas
// configuration and of the scene framebuffer format on a page that stays
// open, so each step must run on the same viewer as the step before it. The
// steps live here as data so any globe probe can take a viewer through them;
// the probe that owns the rig decides what to capture between them.
//
// WHAT A STEP RECORDS. After a step's frames have rendered: the scene flags as
// the page reports them, the canvas presentation format and whether the
// context kept the HDR canvas configuration (a device or browser that cannot
// configure an extended-range canvas demotes it to SDR, and a step that never
// changed the format cannot show a format defect), the post-process stage
// state `CesiumDebug.postProcess()` reports, and every uncaptured WebGPU error
// `Tools/lib/webgpu-error-gate.mjs` collected while the step rendered.
//
// Page functions take everything they need as arguments: a function handed to
// `page.evaluate` cannot see this module's bindings.

/**
 * The sequence, in order. `start` changes nothing: it is the frame of the
 * rig's pinned dials. Each later step changes one scene flag.
 */
export const HDR_TOGGLE_STEPS = Object.freeze([
  Object.freeze({ id: "start", set: null }),
  Object.freeze({ id: "canvas-hdr-on", set: { useHDRCanvasOutput: true } }),
  Object.freeze({ id: "canvas-hdr-off", set: { useHDRCanvasOutput: false } }),
  Object.freeze({ id: "scene-hdr-on", set: { highDynamicRange: true } }),
  Object.freeze({ id: "scene-hdr-off", set: { highDynamicRange: false } }),
]);

/** The canvas format the HDR canvas-output configuration presents. */
export const HDR_CANVAS_FORMAT = "rgba16float";

/**
 * Apply a rig's dials to the page's viewer, pin its clock and settle the
 * tiles. Runs in the page.
 *
 * @param {{moduleUrl: string, dials: object, clock: string|null, det: string,
 *   minFrames: number, maxFrames: number, stableFrames: number}} args
 * @returns {Promise<{framesRendered: number, tilesLoaded: boolean}>}
 */
export async function pageApplyHdrToggleDials({
  moduleUrl,
  dials,
  clock,
  det,
  minFrames,
  maxFrames,
  stableFrames,
}) {
  const root = globalThis;
  const viewer = root.viewer;
  const scene = viewer.scene;
  const C = await import(moduleUrl);
  // eslint-disable-next-line no-new-func
  new Function(det)();
  root.__det.pinClock(C, viewer, scene, clock);
  // The display policy goes first: with it on, display detection may assign
  // either flag after this function has set it.
  scene.hdrDisplayPolicy = dials.hdrDisplayPolicy;
  scene.highDynamicRange = dials.highDynamicRange;
  scene.useHDRCanvasOutput = dials.useHDRCanvasOutput;
  scene.colorGradingEnabled = dials.colorGradingEnabled;
  scene.colorGradingConfig = { ...dials.colorGradingConfig };
  const framesRendered = await root.__det.settleTiles(scene, {
    minFrames,
    maxFrames,
    stableFrames,
  });
  return { framesRendered, tilesLoaded: scene.globe.tilesLoaded === true };
}

/**
 * Apply one step's flag changes, render `frames` frames, and read the state
 * the step left. Runs in the page; the error gate must already be armed.
 *
 * @param {{set: object|null, frames: number, gateFrom: number}} args `gateFrom`
 *   is how many gate errors earlier steps had collected; only later ones are
 *   this step's.
 * @returns {Promise<object>} The page half of the step record.
 */
export async function pageApplyHdrStep({ set, frames, gateFrom }) {
  const root = globalThis;
  const scene = root.viewer.scene;
  if (set) {
    for (const [key, value] of Object.entries(set)) {
      scene[key] = value;
    }
  }
  for (let i = 0; i < frames; i++) {
    scene.render();
    await new Promise((resolve) => requestAnimationFrame(resolve));
  }
  const gate = root.__webgpuGate ?? null;
  const debug = root.CesiumDebug;
  let postProcess = null;
  if (debug && typeof debug.postProcess === "function") {
    const state = debug.postProcess();
    postProcess = state
      ? {
          hasActiveStages: state.hasActiveStages === true,
          tonemapEnabled: state.tonemapEnabled ?? null,
          colorGradingEnabled: state.colorGradingEnabled ?? null,
          fxaaEnabled: state.fxaaEnabled ?? null,
        }
      : null;
  }
  const context = scene.context;
  return {
    flags: {
      highDynamicRange: scene.highDynamicRange === true,
      useHDRCanvasOutput: scene.useHDRCanvasOutput === true,
    },
    canvas: {
      presentationFormat: context.presentationFormat ?? null,
      hdrCanvasOutput: context.hdrCanvasOutput === true,
    },
    postProcess,
    gate: gate
      ? {
          armed: gate.armedDevices,
          total: gate.errors.length,
          errors: gate.errors.slice(gateFrom),
          deviceLost: gate.deviceLost,
        }
      : null,
  };
}

/**
 * Judge one step's record. Pure.
 *
 * A step passes when, after it, the page rendered with no uncaptured WebGPU
 * error, no console error and no device loss; the colour-grading stage is
 * present and enabled; the frame is not dead; and the frame is grey, which the
 * rig's saturation-0 grade makes it only when the grade ran. A step whose
 * request for the HDR canvas was demoted to SDR is marked `deviceBlocked`: it
 * still has to render cleanly, but it exercised no format change.
 *
 * @param {object} record The step record: the page half plus `consoleErrors`
 *   (this step's) and `frame` ({nonBlackFraction, meanChroma}).
 * @param {{nonBlackFloor: number, chromaCeiling: number}} limits
 * @returns {{pass: boolean, deviceBlocked: boolean, reasons: string[]}}
 */
export function judgeHdrStep(record, limits) {
  const reasons = [];
  const gate = record.gate;
  if (!gate || !(gate.armed > 0)) {
    reasons.push("the WebGPU error gate was not armed on any device");
  } else {
    if (gate.errors.length > 0) {
      reasons.push(`${gate.errors.length} uncaptured WebGPU error(s)`);
    }
    if (gate.deviceLost) {
      reasons.push(`device lost: ${gate.deviceLost}`);
    }
  }
  if (record.consoleErrors.length > 0) {
    reasons.push(`${record.consoleErrors.length} console error(s)`);
  }
  if (!record.postProcess) {
    reasons.push("CesiumDebug.postProcess() reported no pipeline");
  } else if (record.postProcess.colorGradingEnabled !== true) {
    reasons.push(
      `the colour-grading stage is not live (reported ${String(record.postProcess.colorGradingEnabled)})`,
    );
  }
  if (!(record.frame.nonBlackFraction >= limits.nonBlackFloor)) {
    reasons.push(
      `the frame is dead: non-black fraction ${record.frame.nonBlackFraction} below ${limits.nonBlackFloor}`,
    );
  }
  if (!(record.frame.meanChroma <= limits.chromaCeiling)) {
    reasons.push(
      `the frame is not grey: mean chroma ${record.frame.meanChroma} above ${limits.chromaCeiling}`,
    );
  }
  const askedForHdrCanvas = record.flags.useHDRCanvasOutput === true;
  const deviceBlocked =
    askedForHdrCanvas &&
    (record.canvas.hdrCanvasOutput !== true ||
      record.canvas.presentationFormat !== HDR_CANVAS_FORMAT);
  return { pass: reasons.length === 0, deviceBlocked, reasons };
}
