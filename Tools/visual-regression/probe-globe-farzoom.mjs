#!/usr/bin/env node
// probe-globe-farzoom.mjs — FARZOOM-INTERIOR-BLOBS (Q23) diagnostic probe.
//
// GOAL (TIER3 diagnostic): root-cause far-zoom residual **bucket (b)** —
// the interior "GPU brighter" blobs concentrated over high-latitude snowy
// terrain (Alaska/arctic) at the 25 Mm default-viewer far camera. Measured
// by GLOBE-POLAR-STRETCH-POLISH at 32.2% of the far-view mismatch
// (0.72% of the crop), meanΔ(gpu−gl) ≈ +25 R/G/B. Two suspects were named
// in DEFERRED_WORK BUG-GLOBE-FARZOOM-RESIDUAL-FLOOR:
//   (1) ground-atmosphere intensity divergence (the WGSL per-fragment
//       drape vs the WebGL per-vertex/per-fragment split), and/or
//   (2) mip/LOD-bias divergence on high-contrast imagery.
//
// DIAGNOSTIC METHOD (per the queue row): toggle `scene.globe.
// showGroundAtmosphere` on BOTH backends at the far view and RE-BUCKET.
//   - If bucket (b) collapses with ground-atmosphere OFF → the drape is the
//     root cause (suspect 1). The residual with atmo OFF isolates the pure
//     imagery/lighting/mip term (suspect 2).
//   - If bucket (b) survives with ground-atmosphere OFF → the drape is NOT
//     the cause; it's imagery mip/LOD-bias (suspect 2), and the atmosphere
//     lever has no payoff here.
//
// Four captures at the ONE far view (-95, 40, 25 Mm), clock PINNED (shared
// Q7/Q9 determinism kit so both launches render the identical sky — see
// probe-globe-polar-stretch.mjs for why that matters):
//   webgl-atmoOn   webgpu-atmoOn   webgl-atmoOff   webgpu-atmoOff
// Then two GPU-vs-GL diffs (atmoOn, atmoOff), each bucketed with the SAME
// morphological decomposition probe-globe-polar-stretch.mjs uses. The
// headline number is `interiorBlobGpuBrighter` px (bucket b) for On vs Off.
//
// This is a DIAGNOSTIC probe — it prints the re-bucket and writes PNGs +
// report.json; it does not gate a fix (no runtime code changed by Q23).
//
// Usage: node Tools/visual-regression/probe-globe-farzoom.mjs
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
  "globe-farzoom",
);
fs.mkdirSync(OUT_DIR, { recursive: true });

const VIEW = { lon: -95, lat: 40, height: 25e6 };

async function capture(renderer, atmo) {
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
    async ({ lon, lat, height, atmo, det, iso }) => {
      const C = await import("/Build/CesiumUnminified/index.js");
      const v = window.viewer;
      // eslint-disable-next-line no-new-func
      new Function(det)();
      window.__det.pinClock(C, v, v.scene, iso);
      v.scene.screenSpaceCameraController.enableInputs = false;
      // The diagnostic toggle. Default is true for WGS84; forcing false on
      // BOTH backends removes the ground-atmosphere drape so the re-bucket
      // isolates whether bucket (b) is the drape or the underlying imagery.
      v.scene.globe.showGroundAtmosphere = atmo;
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
    { ...VIEW, atmo, det: DET_BROWSER_SETUP, iso: DETERMINISTIC_CLOCK_ISO },
  );
  await page.waitForTimeout(2000);
  const out = path.join(
    OUT_DIR,
    `${atmo ? "atmoOn" : "atmoOff"}-${renderer}.png`,
  );
  await page.screenshot({ path: out, fullPage: false });
  await browser.close();
  if (errs.length) {
    console.log(
      `  [${renderer}/${atmo ? "on" : "off"}] page errors: ${errs[0]}`,
    );
  }
  return out;
}

// GPU-vs-GL bucket decomposition — same morphological opening the
// polar-stretch probe uses (interior >=3x3 blobs vs thin seam/AA), split
// by which backend is brighter. Returns per-bucket px + meanΔ(gpu−gl).
async function analyze(pngGl, pngGpu, label) {
  const browser = await chromium.launch({ channel: "msedge", headless: true });
  const page = await browser.newPage();
  await page.setContent("<html><body></body></html>");
  const ba = fs.readFileSync(pngGl).toString("base64");
  const bb = fs.readFileSync(pngGpu).toString("base64");
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
      const A = await decode(ba); // WebGL
      const B = await decode(bb); // WebGPU
      if (A.w !== B.w || A.h !== B.h) return { error: "size mismatch" };
      const W = A.w,
        H = A.h;
      const CROP = { x0: 250, x1: 1010, y0: 45, y1: 640 };
      const lum = (d, i) =>
        0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
      const cw = CROP.x1 - CROP.x0,
        ch = CROP.y1 - CROP.y0;
      const mmask = new Uint8Array(cw * ch);
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
      const sums = {};
      for (const k of Object.keys(counts)) sums[k] = { dr: 0, dg: 0, db: 0 };
      // Also track the spatial centroid of the GPU-brighter blob bucket so
      // On vs Off can confirm it stays in the same high-lat region.
      let gpuBlobCx = 0,
        gpuBlobCy = 0;
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
          } else if (lum(A.data, gi) > lum(B.data, gi)) {
            bucket = "interiorBlobGlBrighter";
            col = [255, 0, 0];
          } else {
            bucket = "interiorBlobGpuBrighter";
            col = [0, 255, 0];
            gpuBlobCx += px;
            gpuBlobCy += py;
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
      const nGpuBlob = counts.interiorBlobGpuBrighter;
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
      return {
        mismatchPct: +((100 * mismatch) / cropPx).toFixed(3),
        mismatchPx: mismatch,
        buckets,
        gpuBlobCentroid: nGpuBlob
          ? {
              x: +(gpuBlobCx / nGpuBlob).toFixed(0),
              y: +(gpuBlobCy / nGpuBlob).toFixed(0),
            }
          : null,
        maskB64,
      };
    },
    { ba, bb },
  );
  await browser.close();
  if (result.maskB64) {
    fs.writeFileSync(
      path.join(OUT_DIR, `${label}-bucket-mask.png`),
      Buffer.from(result.maskB64, "base64"),
    );
    delete result.maskB64;
  }
  return result;
}

// Same-backend On-vs-Off diff — how much does the ground-atmosphere drape
// change EACH backend's own output? Confirms the toggle is doing something
// and quantifies each backend's drape magnitude independently.
async function selfDiff(pngOn, pngOff) {
  const browser = await chromium.launch({ channel: "msedge", headless: true });
  const page = await browser.newPage();
  await page.setContent("<html><body></body></html>");
  const ba = fs.readFileSync(pngOn).toString("base64");
  const bb = fs.readFileSync(pngOff).toString("base64");
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
          data: ctx.getImageData(0, 0, c.width, c.height).data,
        };
      };
      const A = await decode(ba);
      const B = await decode(bb);
      const W = A.w;
      const CROP = { x0: 250, x1: 1010, y0: 45, y1: 640 };
      let changed = 0,
        cropPx = 0,
        sumDelta = 0;
      for (let y = CROP.y0; y < CROP.y1; y++) {
        for (let x = CROP.x0; x < CROP.x1; x++) {
          const i = 4 * (y * W + x);
          cropPx++;
          const d =
            Math.abs(A.data[i] - B.data[i]) +
            Math.abs(A.data[i + 1] - B.data[i + 1]) +
            Math.abs(A.data[i + 2] - B.data[i + 2]);
          if (d > 12) {
            changed++;
            // Signed luminance delta (on − off): + means atmo brightens.
            sumDelta +=
              0.2126 * (A.data[i] - B.data[i]) +
              0.7152 * (A.data[i + 1] - B.data[i + 1]) +
              0.0722 * (A.data[i + 2] - B.data[i + 2]);
          }
        }
      }
      return {
        changedPct: +((100 * changed) / cropPx).toFixed(2),
        meanLumDelta_onMinusOff: changed ? +(sumDelta / changed).toFixed(1) : 0,
      };
    },
    { ba, bb },
  );
  await browser.close();
  return result;
}

console.log(`[farzoom] capturing 4 frames at far view (${VIEW.height} m)`);
const glOn = await capture("webgl", true);
const gpuOn = await capture("webgpu", true);
const glOff = await capture("webgl", false);
const gpuOff = await capture("webgpu", false);

console.log("[farzoom] analyzing GPU-vs-GL, atmosphere ON");
const on = await analyze(glOn, gpuOn, "atmoOn");
console.log("[farzoom] analyzing GPU-vs-GL, atmosphere OFF");
const off = await analyze(glOff, gpuOff, "atmoOff");
console.log("[farzoom] self-diff On-vs-Off (drape magnitude per backend)");
const glDrape = await selfDiff(glOn, glOff);
const gpuDrape = await selfDiff(gpuOn, gpuOff);

const bOn = on.buckets.interiorBlobGpuBrighter.px;
const bOff = off.buckets.interiorBlobGpuBrighter.px;
const collapse = bOn > 0 ? +(100 * (1 - bOff / bOn)).toFixed(1) : 0;

const report = {
  view: VIEW,
  atmoOn: on,
  atmoOff: off,
  drapeMagnitude: {
    webgl_onMinusOff: glDrape,
    webgpu_onMinusOff: gpuDrape,
  },
  bucketB_interiorBlobGpuBrighter: {
    atmoOn_px: bOn,
    atmoOff_px: bOff,
    collapsePct: collapse,
  },
};
fs.writeFileSync(
  path.join(OUT_DIR, "report.json"),
  JSON.stringify(report, null, 2),
);

const pr = (label, a) => {
  console.log(`  ${label}: mismatch ${a.mismatchPct}% (${a.mismatchPx}px)`);
  const b = a.buckets;
  for (const k of [
    "interiorBlobGpuBrighter",
    "interiorBlobGlBrighter",
    "seamThin",
    "limb",
    "space",
  ]) {
    const e = b[k];
    console.log(
      `    ${k.padEnd(24)} ${String(e.pctOfMismatch).padStart(5)}% | ${e.pctOfCrop}%  px=${e.px}  meanΔ(gpu−gl)=${e.meanDelta_gpuMinusGl ? JSON.stringify(e.meanDelta_gpuMinusGl) : "-"}`,
    );
  }
  if (a.gpuBlobCentroid)
    console.log(
      `    gpuBlob centroid (px, full-frame): ${JSON.stringify(a.gpuBlobCentroid)}`,
    );
};

console.log("\n=== GPU-vs-GL, ground-atmosphere ON (baseline) ===");
pr("atmoOn", on);
console.log("\n=== GPU-vs-GL, ground-atmosphere OFF ===");
pr("atmoOff", off);
console.log("\n=== drape magnitude (same-backend On−Off) ===");
console.log(
  `    webgl : ${glDrape.changedPct}% pixels changed, mean lum Δ(on−off) ${glDrape.meanLumDelta_onMinusOff}`,
);
console.log(
  `    webgpu: ${gpuDrape.changedPct}% pixels changed, mean lum Δ(on−off) ${gpuDrape.meanLumDelta_onMinusOff}`,
);
console.log("\n=== VERDICT — bucket (b) interiorBlobGpuBrighter ===");
console.log(`    atmo ON : ${bOn} px`);
console.log(`    atmo OFF: ${bOff} px`);
console.log(`    collapse with atmo OFF: ${collapse}%`);
console.log(
  collapse >= 50
    ? "    → ground-atmosphere drape IS the dominant driver of bucket (b)."
    : "    → ground-atmosphere drape is NOT the dominant driver; residual survives (imagery mip/LOD-bias).",
);
console.log(`\n[farzoom] PNGs + report.json in ${OUT_DIR}`);
