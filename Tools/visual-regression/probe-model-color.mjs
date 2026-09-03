/**
 * WIRE-MODEL-COLOR acceptance probe.
 * @purpose model.color acceptance: HIGHLIGHT/REPLACE/MIX tint parity per channel across backends, mode sanity, off-gate identity; fresh page per capture.
 * @status ACTIVE
 *
 * WebGL blends `model.color` into the lit color per `model.colorBlendMode`
 * (HIGHLIGHT / REPLACE / MIX) + `model.colorBlendAmount`
 * (`ModelColorPipelineStage` + `ModelColorStageFS.glsl`). This probe verifies
 * the WebGPU wiring (`MODEL_HAS_COLOR` ifdef blocks in ModelPBRComplete.wgsl,
 * driven by the material-UB reserved lanes) matches WebGL semantics:
 *
 *   1. COLOR PARITY — for each blend mode with `model.color = Color.RED`,
 *      the mean model-pixel color agrees between backends per channel within
 *      tolerance (shading differs slightly by design; the tint must match).
 *
 *   2. MODE SANITY — RED HIGHLIGHT/REPLACE kill the green/blue channels on
 *      BOTH backends (multiply-by-red / replace-with-red); MIX keeps some.
 *
 *   3. OFF-GATE — `model.color` undefined (default) renders identically to a
 *      capture that never touches the color API. Combined with the
 *      preprocess(defines=0) byte-identity of the stripped ifdef blocks, the
 *      feature is parity-neutral when off.
 *
 * Each capture uses a FRESH page load + a single element screenshot (WebGPU's
 * swapchain present detaches the canvas texture).
 *
 * Usage: node Tools/visual-regression/probe-model-color.mjs
 *   PROBE_BASE (default http://localhost:8080)
 */
import { chromium } from "playwright";
import { encodeRgbaPng } from "../lib/png-rgba.mjs";
import {
  errorGateInit,
  armWebGPUDevices,
  collectGateErrors,
  attachConsoleErrorGate,
} from "../lib/webgpu-error-gate.mjs";

const BASE = process.env.PROBE_BASE || "http://localhost:8080";
const MODEL = "/Apps/SampleData/models/CesiumMilkTruck/CesiumMilkTruck.glb";

const HEADING = 0.6;
const PITCH = -0.3;
const W = 800;
const H = 600;

async function capture(renderer, colorMode) {
  // colorMode: "highlight" | "replace" | "mix" → model.color = RED + mode;
  //            "none" → color API never touched (defaults, color undefined).
  const browser = await chromium.launch({
    channel: "msedge",
    headless: true,
    args: ["--enable-unsafe-webgpu"],
  });
  const page = await browser.newPage({ viewport: { width: W, height: H } });
  const consoleErrors = attachConsoleErrorGate(page);
  await page.addInitScript(errorGateInit);
  await page.goto(`${BASE}/Apps/CesiumViewer/index.html?renderer=${renderer}`, {
    waitUntil: "networkidle",
    timeout: 90000,
  });
  await page.waitForFunction(() => !!window.viewer, { timeout: 90000 });

  const info = await page.evaluate(
    async ({ modelUrl, heading, pitch, colorMode }) => {
      const C = await import("/Build/CesiumUnminified/index.js");
      const v = window.viewer;
      const scene = v.scene;

      for (const sel of [
        ".cesium-viewer-toolbar",
        ".cesium-viewer-animationContainer",
        ".cesium-viewer-timelineContainer",
        ".cesium-viewer-bottom",
        ".cesium-navigation-help",
        ".cesium-viewer-fullscreenContainer",
      ]) {
        document
          .querySelectorAll(sel)
          .forEach((e) => (e.style.display = "none"));
      }

      // Isolate the model on a black background.
      scene.globe.show = false;
      scene.skyBox.show = false;
      scene.skyAtmosphere.show = false;
      scene.backgroundColor = C.Color.BLACK;

      const modelMatrix = C.Transforms.eastNorthUpToFixedFrame(
        C.Cartesian3.fromDegrees(-75, 40, 0),
      );
      const model = await C.Model.fromGltfAsync({
        url: modelUrl,
        modelMatrix,
        scale: 4.0,
      });
      scene.primitives.add(model);
      for (let i = 0; i < 600 && !model.ready; i++) {
        scene.render();
        await new Promise((r) => requestAnimationFrame(r));
      }

      if (colorMode === "highlight") {
        model.color = C.Color.RED;
        model.colorBlendMode = C.ColorBlendMode.HIGHLIGHT;
      } else if (colorMode === "replace") {
        model.color = C.Color.RED;
        model.colorBlendMode = C.ColorBlendMode.REPLACE;
      } else if (colorMode === "mix") {
        model.color = C.Color.RED;
        model.colorBlendMode = C.ColorBlendMode.MIX;
        model.colorBlendAmount = 0.5;
      }
      // "none": don't touch the color API at all.

      v.camera.viewBoundingSphere(
        model.boundingSphere,
        new C.HeadingPitchRange(
          heading,
          pitch,
          model.boundingSphere.radius * 3.0,
        ),
      );
      v.camera.lookAtTransform(C.Matrix4.IDENTITY);
      for (let i = 0; i < 40; i++) {
        scene.render();
        await new Promise((r) => requestAnimationFrame(r));
      }
      scene.canvas.setAttribute("data-cs", "1");
      return { ready: !!model.ready };
    },
    { modelUrl: MODEL, heading: HEADING, pitch: PITCH, colorMode },
  );

  const gateArm = await armWebGPUDevices(page);
  await page.evaluate(() => new Promise((r) => setTimeout(r, 150)));
  const gate = await collectGateErrors(page);

  const png = await page
    .locator('canvas[data-cs="1"]')
    .screenshot({ type: "png" });
  const decoded = await page.evaluate(async (b64) => {
    const blob = await (await fetch(`data:image/png;base64,${b64}`)).blob();
    const bmp = await createImageBitmap(blob);
    const off = new OffscreenCanvas(bmp.width, bmp.height);
    const ctx = off.getContext("2d");
    ctx.drawImage(bmp, 0, 0);
    const d = ctx.getImageData(0, 0, bmp.width, bmp.height).data;
    return { w: bmp.width, h: bmp.height, data: Array.from(d) };
  }, Buffer.from(png).toString("base64"));

  await browser.close();
  return {
    ready: info.ready,
    gateArmed: gateArm.armed,
    gateErrors: gate.errors,
    deviceLost: gate.deviceLost,
    consoleFaults: consoleErrors,
    decoded,
  };
}

// Mean RGB over model pixels (lum > 12). Skip the top 60 rows — the
// CesiumViewer renderer-switch toolbar overlays the canvas there.
function meanModelColor(img) {
  let n = 0,
    r = 0,
    g = 0,
    b = 0;
  for (let y = 60; y < img.h; y++) {
    for (let x = 0; x < img.w; x++) {
      const i = (y * img.w + x) * 4;
      const lum = img.data[i] + img.data[i + 1] + img.data[i + 2];
      if (lum > 12) {
        n++;
        r += img.data[i];
        g += img.data[i + 1];
        b += img.data[i + 2];
      }
    }
  }
  return n
    ? {
        n,
        r: +(r / n).toFixed(1),
        g: +(g / n).toFixed(1),
        b: +(b / n).toFixed(1),
      }
    : { n: 0, r: 0, g: 0, b: 0 };
}

// Per-pixel mean channel diff over pixels where EITHER capture has model
// coverage, plus a coverage-mask mismatch pct (silhouettes must agree).
function colorDiff(a, b) {
  if (a.w !== b.w || a.h !== b.h)
    return { union: 0, maskPct: null, meanChanDiff: null };
  let union = 0,
    mismatch = 0,
    sum = 0,
    both = 0;
  for (let y = 60; y < a.h; y++) {
    for (let x = 0; x < a.w; x++) {
      const i = (y * a.w + x) * 4;
      const am = a.data[i] + a.data[i + 1] + a.data[i + 2] > 12;
      const bm = b.data[i] + b.data[i + 1] + b.data[i + 2] > 12;
      if (am || bm) {
        union++;
        if (am !== bm) mismatch++;
        if (am && bm) {
          both++;
          sum +=
            (Math.abs(a.data[i] - b.data[i]) +
              Math.abs(a.data[i + 1] - b.data[i + 1]) +
              Math.abs(a.data[i + 2] - b.data[i + 2])) /
            3;
        }
      }
    }
  }
  return {
    union,
    maskPct: union ? +((100 * mismatch) / union).toFixed(2) : null,
    meanChanDiff: both ? +(sum / both).toFixed(2) : null,
  };
}

// ── PNG encoder — shared Tools/lib/png-rgba.mjs ──
function encodePNG({ w, h, data }) {
  // `data` is a plain Array (page-side `Array.from(imageData.data)`), so it
  // needs a typed-array copy before it can go through the shared encoder.
  return encodeRgbaPng(Uint8Array.from(data), w, h);
}

// ── Captures ──
const modes = ["highlight", "replace", "mix"];
const caps = {};
for (const mode of modes) {
  caps[`webgl_${mode}`] = await capture("webgl", mode);
  caps[`webgpu_${mode}`] = await capture("webgpu", mode);
}
// Off-gate pair: WebGPU untouched vs WebGL untouched (parity of the default)
// + a second WebGPU untouched load for load-to-load determinism baseline.
caps.webgpu_none = await capture("webgpu", "none");
caps.webgpu_none2 = await capture("webgpu", "none");

const fs = await import("fs");
fs.mkdirSync("Tools/visual-regression/output", { recursive: true });
for (const [name, cap] of Object.entries(caps)) {
  fs.writeFileSync(
    `Tools/visual-regression/output/model-color-${name}.png`,
    encodePNG(cap.decoded),
  );
}

const report = { modes: {}, offGate: {} };
let pass = true;
const gateErrors = [];
let deviceLost = false;
for (const cap of Object.values(caps)) {
  gateErrors.push(...cap.gateErrors);
  deviceLost = deviceLost || cap.deviceLost;
  if (!cap.ready) pass = false;
}

// Per-mode parity: mean model color per channel within 14/255, silhouette
// mask within 12% (shape tolerance — same as the splitter probe), per-pixel
// mean channel diff over the intersection < 14.
for (const mode of modes) {
  const gl = caps[`webgl_${mode}`].decoded;
  const gpu = caps[`webgpu_${mode}`].decoded;
  const glMean = meanModelColor(gl);
  const gpuMean = meanModelColor(gpu);
  const diff = colorDiff(gl, gpu);
  const meanDelta = {
    r: +(gpuMean.r - glMean.r).toFixed(1),
    g: +(gpuMean.g - glMean.g).toFixed(1),
    b: +(gpuMean.b - glMean.b).toFixed(1),
  };
  const meanOK =
    Math.abs(meanDelta.r) < 14 &&
    Math.abs(meanDelta.g) < 14 &&
    Math.abs(meanDelta.b) < 14;
  const maskOK = diff.maskPct !== null && diff.maskPct < 12;
  const pixOK = diff.meanChanDiff !== null && diff.meanChanDiff < 14;
  // RED tint sanity: HIGHLIGHT multiplies by red / REPLACE replaces with red
  // → green+blue channels collapse on BOTH backends.
  let redOK = true;
  if (mode === "highlight" || mode === "replace") {
    redOK = gpuMean.g < 20 && gpuMean.b < 20 && glMean.g < 20 && glMean.b < 20;
  } else if (mode === "mix") {
    // LATENT VACUITY, closed 2026-08-07 (NEW-PROBE-VACUOUS-REACHABILITY-
    // ASSERTION item 5). MIX used to fall through to the `true` initializer, so
    // it carried NO mode-specific predicate at all and was covered only by the
    // cross-backend parity triple — a bug that broke MIX identically on both
    // backends passed, while the PASS banner named MIX explicitly.
    //
    // The assertion is a MECHANISM-TOGGLE control, not a new bar: MIX blends
    // the model toward red, so relative to the UNTINTED capture the milk
    // truck's green and blue must fall on BOTH backends. The margin is ZERO —
    // no fitted threshold was invented, and nothing here can fail a build in
    // which the mix does anything at all.
    const untinted = meanModelColor(caps.webgpu_none.decoded);
    redOK =
      gpuMean.g < untinted.g &&
      gpuMean.b < untinted.b &&
      glMean.g < untinted.g &&
      glMean.b < untinted.b;
  }
  const modeOK = meanOK && maskOK && pixOK && redOK;
  report.modes[mode] = {
    glMean,
    gpuMean,
    meanDelta,
    diff,
    meanOK,
    maskOK,
    pixOK,
    redOK,
    modeOK,
  };
  if (!modeOK) pass = false;
}

// Off-gate: WebGPU-untouched must match a second untouched load exactly as
// well as any two loads match each other, and (the real assertion) it must
// NOT be red-tinted — it matches the historical uncolored render.
{
  const a = caps.webgpu_none.decoded;
  const b = caps.webgpu_none2.decoded;
  const loadNoise = colorDiff(a, b);
  const noneMean = meanModelColor(a);
  // The milk truck's untinted mean has healthy green/blue (yellow cab +
  // white box) — assert the off-gate capture is NOT channel-collapsed.
  const notTinted = noneMean.g > 30 && noneMean.b > 30;
  const stable =
    loadNoise.maskPct !== null &&
    loadNoise.maskPct < 2 &&
    loadNoise.meanChanDiff !== null &&
    loadNoise.meanChanDiff < 3;
  report.offGate = { noneMean, loadNoise, notTinted, stable };
  if (!notTinted || !stable) pass = false;
}

report.gateErrors = gateErrors;
report.deviceLost = deviceLost;
if (gateErrors.length > 0 || deviceLost) pass = false;

console.log(JSON.stringify(report, null, 2));
console.log(
  pass
    ? "GATE PASS — WebGPU model.color HIGHLIGHT/REPLACE/MIX match WebGL, and the undefined-color default is untinted + stable"
    : "GATE FAIL",
);
process.exit(pass ? 0 : 1);
