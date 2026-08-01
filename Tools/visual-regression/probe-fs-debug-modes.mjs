#!/usr/bin/env node
// Capture each globe-fragment debug mode at a mid-latitude view.
// Useful for verifying:
//   - "uv" — Red=U, Green=V, Blue=webMercT. Should look like a clean
//     RGB gradient with no banding.
//   - "alpha" — texCoordsAlpha mask. Should be solid red where the tile
//     is fully covered by layer 0, 0 where outside.
//   - "sample0", "sample1" — raw imagery sampling output, bypasses all
//     compositing. Verifies the per-layer texture is what we expect.
//   - "post-composite-color" — what the composite stage emits before
//     material / atmosphere / fog.

import { chromium } from "playwright";
import fs from "fs";
import path from "path";

const BASE = "http://localhost:8080";
const OUT_DIR = "Tools/visual-regression/output";

// The modes most relevant to imagery/UV correctness.
const MODES = [
  "uv",
  "alpha",
  "layer-count",
  "sample0",
  "tex0-alpha",
  "post-composite-color",
  "mip4",
  "lod-magnitude",
];

const VIEW = { lon: -100, lat: 40, height: 3_000_000 };

async function capture(mode) {
  const browser = await chromium.launch({
    channel: "msedge",
    headless: true,
    args: ["--enable-unsafe-webgpu", "--use-vulkan", "--disable-cache"],
  });
  const page = await browser.newPage({
    viewport: { width: 1280, height: 720 },
  });
  await page.goto(`${BASE}/Apps/CesiumViewer/index.html?renderer=webgpu`, {
    waitUntil: "networkidle",
  });
  await page.waitForFunction(() => !!window.viewer);

  await page.evaluate(
    async ({ mode, view }) => {
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
        destination: C.Cartesian3.fromDegrees(view.lon, view.lat, view.height),
      });
      for (let i = 0; i < 1500; i++) {
        v.scene.render();
        await new Promise((r) => requestAnimationFrame(r));
        if (v.scene.globe.tilesLoaded && i > 300) break;
      }
      // `getActiveDebugSentinel` looks up by NAME, not by sentinel value.
      globalThis._webgpuGlobeDebugMode = mode;
      // Several frames so the tile UB re-packs with the sentinel applied.
      for (let i = 0; i < 4; i++) {
        v.scene.render();
        await new Promise((r) => requestAnimationFrame(r));
      }
    },
    { mode, view: VIEW },
  );
  await page.waitForTimeout(800);
  const out = path.join(OUT_DIR, `fs-debug-${mode}-webgpu.png`);
  await page.screenshot({ path: out });
  await browser.close();
  return out;
}

(async () => {
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
  console.log("[fs-debug-modes] capturing each mode at midlat view");
  for (const mode of MODES) {
    console.log(`  ${mode}`);
    await capture(mode);
  }
})();
