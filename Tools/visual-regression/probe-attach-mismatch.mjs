// Scan a list of demos for any "Attachment state of [RenderPipeline ...]"
// validation warnings — they indicate format/sample-count drift between a
// cached pipeline and the render pass it's bound against.
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

const demos = process.argv.slice(2);
if (demos.length === 0) {
  demos.push(
    'Atmosphere.html',
    'High Dynamic Range.html',
    'Bloom.html',
    'Ambient Occlusion.html',
    'Depth of Field.html',
    'Lighting.html',
    'Shadows.html',
    'Custom Per-Feature Post Process.html',
    'Post Processing.html',
    'WebGPU Edge Visibility.html',
  );
}

const browser = await chromium.launch({ channel: 'msedge', headless: true });
const summary = [];
for (const demo of demos) {
  const ctx = await browser.newContext({ viewport: { width: 800, height: 600 }});
  const page = await ctx.newPage();
  const msgs = [];
  page.on('console', m => msgs.push(`[${m.type()}] ${m.text()}`));
  page.on('pageerror', e => msgs.push(`[PAGEERROR] ${e.message}`));

  await page.addInitScript(() => { window.__FORCED_RENDERER__ = 'webgpu'; });
  await page.addInitScript({ content: RENDERER_OVERRIDE_SHIM });
  await page.route('**/Apps/Sandcastle/gallery/**.html', async (route) => {
    const response = await route.fetch();
    const txt = (await response.text()).replace(/new\s+Cesium\.Viewer\s*\(/g, 'await Cesium.Viewer.createAsync(');
    await route.fulfill({ status: response.status(), headers: response.headers(), body: txt });
  });

  const url = `http://localhost:8080/Apps/Sandcastle/gallery/${encodeURIComponent(demo)}`;
  try {
    await page.goto(url, { waitUntil: 'load', timeout: 60000 });
    await page.waitForTimeout(8000);
  } catch (e) {
    msgs.push(`[NAV ERROR] ${e.message}`);
  }

  const attachmentMismatch = msgs.filter(m => /Attachment state of \[RenderPipeline/i.test(m));
  const depthPlane = attachmentMismatch.filter(m => /DepthPlane/i.test(m));
  const edge = attachmentMismatch.filter(m => /EdgeEmitter/i.test(m));
  const other = attachmentMismatch.filter(m => !/DepthPlane|EdgeEmitter/i.test(m));
  summary.push({ demo, total: attachmentMismatch.length, depthPlane: depthPlane.length, edge: edge.length, other: other.length, sample: attachmentMismatch[0]?.substring(0, 280) });
  await ctx.close();
}
await browser.close();

console.log('\n=== Summary ===');
for (const s of summary) {
  console.log(`${s.demo}: total=${s.total} depthPlane=${s.depthPlane} edge=${s.edge} other=${s.other}`);
  if (s.sample) console.log('  sample:', s.sample);
}
