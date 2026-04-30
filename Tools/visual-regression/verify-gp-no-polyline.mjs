#!/usr/bin/env node
/**
 * Same camera as verify-ground-polyline-zoom but WITHOUT adding the
 * polyline. If the "grey rectangles" still appear, they're terrain
 * artifacts unrelated to the polyline.
 */
import { chromium } from "playwright";
import fs from "fs";

const BASE = "http://localhost:8080";

(async () => {
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

  await page.goto(`${BASE}/Apps/CesiumViewer/index.html?renderer=webgpu`, {
    waitUntil: "networkidle",
    timeout: 90_000,
  });
  await page.waitForFunction(() => !!window.viewer, { timeout: 90_000 });

  await page.evaluate(async () => {
    const C = await import("/Build/CesiumUnminified/index.js");
    const v = window.viewer;
    v.camera.setView({
      destination: C.Cartesian3.fromDegrees(-75.25, 40.25, 50000),
      orientation: { heading: 0, pitch: -1.57, roll: 0 },
    });
    for (let i = 0; i < 240; i++) {
      v.scene.render();
      await new Promise((r) => requestAnimationFrame(r));
    }
  });

  const buf = await page.screenshot({ omitBackground: false });
  fs.writeFileSync(
    "Tools/visual-regression/output/verify-gp-no-polyline.png",
    buf,
  );
  console.log(`PNG bytes: ${buf.length}`);
  await browser.close();
})();
