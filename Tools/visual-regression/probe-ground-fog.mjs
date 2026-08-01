#!/usr/bin/env node
// Probe: Atmospheric Effects Phase C — GROUND FOG (Batch 420).
//
// Verifies the WebGPU froxel volumetric-fog renderer's near-surface mist
// boost, driven by `atmosphericConditions.effects.groundFog`. Ground fog
// owns its OWN activation path — the froxel fog runs and shows the mist
// EVEN IF the general `volumetricFog.enabled` master is off.
//
// Scene: a LOW oblique camera over terrain looking toward the horizon, so
// the near-ground mist band is visible at the bottom of the frame and the
// sky fills the top. We capture two WebGPU frames:
//
//   OFF — effects.groundFog.enabled = false (default). The baseline.
//   ON  — effects.groundFog.enabled = true; intensity = 1.0. The mist
//         should whiten / haze the LOWER (ground) band materially MORE
//         than the UPPER (sky) band.
//
// Pass criteria (HUMAN reads the PNGs + the printed band stats):
//   - ON vs OFF: lowerBandBrighten  >>  upperBandBrighten  (the mist
//     hugs the ground; the sky high above is largely untouched).
//   - OFF vs OFF (sanity, same settings twice): both bands ~0 delta.
//
// WebGPU-only. Uses the CesiumViewer page with ?renderer=webgpu and the
// `window.viewer` handle, importing Cesium from the built bundle for the
// Cartesian3 helper (same pattern as probe-atmosphere-toggle.mjs).
//
// Usage:  node Tools/visual-regression/probe-ground-fog.mjs
// Outputs: output/ground-fog-{off,on,off2}-webgpu.png
//
// Do NOT run automatically — the human runs it and reads the band stats.

import { chromium } from "playwright";
import fs from "fs";
import path from "path";

const BASE = "http://localhost:8080";
const OUT_DIR = "Tools/visual-regression/output";

// Capture one WebGPU frame with the given ground-fog settings applied.
// `settings` = { enabled: boolean, intensity: number, fogMaster: boolean }.
async function capture(label, settings) {
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

  const echo = await page.evaluate(
    async ({ settings }) => {
      const C = await import("/Build/CesiumUnminified/index.js");
      const v = window.viewer;
      const scene = v.scene;
      const ac = scene.globe.atmosphericConditions;

      // DAYTIME: pin the clock to ~local solar noon over the camera
      // longitude (10.5°E → solar noon ≈ 11:18 UTC) on the summer solstice
      // so the sun is high and the terrain is well lit. Stop the clock so
      // it doesn't drift during the settle loop. Without this the default
      // clock can land at local night and the frame is black — you can't
      // see (or measure) ground fog against an unlit scene.
      v.clock.shouldAnimate = false;
      v.clock.currentTime = C.JulianDate.fromIso8601("2026-06-21T11:00:00Z");

      // LOW oblique camera over mountainous terrain (the Alps) looking
      // north toward the horizon: pitch up so the sky fills the top of the
      // frame and the terrain + near-ground mist band fills the bottom.
      v.camera.setView({
        destination: C.Cartesian3.fromDegrees(10.5, 46.4, 3500),
        orientation: {
          heading: C.Math.toRadians(0),
          pitch: C.Math.toRadians(-8),
          roll: 0,
        },
      });

      // Ground fog needs a base fog field to layer over. When the caller
      // wants the fog master on, enable it; otherwise leave it OFF so we
      // exercise the OWN-activation path (ground fog alone drives the
      // froxel render).
      ac.volumetricFog.enabled = settings.fogMaster === true;

      // The core toggle under test.
      ac.effects.groundFog.enabled = settings.enabled === true;
      ac.effects.groundFog.intensity = settings.intensity ?? 0.0;

      // Let terrain + the froxel passes settle.
      for (let i = 0; i < 400; i++) {
        scene.render();
        await new Promise((r) => requestAnimationFrame(r));
        if (scene.globe.tilesLoaded && i > 120) break;
      }

      return {
        groundFogEnabled: ac.effects.groundFog.enabled,
        groundFogIntensity: ac.effects.groundFog.intensity,
        volumetricFogEnabled: ac.volumetricFog.enabled,
      };
    },
    { settings },
  );
  await page.waitForTimeout(1500);

  const out = path.join(OUT_DIR, `ground-fog-${label}-webgpu.png`);
  await page.screenshot({ path: out, fullPage: false });
  await browser.close();

  const errs = messages.filter((m) => m.t === "error" || m.t === "pageerror");
  return { out, echo, errors: errs };
}

// Decode two PNGs and compare the mean luminance of the LOWER band (ground)
// vs the UPPER band (sky) between them. Returns how much each band
// brightened (b - a) — ground fog should brighten the lower band much more
// than the upper band. Uses Playwright's canvas decode (no Node PNG dep).
async function bandDiff(a, b) {
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
      const A = await decode(ba);
      const B = await decode(bb);
      if (A.w !== B.w || A.h !== B.h) return { error: "size mismatch" };
      const lum = (d, i) =>
        0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
      // Lower band = bottom 30% of rows (ground); upper band = top 30%
      // (sky). Mid band ignored so the terrain/sky boundary doesn't
      // pollute the measurement.
      const lowY0 = Math.floor(A.h * 0.7);
      const upY1 = Math.floor(A.h * 0.3);
      let lowA = 0,
        lowB = 0,
        lowN = 0;
      let upA = 0,
        upB = 0,
        upN = 0;
      for (let y = 0; y < A.h; y++) {
        for (let x = 0; x < A.w; x++) {
          const i = (y * A.w + x) * 4;
          if (y >= lowY0) {
            lowA += lum(A.data, i);
            lowB += lum(B.data, i);
            lowN++;
          } else if (y < upY1) {
            upA += lum(A.data, i);
            upB += lum(B.data, i);
            upN++;
          }
        }
      }
      const lowerMeanA = lowA / Math.max(1, lowN);
      const lowerMeanB = lowB / Math.max(1, lowN);
      const upperMeanA = upA / Math.max(1, upN);
      const upperMeanB = upB / Math.max(1, upN);
      return {
        lowerMeanA: lowerMeanA.toFixed(2),
        lowerMeanB: lowerMeanB.toFixed(2),
        lowerBandBrighten: (lowerMeanB - lowerMeanA).toFixed(2),
        upperMeanA: upperMeanA.toFixed(2),
        upperMeanB: upperMeanB.toFixed(2),
        upperBandBrighten: (upperMeanB - upperMeanA).toFixed(2),
      };
    },
    { ba, bb },
  );
  await browser.close();
  return result;
}

(async () => {
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
  console.log("[probe-ground-fog] Atmospheric Effects Phase C — GROUND FOG");

  // OFF baseline (ground fog disabled, fog master off).
  const off = await capture("off", {
    enabled: false,
    intensity: 0.0,
    fogMaster: false,
  });
  console.log(`  off:  ${off.out} (${off.errors.length} errors)`);
  console.log(`        echo: ${JSON.stringify(off.echo)}`);

  // ON via the OWN-activation path: ground fog enabled, fog master OFF.
  const on = await capture("on", {
    enabled: true,
    intensity: 1.0,
    fogMaster: false,
  });
  console.log(`  on:   ${on.out} (${on.errors.length} errors)`);
  console.log(`        echo: ${JSON.stringify(on.echo)}`);

  // Second OFF capture for the OFF-vs-OFF sanity baseline (~0 delta).
  const off2 = await capture("off2", {
    enabled: false,
    intensity: 0.0,
    fogMaster: false,
  });
  console.log(`  off2: ${off2.out} (${off2.errors.length} errors)`);

  for (const r of [off, on, off2]) {
    if (r.errors.length) {
      console.log(`  ${path.basename(r.out)} errors:`);
      r.errors.slice(0, 3).forEach((e) => console.log(`    ${e.t}: ${e.text}`));
    }
  }

  console.log("\n  ON vs OFF band brighten (mist should hug the ground):");
  console.log("   ", JSON.stringify(await bandDiff(off.out, on.out)));
  console.log("\n  OFF vs OFF sanity (both bands ~0):");
  console.log("   ", JSON.stringify(await bandDiff(off.out, off2.out)));

  console.log("\nManual checks (read the PNGs):");
  console.log(
    "  ON:  a milky near-surface mist hugs the bottom of the frame; the",
  );
  console.log(
    "       sky high above stays clear. lowerBandBrighten >> upperBandBrighten.",
  );
  console.log(
    "  OFF: clean terrain + sky, no mist. OFF-vs-OFF bands ~0 (byte-stable).",
  );
  console.log("[probe-ground-fog] done");
})();
