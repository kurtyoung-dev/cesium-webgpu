#!/usr/bin/env node
// Multi-angle polar diagnostic. Loads the DebugTileImageryProvider
// overlay on WGS84 and captures at 6 viewpoints + 3 altitudes.
//
// Diagnoses two user-flagged issues:
//   1. DebugTileImageryProvider labels appear mirrored in X AND Y on WebGPU
//      (= 180° rotated relative to the source canvas). Symptom is most
//      visible at altitudes where labels are large enough to read
//      (1-3 Mm).
//   2. Polar regions (>±85°) appear to be missing imagery entirely on
//      the WGS84 ellipsoid view at orbit altitudes.
//
// Captures both WebGL (reference) and WebGPU for direct side-by-side.

import { chromium } from "playwright";
import fs from "fs";
import path from "path";

const BASE = "http://localhost:8080";
const OUT_DIR = "Tools/visual-regression/output";

// 6 viewpoints × 2 altitudes covering equatorial, mid-latitude, polar,
// and antipodal views.
const VIEWS = [
  { name: "northpole-close", lon: 0, lat: 89, height: 3_000_000 },
  { name: "northpole-orbit", lon: 0, lat: 80, height: 12_000_000 },
  { name: "southpole-close", lon: 0, lat: -89, height: 3_000_000 },
  { name: "southpole-orbit", lon: 0, lat: -80, height: 12_000_000 },
  { name: "equator-mid", lon: 0, lat: 0, height: 3_000_000 },
  { name: "midlat-mid", lon: -100, lat: 40, height: 3_000_000 },
];

async function capture(renderer, view) {
  const browser = await chromium.launch({
    channel: "msedge", headless: true,
    args: ["--enable-unsafe-webgpu", "--enable-features=Vulkan", "--use-vulkan", "--disable-cache"],
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  await page.goto(`${BASE}/Apps/CesiumViewer/index.html?renderer=${renderer}`, { waitUntil: "networkidle" });
  await page.waitForFunction(() => !!window.viewer);

  await page.evaluate(async ({ view }) => {
    const C = await import("/Build/CesiumUnminified/index.js");
    const v = window.viewer;
    const vm = v.baseLayerPicker.viewModel;
    const wgs84 = vm.terrainProviderViewModels.find((t) =>
      String(t.name || "").toLowerCase().includes("wgs84"));
    if (wgs84) vm.selectedTerrain = wgs84;
    if (C.DebugTileImageryProvider) {
      v.imageryLayers.addImageryProvider(new C.DebugTileImageryProvider({
        colorByLevel: true,
      }));
    }
    v.camera.setView({
      destination: C.Cartesian3.fromDegrees(view.lon, view.lat, view.height),
    });
    for (let i = 0; i < 1500; i++) {
      v.scene.render();
      await new Promise((r) => requestAnimationFrame(r));
      if (v.scene.globe.tilesLoaded && i > 300) break;
    }
  }, { view });
  await page.waitForTimeout(2000);
  const out = path.join(OUT_DIR, `polar-multi-${view.name}-${renderer}.png`);
  await page.screenshot({ path: out });
  await browser.close();
  return out;
}

(async () => {
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
  console.log("[polar-multi-angle] WGS84 + DebugTileImageryProvider, both backends");
  for (const view of VIEWS) {
    for (const renderer of ["webgl", "webgpu"]) {
      console.log(`  ${view.name} ${renderer}`);
      await capture(renderer, view);
    }
  }
})();
