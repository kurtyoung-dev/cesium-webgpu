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
//   mismatch ≤ {mid: 0.27%, far: 1.5%, extreme: 1.5%}
//     (limits tightened by GLOBE-POLAR-STRETCH-POLISH: the tile-seam grid
//     lines — 62% of the mid residual — were fixed by the fragment-entry UV
//     clamp, and the missing zoomed-out ocean sun glint — 63% of the far
//     residual — by the czm_getSpecular Phong port. Pre-polish baseline was
//     mid 0.27% / far 5.46%.)
//     THEN by Q9-STARFIELD-SPACE-BUCKET: the clock is now PINNED (shared Q7
//     determinism kit) so both backend launches render the identical sky.
//     Before pinning, the two separate browser launches happened seconds
//     apart at wall-clock "now", so the star-field TEME rotation + skybox
//     cubemap orientation differed a fraction of a degree between captures —
//     speckling the whole background with >30 mismatch pixels (the "space"
//     bucket, ~42% of the far mismatch, meanΔ≈0 = purely positional). A
//     dedicated diagnostic proved the fix: cross-backend space mismatch
//     6600px→102px and within-backend WebGPU→0px once pinned. That collapsed
//     far 3.63%→0.72% / extreme 4.59%→0.58%, so the ceilings drop to 1.5%.
//     The star renderers themselves are at parity (identical WGSL/GLSL, shared
//     StarFieldMath); the 102 residual px are the low-value STARFIELD-TUNE
//     sprite-brightness item, not a divergence this probe should tolerate 3%
//     of noise to hide.
//
// GLOBE-POLAR-STRETCH-POLISH adds a BUCKET DECOMPOSITION of the residual
// mismatch per view (printed + written to report.json):
//   space     — outside the globe disc (r > 1.02): stars/background
//   limb      — 0.90 < r ≤ 1.02: atmosphere ring brightness/falloff
//   seamThin  — interior thin structures (survive no 3x3 erosion): tile-seam
//               lines + AA/subpixel edge noise
//   interiorBlobGlBrighter / interiorBlobGpuBrighter — interior ≥3x3 blobs,
//               split by which backend is brighter (imagery/lighting/ocean)
// The seam gate additionally counts seamBlue: seamThin pixels with the
// dark-blue initialColor signature (gpu darker AND bluer) — the
// BUG-GLOBE-TILE-SEAM-LINES fingerprint, required ≈ 0 after the UV clamp.
//
// Usage: node Tools/visual-regression/probe-globe-polar-stretch.mjs
//        (dev server on :8080; Edge/msedge required for WebGPU)

import { chromium } from "playwright";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import {
  DET_BROWSER_SETUP,
  DETERMINISTIC_CLOCK_ISO,
} from "./lib/determinism-kit.mjs";

const BASE = process.env.PROBE_BASE || "http://localhost:8080";
const OUT_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "output",
  "globe-polar-stretch",
);
fs.mkdirSync(OUT_DIR, { recursive: true });

const VIEWS = [
  // Ceilings tightened by Q9-STARFIELD-SPACE-BUCKET: the far/extreme limits
  // used to be 3.5 / 4.5 only to tolerate the unpinned-clock star jitter
  // (~1.5% of the crop, ~42% of the far mismatch). With the clock now pinned
  // both backends render the identical sky, so the deterministic residual is
  // far 0.72% / extreme 0.58% (dominated by thin disc-edge AA + the high-lat
  // ground-atmosphere blob). 1.5% leaves ~2x headroom for tile-LOD wobble
  // while still catching a regression that re-introduces the star drift.
  { name: "mid", lon: -95, lat: 40, height: 2e6, maxMismatch: 0.27 },
  { name: "far", lon: -95, lat: 40, height: 25e6, maxMismatch: 1.5 },
  { name: "extreme", lon: -95, lat: 40, height: 55e6, maxMismatch: 1.5 },
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
  const page = await browser.newPage({
    viewport: { width: 1280, height: 720 },
  });
  const errs = [];
  page.on("pageerror", (e) => errs.push(e.message));
  await page.goto(`${BASE}/Apps/CesiumViewer/index.html?renderer=${renderer}`, {
    waitUntil: "networkidle",
  });
  await page.waitForFunction(() => !!window.viewer);
  await page.evaluate(
    async ({ lon, lat, height, det, iso }) => {
      const C = await import("/Build/CesiumUnminified/index.js");
      const v = window.viewer;
      // DETERMINISM (Q9-STARFIELD-SPACE-BUCKET / NEW-STARFIELD-SPACE-BUCKET-
      // RESIDUAL): the CesiumViewer clock starts at wall-clock "now", so the
      // star-field TEME rotation + skybox cubemap orientation differ between
      // the two SEPARATE browser launches (webgl vs webgpu) that this probe
      // fires seconds apart. That rotated the whole celestial sphere a
      // fraction of a degree between captures, speckling the entire background
      // with >30 mismatch pixels — the "space" bucket residual (was ~42% of
      // the far-view mismatch, meanΔ≈0 = positional, NOT a brightness bias).
      // Pinning the clock to a fixed epoch renders the identical sky on both
      // backends; the diagnostic measured the cross-backend space bucket
      // collapse from 6600px to 102px (and within-backend WebGPU to 0px),
      // proving the star renderers are at parity and the residual was probe
      // nondeterminism. Uses the shared Q7 determinism kit.
      // eslint-disable-next-line no-new-func
      new Function(det)();
      window.__det.pinClock(C, v, v.scene, iso);
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
    { ...view, det: DET_BROWSER_SETUP, iso: DETERMINISTIC_CLOCK_ISO },
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
      const lum = (d, i) =>
        0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];

      const cw = CROP.x1 - CROP.x0,
        ch = CROP.y1 - CROP.y0;
      const mmask = new Uint8Array(cw * ch); // 1 = mismatching pixel
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
          if (d > 30) {
            mismatch++;
            mmask[(y - CROP.y0) * cw + (x - CROP.x0)] = 1;
          }
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

      // ── Bucket decomposition (GLOBE-POLAR-STRETCH-POLISH) ──
      // Morphological opening: interior blobs are pixels surviving a 3x3
      // erosion then re-dilated; everything else interior is "thin"
      // (seam lines + AA edge noise).
      const morph = (m, isErode) => {
        const o = new Uint8Array(cw * ch);
        for (let y = 1; y < ch - 1; y++) {
          for (let x = 1; x < cw - 1; x++) {
            let acc = isErode ? 1 : 0;
            for (let dy = -1; dy <= 1; dy++) {
              for (let dx = -1; dx <= 1; dx++) {
                const v = m[(y + dy) * cw + (x + dx)];
                if (isErode && !v) acc = 0;
                if (!isErode && v) acc = 1;
              }
            }
            o[y * cw + x] = acc;
          }
        }
        return o;
      };
      const blob = morph(morph(mmask, true), false);
      const dcx = (disc.minX + disc.maxX) / 2;
      const dcy = (disc.minY + disc.maxY) / 2;
      const dR = (disc.maxX - disc.minX + (disc.maxY - disc.minY)) / 4;
      const counts = {
        space: 0,
        limb: 0,
        seamThin: 0,
        interiorBlobGlBrighter: 0,
        interiorBlobGpuBrighter: 0,
      };
      let seamBlue = 0;
      const sums = {};
      for (const k of Object.keys(counts)) sums[k] = { dr: 0, dg: 0, db: 0 };
      const maskImg = new Uint8ClampedArray(cw * ch * 4);
      for (let y = 0; y < ch; y++) {
        for (let x = 0; x < cw; x++) {
          const mi = y * cw + x;
          const px = x + CROP.x0,
            py = y + CROP.y0;
          const gi = 4 * (py * W + px);
          maskImg[4 * mi] = A.data[gi] * 0.25;
          maskImg[4 * mi + 1] = A.data[gi + 1] * 0.25;
          maskImg[4 * mi + 2] = A.data[gi + 2] * 0.25;
          maskImg[4 * mi + 3] = 255;
          if (!mmask[mi]) continue;
          const r = Math.hypot(px - dcx, py - dcy) / dR;
          let bucket, col;
          if (r > 1.02) {
            bucket = "space";
            col = [255, 0, 255];
          } else if (r > 0.9) {
            bucket = "limb";
            col = [255, 160, 0];
          } else if (!blob[mi]) {
            bucket = "seamThin";
            col = [0, 255, 255];
            // BUG-GLOBE-TILE-SEAM-LINES fingerprint: the exposed
            // initialColor (0, 0, 0.5) makes the GPU pixel both DARKER
            // and relatively BLUER than the GL pixel, AND absolutely dark
            // (navy, lum < 90) — the darkness gate excludes the bright
            // atmosphere-blue inner-limb gradient pixels that share the
            // darker+bluer delta signature but sit at lum ≈ 200.
            const gpuLum = lum(B.data, gi);
            const dlum = gpuLum - lum(A.data, gi);
            const dblue =
              B.data[gi + 2] -
              A.data[gi + 2] -
              (B.data[gi] - A.data[gi] + (B.data[gi + 1] - A.data[gi + 1])) / 2;
            if (dlum < -20 && dblue > 15 && gpuLum < 90) {
              seamBlue++;
              col = [0, 0, 255];
            }
          } else if (lum(A.data, gi) > lum(B.data, gi)) {
            bucket = "interiorBlobGlBrighter";
            col = [255, 0, 0];
          } else {
            bucket = "interiorBlobGpuBrighter";
            col = [0, 255, 0];
          }
          counts[bucket]++;
          sums[bucket].dr += B.data[gi] - A.data[gi];
          sums[bucket].dg += B.data[gi + 1] - A.data[gi + 1];
          sums[bucket].db += B.data[gi + 2] - A.data[gi + 2];
          maskImg[4 * mi] = col[0];
          maskImg[4 * mi + 1] = col[1];
          maskImg[4 * mi + 2] = col[2];
        }
      }
      const buckets = {};
      for (const k of Object.keys(counts)) {
        const n = counts[k];
        buckets[k] = {
          px: n,
          pctOfCrop: +((100 * n) / cropPx).toFixed(3),
          pctOfMismatch: +((100 * n) / Math.max(1, mismatch)).toFixed(1),
          meanDelta_gpuMinusGl: n
            ? {
                r: +(sums[k].dr / n).toFixed(1),
                g: +(sums[k].dg / n).toFixed(1),
                b: +(sums[k].db / n).toFixed(1),
              }
            : null,
        };
      }
      const mc = document.createElement("canvas");
      mc.width = cw;
      mc.height = ch;
      mc.getContext("2d").putImageData(new ImageData(maskImg, cw, ch), 0, 0);
      const maskB64 = mc.toDataURL("image/png").split(",")[1];

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
            const isIce =
              L > 130 && Math.abs(R - Bl) < 40 && Math.abs(R - G) < 40;
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
        mismatchPct: +mismatchPct.toFixed(3),
        discRadius: +PA.r.toFixed(1),
        icePxA: PA.icePx,
        icePxB: PB.icePx,
        iceCentroidYA:
          PA.iceCentroidY === null ? null : +PA.iceCentroidY.toFixed(1),
        iceCentroidYB:
          PB.iceCentroidY === null ? null : +PB.iceCentroidY.toFixed(1),
        bestShift_discUnits: +shifts[0].s.toFixed(3),
        buckets,
        seamBluePx: seamBlue,
        maskB64,
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
  if (res.maskB64) {
    fs.writeFileSync(
      path.join(OUT_DIR, `${view.name}-bucket-mask.png`),
      Buffer.from(res.maskB64, "base64"),
    );
    delete res.maskB64;
  }
  report[view.name] = res;

  const checks = [];
  const centroidShift =
    res.iceCentroidYA !== null && res.iceCentroidYB !== null
      ? Math.abs(res.iceCentroidYA - res.iceCentroidYB) / res.discRadius
      : 0;
  const iceRatio = res.icePxA > 200 ? res.icePxB / res.icePxA : 1; // skip when little ice visible
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
  // BUG-GLOBE-TILE-SEAM-LINES gate: dark-blue seam-fingerprint pixels must
  // be ~eliminated by the fragment-entry UV clamp (< 0.01% of the crop).
  checks.push({
    name: "seam-blue px (tile-seam fingerprint)",
    val: res.seamBluePx,
    ok: res.seamBluePx <= 45,
    limit: 45,
  });
  const viewOk = checks.every((c) => c.ok);
  if (!viewOk) failed = true;
  console.log(`  ${view.name}: ${viewOk ? "PASS" : "FAIL"}`);
  for (const c of checks) {
    console.log(
      `    ${c.ok ? "ok  " : "FAIL"} ${c.name}: ${c.val} (limit ${c.limit})`,
    );
  }
  console.log(`    bucket decomposition (% of mismatch | % of crop):`);
  for (const [k, b] of Object.entries(res.buckets)) {
    console.log(
      `      ${k.padEnd(24)} ${String(b.pctOfMismatch).padStart(5)}% | ${b.pctOfCrop}%  meanΔ(gpu−gl)=${b.meanDelta_gpuMinusGl ? JSON.stringify(b.meanDelta_gpuMinusGl) : "-"}`,
    );
  }
}
fs.writeFileSync(
  path.join(OUT_DIR, "report.json"),
  JSON.stringify(report, null, 2),
);
console.log(`[polar-stretch] PNGs + report.json in ${OUT_DIR}`);
console.log(
  failed ? "[polar-stretch] OVERALL: FAIL" : "[polar-stretch] OVERALL: PASS",
);
process.exit(failed ? 1 : 0);
