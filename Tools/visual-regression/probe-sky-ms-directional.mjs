#!/usr/bin/env node
// Batch 429 — decisive RENDER-level directionality check for the all-azimuth MS
// add. Looks ALONG the horizon perpendicular to the sun azimuth, so the
// LEFT half of the frame faces toward the sun and the RIGHT half faces anti-sun
// (or vice-versa). Captures multipleScattering OFF then ON and reports the
// horizon-band luminance of the SUN-SIDE half vs the ANTI-SUN-SIDE half, off
// and on. After Batch 429 the ON add must raise the SUN-SIDE half MORE than the
// anti-side half — a directional lift, not a flat veil. Also saves the OFF/ON
// PNGs for a visual read.
//
//   node Tools/visual-regression/probe-sky-ms-directional.mjs
//   SKY_MS_TIME=2026-05-19T22:00:00Z node ...   (higher sun)

import { chromium } from "playwright";
import fs from "fs";
import path from "path";

const BASE = "http://localhost:8080";
const OUT_DIR = "Tools/visual-regression/output";
const TIME_ISO = process.env.SKY_MS_TIME || "2026-05-19T23:30:00Z";
const VIEW = { lon: -80.0, lat: 40.0, height: 200.0 };

async function sunAzimuth(page) {
  return await page.evaluate(
    async ({ view, timeIso }) => {
      const C = await import("/Build/CesiumUnminified/index.js");
      const fixed = C.JulianDate.fromIso8601(timeIso);
      const carto = C.Cartographic.fromDegrees(view.lon, view.lat, view.height);
      const origin = C.Cartographic.toCartesian(carto);
      const enu = C.Transforms.eastNorthUpToFixedFrame(origin);
      const inv = C.Matrix4.inverseTransformation(enu, new C.Matrix4());
      const sunPos =
        C.Simon1994PlanetaryPositions.computeSunPositionInEarthInertialFrame(
          fixed,
          new C.Cartesian3(),
        );
      const icrf = C.Transforms.computeIcrfToFixedMatrix(
        fixed,
        new C.Matrix3(),
      );
      let sunFixed = sunPos;
      if (icrf)
        sunFixed = C.Matrix3.multiplyByVector(icrf, sunPos, new C.Cartesian3());
      const sunDir = C.Cartesian3.normalize(
        C.Cartesian3.subtract(sunFixed, origin, new C.Cartesian3()),
        new C.Cartesian3(),
      );
      const sl = C.Matrix4.multiplyByPointAsVector(
        inv,
        sunDir,
        new C.Cartesian3(),
      );
      const az = (Math.atan2(sl.x, sl.y) * 180) / Math.PI;
      const elev = (Math.asin(Math.max(-1, Math.min(1, sl.z))) * 180) / Math.PI;
      return { azimuth: ((az % 360) + 360) % 360, elevation: elev };
    },
    { view: VIEW, timeIso: TIME_ISO },
  );
}

async function capture(page, headingDeg, msOn, label) {
  await page.evaluate(
    async ({ msOn, view, timeIso, headingDeg }) => {
      const C = await import("/Build/CesiumUnminified/index.js");
      const v = window.viewer;
      const fixed = C.JulianDate.fromIso8601(timeIso);
      v.clock.currentTime = fixed.clone();
      v.clock.startTime = fixed.clone();
      v.clock.stopTime = fixed.clone();
      v.clock.shouldAnimate = false;
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
  const out = path.join(OUT_DIR, `sky-ms-dir-${label}.png`);
  await page.screenshot({ path: out });
  return out;
}

// Mean luminance of the LEFT third and RIGHT third of two bands: the near-
// horizon band (often tonemap-saturated) AND the mid-sky band (upper-middle of
// frame, unsaturated — where the directional MS signal shows through).
async function halves(analyzer, png) {
  const b64 = fs.readFileSync(png).toString("base64");
  return await analyzer.evaluate(
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
      function lumOf(y0, y1, x0, x1) {
        let s = 0,
          n = 0;
        for (let y = y0; y < y1; y++) {
          for (let x = x0; x < x1; x++) {
            const i = (y * w + x) * 4;
            s += 0.2126 * da[i] + 0.7152 * da[i + 1] + 0.0722 * da[i + 2];
            n++;
          }
        }
        return s / n;
      }
      function band(f0, f1) {
        const y0 = Math.floor(h * f0),
          y1 = Math.floor(h * f1);
        return {
          left: lumOf(y0, y1, 0, Math.floor(w / 3)),
          right: lumOf(y0, y1, Math.floor((2 * w) / 3), w),
        };
      }
      // Horizon band just above the horizon; mid-sky band = upper-middle
      // (unsaturated, looking ~30-45° up where azimuth variation is visible).
      return { horizon: band(0.42, 0.5), mid: band(0.18, 0.32) };
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
  const errs = [];
  page.on("console", (m) => {
    if (m.type() === "error") errs.push(m.text());
  });
  await page.goto(`${BASE}/Apps/CesiumViewer/index.html?renderer=webgpu`, {
    waitUntil: "networkidle",
  });
  await page.waitForFunction(() => !!window.viewer);

  const sun = await sunAzimuth(page);
  // Heading 90° CCW from the sun azimuth → sun is off to the LEFT of frame;
  // left-of-frame faces toward the sun, right-of-frame faces anti-sun.
  const heading = (sun.azimuth - 90 + 360) % 360;
  console.log(
    `[sky-ms-dir] time=${TIME_ISO} sun az=${sun.azimuth.toFixed(1)}° elev=${sun.elevation.toFixed(1)}°  heading=${heading.toFixed(1)}° (sun to the LEFT)`,
  );

  const analyzer = await browser.newPage({
    viewport: { width: 64, height: 64 },
  });
  await analyzer.setContent("<!doctype html><html><body></body></html>");

  const offPng = await capture(page, heading, false, "off");
  const onPng = await capture(page, heading, true, "on");
  const off = await halves(analyzer, offPng);
  const on = await halves(analyzer, onPng);

  function report(name, o, n) {
    const dL = n.left - o.left;
    const dR = n.right - o.right;
    console.log(
      `  ${name.padEnd(8)} OFF[sun ${o.left.toFixed(1)} | anti ${o.right.toFixed(1)}]  ON[sun ${n.left.toFixed(1)} | anti ${n.right.toFixed(1)}]  Δ[sun ${dL.toFixed(2)} | anti ${dR.toFixed(2)}]  ratio=${(dR !== 0 ? dL / dR : Infinity).toFixed(2)}`,
    );
  }
  console.log("  LEFT third = sun-side, RIGHT third = anti-sun-side");
  report("HORIZON", off.horizon, on.horizon);
  report("MID-SKY", off.mid, on.mid);
  console.log(`  PNG off: ${offPng}`);
  console.log(`  PNG on : ${onPng}`);
  if (errs.length) {
    console.log(`  [console errors: ${errs.length}]`);
    errs.slice(0, 6).forEach((e) => console.log("    " + e));
  } else {
    console.log("  [0 console errors]");
  }
  await browser.close();
})();
