// Smoke-test Phase 6 wiring: setting
// `scene.globe.atmosphericConditions.clouds.enableVolumetric = true`
// should activate the procedural cloud renderer (which is the
// Schneider-style volumetric raymarcher).
import { chromium } from "playwright";
import fs from "fs";

const RENDERER_OVERRIDE_SHIM = `
(() => {
  function patchOptions(o) { if (!o) return o; const c = o.contextOptions || (o.contextOptions = {}); if (!c.renderer) c.renderer = 'webgpu'; return o; }
  function build(C) {
    if (!C || !C.Viewer) return C;
    const O = C.Viewer; const OA = O.createAsync;
    function setup(v) {
      window.__capturedViewer = v;
      // Flip the new toggle and verify the legacy flag follows.
      const ac = v.scene.globe.atmosphericConditions;
      ac.clouds.enableVolumetric = true;
      window.__toggleEcho = {
        enableVolumetric: ac.clouds.enableVolumetric,
        enableProcedural: ac.clouds.enableProcedural,
        showProceduralClouds: v.scene.globe.defaultCloudCollection.enableVolumetric,
      };
      return v;
    }
    function P(c,o) { return setup(new O(c, patchOptions(o||{}))); }
    P.prototype = O.prototype;
    Object.assign(P, O);
    P.createAsync = function(c,o) { return OA.call(O, c, patchOptions(o||{})).then(setup); };
    return new Proxy(C, { get(t,k) { if (k === 'Viewer') return P; return t[k]; } });
  }
  let _c; Object.defineProperty(window, "Cesium", { configurable: true, enumerable: true, get() { return _c; }, set(v) { _c = build(v); Object.defineProperty(window, "Cesium", { value: _c, writable: true, configurable: true, enumerable: true }); } });
  let _s; Object.defineProperty(window, "startup", { configurable: true, enumerable: true, get() { return _s; }, set(v) { if (typeof v === "function") _s = function(_, ...rest) { return v.call(this, window.Cesium, ...rest); }; else _s = v; } });
})();
`;

const browser = await chromium.launch({ channel: "msedge", headless: true });
const ctx = await browser.newContext({ viewport: { width: 800, height: 600 } });
const page = await ctx.newPage();
const errs = [];
page.on("console", (m) => {
  if (m.type() === "error") errs.push(m.text());
});
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
await page.goto(
  "http://localhost:8080/Apps/Sandcastle/gallery/Hello%20World.html",
  { waitUntil: "load", timeout: 60000 },
);
await page.waitForTimeout(10000);
const png = await page.screenshot({ type: "png" });
fs.writeFileSync(
  "Tools/visual-regression/output/volcloud-enabled-webgpu.png",
  png,
);
const echo = await page.evaluate(() => window.__toggleEcho);
console.log("Toggle echo:", JSON.stringify(echo));
console.log("Errors:", errs.length, errs.slice(0, 3).join(" | "));
await browser.close();
