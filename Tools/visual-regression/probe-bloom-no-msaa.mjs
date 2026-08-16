// Probe Bloom.html with scene.msaaSamples = 1 (MSAA disabled) to see
// if the missing-terrain issue is MSAA-related.
// @purpose Bloom.html forensics variant: msaaSamples=1 to test whether the missing-terrain issue was MSAA-related.
// @status INVESTIGATION
//
import { chromium } from "playwright";
import fs from "fs";

const RENDERER_OVERRIDE_SHIM = `
(() => {
  const FORCED_RENDERER = window.__FORCED_RENDERER__;
  if (!FORCED_RENDERER) return;
  function patchOptions(o) { if (!o) return o; const c = o.contextOptions || (o.contextOptions = {}); if (!c.renderer) c.renderer = FORCED_RENDERER; return o; }
  function build(C) {
    if (!C || !C.Viewer) return C;
    const O = C.Viewer; const OA = O.createAsync;
    function P(c,o) { const v = new O(c, patchOptions(o||{})); window.__capturedViewer = v; v.scene.msaaSamples = 1; return v; }
    P.prototype = O.prototype;
    Object.assign(P, O);
    P.createAsync = function(c,o) { return OA.call(O, c, patchOptions(o||{})).then(v => { window.__capturedViewer = v; v.scene.msaaSamples = 1; return v; }); };
    return new Proxy(C, { get(t,k) { if (k === 'Viewer') return P; return t[k]; } });
  }
  let _c; Object.defineProperty(window, "Cesium", { configurable: true, enumerable: true, get() { return _c; }, set(v) { _c = build(v); Object.defineProperty(window, "Cesium", { value: _c, writable: true, configurable: true, enumerable: true }); } });
  let _s; Object.defineProperty(window, "startup", { configurable: true, enumerable: true, get() { return _s; }, set(v) { if (typeof v === "function") _s = function(_, ...rest) { return v.call(this, window.Cesium, ...rest); }; else _s = v; } });
})();
`;

const browser = await chromium.launch({ channel: "msedge", headless: true });
const ctx = await browser.newContext({ viewport: { width: 800, height: 600 } });
const page = await ctx.newPage();
await page.addInitScript({ content: `window.__FORCED_RENDERER__ = 'webgpu';` });
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
await page.goto("http://localhost:8080/Apps/Sandcastle/gallery/Bloom.html", {
  waitUntil: "load",
  timeout: 60000,
});
await page.waitForTimeout(10000);
const png = await page.screenshot({ type: "png" });
fs.writeFileSync(
  "Tools/visual-regression/output/bloom-no-msaa-webgpu.png",
  png,
);
const stats = await page.evaluate(
  async (durl) => {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        const c = document.createElement("canvas");
        c.width = img.width;
        c.height = img.height;
        const cx = c.getContext("2d");
        cx.drawImage(img, 0, 0);
        const d = cx.getImageData(0, 0, c.width, c.height).data;
        let black = 0,
          colored = 0,
          gray = 0;
        const total = d.length / 4;
        for (let i = 0; i < d.length; i += 4) {
          const r = d[i],
            g = d[i + 1],
            b = d[i + 2];
          if (r < 8 && g < 8 && b < 8) black++;
          else if (Math.abs(r - g) < 5 && Math.abs(g - b) < 5) gray++;
          else colored++;
        }
        // Sample middle of canvas
        const mid = cx.getImageData(400, 400, 1, 1).data;
        resolve({
          pctBlack: ((black / total) * 100).toFixed(1),
          pctGray: ((gray / total) * 100).toFixed(1),
          pctColored: ((colored / total) * 100).toFixed(1),
          midPx: [mid[0], mid[1], mid[2]],
        });
      };
      img.src = durl;
    });
  },
  `data:image/png;base64,${png.toString("base64")}`,
);
console.log("WebGPU Bloom.html (msaa=1):", JSON.stringify(stats));
await browser.close();
