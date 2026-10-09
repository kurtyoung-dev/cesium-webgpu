#!/usr/bin/env node
// Verify close-zoom doesn't regress after Batch 56's per-fragment ground atmo fix.
// @purpose One-off check that close zoom did not regress after Batch 56's per-fragment ground-atmosphere fix on the WGS84 ellipsoid.
// @status ARCHIVED-CANDIDATE
//
// ARCHIVED by the wgs84 probe-kit harvest (DX-108; R-2026-09-17-11: moved,
// not deleted). Its conclusion is banked in the wgs84 probe-kit harvest entry in migration_doc/WEBGPU_DEBUGGING_LOG.md.
// Its view is the rig `wgs84-close-1mm` (this page) and the wave-end scene
// `wgs84-close` (split-screen page); live equivalent:
//   node Tools/visual-regression/probe-wgs84.mjs --scene close

import { chromium } from "playwright";
import path from "path";

const BASE = "http://localhost:8080";
const OUT_DIR = "Tools/visual-regression/output";

async function capture(rendererArg) {
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
  await page.goto(
    `${BASE}/Apps/CesiumViewer/index.html?renderer=${rendererArg}`,
    {
      waitUntil: "networkidle",
    },
  );
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
    v.camera.setView({
      destination: C.Cartesian3.fromDegrees(-100, 40, 1000000), // Texas, 1 Mm altitude
    });
    for (let i = 0; i < 600; i++) {
      v.scene.render();
      await new Promise((r) => requestAnimationFrame(r));
    }
  });
  await page.waitForTimeout(1500);
  const out = path.join(OUT_DIR, `wgs84-close-postfix-${rendererArg}.png`);
  await page.screenshot({ path: out });
  await browser.close();
  return out;
}

(async () => {
  console.log(`[wgs84-close-postfix] close-zoom after Batch 56 fixes`);
  console.log(`  webgl`);
  await capture("webgl");
  console.log(`  webgpu`);
  await capture("webgpu");
})();
