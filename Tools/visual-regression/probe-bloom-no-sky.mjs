// Probe Bloom.html with skyAtmosphere disabled.
import { chromium } from "playwright";
import fs from "fs";

const RENDERER_OVERRIDE_SHIM = `
(() => {
  function patchOptions(o) { if (!o) return o; const c = o.contextOptions || (o.contextOptions = {}); if (!c.renderer) c.renderer = 'webgpu'; return o; }
  function build(C) {
    if (!C || !C.Viewer) return C;
    const O = C.Viewer; const OA = O.createAsync;
    function setup(v) { window.__capturedViewer = v; v.scene.skyAtmosphere.show = false; return v; }
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
fs.writeFileSync("Tools/visual-regression/output/bloom-no-sky-webgpu.png", png);
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
        const mid = cx.getImageData(400, 400, 1, 1).data;
        const upper = cx.getImageData(400, 200, 1, 1).data;
        resolve({
          pctBlack: ((black / total) * 100).toFixed(1),
          pctGray: ((gray / total) * 100).toFixed(1),
          pctColored: ((colored / total) * 100).toFixed(1),
          midPx: [mid[0], mid[1], mid[2]],
          upperPx: [upper[0], upper[1], upper[2]],
        });
      };
      img.src = durl;
    });
  },
  `data:image/png;base64,${png.toString("base64")}`,
);
console.log("WebGPU Bloom.html (skyAtmosphere=off):", JSON.stringify(stats));
await browser.close();
