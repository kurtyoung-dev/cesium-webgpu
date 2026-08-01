#!/usr/bin/env node
// probe-request-render-asymmetry.mjs — IS WEBGPU FAILING TO IDLE?
//
// Hypothesis under test (2026-07-19), from Scene.js:4102-4113:
//
//   const pendingAsyncResources =
//     this._context?.asyncResources?.pendingForegroundCount ?? 0;
//   let shouldRender = !this.requestRenderMode || ... || pendingAsyncResources > 0;
//
// The optional chain yields 0 on WebGL, so WebGL scenes never render for this
// reason. If WebGPU's pendingForegroundCount does NOT drain to 0 on a settled
// static scene, WebGPU re-renders EVERY frame while WebGL early-outs — which
// would masquerade as "WebGPU is half the FPS of WebGL" while actually being
// an idle-detection asymmetry, not a renderer throughput deficit.
//
// The CesiumViewer app runs requestRenderMode:true by default
// (Apps/CesiumViewer/CesiumViewerStartupOptions.js:24,41), so this affects
// the default user-facing configuration.
//
// Lanes:
//   A. requestRenderMode = TRUE  (app default) — sample pendingForegroundCount
//      over time on a STATIC settled scene; count real renders vs early-outs.
//   B. requestRenderMode = FALSE (forced)      — both backends do full work
//      every call, giving the HONEST apples-to-apples cost ratio.
//
// Usage: node Tools/visual-regression/probe-request-render-asymmetry.mjs

import { chromium } from "playwright";
import fs from "fs";
import path from "path";

const BASE = "http://localhost:8080";
const OUT_DIR = "Tools/visual-regression/output";
const SETTLE_MS = 12000; // generous: let tiles/imagery/pipelines finish
const IDLE_SAMPLES = 90;
const WARMUP = 40;
const MEASURE = 80;

const HARD_LIMIT_MS = 260000;
const watchdog = setTimeout(() => {
  console.error("[probe-rrm] WATCHDOG FIRED (260s) — forcing exit");
  process.exit(2);
}, HARD_LIMIT_MS);
if (watchdog.unref) watchdog.unref();

function summarize(arr) {
  const a = arr
    .filter((x) => typeof x === "number" && isFinite(x))
    .slice()
    .sort((x, y) => x - y);
  if (!a.length) return null;
  const q = (p) =>
    a[Math.min(a.length - 1, Math.max(0, Math.floor(p * (a.length - 1))))];
  return {
    n: a.length,
    median: q(0.5),
    p95: q(0.95),
    min: a[0],
    max: a[a.length - 1],
    mean: a.reduce((s, x) => s + x, 0) / a.length,
  };
}
const r3 = (x) => (x == null ? null : Math.round(x * 1000) / 1000);

async function laneFor(browser, renderer) {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 720 },
  });
  const page = await context.newPage();
  const out = { renderer, ok: false };
  try {
    await page.goto(
      `${BASE}/Apps/CesiumViewer/index.html?renderer=${renderer}`,
      {
        waitUntil: "domcontentloaded",
        timeout: 90000,
      },
    );
    await page.waitForFunction(
      () =>
        !!(window.viewer && window.viewer.scene && window.viewer.scene.context),
      null,
      {
        timeout: 90000,
      },
    );
    await page.waitForTimeout(SETTLE_MS);

    // ---- Lane A: requestRenderMode as the app ships it ----
    out.laneA = await page.evaluate(
      async ({ samples }) => {
        const scene = window.viewer.scene;
        const ctx = scene.context;
        const probeAsync = () => {
          const ar = ctx && ctx.asyncResources;
          if (!ar) return { present: false, foreground: null, total: null };
          return {
            present: true,
            foreground: ar.pendingForegroundCount ?? null,
            background: ar.pendingBackgroundCount ?? null,
            total: ar.pendingCount ?? null,
          };
        };
        const first = probeAsync();
        const pendingSeries = [];
        const renderMs = [];
        let renderRequestedCount = 0;
        for (let i = 0; i < samples; i++) {
          const p = probeAsync();
          pendingSeries.push(p.foreground);
          if (scene._renderRequested) renderRequestedCount++;
          const t0 = performance.now();
          try {
            scene.render();
          } catch (e) {
            /* ignore */
          }
          renderMs.push(performance.now() - t0);
          await new Promise((r) => requestAnimationFrame(r));
        }
        return {
          requestRenderMode: scene.requestRenderMode,
          asyncResourcesPresent: first.present,
          pendingForegroundFirst: first.foreground,
          pendingForegroundSeries: pendingSeries,
          pendingForegroundNonZeroFrames: pendingSeries.filter(
            (x) => typeof x === "number" && x > 0,
          ).length,
          pendingBackground: first.background,
          renderRequestedFrames: renderRequestedCount,
          renderMs,
        };
      },
      { samples: IDLE_SAMPLES },
    );

    // ---- Lane B: force continuous rendering — honest cost comparison ----
    out.laneB = await page.evaluate(
      async ({ warmup, measure }) => {
        const scene = window.viewer.scene;
        scene.requestRenderMode = false; // force real work every call
        for (let i = 0; i < warmup; i++) {
          try {
            scene.render();
          } catch (e) {}
          await new Promise((r) => requestAnimationFrame(r));
        }
        const renderMs = [];
        for (let i = 0; i < measure; i++) {
          const t0 = performance.now();
          try {
            scene.render();
          } catch (e) {}
          renderMs.push(performance.now() - t0);
          await new Promise((r) => requestAnimationFrame(r));
        }
        return { requestRenderMode: scene.requestRenderMode, renderMs };
      },
      { warmup: WARMUP, measure: MEASURE },
    );

    out.ok = true;
  } catch (e) {
    out.error = String((e && e.message) || e).slice(0, 400);
  } finally {
    await context.close().catch(() => {});
  }
  return out;
}

(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const browser = await chromium.launch({ channel: "msedge", headless: true });
  let gpu, gl;
  try {
    gpu = await laneFor(browser, "webgpu");
    gl = await laneFor(browser, "webgl");
  } finally {
    await browser.close().catch(() => {});
  }

  const sA = (l) => (l?.laneA ? summarize(l.laneA.renderMs) : null);
  const sB = (l) => (l?.laneB ? summarize(l.laneB.renderMs) : null);

  const gpuA = sA(gpu),
    glA = sA(gl),
    gpuB = sB(gpu),
    glB = sB(gl);

  const verdict = {
    Q_idle_asymmetry: (() => {
      if (!gpu?.laneA) return "UNKNOWN";
      const a = gpu.laneA;
      if (!a.asyncResourcesPresent)
        return "asyncResources absent on WebGPU context — hypothesis N/A";
      const nz = a.pendingForegroundNonZeroFrames;
      const pct = Math.round(
        (nz / (a.pendingForegroundSeries.length || 1)) * 100,
      );
      return nz > 0
        ? `CONFIRMED-RISK — pendingForegroundCount > 0 on ${nz}/${a.pendingForegroundSeries.length} idle frames (${pct}%); first=${a.pendingForegroundFirst}. This forces shouldRender=true every such frame on WebGPU while WebGL early-outs.`
        : `NOT-THE-CAUSE — pendingForegroundCount drained to 0 on all ${a.pendingForegroundSeries.length} idle frames (first=${a.pendingForegroundFirst}).`;
    })(),
    idle_render_ms: {
      webgpu_median: r3(gpuA?.median),
      webgl_median: r3(glA?.median),
      ratio:
        gpuA && glA && glA.median > 0 ? r3(gpuA.median / glA.median) : null,
      note: "requestRenderMode as shipped. A large ratio here can be idle-detection asymmetry, NOT throughput.",
    },
    honest_render_ms: {
      webgpu_median: r3(gpuB?.median),
      webgl_median: r3(glB?.median),
      ratio:
        gpuB && glB && glB.median > 0 ? r3(gpuB.median / glB.median) : null,
      note: "requestRenderMode=false on BOTH: every call does real work. THIS is the apples-to-apples CPU cost ratio.",
    },
    interpretation: (() => {
      if (!gpuA || !glA || !gpuB || !glB) return "incomplete";
      const idleRatio = gpuA.median / (glA.median || 1e-9);
      const honestRatio = gpuB.median / (glB.median || 1e-9);
      if (idleRatio > 3 && honestRatio < 1.5)
        return "The apparent deficit is DOMINATED BY IDLE ASYMMETRY: when both backends actually render, WebGPU is competitive. Fix the idle path, not the renderer.";
      if (honestRatio > 1.5)
        return "REAL THROUGHPUT DEFICIT: WebGPU costs more CPU per real frame even with both rendering continuously. Renderer hot path needs work.";
      return "WebGPU is at or better than parity per real frame.";
    })(),
  };

  const report = {
    probe: "request-render-asymmetry",
    date: new Date().toISOString(),
    verdict,
    webgpu: gpu,
    webgl: gl,
  };
  const outPath = path.join(OUT_DIR, "request-render-asymmetry-report.json");
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2));

  console.log(JSON.stringify(verdict, null, 2));
  if (gpu?.laneA) {
    console.log(
      "\nwebgpu idle pendingForeground series (first 30):",
      JSON.stringify(gpu.laneA.pendingForegroundSeries.slice(0, 30)),
    );
    console.log(
      "webgpu renderRequestedFrames:",
      gpu.laneA.renderRequestedFrames,
      "/",
      IDLE_SAMPLES,
    );
  }
  if (gl?.laneA) {
    console.log(
      "webgl  renderRequestedFrames:",
      gl.laneA.renderRequestedFrames,
      "/",
      IDLE_SAMPLES,
    );
    console.log(
      "webgl  asyncResourcesPresent:",
      gl.laneA.asyncResourcesPresent,
    );
  }
  if (gpu?.error) console.log("webgpu lane error:", gpu.error);
  if (gl?.error) console.log("webgl lane error:", gl.error);
  console.log(`\n[full report: ${outPath}]`);
  clearTimeout(watchdog);
  process.exit(0);
})().catch((e) => {
  console.error("[probe-rrm] FATAL", e);
  process.exit(1);
});
