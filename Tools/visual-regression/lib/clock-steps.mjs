/**
 * A rig's clock steps: move the scene's clock to each instant the rig lists,
 * settling after each, so the only thing that changes between steps is the
 * sun (and anything else the time drives).
 * @purpose Step piece for the R-14 sky-only cell (and any rig with dials.clockSteps): sets the viewer's frozen clock to each ISO instant in order, renders the rig's settleFramesPerStep frames at it, and records per step the instant the clock reads back, the frame number and the sun direction the uniform state carries.
 * @status ACTIVE
 *
 * The steps are data in the rig (`dials.clockSteps`, `dials.settleFramesPerStep`);
 * this module only executes them, with the `{page, rig, settle}` signature the
 * other step pieces take (`lib/globe-resize-steps.mjs`,
 * `lib/skybox-swap-steps.mjs`). `settle(frames)` is the probe's own frame
 * renderer; with the viewer's clock frozen, every frame it renders draws at the
 * instant this module set.
 *
 * @module Tools/visual-regression/lib/clock-steps
 */

/**
 * PAGE SIDE. Set the frozen clock to `iso`. Self-contained; the Cesium
 * namespace comes from `moduleUrl`.
 *
 * @param {{iso: string, moduleUrl: string}} args
 * @returns {Promise<{ok: boolean, observed?: string, reason?: string}>}
 */
export async function pageSetClock({ iso, moduleUrl }) {
  const viewer = /** @type {any} */ (globalThis).viewer;
  if (!viewer) {
    return { ok: false, reason: "the page has no viewer" };
  }
  let C;
  try {
    C = await import(moduleUrl);
  } catch (error) {
    return {
      ok: false,
      reason: `the Cesium module did not load: ${String(error && error.message ? error.message : error)}`,
    };
  }
  viewer.clock.shouldAnimate = false;
  viewer.clock.currentTime = C.JulianDate.fromIso8601(iso);
  return {
    ok: true,
    observed: C.JulianDate.toIso8601(viewer.clock.currentTime, 0),
  };
}

/**
 * PAGE SIDE. The frame number and the sun direction (world coordinates) the
 * scene last rendered with.
 *
 * @returns {{frameNumber: number|null, sunDirectionWC: number[]|null}}
 */
export function pageReadSunState() {
  const scene = /** @type {any} */ (globalThis).viewer.scene;
  const sun =
    scene.context &&
    scene.context.uniformState &&
    scene.context.uniformState.sunDirectionWC;
  const frameNumber = scene.frameState && scene.frameState.frameNumber;
  return {
    frameNumber: typeof frameNumber === "number" ? frameNumber : null,
    sunDirectionWC: sun ? [sun.x, sun.y, sun.z] : null,
  };
}

/** Where the page imports the Cesium namespace from. */
export const CLOCK_STEPS_MODULE_URL = "/Build/CesiumUnminified/index.js";

/**
 * Walk the rig's clock steps.
 *
 * @param {object} args
 * @param {{evaluate: Function}} args.page
 * @param {object} args.rig A rig carrying `dials.clockSteps` (ISO instants)
 *   and `dials.settleFramesPerStep`.
 * @param {(frames: number) => Promise<unknown>} args.settle Renders that many
 *   frames in the page.
 * @returns {Promise<{steps: Array<{name: string, ok: boolean,
 *   observed?: string, reason?: string, frameNumber?: number|null,
 *   sunDirectionWC?: number[]|null}>}>} A step that could not set the clock
 *   ends the walk with `ok: false`, as the other step pieces do.
 */
export async function runClockSteps({ page, rig, settle }) {
  const { clockSteps = [], settleFramesPerStep = 0 } = rig.dials ?? {};
  const steps = [];
  for (const iso of clockSteps) {
    const result = await page.evaluate(pageSetClock, {
      iso,
      moduleUrl: CLOCK_STEPS_MODULE_URL,
    });
    if (!result.ok) {
      steps.push({ name: iso, ...result });
      break;
    }
    await settle(settleFramesPerStep);
    steps.push({
      name: iso,
      ...result,
      ...(await page.evaluate(pageReadSunState)),
    });
  }
  return { steps };
}
