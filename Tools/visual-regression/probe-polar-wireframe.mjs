#!/usr/bin/env node
// Show the tile mesh as a wireframe at the polar views. If polar tiles
// exist as wireframe but the imagery is black, it's a UV/sampling bug.
// If no tile mesh at all, it's a mesh-construction or culling bug.

import { chromium } from "playwright";
import fs from "fs";
import path from "path";

const BASE = "http://localhost:8080";
const OUT_DIR = "Tools/visual-regression/output";

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
    v.scene.globe.showWireframe = true;
    v.camera.setView({
      destination: C.Cartesian3.fromDegrees(view.lon, view.lat, view.height),
    });
    for (let i = 0; i < 1200; i++) {
      v.scene.render();
      await new Promise((r) => requestAnimationFrame(r));
      if (v.scene.globe.tilesLoaded && i > 200) break;
    }
  }, { view });
  await page.waitForTimeout(1500);
  const out = path.join(OUT_DIR, `polar-wireframe-${view.name}-${renderer}.png`);
  await page.screenshot({ path: out });
  await browser.close();
  return out;
}

(async () => {
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
  const views = [
    { name: "southpole-close", lon: 0, lat: -89, height: 3_000_000 },
    { name: "northpole-close", lon: 0, lat: 89, height: 3_000_000 },
  ];
  console.log("[polar-wireframe]");
  for (const view of views) {
    for (const renderer of ["webgl", "webgpu"]) {
      console.log(`  ${view.name} ${renderer}`);
      await capture(renderer, view);
    }
  }
})();
