/**
 * The sky-box family's step sequence for a resource-lifetime leg: swap the
 * default sky box's sources in place, settling after each swap.
 * @purpose Sky-box-family steps for probe-texture-lifetime.mjs: replace the default sky box's six face sources in place with solid-colour canvases, once per entry of the rig's swap list, and settle after each swap so its load lands before the next.
 * @status ACTIVE
 *
 * The swaps are data in the rig (`dials.swaps`, `dials.settleFramesPerStep`);
 * this module only executes them. The swap assigns `skyBox.sources` on the SAME
 * sky box rather than building a new one, because replacing a loaded cube
 * texture on a live panorama is the path under test.
 *
 * @module Tools/visual-regression/lib/skybox-swap-steps
 */

/**
 * Replace the sky box's face sources with six solid-colour canvases. Runs in
 * the page.
 *
 * @param {{rgb: number[], faceSize: number}} args
 * @returns {{ok: boolean, reason?: string}}
 */
export function pageSwapSkyBoxSources({ rgb, faceSize }) {
  const viewer = /** @type {any} */ (globalThis).viewer;
  const skyBox = viewer?.scene?.skyBox;
  if (!skyBox) {
    return { ok: false, reason: "the scene has no sky box to swap" };
  }
  const face = () => {
    const canvas = document.createElement("canvas");
    canvas.width = faceSize;
    canvas.height = faceSize;
    const context2d = canvas.getContext("2d");
    context2d.fillStyle = `rgb(${rgb[0]}, ${rgb[1]}, ${rgb[2]})`;
    context2d.fillRect(0, 0, faceSize, faceSize);
    return canvas;
  };
  skyBox.show = true;
  skyBox.sources = {
    positiveX: face(),
    negativeX: face(),
    positiveY: face(),
    negativeY: face(),
    positiveZ: face(),
    negativeZ: face(),
  };
  return { ok: true };
}

/**
 * Apply the rig's swaps in order.
 *
 * @param {object} args
 * @param {{evaluate: Function}} args.page
 * @param {object} args.rig A rig carrying `dials.swaps` and
 *   `dials.settleFramesPerStep`.
 * @param {(frames: number) => Promise<unknown>} args.settle Renders that many
 *   frames in the page.
 * @returns {Promise<{steps: Array<{name: string, ok: boolean, reason?: string}>}>}
 */
export async function runSkyBoxSwapSteps({ page, rig, settle }) {
  const { swaps, settleFramesPerStep } = rig.dials;
  const steps = [];
  for (const swap of swaps) {
    const result = await page.evaluate(pageSwapSkyBoxSources, {
      rgb: swap.rgb,
      faceSize: swap.faceSize,
    });
    steps.push({ name: swap.name, ...result });
    if (!result.ok) {
      break;
    }
    await settle(settleFramesPerStep);
  }
  return { steps };
}
