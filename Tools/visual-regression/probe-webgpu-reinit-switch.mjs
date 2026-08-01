#!/usr/bin/env node
// NS-WEBGPU-REINIT-BLACK-AFTER-SWITCH acceptance probe.
//
// USER-REPORTED (2026-07-05): start the viewer in WebGL, switch to WebGPU
// (renders fine), switch back to WebGL, then switch to WebGPU AGAIN -> the
// second WebGPU init renders ONLY BLACK. The first WebGPU init works; the
// second (after a WebGL round-trip) is broken -> a WebGPU teardown/re-init
// lifecycle bug.
//
// This probe drives the CesiumViewer renderer toggle through the exact
// sequence WebGL -> WebGPU -> WebGL -> WebGPU using window.switchRenderer,
// captures the FIRST WebGPU frame and the SECOND (post-round-trip) WebGPU
// frame, and computes per-frame pixel variance + non-black fraction.
//
// PASS: the SECOND WebGPU frame is NOT black (non-trivial variance) and is
// comparable to the FIRST WebGPU frame. READ THE PNGs.
//
// Usage: node Tools/visual-regression/probe-webgpu-reinit-switch.mjs

import { chromium } from "playwright";
import fs from "fs";
import path from "path";

const BASE = process.env.PROBE_BASE || "http://localhost:8080";
const OUT_DIR = "Tools/visual-regression/output";

async function stats(page, pngPath) {
  // Screenshot the whole viewport then compute variance / non-black fraction
  // by decoding the PNG in-page (no Node PNG dep).
  await page.screenshot({ path: pngPath, fullPage: false });
  const b64 = fs.readFileSync(pngPath).toString("base64");
  return await page.evaluate(async (b64) => {
    const img = new Image();
    img.src = "data:image/png;base64," + b64;
    await img.decode();
    const c = document.createElement("canvas");
    c.width = img.naturalWidth;
    c.height = img.naturalHeight;
    const ctx = c.getContext("2d");
    ctx.drawImage(img, 0, 0);
    const data = ctx.getImageData(0, 0, c.width, c.height).data;
    let n = 0,
      sum = 0,
      sumSq = 0,
      nonBlack = 0;
    for (let i = 0; i < data.length; i += 4) {
      const lum =
        0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
      sum += lum;
      sumSq += lum * lum;
      if (lum > 12) nonBlack++;
      n++;
    }
    const mean = sum / n;
    const variance = sumSq / n - mean * mean;
    return {
      mean: +mean.toFixed(2),
      stddev: +Math.sqrt(Math.max(0, variance)).toFixed(2),
      nonBlackPct: +((100 * nonBlack) / n).toFixed(2),
    };
  }, b64);
}

async function renderBurst(page, frames) {
  await page.evaluate(async (n) => {
    // Render whichever viewer is currently the active window.viewer, plus
    // pump the render loop so tiles/imagery settle.
    for (let i = 0; i < n; i++) {
      const v = window.viewer;
      if (v && !v.isDestroyed()) v.scene.render();
      await new Promise((r) => requestAnimationFrame(r));
    }
  }, frames);
}

async function switchTo(page, mode) {
  // window.switchRenderer awaits createAsync internally; page.evaluate awaits
  // the returned promise, so on resolve the new viewer is live. The webgl
  // branch does not update window.viewer, so renderBurst guards on validity.
  await page.evaluate((m) => window.switchRenderer(m), mode);
  await page.waitForTimeout(500);
  await renderBurst(page, 120);
  await page.waitForTimeout(800);
}

async function run() {
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
  const messages = [];
  page.on("console", (m) => {
    messages.push({ t: m.type(), text: m.text() });
    if (m.type() === "error")
      console.log(`  [console.error] ${m.text().slice(0, 220)}`);
  });
  page.on("pageerror", (e) => {
    messages.push({ t: "pageerror", text: e.message });
    console.log(`  [pageerror] ${e.message.slice(0, 220)}`);
  });

  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

  // Start in WebGL (default renderer for the CesiumViewer page).
  const url = `${BASE}/Apps/CesiumViewer/index.html?renderer=webgl`;
  await page.goto(url, { waitUntil: "networkidle" });
  await page.waitForFunction(() => !!window.switchRenderer);
  await page.waitForFunction(() => !!window.viewer);
  await renderBurst(page, 60);

  // Fixed camera over land so a working frame is unmistakably non-black.
  await page.evaluate(() => {
    const v = window.viewer;
    const Cartesian3 = v.camera.positionWC.constructor;
    v.camera.setView({
      destination: Cartesian3.fromDegrees(-95.0, 38.0, 8000000.0),
    });
  });

  // WebGL -> WebGPU (first init). Reset camera each time because a fresh
  // viewer starts at the default view.
  const setCam = async () =>
    page.evaluate(() => {
      const v = window.viewer;
      if (!v || v.isDestroyed || v.isDestroyed?.()) return "no-viewer";
      const Cartesian3 = v.camera.positionWC.constructor;
      v.camera.setView({
        destination: Cartesian3.fromDegrees(-95.0, 38.0, 8000000.0),
      });
      return "ok";
    });

  await switchTo(page, "webgpu");
  await setCam();
  await renderBurst(page, 120);
  await page.waitForTimeout(800);
  const first = await stats(
    page,
    path.join(OUT_DIR, "probe-reinit-1-webgpu-first.png"),
  );

  // WebGPU -> WebGL (round-trip).
  await switchTo(page, "webgl");
  await setCam();
  await renderBurst(page, 60);

  // WebGL -> WebGPU (SECOND init — the reported black frame).
  await switchTo(page, "webgpu");
  await setCam();
  await renderBurst(page, 120);
  await page.waitForTimeout(800);
  const second = await stats(
    page,
    path.join(OUT_DIR, "probe-reinit-2-webgpu-second.png"),
  );

  await browser.close();

  const errs = messages.filter((m) => m.t === "error" || m.t === "pageerror");
  console.log(
    "[probe-webgpu-reinit-switch] first  WebGPU frame:",
    JSON.stringify(first),
  );
  console.log(
    "[probe-webgpu-reinit-switch] second WebGPU frame:",
    JSON.stringify(second),
  );
  if (errs.length) {
    console.log(
      `\n[probe-webgpu-reinit-switch] ${errs.length} console errors (first 8):`,
    );
    errs
      .slice(0, 8)
      .forEach((e) => console.log(`    ${e.t}: ${e.text.slice(0, 200)}`));
  }

  // PASS criteria: second frame has non-trivial variance AND a healthy
  // non-black fraction comparable to the first frame.
  const secondBlack = second.stddev < 5 || second.nonBlackPct < 10;
  const comparable = second.nonBlackPct >= 0.5 * first.nonBlackPct;
  const pass = !secondBlack && comparable;
  console.log(
    `\n[probe-webgpu-reinit-switch] ${pass ? "PASS" : "FAIL"} ` +
      `(second black=${secondBlack}, comparable=${comparable})`,
  );
  process.exitCode = pass ? 0 : 1;
}

run();
