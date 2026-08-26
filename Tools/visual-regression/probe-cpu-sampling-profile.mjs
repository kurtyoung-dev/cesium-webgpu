#!/usr/bin/env node
// probe-cpu-sampling-profile.mjs — V8 SAMPLING PROFILER FOR THE RENDER LOOP
// @purpose V8 sampling profiler over CDP for the render loop on both backends, attributing self-time the per-pass profiler cannot see.
// @status ACTIVE
//
// WHY THIS TOOL EXISTS (2026-07-19):
// probe-webgpu-frame-breakdown measured a static, settled WebGPU scene
// (9 draw commands, 6 tiles) at 10.5 ms per scene.render(), while the sum of
// ALL instrumented CPU render passes was 0.117 ms — i.e. 99% of the frame is
// spent outside every pass the in-engine profiler can see. The engine's
// per-pass instrumentation cannot localize it by construction, so this probe
// attaches the V8 sampling profiler over CDP and attributes self-time to
// actual JS functions.
//
// It profiles BOTH backends on the same scene so the WebGPU-specific cost is
// isolated from shared Scene work (WebGL renders the same scene in ~0.6 ms).
//
// Output: top self-time functions per backend + a WebGPU-only delta view.
//
// Usage: node Tools/visual-regression/probe-cpu-sampling-profile.mjs
//        node Tools/visual-regression/probe-cpu-sampling-profile.mjs --frames 200

import { chromium } from "playwright";
import fs from "fs";
import path from "path";

const BASE = "http://localhost:8080";
const OUT_DIR = "Tools/visual-regression/output";

// Opt-in determinism for callers that need a network-independent scene: the
// CesiumViewer's `offline=true` mode drops world imagery and world terrain, so
// tile count -- and every per-tile upload it drives -- stops moving with the
// network. Unset, this is the empty string and the URL is the historical online
// one, byte for byte. The C11-170 gate sets it for its children.
const VIEWER_OFFLINE_QUERY =
  process.env.PROBE_VIEWER_OFFLINE === "1" ? "&offline=true" : "";
const SETTLE_MS = 12000;
const WARMUP = 40;
const argFrames = (() => {
  const i = process.argv.indexOf("--frames");
  return i > -1 ? parseInt(process.argv[i + 1], 10) : 150;
})();
const MEASURE = Number.isFinite(argFrames) ? argFrames : 150;

const HARD_LIMIT_MS = 280000;
const watchdog = setTimeout(() => {
  console.error("[probe-cpu-profile] WATCHDOG FIRED (280s) — forcing exit");
  process.exit(2);
}, HARD_LIMIT_MS);
if (watchdog.unref) watchdog.unref();

const r3 = (x) => (x == null ? null : Math.round(x * 1000) / 1000);

// Aggregate a CDP .cpuprofile into self-time per call frame.
function aggregate(profile) {
  const byId = new Map();
  for (const n of profile.nodes) byId.set(n.id, n);

  const selfTimeUs = new Map(); // nodeId -> microseconds
  const { samples = [], timeDeltas = [] } = profile;
  for (let i = 0; i < samples.length; i++) {
    const id = samples[i];
    const dt = timeDeltas[i] || 0;
    selfTimeUs.set(id, (selfTimeUs.get(id) || 0) + dt);
  }

  // Roll up by function identity (name + url + line), since V8 may split nodes.
  const byFn = new Map();
  for (const [id, us] of selfTimeUs) {
    const n = byId.get(id);
    if (!n) continue;
    const cf = n.callFrame || {};
    const name = cf.functionName || "(anonymous)";
    const url = (cf.url || "").split("/").slice(-1)[0] || "(native)";
    const key = `${name} @ ${url}:${cf.lineNumber ?? "?"}`;
    byFn.set(key, (byFn.get(key) || 0) + us);
  }

  const totalUs = [...selfTimeUs.values()].reduce((s, x) => s + x, 0) || 1;
  const rows = [...byFn.entries()]
    .map(([fn, us]) => ({ fn, ms: us / 1000, pct: (us / totalUs) * 100 }))
    .sort((a, b) => b.ms - a.ms);
  return { rows, totalMs: totalUs / 1000 };
}

async function profileBackend(browser, renderer) {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 720 },
  });
  const page = await context.newPage();
  const out = { renderer, ok: false };
  try {
    await page.goto(
      `${BASE}/Apps/CesiumViewer/index.html?renderer=${renderer}${VIEWER_OFFLINE_QUERY}`,
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

    // Force real work every call so we profile rendering, not the idle early-out.
    await page.evaluate(async (warmup) => {
      const scene = window.viewer.scene;
      scene.requestRenderMode = false;
      for (let i = 0; i < warmup; i++) {
        try {
          scene.render();
        } catch (e) {}
        await new Promise((r) => requestAnimationFrame(r));
      }
    }, WARMUP);

    const client = await page.context().newCDPSession(page);
    await client.send("Profiler.enable");
    await client.send("Profiler.setSamplingInterval", { interval: 100 }); // 100us
    await client.send("Profiler.start");

    const timing = await page.evaluate(async (measure) => {
      const scene = window.viewer.scene;
      const ms = [];
      for (let i = 0; i < measure; i++) {
        const t0 = performance.now();
        try {
          scene.render();
        } catch (e) {}
        ms.push(performance.now() - t0);
        await new Promise((r) => requestAnimationFrame(r));
      }
      const sorted = ms.slice().sort((a, b) => a - b);
      return {
        median: sorted[Math.floor(sorted.length / 2)],
        frames: ms.length,
        totalMs: ms.reduce((s, x) => s + x, 0),
      };
    }, MEASURE);

    const { profile } = await client.send("Profiler.stop");
    await client.detach().catch(() => {});

    const agg = aggregate(profile);
    out.timing = timing;
    out.sampledTotalMs = r3(agg.totalMs);
    out.top = agg.rows
      .slice(0, 30)
      .map((r) => ({ fn: r.fn, ms: r3(r.ms), pct: r3(r.pct) }));
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
    gpu = await profileBackend(browser, "webgpu");
    gl = await profileBackend(browser, "webgl");
  } finally {
    await browser.close().catch(() => {});
  }

  // WebGPU-only view: functions absent (or far cheaper) in the WebGL profile.
  const glMap = new Map((gl?.top || []).map((r) => [r.fn, r.ms]));
  const webgpuSpecific = (gpu?.top || [])
    .map((r) => ({
      ...r,
      webglMs: glMap.get(r.fn) ?? 0,
      deltaMs: r3(r.ms - (glMap.get(r.fn) ?? 0)),
    }))
    .filter((r) => r.deltaMs > 0)
    .sort((a, b) => b.deltaMs - a.deltaMs)
    .slice(0, 20);

  const report = {
    probe: "cpu-sampling-profile",
    date: new Date().toISOString(),
    frames: MEASURE,
    webgpu: {
      medianRenderMs: r3(gpu?.timing?.median),
      sampledTotalMs: gpu?.sampledTotalMs,
      error: gpu?.error,
    },
    webgl: {
      medianRenderMs: r3(gl?.timing?.median),
      sampledTotalMs: gl?.sampledTotalMs,
      error: gl?.error,
    },
    webgpuTopSelfTime: gpu?.top?.slice(0, 20),
    webglTopSelfTime: gl?.top?.slice(0, 12),
    webgpuSpecificHotspots: webgpuSpecific,
  };

  const outPath = path.join(OUT_DIR, "cpu-sampling-profile.json");
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2));

  console.log(
    `WebGPU median render: ${report.webgpu.medianRenderMs} ms   |   WebGL median render: ${report.webgl.medianRenderMs} ms`,
  );
  console.log(`\n=== WebGPU top self-time (${MEASURE} frames) ===`);
  for (const r of (gpu?.top || []).slice(0, 18))
    console.log(
      `  ${String(r.ms).padStart(9)} ms  ${String(r.pct).padStart(6)}%  ${r.fn}`,
    );
  console.log(`\n=== WebGL top self-time (control) ===`);
  for (const r of (gl?.top || []).slice(0, 10))
    console.log(
      `  ${String(r.ms).padStart(9)} ms  ${String(r.pct).padStart(6)}%  ${r.fn}`,
    );
  console.log(`\n=== WebGPU-SPECIFIC hotspots (delta vs WebGL) ===`);
  for (const r of webgpuSpecific.slice(0, 15))
    console.log(`  +${String(r.deltaMs).padStart(9)} ms  ${r.fn}`);
  if (gpu?.error) console.log("webgpu error:", gpu.error);
  if (gl?.error) console.log("webgl error:", gl.error);
  console.log(`\n[full report: ${outPath}]`);
  clearTimeout(watchdog);
  process.exit(0);
})().catch((e) => {
  console.error("[probe-cpu-profile] FATAL", e);
  process.exit(1);
});
