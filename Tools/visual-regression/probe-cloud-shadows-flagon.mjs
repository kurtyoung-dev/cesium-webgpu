#!/usr/bin/env node
/**
 * CLOUD-SHADOWS flag-ON probe (Batch 437 — 4.1 CLOUD-SHADOWS).
 * @purpose Cloud cast-shadow ON/OFF capture over lit terrain, plus a C13-16 U2 CIRRUS acceptance mode with pinned clock/wind.
 * @status ACTIVE
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
 * Legacy usage (unchanged):
 *   node Tools/visual-regression/probe-cloud-shadows-flagon.mjs
 *
 * C13-16 U2 CIRRUS acceptance mode:
 *   C13_U2_SHADOW_MODE=cirrus node Tools/visual-regression/probe-cloud-shadows-flagon.mjs
 * This pins clock and wind, proves the packed CIRRUS morphology row, checks a
 * non-vacuous cloud subject, and captures single and cascaded shadows
 * separately. It intentionally does not alter the historical thresholds.
 */
import fs from "node:fs";
import { chromium } from "playwright";
import {
  armWebGPUDevices,
  attachConsoleErrorGate,
  collectGateErrors,
  errorGateInit,
} from "../lib/webgpu-error-gate.mjs";
import { installWeatherPinHarnessOnPage } from "./lib/weather-probe-pinning.mjs";

const BASE = process.env.PROBE_BASE || "http://localhost:8080";
const ACCEPTANCE_MODE = process.env.C13_U2_SHADOW_MODE || "legacy";
if (!["legacy", "cirrus"].includes(ACCEPTANCE_MODE)) {
  throw new Error("C13_U2_SHADOW_MODE must be legacy or cirrus");
}
const CIRRUS_ROW = [Math.fround(0.6), 9, Math.fround(0.9), Math.fround(0.12)];
// Existing U2 tour-fixture non-vacuity floor; this probe does not retune it.
const CIRRUS_MIN_CHANGED_FRACTION = 0.002;

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
  const gpuConsoleErrors = attachConsoleErrorGate(page);
  await page.addInitScript(errorGateInit);
  await installWeatherPinHarnessOnPage(page);
  const viewerUrl = `${BASE}/Apps/CesiumViewer/index.html?renderer=webgpu${
    ACCEPTANCE_MODE === "cirrus" ? "&offline=true" : ""
  }`;
  await page.goto(viewerUrl, {
    waitUntil: "networkidle",
    timeout: 90_000,
  });
  await page.waitForFunction(() => !!window.viewer, { timeout: 90_000 });
  const armState = await armWebGPUDevices(page);

  async function capture(mode) {
    return page.evaluate(
      async ({
        mode,
        camera,
        timeIso,
        proc,
        acceptanceMode,
        expectedRow,
        minChangedFraction,
      }) => {
        const v = window.viewer,
          s = v.scene,
          g = s.globe;
        const C = await import("/Build/CesiumUnminified/index.js");
        const ac = s._frameState ? s._frameState.atmosphericConditions : null;
        const clouds = g.defaultCloudCollection;
        const vol = clouds.volumetric;
        const cirrusAcceptance = acceptanceMode === "cirrus";
        v.useDefaultRenderLoop = false;
        s.requestRenderMode = false;
        s.skyAtmosphere.show = true;
        s.globe.show = true;
        s.globe.enableLighting = true;
        v.clock.shouldAnimate = false;
        const pinnedTime = C.JulianDate.fromIso8601(timeIso);
        v.clock.currentTime = pinnedTime;
        clouds.enableVolumetric = mode !== "off";
        vol.cloudCoverage = proc.coverage;
        vol.cloudDensity = proc.density;
        vol.cloudLayerBottom = proc.bottom;
        vol.cloudLayerTop = proc.top;
        vol.cloudVolumetricQuality = "high";
        vol.cloudCastShadows = !["off", "noshadow"].includes(mode);
        vol.cloudShadowCascades = mode === "cascaded";
        if (cirrusAcceptance) {
          clouds.cloudType = C.CloudType.CIRRUS;
          vol.cloudType = C.CloudType.CIRRUS;
          vol.cloudWindSpeed = 0;
          vol.cloudWindDirection = new C.Cartesian2(1, 0);
        }
        if (ac) {
          ac.volumetricFog = ac.volumetricFog || {};
          ac.volumetricFog.enabled = !cirrusAcceptance && mode === "fog";
          ac.volumetricFog.density = 0.0008;
          ac.volumetricFog.cloudShadowHiFi =
            !cirrusAcceptance && mode === "fog";
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
          window.__weatherPin.renderAt(v.clock.currentTime);
          await new Promise((r) => requestAnimationFrame(r));
        }

        let nonVacuity = null;
        if (cirrusAcceptance && mode !== "off") {
          clouds.enableVolumetric = true;
          const subject = (
            await window.__weatherPin.capture(v.clock.currentTime, false)
          ).data;
          clouds.enableVolumetric = false;
          const control = (
            await window.__weatherPin.capture(v.clock.currentTime, false)
          ).data;
          let changedPixels = 0;
          for (let i = 0; i < subject.length; i += 4) {
            const maxDelta = Math.max(
              Math.abs(subject[i] - control[i]),
              Math.abs(subject[i + 1] - control[i + 1]),
              Math.abs(subject[i + 2] - control[i + 2]),
            );
            if (maxDelta > 4) changedPixels++;
          }
          const pixelCount = subject.length / 4;
          const changedFraction = changedPixels / pixelCount;
          nonVacuity = {
            changedPixels,
            pixelCount,
            changedFraction,
            minChangedFraction,
            ok: changedFraction > minChangedFraction,
          };
          clouds.enableVolumetric = true;
          for (let i = 0; i < 8; i++) {
            window.__weatherPin.renderAt(v.clock.currentTime);
          }
        }

        const row = s.context?._cloudCache?.uniformData
          ? Array.from(s.context._cloudCache.uniformData.slice(168, 172))
          : null;
        const genusRowMatches =
          !cirrusAcceptance ||
          mode === "off" ||
          (Array.isArray(row) &&
            row.length === expectedRow.length &&
            row.every((value, index) => Object.is(value, expectedRow[index])));
        const finalFrame = await window.__weatherPin.capture(
          v.clock.currentTime,
          true,
        );
        // The documentary PNG is the exact byte source of a scored metric:
        // the shared brightness reducer over the same frozen frame doubles as
        // a black-frame tripwire for the eyeball evidence.
        const finalBrightness = window.__weatherPin.brightFraction(
          finalFrame,
          16,
        );
        return {
          dataUrl: finalFrame.png,
          finalBrightness,
          rendererType: s.context?.rendererType ?? null,
          cloudType: vol.cloudType ?? clouds.cloudType,
          windSpeed: vol.cloudWindSpeed,
          windDirection: vol.cloudWindDirection
            ? { x: vol.cloudWindDirection.x, y: vol.cloudWindDirection.y }
            : null,
          clockIso: C.JulianDate.toIso8601(v.clock.currentTime),
          clockPinned:
            v.clock.shouldAnimate === false &&
            C.JulianDate.equals(v.clock.currentTime, pinnedTime),
          genusUniformRow: row,
          genusRowMatches,
          nonVacuity,
          shadowMode: {
            cast: vol.cloudCastShadows === true,
            cascaded: vol.cloudShadowCascades === true,
          },
        };
      },
      {
        mode,
        camera: CAMERA,
        timeIso: TIME_ISO,
        proc: PROC,
        acceptanceMode: ACCEPTANCE_MODE,
        expectedRow: CIRRUS_ROW,
        minChangedFraction: CIRRUS_MIN_CHANGED_FRACTION,
      },
    );
  }

  const out =
    ACCEPTANCE_MODE === "cirrus"
      ? {
          off: "u2-cirrus-off.png",
          noshadow: "u2-cirrus-noshadow.png",
          single: "u2-cirrus-shadow-single.png",
          cascaded: "u2-cirrus-shadow-cascaded.png",
        }
      : {
          shadows: "flagon-shadows.png",
          noshadow: "flagon-noshadow.png",
          fog: "flagon-fog-shadows.png",
        };
  const captures = {};
  for (const mode of Object.keys(out)) {
    const record = await capture(mode);
    captures[mode] = record;
    const b64 = record.dataUrl.split(",")[1];
    const path = `Tools/visual-regression/output/cloud-shadows/${out[mode]}`;
    fs.writeFileSync(path, Buffer.from(b64, "base64"));
    delete record.dataUrl;
    console.log(`[flagon] wrote ${path}`);
  }

  const gate = await collectGateErrors(page);
  await browser.close();
  const newErrs = [
    ...new Set([
      ...gpuConsoleErrors,
      ...(gate.errors || []),
      ...(gate.deviceLost ? [gate.deviceLost] : []),
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

  if (ACCEPTANCE_MODE === "cirrus") {
    const subjectModes = ["noshadow", "single", "cascaded"];
    const packedRowsOk = subjectModes.every(
      (mode) => captures[mode]?.genusRowMatches === true,
    );
    const cirrusSelected = subjectModes.every(
      (mode) => captures[mode]?.cloudType === 1,
    );
    const nonVacuous = subjectModes.every(
      (mode) => captures[mode]?.nonVacuity?.ok === true,
    );
    const deterministic = subjectModes.every(
      (mode) =>
        captures[mode]?.clockPinned === true &&
        captures[mode]?.windSpeed === 0 &&
        captures[mode]?.windDirection?.x === 1 &&
        captures[mode]?.windDirection?.y === 0,
    );
    const separateShadowRoutes =
      captures.single?.shadowMode?.cast === true &&
      captures.single?.shadowMode?.cascaded === false &&
      captures.cascaded?.shadowMode?.cast === true &&
      captures.cascaded?.shadowMode?.cascaded === true;
    const webgpuOk =
      armState.found >= 1 &&
      Object.values(captures).every(
        (record) => record.rendererType === "webgpu",
      );
    const structuralOk =
      packedRowsOk &&
      cirrusSelected &&
      deterministic &&
      separateShadowRoutes &&
      webgpuOk &&
      newErrs.length === 0;
    const passed = structuralOk && nonVacuous;
    const manifest = {
      manifestVersion: "c13-16-u2-cirrus-shadows/1",
      acceptanceMode: ACCEPTANCE_MODE,
      camera: CAMERA,
      clockIso: TIME_ISO,
      procedural: PROC,
      expectedGenusUniformRow: CIRRUS_ROW,
      minChangedFraction: CIRRUS_MIN_CHANGED_FRACTION,
      captures,
      checks: {
        packedRowsOk,
        cirrusSelected,
        nonVacuous,
        deterministic,
        separateShadowRoutes,
        webgpuOk,
        noNewErrors: newErrs.length === 0,
      },
      errors: newErrs,
      passed,
    };
    const manifestPath =
      "Tools/visual-regression/output/cloud-shadows/u2-cirrus-acceptance.json";
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    for (const mode of subjectModes) {
      const record = captures[mode];
      const changedFraction = record.nonVacuity?.changedFraction;
      console.log(
        `[u2-cirrus:${mode}] row=${JSON.stringify(record.genusUniformRow)} ` +
          `changed=${Number.isFinite(changedFraction) ? changedFraction.toFixed(6) : "n/a"} ` +
          `[${record.genusRowMatches && record.nonVacuity?.ok ? "PASS" : "FAIL"}]`,
      );
    }
    console.log(`manifest: ${manifestPath}`);
    console.log(`RESULT: ${passed ? "GREEN" : "RED"}`);
    process.exitCode = passed ? 0 : structuralOk ? 1 : 3;
  }
})();
