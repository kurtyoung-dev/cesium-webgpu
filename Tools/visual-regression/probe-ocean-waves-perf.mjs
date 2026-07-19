#!/usr/bin/env node
// probe-ocean-waves-perf.mjs — OCEAN-WAVES PERF AUDIT (C11-158)
//
// Measures the WebGPU enhanced-ocean fragment cost (Fresnel + GGX specular +
// 3-octave wave normals + foam + SSS) ON vs OFF on a STATIC, ocean-dominant
// nadir view. Bounded/deterministic (no moving-altitude track) with a HARD
// watchdog so it can never hang the machine.
//
// Toggle: globe.showWaterEffect  (gates flags.x=showReflectiveOcean AND
//   flags.z=showOceanWaves — i.e. the entire computeEnhancedOcean call incl.
//   the 3-octave sampleOceanWaveNormals march).
//
// Metrics per rep:
//   - CPU: wall-clock ms around scene.render() (JS + command encoding)
//   - GPU: WebGPU timestamp-query per-pass avgMs (globe/terrain pass) +
//          whole-frame frameAvgMs.
//
// Usage: node Tools/visual-regression/probe-ocean-waves-perf.mjs
// Output: JSON to stdout + ocean-waves-{ON,OFF}.png screenshots.

import { chromium } from "playwright";
import fs from "fs";
import path from "path";

const BASE = "http://localhost:8080";
const OUT_DIR = "Tools/visual-regression/output";
// Mid-Pacific open ocean, nadir (pitch -90), 20 km altitude.
// -> viewport is ~100% ocean; at 20 km the wave fade (waveIntensityFade,
//    zero only above ~1000 km) is ~1.0, so the 3-octave march runs at full
//    strength across the frame — the maximum-wave-cost case.
const VIEW = process.env.VIEW || "-145,25,20000,0,-90";
const REPS = 5;
const WARMUP_FRAMES = 90;
const MEASURE_FRAMES = 60;
const SETTLE_FRAMES = 260;

// ── HARD watchdog: force-exit if anything hangs (machine safety) ──
const HARD_LIMIT_MS = 200000; // 200s < the Bash 260s timeout
const watchdog = setTimeout(() => {
  console.error("[probe-ocean-waves] WATCHDOG FIRED (200s) — forcing exit");
  process.exit(2);
}, HARD_LIMIT_MS);
if (watchdog.unref) watchdog.unref();

function summarize(arr) {
  const a = arr.filter((x) => typeof x === "number" && isFinite(x)).slice().sort((x, y) => x - y);
  if (!a.length) return null;
  const q = (p) => a[Math.min(a.length - 1, Math.max(0, Math.floor(p * (a.length - 1))))];
  const sum = a.reduce((s, x) => s + x, 0);
  return {
    n: a.length,
    median: q(0.5),
    p95: q(0.95),
    min: a[0],
    max: a[a.length - 1],
    mean: sum / a.length,
    noise: a[a.length - 1] - a[0],
  };
}
const r3 = (x) => (x == null ? null : Math.round(x * 1000) / 1000);

(async () => {
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

  const browser = await chromium.launch({
    channel: "msedge",
    headless: true,
    args: ["--enable-unsafe-webgpu", "--enable-features=Vulkan", "--use-vulkan"],
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const logs = [];
  page.on("console", (m) => logs.push(`[${m.type()}] ${m.text()}`));
  page.on("pageerror", (e) => logs.push(`[pageerror] ${e.message}`));

  const url = `${BASE}/Apps/CesiumViewer/index.html?renderer=webgpu&view=${encodeURIComponent(VIEW)}`;
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForFunction(() => !!window.viewer, { timeout: 30000 });

  // Take manual control of the render loop (fully deterministic; no
  // autonomous loop keeping the GPU busy after we finish).
  const settle = await page.evaluate(async (n) => {
    const v = window.viewer;
    v.useDefaultRenderLoop = false;
    const ctx = v.scene._context;
    for (let i = 0; i < n; i++) {
      v.scene.render();
      await new Promise((r) => requestAnimationFrame(r));
    }
    const globe = v.scene.globe;
    return {
      isWebGPU: !!ctx && !!ctx.isWebGPU,
      rendererType: ctx && ctx.rendererType,
      hasWaterMask: !!(globe.terrainProvider && globe.terrainProvider.hasWaterMask),
      terrainReady: !!(globe.terrainProvider && globe.terrainProvider.availability),
      showWaterEffect: globe.showWaterEffect,
      enableEnhancedOcean: globe.enableEnhancedOcean,
      oceanNormalMapUrl: globe.oceanNormalMapUrl,
      hasTimestampQuery: !!(ctx && ctx.hasFeature && ctx.hasFeature("timestamp-query")),
      tilesRendered:
        (globe._surface && globe._surface._tilesToRender && globe._surface._tilesToRender.length) || -1,
      cameraHeight: v.camera.positionCartographic.height,
    };
  }, SETTLE_FRAMES);
  console.log("SETTLE " + JSON.stringify(settle));

  async function measureState(wavesOn) {
    await page.evaluate((on) => {
      const v = window.viewer;
      v.scene.globe.showWaterEffect = on;
      const ctx = v.scene._context;
      if (ctx && ctx.performanceManager) {
        ctx.performanceManager.config.timestampProfiling = true;
      }
    }, wavesOn);
    // warmup so passes get instrumented + GPU-timestamp readback pipeline fills
    await page.evaluate(async (n) => {
      const v = window.viewer;
      for (let i = 0; i < n; i++) {
        v.scene.render();
        await new Promise((r) => requestAnimationFrame(r));
      }
    }, WARMUP_FRAMES);

    const reps = [];
    for (let rep = 0; rep < REPS; rep++) {
      const r = await page.evaluate(async (mf) => {
        const v = window.viewer;
        const ctx = v.scene._context;
        const prof = ctx && ctx.timestampProfiler;
        if (prof && prof.reset) prof.reset();
        const cpu = [];
        for (let i = 0; i < mf; i++) {
          const t0 = performance.now();
          v.scene.render();
          const t1 = performance.now();
          cpu.push(t1 - t0);
          await new Promise((r) => requestAnimationFrame(r));
        }
        const res = prof && prof.getResults ? prof.getResults() : null;
        let passDetail = {};
        let globePassMs = null;
        let globePassName = null;
        if (res && res.passes) {
          for (const [k, p] of Object.entries(res.passes)) {
            passDetail[k] = p.avgMs;
            if (globePassMs == null && /terrain|globe|surface/i.test(k)) {
              globePassMs = p.avgMs;
              globePassName = k;
            }
          }
        }
        return {
          cpu,
          profEnabled: res ? res.enabled : false,
          frameAvgMs: res ? res.frameAvgMs : null,
          frameMs: res ? res.frameMs : null,
          profiledPassAvgMs: res ? res.profiledPassAvgMs : null,
          globePassMs,
          globePassName,
          passDetail,
        };
      }, MEASURE_FRAMES);
      reps.push(r);
    }
    return reps;
  }

  const onReps = await measureState(true);
  const offReps = await measureState(false);

  // ── Screenshots to confirm the view is ocean-dominant + waves visibly toggle
  async function shot(on, name) {
    await page.evaluate(async (o) => {
      const v = window.viewer;
      v.scene.globe.showWaterEffect = o;
      for (let i = 0; i < 60; i++) {
        v.scene.render();
        await new Promise((r) => requestAnimationFrame(r));
      }
    }, on);
    await page.screenshot({ path: path.join(OUT_DIR, name), fullPage: false });
  }
  await shot(true, "ocean-waves-ON.png");
  await shot(false, "ocean-waves-OFF.png");

  await browser.close();
  clearTimeout(watchdog);

  // ── Aggregate ──
  const collectCPU = (reps) => reps.flatMap((r) => r.cpu);
  const perRepCPUmed = (reps) => reps.map((r) => summarize(r.cpu).median);
  const perRepCPUp95 = (reps) => reps.map((r) => summarize(r.cpu).p95);
  const perRepGlobe = (reps) => reps.map((r) => r.globePassMs);
  const perRepFrame = (reps) => reps.map((r) => r.frameAvgMs);
  // Summarize each named GPU pass across the 5 reps. The globe surface +
  // ocean fragment shading lives in "Scene Framebuffer Render Pass".
  const perPassSummary = (reps) => {
    const keys = new Set();
    reps.forEach((r) => Object.keys(r.passDetail || {}).forEach((k) => keys.add(k)));
    const out = {};
    for (const k of keys) {
      out[k] = summarize(reps.map((r) => (r.passDetail || {})[k]));
    }
    return out;
  };

  const out = {
    head: process.env.GIT_HEAD || null,
    view: VIEW,
    reps: REPS,
    measureFrames: MEASURE_FRAMES,
    settle,
    ON: {
      cpu_allframes: summarize(collectCPU(onReps)),
      cpu_perRep_median: perRepCPUmed(onReps),
      cpu_perRep_p95: perRepCPUp95(onReps),
      gpu_globePass_perRep: perRepGlobe(onReps),
      gpu_globePass_summary: summarize(perRepGlobe(onReps)),
      gpu_frameAvg_perRep: perRepFrame(onReps),
      gpu_frameAvg_summary: summarize(perRepFrame(onReps)),
      gpu_perPass_summary: perPassSummary(onReps),
      profEnabled: onReps[0] && onReps[0].profEnabled,
    },
    OFF: {
      cpu_allframes: summarize(collectCPU(offReps)),
      cpu_perRep_median: perRepCPUmed(offReps),
      cpu_perRep_p95: perRepCPUp95(offReps),
      gpu_globePass_perRep: perRepGlobe(offReps),
      gpu_globePass_summary: summarize(perRepGlobe(offReps)),
      gpu_frameAvg_perRep: perRepFrame(offReps),
      gpu_frameAvg_summary: summarize(perRepFrame(offReps)),
      gpu_perPass_summary: perPassSummary(offReps),
    },
    errors: logs.filter((l) => l.startsWith("[error]") || l.startsWith("[pageerror]")).slice(0, 8),
  };

  // Deltas
  const onGlobe = out.ON.gpu_globePass_summary;
  const offGlobe = out.OFF.gpu_globePass_summary;
  const onFrame = out.ON.gpu_frameAvg_summary;
  const offFrame = out.OFF.gpu_frameAvg_summary;
  const onCPU = out.ON.cpu_allframes;
  const offCPU = out.OFF.cpu_allframes;
  const SCENE_PASS = "Scene Framebuffer Render Pass";
  const onScene = out.ON.gpu_perPass_summary[SCENE_PASS];
  const offScene = out.OFF.gpu_perPass_summary[SCENE_PASS];
  out.DELTA = {
    // PRIMARY GPU metric: the scene color pass that contains the globe
    // surface + ocean fragment shading.
    gpu_scenePass_on_median: onScene ? r3(onScene.median) : null,
    gpu_scenePass_off_median: offScene ? r3(offScene.median) : null,
    gpu_scenePass_ms: onScene && offScene ? r3(onScene.median - offScene.median) : null,
    gpu_scenePass_pct:
      onScene && offScene && offScene.median ? r3(100 * (onScene.median - offScene.median) / offScene.median) : null,
    gpu_scenePass_noise_on: onScene ? r3(onScene.noise) : null,
    gpu_scenePass_noise_off: offScene ? r3(offScene.noise) : null,
    gpu_frameAvg_ms: onFrame && offFrame ? r3(onFrame.median - offFrame.median) : null,
    gpu_frameAvg_pct:
      onFrame && offFrame && offFrame.median ? r3(100 * (onFrame.median - offFrame.median) / offFrame.median) : null,
    // Enhanced-ocean cost as a fraction of the whole GPU frame.
    ocean_pct_of_frame:
      onScene && offScene && onFrame ? r3(100 * (onScene.median - offScene.median) / onFrame.median) : null,
    cpu_median_ms: onCPU && offCPU ? r3(onCPU.median - offCPU.median) : null,
    cpu_p95_ms: onCPU && offCPU ? r3(onCPU.p95 - offCPU.p95) : null,
  };

  console.log("RESULT " + JSON.stringify(out));
  console.log("[probe-ocean-waves] done");
  process.exit(0);
})().catch(async (e) => {
  console.error("[probe-ocean-waves] FATAL", e && e.stack ? e.stack : e);
  clearTimeout(watchdog);
  process.exit(1);
});
