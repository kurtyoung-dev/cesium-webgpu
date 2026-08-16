#!/usr/bin/env node
// @purpose Early attempt to introspect the globe imagery texture cache from the page; never reaches the per-device renderer instance
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
  await page.goto(`${BASE}/Apps/CesiumViewer/index.html?renderer=webgpu`, {
    waitUntil: "networkidle",
  });
  await page.waitForFunction(() => !!window.viewer);

  const result = await page.evaluate(async () => {
    const C = await import("/Build/CesiumUnminified/index.js");
    const v = window.viewer;
    v.camera.setView({
      destination: C.Cartesian3.fromDegrees(-75.5, 40.0, 5_000_000),
    });
    for (let i = 0; i < 240; i++) {
      v.scene.render();
      await new Promise((r) => requestAnimationFrame(r));
    }

    const ctx = v.scene.context;
    const _device = ctx._device;

    // Find globe surface renderer's _imageryTextureCache
    const _fr = ctx.getFeatureRenderer?.(0); // GLOBE_SURFACE = 0
    const _cacheEntries = [];
    const _renderer = null;
    // Iterate FR cache. We need to access the renderer instance. The
    // renderer is stored per-device in WebGPUGlobeRenderers map. Find it
    // via the fr's cache or via the scene path.
    const surface = v.scene.globe._surface;
    const _tp = surface._tileProvider;
    // Actually the renderer is per-device — let's locate via scene
    const _sr = v.scene._alternateSceneRenderer;
    // Heuristic: check global state - try a few well-known field names
    const probeKeys = ["_webgpuGlobeRenderers", "webgpuGlobeRenderers"];
    let _glob = null;
    for (const k of probeKeys) {
      if (window[k]) {
        _glob = window[k];
        break;
      }
    }

    // Hack: read via tile.data.imagery[0].readyImagery._webgpuTexture? No, cache is on renderer.
    // Best alternate: search the GPU texture pool. We can introspect the device.

    // Let's instead probe via the scene by tagging: the renderer's _imageryTextureCache
    // can be reached by looking at the scene's Render Scheduler registered FR.
    // Simpler: re-do uplook via cache map known by creation log.

    // Iterate a few tiles' imagery and find the renderer's view caching
    const tiles = surface._tilesToRender.slice(0, 3);
    const out = [];
    for (const t of tiles) {
      if (!t.data?.imagery?.length) continue;
      const ti = t.data.imagery[0];
      const imagery = ti.readyImagery;
      out.push({
        tileLevel: t.level,
        tileX: t.x,
        tileY: t.y,
        imageryKey: imagery?.key,
        imageryX: imagery?.x,
        imageryY: imagery?.y,
        imageryLevel: imagery?.level,
        webgpuRepro: !!imagery?._webgpuReprojectedTexture,
        hasImage: !!imagery?.image,
      });
    }
    return { tiles: out };
  });

  await browser.close();
  console.log(JSON.stringify(result, null, 2));
})();
