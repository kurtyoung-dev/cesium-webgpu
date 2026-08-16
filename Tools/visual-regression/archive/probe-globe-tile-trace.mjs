// Read the cumulative globe tile trace counters
// @purpose Reads cumulative globe tile-trace debug globals (__dbgGlobeTileTraceGet etc.) plus pipeline-cache size after a settle loop
// @status INVESTIGATION
//
import { chromium } from "playwright";

const URL =
  "http://localhost:8080/Apps/CesiumViewer/index.html?renderer=webgpu";
const browser = await chromium.launch({ headless: true, channel: "msedge" });
const ctx = await browser.newContext({
  viewport: { width: 1280, height: 720 },
});
const page = await ctx.newPage();
await page.goto(URL, { waitUntil: "networkidle" });
await page.waitForFunction(() => !!window.viewer, { timeout: 30000 });
// Run rAF loop with explicit yield between batches, so microtasks fire
await page.evaluate(async () => {
  for (let batch = 0; batch < 12; batch++) {
    await new Promise((r) => {
      let n = 0;
      (function tick() {
        if (n++ > 20) r();
        else requestAnimationFrame(tick);
      })();
    });
    await new Promise((r) => setTimeout(r, 100));
  }
});
const result = await page.evaluate(() => {
  const trace = globalThis.__dbgGlobeTileTraceGet
    ? globalThis.__dbgGlobeTileTraceGet()
    : null;
  const createTrace = globalThis.__dbgCreateTileCommands ?? null;
  const pcacheTrace = globalThis.__dbgPipelineCreates ?? null;
  const selectTrace = globalThis.__dbgSelectPipeline ?? null;
  const resolveTrace = globalThis.__dbgResolveGlobe ?? null;
  const ctx = window.viewer.scene._context;
  const pcache = ctx?.webgpuPipelineCache;
  const pcacheSize = pcache?.cache?.size ?? -1;
  const pcacheKeys = pcache?.cache
    ? Array.from(pcache.cache.keys()).slice(0, 5)
    : [];
  // The renderer's per-device instance lives in a module-scoped WeakMap
  // inside GlobeSurfaceTileProviderRendering.js — not accessible from
  // here. `fr` (the FR record) only carries the RendererClass
  // constructor, not the running instance. See WEBGPU_DEBUGGING_LOG.md
  // Batch 71 for why fr._instance was removed.
  return {
    trace,
    createTrace,
    pcacheTrace,
    selectTrace,
    resolveTrace,
    pcacheSize,
    pcacheKeys,
    cmdListLength: window.viewer.scene._frameState.commandList.length,
    tilesToRender: window.viewer.scene.globe._surface._tilesToRender.length,
    pcacheStats: pcache?.stats,
  };
});
console.log("[probe-globe-tile-trace] result:");
console.log(JSON.stringify(result, null, 2));
await browser.close();
