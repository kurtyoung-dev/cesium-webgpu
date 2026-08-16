#!/usr/bin/env node
// Batch 438 — atmosphere-physics trio (4.5 SKY-OZONE / 4.6 MIE-PHASE / 4.4 SKY-MOON).
// @purpose Mode-driven acceptance for ozone dusk deepening, improved Mie aureole, and inline moon glow, plus an off-mode pre/post byte-parity baseline.
// @status ACTIVE
//
// Modes (argv[2]):
//   off    — all three flags default-off (PARITY baseline). Run twice across a
//            rebuild (pre/post) and byte-compare → must be byte-identical.
//   ozone  — skyAtmosphere.ozone = true at DUSK (low sun): zenith should deepen
//            toward blue/violet vs the too-cyan Rayleigh-only dusk.
//   mie    — skyAtmosphere.improvedMiePhase = true: near-sun aureole tighter
//            forward peak + slight backscatter vs HG.
//   moon   — skyAtmosphere.dualLightInline = true at NIGHT (sun down, moon up):
//            a soft moon glow appears on the inline (parity) march path.
//
// argv[3] = optional tag (pre/post for the parity byte-compare).
//
//   node Tools/visual-regression/probe-atmo-physics-438.mjs off pre
//   node Tools/visual-regression/probe-atmo-physics-438.mjs off post
//   node Tools/visual-regression/probe-atmo-physics-438.mjs ozone
//   node Tools/visual-regression/probe-atmo-physics-438.mjs mie
//   node Tools/visual-regression/probe-atmo-physics-438.mjs moon

import { chromium } from "playwright";
import fs from "fs";
import path from "path";

const BASE = "http://localhost:8080";
const OUT_DIR = "Tools/visual-regression/output";

const MODE = (process.argv[2] || "off").toLowerCase();
const TAG = process.argv[3] || "";

// Time presets per mode. Dusk for ozone (low sun), night for moon, daytime for
// mie aureole + the parity baseline. Chosen so the effect is at its strongest.
// Times chosen from measured sun/moon elevations over Pittsburgh (lon -80, lat
// 40), see _tmp-azimuth scan:
//   ozone dusk = 01:30Z  sunElev -7.6° (nautical twilight, deep-blue zenith)
//   mie noon   = 18:00Z  sunElev 70°   (sun high → bright near-sun aureole)
//   moon night = 27th 03:00Z  sunElev -21.8° (deep night) + moonElev 22.4° (up)
const TIMES = {
  off: "2026-05-19T18:00:00Z", // mid-afternoon, deterministic daytime sky
  // ozone dusk = 01:00Z sunElev -2.9° (civil twilight — sun just below the
  // horizon: bright enough to read the zenith color, low enough for the long
  // ozone path that deepens it toward blue/violet).
  ozone: "2026-07-15T01:00:00Z",
  duskoff: "2026-07-15T01:00:00Z",
  mie: "2026-07-15T18:00:00Z",
  mieoff: "2026-07-15T18:00:00Z",
  // moon night = 06 Jul 08:00Z: scene frameState reports sunElev -17.8°
  // (deep night) + moonElev 41.5° (moon high up). NOTE: the scene's
  // moonDirectionWC differs markedly from a raw Simon1994 ephemeris calc, so
  // these were found by scanning the actual frameState value, not the ephemeris.
  moon: "2026-07-06T08:00:00Z",
  moonoff: "2026-07-06T08:00:00Z",
};

// Camera heading (deg) per mode — point at the relevant body's azimuth.
//   ozone/duskoff → sunAz 306 (NW twilight glow)
//   mie/mieoff    → sunAz 204 (toward the high sun, pitch up)
//   moon/moonoff  → moonAz 173 (toward the risen moon)
const HEADINGS = {
  off: 270,
  ozone: 306,
  duskoff: 306,
  mie: 204,
  mieoff: 204,
  moon: 173,
  moonoff: 173,
};

// Heading/pitch per mode. ozone/moon look at the horizon; mie looks toward the sun.
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
    async ({ mode, view, timeIso, heading }) => {
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
      // Flags — all default false; flip the one under test.
      sky.ozone = mode === "ozone";
      sky.improvedMiePhase = mode === "mie";
      sky.dualLightInline = mode === "moon";

      // The moon test needs the sky to actually DARKEN at night — in the default
      // NONE dynamic-lighting mode the sky is "lit from directly above" and stays
      // bright daytime-blue regardless of sun position, so a moon glow can't be
      // seen. SUNLIGHT mode uses the true (below-horizon) sun direction so the
      // night sky goes dark; the inline dual-light moon march then shows. The
      // ozone twilight test also reads better with a real sun direction.
      if (
        mode === "moon" ||
        mode === "moonoff" ||
        mode === "ozone" ||
        mode === "duskoff"
      ) {
        v.scene.atmosphere.dynamicLighting =
          C.DynamicAtmosphereLightingType.SUNLIGHT;
      }

      v.scene.globe.showGroundAtmosphere = false;
      v.scene.globe.show = false; // pure sky → deterministic for the byte gate
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

      // Heading points at the relevant body's azimuth (passed in). mie looks up
      // toward the high sun (pitch +18° so the near-sun aureole fills frame); the
      // ozone twilight test looks up toward the zenith (pitch +35°) where the
      // ozone blue/violet deepening shows; the others look just above the horizon.
      const isMie = mode === "mie" || mode === "mieoff";
      const isOzone = mode === "ozone" || mode === "duskoff";
      let pitchDeg = -1.0;
      if (isMie) {
        pitchDeg = 18.0;
      } else if (isOzone) {
        pitchDeg = 35.0;
      }
      v.camera.setView({
        destination: C.Cartesian3.fromDegrees(view.lon, view.lat, view.height),
        orientation: {
          heading: C.Math.toRadians(heading),
          pitch: C.Math.toRadians(pitchDeg),
          roll: 0.0,
        },
      });

      for (let i = 0; i < 120; i++) {
        v.scene.render();
        await new Promise((r) => requestAnimationFrame(r));
      }

      // For the moon modes, re-aim the camera at the ACTUAL moon position (the
      // scene's frameState.moonDirectionWC, which differs from a raw ephemeris
      // calc), then render a few more frames so the screenshot frames the glow.
      if (mode === "moon" || mode === "moonoff") {
        const fs = v.scene._frameState ?? v.scene.frameState;
        const md = fs?.moonDirectionWC;
        const sd = fs?.sunDirectionWC;
        const upWC = C.Cartesian3.normalize(
          C.Cartesian3.fromDegrees(view.lon, view.lat, 0),
          new C.Cartesian3(),
        );
        if (md) {
          const moonElev =
            90 -
            (Math.acos(Math.max(-1, Math.min(1, C.Cartesian3.dot(md, upWC)))) *
              180) /
              Math.PI;
          const sunElev = sd
            ? 90 -
              (Math.acos(
                Math.max(-1, Math.min(1, C.Cartesian3.dot(sd, upWC))),
              ) *
                180) /
                Math.PI
            : 999;
          window.__moonElev = moonElev;
          window.__sunElev = sunElev;
          // Aim the camera straight at the moon direction.
          const camPos = C.Cartesian3.fromDegrees(
            view.lon,
            view.lat,
            view.height,
          );
          v.camera.setView({
            destination: camPos,
            orientation: {
              direction: md,
              up: upWC,
            },
          });
          for (let i = 0; i < 30; i++) {
            v.scene.render();
            await new Promise((r) => requestAnimationFrame(r));
          }
        }
      }
    },
    {
      mode,
      view: VIEW,
      timeIso: TIMES[mode] ?? TIMES.off,
      heading: HEADINGS[mode] ?? 270,
    },
  );
  const elev = await page.evaluate(() => ({
    moonElev: window.__moonElev,
    sunElev: window.__sunElev,
  }));
  if (elev.moonElev !== undefined) {
    console.log(
      `  moonElev=${elev.moonElev?.toFixed(1)} sunElev=${elev.sunElev?.toFixed(1)}`,
    );
  }
  await page.waitForTimeout(1200);
  const label = tag ? `${mode}-${tag}` : mode;
  const out = path.join(OUT_DIR, `atmo438-${label}.png`);
  await page.screenshot({ path: out });
  await browser.close();
  if (consoleErrors.length) {
    console.log(`  [console errors: ${consoleErrors.length}]`);
    consoleErrors.slice(0, 8).forEach((e) => console.log("    " + e));
  } else {
    console.log("  [0 console errors]");
  }
  return out;
}

// Region stats + optional byte-diff vs a reference PNG.
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
      const zn = [Math.floor(h * 0.05), Math.floor(h * 0.18)]; // zenith band
      const hz = [Math.floor(h * 0.42), Math.floor(h * 0.5)]; // near-horizon
      const cn = [Math.floor(h * 0.3), Math.floor(h * 0.45)]; // center (near-sun)
      function band(y0, y1) {
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
        return {
          lum: sum / n,
          r: rS / n,
          g: gS / n,
          b: bS / n,
        };
      }
      const out = {
        zenith: band(zn[0], zn[1]),
        horizon: band(hz[0], hz[1]),
        center: band(cn[0], cn[1]),
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
  console.log(`[atmo438] mode=${MODE}${TAG ? ` tag=${TAG}` : ""}`);
  const png = await capture(MODE, TAG);
  // For the `off` parity post pass, byte-diff against the `off-pre` baseline.
  let ref = null;
  if (MODE === "off" && TAG === "post") {
    ref = path.join(OUT_DIR, "atmo438-off-pre.png");
    if (!fs.existsSync(ref)) ref = null;
  }
  const s = await analyze(png, ref);
  const f = (x) => x.toFixed(2);
  console.log(
    `  zenith  lum=${f(s.zenith.lum)} (r=${f(s.zenith.r)} g=${f(s.zenith.g)} b=${f(s.zenith.b)})`,
  );
  console.log(
    `  horizon lum=${f(s.horizon.lum)} (r=${f(s.horizon.r)} g=${f(s.horizon.g)} b=${f(s.horizon.b)})`,
  );
  console.log(
    `  center  lum=${f(s.center.lum)} (r=${f(s.center.r)} g=${f(s.center.g)} b=${f(s.center.b)})`,
  );
  if (s.diff) {
    console.log(
      `  PARITY DIFF vs off-pre: mismatchPct=${s.diff.mismatchPct.toFixed(4)}% ` +
        `meanDelta=${s.diff.meanDelta.toFixed(4)} maxDelta=${s.diff.maxDelta} ` +
        `(${s.diff.mismatch}/${s.diff.total} px)`,
    );
  }
  console.log(`  PNG: ${png}`);
})();
