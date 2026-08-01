// Debug the renderer-override shim to see why __capturedViewer stays null.
import { chromium } from "playwright";

const SHIM = `
(() => {
  const FORCED_RENDERER = window.__FORCED_RENDERER__;
  window.__shimLog = [];
  window.__shimLog.push("shim-start FORCED=" + FORCED_RENDERER);
  if (!FORCED_RENDERER) return;
  window.__capturedViewer = null;

  function buildPatched(C) {
    window.__shimLog.push("buildPatched: C exists=" + !!C + " Viewer=" + (C && C.Viewer ? "yes" : "no"));
    if (!C || !C.Viewer) return C;
    const Original = C.Viewer;
    const OriginalCreateAsync = Original.createAsync;
    function PatchedViewer(container, options) {
      window.__shimLog.push("PatchedViewer ctor called");
      const o = options || {};
      o.contextOptions = o.contextOptions || {};
      if (!o.contextOptions.renderer) o.contextOptions.renderer = FORCED_RENDERER;
      const inst = new Original(container, o);
      if (!window.__capturedViewer) window.__capturedViewer = inst;
      return inst;
    }
    PatchedViewer.prototype = Original.prototype;
    Object.assign(PatchedViewer, Original);
    PatchedViewer.createAsync = function (container, options) {
      window.__shimLog.push("Patched createAsync called");
      const o = options || {};
      o.contextOptions = o.contextOptions || {};
      if (!o.contextOptions.renderer) o.contextOptions.renderer = FORCED_RENDERER;
      return OriginalCreateAsync.call(Original, container, o).then((v) => {
        window.__shimLog.push("createAsync resolved, viewer captured");
        if (!window.__capturedViewer) window.__capturedViewer = v;
        return v;
      });
    };
    let getCount = 0;
    let viewerGetCount = 0;
    window.__viewerGetCount = () => ({ getCount, viewerGetCount });
    return new Proxy(C, {
      get(target, prop) {
        getCount++;
        if (prop === "Viewer") {
          viewerGetCount++;
          window.__shimLog.push("Proxy.get Viewer #" + viewerGetCount);
          return PatchedViewer;
        }
        return target[prop];
      },
    });
  }

  let _cesium;
  Object.defineProperty(window, "Cesium", {
    configurable: true,
    enumerable: true,
    get() { return _cesium; },
    set(val) {
      window.__shimLog.push("window.Cesium SET trapped");
      _cesium = buildPatched(val);
      Object.defineProperty(window, "Cesium", {
        value: _cesium, writable: true, configurable: true, enumerable: true,
      });
    },
  });
  if (window.Cesium) {
    const replaced = buildPatched(window.Cesium);
    Object.defineProperty(window, "Cesium", { value: replaced, writable: true, configurable: true, enumerable: true });
  }
})();
`;

const browser = await chromium.launch({ headless: true, channel: "msedge" });
const ctx = await browser.newContext({ viewport: { width: 800, height: 600 } });
const page = await ctx.newPage();
await page.addInitScript((r) => {
  window.__FORCED_RENDERER__ = r;
}, "webgpu");
await page.addInitScript({ content: SHIM });

await page.goto(
  "http://localhost:8080/Apps/Sandcastle/gallery/3D%20Models.html",
  {
    waitUntil: "domcontentloaded",
  },
);
await page.waitForFunction(() => {
  const c = document.querySelector(".cesium-widget canvas");
  return c && c.width > 0 && c.height > 0;
});
await page.waitForTimeout(3000);

const logAndState = await page.evaluate(() => {
  const counts =
    typeof window.__viewerGetCount === "function"
      ? window.__viewerGetCount()
      : null;
  return {
    log: window.__shimLog || [],
    capturedViewerExists: !!window.__capturedViewer,
    rendererType: window.__capturedViewer?.scene?.context?.rendererType ?? null,
    cesiumExists: !!window.Cesium,
    cesiumIsProxy:
      typeof window.Cesium === "object" &&
      Object.getPrototypeOf(window.Cesium) !== Object.prototype &&
      typeof window.Cesium.Viewer === "function",
    cesiumViewerName: window.Cesium?.Viewer?.name,
    proxyCounts: counts,
  };
});

console.log(JSON.stringify(logAndState, null, 2));

await browser.close();
