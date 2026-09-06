#!/usr/bin/env node
/**
 * Probe: CLASSIFICATION-FRUSTUM-SLICES (`AR-714` / `AR-715` / `AR-716`).
 * @purpose Measures, on both renderers and in SCENE3D, SCENE2D and mid-morph, whether every classification command carries a bounding volume, whether it is binned into exactly the frustum bands that volume reaches, and — reported, not gated — the frustum-list length and the translucent/opaque mean-channel ratio inside the classified footprint.
 * @status ACTIVE
 * @runtime lib/probe-runtime.mjs
 *
 * WHAT THIS MEASURES AND WHY THE BARS CHANGED
 * -------------------------------------------
 * A classification command with no bounding volume takes
 * `View.createPotentiallyVisibleSet`'s no-bounding-volume branch
 * (`Scene/View.js:374-388`), which does two things: it bins the command into
 * every frustum band, and it folds the camera's whole near..far into the
 * accumulators `updateFrustums` divides — so it also CREATES bands.
 *
 * The row's first Edge leg asked for `slices == 1`, `frustums == 1` and
 * `draws == distinctCommands` on both renderers. Eowyn's job-9 leg 2
 * (`Tools/visual-regression/output/wave-p0-2-edge-2026-09-05-job9/leg2-ar714`)
 * showed those are one bar in three hats, and that the hat does not fit
 * SCENE2D on either backend. The adjudication and the replacement bars live in
 * `lib/classification-frustum-slices-verdicts.mjs`, which is where the decision
 * logic itself lives so a browser-free spec can execute and mutate it. In
 * short:
 *
 *   1. `bounded` — every owned command carries a bounding volume. GATED, both
 *      backends. This is the property AR-714/715/716 changed, observed
 *      directly, and it cannot be satisfied vacuously.
 *   2. `slices` == the count derived by replaying `insertIntoBin`'s own band
 *      test over the command's own `computePlaneDistances` extent against the
 *      frame's own band list. GATED, both backends. One band gives 1; the
 *      SCENE2D straddle gives 2; no volume gives the whole band count.
 *   3. `draws` == the sum of those per-command expectations. GATED, both.
 *   4. `sceneMode` == the mode the scene claims to be measuring. GATED, both.
 *   5. `errors` — the ones NOT attributed to the tracked
 *      `WebGPUDebugFrustumOverlay` bind-group defect. GATED, both. The
 *      attributed ones are counted, reported in their own column and named in
 *      the summary; they are neither swallowed nor charged to this row.
 *   6. `frustums` — REPORTED. `frustumCommandsList.length` is a property of the
 *      whole frame, not of this primitive: the `*-cull` cells, where the
 *      primitive contributes nothing at all, read 1 on WebGL and 2 on WebGPU.
 *   7. `ratio` — REPORTED, with a `ratioStatus`. See below.
 *
 * THE CULL SCENE IS THE BATCH-167 TRAP
 * ------------------------------------
 * `WebGPUDrawCommand.ts:502` defaults `cull` to true and `Scene.isVisible`
 * short-circuits to visible while the bounding volume is absent, so supplying
 * one switches on culling that had been moot. The `*-cull` scenes place the
 * same primitive outside the view and require ZERO owned commands binned on
 * both renderers, while the in-view scenes require them present — so the fix
 * cannot have changed behaviour twice.
 *
 * THE FOOTPRINT IS CAPTURED WITH `debugShowFrustums` OFF
 * -----------------------------------------------------
 * It has to be. `scene.debugShowFrustums = true` makes
 * `DebugInspector.js:79-85` multiply every fragment by `debugShowFrustumsColor`
 * — `(bit0, bit1, bit2)` of `debugOverlappingFrustums` (`:129-143`). A command
 * in band 0 alone is multiplied by `(1,0,0)`, which zeroes the green channel
 * the footprint counts, and on WebGPU the same switch routes the frame through
 * the broken debug overlay instead of the post-process chain, so the canvas is
 * not written with scene content at all. Leg 2 read 0 footprint pixels on 12 of
 * 14 cells for exactly those two reasons. So the footprint is captured first,
 * with the flag off, and only then is the flag turned on and the distribution
 * read from a later frame. They describe different frames on purpose: one
 * measures pixels, the other measures binning, and the flag that enables the
 * second destroys the first.
 *
 * THE GROUND IS BLACK ON PURPOSE
 * ------------------------------
 * Every scene removes the imagery layers, paints `globe.baseColor` black and
 * turns the sky, sun and atmosphere off, so the classification composites over
 * black and the blend arithmetic behind the ratio is the arithmetic the ledger
 * used. With imagery underneath, a translucent/opaque ratio is not a blend
 * ratio at all.
 *
 * Usage: node server.js --port 8094 --serve-built   (separate terminal, once)
 *        node Tools/visual-regression/probe-classification-frustum-slices.mjs
 *   SCENE=<name> runs one scene; default runs all of them.
 * Out:   Tools/visual-regression/output/classifyslices-report.json +
 *        classifyslices-runtime.json + classifyslices-summary.md
 */
import {
  attachConsoleErrorGate,
  collectGateErrors,
  errorGateInit,
} from "../lib/webgpu-error-gate.mjs";
import {
  MIN_FOOTPRINT_PIXELS,
  OVERLAY_DEFECT_ROW,
  SINGLE_BLEND_BAND,
  evaluateCell,
  evaluateRatio,
  foldCommands,
  partitionErrors,
} from "./lib/classification-frustum-slices-verdicts.mjs";
import { ProbeRefusal, isEntryPoint, runProbe } from "./lib/probe-runtime.mjs";

// The decision logic is re-exported so a reader of the probe can find it and a
// spec can import it from either module.
export {
  MIN_FOOTPRINT_PIXELS,
  OVERLAY_DEFECT_MARKER,
  OVERLAY_DEFECT_ROW,
  SINGLE_BLEND_BAND,
  evaluateCell,
  evaluateRatio,
  expectedSliceCount,
  foldCommands,
  partitionErrors,
  sliceCount,
} from "./lib/classification-frustum-slices-verdicts.mjs";

const VIEWPORT = { width: 800, height: 600 };
const WATCHDOG_BUDGET_MS = 8 * 60 * 1000;

// `morphTo3D` divides its duration by three and spends the first third in a
// `camera.flyTo` that is still SCENE2D (`Scene/SceneTransitioner.js:470-546`),
// so a fixed frame budget reads the flyTo rather than the morph. Bounded wait
// for the mode itself: four seconds at 60 Hz against a 0.67 s prologue.
const MORPH_WAIT_FRAMES = 240;

// The drape and the camera. A sub-degree footprint under a nadir camera, so
// the classified region is a large, solid block of pixels at both alphas.
const LON = -75.0;
const LAT = 40.0;
const HALF_SPAN = 0.35;
const CAMERA_HEIGHT_3D = 350000.0;
const CAMERA_HEIGHT_2D = 2000000.0;
// Far enough that the drape is outside the frustum in both modes.
const CULL_OFFSET_DEGREES = 120.0;

/**
 * Every scene this probe can run: which primitive, which scene mode, whether
 * the primitive is placed outside the view, and whether the blend ratio is
 * measured (a mid-morph frame is not a stable place to read a mean).
 */
const SCENES = Object.freeze([
  {
    name: "classification-3d",
    kind: "classification",
    mode: "3d",
    ratio: true,
  },
  { name: "groundprim-2d", kind: "groundprim", mode: "2d", ratio: true },
  { name: "groundprim-morph", kind: "groundprim", mode: "morph", ratio: false },
  { name: "groundpolyline-3d", kind: "polyline", mode: "3d", ratio: true },
  { name: "groundpolyline-2d", kind: "polyline", mode: "2d", ratio: false },
  {
    name: "groundpolyline-cull",
    kind: "polyline",
    mode: "3d",
    ratio: false,
    outside: true,
  },
  {
    name: "groundprim-cull",
    kind: "groundprim",
    mode: "3d",
    ratio: false,
    outside: true,
  },
]);

/**
 * Builds the scene in the page and leaves the classification primitive on
 * `window.__probeTarget`, then reads the footprint with `debugShowFrustums`
 * off and the command distribution with it on.
 *
 * Everything inside runs in the browser; it takes only JSON-serialisable
 * arguments and returns only JSON-serialisable values.
 *
 * @param {object} page The Playwright page.
 * @param {object} spec The scene spec plus `alpha` and `renderer`.
 * @returns {Promise<object>} The reading.
 */
async function measure(page, spec) {
  return await page.evaluate(async (options) => {
    const C = await import("/Build/CesiumUnminified/index.js");

    if (window.__probeViewer && !window.__probeViewer.isDestroyed()) {
      try {
        window.__probeViewer.destroy();
      } catch (e) {
        void e;
      }
    }
    window.__probeViewer = undefined;
    window.__probeTarget = undefined;

    let container = document.getElementById("cesiumContainer");
    if (!container) {
      container = document.createElement("div");
      container.id = "cesiumContainer";
      document.body.appendChild(container);
    }
    container.innerHTML = "";
    Object.assign(container.style, {
      position: "absolute",
      top: "0",
      left: "0",
      width: `${options.width}px`,
      height: `${options.height}px`,
    });

    const viewer = await C.Viewer.createAsync("cesiumContainer", {
      contextOptions: { renderer: options.renderer },
      baseLayerPicker: false,
      geocoder: false,
      timeline: false,
      animation: false,
      fullscreenButton: false,
      navigationHelpButton: false,
      homeButton: false,
      sceneModePicker: false,
      infoBox: false,
      selectionIndicator: false,
      shouldAnimate: false,
    });
    window.__probeViewer = viewer;
    window.viewer = viewer;

    const scene = viewer.scene;
    // The classification must composite over black for the blend ratio to be
    // a blend ratio. Imagery, sky, sun and atmosphere all put something else
    // underneath or on top of it.
    viewer.imageryLayers.removeAll();
    scene.globe.baseColor = C.Color.BLACK;
    scene.globe.showGroundAtmosphere = false;
    scene.globe.enableLighting = false;
    scene.skyBox.show = false;
    scene.skyAtmosphere.show = false;
    scene.sun.show = false;
    scene.moon.show = false;
    scene.fog.enabled = false;
    scene.backgroundColor = C.Color.BLACK;
    // OFF for the whole settle and for the footprint capture. It tints every
    // fragment by band membership (`DebugInspector.js:79-85`) and on WebGPU it
    // replaces the post-process chain, so a footprint read under it measures
    // the debug overlay rather than the classification. Turned on below, after
    // the capture, for the two frames the distribution is read from.
    scene.debugShowFrustums = false;

    const offsetLon = options.outside ? options.cullOffset : 0.0;
    const west = options.lon + offsetLon - options.halfSpan;
    const east = options.lon + offsetLon + options.halfSpan;
    const south = options.lat - options.halfSpan;
    const north = options.lat + options.halfSpan;
    const colour = new C.Color(0.1, 1.0, 0.1, options.alpha);

    let primitive;
    if (options.kind === "polyline") {
      primitive = new C.GroundPolylinePrimitive({
        geometryInstances: new C.GeometryInstance({
          geometry: new C.GroundPolylineGeometry({
            positions: C.Cartesian3.fromDegreesArray([
              west,
              south,
              east,
              south,
              east,
              north,
              west,
              north,
            ]),
            width: 40.0,
          }),
        }),
        appearance: new C.PolylineMaterialAppearance({
          material: C.Material.fromType("Color", { color: colour }),
        }),
        asynchronous: false,
      });
    } else {
      const instance = new C.GeometryInstance({
        geometry: new C.RectangleGeometry({
          rectangle: C.Rectangle.fromDegrees(west, south, east, north),
          vertexFormat: C.PerInstanceColorAppearance.VERTEX_FORMAT,
        }),
        attributes: {
          color: C.ColorGeometryInstanceAttribute.fromColor(colour),
        },
      });
      const Ctor =
        options.kind === "classification"
          ? C.ClassificationPrimitive
          : C.GroundPrimitive;
      primitive = new Ctor({
        geometryInstances: instance,
        appearance: new C.PerInstanceColorAppearance({
          flat: true,
          translucent: options.alpha < 1.0,
        }),
        classificationType: C.ClassificationType.TERRAIN,
        asynchronous: false,
      });
    }
    scene.primitives.add(primitive);
    window.__probeTarget = primitive;

    // The ONLY sanctioned way to read this canvas. A probe-local
    // `drawImage(scene.canvas)` reads a buffer neither backend guarantees still
    // exists — WebGL clears the drawing buffer after the compositor swap and
    // WebGPU invalidates the swap-chain texture after presentation — so the
    // fleet forbids it (`lib/prohibited-reader-rule.mjs`) and this block is
    // copied byte-for-byte from `lib/same-task-capture.mjs`.
    // ==BEGIN same-task-capture==
    const makeSameTaskCapture = (scene, canvas, timeFn) => {
      const renderNow = () => scene.render(timeFn());
      const tmp = document.createElement("canvas");
      const ctx = tmp.getContext("2d", { willReadFrequently: true });
      const decodeSnapshot = async (snapshot) => {
        const image = new Image();
        const loaded = new Promise((resolve, reject) => {
          const decodeFailed = "same-task PNG decode failed";
          image.onload = resolve;
          image.onerror = () => reject(new Error(decodeFailed));
        });
        image.src = snapshot;
        await loaded;
        tmp.width = image.naturalWidth;
        tmp.height = image.naturalHeight;
        ctx.drawImage(image, 0, 0);
        return ctx.getImageData(0, 0, tmp.width, tmp.height);
      };
      const snapshotNow = () => {
        renderNow();
        return canvas.toDataURL("image/png");
      };
      const captureNow = () => {
        const snapshot = snapshotNow();
        return decodeSnapshot(snapshot);
      };
      const grabNow = snapshotNow;
      const settleThen = async (maxFrames, done, capture) => {
        let settled = false;
        for (let k = 0; k < maxFrames; k++) {
          if (typeof done === "function" && done() === true) {
            settled = true;
            break;
          }
          renderNow();
          await new Promise((r) => requestAnimationFrame(r));
        }
        if (!settled && typeof done === "function") {
          settled = done() === true;
        }
        const hasCapture = typeof capture === "function";
        const result = hasCapture ? await capture() : undefined;
        return { settled, result };
      };
      return { renderNow, captureNow, grabNow, settleThen };
    };
    // ==END same-task-capture==

    // `scene.render()` with no argument is what every settle below does, so the
    // capture's own render must be the same call.
    const { captureNow } = makeSameTaskCapture(
      scene,
      scene.canvas,
      () => undefined,
    );

    const frame = (n) =>
      new Promise((resolve) => {
        let left = n;
        const step = () => {
          scene.render();
          left -= 1;
          if (left <= 0) {
            resolve();
            return;
          }
          requestAnimationFrame(step);
        };
        step();
      });

    if (options.mode === "2d") {
      scene.morphTo2D(0.0);
    } else {
      scene.morphTo3D(0.0);
    }
    await frame(4);

    viewer.camera.setView({
      destination: C.Cartesian3.fromDegrees(
        options.lon,
        options.lat,
        options.mode === "2d" ? options.height2D : options.height3D,
      ),
      orientation: { heading: 0.0, pitch: -Math.PI / 2, roll: 0.0 },
    });

    // Settle the globe: the frustum list moves while tiles load, so a reading
    // taken before `tilesLoaded` is a reading of the loading transient.
    await frame(20);
    let stable = 0;
    for (let i = 0; i < 240 && stable < 8; i++) {
      await frame(1);
      stable = scene.globe.tilesLoaded ? stable + 1 : 0;
    }
    await frame(8);

    let morphReached = true;
    if (options.mode === "morph") {
      scene.morphTo2D(0.0);
      await frame(6);
      scene.morphTo3D(2.0);
      // `morphFrom2DTo3D` divides the duration by three and flies the camera
      // in SCENE2D for the first third, setting MORPHING only in that flyTo's
      // completion callback (`Scene/SceneTransitioner.js:470-546`). A fixed
      // frame budget therefore reads a 2D frame — which is what leg 2 did,
      // reporting `sceneMode` 2 on both renderers. Wait for the mode itself,
      // with a bound.
      morphReached = false;
      for (let i = 0; i < options.morphWaitFrames && !morphReached; i++) {
        await frame(1);
        morphReached = scene.mode === C.SceneMode.MORPHING;
      }
      // Past the transition edge and far short of the remaining two thirds.
      await frame(8);
    }

    const readDistribution = () => {
      const view = scene.view;
      const list = view.frustumCommandsList;
      const camera = scene.camera;
      const bands = [];
      for (let i = 0; i < list.length; i++) {
        bands.push({ near: list[i].near, far: list[i].far });
      }
      const seen = new Map();
      let draws = 0;
      for (let i = 0; i < list.length; i++) {
        const frustumCommands = list[i];
        for (let p = 0; p < frustumCommands.commands.length; p++) {
          const used = frustumCommands.indices[p];
          for (let k = 0; k < used; k++) {
            const command = frustumCommands.commands[p][k];
            if (!command || command.owner !== window.__probeTarget) {
              continue;
            }
            draws += 1;
            if (seen.has(command)) {
              continue;
            }
            const volume = command.boundingVolume;
            const hasBoundingVolume =
              !!volume && typeof volume.computePlaneDistances === "function";
            // The extent the PVS itself computes for this command: the
            // volume's plane distances when it has one, and the camera's whole
            // range when it does not (`Scene/View.js:340-344`, `:374-378`).
            let near = camera.frustum.near;
            let far = camera.frustum.far;
            if (hasBoundingVolume) {
              const interval = volume.computePlaneDistances(
                camera.positionWC,
                camera.directionWC,
              );
              near = interval.start;
              far = interval.stop;
            }
            seen.set(command, {
              sliceMask: (command.debugOverlappingFrustums ?? 0) >>> 0,
              near,
              far,
              hasBoundingVolume,
              executeInClosestFrustum: command.executeInClosestFrustum === true,
            });
          }
        }
      }
      return {
        frustums: list.length,
        bands,
        draws,
        commands: Array.from(seen.values()),
        sceneMode: scene.mode,
      };
    };

    const readFootprint = async () => {
      const { data, width, height } = await captureNow();
      let sum = 0;
      let count = 0;
      for (let p = 0; p < width * height; p++) {
        const i = 4 * p;
        const r = data[i];
        const g = data[i + 1];
        const b = data[i + 2];
        // The classification is the only green thing in the frame: the globe
        // is black, the sky is off, and nothing else is added.
        if (g > 20 && g > r + 10 && g > b + 10) {
          sum += g;
          count += 1;
        }
      }
      return { meanChannel: count > 0 ? sum / count : 0, pixels: count };
    };

    // Pixels first, under no tint. Then the flag, then the binning.
    const footprint = await readFootprint();
    scene.debugShowFrustums = true;
    await frame(2);
    const distribution = readDistribution();
    scene.debugShowFrustums = false;

    return {
      ...distribution,
      ...footprint,
      morphReached,
      sceneModeEnum: {
        MORPHING: C.SceneMode.MORPHING,
        COLUMBUS_VIEW: C.SceneMode.COLUMBUS_VIEW,
        SCENE2D: C.SceneMode.SCENE2D,
        SCENE3D: C.SceneMode.SCENE3D,
      },
    };
  }, spec);
}

/**
 * The scene mode each `mode` string claims to measure, read from the live enum
 * the page returned rather than from a transcribed integer.
 *
 * @param {string} mode The scene spec's mode.
 * @param {object} sceneModeEnum The page's `SceneMode` values.
 * @returns {number} The expected `scene.mode`.
 */
function expectedSceneModeFor(mode, sceneModeEnum) {
  if (mode === "2d") {
    return sceneModeEnum.SCENE2D;
  }
  if (mode === "morph") {
    return sceneModeEnum.MORPHING;
  }
  return sceneModeEnum.SCENE3D;
}

/**
 * Runs one scene on one renderer, at one or two alphas.
 *
 * @param {object} browser The Edge browser.
 * @param {string} origin The served origin.
 * @param {object} scene The scene spec.
 * @param {string} renderer `webgl` or `webgpu`.
 * @returns {Promise<object>} The cell.
 */
async function runCell(browser, origin, scene, renderer) {
  const page = await browser.newPage({ viewport: VIEWPORT });
  const consoleErrors = attachConsoleErrorGate(page);
  await page.addInitScript(errorGateInit);
  await page.goto(
    `${origin}/Apps/CesiumViewer/index.html?renderer=${renderer}`,
    {
      waitUntil: "networkidle",
      timeout: 90000,
    },
  );
  await page.waitForFunction(() => !!window.viewer, { timeout: 90000 });

  const base = {
    renderer,
    kind: scene.kind,
    mode: scene.mode,
    outside: scene.outside === true,
    lon: LON,
    lat: LAT,
    halfSpan: HALF_SPAN,
    height3D: CAMERA_HEIGHT_3D,
    height2D: CAMERA_HEIGHT_2D,
    cullOffset: CULL_OFFSET_DEGREES,
    width: VIEWPORT.width,
    height: VIEWPORT.height,
    morphWaitFrames: MORPH_WAIT_FRAMES,
  };

  const translucent = await measure(page, { ...base, alpha: 0.5 });
  const opaque = scene.ratio
    ? await measure(page, { ...base, alpha: 1.0 })
    : null;

  const gate = await collectGateErrors(page);
  await page.close();

  // Attribution, not suppression: the overlay's validation failures are a
  // different subsystem's defect (`OVERLAY_DEFECT_ROW`) and are counted and
  // published in their own column, so this row's error bar stays honest and
  // theirs stays visible.
  const partition = partitionErrors([...gate.errors, ...consoleErrors]);
  const errors = partition.gating.length + (gate.deviceLost ? 1 : 0);

  const folded = foldCommands(translucent.commands, translucent.bands);

  const cell = {
    scene: scene.name,
    renderer,
    outside: scene.outside === true,
    errors,
    overlayErrors: partition.overlay.length,
    overlayDefectRow: partition.overlay.length > 0 ? OVERLAY_DEFECT_ROW : null,
    gateErrorsSample: partition.gating.slice(0, 6),
    overlayErrorsSample: partition.overlay.slice(0, 2),
    sceneMode: translucent.sceneMode,
    expectedSceneMode: expectedSceneModeFor(
      scene.mode,
      translucent.sceneModeEnum,
    ),
    morphReached: translucent.morphReached,
    frustums: translucent.frustums,
    bands: translucent.bands,
    slices: folded.slices,
    expectedSlices: folded.expectedSlices,
    draws: translucent.draws,
    expectedDraws: folded.expectedDraws,
    distinctCommands: folded.distinctCommands,
    boundedCommands: folded.boundedCommands,
    footprintPixels: translucent.pixels,
    translucentMeanChannel: translucent.meanChannel,
    opaqueMeanChannel: opaque ? opaque.meanChannel : null,
  };

  const ratio = evaluateRatio(cell);
  cell.ratio = ratio.ratio;
  cell.ratioStatus = ratio.ratioStatus;

  const verdict = evaluateCell(cell);
  cell.pass = verdict.pass;
  cell.clauses = verdict.clauses;
  cell.claim = verdict.claim;
  return cell;
}

/** The descriptor the shared runtime executes. */
export const descriptor = {
  name: "classifyslices",
  title: "Classification frustum slices (AR-714 / AR-715 / AR-716)",
  outputSubdirectory: "",
  receiptEnvelope: "runtime",
  async cells({ browser, origin, options }) {
    if (options.runs !== 1) {
      throw new ProbeRefusal(
        "multi-run-not-supported",
        `probe-classification-frustum-slices keys its cells by scene and renderer, so --runs ${options.runs} would drop every run but the last; pass --runs 1 (the default)`,
        { runs: options.runs },
      );
    }
    const only = (process.env.SCENE || "").trim();
    const selected = only
      ? SCENES.filter((scene) => scene.name === only)
      : SCENES.slice();
    if (selected.length === 0) {
      throw new ProbeRefusal(
        "unknown-scene",
        `SCENE=${only} names no scene; known scenes are ${SCENES.map((s) => s.name).join(", ")}`,
        { requested: only },
      );
    }

    const work = (async () => {
      const produced = [];
      for (const scene of selected) {
        for (const renderer of options.renderers) {
          produced.push(await runCell(browser, origin, scene, renderer));
        }
      }
      return produced;
    })();
    work.catch(() => {});
    let watchdogTimer;
    const watchdog = new Promise((_resolve, reject) => {
      watchdogTimer = setTimeout(
        () =>
          reject(
            new ProbeRefusal(
              "watchdog-timeout",
              `probe-classification-frustum-slices exceeded its ${WATCHDOG_BUDGET_MS}ms machine-safety budget`,
              {
                budgetMs: WATCHDOG_BUDGET_MS,
                scenes: selected.map((scene) => scene.name),
              },
            ),
          ),
        WATCHDOG_BUDGET_MS,
      );
    });
    try {
      return await Promise.race([work, watchdog]);
    } finally {
      clearTimeout(watchdogTimer);
    }
  },
  receipt(cells, context) {
    return {
      base: context.origin,
      // Carried un-applied: the ratio is reported, not gated, until an Edge
      // leg shows a non-zero footprint control on both backends.
      singleBlendBandReportedNotGated: SINGLE_BLEND_BAND,
      minFootprintPixels: MIN_FOOTPRINT_PIXELS,
      overlayDefectRow: OVERLAY_DEFECT_ROW,
      overlayErrorsTotal: cells.reduce(
        (total, cell) => total + cell.overlayErrors,
        0,
      ),
      cells,
    };
  },
  verdicts(cells) {
    return cells.map((cell) => ({
      id: `${cell.scene}:${cell.renderer}`,
      claim: cell.claim,
      pass: cell.pass,
    }));
  },
  summary(receipt) {
    const rows = receipt.cells.map(
      (cell) =>
        `| ${cell.scene} | ${cell.renderer} | ${cell.sceneMode}/${cell.expectedSceneMode} | ` +
        `${cell.boundedCommands}/${cell.distinctCommands} | ` +
        `${cell.slices}/${cell.expectedSlices} | ` +
        `${cell.draws}/${cell.expectedDraws} | ` +
        `${cell.frustums} | ` +
        `${cell.ratio === null ? cell.ratioStatus : cell.ratio.toFixed(3)} | ` +
        `${cell.errors} | ${cell.overlayErrors} | ${cell.pass ? "PASS" : "FAIL"} |`,
    );
    const passed = receipt.cells.filter((cell) => cell.pass).length;
    return [
      "# Classification frustum slices (AR-714 / AR-715 / AR-716)",
      "",
      `Base: \`${receipt.base}\``,
      "",
      `Cells: ${passed}/${receipt.cells.length} passed.`,
      "",
      "Gated: `bounded`, `slices`, `draws`, `mode`, `errors`. Reported only:",
      "`frustums` (a whole-frame property, not this primitive's) and `ratio`.",
      "",
      "| scene | renderer | mode/exp | bounded/cmds | slices/exp | draws/exp | frustums | ratio | errors | overlay | |",
      "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
      ...rows,
      "",
      `Overlay column: errors attributed to \`${receipt.overlayDefectRow}\` and`,
      "excluded from the gated `errors` count. Total this run:",
      `${receipt.overlayErrorsTotal}. A non-zero total is a real WebGPU defect`,
      "in a different subsystem, not a pass for it.",
      "",
    ].join("\n");
  },
};

if (isEntryPoint(import.meta.url)) {
  process.exitCode = await runProbe(descriptor);
}
