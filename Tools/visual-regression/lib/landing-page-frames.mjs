/**
 * The landing probe's page-side frame driver: how many frames a rig settles
 * for, and the in-page function that renders them at the frozen clock.
 * @purpose Frame-driver piece for probe-landing-cells.mjs: the settle frame count a rig's readiness names (settleFrames, or settleMs at about 60 frames a second), the in-page frame loop the probe's settle and every step piece it hands `settle` to (clock steps, dive gate, device loss) run with the viewer's own render loop stopped, and page time since navigation start.
 * @status ACTIVE
 *
 * WHY A PIECE. The landing stage stops the viewer's render loop
 * (`lib/landing-cell-stage.mjs`), so every frame of a landing page is one the
 * probe drives from here; the frame loop moved out of
 * `probe-landing-cells.mjs` (near 1,000 lines) so that it has one home and a
 * spec of its own. The page functions are self-contained because
 * `page.evaluate` serialises them.
 *
 * A DRIVEN FRAME IS A WIDGET FRAME. With the render loop stopped, the only
 * thing that refreshes `scene.globeHeight` and runs the screen-space camera
 * controller (so a wheel notch moves the camera) is
 * `scene.initializeFrame()`; `scene.render()` alone marks the globe height
 * stale and never refreshes it. `CesiumWidget.prototype.render` runs both in
 * that order, so each driven frame does too, at the clock the stage froze (no
 * `clock.tick()`).
 *
 * @module Tools/visual-regression/lib/landing-page-frames
 */

/**
 * The frames a rig settles for after staging. Pure.
 *
 * @param {{readiness?: {kind?: string, frames?: number, ms?: number}}} rig
 * @returns {number}
 */
export function settleFramesOf(rig) {
  if (rig.readiness?.kind === "settleFrames") {
    return rig.readiness.frames;
  }
  // A settleMs rig renders at about 60 frames a second for its time.
  return Math.max(1, Math.round(((rig.readiness?.ms ?? 1000) / 1000) * 60));
}

/**
 * Render `frames` widget frames at the frozen clock: `initializeFrame()`,
 * then `render()`, then one animation frame. Runs in the page.
 */
export async function pageRenderFrames({ frames }) {
  const viewer = /** @type {any} */ (globalThis).viewer;
  for (let i = 0; i < frames; i++) {
    viewer.scene.initializeFrame();
    viewer.scene.render(viewer.clock.currentTime);
    await new Promise((resolve) => requestAnimationFrame(resolve));
  }
  return frames;
}

/** Page time now (milliseconds since navigation start). Runs in the page. */
export function pageNow() {
  return performance.now();
}
