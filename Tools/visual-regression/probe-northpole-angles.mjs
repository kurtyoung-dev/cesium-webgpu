#!/usr/bin/env node
// Capture the north pole from multiple camera positions on both backends
// for visual side-by-side review. WGS84 ellipsoid, no debug overlay.
// Clock pinned to FIXED_CLOCK_UTC for cross-session reproducibility —
// see WEBGPU_DEBUGGING_LOG.md Batch 70 for why this matters.

import { chromium } from "playwright";
import fs from "fs";
import path from "path";

const BASE = "http://localhost:8080";
const OUT_DIR = "Tools/visual-regression/output";

// Pinned clock — matches probe-polar-multi-plain.mjs.
const FIXED_CLOCK_UTC = "2026-05-19T18:00:00Z";

// Views around the north pole. lon varies to rotate the camera, lat
// varies to change pitch toward / away from the pole, height covers
// close (~3 Mm) through low-orbit (~8 Mm) through orbit (~12 Mm).
const VIEWS = [
  { name: "np-zenith-3Mm", lon: 0, lat: 89, height: 3_000_000 },
  { name: "np-zenith-1Mm", lon: 0, lat: 89, height: 1_000_000 },
  { name: "np-tilt-85-2Mm", lon: 0, lat: 85, height: 2_000_000 },
  { name: "np-loworbit-70", lon: 0, lat: 70, height: 6_000_000 },
  { name: "np-orbit-80", lon: 0, lat: 80, height: 12_000_000 },
  { name: "np-orbit-60", lon: 0, lat: 60, height: 12_000_000 },
  { name: "np-from-greenland", lon: -40, lat: 75, height: 5_000_000 },
  { name: "np-from-asia", lon: 100, lat: 75, height: 5_000_000 },
];

async function capture(renderer, view) {
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

  await page.evaluate(
    async ({ view, clockUTC }) => {
      const C = await import("/Build/CesiumUnminified/index.js");
      const v = window.viewer;
      const vm = v.baseLayerPicker.viewModel;
      const wgs84 = vm.terrainProviderViewModels.find((t) =>
        String(t.name || "")
          .toLowerCase()
          .includes("wgs84"),
      );
      if (wgs84) vm.selectedTerrain = wgs84;
      // Pin the clock — matches probe-polar-multi-plain.mjs.
      const fixed = C.JulianDate.fromIso8601(clockUTC);
      v.clock.currentTime = fixed.clone();
      v.clock.startTime = fixed.clone();
      v.clock.stopTime = fixed.clone();
      v.clock.shouldAnimate = false;
      v.clock.multiplier = 0;
      v.camera.setView({
        destination: C.Cartesian3.fromDegrees(view.lon, view.lat, view.height),
      });
      for (let i = 0; i < 1500; i++) {
        v.scene.render();
        await new Promise((r) => requestAnimationFrame(r));
        if (v.scene.globe.tilesLoaded && i > 300) break;
      }
    },
    { view, clockUTC: FIXED_CLOCK_UTC },
  );
  await page.waitForTimeout(2000);
  const out = path.join(OUT_DIR, `${view.name}-${renderer}.png`);
  await page.screenshot({ path: out });
  await browser.close();
  return out;
}

(async () => {
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
  console.log("[northpole-angles] WGS84, no overlay, both backends");
  for (const view of VIEWS) {
    for (const renderer of ["webgl", "webgpu"]) {
      console.log(`  ${view.name} ${renderer}`);
      await capture(renderer, view);
    }
  }
})();
