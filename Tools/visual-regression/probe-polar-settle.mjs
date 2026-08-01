#!/usr/bin/env node
// Test whether the polar-stretching artifact is settle-dependent
// (i.e., parent-imagery substitution during tile loading) or a
// steady-state bug. Capture at three settle budgets: 120 frames,
// 600 frames, 2400 frames.

import { chromium } from "playwright";
import fs from "fs";
import path from "path";

const BASE = "http://localhost:8080";
const OUT_DIR = "Tools/visual-regression/output";

async function capture(renderer, settleFrames) {
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

  const stats = await page.evaluate(
    async ({ settleFrames }) => {
      const C = await import("/Build/CesiumUnminified/index.js");
      const v = window.viewer;
      const vm = v.baseLayerPicker.viewModel;
      const wgs84 = vm.terrainProviderViewModels.find((t) =>
        String(t.name || "")
          .toLowerCase()
          .includes("wgs84"),
      );
      if (wgs84) vm.selectedTerrain = wgs84;
      v.scene.globe.tileCacheSize = 0; // force fresh tile loads
      v.camera.setView({
        destination: C.Cartesian3.fromDegrees(-105, 50, 14_000_000),
      });
      let tilesLoadedAt = -1;
      for (let i = 0; i < settleFrames; i++) {
        v.scene.render();
        await new Promise((r) => requestAnimationFrame(r));
        if (v.scene.globe.tilesLoaded && tilesLoadedAt < 0) tilesLoadedAt = i;
      }
      return {
        tilesLoadedAt,
        finalTilesLoaded: v.scene.globe.tilesLoaded,
        tileCount: v.scene._globe?._surface?._tilesToRender?.length ?? 0,
      };
    },
    { settleFrames },
  );
  await page.waitForTimeout(500);
  const out = path.join(
    OUT_DIR,
    `polar-settle-${renderer}-${settleFrames}.png`,
  );
  await page.screenshot({ path: out });
  await browser.close();
  return { ...stats, out };
}

(async () => {
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
  console.log("[polar-settle] testing settle dependency at 14Mm WGS84");
  for (const frames of [120, 600, 2400]) {
    const wgpu = await capture("webgpu", frames);
    console.log(
      `  webgpu @ ${frames} frames: tilesLoadedAt=${wgpu.tilesLoadedAt} tiles=${wgpu.tileCount} loaded=${wgpu.finalTilesLoaded}`,
    );
  }
})();
