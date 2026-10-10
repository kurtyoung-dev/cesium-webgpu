// probe-scene-frames.mjs — drive a page's Cesium scene frame by frame, on any
// render mode, under a wall-clock deadline.
//
// @purpose The probe runtime's frame driver: an in-page function that renders a scene one frame at a time by requesting the next render from every postRender, hands each frame to a step callback, and ends when the step says so, at a frame cap, or at a wall-clock deadline, reporting which; plus the call that installs it in a page under one global so a step module's page function can use it.
// @status ACTIVE
//
// WHY A DRIVER. A step sequence that has to do something on a given frame
// (add a batch, then watch what the next frames did with it) cannot be a
// settle: `lib/capture.mjs` settles on `requestAnimationFrame`, which counts
// browser frames whether or not the scene rendered one. It has to count the
// scene's own `postRender` events. And a page in request-render mode renders
// only when asked: `Apps/CesiumViewer` sets `scene.requestRenderMode = true`
// at startup, so a sequence that requests one render and then counts
// `postRender` events sees a few dozen frames (the scene's own pending work)
// and then none. The driver therefore calls `scene.requestRender()` from
// every `postRender` it handles, which is harmless when the scene renders
// continuously anyway.
//
// WHY A WALL-CLOCK DEADLINE. A frame cap only trips when frames arrive. A
// scene that stops rendering altogether (a device loss, an exception that
// stopped the render loop, a page that never started one) fires no
// `postRender`, so without a clock the promise never settles and the
// `page.evaluate` that awaits it never returns. The deadline RESOLVES with
// `outcome: "deadline"` rather than rejecting, so the caller still receives
// the frames it did see and names the refusal itself.
//
// HOW A STEP MODULE USES IT. A page function cannot see this module's
// bindings, so the probe calls `installSceneFrameDriver(page)` once the page
// has a viewer, and the step module's page function reads the driver from
// `globalThis[SCENE_FRAME_DRIVER_GLOBAL]` (the name is passed in as an
// argument). `driveSceneFrames` is self-contained for that reason: it uses
// nothing but its arguments and the page's own globals.

/** The page global `installSceneFrameDriver` puts the driver under. */
export const SCENE_FRAME_DRIVER_GLOBAL = "__probeDriveSceneFrames";

/** Every way a driven run can end. */
export const SCENE_FRAME_OUTCOMES = Object.freeze({
  DONE: "done",
  FRAME_CAP: "frame-cap",
  DEADLINE: "deadline",
  STEP_ERROR: "step-error",
});

/**
 * Render a scene frame by frame until `onFrame` returns `true`, `maxFrames`
 * frames have rendered, or `deadlineMs` has passed, whichever comes first.
 * Runs in the page (or anywhere `performance`, `setTimeout` and a scene with a
 * `postRender` event exist); it reads nothing outside its arguments.
 *
 * @param {{postRender: {addEventListener: Function}, requestRender: Function}} scene
 *   The scene to drive.
 * @param {object} options Options.
 * @param {(frame: number) => boolean} options.onFrame Called after each
 *   rendered frame with its 1-based count; `true` ends the run.
 * @param {number} options.maxFrames The frame count that ends the run.
 * @param {number} options.deadlineMs Wall-clock milliseconds the run may take.
 * @returns {Promise<{outcome: string, frames: number, elapsedMs: number,
 *   error?: string}>} How the run ended. Never rejects.
 */
export function driveSceneFrames(scene, { onFrame, maxFrames, deadlineMs }) {
  return new Promise((resolve) => {
    const started = performance.now();
    let frames = 0;
    let settled = false;
    let removeListener = () => {};
    let timer = null;
    const finish = (outcome, error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      removeListener();
      const record = {
        outcome,
        frames,
        elapsedMs: Math.round(performance.now() - started),
      };
      if (error !== undefined) {
        record.error = String(error?.message ?? error);
      }
      resolve(record);
    };
    timer = setTimeout(() => finish("deadline"), Math.max(0, deadlineMs));
    removeListener = scene.postRender.addEventListener(() => {
      if (settled) {
        return;
      }
      frames += 1;
      let done;
      try {
        done = onFrame(frames) === true;
      } catch (error) {
        finish("step-error", error);
        return;
      }
      if (done) {
        finish("done");
        return;
      }
      if (frames >= maxFrames) {
        finish("frame-cap");
        return;
      }
      // Request-render mode renders only when asked; ask for the next frame.
      scene.requestRender();
    });
    scene.requestRender();
  });
}

/**
 * Install {@link driveSceneFrames} in a page under
 * {@link SCENE_FRAME_DRIVER_GLOBAL}, so a page function can drive frames.
 *
 * @param {{evaluate: Function}} page A Playwright page or frame.
 * @returns {Promise<void>}
 */
export async function installSceneFrameDriver(page) {
  await page.evaluate(
    `globalThis[${JSON.stringify(SCENE_FRAME_DRIVER_GLOBAL)}] = ${driveSceneFrames.toString()};`,
  );
}
