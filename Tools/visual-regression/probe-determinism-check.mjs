#!/usr/bin/env node
// Capture midlat-mid on each backend N times back-to-back. If a backend
// is deterministic, all N snapshots are pixel-identical. If not, the
// run-to-run variance is what's contaminating the polar-multi diff
// metric.

import { chromium } from "playwright";
import fs from "fs";
import path from "path";

const BASE = "http://localhost:8080";
const OUT_DIR = "Tools/visual-regression/output";
const VIEW = { lon: -100, lat: 40, height: 3_000_000 };
const N = 4;

async function capture(renderer, attempt) {
  const browser = await chromium.launch({
    channel: "msedge",
    headless: true,
    args: ["--enable-unsafe-webgpu", "--use-vulkan", "--disable-cache"],
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  await page.goto(`${BASE}/Apps/CesiumViewer/index.html?renderer=${renderer}`, {
    waitUntil: "networkidle",
  });
  await page.waitForFunction(() => !!window.viewer);
  await page.evaluate(
    async ({ view }) => {
      const C = await import("/Build/CesiumUnminified/index.js");
      const v = window.viewer;
      const vm = v.baseLayerPicker.viewModel;
      const wgs84 = vm.terrainProviderViewModels.find((t) =>
        String(t.name || "").toLowerCase().includes("wgs84"),
      );
      if (wgs84) vm.selectedTerrain = wgs84;
      v.camera.setView({
        destination: C.Cartesian3.fromDegrees(view.lon, view.lat, view.height),
      });
      for (let i = 0; i < 1500; i++) {
        v.scene.render();
        await new Promise((r) => requestAnimationFrame(r));
        if (v.scene.globe.tilesLoaded && i > 300) break;
      }
    },
    { view: VIEW },
  );
  await page.waitForTimeout(1500);
  const out = path.join(OUT_DIR, `determinism-${renderer}-${attempt}.png`);
  await page.screenshot({ path: out });
  await browser.close();
  return out;
}

async function diff(aPath, bPath) {
  const browser = await chromium.launch({ channel: "msedge", headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  await page.setContent("<!doctype html><html><body></body></html>");
  const aB64 = fs.readFileSync(aPath).toString("base64");
  const bB64 = fs.readFileSync(bPath).toString("base64");
  const stats = await page.evaluate(
    async ({ aB64, bB64 }) => {
      async function decode(b64) {
        const img = new Image();
        img.src = "data:image/png;base64," + b64;
        await img.decode();
        const cv = document.createElement("canvas");
        cv.width = img.width; cv.height = img.height;
        const ctx = cv.getContext("2d");
        ctx.drawImage(img, 0, 0);
        return ctx.getImageData(0, 0, img.width, img.height);
      }
      const a = await decode(aB64);
      const b = await decode(bB64);
      let total = 0, mismatch = 0, deltaSum = 0;
      for (let y = 50; y < 670; y++) {
        for (let x = 0; x < 998; x++) {
          const i = (y * a.width + x) * 4;
          const d = Math.abs(a.data[i] - b.data[i]) + Math.abs(a.data[i+1] - b.data[i+1]) + Math.abs(a.data[i+2] - b.data[i+2]);
          deltaSum += d; total++;
          if (d > 6) mismatch++;
        }
      }
      return { total, mismatch, mismatchPct: 100 * mismatch / total, meanDelta: deltaSum / total };
    },
    { aB64, bB64 },
  );
  await browser.close();
  return stats;
}

(async () => {
  console.log(`[determinism] capturing midlat-mid ${N}x on each backend back-to-back`);
  const webgl = [];
  const webgpu = [];
  for (let i = 0; i < N; i++) {
    console.log(`  webgl  attempt ${i+1}/${N}`);
    webgl.push(await capture("webgl", i));
    console.log(`  webgpu attempt ${i+1}/${N}`);
    webgpu.push(await capture("webgpu", i));
  }
  console.log();
  console.log(`=== Within-backend determinism check ===`);
  console.log(`WebGL  attempts (each vs attempt 0):`);
  for (let i = 1; i < N; i++) {
    const s = await diff(webgl[0], webgl[i]);
    console.log(`  attempt ${i} vs 0: mismatch=${s.mismatchPct.toFixed(2)}% meanDelta=${s.meanDelta.toFixed(2)}`);
  }
  console.log(`WebGPU attempts (each vs attempt 0):`);
  for (let i = 1; i < N; i++) {
    const s = await diff(webgpu[0], webgpu[i]);
    console.log(`  attempt ${i} vs 0: mismatch=${s.mismatchPct.toFixed(2)}% meanDelta=${s.meanDelta.toFixed(2)}`);
  }
  console.log();
  console.log(`=== Cross-backend diff (typical polar-multi metric) ===`);
  for (let i = 0; i < N; i++) {
    const s = await diff(webgl[i], webgpu[i]);
    console.log(`  webgl[${i}] vs webgpu[${i}]: mismatch=${s.mismatchPct.toFixed(2)}% meanDelta=${s.meanDelta.toFixed(2)}`);
  }
})();
