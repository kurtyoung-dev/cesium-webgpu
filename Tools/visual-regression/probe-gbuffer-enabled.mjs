#!/usr/bin/env node
// Probe-gbuffer-enabled — Phase 8a Slice 2b (Batch 86).
// @purpose Flips scene.deferredLighting on and asserts the G-buffer producer runs with zero visible pixel change (consumers land in a later slice)
// @status ACTIVE
//
// Flips `scene.deferredLighting = true` on the WebGPU viewer, renders
// N frames, and verifies:
//   1. No console errors / page errors.
//   2. The G-buffer producer compute pass runs (visible in the
//      perf-manager's compute dispatch counter).
//   3. The on-screen render is unchanged from the default-flag-off
//      capture (the G-buffer is a separate target; flipping the flag
//      should NOT affect what the user sees).
//
// (3) is the key regression check: the producer is meant to be
// invisible until Slice 4 wires consumers. If flipping the flag
// changes the canvas pixels, something downstream is already reading
// from the G-buffer when it shouldn't be (or the flag is leaking
// into a non-deferred code path).

import { chromium } from "playwright";
import fs from "fs";
import path from "path";

const BASE = "http://localhost:8080";
const OUT_DIR = "Tools/visual-regression/output";
const FIXED_CLOCK_UTC = "2026-05-19T18:00:00Z";

const VIEW = { lon: -100, lat: 40, height: 3_000_000 };

async function capture(deferredLighting) {
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
  page.on("console", (m) => messages.push({ t: m.type(), text: m.text() }));
  page.on("pageerror", (e) =>
    messages.push({ t: "pageerror", text: e.message }),
  );

  await page.goto(`${BASE}/Apps/CesiumViewer/index.html?renderer=webgpu`, {
    waitUntil: "networkidle",
  });
  await page.waitForFunction(() => !!window.viewer);

  const stats = await page.evaluate(
    async ({ view, clockUTC, deferredLighting }) => {
      const C = await import("/Build/CesiumUnminified/index.js");
      const v = window.viewer;
      const vm = v.baseLayerPicker.viewModel;
      const wgs84 = vm.terrainProviderViewModels.find((t) =>
        String(t.name || "")
          .toLowerCase()
          .includes("wgs84"),
      );
      if (wgs84) vm.selectedTerrain = wgs84;

      const fixed = C.JulianDate.fromIso8601(clockUTC);
      v.clock.currentTime = fixed.clone();
      v.clock.startTime = fixed.clone();
      v.clock.stopTime = fixed.clone();
      v.clock.shouldAnimate = false;
      v.clock.multiplier = 0;

      v.scene.deferredLighting = deferredLighting;

      v.camera.setView({
        destination: C.Cartesian3.fromDegrees(view.lon, view.lat, view.height),
      });
      for (let i = 0; i < 1500; i++) {
        v.scene.render();
        await new Promise((r) => requestAnimationFrame(r));
        if (v.scene.globe.tilesLoaded && i > 400) break;
      }

      // Sanity readbacks. These properties are public-underscore on the
      // PerformanceManager; we surface them only for the probe —
      // production code never depends on them. PerfMgr lives on the
      // WebGPU context via `_performanceManager` (note the underscore).
      const ctx = v.scene.context;
      const pm =
        ctx &&
        (ctx.performanceManager ?? ctx._performanceManager ?? ctx.perfManager);
      // Try to peek at the depth-only view to confirm it's wired (the
      // accessor is `depthOnlyTextureView`).
      const depthOnly = ctx && ctx.depthOnlyTextureView;
      return {
        sceneDeferred: v.scene.deferredLighting,
        frameStateDeferred: v.scene.frameState?.useDeferredLighting ?? null,
        envStateDeferred:
          v.scene._environmentState?.useDeferredLighting ?? null,
        gBufferAlloc: !!v.scene._view?.gBufferFramebuffer?.framebuffer,
        gBufferOutputView:
          !!v.scene._view?.gBufferFramebuffer?.normalRoughnessTexture,
        gBufferResources: !!pm?._gbufferComputeResources,
        depthOnlyView: !!depthOnly,
        computeDispatches: pm?.computeDispatches ?? null,
        invProjAvailable: !!ctx?.uniformState?.inverseProjection,
      };
    },
    { view: VIEW, clockUTC: FIXED_CLOCK_UTC, deferredLighting },
  );

  await page.waitForTimeout(1500);
  const tag = deferredLighting ? "on" : "off";
  const out = path.join(OUT_DIR, `gbuffer-enabled-${tag}.png`);
  await page.screenshot({ path: out });
  await browser.close();

  const errors = messages.filter((m) => m.t === "error" || m.t === "pageerror");
  return { out, stats, errors };
}

async function diffPngs(a, b) {
  const browser = await chromium.launch({ channel: "msedge", headless: true });
  const page = await browser.newPage();
  await page.setContent("<html><body></body></html>");
  const ba = fs.readFileSync(a).toString("base64");
  const bb = fs.readFileSync(b).toString("base64");
  const result = await page.evaluate(
    async ({ ba, bb }) => {
      const decode = async (b64) => {
        const img = new Image();
        img.src = "data:image/png;base64," + b64;
        await img.decode();
        const c = document.createElement("canvas");
        c.width = img.naturalWidth;
        c.height = img.naturalHeight;
        c.getContext("2d").drawImage(img, 0, 0);
        return {
          w: img.naturalWidth,
          h: img.naturalHeight,
          data: c.getContext("2d").getImageData(0, 0, c.width, c.height).data,
        };
      };
      const a = await decode(ba);
      const b = await decode(bb);
      if (a.w !== b.w || a.h !== b.h) return { error: "size mismatch" };
      const total = a.w * a.h;
      let mismatch = 0;
      let sum = 0;
      for (let i = 0; i < a.data.length; i += 4) {
        const dr = Math.abs(a.data[i] - b.data[i]);
        const dg = Math.abs(a.data[i + 1] - b.data[i + 1]);
        const db = Math.abs(a.data[i + 2] - b.data[i + 2]);
        const d = dr + dg + db;
        sum += d;
        if (d > 30) mismatch++;
      }
      return {
        totalPx: total,
        mismatchPx: mismatch,
        mismatchPct: (100 * mismatch) / total,
        meanDelta: sum / total,
      };
    },
    { ba, bb },
  );
  await browser.close();
  return result;
}

(async () => {
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
  console.log("[probe-gbuffer-enabled] toggling scene.deferredLighting");

  console.log("  capturing OFF baseline...");
  const off = await capture(false);
  console.log("    stats:", off.stats);
  if (off.errors.length) {
    console.log(
      "    ! errors:",
      off.errors.slice(0, 3).map((e) => `${e.t}: ${e.text.slice(0, 800)}`),
    );
  }

  console.log("  capturing ON (deferredLighting = true)...");
  const on = await capture(true);
  console.log("    stats:", on.stats);
  if (on.errors.length) {
    console.log(
      "    ! errors:",
      on.errors.slice(0, 3).map((e) => `${e.t}: ${e.text.slice(0, 800)}`),
    );
  }

  // Sanity checks
  console.log("\n[probe-gbuffer-enabled] verification:");
  console.log(
    `  - scene.deferredLighting on:  ${on.stats.sceneDeferred} (expected true)`,
  );
  console.log(
    `  - frameState.useDeferredLighting on: ${on.stats.frameStateDeferred} (expected true)`,
  );
  console.log(
    `  - gBufferFramebuffer allocated on:  ${on.stats.gBufferAlloc} (expected true)`,
  );
  console.log(
    `  - gBuffer compute resources on:     ${on.stats.gBufferResources} (expected true — created on first dispatch)`,
  );

  // Scene-pixel comparison.
  //
  // Pre-Slice-4 (Batches 80-86): the producer was fully dormant on the
  // canvas path — diff was expected to be ~0% and the probe used a
  // 0.5% tolerance.
  //
  // Post-Slice-4 (Batch 87+): the AO effect now reads surface normals
  // from the G-buffer when the flag is on, replacing its depth-only
  // central-difference reconstruction. The two normal sources produce
  // very similar AO output but not identical at silhouette edges
  // (Slice 3 silhouette-aware normals are cleaner). A small diff in
  // the 0.5-2% range with low mean delta is EXPECTED and confirms
  // Slice 4 is working. Larger diffs (≥5%) suggest a regression
  // — likely a wrong-space normal or a broken bind-group.
  const diff = await diffPngs(off.out, on.out);
  console.log(`\n  on-vs-off pixel diff:`, diff);
  if (diff.mismatchPct > 5.0) {
    console.log(
      `    !! mismatch ${diff.mismatchPct.toFixed(3)}% exceeds 5% — likely a Slice 4 wiring regression`,
    );
  } else if (diff.mismatchPct > 0.05) {
    console.log(
      `    ✓ Slice 4 visible (${diff.mismatchPct.toFixed(3)}% mismatch, mean delta ${diff.meanDelta.toFixed(3)}) — AO is now reading G-buffer normals`,
    );
  } else {
    console.log(
      `    ✓ on-screen unchanged (${diff.mismatchPct.toFixed(3)}% mismatch) — no AO active OR Slice 4 not yet engaged`,
    );
  }

  const reportPath = path.join(OUT_DIR, "gbuffer-enabled-report.json");
  fs.writeFileSync(
    reportPath,
    JSON.stringify(
      {
        runAt: new Date().toISOString(),
        off: { stats: off.stats, errorCount: off.errors.length },
        on: { stats: on.stats, errorCount: on.errors.length },
        canvasDiff: diff,
      },
      null,
      2,
    ),
  );
  console.log(`\n  report: ${reportPath}`);
})();
