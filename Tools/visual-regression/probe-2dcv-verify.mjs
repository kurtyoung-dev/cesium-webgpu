#!/usr/bin/env node
// Probe (BUG-3): verify SCENE2D and COLUMBUS_VIEW render the globe on WebGPU
// comparably to WebGL. Captures WebGL + WebGPU x {2D, CV} and an error gate.
// @purpose BUG-3 visual verification: instant-morphs to 2D and CV on both backends, screenshots plus pixel stats behind the WebGPU error gate.
// @status INVESTIGATION
//
// Inventory BUG-3: "2D/Columbus View modes: branching landed but never
// visually verified". This probe drives scene.morphTo2D(0) /
// scene.morphToColumbusView(0) (instant), settles ~30+ frames, screenshots,
// and dumps canvas pixel stats. READ the PNGs to confirm the globe renders
// flattened (2D map) and 3D-on-a-plane (CV) on WebGPU.
//
// Usage: node Tools/visual-regression/probe-2dcv-verify.mjs
// Env:   PROBE_BASE (default http://localhost:8134)
// Out:   Tools/visual-regression/output/bug3-2dcv-{2d,cv}-{webgl,webgpu}.png

import { chromium } from "playwright";
import fs from "fs";
import path from "path";
import {
  errorGateInit,
  armWebGPUDevices,
  collectGateErrors,
  attachConsoleErrorGate,
} from "../lib/webgpu-error-gate.mjs";

const BASE = process.env.PROBE_BASE || "http://localhost:8134";
const OUT_DIR = "Tools/visual-regression/output";

// SceneMode: 0=MORPH, 1=COLUMBUS_VIEW, 2=SCENE2D, 3=SCENE3D
const MODES = [
  { name: "2d", id: 2 },
  { name: "cv", id: 1 },
];

async function capture(rendererArg, mode) {
  const browser = await chromium.launch({
    channel: "msedge",
    headless: true,
    args: ["--enable-unsafe-webgpu"],
  });
  const page = await browser.newPage({
    viewport: { width: 1280, height: 720 },
  });

  const consoleErrors = attachConsoleErrorGate(page);
  const probeLogs = [];
  page.on("console", (m) => {
    if (m.text().includes("[probe]")) probeLogs.push(m.text());
  });
  await page.addInitScript(errorGateInit);

  const url = `${BASE}/Apps/CesiumViewer/index.html?renderer=${rendererArg}`;
  await page.goto(url, { waitUntil: "networkidle" });
  await page.waitForFunction(() => !!window.viewer);
  await armWebGPUDevices(page);

  const stats = await page.evaluate(async (modeId) => {
    const v = window.viewer;
    if (modeId === 1) v.scene.morphToColumbusView(0);
    else if (modeId === 2) v.scene.morphTo2D(0);
    else v.scene.morphTo3D(0);

    // Settle morph + tile loads + reprojection well past the requested
    // ~30 frames so imagery has time to stream in.
    for (let i = 0; i < 240; i++) {
      v.scene.render();
      await new Promise((r) => requestAnimationFrame(r));
    }

    const fs = v.scene.frameState;
    const tilesRendered =
      v.scene._globe?._surface?._tilesToRender?.length ?? -1;
    const frust = v.camera.frustum;

    // Canvas pixel stats — distinguish "globe rendered" from "blank".
    const c = v.scene.canvas;
    const off = document.createElement("canvas");
    off.width = c.width;
    off.height = c.height;
    const cx = off.getContext("2d");
    let pix;
    try {
      cx.drawImage(c, 0, 0);
      const data = cx.getImageData(0, 0, c.width, c.height).data;
      let nonBlack = 0,
        tR = 0,
        tG = 0,
        tB = 0,
        samples = 0;
      const step = 4 * 16;
      for (let i = 0; i < data.length; i += step) {
        samples++;
        tR += data[i];
        tG += data[i + 1];
        tB += data[i + 2];
        if (data[i] > 5 || data[i + 1] > 5 || data[i + 2] > 5) nonBlack++;
      }
      pix = {
        w: c.width,
        h: c.height,
        samples,
        nonBlack,
        nonBlackPct: ((100 * nonBlack) / samples).toFixed(1),
        avgR: (tR / samples).toFixed(1),
        avgG: (tG / samples).toFixed(1),
        avgB: (tB / samples).toFixed(1),
      };
    } catch (e) {
      pix = { err: e.message };
    }

    console.log(
      `[probe] mode=${v.scene.mode} morphTime=${fs?.morphTime} frustumType=${frust?.constructor?.name} tilesToRender=${tilesRendered}`,
    );
    return { mode: v.scene.mode, tilesRendered, pix };
  }, mode.id);

  await page.waitForTimeout(1200);

  const out = path.join(OUT_DIR, `bug3-2dcv-${mode.name}-${rendererArg}.png`);
  await page.screenshot({ path: out, fullPage: false });

  const gate = await collectGateErrors(page);
  await browser.close();

  const fatal = [
    ...consoleErrors,
    ...gate.errors,
    ...(gate.deviceLost ? [gate.deviceLost] : []),
  ];

  console.log(`  [${rendererArg}/${mode.name}] saved ${out}`);
  console.log(`    stats: ${JSON.stringify(stats)}`);
  console.log(`    gate: armed=${gate.armedDevices} fatal=${fatal.length}`);
  fatal.slice(0, 6).forEach((e) => console.log(`      FATAL: ${e}`));
  probeLogs.forEach((l) => console.log(`    ${l}`));
  return { out, stats, fatal };
}

(async () => {
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
  const results = {};
  for (const mode of MODES) {
    for (const r of ["webgl", "webgpu"]) {
      console.log(`[probe-2dcv-verify] ${r} ${mode.name}`);
      results[`${r}-${mode.name}`] = await capture(r, mode);
    }
  }
  console.log("\n[probe-2dcv-verify] SUMMARY");
  for (const k of Object.keys(results)) {
    const r = results[k];
    console.log(
      `  ${k}: nonBlackPct=${r.stats.pix?.nonBlackPct} avg=(${r.stats.pix?.avgR},${r.stats.pix?.avgG},${r.stats.pix?.avgB}) tiles=${r.stats.tilesRendered} fatal=${r.fatal.length}`,
    );
  }
  console.log("[probe-2dcv-verify] done");
})();
