/**
 * MODEL-SCENE-MODES acceptance probe.
 *
 * WebGL renders glTF models in SCENE2D / COLUMBUS_VIEW by swapping the draw
 * command's model matrix to the scene graph's projected-frame
 * `_computedModelMatrix2D` (Transforms.basisTo2D — ModelMatrixUpdateStage.js)
 * and carrying a 2D-frame bounding volume. This probe verifies the WebGPU
 * port (mode-aware `modelMatrix` + `commandBoundingVolume` pick in
 * WebGPUModelRenderer.js):
 *
 *   1. MODE PARITY — the milk truck in SCENE2D and COLUMBUS_VIEW renders at
 *      the same screen position/footprint on both backends: silhouette-mask
 *      mismatch and per-pixel mean channel diff within tolerance, and the
 *      model actually covers pixels (non-empty) on WebGPU.
 *
 *   2. 3D OFF-GATE — SCENE3D renders at parity (the mode gate short-circuits
 *      to the exact pre-change matrix/BV expressions in 3D), asserted by the
 *      same WebGL-vs-WebGPU diff on the 3D leg.
 *
 * Each capture uses a FRESH page load + a single element screenshot (WebGPU's
 * swapchain present detaches the canvas texture).
 *
 * Usage: node Tools/visual-regression/probe-model-scene-modes.mjs
 *   PROBE_BASE (default http://localhost:8080)
 * Out: Tools/visual-regression/output/model-scene-modes-{mode}-{renderer}.png
 */
import { chromium } from "playwright";
import zlib from "zlib";
import {
  errorGateInit,
  armWebGPUDevices,
  collectGateErrors,
  attachConsoleErrorGate,
} from "../lib/webgpu-error-gate.mjs";

const BASE = process.env.PROBE_BASE || "http://localhost:8080";
const MODEL = "/Apps/SampleData/models/CesiumMilkTruck/CesiumMilkTruck.glb";

const W = 800;
const H = 600;

// SceneMode ids: 1=COLUMBUS_VIEW, 2=SCENE2D, 3=SCENE3D
const MODES = [
  { name: "3d", id: 3 },
  { name: "2d", id: 2 },
  { name: "cv", id: 1 },
];

async function capture(renderer, mode) {
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
    async ({ modelUrl, modeId }) => {
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

      const lon = -75;
      const lat = 40;
      const modelMatrix = C.Transforms.eastNorthUpToFixedFrame(
        C.Cartesian3.fromDegrees(lon, lat, 0),
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

      // Flip scene mode instantly, then settle a few frames before placing
      // the camera (mode flip resets the camera).
      if (modeId === 2) scene.morphTo2D(0);
      else if (modeId === 1) scene.morphToColumbusView(0);
      for (let i = 0; i < 10; i++) {
        scene.render();
        await new Promise((r) => requestAnimationFrame(r));
      }

      if (modeId === 3) {
        v.camera.viewBoundingSphere(
          model.boundingSphere,
          new C.HeadingPitchRange(0.6, -0.3, model.boundingSphere.radius * 3.0),
        );
        v.camera.lookAtTransform(C.Matrix4.IDENTITY);
      } else if (modeId === 2) {
        // Top-down ortho map: height maps to view extent.
        v.camera.setView({
          destination: C.Cartesian3.fromDegrees(lon, lat, 250.0),
        });
      } else {
        // CV: view the truck from the south, pitched down.
        v.camera.setView({
          destination: C.Cartesian3.fromDegrees(lon, lat - 0.002, 120.0),
          orientation: { heading: 0.0, pitch: -0.5, roll: 0.0 },
        });
      }

      for (let i = 0; i < 60; i++) {
        scene.render();
        await new Promise((r) => requestAnimationFrame(r));
      }
      scene.canvas.setAttribute("data-cs", "1");
      return { ready: !!model.ready, sceneMode: scene.mode };
    },
    { modelUrl: MODEL, modeId: mode.id },
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
    sceneMode: info.sceneMode,
    gateArmed: gateArm.armed,
    gateErrors: gate.errors,
    deviceLost: gate.deviceLost,
    consoleFaults: consoleErrors,
    decoded,
  };
}

// Model-pixel count + centroid (lum > 12), skipping the top 60 rows (viewer
// toolbar overlay area).
function coverage(img) {
  let n = 0,
    sx = 0,
    sy = 0;
  for (let y = 60; y < img.h; y++) {
    for (let x = 0; x < img.w; x++) {
      const i = (y * img.w + x) * 4;
      if (img.data[i] + img.data[i + 1] + img.data[i + 2] > 12) {
        n++;
        sx += x;
        sy += y;
      }
    }
  }
  return n
    ? { n, cx: +(sx / n).toFixed(1), cy: +(sy / n).toFixed(1) }
    : { n: 0, cx: null, cy: null };
}

// Silhouette-mask mismatch over the union + per-pixel mean channel diff over
// the intersection (same metrics as probe-model-color), plus an INTERIOR
// channel diff computed only over intersection pixels whose 4-neighbourhood
// is also fully in the intersection. On the small 2D/CV footprints (~1700 px)
// antialiased silhouette-edge pixels against the black background are a large
// fraction of the mask and inflate the raw channel diff; eroding to the
// interior isolates the true surface-shading delta so the assert tracks the
// same pre-existing backend shading gap the 3D leg measures (~13/255 mean),
// not edge-AA noise.
function maskDiff(a, b) {
  if (a.w !== b.w || a.h !== b.h)
    return { union: 0, maskPct: null, meanChanDiff: null, interiorDiff: null };
  const isBoth = (x, y) => {
    const i = (y * a.w + x) * 4;
    return (
      a.data[i] + a.data[i + 1] + a.data[i + 2] > 12 &&
      b.data[i] + b.data[i + 1] + b.data[i + 2] > 12
    );
  };
  let union = 0,
    mismatch = 0,
    sum = 0,
    both = 0,
    interiorSum = 0,
    interior = 0;
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
          const d =
            (Math.abs(a.data[i] - b.data[i]) +
              Math.abs(a.data[i + 1] - b.data[i + 1]) +
              Math.abs(a.data[i + 2] - b.data[i + 2])) /
            3;
          sum += d;
          if (
            y > 60 &&
            y < a.h - 1 &&
            x > 0 &&
            x < a.w - 1 &&
            isBoth(x - 1, y) &&
            isBoth(x + 1, y) &&
            isBoth(x, y - 1) &&
            isBoth(x, y + 1)
          ) {
            interior++;
            interiorSum += d;
          }
        }
      }
    }
  }
  return {
    union,
    maskPct: union ? +((100 * mismatch) / union).toFixed(2) : null,
    meanChanDiff: both ? +(sum / both).toFixed(2) : null,
    interior,
    interiorDiff: interior ? +(interiorSum / interior).toFixed(2) : null,
  };
}

// ── PNG encoder (zlib deflate) — zero external dep ──
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++)
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function encodePNG({ w, h, data }) {
  const bpr = w * 4;
  const raw = Buffer.alloc((bpr + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (bpr + 1)] = 0;
    Buffer.from(data.slice(y * bpr, (y + 1) * bpr)).copy(
      raw,
      y * (bpr + 1) + 1,
    );
  }
  const idat = zlib.deflateSync(raw);
  const chunk = (type, body) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(body.length, 0);
    const tb = Buffer.from(type, "ascii");
    const crcBuf = Buffer.alloc(4);
    crcBuf.writeUInt32BE(crc32(Buffer.concat([tb, body])), 0);
    return Buffer.concat([len, tb, body, crcBuf]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", idat),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// ── Captures ──
const caps = {};
for (const mode of MODES) {
  for (const r of ["webgl", "webgpu"]) {
    console.log(`[probe-model-scene-modes] capturing ${r} ${mode.name}...`);
    caps[`${r}_${mode.name}`] = await capture(r, mode);
  }
}

const fs = await import("fs");
fs.mkdirSync("Tools/visual-regression/output", { recursive: true });
for (const [name, cap] of Object.entries(caps)) {
  fs.writeFileSync(
    `Tools/visual-regression/output/model-scene-modes-${name.replace("_", "-").split("-").reverse().join("-")}.png`,
    encodePNG(cap.decoded),
  );
}

const report = { modes: {} };
let pass = true;
const gateErrors = [];
let deviceLost = false;
for (const cap of Object.values(caps)) {
  gateErrors.push(...cap.gateErrors);
  deviceLost = deviceLost || cap.deviceLost;
  if (!cap.ready) pass = false;
}

// Per-mode parity thresholds: silhouette mask mismatch < 12% of the union
// (same shape tolerance as probe-model-color / probe-model-splitter),
// interior (edge-eroded) mean channel diff < 24, and WebGPU coverage
// non-trivial (> 200 px) so an "everything culled" regression can't sneak
// through a trivially matching empty pair. Position/footprint (the actual
// scene-mode acceptance) is held tight: mask + 20 px centroid.
//
// Interior-diff calibration (2026-07-02): the backends carry a pre-existing
// warm-vs-cool model shading residual (WebGPU +R/−B vs WebGL — the known
// atmosphere/IBL tint parity gap, NOT scene-mode related). Measured per-mode
// channel means show the SAME signature in every mode, scaling with surface
// brightness: 3D leg (mean lum ~107) → interiorDiff 13.0; CV (~129) → 14.3;
// 2D top-down white roof (~181) → 20.6. 24 covers that brightness-scaled
// baseline with headroom while still failing a gross wrong-lighting /
// wrong-normal-matrix / wrong-texture regression (those measure 60+).
for (const mode of MODES) {
  const gl = caps[`webgl_${mode.name}`].decoded;
  const gpu = caps[`webgpu_${mode.name}`].decoded;
  const glCov = coverage(gl);
  const gpuCov = coverage(gpu);
  const diff = maskDiff(gl, gpu);
  const covOK = gpuCov.n > 200 && glCov.n > 200;
  const maskOK = diff.maskPct !== null && diff.maskPct < 12;
  const pixOK = diff.interiorDiff !== null && diff.interiorDiff < 24;
  const centroidOK =
    covOK &&
    Math.abs(gpuCov.cx - glCov.cx) < 20 &&
    Math.abs(gpuCov.cy - glCov.cy) < 20;
  const modeOK = covOK && maskOK && pixOK && centroidOK;
  report.modes[mode.name] = {
    glCov,
    gpuCov,
    diff,
    covOK,
    maskOK,
    pixOK,
    centroidOK,
    modeOK,
    glSceneMode: caps[`webgl_${mode.name}`].sceneMode,
    gpuSceneMode: caps[`webgpu_${mode.name}`].sceneMode,
  };
  if (!modeOK) pass = false;
}

report.gateErrors = gateErrors;
report.deviceLost = deviceLost;
if (gateErrors.length > 0 || deviceLost) pass = false;

console.log(JSON.stringify(report, null, 2));
console.log(
  pass
    ? "GATE PASS — WebGPU model position/footprint matches WebGL in SCENE2D, COLUMBUS_VIEW, and SCENE3D"
    : "GATE FAIL",
);
process.exit(pass ? 0 : 1);
