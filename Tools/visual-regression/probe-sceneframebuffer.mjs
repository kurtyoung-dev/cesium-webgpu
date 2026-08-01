// Diagnostic probe — read the WebGPU scene framebuffer's color
// texture directly via copyTextureToBuffer + mapAsync. This bypasses
// the canvas swap chain entirely. If the scene FBO has rendered
// content but the canvas is black, the bug is in the post-process
// blit. If the scene FBO is also empty, the bug is upstream.

import { chromium } from "playwright";

const URL =
  "http://localhost:8080/Apps/CesiumViewer/index.html?renderer=webgpu";

const browser = await chromium.launch({ headless: true, channel: "msedge" });
const ctx = await browser.newContext({
  viewport: { width: 1280, height: 720 },
});
const page = await ctx.newPage();

const errors = [];
page.on("console", (msg) => {
  if (msg.type() === "error" || msg.type() === "warning")
    errors.push(`[${msg.type()}] ${msg.text()}`);
});
page.on("pageerror", (e) => errors.push(`[pageerror] ${e.message}`));

console.log("[probe-fbo] navigating", URL);
await page.goto(URL, { waitUntil: "networkidle" });
await page.waitForFunction(() => !!window.viewer, { timeout: 30_000 });

// Render for ~3s
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
  if (!v) return { error: "no viewer" };

  const renderer = v.scene._alternateSceneRenderer;
  if (!renderer) return { error: "no _alternateSceneRenderer" };
  const sceneFB = renderer._sceneFramebuffer;
  if (!sceneFB) return { error: "no _sceneFramebuffer" };
  const colorTarget = sceneFB.colorTarget;
  if (!colorTarget) return { error: "no colorTarget" };

  // Get the underlying GPUTexture
  const tex = colorTarget.getColorTexture
    ? colorTarget.getColorTexture(0)
    : null;
  if (!tex) return { error: "colorTarget.getColorTexture(0) returned null" };

  const w = tex.width;
  const h = tex.height;
  const fmt = tex.format;
  const usage = tex.usage;

  // Format diagnostics — compare scene FBO format vs context's
  // declared scenePipelineFormat (what pipelines should target).
  const wgpuCtx = v.scene._context;
  const formatDiag = {
    sceneFBColorFormat: fmt,
    sceneFBcolorFormatField: sceneFB.colorFormat,
    contextScenePipelineFormat: wgpuCtx.scenePipelineFormat,
    contextSceneColorFormat: wgpuCtx._sceneColorFormat,
    contextPresentationFormat: wgpuCtx._presentationFormat,
    pipelineFormatGeneration: wgpuCtx._scenePipelineFormatGeneration,
    sceneFBHdr: sceneFB._hdr,
    sceneFBWidth: sceneFB._width,
    sceneFBHeight: sceneFB._height,
  };
  console.log("[FORMAT-DIAG] " + JSON.stringify(formatDiag));

  // Sample center pixel via copyTextureToBuffer.
  const ctx = v.scene._context;
  const dev = ctx._device || ctx.device;
  if (!dev) return { error: "no device" };

  // Need COPY_SRC usage. Check.
  const hasCopySrc = (usage & 1) !== 0; // GPUTextureUsage.COPY_SRC = 1
  if (!hasCopySrc) {
    return {
      error: "scene FBO color tex lacks COPY_SRC usage",
      width: w,
      height: h,
      format: fmt,
      usage,
    };
  }

  // Sample a 64x64 region in the center.
  const sampleSize = 64;
  const x0 = Math.floor((w - sampleSize) / 2);
  const y0 = Math.floor((h - sampleSize) / 2);
  // Bytes per pixel: 8 for rgba16float, 4 for bgra8unorm/rgba8unorm
  const bpp = fmt === "rgba16float" ? 8 : fmt === "rgba32float" ? 16 : 4;
  // bytesPerRow must be 256-aligned
  const bytesPerRow = Math.ceil((sampleSize * bpp) / 256) * 256;
  const buf = dev.createBuffer({
    label: "ProbeFBOReadback",
    size: bytesPerRow * sampleSize,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  });
  const enc = dev.createCommandEncoder({ label: "ProbeFBOReadbackEncoder" });
  enc.copyTextureToBuffer(
    { texture: tex, origin: { x: x0, y: y0, z: 0 } },
    { buffer: buf, bytesPerRow },
    { width: sampleSize, height: sampleSize, depthOrArrayLayers: 1 },
  );
  dev.queue.submit([enc.finish()]);

  await buf.mapAsync(GPUMapMode.READ);
  const range = new Uint8Array(buf.getMappedRange());
  // Sample first 5 pixels' RGB (interpret based on format).
  const samples = [];
  let nonZeroCount = 0;
  let totalChecked = 0;
  if (fmt === "rgba16float") {
    // f16 → just read raw u16 magnitudes; non-zero means content.
    const u16 = new Uint16Array(
      range.buffer,
      range.byteOffset,
      range.byteLength / 2,
    );
    for (let py = 0; py < sampleSize; py++) {
      for (let px = 0; px < sampleSize; px++) {
        const off = py * (bytesPerRow / 2) + px * 4;
        const r = u16[off],
          g = u16[off + 1],
          b = u16[off + 2];
        if (r || g || b) nonZeroCount++;
        totalChecked++;
        if (samples.length < 5) samples.push([r, g, b]);
      }
    }
  } else {
    for (let py = 0; py < sampleSize; py++) {
      for (let px = 0; px < sampleSize; px++) {
        const off = py * bytesPerRow + px * 4;
        const a = range[off],
          c = range[off + 1],
          d = range[off + 2];
        if (a || c || d) nonZeroCount++;
        totalChecked++;
        if (samples.length < 5) samples.push([a, c, d]);
      }
    }
  }
  buf.unmap();
  buf.destroy();
  // Dump per-pass command counts across all frustums.
  const view = v.scene._view;
  const fcl = view?.frustumCommandsList;
  const passCountSummary = [];
  const firstNonEmptyCmd = [];
  if (fcl && fcl.length > 0) {
    for (let f = 0; f < fcl.length; f++) {
      const fc = fcl[f];
      if (!fc) continue;
      const counts = [];
      for (let p = 0; p < fc.commands.length; p++) {
        const cnt = fc.indices[p] ?? 0;
        if (cnt > 0) counts.push({ passIdx: p, count: cnt });
      }
      passCountSummary.push({ frustumIdx: f, counts });
      // Capture FIRST non-empty command (any pass) for inspection.
      if (firstNonEmptyCmd.length < 3) {
        for (let p = 0; p < fc.commands.length; p++) {
          const cnt = fc.indices[p] ?? 0;
          if (cnt > 0) {
            const cmd = fc.commands[p][0];
            firstNonEmptyCmd.push({
              frustumIdx: f,
              passIdx: p,
              hasPipeline: !!cmd?.pipeline,
              pipelineType: cmd?.pipeline?.constructor?.name ?? null,
              bindGroupCount: cmd?.bindGroups?.length ?? 0,
              vertexBufferCount: cmd?.vertexBuffers?.length ?? 0,
              hasIndexBuffer: !!cmd?.indexBuffer,
              indexCount: cmd?.indexCount ?? null,
              vertexCount: cmd?.vertexCount ?? null,
              hasExecute: typeof cmd?.execute === "function",
              ownerName: cmd?.owner?.constructor?.name ?? null,
              isWebGPUDrawCommand: !!cmd?.isWebGPUDrawCommand,
              cmdKeys: cmd
                ? Object.keys(cmd)
                    .filter((k) => !k.startsWith("_"))
                    .slice(0, 20)
                : [],
            });
            break;
          }
        }
      }
    }
  }

  return {
    width: w,
    height: h,
    format: fmt,
    usage,
    sampleSize,
    sampledPixels: totalChecked,
    nonZeroPixels: nonZeroCount,
    firstFiveSamples: samples,
    formatDiag,
    passCountSummary,
    firstNonEmptyCmd,
  };
});

console.log("\n[probe-fbo] scene framebuffer color readback:");
console.log(JSON.stringify(result, null, 2));

if (errors.length > 0) {
  console.log("\n[probe-fbo] errors / warnings (first 10):");
  for (const e of errors.slice(0, 10)) console.log("  " + e);
}

await browser.close();
