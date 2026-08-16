// @purpose WebGL twin of disable-skyatmo-probe: disables skyAtmosphere/groundAtmosphere/fog/skyBox and captures, for dark-sky layer attribution.
// @status INVESTIGATION

import { chromium } from "playwright";

const browser = await chromium.launch({
  channel: "msedge",
  headless: true,
  args: ["--enable-unsafe-webgpu", "--enable-features=Vulkan"],
});
const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
await page.goto(
  "http://localhost:8080/Apps/CesiumViewer/index.html?renderer=webgl",
  {
    waitUntil: "networkidle",
    timeout: 60000,
  },
);
await page.waitForFunction(() => !!window.viewer, { timeout: 60000 });

await page.evaluate(async () => {
  const v = window.viewer;
  v.scene.skyAtmosphere.show = false;
  v.scene.globe.showGroundAtmosphere = false;
  v.scene.fog.enabled = false;
  v.scene.skyBox.show = false;
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
  "Tools/visual-regression/output/disable-skyatmo-wgl.png",
  Buffer.from(dataUrl.replace(/^data:image\/png;base64,/, ""), "base64"),
);

await browser.close();
