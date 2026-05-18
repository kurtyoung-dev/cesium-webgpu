#!/usr/bin/env node
// Check the actual enableLighting state on both backends at the default load.

import { chromium } from "playwright";

for (const renderer of ["webgl", "webgpu"]) {
  const browser = await chromium.launch({
    channel: "msedge",
    headless: true,
    args: ["--enable-unsafe-webgpu", "--enable-features=Vulkan", "--use-vulkan"],
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  await page.goto(`http://localhost:8080/Apps/CesiumViewer/index.html?renderer=${renderer}`, {
    waitUntil: "networkidle",
  });
  await page.waitForFunction(() => !!window.viewer);
  await page.evaluate(async () => {
    for (let i = 0; i < 60; i++) {
      window.viewer.scene.render();
      await new Promise((r) => requestAnimationFrame(r));
    }
  });
  const info = await page.evaluate(() => {
    const v = window.viewer;
    const g = v.scene.globe;
    const sft = v.scene._globe?._surface?.tileProvider;
    return {
      "globe.enableLighting": g.enableLighting,
      "globe.dynamicAtmosphereLighting": g.dynamicAtmosphereLighting,
      "globe.dynamicAtmosphereLightingFromSun": g.dynamicAtmosphereLightingFromSun,
      "tileProvider.enableLighting": sft?.enableLighting,
      "tileProvider.dynamicAtmosphereLighting": sft?.dynamicAtmosphereLighting,
      "scene.lightingActive": v.scene.lighting,
    };
  });
  console.log(`[${renderer}]`, JSON.stringify(info, null, 2));
  await browser.close();
}
