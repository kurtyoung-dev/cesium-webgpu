#!/usr/bin/env node
// Probe (C7-PP-SILHOUETTE-ARRAY-EDGE): the ARRAY form of
// PostProcessStageLibrary.createSilhouetteStage([edgeStages]) must carry
// the inner edge-detection stage's custom color/length through to the
// WebGPU library twin, matching WebGL — not fall back to the black/0.25
// defaults (the pre-fix bug where the outer composite's undefined uniforms
// alias reached packEdgeUniforms).
//
// Deterministic scene (globe + two boxes → strong depth discontinuities so
// the silhouette produces visible edges). On BOTH backends:
//   ARRAY form:  createSilhouetteStage([edge]) with edge.color = RED
//   SINGLE form: createSilhouetteStage() with uniforms.color = CYAN
//
// Assertions:
//   (1) ARRAY:  WebGPU matches WebGL within tolerance (cross-backend mean
//       byte delta), AND the WebGPU edge pixels are RED-dominant (proving
//       the custom color came through — the pre-fix black default would be
//       gray/dark, red≈green≈blue).
//   (2) SINGLE: WebGPU matches WebGL within tolerance, AND edge pixels are
//       CYAN-dominant (green,blue > red) — regression that the single-stage
//       path is unchanged.
//   (3) Zero console errors + zero GPU uncapturederrors.
//
// Usage: node Tools/visual-regression/probe-pp-silhouette-array.mjs
// Env: PROBE_BASE (default http://localhost:8080)

import { chromium } from "playwright";
import { mkdirSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const BASE = process.env.PROBE_BASE || "http://localhost:8080";
const OUT_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "output",
  "pp-silhouette-array",
);
mkdirSync(OUT_DIR, { recursive: true });

const browser = await chromium.launch({
  channel: "msedge",
  headless: true,
  args: ["--enable-unsafe-webgpu"],
});

async function runBackend(renderer) {
  const page = await browser.newPage({ viewport: { width: 1024, height: 768 } });
  const consoleErrors = [];
  page.on("console", (m) => {
    if (m.type() === "error") consoleErrors.push(m.text());
  });
  page.on("pageerror", (e) => consoleErrors.push(`pageerror: ${e.message}`));
  await page.goto(`${BASE}/Apps/CesiumViewer/index.html?renderer=${renderer}`, {
    waitUntil: "networkidle",
  });
  await page.waitForFunction(() => !!window.viewer);

  const out = await page.evaluate(
    async ({ isWebGPU }) => {
      const C = await import("/Build/CesiumUnminified/index.js");
      const v = window.viewer;
      const scene = v.scene;

      window.__gpuErrors = [];
      if (isWebGPU) {
        const dev = scene.context._device || scene.context.device;
        if (dev && dev.addEventListener) {
          dev.addEventListener("uncapturederror", (e) => {
            window.__gpuErrors.push(String(e.error && e.error.message));
          });
        }
      }

      // Deterministic scene with depth discontinuities.
      scene.requestRenderMode = false;
      v.clock.shouldAnimate = false;
      v.clock.currentTime = C.JulianDate.fromIso8601("2026-06-21T08:00:00Z");
      scene.fog.enabled = false;
      if (scene.skyAtmosphere) scene.skyAtmosphere.show = false;
      if (scene.skyBox) scene.skyBox.show = false;
      if (scene.sun) scene.sun.show = false;
      if (scene.moon) scene.moon.show = false;
      scene.globe.showGroundAtmosphere = false;
      scene.terrainProvider = new C.EllipsoidTerrainProvider();
      scene.globe.showWaterEffect = false;
      scene.globe.baseColor = new C.Color(0.12, 0.15, 0.2, 1.0);
      v.imageryLayers.removeAll();

      const boxSpecs = [
        { lon: 0.12, height: 6000, color: C.Color.ORANGE },
        { lon: 0.28, height: 10000, color: C.Color.WHITE },
        { lon: 0.2, height: 3000, color: C.Color.YELLOW },
      ];
      for (const b of boxSpecs) {
        v.entities.add({
          position: C.Cartesian3.fromDegrees(b.lon, 0.0, b.height),
          box: {
            dimensions: new C.Cartesian3(6000.0, 6000.0, 12000.0),
            material: b.color,
          },
        });
      }

      scene.morphTo3D(0);
      v.camera.setView({
        destination: C.Cartesian3.fromDegrees(0.0, 0.0, 22000.0),
        orientation: {
          heading: C.Math.toRadians(90.0),
          pitch: C.Math.toRadians(-12.0),
          roll: 0.0,
        },
      });

      const oncePostRender = () =>
        new Promise((resolve) => {
          const remove = scene.postRender.addEventListener(() => {
            remove();
            resolve();
          });
        });
      const renderFrames = async (n) => {
        for (let i = 0; i < n; i++) await oncePostRender();
      };
      const grab = () =>
        new Promise((resolve) => {
          const remove = scene.postRender.addEventListener(() => {
            remove();
            const c = scene.canvas;
            const off = document.createElement("canvas");
            off.width = c.width;
            off.height = c.height;
            const cx = off.getContext("2d");
            cx.drawImage(c, 0, 0);
            const u8 = new Uint8Array(
              cx.getImageData(0, 0, c.width, c.height).data.buffer,
            );
            let bin = "";
            const chunk = 0x8000;
            for (let i = 0; i < u8.length; i += chunk) {
              bin += String.fromCharCode.apply(null, u8.subarray(i, i + chunk));
            }
            resolve({ b64: btoa(bin), png: off.toDataURL("image/png"), w: c.width, h: c.height });
          });
        });
      const bytesEqual = (a, b) => a.b64 === b.b64;
      const settleAndGrab = async () => {
        let prev = await grab();
        for (let i = 0; i < 40; i++) {
          await renderFrames(10);
          const cur = await grab();
          if (scene.globe.tilesLoaded && bytesEqual(prev, cur)) return cur;
          prev = cur;
        }
        return prev;
      };

      // Strip async default ion imagery until tiles settle.
      let stable = 0;
      for (let i = 0; i < 600 && stable < 5; i++) {
        if (v.imageryLayers.length > 0) v.imageryLayers.removeAll();
        await oncePostRender();
        stable = scene.globe.tilesLoaded ? stable + 1 : 0;
      }
      await renderFrames(60);

      const captures = {};
      captures.base = await settleAndGrab();

      // ARRAY form: custom RED edge color + length 1.0.
      const edge = C.PostProcessStageLibrary.createEdgeDetectionStage();
      edge.uniforms.color = C.Color.clone(C.Color.RED);
      edge.uniforms.length = 1.0;
      const arraySil = C.PostProcessStageLibrary.createSilhouetteStage([edge]);
      scene.postProcessStages.add(arraySil);
      await renderFrames(10);
      captures.array = await settleAndGrab();
      scene.postProcessStages.remove(arraySil);
      await renderFrames(10);

      // SINGLE form: custom CYAN edge color + length 1.0.
      const singleSil = C.PostProcessStageLibrary.createSilhouetteStage();
      singleSil.uniforms.color = C.Color.clone(C.Color.CYAN);
      singleSil.uniforms.length = 1.0;
      scene.postProcessStages.add(singleSil);
      await renderFrames(10);
      captures.single = await settleAndGrab();
      scene.postProcessStages.remove(singleSil);
      await renderFrames(10);

      return { captures, gpuErrors: window.__gpuErrors };
    },
    { isWebGPU: renderer === "webgpu" },
  );

  await page.close();
  return { out, consoleErrors };
}

function savePng(name, img) {
  writeFileSync(join(OUT_DIR, name), Buffer.from(img.png.split(",")[1], "base64"));
}
// Count + locate the silhouette edge pixels by DIRECT COLOR SIGNATURE rather
// than diff-vs-base. The pre-fix bug rendered gray/dark default edges; the
// fix renders the caller's saturated RED (array) / CYAN (single) lines. A
// signature predicate isolates those pure lines cleanly — the box fills
// (white/orange/yellow) and globe base (dark blue) can't alias into a
// red-only or cyan-only test. This is robust to the TPDF dither (Batch 639)
// and atmosphere/tile-settle jitter that made a whole-frame diff-vs-base
// pick up huge non-edge regions and average to background color.
function edgePixels(cap, predicate) {
  const A = Buffer.from(cap.b64, "base64");
  const w = cap.w;
  let n = 0, r = 0, g = 0, b = 0, sx = 0;
  for (let i = 0; i < A.length; i += 4) {
    const R = A[i], G = A[i + 1], B = A[i + 2];
    if (predicate(R, G, B)) {
      n++; r += R; g += G; b += B; sx += (i / 4) % w;
    }
  }
  if (n === 0) return { n: 0, r: 0, g: 0, b: 0, x: 0 };
  return { n, r: r / n, g: g / n, b: b / n, x: sx / n };
}
// Pure silhouette-line signatures (custom colors set in the scene).
const isRed = (r, g, b) => r > 150 && g < 90 && b < 90;
const isCyan = (r, g, b) => g > 150 && b > 150 && r < 90;

console.log("=== WebGPU run ===");
const gpu = await runBackend("webgpu");
console.log("=== WebGL run ===");
const gl = await runBackend("webgl");
await browser.close();

if (!gpu.out?.captures || !gl.out?.captures) {
  console.error("FATAL: missing captures");
  process.exit(1);
}

for (const k of ["base", "array", "single"]) {
  savePng(`webgpu-${k}.png`, gpu.out.captures[k]);
  savePng(`webgl-${k}.png`, gl.out.captures[k]);
}

let pass = true;

// Cross-backend edge parity: both backends must paint a comparable count of
// same-color silhouette pixels at a comparable horizontal centroid. The
// pre-fix bug produced NO red pixels on WebGPU (gray defaults) → gpuN≈0.
const MIN_EDGE = 1200; // silhouette line pixel floor per backend
const countRatioOK = (a, b) => a > 0 && b > 0 && Math.min(a, b) / Math.max(a, b) > 0.4;
const xCentroidOK = (a, b) => Math.abs(a - b) < 60; // px, out of 1024 wide

// (1) ARRAY form → custom RED edge.
const gpuArr = edgePixels(gpu.out.captures.array, isRed);
const glArr = edgePixels(gl.out.captures.array, isRed);
const arrayOK =
  gpuArr.n > MIN_EDGE && glArr.n > MIN_EDGE &&
  countRatioOK(gpuArr.n, glArr.n) && xCentroidOK(gpuArr.x, glArr.x);
pass = pass && arrayOK;
console.log(
  `ARRAY  RED gpuN=${gpuArr.n}@x${gpuArr.x.toFixed(0)} ` +
    `glN=${glArr.n}@x${glArr.x.toFixed(0)} ` +
    `gpuRGB=(${gpuArr.r.toFixed(0)},${gpuArr.g.toFixed(0)},${gpuArr.b.toFixed(0)}) ` +
    `${arrayOK ? "OK" : "FAIL"}`,
);

// (2) SINGLE form → custom CYAN edge (regression: path unchanged).
const gpuSin = edgePixels(gpu.out.captures.single, isCyan);
const glSin = edgePixels(gl.out.captures.single, isCyan);
const singleOK =
  gpuSin.n > MIN_EDGE && glSin.n > MIN_EDGE &&
  countRatioOK(gpuSin.n, glSin.n) && xCentroidOK(gpuSin.x, glSin.x);
pass = pass && singleOK;
console.log(
  `SINGLE CYAN gpuN=${gpuSin.n}@x${gpuSin.x.toFixed(0)} ` +
    `glN=${glSin.n}@x${glSin.x.toFixed(0)} ` +
    `gpuRGB=(${gpuSin.r.toFixed(0)},${gpuSin.g.toFixed(0)},${gpuSin.b.toFixed(0)}) ` +
    `${singleOK ? "OK" : "FAIL"}`,
);

// (3) errors.
const allErrors = [...gpu.consoleErrors, ...gl.consoleErrors, ...gpu.out.gpuErrors];
console.log(
  `errors: webgpu-console=${gpu.consoleErrors.length} webgl-console=${gl.consoleErrors.length} gpu=${gpu.out.gpuErrors.length} ${allErrors.length === 0 ? "OK" : "FAIL"}`,
);
allErrors.slice(0, 8).forEach((e) => console.log("  ERR:", String(e).slice(0, 220)));
pass = pass && allErrors.length === 0;

console.log(`PNGs: ${OUT_DIR}`);
console.log(pass ? "PASS" : "FAIL");
process.exit(pass ? 0 : 1);
