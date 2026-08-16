// @purpose Minimal WebGPU CesiumViewer boot dumping frame-state stats and one screenshot
// @status INVESTIGATION

import { chromium } from "playwright";

const URL =
  "http://localhost:8080/Apps/CesiumViewer/index.html?renderer=webgpu";
const browser = await chromium.launch({ headless: true, channel: "msedge" });
const ctx = await browser.newContext({
  viewport: { width: 1280, height: 720 },
});
const page = await ctx.newPage();
await page.goto(URL, { waitUntil: "networkidle" });
await page.waitForFunction(() => !!window.viewer, { timeout: 30000 });
// Run for ~6 seconds to give pipeline async + afterRender chain time to settle.
await page.evaluate(async () => {
  for (let batch = 0; batch < 12; batch++) {
    await new Promise((r) => {
      let n = 0;
      (function tick() {
        if (n++ > 20) r();
        else requestAnimationFrame(tick);
      })();
    });
    await new Promise((r) => setTimeout(r, 100));
  }
});

const stats = await page.evaluate(() => {
  const v = window.viewer;
  const canvas = v.canvas;
  const fs = v.scene._frameState;
  return {
    cmdListLength: fs.commandList.length,
    cmdListPasses: fs.commandList.map((c) => c.pass),
    requestRenderMode: v.scene.requestRenderMode,
    canvasWidth: canvas.width,
    canvasHeight: canvas.height,
    tilesToRender: v.scene.globe._surface._tilesToRender.length,
  };
});
console.log("Stats:", JSON.stringify(stats, null, 2));

await page.screenshot({
  path: "F:/Dev/GH/cesium-webgpu/Tools/visual-regression/output/diag-fixed-cesiumviewer.png",
  fullPage: false,
});
console.log("Screenshot saved to output/diag-fixed-cesiumviewer.png");

await browser.close();
