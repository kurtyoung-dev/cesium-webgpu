#!/usr/bin/env node
/**
 * Canvas-black readback probe. Reads back the sceneFramebuffer color
 * texture pixels via copyTextureToBuffer + mapAsync. Tells us whether
 * the GLOBE pass actually wrote ANY color to scene FB, regardless of
 * what the post-process chain does to it later.
 */
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
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error" || m.type() === "warning")
      errors.push(`[${m.type()}] ${m.text()}`);
  });

  const url = `${BASE}/Apps/CesiumViewer/index.html?renderer=webgpu`;
  await page.goto(url, { waitUntil: "networkidle", timeout: 90_000 });
  await page.waitForFunction(() => !!window.viewer, { timeout: 90_000, polling: 500 });

  const result = await page.evaluate(async () => {
    const C = await import("/Build/CesiumUnminified/index.js");
    const v = window.viewer;
    v.camera.setView({
      destination: C.Cartesian3.fromDegrees(-75.5, 40.0, 5_000_000),
    });

    // Render 90 frames to let imagery + tiles load
    for (let i = 0; i < 90; i++) {
      v.scene.render();
      await new Promise((r) => requestAnimationFrame(r));
    }

    const ctx = v.scene.context;
    const device = ctx._device;

    // Find the scene framebuffer color texture via the alternate scene renderer
    const sr = v.scene._alternateSceneRenderer;
    const sfb = sr?._sceneFramebuffer;
    if (!sfb) return { error: "no sceneFramebuffer on alternate scene renderer", srKeys: Object.keys(sr || {}) };
    const colorTexture = sfb.colorTexture;
    if (!colorTexture) return { error: "no colorTexture", sfbKeys: Object.keys(sfb) };

    const W = colorTexture.width;
    const H = colorTexture.height;
    const bytesPerPixel = 4;
    const bytesPerRow = Math.ceil((W * bytesPerPixel) / 256) * 256;
    const bufferSize = bytesPerRow * H;

    const readbackBuffer = device.createBuffer({
      label: "readback",
      size: bufferSize,
      usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
    });

    // Render one more frame, but do an extra copyTextureToBuffer right
    // after the post-process completes. Do this synchronously by
    // rendering, then queueing the copy on the device's queue using
    // a fresh encoder.
    v.scene.render();
    await new Promise((r) => requestAnimationFrame(r));

    const encoder = device.createCommandEncoder({ label: "readback encoder" });
    encoder.copyTextureToBuffer(
      { texture: colorTexture },
      { buffer: readbackBuffer, bytesPerRow, rowsPerImage: H },
      { width: W, height: H, depthOrArrayLayers: 1 },
    );
    device.queue.submit([encoder.finish()]);

    await readbackBuffer.mapAsync(GPUMapMode.READ);
    const data = new Uint8Array(readbackBuffer.getMappedRange()).slice();
    readbackBuffer.unmap();
    readbackBuffer.destroy();

    // Sample 100 pixels evenly distributed
    const samples = [];
    let nonBlack = 0;
    let sum = [0, 0, 0, 0];
    for (let i = 0; i < 100; i++) {
      const tx = Math.floor((i % 10) * W / 10) + Math.floor(W / 20);
      const ty = Math.floor(Math.floor(i / 10) * H / 10) + Math.floor(H / 20);
      const off = ty * bytesPerRow + tx * 4;
      const px = [data[off], data[off + 1], data[off + 2], data[off + 3]];
      sum[0] += px[0]; sum[1] += px[1]; sum[2] += px[2]; sum[3] += px[3];
      if (px[0] + px[1] + px[2] > 5) nonBlack++;
      if (i < 5) samples.push(`(${tx},${ty})=${px.join(",")}`);
    }
    return {
      colorFormat: sfb.colorFormat,
      W, H,
      avg: sum.map((v) => Math.round(v / 100)),
      nonBlack,
      samples,
    };
  });

  await browser.close();
  console.log("Result:", JSON.stringify(result, null, 2));
  if (errors.length) {
    console.log("\nFirst errors/warnings:");
    for (const e of errors.slice(0, 10)) console.log("  " + e.slice(0, 250));
  }
})();
