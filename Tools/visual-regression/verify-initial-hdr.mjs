#!/usr/bin/env node
/**
 * Verify initial-mount HDR works (no runtime toggle).
 * Goal: distinguish "HDR completely broken" from "HDR runtime toggle broken".
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

  page.on("console", (m) => {
    const t = m.type();
    const txt = m.text();
    if (t === "error") console.log(`[error] ${txt}`);
    if (t === "warning" && txt.includes("Attachment state"))
      console.log(`[warn] ${txt.slice(0, 200)}`);
    if (txt.includes("Batch110")) console.log(`[batch110] ${txt}`);
  });

  await page.goto(`${BASE}/Apps/CesiumViewer/index.html?renderer=webgpu`, {
    waitUntil: "networkidle",
    timeout: 90_000,
  });
  await page.waitForFunction(() => !!window.viewer, { timeout: 90_000 });

  // Set HDR=true BEFORE any rendering (initial mount in HDR mode).
  await page.evaluate(async () => {
    const C = await import("/Build/CesiumUnminified/index.js");
    const v = window.viewer;
    v.scene.highDynamicRange = true;
    v.camera.setView({
      destination: C.Cartesian3.fromDegrees(-75.5, 40.0, 5_000_000),
    });
    for (let i = 0; i < 240; i++) {
      v.scene.render();
      await new Promise((r) => requestAnimationFrame(r));
    }
  });

  const buf = await page.screenshot({ omitBackground: false });
  fs.writeFileSync(
    "Tools/visual-regression/output/verify-initial-hdr.png",
    buf,
  );
  console.log(`PNG bytes: ${buf.length}`);

  await browser.close();
})();
