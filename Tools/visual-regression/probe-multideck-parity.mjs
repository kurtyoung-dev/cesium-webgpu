#!/usr/bin/env node
/**
 * CLOUD-MULTIDECK parity probe (Batch 443 — item 4.9 CLOUD-MULTIDECK).
 *
 * Captures the DEFAULT cloud render — clouds ON, multiDeck OFF, the default
 * (cinematic) full-res tier — which MUST be byte-identical between the
 * stash-reverted main build (PARITY_TAG=main) and the modified build
 * (PARITY_TAG=modified). multiDeck OFF makes the WGSL march EXACTLY ONE shell
 * with cloudLayerBottom/Top + the legacy composite, so the off path is
 * byte-unchanged. This layers ON TOP of the half-res/temporal/morphology batches
 * — captured at the CINEMATIC default tier (renderResScale=1, full-res, no
 * temporal) so the parity diff is deterministic.
 *
 * Output: output/multideck/parity-<TAG>.png
 *
 * Usage:
 *   PARITY_TAG=main     node Tools/visual-regression/probe-multideck-parity.mjs
 *   PARITY_TAG=modified node Tools/visual-regression/probe-multideck-parity.mjs
 */
import { chromium } from "playwright";

const BASE = process.env.PROBE_BASE || "http://localhost:8080";
const TAG = process.env.PARITY_TAG || "tag";

// Camera looking out across a cloud field with the sun up so the lit/shadow
// gradient is non-trivial.
const CAMERA = { lon: -100.0, lat: 36.0, height: 9000, heading: 40, pitch: -8 };
const TIME_ISO = "2026-06-21T17:00:00Z";

(async () => {
  const fs = await import("fs");
  fs.mkdirSync("Tools/visual-regression/output/multideck", { recursive: true });
  const browser = await chromium.launch({
    channel: "msedge",
    headless: true,
    args: ["--enable-unsafe-webgpu"],
  });
  const page = await browser.newPage({ viewport: { width: 1024, height: 768 } });
  const errs = [];
  page.on("console", (m) => {
    if (m.type() === "error") errs.push(m.text());
  });
  await page.goto(`${BASE}/Apps/CesiumViewer/index.html?renderer=webgpu`, {
    waitUntil: "networkidle",
    timeout: 90_000,
  });
  await page.waitForFunction(() => !!window.viewer, { timeout: 90_000 });

  const dataUrl = await page.evaluate(
    async ({ camera, timeIso }) => {
      const v = window.viewer,
        s = v.scene,
        g = s.globe;
      const C = await import("/Build/CesiumUnminified/index.js");
      v.clock.shouldAnimate = false;
      v.clock.currentTime = C.JulianDate.fromIso8601(timeIso);
      s.skyAtmosphere.show = true;
      s.globe.show = true;
      s.globe.enableLighting = true;
      // Clouds ON at the DEFAULT (cinematic, full-res) tier; multiDeck OFF.
      g.defaultCloudCollection.enableVolumetric = true;
      g.defaultCloudCollection.volumetric.cloudVolumetricQuality = "high"; // cinematic → renderResScale=1, no temporal
      g.defaultCloudCollection.volumetric.cloudCoverage = 0.55;
      if ("cloudMultiDeck" in g) g.defaultCloudCollection.volumetric.cloudMultiDeck = false;
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
    { camera: CAMERA, timeIso: TIME_ISO },
  );
  const b64 = dataUrl.split(",")[1];
  const path = `Tools/visual-regression/output/multideck/parity-${TAG}.png`;
  fs.writeFileSync(path, Buffer.from(b64, "base64"));
  console.log(`[parity:${TAG}] wrote ${path}`);

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
