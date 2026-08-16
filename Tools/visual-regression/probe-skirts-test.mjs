#!/usr/bin/env node
// Test if the blue tile-boundary lines on WebGPU are caused by terrain
// skirts. Capture WebGPU at WGS84 14Mm with skirts ON vs OFF.
// @purpose A/B capture of WebGPU terrain skirts ON vs OFF to test whether blue tile-boundary lines were caused by skirts.
// @status INVESTIGATION

import { chromium } from "playwright";
import fs from "fs";
import path from "path";

const BASE = "http://localhost:8080";
const OUT_DIR = "Tools/visual-regression/output";

async function capture(showSkirts) {
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
  await page.goto(`${BASE}/Apps/CesiumViewer/index.html?renderer=webgpu`, {
    waitUntil: "networkidle",
  });
  await page.waitForFunction(() => !!window.viewer);
  await page.evaluate(
    async ({ showSkirts }) => {
      const C = await import("/Build/CesiumUnminified/index.js");
      const v = window.viewer;
      const vm = v.baseLayerPicker.viewModel;
      const wgs84 = vm.terrainProviderViewModels.find((t) =>
        String(t.name || "")
          .toLowerCase()
          .includes("wgs84"),
      );
      if (wgs84) vm.selectedTerrain = wgs84;
      v.scene.globe.showSkirts = showSkirts;
      v.camera.setView({
        destination: C.Cartesian3.fromDegrees(-105, 50, 14_000_000),
      });
      for (let i = 0; i < 1200; i++) {
        v.scene.render();
        await new Promise((r) => requestAnimationFrame(r));
        if (v.scene.globe.tilesLoaded && i > 200) break;
      }
    },
    { showSkirts },
  );
  await page.waitForTimeout(2000);
  const out = path.join(OUT_DIR, `skirts-${showSkirts ? "on" : "off"}.png`);
  await page.screenshot({ path: out });
  await browser.close();
  return out;
}

(async () => {
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
  console.log("[skirts-test] WGS84 14Mm with skirts ON/OFF");
  console.log("  on");
  await capture(true);
  console.log("  off");
  await capture(false);
})();
