// Hook GPURenderBundleEncoder methods to track what's recorded in
// bundles. Specifically: the globe tile bundle.
// @purpose Hooks GPURenderBundleEncoder + pipeline creation to dump what draw state the globe tile render bundle records (targets, blend, depth).
// @status ACTIVE

import { chromium } from "playwright";

const URL =
  "http://localhost:8080/Apps/CesiumViewer/index.html?renderer=webgpu";

const browser = await chromium.launch({ headless: true, channel: "msedge" });
const ctx = await browser.newContext({
  viewport: { width: 1280, height: 720 },
});
const page = await ctx.newPage();

await page.addInitScript(() => {
  globalThis.__dbgBundles = [];
  globalThis.__dbgPipelineDescriptors = new WeakMap();

  if (typeof window.GPUDevice !== "undefined") {
    const dproto = window.GPUDevice.prototype;
    const wrap = (name) => {
      const o = dproto[name];
      if (typeof o === "function") {
        dproto[name] = function (desc) {
          const r = o.call(this, desc);
          const recordOn = (p) => {
            try {
              const targets = (desc?.fragment?.targets ?? []).map((t) => ({
                format: t?.format,
                writeMask: t?.writeMask,
                blend: t?.blend ? "yes" : "no",
              }));
              globalThis.__dbgPipelineDescriptors.set(p, {
                label: desc?.label ?? null,
                targets,
                depthCompare: desc?.depthStencil?.depthCompare,
                depthWriteEnabled: desc?.depthStencil?.depthWriteEnabled,
              });
            } catch (e) {}
          };
          if (r && typeof r.then === "function") {
            r.then(recordOn).catch(() => {});
          } else if (r) {
            recordOn(r);
          }
          return r;
        };
      }
    };
    wrap("createRenderPipeline");
    wrap("createRenderPipelineAsync");

    // Hook createRenderBundleEncoder
    const origBE = dproto.createRenderBundleEncoder;
    if (typeof origBE === "function") {
      dproto.createRenderBundleEncoder = function (desc) {
        const enc = origBE.call(this, desc);
        const info = {
          label: desc?.label ?? null,
          colorFormats: desc?.colorFormats,
          depthStencilFormat: desc?.depthStencilFormat,
          draws: [],
        };
        globalThis.__dbgBundles.push(info);
        const proto = enc.constructor.prototype;
        if (!proto.__dbgInstrumented) {
          const origSP = proto.setPipeline;
          if (typeof origSP === "function") {
            proto.setPipeline = function (p) {
              this.__dbgCurrentPipeline = p;
              return origSP.call(this, p);
            };
          }
          const wrapDraw = (n) => {
            const oo = proto[n];
            if (typeof oo === "function") {
              proto[n] = function (...args) {
                if (this.__dbgInfo) {
                  const desc =
                    globalThis.__dbgPipelineDescriptors.get(
                      this.__dbgCurrentPipeline,
                    ) ?? null;
                  this.__dbgInfo.draws.push({
                    method: n,
                    pipelineLabel: desc?.label ?? null,
                    targets: desc?.targets,
                    depthCompare: desc?.depthCompare,
                    depthWriteEnabled: desc?.depthWriteEnabled,
                  });
                }
                return oo.apply(this, args);
              };
            }
          };
          wrapDraw("draw");
          wrapDraw("drawIndexed");
          wrapDraw("drawIndirect");
          wrapDraw("drawIndexedIndirect");
          proto.__dbgInstrumented = true;
        }
        enc.__dbgInfo = info;
        return enc;
      };
    }
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
  const bundles = globalThis.__dbgBundles ?? [];
  return {
    totalBundles: bundles.length,
    sample: bundles.slice(-3).map((b) => ({
      label: b.label,
      colorFormats: b.colorFormats,
      depthStencilFormat: b.depthStencilFormat,
      drawCount: b.draws.length,
      uniqueDraws: b.draws.slice(0, 3),
    })),
  };
});

console.log("[probe-bundle-content] result:");
console.log(JSON.stringify(result, null, 2));

await browser.close();
