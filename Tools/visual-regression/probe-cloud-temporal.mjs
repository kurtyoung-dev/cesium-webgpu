#!/usr/bin/env node
/**
 * Cloud TEMPORAL probe (Batch 433, improvement-plan 3.2 CLOUD-TEMPORAL). Exercises
 * the temporal reprojection/accumulation path at a TEMPORAL tier (T1 low / T2
 * medium, which set temporalEnabled=true + renderResScale=0.5). Three captures, all
 * dumping RAW CANVAS pixels (no UI chrome) via toDataURL:
 *
 *   static-converged — hold the camera STILL for ~40 frames; the accumulation should
 *       converge to a clean image at least as clean as the single-pass half-res
 *       (temporal supersampling reduces the half-res noise).
 *   moving-mid       — a frame captured DURING a continuous camera pan/rotate (the
 *       GHOSTING test: the neighborhood clamp must keep cloud edges crisp — no comet
 *       trails / smears / doubled clouds / disocclusion holes behind the motion).
 *   moving-settle    — a few frames AFTER motion stops; the deck should re-converge
 *       clean with no residual ghost from the motion.
 *
 * Output: output/cloud-temporal/<TIER>-<phase>.png   (TIER from TEMPORAL_TIER env;
 *   "low" → T1, "medium" → T2). Default "medium".
 *
 * Usage:
 *   TEMPORAL_TIER=medium node Tools/visual-regression/probe-cloud-temporal.mjs
 */
import { chromium } from "playwright";

const BASE = process.env.PROBE_BASE || "http://localhost:8080";
const TIER = process.env.TEMPORAL_TIER || "medium"; // low=T1, medium=T2

const SCENE = {
  proc: { coverage: 0.5, density: 0.75, bottom: 1500, top: 3800 },
  camera: { lon: -95, lat: 39, height: 1400, heading: 0, pitch: 8 },
  timeIso: "2026-06-21T18:20:00Z",
};

(async () => {
  const fs = await import("fs");
  const outDir = "Tools/visual-regression/output/cloud-temporal";
  fs.mkdirSync(outDir, { recursive: true });
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

  const results = await page.evaluate(
    async ({ scene, tier }) => {
      const v = window.viewer,
        s = v.scene,
        g = s.globe;
      const C = await import("/Build/CesiumUnminified/index.js");
      s.skyBox.show = true;
      s.sun.show = true;
      s.skyAtmosphere.show = true;
      s.globe.show = true;
      v.clock.shouldAnimate = false;
      v.clock.currentTime = C.JulianDate.fromIso8601(scene.timeIso);
      g.defaultCloudCollection.enableVolumetric = true;
      g.defaultCloudCollection.volumetric.cloudCoverage = scene.proc.coverage;
      g.defaultCloudCollection.volumetric.cloudDensity = scene.proc.density;
      g.defaultCloudCollection.volumetric.cloudLayerBottom = scene.proc.bottom;
      g.defaultCloudCollection.volumetric.cloudLayerTop = scene.proc.top;
      g.defaultCloudCollection.volumetric.cloudVolumetricQuality = tier; // low → T1, medium → T2 (both temporal)

      const setView = (lon, lat, height, headingDeg, pitchDeg) =>
        v.camera.setView({
          destination: C.Cartesian3.fromDegrees(lon, lat, height),
          orientation: {
            heading: C.Math.toRadians(headingDeg),
            pitch: C.Math.toRadians(pitchDeg),
            roll: 0.0,
          },
        });
      const renderN = async (n) => {
        for (let i = 0; i < n; i++) {
          s.render();
          await new Promise((r) => requestAnimationFrame(r));
        }
      };

      const cam = scene.camera;
      const out = {};

      // ── STATIC CONVERGE ──
      // Hold the camera dead still; let temporal accumulation converge.
      setView(cam.lon, cam.lat, cam.height, cam.heading, cam.pitch);
      await renderN(48);
      out.staticConverged = s.canvas.toDataURL("image/png");

      // ── MOVING (GHOSTING TEST) ──
      // Continuous heading pan: one degree per frame for ~25 frames so reprojected
      // history is several texels stale each frame (worst case for ghosting). Capture
      // a frame MID-motion (no extra settle renders after the last move).
      let h = cam.heading;
      for (let i = 0; i < 25; i++) {
        h += 1.6; // pan right ~1.6°/frame
        setView(cam.lon, cam.lat, cam.height, h, cam.pitch);
        s.render();
        await new Promise((r) => requestAnimationFrame(r));
      }
      out.movingMid = s.canvas.toDataURL("image/png");

      // ── SETTLE ──
      // Stop moving; render a handful of frames; the deck should re-converge clean
      // with NO residual ghost from the pan.
      await renderN(24);
      out.movingSettle = s.canvas.toDataURL("image/png");

      return out;
    },
    { scene: SCENE, tier: TIER },
  );

  await browser.close();
  const write = (name, dataUrl) => {
    const p = `${outDir}/${TIER}-${name}.png`;
    fs.writeFileSync(p, Buffer.from(dataUrl.split(",")[1], "base64"));
    console.log(`[temporal:${TIER}] wrote ${p}`);
  };
  write("static-converged", results.staticConverged);
  write("moving-mid", results.movingMid);
  write("moving-settle", results.movingSettle);
  const newErrs = errs.filter(
    (e) => !/AtmosphereLUT|default layout|favicon/.test(e),
  );
  console.log(
    newErrs.length
      ? `NEW errs: ${newErrs.slice(0, 6).join(" | ")}`
      : "no new console errors",
  );
})();
