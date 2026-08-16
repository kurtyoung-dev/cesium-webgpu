// Override Scene FB clear color to bright magenta. Run, then readback FB.
// @purpose Diagnostic: forces the scene-FB clear to magenta to classify black-canvas causes (no-op draws vs black writes vs broken downstream blit).
// @status ACTIVE
//
// If FB stays magenta -> draws are no-ops (writeMask=0, depth fail, etc).
// If FB has black/dark patches -> draws write (0,0,0) to color.
// If FB has globe colors -> rendering actually works at GPU level, but
// downstream is broken.

import { chromium } from "playwright";

const URL =
  "http://localhost:8080/Apps/CesiumViewer/index.html?renderer=webgpu";

const browser = await chromium.launch({ headless: true, channel: "msedge" });
const ctx = await browser.newContext({
  viewport: { width: 1280, height: 720 },
});
const page = await ctx.newPage();

await page.addInitScript(() => {
  if (typeof window.GPUCommandEncoder !== "undefined") {
    const proto = window.GPUCommandEncoder.prototype;
    const orig = proto.beginRenderPass;
    proto.beginRenderPass = function (desc) {
      // Override Scene FB clear → magenta so we can see if writes happen.
      if (
        desc?.label === "Scene Framebuffer Render Pass" &&
        desc.colorAttachments?.[0]?.loadOp === "clear"
      ) {
        // Shallow clone — don't mutate caller's object.
        const newDesc = {
          ...desc,
          colorAttachments: desc.colorAttachments.map((a, i) =>
            i === 0
              ? {
                  ...a,
                  clearValue: { r: 1.0, g: 0.0, b: 1.0, a: 1.0 },
                }
              : a,
          ),
        };
        return orig.call(this, newDesc);
      }
      return orig.call(this, desc);
    };
  }
});

await page.goto(URL, { waitUntil: "networkidle" });
await page.waitForFunction(() => !!window.viewer, { timeout: 30_000 });
await page.evaluate(
  () =>
    new Promise((r) => {
      let n = 0;
      function tick() {
        if (n++ > 180) r();
        else requestAnimationFrame(tick);
      }
      tick();
    }),
);

const result = await page.evaluate(async () => {
  const v = window.viewer;
  const renderer = v.scene._alternateSceneRenderer;
  const sceneFB = renderer._sceneFramebuffer;
  const colorTarget = sceneFB.colorTarget;
  const tex = colorTarget.getColorTexture(0);
  const w = tex.width;
  const h = tex.height;
  const fmt = tex.format;
  const ctx = v.scene._context;
  const dev = ctx._device;

  const sampleSize = 64;
  const x0 = Math.floor((w - sampleSize) / 2);
  const y0 = Math.floor((h - sampleSize) / 2);
  const bpp = 4;
  const bytesPerRow = Math.ceil((sampleSize * bpp) / 256) * 256;
  const buf = dev.createBuffer({
    label: "ProbeMagentaReadback",
    size: bytesPerRow * sampleSize,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  });
  const enc = dev.createCommandEncoder({ label: "ProbeMagentaEnc" });
  enc.copyTextureToBuffer(
    { texture: tex, origin: { x: x0, y: y0, z: 0 } },
    { buffer: buf, bytesPerRow },
    { width: sampleSize, height: sampleSize, depthOrArrayLayers: 1 },
  );
  dev.queue.submit([enc.finish()]);

  await buf.mapAsync(GPUMapMode.READ);
  const range = new Uint8Array(buf.getMappedRange());
  // BGRA: range[off+0]=B, [off+1]=G, [off+2]=R, [off+3]=A
  const buckets = {
    magenta: 0, // (B>200, G<50, R>200) → BGRA(255,0,255,255)
    black: 0, // all rgb < 30
    other: 0,
  };
  const samplePixels = [];
  for (let py = 0; py < sampleSize; py++) {
    for (let px = 0; px < sampleSize; px++) {
      const off = py * bytesPerRow + px * 4;
      const B = range[off];
      const G = range[off + 1];
      const R = range[off + 2];
      const A = range[off + 3];
      const isMagenta = R > 200 && B > 200 && G < 50;
      const isBlack = R < 30 && G < 30 && B < 30;
      if (isMagenta) buckets.magenta++;
      else if (isBlack) buckets.black++;
      else buckets.other++;
      if (samplePixels.length < 10) samplePixels.push([B, G, R, A]);
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
  };
});

console.log("[probe-magenta-clear] result:");
console.log(JSON.stringify(result, null, 2));
console.log(
  "\nInterpretation:\n" +
    "  - magenta dominant → draws are NO-OPS (writeMask=0, depth fail, etc)\n" +
    "  - black dominant → draws write (0,0,0) to color\n" +
    "  - other dominant → globe colors visible; bug is downstream",
);

await browser.close();
