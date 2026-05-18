#!/usr/bin/env node
// Pixel-diff every pair of polar-multi-{view}-{renderer}.png. Decodes
// each PNG inside a Playwright page (sidesteps node-side PNG deps) and
// reports per-view mismatch%, mean per-channel delta, and overall
// brightness ratio. Target: every view < 2% diff.

import { chromium } from "playwright";
import fs from "fs";
import path from "path";

const OUT_DIR = "Tools/visual-regression/output";

const VIEWS = [
  "northpole-close",
  "northpole-orbit",
  "southpole-close",
  "southpole-orbit",
  "equator-mid",
  "midlat-mid",
];

(async () => {
  const browser = await chromium.launch({
    channel: "msedge", headless: true,
    args: ["--enable-unsafe-webgpu"],
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  await page.setContent("<!doctype html><html><body></body></html>");

  console.log(`${"view".padEnd(20)} ${"mismatch%".padStart(10)} ${"meanDelta".padStart(10)} ${"brightnessR".padStart(12)}`);
  console.log("─".repeat(56));

  const results = [];
  for (const view of VIEWS) {
    const wglPath = path.join(OUT_DIR, `polar-multi-${view}-webgl.png`);
    const wgpuPath = path.join(OUT_DIR, `polar-multi-${view}-webgpu.png`);
    if (!fs.existsSync(wglPath) || !fs.existsSync(wgpuPath)) {
      console.log(`${view.padEnd(20)} MISSING`);
      continue;
    }
    const wglB64 = fs.readFileSync(wglPath).toString("base64");
    const wgpuB64 = fs.readFileSync(wgpuPath).toString("base64");

    const stats = await page.evaluate(
      async ({ wglB64, wgpuB64 }) => {
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
        const a = await decode(wglB64);
        const b = await decode(wgpuB64);
        if (a.width !== b.width || a.height !== b.height) {
          return { error: `size mismatch ${a.width}x${a.height} vs ${b.width}x${b.height}` };
        }
        const da = a.data, db = b.data;
        let mismatch = 0, total = 0;
        let rSumA = 0, gSumA = 0, bSumA = 0;
        let rSumB = 0, gSumB = 0, bSumB = 0;
        let deltaSum = 0;
        // Center 80% × 80% to avoid UI chrome at edges.
        const w = a.width, h = a.height;
        const x0 = Math.floor(w * 0.1), x1 = Math.floor(w * 0.9);
        const y0 = Math.floor(h * 0.1), y1 = Math.floor(h * 0.9);
        for (let y = y0; y < y1; y++) {
          for (let x = x0; x < x1; x++) {
            const i = (y * w + x) * 4;
            const ra = da[i], ga = da[i + 1], ba = da[i + 2];
            const rb = db[i], gb = db[i + 1], bb = db[i + 2];
            rSumA += ra; gSumA += ga; bSumA += ba;
            rSumB += rb; gSumB += gb; bSumB += bb;
            const delta = Math.abs(ra - rb) + Math.abs(ga - gb) + Math.abs(ba - bb);
            deltaSum += delta;
            if (delta > 24) mismatch++;   // ~8 per channel — accounts for AA
            total++;
          }
        }
        const meanA = (rSumA + gSumA + bSumA) / (3 * total);
        const meanB = (rSumB + gSumB + bSumB) / (3 * total);
        return {
          width: w, height: h,
          total, mismatch,
          mismatchPct: 100 * mismatch / total,
          meanDelta: deltaSum / total,
          brightnessRatio: meanB > 0 ? meanA / meanB : Infinity,
          meanA, meanB,
        };
      },
      { wglB64, wgpuB64 },
    );

    if (stats.error) {
      console.log(`${view.padEnd(20)} ERROR ${stats.error}`);
      continue;
    }
    const passBand = stats.mismatchPct < 2 ? "\x1b[32m" : stats.mismatchPct < 10 ? "\x1b[33m" : "\x1b[31m";
    const reset = "\x1b[0m";
    console.log(
      `${view.padEnd(20)} ${(passBand + stats.mismatchPct.toFixed(2) + "%" + reset).padStart(20)} ${stats.meanDelta.toFixed(1).padStart(10)} ${stats.brightnessRatio.toFixed(3).padStart(12)}`,
    );
    results.push({ view, ...stats });
  }
  await browser.close();

  // Summary
  console.log();
  const avg = results.reduce((s, r) => s + r.mismatchPct, 0) / results.length;
  const worst = results.reduce((m, r) => r.mismatchPct > m.mismatchPct ? r : m, results[0]);
  console.log(`Average mismatch: ${avg.toFixed(2)}%`);
  console.log(`Worst view: ${worst.view} at ${worst.mismatchPct.toFixed(2)}%`);
  const passCount = results.filter((r) => r.mismatchPct < 2).length;
  console.log(`Pass (<2% diff): ${passCount} / ${results.length}`);

  fs.writeFileSync(
    path.join(OUT_DIR, "polar-multi-diff-report.json"),
    JSON.stringify({ runAt: new Date().toISOString(), results }, null, 2),
  );
})();
