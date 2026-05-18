#!/usr/bin/env node
import { chromium } from "playwright";
import fs from "fs";
import path from "path";

const BASE = "http://localhost:8080";
const OUT_DIR = "Tools/visual-regression/output";

async function capture(label, flagName) {
  const browser = await chromium.launch({
    channel: "msedge",
    headless: true,
    args: ["--enable-unsafe-webgpu", "--enable-features=Vulkan", "--use-vulkan", "--disable-cache"],
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  await page.goto(`${BASE}/Apps/CesiumViewer/index.html?renderer=webgpu`, { waitUntil: "networkidle" });
  await page.waitForFunction(() => !!window.viewer);
  await page.evaluate(async ({ flagName }) => {
    const v = window.viewer;
    const vm = v.baseLayerPicker.viewModel;
    const wgs84 = vm.terrainProviderViewModels.find((t) =>
      String(t.name || "").toLowerCase().includes("wgs84"));
    if (wgs84) vm.selectedTerrain = wgs84;
    if (flagName) window[flagName] = true;
    for (let i = 0; i < 1200; i++) {
      v.scene.render();
      await new Promise((r) => requestAnimationFrame(r));
    }
  }, { flagName });
  await page.waitForTimeout(2500);
  const out = path.join(OUT_DIR, `wgs84-${label}.png`);
  await page.screenshot({ path: out });
  await browser.close();
  return out;
}

(async () => {
  console.log(`[probe-wgs84-atmo] atmosphere/drape debugs`);
  console.log(`  fadeAmount`); await capture("fade-amount", "_webgpuGlobeFadeAmountDebug");
  console.log(`  draped`); await capture("draped", "_webgpuGlobeDrapedDebug");
  console.log(`  atmoColor`); await capture("atmo-color", "_webgpuGlobeAtmoColorDebug");
  console.log(`  transmittance`); await capture("transmittance", "_webgpuGlobeTransmittanceDebug");
})();
