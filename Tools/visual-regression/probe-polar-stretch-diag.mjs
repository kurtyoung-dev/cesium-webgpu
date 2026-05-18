#!/usr/bin/env node
// Reproduce the polar-stretching artifact at WGS84 orbit and overlay
// the new DebugTileImageryProvider so we can SEE which tiles are
// affected (by rectangle / Mercator-limit annotations).

import { chromium } from "playwright";
import fs from "fs";
import path from "path";

const BASE = "http://localhost:8080";
const OUT_DIR = "Tools/visual-regression/output";

async function capture(renderer, label, withOverlay) {
  const browser = await chromium.launch({
    channel: "msedge", headless: true,
    args: ["--enable-unsafe-webgpu", "--enable-features=Vulkan", "--use-vulkan", "--disable-cache"],
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  await page.goto(`${BASE}/Apps/CesiumViewer/index.html?renderer=${renderer}`, { waitUntil: "networkidle" });
  await page.waitForFunction(() => !!window.viewer);
  try {
    await page.waitForFunction(() => !!window.CesiumDebug, { timeout: 5000 });
  } catch {}

  await page.evaluate(async ({ withOverlay }) => {
    const C = await import("/Build/CesiumUnminified/index.js");
    const v = window.viewer;
    const vm = v.baseLayerPicker.viewModel;
    const wgs84 = vm.terrainProviderViewModels.find((t) =>
      String(t.name || "").toLowerCase().includes("wgs84"));
    if (wgs84) vm.selectedTerrain = wgs84;

    if (withOverlay && C.DebugTileImageryProvider) {
      v.imageryLayers.addImageryProvider(new C.DebugTileImageryProvider({ colorByLevel: true }));
    }

    // Match the user's screenshot altitude (the full-globe-visible view
    // where polar stretching is most prominent).
    v.camera.setView({
      destination: C.Cartesian3.fromDegrees(-105, 50, 14_000_000),
    });
    for (let i = 0; i < 1200; i++) {
      v.scene.render();
      await new Promise((r) => requestAnimationFrame(r));
      if (v.scene.globe.tilesLoaded && i > 200) break;
    }
  }, { withOverlay });
  await page.waitForTimeout(2000);

  const out = path.join(OUT_DIR, `polar-${label}-${renderer}.png`);
  await page.screenshot({ path: out });
  await browser.close();
  return out;
}

(async () => {
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
  console.log("[probe-polar-stretch-diag]");
  console.log("  Plain WebGPU");
  await capture("webgpu", "plain", false);
  console.log("  WebGPU + DebugTileImageryProvider overlay");
  await capture("webgpu", "overlay", true);
  console.log("  Plain WebGL (reference)");
  await capture("webgl", "plain", false);
})();
