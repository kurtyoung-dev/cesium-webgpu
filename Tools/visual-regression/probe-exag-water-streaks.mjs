#!/usr/bin/env node
// Regression probe for Q12-EXAG-WATER-STREAKS (NEW-WEBGPU-EXAG-WATER-STREAKS).
//
// PREMISE (now stale/RESOLVED): under high vertical exaggeration over Himalaya
// glacial-lake terrain (EXAG=10, lon 86.9 lat 27.0 h 250km), WebGPU used to
// render thin BRIGHT-BLUE water streaks WebGL lacks. Batch 379 localised it to
// a globe-FS water-fragment colour/saturation divergence: with atmosphere OFF
// on both, WebGL lakes went grey-bright (~0 blue-streak px) but WebGPU lakes
// STAYED saturated dark-blue (2452 px @ meanRGB(18,17,123)) — the blue lived in
// the water fragment itself, independent of atmosphere + LOD. Q10 (Batch 541,
// NEW-GLOBE-DAYTIME-OCEAN-BRIGHTNESS) fixed the GlobeTerrain.wgsl
// computeEnhancedOcean water-fragment highlight taper (dayFade -> lightingFade
// + distance-faded tsPerturbationRatio), which is exactly that path — so the
// exaggerated-lake streaks are gone too.
//
// This probe LOCKS that fix in with two assertions:
//   (A) CORE REGRESSION GUARD — with atmosphere OFF, WebGPU must NOT render
//       saturated water fragments. blueStreakPx(webgpu-off) must be small
//       (pre-fix 2452 -> post-fix 0). This is the signature of the bug.
//   (B) CROSS-BACKEND PARITY — with atmosphere ON, WebGPU water colour must
//       track WebGL (the shared atmosphere drape). meanB within tolerance and
//       blue-streak-px ratio near 1.
//
// The "bright-blue streak" metric (B>90 && B-R>25 && B-G>10, cropping UI + the
// star sky) is colour-selective: the star field is grey (R~=G~=B) so it never
// matches, making the metric robust to the (pinned-but-harmless) star field.
//
// Usage: PROBE_BASE=http://localhost:8080 node Tools/visual-regression/probe-exag-water-streaks.mjs
import { chromium } from "playwright";
import { writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { DET_BROWSER_SETUP, DETERMINISTIC_CLOCK_ISO } from "./lib/determinism-kit.mjs";

const __dir = dirname(fileURLToPath(import.meta.url));
const OUT = join(__dir, "output");
mkdirSync(OUT, { recursive: true });
const BASE = process.env.PROBE_BASE || "http://localhost:8080";

const browser = await chromium.launch({
  channel: "msedge",
  headless: true,
  args: ["--enable-unsafe-webgpu"],
});

async function capture(renderer, killAtmosphere) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  await page.goto(`${BASE}/Apps/CesiumViewer/index.html?renderer=${renderer}`, {
    waitUntil: "networkidle",
  });
  await page.waitForFunction(() => !!window.viewer);
  const res = await page.evaluate(
    async ({ killAtmo, det, iso }) => {
      const v = window.viewer,
        s = v.scene,
        c = v.camera;
      // Pin the clock so the sun/star field are constant run-to-run.
      // eslint-disable-next-line no-new-func
      new Function(det)();
      const C = await import("/Build/CesiumUnminified/index.js");
      window.__det.pinClock(C, v, s, iso);
      s.verticalExaggeration = 10;
      s.highDynamicRange = false; // remove HDR tonemap as a variable
      if (killAtmo) {
        s.fog.enabled = false;
        if (s.skyAtmosphere) s.skyAtmosphere.show = false;
        s.globe.showGroundAtmosphere = false;
      }
      const ell = s.ellipsoid ?? s.globe.ellipsoid;
      const dest = ell.cartographicToCartesian({
        longitude: (86.9 * Math.PI) / 180,
        latitude: (27.0 * Math.PI) / 180,
        height: 250000,
      });
      const setIt = () =>
        c.setView({ destination: dest, orientation: { heading: 0, pitch: -0.45, roll: 0 } });
      setIt();
      await window.__det.settleTiles(s, { stableFrames: 30, maxFrames: 1500 });
      setIt();
      for (let i = 0; i < 60; i++) {
        s.initializeFrame();
        s.render();
        await new Promise((r) => requestAnimationFrame(r));
      }
      return { dataUrl: s.canvas.toDataURL("image/png") };
    },
    { killAtmo: killAtmosphere, det: DET_BROWSER_SETUP, iso: DETERMINISTIC_CLOCK_ISO },
  );
  writeFileSync(
    join(OUT, `exag-water-${renderer}-${killAtmosphere ? "off" : "on"}.png`),
    Buffer.from(res.dataUrl.split(",")[1], "base64"),
  );
  const stat = await page.evaluate(async (b64) => {
    const blob = await (await fetch(`data:image/png;base64,${b64}`)).blob();
    const bmp = await createImageBitmap(blob);
    const off = new OffscreenCanvas(bmp.width, bmp.height);
    const cx = off.getContext("2d");
    cx.drawImage(bmp, 0, 0);
    const d = cx.getImageData(0, 0, bmp.width, bmp.height).data;
    let n = 0,
      sr = 0,
      sg = 0,
      sb = 0;
    const w = bmp.width;
    for (let i = 0; i < d.length; i += 4) {
      const x = (i / 4) % w,
        y = Math.floor(i / 4 / w);
      if (y < 40 || x > 1000) continue; // skip sky-heavy top + UI on the right
      const R = d[i],
        G = d[i + 1],
        B = d[i + 2];
      if (B > 90 && B - R > 25 && B - G > 10) {
        n++;
        sr += R;
        sg += G;
        sb += B;
      }
    }
    return {
      blueStreakPx: n,
      meanR: n ? +(sr / n).toFixed(1) : 0,
      meanG: n ? +(sg / n).toFixed(1) : 0,
      meanB: n ? +(sb / n).toFixed(1) : 0,
    };
  }, res.dataUrl.split(",")[1]);
  await page.close();
  return stat;
}

const grid = {};
for (const r of ["webgl", "webgpu"]) {
  for (const killAtmo of [false, true]) {
    const key = `${r}-${killAtmo ? "off" : "on"}`;
    grid[key] = await capture(r, killAtmo);
    console.log(
      `${key}: blueStreakPx=${grid[key].blueStreakPx} meanRGB=(${grid[key].meanR},${grid[key].meanG},${grid[key].meanB})`,
    );
  }
}
await browser.close();

// (A) CORE REGRESSION GUARD: WebGPU water must not stay saturated blue with
// atmosphere OFF (pre-fix 2452 px; post-fix 0). Guard well below the bug value.
const gpuOffBlue = grid["webgpu-off"].blueStreakPx;
const glOffBlue = grid["webgl-off"].blueStreakPx;
const CORE_MAX = 300;
const coreOk = gpuOffBlue <= CORE_MAX && gpuOffBlue <= glOffBlue + CORE_MAX;

// (B) CROSS-BACKEND PARITY with atmosphere ON: shared drape, colours track.
const glB = grid["webgl-on"].meanB,
  gpuB = grid["webgpu-on"].meanB;
const glPx = grid["webgl-on"].blueStreakPx,
  gpuPx = grid["webgpu-on"].blueStreakPx;
const meanBOk = Math.abs(glB - gpuB) <= 15;
const ratio = glPx > 0 ? gpuPx / glPx : 0;
const ratioOk = ratio >= 0.7 && ratio <= 1.4;

console.log("\n=== ASSERTIONS ===");
console.log(
  `(A) core guard: webgpu-off blueStreakPx=${gpuOffBlue} (<=${CORE_MAX}, webgl-off=${glOffBlue}) -> ${coreOk ? "OK" : "FAIL"}`,
);
console.log(
  `(B) parity ON: meanB gl=${glB} gpu=${gpuB} (|d|<=15 -> ${meanBOk ? "OK" : "FAIL"}); px ratio=${ratio.toFixed(3)} (0.7-1.4 -> ${ratioOk ? "OK" : "FAIL"})`,
);

const pass = coreOk && meanBOk && ratioOk;
console.log(pass ? "\nPASS" : "\nFAIL");
process.exit(pass ? 0 : 1);
