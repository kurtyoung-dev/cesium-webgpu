#!/usr/bin/env node
// Batch 62 — sample center pixel of canvas at south-pole-close for each
// FS debug mode. Goal: numerically confirm what value the WGSL `return`
// produces at the polar zenith pixel.

import { chromium } from "playwright";
import zlib from "zlib";

const BASE = "http://localhost:8080";

const MODES = [
  "production",
  "force-red",
  "alpha",
  "layer-count",
  "sample0",
  "tex0-alpha",
  "post-composite-color",
  "post-composite-alpha",
  "fade-amount",
  "atmo-color",
];

function decodeCenterPixel(pngBuf) {
  // Parse PNG: concatenate all IDAT chunks then inflate.
  let off = 8;
  const idats = [];
  let width = 0, bpp = 4;
  while (off < pngBuf.length) {
    const len = pngBuf.readUInt32BE(off);
    off += 4;
    const type = pngBuf.toString("ascii", off, off + 4);
    off += 4;
    if (type === "IHDR") {
      width = pngBuf.readUInt32BE(off);
      const colorType = pngBuf[off + 9];
      bpp = colorType === 6 ? 4 : colorType === 2 ? 3 : 4;
    }
    if (type === "IDAT") {
      idats.push(pngBuf.slice(off, off + len));
    }
    off += len + 4;
    if (type === "IEND") break;
  }
  if (idats.length === 0) return null;
  const data = zlib.inflateSync(Buffer.concat(idats));
  // Row 0: filter byte + width × bpp data
  return [data[1], data[2], data[3], bpp === 4 ? data[4] : 255];
}

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
await page.waitForFunction(() => !!window.CesiumDebug);

const POINTS = [
  ["center", 640, 360],
  ["pole-near", 640, 320],
  ["pole-near2", 640, 400],
  ["edge-NE", 900, 200],
  ["edge-SW", 380, 580],
];

console.log("[polar-pixel-sweep] @ south-pole-close (0,-89,3Mm) WGS84\n");
for (const mode of MODES) {
  await page.evaluate(async (mode) => {
    const C = await import("/Build/CesiumUnminified/index.js");
    const v = window.viewer;
    const vm = v.baseLayerPicker.viewModel;
    const wgs84 = vm.terrainProviderViewModels.find((t) =>
      String(t.name || "").toLowerCase().includes("wgs84"),
    );
    if (wgs84) vm.selectedTerrain = wgs84;
    if (mode === "production") window.CesiumDebug.globeFragmentDebug(null);
    else window.CesiumDebug.globeFragmentDebug(mode);
    v.camera.setView({
      destination: C.Cartesian3.fromDegrees(0, -89, 3_000_000),
    });
    for (let i = 0; i < 800; i++) {
      v.scene.render();
      await new Promise((r) => requestAnimationFrame(r));
      if (v.scene.globe.tilesLoaded && i > 200) break;
    }
    await new Promise((r) => setTimeout(r, 500));
  }, mode);

  const row = [mode.padEnd(22)];
  for (const [, x, y] of POINTS) {
    const png = await page.screenshot({ clip: { x, y, width: 2, height: 2 } });
    const px = decodeCenterPixel(png);
    row.push(px ? `${px[0].toString().padStart(3)},${px[1].toString().padStart(3)},${px[2].toString().padStart(3)},${px[3].toString().padStart(3)}` : "????");
  }
  console.log(row.join("  "));
}

console.log(
  "\n" + " ".repeat(22) + "  " +
  POINTS.map(([n]) => n.padEnd(15)).join("  "),
);

await browser.close();
