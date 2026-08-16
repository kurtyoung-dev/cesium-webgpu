#!/usr/bin/env node
// C2-6 DIAGNOSTIC (NEW-WEBGPU-EXAG-WATER-STREAKS) — 2x2: {webgl,webgpu} x
// {atmo-on, atmo-off}, + per-backend rendered TILE LEVELS + a "bright-blue lake
// streak" metric. Decides the branch:
// @purpose 2x2 {backend}x{atmosphere} capture + rendered tile levels + lake-streak metric; branch-decider for the exaggerated-terrain bright-lake streak bug.
// @status INVESTIGATION
//
//   - If webgl-on vs webgl-off mutes the lakes a lot → atmosphere IS the agent
//     (fixable: match the WebGPU drape/fade).
//   - If WebGPU tile levels differ from WebGL at the lake region → terrain LOD
//     divergence (NOT a shader fix; defer as a bigger batch).
//   - If atmo on/off identical on both AND tiles match → imagery/saturation.
//
// Usage: PROBE_BASE=http://localhost:8080 node Tools/visual-regression/diag-exag-water-streaks-2x2.mjs
import { chromium } from "playwright";
import { writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dir = dirname(fileURLToPath(import.meta.url));
const OUT = join(__dir, "output");
mkdirSync(OUT, { recursive: true });
const BASE = process.env.PROBE_BASE || "http://localhost:8080";

const browser = await chromium.launch({
  channel: "msedge",
  headless: true,
  args: ["--enable-unsafe-webgpu"],
});

async function capture(renderer, killAtmosphere) {
  const page = await browser.newPage({
    viewport: { width: 1280, height: 720 },
  });
  await page.goto(`${BASE}/Apps/CesiumViewer/index.html?renderer=${renderer}`, {
    waitUntil: "networkidle",
  });
  await page.waitForFunction(() => !!window.viewer);
  const res = await page.evaluate(async (killAtmo) => {
    const v = window.viewer,
      s = v.scene,
      c = v.camera;
    s.verticalExaggeration = 10;
    s.highDynamicRange = false; // remove HDR tonemap as a variable
    if (killAtmo) {
      s.fog.enabled = false;
      if (s.skyAtmosphere) s.skyAtmosphere.show = false;
      s.globe.showGroundAtmosphere = false;
    }
    const ell = s.ellipsoid ?? s.globe.ellipsoid;
    const dest = ell.cartographicToCartesian({
      longitude: (86.9 * Math.PI) / 180,
      latitude: (27.0 * Math.PI) / 180,
      height: 250000,
    });
    const setIt = () =>
      c.setView({
        destination: dest,
        orientation: { heading: 0, pitch: -0.45, roll: 0 },
      });
    setIt();
    for (let i = 0; i < 320; i++) {
      s.initializeFrame();
      s.render();
      await new Promise((r) => requestAnimationFrame(r));
    }
    setIt();
    for (let i = 0; i < 60; i++) {
      s.initializeFrame();
      s.render();
      await new Promise((r) => requestAnimationFrame(r));
    }
    // Rendered tile levels at the lake region.
    let levels = [];
    try {
      const tiles = s.globe._surface._tilesToRender || [];
      levels = tiles.map((t) => t.level);
    } catch (e) {
      /* */
    }
    const lvlHist = {};
    for (const l of levels) lvlHist[l] = (lvlHist[l] || 0) + 1;
    return {
      dataUrl: s.canvas.toDataURL("image/png"),
      tileCount: levels.length,
      lvlHist,
      fade: (() => {
        try {
          return s.globe._surface.tileProvider.lightingFadeOutDistance;
        } catch (e) {
          return null;
        }
      })(),
    };
  }, killAtmosphere);
  writeFileSync(
    join(OUT, `exag2x2-${renderer}-${killAtmosphere ? "off" : "on"}.png`),
    Buffer.from(res.dataUrl.split(",")[1], "base64"),
  );
  // Decode for the bright-blue metric.
  const stat = await page.evaluate(async (b64) => {
    const blob = await (await fetch(`data:image/png;base64,${b64}`)).blob();
    const bmp = await createImageBitmap(blob);
    const off = new OffscreenCanvas(bmp.width, bmp.height);
    const cx = off.getContext("2d");
    cx.drawImage(bmp, 0, 0);
    const d = cx.getImageData(0, 0, bmp.width, bmp.height).data;
    // "bright-blue lake streak": B noticeably > R and reasonably bright. Skip UI.
    let n = 0,
      sr = 0,
      sg = 0,
      sb = 0;
    const w = bmp.width;
    for (let i = 0; i < d.length; i += 4) {
      const x = (i / 4) % w,
        y = Math.floor(i / 4 / w);
      if (y < 40 || x > 1000) continue;
      const R = d[i],
        G = d[i + 1],
        B = d[i + 2];
      if (B > 90 && B - R > 25 && B - G > 10) {
        n++;
        sr += R;
        sg += G;
        sb += B;
      }
    }
    return {
      blueStreakPx: n,
      meanR: n ? +(sr / n).toFixed(1) : 0,
      meanG: n ? +(sg / n).toFixed(1) : 0,
      meanB: n ? +(sb / n).toFixed(1) : 0,
    };
  }, res.dataUrl.split(",")[1]);
  await page.close();
  return { ...res, ...stat, dataUrl: undefined };
}

const grid = {};
for (const r of ["webgl", "webgpu"]) {
  for (const killAtmo of [false, true]) {
    const key = `${r}-${killAtmo ? "off" : "on"}`;
    grid[key] = await capture(r, killAtmo);
    console.log(
      `${key}: blueStreakPx=${grid[key].blueStreakPx} meanRGB=(${grid[key].meanR},${grid[key].meanG},${grid[key].meanB}) tiles=${grid[key].tileCount} fade=${grid[key].fade} lvlHist=${JSON.stringify(grid[key].lvlHist)}`,
    );
  }
}
await browser.close();
console.log("\n=== BRANCH ANALYSIS ===");
console.log(
  `webgl atmo mutes lakes? on=${grid["webgl-on"].blueStreakPx} off=${grid["webgl-off"].blueStreakPx} (delta ${grid["webgl-off"].blueStreakPx - grid["webgl-on"].blueStreakPx})`,
);
console.log(
  `webgpu atmo mutes lakes? on=${grid["webgpu-on"].blueStreakPx} off=${grid["webgpu-off"].blueStreakPx}`,
);
console.log(
  `cross (atmo OFF both): webgl=${grid["webgl-off"].blueStreakPx} webgpu=${grid["webgpu-off"].blueStreakPx}`,
);
console.log(
  `tile counts: webgl=${grid["webgl-on"].tileCount} webgpu=${grid["webgpu-on"].tileCount} (LOD divergence if very different)`,
);
