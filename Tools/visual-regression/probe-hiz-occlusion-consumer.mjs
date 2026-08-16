#!/usr/bin/env node
// Probe: HIZ-OCCLUSION-CONSUMER (NEW-HIZ-CONSUME, Batch 210)
// @purpose Dense 3600-box scene crossing the Hi-Z gate: polls highDensityCull() for activation/dispatch/filtering and captures both backends for over-cull
// @status ACTIVE
//
// Verifies the Hi-Z occlusion-culling consumer on WebGPU:
//   1. Builds a DENSE scene (thousands of individual box primitives) so the
//      per-frustum opaque command count crosses the Hi-Z activation gate
//      (HI_Z_THRESHOLD_HI = 2400). A default globe alone never reaches that.
//   2. Lets the scene settle, then polls CesiumDebug.highDensityCull() across
//      many frames to capture whether the HiZ gate actually activates +
//      dispatches + filters (occlusion is doing something).
//   3. Captures the rendered canvas to PNG on BOTH backends so we can read it
//      and confirm no missing/flickering geometry from over-aggressive culling.
//
// Output: Tools/visual-regression/output/hiz-occlusion-<renderer>.png
//
// Usage:
//   PROBE_BASE=http://localhost:8134 node Tools/visual-regression/probe-hiz-occlusion-consumer.mjs

import { chromium } from "playwright";
import fs from "fs";
import path from "path";
import {
  errorGateInit,
  armWebGPUDevices,
  collectGateErrors,
  attachConsoleErrorGate,
} from "../lib/webgpu-error-gate.mjs";

const BASE = process.env.PROBE_BASE || "http://localhost:8134";
const OUT_DIR = "Tools/visual-regression/output";
// Grid of boxes — 60x60 = 3600 primitives, comfortably above HI_Z_THRESHOLD_HI
// (2400). Each Primitive(BoxGeometry) yields its own opaque DrawCommand.
const GRID = Number(process.env.PROBE_GRID || 60);

async function run(rendererArg) {
  const browser = await chromium.launch({
    channel: "msedge",
    headless: true,
    args: [
      "--enable-unsafe-webgpu",
      "--enable-features=Vulkan",
      "--use-vulkan",
    ],
  });
  const page = await browser.newPage({
    viewport: { width: 1024, height: 768 },
  });
  const consoleErrors = attachConsoleErrorGate(page);
  await page.addInitScript(errorGateInit);

  const url = `${BASE}/Apps/CesiumViewer/index.html?renderer=${rendererArg}`;
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => !!window.viewer, null, { timeout: 60000 });
  await armWebGPUDevices(page);

  // Build the dense box grid + frame it. Boxes are clustered so many overlap
  // in screen space (the occlusion-test target — front boxes occlude rear).
  const buildInfo = await page.evaluate(async (grid) => {
    const Cesium = await import("/Build/CesiumUnminified/index.js");
    const v = window.viewer;
    const scene = v.scene;
    const prims = scene.primitives;

    // A compact patch over Colorado so boxes overlap heavily on screen.
    const lon0 = -105.0;
    const lat0 = 39.0;
    const span = 0.6; // degrees
    const boxDim = new Cesium.Cartesian3(6000.0, 6000.0, 90000.0);
    const geom = Cesium.BoxGeometry.fromDimensions({
      vertexFormat: Cesium.PerInstanceColorAppearance.VERTEX_FORMAT,
      dimensions: boxDim,
    });

    let created = 0;
    for (let i = 0; i < grid; i++) {
      for (let j = 0; j < grid; j++) {
        const lon = lon0 + (i / grid) * span;
        const lat = lat0 + (j / grid) * span;
        const height = 50000 + ((i * 7 + j * 13) % 11) * 8000;
        const pos = Cesium.Cartesian3.fromDegrees(lon, lat, height);
        const modelMatrix = Cesium.Transforms.eastNorthUpToFixedFrame(pos);
        const inst = new Cesium.GeometryInstance({
          geometry: geom,
          modelMatrix,
          attributes: {
            color: Cesium.ColorGeometryInstanceAttribute.fromColor(
              Cesium.Color.fromHsl((created % 360) / 360, 0.7, 0.55, 1.0),
            ),
          },
        });
        // One Primitive per instance => one DrawCommand per box. This is the
        // dense-command-count path the Hi-Z gate is designed for.
        prims.add(
          new Cesium.Primitive({
            geometryInstances: inst,
            appearance: new Cesium.PerInstanceColorAppearance({
              translucent: false,
              closed: true,
            }),
            asynchronous: false,
          }),
        );
        created++;
      }
    }

    // Frame the patch from a low oblique angle so near boxes occlude far ones.
    const center = Cesium.Cartesian3.fromDegrees(
      lon0 + span / 2,
      lat0 + span / 2,
      50000,
    );
    scene.camera.lookAt(
      center,
      new Cesium.HeadingPitchRange(
        Cesium.Math.toRadians(20),
        Cesium.Math.toRadians(-18),
        180000,
      ),
    );
    scene.camera.lookAtTransform(Cesium.Matrix4.IDENTITY);

    return { created, primCount: prims.length };
  }, GRID);

  // Settle: HiZ is 1-frame-latent (readback feeds the NEXT frame) and the gate
  // has hysteresis, so render many frames and sample stats across them.
  const statSamples = await page.evaluate(async () => {
    const v = window.viewer;
    const scene = v.scene;
    const samples = [];
    const dbg = window.CesiumDebug;
    const hasStats = dbg && typeof dbg.highDensityCull === "function";
    for (let i = 0; i < 180; i++) {
      scene.render();
      await new Promise((r) => requestAnimationFrame(r));
      if (hasStats && i % 20 === 0) {
        try {
          // Call the underlying renderer stats directly to avoid console.table
          // spam; highDensityCull() returns the same object.
          const renderer = scene._alternateSceneRenderer;
          if (
            renderer &&
            typeof renderer.getHighDensityCullStats === "function"
          ) {
            const s = renderer.getHighDensityCullStats();
            samples.push({
              frame: i,
              hiZ: s.hiZ,
              gpuCullerOpaque: s.gpuCullerOpaque,
            });
          }
        } catch (e) {
          samples.push({ frame: i, error: String(e) });
        }
      }
    }
    return {
      hasCesiumDebug: !!dbg,
      hasHighDensityCull: hasStats,
      hasAlternateRenderer: !!scene._alternateSceneRenderer,
      samples,
    };
  });

  await page.waitForTimeout(800);

  // Capture the WebGL/WebGPU canvas directly (toDataURL) so we read exactly
  // what the engine drew, not browser chrome.
  const dataUrl = await page.evaluate(async () => {
    const v = window.viewer;
    v.scene.render();
    await new Promise((r) => requestAnimationFrame(r));
    v.scene.render();
    const canvas = v.scene.canvas;
    return canvas.toDataURL("image/png");
  });

  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
  const outPath = path.join(OUT_DIR, `hiz-occlusion-${rendererArg}.png`);
  const b64 = dataUrl.replace(/^data:image\/png;base64,/, "");
  fs.writeFileSync(outPath, Buffer.from(b64, "base64"));

  // Rough non-background pixel count from the captured PNG (decode in-page).
  const pixelStats = await page.evaluate(async (du) => {
    const img = new Image();
    img.src = du;
    await img.decode();
    const c = document.createElement("canvas");
    c.width = img.naturalWidth;
    c.height = img.naturalHeight;
    const ctx = c.getContext("2d");
    ctx.drawImage(img, 0, 0);
    const d = ctx.getImageData(0, 0, c.width, c.height).data;
    let nonBg = 0;
    for (let i = 0; i < d.length; i += 4) {
      const lum = 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
      if (lum > 12) nonBg++;
    }
    return { total: c.width * c.height, nonBg, w: c.width, h: c.height };
  }, dataUrl);

  const gate = await collectGateErrors(page);
  await browser.close();

  return {
    renderer: rendererArg,
    outPath,
    buildInfo,
    statSamples,
    pixelStats,
    consoleErrors: consoleErrors.slice(0, 8),
    gate,
  };
}

(async () => {
  const results = {};
  for (const r of ["webgpu", "webgl"]) {
    console.log(`\n[probe-hiz-occlusion] === ${r} ===`);
    try {
      const res = await run(r);
      results[r] = res;
      console.log(`  built: ${JSON.stringify(res.buildInfo)}`);
      console.log(
        `  debug: hasCesiumDebug=${res.statSamples.hasCesiumDebug} hasHighDensityCull=${res.statSamples.hasHighDensityCull} hasAlternateRenderer=${res.statSamples.hasAlternateRenderer}`,
      );
      for (const s of res.statSamples.samples) {
        if (s.hiZ) {
          console.log(
            `  frame ${s.frame}: hiZ active=${s.hiZ.activeAnyFrustum} dispatches=${s.hiZ.dispatches} in=${s.hiZ.lastFrameInput} filtered=${s.hiZ.lastFrameFiltered} hit=${s.hiZ.hitRatio} | gpuCullOpaque active=${s.gpuCullerOpaque.activeAnyFrustum} dispatches=${s.gpuCullerOpaque.dispatches}`,
          );
        } else if (s.error) {
          console.log(`  frame ${s.frame}: ERROR ${s.error}`);
        }
      }
      console.log(
        `  pixels: nonBg=${res.pixelStats.nonBg}/${res.pixelStats.total} (${((100 * res.pixelStats.nonBg) / res.pixelStats.total).toFixed(1)}%) ${res.pixelStats.w}x${res.pixelStats.h}`,
      );
      console.log(`  png: ${res.outPath}`);
      if (res.consoleErrors.length)
        console.log(`  consoleErrors: ${JSON.stringify(res.consoleErrors)}`);
      console.log(
        `  gate: errors=${res.gate.errors.length} deviceLost=${res.gate.deviceLost} armed=${res.gate.armedDevices}`,
      );
      if (res.gate.errors.length)
        console.log(
          `  gate.errors: ${JSON.stringify(res.gate.errors.slice(0, 5))}`,
        );
    } catch (e) {
      console.log(`  FAILED: ${e.message}`);
      results[r] = { error: e.message };
    }
  }
  console.log("\n[probe-hiz-occlusion] done");
})();
