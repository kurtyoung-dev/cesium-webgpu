#!/usr/bin/env node
// Exact pixel diff of two canvas-element PNGs (Batch 440 parity gate).
// @purpose CLI exact pixel diff of two canvas PNGs via Playwright canvas decode; reports differing-pixel count/%/max channel delta (fog-MS parity gate tool).
// @status INVESTIGATION
//
// Decodes both via Playwright/createImageBitmap (no Node PNG dep) and reports
// the count + percentage of differing pixels (and max channel delta).
//
// Usage: node Tools/visual-regression/diff-fog-ms.mjs <pngA> <pngB>

import { chromium } from "playwright";
import fs from "fs";

const a = process.argv[2];
const b = process.argv[3];
if (!a || !b || !fs.existsSync(a) || !fs.existsSync(b)) {
  console.error(`usage: diff-fog-ms.mjs <pngA> <pngB> (both must exist)`);
  process.exit(2);
}

const browser = await chromium.launch({ channel: "msedge", headless: true });
const page = await browser.newPage();

async function decode(file) {
  const b64 = fs.readFileSync(file).toString("base64");
  return page.evaluate(async (b64in) => {
    const bin = atob(b64in);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const bitmap = await createImageBitmap(
      new Blob([bytes], { type: "image/png" }),
    );
    const c = document.createElement("canvas");
    c.width = bitmap.width;
    c.height = bitmap.height;
    const ctx = c.getContext("2d");
    ctx.drawImage(bitmap, 0, 0);
    const d = ctx.getImageData(0, 0, c.width, c.height).data;
    return { w: c.width, h: c.height, data: Array.from(d) };
  }, b64);
}

const da = await decode(a);
const db = await decode(b);
await browser.close();

if (da.w !== db.w || da.h !== db.h) {
  console.log(`DIMENSION MISMATCH: ${da.w}x${da.h} vs ${db.w}x${db.h}`);
  process.exit(1);
}

// Optional fog-only crop to exclude animated UI chrome (clock hands, timeline
// ticks, help panel). The default CesiumViewer overlays the clock bottom-left,
// the timeline along the bottom, a toolbar top-right, and the help panel
// top-right; the large central/left band x:[0,1000] y:[300,620] is pure fog.
const CROP =
  process.argv[4] === "full" ? null : { x0: 0, y0: 300, x1: 1000, y1: 620 };

let diffPixels = 0;
let maxDelta = 0;
let considered = 0;
for (let y = 0; y < da.h; y++) {
  if (CROP && (y < CROP.y0 || y >= CROP.y1)) continue;
  for (let x = 0; x < da.w; x++) {
    if (CROP && (x < CROP.x0 || x >= CROP.x1)) continue;
    const i = (y * da.w + x) * 4;
    const dr = Math.abs(da.data[i] - db.data[i]);
    const dg = Math.abs(da.data[i + 1] - db.data[i + 1]);
    const dbb = Math.abs(da.data[i + 2] - db.data[i + 2]);
    const m = Math.max(dr, dg, dbb);
    considered++;
    if (m > 0) diffPixels++;
    if (m > maxDelta) maxDelta = m;
  }
}
const pct = (diffPixels / considered) * 100;
console.log(
  `[diff-fog-ms] ${da.w}x${da.h} crop=${CROP ? JSON.stringify(CROP) : "full"}`,
);
console.log(`  diffPixels=${diffPixels}/${considered} (${pct.toFixed(4)}%)`);
console.log(`  maxChannelDelta=${maxDelta}`);
console.log(`  BYTE-IDENTICAL(crop)=${diffPixels === 0}`);
