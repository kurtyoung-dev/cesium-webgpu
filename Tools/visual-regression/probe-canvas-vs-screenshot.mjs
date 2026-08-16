#!/usr/bin/env node
// Compare bytes read via getImageData vs bytes captured via page.screenshot
// on the SAME canvas state. If they differ, Playwright headless screenshot
// applies a transform that getImageData does not.
// @purpose Instrument self-check: compares getImageData bytes vs page.screenshot of the same canvas state to detect Playwright capture transforms
// @status INVESTIGATION

import { chromium } from "playwright";
import fs from "fs";
import zlib from "zlib";

const BASE = "http://localhost:8080";

function decodePngMean(buf) {
  let off = 8;
  let width = 0,
    height = 0,
    colorType = 0;
  const idatChunks = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    off += 4;
    const type = buf.subarray(off, off + 4).toString("ascii");
    off += 4;
    const data = buf.subarray(off, off + len);
    off += len + 4;
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      colorType = data[9];
    } else if (type === "IDAT") {
      idatChunks.push(data);
    } else if (type === "IEND") break;
  }
  const decompressed = zlib.inflateSync(Buffer.concat(idatChunks));
  const channels = colorType === 2 ? 3 : 4;
  const stride = 1 + width * channels;
  let mr = 0,
    mg = 0,
    mb = 0,
    count = 0;
  for (let y = 0; y < height; y++) {
    const rowStart = y * stride + 1;
    for (let x = 0; x < width; x++) {
      const off = rowStart + x * channels;
      if (off + 2 < decompressed.length) {
        mr += decompressed[off];
        mg += decompressed[off + 1];
        mb += decompressed[off + 2];
        count++;
      }
    }
  }
  return { meanR: mr / count, meanG: mg / count, meanB: mb / count };
}

async function run(renderer) {
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
  await page.goto(`${BASE}/Apps/CesiumViewer/index.html?renderer=${renderer}`, {
    waitUntil: "networkidle",
  });
  await page.waitForFunction(() => !!window.viewer);

  // Set camera + render
  await page.evaluate(async () => {
    const C = await import("/Build/CesiumUnminified/index.js");
    const v = window.viewer;
    v.camera.setView({
      destination: C.Cartesian3.fromDegrees(10, 50, 4_000_000),
    });
    for (let i = 0; i < 240; i++) {
      v.scene.render();
      await new Promise((r) => requestAnimationFrame(r));
    }
    await new Promise((r) => setTimeout(r, 1500));
    v.scene.render();
  });

  // Read via getImageData
  const getImageDataMean = await page.evaluate(() => {
    const v = window.viewer;
    const canvas = v.canvas;
    const ctx2d = document.createElement("canvas").getContext("2d");
    ctx2d.canvas.width = canvas.width;
    ctx2d.canvas.height = canvas.height;
    ctx2d.drawImage(canvas, 0, 0);
    const w = canvas.width;
    const h = canvas.height;
    const data = ctx2d.getImageData(0, 0, w, h).data;
    let mr = 0,
      mg = 0,
      mb = 0;
    const n = w * h;
    for (let i = 0; i < n; i++) {
      mr += data[i * 4];
      mg += data[i * 4 + 1];
      mb += data[i * 4 + 2];
    }
    return { meanR: mr / n, meanG: mg / n, meanB: mb / n };
  });

  // Read via page.screenshot
  const ssPath = `/tmp/${renderer}-canvas-vs-ss.png`;
  await page.screenshot({ path: ssPath, fullPage: false });
  const ssBytes = decodePngMean(fs.readFileSync(ssPath));

  await browser.close();
  return { getImageDataMean, ssBytes };
}

(async () => {
  for (const r of ["webgl", "webgpu"]) {
    console.log(`\n=== ${r.toUpperCase()} ===`);
    const { getImageDataMean, ssBytes } = await run(r);
    console.log(
      `  getImageData mean: (${getImageDataMean.meanR.toFixed(1)}, ${getImageDataMean.meanG.toFixed(1)}, ${getImageDataMean.meanB.toFixed(1)})`,
    );
    console.log(
      `  page.screenshot  : (${ssBytes.meanR.toFixed(1)}, ${ssBytes.meanG.toFixed(1)}, ${ssBytes.meanB.toFixed(1)})`,
    );
  }
})();
