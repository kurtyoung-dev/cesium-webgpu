#!/usr/bin/env node
// Probe: the two texture paths the WebGPU renderer serves through the WebGL
// compatibility stub that a scene can watch go blank - a label glyph atlas
// that grows in a later frame, and a video texture whose element has no width
// attribute.
// @purpose Captures the label-atlas growth rig (texture-atlas-label-growth) and the Sandcastle2 Video demo rig (sandcastle2-video) on both renderers, with the atlas size before and after its growth, each half's lit fraction, the video element's sizes and the central box's spread and motion, and the WebGPU error gate; and, when named, the framebuffer census on WebGPU (the CesiumViewer opening view with its clock pinned, with MSAA, pickPosition or a translucent rectangle, and a model with shadows and image-based lighting, each cell's clock pinned and its tiles settled through the determinism kit), with each Framebuffer.js consumer's attachments, copies, blits and teardowns counted and the three-run comparison of its captures.
// @status ACTIVE
// @runtime lib/probe-runtime.mjs
//
// WHAT EACH SCENE ASKS.
//   atlas - whether the glyphs added in the FIRST batch are still drawn after
//           the glyph atlas grew to take the second. A `TextureAtlas` grows in
//           a scene's after-render callbacks and copies its existing images
//           into the larger texture there. The first batch is the top half of
//           the frame, the second the bottom half; `halfLitFractions` reads
//           each. The steps are `lib/label-atlas-growth-steps.mjs`, which
//           refuses a run whose atlas did not grow between the batches.
//   video - whether the ellipsoid the demo textures with a playing video shows
//           the video. The demo's `<video>` has no width or height attribute,
//           so its `width`/`height` read 0 while `videoWidth`/`videoHeight`
//           are the frame size; the cell records all four. A blank surface is
//           a central box with little spread and no change between two
//           captures 1.5 s apart.
//   framebuffer-census - only when named, WebGPU only. Each census cell
//           (`lib/framebuffer-census-steps.mjs`) is a registry rig plus dials,
//           settled and captured, with the engine receipt's framebuffer
//           events and the scene-layer `Framebuffer.js` counters
//           (`pageInstallFramebufferCensusTrace`) beside the capture. Two
//           BEFORE runs and one AFTER run are compared with
//           `--census-compare <before1> <before2> <after>`, which reads the
//           three output directories and writes no capture.
//
// WHY THE VIDEO SCENE IS HERE AND NOT IN lib/capture.mjs. The demo runs in the
// Sandcastle2 run frame. `capture.mjs` navigates the top-level page only, so it
// can neither follow the app's origin redirect nor reach a canvas inside the
// run frame; `openSandcastle2Url` does both under the origin guard.
//
// THE ERROR GATE. `Tools/lib/webgpu-error-gate.mjs` is installed in every
// frame before any page script; a WebGPU device is armed as soon as it is
// requested (the Sandcastle2 demo keeps its viewer in a local, so the gate's
// viewer walk cannot reach it), and each cell records the uncaptured errors
// and any device loss.
//
// FRAMES AND THE CELL BUDGET. The CesiumViewer page runs in request-render
// mode, so the atlas steps drive their frames through the runtime's frame
// driver (`installSceneFrameDriver` / `driveSceneFrames`), which requests the
// next render from every frame and ends at a wall-clock deadline. Every
// browser call a cell makes is bounded by the cell's budget
// (`createCellBudget`), so a page that stops answering refuses the cell by
// name (`atlas-steps-did-not-finish` from the driver's own deadline, or
// `cell-over-budget` from the bound) instead of running to the run's orderly
// deadline. The video demo renders continuously and waits on the video's own
// clock with a timeout, so it needs no driver; its calls are bounded the same
// way.
//
// Usage: node Tools/visual-regression/probe-stub-texture-uploads.mjs
//   [--port 8094] [--sandcastle-port 8095]
//   [--scene atlas,video|framebuffer-census]
//   [--renderer both|webgl|webgpu] [--runs N]
//   [--census-settle-frames N] (a census cell's settle, instead of its rig's)
//        node Tools/visual-regression/probe-stub-texture-uploads.mjs
//   --census-compare <before1-dir> <before2-dir> <after-dir>
// Outputs: Tools/visual-regression/output/stub-texture-uploads/

import { attachPageDiagnostics } from "../lib/attach-page-diagnostics.mjs";
import { decodePng } from "../lib/png-decode.mjs";
import {
  armWebGPUDevices,
  collectGateErrors,
  errorGateInit,
} from "../lib/webgpu-error-gate.mjs";
import { captureUrlFor } from "./lib/capture.mjs";
import { DET_BROWSER_SETUP } from "./lib/determinism-kit.mjs";
import {
  CENSUS_MAX_FRAMES,
  FRAMEBUFFER_CENSUS_CELLS,
  CENSUS_TILE_SETTLE,
  censusCaptureName,
  compareFramebufferCensusRuns,
  decideCensusRun,
  pageRunFramebufferCensus,
  requireCensusClock,
} from "./lib/framebuffer-census-steps.mjs";
import {
  decideAtlasGrowth,
  halfLitFractions,
  pageRunLabelAtlasGrowth,
} from "./lib/label-atlas-growth-steps.mjs";
import {
  ProbeRefusal,
  SCENE_FRAME_DRIVER_GLOBAL,
  captureElement,
  installSceneFrameDriver,
  isEntryPoint,
  runProbe,
} from "./lib/probe-runtime.mjs";
import { openSandcastle2Url } from "./lib/sandcastle2-renderer-gate.mjs";
import {
  copySourceDestroyOrder,
  frameReadVideoMaterialState,
  pageInstallFramebufferCensusTrace,
  pageInstallSceneTextureTrace,
  pageReadFramebufferCensusTrace,
  pageReadLabelAtlasState,
  pageReadStubTextureTrace,
  stubTextureTraceInit,
} from "./lib/stub-texture-trace.mjs";
import { STRIP_WIDGETS_SOURCE } from "./lib/strip-viewer-widgets.mjs";
import CENSUS_GLOBE_RIG from "./rigs/framebuffer-census-globe.mjs";
import CENSUS_MODEL_RIG from "./rigs/framebuffer-census-model-shadows-ibl.mjs";
import ATLAS_RIG from "./rigs/texture-atlas-label-growth.mjs";
import VIDEO_RIG from "./rigs/sandcastle2-video.mjs";

/** The probe's two scenes, by `--scene` name. */
export const STUB_TEXTURE_SCENES = Object.freeze({
  atlas: ATLAS_RIG,
  video: VIDEO_RIG,
  "framebuffer-census": CENSUS_GLOBE_RIG,
});

/** The census cells' rigs, by id. */
const CENSUS_RIGS = Object.freeze({
  [CENSUS_GLOBE_RIG.id]: CENSUS_GLOBE_RIG,
  [CENSUS_MODEL_RIG.id]: CENSUS_MODEL_RIG,
});

/** Scenes a run captures only when `--scene` names them. */
const NAMED_ONLY_SCENES = Object.freeze(["framebuffer-census"]);

/** Every scene, in the order a run captures them. */
export const DEFAULT_SCENES = Object.freeze(["atlas", "video"]);

/** The encoder label of the stub's off-frame copies (the atlas growth's). */
const OFF_FRAME_COPY_LABEL = "GLStub_OffFrameTextureCopy";

/** The engine module the CesiumViewer page loads and the steps import. */
const CESIUM_MODULE_URL = "/Build/CesiumUnminified/index.js";

/** The scene canvas, on the CesiumViewer page and in the Sandcastle2 frame. */
const CANVAS_SELECTOR = ".cesium-widget canvas";

/** The frame count past which the atlas steps give up. */
const ATLAS_MAX_FRAMES = 600;

/** Per-channel tolerance for the video box's change between captures. */
const CHANGE_TOLERANCE = 16;

/** How long the video may take to reach its first played second. */
const VIDEO_PLAY_BUDGET_MS = 60_000;

/** Navigation plus the wait for the viewer or the run frame. */
const NAVIGATION_BUDGET_MS = 120_000;
/** The atlas steps, the video settle and both captures. */
const SETTLE_BUDGET_MS = 120_000;
/** What one cell (one scene on one renderer) may take. */
const CELL_BUDGET_MS = NAVIGATION_BUDGET_MS + SETTLE_BUDGET_MS;
/**
 * How much earlier than the cell's budget the in-page frame driver's own
 * deadline falls, so a stalled scene answers with its trace before the Node
 * side's bound gives up on the call.
 */
const PAGE_DEADLINE_MARGIN_MS = 10_000;

/**
 * A cell's wall-clock budget, shared by every browser call the cell makes.
 *
 * WHY. Playwright gives `page.evaluate` no timeout, so a page function whose
 * promise never settles holds the cell until the run's orderly deadline ends
 * the whole run with no cell record; an Edge run of this probe spent twenty
 * minutes that way. Every browser call a cell makes goes through `bound`,
 * which races it against what is left of the budget and refuses by name
 * (`cell-over-budget`) when the budget runs out first. The losing call fails
 * when the cell's browser context closes; the race has already subscribed
 * to it, so that rejection cannot surface as an unhandled one.
 *
 * @param {object} options Options.
 * @param {string} options.scene The cell's scene.
 * @param {string} options.renderer The cell's renderer.
 * @param {number} options.budgetMs What the whole cell may take.
 * @param {() => number} [options.now] Clock, in milliseconds.
 * @returns {{remainingMs: () => number,
 *   bound: (step: string, work: () => unknown) => Promise<unknown>}} The
 *   remaining budget and the bounded call.
 */
export function createCellBudget({
  scene,
  renderer,
  budgetMs,
  now = Date.now,
}) {
  const deadline = now() + budgetMs;
  const remainingMs = () => Math.max(0, deadline - now());
  const refusal = (step, remainingAtStart) =>
    new ProbeRefusal(
      "cell-over-budget",
      `${scene} on ${renderer}: ${step} had not returned when the cell's ${budgetMs} ms budget ran out`,
      { scene, renderer, step, budgetMs, remainingAtStart },
    );
  return {
    remainingMs,
    async bound(step, work) {
      const remaining = remainingMs();
      if (remaining <= 0) {
        throw refusal(step, 0);
      }
      const pending = Promise.resolve().then(work);
      let timer = null;
      const expired = new Promise((resolve, reject) => {
        timer = setTimeout(() => reject(refusal(step, remaining)), remaining);
      });
      try {
        return await Promise.race([pending, expired]);
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

/**
 * An init script, run in every frame before its scripts: arm each WebGPU
 * device with the error gate the moment it is created.
 */
function armDevicesOnRequest() {
  const adapterPrototype = globalThis.GPUAdapter?.prototype;
  if (!adapterPrototype || adapterPrototype.__stubTextureArmed) {
    return;
  }
  adapterPrototype.__stubTextureArmed = true;
  const requestDevice = adapterPrototype.requestDevice;
  adapterPrototype.requestDevice = async function (...args) {
    const device = await requestDevice.apply(this, args);
    globalThis.__armWebGPUDevice?.(device, "webgpu");
    return device;
  };
}

/**
 * Plan one run's cells: each requested scene on each requested renderer, in
 * the canonical scene order whatever order `--scene` named them in.
 *
 * @param {{scene?: string, renderers: string[]}} options Parsed options.
 * @returns {Array<{scene: string, rig: object, renderer: string}>} The cells.
 * @throws {TypeError} For a scene that is not atlas or video.
 */
export function planStubTextureCells({ scene, renderers } = {}) {
  const names = String(scene ?? DEFAULT_SCENES.join(","))
    .split(",")
    .map((name) => name.trim().toLowerCase())
    .filter((name) => name.length > 0);
  if (names.length === 0) {
    throw new TypeError(
      "--scene needs at least one of atlas, video, framebuffer-census",
    );
  }
  for (const name of names) {
    if (!Object.hasOwn(STUB_TEXTURE_SCENES, name)) {
      throw new TypeError(
        `--scene must name atlas, video or framebuffer-census (got "${name}")`,
      );
    }
  }
  const cells = [];
  for (const name of [...DEFAULT_SCENES, ...NAMED_ONLY_SCENES].filter((each) =>
    names.includes(each),
  )) {
    if (name === "framebuffer-census") {
      if (renderers.includes("webgpu")) {
        for (const census of FRAMEBUFFER_CENSUS_CELLS) {
          const rig = CENSUS_RIGS[census.rig];
          cells.push({ scene: name, rig, renderer: "webgpu", census });
        }
      }
      continue;
    }
    const rig = STUB_TEXTURE_SCENES[name];
    for (const renderer of renderers) {
      if (rig.renderers.includes(renderer)) {
        cells.push({ scene: name, rig, renderer });
      }
    }
  }
  return cells;
}

/**
 * The square box centred in a frame whose side is `fraction` of the frame's
 * shorter side.
 *
 * @param {{width: number, height: number}} image The frame.
 * @param {number} fraction The box side as a fraction of the shorter side.
 * @returns {{x0: number, y0: number, x1: number, y1: number}} Half-open box.
 */
export function centerBox({ width, height }, fraction) {
  const side = Math.max(1, Math.round(Math.min(width, height) * fraction));
  const x0 = Math.floor((width - side) / 2);
  const y0 = Math.floor((height - side) / 2);
  return { x0, y0, x1: x0 + side, y1: y0 + side };
}

/**
 * The luminance spread inside a box, and how many of its pixels changed by
 * more than `tolerance` in any channel between two frames of the same size.
 *
 * @param {{width: number, data: ArrayLike<number>}} first The first frame.
 * @param {{width: number, data: ArrayLike<number>}} second The second frame.
 * @param {{x0: number, y0: number, x1: number, y1: number}} box The box.
 * @param {number} [tolerance] Per-channel change tolerance.
 * @returns {{lumaStdDev: number, changedFraction: number}} The box's spread in
 *   the first frame and its changed fraction.
 */
export function boxSpreadAndChange(
  first,
  second,
  box,
  tolerance = CHANGE_TOLERANCE,
) {
  let count = 0;
  let sum = 0;
  let sumSquares = 0;
  let changed = 0;
  for (let y = box.y0; y < box.y1; y++) {
    for (let x = box.x0; x < box.x1; x++) {
      const i = (y * first.width + x) * 4;
      const a = first.data;
      const b = second.data;
      const luma = 0.2126 * a[i] + 0.7152 * a[i + 1] + 0.0722 * a[i + 2];
      sum += luma;
      sumSquares += luma * luma;
      count += 1;
      if (
        Math.abs(a[i] - b[i]) > tolerance ||
        Math.abs(a[i + 1] - b[i + 1]) > tolerance ||
        Math.abs(a[i + 2] - b[i + 2]) > tolerance
      ) {
        changed += 1;
      }
    }
  }
  const mean = count > 0 ? sum / count : 0;
  const variance =
    count > 0 ? Math.max(0, sumSquares / count - mean * mean) : 0;
  return {
    lumaStdDev: Math.sqrt(variance),
    changedFraction: count > 0 ? changed / count : 0,
  };
}

/**
 * Wait until the demo's video has played `minSeconds`, and read its sizes.
 * Runs in the Sandcastle2 run frame.
 *
 * @param {{elementId: string, minSeconds: number, timeoutMs: number}} args
 * @returns {Promise<object>} Whether it played, and the element's sizes.
 */
export async function frameAwaitVideo({ elementId, minSeconds, timeoutMs }) {
  // __stubTextureAwaitVideo
  const started = performance.now();
  const read = () => {
    const element = document.getElementById(elementId);
    if (!element) {
      return { found: false };
    }
    return {
      found: true,
      widthAttribute: element.getAttribute("width"),
      heightAttribute: element.getAttribute("height"),
      width: element.width,
      height: element.height,
      videoWidth: element.videoWidth,
      videoHeight: element.videoHeight,
      readyState: element.readyState,
      currentTime: element.currentTime,
      paused: element.paused,
    };
  };
  for (;;) {
    const state = read();
    if (
      state.found &&
      state.readyState >= 2 &&
      state.currentTime >= minSeconds
    ) {
      return { ok: true, ...state };
    }
    if (performance.now() - started > timeoutMs) {
      return { ok: false, ...state };
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

/**
 * Accept the viewer-chrome strip's report, or refuse the cell: an element
 * capture composites whatever is stacked over the canvas.
 *
 * @param {unknown} report What the strip returned in the page.
 * @param {{scene: string, renderer: string}} cell The cell.
 * @returns {number|null} How many elements were removed.
 * @throws {ProbeRefusal} `capture-chrome-over-canvas`.
 */
export function acceptStrip(report, { scene, renderer }) {
  if (!Array.isArray(report?.leftovers) || report.leftovers.length > 0) {
    throw new ProbeRefusal(
      "capture-chrome-over-canvas",
      `${scene} on ${renderer}: the viewer chrome strip left elements over the scene canvas, or reported none`,
      { scene, renderer, widgets: report ?? null },
    );
  }
  return Number.isFinite(report.removed) ? report.removed : null;
}

/**
 * The atlas scene on one renderer. The viewer chrome is stripped before the
 * steps, so any canvas resize the strip causes is rendered over by the steps'
 * own frames rather than left for a request-render-mode page to skip.
 */
async function captureAtlasCell({
  page,
  origin,
  cell,
  run,
  outputDirectory,
  captures,
  budget,
}) {
  const { rig } = cell;
  const url = new URL(captureUrlFor({ rig, origin }));
  url.searchParams.set("renderer", cell.renderer);
  await budget.bound("navigation", () =>
    page.goto(url.href, {
      waitUntil: "load",
      timeout: Math.min(NAVIGATION_BUDGET_MS, budget.remainingMs()),
    }),
  );
  await budget.bound("the wait for the viewer", () =>
    page.waitForFunction(() => !!globalThis.viewer, null, {
      timeout: Math.min(NAVIGATION_BUDGET_MS, budget.remainingMs()),
    }),
  );
  await budget.bound("arming the error gate", () => armWebGPUDevices(page));
  const removed = acceptStrip(
    await budget.bound("the viewer chrome strip", () =>
      page.evaluate(`(${STRIP_WIDGETS_SOURCE})()`),
    ),
    cell,
  );
  await budget.bound("installing the frame driver", () =>
    installSceneFrameDriver(page),
  );
  const traceInstalled = await budget.bound(
    "installing the texture trace",
    () =>
      page.evaluate(pageInstallSceneTextureTrace, {
        moduleUrl: CESIUM_MODULE_URL,
      }),
  );
  const growth = await budget.bound("the label atlas steps", () =>
    page.evaluate(pageRunLabelAtlasGrowth, {
      moduleUrl: CESIUM_MODULE_URL,
      hideScene: rig.dials.hideScene,
      font: rig.dials.font,
      batches: rig.dials.batches,
      camera: rig.camera,
      settleFrames: rig.readiness.frames,
      maxFrames: ATLAS_MAX_FRAMES,
      deadlineMs: Math.max(0, budget.remainingMs() - PAGE_DEADLINE_MARGIN_MS),
      driverGlobal: SCENE_FRAME_DRIVER_GLOBAL,
    }),
  );
  const atlas = decideAtlasGrowth(growth);
  const shot = await budget.bound("the capture", () =>
    captureElement({
      page,
      selector: CANVAS_SELECTOR,
      name: `atlas-${cell.renderer}-run${run}`,
      outputDirectory,
      captures,
    }),
  );
  const image = decodePng(shot.buffer);
  const record = {
    atlas,
    framesRendered: growth.frames,
    stepsElapsedMs: growth.elapsedMs,
    batchFrames: growth.batchFrames,
    widgetsRemoved: removed,
    capture: { name: shot.name, sha256: shot.sha256 },
    halves: halfLitFractions(image),
    trace: {
      installed: traceInstalled.installed,
      ...(await budget.bound("reading the texture trace", () =>
        page.evaluate(pageReadStubTextureTrace),
      )),
      labelAtlas: await budget.bound("reading the label atlas state", () =>
        page.evaluate(pageReadLabelAtlasState),
      ),
    },
    gate: await budget.bound("reading the error gate", () =>
      collectGateErrors(page),
    ),
  };
  // Whether the texture the growth copied from was destroyed once, after the
  // last of those copies was submitted, from the trace's unsampled counters.
  return {
    ...record,
    copySourceDestroy: copySourceDestroyOrder(
      record.trace.gpu,
      OFF_FRAME_COPY_LABEL,
    ),
  };
}

/** The video scene on one renderer. */
async function captureVideoCell({
  page,
  origin,
  options,
  cell,
  run,
  outputDirectory,
  captures,
  budget,
}) {
  const { rig } = cell;
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
      { timeoutMs: Math.min(NAVIGATION_BUDGET_MS, budget.remainingMs()) },
    ),
  );
  const frame = opened.bucketFrame;
  const traceInstalled = await budget.bound(
    "installing the texture trace",
    () => frame.evaluate(pageInstallSceneTextureTrace, { moduleUrl: "cesium" }),
  );
  const video = await budget.bound("the wait for the video", () =>
    frame.evaluate(frameAwaitVideo, {
      elementId: rig.dials.videoElementId,
      minSeconds: rig.dials.minVideoSeconds,
      timeoutMs: Math.min(
        VIDEO_PLAY_BUDGET_MS,
        Math.max(0, budget.remainingMs() - PAGE_DEADLINE_MARGIN_MS),
      ),
    }),
  );
  if (!video.ok) {
    throw new ProbeRefusal(
      "video-not-playing",
      `video on ${cell.renderer}: the demo's video did not play ${rig.dials.minVideoSeconds} s (no network access to cesium.com is the usual cause)`,
      { video },
    );
  }
  await budget.bound("the settle", () => page.waitForTimeout(rig.readiness.ms));
  const first = await budget.bound("the first capture", () =>
    captureElement({
      page: frame,
      selector: CANVAS_SELECTOR,
      name: `video-${cell.renderer}-run${run}-a`,
      outputDirectory,
      captures,
    }),
  );
  await budget.bound("the wait between captures", () =>
    page.waitForTimeout(rig.dials.secondCaptureDelayMs),
  );
  const second = await budget.bound("the second capture", () =>
    captureElement({
      page: frame,
      selector: CANVAS_SELECTOR,
      name: `video-${cell.renderer}-run${run}-b`,
      outputDirectory,
      captures,
    }),
  );
  opened.assertNoOriginBreach();
  const a = decodePng(first.buffer);
  const b = decodePng(second.buffer);
  if (a.width !== b.width || a.height !== b.height) {
    throw new ProbeRefusal(
      "capture-size-mismatch",
      `video on ${cell.renderer}: the two captures differ in size`,
      { first: [a.width, a.height], second: [b.width, b.height] },
    );
  }
  return {
    video,
    captures: [
      { name: first.name, sha256: first.sha256 },
      { name: second.name, sha256: second.sha256 },
    ],
    centerBox: boxSpreadAndChange(
      a,
      b,
      centerBox(a, rig.dials.centerBoxFraction),
    ),
    trace: {
      installed: traceInstalled.installed,
      ...(await budget.bound("reading the texture trace", () =>
        frame.evaluate(pageReadStubTextureTrace),
      )),
      videoMaterials: await budget.bound("reading the video materials", () =>
        frame.evaluate(frameReadVideoMaterialState),
      ),
    },
    gate: await budget.bound("reading the error gate", () =>
      collectGateErrors(frame),
    ),
  };
}

/**
 * One framebuffer census cell on WebGPU: the rig's page, the census counters
 * installed before the settle, the cell's dials applied, the rig's settle
 * frames driven, one element capture of the scene canvas, and the receipts.
 */
async function captureCensusCell({
  page,
  origin,
  options,
  cell,
  run,
  outputDirectory,
  captures,
  budget,
}) {
  const { rig, census } = cell;
  const clock = requireCensusClock(rig, census);
  const settleFrames = options.censusSettleFrames ?? rig.readiness.frames;
  const url = new URL(captureUrlFor({ rig, origin }));
  url.searchParams.set("renderer", cell.renderer);
  await budget.bound("navigation", () =>
    page.goto(url.href, {
      waitUntil: "load",
      timeout: Math.min(NAVIGATION_BUDGET_MS, budget.remainingMs()),
    }),
  );
  await budget.bound("the wait for the viewer", () =>
    page.waitForFunction(() => !!globalThis.viewer, null, {
      timeout: Math.min(NAVIGATION_BUDGET_MS, budget.remainingMs()),
    }),
  );
  await budget.bound("arming the error gate", () => armWebGPUDevices(page));
  const removed = acceptStrip(
    await budget.bound("the viewer chrome strip", () =>
      page.evaluate(`(${STRIP_WIDGETS_SOURCE})()`),
    ),
    cell,
  );
  await budget.bound("installing the frame driver", () =>
    installSceneFrameDriver(page),
  );
  const traceInstalled = await budget.bound(
    "installing the texture trace",
    () =>
      page.evaluate(pageInstallSceneTextureTrace, {
        moduleUrl: CESIUM_MODULE_URL,
      }),
  );
  const censusInstalled = await budget.bound(
    "installing the framebuffer census counters",
    () =>
      page.evaluate(pageInstallFramebufferCensusTrace, {
        moduleUrl: CESIUM_MODULE_URL,
      }),
  );
  const settled = decideCensusRun(
    await budget.bound("the census settle", () =>
      page.evaluate(pageRunFramebufferCensus, {
        moduleUrl: CESIUM_MODULE_URL,
        camera: rig.camera,
        clock,
        det: DET_BROWSER_SETUP,
        tileSettle: CENSUS_TILE_SETTLE,
        rigDials: rig.dials ?? {},
        cellDials: census.dials,
        settleFrames,
        maxFrames: Math.max(CENSUS_MAX_FRAMES, settleFrames + 1),
        deadlineMs: Math.max(0, budget.remainingMs() - PAGE_DEADLINE_MARGIN_MS),
        driverGlobal: SCENE_FRAME_DRIVER_GLOBAL,
      }),
    ),
    census,
  );
  const shot = await budget.bound("the capture", () =>
    captureElement({
      page,
      selector: CANVAS_SELECTOR,
      name: censusCaptureName(census.name, run),
      outputDirectory,
      captures,
    }),
  );
  return {
    census: census.name,
    dials: census.dials,
    settleFrames,
    framesRendered: settled.frames,
    stepsElapsedMs: settled.elapsedMs,
    applied: settled.applied,
    modelReady: settled.modelReady,
    msaaSamples: settled.msaaSamples,
    widgetsRemoved: removed,
    capture: { name: shot.name, sha256: shot.sha256 },
    trace: {
      installed: traceInstalled.installed,
      ...(await budget.bound("reading the texture trace", () =>
        page.evaluate(pageReadStubTextureTrace),
      )),
      framebuffers: {
        installed: censusInstalled.installed,
        ...(await budget.bound("reading the framebuffer census", () =>
          page.evaluate(pageReadFramebufferCensusTrace),
        )),
      },
    },
    gate: await budget.bound("reading the error gate", () =>
      collectGateErrors(page),
    ),
  };
}

/**
 * Compare a framebuffer census over three output directories and print one
 * row per cell; never opens a browser.
 *
 * @param {string[]} directories B1, B2 and A, in that order.
 * @returns {number} The exit code: 0, or 2 for a usage error.
 */
export function runCensusCompare(directories) {
  const [before1, before2, after] = directories;
  if (!before1 || !before2 || !after) {
    console.error(
      "usage: --census-compare <before1-dir> <before2-dir> <after-dir>",
    );
    return 2;
  }
  const rows = compareFramebufferCensusRuns({
    before1,
    before2,
    after,
    boxSpreadAndChange,
  });
  console.log(JSON.stringify(rows, null, 2));
  return 0;
}

/**
 * One scene on one renderer, in a fresh browser context, every browser call
 * bounded by one cell budget.
 */
async function captureCell({
  browser,
  origin,
  options,
  cell,
  run,
  outputDirectory,
  captures,
}) {
  const budget = createCellBudget({
    scene: cell.scene,
    renderer: cell.renderer,
    budgetMs: CELL_BUDGET_MS,
  });
  const context = await browser.newContext({
    viewport: { ...cell.rig.viewport },
  });
  try {
    await context.addInitScript(errorGateInit);
    await context.addInitScript(armDevicesOnRequest);
    await context.addInitScript(stubTextureTraceInit);
    const page = await context.newPage();
    const diagnostics = attachPageDiagnostics(page);
    try {
      const work =
        cell.scene === "atlas"
          ? captureAtlasCell
          : cell.scene === "framebuffer-census"
            ? captureCensusCell
            : captureVideoCell;
      const measured = await work({
        page,
        origin,
        options,
        cell,
        run,
        outputDirectory,
        captures,
        budget,
      });
      return {
        run,
        scene: cell.scene,
        rig: cell.rig.id,
        renderer: cell.renderer,
        ...measured,
        pageErrors: diagnostics.errors.map(({ text }) => text).slice(0, 5),
      };
    } finally {
      diagnostics.detach();
    }
  } finally {
    await context.close();
  }
}

/**
 * Pair each scene's WebGPU cell with its WebGL cell: the atlas halves' lit
 * fractions as WebGPU over WebGL, and the video box's spread and change side
 * by side. Pure and exported for a spec.
 *
 * @param {Array<object>} records The run's cell records.
 * @returns {Array<object>} One pair per scene captured on both renderers.
 */
export function pairStubTextureCells(records) {
  const pairs = [];
  for (const scene of DEFAULT_SCENES) {
    const webgl = records.find(
      (record) => record.scene === scene && record.renderer === "webgl",
    );
    const webgpu = records.find(
      (record) => record.scene === scene && record.renderer === "webgpu",
    );
    if (!webgl || !webgpu) {
      continue;
    }
    if (scene === "atlas") {
      const ratio = (gpu, gl) => (gl > 0 ? gpu / gl : null);
      pairs.push({
        scene,
        topWebgpuOverWebgl: ratio(webgpu.halves.top, webgl.halves.top),
        bottomWebgpuOverWebgl: ratio(webgpu.halves.bottom, webgl.halves.bottom),
      });
    } else {
      pairs.push({
        scene,
        lumaStdDev: {
          webgpu: webgpu.centerBox.lumaStdDev,
          webgl: webgl.centerBox.lumaStdDev,
        },
        changedFraction: {
          webgpu: webgpu.centerBox.changedFraction,
          webgl: webgl.centerBox.changedFraction,
        },
      });
    }
  }
  return pairs;
}

/** How many cells a run will take, for the deadline; never throws. */
function plannedCellCount(options) {
  try {
    return planStubTextureCells(options).length;
  } catch {
    return DEFAULT_SCENES.length * 2;
  }
}

/** The descriptor the shared runtime executes. */
export const descriptor = {
  name: "stub-texture-uploads",
  title:
    "Label-atlas growth and the Sandcastle2 Video demo, WebGL vs WebGPU, with the WebGPU error gate",
  outputSubdirectory: "stub-texture-uploads",
  receiptEnvelope: "runtime",
  servedArtifacts: [
    "Build/CesiumUnminified/Cesium.js",
    "Build/CesiumUnminified/index.js",
    "packages/engine/Build/Unminified/index.js",
  ],
  args: {
    extraOptions: [
      {
        flag: "--scene",
        key: "scene",
        kind: "string",
        default: DEFAULT_SCENES.join(","),
      },
      {
        flag: "--sandcastle-port",
        key: "sandcastlePort",
        kind: "positive-integer",
      },
      {
        flag: "--census-settle-frames",
        key: "censusSettleFrames",
        kind: "positive-integer",
      },
    ],
  },
  workBudgetMs: (options) =>
    Math.max(1, plannedCellCount(options)) * CELL_BUDGET_MS,
  async cells({ browser, run, options, origin, outputDirectory, captures }) {
    const records = [];
    for (const cell of planStubTextureCells(options)) {
      console.log(
        `[probe-stub-texture-uploads] ${cell.scene} on ${cell.renderer} (run ${run})`,
      );
      records.push(
        await captureCell({
          browser,
          origin,
          options,
          cell,
          run,
          outputDirectory,
          captures,
        }),
      );
    }
    return [{ run, cells: records, pairs: pairStubTextureCells(records) }];
  },
  receipt(cells, context) {
    for (const { pairs } of cells) {
      for (const pair of pairs) {
        console.log(`  ${JSON.stringify(pair)}`);
      }
    }
    return { scene: context.options.scene, cells };
  },
};

if (isEntryPoint(import.meta.url)) {
  const compareAt = process.argv.indexOf("--census-compare");
  process.exitCode =
    compareAt >= 0
      ? runCensusCompare(process.argv.slice(compareAt + 1))
      : await runProbe(descriptor);
}
