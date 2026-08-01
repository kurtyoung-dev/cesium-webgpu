#!/usr/bin/env node
// Probe (BUG-1): verify the stars (skyBox), sun, and atmosphere limb render
// on WebGPU and match WebGL. Camera is parked far out in space looking at the
// limb of the Earth so the skybox/stars fill much of the frame. We pin the
// clock so the star field + sun position are deterministic, then capture both
// backends and pixel-diff them.
//
// Pass criterion: WebGPU shows star points in the black background + the
// atmosphere limb arc, visually matching WebGL.
//
// Usage:
//   PROBE_BASE=http://localhost:8134 node Tools/visual-regression/probe-skybox-stars-sun.mjs
// Outputs:
//   Tools/visual-regression/output/skybox-stars-sun-{webgl,webgpu}.png

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

// Far out in space. ~5e7 m above (0,0) puts the camera well beyond GEO, so the
// Earth is a small-ish disc surrounded by skybox/stars on a black background.
const VIEW = { lon: 0, lat: 0, height: 5.0e7 };

async function capture(rendererArg) {
  const browser = await chromium.launch({
    channel: "msedge",
    headless: true,
    args: [
      "--enable-unsafe-webgpu",
      "--enable-features=Vulkan",
      "--use-vulkan",
    ],
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

  const meta = await page.evaluate(async (view) => {
    const C = await import("/Build/CesiumUnminified/index.js");
    const v = window.viewer;
    const s = v.scene;

    // Pin the clock so the star field + sun are deterministic across backends.
    const fixed = C.JulianDate.fromIso8601("2026-05-19T18:00:00Z");
    v.clock.currentTime = fixed.clone();
    v.clock.startTime = fixed.clone();
    v.clock.stopTime = fixed.clone();
    v.clock.shouldAnimate = false;
    v.clock.multiplier = 0;

    // Explicitly enable the things under test.
    if (s.skyBox) s.skyBox.show = true;
    if (s.sun) s.sun.show = true;
    if (s.skyAtmosphere) s.skyAtmosphere.show = true;
    s.backgroundColor = C.Color.BLACK;

    // Park far out looking down the limb.
    v.camera.setView({
      destination: C.Cartesian3.fromDegrees(view.lon, view.lat, view.height),
    });

    let settled = false;
    for (let i = 0; i < 600; i++) {
      s.render();
      await new Promise((r) => requestAnimationFrame(r));
      if (s.globe.tilesLoaded && i > 120) {
        settled = true;
        break;
      }
    }

    return {
      renderer: s.context.rendererType,
      skyBoxShow: !!(s.skyBox && s.skyBox.show),
      sunShow: !!(s.sun && s.sun.show),
      skyAtmoShow: !!(s.skyAtmosphere && s.skyAtmosphere.show),
      settled,
      cameraHeight: v.camera.positionCartographic.height,
    };
  }, VIEW);

  await page.waitForTimeout(1500);

  const out = path.join(OUT_DIR, `skybox-stars-sun-${rendererArg}.png`);
  await page.screenshot({ path: out, fullPage: false });

  const gate = await collectGateErrors(page);
  await browser.close();

  return { out, meta, consoleErrors, gate };
}

// Decode a PNG in a headless canvas and report:
//  - star pixel count: bright pixels in the dark-background region (outside
//    the Earth disc) — a proxy for "are stars visible".
//  - sun pixel count: very bright (near-white) clustered pixels.
//  - non-black pixels total.
async function analyze(pngPath) {
  const browser = await chromium.launch({ channel: "msedge", headless: true });
  const page = await browser.newPage();
  await page.setContent("<!doctype html><html><body></body></html>");
  const b64 = fs.readFileSync(pngPath).toString("base64");
  const stats = await page.evaluate(async (b64) => {
    const img = new Image();
    img.src = "data:image/png;base64," + b64;
    await img.decode();
    const w = img.naturalWidth;
    const h = img.naturalHeight;
    const cv = document.createElement("canvas");
    cv.width = w;
    cv.height = h;
    const ctx = cv.getContext("2d");
    ctx.drawImage(img, 0, 0);
    const d = ctx.getImageData(0, 0, w, h).data;

    let nonBlack = 0;
    let starish = 0; // dim-to-mid bright isolated points
    let bright = 0; // very bright (sun / sun glow / disc highlights)
    let lumSum = 0;
    // Histogram of max-channel value to characterise the field.
    const hist = new Array(8).fill(0);
    for (let i = 0; i < d.length; i += 4) {
      const r = d[i],
        g = d[i + 1],
        b = d[i + 2];
      const mx = Math.max(r, g, b);
      const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      lumSum += lum;
      if (mx > 12) nonBlack++;
      if (mx >= 20 && mx < 180) starish++;
      if (mx >= 220) bright++;
      hist[Math.min(7, Math.floor(mx / 32))]++;
    }
    const total = w * h;
    return {
      w,
      h,
      total,
      nonBlackPct: (100 * nonBlack) / total,
      starishPct: (100 * starish) / total,
      brightPct: (100 * bright) / total,
      meanLum: lumSum / total,
      hist,
    };
  }, b64);
  await browser.close();
  return stats;
}

async function diffPngs(a, b) {
  const browser = await chromium.launch({ channel: "msedge", headless: true });
  const page = await browser.newPage();
  await page.setContent("<!doctype html><html><body></body></html>");
  const ba = fs.readFileSync(a).toString("base64");
  const bb = fs.readFileSync(b).toString("base64");
  const result = await page.evaluate(
    async ({ ba, bb }) => {
      const decode = async (b64) => {
        const img = new Image();
        img.src = "data:image/png;base64," + b64;
        await img.decode();
        const c = document.createElement("canvas");
        c.width = img.naturalWidth;
        c.height = img.naturalHeight;
        c.getContext("2d").drawImage(img, 0, 0);
        return {
          w: img.naturalWidth,
          h: img.naturalHeight,
          data: c.getContext("2d").getImageData(0, 0, c.width, c.height).data,
        };
      };
      const A = await decode(ba);
      const B = await decode(bb);
      if (A.w !== B.w || A.h !== B.h) return { error: "size mismatch" };
      const total = A.w * A.h;
      let mismatch = 0,
        sum = 0;
      for (let i = 0; i < A.data.length; i += 4) {
        const dr = Math.abs(A.data[i] - B.data[i]);
        const dg = Math.abs(A.data[i + 1] - B.data[i + 1]);
        const db = Math.abs(A.data[i + 2] - B.data[i + 2]);
        const dd = dr + dg + db;
        sum += dd;
        if (dd > 30) mismatch++;
      }
      return {
        mismatchPct: ((100 * mismatch) / total).toFixed(2),
        meanDelta: (sum / total).toFixed(2),
      };
    },
    { ba, bb },
  );
  await browser.close();
  return result;
}

(async () => {
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
  console.log(`[skybox-stars-sun] base=${BASE} view=`, VIEW);

  const gpu = await capture("webgpu");
  const gl = await capture("webgl");

  console.log("\n-- WebGPU --");
  console.log("  meta:", JSON.stringify(gpu.meta));
  console.log(
    "  gate errors:",
    gpu.gate.errors.length,
    "deviceLost:",
    gpu.gate.deviceLost,
  );
  console.log("  console faults:", gpu.consoleErrors.length);
  if (gpu.consoleErrors.length)
    gpu.consoleErrors.slice(0, 5).forEach((e) => console.log("    " + e));

  console.log("\n-- WebGL --");
  console.log("  meta:", JSON.stringify(gl.meta));

  const aGpu = await analyze(gpu.out);
  const aGl = await analyze(gl.out);
  console.log("\n-- analyze WebGPU --", JSON.stringify(aGpu));
  console.log("-- analyze WebGL  --", JSON.stringify(aGl));

  const diff = await diffPngs(gpu.out, gl.out);
  console.log("\n-- diff (gpu vs gl) --", JSON.stringify(diff));

  console.log("\nPNGs:");
  console.log("  " + path.resolve(gpu.out));
  console.log("  " + path.resolve(gl.out));
})();
