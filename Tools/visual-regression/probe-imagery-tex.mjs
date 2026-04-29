#!/usr/bin/env node
// Probe what's actually in the imagery textures and uniform buffers.
// Reads the first imagery layer's texture and checks if it has expected
// content (Bing aerial = mostly green/blue, not solid color).
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
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });

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
    const device = ctx._device;

    // Find the globe surface renderer's imagery cache
    const fr = ctx.getFeatureRenderer?.(/* GLOBE_SURFACE */ 0);
    // Walk through the first ready tile and find its imagery
    const surface = v.scene.globe._surface;
    const tiles = surface._tilesToRender;
    const sampleTile = tiles?.[0];
    if (!sampleTile?.data?.imagery?.length) {
      return { error: "no imagery on first tile", tilesCount: tiles?.length };
    }

    // Inspect first imagery
    const ti = sampleTile.data.imagery[0];
    const imagery = ti.readyImagery;
    const dump = {
      tilesToRender: tiles.length,
      tileLevel: sampleTile.level,
      tileX: sampleTile.x,
      tileY: sampleTile.y,
      imageryReady: !!imagery,
      tsImagery: !!ti.textureTranslationAndScale,
      ts: ti.textureTranslationAndScale ? {
        x: ti.textureTranslationAndScale.x,
        y: ti.textureTranslationAndScale.y,
        z: ti.textureTranslationAndScale.z,
        w: ti.textureTranslationAndScale.w,
      } : null,
      tcr: ti.textureCoordinateRectangle ? {
        x: ti.textureCoordinateRectangle.x,
        y: ti.textureCoordinateRectangle.y,
        z: ti.textureCoordinateRectangle.z,
        w: ti.textureCoordinateRectangle.w,
      } : null,
      imageryHasTex: !!imagery?.texture,
      imageryHasWebGPUTex: !!imagery?._webgpuTexture || !!imagery?.webgpuTexture,
      imageryHasWebGPUView: !!imagery?._webgpuTextureView || !!imagery?.webgpuTextureView,
      imageryStateNum: imagery?.state,
      imageryHasImage: !!imagery?.image,
      imageryImageType: imagery?.image?.constructor?.name,
      imageryImageSize: imagery?.image
        ? { w: imagery.image.width || imagery.image.naturalWidth, h: imagery.image.height || imagery.image.naturalHeight }
        : null,
      useWebMercatorT: ti.useWebMercatorT,
    };
    // Pull mesh details
    if (sampleTile.data.mesh) {
      const m = sampleTile.data.mesh;
      const enc = m.encoding;
      dump.mesh = {
        hasNormals: !!enc?.hasVertexNormals,
        hasWebMercatorT: !!enc?.hasWebMercatorT,
        hasGeodeticSurfaceNormals: !!enc?.hasGeodeticSurfaceNormals,
        quantization: enc?.quantization,
        stride: enc?.stride || enc?.getStride?.(),
        center: m.center
          ? { x: m.center.x, y: m.center.y, z: m.center.z }
          : null,
      };
    }
    // Sample center of imagery image
    if (imagery?.image && imagery.image instanceof ImageBitmap) {
      const off = document.createElement("canvas");
      off.width = imagery.image.width;
      off.height = imagery.image.height;
      const cctx = off.getContext("2d");
      cctx.drawImage(imagery.image, 0, 0);
      const samples = [];
      for (const [x, y] of [
        [10, 10], [128, 128], [240, 240], [128, 10], [10, 240],
      ]) {
        const px = cctx.getImageData(x, y, 1, 1).data;
        samples.push(`(${x},${y})=[${px[0]},${px[1]},${px[2]},${px[3]}]`);
      }
      dump.imagerySamplesRGBA = samples;
    }
    return dump;
  });

  await browser.close();
  console.log(JSON.stringify(result, null, 2));
})();
