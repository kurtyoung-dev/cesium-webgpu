#!/usr/bin/env node
// Probe (BUG-3): capture WebGPU + WebGL SCENE2D screenshots and report WHERE the
// non-black pixels are + a coarse row/col occupancy map, so we can see whether
// the 2D map is off-screen, mis-scaled, depth-failed, or only the sky renders.
//
// Usage: node Tools/visual-regression/probe-2d-blank-where.mjs
// Out:   output/bug3-where-{webgpu,webgl}.png

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

async function run(rendererArg) {
  const browser = await chromium.launch({
    channel: "msedge",
    headless: true,
    args: ["--enable-unsafe-webgpu"],
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const consoleErrors = attachConsoleErrorGate(page);
  await page.addInitScript(errorGateInit);

  await page.goto(`${BASE}/Apps/CesiumViewer/index.html?renderer=${rendererArg}`, {
    waitUntil: "networkidle",
  });
  await page.waitForFunction(() => !!window.viewer);
  await armWebGPUDevices(page);

  const result = await page.evaluate(async () => {
    const v = window.viewer;
    v.scene.morphTo2D(0);
    for (let i = 0; i < 180; i++) {
      v.scene.render();
      await new Promise((r) => requestAnimationFrame(r));
    }
    const c = v.scene.canvas;
    const off = document.createElement("canvas");
    off.width = c.width;
    off.height = c.height;
    const cx = off.getContext("2d");
    cx.drawImage(c, 0, 0);
    const W = c.width,
      H = c.height;
    const data = cx.getImageData(0, 0, W, H).data;
    // 16x9 occupancy grid of nonBlack fraction + dominant color
    const GX = 16,
      GY = 9;
    const grid = [];
    for (let gy = 0; gy < GY; gy++) {
      let row = "";
      for (let gx = 0; gx < GX; gx++) {
        let nb = 0,
          tot = 0;
        const x0 = Math.floor((gx * W) / GX),
          x1 = Math.floor(((gx + 1) * W) / GX);
        const y0 = Math.floor((gy * H) / GY),
          y1 = Math.floor(((gy + 1) * H) / GY);
        for (let y = y0; y < y1; y += 4)
          for (let x = x0; x < x1; x += 4) {
            const i = (y * W + x) * 4;
            tot++;
            if (data[i] > 8 || data[i + 1] > 8 || data[i + 2] > 8) nb++;
          }
        const frac = nb / Math.max(1, tot);
        row += frac > 0.5 ? "#" : frac > 0.1 ? "+" : frac > 0.01 ? "." : " ";
      }
      grid.push(row);
    }
    // center pixel + corners sample
    const samp = (x, y) => {
      const i = (y * W + x) * 4;
      return [data[i], data[i + 1], data[i + 2], data[i + 3]];
    };
    return {
      W,
      H,
      mode: v.scene.mode,
      tiles: v.scene._globe?._surface?._tilesToRender?.length ?? -1,
      grid,
      center: samp(W >> 1, H >> 1),
      topLeft: samp(10, 10),
      camHeight: v.camera.positionCartographic?.height,
    };
  });

  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
  const out = path.join(OUT_DIR, `bug3-where-${rendererArg}.png`);
  await page.screenshot({ path: out, fullPage: false });
  const gate = await collectGateErrors(page);
  await browser.close();

  console.log(`\n===== ${rendererArg.toUpperCase()} SCENE2D =====`);
  console.log(`tiles=${result.tiles} mode=${result.mode} camHeight=${result.camHeight}`);
  console.log(`center px=${result.center} topLeft=${result.topLeft}`);
  console.log("occupancy (16x9), '#'=>50% '+'>10% '.'>1% ' '=blank:");
  result.grid.forEach((r) => console.log("  |" + r + "|"));
  const fatal = [...consoleErrors, ...gate.errors];
  console.log(`gate fatal=${fatal.length}`);
  fatal.slice(0, 4).forEach((e) => console.log("  FATAL: " + e));
  console.log(`saved ${out}`);
  return out;
}

(async () => {
  await run("webgpu");
  await run("webgl");
  console.log("\n[probe-2d-blank-where] done");
})();
