/**
 * The split-screen comparison page's own state that a capture must control:
 * the per-run status box drawn over each canvas, and the page clock a scene's
 * setup may pin.
 * @purpose Page-side helpers for capture-and-diff.mjs on Apps/WebGPUTest/split-screen-comparison.html: hide or show the per-run status boxes (.pane-status, "WebGPU — 342ms") before an element capture, and snapshot and restore the page clock (the WebGL master's animation, wall-clock offset and instant) around a scene so a setup that pins it does not leak into the scenes after it.
 * @status ACTIVE
 *
 * WHY (round 5, K5-4 and K5-5). An element screenshot captures whatever the
 * page draws over the element, and the page draws each viewer's creation time
 * over the bottom-left of its canvas, so the digits differed inside the
 * compared pixels run to run (Calenhad, round 2, note 7). And the runner applies
 * every scene of a sweep to one page, so a scene that pins the clock (the
 * clock-pinned twins, the subsystem scenes) would leave every later scene at
 * its instant. Both are the page's state, not a scene's, so they live here
 * rather than in the runner or in a setup file.
 *
 * Every function here is self-contained: it reads only its argument and the
 * page's globals (`document`, `window.Cesium`, `window.webglViewer`,
 * `window.webgpuViewer`).
 *
 * @module Tools/visual-regression/lib/split-screen-page-state
 */

/**
 * PAGE SIDE. The page clock as a scene leaves it: the WebGL viewer's (the
 * page's clock master; its sync copies it into the WebGPU viewer every frame),
 * read as whether it animates, its offset from the wall clock, its instant at
 * full precision (`instant`) and to the second (`iso`, for a reader).
 * Self-contained.
 *
 * @returns {{shouldAnimate: boolean, offsetSeconds: number, instant: string,
 *   iso: string, webgpuIso: string|null}|null} null without the viewers.
 */
export function snapshotSceneClockInPage() {
  const Cesium = window.Cesium;
  const master = window.webglViewer;
  if (!Cesium || !master || !master.clock) {
    return null;
  }
  const slave = window.webgpuViewer;
  return {
    shouldAnimate: master.clock.shouldAnimate === true,
    offsetSeconds: Cesium.JulianDate.secondsDifference(
      master.clock.currentTime,
      Cesium.JulianDate.now(),
    ),
    instant: Cesium.JulianDate.toIso8601(master.clock.currentTime),
    iso: Cesium.JulianDate.toIso8601(master.clock.currentTime, 0),
    webgpuIso:
      slave && slave.clock
        ? Cesium.JulianDate.toIso8601(slave.clock.currentTime, 0)
        : null,
  };
}

/**
 * PAGE SIDE. Put the page clock back as {@link snapshotSceneClockInPage} read
 * it before a scene's setup, so a setup that pins the clock (the clock-pinned
 * twins, the subsystem scenes) does not leave it pinned for the scenes after
 * it in a sweep (round 5, K5-5). An animating clock resumes at its old offset
 * from the wall clock, i.e. where it would have been; a frozen one gets its
 * instant back. Self-contained.
 *
 * @param {{shouldAnimate: boolean, offsetSeconds: number,
 *   instant: string}|null} snapshot
 * @returns {boolean} Whether anything was restored.
 */
export function restoreSceneClockInPage(snapshot) {
  const Cesium = window.Cesium;
  const master = window.webglViewer;
  if (!snapshot || !Cesium || !master || !master.clock) {
    return false;
  }
  const time = snapshot.shouldAnimate
    ? Cesium.JulianDate.addSeconds(
        Cesium.JulianDate.now(),
        snapshot.offsetSeconds,
        new Cesium.JulianDate(),
      )
    : Cesium.JulianDate.fromIso8601(snapshot.instant);
  master.clock.currentTime = time;
  master.clock.shouldAnimate = snapshot.shouldAnimate;
  if (window.webgpuViewer && window.webgpuViewer.clock) {
    // The page's slave never animates; its sync copies the master each frame.
    window.webgpuViewer.clock.currentTime = Cesium.JulianDate.clone(time);
  }
  return true;
}

/** The split-screen page's per-run status boxes (`#leftStatus`, `#rightStatus`). */
export const PANE_STATUS_SELECTOR = ".pane-status";

/**
 * PAGE SIDE. Show or hide every element `selector` matches (visibility only,
 * so nothing reflows). Self-contained.
 *
 * @param {{selector: string, show: boolean}} args
 * @returns {number} The number of elements set.
 */
export function setPaneStatusVisibilityInPage({ selector, show }) {
  const elements = document.querySelectorAll(selector);
  for (const element of elements) {
    element.style.visibility = show ? "" : "hidden";
  }
  return elements.length;
}
