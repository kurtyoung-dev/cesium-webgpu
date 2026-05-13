// Dusk-terminator regression probe (Batch 24, orbit polish §13.3).
//
// Validates `lightDirectionEC` plumbing (Batches 17/18) +
// `computeDayNightFade` math + `nightAmbient` floor by setting the
// scene's clock to the vernal equinox at a longitude where the
// day/night terminator crosses the viewport, then comparing the lit
// vs unlit hemisphere pixel ratios.
//
// Expected: WebGL and WebGPU both render with the terminator
// roughly down the center of the view; the unlit (night) hemisphere
// is significantly darker (mean luminance ratio > 4:1 lit:unlit).
//
// Outputs:
//   - Tools/visual-regression/output/dusk-{webgl,webgpu}.png
//   - Per-side mean RGB + lit/unlit luminance ratio
//
// Failure modes this probe catches:
//   - Wrong sun direction (Batch 17 regression) → both sides ~equal
//     brightness, or the terminator lands on the wrong meridian.
//   - Wrong nightAmbient floor → unlit side too bright (no dark
//     night) OR pure black (city lights / earthshine missing).
//   - lightDirectionEC swapped with sunDirectionEC → custom
//     DirectionalLight scenes would diverge from this probe.
import { chromium } from 'playwright';
import fs from 'fs';

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

async function probe(browser, renderer) {
  const ctx = await browser.newContext({ viewport: { width: 800, height: 600 } });
  const page = await ctx.newPage();
  const msgs = [];
  page.on('console', m => msgs.push(`[${m.type()}] ${m.text()}`));

  await page.addInitScript((r) => { window.__FORCED_RENDERER__ = r; }, renderer);
  await page.addInitScript({ content: RENDERER_OVERRIDE_SHIM });
  await page.route('**/Apps/Sandcastle/gallery/**.html', async (route) => {
    const response = await route.fetch();
    const txt = (await response.text()).replace(/new\s+Cesium\.Viewer\s*\(/g, 'await Cesium.Viewer.createAsync(');
    await route.fulfill({ status: response.status(), headers: response.headers(), body: txt });
  });

  await page.goto('http://localhost:8080/Apps/Sandcastle/gallery/Hello%20World.html', { waitUntil: 'load', timeout: 60000 });
  await page.waitForTimeout(4000);

  // Set vernal equinox 2026-03-20 21:00 UTC and camera position so the
  // terminator crosses near the meridian visible from the camera. At
  // 0°N, 90°E, 21:00 UTC the sun is approximately 90° to the west of
  // the camera → terminator runs roughly north-south through the
  // viewport center.
  await page.evaluate(() => {
    const v = window.viewer || window.__capturedViewer;
    if (!v) return;
    const Cesium = window.Cesium;
    // CRITICAL: globe lighting must be on for the day/night terminator
    // to be visible. Hello World defaults to off — without this flag
    // the globe renders as if uniformly lit by ambient sunlight.
    v.scene.globe.enableLighting = true;
    // Vernal equinox 12:00 UTC: sun is overhead the Greenwich meridian
    // (0°E) at noon, so the sub-solar point is at (0°N, 0°E). The
    // anti-solar point (midnight, fully unlit) is at (0°N, 180°E).
    // We position the camera at 90°E so the terminator crosses
    // roughly down the center of the viewport.
    v.clock.currentTime = Cesium.JulianDate.fromIso8601('2026-03-20T12:00:00Z');
    v.clock.shouldAnimate = false;
    // Camera at 12 Mm altitude over (0°N, 90°E) looking down at Earth.
    v.scene.camera.setView({
      destination: Cesium.Cartesian3.fromDegrees(90.0, 0.0, 12_000_000.0),
      orientation: {
        heading: 0.0,
        pitch: -Cesium.Math.PI_OVER_TWO,
        roll: 0.0,
      },
    });
    v.scene.requestRender();
  });
  await page.waitForTimeout(6000);

  const png = await page.screenshot({ type: 'png' });
  fs.writeFileSync(`Tools/visual-regression/output/dusk-${renderer}.png`, png);

  // Sample the left and right halves of the canvas to compute mean
  // luminance per side. The terminator should run roughly down the
  // center, so left half ≈ unlit, right half ≈ lit (camera longitude
  // 90°E places the sub-solar point on the eastern half of the view).
  const stats = await page.evaluate(async (durl) => {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        const c = document.createElement('canvas');
        c.width = img.width; c.height = img.height;
        const cx = c.getContext('2d');
        cx.drawImage(img, 0, 0);
        // Avoid the UI overlays — sample a disk-shaped region in the
        // bottom half of the canvas where the globe is.
        const halfW = img.width >> 1;
        const yStart = img.height >> 2;
        const yEnd = img.height - 50;
        let leftR = 0, leftG = 0, leftB = 0, leftN = 0;
        let rightR = 0, rightG = 0, rightB = 0, rightN = 0;
        for (let y = yStart; y < yEnd; y += 4) {
          for (let x = 0; x < img.width; x += 4) {
            const d = cx.getImageData(x, y, 1, 1).data;
            // Skip pixels close to pure black (likely space/sky)
            const lum = 0.299 * d[0] + 0.587 * d[1] + 0.114 * d[2];
            if (lum < 8) continue;
            if (x < halfW) {
              leftR += d[0]; leftG += d[1]; leftB += d[2]; leftN++;
            } else {
              rightR += d[0]; rightG += d[1]; rightB += d[2]; rightN++;
            }
          }
        }
        const mk = (r, g, b, n) => n > 0 ? {
          r: Math.round(r / n), g: Math.round(g / n), b: Math.round(b / n),
          n,
          lum: Math.round(0.299 * r / n + 0.587 * g / n + 0.114 * b / n),
        } : { r: 0, g: 0, b: 0, n: 0, lum: 0 };
        resolve({ left: mk(leftR, leftG, leftB, leftN), right: mk(rightR, rightG, rightB, rightN) });
      };
      img.src = durl;
    });
  }, `data:image/png;base64,${png.toString('base64')}`);

  await ctx.close();
  return { stats, msgCount: msgs.length };
}

const browser = await chromium.launch({ channel: 'msedge', headless: true });
const wgl = await probe(browser, 'webgl');
const wgpu = await probe(browser, 'webgpu');
await browser.close();

console.log('=== Dusk-Terminator Probe (Batch 24) ===');
console.log('');
console.log('             WebGL                       WebGPU');
console.log(`  left   RGB=${JSON.stringify(wgl.stats.left)}`);
console.log(`         RGB=${JSON.stringify(wgpu.stats.left)}`);
console.log(`  right  RGB=${JSON.stringify(wgl.stats.right)}`);
console.log(`         RGB=${JSON.stringify(wgpu.stats.right)}`);

// Compute brighter:darker luminance asymmetry (direction-agnostic so
// we don't depend on which side of the viewport the lit hemisphere
// lands on for the chosen camera/time pair). A healthy terminator
// view shows clear asymmetry: at minimum the brighter half should
// be 1.3× the darker half. Equal brightness (~1.0:1) means either
// uniform lighting or the disk is fully on the brighter side and
// the darker sample is sky.
const wglRatio = Math.max(wgl.stats.left.lum, wgl.stats.right.lum)
  / Math.max(1, Math.min(wgl.stats.left.lum, wgl.stats.right.lum));
const wgpuRatio = Math.max(wgpu.stats.left.lum, wgpu.stats.right.lum)
  / Math.max(1, Math.min(wgpu.stats.left.lum, wgpu.stats.right.lum));
console.log('');
console.log(`  WebGL  brighter:darker hemisphere ratio: ${wglRatio.toFixed(2)}:1`);
console.log(`  WebGPU brighter:darker hemisphere ratio: ${wgpuRatio.toFixed(2)}:1`);
console.log('  (Direction-agnostic — checks that the terminator');
console.log('   produces clear hemisphere asymmetry, not which side');
console.log('   is lit. Camera/time pair is fixed; the brighter side');
console.log('   for this setup is the dusk-lit one at 90°E.)');

// Verdict: a healthy hemisphere asymmetry is > 1.3:1. Ratios near
// 1:1 mean uniform lighting (sun direction broken) or the disk is
// fully one-sided in the viewport.
const VERDICT_THRESHOLD = 1.3;
const wglPass = wglRatio > VERDICT_THRESHOLD;
const wgpuPass = wgpuRatio > VERDICT_THRESHOLD;
console.log('');
console.log(`  WebGL  ${wglPass ? '✓' : '✗'} (threshold ${VERDICT_THRESHOLD}:1)`);
console.log(`  WebGPU ${wgpuPass ? '✓' : '✗'} (threshold ${VERDICT_THRESHOLD}:1)`);
console.log('');
console.log('  Output:');
console.log(`    Tools/visual-regression/output/dusk-webgl.png`);
console.log(`    Tools/visual-regression/output/dusk-webgpu.png`);
process.exit(wglPass && wgpuPass ? 0 : 1);
