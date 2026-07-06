#!/usr/bin/env node
// ACCEPTANCE / REGRESSION probe for NS-WEBGPU-OCEAN-BRIGHT-NO-WAVES.
// User-reported (2026-07-06) split-screen bug: at a low-oblique DAYTIME
// coastal view the WebGPU ocean renders TOO BRIGHT (flat washed-out cyan)
// AND LACKS the animated wave-noise/foam swirls that WebGL shows.
//
// Asserts, over an ocean-dominated crop:
//   (a) mean ocean brightness (WebGPU) within tolerance of WebGL,
//   (b) spatial wave-noise VARIANCE present on WebGPU comparable to WebGL,
//   (c) advancing the clock a few frames ANIMATES the WebGPU wave pattern
//       (temporal frame-to-frame delta over the ocean crop is non-trivial).
// READ the emitted PNGs — numbers alone don't prove the artifact is gone.
import { chromium } from "playwright";
import fs from "fs";
import path from "path";

const BASE = process.env.PROBE_BASE || "http://localhost:8080";
const OUT_DIR = "Tools/visual-regression/output";
// Low-oblique daytime coastal view: over ocean off Puerto Rico's north
// coast, camera low (18 km) pitched down toward the coastline.
const VIEW = "view=-66.4,18.9,18000,150,-18,0";
const DAY_ISO = "2026-07-03T16:00:00Z"; // Caribbean ~noon, sun high

// Ocean crop: lower-center of the 1280x720 frame (foreground water).
const CROP = { x0: 260, y0: 380, x1: 1020, y1: 700 };

async function launch() {
  return chromium.launch({
    channel: "msedge",
    headless: true,
    args: ["--enable-unsafe-webgpu", "--enable-features=Vulkan", "--use-vulkan", "--disable-cache"],
  });
}

// Capture N sequential frames (for animation check). Returns array of PNG paths.
async function captureFrames(rendererArg, { label, frames = 1, animate = false }) {
  const browser = await launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const messages = [];
  page.on("console", (m) => messages.push({ t: m.type(), text: m.text() }));
  page.on("pageerror", (e) => messages.push({ t: "pageerror", text: e.message }));

  const url = `${BASE}/Apps/CesiumViewer/index.html?renderer=${rendererArg}&${VIEW}`;
  await page.goto(url, { waitUntil: "networkidle" });
  await page.waitForFunction(() => !!window.viewer);

  // Settle tiles at a fixed clock.
  await page.evaluate(
    async ({ clockIso }) => {
      const v = window.viewer;
      const JulianDate = v.clock.currentTime.constructor;
      // Force continuous rendering so every scene.render() actually re-packs
      // globe tiles — matches the live app when the clock is animating
      // (each tick requests a render). Without this, requestRenderMode skips
      // globe re-render for a paused/near-static clock and the frame-driven
      // ocean animation can't be observed.
      v.scene.requestRenderMode = false;
      v.clock.shouldAnimate = false;
      v.clock.currentTime = JulianDate.fromIso8601(clockIso);
      for (let i = 0; i < 260; i++) {
        v.clock.currentTime = JulianDate.fromIso8601(clockIso);
        v.scene.render();
        await new Promise((r) => requestAnimationFrame(r));
      }
    },
    { clockIso: DAY_ISO },
  );
  await page.waitForTimeout(1200);

  const out = [];
  for (let f = 0; f < frames; f++) {
    if (f > 0) {
      // Mirror the LIVE user scenario: play the clock forward at a realistic
      // ~real-time rate (deterministic: fixed per-frame delta over a fixed
      // frame count) so the globe re-renders each frame on BOTH backends.
      // WebGL churns the ocean via `czm_frameNumber` (per rendered frame);
      // the WebGPU fix now mirrors that via `frameState.frameNumber`. The
      // small clock delta (~1.5 s total) contributes almost nothing to the
      // OLD clock-seconds path (octave shift ~0.018) but the frame-driven
      // fix advances the phase strongly — that difference is what we assert.
      await page.evaluate(
        async ({ clockIso, frames, dtSec }) => {
          const v = window.viewer;
          const JulianDate = v.clock.currentTime.constructor;
          const base = JulianDate.fromIso8601(clockIso);
          for (let i = 1; i <= frames; i++) {
            v.clock.currentTime = JulianDate.addSeconds(
              base,
              i * dtSec,
              new JulianDate(),
            );
            v.scene.render();
            await new Promise((r) => requestAnimationFrame(r));
          }
        },
        { clockIso: DAY_ISO, frames: 90, dtSec: 1.5 / 90 },
      );
      await page.waitForTimeout(300);
    }
    const p = path.join(OUT_DIR, `ocean-waves-${label}-${rendererArg}-f${f}.png`);
    await page.screenshot({ path: p, fullPage: false });
    out.push(p);
  }
  await browser.close();
  const errs = messages.filter((m) => m.t === "error" || m.t === "pageerror");
  if (errs.length) errs.slice(0, 3).forEach((e) => console.log(`    ${e.t}: ${e.text}`));
  return out;
}

// Analyze a PNG crop: mean luminance + spatial variance (high-freq wave detail
// via mean abs Laplacian). Optionally diff against a second PNG (temporal).
async function analyze(paths, crop) {
  const browser = await launch();
  const page = await browser.newPage();
  await page.setContent("<html><body></body></html>");
  const b64s = paths.map((p) => fs.readFileSync(p).toString("base64"));
  const res = await page.evaluate(
    async ({ b64s, crop }) => {
      const decode = async (b64) => {
        const img = new Image();
        img.src = "data:image/png;base64," + b64;
        await img.decode();
        const c = document.createElement("canvas");
        c.width = img.naturalWidth;
        c.height = img.naturalHeight;
        c.getContext("2d").drawImage(img, 0, 0);
        return {
          w: img.naturalWidth,
          h: img.naturalHeight,
          data: c.getContext("2d").getImageData(0, 0, c.width, c.height).data,
        };
      };
      const imgs = [];
      for (const b of b64s) imgs.push(await decode(b));
      const A = imgs[0];
      const lum = (d, i) => 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
      const idx = (x, y) => (y * A.w + x) * 4;
      // Mean luminance over crop.
      let sum = 0, n = 0;
      for (let y = crop.y0; y < crop.y1; y++) {
        for (let x = crop.x0; x < crop.x1; x++) {
          sum += lum(A.data, idx(x, y));
          n++;
        }
      }
      const meanLum = sum / n;
      // Spatial detail: mean abs Laplacian (4-neighbor) over crop.
      let lap = 0, ln = 0;
      for (let y = crop.y0 + 1; y < crop.y1 - 1; y++) {
        for (let x = crop.x0 + 1; x < crop.x1 - 1; x++) {
          const c = lum(A.data, idx(x, y));
          const l =
            4 * c -
            lum(A.data, idx(x - 1, y)) -
            lum(A.data, idx(x + 1, y)) -
            lum(A.data, idx(x, y - 1)) -
            lum(A.data, idx(x, y + 1));
          lap += Math.abs(l);
          ln++;
        }
      }
      const detail = lap / ln;
      // Temporal delta vs 2nd image (if present) over crop.
      let temporal = null;
      if (imgs.length > 1) {
        const B = imgs[1];
        let td = 0, tn = 0;
        for (let y = crop.y0; y < crop.y1; y++) {
          for (let x = crop.x0; x < crop.x1; x++) {
            const i = idx(x, y);
            td += Math.abs(lum(A.data, i) - lum(B.data, i));
            tn++;
          }
        }
        temporal = td / tn;
      }
      return { meanLum: +meanLum.toFixed(2), detail: +detail.toFixed(3), temporal: temporal === null ? null : +temporal.toFixed(3) };
    },
    { b64s, crop },
  );
  await browser.close();
  return res;
}

(async () => {
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

  console.log("== capture (2 frames each for animation) ==");
  const glFrames = await captureFrames("webgl", { label: "day", frames: 2 });
  const gpuFrames = await captureFrames("webgpu", { label: "day", frames: 2 });

  const gl = await analyze(glFrames, CROP);
  const gpu = await analyze(gpuFrames, CROP);

  console.log("  WebGL :", JSON.stringify(gl));
  console.log("  WebGPU:", JSON.stringify(gpu));

  const brightRatio = gpu.meanLum / Math.max(1, gl.meanLum);
  const detailRatio = gpu.detail / Math.max(0.001, gl.detail);
  console.log(`  brightness gpu/gl: ${brightRatio.toFixed(3)}  (target ~1.0, <1.35 acceptable)`);
  console.log(`  wave-detail gpu/gl: ${detailRatio.toFixed(3)}  (target >~0.4)`);
  console.log(`  WebGPU temporal wave delta: ${gpu.temporal}  (target >0.3 = animating)`);
  console.log(`  WebGL  temporal wave delta: ${gl.temporal}`);
  console.log("PNGs:", glFrames.concat(gpuFrames).join("  "));
  console.log("done");
})();
