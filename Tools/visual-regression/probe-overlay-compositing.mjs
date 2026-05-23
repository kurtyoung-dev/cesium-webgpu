#!/usr/bin/env node
// Layer 2 (DebugTileImageryProvider) on top of layer 1 (Ion imagery).
// Verifies multi-layer compositing on WebGPU matches WebGL.
//
// What to look for in the screenshots:
//   - Tile labels (text "L/X/Y", "L=4 X=7 Y=4") right-side up and in the
//     same screen position on both backends.
//   - Cyan/magenta/yellow tile-grid lines line up with the underlying
//     Ion imagery.
//   - Mercator-limit edges (±85°) marked with a different color than
//     the regular tile edges.

import { chromium } from "playwright";
import fs from "fs";
import path from "path";

const BASE = "http://localhost:8080";
const OUT_DIR = "Tools/visual-regression/output";

const VIEWS = [
  { name: "midlat-overlay", lon: -100, lat: 40, height: 3_000_000 },
  { name: "equator-overlay", lon: 0, lat: 0, height: 3_000_000 },
  { name: "mercator-edge-overlay", lon: 0, lat: 80, height: 6_000_000 },
];

async function capture(renderer, view) {
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
      // Layer 2: DebugTileImageryProvider overlay on top of base Ion imagery.
      if (C.DebugTileImageryProvider) {
        v.imageryLayers.addImageryProvider(
          new C.DebugTileImageryProvider({ colorByLevel: true }),
        );
      }
      v.camera.setView({
        destination: C.Cartesian3.fromDegrees(view.lon, view.lat, view.height),
      });
      for (let i = 0; i < 1500; i++) {
        v.scene.render();
        await new Promise((r) => requestAnimationFrame(r));
        if (v.scene.globe.tilesLoaded && i > 300) break;
      }
    },
    { view },
  );
  await page.waitForTimeout(1500);
  const out = path.join(OUT_DIR, `overlay-${view.name}-${renderer}.png`);
  await page.screenshot({ path: out });
  await browser.close();
  return out;
}

(async () => {
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
  console.log("[overlay-compositing] Ion + DebugTileImageryProvider overlay, both backends");
  for (const view of VIEWS) {
    for (const renderer of ["webgl", "webgpu"]) {
      console.log(`  ${view.name} ${renderer}`);
      await capture(renderer, view);
    }
  }
})();
