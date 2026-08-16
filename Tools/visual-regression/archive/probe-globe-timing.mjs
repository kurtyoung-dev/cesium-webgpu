// @purpose Collects '[GLOBE-PIPELINE]' console timing logs and __dbgResolveGlobe/__dbgSelectPipeline state during a settle loop
// @status INVESTIGATION

import { chromium } from "playwright";

const URL =
  "http://localhost:8080/Apps/CesiumViewer/index.html?renderer=webgpu";
const browser = await chromium.launch({ headless: true, channel: "msedge" });
const ctx = await browser.newContext({
  viewport: { width: 1280, height: 720 },
});
const page = await ctx.newPage();

const messages = [];
page.on("console", (m) => {
  const text = m.text();
  if (text.includes("[GLOBE-PIPELINE]")) {
    messages.push(`[${m.type()}] ${text}`);
  }
});

await page.goto(URL, { waitUntil: "networkidle" });
await page.waitForFunction(() => !!window.viewer, { timeout: 30000 });

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

console.log("=== GLOBE-PIPELINE timing logs ===");
for (const m of messages) console.log(m);
console.log(`\n(captured ${messages.length} messages)`);

const finalState = await page.evaluate(() => {
  const r = globalThis.__dbgResolveGlobe ?? null;
  const sel = globalThis.__dbgSelectPipeline ?? null;
  return {
    kickStartTime: r?.kickStartTime,
    thenFireTime: r?.thenFireTime,
    thenFired: r?.thenFired,
    selectCalls: sel?.calls,
    selectLastResult: sel?.lastResult,
    selectLastEntryHasPipeline: sel?.lastEntryHasPipeline,
  };
});
console.log("\nFinal state:", JSON.stringify(finalState, null, 2));

await browser.close();
