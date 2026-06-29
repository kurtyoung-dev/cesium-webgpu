#!/usr/bin/env node
/**
 * Batch 436 (3.6 CLOUD-CONE-LIGHT) — COST probe (GPU-synced A/B).
 *
 * Times the cinematic cloud frame with the light march in STRAIGHT vs CONE mode
 * (flipping only window.__FORCE_CONE). Everything else identical, high coverage so
 * the per-sample lightMarch dominates the frame. Cone should be cheaper.
 *
 * Usage: node Tools/visual-regression/probe-cloud-cone-perf.mjs
 */
import { chromium } from "playwright";

const BASE = process.env.PROBE_BASE || "http://localhost:8080";

async function timeMode(page, forceCone) {
  return page.evaluate(async (forceCone) => {
    window.__FORCE_CONE = forceCone;
    const C = await import("/Build/CesiumUnminified/index.js");
    const v = window.viewer,
      s = v.scene,
      g = s.globe;
    s.skyBox.show = false;
    s.sun.show = false;
    s.skyAtmosphere.show = false;
    s.backgroundColor = C.Color.BLACK;
    g.show = false;
    v.clock.shouldAnimate = false;
    const jd = C.JulianDate.fromIso8601("2026-06-21T18:20:00Z");
    v.clock.currentTime = jd;
    g.showProceduralClouds = true;
    g.cloudVolumetricQuality = "high"; // cinematic full-res baked, lightSteps=8
    g.cloudQuality = 64;
    g.cloudCoverage = 0.8; // dense — lots of fine samples → lightMarch dominates
    g.cloudDensity = 1.0;
    g.cloudLayerBottom = 1500;
    g.cloudLayerTop = 4000;
    v.camera.setView({
      destination: C.Cartesian3.fromDegrees(-95, 39, 2200),
      orientation: {
        heading: C.Math.toRadians(0),
        pitch: C.Math.toRadians(8),
        roll: 0.0,
      },
    });
    const device = s.context.device;
    for (let i = 0; i < 50; i++) {
      s.render(jd);
      await new Promise((r) => requestAnimationFrame(r));
    }
    if (device) await device.queue.onSubmittedWorkDone();
    const M = 200;
    const t0 = performance.now();
    for (let i = 0; i < M; i++) s.render(jd);
    if (device) await device.queue.onSubmittedWorkDone();
    const t1 = performance.now();
    return { msPerFrame: +((t1 - t0) / M).toFixed(4), hasDevice: !!device };
  }, forceCone);
}

const browser = await chromium.launch({
  channel: "msedge",
  headless: true,
  args: ["--enable-unsafe-webgpu"],
});
const page = await browser.newPage({ viewport: { width: 1024, height: 768 } });
const errors = [];
page.on("console", (m) => {
  if (m.type() === "error") errors.push(m.text());
});
await page.goto(`${BASE}/Apps/CesiumViewer/index.html?renderer=webgpu`, {
  waitUntil: "networkidle",
  timeout: 90_000,
});
await page.waitForFunction(() => !!window.viewer, { timeout: 90_000 });

// Interleave runs to average out thermal/scheduler drift.
const s1 = await timeMode(page, 0);
const c1 = await timeMode(page, 1);
const s2 = await timeMode(page, 0);
const c2 = await timeMode(page, 1);
await browser.close();

const straight = (s1.msPerFrame + s2.msPerFrame) / 2;
const cone = (c1.msPerFrame + c2.msPerFrame) / 2;
console.log(`STRAIGHT msPerFrame: ${s1.msPerFrame}, ${s2.msPerFrame} (avg ${straight.toFixed(3)})`);
console.log(`CONE     msPerFrame: ${c1.msPerFrame}, ${c2.msPerFrame} (avg ${cone.toFixed(3)})`);
console.log(`cone/straight = ${(cone / straight).toFixed(3)}  (lower = cheaper)`);
console.log(`hasDevice=${s1.hasDevice} errors=${errors.length}`);
