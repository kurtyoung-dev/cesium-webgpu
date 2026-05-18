#!/usr/bin/env node
// Test new mip-related debug modes at orbit altitude.
// If mip4 differs from sample0, mipmaps are present and the gap is LOD selection.
// If mip4 == sample0 (or all-zero), mipmap chain isn't being read.

import { chromium } from "playwright";
import fs from "fs";
import path from "path";

const BASE = "http://localhost:8080";
const OUT_DIR = "Tools/visual-regression/output";

async function capture(modeName) {
  const browser = await chromium.launch({
    channel: "msedge",
    headless: true,
    args: ["--enable-unsafe-webgpu", "--enable-features=Vulkan", "--use-vulkan", "--disable-cache"],
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  await page.goto(`${BASE}/Apps/CesiumViewer/index.html?renderer=webgpu`, { waitUntil: "networkidle" });
  await page.waitForFunction(() => !!window.viewer);
  await page.waitForFunction(() => !!window.CesiumDebug, { timeout: 5000 });

  await page.evaluate(async (mode) => {
    const C = await import("/Build/CesiumUnminified/index.js");
    const v = window.viewer;
    v.scene.globe.showGroundAtmosphere = false;
    if (mode) window.CesiumDebug.globeFragmentDebug(mode);
    v.camera.setView({ destination: C.Cartesian3.fromDegrees(-100, 40, 20_000_000) });
    for (let i = 0; i < 800; i++) {
      v.scene.render();
      await new Promise((r) => requestAnimationFrame(r));
      if (v.scene.globe.tilesLoaded && i > 80) break;
    }
  }, modeName);
  await page.waitForTimeout(2000);

  const buffer = await page.screenshot({ fullPage: false });
  const out = path.join(OUT_DIR, `mipdebug-${modeName || "final"}.png`);
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
    const w = img.width, h = img.height;
    const x0 = Math.floor(w * 0.2), x1 = Math.floor(w * 0.8);
    const y0 = Math.floor(h * 0.2), y1 = Math.floor(h * 0.8);
    let rSum = 0, gSum = 0, bSum = 0, n = 0;
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const i = (y * w + x) * 4;
        rSum += data[i]; gSum += data[i + 1]; bSum += data[i + 2]; n++;
      }
    }
    return { meanRgb: (rSum + gSum + bSum) / (3 * n) };
  }, base64);
  await browser.close();
  return stats;
}

(async () => {
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
  console.log(`[mipdebug] orbit-20mm`);
  for (const mode of ["sample0", "mip4", "lod-magnitude", null]) {
    const r = await capture(mode);
    console.log(`  ${(mode || "final").padEnd(18)}: meanRGB=${r.meanRgb.toFixed(2)}`);
  }
})();
