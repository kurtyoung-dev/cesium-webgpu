// @purpose One-off variant of the particle sample: WebGPU-forced Particle System Sandcastle with fog disabled, isolating fog's effect on particles
// @status INVESTIGATION

import { chromium } from "playwright";
import fs from "fs";

const RENDERER_OVERRIDE_SHIM = `
(() => {
  function patchOptions(o) { if (!o) return o; const c = o.contextOptions || (o.contextOptions = {}); if (!c.renderer) c.renderer = 'webgpu'; return o; }
  function build(C) {
    if (!C || !C.Viewer) return C;
    const O = C.Viewer; const OA = O.createAsync;
    function setup(v) { window.__capturedViewer = v; v.scene.fog.enabled = false; return v; }
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
await page.goto(
  "http://localhost:8080/Apps/Sandcastle/gallery/Particle%20System.html",
  { waitUntil: "load", timeout: 60000 },
);
await page.waitForTimeout(12000);
const png = await page.screenshot({ type: "png" });
fs.writeFileSync(
  "Tools/visual-regression/output/particle-no-fog-webgpu.png",
  png,
);
const samples = await page.evaluate(
  async (durl) => {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        const c = document.createElement("canvas");
        c.width = img.width;
        c.height = img.height;
        const cx = c.getContext("2d");
        cx.drawImage(img, 0, 0);
        const points = [
          { name: "mid-canvas", x: 400, y: 300 },
          { name: "lower-mid", x: 400, y: 450 },
          { name: "left-mid", x: 200, y: 300 },
          { name: "right-mid", x: 600, y: 300 },
          { name: "lower-left", x: 200, y: 500 },
        ];
        resolve(
          points.map((p) => {
            const d = cx.getImageData(p.x, p.y, 1, 1).data;
            return { ...p, r: d[0], g: d[1], b: d[2] };
          }),
        );
      };
      img.src = durl;
    });
  },
  `data:image/png;base64,${png.toString("base64")}`,
);
console.log("Particle System WebGPU (fog disabled):");
for (const s of samples) {
  console.log(
    `  ${s.name.padEnd(12)} @ (${s.x},${s.y}) = (${s.r},${s.g},${s.b})`,
  );
}
await browser.close();
