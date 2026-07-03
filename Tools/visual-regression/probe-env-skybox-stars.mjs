#!/usr/bin/env node
// Probe (ENV-SKYBOX-STARMAP): verify the SkyBox star cube-map (the faint-star /
// milky-way background texture) draws on WebGPU and matches WebGL — separately
// from the fork's bright-star catalog point renderer (StarField), which is
// disabled for the isolated capture so only the cube-map contribution remains.
//
// Camera is parked far out in space looking AWAY from Earth (pitch straight up
// from local ENU) so the frame is pure sky: no globe, no atmosphere limb, no
// sun. The clock is pinned so the ICRF->fixed skybox rotation is deterministic.
//
// Captures per backend:
//   1. cube-map ONLY  (skyBox.show=true, skyBox.starField.show=false)
//   2. default        (skyBox + starField, as the viewer ships)
//
// Pass criteria:
//   - WebGPU cube-map-only capture shows a star field comparable to WebGL:
//     star-pixel density and mean sky luminance within family (not near-zero).
//   - The star PATTERN matches WebGL (block-luminance correlation of the sky
//     crop, aligned vs vertically-mirrored) — catches the cube-face flipY
//     parity bug (WebGL uploads faces with UNPACK_FLIP_Y_WEBGL=true; WebGPU
//     must pass flipY:true to copyExternalImageToTexture or every face is
//     vertically mirrored and a DIFFERENT sky region shows).
//   - 0 WebGPU device errors.
//
// Usage:
//   node Tools/visual-regression/probe-env-skybox-stars.mjs
// Outputs:
//   Tools/visual-regression/output/env-skybox-stars-{webgl,webgpu}-{cubemap,default}.png

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

async function capture(rendererArg, starFieldOn) {
  const browser = await chromium.launch({
    channel: "msedge",
    headless: true,
    args: ["--enable-unsafe-webgpu", "--enable-features=Vulkan", "--use-vulkan"],
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const consoleErrors = attachConsoleErrorGate(page);
  await page.addInitScript(errorGateInit);

  const url = `${BASE}/Apps/CesiumViewer/index.html?renderer=${rendererArg}`;
  await page.goto(url, { waitUntil: "networkidle" });
  await page.waitForFunction(() => !!window.viewer);
  await armWebGPUDevices(page);

  const meta = await page.evaluate(async (starFieldOn) => {
    const C = await import("/Build/CesiumUnminified/index.js");
    const v = window.viewer;
    const s = v.scene;

    // Pin the clock so the skybox orientation is deterministic across runs.
    const fixed = C.JulianDate.fromIso8601("2026-05-19T18:00:00Z");
    v.clock.currentTime = fixed.clone();
    v.clock.startTime = fixed.clone();
    v.clock.stopTime = fixed.clone();
    v.clock.shouldAnimate = false;
    v.clock.multiplier = 0;

    if (s.skyBox) {
      s.skyBox.show = true;
      if (s.skyBox.starField) {
        s.skyBox.starField.show = starFieldOn;
      }
    }
    if (s.sun) s.sun.show = true;
    if (s.skyAtmosphere) s.skyAtmosphere.show = true;
    s.backgroundColor = C.Color.BLACK;

    // Far out in space, looking straight AWAY from Earth (local up) so the
    // frame is pure skybox — no globe, no limb, no atmosphere.
    v.camera.setView({
      destination: C.Cartesian3.fromDegrees(0, 0, 5.0e7),
      orientation: { heading: 0, pitch: C.Math.toRadians(90), roll: 0 },
    });

    // Render enough frames for the async cube-map load + command creation.
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
      skyBoxShow: !!(s.skyBox && s.skyBox.show),
      starFieldShow: !!(
        s.skyBox &&
        s.skyBox.starField &&
        s.skyBox.starField.show
      ),
      sawSkyBoxCmd,
    };
  }, starFieldOn);

  await page.waitForTimeout(800);

  const label = starFieldOn ? "default" : "cubemap";
  const out = path.join(OUT_DIR, `env-skybox-stars-${rendererArg}-${label}.png`);
  await page.screenshot({ path: out, fullPage: false });

  const gate = await collectGateErrors(page);
  await browser.close();

  return { out, meta, consoleErrors, gate };
}

// Star-pixel density + mean luminance of a capture.
async function analyze(pngPath) {
  const browser = await chromium.launch({ channel: "msedge", headless: true });
  const page = await browser.newPage();
  await page.setContent("<!doctype html><html><body></body></html>");
  const b64 = fs.readFileSync(pngPath).toString("base64");
  const stats = await page.evaluate(async (b64) => {
    const img = new Image();
    img.src = "data:image/png;base64," + b64;
    await img.decode();
    const w = img.naturalWidth;
    const h = img.naturalHeight;
    const cv = document.createElement("canvas");
    cv.width = w;
    cv.height = h;
    const ctx = cv.getContext("2d");
    ctx.drawImage(img, 0, 0);
    const d = ctx.getImageData(0, 0, w, h).data;

    let starPx = 0; // any pixel meaningfully above black
    let brightPx = 0;
    let lumSum = 0;
    for (let i = 0; i < d.length; i += 4) {
      const mx = Math.max(d[i], d[i + 1], d[i + 2]);
      const lum = 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
      lumSum += lum;
      if (mx > 8) starPx++;
      if (mx > 96) brightPx++;
    }
    const total = w * h;
    return {
      starPct: (100 * starPx) / total,
      brightPct: (100 * brightPx) / total,
      meanLum: lumSum / total,
    };
  }, b64);
  await browser.close();
  return stats;
}

// Pattern check: block-mean-luminance Pearson correlation between the two
// cube-map-only captures over a UI-free sky crop. The aligned correlation
// must beat the vertically-mirrored one (and be meaningfully positive) —
// a flipY regression mirrors every cube face, so the milky-way density
// gradient decorrelates when aligned and re-correlates when mirrored.
async function correlate(pngA, pngB) {
  const browser = await chromium.launch({ channel: "msedge", headless: true });
  const page = await browser.newPage();
  await page.setContent("<!doctype html><html><body></body></html>");
  const ba = fs.readFileSync(pngA).toString("base64");
  const bb = fs.readFileSync(pngB).toString("base64");
  const r = await page.evaluate(async ({ ba, bb }) => {
    const decode = async (b64) => {
      const img = new Image();
      img.src = "data:image/png;base64," + b64;
      await img.decode();
      const c = document.createElement("canvas");
      c.width = img.naturalWidth;
      c.height = img.naturalHeight;
      const x = c.getContext("2d");
      x.drawImage(img, 0, 0);
      return x.getImageData(0, 0, c.width, c.height);
    };
    const A = await decode(ba);
    const B = await decode(bb);
    // Sky-only crop: skip top toolbar, right help panel, bottom timeline +
    // WebGL ion attribution.
    const x0 = 40,
      x1 = 980,
      y0 = 300,
      y1 = 640;
    const BLOCK = 20;
    const gw = Math.floor((x1 - x0) / BLOCK);
    const gh = Math.floor((y1 - y0) / BLOCK);
    const grid = (im, flipV) => {
      const g = new Float64Array(gw * gh);
      for (let gy = 0; gy < gh; gy++) {
        for (let gx = 0; gx < gw; gx++) {
          let sum = 0;
          for (let dy = 0; dy < BLOCK; dy++) {
            for (let dx = 0; dx < BLOCK; dx++) {
              const px = x0 + gx * BLOCK + dx;
              let py = y0 + gy * BLOCK + dy;
              if (flipV) py = y1 - 1 - (gy * BLOCK + dy);
              const i = (py * im.width + px) * 4;
              sum +=
                0.2126 * im.data[i] +
                0.7152 * im.data[i + 1] +
                0.0722 * im.data[i + 2];
            }
          }
          g[gy * gw + gx] = sum / (BLOCK * BLOCK);
        }
      }
      return g;
    };
    const pearson = (a, b) => {
      const n = a.length;
      let ma = 0,
        mb = 0;
      for (let i = 0; i < n; i++) {
        ma += a[i];
        mb += b[i];
      }
      ma /= n;
      mb /= n;
      let num = 0,
        da = 0,
        db = 0;
      for (let i = 0; i < n; i++) {
        const xa = a[i] - ma;
        const xb = b[i] - mb;
        num += xa * xb;
        da += xa * xa;
        db += xb * xb;
      }
      const den = Math.sqrt(da * db);
      return den > 0 ? num / den : 0;
    };
    const gA = grid(A, false);
    const gB = grid(B, false);
    const gBflip = grid(B, true);
    return {
      aligned: pearson(gA, gB),
      mirrored: pearson(gA, gBflip),
    };
  }, { ba, bb });
  await browser.close();
  return r;
}

(async () => {
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
  console.log(`[env-skybox-stars] base=${BASE}`);

  const results = {};
  for (const renderer of ["webgpu", "webgl"]) {
    for (const starFieldOn of [false, true]) {
      const label = starFieldOn ? "default" : "cubemap";
      const r = await capture(renderer, starFieldOn);
      results[`${renderer}-${label}`] = r;
      const a = await analyze(r.out);
      results[`${renderer}-${label}`].stats = a;
      console.log(
        `\n-- ${renderer} / ${label} --\n` +
          `  meta: ${JSON.stringify(r.meta)}\n` +
          `  stats: ${JSON.stringify(a)}\n` +
          `  gate errors: ${r.gate ? r.gate.errors.length : "n/a"} ` +
          `deviceLost: ${r.gate ? r.gate.deviceLost : "n/a"} ` +
          `console faults: ${r.consoleErrors.length}`,
      );
      if (r.consoleErrors.length) {
        r.consoleErrors.slice(0, 5).forEach((e) => console.log("    " + e));
      }
    }
  }

  // Verdict: cube-map-only star density on WebGPU must be in family with WebGL.
  const gpu = results["webgpu-cubemap"].stats;
  const gl = results["webgl-cubemap"].stats;
  const densityRatio = gl.starPct > 0 ? gpu.starPct / gl.starPct : 0;
  const lumRatio = gl.meanLum > 0 ? gpu.meanLum / gl.meanLum : 0;
  const gateErrors = results["webgpu-cubemap"].gate.errors.length;

  // Same sky region (flipY parity): the aligned pattern correlation must be
  // meaningfully positive and beat the vertically-mirrored correlation.
  const corr = await correlate(
    results["webgpu-cubemap"].out,
    results["webgl-cubemap"].out,
  );

  const pass =
    densityRatio > 0.75 &&
    densityRatio < 1.33 &&
    lumRatio > 0.75 &&
    lumRatio < 1.33 &&
    corr.aligned > 0.5 &&
    corr.aligned > corr.mirrored &&
    gateErrors === 0;

  console.log(
    `\n== verdict == densityRatio(gpu/gl)=${densityRatio.toFixed(3)} ` +
      `lumRatio=${lumRatio.toFixed(3)} ` +
      `patternCorr aligned=${corr.aligned.toFixed(3)} ` +
      `mirrored=${corr.mirrored.toFixed(3)} gateErrors=${gateErrors} => ` +
      (pass ? "PASS" : "FAIL"),
  );

  console.log("\nPNGs:");
  for (const k of Object.keys(results)) {
    console.log("  " + path.resolve(results[k].out));
  }
  process.exit(pass ? 0 : 1);
})();
