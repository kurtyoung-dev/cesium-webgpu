// @purpose One-shot dump of presentation/preferred/scene color formats and the HDR-canvas flag from a live WebGPU viewer.
// @status INVESTIGATION

import { chromium } from "playwright";

const browser = await chromium.launch({
  channel: "msedge",
  headless: true,
  args: ["--enable-unsafe-webgpu", "--enable-features=Vulkan"],
});
const page = await browser.newPage();
await page.goto(
  "http://localhost:8080/Apps/CesiumViewer/index.html?renderer=webgpu",
  {
    waitUntil: "networkidle",
    timeout: 60000,
  },
);
await page.waitForFunction(() => !!window.viewer, { timeout: 60000 });
await page.waitForTimeout(3000);

const result = await page.evaluate(async () => {
  const v = window.viewer;
  const ctx = v.scene.context;
  const _sceneFB = ctx._sceneFramebuffer;
  return {
    presentationFormat: ctx._presentationFormat,
    preferredFormat: navigator.gpu.getPreferredCanvasFormat(),
    sceneColorFormat: ctx._sceneColorFormat,
    rendererType: ctx.rendererType,
    hdrCanvas: ctx._hdrCanvasOutput,
  };
});
await browser.close();
console.log(JSON.stringify(result, null, 2));
