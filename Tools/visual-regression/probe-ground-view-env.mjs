#!/usr/bin/env node
// Probe (NEW-GROUND-VIEW-ENV-DIVERGENCES, Batch 247): three cross-backend
// environment divergences at deterministic ground-level views, each measured
// numerically against the WebGL reference render of the SAME scene:
//
//   (1) Ground-level daytime SKY-ATMOSPHERE brightness. Pre-fix the WebGPU
//       sky shader took the inscatter-LUT fast path whose 2D bake encodes
//       the WORLD-space sun direction in a synthetic Y-up frame (no
//       view-sun azimuth dependence either), rendering a frame-filling
//       bright-blue sky where WebGL renders dark navy. Metric: mean RGB /
//       max-channel (HSB value) over the top sky band, webgpu/webgl ratio.
//   (2) SUN primitive at a ground-level sun-aimed view. Pre-fix the WebGPU
//       sun command entered frameState.commandList (binned BEFORE the
//       injected skyAtmosphere command), so the alpha-over atmosphere
//       shell (alpha ~= 1 at ground level) overwrote the sun disk. The
//       atmosphere-off control shows the disk on both backends; the
//       atmosphere-on capture loses it on WebGPU only. Metric: count of
//       bright (lum > 180) pixels within 180 px of frame center, with the
//       camera aimed exactly at the computed sun direction.
//   (3) No-imagery globe BASE COLOR. Pre-fix GlobeTerrain.wgsl hardcoded
//       vec3(0.04, 0.04, 0.06) (= rgb(10,10,15)) instead of consuming
//       globe.baseColor — NOT an sRGB issue. Metric: exact globe-area
//       pixel RGB vs the configured baseColor (0.12, 0.15, 0.2) =
//       rgb(31, 38, 51).
//
// Asserts:
//   (1) sky mean-luminance ratio webgpu/webgl in [0.8, 1.25] AND sky
//       max-channel (value) ratio in [0.8, 1.25] (post-fix measured
//       0.99x / 0.99x; pre-fix 1.73x / 1.46x).
//   (2) webgpu sun bright-pixel count (atmosphere ON) >= 0.25x webgl AND
//       > 50 absolute; control (atmosphere OFF) > 50 on both.
//   (3) webgpu globe pixel within ±3/channel of webgl AND of expected
//       rgb(31, 38, 51).
//   (4) 0 console errors on both backends.
//
// Usage: node Tools/visual-regression/probe-ground-view-env.mjs
// Env:   PROBE_BASE (default http://localhost:8134)

import { chromium } from "playwright";
import { mkdirSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const BASE = process.env.PROBE_BASE || "http://localhost:8134";
const OUT_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "output",
  "ground-view-env",
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

    // Deterministic scene: continuous renders, pinned clock (sun fixed).
    scene.requestRenderMode = false;
    v.clock.shouldAnimate = false;
    v.clock.currentTime = C.JulianDate.fromIso8601("2026-06-21T09:00:00Z");

    // Strip everything backend-divergent for the baseline; scenarios
    // re-enable individual elements one at a time.
    if (scene.skyAtmosphere) scene.skyAtmosphere.show = false;
    if (scene.sun) scene.sun.show = false;
    if (scene.moon) scene.moon.show = false;
    if (scene.skyBox) scene.skyBox.show = false;
    scene.fog.enabled = false;
    scene.globe.showGroundAtmosphere = false;
    v.imageryLayers.removeAll();
    scene.globe.baseColor = new C.Color(0.12, 0.15, 0.2, 1.0);
    scene.terrainProvider = new C.EllipsoidTerrainProvider();
    scene.globe.showWaterEffect = false;

    scene.morphTo3D(0);
    v.camera.setView({
      destination: C.Cartesian3.fromDegrees(0.0, 0.0, 20000.0),
      orientation: { heading: 0.0, pitch: C.Math.toRadians(-15.0), roll: 0.0 },
    });

    const oncePostRender = () =>
      new Promise((resolve) => {
        const remove = scene.postRender.addEventListener(() => {
          remove();
          resolve();
        });
      });
    const renderFrames = async (n) => {
      for (let i = 0; i < n; i++) {
        // The CesiumViewer app adds its default ion imagery ASYNCHRONOUSLY
        // after viewer creation — keep stripping (Batch 240 gotcha).
        if (v.imageryLayers.length > 0) v.imageryLayers.removeAll();
        await oncePostRender();
      }
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

    // ─── Warmup: solid-color globe loaded + visibly rendering ───
    let warmupFrames = 0;
    let stable = 0;
    for (let i = 0; i < 600 && stable < 5; i++) {
      await renderFrames(1);
      warmupFrames++;
      stable = scene.globe.tilesLoaded ? stable + 1 : 0;
    }
    // tilesLoaded goes true during the terrain-provider swap before tiles
    // actually render on WebGPU (Batch 240 gotcha) — wait for a non-black
    // globe-area pixel.
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

    // ─── Scenario 3: no-imagery globe baseColor ───
    const imgBase = await grab();
    const gi = 4 * (Math.floor(imgBase.h * 0.75) * imgBase.w + imgBase.w / 2);
    const baseColorPixel = [
      imgBase.data[gi],
      imgBase.data[gi + 1],
      imgBase.data[gi + 2],
    ];

    // ─── Scenario 1: ground-level daytime sky-atmosphere ───
    // Camera 3 km up, pitched +20° — the sky fills the upper frame.
    if (scene.skyAtmosphere) scene.skyAtmosphere.show = true;
    v.camera.setView({
      destination: C.Cartesian3.fromDegrees(0.0, 0.0, 3000.0),
      orientation: { heading: 0.0, pitch: C.Math.toRadians(20.0), roll: 0.0 },
    });
    await renderFrames(25);
    const imgSky = await grab();
    // Mean RGB over the top sky band (y < 20% of height).
    let sr = 0,
      sg = 0,
      sb = 0,
      sn = 0;
    const bandH = Math.floor(imgSky.h * 0.2);
    for (let y = 0; y < bandH; y++) {
      for (let x = 0; x < imgSky.w; x += 4) {
        const i = 4 * (y * imgSky.w + x);
        sr += imgSky.data[i];
        sg += imgSky.data[i + 1];
        sb += imgSky.data[i + 2];
        sn++;
      }
    }
    const skyMean = [sr / sn, sg / sn, sb / sn];
    const skyValue = Math.max(...skyMean) / 255; // HSB value of the mean
    const skyLum =
      (0.2126 * skyMean[0] + 0.7152 * skyMean[1] + 0.0722 * skyMean[2]) / 255;

    // ─── Scenario 2: sun disk at a ground-level sun-aimed view ───
    // Compute the sun's ENU heading/elevation at the camera location and
    // aim the camera exactly at it — deterministic disk-at-frame-center.
    const camPos = C.Cartesian3.fromDegrees(0.0, 0.0, 3000.0);
    const sunWC = scene.context.uniformState.sunPositionWC;
    const toSun = C.Cartesian3.normalize(
      C.Cartesian3.subtract(sunWC, camPos, new C.Cartesian3()),
      new C.Cartesian3(),
    );
    const enu = C.Transforms.eastNorthUpToFixedFrame(camPos);
    const invEnu = C.Matrix4.inverseTransformation(enu, new C.Matrix4());
    const dEnu = C.Matrix4.multiplyByPointAsVector(
      invEnu,
      toSun,
      new C.Cartesian3(),
    );
    const sunElevationRad = Math.asin(dEnu.z / C.Cartesian3.magnitude(dEnu));
    const sunHeadingRad = Math.atan2(dEnu.x, dEnu.y); // east-of-north

    if (scene.sun) scene.sun.show = true;
    v.camera.setView({
      destination: camPos,
      orientation: {
        heading: sunHeadingRad,
        pitch: sunElevationRad,
        roll: 0.0,
      },
    });
    await renderFrames(25);
    const imgSunAtmoOn = await grab();

    // Control: atmosphere OFF — isolates "sun missing entirely" from
    // "sun hidden behind the atmosphere layer".
    if (scene.skyAtmosphere) scene.skyAtmosphere.show = false;
    await renderFrames(15);
    const imgSunAtmoOff = await grab();

    const sunMetrics = (img) => {
      const cxp = img.w / 2;
      const cyp = img.h / 2;
      let bright = 0;
      let maxLum = 0;
      for (let y = 0; y < img.h; y++) {
        for (let x = 0; x < img.w; x++) {
          const dx = x - cxp;
          const dy = y - cyp;
          if (dx * dx + dy * dy > 180 * 180) continue;
          const i = 4 * (y * img.w + x);
          const l =
            0.2126 * img.data[i] +
            0.7152 * img.data[i + 1] +
            0.0722 * img.data[i + 2];
          if (l > maxLum) maxLum = l;
          if (l > 180) bright++;
        }
      }
      return { bright, maxLum: Math.round(maxLum) };
    };

    return {
      imgBase,
      imgSky,
      imgSunAtmoOn,
      imgSunAtmoOff,
      baseColorPixel,
      skyMean: skyMean.map((x) => Math.round(x * 10) / 10),
      skyValue: Math.round(skyValue * 1000) / 1000,
      skyLum: Math.round(skyLum * 1000) / 1000,
      sunOn: sunMetrics(imgSunAtmoOn),
      sunOff: sunMetrics(imgSunAtmoOff),
      sunElevationDeg: Math.round((sunElevationRad * 180) / Math.PI),
      sunHeadingDeg: Math.round((sunHeadingRad * 180) / Math.PI),
      warmupFrames,
    };
  });

  await page.close();
  return { ...out, errors };
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
  savePng(`${tag}-basecolor.png`, r.imgBase);
  savePng(`${tag}-sky.png`, r.imgSky);
  savePng(`${tag}-sun-atmo-on.png`, r.imgSunAtmoOn);
  savePng(`${tag}-sun-atmo-off.png`, r.imgSunAtmoOff);
  console.log(
    `${tag}: warmup ${r.warmupFrames}f | basePixel rgb(${r.baseColorPixel.join(",")}) | ` +
      `sky mean rgb(${r.skyMean.join(",")}) value=${r.skyValue} lum=${r.skyLum} | ` +
      `sun elev=${r.sunElevationDeg}° hdg=${r.sunHeadingDeg}° ` +
      `atmoOn{bright=${r.sunOn.bright} max=${r.sunOn.maxLum}} ` +
      `atmoOff{bright=${r.sunOff.bright} max=${r.sunOff.maxLum}} | errors=${r.errors.length}`,
  );
}

// (1) sky brightness parity band (post-fix: 0.99x / 0.99x)
const lumRatio = gpu.skyLum / Math.max(gl.skyLum, 1e-6);
const valRatio = gpu.skyValue / Math.max(gl.skyValue, 1e-6);
const sky1OK =
  lumRatio >= 0.8 && lumRatio <= 1.25 && valRatio >= 0.8 && valRatio <= 1.25;
// (2) sun disk present at the atmosphere-on sun-aimed view
const sunCtrlOK = gl.sunOff.bright > 50 && gpu.sunOff.bright > 50;
const sun2OK =
  sunCtrlOK &&
  gpu.sunOn.bright > 50 &&
  gpu.sunOn.bright >= 0.25 * gl.sunOn.bright;
// (3) baseColor exact
const expected = [31, 38, 51];
const within = (a, b, tol) => a.every((x, i) => Math.abs(x - b[i]) <= tol);
const base3OK =
  within(gpu.baseColorPixel, gl.baseColorPixel, 3) &&
  within(gpu.baseColorPixel, expected, 3);
// (4) zero console errors
const errOK = gl.errors.length === 0 && gpu.errors.length === 0;

console.log(
  `(1) sky brightness ratio webgpu/webgl: lum ${lumRatio.toFixed(2)}x, ` +
    `value ${valRatio.toFixed(2)}x (band [0.8, 1.25]) ${sky1OK ? "OK" : "FAIL"}`,
);
console.log(
  `(2) sun disk (atmo ON): webgl bright=${gl.sunOn.bright} webgpu bright=${gpu.sunOn.bright} ` +
    `(need webgpu >= max(50, 0.25x webgl); control atmo OFF webgl=${gl.sunOff.bright} ` +
    `webgpu=${gpu.sunOff.bright}) ${sun2OK ? "OK" : "FAIL"}`,
);
console.log(
  `(3) baseColor: webgl rgb(${gl.baseColorPixel.join(",")}) webgpu rgb(${gpu.baseColorPixel.join(",")}) ` +
    `expected rgb(${expected.join(",")}) ±3 ${base3OK ? "OK" : "FAIL"}`,
);
console.log(
  `(4) console errors: webgl=${gl.errors.length} webgpu=${gpu.errors.length} ${errOK ? "OK" : "FAIL"}`,
);
[...gl.errors, ...gpu.errors]
  .slice(0, 8)
  .forEach((e) => console.log("  ERR:", e.slice(0, 250)));

console.log(`PNGs: ${OUT_DIR}`);
const pass = sky1OK && sun2OK && base3OK && errOK;
console.log(pass ? "PASS" : "FAIL");
await browser.close();
process.exit(pass ? 0 : 1);
