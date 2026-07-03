#!/usr/bin/env node
// Probe (NEW-WEBGPU-SKYBOX-HDR-FAINT-STAR-PARITY): WebGPU forced auto-exposure
// ALWAYS-ON (B.14) while WebGL defaults it off, and configure never synced the
// flag — so under HDR the adaptive exposure collapsed the near-black night sky
// to pure black (the bright catalog stars + their bloom halos vanished). Fix
// (Batch 364): honor PostProcessStageCollection._autoExposureEnabled (WebGL's
// opt-in flag, default false) so both backends expose identically by default.
//
// Renders the same night-sky view on BOTH backends under HDR and asserts the
// WebGPU frame is NOT crushed (bright pixels + saturated bloom-feeding points +
// non-trivial max luminance), measuring WebGL for reference. A residual
// brightness gap vs WebGL's catalog star sprites is tracked separately
// (NEW-WEBGPU-STARFIELD-TUNE) and is NOT asserted here.
//
// Usage: node Tools/visual-regression/probe-stars-hdr-autoexposure-parity.mjs

import { chromium } from "playwright";
import { writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dir = dirname(fileURLToPath(import.meta.url));
const OUT = join(__dir, "output");
mkdirSync(OUT, { recursive: true });
const BASE = process.env.PROBE_BASE || "http://localhost:8080";

async function measure(renderer) {
  const browser = await chromium.launch({
    channel: "msedge",
    headless: true,
    args: ["--enable-unsafe-webgpu"],
  });
  const page = await browser.newPage({ viewport: { width: 1000, height: 1000 } });
  const errs = [];
  page.on("console", (m) => {
    if (m.type() === "error") errs.push(m.text());
  });
  await page.goto(`${BASE}/Apps/CesiumViewer/index.html?renderer=${renderer}`, {
    waitUntil: "domcontentloaded",
    timeout: 90000,
  });
  await page.waitForFunction(() => !!window.viewer, null, { timeout: 90000 });

  const r = await page.evaluate(async () => {
    const C = await import("/Build/CesiumUnminified/index.js");
    const v = window.viewer;
    const s = v.scene;
    s.requestRenderMode = false;
    v.clock.shouldAnimate = false;
    v.clock.currentTime = C.JulianDate.fromIso8601("2024-01-01T03:00:00Z");
    s.skyAtmosphere.show = false;
    s.fog.enabled = false;
    s.globe.show = false;
    s.highDynamicRange = true;
    if (s.postProcessStages?.bloom) s.postProcessStages.bloom.enabled = true;
    s.camera.setView({
      destination: C.Cartesian3.fromDegrees(0, 0, 9_000_000),
      orientation: { heading: 0, pitch: C.Math.toRadians(55), roll: 0 },
    });
    for (let i = 0; i < 90; i++)
      await new Promise((res) => {
        s.requestRender();
        s.render();
        requestAnimationFrame(res);
      });
    return new Promise((resolve) => {
      const remove = s.postRender.addEventListener(() => {
        remove();
        const c = s.canvas;
        const off = document.createElement("canvas");
        off.width = c.width;
        off.height = c.height;
        const cx = off.getContext("2d");
        cx.drawImage(c, 0, 0);
        const d = cx.getImageData(0, 0, c.width, c.height).data;
        let bright = 0,
          sat = 0,
          maxL = 0;
        for (let i = 0; i < d.length; i += 4) {
          const l = d[i] + d[i + 1] + d[i + 2];
          if (l > 120) bright++;
          if (d[i] > 250 || d[i + 1] > 250 || d[i + 2] > 250) sat++;
          if (l > maxL) maxL = l;
        }
        resolve({ png: off.toDataURL("image/png"), bright, sat, maxL });
      });
      s.requestRender();
      s.render();
    });
  });
  writeFileSync(
    join(OUT, `stars-hdr-ae-${renderer}.png`),
    Buffer.from(r.png.split(",")[1], "base64"),
  );
  await browser.close();
  return { ...r, errs };
}

const gl = await measure("webgl");
const gpu = await measure("webgpu");

console.log(`WebGL  HDR sky: bright(>120)=${gl.bright}  saturated=${gl.sat}  maxLum=${gl.maxL}  errors=${gl.errs.length}`);
console.log(`WebGPU HDR sky: bright(>120)=${gpu.bright}  saturated=${gpu.sat}  maxLum=${gpu.maxL}  errors=${gpu.errs.length}`);

// The fix: WebGPU must no longer be crushed to black. (Before: bright=0,
// maxLum=0.) Gate generously — residual catalog-sprite brightness gap vs WebGL
// is a separate item.
//
// NEW-PP-LIBRARY-TONEMAP-ORDER (2026-07-03): the old `sat > 0` clause
// asserted a BUG — pre-fix, WebGPU never engaged the tonemap under plain
// `highDynamicRange`, so bright star cores stayed at raw 255 (maxLum
// ~761, per the B364 diag). Now BOTH backends tonemap (PBR Neutral
// compresses the catalog's peaks to ~717-726) and saturation is a
// knife-edge 0-or-1-pixel wobble. Guard the tonemap comparatively via
// maxLum headroom instead: if the WebGPU tonemap ever goes missing
// again, gpu.maxL jumps to ~761+ while WebGL stays ~717 and this fails.
const notCrushed = gpu.bright > 100 && gpu.maxL > 200;
const tonemapEngaged = gpu.maxL <= gl.maxL + 30;
const errorsOK = gpu.errs.length === 0 && gl.errs.length === 0;
console.log(`WebGPU not crushed (bright>100 & maxLum>200): ${notCrushed ? "OK" : "FAIL"}`);
console.log(`tonemap engaged (gpu maxLum ${gpu.maxL} <= gl ${gl.maxL}+30): ${tonemapEngaged ? "OK" : "FAIL"}`);
console.log(`console errors: ${errorsOK ? "OK" : "FAIL"}`);
const pass = notCrushed && tonemapEngaged && errorsOK;
console.log(pass ? "PASS" : "FAIL");
process.exit(pass ? 0 : 1);
