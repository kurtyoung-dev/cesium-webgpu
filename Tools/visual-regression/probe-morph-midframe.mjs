#!/usr/bin/env node
// Probe (morph audit): capture MID-MORPH frames during a non-zero-duration
// 3D→2D and 3D→Columbus transition, for WebGL vs WebGPU. The existing probes
// only use duration-0 morphs (terminal states); this exercises the MORPHING
// branch (scene.mode === 0, 0 < morphTime < 1) that the audit found broken.
//
// Signal: during the morph the globe should smoothly flatten (nonBlack% rises
// 3D→2D / stays substantial 3D→CV). If the WebGPU globe is displaced off-screen
// mid-morph (the mesh.center double-count P1), its mid-morph nonBlack% craters
// toward ~0 while WebGL stays substantial.
//
// Usage: node Tools/visual-regression/probe-morph-midframe.mjs
// Out:   output/morph-mid-{2d,cv}-{webgl,webgpu}.png  (a ~morphTime 0.5 frame)

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
const TARGETS = [
  { name: "2d", call: "morphTo2D" },
  { name: "cv", call: "morphToColumbusView" },
];

async function capture(rendererArg, target) {
  const browser = await chromium.launch({
    channel: "msedge",
    headless: true,
    args: ["--enable-unsafe-webgpu"],
  });
  const page = await browser.newPage({
    viewport: { width: 1280, height: 720 },
  });
  const consoleErrors = attachConsoleErrorGate(page);
  await page.addInitScript(errorGateInit);
  await page.goto(
    `${BASE}/Apps/CesiumViewer/index.html?renderer=${rendererArg}`,
    {
      waitUntil: "networkidle",
    },
  );
  await page.waitForFunction(() => !!window.viewer);
  await armWebGPUDevices(page);

  // Phase 1: reset to 3D, settle, then run a 2.0s morph; render frame-by-frame,
  // sampling morphTime + nonBlack%. STOP at the first frame with morphTime≈0.5
  // so the canvas holds a mid-morph frame for the screenshot.
  const result = await page.evaluate(async (call) => {
    const v = window.viewer;
    const MORPHING = 0; // SceneMode.MORPHING
    // Ensure we start from a clean 3D state. initializeFrame() is the tween
    // driver (advances the morphTime animation); render() alone won't tick it.
    v.scene.morphTo3D(0);
    for (let i = 0; i < 90; i++) {
      v.scene.initializeFrame();
      v.scene.render();
      await new Promise((r) => requestAnimationFrame(r));
    }

    function nonBlackPct() {
      const c = v.scene.canvas;
      const off = document.createElement("canvas");
      off.width = c.width;
      off.height = c.height;
      const cx = off.getContext("2d");
      cx.drawImage(c, 0, 0);
      const d = cx.getImageData(0, 0, c.width, c.height).data;
      let nb = 0,
        t = 0;
      for (let p = 0; p < d.length; p += 64) {
        t++;
        if (d[p] > 8 || d[p + 1] > 8 || d[p + 2] > 8) nb++;
      }
      return (100 * nb) / t;
    }

    const startPct = nonBlackPct();
    v.scene[call](2.0); // non-zero duration → animated morph

    const samples = [];
    let midCaptured = false;
    let midMorphTime = null;
    let midPct = null;
    let midDataUrl = null;
    let minPctDuringMorph = 101;
    // Render up to ~6s of frames; bail when morph completes.
    for (let i = 0; i < 360; i++) {
      v.scene.initializeFrame();
      v.scene.render();
      await new Promise((r) => requestAnimationFrame(r));
      const mode = v.scene.mode;
      const mt = v.scene.morphTime;
      if (mode === MORPHING) {
        const pct = nonBlackPct();
        samples.push({ mt: +mt.toFixed(3), pct: +pct.toFixed(1) });
        if (pct < minPctDuringMorph) minPctDuringMorph = pct;
        // Capture the first frame near the midpoint and then STOP so the
        // canvas holds it for the Node screenshot.
        if (!midCaptured && mt <= 0.55 && mt >= 0.35) {
          midCaptured = true;
          midMorphTime = +mt.toFixed(3);
          midPct = +pct.toFixed(1);
          // Capture the canvas RIGHT NOW (same microtask as the render) so
          // the saved frame is exactly this morphTime — the default render
          // loop keeps morphing after evaluate() returns, so a Node-side
          // page.screenshot would catch an arbitrary later frame.
          midDataUrl = v.scene.canvas.toDataURL("image/png");
          break;
        }
      } else if (i > 3) {
        // morph already finished (shouldn't happen before mid for 2s morph)
        break;
      }
    }
    return {
      startPct: +startPct.toFixed(1),
      midCaptured,
      midMorphTime,
      midPct,
      midDataUrl,
      minPctDuringMorph: +minPctDuringMorph.toFixed(1),
      // a few representative samples across the captured span
      samples: samples.filter(
        (_, i) => i % Math.max(1, Math.floor(samples.length / 8)) === 0,
      ),
    };
  }, target.call);

  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
  const out = path.join(OUT_DIR, `morph-mid-${target.name}-${rendererArg}.png`);
  if (result.midDataUrl) {
    // Deterministic: the exact mid-morph canvas frame captured in-evaluate.
    fs.writeFileSync(
      out,
      Buffer.from(result.midDataUrl.split(",")[1], "base64"),
    );
  } else {
    await page.screenshot({ path: out });
  }
  const gate = await collectGateErrors(page);
  await browser.close();

  const fatal = [
    ...consoleErrors,
    ...gate.errors,
    ...(gate.deviceLost ? [gate.deviceLost] : []),
  ];
  console.log(
    `\n===== ${rendererArg.toUpperCase()} 3D→${target.name.toUpperCase()} =====`,
  );
  console.log(
    `  startPct(3D)=${result.startPct}  midMorphTime=${result.midMorphTime}  midPct=${result.midPct}  minPctDuringMorph=${result.minPctDuringMorph}`,
  );
  console.log(
    `  samples(mt:pct): ${result.samples.map((s) => `${s.mt}:${s.pct}`).join("  ")}`,
  );
  console.log(`  gate fatal=${fatal.length}  saved ${out}`);
  fatal.slice(0, 4).forEach((e) => console.log(`    FATAL: ${e}`));
  return { rendererArg, target: target.name, ...result, fatal: fatal.length };
}

(async () => {
  const rows = [];
  for (const target of TARGETS) {
    for (const r of ["webgl", "webgpu"]) {
      rows.push(await capture(r, target));
    }
  }
  console.log(
    "\n[probe-morph-midframe] SUMMARY (mid-morph nonBlack%, webgl vs webgpu)",
  );
  for (const t of ["2d", "cv"]) {
    const gl = rows.find((x) => x.rendererArg === "webgl" && x.target === t);
    const gpu = rows.find((x) => x.rendererArg === "webgpu" && x.target === t);
    console.log(
      `  3D→${t}: webgl mid=${gl?.midPct} (min ${gl?.minPctDuringMorph})  |  webgpu mid=${gpu?.midPct} (min ${gpu?.minPctDuringMorph})  | fatal gl=${gl?.fatal} gpu=${gpu?.fatal}`,
    );
  }
  console.log("[probe-morph-midframe] done");
})();
