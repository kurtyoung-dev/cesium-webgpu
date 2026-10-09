#!/usr/bin/env node
// Sample0 debug after alpha=1 fix.
// @purpose One-off sample0 texture debug after the Batch-56 alpha=1 reprojection fix on the WGS84 ellipsoid.
// @status ARCHIVED-CANDIDATE
//
// ARCHIVED by the wgs84 probe-kit harvest (DX-108; R-2026-09-17-11: moved,
// not deleted). Its conclusion is banked in the wgs84 probe-kit harvest entry in migration_doc/WEBGPU_DEBUGGING_LOG.md.
// The window flag(s) this probe sets are named by no file in the engine's
// Renderer/WebGPU, Scene or Core directories (a one-level search), and the
// banked 2026-07-02 frames that set such flags are the plain frame: the
// globe-fragment debug registry reads `globalThis._webgpuGlobeDebugMode`
// (`CesiumDebug.globeFragmentDebug(name)`). Live equivalent, same view:
//   _webgpuGlobeSample0Debug -> node Tools/visual-regression/probe-wgs84.mjs --renderer webgpu --scene home --debug-mode sample0
//   _webgpuGlobeLayerCountDebug -> node Tools/visual-regression/probe-wgs84.mjs --renderer webgpu --scene home --debug-mode layer-count

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
