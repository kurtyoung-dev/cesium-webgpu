#!/usr/bin/env node
// Bisect: at orbit-20mm with atmosphere OFF, capture WebGPU using
// post-composite-color debug mode. If the post-composite color is
// BRIGHT (matching WebGL final), the bug is downstream of imagery
// composite. If it's already DIM, the bug is in the composite itself
// (sampling, gamma, alpha math).
// @purpose Bisects the globe brightness gap via the post-composite-color debug mode: bright there = bug downstream of composite, dim = in composite.
// @status ACTIVE

import { chromium } from "playwright";
import fs from "fs";
import path from "path";

const BASE = "http://localhost:8080";
const OUT_DIR = "Tools/visual-regression/output";

async function measure(rendererArg, debugMode, altitude) {
  const browser = await chromium.launch({
    channel: "msedge",
    headless: true,
    args: [
      "--enable-unsafe-webgpu",
      "--enable-features=Vulkan",
      "--use-vulkan",
      "--disable-cache",
    ],
  });
  const page = await browser.newPage({
    viewport: { width: 1280, height: 720 },
  });
  await page.goto(
    `${BASE}/Apps/CesiumViewer/index.html?renderer=${rendererArg}`,
    { waitUntil: "networkidle" },
  );
  await page.waitForFunction(() => !!window.viewer);

  await page.evaluate(
    async ({ debugMode, altitude }) => {
      const C = await import("/Build/CesiumUnminified/index.js");
      const v = window.viewer;
      v.scene.globe.showGroundAtmosphere = false;
      if (debugMode && window.CesiumDebug) {
        window.CesiumDebug.globeFragmentDebug(debugMode);
      }
      v.camera.setView({
        destination: C.Cartesian3.fromDegrees(-100, 40, altitude),
      });
      for (let i = 0; i < 800; i++) {
        v.scene.render();
        await new Promise((r) => requestAnimationFrame(r));
        if (v.scene.globe.tilesLoaded && i > 80) break;
      }
    },
    { debugMode, altitude },
  );
  await page.waitForTimeout(2000);

  const buffer = await page.screenshot({ fullPage: false });
  const label = `${rendererArg}-${altitude / 1e6}mm${debugMode ? "-" + debugMode : ""}`;
  const out = path.join(OUT_DIR, `bisect-${label}.png`);
  fs.writeFileSync(out, buffer);

  const base64 = buffer.toString("base64");
  const stats = await page.evaluate(async (b64) => {
    const img = new Image();
    img.src = "data:image/png;base64," + b64;
    await img.decode();
    const cv = document.createElement("canvas");
    cv.width = img.width;
    cv.height = img.height;
    const ctx = cv.getContext("2d");
    ctx.drawImage(img, 0, 0);
    const data = ctx.getImageData(0, 0, img.width, img.height).data;
    const w = img.width,
      h = img.height;
    const x0 = Math.floor(w * 0.2),
      x1 = Math.floor(w * 0.8);
    const y0 = Math.floor(h * 0.2),
      y1 = Math.floor(h * 0.8);
    let rSum = 0,
      gSum = 0,
      bSum = 0,
      n = 0;
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const i = (y * w + x) * 4;
        rSum += data[i];
        gSum += data[i + 1];
        bSum += data[i + 2];
        n++;
      }
    }
    return { meanRgb: (rSum + gSum + bSum) / (3 * n) };
  }, base64);

  await browser.close();
  return stats;
}

(async () => {
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
  console.log(`[bisect] orbit-20mm, atmosphere OFF\n`);

  for (const altitude of [12_000_000, 20_000_000]) {
    const altLabel = `${altitude / 1e6}mm`;
    console.log(`\n--- ${altLabel} (atmosphere OFF) ---`);
    const wglFinal = await measure("webgl", null, altitude);
    console.log(
      `  WebGL  final               : ${wglFinal.meanRgb.toFixed(2)}`,
    );
    const wgpuFinal = await measure("webgpu", null, altitude);
    console.log(
      `  WebGPU final               : ${wgpuFinal.meanRgb.toFixed(2)}`,
    );
    const wgpuPostComp = await measure(
      "webgpu",
      "post-composite-color",
      altitude,
    );
    console.log(
      `  WebGPU post-composite-color: ${wgpuPostComp.meanRgb.toFixed(2)}`,
    );
    const wgpuSample0 = await measure("webgpu", "sample0", altitude);
    console.log(
      `  WebGPU sample0 (raw layer 0): ${wgpuSample0.meanRgb.toFixed(2)}`,
    );
  }

  console.log(`\nInterpretation:`);
  console.log(
    `  - If WebGPU post-comp matches WebGL final, bug is downstream of composite.`,
  );
  console.log(`  - If WebGPU post-comp is dim, bug is in composite.`);
  console.log(
    `  - If WebGPU sample0 is dim, bug is at upload / sample / mipmap.`,
  );
})();
