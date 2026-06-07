#!/usr/bin/env node
// Probe (P1c): verify vertical exaggeration now applies in COLUMBUS_VIEW (and by
// extension the morph planar leg) on WebGPU, matching WebGL. The exaggeration
// block in GlobeTerrain.wgsl was gated to SCENE3D (mode>2.5), so CV/morph terrain
// rendered flat. Fix ungates it + exaggerates the planar-leg height.
//
// Test: high verticalExaggeration over a mountainous oblique CV view; WebGPU CV
// relief should match WebGL CV relief (WebGL is the reference). Captures the
// canvas in-evaluate (deterministic) for both backends.
//
// Usage: node Tools/visual-regression/probe-exaggeration-cv.mjs
// Out:   output/exag-cv-{webgl,webgpu}.png

import { chromium } from "playwright";
import fs from "fs";
import path from "path";
import { errorGateInit, armWebGPUDevices, collectGateErrors, attachConsoleErrorGate } from "../lib/webgpu-error-gate.mjs";

const BASE = process.env.PROBE_BASE || "http://localhost:8134";
const OUT_DIR = "Tools/visual-regression/output";
const EXAG = Number(process.env.EXAG ?? 10);

async function capture(rendererArg) {
  const browser = await chromium.launch({ channel: "msedge", headless: true, args: ["--enable-unsafe-webgpu"] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const consoleErrors = attachConsoleErrorGate(page);
  await page.addInitScript(errorGateInit);
  await page.goto(`${BASE}/Apps/CesiumViewer/index.html?renderer=${rendererArg}`, { waitUntil: "networkidle" });
  await page.waitForFunction(() => !!window.viewer);
  await armWebGPUDevices(page);

  const out = await page.evaluate(async (exagValue) => {
    const v = window.viewer;
    const c = v.camera;
    v.scene.verticalExaggeration = exagValue;
    // Oblique view over the Himalayas (Everest ~27.99N 86.92E) so terrain
    // height is visible as relief in Columbus View.
    function setHimalayaView() {
      c.setView({
        destination: window.Cesium
          ? window.Cesium.Cartesian3.fromDegrees(86.9, 27.0, 250000)
          : c.positionWC,
        orientation: { heading: 0.0, pitch: -0.45, roll: 0.0 },
      });
    }
    // window.Cesium not exposed → use camera lon/lat via flyTo-less setView with
    // Cartographic through the scene globe ellipsoid.
    const ell = v.scene.ellipsoid ?? v.scene.globe.ellipsoid;
    const dest = ell.cartographicToCartesian({ longitude: (86.9 * Math.PI) / 180, latitude: (27.0 * Math.PI) / 180, height: 250000 });
    c.setView({ destination: dest, orientation: { heading: 0.0, pitch: -0.45, roll: 0.0 } });

    v.scene.morphToColumbusView(0);
    // Settle: terrain tiles must stream in for relief to show.
    for (let i = 0; i < 300; i++) {
      v.scene.initializeFrame();
      v.scene.render();
      await new Promise((r) => requestAnimationFrame(r));
    }
    // re-assert the view (morph may have moved the camera) and settle again
    c.setView({ destination: dest, orientation: { heading: 0.0, pitch: -0.45, roll: 0.0 } });
    for (let i = 0; i < 180; i++) {
      v.scene.initializeFrame();
      v.scene.render();
      await new Promise((r) => requestAnimationFrame(r));
    }

    const cv = v.scene.canvas;
    const off = document.createElement("canvas");
    off.width = cv.width;
    off.height = cv.height;
    const cx = off.getContext("2d");
    cx.drawImage(cv, 0, 0);
    const d = cx.getImageData(0, 0, cv.width, cv.height).data;
    let nb = 0, t = 0;
    for (let p = 0; p < d.length; p += 64) { t++; if (d[p] > 8 || d[p + 1] > 8 || d[p + 2] > 8) nb++; }
    return {
      mode: v.scene.mode,
      exaggeration: v.scene.verticalExaggeration,
      nonBlackPct: +((100 * nb) / t).toFixed(1),
      dataUrl: cv.toDataURL("image/png"),
    };
  }, EXAG);

  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
  const file = path.join(OUT_DIR, `exag${EXAG}-cv-${rendererArg}.png`);
  fs.writeFileSync(file, Buffer.from(out.dataUrl.split(",")[1], "base64"));
  const gate = await collectGateErrors(page);
  await browser.close();
  const fatal = [...consoleErrors, ...gate.errors];
  console.log(`${rendererArg}: mode=${out.mode} exag=${out.exaggeration} nonBlack=${out.nonBlackPct}% fatal=${fatal.length} saved ${file}`);
  return out;
}

(async () => {
  await capture("webgl");
  await capture("webgpu");
  console.log("[probe-exaggeration-cv] done — READ the PNGs: WebGPU CV relief should match WebGL.");
})();
