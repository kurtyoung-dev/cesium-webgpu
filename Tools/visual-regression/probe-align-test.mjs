#!/usr/bin/env node
// Search for the best (dx, dy) pixel offset to align WebGPU's image
// with WebGL's at northpole-close. If the optimum is non-zero, there
// is a positional shift between the two backends.
// @purpose Searches best (dx,dy) offset between pre-captured northpole WebGL/WebGPU PNGs to detect a positional shift between backends.
// @status INVESTIGATION
//
import { chromium } from "playwright";
import fs from "fs";

const browser = await chromium.launch({ channel: "msedge", headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
await page.setContent("<!doctype html><html><body></body></html>");

const a = fs
  .readFileSync(
    "Tools/visual-regression/output/polar-fixed-northpole-close-webgl.png",
  )
  .toString("base64");
const b = fs
  .readFileSync(
    "Tools/visual-regression/output/polar-fixed-northpole-close-webgpu.png",
  )
  .toString("base64");

const r = await page.evaluate(
  async ({ a, b }) => {
    async function dec(b64) {
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
    const ia = await dec(a);
    const ib = await dec(b);
    const da = ia.data,
      db = ib.data;
    const w = ia.width,
      h = ia.height;
    // Clean Greenland box (no UI)
    const boxes = [
      { name: "greenland", x0: 50, x1: 250, y0: 150, y1: 400 },
      { name: "ocean-center", x0: 500, x1: 700, y0: 350, y1: 500 },
      { name: "russia", x0: 700, x1: 900, y0: 100, y1: 300 },
    ];
    const out = {};
    for (const box of boxes) {
      const score = (dx, dy) => {
        let s = 0,
          n = 0;
        for (let y = box.y0; y < box.y1; y++)
          for (let x = box.x0; x < box.x1; x++) {
            const i = (y * w + x) * 4;
            const yj = y + dy,
              xj = x + dx;
            if (yj < 0 || yj >= h || xj < 0 || xj >= w) continue;
            const j = (yj * w + xj) * 4;
            s +=
              Math.abs(da[i] - db[j]) +
              Math.abs(da[i + 1] - db[j + 1]) +
              Math.abs(da[i + 2] - db[j + 2]);
            n++;
          }
        return n > 0 ? s / n : Infinity;
      };
      const results = [];
      for (let dy = -6; dy <= 6; dy++)
        for (let dx = -6; dx <= 6; dx++) {
          results.push({ dx, dy, s: score(dx, dy) });
        }
      results.sort((a, b) => a.s - b.s);
      out[box.name] = results.slice(0, 3);
    }
    return out;
  },
  { a, b },
);
console.log("Best (dx, dy) shifts to align WebGPU onto WebGL per region:");
for (const [name, top] of Object.entries(r)) {
  console.log(`\n${name}:`);
  for (const t of top)
    console.log(
      `  dx=${t.dx.toString().padStart(2)}  dy=${t.dy.toString().padStart(2)}  meanDelta=${t.s.toFixed(2)}`,
    );
}
await browser.close();
