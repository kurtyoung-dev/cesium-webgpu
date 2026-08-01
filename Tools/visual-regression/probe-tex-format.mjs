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
await page.waitForTimeout(5000);

const result = await page.evaluate(() => {
  const v = window.viewer;
  // Try to find any imagery texture
  const surface = v.scene.globe._surface;
  const _tileProvider = surface.tileProvider;
  const tilesToRender = surface._tilesToRender;
  const sample = [];
  for (let i = 0; i < Math.min(3, tilesToRender.length); i++) {
    const tile = tilesToRender[i];
    const tileData = tile.data;
    if (tileData && tileData.imagery && tileData.imagery.length > 0) {
      const imageryLayer = tileData.imagery[0];
      const readyImagery = imageryLayer.readyImagery;
      if (readyImagery && readyImagery.texture) {
        const tex = readyImagery.texture;
        sample.push({
          tileLevel: tile.level,
          tileX: tile.x,
          tileY: tile.y,
          texFormat: tex._format || tex.format,
          texPixelFormat: tex._pixelFormat,
          texPixelDatatype: tex._pixelDatatype,
          texInternalFormat: tex._internalFormat,
          isWebGPU: !!tex._gpuTexture,
        });
      }
    }
  }
  return { tileCount: tilesToRender.length, samples: sample };
});
await browser.close();
console.log(JSON.stringify(result, null, 2));
