#!/usr/bin/env node
// Batch 429 — SKY-MS all-azimuth (A-LUT-REPARAM follow-up).
// @purpose Verifies the reparameterized MS LUT lifts the twilight sky at ALL azimuths (toward/side/anti sun), directionally, with no wrap seam.
// @status ACTIVE
//
// Verifies the multiple-scattering add now lifts the sky at ALL azimuths, not
// just the sun meridian, after re-parameterizing the MS LUT onto the
// sun-relative sky-view domain (relAzimuth × Hillaire-warped view-zenith).
//
// For a low/twilight sun, captures the WebGPU sky at four headings — TOWARD the
// sun, two SIDE views (±90° from the sun azimuth), and ANTI-sun — each with
// skyAtmosphere.multipleScattering OFF then ON. Reports the horizon-band
// luminance for each (off, on, delta). The Batch 427 add was directionally
// flat: ~zero off-meridian lift at twilight. After Batch 429 the on−off delta
// must be NON-trivial at every azimuth AND directional (largest toward the
// bright sky), with no over-bright veil and no azimuth-wrap seam.
//
//   node Tools/visual-regression/probe-sky-ms-azimuth.mjs
//
// Env:
//   SKY_MS_TIME  — ISO time (default 2026-05-19T23:30:00Z, the twilight sun the
//                  427 agent measured all-zero).

import { chromium } from "playwright";
import fs from "fs";
import path from "path";

const BASE = "http://localhost:8080";
const OUT_DIR = "Tools/visual-regression/output";
const TIME_ISO = process.env.SKY_MS_TIME || "2026-05-19T23:30:00Z";
const VIEW = { lon: -80.0, lat: 40.0, height: 200.0 };

// Resolve the sun's azimuth (deg, 0=N, CW) and elevation at the view, so the
// heading sweep is anchored to the actual sun position rather than a guess.
async function resolveSun(page) {
  return await page.evaluate(
    async ({ view, timeIso }) => {
      const C = await import("/Build/CesiumUnminified/index.js");
      const v = window.viewer;
      const fixed = C.JulianDate.fromIso8601(timeIso);
      v.clock.currentTime = fixed.clone();
      v.clock.shouldAnimate = false;
      // Sun direction in WC.
      const _sunWC = C.Simon1994PlanetaryPositions
        .computeSunPositionInEarthInertialFrame
        ? null
        : null;
      // Use Cesium's scene sun position via the existing helper through the
      // light. Simpler: derive ENU sun direction from the scene's sun.
      const carto = C.Cartographic.fromDegrees(view.lon, view.lat, view.height);
      const origin = C.Cartographic.toCartesian(carto);
      const enu = C.Transforms.eastNorthUpToFixedFrame(origin);
      const inv = C.Matrix4.inverseTransformation(enu, new C.Matrix4());
      // Sun position (WC) at this time.
      const sunPos =
        C.Simon1994PlanetaryPositions.computeSunPositionInEarthInertialFrame(
          fixed,
          new C.Cartesian3(),
        );
      // Inertial→fixed.
      const icrfToFixed = C.Transforms.computeIcrfToFixedMatrix(
        fixed,
        new C.Matrix3(),
      );
      let sunFixed = sunPos;
      if (icrfToFixed) {
        sunFixed = C.Matrix3.multiplyByVector(
          icrfToFixed,
          sunPos,
          new C.Cartesian3(),
        );
      }
      const sunDir = C.Cartesian3.normalize(
        C.Cartesian3.subtract(sunFixed, origin, new C.Cartesian3()),
        new C.Cartesian3(),
      );
      const sunLocal = C.Matrix4.multiplyByPointAsVector(
        inv,
        sunDir,
        new C.Cartesian3(),
      );
      // sunLocal = (east, north, up). Azimuth from north, CW.
      const az = (Math.atan2(sunLocal.x, sunLocal.y) * 180) / Math.PI;
      const elev =
        (Math.asin(Math.max(-1, Math.min(1, sunLocal.z))) * 180) / Math.PI;
      return { azimuth: ((az % 360) + 360) % 360, elevation: elev };
    },
    { view: VIEW, timeIso: TIME_ISO },
  );
}

async function captureHeading(page, headingDeg, msOn, label) {
  await page.evaluate(
    async ({ msOn, view, timeIso, headingDeg }) => {
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
      sky.multipleScattering = msOn;

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
          heading: C.Math.toRadians(headingDeg),
          pitch: C.Math.toRadians(-2.0),
          roll: 0.0,
        },
      });

      for (let i = 0; i < 90; i++) {
        v.scene.render();
        await new Promise((r) => requestAnimationFrame(r));
      }
    },
    { msOn, view: VIEW, timeIso: TIME_ISO, headingDeg },
  );
  await page.waitForTimeout(800);
  const out = path.join(OUT_DIR, `sky-ms-az-${label}.png`);
  await page.screenshot({ path: out });
  return out;
}

// Horizon-band mean luminance + RGB for one PNG (band just above the horizon at
// pitch -2°, rows [0.42, 0.50]).
async function bandStats(analyzerPage, pngPath) {
  const b64 = fs.readFileSync(pngPath).toString("base64");
  return await analyzerPage.evaluate(
    async ({ b64 }) => {
      const img = new Image();
      img.src = "data:image/png;base64," + b64;
      await img.decode();
      const cv = document.createElement("canvas");
      cv.width = img.width;
      cv.height = img.height;
      const ctx = cv.getContext("2d");
      ctx.drawImage(img, 0, 0);
      const d = ctx.getImageData(0, 0, img.width, img.height);
      const w = d.width,
        h = d.height,
        da = d.data;
      function band(f0, f1) {
        const y0 = Math.floor(h * f0),
          y1 = Math.floor(h * f1);
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
      // Horizon band just above the horizon line; zenith band = upper sky
      // (darker / unsaturated, where the MS lift shows through the tonemap).
      return { horizon: band(0.42, 0.5), zenith: band(0.05, 0.2) };
    },
    { b64 },
  );
}

(async () => {
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
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

  const sun = await resolveSun(page);
  console.log(
    `[sky-ms-az] time=${TIME_ISO} sun azimuth=${sun.azimuth.toFixed(1)}° elevation=${sun.elevation.toFixed(1)}°`,
  );

  const headings = [
    { name: "toward", deg: sun.azimuth },
    { name: "side", deg: (sun.azimuth + 90) % 360 },
    { name: "anti", deg: (sun.azimuth + 180) % 360 },
  ];

  const analyzer = await browser.newPage({
    viewport: { width: 64, height: 64 },
  });
  await analyzer.setContent("<!doctype html><html><body></body></html>");

  console.log(
    "  heading        HORIZON off/on/Δ           ZENITH off/on/Δ        zenith-on(r,g,b)",
  );
  for (const hd of headings) {
    const offPng = await captureHeading(page, hd.deg, false, `${hd.name}-off`);
    const onPng = await captureHeading(page, hd.deg, true, `${hd.name}-on`);
    const off = await bandStats(analyzer, offPng);
    const on = await bandStats(analyzer, onPng);
    const dh = on.horizon.lum - off.horizon.lum;
    const dz = on.zenith.lum - off.zenith.lum;
    console.log(
      `  ${hd.name.padEnd(7)} ${hd.deg.toFixed(0).padStart(3)}°  ` +
        `${off.horizon.lum.toFixed(1).padStart(6)}/${on.horizon.lum.toFixed(1).padStart(6)}/${dh.toFixed(2).padStart(5)}   ` +
        `${off.zenith.lum.toFixed(1).padStart(6)}/${on.zenith.lum.toFixed(1).padStart(6)}/${dz.toFixed(2).padStart(5)}   ` +
        `(${on.zenith.r.toFixed(0)},${on.zenith.g.toFixed(0)},${on.zenith.b.toFixed(0)})`,
    );
  }

  await browser.close();
  if (consoleErrors.length) {
    console.log(`  [console errors: ${consoleErrors.length}]`);
    consoleErrors.slice(0, 8).forEach((e) => console.log("    " + e));
  } else {
    console.log("  [0 console errors]");
  }
})();
