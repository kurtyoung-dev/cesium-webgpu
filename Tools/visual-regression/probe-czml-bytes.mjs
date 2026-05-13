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

const demo = process.argv[2] || 'CZML Rectangle.html';
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const ctx = await browser.newContext({ viewport: { width: 800, height: 600 }});
const page = await ctx.newPage();
const msgs = [];
page.on('console', m => msgs.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', e => msgs.push(`[PAGEERROR] ${e.message}\n${e.stack || ''}`));

await page.addInitScript(() => { window.__FORCED_RENDERER__ = 'webgpu'; });
await page.addInitScript({ content: RENDERER_OVERRIDE_SHIM });
await page.route('**/Apps/Sandcastle/gallery/**.html', async (route) => {
  const response = await route.fetch();
  const txt = (await response.text()).replace(/new\s+Cesium\.Viewer\s*\(/g, 'await Cesium.Viewer.createAsync(');
  await route.fulfill({ status: response.status(), headers: response.headers(), body: txt });
});

const url = `http://localhost:8080/Apps/Sandcastle/gallery/${encodeURIComponent(demo)}`;
await page.goto(url, { waitUntil: 'load', timeout: 60000 });
await page.waitForTimeout(8000);

const bufErrs = msgs.filter(m =>
  /writeBuffer|createBuffer|Number of bytes|byte count/i.test(m)
);
const includesErrs = msgs.filter(m => /\.includes is not a function/i.test(m));
const vec4Errs = msgs.filter(m => /Invalid vec4 value|UniformArrayFloatVec4/i.test(m));
const wgslDoctype = msgs.filter(m => /unexpected token <!DOCTYPE/i.test(m));
const errs = msgs.filter(m => m.includes('[error]') || m.includes('PAGEERROR'));
console.log(`msgs=${msgs.length} buf=${bufErrs.length} includes=${includesErrs.length} vec4=${vec4Errs.length} doctype=${wgslDoctype.length} all-errs=${errs.length}`);
console.log('\n=== Errors (last 8) — full ===');
errs.slice(-8).forEach(e => console.log(' ', e.substring(0, 1500)));
await browser.close();
