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

const browser = await chromium.launch({ channel: "msedge", headless: true });
const ctx = await browser.newContext({ viewport: { width: 800, height: 600 } });
const page = await ctx.newPage();
const msgs = [];
page.on("console", (m) => msgs.push(`[${m.type()}] ${m.text()}`));
page.on("pageerror", (e) => msgs.push(`[PAGEERROR] ${e.message}`));

await page.addInitScript(() => {
  window.__FORCED_RENDERER__ = "webgpu";
});
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
  "http://localhost:8080/Apps/Sandcastle/gallery/Bathymetry.html",
  { waitUntil: "load", timeout: 60000 },
);
await page.waitForTimeout(8000);

const state = await page.evaluate(() => {
  const v = window.viewer || window.__capturedViewer;
  if (!v) return { hasViewer: false };
  const globe = v.scene.globe;
  const mat = globe.material;
  if (!mat) return { hasMaterial: false };

  // Dump the composite's wgslShaderSource (what gets prepended to GlobeTerrain.wgsl)
  const wgslSource = mat.wgslShaderSource || "";

  // Inspect composite + sub-material uniforms directly
  const inspect = (m) => {
    if (!m) return null;
    const keys = [];
    try {
      for (const k of Object.keys(m.uniforms)) keys.push(k);
    } catch (e) {}
    const valuesByKey = {};
    for (const k of keys) {
      let val;
      try {
        val = m.uniforms[k];
      } catch (e) {
        val = `<error: ${e.message}>`;
      }
      valuesByKey[k] =
        val == null
          ? String(val)
          : val instanceof HTMLCanvasElement
            ? "HTMLCanvasElement"
            : val.constructor?.name || typeof val;
    }
    return {
      type: m.type,
      wgslLen: (m.wgslShaderSource || "").length,
      keys,
      values: valuesByKey,
    };
  };

  const composite = inspect(mat);
  const subs = {};
  if (mat.materials) {
    for (const k of Object.keys(mat.materials)) {
      subs[k] = inspect(mat.materials[k]);
    }
  }
  // Also test what the WGSL fabric's `image` lookup returns when walking sub-materials manually
  let imageFromSubMaterials = "not found";
  if (mat.materials) {
    for (const k of Object.keys(mat.materials)) {
      const sub = mat.materials[k];
      if (sub && sub.uniforms && "image" in sub.uniforms) {
        const img = sub.uniforms.image;
        imageFromSubMaterials =
          img == null
            ? String(img)
            : img instanceof HTMLCanvasElement
              ? `HTMLCanvasElement(${img.width}x${img.height})`
              : img.constructor?.name || typeof img;
        break;
      }
    }
  }
  return { composite, subs, imageFromSubMaterials, wgslSource };
});

console.log(JSON.stringify(state, null, 2));
await browser.close();
