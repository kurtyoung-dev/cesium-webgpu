#!/usr/bin/env node
// Acceptance probe for Q7-PROBE-DETERMINISM.
// @purpose Acceptance for lib/determinism-kit.mjs: pinned-clock recipe makes globe captures reproducible run-to-run (<0.05%) while the legacy recipe drifts.
// @status ACTIVE
//
// Proves the determinism kit (Tools/visual-regression/lib/determinism-kit.mjs)
// makes a sky-visible globe probe REPRODUCIBLE run-to-run, killing the drift
// that flips globe probes red/green on unchanged builds.
//
// The drift is a RUN-TO-RUN (separate page load) effect: the CesiumViewer
// clock initialises to wall-clock "now" at construction, so the star-field
// TEME rotation + sun elevation differ on every load. Two loads minutes apart
// render a visibly different sky over the SAME globe. We therefore measure
// WITHIN-BACKEND reproducibility: capture the same backend N times in separate
// page loads and diff each run against run 0.
//
//   BASELINE mode — legacy recipe: unpinned clock, fixed 240-frame loop, sky
//                   on. Expect run-to-run diff > 0 (the sky moved).
//   KIT mode      — pinClock (+ settleTiles); sky ON so the frozen star field
//                   is what's being stabilised. Expect run-to-run diff ~0.
//
// PASS: KIT within-backend run-to-run mismatch is < 0.05% on BOTH backends
// AND at least the baseline shows it CAN drift (baseline max >= kit max),
// i.e. the kit is doing real work, not masking a trivially-static scene.
//
// Usage: PROBE_RUNS=3 node Tools/visual-regression/probe-determinism-kit.mjs
// Env: PROBE_BASE (default http://localhost:8080), PROBE_RUNS (default 3)

import { chromium } from "playwright";
import fs from "fs";
import path from "path";
import {
  DET_BROWSER_SETUP,
  DETERMINISTIC_CLOCK_ISO,
  runCount,
} from "./lib/determinism-kit.mjs";

const BASE = process.env.PROBE_BASE || "http://localhost:8080";
const OUT_DIR = "Tools/visual-regression/output/determinism-kit";
const N = runCount(3);

// A horizon view from ~2 Earth radii: the globe fills the lower frame, the
// upper frame is star-field sky — the region whose rotation drifts run-to-run
// under an unpinned clock.
const CAMERA_JS = `
  v.camera.setView({
    destination: scene.globe.ellipsoid.cartographicToCartesian({
      longitude: -1.3194745, latitude: 0.35, height: 8000000.0,
    }),
    orientation: { heading: 0.0, pitch: -0.35, roll: 0.0 },
  });
`;

async function capture(rendererArg, useKit, tag) {
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
    viewport: { width: 1024, height: 640 },
  });
  await page.goto(
    `${BASE}/Apps/CesiumViewer/index.html?renderer=${rendererArg}`,
    {
      waitUntil: "networkidle",
    },
  );
  await page.waitForFunction(() => !!window.viewer);

  await page.evaluate(
    async ({ det, useKit, iso, camera }) => {
      const v = window.viewer;
      const scene = v.scene;
      for (const el of document.querySelectorAll(
        ".cesium-viewer-toolbar, .cesium-viewer-animationContainer, " +
          ".cesium-viewer-timelineContainer, .cesium-viewer-bottom, " +
          ".cesium-widget-credits, #toolbar",
      )) {
        el.style.display = "none";
      }
      // eslint-disable-next-line no-new-func
      new Function(det)();
      // eslint-disable-next-line no-new-func
      new Function("v", "scene", camera)(v, scene);

      const C = await import("/Build/CesiumUnminified/index.js");
      if (useKit) {
        // Kit: pin the clock (freezes the star field / sun regardless of when
        // this page loaded), then settle. Sky stays ON — the frozen sky is
        // exactly what we are proving reproducible.
        window.__det.pinClock(C, v, scene, iso);
        await window.__det.settleTiles(scene, {
          stableFrames: 30,
          maxFrames: 1500,
        });
      } else {
        // Legacy: leave the clock at wall-clock "now" (set shouldAnimate on so
        // the sky also advances DURING the run, matching the historical
        // unpinned probes), fixed frame loop.
        v.clock.shouldAnimate = true;
        v.clock.multiplier = 3600;
        for (let i = 0; i < 240; i++) {
          scene.render();
          await new Promise((r) => requestAnimationFrame(r));
        }
      }
    },
    {
      det: DET_BROWSER_SETUP,
      useKit,
      iso: DETERMINISTIC_CLOCK_ISO,
      camera: CAMERA_JS,
    },
  );
  if (!useKit) await page.waitForTimeout(1200);

  const out = path.join(OUT_DIR, `${tag}-${rendererArg}.png`);
  await page.screenshot({ path: out, fullPage: false });
  await browser.close();
  return out;
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
      if (a.w !== b.w || a.h !== b.h) return { mismatchPct: 100 };
      const total = a.w * a.h;
      let mismatch = 0;
      for (let i = 0; i < a.data.length; i += 4) {
        const d =
          Math.abs(a.data[i] - b.data[i]) +
          Math.abs(a.data[i + 1] - b.data[i + 1]) +
          Math.abs(a.data[i + 2] - b.data[i + 2]);
        if (d > 30) mismatch++;
      }
      return { mismatchPct: (100 * mismatch) / total };
    },
    { ba, bb },
  );
  await browser.close();
  return result.mismatchPct;
}

// Capture a backend N times (separate loads) and report the max run-to-run
// diff vs run 0 — the within-backend reproducibility of the metric.
async function reproducibility(useKit, rendererArg) {
  const mode = useKit ? "kit" : "baseline";
  const shots = [];
  for (let i = 0; i < N; i++) {
    shots.push(
      await capture(rendererArg, useKit, `${mode}-${rendererArg}-run${i}`),
    );
  }
  let maxDiff = 0;
  const diffs = [];
  for (let i = 1; i < N; i++) {
    const d = await diffPngs(shots[0], shots[i]);
    diffs.push(d);
    maxDiff = Math.max(maxDiff, d);
  }
  console.log(
    `  [${mode} ${rendererArg}] run-to-run vs run0: [${diffs
      .map((x) => x.toFixed(3))
      .join(", ")}]% max=${maxDiff.toFixed(3)}%`,
  );
  return maxDiff;
}

(async () => {
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
  console.log(
    `[determinism-kit] ${N} separate loads per (mode,backend), sky-visible horizon view\n`,
  );

  console.log(`BASELINE (unpinned wall-clock, animating sky):`);
  const baseGpu = await reproducibility(false, "webgpu");
  const baseGl = await reproducibility(false, "webgl");
  const baseMax = Math.max(baseGpu, baseGl);

  console.log(`\nKIT (pinClock + settleTiles, sky frozen):`);
  const kitGpu = await reproducibility(true, "webgpu");
  const kitGl = await reproducibility(true, "webgl");
  const kitMax = Math.max(kitGpu, kitGl);

  console.log(
    `\nwithin-backend run-to-run drift: baseline max=${baseMax.toFixed(3)}% -> kit max=${kitMax.toFixed(3)}%`,
  );
  console.log(`PNGs: ${OUT_DIR}`);
  const pass = kitMax < 0.05 && baseMax >= kitMax;
  console.log(pass ? "PASS" : "FAIL");
  process.exit(pass ? 0 : 1);
})();
