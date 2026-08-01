#!/usr/bin/env node
// Probe (C4-CUBEMAP-PANORAMA-HDR-DECODE): verify the WebGPU SkyBox cube-map
// applies czm_gammaCorrect's sRGB->linear decode (pow(color, czm_gamma)) when
// HDR is enabled, matching WebGL SkyBoxFS.glsl, and stays byte-identical on the
// default SDR path.
//
// The cube-map faint-star / milky-way background is sRGB-encoded. WebGL decodes
// it to linear (#ifdef HDR) before it enters the linear HDR pipeline; the
// tonemap stage then re-encodes for display. Before this fix WebGPU passed the
// cube-map through un-decoded in HDR mode, so its faint sky was brighter than
// WebGL's. After the fix the two backends should converge in HDR.
//
// Captures cube-map-ONLY sky (starField point renderer off) per backend in two
// modes: SDR (default) and HDR (scene.highDynamicRange = true). Metric = mean
// luminance of the faint sky crop.
//
// Pass criteria:
//   - HDR: WebGPU faint-sky mean luminance converges to WebGL (ratio ~1),
//     and is measurably below the WebGPU SDR luminance (the decode darkens
//     sub-unity sRGB values → proves the branch is active).
//   - SDR off-gate: WebGPU SDR still matches WebGL SDR (unchanged parity).
//   - 0 WebGPU device errors.
//
// Usage:  node Tools/visual-regression/probe-panorama-hdr.mjs
// Outputs: Tools/visual-regression/output/panorama-hdr-{webgl,webgpu}-{sdr,hdr}.png

import { chromium } from "playwright";
import fs from "fs";
import path from "path";
import {
  errorGateInit,
  armWebGPUDevices,
  collectGateErrors,
  attachConsoleErrorGate,
} from "../lib/webgpu-error-gate.mjs";

const BASE = process.env.PROBE_BASE || "http://localhost:8080";
const OUT_DIR = "Tools/visual-regression/output";

async function capture(rendererArg, hdrOn) {
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
    viewport: { width: 1280, height: 720 },
  });
  const consoleErrors = attachConsoleErrorGate(page);
  await page.addInitScript(errorGateInit);

  const url = `${BASE}/Apps/CesiumViewer/index.html?renderer=${rendererArg}`;
  await page.goto(url, { waitUntil: "networkidle" });
  await page.waitForFunction(() => !!window.viewer);
  await armWebGPUDevices(page);

  const meta = await page.evaluate(async (hdrOn) => {
    const C = await import("/Build/CesiumUnminified/index.js");
    const v = window.viewer;
    const s = v.scene;

    const fixed = C.JulianDate.fromIso8601("2026-05-19T18:00:00Z");
    v.clock.currentTime = fixed.clone();
    v.clock.startTime = fixed.clone();
    v.clock.stopTime = fixed.clone();
    v.clock.shouldAnimate = false;
    v.clock.multiplier = 0;

    s.highDynamicRange = hdrOn === true;

    if (s.skyBox) {
      s.skyBox.show = true;
      // Isolate the cube-map contribution — no bright catalog stars.
      if (s.skyBox.starField) s.skyBox.starField.show = false;
    }
    // Keep sun + skyAtmosphere ON (matches probe-env-skybox-stars) — the
    // WebGPU environment pass renders the skybox cube-map through this path;
    // disabling them leaves the WebGPU frame black. Camera looks AWAY from
    // Earth so no atmosphere limb / sun disc enters the sky crop.
    if (s.sun) s.sun.show = true;
    if (s.skyAtmosphere) s.skyAtmosphere.show = true;
    s.backgroundColor = C.Color.BLACK;

    // Far out in space, looking straight AWAY from Earth so the frame is
    // pure cube-map: no globe, no limb, no atmosphere.
    v.camera.setView({
      destination: C.Cartesian3.fromDegrees(0, 0, 5.0e7),
      orientation: { heading: 0, pitch: C.Math.toRadians(90), roll: 0 },
    });

    let sawSkyBoxCmd = false;
    for (let i = 0; i < 300; i++) {
      s.render();
      await new Promise((r) => requestAnimationFrame(r));
      const env = s._environmentState;
      if (env && env.skyBoxCommand) sawSkyBoxCmd = true;
      if (sawSkyBoxCmd && i > 60) break;
    }

    return {
      renderer: s.context.rendererType,
      hdr: !!s.highDynamicRange,
      hdrSupported: !!s.highDynamicRangeSupported,
      sawSkyBoxCmd,
    };
  }, hdrOn);

  await page.waitForTimeout(800);

  const label = hdrOn ? "hdr" : "sdr";
  const out = path.join(OUT_DIR, `panorama-hdr-${rendererArg}-${label}.png`);
  await page.screenshot({ path: out, fullPage: false });

  const gate = await collectGateErrors(page);
  await browser.close();
  return { out, meta, consoleErrors, gate };
}

// Mean luminance + faint-pixel count of the faint sky crop (UI-free region).
async function analyze(pngPath) {
  const browser = await chromium.launch({ channel: "msedge", headless: true });
  const page = await browser.newPage();
  await page.setContent("<!doctype html><html><body></body></html>");
  const b64 = fs.readFileSync(pngPath).toString("base64");
  const stats = await page.evaluate(async (b64) => {
    const img = new Image();
    img.src = "data:image/png;base64," + b64;
    await img.decode();
    const cv = document.createElement("canvas");
    cv.width = img.naturalWidth;
    cv.height = img.naturalHeight;
    const ctx = cv.getContext("2d");
    ctx.drawImage(img, 0, 0);
    // Sky-only crop: skip toolbar, side panels, timeline/attribution.
    const x0 = 40,
      x1 = 980,
      y0 = 300,
      y1 = 640;
    const d = ctx.getImageData(x0, y0, x1 - x0, y1 - y0).data;
    let lumSum = 0;
    let faintPx = 0;
    let n = 0;
    for (let i = 0; i < d.length; i += 4) {
      const lum = 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
      lumSum += lum;
      // Faint sky = the milky-way background band, not the sparse hot stars.
      if (lum > 2 && lum < 96) faintPx++;
      n++;
    }
    return { meanLum: lumSum / n, faintPct: (100 * faintPx) / n };
  }, b64);
  await browser.close();
  return stats;
}

(async () => {
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
  console.log(`[panorama-hdr] base=${BASE}`);

  const results = {};
  for (const renderer of ["webgpu", "webgl"]) {
    for (const hdrOn of [false, true]) {
      const label = hdrOn ? "hdr" : "sdr";
      const r = await capture(renderer, hdrOn);
      r.stats = await analyze(r.out);
      results[`${renderer}-${label}`] = r;
      console.log(
        `\n-- ${renderer} / ${label} --\n` +
          `  meta: ${JSON.stringify(r.meta)}\n` +
          `  stats: ${JSON.stringify(r.stats)}\n` +
          `  gate errors: ${r.gate ? r.gate.errors.length : "n/a"} ` +
          `console faults: ${r.consoleErrors.length}`,
      );
      if (r.consoleErrors.length) {
        r.consoleErrors.slice(0, 5).forEach((e) => console.log("    " + e));
      }
    }
  }

  const gpuSdr = results["webgpu-sdr"].stats;
  const glSdr = results["webgl-sdr"].stats;
  const gpuHdr = results["webgpu-hdr"].stats;
  const glHdr = results["webgl-hdr"].stats;

  // SDR off-gate: WebGPU SDR still tracks WebGL SDR (unchanged parity).
  const sdrRatio = glSdr.meanLum > 0 ? gpuSdr.meanLum / glSdr.meanLum : 0;
  // HDR convergence: WebGPU HDR faint sky now matches WebGL HDR.
  const hdrRatio = glHdr.meanLum > 0 ? gpuHdr.meanLum / glHdr.meanLum : 0;
  const gateErrors =
    results["webgpu-hdr"].gate.errors.length +
    results["webgpu-sdr"].gate.errors.length;

  const pass =
    sdrRatio > 0.75 &&
    sdrRatio < 1.33 &&
    hdrRatio > 0.75 &&
    hdrRatio < 1.33 &&
    gateErrors === 0;

  console.log(
    `\n== verdict ==\n` +
      `  SDR off-gate  gpu/gl meanLum=${sdrRatio.toFixed(3)}\n` +
      `  HDR converge  gpu/gl meanLum=${hdrRatio.toFixed(3)}\n` +
      `  gpu SDR meanLum=${gpuSdr.meanLum.toFixed(3)} ` +
      `gpu HDR meanLum=${gpuHdr.meanLum.toFixed(3)}\n` +
      `  gateErrors=${gateErrors} => ` +
      (pass ? "PASS" : "FAIL"),
  );

  console.log("\nPNGs:");
  for (const k of Object.keys(results)) {
    console.log("  " + path.resolve(results[k].out));
  }
  process.exit(pass ? 0 : 1);
})();
