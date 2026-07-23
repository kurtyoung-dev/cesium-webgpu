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
import {
  errorGateInit,
  armWebGPUDevices,
  collectGateErrors,
  attachConsoleErrorGate,
} from "../lib/webgpu-error-gate.mjs";
import { installCloudProbeHarnessOnPage } from "./lib/cloud-probe-harness.mjs";

const BASE = process.env.PROBE_BASE || "http://localhost:8080";
const TIER = process.env.TEMPORAL_TIER || "medium"; // low=T1, medium=T2
if (!["low", "medium"].includes(TIER)) {
  throw new Error("TEMPORAL_TIER must be low or medium");
}

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
  const gpuConsoleErrors = attachConsoleErrorGate(page);
  page.on("console", (m) => {
    if (m.type() === "error") errs.push(m.text());
  });
  page.on("pageerror", (error) => errs.push(`pageerror: ${error.message}`));
  await page.addInitScript(errorGateInit);
  await installCloudProbeHarnessOnPage(page);
  await page.goto(
    `${BASE}/Apps/CesiumViewer/index.html?renderer=webgpu&offline=true`,
    {
      waitUntil: "networkidle",
      timeout: 90_000,
    },
  );
  await page.waitForFunction(() => !!window.viewer, { timeout: 90_000 });
  const armState = await armWebGPUDevices(page);

  const results = await page.evaluate(
    async ({ scene, tier }) => {
      const v = window.viewer,
        s = v.scene;
      const C = await import("/Build/CesiumUnminified/index.js");
      v.useDefaultRenderLoop = false;
      s.skyBox.show = true;
      s.sun.show = true;
      s.skyAtmosphere.show = true;
      s.globe.show = true;
      v.clock.shouldAnimate = false;
      const frameTime = C.JulianDate.fromIso8601(scene.timeIso);
      v.clock.currentTime = frameTime;
      const configTruth = globalThis.__cloudProbe.configure({
        requireWebGPU: true,
        volumetric: {
          cloudCoverage: scene.proc.coverage,
          cloudDensity: scene.proc.density,
          cloudLayerBottom: scene.proc.bottom,
          cloudLayerTop: scene.proc.top,
          // low → T1, medium → T2 (both temporal)
          cloudVolumetricQuality: tier,
        },
      });

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
          s.render(frameTime);
          await new Promise((r) => requestAnimationFrame(r));
        }
      };
      const capture = () => {
        // Snapshot in the same task as an explicit render. Waiting until after
        // presentation can relinquish the WebGPU canvas texture and yield a
        // misleading all-zero PNG.
        s.render(frameTime);
        return s.canvas.toDataURL("image/png");
      };

      const cam = scene.camera;
      const out = {};

      // ── STATIC CONVERGE ──
      // Hold the camera dead still; let temporal accumulation converge.
      setView(cam.lon, cam.lat, cam.height, cam.heading, cam.pitch);
      await renderN(48);
      out.staticConverged = capture();

      // ── MOVING (GHOSTING TEST) ──
      // Continuous heading pan: one degree per frame for ~25 frames so reprojected
      // history is several texels stale each frame (worst case for ghosting). Capture
      // a frame MID-motion (no extra settle renders after the last move).
      let h = cam.heading;
      for (let i = 0; i < 25; i++) {
        h += 1.6; // pan right ~1.6°/frame
        setView(cam.lon, cam.lat, cam.height, h, cam.pitch);
        s.render(frameTime);
        await new Promise((r) => requestAnimationFrame(r));
      }
      out.movingMid = capture();

      // ── SETTLE ──
      // Stop moving; render a handful of frames; the deck should re-converge clean
      // with NO residual ghost from the pan.
      await renderN(24);
      out.movingSettle = capture();

      return {
        ...out,
        configTruth,
        effectiveTimeIso: C.JulianDate.toIso8601(frameTime),
      };
    },
    { scene: SCENE, tier: TIER },
  );

  const gpuGate = await collectGateErrors(page);
  await browser.close();
  const write = (name, dataUrl) => {
    const p = `${outDir}/${TIER}-${name}.png`;
    fs.writeFileSync(p, Buffer.from(dataUrl.split(",")[1], "base64"));
    console.log(`[temporal:${TIER}] wrote ${p}`);
  };
  write("static-converged", results.staticConverged);
  write("moving-mid", results.movingMid);
  write("moving-settle", results.movingSettle);
  const newErrs = [
    ...new Set([
      ...errs,
      ...gpuConsoleErrors,
      ...gpuGate.errors,
      ...(gpuGate.deviceLost ? [gpuGate.deviceLost] : []),
      ...(armState.found < 1
        ? ["WebGPU error gate did not find a device"]
        : []),
    ]),
  ].filter((e) => !/AtmosphereLUT|default layout|favicon/.test(e));
  console.log(
    newErrs.length
      ? `NEW errs: ${newErrs.slice(0, 6).join(" | ")}`
      : "no new console errors",
  );
  const truthPath = `${outDir}/${TIER}-truth.json`;
  fs.writeFileSync(
    truthPath,
    JSON.stringify(
      {
        probeVersion: "c13-01",
        tier: TIER,
        configTruth: results.configTruth,
        effectiveTimeIso: results.effectiveTimeIso,
        gpuGate: {
          ...gpuGate,
          armState,
        },
        errors: newErrs,
      },
      null,
      2,
    ),
  );
  console.log(
    `[temporal:${TIER}] config=${JSON.stringify(results.configTruth.config)} truth=${truthPath}`,
  );
  process.exitCode = results.configTruth.ok && newErrs.length === 0 ? 0 : 1;
})();
