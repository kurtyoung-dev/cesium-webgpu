#!/usr/bin/env node
// Pixel-exact diff between two PNGs. Used by the SKY-MS parity gate to assert
// the flag-OFF build is BYTE-IDENTICAL across the change (pre vs post).
//
//   node Tools/visual-regression/diff-two-pngs.mjs A.png B.png
//
// Prints mismatched-pixel count, mean delta, max delta. Exit 0 iff zero drift.

import { chromium } from "playwright";
import fs from "fs";

const A = process.argv[2];
const B = process.argv[3];
// Optional: ignore the bottom N pixels (the Cesium timeline/clock widget,
// whose tick needle is frame-timing dependent and not part of the render).
const CROP_BOTTOM = parseInt(process.argv[4] || "0", 10) || 0;
if (!A || !B) {
  console.error("usage: diff-two-pngs.mjs A.png B.png [cropBottomPx]");
  process.exit(2);
}

(async () => {
  const browser = await chromium.launch({ channel: "msedge", headless: true });
  const page = await browser.newPage();
  await page.setContent("<!doctype html><html><body></body></html>");
  const a64 = fs.readFileSync(A).toString("base64");
  const b64 = fs.readFileSync(B).toString("base64");
  const r = await page.evaluate(
    async ({ a64, b64, cropBottom }) => {
      async function decode(s) {
        const img = new Image();
        img.src = "data:image/png;base64," + s;
        await img.decode();
        const cv = document.createElement("canvas");
        cv.width = img.width;
        cv.height = img.height;
        const ctx = cv.getContext("2d");
        ctx.drawImage(img, 0, 0);
        return ctx.getImageData(0, 0, img.width, img.height);
      }
      const a = await decode(a64);
      const b = await decode(b64);
      if (a.width !== b.width || a.height !== b.height) {
        return { sizeMismatch: true, aw: a.width, ah: a.height, bw: b.width, bh: b.height };
      }
      const da = a.data,
        db = b.data;
      const w = a.width,
        h = a.height;
      const yMax = h - cropBottom;
      let mismatch = 0,
        deltaSum = 0,
        maxDelta = 0,
        total = 0;
      for (let y = 0; y < yMax; y++) {
        for (let x = 0; x < w; x++) {
          const i = (y * w + x) * 4;
          const delta =
            Math.abs(da[i] - db[i]) +
            Math.abs(da[i + 1] - db[i + 1]) +
            Math.abs(da[i + 2] - db[i + 2]);
          deltaSum += delta;
          if (delta > maxDelta) maxDelta = delta;
          if (delta > 0) mismatch++;
          total++;
        }
      }
      return {
        mismatch,
        total,
        mismatchPct: (100 * mismatch) / total,
        meanDelta: deltaSum / total,
        maxDelta,
      };
    },
    { a64, b64, cropBottom: CROP_BOTTOM },
  );
  await browser.close();
  if (r.sizeMismatch) {
    console.log(`SIZE MISMATCH: ${r.aw}x${r.ah} vs ${r.bw}x${r.bh}`);
    process.exit(1);
  }
  console.log(
    `mismatchedPixels=${r.mismatch}/${r.total} (${r.mismatchPct.toFixed(4)}%) meanDelta=${r.meanDelta.toFixed(4)} maxDelta=${r.maxDelta}`,
  );
  process.exit(r.mismatch === 0 ? 0 : 1);
})();
