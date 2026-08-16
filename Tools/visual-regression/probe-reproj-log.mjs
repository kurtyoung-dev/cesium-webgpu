#!/usr/bin/env node
// Capture all console output from a WebGPU CesiumViewer load to see
// whether the reprojection mipmap generation path is being hit.
// @purpose One-off diagnostic: captures all console output during a WebGPU load to check whether the reprojection mipmap path is hit
// @status INVESTIGATION

import { chromium } from "playwright";

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
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const msgs = [];
page.on("console", (m) => msgs.push(`${m.type()}: ${m.text()}`));
page.on("pageerror", (e) => msgs.push(`pageerror: ${e.message}`));

await page.goto(
  `http://localhost:8080/Apps/CesiumViewer/index.html?renderer=webgpu`,
  { waitUntil: "networkidle" },
);
await page.waitForFunction(() => !!window.viewer);
await page.evaluate(async () => {
  const C = await import("/Build/CesiumUnminified/index.js");
  const v = window.viewer;
  v.camera.setView({
    destination: C.Cartesian3.fromDegrees(-100, 40, 20_000_000),
  });
  for (let i = 0; i < 600; i++) {
    v.scene.render();
    await new Promise((r) => requestAnimationFrame(r));
    if (v.scene.globe.tilesLoaded && i > 60) break;
  }
});
await page.waitForTimeout(3000);
await browser.close();

const relevant = msgs.filter(
  (m) =>
    m.toLowerCase().includes("reproject") ||
    m.toLowerCase().includes("uploadimagesource") ||
    m.toLowerCase().includes("mipmap"),
);
console.log("Relevant messages:");
relevant.slice(0, 20).forEach((m) => console.log(`  ${m}`));
console.log(`Total ${msgs.length} messages, ${relevant.length} relevant.`);
