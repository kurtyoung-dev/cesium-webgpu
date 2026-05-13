import { chromium } from "playwright";

const URL = "http://localhost:8080/Apps/WebGPUTest/split-screen-comparison.html";
const browser = await chromium.launch({ headless: true, channel: "msedge" });
const ctx = await browser.newContext({ viewport: { width: 1600, height: 800 } });
const page = await ctx.newPage();
const messages = [];
page.on("console", (m) => {
  if (m.type() === "error" || m.type() === "warning") {
    messages.push(`[${m.type()}] ${m.text()}`);
  }
});
page.setDefaultTimeout(120000);
await page.goto(URL, { waitUntil: "networkidle" });
// Click the launch button to start viewer creation
await page.waitForSelector("#btnLaunch", { timeout: 10000 });
await page.click("#btnLaunch");
await page.waitForFunction(() => !!window.webglViewer && !!window.webgpuViewer);
console.log("both viewers ready");

// Run for 6 seconds
await page.evaluate(async () => {
  for (let batch = 0; batch < 12; batch++) {
    await new Promise((r) => { let n = 0; (function tick(){ if (n++ > 20) r(); else requestAnimationFrame(tick); })(); });
    await new Promise((r) => setTimeout(r, 100));
  }
});

const stats = await page.evaluate(async () => {
  const wgpu = window.webgpuViewer;
  const fs = wgpu.scene._frameState;
  const surface = wgpu.scene.globe?._surface;
  const renderer = wgpu.scene._alternateSceneRenderer;
  const sceneFB = renderer?._sceneFramebuffer;
  const colorTarget = sceneFB?.colorTarget;
  const tex = colorTarget?.getColorTexture?.(0);
  // Sample scene FB content
  let fbStats = null;
  if (tex && wgpu.scene._context._device) {
    const dev = wgpu.scene._context._device;
    const w = tex.width, h = tex.height;
    const ss = 64;
    const x0 = Math.floor((w - ss) / 2), y0 = Math.floor((h - ss) / 2);
    const bpr = Math.ceil((ss * 4) / 256) * 256;
    const buf = dev.createBuffer({
      size: bpr * ss,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
    const enc = dev.createCommandEncoder();
    enc.copyTextureToBuffer(
      { texture: tex, origin: { x: x0, y: y0, z: 0 } },
      { buffer: buf, bytesPerRow: bpr },
      { width: ss, height: ss, depthOrArrayLayers: 1 },
    );
    dev.queue.submit([enc.finish()]);
    await buf.mapAsync(GPUMapMode.READ);
    const range = new Uint8Array(buf.getMappedRange());
    let nz = 0;
    for (let py = 0; py < ss; py++) {
      for (let px = 0; px < ss; px++) {
        const off = py * bpr + px * 4;
        if (range[off] | range[off + 1] | range[off + 2]) nz++;
      }
    }
    fbStats = { width: w, height: h, format: tex.format, nonZeroPixels: nz, totalSampled: ss * ss };
    buf.unmap();
    buf.destroy();
  }
  // Sample CANVAS via toDataURL → check if it's actually grey
  const canvas = wgpu.scene.canvas;
  const dataUrl = canvas.toDataURL();
  const isJustHeader = dataUrl.length < 100;
  return {
    requestRenderMode: wgpu.scene.requestRenderMode,
    cmdListLength: fs.commandList.length,
    cmdListPasses: fs.commandList.map((c) => c.pass),
    tilesToRender: surface?._tilesToRender?.length,
    rendererType: wgpu.scene.context.rendererType,
    fbStats,
    canvasWidth: canvas.width,
    canvasHeight: canvas.height,
    canvasDataUrlLength: dataUrl.length,
    canvasDataUrlPrefix: dataUrl.substring(0, 60),
  };
});
console.log("WebGPU viewer stats:", JSON.stringify(stats, null, 2));
console.log("Errors/warnings (first 15):");
for (const m of messages.slice(0, 15)) console.log(m);

await page.screenshot({
  path: "F:/Dev/GH/cesium-webgpu/Tools/visual-regression/output/diag-fixed-split-screen.png",
});
await browser.close();
