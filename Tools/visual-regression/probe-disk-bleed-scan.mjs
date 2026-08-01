// Scan a vertical strip of pixels for Hello World to find where the
// bluish off-disk halo actually starts in WebGPU vs WebGL.
import { chromium } from "playwright";

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

async function probe(renderer) {
  const browser = await chromium.launch({ channel: "msedge", headless: true });
  const ctx = await browser.newContext({
    viewport: { width: 800, height: 600 },
  });
  const page = await ctx.newPage();
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
  await page.goto(
    "http://localhost:8080/Apps/Sandcastle/gallery/Hello%20World.html",
    { waitUntil: "load", timeout: 60000 },
  );
  await page.waitForTimeout(8000);
  const png = await page.screenshot({ type: "png" });
  const dataUrl = `data:image/png;base64,${png.toString("base64")}`;
  const result = await page.evaluate(async (durl) => {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        const c = document.createElement("canvas");
        c.width = img.width;
        c.height = img.height;
        const cx = c.getContext("2d");
        cx.drawImage(img, 0, 0);
        // Scan horizontal row y=300, every 25 pixels
        const samples = [];
        for (let x = 0; x < 800; x += 25) {
          const d = cx.getImageData(x, 300, 1, 1).data;
          samples.push({ x, r: d[0], g: d[1], b: d[2] });
        }
        resolve(samples);
      };
      img.src = durl;
    });
  }, dataUrl);
  await browser.close();
  return result;
}

const wgl = await probe("webgl");
const wgpu = await probe("webgpu");

console.log("x    | wgl R,G,B      | wgpu R,G,B     | Δ");
console.log("-----|----------------|----------------|------");
for (let i = 0; i < wgl.length; i++) {
  const a = wgl[i];
  const b = wgpu[i];
  const dr = b.r - a.r,
    dg = b.g - a.g,
    db = b.b - a.b;
  const sumD = Math.abs(dr) + Math.abs(dg) + Math.abs(db);
  const flag = sumD > 60 ? " ⚠️" : "";
  console.log(
    `${a.x.toString().padStart(4)} | (${a.r.toString().padStart(3)},${a.g.toString().padStart(3)},${a.b.toString().padStart(3)})  | (${b.r.toString().padStart(3)},${b.g.toString().padStart(3)},${b.b.toString().padStart(3)})  | (${dr.toString().padStart(4)},${dg.toString().padStart(4)},${db.toString().padStart(4)})${flag}`,
  );
}
