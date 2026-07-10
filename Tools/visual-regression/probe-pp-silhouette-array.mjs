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

const CROSS_TOL = 14; // cross-backend mean byte delta

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
function diffImgs(a, b) {
  const A = Buffer.from(a.b64, "base64");
  const B = Buffer.from(b.b64, "base64");
  if (A.length !== B.length) return { fracDiff: 1, meanDelta: 255, diffBytes: -1 };
  let diffBytes = 0, maxDelta = 0, sum = 0;
  for (let i = 0; i < A.length; i++) {
    const d = Math.abs(A[i] - B[i]);
    if (d > 0) diffBytes++;
    if (d > maxDelta) maxDelta = d;
    sum += d;
  }
  return { diffBytes, maxDelta, meanDelta: sum / A.length, fracDiff: diffBytes / A.length };
}
// Mean RGB over pixels whose color changed vs the base capture (the edge
// pixels the silhouette painted).
function edgeMeanColor(cap, base) {
  const A = Buffer.from(cap.b64, "base64");
  const Bb = Buffer.from(base.b64, "base64");
  let n = 0, r = 0, g = 0, b = 0;
  for (let i = 0; i < A.length; i += 4) {
    const dr = Math.abs(A[i] - Bb[i]);
    const dg = Math.abs(A[i + 1] - Bb[i + 1]);
    const db = Math.abs(A[i + 2] - Bb[i + 2]);
    if (dr + dg + db > 40) {
      n++; r += A[i]; g += A[i + 1]; b += A[i + 2];
    }
  }
  if (n === 0) return { n: 0, r: 0, g: 0, b: 0 };
  return { n, r: r / n, g: g / n, b: b / n };
}

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

// (1) ARRAY form.
const arrayX = diffImgs(gpu.out.captures.array, gl.out.captures.array);
const arrayMatch = arrayX.meanDelta <= CROSS_TOL;
const gpuArrEdge = edgeMeanColor(gpu.out.captures.array, gpu.out.captures.base);
const glArrEdge = edgeMeanColor(gl.out.captures.array, gl.out.captures.base);
// RED dominance: red channel clearly above green & blue in edge pixels.
const gpuArrRed = gpuArrEdge.r > gpuArrEdge.g + 25 && gpuArrEdge.r > gpuArrEdge.b + 25;
const glArrRed = glArrEdge.r > glArrEdge.g + 25 && glArrEdge.r > glArrEdge.b + 25;
const arrayOK = arrayMatch && gpuArrRed && glArrRed && gpuArrEdge.n > 2000;
pass = pass && arrayOK;
console.log(
  `ARRAY  xMean=${arrayX.meanDelta.toFixed(2)}(tol ${CROSS_TOL}) ` +
    `gpuEdge rgb=(${gpuArrEdge.r.toFixed(0)},${gpuArrEdge.g.toFixed(0)},${gpuArrEdge.b.toFixed(0)}) n=${gpuArrEdge.n} ` +
    `glEdge rgb=(${glArrEdge.r.toFixed(0)},${glArrEdge.g.toFixed(0)},${glArrEdge.b.toFixed(0)}) ` +
    `redDom gpu=${gpuArrRed ? "Y" : "N"}/gl=${glArrRed ? "Y" : "N"} ${arrayOK ? "OK" : "FAIL"}`,
);

// (2) SINGLE form.
const singleX = diffImgs(gpu.out.captures.single, gl.out.captures.single);
const singleMatch = singleX.meanDelta <= CROSS_TOL;
const gpuSinEdge = edgeMeanColor(gpu.out.captures.single, gpu.out.captures.base);
const glSinEdge = edgeMeanColor(gl.out.captures.single, gl.out.captures.base);
// CYAN dominance: green & blue clearly above red.
const gpuSinCyan = gpuSinEdge.g > gpuSinEdge.r + 25 && gpuSinEdge.b > gpuSinEdge.r + 25;
const glSinCyan = glSinEdge.g > glSinEdge.r + 25 && glSinEdge.b > glSinEdge.r + 25;
const singleOK = singleMatch && gpuSinCyan && glSinCyan && gpuSinEdge.n > 2000;
pass = pass && singleOK;
console.log(
  `SINGLE xMean=${singleX.meanDelta.toFixed(2)}(tol ${CROSS_TOL}) ` +
    `gpuEdge rgb=(${gpuSinEdge.r.toFixed(0)},${gpuSinEdge.g.toFixed(0)},${gpuSinEdge.b.toFixed(0)}) n=${gpuSinEdge.n} ` +
    `glEdge rgb=(${glSinEdge.r.toFixed(0)},${glSinEdge.g.toFixed(0)},${glSinEdge.b.toFixed(0)}) ` +
    `cyanDom gpu=${gpuSinCyan ? "Y" : "N"}/gl=${glSinCyan ? "Y" : "N"} ${singleOK ? "OK" : "FAIL"}`,
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
