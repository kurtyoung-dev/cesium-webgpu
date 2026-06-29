#!/usr/bin/env node
/**
 * Pixel-diff two PNGs via Playwright canvas-decode (zero Node PNG dep), per the
 * project's visual-regression convention. Prints mismatch% (any channel differs
 * by > THRESH) and max per-channel delta. Used to assert the CLOUD-MULTIDECK
 * parity pair (main vs modified) is byte-identical (zero drift).
 *
 * Usage: node Tools/visual-regression/diff-multideck.mjs <a.png> <b.png>
 */
import { chromium } from "playwright";
import fs from "fs";

const [, , aPath, bPath] = process.argv;
if (!aPath || !bPath) {
  console.error("usage: diff-multideck.mjs <a.png> <b.png>");
  process.exit(2);
}
const THRESH = 0; // exact (byte-identical) — any nonzero channel delta counts

const toDataUrl = (p) =>
  `data:image/png;base64,${fs.readFileSync(p).toString("base64")}`;

(async () => {
  const browser = await chromium.launch({ channel: "msedge", headless: true });
  const page = await browser.newPage();
  const res = await page.evaluate(
    async ({ aUrl, bUrl, thresh }) => {
      const load = (url) =>
        new Promise((resolve, reject) => {
          const img = new Image();
          img.onload = () => resolve(img);
          img.onerror = reject;
          img.src = url;
        });
      const decode = async (url) => {
        const img = await load(url);
        const c = document.createElement("canvas");
        c.width = img.width;
        c.height = img.height;
        const ctx = c.getContext("2d");
        ctx.drawImage(img, 0, 0);
        return {
          w: img.width,
          h: img.height,
          data: ctx.getImageData(0, 0, img.width, img.height).data,
        };
      };
      const A = await decode(aUrl);
      const B = await decode(bUrl);
      if (A.w !== B.w || A.h !== B.h) {
        return { error: `size mismatch ${A.w}x${A.h} vs ${B.w}x${B.h}` };
      }
      let mismatch = 0;
      let maxDelta = 0;
      const total = A.w * A.h;
      for (let i = 0; i < A.data.length; i += 4) {
        let px = 0;
        for (let c = 0; c < 4; c++) {
          const d = Math.abs(A.data[i + c] - B.data[i + c]);
          if (d > maxDelta) maxDelta = d;
          if (d > thresh) px = 1;
        }
        mismatch += px;
      }
      return {
        w: A.w,
        h: A.h,
        total,
        mismatch,
        pct: (mismatch / total) * 100,
        maxDelta,
      };
    },
    { aUrl: toDataUrl(aPath), bUrl: toDataUrl(bPath), thresh: THRESH },
  );
  await browser.close();
  if (res.error) {
    console.error(`DIFF ERROR: ${res.error}`);
    process.exit(1);
  }
  console.log(
    `${aPath}\n  vs ${bPath}\n  ${res.w}x${res.h}  mismatchPx=${res.mismatch}/${res.total}  mismatch=${res.pct.toFixed(4)}%  maxChannelDelta=${res.maxDelta}`,
  );
  console.log(
    res.mismatch === 0
      ? "RESULT: ZERO DRIFT (byte-identical)"
      : `RESULT: DRIFT (${res.mismatch} px differ, maxDelta=${res.maxDelta})`,
  );
})();
