#!/usr/bin/env node
// Batch 64 probe — capture polar views with the simulation clock FROZEN
// at a fixed time on both backends, lighting/atmosphere disabled, and
// post-processing minimized. Isolates whether the residual diff comes
// from time-of-day drift (sun direction, day/night fade, animation tick).

import { chromium } from "playwright";
import fs from "fs";
import path from "path";

const BASE = "http://localhost:8080";
const OUT_DIR = "Tools/visual-regression/output";

const FIXED_ISO = "2026-05-18T12:00:00Z";

const VIEWS = [
  { name: "northpole-close", lon: 0, lat: 89, height: 3_000_000 },
  { name: "southpole-close", lon: 0, lat: -89, height: 3_000_000 },
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
    async ({ view, fixedISO }) => {
      const C = await import("/Build/CesiumUnminified/index.js");
      const v = window.viewer;
      const vm = v.baseLayerPicker.viewModel;
      const wgs84 = vm.terrainProviderViewModels.find((t) =>
        String(t.name || "")
          .toLowerCase()
          .includes("wgs84"),
      );
      if (wgs84) vm.selectedTerrain = wgs84;

      // Freeze the clock to a deterministic time
      const jd = C.JulianDate.fromIso8601(fixedISO);
      v.clock.currentTime = jd;
      v.clock.multiplier = 0;
      v.clock.shouldAnimate = false;

      // Strip everything that can vary with time/sun
      v.scene.skyAtmosphere.show = false;
      v.scene.globe.showGroundAtmosphere = false;
      v.scene.globe.enableLighting = false;
      v.scene.sun.show = false;
      v.scene.moon.show = false;
      v.scene.skyBox.show = false;
      v.scene.fog.enabled = false;

      v.camera.setView({
        destination: C.Cartesian3.fromDegrees(view.lon, view.lat, view.height),
      });
      for (let i = 0; i < 1500; i++) {
        v.scene.render();
        await new Promise((r) => requestAnimationFrame(r));
        if (v.scene.globe.tilesLoaded && i > 300) break;
      }
      // One more set of synchronous renders at the fixed time
      v.clock.currentTime = jd;
      v.scene.render();
      v.scene.render();
    },
    { view, fixedISO: FIXED_ISO },
  );
  await page.waitForTimeout(1500);
  const out = path.join(OUT_DIR, `polar-fixed-${view.name}-${renderer}.png`);
  await page.screenshot({ path: out });
  await browser.close();
  return out;
}

(async () => {
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
  console.log("[polar-fixed-time] WGS84, NO atmo/sun/lighting/fog/skybox");
  for (const view of VIEWS) {
    for (const renderer of ["webgl", "webgpu"]) {
      console.log(`  ${view.name} ${renderer}`);
      await capture(renderer, view);
    }
  }
})();
