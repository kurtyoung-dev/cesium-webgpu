#!/usr/bin/env node
// probe-webgpu-frame-breakdown.mjs — WHERE DOES THE WEBGPU FRAME TIME GO?
//
// Context (2026-07-19): probe-request-render-asymmetry measured, with
// requestRenderMode=false on BOTH backends (every call doing real work):
//     WebGPU  ~10.5 ms / scene.render()
//     WebGL   ~0.6  ms / scene.render()
// on a STATIC, settled default scene. Idle-detection asymmetry was RULED OUT
// (pendingForegroundCount drained to 0 on all 90 idle frames).
//
// A ~10 ms fixed cost on a static scene points at per-frame rebuild work, not
// scene complexity. This probe localizes it using the profilers the fork
// already ships:
//   - CPU per-pass recording cost  (WebGPUSceneRenderer.setCpuPassProfiling)
//   - GPU per-pass timing          (timestamp-query, if available)
// and reports the UNACCOUNTED remainder (total render ms minus summed pass
// ms), which is where non-pass overhead — command generation, uniform packing,
// bind-group churn, allocation — would hide.
//
// Usage: node Tools/visual-regression/probe-webgpu-frame-breakdown.mjs

import { chromium } from "playwright";
import fs from "fs";
import path from "path";

const BASE = "http://localhost:8080";
const OUT_DIR = "Tools/visual-regression/output";
const SETTLE_MS = 12000;
const WARMUP = 40;
const MEASURE = 120;

const HARD_LIMIT_MS = 260000;
const watchdog = setTimeout(() => {
  console.error("[probe-frame-breakdown] WATCHDOG FIRED (260s) — forcing exit");
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
  };
}
const r3 = (x) => (x == null ? null : Math.round(x * 1000) / 1000);

(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const browser = await chromium.launch({ channel: "msedge", headless: true });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 720 },
  });
  const page = await context.newPage();
  const consoleErrors = [];
  page.on("console", (m) => {
    if (m.type() === "error") consoleErrors.push(m.text().slice(0, 200));
  });

  let result = {};
  try {
    await page.goto(`${BASE}/Apps/CesiumViewer/index.html?renderer=webgpu`, {
      waitUntil: "domcontentloaded",
      timeout: 90000,
    });
    await page.waitForFunction(
      () =>
        !!(window.viewer && window.viewer.scene && window.viewer.scene.context),
      null,
      {
        timeout: 90000,
      },
    );
    await page.waitForTimeout(SETTLE_MS);

    result = await page.evaluate(
      async ({ warmup, measure }) => {
        const scene = window.viewer.scene;
        const renderer = scene._alternateSceneRenderer;
        const out = { hasRenderer: !!renderer };
        if (!renderer) return out;

        scene.requestRenderMode = false;

        out.profilerAvailable =
          typeof renderer.setCpuPassProfiling === "function";
        if (out.profilerAvailable) renderer.setCpuPassProfiling(true);

        // GPU timestamp profiler, if the device exposes it.
        out.gpuProfilerAvailable =
          typeof renderer.setGpuPassProfiling === "function";
        if (out.gpuProfilerAvailable) {
          try {
            renderer.setGpuPassProfiling(true);
          } catch (e) {
            out.gpuProfilerError = String(e && e.message);
          }
        }

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
        out.renderMs = renderMs;

        if (
          out.profilerAvailable &&
          typeof renderer.getCpuPassProfile === "function"
        ) {
          const p = renderer.getCpuPassProfile();
          out.cpuProfile = {
            enabled: p.enabled,
            frameCount: p.frameCount,
            passes: Object.values(p.passes || {}).map((x) => ({
              name: x.name,
              avgMs: x.avgMs,
              maxMs: x.maxMs,
              samples: x.samples,
            })),
          };
        }
        if (
          out.gpuProfilerAvailable &&
          typeof renderer.getGpuPassProfile === "function"
        ) {
          try {
            const g = renderer.getGpuPassProfile();
            out.gpuProfile = {
              enabled: g.enabled,
              frameCount: g.frameCount,
              passes: Object.values(g.passes || {}).map((x) => ({
                name: x.name,
                avgMs: x.avgMs,
                samples: x.samples,
              })),
            };
          } catch (e) {
            out.gpuProfileError = String(e && e.message);
          }
        }

        // Scene-level command/pass counts for context.
        try {
          const fs_ = scene._frameState || scene.frameState;
          out.sceneStats = {
            commandListLength: fs_?.commandList?.length ?? null,
            drawCommandsExecuted: scene._context?._drawCallCount ?? null,
            renderPassCount:
              renderer._renderPassCount ?? renderer.renderPassCount ?? null,
            tilesRendered:
              scene.globe?._surface?._tilesToRender?.length ?? null,
          };
        } catch (e) {
          out.sceneStatsError = String(e && e.message);
        }

        if (out.profilerAvailable) renderer.setCpuPassProfiling(false);
        return out;
      },
      { warmup: WARMUP, measure: MEASURE },
    );
  } catch (e) {
    result.error = String((e && e.message) || e).slice(0, 400);
  } finally {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }

  const total = summarize(result.renderMs || []);
  const passes = (result.cpuProfile?.passes || [])
    .slice()
    .sort((a, b) => b.avgMs - a.avgMs);
  const passSum = passes.reduce((s, p) => s + (p.avgMs || 0), 0);

  const report = {
    probe: "webgpu-frame-breakdown",
    date: new Date().toISOString(),
    totalRenderMs: total
      ? {
          median: r3(total.median),
          p95: r3(total.p95),
          min: r3(total.min),
          max: r3(total.max),
        }
      : null,
    cpuPassSumMs: r3(passSum),
    unaccountedMs: total ? r3(total.median - passSum) : null,
    unaccountedPct:
      total && total.median > 0
        ? Math.round(((total.median - passSum) / total.median) * 100)
        : null,
    topCpuPasses: passes.slice(0, 15).map((p) => ({
      name: p.name,
      avgMs: r3(p.avgMs),
      maxMs: r3(p.maxMs),
      samples: p.samples,
    })),
    gpuPasses: (result.gpuProfile?.passes || [])
      .slice()
      .sort((a, b) => b.avgMs - a.avgMs)
      .slice(0, 12)
      .map((p) => ({ name: p.name, avgMs: r3(p.avgMs) })),
    sceneStats: result.sceneStats,
    profilerAvailable: result.profilerAvailable,
    gpuProfilerAvailable: result.gpuProfilerAvailable,
    gpuProfileError: result.gpuProfileError || result.gpuProfilerError,
    consoleErrors: consoleErrors.slice(0, 8),
    error: result.error,
  };

  const outPath = path.join(OUT_DIR, "webgpu-frame-breakdown.json");
  fs.writeFileSync(outPath, JSON.stringify({ report, raw: result }, null, 2));
  console.log(JSON.stringify(report, null, 2));
  console.log(`\n[full report: ${outPath}]`);
  clearTimeout(watchdog);
  process.exit(0);
})().catch((e) => {
  console.error("[probe-frame-breakdown] FATAL", e);
  process.exit(1);
});
