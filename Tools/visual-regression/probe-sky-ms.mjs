#!/usr/bin/env node
// Batch 427 — SKY-MS (multiple-scattering in the visible sky).
//
// Two jobs:
//   1. PARITY: capture the WebGPU sky with skyAtmosphere.multipleScattering OFF.
//      Save the PNG. Run twice across a rebuild (pre-change vs post-change) and
//      compare byte-for-byte — default-false MUST be byte-identical to today.
//   2. FLAG-ON: capture with multipleScattering ON. The horizon / shadowed limb
//      band must be measurably brighter than OFF (MS lifts the too-dark
//      single-scatter horizon) while the zenith hue stays sane.
//
// Mode is selected by argv: `off` (default) or `on`. The PNG filename encodes
// the mode + an optional tag (argv[3]) so the parity pass can label pre/post.
//
//   node Tools/visual-regression/probe-sky-ms.mjs off pre
//   node Tools/visual-regression/probe-sky-ms.mjs off post
//   node Tools/visual-regression/probe-sky-ms.mjs on
//
// Ground-level view with the sun near the horizon (max MS effect) and the
// fullscreen sky path so the whole frame is sky (no shell coverage gap).

import { chromium } from "playwright";
import fs from "fs";
import path from "path";

const BASE = "http://localhost:8080";
const OUT_DIR = "Tools/visual-regression/output";

const MODE = (process.argv[2] || "off").toLowerCase(); // off | on
const TAG = process.argv[3] || ""; // optional label (pre/post)
const _MS_ON = MODE === "on";
// Optional ISO time override (env SKY_MS_TIME) — lets the flag-ON visibility
// run pick a twilight sun (sun near/below horizon) where MS lifts the dark
// single-scatter sky most. Default keeps the daytime sun used by the parity run.
const TIME_ISO = process.env.SKY_MS_TIME || "2026-05-19T23:30:00Z";

// Ground-level, looking toward the horizon where the sun sits low. Sun near the
// horizon maximizes the multiple-scattering lift on the limb. Pittsburgh-ish
// location, camera low, heading toward the sunset.
const VIEW = { lon: -80.0, lat: 40.0, height: 200.0 };

async function capture(mode, tag) {
  const browser = await chromium.launch({
    channel: "msedge",
    headless: true,
    args: ["--enable-unsafe-webgpu", "--use-vulkan", "--disable-cache"],
  });
  const page = await browser.newPage({
    viewport: { width: 1280, height: 720 },
  });
  const consoleErrors = [];
  page.on("console", (m) => {
    if (m.type() === "error") consoleErrors.push(m.text());
  });
  await page.goto(`${BASE}/Apps/CesiumViewer/index.html?renderer=webgpu`, {
    waitUntil: "networkidle",
  });
  await page.waitForFunction(() => !!window.viewer);

  await page.evaluate(
    async ({ msOn, view, timeIso }) => {
      const C = await import("/Build/CesiumUnminified/index.js");
      const v = window.viewer;
      // Pin the clock so the sun direction is reproducible.
      const fixed = C.JulianDate.fromIso8601(timeIso);
      v.clock.currentTime = fixed.clone();
      v.clock.startTime = fixed.clone();
      v.clock.stopTime = fixed.clone();
      v.clock.shouldAnimate = false;
      v.clock.multiplier = 0;

      const sky = v.scene.skyAtmosphere;
      sky.show = true;
      // Fullscreen sky path → whole frame is sky (no shell coverage gap at
      // ground level). Same option the cloud/sky handoff uses.
      sky._webgpuFullscreen = true;
      // The flag under test. Default false; this probe flips it for `on`.
      sky.multipleScattering = msOn;

      v.scene.globe.showGroundAtmosphere = false;
      // Hide the globe so the frame is pure sky — removes async terrain-tile
      // streaming as a source of frame-to-frame non-determinism, which the
      // byte-exact parity gate needs. The whole frame is the fullscreen sky.
      v.scene.globe.show = false;
      v.scene.fog.enabled = false;
      v.scene.skyBox.show = false;
      v.scene.sun.show = false;
      v.scene.moon.show = false;
      v.scene.globe.enableLighting = false;
      v.scene.backgroundColor = C.Color.BLACK;

      // Hide the timeline / animation / nav widgets so the bottom toolbar
      // (clock needle, timeline ticks) doesn't introduce frame-timing-
      // dependent UI pixels into the byte-exact parity diff. Only the sky
      // matters here.
      for (const sel of [
        ".cesium-viewer-timelineContainer",
        ".cesium-viewer-animationContainer",
        ".cesium-viewer-bottom",
        ".cesium-viewer-toolbar",
        ".cesium-viewer-fullscreenContainer",
        ".cesium-viewer-navigationContainer",
        ".cesium-navigation-help",
      ]) {
        const el = document.querySelector(sel);
        if (el) el.style.display = "none";
      }

      // Look toward the horizon (pitch slightly down so the horizon band sits
      // mid-frame). Heading west toward the low sun.
      v.camera.setView({
        destination: C.Cartesian3.fromDegrees(view.lon, view.lat, view.height),
        orientation: {
          heading: C.Math.toRadians(270.0),
          pitch: C.Math.toRadians(-2.0),
          roll: 0.0,
        },
      });

      // Fixed frame count — globe is hidden so there's nothing async to wait
      // on; this keeps the captured frame deterministic for the parity gate.
      // The first ~30 frames let the atmosphere LUT bake settle.
      for (let i = 0; i < 90; i++) {
        v.scene.render();
        await new Promise((r) => requestAnimationFrame(r));
      }
    },
    { msOn: mode === "on", view: VIEW, timeIso: TIME_ISO },
  );
  await page.waitForTimeout(1200);
  const label = tag ? `${mode}-${tag}` : mode;
  const out = path.join(OUT_DIR, `sky-ms-${label}.png`);
  await page.screenshot({ path: out });
  await browser.close();
  if (consoleErrors.length) {
    console.log(`  [console errors: ${consoleErrors.length}]`);
    consoleErrors.slice(0, 6).forEach((e) => console.log("    " + e));
  } else {
    console.log("  [0 console errors]");
  }
  return out;
}

// Region stats: split the frame into a HORIZON band (lower-middle, where MS
// lifts) and a ZENITH band (top, should stay sane). Returns mean luminance per
// band for one PNG, plus a full-frame mismatch vs a reference PNG if provided.
async function analyze(pngPath, refPath) {
  const browser = await chromium.launch({ channel: "msedge", headless: true });
  const page = await browser.newPage({
    viewport: { width: 1280, height: 720 },
  });
  await page.setContent("<!doctype html><html><body></body></html>");
  const b64 = fs.readFileSync(pngPath).toString("base64");
  const refB64 = refPath ? fs.readFileSync(refPath).toString("base64") : null;
  const stats = await page.evaluate(
    async ({ b64, refB64 }) => {
      async function decode(s) {
        const img = new Image();
        img.src = "data:image/png;base64," + s;
        await img.decode();
        const cv = document.createElement("canvas");
        cv.width = img.width;
        cv.height = img.height;
        const ctx = cv.getContext("2d");
        ctx.drawImage(img, 0, 0);
        return ctx.getImageData(0, 0, img.width, img.height);
      }
      const a = await decode(b64);
      const w = a.width,
        h = a.height;
      const da = a.data;
      // Globe hidden → whole frame is sky. Horizon line sits ~mid-frame at
      // pitch -2°. Near-horizon band = [0.42, 0.50] (just above the horizon,
      // where MS lifts the too-dark single-scatter limb). Zenith band =
      // [0.05, 0.18] (upper sky, should stay sane / not blow out).
      const hzY0 = Math.floor(h * 0.42),
        hzY1 = Math.floor(h * 0.5);
      const znY0 = Math.floor(h * 0.05),
        znY1 = Math.floor(h * 0.18);
      function bandLum(y0, y1) {
        let sum = 0,
          n = 0,
          rS = 0,
          gS = 0,
          bS = 0;
        for (let y = y0; y < y1; y++) {
          for (let x = 0; x < w; x++) {
            const i = (y * w + x) * 4;
            const r = da[i],
              g = da[i + 1],
              b = da[i + 2];
            rS += r;
            gS += g;
            bS += b;
            sum += 0.2126 * r + 0.7152 * g + 0.0722 * b;
            n++;
          }
        }
        return { lum: sum / n, r: rS / n, g: gS / n, b: bS / n };
      }
      const out = {
        horizon: bandLum(hzY0, hzY1),
        zenith: bandLum(znY0, znY1),
      };
      if (refB64) {
        const ref = await decode(refB64);
        const dr = ref.data;
        let mismatch = 0,
          total = 0,
          deltaSum = 0,
          maxDelta = 0;
        for (let i = 0; i < da.length; i += 4) {
          const delta =
            Math.abs(da[i] - dr[i]) +
            Math.abs(da[i + 1] - dr[i + 1]) +
            Math.abs(da[i + 2] - dr[i + 2]);
          deltaSum += delta;
          if (delta > maxDelta) maxDelta = delta;
          if (delta > 0) mismatch++;
          total++;
        }
        out.diff = {
          mismatch,
          total,
          mismatchPct: (100 * mismatch) / total,
          meanDelta: deltaSum / total,
          maxDelta,
        };
      }
      return out;
    },
    { b64, refB64 },
  );
  await browser.close();
  return stats;
}

(async () => {
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
  console.log(
    `[sky-ms] mode=${MODE}${TAG ? ` tag=${TAG}` : ""} view=lat40,200m,sun-near-horizon, fullscreen sky`,
  );
  const png = await capture(MODE, TAG);
  const s = await analyze(png, null);
  console.log(
    `  horizon lum=${s.horizon.lum.toFixed(2)} (r=${s.horizon.r.toFixed(1)} g=${s.horizon.g.toFixed(1)} b=${s.horizon.b.toFixed(1)})`,
  );
  console.log(
    `  zenith  lum=${s.zenith.lum.toFixed(2)} (r=${s.zenith.r.toFixed(1)} g=${s.zenith.g.toFixed(1)} b=${s.zenith.b.toFixed(1)})`,
  );
  console.log(`  PNG: ${png}`);
})();
