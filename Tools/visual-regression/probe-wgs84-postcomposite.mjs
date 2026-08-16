#!/usr/bin/env node
// @purpose One-off debug harness from the WGS84 reprojection investigation: terrain + debug-flag toggle capture (post-composite stage variant).
// @status INVESTIGATION

import { chromium } from "playwright";
import path from "path";

const BASE = "http://localhost:8080";
const OUT_DIR = "Tools/visual-regression/output";

async function capture(label, flagName) {
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
    async ({ flagName }) => {
      const v = window.viewer;
      const vm = v.baseLayerPicker.viewModel;
      const wgs84 = vm.terrainProviderViewModels.find((t) =>
        String(t.name || "")
          .toLowerCase()
          .includes("wgs84"),
      );
      if (wgs84) vm.selectedTerrain = wgs84;
      if (flagName) window[flagName] = true;
      for (let i = 0; i < 1200; i++) {
        v.scene.render();
        await new Promise((r) => requestAnimationFrame(r));
      }
    },
    { flagName },
  );
  await page.waitForTimeout(2500);
  const out = path.join(OUT_DIR, `wgs84-${label}.png`);
  await page.screenshot({ path: out });
  await browser.close();
  return out;
}

(async () => {
  console.log(`[probe-wgs84-postcomposite] post-composite color and alpha`);
  console.log(`  color`);
  await capture("postcomp-color", "_webgpuGlobePostCompositeColorDebug");
  console.log(`  alpha`);
  await capture("postcomp-alpha", "_webgpuGlobePostCompositeAlphaDebug");
})();
