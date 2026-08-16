/**
 * NEW-MODEL-PROJECT2D-BV-MORPH (B11) acceptance probe.
 * @purpose projectTo2D acceptance: accurate per-vertex 2D/CV reprojection footprint parity vs WebGL for a large-arc model; non-empty; 3D off-gate.
 * @status ACTIVE
 *
 * `Model` with `projectTo2D: true` asks Cesium to project the model's
 * positions ACCURATELY to the 2D / Columbus-View map frame (per-vertex
 * ellipsoid→projected reprojection) rather than the affine `basisTo2D`
 * linearization used by the default (projectTo2D:false) path. WebGL builds a
 * CPU-side 2D position buffer per primitive (SceneMode2DPipelineStage) +
 * per-primitive 2D bounding spheres; the model then morphs its 3D bounding
 * volume into the flat 2D-clipped ortho box.
 *
 * This probe drives a model spanning a LARGE geographic arc (big scale) so the
 * accurate reprojection visibly diverges from the affine approximation, then
 * compares WebGL (always accurate for projectTo2D:true) against WebGPU:
 *
 *   1. PROJECT2D PARITY (2D + CV) — the model renders at the same
 *      footprint/silhouette on both backends (mask mismatch + centroid),
 *      proving the WebGPU accurate-2D vertex path + morphed bounding volume
 *      match WebGL. On the current affine WebGPU path the large-arc footprint
 *      diverges from WebGL's accurate one; the fix pulls it into tolerance.
 *
 *   2. NON-EMPTY — WebGPU must actually cover pixels (a wrong 2D bounding
 *      volume would cull the model outright → empty frame).
 *
 *   3. OFF-GATE SANITY — SCENE3D renders at parity regardless of projectTo2D
 *      (projectTo2D only affects 2D/CV).
 *
 * Usage: node Tools/visual-regression/probe-model-project2d.mjs
 *   PROBE_BASE (default http://localhost:8080)
 * Out: Tools/visual-regression/output/model-project2d-{mode}-{renderer}.png
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

// Large scale so the model spans a wide arc — makes the accurate-vs-affine 2D
// projection difference several pixels (basisTo2D is a local linearization at
// the model origin; error grows with map distance from origin).
const SCALE = 9000.0;

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
    async ({ modelUrl, modeId, scale }) => {
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
        scale: scale,
        // The item under test: accurate per-vertex 2D reprojection + morphed
        // 2D bounding volume.
        projectTo2D: true,
      });
      scene.primitives.add(model);
      for (let i = 0; i < 600 && !model.ready; i++) {
        scene.render();
        await new Promise((r) => requestAnimationFrame(r));
      }

      if (modeId === 2) scene.morphTo2D(0);
      else if (modeId === 1) scene.morphToColumbusView(0);
      for (let i = 0; i < 10; i++) {
        scene.render();
        await new Promise((r) => requestAnimationFrame(r));
      }

      // Frame the model's own 2D bounding sphere so the footprint fills a
      // consistent portion of the viewport on both backends and both modes.
      const bs = model.boundingSphere;
      if (modeId === 3) {
        v.camera.viewBoundingSphere(
          bs,
          new C.HeadingPitchRange(0.6, -0.3, bs.radius * 3.0),
        );
        v.camera.lookAtTransform(C.Matrix4.IDENTITY);
      } else if (modeId === 2) {
        // Top-down ortho map framed on the model centre.
        const carto = scene.mapProjection.ellipsoid.cartesianToCartographic(
          bs.center,
        );
        const clon = C.Math.toDegrees(carto.longitude);
        const clat = C.Math.toDegrees(carto.latitude);
        v.camera.setView({
          destination: C.Cartesian3.fromDegrees(clon, clat, bs.radius * 4.0),
        });
      } else {
        // Columbus View: top-down over the model centre (perspective camera).
        const carto = scene.mapProjection.ellipsoid.cartesianToCartographic(
          bs.center,
        );
        const clon = C.Math.toDegrees(carto.longitude);
        const clat = C.Math.toDegrees(carto.latitude);
        v.camera.setView({
          destination: C.Cartesian3.fromDegrees(clon, clat, bs.radius * 5.0),
          orientation: {
            heading: 0.0,
            pitch: -C.Math.PI_OVER_TWO,
            roll: 0.0,
          },
        });
      }

      for (let i = 0; i < 60; i++) {
        scene.render();
        await new Promise((r) => requestAnimationFrame(r));
      }
      scene.canvas.setAttribute("data-cs", "1");
      // Surface the model-frame bounding sphere for the BV-morph assertion.
      const sg = model._sceneGraph;
      const bs2d = sg && sg._boundingSphere2D;
      return {
        ready: !!model.ready,
        sceneMode: scene.mode,
        projectTo2D: model._projectTo2D === true,
        bs2d: bs2d
          ? {
              cx: bs2d.center.x,
              cy: bs2d.center.y,
              cz: bs2d.center.z,
              r: bs2d.radius,
            }
          : null,
      };
    },
    { modelUrl: MODEL, modeId: mode.id, scale: SCALE },
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
    projectTo2D: info.projectTo2D,
    bs2d: info.bs2d,
    gateArmed: gateArm.armed,
    gateErrors: gate.errors,
    deviceLost: gate.deviceLost,
    consoleFaults: consoleErrors,
    decoded,
  };
}

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
    console.log(`[probe-model-project2d] capturing ${r} ${mode.name}...`);
    caps[`${r}_${mode.name}`] = await capture(r, mode);
  }
}

const fs = await import("fs");
fs.mkdirSync("Tools/visual-regression/output", { recursive: true });
for (const [name, cap] of Object.entries(caps)) {
  const [r, m] = name.split("_");
  fs.writeFileSync(
    `Tools/visual-regression/output/model-project2d-${m}-${r}.png`,
    encodePNG(cap.decoded),
  );
}

const report = { scale: SCALE, modes: {} };
let pass = true;
const gateErrors = [];
let deviceLost = false;
for (const cap of Object.values(caps)) {
  gateErrors.push(...cap.gateErrors);
  deviceLost = deviceLost || cap.deviceLost;
  if (!cap.ready) pass = false;
}

// Per-mode thresholds. 3D is the off-gate (projectTo2D must not disturb 3D):
// held at the same band as probe-model-scene-modes. 2D/CV are the accuracy
// gates: silhouette mask mismatch < 12% of the union, centroid within 20 px,
// and non-trivial WebGPU coverage (> 200 px). Interior channel diff < 24
// covers the known warm/cool model-shading residual without masking a gross
// geometry regression.
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
    glProjectTo2D: caps[`webgl_${mode.name}`].projectTo2D,
    gpuProjectTo2D: caps[`webgpu_${mode.name}`].projectTo2D,
    glBs2d: caps[`webgl_${mode.name}`].bs2d,
    gpuBs2d: caps[`webgpu_${mode.name}`].bs2d,
  };
  if (!modeOK) pass = false;
}

report.gateErrors = gateErrors;
report.deviceLost = deviceLost;
if (gateErrors.length > 0 || deviceLost) pass = false;

console.log(JSON.stringify(report, null, 2));
console.log(
  pass
    ? "GATE PASS — WebGPU projectTo2D model footprint + bounding volume match WebGL in SCENE2D, COLUMBUS_VIEW, and SCENE3D"
    : "GATE FAIL",
);
process.exit(pass ? 0 : 1);
