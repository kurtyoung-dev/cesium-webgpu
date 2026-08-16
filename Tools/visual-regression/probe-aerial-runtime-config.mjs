#!/usr/bin/env node
// Probe (Q15 — ATMO-AERIAL-PERSPECTIVE-NEARFIELD-TUNE): prove that
// `window.viewer.scene.aerialPerspectiveConfig.{intensity,inscatterScale}` are RUNTIME-MUTABLE
// for the WebGPU aerial-perspective post-process. Before the fix the config was
// read once at effect init (addAerialPerspective) and later mutations were
// inert — the setIntensity/setInscatterScale setters existed but the configure
// pass never re-pushed them per frame (unlike ColdOptics / HeatShimmer). The fix
// re-reads the config object every frame in updateAerialPerspectiveFrameData.
// @purpose Proves aerialPerspectiveConfig intensity/inscatterScale are runtime-mutable per frame on the WebGPU aerial-perspective effect, with OFF-gate.
// @status ACTIVE
//
// Method (WebGPU only — this effect has no WebGL counterpart):
//   1. Enable aerialPerspective with a LOW intensity config, warm up, capture
//      the far-band (distant terrain) brightness.
//   2. Mutate window.viewer.scene.aerialPerspectiveConfig.intensity to a HIGH value AT RUNTIME
//      (same object, no re-init), settle, capture again.
//   3. Assert the far band got measurably HAZIER (brighter inscatter + more
//      extinction blend). A change proves the per-frame sync is live; NO change
//      is the pre-fix bug.
//   4. Repeat for inscatterScale (low → high) to prove the second dial too.
//   5. OFF-GATE: with aerialPerspective=false the frame is the plain globe and
//      config mutations do nothing (byte-identical default path). Zero errors.
//
// Camera: low oblique horizon view (Colorado Rockies) — wide depth span so the
// far band shows the haze gradient. Mirrors probe-aerial-perspective.mjs.
//
// Usage: node Tools/visual-regression/probe-aerial-runtime-config.mjs
// Env:   PROBE_BASE (default http://localhost:8080)

import { chromium } from "playwright";
import { fileURLToPath } from "url";
import path from "path";

const BASE = process.env.PROBE_BASE || "http://localhost:8080";
const OUT_DIR = path.dirname(fileURLToPath(import.meta.url));

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
page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
await page.goto(`${BASE}/Apps/CesiumViewer/index.html?renderer=webgpu`, {
  waitUntil: "networkidle",
});
await page.waitForFunction(() => !!window.viewer);

const setup = await page.evaluate(async () => {
  const C = await import("/Build/CesiumUnminified/index.js");
  const v = window.viewer;
  const scene = v.scene;

  scene.requestRenderMode = false;
  v.clock.shouldAnimate = false;
  v.clock.currentTime = C.JulianDate.fromIso8601("2026-06-15T19:00:00Z");

  scene.globe.showGroundAtmosphere = true;
  scene.fog.enabled = true;
  if (scene.skyAtmosphere) scene.skyAtmosphere.show = true;

  // Aerial perspective ON, LOW starting intensity — set BEFORE first enable so
  // the effect inits with this config; runtime mutation is what we then test.
  window.viewer.scene.aerialPerspectiveConfig = {
    intensity: 0.1,
    inscatterScale: 0.05,
  };
  scene.aerialPerspective = true;

  v.camera.setView({
    destination: C.Cartesian3.fromDegrees(-106.5, 38.8, 6000.0),
    orientation: {
      heading: C.Math.toRadians(0.0),
      pitch: C.Math.toRadians(-8.0),
      roll: 0.0,
    },
  });

  const oncePostRender = () =>
    new Promise((resolve) => {
      const remove = scene.postRender.addEventListener(() => {
        remove();
        resolve();
      });
    });

  let frames = 0;
  let consecutiveLoaded = 0;
  for (; frames < 900; frames++) {
    await oncePostRender();
    consecutiveLoaded = scene.globe.tilesLoaded ? consecutiveLoaded + 1 : 0;
    if (frames > 300 && consecutiveLoaded > 60) break;
  }
  return { warmupFrames: frames, tilesLoaded: scene.globe.tilesLoaded };
});

// Capture far-band brightness/saturation after applying a runtime config mutator.
// `mutate` runs in-page each capture; `aerialOn` toggles the master flag.
async function capture(mutate, aerialOn, pngName) {
  const stats = await page.evaluate(
    async ({ mutateSrc, on }) => {
      const v = window.viewer;
      const scene = v.scene;
      scene.aerialPerspective = on;
      // eslint-disable-next-line no-eval
      (0, eval)(mutateSrc);

      const oncePostRender = () =>
        new Promise((resolve) => {
          const remove = scene.postRender.addEventListener(() => {
            remove();
            resolve();
          });
        });

      for (let i = 0; i < 20; i++) await oncePostRender();

      return new Promise((resolve) => {
        const remove = scene.postRender.addEventListener(() => {
          remove();
          const c = scene.canvas;
          const off = document.createElement("canvas");
          off.width = c.width;
          off.height = c.height;
          const cx = off.getContext("2d");
          cx.drawImage(c, 0, 0);
          const w = c.width;
          const h = c.height;
          const d = cx.getImageData(0, 0, w, h).data;

          const farY0 = Math.floor(h * 0.3);
          const farY1 = Math.floor(h * 0.45);
          let sb = 0;
          let ss = 0;
          let n = 0;
          for (let y = farY0; y < farY1; y++) {
            for (let x = 0; x < w; x++) {
              const i = (y * w + x) * 4;
              const r = d[i] / 255;
              const g = d[i + 1] / 255;
              const b = d[i + 2] / 255;
              const mx = Math.max(r, g, b);
              const mn = Math.min(r, g, b);
              sb += (r + g + b) / 3;
              ss += mx > 1e-4 ? (mx - mn) / mx : 0;
              n++;
            }
          }
          let sumB = 0;
          let nonBlack = 0;
          const total = w * h;
          for (let p = 0; p < total; p++) {
            const i = 4 * p;
            sumB += (d[i] + d[i + 1] + d[i + 2]) / 3 / 255;
            if (d[i] + d[i + 1] + d[i + 2] > 45) nonBlack++;
          }
          resolve({
            farBright: sb / n,
            farSat: ss / n,
            mean: sumB / total,
            nonBlack,
            total,
          });
        });
      });
    },
    { mutateSrc: mutate, on: aerialOn },
  );
  await page.screenshot({ path: `${OUT_DIR}/${pngName}` });
  return stats;
}

// (1) low intensity (init config), (2) high intensity via runtime mutation.
const lowInt = await capture(
  "window.viewer.scene.aerialPerspectiveConfig.intensity = 0.1;",
  true,
  "aerial-runtime-intensity-low.png",
);
const highInt = await capture(
  "window.viewer.scene.aerialPerspectiveConfig.intensity = 1.8;",
  true,
  "aerial-runtime-intensity-high.png",
);

// (3) inscatterScale low → high (keep intensity high so extinction is present).
const lowScatter = await capture(
  "window.viewer.scene.aerialPerspectiveConfig.intensity = 1.0; window.viewer.scene.aerialPerspectiveConfig.inscatterScale = 0.02;",
  true,
  "aerial-runtime-inscatter-low.png",
);
const highScatter = await capture(
  "window.viewer.scene.aerialPerspectiveConfig.intensity = 1.0; window.viewer.scene.aerialPerspectiveConfig.inscatterScale = 3.0;",
  true,
  "aerial-runtime-inscatter-high.png",
);

// (4) OFF-GATE: aerialPerspective disabled — config mutation is inert.
const offA = await capture(
  "window.viewer.scene.aerialPerspectiveConfig.intensity = 0.1;",
  false,
  "aerial-runtime-offgate-a.png",
);
const offB = await capture(
  "window.viewer.scene.aerialPerspectiveConfig.intensity = 5.0;",
  false,
  "aerial-runtime-offgate-b.png",
);

await browser.close();

// ── Evaluate ──
// (A) intensity dial is live: mutating intensity at runtime measurably changes
//     the far band. With the low inscatterScale in force here the dominant term
//     is the extinction blend `mix(1, extinction, hazeIntensity)`, so raising
//     intensity DIMS the far terrain — the SIGN is physical; the MAGNITUDE of
//     the change is the proof that the per-frame sync is live (pre-fix = 0).
const intDelta = highInt.farBright - lowInt.farBright;
const aOK = Math.abs(intDelta) > 0.02;
// (B) inscatterScale dial is live: raising it brightens the far band.
const scatterDelta = highScatter.farBright - lowScatter.farBright;
const bOK = scatterDelta > 0.02;
// (C) OFF-GATE: with aerialPerspective=false, mutating the config changes
//     nothing — the two off frames match within noise.
const offDelta = Math.abs(offB.mean - offA.mean);
const cOK = offDelta < 0.003;
// (D) scene still renders (not blacked) at high intensity.
const dOK = highInt.nonBlack > 200000;
// (E) zero console/validation errors.
const eOK = errors.length === 0;

console.log(
  `warmup: ${setup.warmupFrames} frames, tilesLoaded=${setup.tilesLoaded}`,
);
console.log(
  `intensity  low  farB=${lowInt.farBright.toFixed(4)} farS=${lowInt.farSat.toFixed(4)}`,
);
console.log(
  `intensity  high farB=${highInt.farBright.toFixed(4)} farS=${highInt.farSat.toFixed(4)}`,
);
console.log(
  `inscatter  low  farB=${lowScatter.farBright.toFixed(4)}   high farB=${highScatter.farBright.toFixed(4)}`,
);
console.log(
  `offgate    A mean=${offA.mean.toFixed(4)}   B mean=${offB.mean.toFixed(4)}`,
);
console.log(
  `(A) intensity runtime-live: far ΔB=${intDelta.toFixed(4)} (|Δ|>0.02) ${aOK ? "OK" : "FAIL"}`,
);
console.log(
  `(B) inscatterScale runtime-live: far ΔB=${scatterDelta.toFixed(4)} (>0.02) ${bOK ? "OK" : "FAIL"}`,
);
console.log(
  `(C) off-gate inert: |mean Δ|=${offDelta.toFixed(4)} (<0.003) ${cOK ? "OK" : "FAIL"}`,
);
console.log(
  `(D) renders at high intensity: ${highInt.nonBlack}/${highInt.total} ${dOK ? "OK" : "FAIL"}`,
);
console.log(`(E) console errors: ${errors.length} ${eOK ? "OK" : "FAIL"}`);
errors.slice(0, 8).forEach((e) => console.log("  ERR:", e.slice(0, 250)));
console.log(`PNGs: ${OUT_DIR}/aerial-runtime-*.png`);

const pass = aOK && bOK && cOK && dOK && eOK;
console.log(pass ? "PASS" : "FAIL");
process.exit(pass ? 0 : 1);
