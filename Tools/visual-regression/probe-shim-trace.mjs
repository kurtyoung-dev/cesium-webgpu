import { chromium } from "playwright";
import { readFileSync } from "node:fs";
import path from "node:path";
const RUNNER = path.resolve("Tools/visual-regression/cross-backend-sandcastle-runner.mjs");
const code = readFileSync(RUNNER, "utf-8");
const SHIM_MATCH = code.match(/const RENDERER_OVERRIDE_SHIM = `([\s\S]*?)`;/);
const SHIM = SHIM_MATCH[1];
const browser = await chromium.launch({ headless: true, channel: "msedge" });
const ctx = await browser.newContext({ viewport: { width: 800, height: 600 } });
const page = await ctx.newPage();
await page.addInitScript((r) => { window.__FORCED_RENDERER__ = r; }, "webgpu");
await page.addInitScript({ content: SHIM });
await page.route("**/Apps/Sandcastle/gallery/**.html", async (route) => {
  const r = await route.fetch();
  const t = await r.text();
  const rewritten = t
    .replace(/new\s+Cesium\.Viewer\s*\(/g, "await Cesium.Viewer.createAsync(")
    .replace(/new\s+Viewer\s*\(/g, "await Cesium.Viewer.createAsync(");
  await route.fulfill({ status: r.status(), headers: r.headers(), body: rewritten });
});
await page.goto("http://localhost:8080/Apps/Sandcastle/gallery/3D%20Models.html", { waitUntil: "domcontentloaded" });
await page.waitForFunction(() => {
  const c = document.querySelector(".cesium-widget canvas");
  return c && c.width > 0 && c.height > 0;
});
await page.waitForTimeout(4000);
const debug = await page.evaluate(() => ({
  log: window.__shimDebug || [],
  hasViewer: !!window.__capturedViewer,
  entityCount: window.__capturedViewer ? window.__capturedViewer.entities.values.length : -1,
  trackedEntity: window.__capturedViewer && window.__capturedViewer.trackedEntity ? window.__capturedViewer.trackedEntity.name : null,
}));
console.log(JSON.stringify(debug, null, 2));
await browser.close();
