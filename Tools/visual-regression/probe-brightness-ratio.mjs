#!/usr/bin/env node
// Measures the WebGL/WebGPU brightness ratio at multiple camera
// distances. Captures both backends at each distance, decodes the
// PNG inside the page to compute mean RGB across the visible globe
// area, and reports the per-distance ratio.
//
// Baseline measurement for the pre-existing "globe ~4x darker on
// WebGPU" issue. Re-run after any tonemap / drape / atmosphere
// fix to track whether we've closed the gap.
//
// Distances tested (camera altitude above WGS84):
//   - 1 Mm    — close zoom over Texas (post-Batch-56 known good)
//   - 5 Mm    — mid-low altitude
//   - 12 Mm   — mid-orbit (fade ramp is mid-transition here)
//   - 20 Mm   — orbital (where the per-fragment drape kicks in)
//   - 40 Mm   — far-orbit (full atmosphere drape)
//
// Threshold: a ratio outside [0.5, 2.0] is reported as RED (significant
// disparity). Inside that range is GREEN (parity-adjacent).
//
// Canvas readback returns all-zeros in headless mode, so we decode the
// page.screenshot() PNG inline by drawing it back into a canvas before
// reading pixels. This is the same trick `probe-saved-view.mjs` uses.

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
  { name: "far-40mm", longitude: -100, latitude: 40, altitude: 40_000_000 },
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
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  await page.goto(
    `${BASE}/Apps/CesiumViewer/index.html?renderer=${rendererArg}`,
    { waitUntil: "networkidle" },
  );
  await page.waitForFunction(() => !!window.viewer);

  await page.evaluate(async (d) => {
    const C = await import("/Build/CesiumUnminified/index.js");
    const v = window.viewer;
    v.camera.setView({
      destination: C.Cartesian3.fromDegrees(d.longitude, d.latitude, d.altitude),
    });
    for (let i = 0; i < 800; i++) {
      v.scene.render();
      await new Promise((r) => requestAnimationFrame(r));
      if (v.scene.globe.tilesLoaded && i > 80) break;
    }
  }, distance);
  await page.waitForTimeout(2000);

  // page.screenshot returns a PNG buffer. Decode it inside the page by
  // drawing into a 2D canvas (which honors PNG decode), then read
  // ImageData. This sidesteps the preserveDrawingBuffer=false footgun
  // where reading the WebGL/WebGPU canvas directly returns all-zeros.
  const screenshotBuffer = await page.screenshot({ fullPage: false });
  const out = path.join(OUT_DIR, `brightness-${distance.name}-${rendererArg}.png`);
  fs.writeFileSync(out, screenshotBuffer);

  // Encode PNG → base64 → decode in page → read pixels
  const base64 = screenshotBuffer.toString("base64");
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
    // Center 60% × 60% of frame — avoid the credit display, baseLayerPicker,
    // and the right-side help overlay. Globe occupies most of this region
    // at every test altitude.
    const w = img.width;
    const h = img.height;
    const x0 = Math.floor(w * 0.2);
    const x1 = Math.floor(w * 0.8);
    const y0 = Math.floor(h * 0.2);
    const y1 = Math.floor(h * 0.8);
    let rSum = 0, gSum = 0, bSum = 0, n = 0;
    let globePx = 0;
    let blackPx = 0;
    let rGlobe = 0, gGlobe = 0, bGlobe = 0;
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const i = (y * w + x) * 4;
        const r = data[i], g = data[i + 1], b = data[i + 2];
        rSum += r;
        gSum += g;
        bSum += b;
        n++;
        // "Globe pixel" heuristic: anything non-black (the space
        // background is pure black RGB 0,0,0).
        if (r + g + b > 12) {
          globePx++;
          rGlobe += r; gGlobe += g; bGlobe += b;
        } else {
          blackPx++;
        }
      }
    }
    return {
      sampleCount: n,
      globePx,
      blackPx,
      globeFrac: globePx / n,
      meanR: rSum / n,
      meanG: gSum / n,
      meanB: bSum / n,
      // Mean over full sample region (includes space — biased by globe coverage)
      meanRgb: (rSum + gSum + bSum) / (3 * n),
      // Mean over globe-only pixels — true per-pixel imagery brightness
      meanRgbGlobeOnly:
        globePx > 0 ? (rGlobe + gGlobe + bGlobe) / (3 * globePx) : 0,
    };
  }, base64);

  await browser.close();
  return stats;
}

function colorize(value, lo, hi) {
  if (value >= lo && value <= hi) return `\x1b[32m${value.toFixed(3)}\x1b[0m`; // green
  return `\x1b[31m${value.toFixed(3)}\x1b[0m`; // red
}

(async () => {
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
  console.log(`[probe-brightness-ratio] WebGL vs WebGPU mean-RGB across distances`);
  console.log();
  console.log(
    `${"distance".padEnd(12)} ${"WebGL globe-only".padStart(17)} ${"WebGPU globe-only".padStart(17)} ${"WebGL/WebGPU".padStart(14)}`,
  );
  console.log("─".repeat(70));

  const rows = [];
  for (const d of DISTANCES) {
    process.stdout.write(`  ${d.name.padEnd(12)} … `);
    const wgl = await measure("webgl", d);
    const wgpu = await measure("webgpu", d);
    const ratio =
      wgpu.meanRgbGlobeOnly > 0
        ? wgl.meanRgbGlobeOnly / wgpu.meanRgbGlobeOnly
        : Infinity;
    rows.push({ d, wgl, wgpu, ratio });
    process.stdout.write("\r");
    console.log(
      `  ${d.name.padEnd(12)} ${wgl.meanRgbGlobeOnly.toFixed(2).padStart(17)} ${wgpu.meanRgbGlobeOnly.toFixed(2).padStart(17)} ${colorize(ratio, 0.5, 2.0).padStart(23)}`,
    );
  }

  // Summary
  const avgRatio = rows.reduce((s, r) => s + r.ratio, 0) / rows.length;
  console.log();
  console.log(
    `Average WebGL/WebGPU per-globe-pixel brightness ratio: ${colorize(avgRatio, 0.5, 2.0)}  (ideal = 1.0)`,
  );
  console.log(
    `Pass band: [0.5, 2.0]. Outside that range = significant disparity.`,
  );
  console.log();
  console.log("Per-distance PNGs:");
  for (const r of rows) {
    console.log(`  brightness-${r.d.name}-webgl.png  vs  brightness-${r.d.name}-webgpu.png`);
  }

  // Write a JSON report for diff-against-baseline tracking
  const report = {
    runAt: new Date().toISOString(),
    averageRatio: avgRatio,
    perDistance: rows.map((r) => ({
      name: r.d.name,
      altitude: r.d.altitude,
      webglMeanRgb: r.wgl.meanRgb,
      webgpuMeanRgb: r.wgpu.meanRgb,
      ratio: r.ratio,
      webglGlobeFrac: r.wgl.globeFrac,
      webgpuGlobeFrac: r.wgpu.globeFrac,
    })),
  };
  const reportPath = path.join(OUT_DIR, "brightness-ratio-report.json");
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.log(`\nJSON report: ${reportPath}`);
})();
