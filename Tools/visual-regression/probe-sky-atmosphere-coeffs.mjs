#!/usr/bin/env node
// Q24R-DPH47-SKY-COEFFS — SkyAtmosphere scattering-coefficient response parity.
//
// PREMISE-VERIFICATION RESULT (2026-07-04): the DP-H47 increment-1 premise
// ("WebGPU SkyAtmosphere ignores scene.atmosphere.rayleighCoefficient; wiring it
// through would match WebGL responsiveness") is STALE. Empirically AND by code:
//
//   * The WebGL SKY is driven by the SkyAtmosphere INSTANCE coefficients
//     (`u_atmosphereRayleighCoefficient`, bound in Scene/SkyAtmosphere.js →
//     consumed by AtmosphereCommon.glsl `computeScattering`). It does NOT read
//     `scene.atmosphere.rayleighCoefficient` (`czm_atmosphere*`) — that suite
//     drives only the GROUND atmosphere and the Model/IBL sky-fill
//     (ComputeRadianceMapFS.glsl `czm_computeScattering`).
//   * WebGPU's `WebGPUSkyAtmosphereRenderer.packUniforms` ALREADY reads
//     `skyAtmosphere.atmosphereRayleighCoefficient` (the same instance property),
//     so the sky-coefficient parity is already closed at BOTH defaults and
//     overrides. Wiring `scene.atmosphere.*` into the WebGPU sky would make it
//     DIVERGE from WebGL, not converge.
//
// This probe is the REGRESSION GUARD for that verified parity. It asserts:
//   (A) DEFAULT sky cross-backend parity (WebGPU base ≈ WebGL base).
//   (B) skyAtmosphere.atmosphereRayleighCoefficient override REVERSES the sky
//       on BOTH backends by the same large amount (real, matching response).
//   (C) scene.atmosphere.rayleighCoefficient override moves NEITHER backend's
//       sky (both correctly ignore it — WebGL-faithful).
//   (D) 0 device/console errors on both backends.
//
//   node Tools/visual-regression/probe-sky-atmosphere-coeffs.mjs

import { chromium } from "playwright";
import fs from "fs";
import path from "path";

const BASE = "http://localhost:8080";
const OUT_DIR = "Tools/visual-regression/output";
const TIME_ISO = "2026-05-19T18:00:00Z"; // daytime sun
const VIEW = { lon: -80.0, lat: 40.0, height: 200.0 };

async function capture(renderer, mode) {
  const browser = await chromium.launch({
    channel: "msedge",
    headless: true,
    args: ["--enable-unsafe-webgpu", "--use-vulkan", "--disable-cache"],
  });
  const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
  const consoleErrors = [];
  page.on("console", (m) => {
    if (m.type() === "error") consoleErrors.push(m.text());
  });
  await page.goto(`${BASE}/Apps/CesiumViewer/index.html?renderer=${renderer}`, {
    waitUntil: "networkidle",
  });
  await page.waitForFunction(() => !!window.viewer);

  await page.evaluate(
    async ({ mode, view, timeIso, renderer }) => {
      const C = await import("/Build/CesiumUnminified/index.js");
      const v = window.viewer;
      const fixed = C.JulianDate.fromIso8601(timeIso);
      v.clock.currentTime = fixed.clone();
      v.clock.startTime = fixed.clone();
      v.clock.stopTime = fixed.clone();
      v.clock.shouldAnimate = false;
      v.clock.multiplier = 0;

      const sky = v.scene.skyAtmosphere;
      sky.show = true;
      if (renderer === "webgpu") sky._webgpuFullscreen = true;

      v.scene.globe.showGroundAtmosphere = false;
      v.scene.globe.show = false;
      v.scene.fog.enabled = false;
      v.scene.skyBox.show = false;
      v.scene.sun.show = false;
      v.scene.moon.show = false;
      v.scene.globe.enableLighting = false;
      v.scene.backgroundColor = C.Color.BLACK;

      // reversed rayleigh: red-heavy instead of blue-heavy
      const REV = new C.Cartesian3(28.4e-6, 13.0e-6, 5.5e-6);
      if (mode === "skyover") {
        sky.atmosphereRayleighCoefficient = C.Cartesian3.clone(REV);
      } else if (mode === "atmoover") {
        v.scene.atmosphere.rayleighCoefficient = C.Cartesian3.clone(REV);
      }

      for (const sel of [
        ".cesium-viewer-timelineContainer",
        ".cesium-viewer-animationContainer",
        ".cesium-viewer-bottom",
        ".cesium-viewer-toolbar",
      ]) {
        const el = document.querySelector(sel);
        if (el) el.style.display = "none";
      }

      v.camera.setView({
        destination: C.Cartesian3.fromDegrees(view.lon, view.lat, view.height),
        orientation: {
          heading: C.Math.toRadians(270.0),
          pitch: C.Math.toRadians(20.0),
          roll: 0.0,
        },
      });

      for (let i = 0; i < 90; i++) {
        v.scene.render();
        await new Promise((r) => requestAnimationFrame(r));
      }
    },
    { mode, view: VIEW, timeIso: TIME_ISO, renderer },
  );
  await page.waitForTimeout(600);
  const out = path.join(OUT_DIR, `sky-coeffs-${renderer}-${mode}.png`);
  await page.screenshot({ path: out });
  await browser.close();
  return { out, consoleErrors };
}

async function meanRGB(pngPath) {
  const browser = await chromium.launch({ channel: "msedge", headless: true });
  const page = await browser.newPage();
  await page.setContent("<!doctype html><html><body></body></html>");
  const b64 = fs.readFileSync(pngPath).toString("base64");
  const s = await page.evaluate(async (b64) => {
    const img = new Image();
    img.src = "data:image/png;base64," + b64;
    await img.decode();
    const cv = document.createElement("canvas");
    cv.width = img.width;
    cv.height = img.height;
    const ctx = cv.getContext("2d");
    ctx.drawImage(img, 0, 0);
    const d = ctx.getImageData(0, 0, img.width, img.height).data;
    const w = img.width,
      h = img.height;
    let r = 0,
      g = 0,
      b = 0,
      n = 0;
    for (let y = Math.floor(h * 0.1); y < Math.floor(h * 0.3); y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        r += d[i];
        g += d[i + 1];
        b += d[i + 2];
        n++;
      }
    }
    return { r: r / n, g: g / n, b: b / n };
  }, b64);
  await browser.close();
  return s;
}

const rbDelta = (a, b) => Math.abs(a.r - b.r) + Math.abs(a.b - b.b);

(async () => {
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
  console.log(
    "[sky-atmosphere-coeffs] SkyAtmosphere coefficient response parity",
  );
  const data = {};
  let totalErrors = 0;
  for (const renderer of ["webgl", "webgpu"]) {
    data[renderer] = {};
    for (const mode of ["base", "skyover", "atmoover"]) {
      const { out, consoleErrors } = await capture(renderer, mode);
      totalErrors += consoleErrors.length;
      const c = await meanRGB(out);
      data[renderer][mode] = c;
      console.log(
        `  ${renderer.padEnd(6)} ${mode.padEnd(9)} r=${c.r.toFixed(1)} g=${c.g.toFixed(1)} b=${c.b.toFixed(1)}  (errs=${consoleErrors.length})`,
      );
    }
  }

  const wgl = data.webgl,
    wgpu = data.webgpu;
  const skyRespWgl = rbDelta(wgl.skyover, wgl.base);
  const skyRespWgpu = rbDelta(wgpu.skyover, wgpu.base);
  const atmoRespWgl = rbDelta(wgl.atmoover, wgl.base);
  const atmoRespWgpu = rbDelta(wgpu.atmoover, wgpu.base);
  const baseParity = rbDelta(wgl.base, wgpu.base);

  console.log("");
  console.log(
    `  (A) default cross-backend |dR|+|dB| = ${baseParity.toFixed(1)} (want < 12)`,
  );
  console.log(
    `  (B) skyInstance-override response  WebGL=${skyRespWgl.toFixed(1)}  WebGPU=${skyRespWgpu.toFixed(1)} (want BOTH > 120, close)`,
  );
  console.log(
    `  (C) sceneAtmosphere-override response WebGL=${atmoRespWgl.toFixed(1)}  WebGPU=${atmoRespWgpu.toFixed(1)} (want BOTH < 8 — sky ignores it on both)`,
  );
  console.log(`  (D) total console/device errors = ${totalErrors} (want 0)`);

  const passA = baseParity < 12;
  const passB =
    skyRespWgl > 120 &&
    skyRespWgpu > 120 &&
    Math.abs(skyRespWgl - skyRespWgpu) < 20;
  const passC = atmoRespWgl < 8 && atmoRespWgpu < 8;
  const passD = totalErrors === 0;
  const pass = passA && passB && passC && passD;
  console.log("");
  console.log(
    `  RESULT: ${pass ? "PASS" : "FAIL"}  [A:${passA} B:${passB} C:${passC} D:${passD}]`,
  );
  process.exit(pass ? 0 : 1);
})();
