#!/usr/bin/env node
// Like probe-polar-multi-angle but WITHOUT the DebugTileImageryProvider
// overlay. Gives a clean measure of imagery-only diffs at each polar
// view. The debug overlay adds tile-grid lines that don't align perfectly
// between backends and inflate the pixel-diff number.
//
// CLOCK PINNING (Batch 70+) — Both backends are captured with the
// Cesium clock frozen at FIXED_CLOCK_UTC. Without this, the clock
// auto-advances between launches and the terminator falls in
// different screen positions per capture, producing run-to-run
// non-determinism in the cross-backend diff. See
// WEBGPU_DEBUGGING_LOG.md Batch 69 for the bisection that surfaced
// this. Keep this constant stable across batches so historical
// baselines remain comparable.

import { chromium } from "playwright";
import fs from "fs";
import path from "path";

const BASE = "http://localhost:8080";
const OUT_DIR = "Tools/visual-regression/output";

// Fixed UTC moment for every capture. Choice rationale:
//   - 18:00 UTC = noon CST → midlat-mid (lon=-100, lat=40) is at solar
//     noon, well-lit and on the day side, no terminator in view.
//   - May 19, late spring in the northern hemisphere → north pole is in
//     continuous daylight (always on the day side regardless of UTC),
//     south pole is in continuous darkness. Both poles render their
//     "stable" lighting state, no terminator sweep across either.
//   - 2026 keeps this in alignment with the migration-doc timeline.
const FIXED_CLOCK_UTC = "2026-05-19T18:00:00Z";

const VIEWS = [
  { name: "northpole-close", lon: 0, lat: 89, height: 3_000_000 },
  { name: "northpole-orbit", lon: 0, lat: 80, height: 12_000_000 },
  { name: "southpole-close", lon: 0, lat: -89, height: 3_000_000 },
  { name: "southpole-orbit", lon: 0, lat: -80, height: 12_000_000 },
  { name: "equator-mid", lon: 0, lat: 0, height: 3_000_000 },
  { name: "midlat-mid", lon: -100, lat: 40, height: 3_000_000 },
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
      // Pin the clock BEFORE any rendering so the very first frame uses
      // the fixed time. `shouldAnimate = false` blocks the per-frame
      // tick from advancing. Setting `currentTime` and `clock.startTime`
      // / `clock.stopTime` to the same JulianDate also locks the
      // timeline widget. Both backends use this exact same setup.
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
  const out = path.join(OUT_DIR, `polar-plain-${view.name}-${renderer}.png`);
  await page.screenshot({ path: out });
  await browser.close();
  return out;
}

(async () => {
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
  console.log("[polar-multi-plain] WGS84, NO debug overlay, both backends");
  for (const view of VIEWS) {
    for (const renderer of ["webgl", "webgpu"]) {
      console.log(`  ${view.name} ${renderer}`);
      await capture(renderer, view);
    }
  }
})();
