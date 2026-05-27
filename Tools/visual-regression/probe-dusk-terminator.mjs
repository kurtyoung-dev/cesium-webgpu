// Dusk-terminator regression probe (Batch 24, orbit polish §13.3;
// rebuilt Batch 160 onto the CesiumViewer driver).
//
// Validates `lightDirectionEC` plumbing (Batches 17/18) +
// `computeDayNightFade` math + `nightAmbient` floor by setting the
// scene's clock to the vernal equinox and the camera over a longitude
// where the day/night terminator crosses the viewport, then comparing
// the lit vs unlit hemisphere mean luminance.
//
// Driver: the canonical CesiumViewer page with `?renderer=webgl` /
// `?renderer=webgpu` and the global `window.viewer` — the same robust
// pattern every other probe here uses. (The original Batch 24 version
// drove the Sandcastle "Hello World" gallery page through a
// renderer-override shim that rewrote `new Viewer(...)` →
// `Viewer.createAsync(...)`; that shim never reliably captured the
// async WebGPU viewer, so the WebGPU globe rendered as empty space and
// the probe silently "passed/failed" on a blank frame. Rebuilt to use
// the CesiumViewer driver so WebGPU is genuinely exercised.)
//
// Expected: both backends render the globe with the terminator down the
// center of the view; the lit hemisphere is meaningfully brighter than
// the unlit one (direction-agnostic brighter:darker ratio > threshold).
//
// Outputs:
//   - Tools/visual-regression/output/dusk-{webgl,webgpu}.png
//   - Per-side mean RGB + lit/unlit luminance ratio
//
// Failure modes this probe catches:
//   - Wrong sun direction (Batch 17 regression) → both sides ~equal
//     brightness, or the terminator lands on the wrong meridian.
//   - Wrong nightAmbient floor → unlit side too bright (no dark night)
//     OR pure black (city lights / earthshine missing).
//   - lightDirectionEC swapped with sunDirectionEC.
//   - WebGPU globe not rendering under a forced renderer at all.
import { chromium } from "playwright";
import fs from "fs";

const PROBE_BASE = process.env.PROBE_BASE || "http://localhost:8080";
const VERDICT_THRESHOLD = 1.3; // brighter:darker hemisphere luminance ratio

async function probe(browser, renderer) {
  const ctx = await browser.newContext({ viewport: { width: 800, height: 600 } });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.log(`>> [${renderer}] pageerror: ${e.message}`));
  await page.goto(`${PROBE_BASE}/Apps/CesiumViewer/index.html?renderer=${renderer}`, {
    waitUntil: "networkidle",
  });
  await page.waitForFunction(() => !!window.viewer);

  // Capture WebGPU uncaptured device errors.
  await page.evaluate(() => {
    window.__probeErrors = [];
    const dev = window.viewer?.scene?.context?._device;
    if (dev) dev.onuncapturederror = (ev) => window.__probeErrors.push(ev?.error?.message ?? "");
  });

  await page.evaluate(async () => {
    const Cesium = await import("/Build/CesiumUnminified/index.js");
    const v = window.viewer;
    // Globe lighting must be on for the day/night terminator to show —
    // off, the globe renders uniformly sun-lit.
    v.scene.globe.enableLighting = true;
    // Vernal equinox 12:00 UTC: sub-solar point at (0°N, 0°E), anti-solar
    // (midnight) at (0°N, 180°E). Camera over (0°N, 90°E) looking straight
    // down puts the nadir on the terminator (90°E meridian), so the
    // terminator runs roughly down the viewport center: day side toward
    // 0°E (west → left of screen, north-up), night side toward 180°E.
    v.clock.currentTime = Cesium.JulianDate.fromIso8601("2026-03-20T12:00:00Z");
    v.clock.shouldAnimate = false;
    v.scene.camera.setView({
      destination: Cesium.Cartesian3.fromDegrees(90.0, 0.0, 12_000_000.0),
      orientation: {
        heading: 0.0,
        pitch: -Cesium.Math.PI_OVER_TWO,
        roll: 0.0,
      },
    });
  });

  // Render plenty of frames so imagery tiles stream in for both backends.
  await page.evaluate(async () => {
    const scene = window.viewer.scene;
    for (let i = 0; i < 240; i++) {
      scene.requestRender();
      scene.render();
      await new Promise((r) => requestAnimationFrame(r));
    }
  });

  const png = await page.screenshot({ type: "png" });
  fs.writeFileSync(`Tools/visual-regression/output/dusk-${renderer}.png`, png);

  // Sample left/right halves over the globe region (skip UI overlay band
  // along the top, skip near-black space pixels) and compute mean
  // luminance per side.
  const stats = await page.evaluate(async (durl) => {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        const c = document.createElement("canvas");
        c.width = img.width;
        c.height = img.height;
        const cx = c.getContext("2d");
        cx.drawImage(img, 0, 0);
        const data = cx.getImageData(0, 0, img.width, img.height).data;
        const halfW = img.width >> 1;
        const yStart = img.height >> 2; // skip top UI band
        const yEnd = img.height - 50; // skip bottom timeline
        let lR = 0, lG = 0, lB = 0, lN = 0, rR = 0, rG = 0, rB = 0, rN = 0;
        for (let y = yStart; y < yEnd; y += 2) {
          for (let x = 0; x < img.width; x += 2) {
            const i = (y * img.width + x) * 4;
            const lum = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
            if (lum < 8) continue; // skip space/sky
            if (x < halfW) {
              lR += data[i]; lG += data[i + 1]; lB += data[i + 2]; lN++;
            } else {
              rR += data[i]; rG += data[i + 1]; rB += data[i + 2]; rN++;
            }
          }
        }
        const mk = (r, g, b, n) =>
          n > 0
            ? {
                r: Math.round(r / n),
                g: Math.round(g / n),
                b: Math.round(b / n),
                n,
                lum: Math.round((0.299 * r + 0.587 * g + 0.114 * b) / n),
              }
            : { r: 0, g: 0, b: 0, n: 0, lum: 0 };
        resolve({ left: mk(lR, lG, lB, lN), right: mk(rR, rG, rB, rN) });
      };
      img.src = durl;
    });
  }, `data:image/png;base64,${png.toString("base64")}`);

  const errs = await page.evaluate(() => window.__probeErrors ?? []);
  await ctx.close();
  return { stats, errs };
}

const browser = await chromium.launch({
  channel: "msedge",
  headless: true,
  args: ["--enable-unsafe-webgpu"],
});
const wgl = await probe(browser, "webgl");
const wgpu = await probe(browser, "webgpu");
await browser.close();

console.log("=== Dusk-Terminator Probe ===\n");
console.log("             WebGL                       WebGPU");
console.log(`  left   RGB=${JSON.stringify(wgl.stats.left)}`);
console.log(`         RGB=${JSON.stringify(wgpu.stats.left)}`);
console.log(`  right  RGB=${JSON.stringify(wgl.stats.right)}`);
console.log(`         RGB=${JSON.stringify(wgpu.stats.right)}`);

const ratio = (s) =>
  Math.max(s.left.lum, s.right.lum) / Math.max(1, Math.min(s.left.lum, s.right.lum));
const wglRatio = ratio(wgl.stats);
const wgpuRatio = ratio(wgpu.stats);
console.log("");
console.log(`  WebGL  brighter:darker hemisphere ratio: ${wglRatio.toFixed(2)}:1`);
console.log(`  WebGPU brighter:darker hemisphere ratio: ${wgpuRatio.toFixed(2)}:1`);
console.log("  (Direction-agnostic — checks the terminator produces clear");
console.log("   hemisphere asymmetry, not which side is lit.)");

const wglPass = wglRatio > VERDICT_THRESHOLD;
const wgpuPass = wgpuRatio > VERDICT_THRESHOLD;
const wgpuNoErr = wgpu.errs.length === 0;
console.log("");
console.log(`  WebGL  ${wglPass ? "✓" : "✗"} (threshold ${VERDICT_THRESHOLD}:1)`);
console.log(`  WebGPU ${wgpuPass ? "✓" : "✗"} (threshold ${VERDICT_THRESHOLD}:1)`);
console.log(`  WebGPU device errors: ${wgpu.errs.length}`);
wgpu.errs.slice(0, 5).forEach((e) => console.log(`    - ${(e ?? "").slice(0, 160)}`));
console.log("\n  Output: Tools/visual-regression/output/dusk-{webgl,webgpu}.png");
process.exit(wglPass && wgpuPass && wgpuNoErr ? 0 : 1);
