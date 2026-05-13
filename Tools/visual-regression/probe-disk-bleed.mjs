// Probe NEW-VR2-3-IMAGERY-WASH-OUT — sample globe-disk pixels in WebGL
// vs WebGPU for the affected demos. Reports center-disk RGB so we can
// see if atmosphere is bleeding cyan onto the ocean.
import { chromium } from 'playwright';
import fs from 'fs';

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

const demos = process.argv.slice(2);
if (demos.length === 0) {
  demos.push('Hello World.html', 'Star Burst.html', 'Box.html', 'Polygon.html', 'Polyline.html', 'Sentinel-2.html');
}

const browser = await chromium.launch({ channel: 'msedge', headless: true });

// Sample several points across the canvas to find disk + sky pixels
function samplePoints(pngBuf, width, height) {
  // Returns RGB at: center, mid-left disk, upper-right sky
  // Simple PNG parsing — use canvas via page would be more reliable.
  return null;
}

async function probeDemo(demo, renderer) {
  const ctx = await browser.newContext({ viewport: { width: 800, height: 600 }});
  const page = await ctx.newPage();
  await page.addInitScript((r) => { window.__FORCED_RENDERER__ = r; }, renderer);
  await page.addInitScript({ content: RENDERER_OVERRIDE_SHIM });
  await page.route('**/Apps/Sandcastle/gallery/**.html', async (route) => {
    const response = await route.fetch();
    const txt = (await response.text()).replace(/new\s+Cesium\.Viewer\s*\(/g, 'await Cesium.Viewer.createAsync(');
    await route.fulfill({ status: response.status(), headers: response.headers(), body: txt });
  });
  try {
    await page.goto(`http://localhost:8080/Apps/Sandcastle/gallery/${encodeURIComponent(demo)}`, { waitUntil: 'load', timeout: 60000 });
    await page.waitForTimeout(8000);
  } catch (e) {
    await ctx.close();
    return { error: e.message };
  }
  const outName = demo.replace(/\.html$/, '').replace(/[^a-zA-Z0-9_-]/g, '_');
  const png = await page.screenshot({ type: 'png' });
  fs.writeFileSync(`Tools/visual-regression/output/disk-bleed-${outName}-${renderer}.png`, png);

  // Use the page's own canvas to sample points
  const samples = await page.evaluate(async (durl) => {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        const c = document.createElement('canvas');
        c.width = img.width; c.height = img.height;
        const cx = c.getContext('2d');
        cx.drawImage(img, 0, 0);
        const pts = [
          { name: 'center', x: 400, y: 300 },           // center of canvas
          { name: 'mid-upper', x: 400, y: 200 },        // upper region (likely sky/atmosphere)
          { name: 'mid-lower', x: 400, y: 400 },        // lower region (likely disk)
          { name: 'left-disk', x: 200, y: 300 },        // disk left
          { name: 'right-disk', x: 600, y: 300 },       // disk right
        ];
        const result = pts.map(p => {
          const d = cx.getImageData(p.x, p.y, 1, 1).data;
          return { ...p, r: d[0], g: d[1], b: d[2], a: d[3] };
        });
        resolve(result);
      };
      img.src = durl;
    });
  }, `data:image/png;base64,${png.toString('base64')}`);
  await ctx.close();
  return { samples };
}

for (const demo of demos) {
  const wgl = await probeDemo(demo, 'webgl');
  const wgpu = await probeDemo(demo, 'webgpu');
  console.log(`\n=== ${demo} ===`);
  if (wgl.error || wgpu.error) {
    console.log('  ERROR:', wgl.error || wgpu.error);
    continue;
  }
  for (let i = 0; i < wgl.samples.length; i++) {
    const a = wgl.samples[i];
    const b = wgpu.samples[i];
    const dr = b.r - a.r, dg = b.g - a.g, db = b.b - a.b;
    const flag = (Math.abs(dr) + Math.abs(dg) + Math.abs(db)) > 60 ? ' ⚠️' : '';
    console.log(`  ${a.name.padEnd(11)} wgl=(${a.r.toString().padStart(3)},${a.g.toString().padStart(3)},${a.b.toString().padStart(3)})  wgpu=(${b.r.toString().padStart(3)},${b.g.toString().padStart(3)},${b.b.toString().padStart(3)})  Δ=(${dr.toString().padStart(4)},${dg.toString().padStart(4)},${db.toString().padStart(4)})${flag}`);
  }
}
await browser.close();
