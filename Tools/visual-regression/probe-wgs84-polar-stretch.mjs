#!/usr/bin/env node
// Reproduce the user-reported polar-stretching artifact on WGS84 orbit.
// User flagged "stretched at the northern latitudes" — similar to a prior
// Ion-terrain bug.
//
// View: default Cesium home position (matches the user's screenshot —
// perspective view over North America with the limb visible).

import { chromium } from "playwright";
import fs from "fs";
import path from "path";

const BASE = "http://localhost:8080";
const OUT_DIR = "Tools/visual-regression/output";

async function capture(renderer) {
  const browser = await chromium.launch({
    channel: "msedge", headless: true,
    args: ["--enable-unsafe-webgpu", "--enable-features=Vulkan", "--use-vulkan", "--disable-cache"],
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  await page.goto(`${BASE}/Apps/CesiumViewer/index.html?renderer=${renderer}`, { waitUntil: "networkidle" });
  await page.waitForFunction(() => !!window.viewer);

  await page.evaluate(async () => {
    const v = window.viewer;
    // Swap to WGS84 ellipsoid (user's setup per the screenshot)
    const vm = v.baseLayerPicker.viewModel;
    const wgs84 = vm.terrainProviderViewModels.find((t) =>
      String(t.name || "").toLowerCase().includes("wgs84"));
    if (wgs84) vm.selectedTerrain = wgs84;
    // Match the user's screenshot — globe centered, North America + Arctic visible
    const C = await import("/Build/CesiumUnminified/index.js");
    v.camera.setView({
      destination: C.Cartesian3.fromDegrees(-105, 50, 14_000_000),
    });
    for (let i = 0; i < 1200; i++) {
      v.scene.render();
      await new Promise((r) => requestAnimationFrame(r));
      if (v.scene.globe.tilesLoaded && i > 200) break;
    }
  });
  await page.waitForTimeout(2000);

  const out = path.join(OUT_DIR, `wgs84-polar-${renderer}.png`);
  await page.screenshot({ path: out });
  await browser.close();
  return out;
}

(async () => {
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
  console.log("[probe-wgs84-polar-stretch] WGS84 + default home view");
  console.log("  webgl");
  await capture("webgl");
  console.log("  webgpu");
  await capture("webgpu");
})();
