#!/usr/bin/env node
// Variant of probe-brightness-ratio.mjs that disables ground atmosphere
// on both backends. Isolates the imagery-composite path from the
// drape/atmosphere path so we can tell whether the brightness gap is in
// the drape branch (gap disappears here) or in the composite chain
// (gap remains).

import { chromium } from "playwright";
import fs from "fs";
import path from "path";

const BASE = "http://localhost:8080";
const OUT_DIR = "Tools/visual-regression/output";

const DISTANCES = [
  { name: "close-1mm", longitude: -100, latitude: 40, altitude: 1_000_000 },
  { name: "mid-5mm", longitude: -100, latitude: 40, altitude: 5_000_000 },
  { name: "mid-12mm", longitude: -100, latitude: 40, altitude: 12_000_000 },
  { name: "orbit-20mm", longitude: -100, latitude: 40, altitude: 20_000_000 },
];

async function measure(rendererArg, distance) {
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

  await page.evaluate(async (d) => {
    const C = await import("/Build/CesiumUnminified/index.js");
    const v = window.viewer;
    v.scene.globe.showGroundAtmosphere = false; // KEY: disable drape
    v.camera.setView({
      destination: C.Cartesian3.fromDegrees(
        d.longitude,
        d.latitude,
        d.altitude,
      ),
    });
    for (let i = 0; i < 800; i++) {
      v.scene.render();
      await new Promise((r) => requestAnimationFrame(r));
      if (v.scene.globe.tilesLoaded && i > 80) break;
    }
  }, distance);
  await page.waitForTimeout(2000);

  const buffer = await page.screenshot({ fullPage: false });
  const out = path.join(
    OUT_DIR,
    `brightness-noatmo-${distance.name}-${rendererArg}.png`,
  );
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
      n = 0,
      globePx = 0;
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const i = (y * w + x) * 4;
        const r = data[i],
          g = data[i + 1],
          b = data[i + 2];
        rSum += r;
        gSum += g;
        bSum += b;
        n++;
        if (r + g + b > 12) globePx++;
      }
    }
    return {
      meanRgb: (rSum + gSum + bSum) / (3 * n),
      globeFrac: globePx / n,
    };
  }, base64);

  await browser.close();
  return stats;
}

(async () => {
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
  console.log(
    `[probe-brightness-no-atmo] WebGL vs WebGPU (showGroundAtmosphere = false)\n`,
  );
  console.log(
    `${"distance".padEnd(12)} ${"WebGL".padStart(8)} ${"WebGPU".padStart(8)} ${"ratio".padStart(8)}`,
  );
  console.log("─".repeat(40));
  const rows = [];
  for (const d of DISTANCES) {
    const wgl = await measure("webgl", d);
    const wgpu = await measure("webgpu", d);
    const ratio = wgpu.meanRgb > 0 ? wgl.meanRgb / wgpu.meanRgb : Infinity;
    rows.push({ d, wgl, wgpu, ratio });
    console.log(
      `  ${d.name.padEnd(12)} ${wgl.meanRgb.toFixed(2).padStart(8)} ${wgpu.meanRgb.toFixed(2).padStart(8)} ${ratio.toFixed(3).padStart(8)}`,
    );
  }
  const avgRatio = rows.reduce((s, r) => s + r.ratio, 0) / rows.length;
  console.log(`\nAverage ratio (atmosphere OFF): ${avgRatio.toFixed(3)}`);
  console.log(
    `If this is near 1.0, the brightness gap is in the drape branch.`,
  );
  console.log(`If this is still > 1.2, the gap is in the imagery composite.`);
})();
