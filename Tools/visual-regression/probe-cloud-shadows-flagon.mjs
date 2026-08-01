#!/usr/bin/env node
/**
 * CLOUD-SHADOWS flag-ON probe (Batch 437 — 4.1 CLOUD-SHADOWS).
 *
 * Procedural clouds ON + globe.defaultCloudCollection.volumetric.cloudCastShadows=true over lit terrain. Captures
 * the canvas so the cloud-shaped ground shadows can be eyeballed against the cloud
 * positions. Also captures a NO-SHADOW twin (cloudCastShadows=false, same scene) so
 * the diff isolates the cast shadow. Optionally pans the sun to confirm shadows
 * track the sun direction.
 *
 * Output:
 *   output/cloud-shadows/flagon-shadows.png    (clouds + cast shadows)
 *   output/cloud-shadows/flagon-noshadow.png   (clouds, no cast shadows)
 *   output/cloud-shadows/flagon-fog-shadows.png (fog + cloudShadowHiFi)
 *
 * Usage:  node Tools/visual-regression/probe-cloud-shadows-flagon.mjs
 */
import { chromium } from "playwright";

const BASE = process.env.PROBE_BASE || "http://localhost:8080";

// High overcast-ish deck + a near-overhead camera looking down at terrain so a
// cloud directly overhead darkens the ground beneath it.
const CAMERA = {
  lon: -109.5,
  lat: 38.5,
  height: 9000,
  heading: 20,
  pitch: -38,
};
const TIME_ISO = "2026-06-21T16:30:00Z";
const PROC = { coverage: 0.55, density: 0.85, bottom: 1500, top: 4200 };

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

  async function capture(mode) {
    return page.evaluate(
      async ({ mode, camera, timeIso, proc }) => {
        const v = window.viewer,
          s = v.scene,
          g = s.globe;
        const C = await import("/Build/CesiumUnminified/index.js");
        const ac = s._frameState ? s._frameState.atmosphericConditions : null;
        s.skyAtmosphere.show = true;
        s.globe.show = true;
        s.globe.enableLighting = true;
        v.clock.shouldAnimate = false;
        v.clock.currentTime = C.JulianDate.fromIso8601(timeIso);
        g.defaultCloudCollection.enableVolumetric = true;
        g.defaultCloudCollection.volumetric.cloudCoverage = proc.coverage;
        g.defaultCloudCollection.volumetric.cloudDensity = proc.density;
        g.defaultCloudCollection.volumetric.cloudLayerBottom = proc.bottom;
        g.defaultCloudCollection.volumetric.cloudLayerTop = proc.top;
        g.defaultCloudCollection.volumetric.cloudVolumetricQuality = "high";
        g.defaultCloudCollection.volumetric.cloudCastShadows =
          mode !== "noshadow";
        if (ac) {
          ac.volumetricFog = ac.volumetricFog || {};
          ac.volumetricFog.enabled = mode === "fog";
          ac.volumetricFog.density = 0.0008;
          ac.volumetricFog.cloudShadowHiFi = mode === "fog";
        }
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
        for (let i = 0; i < 240; i++) {
          s.render();
          await new Promise((r) => requestAnimationFrame(r));
        }
        return s.canvas.toDataURL("image/png");
      },
      { mode, camera: CAMERA, timeIso: TIME_ISO, proc: PROC },
    );
  }

  const out = {
    shadows: "flagon-shadows.png",
    noshadow: "flagon-noshadow.png",
    fog: "flagon-fog-shadows.png",
  };
  for (const mode of Object.keys(out)) {
    const dataUrl = await capture(mode);
    const b64 = dataUrl.split(",")[1];
    const path = `Tools/visual-regression/output/cloud-shadows/${out[mode]}`;
    fs.writeFileSync(path, Buffer.from(b64, "base64"));
    console.log(`[flagon] wrote ${path}`);
  }

  await browser.close();
  const newErrs = errs.filter(
    (e) => !/AtmosphereLUT|default layout|favicon/.test(e),
  );
  console.log(
    newErrs.length
      ? `NEW errs: ${newErrs.slice(0, 6).join(" | ")}`
      : "no new console errors",
  );
})();
