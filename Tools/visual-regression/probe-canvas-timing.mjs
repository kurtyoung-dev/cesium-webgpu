// Snapshot canvas dimensions over time during load.
import { chromium } from 'playwright';

const RENDERER_OVERRIDE_SHIM = `
(() => {
  const FORCED_RENDERER = window.__FORCED_RENDERER__;
  if (!FORCED_RENDERER) return;
  window.__canvasSnaps = [];
  function takeSnap(label) {
    const c = document.getElementById('cesiumContainer')?.querySelector('canvas');
    if (!c) return;
    window.__canvasSnaps.push({
      t: performance.now(),
      label,
      width: c.width,
      height: c.height,
      cssWidth: c.clientWidth,
      cssHeight: c.clientHeight,
    });
  }
  setInterval(() => { takeSnap('tick'); }, 100);
  function patchOptions(o) { if (!o) return o; const c = o.contextOptions || (o.contextOptions = {}); if (!c.renderer) c.renderer = FORCED_RENDERER; return o; }
  function build(C) { if (!C || !C.Viewer) return C; const O = C.Viewer; const OA = O.createAsync; function P(c,o) { const v = new O(c, patchOptions(o||{})); window.__capturedViewer = v; return v; } P.prototype = O.prototype; Object.assign(P, O); P.createAsync = function(c,o) { takeSnap('before-createAsync'); return OA.call(O, c, patchOptions(o||{})).then(v => { window.__capturedViewer = v; takeSnap('after-createAsync'); return v; }); }; return new Proxy(C, { get(t,k) { if (k === 'Viewer') return P; return t[k]; } }); }
  let _c; Object.defineProperty(window, "Cesium", { configurable: true, enumerable: true, get() { return _c; }, set(v) { _c = build(v); Object.defineProperty(window, "Cesium", { value: _c, writable: true, configurable: true, enumerable: true }); } });
  let _s; Object.defineProperty(window, "startup", { configurable: true, enumerable: true, get() { return _s; }, set(v) { if (typeof v === "function") _s = function(_, ...rest) { return v.call(this, window.Cesium, ...rest); }; else _s = v; } });
})();
`;

async function probe(renderer) {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  const ctx = await browser.newContext({ viewport: { width: 800, height: 600 }});
  const page = await ctx.newPage();
  await page.addInitScript((r) => { window.__FORCED_RENDERER__ = r; }, renderer);
  await page.addInitScript({ content: RENDERER_OVERRIDE_SHIM });
  await page.route('**/Apps/Sandcastle/gallery/**.html', async (route) => {
    const response = await route.fetch();
    const txt = (await response.text()).replace(/new\s+Cesium\.Viewer\s*\(/g, 'await Cesium.Viewer.createAsync(');
    await route.fulfill({ status: response.status(), headers: response.headers(), body: txt });
  });
  await page.goto('http://localhost:8080/Apps/Sandcastle/gallery/Hello%20World.html', { waitUntil: 'load', timeout: 60000 });
  await page.waitForTimeout(3000);
  const result = await page.evaluate(() => ({
    snaps: (window.__canvasSnaps || []).filter((_, i, arr) => {
      // Dedupe consecutive same-value snaps
      if (i === 0) return true;
      const prev = arr[i - 1];
      const cur = arr[i];
      return prev.width !== cur.width || prev.height !== cur.height ||
             prev.cssWidth !== cur.cssWidth || prev.cssHeight !== cur.cssHeight ||
             cur.label !== 'tick';
    }).slice(0, 30),
    finalCameraHeight: (window.viewer || window.__capturedViewer)?.scene?.camera?.positionCartographic?.height,
  }));
  await browser.close();
  return result;
}

const wgl = await probe('webgl');
const wgpu = await probe('webgpu');
console.log('=== WebGL ===');
console.log(`Final cameraHeight: ${wgl.finalCameraHeight}`);
console.log('Canvas dimension snaps:');
for (const s of wgl.snaps) {
  console.log(`  t=${s.t.toFixed(0).padStart(6)}ms [${s.label.padEnd(20)}] w=${s.width} h=${s.height} cssW=${s.cssWidth} cssH=${s.cssHeight}`);
}
console.log('\n=== WebGPU ===');
console.log(`Final cameraHeight: ${wgpu.finalCameraHeight}`);
console.log('Canvas dimension snaps:');
for (const s of wgpu.snaps) {
  console.log(`  t=${s.t.toFixed(0).padStart(6)}ms [${s.label.padEnd(20)}] w=${s.width} h=${s.height} cssW=${s.cssWidth} cssH=${s.cssHeight}`);
}
