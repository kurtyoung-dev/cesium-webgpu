#!/usr/bin/env node
/**
 * CLOUD-SHADOWS parity probe (Batch 437 — 4.1 CLOUD-SHADOWS).
 *
 * Captures the THREE default render paths that the cloud-shadow consumers touch,
 * with the feature at its DEFAULT-OFF state (globe.defaultCloudCollection.volumetric.cloudCastShadows=false,
 * atmosphericConditions.volumetricFog.cloudShadowHiFi=false). Each MUST be
 * byte-identical between the stash-reverted main build (PARITY_TAG=main) and the
 * modified build (PARITY_TAG=modified) — default-off renders no shadow map and all
 * consumers read a 1x1-white (transmittance=1) placeholder, so the off path is
 * byte-unchanged.
 *
 *   a) globe-terrain  — lit terrain under the sun, clouds OFF, cloudCastShadows OFF
 *   b) aerial         — aerial-perspective post-process ON, cloudCastShadows OFF
 *   c) fog            — volumetric fog ON, cloudShadowHiFi OFF (local-fbm path stays)
 *
 * Output: output/cloud-shadows/parity-<scene>-<TAG>.png
 *
 * Usage:
 *   PARITY_TAG=main     node Tools/visual-regression/probe-cloud-shadows-parity.mjs
 *   PARITY_TAG=modified node Tools/visual-regression/probe-cloud-shadows-parity.mjs
 */
import { chromium } from "playwright";

const BASE = process.env.PROBE_BASE || "http://localhost:8080";
const TAG = process.env.PARITY_TAG || "tag";

// A lit-terrain saved view with the sun up so the diffuse term is non-trivial
// (so a cloud-shadow multiply, if it leaked, would move pixels). Pittsburgh-ish,
// looking across terrain with sun mid-sky.
const CAMERA = {
  lon: -109.5,
  lat: 38.5,
  height: 6000,
  heading: 30,
  pitch: -18,
};
const TIME_ISO = "2026-06-21T17:00:00Z";

const SCENES = {
  // (a) lit ground terrain, no clouds, no aerial, no fog
  terrain: (g, s) => {
    s.skyAtmosphere.show = true;
    s.globe.show = true;
    s.globe.enableLighting = true;
    g.defaultCloudCollection.enableVolumetric = false;
    if ("cloudCastShadows" in g)
      g.defaultCloudCollection.volumetric.cloudCastShadows = false;
  },
  // (b) aerial perspective on
  aerial: (g, s, ac) => {
    s.globe.show = true;
    s.globe.enableLighting = true;
    g.defaultCloudCollection.enableVolumetric = false;
    if ("cloudCastShadows" in g)
      g.defaultCloudCollection.volumetric.cloudCastShadows = false;
    if (ac) {
      ac.aerialPerspective = ac.aerialPerspective || {};
      ac.aerialPerspective.enabled = true;
    }
  },
  // (c) volumetric fog on, hi-fi cloud shadow OFF (keeps local-fbm path)
  fog: (g, s, ac) => {
    s.globe.show = true;
    s.globe.enableLighting = true;
    g.defaultCloudCollection.enableVolumetric = false;
    if ("cloudCastShadows" in g)
      g.defaultCloudCollection.volumetric.cloudCastShadows = false;
    if (ac) {
      ac.volumetricFog = ac.volumetricFog || {};
      ac.volumetricFog.enabled = true;
      ac.volumetricFog.density = 0.0008;
      if ("cloudShadowHiFi" in ac.volumetricFog)
        ac.volumetricFog.cloudShadowHiFi = false;
    }
  },
};

(async () => {
  const fs = await import("fs");
  fs.mkdirSync("Tools/visual-regression/output/cloud-shadows", {
    recursive: true,
  });
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

  for (const sceneName of Object.keys(SCENES)) {
    const dataUrl = await page.evaluate(
      async ({ sceneName, camera, timeIso }) => {
        const v = window.viewer,
          s = v.scene,
          g = s.globe;
        const C = await import("/Build/CesiumUnminified/index.js");
        const ac = s._frameState ? s._frameState.atmosphericConditions : null;
        v.clock.shouldAnimate = false;
        v.clock.currentTime = C.JulianDate.fromIso8601(timeIso);
        // Reset cross-scene state to a known baseline.
        g.defaultCloudCollection.enableVolumetric = false;
        if (ac && ac.volumetricFog) ac.volumetricFog.enabled = false;
        if (ac && ac.aerialPerspective) ac.aerialPerspective.enabled = false;
        // Apply this scene's setup. The applier closures are defined on the
        // host side; re-create them here as a string-keyed switch.
        const setups = {
          terrain: () => {
            s.skyAtmosphere.show = true;
            s.globe.show = true;
            s.globe.enableLighting = true;
            g.defaultCloudCollection.enableVolumetric = false;
            if ("cloudCastShadows" in g)
              g.defaultCloudCollection.volumetric.cloudCastShadows = false;
          },
          aerial: () => {
            s.globe.show = true;
            s.globe.enableLighting = true;
            g.defaultCloudCollection.enableVolumetric = false;
            if ("cloudCastShadows" in g)
              g.defaultCloudCollection.volumetric.cloudCastShadows = false;
            if (ac) {
              ac.aerialPerspective = ac.aerialPerspective || {};
              ac.aerialPerspective.enabled = true;
            }
          },
          fog: () => {
            s.globe.show = true;
            s.globe.enableLighting = true;
            g.defaultCloudCollection.enableVolumetric = false;
            if ("cloudCastShadows" in g)
              g.defaultCloudCollection.volumetric.cloudCastShadows = false;
            if (ac) {
              ac.volumetricFog = ac.volumetricFog || {};
              ac.volumetricFog.enabled = true;
              ac.volumetricFog.density = 0.0008;
              if ("cloudShadowHiFi" in ac.volumetricFog)
                ac.volumetricFog.cloudShadowHiFi = false;
            }
          },
        };
        setups[sceneName]();
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
        // Determinism: render until the globe reports all tiles loaded (with a
        // generous cap), THEN a fixed settle, so imagery/terrain streaming has
        // converged to the same image every run (the parity diff demands it).
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
      { sceneName, camera: CAMERA, timeIso: TIME_ISO },
    );
    const b64 = dataUrl.split(",")[1];
    const path = `Tools/visual-regression/output/cloud-shadows/parity-${sceneName}-${TAG}.png`;
    fs.writeFileSync(path, Buffer.from(b64, "base64"));
    console.log(`[parity:${TAG}] wrote ${path}`);
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
