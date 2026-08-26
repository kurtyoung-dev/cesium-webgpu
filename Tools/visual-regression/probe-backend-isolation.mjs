#!/usr/bin/env node
// probe-backend-isolation.mjs — IS WEBGL STILL RUNNING IN WEBGPU MODE?
// @purpose Answered 2026-07-19 maintainer questions: is a WebGL context still created in webgpu mode, and does split-screen cost what solo costs.
// @status INVESTIGATION
//
// Answers two maintainer questions empirically (2026-07-19):
//
//   Q1. When renderer=webgpu is selected, is a WebGL context still being
//       created / retained / driven? Instruments
//       HTMLCanvasElement.prototype.getContext BEFORE any page script runs,
//       so no context creation can escape the log regardless of which module
//       requests it or how lazily.
//
//   Q2. Split-screen reportedly costs the SAME as running one backend alone.
//       If true, per-frame cost is not dominated by renderer work. Measures
//       explicit scene.render() wall-clock in three lanes (webgpu-solo,
//       webgl-solo, split) so the claim is testable rather than anecdotal.
//
// Timing note: FPS/idle-soak is INVALID under requestRenderMode (see
// DEBUGGING_GUIDE). We therefore drive explicit scene.render() calls and
// measure wall-clock around them — the same pattern probe-ocean-waves-perf
// uses — instead of sampling an rAF-driven FPS counter.
//
// Usage: node Tools/visual-regression/probe-backend-isolation.mjs
// Output: JSON to stdout + backend-isolation-report.json

import { chromium } from "playwright";
import fs from "fs";
import path from "path";
import { launchLaneIfGated } from "./lib/backend-isolation-launch.mjs";

const BASE = "http://localhost:8080"; // NOTE: server binds IPv6; 127.0.0.1 does NOT resolve

// Opt-in determinism for callers that need a network-independent scene: the
// CesiumViewer's `offline=true` mode drops world imagery and world terrain, so
// tile count -- and every per-tile upload it drives -- stops moving with the
// network. Unset, this is the empty string and the URL is the historical online
// one, byte for byte. The C11-170 gate sets it for its children.
const VIEWER_OFFLINE_QUERY =
  process.env.PROBE_VIEWER_OFFLINE === "1" ? "&offline=true" : "";
const OUT_DIR = "Tools/visual-regression/output";
const WARMUP_FRAMES = 60;
const MEASURE_FRAMES = 90;

// ── HARD watchdog: force-exit if anything hangs (machine safety) ──
const HARD_LIMIT_MS = 240000;
const watchdog = setTimeout(() => {
  console.error(
    "[probe-backend-isolation] WATCHDOG FIRED (240s) — forcing exit",
  );
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

// Runs before ANY page script — catches every getContext call.
const INSTRUMENT = () => {
  window.__ctxCalls = [];
  const orig = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (type, ...rest) {
    let result;
    let threw = null;
    try {
      result = orig.call(this, type, ...rest);
    } catch (e) {
      threw = String(e && e.message);
      throw e;
    } finally {
      const stack = (new Error().stack || "")
        .split("\n")
        .slice(2, 7)
        .join(" | ");
      window.__ctxCalls.push({
        type: String(type),
        returnedNull: result == null,
        threw,
        canvasId: this.id || null,
        canvasClass: this.className || null,
        w: this.width,
        h: this.height,
        stack,
      });
    }
    return result;
  };
};

async function waitForViewer(page, globalName, timeoutMs = 90000) {
  await page.waitForFunction(
    (g) => {
      const v = window[g];
      return !!(v && v.scene && v.scene.context);
    },
    globalName,
    { timeout: timeoutMs },
  );
}

// Drive explicit renders and time them. Returns per-frame ms.
async function timeRenders(page, globalNames, warmup, measure) {
  return page.evaluate(
    async ({ names, warmup, measure }) => {
      const viewers = names.map((n) => window[n]).filter(Boolean);
      if (!viewers.length)
        return { error: "no viewers found for " + names.join(",") };
      const scenes = viewers.map((v) => v.scene);
      // Warm up: let caches/pipelines settle so we measure steady state.
      for (let i = 0; i < warmup; i++) {
        for (const s of scenes) {
          try {
            s.render();
          } catch (e) {
            /* keep going; report below */
          }
        }
        await new Promise((r) => requestAnimationFrame(r));
      }
      const samples = [];
      const perScene = scenes.map(() => []);
      for (let i = 0; i < measure; i++) {
        const t0 = performance.now();
        for (let k = 0; k < scenes.length; k++) {
          const s0 = performance.now();
          try {
            scenes[k].render();
          } catch (e) {
            /* ignore */
          }
          perScene[k].push(performance.now() - s0);
        }
        samples.push(performance.now() - t0);
        await new Promise((r) => requestAnimationFrame(r));
      }
      return { samples, perScene, sceneCount: scenes.length };
    },
    { names: globalNames, warmup, measure },
  );
}

async function inspectContexts(page, globalNames) {
  return page.evaluate((names) => {
    const calls = window.__ctxCalls || [];
    const classify = (t) => {
      const s = t.toLowerCase();
      if (s === "webgpu") return "webgpu";
      if (s.includes("webgl")) return "webgl";
      if (s === "2d" || s === "bitmaprenderer") return "2d";
      return "other";
    };
    const byKind = {};
    for (const c of calls) {
      const k = classify(c.type);
      byKind[k] = byKind[k] || { count: 0, nonNull: 0, types: {}, samples: [] };
      byKind[k].count++;
      if (!c.returnedNull) byKind[k].nonNull++;
      byKind[k].types[c.type] = (byKind[k].types[c.type] || 0) + 1;
      if (byKind[k].samples.length < 4) byKind[k].samples.push(c);
    }
    const viewerInfo = names
      .map((n) => {
        const v = window[n];
        if (!v || !v.scene || !v.scene.context) return null;
        const ctx = v.scene.context;
        return {
          global: n,
          rendererType: ctx.rendererType ?? null,
          isWebGPU: ctx.isWebGPU ?? null,
          contextId: ctx.id ?? null,
          // A live WebGL context object on a WebGPU scene would be the smoking gun.
          hasGlProperty: !!ctx._gl || !!ctx.gl,
        };
      })
      .filter(Boolean);
    return {
      totalGetContextCalls: calls.length,
      byKind,
      canvasCount: document.querySelectorAll("canvas").length,
      viewerInfo,
    };
  }, globalNames);
}

async function runLane(browser, { name, url, globals, launchSelector }) {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 720 },
  });
  await context.addInitScript(INSTRUMENT);
  const page = await context.newPage();
  const consoleErrors = [];
  page.on("console", (m) => {
    if (m.type() === "error") consoleErrors.push(m.text().slice(0, 300));
  });
  const lane = { name, url, ok: false };
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 90000 });
    await launchLaneIfGated(page, launchSelector);
    for (const g of globals) await waitForViewer(page, g);
    // Let terrain/imagery settle so we are not timing tile loads.
    await page.waitForTimeout(6000);
    lane.contexts = await inspectContexts(page, globals);
    const t = await timeRenders(page, globals, WARMUP_FRAMES, MEASURE_FRAMES);
    if (t.error) {
      lane.timingError = t.error;
    } else {
      lane.frameMs = summarize(t.samples);
      lane.perScene = t.perScene.map((s, i) => ({
        scene: globals[i] ?? `scene${i}`,
        ...summarize(s),
      }));
    }
    lane.consoleErrors = consoleErrors.slice(0, 6);
    lane.ok = true;
  } catch (e) {
    lane.error = String((e && e.message) || e).slice(0, 400);
    lane.consoleErrors = consoleErrors.slice(0, 6);
  } finally {
    await context.close().catch(() => {});
  }
  return lane;
}

(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const browser = await chromium.launch({ channel: "msedge", headless: true });
  const lanes = [];
  try {
    lanes.push(
      await runLane(browser, {
        name: "webgpu-solo",
        url: `${BASE}/Apps/CesiumViewer/index.html?renderer=webgpu${VIEWER_OFFLINE_QUERY}`,
        globals: ["viewer"],
      }),
    );
    lanes.push(
      await runLane(browser, {
        name: "webgl-solo",
        url: `${BASE}/Apps/CesiumViewer/index.html?renderer=webgl${VIEWER_OFFLINE_QUERY}`,
        globals: ["viewer"],
      }),
    );
    lanes.push(
      await runLane(browser, {
        name: "split",
        url: `${BASE}/Apps/WebGPUTest/split-screen-comparison.html`,
        globals: ["webglViewer", "webgpuViewer"],
        launchSelector: "#btnLaunch",
      }),
    );
  } finally {
    await browser.close().catch(() => {});
  }

  // ── Verdicts ──
  const gpuSolo = lanes.find((l) => l.name === "webgpu-solo");
  const glSolo = lanes.find((l) => l.name === "webgl-solo");
  const split = lanes.find((l) => l.name === "split");

  const webglInWebgpuMode = (() => {
    const k = gpuSolo?.contexts?.byKind;
    if (!k) return "UNKNOWN";
    const gl = k.webgl;
    if (!gl || gl.count === 0)
      return "NO — zero WebGL getContext calls in webgpu mode";
    if (gl.nonNull === 0)
      return `ATTEMPTED-BUT-NULL — ${gl.count} webgl getContext call(s), all returned null`;
    return `YES — ${gl.nonNull} live WebGL context(s) created from ${gl.count} call(s)`;
  })();

  const splitVsSolo = (() => {
    if (!split?.frameMs || !gpuSolo?.frameMs || !glSolo?.frameMs)
      return "UNKNOWN";
    const soloSum = gpuSolo.frameMs.median + glSolo.frameMs.median;
    const ratio = split.frameMs.median / soloSum;
    return {
      splitMedianMs: r3(split.frameMs.median),
      webgpuSoloMedianMs: r3(gpuSolo.frameMs.median),
      webglSoloMedianMs: r3(glSolo.frameMs.median),
      sumOfSolosMs: r3(soloSum),
      splitOverSumRatio: r3(ratio),
      interpretation:
        ratio < 0.7
          ? "Split is CHEAPER than the sum of solos — shared/serial work dominates, not renderer work"
          : ratio > 1.3
            ? "Split costs MORE than the sum — contention"
            : "Split ~= sum of solos — renderer work is additive (expected)",
    };
  })();

  const backendRatio =
    gpuSolo?.frameMs && glSolo?.frameMs
      ? r3(gpuSolo.frameMs.median / glSolo.frameMs.median)
      : null;

  const report = {
    probe: "backend-isolation",
    date: new Date().toISOString(),
    base: BASE,
    verdicts: {
      Q1_webgl_running_in_webgpu_mode: webglInWebgpuMode,
      Q2_split_vs_solo: splitVsSolo,
      webgpu_over_webgl_render_ms_ratio: backendRatio,
      note: "ratio > 1 means WebGPU spends MORE ms per scene.render() than WebGL. This measures CPU wall-clock around render(), not GPU time.",
    },
    lanes,
  };

  const outPath = path.join(OUT_DIR, "backend-isolation-report.json");
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report.verdicts, null, 2));
  console.log("\n--- per-lane context summary ---");
  for (const l of lanes) {
    if (!l.ok) {
      console.log(`${l.name}: FAILED — ${l.error}`);
      continue;
    }
    const k = l.contexts.byKind;
    const kinds = Object.entries(k)
      .map(([kind, v]) => `${kind}=${v.count}(live ${v.nonNull})`)
      .join(" ");
    console.log(
      `${l.name}: getContext[${kinds}] canvases=${l.contexts.canvasCount} frameMs.median=${r3(l.frameMs?.median)} viewers=${JSON.stringify(l.contexts.viewerInfo)}`,
    );
  }
  console.log(`\n[full report: ${outPath}]`);
  clearTimeout(watchdog);
  process.exit(0);
})().catch((e) => {
  console.error("[probe-backend-isolation] FATAL", e);
  process.exit(1);
});
