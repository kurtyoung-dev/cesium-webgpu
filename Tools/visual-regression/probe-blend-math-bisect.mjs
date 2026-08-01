#!/usr/bin/env node
// Bisection probe: compare OLD WGSL straight-mix output vs NEW WGSL
// premultiplied-alpha output at the midlat-mid view. We want to
// identify exactly which pixels diverge and infer what input state is
// triggering the divergence.
//
// Inputs (assumed pre-captured):
//   Tools/visual-regression/output/bisect-midlat-OLD-wgsl-mix.png
//   Tools/visual-regression/output/bisect-midlat-NEW-premultiplied.png
//   Tools/visual-regression/output/bisect-midlat-webgl-reference.png
//
// Output:
//   - per-row histogram of mismatch
//   - listing of N most-divergent pixel positions
//   - mean delta per region (top/mid/bottom thirds)
//   - if NEW is closer to WebGL than OLD anywhere, identify those regions
//     (because that's where the math fix is actually helping)

import { chromium } from "playwright";
import fs from "fs";

const OUT = "Tools/visual-regression/output";

(async () => {
  const browser = await chromium.launch({ channel: "msedge", headless: true });
  const page = await browser.newPage({
    viewport: { width: 1280, height: 720 },
  });
  await page.setContent("<!doctype html><html><body></body></html>");

  const old_b64 = fs
    .readFileSync(`${OUT}/bisect-midlat-OLD-wgsl-mix.png`)
    .toString("base64");
  const neu_b64 = fs
    .readFileSync(`${OUT}/bisect-midlat-NEW-premultiplied.png`)
    .toString("base64");
  const wgl_b64 = fs
    .readFileSync(`${OUT}/bisect-midlat-webgl-reference.png`)
    .toString("base64");

  const result = await page.evaluate(
    async ({ old_b64, neu_b64, wgl_b64 }) => {
      async function decode(b64) {
        const img = new Image();
        img.src = "data:image/png;base64," + b64;
        await img.decode();
        const cv = document.createElement("canvas");
        cv.width = img.width;
        cv.height = img.height;
        const ctx = cv.getContext("2d");
        ctx.drawImage(img, 0, 0);
        return ctx.getImageData(0, 0, img.width, img.height);
      }
      const old_img = await decode(old_b64);
      const neu_img = await decode(neu_b64);
      const wgl_img = await decode(wgl_b64);
      const w = old_img.width;
      const h = old_img.height;

      // Sample within the globe area, skipping UI chrome.
      const x0 = 0,
        x1 = Math.floor(w * 0.78);
      const y0 = Math.floor(h * 0.06),
        y1 = Math.floor(h * 0.9);

      let newVsOldMismatch = 0;
      let newVsOldTotal = 0;
      let newVsOldDeltaSum = 0;
      let oldVsWGLDeltaSum = 0;
      let newVsWGLDeltaSum = 0;
      let newCloserCount = 0;
      let oldCloserCount = 0;
      let tieCount = 0;

      // Per-row stats
      const rowMismatch = new Array(h).fill(0);
      const rowTotal = new Array(h).fill(0);

      // Top divergent pixels
      const divergent = [];

      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const i = (y * w + x) * 4;
          const oR = old_img.data[i],
            oG = old_img.data[i + 1],
            oB = old_img.data[i + 2];
          const nR = neu_img.data[i],
            nG = neu_img.data[i + 1],
            nB = neu_img.data[i + 2];
          const gR = wgl_img.data[i],
            gG = wgl_img.data[i + 1],
            gB = wgl_img.data[i + 2];

          const newVsOld =
            Math.abs(oR - nR) + Math.abs(oG - nG) + Math.abs(oB - nB);
          const oldVsWGL =
            Math.abs(oR - gR) + Math.abs(oG - gG) + Math.abs(oB - gB);
          const newVsWGL =
            Math.abs(nR - gR) + Math.abs(nG - gG) + Math.abs(nB - gB);

          newVsOldDeltaSum += newVsOld;
          oldVsWGLDeltaSum += oldVsWGL;
          newVsWGLDeltaSum += newVsWGL;
          newVsOldTotal++;
          rowTotal[y]++;
          if (newVsOld > 6) {
            newVsOldMismatch++;
            rowMismatch[y]++;
            if (
              divergent.length < 30 ||
              divergent[divergent.length - 1].delta < newVsOld
            ) {
              divergent.push({
                x,
                y,
                old: [oR, oG, oB],
                new: [nR, nG, nB],
                wgl: [gR, gG, gB],
                delta: newVsOld,
              });
              divergent.sort((a, b) => b.delta - a.delta);
              if (divergent.length > 30) divergent.length = 30;
            }
          }
          // Is new closer to WGL than old?
          if (newVsWGL < oldVsWGL - 2) newCloserCount++;
          else if (oldVsWGL < newVsWGL - 2) oldCloserCount++;
          else tieCount++;
        }
      }

      // Aggregate per-row mismatch — find rows with most divergence
      const rowSummary = [];
      for (let y = y0; y < y1; y++) {
        if (rowMismatch[y] > 0) {
          rowSummary.push({
            y,
            mismatch: rowMismatch[y],
            total: rowTotal[y],
            pct: (100 * rowMismatch[y]) / rowTotal[y],
          });
        }
      }
      rowSummary.sort((a, b) => b.pct - a.pct);

      return {
        width: w,
        height: h,
        sampleRegion: { x0, x1, y0, y1 },
        newVsOld: {
          total: newVsOldTotal,
          mismatch: newVsOldMismatch,
          mismatchPct: (100 * newVsOldMismatch) / newVsOldTotal,
          meanDelta: newVsOldDeltaSum / newVsOldTotal,
        },
        oldVsWGL: { meanDelta: oldVsWGLDeltaSum / newVsOldTotal },
        newVsWGL: { meanDelta: newVsWGLDeltaSum / newVsOldTotal },
        relativeToWGL: {
          newCloser: newCloserCount,
          oldCloser: oldCloserCount,
          tie: tieCount,
        },
        topDivergent: divergent.slice(0, 15),
        topDivergentRows: rowSummary.slice(0, 10),
      };
    },
    { old_b64, neu_b64, wgl_b64 },
  );

  console.log(`=== Pixel diff: NEW WGSL vs OLD WGSL (at midlat-mid) ===`);
  console.log(
    `Sample region: x=[${result.sampleRegion.x0},${result.sampleRegion.x1}], y=[${result.sampleRegion.y0},${result.sampleRegion.y1}]`,
  );
  console.log(`Total pixels: ${result.newVsOld.total}`);
  console.log(
    `Diverging pixels (delta > 6): ${result.newVsOld.mismatch} (${result.newVsOld.mismatchPct.toFixed(2)}%)`,
  );
  console.log(
    `Mean delta: ${result.newVsOld.meanDelta.toFixed(2)} (sum-of-abs-RGB per pixel)`,
  );
  console.log();
  console.log(`=== Distance from WebGL reference ===`);
  console.log(`OLD vs WGL mean delta: ${result.oldVsWGL.meanDelta.toFixed(2)}`);
  console.log(`NEW vs WGL mean delta: ${result.newVsWGL.meanDelta.toFixed(2)}`);
  const dir =
    result.newVsWGL.meanDelta < result.oldVsWGL.meanDelta
      ? "CLOSER to WebGL"
      : "FURTHER from WebGL";
  console.log(`NEW is ${dir} on average`);
  console.log();
  console.log(
    `Per-pixel: NEW closer to WGL: ${result.relativeToWGL.newCloser}  OLD closer: ${result.relativeToWGL.oldCloser}  tie: ${result.relativeToWGL.tie}`,
  );
  console.log();
  console.log(`=== Top 15 divergent pixels (sorted by NEW-vs-OLD delta) ===`);
  for (const p of result.topDivergent) {
    console.log(
      `  (${p.x.toString().padStart(4)},${p.y.toString().padStart(4)}) delta=${p.delta.toString().padStart(4)} | OLD=[${p.old}] NEW=[${p.new}] WGL=[${p.wgl}]`,
    );
  }
  console.log();
  console.log(`=== Top 10 rows with most divergent pixels ===`);
  for (const r of result.topDivergentRows) {
    console.log(
      `  row ${r.y}: ${r.mismatch}/${r.total} (${r.pct.toFixed(1)}%) divergent`,
    );
  }

  await browser.close();
})();
