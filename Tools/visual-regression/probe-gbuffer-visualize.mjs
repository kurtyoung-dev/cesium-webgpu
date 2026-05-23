#!/usr/bin/env node
// Probe-gbuffer-visualize — Phase 8a Slice 2c (Batch 89).
//
// Calls `CesiumDebug.showGBufferNormals()` on the WebGPU viewer to
// replace the production post-process chain with a fullscreen blit of
// the G-buffer normal texture. The captured PNG IS the G-buffer —
// surface normals mapped `(n + 1) * 0.5` to RGB so the standard
// normal-map color convention applies:
//   +X right → red
//   +Y up    → green
//   +Z toward camera → blue
//
// Sky / depth-clear / high-gradient sentinel pixels show as magenta.
//
// What "passing" looks like:
//   - The visible globe disc fills with smoothly-varying RGB values
//     (a sphere lit by a directional camera should show all three
//     channels gradiating from edge to edge — red on the +X side,
//     green on the +Y side, blue toward the camera center).
//   - The space around the globe is solid magenta (sentinel).
//   - No black blotches inside the globe (silhouette discontinuities
//     are handled by Slice 3's forward/backward fallback).

import { chromium } from "playwright";
import fs from "fs";
import path from "path";

const BASE = "http://localhost:8080";
const OUT_DIR = "Tools/visual-regression/output";
const FIXED_CLOCK_UTC = "2026-05-19T18:00:00Z";

// A close-ish view of the globe so the normal direction varies
// meaningfully across the disc — at orbit altitude the disc is so
// small the normals look uniform.
const VIEW = { lon: 0, lat: 0, height: 8_000_000 };

async function capture() {
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
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });

  const messages = [];
  page.on("console", (m) => {
    const text = m.text();
    messages.push({ t: m.type(), text });
    // Mirror Phase8a logs to node stdout for live diagnostics
    if (text.includes("[Phase8a")) {
      // eslint-disable-next-line no-console
      console.log(`  [browser] ${text}`);
    }
  });
  page.on("pageerror", (e) => messages.push({ t: "pageerror", text: e.message }));

  await page.goto(`${BASE}/Apps/CesiumViewer/index.html?renderer=webgpu`, {
    waitUntil: "networkidle",
  });
  await page.waitForFunction(() => !!window.viewer && !!window.CesiumDebug);

  const histo = await page.evaluate(
    async ({ view, clockUTC }) => {
      const C = await import("/Build/CesiumUnminified/index.js");
      const v = window.viewer;
      const vm = v.baseLayerPicker.viewModel;
      const wgs84 = vm.terrainProviderViewModels.find((t) =>
        String(t.name || "").toLowerCase().includes("wgs84"),
      );
      if (wgs84) vm.selectedTerrain = wgs84;

      // Phase 8a Slice 2d (Batch 90) — MSAA is now supported via a
      // separate multisampled-depth producer variant. The probe runs
      // at Cesium's default `msaaSamples = 4`; the dispatcher picks
      // the right pipeline automatically.

      // Pin clock
      const fixed = C.JulianDate.fromIso8601(clockUTC);
      v.clock.currentTime = fixed.clone();
      v.clock.startTime = fixed.clone();
      v.clock.stopTime = fixed.clone();
      v.clock.shouldAnimate = false;
      v.clock.multiplier = 0;

      v.camera.setView({
        destination: C.Cartesian3.fromDegrees(view.lon, view.lat, view.height),
      });

      // Let tiles + frame state settle
      for (let i = 0; i < 600; i++) {
        v.scene.render();
        await new Promise((r) => requestAnimationFrame(r));
        if (v.scene.globe.tilesLoaded && i > 200) break;
      }

      // Capture pre-toggle state for diagnostics
      const sr = v.scene.context?.sceneRenderer;
      const beforeMSAA = v.scene.msaaSamples;
      const beforeSFB = !!sr?._sceneFramebuffer;
      const beforeDepthView = !!sr?._sceneFramebuffer?.depthSampleableView;

      // Toggle the overlay AFTER the scene has settled
      window.CesiumDebug.showGBufferNormals();

      // Render more frames with the overlay on
      for (let i = 0; i < 60; i++) {
        v.scene.render();
        await new Promise((r) => requestAnimationFrame(r));
      }

      window.__gbufferDiag = {
        msaa: beforeMSAA,
        sceneFB: beforeSFB,
        depthView: beforeDepthView,
        deferredLighting: v.scene.deferredLighting,
        debugFlag: v.scene.debugShowGBufferNormals,
        gBufferAlloc: !!v.scene._view?.gBufferFramebuffer?.framebuffer,
        gBufferOutputView: !!v.scene._view?.gBufferFramebuffer?.normalRoughnessTexture,
      };

      // Sample the canvas pixels to verify the overlay actually ran
      // (rather than the page returning the last production frame).
      // Pull a small histogram of the center 100×100 region.
      const canvas = v.canvas;
      const tmp = document.createElement("canvas");
      tmp.width = 100;
      tmp.height = 100;
      const tctx = tmp.getContext("2d");
      tctx.drawImage(
        canvas,
        canvas.width / 2 - 50,
        canvas.height / 2 - 50,
        100,
        100,
        0,
        0,
        100,
        100,
      );
      const pix = tctx.getImageData(0, 0, 100, 100).data;
      // Tally per-channel mean + count of magenta-sentinel pixels.
      let sumR = 0, sumG = 0, sumB = 0, sentinel = 0, total = 0;
      for (let i = 0; i < pix.length; i += 4) {
        sumR += pix[i]; sumG += pix[i + 1]; sumB += pix[i + 2];
        // Magenta sentinel ≈ (255, 0, 255)
        if (pix[i] > 200 && pix[i + 1] < 50 && pix[i + 2] > 200) {
          sentinel++;
        }
        total++;
      }
      return {
        meanR: sumR / total,
        meanG: sumG / total,
        meanB: sumB / total,
        sentinelPct: (100 * sentinel) / total,
        totalSampled: total,
        diag: window.__gbufferDiag,
      };
    },
    { view: VIEW, clockUTC: FIXED_CLOCK_UTC },
  );

  await page.waitForTimeout(1500);
  const out = path.join(OUT_DIR, "gbuffer-visualize.png");
  await page.screenshot({ path: out });
  await browser.close();

  const errors = messages.filter(
    (m) => m.t === "error" || m.t === "pageerror",
  );
  return { out, histo, errors };
}

(async () => {
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
  console.log("[probe-gbuffer-visualize] capturing G-buffer normal overlay");
  const { out, histo, errors } = await capture();
  console.log(`  screenshot: ${out}`);
  console.log(`  center 100×100 histogram:`, histo);
  if (errors.length) {
    console.log(`  ${errors.length} errors:`);
    errors.slice(0, 3).forEach((e) =>
      console.log(`    ${e.t}: ${e.text.slice(0, 150)}`),
    );
  }

  // Heuristic check: if the center region is all-magenta sentinel the
  // overlay didn't actually find a normal at the globe center, which
  // suggests the producer didn't write valid data. If the center mean
  // RGB shows variation across all three channels with low sentinel%,
  // the overlay is showing real surface normals.
  console.log(`\n  interpretation:`);
  if (histo.sentinelPct > 90) {
    console.log(`    !! mostly magenta sentinel (${histo.sentinelPct.toFixed(1)}%) — producer didn't write normals at center.`);
    console.log(`       likely: scene.deferredLighting didn't take effect, or compute pass failed.`);
  } else if (histo.sentinelPct < 5) {
    console.log(`    ✓ globe visible with real normals (${histo.sentinelPct.toFixed(1)}% sentinel) — producer is writing meaningful data.`);
  } else {
    console.log(`    ~ partial visibility (${histo.sentinelPct.toFixed(1)}% sentinel) — globe at edge of view, or partial coverage.`);
  }

  // RGB variation across the 100×100 sample — if all three channels
  // hover near the same mean the camera is looking down a coordinate
  // axis (uniform normal). Useful as a sanity check that the producer
  // is varying with position, not stuck at a constant.
  const channelSpread = Math.max(
    Math.abs(histo.meanR - 127),
    Math.abs(histo.meanG - 127),
    Math.abs(histo.meanB - 127),
  );
  console.log(`    channel spread from neutral (127): ${channelSpread.toFixed(1)}`);
})();
