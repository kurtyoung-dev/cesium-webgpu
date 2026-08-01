// Open a render pass on the scene FB texture and draw a fullscreen
// triangle. If the FB has the triangle's color afterward, the FB
// itself works. If still cleared/blank, the issue is with the scene FB.

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
        if (n++ > 60) r();
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
  const colorView = colorTarget.getColorTextureView(0);
  const fmt = tex.format;
  const ctx = v.scene._context;
  const dev = ctx._device;

  // Build a simple fullscreen-triangle pipeline that outputs (0,1,0,1) green.
  const wgsl = `
@vertex fn vertexMain(@builtin(vertex_index) vi: u32) -> @builtin(position) vec4f {
  let x = f32(i32(vi & 1u) * 4 - 1);
  let y = f32(i32(vi >> 1u) * 4 - 1);
  return vec4f(x, y, 0.0, 1.0);
}
@fragment fn fragmentMain() -> @location(0) vec4f {
  return vec4f(0.0, 1.0, 0.0, 1.0);
}
  `;
  const module = dev.createShaderModule({ code: wgsl, label: "ProbeFSGreen" });
  const pipeline = dev.createRenderPipeline({
    label: "ProbeFSGreenPipeline",
    layout: "auto",
    vertex: { module, entryPoint: "vertexMain" },
    fragment: {
      module,
      entryPoint: "fragmentMain",
      targets: [{ format: fmt }],
    },
    primitive: { topology: "triangle-list" },
    depthStencil: {
      format: "depth24plus-stencil8",
      depthCompare: "less-equal",
      depthWriteEnabled: false,
    },
  });

  // Open a render pass on the scene FB color view + DEPTH attachment.
  const depthView = colorTarget.depthStencilAttachment?.view;
  const enc = dev.createCommandEncoder({ label: "ProbeDirectDrawEnc" });
  const pass = enc.beginRenderPass({
    label: "ProbeDirectDraw-Pass",
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
  pass.setPipeline(pipeline);
  pass.draw(3);
  pass.end();

  // Now read back the FB.
  const w = tex.width;
  const h = tex.height;
  const bpp = 4;
  const sampleSize = 64;
  const x0 = Math.floor((w - sampleSize) / 2);
  const y0 = Math.floor((h - sampleSize) / 2);
  const bytesPerRow = Math.ceil((sampleSize * bpp) / 256) * 256;
  const buf = dev.createBuffer({
    label: "ProbeReadback",
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
  // BGRA: [B, G, R, A]
  const buckets = { green: 0, magenta: 0, other: 0 };
  for (let py = 0; py < sampleSize; py++) {
    for (let px = 0; px < sampleSize; px++) {
      const off = py * bytesPerRow + px * 4;
      const B = range[off];
      const G = range[off + 1];
      const R = range[off + 2];
      if (G > 200 && R < 50 && B < 50) buckets.green++;
      else if (R > 200 && G < 50 && B > 200) buckets.magenta++;
      else buckets.other++;
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
  };
});

console.log("[probe-direct-draw-fb] result:");
console.log(JSON.stringify(result, null, 2));

await browser.close();
