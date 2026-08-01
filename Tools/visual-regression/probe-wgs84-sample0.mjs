#!/usr/bin/env node
// Sample0 debug after alpha=1 fix.

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
      const blp = v.baseLayerPicker;
      const vm = blp.viewModel;
      const wgs84Tvm = vm.terrainProviderViewModels.find((t) =>
        String(t.name || "")
          .toLowerCase()
          .includes("wgs84"),
      );
      if (wgs84Tvm) vm.selectedTerrain = wgs84Tvm;
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
  await page.screenshot({ path: out, fullPage: false });
  await browser.close();
  return out;
}

(async () => {
  console.log(`[probe-wgs84-sample0] post-fix sample debug`);
  console.log(`  sample0`);
  await capture("postfix-sample0", "_webgpuGlobeSample0Debug");
  console.log(`  lcdbg`);
  await capture("postfix-lcdbg", "_webgpuGlobeLayerCountDebug");
})();
