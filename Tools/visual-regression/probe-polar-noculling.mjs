#!/usr/bin/env node
// Test whether disabling backface culling fixes the polar black hole.
// @purpose Diagnostic: tested whether disabling backface culling fixes the polar black hole
// @status INVESTIGATION

import { chromium } from "playwright";
import fs from "fs";
import path from "path";

const BASE = "http://localhost:8080";
const OUT_DIR = "Tools/visual-regression/output";

async function capture(renderer) {
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
  await page.goto(`${BASE}/Apps/CesiumViewer/index.html?renderer=${renderer}`, {
    waitUntil: "networkidle",
  });
  await page.waitForFunction(() => !!window.viewer);

  await page.evaluate(async () => {
    const C = await import("/Build/CesiumUnminified/index.js");
    const v = window.viewer;
    const vm = v.baseLayerPicker.viewModel;
    const wgs84 = vm.terrainProviderViewModels.find((t) =>
      String(t.name || "")
        .toLowerCase()
        .includes("wgs84"),
    );
    if (wgs84) vm.selectedTerrain = wgs84;
    v.scene.globe.backFaceCulling = false;
    v.camera.setView({
      destination: C.Cartesian3.fromDegrees(0, -89, 3_000_000),
    });
    for (let i = 0; i < 1200; i++) {
      v.scene.render();
      await new Promise((r) => requestAnimationFrame(r));
      if (v.scene.globe.tilesLoaded && i > 200) break;
    }
  });
  await page.waitForTimeout(1500);
  const out = path.join(OUT_DIR, `polar-noculling-${renderer}.png`);
  await page.screenshot({ path: out });
  await browser.close();
  return out;
}

(async () => {
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
  console.log("[polar-noculling]");
  for (const renderer of ["webgl", "webgpu"]) {
    console.log(`  ${renderer}`);
    await capture(renderer);
  }
})();
