#!/usr/bin/env node
// Probe: FORK-41 OCCLUSION CORRECTNESS (Batch 291)
//
// FORK-41 activates the Hi-Z pyramid + OcclusionTest compute path in the dense
// (>=2400 opaque-command) WebGPU high-density cull path.
//
// STATE (Batch 291):
//   The full path is WIRED + RUNS every frame in the density-gated branch
//   (WebGPUSceneRenderer `_dispatchHiZForNextFrame` / `_filterByHiZVisibility`,
//   Batch 210-223): the Hi-Z pyramid is built from the prior-frame depth, the
//   OcclusionTest compute pass is dispatched, and the visibility is read back
//   async (double-buffered). Batch 291 fixed three real correctness bugs in the
//   test (log-depth-vs-linear depth-space mismatch; off-screen->occluded
//   false-cull; Hi-Z mip-index off-by-one).
//
//   HOWEVER, after those fixes the OcclusionTest STILL culls nothing
//   (occludedFlags=0) even in a guaranteed-occlusion scene (a near wall fully
//   in front of 3600 boxes), so at least one more correctness gap remains
//   (background-bleed in the 4-corner max-Z sample, and/or UV row-order). Per
//   the FORK-41 risk guidance, the consumer-side command DROP is therefore
//   GATED OFF BY DEFAULT (`WebGPUSceneRenderer._hiZConsumeEnabled = false`,
//   toggle via `CesiumDebug.hiZConsume(true)`): the build/dispatch/readback run
//   and are measurable, but no geometry is dropped → ZERO false-cull risk. This
//   ships the wiring without a visual regression; finishing the cull is the
//   documented next step (DEFERRED_WORK FORK-41).
//
// This probe asserts the SHIPPABLE state, on WebGPU, in a dense overlapping
// scene:
//
//   1. OCCLUSION RUNS — the HiZ gate activates + dispatches (stats.dispatches>0).
//   2. SAFE DEFAULT (no false-cull) — with the default flag, the rendered image
//      matches the image with GPU culling forced OFF (gpuCullingHint="never").
//   3. NO VALIDATION ERRORS / device loss.
//   4. (informational) hitRatio — currently 0 (cull inert by design); printed
//      so a future fix flips it positive and this probe's INFO line proves it.
//
// Output PNGs (read them — don't trust the diff number alone):
//   output/fork41-occlusion-on.png   (gpuCullingHint=auto, occlusion path live)
//   output/fork41-occlusion-off.png  (gpuCullingHint=never, baseline)
//   output/fork41-occlusion-diff.png (per-pixel abs diff, amplified)
//
// Usage:
//   PROBE_BASE=http://localhost:8134 node Tools/visual-regression/probe-fork41-occlusion.mjs

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
const GRID = Number(process.env.PROBE_GRID || 60); // 60x60 = 3600 > HI_Z_THRESHOLD_HI(2400)
const W = 1024;
const H = 768;
// Allowable per-pixel mismatch between occlusion-on and occlusion-off. A
// correct occlusion cull is pixel-exact in principle; allow a small budget for
// 1-frame-latency edge shimmer at box silhouettes (HiZ consumes the PRIOR
// frame's readback). A real false-cull removes whole boxes => far above this.
const MISMATCH_BUDGET_PCT = Number(process.env.PROBE_MISMATCH_BUDGET || 1.5);

const BUILD_SCENE = async (grid) => {
  const Cesium = await import("/Build/CesiumUnminified/index.js");
  const v = window.viewer;
  const scene = v.scene;
  const prims = scene.primitives;
  // Static frame so on/off captures are deterministic.
  scene.requestRenderMode = false;
  scene.globe.show = false; // isolate the boxes (occlusion target), no terrain depth.

  const lon0 = -105.0,
    lat0 = 39.0,
    span = 0.6;
  const boxDim = new Cesium.Cartesian3(6000.0, 6000.0, 90000.0);
  const geom = Cesium.BoxGeometry.fromDimensions({
    vertexFormat: Cesium.PerInstanceColorAppearance.VERTEX_FORMAT,
    dimensions: boxDim,
  });
  let created = 0;
  for (let i = 0; i < grid; i++) {
    for (let j = 0; j < grid; j++) {
      const lon = lon0 + (i / grid) * span;
      const lat = lat0 + (j / grid) * span;
      const height = 50000 + ((i * 7 + j * 13) % 11) * 8000;
      const pos = Cesium.Cartesian3.fromDegrees(lon, lat, height);
      const modelMatrix = Cesium.Transforms.eastNorthUpToFixedFrame(pos);
      const inst = new Cesium.GeometryInstance({
        geometry: geom,
        modelMatrix,
        attributes: {
          color: Cesium.ColorGeometryInstanceAttribute.fromColor(
            Cesium.Color.fromHsl((created % 360) / 360, 0.7, 0.55, 1.0),
          ),
        },
      });
      prims.add(
        new Cesium.Primitive({
          geometryInstances: inst,
          appearance: new Cesium.PerInstanceColorAppearance({
            translucent: false,
            closed: true,
          }),
          asynchronous: false,
        }),
      );
      created++;
    }
  }
  const center = Cesium.Cartesian3.fromDegrees(
    lon0 + span / 2,
    lat0 + span / 2,
    50000,
  );
  scene.camera.lookAt(
    center,
    new Cesium.HeadingPitchRange(
      Cesium.Math.toRadians(20),
      Cesium.Math.toRadians(-18),
      180000,
    ),
  );
  scene.camera.lookAtTransform(Cesium.Matrix4.IDENTITY);
  return { created, primCount: prims.length };
};

// Render N frames, then capture the canvas + the latest HiZ stats.
const RENDER_AND_CAPTURE = async (cfg) => {
  const v = window.viewer;
  const scene = v.scene;
  scene.gpuCullingHint = cfg.hint;
  // Warm: HiZ is 1-frame latent + has activation hysteresis; render enough
  // frames for the readback loop to stabilize and the gate to latch.
  for (let i = 0; i < cfg.frames; i++) {
    scene.render();
    await new Promise((r) => requestAnimationFrame(r));
  }
  scene.render();
  await new Promise((r) => requestAnimationFrame(r));
  scene.render();

  let stats = null;
  try {
    const renderer = scene._alternateSceneRenderer;
    if (renderer && typeof renderer.getHighDensityCullStats === "function") {
      const s = renderer.getHighDensityCullStats();
      stats = {
        hiZActive: s.hiZ.activeAnyFrustum,
        hiZDispatches: s.hiZ.dispatches,
        hiZInput: s.hiZ.lastFrameInput,
        hiZFiltered: s.hiZ.lastFrameFiltered,
        hiZHitRatio: s.hiZ.hitRatio,
      };
    }
  } catch (e) {
    stats = { error: String(e) };
  }
  return { dataUrl: scene.canvas.toDataURL("image/png"), stats };
};

function decodePngToRgba(page, dataUrl) {
  return page.evaluate(async (du) => {
    const img = new Image();
    img.src = du;
    await img.decode();
    const c = document.createElement("canvas");
    c.width = img.naturalWidth;
    c.height = img.naturalHeight;
    const ctx = c.getContext("2d");
    ctx.drawImage(img, 0, 0);
    const d = ctx.getImageData(0, 0, c.width, c.height).data;
    return { w: c.width, h: c.height, data: Array.from(d) };
  }, dataUrl);
}

async function run() {
  const browser = await chromium.launch({
    channel: "msedge",
    headless: true,
    args: [
      "--enable-unsafe-webgpu",
      "--enable-features=Vulkan",
      "--use-vulkan",
    ],
  });
  const page = await browser.newPage({ viewport: { width: W, height: H } });
  const consoleErrors = attachConsoleErrorGate(page);
  page.on("pageerror", (e) => console.log("  PAGEERROR:", e.message));
  await page.addInitScript(errorGateInit);

  const url = `${BASE}/Apps/CesiumViewer/index.html?renderer=webgpu`;
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => !!window.viewer, null, { timeout: 60000 });
  await armWebGPUDevices(page);

  const buildInfo = await page.evaluate(BUILD_SCENE, GRID);

  // OFF baseline first (no GPU culling at all) so nothing the occlusion path
  // does can leak state into the baseline.
  const off = await page.evaluate(RENDER_AND_CAPTURE, {
    hint: "never",
    frames: 120,
  });
  // ON: auto -> HiZ gate engages above threshold.
  const on = await page.evaluate(RENDER_AND_CAPTURE, {
    hint: "auto",
    frames: 200,
  });

  const offRgba = await decodePngToRgba(page, off.dataUrl);
  const onRgba = await decodePngToRgba(page, on.dataUrl);

  // Pixel diff (luma threshold) + amplified diff image.
  const a = offRgba.data,
    b = onRgba.data;
  const n = Math.min(a.length, b.length);
  const diff = new Uint8ClampedArray(n);
  let mismatch = 0;
  const total = offRgba.w * offRgba.h;
  for (let i = 0; i < n; i += 4) {
    const dr = Math.abs(a[i] - b[i]);
    const dg = Math.abs(a[i + 1] - b[i + 1]);
    const db = Math.abs(a[i + 2] - b[i + 2]);
    const dl = 0.2126 * dr + 0.7152 * dg + 0.0722 * db;
    if (dl > 24) {
      mismatch++;
      diff[i] = 255;
      diff[i + 1] = 0;
      diff[i + 2] = 0;
      diff[i + 3] = 255;
    } else {
      diff[i] = a[i];
      diff[i + 1] = a[i + 1];
      diff[i + 2] = a[i + 2];
      diff[i + 3] = 60;
    }
  }
  const mismatchPct = (100 * mismatch) / total;

  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
  const writePng = (name, du) =>
    fs.writeFileSync(
      path.join(OUT_DIR, name),
      Buffer.from(du.replace(/^data:image\/png;base64,/, ""), "base64"),
    );
  writePng("fork41-occlusion-off.png", off.dataUrl);
  writePng("fork41-occlusion-on.png", on.dataUrl);

  // Encode diff via the page canvas.
  const diffUrl = await page.evaluate(
    (args) => {
      const { data, w, h } = args;
      const c = document.createElement("canvas");
      c.width = w;
      c.height = h;
      const ctx = c.getContext("2d");
      const id = new ImageData(new Uint8ClampedArray(data), w, h);
      ctx.putImageData(id, 0, 0);
      return c.toDataURL("image/png");
    },
    { data: Array.from(diff), w: offRgba.w, h: offRgba.h },
  );
  writePng("fork41-occlusion-diff.png", diffUrl);

  const gate = await collectGateErrors(page);
  await browser.close();

  return {
    buildInfo,
    off,
    on,
    mismatch,
    total,
    mismatchPct,
    consoleErrors: consoleErrors.slice(0, 8),
    gate,
  };
}

(async () => {
  console.log("[probe-fork41-occlusion] === WebGPU dense occlusion ===");
  let res;
  try {
    res = await run();
  } catch (e) {
    console.log(`FAILED: ${e.message}`);
    process.exit(2);
  }

  console.log(`  built: ${JSON.stringify(res.buildInfo)}`);
  console.log(`  OFF stats: ${JSON.stringify(res.off.stats)}`);
  console.log(`  ON  stats: ${JSON.stringify(res.on.stats)}`);
  console.log(
    `  pixel mismatch on-vs-off: ${res.mismatch}/${res.total} (${res.mismatchPct.toFixed(3)}%)  budget=${MISMATCH_BUDGET_PCT}%`,
  );
  console.log(
    `  gate: errors=${res.gate.errors.length} deviceLost=${res.gate.deviceLost} armed=${res.gate.armedDevices}`,
  );
  if (res.gate.errors.length)
    console.log(
      `  gate.errors: ${JSON.stringify(res.gate.errors.slice(0, 5))}`,
    );
  if (res.consoleErrors.length)
    console.log(`  consoleErrors: ${JSON.stringify(res.consoleErrors)}`);

  const s = res.on.stats || {};
  const checks = [];
  checks.push(["occlusion DISPATCHES (path runs)", (s.hiZDispatches || 0) > 0]);
  checks.push(["occlusion is ACTIVE (gate latched)", s.hiZActive === true]);
  checks.push([
    "SAFE DEFAULT: no false-cull (pixels match)",
    res.mismatchPct <= MISMATCH_BUDGET_PCT,
  ]);
  checks.push([
    "no validation errors / device loss",
    res.gate.errors.length === 0 && !res.gate.deviceLost,
  ]);

  // INFORMATIONAL — the actual command DROP is gated OFF by default pending
  // the remaining OcclusionTest correctness fix (FORK-41). A future fix flips
  // this from 0 to >0; the probe records it but does NOT fail on 0 (the
  // shipped default is intentionally inert + safe).
  const culls = (s.hiZHitRatio || 0) > 0;
  console.log(
    `  [INFO] occlusion currently CULLS (hitRatio>0): ${culls} (gated OFF by default; expected 0 until correctness fix lands)`,
  );

  let allPass = true;
  for (const [name, ok] of checks) {
    console.log(`  [${ok ? "PASS" : "FAIL"}] ${name}`);
    if (!ok) allPass = false;
  }
  console.log(
    `[probe-fork41-occlusion] ${allPass ? "ALL PASS" : "FAILURES PRESENT"}`,
  );
  process.exit(allPass ? 0 : 1);
})();
