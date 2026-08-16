// Probe demos suspected of rendering nothing on WebGPU.
// @purpose Sweeps demos suspected of rendering nothing on WebGPU: clear-color pixel sniff + primitive/tile counts per demo, both backends.
// @status INVESTIGATION
//
// For each demo: capture WebGL + WebGPU screenshots, compute pixel
// non-default counts (sniff for "scene is just clear color"), and dump
// the scene's primitive count + tile count.
import { chromium } from "playwright";
import fs from "fs";

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
    "3D Tiles Photogrammetry.html",
    "Bathymetry.html",
    "3D Tiles Compare.html",
    "Particle System.html",
  );
}

const browser = await chromium.launch({ channel: "msedge", headless: true });
for (const demo of demos) {
  for (const renderer of ["webgl", "webgpu"]) {
    const ctx = await browser.newContext({
      viewport: { width: 800, height: 600 },
    });
    const page = await ctx.newPage();
    const msgs = [];
    page.on("console", (m) => msgs.push(`[${m.type()}] ${m.text()}`));
    page.on("pageerror", (e) => msgs.push(`[PAGEERROR] ${e.message}`));

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

    const url = `http://localhost:8080/Apps/Sandcastle/gallery/${encodeURIComponent(demo)}`;
    try {
      await page.goto(url, { waitUntil: "load", timeout: 60000 });
      await page.waitForTimeout(10000);
    } catch (e) {
      msgs.push(`[NAV ERROR] ${e.message}`);
    }
    const outName = demo.replace(/\.html$/, "").replace(/[^a-zA-Z0-9_-]/g, "_");
    const png = await page.screenshot({ type: "png" });
    fs.writeFileSync(
      `Tools/visual-regression/output/empty-${outName}-${renderer}.png`,
      png,
    );

    const state = await page.evaluate(() => {
      const v = window.viewer || window.__capturedViewer;
      if (!v) return { hasViewer: false };
      const scene = v.scene;
      const cam = scene.camera;
      const primitives = scene.primitives;
      let tilesetCount = 0;
      const primCount = primitives.length;
      let tileLoadStats = null;
      try {
        for (let i = 0; i < primitives.length; i++) {
          const p = primitives.get(i);
          if (p && p.tileVisible !== undefined) {
            tilesetCount++;
            if (p.statistics) {
              tileLoadStats = {
                visited: p.statistics.visited,
                numberOfCommands: p.statistics.numberOfCommands,
                numberOfTilesTotal: p.statistics.numberOfTilesTotal,
                numberOfTilesProcessing: p.statistics.numberOfTilesProcessing,
                numberOfPendingRequests: p.statistics.numberOfPendingRequests,
                ready: p.ready,
              };
            }
          }
        }
      } catch (e) {}
      return {
        hasViewer: true,
        renderer:
          scene.context?._rendererType ||
          (scene.context?.constructor?.name === "WebGPUContext"
            ? "webgpu"
            : "webgl"),
        primCount,
        tilesetCount,
        tileLoadStats,
        cameraHeight: cam?.positionCartographic?.height,
        cameraLongDeg:
          ((cam?.positionCartographic?.longitude || 0) * 180) / Math.PI,
        cameraLatDeg:
          ((cam?.positionCartographic?.latitude || 0) * 180) / Math.PI,
        sceneMode: scene.mode,
        globeShow: scene.globe?.show,
        skyBox: !!scene.skyBox?.show,
        skyAtmosphere: !!scene.skyAtmosphere?.show,
        canvasSize: { w: scene.canvas?.width, h: scene.canvas?.height },
      };
    });

    // Pixel histogram sniff
    const dataUrl = `data:image/png;base64,${png.toString("base64")}`;
    const hist = await page.evaluate(async (durl) => {
      return new Promise((resolve) => {
        const img = new Image();
        img.onload = () => {
          const c = document.createElement("canvas");
          c.width = img.width;
          c.height = img.height;
          const cx = c.getContext("2d");
          cx.drawImage(img, 0, 0);
          const d = cx.getImageData(0, 0, c.width, c.height).data;
          let blackPx = 0,
            whitePx = 0,
            grayPx = 0,
            coloredPx = 0;
          const total = d.length / 4;
          for (let i = 0; i < d.length; i += 4) {
            const r = d[i],
              g = d[i + 1],
              b = d[i + 2];
            if (r < 8 && g < 8 && b < 8) blackPx++;
            else if (r > 247 && g > 247 && b > 247) whitePx++;
            else if (
              Math.abs(r - g) < 5 &&
              Math.abs(g - b) < 5 &&
              Math.abs(r - b) < 5
            )
              grayPx++;
            else coloredPx++;
          }
          resolve({
            total,
            blackPx,
            whitePx,
            grayPx,
            coloredPx,
            pctBlack: ((blackPx / total) * 100).toFixed(1),
            pctWhite: ((whitePx / total) * 100).toFixed(1),
            pctGray: ((grayPx / total) * 100).toFixed(1),
            pctColored: ((coloredPx / total) * 100).toFixed(1),
          });
        };
        img.src = durl;
      });
    }, dataUrl);

    const errs = msgs.filter(
      (m) => m.includes("[error]") || m.includes("PAGEERROR"),
    );
    const warns = msgs.filter(
      (m) =>
        m.includes("[warning]") &&
        (m.includes("WebGPU") ||
          m.includes("shader") ||
          m.includes("pipeline")),
    );
    console.log(`\n=== ${demo} [${renderer}] ===`);
    console.log("State:", JSON.stringify(state));
    console.log("Pixels:", JSON.stringify(hist));
    console.log(`errs=${errs.length} wgpu-warns=${warns.length}`);
    errs.slice(0, 5).forEach((e) => console.log("  ERR:", e.substring(0, 300)));
    await ctx.close();
  }
}
await browser.close();
