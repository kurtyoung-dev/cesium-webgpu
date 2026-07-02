#!/usr/bin/env node
// probe-globe-polar-stretch.mjs — GLOBE-POLAR-STRETCH acceptance probe.
//
// USER-REPORTED (2026-07-02): the zoomed-out WebGPU globe stretched high
// latitudes toward the equator — worse the further out. Root cause: the
// WGSL Mercator→geographic reprojection (`ReprojectWebMercator.wgsl`)
// carried a spurious double vertical flip (`v_geo = 1-y` + `srcV =
// 1-mercatorFraction`) that cancels only for imagery tiles symmetric
// about the equator. Far-zoom terrain tiles (level 0-2, spanning past
// ±85°) all sample the REPROJECTED texture (`useWebMercatorT=false`), so
// the whole disc showed latitude-mirror-warped imagery. Mid zoom binds
// the raw Mercator texture (`useWebMercatorT=true` path) and was always
// clean — which is why the bug was zoom-gated.
//
// THREE views, WebGL vs WebGPU (default CesiumViewer = Bing Mercator
// imagery over CesiumTerrainProvider):
//   mid     (-95, 40, 2e6 m)    — regression guard; was already at parity
//   far     (-95, 40, 25e6 m)   — first user screenshot (Greenland squashed)
//   extreme (-95, 40, 55e6 m)   — second user screenshot (max zoom-out)
//
// Measures, inside the consensus globe disc:
//   - plain pixel mismatch % (informational + generous ceiling)
//   - ice/white-pixel centroid Y (Greenland/arctic pack ice) in
//     disc-radius units — the latitude-band alignment metric
//   - ice pixel area ratio
//   - best vertical shift aligning the top-half land-fraction profiles
//
// PASS criteria per view (disc-relative units so all zooms compare):
//   |iceCentroidY_gl − iceCentroidY_gpu| ≤ 0.025 · discRadius
//   ice area ratio within [0.85, 1.18]
//   |bestTopHalfShift| ≤ 0.02 · discRadius
//   mismatch ≤ {mid: 4%, far: 12%, extreme: 14%}   (residual = atmosphere
//     limb brightness + WebGPU tile-seam lines, tracked separately)
//
// Usage: node Tools/visual-regression/probe-globe-polar-stretch.mjs
//        (dev server on :8080; Edge/msedge required for WebGPU)

import { chromium } from "playwright";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const BASE = "http://localhost:8080";
const OUT_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "output",
  "globe-polar-stretch",
);
fs.mkdirSync(OUT_DIR, { recursive: true });

const VIEWS = [
  { name: "mid", lon: -95, lat: 40, height: 2e6, maxMismatch: 4 },
  { name: "far", lon: -95, lat: 40, height: 25e6, maxMismatch: 12 },
  { name: "extreme", lon: -95, lat: 40, height: 55e6, maxMismatch: 14 },
];
const MAX_CENTROID_SHIFT = 0.025; // disc-radius units
const MAX_PROFILE_SHIFT = 0.02; // disc-radius units
const ICE_RATIO_RANGE = [0.85, 1.18];

async function capture(renderer, view) {
  const browser = await chromium.launch({
    channel: "msedge",
    headless: true,
    args: [
      "--enable-unsafe-webgpu",
      "--enable-features=Vulkan",
      "--use-vulkan",
      "--disable-cache",
    ],
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const errs = [];
  page.on("pageerror", (e) => errs.push(e.message));
  await page.goto(`${BASE}/Apps/CesiumViewer/index.html?renderer=${renderer}`, {
    waitUntil: "networkidle",
  });
  await page.waitForFunction(() => !!window.viewer);
  await page.evaluate(
    async ({ lon, lat, height }) => {
      const C = await import("/Build/CesiumUnminified/index.js");
      const v = window.viewer;
      v.clock.shouldAnimate = false;
      v.scene.screenSpaceCameraController.enableInputs = false;
      v.camera.setView({
        destination: C.Cartesian3.fromDegrees(lon, lat, height),
        orientation: { heading: 0, pitch: -C.Math.PI_OVER_TWO, roll: 0 },
      });
      for (let i = 0; i < 1500; i++) {
        v.scene.render();
        await new Promise((r) => requestAnimationFrame(r));
        if (v.scene.globe.tilesLoaded && i > 240) break;
      }
    },
    view,
  );
  await page.waitForTimeout(2000);
  const out = path.join(OUT_DIR, `${view.name}-${renderer}.png`);
  await page.screenshot({ path: out, fullPage: false });
  await browser.close();
  if (errs.length) {
    console.log(`  [${renderer}/${view.name}] page errors: ${errs[0]}`);
  }
  return out;
}

// Decode PNGs in a browser page (no Node PNG dep); run the disc /
// latitude-band analysis + plain mismatch diff inside the crop.
async function analyze(pngA, pngB) {
  const browser = await chromium.launch({ channel: "msedge", headless: true });
  const page = await browser.newPage();
  await page.setContent("<html><body></body></html>");
  const ba = fs.readFileSync(pngA).toString("base64");
  const bb = fs.readFileSync(pngB).toString("base64");
  const result = await page.evaluate(
    async ({ ba, bb }) => {
      const decode = async (b64) => {
        const img = new Image();
        img.src = "data:image/png;base64," + b64;
        await img.decode();
        const c = document.createElement("canvas");
        c.width = img.naturalWidth;
        c.height = img.naturalHeight;
        const ctx = c.getContext("2d");
        ctx.drawImage(img, 0, 0);
        return {
          w: img.naturalWidth,
          h: img.naturalHeight,
          data: ctx.getImageData(0, 0, c.width, c.height).data,
        };
      };
      const A = await decode(ba);
      const B = await decode(bb);
      if (A.w !== B.w || A.h !== B.h) return { error: "size mismatch" };
      const W = A.w,
        H = A.h;
      // Crop out CesiumViewer UI chrome (toolbar, help panel, timeline).
      const CROP = { x0: 250, x1: 1010, y0: 45, y1: 640 };
      const lum = (d, i) => 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];

      let mismatch = 0,
        cropPx = 0;
      for (let y = CROP.y0; y < CROP.y1; y++) {
        for (let x = CROP.x0; x < CROP.x1; x++) {
          const i = 4 * (y * W + x);
          cropPx++;
          const d =
            Math.abs(A.data[i] - B.data[i]) +
            Math.abs(A.data[i + 1] - B.data[i + 1]) +
            Math.abs(A.data[i + 2] - B.data[i + 2]);
          if (d > 30) mismatch++;
        }
      }
      const mismatchPct = (100 * mismatch) / cropPx;

      // Consensus globe disc: rows/cols with many bright pixels in BOTH
      // images (cameras identical → identical true disc geometry).
      const detectDisc = (im) => {
        const d = im.data;
        const rowCnt = new Array(H).fill(0);
        const colCnt = new Array(W).fill(0);
        for (let y = CROP.y0; y < CROP.y1; y++) {
          for (let x = CROP.x0; x < CROP.x1; x++) {
            if (lum(d, 4 * (y * W + x)) > 24) {
              rowCnt[y]++;
              colCnt[x]++;
            }
          }
        }
        let minX = -1,
          maxX = -1,
          minY = -1,
          maxY = -1;
        for (let y = 0; y < H; y++)
          if (rowCnt[y] >= 30) {
            if (minY < 0) minY = y;
            maxY = y;
          }
        for (let x = 0; x < W; x++)
          if (colCnt[x] >= 30) {
            if (minX < 0) minX = x;
            maxX = x;
          }
        return { minX, maxX, minY, maxY };
      };
      const dA = detectDisc(A);
      const dB = detectDisc(B);
      const disc = {
        minX: Math.max(dA.minX, dB.minX),
        maxX: Math.min(dA.maxX, dB.maxX),
        minY: Math.max(dA.minY, dB.minY),
        maxY: Math.min(dA.maxY, dB.maxY),
      };

      const profile = (im) => {
        const d = im.data;
        const { minX, maxX, minY, maxY } = disc;
        const cx = (minX + maxX) / 2;
        const cy = (minY + maxY) / 2;
        const r = (maxX - minX + (maxY - minY)) / 4;
        const rows = [];
        for (let y = Math.ceil(cy - r); y <= Math.floor(cy + r); y++) {
          if (y < 0 || y >= H) continue;
          const dy = (y - cy) / r;
          if (Math.abs(dy) > 0.93) continue;
          const halfW = Math.sqrt(Math.max(0, 1 - dy * dy)) * r * 0.93;
          if (halfW < 3) continue;
          let n = 0,
            land = 0,
            ice = 0;
          const x0 = Math.max(0, Math.ceil(cx - halfW));
          const x1 = Math.min(W - 1, Math.floor(cx + halfW));
          for (let x = x0; x <= x1; x++) {
            const i = 4 * (y * W + x);
            const R = d[i],
              G = d[i + 1],
              Bl = d[i + 2];
            n++;
            const L = 0.2126 * R + 0.7152 * G + 0.0722 * Bl;
            const isIce = L > 130 && Math.abs(R - Bl) < 40 && Math.abs(R - G) < 40;
            const isLand = isIce || (R > Bl + 8 && L > 30);
            if (isIce) ice++;
            if (isLand) land++;
          }
          rows.push({ y, v: dy, landFrac: land / n, iceCnt: ice });
        }
        let iceSum = 0,
          iceWY = 0;
        for (const rr of rows) {
          iceSum += rr.iceCnt;
          iceWY += rr.iceCnt * rr.y;
        }
        return {
          r,
          cy,
          rows,
          icePx: iceSum,
          iceCentroidY: iceSum > 0 ? iceWY / iceSum : null,
        };
      };
      const PA = profile(A);
      const PB = profile(B);

      // Best vertical alignment of top-half land profiles (disc units).
      const sample = (P, v) => {
        let best = null,
          bd = 1e9;
        for (const rr of P.rows) {
          const dd = Math.abs(rr.v - v);
          if (dd < bd) {
            bd = dd;
            best = rr;
          }
        }
        return best ? best.landFrac : 0;
      };
      const shifts = [];
      for (let s = -0.2; s <= 0.2001; s += 0.005) {
        let err = 0,
          cnt = 0;
        for (let v = -0.9; v <= 0; v += 0.01) {
          err += Math.abs(sample(PA, v) - sample(PB, v + s));
          cnt++;
        }
        shifts.push({ s, err: err / cnt });
      }
      shifts.sort((a, b) => a.err - b.err);

      return {
        mismatchPct: +mismatchPct.toFixed(2),
        discRadius: +PA.r.toFixed(1),
        icePxA: PA.icePx,
        icePxB: PB.icePx,
        iceCentroidYA: PA.iceCentroidY === null ? null : +PA.iceCentroidY.toFixed(1),
        iceCentroidYB: PB.iceCentroidY === null ? null : +PB.iceCentroidY.toFixed(1),
        bestShift_discUnits: +shifts[0].s.toFixed(3),
      };
    },
    { ba, bb },
  );
  await browser.close();
  return result;
}

let failed = false;
const report = {};
for (const view of VIEWS) {
  console.log(`[polar-stretch] capturing ${view.name} (h=${view.height} m)`);
  const gl = await capture("webgl", view);
  const gpu = await capture("webgpu", view);
  const res = await analyze(gl, gpu);
  report[view.name] = res;

  const checks = [];
  const centroidShift =
    res.iceCentroidYA !== null && res.iceCentroidYB !== null
      ? Math.abs(res.iceCentroidYA - res.iceCentroidYB) / res.discRadius
      : 0;
  const iceRatio =
    res.icePxA > 200 ? res.icePxB / res.icePxA : 1; // skip when little ice visible
  checks.push({
    name: "ice centroid Y shift",
    val: +centroidShift.toFixed(4),
    ok: centroidShift <= MAX_CENTROID_SHIFT,
    limit: MAX_CENTROID_SHIFT,
  });
  checks.push({
    name: "ice area ratio (gpu/gl)",
    val: +iceRatio.toFixed(3),
    ok: iceRatio >= ICE_RATIO_RANGE[0] && iceRatio <= ICE_RATIO_RANGE[1],
    limit: ICE_RATIO_RANGE.join(".."),
  });
  checks.push({
    name: "top-half profile shift",
    val: Math.abs(res.bestShift_discUnits),
    ok: Math.abs(res.bestShift_discUnits) <= MAX_PROFILE_SHIFT,
    limit: MAX_PROFILE_SHIFT,
  });
  checks.push({
    name: "pixel mismatch %",
    val: res.mismatchPct,
    ok: res.mismatchPct <= view.maxMismatch,
    limit: view.maxMismatch,
  });
  const viewOk = checks.every((c) => c.ok);
  if (!viewOk) failed = true;
  console.log(`  ${view.name}: ${viewOk ? "PASS" : "FAIL"}`);
  for (const c of checks) {
    console.log(
      `    ${c.ok ? "ok  " : "FAIL"} ${c.name}: ${c.val} (limit ${c.limit})`,
    );
  }
}
fs.writeFileSync(
  path.join(OUT_DIR, "report.json"),
  JSON.stringify(report, null, 2),
);
console.log(`[polar-stretch] PNGs + report.json in ${OUT_DIR}`);
console.log(failed ? "[polar-stretch] OVERALL: FAIL" : "[polar-stretch] OVERALL: PASS");
process.exit(failed ? 1 : 0);
