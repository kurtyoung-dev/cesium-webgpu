#!/usr/bin/env node
// Quick probe: orbit-only comparison for WGS84 ellipsoid.
// @purpose Quick orbit-only WebGL-vs-WebGPU comparison used to verify the Batch-56 alpha=1 force in WebGPUImageryReprojection.
// @status INVESTIGATION
//
// Used to verify the Batch 56 alpha=1 force in WebGPUImageryReprojection fix.

import { chromium } from "playwright";
import fs from "fs";
import path from "path";

import { attachPageDiagnostics } from "../lib/attach-page-diagnostics.mjs";

const BASE = "http://localhost:8080";
const OUT_DIR = "Tools/visual-regression/output";

async function capture(rendererArg, label) {
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
  const diagnostics = attachPageDiagnostics(page);

  await page.goto(
    `${BASE}/Apps/CesiumViewer/index.html?renderer=${rendererArg}`,
    {
      waitUntil: "networkidle",
    },
  );
  await page.waitForFunction(() => !!window.viewer);

  await page.evaluate(async () => {
    const v = window.viewer;
    const blp = v.baseLayerPicker;
    const vm = blp.viewModel;
    const wgs84Tvm = vm.terrainProviderViewModels.find((t) =>
      String(t.name || "")
        .toLowerCase()
        .includes("wgs84"),
    );
    if (wgs84Tvm) vm.selectedTerrain = wgs84Tvm;
    for (let i = 0; i < 1200; i++) {
      v.scene.render();
      await new Promise((r) => requestAnimationFrame(r));
    }
  });
  await page.waitForTimeout(2500);

  // Compute mean brightness of canvas
  const stats = await page.evaluate(() => {
    const cv = document.querySelector("canvas");
    const w = cv.width,
      h = cv.height;
    const c2 = document.createElement("canvas");
    c2.width = w;
    c2.height = h;
    const ctx = c2.getContext("2d");
    ctx.drawImage(cv, 0, 0);
    const data = ctx.getImageData(0, 0, w, h).data;
    let rSum = 0,
      gSum = 0,
      bSum = 0,
      nonBlack = 0;
    let sampled = 0;
    for (let i = 0; i < data.length; i += 4) {
      const r = data[i],
        g = data[i + 1],
        b = data[i + 2];
      rSum += r;
      gSum += g;
      bSum += b;
      if (r + g + b > 15) nonBlack++;
      sampled++;
    }
    return {
      width: w,
      height: h,
      meanR: rSum / sampled,
      meanG: gSum / sampled,
      meanB: bSum / sampled,
      nonBlackPct: (100 * nonBlack) / sampled,
    };
  });
  console.log(`  ${label}-${rendererArg}: ${JSON.stringify(stats)}`);

  const out = path.join(OUT_DIR, `wgs84-quick-${label}-${rendererArg}.png`);
  await page.screenshot({ path: out, fullPage: false });
  diagnostics.detach();
  await browser.close();

  // Reassemble arrival order across the two arrays by seq (not timestamp —
  // millisecond resolution ties same-tick console/pageerror pairs, which an
  // uncaught page error routinely produces) — the original single-array
  // design interleaved console and page errors as they fired;
  // attachPageDiagnostics keeps them separate, so this is the equivalent
  // re-merge for the console.log summary below.
  const errs = [
    ...diagnostics.console
      .filter((m) => m.type === "error")
      .map((m) => ({ t: "error", text: m.text, seq: m.seq })),
    ...diagnostics.errors.map((m) => ({
      t: "pageerror",
      text: m.text,
      seq: m.seq,
    })),
  ].sort((a, b) => a.seq - b.seq);
  if (errs.length) {
    console.log(`  ${errs.length} errors:`);
    errs.slice(0, 3).forEach((e) => console.log(`    ${e.t}: ${e.text}`));
  }
  return { out, stats };
}

(async () => {
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
  console.log(`[probe-wgs84-quick] orbit comparison`);
  const webgl = await capture("webgl", "orbit");
  const webgpu = await capture("webgpu", "orbit");
  console.log(`\nSummary:`);
  console.log(
    `  WebGL  nonBlack=${webgl.stats.nonBlackPct.toFixed(1)}% mean=(${webgl.stats.meanR.toFixed(0)},${webgl.stats.meanG.toFixed(0)},${webgl.stats.meanB.toFixed(0)})`,
  );
  console.log(
    `  WebGPU nonBlack=${webgpu.stats.nonBlackPct.toFixed(1)}% mean=(${webgpu.stats.meanR.toFixed(0)},${webgpu.stats.meanG.toFixed(0)},${webgpu.stats.meanB.toFixed(0)})`,
  );
})();
