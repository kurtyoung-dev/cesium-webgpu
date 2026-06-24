#!/usr/bin/env node
/**
 * Probe: cloud motion is CLOCK-BOUND, not wall-clock (Weather Phase 0a).
 *
 * Before: ProceduralClouds.wgsl `time` uniform = performance.now()/1000 → clouds
 * drift on wall time regardless of the scene clock (can't scrub/pause/replay).
 * After: `time` derives from frameState.time (the scene-clock JulianDate) → wind
 * advection scrubs with the timeline, freezes when the clock is paused, and
 * replays deterministically.
 *
 * Tests (WebGPU):
 *   (A) FROZEN: same scene-clock time, two captures separated by real wall time →
 *       cloud field IDENTICAL (was different when wall-clock-driven).
 *   (B) ADVECTS: two scene-clock times 3h apart → cloud field DIFFERENT (wind moved them).
 *
 * Compares cloud-pixel signatures via a coarse luminance grid hash + a changed-cell count.
 *
 * Usage: PROBE_BASE=http://localhost:8080 node Tools/visual-regression/probe-cloud-clockbind.mjs
 */
import { chromium } from "playwright";

const BASE = process.env.PROBE_BASE || "http://localhost:8080";

const browser = await chromium.launch({
  channel: "msedge",
  headless: true,
  args: ["--enable-unsafe-webgpu"],
});
const page = await browser.newPage({ viewport: { width: 1024, height: 768 } });
await page.goto(`${BASE}/Apps/CesiumViewer/index.html?renderer=webgpu`, {
  waitUntil: "networkidle",
  timeout: 90000,
});
await page.waitForFunction(() => !!window.viewer, { timeout: 90000 });

const result = await page.evaluate(async () => {
  const C = await import("/Build/CesiumUnminified/index.js");
  const v = window.viewer,
    s = v.scene,
    g = s.globe;
  g.showProceduralClouds = true;
  if ("cloudCoverage" in g) g.cloudCoverage = 0.45;
  if ("cloudDensity" in g) g.cloudDensity = 0.8;
  if ("cloudWindSpeed" in g) g.cloudWindSpeed = 4000; // strong wind so advection is obvious
  s.skyAtmosphere.show = false;
  if (s.sun) s.sun.show = false;
  if (s.moon) s.moon.show = false;
  s.skyBox.show = false;
  s.backgroundColor = C.Color.BLACK;
  v.clock.shouldAnimate = false; // we drive time manually

  v.camera.setView({
    destination: C.Cartesian3.fromDegrees(-95.0, 39.0, 800.0),
    orientation: {
      heading: C.Math.toRadians(0.0),
      pitch: C.Math.toRadians(10.0),
      roll: 0.0,
    },
  });

  // Coarse 32x24 luminance grid over the upper-half (sky) — a cheap cloud-field
  // signature robust to AA noise.
  function signature() {
    const cv = s.canvas,
      w = cv.width,
      h = cv.height;
    const t = document.createElement("canvas");
    t.width = w;
    t.height = h;
    const cx = t.getContext("2d");
    cx.drawImage(cv, 0, 0);
    const px = cx.getImageData(0, 0, w, h).data;
    const GX = 32,
      GY = 24;
    const grid = new Float32Array(GX * GY);
    const cw = Math.floor(w / GX),
      ch = Math.floor(h / 2 / GY); // upper half
    for (let gy = 0; gy < GY; gy++) {
      for (let gx = 0; gx < GX; gx++) {
        let sum = 0,
          n = 0;
        for (let yy = 0; yy < ch; yy += 3) {
          for (let xx = 0; xx < cw; xx += 3) {
            const px0 = (gx * cw + xx),
              py0 = gy * ch + yy;
            const i = (py0 * w + px0) * 4;
            sum += Math.max(px[i], px[i + 1], px[i + 2]);
            n++;
          }
        }
        grid[gy * GX + gx] = n ? sum / n : 0;
      }
    }
    return grid;
  }
  function changedCells(a, b, thresh = 18) {
    let c = 0;
    for (let i = 0; i < a.length; i++) if (Math.abs(a[i] - b[i]) > thresh) c++;
    return c;
  }

  async function renderFrames(n) {
    for (let i = 0; i < n; i++) {
      s.render();
      await new Promise((r) => requestAnimationFrame(r));
    }
  }

  const t0 = C.JulianDate.fromIso8601("2026-06-21T18:00:00Z");
  const t3h = C.JulianDate.addHours(t0, 3, new C.JulianDate());

  // (A) FROZEN — same scene time, but render two batches separated by REAL wall
  // time (the inner awaits + 40 frames each let performance.now advance ~hundreds
  // of ms). If clouds were wall-clock-driven they'd drift between sigA1 and sigA2.
  v.clock.currentTime = t0;
  await renderFrames(60);
  const sigA1 = signature();
  await new Promise((r) => setTimeout(r, 1200)); // burn wall-clock time
  v.clock.currentTime = t0; // re-assert same scene time
  await renderFrames(60);
  const sigA2 = signature();
  const frozenChanged = changedCells(sigA1, sigA2);

  // (B) ADVECTS — jump the scene clock 3h forward; wind should move the field.
  v.clock.currentTime = t3h;
  await renderFrames(60);
  const sigB = signature();
  const advectChanged = changedCells(sigA2, sigB);

  let cloudCells = 0;
  for (let i = 0; i < sigA1.length; i++) if (sigA1[i] > 150) cloudCells++;

  return { frozenChanged, advectChanged, cloudCells, totalCells: sigA1.length };
});

await browser.close();
console.log("RESULT:", JSON.stringify(result));
const checks = [
  ["clouds render (cloud cells > 20)", result.cloudCells > 20],
  [
    `FROZEN: same clock time → identical field (changed=${result.frozenChanged}, want <=3)`,
    result.frozenChanged <= 3,
  ],
  [
    `ADVECTS: +3h clock → field moved (changed=${result.advectChanged}, want >=20)`,
    result.advectChanged >= 20,
  ],
];
let pass = true;
for (const [label, ok] of checks) {
  console.log(`  [${ok ? "PASS" : "FAIL"}] ${label}`);
  if (!ok) pass = false;
}
console.log(`\nRESULT: ${pass ? "GREEN" : "RED"}`);
process.exitCode = pass ? 0 : 1;
