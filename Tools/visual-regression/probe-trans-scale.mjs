#!/usr/bin/env node
// Inspect tileImagery.textureTranslationAndScale on both backends at close zoom.
// @purpose Prints tileImagery.textureTranslationAndScale for rendered tiles on both backends at close zoom.
// @status INVESTIGATION

import { chromium } from "playwright";

for (const renderer of ["webgl", "webgpu"]) {
  const browser = await chromium.launch({
    channel: "msedge",
    headless: true,
    args: [
      "--enable-unsafe-webgpu",
      "--enable-features=Vulkan",
      "--use-vulkan",
    ],
  });
  const page = await browser.newPage({
    viewport: { width: 1280, height: 720 },
  });
  await page.goto(
    `http://localhost:8080/Apps/CesiumViewer/index.html?renderer=${renderer}`,
    { waitUntil: "networkidle" },
  );
  await page.waitForFunction(() => !!window.viewer);
  await page.evaluate(async () => {
    const C = await import("/Build/CesiumUnminified/index.js");
    const v = window.viewer;
    v.camera.setView({
      destination: C.Cartesian3.fromDegrees(-100, 40, 1_000_000),
    });
    for (let i = 0; i < 300; i++) {
      v.scene.render();
      await new Promise((r) => requestAnimationFrame(r));
      if (v.scene.globe.tilesLoaded && i > 60) break;
    }
  });
  await page.waitForTimeout(1000);
  const info = await page.evaluate(() => {
    const v = window.viewer;
    const tiles = v.scene._globe._surface._tilesToRender || [];
    const sample = tiles.slice(0, 3).map((t) => {
      const ti = t?.data?.imagery?.[0];
      if (!ti) return null;
      const ts = ti.textureTranslationAndScale;
      return {
        tileLevel: t.level,
        useMercT: ti.useWebMercatorT,
        ts: ts
          ? `(${ts.x.toFixed(4)}, ${ts.y.toFixed(4)}, ${ts.z.toFixed(4)}, ${ts.w.toFixed(4)})`
          : null,
        hasReproj: !!ti.readyImagery?._webgpuReprojectedTexture,
      };
    });
    return { count: tiles.length, sample };
  });
  console.log(`[${renderer}]`, JSON.stringify(info, null, 2));
  await browser.close();
}
