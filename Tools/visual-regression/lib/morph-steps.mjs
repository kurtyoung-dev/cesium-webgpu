/**
 * The morph-hold page step of the landing cell E-CLOUD-morph: start a scene
 * mode morph that outlasts the run, and read the mode and the morph time
 * before and after the frames rendered inside it.
 * @purpose Page-side morph-hold step and the pure Node record builder for the landing cells of kind morph-hold: calls scene.morphTo2D / morphToColumbusView / morphTo3D with a duration of thousands of seconds, so the scene stays in SceneMode.MORPHING for every frame the cell renders and captures, reads scene.mode (by name) and scene.morphTime before and after the frames, and answers held: true only when both reads are MORPHING; a tree or a page that cannot start the morph answers a NOT AVAILABLE reason naming the seam, never a mode it did not read.
 * @status ACTIVE
 *
 * WHY HELD AND NOT STOPPED AT A FRACTION. The scene's tweens advance on
 * wall-clock time (`TweenCollection` reads the real clock, not the pinned
 * viewer clock), and `Scene.initializeFrame` runs the tween update before
 * the frame state is built, so a morph of ordinary length passes through its fractions at
 * a speed the probe does not control, and a `morphTime` written by hand is
 * overwritten by the next tween update. A morph of a very long duration keeps
 * the mode MORPHING for the whole run; from 3D the engine tweens the camera
 * first and starts the `morphTime` tween only when that completes, so
 * `morphTime` does not move during the run. The step reports the two
 * `morphTime` reads so the receipt shows how far it moved; it does not claim
 * a fraction.
 *
 * @module Tools/visual-regression/lib/morph-steps
 */

/** The morph targets the dial accepts, and the scene method each calls. */
export const MORPH_HOLD_TARGETS = Object.freeze({
  SCENE2D: "morphTo2D",
  COLUMBUS_VIEW: "morphToColumbusView",
  SCENE3D: "morphTo3D",
});

/** Frames rendered between the two reads. */
export const MORPH_HOLD_FRAMES = 30;

/**
 * The first error of a `morphHold` dial value, or null. Pure.
 *
 * @param {unknown} value
 * @returns {string|null}
 */
export function morphHoldViolation(value) {
  if (value === null || typeof value !== "object") {
    return "morphHold must be {to, seconds}";
  }
  const { to, seconds } = /** @type {any} */ (value);
  if (!Object.hasOwn(MORPH_HOLD_TARGETS, to)) {
    return `morphHold.to must be one of ${Object.keys(MORPH_HOLD_TARGETS).join(", ")}`;
  }
  if (!(Number.isFinite(seconds) && seconds >= 600)) {
    return "morphHold.seconds must be at least 600 (the morph has to outlast the run)";
  }
  return null;
}

/**
 * PAGE SIDE. Start the morph, then render frames inside it and read the mode
 * before and after. Self-contained: passed to `page.evaluate`.
 *
 * @param {{to: string, seconds: number, frames: number, method: string,
 *   moduleUrl: string}} input
 * @returns {Promise<object>} JSON-safe.
 */
export async function pageMorphHold({
  to,
  seconds,
  frames,
  method,
  moduleUrl,
}) {
  const viewer = /** @type {any} */ (globalThis).viewer;
  const scene = viewer && viewer.scene;
  if (!scene || typeof scene[method] !== "function") {
    return {
      available: false,
      reason: `NOT AVAILABLE: scene.${method} is not a function on this page`,
    };
  }
  const C = await import(moduleUrl);
  const nameOf = (mode) => {
    for (const key of Object.keys(C.SceneMode)) {
      if (C.SceneMode[key] === mode) {
        return key;
      }
    }
    return `unknown(${String(mode)})`;
  };
  const read = () => ({
    mode: nameOf(scene.mode),
    morphTime: scene.morphTime,
    frameNumber: scene.frameState ? scene.frameState.frameNumber : null,
  });
  const before = read();
  try {
    scene[method](seconds);
  } catch (error) {
    return {
      available: false,
      reason: `NOT AVAILABLE: scene.${method}(${seconds}) threw ${String(error && error.message ? error.message : error)}`,
    };
  }
  const started = read();
  for (let i = 0; i < frames; i++) {
    scene.initializeFrame();
    scene.render(viewer.clock.currentTime);
    await new Promise((resolve) => requestAnimationFrame(resolve));
  }
  const after = read();
  return { available: true, to, seconds, frames, before, started, after };
}

/**
 * The record a morph-hold page carries, from the page's raw answer. Pure.
 * `held` is true only when the scene read MORPHING right after the morph was
 * started and again after the frames.
 *
 * @param {object|null|undefined} raw {@link pageMorphHold}'s answer.
 * @returns {object}
 */
export function morphHoldRecord(raw) {
  if (!raw || raw.available !== true) {
    return {
      available: false,
      reason:
        raw?.reason ??
        "NOT AVAILABLE: the page returned no morph-hold answer (seam: scene.morphTo*)",
    };
  }
  const startedMode = raw.started?.mode ?? null;
  const afterMode = raw.after?.mode ?? null;
  const drift =
    Number.isFinite(raw.started?.morphTime) &&
    Number.isFinite(raw.after?.morphTime)
      ? Math.abs(raw.after.morphTime - raw.started.morphTime)
      : null;
  return {
    available: true,
    to: raw.to,
    seconds: raw.seconds,
    frames: raw.frames,
    modeBefore: raw.before?.mode ?? null,
    modeStarted: startedMode,
    modeAfter: afterMode,
    morphTimeStarted: raw.started?.morphTime ?? null,
    morphTimeAfter: raw.after?.morphTime ?? null,
    morphTimeDrift: drift,
    held: startedMode === "MORPHING" && afterMode === "MORPHING",
  };
}

/**
 * Run the morph hold for a rig that declares `morphHold`. Node side.
 *
 * @param {{page: object, rig: object, moduleUrl: string, frames?: number}} input
 * @returns {Promise<object>} {@link morphHoldRecord}'s answer, or
 *   `{available: false, reason}` when the rig declares no (valid) dial.
 */
export async function runMorphHold({
  page,
  rig,
  moduleUrl,
  frames = MORPH_HOLD_FRAMES,
}) {
  const dial = rig?.dials?.morphHold;
  const violation = morphHoldViolation(dial);
  if (violation !== null) {
    return { available: false, reason: `NOT AVAILABLE: ${violation}` };
  }
  const raw = await page.evaluate(pageMorphHold, {
    to: dial.to,
    seconds: dial.seconds,
    frames,
    method: MORPH_HOLD_TARGETS[dial.to],
    moduleUrl,
  });
  return morphHoldRecord(raw);
}
