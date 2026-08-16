#!/usr/bin/env node
/**
 * Canvas-black readback probe. Reads back the sceneFramebuffer color
 * texture pixels via copyTextureToBuffer + mapAsync. Tells us whether
 * the GLOBE pass actually wrote ANY color to scene FB, regardless of
 * what the post-process chain does to it later.
 * @purpose Reads back the sceneFramebuffer color texture via copyTextureToBuffer/mapAsync to prove whether the globe pass wrote any color, ignoring the PP chain.
 * @status INVESTIGATION
 *
 */
import { chromium } from "playwright";

const BASE = process.env.PROBE_BASE || "http://localhost:8080";

(async () => {
  const browser = await chromium.launch({
    channel: "msedge",
    headless: true,
    args: ["--enable-unsafe-webgpu", "--disable-cache"],
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
  await page.waitForFunction(() => !!window.viewer, {
    timeout: 90_000,
    polling: 500,
  });

  const result = await page.evaluate(async () => {
    const C = await import("/Build/CesiumUnminified/index.js");
    const v = window.viewer;
    // Default ion World Imagery now loads (valid default token), so this
    // exercises the real default-viewer render path. Frame the globe disk.
    v.camera.setView({
      destination: C.Cartesian3.fromDegrees(-75.5, 40.0, 3_000_000),
    });

    // Render until imagery tiles settle (or a frame cap).
    for (let i = 0; i < 400; i++) {
      v.scene.render();
      await new Promise((r) => requestAnimationFrame(r));
      if (v.scene.globe.tilesLoaded && i > 60) break;
    }

    const ctx = v.scene.context;
    const device = ctx._device;

    // Find the scene framebuffer color texture via the alternate scene renderer
    const sr = v.scene._alternateSceneRenderer;
    const sfb = sr?._sceneFramebuffer;
    if (!sfb)
      return {
        error: "no sceneFramebuffer on alternate scene renderer",
        srKeys: Object.keys(sr || {}),
      };
    const colorTexture = sfb.colorTexture;
    if (!colorTexture)
      return { error: "no colorTexture", sfbKeys: Object.keys(sfb) };

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
    const sum = [0, 0, 0, 0];
    for (let i = 0; i < 100; i++) {
      const tx = Math.floor(((i % 10) * W) / 10) + Math.floor(W / 20);
      const ty = Math.floor((Math.floor(i / 10) * H) / 10) + Math.floor(H / 20);
      const off = ty * bytesPerRow + tx * 4;
      const px = [data[off], data[off + 1], data[off + 2], data[off + 3]];
      sum[0] += px[0];
      sum[1] += px[1];
      sum[2] += px[2];
      sum[3] += px[3];
      if (px[0] + px[1] + px[2] > 5) nonBlack++;
      if (i < 5) samples.push(`(${tx},${ty})=${px.join(",")}`);
    }
    return {
      colorFormat: sfb.colorFormat,
      W,
      H,
      avg: sum.map((v) => Math.round(v / 100)),
      nonBlack,
      samples,
    };
  });

  // Canvas screenshot — the user-facing symptom of BUG-WEBGPU-CANVAS-BLACK
  // is the CANVAS rendering black, not the scene FB. Capture + sample center
  // pixels (away from the UI overlays) so we test the post-process blit to
  // the swap chain, which is what the bug broke.
  const png = await page.screenshot({ type: "png" });
  const fs = await import("fs");
  fs.mkdirSync("Tools/visual-regression/output", { recursive: true });
  fs.writeFileSync(
    "Tools/visual-regression/output/canvas-black-reverify.png",
    png,
  );
  const canvasSample = await page.evaluate(
    async (durl) => {
      return await new Promise((resolve) => {
        const img = new Image();
        img.onload = () => {
          const c = document.createElement("canvas");
          c.width = img.width;
          c.height = img.height;
          const cx = c.getContext("2d");
          cx.drawImage(img, 0, 0);
          const d = cx.getImageData(0, 0, c.width, c.height).data;
          // Sample a centered region (avoid the right-side help panel + bottom
          // timeline). 30%-70% horizontally, 20%-60% vertically.
          let nonBlack = 0;
          let total = 0;
          for (
            let y = (img.height * 0.2) | 0;
            (y < img.height * 0.6) | 0;
            y += 7
          ) {
            for (
              let x = (img.width * 0.3) | 0;
              (x < img.width * 0.7) | 0;
              x += 7
            ) {
              const i = (y * img.width + x) * 4;
              total++;
              if (d[i] + d[i + 1] + d[i + 2] > 12) nonBlack++;
            }
          }
          resolve({
            total,
            nonBlack,
            fraction: +(nonBlack / total).toFixed(3),
          });
        };
        img.src = durl;
      });
    },
    `data:image/png;base64,${png.toString("base64")}`,
  );

  await browser.close();
  console.log("Result:", JSON.stringify(result, null, 2));
  console.log("Canvas sample:", JSON.stringify(canvasSample));
  if (errors.length) {
    console.log("\nFirst errors/warnings:");
    for (const e of errors.slice(0, 10)) console.log("  " + e.slice(0, 250));
  }
})();
