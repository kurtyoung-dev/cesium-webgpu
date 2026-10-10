/**
 * The globe family's step sequence for a resource-lifetime leg: resize the
 * canvas through a rig's ladder, settling after each size.
 * @purpose Globe-family steps for probe-texture-lifetime.mjs: set the scene's MSAA sample count from the rig, walk the rig's resize ladder with page.setViewportSize, settle after each size and record the canvas size the page actually rendered at.
 * @status ACTIVE
 *
 * The steps are data in the rig (`dials.resizeLadder`, `dials.msaaSamples`,
 * `dials.settleFramesPerStep`); this module only executes them, so the probe
 * declares cells and every family keeps its steps in one place.
 *
 * @module Tools/visual-regression/lib/globe-resize-steps
 */

/**
 * Set the scene's MSAA sample count and read back what the scene holds.
 * Runs in the page. The context's effective count is written at render time,
 * so it is read after the first settle, not here.
 *
 * @param {{samples: number}} args
 * @returns {{sceneMsaaSamples: number|null}}
 */
export function pageSetMsaaSamples({ samples }) {
  const viewer = /** @type {any} */ (globalThis).viewer;
  viewer.scene.msaaSamples = samples;
  return { sceneMsaaSamples: viewer.scene.msaaSamples ?? null };
}

/**
 * The canvas size the scene last rendered at. Runs in the page.
 *
 * @returns {{width: number, height: number, contextMsaaSamples: number|null}}
 */
export function pageReadCanvasSize() {
  const viewer = /** @type {any} */ (globalThis).viewer;
  const canvas = viewer.scene.canvas;
  return {
    width: canvas.width,
    height: canvas.height,
    contextMsaaSamples: viewer.scene.context?._msaaSamples ?? null,
  };
}

/**
 * Walk the rig's resize ladder.
 *
 * @param {object} args
 * @param {{setViewportSize: Function, evaluate: Function}} args.page
 * @param {object} args.rig A rig carrying `dials.resizeLadder` and
 *   `dials.settleFramesPerStep`.
 * @param {(frames: number) => Promise<unknown>} args.settle Renders that many
 *   frames in the page.
 * @returns {Promise<{msaa: object, steps: Array<object>}>} What each step
 *   requested and what the page rendered at.
 */
export async function runGlobeResizeSteps({ page, rig, settle }) {
  const { resizeLadder, settleFramesPerStep, msaaSamples } = rig.dials;
  const msaa = await page.evaluate(pageSetMsaaSamples, {
    samples: msaaSamples,
  });
  await settle(settleFramesPerStep);
  msaa.contextMsaaSamplesAfterSettle = (
    await page.evaluate(pageReadCanvasSize)
  ).contextMsaaSamples;
  const steps = [];
  for (const [width, height] of resizeLadder) {
    await page.setViewportSize({ width, height });
    await settle(settleFramesPerStep);
    steps.push({
      requested: { width, height },
      rendered: await page.evaluate(pageReadCanvasSize),
    });
  }
  return { msaa, steps };
}
