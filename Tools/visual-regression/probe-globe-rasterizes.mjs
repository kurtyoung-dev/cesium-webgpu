#!/usr/bin/env node
// Probe: verify the WebGPU globe actually RASTERIZES (BUG-11 staleness check).
//
// BUG-11 in the inventory claims "globe geometry never rasterizes; depth
// uniformly 1.0". This probe loads the default CesiumViewer on BOTH backends,
// lets the globe settle, captures the CANVAS pixels (not the page chrome), and
// reports:
//   - non-background pixel count + coverage % (is the globe actually drawn?)
//   - mean luminance + a coarse color histogram (terrain/imagery vs flat fill)
//   - depth-buffer min/max via CesiumDebug.showDepth-style sampling if available
//   - WebGPU error gate (uncaptured GPU errors / device loss)
//
// Verdict pass = WebGPU canvas shows a visibly-rendered globe (substantial
// non-background coverage that roughly matches WebGL), NOT a black/empty frame.
//
// Usage: node Tools/visual-regression/probe-globe-rasterizes.mjs
// Env:   PROBE_BASE (default http://localhost:8134)
// Out:   Tools/visual-regression/output/globe-rasterizes-{webgpu,webgl}.png

import { chromium } from "playwright";
import fs from "fs";
import path from "path";
import {
  errorGateInit,
  armWebGPUDevices,
  collectGateErrors,
  attachConsoleErrorGate,
} from "../lib/webgpu-error-gate.mjs";

const BASE = process.env.PROBE_BASE || "http://localhost:8134";
const OUT_DIR = "Tools/visual-regression/output";

async function capture(rendererArg) {
  const browser = await chromium.launch({
    channel: "msedge",
    headless: true,
    args: ["--enable-unsafe-webgpu"],
  });
  const page = await browser.newPage({
    viewport: { width: 1280, height: 720 },
  });
  const consoleErrors = attachConsoleErrorGate(page);
  await page.addInitScript(errorGateInit);

  const url = `${BASE}/Apps/CesiumViewer/index.html?renderer=${rendererArg}`;
  await page.goto(url, { waitUntil: "networkidle" });
  await page.waitForFunction(() => !!window.viewer);
  await armWebGPUDevices(page);

  // Settle: render many frames so tiles + imagery finish loading.
  await page.evaluate(async () => {
    const v = window.viewer;
    for (let i = 0; i < 300; i++) {
      v.scene.render();
      await new Promise((r) => requestAnimationFrame(r));
    }
  });
  await page.waitForTimeout(2500);
  // Arm again in case the device was (re)created after first arm.
  await armWebGPUDevices(page);

  // Read the actual WebGPU/WebGL canvas pixels directly (not the page
  // screenshot, which can include the picker chrome). We draw the canvas
  // into a 2D canvas and read ImageData. For WebGPU the on-screen canvas is
  // the configured context surface; toDataURL works after a render with
  // preserveDrawingBuffer-equivalent (Cesium copies to the canvas).
  const canvasStats = await page.evaluate(() => {
    const v = window.viewer;
    const cvs = v.scene.canvas;
    const w = cvs.width;
    const h = cvs.height;
    const tmp = document.createElement("canvas");
    tmp.width = w;
    tmp.height = h;
    const ctx = tmp.getContext("2d");
    ctx.drawImage(cvs, 0, 0, w, h);
    let data;
    try {
      data = ctx.getImageData(0, 0, w, h).data;
    } catch (e) {
      return { error: "getImageData failed: " + e.message, w, h };
    }
    const total = w * h;
    let nonBg = 0;
    let sumLum = 0;
    let blueish = 0; // sky/ocean
    let greenish = 0; // land
    let brownish = 0; // terrain
    let near0 = 0; // pure black
    for (let i = 0; i < data.length; i += 4) {
      const r = data[i],
        g = data[i + 1],
        b = data[i + 2];
      const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      sumLum += lum;
      if (lum < 8) near0++;
      // "non-background": anything not near-black. The Cesium default
      // background is black behind the globe.
      if (lum >= 8) nonBg++;
      if (b > r + 15 && b > g + 5) blueish++;
      if (g > r + 10 && g > b + 10) greenish++;
      if (r > b + 20 && g > b + 10 && r > 40) brownish++;
    }
    return {
      w,
      h,
      total,
      nonBgPx: nonBg,
      nonBgPct: +((100 * nonBg) / total).toFixed(2),
      near0Px: near0,
      near0Pct: +((100 * near0) / total).toFixed(2),
      meanLum: +(sumLum / total).toFixed(2),
      blueishPx: blueish,
      greenishPx: greenish,
      brownishPx: brownish,
    };
  });

  // Depth check: try CesiumDebug.showDepth, else sample depth uniformity.
  // pickPosition reads the depth buffer at the center pixel: if depth is
  // uniformly 1.0 (the BUG-11 symptom) it returns undefined; if the globe
  // rasterized, it returns a cartesian on the globe surface (~6.37e6 mag).
  const depthInfo = await page.evaluate(async () => {
    const out = {
      hasCesiumDebug: !!window.CesiumDebug,
      hasShowDepth: false,
      note: null,
    };
    try {
      if (
        window.CesiumDebug &&
        typeof window.CesiumDebug.showDepth === "function"
      ) {
        out.hasShowDepth = true;
      }
    } catch (e) {
      out.note = "depth probe error: " + e.message;
    }
    try {
      const v = window.viewer;
      const scene = v.scene;
      const C = await import("/Build/CesiumUnminified/index.js");
      // Sample a 3x3 grid; the globe fills the center so several should hit.
      const w = scene.canvas.clientWidth;
      const h = scene.canvas.clientHeight;
      const pts = [
        [0.5, 0.5],
        [0.4, 0.4],
        [0.6, 0.6],
        [0.5, 0.4],
        [0.5, 0.6],
      ];
      const hits = [];
      for (const [fx, fy] of pts) {
        const px = new C.Cartesian2(w * fx, h * fy);
        let picked;
        try {
          picked = scene.pickPosition(px);
        } catch (e) {
          picked = undefined;
        }
        if (picked) {
          hits.push(+Math.hypot(picked.x, picked.y, picked.z).toFixed(0));
        }
      }
      out.depthSupported = scene.pickPositionSupported;
      out.pickHits = hits;
      out.pickHitCount = hits.length;
      out.depthNonUniform = hits.length > 0; // a non-1.0 depth produced a real position
    } catch (e) {
      out.pickNote = "pickPosition error: " + e.message;
    }
    return out;
  });

  const out = path.join(OUT_DIR, `globe-rasterizes-${rendererArg}.png`);
  // Screenshot only the canvas element so we get the rendered globe, not chrome.
  const handle = await page.$("canvas");
  if (handle) {
    await handle.screenshot({ path: out });
  } else {
    await page.screenshot({ path: out });
  }

  const gate = await collectGateErrors(page);

  // The in-page getImageData on a GPU canvas returns blank; decode the
  // captured PNG (compositor output) for REAL coverage numbers.
  const pngStats = await page.evaluate(async (b64) => {
    const img = new Image();
    img.src = "data:image/png;base64," + b64;
    await img.decode();
    const c = document.createElement("canvas");
    c.width = img.naturalWidth;
    c.height = img.naturalHeight;
    const cx = c.getContext("2d");
    cx.drawImage(img, 0, 0);
    const data = cx.getImageData(0, 0, c.width, c.height).data;
    const total = c.width * c.height;
    let nonBg = 0,
      sumLum = 0,
      blueish = 0,
      greenish = 0,
      brownish = 0;
    for (let i = 0; i < data.length; i += 4) {
      const r = data[i],
        g = data[i + 1],
        b = data[i + 2];
      const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      sumLum += lum;
      if (lum >= 8) nonBg++;
      if (b > r + 15 && b > g + 5) blueish++;
      if (g > r + 10 && g > b + 10) greenish++;
      if (r > b + 20 && g > b + 10 && r > 40) brownish++;
    }
    return {
      w: c.width,
      h: c.height,
      total,
      nonBgPx: nonBg,
      nonBgPct: +((100 * nonBg) / total).toFixed(2),
      meanLum: +(sumLum / total).toFixed(2),
      blueishPx: blueish,
      greenishPx: greenish,
      brownishPx: brownish,
    };
  }, fs.readFileSync(out).toString("base64"));

  await browser.close();

  return { out, canvasStats, pngStats, depthInfo, gate, consoleErrors };
}

(async () => {
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
  const results = {};
  for (const r of ["webgpu", "webgl"]) {
    console.log(`[globe-rasterizes] capturing ${r} ...`);
    const res = await capture(r);
    results[r] = res;
    console.log(`  png:        ${res.out}`);
    console.log(`  pngStats:   ${JSON.stringify(res.pngStats)}`);
    console.log(`  depth/pick: ${JSON.stringify(res.depthInfo)}`);
    console.log(
      `  gate:       armed=${res.gate.armedDevices} errors=${res.gate.errors.length} deviceLost=${res.gate.deviceLost || "no"}`,
    );
    if (res.gate.errors.length)
      res.gate.errors.slice(0, 5).forEach((e) => console.log(`    GATE: ${e}`));
    if (res.consoleErrors.length)
      res.consoleErrors
        .slice(0, 5)
        .forEach((e) => console.log(`    CONSOLE: ${e}`));
  }
  console.log("[globe-rasterizes] done");
})();
