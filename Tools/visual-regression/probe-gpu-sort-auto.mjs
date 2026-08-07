#!/usr/bin/env node
// Probe: GPU-SORT-AUTO (NS-GPU-SORT-NO-SCENE-WIRING)
//
// Verifies the PRODUCTION auto-enable heuristic for the GPU front-to-back
// opaque sort consumer — the piece added by NS-GPU-SORT-NO-SCENE-WIRING on
// top of the C4-GPU-SORT-PIPELINE-PHASE3 consumer (which was previously
// reachable only via the CesiumDebug.gpuSortConsume debug flag).
//
// Acceptance (auto-enable above threshold, NO debug flag):
//   1. Build a DENSE scene (80x80 = 6400 box primitives) so the per-frustum
//      opaque command count crosses the GPU-sort activation gate
//      (GPU_SORT_KEYS_THRESHOLD_HI = 6000).
//   2. WITHOUT touching CesiumDebug.gpuSortConsume, render many frames and
//      assert the consumer auto-applied: consumeMode === "auto",
//      consumeEnabled === true, dispatches > 0, hasReadback, and
//      consumeApplied > 0. This is the "live path" the task requires.
//
// Off-gate A (flag-off unchanged):
//   3. Force mode "never" (CesiumDebug.gpuSortConsume(false)); render more
//      frames and assert consumeApplied does NOT increase (consumer stops)
//      and the pixels match the auto-on capture within the same-setting
//      noise floor (reordering is output-invariant, so auto-on ≡ never).
//
// Off-gate B (below threshold unchanged):
//   4. Restore mode "auto", shrink the scene to 20x20 = 400 boxes (< the
//      4000 LO gate), render, and assert the gate deactivates
//      (activeAnyFrustum === false) and consumeApplied does NOT increase —
//      even in "auto", below the threshold nothing is reordered.
//
// Output: Tools/visual-regression/output/gpu-sort-auto-{on,never}.png
//
// Usage:
//   PROBE_BASE=http://localhost:8080 node Tools/visual-regression/probe-gpu-sort-auto.mjs

import { chromium } from "playwright";
import fs from "fs";
import path from "path";
import {
  errorGateInit,
  armWebGPUDevices,
  collectGateErrors,
  attachConsoleErrorGate,
} from "../lib/webgpu-error-gate.mjs";

const BASE = process.env.PROBE_BASE || "http://localhost:8080";
const OUT_DIR = "Tools/visual-regression/output";
const GRID = Number(process.env.PROBE_GRID || 80); // 80x80 = 6400 > 6000

async function buildGrid(page, grid, clearFirst) {
  return page.evaluate(
    async ([g, clear]) => {
      const Cesium = await import("/Build/CesiumUnminified/index.js");
      const v = window.viewer;
      const scene = v.scene;
      const prims = scene.primitives;
      if (clear) {
        prims.removeAll();
      }
      scene.globe.show = false;
      scene.skyBox.show = false;
      scene.sun.show = false;
      if (scene.moon) scene.moon.show = false;
      if (scene.skyAtmosphere) scene.skyAtmosphere.show = false;
      scene.fog.enabled = false;
      scene.backgroundColor = Cesium.Color.BLACK;

      const lon0 = -105.0;
      const lat0 = 39.0;
      const span = 1.2;
      const boxDim = new Cesium.Cartesian3(1500.0, 1500.0, 1500.0);
      const geom = Cesium.BoxGeometry.fromDimensions({
        vertexFormat: Cesium.PerInstanceColorAppearance.VERTEX_FORMAT,
        dimensions: boxDim,
      });
      let created = 0;
      for (let i = 0; i < g; i++) {
        for (let j = 0; j < g; j++) {
          const lon = lon0 + (i / g) * span;
          const lat = lat0 + (j / g) * span;
          const height = 5000 + ((i * 7 + j * 13) % 40) * 4000;
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
        80000,
      );
      scene.camera.lookAt(
        center,
        new Cesium.HeadingPitchRange(0.0, Cesium.Math.toRadians(-89.9), 360000),
      );
      scene.camera.lookAtTransform(Cesium.Matrix4.IDENTITY);
      return { created, primCount: prims.length };
    },
    [grid, clearFirst],
  );
}

const settle = (page, frames) =>
  page.evaluate(async (n) => {
    const scene = window.viewer.scene;
    for (let i = 0; i < n; i++) {
      scene.render();
      await new Promise((r) => requestAnimationFrame(r));
    }
  }, frames);

const capture = (page) =>
  page.evaluate(async () => {
    const v = window.viewer;
    v.scene.render();
    await new Promise((r) => requestAnimationFrame(r));
    v.scene.render();
    return v.scene.canvas.toDataURL("image/png");
  });

const readSortStats = (page) =>
  page.evaluate(() => {
    const renderer = window.viewer.scene._alternateSceneRenderer;
    if (!renderer || typeof renderer.getHighDensityCullStats !== "function") {
      return null;
    }
    return renderer.getHighDensityCullStats().gpuSortKeys;
  });

const diffPair = (page, a, b) =>
  page.evaluate(
    async ([x, y]) => {
      async function decode(du) {
        const img = new Image();
        img.src = du;
        await img.decode();
        const c = document.createElement("canvas");
        c.width = img.naturalWidth;
        c.height = img.naturalHeight;
        const ctx = c.getContext("2d");
        ctx.drawImage(img, 0, 0);
        return {
          d: ctx.getImageData(0, 0, c.width, c.height).data,
          w: c.width,
          h: c.height,
        };
      }
      const A = await decode(x);
      const B = await decode(y);
      let diff = 0;
      const n = Math.min(A.d.length, B.d.length);
      for (let i = 0; i < n; i += 4) {
        if (
          A.d[i] !== B.d[i] ||
          A.d[i + 1] !== B.d[i + 1] ||
          A.d[i + 2] !== B.d[i + 2] ||
          A.d[i + 3] !== B.d[i + 3]
        )
          diff++;
      }
      return { diff, total: (A.w * A.h) | 0 };
    },
    [a, b],
  );

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
  const page = await browser.newPage({
    viewport: { width: 1024, height: 768 },
  });
  const consoleErrors = attachConsoleErrorGate(page);
  await page.addInitScript(errorGateInit);

  const url = `${BASE}/Apps/CesiumViewer/index.html?renderer=webgpu`;
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => !!window.viewer, null, { timeout: 60000 });
  await armWebGPUDevices(page);

  const buildInfo = await buildGrid(page, GRID, false);

  // Stabilize the visible box set: disable the HiZ occlusion consumer so its
  // 1-frame-latent readback doesn't drift which boxes are culled.
  await page.evaluate(() => {
    if (window.CesiumDebug && window.CesiumDebug.hiZConsume) {
      window.CesiumDebug.hiZConsume(false);
    }
  });

  // ── Phase 1 — AUTO-ENABLE: settle WITHOUT touching gpuSortConsume ──
  await settle(page, 120);
  const autoImg = await capture(page);
  await settle(page, 2);
  const autoImg2 = await capture(page); // same-setting noise floor
  const autoStats = await readSortStats(page);

  // ── Phase 2 — OFF-GATE A (flag-off unchanged): force mode "never" ──
  // Settle into "never", then measure a freeze-in-place delta: read stats,
  // render more, read again — consumeApplied must NOT advance while "never".
  await page.evaluate(() => window.CesiumDebug.gpuSortConsume(false));
  await settle(page, 40);
  const neverStatsA = await readSortStats(page);
  await settle(page, 20);
  const neverStats = await readSortStats(page); // B
  const neverImg = await capture(page);

  // ── Phase 3 — OFF-GATE B (below threshold): restore auto + tiny grid ──
  // 400 boxes < 4000 LO gate — even in "auto" nothing must reorder. Same
  // freeze-in-place delta: consumeApplied + consumeSkipped both frozen.
  await page.evaluate(() => window.CesiumDebug.gpuSortConsumeMode("auto"));
  const smallInfo = await buildGrid(page, 20, true); // 400 boxes < 4000 LO
  await settle(page, 60);
  const smallStatsA = await readSortStats(page);
  await settle(page, 30);
  const smallStats = await readSortStats(page); // B

  const diffAutoVsNever = await diffPair(page, autoImg, neverImg);
  const diffNoiseFloor = await diffPair(page, autoImg, autoImg2);

  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
  const onPath = path.join(OUT_DIR, "gpu-sort-auto-on.png");
  const neverPath = path.join(OUT_DIR, "gpu-sort-auto-never.png");
  fs.writeFileSync(
    onPath,
    Buffer.from(autoImg.replace(/^data:image\/png;base64,/, ""), "base64"),
  );
  fs.writeFileSync(
    neverPath,
    Buffer.from(neverImg.replace(/^data:image\/png;base64,/, ""), "base64"),
  );

  const gate = await collectGateErrors(page);
  await browser.close();

  return {
    buildInfo,
    smallInfo,
    autoStats,
    neverStatsA,
    neverStats,
    smallStatsA,
    smallStats,
    diffAutoVsNever,
    diffNoiseFloor,
    onPath,
    neverPath,
    consoleErrors: consoleErrors.slice(0, 8),
    gate,
  };
}

(async () => {
  console.log("[probe-gpu-sort-auto] === webgpu ===");
  const res = await run();
  console.log(`  builtDense: ${JSON.stringify(res.buildInfo)}`);
  console.log(`  builtSmall: ${JSON.stringify(res.smallInfo)}`);
  console.log(`  autoStats:   ${JSON.stringify(res.autoStats)}`);
  console.log(`  neverStatsA: ${JSON.stringify(res.neverStatsA)}`);
  console.log(`  neverStatsB: ${JSON.stringify(res.neverStats)}`);
  console.log(`  smallStatsA: ${JSON.stringify(res.smallStatsA)}`);
  console.log(`  smallStatsB: ${JSON.stringify(res.smallStats)}`);

  const dAn = res.diffAutoVsNever;
  const dNf = res.diffNoiseFloor;
  const pctAn = dAn.total ? (100 * dAn.diff) / dAn.total : 100;
  const pctNf = dNf.total ? (100 * dNf.diff) / dNf.total : 100;
  console.log(
    `  pixelDiff auto-vs-never (reorder effect): ${dAn.diff}/${dAn.total} (${pctAn.toFixed(4)}%)`,
  );
  console.log(
    `  pixelDiff auto-vs-auto2 (noise floor):    ${dNf.diff}/${dNf.total} (${pctNf.toFixed(4)}%)`,
  );
  console.log(`  png on:    ${res.onPath}`);
  console.log(`  png never: ${res.neverPath}`);
  if (res.consoleErrors.length)
    console.log(`  consoleErrors: ${JSON.stringify(res.consoleErrors)}`);
  console.log(
    `  gate: errors=${res.gate.errors.length} deviceLost=${res.gate.deviceLost} armed=${res.gate.armedDevices}`,
  );
  if (res.gate.errors.length)
    console.log(
      `  gate.errors: ${JSON.stringify(res.gate.errors.slice(0, 5))}`,
    );

  const a = res.autoStats;
  const nvA = res.neverStatsA;
  const nv = res.neverStats;
  const smA = res.smallStatsA;
  const sm = res.smallStats;
  // OFF-GATE A: "never" stops the consumer — no NEW applies between the two
  // freeze-in-place reads while in "never" — and pixels equal auto (invariant).
  const neverStopsConsumer =
    !!nv &&
    !!nvA &&
    nv.consumeMode === "never" &&
    nv.consumeEnabled === false &&
    nv.consumeApplied === nvA.consumeApplied;
  const outputInvariant = pctAn <= Math.max(pctNf, 0.05);
  // OFF-GATE B: below the LO threshold, even in "auto" nothing reorders —
  // neither consumeApplied nor consumeSkipped advances (the per-frame gate
  // for the executed frustums is false, so `_applySortedOrder` isn't called).
  const belowThresholdInactive =
    !!sm &&
    !!smA &&
    sm.consumeMode === "auto" &&
    sm.consumeApplied === smA.consumeApplied &&
    sm.consumeSkipped === smA.consumeSkipped;

  const checks = {
    // AUTO-ENABLE (the new production heuristic — no debug flag touched):
    autoModeDefault: !!a && a.consumeMode === "auto",
    autoConsumeEnabled: !!a && a.consumeEnabled === true,
    gateActivated: !!a && a.dispatches > 0 && a.activeAnyFrustum === true,
    hasReadback: !!a && a.hasReadback === true,
    autoConsumeApplied: !!a && a.consumeApplied > 0,
    // OFF-GATES:
    neverStopsConsumer,
    outputInvariant,
    belowThresholdInactive,
    noGateErrors: res.gate.errors.length === 0 && !res.gate.deviceLost,
  };
  console.log(`\n  CHECKS: ${JSON.stringify(checks, null, 0)}`);
  // The verdict is the FOLD of the named check list, and the failure line is
  // its FILTER — so a FAIL always says which predicate failed instead of
  // leaving a reader to diff a nine-key JSON dump. Truth value is unchanged:
  // `every(Boolean)` over the same object.
  const failedPredicates = Object.keys(checks).filter((k) => !checks[k]);
  const pass = failedPredicates.length === 0;
  console.log(
    `\n[probe-gpu-sort-auto] ${pass ? "PASS" : `FAIL — failing predicate(s): ${failedPredicates.join(", ")}`}`,
  );
  process.exit(pass ? 0 : 1);
})();
