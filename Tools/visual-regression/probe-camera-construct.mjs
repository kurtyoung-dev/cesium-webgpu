// Patch Camera class to capture aspectRatio + dbW/H at construction.
import { chromium } from "playwright";

const RENDERER_OVERRIDE_SHIM = `
(() => {
  const FORCED_RENDERER = window.__FORCED_RENDERER__;
  if (!FORCED_RENDERER) return;
  function patchOptions(o) { if (!o) return o; const c = o.contextOptions || (o.contextOptions = {}); if (!c.renderer) c.renderer = FORCED_RENDERER; return o; }
  function build(C) {
    if (!C || !C.Viewer) return C;
    // Patch Camera class - intercept after Cesium module is built
    if (C.Camera && !C.Camera.__patched) {
      const OrigCamera = C.Camera;
      const patched = function(scene) {
        OrigCamera.call(this, scene);
        try {
          window.__cameraInits = window.__cameraInits || [];
          window.__cameraInits.push({
            t: performance.now(),
            renderer: FORCED_RENDERER,
            dbw: scene.drawingBufferWidth,
            dbh: scene.drawingBufferHeight,
            canvasW: scene.canvas.width,
            canvasH: scene.canvas.height,
            aspectRatio: this.frustum.aspectRatio,
            fov: this.frustum.fov,
            fovy: this.frustum.fovy,
            posX: this.position.x,
            posY: this.position.y,
            posZ: this.position.z,
            posMag: Math.sqrt(this.position.x**2 + this.position.y**2 + this.position.z**2),
          });
        } catch (e) {}
      };
      patched.prototype = OrigCamera.prototype;
      Object.setPrototypeOf(patched, OrigCamera);
      Object.assign(patched, OrigCamera);
      patched.__patched = true;
      C.Camera = patched;
    }
    const O = C.Viewer; const OA = O.createAsync;
    function P(c,o) { const v = new O(c, patchOptions(o||{})); window.__capturedViewer = v; return v; }
    P.prototype = O.prototype;
    Object.assign(P, O);
    P.createAsync = function(c,o) { return OA.call(O, c, patchOptions(o||{})).then(v => { window.__capturedViewer = v; return v; }); };
    return new Proxy(C, { get(t,k) { if (k === 'Viewer') return P; return t[k]; } });
  }
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
  const result = await page.evaluate(() => ({
    cameraInits: window.__cameraInits || [],
  }));
  await browser.close();
  return result;
}

const wgl = await probe("webgl");
const wgpu = await probe("webgpu");
console.log("=== WebGL Camera inits ===");
console.log(JSON.stringify(wgl.cameraInits, null, 2));
console.log("\n=== WebGPU Camera inits ===");
console.log(JSON.stringify(wgpu.cameraInits, null, 2));
