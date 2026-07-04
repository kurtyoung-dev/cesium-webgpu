#!/usr/bin/env node
// ACCEPTANCE / REGRESSION probe for PARITY-GLOBE-RIVER-WATER-INTENSITY (Q11).
// Inland rivers/lakes (St. Lawrence is the visual reference) render bright
// blue on WebGL but subdued/darker on WebGPU. This probe pins a DAYTIME sun
// over the St. Lawrence estuary and captures WebGL vs WebGPU, reporting both
// a whole-frame mismatch AND a WATER-SELECTIVE metric: mean luminance / blue
// channel over "blue water" pixels only (blue dominant + bright), which
// isolates the river-intensity delta from surrounding land/atmosphere.
//
// PASS: water-pixel meanLum(webgpu) within ~10% of meanLum(webgl); whole-frame
//       mismatch does not regress vs the standing globe residual.
import { chromium } from "playwright";
import fs from "fs";
import path from "path";

const BASE = process.env.PROBE_BASE || "http://localhost:8080";
const OUT_DIR = "Tools/visual-regression/output";
// St. Lawrence estuary near Quebec City — the river is wide + water-masked,
// looking down-river to the NE. Daytime so the water is lit bright blue.
const VIEW = "view=-70.6,47.2,180000";
const DAY_ISO = "2026-07-03T15:30:00Z"; // Quebec local ~10:30am, sun up

async function capture(rendererArg, label) {
  const browser = await chromium.launch({
    channel: "msedge",
    headless: true,
    args: ["--enable-unsafe-webgpu", "--enable-features=Vulkan", "--use-vulkan", "--disable-cache"],
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const messages = [];
  page.on("console", (m) => messages.push({ t: m.type(), text: m.text() }));
  page.on("pageerror", (e) => messages.push({ t: "pageerror", text: e.message }));

  const url = `${BASE}/Apps/CesiumViewer/index.html?renderer=${rendererArg}&${VIEW}`;
  await page.goto(url, { waitUntil: "networkidle" });
  await page.waitForFunction(() => !!window.viewer);

  await page.evaluate(
    async ({ clockIso }) => {
      const v = window.viewer;
      const JulianDate = v.clock.currentTime.constructor;
      v.clock.shouldAnimate = false;
      v.clock.currentTime = JulianDate.fromIso8601(clockIso);
      for (const el of document.querySelectorAll(
        ".cesium-viewer-toolbar, .cesium-viewer-animationContainer, " +
          ".cesium-viewer-timelineContainer, .cesium-viewer-bottom, " +
          ".cesium-widget-credits, #toolbar",
      )) {
        el.style.display = "none";
      }
      // Settle tiles + hold the clock so both backends see identical sun.
      for (let i = 0; i < 400; i++) {
        v.clock.currentTime = JulianDate.fromIso8601(clockIso);
        v.scene.render();
        await new Promise((r) => requestAnimationFrame(r));
      }
    },
    { clockIso: DAY_ISO },
  );
  await page.waitForTimeout(1500);

  const out = path.join(OUT_DIR, `probe-river-${label}-${rendererArg}.png`);
  await page.screenshot({ path: out, fullPage: false });
  await browser.close();
  const errs = messages.filter((m) => m.t === "error" || m.t === "pageerror");
  if (errs.length) errs.slice(0, 3).forEach((e) => console.log(`    ${e.t}: ${e.text}`));
  return out;
}

async function analyze(a, b) {
  const browser = await chromium.launch({ channel: "msedge", headless: true });
  const page = await browser.newPage();
  await page.setContent("<html><body></body></html>");
  const ba = fs.readFileSync(a).toString("base64");
  const bb = fs.readFileSync(b).toString("base64");
  const result = await page.evaluate(
    async ({ ba, bb }) => {
      const decode = async (b64) => {
        const img = new Image();
        img.src = "data:image/png;base64," + b64;
        await img.decode();
        const c = document.createElement("canvas");
        c.width = img.naturalWidth;
        c.height = img.naturalHeight;
        c.getContext("2d").drawImage(img, 0, 0);
        return { w: img.naturalWidth, h: img.naturalHeight, data: c.getContext("2d").getImageData(0, 0, c.width, c.height).data };
      };
      const A = await decode(ba), B = await decode(bb);
      if (A.w !== B.w || A.h !== B.h) return { error: "size mismatch" };
      const total = A.w * A.h;
      // "blue water" pixel = blue dominant over red & green, and not sky
      // (exclude very top rows) — count in EITHER backend so a subdued
      // WebGPU pixel that no longer reads as blue is still measured.
      const isWater = (r, g, bl, y, h) =>
        y > h * 0.25 && bl > r + 8 && bl > g + 4 && bl > 40 && bl < 250;
      let mismatch = 0, sum = 0;
      let nA = 0, lumA = 0, blueA = 0;
      let nB = 0, lumB = 0, blueB = 0;
      let nBoth = 0, lumBothA = 0, lumBothB = 0, blueBothA = 0, blueBothB = 0;
      for (let i = 0, px = 0; i < A.data.length; i += 4, px++) {
        const y = Math.floor(px / A.w);
        const ra = A.data[i], ga = A.data[i + 1], ba2 = A.data[i + 2];
        const rb = B.data[i], gb = B.data[i + 1], bb2 = B.data[i + 2];
        const d = Math.abs(ra - rb) + Math.abs(ga - gb) + Math.abs(ba2 - bb2);
        sum += d;
        if (d > 30) mismatch++;
        const la = 0.2126 * ra + 0.7152 * ga + 0.0722 * ba2;
        const lb = 0.2126 * rb + 0.7152 * gb + 0.0722 * bb2;
        const wa = isWater(ra, ga, ba2, y, A.h);
        const wb = isWater(rb, gb, bb2, y, A.h);
        if (wa) { nA++; lumA += la; blueA += ba2; }
        if (wb) { nB++; lumB += lb; blueB += bb2; }
        if (wa && wb) { nBoth++; lumBothA += la; lumBothB += lb; blueBothA += ba2; blueBothB += bb2; }
      }
      return {
        mismatchPct: (100 * mismatch / total).toFixed(2),
        meanDelta: (sum / total).toFixed(2),
        // A = first arg (webgl), B = second arg (webgpu)
        waterPx_gl: nA, waterPx_gpu: nB, waterPx_both: nBoth,
        waterLum_gl: (lumA / Math.max(1, nA)).toFixed(1),
        waterLum_gpu: (lumB / Math.max(1, nB)).toFixed(1),
        waterBlue_gl: (blueA / Math.max(1, nA)).toFixed(1),
        waterBlue_gpu: (blueB / Math.max(1, nB)).toFixed(1),
        bothLum_gl: (lumBothA / Math.max(1, nBoth)).toFixed(1),
        bothLum_gpu: (lumBothB / Math.max(1, nBoth)).toFixed(1),
        bothBlue_gl: (blueBothA / Math.max(1, nBoth)).toFixed(1),
        bothBlue_gpu: (blueBothB / Math.max(1, nBoth)).toFixed(1),
      };
    },
    { ba, bb },
  );
  await browser.close();
  return result;
}

(async () => {
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
  console.log("== St. Lawrence river, DAYTIME ==");
  const gl = await capture("webgl", "day");
  const gpu = await capture("webgpu", "day");
  const r = await analyze(gl, gpu);
  console.log(JSON.stringify(r, null, 2));
  console.log("PNGs:\n  " + gl + "\n  " + gpu);
})();
