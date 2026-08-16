// Probe — Batch 77 VERTEX_LIGHTING path verification.
// @purpose Smoke-verifies the globe VERTEX_LIGHTING path with world-terrain vertex normals; lambertDiffuseMultiplier must visibly move the canvas.
// @status ACTIVE
//
// Loads CesiumViewer with WebGPU, enables `globe.enableLighting = true`,
// swaps to Cesium World Terrain with `requestVertexNormals: true`, and
// captures a midlat view. The Lambert path inside GlobeTerrain.wgsl
// branches on `camera.lighting.z > 0.5` (hasVertexNormals flag). When
// the branch is taken the diffuse formula becomes
//   `clamp(NdotL * lambertDiffuseMultiplier + vertexShadowDarkness, 0, 1)`
// matching WebGL ENABLE_VERTEX_LIGHTING.
//
// This probe does NOT pixel-compare against WebGL — driver-level
// numerical drift dominates at high contrast (see Batch 64). The probe
// just confirms:
//   1. The page loads without console errors after the new code path
//      is exercised (vertex normals + lighting on).
//   2. A non-trivial scene renders (canvas isn't all-black / all-white).
//   3. Setting `globe.lambertDiffuseMultiplier` to an out-of-default
//      value visibly changes the canvas (proves the uniform reaches
//      the shader).
//
// Run with: node Tools/visual-regression/probe-vertex-lighting.mjs

import { chromium } from "playwright";
import fs from "node:fs";

const OUTPUT_DIR = "Tools/visual-regression/output";
fs.mkdirSync(OUTPUT_DIR, { recursive: true });

const URL =
  "http://localhost:8080/Apps/CesiumViewer/index.html?renderer=webgpu";

async function captureWithLightingConfig(multiplier) {
  const browser = await chromium.launch({ channel: "msedge", headless: true });
  const ctx = await browser.newContext({
    viewport: { width: 1280, height: 720 },
  });
  const page = await ctx.newPage();
  const consoleErrors = [];
  page.on("console", (m) => {
    if (m.type() === "error") consoleErrors.push(m.text());
  });
  page.on("pageerror", (e) => consoleErrors.push(`pageerror: ${e.message}`));

  await page.goto(URL, { waitUntil: "load", timeout: 60000 });
  await page.waitForFunction(() => !!window.viewer, { timeout: 30000 });

  // Switch terrain provider to one with vertex normals; enable lighting.
  await page.evaluate(
    async ({ multiplier }) => {
      const C = await import("/Build/CesiumUnminified/index.js");
      const v = window.viewer;
      v.scene.globe.enableLighting = true;
      v.scene.globe.lambertDiffuseMultiplier = multiplier;
      v.scene.globe.vertexShadowDarkness = 0.3;
      try {
        const tp = await C.createWorldTerrainAsync({
          requestVertexNormals: true,
        });
        v.scene.globe.terrainProvider = tp;
      } catch (e) {
        console.error("terrain swap failed:", e.message);
      }
      // Camera at a midlat view so terrain lighting is clearly visible.
      v.camera.setView({
        destination: C.Cartesian3.fromDegrees(-122.0, 37.5, 50000.0),
        orientation: { heading: 0, pitch: -C.Math.PI_OVER_FOUR, roll: 0 },
      });
      // Pin clock for cross-run stability.
      const fixed = C.JulianDate.fromIso8601("2026-05-19T18:00:00Z");
      v.clock.currentTime = fixed.clone();
      v.clock.startTime = fixed.clone();
      v.clock.stopTime = fixed.clone();
      v.clock.shouldAnimate = false;
      v.clock.multiplier = 0;
      for (let i = 0; i < 1200; i++) {
        v.scene.render();
        await new Promise((r) => requestAnimationFrame(r));
        if (v.scene.globe.tilesLoaded && i > 200) break;
      }
    },
    { multiplier },
  );

  // Wait for tiles + a few render frames.
  await page.waitForTimeout(8000);

  // Sample the canvas pixels — average brightness as a coarse signal.
  const stats = await page.evaluate(() => {
    const canvas = document.querySelector("canvas");
    if (!canvas) return null;
    const off = document.createElement("canvas");
    off.width = canvas.width;
    off.height = canvas.height;
    const ctx = off.getContext("2d");
    ctx.drawImage(canvas, 0, 0);
    const data = ctx.getImageData(0, 0, off.width, off.height).data;
    let sum = 0;
    for (let i = 0; i < data.length; i += 4) {
      sum += data[i] + data[i + 1] + data[i + 2];
    }
    const mean = sum / (data.length / 4) / 3;
    return { width: off.width, height: off.height, meanBrightness: mean };
  });

  await page.screenshot({
    path: `${OUTPUT_DIR}/vertex-lighting-mult-${multiplier.toFixed(2)}.png`,
  });

  await browser.close();
  return { stats, consoleErrors };
}

const lowMult = await captureWithLightingConfig(0.3);
const highMult = await captureWithLightingConfig(1.5);

const report = {
  runAt: new Date().toISOString(),
  lowMult: { multiplier: 0.3, ...lowMult },
  highMult: { multiplier: 1.5, ...highMult },
  brightnessDelta: highMult.stats.meanBrightness - lowMult.stats.meanBrightness,
};
fs.writeFileSync(
  `${OUTPUT_DIR}/vertex-lighting-report.json`,
  JSON.stringify(report, null, 2),
);
console.log(JSON.stringify(report, null, 2));
