// video-paused-cell.mjs - the paused video cell: one video frame held still,
// the same texture shown on identical geometry by both renderers, and the
// texture flipped on WebGL as the control.
//
// @purpose The reusable steps and decision for a paused-video parity cell in the Sandcastle2 run frame: in-frame dials that fix an image material's repeat and clear the scene behind its surface to one background colour, the pause-and-seek, the wait for scene frames, the top page's console collapse that keeps the run frame's canvas one size on both renderers, the box check against that background, the capture of one cell, and the orientation and content-parity verdicts computed in Node from a run's captures.
// @status ACTIVE
//
// WHAT THE CELL ASKS. Whether the WebGPU renderer shows a video texture the
// same way up, with the same content, as WebGL. A playing video cannot answer
// that (two captures are never the same frame), so the cell pauses the element
// at one `currentTime` on every capture. The demo tiles the video with a
// `CallbackProperty` repeat; the dials replace it with a constant one, so the
// parity captures show the video once, and the control capture (WebGL only)
// samples it at repeat (1, -1). WebGL's Image material samples
// `fract(repeat * st)`, so that control flips the TEXTURE on identical
// geometry. Flipping the captured box would flip the geometry with it, so it
// is not the control.
//
// WHY THE CONSOLE IS COLLAPSED. The Sandcastle2 standalone page stacks its
// console pane under the run frame, collapsed to 33 px, and expands it to
// 200 px on the first console message that is not a plain log
// (`AppStandalone.tsx` `appendConsole`, `ViewerConsoleStack.tsx`). Every video
// capture before this cell was 1280x687 on WebGL (720 - 33) and 1280x520 on
// WebGPU (720 - 200). A pixel comparison across renderers needs one canvas
// size, so the cell collapses the console in the top page before it seeks,
// records whether it was expanded and the messages that expanded it, and the
// decision refuses captures whose sizes differ rather than resampling.
//
// WHY THE BACKGROUND. The box must lie wholly inside the textured surface in
// every capture. With the globe, sky, sun and moon hidden over one background
// colour, a box pixel of that colour is a pixel of no surface, which a capture
// can show; aerial imagery behind the surface could not.
//
// WHY A READINESS WAIT. The demo tracks the ellipsoid's entity, and the
// viewer aims the camera at it only once the primitive drawing it is ready.
// Until then the camera keeps its home view, from which the ellipsoid is
// smaller than a pixel, so a capture taken after a fixed number of frames can
// show no surface at all: on Edge, 4 of 9 WebGL captures of this cell did.
// So the cell counts its settle frames only from the first frame at which the
// video material's texture has been adopted from the element, a primitive
// drawing that material reports ready and the scene camera is in a tracking
// transform, with the canvas at one size; the background-in-the-box refusal
// stays as the backstop. The wait first waits, for at most the rig's
// `firstRenderMaxMs`, for the scene's first render: the demo's video plays
// on its own clock, so the video wait and the seek can finish before a
// WebGPU viewer has rendered a frame or created its canvas (on Edge one such
// viewer rendered first 745 ms after the cell reached the wait). Only a scene
// that has not rendered by then refuses the cell.
//
// THE CELL. `captureVideoPausedCell` is one capture of the cell, run by
// `probe-stub-texture-uploads.mjs --scene video-paused` with the probe's own
// video wait, canvas selector and budgets passed in as a kit, and
// `pairVideoPausedCells` decides a run's captures through
// `decideVideoPausedCell`, with the probe's box metric passed in, after the
// last cell. The texture trace is installed through
// `installSceneTextureTraceInFrame`, which waits for the run frame's import
// map before anything imports `cesium` there, and the settle drives the scene
// with the kit's frame driver (`lib/probe-scene-frames.mjs`).
//
// FRAME-SIDE FUNCTIONS are serialised into the run frame, so each is
// self-contained. `frameInstallVideoPausedDials` imports the engine module the
// frame's import map names, wraps `ImageMaterialProperty.prototype.getValue`
// (the repeat) and `Scene.prototype.render` (the scene dials and a frame
// counter), and is idempotent.

import { decodePng } from "../../lib/png-decode.mjs";
import { collectGateErrors } from "../../lib/webgpu-error-gate.mjs";
import {
  ProbeRefusal,
  SCENE_FRAME_DRIVER_GLOBAL,
  captureElement,
  installSceneFrameDriver,
} from "./probe-runtime.mjs";
import { openSandcastle2Url } from "./sandcastle2-renderer-gate.mjs";
import {
  frameReadVideoMaterialState,
  installSceneTextureTraceInFrame,
} from "./stub-texture-trace.mjs";

/** The run-frame global the dials keep their state in. */
export const VIDEO_PAUSED_DIALS_GLOBAL = "__videoPausedDials";

/**
 * Install the paused cell's dials in the run frame: a constant repeat for every
 * image material property, and the scene cleared to one background colour.
 * Runs in the frame; self-contained.
 *
 * @param {{moduleUrl: string, repeat: number[], background: number[]}} args
 *   The engine module specifier, the repeat as `[x, y]`, and the background
 *   colour as `[r, g, b, a]` in 0-1.
 * @returns {Promise<{installed: string[]}>} The methods wrapped.
 */
export async function frameInstallVideoPausedDials({
  moduleUrl,
  repeat,
  background,
}) {
  // __videoPausedDials
  const C = await import(moduleUrl);
  const existing = globalThis.__videoPausedDials;
  if (existing) {
    existing.repeat = repeat;
    return { installed: existing.installed };
  }
  const state = {
    repeat,
    renders: 0,
    scenes: new Set(),
    installed: [],
  };
  globalThis.__videoPausedDials = state;
  const getValue = C.ImageMaterialProperty?.prototype?.getValue;
  if (typeof getValue === "function") {
    C.ImageMaterialProperty.prototype.getValue = function (time, result) {
      const value = getValue.call(this, time, result);
      if (value && Array.isArray(state.repeat)) {
        value.repeat = C.Cartesian2.fromElements(
          state.repeat[0],
          state.repeat[1],
          value.repeat ?? new C.Cartesian2(),
        );
      }
      return value;
    };
    state.installed.push("ImageMaterialProperty.getValue");
  }
  const render = C.Scene?.prototype?.render;
  if (typeof render === "function") {
    C.Scene.prototype.render = function (...args) {
      if (!state.scenes.has(this)) {
        state.scenes.add(this);
        if (this.globe) {
          this.globe.show = false;
        }
        for (const name of ["skyBox", "skyAtmosphere", "sun", "moon"]) {
          if (this[name]) {
            this[name].show = false;
          }
        }
        if (this.fog) {
          this.fog.enabled = false;
        }
        this.backgroundColor = new C.Color(
          background[0],
          background[1],
          background[2],
          background[3],
        );
      }
      const result = render.apply(this, args);
      state.renders += 1;
      return result;
    };
    state.installed.push("Scene.render");
  }
  return { installed: state.installed };
}

/**
 * Pause the element, seek it to `seconds`, and wait for the seek to land with
 * the frame's data. Runs in the frame; self-contained.
 *
 * @param {{elementId: string, seconds: number, timeoutMs: number}} args
 * @returns {Promise<object>} Whether it landed, and the element's state.
 */
export async function frameSeekPausedVideo({ elementId, seconds, timeoutMs }) {
  // __videoPausedSeek
  const element = document.getElementById(elementId);
  if (!element) {
    return { ok: false, found: false };
  }
  element.pause();
  const landed = new Promise((resolve) => {
    element.addEventListener("seeked", () => resolve(true), { once: true });
  });
  element.currentTime = seconds;
  const timedOut = new Promise((resolve) =>
    setTimeout(() => resolve(false), timeoutMs),
  );
  const seeked = await Promise.race([landed, timedOut]);
  const started = performance.now();
  while (element.readyState < 2 && performance.now() - started < timeoutMs) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return {
    ok: seeked && element.paused && element.readyState >= 2,
    found: true,
    seeked,
    paused: element.paused,
    currentTime: element.currentTime,
    readyState: element.readyState,
    videoWidth: element.videoWidth,
    videoHeight: element.videoHeight,
  };
}

/**
 * Wait until the paused surface has been drawn. Drives the scene with the
 * kit's frame driver (installed under `driverGlobal`) and ends when, on each
 * of `settleFrames` consecutive scene frames at one canvas size, all three
 * readiness conditions hold:
 *   - `textureAdopted`: a video material's `_textures` entry for the video
 *     uniform is at least 2x2 (adopted from the element, not the 1x1 default
 *     texture it holds before the video has a frame);
 *   - `primitiveReady`: a primitive drawing that material reports `ready`;
 *   - `cameraTracking`: the scene camera's transform is not the identity,
 *     which the demo's tracked entity sets once the viewer aims at it.
 * A condition that lapses restarts the count. Before driving, it waits for
 * the scene's first render (the dials record a scene when it first renders)
 * for at most `firstRenderMs`, bounded by `deadlineMs`; a scene that has
 * not rendered by then ends the wait with `no-scene-rendered`. The drive
 * then has what is left of `deadlineMs`. Runs in the frame; self-contained.
 *
 * @param {{driverGlobal: string, settleFrames: number, maxFrames: number, deadlineMs: number, firstRenderMs: number, selector: string}} args
 * @returns {Promise<object>} Whether it held, how long the first render took
 *   to arrive, how the drive ended, the frame at which the readiness that held
 *   began, the canvas size and the last readiness reading.
 */
export async function frameAwaitPausedSurfaceDrawn({
  driverGlobal,
  settleFrames,
  maxFrames,
  deadlineMs,
  firstRenderMs,
  selector,
}) {
  // __videoPausedSurfaceDrawn
  const started = performance.now();
  const trace = globalThis.__sceneTextureTrace;
  const drive = globalThis[driverGlobal];
  if (!trace || typeof drive !== "function") {
    return {
      ok: false,
      reason: !trace ? "trace-not-installed" : "driver-not-installed",
    };
  }
  const renderedScene = () => {
    const dials = globalThis.__videoPausedDials;
    return dials ? [...dials.scenes][0] : undefined;
  };
  const firstRenderBoundMs = Number.isFinite(firstRenderMs)
    ? Math.max(0, Math.min(firstRenderMs, deadlineMs))
    : 0;
  let scene = renderedScene();
  const firstRender = { renderedAtEntry: scene !== undefined };
  while (!scene && performance.now() - started < firstRenderBoundMs) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    scene = renderedScene();
  }
  firstRender.waitedMs = Math.round(performance.now() - started);
  firstRender.boundMs = firstRenderBoundMs;
  if (!scene) {
    return { ok: false, reason: "no-scene-rendered", firstRender };
  }
  const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  const read = () => {
    let textureAdopted = false;
    let primitiveReady = false;
    for (const material of trace.videoMaterials ?? []) {
      for (const [key, value] of Object.entries(material.uniforms ?? {})) {
        if (
          typeof HTMLVideoElement === "undefined" ||
          !(value instanceof HTMLVideoElement)
        ) {
          continue;
        }
        const texture = material._textures?.[key];
        if (!texture || texture.width < 2 || texture.height < 2) {
          continue;
        }
        textureAdopted = true;
        for (const primitive of trace.videoPrimitives ?? []) {
          if (
            primitive.appearance?.material === material &&
            primitive.ready === true
          ) {
            primitiveReady = true;
          }
        }
      }
    }
    const transform = scene.camera?.transform;
    const cameraTracking =
      transform !== undefined &&
      identity.some((value, index) => transform[index] !== value);
    const canvas = document.querySelector(selector);
    return {
      textureAdopted,
      primitiveReady,
      cameraTracking,
      canvas: canvas ? [canvas.width, canvas.height] : null,
    };
  };
  let readyFrom = null;
  let lastSize = null;
  let stableFrom = 0;
  let last = null;
  const run = await drive(scene, {
    onFrame(frame) {
      last = read();
      const size = last.canvas;
      if (
        !size ||
        !lastSize ||
        size[0] !== lastSize[0] ||
        size[1] !== lastSize[1]
      ) {
        lastSize = size;
        stableFrom = frame;
      }
      if (!(
        last.textureAdopted &&
        last.primitiveReady &&
        last.cameraTracking
      )) {
        readyFrom = null;
        return false;
      }
      readyFrom ??= frame;
      return (
        frame - readyFrom >= settleFrames && frame - stableFrom >= settleFrames
      );
    },
    maxFrames,
    deadlineMs: Math.max(0, deadlineMs - (performance.now() - started)),
  });
  return {
    ok: run.outcome === "done",
    firstRender,
    drive: run,
    readyFromFrame: readyFrom,
    canvas: lastSize,
    readiness: last,
  };
}

/**
 * Collapse the Sandcastle2 standalone page's console pane if it is expanded,
 * and report what it held. Runs in the top page; self-contained.
 *
 * @returns {object} Whether the pane was found and expanded, whether it is
 *   collapsed now, and the first few warnings and errors it shows.
 */
export function pageCollapseSandcastleConsole() {
  // __collapseSandcastleConsole
  const mirror = document.querySelector(".console-mirror");
  if (!mirror) {
    return { found: false };
  }
  const messages = [...mirror.querySelectorAll(".message")]
    .map((node) => node.textContent ?? "")
    .slice(0, 5);
  const wasExpanded = mirror.classList.contains("expanded");
  if (wasExpanded) {
    // The header's own handler toggles once; its title span carries a second
    // handler, so the click goes to the header element itself.
    mirror.querySelector(".console-snapshot")?.click();
  }
  return {
    found: true,
    wasExpanded,
    messages,
  };
}

/**
 * Whether the console pane is expanded now. Runs in the top page.
 *
 * @returns {boolean|null} Null when the page has no console pane.
 */
export function pageSandcastleConsoleExpanded() {
  const mirror = document.querySelector(".console-mirror");
  return mirror ? mirror.classList.contains("expanded") : null;
}

/**
 * The paused cell's box: a square whose side is `sideFraction` of the frame's
 * shorter side, centred at (`centerX`, `centerY`) as fractions of the frame.
 *
 * @param {{width: number, height: number}} image The frame.
 * @param {{sideFraction: number, centerX: number, centerY: number}} spec
 * @returns {{x0: number, y0: number, x1: number, y1: number}} Half-open box.
 */
export function pausedBox({ width, height }, spec) {
  const side = Math.max(
    1,
    Math.round(Math.min(width, height) * spec.sideFraction),
  );
  const x0 = Math.max(0, Math.round(width * spec.centerX - side / 2));
  const y0 = Math.max(0, Math.round(height * spec.centerY - side / 2));
  return {
    x0,
    y0,
    x1: Math.min(width, x0 + side),
    y1: Math.min(height, y0 + side),
  };
}

/**
 * How many pixels inside a box are the background colour, within `tolerance`
 * per channel.
 *
 * @param {{width: number, data: ArrayLike<number>}} image A decoded frame.
 * @param {{x0: number, y0: number, x1: number, y1: number}} box The box.
 * @param {number[]} background The background as `[r, g, b, a]` in 0-1.
 * @param {number} tolerance Per-channel tolerance in 0-255.
 * @returns {number} The background pixels in the box.
 */
export function backgroundPixelsInBox(image, box, background, tolerance) {
  const target = background.slice(0, 3).map((value) => value * 255);
  let count = 0;
  for (let y = box.y0; y < box.y1; y++) {
    for (let x = box.x0; x < box.x1; x++) {
      const i = (y * image.width + x) * 4;
      if (
        Math.abs(image.data[i] - target[0]) <= tolerance &&
        Math.abs(image.data[i + 1] - target[1]) <= tolerance &&
        Math.abs(image.data[i + 2] - target[2]) <= tolerance
      ) {
        count += 1;
      }
    }
  }
  return count;
}

/**
 * Decide the paused cell from its four captures, in Node.
 *
 * `d(X, Y)` is `changedFraction` from the probe's `boxSpreadAndChange` (passed
 * in, as the census comparison takes it) over the box at its default
 * tolerance. The rules, registered before any AFTER run:
 *   - the control separates when `d(L1, F) >= controlMin`; otherwise the cell
 *     is void and is re-run;
 *   - orientation HOLDS when `d(G, F) >= d(G, L1) + orientationMargin`;
 *   - content parity HOLDS when `d(G, L1) <= 2 * d(L1, L2) + parityFloor`.
 *
 * @param {Object<string, {width: number, height: number, data: ArrayLike<number>}>} images
 *   Decoded captures by tag: `L1`, `L2` and `F` (WebGL) and `G` (WebGPU).
 * @param {object} spec The rig's paused dials: `box`, `background`,
 *   `backgroundTolerance` and `rules`.
 * @param {{boxSpreadAndChange: Function}} kit The probe's box metric.
 * @returns {object} The sizes, the box, each capture's background pixels in
 *   it, the four distances and the verdicts.
 * @throws {ProbeRefusal} `capture-size-mismatch` when the captures differ in
 *   size, or `paused-box-outside-surface` when a capture shows background in
 *   the box.
 */
export function decideVideoPausedCell(images, spec, { boxSpreadAndChange }) {
  const tags = Object.keys(images);
  const sizes = Object.fromEntries(
    tags.map((tag) => [tag, [images[tag].width, images[tag].height]]),
  );
  const first = images[tags[0]];
  if (
    tags.some(
      (tag) =>
        images[tag].width !== first.width ||
        images[tag].height !== first.height,
    )
  ) {
    throw new ProbeRefusal(
      "capture-size-mismatch",
      "video-paused: the captures differ in size across the cell, so they cannot be compared pixel for pixel",
      { sizes },
    );
  }
  const box = pausedBox(first, spec.box);
  const backgroundPixels = Object.fromEntries(
    tags.map((tag) => [
      tag,
      backgroundPixelsInBox(
        images[tag],
        box,
        spec.background,
        spec.backgroundTolerance,
      ),
    ]),
  );
  if (Object.values(backgroundPixels).some((count) => count > 0)) {
    throw new ProbeRefusal(
      "paused-box-outside-surface",
      "video-paused: a capture shows background inside the box, so the box is not wholly on the textured surface",
      { box, backgroundPixels, sizes },
    );
  }
  const complete = ["L1", "L2", "F", "G"].every((tag) => images[tag]);
  if (!complete) {
    return {
      box,
      sizes,
      backgroundPixels,
      verdict: "incomplete",
      missing: ["L1", "L2", "F", "G"].filter((tag) => !images[tag]),
    };
  }
  const d = (a, b) =>
    boxSpreadAndChange(images[a], images[b], box).changedFraction;
  const distances = {
    gF: d("G", "F"),
    gL1: d("G", "L1"),
    l1L2: d("L1", "L2"),
    l1F: d("L1", "F"),
  };
  const { controlMin, orientationMargin, parityFloor } = spec.rules;
  const controlSeparates = distances.l1F >= controlMin;
  const orientation =
    distances.gF >= distances.gL1 + orientationMargin ? "HOLDS" : "FAILS";
  const contentParity =
    distances.gL1 <= 2 * distances.l1L2 + parityFloor ? "HOLDS" : "FAILS";
  return {
    box,
    sizes,
    backgroundPixels,
    distances,
    rules: spec.rules,
    controlSeparates,
    orientation: controlSeparates ? orientation : "VOID",
    contentParity: controlSeparates ? contentParity : "VOID",
    verdict: !controlSeparates
      ? "void-control-does-not-separate"
      : orientation === "HOLDS" && contentParity === "HOLDS"
        ? "HOLDS"
        : "FAILS",
  };
}

/** Where a paused cell keeps its decoded capture for the run's decision. */
const PAUSED_IMAGE = Symbol("pausedImage");

/**
 * One capture of the paused cell: the demo with the paused dials installed,
 * the console pane collapsed, the video held at one time and the scene's
 * frames settled at one canvas size, then one element capture of the scene
 * canvas. The decoded capture stays on the record under a symbol, which the
 * receipt does not serialise, for `decideVideoPausedCell`.
 *
 * @param {object} args The probe's cell arguments (page, origin, options,
 *   cell, run, outputDirectory, captures, budget).
 * @param {object} kit The probe's pieces: `frameAwaitVideo`, `canvasSelector`
 *   and its navigation, video-play and page-deadline budgets.
 * @returns {Promise<object>} The cell record.
 */
export async function captureVideoPausedCell(
  { page, origin, options, cell, run, outputDirectory, captures, budget },
  kit,
) {
  const { rig, paused } = cell;
  const dials = rig.dials.paused;
  const seconds = options.pausedSeconds ?? dials.currentTimeSeconds;
  const base = new URL(origin);
  const opened = await budget.bound("opening the demo", () =>
    openSandcastle2Url(
      page,
      {
        base: origin,
        bucketBase: `${base.protocol}//${base.hostname}:${options.sandcastlePort ?? Number(base.port) + 1}`,
        id: rig.dials.galleryId,
        renderer: cell.renderer,
        standalone: true,
      },
      { timeoutMs: Math.min(kit.navigationBudgetMs, budget.remainingMs()) },
    ),
  );
  const frame = opened.bucketFrame;
  const traceInstalled = await budget.bound(
    "installing the texture trace",
    () =>
      installSceneTextureTraceInFrame(frame, {
        moduleUrl: "cesium",
        timeoutMs: Math.min(kit.navigationBudgetMs, budget.remainingMs()),
      }),
  );
  const repeat = paused.control ? dials.controlRepeat : dials.repeat;
  const dialsInstalled = await budget.bound("installing the paused dials", () =>
    frame.evaluate(frameInstallVideoPausedDials, {
      moduleUrl: "cesium",
      repeat,
      background: dials.background,
    }),
  );
  const video = await budget.bound("the wait for the video", () =>
    frame.evaluate(kit.frameAwaitVideo, {
      elementId: rig.dials.videoElementId,
      minSeconds: rig.dials.minVideoSeconds,
      timeoutMs: Math.min(
        kit.videoPlayBudgetMs,
        Math.max(0, budget.remainingMs() - kit.pageDeadlineMarginMs),
      ),
    }),
  );
  if (!video.ok) {
    throw new ProbeRefusal(
      "video-not-playing",
      `video-paused on ${cell.renderer}: the demo's video did not play ${rig.dials.minVideoSeconds} s (no network access to cesium.com is the usual cause)`,
      { video },
    );
  }
  const consolePane = await budget.bound("collapsing the console", () =>
    page.evaluate(pageCollapseSandcastleConsole),
  );
  const seek = await budget.bound("the pause and seek", () =>
    frame.evaluate(frameSeekPausedVideo, {
      elementId: rig.dials.videoElementId,
      seconds,
      timeoutMs: Math.min(
        dials.seekTimeoutMs,
        Math.max(0, budget.remainingMs() - kit.pageDeadlineMarginMs),
      ),
    }),
  );
  if (!seek.ok) {
    throw new ProbeRefusal(
      "video-seek-did-not-land",
      `video-paused on ${cell.renderer}: the video did not pause at ${seconds} s with a frame's data`,
      { seek },
    );
  }
  await budget.bound("installing the frame driver", () =>
    installSceneFrameDriver(frame),
  );
  const settled = await budget.bound("the wait for the drawn surface", () =>
    frame.evaluate(frameAwaitPausedSurfaceDrawn, {
      driverGlobal: SCENE_FRAME_DRIVER_GLOBAL,
      settleFrames: dials.settleFrames,
      maxFrames: dials.readyMaxFrames,
      deadlineMs: Math.max(0, budget.remainingMs() - kit.pageDeadlineMarginMs),
      firstRenderMs: dials.firstRenderMaxMs,
      selector: kit.canvasSelector,
    }),
  );
  if (!settled.ok) {
    throw new ProbeRefusal(
      "paused-surface-not-drawn",
      `video-paused on ${cell.renderer}: the surface was not drawn for ${dials.settleFrames} frames at one canvas size (texture adopted, primitive ready, camera tracking) before the frame cap or the deadline, or the scene did not render within ${dials.firstRenderMaxMs} ms`,
      { settled },
    );
  }
  const consoleExpandedAtCapture = await budget.bound(
    "reading the console pane",
    () => page.evaluate(pageSandcastleConsoleExpanded),
  );
  const shot = await budget.bound("the capture", () =>
    captureElement({
      page: frame,
      selector: kit.canvasSelector,
      name: `video-paused-${paused.tag}-${cell.renderer}-run${run}`,
      outputDirectory,
      captures,
    }),
  );
  opened.assertNoOriginBreach();
  return {
    paused: { tag: paused.tag, control: paused.control, repeat, seconds },
    video,
    seek,
    settled,
    console: { ...consolePane, expandedAtCapture: consoleExpandedAtCapture },
    dialsInstalled: dialsInstalled.installed,
    capture: { name: shot.name, sha256: shot.sha256 },
    trace: {
      installed: traceInstalled.installed,
      importMap: traceInstalled.importMap,
      videoMaterials: await budget.bound("reading the video materials", () =>
        frame.evaluate(frameReadVideoMaterialState),
      ),
    },
    gate: await budget.bound("reading the error gate", () =>
      collectGateErrors(frame),
    ),
    [PAUSED_IMAGE]: decodePng(shot.buffer),
  };
}

/**
 * Decide the paused cell over a run's records, when it has any: the captures
 * by tag, through `decideVideoPausedCell` and the rig's rules.
 *
 * @param {Array<object>} records The run's cell records.
 * @param {object} spec The rig's paused dials.
 * @param {{boxSpreadAndChange: Function}} metric The probe's box metric.
 * @returns {object|null} The paused pair, or null when the run had no paused
 *   cell.
 */
export function pairVideoPausedCells(records, spec, metric) {
  const images = {};
  for (const record of records) {
    if (record.scene === "video-paused" && record[PAUSED_IMAGE]) {
      images[record.paused.tag] = record[PAUSED_IMAGE];
    }
  }
  if (Object.keys(images).length === 0) {
    return null;
  }
  return {
    scene: "video-paused",
    ...decideVideoPausedCell(images, spec, metric),
  };
}
