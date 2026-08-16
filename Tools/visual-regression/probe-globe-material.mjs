// @purpose Runs a legacy Sandcastle gallery demo (default Globe Materials) under a forced-renderer Viewer shim; reports console errors and pixels
// @status ACTIVE

import { chromium } from "playwright";
import fs from "fs";

const RENDERER_OVERRIDE_SHIM = `
(() => {
  const FORCED_RENDERER = window.__FORCED_RENDERER__;
  if (!FORCED_RENDERER) return;
  function patchOptions(o) { if (!o) return o; const c = o.contextOptions || (o.contextOptions = {}); if (!c.renderer) c.renderer = FORCED_RENDERER; return o; }
  function build(C) { if (!C || !C.Viewer) return C; const O = C.Viewer; const OA = O.createAsync; function P(c,o) { const v = new O(c, patchOptions(o||{})); window.__capturedViewer = v; return v; } P.prototype = O.prototype; Object.assign(P, O); P.createAsync = function(c,o) { return OA.call(O, c, patchOptions(o||{})).then(v => { window.__capturedViewer = v; return v; }); }; return new Proxy(C, { get(t,k) { if (k === 'Viewer') return P; return t[k]; } }); }
  let _c; Object.defineProperty(window, "Cesium", { configurable: true, enumerable: true, get() { return _c; }, set(v) { _c = build(v); Object.defineProperty(window, "Cesium", { value: _c, writable: true, configurable: true, enumerable: true }); } });
  let _s; Object.defineProperty(window, "startup", { configurable: true, enumerable: true, get() { return _s; }, set(v) { if (typeof v === "function") _s = function(_, ...rest) { return v.call(this, window.Cesium, ...rest); }; else _s = v; } });
})();
`;

const demo = process.argv[2] || "Globe Materials.html";
const renderer = process.argv[3] || "webgpu";

const browser = await chromium.launch({ channel: "msedge", headless: true });
const ctx = await browser.newContext({ viewport: { width: 800, height: 600 } });
const page = await ctx.newPage();
const msgs = [];
page.on("console", (m) => msgs.push(`[${m.type()}] ${m.text()}`));
page.on("pageerror", (e) => msgs.push(`[PAGEERROR] ${e.message}`));

await page.addInitScript((r) => {
  window.__FORCED_RENDERER__ = r;
}, renderer);
await page.addInitScript({ content: RENDERER_OVERRIDE_SHIM });
await page.route("**/Apps/Sandcastle/gallery/**.html", async (route) => {
  const response = await route.fetch();
  const txt = (await response.text()).replace(
    /new\s+Cesium\.Viewer\s*\(/g,
    "await Cesium.Viewer.createAsync(",
  );
  await route.fulfill({
    status: response.status(),
    headers: response.headers(),
    body: txt,
  });
});

const url = `http://localhost:8080/Apps/Sandcastle/gallery/${encodeURIComponent(demo)}`;
await page.goto(url, { waitUntil: "load", timeout: 60000 });
await page.waitForTimeout(6000);
// Click the requested radio to switch material on (defaults to elevation)
const radioVal = process.argv[4] || "elevation";
const radio = await page
  .locator(`input[type="radio"][value="${radioVal}"]`)
  .first();
if ((await radio.count()) > 0) {
  await radio.click();
  console.log(`Clicked ${radioVal} radio`);
  await page.waitForTimeout(6000);
} else {
  console.log(`No ${radioVal} radio found — using default state`);
  await page.waitForTimeout(6000);
}
const outName = demo.replace(/\.html$/, "").replace(/[^a-zA-Z0-9_-]/g, "_");
fs.writeFileSync(
  `Tools/visual-regression/output/probe-${outName}-${renderer}.png`,
  await page.screenshot({ type: "png" }),
);

// Inspect material state after click
const matState = await page.evaluate(() => {
  const v = window.viewer || window.__capturedViewer;
  if (!v) return { hasViewer: false };
  const m = v.scene.globe.material;
  if (!m) return { hasMaterial: false };
  const u = m.uniforms || {};
  const img = u.image;
  return {
    type: m.type,
    wgslLen: (m.wgslShaderSource || "").length,
    imageType: img ? img.constructor?.name || typeof img : "none",
    imageHasWebGPU:
      img && img._webgpuTexture ? !!img._webgpuTexture.view : false,
    minHeight: u.minimumHeight,
    maxHeight: u.maximumHeight,
    tileProviderHasMat: !!v.scene.globe._surface?._tileProvider?.material,
  };
});
console.log("Material state:", JSON.stringify(matState, null, 2));

const errs = msgs.filter(
  (m) =>
    m.includes("[error]") ||
    m.includes("PAGEERROR") ||
    m.toLowerCase().includes("compilation") ||
    m.toLowerCase().includes("shader "),
);
const wgpuErrs = msgs.filter(
  (m) =>
    m.toLowerCase().includes("webgpu") &&
    (m.includes("error") || m.includes("warning")),
);
console.log(
  `msgs=${msgs.length} errs=${errs.length} wgpu-errs/warns=${wgpuErrs.length}`,
);
console.log("\n=== Errors / Compilation ===");
errs.slice(0, 15).forEach((e) => console.log(" ", e.substring(0, 500)));
const allErrs = msgs.filter(
  (m) =>
    m.includes("material") ||
    m.includes("shader") ||
    m.includes("Shader") ||
    m.includes("compilation"),
);
console.log("\n=== Material/Shader messages ===");
allErrs.slice(0, 15).forEach((e) => console.log(" ", e.substring(0, 500)));
console.log("\n=== WebGPU errs/warns ===");
wgpuErrs.slice(0, 5).forEach((e) => console.log(" ", e.substring(0, 350)));
console.log("\nScreenshot:", `probe-${outName}-${renderer}.png`);
await browser.close();
