#!/usr/bin/env node
/**
 * Probe: CLASSIFICATION-FRUSTUM-SLICES (`AR-714` / `AR-715` / `AR-716`).
 * @purpose Measures, on both renderers and in SCENE3D, SCENE2D and mid-morph, how many frustum slices a classification command occupies, how long the frustum list is, how many times the classification draws per frame, and the translucent/opaque mean-channel ratio inside the classified footprint.
 * @status ACTIVE
 * @runtime lib/probe-runtime.mjs
 *
 * WHAT THIS MEASURES AND WHY THE NUMBERS COME IN FOURS
 * ----------------------------------------------------
 * A classification command with no bounding volume takes
 * `View.createPotentiallyVisibleSet`'s no-bounding-volume branch
 * (`Scene/View.js:374-388`), which does two things: it bins the command into
 * every frustum slice, and it folds the camera's whole near..far into the
 * accumulators `updateFrustums` divides — so it also CREATES slices. A fix
 * that lowers the slice count but leaves the list long has half landed, which
 * is why the list length is read in the same frame. And a translucent
 * classification drawn N times composites to `1 - (1 - a)^N` of its colour, so
 * the mean channel is what proves the slice count mattered rather than merely
 * moved.
 *
 * Four numbers per scene, each with its own bar:
 *
 *   1. `slices` — the popcount of `command.debugOverlappingFrustums`
 *      (`Scene/View.js:642-643`), maximised over the commands this primitive
 *      owns. BAR: 1 on BOTH renderers. Deterministic: a pure function of the
 *      command extent and the frustum splits, with no timing input.
 *   2. `frustums` — `scene.view.frustumCommandsList.length` in the same frame.
 *      BAR: 1 on BOTH renderers — the same bar the cell applies to `slices`,
 *      because the omitted volume grows the list as well as the bin count and a
 *      fix that lowers one but not the other has only half landed.
 *      Deterministic once the globe has settled; it moves while tiles load,
 *      which is why every scene settles on `globe.tilesLoaded` first.
 *   3. `draws` — how many bin slots hold a command this primitive owns.
 *      BAR: equal to the number of DISTINCT owned commands, i.e. every command
 *      binned exactly once. The absolute count is NOT comparable across
 *      renderers (WebGL emits stencil and colour commands where WebGPU emits
 *      one depth-sample command), which is exactly why the bar is the ratio to
 *      the distinct count rather than the count itself.
 *   4. `ratio` — the classified footprint's mean channel at alpha 0.5 divided
 *      by the same at alpha 1.0. BAR: the ledger's single-blend band
 *      0.34..0.62 (`DEFERRED_WORK.md:6439`), against the 0.748 double blend.
 *      This is the noisiest of the four: it depends on how many footprint
 *      pixels the classifier covers, so the cell also reports the pixel count
 *      and refuses to score a ratio taken over fewer than
 *      `MIN_FOOTPRINT_PIXELS` pixels rather than publishing a number computed
 *      from a handful of edge fragments. NOTE the shape: this is the
 *      translucent/opaque RATIO that `probe-ellipsoidprim-translucent.mjs`
 *      established, not an absolute channel mean — the ledger's band is a
 *      ratio band and an absolute mean is not comparable to it.
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
 * THE GROUND IS BLACK ON PURPOSE
 * ------------------------------
 * Every scene removes the imagery layers, paints `globe.baseColor` black and
 * turns the sky, sun and atmosphere off, so the classification composites over
 * black and the blend arithmetic behind bar 4 is the arithmetic the ledger
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
import { ProbeRefusal, isEntryPoint, runProbe } from "./lib/probe-runtime.mjs";

const VIEWPORT = { width: 800, height: 600 };
const WATCHDOG_BUDGET_MS = 8 * 60 * 1000;

// A ratio taken over a sliver of edge fragments is noise wearing a number's
// clothes. Below this the cell reports the ratio as null and fails on bar 4
// rather than scoring it.
const MIN_FOOTPRINT_PIXELS = 2000;

const SINGLE_BLEND_BAND = Object.freeze([0.34, 0.62]);

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
 * `window.__probeTarget`, then reads the three command-distribution numbers
 * and, when asked, the footprint's mean channel.
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
    // The slice count is only recorded while this is on
    // (`Scene/View.js:642-643`).
    scene.debugShowFrustums = true;

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

    if (options.mode === "morph") {
      // Half a second into a two-second 2D->3D morph: `scene.mode` is
      // MORPHING and the transient is the point.
      scene.morphTo2D(0.0);
      await frame(6);
      scene.morphTo3D(2.0);
      await frame(30);
    }

    const readDistribution = () => {
      const view = scene.view;
      const list = view.frustumCommandsList;
      const owned = new Set();
      let draws = 0;
      let slices = 0;
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
            owned.add(command);
            let bits = (command.debugOverlappingFrustums ?? 0) >>> 0;
            let count = 0;
            while (bits !== 0) {
              count += bits & 1;
              bits >>>= 1;
            }
            if (count > slices) {
              slices = count;
            }
          }
        }
      }
      return {
        frustums: list.length,
        draws,
        distinctCommands: owned.size,
        slices,
        sceneMode: scene.mode,
      };
    };

    // The capture renders as it reads, so the distribution is read AFTERWARDS:
    // both numbers then describe the same frame, which is what the acceptance
    // requires ("captured with `frustumCommandsList.length` itself in the same
    // frame").
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

    const footprint = await readFootprint();
    const distribution = readDistribution();
    return { ...distribution, ...footprint };
  }, spec);
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
  };

  const translucent = await measure(page, { ...base, alpha: 0.5 });
  const opaque = scene.ratio
    ? await measure(page, { ...base, alpha: 1.0 })
    : null;

  const gate = await collectGateErrors(page);
  await page.close();

  const errors =
    gate.errors.length + consoleErrors.length + (gate.deviceLost ? 1 : 0);

  const ratio =
    opaque &&
    opaque.meanChannel > 0 &&
    translucent.pixels >= MIN_FOOTPRINT_PIXELS
      ? translucent.meanChannel / opaque.meanChannel
      : null;

  const cell = {
    scene: scene.name,
    renderer,
    errors,
    gateErrorsSample: gate.errors.slice(0, 6),
    consoleErrorsSample: consoleErrors.slice(0, 6),
    sceneMode: translucent.sceneMode,
    frustums: translucent.frustums,
    slices: translucent.slices,
    draws: translucent.draws,
    distinctCommands: translucent.distinctCommands,
    footprintPixels: translucent.pixels,
    translucentMeanChannel: translucent.meanChannel,
    opaqueMeanChannel: opaque ? opaque.meanChannel : null,
    ratio,
  };

  if (scene.outside === true) {
    // The cull half: nothing this primitive owns may be binned, and that must
    // be true on both renderers.
    cell.pass = cell.errors === 0 && cell.draws === 0;
    cell.claim = "a classification primitive outside the view is not drawn";
    return cell;
  }

  const distributionOk =
    cell.errors === 0 &&
    cell.distinctCommands > 0 &&
    cell.slices === 1 &&
    cell.frustums === 1 &&
    cell.draws === cell.distinctCommands;
  const ratioOk =
    !scene.ratio ||
    (cell.footprintPixels >= MIN_FOOTPRINT_PIXELS &&
      cell.ratio !== null &&
      cell.ratio > SINGLE_BLEND_BAND[0] &&
      cell.ratio < SINGLE_BLEND_BAND[1]);
  cell.pass = distributionOk && ratioOk;
  cell.claim =
    "one frustum slice, one frustum, one draw per command, and a single blend";
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
      singleBlendBand: SINGLE_BLEND_BAND,
      minFootprintPixels: MIN_FOOTPRINT_PIXELS,
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
        `| ${cell.scene} | ${cell.renderer} | ${cell.slices} | ${cell.frustums} | ` +
        `${cell.draws}/${cell.distinctCommands} | ` +
        `${cell.ratio === null ? "—" : cell.ratio.toFixed(3)} | ` +
        `${cell.errors} | ${cell.pass ? "PASS" : "FAIL"} |`,
    );
    const passed = receipt.cells.filter((cell) => cell.pass).length;
    return [
      "# Classification frustum slices (AR-714 / AR-715 / AR-716)",
      "",
      `Base: \`${receipt.base}\``,
      "",
      `Cells: ${passed}/${receipt.cells.length} passed.`,
      "",
      "| scene | renderer | slices | frustums | draws/commands | ratio | errors | |",
      "| --- | --- | --- | --- | --- | --- | --- | --- |",
      ...rows,
      "",
    ].join("\n");
  },
};

if (isEntryPoint(import.meta.url)) {
  process.exitCode = await runProbe(descriptor);
}
