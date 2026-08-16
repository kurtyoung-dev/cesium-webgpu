#!/usr/bin/env node
// Check tex.a values after the alpha=1 force in reprojection FS.
// @purpose One-off debug: sampled tex.a values after the Batch-56 alpha=1 force in the WebGPU imagery-reprojection fragment shader.
// @status INVESTIGATION

import { chromium } from "playwright";
import path from "path";

const BASE = "http://localhost:8080";
const OUT_DIR = "Tools/visual-regression/output";

async function capture(label) {
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
  page.on("console", (m) => {
    const t = m.type();
    if (t === "error" || t === "warning") console.log(`  ${t}: ${m.text()}`);
  });

  await page.goto(`${BASE}/Apps/CesiumViewer/index.html?renderer=webgpu`, {
    waitUntil: "networkidle",
  });
  await page.waitForFunction(() => !!window.viewer);

  await page.evaluate(async () => {
    const v = window.viewer;
    const blp = v.baseLayerPicker;
    const vm = blp.viewModel;
    const wgs84Tvm = vm.terrainProviderViewModels.find((t) =>
      String(t.name || "")
        .toLowerCase()
        .includes("wgs84"),
    );
    if (wgs84Tvm) vm.selectedTerrain = wgs84Tvm;
    // Set tex alpha debug flag BEFORE rendering settles
    window._webgpuGlobeTexAlphaDebug = true;
    for (let i = 0; i < 1200; i++) {
      v.scene.render();
      await new Promise((r) => requestAnimationFrame(r));
    }
  });
  await page.waitForTimeout(2500);

  const out = path.join(OUT_DIR, `wgs84-alphadbg-${label}.png`);
  await page.screenshot({ path: out, fullPage: false });
  await browser.close();
  return out;
}

(async () => {
  console.log(`[probe-wgs84-alphadbg] testing texAlpha after alpha=1 fix`);
  const png = await capture("post-fix");
  console.log(`  output: ${png}`);
})();
