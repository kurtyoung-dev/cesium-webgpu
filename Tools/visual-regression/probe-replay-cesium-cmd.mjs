// Replay Cesium's SkyAtmosphere command in our own controlled pass.
// @purpose Bring-up diagnostic: replayed the SkyAtmosphere draw command in a controlled pass to split frame-loop faults from bad pipeline/buffers
// @status INVESTIGATION
//
// If output appears -> Cesium's frame loop has a problem.
// If output doesn't appear -> the pipeline/bindgroup/buffers themselves
// are bad.

import { chromium } from "playwright";

const URL =
  "http://localhost:8080/Apps/CesiumViewer/index.html?renderer=webgpu";

const browser = await chromium.launch({ headless: true, channel: "msedge" });
const ctx = await browser.newContext({
  viewport: { width: 1280, height: 720 },
});
const page = await ctx.newPage();

await page.goto(URL, { waitUntil: "networkidle" });
await page.waitForFunction(() => !!window.viewer, { timeout: 30_000 });
await page.evaluate(
  () =>
    new Promise((r) => {
      let n = 0;
      function tick() {
        if (n++ > 90) r();
        else requestAnimationFrame(tick);
      }
      tick();
    }),
);

const result = await page.evaluate(async () => {
  const v = window.viewer;
  const sceneFB = v.scene._alternateSceneRenderer._sceneFramebuffer;
  const colorTarget = sceneFB.colorTarget;
  const tex = colorTarget.getColorTexture(0);
  const colorView = colorTarget.getColorTextureView(0);
  const depthView = colorTarget.depthStencilAttachment?.view;
  const fmt = tex.format;
  const dev = v.scene._context._device;

  // Find the SkyAtmosphere command. It's a WebGPUDrawCommand with
  // owner.constructor.name === "SkyAtmosphere".
  const skyAtmo = v.scene.skyAtmosphere;
  const skyCache = skyAtmo?._webgpuCache;
  const skyCmd = skyCache?.command;
  if (!skyCmd) {
    return { error: "no SkyAtmosphere command found" };
  }

  const enc = dev.createCommandEncoder({ label: "ProbeReplayEnc" });
  const pass = enc.beginRenderPass({
    label: "ProbeReplay-Pass",
    colorAttachments: [
      {
        view: colorView,
        loadOp: "clear",
        storeOp: "store",
        clearValue: { r: 1, g: 0, b: 1, a: 1 }, // magenta
      },
    ],
    depthStencilAttachment: depthView
      ? {
          view: depthView,
          depthClearValue: 1.0,
          depthLoadOp: "clear",
          depthStoreOp: "store",
          stencilClearValue: 0,
          stencilLoadOp: "clear",
          stencilStoreOp: "store",
        }
      : undefined,
  });
  pass.setViewport(0, 0, tex.width, tex.height, 0, 1);
  pass.setScissorRect(0, 0, tex.width, tex.height);

  // Replay SkyAtmosphere using the command's own execute path
  try {
    skyCmd.execute(pass);
  } catch (e) {
    return { error: "skyCmd.execute threw: " + String(e) };
  }

  pass.end();

  // Read FB
  const w = tex.width;
  const h = tex.height;
  const sampleSize = 64;
  const x0 = Math.floor((w - sampleSize) / 2);
  const y0 = Math.floor((h - sampleSize) / 2);
  const bytesPerRow = Math.ceil((sampleSize * 4) / 256) * 256;
  const buf = dev.createBuffer({
    label: "ProbeReplayReadback",
    size: bytesPerRow * sampleSize,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  });
  enc.copyTextureToBuffer(
    { texture: tex, origin: { x: x0, y: y0, z: 0 } },
    { buffer: buf, bytesPerRow },
    { width: sampleSize, height: sampleSize, depthOrArrayLayers: 1 },
  );
  dev.queue.submit([enc.finish()]);

  await buf.mapAsync(GPUMapMode.READ);
  const range = new Uint8Array(buf.getMappedRange());
  // BGRA
  const buckets = { magenta: 0, other: 0 };
  const samplePixels = [];
  for (let py = 0; py < sampleSize; py++) {
    for (let px = 0; px < sampleSize; px++) {
      const off = py * bytesPerRow + px * 4;
      const B = range[off];
      const G = range[off + 1];
      const R = range[off + 2];
      const A = range[off + 3];
      if (R > 200 && G < 50 && B > 200) buckets.magenta++;
      else buckets.other++;
      if (samplePixels.length < 8) samplePixels.push([B, G, R, A]);
    }
  }
  buf.unmap();
  buf.destroy();

  return {
    width: w,
    height: h,
    format: fmt,
    sampledPixels: sampleSize * sampleSize,
    buckets,
    samplePixels,
    skyCmdInfo: {
      hasPipeline: !!skyCmd.pipeline,
      bindGroupCount: skyCmd.bindGroups?.length ?? 0,
      vertexBufferCount: skyCmd.vertexBuffers?.length ?? 0,
      hasIndexBuffer: !!skyCmd.indexBuffer,
      indexCount: skyCmd.indexCount,
      enabled: skyCmd.enabled,
    },
  };
});

console.log("[probe-replay-cesium-cmd] result:");
console.log(JSON.stringify(result, null, 2));

await browser.close();
