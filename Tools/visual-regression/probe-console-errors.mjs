// @purpose Minimal utility: loads the WebGPU viewer, settles 180 frames, prints only error/pipeline-failure console messages.
// @status ACTIVE

import { chromium } from "playwright";
const URL =
  "http://localhost:8080/Apps/CesiumViewer/index.html?renderer=webgpu";
const browser = await chromium.launch({ headless: true, channel: "msedge" });
const ctx = await browser.newContext({
  viewport: { width: 1280, height: 720 },
});
const page = await ctx.newPage();
const messages = [];
page.on("console", (m) => messages.push(`[${m.type()}] ${m.text()}`));
page.on("pageerror", (e) => messages.push(`[pageerror] ${e.message}`));
await page.goto(URL, { waitUntil: "networkidle" });
await page.waitForFunction(() => !!window.viewer, { timeout: 30000 });
await page.evaluate(
  () =>
    new Promise((r) => {
      let n = 0;
      (function tick() {
        if (n++ > 180) r();
        else requestAnimationFrame(tick);
      })();
    }),
);
console.log("=== ERRORS only ===");
for (const m of messages) {
  if (
    m.includes("[error]") ||
    m.includes("[pageerror]") ||
    m.includes("Failed to create pipeline") ||
    m.includes("VALIDATION") ||
    m.includes("Failed")
  ) {
    console.log(m);
  }
}
console.log(`\n(total messages: ${messages.length})`);
await browser.close();
