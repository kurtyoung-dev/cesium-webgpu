// @purpose Fast dump of four key GPUAdapter limits (vertex buffers/attributes, bind groups, max buffer size) from the viewer page in one default Edge config.
// @status ACTIVE

import { chromium } from "playwright";
const browser = await chromium.launch({ headless: true, channel: "msedge" });
const ctx = await browser.newContext();
const page = await ctx.newPage();
await page.goto(
  "http://localhost:8080/Apps/CesiumViewer/index.html?renderer=webgpu",
  { waitUntil: "domcontentloaded" },
);
const limits = await page.evaluate(async () => {
  if (!navigator.gpu) return { error: "no gpu" };
  const adapter = await navigator.gpu.requestAdapter();
  return {
    maxVertexBuffers: adapter.limits.maxVertexBuffers,
    maxVertexAttributes: adapter.limits.maxVertexAttributes,
    maxBindGroups: adapter.limits.maxBindGroups,
    maxBufferSize: adapter.limits.maxBufferSize,
  };
});
console.log(JSON.stringify(limits, null, 2));
await browser.close();
