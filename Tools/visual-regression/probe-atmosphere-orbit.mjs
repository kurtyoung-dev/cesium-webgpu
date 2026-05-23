#!/usr/bin/env node
// Isolate which atmosphere component (sky vs ground) drives the orbit
// residual. Captures three configurations at lat=80, alt=12Mm:
//   A) full atmosphere (baseline)
//   B) sky atmosphere ONLY (ground off)
//   C) ground atmosphere ONLY (sky off)
//   D) all atmosphere OFF
//
// For each: WebGL vs WebGPU pixel-diff over the visible sample region.

import { chromium } from "playwright";
import fs from "fs";
import path from "path";

const BASE = "http://localhost:8080";
const OUT_DIR = "Tools/visual-regression/output";

const CONFIGS = [
  { name: "A-full", skyAtmo: true, groundAtmo: true },
  { name: "B-sky-only", skyAtmo: true, groundAtmo: false },
  { name: "C-ground-only", skyAtmo: false, groundAtmo: true },
  { name: "D-all-off", skyAtmo: false, groundAtmo: false },
];

const VIEW = { lon: 0, lat: 80, height: 12_000_000 };

async function capture(renderer, config) {
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
    async ({ config, view }) => {
      const C = await import("/Build/CesiumUnminified/index.js");
      const v = window.viewer;
      const vm = v.baseLayerPicker.viewModel;
      const wgs84 = vm.terrainProviderViewModels.find((t) =>
        String(t.name || "").toLowerCase().includes("wgs84"),
      );
      if (wgs84) vm.selectedTerrain = wgs84;
      // Pin the clock for cross-session reproducibility (Batch 70).
      const fixed = C.JulianDate.fromIso8601("2026-05-19T18:00:00Z");
      v.clock.currentTime = fixed.clone();
      v.clock.startTime = fixed.clone();
      v.clock.stopTime = fixed.clone();
      v.clock.shouldAnimate = false;
      v.clock.multiplier = 0;
      v.scene.skyAtmosphere.show = config.skyAtmo;
      v.scene.globe.showGroundAtmosphere = config.groundAtmo;
      v.scene.fog.enabled = false;
      v.scene.skyBox.show = false;
      v.scene.sun.show = false;
      v.scene.moon.show = false;
      v.scene.globe.enableLighting = false;
      v.scene.backgroundColor = C.Color.BLACK;
      v.camera.setView({
        destination: C.Cartesian3.fromDegrees(view.lon, view.lat, view.height),
      });
      for (let i = 0; i < 1500; i++) {
        v.scene.render();
        await new Promise((r) => requestAnimationFrame(r));
        if (v.scene.globe.tilesLoaded && i > 300) break;
      }
    },
    { config, view: VIEW },
  );
  await page.waitForTimeout(1500);
  const out = path.join(OUT_DIR, `atmo-${config.name}-${renderer}.png`);
  await page.screenshot({ path: out });
  await browser.close();
  return out;
}

async function diff(wglPath, wgpuPath) {
  const browser = await chromium.launch({ channel: "msedge", headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  await page.setContent("<!doctype html><html><body></body></html>");
  const wglB64 = fs.readFileSync(wglPath).toString("base64");
  const wgpuB64 = fs.readFileSync(wgpuPath).toString("base64");
  const stats = await page.evaluate(
    async ({ wglB64, wgpuB64 }) => {
      async function decode(b64) {
        const img = new Image();
        img.src = "data:image/png;base64," + b64;
        await img.decode();
        const cv = document.createElement("canvas");
        cv.width = img.width;
        cv.height = img.height;
        const ctx = cv.getContext("2d");
        ctx.drawImage(img, 0, 0);
        return ctx.getImageData(0, 0, img.width, img.height);
      }
      const a = await decode(wglB64);
      const b = await decode(wgpuB64);
      const da = a.data,
        db = b.data;
      const w = a.width,
        h = a.height;
      const x0 = Math.floor(w * 0.05),
        x1 = Math.floor(w * 0.78);
      const y0 = Math.floor(h * 0.08),
        y1 = Math.floor(h * 0.9);
      let mismatch = 0,
        total = 0,
        deltaSum = 0,
        rSumA = 0,
        gSumA = 0,
        bSumA = 0,
        rSumB = 0,
        gSumB = 0,
        bSumB = 0;
      // Separate counters: pixels OUTSIDE the Earth disc (mostly atmosphere
      // / space) vs INSIDE (ground).
      let outsideMismatch = 0,
        outsideTotal = 0,
        outsideDeltaSum = 0;
      let insideMismatch = 0,
        insideTotal = 0,
        insideDeltaSum = 0;
      // We approximate "inside the disc" as "WebGL pixel has a strong
      // green channel" (Bing aerial green-blue average) — atmosphere
      // halo is pinkish; ground/ocean is greenish/blueish.
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const i = (y * w + x) * 4;
          const ra = da[i],
            ga = da[i + 1],
            ba = da[i + 2];
          const rb = db[i],
            gb = db[i + 1],
            bb = db[i + 2];
          rSumA += ra;
          gSumA += ga;
          bSumA += ba;
          rSumB += rb;
          gSumB += gb;
          bSumB += bb;
          const delta = Math.abs(ra - rb) + Math.abs(ga - gb) + Math.abs(ba - bb);
          deltaSum += delta;
          if (delta > 24) mismatch++;
          total++;
          // Inside disc: WebGL pixel has at least one channel ≥ 30 (above
          // pure black) AND no strong pink (atmosphere halo signature).
          const isInsideWGL =
            (ra >= 30 || ga >= 30 || ba >= 30) && ga > ra - 20;
          if (isInsideWGL) {
            insideTotal++;
            insideDeltaSum += delta;
            if (delta > 24) insideMismatch++;
          } else {
            outsideTotal++;
            outsideDeltaSum += delta;
            if (delta > 24) outsideMismatch++;
          }
        }
      }
      return {
        mismatch,
        total,
        mismatchPct: (100 * mismatch) / total,
        meanDelta: deltaSum / total,
        meanA: (rSumA + gSumA + bSumA) / (3 * total),
        meanB: (rSumB + gSumB + bSumB) / (3 * total),
        insidePct: (100 * insideMismatch) / Math.max(1, insideTotal),
        insideMeanDelta: insideDeltaSum / Math.max(1, insideTotal),
        outsidePct: (100 * outsideMismatch) / Math.max(1, outsideTotal),
        outsideMeanDelta: outsideDeltaSum / Math.max(1, outsideTotal),
      };
    },
    { wglB64, wgpuB64 },
  );
  await browser.close();
  return stats;
}

(async () => {
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
  console.log("[atmosphere-orbit] view=lat80,12Mm; sky vs ground isolation");
  console.log();
  console.log(
    `${"config".padEnd(16)} ${"total%".padStart(8)} ${"mD".padStart(7)} ${"inside%".padStart(8)} ${"i-mD".padStart(7)} ${"out%".padStart(7)} ${"o-mD".padStart(7)}`,
  );
  console.log("─".repeat(70));
  for (const config of CONFIGS) {
    const wgl = await capture("webgl", config);
    const wgpu = await capture("webgpu", config);
    const s = await diff(wgl, wgpu);
    console.log(
      `${config.name.padEnd(16)} ${s.mismatchPct.toFixed(2).padStart(7)}% ${s.meanDelta.toFixed(1).padStart(7)} ${s.insidePct.toFixed(2).padStart(7)}% ${s.insideMeanDelta.toFixed(1).padStart(7)} ${s.outsidePct.toFixed(2).padStart(6)}% ${s.outsideMeanDelta.toFixed(1).padStart(7)}`,
    );
  }
})();
