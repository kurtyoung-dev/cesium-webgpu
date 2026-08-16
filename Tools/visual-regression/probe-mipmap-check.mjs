#!/usr/bin/env node
// Inspect the WebGPU globe surface renderer's imagery cache to verify
// that uploaded textures now have mipLevelCount > 1.
// @purpose One-off: inspects the WebGPU globe imagery cache to confirm uploaded tile textures allocate mipLevelCount > 1.
// @status INVESTIGATION

import { chromium } from "playwright";

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
    if (t === "error") console.log(`  ${t}: ${m.text()}`);
  });
  page.on("pageerror", (e) => console.log(`  pageerror: ${e.message}`));

  await page.goto(`${BASE}/Apps/CesiumViewer/index.html?renderer=webgpu`, {
    waitUntil: "networkidle",
  });
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
  await page.waitForTimeout(2000);

  // Walk the renderer object graph looking for _imageryTextureCache
  const info = await page.evaluate(() => {
    const v = window.viewer;
    const scene = v.scene;
    const altRenderer = scene._alternateSceneRenderer;
    // Possible locations
    const candidates = {
      "scene._alternateSceneRenderer._imageryTextureCache":
        altRenderer?._imageryTextureCache,
      "scene._alternateSceneRenderer._globeSurfaceRenderer._imageryTextureCache":
        altRenderer?._globeSurfaceRenderer?._imageryTextureCache,
      "scene._globe._surface.tileProvider._imageryTextureCache":
        scene._globe?._surface?.tileProvider?._imageryTextureCache,
      "scene._context._globeSurfaceRenderer._imageryTextureCache":
        scene._context?._globeSurfaceRenderer?._imageryTextureCache,
    };
    const found = Object.entries(candidates).find(([, v]) => v && v.size > 0);
    if (!found) {
      return {
        error: "no cache found",
        keys: Object.keys(candidates).map((k) => `${k}: ${!!candidates[k]}`),
      };
    }
    const [location, cache] = found;
    const entries = Array.from(cache.entries()).slice(0, 5);
    return {
      location,
      cacheSize: cache.size,
      sample: entries.map(([key, val]) => ({
        key,
        hasTexture: !!val?.texture,
        mipLevelCount: val?.texture?.mipLevelCount,
        width: val?.texture?.width,
        height: val?.texture?.height,
      })),
    };
  });

  console.log(JSON.stringify(info, null, 2));
  await browser.close();
})();
