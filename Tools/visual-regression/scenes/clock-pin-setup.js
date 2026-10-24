/**
 * Pin both split-screen viewers' clocks to one instant, frozen, so a scene
 * that otherwise follows the wall clock (globe-default, globe-horizon) shows
 * the same sun, terminator and sky on every run (round 5, K5-5).
 *
 * WHY. `split-screen-comparison.html` starts the WebGL viewer's clock at page
 * load with `shouldAnimate = true` and copies it into the WebGPU viewer every
 * frame (VR3-SPLIT-SCREEN-CLOCK-SYNC). The two halves agree with each other,
 * but a capture at night is compared with a historical baseline captured in
 * daylight: on 2026-10-23 the globe-default historical gates measured 99.3 %
 * mismatch and passed only by the letter, with no sensitivity. The clock-pinned
 * twin scenes run this file first so their captures, and the baselines a
 * reviewed refresh takes from them (R-2026-08-29-2), share one instant.
 *
 * HOW. The WebGL viewer is the page's clock master: stopping its animation and
 * setting its time pins both, because the page's own sync copies it into the
 * WebGPU viewer on the next frame; the WebGPU viewer is set directly too, so
 * neither half waits on the copy. The file then waits until both clocks read
 * the instant and throws if they do not within the budget, because a twin
 * that silently kept the wall clock would certify the night capture again.
 *
 * Called as `new Function("params", src)(params)` from `capture-and-diff.mjs`'s
 * `applyScene` with `params.pinnedTimeIso`, an ISO-8601 UTC instant (the
 * twin rig's `setupParams`, hashed into the scene identity). Returns a Promise
 * the runner awaits before positioning the camera and settling.
 */

/* global params */
const Cesium = window.Cesium;
const viewers = [window.webglViewer, window.webgpuViewer].filter(Boolean);
if (viewers.length !== 2) {
  throw new Error("clock-pin-setup: both split-screen viewers are required");
}
if (typeof params?.pinnedTimeIso !== "string") {
  throw new Error("clock-pin-setup: setupParams.pinnedTimeIso is required");
}

const CLOCK_PIN_BUDGET_FRAMES = 120;
const pinned = Cesium.JulianDate.fromIso8601(params.pinnedTimeIso);

for (const viewer of viewers) {
  viewer.clock.shouldAnimate = false;
  viewer.clock.currentTime = Cesium.JulianDate.clone(pinned);
}

return new Promise((resolve, reject) => {
  let frames = 0;
  function tick() {
    frames++;
    for (const viewer of viewers) {
      viewer.scene.requestRender();
    }
    const held = viewers.every(
      (viewer) =>
        viewer.clock.shouldAnimate === false &&
        Cesium.JulianDate.equals(viewer.clock.currentTime, pinned),
    );
    if (held && frames > 2) {
      resolve();
    } else if (frames > CLOCK_PIN_BUDGET_FRAMES) {
      reject(
        new Error(
          `clock-pin-setup: the viewers' clocks did not hold ${params.pinnedTimeIso} within ${CLOCK_PIN_BUDGET_FRAMES} frames`,
        ),
      );
    } else {
      requestAnimationFrame(tick);
    }
  }
  tick();
});
