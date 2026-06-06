#!/usr/bin/env node
// Companion to probe-skybox-stars-sun.mjs (BUG-1): orient the camera in deep
// space to LOOK AT the sun so the sun disc/glow is in frame on both backends.
// We pin the clock, park far out, then point the camera along the
// scene->sun direction. Captures WebGL + WebGPU and reports the brightest
// cluster (sun) location + intensity.
//
// Usage:
//   PROBE_BASE=http://localhost:8134 node Tools/visual-regression/probe-skybox-stars-sun-facing.mjs
// Outputs:
//   Tools/visual-regression/output/skybox-sun-facing-{webgl,webgpu}.png

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
    args: ["--enable-unsafe-webgpu", "--enable-features=Vulkan", "--use-vulkan"],
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const consoleErrors = attachConsoleErrorGate(page);
  await page.addInitScript(errorGateInit);

  const url = `${BASE}/Apps/CesiumViewer/index.html?renderer=${rendererArg}`;
  await page.goto(url, { waitUntil: "networkidle" });
  await page.waitForFunction(() => !!window.viewer);
  await armWebGPUDevices(page);

  const meta = await page.evaluate(async () => {
    const C = await import("/Build/CesiumUnminified/index.js");
    const v = window.viewer;
    const s = v.scene;

    const fixed = C.JulianDate.fromIso8601("2026-05-19T18:00:00Z");
    v.clock.currentTime = fixed.clone();
    v.clock.startTime = fixed.clone();
    v.clock.stopTime = fixed.clone();
    v.clock.shouldAnimate = false;
    v.clock.multiplier = 0;

    if (s.skyBox) s.skyBox.show = true;
    if (s.sun) s.sun.show = true;
    if (s.skyAtmosphere) s.skyAtmosphere.show = true;
    s.backgroundColor = C.Color.BLACK;

    // Park far out in space first.
    v.camera.setView({
      destination: C.Cartesian3.fromDegrees(0, 0, 8.0e7),
    });
    s.render();

    // Sun position in world (WGS84) coords for the pinned time.
    const sunPos = s.context.uniformState.sunPositionWC || s.sun?._boundingVolume?.center;
    // Fall back to the well-known Simon1994 sun direction via UniformState.
    let dir;
    if (sunPos) {
      dir = C.Cartesian3.normalize(sunPos, new C.Cartesian3());
    } else {
      dir = new C.Cartesian3(1, 0, 0);
    }
    // Place the camera on the OPPOSITE side of the sun direction, far out,
    // and aim back toward the sun so the sun disc sits roughly centre-frame
    // against the star field (Earth not necessarily in view).
    const camPos = C.Cartesian3.multiplyByScalar(dir, -1.0e8, new C.Cartesian3());
    v.camera.setView({
      destination: camPos,
      orientation: {
        direction: dir,
        up: C.Cartesian3.UNIT_Z,
      },
    });

    for (let i = 0; i < 240; i++) {
      s.render();
      await new Promise((r) => requestAnimationFrame(r));
    }

    return {
      renderer: s.context.rendererType,
      sunShow: !!(s.sun && s.sun.show),
      sunDir: dir ? [dir.x.toFixed(3), dir.y.toFixed(3), dir.z.toFixed(3)] : null,
      hadSunPos: !!sunPos,
    };
  });

  await page.waitForTimeout(1200);
  const out = path.join(OUT_DIR, `skybox-sun-facing-${rendererArg}.png`);
  await page.screenshot({ path: out, fullPage: false });
  const gate = await collectGateErrors(page);
  await browser.close();
  return { out, meta, consoleErrors, gate };
}

async function brightest(pngPath) {
  const browser = await chromium.launch({ channel: "msedge", headless: true });
  const page = await browser.newPage();
  await page.setContent("<!doctype html><html><body></body></html>");
  const b64 = fs.readFileSync(pngPath).toString("base64");
  const r = await page.evaluate(async (b64) => {
    const img = new Image();
    img.src = "data:image/png;base64," + b64;
    await img.decode();
    const w = img.naturalWidth, h = img.naturalHeight;
    const cv = document.createElement("canvas");
    cv.width = w; cv.height = h;
    const ctx = cv.getContext("2d");
    ctx.drawImage(img, 0, 0);
    const d = ctx.getImageData(0, 0, w, h).data;
    let bx = 0, by = 0, bv = -1, brightCount = 0;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        const lum = 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
        if (lum >= 240) brightCount++;
        if (lum > bv) { bv = lum; bx = x; by = y; }
      }
    }
    return { w, h, brightestLum: bv, brightestXY: [bx, by], nearWhiteCount: brightCount };
  }, b64);
  await browser.close();
  return r;
}

(async () => {
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
  console.log(`[skybox-sun-facing] base=${BASE}`);
  const gpu = await capture("webgpu");
  const gl = await capture("webgl");
  console.log("\n-- WebGPU --", JSON.stringify(gpu.meta));
  console.log("  gate errors:", gpu.gate.errors.length, "deviceLost:", gpu.gate.deviceLost, "console faults:", gpu.consoleErrors.length);
  console.log("-- WebGL  --", JSON.stringify(gl.meta));
  const bg = await brightest(gpu.out);
  const bl = await brightest(gl.out);
  console.log("\n-- brightest WebGPU --", JSON.stringify(bg));
  console.log("-- brightest WebGL  --", JSON.stringify(bl));
  console.log("\nPNGs:");
  console.log("  " + path.resolve(gpu.out));
  console.log("  " + path.resolve(gl.out));
})();
