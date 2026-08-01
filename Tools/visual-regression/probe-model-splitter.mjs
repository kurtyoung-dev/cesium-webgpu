/**
 * WIRE-MODEL-SPLITTER acceptance probe.
 *
 * WebGL applies `model.splitDirection` (SplitDirection.LEFT / RIGHT of the
 * split slider) via an FS discard (`ModelSplitterPipelineStage` +
 * `ModelSplitterStageFS.glsl`). This probe verifies the WebGPU wiring
 * (`MODEL_SPLIT_ENABLED` ifdef block in ModelPBRComplete.wgsl, driven by the
 * material-UB pad lanes) matches WebGL semantics:
 *
 *   1. SPLIT PARITY — with `model.splitDirection = LEFT` and
 *      `scene.splitPosition = 0.5`, BOTH backends render the same half-hidden
 *      model: model pixels exist left of mid-canvas, ~none right of it, and
 *      the per-pixel coverage masks agree within tolerance.
 *
 *   2. OFF-GATE — `splitDirection = NONE` (default) renders the full model on
 *      WebGPU (pixels on both sides), identical coverage to a capture that
 *      never touches the splitter API. Combined with the preprocess(defines=0)
 *      byte-identity proof, the feature is parity-neutral when off.
 *
 * Each capture uses a FRESH page load + a single element screenshot (WebGPU's
 * swapchain present detaches the canvas texture).
 *
 * Usage: node Tools/visual-regression/probe-model-splitter.mjs
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

async function capture(renderer, splitMode) {
  // splitMode: "left" → splitDirection=LEFT + splitPosition=0.5;
  //            "none" → splitDirection=NONE + splitPosition=0.5;
  //            "untouched" → splitter API never touched (defaults).
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
    async ({ modelUrl, heading, pitch, splitMode }) => {
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

      if (splitMode === "left") {
        scene.splitPosition = 0.5;
        model.splitDirection = C.SplitDirection.LEFT;
      } else if (splitMode === "none") {
        scene.splitPosition = 0.5;
        model.splitDirection = C.SplitDirection.NONE;
      }
      // "untouched": don't touch splitter API at all.

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
    { modelUrl: MODEL, heading: HEADING, pitch: PITCH, splitMode },
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

// Count non-black (model) pixels left / right of the split column. A small
// margin absorbs the cut-edge column: the framebuffer split sits at
// `0.5 * drawingBufferWidth` which, after DPR scaling + screenshot resample,
// can land a few pixels right of the screenshot's mid column on BOTH
// backends (verified: WebGL and WebGPU report identical right-side counts).
function halfCoverage(img, margin = 6) {
  const splitX = Math.floor(img.w / 2) + margin;
  let left = 0,
    right = 0;
  // Skip the top 60 rows — the CesiumViewer renderer-switch toolbar
  // (WebGL/WebGPU/Split buttons) overlays the canvas there and would be
  // miscounted as right-side "model" pixels.
  for (let y = 60; y < img.h; y++) {
    for (let x = 0; x < img.w; x++) {
      const i = (y * img.w + x) * 4;
      const lum = img.data[i] + img.data[i + 1] + img.data[i + 2];
      if (lum > 12) {
        if (x < splitX) left++;
        else right++;
      }
    }
  }
  return { left, right };
}

// Coverage-mask agreement between two captures (model-pixel presence, not
// color — WebGL vs WebGPU PBR shading differs slightly by design).
function maskDiff(a, b) {
  if (a.w !== b.w || a.h !== b.h) return { union: 0, mismatch: 0, pct: null };
  let union = 0,
    mismatch = 0;
  // Same top-60-row toolbar mask as halfCoverage.
  for (let y = 60; y < a.h; y++) {
    for (let x = 0; x < a.w; x++) {
      const i = (y * a.w + x) * 4;
      const am = a.data[i] + a.data[i + 1] + a.data[i + 2] > 12;
      const bm = b.data[i] + b.data[i + 1] + b.data[i + 2] > 12;
      if (am || bm) {
        union++;
        if (am !== bm) mismatch++;
      }
    }
  }
  return {
    union,
    mismatch,
    pct: union ? +((100 * mismatch) / union).toFixed(2) : null,
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
const webglLeft = await capture("webgl", "left");
const webgpuLeft = await capture("webgpu", "left");
const webgpuNone = await capture("webgpu", "none");
const webgpuUntouched = await capture("webgpu", "untouched");

const fs = await import("fs");
fs.mkdirSync("Tools/visual-regression/output", { recursive: true });
fs.writeFileSync(
  "Tools/visual-regression/output/model-splitter-webgl-left.png",
  encodePNG(webglLeft.decoded),
);
fs.writeFileSync(
  "Tools/visual-regression/output/model-splitter-webgpu-left.png",
  encodePNG(webgpuLeft.decoded),
);
fs.writeFileSync(
  "Tools/visual-regression/output/model-splitter-webgpu-none.png",
  encodePNG(webgpuNone.decoded),
);
fs.writeFileSync(
  "Tools/visual-regression/output/model-splitter-webgpu-untouched.png",
  encodePNG(webgpuUntouched.decoded),
);

const glLeftCov = halfCoverage(webglLeft.decoded);
const gpuLeftCov = halfCoverage(webgpuLeft.decoded);
const gpuNoneCov = halfCoverage(webgpuNone.decoded);
const gpuUntouchedCov = halfCoverage(webgpuUntouched.decoded);
const leftParity = maskDiff(webglLeft.decoded, webgpuLeft.decoded);
const offGate = maskDiff(webgpuNone.decoded, webgpuUntouched.decoded);

const gateErrors = [
  ...webglLeft.gateErrors,
  ...webgpuLeft.gateErrors,
  ...webgpuNone.gateErrors,
  ...webgpuUntouched.gateErrors,
];
const deviceLost =
  webgpuLeft.deviceLost || webgpuNone.deviceLost || webgpuUntouched.deviceLost;

const report = {
  webglLeft: { ready: webglLeft.ready, coverage: glLeftCov },
  webgpuLeft: {
    ready: webgpuLeft.ready,
    coverage: gpuLeftCov,
    gateArmed: webgpuLeft.gateArmed,
  },
  webgpuNone: { ready: webgpuNone.ready, coverage: gpuNoneCov },
  webgpuUntouched: { ready: webgpuUntouched.ready, coverage: gpuUntouchedCov },
  leftParity_maskDiffPct: leftParity.pct,
  offGate_maskDiffPct: offGate.pct,
  gateErrors,
  deviceLost,
  consoleFaults: [
    ...webglLeft.consoleFaults,
    ...webgpuLeft.consoleFaults,
    ...webgpuNone.consoleFaults,
    ...webgpuUntouched.consoleFaults,
  ].slice(0, 6),
};
console.log(JSON.stringify(report, null, 2));

// Gates:
//  - SPLIT works on both backends: LEFT captures have substantial model
//    coverage left of mid-canvas and ~none right of it (< 0.5% of left count).
//  - PARITY: the WebGL-LEFT vs WebGPU-LEFT coverage masks agree within 12%
//    (shape tolerance — silhouettes match; shading may differ slightly).
//  - OFF-GATE: splitDirection=NONE shows the model on BOTH sides and its
//    mask matches the untouched capture within 2%.
//  - No WebGPU device errors / device loss.
const glSplitOK =
  glLeftCov.left > 2000 && glLeftCov.right < glLeftCov.left * 0.005;
const gpuSplitOK =
  gpuLeftCov.left > 2000 && gpuLeftCov.right < gpuLeftCov.left * 0.005;
const parityOK = leftParity.pct !== null && leftParity.pct < 12;
const noneBothSides = gpuNoneCov.left > 2000 && gpuNoneCov.right > 2000;
const offGateOK = offGate.pct !== null && offGate.pct < 2;

const pass =
  webglLeft.ready &&
  webgpuLeft.ready &&
  webgpuNone.ready &&
  webgpuUntouched.ready &&
  gateErrors.length === 0 &&
  !deviceLost &&
  glSplitOK &&
  gpuSplitOK &&
  parityOK &&
  noneBothSides &&
  offGateOK;

console.log(
  JSON.stringify({ glSplitOK, gpuSplitOK, parityOK, noneBothSides, offGateOK }),
);
console.log(
  pass
    ? "GATE PASS — WebGPU model.splitDirection=LEFT hides the right half exactly like WebGL, and splitDirection=NONE is unchanged from the untouched default"
    : "GATE FAIL",
);
process.exit(pass ? 0 : 1);
