// NEW-VR2-3c forensics — dump camera/canvas/projection state.
import { chromium } from 'playwright';

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
  await page.waitForTimeout(8000);
  const state = await page.evaluate(() => {
    const v = window.viewer || window.__capturedViewer;
    if (!v) return null;
    const scene = v.scene;
    const cam = scene.camera;
    const f = cam.frustum;
    return {
      dbw: scene.drawingBufferWidth,
      dbh: scene.drawingBufferHeight,
      canvasW: scene.canvas.width,
      canvasH: scene.canvas.height,
      cssW: scene.canvas.clientWidth,
      cssH: scene.canvas.clientHeight,
      pixelRatio: scene.pixelRatio,
      cameraH: cam.positionCartographic?.height,
      fov: f.fov,
      fovy: f.fovy,
      aspectRatio: f.aspectRatio,
      near: f.near,
      far: f.far,
    };
  });
  await browser.close();
  return state;
}

const wgl = await probe('webgl');
const wgpu = await probe('webgpu');
console.log('Field          | WebGL                  | WebGPU');
console.log('---------------|------------------------|------------------------');
const fields = ['dbw', 'dbh', 'canvasW', 'canvasH', 'cssW', 'cssH', 'pixelRatio', 'cameraH', 'fov', 'fovy', 'aspectRatio', 'near', 'far'];
for (const f of fields) {
  console.log(`${f.padEnd(14)} | ${String(wgl[f]).padEnd(22)} | ${String(wgpu[f]).padEnd(22)} ${wgl[f] !== wgpu[f] ? '⚠️' : ''}`);
}
