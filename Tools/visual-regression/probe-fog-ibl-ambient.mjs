#!/usr/bin/env node
// Probe: improvement-plan 2.4 — FOG-IBL-AMBIENT (Batch 431).
// @purpose Opt-in sky-LUT/IBL fog ambient: warms at low sun, neutral/brighter at high sun; a human reads the PNGs and band stats.
// @status ACTIVE
//
// Verifies the WebGPU froxel volumetric-fog renderer's opt-in sky-LUT /
// IBL-driven fog ambient. With `atmosphericConditions.volumetricFog.iblAmbient`
// ON, the scattering kernel replaces the flat-constant fog ambient with a
// sample of the Bruneton TRANSMITTANCE LUT at (froxel altitude, view-up along
// the sun) tinted by the atmosphere-derived SH-L2 probe. Result: at LOW sun the
// fog ambient warms (reddened low sky), at HIGH sun it stays neutral/brighter.
//
// Captures (WebGPU only, volumetric fog ENABLED in every capture so we isolate
// ONLY the iblAmbient toggle / sun elevation):
//
//   off       — iblAmbient = false (parity default). The flat-constant ambient.
//   on-low    — iblAmbient = true, sun LOW (sunset). Ambient should warm.
//   on-high   — iblAmbient = true, sun HIGH (noon). Ambient should be neutral/
//               brighter.
//
// Pass criteria (HUMAN reads the PNGs + the printed RGB stats):
//   - on-low vs off: a visible color shift in the fog band (warmer — R up
//     relative to B), tracking the low sun, no blowout / banding.
//   - on-high vs on-low: brighter / cooler (more neutral), tracking time of day.
//
// The off=byte-identical PARITY check is done separately by the coordinator via
// git stash (rebuild main → capture off; restore → rebuild → capture off; the
// two off frames must be pixel-identical). This probe's job is the FLAG-ON look.
//
// Usage:  node Tools/visual-regression/probe-fog-ibl-ambient.mjs
// Outputs: output/fog-ibl-{off,on-low,on-high}-webgpu.png
//
// Do NOT run automatically — the human runs it and reads the band stats.

import { chromium } from "playwright";
import fs from "fs";
import path from "path";

const BASE = "http://localhost:8080";
const OUT_DIR = "Tools/visual-regression/output";

// `settings` = { iblAmbient: boolean, sunHigh: boolean }.
async function capture(label, settings) {
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
    viewport: { width: 1280, height: 720 },
  });
  const messages = [];
  page.on("console", (m) => messages.push({ t: m.type(), text: m.text() }));
  page.on("pageerror", (e) =>
    messages.push({ t: "pageerror", text: e.message }),
  );

  await page.goto(`${BASE}/Apps/CesiumViewer/index.html?renderer=webgpu`, {
    waitUntil: "networkidle",
  });
  await page.waitForFunction(() => !!window.viewer);

  const echo = await page.evaluate(
    async ({ settings }) => {
      const C = await import("/Build/CesiumUnminified/index.js");
      const v = window.viewer;
      const scene = v.scene;
      const ac = scene.globe.atmosphericConditions;

      v.clock.shouldAnimate = false;
      // LOW sun (sunset) ≈ 17:30 UTC over 10.5°E, HIGH sun ≈ 11:00 UTC.
      v.clock.currentTime = settings.sunHigh
        ? C.JulianDate.fromIso8601("2026-06-21T11:00:00Z")
        : C.JulianDate.fromIso8601("2026-06-21T17:40:00Z");

      // LOW oblique camera over the Alps looking north toward the horizon, so
      // the fog band fills the lower-mid frame and the sky fills the top.
      v.camera.setView({
        destination: C.Cartesian3.fromDegrees(10.5, 46.4, 3500),
        orientation: {
          heading: C.Math.toRadians(0),
          pitch: C.Math.toRadians(-8),
          roll: 0,
        },
      });

      // Volumetric fog ENABLED in every capture (we isolate only iblAmbient).
      // A moderate base density + high falloff so the fog is a visible haze
      // band rather than an opaque whiteout.
      ac.volumetricFog.enabled = true;
      ac.volumetricFog.density = 1.0;
      ac.volumetricFog.falloff = 0.0008;
      ac.volumetricFog.maxDistance = 40000;
      ac.volumetricFog.ambientStrength = 0.5;
      // The toggle under test.
      ac.volumetricFog.iblAmbient = settings.iblAmbient === true;

      for (let i = 0; i < 420; i++) {
        scene.render();
        await new Promise((r) => requestAnimationFrame(r));
        if (scene.globe.tilesLoaded && i > 140) break;
      }

      return {
        iblAmbient: ac.volumetricFog.iblAmbient,
        volumetricFogEnabled: ac.volumetricFog.enabled,
        sunHigh: settings.sunHigh === true,
      };
    },
    { settings },
  );
  await page.waitForTimeout(1500);

  const out = path.join(OUT_DIR, `fog-ibl-${label}-webgpu.png`);
  await page.screenshot({ path: out, fullPage: false });
  await browser.close();

  const errs = messages.filter((m) => m.t === "error" || m.t === "pageerror");
  return { out, echo, errors: errs };
}

// Decode two PNGs and compare the mean RGB of the fog band (middle 40% of
// rows — terrain+haze, avoiding the pure-sky top and pure-ground bottom).
// Returns mean R/G/B for each + the warm-shift (R−B) delta. Uses Playwright's
// canvas decode (no Node PNG dep).
async function bandRGB(a, b, labelA, labelB) {
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
      const A = await decode(ba);
      const B = await decode(bb);
      if (A.w !== B.w || A.h !== B.h) return { error: "size mismatch" };
      // Fog band = middle 40% of rows (rows 0.4h .. 0.8h).
      const y0 = Math.floor(A.h * 0.4);
      const y1 = Math.floor(A.h * 0.8);
      const mean = (D) => {
        let r = 0,
          g = 0,
          bl = 0,
          n = 0;
        for (let y = y0; y < y1; y++) {
          for (let x = 0; x < A.w; x++) {
            const i = (y * A.w + x) * 4;
            r += D[i];
            g += D[i + 1];
            bl += D[i + 2];
            n++;
          }
        }
        return { r: r / n, g: g / n, b: bl / n };
      };
      // Also count any fully-saturated (blown-out) pixels in the band.
      const blown = (D) => {
        let c = 0,
          n = 0;
        for (let y = y0; y < y1; y++) {
          for (let x = 0; x < A.w; x++) {
            const i = (y * A.w + x) * 4;
            if (D[i] >= 254 && D[i + 1] >= 254 && D[i + 2] >= 254) c++;
            n++;
          }
        }
        return (100 * c) / n;
      };
      const mA = mean(A.data);
      const mB = mean(B.data);
      return {
        A: {
          r: mA.r.toFixed(1),
          g: mA.g.toFixed(1),
          b: mA.b.toFixed(1),
          warmRB: (mA.r - mA.b).toFixed(1),
          blownPct: blown(A.data).toFixed(2),
        },
        B: {
          r: mB.r.toFixed(1),
          g: mB.g.toFixed(1),
          b: mB.b.toFixed(1),
          warmRB: (mB.r - mB.b).toFixed(1),
          blownPct: blown(B.data).toFixed(2),
        },
        warmShift_BminusA: (mB.r - mB.b - (mA.r - mA.b)).toFixed(1),
        lumShift_BminusA: (
          0.2126 * mB.r +
          0.7152 * mB.g +
          0.0722 * mB.b -
          (0.2126 * mA.r + 0.7152 * mA.g + 0.0722 * mA.b)
        ).toFixed(1),
      };
    },
    { ba, bb },
  );
  await browser.close();
  return { labelA, labelB, ...result };
}

(async () => {
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
  console.log("[probe-fog-ibl-ambient] FOG-IBL-AMBIENT (Batch 431)");

  const off = await capture("off", { iblAmbient: false, sunHigh: false });
  console.log(`  off:     ${off.out} (${off.errors.length} errors)`);
  console.log(`           echo: ${JSON.stringify(off.echo)}`);

  const onLow = await capture("on-low", { iblAmbient: true, sunHigh: false });
  console.log(`  on-low:  ${onLow.out} (${onLow.errors.length} errors)`);
  console.log(`           echo: ${JSON.stringify(onLow.echo)}`);

  const onHigh = await capture("on-high", { iblAmbient: true, sunHigh: true });
  console.log(`  on-high: ${onHigh.out} (${onHigh.errors.length} errors)`);
  console.log(`           echo: ${JSON.stringify(onHigh.echo)}`);

  for (const r of [off, onLow, onHigh]) {
    if (r.errors.length) {
      console.log(`  ${path.basename(r.out)} errors:`);
      r.errors.slice(0, 4).forEach((e) => console.log(`    ${e.t}: ${e.text}`));
    }
  }

  console.log("\n  Fog-band RGB — off (A) vs on-low (B): warm shift expected");
  console.log(
    "   ",
    JSON.stringify(await bandRGB(off.out, onLow.out, "off", "on-low")),
  );
  console.log(
    "\n  Fog-band RGB — on-low (A) vs on-high (B): brighter/cooler expected",
  );
  console.log(
    "   ",
    JSON.stringify(await bandRGB(onLow.out, onHigh.out, "on-low", "on-high")),
  );

  console.log("\nManual checks (read the PNGs):");
  console.log(
    "  on-low:  fog band reads as warm atmospheric haze (sky-tinted),",
  );
  console.log(
    "           warmer than off; no over-bright blowout, no SH banding.",
  );
  console.log("  on-high: fog band brighter / more neutral than on-low.");
  console.log("  off:     unchanged flat-grey haze (parity baseline).");
  console.log("[probe-fog-ibl-ambient] done");
})();
