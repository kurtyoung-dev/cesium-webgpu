#!/usr/bin/env node
/**
 * Probe: EYE-CARTOGRAPHIC-FRAME (census `C-20` / `C-21` / `C-22`, `-07` item 14).
 * @purpose Confirms in a real WebGPU frame that the globe camera UB's eye cartographic tail arrives on the GPU as a true rotation, that csm_eyeToCartographicDelta round-trips the camera to zero there, and that the values the packer read match an independent CPU re-derivation of czm_eyeToEnu / czm_eyeCartographic / czm_eyeEllipsoidCurvature at four altitudes including a grazing near-horizon view.
 * @status ACTIVE
 * @runtime lib/probe-runtime.mjs
 *
 * WHY THIS LEG IS NUMERIC AND NOT A PIXEL DIFF
 * -------------------------------------------
 * This lane adds no visible feature. Its three uniforms exist to serve the
 * model clipping-polygon and model vector-lookup twins, which are HELD behind
 * items 2 and 13. There is therefore nothing to compare against WebGL: WebGL
 * has had `czm_eyeCartographic` and `czm_eyeToEnu` since 1.145 and renders
 * exactly the same pixels with or without them, so a WebGL/WebGPU diff would
 * be identically zero whether this lane landed or not. Inventing one would be
 * decoration. What a browser CAN answer, and Node cannot, is whether the bytes
 * survive the trip to the GPU under WGSL's uniform-address-space rules — which
 * is precisely the failure this lane's layout hazard is about.
 *
 * WHAT IS ACTUALLY MEASURED, PER SCENE
 * ------------------------------------
 *   1. `certificate` — the fraction of globe fragments that paint PURE GREEN
 *      under `CesiumDebug.globeFragmentDebug('eye-carto-frame')`. That mode
 *      reads `camera.eyeToEnu` as a `mat3x3<f32>` and returns green only when
 *      the three columns are orthonormal to 1e-4, the determinant is 1 to
 *      1e-4, and `csm_eyeToCartographicDelta(vec3(0))` comes back as zero.
 *      BAR: at least `MIN_CERTIFIED_PIXELS` green fragments and ZERO fragments
 *      painting a red or blue residual. A packer that wrote the matrix as nine
 *      tight floats — GLSL `mat3`'s layout — paints red, and only a real
 *      driver's `mat3x3` load can tell us it does not.
 *   2. `cpuAgreement` — the max absolute difference between
 *      `scene.context.uniformState`'s three values in that same frame and an
 *      independent re-derivation from `camera.positionCartographic` through
 *      `Transforms.eastNorthUpToFixedFrame` and
 *      `Ellipsoid.getLocalCurvature`. BAR: `CPU_AGREEMENT_TOLERANCE`. This is
 *      what makes the certificate mean something: green over a frame whose
 *      camera state was stale would still be green.
 *   3. `errors` — the shared WebGPU error gate. BAR: 0.
 *
 * THE FOUR SCENES
 * ---------------
 * Altitude is the axis that matters: the delta formulation's approximations
 * bite at the horizon of a high camera, and `eyeEllipsoidCurvature` is the
 * term that separates a sphere from WGS84 at high latitude. `low`, `mid` and
 * `high` are nadir views at 2 km, 500 km and 10,000 km; `grazing` is the
 * near-horizon case the brief names — a 1,000 km camera pitched until the limb
 * fills the frame, so most fragments are at large ENU offsets from the eye.
 *
 * WEBGPU ONLY, DELIBERATELY
 * -------------------------
 * The uniforms are WGSL. `--renderer webgl` is refused rather than silently
 * producing a cell that measures nothing.
 *
 * Usage: node server.js --port 8094 --serve-built   (separate terminal, once)
 *        node Tools/visual-regression/probe-eye-cartographic-frame.mjs --renderer webgpu
 *   SCENE=<name> runs one scene; default runs all four.
 * Out:   Tools/visual-regression/output/eyecarto-report.json +
 *        eyecarto-runtime.json + eyecarto-summary.md
 */
import {
  attachConsoleErrorGate,
  collectGateErrors,
  errorGateInit,
} from "../lib/webgpu-error-gate.mjs";
import { ProbeRefusal, isEntryPoint, runProbe } from "./lib/probe-runtime.mjs";

const VIEWPORT = { width: 800, height: 600 };
const WATCHDOG_BUDGET_MS = 8 * 60 * 1000;

// Below this the "all green" verdict is being taken over a handful of limb
// fragments and says nothing. 600 x 800 is 480,000 pixels; the globe fills a
// large fraction of every scene here.
const MIN_CERTIFIED_PIXELS = 20000;

// `uniformState`'s values are f64 all the way; the re-derivation runs the same
// `Transforms` and `Ellipsoid` entry points, so the two differ only by the
// order of a handful of f64 operations. Angles are radians and the height is
// metres, so one tolerance covers both only because both are small: 1e-9 rad
// is 6 mm on the ground and 1e-9 m is a nanometre.
const CPU_AGREEMENT_TOLERANCE = 1e-9;

const SCENES = Object.freeze([
  { name: "low", lon: -75.0, lat: 40.0, height: 2.0e3, pitch: -90 },
  { name: "mid", lon: 12.5, lat: 41.9, height: 5.0e5, pitch: -90 },
  { name: "high", lon: 139.7, lat: 35.7, height: 1.0e7, pitch: -90 },
  // The grazing near-horizon case: pitched until the limb crosses the frame,
  // so the fragments the delta is evaluated on sit at the tangent distance.
  { name: "grazing", lon: 0.0, lat: 66.5, height: 1.0e6, pitch: -12 },
]);

/**
 * Runs one scene on one renderer and returns its cell.
 *
 * @param {object} browser Playwright browser.
 * @param {string} origin Served origin.
 * @param {object} scene One entry of {@link SCENES}.
 * @param {string} renderer Renderer name.
 * @returns {Promise<object>} The cell.
 */
async function runCell(browser, origin, scene, renderer) {
  const page = await browser.newPage({ viewport: VIEWPORT });
  const consoleErrors = [];
  page.on("console", (message) => {
    if (message.type() === "error") {
      consoleErrors.push(message.text());
    }
  });
  await page.addInitScript(errorGateInit);
  await attachConsoleErrorGate(page);
  await page.goto(
    `${origin}/Apps/CesiumViewer/index.html?renderer=${renderer}`,
    {
      waitUntil: "load",
    },
  );

  const measured = await page.evaluate(
    async (options) => {
      // `Apps/CesiumViewer/index.html` loads its script as a module, and module
      // scope is not global scope: the page publishes `window.viewer` and
      // `window.CesiumDebug` but NEVER `window.Cesium`. Importing the same URL
      // the app itself imports gets the SAME instance out of the module map,
      // rather than a second copy with its own `JulianDate`.
      // (`WEBGPU_DEBUGGING_LOG.md`, 2026-09-05; it has cost three probes now.)
      const C = await import("/Build/CesiumUnminified/index.js");

      if (window.__probeViewer) {
        try {
          window.__probeViewer.destroy();
        } catch (e) {
          void e;
        }
      }
      window.__probeViewer = undefined;

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
      // Everything that is not a globe fragment must be black, so a pixel that
      // is neither black nor the certificate's own colour is a real signal.
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

      scene.camera.setView({
        destination: C.Cartesian3.fromDegrees(
          options.lon,
          options.lat,
          options.cameraHeight,
        ),
        orientation: {
          heading: 0.0,
          pitch: C.Math.toRadians(options.pitch),
          roll: 0.0,
        },
      });

      // The ONLY sanctioned way to read this canvas. A probe-local
      // `drawImage(scene.canvas)` reads a buffer neither backend guarantees
      // still exists — WebGL clears the drawing buffer after the compositor
      // swap and WebGPU invalidates the swap-chain texture after presentation
      // — so the fleet forbids it (`lib/prohibited-reader-rule.mjs`) and this
      // block is copied byte-for-byte from `lib/same-task-capture.mjs`.
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

      const capture = makeSameTaskCapture(scene, scene.canvas, () =>
        C.JulianDate.now(),
      );
      const settled = await capture.settleThen(
        options.settleFrames,
        () => scene.globe.tilesLoaded === true,
        undefined,
      );

      // Turn the certificate on, then let a few frames go by before reading:
      // the sentinel travels in the per-tile UB, so the frame that reads it is
      // the one AFTER the pack that wrote it.
      window.CesiumDebug.globeFragmentDebug("eye-carto-frame");
      const painted = await capture.settleThen(
        8,
        () => false,
        () => capture.captureNow(),
      );
      const image = painted.result;
      window.CesiumDebug.globeFragmentDebug(null);

      let certified = 0;
      let failed = 0;
      let black = 0;
      let other = 0;
      const data = image.data;
      for (let i = 0; i < data.length; i += 4) {
        const r = data[i];
        const g = data[i + 1];
        const b = data[i + 2];
        if (r <= 4 && g <= 4 && b <= 4) {
          black++;
        } else if (g >= 250 && r <= 4 && b <= 4) {
          certified++;
        } else if (r > 4 || b > 4) {
          failed++;
        } else {
          other++;
        }
      }

      // The same frame's uniform state, and an independent re-derivation of
      // the three values from the camera the renderer just used.
      const uniformState = scene.context.uniformState;
      const ellipsoid = scene.globe.ellipsoid ?? C.Ellipsoid.WGS84;
      const carto = scene.camera.positionCartographic;
      const surface = C.Cartesian3.fromRadians(
        carto.longitude,
        carto.latitude,
        0.0,
        ellipsoid,
      );
      const enuToWorld = C.Transforms.eastNorthUpToFixedFrame(
        surface,
        ellipsoid,
      );
      const enuRotation = C.Matrix4.getRotation(enuToWorld, new C.Matrix3());
      const viewRotation = C.Matrix4.getRotation(
        scene.camera.viewMatrix,
        new C.Matrix3(),
      );
      const enuToView = C.Matrix3.multiply(
        viewRotation,
        enuRotation,
        new C.Matrix3(),
      );
      const expectedEnu = C.Matrix3.transpose(enuToView, new C.Matrix3());
      const expectedCurvature = ellipsoid.getLocalCurvature(
        surface,
        new C.Cartesian2(),
      );

      let worst = 0;
      const track = (a, b) => {
        worst = Math.max(worst, Math.abs(a - b));
      };
      track(uniformState.eyeCartographic.x, carto.longitude);
      track(uniformState.eyeCartographic.y, carto.latitude);
      track(uniformState.eyeCartographic.z, carto.height);
      for (let i = 0; i < 9; i++) {
        track(uniformState.eyeToEnu[i], expectedEnu[i]);
      }
      track(uniformState.eyeEllipsoidCurvature.x, expectedCurvature.x);
      track(uniformState.eyeEllipsoidCurvature.y, expectedCurvature.y);

      return {
        certified,
        failed,
        black,
        other,
        cpuAgreement: worst,
        // The invariant C-20 states, read in a live frame rather than a
        // harness: the two are the SAME number, not merely close.
        heightIsCartographicZ: Object.is(
          uniformState.eyeCartographic.z,
          uniformState.eyeHeight,
        ),
        eyeHeight: uniformState.eyeHeight,
        tilesLoaded: settled.settled === true,
        renderReady: scene.renderReady === true,
      };
    },
    {
      renderer,
      width: VIEWPORT.width,
      height: VIEWPORT.height,
      lon: scene.lon,
      lat: scene.lat,
      cameraHeight: scene.height,
      pitch: scene.pitch,
      settleFrames: 240,
    },
  );

  const gate = await collectGateErrors(page);
  await page.close();

  const errors =
    gate.errors.length + consoleErrors.length + (gate.deviceLost ? 1 : 0);

  const cell = {
    scene: scene.name,
    renderer,
    errors,
    gateErrorsSample: gate.errors.slice(0, 6),
    consoleErrorsSample: consoleErrors.slice(0, 6),
    ...measured,
  };
  cell.pass =
    errors === 0 &&
    cell.failed === 0 &&
    cell.certified >= MIN_CERTIFIED_PIXELS &&
    cell.heightIsCartographicZ === true &&
    cell.cpuAgreement <= CPU_AGREEMENT_TOLERANCE;
  cell.claim =
    "the eye cartographic frame reaches the GPU as a true rotation, the delta round-trips the camera to zero, and the packed values match an independent re-derivation";
  return cell;
}

/** The descriptor the shared runtime executes. */
export const descriptor = {
  name: "eyecarto",
  title: "Eye cartographic frame on the GPU (C-20 / C-21 / C-22)",
  outputSubdirectory: "",
  receiptEnvelope: "runtime",
  async cells({ browser, origin, options }) {
    if (options.runs !== 1) {
      throw new ProbeRefusal(
        "multi-run-not-supported",
        `probe-eye-cartographic-frame keys its cells by scene and renderer, so --runs ${options.runs} would drop every run but the last; pass --runs 1 (the default)`,
        { runs: options.runs },
      );
    }
    const renderers = options.renderers.filter(
      (renderer) => renderer === "webgpu",
    );
    if (renderers.length === 0) {
      throw new ProbeRefusal(
        "webgpu-only",
        "the three uniforms this probe reads are WGSL: WebGL has carried czm_eyeCartographic and czm_eyeToEnu since 1.145 and renders identically with or without them, so a webgl cell would measure nothing. Pass --renderer webgpu.",
        { requested: options.renderers },
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
        for (const renderer of renderers) {
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
              `probe-eye-cartographic-frame exceeded its ${WATCHDOG_BUDGET_MS}ms machine-safety budget`,
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
      minCertifiedPixels: MIN_CERTIFIED_PIXELS,
      cpuAgreementTolerance: CPU_AGREEMENT_TOLERANCE,
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
        `| ${cell.scene} | ${cell.renderer} | ${cell.certified} | ${cell.failed} | ` +
        `${cell.cpuAgreement.toExponential(2)} | ` +
        `${cell.heightIsCartographicZ ? "yes" : "NO"} | ` +
        `${cell.errors} | ${cell.pass ? "PASS" : "FAIL"} |`,
    );
    const passed = receipt.cells.filter((cell) => cell.pass).length;
    return [
      "# Eye cartographic frame on the GPU (C-20 / C-21 / C-22)",
      "",
      `Base: \`${receipt.base}\``,
      "",
      `Cells: ${passed}/${receipt.cells.length} passed.`,
      "",
      `Green fragments certify the ENU basis arrived orthonormal with det 1 and`,
      `that \`csm_eyeToCartographicDelta\` round-trips the camera to zero. A red`,
      `or blue fragment is a packing error — the tight nine-float \`mat3\` layout`,
      `paints red.`,
      "",
      "| scene | renderer | certified px | failed px | cpu agreement | z==eyeHeight | errors | |",
      "| --- | --- | --- | --- | --- | --- | --- | --- |",
      ...rows,
      "",
    ].join("\n");
  },
};

if (isEntryPoint(import.meta.url)) {
  process.exitCode = await runProbe(descriptor);
}
