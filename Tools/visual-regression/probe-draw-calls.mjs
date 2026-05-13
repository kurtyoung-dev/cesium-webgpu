// Diagnostic probe — instrument the GPURenderPassEncoder to count
// actual GPU draw calls vs no-ops. Tells us whether commands are
// reaching the encoder or being skipped silently.

import { chromium } from "playwright";

const URL = "http://localhost:8080/Apps/CesiumViewer/index.html?renderer=webgpu";

const browser = await chromium.launch({ headless: true, channel: "msedge" });
const ctx = await browser.newContext({
  viewport: { width: 1280, height: 720 },
});
const page = await ctx.newPage();

console.log("[probe-draws] navigating");
await page.goto(URL, { waitUntil: "networkidle" });

// BEFORE viewer init, install instrumentation hooks on the
// GPURenderPassEncoder prototype. Hooks count calls per method.
await page.addInitScript(() => {
  if (
    !window.__drawCountInstalled &&
    typeof window.GPURenderPassEncoder !== "undefined"
  ) {
    window.__drawCounts = {
      setPipeline: 0,
      setBindGroup: 0,
      setVertexBuffer: 0,
      setIndexBuffer: 0,
      draw: 0,
      drawIndexed: 0,
      drawIndirect: 0,
      drawIndexedIndirect: 0,
      executeBundles: 0,
      beginRenderPass: 0,
      end: 0,
    };
    const proto = window.GPURenderPassEncoder.prototype;
    for (const name of [
      "setPipeline",
      "setBindGroup",
      "setVertexBuffer",
      "setIndexBuffer",
      "draw",
      "drawIndexed",
      "drawIndirect",
      "drawIndexedIndirect",
      "executeBundles",
      "end",
    ]) {
      const orig = proto[name];
      if (typeof orig === "function") {
        proto[name] = function (...args) {
          window.__drawCounts[name] = (window.__drawCounts[name] || 0) + 1;
          return orig.apply(this, args);
        };
      }
    }
    // Also hook beginRenderPass on the encoder
    if (typeof window.GPUCommandEncoder !== "undefined") {
      const ceProto = window.GPUCommandEncoder.prototype;
      const origBegin = ceProto.beginRenderPass;
      if (typeof origBegin === "function") {
        ceProto.beginRenderPass = function (desc) {
          window.__drawCounts.beginRenderPass =
            (window.__drawCounts.beginRenderPass || 0) + 1;
          return origBegin.call(this, desc);
        };
      }
    }
    window.__drawCountInstalled = true;
  }
});

// Re-navigate so the addInitScript runs from the top.
await page.goto(URL, { waitUntil: "networkidle" });
await page.waitForFunction(() => !!window.viewer, { timeout: 30_000 });

// Reset counters then render for ~3s
await page.evaluate(() => {
  if (window.__drawCounts) {
    for (const k of Object.keys(window.__drawCounts)) {
      window.__drawCounts[k] = 0;
    }
  }
});
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

const result = await page.evaluate(() => ({
  drawCounts: window.__drawCounts ?? null,
  hookInstalled: !!window.__drawCountInstalled,
  hasGPURenderPassEncoder: typeof window.GPURenderPassEncoder !== "undefined",
  rendererType: window.viewer?.scene?.context?.rendererType ?? null,
  // Sanity: does scene have the expected setup?
  sceneFrameNumber: window.viewer?.scene?._frameState?.frameNumber ?? null,
  hasAlternateRenderer: !!window.viewer?.scene?._alternateSceneRenderer,
}));
console.log("\n[probe-draws] WebGPU draw-call counts over 180 frames:");
console.log(JSON.stringify(result, null, 2));

await browser.close();
