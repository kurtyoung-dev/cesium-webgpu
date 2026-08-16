// Probe Bloom.html with globe.show = false to see what fills the lower half.
// @purpose Bloom.html forensics variant: globe.show=false to identify what fills the lower half during the missing-terrain bloom investigation.
// @status INVESTIGATION
//
import { chromium } from "playwright";
import fs from "fs";

const RENDERER_OVERRIDE_SHIM = `
(() => {
  function patchOptions(o) { if (!o) return o; const c = o.contextOptions || (o.contextOptions = {}); if (!c.renderer) c.renderer = 'webgpu'; return o; }
  function build(C) {
    if (!C || !C.Viewer) return C;
    const O = C.Viewer; const OA = O.createAsync;
    function setup(v) { window.__capturedViewer = v; v.scene.globe.show = false; return v; }
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
const msgs = [];
page.on("console", (m) => msgs.push(`[${m.type()}] ${m.text()}`));
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
  "Tools/visual-regression/output/bloom-no-globe-webgpu.png",
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
          { name: "sky", x: 400, y: 100 },
          { name: "mid-300", x: 400, y: 300 },
          { name: "mid-400", x: 400, y: 400 },
          { name: "low-500", x: 400, y: 500 },
          { name: "lower-left", x: 100, y: 450 },
          { name: "lower-right", x: 700, y: 450 },
        ];
        const result = points.map((p) => {
          const d = cx.getImageData(p.x, p.y, 1, 1).data;
          return { ...p, r: d[0], g: d[1], b: d[2] };
        });
        resolve(result);
      };
      img.src = durl;
    });
  },
  `data:image/png;base64,${png.toString("base64")}`,
);
console.log("Bloom.html WebGPU (globe.show = false):");
for (const s of samples) {
  console.log(
    `  ${s.name.padEnd(15)} @ (${s.x},${s.y}) = (${s.r}, ${s.g}, ${s.b})`,
  );
}
await browser.close();
