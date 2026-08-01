// Probe to investigate why WebGPU demos don't follow camera setView/flyTo.
import { chromium } from "playwright";

const DEMO = process.argv[2] || "3D Tiles BIM";
const RENDERER_OVERRIDE = `
(() => {
  const FORCED = window.__FORCED_RENDERER__;
  if (!FORCED) return;
  function patch(C) {
    if (!C || !C.Viewer) return C;
    const Original = C.Viewer;
    const OriginalCreateAsync = Original.createAsync;
    function PatchedViewer(container, options) {
      const o = options || {};
      o.contextOptions = o.contextOptions || {};
      if (!o.contextOptions.renderer) o.contextOptions.renderer = FORCED;
      const inst = new Original(container, o);
      window.__capturedViewer = window.__capturedViewer || inst;
      return inst;
    }
    PatchedViewer.prototype = Original.prototype;
    Object.assign(PatchedViewer, Original);
    PatchedViewer.createAsync = function (c, o) {
      const opts = o || {};
      opts.contextOptions = opts.contextOptions || {};
      if (!opts.contextOptions.renderer) opts.contextOptions.renderer = FORCED;
      return OriginalCreateAsync.call(Original, c, opts).then(v => {
        window.__capturedViewer = window.__capturedViewer || v;
        return v;
      });
    };
    return new Proxy(C, { get(t, p) { return p === "Viewer" ? PatchedViewer : t[p]; } });
  }
  let _c;
  Object.defineProperty(window, "Cesium", {
    configurable: true, enumerable: true,
    get() { return _c; },
    set(v) { _c = patch(v); Object.defineProperty(window, "Cesium", { value: _c, writable: true, configurable: true, enumerable: true }); },
  });
  let _s;
  Object.defineProperty(window, "startup", {
    configurable: true, enumerable: true,
    get() { return _s; },
    set(v) {
      if (typeof v === "function") {
        _s = function(_orig, ...rest) { return v.call(this, window.Cesium, ...rest); };
      } else { _s = v; }
    },
  });
})();
`;

async function probe(forced) {
  const browser = await chromium.launch({ headless: true, channel: "msedge" });
  const ctx = await browser.newContext({
    viewport: { width: 800, height: 600 },
  });
  const page = await ctx.newPage();
  await page.addInitScript((r) => {
    window.__FORCED_RENDERER__ = r;
  }, forced);
  await page.addInitScript({ content: RENDERER_OVERRIDE });
  if (forced === "webgpu") {
    await page.route("**/Apps/Sandcastle/gallery/**.html", async (route) => {
      const r = await route.fetch();
      const t = await r.text();
      const rewritten = t
        .replace(
          /new\s+Cesium\.Viewer\s*\(/g,
          "await Cesium.Viewer.createAsync(",
        )
        .replace(/new\s+Viewer\s*\(/g, "await Cesium.Viewer.createAsync(");
      await route.fulfill({
        status: r.status(),
        headers: r.headers(),
        body: rewritten,
      });
    });
  }
  page.setDefaultTimeout(30000);
  await page.goto(
    `http://localhost:8080/Apps/Sandcastle/gallery/${encodeURIComponent(DEMO)}.html`,
    { waitUntil: "domcontentloaded" },
  );
  await page.waitForFunction(() => {
    const c = document.querySelector(".cesium-widget canvas");
    return c && c.width > 0 && c.height > 0;
  });
  await page.waitForTimeout(3500);
  const result = await page.evaluate(() => {
    const v = window.__capturedViewer;
    if (!v) return { error: "no viewer" };
    const cam = v.scene.camera;
    const trackedEntity = v.trackedEntity;
    return {
      renderer: v.scene.context.rendererType,
      position: {
        x: cam.position.x,
        y: cam.position.y,
        z: cam.position.z,
      },
      heading: cam.heading,
      pitch: cam.pitch,
      roll: cam.roll,
      cartographic: cam.positionCartographic
        ? {
            lon: Cesium.Math.toDegrees(cam.positionCartographic.longitude),
            lat: Cesium.Math.toDegrees(cam.positionCartographic.latitude),
            h: cam.positionCartographic.height,
          }
        : null,
      trackedEntity: trackedEntity
        ? {
            id: trackedEntity.id,
            name: trackedEntity.name,
            hasPosition: !!trackedEntity.position,
            hasModel: !!trackedEntity.model,
          }
        : null,
      entityCount: v.entities.values.length,
      hasEntityView: !!cam._currentEntityView || !!cam._entityViewSpriteFrame,
      requestRenderMode: v.scene.requestRenderMode,
      frameCount: v.scene.frameState.frameNumber,
    };
  });
  await browser.close();
  return result;
}

const wgl = await probe("webgl");
const wgpu = await probe("webgpu");
console.log("WebGL  camera:", JSON.stringify(wgl, null, 2));
console.log("WebGPU camera:", JSON.stringify(wgpu, null, 2));
