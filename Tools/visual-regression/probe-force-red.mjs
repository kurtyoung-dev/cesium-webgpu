#!/usr/bin/env node
import { chromium } from "playwright";
import fs from "fs";
import path from "path";

const OUT_DIR = "Tools/visual-regression/output";

for (const renderer of ["webgl", "webgpu"]) {
  const browser = await chromium.launch({
    channel: "msedge", headless: true,
    args: ["--enable-unsafe-webgpu", "--enable-features=Vulkan", "--use-vulkan"],
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  await page.goto(`http://localhost:8080/Apps/CesiumViewer/index.html?renderer=${renderer}`, { waitUntil: "networkidle" });
  await page.waitForFunction(() => !!window.viewer);
  try {
    await page.waitForFunction(() => !!window.CesiumDebug, { timeout: 5000 });
  } catch (e) {
    // WebGL build may not install CesiumDebug — fall back to direct flag set
  }

  await page.evaluate(async () => {
    const C = await import("/Build/CesiumUnminified/index.js");
    const v = window.viewer;
    v.scene.globe.showGroundAtmosphere = false;
    if (window.CesiumDebug?.globeFragmentDebug) {
      window.CesiumDebug.globeFragmentDebug("force-red");
    }
    v.camera.setView({ destination: C.Cartesian3.fromDegrees(-100, 40, 12_000_000) });
    for (let i = 0; i < 600; i++) {
      v.scene.render();
      await new Promise((r) => requestAnimationFrame(r));
      if (v.scene.globe.tilesLoaded && i > 60) break;
    }
  });
  await page.waitForTimeout(1500);

  const buffer = await page.screenshot();
  const out = path.join(OUT_DIR, `forcered-mid-12mm-${renderer}.png`);
  fs.writeFileSync(out, buffer);

  const base64 = buffer.toString("base64");
  const stats = await page.evaluate(async (b64) => {
    const img = new Image();
    img.src = "data:image/png;base64," + b64;
    await img.decode();
    const cv = document.createElement("canvas");
    cv.width = img.width; cv.height = img.height;
    cv.getContext("2d").drawImage(img, 0, 0);
    const data = cv.getContext("2d").getImageData(0, 0, img.width, img.height).data;
    let r = 0, g = 0, b = 0, n = 0;
    let redPx = 0;
    const cx = img.width / 2 | 0, cy = img.height / 2 | 0;
    for (let y = cy - 100; y < cy + 100; y++) {
      for (let x = cx - 100; x < cx + 100; x++) {
        const i = (y * img.width + x) * 4;
        r += data[i]; g += data[i + 1]; b += data[i + 2]; n++;
        if (data[i] > 200 && data[i + 1] < 50 && data[i + 2] < 50) redPx++;
      }
    }
    return { meanR: r / n, meanG: g / n, meanB: b / n, redPxPct: 100 * redPx / n };
  }, base64);

  console.log(`${renderer.padEnd(8)} center-200x200: R=${stats.meanR.toFixed(1)} G=${stats.meanG.toFixed(1)} B=${stats.meanB.toFixed(1)}  bright-red pixels=${stats.redPxPct.toFixed(1)}%`);
  await browser.close();
}
