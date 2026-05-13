// Disable requestRenderMode to force continuous rendering, then check
// if globe tiles render properly.
import { chromium } from "playwright";

const URL = "http://localhost:8080/Apps/CesiumViewer/index.html?renderer=webgpu";
const browser = await chromium.launch({ headless: true, channel: "msedge" });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
const page = await ctx.newPage();
await page.goto(URL, { waitUntil: "networkidle" });
await page.waitForFunction(() => !!window.viewer, { timeout: 30000 });

// Force continuous render mode
await page.evaluate(() => {
  const v = window.viewer;
  v.scene.requestRenderMode = false;
  v.scene.maximumRenderTimeChange = 0;
  console.log("[probe] requestRenderMode disabled");
});

await page.evaluate(async () => {
  for (let batch = 0; batch < 12; batch++) {
    await new Promise((r) => { let n=0; (function tick(){ if(n++>20) r(); else requestAnimationFrame(tick);})(); });
    await new Promise((r) => setTimeout(r, 100));
  }
});

const finalState = await page.evaluate(() => {
  const r = globalThis.__dbgResolveGlobe ?? null;
  const sel = globalThis.__dbgSelectPipeline ?? null;
  const create = globalThis.__dbgCreateTileCommands ?? null;
  const trace = globalThis.__dbgGlobeTileTraceGet ? globalThis.__dbgGlobeTileTraceGet() : null;
  return {
    addCalls: trace?.addCalls,
    pushedCommands: trace?.pushedCommands,
    selectCalls: sel?.calls,
    selectLastEntryHasPipeline: sel?.lastEntryHasPipeline,
    selectLastResult: sel?.lastResult,
    thenFired: r?.thenFired,
    cmdListLength: window.viewer.scene._frameState.commandList.length,
    cmdListPasses: window.viewer.scene._frameState.commandList.map((c) => c.pass),
  };
});
console.log("Final state:", JSON.stringify(finalState, null, 2));

await browser.close();
