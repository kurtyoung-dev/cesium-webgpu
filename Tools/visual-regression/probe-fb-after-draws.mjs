// Hook GPURenderPassEncoder.end() to: when ending a "Scene Framebuffer
// Render Pass" pass with draws > 0, IMMEDIATELY queue a copyTextureToBuffer
// of the colorAttachments[0].view's owning texture into a readback
// buffer. We then map the buffer at the end of the test and report
// the FIRST non-zero pixel found across all snapshots.
//
// Goal: prove or disprove that the 5 draws per "Scene FB load" pass
// produce visible color writes on the GPU side. If snapshots are
// all-zero, draws are no-ops at the GPU level (writeMask=0, depth fail,
// shader discard, format mismatch). If snapshots show content, the
// content is being trashed downstream by post-process or canvas blit.

import { chromium } from "playwright";

const URL = "http://localhost:8080/Apps/CesiumViewer/index.html?renderer=webgpu";

const browser = await chromium.launch({ headless: true, channel: "msedge" });
const ctx = await browser.newContext({
  viewport: { width: 1280, height: 720 },
});
const page = await ctx.newPage();

await page.addInitScript(() => {
  globalThis.__dbgSceneFBSnapshots = [];
  globalThis.__dbgViewToTexture = new WeakMap();
  globalThis.__dbgViewToTag = new WeakMap();
  globalThis.__dbgNextViewTag = 1;

  // Wrap createView so we can map view → texture.
  if (typeof window.GPUTexture !== "undefined") {
    const origCreateView = window.GPUTexture.prototype.createView;
    window.GPUTexture.prototype.createView = function (...args) {
      const view = origCreateView.apply(this, args);
      try {
        globalThis.__dbgViewToTexture.set(view, this);
      } catch (e) {}
      return view;
    };
  }

  if (typeof window.GPUCommandEncoder !== "undefined") {
    const ceProto = window.GPUCommandEncoder.prototype;
    const origBegin = ceProto.beginRenderPass;
    ceProto.beginRenderPass = function (desc) {
      const pass = origBegin.call(this, desc);
      const tagView = (v) => {
        if (!v) return null;
        let t = globalThis.__dbgViewToTag.get(v);
        if (!t) {
          t = globalThis.__dbgNextViewTag++;
          globalThis.__dbgViewToTag.set(v, t);
        }
        return t;
      };
      const colorView = desc?.colorAttachments?.[0]?.view ?? null;
      const info = {
        label: desc?.label ?? null,
        loadOp: desc?.colorAttachments?.[0]?.loadOp ?? null,
        view: colorView,
        viewTag: tagView(colorView),
        encoder: this,
        drawsInPass: 0,
      };
      // Wrap draw counter
      const passProto = pass.constructor.prototype;
      if (!passProto.__dbgInstrumented) {
        const wrapDraw = (name) => {
          const orig = passProto[name];
          if (typeof orig === "function") {
            passProto[name] = function (...args) {
              if (this.__dbgInfo) this.__dbgInfo.drawsInPass++;
              return orig.apply(this, args);
            };
          }
        };
        wrapDraw("draw");
        wrapDraw("drawIndexed");
        wrapDraw("drawIndirect");
        wrapDraw("drawIndexedIndirect");
        wrapDraw("executeBundles");
        // Wrap end so we can schedule readback when Scene FB pass with
        // draws ends.
        const origEnd = passProto.end;
        passProto.end = function (...args) {
          const info = this.__dbgInfo;
          const result = origEnd.apply(this, args);
          if (
            info &&
            info.label === "Scene Framebuffer Render Pass" &&
            info.drawsInPass > 0 &&
            globalThis.__dbgSceneFBSnapshots.length < 8
          ) {
            const tex = globalThis.__dbgViewToTexture.get(info.view);
            if (tex) {
              const w = tex.width;
              const h = tex.height;
              const fmt = tex.format;
              const bpp =
                fmt === "rgba16float"
                  ? 8
                  : fmt === "rgba32float"
                    ? 16
                    : 4;
              const sampleW = Math.min(64, w);
              const sampleH = Math.min(64, h);
              const x0 = Math.floor((w - sampleW) / 2);
              const y0 = Math.floor((h - sampleH) / 2);
              const bytesPerRow = Math.ceil((sampleW * bpp) / 256) * 256;
              const dev = info.encoder._device || globalThis.__dbgDevice;
              if (dev) {
                try {
                  const buf = dev.createBuffer({
                    label: "ProbeAfterDrawReadback",
                    size: bytesPerRow * sampleH,
                    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
                  });
                  // Use the SAME encoder that just ended the pass.
                  info.encoder.copyTextureToBuffer(
                    { texture: tex, origin: { x: x0, y: y0, z: 0 } },
                    { buffer: buf, bytesPerRow },
                    {
                      width: sampleW,
                      height: sampleH,
                      depthOrArrayLayers: 1,
                    },
                  );
                  globalThis.__dbgSceneFBSnapshots.push({
                    viewTag: info.viewTag,
                    drawsInPass: info.drawsInPass,
                    width: sampleW,
                    height: sampleH,
                    format: fmt,
                    bytesPerRow,
                    buf,
                  });
                } catch (e) {
                  // copy after pass may fail validation; record the error
                  globalThis.__dbgSceneFBSnapshots.push({
                    error: String(e),
                    viewTag: info.viewTag,
                    drawsInPass: info.drawsInPass,
                  });
                }
              }
            }
          }
          return result;
        };
        passProto.__dbgInstrumented = true;
      }
      pass.__dbgInfo = info;
      return pass;
    };
  }

  // Capture the GPUDevice so we can use it for readback buffers.
  if (typeof navigator !== "undefined" && navigator.gpu) {
    const origReq = navigator.gpu.requestAdapter;
    navigator.gpu.requestAdapter = async function (...args) {
      const a = await origReq.apply(this, args);
      if (a) {
        const origRD = a.requestDevice;
        a.requestDevice = async function (...rargs) {
          const d = await origRD.apply(this, rargs);
          globalThis.__dbgDevice = d;
          return d;
        };
      }
      return a;
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
  const snaps = globalThis.__dbgSceneFBSnapshots ?? [];
  const out = [];
  for (const s of snaps) {
    if (s.error) {
      out.push({ error: s.error, drawsInPass: s.drawsInPass });
      continue;
    }
    try {
      await s.buf.mapAsync(GPUMapMode.READ);
      const range = new Uint8Array(s.buf.getMappedRange());
      let nonZero = 0;
      const samples = [];
      for (let py = 0; py < s.height; py++) {
        for (let px = 0; px < s.width; px++) {
          const off = py * s.bytesPerRow + px * 4;
          const a = range[off],
            b = range[off + 1],
            c = range[off + 2];
          if (a || b || c) nonZero++;
          if (samples.length < 5) samples.push([a, b, c]);
        }
      }
      out.push({
        viewTag: s.viewTag,
        drawsInPass: s.drawsInPass,
        nonZero,
        totalSampled: s.width * s.height,
        samples,
        format: s.format,
      });
      s.buf.unmap();
      s.buf.destroy();
    } catch (e) {
      out.push({ error: String(e), drawsInPass: s.drawsInPass });
    }
  }
  return out;
});

console.log("[probe-fb-after-draws] snapshots after Scene FB passes with draws:");
console.log(JSON.stringify(result, null, 2));

await browser.close();
