/**
 * GLTF-POINTS-MODE acceptance probe.
 *
 * A glTF whose primitive has `mode: 0` (POINTS) must render on BOTH backends.
 * WebGL consumes `primitive.primitiveType` via `PrimitiveRenderResources` →
 * `DrawCommand.primitiveType` and draws gl.POINTS with `gl_PointSize = 1.0`
 * (ModelVS.glsl, no styling). WebGPU historically hardcoded triangle-list in
 * every model pipeline, so POINTS primitives rasterized garbage/nothing. The
 * fix threads a "point-list" GPUPrimitiveTopology (keyed off the extracted
 * `geometry.primitiveType`) through `WebGPUModelPipelineCache`.
 *
 * Asset: Specs/Data/Models/glTF-2.0/PointCloudWithRGBColors (2500 points in a
 * unit cube, POSITION + COLOR_0, non-indexed, mode 0).
 *
 * Gates:
 *   1. SIGNATURE PIXELS — both backends light up a healthy number of point
 *      pixels (> 200) against the isolated black background.
 *   2. CROSS-BACKEND PARITY — coverage ratio within 2x (1px point raster +
 *      FXAA differ slightly per backend), mean point color per channel within
 *      tolerance, and the lit-pixel centroid within a few pixels (same cube,
 *      same camera).
 *   3. ERROR GATE — no WebGPU validation errors / device loss / console
 *      faults (a triangle-list pipeline fed point data would not error, but a
 *      broken point-list pipeline would).
 *
 * Usage: node Tools/visual-regression/probe-gltf-points-mode.mjs
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
const MODEL =
  "/Specs/Data/Models/glTF-2.0/PointCloudWithRGBColors/glTF-Binary/PointCloudWithRGBColors.glb";

const HEADING = 0.6;
const PITCH = -0.35;
const W = 800;
const H = 600;

async function capture(renderer) {
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
    async ({ modelUrl, heading, pitch }) => {
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

      // Isolate the point cloud on a black background.
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
        scale: 100.0,
      });
      scene.primitives.add(model);
      for (let i = 0; i < 600 && !model.ready; i++) {
        scene.render();
        await new Promise((r) => requestAnimationFrame(r));
      }

      v.camera.viewBoundingSphere(
        model.boundingSphere,
        new C.HeadingPitchRange(
          heading,
          pitch,
          model.boundingSphere.radius * 2.5,
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
    { modelUrl: MODEL, heading: HEADING, pitch: PITCH },
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

// Lit-pixel stats (lum > 12), skipping the top 60 rows (renderer-switch
// toolbar overlay). Returns count, mean RGB, and centroid.
function pointStats(img) {
  let n = 0,
    r = 0,
    g = 0,
    b = 0,
    cx = 0,
    cy = 0;
  for (let y = 60; y < img.h; y++) {
    for (let x = 0; x < img.w; x++) {
      const i = (y * img.w + x) * 4;
      const lum = img.data[i] + img.data[i + 1] + img.data[i + 2];
      if (lum > 12) {
        n++;
        r += img.data[i];
        g += img.data[i + 1];
        b += img.data[i + 2];
        cx += x;
        cy += y;
      }
    }
  }
  return n
    ? {
        n,
        r: +(r / n).toFixed(1),
        g: +(g / n).toFixed(1),
        b: +(b / n).toFixed(1),
        cx: +(cx / n).toFixed(1),
        cy: +(cy / n).toFixed(1),
      }
    : { n: 0, r: 0, g: 0, b: 0, cx: 0, cy: 0 };
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
const gl = await capture("webgl");
const gpu = await capture("webgpu");

const fs = await import("fs");
fs.mkdirSync("Tools/visual-regression/output", { recursive: true });
fs.writeFileSync(
  "Tools/visual-regression/output/gltf-points-webgl.png",
  encodePNG(gl.decoded),
);
fs.writeFileSync(
  "Tools/visual-regression/output/gltf-points-webgpu.png",
  encodePNG(gpu.decoded),
);

const glStats = pointStats(gl.decoded);
const gpuStats = pointStats(gpu.decoded);

const sigOK = glStats.n > 200 && gpuStats.n > 200;
const ratio = glStats.n > 0 ? gpuStats.n / glStats.n : 0;
const ratioOK = ratio > 0.5 && ratio < 2.0;
const meanDelta = {
  r: +(gpuStats.r - glStats.r).toFixed(1),
  g: +(gpuStats.g - glStats.g).toFixed(1),
  b: +(gpuStats.b - glStats.b).toFixed(1),
};
const meanOK =
  Math.abs(meanDelta.r) < 30 &&
  Math.abs(meanDelta.g) < 30 &&
  Math.abs(meanDelta.b) < 30;
const centroidDist = Math.hypot(
  gpuStats.cx - glStats.cx,
  gpuStats.cy - glStats.cy,
);
const centroidOK = centroidDist < 20;

const gateErrors = [...gl.gateErrors, ...gpu.gateErrors];
const consoleFaults = [...gl.consoleFaults, ...gpu.consoleFaults];
const deviceLost = gl.deviceLost || gpu.deviceLost;
const errorsOK = gateErrors.length === 0 && !deviceLost;

const pass =
  gl.ready && gpu.ready && sigOK && ratioOK && meanOK && centroidOK && errorsOK;

console.log(
  JSON.stringify(
    {
      glStats,
      gpuStats,
      ratio: +ratio.toFixed(3),
      meanDelta,
      centroidDist: +centroidDist.toFixed(1),
      sigOK,
      ratioOK,
      meanOK,
      centroidOK,
      gateErrors,
      consoleFaults,
      deviceLost,
    },
    null,
    2,
  ),
);
console.log(
  pass
    ? "GATE PASS — POINTS-mode glTF renders points on both backends within tolerance"
    : "GATE FAIL",
);
process.exit(pass ? 0 : 1);
