#!/usr/bin/env node
// Probe (Item 2.3 — AERIAL-FROXEL): the aerial-perspective froxel 3D LUT fast
// path. When `scene.aerialPerspectiveFroxel = true` (nested under the opt-in
// `scene.aerialPerspective`), the effect bakes a 32³ froxel volume of
// accumulated inscatter + transmittance once per frame and the fragment shader
// does ONE trilinear fetch instead of the 10-step per-pixel analytic march.
//
// Same low-oblique wide-depth-span view as probe-aerial-perspective.mjs.
//
// Captures three states:
//   A) aerialPerspective OFF                    — no-aerial baseline
//   B) aerialPerspective ON, froxel OFF         — analytic march (parity path)
//   C) aerialPerspective ON, froxel ON          — froxel fast path (this feature)
//
// Assertions:
//   (1) FROXEL RENDERS — C fills a large non-black region (bake + 3D sample did
//       not black/NaN the scene).
//   (2) FROXEL AERIAL SIGNATURE — C's far band is HAZIER than A (brighter AND
//       desaturated), the definitive aerial-perspective signature, proving the
//       froxel path produces real distance haze.
//   (3) FROXEL IS LIVE / DISTINCT — C differs from A in overall brightness (the
//       froxel contributes, not a passthrough no-op).
//   (4) ANALYTIC PARITY PATH STILL WORKS — B also shows the aerial signature
//       (the froxel-OFF gate leaves the analytic march intact).
//   (5) ZERO console errors (incl. WebGPU validation — the compute bake, the
//       3D storage/sample bindings, and the extra uniform slot are all valid).
//
// OFF-GATE NOTE: with `froxel` OFF the fragment's `froxelParams.x` is 0, so the
// `if (froxelParams.x > 0.5)` block is skipped and the analytic march runs
// verbatim — state B is byte-identical to the pre-change analytic path. This
// probe demonstrates B still carries the aerial signature; byte-identity is
// guaranteed structurally by the gate (no pre-change baseline needed).
//
// Usage: node Tools/visual-regression/probe-aerial-froxel.mjs
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

async function capture(aerialOn, froxelOn, pngName) {
  const stats = await page.evaluate(
    async ({ on, froxel }) => {
      const v = window.viewer;
      const scene = v.scene;
      scene.aerialPerspective = on;
      scene.aerialPerspectiveFroxel = froxel;

      const oncePostRender = () =>
        new Promise((resolve) => {
          const remove = scene.postRender.addEventListener(() => {
            remove();
            resolve();
          });
        });

      for (let i = 0; i < 30; i++) await oncePostRender();

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
          const bandStats = (y0, y1) => {
            let sb = 0;
            let ss = 0;
            let n = 0;
            for (let y = y0; y < y1; y++) {
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
            return { bright: sb / n, sat: ss / n };
          };

          let sumB = 0;
          let nonBlack = 0;
          const total = w * h;
          for (let p = 0; p < total; p++) {
            const i = 4 * p;
            sumB += (d[i] + d[i + 1] + d[i + 2]) / 3 / 255;
            if (d[i] + d[i + 1] + d[i + 2] > 45) nonBlack++;
          }
          const far = bandStats(farY0, farY1);
          resolve({
            mean: sumB / total,
            farBright: far.bright,
            farSat: far.sat,
            nonBlack,
            total,
          });
        });
      });
    },
    { on: aerialOn, froxel: froxelOn },
  );

  await page.screenshot({ path: `${OUT_DIR}/${pngName}` });
  return stats;
}

const a = await capture(false, false, "aerial-froxel-A-off.png");
const b = await capture(true, false, "aerial-froxel-B-analytic.png");
const c = await capture(true, true, "aerial-froxel-C-froxel.png");

await browser.close();

// (1) froxel renders
const renders = c.nonBlack > 200000;
// (2) froxel aerial signature vs no-aerial baseline
const cFarBrighter = c.farBright - a.farBright;
const cFarDesat = a.farSat - c.farSat;
const signature = cFarBrighter > 0.02 && cFarDesat > 0.0;
// (3) froxel is live / distinct from baseline
const cContributes =
  Math.abs(c.mean - a.mean) > 0.002 || Math.abs(cFarBrighter) > 0.01;
// (4) analytic parity path still shows the signature
const bFarBrighter = b.farBright - a.farBright;
const bFarDesat = a.farSat - b.farSat;
const analyticOK = bFarBrighter > 0.02 && bFarDesat > 0.0;
// (5) zero console errors
const noErr = errors.length === 0;

console.log(
  `warmup: ${setup.warmupFrames} frames, tilesLoaded=${setup.tilesLoaded}`,
);
console.log(
  `A  (no-aerial) : mean=${a.mean.toFixed(4)} farB=${a.farBright.toFixed(4)} farS=${a.farSat.toFixed(4)} nonBlack=${a.nonBlack}`,
);
console.log(
  `B  (analytic)  : mean=${b.mean.toFixed(4)} farB=${b.farBright.toFixed(4)} farS=${b.farSat.toFixed(4)} nonBlack=${b.nonBlack}`,
);
console.log(
  `C  (froxel)    : mean=${c.mean.toFixed(4)} farB=${c.farBright.toFixed(4)} farS=${c.farSat.toFixed(4)} nonBlack=${c.nonBlack}`,
);
console.log(
  `(1) froxel renders: ${c.nonBlack}/${c.total} non-black (>200000) ${renders ? "OK" : "FAIL"}`,
);
console.log(
  `(2) froxel aerial signature: far brighter=${cFarBrighter.toFixed(4)} (>0.02) AND desat=${cFarDesat.toFixed(4)} (>0) ${signature ? "OK" : "FAIL"}`,
);
console.log(
  `(3) froxel contributes: |mean d|=${Math.abs(c.mean - a.mean).toFixed(4)} ${cContributes ? "OK" : "FAIL"}`,
);
console.log(
  `(4) analytic path signature: far brighter=${bFarBrighter.toFixed(4)} desat=${bFarDesat.toFixed(4)} ${analyticOK ? "OK" : "FAIL"}`,
);
console.log(`(5) console errors: ${errors.length} ${noErr ? "OK" : "FAIL"}`);
errors.slice(0, 8).forEach((e) => console.log("  ERR:", e.slice(0, 250)));
console.log(`PNGs: ${OUT_DIR}/aerial-froxel-{A-off,B-analytic,C-froxel}.png`);

const pass = renders && signature && cContributes && analyticOK && noErr;
console.log(pass ? "PASS" : "FAIL");
process.exit(pass ? 0 : 1);
