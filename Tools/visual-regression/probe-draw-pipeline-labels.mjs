// Hook setPipeline + draw to record what pipelines actually draw
// during Scene FB pass.

import { chromium } from "playwright";

const URL =
  "http://localhost:8080/Apps/CesiumViewer/index.html?renderer=webgpu";

const browser = await chromium.launch({ headless: true, channel: "msedge" });
const ctx = await browser.newContext({
  viewport: { width: 1280, height: 720 },
});
const page = await ctx.newPage();

await page.addInitScript(() => {
  globalThis.__dbgDrawsByPass = [];
  globalThis.__dbgPipelineDescriptors = new WeakMap();

  // Wrap createRenderPipeline + createRenderPipelineAsync to capture
  // the descriptor (target writeMask, depth-stencil, etc.) per pipeline.
  if (typeof window.GPUDevice !== "undefined") {
    const proto = window.GPUDevice.prototype;
    const wrapCreate = (name) => {
      const orig = proto[name];
      if (typeof orig === "function") {
        proto[name] = function (desc) {
          const result = orig.call(this, desc);
          // For sync, result is a pipeline. For async, it's a Promise.
          const recordOn = (p) => {
            try {
              const targets = (desc?.fragment?.targets ?? []).map((t) => ({
                format: t?.format,
                writeMask:
                  t?.writeMask !== undefined ? t.writeMask : "(undefined)",
                blend: t?.blend ? "yes" : "no",
              }));
              const ds = desc?.depthStencil;
              globalThis.__dbgPipelineDescriptors.set(p, {
                label: desc?.label ?? null,
                targets,
                depthCompare: ds?.depthCompare,
                depthWriteEnabled: ds?.depthWriteEnabled,
                depthFormat: ds?.format,
                cullMode: desc?.primitive?.cullMode,
              });
            } catch (e) {}
          };
          if (result && typeof result.then === "function") {
            result.then(recordOn).catch(() => {});
          } else if (result) {
            recordOn(result);
          }
          return result;
        };
      }
    };
    wrapCreate("createRenderPipeline");
    wrapCreate("createRenderPipelineAsync");
  }

  if (typeof window.GPUCommandEncoder !== "undefined") {
    const proto = window.GPUCommandEncoder.prototype;
    const orig = proto.beginRenderPass;
    proto.beginRenderPass = function (desc) {
      const pass = orig.call(this, desc);
      const passInfo = {
        label: desc?.label ?? null,
        loadOp: desc?.colorAttachments?.[0]?.loadOp ?? null,
        depthLoadOp: desc?.depthStencilAttachment?.depthLoadOp ?? null,
        depthClearValue: desc?.depthStencilAttachment?.depthClearValue ?? null,
        draws: [],
      };
      globalThis.__dbgDrawsByPass.push(passInfo);

      const passProto = pass.constructor.prototype;
      if (!passProto.__dbgInstrumented) {
        const origSetPipeline = passProto.setPipeline;
        passProto.setPipeline = function (p) {
          this.__dbgCurrentPipeline = p;
          return origSetPipeline.call(this, p);
        };
        const origSetVp = passProto.setViewport;
        if (typeof origSetVp === "function") {
          passProto.setViewport = function (x, y, w, h, mn, mx) {
            if (this.__dbgInfo) {
              this.__dbgInfo.lastViewport = [x, y, w, h, mn, mx];
            }
            return origSetVp.call(this, x, y, w, h, mn, mx);
          };
        }
        const origSetSc = passProto.setScissorRect;
        if (typeof origSetSc === "function") {
          passProto.setScissorRect = function (x, y, w, h) {
            if (this.__dbgInfo) {
              this.__dbgInfo.lastScissor = [x, y, w, h];
            }
            return origSetSc.call(this, x, y, w, h);
          };
        }
        const wrapDraw = (name) => {
          const o = passProto[name];
          if (typeof o === "function") {
            passProto[name] = function (...args) {
              if (this.__dbgInfo) {
                const desc =
                  globalThis.__dbgPipelineDescriptors.get(
                    this.__dbgCurrentPipeline,
                  ) ?? null;
                this.__dbgInfo.draws.push({
                  method: name,
                  pipeline: desc,
                });
              }
              return o.apply(this, args);
            };
          }
        };
        wrapDraw("draw");
        wrapDraw("drawIndexed");
        wrapDraw("drawIndirect");
        wrapDraw("drawIndexedIndirect");
        // Wrap executeBundles too — globe tiles may use render bundles
        const origEB = passProto.executeBundles;
        if (typeof origEB === "function") {
          passProto.executeBundles = function (bundles, ...rest) {
            if (this.__dbgInfo) {
              this.__dbgInfo.draws.push({
                method: "executeBundles",
                bundleCount: bundles?.length ?? 0,
                pipeline: null,
              });
            }
            return origEB.call(this, bundles, ...rest);
          };
        }
        passProto.__dbgInstrumented = true;
      }
      pass.__dbgInfo = passInfo;
      return pass;
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
        if (n++ > 240) r();
        else requestAnimationFrame(tick);
      }
      tick();
    }),
);

const result = await page.evaluate(() => {
  const passes = globalThis.__dbgDrawsByPass ?? [];
  // Find Scene FB passes WITH draws (5 typical)
  const sceneFBwithDraws = passes.filter(
    (p) => p.label === "Scene Framebuffer Render Pass" && p.draws.length > 0,
  );
  // Sample a stable mid-test pass:
  // Sample late passes when tiles have loaded
  const sample = sceneFBwithDraws.slice(-3);
  return sample.map((p) => ({
    label: p.label,
    loadOp: p.loadOp,
    depthLoadOp: p.depthLoadOp,
    depthClearValue: p.depthClearValue,
    lastViewport: p.lastViewport,
    lastScissor: p.lastScissor,
    drawCount: p.draws.length,
    draws: p.draws.map((d) => ({
      method: d.method,
      pipelineLabel: d.pipeline?.label ?? "(no descriptor)",
      targets: d.pipeline?.targets,
      depthCompare: d.pipeline?.depthCompare,
      depthWriteEnabled: d.pipeline?.depthWriteEnabled,
      depthFormat: d.pipeline?.depthFormat,
      cullMode: d.pipeline?.cullMode,
    })),
  }));
});

console.log(
  "[probe-draw-pipeline-labels] mid-test scene FB passes with draws:",
);
console.log(JSON.stringify(result, null, 2));

await browser.close();
