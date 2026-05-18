#!/usr/bin/env node
// At south-pole-close: enable globeFragmentDebug("force-red"). If polar
// tiles are rasterizing (just with wrong imagery), they show RED in the
// center where the black hole was. If they're NOT rasterizing at all,
// the black hole stays.

import { chromium } from "playwright";
import fs from "fs";
import path from "path";

const BASE = "http://localhost:8080";
const OUT_DIR = "Tools/visual-regression/output";

const browser = await chromium.launch({
  channel: "msedge", headless: true,
  args: ["--enable-unsafe-webgpu", "--enable-features=Vulkan", "--use-vulkan", "--disable-cache"],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
await page.goto(`${BASE}/Apps/CesiumViewer/index.html?renderer=webgpu`, { waitUntil: "networkidle" });
await page.waitForFunction(() => !!window.viewer);
await page.waitForFunction(() => !!window.CesiumDebug, { timeout: 5000 });

await page.evaluate(async () => {
  const C = await import("/Build/CesiumUnminified/index.js");
  const v = window.viewer;
  const vm = v.baseLayerPicker.viewModel;
  const wgs84 = vm.terrainProviderViewModels.find((t) =>
    String(t.name || "").toLowerCase().includes("wgs84"));
  if (wgs84) vm.selectedTerrain = wgs84;
  window.CesiumDebug.globeFragmentDebug("force-red");
  v.camera.setView({
    destination: C.Cartesian3.fromDegrees(0, -89, 3_000_000),
  });
  for (let i = 0; i < 1200; i++) {
    v.scene.render();
    await new Promise((r) => requestAnimationFrame(r));
    if (v.scene.globe.tilesLoaded && i > 200) break;
  }
});
await page.waitForTimeout(1500);
const out = path.join(OUT_DIR, "polar-forcered-webgpu.png");
await page.screenshot({ path: out });
await browser.close();
console.log("saved", out);
