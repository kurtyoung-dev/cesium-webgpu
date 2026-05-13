// Read the cumulative globe tile trace counters
import { chromium } from "playwright";

const URL = "http://localhost:8080/Apps/CesiumViewer/index.html?renderer=webgpu";
const browser = await chromium.launch({ headless: true, channel: "msedge" });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
const page = await ctx.newPage();
await page.goto(URL, { waitUntil: "networkidle" });
await page.waitForFunction(() => !!window.viewer, { timeout: 30000 });
// Run rAF loop with explicit yield between batches, so microtasks fire
await page.evaluate(async () => {
  for (let batch = 0; batch < 12; batch++) {
    await new Promise((r) => { let n=0; (function tick(){ if(n++>20) r(); else requestAnimationFrame(tick);})(); });
    await new Promise((r) => setTimeout(r, 100));
  }
});
const result = await page.evaluate(() => {
  const trace = globalThis.__dbgGlobeTileTraceGet ? globalThis.__dbgGlobeTileTraceGet() : null;
  const createTrace = globalThis.__dbgCreateTileCommands ?? null;
  const pcacheTrace = globalThis.__dbgPipelineCreates ?? null;
  const selectTrace = globalThis.__dbgSelectPipeline ?? null;
  const resolveTrace = globalThis.__dbgResolveGlobe ?? null;
  const ctx = window.viewer.scene._context;
  const pcache = ctx?.webgpuPipelineCache;
  const pcacheSize = pcache?.cache?.size ?? -1;
  const pcacheKeys = pcache?.cache ? Array.from(pcache.cache.keys()).slice(0, 5) : [];
  // Get the renderer's local pipeline cache map
  const fr = ctx?.getFeatureRenderer?.(12 /* GLOBE_SURFACE */);
  const rendererInst = fr?._instance ?? fr;
  // Try to access local pipeline cache
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
