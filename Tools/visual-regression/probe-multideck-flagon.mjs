#!/usr/bin/env node
/**
 * CLOUD-MULTIDECK flag-on probe (Batch 443 — item 4.9 CLOUD-MULTIDECK).
 *
 * Captures the SAME view with multiDeck OFF and multiDeck ON so the stacked-deck
 * effect is directly comparable:
 *   - OFF: one shell [cloudLayerBottom=1500, cloudLayerTop=4000] (today's single deck)
 *   - ON:  three shells from CloudTypeProfile.CloudDeck.bounds — LOW [0,2km],
 *          MID [2,7km], HIGH [5,13km] — composited front-to-back. A LOW cumulus
 *          layer should read BENEATH a HIGH cirrus veil (correct depth ordering),
 *          no z-fighting, no double-darkening seam at the deck boundaries.
 *
 * The camera is below the decks at a shallow pitch so the shells separate by
 * altitude across the frame (near/low band vs far/high band). cloudCoverage is
 * moderate so the decks read as distinct layers, not a solid overcast blob.
 *
 * Output: output/multideck/flagon-off.png, flagon-on.png
 *
 * Usage: node Tools/visual-regression/probe-multideck-flagon.mjs
 */
import { chromium } from "playwright";

const BASE = process.env.PROBE_BASE || "http://localhost:8080";
const CAMERA = { lon: -100.0, lat: 36.0, height: 1200, heading: 30, pitch: 6 };
const TIME_ISO = "2026-06-21T17:00:00Z";

async function capture(page, multiDeck) {
  return page.evaluate(
    async ({ camera, timeIso, multiDeck }) => {
      const v = window.viewer,
        s = v.scene,
        g = s.globe;
      const C = await import("/Build/CesiumUnminified/index.js");
      v.clock.shouldAnimate = false;
      v.clock.currentTime = C.JulianDate.fromIso8601(timeIso);
      s.skyAtmosphere.show = true;
      s.globe.show = true;
      s.globe.enableLighting = true;
      g.defaultCloudCollection.enableVolumetric = true;
      g.defaultCloudCollection.volumetric.cloudVolumetricQuality = "high"; // cinematic full-res for a clean read
      g.defaultCloudCollection.volumetric.cloudCoverage = 0.5;
      if ("cloudMultiDeck" in g)
        g.defaultCloudCollection.volumetric.cloudMultiDeck = multiDeck;
      v.camera.setView({
        destination: C.Cartesian3.fromDegrees(
          camera.lon,
          camera.lat,
          camera.height,
        ),
        orientation: {
          heading: C.Math.toRadians(camera.heading),
          pitch: C.Math.toRadians(camera.pitch),
          roll: 0.0,
        },
      });
      let loadedStreak = 0;
      for (let i = 0; i < 1200; i++) {
        s.render();
        await new Promise((r) => requestAnimationFrame(r));
        if (g.tilesLoaded === true) {
          loadedStreak++;
          if (loadedStreak > 60) break;
        } else {
          loadedStreak = 0;
        }
      }
      for (let i = 0; i < 60; i++) {
        s.render();
        await new Promise((r) => requestAnimationFrame(r));
      }
      return s.canvas.toDataURL("image/png");
    },
    { camera: CAMERA, timeIso: TIME_ISO, multiDeck },
  );
}

(async () => {
  const fs = await import("fs");
  fs.mkdirSync("Tools/visual-regression/output/multideck", { recursive: true });
  const browser = await chromium.launch({
    channel: "msedge",
    headless: true,
    args: ["--enable-unsafe-webgpu"],
  });
  const page = await browser.newPage({
    viewport: { width: 1024, height: 768 },
  });
  const errs = [];
  page.on("console", (m) => {
    if (m.type() === "error") errs.push(m.text());
  });
  await page.goto(`${BASE}/Apps/CesiumViewer/index.html?renderer=webgpu`, {
    waitUntil: "networkidle",
    timeout: 90_000,
  });
  await page.waitForFunction(() => !!window.viewer, { timeout: 90_000 });

  for (const [tag, md] of [
    ["off", false],
    ["on", true],
  ]) {
    const dataUrl = await capture(page, md);
    const b64 = dataUrl.split(",")[1];
    const path = `Tools/visual-regression/output/multideck/flagon-${tag}.png`;
    fs.writeFileSync(path, Buffer.from(b64, "base64"));
    console.log(`[flagon:${tag}] wrote ${path}`);
  }

  await browser.close();
  const newErrs = errs.filter(
    (e) => !/AtmosphereLUT|default layout|favicon/.test(e),
  );
  console.log(
    newErrs.length
      ? `NEW errs: ${newErrs.slice(0, 4).join(" | ")}`
      : "no new console errors",
  );
})();
