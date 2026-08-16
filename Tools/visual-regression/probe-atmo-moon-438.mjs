#!/usr/bin/env node
// Batch 438 — 4.4 SKY-MOON dedicated probe.
// @purpose Finds a real moonlit night via ICRF scan, then asserts dualLightInline ON gives clear moon-glow luminance vs OFF on the inline sky march.
// @status ACTIVE
//
// The moon glow on the inline (parity) march path only shows when the scene's
// frameState.moonDirectionWC actually has the moon ABOVE the local horizon while
// the sun is below it (a real moonlit night). That direction depends on ICRF
// data that loads async, so this probe:
//   1. preloads ICRF for the scan window,
//   2. scans candidate night times (rendering with rAF so frameState updates),
//   3. picks the first time with sunElev < -8 AND moonElev > 20,
//   4. captures the inline sky with dualLightInline ON and OFF at that time,
//      camera aimed straight at the moon, and reports the center luminance.
//
// PASS = moon ON center luminance clearly > moon OFF (which is ~0, dark night).

import { chromium } from "playwright";
import fs from "fs";
import path from "path";

const BASE = "http://localhost:8080";
const OUT_DIR = "Tools/visual-regression/output";

async function run(moonOn) {
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

  const result = await page.evaluate(async (moonOn) => {
    const C = await import("/Build/CesiumUnminified/index.js");
    const v = window.viewer;
    const lon = -80,
      lat = 40;
    const up = C.Cartesian3.normalize(
      C.Cartesian3.fromDegrees(lon, lat, 0),
      new C.Cartesian3(),
    );

    // Preload ICRF so moonDirectionWC is correct (not the fallback transform —
    // the fallback gives wrong moon positions that look favorable but aren't).
    // Winter window: the full moon rides high at night at 40°N, so genuine
    // moonlit-night times exist (none did in July with correct ICRF).
    const start = C.JulianDate.fromIso8601("2026-01-01T00:00:00Z");
    const stop = C.JulianDate.fromIso8601("2026-01-15T00:00:00Z");
    try {
      await C.Transforms.preloadIcrfFixed(new C.TimeInterval({ start, stop }));
    } catch (e) {
      /* fallback transform still works, just less accurate */
    }

    const sky = v.scene.skyAtmosphere;
    sky.show = true;
    sky._webgpuFullscreen = true;
    sky.dualLightInline = moonOn;
    v.scene.atmosphere.dynamicLighting =
      C.DynamicAtmosphereLightingType.SUNLIGHT;
    v.scene.globe.show = false;
    v.scene.fog.enabled = false;
    v.scene.skyBox.show = false;
    v.scene.sun.show = false;
    // Moon.update only publishes frameState.moonDirectionWC when the moon is
    // SHOWN — with moon.show = false the direction freezes at its initial value
    // (the bug that made every scanned time report the same moonElev). Keep it
    // shown so the ephemeris advances; the tiny moon billboard doesn't affect
    // the sky-region luminance measurement.
    v.scene.moon.show = true;
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
      destination: C.Cartesian3.fromDegrees(lon, lat, 200),
      orientation: { heading: 0, pitch: C.Math.toRadians(45), roll: 0 },
    });

    // Scan for a moon-up, sun-down time using the ACTUAL frameState value.
    let chosen = null;
    for (let d = 1; d <= 12 && !chosen; d++) {
      for (let h = 0; h < 24; h += 2) {
        const iso = `2026-01-${String(d).padStart(2, "0")}T${String(h).padStart(2, "0")}:00:00Z`;
        const t = C.JulianDate.fromIso8601(iso);
        v.clock.currentTime = t.clone();
        v.clock.shouldAnimate = false;
        v.clock.multiplier = 0;
        v.scene.render();
        await new Promise((r) => requestAnimationFrame(r));
        v.scene.render();
        await new Promise((r) => requestAnimationFrame(r));
        const fsx = v.scene._frameState ?? v.scene.frameState;
        const md = fsx?.moonDirectionWC;
        const sd = fsx?.sunDirectionWC;
        if (!md || !sd) continue;
        const me =
          90 -
          (Math.acos(Math.max(-1, Math.min(1, C.Cartesian3.dot(md, up)))) *
            180) /
            Math.PI;
        const se =
          90 -
          (Math.acos(Math.max(-1, Math.min(1, C.Cartesian3.dot(sd, up)))) *
            180) /
            Math.PI;
        if (!window.__scanLog) window.__scanLog = [];
        if (window.__scanLog.length < 6)
          window.__scanLog.push(
            `${iso} se=${se.toFixed(1)} me=${me.toFixed(1)}`,
          );
        if (se < -8 && me > 20) {
          chosen = { iso, moonElev: me, sunElev: se };
          break;
        }
      }
    }
    if (!chosen)
      return {
        error: "no moon-up sun-down time found",
        scanLog: window.__scanLog,
      };

    // Pin the chosen time and aim straight at the moon.
    const t = C.JulianDate.fromIso8601(chosen.iso);
    v.clock.currentTime = t.clone();
    v.clock.startTime = t.clone();
    v.clock.stopTime = t.clone();
    v.clock.shouldAnimate = false;
    v.clock.multiplier = 0;
    for (let i = 0; i < 30; i++) {
      v.scene.render();
      await new Promise((r) => requestAnimationFrame(r));
    }
    const fsx = v.scene._frameState ?? v.scene.frameState;
    const md = fsx.moonDirectionWC;
    v.camera.setView({
      destination: C.Cartesian3.fromDegrees(lon, lat, 200),
      orientation: { direction: md, up: up },
    });
    for (let i = 0; i < 40; i++) {
      v.scene.render();
      await new Promise((r) => requestAnimationFrame(r));
    }

    // Re-confirm moon elevation at capture time.
    const md2 = (v.scene._frameState ?? v.scene.frameState).moonDirectionWC;
    const sd2 = (v.scene._frameState ?? v.scene.frameState).sunDirectionWC;
    const me2 =
      90 -
      (Math.acos(Math.max(-1, Math.min(1, C.Cartesian3.dot(md2, up)))) * 180) /
        Math.PI;
    const se2 =
      90 -
      (Math.acos(Math.max(-1, Math.min(1, C.Cartesian3.dot(sd2, up)))) * 180) /
        Math.PI;

    // Sample center 120×120 of the canvas (where the moon now sits).
    const cv = v.scene.canvas;
    const tmp = document.createElement("canvas");
    tmp.width = cv.width;
    tmp.height = cv.height;
    const ctx = tmp.getContext("2d");
    ctx.drawImage(cv, 0, 0);
    const cx = Math.floor(cv.width / 2),
      cy = Math.floor(cv.height / 2);
    const dd = ctx.getImageData(cx - 60, cy - 60, 120, 120).data;
    let r = 0,
      g = 0,
      b = 0,
      n = 0,
      maxc = 0;
    for (let i = 0; i < dd.length; i += 4) {
      r += dd[i];
      g += dd[i + 1];
      b += dd[i + 2];
      maxc = Math.max(maxc, dd[i], dd[i + 1], dd[i + 2]);
      n++;
    }
    return {
      iso: chosen.iso,
      moonElev: me2,
      sunElev: se2,
      meanR: r / n,
      meanG: g / n,
      meanB: b / n,
      maxChannel: maxc,
    };
  }, moonOn);

  const label = moonOn ? "on" : "off";
  await page.screenshot({
    path: path.join(OUT_DIR, `atmo438-moon-${label}.png`),
  });
  await browser.close();
  return { result, errs: errs.length };
}

(async () => {
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
  for (const moonOn of [false, true]) {
    const { result, errs } = await run(moonOn);
    const lbl = moonOn ? "ON " : "OFF";
    if (result.error) {
      console.log(`[moon ${lbl}] ERROR: ${result.error} (errs=${errs})`);
      if (result.scanLog)
        result.scanLog.forEach((l) => console.log("    scan: " + l));
      continue;
    }
    console.log(
      `[moon ${lbl}] iso=${result.iso} moonElev=${result.moonElev.toFixed(1)} sunElev=${result.sunElev.toFixed(1)} | ` +
        `center mean rgb=(${result.meanR.toFixed(2)},${result.meanG.toFixed(2)},${result.meanB.toFixed(2)}) maxCh=${result.maxChannel} errs=${errs}`,
    );
  }
})();
