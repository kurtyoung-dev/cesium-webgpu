// NEW-VR2-1 forensics — probe Bloom.html GLOBE PASS commands.
// @purpose Forensics on Bloom.html globe-pass commands — dumps tile draw state to attribute the bloom-frame terrain anomaly.
// @status INVESTIGATION
//
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
  await page.goto("http://localhost:8080/Apps/Sandcastle/gallery/Bloom.html", {
    waitUntil: "load",
    timeout: 60000,
  });
  await page.waitForTimeout(10000);
  const state = await page.evaluate(() => {
    const v = window.viewer || window.__capturedViewer;
    if (!v) return null;
    const scene = v.scene;
    const cam = scene.camera;
    const frameState = scene._frameState;
    // Sample mid-canvas pixel to verify what's there
    const canvas = scene.canvas;
    const gl = canvas.getContext("webgl2") || canvas.getContext("webgl");
    let mid = null;
    try {
      if (gl) {
        const px = new Uint8Array(4);
        gl.readPixels(
          (canvas.width / 2) | 0,
          (canvas.height / 2) | 0,
          1,
          1,
          gl.RGBA,
          gl.UNSIGNED_BYTE,
          px,
        );
        mid = { r: px[0], g: px[1], b: px[2], a: px[3] };
      }
    } catch (e) {}
    // Use scene's getDebugSnapshot for command counts
    let snap = null;
    try {
      snap = scene.getDebugSnapshot?.();
    } catch (e) {}
    // Look at frameState's commandList
    const cmdListLen = frameState?.commandList?.length ?? 0;
    // Count commands per pass
    const passCounts = {};
    if (frameState?.commandList) {
      for (const cmd of frameState.commandList) {
        const pass = cmd?.pass ?? "unknown";
        passCounts[pass] = (passCounts[pass] || 0) + 1;
      }
    }
    return {
      contextType: scene.context?.constructor?.name,
      isWebGPU: scene.context?.isWebGPU === true,
      cameraHeight: cam.positionCartographic?.height,
      drawingBufferWidth: scene.drawingBufferWidth,
      drawingBufferHeight: scene.drawingBufferHeight,
      cmdListLen,
      passCounts,
      midPixelFromGL: mid,
      framebufferSummary: snap?.scene
        ? {
            frameNumber: snap.scene.frameNumber,
            primitivesCount: snap.scene.primitivesCount,
            useHdr: snap.scene.useHdr,
          }
        : null,
    };
  });
  await browser.close();
  return state;
}

const wgl = await probe("webgl");
const wgpu = await probe("webgpu");
console.log("=== WebGL ===");
console.log(JSON.stringify(wgl, null, 2));
console.log("\n=== WebGPU ===");
console.log(JSON.stringify(wgpu, null, 2));
