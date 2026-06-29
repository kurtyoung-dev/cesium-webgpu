#!/usr/bin/env node
// Batch 428 — A-LUT-REPARAM (sun-relative sky-view LUT,
// NEW-ATMOSPHERE-LUT-SUN-RELATIVE).
//
// Two jobs:
//   1. PARITY: capture the WebGPU sky with skyAtmosphere.useScatteringLut OFF
//      at a fixed azimuth. Run twice across a rebuild (pre/post change) and diff
//      byte-for-byte — default-OFF MUST be byte-identical (the flag-off shader
//      never samples the sky-view LUT; the new bake writes a texture nothing
//      reads on the default path).
//   2. FLAG-ON correctness: capture with useScatteringLut ON at MULTIPLE view
//      azimuths relative to a fixed low sun (toward-sun / 90°-off / anti-sun).
//      The LUT-sampled sky must show physically-correct azimuthal variation
//      (warm near the sun, cooler anti-sun) — variation the OLD inscatter LUT
//      could NOT produce — and closely match the inline march on the meridian.
//
// Args: MODE = off | on   (default off)
//       AZIMUTH = toward | side | anti   (default toward) — heading vs the sun
//       TAG = optional label (pre/post)
//   node Tools/visual-regression/probe-sky-view-lut.mjs off toward pre
//   node Tools/visual-regression/probe-sky-view-lut.mjs on toward
//   node Tools/visual-regression/probe-sky-view-lut.mjs on anti
//
// Ground-level fullscreen sky, sun near the horizon (max azimuthal contrast),
// globe hidden so the frame is pure sky and deterministic for the byte gate.

import { chromium } from "playwright";
import fs from "fs";
import path from "path";

const BASE = "http://localhost:8080";
const OUT_DIR = "Tools/visual-regression/output";

const MODE = (process.argv[2] || "off").toLowerCase(); // off | on
const AZIMUTH = (process.argv[3] || "toward").toLowerCase(); // toward|side|anti
const TAG = process.argv[4] || "";
const LUT_ON = MODE === "on";
const ALSO_MS = process.env.SKY_VIEW_MS === "1"; // bonus: MS on too

const TIME_ISO = process.env.SKY_VIEW_TIME || "2026-05-19T23:30:00Z";
const VIEW = { lon: -80.0, lat: 40.0, height: 200.0 };

// Heading the camera relative to the sun's azimuth. The sun at the chosen time
// sits low to the west, so heading west (270°) looks toward it, east (90°) is
// anti-sun, north (0°) is 90° off. We do NOT hardcode the sun azimuth; instead
// we measure the camera-frame sun direction in the page and report it.
const HEADINGS = { toward: 270.0, side: 0.0, anti: 90.0 };

async function capture(mode, azimuth, tag) {
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

  const sunInfo = await page.evaluate(
    async ({ lutOn, alsoMs, view, timeIso, heading }) => {
      const C = await import("/Build/CesiumUnminified/index.js");
      const v = window.viewer;
      const fixed = C.JulianDate.fromIso8601(timeIso);
      v.clock.currentTime = fixed.clone();
      v.clock.startTime = fixed.clone();
      v.clock.stopTime = fixed.clone();
      v.clock.shouldAnimate = false;
      v.clock.multiplier = 0;

      const sky = v.scene.skyAtmosphere;
      sky.show = true;
      sky._webgpuFullscreen = true;
      sky.useScatteringLut = lutOn;
      sky.multipleScattering = alsoMs;
      // Force SUNLIGHT dynamic lighting so the LUT path (which requires a
      // non-NONE light direction) is exercised.
      v.scene.atmosphere.dynamicLighting =
        C.DynamicAtmosphereLightingType.SUNLIGHT;

      v.scene.globe.showGroundAtmosphere = false;
      v.scene.globe.show = false;
      v.scene.fog.enabled = false;
      v.scene.skyBox.show = false;
      v.scene.sun.show = false;
      v.scene.moon.show = false;
      v.scene.globe.enableLighting = false;
      v.scene.backgroundColor = C.Color.BLACK;

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

      v.camera.setView({
        destination: C.Cartesian3.fromDegrees(view.lon, view.lat, view.height),
        orientation: {
          heading: C.Math.toRadians(heading),
          pitch: C.Math.toRadians(-2.0),
          roll: 0.0,
        },
      });

      for (let i = 0; i < 90; i++) {
        v.scene.render();
        await new Promise((r) => requestAnimationFrame(r));
      }

      // Report the angle between the camera forward direction and the sun
      // direction (world) so we can confirm toward/side/anti geometry.
      const sunWC = v.scene.frameState?.sunDirectionWC;
      const fwd = v.camera.directionWC;
      let cosToSun = 0;
      if (sunWC && fwd) {
        cosToSun = sunWC.x * fwd.x + sunWC.y * fwd.y + sunWC.z * fwd.z;
      }
      // Sun zenith at the camera (cos between sun and local up).
      const up = C.Cartesian3.normalize(
        v.camera.positionWC,
        new C.Cartesian3(),
      );
      let cosSunZenith = 0;
      if (sunWC) {
        cosSunZenith = sunWC.x * up.x + sunWC.y * up.y + sunWC.z * up.z;
      }
      return { cosToSun, cosSunZenith };
    },
    {
      lutOn: mode === "on",
      alsoMs: ALSO_MS,
      view: VIEW,
      timeIso: TIME_ISO,
      heading: HEADINGS[azimuth] ?? 270.0,
    },
  );
  await page.waitForTimeout(1000);
  const msTag = ALSO_MS ? "-ms" : "";
  const label = tag
    ? `${mode}-${azimuth}${msTag}-${tag}`
    : `${mode}-${azimuth}${msTag}`;
  const out = path.join(OUT_DIR, `sky-view-lut-${label}.png`);
  await page.screenshot({ path: out });
  await browser.close();
  if (consoleErrors.length) {
    console.log(`  [console errors: ${consoleErrors.length}]`);
    consoleErrors.slice(0, 8).forEach((e) => console.log("    " + e));
  } else {
    console.log("  [0 console errors]");
  }
  return { out, sunInfo };
}

// Band luminance + optional byte-diff vs a reference PNG.
async function analyze(pngPath, refPath) {
  const browser = await chromium.launch({ channel: "msedge", headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
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
  const refArg = process.env.SKY_VIEW_REF || null;
  console.log(
    `[sky-view-lut] mode=${MODE} azimuth=${AZIMUTH}${TAG ? ` tag=${TAG}` : ""}${ALSO_MS ? " +MS" : ""}`,
  );
  const { out, sunInfo } = await capture(MODE, AZIMUTH, TAG);
  console.log(
    `  sun: cosToCamFwd=${sunInfo.cosToSun.toFixed(3)} cosSunZenith=${sunInfo.cosSunZenith.toFixed(3)}`,
  );
  const s = await analyze(out, refArg);
  console.log(
    `  horizon lum=${s.horizon.lum.toFixed(2)} (r=${s.horizon.r.toFixed(1)} g=${s.horizon.g.toFixed(1)} b=${s.horizon.b.toFixed(1)})`,
  );
  console.log(
    `  zenith  lum=${s.zenith.lum.toFixed(2)} (r=${s.zenith.r.toFixed(1)} g=${s.zenith.g.toFixed(1)} b=${s.zenith.b.toFixed(1)})`,
  );
  if (s.diff) {
    console.log(
      `  DIFF vs ${refArg}: mismatchPct=${s.diff.mismatchPct.toFixed(4)}% meanDelta=${s.diff.meanDelta.toFixed(4)} maxDelta=${s.diff.maxDelta}`,
    );
  }
  console.log(`  PNG: ${out}`);
})();
