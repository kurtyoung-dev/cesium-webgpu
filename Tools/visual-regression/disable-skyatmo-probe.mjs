// @purpose Disables skyAtmosphere/groundAtmosphere/fog/skyBox on WebGPU and captures, isolating which environment layer caused the dark-sky bug.
// @status INVESTIGATION

import { chromium } from "playwright";

const browser = await chromium.launch({
  channel: "msedge",
  headless: true,
  args: ["--enable-unsafe-webgpu", "--enable-features=Vulkan"],
});
const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
await page.goto(
  "http://localhost:8080/Apps/CesiumViewer/index.html?renderer=webgpu",
  {
    waitUntil: "networkidle",
    timeout: 60000,
  },
);
await page.waitForFunction(() => !!window.viewer, { timeout: 60000 });

await page.evaluate(async () => {
  const v = window.viewer;
  v.scene.skyAtmosphere.show = false; // disable atmosphere
  v.scene.globe.showGroundAtmosphere = false; // disable ground atmosphere
  v.scene.fog.enabled = false; // disable fog
  v.scene.skyBox.show = false; // disable stars
  for (let i = 0; i < 30; i++) {
    v.scene.render();
    await new Promise((r) => requestAnimationFrame(r));
  }
});
await page.waitForTimeout(2000);

const dataUrl = await page.evaluate(() =>
  window.viewer.scene.canvas.toDataURL("image/png"),
);
const fs = await import("node:fs/promises");
await fs.writeFile(
  "Tools/visual-regression/output/disable-skyatmo.png",
  Buffer.from(dataUrl.replace(/^data:image\/png;base64,/, ""), "base64"),
);

await browser.close();
console.log("saved disable-skyatmo.png");
