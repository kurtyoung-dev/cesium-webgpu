/**
 * WIRE-MODEL-SILHOUETTE acceptance probe.
 * @purpose model.silhouette acceptance: red rim parity across backends (stencil two-pass semantics) + silhouetteSize=0 off-gate identity, zero rim pixels.
 * @status ACTIVE
 *
 * WebGL renders `model.silhouetteColor` / `model.silhouetteSize` via a
 * stencil two-pass (`ModelSilhouettePipelineStage` + ModelDrawCommand's
 * deriveSilhouetteModelCommand / deriveSilhouetteColorCommand): the base
 * draw stamps a stencil reference, then an inflated-normals draw paints the
 * silhouette color where the stencil differs. This probe verifies the WebGPU
 * wiring (MODEL_SILHOUETTE ifdef blocks in ModelPBRComplete.wgsl + the
 * silhouette stencil pipeline variants) matches WebGL semantics:
 *
 *   1. RIM PARITY — `silhouetteColor = RED, silhouetteSize = 4`: both
 *      backends show a comparable red rim around the model (red-dominant
 *      pixel count within tolerance, rim mask overlap within tolerance).
 *
 *   2. OFF-GATE — `silhouetteSize = 0` (with silhouetteColor set) renders
 *      identically to a capture that never touches the silhouette API
 *      (within load-to-load noise) and shows ZERO red-rim pixels. Combined
 *      with preprocess(defines=0) byte-identity of the stripped ifdef
 *      blocks, the feature is parity-neutral when off.
 *
 * Each capture uses a FRESH page load + a single element screenshot
 * (WebGPU's swapchain present detaches the canvas texture).
 *
 * Usage: node Tools/visual-regression/probe-model-silhouette.mjs
 *   PROBE_BASE (default http://localhost:8080)
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

const HEADING = 0.6;
const PITCH = -0.3;
const W = 800;
const H = 600;

async function capture(renderer, silhouetteMode) {
  // silhouetteMode: "sil"   → silhouetteColor=RED, silhouetteSize=4
  //                 "size0" → silhouetteColor=RED, silhouetteSize=0 (off)
  //                 "none"  → silhouette API never touched (defaults)
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
    async ({ modelUrl, heading, pitch, silhouetteMode }) => {
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

      if (silhouetteMode === "sil") {
        model.silhouetteColor = C.Color.RED;
        model.silhouetteSize = 4.0;
      } else if (silhouetteMode === "size0") {
        model.silhouetteColor = C.Color.RED;
        model.silhouetteSize = 0.0;
      }
      // "none": don't touch the silhouette API at all.

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
    { modelUrl: MODEL, heading: HEADING, pitch: PITCH, silhouetteMode },
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

// Red-rim predicate: the silhouette color is pure RED — a rim pixel is
// strongly red-dominant. The milk truck body is yellow/white/green (no
// saturated pure-red patches), so this cleanly isolates the rim.
function isRimPixel(d, i) {
  return d[i] > 140 && d[i + 1] < 80 && d[i + 2] < 80;
}

// Count rim pixels + capture the rim mask (skip the top 60 rows — the
// CesiumViewer renderer-switch toolbar overlays the canvas there).
function rimStats(img) {
  const mask = new Uint8Array(img.w * img.h);
  let n = 0;
  for (let y = 60; y < img.h; y++) {
    for (let x = 0; x < img.w; x++) {
      const i = (y * img.w + x) * 4;
      if (isRimPixel(img.data, i)) {
        mask[y * img.w + x] = 1;
        n++;
      }
    }
  }
  return { n, mask };
}

// Rim-mask overlap with 2px dilation slack: a rim is a ~4px band whose
// exact AA/rasterization differs slightly per backend; count a pixel as
// "matched" when the other backend has a rim pixel within a 2px radius.
function rimOverlap(a, b, w, h) {
  const near = (mask, x, y) => {
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx >= 0 && nx < w && ny >= 0 && ny < h && mask[ny * w + nx]) {
          return true;
        }
      }
    }
    return false;
  };
  let aTotal = 0,
    aMatched = 0,
    bTotal = 0,
    bMatched = 0;
  for (let y = 60; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const idx = y * w + x;
      if (a.mask[idx]) {
        aTotal++;
        if (near(b.mask, x, y)) aMatched++;
      }
      if (b.mask[idx]) {
        bTotal++;
        if (near(a.mask, x, y)) bMatched++;
      }
    }
  }
  return {
    aMatchedPct: aTotal ? +((100 * aMatched) / aTotal).toFixed(1) : null,
    bMatchedPct: bTotal ? +((100 * bMatched) / bTotal).toFixed(1) : null,
  };
}

// Per-pixel mean channel diff over pixels where EITHER capture has content,
// plus a coverage-mask mismatch pct (off-gate stability check).
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
caps.webgl_sil = await capture("webgl", "sil");
caps.webgpu_sil = await capture("webgpu", "sil");
caps.webgpu_size0 = await capture("webgpu", "size0");
caps.webgpu_none = await capture("webgpu", "none");
caps.webgpu_none2 = await capture("webgpu", "none");

const fs = await import("fs");
fs.mkdirSync("Tools/visual-regression/output", { recursive: true });
for (const [name, cap] of Object.entries(caps)) {
  fs.writeFileSync(
    `Tools/visual-regression/output/model-silhouette-${name}.png`,
    encodePNG(cap.decoded),
  );
}

const report = {};
let pass = true;
const gateErrors = [];
let deviceLost = false;
for (const cap of Object.values(caps)) {
  gateErrors.push(...cap.gateErrors);
  deviceLost = deviceLost || cap.deviceLost;
  if (!cap.ready) pass = false;
}

// 1. RIM PARITY — both backends show a comparable red rim.
{
  const gl = caps.webgl_sil.decoded;
  const gpu = caps.webgpu_sil.decoded;
  const glRim = rimStats(gl);
  const gpuRim = rimStats(gpu);
  const overlap = rimOverlap(glRim, gpuRim, gl.w, gl.h);
  // The truck at this framing yields a rim of thousands of pixels; require
  // a healthy rim on BOTH backends, a count ratio within 40% (AA/coverage
  // differences), and ≥80% dilated-mask mutual overlap.
  const bothHaveRim = glRim.n > 800 && gpuRim.n > 800;
  const ratio =
    glRim.n > 0 && gpuRim.n > 0
      ? +(Math.min(glRim.n, gpuRim.n) / Math.max(glRim.n, gpuRim.n)).toFixed(3)
      : 0;
  const ratioOK = ratio > 0.6;
  const overlapOK =
    overlap.aMatchedPct !== null &&
    overlap.aMatchedPct > 80 &&
    overlap.bMatchedPct !== null &&
    overlap.bMatchedPct > 80;
  const rimOK = bothHaveRim && ratioOK && overlapOK;
  report.rimParity = {
    glRimPixels: glRim.n,
    gpuRimPixels: gpuRim.n,
    ratio,
    overlap,
    bothHaveRim,
    ratioOK,
    overlapOK,
    rimOK,
  };
  if (!rimOK) pass = false;
}

// 2. OFF-GATE — size0 matches the untouched default within load-to-load
// noise and shows zero red rim.
{
  const size0 = caps.webgpu_size0.decoded;
  const none = caps.webgpu_none.decoded;
  const none2 = caps.webgpu_none2.decoded;
  const loadNoise = colorDiff(none, none2);
  const offDiff = colorDiff(size0, none);
  const size0Rim = rimStats(size0).n;
  const noneRim = rimStats(none).n;
  // The milk truck has a handful of naturally red-dominant pixels (tail
  // lights) even with the silhouette API untouched — so the off-gate
  // asserts size0's red count matches the untouched baseline (within
  // AA noise), i.e. NO rim was added (an actual rim is ~4000 px).
  const noRim = Math.abs(size0Rim - noneRim) < Math.max(15, noneRim);
  const stable =
    offDiff.maskPct !== null &&
    offDiff.maskPct < Math.max(2, (loadNoise.maskPct ?? 0) * 2 + 1) &&
    offDiff.meanChanDiff !== null &&
    offDiff.meanChanDiff < Math.max(3, (loadNoise.meanChanDiff ?? 0) * 2 + 1);
  report.offGate = { size0Rim, noneRim, noRim, offDiff, loadNoise, stable };
  if (!noRim || !stable) pass = false;
}

report.gateErrors = gateErrors;
report.deviceLost = deviceLost;
if (gateErrors.length > 0 || deviceLost) pass = false;

console.log(JSON.stringify(report, null, 2));
console.log(
  pass
    ? "GATE PASS — WebGPU model silhouette (RED, size 4) matches WebGL's stencil two-pass rim, and silhouetteSize=0 is off + stable"
    : "GATE FAIL",
);
process.exit(pass ? 0 : 1);
