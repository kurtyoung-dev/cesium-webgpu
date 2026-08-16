#!/usr/bin/env node
// Probe: Atmospheric Effects Phase C — GROUND FOG (Batch 420 / 421).
// @purpose Gates the froxel ground-fog own-activation path: config echo, ON-lane dispatch, lower-band brightening vs an OFF noise floor — hard exit codes
// @status ACTIVE
//
// Verifies the WebGPU froxel volumetric-fog renderer's near-surface mist
// boost, driven by `atmosphericConditions.effects.groundFog`. Ground fog
// owns its OWN activation path — the froxel fog runs and shows the mist
// EVEN IF the general `volumetricFog.enabled` master is off.
//
// Scene: a LOW oblique camera over terrain looking toward the horizon, so
// the near-ground mist band is visible at the bottom of the frame and the
// sky fills the top. We capture three WebGPU frames:
//
//   OFF  — effects.groundFog.enabled = false (default). The baseline.
//   ON   — effects.groundFog.enabled = true; intensity = 1.0. The mist
//          should whiten / haze the LOWER (ground) band materially MORE
//          than the UPPER (sky) band.
//   OFF2 — a second OFF capture, so the ON measurement is read against a
//          known capture noise floor rather than against an assumption.
//
// THIS PROBE GATES. It used to print its band numbers under a read-the-PNGs
// heading and exit 0 whatever they said, which is why
// NEW-WEBGPU-GROUND-FOG-RENDERS-NOTHING sat unnoticed for 400+ batches while
// the effect contributed literally nothing: the ON frame was byte-identical to
// OFF (lower band 101.31 both, upper 167.36 both, brighten 0.00 both) and no
// exit code ever said so. A manual-verdict probe in a gating fleet is a probe
// nobody fails.
//
// Gates:
//   A CONFIG     the engine echoes the requested ground-fog config back, with
//                the volumetricFog MASTER still off (the own-activation path
//                is the thing under test; enabling the master would hide a
//                regression in it).
//   B DISPATCH   the froxel compute AND the composite actually ran on the ON
//                lane, and did NOT run on the OFF lane. Reported STRUCTURAL,
//                never FAIL, when the ON lane never dispatched: a pixel leg
//                whose subject never executed is measuring an unrelated frame,
//                and scoring that either way is a lie.
//   C MIST       lowerBandBrighten materially above upperBandBrighten — the
//                mist hugs the ground and leaves the high sky alone. This is a
//                RELATIVE claim on purpose: "something changed" would also be
//                satisfied by a global tint.
//   D SEE-THROUGH the ground band must not saturate. The acceptance for this
//                effect is explicitly "terrain visible THROUGH the haze, not a
//                whiteout", so a whiteout is a FAIL, not a stronger pass.
//   E STABILITY  OFF vs OFF must stay at ~0 in both bands. If the capture path
//                is not repeatable the ON delta is uninterpretable — reported
//                STRUCTURAL (an instrument gap), not FAIL.
//   F CLEAN      zero console / pageerror / uncaptured-device errors.
//   G DATUM      the band's SHIPPED inputs, read back off the renderer, match
//                what the CPU band model computes for this camera. Batch 844
//                could not tell a wrong density from a wrong datum because
//                nothing on the frame reported what the shader had been handed.
//   H CALIBRATION the composite is `scene * T + S`, so a per-pixel regression of
//                (OFF luminance, ON-OFF delta) over the ground band recovers
//                BOTH the effective transmittance and the mist's own in-scatter
//                — which one band mean cannot do. The in-scatter is checked
//                against the shipped uniforms (a prediction with no free
//                parameter) and the optical depth against the band model, with
//                the shortfall reported as the terrain-above-datum it implies.
//
// WebGPU-only. Uses the CesiumViewer page with ?renderer=webgpu and the
// `window.viewer` handle, importing Cesium from the built bundle for the
// Cartesian3 helper (same pattern as probe-atmosphere-toggle.mjs).
//
// Usage:  node Tools/visual-regression/probe-ground-fog.mjs
// Env:    PROBE_BASE (default http://localhost:8080)
// Outputs: output/ground-fog-{off,on,off2}-webgpu.png
// Exit:
//   0 every gate decided and passed | 1 a real product FAIL |
//   2 watchdog or exception | 3 no FAIL but a gate had no subject to
//     measure (acceptance INCOMPLETE, not green)

// RUNNER REQUIREMENT: Node >= 22.18. This probe imports the engine's ground-fog
// leaf module (`.ts`) so its predictions use the SHIPPED constants rather than a
// copy of them, and relies on Node's built-in type stripping (default from
// 22.18; on 22.6-22.17 add `--experimental-strip-types`).

import { chromium } from "playwright";
import fs from "fs";
import path from "path";

import {
  armWebGPUDevices,
  attachConsoleErrorGate,
  collectGateErrors,
  errorGateInit,
} from "../lib/webgpu-error-gate.mjs";
import {
  INNER_RADIUS,
  WGS84,
  bandOpticalDepth,
  cameraFrame,
  compositeDeltaCounts,
  fogSourceRadianceCounts,
  impliedTerrainOffset,
  invertCompositeSums,
} from "./lib/ground-fog-band-model.mjs";

const {
  GROUND_FOG_BAND_HEIGHT,
  GROUND_FOG_PEAK_EXTINCTION,
  groundFogDensityBoost,
  groundFogReferenceAltitude,
} = await import(
  new URL(
    "../../packages/engine/Source/Renderer/WebGPU/WebGPUGroundFogBand.ts",
    import.meta.url,
  ).href
);

const BASE = process.env.PROBE_BASE || "http://localhost:8080";
const OUT_DIR = "Tools/visual-regression/output";

const WATCHDOG_MS = 420_000;
const watchdog = setTimeout(() => {
  console.error(`STRUCTURAL: probe exceeded ${WATCHDOG_MS} ms`);
  process.exit(2);
}, WATCHDOG_MS);
watchdog.unref?.();

// ── Thresholds. Predicted, not fitted.
//
// The band model (`lib/ground-fog-band-model.mjs`) marches the shipped
// extinction through this exact camera. What it predicts is an OPTICAL DEPTH;
// what this probe scores is a SIGNED band-mean change, and the two are not the
// same quantity — the composite is `scene * transmittance + inScatter`, so the
// change is `(fogLuminance - sceneLuminance) * (1 - transmittance)`. Batch 844
// compared a measured +3.6 against "~40", which was the attenuation magnitude
// alone; the corrected signed prediction over LEVEL ground is +36.
//
// The floor below is that prediction taken at the WORST relief the level datum
// is designed to survive. The band is anchored to ONE scalar — the terrain
// height under the camera — so terrain standing `dh` above it scales the whole
// optical depth by `exp(-dh / bandHeight)`, and the band's own docstring puts
// its useful limit at 3 band heights. A mist that clears the floor computed at
// that limit is a mist the design admits; below it, the level datum is out of
// its envelope and gate H says so with the number.
const LEVEL_DATUM_RELIEF_ENVELOPE = 3 * GROUND_FOG_BAND_HEIGHT;
// The OFF/OFF pair measured 0.00 in both bands, so anything above a rounding
// wobble means the capture path itself moved between runs.
const MAX_STABILITY_DELTA = 0.25;
// A fully saturated ground band is a whiteout, not a mist.
const MAX_LOWER_MEAN = 250.0;
// The probe's row bands: bottom 30% of rows is the ground band, top 30% the sky
// band, mid ignored so the horizon does not pollute either.
const LOWER_BAND = { fromFraction: 0.7, toFraction: 1.0 };
// The shipped scattering inputs on the ground-fog path (albedo default,
// the forced ambient floor, sun intensity 1, HG g 0.3) bound the mist's own
// in-scatter without knowing where the sun is: the Henyey-Greenstein term can
// only run between full backscatter and the shader's clamped forward peak.
const SHIPPED_FOG_ALBEDO = { r: 0.9, g: 0.92, b: 0.95 };
const inScatterAt = (cosSunAngle, moonScale) =>
  fogSourceRadianceCounts({
    albedo: SHIPPED_FOG_ALBEDO,
    ambientStrength: 0.7,
    sunIntensity: 1.0,
    cosSunAngle,
    anisotropy: 0.3,
    moonScale,
    cosMoonAngle: cosSunAngle,
  });
const INSCATTER_BOUNDS = { min: inScatterAt(-1, 0), max: inScatterAt(1, 0.05) };
// The regression is over a quarter-million pixels, so the interval can be tight;
// 8-bit quantisation and the f16 scattering volume are the only slack needed.
const INSCATTER_TOLERANCE = 0.05;

// Capture one WebGPU frame with the given ground-fog settings applied.
// `settings` = { enabled: boolean, intensity: number, fogMaster: boolean }.
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
  const consoleGate = attachConsoleErrorGate(page);
  page.on("console", (m) => messages.push({ t: m.type(), text: m.text() }));
  page.on("pageerror", (e) =>
    messages.push({ t: "pageerror", text: e.message }),
  );
  await page.addInitScript(errorGateInit);

  await page.goto(`${BASE}/Apps/CesiumViewer/index.html?renderer=webgpu`, {
    waitUntil: "networkidle",
  });
  await page.waitForFunction(() => !!window.viewer);
  await armWebGPUDevices(page);

  const echo = await page.evaluate(
    async ({ settings }) => {
      const C = await import("/Build/CesiumUnminified/index.js");
      const v = window.viewer;
      const scene = v.scene;
      const ac = scene.globe.atmosphericConditions;

      // DAYTIME: pin the clock to ~local solar noon over the camera
      // longitude (10.5°E → solar noon ≈ 11:18 UTC) on the summer solstice
      // so the sun is high and the terrain is well lit. Stop the clock so
      // it doesn't drift during the settle loop. Without this the default
      // clock can land at local night and the frame is black — you can't
      // see (or measure) ground fog against an unlit scene.
      v.clock.shouldAnimate = false;
      v.clock.currentTime = C.JulianDate.fromIso8601("2026-06-21T11:00:00Z");

      // LOW oblique camera over mountainous terrain (the Alps) looking
      // north toward the horizon: pitch up so the sky fills the top of the
      // frame and the terrain + near-ground mist band fills the bottom.
      v.camera.setView({
        destination: C.Cartesian3.fromDegrees(10.5, 46.4, 3500),
        orientation: {
          heading: C.Math.toRadians(0),
          pitch: C.Math.toRadians(-8),
          roll: 0,
        },
      });

      // Ground fog needs a base fog field to layer over. When the caller
      // wants the fog master on, enable it; otherwise leave it OFF so we
      // exercise the OWN-activation path (ground fog alone drives the
      // froxel render).
      ac.volumetricFog.enabled = settings.fogMaster === true;

      // The core toggle under test.
      ac.effects.groundFog.enabled = settings.enabled === true;
      ac.effects.groundFog.intensity = settings.intensity ?? 0.0;

      // Let terrain + the froxel passes settle.
      for (let i = 0; i < 400; i++) {
        scene.render();
        await new Promise((r) => requestAnimationFrame(r));
        if (scene.globe.tilesLoaded && i > 120) break;
      }

      // The froxel renderer's own counters. `updatesDispatched` counts frames
      // whose three compute passes were recorded; `composites` counts frames
      // whose full-screen composite was recorded. Both are what separates "the
      // mist is invisible" from "the mist never ran" — the difference between a
      // product FAIL and an instrument STRUCTURAL.
      const context = scene._context;
      const stats =
        context && context.getRendererStatistics
          ? context.getRendererStatistics()
          : null;
      const fog = stats ? stats.volumetricFog : null;
      // NEW-WEBGPU-GROUND-FOG-RENDERS-NOTHING (Batch 845) — the band's SHIPPED
      // inputs, as packed. Gate G checks these against the CPU band model, so
      // "the datum is wrong" and "the density is wrong" stop being the same
      // observation.
      const groundFog = fog ? fog.groundFog : null;

      return {
        groundFogEnabled: ac.effects.groundFog.enabled,
        groundFogIntensity: ac.effects.groundFog.intensity,
        volumetricFogEnabled: ac.volumetricFog.enabled,
        terrainHeightUnderCamera:
          typeof scene.globe.getHeight === "function"
            ? (scene.globe.getHeight(v.camera.positionCartographic) ?? null)
            : null,
        cameraHeight: v.camera.positionCartographic.height,
        cameraLatitudeDeg:
          (v.camera.positionCartographic.latitude * 180) / Math.PI,
        cameraLongitudeDeg:
          (v.camera.positionCartographic.longitude * 180) / Math.PI,
        fogLastEnabled: fog ? fog.enabled : null,
        fogUpdatesDispatched: fog ? fog.updatesDispatched : null,
        fogComposites: fog ? fog.composites : null,
        fogResolutionKey: fog ? fog.resolutionKey : null,
        fogGroundActive: groundFog ? groundFog.active : null,
        fogGroundDatum: groundFog ? groundFog.referenceAltitude : null,
        fogGroundTerrainHeight: groundFog ? groundFog.terrainHeight : null,
        fogGroundCameraAltitude: groundFog ? groundFog.cameraAltitude : null,
        fogGroundBandHeight: groundFog ? groundFog.bandHeight : null,
        fogGroundPeakDensity: groundFog ? groundFog.peakDensity : null,
        fogGroundAmbient: groundFog ? groundFog.ambientStrength : null,
        fogGroundAnisotropy: groundFog ? groundFog.anisotropy : null,
        fogGroundAlbedo: groundFog ? groundFog.albedo : null,
      };
    },
    { settings },
  );
  await page.waitForTimeout(1500);

  const out = path.join(OUT_DIR, `ground-fog-${label}-webgpu.png`);
  await page.screenshot({ path: out, fullPage: false });
  const gate = await collectGateErrors(page);
  await browser.close();

  const errs = [
    ...messages
      .filter((m) => m.t === "error" || m.t === "pageerror")
      .map((m) => `${m.t}: ${m.text}`),
    ...consoleGate,
    ...(gate.errors ?? []),
    ...(gate.deviceLost ? [gate.deviceLost] : []),
  ];
  return { out, echo, errors: errs };
}

// Decode two PNGs and compare the mean luminance of the LOWER band (ground)
// vs the UPPER band (sky) between them. Returns how much each band
// brightened (b - a) — ground fog should brighten the lower band much more
// than the upper band. Uses Playwright's canvas decode (no Node PNG dep).
async function bandDiff(a, b) {
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
      const lum = (d, i) =>
        0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
      // Lower band = bottom 30% of rows (ground); upper band = top 30%
      // (sky). Mid band ignored so the terrain/sky boundary doesn't
      // pollute the measurement.
      const lowY0 = Math.floor(A.h * 0.7);
      const upY1 = Math.floor(A.h * 0.3);
      let lowA = 0,
        lowB = 0,
        lowN = 0;
      let upA = 0,
        upB = 0,
        upN = 0;
      const sums = {
        count: 0,
        sumScene: 0,
        sumDelta: 0,
        sumSceneScene: 0,
        sumSceneDelta: 0,
      };
      for (let y = 0; y < A.h; y++) {
        for (let x = 0; x < A.w; x++) {
          const i = (y * A.w + x) * 4;
          if (y >= lowY0) {
            const scene = lum(A.data, i);
            const delta = lum(B.data, i) - scene;
            sums.count++;
            sums.sumScene += scene;
            sums.sumDelta += delta;
            sums.sumSceneScene += scene * scene;
            sums.sumSceneDelta += scene * delta;
            lowA += lum(A.data, i);
            lowB += lum(B.data, i);
            lowN++;
          } else if (y < upY1) {
            upA += lum(A.data, i);
            upB += lum(B.data, i);
            upN++;
          }
        }
      }
      const lowerMeanA = lowA / Math.max(1, lowN);
      const lowerMeanB = lowB / Math.max(1, lowN);
      const upperMeanA = upA / Math.max(1, upN);
      const upperMeanB = upB / Math.max(1, upN);
      return {
        lowerMeanA: Number(lowerMeanA.toFixed(2)),
        lowerMeanB: Number(lowerMeanB.toFixed(2)),
        lowerBandBrighten: Number((lowerMeanB - lowerMeanA).toFixed(2)),
        upperMeanA: Number(upperMeanA.toFixed(2)),
        upperMeanB: Number(upperMeanB.toFixed(2)),
        upperBandBrighten: Number((upperMeanB - upperMeanA).toFixed(2)),
        // Regression sums over the ground band, for the composite inversion
        // (gate H). Accumulated here rather than shipping a quarter-million
        // pixel pairs across the page boundary; the inversion itself lives in
        // the band model so there is one copy of the arithmetic.
        lowerSums: {
          count: sums.count,
          sumScene: sums.sumScene,
          sumDelta: sums.sumDelta,
          sumSceneScene: sums.sumSceneScene,
          sumSceneDelta: sums.sumSceneDelta,
        },
      };
    },
    { ba, bb },
  );
  await browser.close();
  return result;
}

function verdict(value) {
  if (value === null) return "STRUCTURAL";
  return value ? "PASS" : "FAIL";
}

async function main() {
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
  console.log("[probe-ground-fog] Atmospheric Effects Phase C — GROUND FOG");

  // OFF baseline (ground fog disabled, fog master off).
  const off = await capture("off", {
    enabled: false,
    intensity: 0.0,
    fogMaster: false,
  });
  console.log(`  off:  ${off.out} (${off.errors.length} errors)`);
  console.log(`        echo: ${JSON.stringify(off.echo)}`);

  // ON via the OWN-activation path: ground fog enabled, fog master OFF.
  const on = await capture("on", {
    enabled: true,
    intensity: 1.0,
    fogMaster: false,
  });
  console.log(`  on:   ${on.out} (${on.errors.length} errors)`);
  console.log(`        echo: ${JSON.stringify(on.echo)}`);

  // Second OFF capture for the OFF-vs-OFF sanity baseline (~0 delta).
  const off2 = await capture("off2", {
    enabled: false,
    intensity: 0.0,
    fogMaster: false,
  });
  console.log(`  off2: ${off2.out} (${off2.errors.length} errors)`);

  const allErrors = [...off.errors, ...on.errors, ...off2.errors];
  for (const r of [off, on, off2]) {
    if (r.errors.length) {
      console.log(`  ${path.basename(r.out)} errors:`);
      r.errors.slice(0, 3).forEach((e) => console.log(`    ${e}`));
    }
  }

  const mist = await bandDiff(off.out, on.out);
  const stability = await bandDiff(off.out, off2.out);
  console.log("\n  ON vs OFF band brighten (mist should hug the ground):");
  console.log("   ", JSON.stringify(mist));
  console.log("\n  OFF vs OFF sanity (both bands ~0):");
  console.log("   ", JSON.stringify(stability));

  // ── A CONFIG ────────────────────────────────────────────────────────────
  const gateA =
    on.echo.groundFogEnabled === true &&
    on.echo.groundFogIntensity === 1.0 &&
    on.echo.volumetricFogEnabled === false &&
    off.echo.groundFogEnabled === false;

  // ── B DISPATCH ──────────────────────────────────────────────────────────
  // The ON lane must have run the froxel compute AND the composite. If it did
  // not, the pixel gates below measured a frame the effect never touched, so
  // they cannot be scored — STRUCTURAL, not FAIL and not PASS.
  const onRan =
    (on.echo.fogUpdatesDispatched ?? 0) > 0 && (on.echo.fogComposites ?? 0) > 0;
  const offRan =
    (off.echo.fogUpdatesDispatched ?? 0) > 0 ||
    (off.echo.fogComposites ?? 0) > 0;
  // Ground fog off with the master off must leave the froxel renderer idle;
  // if it runs anyway the OFF baseline is not a baseline.
  const gateB = offRan ? false : onRan ? true : null;

  // ── G DATUM ─────────────────────────────────────────────────────────────
  // What the shader was actually handed, against what the band model says it
  // should have been. `null` (no diagnostics on this build) is STRUCTURAL.
  const datumReport = { ok: null, lines: [] };
  if (on.echo.fogGroundDatum === null || on.echo.fogGroundDatum === undefined) {
    datumReport.lines.push(
      "the renderer reported no ground-fog diagnostics — cannot check the datum",
    );
  } else {
    const frame = cameraFrame(
      on.echo.cameraLatitudeDeg,
      on.echo.cameraLongitudeDeg,
      on.echo.cameraHeight,
    );
    const expected = groundFogReferenceAltitude(
      frame.unit.x,
      frame.unit.y,
      frame.unit.z,
      WGS84.a,
      WGS84.a,
      WGS84.b,
      INNER_RADIUS,
      on.echo.fogGroundTerrainHeight ?? 0,
    );
    const datumError = Math.abs(on.echo.fogGroundDatum - expected);
    // The camera's height above its own datum is the geodetic height minus the
    // terrain beneath it — the whole point of expressing both in the
    // inscribed-sphere frame. A mismatch here means the two terms are NOT in
    // the same frame, which is the original defect.
    const heightAboveDatum =
      on.echo.fogGroundCameraAltitude - on.echo.fogGroundDatum;
    const expectedHeight =
      on.echo.cameraHeight - (on.echo.fogGroundTerrainHeight ?? 0);
    const heightError = Math.abs(heightAboveDatum - expectedHeight);
    datumReport.ok =
      on.echo.fogGroundActive === true &&
      Number.isFinite(on.echo.fogGroundDatum) &&
      datumError < 1.0 &&
      heightError < 1.0 &&
      on.echo.fogGroundBandHeight === GROUND_FOG_BAND_HEIGHT &&
      Math.abs(on.echo.fogGroundPeakDensity - GROUND_FOG_PEAK_EXTINCTION) <
        1e-9;
    datumReport.lines.push(
      `datum ${on.echo.fogGroundDatum?.toFixed(2)} m vs model ${expected.toFixed(2)} m` +
        ` (error ${datumError.toFixed(3)} m); camera ${heightAboveDatum.toFixed(1)} m above it` +
        ` vs expected ${expectedHeight.toFixed(1)} m; terrain under camera` +
        ` ${on.echo.fogGroundTerrainHeight} m; band ${on.echo.fogGroundBandHeight} m;` +
        ` peak ${on.echo.fogGroundPeakDensity}`,
    );
  }
  const gateG = datumReport.ok;

  // ── H CALIBRATION ───────────────────────────────────────────────────────
  // Invert the composite over the ground band: slope gives the transmittance
  // the frame actually received, intercept gives the mist's own in-scatter.
  const calibration = { gate: null, lines: [], floor: null };
  if (mist.error === undefined && mist.lowerSums && gateB === true) {
    const inverted = invertCompositeSums(mist.lowerSums);
    // The band model's LEVEL-ground prediction for this camera, using the
    // terrain height the engine itself used for the datum — falling back to the
    // page's own `globe.getHeight` echo on builds that predate the diagnostics,
    // so this leg still reports numbers when gate G is STRUCTURAL.
    const frame = cameraFrame(
      on.echo.cameraLatitudeDeg,
      on.echo.cameraLongitudeDeg,
      on.echo.cameraHeight,
    );
    const reference = groundFogReferenceAltitude(
      frame.unit.x,
      frame.unit.y,
      frame.unit.z,
      WGS84.a,
      WGS84.a,
      WGS84.b,
      INNER_RADIUS,
      on.echo.fogGroundTerrainHeight ?? on.echo.terrainHeightUnderCamera ?? 0,
    );
    const modelled = bandOpticalDepth({
      frame,
      boost: groundFogDensityBoost,
      bandHeight: GROUND_FOG_BAND_HEIGHT,
      peakDensity: GROUND_FOG_PEAK_EXTINCTION,
      referenceAltitude: reference,
      terrainAltitude: reference,
      intensity: on.echo.groundFogIntensity ?? 1.0,
      ...LOWER_BAND,
    });
    const offset = impliedTerrainOffset(
      inverted.opticalDepth,
      modelled.mean,
      GROUND_FOG_BAND_HEIGHT,
    );
    // Two independent legs. The in-scatter is a prediction with no free
    // parameter and is invariant to any uniform dilution of the fog, so it
    // tests the scattering pass alone. The optical depth is then whatever is
    // left, expressed as the relief the LEVEL datum is failing to follow.
    const inScatterOk =
      Number.isFinite(inverted.fogLuminance) &&
      inverted.fogLuminance >
        INSCATTER_BOUNDS.min * (1 - INSCATTER_TOLERANCE) &&
      inverted.fogLuminance < INSCATTER_BOUNDS.max * (1 + INSCATTER_TOLERANCE);
    const reliefOk = Number.isFinite(offset)
      ? offset < LEVEL_DATUM_RELIEF_ENVELOPE
      : false;
    calibration.gate = inverted.slope >= 0 ? null : inScatterOk && reliefOk;
    calibration.floor = compositeDeltaCounts(
      modelled.mean *
        Math.exp(-LEVEL_DATUM_RELIEF_ENVELOPE / GROUND_FOG_BAND_HEIGHT),
      mist.lowerMeanA,
      INSCATTER_BOUNDS.min,
    );
    calibration.lines.push(
      `in-scatter ${inverted.fogLuminance.toFixed(2)} counts vs shipped-uniform` +
        ` ${INSCATTER_BOUNDS.min.toFixed(1)}..${INSCATTER_BOUNDS.max.toFixed(1)}` +
        ` (${inScatterOk ? "match" : "MISMATCH"})`,
    );
    calibration.lines.push(
      `optical depth ${inverted.opticalDepth.toFixed(4)} (transmittance` +
        ` ${inverted.transmittance.toFixed(4)}) vs level-ground model` +
        ` ${modelled.mean.toFixed(4)} — implies ${Number.isFinite(offset) ? offset.toFixed(0) : "n/a"} m` +
        ` of terrain above the datum (envelope ${LEVEL_DATUM_RELIEF_ENVELOPE} m)`,
    );
  } else {
    calibration.lines.push(
      "no measurable ON/OFF pair — the composite inversion has no subject",
    );
  }
  const gateH = calibration.gate;

  // ── C MIST / D SEE-THROUGH / E STABILITY ────────────────────────────────
  // The floor is the model's own signed prediction taken at the worst relief
  // the level datum is designed to survive; it falls back to the historical
  // round number only when the model could not be evaluated (no diagnostics).
  const MIN_LOWER_MINUS_UPPER =
    calibration.floor !== null && Number.isFinite(calibration.floor)
      ? calibration.floor
      : 3.0;
  const separation =
    mist.error === undefined
      ? mist.lowerBandBrighten - mist.upperBandBrighten
      : null;
  const stable =
    stability.error === undefined &&
    Math.abs(stability.lowerBandBrighten) <= MAX_STABILITY_DELTA &&
    Math.abs(stability.upperBandBrighten) <= MAX_STABILITY_DELTA;
  // An unrepeatable capture path makes the ON delta uninterpretable. That is an
  // instrument condition, not a product verdict.
  const gateE = stability.error !== undefined ? null : stable ? true : null;

  // A decode failure (size mismatch) is an instrument condition too — the ON
  // measurement does not exist, so C and D have nothing to score.
  const pixelsMeasurable =
    gateB === true && gateE === true && mist.error === undefined;
  const gateC = !pixelsMeasurable
    ? null
    : separation >= MIN_LOWER_MINUS_UPPER &&
      mist.lowerBandBrighten >= MIN_LOWER_MINUS_UPPER;
  const gateD = !pixelsMeasurable ? null : mist.lowerMeanB <= MAX_LOWER_MEAN;

  // ── F CLEAN ─────────────────────────────────────────────────────────────
  const gateF = allErrors.length === 0;

  console.log(
    `\nA CONFIG      (engine echoes the own-activation request, master off): ${verdict(gateA)}`,
  );
  console.log(
    `B DISPATCH    (froxel compute + composite ran ON, idle OFF): ${verdict(gateB)}` +
      ` on{updates=${on.echo.fogUpdatesDispatched} composites=${on.echo.fogComposites}}` +
      ` off{updates=${off.echo.fogUpdatesDispatched} composites=${off.echo.fogComposites}}` +
      (gateB === null
        ? " — the fog compute never ran, so the pixel gates below have no subject" +
          " (instrument gap, NOT a product verdict)"
        : ""),
  );
  console.log(
    `C MIST        (lowerBandBrighten >> upperBandBrighten): ${verdict(gateC)}` +
      ` lower=${mist.lowerBandBrighten} upper=${mist.upperBandBrighten}` +
      ` separation=${separation === null ? "n/a" : separation.toFixed(2)}` +
      ` (need >= ${MIN_LOWER_MINUS_UPPER.toFixed(2)}` +
      `${calibration.floor === null ? ", fallback — the model could not be evaluated" : ", from the band model at the level datum's relief envelope"})`,
  );
  console.log(
    `D SEE-THROUGH (ground band not a whiteout): ${verdict(gateD)}` +
      ` lowerMean=${mist.lowerMeanB} (max ${MAX_LOWER_MEAN})`,
  );
  console.log(
    `E STABILITY   (OFF vs OFF ~0 in both bands): ${verdict(gateE)}` +
      ` lower=${stability.lowerBandBrighten} upper=${stability.upperBandBrighten}` +
      ` (max |delta| ${MAX_STABILITY_DELTA})`,
  );
  console.log(
    `F CLEAN       (zero console / device errors): ${verdict(gateF)} errors=${allErrors.length}`,
  );
  console.log(
    `G DATUM       (shipped band inputs match the model): ${verdict(gateG)}`,
  );
  for (const line of datumReport.lines) console.log(`              ${line}`);
  console.log(
    `H CALIBRATION (composite inverted per pixel): ${verdict(gateH)}` +
      (gateH === null
        ? " — the regression found no attenuation to invert (instrument gap)"
        : ""),
  );
  for (const line of calibration.lines) console.log(`              ${line}`);

  console.log("\nAlso read the PNGs:");
  console.log(
    "  ON:  a milky near-surface mist hugs the bottom of the frame; the sky high above stays clear.",
  );
  console.log("  OFF: clean terrain + sky, no mist.");

  const gates = [gateA, gateB, gateC, gateD, gateE, gateF, gateG, gateH];
  const failed = gates.some((gate) => gate === false);
  const structural = gates.some((gate) => gate === null);
  console.log(
    `\nGATE ${failed ? "FAIL" : structural ? "INCOMPLETE (structural)" : "PASS"}` +
      (structural
        ? " — a leg could not see its subject. That is an instrument gap owed as" +
          " follow-up, NOT a product verdict, and NOT a pass: exit 3 so a" +
          " structural run can never be mistaken for a green one."
        : ""),
  );
  // Exit codes: 0 = every gate decided and passed. 1 = a real product FAIL.
  // 2 = watchdog or an exception. 3 = no FAIL, but at least one gate had no
  // subject to measure — acceptance is INCOMPLETE, not green.
  process.exitCode = failed ? 1 : structural ? 3 : 0;
  console.log("[probe-ground-fog] done");
}

main()
  .catch((error) => {
    console.error(error?.stack ?? String(error));
    process.exitCode = 2;
  })
  .finally(() => clearTimeout(watchdog));
