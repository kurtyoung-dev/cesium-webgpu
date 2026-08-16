#!/usr/bin/env node
// Probe (NEW-BLOOM-UNIFORM-PARITY, Batch 240): bloom uniform parity
// between WebGL and WebGPU at DEFAULT `scene.postProcessStages.bloom`
// uniforms (contrast=128, brightness=-0.3, glowOnly=false, delta=1,
// sigma=2, stepSize=1).
// @purpose Bloom uniform-parity gate: default-uniform bloomed-fraction band vs WebGL, glowOnly + brightness response, stripped scene with synthetic sun.
// @status ACTIVE
//
// Pre-fix, the WebGPU sync layer fed WebGL's BRIGHTNESS (-0.3) into a
// luminance THRESHOLD — `max(color - (-0.3)*avgLum, 0)` passes every
// pixel, so default bloom bloomed the whole frame (measured 100% of
// pixels vs WebGL's ~0.1%). The fix ports the ContrastBias bright-pass
// (HSB brightness + contrast curve) to WGSL and maps all six uniforms
// through the configure path.
//
// Scene: a bright "sun" disk (white point primitive, backend-identical
// rendering) above the globe horizon, camera at 20 km altitude (below
// the 100 km altitude-gate floor, so the fork's orbit gate multiplier
// is exactly 1.0 — parity regime). Sky atmosphere / sun primitive /
// skybox / imagery are disabled because they render with KNOWN
// brightness divergence across backends (the WebGPU daytime sky is
// bright enough to legitimately pass the contrast/bias bright-pass,
// which would contaminate the parity metric — see the probe's first
// iteration in the Batch 240 debugging-log entry).
//
// Per backend, four in-postRender captures:
//   off      — bloom disabled (baseline)
//   defOn    — bloom enabled, DEFAULT uniforms
//   glowOnly — glowOnly = true
//   dimmed   — glowOnly = false, brightness = -0.9 (bright pass goes dark)
//
// Asserts:
//   (A) bloomed-pixel fraction (lum(defOn) - lum(off) > 12/255):
//       webgpu <= 2x webgl AND >= 0.2x webgl (tiny-slack when both
//       < 0.02%), and webgpu NOT "everything" (< 0.35 absolute).
//   (B) glowOnly responds (webgpu): >= 1% of pixels change by > 10 vs defOn.
//   (C) brightness responds (webgpu): >= 0.1% of pixels change by > 10 vs
//       defOn AND dimmed bloomed-fraction < 0.25x default bloomed-fraction.
//   (D) 0 console errors on both backends.
//
// Usage: node Tools/visual-regression/probe-bloom-parity.mjs
// Env:   PROBE_BASE (default http://localhost:8134)

import { chromium } from "playwright";
import { mkdirSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const BASE = process.env.PROBE_BASE || "http://localhost:8134";
const OUT_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "output",
  "bloom-parity",
);
mkdirSync(OUT_DIR, { recursive: true });

const browser = await chromium.launch({
  channel: "msedge",
  headless: true,
  args: ["--enable-unsafe-webgpu"],
});

async function runBackend(renderer) {
  const page = await browser.newPage({
    viewport: { width: 1024, height: 768 },
  });
  const errors = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  await page.goto(`${BASE}/Apps/CesiumViewer/index.html?renderer=${renderer}`, {
    waitUntil: "networkidle",
  });
  await page.waitForFunction(() => !!window.viewer);

  const out = await page.evaluate(async () => {
    const C = await import("/Build/CesiumUnminified/index.js");
    const v = window.viewer;
    const scene = v.scene;

    // CesiumViewer runs requestRenderMode=true — force continuous
    // renders so postRender fires every rAF; pin the clock for a
    // deterministic scene.
    scene.requestRenderMode = false;
    v.clock.shouldAnimate = false;
    v.clock.currentTime = C.JulianDate.fromIso8601("2026-06-21T12:00:00Z");

    // Strip every backend-divergent environment element: the WebGPU
    // sky atmosphere is bright enough at ground level to legitimately
    // pass the contrast/bias bright-pass while WebGL's is dark navy —
    // a separate parity issue that would dominate the bloom metric.
    // Solid-color globe (no imagery) removes tile-loading drift too.
    if (scene.skyAtmosphere) scene.skyAtmosphere.show = false;
    if (scene.sun) scene.sun.show = false;
    if (scene.moon) scene.moon.show = false;
    if (scene.skyBox) scene.skyBox.show = false;
    scene.fog.enabled = false;
    scene.globe.showGroundAtmosphere = false;
    v.imageryLayers.removeAll();
    scene.globe.baseColor = new C.Color(0.12, 0.15, 0.2, 1.0);
    // CesiumViewer loads world terrain (water mask) — at lat0/lon0 the
    // WebGL globe renders the bright animated ocean-wave effect while
    // WebGPU does not (divergent), so pin both to ellipsoid + waves off.
    scene.terrainProvider = new C.EllipsoidTerrainProvider();
    scene.globe.showWaterEffect = false;

    // Bright "sun": a 200 px white point — both backends render point
    // primitives identically (collection parity, Batches 226-232).
    // Camera at 20 km looking north, pitch -15°; the point sits ~78 km
    // ahead at 30 km altitude → ~22° above frame center, against space.
    const points = scene.primitives.add(new C.PointPrimitiveCollection());
    points.add({
      position: C.Cartesian3.fromDegrees(0.0, 0.7, 30000.0),
      color: C.Color.WHITE,
      pixelSize: 200,
      disableDepthTestDistance: Number.POSITIVE_INFINITY,
    });

    scene.morphTo3D(0);
    v.camera.setView({
      destination: C.Cartesian3.fromDegrees(0.0, 0.0, 20000.0),
      orientation: {
        heading: 0.0,
        pitch: C.Math.toRadians(-15.0),
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

    // Readback MUST happen inside scene.postRender (a WebGPU canvas
    // clears its texture on present).
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
          resolve({
            data: Array.from(
              new Uint8Array(
                cx.getImageData(0, 0, c.width, c.height).data.buffer,
              ),
            ),
            png: off.toDataURL("image/png"),
            w: c.width,
            h: c.height,
          });
        });
      });

    const bloom = scene.postProcessStages.bloom;
    bloom.enabled = false;

    // The CesiumViewer app adds its default ion imagery ASYNCHRONOUSLY
    // after viewer creation, so a single removeAll() races it (probe v2:
    // WebGL had loaded bright ocean imagery by capture time, WebGPU
    // hadn't — the diff metric measured imagery divergence, not bloom).
    // Strip layers every frame and wait until the solid-color globe is
    // fully tile-loaded + stable on BOTH backends before the baseline.
    let warmupFrames = 0;
    let stable = 0;
    for (let i = 0; i < 600 && stable < 5; i++) {
      if (v.imageryLayers.length > 0) v.imageryLayers.removeAll();
      await oncePostRender();
      warmupFrames++;
      stable = scene.globe.tilesLoaded ? stable + 1 : 0;
    }
    // `tilesLoaded` can report true during a terrain-provider swap
    // BEFORE the new tiles actually render (observed on the WebGPU
    // backend: the globe stayed black for ~25 more frames, then
    // appeared mid-capture-sequence and dominated every diff metric).
    // Wait until a globe-area pixel is actually non-black on screen.
    const sampleGlobeLum = () =>
      new Promise((resolve) => {
        const remove = scene.postRender.addEventListener(() => {
          remove();
          const c = scene.canvas;
          const off = document.createElement("canvas");
          off.width = c.width;
          off.height = c.height;
          const cx = off.getContext("2d");
          cx.drawImage(c, 0, 0);
          const px = cx.getImageData(
            Math.floor(c.width / 2),
            Math.floor(c.height * 0.75),
            1,
            1,
          ).data;
          resolve(0.2126 * px[0] + 0.7152 * px[1] + 0.0722 * px[2]);
        });
      });
    let globeVisible = 0;
    for (let i = 0; i < 240 && globeVisible < 3; i++) {
      const l = await sampleGlobeLum();
      warmupFrames++;
      globeVisible = l > 5 ? globeVisible + 1 : 0;
    }
    await renderFrames(10);
    const imgOff = await grab();

    bloom.enabled = true; // DEFAULT uniforms
    await renderFrames(10);
    const imgDefOn = await grab();

    bloom.uniforms.glowOnly = true;
    await renderFrames(8);
    const imgGlow = await grab();

    bloom.uniforms.glowOnly = false;
    bloom.uniforms.brightness = -0.9;
    await renderFrames(8);
    const imgDim = await grab();

    // Diagnostic: globe-area pixel (center, 75% down) from the baseline —
    // verifies the globe actually rendered (baseColor, not black) before
    // the off capture.
    const gi = 4 * (Math.floor(imgOff.h * 0.75) * imgOff.w + imgOff.w / 2);
    const globePixelOff = [
      imgOff.data[gi],
      imgOff.data[gi + 1],
      imgOff.data[gi + 2],
    ];

    return { imgOff, imgDefOn, imgGlow, imgDim, warmupFrames, globePixelOff };
  });

  await page.close();
  return { ...out, errors };
}

const lum = (d, i) => 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];

// Fraction of pixels whose luminance increased by > 12/255 from off -> on.
function bloomedFraction(off, on) {
  const n = off.w * off.h;
  let count = 0;
  for (let p = 0; p < n; p++) {
    if (lum(on.data, 4 * p) - lum(off.data, 4 * p) > 12) count++;
  }
  return count / n;
}

// Fraction of pixels differing by > 10 in any channel.
function changedFraction(a, b) {
  const n = a.w * a.h;
  let count = 0;
  for (let p = 0; p < n; p++) {
    const i = 4 * p;
    if (
      Math.abs(a.data[i] - b.data[i]) > 10 ||
      Math.abs(a.data[i + 1] - b.data[i + 1]) > 10 ||
      Math.abs(a.data[i + 2] - b.data[i + 2]) > 10
    ) {
      count++;
    }
  }
  return count / n;
}

function savePng(name, img) {
  writeFileSync(
    join(OUT_DIR, name),
    Buffer.from(img.png.split(",")[1], "base64"),
  );
}

console.log("=== WebGL pass ===");
const gl = await runBackend("webgl");
console.log("=== WebGPU pass ===");
const gpu = await runBackend("webgpu");

for (const [tag, r] of [
  ["webgl", gl],
  ["webgpu", gpu],
]) {
  savePng(`${tag}-off.png`, r.imgOff);
  savePng(`${tag}-default-on.png`, r.imgDefOn);
  savePng(`${tag}-glow-only.png`, r.imgGlow);
  savePng(`${tag}-brightness-dim.png`, r.imgDim);
  console.log(
    `${tag}: canvas ${r.imgOff.w}x${r.imgOff.h}, warmup ${r.warmupFrames} frames, ` +
      `globe pixel (off) rgb(${r.globePixelOff.join(",")}), console errors: ${r.errors.length}`,
  );
}

const glFrac = bloomedFraction(gl.imgOff, gl.imgDefOn);
const gpuFrac = bloomedFraction(gpu.imgOff, gpu.imgDefOn);
const gpuDimFrac = bloomedFraction(gpu.imgOff, gpu.imgDim);
const glowChanged = changedFraction(gpu.imgDefOn, gpu.imgGlow);
const dimChanged = changedFraction(gpu.imgDefOn, gpu.imgDim);
const glGlowChanged = changedFraction(gl.imgDefOn, gl.imgGlow);

// (A) default-uniform parity band. Tiny-slack: if neither backend
// blooms more than 0.02% of the frame the ratio is pure noise.
const bothTiny = glFrac < 0.0002 && gpuFrac < 0.0002;
const aOK =
  gpuFrac < 0.35 &&
  (bothTiny || (gpuFrac <= 2.0 * glFrac && gpuFrac >= 0.2 * glFrac));
// (B) glowOnly responds on webgpu (frame collapses to glow-only —
// the whole globe blacks out, so the change is large).
const bOK = glowChanged > 0.01;
// (C) brightness responds on webgpu (halo-sized delta + directional:
// a -0.9 brightness shift kills even white pixels in the bright pass).
const cOK = dimChanged > 0.001 && gpuDimFrac < 0.25 * Math.max(gpuFrac, 1e-9);
// (D) zero console errors.
const dOK = gl.errors.length === 0 && gpu.errors.length === 0;

const pct = (x) => `${(100 * x).toFixed(3)}%`;
console.log(
  `(A) default-uniform bloomed-pixel fraction: webgl=${pct(glFrac)} webgpu=${pct(gpuFrac)} ` +
    `(ratio ${(gpuFrac / Math.max(glFrac, 1e-9)).toFixed(2)}x, band [0.2x, 2x], abs cap 35%) ${aOK ? "OK" : "FAIL"}`,
);
console.log(
  `(B) glowOnly responds (webgpu): ${pct(glowChanged)} of pixels changed >10 ` +
    `(threshold 1%; webgl same toggle: ${pct(glGlowChanged)}) ${bOK ? "OK" : "FAIL"}`,
);
console.log(
  `(C) brightness=-0.9 responds (webgpu): ${pct(dimChanged)} pixels changed >10 (threshold 0.1%), ` +
    `bloomed fraction ${pct(gpuDimFrac)} < 0.25x default ${pct(gpuFrac)} ${cOK ? "OK" : "FAIL"}`,
);
console.log(
  `(D) console errors: webgl=${gl.errors.length} webgpu=${gpu.errors.length} ${dOK ? "OK" : "FAIL"}`,
);
[...gl.errors, ...gpu.errors]
  .slice(0, 8)
  .forEach((e) => console.log("  ERR:", e.slice(0, 250)));

console.log(`PNGs: ${OUT_DIR}`);
const pass = aOK && bOK && cOK && dOK;
console.log(pass ? "PASS" : "FAIL");
await browser.close();
process.exit(pass ? 0 : 1);
