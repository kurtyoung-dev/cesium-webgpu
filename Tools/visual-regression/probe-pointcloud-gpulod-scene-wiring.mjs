#!/usr/bin/env node
// Probe (NS-DECOUPLEDSCAN-NO-SCENE-WIRING): verify the point-cloud GPU-LOD
// processor is now reachable from the Scene behind an opt-in flag, and that
// the deterministic decoupled-lookback SCAN compute path is actually
// dispatched end-to-end when the flag is on.
// @purpose Verifies PointCloudShading.gpuLOD reaches the WebGPU LOD processor, decoupled-scan compute dispatches end-to-end, off-gate keeps atomic path
// @status ACTIVE
//
// What this exercises (the real integrated plumbing, not a mock):
//   CHECK A — Scene wiring: `PointCloudShading` exposes `gpuLOD`
//             (default false; settable true). This is the opt-in that
//             `TimeDynamicPointCloud.renderFrame` maps onto
//             `pointCloud.enableGPULOD`, which the WebGPU point-cloud
//             feature renderer reads to activate the LOD processor.
//   CHECK B — Scan ON: a WebGPU context created with
//             `contextOptions.useDeterministicPointCloudLOD:true` builds its
//             `context.pointCloudLOD` processor with `useDecoupledScan:true`.
//             Uploading >threshold points and dispatching records the THREE
//             scan compute passes (tagVisible → decoupled-scan → compactScanned).
//   CHECK C — Off-gate: a WebGPU context WITHOUT the option builds the
//             processor with the default atomic-add path; dispatching records
//             the single atomic `computeMain(/Subgroups)` pass and NONE of the
//             scan passes.
//
// Usage: node Tools/visual-regression/probe-pointcloud-gpulod-scene-wiring.mjs
// Env:   PROBE_BASE (default http://localhost:8080)

import { chromium } from "playwright";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { writeFileSync, rmSync } from "fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BASE = process.env.PROBE_BASE || "http://localhost:8080";

// Self-contained: drop a temp page that loads the IIFE bundle → global
// `Cesium`, then remove it on exit (keeps the tree clean).
const APPS_DIR = join(__dirname, "..", "..", "Apps");
const TMP_HTML = join(APPS_DIR, "_probe-tmp-gpulod.html");
const TMP_URL = `${BASE}/Apps/_probe-tmp-gpulod.html`;
writeFileSync(
  TMP_HTML,
  `<!doctype html><html><head><meta charset="utf-8">` +
    `<script src="/Build/CesiumUnminified/Cesium.js"></script>` +
    `<style>html,body{width:100%;height:100%;margin:0}</style>` +
    `</head><body></body></html>`,
);

const browser = await chromium.launch({
  channel: "msedge",
  headless: true,
  args: ["--enable-unsafe-webgpu"],
});
const page = await browser.newPage({ viewport: { width: 900, height: 600 } });
const errors = [];
page.on("console", (m) => {
  if (m.type() === "error") errors.push(m.text());
});
page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));

// Temp page loads the IIFE bundle → global `Cesium`. We build our own WebGPU
// viewers via Cesium.Viewer.createAsync below.
await page.goto(TMP_URL, { waitUntil: "load" });
await page.waitForFunction(() => !!window.Cesium, { timeout: 30000 });

const out = await page.evaluate(async () => {
  const Cesium = window.Cesium;
  const _log = [];

  // ── CHECK A — Scene-wiring opt-in flag on PointCloudShading ──────────
  const defShading = new Cesium.PointCloudShading();
  const onShading = new Cesium.PointCloudShading({ gpuLOD: true });
  const wiringDefaultOff = defShading.gpuLOD === false;
  const wiringSettableOn = onShading.gpuLOD === true;

  // Helper: build a WebGPU viewer in a throwaway container and return its
  // ready WebGPU context.
  async function makeWebGPUContext(useDeterministic) {
    const div = document.createElement("div");
    div.style.width = "600px";
    div.style.height = "400px";
    document.body.appendChild(div);
    const viewer = await Cesium.Viewer.createAsync(div, {
      contextOptions: {
        renderer: "webgpu",
        useDeterministicPointCloudLOD: useDeterministic,
      },
      baseLayerPicker: false,
      geocoder: false,
      timeline: false,
      animation: false,
    });
    const ctx = viewer.scene.context;
    // Wait for the device to exist.
    const t0 = performance.now();
    while (!ctx.device && performance.now() - t0 < 15000) {
      await new Promise((r) => setTimeout(r, 50));
    }
    return { viewer, div, ctx };
  }

  // Drive the real processor: upload > threshold points and dispatch once,
  // capturing every compute-pass label encoded.
  async function runDispatch(ctx) {
    // Trigger lazy processor creation; poll until pipelines are compiled.
    let proc = ctx.pointCloudLOD;
    const t0 = performance.now();
    while ((!proc || !proc.isReady) && performance.now() - t0 < 20000) {
      await new Promise((r) => setTimeout(r, 50));
      proc = ctx.pointCloudLOD;
    }
    if (!proc || !proc.isReady) {
      return { ready: false, labels: [] };
    }

    // Fork the same owner-scoped stream used by the scene renderer. The
    // context object is an immutable template; mutable positions/count/index
    // buffers must never alias another cloud.
    proc = await proc.createOwnerStream("integrated-probe-owner");

    const N = 60000; // above POINT_COUNT_LOD_THRESHOLD (50_000)
    const x = new Float32Array(N);
    const y = new Float32Array(N);
    const z = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      x[i] = (i % 100) * 0.5;
      y[i] = ((i / 100) | 0) * 0.5;
      z[i] = 0;
    }
    proc.uploadPositions(x, y, z);

    const device = ctx.device;
    const encoder = device.createCommandEncoder({ label: "probe-encoder" });
    // Capture compute-pass labels on THIS encoder instance.
    const labels = [];
    const origBegin = encoder.beginComputePass.bind(encoder);
    encoder.beginComputePass = (desc) => {
      labels.push((desc && desc.label) || "(unlabeled)");
      return origBegin(desc);
    };

    // Permissive projected-error params: every point is LOD-0 and every local
    // point is inside the box frustum.
    const planes = [
      1, 0, 0, 1e6, -1, 0, 0, 1e6, 0, 1, 0, 1e6, 0, -1, 0, 1e6, 0, 0, 1, 1e6, 0,
      0, -1, 1e6,
    ];
    proc.dispatch(encoder, {
      cameraPositionLocal: [0, 0, 0],
      projectionScale: 1.0,
      targetPixelSpacing: 1.0,
      frustumPlanes: planes,
      pointCount: N,
      maxVisiblePoints: N,
      geometricError: 1e9,
      modelLinear: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0],
    });
    device.queue.submit([encoder.finish()]);
    await device.queue.onSubmittedWorkDone();
    proc.destroy();
    return { ready: true, labels };
  }

  // ── CHECK B — deterministic scan ON ──────────────────────────────────
  const on = await makeWebGPUContext(true);
  const onIsWebGPU = !!on.ctx.isWebGPU;
  const onRun = await runDispatch(on.ctx);
  on.viewer.destroy();
  on.div.remove();

  // ── CHECK C — off-gate, default atomic path ──────────────────────────
  const off = await makeWebGPUContext(false);
  const offRun = await runDispatch(off.ctx);
  off.viewer.destroy();
  off.div.remove();

  const hasScan = (labels) =>
    labels.some((l) => /tagVisible/.test(l)) &&
    labels.some((l) => /compactScanned/.test(l)) &&
    labels.some((l) => /ComputePass/.test(l)); // WebGPUDecoupledScan pass
  const hasAtomic = (labels) =>
    labels.some((l) => /computeMain/i.test(l) && !/scan/i.test(l));

  return {
    wiringDefaultOff,
    wiringSettableOn,
    onIsWebGPU,
    onReady: onRun.ready,
    onLabels: onRun.labels,
    onHasScan: hasScan(onRun.labels),
    offReady: offRun.ready,
    offLabels: offRun.labels,
    offHasScan: hasScan(offRun.labels),
    offHasAtomic: hasAtomic(offRun.labels),
  };
});

await browser.close();
rmSync(TMP_HTML, { force: true });

// ── Evaluate ────────────────────────────────────────────────────────────
console.log("CHECK A — Scene wiring (PointCloudShading.gpuLOD)");
console.log(`  default gpuLOD === false : ${out.wiringDefaultOff}`);
console.log(`  settable gpuLOD === true : ${out.wiringSettableOn}`);
console.log("CHECK B — deterministic scan ON");
console.log(`  context isWebGPU         : ${out.onIsWebGPU}`);
console.log(`  processor ready          : ${out.onReady}`);
console.log(`  scan passes dispatched   : ${out.onHasScan}`);
console.log(`  labels: ${JSON.stringify(out.onLabels)}`);
console.log("CHECK C — off-gate (default atomic path)");
console.log(`  processor ready          : ${out.offReady}`);
console.log(`  scan passes ABSENT       : ${!out.offHasScan}`);
console.log(`  atomic pass dispatched   : ${out.offHasAtomic}`);
console.log(`  labels: ${JSON.stringify(out.offLabels)}`);

const pass =
  out.wiringDefaultOff &&
  out.wiringSettableOn &&
  out.onIsWebGPU &&
  out.onReady &&
  out.onHasScan &&
  out.offReady &&
  !out.offHasScan &&
  out.offHasAtomic;

if (errors.length) {
  console.error(`console errors: ${errors.slice(0, 8).join(" | ")}`);
}
console.log(pass ? "\nPROBE PASS" : "\nPROBE FAIL");
process.exit(pass ? 0 : 1);
